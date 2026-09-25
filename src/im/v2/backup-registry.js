import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { withClosedBackupSnapshot } from '../backup-snapshot.js';
import { withProtectedBackupCopy } from '../backup-registry.js';
import { getInstanceIdentity } from '../schema.js';
import { projectCandidateBudget } from './schema-internal.js';
import { createImV2Backup, validationLimits, verifyV4 } from './backup.js';
import { authorize, canonical, decode, deepFreeze, directoryEntries, exists, fail, fileHash, hash, invalid, operationBudget, privateDirectory,
  protectedPath, publishBytes, publishPending, readBytes, reserve, same, sha, shape, storage,
  ref, rejectThenable, resyncPublished, streamFile, time, uuid, writeAll } from './recovery-records.js';

function oldRecord(bytes) {
  // Preserve historical bytes, but reapply its exact recordVersion=2 shape on
  // every reopen. This parser grants no provenance; only the genuine bridge can.
  const value = JSON.parse(bytes.toString('utf8'));
  shape(value, ['recordVersion', 'instanceId', 'instanceCreatedAt', 'registrationGeneration', 'backupId', 'fileHash',
    'schemaVersion', 'schemaChecksum', 'completedAt', 'executorActorId', 'backupApprovalId', 'backupApproverId',
    'toolVersion', 'artifactReference', 'manifestHash', 'publicationState', 'registeredAt']);
  if (value.recordVersion !== 2 || value.registrationGeneration !== 1 || value.schemaVersion !== 3 || value.publicationState !== 'published' ||
      ![value.instanceId, value.backupId].every(uuid) || ![value.instanceCreatedAt, value.completedAt, value.registeredAt].every(time) ||
      ![value.fileHash, value.manifestHash, value.schemaChecksum].every(hash) ||
      ![value.executorActorId, value.backupApprovalId, value.backupApproverId, value.toolVersion, value.artifactReference].every(ref)) invalid();
  return value;
}

function verifyV3(path, manifestPath, expected, budget) {
  const before = protectedPath(path);
  budget.file(before.size);
  if (exists(`${path}-wal`) || exists(`${path}-shm`) || exists(`${path}-journal`)) invalid();
  const manifestBytes = readBytes(manifestPath, budget);
  if (fileHash(path, budget) !== expected.fileHash || sha(manifestBytes) !== expected.manifestHash) invalid();
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  for (const key of ['backupId', 'fileHash', 'schemaVersion', 'schemaChecksum', 'completedAt'])
    if (manifest[key] !== expected[key]) invalid();
  if (manifest.sourceId !== expected.instanceId || manifest.schemaVersion !== 3 ||
      ![manifest.backupId, manifest.sourceId, manifest.approvalId, manifest.toolVersion].every(ref) ||
      !time(manifest.completedAt) || !hash(manifest.fileHash) ||
      ['integrityCheck', 'foreignKeyCheck', 'schemaCheck', 'hashCheck'].some(key => manifest.verification?.[key] !== true)) invalid();
  budget.tick();
  try {
    withClosedBackupSnapshot(path, db => {
      budget.tick();
      projectCandidateBudget(db, budget, 3);
      for (const row of db.prepare('PRAGMA integrity_check').iterate()) { budget.tick(); if (row.integrity_check !== 'ok') invalid(); }
      budget.tick();
      for (const row of db.prepare('PRAGMA foreign_key_check').iterate()) { budget.tick(); invalid(); }
      budget.tick();
      const identity = getInstanceIdentity(db);
      if (identity.instanceId !== expected.instanceId || identity.createdAt !== expected.instanceCreatedAt) invalid();
      const marker = db.prepare('SELECT version,migration_checksum FROM im_schema').get();
      if (marker.version !== 3 || marker.migration_checksum !== expected.schemaChecksum) invalid();
      budget.tick();
    });
  } catch (e) {
    if (e?.code === 'IM_V2_BUDGET_EXCEEDED') throw fail('RECOVERY_BUSY');
    throw e;
  }
  budget.tick();
  if (!same(before, protectedPath(path)) || fileHash(path, budget) !== expected.fileHash ||
      exists(`${path}-wal`) || exists(`${path}-shm`) || exists(`${path}-journal`)) invalid();
}

function build({ root, authority, clock = Date.now, limits } = {}) {
  const store = storage(root), bounds = validationLimits(limits);
  if (typeof clock !== 'function') invalid();
  const now = () => { const value = clock(); if (!time(value)) invalid(); return value; };
  const leaf = (dir, id, suffix = '.json') => {
    if (!uuid(id)) invalid();
    const parent = join(store.root, 'registry', dir); privateDirectory(parent);
    return join(parent, `${id}${suffix}`);
  };
  const read = (dir, id, kind, suffix, budget) => decode(kind, readBytes(leaf(dir, id, suffix), budget));
  const write = (dir, id, kind, data, suffix, budget) => publishBytes(leaf(dir, id, suffix), canonical(kind, data), budget);
  function verifyLocked(backupId, budget, cache) {
    if (cache?.has(backupId)) return cache.get(backupId);
    const record = read('records', backupId, 'record', undefined, budget);
    if (record.backupId !== backupId) invalid();
    const evidenceBytes = readBytes(leaf('records', backupId, '.source.json'), budget);
    const sourceEvidence = decode('source', evidenceBytes);
    if (sha(evidenceBytes) !== record.sourceEvidenceHash) invalid();
    for (const key of ['backupId', 'instanceId', 'instanceCreatedAt', 'schemaVersion', 'schemaChecksum', 'fileHash', 'manifestHash', 'completedAt'])
      if (record[key] !== sourceEvidence[key]) invalid();
    const path = leaf('artifacts', backupId, '.sqlite'), manifestPath = leaf('artifacts', backupId, '.manifest.json');
    const manifestBytes = readBytes(manifestPath, budget);
    if (sha(manifestBytes) !== record.manifestHash) invalid();
    if (record.publicationKind === 'native-v4') {
      if (sourceEvidence.registryFormat !== 3 || exists(leaf('records', backupId, '.import.json'))) invalid();
      const { manifest } = verifyV4(path, manifestBytes, bounds, budget);
      if (manifest.backupId !== backupId || manifest.sourceId !== record.instanceId || manifest.sourceCreatedAt !== record.instanceCreatedAt ||
          manifest.fileHash !== record.fileHash || manifest.schemaChecksum !== record.schemaChecksum || manifest.completedAt !== record.completedAt) invalid();
    } else {
      if (sourceEvidence.registryFormat !== 2) invalid();
      const originalBytes = readBytes(leaf('records', backupId, '.import.json'), budget);
      if (sha(originalBytes) !== sourceEvidence.importedRecordHash) invalid();
      const original = oldRecord(originalBytes);
      for (const key of ['backupId', 'instanceId', 'instanceCreatedAt', 'schemaVersion', 'schemaChecksum', 'fileHash', 'manifestHash', 'completedAt'])
        if (original[key] !== record[key]) invalid();
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      if (manifest.approvalId !== original.backupApprovalId || manifest.toolVersion !== original.toolVersion) invalid();
      verifyV3(path, manifestPath, record, budget);
    }
    budget.tick();
    const verified = deepFreeze({ record, sourceEvidence });
    cache?.set(backupId, verified);
    return verified;
  }
  // The sole writer is captured by genuine native publication and authenticated
  // legacy bridge below. Neither facade nor callback receives it.
  function commitLocked(manifest, publicationKind, originalBytes, budget) {
    const backupId = manifest.backupId;
    const imported = publicationKind === 'imported-registered-v3';
    const original = imported ? oldRecord(originalBytes) : null;
    const manifestBytes = readBytes(leaf('artifacts', backupId, '.manifest.json'), budget);
    const sourceEvidence = { version: 1, kind: 'registered-backup', sourceRef: `backup:${backupId}`,
      registryFormat: imported ? 2 : 3, instanceId: manifest.sourceId,
      instanceCreatedAt: imported ? original.instanceCreatedAt : manifest.sourceCreatedAt,
      backupId, fileHash: manifest.fileHash, manifestHash: sha(manifestBytes), schemaVersion: manifest.schemaVersion,
      schemaChecksum: manifest.schemaChecksum, completedAt: manifest.completedAt,
      importedRecordHash: imported ? sha(originalBytes) : null };
    const sourceBytes = canonical('source', sourceEvidence);
    const record = { recordVersion: 3, backupId, instanceId: sourceEvidence.instanceId, instanceCreatedAt: sourceEvidence.instanceCreatedAt,
      schemaVersion: manifest.schemaVersion, schemaChecksum: manifest.schemaChecksum, fileHash: manifest.fileHash,
      manifestHash: sourceEvidence.manifestHash, completedAt: manifest.completedAt,
      artifactReference: `registry/artifacts/${backupId}.sqlite`, publicationKind, sourceEvidenceHash: sha(sourceBytes), registeredAt: now() };
    if (imported) publishBytes(leaf('records', backupId, '.import.json'), originalBytes, budget);
    publishBytes(leaf('records', backupId, '.source.json'), sourceBytes, budget);
    write('records', backupId, 'record', record, undefined, budget);
    return verifyLocked(backupId, budget);
  }
  function verify({ backupId } = {}, context) {
    authorize(authority, context); const budget = operationBudget(bounds);
    return store.withLock(() => verifyLocked(backupId, budget));
  }
  function withVerifiedBackup({ backupId } = {}, context, callback) {
    authorize(authority, context);
    if (typeof callback !== 'function' || Object.prototype.toString.call(callback) === '[object AsyncFunction]') invalid();
    const budget = operationBudget(bounds);
    let sinkFailure;
    const callbackFailure = fail('RECOVERY_CALLBACK_FAILED');
    try { return store.withLock(() => {
      const verified = verifyLocked(backupId, budget), expectedHash = verified.record.fileHash;
      let active = true;
      try {
        const result = callback(Object.freeze({ ...verified, copyTo(writeChunk) {
          if (!active) throw fail('RECOVERY_INVALID');
          if (typeof writeChunk !== 'function' || Object.prototype.toString.call(writeChunk) === '[object AsyncFunction]') invalid();
          streamFile(leaf('artifacts', backupId, '.sqlite'), chunk => {
            let result;
            try { result = writeChunk(Buffer.from(chunk)); }
            catch (error) { sinkFailure = { error }; throw error; }
            try { rejectThenable(result); } catch (e) { active = false; throw e; }
          }, budget);
          if (fileHash(leaf('artifacts', backupId, '.sqlite'), budget) !== expectedHash) invalid();
        } }));
        rejectThenable(result);
        verifyLocked(backupId, budget);
        return result;
      } catch (error) {
        // The caller already owns its sink exception. Carry only our private
        // sentinel through storage sanitization, then restore it after unlock.
        if (sinkFailure && Object.is(error, sinkFailure.error)) throw callbackFailure;
        throw error;
      } finally { active = false; }
    }); } catch (error) {
      if (error === callbackFailure) throw sinkFailure.error;
      throw error;
    }
  }
  function holdLocked(holdId, budget, cache) {
    const hold = read('holds', holdId, 'hold', undefined, budget);
    if (hold.holdId !== holdId) invalid();
    verifyLocked(hold.backupId, budget, cache);
    let binding = null;
    if (exists(leaf('holds', holdId, '.binding.json'))) {
      binding = read('holds', holdId, 'binding', '.binding.json', budget);
      if (binding.holdId !== holdId || binding.stageHash !== hold.stageHash || binding.boundAt < hold.createdAt) invalid();
    }
    // P5-C owns terminal proof verification. No marker is authoritative in A.
    if (exists(leaf('releases', holdId))) invalid();
    return { hold, binding, release: null };
  }
  function scanHolds(budget, cache) {
    const ids = new Set(); let malformed = false;
    directoryEntries(join(store.root, 'registry', 'holds'), budget, name => {
      const match = /^([0-9a-f-]{36})(\.binding)?\.json$/.exec(name);
      if (!match || !uuid(match[1])) malformed = true;
      else ids.add(match[1]);
    });
    directoryEntries(join(store.root, 'registry', 'releases'), budget, () => { malformed = true; });
    if (malformed) invalid();
    const holds = [];
    for (const id of ids) { budget.tick(); holds.push(holdLocked(id, budget, cache)); }
    return holds;
  }
  function createStageHold(input, context) {
    authorize(authority, context); shape(input, ['backupId', 'recoveryRunId', 'stageHash']);
    if (!uuid(input.backupId) || !uuid(input.recoveryRunId) || !hash(input.stageHash)) invalid();
    const budget = operationBudget(bounds);
    return store.withLock(() => {
      const cache = new Map();
      verifyLocked(input.backupId, budget, cache);
      const matches = scanHolds(budget, cache).filter(({ hold }) => hold.recoveryRunId === input.recoveryRunId);
      if (matches.length > 1) invalid();
      if (matches.length) {
        const { hold } = matches[0];
        if (hold.backupId !== input.backupId || hold.stageHash !== input.stageHash) invalid();
        resyncPublished(leaf('holds', hold.holdId), budget);
        return hold;
      }
      const hold = { version: 1, holdId: randomUUID(), backupId: input.backupId,
        recoveryRunId: input.recoveryRunId, stageHash: input.stageHash, createdAt: now() };
      write('holds', hold.holdId, 'hold', hold, undefined, budget); return hold;
    });
  }
  function bindPrepareHold(input, context) {
    authorize(authority, context); shape(input, ['holdId', 'preparePlanHash']);
    if (!uuid(input.holdId) || !hash(input.preparePlanHash)) invalid();
    const budget = operationBudget(bounds);
    return store.withLock(() => {
      const { hold, binding } = holdLocked(input.holdId, budget);
      if (binding) {
        if (binding.preparePlanHash !== input.preparePlanHash) invalid();
        resyncPublished(leaf('holds', hold.holdId, '.binding.json'), budget); return binding;
      }
      const value = { version: 1, holdId: hold.holdId, stageHash: hold.stageHash, preparePlanHash: input.preparePlanHash, boundAt: now() };
      if (value.boundAt < hold.createdAt) invalid();
      write('holds', hold.holdId, 'binding', value, '.binding.json', budget); return value;
    });
  }
  function getHold({ holdId } = {}, context) {
    authorize(authority, context); const budget = operationBudget(bounds);
    return store.withLock(() => holdLocked(holdId, budget));
  }
  function checkCleanup({ backupId } = {}, context) {
    authorize(authority, context);
    const budget = operationBudget(bounds);
    return store.withLock(() => {
      const cache = new Map(); verifyLocked(backupId, budget, cache);
      const held = scanHolds(budget, cache).some(({ hold }) => hold.backupId === backupId);
      budget.tick();
      return { allowed: false, reason: held ? 'HOLD' : 'DISABLED' };
    });
  }
  const registry = Object.freeze({ verify, withVerifiedBackup, createStageHold, bindPrepareHold, getHold, checkCleanup });
  return { registry, store, leaf, bounds, commitLocked };
}

export function createImV2BackupRegistry(options) { return build(options).registry; }

export function createTrustedImV2BackupServices(options = {}) {
  const { registry, store, leaf, bounds, commitLocked } = build(options);
  const backup = createImV2Backup(options);
  async function publish(input, context) {
    const budget = operationBudget(bounds);
    const result = await backup.publish(input, context, budget);
    return store.withLock(() => {
      const actual = verifyV4(leaf('artifacts', result.manifest.backupId, '.sqlite'),
        readBytes(leaf('artifacts', result.manifest.backupId, '.manifest.json'), budget), bounds, budget);
      if (actual.manifestHash !== result.manifestHash) invalid();
      return commitLocked(actual.manifest, 'native-v4', undefined, budget);
    });
  }
  function importRegisteredV3(input, context) {
    authorize(options.authority, context); shape(input, ['sourceRegistry', 'backupId']);
    if (!uuid(input.backupId)) invalid();
    const budget = operationBudget(bounds);
    // Old source lock is acquired before any new registry lock.
    try { return withProtectedBackupCopy(input.sourceRegistry, { backupId: input.backupId, adminContext: context,
      limits: { maxFileBytes: bounds.maxFileBytes, maxElapsedMs: bounds.maxElapsedMs }, tick: () => budget.tick() }, proof =>
      store.withLock(() => {
        const originalBytes = Buffer.from(proof.recordBytes), manifestBytes = Buffer.from(proof.manifestBytes);
        if (originalBytes.length > 65536 || manifestBytes.length > 65536) invalid();
        const original = oldRecord(originalBytes);
        const manifest = JSON.parse(manifestBytes.toString('utf8'));
        if (original.backupId !== input.backupId || original.schemaVersion !== 3 || original.recordVersion !== 2 ||
            sha(manifestBytes) !== original.manifestHash) invalid();
        const target = leaf('artifacts', input.backupId, '.sqlite');
        if (exists(target) || exists(leaf('records', input.backupId))) invalid();
        const pending = reserve(join(store.root, 'registry', 'artifacts'));
        try { proof.copyTo(chunk => { budget.tick(); writeAll(pending.fd, chunk); budget.tick(); }); fsyncSync(pending.fd); budget.tick(); }
        catch (e) { throw e?.code?.startsWith('REGISTRY_') || e?.code?.startsWith('RECOVERY_') ? e : fail('RECOVERY_DURABILITY_UNCERTAIN'); }
        finally { closeSync(pending.fd); }
        if (fileHash(pending.path, budget) !== original.fileHash) invalid();
        publishPending(pending.path, target, pending.identity);
        const manifestPath = leaf('artifacts', input.backupId, '.manifest.json');
        publishBytes(manifestPath, manifestBytes, budget);
        verifyV3(target, manifestPath, original, budget);
        return commitLocked(manifest, 'imported-registered-v3', originalBytes, budget);
      }));
    } catch (error) {
      if (error?.code?.startsWith('RECOVERY_')) throw error;
      if (error?.code === 'REGISTRY_BUSY') throw fail('RECOVERY_BUSY');
      if (error?.code === 'REGISTRY_AUTH_DENIED') throw fail('RECOVERY_AUTH_DENIED');
      // Legacy I/O errors may carry source paths. No raw error crosses the v2 seam.
      throw fail('RECOVERY_EVIDENCE_MISMATCH');
    }
  }
  return Object.freeze({ publisher: Object.freeze({ publish, importRegisteredV3, status: backup.status, drain: backup.drain }), registry });
}
