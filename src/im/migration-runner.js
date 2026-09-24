import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createImMigration } from './migration.js';
import { createImBackup } from './backup.js';
import { assertImSchema, IM_SCHEMA_VERSION } from './schema.js';
import { withImmediateTransaction } from './transaction.js';

const VERSION = 'im-migration-runner-v1';
const PLAN_VERSION = 'legacy-bindings-v1';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// All operator authentication and approval decisions belong to trusted local injected authorities.
// Neither an operator-supplied flag nor a submitted digest constitutes authorization.
export function createImMigrationRunner({ db, authority, approvalAuthority, provenanceResolver, backup, sourceId,
  actorId = 'local-admin', clock = Date.now, approvalTtlMs = 300000, fault, probe } = {}) {
  if (!db || !id(sourceId) || !id(actorId) || typeof clock !== 'function' ||
      !Number.isSafeInteger(approvalTtlMs) || approvalTtlMs < 1 || approvalTtlMs > 86400000) throw fail('MIGRATION_INVALID');
  assertImSchema(db);
  const sourceFile = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!sourceFile) throw fail('MIGRATION_INVALID');
  const sourceInstance = sha(sourceFile);
  const schemaChecksum = db.prepare('SELECT migration_checksum FROM im_schema').get().migration_checksum;
  const migration = createImMigration({ db, clock, authorizeAdmin: () => actorId });
  const backupService = backup ?? createImBackup({ db, authority, clock });
  // Never delegate evidence validation to an injected backup facade alone.
  const verifier = createImBackup({ db }).verify;
  const authenticate = context => {
    let accepted = false;
    try { accepted = authority?.authorizeAdmin(context) === true; } catch { /* denied */ }
    if (!accepted) throw fail('MIGRATION_AUTH_DENIED');
  };
  const evidence = pair => {
    probe?.('backup-verification', db.isTransaction);
    if (!own(pair, ['backupPath', 'manifestPath'])) throw fail('MIGRATION_BACKUP_REQUIRED');
    let checked;
    try { checked = verifier(pair); } catch { /* denied */ }
    if (checked?.ok !== true || !id(checked.backupId) || !hash(checked.fileHash) ||
        checked.schemaVersion !== IM_SCHEMA_VERSION) throw fail('MIGRATION_BACKUP_REQUIRED');
    let manifest;
    try { manifest = JSON.parse(readFileSync(pair.manifestPath, 'utf8')); } catch { throw fail('MIGRATION_BACKUP_REQUIRED'); }
    if (manifest.sourceId !== sourceId || manifest.schemaChecksum !== schemaChecksum ||
        manifest.backupId !== checked.backupId || manifest.fileHash !== checked.fileHash) throw fail('MIGRATION_BACKUP_REQUIRED');
    return { backupId: checked.backupId, fileHash: checked.fileHash };
  };
  // The resolver is an injected trusted registration authority, NOT the caller's package or manifest.
  // Resolve twice: expensive physical verification outside the lock, small registration check inside.
  const registered = (proof, context) => {
    if (typeof provenanceResolver?.resolve !== 'function') throw fail('MIGRATION_PROVENANCE_REQUIRED');
    const identity = Object.freeze({ sourceId, sourceInstance, backupId: proof.backupId,
      fileHash: proof.fileHash, schemaVersion: IM_SCHEMA_VERSION, schemaChecksum });
    let record;
    try { record = provenanceResolver.resolve(identity, context); } catch { /* fail closed */ }
    if (!record || record.then || record.registered !== true || record.publicationState !== 'published' ||
        record.revoked !== false || !id(record.registrationGeneration) ||
        record.sourceId !== sourceId || record.sourceInstance !== sourceInstance ||
        record.backupId !== proof.backupId || record.fileHash !== proof.fileHash ||
        record.schemaVersion !== IM_SCHEMA_VERSION || record.schemaChecksum !== schemaChecksum)
      throw fail('MIGRATION_PROVENANCE_REJECTED');
    return record.registrationGeneration;
  };
  const packageFor = (bindings, backupProof, expiresAt) => {
    const current = migration.previewLegacyBindings(bindings, undefined);
    return { toolVersion: VERSION, planVersion: PLAN_VERSION, actorId, schemaVersion: IM_SCHEMA_VERSION,
      schemaChecksum, sourceId, sourceInstance, previewId: current.previewId,
      sourceFingerprint: current.sourceFingerprint, proposedBindings: current.proposedBindings,
      backupId: backupProof.backupId, fileHash: backupProof.fileHash,
      operation: 'bind-legacy-members', expectedImpact: { bindingCount: current.proposedBindings.length,
        legacyMessagesCopied: 0, imWriteModeChanged: false }, expiresAt };
  };
  const now = () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw fail('MIGRATION_INVALID');
    return value;
  };

  async function createBackup({ destinationPath, approvalId } = {}, context) {
    authenticate(context);
    return backupService.backup({ destinationPath, approvalId, sourceId, adminContext: context });
  }
  function preview(proposedBindings, pair, context) {
    authenticate(context);
    const proof = evidence(pair);
    const expiresAt = now() + approvalTtlMs;
    if (!Number.isSafeInteger(expiresAt)) throw fail('MIGRATION_INVALID');
    const plan = packageFor(proposedBindings, proof, expiresAt);
    return { package: plan, planHash: sha(plan) };
  }
  function commit(request, context) {
    authenticate(context);
    if (!own(request, ['package', 'planHash', 'approval', 'backup']) || !hash(request.planHash) ||
        !own(request.approval, ['approver', 'planHash', 'backupId']) || !id(request.approval.approver) ||
        request.approval.planHash !== request.planHash || request.approval.backupId !== request.package?.backupId ||
        !own(request.package, ['toolVersion', 'planVersion', 'actorId', 'schemaVersion', 'schemaChecksum', 'sourceId',
          'sourceInstance', 'previewId', 'sourceFingerprint', 'proposedBindings', 'backupId', 'fileHash',
          'operation', 'expectedImpact', 'expiresAt']) || !hash(request.package.sourceFingerprint) ||
        !hash(request.package.fileHash) || !Number.isSafeInteger(request.package.expiresAt) ||
        request.package.expiresAt <= now() || sha(request.package) !== request.planHash) throw fail('MIGRATION_APPROVAL_INVALID');
    let approved = false;
    try { approved = approvalAuthority?.authorizeApproval(request.approval, context) === true; } catch { /* denied */ }
    if (!approved) throw fail('MIGRATION_APPROVAL_INVALID');
    const proof = evidence(request.backup);
    if (proof.backupId !== request.package.backupId || proof.fileHash !== request.package.fileHash) throw fail('MIGRATION_BACKUP_REQUIRED');
    const generation = registered(proof, context);
    return withImmediateTransaction(db, () => {
      // Never hash files, run integrity/FK/schema scans, or query the entire backup under the write lock.
      if (sha(db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file) !== sourceInstance ||
          db.prepare('SELECT migration_checksum FROM im_schema').get()?.migration_checksum !== schemaChecksum)
        throw fail('MIGRATION_STALE');
      authenticate(context);
      let stillApproved = false;
      try { stillApproved = approvalAuthority?.authorizeApproval(request.approval, context) === true; } catch { /* denied */ }
      if (!stillApproved) throw fail('MIGRATION_APPROVAL_INVALID');
      if (registered(proof, context) !== generation) throw fail('MIGRATION_PROVENANCE_REJECTED');
      const completedAt = now();
      if (completedAt >= request.package.expiresAt) throw fail('MIGRATION_APPROVAL_INVALID');
      const existing = db.prepare('SELECT preview_hash,status,actor_id,completed_at FROM im_migration_runs WHERE run_id=?')
        .get(request.package.previewId);
      if (existing) {
        const saved = db.prepare('SELECT legacy_member,agent_id,approval_ref,status FROM im_legacy_bindings WHERE migration_run_id=? ORDER BY legacy_member')
          .all(request.package.previewId);
        const bindings = request.package.proposedBindings;
        if (existing.status !== 'completed' || existing.preview_hash !== request.package.sourceFingerprint ||
            existing.actor_id !== actorId || saved.length !== bindings.length ||
            !saved.every((row, i) => row.legacy_member === bindings[i]?.legacyMember &&
              row.agent_id === bindings[i]?.agentId && row.approval_ref === request.planHash && row.status === 'active'))
          throw fail('MIGRATION_STALE');
        // A retry must still validate the whole package, not only the run ID.
        const audit = db.prepare("SELECT safe_details_json FROM im_audit WHERE action='legacy_bindings_committed' AND actor_id=? ORDER BY id DESC")
          .all(actorId).map(row => JSON.parse(row.safe_details_json)).find(row => row.runId === request.package.previewId);
        if (request.package.actorId !== actorId || request.package.toolVersion !== VERSION || request.package.planVersion !== PLAN_VERSION ||
            request.package.sourceId !== sourceId || request.package.sourceInstance !== sourceInstance ||
            request.package.schemaChecksum !== schemaChecksum || audit?.planHash !== request.planHash ||
            audit?.backupId !== proof.backupId || audit?.approver !== request.approval.approver) throw fail('MIGRATION_STALE');
        return { runId: request.package.previewId, status: 'completed', bindingCount: saved.length, completedAt: existing.completed_at };
      }
      let current;
      try { current = packageFor(request.package.proposedBindings, proof, request.package.expiresAt); }
      catch { throw fail('MIGRATION_STALE'); }
      if (JSON.stringify(current) !== JSON.stringify(request.package) || sha(current) !== request.planHash) throw fail('MIGRATION_STALE');
      db.prepare('INSERT INTO im_migration_runs(run_id,preview_hash,status,actor_id,created_at,completed_at) VALUES (?,?,?,?,?,?)')
        .run(current.previewId, current.sourceFingerprint, 'completed', actorId, completedAt, completedAt);
      const insert = db.prepare("INSERT INTO im_legacy_bindings(legacy_member,agent_id,approval_ref,migration_run_id,status,source) VALUES (?,?,?,?,'active','legacy_ip')");
      for (const binding of current.proposedBindings) {
        insert.run(binding.legacyMember, binding.agentId, request.planHash, current.previewId);
        fault?.('after-binding');
      }
      db.prepare('INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json) VALUES (?,?,?,?,?,?)')
        .run('admin', actorId, 'legacy_bindings_committed', JSON.stringify(current.proposedBindings.map(b => b.agentId)),
          completedAt, JSON.stringify({ runId: current.previewId, bindingCount: current.proposedBindings.length,
             planHash: request.planHash, backupId: proof.backupId, approver: request.approval.approver }));
      return { runId: current.previewId, status: 'completed', bindingCount: current.proposedBindings.length, completedAt };
    });
  }
  return Object.freeze({ createBackup, preview, commit });
}
