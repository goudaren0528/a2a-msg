import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { createImV2RecoveryServices } from '../src/im/v2/recovery.js';
import { sha } from '../src/im/v2/recovery-records.js';
import { fixture, unsupported } from './fixtures/im-v2-backup/helpers.js';
import { policy } from './fixtures/im-v2-schema/helpers.js';
import { setup, context, query, tree, business, typedBusiness, snapshot } from './fixtures/im-v2-recovery-activate/helpers.js';
import { child } from './fixtures/im-v2-recovery-activate/children.js';
import { createImV2Auth } from '../src/im/v2/auth.js';
import { DEFAULT_MAINTENANCE } from '../src/im/v2/config.js';

const native = { skip: unsupported };
const floor = s => query(s.path, db => db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at);
const run = s => query(s.path, db => db.prepare('SELECT * FROM im_recovery_runs WHERE run_id=?').get(s.staged.runId));
function planned(s) {
  const seal = s.api.verifyRecovery(s.verifyInput, context);
  const plan = s.api.previewActivation(s.previewInput(seal), context);
  return { seal, plan, input: s.activateInput(seal, plan) };
}
test('C1 Windows strict protection is unsupported without platform overrides', { skip: !unsupported }, t => {
  const f = fixture(t);
  assert.throws(() => createImV2RecoveryServices({ root: f.root, sourceCatalog: {}, policy: policy() }), { code: 'RECOVERY_UNSUPPORTED' });
});
for (const route of ['fresh', 'closed-v3', 'registered-v3', 'snapshot']) test(`C1 real ${route} verify/preview/activate, expired completed retry and strict v1 status`, native, async t => {
  const s = await setup(t, route), initial = business(s.path), typed = typedBusiness(s.path), source = snapshot(s.f.db);
  const bytes = s.sourcePath && readFileSync(s.sourcePath), registry = tree(s.f.registryRoot);
  s.state.now += 400000; // original prepare TTL is obsolete after approved prepare.
  const { seal, plan, input } = planned(s);
  const verified = run(s), sealed = JSON.parse(readFileSync(join(s.root, seal.sealReference)));
  assert.equal(sealed.candidateFileHash, sha(readFileSync(s.path)));
  assert.equal(verified.verified_at, sealed.verifiedAt);
  assert.deepEqual(s.open().verifyRecovery(s.verifyInput, context), seal);
  assert.equal(sha(readFileSync(s.path)), sealed.candidateFileHash);
  assert.deepEqual(s.api.previewActivation(s.previewInput(seal), context), plan);
  assert.equal(s.api.getRecoveryStatus({ runId: s.staged.runId }, context).state, 'verified');
  assert.deepEqual(business(s.path), initial);
  assert.deepEqual(typedBusiness(s.path), typed);
  s.state.now += 1;
  const result = s.api.activateRecovery(input, context);
  assert.equal(result.status, 'active'); assert.equal(result.writeMode, 'paused');
  assert.equal(run(s).verified_at, verified.verified_at);
  assert.equal(query(s.path, db => db.prepare("SELECT count(*) n FROM im_audit WHERE action='recovery.activate'").get().n), 1);
  assert.deepEqual(business(s.path), initial);
  assert.deepEqual(typedBusiness(s.path), typed);
  assert.throws(() => s.api.verifyRecovery(s.verifyInput, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  s.state.now += 900000; s.state.activate = false; s.state.prepare = false; s.state.reviewed = false;
  const before = tree(s.root), clock = floor(s);
  assert.deepEqual(s.open().activateRecovery(input, context), result);
  const status = s.open().getRecoveryStatus({ runId: s.staged.runId }, context);
  assert.equal(status.state, 'active'); assert.equal(status.nextAction, 'NONE'); assert.equal(Object.hasOwn(status, 'version'), false);
  assert.equal(s.open().prepareRecovery(s.prepareInput, context).status, 'active');
  assert.deepEqual(tree(s.root), before); assert.equal(floor(s), clock);
  assert.deepEqual(snapshot(s.f.db), source); assert.deepEqual(tree(s.f.registryRoot), registry);
  if (bytes) assert.deepEqual(readFileSync(s.sourcePath), bytes);
  assert.throws(() => s.open().activateRecovery({ ...input, activationApprovalRef: 'different' }, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
});
test('C1 exact detached inputs, known async zero prefix, thenables observed and independent evidence gates', native, async t => {
  const s = await setup(t); const { seal, input } = planned(s); let calls = 0;
  const before = tree(s.root), old = s.options.approvalAuthority;
  s.options.approvalAuthority = { async authorizeApproval() { calls++; return true; } };
  assert.throws(() => s.open().activateRecovery(input, context), { code: 'RECOVERY_APPROVAL_DENIED' }); assert.equal(calls, 0);
  s.options.approvalAuthority = { authorizeApproval: () => Promise.reject(new Error('private')) };
  assert.throws(() => s.open().activateRecovery(input, context), { code: 'RECOVERY_APPROVAL_DENIED' });
  s.options.approvalAuthority = old;
  assert.throws(() => s.api.activateRecovery({ ...input, activationApprovalRef: 'prepare-ok' }, context), { code: 'RECOVERY_APPROVAL_DENIED' });
  s.state.reviewed = false;
  assert.throws(() => s.api.activateRecovery(input, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  s.state.reviewed = true;
  assert.throws(() => s.api.previewActivation({ ...s.previewInput(seal), authReviewRef: 'wrong' }, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.throws(() => s.api.activateRecovery({ ...input, db: {} }, context), { code: 'RECOVERY_INVALID' });
  const detached = { ...input };
  s.options.authority = { authorizeAdmin() { detached.activationApprovalRef = 'changed'; return true; } };
  assert.deepEqual(tree(s.root), before);
  assert.equal(s.open().activateRecovery(detached, context).status, 'active');
  assert.equal(run(s).activation_approval_ref, input.activationApprovalRef);
});
for (const artifact of ['seal', 'plan', 'candidate', 'sidecar', 'foreign-run']) test(`C1 ${artifact} refusal precedes clock writes`, native, async t => {
  const s = await setup(t), { seal, input } = planned(s);
  s.state.now += 100;
  if (artifact === 'seal') writeFileSync(join(s.root, seal.sealReference), Buffer.concat([readFileSync(join(s.root, seal.sealReference)), Buffer.from('\n')]));
  if (artifact === 'plan') writeFileSync(join(s.dir, `activation-${input.activationPlanHash}.json`), '{}');
  if (artifact === 'candidate') {
    const db = new DatabaseSync(s.path); db.exec('UPDATE im_clock SET last_observed_at=last_observed_at+1'); db.close();
  }
  if (artifact === 'sidecar') writeFileSync(s.path + '-wal', '', { mode: 0o600 });
  if (artifact === 'foreign-run') input.sealReference = `runs/${randomUUID()}/seals/${seal.sealHash}.json`;
  const before = tree(s.root), hash = sha(readFileSync(s.path));
  assert.throws(() => s.api.activateRecovery(input, context), error => ['RECOVERY_INVALID', 'RECOVERY_EVIDENCE_MISMATCH', 'RECOVERY_INDETERMINATE'].includes(error.code));
  assert.deepEqual(tree(s.root), before); assert.equal(sha(readFileSync(s.path)), hash);
});
test('C1 expiry equality retains floor, invalidates old seal, reverify/new-ref/new-approval succeeds', native, async t => {
  const s = await setup(t), { seal, plan, input } = planned(s), initial = business(s.path), verifiedAt = run(s).verified_at;
  s.state.now = plan.activationPlan.expiresAt;
  assert.throws(() => s.api.activateRecovery(input, context), { code: 'RECOVERY_REVERIFY_REQUIRED' });
  assert.equal(run(s).status, 'verified'); assert.equal(floor(s), s.state.now); assert.deepEqual(business(s.path), initial);
  const before = tree(s.root);
  assert.throws(() => s.api.activateRecovery(input, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.deepEqual(tree(s.root), before);
  const newSeal = s.api.verifyRecovery(s.verifyInput, context);
  assert.notEqual(newSeal.sealHash, seal.sealHash); assert.equal(run(s).verified_at, verifiedAt);
  assert.throws(() => s.api.previewActivation(s.previewInput(newSeal), context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  const next = s.api.previewActivation({ ...s.previewInput(newSeal), activationRef: 'activation-2' }, context);
  assert.equal(s.api.activateRecovery(s.activateInput(newSeal, next, 'activate-ok-2'), context).status, 'active');
  assert.equal(readdirSync(join(s.dir, 'seals')).length, 2);
});
for (const phase of ['late-approval', 'final-expiry', 'final-rollback']) test(`C1 ${phase} abort retains observed floor and verified business state`, native, async t => {
  const s = await setup(t), { plan, input } = planned(s), before = business(s.path), start = s.state.now;
  let approvals = 0, samples = 0;
  s.options.approvalAuthority = { authorizeApproval() { approvals++; return phase !== 'late-approval' || approvals < 3; } };
  s.options.clock = () => {
    samples++;
    if (samples === 3 && phase === 'final-expiry') return plan.activationPlan.expiresAt;
    if (samples === 3 && phase === 'final-rollback') return start;
    return start + 1;
  };
  assert.throws(() => s.open().activateRecovery(input, context), { code: 'RECOVERY_REVERIFY_REQUIRED' });
  assert.equal(approvals, 3); assert.equal(samples, phase === 'late-approval' ? 2 : 3);
  assert.equal(floor(s), phase === 'final-expiry' ? plan.activationPlan.expiresAt : start + 1);
  assert.equal(run(s).status, 'verified'); assert.deepEqual(business(s.path), before);
});
test('C1 completion missing: readonly status is conservative, exact activate alone repairs without DB rewrite', native, async t => {
  const s = await setup(t), { input } = planned(s);
  const result = s.api.activateRecovery(input, context);
  const file = join(s.dir, 'activation-complete.json'), completion = readFileSync(file);
  unlinkSync(file); // isolated response-loss fixture only
  const before = tree(s.root), dbHash = sha(readFileSync(s.path));
  assert.equal(s.api.getRecoveryStatus({ runId: s.staged.runId }, context).state, 'indeterminate');
  assert.deepEqual(tree(s.root), before);
  assert.throws(() => s.api.activateRecovery({ ...input, activationApprovalRef: 'other' }, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  s.state.now += 900000; s.state.activate = false;
  assert.deepEqual(s.open().activateRecovery(input, context), result);
  assert.deepEqual(readFileSync(file), completion); assert.equal(sha(readFileSync(s.path)), dbHash);
});
test('C1 preview keeps immutable times, conflicts per ref, expired plan needs new reference and no anchor', native, async t => {
  const s = await setup(t), { seal, plan } = planned(s), initial = floor(s);
  s.state.now = plan.activationPlan.expiresAt;
  assert.throws(() => s.api.previewActivation(s.previewInput(seal), context), { code: 'RECOVERY_PLAN_STALE' });
  const next = s.api.previewActivation({ ...s.previewInput(seal), activationRef: 'next' }, context);
  assert.equal(next.activationPlan.createdAt, s.state.now); assert.equal(floor(s), initial);
  assert.equal(JSON.parse(readFileSync(join(s.dir, `activation-${plan.activationPlanHash}.json`))).createdAt, plan.activationPlan.createdAt);
});
for (const mode of ['seal-sync', 'commit-response', 'close-response', 'completion-sync']) test(`C1 native child ${mode}`, native, async t => {
  const worker = child('fault-child.js', [mode]);
  try {
    const result = await worker.result(); t.diagnostic(JSON.stringify(result));
    assert.equal(result.error, null); assert.deepEqual(result.exit, { code: 0, signal: null });
    assert.deepEqual(result.close, result.exit); assert.match(result.output, /"success":true/);
  } finally { await worker.stop(); }
});
for (const scope of ['source', 'workspace', 'candidate']) test(`C1 real IPC ${scope} coordinator contention`, native, async t => {
  const s = await setup(t, 'snapshot');
  const path = scope === 'source' ? join(s.f.registryRoot, 'coordination.sqlite') :
    scope === 'workspace' ? join(s.root, 'requests', 'coordination.sqlite') : join(s.dir, 'coordination.sqlite');
  const holder = child('process-child.js', [], true), contender = child('process-child.js', [], true);
  try {
    assert.equal((await holder.message()).phase, 'ready'); assert.equal((await contender.message()).phase, 'ready');
    contender.proc.send({ mode: 'compose', root: s.root, registryRoot: s.f.registryRoot,
      backupId: s.options.sourceCatalog.source.backupId, now: s.state.now });
    assert.equal((await contender.message()).phase, 'composed');
    holder.proc.send({ mode: 'hold', path }); assert.equal((await holder.message()).phase, 'held');
    const before = tree(s.root);
    contender.proc.send({ mode: 'verify', root: s.root, registryRoot: s.f.registryRoot,
      backupId: s.options.sourceCatalog.source.backupId, now: s.state.now, verifyInput: s.verifyInput });
    assert.deepEqual(await contender.message(), { phase: 'complete', code: 'RECOVERY_BUSY' });
    const result = await contender.result(); t.diagnostic(JSON.stringify({ scope, ...result }));
    assert.equal(result.error, null); assert.deepEqual(result.exit, { code: 0, signal: null }); assert.deepEqual(result.close, result.exit);
    assert.deepEqual(tree(s.root), before);
    holder.proc.send({ mode: 'release' }); assert.equal((await holder.message()).phase, 'released');
    const released = await holder.result(); assert.equal(released.exit.code, 0); assert.deepEqual(released.close, released.exit);
    assert.equal(s.api.verifyRecovery(s.verifyInput, context).status, 'verified');
  } finally { await contender.stop(); await holder.stop(); }
});
for (const scope of ['source', 'workspace', 'candidate']) test(`C1 active exact retry real independent ${scope} coordinator contention`, native, async t => {
  const s = await setup(t, 'snapshot'), { input } = planned(s);
  const active = s.api.activateRecovery(input, context);
  const path = scope === 'source' ? join(s.f.registryRoot, 'coordination.sqlite') :
    scope === 'workspace' ? join(s.root, 'requests', 'coordination.sqlite') : join(s.dir, 'coordination.sqlite');
  const holder = child('process-child.js', [], true), contender = child('process-child.js', [], true);
  try {
    assert.equal((await holder.message()).phase, 'ready'); assert.equal((await contender.message()).phase, 'ready');
    contender.proc.send({ mode: 'compose', root: s.root, registryRoot: s.f.registryRoot,
      backupId: s.options.sourceCatalog.source.backupId, now: s.state.now + 900000 });
    assert.equal((await contender.message()).phase, 'composed');
    holder.proc.send({ mode: 'hold', path }); assert.equal((await holder.message()).phase, 'held');
    const before = tree(s.root), registry = tree(s.f.registryRoot);
    contender.proc.send({ mode: 'activate', activateInput: input });
    assert.deepEqual(await contender.message(), { phase: 'complete', code: 'RECOVERY_BUSY' });
    const result = await contender.result(); t.diagnostic(JSON.stringify({ scope, activeRetry: true, ...result }));
    assert.equal(result.error, null); assert.deepEqual(result.exit, { code: 0, signal: null }); assert.deepEqual(result.close, result.exit);
    assert.deepEqual(tree(s.root), before); assert.deepEqual(tree(s.f.registryRoot), registry);
    holder.proc.send({ mode: 'release' }); assert.equal((await holder.message()).phase, 'released');
    const released = await holder.result(); assert.deepEqual(released.exit, { code: 0, signal: null }); assert.deepEqual(released.close, released.exit);
    assert.deepEqual(s.api.activateRecovery(input, context), active);
    assert.deepEqual(tree(s.root), before); assert.deepEqual(tree(s.f.registryRoot), registry);
  } finally { await contender.stop(); await holder.stop(); }
});
test('C1 actual active paused candidate still refuses business writes through existing P3 gate', native, async t => {
  const secret = randomBytes(32).toString('base64url');
  const s = await setup(t, 'snapshot', f => f.db.prepare('UPDATE im_credentials SET secret_hash=? WHERE credential_id=?').run(sha(secret), f.credential));
  const { input } = planned(s); s.api.activateRecovery(input, context);
  const before = business(s.path), db = new DatabaseSync(s.path);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    const p = { ...policy(), effectiveAt: 1 }, config = { enabled: true, writeMode: 'enabled', transport: { mode: 'local-test', serverUrl: 'http://localhost/' },
      retention: { policy: p, policyHash: sha(JSON.stringify(p)) }, lease: { ttlMs: 1000, renewalMs: 500 },
      limits: { maxAttachmentBytes: 10485760, maxBodyBytes: 65536, maxFileBodyBytes: 16777216, maxConnections: 10, maxRequestsPerMinute: 100 },
      maintenance: { ...DEFAULT_MAINTENANCE, maxKeyReservations: 1000 } };
    const auth = createImV2Auth({ db, policy: config, clock: () => s.state.now });
    const principal = auth.authenticate(`${s.f.credential}.${secret}`);
    let entered = false;
    assert.throws(() => auth.withWrite(principal, { protocol: 'a2a-msg.im.v2', centerEpoch: s.preview.preparePlan.newEpoch }, () => { entered = true; }), { code: 'NEW_WRITES_DISABLED' });
    assert.equal(entered, false);
  } finally { db.close(); }
  assert.deepEqual(business(s.path), before);
});
test('C1 candidate inode replaced during adapter is rejected before guard writes', native, async t => {
  const s = await setup(t), { input } = planned(s), before = readFileSync(s.path);
  let replaced = false;
  s.options.approvalAuthority = { authorizeApproval() {
    if (!replaced) {
      const replacement = join(s.dir, 'replacement.sqlite');
      writeFileSync(replacement, before, { mode: 0o600 }); renameSync(replacement, s.path); replaced = true;
    }
    return true;
  } };
  assert.throws(() => s.open().activateRecovery(input, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.deepEqual(readFileSync(s.path), before);
});
test('C1 current source isolation and auth review are rechecked, references alone grant no permission', native, async t => {
  const s = await setup(t, 'snapshot'), { input } = planned(s), before = tree(s.root);
  s.state.isolated = false;
  assert.throws(() => s.api.activateRecovery(input, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  s.state.isolated = true;
  let calls = 0;
  s.options.evidenceAuthority.assertAuthReview = async () => { calls++; return true; };
  assert.throws(() => s.open().activateRecovery(input, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.equal(calls, 0); assert.deepEqual(tree(s.root), before);
});
test('C1 verified commit with missing seal reconstructs persisted verifiedAt without time anchor', native, async t => {
  const s = await setup(t), seal = s.api.verifyRecovery(s.verifyInput, context), at = run(s).verified_at;
  const bytes = readFileSync(join(s.root, seal.sealReference)), candidate = readFileSync(s.path);
  unlinkSync(join(s.root, seal.sealReference));
  s.state.now += 900000;
  const before = tree(s.root);
  assert.equal(s.api.getRecoveryStatus({ runId: s.staged.runId }, context).state, 'verified');
  assert.deepEqual(tree(s.root), before);
  assert.deepEqual(s.open().verifyRecovery(s.verifyInput, context), seal);
  assert.deepEqual(readFileSync(join(s.root, seal.sealReference)), bytes);
  assert.deepEqual(readFileSync(s.path), candidate); assert.equal(run(s).verified_at, at);
});
test('C1 valid SQL active words with absent C chain never satisfy status or B completed retry', native, async t => {
  const s = await setup(t), { input } = planned(s); s.api.activateRecovery(input, context);
  const planPath = join(s.dir, `activation-${input.activationPlanHash}.json`);
  unlinkSync(planPath);
  const before = tree(s.root);
  assert.equal(s.api.getRecoveryStatus({ runId: s.staged.runId }, context).state, 'indeterminate');
  assert.throws(() => s.api.prepareRecovery(s.prepareInput, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.deepEqual(tree(s.root), before);
});

for (const fault of ['candidate-file', 'candidate-directory', 'completion-file', 'completion-directory']) {
  test(`C1 actual exited publisher before-native completion dir failure; independent ${fault} retry refuses then resyncs`, native, async t => {
    const publisher = child('restart-child.js', ['publish'], true);
    let retry, persisted, safeCleanup = false;
    try {
      const handoff = await publisher.message();
      assert.equal(handoff.phase, 'published-before-native-failure'); persisted = handoff.persisted;
      assert.equal(handoff.visible.status.state, 'active'); assert.equal(handoff.visible.prepared.status, 'active');
      publisher.proc.send({ mode: 'exit-with-owned-locks' });
      assert.equal((await publisher.message()).phase, 'exiting-with-owned-locks');
      const first = await publisher.result();
      t.diagnostic(JSON.stringify({ role: 'publisher', fault, ...first, events: handoff.events }));
      assert.equal(first.error, null); assert.deepEqual(first.exit, { code: 0, signal: null }); assert.deepEqual(first.close, first.exit);
      // No new process starts until BOTH independent exit and stdio-close evidence.
      retry = child('restart-child.js', ['retry'], true);
      assert.notEqual(retry.proc.pid, publisher.proc.pid);
      assert.equal((await retry.message()).phase, 'ready');
      retry.proc.send({ ...persisted, fault, visible: handoff.visible, before: handoff.before });
      const report = await retry.message(), second = await retry.result();
      t.diagnostic(JSON.stringify({ role: 'retry', fault, ...second, report }));
      assert.equal(second.error, null); assert.deepEqual(second.exit, { code: 0, signal: null }); assert.deepEqual(second.close, second.exit);
      assert.equal(report.phase, 'complete'); assert.deepEqual(report.visible, handoff.visible);
      assert.ok(report.failed.some(e => e.phase === fault && !e.native && e.fault === 'before-native'));
      assert.deepEqual(report.succeeded.filter(e => e.operation === 'fsync').map(e => e.phase),
        [...Array(2)].flatMap(() => ['candidate-file', 'candidate-directory', 'completion-file', 'completion-directory']));
      assert.equal(report.candidateHash, handoff.before.candidate);
      safeCleanup = true;
    } finally {
      await retry?.stop(); await publisher.stop();
      if (safeCleanup && persisted) rmSync(persisted.fixtureRoot, { recursive: true, force: true });
      else if (persisted) t.diagnostic(`uncertain evidence retained: ${persisted.fixtureRoot}`);
    }
  });
}

test('C1 conflicting canonical completion refuses readonly observations and exact activation without repairing evidence', native, async t => {
  const s = await setup(t, 'snapshot'), { input } = planned(s);
  s.api.activateRecovery(input, context);
  const completion = join(s.dir, 'activation-complete.json'), bytes = readFileSync(completion);
  // Canonical-looking JSON with conflicting binding, not an unrelated setup error.
  const value = JSON.parse(bytes); value.activationApprovalRef = 'conflicting-approval';
  writeFileSync(completion, JSON.stringify(value));
  const before = tree(s.root), source = readFileSync(s.sourcePath), registry = tree(s.f.registryRoot), candidate = readFileSync(s.path);
  assert.equal(s.api.getRecoveryStatus({ runId: s.staged.runId }, context).state, 'indeterminate');
  assert.throws(() => s.api.prepareRecovery(s.prepareInput, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.throws(() => s.api.activateRecovery(input, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.deepEqual(tree(s.root), before); assert.deepEqual(readFileSync(s.path), candidate);
  assert.deepEqual(readFileSync(s.sourcePath), source); assert.deepEqual(tree(s.f.registryRoot), registry);
});
