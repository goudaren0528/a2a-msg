import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { V5_CHECKSUM } from './schema-v5-internal.js';

// Content-only C1 records. No provenance, cross-record authority or publication
// capability follows from canonical bytes or their hashes.
const MAX_BYTES = 65536;
const FIELDS = {
  manifest: ['formatVersion','backupId','sourceId','sourceCreatedAt','schemaVersion','schemaChecksum','fileHash','completedAt','toolVersion','approval'],
  record: ['recordVersion','backupId','instanceId','instanceCreatedAt','schemaVersion','schemaChecksum','fileHash','manifestHash','completedAt','artifactReference','publicationKind','sourceEvidenceHash','registeredAt'],
  source: ['version','kind','sourceRef','registryFormat','instanceId','instanceCreatedAt','backupId','fileHash','manifestHash','schemaVersion','schemaChecksum','completedAt','importedRecordHash'],
};
const APPROVAL = ['approvalRef','executorActorId','approverActorId'];
const rejected = Symbol('rejected backup record');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;

function ensure(condition) { if (!condition) throw rejected; }

function boundary(code, operation) {
  try { return operation(); }
  catch {
    // Classification belongs to the public operation, not to a thrown value.
    // Never reflect on foreign exceptions; always expose a fresh fixed error.
    throw Object.assign(new Error(code), { code });
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

function uuid(value) {
  ensure(typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value));
}
function hash(value) {
  ensure(typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value));
}
function time(value) {
  ensure(Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0);
}
function ref(value) {
  // P5 references count UTF-16 units, including lone surrogates. JSON.stringify
  // escapes those surrogates losslessly; no Unicode normalization is performed.
  ensure(typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value));
}

function canonical(kind, value) {
  const record = shape(value, kindFields(kind));
  uuid(record.backupId);
  ensure(record.schemaVersion === 5 && record.schemaChecksum === V5_CHECKSUM);
  hash(record.fileHash);
  time(record.completedAt);
  if (kind === 'manifest') {
    ensure(record.formatVersion === 3 && record.toolVersion === 'im-v2-backup-2');
    uuid(record.sourceId);
    time(record.sourceCreatedAt);
    const approval = shape(record.approval, APPROVAL);
    for (const field of APPROVAL) ref(approval[field]);
    ensure(approval.executorActorId !== approval.approverActorId);
    record.approval = Object.freeze(approval);
  } else {
    uuid(record.instanceId);
    time(record.instanceCreatedAt);
    hash(record.manifestHash);
    if (kind === 'record') {
      ensure(record.recordVersion === 4 && record.publicationKind === 'native-v5');
      ensure(record.artifactReference === `registry/artifacts/${record.backupId}.sqlite`);
      hash(record.sourceEvidenceHash);
      time(record.registeredAt);
    } else {
      ensure(record.version === 2 && record.kind === 'registered-backup' && record.registryFormat === 4);
      ensure(record.sourceRef === `backup:${record.backupId}` && record.importedRecordHash === null);
    }
  }
  // Inherited P5 defines scalar times, not a monotonic relationship between
  // creation, completion and registration. Authority checks belong to consumers.
  return Object.freeze(record);
}

function serialize(record) {
  const text = JSON.stringify(record);
  const length = Buffer.byteLength(text, 'utf8');
  ensure(length <= MAX_BYTES);
  // Dedicated backing store: no alias into Node's small-buffer pool.
  const bytes = Buffer.alloc(length);
  bytes.write(text, 'utf8');
  return bytes;
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
  // Reject shadowed properties without consulting length/buffer/iterator getters.
  const keys = Reflect.ownKeys(value);
  ensure(keys.length === length && keys.every((key, index) => key === String(index)));
  const copy = Buffer.alloc(length);
  Uint8Array.prototype.set.call(copy, value);
  return copy;
}

export function encodeImV5BackupRecord(kind, record) {
  return boundary('RECOVERY_INVALID', () => serialize(canonical(kind, record)));
}

export function decodeImV5BackupRecord(kind, bytes) {
  return boundary('RECOVERY_EVIDENCE_MISMATCH', () => {
    kindFields(kind);
    const copy = ownedBytes(bytes);
    const text = decoder.decode(copy);
    ensure(!text.startsWith('\uFEFF'));
    const record = canonical(kind, JSON.parse(text));
    // Also rejects duplicate/escaped-alias keys, alternate string/number spelling,
    // reordered fields, whitespace and trailing newlines.
    ensure(copy.equals(serialize(record)));
    return record;
  });
}

export function hashImV5BackupRecord(kind, record) {
  return boundary('RECOVERY_INVALID', () => createHash('sha256').update(encodeImV5BackupRecord(kind, record)).digest('hex'));
}
