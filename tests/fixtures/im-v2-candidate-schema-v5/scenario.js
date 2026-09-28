// Dedicated test child. Clock controls are installed before ANY product import.
// They never change the OS clock or leak into node:test's parent process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { limits, V5, fields, hash, record, fileHash, files, snapshot, snapshotDb, inherited, retained, checkPlan, checkConverted, safeError, withDb } from './oracle.js';
import { runChild, successful } from './process.js';

const [scenario, variant = ''] = process.argv.slice(2);
assert.match(process.env.B02B_TERMINAL_SOURCE_HASH ?? '', /^[0-9a-f]{64}$/);
const nativeWall = Date.now, nativeMono = process.hrtime.bigint;
let wall = 1800000000000, monotonicOffset = 0n, clockReads = 0;
let budgetElapsed = 0;
if (scenario === 'shared-budget') Object.defineProperty(performance, 'now', { configurable: true, value: () => budgetElapsed });
Date.now = () => { clockReads++; return wall; };
process.hrtime.bigint = () => nativeMono() + monotonicOffset;
const report = { scenario, variant, argv: process.argv, pid: process.pid, terminalSourceHash: process.env.B02B_TERMINAL_SOURCE_HASH,
  node: process.version, sqlite: null, fixedWall: wall, startedNativeWall: nativeWall(), validated: false, cleanupErrors: [] };
const cleanups = [], t = { after(fn) { cleanups.push(fn); }, diagnostic(value) { (report.diagnostics ??= []).push(value); } };
let observer;
const M = 'MAINTENANCE_', invalid = M + 'INVALID';
function refuses(call, allowed = [M + 'CONVERSION_CONFLICT', M + 'TARGET_STALE', M + 'DURABILITY_UNCERTAIN', 'RECOVERY_EVIDENCE_MISMATCH', 'RECOVERY_INDETERMINATE']) {
  let e; try { call(); } catch (error) { e = error; }
  assert.ok(e, 'operation must refuse'); assert.ok(allowed.includes(e.code), `unexpected ${e.code}: ${e.message}`); assert.equal(e.message, e.code);
  return { code: e.code, message: e.message };
}
const sqlWrite = e => e.op === 'mutation' || e.op === 'exec' && /^\s*(?:CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(e.sql);
const isTransition = e => (e.op === 'mutation' || e.op === 'exec') && /INSERT\s+INTO\s+["`\[]?im_center_schema_transitions\b/i.test(e.sql);
function exactBusy(path, expected) {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./probe-supervisor.js', import.meta.url)), path], { encoding: 'utf8', timeout: 20000 });
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout); assert.equal(out.connectionClosed, true); assert.equal(out.acquired, !expected);
  assert.equal(out.sqliteCode, expected ? 5 : null); assert.deepEqual(out.lifecycle.exit, { code: 0, signal: null });
  assert.deepEqual(out.lifecycle.close, { code: 0, signal: null }); assert.deepEqual(out.lifecycle.errors, []);
  (report.contenders ??= []).push({ path, ...out });
}
function closedBeforeSync(events, path) {
  const live = new Set(); let syncs = 0;
  for (const event of events) {
    if (event.path !== path) continue;
    if (event.op === 'db-seen') live.add(event.connection);
    if (event.op === 'db-close') { assert.equal(event.isOpen, false); live.delete(event.connection); }
    if (event.op === 'fsync') { syncs++; assert.equal(live.size, 0, 'all observed candidate readers/writers closed before candidate sync'); }
  }
  assert.ok(syncs > 0, 'candidate sync actually observed'); assert.equal(live.size, 0);
}
try {
  // Only terminal immutable candidates may reach this import closure.
  const [{ setup, context, openWorkspace }, runtime, { withRecoveryConversionScope: scope }, { assertImSchemaV5 }, { assertImSchemaV4 }, { observeNative }] = await Promise.all([
    import('../im-v2-recovery-conversion-target/helpers.js'), import('../../../src/im/v2/candidate-schema-v5-converter.js'),
    import('../../../src/im/v2/recovery-conversion-target.js'), import('../../../src/im/v2/schema-v5.js'),
    import('../../../src/im/v2/schema.js'), import('./native-observer.js'),
  ]);
  const { createCandidateSchemaV5Converter: create } = runtime;
  const memory = new DatabaseSync(':memory:'); report.sqlite = memory.prepare('SELECT sqlite_version() AS v').get().v; memory.close();
  assert.equal(process.version, 'v24.19.0'); assert.equal(report.sqlite, '3.53.3');
  let adminAllowed = true, approvalAllowed = true, approverId = 'independent', resolveHook, authorizeHook, adminHook;
  const calls = [], hooks = {};
  const route = scenario === 'intake' ? variant.replace('-enabled', '') : scenario === 'source-gate' ? 'closed-v3' : ['locks', 'old-facades'].includes(scenario) ? 'snapshot' : 'fresh';
  const s = await setup(t, route, variant === 'snapshot-enabled' || scenario === 'locks', hooks);
  report.fixtureRoot = s.f.root;
  const authority = { authorizeAdmin: ctx => { adminHook?.(); return ctx === context && adminAllowed; } };
  const approvalAuthority = {
    resolveApproval(input, ctx) { calls.push({ method: 'resolve', input: { ...input }, sameContext: ctx === context }); return resolveHook ? resolveHook(input, ctx) : { approverId }; },
    authorizeApproval(input, ctx) { calls.push({ method: 'authorize', input: { ...input }, sameContext: ctx === context }); return authorizeHook ? authorizeHook(input, ctx) : approvalAllowed; },
  };
  const target = s.target(), options = { target, authority, approvalAuthority, executorId: 'executor', limits: { ...limits } };
  const make = patch => create({ ...options, ...patch });
  const constructorBefore = files(s.dir), converter = make(); assert.deepEqual(files(s.dir), constructorBefore);
  const before = snapshot(s.path), stageFiles = files(s.dir), sourceHash = s.source && fileHash(s.source);
  const originalSnapshot = snapshotDb(s.f.db);
  const historicalRoot = join(s.f.root, 'historical-workspace', 'runs');
  const historical = fs.existsSync(historicalRoot) ? fs.readdirSync(historicalRoot).map(run => join(historicalRoot, run, 'candidate.sqlite')) : [];
  const historicalHashes = historical.map(path => [path, fileHash(path)]);
  let preview, request, pausedBefore;
  function plan() {
    preview = converter.previewConversion({}, context); pausedBefore = snapshot(s.path);
    checkPlan(s, preview, fileHash(s.path));
    request = { transitionId: preview.plan.transitionId, planHash: preview.planHash, approvalRef: 'approved' };
    return preview;
  }
  function converted(result, extras = {}) { return checkConverted(s, preview, result, pausedBefore, assertImSchemaV5, extras); }
  function observe(after) { observer?.restore(); observer = observeNative(after); return observer; }
  function stop() { observer?.restore(); return observer?.events ?? []; }
  function unchangedV4(hash) {
    assert.equal(fileHash(s.path), hash); assert.equal(withDb(s.path, assertImSchemaV4), true);
    assert.equal(withDb(s.path, db => db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='im_center_schema_transitions'").get().n), 0);
    assert.equal(fs.existsSync(join(s.dir, 'conversion-complete.json')), false);
  }
  function approvalBindings() {
    const p = preview.plan, expected = { kind: 'candidate-schema-conversion', planHash: preview.planHash, approvalRef: 'approved',
      instanceId: p.instanceId, instanceCreatedAt: p.instanceCreatedAt, centerEpoch: p.centerEpoch, executorId: 'executor' };
    assert.ok(calls.filter(c => c.method === 'resolve').length >= 1);
    assert.ok(calls.filter(c => c.method === 'authorize').length >= 2, 'approval repeated before mutation and final commit');
    for (const c of calls) { assert.equal(c.sameContext, true); assert.deepEqual(c.input, c.method === 'resolve' ? expected : { ...expected, approverId: 'independent' }); }
  }
  if (scenario === 'intake' || scenario === 'approval-bindings') {
    plan(); inherited(before, pausedBefore, variant === 'snapshot-enabled');
    const planFiles = files(s.dir), replay = converter.previewConversion({}, context);
    assert.deepEqual(replay, { ...preview, replayed: true }); assert.deepEqual(files(s.dir), planFiles);
    retained(stageFiles, files(s.dir), ['candidate.sqlite']);
    observe(); const result = converter.convertCandidate(request, context); stop();
    report.conversionEvents = [...observer.events];
    converted(result); approvalBindings();
    closedBeforeSync(observer.events, s.path);
    const writes = observer.events.filter(e => e.path === s.path && sqlWrite(e));
    assert.equal(writes.filter(isTransition).length, 1);
    for (const event of writes) { assert.equal(event.foreignKeys, 1); assert.equal(event.transaction, true); assert.equal(event.nlink, 1); }
    assert.equal(new Set(writes.map(e => e.connection)).size, 1, 'one privately owned mutation connection');
    const commits = observer.events.filter(e => e.path === s.path && e.op === 'exec' && /^COMMIT\s*;?$/i.test(e.sql));
    assert.equal(commits.length, 1); assert.equal(commits[0].transaction, false);
    assert.ok(observer.events.some(e => e.path === s.path && e.op === 'exec' && /^BEGIN IMMEDIATE\s*;?$/i.test(e.sql) && e.transaction));
    assert.equal(observer.events.some(e => /foreign_keys\s*=\s*(?:OFF|0)/i.test(e.sql ?? '')), false);
    const after = files(s.dir), rows = snapshot(s.path); calls.length = 0;
    observe(); const exact = make({ target: s.target() }).convertCandidate(request, context); stop();
    converted(exact, { replayed: true }); assert.deepEqual(exact, { ...result, replayed: true });
    assert.deepEqual(calls, []); assert.deepEqual(snapshot(s.path), rows); assert.deepEqual(files(s.dir), after);
    closedBeforeSync(observer.events, s.path);
    assert.deepEqual(observer.events.filter(sqlWrite), []);
    for (const name of ['candidate.sqlite', 'conversion-complete.json']) {
      const e = observer.events.find(e => e.op === 'fsync' && e.path === join(s.dir, name)); assert.equal(e?.fdType, 'file');
      assert.ok(observer.events.some(d => d.op === 'fsync' && d.path === s.dir && d.seq > e.seq && d.fdType === 'directory'));
    }
    safeError(() => converter.previewConversion({}, context), M + 'CONVERSION_CONFLICT');
    report.result = result; report.events = observer.events;
  } else if (scenario === 'surface') {
    assert.deepEqual(Object.keys(runtime), ['createCandidateSchemaV5Converter']);
    assert.deepEqual(Object.keys(converter), ['previewConversion', 'convertCandidate']); assert.ok(Object.isFrozen(converter));
    assert.deepEqual(Object.keys(s.api), ['stageCandidate', 'previewRecovery', 'prepareRecovery', 'getRecoveryStatus', 'verifyRecovery', 'previewActivation', 'activateRecovery', 'releaseRecoveryHold']);
    for (const [key, value] of Object.entries({ clock: () => wall, path: s.path, db: s.f.db, sql: 'SELECT 1', plan: {}, writer: () => {} })) {
      safeError(() => make({ [key]: value }), invalid);
    }
    let prefixes = 0;
    for (const key of ['authorizeAdmin']) safeError(() => make({ authority: { [key]: async () => { prefixes++; return true; } } }), invalid);
    for (const key of ['resolveApproval', 'authorizeApproval']) safeError(() => make({ approvalAuthority: { ...approvalAuthority, [key]: async () => { prefixes++; return true; } } }), invalid);
    assert.equal(prefixes, 0); assert.deepEqual(files(s.dir), constructorBefore);
  } else if (scenario === 'limits') {
    for (const key of Object.keys(limits)) {
      const missing = { ...limits }; delete missing[key]; safeError(() => make({ limits: missing }), invalid);
      for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, true, limits[key] + 1]) safeError(() => make({ limits: { ...limits, [key]: value } }), invalid);
    }
    safeError(() => make({ limits: { ...limits, extra: 1 } }), invalid);
    const { createImV2RecoveryServices, createRecoveryConversionTarget } = await import('../../../src/im/v2/recovery.js');
    const lower = createImV2RecoveryServices({ ...s.options, limits: { maxMessages: 9999 } });
    const lowerTarget = createRecoveryConversionTarget(lower, { runId: s.staged.runId }, context);
    safeError(() => make({ target: lowerTarget }), invalid);
    assert.ok(make({ target: lowerTarget, limits: { ...limits, maxMessages: 9999 } }));
    assert.deepEqual(files(s.dir), constructorBefore);
  } else if (scenario === 'capabilities') {
    let traps = 0; const fake = new Proxy({}, { ownKeys() { traps++; throw Error('secret'); }, getPrototypeOf() { traps++; throw Error('secret'); }, get() { traps++; throw Error('secret'); } });
    for (const target of [{}, { ...options.target }, fake, null]) safeError(() => make({ target }), invalid);
    assert.equal(traps, 0);
    let escaped;
    scope(target, context, session => { escaped = session; assert.deepEqual(Object.keys(session), ['inspectIntake', 'readConversionRecords', 'claimConversion', 'ensurePaused', 'publishConversionPlan', 'applyApprovedConversion', 'finishConversion']); return session.inspectIntake({}); });
    // §12 extends the visible internal session, but ordinary consumers lack the
    // hidden converter binding. Correct-shaped arguments cannot authorize it.
    for (const [method, input] of [
      ['publishConversionPlan', {}],
      ['applyApprovedConversion', { transitionId: s.staged.runId, planHash: 'a'.repeat(64), approvalRef: 'approved' }],
      ['finishConversion', { transitionId: s.staged.runId, planHash: 'a'.repeat(64) }],
    ]) safeError(() => scope(target, context, session => session[method](input)), 'RECOVERY_INVALID');
    safeError(() => escaped.inspectIntake({}), 'RECOVERY_INVALID');
    const copied = { ...converter }; safeError(() => copied.previewConversion({}, context), invalid);
    const bare = converter.previewConversion; safeError(() => bare({}, context), invalid);
    target.invalidate(); refuses(() => converter.previewConversion({}, context), [invalid, M + 'TARGET_STALE', 'RECOVERY_INVALID']);
    assert.deepEqual(files(s.dir), constructorBefore);
    assert.ok(make({ target: s.target() }));
    const stale = s.target(); fs.renameSync(s.path, join(s.f.root, 'replaced.sqlite')); fs.writeFileSync(s.path, fs.readFileSync(join(s.f.root, 'replaced.sqlite')), { mode: 0o600 });
    refuses(() => make({ target: stale }).previewConversion({}, context));
  } else if (scenario === 'strict-inputs') {
    let traps = 0; const proxy = new Proxy({}, { ownKeys() { traps++; throw Error('secret'); }, getPrototypeOf() { traps++; throw Error('secret'); }, get() { traps++; throw Error('secret'); } });
    const accessor = Object.defineProperty({}, 'extra', { enumerable: true, get() { traps++; throw Error('secret'); } });
    for (const input of [null, [], Object.create(null), { extra: 1 }, { [Symbol()]: 1 }, accessor, proxy]) safeError(() => converter.previewConversion(input, context), invalid);
    assert.equal(traps, 0); assert.deepEqual(files(s.dir), constructorBefore);
    plan(); const current = files(s.dir);
    for (const input of [null, [], { ...request, path: s.path }, { ...request, plan: preview.plan }, { ...request, approvalRef: '' }, { ...request, transitionId: request.transitionId.toUpperCase() }, proxy]) safeError(() => converter.convertCandidate(input, context), invalid);
    assert.equal(traps, 0); assert.deepEqual(files(s.dir), current);
    assert.equal(calls.length, 0);
  } else if (scenario === 'callbacks') {
    plan(); const prehash = fileHash(s.path);
    for (const bad of [null, true, { approverId: 'independent', extra: 1 }, Object.create(null)]) {
      resolveHook = () => bad; safeError(() => converter.convertCandidate(request, context), M + 'APPROVAL_DENIED'); unchangedV4(prehash);
    }
    let traps = 0;
    resolveHook = () => new Proxy({}, { ownKeys() { traps++; throw Error('secret'); }, getPrototypeOf() { traps++; throw Error('secret'); }, get() { traps++; throw Error('secret'); } });
    safeError(() => converter.convertCandidate(request, context), M + 'APPROVAL_DENIED'); assert.equal(traps, 0);
    resolveHook = () => Promise.reject(Error('callback private secret'));
    safeError(() => converter.convertCandidate(request, context), M + 'APPROVAL_DENIED'); await new Promise(resolve => setImmediate(resolve));
    resolveHook = undefined;
    for (const value of [1, 'true', {}, Promise.resolve(true)]) {
      authorizeHook = () => value; safeError(() => converter.convertCandidate(request, context), M + 'APPROVAL_DENIED'); unchangedV4(prehash);
    }
    authorizeHook = () => { throw undefined; }; safeError(() => converter.convertCandidate(request, context), M + 'APPROVAL_DENIED'); unchangedV4(prehash);
  } else if (['wrong-approval', 'self-approval', 'final-revocation', 'final-admin-revocation', 'reentry'].includes(scenario)) {
    plan(); const prehash = fileHash(s.path); let reached = 0;
    if (scenario === 'wrong-approval') approvalAllowed = false;
    if (scenario === 'self-approval') approverId = 'executor';
    if (scenario === 'reentry') resolveHook = () => { reached++; safeError(() => converter.previewConversion({}, context), invalid); return { approverId: 'independent' }; };
    observe(e => { if (e.path === s.path && isTransition(e)) { reached++; if (scenario === 'final-revocation') approvalAllowed = false; if (scenario === 'final-admin-revocation') adminAllowed = false; } });
    const error = safeError(() => converter.convertCandidate(request, context), scenario === 'reentry' ? invalid : scenario === 'final-admin-revocation' ? M + 'AUTH_DENIED' : M + 'APPROVAL_DENIED'); stop();
    if (scenario.startsWith('final-') || scenario === 'reentry') assert.equal(reached, 1);
    unchangedV4(prehash); report.error = error; report.events = observer.events;
  } else if (['ttl-expiry', 'wall-regression', 'final-wall-expiry', 'final-wall-regression', 'monotonic-deadline'].includes(scenario)) {
    plan(); const prehash = fileHash(s.path), planBytes = fs.readFileSync(join(s.dir, 'conversion-plan.json')); let reached = 0;
    if (scenario === 'ttl-expiry') {
      wall = preview.plan.expiresAt;
      safeError(() => converter.previewConversion({}, context), M + 'PLAN_STALE');
      safeError(() => converter.convertCandidate(request, context), M + 'PLAN_STALE');
      wall++; safeError(() => converter.previewConversion({}, context), M + 'PLAN_STALE');
    } else if (scenario === 'wall-regression') {
      wall = preview.plan.createdAt - 1;
      safeError(() => converter.convertCandidate(request, context), M + 'PLAN_STALE');
    } else {
      if (scenario === 'monotonic-deadline') wall = preview.plan.expiresAt - 2000;
      if (scenario === 'final-wall-regression') wall = preview.plan.createdAt + 10;
      observe(e => {
        if (e.path !== s.path || !isTransition(e)) return; reached++;
        if (scenario === 'final-wall-expiry') wall = preview.plan.expiresAt;
        else if (scenario === 'final-wall-regression') wall--;
        else monotonicOffset += 2001000000n; // Wall stays valid; only monotonic progress exhausts admitted 2000ms.
      });
      safeError(() => converter.convertCandidate(request, context), M + 'PLAN_STALE'); stop(); assert.equal(reached, 1);
      if (scenario === 'monotonic-deadline') assert.equal(wall, preview.plan.expiresAt - 2000);
    }
    unchangedV4(prehash); assert.deepEqual(fs.readFileSync(join(s.dir, 'conversion-plan.json')), planBytes);
    if (scenario === 'monotonic-deadline') {
      wall = preview.plan.createdAt + 1; monotonicOffset += 1000000n;
      observe();
      safeError(() => converter.convertCandidate(request, context), M + 'PLAN_STALE'); stop();
      assert.deepEqual(observer.events.filter(sqlWrite), []); unchangedV4(prehash);
    }
    report.clock = { wall, monotonicOffset: String(monotonicOffset), reached };
  } else if (scenario === 'shared-budget') {
    plan(); const prehash = fileHash(s.path); let transitioned = false, fired = 0, admitted = false;
    authorizeHook = () => {
      if (!admitted) { admitted = true; budgetElapsed = 6000; }
      else if (transitioned && variant === 'final-approval' && !fired) { fired++; budgetElapsed += 5000; }
      return true;
    };
    observe(e => {
      if (e.path !== s.path) return;
      if (isTransition(e)) transitioned = true;
      if (transitioned && variant === 'validation' && e.op === 'prepare' && !fired) { fired++; budgetElapsed += 5000; }
    });
    report.budgetError = safeError(() => converter.convertCandidate(request, context), M + 'READ_UNAVAILABLE'); stop();
    assert.equal(fired, 1); assert.equal(transitioned, true); assert.equal(budgetElapsed, 11000);
    unchangedV4(prehash); assert.ok(observer.events.some(e => e.path === s.path && e.op === 'exec' && e.sql === 'ROLLBACK'));
    report.events = observer.events; report.budgetElapsed = budgetElapsed;
  } else if (scenario === 'budget-caps') {
    plan(); const prehash = fileHash(s.path), saved = files(s.dir);
    for (const patch of [{ maxFileBytes: fs.statSync(s.path).size - 1 }, { maxMetadataEntries: 1 }]) {
      const capped = make({ limits: { ...limits, ...patch } }); observe();
      safeError(() => capped.convertCandidate(request, context), M + 'READ_UNAVAILABLE'); stop();
      unchangedV4(prehash); assert.deepEqual(files(s.dir), saved); assert.deepEqual(observer.events.filter(sqlWrite), []);
    }
  } else if (scenario === 'drift') {
    plan(); const db = new DatabaseSync(s.path); db.exec('PRAGMA foreign_keys=ON');
    try {
      if (variant === 'bytes') db.exec('PRAGMA user_version=17');
      if (variant === 'policy') db.exec("UPDATE im_retention_policies SET effective_at=effective_at+1");
      if (variant === 'identity') db.exec('UPDATE im_instance_identity SET created_at=created_at+1');
      if (variant === 'epoch') db.exec('UPDATE im_center_epochs SET created_at=created_at+1');
    } finally { db.close(); }
    const changed = fileHash(s.path); observe(); safeError(() => converter.convertCandidate(request, context), M + (['bytes', 'epoch'].includes(variant) ? 'DURABILITY_UNCERTAIN' : 'CONVERSION_CONFLICT')); stop();
    assert.equal(fileHash(s.path), changed); assert.deepEqual(observer.events.filter(sqlWrite), []);
    assert.equal(fs.existsSync(join(s.dir, 'conversion-complete.json')), false);
  } else if (scenario === 'precommit-rollback') {
    plan(); const prehash = fileHash(s.path); let injected = 0;
    observe(e => { if (e.path === s.path && isTransition(e) && !injected) { injected++; throw Error('native transition response lost before COMMIT'); } });
    refuses(() => converter.convertCandidate(request, context), [M + 'CONVERSION_CONFLICT', M + 'DURABILITY_UNCERTAIN', M + 'FACT_MISMATCH']); stop();
    assert.equal(injected, 1); unchangedV4(prehash);
    assert.ok(observer.events.some(e => e.path === s.path && e.op === 'exec' && /^ROLLBACK\s*;?$/i.test(e.sql) && !e.transaction));
    const result = converter.convertCandidate(request, context); converted(result); report.result = result;
  } else if (scenario === 'source-gate') {
    plan(); const prehash = fileHash(s.path); let sourceChecks = 0;
    hooks.isolation = () => { sourceChecks++; throw Error('current source isolation denied'); };
    safeError(() => converter.convertCandidate(request, context), M + 'CONVERSION_CONFLICT');
    assert.ok(sourceChecks > 0); unchangedV4(prehash); delete hooks.isolation;
    const result = converter.convertCandidate(request, context); converted(result);
    hooks.isolation = () => { sourceChecks++; throw Error('current source isolation denied on completed retry'); };
    const complete = files(s.dir);
    safeError(() => converter.convertCandidate(request, context), M + 'CONVERSION_CONFLICT');
    assert.deepEqual(files(s.dir), complete); delete hooks.isolation;
  } else if (scenario === 'invalidation') {
    plan(); const prehash = fileHash(s.path); let fired = 0;
    resolveHook = () => { fired++; target.invalidate(); return { approverId: 'independent' }; };
    refuses(() => converter.convertCandidate(request, context), [invalid, M + 'TARGET_STALE', 'RECOVERY_INVALID']);
    assert.equal(fired, 1); unchangedV4(prehash);
    resolveHook = undefined;
    const result = make({ target: s.target() }).convertCandidate(request, context); converted(result);
  } else if (scenario === 'unresolved-close') {
    plan(); let writer, committed = false, interceptions = 0;
    const nativeExec = DatabaseSync.prototype.exec, nativeClose = DatabaseSync.prototype.close;
    observe(); const observedExec = DatabaseSync.prototype.exec, observedClose = DatabaseSync.prototype.close;
    DatabaseSync.prototype.exec = function(sql) {
      const value = Reflect.apply(observedExec, this, [sql]);
      if (/CREATE TABLE im_center_schema_transitions/i.test(sql)) writer = this;
      if (this === writer && sql === 'COMMIT') committed = true;
      return value;
    };
    DatabaseSync.prototype.close = function() {
      if (this === writer && committed) { interceptions++; assert.equal(this.isOpen, true); throw Error('simulated native close refusal BEFORE native call'); }
      return Reflect.apply(observedClose, this, []);
    };
    try {
      safeError(() => converter.convertCandidate(request, context), M + 'DURABILITY_UNCERTAIN');
      assert.equal(committed, true); assert.equal(interceptions, 2); assert.equal(writer.isOpen, true);
      const commit = observer.events.find(e => e.path === s.path && e.op === 'exec' && e.sql === 'COMMIT'); assert.ok(commit);
      const later = observer.events.filter(e => e.seq > commit.seq);
      assert.deepEqual(later.filter(e => e.path === s.path && ['file-read', 'fsync', 'db-close'].includes(e.op)), []);
      assert.equal(fs.existsSync(join(s.dir, 'conversion-complete.json')), false);
      const start = observer.events.length;
      safeError(() => converter.convertCandidate(request, context), M + 'DURABILITY_UNCERTAIN');
      safeError(s.target, 'RECOVERY_INDETERMINATE');
      assert.deepEqual(observer.events.slice(start).filter(e => sqlWrite(e) || ['fsync', 'write', 'linkSync', 'unlinkSync', 'renameSync'].includes(e.op)), []);
      report.closeRefusal = { simulatedBeforeNative: true, interceptions, committed, remainedOpen: writer.isOpen };
    } finally {
      DatabaseSync.prototype.exec = nativeExec; DatabaseSync.prototype.close = nativeClose;
      if (writer?.isOpen) Reflect.apply(nativeClose, writer, []);
      report.ownedWriterClosedAfterAssertions = writer?.isOpen === false;
      assert.equal(report.ownedWriterClosedAfterAssertions, true); stop();
    }
    report.events = observer.events;
  } else if (['postcommit-response-loss', 'native-close-response-loss', 'candidate-file-sync-response-loss', 'candidate-dir-sync-response-loss', 'completion-pending-sync-response-loss', 'completion-final-dir-sync-response-loss'].includes(scenario)) {
    plan(); const locks = [join(s.root, 'requests', 'coordination.sqlite'), join(s.dir, 'coordination.sqlite')];
    let connection, transition, commit, closed, fileSync, dirSync, linked, pending, injected = 0;
    const completionPath = join(s.dir, 'conversion-complete.json');
    observe((e, events) => {
      if (e.path === s.path && isTransition(e)) { assert.equal(e.foreignKeys, 1); assert.equal(e.transaction, true); connection = e.connection; transition = e; }
      if (connection && e.connection === connection && e.op === 'exec' && /^COMMIT\s*;?$/i.test(e.sql)) { assert.equal(e.transaction, false); commit = e; }
      if (commit && e.connection === connection && e.op === 'db-close') { assert.equal(e.isOpen, false); closed = e; }
      if (closed && e.op === 'fsync' && e.path === s.path) fileSync ??= e;
      if (fileSync && e.op === 'fsync' && e.path === s.dir) dirSync ??= e;
      if (dirSync && e.op === 'fsync' && e.fdType === 'file' && e.path.endsWith('.pending')) {
        // Pending names are random UUIDs, not the final record's basename.
        // Identify the actual bounded canonical payload after native fsync.
        const payload = JSON.parse(fs.readFileSync(e.path));
        if (payload.schemaVersion === 5 && payload.transitionId === request.transitionId && payload.postconversionFileHash) pending ??= e;
      }
      if (e.op === 'linkSync' && e.paths[1] === completionPath) linked = e;
      const hit = scenario === 'postcommit-response-loss' ? e === commit
        : scenario === 'native-close-response-loss' ? e === closed
          : scenario === 'candidate-file-sync-response-loss' ? e === fileSync
            : scenario === 'candidate-dir-sync-response-loss' ? e === dirSync
              : scenario === 'completion-pending-sync-response-loss' ? e === pending
                : linked && e.op === 'fsync' && e.path === s.dir && e.seq > linked.seq;
      if (!hit || injected) return;
      assert.ok(transition && commit && transition.seq < commit.seq);
      for (const path of locks) exactBusy(path, true);
      injected++; report.fault = { transition, commit, closed, fileSync, dirSync, pending, linked, event: e };
      throw Error('owned real-native response loss: private secret');
    });
    let result;
    if (['postcommit-response-loss', 'native-close-response-loss'].includes(scenario)) result = converter.convertCandidate(request, context);
    else {
      let error;
      try { result = converter.convertCandidate(request, context); } catch (e) { error = e; }
      report.observedResult = result; report.observedError = error && { code: error.code, message: error.message };
      report.events = [...observer.events];
      if (!error) { report.postFaultSnapshot = snapshot(s.path); report.postFaultFiles = files(s.dir); }
      assert.ok(error, 'native close/sync/publication response loss must not return success');
      assert.equal(error.code, M + 'DURABILITY_UNCERTAIN'); assert.equal(error.message, error.code);
    }
    stop(); assert.equal(injected, 1); assert.equal(withDb(s.path, assertImSchemaV5), undefined);
    assert.equal(observer.events.filter(e => e.path === s.path && isTransition(e)).length, 1);
    assert.equal(observer.events.some(e => e.connection === connection && e.op === 'exec' && /^ROLLBACK/i.test(e.sql) && e.seq > commit.seq), false);
    for (const path of locks) exactBusy(path, false);
    if (result) {
      converted(result); assert.equal(result.replayed, false); closedBeforeSync(observer.events, s.path);
      assert.equal(observer.events.filter(e => e.path === s.path && e.op === 'exec' && /^DROP TABLE im_schema$/i.test(e.sql)).length, 1);
      const reopen = observer.events.find(e => e.op === 'db-seen' && e.path === s.path && e.seq > closed.seq);
      assert.ok(reopen && reopen.connection !== connection);
      assert.ok(observer.events.some(e => e.connection === reopen.connection && e.op === 'prepare' && /foreign_key_check/.test(e.sql)));
      assert.ok(fileSync && dirSync && pending && linked);
      const unlinked = observer.events.find(e => e.op === 'unlinkSync' && e.paths[0] === linked.paths[0]);
      assert.ok(fileSync.seq < dirSync.seq && dirSync.seq < pending.seq && pending.seq < linked.seq && linked.seq < unlinked.seq);
      assert.ok(observer.events.some(e => e.op === 'fsync' && e.path === s.dir && e.seq > unlinked.seq));
    }
    const after = snapshot(s.path), candidate = fileHash(s.path), priorCalls = calls.length;
    report.postFaultSnapshot = after; report.postFaultFiles = files(s.dir);
    if (scenario === 'completion-pending-sync-response-loss') {
      assert.ok(pending); assert.equal(linked, undefined); assert.equal(fs.existsSync(completionPath), false);
      const rows = withDb(s.path, db => db.prepare('SELECT * FROM im_center_schema_transitions').all());
      assert.equal(rows.length, 1);
      const reconstructed = { version: 1 };
      for (const key of fields.conversionPlan.slice(1)) reconstructed[key] = rows[0][key === 'createdAt' ? 'plan_created_at' : key === 'expiresAt' ? 'plan_expires_at' : key.replace(/[A-Z]/g, c => '_' + c.toLowerCase())];
      assert.deepEqual(reconstructed, preview.plan);
      assert.equal(rows[0].executor_id, 'executor'); assert.equal(rows[0].approver_id, 'independent');
      assert.equal(rows[0].approval_ref, request.approvalRef);
      const proof = { version: 1, plan: preview.plan, planHash: preview.planHash, approvalRef: request.approvalRef,
        executorId: 'executor', approverId: 'independent', convertedAt: rows[0].converted_at };
      assert.equal(rows[0].approved_plan_hash, preview.planHash);
      assert.ok(proof.convertedAt >= preview.plan.createdAt && proof.convertedAt < preview.plan.expiresAt);
      const p = preview.plan;
      assert.deepEqual(record(pending.path, 'conversionComplete'), { version: 1, transitionId: p.transitionId,
        planHash: preview.planHash, conversionProofHash: hash('conversionProof', proof), instanceId: p.instanceId,
        instanceCreatedAt: p.instanceCreatedAt, centerEpoch: p.centerEpoch, recoveryRunId: p.recoveryRunId,
        stageHash: p.stageHash, candidateReference: p.candidateReference, schemaVersion: 5, schemaChecksum: V5,
        preconversionFileHash: p.preconversionFileHash, postconversionFileHash: candidate });
      inherited(pausedBefore, after);
      const st = fs.statSync(pending.path, { bigint: true });
      report.pendingIdentity = { ino: String(st.ino), dev: String(st.dev), nlink: String(st.nlink), size: String(st.size), mtime: String(st.mtimeNs) };
      report.committedProof = proof;
    }
    const retry = scenario === 'completion-pending-sync-response-loss'
      ? await runChild('./restart-pending.js', [s.root, s.staged.runId])
      : await runChild('./restart.js', [s.root, s.staged.runId, JSON.stringify(request), String(preview.plan.expiresAt + 1)]);
    report.restart = retry; const output = successful(retry);
    if (scenario === 'completion-pending-sync-response-loss') {
      assert.equal(output.code, 'RECOVERY_INDETERMINATE'); assert.deepEqual(files(s.dir), report.postFaultFiles);
      assert.deepEqual(output.identity, report.pendingIdentity);
    } else { converted(output.result, { replayed: true }); assert.equal(output.approvalCalls, 0); assert.equal(output.clockReadsDuringConvert, 0); }
    assert.deepEqual(snapshot(s.path), after); assert.equal(fileHash(s.path), candidate); assert.equal(calls.length, priorCalls);
    report.events = observer.events;
  } else if (['completion-missing', 'completion-conflict', 'restart-expired'].includes(scenario)) {
    plan(); const result = converter.convertCandidate(request, context); converted(result);
    const completePath = join(s.dir, 'conversion-complete.json'), original = fs.readFileSync(completePath), candidate = fileHash(s.path), rows = snapshot(s.path);
    if (scenario === 'completion-conflict') {
      const modified = JSON.parse(original); modified.postconversionFileHash = 'a'.repeat(64);
      fs.writeFileSync(completePath, JSON.stringify(modified)); const conflict = fs.readFileSync(completePath);
      refuses(() => make({ target: s.target() }).convertCandidate(request, context));
      assert.deepEqual(fs.readFileSync(completePath), conflict);
    } else {
      if (scenario === 'completion-missing') fs.unlinkSync(completePath);
      const execution = await runChild('./restart.js', [s.root, s.staged.runId, JSON.stringify(request), String(preview.plan.expiresAt + 1)]);
      report.restart = execution; const output = successful(execution); converted(output.result, { replayed: true });
      assert.equal(output.approvalCalls, 0); assert.equal(output.clockReadsDuringConvert, 0);
      assert.deepEqual(fs.readFileSync(completePath), original);
    }
    assert.equal(fileHash(s.path), candidate); assert.deepEqual(snapshot(s.path), rows);
  } else if (scenario === 'old-facades') {
    plan(); const result = converter.convertCandidate(request, context); converted(result);
    const saved = files(s.dir), input = { runId: s.staged.runId }, h = 'a'.repeat(64);
    const methods = [() => s.api.stageCandidate(s.input, context), () => s.api.previewRecovery(input, context),
      () => s.api.prepareRecovery({ ...input, preparePlanHash: h, approvalRef: 'ok' }, context), () => s.api.getRecoveryStatus(input, context),
      () => s.api.verifyRecovery({ ...input, preparePlanHash: h }, context),
      () => s.api.previewActivation({ ...input, sealReference: 'seal', authReviewRef: 'auth', isolationAckRef: 'isolated', activationRef: 'activate' }, context),
      () => s.api.activateRecovery({ ...input, activationPlanHash: h, activationApprovalRef: 'ok', sealReference: 'seal' }, context),
      () => s.api.releaseRecoveryHold({ ...input, holdId: s.staged.holdId, releasePlanHash: h, approvalRef: 'ok' }, context)];
    const remint = s.target(); observe();
    for (const call of methods) safeError(call, 'RECOVERY_CONVERSION_PENDING');
    for (const name of ['inspectIntake', 'readConversionRecords', 'claimConversion', 'ensurePaused']) safeError(() => scope(remint, context, session => session[name]({})), 'RECOVERY_CONVERSION_PENDING');
    stop(); assert.deepEqual(files(s.dir), saved); assert.deepEqual(observer.events.filter(e => sqlWrite(e) || e.op === 'fsync'), []);
    const ownerPath = join(s.dir, 'conversion-owner.json'), owner = JSON.parse(fs.readFileSync(ownerPath)); owner.stageHash = 'a'.repeat(64); fs.writeFileSync(ownerPath, JSON.stringify(owner));
    const corrupted = files(s.dir), ownerBytes = fs.readFileSync(ownerPath);
    observe(); report.malformedOwnerStatus = s.api.getRecoveryStatus(input, context); stop();
    assert.deepEqual(report.malformedOwnerStatus, { version: 2, runId: input.runId, candidateReference: s.staged.candidateReference,
      state: 'indeterminate', stageHash: preview.plan.stageHash, preparePlanHash: null, newEpoch: null, holdId: null, writeMode: null,
      nextAction: 'MANUAL_RECONCILIATION', releasePlan: null, releasePlanHash: null });
    assert.deepEqual(observer.events.filter(e => sqlWrite(e) || ['fsync', 'write', 'linkSync', 'unlinkSync', 'renameSync'].includes(e.op)), []);
    assert.deepEqual(files(s.dir), corrupted); assert.deepEqual(fs.readFileSync(ownerPath), ownerBytes);
    report.statusEvents = [...observer.events]; observe();
    for (const [index, call] of methods.entries()) if (index !== 3) safeError(call, 'RECOVERY_EVIDENCE_MISMATCH');
    stop(); assert.deepEqual(files(s.dir), corrupted);
    assert.deepEqual(observer.events.filter(e => sqlWrite(e) || ['fsync', 'write', 'linkSync', 'unlinkSync', 'renameSync'].includes(e.op)), []);
    const { hashRecoveryRequestRef } = await import('../../../src/im/v2/recovery-plan.js');
    const locatorPath = join(s.root, 'requests', hashRecoveryRequestRef(s.input.requestRef) + '.json');
    const locator = JSON.parse(fs.readFileSync(locatorPath)); locator.stageHash = 'a'.repeat(64); fs.writeFileSync(locatorPath, JSON.stringify(locator));
    observe(); safeError(() => s.api.getRecoveryStatus(input, context), 'RECOVERY_EVIDENCE_MISMATCH'); stop();
    assert.ok(observer.events.some(e => e.op === 'file-read' && e.path === locatorPath));
    assert.deepEqual(observer.events.filter(e => sqlWrite(e) || ['fsync', 'write', 'linkSync', 'unlinkSync', 'renameSync'].includes(e.op)), []);
    report.invalidLocatorEvents = observer.events;
  } else if (scenario === 'locks') {
    plan(); const locks = [join(s.f.registryRoot, 'coordination.sqlite'), join(s.root, 'requests', 'coordination.sqlite'), join(s.dir, 'coordination.sqlite')];
    let ddl = 0, final = 0, linked = false;
    observe(e => {
      if (e.path === s.path && isTransition(e)) { ddl++; for (const path of locks) exactBusy(path, true); }
      if (e.op === 'linkSync' && e.paths[1] === join(s.dir, 'conversion-complete.json')) linked = true;
      if (linked && !final && e.op === 'fsync' && e.path === s.dir) { final++; for (const path of locks) exactBusy(path, true); }
    });
    const result = converter.convertCandidate(request, context); stop(); converted(result);
    assert.equal(ddl, 1); assert.equal(final, 1); for (const path of locks) exactBusy(path, false);
  } else if (scenario === 'unknown-evidence') {
    plan(); const unknown = join(s.dir, '.foreign.pending'); fs.writeFileSync(unknown, 'private unknown', { mode: 0o600 });
    const beforeUnknown = files(s.dir); safeError(() => converter.convertCandidate(request, context), M + 'DURABILITY_UNCERTAIN'); assert.deepEqual(files(s.dir), beforeUnknown);
  } else throw Error(`unhandled ${scenario}`);
  if (sourceHash) assert.equal(fileHash(s.source), sourceHash, 'original registered backup/closed source unchanged');
  assert.deepEqual(snapshotDb(s.f.db), originalSnapshot, 'all original live-center rows and schema unchanged');
  for (const [path, hash] of historicalHashes) assert.equal(fileHash(path), hash, 'historical original active center unchanged');
  report.validated = true;
} catch (error) {
  if (observer) report.events ??= observer.events;
  // Preserve RED fixture bytes for parent inspection. Existing genuine fixture
  // cleanup still closes native DB handles; its explicit retain switch prevents
  // only deletion of this child's owned temporary root.
  process.env.B02A_RETAIN_FIXTURES = '1'; report.retainedFixture = report.fixtureRoot;
  report.error = { code: error?.code, message: error?.message, stack: error?.stack }; process.exitCode = 1;
} finally {
  observer?.restore(); Date.now = nativeWall; process.hrtime.bigint = nativeMono;
  for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch (error) { report.cleanupErrors.push({ message: error.message, stack: error.stack }); }
  if (report.cleanupErrors.length) { report.validated = false; process.exitCode = 1; }
  report.finishedNativeWall = nativeWall(); process.stdout.write(JSON.stringify(report));
}
