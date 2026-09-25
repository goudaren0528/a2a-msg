import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createBackupRegistry, createTrustedBackupServices } from '../src/im/backup-registry.js';
import * as registryModule from '../src/im/backup-registry.js';
import * as publisherModule from '../src/im/backup-publisher.js';
import { createAdminAuthority } from '../src/im/keystore.js';
import { createImBackup } from '../src/im/backup.js';
import { getInstanceIdentity, initInstanceIdentity, migrateImSchemaV3 } from '../src/im/schema.js';
import { isolated } from './fixtures/im-v2-backup/isolated.js';

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
  db.exec('PRAGMA foreign_keys=ON'); migrateImSchemaV3(db); initInstanceIdentity(db);
  const services = createTrustedBackupServices({ db, dir, authority, platform });
  return { root, dir, db, authority, adminContext, services, ...services, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const expected = (f, output) => ({ instanceId: getInstanceIdentity(f.db).instanceId,
  instanceCreatedAt: getInstanceIdentity(f.db).createdAt, registrationGeneration: 1,
  fileHash: output.manifest.fileHash, manifestHash: createHash('sha256').update(readFileSync(join(f.dir, output.artifactReference + '.manifest.json'))).digest('hex'),
  schemaVersion: output.manifest.schemaVersion, schemaChecksum: output.manifest.schemaChecksum });
const onWindows = process.platform === 'win32';

function trackedWorker(child) {
  const tracked = { child, settled: false, errors: [] };
  child.on('error', error => tracked.errors.push(error));
  tracked.exit = new Promise(resolve => {
    const done = (code, signal) => {
      if (!tracked.settled) { tracked.settled = true; resolve({ code, signal }); }
    };
    child.once('exit', done);
    child.once('close', done); // failed spawn may have no exit, but still closes
  });
  return tracked;
}

function boundedWorkerExit(tracked, timeoutMs) {
  let timer;
  return Promise.race([tracked.exit.then(outcome => ({ confirmed: true, outcome })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ confirmed: false }), timeoutMs); })])
    .finally(() => clearTimeout(timer));
}

async function stopWorkers(children, timeoutMs = 2000) {
  const results = await Promise.allSettled(children.map(async tracked => {
    if (!tracked.settled) tracked.child.kill('SIGTERM');
    let result = await boundedWorkerExit(tracked, timeoutMs);
    if (!result.confirmed) {
      if (!tracked.settled) tracked.child.kill('SIGKILL');
      result = await boundedWorkerExit(tracked, timeoutMs);
    }
    if (!result.confirmed) throw Error(`owned worker exit unconfirmed (${tracked.errors.map(error => error.code).join(',')})`);
    return result.outcome;
  }));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'worker cleanup incomplete; retaining directory');
}

test('worker error alone never confirms exit or permits premature cleanup', async () => {
  const child = new EventEmitter();
  const signals = [];
  child.kill = signal => {
    signals.push(signal);
    if (signal === 'SIGTERM') child.emit('error', Object.assign(Error('kill failed'), { code: 'ESRCH' }));
    else child.emit('exit', null, signal);
  };
  const tracked = trackedWorker(child);
  child.emit('error', Error('IPC failure'));
  assert.equal(tracked.settled, false);
  await stopWorkers([tracked], 10);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(tracked.settled, true);
});

test('reader facade and trusted services return no general registration writer or artifact directory', t => {
  if (onWindows) return t.skip('native protected registry unsupported on Windows; test injection cannot bypass lock policy');
  const f = fixture(); t.after(() => f.close());
  assert.deepEqual(Reflect.ownKeys(f.services).sort(), ['publisher', 'registry']);
  assert.equal(Object.isFrozen(f.services), true);
  assert.deepEqual(Reflect.ownKeys(f.registry).sort(), ['cleanupBackup', 'getInstance', 'resolveForMigration', 'revokeBackup', 'withDiscoveredBackup', 'withVerifiedBackup']);
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
  assert.deepEqual(Reflect.ownKeys(registryModule).filter(key => typeof key === 'string').sort(), ['createBackupRegistry', 'createTrustedBackupServices', 'withProtectedBackupCopy']);
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
  if (onWindows) return t.skip('native registry unavailable on Windows');
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
   assert.throws(() => f.registry.resolveForMigration({ backupId, expected: { ...oldWriteArgs,
     instanceCreatedAt: getInstanceIdentity(f.db).createdAt } }), denied('REGISTRY_NOT_FOUND'));
  assert.equal(readdirSync(f.dir).some(name => name.startsWith('backup-')), false);
});

test('real published record retains resolution and revocation', { skip: onWindows }, async t => {
  const f = fixture(); t.after(() => f.close());
  const output = await f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' });
  assert.equal(f.registry.resolveForMigration({ backupId: output.backupId, expected: expected(f, output) }).publicationState, 'published');
  assert.deepEqual(f.registry.getInstance(), { instanceId: getInstanceIdentity(f.db).instanceId,
    instanceCreatedAt: getInstanceIdentity(f.db).createdAt, registrationGeneration: 1 });
  const evidence = f.registry.withVerifiedBackup({ backupId: output.backupId, expected: expected(f, output) }, proof => {
    assert.equal(proof.backupId, output.backupId);
    assert.equal(proof.recheck().fileHash, proof.fileHash);
    return proof;
  });
  assert.throws(() => evidence.recheck(), denied('REGISTRY_USE_EXPIRED'));
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

test('separate facade cannot revoke while verified callback holds lock', { skip: onWindows }, async t => {
  const f = fixture(); t.after(() => f.close());
  const output = await f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' });
  const other = createBackupRegistry({ dir: f.dir, authority: f.authority, platform });
  f.registry.withVerifiedBackup({ backupId: output.backupId, expected: expected(f, output) }, () => {
    assert.throws(() => other.revokeBackup({ backupId: output.backupId, adminContext: f.adminContext }), denied('REGISTRY_BUSY'));
  });
  const registeredIdentity = f.registry.getInstance();
  f.registry.withDiscoveredBackup({ backupId: output.backupId, expectedIdentity: registeredIdentity }, () => {
    assert.throws(() => other.revokeBackup({ backupId: output.backupId, adminContext: f.adminContext }), denied('REGISTRY_BUSY'));
  });
  other.revokeBackup({ backupId: output.backupId, adminContext: f.adminContext });
  assert.throws(() => other.resolveForMigration({ backupId: output.backupId, expected: expected(f, output) }), denied('REGISTRY_REVOKED'));
});

test('native Windows registry remains fail closed', { skip: !onWindows }, t => {
  const root = mkdtempSync(join(tmpdir(), 'registry-windows-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => createBackupRegistry({ dir: root }), denied('REGISTRY_PERMISSION_UNVERIFIED'));
  assert.throws(() => createTrustedBackupServices({ dir: root, platform }), denied('REGISTRY_PERMISSION_UNVERIFIED'));
});

test('legacy genuine protected-copy rejects async prefixes and consumes rejected sink/outer promises',
  { skip: onWindows, timeout: 30000 }, async () => {
    await isolated('callbacks-old');
    await isolated('callbacks-old', { rejectionObserver: true });
  });

test('caller cannot request duplicate backupId; pre-existing record untouched and duplicate revocation refused', async t => {
  if (onWindows) return t.skip('native registry unavailable on Windows');
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
  if (onWindows) return t.skip('native registry unavailable on Windows');
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
     registrationGeneration: 1, fileHash: manifest.fileHash, manifestHash: 'a'.repeat(64), schemaVersion: 2, schemaChecksum: manifest.schemaChecksum } }), denied('REGISTRY_INVALID_INPUT'));
});

test('v1 instance record never becomes eligible through reopening or trusted publisher', { skip: onWindows }, async t => {
  const f = fixture(); t.after(() => f.close());
  const published = await f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' });
  const identity = getInstanceIdentity(f.db);
  rmSync(join(f.dir, 'instance-1.json'));
  writeFileSync(join(f.dir, 'instance-1.json'), JSON.stringify({ recordVersion: 1,
    instanceId: identity.instanceId, dbLocation: join(f.root, 'source.sqlite'), registrationGeneration: 1 }), { mode: 0o600 });
  assert.throws(() => f.registry.getInstance(), denied('REGISTRY_UNTRUSTED_RECORD'));
  assert.throws(() => createBackupRegistry({ dir: f.dir }).getInstance(), denied('REGISTRY_UNTRUSTED_RECORD'));
  assert.throws(() => f.registry.withDiscoveredBackup({ backupId: published.backupId, expectedIdentity: {
    instanceId: identity.instanceId, instanceCreatedAt: identity.createdAt, registrationGeneration: 1 } }, () => {}),
    denied('REGISTRY_UNTRUSTED_RECORD'));
  await assert.rejects(f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' }), denied('REGISTRY_UNTRUSTED_RECORD'));
});

test('thenable and throwing callbacks release cross-process lock', { skip: onWindows }, async t => {
  const f = fixture(); t.after(() => f.close());
  const output = await f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' });
  const input = { backupId: output.backupId, expected: expected(f, output) };
  assert.throws(() => f.registry.withVerifiedBackup(input, () => Promise.resolve()), denied('REGISTRY_ASYNC_CALLBACK'));
  let calls = 0;
  assert.throws(() => f.registry.withVerifiedBackup(input, async () => { calls++; }), denied('REGISTRY_ASYNC_CALLBACK'));
  assert.equal(calls, 0);
  assert.throws(() => f.registry.withVerifiedBackup(input, () => { throw Error('callback fault'); }), /callback fault/);
  f.registry.revokeBackup({ backupId: output.backupId, adminContext: f.adminContext });
});

test('metadata-only recheck uses frozen target and rejects changed registry metadata', { skip: onWindows }, async t => {
  const f = fixture(); t.after(() => f.close());
  const output = await f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' });
  const input = { backupId: output.backupId, expected: { ...expected(f, output), manifestHash: '0'.repeat(64) } };
  assert.throws(() => f.registry.withVerifiedBackup(input, () => {}), denied('REGISTRY_HASH_MISMATCH'));
  input.expected.manifestHash = expected(f, output).manifestHash;
  f.registry.withVerifiedBackup(input, evidence => {
    input.backupId = randomUUID(); input.expected.instanceId = randomUUID();
    f.db.exec('BEGIN IMMEDIATE');
    try { assert.equal(evidence.recheck().backupId, output.backupId); }
    finally { f.db.exec('ROLLBACK'); }
    writeFileSync(join(f.dir, `revoked-${output.backupId}.json`), JSON.stringify({ recordVersion: 1,
      backupId: output.backupId, revokedAt: 1 }), { mode: 0o600 });
    assert.throws(() => evidence.recheck(), denied('REGISTRY_REVOKED'));
    rmSync(join(f.dir, `revoked-${output.backupId}.json`)); // isolated adversarial mutation only
    const name = join(f.dir, `backup-${output.backupId}.json`);
    const altered = JSON.parse(readFileSync(name, 'utf8'));
    altered.schemaChecksum = '0'.repeat(64);
    writeFileSync(name, JSON.stringify(altered));
    assert.throws(() => evidence.recheck(), denied('REGISTRY_SCHEMA_MISMATCH'));
  });
});

test('discovery binds a protected registered backup and strict use requires all approved evidence', { skip: onWindows }, async t => {
  const f = fixture(); t.after(() => f.close());
  const output = await f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' });
  const identity = f.registry.getInstance();
  const input = { backupId: output.backupId, expectedIdentity: { ...identity } };
  let scoped;
  const found = f.registry.withDiscoveredBackup(input, proof => {
    assert.equal(Object.isFrozen(proof), true);
    assert.deepEqual(Object.keys(proof).sort(), ['backupId', 'fileHash', 'instanceCreatedAt', 'instanceId',
      'manifestHash', 'recheck', 'registrationGeneration', 'schemaChecksum', 'schemaVersion']);
    input.backupId = randomUUID(); input.expectedIdentity.instanceId = randomUUID();
    scoped = proof.recheck;
    f.db.exec('BEGIN IMMEDIATE');
    try { assert.equal(proof.recheck().manifestHash, proof.manifestHash); }
    finally { f.db.exec('ROLLBACK'); }
    return { ...proof };
  });
  assert.throws(scoped, denied('REGISTRY_USE_EXPIRED'));
  assert.equal(found.manifestHash, expected(f, output).manifestHash);
  const strict = { backupId: output.backupId, expected: { ...found } };
  assert.equal(f.registry.withVerifiedBackup(strict, proof => proof.fileHash), found.fileHash);
  for (const field of ['instanceId', 'instanceCreatedAt', 'registrationGeneration', 'fileHash', 'manifestHash', 'schemaVersion', 'schemaChecksum']) {
    const incomplete = { ...strict.expected }; delete incomplete[field];
    assert.throws(() => f.registry.withVerifiedBackup({ ...strict, expected: incomplete }, () => assert.fail('callback ran')),
      denied('REGISTRY_INVALID_INPUT'), field);
    assert.throws(() => f.registry.resolveForMigration({ ...strict, expected: incomplete }), denied('REGISTRY_INVALID_INPUT'), field);
  }
  const invalidValues = {
    fileHash: [null, undefined, 1, new String(found.fileHash), [], '0'.repeat(63), 'g'.repeat(64)],
    manifestHash: [null, undefined, 1, new String(found.manifestHash), [], '0'.repeat(63), 'g'.repeat(64)],
    schemaVersion: [null, undefined, '2', new Number(found.schemaVersion), [], 0, -1, 1.5],
    schemaChecksum: [null, undefined, 1, new String(found.schemaChecksum), [], '0'.repeat(63), 'g'.repeat(64)],
  };
  for (const [field, values] of Object.entries(invalidValues)) {
    for (const value of values) {
      const malformed = { ...strict, expected: { ...strict.expected, [field]: value } };
      let callbacks = 0;
      assert.throws(() => f.registry.withVerifiedBackup(malformed, () => { callbacks++; }),
        denied('REGISTRY_INVALID_INPUT'), `${field}: ${typeof value} ${Object.prototype.toString.call(value)} ${String(value)}`);
      assert.equal(callbacks, 0, field);
      assert.throws(() => f.registry.resolveForMigration(malformed), denied('REGISTRY_INVALID_INPUT'), field);
    }
  }
  for (const field of ['fileHash', 'manifestHash', 'schemaChecksum']) {
    const mismatch = { ...strict.expected, [field]: '0'.repeat(64) };
    assert.throws(() => f.registry.withVerifiedBackup({ ...strict, expected: mismatch }, () => assert.fail('callback ran')));
  }
  for (const expectedIdentity of [undefined, { ...identity, registrationGeneration: '1' },
    { ...identity, registrationGeneration: 2 }, { ...identity, instanceId: randomUUID() },
    { ...identity, instanceCreatedAt: identity.instanceCreatedAt + 1 }]) {
    assert.throws(() => f.registry.withDiscoveredBackup({ backupId: output.backupId, expectedIdentity },
      () => assert.fail('callback ran')));
  }
  assert.throws(() => f.registry.withDiscoveredBackup({ backupId: randomUUID(), expectedIdentity: identity }, () => {}),
    denied('REGISTRY_NOT_FOUND'));
  let called = 0;
  assert.throws(() => f.registry.withDiscoveredBackup({ backupId: output.backupId, expectedIdentity: identity }, async () => { called++; }),
    denied('REGISTRY_ASYNC_CALLBACK'));
  assert.equal(called, 0);
  assert.throws(() => f.registry.withDiscoveredBackup({ backupId: output.backupId, expectedIdentity: identity }, () => Promise.resolve()),
    denied('REGISTRY_ASYNC_CALLBACK'));
  assert.throws(() => f.registry.withDiscoveredBackup({ backupId: output.backupId, expectedIdentity: identity }, () => { throw false; }),
    value => value === false);
  f.registry.revokeBackup({ backupId: output.backupId, adminContext: f.adminContext });
  assert.throws(() => f.registry.withDiscoveredBackup({ backupId: output.backupId, expectedIdentity: identity }, () => {}),
    denied('REGISTRY_REVOKED'));
});

test('discovery never calls back on corrupted artifact, manifest, copied identity or foreign key',
  { skip: onWindows }, async t => {
    for (const corruption of ['artifact', 'manifest', 'identity', 'foreign-key']) {
      const f = fixture(); t.after(() => f.close());
      const output = await f.publisher.publish({ adminContext: f.adminContext, approvalId: 'approved' });
      const path = join(f.dir, output.artifactReference), identity = f.registry.getInstance();
      if (corruption === 'artifact') writeFileSync(path, 'corrupt');
      if (corruption === 'manifest') writeFileSync(`${path}.manifest.json`, '{}');
      // An independently modified copied DB cannot be used even if a caller supplies a plausible backupId.
      if (corruption === 'identity' || corruption === 'foreign-key') {
        const copy = new DatabaseSync(path);
        try {
          if (corruption === 'identity') copy.prepare('UPDATE im_instance_identity SET instance_id=?').run(randomUUID());
          else {
            copy.exec('PRAGMA foreign_keys=OFF');
            copy.prepare("INSERT INTO im_credentials(credential_id,agent_id,secret_hash,created_at) VALUES ('orphan','absent','hash',1)").run();
          }
        } finally { copy.close(); }
        const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
        const manifestPath = `${path}.manifest.json`;
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        manifest.fileHash = digest(path);
        writeFileSync(manifestPath, JSON.stringify(manifest));
        const recordPath = join(f.dir, `backup-${output.backupId}.json`);
        const record = JSON.parse(readFileSync(recordPath, 'utf8'));
        record.fileHash = manifest.fileHash;
        record.manifestHash = digest(manifestPath);
        writeFileSync(recordPath, JSON.stringify(record));
      }
      let callbacks = 0;
      assert.throws(() => f.registry.withDiscoveredBackup({ backupId: output.backupId, expectedIdentity: identity },
        () => { callbacks++; }), /REGISTRY_/);
      assert.equal(callbacks, 0, corruption);
    }
  });

test('separate process publishes then exits; fresh process discovers from ID and live identity only',
  { skip: onWindows, timeout: 20000 }, async t => {
    const f = fixture();
    const children = [];
    t.after(async () => {
      await stopWorkers(children);
      f.close();
    });
    async function worker(mode, extra = '') {
      const child = fork(new URL('./fixtures/im-backup-registry/discover.js', import.meta.url),
        [mode, f.root, f.dir, extra], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const tracked = trackedWorker(child);
      children.push(tracked);
      const message = new Promise((resolve, reject) => {
        const onMessage = value => { clear(); resolve(value); };
        const onError = error => { clear(); reject(error); };
        const clear = () => { child.off('message', onMessage); child.off('error', onError); };
        child.on('message', onMessage); child.on('error', onError);
        void tracked.exit.then(() => { clear(); reject(Error('worker exited before IPC')); });
      });
      let timer;
      try {
        const value = await Promise.race([message, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('worker IPC timeout')), 5000); })]);
        const ended = await boundedWorkerExit(tracked, 5000);
        assert.equal(ended.confirmed, true, 'worker exit timeout');
        assert.deepEqual(ended.outcome, { code: 0, signal: null });
        if (value.error) throw Error(value.error);
        return value;
      } finally { clearTimeout(timer); }
    }
    const published = await worker('publish');
    const discovered = await worker('discover', published.backupId);
    assert.equal(discovered.backupId, published.backupId);
    assert.equal(discovered.fileHash, published.fileHash);
    assert.equal(discovered.manifestHash, expected(f, { artifactReference: published.artifactReference,
      manifest: { fileHash: published.fileHash, schemaVersion: discovered.schemaVersion,
        schemaChecksum: discovered.schemaChecksum } }).manifestHash);
  });
