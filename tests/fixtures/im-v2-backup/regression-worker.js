import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import { join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { syncBuiltinESMExports } from 'node:module';
import { createBackupRegistry, withProtectedBackupCopy } from '../../../src/im/backup-registry.js';
import { createImV2Backup } from '../../../src/im/v2/backup.js';
import { createImV2BackupRegistry, createTrustedImV2BackupServices } from '../../../src/im/v2/backup-registry.js';
import { fixture, context } from './helpers.js';
import { legacyPublished } from './legacy-published.js';

const busy = { code: 'RECOVERY_BUSY' };
const uncertain = { code: 'RECOVERY_DURABILITY_UNCERTAIN' };
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;

function wrapFs(replacements) {
  const originals = Object.fromEntries(Object.keys(replacements).map(key => [key, fs[key]]));
  for (const [key, factory] of Object.entries(replacements)) fs[key] = factory(originals[key]);
  syncBuiltinESMExports();
  return () => { Object.assign(fs, originals); syncBuiltinESMExports(); };
}

async function callbacks(t, generation, observeRejections) {
  const f = fixture(t, { v3: generation === 'old' });
  let enter, acquire;
  if (generation === 'old') {
    const { old, oldRoot, oldAuthority, output } = await legacyPublished(t, f);
    enter = callback => withProtectedBackupCopy(old.registry, { backupId: output.backupId, adminContext: context }, callback);
    acquire = () => createBackupRegistry({ dir: oldRoot, authority: oldAuthority }).getInstance();
  } else {
    const services = createTrustedImV2BackupServices(f.options);
    const { record } = await services.publisher.publish({ approvalRef: 'test-approved' }, context);
    await services.publisher.drain();
    enter = callback => services.registry.withVerifiedBackup({ backupId: record.backupId }, context, callback);
    acquire = () => createImV2BackupRegistry(f.options).verify({ backupId: record.backupId }, context);
  }
  const unhandled = [];
  if (observeRejections) process.on('unhandledRejection', reason => unhandled.push(reason));
  let prefix = 0, stale, bytes = 0;
  assert.throws(() => enter(async () => { prefix++; }));
  assert.equal(prefix, 0, 'outer AsyncFunction prefix must not execute');
  enter(proof => {
    stale = proof.copyTo;
    assert.throws(() => proof.copyTo(async () => { prefix++; }));
    assert.equal(prefix, 0, 'copy AsyncFunction prefix must not execute');
    proof.copyTo(chunk => { bytes += chunk.length; });
  });
  assert.ok(bytes > 0, 'legitimate synchronous sink receives actual bytes');
  assert.throws(() => stale(() => {}));
  assert.throws(() => enter(proof => proof.copyTo(() => Promise.reject(Error('synthetic sink rejection')))));
  acquire();
  assert.throws(() => enter(() => Promise.reject(Error('synthetic outer rejection'))));
  acquire();
  const sinkError = Error('synthetic sink throw');
  assert.throws(() => enter(proof => proof.copyTo(() => { throw sinkError; })), error => error === sinkError);
  acquire(); // Real next acquisition, not merely absence of a lockfile.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  return { prefix, bytes, rejectionObserver: observeRejections };
}

async function durability(t, kind) {
  const f = fixture(t), services = createTrustedImV2BackupServices(f.options);
  const { record } = await services.publisher.publish({ approvalRef: 'test-approved' }, context);
  await services.publisher.drain();
  const holds = join(f.registryRoot, 'registry/holds'), directory = fs.lstatSync(holds);
  const input = { backupId: record.backupId, recoveryRunId: randomUUID(), stageHash: 'a'.repeat(64) };
  const hold = kind === 'binding' ? services.registry.createStageHold(input, context) : null;
  const bindingInput = hold && { holdId: hold.holdId, preparePlanHash: 'b'.repeat(64) };
  const invoke = registry => kind === 'binding' ? registry.bindPrepareHold(bindingInput, context) : registry.createStageHold(input, context);
  let failSync = true, linked = 0, unlinked = 0, failedSyncs = 0, successfulSyncs = 0;
  const restore = wrapFs({
    linkSync: real => (...args) => { const result = real(...args); if (dirname(args[1]) === holds) linked++; return result; },
    unlinkSync: real => (...args) => { const result = real(...args); if (dirname(args[0]) === holds) unlinked++; return result; },
    fsyncSync: real => fd => {
      const result = real(fd); // Fault is AFTER the actual syscall and final link/unlink.
      if (sameInode(fs.fstatSync(fd), directory)) {
        if (failSync) { failedSyncs++; throw Error('synthetic hold-directory sync failure'); }
        successfulSyncs++;
      }
      return result;
    },
  });
  try {
    assert.throws(() => invoke(services.registry), uncertain);
    assert.equal(linked, 1); assert.equal(unlinked, 1); assert.equal(failedSyncs, 1);
    const names = fs.readdirSync(holds).sort();
    const filename = kind === 'binding' ? `${hold.holdId}.binding.json` : names.find(name => /^[0-9a-f-]{36}\.json$/.test(name));
    assert.ok(filename, 'published final evidence stays present after failed directory sync');
    const path = join(holds, filename), bytes = fs.readFileSync(path), original = JSON.parse(bytes);
    const identity = fs.lstatSync(path);
    assert.equal(identity.nlink, 1);
    assert.throws(() => invoke(services.registry), uncertain);
    const reopened = createImV2BackupRegistry(f.options);
    assert.throws(() => invoke(reopened), uncertain);
    assert.equal(failedSyncs, 3, 'each retry must attempt directory resynchronization');
    assert.ok(fs.readFileSync(path).equals(bytes));
    assert.deepEqual(fs.readdirSync(holds).sort(), names);
    failSync = false;
    assert.deepEqual(invoke(createImV2BackupRegistry(f.options)), original);
    assert.ok(successfulSyncs > 0);
    assert.ok(fs.readFileSync(path).equals(bytes));
    assert.ok(sameInode(identity, fs.lstatSync(path)), 'retry preserves original final inode');
    assert.deepEqual(fs.readdirSync(holds).sort(), names);
    assert.equal(linked, 1); assert.equal(unlinked, 1);
    if (kind === 'binding') assert.throws(() => reopened.bindPrepareHold({ ...bindingInput, preparePlanHash: 'c'.repeat(64) }, context));
    return { linked, unlinked, failedSyncs, successfulSyncs };
  } finally { restore(); }
}

async function budgets(t, mode) {
  const f = fixture(t), services = createTrustedImV2BackupServices(f.options);
  const { record } = await services.publisher.publish({ approvalRef: 'test-approved' }, context);
  await services.publisher.drain();
  const path = join(f.registryRoot, record.artifactReference), identity = fs.lstatSync(path);
  const sourceBytes = fs.readFileSync(path);
  let reads = 0, eof = 0, elapsed = 0, advanced = false, fileDigests = 0;
  const originalCreateHash = crypto.createHash;
  crypto.createHash = (...args) => {
    const hash = originalCreateHash(...args), update = hash.update.bind(hash), digest = hash.digest.bind(hash);
    let bytes = 0;
    hash.update = (input, ...rest) => { bytes += Buffer.byteLength(input); update(input, ...rest); return hash; };
    hash.digest = (...rest) => {
      const result = digest(...rest);
      if (bytes === identity.size && ++fileDigests === 2 && mode === 'final-hash-time') {
        elapsed = 10001; advanced = true;
      }
      return result;
    };
    return hash;
  };
  const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  Object.defineProperty(performance, 'now', { configurable: true, value: () => elapsed });
  const restore = wrapFs({
    readSync: real => (...args) => {
      const result = real(...args);
      if (sameInode(fs.fstatSync(args[0]), identity)) {
        if (result) reads++;
        else eof++;
        if (mode === 'hash-time' && result) {
          elapsed = 10001; advanced = true;
        }
      }
      return result;
    },
    readFileSync: real => (...args) => {
      if (args[0] === path) reads++;
      return real(...args);
    },
  });
  try {
    if (mode === 'file-cap') {
      const limits = { maxFileBytes: identity.size - 1 };
      assert.throws(() => createImV2Backup({ ...f.options, limits }).verify({ backupId: record.backupId }), busy);
      assert.equal(reads, 0, 'oversized artifact refused before any heavy file read/hash');
      assert.throws(() => createImV2BackupRegistry({ ...f.options, limits }).verify({ backupId: record.backupId }, context), busy);
      assert.equal(reads, 0);
    } else if (mode === 'copy-time') {
      let chunks = 0;
      assert.throws(() => services.registry.withVerifiedBackup({ backupId: record.backupId }, context, proof => {
        proof.copyTo(() => { chunks++; elapsed = 10001; advanced = true; });
      }), busy);
      assert.equal(chunks, 1, 'stream must stop after the first over-budget sink chunk');
      assert.equal(advanced, true);
    } else {
      assert.throws(() => createImV2Backup(f.options).verify({ backupId: record.backupId }), busy);
      assert.equal(advanced, true, 'time advanced only after a genuine artifact read');
      assert.ok(reads > 0);
      if (mode === 'final-hash-time') {
        assert.equal(eof, 2, 'initial hash completed; final hash time must count');
        assert.equal(fileDigests, 2, 'elapsed time advances after the genuine final digest');
      }
    }
  } finally {
    restore();
    crypto.createHash = originalCreateHash; syncBuiltinESMExports();
    if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor); else delete performance.now;
  }
  assert.ok(fs.readFileSync(path).equals(sourceBytes));
  createImV2BackupRegistry(f.options).verify({ backupId: record.backupId }, context);
  return { reads, eof, advanced };
}

async function cleanupBudget(t, unrelated = false) {
  const f = fixture(t), services = createTrustedImV2BackupServices(f.options);
  const { record } = await services.publisher.publish({ approvalRef: 'test-approved' }, context);
  await services.publisher.drain();
  const other = unrelated ? await services.publisher.publish({ approvalRef: 'test-approved' }, context) : null;
  await services.publisher.drain();
  const path = join(f.registryRoot, record.artifactReference), identity = fs.lstatSync(path);
  const dirs = ['holds', 'releases'].map(name => join(f.registryRoot, 'registry', name));
  let bytesRead = 0, opened = 0, entries = 0;
  const restore = wrapFs({
    readSync: real => (...args) => { const n = real(...args); if (sameInode(fs.fstatSync(args[0]), identity)) bytesRead += n; return n; },
    readdirSync: real => (...args) => { assert.ok(!dirs.includes(args[0]), 'cleanup must not materialize metadata with readdirSync'); return real(...args); },
    opendirSync: real => (...args) => {
      const dir = real(...args);
      if (dirs.includes(args[0])) {
        opened++;
        const read = dir.readSync.bind(dir);
        dir.readSync = () => { const entry = read(); if (entry) entries++; return entry; };
      }
      return dir;
    },
  });
  try {
    assert.deepEqual(services.registry.checkCleanup({ backupId: record.backupId }, context), { allowed: false, reason: 'DISABLED' });
    const baseline = bytesRead; assert.ok(baseline > 0);
    for (let n = 0; n < 3; n++) services.registry.createStageHold({ backupId: other?.record.backupId ?? record.backupId,
      recoveryRunId: randomUUID(), stageHash: 'a'.repeat(64) }, context);
    bytesRead = 0;
    assert.equal(services.registry.checkCleanup({ backupId: record.backupId }, context).reason, unrelated ? 'DISABLED' : 'HOLD');
    assert.equal(bytesRead, baseline, 'multiple holds for the same backup must share one artifact verification');
    assert.ok(opened > 0);
    const limited = createImV2BackupRegistry({ ...f.options, limits: { maxMetadataEntries: 2 } });
    entries = 0;
    assert.throws(() => limited.checkCleanup({ backupId: record.backupId }, context), busy);
    assert.ok(entries <= 3, 'stream stops at the first entry above its cap');
    if (unrelated) {
      // Entries owned by this directory cannot be silently filtered out merely
      // because their names are unrelated to the requested backup.
      fs.writeFileSync(join(dirs[1], 'unrelated-owned-entry.txt'), 'synthetic', { mode: 0o600 });
      assert.throws(() => services.registry.checkCleanup({ backupId: record.backupId }, context));
    }
  } finally { restore(); }
  return { opened, entries };
}

async function importBudget(t) {
  const f = fixture(t, { v3: true }), old = await legacyPublished(t, f);
  const bytes = fs.readFileSync(old.artifact), identity = fs.lstatSync(old.artifact);
  const services = createTrustedImV2BackupServices({ ...f.options, limits: { maxFileBytes: bytes.length - 1 } });
  let reads = 0;
  const restore = wrapFs({
    readSync: real => (...args) => {
      if (sameInode(fs.fstatSync(args[0]), identity)) reads++;
      return real(...args);
    },
    readFileSync: real => (...args) => { if (args[0] === old.artifact) reads++; return real(...args); },
  });
  try {
    assert.throws(() => services.publisher.importRegisteredV3({ sourceRegistry: old.old.registry, backupId: old.output.backupId }, context), busy);
    assert.equal(reads, 0, 'lowered P5 cap must reach the authenticated bridge before heavy source hashing');
  } finally { restore(); }
  assert.ok(fs.readFileSync(old.artifact).equals(bytes));
  assert.deepEqual(fs.readdirSync(join(f.registryRoot, 'registry/records')), []);
  createBackupRegistry({ dir: old.oldRoot, authority: old.oldAuthority }).getInstance();
  return { reads };
}

const cleanup = [];
const t = { after: callback => cleanup.push(callback) };
process.once('message', async message => {
  if (message.phase !== 'go') throw Error('expected go phase');
  let result;
  try {
    const { mode, rejectionObserver } = message;
    if (mode.startsWith('callbacks-')) result = await callbacks(t, mode.slice('callbacks-'.length), rejectionObserver);
    else if (mode.startsWith('durability-')) result = await durability(t, mode.slice('durability-'.length));
    else if (mode === 'cleanup-budget' || mode === 'cleanup-unrelated') result = await cleanupBudget(t, mode === 'cleanup-unrelated');
    else if (mode === 'import-file-cap') result = await importBudget(t);
    else result = await budgets(t, mode);
    for (const callback of cleanup.reverse()) await callback();
    process.send({ phase: 'complete', ...result }, () => process.disconnect());
  } catch (error) {
    // Synthetic fixtures only. Failure retains directories, and no error is
    // mistaken for child exit by the parent harness.
    process.send({ phase: 'failure', code: error.code ?? 'TEST_FAILURE', message: error.message, stack: error.stack }, () => {
      process.exitCode = 1; process.disconnect();
    });
  }
});
process.send({ phase: 'ready' });
