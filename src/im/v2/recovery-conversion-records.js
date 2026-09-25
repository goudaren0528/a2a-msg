// Pure B0.2a evidence DTOs. Successful decoding never grants recovery ownership.
import { createHash } from 'node:crypto';
import { types } from 'node:util';

const MAX_BYTES = 65536;
const errors = new WeakSet();
function invalid() {
  const error = Object.assign(new Error('RECOVERY_INVALID'), { code: 'RECOVERY_INVALID' });
  errors.add(error);
  throw error;
}
function guarded(consume) {
  try { return consume(); }
  catch (error) {
    // Identity only: even a thrown Proxy or a foreign error's code is untrusted.
    if (errors.has(error)) throw error;
    invalid();
  }
}

const uuid = value => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const hash = value => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
// Match P5's reference primitive, including its UTF-16-unit length bound.
const ref = value => typeof value === 'string' && value.length >= 1 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);
const nullable = test => value => value === null || test(value);
const one = value => value === 1;
const mode = value => value === 'paused' || value === 'enabled';
const fields = {
  owner: {
    version: one, runId: uuid, stageHash: hash, stagedHash: hash, candidateReference: ref,
    instanceId: uuid, instanceCreatedAt: time, centerEpoch: uuid,
    candidateKind: value => value === 'fresh_bootstrap' || value === 'v3_import' || value === 'snapshot_recovery',
    preparationRef: nullable(ref), sourceEvidenceHash: nullable(hash), holdId: nullable(uuid),
    intakeFileHash: hash, intakeWriteMode: mode, claimedAt: time
  },
  pauseIntent: {
    version: one, ownerHash: hash, inputFileHash: hash, originalWriteMode: mode,
    targetWriteMode: value => value === 'paused', createdAt: time
  },
  paused: {
    version: one, ownerHash: hash, pauseIntentHash: hash, inputFileHash: hash,
    pausedFileHash: hash, changed: value => typeof value === 'boolean', pausedAt: time
  }
};
const domains = {
  owner: 'im-recovery-conversion-owner-v1',
  pauseIntent: 'im-recovery-conversion-pause-intent-v1',
  paused: 'im-recovery-conversion-paused-v1'
};
function rulesFor(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(fields, kind)) invalid();
  return fields[kind];
}
function normalize(kind, value) {
  const rules = rulesFor(kind);
  if (value === null || typeof value !== 'object' || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const keys = Object.keys(rules);
  if (Reflect.ownKeys(value).length !== keys.length) invalid();
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !rules[key](descriptor.value)) invalid();
    // Every accepted field is primitive; nested objects are never traversed.
    result[key] = descriptor.value;
  }
  if (kind === 'owner') {
    if (result.candidateReference !== `runs/${result.runId}/candidate.sqlite` ||
        result.claimedAt < result.instanceCreatedAt) invalid();
    if (result.candidateKind === 'fresh_bootstrap') {
      if (result.preparationRef === null || result.sourceEvidenceHash !== null ||
          result.holdId !== null || result.intakeWriteMode !== 'paused') invalid();
    } else if (result.candidateKind === 'v3_import') {
      if (result.preparationRef === null || result.sourceEvidenceHash === null ||
          result.intakeWriteMode !== 'paused') invalid();
    } else if (result.preparationRef !== null || result.sourceEvidenceHash === null || result.holdId === null) invalid();
  }
  if (kind === 'paused' && !result.changed && result.inputFileHash !== result.pausedFileHash) invalid();
  return Object.freeze(result);
}
function encode(kind, value) {
  const text = JSON.stringify(normalize(kind, value));
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) invalid();
  // A fresh, unpooled ArrayBuffer belongs solely to this invocation's caller.
  return new TextEncoder().encode(text);
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
function copyBytes(bytes) {
  if (types.isProxy(bytes) || !types.isUint8Array(bytes)) invalid();
  const length = byteLength.call(bytes);
  if (length === 0 || length > MAX_BYTES || types.isSharedArrayBuffer(arrayBuffer.call(bytes))) invalid();
  const copy = new Uint8Array(length);
  Uint8Array.prototype.set.call(copy, bytes);
  return copy;
}

export function encodeRecoveryConversionRecord(kind, value) {
  return guarded(() => encode(kind, value));
}
export function decodeRecoveryConversionRecord(kind, bytes) {
  return guarded(() => {
    rulesFor(kind);
    const copy = copyBytes(bytes);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(copy);
    const record = normalize(kind, JSON.parse(text));
    const canonical = encode(kind, record);
    if (canonical.length !== copy.length || !canonical.every((byte, index) => byte === copy[index])) invalid();
    return record;
  });
}
export function hashRecoveryConversionRecord(kind, value) {
  return guarded(() => {
    const bytes = encode(kind, value);
    return createHash('sha256').update(domains[kind], 'ascii').update('\0', 'ascii').update(bytes).digest('hex');
  });
}
