import { functionalWall } from './fixtures/im-v2-recovery-conversion-target/functional-clock.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, writeFileSync, linkSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createImV2RecoveryServices, createRecoveryConversionTarget } from '../src/im/v2/recovery.js';
import { withRecoveryConversionScope as scope } from '../src/im/v2/recovery-conversion-target.js';
import { createImV2BackupRegistry, withRecoveryHold } from '../src/im/v2/backup-registry.js';
import { operationBudget } from '../src/im/v2/recovery-records.js';
import { validationLimits } from '../src/im/v2/backup.js';
import { context, setup, bytes, logical, tree, intakeKeys } from './fixtures/im-v2-recovery-conversion-target/helpers.js';
import { observeNative } from './fixtures/im-v2-recovery-conversion-target/native-observer.js';
import { hashRecoveryRequestRef } from '../src/im/v2/recovery-plan.js';

const native = { skip: process.platform === 'win32' };
const invalid = { code: 'RECOVERY_INVALID' }, pending = { code: 'RECOVERY_CONVERSION_PENDING' };
function safeError(error, code) {
  assert.equal(error?.code, code); assert.equal(error.message, code);
}
function caught(call) { try { return { value: call() }; } catch (error) { return { error }; } }
function noConversion(s) { assert.deepEqual(fs.readdirSync(s.dir).filter(name => name.startsWith('conversion-')), []); }
function releasedControls(s) {
  return [s.services && join(s.f.registryRoot, 'coordination.sqlite'),
    join(s.root, 'requests', 'coordination.sqlite'), join(s.dir, 'coordination.sqlite')].filter(Boolean);
}
test('bridge pure counterfeit capabilities reject without reflection', t => {
  t.diagnostic(JSON.stringify({ functionalWall: functionalWall() }));
  const hostile = new Proxy({}, { get() { throw Error('foreign'); }, getPrototypeOf() { throw Error('foreign'); } });
  for (const fake of [{}, Object.freeze({}), hostile, null]) {
    assert.throws(() => createRecoveryConversionTarget(fake, { runId: 'bad' }, context), invalid);
    assert.throws(() => scope(fake, context, () => {}), invalid);
  }
});
test('Windows strict construction remains unsupported', { skip: process.platform !== 'win32' }, () => {
  assert.throws(() => createImV2RecoveryServices({ root: 'C:\\' }), { code: 'RECOVERY_UNSUPPORTED' });
});

for (const [route, enabled] of [['fresh', false], ['closed-v3', true], ['registered-v3', true], ['snapshot', false], ['snapshot', true]]) {
  test(`genuine ${route} enabled=${enabled}: ordered intake, claim, pause, restart and immutable source`, native, async t => {
    const s = await setup(t, route, enabled), target = s.target(), before = tree(s.dir), original = logical(s.path);
    const source = s.source ? readFileSync(s.source) : null;
    const intake = scope(target, context, session => session.inspectIntake({}));
    assert.deepEqual(Object.keys(intake), intakeKeys); assert.equal(intake.phase, 'UNCLAIMED');
    assert.equal(intake.currentFileHash, bytes(s.path)); assert.equal(intake.intakeFileHash, intake.currentFileHash);
    assert.equal(intake.ownerHash, null); assert.equal(intake.pauseIntentHash, null); assert.equal(intake.pausedHash, null);
    assert.equal(intake.sourceEvidenceHash === null, route === 'fresh');
    assert.equal(intake.holdId === null, route === 'fresh' || route === 'closed-v3');
    assert.deepEqual(tree(s.dir), before, 'mint and inspect never resync or publish');
    const empty = scope(target, context, session => session.readConversionRecords({}));
    assert.deepEqual(empty, { version: 1, owner: null, pauseIntent: null, paused: null });
    let first;
    const paused = scope(target, context, session => {
      assert.deepEqual(Object.keys(session), ['inspectIntake', 'readConversionRecords', 'claimConversion', 'ensurePaused']);
      first = session.claimConversion({}); assert.equal(first.replayed, false);
      assert.equal(session.claimConversion({}).replayed, true);
      assert.equal(session.inspectIntake({}).phase, 'CLAIMED');
      return session.ensurePaused({});
    });
    assert.equal(paused.replayed, false); assert.equal(paused.paused.record.changed, route === 'snapshot' && enabled);
    assert.ok(Object.isFrozen(paused.owner.record)); assert.deepEqual(Object.keys(paused), ['version', 'owner', 'pauseIntent', 'paused', 'replayed']);
    assert.equal(paused.owner.record.intakeFileHash, intake.intakeFileHash);
    const after = logical(s.path);
    for (const [table, rows] of Object.entries(original.rows)) {
      if (table === 'im_settings' && route === 'snapshot' && enabled) {
        assert.deepEqual(after.rows[table], rows.map(row => JSON.stringify({ ...JSON.parse(row), write_mode: 'paused' })));
      } else assert.deepEqual(after.rows[table], rows, `${table} unchanged`);
    }
    assert.deepEqual(after.schema, original.schema);
    if (!paused.paused.record.changed) assert.equal(bytes(s.path), intake.intakeFileHash);
    const evidence = tree(s.dir);
    const replay = scope(s.target(), context, session => { session.claimConversion({}); return session.ensurePaused({}); });
    assert.deepEqual(replay, { ...paused, replayed: true }); assert.deepEqual(tree(s.dir), evidence);
    const current = scope(s.target(), context, session => session.inspectIntake({}));
    assert.equal(current.phase, 'PAUSED'); assert.equal(current.intakeWriteMode, intake.intakeWriteMode);
    assert.equal(current.currentWriteMode, 'paused');
    for (const [name, hash] of Object.entries(before)) if (name !== 'candidate.sqlite') assert.equal(tree(s.dir)[name], hash, name);
    if (source) assert.deepEqual(readFileSync(s.source), source);
  });
}

test('session exact receiver/arity/input, poison, result identity, expiry and revocation', native, async t => {
  const s = await setup(t), target = s.target();
  let escaped, foreign;
  foreign = scope(target, context, session => { escaped = session; return session.inspectIntake({}); });
  assert.throws(() => escaped.inspectIntake({}), invalid);
  const methods = ['inspectIntake', 'readConversionRecords', 'claimConversion', 'ensurePaused'];
  const proxy = new Proxy({}, { ownKeys() { throw Error('trap'); }, getPrototypeOf() { throw Error('trap'); } });
  const getter = Object.defineProperty({}, 'x', { get() { throw Error('trap'); } });
  for (const name of methods) for (const args of [[], [{}, {}], [null], [[]], [Object.create(null)], [{ x: 1 }], [getter], [{ [Symbol()]: 1 }], [proxy]]) {
    assert.throws(() => scope(target, context, session => {
      const valid = session.inspectIntake({}); assert.throws(() => session[name](...args), invalid); return valid;
    }), invalid);
  }
  assert.throws(() => scope(target, context, session => {
    const result = session.inspectIntake({}), copied = { ...session };
    assert.throws(() => copied.inspectIntake({}), invalid); return result;
  }), invalid);
  for (const value of [undefined, null, false, 0, '', foreign, { ...foreign }]) assert.throws(() => scope(target, context, () => value), invalid);
  assert.throws(() => scope(target, context, session => session), invalid);
  assert.throws(() => scope(target, context, session => { const value = session.inspectIntake({});
    assert.throws(() => session.ensurePaused({}), invalid); return value; }), invalid);
  assert.throws(() => scope(target, context, session => { const value = session.inspectIntake({});
    assert.throws(() => escaped.inspectIntake({}), invalid); return value; }), invalid);
  const other = s.target();
  assert.throws(() => scope(target, context, session => { const value = session.inspectIntake({});
    assert.throws(() => scope(other, context, nested => nested.inspectIntake({})), invalid); return value; }), invalid);
  let prefix = 0;
  assert.throws(() => scope(target, context, async () => { prefix++; }), invalid);
  assert.throws(() => scope(target, context, function* () { prefix++; }), invalid); assert.equal(prefix, 0);
  assert.throws(() => scope(target, context, () => Promise.reject(Error('observed rejection'))), invalid);
  for (const error of [undefined, null, false, 0, proxy]) assert.throws(() => scope(target, context, () => { throw error; }), { code: 'RECOVERY_CALLBACK_FAILED' });
  assert.throws(() => scope(target, context, session => { const value = session.inspectIntake({});
    assert.throws(() => target.invalidate(1), invalid); return value; }), invalid);
  assert.throws(() => scope(target, context, session => { const value = session.inspectIntake({}); target.invalidate(); return value; }), invalid);
  assert.equal(target.invalidate(), undefined); assert.throws(() => scope(target, context, () => foreign), invalid);
  const copied = { ...target }; assert.throws(() => copied.invalidate(), invalid);
  assert.equal(scope(s.target(), context, session => session.inspectIntake({})).phase, 'UNCLAIMED');
});

test('all eight legacy operations refuse durable owner before writes or clock work', native, async t => {
  const s = await setup(t, 'snapshot', true), target = s.target();
  scope(target, context, session => session.claimConversion({}));
  const before = tree(s.root), registry = tree(s.f.registryRoot), input = { runId: s.staged.runId }, hash = 'a'.repeat(64);
  const calls = [
    () => s.api.stageCandidate(s.input, context), () => s.api.previewRecovery(input, context),
    () => s.api.prepareRecovery({ ...input, preparePlanHash: hash, approvalRef: 'ok' }, context),
    () => s.api.getRecoveryStatus(input, context), () => s.api.verifyRecovery({ ...input, preparePlanHash: hash }, context),
    () => s.api.previewActivation({ ...input, sealReference: 'seal', authReviewRef: 'auth', isolationAckRef: 'isolated', activationRef: 'activate' }, context),
    () => s.api.activateRecovery({ ...input, activationPlanHash: hash, activationApprovalRef: 'ok', sealReference: 'seal' }, context),
    () => s.api.releaseRecoveryHold({ ...input, holdId: s.staged.holdId, releasePlanHash: hash, approvalRef: 'ok' }, context),
  ];
  const original = fs.fsyncSync; let syncs = 0;
  fs.fsyncSync = (...args) => { syncs++; return original(...args); }; syncBuiltinESMExports();
  try { for (const call of calls) assert.throws(call, pending); } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  assert.equal(syncs, 0); assert.deepEqual(tree(s.root), before); assert.deepEqual(tree(s.f.registryRoot), registry);
  assert.throws(() => createRecoveryConversionTarget(s.api, input, {}), { code: 'RECOVERY_AUTH_DENIED' });
});

test('exact inventory, alias, orphan and preexisting prepare reject', native, async t => {
  for (const name of ['unknown', '.foreign.pending', 'conversion-paused.json', 'conversion-owner.json']) {
    const s = await setup(t); writeFileSync(join(s.dir, name), '{}', { mode: 0o600 });
    assert.throws(s.target, { code: name.endsWith('.pending') ? 'RECOVERY_INDETERMINATE' : 'RECOVERY_EVIDENCE_MISMATCH' });
  }
  const s = await setup(t); linkSync(s.path, join(s.f.root, 'candidate-alias.sqlite'));
  assert.throws(s.target, { code: 'RECOVERY_EVIDENCE_MISMATCH' }); unlinkSync(join(s.f.root, 'candidate-alias.sqlite'));
  s.api.previewRecovery({ runId: s.staged.runId }, context); assert.throws(s.target, { code: 'RECOVERY_EVIDENCE_MISMATCH' });
});

test('changed candidate with intent but missing paused proof is never adopted', native, async t => {
  const s = await setup(t, 'snapshot', true), target = s.target();
  const original = fs.linkSync;
  fs.linkSync = (...args) => { if (String(args[1]).endsWith('conversion-paused.json')) throw Error('injected'); return original(...args); };
  syncBuiltinESMExports();
  try { assert.throws(() => scope(target, context, session => { session.claimConversion({}); return session.ensurePaused({}); }), { code: 'RECOVERY_DURABILITY_UNCERTAIN' }); }
  finally { fs.linkSync = original; syncBuiltinESMExports(); }
  assert.equal(JSON.parse(logical(s.path).rows.im_settings[0]).write_mode, 'paused');
  assert.throws(s.target, { code: 'RECOVERY_INDETERMINATE' });
});

test('source cleanup invalidation occurs after session expiry and prevents outer success', native, async t => {
  const hooks = {}, s = await setup(t, 'closed-v3', false, hooks), target = s.target();
  let escaped, armed = false;
  hooks.isolation = () => { if (armed) { assert.throws(() => escaped.inspectIntake({}), invalid); target.invalidate(); } };
  assert.throws(() => scope(target, context, session => { escaped = session; const value = session.inspectIntake({}); armed = true; return value; }), invalid);
});

test('authentic inherited budget rejects forged and lower-ceiling incompatibility before source work', native, async t => {
  const s = await setup(t, 'snapshot'), input = { backupId: s.options.sourceCatalog.source.backupId, holdId: s.staged.holdId };
  let called = false;
  assert.throws(() => withRecoveryHold(s.services.registry, input, context, () => { called = true; }, {}), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  const budget = operationBudget(validationLimits()); budget.tick();
  assert.equal(withRecoveryHold(s.services.registry, input, context, () => 7, budget), 7);
  const smaller = createImV2BackupRegistry({ ...s.f.options, limits: { maxFileBytes: 1024 } });
  assert.throws(() => withRecoveryHold(smaller, input, context, () => { called = true; }, budget), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.equal(called, false);
});

function child(name, args) {
  const script = name === 'probe-lock.js' ? 'probe-supervisor.js' : name;
  const argv = [fileURLToPath(new URL(`./fixtures/im-v2-recovery-conversion-target/${script}`, import.meta.url)), ...args];
  const result = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  if (name === 'probe-lock.js') {
    assert.equal(output.connectionClosed, true, 'child native connection closed before actual process exit');
    assert.deepEqual(output.lifecycle.exit, { code: 0, signal: null });
    assert.deepEqual(output.lifecycle.close, { code: 0, signal: null });
    assert.equal(output.lifecycle.timedOut, false);
  }
  return output;
}
test('independent process reopens exact paused owner without regenerating times', native, async t => {
  const s = await setup(t);
  const paused = scope(s.target(), context, session => { session.claimConversion({}); return session.ensurePaused({}); });
  const before = tree(s.dir);
  assert.deepEqual(child('reopen.js', [s.root, s.staged.runId]), { ...paused, replayed: true });
  assert.deepEqual(tree(s.dir), before);
});
test('independent process contention spans source/workspace/candidate during owner and pause publication', native, async t => {
  const s = await setup(t, 'snapshot', true), target = s.target();
  const paths = [join(s.f.registryRoot, 'coordination.sqlite'), join(s.root, 'requests', 'coordination.sqlite'), join(s.dir, 'coordination.sqlite')];
  const original = fs.linkSync, observations = [];
  fs.linkSync = (...args) => {
    if (/conversion-(owner|pause-intent|paused)\.json$/.test(String(args[1]))) {
      observations.push(paths.map(path => child('probe-lock.js', [path]).acquired));
    }
    return original(...args);
  };
  syncBuiltinESMExports();
  try { scope(target, context, session => { session.claimConversion({}); return session.ensurePaused({}); }); }
  finally { fs.linkSync = original; syncBuiltinESMExports(); }
  assert.deepEqual(observations, [[false, false, false], [false, false, false], [false, false, false]]);
  for (const path of paths) assert.equal(child('probe-lock.js', [path]).acquired, true);
});

test('visible uncertain owner excludes legacy until exact durability retry; resyncs files and directory', native, async t => {
  const s = await setup(t), target = s.target();
  const originals = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync };
  const descriptors = new Map(), events = []; let ownerVisible = false, failOnce = true;
  fs.openSync = (...args) => { const fd = originals.openSync(...args); descriptors.set(fd, String(args[0])); return fd; };
  fs.closeSync = fd => { const result = originals.closeSync(fd); descriptors.delete(fd); return result; };
  fs.linkSync = (...args) => { const result = originals.linkSync(...args); if (String(args[1]).endsWith('conversion-owner.json')) ownerVisible = true; return result; };
  fs.fsyncSync = fd => {
    const path = descriptors.get(fd); events.push(path);
    if (ownerVisible && failOnce && path === s.dir) { failOnce = false; throw Error('directory sync uncertainty'); }
    return originals.fsyncSync(fd);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => scope(target, context, session => session.claimConversion({})), { code: 'RECOVERY_DURABILITY_UNCERTAIN' });
    const owner = readFileSync(join(s.dir, 'conversion-owner.json'));
    assert.throws(() => s.api.stageCandidate(s.input, context), pending);
    assert.throws(() => s.api.getRecoveryStatus({ runId: s.staged.runId }, context), pending);
    events.length = 0;
    scope(s.target(), context, session => { assert.equal(session.claimConversion({}).replayed, true); return session.ensurePaused({}); });
    assert.deepEqual(readFileSync(join(s.dir, 'conversion-owner.json')), owner);
    assert.ok(events.includes(join(s.dir, 'conversion-owner.json'))); assert.ok(events.includes(s.dir));
    events.length = 0;
    scope(s.target(), context, session => { session.claimConversion({}); return session.ensurePaused({}); });
    for (const name of ['candidate.sqlite', 'conversion-owner.json', 'conversion-pause-intent.json', 'conversion-paused.json']) assert.ok(events.includes(join(s.dir, name)), name);
  } finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
});

test('shared count and elapsed budget include real DB metadata and consumer time', native, async t => {
  const s = await setup(t);
  const restricted = createImV2RecoveryServices({ ...s.options, limits: { maxMetadataEntries: 40 } });
  assert.throws(() => createRecoveryConversionTarget(restricted, { runId: s.staged.runId }, context), { code: 'RECOVERY_BUSY' });
  const short = createImV2RecoveryServices({ ...s.options, limits: { maxElapsedMs: 500 } });
  const target = createRecoveryConversionTarget(short, { runId: s.staged.runId }, context);
  assert.throws(() => scope(target, context, session => {
    const result = session.inspectIntake({});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 550);
    return result;
  }), { code: 'RECOVERY_BUSY' });
});

test('caught final authority callback misuse cannot reuse the earlier valid result', native, async t => {
  const hooks = {}, s = await setup(t, 'fresh', false, hooks), target = s.target();
  let escaped, armed = false;
  hooks.admin = () => { if (armed) { armed = false; assert.throws(() => escaped.readConversionRecords({}), invalid); } };
  assert.throws(() => scope(target, context, session => {
    escaped = session; const result = session.inspectIntake({}); armed = true; return result;
  }), invalid);
});

test('pre-minted target accepts same bound owner; replacement candidate invalidates old target', native, async t => {
  const s = await setup(t), first = s.target(), second = s.target();
  const owner = scope(first, context, session => session.claimConversion({}));
  const retry = scope(second, context, session => session.claimConversion({}));
  assert.deepEqual(retry, { ...owner, replayed: true });
  const saved = readFileSync(s.path); renameSync(s.path, join(s.f.root, 'replaced.sqlite')); writeFileSync(s.path, saved, { mode: 0o600 });
  assert.throws(() => scope(first, context, session => session.inspectIntake({})), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
});

test('native pause COMMIT uncertainty leaves changed bytes without completion indeterminate', native, async t => {
  const s = await setup(t, 'snapshot', true), target = s.target(), source = bytes(s.source);
  const original = DatabaseSync.prototype.exec; let mutated = false, injected = false;
  DatabaseSync.prototype.exec = function(sql) {
    const result = Reflect.apply(original, this, [sql]);
    if (sql === 'COMMIT' && !injected && mutated) { injected = true; throw Error('native commit response lost'); }
    return result;
  };
  try {
    assert.throws(() => scope(target, context, session => {
      session.claimConversion({}); mutated = true; return session.ensurePaused({});
    }), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  } finally { DatabaseSync.prototype.exec = original; }
  assert.equal(injected, true); assert.equal(JSON.parse(logical(s.path).rows.im_settings[0]).write_mode, 'paused');
  assert.ok(fs.existsSync(join(s.dir, 'conversion-pause-intent.json')));
  assert.equal(fs.existsSync(join(s.dir, 'conversion-paused.json')), false);
  assert.equal(fs.readdirSync(s.dir).some(name => name.endsWith('.pending')), false);
  const before = tree(s.dir);
  assert.throws(s.target, { code: 'RECOVERY_INDETERMINATE' });
  assert.deepEqual(tree(s.dir), before); assert.equal(bytes(s.source), source);
});

test('visible intent with unchanged input retries same bytes/time before candidate-only pause', native, async t => {
  const s = await setup(t, 'snapshot', true), target = s.target(), inputHash = bytes(s.path);
  const originals = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync };
  const descriptors = new Map(); let intentVisible = false, injected = false;
  fs.openSync = (...args) => { const fd = originals.openSync(...args); descriptors.set(fd, String(args[0])); return fd; };
  fs.closeSync = fd => { const value = originals.closeSync(fd); descriptors.delete(fd); return value; };
  fs.linkSync = (...args) => { const value = originals.linkSync(...args); if (String(args[1]).endsWith('conversion-pause-intent.json')) intentVisible = true; return value; };
  fs.fsyncSync = fd => {
    if (intentVisible && !injected && descriptors.get(fd) === s.dir) { injected = true; throw Error('intent directory uncertainty'); }
    return originals.fsyncSync(fd);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => scope(target, context, session => { session.claimConversion({}); return session.ensurePaused({}); }), { code: 'RECOVERY_DURABILITY_UNCERTAIN' }); }
  finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
  assert.equal(bytes(s.path), inputHash);
  const intent = readFileSync(join(s.dir, 'conversion-pause-intent.json'));
  const target2 = s.target();
  assert.equal(scope(target2, context, session => session.inspectIntake({})).phase, 'PAUSE_INTENT');
  const result = scope(target2, context, session => { session.claimConversion({}); return session.ensurePaused({}); });
  assert.equal(result.replayed, false); assert.deepEqual(readFileSync(join(s.dir, 'conversion-pause-intent.json')), intent);
});

// These gates describe actual native progress, never a callback ordinal. Fixture
// construction and a successful control mint happen before instrumentation.
for (const phase of ['early-admin', 'final-closed-source-isolation', 'final-isolation', 'final-admin']) {
  for (const attempt of ['same-run', 'different-run', 'invalid-scope']) {
    test(`mint poison ${phase}: caught ${attempt} cannot escape as a target`, native, async t => {
      const hooks = {}, s = await setup(t, 'closed-v3', false, hooks);
      // Only these three cases separate the authority owners. The genuine
      // closed-source capability retains its original authority and hook.
      if (phase === 'final-closed-source-isolation') {
        s.options.evidenceAuthority = { ...s.evidenceAuthority, assertSourceIsolation: () => true };
        assert.notEqual(s.options.evidenceAuthority, s.evidenceAuthority);
      }
      const other = attempt === 'different-run'
        ? s.api.stageCandidate({ ...s.input, requestRef: 'other-genuine-run' }, context) : s.staged;
      const control = scope(s.target(), context, session => session.inspectIntake({}));
      assert.equal(control.phase, 'UNCLAIMED'); assert.ok(control.preparationRef);
      const before = tree(s.f.root), candidateLock = join(s.dir, 'coordination.sqlite');
      const workspaceLock = join(s.root, 'requests', 'coordination.sqlite');
      let candidateReadClosed = false, candidateReleased = false, workspaceReleased = false, sourcePostReadClosed = false;
      let started = false, fired = 0, nested, marked;
      const observer = observeNative(event => {
        if (event.op === 'exec' && event.path === candidateLock && event.sql === 'BEGIN IMMEDIATE') started = true;
        if (event.op === 'db-close' && event.path === s.path) candidateReadClosed = true;
        if (event.op === 'db-close' && event.path === candidateLock && started) candidateReleased = true;
        if (event.op === 'db-close' && event.path === workspaceLock && candidateReleased) workspaceReleased = true;
        if (event.op === 'db-close' && event.path === s.source && candidateReleased && workspaceReleased) sourcePostReadClosed = true;
      });
      const invoke = current => {
        if (fired || current !== phase) return;
        const ready = current === 'early-admin' ? !started && !candidateReadClosed
          : current === 'final-closed-source-isolation' ? started && candidateReadClosed && candidateReleased && workspaceReleased && !sourcePostReadClosed
            : candidateReadClosed && candidateReleased && workspaceReleased && (current !== 'final-admin' || sourcePostReadClosed);
        if (!ready) return;
        fired++; marked = { phase: current, started, candidateReadClosed, candidateReleased, workspaceReleased, sourcePostReadClosed };
        nested = caught(() => attempt === 'invalid-scope' ? scope({}, context, () => null)
          : createRecoveryConversionTarget(s.api, { runId: other.runId }, context));
      };
      hooks.admin = () => invoke(candidateReadClosed ? 'final-admin' : 'early-admin');
      hooks.isolation = () => invoke(phase === 'final-closed-source-isolation' ? 'final-closed-source-isolation' : 'final-isolation');
      let outer;
      try { outer = caught(s.target); }
      finally { observer.restore(); delete hooks.admin; delete hooks.sourceEvidence; delete hooks.isolation; }
      assert.equal(fired, 1, `must reach ${phase}; trace=${JSON.stringify(observer.events.filter(e => e.op !== 'write'))}`);
      safeError(nested.error, 'RECOVERY_INVALID'); safeError(outer.error, 'RECOVERY_INVALID');
      assert.equal(outer.value, undefined); assert.equal(nested.value, undefined);
      assert.deepEqual(tree(s.f.root), before); noConversion(s);
      assert.equal(scope(s.target(), context, session => session.inspectIntake({})).phase, 'UNCLAIMED');
      assert.deepEqual(tree(s.f.root), before);
      t.diagnostic(JSON.stringify({ phase: marked, attempt, injectionCount: fired, result: 'fixed-invalid/no-publication/cleanup-remint' }));
    });
  }
}

for (const mode of ['equal', 'below', 'natural']) {
  test(`isolated genuine FRESH clock ${mode}: intent boundary after claim twice and CLAIMED`, native, async t => {
    const result = child('fresh-clock-supervisor.js', [mode]);
    assert.equal(result.mode, mode); assert.equal(result.completed, true);
    assert.equal(result.validated, true);
    assert.ok((mode === 'natural' ? ['SUCCESS', 'CLOCK_REGRESSION_OBSERVED_SAFE_REFUSAL'] : ['SUCCESS']).includes(result.outcome));
    assert.deepEqual(result.lifecycle.exit, { code: 0, signal: null });
    assert.deepEqual(result.lifecycle.close, { code: 0, signal: null });
    assert.equal(result.lifecycle.timedOut, false);
    t.diagnostic(JSON.stringify(result));
  });
}

test('locator-only durable interruption: observational RETRY_STAGE then explicit identical stage retry', native, async t => {
  const s = await setup(t, 'closed-v3'), input = { ...s.input, requestRef: 'locator-only-followup' };
  const originalMkdir = fs.mkdirSync; let injections = 0, interruptedPath;
  fs.mkdirSync = (...args) => {
    if (String(args[0]).startsWith(join(s.root, 'runs') + '/') && /[0-9a-f-]{36}$/.test(String(args[0]))) {
      injections++; interruptedPath = String(args[0]); throw Error('test before run directory creation');
    }
    return originalMkdir(...args);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => s.api.stageCandidate(input, context)); }
  finally { fs.mkdirSync = originalMkdir; syncBuiltinESMExports(); }
  assert.equal(injections, 1);
  const locatorPath = join(s.root, 'requests', `${hashRecoveryRequestRef(input.requestRef)}.json`);
  const locatorBytes = readFileSync(locatorPath), locator = JSON.parse(locatorBytes);
  assert.equal(interruptedPath, join(s.root, 'runs', locator.runId)); assert.equal(fs.existsSync(interruptedPath), false);
  assert.ok(locator.stage.preparationRef);
  const before = tree(s.f.root), observer = observeNative(); let mkdirs = 0, status;
  fs.mkdirSync = (...args) => { mkdirs++; return originalMkdir(...args); }; syncBuiltinESMExports();
  try { status = s.open().getRecoveryStatus({ runId: locator.runId }, context); }
  finally { fs.mkdirSync = originalMkdir; observer.restore(); syncBuiltinESMExports(); }
  assert.equal(status.state, 'indeterminate'); assert.equal(status.nextAction, 'RETRY_STAGE');
  assert.equal(mkdirs, 0); assert.equal(fs.existsSync(interruptedPath), false);
  assert.deepEqual(observer.events.filter(e => ['write', 'linkSync', 'unlinkSync', 'renameSync', 'fsync', 'mutation'].includes(e.op)), []);
  assert.deepEqual(tree(s.f.root), before);
  const result = s.open().stageCandidate(input, context);
  assert.equal(result.runId, locator.runId); assert.equal(result.candidateReference, locator.stage.candidateReference);
  assert.equal(result.preparationRef, locator.stage.preparationRef);
  assert.deepEqual(readFileSync(locatorPath), locatorBytes);
  const stage = JSON.parse(readFileSync(join(interruptedPath, 'stage.json')));
  assert.equal(stage.preparationRef, locator.stage.preparationRef); assert.deepEqual(stage, locator.stage);
  t.diagnostic(JSON.stringify({ injections, status, runId: result.runId, preparationRef: stage.preparationRef,
    observationEvents: observer.events, observationMkdirs: mkdirs }));
});

for (const fault of ['broken-run-link', 'nonprivate-runs-parent']) {
  test(`locator status ${fault}: existing unsafe paths refuse without repair`, native, async t => {
    const s = await setup(t), moved = join(s.f.root, 'saved-run'), runs = join(s.root, 'runs');
    const original = tree(s.f.root);
    if (fault === 'broken-run-link') { renameSync(s.dir, moved); fs.symlinkSync(join(s.f.root, 'missing-run'), s.dir); }
    else fs.chmodSync(runs, 0o755);
    const observer = observeNative(); let result, retry, statusEventCount;
    try {
      result = caught(() => s.open().getRecoveryStatus({ runId: s.staged.runId }, context));
      statusEventCount = observer.events.length;
      retry = caught(() => s.open().stageCandidate(s.input, context));
    }
    finally {
      observer.restore();
      if (fault === 'broken-run-link') { unlinkSync(s.dir); renameSync(moved, s.dir); }
      else fs.chmodSync(runs, 0o700);
    }
    assert.equal(result.error, undefined); assert.equal(result.value.state, 'indeterminate');
    assert.equal(result.value.nextAction, 'MANUAL_RECONCILIATION');
    safeError(retry.error, 'RECOVERY_EVIDENCE_MISMATCH'); assert.equal(retry.value, undefined);
    assert.deepEqual(observer.events.slice(0, statusEventCount).filter(e => ['write', 'linkSync', 'unlinkSync', 'renameSync', 'fsync', 'mutation'].includes(e.op)), []);
    assert.deepEqual(observer.events.slice(statusEventCount).filter(e => ['write', 'linkSync', 'unlinkSync', 'renameSync', 'mutation'].includes(e.op)), []);
    // Explicit stage may resync its workspace while checking a broken run link;
    // no run/evidence repair is allowed. Observational status above is zero-sync.
    assert.ok(observer.events.slice(statusEventCount).filter(e => e.op === 'fsync').every(e => e.path === s.root && e.fdType === 'directory'));
    assert.deepEqual(tree(s.f.root), original);
  });
}

test('legacy unclaimed FRESH stage-only repair restores original bytes and exact P1 result', native, async t => {
  const s = await setup(t), stagePath = join(s.dir, 'stage.json');
  const control = scope(s.target(), context, session => session.inspectIntake({}));
  assert.ok(control.preparationRef); assert.equal(control.phase, 'UNCLAIMED');
  const stageBytes = readFileSync(stagePath), original = tree(s.f.root), db = logical(s.path);
  unlinkSync(stagePath); // Fixture deletion is outside the operation observer.
  const observer = observeNative(); let result;
  try { result = s.api.stageCandidate(s.input, context); } finally { observer.restore(); }
  assert.deepEqual(result, s.staged); assert.deepEqual(readFileSync(stagePath), stageBytes);
  assert.deepEqual(logical(s.path), db);
  const after = tree(s.f.root), relative = Object.keys(original).find(name => name.endsWith(`${s.staged.runId}/stage.json`));
  assert.ok(relative); delete original[relative]; delete after[relative]; assert.deepEqual(after, original);
  assert.ok(observer.events.some(e => e.op === 'linkSync' && e.paths[1] === stagePath));
  assert.ok(observer.events.some(e => e.op === 'fsync' && e.path === s.dir && e.fdType === 'directory'));
  noConversion(s);
});

test('legacy claimed missing stage refuses before all old evidence writes and resync', native, async t => {
  const s = await setup(t), stagePath = join(s.dir, 'stage.json');
  scope(s.target(), context, session => session.claimConversion({}));
  assert.throws(() => s.api.stageCandidate(s.input, context), pending);
  unlinkSync(stagePath);
  const before = tree(s.f.root), observer = observeNative(); let result;
  try { result = caught(() => s.api.stageCandidate(s.input, context)); } finally { observer.restore(); }
  safeError(result.error, 'RECOVERY_EVIDENCE_MISMATCH'); assert.equal(result.value, undefined);
  assert.equal(fs.existsSync(stagePath), false); assert.deepEqual(tree(s.f.root), before);
  assert.deepEqual(observer.events.filter(e => ['write', 'linkSync', 'unlinkSync', 'renameSync', 'fsync', 'mutation'].includes(e.op)), []);
});

test('legacy unclaimed FRESH missing both stage and staged retains original run and P1', native, async t => {
  const s = await setup(t), stagePath = join(s.dir, 'stage.json'), stagedPath = join(s.dir, 'staged.json');
  const stageBytes = readFileSync(stagePath), before = logical(s.path), candidate = bytes(s.path);
  unlinkSync(stagePath); unlinkSync(stagedPath);
  const result = s.api.stageCandidate(s.input, context);
  assert.deepEqual(result, s.staged); assert.deepEqual(readFileSync(stagePath), stageBytes);
  assert.equal(bytes(s.path), candidate); assert.deepEqual(logical(s.path), before); noConversion(s);
});

for (const point of ['native-close-response-loss', 'candidate-file-sync-response-loss',
  'candidate-directory-sync-response-loss', 'paused-publication-directory-sync-response-loss']) {
  test(`enabled historical SNAPSHOT ${point}: caught failure poisons issued result`, native, async t => {
    const s = await setup(t, 'snapshot', true), target = s.target();
    const intake = scope(target, context, session => session.inspectIntake({}));
    assert.equal(intake.phase, 'UNCLAIMED'); assert.equal(intake.currentWriteMode, 'enabled');
    const before = tree(s.f.root), beforeLogical = logical(s.path), controls = releasedControls(s);
    let pauseConnection, begin, mutation, commit, closed, fileSync, dirSync, pendingSync, linked, unlinked;
    let injections = 0, faultPhase, inner, returnedIssued = false;
    const pausedPath = join(s.dir, 'conversion-paused.json');
    const observer = observeNative((event, events) => {
      if (event.op === 'mutation' && event.path === s.path && /^UPDATE im_settings SET write_mode='paused'/.test(event.sql)) {
        assert.equal(event.changes, 1); pauseConnection = event.connection; mutation = event;
        begin = events.findLast(e => e.op === 'exec' && e.connection === pauseConnection && e.sql === 'BEGIN IMMEDIATE');
        assert.ok(begin?.transaction); assert.ok(begin.seq < mutation.seq);
      }
      if (event.op === 'exec' && event.connection === pauseConnection && event.sql === 'COMMIT') {
        assert.ok(mutation); assert.equal(event.transaction, false); commit = event;
      }
      if (event.op === 'db-close' && event.connection === pauseConnection && commit) {
        assert.equal(event.isOpen, false); closed = event;
      }
      if (event.op === 'fsync' && event.path === s.path && closed) {
        assert.equal(event.fdType, 'file'); fileSync ??= event;
      }
      if (event.op === 'fsync' && event.path === s.dir && fileSync && !linked) {
        assert.equal(event.fdType, 'directory'); dirSync ??= event;
      }
      if (event.op === 'linkSync' && event.paths[1] === pausedPath) {
        assert.ok(dirSync); linked = event;
        pendingSync = events.findLast(e => e.op === 'fsync' && e.path === event.paths[0]);
        assert.equal(pendingSync?.fdType, 'file'); assert.ok(pendingSync.seq < linked.seq);
      }
      if (event.op === 'unlinkSync' && linked && event.paths[0] === linked.paths[0]) unlinked = event;
      const hit = point === 'native-close-response-loss' ? event === closed
        : point === 'candidate-file-sync-response-loss' ? event === fileSync
          : point === 'candidate-directory-sync-response-loss' ? event === dirSync
            : event.op === 'fsync' && event.path === s.dir && unlinked;
      if (!hit || injections) return;
      assert.ok(commit.seq < closed.seq);
      if (fileSync) assert.ok(closed.seq < fileSync.seq);
      if (dirSync) assert.ok(fileSync.seq < dirSync.seq);
      if (point === 'paused-publication-directory-sync-response-loss') {
        assert.equal(event.fdType, 'directory'); assert.ok(linked.seq < unlinked.seq && unlinked.seq < event.seq);
        assert.equal(fs.existsSync(pausedPath), true); assert.equal(fs.existsSync(linked.paths[0]), false);
      } else assert.equal(fs.existsSync(pausedPath), false);
      assert.deepEqual(controls.map(path => child('probe-lock.js', [path]).acquired), [false, false, false]);
      injections++; faultPhase = { point, event, begin, mutation, commit, closed, fileSync, dirSync, pendingSync, linked, unlinked };
      throw Error('test-owned native response loss');
    });
    let outer;
    try {
      outer = caught(() => scope(target, context, session => {
        const issued = session.claimConversion({});
        inner = caught(() => session.ensurePaused({}));
        returnedIssued = true; return issued;
      }));
    } finally { observer.restore(); }
    // Do this before any assertion that could end the test and trigger cleanup.
    for (const path of controls) assert.equal(child('probe-lock.js', [path]).acquired, true);
    assert.equal(injections, 1); assert.equal(returnedIssued, true);
    safeError(inner.error, 'RECOVERY_DURABILITY_UNCERTAIN'); safeError(outer.error, 'RECOVERY_DURABILITY_UNCERTAIN');
    assert.equal(outer.value, undefined);
    const afterLogical = logical(s.path);
    assert.deepEqual(afterLogical.schema, beforeLogical.schema);
    for (const [table, rows] of Object.entries(beforeLogical.rows)) assert.deepEqual(afterLogical.rows[table], table === 'im_settings'
      ? rows.map(row => JSON.stringify({ ...JSON.parse(row), write_mode: 'paused' })) : rows, table);
    const after = tree(s.f.root), changed = `conversion-workspace/runs/${s.staged.runId}/candidate.sqlite`;
    for (const [path, value] of Object.entries(before)) if (path !== changed) assert.equal(after[path], value, path);
    assert.equal(fs.readdirSync(s.dir).some(name => /\.pending$|-(wal|shm|journal)$/.test(name)), false);
    assert.ok(fs.existsSync(join(s.dir, 'conversion-owner.json'))); assert.ok(fs.existsSync(join(s.dir, 'conversion-pause-intent.json')));
    const evidence = tree(s.f.root), retryObserver = observeNative();
    try {
      if (point !== 'paused-publication-directory-sync-response-loss') {
        assert.equal(fs.existsSync(pausedPath), false);
        assert.throws(s.target, { code: 'RECOVERY_INDETERMINATE' });
        assert.deepEqual(retryObserver.events.filter(e => ['mutation', 'write', 'fsync', 'linkSync', 'unlinkSync'].includes(e.op)), []);
      } else {
        const reopened = s.target();
        assert.equal(scope(reopened, context, session => session.inspectIntake({})).phase, 'PAUSED');
        const records = scope(reopened, context, session => session.readConversionRecords({}));
        assert.ok(records.owner && records.pauseIntent && records.paused);
        assert.deepEqual(retryObserver.events.filter(e => ['mutation', 'write', 'fsync', 'linkSync', 'unlinkSync'].includes(e.op)), []);
        const retry = scope(reopened, context, session => { session.claimConversion({}); return session.ensurePaused({}); });
        assert.equal(retry.replayed, true);
        assert.deepEqual({ version: retry.version, owner: retry.owner, pauseIntent: retry.pauseIntent, paused: retry.paused }, records);
        for (const name of ['candidate.sqlite', 'conversion-owner.json', 'conversion-pause-intent.json', 'conversion-paused.json']) {
          const file = retryObserver.events.find(e => e.op === 'fsync' && e.path === join(s.dir, name));
          assert.equal(file?.fdType, 'file', name);
          assert.ok(retryObserver.events.some(e => e.op === 'fsync' && e.path === s.dir && e.fdType === 'directory' && e.seq > file.seq), name);
        }
        assert.deepEqual(retryObserver.events.filter(e => ['mutation', 'write', 'linkSync', 'unlinkSync'].includes(e.op)), []);
      }
    } finally { retryObserver.restore(); }
    assert.deepEqual(tree(s.f.root), evidence);
    for (const path of controls) assert.equal(child('probe-lock.js', [path]).acquired, true);
    t.diagnostic(JSON.stringify({ ...faultPhase, injectionCount: injections, caughtAndReturnedIssued: returnedIssued,
      nativeResponseLossOnly: true, closeFailedStillOpenCovered: false }));
  });
}
