import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, copyFileSync, openSync, closeSync, constants, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { migrateImSchema } from '../src/im/schema.js';
import { createImClockGuard } from '../src/im/clock-guard.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImAuth } from '../src/im/auth.js';
import { createImAcl } from '../src/im/acl.js';
import { createImMessages } from '../src/im/messages.js';
import { createImDelivery } from '../src/im/delivery.js';
import { createImMigration } from '../src/im/migration.js';
import { createImBackup } from '../src/im/backup.js';
import { createAdminAuthority, createLocalKeystore } from '../src/im/keystore.js';
import { PROTOCOL } from '../src/im/contracts.js';

const policy = { enabled: true, writeMode: 'enabled', transport: { mode: 'local-test', serverUrl: 'http://localhost:8787' },
  retention: { policy: { messageRetentionMs: 100000, attachmentRetentionMs: 90000,
    idempotencyRetentionMs: 110000, safeRetryWindowMs: 10000 } }, lease: { ttlMs: 5000, renewalMs: 1000 } };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const localDurability = process.platform === 'win32' ? 'best-effort' : 'strict';
const runnerFor = options => createImBackup({ durability: localDurability, ...options });

test('online WAL backup preserves real core message, BLOB, key and ACK; tamper fails verification', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-backup-'));
  const source = join(dir, 'source.sqlite');
  const db = new DatabaseSync(source);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
  migrateImSchema(db);
  const context = {};
  const clock = () => 1000;
  const timeGuard = createImClockGuard({ db, clock });
  const migration = createImMigration({ db, clock, timeGuard, authorizeAdmin: c => c === context ? 'operator' : null });
  const admin = createImAdmin({ db, clock, timeGuard, authorizeAdmin: c => c === context });
  const auth = createImAuth({ db, clock, timeGuard });
  const acl = createImAcl({ db, clock, timeGuard, auth });
  const messages = createImMessages({ db, clock, timeGuard, auth, acl, policy });
  const delivery = createImDelivery({ db, clock, timeGuard, auth, acl, policy });
  const agents = ['A', 'B'].map(displayName => {
    const agentId = admin.registerAgent({ displayName }, context).agentId;
    const credential = admin.issueCredential({ agentId, expiresAt: null }, context);
    return { agentId, principal: auth.authenticate(credential.credential) };
  });
  const [a, b] = agents;
  admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: true, reason: 'approved' }, context);
  migration.setImWriteMode({ mode: 'enabled', reason: 'test', policy }, context);
  const conversationId = messages.ensureConversation(a.principal, { peerAgentId: b.agentId }).conversationId;
  const bytes = Buffer.from('actual SQLite attachment BLOB');
  const clientMessageId = randomUUID();
  const sent = messages.send(a.principal, { protocol: PROTOCOL, conversationId, recipientAgentId: b.agentId,
    clientMessageId, text: 'snapshot message', attachment: { name: 'proof.bin', sha256: hash(bytes), dataBase64: bytes.toString('base64') } });
  const instanceId = randomUUID();
  const lease = delivery.acquire(b.principal, { instanceId, requestId: randomUUID() });
  delivery.ack(b.principal, { instanceId, generation: lease.generation, messageIds: [sent.messageId] });
  const runner = runnerFor({ db, authority: { authorizeAdmin: () => true }, clock, toolVersion: 'test-v1' });
  const destinationPath = join(dir, 'snapshot.sqlite');
  const result = await runner.backup({ destinationPath, approvalId: 'local-approval', sourceId: 'isolated-source' });
  assert.equal(runner.verify(result).ok, true);
  assert.equal(result.durability, process.platform === 'win32' ? 'degraded' : 'durable');
  assert.equal(result.manifest.schemaVersion, 2);
  assert.equal(result.manifest.fileHash, hash(readFileSync(destinationPath)));
  assert.equal(JSON.stringify(result.manifest).includes('snapshot message'), false);
  const isolated = join(dir, 'isolated-restore.sqlite');
  copyFileSync(destinationPath, isolated); // ONLY an offline verified backup is copied into an isolated restore location.
  const restored = new DatabaseSync(isolated, { readOnly: true });
  try {
    assert.equal(restored.prepare('SELECT text FROM im_messages WHERE message_id=?').get(sent.messageId).text, 'snapshot message');
    const attachment = restored.prepare('SELECT data,sha256 FROM im_attachments WHERE message_id=?').get(sent.messageId);
    assert.equal(hash(attachment.data), attachment.sha256);
    assert.equal(hash(attachment.data), hash(bytes));
    assert.equal(restored.prepare('SELECT message_id FROM im_send_keys WHERE sender_id=? AND client_message_id=?').get(a.agentId, clientMessageId).message_id, sent.messageId);
    assert.equal(restored.prepare('SELECT acked_through FROM im_receive_state WHERE agent_id=?').get(b.agentId).acked_through, 1);
  } finally { restored.close(); }
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
  manifest.fileHash = '0'.repeat(64);
  writeFileSync(result.manifestPath, JSON.stringify(manifest));
  assert.deepEqual(runner.verify(result), { ok: false, code: 'BACKUP_VERIFY_FAILED' });
  writeFileSync(result.manifestPath, JSON.stringify(result.manifest));
  const fd = openSync(result.backupPath, constants.O_RDWR);
  try { writeSync(fd, Buffer.from([0]), 0, 1, 1024); } finally { closeSync(fd); }
  assert.equal(runner.verify(result).ok, false, 'mutated database bytes fail verification');
});

test('authorization denied, missing, and thenable create no output; existing destination is unchanged', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-backup-denied-'));
  let db;
  t.after(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });
  const destinationPath = join(dir, 'backup.sqlite');
  const input = { destinationPath, approvalId: 'approval', sourceId: 'source' };
  for (const authority of [undefined, { authorizeAdmin: () => false }, { authorizeAdmin: () => Promise.resolve(true) }]) {
    const runner = runnerFor({ authority });
    await assert.rejects(runner.backup(input), { code: 'BACKUP_AUTH_DENIED' });
    assert.deepEqual(readdirSync(dir), []);
  }
  db = new DatabaseSync(join(dir, 'source.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  migrateImSchema(db);
  writeFileSync(destinationPath, 'do not overwrite');
  const runner = runnerFor({ db, authority: { authorizeAdmin: () => true } });
  await assert.rejects(runner.backup(input), { code: 'BACKUP_TARGET_EXISTS' });
  assert.equal(readFileSync(destinationPath, 'utf8'), 'do not overwrite');
  assert.equal(existsSync(`${destinationPath}.manifest.json`), false);
  await assert.rejects(runner.backup({ ...input, destinationPath: join(dir, 'missing-parent', 'backup.sqlite') }), { code: 'BACKUP_FAILED' });
});

test('invalid schema cannot publish proof; failure cleans pending files', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-backup-invalid-'));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('CREATE TABLE arbitrary (value TEXT)');
  const runner = runnerFor({ db, authority: { authorizeAdmin: () => true } });
  const destinationPath = join(dir, 'invalid.sqlite');
  await assert.rejects(runner.backup({ destinationPath, approvalId: 'approval', sourceId: 'source' }), { code: 'BACKUP_VERIFY_FAILED' });
  assert.equal(existsSync(destinationPath), false);
  assert.equal(existsSync(`${destinationPath}.manifest.json`), false);
  assert.equal(readdirSync(dir).some(name => name.includes('.pending')), false);
});

test('simulated interruption after snapshot does not publish manifest or database', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-backup-interrupt-'));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('PRAGMA foreign_keys=ON');
  migrateImSchema(db);
  const runner = runnerFor({ db, authority: { authorizeAdmin: () => true }, clock: () => { throw new Error('interrupt'); } });
  const destinationPath = join(dir, 'snapshot.sqlite');
  await assert.rejects(runner.backup({ destinationPath, approvalId: 'approval', sourceId: 'source' }), { code: 'BACKUP_FAILED' });
  assert.equal(existsSync(destinationPath), false);
  assert.equal(existsSync(`${destinationPath}.manifest.json`), false);
  assert.equal(readdirSync(dir).some(name => name.includes('.pending')), false);
});

test('WAL writer concurrent with online backup yields complete atomic message/attachment pairs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-backup-wal-'));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  const writer = new DatabaseSync(join(dir, 'source.sqlite'));
  t.after(() => { writer.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
  writer.exec('PRAGMA foreign_keys=ON');
  migrateImSchema(db);
  const context = {};
  const clock = () => 1000;
  const timeGuard = createImClockGuard({ db: writer, clock });
  const admin = createImAdmin({ db: writer, clock, timeGuard, authorizeAdmin: c => c === context });
  const auth = createImAuth({ db: writer, clock, timeGuard });
  const acl = createImAcl({ db: writer, clock, timeGuard, auth });
  const messages = createImMessages({ db: writer, clock, timeGuard, auth, acl, policy });
  const migration = createImMigration({ db: writer, clock, timeGuard, authorizeAdmin: c => c === context ? 'operator' : null });
  const [a, b] = ['A', 'B'].map(displayName => {
    const agentId = admin.registerAgent({ displayName }, context).agentId;
    return { agentId, principal: auth.authenticate(admin.issueCredential({ agentId, expiresAt: null }, context).credential) };
  });
  admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: true, reason: 'approved' }, context);
  migration.setImWriteMode({ mode: 'enabled', reason: 'test', policy }, context);
  const conversationId = messages.ensureConversation(a.principal, { peerAgentId: b.agentId }).conversationId;
  const bytes = Buffer.alloc(16 * 1024, 0x39);
  const send = () => messages.send(a.principal, { protocol: PROTOCOL, conversationId, recipientAgentId: b.agentId,
    clientMessageId: randomUUID(), text: 'atomic', attachment: { name: 'large.bin', sha256: hash(bytes), dataBase64: bytes.toString('base64') } });
  send();
  let running = true;
  let writes = 0;
  let writeError;
  const pump = () => {
    if (!running) return;
    try { send(); writes++; } catch (error) { writeError = error; running = false; return; }
    if (writes < 6) setImmediate(pump);
  };
  setImmediate(pump);
  const runner = runnerFor({ db, authority: { authorizeAdmin: () => true } });
  let result;
  try { result = await runner.backup({ destinationPath: join(dir, 'snapshot.sqlite'), approvalId: 'approval', sourceId: 'wal-source' }); }
  finally { running = false; }
  assert.equal(writeError, undefined);
  assert.ok(writes > 0, 'concurrent writer must actually execute');
  assert.equal(runner.verify(result).ok, true);
  const copy = new DatabaseSync(result.backupPath, { readOnly: true });
  try {
    const rows = copy.prepare('SELECT m.message_id, a.data, a.sha256 FROM im_messages m LEFT JOIN im_attachments a ON a.message_id=m.message_id').all();
    assert.ok(rows.length > 0);
    for (const row of rows) { assert.ok(row.data); assert.equal(hash(row.data), row.sha256); }
    assert.equal(copy.prepare('SELECT count(*) n FROM im_send_keys').get().n, rows.length);
    assert.equal(copy.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { copy.close(); }
});

test('continuous external WAL writer: budget fails closed without manifest publication', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-backup-busy-'));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  const writer = new DatabaseSync(join(dir, 'source.sqlite'));
  t.after(() => { writer.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
  migrateImSchema(db);
  writer.exec('CREATE TABLE load_probe(n INTEGER)');
  // A large snapshot gives the independent connection time to trigger native backup restarts.
  writer.prepare('INSERT INTO load_probe(n) VALUES(?)').run(0);
  writer.exec('CREATE TABLE large_probe(data BLOB)');
  const fill = writer.prepare('INSERT INTO large_probe(data) VALUES(?)');
  for (let i = 0; i < 8; i++) fill.run(Buffer.alloc(64 * 1024, i));
  let active = true;
  let writes = 0;
  const tick = () => {
    if (!active) return;
    writer.prepare('INSERT INTO load_probe(n) VALUES(?)').run(++writes);
    setImmediate(tick);
  };
  setImmediate(tick);
  const destinationPath = join(dir, 'busy.sqlite');
  const runner = runnerFor({ db, authority: { authorizeAdmin: () => true }, backupTimeBudgetMs: 80 });
  let result, error;
  try {
    result = await runner.backup({ destinationPath, approvalId: 'approval', sourceId: 'source' }).catch(caught => { error = caught; });
  } finally { active = false; }
  assert.ok(writes > 0);
  if (error) {
    assert.equal(error.code, 'BACKUP_BUSY');
    assert.equal(existsSync(destinationPath), false);
    assert.equal(existsSync(`${destinationPath}.manifest.json`), false);
  } else assert.equal(runner.verify(result).ok, true, 'writer may pause long enough for a valid snapshot');
  // Native backup has no cancellation. Once the external writer stops it can settle,
  // and its private pending file is then removed by the deferred cleanup handler.
  await runner.drain();
  assert.equal(readdirSync(dir).some(name => name.includes('.pending')), false);
});

test('real protected-file authority needs separate authenticated context, never metadata', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-backup-auth-'));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  migrateImSchema(db);
  const secretFile = join(dir, 'admin.secret');
  const options = { trustWindowsPermissions: process.platform === 'win32', report: () => {} };
  const adminSecret = createLocalKeystore({ directory: dir, ...options }).createAdminSecret(secretFile);
  const runner = runnerFor({ db, authority: createAdminAuthority({ secretFile, ...options }) });
  const input = { destinationPath: join(dir, 'backup.sqlite'), approvalId: adminSecret, sourceId: adminSecret };
  await assert.rejects(runner.backup(input), { code: 'BACKUP_AUTH_DENIED' });
  await assert.rejects(runner.backup({ ...input, adminContext: { adminSecret: '0'.repeat(64) } }), { code: 'BACKUP_AUTH_DENIED' });
  const result = await runner.backup({ ...input, approvalId: 'approved-change', sourceId: 'local-source', adminContext: { adminSecret } });
  assert.equal(runner.verify(result).ok, true);
  assert.equal(JSON.stringify(result.manifest).includes(adminSecret), false);
});

for (const outcome of ['resolve', 'reject']) {
  test(`timeout then late ${outcome}: per-source in-flight isolation, no late publish`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'im-backup-late-'));
    const db = new DatabaseSync(join(dir, 'source.sqlite'));
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    migrateImSchema(db);
    let settle;
    let starts = 0;
    const runner = runnerFor({ db, authority: { authorizeAdmin: () => true }, backupTimeBudgetMs: 10,
      nativeBackup: (_, pending) => { starts++; return new Promise((resolve, reject) => { settle = () => {
        if (outcome === 'resolve') { writeFileSync(pending, 'late output'); resolve(); }
        else reject(new Error('late failure'));
      }; }); } });
    const first = join(dir, 'first.sqlite');
    await assert.rejects(runner.backup({ destinationPath: first, approvalId: 'ok', sourceId: 'one' }), { code: 'BACKUP_BUSY' });
    assert.equal(runner.status().nativeInFlight, true);
    for (const destinationPath of [first, join(dir, 'second.sqlite')])
      await assert.rejects(runner.backup({ destinationPath, approvalId: 'ok', sourceId: 'one' }), { code: 'BACKUP_BUSY' });
    assert.equal(starts, 1);
    settle();
    await runner.drain();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runner.status().nativeInFlight, false);
    for (const name of ['first.sqlite', 'first.sqlite.manifest.json', 'second.sqlite', 'second.sqlite.manifest.json'])
      assert.equal(existsSync(join(dir, name)), false);
    assert.equal(readdirSync(dir).some(name => name.includes('.pending')), false);
  });
}

test('manifest publication fault, collision, and disk-full preserve other files and never prove success', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-backup-fault-'));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  migrateImSchema(db);
  for (const [stage, code, competing] of [
    ['before-manifest-link', 'EACCES', false], ['before-manifest-link', 'ENOSPC', false],
    ['before-manifest-link', 'EEXIST', true],
    ['manifest-link', 'EACCES', false],
  ]) {
    const destinationPath = join(dir, `${code}-${competing}.sqlite`);
    const manifestPath = `${destinationPath}.manifest.json`;
    const runner = runnerFor({ db, authority: { authorizeAdmin: () => true }, fault: at => {
      if (at === stage) { if (competing) writeFileSync(manifestPath, 'other owner');
        else throw Object.assign(new Error(code), { code }); }
    } });
    await assert.rejects(runner.backup({ destinationPath, approvalId: 'ok', sourceId: 'one' }), { code: 'BACKUP_FAILED' });
    assert.equal(existsSync(destinationPath), false);
    assert.equal(existsSync(manifestPath), competing);
    if (competing) assert.equal(readFileSync(manifestPath, 'utf8'), 'other owner');
  }
  const target = join(dir, 'raced-target.sqlite');
  const runner = runnerFor({ db, authority: { authorizeAdmin: () => true }, fault: at => {
    if (at === 'before-target-link') writeFileSync(target, 'other owner');
  } });
  await assert.rejects(runner.backup({ destinationPath: target, approvalId: 'ok', sourceId: 'one' }), { code: 'BACKUP_FAILED' });
  assert.equal(readFileSync(target, 'utf8'), 'other owner');
});

test('pending pair is not accepted as migration evidence; unsupported native path fails closed', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-backup-pending-'));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  migrateImSchema(db);
  const runner = runnerFor({ db, authority: { authorizeAdmin: () => true }, nativeBackup: null });
  await assert.rejects(runner.backup({ destinationPath: join(dir, 'snapshot.sqlite'), approvalId: 'ok', sourceId: 'one' }), { code: 'BACKUP_UNSUPPORTED' });
  assert.equal(runner.verify({ backupPath: join(dir, 'snapshot.pending'), manifestPath: join(dir, 'snapshot.pending.manifest.pending') }).ok, false);
});

test('strict durability refuses unavailable directory fsync without publishing success', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-backup-durable-'));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  migrateImSchema(db);
  const destinationPath = join(dir, 'snapshot.sqlite');
  const runner = createImBackup({ db, authority: { authorizeAdmin: () => true }, fault: stage => {
    if (stage === 'directory-sync') throw Object.assign(new Error('unsupported'), { code: 'EPERM' });
  } });
  await assert.rejects(runner.backup({ destinationPath, approvalId: 'ok', sourceId: 'one' }), { code: 'BACKUP_DURABILITY_UNAVAILABLE' });
  assert.equal(existsSync(destinationPath), false);
  assert.equal(existsSync(`${destinationPath}.manifest.json`), false);
});

test('large database successful backup benchmark (8 MiB)', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-backup-large-'));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  migrateImSchema(db);
  db.exec('CREATE TABLE benchmark_blob(data BLOB)');
  const insert = db.prepare('INSERT INTO benchmark_blob(data) VALUES(?)');
  for (let i = 0; i < 8; i++) insert.run(Buffer.alloc(1024 * 1024, i));
  const runner = runnerFor({ db, authority: { authorizeAdmin: () => true } });
  const start = performance.now();
  const result = await runner.backup({ destinationPath: join(dir, 'large.sqlite'), approvalId: 'ok', sourceId: 'one' });
  const elapsed = performance.now() - start;
  assert.equal(runner.verify(result).ok, true);
  assert.ok(elapsed < 30000, `8 MiB backup took ${elapsed.toFixed(0)} ms`);
  t.diagnostic(`8 MiB backup+verification: ${elapsed.toFixed(1)} ms; rate=256 pages/step`);
});
