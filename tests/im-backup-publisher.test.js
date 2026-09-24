import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync, backup as nativeBackup } from 'node:sqlite';
import { createTrustedBackupServices, createBackupRegistry } from '../src/im/backup-registry.js';
import { createBackupPublisher } from '../src/im/backup-publisher.js';
import { createImBackup } from '../src/im/backup.js';
import { createAdminAuthority } from '../src/im/keystore.js';
import { getInstanceIdentity, initInstanceIdentity, migrateImSchema, migrateImSchemaV3 } from '../src/im/schema.js';
import { V1_DDL, V1_CHECKSUM } from './fixtures/im-schema/v1.js';

const denied = code => error => error?.code === code;
// TEST DOUBLE ONLY: does not validate Windows ACLs or directory fsync durability.
const platform = {
  privateDirectory(path) { assert.ok(lstatSync(path).isDirectory()); return resolve(path); },
  protectedPath(path, directory = false) { const st = lstatSync(path); assert.ok(directory ? st.isDirectory() : st.isFile()); return st; },
  checkOpened(path, before, opened) { assert.equal(before.ino, opened.ino); assert.equal(lstatSync(path).ino, opened.ino); },
  syncDirectory() {},
};
function fixture({ identity = true, native = false, lowLevel = false, version = 3 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'publisher-'));
  chmodSync(root, 0o700);
  const dir = join(root, 'registry'), artifacts = join(dir, 'artifacts');
  mkdirSync(dir, { mode: 0o700 }); mkdirSync(artifacts, { mode: 0o700 });
  const secret = 'e'.repeat(64), secretFile = join(root, 'admin.secret');
  writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
  const realAuthority = createAdminAuthority({ secretFile, trustWindowsPermissions: process.platform === 'win32', report() {} });
  const reports = [];
  const authority = { authorizeAdmin: ctx => realAuthority.authorizeAdmin(ctx),
    publicationActors: () => ({ executorActorId: 'executor', backupApproverId: 'approver' }) };
  const adminContext = { adminSecret: secret }, db = new DatabaseSync(join(root, 'source.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  if (version === 2) migrateImSchema(db);
  else migrateImSchemaV3(db);
  if (identity) initInstanceIdentity(db);
  const options = { db, dir, authority, ...(native ? {} : { platform }) };
  const services = lowLevel ? null : createTrustedBackupServices(options);
  return { root, dir, artifacts, secret, reports, db, authority, adminContext, services, ...services,
    close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const records = f => readdirSync(f.dir).filter(name => name.startsWith('backup-'));
const expected = (f, result) => ({ instanceId: getInstanceIdentity(f.db).instanceId,
  instanceCreatedAt: getInstanceIdentity(f.db).createdAt, registrationGeneration: 1,
  fileHash: result.manifest.fileHash,
  manifestHash: createHash('sha256').update(readFileSync(join(f.dir, result.artifactReference + '.manifest.json'))).digest('hex'),
  schemaVersion: result.manifest.schemaVersion, schemaChecksum: result.manifest.schemaChecksum });

test('public facade cannot register arbitrary file, hash or provenance fields', t => {
  if (process.platform === 'win32') return t.skip('native registry unavailable on Windows');
  const f = fixture(); t.after(() => f.close());
  assert.deepEqual(Reflect.ownKeys(f.services).sort(), ['publisher', 'registry']);
  assert.equal(Object.isFrozen(f.services), true);
  for (const value of [f.services, f.registry, f.publisher]) {
    assert.equal(Object.isFrozen(value), true);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      assert.equal(Object.hasOwn(descriptor, 'value'), true);
      assert.equal(descriptor.writable, false);
      assert.ok(!['writer', 'backup', 'artifactDirectory', 'directory', 'registerInstance', 'registerPublishedBackup'].includes(key));
    }
  }
  assert.equal(f.registry.registerInstance, undefined);
  assert.equal(f.registry.registerPublishedBackup, undefined);
  assert.deepEqual(Object.keys(f.publisher), ['publish']);
  assert.equal(f.publisher.registerPublishedBackup, undefined);
  const reopened = createBackupRegistry({ dir: f.dir, authority: f.authority, platform });
  assert.equal(reopened.registerPublishedBackup, undefined);
});

test('real factory ignores attacker artifact/hash/ID/source; Windows strict backup refuses before publication', async t => {
  if (process.platform === 'win32') return t.skip('native registry unavailable on Windows');
  const f = fixture(); t.after(() => f.close());
  const fakeId = randomUUID(), fakeHash = 'a'.repeat(64);
  const publish = () => f.services.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved',
    backupId: fakeId, artifactReference: 'artifacts/attacker.sqlite', destinationPath: join(f.root, 'outside.sqlite'),
    fileHash: fakeHash, manifestHash: fakeHash, sourceId: randomUUID(), instanceId: randomUUID(),
    publicationState: 'published' });
  if (process.platform === 'win32') {
    await assert.rejects(publish(), denied('BACKUP_DURABILITY_UNAVAILABLE'));
    assert.throws(() => f.registry.resolveForMigration({ backupId: fakeId,
      expected: { instanceId: getInstanceIdentity(f.db).instanceId, registrationGeneration: 1,
        fileHash: fakeHash, schemaVersion: 2, schemaChecksum: fakeHash } }), denied('REGISTRY_NOT_FOUND'));
    assert.deepEqual(records(f), []);
    return;
  }
  const result = await publish();
  assert.notEqual(result.backupId, fakeId);
  assert.notEqual(result.manifest.fileHash, fakeHash);
  assert.equal(result.manifest.sourceId, getInstanceIdentity(f.db).instanceId);
  assert.ok(result.artifactReference.startsWith('artifacts/'));
  assert.notEqual(result.artifactReference, 'artifacts/attacker.sqlite');
  assert.equal(f.registry.resolveForMigration({ backupId: result.backupId, expected: expected(f, result) }).publicationState, 'published');
  assert.throws(() => f.registry.resolveForMigration({ backupId: fakeId, expected: expected(f, result) }), denied('REGISTRY_NOT_FOUND'));
  assert.deepEqual(records(f), [`backup-${result.backupId}.json`]);
});

test('authorization failure touches no db, registry or backup; secret canary absent from errors and callback', async t => {
  const f = fixture({ lowLevel: true }); t.after(() => f.close());
  let dbCalls = 0, registryCalls = 0, backupCalls = 0;
  const db = { prepare() { dbCalls++; throw Error('db touched'); } };
  const registry = { getInstance() { registryCalls++; throw Error('registry touched'); } };
  const backup = { backup() { backupCalls++; throw Error('backup touched'); } };
  for (const authority of [undefined, { authorizeAdmin: () => Promise.resolve(true) },
    { authorizeAdmin: () => { throw Error(`leak ${f.secret}`); } }, { authorizeAdmin: () => ({ ok: true }) }]) {
    const publisher = createBackupPublisher({ db, registry, backup, authority });
    await assert.rejects(publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' }), error => {
      assert.equal(error.code, 'BACKUP_AUTH_DENIED'); assert.ok(!JSON.stringify(error).includes(f.secret));
      assert.ok(!String(error).includes(f.secret)); return true;
    });
  }
  assert.deepEqual([dbCalls, registryCalls, backupCalls], [0, 0, 0]);
  assert.ok(!JSON.stringify(f.reports).includes(f.secret));
});

test('v2 missing identity and v1 bootstrap verify content but cannot publish', async t => {
  if (process.platform === 'win32') return t.skip('native registry unavailable on Windows');
  const f = fixture({ identity: false, version: 2 });
  const old = new DatabaseSync(join(f.root, 'v1.sqlite')); t.after(() => { old.close(); f.close(); });
  const backup = createImBackup({ db: f.db, authority: f.authority, durability: process.platform === 'win32' ? 'best-effort' : 'strict' });
  const first = await backup.backup({ destinationPath: join(f.artifacts, 'bootstrap.sqlite'), approvalId: 'approved', sourceId: 'bootstrap', adminContext: f.adminContext });
  assert.equal(backup.verify(first).ok, true);
  await assert.rejects(f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' }), denied('BACKUP_IDENTITY_MISMATCH'));
  old.exec('PRAGMA foreign_keys=ON'); for (const sql of V1_DDL) old.exec(sql);
  old.prepare('INSERT INTO im_schema VALUES (1,?)').run(V1_CHECKSUM);
  old.exec("INSERT INTO im_settings VALUES (1,'paused'); INSERT INTO im_clock VALUES (1,0)");
  const oldBackup = createImBackup({ db: old, authority: f.authority, durability: process.platform === 'win32' ? 'best-effort' : 'strict' });
  const second = await oldBackup.backup({ destinationPath: join(f.artifacts, 'old.sqlite'), approvalId: 'approved', sourceId: 'bootstrap', adminContext: f.adminContext });
  assert.equal(oldBackup.verify(second).ok, true);
  const oldService = createTrustedBackupServices({ db: old, dir: f.dir, authority: f.authority, platform });
  await assert.rejects(oldService.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' }), denied('BACKUP_IDENTITY_MISMATCH'));
  assert.deepEqual(records(f), []);
});

test('Windows native registry fails closed', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'registry-windows-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => createTrustedBackupServices({ dir: root, platform }), denied('REGISTRY_PERMISSION_UNVERIFIED'));
});

test('Unix native strict E2E survives reopening registry without platform double', { skip: process.platform === 'win32' }, async t => {
  const f = fixture({ native: true }); t.after(() => f.close());
  const result = await f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved', sourceId: randomUUID(), instanceId: randomUUID() });
  assert.equal(result.manifest.sourceId, getInstanceIdentity(f.db).instanceId);
  const reopened = createBackupRegistry({ dir: f.dir, authority: f.authority });
  assert.equal(reopened.resolveForMigration({ backupId: result.backupId, expected: expected(f, result) }).publicationState, 'published');
  assert.ok(!readFileSync(join(f.dir, `backup-${result.backupId}.json`), 'utf8').includes(f.secret));
  assert.ok(!JSON.stringify(result).includes(f.secret));
  assert.ok(!readFileSync(join(f.artifacts, `${result.artifactReference.split('/')[1]}.manifest.json`), 'utf8').includes(f.secret));
});

test('foreign B legal backup: original and relabeled source claims cannot become A publication via real factory', async t => {
  if (process.platform === 'win32') return t.skip('native registry unavailable on Windows');
  const a = fixture(), b = fixture(); t.after(() => { a.close(); b.close(); });
  const bBackup = createImBackup({ db: b.db, authority: b.authority, durability: process.platform === 'win32' ? 'best-effort' : 'strict' });
  const bResult = await bBackup.backup({ destinationPath: join(b.artifacts, 'b.sqlite'),
    sourceId: getInstanceIdentity(b.db).instanceId, approvalId: 'approved', adminContext: b.adminContext });
  assert.equal(bBackup.verify(bResult).ok, true);
  const sourceA = getInstanceIdentity(a.db).instanceId;
  for (const sourceId of [bResult.manifest.sourceId, sourceA]) {
    const path = join(a.artifacts, `${randomUUID()}.sqlite`);
    const { copyFileSync } = await import('node:fs');
    copyFileSync(bResult.backupPath, path);
    const manifest = { ...bResult.manifest, sourceId };
    writeFileSync(`${path}.manifest.json`, JSON.stringify(manifest));
    assert.equal(createImBackup({ db: a.db }).verify({ backupPath: path, manifestPath: `${path}.manifest.json` }).ok, true);
    assert.equal(a.registry.registerPublishedBackup, undefined);
    // This copied foreign artifact is not a registered publication in A. Supply
    // complete, actually computed expected evidence rather than reading a
    // nonexistent publisher artifactReference from the raw backup result.
    const foreignExpected = { instanceId: sourceA, instanceCreatedAt: getInstanceIdentity(a.db).createdAt,
      registrationGeneration: 1, fileHash: manifest.fileHash,
      manifestHash: createHash('sha256').update(readFileSync(`${path}.manifest.json`)).digest('hex'),
      schemaVersion: manifest.schemaVersion, schemaChecksum: manifest.schemaChecksum };
    assert.throws(() => a.registry.resolveForMigration({ backupId: manifest.backupId, expected: foreignExpected }), denied('REGISTRY_NOT_FOUND'));
    const publish = () => a.services.publisher.publish({ adminContext: a.adminContext, approvalId: 'approved',
      artifactReference: `artifacts/${path.split(/[\\/]/).at(-1)}`, destinationPath: path,
      backupId: manifest.backupId, fileHash: manifest.fileHash, sourceId, instanceId: sourceId });
    if (process.platform === 'win32') {
      await assert.rejects(publish(), denied('BACKUP_DURABILITY_UNAVAILABLE'));
      assert.throws(() => a.registry.resolveForMigration({ backupId: manifest.backupId, expected: foreignExpected }), denied('REGISTRY_NOT_FOUND'));
      continue;
    }
    const issued = await publish();
    assert.notEqual(issued.backupId, manifest.backupId);
    assert.equal(issued.manifest.sourceId, sourceA);
    assert.equal(a.registry.resolveForMigration({ backupId: issued.backupId, expected: expected(a, issued) }).publicationState, 'published');
    assert.throws(() => a.registry.resolveForMigration({ backupId: manifest.backupId, expected: foreignExpected }), denied('REGISTRY_NOT_FOUND'));
  }
  assert.equal(records(a).length, process.platform === 'win32' ? 0 : 2);
});

test('source identity and registry generation drift are rejected before snapshot', async t => {
  if (process.platform === 'win32') return t.skip('native registry unavailable on Windows');
  const f = fixture(); t.after(() => f.close());
  writeFileSync(join(f.dir, 'instance-1.json'), JSON.stringify({ recordVersion: 2, instanceId: randomUUID(), instanceCreatedAt: getInstanceIdentity(f.db).createdAt, dbLocation: 'different', registrationGeneration: 1 }), { mode: 0o600 });
  await assert.rejects(f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' }), denied('BACKUP_IDENTITY_MISMATCH'));
  writeFileSync(join(f.dir, 'instance-1.json'), JSON.stringify({ recordVersion: 2, instanceId: getInstanceIdentity(f.db).instanceId, instanceCreatedAt: getInstanceIdentity(f.db).createdAt, dbLocation: 'correct', registrationGeneration: 2 }), { mode: 0o600 });
  await assert.rejects(f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' }), denied('REGISTRY_UNTRUSTED_RECORD'));
  assert.deepEqual(records(f), []);
});

test('publisher-level timeout BUSY calls writer zero times before and after native backup drain', async t => {
  const f = fixture({ lowLevel: true }); t.after(() => f.close());
  let finish;
  const delayed = createImBackup({ db: f.db, authority: f.authority, backupTimeBudgetMs: 10,
    nativeBackup: async (db, path, options) => { await new Promise(resolve => { finish = resolve; }); return nativeBackup(db, path, options); } });
  let publications = 0;
  const writer = { registerInstance: () => ({ instanceId: getInstanceIdentity(f.db).instanceId,
    instanceCreatedAt: getInstanceIdentity(f.db).createdAt, registrationGeneration: 1 }),
    registerPublishedBackup: () => { publications++; throw Error('writer must not be called'); } };
  const registry = { getInstance: () => ({ instanceId: getInstanceIdentity(f.db).instanceId,
    instanceCreatedAt: getInstanceIdentity(f.db).createdAt, registrationGeneration: 1 }) };
  const publisher = createBackupPublisher({ db: f.db, registry, writer, artifactDirectory: f.artifacts,
    backup: delayed, authority: f.authority });
  const promise = publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' });
  await assert.rejects(promise, denied('BACKUP_BUSY'));
  assert.equal(publications, 0);
  assert.deepEqual(records(f), []);
  finish(); await delayed.drain();
  assert.equal(publications, 0);
  assert.deepEqual(records(f), []);
});

test('publisher copy identity rejects substituted B SQLite despite real content verify (both source labels)', async t => {
  const a = fixture({ lowLevel: true }), b = fixture({ lowLevel: true }); t.after(() => { a.close(); b.close(); });
  const real = createImBackup({ db: b.db, authority: b.authority, durability: process.platform === 'win32' ? 'best-effort' : 'strict' });
  const bResult = await real.backup({ destinationPath: join(b.artifacts, 'foreign.sqlite'),
    approvalId: 'approved', sourceId: getInstanceIdentity(b.db).instanceId, adminContext: b.adminContext });
  const sourceA = getInstanceIdentity(a.db).instanceId;
  for (const label of [bResult.manifest.sourceId, sourceA]) {
    const registry = { getInstance: () => ({ instanceId: sourceA,
      instanceCreatedAt: getInstanceIdentity(a.db).createdAt, registrationGeneration: 1 }) };
    let registrations = 0;
    const writer = { registerPublishedBackup() { registrations++; throw Error('must not register'); } };
    const backup = { ...real, backup: async ({ destinationPath }) => {
      const { copyFileSync } = await import('node:fs');
      copyFileSync(bResult.backupPath, destinationPath);
      const manifest = { ...bResult.manifest, sourceId: label };
      writeFileSync(`${destinationPath}.manifest.json`, JSON.stringify(manifest));
      assert.equal(real.verify({ backupPath: destinationPath, manifestPath: `${destinationPath}.manifest.json` }).ok, true);
      return { backupPath: destinationPath, manifestPath: `${destinationPath}.manifest.json`, manifest,
        durability: 'durable' }; // Windows test-double marker, not a real durability proof
    } };
    const publisher = createBackupPublisher({ db: a.db, registry, writer, backup,
      artifactDirectory: a.artifacts, authority: a.authority });
    await assert.rejects(publisher.publish({ adminContext: a.adminContext, approvalId: 'approved' }), denied('BACKUP_IDENTITY_MISMATCH'));
    assert.equal(registrations, 0);
  }
  assert.deepEqual(records(a), []);
});

test('real verify refuses corrupted business foreign key even after recomputing correct hashes', async t => {
  const f = fixture({ lowLevel: true }); t.after(() => f.close());
  const real = createImBackup({ db: f.db, authority: f.authority, durability: process.platform === 'win32' ? 'best-effort' : 'strict' });
  const backup = { ...real, backup: async input => {
    const result = await real.backup(input);
    const copy = new DatabaseSync(result.backupPath);
    copy.exec('PRAGMA foreign_keys=OFF');
    copy.exec("INSERT INTO im_credentials(credential_id,agent_id,secret_hash,created_at) VALUES ('orphan','missing','hash',1)");
    copy.close();
    const manifest = { ...result.manifest, fileHash: createHash('sha256').update(readFileSync(result.backupPath)).digest('hex') };
    writeFileSync(result.manifestPath, JSON.stringify(manifest));
    assert.equal(real.verify({ backupPath: result.backupPath, manifestPath: result.manifestPath }).ok, false);
    return { ...result, manifest, durability: 'durable' }; // TEST DOUBLE ONLY on Windows
  } };
  const id = getInstanceIdentity(f.db).instanceId;
  const registry = { getInstance: () => ({ instanceId: id,
    instanceCreatedAt: getInstanceIdentity(f.db).createdAt, registrationGeneration: 1 }) };
  const writer = { registerPublishedBackup() { assert.fail('real verifier must reject before registry write'); } };
  const publisher = createBackupPublisher({ db: f.db, registry, writer, artifactDirectory: f.artifacts, backup, authority: f.authority });
  await assert.rejects(publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' }), denied('BACKUP_VERIFY_FAILED'));
  assert.deepEqual(records(f), []);
});

test('copied createdAt mismatch and source identity drift refuse publication', async t => {
  const f = fixture({ lowLevel: true }); t.after(() => f.close());
  const real = createImBackup({ db: f.db, authority: f.authority, durability: process.platform === 'win32' ? 'best-effort' : 'strict' });
  const id = getInstanceIdentity(f.db).instanceId;
  const registry = { getInstance: () => ({ instanceId: id,
    instanceCreatedAt: getInstanceIdentity(f.db).createdAt, registrationGeneration: 1 }) };
  const writer = { registerPublishedBackup() { assert.fail('identity mismatch before registration'); } };
  for (const target of ['copy', 'source']) {
    const backup = { ...real, backup: async input => {
      const result = await real.backup(input);
      const modified = target === 'copy' ? new DatabaseSync(result.backupPath) : f.db;
      modified.prepare('UPDATE im_instance_identity SET created_at=created_at+1').run();
      if (target === 'copy') modified.close();
      if (target === 'copy') {
        const manifest = { ...result.manifest, fileHash: createHash('sha256').update(readFileSync(result.backupPath)).digest('hex') };
        writeFileSync(result.manifestPath, JSON.stringify(manifest));
      }
      return { ...result, durability: 'durable' }; // TEST DOUBLE ONLY on Windows
    } };
    const publisher = createBackupPublisher({ db: f.db, registry, writer, artifactDirectory: f.artifacts, backup, authority: f.authority });
    await assert.rejects(publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' }), denied('BACKUP_IDENTITY_MISMATCH'));
  }
  assert.deepEqual(records(f), []);
});
