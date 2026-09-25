import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createImV2RecoveryServices } from '../src/im/v2/recovery.js';
import { hashRecoveryRecord, decodeRecoveryRecord, encodeRecoveryRecord } from '../src/im/v2/recovery-plan.js';
import { fixture, unsupported } from './fixtures/im-v2-backup/helpers.js';
import { policy } from './fixtures/im-v2-schema/helpers.js';
import { setup, context, tree, query, snapshot } from './fixtures/im-v2-recovery-release/helpers.js';
import { observe } from './fixtures/im-v2-recovery-release/observer.js';
import { child } from './fixtures/im-v2-recovery-activate/children.js';

const native = { skip: unsupported };
const keys = ['version', 'runId', 'candidateReference', 'state', 'stageHash', 'preparePlanHash', 'newEpoch', 'holdId', 'writeMode', 'nextAction', 'releasePlan', 'releasePlanHash'];
const failure = fn => assert.throws(fn, e => ['RECOVERY_EVIDENCE_MISMATCH', 'RECOVERY_INDETERMINATE'].includes(e.code));
const sixSyncs = ['candidate-file', 'candidate-directory', 'completion-file', 'completion-directory', 'marker-file', 'marker-directory'];
test('C2 actual registry clock below genuine completion refuses before marker I/O; equality publishes; same-factory throwing-clock retry resyncs six phases', native, async t => {
  const s = await setup(t, 'snapshot', false);
  const bindingPath = join(s.f.registryRoot, 'registry/holds', `${s.staged.holdId}.binding.json`);
  const binding = JSON.parse(fs.readFileSync(bindingPath));
  s.state.now = binding.boundAt + 2000;
  const seal = s.api.verifyRecovery(s.verifyInput, context);
  const plan = s.api.previewActivation(s.previewInput(seal), context);
  s.activationInput = s.activateInput(seal, plan);
  s.active = s.api.activateRecovery(s.activationInput, context);
  const completion = JSON.parse(fs.readFileSync(s.completion));
  assert.equal(completion.activatedAt, s.state.now);
  let registryNow = binding.boundAt + 1000, clockCalls = 0, throwClock = false;
  // The original factory's actual captured registry callback reads this property.
  // No replacement registry or unrelated recovery clock stands in for it.
  Object.defineProperty(s.registryClock, 'now', { get() { clockCalls++; if (throwClock) throw Error('TEST_ONLY registry clock must not run'); return registryNow; } });
  assert(binding.boundAt < registryNow && registryNow < completion.activatedAt);
  const status = s.status(), input = s.releaseInput();
  assert.equal(status.state, 'active'); assert.equal(status.nextAction, 'APPROVE_RELEASE_HOLD');
  assert.equal(status.releasePlan.activationCompletionHash, hashRecoveryRecord('activationCompletion', completion));
  const before = tree(s.root), registry = tree(s.f.registryRoot), source = fs.readFileSync(s.sourcePath), original = snapshot(s.f.db);
  const watch = observe(s); clockCalls = 0;
  try {
    assert.throws(() => s.api.releaseRecoveryHold(input, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
    assert.equal(clockCalls, 1, 'actual C0 publication clock was sampled');
    assert.deepEqual(watch.markerIO, [], 'no marker write-open/write/link/unlink/fsync');
    assert.deepEqual(watch.events.map(e => e.phase), sixSyncs.slice(0, 4));
    assert(watch.events.every(e => e.native));
  } finally { watch.restore(); }
  assert.deepEqual(tree(s.root), before); assert.deepEqual(tree(s.f.registryRoot), registry);
  assert.deepEqual(fs.readFileSync(s.sourcePath), source); assert.deepEqual(snapshot(s.f.db), original);
  assert.equal(fs.existsSync(s.marker), false); assert.deepEqual(s.status(), status);
  registryNow = completion.activatedAt; clockCalls = 0;
  const result = s.api.releaseRecoveryHold(input, context);
  assert.equal(result.state, 'released'); assert.equal(clockCalls, 1);
  const marker = fs.readFileSync(s.marker), inode = fs.statSync(s.marker).ino;
  assert.equal(JSON.parse(marker).releasedAt, completion.activatedAt);
  throwClock = true; clockCalls = 0;
  const retry = observe(s);
  try {
    assert.deepEqual(s.api.releaseRecoveryHold(input, context), result);
    assert.equal(clockCalls, 0);
    assert.deepEqual(retry.events.map(e => e.phase), sixSyncs); assert(retry.events.every(e => e.native));
    assert.deepEqual(retry.markerIO.map(e => e.operation), ['fsync', 'fsync']);
  } finally { retry.restore(); }
  assert.deepEqual(fs.readFileSync(s.marker), marker); assert.equal(fs.statSync(s.marker).ino, inode);
  assert.deepEqual(s.status(), { ...status, nextAction: 'NONE' }); assert.equal(clockCalls, 0);
  assert.deepEqual(tree(s.root), before); assert.deepEqual(fs.readFileSync(s.sourcePath), source); assert.deepEqual(snapshot(s.f.db), original);
  t.diagnostic(JSON.stringify({ boundAt: binding.boundAt, rejectedRegistryAt: binding.boundAt + 1000,
    activatedAt: completion.activatedAt, releasedAt: JSON.parse(marker).releasedAt, retryRegistryClockCalls: clockCalls,
    refusalNativePhases: watch.events, retryNativePhases: retry.events, refusalMarkerIO: watch.markerIO }));
});

test('C2 historical marker below genuine completion is malformed terminal proof and never repaired', native, async t => {
  const s = await setup(t, 'snapshot', false);
  const binding = JSON.parse(fs.readFileSync(join(s.f.registryRoot, 'registry/holds', `${s.staged.holdId}.binding.json`)));
  s.state.now = binding.boundAt + 2000;
  const seal = s.api.verifyRecovery(s.verifyInput, context), plan = s.api.previewActivation(s.previewInput(seal), context);
  s.api.activateRecovery(s.activateInput(seal, plan), context);
  const completion = JSON.parse(fs.readFileSync(s.completion)), status = s.status(), input = s.releaseInput();
  assert.equal(status.releasePlan.activationCompletionHash, hashRecoveryRecord('activationCompletion', completion));
  assert(binding.boundAt < completion.activatedAt);
  // Isolated historical corruption only; production may neither rewrite nor delete it.
  fs.writeFileSync(s.marker, JSON.stringify({ version: 1, holdId: input.holdId, recoveryRunId: input.runId,
    terminalState: 'active', stateEvidenceHash: status.releasePlan.activationCompletionHash, approvalRef: input.approvalRef,
    releasedAt: binding.boundAt }), { flag: 'wx', mode: 0o600 });
  const marker = fs.readFileSync(s.marker), inode = fs.statSync(s.marker).ino, before = tree(s.root), registry = tree(s.f.registryRoot);
  const watch = observe(s, { readonly: true });
  try {
    const malformed = s.status();
    assert.equal(malformed.state, 'indeterminate'); assert.equal(malformed.nextAction, 'MANUAL_RECONCILIATION');
    assert.equal(malformed.releasePlan, null); assert.equal(malformed.releasePlanHash, null);
    assert.throws(() => s.api.releaseRecoveryHold(input, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
    assert.deepEqual(watch.events, []); assert.deepEqual(watch.markerIO, []);
  } finally { watch.restore(); }
  assert.deepEqual(fs.readFileSync(s.marker), marker); assert.equal(fs.statSync(s.marker).ino, inode);
  assert.deepEqual(tree(s.root), before); assert.deepEqual(tree(s.f.registryRoot), registry);
});
test('C2 Windows strict protection reports unsupported', { skip: !unsupported }, t => {
  const f = fixture(t);
  assert.throws(() => createImV2RecoveryServices({ root: f.root, sourceCatalog: {}, policy: policy() }), { code: 'RECOVERY_UNSUPPORTED' });
});
test('C2 frozen pure codec accepts staged null epoch/enabled and active repair shape; v1 stays strict', () => {
  const value = { version: 2, runId: randomUUID(), candidateReference: null, state: 'staged', stageHash: 'a'.repeat(64),
    preparePlanHash: null, newEpoch: null, holdId: null, writeMode: 'enabled', nextAction: 'PREVIEW_PREPARE', releasePlan: null, releasePlanHash: null };
  value.candidateReference = `runs/${value.runId}/candidate.sqlite`;
  assert.deepEqual(decodeRecoveryRecord('statusV2', encodeRecoveryRecord('statusV2', value)), value);
  assert.throws(() => encodeRecoveryRecord('status', value), { code: 'RECOVERY_INVALID' });
  value.state = 'active'; value.preparePlanHash = 'b'.repeat(64); value.newEpoch = randomUUID(); value.writeMode = 'paused'; value.nextAction = 'RETRY_ACTIVATE';
  assert.deepEqual(decodeRecoveryRecord('statusV2', encodeRecoveryRecord('statusV2', value)), value);
});
for (const route of ['snapshot', 'registered-v3']) test(`C2 genuine ${route} release, readonly status/B retry, preserved source and exact six-sync retry`, native, async t => {
  const s = await setup(t, route), status = s.status(), input = s.releaseInput();
  assert.deepEqual(Object.keys(s.api), ['stageCandidate', 'previewRecovery', 'prepareRecovery', 'getRecoveryStatus', 'verifyRecovery', 'previewActivation', 'activateRecovery', 'releaseRecoveryHold']);
  assert.deepEqual(Object.keys(status), keys); assert.equal(status.version, 2);
  assert.equal(status.nextAction, 'APPROVE_RELEASE_HOLD'); assert.equal(status.releasePlanHash, hashRecoveryRecord('releasePlan', status.releasePlan));
  const original = snapshot(s.f.db), backup = fs.readFileSync(s.sourcePath), candidate = fs.readFileSync(s.path), workspace = tree(s.root);
  const result = s.api.releaseRecoveryHold(input, context);
  assert.deepEqual(result, { runId: input.runId, holdId: input.holdId, state: 'released', releasePlanHash: input.releasePlanHash });
  const marker = fs.readFileSync(s.marker), inode = fs.statSync(s.marker).ino, registry = tree(s.f.registryRoot);
  let clocks = 0;
  s.options.clock = () => { clocks++; throw Error('unexpected clock'); };
  const api = s.open(), watch = observe(s, { readonly: true });
  try {
    const released = api.getRecoveryStatus({ runId: input.runId }, context);
    assert.deepEqual(released, { ...status, nextAction: 'NONE' });
    assert.equal(api.prepareRecovery(s.prepareInput, context).status, 'active');
    assert.deepEqual(watch.events, []);
  } finally { watch.restore(); }
  const retry = observe(s);
  try {
    assert.deepEqual(api.releaseRecoveryHold(input, context), result);
    assert.deepEqual(retry.events.filter(e => e.operation === 'fsync').map(e => e.phase),
      ['candidate-file', 'candidate-directory', 'completion-file', 'completion-directory', 'marker-file', 'marker-directory']);
  } finally { retry.restore(); }
  assert.equal(clocks, 0); assert.deepEqual(fs.readFileSync(s.marker), marker); assert.equal(fs.statSync(s.marker).ino, inode);
  assert.deepEqual(tree(s.f.registryRoot), registry); assert.deepEqual(tree(s.root), workspace);
  assert.deepEqual(fs.readFileSync(s.path), candidate); assert.deepEqual(fs.readFileSync(s.sourcePath), backup); assert.deepEqual(snapshot(s.f.db), original);
  assert.deepEqual(s.services.registry.checkCleanup({ backupId: status.releasePlan.backupId }, context), { allowed: false, reason: 'HOLD' });
  assert.deepEqual(api.activateRecovery(s.activationInput, context), s.active);
  assert.throws(() => api.releaseRecoveryHold({ ...input, approvalRef: 'other' }, context), { code: 'RECOVERY_APPROVAL_DENIED' });
});
for (const route of ['fresh', 'closed-v3']) test(`C2 ${route} has no fabricated backup hold`, native, async t => {
  const s = await setup(t, route), status = s.status();
  assert.equal(status.nextAction, 'NONE'); assert.equal(status.holdId, null); assert.equal(status.releasePlan, null); assert.equal(status.releasePlanHash, null);
  const before = tree(s.root);
  failure(() => s.api.releaseRecoveryHold({ runId: s.staged.runId, holdId: randomUUID(), releasePlanHash: 'a'.repeat(64), approvalRef: 'release-ok' }, context));
  assert.deepEqual(tree(s.root), before);
});
for (const state of ['prepared', 'verified', 'failed']) test(`C2 ${state} cannot release`, native, async t => {
  const s = await setup(t, 'snapshot', false);
  if (state === 'verified') s.api.verifyRecovery(s.verifyInput, context);
  if (state === 'failed') {
    const db = new DatabaseSync(s.path);
    try { db.exec("UPDATE im_recovery_runs SET status='failed',failure_code='test-failure'"); } finally { db.close(); }
  }
  const before = tree(s.root), registry = tree(s.f.registryRoot), status = s.status();
  assert.equal(status.state, state); assert.equal(status.releasePlan, null);
  failure(() => s.api.releaseRecoveryHold({ runId: s.staged.runId, holdId: s.staged.holdId, releasePlanHash: 'a'.repeat(64), approvalRef: 'release-ok' }, context));
  assert.deepEqual(tree(s.root), before); assert.deepEqual(tree(s.f.registryRoot), registry);
});
test('C2 missing completion is active/RETRY_ACTIVATE; only exact activation repairs', native, async t => {
  const s = await setup(t), input = s.releaseInput(), bytes = fs.readFileSync(s.completion);
  fs.unlinkSync(s.completion);
  const before = tree(s.root), status = s.status();
  assert.equal(status.state, 'active'); assert.equal(status.nextAction, 'RETRY_ACTIVATE'); assert.equal(status.releasePlan, null); assert.equal(status.releasePlanHash, null);
  failure(() => s.api.releaseRecoveryHold(input, context));
  assert.deepEqual(tree(s.root), before); assert.equal(fs.existsSync(s.marker), false);
  assert.deepEqual(s.api.activateRecovery(s.activationInput, context), s.active);
  assert.deepEqual(fs.readFileSync(s.completion), bytes); assert.equal(s.status().nextAction, 'APPROVE_RELEASE_HOLD');
});
for (const artifact of ['hash', 'hold', 'binding', 'completion', 'plan', 'candidate', 'marker', 'malformed-marker', 'released-db']) test(`C2 forged ${artifact} cannot supply terminal authority`, native, async t => {
  const s = await setup(t), input = s.releaseInput();
  if (artifact === 'hash') input.releasePlanHash = 'a'.repeat(64);
  if (artifact === 'hold') input.holdId = randomUUID();
  if (artifact === 'binding') {
    const path = join(s.f.registryRoot, 'registry/holds', `${s.staged.holdId}.binding.json`), value = JSON.parse(fs.readFileSync(path));
    value.preparePlanHash = 'a'.repeat(64); fs.writeFileSync(path, JSON.stringify(value));
  }
  if (artifact === 'completion') { const value = JSON.parse(fs.readFileSync(s.completion)); value.activationApprovalRef = 'forged'; fs.writeFileSync(s.completion, JSON.stringify(value)); }
  if (artifact === 'plan') { const path = join(s.dir, `activation-${s.activationInput.activationPlanHash}.json`), value = JSON.parse(fs.readFileSync(path)); value.activationRef = 'forged'; fs.writeFileSync(path, JSON.stringify(value)); }
  if (['candidate', 'released-db'].includes(artifact)) {
    if (artifact === 'released-db') s.api.releaseRecoveryHold(input, context);
    const db = new DatabaseSync(s.path); try { db.exec("UPDATE im_recovery_runs SET activation_ref='forged'"); } finally { db.close(); }
  }
  if (artifact.includes('marker')) {
    const value = { version: 1, holdId: input.holdId, recoveryRunId: input.runId, terminalState: 'active', stateEvidenceHash: 'a'.repeat(64), approvalRef: 'release-ok', releasedAt: s.state.now };
    fs.writeFileSync(s.marker, artifact === 'malformed-marker' ? '{}' : JSON.stringify(value), { mode: 0o600 });
  }
  const before = tree(s.root), registry = tree(s.f.registryRoot);
  failure(() => s.api.releaseRecoveryHold(input, context));
  if (!['hash', 'hold'].includes(artifact)) {
    try { assert.equal(s.status().state, 'indeterminate'); } catch (e) { assert.equal(e.code, 'RECOVERY_EVIDENCE_MISMATCH'); }
  }
  assert.deepEqual(tree(s.root), before); assert.deepEqual(tree(s.f.registryRoot), registry);
});
test('C2 strict detached input, independent literal approvals, known async zero-prefix and thenable rejection', native, async t => {
  const s = await setup(t), input = s.releaseInput();
  for (const value of [{ ...input, stateEvidenceHash: 'a'.repeat(64) }, { ...input, holdId: 'bad' }, { ...input, verifyTerminal() {} }])
    assert.throws(() => s.api.releaseRecoveryHold(value, context), { code: 'RECOVERY_INVALID' });
  let calls = 0;
  s.options.approvalAuthority = { async authorizeApproval() { calls++; return true; } };
  assert.throws(() => s.open().releaseRecoveryHold(input, context), { code: 'RECOVERY_APPROVAL_DENIED' }); assert.equal(calls, 0);
  for (const value of [1, {}, null, false, Promise.reject(Error('private'))]) {
    s.options.approvalAuthority = { authorizeApproval: () => value };
    assert.throws(() => s.open().releaseRecoveryHold(input, context), { code: 'RECOVERY_APPROVAL_DENIED' });
  }
  s.options.authority = { async authorizeAdmin() { calls++; return true; } };
  assert.throws(() => s.open().releaseRecoveryHold(input, context), { code: 'RECOVERY_AUTH_DENIED' }); assert.equal(calls, 0);
  const detached = { ...input };
  s.options.authority = { authorizeAdmin() { detached.approvalRef = 'mutated'; return true; } };
  s.options.approvalAuthority = { authorizeApproval: request => request.kind === 'release-hold' && request.planHash === input.releasePlanHash && request.approvalRef === 'release-ok' };
  assert.equal(s.open().releaseRecoveryHold(detached, context).state, 'released');
  s.options.approvalAuthority = { authorizeApproval: () => true };
  failure(() => s.open().releaseRecoveryHold({ ...input, approvalRef: 'different-authorized-ref' }, context));
});
test('C2 final release approval revocation occurs after candidate/completion sync and before marker publication', native, async t => {
  const s = await setup(t), input = s.releaseInput(); let approvals = 0;
  s.options.approvalAuthority = { authorizeApproval() { return ++approvals === 1; } };
  const watch = observe(s);
  try { assert.throws(() => s.open().releaseRecoveryHold(input, context), { code: 'RECOVERY_APPROVAL_DENIED' }); }
  finally { watch.restore(); }
  assert.equal(approvals, 2); assert.equal(fs.existsSync(s.marker), false);
  assert.deepEqual(watch.events.map(e => e.phase), ['candidate-file', 'candidate-directory', 'completion-file', 'completion-directory']);
});

test('C2 independent source/workspace/candidate contenders remain BUSY through terminal verification, four syncs and publication', native, async t => {
  const s = await setup(t), input = s.releaseInput(), request = join(s.f.root, 'probe-request.json'), response = join(s.f.root, 'probe-response.json');
  const contender = child('../im-v2-recovery-release/contender.js', [request, response], true);
  const probes = []; let sequence = 0;
  try {
    assert.equal((await contender.message()).phase, 'ready');
    const probe = phase => {
      if (!['terminal-verify', 'candidate-file', 'candidate-directory', 'completion-file', 'completion-directory', 'marker-publish', 'marker-directory'].includes(phase)) return;
      for (const path of s.locks) {
        fs.writeFileSync(request, JSON.stringify({ sequence: ++sequence, directory: dirname(path) }), { mode: 0o600 });
        const until = Date.now() + 5000; let result;
        while (Date.now() < until) {
          try { result = JSON.parse(fs.readFileSync(response)); } catch { /* independent response is not yet complete */ }
          if (result?.sequence === sequence) break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
        assert.equal(result?.sequence, sequence); assert.equal(result.code, 'RECOVERY_BUSY'); probes.push({ phase, path, code: result.code });
      }
    };
    const watch = observe(s, { probe });
    try { assert.equal(s.api.releaseRecoveryHold(input, context).state, 'released'); }
    finally { watch.restore(); }
    assert.equal(probes.length, 21);
    contender.proc.send({ mode: 'stop' }); const result = await contender.result();
    t.diagnostic(JSON.stringify({ probes, ...result }));
    assert.equal(result.error, null); assert.deepEqual(result.exit, { code: 0, signal: null }); assert.deepEqual(result.close, result.exit);
  } finally { await contender.stop(); }
});

test('C2 staged snapshot preserves null epoch/enabled and cannot release; stale prepare never regenerates epoch', native, async t => {
  const s = await setup(t, 'snapshot', false, f => f.db.exec("UPDATE im_settings SET write_mode='enabled'"));
  const staged = s.api.stageCandidate({ requestRef: 'second', candidateKind: 'snapshot_recovery', sourceRef: 'source', isolationAckRef: 'isolated' }, context);
  const status = s.api.getRecoveryStatus({ runId: staged.runId }, context);
  assert.equal(status.state, 'staged'); assert.equal(status.newEpoch, null); assert.equal(status.nextAction, 'PREVIEW_PREPARE');
  assert.equal(status.writeMode, 'enabled'); assert.equal(status.releasePlan, null); assert.deepEqual(Object.keys(status), keys);
  failure(() => s.api.releaseRecoveryHold({ runId: staged.runId, holdId: staged.holdId, releasePlanHash: 'a'.repeat(64), approvalRef: 'release-ok' }, context));
  s.state.now += 900000;
  const before = tree(s.root);
  assert.equal(s.api.prepareRecovery(s.prepareInput, context).newEpoch, s.preview.preparePlan.newEpoch);
  assert.deepEqual(tree(s.root), before);
});

test('C2 current source closure/isolation and actual backup remain required after release', native, async t => {
  const s = await setup(t), input = s.releaseInput();
  let calls = 0;
  s.options.evidenceAuthority.authorizeSourceClosedEvidence = async () => { calls++; return true; };
  assert.throws(() => s.api.releaseRecoveryHold(input, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' }); assert.equal(calls, 0);
  s.options.evidenceAuthority.authorizeSourceClosedEvidence = () => Promise.reject(Error('private closure'));
  assert.throws(() => s.api.releaseRecoveryHold(input, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  s.options.evidenceAuthority.authorizeSourceClosedEvidence = () => true;
  s.state.isolated = false;
  assert.throws(() => s.api.releaseRecoveryHold(input, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  s.state.isolated = true; s.api.releaseRecoveryHold(input, context);
  const fd = fs.openSync(s.sourcePath, 'r+');
  try { fs.writeSync(fd, Buffer.from('corrupt'), 0, 7, 100); } finally { fs.closeSync(fd); }
  failure(() => s.status()); failure(() => s.api.prepareRecovery(s.prepareInput, context)); failure(() => s.api.releaseRecoveryHold(input, context));
  assert.equal(fs.existsSync(s.marker), true);
});

test('C2 post-publication terminal failure retains marker and exact retry revalidates real facts', native, async t => {
  const s = await setup(t), input = s.releaseInput(), candidate = fs.readFileSync(s.path);
  let replaced = false;
  const watch = observe(s, { probe(phase) {
    if (phase !== 'marker-directory' || replaced) return;
    const replacement = join(s.dir, 'replacement.sqlite');
    fs.writeFileSync(replacement, candidate, { mode: 0o600 }); fs.renameSync(replacement, s.path); replaced = true;
  } });
  try { failure(() => s.api.releaseRecoveryHold(input, context)); }
  finally { watch.restore(); }
  assert.equal(replaced, true); assert.equal(fs.existsSync(s.marker), true);
  const marker = fs.readFileSync(s.marker), inode = fs.statSync(s.marker).ino;
  assert.equal(s.open().releaseRecoveryHold(input, context).state, 'released');
  assert.deepEqual(fs.readFileSync(s.marker), marker); assert.equal(fs.statSync(s.marker).ino, inode);
  assert.deepEqual(fs.readFileSync(s.path), candidate);
});

for (const fault of ['candidate-file', 'candidate-directory', 'completion-file', 'completion-directory', 'marker-file', 'marker-directory'])
test(`C2 native published marker uncertainty then exited process ${fault} exact retry`, native, async t => {
  const publisher = child('../im-v2-recovery-release/process.js', ['publish'], true);
  let retry, persisted, safe = false;
  try {
    const first = await publisher.message(); assert.equal(first.phase, 'published'); persisted = first.persisted;
    publisher.proc.send({ mode: 'exit' });
    const exited = await publisher.result(); t.diagnostic(JSON.stringify({ role: 'publisher', ...exited, events: first.events }));
    assert.equal(exited.error, null); assert.deepEqual(exited.exit, { code: 0, signal: null }); assert.deepEqual(exited.close, exited.exit);
    retry = child('../im-v2-recovery-release/process.js', ['retry'], true);
    assert.equal((await retry.message()).phase, 'ready'); retry.proc.send({ ...persisted, fault });
    const report = await retry.message(), result = await retry.result();
    t.diagnostic(JSON.stringify({ role: 'retry', report, ...result }));
    assert.equal(report.phase, 'complete'); assert.equal(result.error, null); assert.deepEqual(result.exit, { code: 0, signal: null }); assert.deepEqual(result.close, result.exit);
    safe = true;
  } finally {
    await retry?.stop(); await publisher.stop();
    if (safe && persisted) fs.rmSync(persisted.fixtureRoot, { recursive: true, force: true });
    else if (persisted) t.diagnostic(`retained evidence: ${persisted.fixtureRoot}`);
  }
});
