import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, chmodSync, lstatSync, writeFileSync, readFileSync, symlinkSync, linkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { createBackupRegistry, createTrustedBackupServices } from '../src/im/backup-registry.js';
import { createRegistryLock } from '../src/im/registry-lock.js';
import { getInstanceIdentity, initInstanceIdentity, migrateImSchemaV3 } from '../src/im/schema.js';

const unix = process.platform !== 'win32';
const forkTimeoutMs = 5000;

function trackedFork(script, args, children) {
  const child = fork(script, args, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  // Register immediately, before any IPC waiter can observe a fast exit.
  const tracked = { child, settled: false, errors: [] };
  child.on('error', error => tracked.errors.push(error)); // also protects cleanup-time kill errors
  const exit = new Promise(resolve => {
    const done = (code, signal) => {
      if (!tracked.settled) { tracked.settled = true; resolve({ code, signal }); }
    };
    child.once('exit', done);
    // A failed spawn has no exit event, but still emits close once no child exists.
    child.once('close', done);
  });
  tracked.exit = exit;
  children.push(tracked);
  return tracked;
}

function expectMessage(tracked, accepted, label) {
  const { child, exit } = tracked;
  return new Promise((resolve, reject) => {
    let timer;
    const clear = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
    };
    const onMessage = message => {
      clear();
      if (accepted.includes(message)) resolve(message);
      else reject(Error(`${label}: unexpected IPC ${String(message)}`));
    };
    const onError = error => { clear(); reject(error); };
    child.on('message', onMessage);
    child.on('error', onError);
    // The exit promise was installed immediately at fork, so an already exited
    // child cannot leave this waiter hanging even if its exit event was missed.
    void exit.then(outcome => { clear(); reject(Error(`${label}: exited before IPC (${JSON.stringify(outcome)})`)); });
    timer = setTimeout(() => { clear(); reject(Error(`${label}: IPC timeout`)); }, forkTimeoutMs);
  });
}

function boundedExit(exit, timeoutMs) {
  let timer;
  return Promise.race([exit.then(outcome => ({ confirmed: true, outcome })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ confirmed: false }), timeoutMs); })])
    .finally(() => clearTimeout(timer));
}

async function stopChildren(children, { graceMs = forkTimeoutMs, killMs = forkTimeoutMs } = {}) {
  const results = await Promise.allSettled(children.map(async tracked => {
    const { child, exit } = tracked;
    if (!tracked.settled) child.kill('SIGTERM');
    let result = await boundedExit(exit, graceMs);
    if (!result.confirmed) {
      // Only the retained ChildProcess object can be signaled: never address a
      // numeric PID that might have been recycled.
      if (!tracked.settled) child.kill('SIGKILL');
      result = await boundedExit(exit, killMs);
    }
    if (!result.confirmed) throw Error(`owned child exit unconfirmed; retaining test directory (${tracked.errors.map(e => e.code).join(',')})`);
    return result.outcome;
  }));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'child cleanup incomplete');
  return results.map(result => result.value);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'registry-lock-')); chmodSync(root, 0o700);
  const dir = join(root, 'registry'); mkdirSync(dir, { mode: 0o700 }); mkdirSync(join(dir, 'artifacts'), { mode: 0o700 });
  const db = new DatabaseSync(join(root, 'source.sqlite'));
  db.exec('PRAGMA foreign_keys=ON'); migrateImSchemaV3(db); initInstanceIdentity(db);
  const children = [];
  t.after(async () => {
    await stopChildren(children);
    db.close(); rmSync(root, { recursive: true, force: true });
  });
  const authority = { authorizeAdmin: () => true, publicationActors: () => ({ executorActorId: 'executor', backupApproverId: 'approver' }) };
  return { root, dir, db, authority, children, ...createTrustedBackupServices({ db, dir, authority }) };
}

test('native lock file is private, stable and survives independent initialization', { skip: !unix }, t => {
  const f = fixture(t), path = join(f.dir, 'coordination.sqlite');
  const before = lstatSync(path);
  assert.equal(before.mode & 0o077, 0);
  assert.equal(before.nlink, 1);
  createBackupRegistry({ dir: f.dir });
  assert.equal(lstatSync(path).ino, before.ino);
});

test('lock callback throws all falsy values unchanged and releases', { skip: !unix }, t => {
  const f = fixture(t);
  const path = join(f.dir, 'coordination.sqlite');
  const platform = { privateDirectory: path => path, protectedPath: path => lstatSync(path),
    checkOpened: (path, before, opened) => assert.equal(before.ino, opened.ino), syncDirectory() {} };
  const lock = createRegistryLock(f.dir, platform);
  for (const value of [undefined, null, false, 0, '']) {
    let caught = Symbol('not thrown');
    try { lock.withLock(() => { throw value; }); } catch (error) { caught = error; }
    assert.equal(caught, value);
    assert.equal(createRegistryLock(f.dir, platform).withLock(() => 42), 42);
  }
  let calls = 0;
  assert.throws(() => lock.withLock(async () => { calls++; }), { code: 'REGISTRY_ASYNC_CALLBACK' });
  assert.equal(calls, 0);
  assert.throws(() => lock.withLock(() => Promise.resolve()), { code: 'REGISTRY_ASYNC_CALLBACK' });
  assert.equal(lstatSync(path).nlink, 1);
});

test('existing coordination file rejects unsafe mode, symlink, hardlink and invalid SQLite', { skip: !unix }, t => {
  const cases = [
    (path, root) => { writeFileSync(path, 'bad', { mode: 0o644 }); chmodSync(path, 0o644); },
    (path, root) => symlinkSync(join(root, 'other'), path),
    (path, root) => { writeFileSync(path, 'bad', { mode: 0o600 }); linkSync(path, join(root, 'other')); },
    path => writeFileSync(path, 'bad', { mode: 0o600 }),
  ];
  for (const mutate of cases) {
    const root = mkdtempSync(join(tmpdir(), 'registry-unsafe-')); chmodSync(root, 0o700);
    const dir = join(root, 'registry'); mkdirSync(dir, { mode: 0o700 });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(dir, 'coordination.sqlite'); mutate(path, root);
    assert.throws(() => createBackupRegistry({ dir }), /REGISTRY_/);
  }
});

test('existing coordination file refuses unsupported journal mode and user version', { skip: !unix }, t => {
  for (const pragma of ['PRAGMA user_version=3', 'PRAGMA journal_mode=WAL']) {
    const f = fixture(t), path = join(f.dir, 'coordination.sqlite');
    const db = new DatabaseSync(path);
    try { db.exec(pragma); } finally { db.close(); }
    assert.throws(() => createBackupRegistry({ dir: f.dir }).getInstance(), { code: 'REGISTRY_UNTRUSTED_PATH' });
  }
});

test('simultaneous first init from independent processes retains one coordination inode', { skip: !unix, timeout: 20000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'registry-first-init-')); chmodSync(root, 0o700);
  const dir = join(root, 'registry'); mkdirSync(dir, { mode: 0o700 });
  const children = [];
  t.after(async () => {
    await stopChildren(children);
    rmSync(root, { recursive: true, force: true });
  });
  const script = new URL('./fixtures/im-registry-lock/init.js', import.meta.url);
  const first = trackedFork(script, [dir], children);
  const second = trackedFork(script, [dir], children);
  await Promise.all([first, second].map(child => expectMessage(child, ['ready-to-start'], 'init barrier')));
  const resultsPending = [first, second].map(child => expectMessage(child,
    ['ready', 'REGISTRY_UNTRUSTED_PATH', 'REGISTRY_BUSY'], 'first init result'));
  first.child.send('go'); second.child.send('go');
  const results = await Promise.all(resultsPending);
  assert.ok(results.some(value => value === 'ready'));
  assert.ok(results.every(value => value === 'ready' || value === 'REGISTRY_UNTRUSTED_PATH' || value === 'REGISTRY_BUSY'));
  const path = join(dir, 'coordination.sqlite'), before = lstatSync(path);
  assert.equal(before.nlink, 1);
  createBackupRegistry({ dir });
  assert.equal(lstatSync(path).ino, before.ino);
});

test('native separate process lock releases upon holder death; revocation wins afterward', { skip: !unix, timeout: 20000 }, async t => {
  const f = fixture(t), output = await f.publisher.publish({ approvalId: 'approved' });
  const identity = getInstanceIdentity(f.db);
  const expected = { instanceId: identity.instanceId, instanceCreatedAt: identity.createdAt,
    registrationGeneration: 1, fileHash: output.manifest.fileHash,
    manifestHash: createHash('sha256').update(readFileSync(join(f.dir, output.artifactReference + '.manifest.json'))).digest('hex'),
    schemaVersion: output.manifest.schemaVersion, schemaChecksum: output.manifest.schemaChecksum };
  const holder = trackedFork(new URL('./fixtures/im-registry-lock/holder.js', import.meta.url),
    [f.dir, output.backupId, JSON.stringify(expected)], f.children);
  await expectMessage(holder, ['locked'], 'holder lock barrier');
  // After holder's second same-process facade has constructed and attempted
  // acquisition, an independent process must STILL find the OS lock held.
  const contender = trackedFork(new URL('./fixtures/im-registry-lock/check.js', import.meta.url),
    [f.dir, output.backupId, JSON.stringify(expected)], f.children);
  assert.equal(await expectMessage(contender, ['REGISTRY_BUSY'], 'independent contender after second facade'), 'REGISTRY_BUSY');
  for (const operation of [
    () => f.registry.revokeBackup({ backupId: output.backupId }),
    () => f.registry.cleanupBackup({ backupId: output.backupId }),
  ]) {
    const started = performance.now();
    assert.throws(operation, { code: 'REGISTRY_BUSY' });
    assert.ok(performance.now() - started < 1500, 'contention must fail fast, not wait for holder release');
  }
  holder.child.kill(); await stopChildren([holder]);
  f.registry.revokeBackup({ backupId: output.backupId });
  assert.throws(() => f.registry.withVerifiedBackup({ backupId: output.backupId, expected }, () => {}), { code: 'REGISTRY_REVOKED' });
  f.registry.cleanupBackup({ backupId: output.backupId });
});

test('normal callback return releases lock for a separate process', { skip: !unix, timeout: 20000 }, async t => {
  const f = fixture(t), output = await f.publisher.publish({ approvalId: 'approved' });
  const identity = getInstanceIdentity(f.db);
  const expected = { instanceId: identity.instanceId, instanceCreatedAt: identity.createdAt,
    registrationGeneration: 1, fileHash: output.manifest.fileHash,
    manifestHash: createHash('sha256').update(readFileSync(join(f.dir, output.artifactReference + '.manifest.json'))).digest('hex'),
    schemaVersion: output.manifest.schemaVersion, schemaChecksum: output.manifest.schemaChecksum };
  assert.equal(f.registry.withVerifiedBackup({ backupId: output.backupId, expected }, proof => proof.backupId), output.backupId);
  const child = trackedFork(new URL('./fixtures/im-registry-lock/check.js', import.meta.url),
    [f.dir, output.backupId, JSON.stringify(expected)], f.children);
  const result = await expectMessage(child, [output.backupId], 'other process lock acquisition');
  assert.equal(result, output.backupId);
});

test('owned SIGTERM-resistant child is SIGKILLed and confirmed exited before directory removal',
  { skip: !unix, timeout: 10000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'registry-escalation-')); chmodSync(root, 0o700);
    const children = [];
    let outcome;
    t.after(async () => {
      // A failed cleanup must retain the directory for diagnosis; do not delete
      // any path while the child could still be running.
      if (!outcome) [outcome] = await stopChildren(children, { graceMs: 100, killMs: 2000 });
      assert.equal(outcome.signal, 'SIGKILL');
      rmSync(root, { recursive: true, force: true });
    });
    const child = trackedFork(new URL('./fixtures/im-registry-lock/ignore-term.js', import.meta.url), [root], children);
    await expectMessage(child, ['ignoring-term'], 'SIGTERM-resistant child ready');
    [outcome] = await stopChildren(children, { graceMs: 100, killMs: 2000 });
    assert.deepEqual(outcome, { code: null, signal: 'SIGKILL' });
  });

test('lock preserves normal callback results and original errors', { skip: !unix }, t => {
  const f = fixture(t);
  const platform = { privateDirectory: path => path, protectedPath: path => lstatSync(path),
    checkOpened: (path, before, opened) => assert.equal(before.ino, opened.ino), syncDirectory() {} };
  const lock = createRegistryLock(f.dir, platform);
  assert.equal(lock.withLock(() => 'committed-by-caller'), 'committed-by-caller');
  assert.throws(() => lock.withLock(() => { throw Error('caller failure'); }), /caller failure/);
});
