// Fixed engine for recovery-owned candidates. This path-taking internal helper
// is not an ownership boundary: only recovery's locked private scope supplies it.
import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { assertImSchemaV4Internal, V4_CHECKSUM } from './schema-internal.js';
import { assertImSchemaV5Internal, V5_CHECKSUM, V5_SCHEMA, V5_TABLES, V5_INDEXES } from './schema-v5-internal.js';
import { decodeMaintenanceV5Record, encodeMaintenanceV5Record, hashMaintenanceV5Record } from './maintenance-v5-records.js';
import { closeConversionCandidate, standalone } from './recovery-candidate.js';
import { fail, fileHash, isRecoveryOperationBudget, protectedPath, same, shape, time } from './recovery-records.js';

const conflict = () => { throw fail('RECOVERY_CONVERSION_CONFLICT'); };
const uncertain = () => fail('RECOVERY_DURABILITY_UNCERTAIN');
const copy = (kind, value) => decodeMaintenanceV5Record(kind, encodeMaintenanceV5Record(kind, value));
function safeFailure(error) {
  // The bridge latches authorization/poison errors itself. Native/provider
  // thrown objects must never reach callback-bearing lock cleanup unclassified.
  let code;
  if (error && typeof error === 'object' && !types.isProxy(error)) code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  if (code === 'RECOVERY_BUSY' || code === 'IM_V2_BUDGET_EXCEEDED') return fail('RECOVERY_BUSY');
  if (code === 'RECOVERY_DURABILITY_UNCERTAIN') return uncertain();
  return fail('RECOVERY_CONVERSION_CONFLICT');
}
function verify(db, plan, budget, version) {
  if (version === 4) assertImSchemaV4Internal(db, budget);
  else assertImSchemaV5Internal(db, budget);
  for (const row of db.prepare('PRAGMA integrity_check').iterate()) { budget.tick(); if (row.integrity_check !== 'ok') conflict(); }
  for (const row of db.prepare('PRAGMA foreign_key_check').iterate()) { budget.tick(); conflict(); }
  const identity = db.prepare('SELECT instance_id,created_at FROM im_instance_identity WHERE singleton=1').get();
  const center = db.prepare('SELECT center_epoch,status,recovery_run_id FROM im_center_state WHERE singleton=1').get();
  if (identity.instance_id !== plan.instanceId || identity.created_at !== plan.instanceCreatedAt ||
      center.center_epoch !== plan.centerEpoch || db.prepare('SELECT write_mode FROM im_settings WHERE singleton=1').get().write_mode !== 'paused' ||
      !db.prepare('SELECT 1 FROM im_retention_policies WHERE policy_hash=?').get(plan.executionPolicyHash) ||
      db.prepare('SELECT 1 FROM im_recovery_runs WHERE run_id=?').get(plan.recoveryRunId)) conflict();
  if (plan.preparationRef !== null) {
    const preparation = db.prepare('SELECT kind,initial_epoch,policy_hash FROM im_schema_preparations WHERE preparation_ref=?').get(plan.preparationRef);
    if (!preparation || preparation.kind !== (plan.candidateKind === 'fresh_bootstrap' ? 'fresh' : 'v3_import') ||
        preparation.initial_epoch !== plan.centerEpoch || preparation.policy_hash !== plan.executionPolicyHash ||
        center.status !== 'prepared' || center.recovery_run_id !== null) conflict();
  }
  if (version === 5 && (db.prepare('SELECT 1 FROM im_maintenance_time_anchors LIMIT 1').get() ||
      db.prepare('SELECT 1 FROM im_maintenance_time_head LIMIT 1').get())) conflict();
  budget.tick();
  return db.prepare('SELECT last_observed_at FROM im_clock WHERE singleton=1').get().last_observed_at;
}
function transitionRow(plan, planHash, approvalRef, executorId, approverId, convertedAt) {
  return { transition_id: plan.transitionId, from_version: 4, to_version: 5,
    instance_id: plan.instanceId, instance_created_at: plan.instanceCreatedAt, center_epoch: plan.centerEpoch,
    from_checksum: plan.fromChecksum, to_checksum: plan.toChecksum, recovery_run_id: plan.recoveryRunId,
    stage_hash: plan.stageHash, candidate_reference: plan.candidateReference, candidate_kind: plan.candidateKind,
    preparation_ref: plan.preparationRef, source_evidence_hash: plan.sourceEvidenceHash,
    preconversion_file_hash: plan.preconversionFileHash, execution_policy_hash: plan.executionPolicyHash,
    plan_created_at: plan.createdAt, plan_expires_at: plan.expiresAt, approver_id: approverId,
    approved_plan_hash: planHash, approval_ref: approvalRef, executor_id: executorId, converted_at: convertedAt };
}
function verifyRow(db, expected, budget) {
  const rows = db.prepare('SELECT * FROM im_center_schema_transitions LIMIT 2').all();
  budget.tick();
  if (rows.length !== 1 || Object.keys(expected).some(key => rows[0][key] !== expected[key])) conflict();
}
export function applyOwnedCandidateSchemaV5(resources) {
  if (types.isProxy(resources)) conflict();
  shape(resources, ['candidatePath', 'plan', 'planHash', 'approvalRef', 'executorId', 'approverId', 'budget', 'checkAuthorizationAndTime']);
  const { candidatePath: path, budget, checkAuthorizationAndTime: gate, planHash, approvalRef, executorId, approverId } = resources;
  if (!isRecoveryOperationBudget(budget) || typeof path !== 'string' || typeof gate !== 'function' ||
      types.isProxy(gate) || types.isAsyncFunction(gate) || types.isGeneratorFunction(gate)) conflict();
  const plan = copy('conversionPlan', resources.plan);
  if (plan.fromChecksum !== V4_CHECKSUM || plan.toChecksum !== V5_CHECKSUM || hashMaintenanceV5Record('conversionPlan', plan) !== planHash) conflict();
  budget.tick();
  const identity = standalone(path, budget);
  if (fileHash(path, budget) !== plan.preconversionFileHash) conflict();
  let db, proof, expected, failure, commitAttempted = false;
  const sample = floor => {
    const at = gate();
    if (!time(at) || at < floor || at < plan.createdAt || at >= plan.expiresAt) conflict();
    budget.tick(); return at;
  };
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
    if (!same(identity, protectedPath(path)) || db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') conflict();
    verify(db, plan, budget, 4);
    db.exec('BEGIN IMMEDIATE');
    const floor = verify(db, plan, budget, 4), convertedAt = sample(floor);
    proof = copy('conversionProof', { version: 1, plan, planHash, approvalRef, executorId, approverId, convertedAt });
    expected = transitionRow(plan, planHash, approvalRef, executorId, approverId, convertedAt);
    for (const sql of [...V5_TABLES, ...V5_INDEXES]) { db.exec(sql); budget.tick(); }
    db.exec('DROP TABLE im_schema'); db.exec(V5_SCHEMA);
    db.prepare('INSERT INTO im_schema(version,migration_checksum) VALUES (5,?)').run(V5_CHECKSUM);
    const keys = Object.keys(expected);
    db.prepare(`INSERT INTO im_center_schema_transitions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(expected));
    const finalFloor = verify(db, plan, budget, 5);
    verifyRow(db, expected, budget);
    if (!same(identity, protectedPath(path))) conflict();
    sample(Math.max(finalFloor, convertedAt));
    commitAttempted = true; db.exec('COMMIT');
  } catch (error) { failure = { error: safeFailure(error) }; }
  finally {
    if (db) {
      try { if (db.isTransaction) db.exec('ROLLBACK'); }
      catch { failure = { error: uncertain() }; }
      closeConversionCandidate(db, path);
    }
  }
  if (!same(identity, standalone(path, budget))) conflict();
  // Never retry DDL here. Reopen under the caller's unchanged locks and timer.
  if (failure && !commitAttempted) throw failure.error;
  let reader, actualVersion;
  try {
    reader = new DatabaseSync(path, { readOnly: true });
    reader.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; BEGIN');
    const marker = reader.prepare("SELECT CASE WHEN typeof(version)='integer' THEN version ELSE NULL END AS version,length(CAST(migration_checksum AS BLOB)) AS bytes FROM im_schema LIMIT 2").all();
    if (marker.length !== 1 || marker[0].bytes !== 64 || ![4, 5].includes(marker[0].version)) conflict();
    actualVersion = marker[0].version;
    verify(reader, plan, budget, actualVersion);
    if (actualVersion === 5) verifyRow(reader, expected, budget);
  } catch (error) { throw safeFailure(error); }
  finally {
    try { if (reader?.isTransaction) reader.exec('ROLLBACK'); }
    finally { closeConversionCandidate(reader, path); }
  }
  if (!same(identity, standalone(path, budget))) conflict();
  if (actualVersion === 4) {
    if (fileHash(path, budget) !== plan.preconversionFileHash) conflict();
    throw uncertain();
  }
  budget.tick(); return proof;
}
