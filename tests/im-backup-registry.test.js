import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackupRegistry, createTrustedBackupServices } from '../src/im/backup-registry.js';
import * as registryModule from '../src/im/backup-registry.js';
import * as publisherModule from '../src/im/backup-publisher.js';
import { createAdminAuthority } from '../src/im/keystore.js';
import { createImBackup } from '../src/im/backup.js';
import { getInstanceIdentity, initInstanceIdentity, migrateImSchema } from '../src/im/schema.js';

const denied = code => error => error?.code === code;
// TEST DOUBLE ONLY: these callbacks do not establish ACL or crash durability on Windows.
const platform = {
  privateDirectory(path) { assert.ok(lstatSync(path).isDirectory()); return resolve(path); },
  protectedPath(path, directory = false) { const st = lstatSync(path); assert.ok(directory ? st.isDirectory() : st.isFile()); return st; },
  checkOpened(path, before, opened) { assert.equal(before.ino, opened.ino); assert.equal(lstatSync(path).ino, opened.ino); },
  syncDirectory() {},
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'registry-'));
  const dir = join(root, 'registry'); mkdirSync(dir, { mode: 0o700 }); mkdirSync(join(dir, 'artifacts'), { mode: 0o700 });
  const secret = 'c'.repeat(64), secretFile = join(root, 'admin.secret');
  writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
  const real = createAdminAuthority({ secretFile, trustWindowsPermissions: process.platform === 'win32', report() {} });
  const authority = { authorizeAdmin: ctx => real.authorizeAdmin(ctx), publicationActors: () => ({ executorActorId: 'executor', backupApproverId: 'approver' }) };
  const adminContext = { adminSecret: secret }, db = new DatabaseSync(join(root, 'source.sqlite'));
  db.exec('PRAGMA foreign_keys=ON'); migrateImSchema(db); initInstanceIdentity(db);
  const services = createTrustedBackupServices({ db, dir, authority, platform });
  return { root, dir, db, authority, adminContext, services, ...services, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const expected = (f, output) => ({ instanceId: getInstanceIdentity(f.db).instanceId, registrationGeneration: 1,
  fileHash: output.manifest.fileHash, schemaVersion: output.manifest.schemaVersion, schemaChecksum: output.manifest.schemaChecksum });
const onWindows = process.platform === 'win32';

test('reader facade and trusted services return no general registration writer or artifact directory', t => {
  const f = fixture(); t.after(() => f.close());
  assert.deepEqual(Reflect.ownKeys(f.services).sort(), ['publisher', 'registry']);
  assert.equal(Object.isFrozen(f.services), true);
  assert.deepEqual(Reflect.ownKeys(f.registry).sort(), ['beginUse', 'cleanupBackup', 'drain', 'getInstance', 'resolveForMigration', 'revokeBackup', 'status']);
  assert.equal(Object.isFrozen(f.registry), true);
  assert.deepEqual(Reflect.ownKeys(f.publisher), ['publish']);
  assert.equal(Object.isFrozen(f.publisher), true);
  for (const value of [f.services, f.registry, f.publisher]) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(value)) {
      assert.equal(Object.hasOwn(descriptors[key], 'value'), true, 'no accessor can hide a writer');
      assert.equal(descriptors[key].configurable, false);
      assert.equal(descriptors[key].writable, false);
      assert.ok(!['writer', 'backup', 'artifactDirectory', 'directory', 'registerInstance', 'registerPublishedBackup'].includes(key));
    }
  }
  assert.deepEqual(Reflect.ownKeys(registryModule).filter(key => typeof key === 'string').sort(), ['createBackupRegistry', 'createTrustedBackupServices']);
  assert.deepEqual(Reflect.ownKeys(publisherModule).filter(key => typeof key === 'string'), ['createBackupPublisher']);
  for (const module of [registryModule, publisherModule])
    assert.deepEqual(Reflect.ownKeys(module).filter(key => typeof key === 'symbol'), [Symbol.toStringTag]);
  assert.equal(f.registry.registerInstance, undefined);
  assert.equal(f.registry.registerPublishedBackup, undefined);
  assert.equal(f.registry.artifactDirectory, undefined);
  assert.deepEqual(Object.keys(createBackupRegistry({ dir: f.dir, authority: f.authority, platform })).sort(), Object.keys(f.registry).sort());
  assert.equal(Object.getOwnPropertyDescriptors(f.services).registry.value, f.registry);
});

test('self-consistent fake non-SQLite artifact with correct hashes and four true flags is not registrable', t => {
  const f = fixture(); t.after(() => f.close());
  const backupId = randomUUID(), instanceId = getInstanceIdentity(f.db).instanceId;
  const path = join(f.dir, 'artifacts', `${backupId}.sqlite`);
  writeFileSync(path, 'forged non-SQLite content', { mode: 0o600 });
  const fileHash = createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest = { backupId, sourceId: instanceId, fileHash, schemaVersion: 2,
    schemaChecksum: 'a'.repeat(64), completedAt: 123, approvalId: 'approved', toolVersion: 'forged',
    verification: { integrityCheck: true, foreignKeyCheck: true, schemaCheck: true, hashCheck: true } };
  writeFileSync(`${path}.manifest.json`, JSON.stringify(manifest), { mode: 0o600 });
  const manifestHash = createHash('sha256').update(readFileSync(`${path}.manifest.json`)).digest('hex');
  // Historical API accepted exactly these fields: source ID and SQLite were not inspected.
  const oldWriteArgs = { instanceId, registrationGeneration: 1, backupId, fileHash, schemaVersion: 2,
    schemaChecksum: manifest.schemaChecksum, completedAt: 123, executorActorId: 'executor', backupApprovalId: 'approved',
    backupApproverId: 'approver', toolVersion: 'forged', artifactReference: `artifacts/${backupId}.sqlite`, manifestHash,
    adminContext: f.adminContext };
  assert.equal(f.registry.registerPublishedBackup, undefined);
  assert.equal(f.publisher.registerPublishedBackup, undefined);
  assert.equal(f.publisher.publish.length, 0);
  assert.throws(() => f.registry.resolveForMigration({ backupId, expected: { ...oldWriteArgs } }), denied('REGISTRY_NOT_FOUND'));
  assert.equal(readdirSync(f.dir).some(name => name.startsWith('backup-')), false);
});

test('real published record retains resolution, revocation and in-process use handles (no cross-process race)', { skip: onWindows }, async t => {
  const f = fixture(); t.after(() => f.close());
  const output = await f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' });
  assert.equal(f.registry.resolveForMigration({ backupId: output.backupId, expected: expected(f, output) }).publicationState, 'published');
  assert.deepEqual(f.registry.getInstance(), { instanceId: getInstanceIdentity(f.db).instanceId, registrationGeneration: 1 });
  const handle = f.registry.beginUse(output.backupId);
  assert.equal(f.registry.status().activeUses, 1);
  assert.throws(() => f.registry.revokeBackup({ backupId: output.backupId, adminContext: f.adminContext }), denied('REGISTRY_IN_USE'));
  let settled = false; const wait = f.registry.drain().then(() => { settled = true; });
  handle.end(); handle.end(); await wait; assert.equal(settled, true);
  const original = readFileSync(join(f.dir, `backup-${output.backupId}.json`), 'utf8');
  assert.ok(!original.includes(f.adminContext.adminSecret));
  const artifactName = output.artifactReference.split('/')[1];
  const duplicate = join(f.dir, 'artifacts', 'duplicate.sqlite');
  copyFileSync(join(f.dir, 'artifacts', artifactName), duplicate);
  copyFileSync(`${join(f.dir, 'artifacts', artifactName)}.manifest.json`, `${duplicate}.manifest.json`);
  const actualBackup = createImBackup({ db: f.db, authority: f.authority });
  assert.equal(actualBackup.verify({ backupPath: duplicate, manifestPath: `${duplicate}.manifest.json` }).ok, true);
  assert.throws(() => f.registry.resolveForMigration({ backupId: output.backupId, expected: { ...expected(f, output), fileHash: '0'.repeat(64) } }), denied('REGISTRY_HASH_MISMATCH'));
  const second = await f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved', backupId: output.backupId,
    artifactReference: `artifacts/${artifactName}`, fileHash: output.manifest.fileHash });
  assert.notEqual(second.backupId, output.backupId);
  assert.equal(readFileSync(join(f.dir, `backup-${output.backupId}.json`), 'utf8'), original);
  f.registry.revokeBackup({ backupId: output.backupId, adminContext: f.adminContext });
  assert.throws(() => f.registry.revokeBackup({ backupId: output.backupId, adminContext: f.adminContext }), denied('REGISTRY_ALREADY_EXISTS'));
  assert.throws(() => f.registry.resolveForMigration({ backupId: output.backupId, expected: expected(f, output) }), denied('REGISTRY_REVOKED'));
  f.registry.cleanupBackup({ backupId: output.backupId, adminContext: f.adminContext });
  assert.equal(readFileSync(join(f.dir, `backup-${output.backupId}.json`), 'utf8'), original);
});

test('separate registry facade does not provide cross-process use/revocation serialization', { skip: onWindows }, async t => {
  const f = fixture(); t.after(() => f.close());
  const output = await f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' });
  const handle = f.registry.beginUse(output.backupId);
  const other = createBackupRegistry({ dir: f.dir, authority: f.authority, platform });
  other.revokeBackup({ backupId: output.backupId, adminContext: f.adminContext });
  assert.throws(() => other.resolveForMigration({ backupId: output.backupId, expected: expected(f, output) }), denied('REGISTRY_REVOKED'));
  handle.end();
});

test('native Windows registry remains fail closed', { skip: !onWindows }, t => {
  const f = fixture(); t.after(() => f.close());
  assert.throws(() => createBackupRegistry({ dir: f.dir, authority: f.authority }), denied('REGISTRY_PERMISSION_UNVERIFIED'));
  assert.throws(() => createTrustedBackupServices({ db: f.db, dir: f.dir, authority: f.authority }), denied('REGISTRY_PERMISSION_UNVERIFIED'));
});

test('caller cannot request duplicate backupId; pre-existing record untouched and duplicate revocation refused', async t => {
  const f = fixture(); t.after(() => f.close());
  const sourceId = getInstanceIdentity(f.db).instanceId, backupId = randomUUID();
  const record = join(f.dir, `backup-${backupId}.json`);
  // Seed a pre-existing final filename: the trusted publication must never replace it.
  const sentinel = JSON.stringify({ sentinel: backupId });
  writeFileSync(record, sentinel, { mode: 0o600 });
  if (onWindows) {
    await assert.rejects(f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved', backupId }), denied('BACKUP_DURABILITY_UNAVAILABLE'));
    assert.equal(readFileSync(record, 'utf8'), sentinel);
    return;
  }
  const published = await f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved', backupId });
  assert.notEqual(published.backupId, backupId);
  assert.equal(readFileSync(record, 'utf8'), sentinel);
  f.registry.revokeBackup({ backupId: published.backupId, adminContext: f.adminContext });
  assert.throws(() => f.registry.revokeBackup({ backupId: published.backupId, adminContext: f.adminContext }), denied('REGISTRY_ALREADY_EXISTS'));
  assert.equal(f.registry.registerPublishedBackup, undefined);
  assert.equal(sourceId, getInstanceIdentity(f.db).instanceId);
});

test('historical payload construction and unreachable writer interface (not an old-version exploit replay)', t => {
  const a = fixture(), b = fixture(); t.after(() => { a.close(); b.close(); });
  const sourceA = getInstanceIdentity(a.db).instanceId, sourceB = getInstanceIdentity(b.db).instanceId;
  assert.notEqual(sourceA, sourceB);
  const fakeFile = join(a.dir, 'artifacts', 'foreign.sqlite'); writeFileSync(fakeFile, 'illustrative payload only');
  const manifest = { backupId: randomUUID(), sourceId: sourceB, fileHash: createHash('sha256').update(readFileSync(fakeFile)).digest('hex'),
    schemaVersion: 2, schemaChecksum: 'a'.repeat(64), completedAt: 1, toolVersion: 'v1', approvalId: 'approved',
    verification: { integrityCheck: true, foreignKeyCheck: true, schemaCheck: true, hashCheck: true } };
  // Construct two illustrative manifest variants; neither executes a historical writer.
  for (const sourceId of [sourceB, sourceA]) {
    const historical = { ...manifest, sourceId };
    assert.equal(historical.fileHash, manifest.fileHash);
    assert.equal(historical.backupId, manifest.backupId);
  }
  assert.equal(a.registry.registerPublishedBackup, undefined);
  assert.throws(() => a.registry.resolveForMigration({ backupId: manifest.backupId, expected: { instanceId: sourceA,
    registrationGeneration: 1, fileHash: manifest.fileHash, schemaVersion: 2, schemaChecksum: manifest.schemaChecksum } }), denied('REGISTRY_NOT_FOUND'));
});
