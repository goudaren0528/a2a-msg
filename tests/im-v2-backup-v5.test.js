import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sqlite, { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createImV2Backup, inspectV4, verifyV4, validationLimits } from '../src/im/v2/backup.js';
import { createTrustedImV2BackupServices } from '../src/im/v2/backup-registry.js';
import { assertImSchemaV5 } from '../src/im/v2/schema-v5.js';
import { fixture, liveSource, context, actors, authority, unsupported, unsupportedError, busy, mismatch,
  assertChain, snapshot, fileState, paths, rehashChain, GOLDEN } from './fixtures/im-v2-backup-v5/helpers.js';

test('B2 portable: exact six lower-only limits and Windows strict UNSUPPORTED', t => {
  const defaults = { maxMessages: 10000, maxVerifiedContentBytes: 104857600, maxOtherRecords: 10000,
    maxElapsedMs: 10000, maxFileBytes: 134217728, maxMetadataEntries: 10000 };
  assert.deepEqual(validationLimits(), defaults); assert.ok(Object.isFrozen(validationLimits()));
  for (const [key, ceiling] of Object.entries(defaults)) {
    assert.equal(validationLimits({ [key]: 1 })[key], 1);
    for (const value of [0, -1, 1.5, ceiling + 1, Infinity, '1', null]) assert.throws(() => validationLimits({ [key]: value }));
  }
  assert.throws(() => validationLimits({ schemaVersion: 5 }));
  if (unsupported) {
    const f = fixture(t);
    assert.throws(() => createImV2Backup(f.options), unsupportedError);
    assert.throws(() => createTrustedImV2BackupServices(f.options), unsupportedError);
  }
});

for (const mode of ['paused', 'enabled']) test(`B2 native5 ACTIVE/${mode}: actual snapshot -> register -> independent canonical proof`, { skip: unsupported }, async t => {
  const f = fixture(t, { mode }), live = await liveSource(t, f), expected = snapshot(live.db), sourceBefore = fileState(live.path);
  const services = createTrustedImV2BackupServices({ ...f.options, db: live.db });
  const result = await services.publisher.publish({ approvalRef: 'b2-approved' }, context);
  assert.equal(await services.publisher.drain(), undefined);
  const chain = assertChain(f, result, expected);
  assert.notEqual(fs.statSync(chain.paths.artifact).ino, fs.statSync(live.path).ino);
  assert.deepEqual(fileState(live.path), sourceBefore); assert.deepEqual(snapshot(live.db), expected);
  assert.deepEqual(services.publisher.status(), { nativeInFlight: false });
  assert.equal(Object.hasOwn(services.publisher, 'registerArtifact'), false);
  assert.deepEqual(Object.keys(services.publisher).sort(), ['drain', 'importRegisteredV3', 'publish', 'status']);
  assert.throws(() => inspectV4(chain.paths.artifact), mismatch);
  assert.throws(() => verifyV4(chain.paths.artifact, fs.readFileSync(chain.paths.manifest)), mismatch);
});

test('B2 native5 WAL source keeps exact main/WAL bytes, live mode, business facts and nonempty anchor head', { skip: unsupported }, async t => {
  const f = fixture(t, { mode: 'enabled' }), live = await liveSource(t, f, { wal: true });
  const before = [fileState(live.path), fileState(`${live.path}-wal`)], expected = snapshot(live.db);
  const services = createTrustedImV2BackupServices({ ...f.options, db: live.db });
  const result = await services.publisher.publish({ approvalRef: 'b2-approved' }, context); await services.publisher.drain();
  const chain = assertChain(f, result, expected);
  assert.deepEqual([fileState(live.path), fileState(`${live.path}-wal`)], before);
  assert.deepEqual(snapshot(live.db), expected);
  assert.equal(live.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.notEqual(fs.statSync(chain.paths.artifact).ino, fs.statSync(live.path).ino);
  for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(fs.existsSync(chain.paths.artifact + suffix), false);
});

test('B2 completed independent snapshot survives later live marker and identity drift', { skip: unsupported }, async t => {
  const f = fixture(t), before = snapshot(f.db), original = sqlite.backup;
  let completed = false;
  sqlite.backup = async (...args) => {
    const result = await original(...args); completed = true;
    // Corrupt only the source AFTER genuine native completion. Independent
    // destination remains legal 5; querying live identity now is wrong.
    f.db.prepare('UPDATE im_instance_identity SET instance_id=?').run(randomUUID());
    f.db.exec('PRAGMA ignore_check_constraints=ON');
    f.db.prepare('UPDATE im_schema SET version=4,migration_checksum=?').run('c950eb40692a72f918c8976d4bef8cab0b9e357495b01df75e0ab2d1b0b5f216');
    f.db.exec('PRAGMA ignore_check_constraints=OFF');
    return result;
  };
  syncBuiltinESMExports();
  const services = createTrustedImV2BackupServices(f.options);
  try {
    const result = await services.publisher.publish({ approvalRef: 'b2-approved' }, context); await services.publisher.drain();
    assert.equal(completed, true); assert.equal(result.record.instanceId, f.identity.instance_id);
    assert.equal(result.record.schemaVersion, 5); assert.equal(result.record.schemaChecksum, GOLDEN.checksum);
    const db = new DatabaseSync(paths(f.registryRoot, result.record.backupId).artifact, { readOnly: true });
    try { assertImSchemaV5(db); assert.deepEqual(snapshot(db), before); } finally { db.close(); }
  } finally { await services.publisher.drain(); sqlite.backup = original; syncBuiltinESMExports(); }
});

test('B2 approval mutation is attempted but original captured ref and actor pair bind manifest and reauthorization', { skip: unsupported }, async t => {
  const f = fixture(t), input = { approvalRef: 'b2-approved' }, seen = []; let actorCalls = 0, attempts = 0;
  const services = createTrustedImV2BackupServices({ ...f.options,
    authority: { ...authority, publicationActors: () => { actorCalls++; return actorCalls === 1 ? { ...actors } : { executorActorId: 'changed-executor', approverActorId: 'changed-approver' }; } },
    approvalAuthority: { authorizeBackup(value, ctx) {
      seen.push({ ...value }); attempts++; input.approvalRef = 'b2-mutated-caller';
      try { value.approvalRef = 'b2-mutated-adapter'; } catch { /* immutable DTO is also lawful */ }
      return ctx === context;
    } },
  });
  const result = await services.publisher.publish(input, context); await services.publisher.drain();
  assert.ok(attempts >= 2, 'approval checked again after async native work');
  assert.equal(actorCalls, 1, 'actor pair captured once');
  assert.ok(seen.every(value => value.approvalRef === 'b2-approved' && value.executorActorId === actors.executorActorId && value.approverActorId === actors.approverActorId));
  assertChain(f, result);
});

test('B2 revocation after actual native completion prevents metadata publication and preserves owned pending', { skip: unsupported }, async t => {
  const f = fixture(t), original = sqlite.backup; let allowed = true, completed = false;
  sqlite.backup = async (...args) => { const result = await original(...args); completed = true; allowed = false; return result; };
  syncBuiltinESMExports();
  const services = createTrustedImV2BackupServices({ ...f.options, authority: { ...authority, authorizeAdmin: ctx => ctx === context && allowed } });
  try {
    await assert.rejects(services.publisher.publish({ approvalRef: 'b2-approved' }, context), { code: 'RECOVERY_AUTH_DENIED' });
    await services.publisher.drain(); assert.equal(completed, true);
    const files = fs.readdirSync(join(f.registryRoot, 'registry/artifacts'));
    assert.ok(files.length > 0 && files.every(name => name.endsWith('.pending')));
    assert.deepEqual(fs.readdirSync(join(f.registryRoot, 'registry/records')), []);
  } finally { await services.publisher.drain(); sqlite.backup = original; syncBuiltinESMExports(); }
});

test('B2 timeout retains native ownership; source stays open until actual completion and drain<void>', { skip: unsupported, timeout: 15000 }, async t => {
  const f = fixture(t), original = sqlite.backup; let release, reached;
  const barrier = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { reached = resolve; });
  let completed = false;
  sqlite.backup = async (...args) => { reached(); await barrier; const result = await original(...args); completed = true; return result; };
  syncBuiltinESMExports();
  const services = createTrustedImV2BackupServices({ ...f.options, backupTimeBudgetMs: 10 });
  try {
    const rejected = assert.rejects(services.publisher.publish({ approvalRef: 'b2-approved' }, context), busy);
    await entered; await rejected; assert.deepEqual(services.publisher.status(), { nativeInFlight: true });
    let drained = false; const drain = services.publisher.drain().then(value => { assert.equal(value, undefined); drained = true; });
    await Promise.resolve(); assert.equal(drained, false); assertImSchemaV5(f.db);
    release(); await drain; assert.equal(completed, true); assert.deepEqual(services.publisher.status(), { nativeInFlight: false });
    assert.ok(fs.readdirSync(join(f.registryRoot, 'registry/artifacts')).every(name => name.endsWith('.pending')));
    assert.deepEqual(fs.readdirSync(join(f.registryRoot, 'registry/records')), []);
  } finally { release(); await services.publisher.drain(); sqlite.backup = original; syncBuiltinESMExports(); }
});

const mutations = [
  ['content', db => { db.exec("UPDATE im_messages SET text='B2 changed actual content'"); assert.equal(db.prepare('SELECT text FROM im_messages').get().text, 'B2 changed actual content'); }],
  ['schema', db => { db.exec('DROP INDEX im_content_expiry'); assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='im_content_expiry'").get().n, 0); }],
  ['identity', db => { const id = randomUUID(); db.prepare('UPDATE im_instance_identity SET instance_id=?').run(id); assert.equal(db.prepare('SELECT instance_id FROM im_instance_identity').get().instance_id, id); }],
  ['FK', db => { db.exec('PRAGMA foreign_keys=OFF'); db.prepare('UPDATE im_center_state SET center_epoch=?').run(randomUUID()); assert.ok(db.prepare('PRAGMA foreign_key_check').all().length > 0); }],
  ['anchor-chain', db => { db.exec("UPDATE im_maintenance_time_anchors SET previous_anchor_hash='" + 'f'.repeat(64) + "' WHERE generation=2"); assert.equal(db.prepare('SELECT previous_anchor_hash FROM im_maintenance_time_anchors WHERE generation=2').get().previous_anchor_hash, 'f'.repeat(64)); }],
  ['head-not-tip', db => { db.exec('UPDATE im_maintenance_time_head SET generation=1,anchor_hash=(SELECT anchor_hash FROM im_maintenance_time_anchors WHERE generation=1)'); assert.equal(db.prepare('SELECT generation FROM im_maintenance_time_head').get().generation, 1); }],
  ['transition', db => { db.exec("UPDATE im_center_schema_transitions SET approved_plan_hash='" + 'e'.repeat(64) + "'"); assert.equal(db.prepare('SELECT approved_plan_hash FROM im_center_schema_transitions').get().approved_plan_hash, 'e'.repeat(64)); }],
];
for (const [label, mutate] of mutations) test(`B2 ${label} actual artifact mutation refuses with all outer hashes independently recomputed`, { skip: unsupported }, async t => {
  const f = fixture(t), services = createTrustedImV2BackupServices(f.options);
  const result = await services.publisher.publish({ approvalRef: 'b2-approved' }, context); await services.publisher.drain();
  const chain = assertChain(f, result); const before = fs.readFileSync(chain.paths.artifact);
  const db = new DatabaseSync(chain.paths.artifact);
  try { mutate(db); } finally { db.close(); }
  assert.notDeepEqual(fs.readFileSync(chain.paths.artifact), before, 'mutation reached native storage, not an earlier CHECK failure');
  rehashChain(f.registryRoot, result.record.backupId);
  assert.throws(() => services.registry.verify({ backupId: result.record.backupId }, context), mismatch);
});

for (const limits of [{ maxVerifiedContentBytes: 1 }, { maxOtherRecords: 1 }, { maxFileBytes: 1 }]) {
  test(`B2 genuine native5 lower ${Object.keys(limits)[0]} remains RECOVERY_BUSY`, { skip: unsupported }, async t => {
    const f = fixture(t), services = createTrustedImV2BackupServices({ ...f.options, limits });
    await assert.rejects(services.publisher.publish({ approvalRef: 'b2-approved' }, context), busy); await services.publisher.drain();
    assert.deepEqual(fs.readdirSync(join(f.registryRoot, 'registry/records')), []);
  });
}
