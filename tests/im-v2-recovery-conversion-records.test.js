import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as codec from '../src/im/v2/recovery-conversion-records.js';

const { encodeRecoveryConversionRecord: encode, decodeRecoveryConversionRecord: decode,
  hashRecoveryConversionRecord: hash } = codec;
const vectors = JSON.parse(readFileSync(new URL('./fixtures/im-v2-recovery-conversion-records/vectors.json', import.meta.url), 'utf8'));
const baseline = kind => JSON.parse(vectors.find(vector => vector.kind === kind).canonical);
const bytes = text => new TextEncoder().encode(text);
const hex = digit => digit.repeat(64);
const holdId = '44444444-4444-4444-8444-444444444444';
const reject = fn => assert.throws(fn, error => {
  assert.equal(Object.getPrototypeOf(error), Error.prototype);
  assert.equal(error.code, 'RECOVERY_INVALID');
  assert.equal(error.message, 'RECOVERY_INVALID');
  assert.deepEqual(Object.keys(error), ['code']);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
});
function rejectRecord(kind, value) {
  reject(() => encode(kind, value));
  reject(() => hash(kind, value));
}
function accepted(kind, value) {
  const encoded = encode(kind, value);
  assert.deepEqual(decode(kind, encoded), value);
  assert.match(hash(kind, value), /^[0-9a-f]{64}$/);
}

test('exact three exports and detached descriptive DTOs have no capability surface', () => {
  assert.deepEqual(Object.keys(codec).sort(), ['decodeRecoveryConversionRecord', 'encodeRecoveryConversionRecord', 'hashRecoveryConversionRecord']);
  for (const vector of vectors) {
    const value = baseline(vector.kind);
    const dto = decode(vector.kind, bytes(vector.canonical));
    assert.deepEqual(Reflect.ownKeys(dto), Object.keys(value));
    assert.equal(Object.getPrototypeOf(dto), Object.prototype);
    assert.equal(Object.isFrozen(dto), true);
    assert.notEqual(dto, value);
    assert.equal(Object.values(dto).every(v => v === null || ['string', 'boolean', 'number'].includes(typeof v)), true);
    assert.throws(() => { dto.version = 2; }, TypeError);
    assert.throws(() => { dto.claimConversion = () => {}; }, TypeError);
  }
});

for (const vector of vectors) {
  test(`${vector.kind}: independent literal bytes, fixed hash, insertion order and domain separation`, () => {
    const value = baseline(vector.kind);
    const reversed = Object.fromEntries(Object.entries(value).reverse());
    assert.deepEqual(encode(vector.kind, reversed), bytes(vector.canonical));
    assert.deepEqual(decode(vector.kind, bytes(vector.canonical)), value);
    assert.equal(hash(vector.kind, reversed), vector.sha256);
    const digest = prefix => createHash('sha256').update(prefix).update(bytes(vector.canonical)).digest('hex');
    assert.equal(digest(`${vector.domain}\0`), vector.sha256);
    for (const prefix of ['', `${vector.domain}\n`, vector.domain, `${vector.domain}\0\0`]) assert.notEqual(digest(prefix), vector.sha256);
  });
  test(`${vector.kind}: exact fields, accessor/symbol/unknown rejection`, () => {
    const value = baseline(vector.kind);
    accepted(vector.kind, value);
    for (const key of Object.keys(value)) {
      const missing = { ...value }; delete missing[key]; rejectRecord(vector.kind, missing);
      rejectRecord(vector.kind, { ...value, [key]: undefined });
      let accessed = 0;
      const accessor = { ...value };
      Object.defineProperty(accessor, key, { get() { accessed++; throw new Error('secret'); } });
      rejectRecord(vector.kind, accessor);
      assert.equal(accessed, 0);
    }
    for (const key of ['unknown', '__proto__', 'toJSON', 'then', Symbol('secret')]) {
      const extra = { ...value };
      Object.defineProperty(extra, key, { value: 1 });
      rejectRecord(vector.kind, extra);
    }
    // Ordinary own data descriptors are snapshotted without requiring enumerability.
    const nonenumerable = { ...value };
    Object.defineProperty(nonenumerable, 'version', { value: 1, enumerable: false });
    assert.deepEqual(encode(vector.kind, nonenumerable), bytes(vector.canonical));
  });
  test(`${vector.kind}: canonical byte decoder refuses all lexical aliases`, () => {
    const literal = vector.canonical;
    const variants = [
      ` ${literal}`, `${literal} `, `${literal}\n`, `\ufeff${literal}`, `${literal}{}`, `${literal}null`,
      literal.replace('{', '{ '), JSON.stringify(Object.fromEntries(Object.entries(baseline(vector.kind)).reverse())),
      literal.replace('"version":1', '"version":1,"version":1'),
      literal.replace('"version":1', '"version":1,"\\u0076ersion":1'),
      literal.replace('"version":1', '"\\u0076ersion":1'),
      literal.replace('"version":1', '"version":1.0'), literal.replace('"version":1', '"version":1e0'),
      literal.replace('"version":1', '"version":9007199254740992'), literal.slice(0, -1),
      literal.replace('"version":1', '"version":true'), literal.replace('"version":1', '"version":null')
    ];
    for (const text of variants) reject(() => decode(vector.kind, bytes(text)));
  });
}

test('owner four routes and all intake mode pairs have exact nullability', () => {
  const fresh = baseline('owner');
  const closed = { ...fresh, candidateKind: 'v3_import', sourceEvidenceHash: hex('d') };
  const registered = { ...closed, holdId };
  const snapshot = { ...registered, candidateKind: 'snapshot_recovery', preparationRef: null };
  for (const route of [fresh, closed, registered, snapshot]) {
    for (const intakeWriteMode of ['paused', 'enabled']) {
      const value = { ...route, intakeWriteMode };
      if (intakeWriteMode === 'paused' || route === snapshot) accepted('owner', value);
      else rejectRecord('owner', value);
    }
  }
  for (const [base, key, value] of [
    [fresh, 'preparationRef', null], [fresh, 'sourceEvidenceHash', hex('d')], [fresh, 'holdId', holdId],
    [closed, 'preparationRef', null], [closed, 'sourceEvidenceHash', null],
    [registered, 'preparationRef', null], [registered, 'sourceEvidenceHash', null],
    [snapshot, 'preparationRef', 'unexpected'], [snapshot, 'sourceEvidenceHash', null], [snapshot, 'holdId', null]
  ]) rejectRecord('owner', { ...base, [key]: value });
});

test('pause modes and changed=false file equality; changed=true is not provenance', () => {
  for (const originalWriteMode of ['enabled', 'paused']) accepted('pauseIntent', { ...baseline('pauseIntent'), originalWriteMode });
  for (const targetWriteMode of ['enabled', null, true, 'PAUSED']) rejectRecord('pauseIntent', { ...baseline('pauseIntent'), targetWriteMode });
  const paused = baseline('paused');
  accepted('paused', paused);
  accepted('paused', { ...paused, pausedFileHash: paused.inputFileHash });
  accepted('paused', { ...paused, changed: false, pausedFileHash: paused.inputFileHash });
  rejectRecord('paused', { ...paused, changed: false });
  for (const changed of [0, 1, 'true', null, new Boolean(true)]) rejectRecord('paused', { ...paused, changed });
});

test('canonical UUIDs, hashes, fixed candidate reference and no caller path', () => {
  const owner = baseline('owner');
  for (const key of ['runId', 'instanceId', 'centerEpoch', 'holdId']) {
    const valid = { ...owner, candidateKind: 'v3_import', sourceEvidenceHash: hex('d'), holdId };
    accepted('owner', valid);
    for (const value of ['ABCDEFAB-1234-1234-1234-123456789abc', holdId.replaceAll('-', ''), `${holdId}\n`, `{${holdId}}`, 1, false]) rejectRecord('owner', { ...valid, [key]: value });
  }
  for (const vector of vectors) {
    const valid = baseline(vector.kind);
    for (const key of Object.keys(valid).filter(key => key.endsWith('Hash') && valid[key] !== null)) {
      for (const value of [hex('A'), 'a'.repeat(63), 'a'.repeat(65), `${hex('a')}\n`, null, 2]) rejectRecord(vector.kind, { ...valid, [key]: value });
    }
  }
  for (const candidateReference of [
    'candidate.sqlite', `runs/${holdId}/candidate.sqlite`, `./${owner.candidateReference}`,
    `${owner.candidateReference}/..`, owner.candidateReference.replaceAll('/', '\\'),
    `D:/${owner.candidateReference}`, `/${owner.candidateReference}`, `file:///${owner.candidateReference}`,
    owner.candidateReference.replace('runs/', 'runs//'), owner.candidateReference.replace('candidate.sqlite', '%63andidate.sqlite')
  ]) rejectRecord('owner', { ...owner, candidateReference });
  for (const candidateKind of ['fresh', 'V3_IMPORT', null, 1]) rejectRecord('owner', { ...owner, candidateKind });
});

test('safe integer boundaries and local chronology are strict without cross-record authority', () => {
  for (const [kind, key] of [['owner', 'instanceCreatedAt'], ['owner', 'claimedAt'], ['pauseIntent', 'createdAt'], ['paused', 'pausedAt']]) {
    const base = baseline(kind);
    if (kind === 'owner') { base.instanceCreatedAt = 0; base.claimedAt = Number.MAX_SAFE_INTEGER; }
    for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) accepted(kind, { ...base, [key]: value });
    for (const value of [-0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null, 1n, new Number(1)]) rejectRecord(kind, { ...base, [key]: value });
    const canonical = JSON.stringify({ ...base, [key]: 0 });
    for (const token of ['-0', '0.0', '0e0', '1e309', '9007199254740993']) reject(() => decode(kind, bytes(canonical.replace(`"${key}":0`, `"${key}":${token}`))));
  }
  rejectRecord('owner', { ...baseline('owner'), claimedAt: 999 });
  accepted('pauseIntent', { ...baseline('pauseIntent'), createdAt: 0, ownerHash: hex('1') });
  accepted('paused', { ...baseline('paused'), pausedAt: 0, ownerHash: hex('2'), pauseIntentHash: hex('3') });
});

test('references use existing 1..255 UTF-16 units and canonical Unicode JSON', () => {
  const owner = baseline('owner');
  for (const preparationRef of ['a', '中'.repeat(255), '😀'.repeat(127) + 'a', 'e\u0301', '\u00e9', '\u2028\u2029', '\ufeff', '\ufffd', '\ud800', '\udfff', 'quote"back\\slash']) accepted('owner', { ...owner, preparationRef });
  for (const preparationRef of ['', 'a'.repeat(256), '😀'.repeat(128), '\0', '\n', '\t', '\x1f', '\x7f']) rejectRecord('owner', { ...owner, preparationRef });
  const unicode = vectors[0].canonical;
  reject(() => decode('owner', bytes(unicode.replace('初', '\\u521d'))));
  reject(() => decode('owner', bytes(unicode.replace('😀', '\\ud83d\\ude00'))));
  assert.notEqual(hash('owner', { ...owner, preparationRef: 'e\u0301' }), hash('owner', { ...owner, preparationRef: '\u00e9' }));
});

test('raw UTF-8 malformed, overlong, surrogate and truncated sequences fail fixed invalid', () => {
  const literal = vectors[0].canonical.replace('prepare:初期😀', 'MARK');
  const [before, after] = literal.split('MARK');
  for (const malformed of [[0x80], [0xc0, 0xaf], [0xc1, 0x81], [0xe0, 0x80, 0xaf], [0xed, 0xa0, 0x80], [0xf0, 0x80, 0x80, 0xaf], [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xc2], [0xe2, 0x82], [0xf0, 0x9f, 0x98], [0xff]]) {
    reject(() => decode('owner', Uint8Array.from([...bytes(before), ...malformed, ...bytes(after)])));
  }
});

test('64 KiB byte ceiling uses raw length and does not adopt oversized metadata', () => {
  for (const vector of vectors) {
    for (const length of [65535, 65536, 65537, 131072]) {
      const padded = new Uint8Array(length).fill(0x20);
      padded.set(bytes(vector.canonical));
      reject(() => decode(vector.kind, padded));
    }
    rejectRecord(vector.kind, { ...baseline(vector.kind), metadata: 'x'.repeat(65537) });
  }
  rejectRecord('owner', { ...baseline('owner'), preparationRef: 'x'.repeat(65537) });
  // Exact shapes cannot produce a valid 64 KiB record: only Ref has variable
  // length, at most 255 UTF-16 units. This is the largest JSON escape expansion.
  const maximal = { ...baseline('owner'), preparationRef: '\ud800'.repeat(255), instanceCreatedAt: Number.MAX_SAFE_INTEGER, claimedAt: Number.MAX_SAFE_INTEGER };
  accepted('owner', maximal);
  assert.ok(encode('owner', maximal).length < 65536);
});

test('input and output bytes are detached snapshots with owned, unpooled buffers', () => {
  for (const vector of vectors) {
    const value = baseline(vector.kind);
    const first = encode(vector.kind, value), second = encode(vector.kind, value);
    assert.equal(Object.getPrototypeOf(first), Uint8Array.prototype);
    assert.equal(first.byteOffset, 0);
    assert.equal(first.buffer.byteLength, first.byteLength);
    assert.notEqual(first.buffer, second.buffer);
    const decoded = decode(vector.kind, first);
    first.fill(0); value.version = 2;
    assert.equal(decoded.version, 1);
    assert.deepEqual(second, bytes(vector.canonical));
    const padded = Buffer.concat([Buffer.from('xx'), Buffer.from(vector.canonical), Buffer.from('yy')]);
    assert.deepEqual(decode(vector.kind, padded.subarray(2, -2)), baseline(vector.kind));
    padded.fill(0);
    assert.deepEqual(decoded, baseline(vector.kind));
    const source = bytes(vector.canonical);
    Object.defineProperties(source, {
      length: { get() { throw new Error('length accessed'); } },
      byteLength: { get() { throw new Error('byteLength accessed'); } },
      buffer: { get() { throw new Error('buffer accessed'); } },
      [Symbol.iterator]: { get() { throw new Error('iterator accessed'); } }
    });
    assert.deepEqual(decode(vector.kind, source), baseline(vector.kind));
  }
});

test('invalid byte types, shared and detached buffers fail without coercion', () => {
  for (const input of [null, undefined, '', vectors[0].canonical, [], {}, new ArrayBuffer(4), new DataView(new ArrayBuffer(4)), new Uint16Array(4), new Uint8ClampedArray(4), new Uint8Array(), new Uint8Array(new SharedArrayBuffer(10))]) reject(() => decode('owner', input));
  const detached = bytes(vectors[0].canonical);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  reject(() => decode('owner', detached));
});

test('unknown kind, prototype names, symbols and coercion objects are fixed invalid for all APIs', () => {
  let accesses = 0;
  const trap = () => { accesses++; throw new Error('foreign'); };
  const hostile = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  for (const kind of [undefined, null, 1, '', 'Owner', 'pause-intent', 'stage', 'toString', '__proto__', 'constructor', Symbol('owner'), new String('owner'), hostile]) {
    rejectRecord(kind, baseline('owner'));
    reject(() => decode(kind, bytes(vectors[0].canonical)));
  }
  assert.equal(accesses, 0);
  for (const vector of vectors) for (const other of vectors) if (vector !== other) reject(() => decode(other.kind, bytes(vector.canonical)));
});

test('top-level and nested hostile values never run getters, coercion or Proxy traps', () => {
  let accesses = 0;
  const foreign = new Proxy({}, { get() { accesses++; throw null; }, getPrototypeOf() { accesses++; throw false; } });
  const trap = () => { accesses++; throw foreign; };
  const handler = Object.fromEntries(['get', 'ownKeys', 'getPrototypeOf', 'getOwnPropertyDescriptor', 'has'].map(key => [key, trap]));
  const proxy = new Proxy(baseline('owner'), handler);
  const revoked = Proxy.revocable({}, handler); revoked.revoke();
  const nested = Object.defineProperties({}, {
    code: { get: trap }, message: { get: trap }, toJSON: { get: trap }, valueOf: { get: trap },
    [Symbol.toPrimitive]: { get: trap }
  });
  for (const input of [proxy, revoked.proxy, nested, Object.create(null), [], new Date(), /x/, new Map(), () => {}]) rejectRecord('owner', input);
  reject(() => decode('owner', new Proxy(bytes(vectors[0].canonical), handler)));
  reject(() => decode('owner', revoked.proxy));
  for (const vector of vectors) {
    const base = baseline(vector.kind);
    for (const key of Object.keys(base)) {
      for (const value of [proxy, revoked.proxy, nested, foreign, Symbol('secret')]) rejectRecord(vector.kind, { ...base, [key]: value });
      const cyclic = { ...base }; cyclic[key] = cyclic; rejectRecord(vector.kind, cyclic);
    }
  }
  assert.equal(accesses, 0);
});
