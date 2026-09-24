import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateImSchema, migrateImSchemaV3, initInstanceIdentity } from '../src/im/schema.js';
import { createTrustedMigrationServices } from '../src/im/migration-services.js';
import { createImMigrationRunner } from '../src/im/migration-runner.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImAuth } from '../src/im/auth.js';
import { createImAcl } from '../src/im/acl.js';
import { createImMessages } from '../src/im/messages.js';
import { createImDelivery } from '../src/im/delivery.js';
import { createImMigration } from '../src/im/migration.js';
import { PROTOCOL } from '../src/im/contracts.js';

const unix = process.platform !== 'win32';
const bindings = [{ legacyMember: 'old-b', agentId: 'agent-b' }, { legacyMember: 'old-a', agentId: 'agent-a' }];
const count = (db, table) => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const policy = { enabled: true, writeMode: 'enabled', transport: { mode: 'local-test', serverUrl: 'http://localhost:8787' },
  retention: { policy: { messageRetentionMs: 100000, attachmentRetentionMs: 90000,
    idempotencyRetentionMs: 110000, safeRetryWindowMs: 10000 } }, lease: { ttlMs: 5000, renewalMs: 1000 } };
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'im-migration-c-'));
  chmodSync(root, 0o700);
  const dir = join(root, 'registry'); mkdirSync(dir, { mode: 0o700 }); mkdirSync(join(dir, 'artifacts'), { mode: 0o700 });
  const db = new DatabaseSync(join(root, 'live.sqlite'));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE members(name TEXT PRIMARY KEY, revoked_at TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, from_name TEXT, to_name TEXT, text TEXT, read_at TEXT);
    INSERT INTO members VALUES ('old-a',NULL),('old-b',NULL);
    INSERT INTO messages VALUES (1,'old-a','old-b','private',NULL)`);
  migrateImSchemaV3(db); initInstanceIdentity(db, { clock: () => 1 });
  db.exec("INSERT INTO im_agents(agent_id,display_name,status,created_at) VALUES ('agent-a','A','active',1),('agent-b','B','active',1)");
  let time = 1000;
  const clock = () => time;
  const authority = { authorizeAdmin: context => context === 'admin',
    publicationActors: () => ({ executorActorId: 'executor', backupApproverId: 'backup-reviewer' }) };
  const approvals = new Set();
  const approvalAuthority = { authorizeApproval: approval => approvals.has(JSON.stringify(approval)) };
  const services = createTrustedMigrationServices({ db, dir, authority, approvalAuthority, actorId: 'operator', clock,
    approvalTtlMs: 1000 });
  const runner = overrides.fault ? createImMigrationRunner({ db, registry: services.registry,
    publisher: services.publisher, authority, approvalAuthority, actorId: 'operator', clock,
    approvalTtlMs: 1000, fault: overrides.fault }) : services.runner;
  async function approved() {
    const published = await services.publisher.publish({ adminContext: 'admin', approvalId: 'backup-review' });
    const preview = runner.preview(bindings, { backupId: published.backupId }, 'admin');
    const approval = { approver: 'migration-reviewer', planHash: preview.planHash, backupId: published.backupId };
    approvals.add(JSON.stringify(approval));
    return { published, preview, approval, request: { ...preview, approval } };
  }
  return { db, dir, root, runner, services, approvals, approved, authority, approvalAuthority, clock,
    setTime(value) { time = value; } };
}

function acceptedTraffic(f) {
  const admin = createImAdmin({ db: f.db, clock: f.clock, authorizeAdmin: () => true });
  const auth = createImAuth({ db: f.db, clock: f.clock });
  const acl = createImAcl({ db: f.db, clock: f.clock, auth });
  const messages = createImMessages({ db: f.db, clock: f.clock, auth, acl, policy });
  const delivery = createImDelivery({ db: f.db, clock: f.clock, auth, acl, policy });
  const agents = ['sender', 'recipient'].map(displayName => admin.registerAgent({ displayName }, 'admin').agentId);
  const principals = agents.map(agentId => auth.authenticate(admin.issueCredential({ agentId, expiresAt: null }, 'admin').credential));
  admin.setContact({ agentA: agents[0], agentB: agents[1], allowed: true, reason: 'isolated test' }, 'admin');
  const migration = createImMigration({ db: f.db, clock: f.clock, authorizeAdmin: () => 'operator' });
  migration.setImWriteMode({ mode: 'enabled', reason: 'isolated test', policy }, 'admin');
  const conversationId = messages.ensureConversation(principals[0], { peerAgentId: agents[1] }).conversationId;
  const key = randomUUID();
  const sent = messages.send(principals[0], { protocol: PROTOCOL, conversationId,
    recipientAgentId: agents[1], clientMessageId: key, text: 'accepted' });
  const instanceId = randomUUID();
  const lease = delivery.acquire(principals[1], { instanceId, requestId: randomUUID() });
  const synced = delivery.sync(principals[1], { instanceId, generation: lease.generation });
  assert.deepEqual(synced.items.map(item => item.message.messageId), [sent.messageId]);
  const acknowledged = delivery.ack(principals[1], { instanceId, generation: lease.generation, messageIds: [sent.messageId] });
  assert.equal(acknowledged.ackedThrough, synced.items[0].seq);
  assert.equal(f.db.prepare('SELECT acked_at FROM im_deliveries WHERE message_id=?').get(sent.messageId).acked_at !== null, true);
  assert.equal(f.db.prepare('SELECT acked_through FROM im_receive_state WHERE agent_id=?').get(agents[1]).acked_through,
    synced.items[0].seq);
  f.db.exec("INSERT INTO messages VALUES (2,'old-b','old-a','accepted before binding',NULL)");
  const tables = ['messages', 'im_messages', 'im_send_keys', 'im_deliveries', 'im_receive_state', 'im_credentials', 'im_receiver_leases'];
  const snapshot = () => tables.map(table => JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all()));
  return { migration, sent, key, snapshot, before: snapshot() };
}

test('real registry discovery is denied before authorization; strict package, approval and retry', { skip: !unix }, async t => {
  const f = fixture(t);
  const { published, preview, request } = await f.approved();
  assert.equal(preview.package.toolVersion, 'im-migration-runner-v2');
  assert.equal(preview.package.registrationGeneration, 1);
  assert.deepEqual(preview.package.proposedBindings, [...bindings].reverse());
  assert.equal(preview.package.instanceId, f.services.registry.getInstance().instanceId);
  assert.equal(preview.package.manifestHash.length, 64);
  const registry = f.services.registry;
  let discoveryCalls = 0;
  const deniedRunner = createImMigrationRunner({ db: f.db, publisher: f.services.publisher,
    registry: { ...registry, withDiscoveredBackup(...args) { discoveryCalls++; return registry.withDiscoveredBackup(...args); } },
    authority: f.authority, approvalAuthority: f.approvalAuthority, actorId: 'operator', clock: f.clock });
  assert.throws(() => deniedRunner.preview(bindings, { backupId: published.backupId }, 'guest'), { code: 'MIGRATION_AUTH_DENIED' });
  assert.equal(discoveryCalls, 0);
  assert.throws(() => f.runner.preview(bindings, { backupId: randomUUID() }, 'guest'), { code: 'MIGRATION_AUTH_DENIED' });
  assert.throws(() => f.runner.preview(bindings, { backupPath: published.artifactReference }, 'admin'), { code: 'MIGRATION_BACKUP_REQUIRED' });
  assert.throws(() => f.runner.commit({ ...request, backupPath: published.artifactReference }, 'admin'), { code: 'MIGRATION_APPROVAL_INVALID' });
  assert.throws(() => f.runner.commit({ ...request, approval: { ...request.approval, approver: 'backup-reviewer' } }, 'admin'),
    { code: 'MIGRATION_APPROVAL_INVALID' });
  for (const [key, value] of [['toolVersion', 'im-migration-runner-v1'], ['registrationGeneration', '1'],
    ['instanceId', 'path-hash'], ['manifestHash', undefined], ['fileHash', '0'.repeat(64)]]) {
    const altered = structuredClone(request); altered.package[key] = value;
    assert.throws(() => f.runner.commit(altered, 'admin'), { code: 'MIGRATION_APPROVAL_INVALID' });
  }
  f.db.exec("INSERT INTO messages VALUES (2,'old-b','old-a','later',NULL)");
  const initial = ['messages', 'im_messages', 'im_send_keys', 'im_deliveries', 'im_receive_state', 'im_credentials', 'im_receiver_leases']
    .map(table => JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all()));
  const result = f.runner.commit(request, 'admin');
  assert.deepEqual(f.runner.commit(request, 'admin'), result);
  assert.equal(count(f.db, 'im_legacy_bindings'), 2);
  assert.equal(count(f.db, 'im_migration_runs'), 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM im_audit WHERE action='legacy_bindings_committed'").get().n, 1);
  assert.deepEqual(['messages', 'im_messages', 'im_send_keys', 'im_deliveries', 'im_receive_state', 'im_credentials', 'im_receiver_leases']
    .map(table => JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all())), initial);
  assert.equal(f.db.prepare('SELECT read_at FROM messages WHERE id=1').get().read_at, null);
});

test('business failure rolls back bindings but persists clock floor; expiry is exclusive', { skip: !unix }, async t => {
  let writes = 0;
  const f = fixture(t, { fault: () => { if (++writes === 2) throw Error('injected'); } });
  const { request } = await f.approved();
  assert.throws(() => f.runner.commit(request, 'admin'), /injected/);
  assert.equal(count(f.db, 'im_legacy_bindings'), 0);
  assert.equal(count(f.db, 'im_migration_runs'), 0);
  assert.ok(f.db.prepare('SELECT last_observed_at FROM im_clock WHERE singleton=1').get().last_observed_at >= 1000);
  f.setTime(request.package.expiresAt);
  assert.throws(() => f.runner.commit(request, 'admin'), { code: 'MIGRATION_APPROVAL_INVALID' });
});

test('expiry after mutation rolls back business writes while retaining fresh clock floor', { skip: !unix }, async t => {
  let f;
  f = fixture(t, { fault: () => f.setTime(2000) });
  const { request } = await f.approved();
  assert.equal(request.package.expiresAt, 2000);
  assert.throws(() => f.runner.commit(request, 'admin'), { code: 'MIGRATION_APPROVAL_INVALID' });
  assert.equal(count(f.db, 'im_legacy_bindings'), 0);
  assert.equal(count(f.db, 'im_migration_runs'), 0);
  assert.equal(f.db.prepare('SELECT last_observed_at FROM im_clock WHERE singleton=1').get().last_observed_at, 2000);
});

test('independent migration approval revocation at transaction boundary prevents writes', { skip: !unix }, async t => {
  const f = fixture(t);
  const { request } = await f.approved();
  let checks = 0;
  const runner = createImMigrationRunner({ db: f.db, registry: f.services.registry, publisher: f.services.publisher,
    authority: f.authority, actorId: 'operator', clock: f.clock, approvalTtlMs: 1000,
    approvalAuthority: { authorizeApproval: approval => ++checks === 1 && f.approvals.has(JSON.stringify(approval)) } });
  assert.throws(() => runner.commit(request, 'admin'), { code: 'MIGRATION_APPROVAL_INVALID' });
  assert.equal(checks, 2);
  assert.equal(count(f.db, 'im_legacy_bindings'), 0);
});

test('lost response after committed callback retries exact approved result without another batch', { skip: !unix }, async t => {
  const f = fixture(t);
  const { request } = await f.approved();
  let uncertain = true;
  const registry = { ...f.services.registry, withVerifiedBackup(input, callback) {
    const result = f.services.registry.withVerifiedBackup(input, callback);
    if (uncertain) { uncertain = false; throw Error('response lost after commit'); }
    return result;
  } };
  // Internal test facade models a post-COMMIT response failure; real registry still
  // performs physical verification and releases its coordinator before the throw.
  const runner = createImMigrationRunner({ db: f.db, registry, publisher: f.services.publisher,
    authority: f.authority, approvalAuthority: f.approvalAuthority, actorId: 'operator', clock: f.clock,
    approvalTtlMs: 1000 });
  assert.throws(() => runner.commit(request, 'admin'), /response lost after commit/);
  assert.equal(count(f.db, 'im_legacy_bindings'), 2);
  const result = runner.commit(request, 'admin');
  assert.equal(result.status, 'completed');
  assert.equal(count(f.db, 'im_migration_runs'), 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM im_audit WHERE action='legacy_bindings_committed'").get().n, 1);
});

test('real v2 schema without initialized identity cannot construct runner', { skip: !unix }, t => {
  const root = mkdtempSync(join(tmpdir(), 'im-c-uninitialized-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, 'live.sqlite')); t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON'); migrateImSchema(db);
  assert.throws(() => createImMigrationRunner({ db, registry: {}, publisher: {}, clock: () => 1000 }),
    { code: 'IM_IDENTITY_MISSING' });
});

test('captured live schema cookie or identity drift refuses commit without binding writes', { skip: !unix }, async t => {
  for (const drift of ['cookie', 'identity']) {
    const f = fixture(t);
    const { request } = await f.approved();
    let changed = false;
    const registry = { ...f.services.registry, withVerifiedBackup(input, callback) {
      return f.services.registry.withVerifiedBackup(input, evidence => {
        if (!changed) {
          changed = true;
          if (drift === 'cookie') f.db.exec('CREATE TABLE unrelated_schema_change (id INTEGER)');
          else f.db.prepare('UPDATE im_instance_identity SET created_at=created_at+1 WHERE singleton=1').run();
        }
        return callback(evidence);
      });
    } };
    const runner = createImMigrationRunner({ db: f.db, registry, publisher: f.services.publisher,
      authority: f.authority, approvalAuthority: f.approvalAuthority, actorId: 'operator', clock: f.clock });
    assert.throws(() => runner.commit(request, 'admin'), { code: 'MIGRATION_STALE' });
    assert.equal(count(f.db, 'im_legacy_bindings'), 0);
  }
});

test('accepted IM message, send key, ACK, receive, credential and lease survive binding and paused rollback',
  { skip: !unix }, async t => {
    const f = fixture(t);
    const { request } = await f.approved();
    const { migration, sent, key, snapshot, before } = acceptedTraffic(f);
    assert.equal(f.runner.commit(request, 'admin').bindingCount, 2);
    assert.deepEqual(snapshot(), before);
    migration.setImWriteMode({ mode: 'paused', reason: 'rollback' }, 'admin');
    assert.deepEqual(snapshot(), before);
    assert.equal(f.db.prepare('SELECT write_mode FROM im_settings WHERE singleton=1').get().write_mode, 'paused');
    assert.equal(f.db.prepare('SELECT read_at FROM messages WHERE id=1').get().read_at, null);
    assert.equal(f.db.prepare('SELECT text FROM im_messages WHERE message_id=?').get(sent.messageId).text, 'accepted');
    assert.equal(f.db.prepare('SELECT message_id FROM im_send_keys WHERE client_message_id=?').get(key).message_id, sent.messageId);
  });

test('failed binding after accepted IM traffic preserves all preexisting records', { skip: !unix }, async t => {
  let writes = 0;
  const f = fixture(t, { fault: () => { if (++writes === 2) throw Error('injected second binding'); } });
  const { request } = await f.approved();
  const { snapshot, before } = acceptedTraffic(f);
  assert.throws(() => f.runner.commit(request, 'admin'), /injected second binding/);
  assert.equal(writes, 2);
  assert.deepEqual(snapshot(), before);
  assert.equal(count(f.db, 'im_legacy_bindings'), 0);
  assert.equal(count(f.db, 'im_migration_runs'), 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM im_audit WHERE action='legacy_bindings_committed'").get().n, 0);
  assert.equal(f.runner.commit(request, 'admin').bindingCount, 2);
  assert.deepEqual(snapshot(), before);
  assert.equal(count(f.db, 'im_legacy_bindings'), 2);
  assert.equal(count(f.db, 'im_migration_runs'), 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM im_audit WHERE action='legacy_bindings_committed'").get().n, 1);
});

test('strict commit uses approved hashes (not discovery), full verification outside transaction and metadata-only recheck inside',
  { skip: !unix }, async t => {
    const f = fixture(t);
    const { request } = await f.approved();
    const seen = [];
    const original = f.services.registry;
    const registry = { ...original,
      withDiscoveredBackup() { throw Error('commit must not discover'); },
      withVerifiedBackup(input, callback) {
        seen.push(['physical', f.db.isTransaction]);
        assert.deepEqual(Object.keys(input.expected).sort(), ['fileHash', 'instanceCreatedAt', 'instanceId',
          'manifestHash', 'registrationGeneration', 'schemaChecksum', 'schemaVersion']);
        return original.withVerifiedBackup(input, evidence => callback(Object.freeze({ ...evidence,
          recheck() { seen.push(['metadata', f.db.isTransaction]); return evidence.recheck(); } })));
      } };
    const runner = createImMigrationRunner({ db: f.db, registry, publisher: f.services.publisher,
      authority: f.authority, approvalAuthority: f.approvalAuthority, actorId: 'operator', clock: f.clock });
    runner.commit(request, 'admin');
    assert.deepEqual(seen, [['physical', false], ['metadata', true]]);
});

test('time expires during independent approval boundary before any binding', { skip: !unix }, async t => {
  const f = fixture(t);
  const { request } = await f.approved();
  let checks = 0;
  const runner = createImMigrationRunner({ db: f.db, registry: f.services.registry, publisher: f.services.publisher,
    authority: f.authority, actorId: 'operator', clock: f.clock, approvalTtlMs: 1000,
    approvalAuthority: { authorizeApproval: approval => {
      if (++checks === 2) f.setTime(request.package.expiresAt);
      return f.approvals.has(JSON.stringify(approval));
    } } });
  assert.throws(() => runner.commit(request, 'admin'), { code: 'MIGRATION_APPROVAL_INVALID' });
  assert.equal(checks, 2);
  assert.equal(count(f.db, 'im_legacy_bindings'), 0);
  assert.equal(f.db.prepare('SELECT last_observed_at FROM im_clock WHERE singleton=1').get().last_observed_at,
    request.package.expiresAt);
});

test('expiry persists through rollback and fresh connection refuses rollback clock', { skip: !unix }, async t => {
  const f = fixture(t);
  const { request } = await f.approved();
  f.setTime(request.package.expiresAt);
  assert.throws(() => f.runner.commit(request, 'admin'), { code: 'MIGRATION_APPROVAL_INVALID' });
  assert.equal(f.db.prepare('SELECT last_observed_at FROM im_clock WHERE singleton=1').get().last_observed_at,
    request.package.expiresAt);
  f.setTime(request.package.expiresAt - 1);
  assert.throws(() => f.runner.commit(request, 'admin'), { code: 'CLOCK_UNSAFE' });
  const reopened = new DatabaseSync(join(f.root, 'live.sqlite'));
  t.after(() => reopened.close());
  reopened.exec('PRAGMA foreign_keys=ON');
  const runner = createImMigrationRunner({ db: reopened, registry: f.services.registry, publisher: f.services.publisher,
    authority: f.authority, approvalAuthority: f.approvalAuthority, actorId: 'operator', clock: f.clock });
  assert.throws(() => runner.commit(request, 'admin'), { code: 'CLOCK_UNSAFE' });
  assert.equal(count(f.db, 'im_migration_runs'), 0);
  assert.equal(count(f.db, 'im_legacy_bindings'), 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM im_audit WHERE action='legacy_bindings_committed'").get().n, 0);
});

test('Unicode member order differs from SQLite BINARY yet exact retry is stable', { skip: !unix }, async t => {
  const f = fixture(t);
  const names = ['\u{10400}', '\uFF21'];
  for (const name of names) f.db.prepare('INSERT INTO members(name,revoked_at) VALUES (?,NULL)').run(name);
  const published = await f.services.publisher.publish({ adminContext: 'admin', approvalId: 'backup-review' });
  const preview = f.runner.preview(names.map((legacyMember, i) => ({ legacyMember, agentId: `agent-${i ? 'b' : 'a'}` })),
    { backupId: published.backupId }, 'admin');
  const approval = { approver: 'migration-reviewer', planHash: preview.planHash, backupId: published.backupId };
  f.approvals.add(JSON.stringify(approval));
  const request = { ...preview, approval };
  const done = f.runner.commit(request, 'admin');
  assert.deepEqual(f.runner.commit(request, 'admin'), done);
  assert.equal(count(f.db, 'im_migration_runs'), 1);
  assert.equal(count(f.db, 'im_legacy_bindings'), 2);
  assert.equal(f.db.prepare("SELECT count(*) n FROM im_audit WHERE action='legacy_bindings_committed'").get().n, 1);
});

test('retry validates indexed complete rowset and captured audit primary key, never scans history under write lock',
  { skip: !unix }, async t => {
    const f = fixture(t);
    const { request } = await f.approved();
    const completed = f.runner.commit(request, 'admin');
    for (let i = 0; i < 150; i++) {
      f.db.prepare('INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json) VALUES (?,?,?,?,?,?)')
        .run('admin', 'operator', 'legacy_bindings_committed', '[]', 1000, JSON.stringify({ runId: `other-${i}` }));
      f.db.prepare('INSERT INTO members(name,revoked_at) VALUES (?,NULL)').run(`unrelated-${i}`);
    }
    const observed = [];
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = sql => {
      if (f.db.isTransaction) observed.push(sql);
      return prepare(sql);
    };
    try { assert.deepEqual(f.runner.commit(request, 'admin'), completed); }
    finally { f.db.prepare = prepare; }
    assert.ok(observed.some(sql => /FROM im_audit WHERE id=\?/.test(sql)));
    assert.ok(observed.some(sql => /FROM im_legacy_bindings INDEXED BY im_legacy_bindings_run WHERE migration_run_id=\? LIMIT \?/.test(sql)));
    assert.ok(!observed.some(sql => /FROM im_audit WHERE action=/.test(sql) ||
      (/FROM im_legacy_bindings WHERE migration_run_id=/.test(sql) && !/INDEXED BY im_legacy_bindings_run/.test(sql))));
    assert.equal(count(f.db, 'im_legacy_bindings'), 2);
  });

test('retry refuses tampered target audit or binding without another batch', { skip: !unix }, async t => {
  for (const tamper of ['audit', 'binding']) {
    const f = fixture(t);
    const { request } = await f.approved();
    f.runner.commit(request, 'admin');
    if (tamper === 'audit') f.db.prepare("UPDATE im_audit SET safe_details_json=? WHERE action='legacy_bindings_committed'")
      .run(JSON.stringify({ runId: request.package.previewId, bindingCount: 2, planHash: request.planHash,
        backupId: request.package.backupId, approver: 'wrong' }));
    else f.db.prepare("UPDATE im_legacy_bindings SET status='revoked' WHERE legacy_member='old-a'").run();
    assert.throws(() => f.runner.commit(request, 'admin'), { code: 'MIGRATION_STALE' });
    assert.equal(count(f.db, 'im_migration_runs'), 1);
    assert.equal(count(f.db, 'im_legacy_bindings'), 2);
  }
});

test('complete indexed rowset rejects extra active or revoked binding in completed run', { skip: !unix }, async t => {
  for (const status of ['active', 'revoked']) {
    const f = fixture(t);
    const { request } = await f.approved();
    f.runner.commit(request, 'admin');
    const member = `extra-${status}`, agent = `extra-agent-${status}`;
    f.db.prepare('INSERT INTO members(name,revoked_at) VALUES (?,NULL)').run(member);
    f.db.prepare('INSERT INTO im_agents(agent_id,display_name,status,created_at) VALUES (?,?,?,?)')
      .run(agent, agent, 'active', 1);
    f.db.prepare('INSERT INTO im_legacy_bindings(legacy_member,agent_id,approval_ref,migration_run_id,status,source) VALUES (?,?,?,?,?,?)')
      .run(member, agent, request.planHash, request.package.previewId, status, 'legacy_ip');
    assert.throws(() => f.runner.commit(request, 'admin'), { code: 'MIGRATION_STALE' });
    assert.equal(count(f.db, 'im_legacy_bindings'), 3);
    assert.equal(f.db.prepare("SELECT count(*) n FROM im_audit WHERE action='legacy_bindings_committed'").get().n, 1);
  }
});

test('complete rowset rejects missing row, changed agent or approval, or moved run', { skip: !unix }, async t => {
  for (const tamper of ['missing', 'agent', 'approval', 'run']) {
    const f = fixture(t);
    const { request } = await f.approved();
    f.runner.commit(request, 'admin');
    if (tamper === 'missing') f.db.prepare('DELETE FROM im_legacy_bindings WHERE legacy_member=?').run('old-a');
    if (tamper === 'agent') {
      f.db.prepare('INSERT INTO im_agents(agent_id,display_name,status,created_at) VALUES (?,?,?,?)')
        .run('other-agent', 'Other', 'active', 1);
      f.db.prepare('UPDATE im_legacy_bindings SET agent_id=? WHERE legacy_member=?').run('other-agent', 'old-a');
    }
    if (tamper === 'approval') f.db.prepare('UPDATE im_legacy_bindings SET approval_ref=? WHERE legacy_member=?').run('other', 'old-a');
    if (tamper === 'run') {
      const otherRun = randomUUID();
      f.db.prepare('INSERT INTO im_migration_runs(run_id,preview_hash,status,actor_id,created_at,completed_at) VALUES (?,?,?,?,?,?)')
        .run(otherRun, '0'.repeat(64), 'completed', 'other', 1, 1);
      f.db.prepare('UPDATE im_legacy_bindings SET migration_run_id=? WHERE legacy_member=?').run(otherRun, 'old-a');
    }
    assert.throws(() => f.runner.commit(request, 'admin'), { code: 'MIGRATION_STALE' }, tamper);
    assert.equal(f.db.prepare("SELECT count(*) n FROM im_audit WHERE action='legacy_bindings_committed'").get().n, 1);
  }
});

test('complete run-rowset query uses v3 index and reads at most approvedCount+1', { skip: !unix }, async t => {
  const f = fixture(t);
  const { request } = await f.approved();
  const sql = `SELECT legacy_member,agent_id,approval_ref,migration_run_id,status,source
      FROM im_legacy_bindings INDEXED BY im_legacy_bindings_run WHERE migration_run_id=? LIMIT ?`;
  const explain = f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(request.package.previewId,
    request.package.proposedBindings.length + 1);
  assert.ok(explain.some(row => /SEARCH im_legacy_bindings USING INDEX im_legacy_bindings_run/.test(row.detail)),
    JSON.stringify(explain));
  f.runner.commit(request, 'admin');
  let rows = 0, limit;
  const original = f.db.prepare.bind(f.db);
  f.db.prepare = statement => {
    const prepared = original(statement);
    if (!/FROM im_legacy_bindings INDEXED BY im_legacy_bindings_run/.test(statement)) return prepared;
    return { iterate(runId, requestedLimit) {
      limit = requestedLimit;
      const source = prepared.iterate(runId, requestedLimit);
      return { *[Symbol.iterator]() { for (const row of source) { rows++; yield row; } } };
    } };
  };
  try { f.runner.commit(request, 'admin'); }
  finally { f.db.prepare = original; }
  assert.equal(limit, request.package.proposedBindings.length + 1);
  assert.equal(rows, request.package.proposedBindings.length);
});

test('audit mutated between prelookup and live write boundary is rejected by primary-key recheck',
  { skip: !unix }, async t => {
    const f = fixture(t);
    const { request } = await f.approved();
    f.runner.commit(request, 'admin');
    const original = f.services.registry;
    const registry = { ...original, withVerifiedBackup(input, callback) {
      return original.withVerifiedBackup(input, evidence => {
        f.db.prepare("UPDATE im_audit SET safe_details_json=? WHERE action='legacy_bindings_committed'")
          .run(JSON.stringify({ runId: request.package.previewId, planHash: '0'.repeat(64) }));
        return callback(evidence);
      });
    } };
    const runner = createImMigrationRunner({ db: f.db, registry, publisher: f.services.publisher,
      authority: f.authority, approvalAuthority: f.approvalAuthority, actorId: 'operator', clock: f.clock });
    assert.throws(() => runner.commit(request, 'admin'), { code: 'MIGRATION_STALE' });
    assert.equal(count(f.db, 'im_legacy_bindings'), 2);
    assert.equal(count(f.db, 'im_migration_runs'), 1);
  });

test('extra completed-run row inserted between audit discovery and live transaction rejects retry',
  { skip: !unix }, async t => {
    const f = fixture(t);
    const { request } = await f.approved();
    f.runner.commit(request, 'admin');
    const member = 'late-member', agent = 'late-agent';
    f.db.prepare('INSERT INTO members(name,revoked_at) VALUES (?,NULL)').run(member);
    f.db.prepare('INSERT INTO im_agents(agent_id,display_name,status,created_at) VALUES (?,?,?,?)')
      .run(agent, agent, 'active', 1);
    const other = new DatabaseSync(join(f.root, 'live.sqlite'));
    t.after(() => other.close());
    other.exec('PRAGMA foreign_keys=ON');
    const original = f.services.registry;
    const registry = { ...original, withVerifiedBackup(input, callback) {
      return original.withVerifiedBackup(input, evidence => {
        other.prepare('INSERT INTO im_legacy_bindings(legacy_member,agent_id,approval_ref,migration_run_id,status,source) VALUES (?,?,?,?,?,?)')
          .run(member, agent, request.planHash, request.package.previewId, 'active', 'legacy_ip');
        return callback(evidence);
      });
    } };
    const runner = createImMigrationRunner({ db: f.db, registry, publisher: f.services.publisher,
      authority: f.authority, approvalAuthority: f.approvalAuthority, actorId: 'operator', clock: f.clock });
    assert.throws(() => runner.commit(request, 'admin'), { code: 'MIGRATION_STALE' });
    assert.equal(count(f.db, 'im_legacy_bindings'), 3);
  });

test('last clock callback injecting a new target-run row is rejected by final rowset check',
  { skip: !unix }, async t => {
    let calls = 0, inject = false;
    const root = mkdtempSync(join(tmpdir(), 'im-c-clock-inject-')); chmodSync(root, 0o700);
    const dir = join(root, 'registry'); mkdirSync(dir, { mode: 0o700 }); mkdirSync(join(dir, 'artifacts'), { mode: 0o700 });
    const db = new DatabaseSync(join(root, 'live.sqlite'));
    t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
    db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE members(name TEXT PRIMARY KEY,revoked_at TEXT);
      INSERT INTO members VALUES ('old-a',NULL),('old-b',NULL),('late',NULL)`);
    migrateImSchemaV3(db); initInstanceIdentity(db, { clock: () => 1 });
    db.exec("INSERT INTO im_agents(agent_id,display_name,status,created_at) VALUES ('agent-a','A','active',1),('agent-b','B','active',1),('agent-late','L','active',1)");
    let runId;
    const clock = () => {
      if (inject && ++calls === 4) {
        db.prepare('INSERT INTO im_legacy_bindings(legacy_member,agent_id,approval_ref,migration_run_id,status,source) VALUES (?,?,?,?,?,?)')
          .run('late', 'agent-late', 'late', runId, 'active', 'legacy_ip');
      }
      return 1000;
    };
    const authority = { authorizeAdmin: () => true,
      publicationActors: () => ({ executorActorId: 'executor', backupApproverId: 'backup-reviewer' }) };
    const approvals = new Set();
    const services = createTrustedMigrationServices({ db, dir, authority,
      approvalAuthority: { authorizeApproval: approval => approvals.has(JSON.stringify(approval)) },
      actorId: 'operator', clock, approvalTtlMs: 1000 });
    const published = await services.publisher.publish({ adminContext: {}, approvalId: 'backup-review' });
    const preview = services.runner.preview(bindings, { backupId: published.backupId }, {});
    runId = preview.package.previewId;
    const approval = { approver: 'migration-reviewer', planHash: preview.planHash, backupId: published.backupId };
    approvals.add(JSON.stringify(approval));
    // First commit establishes the valid completed run, then an exact retry
    // exercises final-rowset validation after the last clock refresh.
    services.runner.commit({ ...preview, approval }, {});
    calls = 0; inject = true;
    assert.throws(() => services.runner.commit({ ...preview, approval }, {}), { code: 'MIGRATION_STALE' });
    assert.equal(count(db, 'im_legacy_bindings'), 2); // injected row rolled back with business effects
  });

test('previewed mapping rejects disabled target or conflicting existing binding, preserving conflict',
  { skip: !unix }, async t => {
    for (const drift of ['disabled', 'conflict']) {
      const f = fixture(t);
      const { request } = await f.approved();
      if (drift === 'disabled') f.db.prepare("UPDATE im_agents SET status='disabled' WHERE agent_id='agent-a'").run();
      else {
        f.db.prepare('INSERT INTO im_migration_runs(run_id,preview_hash,status,actor_id,created_at,completed_at) VALUES (?,?,?,?,?,?)')
          .run(randomUUID(), '0'.repeat(64), 'completed', 'other', 1, 1);
        const runId = f.db.prepare("SELECT run_id FROM im_migration_runs WHERE actor_id='other'").get().run_id;
        f.db.prepare("INSERT INTO im_legacy_bindings(legacy_member,agent_id,approval_ref,migration_run_id,status,source) VALUES (?,?,?,?,?,?)")
          .run('old-a', 'agent-a', 'other', runId, 'active', 'legacy_ip');
      }
      assert.throws(() => f.runner.commit(request, 'admin'), { code: 'MIGRATION_STALE' });
      assert.equal(f.db.prepare('SELECT count(*) n FROM im_migration_runs WHERE actor_id=?').get('operator').n, 0);
      assert.equal(f.db.prepare("SELECT count(*) n FROM im_audit WHERE action='legacy_bindings_committed'").get().n, 0);
      assert.equal(count(f.db, 'im_legacy_bindings'), drift === 'conflict' ? 1 : 0);
      if (drift === 'conflict') assert.equal(f.db.prepare('SELECT approval_ref FROM im_legacy_bindings WHERE legacy_member=?').get('old-a').approval_ref, 'other');
    }
  });

test('revoke-first means no migration writes; protected callback blocks revoke and cleanup',
  { skip: !unix }, async t => {
    const f = fixture(t);
    const { request } = await f.approved();
    // Registry permission and native coordinator semantics, not a mocked resolver.
    f.services.registry.revokeBackup({ backupId: request.package.backupId, adminContext: 'admin' });
    assert.throws(() => f.runner.commit(request, 'admin'), { code: 'REGISTRY_REVOKED' });
    assert.equal(count(f.db, 'im_legacy_bindings'), 0);
    const later = await f.approved();
    const other = (await import('../src/im/backup-registry.js')).createBackupRegistry({ dir: f.dir, authority: f.authority });
    const original = f.services.registry;
    const registry = { ...original, withVerifiedBackup(input, callback) {
      return original.withVerifiedBackup(input, evidence => {
        assert.throws(() => other.revokeBackup({ backupId: later.request.package.backupId, adminContext: 'admin' }),
          { code: 'REGISTRY_BUSY' });
        assert.throws(() => other.cleanupBackup({ backupId: later.request.package.backupId, adminContext: 'admin' }),
          { code: 'REGISTRY_BUSY' });
        return callback(evidence);
      });
    } };
    const runner = createImMigrationRunner({ db: f.db, registry, publisher: f.services.publisher,
      authority: f.authority, approvalAuthority: f.approvalAuthority, actorId: 'operator', clock: f.clock });
    assert.equal(runner.commit(later.request, 'admin').bindingCount, 2);
  });
