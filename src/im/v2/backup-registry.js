import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { types as utilTypes } from 'node:util';
import { withClosedBackupSnapshot } from '../backup-snapshot.js';
import { withProtectedBackupCopy } from '../backup-registry.js';
import { getInstanceIdentity } from '../schema.js';
import { projectCandidateBudget } from './schema-internal.js';
import { createImV2Backup, validationLimits, verifyV4 } from './backup.js';
import { authorize, canonical, decode, deepFreeze, directoryEntries, exists, fail, fileHash, hash, invalid, operationBudget, privateDirectory,
  protectedPath, publishBytes, publishPending, readBytes, reserve, same, sha, shape, storage,
  ref, rejectThenable, resyncPublished, streamFile, time, uuid, writeAll } from './recovery-records.js';

const trustedRegistries = new WeakMap();
const synchronous = fn => typeof fn === 'function' && !['[object AsyncFunction]', '[object AsyncGeneratorFunction]', '[object GeneratorFunction]'].includes(Object.prototype.toString.call(fn));
function adminGate(authority, context) {
  try {
    const fn=authority?.authorizeAdmin;
    if (!synchronous(fn)) throw null;
    const result=fn.call(authority,context); rejectThenable(result);
    if (result===true) return;
  } catch { /* fixed local denial, including falsy throws */ }
  throw fail('RECOVERY_AUTH_DENIED');
}
function approvalGate(authority, operation, context) {
  try {
    const fn=authority?.authorizeApproval;
    if (!synchronous(fn)) throw null;
    const result=fn.call(authority,Object.freeze({kind:'release-hold',planHash:operation.releasePlanHash,approvalRef:operation.approvalRef}),context);
    rejectThenable(result); if (result===true) return;
  } catch { /* no raw adapter errors */ }
  throw fail('RECOVERY_APPROVAL_DENIED');
}
function holdInput(input, keys) {
  try {
    shape(input,keys);
    const value=Object.fromEntries(keys.map(k=>[k,input[k]]));
    for (const key of keys) if (!(key==='releasePlanHash'?hash:key==='approvalRef'?ref:uuid)(value[key])) throw null;
    return Object.freeze(value);
  } catch { throw fail('RECOVERY_INVALID'); }
}

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
    return verifiedScope(backupId, budget, callback);
  }
  function verifiedScope(backupId, budget, callback, prepare = undefined) {
    let active = true;
    let callerFailure;
    const callerSentinel = fail('RECOVERY_CALLBACK_FAILED');
    try { return store.withLock(() => {
    const verified = verifyLocked(backupId, budget), expectedHash = verified.record.fileHash;
    const { hold, binding } = prepare ? prepare(budget) : {};
    const copyTo = writeChunk => {
      if (!active) throw fail('RECOVERY_INVALID');
      if (typeof writeChunk !== 'function' || Object.prototype.toString.call(writeChunk) === '[object AsyncFunction]') invalid();
      streamFile(leaf('artifacts', backupId, '.sqlite'), chunk => {
        let result;
        try { result = writeChunk(Buffer.from(chunk)); }
        catch (error) { callerFailure = { error }; throw error; }
        try { rejectThenable(result); } catch (e) { active = false; throw e; }
      }, budget);
      if (fileHash(leaf('artifacts', backupId, '.sqlite'), budget) !== expectedHash) invalid();
    };
      const proof = Object.freeze({ ...verified, ...(hold === undefined ? {} : { hold, binding }), copyTo });
      let result;
      try { result = callback(proof); }
      catch (error) { if (error !== callerSentinel) callerFailure = { error }; throw callerSentinel; }
      rejectThenable(result);
      callerFailure = undefined;
      verifyLocked(backupId, budget);
      return result;
    }); } catch (error) {
      if (callerFailure && (error === callerSentinel || error?.code === 'RECOVERY_EVIDENCE_MISMATCH')) throw callerFailure.error;
      throw error;
    } finally { active = false; }
  }
  function holdLocked(holdId, budget, cache, allowRelease = false) {
    const hold = read('holds', holdId, 'hold', undefined, budget);
    if (hold.holdId !== holdId) invalid();
    verifyLocked(hold.backupId, budget, cache);
    let binding = null;
    if (exists(leaf('holds', holdId, '.binding.json'))) {
      binding = read('holds', holdId, 'binding', '.binding.json', budget);
      if (binding.holdId !== holdId || binding.stageHash !== hold.stageHash || binding.boundAt < hold.createdAt) invalid();
    }
    let release = null;
    if (exists(leaf('releases', holdId))) {
      if (!allowRelease) invalid(); // Preserve B's old read/source behavior.
      release=read('releases',holdId,'release',undefined,budget);
      // Historical failed markers have no approved C verifier. Fail closed.
      if (!binding||release.holdId!==holdId||release.recoveryRunId!==hold.recoveryRunId||
          release.terminalState!=='active'||release.releasedAt<binding.boundAt) invalid();
    }
    return { hold, binding, release };
  }
  function scanHolds(budget, cache, allowRelease = false) {
    const ids = new Set(); let malformed = false;
    directoryEntries(join(store.root, 'registry', 'holds'), budget, name => {
      const match = /^([0-9a-f-]{36})(\.binding)?\.json$/.exec(name);
      if (!match || !uuid(match[1])) malformed = true;
      else ids.add(match[1]);
    });
    directoryEntries(join(store.root, 'registry', 'releases'), budget, name => {
      const match=/^([0-9a-f-]{36})\.json$/.exec(name);
      if (!allowRelease||!match||!uuid(match[1])||!ids.has(match[1])) malformed=true;
    });
    if (malformed) invalid();
    const holds = [];
    for (const id of ids) { budget.tick(); holds.push(holdLocked(id, budget, cache, allowRelease)); }
    return holds;
  }
  function createStageHold(input, context) {
    authorize(authority, context); shape(input, ['backupId', 'recoveryRunId', 'stageHash']);
    if (!uuid(input.backupId) || !uuid(input.recoveryRunId) || !hash(input.stageHash)) invalid();
    const budget = operationBudget(bounds);
    return store.withLock(() => createStageHoldLocked(input, budget));
  }
  function createStageHoldLocked(input, budget) {
    const cache = new Map();
    verifyLocked(input.backupId, budget, cache);
    const matches = scanHolds(budget, cache).filter(({ hold }) => hold.recoveryRunId === input.recoveryRunId);
    if (matches.length > 1) invalid();
    if (matches.length) {
      const { hold } = matches[0];
      if (hold.backupId !== input.backupId || hold.stageHash !== input.stageHash) invalid();
      resyncPublished(leaf('holds', hold.holdId), budget);
      return deepFreeze(hold);
    }
    const hold = { version: 1, holdId: randomUUID(), backupId: input.backupId,
      recoveryRunId: input.recoveryRunId, stageHash: input.stageHash, createdAt: now() };
    write('holds', hold.holdId, 'hold', hold, undefined, budget); return deepFreeze(hold);
  }
  function bindPrepareHold(input, context) {
    authorize(authority, context); shape(input, ['holdId', 'preparePlanHash']);
    if (!uuid(input.holdId) || !hash(input.preparePlanHash)) invalid();
    const budget = operationBudget(bounds);
    return store.withLock(() => bindPrepareHoldLocked(input, budget));
  }
  function bindPrepareHoldLocked(input, budget) {
    const { hold, binding } = holdLocked(input.holdId, budget);
    if (binding) {
      if (binding.preparePlanHash !== input.preparePlanHash) invalid();
      resyncPublished(leaf('holds', hold.holdId, '.binding.json'), budget); return deepFreeze(binding);
    }
    const value = { version: 1, holdId: hold.holdId, stageHash: hold.stageHash, preparePlanHash: input.preparePlanHash, boundAt: now() };
    if (value.boundAt < hold.createdAt) invalid();
    write('holds', hold.holdId, 'binding', value, '.binding.json', budget); return deepFreeze(value);
  }
  function withRecoverySourceLocked(input, context, callback) {
    authorize(authority, context);
    shape(input, ['backupId', 'recoveryRunId', 'stageHash', 'preparePlanHash']);
    if (!uuid(input.backupId) || !uuid(input.recoveryRunId) || !hash(input.stageHash) ||
        (input.preparePlanHash !== null && !hash(input.preparePlanHash)) ||
        typeof callback !== 'function' || Object.prototype.toString.call(callback) === '[object AsyncFunction]') invalid();
    const budget = operationBudget(bounds);
    return verifiedScope(input.backupId, budget, callback, () => {
      const hold = createStageHoldLocked(input, budget);
      const binding = input.preparePlanHash === null ? null : bindPrepareHoldLocked({ holdId: hold.holdId, preparePlanHash: input.preparePlanHash }, budget);
      return { hold, binding };
    });
  }
  function withRecoverySourceIntentLocked(input, context, callback) {
    authorize(authority, context);
    shape(input, ['backupId']);
    if (!uuid(input.backupId) || typeof callback !== 'function' ||
        Object.prototype.toString.call(callback) === '[object AsyncFunction]') invalid();
    const backupId = input.backupId, budget = operationBudget(bounds);
    let state = 'open-unestablished', established, identity, latched, sinkFailure;
    const callbackSentinel = fail('RECOVERY_CALLBACK_FAILED');
    const latch = error => { latched ??= { error }; state = 'poisoned'; };
    const trustedFailure = error => error?.code?.startsWith('RECOVERY_') ? error : fail('RECOVERY_EVIDENCE_MISMATCH');
    const copyTo = (expectedHash, writeChunk) => {
      if (state !== 'established') throw fail('RECOVERY_INVALID');
      if (typeof writeChunk !== 'function' || Object.prototype.toString.call(writeChunk) === '[object AsyncFunction]') invalid();
      streamFile(leaf('artifacts', backupId, '.sqlite'), chunk => {
        let result;
        try { result = writeChunk(Buffer.from(chunk)); }
        catch (error) { sinkFailure = { error }; throw callbackSentinel; }
        try { rejectThenable(result); } catch (error) { latch(error); throw error; }
      }, budget);
      if (fileHash(leaf('artifacts', backupId, '.sqlite'), budget) !== expectedHash) invalid();
    };
    try {
      return store.withLock(() => {
        const verified = verifyLocked(backupId, budget);
        const establish = value => {
          if (state === 'expired' || state === 'poisoned') throw fail('RECOVERY_INVALID');
          if (state === 'establishing') {
            const error = fail('RECOVERY_EVIDENCE_MISMATCH'); latch(error); throw error;
          }
          try {
            shape(value, ['recoveryRunId', 'stageHash', 'preparePlanHash']);
            if (!uuid(value.recoveryRunId) || !hash(value.stageHash) ||
                (value.preparePlanHash !== null && !hash(value.preparePlanHash))) invalid();
            // Snapshot before any callback-controlled clock or filesystem work.
            const requested = { recoveryRunId: value.recoveryRunId, stageHash: value.stageHash,
              preparePlanHash: value.preparePlanHash };
            if (state === 'established') {
              if (Object.keys(requested).some(key => requested[key] !== identity[key])) invalid();
              return established;
            }
            state = 'establishing';
            const hold = createStageHoldLocked({ backupId, recoveryRunId: requested.recoveryRunId, stageHash: requested.stageHash }, budget);
            const binding = requested.preparePlanHash === null ? null :
              bindPrepareHoldLocked({ holdId: hold.holdId, preparePlanHash: requested.preparePlanHash }, budget);
            if (latched) throw latched.error;
            const proof = Object.freeze({ ...verified, hold, binding, copyTo: chunk => copyTo(verified.record.fileHash, chunk) });
            identity = requested; established = proof; state = 'established';
            return proof;
          } catch (error) {
            const safe = trustedFailure(error);
            latch(safe); throw latched.error;
          }
        };
        let result;
        try { result = callback(Object.freeze({ ...verified, establish })); }
        catch (error) { if (!latched) latched = { error: sinkFailure && error === callbackSentinel ? sinkFailure.error : error }; throw callbackSentinel; }
        try { rejectThenable(result); }
        catch (error) { latch(error); throw error; }
        if (latched) throw callbackSentinel;
        verifyLocked(backupId, budget);
        if (latched) throw callbackSentinel;
        return result;
      });
    } catch (error) {
      if (latched && error === callbackSentinel) throw latched.error;
      if (sinkFailure && error?.code === 'RECOVERY_EVIDENCE_MISMATCH') throw sinkFailure.error;
      throw error;
    } finally { state = 'expired'; }
  }
  function getHold({ holdId } = {}, context) {
    authorize(authority, context); const budget = operationBudget(bounds);
    return store.withLock(() => holdLocked(holdId, budget));
  }
  function heldLocked(input,budget) {
    const cache=new Map(), verified=verifyLocked(input.backupId,budget,cache);
    const held=holdLocked(input.holdId,budget,cache,true);
    if (held.hold.backupId!==input.backupId) invalid();
    return deepFreeze({...verified,...held});
  }
  function withRecoveryHoldLocked(input,context,callback) {
    const operation=holdInput(input,['backupId','holdId']);
    if (!synchronous(callback)) throw fail('RECOVERY_INVALID');
    adminGate(authority,context);
    const budget=operationBudget(bounds), sentinel=fail('RECOVERY_CALLBACK_FAILED');
    let callbackFailure;
    try { return store.withLock(()=>{
      const proof=heldLocked(operation,budget);
      let result;
      try { result=callback(proof); } catch (error) { callbackFailure={error}; throw sentinel; }
      rejectThenable(result);
      verifyLocked(operation.backupId,budget);
      return result;
    }); } catch (error) {
      if (error===sentinel&&callbackFailure) throw callbackFailure.error;
      throw error;
    }
  }
  function releaseRecoveryHoldLocked(operation,context,releaseAuthority,approvalAuthority,verifyTerminal) {
    adminGate(authority,context); adminGate(releaseAuthority,context);
    approvalGate(approvalAuthority,operation,context);
    const budget=operationBudget(bounds);
    let state='open', fault, receipt, publishedHash, marker;
    const poison=error=>{
      if (fault) return fault.error;
      // Latch before inspecting a thrown value: even descriptor/proxy traps may
      // throw or reenter. Sanitization can never leave this scope unpoisoned.
      fault={error:fail('RECOVERY_EVIDENCE_MISMATCH')};
      try {
        if (utilTypes.isProxy(error)) return fault.error;
        const code=Object.getOwnPropertyDescriptor(error,'code')?.value;
        switch (code) {
          case 'RECOVERY_INVALID':
          case 'RECOVERY_EVIDENCE_MISMATCH':
          case 'RECOVERY_AUTH_DENIED':
          case 'RECOVERY_APPROVAL_DENIED':
          case 'RECOVERY_BUSY':
          case 'RECOVERY_UNSUPPORTED':
          case 'RECOVERY_DURABILITY_UNCERTAIN':
          case 'RECOVERY_CALLBACK_FAILED':
            fault.error=fail(code);
        }
      } catch { /* Retain the fixed failure; never propagate hostile errors. */ }
      return fault.error;
    };
    try { return store.withLock(()=>{
      const proof=heldLocked(operation,budget);
      if (!proof.binding||proof.hold.recoveryRunId!==operation.runId) invalid();
      const publish=value=>{
        if (state==='expired'||fault) throw fail('RECOVERY_INVALID');
        if (state==='publishing') throw poison(fail('RECOVERY_EVIDENCE_MISMATCH'));
        state='publishing';
        try {
          rejectThenable(value);
          shape(value,['stateEvidenceHash']);
          const requested=value.stateEvidenceHash;
          if (!hash(requested)) invalid();
          if (receipt) { if (requested!==publishedHash) invalid(); state='published'; return receipt; }
          const previous=proof.release;
          if (previous&&(previous.stateEvidenceHash!==requested||previous.approvalRef!==operation.approvalRef)) invalid();
          if (!synchronous(clock)) throw fail('RECOVERY_INVALID');
          let releasedAt;
          if (previous) releasedAt=previous.releasedAt;
          else { releasedAt=clock(); rejectThenable(releasedAt); if (!time(releasedAt)||releasedAt<proof.binding.boundAt) invalid(); }
          marker=deepFreeze({version:1,holdId:proof.hold.holdId,recoveryRunId:proof.hold.recoveryRunId,
            terminalState:'active',stateEvidenceHash:requested,approvalRef:operation.approvalRef,releasedAt});
          // Recheck source and all gates immediately before publication, while C
          // still owns its workspace/candidate controls inside verifyTerminal.
          verifyLocked(operation.backupId,budget);
          adminGate(authority,context); adminGate(releaseAuthority,context);
          approvalGate(approvalAuthority,operation,context);
          if (fault) throw fault.error;
          write('releases',proof.hold.holdId,'release',marker,undefined,budget);
          if (fault) throw fault.error;
          publishedHash=requested; receipt=Object.freeze(Object.create(null)); state='published';
          return receipt;
        } catch (error) { throw poison(error); }
      };
      let result;
      try { result=verifyTerminal(proof,operation,context,publish); rejectThenable(result); }
      catch { throw poison(fail('RECOVERY_CALLBACK_FAILED')); }
      if (fault||!receipt||result!==receipt) throw poison(fail('RECOVERY_EVIDENCE_MISMATCH'));
      verifyLocked(operation.backupId,budget);
      if (fault) throw fault.error;
      return Object.freeze({releaseMarker:marker});
    }); } finally { state='expired'; }
  }
  function checkCleanup({ backupId } = {}, context) {
    authorize(authority, context);
    const budget = operationBudget(bounds);
    return store.withLock(() => {
      const cache = new Map(); verifyLocked(backupId, budget, cache);
      const held = scanHolds(budget, cache, true).some(({ hold }) => hold.backupId === backupId);
      budget.tick();
      return { allowed: false, reason: held ? 'HOLD' : 'DISABLED' };
    });
  }
  const registry = Object.freeze({ verify, withVerifiedBackup, createStageHold, bindPrepareHold, getHold, checkCleanup });
  trustedRegistries.set(registry, Object.freeze({ withRecoverySourceLocked, withRecoverySourceIntentLocked, withRecoveryHoldLocked, releaseRecoveryHoldLocked }));
  return { registry, store, leaf, bounds, commitLocked };
}

export function createImV2BackupRegistry(options) { return build(options).registry; }

export function withRecoverySource(registry, input, context, callback) {
  if (!trustedRegistries.has(registry)) invalid();
  return trustedRegistries.get(registry).withRecoverySourceLocked(input, context, callback);
}

export function withRecoverySourceIntent(registry, input, context, callback) {
  if (!trustedRegistries.has(registry)) invalid();
  return trustedRegistries.get(registry).withRecoverySourceIntentLocked(input, context, callback);
}

export function withRecoveryHold(registry,input,context,callback) {
  if (!trustedRegistries.has(registry)) invalid();
  return trustedRegistries.get(registry).withRecoveryHoldLocked(input,context,callback);
}

// Trusted local composition, not a network/facade API or a defense against
// malicious same-process JavaScript importing this capability.
export function createRecoveryHoldReleaser({registry,authority,approvalAuthority,verifyTerminal}={}) {
  if (!trustedRegistries.has(registry)) invalid();
  if (!synchronous(verifyTerminal)) throw fail('RECOVERY_INVALID');
  const trusted=trustedRegistries.get(registry);
  return Object.freeze({release(input,context) {
    const operation=holdInput(input,['backupId','runId','holdId','releasePlanHash','approvalRef']);
    return trusted.releaseRecoveryHoldLocked(operation,context,authority,approvalAuthority,verifyTerminal);
  }});
}

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
