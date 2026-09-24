import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, readFileSync, readdirSync, lstatSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAdminAuthority } from '../src/im/keystore.js';
import { createBackupRegistry } from '../src/im/backup-registry.js';
const unixTest = process.platform === 'win32' ? test.skip : test;

const hash = value => createHash('sha256').update(value).digest('hex');
const denied = code => error => error?.code === code;
function trustedTestPlatform() {
  const blocked = new Set(), syncs = [];
  const inspect = (path, directory = false) => {
    const st = lstatSync(path);
    if (blocked.has(resolve(path)) || st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile()))
      throw Object.assign(new Error('REGISTRY_UNTRUSTED_PATH'), { code: 'REGISTRY_UNTRUSTED_PATH' });
    return st;
  };
  return {
    blocked, syncs,
    privateDirectory(path) { inspect(path, true); return resolve(path); },
    protectedPath: inspect,
    checkOpened(path, before, opened) {
      inspect(path);
      if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino ||
          opened.dev !== lstatSync(path).dev || opened.ino !== lstatSync(path).ino)
        throw Object.assign(new Error('REGISTRY_UNTRUSTED_PATH'), { code: 'REGISTRY_UNTRUSTED_PATH' });
    },
    syncDirectory(path) { inspect(path, true); syncs.push(resolve(path)); }, // deterministic capability, not real durability
  };
}
function fixture({ platform = trustedTestPlatform(), fault } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'im-registry-'));
  chmodSync(base, 0o700);
  const dir = join(base, 'registry'); mkdirSync(dir, { mode: 0o700 });
  const artifacts = join(dir, 'artifacts'); mkdirSync(artifacts, { mode: 0o700 });
  const secretFile = join(base, 'admin.secret'), secret = 'a'.repeat(64);
  writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
  const authority = createAdminAuthority({ secretFile, trustWindowsPermissions: process.platform === 'win32', report: () => {} });
  const adminContext = { adminSecret: secret }, instanceId = randomUUID(), backupId = randomUUID();
  const registry = createBackupRegistry({ dir, authority, clock: () => 1700000000000, platform, fault });
  registry.registerInstance({ instanceId, dbLocation: '/private/db.sqlite', adminContext });
  const contents = 'isolated snapshot', fileHash = hash(contents), schemaChecksum = hash('schema');
  const manifest = { backupId, fileHash, schemaVersion: 1, schemaChecksum, completedAt: 123,
    toolVersion: 'test-v1', approvalId: 'approval', verification: { integrityCheck: true,
      foreignKeyCheck: true, schemaCheck: true, hashCheck: true } };
  const artifactReference = `artifacts/${backupId}.sqlite`, path = join(artifacts, `${backupId}.sqlite`);
  writeFileSync(path, contents, { mode: 0o600 });
  const manifestText = JSON.stringify(manifest);
  writeFileSync(`${path}.manifest.json`, manifestText, { mode: 0o600 });
  const args = { instanceId, registrationGeneration: 1, backupId, fileHash, schemaVersion: 1, schemaChecksum,
    completedAt: 123, executorActorId: 'executor', backupApprovalId: 'approval', backupApproverId: 'approver',
    toolVersion: 'test-v1', artifactReference, manifestHash: hash(manifestText), adminContext };
  const expected = { instanceId, registrationGeneration: 1, fileHash, schemaVersion: 1, schemaChecksum };
  return { base, dir, artifacts, registry, adminContext, authority, args, expected, path, backupId, platform };
}

test('register and resolve immutable publication; no private DB location returned', () => {
  const f = fixture();
  assert.deepEqual(f.registry.getInstance(), { instanceId: f.args.instanceId, registrationGeneration: 1 });
  assert.equal(f.registry.registerPublishedBackup(f.args).durability, 'durable');
  assert.equal(f.registry.resolveForMigration({ backupId: f.backupId, expected: f.expected }).fileHash, f.args.fileHash);
  const saved = readFileSync(join(f.dir, `backup-${f.backupId}.json`), 'utf8');
  assert.ok(!saved.includes('/private/db.sqlite'));
  assert.throws(() => f.registry.registerPublishedBackup({ ...f.args, fileHash: hash('other') }), denied('REGISTRY_ALREADY_EXISTS'));
  assert.equal(readFileSync(join(f.dir, `backup-${f.backupId}.json`), 'utf8'), saved);
  for (const expected of [{ ...f.expected, instanceId: randomUUID() }, { ...f.expected, registrationGeneration: 2 }])
    assert.throws(() => f.registry.resolveForMigration({ backupId: f.backupId, expected }), denied('REGISTRY_INSTANCE_MISMATCH'));
  assert.throws(() => f.registry.resolveForMigration({ backupId: randomUUID(), expected: f.expected }), denied('REGISTRY_NOT_FOUND'));
  assert.throws(() => f.registry.resolveForMigration({ backupId: f.backupId, expected: { ...f.expected, fileHash: hash('no') } }), denied('REGISTRY_HASH_MISMATCH'));
  assert.throws(() => f.registry.resolveForMigration({ backupId: f.backupId, expected: { ...f.expected, schemaVersion: 2 } }), denied('REGISTRY_SCHEMA_MISMATCH'));
  assert.throws(() => f.registry.resolveForMigration({ backupId: f.backupId, expected: { ...f.expected, schemaChecksum: hash('wrong') } }), denied('REGISTRY_SCHEMA_MISMATCH'));
});

test('literal-true authority required; simulated ACL rejects direct JSON (not same-privilege forgery proof)', () => {
  const f = fixture();
  assert.throws(() => f.registry.registerPublishedBackup({ ...f.args, adminContext: { admin: true } }), denied('REGISTRY_AUTH_DENIED'));
  assert.throws(() => createBackupRegistry({ dir: f.dir, platform: f.platform })
    .registerPublishedBackup(f.args), denied('REGISTRY_AUTH_DENIED'));
  assert.throws(() => createBackupRegistry({ dir: f.dir, platform: f.platform, authority: { authorizeAdmin: () => { throw Error('denied'); } } })
    .registerPublishedBackup(f.args), denied('REGISTRY_AUTH_DENIED'));
  assert.throws(() => createBackupRegistry({ dir: f.dir, platform: f.platform, authority: { authorizeAdmin: () => Promise.resolve(true) } })
    .registerPublishedBackup(f.args), denied('REGISTRY_AUTH_DENIED'));
  assert.throws(() => f.registry.resolveForMigration({ backupId: f.backupId, expected: f.expected }), denied('REGISTRY_NOT_FOUND'));
  const fake = join(f.dir, `backup-${f.backupId}.json`);
  writeFileSync(fake, JSON.stringify({ ...f.args, publicationState: 'published' }), { mode: 0o644 });
  f.platform.blocked.add(resolve(fake)); // simulated ACL marks direct write as untrusted
  assert.throws(() => f.registry.resolveForMigration({ backupId: f.backupId, expected: f.expected }), denied('REGISTRY_UNTRUSTED_PATH'));
});

test('reject traversal, absolute references, simulated symlinks and reparse points', () => {
  const f = fixture();
  for (const artifactReference of ['../elsewhere', '/tmp/elsewhere', 'artifacts/../elsewhere', 'artifacts/../../outside', 'artifacts\\elsewhere'])
    assert.throws(() => f.registry.registerPublishedBackup({ ...f.args, artifactReference }), denied('REGISTRY_ARTIFACT_DENIED'));
  const link = join(f.artifacts, 'link.sqlite'); writeFileSync(link, 'simulated-link', { mode: 0o600 });
  f.platform.blocked.add(resolve(link)); // ACL/reparse test double refuses this path
  assert.throws(() => f.registry.registerPublishedBackup({ ...f.args, artifactReference: 'artifacts/link.sqlite' }), denied('REGISTRY_UNTRUSTED_PATH'));
  f.platform.blocked.add(resolve(f.path)); // test double marks reparse/ACL-untrusted leaf
  assert.throws(() => f.registry.registerPublishedBackup(f.args), denied('REGISTRY_UNTRUSTED_PATH'));
});

test('file/directory sync interruption cannot publish a successful record', () => {
  const f = fixture();
  for (const stage of ['file-sync', 'directory-sync']) {
    const broken = createBackupRegistry({ dir: f.dir, authority: f.authority, platform: f.platform,
      fault: point => { if (point === stage) throw new Error('simulated interruption'); } });
    assert.throws(() => broken.registerPublishedBackup(f.args), denied(stage === 'directory-sync' ? 'REGISTRY_CLEANUP_INCOMPLETE' : 'REGISTRY_WRITE_FAILED'));
    assert.ok(!readdirSync(f.dir).includes(`backup-${f.backupId}.json`));
  }
});

test('use handles cannot release another handle; drain waits for last genuine handle', async () => {
  const f = fixture(); f.registry.registerPublishedBackup(f.args);
  const a = f.registry.beginUse(f.backupId), b = f.registry.beginUse(f.backupId);
  assert.throws(() => f.registry.revokeBackup({ backupId: f.backupId, adminContext: f.adminContext }), denied('REGISTRY_IN_USE'));
  assert.throws(() => f.registry.cleanupBackup({ backupId: f.backupId, adminContext: f.adminContext }), denied('REGISTRY_IN_USE'));
  let drained = false; const pending = f.registry.drain().then(() => { drained = true; });
  assert.equal(f.registry.endUse, undefined);
  a.end(); a.end(); await Promise.resolve(); assert.equal(drained, false);
  assert.throws(() => f.registry.revokeBackup({ backupId: f.backupId, adminContext: f.adminContext }), denied('REGISTRY_IN_USE'));
  b.end(); await pending; assert.equal(drained, true);
  await f.registry.drain();
  f.registry.revokeBackup({ backupId: f.backupId, adminContext: f.adminContext });
  assert.throws(() => f.registry.resolveForMigration({ backupId: f.backupId, expected: f.expected }), denied('REGISTRY_REVOKED'));
  f.registry.cleanupBackup({ backupId: f.backupId, adminContext: f.adminContext });
});

test('separate registry object can revoke/cleanup despite a handle in another object', () => {
  const f = fixture(); f.registry.registerPublishedBackup(f.args);
  const handle = f.registry.beginUse(f.backupId);
  const other = createBackupRegistry({ dir: f.dir, authority: f.authority, platform: f.platform });
  other.revokeBackup({ backupId: f.backupId, adminContext: f.adminContext });
  other.cleanupBackup({ backupId: f.backupId, adminContext: f.adminContext });
  assert.equal(existsSync(f.path), false);
  handle.end();
});

test('strict versioned instance/publication/revocation reader schemas fail with fixed code', () => {
  const f = fixture(); f.registry.registerPublishedBackup(f.args);
  const instancePath = join(f.dir, 'instance-1.json');
  const backupPath = join(f.dir, `backup-${f.backupId}.json`);
  const savedInstance = JSON.parse(readFileSync(instancePath, 'utf8'));
  const savedBackup = JSON.parse(readFileSync(backupPath, 'utf8'));
  const replace = (path, value) => writeFileSync(path, JSON.stringify(value));
  const check = (path, original, operation, mutations) => {
    for (const mutation of mutations) {
      replace(path, mutation);
      assert.throws(operation, denied('REGISTRY_UNTRUSTED_RECORD'));
    }
    replace(path, original);
  };
  check(instancePath, savedInstance, () => f.registry.getInstance(), [null, [], { ...savedInstance, recordVersion: 2 },
    { ...savedInstance, unknown: 1 }, { ...savedInstance, dbLocation: undefined }]);
  check(backupPath, savedBackup, () => f.registry.resolveForMigration({ backupId: f.backupId, expected: f.expected }),
    [null, [], { ...savedBackup, recordVersion: 2 }, { ...savedBackup, unknown: 1 },
      { ...savedBackup, registeredAt: -1 }, { ...savedBackup, completedAt: -1 },
      { ...savedBackup, schemaVersion: 0 }, { ...savedBackup, executorActorId: undefined }]);
  f.registry.revokeBackup({ backupId: f.backupId, adminContext: f.adminContext });
  const revokedPath = join(f.dir, `revoked-${f.backupId}.json`);
  const savedRevoked = JSON.parse(readFileSync(revokedPath, 'utf8'));
  check(revokedPath, savedRevoked, () => f.registry.resolveForMigration({ backupId: f.backupId, expected: f.expected }),
    [null, [], { ...savedRevoked, recordVersion: 2 }, { ...savedRevoked, unknown: 1 },
      { ...savedRevoked, revokedAt: -1 }, { ...savedRevoked, backupId: undefined }]);
});

test('rollback and cleanup fsync changed directory; partial delete remains revoked and retryable', () => {
  const f = fixture();
  let attempts = 0;
  const broken = createBackupRegistry({ dir: f.dir, authority: f.authority, platform: f.platform,
    fault: point => { if (point === 'directory-sync' && ++attempts === 1) throw Error('simulated'); } });
  assert.throws(() => broken.registerPublishedBackup(f.args), denied('REGISTRY_DURABILITY_UNAVAILABLE'));
  assert.equal(existsSync(join(f.dir, `backup-${f.backupId}.json`)), false);
  assert.equal(f.platform.syncs.at(-1), resolve(f.dir));
  f.registry.registerPublishedBackup(f.args);
  f.registry.revokeBackup({ backupId: f.backupId, adminContext: f.adminContext });
  f.platform.syncs.length = 0;
  const interrupted = createBackupRegistry({ dir: f.dir, authority: f.authority, platform: f.platform,
    fault: (point, leaf) => { if (point === 'before-artifact-unlink' && leaf.endsWith('.manifest.json')) throw Error('simulated second unlink failure'); } });
  assert.throws(() => interrupted.cleanupBackup({ backupId: f.backupId, adminContext: f.adminContext }), denied('REGISTRY_CLEANUP_INCOMPLETE'));
  assert.equal(existsSync(f.path), false);
  assert.equal(existsSync(`${f.path}.manifest.json`), true);
  assert.deepEqual(f.platform.syncs, [resolve(f.artifacts)]);
  f.platform.syncs.length = 0;
  f.registry.cleanupBackup({ backupId: f.backupId, adminContext: f.adminContext });
  assert.deepEqual(f.platform.syncs, [resolve(f.artifacts)]);
  assert.equal(existsSync(`${f.path}.manifest.json`), false);
  assert.throws(() => f.registry.resolveForMigration({ backupId: f.backupId, expected: f.expected }), denied('REGISTRY_REVOKED'));
  f.registry.cleanupBackup({ backupId: f.backupId, adminContext: f.adminContext });
});

unixTest('real Unix permissions and symlink inspection (skipped on Windows: native ACL/reparse semantics unavailable)', () => {
  const f = fixture();
  const native = createBackupRegistry({ dir: f.dir, authority: f.authority });
  assert.equal(native.registerPublishedBackup(f.args).durability, 'durable');
  assert.equal(native.resolveForMigration({ backupId: f.backupId, expected: f.expected }).backupId, f.backupId);
  chmodSync(f.path, 0o644);
  assert.throws(() => native.resolveForMigration({ backupId: f.backupId, expected: f.expected }), denied('REGISTRY_UNTRUSTED_PATH'));
  const g = fixture(), other = createBackupRegistry({ dir: g.dir, authority: g.authority });
  const link = join(g.artifacts, 'link.sqlite'); symlinkSync(g.path, link);
  assert.throws(() => other.registerPublishedBackup({ ...g.args, artifactReference: 'artifacts/link.sqlite' }), denied('REGISTRY_UNTRUSTED_PATH'));
});

test('Windows ACL and reparse trust cannot be established with portable Node primitives', () => {
  if (process.platform !== 'win32') return;
  const dir = mkdtempSync(join(tmpdir(), 'registry-win-'));
  assert.throws(() => createBackupRegistry({ dir }), error => ['REGISTRY_PERMISSION_UNVERIFIED', 'REGISTRY_UNTRUSTED_PATH'].includes(error?.code));
});
