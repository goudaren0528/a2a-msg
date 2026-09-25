import { createHash } from 'node:crypto';
import { types } from 'node:util';

// Pure evidence records. Actual database, chain, file and authority bindings are
// deliberately the responsibility of their consuming validators/services.
const MAX_BYTES = 65536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const FIELDS = {
  timeProposal: ['version','instanceId','instanceCreatedAt','centerEpoch','previousGeneration','previousAnchorHash','sessionNonce','proposedAt','proposalExpiresAt','candidateWallAt','acceptNotBefore','acceptNotAfter','globalFloorObservedAt','maxForwardJumpMs'],
  anchorEvidence: ['version','instanceId','instanceCreatedAt','generation','centerEpoch','previousGeneration','previousAnchorHash','proposalHash','sessionNonce','proposedAt','proposalExpiresAt','candidateWallAt','acceptNotBefore','acceptNotAfter','acceptedWallAt','globalFloorObservedAt','globalFloorAtApproval','maxForwardJumpMs','approvalRef','executorId','approverId'],
  conversionPlan: ['version','transitionId','instanceId','instanceCreatedAt','centerEpoch','recoveryRunId','stageHash','candidateReference','candidateKind','preparationRef','sourceEvidenceHash','fromVersion','fromChecksum','toVersion','toChecksum','preconversionFileHash','executionPolicyHash','createdAt','expiresAt'],
  conversionProof: ['version','plan','planHash','approvalRef','executorId','approverId','convertedAt'],
  conversionComplete: ['version','transitionId','planHash','conversionProofHash','instanceId','instanceCreatedAt','centerEpoch','recoveryRunId','stageHash','candidateReference','schemaVersion','schemaChecksum','preconversionFileHash','postconversionFileHash'],
};
const DOMAINS = {
  timeProposal: 'im-maintenance-time-proposal-v1\n',
  anchorEvidence: 'im-maintenance-time-anchor-v1\n',
  conversionPlan: 'im-center-schema-conversion-plan-v1\n',
  conversionProof: 'im-center-schema-conversion-proof-v1\n',
  conversionComplete: 'im-center-schema-conversion-complete-v1\n',
};
const internalErrors = new WeakSet();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;

function fail(code = 'MAINTENANCE_CODEC_INVALID') {
  const error = new Error('Maintenance record rejected');
  error.code = code;
  internalErrors.add(error);
  throw error;
}

function ensure(condition) { if (!condition) fail(); }

function boundary(operation) {
  try { return operation(); }
  catch (error) {
    // Never inspect a foreign error's code/message/prototype (even a Proxy).
    if (internalErrors.has(error)) throw error;
    fail();
  }
}

function kindFields(kind) {
  ensure(typeof kind === 'string' && Object.hasOwn(FIELDS, kind));
  return FIELDS[kind];
}

function shape(value, fields) {
  ensure(value !== null && typeof value === 'object' && !types.isProxy(value));
  ensure(Object.getPrototypeOf(value) === Object.prototype);
  const keys = Reflect.ownKeys(value);
  ensure(keys.length === fields.length && keys.every(key => typeof key === 'string' && fields.includes(key)));
  const copy = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    ensure(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
    copy[field] = descriptor.value;
  }
  return copy;
}

function number(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  ensure(Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max);
}

function string(value, pattern) {
  ensure(typeof value === 'string' && value.length === (pattern === UUID ? 36 : 64) && pattern.test(value));
}
function nullable(value, check) { if (value !== null) check(value); }
function ref(value) {
  ensure(typeof value === 'string' && value.length >= 1 && value.length <= 255);
  ensure(!/[\x00-\x1f\x7f]/.test(value) && String.prototype.isWellFormed.call(value));
}

function duration(start, end, maximum) {
  number(start); number(end);
  const delta = end - start;
  ensure(delta > 0 && delta <= maximum && start <= Number.MAX_SAFE_INTEGER - delta && start + delta === end);
}

function identity(record) {
  string(record.instanceId, UUID);
  number(record.instanceCreatedAt);
  string(record.centerEpoch, UUID);
}

function proposalFacts(record) {
  identity(record);
  nullable(record.previousGeneration, value => number(value, 1));
  nullable(record.previousAnchorHash, value => string(value, HASH));
  ensure((record.previousGeneration === null) === (record.previousAnchorHash === null));
  string(record.sessionNonce, UUID);
  duration(record.proposedAt, record.proposalExpiresAt, 300000);
  number(record.candidateWallAt);
  duration(record.acceptNotBefore, record.acceptNotAfter, 5000);
  ensure(record.proposedAt === record.candidateWallAt && record.acceptNotBefore === record.candidateWallAt);
  number(record.globalFloorObservedAt);
  number(record.maxForwardJumpMs, 1, 86400000);
}

function actors(record) {
  ref(record.approvalRef); ref(record.executorId); ref(record.approverId);
  ensure(record.executorId !== record.approverId);
}

function candidate(record) {
  string(record.transitionId, UUID);
  identity(record);
  string(record.recoveryRunId, UUID);
  string(record.stageHash, HASH);
  ref(record.candidateReference);
  ensure(record.candidateReference === `runs/${record.recoveryRunId}/candidate.sqlite`);
  string(record.preconversionFileHash, HASH);
}

function canonical(kind, value) {
  const record = shape(value, kindFields(kind));
  ensure(record.version === 1);
  switch (kind) {
    case 'timeProposal':
      proposalFacts(record);
      break;
    case 'anchorEvidence': {
      proposalFacts(record);
      number(record.generation, 1);
      if (record.previousGeneration === null) ensure(record.generation === 1);
      else {
        ensure(record.previousGeneration < Number.MAX_SAFE_INTEGER);
        ensure(record.generation === record.previousGeneration + 1);
      }
      number(record.acceptedWallAt); number(record.globalFloorAtApproval);
      ensure(record.acceptedWallAt >= record.acceptNotBefore && record.acceptedWallAt <= record.acceptNotAfter);
      ensure(record.acceptedWallAt < record.proposalExpiresAt);
      ensure(record.globalFloorAtApproval >= record.globalFloorObservedAt && record.acceptedWallAt >= record.globalFloorAtApproval);
      actors(record);
      string(record.proposalHash, HASH);
      // Use the observed proposal floor, not the approval floor.
      const proposal = Object.fromEntries(FIELDS.timeProposal.map(field => [field, record[field]]));
      ensure(record.proposalHash === digest('timeProposal', serialize(proposal)));
      break;
    }
    case 'conversionPlan':
      candidate(record);
      ensure(record.fromVersion === 4 && record.toVersion === 5);
      for (const field of ['fromChecksum','toChecksum','executionPolicyHash']) string(record[field], HASH);
      nullable(record.preparationRef, ref);
      nullable(record.sourceEvidenceHash, value => string(value, HASH));
      if (record.candidateKind === 'fresh_bootstrap') ensure(record.preparationRef !== null && record.sourceEvidenceHash === null);
      else if (record.candidateKind === 'v3_import') ensure(record.preparationRef !== null && record.sourceEvidenceHash !== null);
      else if (record.candidateKind === 'snapshot_recovery') ensure(record.preparationRef === null && record.sourceEvidenceHash !== null);
      else fail();
      duration(record.createdAt, record.expiresAt, 300000);
      break;
    case 'conversionProof':
      record.plan = canonical('conversionPlan', record.plan);
      string(record.planHash, HASH);
      ensure(record.planHash === digest('conversionPlan', serialize(record.plan)));
      actors(record);
      number(record.convertedAt);
      ensure(record.convertedAt >= record.plan.createdAt && record.convertedAt < record.plan.expiresAt);
      break;
    case 'conversionComplete':
      candidate(record);
      ensure(record.schemaVersion === 5);
      for (const field of ['planHash','conversionProofHash','schemaChecksum','postconversionFileHash']) string(record[field], HASH);
      break;
  }
  return Object.freeze(record);
}

function serialize(record) {
  const text = JSON.stringify(record);
  const length = Buffer.byteLength(text, 'utf8');
  if (length > MAX_BYTES) fail('MAINTENANCE_METADATA_LIMIT');
  // A private backing store, not a slice of Node's shared small-buffer pool.
  const bytes = Buffer.alloc(length);
  bytes.write(text, 'utf8');
  return bytes;
}

function digest(kind, bytes) {
  return createHash('sha256').update(DOMAINS[kind], 'utf8').update(bytes).digest('hex');
}

function ownedBytes(value) {
  ensure(value !== null && typeof value === 'object' && !types.isProxy(value));
  ensure(types.isUint8Array(value));
  const prototype = Object.getPrototypeOf(value);
  ensure(prototype === Uint8Array.prototype || prototype === Buffer.prototype);
  const length = byteLengthGetter.call(value);
  if (length > MAX_BYTES) fail('MAINTENANCE_METADATA_LIMIT');
  const backing = bufferGetter.call(value);
  ensure(!types.isSharedArrayBuffer(backing) && Object.getPrototypeOf(backing) === ArrayBuffer.prototype);
  // Do not consult caller-shadowed buffer/length/iterator/valueOf properties.
  const keys = Reflect.ownKeys(value);
  ensure(keys.length === length && keys.every((key, index) => key === String(index)));
  const copy = Buffer.alloc(length);
  Uint8Array.prototype.set.call(copy, value);
  return copy;
}

export function encodeMaintenanceV5Record(kind, value) {
  return boundary(() => serialize(canonical(kind, value)));
}

export function decodeMaintenanceV5Record(kind, bytes) {
  return boundary(() => {
    kindFields(kind);
    const copy = ownedBytes(bytes);
    const text = decoder.decode(copy);
    ensure(!text.startsWith('\uFEFF'));
    const record = canonical(kind, JSON.parse(text));
    // Also rejects duplicate/escaped-alias keys, alternate numeric spelling,
    // escaped strings, different field order, whitespace and trailing newlines.
    ensure(copy.equals(serialize(record)));
    return record;
  });
}

export function hashMaintenanceV5Record(kind, value) {
  return boundary(() => digest(kind, serialize(canonical(kind, value))));
}
