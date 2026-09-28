import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { V3_CHECKSUM } from './schema-history.js';
import { V4_CHECKSUM } from './schema-internal.js';
import { V5_CHECKSUM } from './schema-v5-internal.js';
import { encodeImV5BackupRecord, decodeImV5BackupRecord, hashImV5BackupRecord } from './backup-v5-records.js';
import { encodeRecoveryRecord, decodeRecoveryRecord, hashRecoveryRecord } from './recovery-plan.js';
import { canonical as canonicalRegistryRecord } from './recovery-records.js';
import { encodeRecoveryConversionRecord, decodeRecoveryConversionRecord, hashRecoveryConversionRecord } from './recovery-conversion-records.js';
import { encodeMaintenanceV5Record, decodeMaintenanceV5Record, hashMaintenanceV5Record } from './maintenance-v5-records.js';

// C2-A content-only records. These bindings establish DTO consistency, not file,
// registry, ownership, clock or approval authority. Historical preimages stay in
// their original codecs; only these four records use the recovery-v5 domain.
const MAX_BYTES = 65536;
const rejected = Symbol('rejected recovery-v5 record');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;

function ensure(condition) { if (!condition) throw rejected; }
function boundary(code, operation) {
  try { return operation(); }
  catch {
    // Never classify, reflect on or expose the thrown value, including errors
    // from historical helpers. Each public rejection is a fresh fixed error.
    throw Object.assign(new Error(code), { code });
  }
}

const checked = test => value => { ensure(test(value)); return value; };
const literal = expected => checked(value => value === expected);
const nullable = check => value => value === null ? null : check(value);
const uuid = checked(value => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value));
const hash = checked(value => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value));
const number = checked(value => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0);
// P5/C1 references count UTF-16 units, including lone surrogates. Maintenance
// records additionally enforce their original well-formed-string rule below.
const ref = checked(value => typeof value === 'string' && value.length >= 1 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value));
const candidateKind = checked(value => value === 'fresh_bootstrap' || value === 'v3_import' || value === 'snapshot_recovery');
const mode = checked(value => value === 'paused' || value === 'enabled');
const boolean = checked(value => typeof value === 'boolean');
const one = literal(1);
const sourceVersion = nullable(checked(value => value === 3 || value === 4));
const historicalVersion = checked(value => value === 3 || value === 4);

function ordinary(value) {
  ensure(value !== null && typeof value === 'object' && !types.isProxy(value));
  ensure(Object.getPrototypeOf(value) === Object.prototype);
}

function dataProperty(value, field) {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  ensure(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
  return descriptor.value;
}

function tag(value, field) {
  ordinary(value);
  return dataProperty(value, field);
}

function snapshot(value, rules) {
  ordinary(value);
  const fields = Object.keys(rules);
  const keys = Reflect.ownKeys(value);
  ensure(keys.length === fields.length && keys.every(key => typeof key === 'string' && Object.hasOwn(rules, key)));
  const copy = {};
  for (const field of fields) copy[field] = rules[field](dataProperty(value, field));
  return copy;
}

// Exact ordered historical schemas form a recursive own-data firewall. No old
// codec sees caller objects, even when its own inspection is less restrictive.
const SOURCE_FIELDS = {
  version: one, kind: literal('registered-backup'), sourceRef: ref,
  registryFormat: checked(value => value === 2 || value === 3),
  instanceId: uuid, instanceCreatedAt: number, backupId: uuid, fileHash: hash,
  manifestHash: hash, schemaVersion: historicalVersion, schemaChecksum: hash,
  completedAt: number, importedRecordHash: nullable(hash),
};
const CLOSED_FIELDS = {
  version: one, kind: literal('closed-source'), sourceRef: ref, instanceId: uuid,
  instanceCreatedAt: number, schemaVersion: literal(3), schemaChecksum: hash,
  closedSourceFileHash: hash, observedAt: number, isolationAckRef: ref,
};
const NATIVE_SOURCE_FIELDS = {
  ...SOURCE_FIELDS, version: literal(2), registryFormat: literal(4),
  schemaVersion: literal(5), schemaChecksum: literal(V5_CHECKSUM), importedRecordHash: literal(null),
};
function sourceKind(value) {
  const kind = tag(value, 'kind');
  ensure(kind === 'registered-backup' || kind === 'closed-source');
  return kind === 'registered-backup' ? 'registeredSourceEvidence' : 'closedSourceEvidence';
}
function sourceSnapshot(value) {
  return snapshot(value, sourceKind(value) === 'registeredSourceEvidence' ? SOURCE_FIELDS : CLOSED_FIELDS);
}
const STAGE_FIELDS = {
  version: one, requestRef: ref, requestHash: hash, runId: uuid, candidateKind,
  sourceRef: nullable(ref), sourceEvidence: nullable(sourceSnapshot),
  sourceClosedEvidenceRef: nullable(ref), sourceClosedEvidenceHash: nullable(hash),
  isolationAckRef: nullable(ref), policyHash: hash, candidateReference: ref,
  preparationRef: nullable(ref), createdAt: number,
};
const STAGED_FIELDS = {
  version: one, runId: uuid, stageHash: hash, candidateBaseHash: nullable(hash),
  preparationRef: nullable(ref), instanceId: uuid, instanceCreatedAt: number,
  initialEpoch: uuid, importEpoch: nullable(uuid), stagedAt: number,
};
const OWNER_FIELDS = {
  version: one, runId: uuid, stageHash: hash, stagedHash: hash, candidateReference: ref,
  instanceId: uuid, instanceCreatedAt: number, centerEpoch: uuid, candidateKind,
  preparationRef: nullable(ref), sourceEvidenceHash: nullable(hash), holdId: nullable(uuid),
  intakeFileHash: hash, intakeWriteMode: mode, claimedAt: number,
};
const PAUSE_INTENT_FIELDS = {
  version: one, ownerHash: hash, inputFileHash: hash, originalWriteMode: mode,
  targetWriteMode: literal('paused'), createdAt: number,
};
const PAUSED_FIELDS = {
  version: one, ownerHash: hash, pauseIntentHash: hash, inputFileHash: hash,
  pausedFileHash: hash, changed: boolean, pausedAt: number,
};
const PLAN_FIELDS = {
  version: one, transitionId: uuid, instanceId: uuid, instanceCreatedAt: number,
  centerEpoch: uuid, recoveryRunId: uuid, stageHash: hash, candidateReference: ref,
  candidateKind, preparationRef: nullable(ref), sourceEvidenceHash: nullable(hash),
  fromVersion: literal(4), fromChecksum: hash, toVersion: literal(5), toChecksum: hash,
  preconversionFileHash: hash, executionPolicyHash: hash, createdAt: number, expiresAt: number,
};
const PROOF_FIELDS = {
  version: one, plan: value => snapshot(value, PLAN_FIELDS), planHash: hash,
  approvalRef: ref, executorId: ref, approverId: ref, convertedAt: number,
};
const COMPLETION_FIELDS = {
  version: one, transitionId: uuid, planHash: hash, conversionProofHash: hash,
  instanceId: uuid, instanceCreatedAt: number, centerEpoch: uuid, recoveryRunId: uuid,
  stageHash: hash, candidateReference: ref, schemaVersion: literal(5), schemaChecksum: hash,
  preconversionFileHash: hash, postconversionFileHash: hash,
};
const HOLD_FIELDS = {
  version: one, holdId: uuid, backupId: uuid, recoveryRunId: uuid, stageHash: hash, createdAt: number,
};

function historical(kind, value, rules) {
  const copy = snapshot(value, rules);
  return decodeRecoveryRecord(kind, encodeRecoveryRecord(kind, copy));
}
function conversion(kind, value, rules) {
  const copy = snapshot(value, rules);
  return decodeRecoveryConversionRecord(kind, encodeRecoveryConversionRecord(kind, copy));
}
function maintenance(kind, value, rules) {
  const copy = snapshot(value, rules);
  return decodeMaintenanceV5Record(kind, encodeMaintenanceV5Record(kind, copy));
}
function historicalSource(value) {
  const kind = sourceKind(value);
  return historical(kind, value, kind === 'registeredSourceEvidence' ? SOURCE_FIELDS : CLOSED_FIELDS);
}
function nativeSource(value) {
  const copy = snapshot(value, NATIVE_SOURCE_FIELDS);
  return decodeImV5BackupRecord('source', encodeImV5BackupRecord('source', copy));
}
function hold(value) {
  const copy = snapshot(value, HOLD_FIELDS);
  return Object.freeze(JSON.parse(canonicalRegistryRecord('hold', copy).toString('utf8')));
}

const FIELDS = {
  archiveIntent: {
    version: one, runId: uuid, legacyStageHash: hash, legacyStagedHash: hash,
    candidateReference: ref, candidateKind, preparationRef: nullable(ref),
    sourceSchemaVersion: sourceVersion, sourceSchemaChecksum: nullable(hash), sourceEvidenceHash: nullable(hash),
    instanceId: uuid, instanceCreatedAt: number, centerEpoch: uuid, executionPolicyHash: hash,
    holdId: nullable(uuid), ownerHash: hash, pauseIntentHash: hash, pausedHash: hash,
    conversionPlanHash: hash, conversionProofHash: hash, conversionCompletionHash: hash,
    conversionPosthash: hash, archiveReference: ref, createdAt: number,
  },
  conversionHandoff: {
    version: one, runId: uuid, archiveIntentHash: hash, legacyStageHash: hash, legacyStagedHash: hash,
    candidateReference: ref, instanceId: uuid, instanceCreatedAt: number, centerEpoch: uuid,
    sourceSchemaVersion: sourceVersion, sourceSchemaChecksum: nullable(hash),
    targetSchemaVersion: literal(5), targetSchemaChecksum: literal(V5_CHECKSUM),
    ownerHash: hash, pauseIntentHash: hash, pausedHash: hash, conversionPlanHash: hash,
    conversionProofHash: hash, conversionCompletionHash: hash, conversionPosthash: hash,
    archiveReference: ref, archiveFileHash: hash, liveInitialHash: hash, handedOffAt: number,
  },
  nativeIntake: {
    version: one, route: literal('native-v5'), runId: uuid, candidateReference: ref, sourceRef: ref,
    sourceEvidence: nativeSource, sourceEvidenceHash: hash, instanceId: uuid, instanceCreatedAt: number,
    sourceSchemaVersion: literal(5), sourceSchemaChecksum: literal(V5_CHECKSUM),
    targetSchemaVersion: literal(5), targetSchemaChecksum: literal(V5_CHECKSUM),
    candidateInitialHash: hash, initialEpoch: uuid, previousRecoveryCounter: number,
    executionPolicyHash: hash, holdId: uuid, acceptedAt: number,
  },
  convertedIntake: {
    version: one, route: literal('converted-v4'), runId: uuid, candidateReference: ref,
    handoffHash: hash, archiveIntentHash: hash, candidateKind, preparationRef: nullable(ref),
    sourceSchemaVersion: sourceVersion, sourceSchemaChecksum: nullable(hash), sourceEvidenceHash: nullable(hash),
    instanceId: uuid, instanceCreatedAt: number, targetSchemaVersion: literal(5), targetSchemaChecksum: literal(V5_CHECKSUM),
    candidateInitialHash: hash, initialEpoch: uuid, previousRecoveryCounter: number,
    executionPolicyHash: hash, holdId: nullable(uuid), acceptedAt: number,
  },
};

function kindFields(kind) {
  ensure(typeof kind === 'string' && Object.hasOwn(FIELDS, kind));
  return FIELDS[kind];
}
function originalSchema(record) {
  const expected = record.sourceSchemaVersion === null ? null : record.sourceSchemaVersion === 3 ? V3_CHECKSUM : V4_CHECKSUM;
  ensure(record.sourceSchemaChecksum === expected);
}
function convertedRoute(record) {
  originalSchema(record);
  if (record.candidateKind === 'fresh_bootstrap') {
    ensure(record.preparationRef !== null && record.sourceSchemaVersion === null && record.sourceEvidenceHash === null && record.holdId === null);
  } else if (record.candidateKind === 'v3_import') {
    ensure(record.preparationRef !== null && record.sourceSchemaVersion === 3 && record.sourceEvidenceHash !== null);
  } else {
    ensure(record.preparationRef === null && record.sourceSchemaVersion === 4 && record.sourceEvidenceHash !== null && record.holdId !== null);
  }
}

function canonical(kind, value) {
  const record = snapshot(value, kindFields(kind));
  const namespace = kind === 'nativeIntake' ? 'v5-runs' : 'runs';
  ensure(record.candidateReference === `${namespace}/${record.runId}/candidate.sqlite`);
  if (kind === 'archiveIntent' || kind === 'convertedIntake') convertedRoute(record);
  if (kind === 'archiveIntent' || kind === 'conversionHandoff') {
    ensure(record.archiveReference === `runs/${record.runId}/conversion-archive.sqlite`);
  }
  if (kind === 'conversionHandoff') {
    originalSchema(record);
    agree(record.archiveFileHash, record.liveInitialHash, record.conversionPosthash);
  } else if (kind === 'nativeIntake') {
    const source = record.sourceEvidence;
    equalFields(record, source, ['sourceRef','instanceId','instanceCreatedAt']);
    ensure(record.candidateInitialHash === source.fileHash);
    ensure(record.sourceEvidenceHash === hashImV5BackupRecord('source', source));
  } else if (kind === 'convertedIntake' && record.candidateKind !== 'snapshot_recovery') {
    ensure(record.previousRecoveryCounter === 0);
  }
  return Object.freeze(record);
}

function serialize(record) {
  const text = JSON.stringify(record);
  const length = Buffer.byteLength(text, 'utf8');
  ensure(length <= MAX_BYTES);
  const bytes = Buffer.alloc(length);
  bytes.write(text, 'utf8');
  return bytes;
}
function digest(kind, record) {
  return createHash('sha256').update(`a2a-msg.im.v2/recovery-v5/${kind}\n`, 'utf8').update(serialize(record)).digest('hex');
}
function ownedBytes(value) {
  ensure(value !== null && typeof value === 'object' && !types.isProxy(value));
  ensure(types.isUint8Array(value));
  const prototype = Object.getPrototypeOf(value);
  ensure(prototype === Buffer.prototype || prototype === Uint8Array.prototype);
  const length = byteLengthGetter.call(value);
  ensure(length > 0 && length <= MAX_BYTES);
  const backing = bufferGetter.call(value);
  ensure(!types.isSharedArrayBuffer(backing) && Object.getPrototypeOf(backing) === ArrayBuffer.prototype);
  const keys = Reflect.ownKeys(value);
  ensure(keys.length === length && keys.every((key, index) => key === String(index)));
  const copy = Buffer.alloc(length);
  Uint8Array.prototype.set.call(copy, value);
  return copy;
}
function agree(...values) { ensure(values.every(value => value === values[0])); }
function equalFields(left, right, fields) {
  for (const field of fields) ensure(left[field] === right[field]);
}
function sameCanonical(left, right) { ensure(serialize(left).equals(serialize(right))); }

const ARCHIVE_FIELDS = {
  archiveIntent: value => canonical('archiveIntent', value),
  handoff: value => canonical('conversionHandoff', value),
  legacyStage: value => historical('stage', value, STAGE_FIELDS),
  legacyStaged: value => historical('staged', value, STAGED_FIELDS),
  owner: value => conversion('owner', value, OWNER_FIELDS),
  pauseIntent: value => conversion('pauseIntent', value, PAUSE_INTENT_FIELDS),
  paused: value => conversion('paused', value, PAUSED_FIELDS),
  conversionPlan: value => maintenance('conversionPlan', value, PLAN_FIELDS),
  conversionProof: value => maintenance('conversionProof', value, PROOF_FIELDS),
  conversionCompletion: value => maintenance('conversionComplete', value, COMPLETION_FIELDS),
  hold: nullable(hold),
};

function archiveBindings(value) {
  const bundle = snapshot(value, ARCHIVE_FIELDS);
  const { archiveIntent: a, handoff: h, legacyStage: s, legacyStaged: t, owner: o,
    pauseIntent: i, paused: p, conversionPlan: l, conversionProof: f,
    conversionCompletion: c, hold: d } = bundle;
  const e = s.sourceEvidence;
  const stageHash = hashRecoveryRecord('stage', s);
  const stagedHash = hashRecoveryRecord('staged', t);
  const evidenceHash = e === null ? null : hashRecoveryRecord(sourceKind(e), e);

  agree(a.runId, h.runId, s.runId, t.runId, o.runId, l.recoveryRunId, c.recoveryRunId);
  agree(stageHash, a.legacyStageHash, h.legacyStageHash, o.stageHash, t.stageHash, l.stageHash, c.stageHash);
  agree(stagedHash, a.legacyStagedHash, h.legacyStagedHash, o.stagedHash);
  for (const record of [h, s, o, l, c]) equalFields(a, record, ['candidateReference']);
  for (const record of [h, t, o, l, c]) equalFields(a, record, ['instanceId','instanceCreatedAt']);
  agree(a.centerEpoch, h.centerEpoch, o.centerEpoch, l.centerEpoch, c.centerEpoch, t.initialEpoch);
  agree(a.candidateKind, s.candidateKind, o.candidateKind, l.candidateKind);
  agree(a.preparationRef, s.preparationRef, t.preparationRef, o.preparationRef, l.preparationRef);
  equalFields(a, h, ['sourceSchemaVersion','sourceSchemaChecksum']);
  agree(a.sourceEvidenceHash, o.sourceEvidenceHash, l.sourceEvidenceHash, evidenceHash);
  agree(a.executionPolicyHash, l.executionPolicyHash, s.policyHash);

  if (e === null) {
    ensure(a.candidateKind === 'fresh_bootstrap' && a.sourceSchemaVersion === null && a.sourceSchemaChecksum === null);
    ensure(t.candidateBaseHash === null && t.importEpoch === null);
  } else {
    equalFields(a, e, ['instanceId','instanceCreatedAt']);
    ensure(a.sourceSchemaVersion === e.schemaVersion && a.sourceSchemaChecksum === e.schemaChecksum);
    ensure(t.candidateBaseHash === (e.kind === 'registered-backup' ? e.fileHash : e.closedSourceFileHash));
    if (a.candidateKind === 'v3_import') ensure(e.schemaVersion === 3 && t.importEpoch !== null && t.importEpoch !== t.initialEpoch);
    else ensure(a.candidateKind === 'snapshot_recovery' && e.kind === 'registered-backup' && e.schemaVersion === 4 && t.importEpoch === null);
    ensure(o.claimedAt >= (e.kind === 'registered-backup' ? e.completedAt : e.observedAt));
  }
  if (e !== null && e.kind === 'registered-backup') {
    ensure(d !== null);
    agree(a.holdId, o.holdId, d.holdId);
    ensure(d.backupId === e.backupId && d.recoveryRunId === a.runId && d.stageHash === stageHash);
    ensure(o.claimedAt >= d.createdAt);
  } else {
    ensure(a.holdId === null && o.holdId === null && d === null);
  }

  agree(a.ownerHash, h.ownerHash, i.ownerHash, p.ownerHash, hashRecoveryConversionRecord('owner', o));
  agree(i.inputFileHash, p.inputFileHash, o.intakeFileHash);
  ensure(i.originalWriteMode === o.intakeWriteMode && i.targetWriteMode === 'paused');
  agree(a.pauseIntentHash, h.pauseIntentHash, p.pauseIntentHash, hashRecoveryConversionRecord('pauseIntent', i));
  agree(a.pausedHash, h.pausedHash, hashRecoveryConversionRecord('paused', p));
  ensure(p.changed === (o.intakeWriteMode === 'enabled'));
  // Stronger binding rule than the historical standalone paused codec.
  ensure(p.changed ? p.pausedFileHash !== o.intakeFileHash : p.pausedFileHash === o.intakeFileHash);
  if (a.candidateKind !== 'snapshot_recovery') ensure(o.intakeWriteMode === 'paused');

  ensure(l.fromVersion === 4 && l.fromChecksum === V4_CHECKSUM && l.toVersion === 5 && l.toChecksum === V5_CHECKSUM);
  ensure(l.preconversionFileHash === p.pausedFileHash);
  sameCanonical(f.plan, l);
  agree(a.conversionPlanHash, h.conversionPlanHash, f.planHash, c.planHash, hashMaintenanceV5Record('conversionPlan', l));
  agree(a.conversionProofHash, h.conversionProofHash, c.conversionProofHash, hashMaintenanceV5Record('conversionProof', f));
  ensure(c.transitionId === l.transitionId && c.schemaVersion === l.toVersion && c.schemaChecksum === l.toChecksum);
  ensure(c.preconversionFileHash === l.preconversionFileHash);
  agree(a.conversionCompletionHash, h.conversionCompletionHash, hashMaintenanceV5Record('conversionComplete', c));
  agree(a.conversionPosthash, h.conversionPosthash, c.postconversionFileHash, h.archiveFileHash, h.liveInitialHash);
  ensure(a.archiveReference === h.archiveReference && h.archiveIntentHash === digest('archiveIntent', a));

  ensure(t.stagedAt >= s.createdAt && o.claimedAt >= t.stagedAt && o.claimedAt >= t.instanceCreatedAt);
  ensure(i.createdAt >= o.claimedAt && p.pausedAt >= i.createdAt);
  ensure(l.createdAt >= p.pausedAt && l.createdAt >= l.instanceCreatedAt);
  ensure(h.handedOffAt >= a.createdAt && a.createdAt >= f.convertedAt);
  return bundle;
}

const ACTUAL_FIELDS = {
  instanceId: uuid, instanceCreatedAt: number, schemaVersion: literal(5), schemaChecksum: literal(V5_CHECKSUM),
  centerEpoch: uuid, recoveryCounter: number, fileHash: hash, writeMode: mode,
};

function intakeBindings(value) {
  // Validate the exact bundle envelope before dispatch; selected branches then
  // snapshot every nested object through their specific schema, never fallback.
  const bundle = snapshot(value, {
    intake: input => input, sourceEvidence: input => input,
    archiveEvidence: input => input, actual: input => input,
  });
  const route = tag(bundle.intake, 'route');
  ensure(route === 'native-v5' || route === 'converted-v4');
  let intake;
  if (route === 'native-v5') {
    intake = canonical('nativeIntake', bundle.intake);
    ensure(bundle.archiveEvidence === null);
    const source = nativeSource(bundle.sourceEvidence);
    sameCanonical(source, intake.sourceEvidence);
    ensure(intake.sourceEvidenceHash === hashImV5BackupRecord('source', source));
  } else {
    // The entire archive is validated before trusting any of its handoff links.
    const archive = archiveBindings(bundle.archiveEvidence);
    const { archiveIntent: a, handoff: h, legacyStage: s } = archive;
    intake = canonical('convertedIntake', bundle.intake);
    ensure(intake.handoffHash === digest('conversionHandoff', h));
    agree(intake.archiveIntentHash, h.archiveIntentHash, digest('archiveIntent', a));
    for (const record of [a, h]) equalFields(intake, record, [
      'runId','candidateReference','instanceId','instanceCreatedAt','sourceSchemaVersion','sourceSchemaChecksum',
    ]);
    equalFields(intake, h, ['targetSchemaVersion','targetSchemaChecksum']);
    equalFields(intake, a, ['candidateKind','preparationRef','sourceEvidenceHash','executionPolicyHash','holdId']);
    ensure(intake.candidateInitialHash === h.liveInitialHash && intake.initialEpoch === h.centerEpoch);
    ensure(intake.acceptedAt >= h.handedOffAt);
    if (s.sourceEvidence === null) ensure(bundle.sourceEvidence === null);
    else sameCanonical(historicalSource(bundle.sourceEvidence), s.sourceEvidence);
  }
  const actual = snapshot(bundle.actual, ACTUAL_FIELDS);
  equalFields(intake, actual, ['instanceId','instanceCreatedAt']);
  ensure(actual.schemaVersion === intake.targetSchemaVersion && actual.schemaChecksum === intake.targetSchemaChecksum);
  ensure(actual.centerEpoch === intake.initialEpoch && actual.recoveryCounter === intake.previousRecoveryCounter);
  ensure(actual.fileHash === intake.candidateInitialHash);
  if (route === 'converted-v4') ensure(actual.writeMode === 'paused');
  // Also applies the complete serialized-record limit to validator results.
  serialize(intake);
  return intake;
}

export function encodeRecoveryV5IntakeRecord(kind, record) {
  return boundary('RECOVERY_INVALID', () => serialize(canonical(kind, record)));
}
export function decodeRecoveryV5IntakeRecord(kind, bytes) {
  return boundary('RECOVERY_EVIDENCE_MISMATCH', () => {
    kindFields(kind);
    const copy = ownedBytes(bytes);
    const text = decoder.decode(copy);
    ensure(!text.startsWith('\uFEFF'));
    const record = canonical(kind, JSON.parse(text));
    // Byte identity rejects duplicate/escaped-alias keys, order changes, number
    // and string aliases, formatting whitespace and all trailing bytes.
    ensure(copy.equals(serialize(record)));
    return record;
  });
}
export function hashRecoveryV5IntakeRecord(kind, record) {
  return boundary('RECOVERY_INVALID', () => digest(kind, canonical(kind, record)));
}
export function validateRecoveryV5ArchiveBindings(bundle) {
  return boundary('RECOVERY_EVIDENCE_MISMATCH', () => {
    const { handoff } = archiveBindings(bundle);
    serialize(handoff);
    return handoff;
  });
}
export function validateRecoveryV5IntakeBindings(bundle) {
  return boundary('RECOVERY_EVIDENCE_MISMATCH', () => intakeBindings(bundle));
}
