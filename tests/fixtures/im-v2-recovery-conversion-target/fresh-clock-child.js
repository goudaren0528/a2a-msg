// Test child only. Install the deterministic domain before ANY product import.
// Natural mode never replaces Date.now and cannot infer an internal time sample.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const [mode, reportPath] = process.argv.slice(2);
assert.ok(['equal', 'below', 'natural'].includes(mode));
const nativeNow = Date.now, fixed = 1800000000000, samples = [], markers = [];
let suppliedWall = fixed, phase = 'before-import', belowArmed = false, sampleArmed = false, observer, s;
const report = { mode, pid: process.pid, argv: process.argv, startedNativeWall: nativeNow(),
  clockOverride: mode !== 'natural', fixedDomain: mode === 'natural' ? null : fixed,
  samples, markers, operations: [], snapshots: {}, outcome: 'UNEXPLAINED_FAILURE', validated: false, completed: false };
if (mode !== 'natural') Date.now = function testWall() {
  const stack = new Error().stack;
  const bridgeTimestamp = sampleArmed && /at timestamp \(/.test(stack) && /recovery\.js:/.test(stack);
  const supplied = belowArmed && bridgeTimestamp ? fixed - 1 : suppliedWall;
  if (bridgeTimestamp) samples.push({ phase, supplied, actualNativeWall: nativeNow(), stack,
    eventSequence: observer?.events.length ?? 0 });
  return supplied;
};
const cleanups = [], t = { after(fn) { cleanups.push(fn); }, diagnostic(value) { (report.fixtureDiagnostics ??= []).push(value); } };
const errorFact = error => ({ code: error?.code, message: error?.message, stack: error?.stack });
const forbidden = event => ['mutation', 'write', 'linkSync', 'unlinkSync', 'renameSync'].includes(event.op) ||
  event.op === 'exec' && /^\s*(UPDATE|INSERT|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM)\b/i.test(event.sql);
const sqlMutation = event => event.op === 'mutation' || event.op === 'exec' && /^\s*(UPDATE|INSERT|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM)\b/i.test(event.sql);
function evidence() {
  // Never raw-open a coordination inode while SQLite holds its native lock.
  return Object.fromEntries(fs.readdirSync(s.dir).sort().map(name => {
    const path = join(s.dir, name), st = fs.statSync(path, { bigint: true });
    return [name, { hash: name === 'coordination.sqlite' ? null : createHash('sha256').update(fs.readFileSync(path)).digest('hex'),
      size: String(st.size), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs) }];
  }));
}
function mark(name) { phase = name; markers.push({ phase, actualNativeWall: nativeNow(), eventSequence: observer?.events.length ?? 0 }); }
function preserved(before, after) { for (const [name, value] of Object.entries(before)) assert.deepEqual(after[name], value, name); }
function operation(name, floor, call) {
  mark(name);
  const op = { phase: name, floor, before: evidence(), eventStart: observer.events.length };
  report.operations.push(op); report.snapshots[name] = op.before;
  op.preNativeWall = nativeNow();
  try {
    const result = call(); op.postNativeWall = nativeNow(); op.successfulResult = true;
    report.snapshots[`${name}-after`] = evidence(); return result;
  }
  catch (error) {
    op.postNativeWall = nativeNow(); op.error = errorFact(error); op.successfulResult = false;
    report.failurePhase = name; throw error;
  } finally { op.eventEnd = observer.events.length; }
}
function fixedRefusal(error) {
  assert.equal(error?.code, 'RECOVERY_EVIDENCE_MISMATCH'); assert.equal(error.message, 'RECOVERY_EVIDENCE_MISMATCH');
}
try {
  const { setup, context, logical } = await import('./helpers.js');
  const { withRecoveryConversionScope: scope } = await import('../../../src/im/v2/recovery-conversion-target.js');
  const { hashRecoveryConversionRecord: hashRecord } = await import('../../../src/im/v2/recovery-conversion-records.js');
  const { observeNative } = await import('./native-observer.js');
  mark('setup'); s = await setup(t, 'fresh', false);
  report.fixture = s.f.root; report.staged = s.staged; report.logicalBefore = logical(s.path);
  const target = s.target();
  report.baseline = scope(target, context, session => session.inspectIntake({}));
  assert.equal(report.baseline.phase, 'UNCLAIMED'); assert.equal(report.baseline.currentWriteMode, 'paused');
  assert.deepEqual(scope(target, context, session => session.readConversionRecords({})), { version: 1, owner: null, pauseIntent: null, paused: null });
  const stagedRecord = JSON.parse(fs.readFileSync(join(s.dir, 'staged.json')));
  const clockRow = JSON.parse(report.logicalBefore.rows.im_clock[0]);
  report.persistedChronology = { stagedAt: stagedRecord.stagedAt, instanceCreatedAt: report.baseline.instanceCreatedAt,
    lastObservedAt: clockRow.last_observed_at };
  assert.ok(Object.values(report.persistedChronology).every(Number.isSafeInteger));
  report.persistedFloor = Math.max(...Object.values(report.persistedChronology));
  report.snapshots.baseline = evidence(); report.baselineValidated = true;
  observer = observeNative();
  try {
    report.result = scope(target, context, session => {
      report.firstClaim = operation('claim-first', report.persistedFloor, () => session.claimConversion({}));
      assert.equal(report.firstClaim.replayed, false);
      report.floor = report.firstClaim.owner.record.claimedAt;
      assert.ok(report.floor >= report.persistedFloor);
      report.secondClaim = operation('claim-second', report.floor, () => session.claimConversion({}));
      assert.equal(report.secondClaim.replayed, true); assert.deepEqual(report.secondClaim.owner, report.firstClaim.owner);
      report.claimed = operation('inspect-claimed', report.floor, () => session.inspectIntake({}));
      assert.equal(report.claimed.phase, 'CLAIMED');
      if (mode !== 'natural') assert.equal(report.floor, fixed);
      sampleArmed = true; belowArmed = mode === 'below';
      return operation('ensure-intent', report.floor, () => session.ensurePaused({}));
    });
  } catch (error) { report.outerError = errorFact(error); }
  finally {
    belowArmed = false; sampleArmed = false;
    report.lastEnteredPhase = phase; mark('scope-returned'); observer.restore(); report.nativeEvents = [...observer.events];
  }
  report.after = evidence(); report.logicalAfter = logical(s.path);
  assert.deepEqual(report.logicalAfter, report.logicalBefore);
  const last = report.operations.at(-1);
  preserved(last?.before ?? report.snapshots.baseline, report.after);
  assert.deepEqual(report.nativeEvents.filter(sqlMutation), []);

  function success(result, expectedOwner) {
    assert.ok(result); assert.equal(result.replayed, false); assert.equal(result.paused.record.changed, false);
    assert.deepEqual(result.owner, expectedOwner);
    assert.equal(result.owner.record.runId, s.staged.runId);
    assert.equal(result.owner.record.instanceId, report.baseline.instanceId);
    assert.equal(result.owner.record.centerEpoch, report.baseline.centerEpoch);
    assert.equal(result.owner.record.intakeFileHash, report.baseline.intakeFileHash);
    for (const kind of ['owner', 'pauseIntent', 'paused']) assert.equal(result[kind].recordHash, hashRecord(kind, result[kind].record));
    assert.equal(result.pauseIntent.record.ownerHash, result.owner.recordHash);
    assert.equal(result.paused.record.ownerHash, result.owner.recordHash);
    assert.equal(result.paused.record.pauseIntentHash, result.pauseIntent.recordHash);
    assert.equal(result.paused.record.pausedFileHash, report.baseline.intakeFileHash);
    assert.ok(result.owner.record.claimedAt >= report.persistedFloor);
    assert.ok(result.pauseIntent.record.createdAt >= result.owner.record.claimedAt);
    assert.ok(result.paused.record.pausedAt >= result.pauseIntent.record.createdAt);
    preserved(report.snapshots.baseline, evidence());
    assert.equal(scope(s.target(), context, session => session.inspectIntake({})).phase, 'PAUSED');
  }
  if (report.outerError) {
    fixedRefusal(report.outerError); assert.equal(report.result, undefined);
    assert.ok(last && last.phase === report.failurePhase && last.successfulResult === false);
    fixedRefusal(last.error);
    assert.deepEqual(report.after, last.before);
    const events = report.nativeEvents.slice(last.eventStart);
    assert.deepEqual(events.filter(forbidden), []);
    assert.equal(fs.existsSync(join(s.dir, 'conversion-pause-intent.json')), false);
    assert.equal(fs.existsSync(join(s.dir, 'conversion-paused.json')), false);
    if (last.phase === 'claim-first') {
      assert.equal(fs.existsSync(join(s.dir, 'conversion-owner.json')), false);
      assert.deepEqual(events.filter(e => e.op === 'fsync'), []);
    } else {
      assert.equal(last.phase, 'ensure-intent'); assert.equal(report.claimed.phase, 'CLAIMED');
      assert.equal(report.after['conversion-owner.json'].hash, createHash('sha256').update(fs.readFileSync(join(s.dir, 'conversion-owner.json'))).digest('hex'));
      assert.ok(events.filter(e => e.op === 'fsync').every(e => e.path === s.dir || e.path === join(s.dir, 'conversion-owner.json')));
    }
    report.refusalInvariants = { genuineBaseline: true, namedPhase: last.phase, exactFixedError: true, noSuccessfulResult: true,
      evidenceBytesMtimeCtimeSame: true, logicalCandidateSame: true, noForbiddenEvents: true, noNewPauseRecords: true,
      noOwner: last.phase === 'claim-first' ? true : null, preNativeWall: last.preNativeWall, postNativeWall: last.postNativeWall, floor: last.floor };
    if (mode === 'natural') {
      assert.ok(Number.isSafeInteger(last.floor));
      assert.ok(last.preNativeWall < last.floor && last.postNativeWall < last.floor, 'both native samples must be below the identified persisted floor');
      assert.equal(samples.length, 0);
      report.outcome = 'CLOCK_REGRESSION_OBSERVED_SAFE_REFUSAL';
      report.classificationLimit = 'Observed native pre/post chronology only; not proof of exact internal timestamp or guard firing';
    } else {
      assert.equal(mode, 'below'); assert.equal(last.phase, 'ensure-intent');
      assert.equal(samples.length, 1); assert.equal(samples[0].supplied, report.floor - 1);
      assert.equal(samples[0].phase, 'ensure-intent');
      assert.match(samples[0].stack, /^[ \t]+at timestamp \((?:[^()\r\n]*[\\/])?recovery\.js:[1-9]\d*:[1-9]\d*\)$/m);
      assert.ok(events.some(e => e.op === 'fsync' && e.path === join(s.dir, 'conversion-owner.json') && e.seq <= samples[0].eventSequence));
      // ONE same-input retry, after an explicit legitimate test-wall advance.
      const retained = evidence(), owner = report.firstClaim.owner;
      suppliedWall = report.floor + 1; report.retrySuppliedWall = suppliedWall; report.retryCount = 0;
      observer = observeNative(); sampleArmed = true;
      try {
        report.retryCount++;
        report.recoveryResult = scope(target, context, session => {
          report.retryClaim = operation('retry-claim', report.floor, () => session.claimConversion({}));
          assert.equal(report.retryClaim.replayed, true); assert.deepEqual(report.retryClaim.owner, owner);
          return operation('retry-ensure', report.floor, () => session.ensurePaused({}));
        });
      } finally { sampleArmed = false; observer.restore(); report.retryEvents = observer.events; }
      assert.equal(report.retryCount, 1); preserved(retained, evidence());
      assert.deepEqual(report.retryEvents.filter(sqlMutation), []);
      assert.deepEqual(logical(s.path), report.logicalBefore);
      success(report.recoveryResult, owner);
      assert.equal(report.recoveryResult.pauseIntent.record.createdAt, suppliedWall);
      assert.equal(report.recoveryResult.paused.record.pausedAt, suppliedWall);
      report.recoveryEvidence = evidence(); report.outcome = 'SUCCESS';
    }
  } else {
    assert.equal(report.failurePhase, undefined); assert.ok(report.firstClaim && report.secondClaim && report.claimed);
    success(report.result, report.firstClaim.owner);
    if (mode === 'equal') {
      assert.equal(samples.length, 2); assert.ok(samples.every(sample => sample.supplied === report.floor));
      assert.equal(report.result.pauseIntent.record.createdAt, report.floor); assert.equal(report.result.paused.record.pausedAt, report.floor);
    } else { assert.equal(mode, 'natural'); assert.equal(samples.length, 0); }
    report.outcome = 'SUCCESS';
  }
  report.validated = true; report.completed = true;
} catch (error) {
  report.assertionError = errorFact(error); report.outcome = 'UNEXPLAINED_FAILURE'; process.exitCode = 1;
} finally {
  try { observer?.restore(); } catch (error) { report.reportError = errorFact(error); }
  Date.now = nativeNow;
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch (error) { (report.cleanupErrors ??= []).push(errorFact(error)); }
  }
  if (report.reportError || report.cleanupErrors) { report.outcome = 'UNEXPLAINED_FAILURE'; report.validated = false; report.completed = false; process.exitCode = 1; }
  report.finishedNativeWall = nativeNow();
  try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); }
  catch (error) { report.reportError = errorFact(error); report.outcome = 'UNEXPLAINED_FAILURE'; report.validated = false; report.completed = false; process.exitCode = 1; }
  // Full report also survives on stdout if writing the report file failed.
  process.stdout.write(JSON.stringify(report));
}
