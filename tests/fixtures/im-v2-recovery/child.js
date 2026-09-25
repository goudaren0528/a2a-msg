import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';

const send = message => process.send({ ...message, pid: process.pid });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const real = Object.fromEntries(['openSync', 'closeSync', 'fsyncSync', 'linkSync', 'unlinkSync', 'writeSync', 'mkdirSync'].map(key => [key, fs[key]]));
const native = Object.fromEntries(['exec', 'prepare', 'close'].map(key => [key, DatabaseSync.prototype[key]]));
let operation = 'startup', operationHash = null, readonly = false, target = null, descriptor, sequence = 0, state, worker;
const fds = new Map(), links = new Map(), syncs = [], readers = new Set(), starts = new WeakMap(), syncedFiles = new Set();
let readonlyViolations = 0;
function mutationCheck(condition, message) {
  if (!condition) { if (readonly) readonlyViolations++; assert.fail(message); }
}
let lastFileSync = null, committed = null, phaseHit = false;
const outcome = callback => { try { return { ok: true, value: callback() }; } catch (error) { return { ok: false, code: error?.code ?? 'UNEXPECTED_ERROR' }; } };
function pathOf(db) {
  return native.prepare.call(db, 'PRAGMA database_list').all().find(row => row.name === 'main')?.file;
}
function projection(db) {
  const has = name => !!native.prepare.call(db, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
  const one = table => has(table) ? native.prepare.call(db, `SELECT * FROM ${table}`).get() ?? null : null;
  const center = one('im_center_state');
  return { version: one('im_schema')?.version ?? null, mode: one('im_settings')?.write_mode ?? null,
    floor: one('im_clock')?.last_observed_at ?? null, center,
    run: has('im_recovery_runs') && center?.recovery_run_id
      ? native.prepare.call(db, 'SELECT * FROM im_recovery_runs WHERE run_id=?').get(center.recovery_run_id) : null,
    preparation: one('im_schema_preparations') };
}
function barrier(phase, evidence = {}) {
  if (target === null || phase !== target || phaseHit) return;
  phaseHit = true;
  send({ caseId: descriptor.caseId, phase, sequence: ++sequence, nativeCompleted: true, operation, operationHash, ...evidence });
  const deadline = performance.now() + 5000;
  while (Atomics.load(state, 0) < sequence) {
    assert.equal(Atomics.load(state, 1), 0, 'control pipe failed');
    const remaining = deadline - performance.now(); assert.ok(remaining > 0, 'bounded go timeout');
    Atomics.wait(state, 0, sequence - 1, remaining);
  }
}
function publicationPhase(path) {
  const name = basename(path), parent = dirname(path);
  if (parent === join(descriptor.registryRoot, 'registry/artifacts')) return name.endsWith('.sqlite') ? 'artifact' : name.endsWith('.manifest.json') ? 'manifest' : null;
  if (parent === join(descriptor.registryRoot, 'registry/records') && /^[a-f0-9-]{36}\.json$/.test(name)) return 'registry-record';
  if (parent === join(descriptor.registryRoot, 'registry/holds')) return name.endsWith('.binding.json') ? 'prepare-binding' : 'stage-hold';
  if (parent === join(descriptor.registryRoot, 'registry/releases')) return 'release-marker';
  if (parent === join(descriptor.workspace, 'requests') && name.endsWith('.json')) return 'locator';
  if (basename(parent) === 'seals') return 'seal';
  if (/^prepare-[a-f0-9]{64}\.json$/.test(name)) return 'prepare-plan';
  if (/^activation-[a-f0-9]{64}\.json$/.test(name)) return 'activation-plan';
  return ({ 'source-closed.json': 'source-closure', 'stage.json': 'stage', 'source-verified.sqlite': 'source-verified',
    'copy-intent.json': 'copy-intent', 'candidate.sqlite': 'candidate-publication', 'base.json': 'base',
    'normalization-intent.json': 'normalization-intent', 'normalized.json': 'normalized', 'staged.json': 'staged',
    'activation-complete.json': 'completion' })[name] ?? null;
}
function install() {
  fs.openSync = (...args) => {
    const path = String(args[0]), flags = args[1];
    const writing = typeof flags === 'number' ? !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC)) : /[wa+]/.test(flags);
    mutationCheck(!(readonly && writing && !path.endsWith('coordination.sqlite')), 'readonly status filesystem mutation');
    const fd = real.openSync(...args); fds.set(fd, { path, directory: fs.fstatSync(fd).isDirectory(), synced: false }); return fd;
  };
  fs.closeSync = fd => { const value = real.closeSync(fd); fds.delete(fd); return value; };
  fs.writeSync = (...args) => {
    mutationCheck(!readonly, 'readonly status write');
    const value = real.writeSync(...args), entry = fds.get(args[0]);
    if (entry?.path.endsWith('.pending') && fs.existsSync(join(dirname(entry.path), 'copy-intent.json')) &&
        !fs.existsSync(join(dirname(entry.path), 'candidate.sqlite')) && operation === 'stage') {
      const expected = JSON.parse(fs.readFileSync(join(dirname(entry.path), 'copy-intent.json')));
      const actual = fs.fstatSync(args[0]);
      const artifact = join(descriptor.registryRoot, 'registry/artifacts', `${descriptor.backupId}.sqlite`);
      if (descriptor.route !== 'closed-v3') {
        assert.ok(fs.existsSync(join(dirname(entry.path), 'hold.json')), 'durable hold before candidate copy');
        const hold = JSON.parse(fs.readFileSync(join(dirname(entry.path), 'hold.json')));
        assert.ok(fs.existsSync(join(descriptor.registryRoot, 'registry/holds', `${hold.holdId}.json`)));
      }
      if (target === 'candidate-partial-write') {
        assert.ok(actual.size > 0 && actual.size < fs.statSync(artifact).size, 'genuine incomplete native write');
        barrier('candidate-partial-write', { written: actual.size, candidateBaseHash: expected.candidateBaseHash });
      }
    }
    return value;
  };
  fs.linkSync = (source, destination) => {
    mutationCheck(!readonly, 'readonly status link');
    assert.ok(syncedFiles.has(String(source)), 'real file fsync precedes no-replace link');
    const value = real.linkSync(source, destination);
    const stat = fs.lstatSync(destination);
    links.set(String(destination), { source: String(source), ino: stat.ino, unlinked: false });
    if (publicationPhase(String(destination)) === 'locator') {
      assert.equal(stat.nlink, 2);
      barrier('locator-two-links', { locatorHash: sha(fs.readFileSync(destination)), nlink: 2 });
    }
    return value;
  };
  fs.unlinkSync = path => {
    mutationCheck(!readonly, 'readonly status unlink'); const value = real.unlinkSync(path);
    for (const entry of links.values()) if (entry.source === String(path)) entry.unlinked = true;
    return value;
  };
  fs.mkdirSync = (...args) => { mutationCheck(!readonly, 'readonly status mkdir'); return real.mkdirSync(...args); };
  fs.fsyncSync = fd => {
    mutationCheck(!readonly, 'readonly status fsync');
    const value = real.fsyncSync(fd), entry = fds.get(fd); assert.ok(entry, 'tracked native descriptor');
    entry.synced = true;
    syncs.push({ path: entry.path, directory: entry.directory, nativeCompleted: true });
    if (!entry.directory) { lastFileSync = entry.path; syncedFiles.add(entry.path); }
    else {
      for (const [path, publication] of links) {
        if (dirname(path) !== entry.path || !publication.unlinked || publication.completed) continue;
        publication.completed = true;
        assert.equal(fs.lstatSync(path).nlink, 1); assert.equal(fs.lstatSync(path).ino, publication.ino);
        barrier(publicationPhase(path), { fileHash: sha(fs.readFileSync(path)), publication: 'file-sync/link/pending-unlink/directory-sync' });
      }
      if (lastFileSync && basename(lastFileSync) === 'candidate.sqlite' && dirname(lastFileSync) === entry.path) {
        assert.equal(readers.size, 0, 'all observed candidate connections closed before sync');
        if (committed === 'verified-commit') barrier('verified-close-sync', { candidateHash: sha(fs.readFileSync(lastFileSync)) });
        if (committed === 'active-commit') barrier('active-close-sync', { candidateHash: sha(fs.readFileSync(lastFileSync)) });
        if (target === 'normalization-close-sync' && fs.existsSync(join(entry.path, 'normalization-intent.json')) && !fs.existsSync(join(entry.path, 'normalized.json'))) {
          const intent = JSON.parse(fs.readFileSync(join(entry.path, 'normalization-intent.json')));
          const bytes = fs.readFileSync(lastFileSync);
          assert.equal(intent.originalHeaderMode, 'WAL'); assert.deepEqual([...bytes.subarray(18, 20)], [1, 1]);
          assert.notEqual(sha(bytes), intent.candidateBaseHash);
          barrier('normalization-close-sync', { candidateHash: sha(bytes) });
        }
      }
      lastFileSync = null;
    }
    return value;
  };
  DatabaseSync.prototype.exec = function(sql) {
    mutationCheck(!(readonly && /\b(UPDATE|INSERT|DELETE\s+FROM|CREATE|DROP|REPLACE|VACUUM|REINDEX)\b/i.test(sql)), 'readonly status SQL mutation');
    const path = pathOf(this), candidate = basename(path ?? '') === 'candidate.sqlite';
    if (candidate) readers.add(this);
    if (candidate && /^BEGIN\b/i.test(sql.trim())) starts.set(this, projection(this));
    const before = starts.get(this), value = native.exec.call(this, sql);
    if (candidate && /^COMMIT\b/i.test(sql.trim())) {
      const after = projection(this); starts.delete(this);
      let phase;
      if (before?.version !== 4 && after.version === 4 && after.preparation) phase = 'p1-commit';
      else if (before?.mode === 'enabled' && after.mode === 'paused' && after.version === 3) phase = 'pause-commit';
      else if (before?.center?.recovery_run_id !== after.center?.recovery_run_id && after.run?.status === 'prepared') phase = 'prepare-commit';
      else if (before?.run?.status === 'prepared' && after.run?.status === 'verified') phase = 'verified-commit';
      else if (before?.run?.status === 'verified' && after.run?.status === 'active') phase = 'active-commit';
      else if (operation === 'activate' && before?.run?.status === 'verified' && after.run?.status === 'verified' && after.floor > before.floor) phase = 'activation-anchor';
      if (phase) {
        committed = phase;
        barrier(phase, { beforeHash: sha(JSON.stringify(before)), afterHash: sha(JSON.stringify(after)),
          floor: after.floor, runId: after.center?.recovery_run_id, epoch: after.center?.center_epoch,
          preparation: after.preparation, state: after.run?.status ?? null });
      }
    }
    return value;
  };
  DatabaseSync.prototype.prepare = function(sql) {
    mutationCheck(!(readonly && /\b(UPDATE|INSERT|DELETE\s+FROM|CREATE|DROP|REPLACE|VACUUM|REINDEX)\b/i.test(sql)), 'readonly status prepared SQL mutation');
    if (basename(pathOf(this) ?? '') === 'candidate.sqlite') readers.add(this);
    return native.prepare.call(this, sql);
  };
  DatabaseSync.prototype.close = function() { const value = native.close.call(this); readers.delete(this); return value; };
  syncBuiltinESMExports();
}
process.once('message', async message => {
  try {
    descriptor = JSON.parse(fs.readFileSync(message.descriptor, 'utf8'));
    assert.equal(descriptor.version, 1);
    target = message.mode === 'kill' ? descriptor.scenario.phase : null;
    if (target) {
      state = new Int32Array(new SharedArrayBuffer(8));
      worker = new Worker(new URL('./barrier.js', import.meta.url), { workerData: { state: state.buffer } });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('worker readiness timeout')), 3000);
        worker.once('message', value => { clearTimeout(timer); assert.equal(value, 'ready'); resolve(); });
        worker.once('error', error => { clearTimeout(timer); reject(error); });
      });
    }
    install(); // Before ALL production imports; no production injection options.
    const f = await import('./fixture.js');
    if (message.mode === 'contender') {
      const { createRegistryLock } = await import('../../../src/im/registry-lock.js');
      const { privateDirectory, protectedPath, checkOpened, syncDirectory } = await import('../../../src/im/v2/recovery-records.js');
      const s = f.saved(descriptor), roots = [descriptor.registryRoot, join(descriptor.workspace, 'requests'), s.dir];
      const results = roots.map(root => outcome(() => createRegistryLock(root, { privateDirectory, protectedPath, checkOpened, syncDirectory }).withLock(() => assert.fail('contender entered'))));
      for (const result of results) assert.deepEqual(result, { ok: false, code: 'REGISTRY_BUSY' });
      send({ phase: 'complete', caseId: descriptor.caseId, contenders: ['source', 'workspace', 'candidate'], results });
    } else if (message.mode === 'publication-retry') {
      const { createImV2BackupRegistry } = await import('../../../src/im/v2/backup-registry.js');
      const artifactDir = join(descriptor.registryRoot, 'registry/artifacts');
      const ids = fs.readdirSync(artifactDir).filter(name => name.endsWith('.sqlite')).map(name => name.slice(0, -7));
      assert.equal(ids.length, 1);
      const registry = createImV2BackupRegistry({ root: descriptor.registryRoot, authority: f.authority });
      const result = outcome(() => registry.verify({ backupId: ids[0] }, f.context));
      send({ phase: 'complete', caseId: descriptor.caseId, operation: 'verify-publication', result });
    } else if (descriptor.scenario.operation === 'publish' && message.mode === 'kill') {
      operation = 'publish'; operationHash = sha(JSON.stringify(descriptor.route === 'snapshot' ? { approvalRef: 'test-approved' } : { backupId: descriptor.oldBackupId }));
      await f.publish(descriptor); assert.fail('publisher returned without required death barrier');
    } else {
      const op = message.operation ?? descriptor.scenario.operation;
      const composition = f.open(descriptor, { noClock: message.noClock === true, advance: op === 'activate' || op === 'release' ? 100 : 0 });
      const s = f.saved(descriptor);
      let status = null;
      if (message.mode === 'retry' || message.mode === 'step') {
        if (s.locator) {
          const workspaceBefore = f.tree(descriptor.workspace), registryBefore = f.tree(descriptor.registryRoot);
          readonly = true;
          const before = syncs.length;
          try { status = outcome(() => composition.api.getRecoveryStatus({ runId: s.locator.runId }, f.context)); }
          finally { readonly = false; }
          assert.equal(syncs.length, before, 'status zero fsync');
          assert.equal(readonlyViolations, 0, 'status attempted no mutation; sanitized assertion is not a refusal');
          assert.deepEqual(f.tree(descriptor.workspace), workspaceBefore, 'readonly status preserves workspace bytes/inodes/times');
          assert.deepEqual(f.tree(descriptor.registryRoot), registryBefore, 'readonly status preserves registry bytes/inodes/times');
        }
      }
      operation = op;
      const input = message.input ?? f.inputFor(descriptor, op); operationHash = sha(JSON.stringify(input));
      const start = syncs.length, result = outcome(() => composition.api[f.methods[op]](input, f.context));
      if (message.mode === 'kill') assert.fail(`operation returned without required barrier: ${result.code ?? 'success'}`);
      send({ phase: 'complete', caseId: descriptor.caseId, operation, operationHash, status, result,
        clocks: composition.clocks(), syncs: syncs.slice(start).map(entry => ({ ...entry, path: entry.path.replace(descriptor.root, '<case>') })),
        publications: [...links].filter(([, entry]) => entry.completed).map(([path, entry]) => ({
          path: path.replace(descriptor.root, '<case>'), pending: entry.source.replace(descriptor.root, '<case>'),
          fileSynced: syncedFiles.has(entry.source), pendingUnlinked: entry.unlinked, directorySynced: entry.completed, ino: entry.ino })),
        approvals: composition.approvals });
    }
  } catch (error) {
    process.exitCode = 1;
    send({ phase: 'failure', caseId: descriptor?.caseId, operation, code: error?.code ?? 'HARNESS_ASSERTION',
      message: String(error?.message ?? error).replaceAll(descriptor?.root ?? '\0', '<case>'), stack: error?.stack?.split('\n').slice(1, 4) });
  } finally {
    Object.assign(fs, real); Object.assign(DatabaseSync.prototype, native); syncBuiltinESMExports();
    if (worker) await worker.terminate();
    process.disconnect();
  }
});
send({ phase: 'ready' });
