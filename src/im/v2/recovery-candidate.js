// Private candidate ownership. Connections never cross the recovery facade.
import { closeSync, fsyncSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { withClosedBackupSnapshot } from '../backup-snapshot.js';
import { createRegistryLock } from '../registry-lock.js';
import { initializeImSchemaV4, migrateImSchemaV4 } from './migration.js';
import { assertImSchemaV4Internal, projectCandidateBudget, V4_DDL } from './schema-internal.js';
import { assertFrozenV3Structure, V3_CHECKSUM, V3_DDL } from './schema-history.js';
import { createImV2ClockGuard } from './clock.js';
import { decodeRecoveryRecord, encodeRecoveryRecord, hashRecoveryRecord, validateRecoveryNormalizationBindings, validateRecoveryPauseBindings, validateRecoveryPlanBindings } from './recovery-plan.js';
import { checkOpened, directoryEntries, exists, fail, fileHash, invalid, privateDirectory, protectedPath,
  publishBytes, publishPending, readBytes, reserve, resyncPublished, same, sha,
  streamFile, syncDirectory, writeAll } from './recovery-records.js';

const unclosedCandidates = new Map();
export function directory(path) {
  if (!exists(path)) { mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)); }
  privateDirectory(path); syncDirectory(dirname(path)); return path;
}
export function lock(path, create, consume) {
  privateDirectory(path);
  if (!create && !exists(join(path, 'coordination.sqlite'))) throw fail('RECOVERY_INDETERMINATE');
  for (const suffix of ['-wal', '-shm', '-journal']) if (exists(join(path, `coordination.sqlite${suffix}`))) invalid();
  try {
    return createRegistryLock(path, { privateDirectory, protectedPath, checkOpened, syncDirectory }).withLock(consume);
  } catch (error) {
    if (error?.code === 'REGISTRY_BUSY') throw fail('RECOVERY_BUSY');
    if (error?.code?.startsWith('REGISTRY_')) invalid();
    throw error;
  }
}
export const readRecord = (path, kind, budget) => exists(path) ? decodeRecoveryRecord(kind, readBytes(path, budget)) : null;
export function putRecord(path, kind, value, budget) {
  const bytes = encodeRecoveryRecord(kind, value);
  if (exists(path) && !readBytes(path, budget).equals(bytes)) invalid();
  publishBytes(path, bytes, budget);
  return decodeRecoveryRecord(kind, bytes);
}
export function standalone(path, budget) {
  if (unclosedCandidates.has(path)) throw fail('RECOVERY_INDETERMINATE');
  const { before, mode } = closedHeader(path, budget);
  if (mode !== 'DELETE') throw fail('RECOVERY_INDETERMINATE');
  return before;
}
function closedHeader(path, budget) {
  privateDirectory(dirname(path)); const before = protectedPath(path);
  for (const suffix of ['-wal', '-shm', '-journal']) if (exists(path + suffix)) throw fail('RECOVERY_INDETERMINATE');
  let header;
  streamFile(path, chunk => { header ??= Buffer.from(chunk.subarray(0, 100)); }, budget);
  if (!header || header.length < 100 || header.toString('ascii', 0, 16) !== 'SQLite format 3\0' ||
      ![1, 2].includes(header[18]) || header[18] !== header[19])
    throw fail('RECOVERY_INDETERMINATE');
  return { before, mode: header[18] === 1 ? 'DELETE' : 'WAL' };
}
function stepTime(now, floor) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0 || value < floor) invalid();
  return value;
}
// This is only for a completed, source-bound copy under exclusive control. It
// is never used by status or to hide a candidate's WAL after a mutation starts.
function inspectBase(path, stage, budget, expectedMode) {
  const header = closedHeader(path, budget), e = stage.sourceEvidence;
  const expectedHash = e.fileHash ?? e.closedSourceFileHash;
  if (fileHash(path, budget) !== expectedHash) throw fail('RECOVERY_INDETERMINATE');
  const writeMode = withClosedBackupSnapshot(path, db => {
    if (e.schemaVersion === 3) {
      projectCandidateBudget(db, budget, 3); assertFrozenV3Structure(db, budget);
    } else validateV4(db, budget);
    for (const row of db.prepare('PRAGMA integrity_check').iterate()) { budget.tick(); if (row.integrity_check !== 'ok') invalid(); }
    for (const row of db.prepare('PRAGMA foreign_key_check').iterate()) { budget.tick(); invalid(); }
    const identity = db.prepare('SELECT instance_id,created_at FROM im_instance_identity WHERE singleton=1').get();
    const marker = db.prepare('SELECT version,migration_checksum FROM im_schema').get();
    const mode = db.prepare('SELECT write_mode FROM im_settings WHERE singleton=1').get()?.write_mode;
    if (identity?.instance_id !== e.instanceId || identity.created_at !== e.instanceCreatedAt ||
        marker?.version !== e.schemaVersion || marker.migration_checksum !== e.schemaChecksum ||
        !['paused', 'enabled'].includes(mode) || (expectedMode !== undefined && mode !== expectedMode)) invalid();
    return mode;
  });
  if (!same(header.before, protectedPath(path)) || fileHash(path, budget) !== expectedHash) invalid();
  closedHeader(path, budget);
  return { ...header, writeMode };
}
const quote = name => `"${name.replaceAll('"', '""')}"`;
// Complete deterministic logical streams, not row counts. A statement yields
// one row (the frozen schema has at most one BLOB column); no row arrays or BLOB
// copies are retained. Integers, REAL bit patterns, NULL, TEXT and BLOB are tagged.
function logicalDigest(db, budget, version) {
  projectCandidateBudget(db, budget, version);
  const digest = createHash('sha256');
  let bytes = 0;
  const update = chunk => {
    const length = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
    if (!Number.isSafeInteger(length) || !Number.isSafeInteger(bytes + length) ||
        bytes + length > budget.limits.maxFileBytes) throw fail('RECOVERY_BUSY');
    bytes += length;
    digest.update(chunk);
  };
  const value = (type, input) => {
    budget.tick();
    let data;
    if (type === 'blob' || (type === 'text' && input instanceof Uint8Array)) data = input;
    else if (type === 'real') { data = Buffer.allocUnsafe(8); data.writeDoubleBE(input); }
    else data = Buffer.from(type === 'null' ? '' : String(input), 'utf8');
    update(`${type}:${data.length}:`); update(data); budget.tick();
  };
  const expected = new Set((version === 3 ? V3_DDL : V4_DDL).filter(sql => sql.startsWith('CREATE TABLE ')).map(sql => /^CREATE TABLE (im_\w+)/.exec(sql)[1]));
  for (const pragma of ['user_version', 'application_id', 'encoding']) {
    value('pragma', pragma);
    const fact = db.prepare(`PRAGMA ${pragma}`).get()[pragma];
    value(typeof fact === 'number' ? 'integer' : 'text', fact);
  }
  let objects = 0;
  for (const row of db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY name LIMIT ?').iterate(budget.limits.maxMetadataEntries + 1)) {
    if (++objects > budget.limits.maxMetadataEntries) throw fail('RECOVERY_BUSY');
    // rootpage is a physical placement fact, not logical schema. Preserve the
    // complete SQL and object identity, including automatic indexes.
    for (const key of ['type', 'name', 'tbl_name', 'sql']) value(row[key] === null ? 'null' : 'text', row[key]);
    if (row.type !== 'table') continue;
    if (!expected.has(row.name)) invalid();
    value('table', row.name);
    const columns = [];
    for (const col of db.prepare(`PRAGMA table_info(${quote(row.name)})`).iterate()) {
      budget.tick(); if (columns.length >= 128) invalid(); columns.push(col.name);
    }
    const selection = columns.map((col, index) => `CASE typeof(${quote(col)}) WHEN 'text' THEN CAST(${quote(col)} AS BLOB) ELSE ${quote(col)} END AS v${index},typeof(${quote(col)}) AS t${index}`).join(',');
    const statement = db.prepare(`SELECT rowid AS logicalRowId,${selection} FROM ${quote(row.name)} ORDER BY rowid LIMIT ?`);
    statement.setReadBigInts(true);
    const limit = budget.limits.maxMessages + budget.limits.maxOtherRecords;
    let count = 0;
    for (const row of statement.iterate(limit + 1)) {
      if (++count > limit) throw fail('RECOVERY_BUSY');
      update('row:');
      value('integer', row.logicalRowId);
      for (let index = 0; index < columns.length; index++) value(row[`t${index}`], row[`v${index}`]);
    }
    value('rows', count);
  }
  return digest.digest('hex');
}
function normalizeCandidate({ path, runRoot, stage, copyIntent, base, budget, now }) {
  let intent = readRecord(join(runRoot, 'normalization-intent.json'), 'normalizationIntent', budget);
  let normalized = readRecord(join(runRoot, 'normalized.json'), 'normalized', budget);
  if (!normalized) {
    const actual = inspectBase(path, stage, budget, base.sourceWriteMode);
    const proposed = { version: 1, runId: stage.runId, stageHash: base.stageHash, baseRecordHash: hashRecoveryRecord('base', base),
      candidateReference: stage.candidateReference, candidateBaseHash: base.candidateBaseHash, originalHeaderMode: actual.mode,
      targetHeaderMode: 'DELETE', createdAt: intent?.createdAt ?? stepTime(now, base.copyStartedAt) };
    if (intent && hashRecoveryRecord('normalizationIntent', intent) !== hashRecoveryRecord('normalizationIntent', proposed)) invalid();
    if (proposed.createdAt < base.copyStartedAt) invalid();
    stepTime(now, proposed.createdAt);
    intent = putRecord(join(runRoot, 'normalization-intent.json'), 'normalizationIntent', proposed, budget);
    if (actual.mode === 'WAL') {
      const beforeDigest = withClosedBackupSnapshot(path, db => logicalDigest(db, budget, base.sourceSchemaVersion));
      let db, failure;
      try {
        db = new DatabaseSync(path);
        db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
        const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (checkpoint?.busy !== 0) throw fail('RECOVERY_BUSY');
        if (db.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete') invalid();
        budget.tick();
      } catch (error) { failure = error; }
      try { db?.close(); } catch { failure ??= fail('RECOVERY_INDETERMINATE'); }
      if (failure) throw failure;
      if (!same(actual.before, standalone(path, budget))) invalid();
      const afterDigest = database(path, budget, false, db => logicalDigest(db, budget, base.sourceSchemaVersion));
      if (beforeDigest !== afterDigest) invalid();
    }
    resyncPublished(path, budget);
    normalized = { version: 1, runId: stage.runId, stageHash: base.stageHash,
      normalizationIntentHash: hashRecoveryRecord('normalizationIntent', intent), candidateBaseHash: base.candidateBaseHash,
      normalizedCandidateHash: fileHash(path, budget), changed: actual.mode === 'WAL', normalizedAt: stepTime(now, intent.createdAt) };
    validateRecoveryNormalizationBindings({ stage, copyIntent, base, normalizationIntent: intent, normalized });
    putRecord(join(runRoot, 'normalized.json'), 'normalized', normalized, budget);
  }
  validateRecoveryNormalizationBindings({ stage, copyIntent, base, normalizationIntent: intent, normalized });
  putRecord(join(runRoot, 'normalization-intent.json'), 'normalizationIntent', intent, budget);
  putRecord(join(runRoot, 'normalized.json'), 'normalized', normalized, budget);
  return { normalizationIntent: intent, normalized };
}
export function database(path, budget, writable, consume) {
  const before = standalone(path, budget);
  let db, result;
  try {
    db = new DatabaseSync(path, { readOnly: !writable });
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
    if (!same(before, protectedPath(path)) || db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') invalid();
    result = consume(db);
    budget.tick();
  } finally {
    let closeFailed = false;
    try { db?.close(); }
    catch {
      closeFailed = true;
      // A thrown native close may have already closed, or may leave an owned
      // connection alive. Never hash/publish through the latter uncertainty.
      try { if (db?.isOpen) db.close(); } catch { /* retain below */ }
      if (db?.isOpen !== false) {
        unclosedCandidates.set(path, db);
        throw fail('RECOVERY_INDETERMINATE');
      }
    }
    if (!same(before, protectedPath(path))) invalid();
    standalone(path, budget);
    if (writable) resyncPublished(path, budget);
    if (closeFailed) throw fail('RECOVERY_DURABILITY_UNCERTAIN');
  }
  return result;
}
export function validateV4(db, budget) {
  assertImSchemaV4Internal(db, budget);
  for (const row of db.prepare('PRAGMA integrity_check').iterate()) { budget.tick(); if (row.integrity_check !== 'ok') invalid(); }
  for (const row of db.prepare('PRAGMA foreign_key_check').iterate()) { budget.tick(); invalid(); }
  budget.tick();
}
function facts(db, stage, budget) {
  validateV4(db, budget);
  const identity = db.prepare('SELECT * FROM im_instance_identity').get();
  const center = db.prepare('SELECT * FROM im_center_state').get();
  const writeMode = db.prepare('SELECT write_mode FROM im_settings').get().write_mode;
  const preparation = stage.preparationRef === null ? null : db.prepare('SELECT * FROM im_schema_preparations WHERE preparation_ref=?').get(stage.preparationRef);
  if (stage.preparationRef !== null) {
    const kind = stage.candidateKind === 'fresh_bootstrap' ? 'fresh' : 'v3_import';
    if (!preparation || preparation.kind !== kind || preparation.policy_hash !== stage.policyHash ||
        preparation.input_hash !== sha(JSON.stringify([kind, kind === 'fresh' ? null : 3, kind === 'fresh' ? null : V3_CHECKSUM,
          JSON.parse(db.prepare('SELECT canonical_json FROM im_retention_policies WHERE policy_hash=?').get(stage.policyHash).canonical_json), stage.preparationRef]))) invalid();
  }
  if (stage.sourceEvidence && (identity.instance_id !== stage.sourceEvidence.instanceId || identity.created_at !== stage.sourceEvidence.instanceCreatedAt)) invalid();
  return { identity, center, writeMode, preparation,
    epoch: db.prepare('SELECT * FROM im_center_epochs WHERE center_epoch=?').get(center.center_epoch),
    schemaChecksum: db.prepare('SELECT migration_checksum FROM im_schema').get().migration_checksum,
    run: db.prepare('SELECT * FROM im_recovery_runs WHERE run_id=?').get(stage.runId) ?? null };
}
export function candidateFacts(path, stage, budget) {
  try {
    return database(path, budget, false, db => {
      db.exec('BEGIN'); try { return facts(db, stage, budget); } finally { db.exec('ROLLBACK'); }
    });
  } catch (error) {
    if (error?.code?.startsWith('RECOVERY_')) throw error;
    if (error?.code === 'IM_V2_BUDGET_EXCEEDED') throw fail('RECOVERY_BUSY');
    invalid();
  }
}
export function assertStaged(stage, staged, actual, base) {
  if (!staged || staged.runId !== stage.runId || staged.stageHash !== hashRecoveryRecord('stage', stage) ||
      staged.preparationRef !== stage.preparationRef || staged.instanceId !== actual.identity.instance_id ||
      staged.instanceCreatedAt !== actual.identity.created_at || staged.candidateBaseHash !== (base?.candidateBaseHash ?? null)) invalid();
  if (stage.candidateKind === 'snapshot_recovery') {
    if (staged.importEpoch !== null || (!actual.run && staged.initialEpoch !== actual.center.center_epoch)) invalid();
  } else if (staged.initialEpoch !== actual.preparation.initial_epoch || staged.importEpoch !== actual.preparation.import_epoch) invalid();
}
export function stageDatabase({ runRoot, stage, proof, policy, budget, now }) {
  const path = join(runRoot, 'candidate.sqlite'), stageHash = hashRecoveryRecord('stage', stage);
  const nonfresh = stage.candidateKind !== 'fresh_bootstrap';
  const p1limits = Object.fromEntries(['maxMessages', 'maxVerifiedContentBytes', 'maxOtherRecords', 'maxElapsedMs'].map(k => [k, budget.limits[k]]));
  let base = readRecord(join(runRoot, 'base.json'), 'base', budget);
  let copyIntent = readRecord(join(runRoot, 'copy-intent.json'), 'copyIntent', budget);
  let chain = null;
  const copy = target => {
    const pending = reserve(runRoot);
    try {
      proof.copyTo(chunk => { budget.tick(); writeAll(pending.fd, chunk); budget.tick(); });
      fsyncSync(pending.fd);
    } finally { closeSync(pending.fd); }
    if (fileHash(pending.path, budget) !== (stage.sourceEvidence.fileHash ?? stage.sourceEvidence.closedSourceFileHash)) invalid();
    publishPending(pending.path, target, pending.identity);
  };
  if (nonfresh) {
    if ((exists(path) || base) && !copyIntent) throw fail('RECOVERY_INDETERMINATE');
    // A deliberately exposes neither mode nor source path. Inspect only bytes
    // copied through its genuine, still-live held source capability. This file
    // cannot substitute for today's source verification or create provenance.
    const verified = join(runRoot, 'source-verified.sqlite');
    if (!exists(verified)) copy(verified);
    const source = inspectBase(verified, stage, budget);
    const proposed = { version: 1, runId: stage.runId, stageHash, candidateReference: stage.candidateReference,
      candidateBaseHash: stage.sourceEvidence.fileHash ?? stage.sourceEvidence.closedSourceFileHash,
      sourceSchemaVersion: stage.sourceEvidence.schemaVersion, sourceSchemaChecksum: stage.sourceEvidence.schemaChecksum,
      sourceWriteMode: source.writeMode, copyStartedAt: copyIntent?.copyStartedAt ?? stepTime(now, stage.createdAt) };
    if (copyIntent && hashRecoveryRecord('copyIntent', copyIntent) !== hashRecoveryRecord('copyIntent', proposed)) invalid();
    if (proposed.copyStartedAt < stage.createdAt) invalid();
    stepTime(now, proposed.copyStartedAt);
    copyIntent = putRecord(join(runRoot, 'copy-intent.json'), 'copyIntent', proposed, budget);
  } else if (base || copyIntent || ['source-verified.sqlite', 'normalization-intent.json', 'normalized.json', 'pause-intent.json', 'paused.json'].some(name => exists(join(runRoot, name)))) invalid();
  if (!exists(path)) {
    // Any incomplete copy is retained for reconciliation, never silently replaced.
    // Caller checks the bounded directory before entering here.
    if (base || ['normalization-intent.json', 'normalized.json', 'pause-intent.json', 'paused.json', 'staged.json'].some(name => exists(join(runRoot, name)))) invalid();
    if (nonfresh) copy(path);
    else {
      const pending = reserve(runRoot);
      try { fsyncSync(pending.fd); } finally { closeSync(pending.fd); }
      publishPending(pending.path, path, pending.identity);
    }
    if (!nonfresh) {
      let db;
      const before = protectedPath(path);
      try {
        db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE');
        initializeImSchemaV4(db, { policy, creationRef: stage.preparationRef, limits: p1limits }); budget.tick();
      } finally { db?.close(); }
      if (!same(before, protectedPath(path))) invalid(); resyncPublished(path, budget);
    }
  }
  if (nonfresh) {
    const expected = { version: 2, runId: stage.runId, stageHash, candidateReference: stage.candidateReference,
      copyIntentHash: hashRecoveryRecord('copyIntent', copyIntent), candidateBaseHash: copyIntent.candidateBaseHash,
      sourceSchemaVersion: copyIntent.sourceSchemaVersion, sourceSchemaChecksum: copyIntent.sourceSchemaChecksum,
      sourceWriteMode: copyIntent.sourceWriteMode, copyStartedAt: copyIntent.copyStartedAt };
    if (base && hashRecoveryRecord('base', base) !== hashRecoveryRecord('base', expected)) invalid();
    if (!base) {
      // Missing base can only recover an exact completed copy with its original
      // intent. Never recopy, invent a start time or adopt modified candidate bytes.
      inspectBase(path, stage, budget, copyIntent.sourceWriteMode);
      resyncPublished(path, budget);
    }
    base = putRecord(join(runRoot, 'base.json'), 'base', expected, budget);
    chain = { stage, copyIntent, base, ...normalizeCandidate({ path, runRoot, stage, copyIntent, base, budget, now }) };
  }
  if (stage.candidateKind === 'v3_import') {
    let intent = readRecord(join(runRoot, 'pause-intent.json'), 'pauseIntent', budget);
    let paused = readRecord(join(runRoot, 'paused.json'), 'paused', budget);
    const version = database(path, budget, false, db => db.prepare('SELECT version FROM im_schema').get().version);
    if (!paused) {
      if (version !== 3 || fileHash(path, budget) !== chain.normalized.normalizedCandidateHash) throw fail('RECOVERY_INDETERMINATE');
      // An earlier enabled pause intent could have committed without its proof.
      // Exact normalized bytes prove that it did not; only this case permits retry.
      const proposed = { version: 2, runId: stage.runId, stageHash, candidateBaseHash: base.candidateBaseHash,
        normalizedRecordHash: hashRecoveryRecord('normalized', chain.normalized), pauseInputHash: chain.normalized.normalizedCandidateHash,
        originalWriteMode: base.sourceWriteMode, targetWriteMode: 'paused', createdAt: intent?.createdAt ?? stepTime(now, chain.normalized.normalizedAt) };
      if (intent && hashRecoveryRecord('pauseIntent', intent) !== hashRecoveryRecord('pauseIntent', proposed)) invalid();
      if (proposed.createdAt < chain.normalized.normalizedAt) invalid();
      stepTime(now, proposed.createdAt);
      intent = putRecord(join(runRoot, 'pause-intent.json'), 'pauseIntent', proposed, budget);
      if (base.sourceWriteMode === 'enabled') database(path, budget, true, db => {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (db.prepare("UPDATE im_settings SET write_mode='paused' WHERE singleton=1 AND write_mode='enabled'").run().changes !== 1) invalid();
          budget.tick(); db.exec('COMMIT');
        } finally { if (db.isTransaction) db.exec('ROLLBACK'); }
      });
      else resyncPublished(path, budget);
      paused = putRecord(join(runRoot, 'paused.json'), 'paused', { version: 2, runId: stage.runId, stageHash,
        pauseIntentHash: hashRecoveryRecord('pauseIntent', intent), candidateBaseHash: base.candidateBaseHash,
        pauseInputHash: intent.pauseInputHash, pausedCandidateHash: fileHash(path, budget), changed: base.sourceWriteMode === 'enabled', pausedAt: stepTime(now, intent.createdAt) }, budget);
    }
    validateRecoveryPauseBindings({ ...chain, pauseIntent: intent, paused });
    putRecord(join(runRoot, 'pause-intent.json'), 'pauseIntent', intent, budget);
    putRecord(join(runRoot, 'paused.json'), 'paused', paused, budget);
    if (version === 3) {
      stepTime(now, paused.pausedAt);
      if (fileHash(path, budget) !== paused.pausedCandidateHash) invalid();
      database(path, budget, true, db => migrateImSchemaV4(db, { expectedVersion: 3, policy, migrationRef: stage.preparationRef, limits: p1limits }));
    } else if (version !== 4) invalid();
  }
  const actual = candidateFacts(path, stage, budget);
  if (stage.candidateKind === 'snapshot_recovery' && !actual.run && fileHash(path, budget) !== chain.normalized.normalizedCandidateHash) invalid();
  let staged = readRecord(join(runRoot, 'staged.json'), 'staged', budget);
  if (!staged) {
    if (actual.run || (stage.candidateKind !== 'snapshot_recovery' && (actual.center.center_epoch !== actual.preparation.initial_epoch || actual.center.recovery_run_id !== null || actual.center.status !== 'prepared' || actual.writeMode !== 'paused'))) invalid();
    staged = { version: 1, runId: stage.runId, stageHash, candidateBaseHash: base?.candidateBaseHash ?? null,
      preparationRef: stage.preparationRef, instanceId: actual.identity.instance_id, instanceCreatedAt: actual.identity.created_at,
      initialEpoch: actual.preparation?.initial_epoch ?? actual.center.center_epoch, importEpoch: actual.preparation?.import_epoch ?? null,
      stagedAt: stepTime(now, stage.candidateKind === 'v3_import' ? readRecord(join(runRoot, 'paused.json'), 'paused', budget).pausedAt : chain?.normalized.normalizedAt ?? stage.createdAt) };
  }
  assertStaged(stage, staged, actual, base);
  if (staged.stagedAt < (stage.candidateKind === 'v3_import' ? readRecord(join(runRoot, 'paused.json'), 'paused', budget).pausedAt : chain?.normalized.normalizedAt ?? stage.createdAt)) invalid();
  if (actual.run) {
    let plan, planHash;
    directoryEntries(runRoot, budget, name => {
      if (!name.startsWith('prepare-')) return;
      if (plan || !/^prepare-[0-9a-f]{64}\.json$/.test(name)) invalid();
      plan = readRecord(join(runRoot, name), 'preparePlan', budget); planHash = hashRecoveryRecord('preparePlan', plan);
      if (name !== `prepare-${planHash}.json`) invalid();
    });
    validateRecoveryPlanBindings(plan, { stage, staged, base,
      sourceClosedEvidence: readRecord(join(runRoot, 'source-closed.json'), 'closureProof', budget),
      previousRecoveryCounter: stage.candidateKind === 'snapshot_recovery' ? actual.center.recovery_counter - 1 : null });
    completed(plan, planHash, actual);
  }
  resyncPublished(path, budget);
  return putRecord(join(runRoot, 'staged.json'), 'staged', staged, budget);
}
export function completed(plan, planHash, actual, approvalRef) {
  const r = actual.run;
  if (!r) return null;
  const fields = { run_id: plan.runId, candidate_kind: plan.candidateKind, preparation_ref: plan.preparationRef,
    backup_id: plan.backupId, backup_file_hash: plan.backupFileHash, manifest_hash: plan.manifestHash,
    candidate_base_hash: plan.backupFileHash, candidate_reference: plan.candidateReference, old_epoch: plan.oldEpoch,
    new_epoch: plan.newEpoch, approved_plan_hash: planHash, isolation_ack_ref: plan.isolationAckRef,
    rpo_report_json: plan.rpoReport === null ? null : JSON.stringify(plan.rpoReport) };
  for (const [key, value] of Object.entries(fields)) if (r[key] !== value) invalid();
  if (approvalRef !== undefined && r.approval_ref !== approvalRef) invalid();
  if (actual.center.recovery_run_id !== plan.runId || actual.center.center_epoch !== plan.newEpoch ||
      actual.center.recovery_counter !== plan.recoveryCounter || !['prepared', 'verified', 'active', 'failed'].includes(r.status) ||
      (r.status === 'failed' ? actual.center.status !== 'prepared' : actual.center.status !== r.status) ||
      actual.writeMode !== 'paused') invalid();
  if (r.status === 'prepared' || r.status === 'verified') {
    if (r.failure_code !== null || r.auth_review_ref !== null || r.activation_plan_hash !== null ||
        r.activation_approval_ref !== null || r.activation_ref !== null || r.activated_at !== null ||
        actual.center.activation_ref !== null || (r.status === 'prepared' ? r.verified_at !== null :
          !Number.isSafeInteger(r.verified_at) || r.verified_at < r.created_at || actual.center.updated_at !== r.verified_at)) invalid();
  }
  return r.status;
}
// Caller holds source -> workspace -> candidate control. No file hashing occurs
// in the guard transaction; its independently durable clock anchor is retained.
export function transitionDatabase({ path, data, budget, clock, authorize, activationPlan = null, activationPlanHash = null, activationApprovalRef = null }) {
  const { stage, staged, base, plan, planHash } = data;
  const expected = activationPlan ? 'verified' : 'prepared';
  if (!same(data.candidateIdentity, standalone(path, budget))) invalid();
  return database(path, budget, true, db => {
    const guard = createImV2ClockGuard({ db, clock });
    const check = status => {
      const actual = facts(db, stage, budget);
      assertStaged(stage, staged, actual, base);
      if (completed(plan, planHash, actual, data.actual.run.approval_ref) !== status ||
          expected === 'verified' && actual.run.verified_at !== data.actual.run.verified_at) invalid();
      return actual;
    };
    return guard.runWriteFresh(() => {
      check(expected); authorize();
      const fresh = value => {
        if (activationPlan && value >= activationPlan.expiresAt) throw fail('RECOVERY_PLAN_STALE');
        if (value < (activationPlan?.createdAt ?? plan.createdAt)) invalid();
      };
      fresh(guard.current());
      const at = guard.current();
      if (activationPlan) {
        if (db.prepare("UPDATE im_recovery_runs SET status='active',auth_review_ref=?,activation_plan_hash=?,activation_approval_ref=?,activation_ref=?,activated_at=? WHERE run_id=? AND status='verified'")
          .run(activationPlan.authReviewRef, activationPlanHash, activationApprovalRef, activationPlan.activationRef, at, plan.runId).changes !== 1) invalid();
        if (db.prepare("UPDATE im_center_state SET status='active',activation_ref=?,updated_at=? WHERE singleton=1 AND recovery_run_id=? AND status='verified'")
          .run(activationPlan.activationRef, at, plan.runId).changes !== 1) invalid();
        db.prepare('INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json) VALUES (?,?,?,?,?,?)')
          .run('system', plan.runId, 'recovery.activate', JSON.stringify([plan.runId]), at, JSON.stringify({ activationPlanHash }));
      } else {
        if (db.prepare("UPDATE im_recovery_runs SET status='verified',verified_at=? WHERE run_id=? AND status='prepared'").run(at, plan.runId).changes !== 1) invalid();
        if (db.prepare("UPDATE im_center_state SET status='verified',updated_at=? WHERE singleton=1 AND recovery_run_id=? AND status='prepared'").run(at, plan.runId).changes !== 1) invalid();
      }
      authorize();
      const actual = check(activationPlan ? 'active' : 'verified');
      if (activationPlan && (actual.run.activation_plan_hash !== activationPlanHash || actual.run.activation_approval_ref !== activationApprovalRef ||
          actual.run.auth_review_ref !== activationPlan.authReviewRef || actual.run.activation_ref !== activationPlan.activationRef ||
          actual.run.activated_at !== at || actual.center.updated_at !== at || actual.run.verified_at !== data.actual.run.verified_at)) invalid();
      budget.tick(); fresh(guard.refreshCurrent());
      authorize(); check(activationPlan ? 'active' : 'verified');
      return actual;
    });
  });
}
export function prepareDatabase({ path, stage, staged, base, plan, planHash, approvalRef, budget, clock, authorize, fresh }) {
  return database(path, budget, true, db => {
    const guard = createImV2ClockGuard({ db, clock });
    return guard.runWriteFresh(() => {
      const actual = facts(db, stage, budget); assertStaged(stage, staged, actual, base);
      if (actual.run) invalid();
      if (actual.center.center_epoch !== (plan.oldEpoch ?? plan.newEpoch) ||
          actual.center.recovery_counter !== (plan.candidateKind === 'snapshot_recovery' ? plan.recoveryCounter - 1 : 0)) invalid();
      if (plan.candidateKind !== 'snapshot_recovery' && (actual.center.status !== 'prepared' || actual.center.recovery_run_id !== null || actual.writeMode !== 'paused')) invalid();
      fresh(guard.current()); authorize(); budget.tick();
      if (plan.candidateKind === 'snapshot_recovery') {
        db.prepare("INSERT INTO im_center_epochs VALUES (?,?,'recovery',?)").run(plan.newEpoch, guard.current(), plan.recoveryCounter);
        for (const state of db.prepare('SELECT agent_id,stream_epoch FROM im_receive_state').iterate()) {
          let prefix = 0;
          for (const delivery of db.prepare('SELECT seq,acked_at FROM im_deliveries WHERE recipient_id=? ORDER BY seq').iterate(state.agent_id)) {
            budget.tick(); if (delivery.seq !== prefix + 1 || delivery.acked_at === null) break; prefix = delivery.seq;
          }
          db.prepare('INSERT INTO im_sync_progress VALUES (?,?,?,?,?)').run(state.agent_id, plan.newEpoch, state.stream_epoch, prefix, guard.current()); budget.tick();
        }
      }
      const row = { run_id: plan.runId, candidate_kind: plan.candidateKind, preparation_ref: plan.preparationRef,
        backup_id: plan.backupId, backup_file_hash: plan.backupFileHash, manifest_hash: plan.manifestHash, candidate_base_hash: plan.backupFileHash,
        candidate_reference: plan.candidateReference, old_epoch: plan.oldEpoch, new_epoch: plan.newEpoch, approved_plan_hash: planHash,
        approval_ref: approvalRef, isolation_ack_ref: plan.isolationAckRef, rpo_report_json: plan.rpoReport === null ? null : JSON.stringify(plan.rpoReport),
        auth_review_ref: null, activation_plan_hash: null, activation_approval_ref: null, status: 'prepared', created_at: guard.current(),
        verified_at: null, activated_at: null, activation_ref: null, failure_code: null };
      db.prepare(`INSERT INTO im_recovery_runs (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
      db.prepare("UPDATE im_center_state SET center_epoch=?,recovery_counter=?,status='prepared',activation_ref=NULL,recovery_run_id=?,updated_at=? WHERE singleton=1")
        .run(plan.newEpoch, plan.recoveryCounter, plan.runId, guard.current());
      db.exec("UPDATE im_settings SET write_mode='paused' WHERE singleton=1; DELETE FROM im_receiver_leases");
      validateV4(db, budget); authorize(); budget.tick(); fresh(guard.refreshCurrent());
      return Object.freeze({ runId: plan.runId, candidateReference: plan.candidateReference, newEpoch: plan.newEpoch, status: 'prepared' });
    });
  });
}
