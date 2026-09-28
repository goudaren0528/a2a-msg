import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as codec from '../src/im/v2/backup-v5-records.js';
import { V5_CHECKSUM } from '../src/im/v2/schema-v5-internal.js';
import { canonical as oldEncode, decode as oldDecode } from '../src/im/v2/recovery-records.js';

const { encodeImV5BackupRecord: encode, decodeImV5BackupRecord: decode, hashImV5BackupRecord: hash } = codec;
// Complete literal expectations, authored via a separate Python field-table
// oracle. Tests only read fixtures; no generation or overwriting on test runs.
const vectors = JSON.parse(readFileSync(new URL('./fixtures/im-v2-backup-v5-records/vectors.json', import.meta.url), 'utf8'));
const sample = kind => JSON.parse(vectors.find(vector => vector.kind === kind).canonical);
const raw = text => Buffer.from(text, 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixedError(code) {
  return error => {
    assert.equal(Object.getPrototypeOf(error), Error.prototype);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ['code','message','stack']);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  };
}
const invalid = fixedError('RECOVERY_INVALID');
const mismatch = fixedError('RECOVERY_EVIDENCE_MISMATCH');
function reject(kind, record) {
  assert.throws(() => encode(kind, record), invalid);
  assert.throws(() => hash(kind, record), invalid);
}
function rejectJson(kind, record) {
  reject(kind, record);
  assert.throws(() => decode(kind, raw(JSON.stringify(record))), mismatch);
}

test('exactly three C1 exports and exact frozen schema checksum', () => {
  assert.deepEqual(Object.keys(codec).sort(), ['decodeImV5BackupRecord','encodeImV5BackupRecord','hashImV5BackupRecord']);
  assert.equal(V5_CHECKSUM, '80eba5e6ce61261d31ec495216c3b6eb8c7a8f0c87edcbb1440372353f495435');
});

for (const { kind, canonical, sha256 } of vectors) {
  test(`${kind}: full literal canonical UTF-8 and fixed raw-byte SHA256 vector`, () => {
    const record = sample(kind), bytes = raw(canonical);
    assert.deepEqual(encode(kind, record), bytes);
    assert.equal(hash(kind, record), sha256);
    assert.equal(sha(bytes), sha256);
    assert.notEqual(sha(Buffer.concat([raw(`im-backup-${kind}\n`), bytes])), sha256);
    assert.deepEqual(decode(kind, bytes), record);
    assert.ok(Object.isFrozen(decode(kind, bytes)));
  });

  test(`${kind}: encoder canonicalizes object order; decoder refuses alternate spelling/order`, () => {
    const reversed = Object.fromEntries(Object.entries(sample(kind)).reverse());
    if (kind === 'manifest') reversed.approval = Object.fromEntries(Object.entries(reversed.approval).reverse());
    assert.equal(encode(kind, reversed).toString('utf8'), canonical);
    const firstKey = Object.keys(sample(kind))[0];
    const firstValue = sample(kind)[firstKey];
    const variants = [
      JSON.stringify(reversed), ` ${canonical}`, `${canonical}\n`, `\uFEFF${canonical}`,
      canonical.replace(':', ': '), canonical.replace('1700000000000', '1700000000000.0'),
      canonical.replace('1700000000000', '1.7e12'),
      canonical.replace(`"${firstKey}"`, `"\\u${firstKey.charCodeAt(0).toString(16).padStart(4, '0')}${firstKey.slice(1)}"`),
      canonical.replace('{', `{"${firstKey}":${firstValue},`),
      canonical.replace('{', `{"\\u${firstKey.charCodeAt(0).toString(16).padStart(4, '0')}${firstKey.slice(1)}":${firstValue},`),
      canonical.replace('aaaaaaaa-bbbb', '\\u0061aaaaaaa-bbbb'),
    ];
    for (const text of variants) assert.throws(() => decode(kind, raw(text)), mismatch, text);
  });

  test(`${kind}: missing/extra/symbol/nonenumerable/accessor fields and nonordinary objects refuse`, () => {
    for (const field of Object.keys(sample(kind))) {
      const missing = sample(kind); delete missing[field]; rejectJson(kind, missing);
      const hidden = sample(kind); Object.defineProperty(hidden, field, { enumerable: false }); reject(kind, hidden);
      let calls = 0;
      const accessor = sample(kind);
      Object.defineProperty(accessor, field, { enumerable: true, get() { calls++; throw Error('foreign'); } });
      reject(kind, accessor); assert.equal(calls, 0);
    }
    rejectJson(kind, { ...sample(kind), unknown: true });
    reject(kind, { ...sample(kind), [Symbol('field')]: true });
    reject(kind, Object.assign(Object.create(null), sample(kind)));
    reject(kind, Object.assign(Object.create({}), sample(kind)));
    for (const value of [null, undefined, [], true, 4, 'record', () => {}, new Date(0)]) reject(kind, value);
  });

  test(`${kind}: every field rejects malformed single-field types and nullability`, () => {
    for (const [field, original] of Object.entries(sample(kind))) {
      for (const value of [undefined, null, true, false, [], {}, 1n, Symbol('bad'), () => {}]) {
        if (original === null && value === null) continue;
        reject(kind, { ...sample(kind), [field]: value });
      }
      if (typeof original === 'number') rejectJson(kind, { ...sample(kind), [field]: String(original) });
      if (typeof original === 'string') rejectJson(kind, { ...sample(kind), [field]: 0 });
    }
  });

  test(`${kind}: UUID/hash/checksum rejects uppercase, whitespace, lengths and near-valid checksums`, () => {
    for (const [field, original] of Object.entries(sample(kind))) {
      if (typeof original !== 'string' || ![36, 64].includes(original.length)) continue;
      const badValues = ['', `${original}\n`, `${original} `, original.slice(1), `g${original.slice(1)}`, original.toUpperCase()];
      for (const value of badValues) if (value !== original) rejectJson(kind, { ...sample(kind), [field]: value });
    }
    for (const schemaVersion of [3, 4, 6, 5.1]) rejectJson(kind, { ...sample(kind), schemaVersion });
    for (const schemaChecksum of ['0'.repeat(64), 'f'.repeat(64), V5_CHECKSUM.slice(0, -1) + '6'])
      rejectJson(kind, { ...sample(kind), schemaChecksum });
  });

  test(`${kind}: safe nonnegative scalar times include zero/MAX, exclude negative zero and overflow`, () => {
    for (const field of Object.keys(sample(kind)).filter(field => field.endsWith('At'))) {
      for (const value of [0, Number.MAX_SAFE_INTEGER]) {
        const record = { ...sample(kind), [field]: value };
        assert.deepEqual(decode(kind, encode(kind, record)), record);
      }
      for (const value of [-0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, '0', new Number(0)])
        reject(kind, { ...sample(kind), [field]: value });
      for (const text of ['-0', '-1', '0.5', '9007199254740992', '1e400', '0.0', '0e0']) {
        const changed = canonical.replace(new RegExp(`"${field}":\\d+`), `"${field}":${text}`);
        assert.throws(() => decode(kind, raw(changed)), mismatch);
      }
    }
  });

  test(`${kind}: owned unpooled output and detached frozen decode`, () => {
    const input = sample(kind), first = encode(kind, input), second = encode(kind, input);
    assert.ok(Buffer.isBuffer(first));
    assert.equal(first.byteOffset, 0);
    assert.equal(first.buffer.byteLength, first.byteLength);
    assert.notEqual(first.buffer, second.buffer);
    assert.notEqual(first.buffer, encode(kind, sample(kind)).buffer);
    const record = decode(kind, first);
    assert.ok(Object.isFrozen(record));
    assert.notEqual(record, input);
    if (kind === 'manifest') {
      assert.ok(Object.isFrozen(record.approval));
      assert.notEqual(record.approval, input.approval);
      input.approval.approvalRef = 'mutated';
      assert.throws(() => { record.approval.approvalRef = 'mutated'; }, TypeError);
    }
    input.backupId = 'mutated'; first.fill(0);
    assert.deepEqual(record, sample(kind));
    assert.equal(second.toString('utf8'), canonical);
    assert.throws(() => { record.backupId = 'mutated'; }, TypeError);
    const padded = Buffer.concat([raw('prefix'), second, raw('suffix')]);
    assert.deepEqual(decode(kind, padded.subarray(6, 6 + second.length)), record);
    assert.deepEqual(decode(kind, new Uint8Array(second)), record);
  });
}

test('fixture three-record hash equalities are content-only, with no registry proof', () => {
  const manifest = sample('manifest'), record = sample('record'), source = sample('source');
  assert.equal(record.manifestHash, hash('manifest', manifest));
  assert.equal(source.manifestHash, record.manifestHash);
  assert.equal(record.sourceEvidenceHash, hash('source', source));
  // Each codec is intentionally local: unrelated syntactically valid hash/ID
  // facts cannot be promoted to cross-record verification by these APIs.
  assert.ok(encode('record', { ...record, manifestHash: '0'.repeat(64), sourceEvidenceHash: '1'.repeat(64) }));
  assert.ok(encode('source', { ...source, instanceId: '00000000-0000-0000-0000-000000000000' }));
});

test('manifest approval has exact nested fields, distinct actors and no implicit permission', () => {
  const base = sample('manifest');
  for (const field of Object.keys(base.approval)) {
    const missing = { ...base.approval }; delete missing[field];
    rejectJson('manifest', { ...base, approval: missing });
    for (const value of ['', 'x'.repeat(256), '\0', '\x1f', '\x7f', 'line\nbreak', null, 4, true, {}, []])
      rejectJson('manifest', { ...base, approval: { ...base.approval, [field]: value } });
    let calls = 0;
    const accessor = { ...base.approval };
    Object.defineProperty(accessor, field, { get() { calls++; return 'valid'; } });
    reject('manifest', { ...base, approval: accessor }); assert.equal(calls, 0);
    const hidden = { ...base.approval }; Object.defineProperty(hidden, field, { enumerable: false });
    reject('manifest', { ...base, approval: hidden });
  }
  for (const approval of [[], Object.assign(Object.create(null), base.approval),
    { ...base.approval, extra: true }, { ...base.approval, [Symbol('extra')]: true }])
    reject('manifest', { ...base, approval });
  rejectJson('manifest', { ...base, approval: { ...base.approval, approverActorId: base.approval.executorActorId } });
  assert.ok(encode('manifest', { ...base, approval: { approvalRef: 'unverified', executorActorId: 'a', approverActorId: 'b' } }));
});

test('P5 refs preserve Unicode, lone surrogate escapes and exact UTF-16 length semantics', () => {
  for (const approvalRef of ['x'.repeat(255), '😀'.repeat(127) + 'x', '\ud800', '\udfff', '备份😀', 'é', 'e\u0301', '\u0080', '\uFEFF']) {
    const record = sample('manifest'); record.approval.approvalRef = approvalRef;
    assert.deepEqual(decode('manifest', encode('manifest', record)), record);
  }
  const record = sample('manifest'); record.approval.approvalRef = '😀'.repeat(128);
  rejectJson('manifest', record);
  const high = sample('manifest'); high.approval.approvalRef = '\ud800';
  assert.ok(encode('manifest', high).includes(raw('"approvalRef":"\\ud800"')));
  const alternate = encode('manifest', high).toString().replace('\\ud800', '\\uD800');
  assert.throws(() => decode('manifest', raw(alternate)), mismatch);
  const composed = sample('manifest'), decomposed = sample('manifest');
  composed.approval.approvalRef = 'é'; decomposed.approval.approvalRef = 'e\u0301';
  assert.notEqual(hash('manifest', composed), hash('manifest', decomposed));
  const literal = vectors[0].canonical;
  assert.throws(() => decode('manifest', raw(literal.replace('备', '\\u5907'))), mismatch);
  assert.throws(() => decode('manifest', raw(literal.replace('"approvalRef":', '"approvalRef":"ignored","approvalRef":'))), mismatch);
  const nestedOrder = sample('manifest'); nestedOrder.approval = Object.fromEntries(Object.entries(nestedOrder.approval).reverse());
  assert.throws(() => decode('manifest', raw(JSON.stringify(nestedOrder))), mismatch);
});

test('derived reference namespaces, version tags and nullability cannot mix generations', () => {
  const manifest = sample('manifest'), record = sample('record'), source = sample('source');
  for (const formatVersion of [1, 2, 4]) rejectJson('manifest', { ...manifest, formatVersion });
  for (const toolVersion of ['im-v2-backup-1', 'im-v2-backup-3', 'im-v2-backup-2\n']) rejectJson('manifest', { ...manifest, toolVersion });
  for (const recordVersion of [2, 3, 5]) rejectJson('record', { ...record, recordVersion });
  for (const publicationKind of ['native-v4', 'imported-registered-v3', 'native-v3', 'native-v5\n']) rejectJson('record', { ...record, publicationKind });
  for (const artifactReference of ['C:/backup.sqlite', '/tmp/backup.sqlite', '../backup.sqlite',
    record.artifactReference.replace('registry/', ''), record.artifactReference.replace('artifacts/', 'artifacts/../'),
    record.artifactReference.replaceAll('/', '\\'), record.artifactReference + '\n', record.artifactReference + '.sqlite',
    record.artifactReference.replace('11111111', '11111112')]) rejectJson('record', { ...record, artifactReference });
  for (const version of [1, 3]) rejectJson('source', { ...source, version });
  for (const registryFormat of [2, 3, 5]) rejectJson('source', { ...source, registryFormat });
  for (const kind of ['native-v5', 'registered-backup\n', 'imported-registered-v3']) rejectJson('source', { ...source, kind });
  for (const importedRecordHash of ['a'.repeat(64), '', 0]) rejectJson('source', { ...source, importedRecordHash });
  for (const sourceRef of [source.sourceRef + '\n', source.sourceRef.replace('backup:', 'backup:/'),
    source.sourceRef.replace('11111111', '11111112'), 'registry/artifacts/' + source.backupId + '.sqlite'])
    rejectJson('source', { ...source, sourceRef });
});

test('historical v4 encoders/decoders reject all new formats and C1 rejects historical controls', () => {
  for (const { kind, canonical } of vectors) {
    assert.throws(() => oldEncode(kind, sample(kind)), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
    assert.throws(() => oldDecode(kind, raw(canonical)), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
    const old = sample(kind); old.schemaVersion = 4;
    if (kind === 'manifest') { old.formatVersion = 2; old.toolVersion = 'im-v2-backup-1'; }
    if (kind === 'record') { old.recordVersion = 3; old.publicationKind = 'native-v4'; }
    if (kind === 'source') { old.version = 1; old.registryFormat = 3; }
    const bytes = oldEncode(kind, old);
    assert.deepEqual(oldDecode(kind, bytes), old);
    reject(kind, old); assert.throws(() => decode(kind, bytes), mismatch);
    if (kind !== 'manifest') {
      old.schemaVersion = 3;
      if (kind === 'record') old.publicationKind = 'imported-registered-v3';
      else { old.registryFormat = 2; old.importedRecordHash = 'b'.repeat(64); }
      assert.deepEqual(oldDecode(kind, oldEncode(kind, old)), old);
      rejectJson(kind, old);
    }
  }
});

test('fatal UTF-8 rejects overlong, truncated, invalid continuation and raw surrogate sequences', () => {
  const literal = vectors[0].canonical;
  const marker = raw('备'), bytes = raw(literal), offset = bytes.indexOf(marker);
  for (const sequence of [[0xc0,0xaf], [0xc2], [0xe2,0x28,0xa1], [0xed,0xa0,0x80], [0xf4,0x90,0x80,0x80], [0xff]])
    assert.throws(() => decode('manifest', Buffer.concat([bytes.subarray(0, offset), Buffer.from(sequence), bytes.subarray(offset + marker.length)])), mismatch);
  for (const text of ['', '{}', 'null', '[]', 'true', '3', '"text"', '{', literal + literal])
    assert.throws(() => decode('manifest', raw(text)), mismatch);
});

test('raw decoder byte cap: 65535/65536 malformed within limit reach JSON, 65537 oversize does not', () => {
  // Valid schemas cannot reach 64 KiB with bounded refs; padding is intentionally
  // noncanonical. Observe the parse boundary to distinguish cap from shape failure.
  const original = JSON.parse;
  let calls = 0;
  try {
    JSON.parse = (...args) => { calls++; return original(...args); };
    for (const length of [65535, 65536, 65537]) {
      const bytes = Buffer.alloc(length, 0x20); bytes.write('{}');
      const before = calls;
      assert.throws(() => decode('manifest', bytes), mismatch);
      assert.equal(calls - before, length <= 65536 ? 1 : 0);
    }
    const bytes = raw('"' + '备'.repeat(21845) + '"');
    assert.equal(bytes.length, 65537);
    const before = calls; assert.throws(() => decode('manifest', bytes), mismatch); assert.equal(calls, before);
  } finally { JSON.parse = original; }
});

test('invalid kind values never coerce or inspect Proxy traps', () => {
  let calls = 0;
  const poison = new Proxy({}, { get() { calls++; throw Error('foreign'); }, getOwnPropertyDescriptor() { calls++; throw Error('foreign'); } });
  for (const kind of ['', 'hold', 'Manifest', '__proto__', 'toString', 'constructor', null, 1, Symbol('manifest'), poison]) {
    reject(kind, sample('manifest'));
    assert.throws(() => decode(kind, raw(vectors[0].canonical)), mismatch);
  }
  assert.equal(calls, 0);
});

test('Proxies including revoked proxies, nested approvals, prototypes and scalar values run zero traps', () => {
  let calls = 0;
  const trap = () => { calls++; throw Error('must not run'); };
  const handler = Object.fromEntries(['get','set','getPrototypeOf','ownKeys','getOwnPropertyDescriptor','has','apply'].map(key => [key, trap]));
  const proxy = value => new Proxy(value, handler);
  const revoked = Proxy.revocable({}, handler); revoked.revoke();
  for (const { kind } of vectors) {
    reject(kind, proxy(sample(kind))); reject(kind, revoked.proxy);
    reject(kind, Object.setPrototypeOf(sample(kind), proxy({})));
    for (const field of Object.keys(sample(kind))) reject(kind, { ...sample(kind), [field]: proxy({}) });
    assert.throws(() => decode(kind, proxy(raw(vectors[0].canonical))), mismatch);
    assert.throws(() => decode(kind, revoked.proxy), mismatch);
  }
  reject('manifest', { ...sample('manifest'), approval: proxy(sample('manifest').approval) });
  for (const field of Object.keys(sample('manifest').approval)) {
    const record = sample('manifest'); record.approval[field] = proxy({}); reject('manifest', record);
  }
  assert.equal(calls, 0);
});

test('no caller coercion, toJSON or iterator callbacks are used', () => {
  let calls = 0;
  const poison = { valueOf() { calls++; return 1; }, toString() { calls++; return 'x'; }, toJSON() { calls++; return {}; } };
  for (const { kind } of vectors) {
    reject(kind, { ...sample(kind), toJSON: poison.toJSON });
    for (const field of Object.keys(sample(kind))) reject(kind, { ...sample(kind), [field]: poison });
  }
  const bytes = raw(vectors[0].canonical);
  Object.defineProperty(bytes, Symbol.iterator, { get() { calls++; throw Error('foreign'); } });
  assert.throws(() => decode('manifest', bytes), mismatch);
  assert.equal(calls, 0);
});

test('byte input rejects shared/detached memory, subclasses, extra fields and shadow getters without callbacks', () => {
  const canonical = raw(vectors[0].canonical);
  const shared = new SharedArrayBuffer(canonical.length), sharedBytes = new Uint8Array(shared); sharedBytes.set(canonical);
  const detached = new Uint8Array(canonical); structuredClone(detached.buffer, { transfer: [detached.buffer] });
  class Subclass extends Uint8Array {}
  for (const bytes of [sharedBytes, Buffer.from(shared), detached, new Subclass(canonical), canonical.buffer,
    new DataView(canonical.buffer), Array.from(canonical), vectors[0].canonical, null, 1])
    assert.throws(() => decode('manifest', bytes), mismatch);
  let calls = 0;
  for (const key of ['length','byteLength','buffer','byteOffset','toString', Symbol('extra')]) {
    const bytes = raw(vectors[0].canonical);
    Object.defineProperty(bytes, key, { get() { calls++; throw Error('foreign'); } });
    assert.throws(() => decode('manifest', bytes), mismatch);
  }
  assert.equal(calls, 0);
});

test('foreign exceptions cannot choose classification, leak causes or run error getters/Proxy traps', () => {
  let calls = 0;
  const foreign = {};
  for (const key of ['code','message','stack','cause']) Object.defineProperty(foreign, key, { get() { calls++; throw Error('leak'); } });
  const proxy = new Proxy({}, Object.fromEntries(['get','getPrototypeOf','ownKeys','getOwnPropertyDescriptor'].map(key => [key, () => { calls++; throw foreign; }])));
  const parse = JSON.parse, stringify = JSON.stringify;
  try {
    for (const exception of [foreign, proxy, { code: 'RECOVERY_INVALID', message: 'secret' }, undefined, 1]) {
      JSON.parse = () => { throw exception; };
      assert.throws(() => decode('manifest', raw(vectors[0].canonical)), mismatch);
      JSON.parse = parse;
      const record = sample('manifest');
      JSON.stringify = () => { throw exception; };
      reject('manifest', record);
      JSON.stringify = stringify;
    }
  } finally { JSON.parse = parse; JSON.stringify = stringify; }
  assert.equal(calls, 0);
  let first, second;
  try { encode('manifest', null); } catch (error) { first = error; }
  try { encode('manifest', null); } catch (error) { second = error; }
  assert.notEqual(first, second);
});
