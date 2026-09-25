import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sqlite, { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { createImV2Backup } from '../src/im/v2/backup.js';
import { assertImSchemaV4 } from '../src/im/v2/schema.js';
import { initializeImSchemaV4 } from '../src/im/v2/migration.js';
import { freshOptions } from './fixtures/im-v2-schema/helpers.js';
import { IM_SCHEMA_VERSION, SUPPORTED_IM_SCHEMA_VERSIONS } from '../src/im/schema.js';
import { canonical, decode, sha } from '../src/im/v2/recovery-records.js';
import { fixture, unsupported, authority, context } from './fixtures/im-v2-backup/helpers.js';
import { isolated } from './fixtures/im-v2-backup/isolated.js';
import { validationLimits } from '../src/im/v2/backup.js';

test('Windows strict protection is unsupported; no platform override', { skip: !unsupported }, t => {
  const f = fixture(t);
  assert.throws(() => createImV2Backup({ ...f.options, platform: {} }), { code: 'RECOVERY_UNSUPPORTED' });
});

test('native populated v4 SQLite snapshot includes keys, real ACK, lease and attachment; old versions stay frozen', { skip: unsupported }, async t => {
  const f = fixture(t), backup = createImV2Backup(f.options);
  const result = await backup.publish({ approvalRef: 'test-approved' }, context); await backup.drain();
  assert.equal(result.manifest.sourceId, f.instanceId);
  assert.equal(result.manifest.sourceCreatedAt, 10);
  assert.equal(result.manifest.formatVersion, 2); assert.equal(result.manifest.schemaVersion, 4);
  const id = result.manifest.backupId, path = join(f.registryRoot, 'registry/artifacts', `${id}.sqlite`);
  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    copy.exec('PRAGMA foreign_keys=ON'); assert.equal(assertImSchemaV4(copy), true);
    for (const [table, count] of [['im_messages', 2], ['im_send_operation_keys', 2], ['im_receiver_leases', 1], ['im_attachments', 1]])
      assert.equal(copy.prepare(`SELECT count(*) n FROM ${table}`).get().n, count);
    assert.equal(copy.prepare('SELECT count(*) n FROM im_deliveries WHERE acked_at IS NOT NULL').get().n, 1);
    assert.equal(copy.prepare('SELECT count(*) n FROM im_deliveries WHERE read_at IS NOT NULL').get().n, 1);
  } finally { copy.close(); }
  assert.deepEqual(backup.verify({ backupId: id }), result);
  assert.equal(lstatSync(path).mode & 0o777, 0o600); assert.equal(lstatSync(path).nlink, 1);
  assert.equal(lstatSync(path).uid, process.geteuid());
  const bytes = readFileSync(join(f.registryRoot, 'registry/artifacts', `${id}.manifest.json`));
  assert.ok(canonical('manifest', result.manifest).equals(bytes)); assert.equal(sha(bytes), result.manifestHash);
  assert.equal(IM_SCHEMA_VERSION, 3); assert.deepEqual(SUPPORTED_IM_SCHEMA_VERSIONS, [1, 2, 3]);
  assert.equal(backup.status().nativeInFlight, false);
});

test('WAL source is snapshotted through native backup with committed WAL facts', { skip: unsupported }, async t => {
  const f = fixture(t), live = join(f.root, 'live.sqlite');
  await sqliteBackup(f.db, live); chmodSync(live, 0o600);
  const source = new DatabaseSync(live);
  t.after(() => source.close());
  source.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  source.prepare('UPDATE im_agents SET display_name=? WHERE agent_id=?').run('WAL committed', f.a);
  assert.ok(lstatSync(`${live}-wal`).size > 0);
  const backup = createImV2Backup({ ...f.options, db: source });
  const { manifest } = await backup.publish({ approvalRef: 'test-approved' }, context); await backup.drain();
  const copy = new DatabaseSync(join(f.registryRoot, 'registry/artifacts', `${manifest.backupId}.sqlite`), { readOnly: true });
  try { assert.equal(copy.prepare('SELECT display_name FROM im_agents WHERE agent_id=?').get(f.a).display_name, 'WAL committed'); }
  finally { copy.close(); }
});

test('valid fresh prepared bootstrap can be backed up without activation or fake source identity', { skip: unsupported }, async t => {
  const f = fixture(t), db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  const preparation = initializeImSchemaV4(db, freshOptions());
  const backup = createImV2Backup({ ...f.options, db });
  const { manifest } = await backup.publish({ approvalRef: 'test-approved' }, context); await backup.drain();
  assert.equal(manifest.sourceId, preparation.instanceId);
  assert.equal(manifest.sourceCreatedAt, preparation.instanceCreatedAt);
  assert.equal(db.prepare('SELECT status FROM im_center_state').get().status, 'prepared');
  assert.equal(db.prepare('SELECT write_mode FROM im_settings').get().write_mode, 'paused');
  assert.equal(db.prepare('SELECT count(*) n FROM im_recovery_runs').get().n, 0);
});

test('literal authorization, approval and strict input reject caller identity and promise authorization', { skip: unsupported }, async t => {
  const f = fixture(t), backup = createImV2Backup(f.options);
  await assert.rejects(backup.publish({ approvalRef: 'test-approved', sourceId: randomUUID() }, context));
  await assert.rejects(backup.publish({ approvalRef: 'test-approved' }, {}), { code: 'RECOVERY_AUTH_DENIED' });
  await assert.rejects(backup.publish({ approvalRef: 'wrong' }, context), { code: 'RECOVERY_APPROVAL_DENIED' });
  for (const value of [Promise.resolve(true), 1, 'true']) {
    const b = createImV2Backup({ ...f.options, authority: { ...authority, authorizeAdmin: () => value } });
    await assert.rejects(b.publish({ approvalRef: 'test-approved' }, context), { code: 'RECOVERY_AUTH_DENIED' });
  }
  assert.deepEqual(readdirSync(join(f.registryRoot, 'registry/artifacts')), []);
});

test('lower P1 full-data budget rejects before publication', { skip: unsupported }, async t => {
  const f = fixture(t), backup = createImV2Backup({ ...f.options, limits: { maxMessages: 1 } });
  await assert.rejects(backup.publish({ approvalRef: 'test-approved' }, context), { code: 'RECOVERY_BUSY' }); await backup.drain();
  assert.equal(readdirSync(join(f.registryRoot, 'registry/artifacts')).some(x => x.endsWith('.json')), false);
});

test('hash, actual identity, schema, FK and payload corruption fail even after manifest fileHash is recomputed', { skip: unsupported }, async t => {
  const mutations = [
    ['payload', db => db.exec("UPDATE im_messages SET text='corrupt'")],
    ['schema', db => db.exec('DROP INDEX im_content_expiry')],
    ['FK', db => { db.exec('PRAGMA foreign_keys=OFF'); db.prepare('UPDATE im_center_state SET center_epoch=?').run(randomUUID()); }],
    ['identity', db => db.prepare('UPDATE im_instance_identity SET instance_id=?').run(randomUUID())],
  ];
  for (const [label, mutate] of mutations) await t.test(label, async t => {
    const f = fixture(t), backup = createImV2Backup(f.options);
    const { manifest } = await backup.publish({ approvalRef: 'test-approved' }, context); await backup.drain();
    const path = join(f.registryRoot, 'registry/artifacts', `${manifest.backupId}.sqlite`);
    const db = new DatabaseSync(path); try { mutate(db); } finally { db.close(); }
    assert.throws(() => backup.verify({ backupId: manifest.backupId }));
    manifest.fileHash = sha(readFileSync(path));
    writeFileSync(join(f.registryRoot, 'registry/artifacts', `${manifest.backupId}.manifest.json`), canonical('manifest', manifest));
    assert.throws(() => backup.verify({ backupId: manifest.backupId }), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  });
});

test('canonical parsing rejects whitespace, BOM, duplicate keys, wrong order and unknown fields', () => {
  const hold = { version: 1, holdId: randomUUID(), backupId: randomUUID(), recoveryRunId: randomUUID(), stageHash: 'a'.repeat(64), createdAt: 1 };
  const bytes = canonical('hold', hold);
  assert.deepEqual(decode('hold', bytes), hold);
  for (const raw of [bytes + '\n', '\ufeff' + bytes, JSON.stringify(hold, null, 2),
    bytes.toString().replace('"version":1', '"version":1,"version":1'), JSON.stringify({ ...hold, extra: 1 }),
    JSON.stringify(Object.fromEntries(Object.entries(hold).reverse()))])
    assert.throws(() => decode('hold', Buffer.from(raw)), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
});

test('native timeout cannot publish and drain owns source lifetime until actual operation settles', { skip: unsupported, timeout: 5000 }, async t => {
  const f = fixture(t), original = sqlite.backup;
  let release, invoked;
  const reached = new Promise(resolve => { invoked = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  // Test-only native wrapper still performs the genuine SQLite backup. A delayed
  // completion models an uncancellable operation without a production override.
  sqlite.backup = async (...args) => { invoked(); await barrier; return original(...args); };
  syncBuiltinESMExports();
  const backup = createImV2Backup({ ...f.options, backupTimeBudgetMs: 10 });
  try {
    const result = backup.publish({ approvalRef: 'test-approved' }, context);
    const rejected = assert.rejects(result, { code: 'RECOVERY_BUSY' });
    await reached; await rejected;
    assert.equal(backup.status().nativeInFlight, true);
    let drained = false; const drain = backup.drain().then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false);
    await assert.rejects(backup.publish({ approvalRef: 'test-approved' }, context), { code: 'RECOVERY_BUSY' });
    release(); await drain;
    assert.equal(backup.status().nativeInFlight, false);
    const files = readdirSync(join(f.registryRoot, 'registry/artifacts'));
    assert.ok(files.length > 0 && files.every(name => name.endsWith('.pending')));
  } finally { release(); await backup.drain(); sqlite.backup = original; syncBuiltinESMExports(); }
});

test('P5 trusted limits are lower-only and preserve the P1 defaults', () => {
  const defaults = validationLimits();
  assert.deepEqual(defaults, { maxMessages: 10000, maxVerifiedContentBytes: 104857600,
    maxOtherRecords: 10000, maxElapsedMs: 10000, maxFileBytes: 128 * 1024 * 1024, maxMetadataEntries: 10000 });
  assert.ok(Object.isFrozen(defaults));
  for (const key of Object.keys(defaults)) {
    assert.equal(validationLimits({ [key]: 1 })[key], 1);
    assert.equal(validationLimits({ [key]: defaults[key] })[key], defaults[key]);
    for (const value of [0, -1, 1.5, defaults[key] + 1, '1', null, Infinity])
      assert.throws(() => validationLimits({ [key]: value }), undefined, `${key}=${value}`);
  }
});

for (const mode of ['file-cap', 'hash-time', 'final-hash-time', 'copy-time'])
  test(`P5 budget: ${mode}, real native reads and unchanged source`, { skip: unsupported, timeout: 20000 }, async () => {
    await isolated(mode);
  });

test('P1 content and other-record budgets still refuse publication', { skip: unsupported }, async t => {
  for (const limits of [{ maxVerifiedContentBytes: 1 }, { maxOtherRecords: 1 }, { maxFileBytes: 1 }]) {
    const f = fixture(t), backup = createImV2Backup({ ...f.options, limits });
    await assert.rejects(backup.publish({ approvalRef: 'test-approved' }, context), { code: 'RECOVERY_BUSY' });
    await backup.drain();
    assert.equal(readdirSync(join(f.registryRoot, 'registry/artifacts')).some(name => name.endsWith('.json')), false);
  }
});
