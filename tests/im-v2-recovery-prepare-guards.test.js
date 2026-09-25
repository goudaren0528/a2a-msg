// Independent P5-B regression guards. Real P1/P5-A fixtures; public B facade only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createImV2RecoveryServices } from '../src/im/v2/recovery.js';
import { createTrustedImV2BackupServices } from '../src/im/v2/backup-registry.js';
import { context, fixture, unsupported } from './fixtures/im-v2-backup/helpers.js';
import { policy, snapshot } from './fixtures/im-v2-schema/helpers.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function setup(f, sourceCatalog = {}) {
  const root = join(f.root, 'prepare-guards'); mkdirSync(root, { mode: 0o700 });
  const state = { now: Date.now(), approved: true, approvals: 0 };
  const options = { root, sourceCatalog, policy: policy(), authority: f.options.authority,
    evidenceAuthority: {
      assertSourceIsolation: () => true,
      getSourceClosedEvidence: binding => ({ version: 1, evidenceRef: 'guards-closed', ...binding, issuedAt: state.now }),
      authorizeSourceClosedEvidence: () => true,
    },
    approvalAuthority: { authorizeApproval(input, ctx) {
      state.approvals++;
      return ctx === context && input.kind === 'prepare' && input.approvalRef === 'guards-approved' && state.approved;
    } }, clock: () => state.now };
  return { root, options, state, open: () => createImV2RecoveryServices(options) };
}
function observe(path) {
  // Every observation really reopens the candidate. Never lower its actual P1 floor.
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const business = snapshot(db);
    const floor = db.prepare('SELECT last_observed_at FROM im_clock WHERE singleton=1').get().last_observed_at;
    delete business.rows.im_clock;
    return { floor, business };
  } finally { db.close(); }
}
function tree(root) {
  return Object.fromEntries(readdirSync(root, { recursive: true }).sort().map(name => {
    const path = join(root, name), stat = statSync(path, { bigint: true });
    if (stat.isDirectory()) return [name, 'directory'];
    const bytes = readFileSync(path);
    return [name, { bytes: bytes.toString('hex'), sha256: sha(bytes), size: String(stat.size), mtimeNs: String(stat.mtimeNs),
      dev: String(stat.dev), ino: String(stat.ino) }];
  }));
}
function evidence(s, f, path) {
  const actual = observe(path);
  return { actual, workspace: tree(s.root), registry: tree(f.registryRoot) };
}
function stage(s, kind = 'fresh_bootstrap') {
  const staged = s.open().stageCandidate({ requestRef: 'prepare-guards', candidateKind: kind,
    sourceRef: kind === 'fresh_bootstrap' ? null : 'source', isolationAckRef: kind === 'fresh_bootstrap' ? null : 'guards-isolated' }, context);
  const path = join(s.root, staged.candidateReference);
  const actual = observe(path);
  s.state.now = Math.max(Date.now(), actual.floor);
  return { staged, path };
}
function preview(s, staged) {
  const value = s.open().previewRecovery({ runId: staged.runId }, context);
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.preparePlan));
  assert.equal(value.preparePlan.expiresAt - value.preparePlan.createdAt, 300000);
  const bytes = readFileSync(join(s.root, 'runs', staged.runId, `prepare-${value.preparePlanHash}.json`));
  assert.equal(sha(bytes), value.preparePlanHash);
  assert.deepEqual(s.open().previewRecovery({ runId: staged.runId }, context), value);
  return { ...value, request: { runId: staged.runId, preparePlanHash: value.preparePlanHash, approvalRef: 'guards-approved' } };
}
function outcome(action) {
  try { return { value: action(), error: null }; }
  catch (error) { return { value: null, error: error.code ?? error.name }; }
}

test('guards Windows capability gate is strictly unsupported', { skip: !unsupported }, t => {
  const f = fixture(t), s = setup(f);
  assert.throws(s.open, { code: 'RECOVERY_UNSUPPORTED' });
});

for (const check of ['durable entry floor', 'rollback retry refusal']) {
  test(`B1 ${check}: equality expiry survives a fresh facade and native connection`, { skip: unsupported }, t => {
    const f = fixture(t), s = setup(f), { staged, path } = stage(s), p = preview(s, staged);
    const before = observe(path);
    assert.ok(p.preparePlan.createdAt >= before.floor);
    s.state.now = p.preparePlan.expiresAt;
    assert.throws(() => s.open().prepareRecovery(p.request, context), { code: 'RECOVERY_PLAN_STALE' });
    const expired = observe(path);
    assert.deepEqual(expired.business, before.business, 'expiry changes no business table, epoch or center state');
    if (check === 'durable entry floor') {
      t.diagnostic(JSON.stringify({ beforeFloor: before.floor, observedExpiry: s.state.now, durableFloor: expired.floor }));
      assert.ok(expired.floor >= p.preparePlan.expiresAt, 'B1: entry expiry observation must be durable before rejecting the plan');
      return;
    }
    s.state.now = p.preparePlan.expiresAt - 1;
    const retry = outcome(() => s.open().prepareRecovery(p.request, context));
    const after = observe(path);
    t.diagnostic(JSON.stringify({ beforeFloor: before.floor, expiry: p.preparePlan.expiresAt,
      expiredFloor: expired.floor, rollbackTime: s.state.now, retry, afterFloor: after.floor,
      businessUnchanged: JSON.stringify(after.business) === JSON.stringify(before.business) }));
    // The current public boundary maps the P1 CLOCK_UNSAFE exception to this code.
    // Correct code alone is insufficient: all business facts must also stay intact.
    assert.equal(retry.error, 'RECOVERY_EVIDENCE_MISMATCH', 'B1: approved rollback retry must be refused by candidate clock safety');
    assert.ok(after.floor >= expired.floor && after.floor >= p.preparePlan.expiresAt, 'clock floor never decreases');
    assert.deepEqual(after.business, before.business, 'no new recovery run, epoch, center transition or other business mutation');
  });
}

test('B1 control: final in-transaction expiry rolls back business while retaining the later floor', { skip: unsupported }, t => {
  const f = fixture(t), s = setup(f), { staged, path } = stage(s), p = preview(s, staged);
  const before = observe(path); let approvals = 0;
  // The documented entry, transactional, and final reauthorization phases.
  s.options.approvalAuthority = { authorizeApproval(input, ctx) {
    assert.equal(ctx, context); assert.equal(input.planHash, p.preparePlanHash);
    if (++approvals === 3) s.state.now = p.preparePlan.expiresAt;
    return true;
  } };
  assert.throws(() => s.open().prepareRecovery(p.request, context), { code: 'RECOVERY_PLAN_STALE' });
  assert.equal(approvals, 3, 'reached final reauthorization, not an entry/setup failure');
  const after = observe(path);
  assert.ok(after.floor >= p.preparePlan.expiresAt);
  assert.deepEqual(after.business, before.business);
});

test('B1 control: completed prepare exact retry ignores expired/revoked mutation approval with zero writes, including child reopen', { skip: unsupported }, t => {
  const f = fixture(t), s = setup(f), { staged, path } = stage(s), p = preview(s, staged);
  const prepared = s.open().prepareRecovery(p.request, context);
  assert.equal(prepared.status, 'prepared');
  const before = evidence(s, f, path), approvals = s.state.approvals;
  s.state.now = p.preparePlan.expiresAt + 1; s.state.approved = false;
  assert.deepEqual(s.open().prepareRecovery(p.request, context), prepared);
  assert.equal(s.open().getRecoveryStatus({ runId: staged.runId }, context).state, 'prepared');
  assert.equal(s.state.approvals, approvals, 'completed retry never asks for new mutation approval');
  const command = [fileURLToPath(new URL('./fixtures/im-v2-recovery-prepare-guards/reopen.js', import.meta.url)),
    JSON.stringify({ root: s.root, now: s.state.now, request: p.request })];
  const child = spawnSync(process.execPath, command, { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  t.diagnostic(JSON.stringify({ child: 'guards/reopen.js', pid: child.pid, exit: child.status, signal: child.signal, error: child.error?.code ?? null }));
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), prepared);
  assert.deepEqual(evidence(s, f, path), before, 'candidate clock/bytes and all workspace/registry file bytes/mtimes are readonly');
});

async function registered(t) {
  const f = fixture(t), registryClock = { now: Date.now() };
  // Registry chronology is independent of the recovery facade's expiry clock.
  const services = createTrustedImV2BackupServices({ ...f.options, clock: () => registryClock.now });
  const { record } = await services.publisher.publish({ approvalRef: 'test-approved' }, context);
  await services.publisher.drain();
  const s = setup(f, { source: { kind: 'registered-backup', registry: services.registry, backupId: record.backupId } });
  const { staged, path } = stage(s, 'snapshot_recovery'), p = preview(s, staged);
  assert.ok(staged.holdId);
  assert.equal(services.registry.getHold({ holdId: staged.holdId }, context).binding, null);
  return { f, s, services, staged, path, p, registryClock };
}

function bindAtCreation(t, services, staged, preparePlanHash) {
  const before = services.registry.getHold({ holdId: staged.holdId }, context);
  assert.equal(before.binding, null);
  assert.equal(before.hold.holdId, staged.holdId);
  assert.equal(before.hold.stageHash, staged.stageHash);
  const binding = services.registry.bindPrepareHold({ holdId: staged.holdId, preparePlanHash }, context);
  assert.deepEqual(binding, { version: 1, holdId: staged.holdId, stageHash: staged.stageHash,
    preparePlanHash, boundAt: before.hold.createdAt });
  assert.deepEqual(services.registry.getHold({ holdId: staged.holdId }, context), { ...before, binding });
  t.diagnostic(JSON.stringify({ setupBinding: 'verified', holdId: binding.holdId, stageHash: binding.stageHash,
    preparePlanHash, createdAt: before.hold.createdAt, boundAt: binding.boundAt }));
  return binding;
}

test('B4 registry clock rollback refuses binding without writes; restoring equality permits binding', { skip: unsupported }, async t => {
  const { f, s, services, staged, path, p, registryClock } = await registered(t);
  const holdBefore = services.registry.getHold({ holdId: staged.holdId }, context);
  assert.equal(holdBefore.binding, null);
  assert.equal(holdBefore.hold.createdAt, registryClock.now);
  const before = evidence(s, f, path);
  registryClock.now = holdBefore.hold.createdAt - 1;
  assert.throws(() => services.registry.bindPrepareHold({ holdId: staged.holdId, preparePlanHash: p.preparePlanHash }, context),
    { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.deepEqual(services.registry.getHold({ holdId: staged.holdId }, context), holdBefore);
  assert.deepEqual(evidence(s, f, path), before, 'rollback creates no binding and preserves hold/file bytes, identities and metadata');
  const rejectedAt = registryClock.now;
  registryClock.now = holdBefore.hold.createdAt;
  const binding = bindAtCreation(t, services, staged, p.preparePlanHash);
  t.diagnostic(JSON.stringify({ createdAt: holdBefore.hold.createdAt, rejectedAt, restoredBoundAt: binding.boundAt,
    rollbackEvidenceUnchanged: true }));
});

for (const missingPlan of [false, true]) for (const operation of ['status', 'preview', 'prepare']) {
  test(`B4 ${missingPlan ? 'bound hold with missing plan' : 'authoritative hold conflicts with plan H'}: ${operation} refuses without repair`, { skip: unsupported }, async t => {
    const { f, s, services, staged, path, p } = await registered(t);
    const boundHash = missingPlan ? p.preparePlanHash : sha(`conflict:${p.preparePlanHash}`);
    if (!missingPlan) assert.notEqual(boundHash, p.preparePlanHash);
    bindAtCreation(t, services, staged, boundHash);
    // Fault injection deletes only this test's own immutable plan, after real binding.
    if (missingPlan) unlinkSync(join(s.root, 'runs', staged.runId, `prepare-${p.preparePlanHash}.json`));
    const before = evidence(s, f, path);
    const result = outcome(() => {
      const api = s.open();
      return operation === 'status' ? api.getRecoveryStatus({ runId: staged.runId }, context)
        : operation === 'preview' ? api.previewRecovery({ runId: staged.runId }, context)
          : api.prepareRecovery(p.request, context);
    });
    const after = evidence(s, f, path);
    t.diagnostic(JSON.stringify({ missingPlan, operation, error: result.error,
      state: result.value?.state, nextAction: result.value?.nextAction, returnedPlanHash: result.value?.preparePlanHash,
      boundHash, originalPlanHash: p.preparePlanHash, evidenceUnchanged: JSON.stringify(after) === JSON.stringify(before) }));
    assert.deepEqual(after, before, 'no candidate/clock/business, registry or metadata bytes/mtime changes and no replacement plan');
    if (operation === 'status') {
      assert.equal(result.error, null);
      assert.equal(result.value.state, 'indeterminate', 'B4: contradictory authoritative binding is not a reusable staged candidate');
      assert.equal(result.value.nextAction, 'MANUAL_RECONCILIATION');
    } else assert.equal(result.error, 'RECOVERY_EVIDENCE_MISMATCH', 'B4: missing/conflicting authoritative plan must refuse');
  });
}

test('B4 control: exact matching H binding permits staged status, immutable preview, prepare and readonly exact retry', { skip: unsupported }, async t => {
  const { f, s, services, staged, path, p } = await registered(t);
  bindAtCreation(t, services, staged, p.preparePlanHash);
  const before = evidence(s, f, path);
  const status = s.open().getRecoveryStatus({ runId: staged.runId }, context);
  assert.equal(status.state, 'staged'); assert.equal(status.nextAction, 'APPROVE_PREPARE');
  assert.equal(status.preparePlanHash, p.preparePlanHash);
  const repeated = s.open().previewRecovery({ runId: staged.runId }, context);
  assert.deepEqual(repeated, { preparePlan: p.preparePlan, preparePlanHash: p.preparePlanHash });
  assert.deepEqual(evidence(s, f, path), before);
  const prepared = s.open().prepareRecovery(p.request, context);
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.newEpoch, p.preparePlan.newEpoch);
  const completed = evidence(s, f, path), approvals = s.state.approvals;
  s.state.now = p.preparePlan.expiresAt + 1; s.state.approved = false;
  assert.deepEqual(s.open().prepareRecovery(p.request, context), prepared);
  assert.equal(s.open().getRecoveryStatus({ runId: staged.runId }, context).state, 'prepared');
  assert.equal(s.state.approvals, approvals);
  assert.deepEqual(evidence(s, f, path), completed);
});
