import { createHash } from 'node:crypto';
import { createImMigration } from './migration.js';
import { getInstanceIdentity, IM_SCHEMA_VERSION } from './schema.js';
import { resolveImTimeGuard } from './clock.js';

const VERSION = 'im-migration-runner-v2';
const PLAN_VERSION = 'legacy-bindings-v2';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const own = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const packageKeys = ['toolVersion', 'planVersion', 'actorId', 'instanceId', 'instanceCreatedAt',
  'registrationGeneration', 'schemaVersion', 'schemaChecksum', 'previewId', 'sourceFingerprint',
  'proposedBindings', 'backupId', 'fileHash', 'manifestHash', 'operation', 'expectedImpact', 'expiresAt'];
const impact = count => ({ bindingCount: count, legacyMessagesCopied: 0, imWriteModeChanged: false });

// Trusted in-process constructor. The externally configured composition is createTrustedMigrationServices.
export function createImMigrationRunner(options = {}) {
  const allowed = ['db', 'registry', 'publisher', 'authority', 'approvalAuthority', 'actorId', 'clock',
    'approvalTtlMs', 'fault', 'timeGuard'];
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Reflect.ownKeys(options).some(key => !allowed.includes(key))) throw fail('MIGRATION_INVALID');
  const { db, registry, publisher, authority, approvalAuthority,
    actorId = 'local-admin', clock = Date.now, approvalTtlMs = 300000, fault, timeGuard } = options;
  if (!db || !registry || !publisher || !id(actorId) || typeof clock !== 'function' ||
      !Number.isSafeInteger(approvalTtlMs) || approvalTtlMs < 1 || approvalTtlMs > 86400000)
    throw fail('MIGRATION_INVALID');
  const guard = resolveImTimeGuard(db, clock, timeGuard);
  // This helper supplies canonical binding validation and source fingerprinting only.
  // Its commit method must never run beneath the registry or our write transaction.
  const migration = createImMigration({ db, clock, timeGuard: guard, authorizeAdmin: () => actorId });
  const authenticate = context => {
    let accepted = false;
    try { accepted = authority?.authorizeAdmin(context) === true; } catch { /* denied */ }
    if (!accepted) throw fail('MIGRATION_AUTH_DENIED');
  };
  const approve = (approval, context) => {
    let accepted = false;
    try { accepted = approvalAuthority?.authorizeApproval(approval, context) === true; } catch { /* denied */ }
    if (!accepted) throw fail('MIGRATION_APPROVAL_INVALID');
  };
  const now = () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw fail('MIGRATION_INVALID');
    return value;
  };
  const live = () => {
    if (db.isTransaction !== false) throw fail('MIGRATION_INVALID');
    const identity = getInstanceIdentity(db); // strict full schema/FK scan, never under a live write lock
    const marker = db.prepare('SELECT version,migration_checksum FROM im_schema').get();
    const cookie = db.prepare('PRAGMA schema_version').get()?.schema_version;
    if (marker?.version !== IM_SCHEMA_VERSION || !hash(marker.migration_checksum) || !Number.isSafeInteger(cookie))
      throw fail('MIGRATION_STALE');
    return { instanceId: identity.instanceId, instanceCreatedAt: identity.createdAt,
      registrationGeneration: 1, schemaVersion: marker.version, schemaChecksum: marker.migration_checksum, cookie };
  };
  live(); // Factory cannot be constructed for structural v2 without initialized identity.
  const sameIdentity = (proof, current) => proof.instanceId === current.instanceId &&
    proof.instanceCreatedAt === current.instanceCreatedAt && proof.registrationGeneration === current.registrationGeneration &&
    proof.schemaVersion === current.schemaVersion && proof.schemaChecksum === current.schemaChecksum;
  const packageFor = (bindings, proof, expiresAt) => {
    const current = migration.previewLegacyBindings(bindings, undefined);
    return { toolVersion: VERSION, planVersion: PLAN_VERSION, actorId, instanceId: proof.instanceId,
      instanceCreatedAt: proof.instanceCreatedAt, registrationGeneration: proof.registrationGeneration,
      schemaVersion: proof.schemaVersion, schemaChecksum: proof.schemaChecksum, previewId: current.previewId,
      sourceFingerprint: current.sourceFingerprint, proposedBindings: current.proposedBindings,
      backupId: proof.backupId, fileHash: proof.fileHash, manifestHash: proof.manifestHash,
      operation: 'bind-legacy-members', expectedImpact: impact(current.proposedBindings.length), expiresAt };
  };
  // Indexed by im_legacy_bindings_run in the explicitly upgraded v3 schema.
  // A bounded complete rowset check, including unexpected/revoked rows, rather
  // than an approved-member subset check or a SQLite/JS ordering comparison.
  const completeBindings = (plan, planHash) => {
    const approved = new Map(plan.proposedBindings.map(binding => [binding.legacyMember, binding.agentId]));
    let count = 0;
    for (const row of db.prepare(`SELECT legacy_member,agent_id,approval_ref,migration_run_id,status,source
      FROM im_legacy_bindings INDEXED BY im_legacy_bindings_run WHERE migration_run_id=? LIMIT ?`)
      .iterate(plan.previewId, approved.size + 1)) {
      count++;
      if (count > approved.size || !approved.has(row.legacy_member) ||
          approved.get(row.legacy_member) !== row.agent_id || row.migration_run_id !== plan.previewId ||
          row.approval_ref !== planHash || row.status !== 'active' || row.source !== 'legacy_ip')
        throw fail('MIGRATION_STALE');
    }
    if (count !== approved.size) throw fail('MIGRATION_STALE');
  };
  const checkedPackage = request => {
    if (!own(request, ['package', 'planHash', 'approval']) || !hash(request.planHash) ||
        !own(request.approval, ['approver', 'planHash', 'backupId']) || !id(request.approval.approver) ||
        !own(request.package, packageKeys)) throw fail('MIGRATION_APPROVAL_INVALID');
    const plan = request.package;
    if (plan.toolVersion !== VERSION || plan.planVersion !== PLAN_VERSION || plan.actorId !== actorId ||
        !uuid(plan.instanceId) || !Number.isSafeInteger(plan.instanceCreatedAt) || plan.instanceCreatedAt < 0 ||
        plan.registrationGeneration !== 1 || plan.schemaVersion !== IM_SCHEMA_VERSION || !hash(plan.schemaChecksum) ||
        !uuid(plan.backupId) || !hash(plan.fileHash) || !hash(plan.manifestHash) ||
        !uuid(plan.previewId) || !hash(plan.sourceFingerprint) ||
        !Array.isArray(plan.proposedBindings) || !plan.proposedBindings.length || plan.proposedBindings.length > 1000 ||
        !plan.proposedBindings.every(binding => own(binding, ['legacyMember', 'agentId']) &&
          id(binding.legacyMember) && id(binding.agentId)) ||
        plan.proposedBindings.some((binding, index) => index > 0 &&
          (plan.proposedBindings[index - 1].legacyMember >= binding.legacyMember ||
            plan.proposedBindings[index - 1].agentId === binding.agentId)) ||
        new Set(plan.proposedBindings.map(binding => binding.agentId)).size !== plan.proposedBindings.length ||
        !own(plan.expectedImpact, ['bindingCount', 'legacyMessagesCopied', 'imWriteModeChanged']) ||
        JSON.stringify(plan.expectedImpact) !== JSON.stringify(impact(plan.proposedBindings.length)) ||
        plan.operation !== 'bind-legacy-members' || !Number.isSafeInteger(plan.expiresAt) || plan.expiresAt < 0 ||
        request.approval.planHash !== request.planHash || request.approval.backupId !== plan.backupId ||
        sha(plan) !== request.planHash) throw fail('MIGRATION_APPROVAL_INVALID');
    return plan;
  };

  async function createBackup(input = {}, context) {
    authenticate(context);
    if (!own(input, ['approvalId'])) throw fail('MIGRATION_INVALID');
    const { approvalId } = input;
    if (!id(approvalId)) throw fail('MIGRATION_INVALID');
    return publisher.publish({ adminContext: context, approvalId });
  }
  function preview(bindings, input, context) {
    authenticate(context);
    if (!own(input, ['backupId']) || !uuid(input.backupId)) throw fail('MIGRATION_BACKUP_REQUIRED');
    const current = live();
    const registered = registry.getInstance();
    if (registered?.instanceId !== current.instanceId || registered?.instanceCreatedAt !== current.instanceCreatedAt ||
        registered?.registrationGeneration !== current.registrationGeneration)
      throw fail('MIGRATION_STALE');
    return registry.withDiscoveredBackup({ backupId: input.backupId, expectedIdentity: {
      instanceId: current.instanceId, instanceCreatedAt: current.instanceCreatedAt,
      registrationGeneration: current.registrationGeneration } }, proof => {
      if (!sameIdentity(proof, current)) throw fail('MIGRATION_BACKUP_REQUIRED');
      const expiresAt = now() + approvalTtlMs;
      if (!Number.isSafeInteger(expiresAt)) throw fail('MIGRATION_INVALID');
      const plan = packageFor(bindings, proof, expiresAt);
      return { package: plan, planHash: sha(plan) };
    });
  }
  function commit(request, context) {
    authenticate(context);
    const plan = checkedPackage(request);
    approve(request.approval, context);
    const current = live();
    if (!sameIdentity(plan, current)) throw fail('MIGRATION_STALE');
    // Find the completed batch's audit by streaming outside the write transaction.
    // There is no index on audit runId; only its captured primary key is read inside.
    const prior = db.prepare('SELECT 1 FROM im_migration_runs WHERE run_id=?').get(plan.previewId);
    let auditId;
    if (prior) {
      for (const row of db.prepare("SELECT id,safe_details_json FROM im_audit WHERE action='legacy_bindings_committed' AND actor_id=? ORDER BY id DESC").iterate(actorId)) {
        let details;
        try { details = JSON.parse(row.safe_details_json); } catch { throw fail('MIGRATION_STALE'); }
        if (details?.runId === plan.previewId) { auditId = row.id; break; }
      }
    }
    const expected = { instanceId: plan.instanceId, instanceCreatedAt: plan.instanceCreatedAt,
      registrationGeneration: plan.registrationGeneration, fileHash: plan.fileHash,
      manifestHash: plan.manifestHash, schemaVersion: plan.schemaVersion, schemaChecksum: plan.schemaChecksum };
    // Registry coordinator -> full verification outside the live write transaction -> live DB guard.
    return registry.withVerifiedBackup({ backupId: plan.backupId, expected }, evidence => {
      if (db.isTransaction !== false || !sameIdentity(evidence, current)) throw fail('MIGRATION_BACKUP_REQUIRED');
      return guard.runWriteFresh(() => {
        // Only bounded point queries and metadata recheck under the live transaction.
        const identity = db.prepare('SELECT instance_id,created_at FROM im_instance_identity WHERE singleton=1').get();
        const marker = db.prepare('SELECT version,migration_checksum FROM im_schema').get();
        const registered = db.prepare('PRAGMA schema_version').get()?.schema_version;
        if (identity?.instance_id !== current.instanceId || identity?.created_at !== current.instanceCreatedAt ||
            marker?.version !== current.schemaVersion || marker?.migration_checksum !== current.schemaChecksum ||
            registered !== current.cookie) throw fail('MIGRATION_STALE');
        evidence.recheck();
        authenticate(context);
        approve(request.approval, context);
        // Exact canonical shape is checked before time is refreshed, including on a completed retry.
        if (sha(plan) !== request.planHash || request.package !== plan ||
            request.approval.planHash !== request.planHash || request.approval.backupId !== plan.backupId)
          throw fail('MIGRATION_APPROVAL_INVALID');
        // A completed retry has bindings of its own; the saved-run branch below
        // validates those. A first commit must recompute its entire fingerprint
        // before sampling the fresh time used for business effects.
        const existing = db.prepare('SELECT preview_hash,status,actor_id,completed_at FROM im_migration_runs WHERE run_id=?').get(plan.previewId);
        let canonical;
        if (!existing) {
          try { canonical = packageFor(plan.proposedBindings, evidence, plan.expiresAt); }
          catch { throw fail('MIGRATION_STALE'); }
          if (JSON.stringify(canonical) !== JSON.stringify(plan) || sha(canonical) !== request.planHash) throw fail('MIGRATION_STALE');
        }
        const completedAt = guard.refreshCurrent();
        if (completedAt >= plan.expiresAt) throw fail('MIGRATION_APPROVAL_INVALID');
        let result;
        if (existing) {
          const auditRow = auditId === undefined ? null : db.prepare('SELECT actor_kind,actor_id,action,target_ids_json,safe_details_json FROM im_audit WHERE id=?').get(auditId);
          let audit, targets;
          try {
            audit = JSON.parse(auditRow.safe_details_json);
            targets = JSON.parse(auditRow.target_ids_json);
          } catch { throw fail('MIGRATION_STALE'); }
          if (existing.status !== 'completed' || existing.preview_hash !== plan.sourceFingerprint || existing.actor_id !== actorId ||
              auditRow?.actor_kind !== 'admin' || auditRow.actor_id !== actorId || auditRow.action !== 'legacy_bindings_committed' ||
              audit?.runId !== plan.previewId || audit?.bindingCount !== plan.proposedBindings.length ||
              JSON.stringify(targets) !== JSON.stringify(plan.proposedBindings.map(binding => binding.agentId)) ||
              audit.planHash !== request.planHash || audit.backupId !== plan.backupId ||
              audit.approver !== request.approval.approver)
            throw fail('MIGRATION_STALE');
          result = { runId: plan.previewId, status: 'completed', bindingCount: plan.proposedBindings.length, completedAt: existing.completed_at };
        } else {
          db.prepare('INSERT INTO im_migration_runs(run_id,preview_hash,status,actor_id,created_at,completed_at) VALUES (?,?,?,?,?,?)')
            .run(plan.previewId, plan.sourceFingerprint, 'completed', actorId, completedAt, completedAt);
          const insert = db.prepare("INSERT INTO im_legacy_bindings(legacy_member,agent_id,approval_ref,migration_run_id,status,source) VALUES (?,?,?,?,'active','legacy_ip')");
          for (const binding of canonical.proposedBindings) {
            insert.run(binding.legacyMember, binding.agentId, request.planHash, plan.previewId);
            fault?.('after-binding'); // internal isolated failure test only
          }
          db.prepare('INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json) VALUES (?,?,?,?,?,?)')
            .run('admin', actorId, 'legacy_bindings_committed', JSON.stringify(canonical.proposedBindings.map(b => b.agentId)),
              completedAt, JSON.stringify({ runId: plan.previewId, bindingCount: canonical.proposedBindings.length,
                planHash: request.planHash, backupId: plan.backupId, approver: request.approval.approver }));
          result = { runId: plan.previewId, status: 'completed', bindingCount: canonical.proposedBindings.length, completedAt };
        }
        if (guard.refreshCurrent() >= plan.expiresAt) throw fail('MIGRATION_APPROVAL_INVALID');
        // This is the final business operation, after the final fresh expiry
        // observation. No external authority/clock/fault callback follows it.
        completeBindings(plan, request.planHash);
        return result;
      });
    });
  }
  return Object.freeze({ createBackup, preview, commit });
}
