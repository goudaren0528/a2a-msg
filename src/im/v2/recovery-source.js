// Trusted construction and synchronous source scopes; no operation accepts a path.
import { dirname, resolve } from 'node:path';
import { withClosedBackupSnapshot } from '../backup-snapshot.js';
import { assertFrozenV3Structure, V3_CHECKSUM } from './schema-history.js';
import { projectCandidateBudget } from './schema-internal.js';
import { withRecoveryHold, withRecoverySource, withRecoverySourceIntent } from './backup-registry.js';
import { decodeRecoveryRecord, encodeRecoveryRecord } from './recovery-plan.js';
import { deepFreeze, exists, fail, fileHash, invalid, privateDirectory, protectedPath,
  ref, rejectThenable, same, shape, streamFile, uuid } from './recovery-records.js';

const closed = new WeakMap();
function rejectNative5(proof) {
  const { record, sourceEvidence } = proof;
  if (record.recordVersion === 4 && record.publicationKind === 'native-v5' && record.schemaVersion === 5 &&
      sourceEvidence.version === 2 && sourceEvidence.registryFormat === 4 && sourceEvidence.schemaVersion === 5 &&
      record.backupId === sourceEvidence.backupId) throw fail('RECOVERY_UNSUPPORTED');
}
export const recordCopy = (kind, value) => decodeRecoveryRecord(kind, encodeRecoveryRecord(kind, value));
export function adapter(owner, name, args, code, literal = true) {
  try {
    const fn = owner?.[name];
    if (typeof fn !== 'function' || Object.prototype.toString.call(fn) === '[object AsyncFunction]' ||
        Object.prototype.toString.call(fn) === '[object AsyncGeneratorFunction]') throw fail(code);
    const result = Reflect.apply(fn, owner, args);
    rejectThenable(result);
    if (literal && result !== true) throw fail(code);
    return result;
  } catch { throw fail(code); }
}
export function createClosedV3Source(input) {
  shape(input, ['path', 'sourceRef', 'evidenceAuthority']);
  if (typeof input.path !== 'string' || !input.path || input.path.includes('\0') || /^file:/i.test(input.path) || !ref(input.sourceRef)) invalid();
  const path = resolve(input.path);
  privateDirectory(dirname(path)); protectedPath(path);
  const capability = Object.freeze({});
  closed.set(capability, Object.freeze({ path, sourceRef: input.sourceRef, evidenceAuthority: input.evidenceAuthority }));
  return capability;
}
function noSidecars(path) {
  if (['-wal', '-shm', '-journal'].some(s => exists(path + s))) invalid();
}
function inspectClosed(path, budget) {
  privateDirectory(dirname(path)); const inode = protectedPath(path);
  noSidecars(path); const digest = fileHash(path, budget);
  const data = withClosedBackupSnapshot(path, db => {
    projectCandidateBudget(db, budget, 3); assertFrozenV3Structure(db, budget);
    for (const row of db.prepare('PRAGMA integrity_check').iterate()) { budget.tick(); if (row.integrity_check !== 'ok') invalid(); }
    for (const row of db.prepare('PRAGMA foreign_key_check').iterate()) { budget.tick(); invalid(); }
    const identity = db.prepare('SELECT instance_id,created_at FROM im_instance_identity WHERE singleton=1').get();
    const marker = db.prepare('SELECT version,migration_checksum FROM im_schema').get();
    if (marker.version !== 3 || marker.migration_checksum !== V3_CHECKSUM) invalid();
    return { instanceId: identity.instance_id, instanceCreatedAt: identity.created_at };
  });
  if (!same(inode, protectedPath(path)) || digest !== fileHash(path, budget)) invalid();
  noSidecars(path); return { ...data, fileHash: digest, inode };
}
export function closureBinding(stageInput, evidence) {
  if (!evidence) return null;
  const registered = evidence.kind === 'registered-backup';
  return recordCopy('closureBinding', { sourceRef: stageInput.sourceRef, isolationAckRef: stageInput.isolationAckRef,
    sourceKind: registered ? 'registered-backup' : 'closed-source', instanceId: evidence.instanceId,
    instanceCreatedAt: evidence.instanceCreatedAt, schemaVersion: evidence.schemaVersion, schemaChecksum: evidence.schemaChecksum,
    fileHash: registered ? evidence.fileHash : evidence.closedSourceFileHash,
    backupId: registered ? evidence.backupId : null, manifestHash: registered ? evidence.manifestHash : null });
}
export function closureProof(authority, binding, context, original) {
  if (!binding) { if (original != null) invalid(); return null; }
  const proof = recordCopy('closureProof', original ?? adapter(authority, 'getSourceClosedEvidence', [binding, context], 'RECOVERY_EVIDENCE_MISMATCH', false));
  for (const key of Object.keys(binding)) if (proof[key] !== binding[key]) invalid();
  adapter(authority, 'authorizeSourceClosedEvidence', [proof, context], 'RECOVERY_EVIDENCE_MISMATCH');
  return proof;
}
export function sourceTable(catalog, evidenceAuthority, now, createReleaser) {
  if (!catalog || Object.getPrototypeOf(catalog) !== Object.prototype) invalid();
  const entries = new Map();
  for (const key of Reflect.ownKeys(catalog)) {
    if (!ref(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(catalog, key), 'value')) invalid();
    const value = catalog[key];
    if (value?.kind === 'registered-backup') {
      shape(value, ['kind', 'registry', 'backupId']); if (!uuid(value.backupId)) invalid();
      entries.set(key, Object.freeze({ ...value }));
    } else {
      shape(value, ['kind', 'source']); const actual = closed.get(value.source);
      if (value.kind !== 'closed-v3' || !actual || actual.sourceRef !== key) invalid();
      entries.set(key, Object.freeze({ ...value }));
    }
  }
  const releasers = new Map();
  if (createReleaser) for (const entry of entries.values()) {
    if (entry.kind !== 'registered-backup' || releasers.has(entry.registry)) continue;
    const refs = Object.freeze([...entries].filter(([, value]) => value.registry === entry.registry).map(([key]) => key));
    releasers.set(entry.registry, createReleaser(entry.registry, refs));
  }
  function release(stage, operation, ctx) {
    const entry = entries.get(stage.sourceRef);
    if (entry?.kind !== 'registered-backup' || stage.sourceEvidence?.backupId !== entry.backupId) invalid();
    return releasers.get(entry.registry)({ backupId: entry.backupId, ...operation }, ctx);
  }
  function isolation(input, ctx) {
    if (input.candidateKind === 'fresh_bootstrap') return;
    adapter(evidenceAuthority, 'assertSourceIsolation', [input.sourceRef, input.isolationAckRef, ctx], 'RECOVERY_EVIDENCE_MISMATCH');
    const entry = entries.get(input.sourceRef);
    if (entry?.kind === 'closed-v3') adapter(closed.get(entry.source).evidenceAuthority, 'assertSourceIsolation',
      [input.sourceRef, input.isolationAckRef, ctx], 'RECOVERY_EVIDENCE_MISMATCH');
  }
  function withSource(input, ctx, budget, mode, identity, consume) {
    if (input.candidateKind === 'fresh_bootstrap') return consume({ sourceEvidence: null, sourceBinding: null });
    const entry = entries.get(input.sourceRef); if (!entry) invalid(); isolation(input, ctx);
    if (entry.kind === 'registered-backup') {
      const inspect = proof => {
        rejectNative5(proof);
        const e = recordCopy('registeredSourceEvidence', proof.sourceEvidence);
        if (e.backupId !== entry.backupId || e.schemaVersion !== (input.candidateKind === 'snapshot_recovery' ? 4 : 3)) invalid();
        if (mode === 'held' && (JSON.stringify(proof.hold) !== JSON.stringify(identity.receipt) ||
            proof.hold.recoveryRunId !== input.runId)) invalid();
        budget.tick(); const result = consume({ ...proof, sourceEvidence: e, sourceBinding: closureBinding(input, e) });
        isolation(input, ctx); budget.tick(); return result;
      };
      // Even a read-only scope first authenticates the registry through A's private
      // WeakMap. Target4 admission rejects native5 before its durability resync
      // and before old codec consumption or automatic hold/binding publication.
      if (mode === 'prepare') return withRecoverySource(entry.registry, { backupId: entry.backupId,
        recoveryRunId: identity.recoveryRunId, stageHash: identity.stageHash, preparePlanHash: identity.preparePlanHash }, ctx, inspect, budget, rejectNative5);
      if (mode === 'held') {
        if (!identity.receipt || identity.receipt.backupId !== entry.backupId) invalid();
        return withRecoveryHold(entry.registry, { backupId: entry.backupId, holdId: identity.receipt.holdId }, ctx, inspect, budget, rejectNative5);
      }
      if (mode === 'read') {
        withRecoverySourceIntent(entry.registry, { backupId: entry.backupId }, ctx, rejectNative5, budget, rejectNative5);
        return entry.registry.withVerifiedBackup({ backupId: entry.backupId }, ctx, inspect, budget, rejectNative5);
      }
      return withRecoverySourceIntent(entry.registry, { backupId: entry.backupId }, ctx, inspect, budget, rejectNative5);
    }
    if (input.candidateKind !== 'v3_import') invalid();
    const source = closed.get(entry.source), before = inspectClosed(source.path, budget);
    const original = identity?.sourceEvidence;
    const evidence = recordCopy('closedSourceEvidence', { version: 1, kind: 'closed-source', sourceRef: input.sourceRef,
      instanceId: before.instanceId, instanceCreatedAt: before.instanceCreatedAt, schemaVersion: 3, schemaChecksum: V3_CHECKSUM,
      closedSourceFileHash: before.fileHash, observedAt: original?.observedAt ?? now(), isolationAckRef: input.isolationAckRef });
    let live = true;
    try {
      const result = consume(Object.freeze({ sourceEvidence: evidence, sourceBinding: closureBinding(input, evidence), copyTo(sink) {
        if (!live || typeof sink !== 'function' || Object.prototype.toString.call(sink) === '[object AsyncFunction]') invalid();
        streamFile(source.path, chunk => rejectThenable(sink(Buffer.from(chunk))), budget);
      } }));
      rejectThenable(result); return result;
    } finally {
      live = false; isolation(input, ctx);
      const after = inspectClosed(source.path, budget);
      if (!same(before.inode, after.inode) || before.fileHash !== after.fileHash) invalid();
    }
  }
  function getHold(input, receipt, ctx) {
    const entry = entries.get(input.sourceRef);
    if (entry?.kind !== 'registered-backup') { if (receipt !== null) invalid(); return null; }
    if (!receipt || receipt.backupId !== entry.backupId) invalid();
    withRecoverySourceIntent(entry.registry, { backupId: entry.backupId }, ctx, rejectNative5, undefined, rejectNative5);
    const actual = entry.registry.getHold({ holdId: receipt.holdId }, ctx);
    if (JSON.stringify(actual.hold) !== JSON.stringify(receipt) || actual.release !== null) invalid();
    return deepFreeze(actual);
  }
  return Object.freeze({ withSource, isolation, getHold, release });
}
