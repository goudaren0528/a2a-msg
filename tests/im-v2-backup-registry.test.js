import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { chmodSync, copyFileSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { createBackupRegistry, createTrustedBackupServices, withProtectedBackupCopy } from '../src/im/backup-registry.js';
import { createImV2BackupRegistry, createTrustedImV2BackupServices } from '../src/im/v2/backup-registry.js';
import { createImV2Backup } from '../src/im/v2/backup.js';
import { canonical, publishBytes, sha } from '../src/im/v2/recovery-records.js';
import { fixture, unsupported, authority, context } from './fixtures/im-v2-backup/helpers.js';
import { isolated } from './fixtures/im-v2-backup/isolated.js';
import { legacyPublished } from './fixtures/im-v2-backup/legacy-published.js';

test('native registry keeps private writer private and binds canonical hashes to actual source', { skip: unsupported }, async t => {
  const f = fixture(t), services = createTrustedImV2BackupServices(f.options);
  const { record, sourceEvidence } = await services.publisher.publish({ approvalRef: 'test-approved' }, context); await services.publisher.drain();
  assert.deepEqual(Object.keys(services).sort(), ['publisher', 'registry']);
  assert.deepEqual(Object.keys(services.registry).sort(), ['bindPrepareHold', 'checkCleanup', 'createStageHold', 'getHold', 'verify', 'withVerifiedBackup']);
  assert.ok(Object.isFrozen(services.registry)); assert.equal(services.writer, undefined);
  assert.equal(record.recordVersion, 3); assert.equal(record.publicationKind, 'native-v4');
  assert.equal(record.instanceId, f.instanceId); assert.equal(sourceEvidence.importedRecordHash, null);
  const bytes = readFileSync(join(f.registryRoot, 'registry/records', `${record.backupId}.source.json`));
  assert.equal(record.sourceEvidenceHash, sha(bytes)); assert.ok(bytes.equals(canonical('source', sourceEvidence)));
  const other = createImV2BackupRegistry(f.options);
  assert.deepEqual(other.verify({ backupId: record.backupId }, context), { record, sourceEvidence });
  let escaped;
  const chunks = [];
  other.withVerifiedBackup({ backupId: record.backupId }, context, proof => {
    escaped = proof.copyTo; proof.copyTo(chunk => chunks.push(chunk));
    assert.throws(() => services.registry.verify({ backupId: record.backupId }, context), { code: 'RECOVERY_BUSY' });
    assert.throws(() => createImV2BackupRegistry(f.options).verify({ backupId: record.backupId }, context), { code: 'RECOVERY_BUSY' });
  });
  assert.equal(sha(Buffer.concat(chunks)), record.fileHash);
  assert.throws(() => escaped(() => {}), { code: 'RECOVERY_INVALID' });
  assert.deepEqual(other.checkCleanup({ backupId: record.backupId }, context), { allowed: false, reason: 'DISABLED' });
});

test('content verification cannot register provenance; manifest replacement and hold orphan fail closed', { skip: unsupported }, async t => {
  const f = fixture(t), primitive = createImV2Backup(f.options);
  const content = await primitive.publish({ approvalRef: 'test-approved' }, context); await primitive.drain();
  const registry = createImV2BackupRegistry(f.options);
  assert.throws(() => registry.verify({ backupId: content.manifest.backupId }, context));
  const { publisher } = createTrustedImV2BackupServices(f.options);
  const { record } = await publisher.publish({ approvalRef: 'test-approved' }, context); await publisher.drain();
  const manifest = join(f.registryRoot, 'registry/artifacts', `${record.backupId}.manifest.json`);
  const original = readFileSync(manifest), value = JSON.parse(original);
  value.approval.approvalRef = 'changed'; writeFileSync(manifest, canonical('manifest', value));
  assert.throws(() => registry.verify({ backupId: record.backupId }, context));
  writeFileSync(manifest, original);
  const holdId = randomUUID();
  writeFileSync(join(f.registryRoot, 'registry/holds', `${holdId}.binding.json`), canonical('binding', {
    version: 1, holdId, stageHash: 'a'.repeat(64), preparePlanHash: 'b'.repeat(64), boundAt: Date.now(),
  }), { mode: 0o600 });
  assert.throws(() => registry.checkCleanup({ backupId: record.backupId }, context));
});

test('registered v3 bridge authenticates old facade, holds source lock through verified independent copy and survives old cleanup', { skip: unsupported }, async t => {
  const f = fixture(t, { v3: true });
  const oldRoot = join(f.root, 'old'); mkdirSync(oldRoot, { mode: 0o700 }); mkdirSync(join(oldRoot, 'artifacts'), { mode: 0o700 });
  // Old publisher requires an actual file-backed source, not the in-memory builder.
  const path = join(f.root, 'old-source.sqlite'); await sqliteBackup(f.db, path); chmodSync(path, 0o600);
  const db = new DatabaseSync(path); t.after(() => db.close()); db.exec('PRAGMA foreign_keys=ON');
  const oldAuthority = { ...authority, publicationActors: () => ({ executorActorId: 'test-executor', backupApproverId: 'test-approver' }) };
  const old = createTrustedBackupServices({ db, dir: oldRoot, authority: oldAuthority });
  const output = await old.publisher.publish({ approvalId: 'test-approved', adminContext: context });
  const newServices = createTrustedImV2BackupServices(f.options);
  let stale;
  withProtectedBackupCopy(old.registry, { backupId: output.backupId, adminContext: context }, proof => {
    stale = proof.copyTo;
    const competitor = createBackupRegistry({ dir: oldRoot, authority: oldAuthority });
    assert.throws(() => competitor.revokeBackup({ backupId: output.backupId, adminContext: context }), { code: 'REGISTRY_BUSY' });
    proof.copyTo(() => {
      assert.throws(() => competitor.cleanupBackup({ backupId: output.backupId, adminContext: context }), { code: 'REGISTRY_BUSY' });
    });
  });
  assert.throws(() => stale(() => {}), { code: 'REGISTRY_USE_EXPIRED' });
  assert.throws(() => newServices.publisher.importRegisteredV3({ sourceRegistry: { ...old.registry }, backupId: output.backupId }, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  const result = newServices.publisher.importRegisteredV3({ sourceRegistry: old.registry, backupId: output.backupId }, context);
  assert.equal(result.record.publicationKind, 'imported-registered-v3');
  assert.equal(result.sourceEvidence.importedRecordHash, sha(readFileSync(join(oldRoot, `backup-${output.backupId}.json`))));
  assert.equal(result.record.fileHash, output.manifest.fileHash);
  assert.notEqual(lstatSync(join(oldRoot, output.artifactReference)).ino,
    lstatSync(join(f.registryRoot, result.record.artifactReference)).ino);
  old.registry.revokeBackup({ backupId: output.backupId, adminContext: context });
  old.registry.cleanupBackup({ backupId: output.backupId, adminContext: context });
  assert.deepEqual(createImV2BackupRegistry(f.options).verify({ backupId: output.backupId }, context), result);
  assert.throws(() => newServices.publisher.importRegisteredV3({ sourceRegistry: old.registry, backupId: randomUUID() }, context));
});

test('unbound/bound durable holds block across facades; binding no-replace, malformed/orphan/release evidence fails closed', { skip: unsupported }, async t => {
  const f = fixture(t), { publisher, registry } = createTrustedImV2BackupServices(f.options);
  const { record } = await publisher.publish({ approvalRef: 'test-approved' }, context); await publisher.drain();
  const hold = registry.createStageHold({ backupId: record.backupId, recoveryRunId: randomUUID(), stageHash: 'a'.repeat(64) }, context);
  const other = createImV2BackupRegistry(f.options);
  assert.equal(other.checkCleanup({ backupId: record.backupId }, context).reason, 'HOLD');
  const binding = other.bindPrepareHold({ holdId: hold.holdId, preparePlanHash: 'b'.repeat(64) }, context);
  assert.deepEqual(registry.bindPrepareHold({ holdId: hold.holdId, preparePlanHash: 'b'.repeat(64) }, context), binding);
  assert.throws(() => registry.bindPrepareHold({ holdId: hold.holdId, preparePlanHash: 'c'.repeat(64) }, context));
  assert.equal(other.checkCleanup({ backupId: record.backupId }, context).reason, 'HOLD');
  assert.deepEqual(other.getHold({ holdId: hold.holdId }, context), { hold, binding, release: null });
  const releasePath = join(f.registryRoot, 'registry/releases', `${hold.holdId}.json`);
  writeFileSync(releasePath, canonical('release', { version: 1, holdId: hold.holdId, recoveryRunId: hold.recoveryRunId,
    terminalState: 'active', stateEvidenceHash: 'd'.repeat(64), approvalRef: 'unverified', releasedAt: binding.boundAt }), { mode: 0o600 });
  assert.deepEqual(other.checkCleanup({ backupId: record.backupId }, context), { allowed: false, reason: 'HOLD' });
  unlinkSync(releasePath);
  const holdPath = join(f.registryRoot, 'registry/holds', `${hold.holdId}.json`);
  writeFileSync(holdPath, readFileSync(holdPath).toString() + '\n');
  assert.throws(() => other.checkCleanup({ backupId: record.backupId }, context));
});

test('protected paths reject modes, hard links, symlinks, unsafe ancestors and malformed pending names', { skip: unsupported }, async t => {
  const f = fixture(t), { publisher, registry } = createTrustedImV2BackupServices(f.options);
  const { record } = await publisher.publish({ approvalRef: 'test-approved' }, context); await publisher.drain();
  const path = join(f.registryRoot, record.artifactReference), extra = join(f.root, 'extra');
  chmodSync(path, 0o644); assert.throws(() => registry.verify({ backupId: record.backupId }, context)); chmodSync(path, 0o600);
  linkSync(path, extra); assert.throws(() => registry.verify({ backupId: record.backupId }, context)); unlinkSync(extra);
  symlinkSync(f.registryRoot, extra); assert.throws(() => createImV2BackupRegistry({ ...f.options, root: extra })); unlinkSync(extra);
  chmodSync(f.registryRoot, 0o777); assert.throws(() => registry.verify({ backupId: record.backupId }, context)); chmodSync(f.registryRoot, 0o700);
  writeFileSync(join(f.registryRoot, 'registry/holds', '.unexpected.pending'), '{}', { mode: 0o600 });
  assert.throws(() => registry.checkCleanup({ backupId: record.backupId }, context));
});

test('no-replace metadata and file/directory fsync failures retain evidence and refuse success', { skip: unsupported }, t => {
  const f = fixture(t), path = join(f.registryRoot, 'proof.json');
  publishBytes(path, Buffer.from('{"v":1}'));
  assert.throws(() => publishBytes(path, Buffer.from('{"v":2}')), { code: 'RECOVERY_DURABILITY_UNCERTAIN' });
  assert.equal(readFileSync(path, 'utf8'), '{"v":1}');
  for (const directory of [false, true]) {
    const target = join(f.registryRoot, `failure-${directory}.json`), original = fs.fsyncSync;
    fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory() === directory) throw Error('test injected fsync'); return original(fd); };
    syncBuiltinESMExports();
    try { assert.throws(() => publishBytes(target, Buffer.from('{}')), { code: 'RECOVERY_DURABILITY_UNCERTAIN' }); }
    finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
    assert.ok(readdirSync(f.registryRoot).some(name => name.endsWith('.pending')));
    if (directory) assert.equal(readFileSync(target, 'utf8'), '{}');
  }
});

test('two-process IPC barrier: old revoke/cleanup and new registry remain BUSY during independent copy after same-process facade probes', { skip: unsupported, timeout: 15000 }, async t => {
  const f = fixture(t, { v3: true });
  const oldRoot = join(f.root, 'old'); mkdirSync(oldRoot, { mode: 0o700 }); mkdirSync(join(oldRoot, 'artifacts'), { mode: 0o700 });
  const source = join(f.root, 'source.sqlite'); await sqliteBackup(f.db, source); chmodSync(source, 0o600);
  const db = new DatabaseSync(source); db.exec('PRAGMA foreign_keys=ON');
  t.after(() => db.close());
  const oldAuthority = { ...authority, publicationActors: () => ({ executorActorId: 'executor', backupApproverId: 'approver' }) };
  const old = createTrustedBackupServices({ db, dir: oldRoot, authority: oldAuthority });
  const output = await old.publisher.publish({ approvalId: 'approved', adminContext: context });
  const other = createImV2BackupRegistry(f.options);
  const child = fork(new URL('./fixtures/im-v2-backup/copy-worker.js', import.meta.url), [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.stdout.resume(); child.stderr.resume();
  let closed = false;
  const close = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
  const messages = [], waiters = [];
  let childError;
  child.on('error', error => { childError = error; for (const waiter of waiters.splice(0)) waiter.reject(error); });
  child.on('message', message => { const waiter = waiters.shift(); if (waiter) waiter.resolve(message); else messages.push(message); });
  function next() {
    if (childError) return Promise.reject(childError);
    if (messages.length) return Promise.resolve(messages.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('IPC barrier timeout')), 4000);
      waiters.push({ resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
  }
  async function waitClose(ms) {
    let timer;
    try { return await Promise.race([close, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
    finally { clearTimeout(timer); }
  }
  try {
    child.send({ oldRoot, newRoot: f.registryRoot, backupId: output.backupId });
    assert.equal((await next()).type, 'copy-held');
    assert.throws(() => old.registry.revokeBackup({ backupId: output.backupId, adminContext: context }), { code: 'REGISTRY_BUSY' });
    assert.throws(() => old.registry.cleanupBackup({ backupId: output.backupId, adminContext: context }), { code: 'REGISTRY_BUSY' });
    assert.throws(() => other.verify({ backupId: output.backupId }, context), { code: 'RECOVERY_BUSY' });
    child.stdin.write(Buffer.from([1]));
    assert.equal((await next()).type, 'target-verification-held');
    assert.throws(() => old.registry.revokeBackup({ backupId: output.backupId, adminContext: context }), { code: 'REGISTRY_BUSY' });
    assert.throws(() => old.registry.cleanupBackup({ backupId: output.backupId, adminContext: context }), { code: 'REGISTRY_BUSY' });
    assert.throws(() => other.verify({ backupId: output.backupId }, context), { code: 'RECOVERY_BUSY' });
    child.stdin.write(Buffer.from([1]));
    assert.equal((await next()).type, 'complete');
    assert.deepEqual(await waitClose(4000), { code: 0, signal: null });
    const record = other.verify({ backupId: output.backupId }, context).record;
    assert.equal(record.publicationKind, 'imported-registered-v3');
  } finally {
    if (!closed) child.kill('SIGTERM');
    if (!await waitClose(1000)) { child.kill('SIGKILL'); if (!await waitClose(1000)) throw Error('owned child close unconfirmed'); }
  }
});

test('new protected copy refuses async prefixes and consumes rejected promises in isolated default/observed children',
  { skip: unsupported, timeout: 30000 }, async () => {
    await isolated('callbacks-new');
    await isolated('callbacks-new', { rejectionObserver: true });
  });

test('stage holds exact retry preserves identity and files; run conflicts and duplicate logical evidence refuse', { skip: unsupported }, async t => {
  const f = fixture(t), { publisher, registry } = createTrustedImV2BackupServices(f.options);
  const first = await publisher.publish({ approvalRef: 'test-approved' }, context);
  const second = await publisher.publish({ approvalRef: 'test-approved' }, context); await publisher.drain();
  const input = { backupId: first.record.backupId, recoveryRunId: randomUUID(), stageHash: 'a'.repeat(64) };
  const directory = join(f.registryRoot, 'registry/holds');
  assert.throws(() => registry.createStageHold({ ...input, holdId: randomUUID() }, context));
  assert.deepEqual(readdirSync(directory), []);
  const hold = registry.createStageHold(input, context), names = readdirSync(directory).sort();
  const bytes = readFileSync(join(directory, `${hold.holdId}.json`));
  assert.deepEqual(registry.createStageHold({ ...input }, context), hold);
  const reopened = createImV2BackupRegistry(f.options);
  assert.deepEqual(reopened.createStageHold({ ...input }, context), hold);
  assert.deepEqual(readdirSync(directory).sort(), names);
  assert.ok(readFileSync(join(directory, `${hold.holdId}.json`)).equals(bytes));
  assert.throws(() => reopened.createStageHold({ ...input, stageHash: 'b'.repeat(64) }, context));
  assert.throws(() => reopened.createStageHold({ ...input, backupId: second.record.backupId }, context));
  assert.deepEqual(readdirSync(directory).sort(), names);
  const duplicate = { ...hold, holdId: randomUUID() };
  writeFileSync(join(directory, `${duplicate.holdId}.json`), canonical('hold', duplicate), { mode: 0o600 });
  assert.throws(() => createImV2BackupRegistry(f.options).createStageHold(input, context),
    'duplicate logical matches must not choose an arbitrary hold');
  assert.equal(readdirSync(directory).length, 2);
});

for (const kind of ['hold', 'binding'])
  test(`${kind} visible final with failed directory sync: persistent retry refuses, reopened exact retry resyncs`,
    { skip: unsupported, timeout: 20000 }, async () => { await isolated(`durability-${kind}`); });

test('cleanup streams capped metadata and verifies a shared backup only once', { skip: unsupported, timeout: 20000 }, async () => {
  await isolated('cleanup-budget');
});

test('cleanup cap counts holds for other backups and refuses unrelated owned entries', { skip: unsupported, timeout: 20000 }, async () => {
  await isolated('cleanup-unrelated');
});

test('registered v3 import applies lowered file cap without source mutation or success record', { skip: unsupported }, async t => {
  const f = fixture(t, { v3: true }), old = await legacyPublished(t, f);
  const before = readFileSync(old.artifact), manifest = readFileSync(`${old.artifact}.manifest.json`);
  const services = createTrustedImV2BackupServices({ ...f.options, limits: { maxFileBytes: before.length - 1 } });
  assert.throws(() => services.publisher.importRegisteredV3({ sourceRegistry: old.old.registry, backupId: old.output.backupId }, context),
    { code: 'RECOVERY_BUSY' });
  assert.ok(readFileSync(old.artifact).equals(before));
  assert.ok(readFileSync(`${old.artifact}.manifest.json`).equals(manifest));
  assert.deepEqual(readdirSync(join(f.registryRoot, 'registry/records')), []);
  assert.throws(() => services.registry.verify({ backupId: old.output.backupId }, context));
  assert.ok(createBackupRegistry({ dir: old.oldRoot, authority: old.oldAuthority }).getInstance());
});

test('registered v3 lowered file cap refuses before the first heavy source hash/read', { skip: unsupported, timeout: 20000 }, async () => {
  await isolated('import-file-cap');
});

test('genuine old WAL publisher preserves committed business facts and original bytes through import, reopen and cleanup',
  { skip: unsupported, timeout: 15000 }, async t => {
    const f = fixture(t, { v3: true }), old = await legacyPublished(t, f, { wal: true });
    const before = readFileSync(old.artifact), manifest = readFileSync(`${old.artifact}.manifest.json`);
    assert.equal(before[18], 2, 'fixture is the genuine legacy WAL-mode snapshot, not rewritten DELETE mode');
    assert.equal(before[19], 2);
    assert.equal(sha(before), old.output.manifest.fileHash);
    function assertClosedWalSnapshot(path) {
      const bytes = readFileSync(path);
      assert.equal(bytes[18], 2, 'WAL write-version byte remains unchanged');
      assert.equal(bytes[19], 2, 'WAL read-version byte remains unchanged');
      assert.equal(sha(bytes), old.output.manifest.fileHash);
      assert.ok(bytes.equals(before), 'complete published main bytes remain unchanged');
      for (const suffix of ['-wal', '-shm', '-journal'])
        assert.throws(() => lstatSync(`${path}${suffix}`), { code: 'ENOENT' }, `closed snapshot has no ${suffix}`);
    }
    assertClosedWalSnapshot(old.artifact);
    const services = createTrustedImV2BackupServices(f.options);
    const result = services.publisher.importRegisteredV3({ sourceRegistry: old.old.registry, backupId: old.output.backupId }, context);
    const copyPath = join(f.registryRoot, result.record.artifactReference);
    assert.ok(readFileSync(old.artifact).equals(before));
    assert.ok(readFileSync(copyPath).equals(before));
    assertClosedWalSnapshot(old.artifact);
    assertClosedWalSnapshot(copyPath);
    assert.ok(readFileSync(`${old.artifact}.manifest.json`).equals(manifest));
    assert.ok(readFileSync(join(f.registryRoot, 'registry/artifacts', `${result.record.backupId}.manifest.json`)).equals(manifest));
    assert.equal(result.record.manifestHash, sha(manifest));
    assert.equal(result.record.fileHash, sha(before));
    assert.notEqual(lstatSync(copyPath).ino, lstatSync(old.artifact).ino);
    // Observe the now-verified closed snapshot separately: the test's SQLite
    // connection must not create sidecars beside the protected publication.
    const observationPath = join(f.root, 'observed-closed-snapshot.sqlite');
    copyFileSync(copyPath, observationPath); chmodSync(observationPath, 0o600);
    const copy = new DatabaseSync(observationPath, { readOnly: true });
    try {
      assert.equal(copy.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.equal(copy.prepare('SELECT text FROM im_messages WHERE message_id=?').get(old.committedMessage).text,
        'committed only after WAL enabled');
      assert.equal(copy.prepare('SELECT count(*) n FROM im_messages').get().n, 3);
    } finally { copy.close(); }
    assert.ok(readFileSync(copyPath).equals(before));
    assert.deepEqual(createImV2BackupRegistry(f.options).verify({ backupId: result.record.backupId }, context), result);
    assertClosedWalSnapshot(old.artifact);
    assertClosedWalSnapshot(copyPath);
    assert.ok(readFileSync(`${old.artifact}.manifest.json`).equals(manifest));
    old.old.registry.revokeBackup({ backupId: old.output.backupId, adminContext: context });
    old.old.registry.cleanupBackup({ backupId: old.output.backupId, adminContext: context });
    assert.deepEqual(createImV2BackupRegistry(f.options).verify({ backupId: result.record.backupId }, context), result);
    assert.ok(readFileSync(copyPath).equals(before));
    assertClosedWalSnapshot(copyPath);
    assert.ok(readFileSync(join(f.registryRoot, 'registry/artifacts', `${result.record.backupId}.manifest.json`)).equals(manifest));
  });

test('registered WAL artifact with a preexisting committed nonempty WAL is refused rather than silently ignored',
  { skip: unsupported, timeout: 15000 }, async t => {
    const f = fixture(t, { v3: true }), old = await legacyPublished(t, f, { wal: true });
    const services = createTrustedImV2BackupServices(f.options);
    const result = services.publisher.importRegisteredV3({ sourceRegistry: old.old.registry, backupId: old.output.backupId }, context);
    const path = join(f.registryRoot, result.record.artifactReference), before = readFileSync(path);
    const writer = new DatabaseSync(path);
    try {
      writer.exec('PRAGMA wal_autocheckpoint=0');
      writer.prepare('UPDATE im_agents SET display_name=? WHERE agent_id=?').run('uncheckpointed synthetic change', f.a);
      assert.ok(lstatSync(`${path}-wal`).size > 0);
      assert.ok(readFileSync(path).equals(before), 'main-file hash alone cannot detect this committed WAL change');
      assert.throws(() => createImV2BackupRegistry(f.options).verify({ backupId: result.record.backupId }, context));
      assert.ok(readFileSync(path).equals(before), 'failed verification must not checkpoint the foreign WAL');
    } finally { writer.close(); }
  });

test('v3 bridge refuses an old registered artifact with committed sidecar state absent from its main bytes',
  { skip: unsupported, timeout: 15000 }, async t => {
    const f = fixture(t, { v3: true }), old = await legacyPublished(t, f, { wal: true });
    const before = readFileSync(old.artifact), manifest = readFileSync(`${old.artifact}.manifest.json`);
    const writer = new DatabaseSync(old.artifact);
    try {
      writer.exec('PRAGMA wal_autocheckpoint=0');
      writer.prepare('UPDATE im_agents SET display_name=? WHERE agent_id=?').run('committed artifact WAL fact', f.a);
      assert.ok(lstatSync(`${old.artifact}-wal`).size > 0);
      assert.ok(readFileSync(old.artifact).equals(before));
      const services = createTrustedImV2BackupServices(f.options);
      assert.throws(() => services.publisher.importRegisteredV3({ sourceRegistry: old.old.registry, backupId: old.output.backupId }, context));
      assert.ok(readFileSync(old.artifact).equals(before));
      assert.ok(readFileSync(`${old.artifact}.manifest.json`).equals(manifest));
      assert.deepEqual(readdirSync(join(f.registryRoot, 'registry/records')), []);
    } finally { writer.close(); }
  });
