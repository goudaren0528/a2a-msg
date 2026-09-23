import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { migrateImSchema } from '../src/im/schema.js';
import { createImMigration } from '../src/im/migration.js';

const policy = {
  enabled: true, writeMode: 'enabled', transport: { mode: 'local-test', serverUrl: 'http://localhost:3000/' },
  retention: { policy: { messageRetentionMs: 1000, attachmentRetentionMs: 500,
    idempotencyRetentionMs: 2000, safeRetryWindowMs: 1000 } },
  lease: { ttlMs: 1000, renewalMs: 500 },
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE members(name TEXT PRIMARY KEY,display_name TEXT NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,from_name TEXT,to_name TEXT,text TEXT,read_at TEXT);
    CREATE TABLE attachments(id INTEGER PRIMARY KEY,message_id INTEGER,name TEXT,data BLOB);
    INSERT INTO members VALUES ('old-a','Shared','yesterday',NULL),('old-b','Shared','yesterday',NULL);
    INSERT INTO messages VALUES (1,'old-a','old-b','legacy private message',NULL);
    INSERT INTO attachments VALUES (1,1,'legacy-file',X'000102');`);
  migrateImSchema(db);
  db.exec(`INSERT INTO im_agents(agent_id,display_name,status,created_at) VALUES
    ('agent-a','Shared','active',1),('agent-b','Shared','active',1),('disabled','Shared','disabled',1);`);
  const migrationClock = () => 100;
  const migration = createImMigration({ db, clock: migrationClock, authorizeAdmin: options.authorizeAdmin ??
    (context => context === 'trusted' ? 'trusted-operator' : null) });
  return { db, migration, clock: migrationClock, context: 'trusted' };
}
const count = (db, table) => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const binding = (legacyMember, agentId) => ({ legacyMember, agentId });
const preview = (migration, bindings) => migration.previewLegacyBindings(bindings, 'trusted');
const commit = (migration, p, extra = {}) => migration.commitLegacyBindings({ previewId: p.previewId,
  sourceFingerprint: p.sourceFingerprint, approvedBindings: p.proposedBindings,
  approvalRef: 'change-123', ...extra }, 'trusted');

test('preview is deterministic, read-only, explicit and insensitive to incoming legacy messages', t => {
  const { db, migration } = fixture(t);
  const legacyBefore = digest(['members', 'messages', 'attachments'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  const p = preview(migration, [binding('old-b', 'agent-b'), binding('old-a', 'agent-a')]);
  assert.deepEqual(p, preview(migration, [binding('old-a', 'agent-a'), binding('old-b', 'agent-b')]));
  assert.equal(count(db, 'im_migration_runs'), 0);
  assert.equal(count(db, 'im_legacy_bindings'), 0);
  assert.equal(count(db, 'im_audit'), 0);
  assert.equal(db.prepare('SELECT last_observed_at n FROM im_clock').get().n, 0);
  assert.equal(digest(['members', 'messages', 'attachments'].map(table => db.prepare(`SELECT * FROM ${table}`).all())), legacyBefore);
  db.exec("INSERT INTO messages VALUES (2,'old-b','old-a','new legacy private message',NULL)");
  assert.deepEqual(p, preview(migration, p.proposedBindings));
  assert.equal(commit(migration, p).bindingCount, 2);
  assert.equal(count(db, 'messages'), 2);
  assert.equal(count(db, 'im_messages'), 0);
  assert.equal(count(db, 'im_conversations'), 0);
  assert.equal(count(db, 'im_attachments'), 0);
});

test('reject malformed, duplicate, unknown, revoked or disabled bindings without guessing names', t => {
  const { db, migration } = fixture(t);
  for (const input of [[], [binding('old-a', 'agent-a'), binding('old-a', 'agent-b')],
    [binding('old-a', 'agent-a'), binding('old-b', 'agent-a')],
    [binding('Shared', 'agent-a')], [binding('old-a', 'Shared')], [binding('old-a', 'disabled')],
    [{ ...binding('old-a', 'agent-a'), admin: true }]]) {
    assert.throws(() => preview(migration, input), { name: 'ImError' });
  }
  db.exec("UPDATE members SET revoked_at='today' WHERE name='old-a'");
  assert.throws(() => preview(migration, [binding('old-a', 'agent-a')]), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('stale state, altered approval, and binding collisions reject; exact completed batch idempotent', t => {
  const { db, migration } = fixture(t);
  const p = preview(migration, [binding('old-a', 'agent-a'), binding('old-b', 'agent-b')]);
  assert.throws(() => commit(migration, p, { approvedBindings: [binding('old-a', 'agent-a')] }), { code: 'IDEMPOTENCY_CONFLICT' });
  db.exec("UPDATE im_agents SET status='disabled' WHERE agent_id='agent-b'");
  assert.throws(() => commit(migration, p), { code: 'IDEMPOTENCY_CONFLICT' });
  db.exec("UPDATE im_agents SET status='active' WHERE agent_id='agent-b'");
  const result = commit(migration, p);
  assert.deepEqual(commit(migration, p), result);
  assert.equal(count(db, 'im_migration_runs'), 1);
  assert.equal(count(db, 'im_legacy_bindings'), 2);
  assert.equal(count(db, 'im_audit'), 1);
  assert.throws(() => commit(migration, p, { approvalRef: 'other' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => preview(migration, [binding('old-a', 'agent-b')]), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(db.prepare('SELECT DISTINCT source FROM im_legacy_bindings').all().map(r => r.source), ['legacy_ip']);
});

test('injected second binding failure rolls back business run, binding and audit but retains clock anchor', t => {
  const { db } = fixture(t);
  const proxy = new Proxy(db, { get(target, prop) {
    if (prop === 'prepare') return sql => {
      const statement = target.prepare(sql);
      if (!sql.startsWith('INSERT INTO im_legacy_bindings')) return statement;
      let calls = 0;
      return new Proxy(statement, { get(stmt, key) {
        if (key === 'run') return (...args) => { if (++calls === 2) throw new Error('injected failure'); return stmt.run(...args); };
        const value = stmt[key]; return typeof value === 'function' ? value.bind(stmt) : value;
      } });
    };
    const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const migration = createImMigration({ db: proxy, clock: () => 100, authorizeAdmin: () => 'trusted-operator' });
  const p = preview(migration, [binding('old-a', 'agent-a'), binding('old-b', 'agent-b')]);
  assert.throws(() => commit(migration, p), /injected failure/);
  for (const table of ['im_migration_runs', 'im_legacy_bindings', 'im_audit']) assert.equal(count(db, table), 0);
  assert.equal(db.prepare('SELECT last_observed_at n FROM im_clock').get().n, 100);
});

test('unauthorized management rejects even caller admin assertions; sync callback and safe actor required', t => {
  const { migration } = fixture(t);
  assert.throws(() => migration.previewLegacyBindings([binding('old-a', 'agent-a')], { admin: true }), { code: 'OPERATION_FORBIDDEN' });
  assert.throws(() => migration.setImWriteMode({ mode: 'paused', reason: 'maintenance' }, { admin: true }), { code: 'OPERATION_FORBIDDEN' });
  const { db, clock } = fixture(t);
  const noAuth = createImMigration({ db, clock });
  assert.throws(() => noAuth.previewLegacyBindings([], { admin: true }), { code: 'OPERATION_FORBIDDEN' });
  const asyncAuth = createImMigration({ db, clock, authorizeAdmin: async () => 'actor' });
  assert.throws(() => asyncAuth.previewLegacyBindings([binding('old-a', 'agent-a')], 'trusted'), { code: 'OPERATION_FORBIDDEN' });
  const echo = createImMigration({ db, clock, authorizeAdmin: context => context });
  assert.throws(() => echo.previewLegacyBindings([binding('old-a', 'agent-a')], 'trusted'), { code: 'OPERATION_FORBIDDEN' });
});

test('pause preserves legacy and IM state; enable requires complete parsed policy and authorization', t => {
  const { db, migration } = fixture(t);
  const before = digest(['members', 'messages', 'attachments', 'im_messages', 'im_send_keys',
    'im_deliveries', 'im_receiver_leases'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  assert.equal(migration.getWriteMode(), 'paused');
  assert.throws(() => migration.setImWriteMode({ mode: 'enabled', reason: 'test' }, 'trusted'), { code: 'POLICY_NOT_CONFIGURED' });
  assert.throws(() => migration.setImWriteMode({ mode: 'enabled', reason: 'test', policy: { enabled: true, writeMode: 'enabled' } }, 'trusted'), { code: 'POLICY_NOT_CONFIGURED' });
  assert.equal(migration.setImWriteMode({ mode: 'enabled', reason: 'approved rollout', policy }, 'trusted').mode, 'enabled');
  assert.equal(migration.setImWriteMode({ mode: 'paused', reason: 'incident' }, 'trusted').mode, 'paused');
  assert.equal(migration.getWriteMode(), 'paused');
  assert.equal(digest(['members', 'messages', 'attachments', 'im_messages', 'im_send_keys',
    'im_deliveries', 'im_receiver_leases'].map(table => db.prepare(`SELECT * FROM ${table}`).all())), before);
  assert.equal(count(db, 'im_audit'), 2);
  assert.throws(() => migration.setImWriteMode({ mode: 'enabled', reason: 'bad', policy, extra: true }, 'trusted'), { code: 'INVALID_REQUEST' });
});

test('factory validates schema once; repeated mode reads avoid manifest and foreign key checks', t => {
  const { db } = fixture(t);
  const sqls = [];
  const proxy = new Proxy(db, { get(target, prop) {
    if (prop === 'prepare') return sql => { sqls.push(sql); return target.prepare(sql); };
    const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const migration = createImMigration({ db: proxy, authorizeAdmin: () => 'operator' });
  assert.ok(sqls.some(sql => /PRAGMA foreign_key_check/.test(sql)));
  sqls.length = 0;
  for (let i = 0; i < 50; i++) assert.equal(migration.getWriteMode(), 'paused');
  assert.ok(sqls.every(sql => sql === 'PRAGMA synchronous'));
});

test('malformed schema fails at factory construction, before any mode lookup', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  assert.throws(() => createImMigration({ db, authorizeAdmin: () => 'operator' }), /IM_SCHEMA_MISMATCH|schema/i);
});
