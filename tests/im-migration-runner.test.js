import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateImSchema } from '../src/im/schema.js';
import { createImBackup } from '../src/im/backup.js';
import { createImMigrationRunner } from '../src/im/migration-runner.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImAuth } from '../src/im/auth.js';
import { createImAcl } from '../src/im/acl.js';
import { createImMessages } from '../src/im/messages.js';
import { createImDelivery } from '../src/im/delivery.js';
import { createImMigration } from '../src/im/migration.js';
import { createAdminAuthority } from '../src/im/keystore.js';
import { PROTOCOL } from '../src/im/contracts.js';

const bindings = [{ legacyMember: 'old-a', agentId: 'agent-a' }, { legacyMember: 'old-b', agentId: 'agent-b' }];
const clone = value => structuredClone(value);
const count = (db, table) => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const policy = { enabled: true, writeMode: 'enabled', transport: { mode: 'local-test', serverUrl: 'http://localhost:8787' },
  retention: { policy: { messageRetentionMs: 100000, attachmentRetentionMs: 90000,
    idempotencyRetentionMs: 110000, safeRetryWindowMs: 10000 } }, lease: { ttlMs: 5000, renewalMs: 1000 } };

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'im-migration-runner-'));
  const db = new DatabaseSync(join(dir, 'live.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE members(name TEXT PRIMARY KEY,revoked_at TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,from_name TEXT,to_name TEXT,text TEXT,read_at TEXT);
    INSERT INTO members VALUES ('old-a',NULL),('old-b',NULL);
    INSERT INTO messages VALUES (1,'old-a','old-b','private',NULL);`);
  migrateImSchema(db);
  let time = 1000;
  const clock = () => options.clock?.() ?? time;
  db.exec(`INSERT INTO im_agents(agent_id,display_name,status,created_at) VALUES
    ('agent-a','A','active',1),('agent-b','B','active',1);`);
  const secret = randomBytes(32).toString('hex');
  const secretFile = join(dir, 'admin.secret');
  writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(secretFile, 0o600);
  const context = Object.freeze({ adminSecret: secret });
  const authority = createAdminAuthority({ secretFile, trustWindowsPermissions: process.platform === 'win32', report: () => {} });
  const approvals = new Set();
  const approvalAuthority = { authorizeApproval: approval => approvals.has(JSON.stringify(approval)) };
  // Real backup service; Windows cannot fsync directories, so the isolated test permits degraded durability.
  const backup = createImBackup({ db, authority, clock, durability: process.platform === 'win32' ? 'best-effort' : 'strict' });
  // TEST DOUBLE only: production registration and instance identity require the later schema package.
  const registrations = new Map();
  const provenanceResolver = { resolve: identity => {
    options.probe?.('provenance', db.isTransaction);
    return registrations.get(identity.backupId);
  } };
  const runner = createImMigrationRunner({ db, authority, approvalAuthority, backup,
    provenanceResolver: options.noProvenance ? undefined : provenanceResolver,
    sourceId: 'isolated-source', clock, fault: options.fault, probe: options.probe });
  const approved = async () => {
    const pair = await runner.createBackup({ destinationPath: join(dir, `${randomUUID()}.sqlite`), approvalId: 'local-approval' }, context);
    assert.equal(pair.manifest.approvalId, 'local-approval');
    if (!options.noRegistration) registrations.set(pair.manifest.backupId, {
      registered: true, publicationState: 'published', revoked: false, registrationGeneration: 'test-generation-1',
      sourceId: pair.manifest.sourceId,
      sourceInstance: runner.preview(bindings, { backupPath: pair.backupPath, manifestPath: pair.manifestPath }, context).package.sourceInstance,
      backupId: pair.manifest.backupId, fileHash: pair.manifest.fileHash,
      schemaVersion: pair.manifest.schemaVersion, schemaChecksum: pair.manifest.schemaChecksum });
    const backupPair = { backupPath: pair.backupPath, manifestPath: pair.manifestPath };
    const preview = runner.preview(bindings, backupPair, context);
    const approval = { approver: 'reviewer-1', planHash: preview.planHash, backupId: preview.package.backupId };
    approvals.add(JSON.stringify(approval));
    return { pair, preview, approval, request: { ...preview, approval, backup: backupPair } };
  };
  return { dir, db, clock, runner, approved, approvals, context, authority, registrations,
    setTime: value => { time = value; } };
}

test('local literal-true authentication, independently approved complete package and verified backup required', async t => {
  const f = fixture(t);
  const { context } = f;
  const { request } = await f.approved();
  assert.throws(() => f.runner.commit({ ...request, backup: undefined }, context), { code: 'MIGRATION_BACKUP_REQUIRED' });
  assert.throws(() => f.runner.commit(request, { admin: true }), { code: 'MIGRATION_AUTH_DENIED' });
  const forged = clone(request);
  forged.approval.approver = 'forged';
  assert.throws(() => f.runner.commit(forged, context), { code: 'MIGRATION_APPROVAL_INVALID' });
  writeFileSync(request.backup.manifestPath, '{}');
  assert.throws(() => f.runner.commit(request, context), { code: 'MIGRATION_BACKUP_REQUIRED' });
  assert.equal(count(f.db, 'im_legacy_bindings'), 0);
  for (const authority of [undefined, { authorizeAdmin: () => Promise.resolve(true) }, { authorizeAdmin: () => { throw Error('no'); } }]) {
    const denied = createImMigrationRunner({ db: f.db, authority, sourceId: 'isolated-source', clock: f.clock });
    assert.throws(() => denied.preview(bindings, request.backup, context), { code: 'MIGRATION_AUTH_DENIED' });
  }
});

test('new legacy and real IM messages do not stale preview; binding never changes old rights/read state', async t => {
  const f = fixture(t);
  const { context } = f;
  const { request } = await f.approved();
  const admin = createImAdmin({ db: f.db, clock: f.clock, authorizeAdmin: () => true });
  const auth = createImAuth({ db: f.db, clock: f.clock });
  const acl = createImAcl({ db: f.db, clock: f.clock, auth });
  const messages = createImMessages({ db: f.db, clock: f.clock, auth, acl, policy });
  const delivery = createImDelivery({ db: f.db, clock: f.clock, auth, acl, policy });
  const ids = ['sender', 'receiver'].map(displayName => admin.registerAgent({ displayName }, context).agentId);
  const principals = ids.map(agentId => auth.authenticate(admin.issueCredential({ agentId, expiresAt: null }, context).credential));
  admin.setContact({ agentA: ids[0], agentB: ids[1], allowed: true, reason: 'test' }, context);
  createImMigration({ db: f.db, clock: f.clock, authorizeAdmin: () => 'local-admin' })
    .setImWriteMode({ mode: 'enabled', reason: 'isolated test', policy }, context);
  const conversationId = messages.ensureConversation(principals[0], { peerAgentId: ids[1] }).conversationId;
  const sent = messages.send(principals[0], { protocol: PROTOCOL, conversationId, recipientAgentId: ids[1], clientMessageId: randomUUID(), text: 'accepted' });
  const instanceId = randomUUID();
  const lease = delivery.acquire(principals[1], { instanceId, requestId: randomUUID() });
  delivery.ack(principals[1], { instanceId, generation: lease.generation, messageIds: [sent.messageId] });
  f.db.exec("INSERT INTO messages VALUES (2,'old-b','old-a','after preview',NULL)");
  const before = ['messages', 'im_messages', 'im_send_keys', 'im_deliveries', 'im_receive_state', 'im_credentials']
    .map(table => JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all()));
  assert.equal(f.runner.commit(request, context).bindingCount, 2);
  assert.deepEqual(['messages', 'im_messages', 'im_send_keys', 'im_deliveries', 'im_receive_state', 'im_credentials']
    .map(table => JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all())), before);
  assert.equal(f.db.prepare('SELECT read_at FROM messages WHERE id=1').get().read_at, null);
  assert.equal(f.db.prepare('SELECT from_name FROM messages WHERE id=1').get().from_name, 'old-a');
  assert.equal(count(f.db, 'im_audit') >= 1, true);
  // Application rollback means gating new writes, not replacing a live database.
  createImMigration({ db: f.db, clock: f.clock, authorizeAdmin: () => 'local-admin' })
    .setImWriteMode({ mode: 'paused', reason: 'rollback' }, context);
  assert.equal(f.db.prepare('SELECT text FROM im_messages WHERE message_id=?').get(sent.messageId).text, 'accepted');
  assert.equal(f.db.prepare('SELECT write_mode FROM im_settings').get().write_mode, 'paused');
});

test('identity or binding drift and tampering full list, actor, approval, backup and versions fail', async t => {
  const f = fixture(t);
  const { context } = f;
  const { request } = await f.approved();
  for (const change of [r => r.package.proposedBindings.pop(), r => { r.package.toolVersion = 'v2'; },
    r => { r.package.planVersion = 'v2'; }, r => { r.package.sourceId = 'other'; },
    r => { r.package.backupId = 'other'; }, r => { r.approval.planHash = '0'.repeat(64); },
    r => { r.planHash = '0'.repeat(64); }]) {
    const modified = clone(request); change(modified);
    assert.throws(() => f.runner.commit(modified, context));
  }
  const otherActor = createImMigrationRunner({ db: f.db, authority: f.authority,
    approvalAuthority: { authorizeApproval: () => true }, provenanceResolver: { resolve: identity => f.registrations.get(identity.backupId) },
    actorId: 'different-actor', sourceId: 'isolated-source', clock: f.clock });
  assert.throws(() => otherActor.commit(request, context), { code: 'MIGRATION_STALE' });
  f.db.exec("UPDATE im_agents SET status='disabled' WHERE agent_id='agent-a'");
  assert.throws(() => f.runner.commit(request, context), { code: 'MIGRATION_STALE' });
  f.db.exec("UPDATE im_agents SET status='active' WHERE agent_id='agent-a'");
  f.db.exec(`INSERT INTO im_migration_runs VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','completed','other',1,1);
    INSERT INTO im_legacy_bindings VALUES ('old-a','agent-a','other','11111111-1111-1111-1111-111111111111','active','legacy_ip')`);
  assert.throws(() => f.runner.commit(request, context), { code: 'MIGRATION_STALE' });
});

test('fault on second transaction write rolls back only batch; exact completed retry is no-op', async t => {
  let writes = 0;
  const f = fixture(t, { fault: () => { if (++writes === 2) throw Error('injected'); } });
  const { context } = f;
  const { request } = await f.approved();
  f.db.exec("INSERT INTO messages VALUES (2,'old-b','old-a','accepted',NULL)");
  const admin = createImAdmin({ db: f.db, clock: f.clock, authorizeAdmin: () => true });
  const auth = createImAuth({ db: f.db, clock: f.clock });
  const acl = createImAcl({ db: f.db, clock: f.clock, auth });
  const messages = createImMessages({ db: f.db, clock: f.clock, auth, acl, policy });
  const delivery = createImDelivery({ db: f.db, clock: f.clock, auth, acl, policy });
  const ids = ['sender', 'receiver'].map(displayName => admin.registerAgent({ displayName }, context).agentId);
  const principals = ids.map(agentId => auth.authenticate(admin.issueCredential({ agentId, expiresAt: null }, context).credential));
  admin.setContact({ agentA: ids[0], agentB: ids[1], allowed: true, reason: 'test' }, context);
  createImMigration({ db: f.db, clock: f.clock, authorizeAdmin: () => 'local-admin' })
    .setImWriteMode({ mode: 'enabled', reason: 'isolated test', policy }, context);
  const conversationId = messages.ensureConversation(principals[0], { peerAgentId: ids[1] }).conversationId;
  const sent = messages.send(principals[0], { protocol: PROTOCOL, conversationId,
    recipientAgentId: ids[1], clientMessageId: randomUUID(), text: 'accepted before fault' });
  const instanceId = randomUUID();
  const lease = delivery.acquire(principals[1], { instanceId, requestId: randomUUID() });
  delivery.ack(principals[1], { instanceId, generation: lease.generation, messageIds: [sent.messageId] });
  const preserved = ['messages', 'im_messages', 'im_send_keys', 'im_deliveries', 'im_receive_state', 'im_credentials']
    .map(table => JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all()));
  assert.throws(() => f.runner.commit(request, context), /injected/);
  assert.equal(count(f.db, 'im_migration_runs'), 0);
  assert.equal(count(f.db, 'im_legacy_bindings'), 0);
  assert.equal(count(f.db, 'messages'), 2);
  assert.deepEqual(['messages', 'im_messages', 'im_send_keys', 'im_deliveries', 'im_receive_state', 'im_credentials']
    .map(table => JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all())), preserved);
  const completed = f.runner.commit(request, context);
  assert.deepEqual(f.runner.commit(request, context), completed);
  assert.equal(count(f.db, 'im_legacy_bindings'), 2);
  assert.equal(f.db.prepare("SELECT count(*) n FROM im_audit WHERE action='legacy_bindings_committed'").get().n, 1);
});

test('provenance is mandatory, published, unrevoked, instance-bound and exact-match; no failures write', async t => {
  const missing = fixture(t, { noProvenance: true });
  const noResolver = await missing.approved();
  assert.throws(() => missing.runner.commit(noResolver.request, missing.context), { code: 'MIGRATION_PROVENANCE_REQUIRED' });
  assert.equal(count(missing.db, 'im_migration_runs'), 0);

  const f = fixture(t, { noRegistration: true });
  const { request } = await f.approved();
  const backupId = request.package.backupId;
  assert.throws(() => f.runner.commit(request, f.context), { code: 'MIGRATION_PROVENANCE_REJECTED' });
  const good = { registered: true, publicationState: 'published', revoked: false,
    registrationGeneration: 'test-generation-1', sourceId: request.package.sourceId,
    sourceInstance: request.package.sourceInstance, backupId, fileHash: request.package.fileHash,
    schemaVersion: request.package.schemaVersion, schemaChecksum: request.package.schemaChecksum };
  for (const change of [
    { registered: false }, { publicationState: 'pending' }, { revoked: true },
    { sourceInstance: 'other' }, { registrationGeneration: null },
    { backupId: 'other' }, { fileHash: '0'.repeat(64) },
    { schemaVersion: -1 }, { schemaChecksum: '0'.repeat(64) },
  ]) {
    f.registrations.set(backupId, { ...good, ...change });
    assert.throws(() => f.runner.commit(request, f.context), { code: 'MIGRATION_PROVENANCE_REJECTED' });
    assert.equal(count(f.db, 'im_legacy_bindings'), 0);
  }
  f.registrations.set(backupId, good);
  assert.equal(f.runner.commit(request, f.context).bindingCount, 2);
});

test('expiry is exclusive inside transaction, including time advancement after external preflight', async t => {
  for (const [inside, allowed] of [[300999, true], [301000, false], [301001, false]]) {
    let advance;
    const f = fixture(t, { probe: (event, locked) => {
      if (event === 'provenance' && locked) advance?.();
    } });
    const { request } = await f.approved();
    advance = () => f.setTime(inside);
    if (allowed) assert.equal(f.runner.commit(request, f.context).bindingCount, 2);
    else assert.throws(() => f.runner.commit(request, f.context), { code: 'MIGRATION_APPROVAL_INVALID' });
    assert.equal(count(f.db, 'im_legacy_bindings'), allowed ? 2 : 0);
  }
});

test('physical backup verification stays outside the immediate write transaction', async t => {
  const seen = [];
  const f = fixture(t, { probe: (event, locked) => seen.push([event, locked]) });
  const { request } = await f.approved();
  seen.length = 0;
  f.runner.commit(request, f.context);
  assert.deepEqual(seen.filter(([event]) => event === 'backup-verification'), [['backup-verification', false]]);
  assert.deepEqual(seen.filter(([event]) => event === 'provenance'), [['provenance', false], ['provenance', true]]);
});

test('provenance generation change or revocation under write lock refuses commit', async t => {
  for (const kind of ['generation', 'revocation']) {
    let switchState;
    const f = fixture(t, { probe: (event, locked) => {
      if (event === 'provenance' && locked) switchState?.();
    } });
    const { request } = await f.approved();
    switchState = () => {
      const record = f.registrations.get(request.package.backupId);
      f.registrations.set(request.package.backupId, { ...record,
        ...(kind === 'generation' ? { registrationGeneration: 'test-generation-2' } : { revoked: true }) });
    };
    assert.throws(() => f.runner.commit(request, f.context), { code: 'MIGRATION_PROVENANCE_REJECTED' });
    assert.equal(count(f.db, 'im_migration_runs'), 0);
  }
});
