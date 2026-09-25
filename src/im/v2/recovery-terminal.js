// Private C evidence reader. Every input here is obtained by the lock-owning
// recovery factory from protected records and a fully inspected native DB.
import { join } from 'node:path';
import { readRecord as readProtectedRecord } from './recovery-candidate.js';
import { encodeRecoveryRecord, hashRecoveryRecord, validateRecoverySealBindings, validateRecoveryActivationPlanBindings,
  validateRecoveryCompletionBindings } from './recovery-plan.js';
import { invalid, hash } from './recovery-records.js';

function readRecord(path, kind, budget) {
  try { return readProtectedRecord(path, kind, budget); }
  catch (error) { if (error?.code === 'RECOVERY_INVALID') invalid(); throw error; }
}
export function sealReference(runId, sealHash) { return `runs/${runId}/seals/${sealHash}.json`; }
export function sealEvidence(data, reference, candidateFileHash) {
  return { preparePlan: data.plan, prepareEvidence: { stage: data.stage, staged: data.staged,
    sourceClosedEvidence: data.sourceClosedEvidence, base: data.base,
    previousRecoveryCounter: data.stage.candidateKind === 'snapshot_recovery' ? data.actual.center.recovery_counter - 1 : null },
    candidateFileHash, schemaChecksum: data.actual.schemaChecksum, verifiedAt: data.actual.run.verified_at, sealReference: reference };
}
export function readSeal(root, data, reference, budget, candidateFileHash) {
  const prefix = `runs/${data.stage.runId}/seals/`;
  if (typeof reference !== 'string' || !reference.startsWith(prefix) || !reference.endsWith('.json')) invalid();
  const digest = reference.slice(prefix.length, -5);
  if (!hash(digest) || reference !== sealReference(data.stage.runId, digest)) invalid();
  const seal = readRecord(join(root, reference), 'seal', budget);
  if (!seal || hashRecoveryRecord('seal', seal) !== digest) invalid();
  // Only completed recognition may use historical seal bytes. Its authority
  // comes from the full active projection, never from this hash alone.
  const evidence = sealEvidence(data, reference, candidateFileHash ?? seal.candidateFileHash);
  validateRecoverySealBindings(seal, evidence);
  return { seal, sealEvidence: evidence };
}
export function readActivation(root, data, planHash, reference, budget, candidateFileHash) {
  if (!hash(planHash)) invalid();
  const activationPlan = readRecord(join(root, 'runs', data.stage.runId, `activation-${planHash}.json`), 'activationPlan', budget);
  if (!activationPlan || hashRecoveryRecord('activationPlan', activationPlan) !== planHash) invalid();
  const activationEvidence = readSeal(root, data, reference, budget, candidateFileHash);
  validateRecoveryActivationPlanBindings(activationPlan, activationEvidence);
  return { activationPlan, activationEvidence };
}
function projection(actual) {
  const r = actual.run, c = actual.center;
  return { run: { runId: r.run_id, preparePlanHash: r.approved_plan_hash, prepareApprovalRef: r.approval_ref,
    candidateReference: r.candidate_reference, newEpoch: r.new_epoch, status: r.status, verifiedAt: r.verified_at,
    activationPlanHash: r.activation_plan_hash, activationApprovalRef: r.activation_approval_ref,
    activationRef: r.activation_ref, activatedAt: r.activated_at, authReviewRef: r.auth_review_ref,
    isolationAckRef: r.isolation_ack_ref, failureCode: r.failure_code },
    center: { runId: c.recovery_run_id, newEpoch: c.center_epoch, status: c.status, activationRef: c.activation_ref,
      updatedAt: c.updated_at, recoveryCounter: c.recovery_counter },
    instance: { instanceId: actual.identity.instance_id, instanceCreatedAt: actual.identity.created_at },
    epoch: { newEpoch: actual.epoch.center_epoch, recoveryCounter: actual.epoch.recovery_counter }, writeMode: actual.writeMode };
}
export function activeEvidence(root, data, held, budget, input = null) {
  const r = data.actual.run;
  if (r?.status !== 'active') invalid();
  const planHash = r.activation_plan_hash;
  if (input && (input.activationPlanHash !== planHash || input.activationApprovalRef !== r.activation_approval_ref)) invalid();
  const plan = readRecord(join(root, 'runs', data.stage.runId, `activation-${planHash}.json`), 'activationPlan', budget);
  if (!plan) invalid();
  const reference = sealReference(data.stage.runId, plan.sealHash);
  if (input && input.sealReference !== reference) invalid();
  const chain = readActivation(root, data, planHash, reference, budget);
  const completion = { version: 1, runId: data.stage.runId, preparePlanHash: data.planHash,
    activationPlanHash: planHash, activationApprovalRef: r.activation_approval_ref, activationRef: plan.activationRef,
    sealHash: plan.sealHash, candidateReference: data.plan.candidateReference, instanceId: data.actual.identity.instance_id,
    instanceCreatedAt: data.actual.identity.created_at, newEpoch: data.plan.newEpoch,
    recoveryCounter: data.actual.epoch.recovery_counter, activatedAt: r.activated_at, writeMode: 'paused' };
  const owned = validateRecoveryCompletionBindings(completion, { ...chain, prepareApprovalRef: r.approval_ref, actual: projection(data.actual) });
  const stored = readRecord(join(root, 'runs', data.stage.runId, 'activation-complete.json'), 'activationCompletion', budget);
  if (stored && !encodeRecoveryRecord('activationCompletion', stored).equals(encodeRecoveryRecord('activationCompletion', owned))) invalid();
  if (held?.release && (!stored || held.release.terminalState !== 'active' ||
      held.release.stateEvidenceHash !== hashRecoveryRecord('activationCompletion', owned) || held.release.releasedAt < owned.activatedAt)) invalid();
  return { completion: owned, stored };
}
