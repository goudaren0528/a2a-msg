import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as api from '../src/im/v2/maintenance-v5-records.js';
import { vectors } from './fixtures/im-v2-maintenance-v5-records/vectors.js';

const { encodeMaintenanceV5Record: encode, decodeMaintenanceV5Record: decode, hashMaintenanceV5Record: hash } = api;
const INVALID = 'MAINTENANCE_CODEC_INVALID';
const LIMIT = 'MAINTENANCE_METADATA_LIMIT';
const H = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const U = '66666666-6666-4666-8666-666666666666';
const sample = kind => JSON.parse(vectors.find(vector => vector.kind === kind).canonical);
const raw = value => Buffer.from(JSON.stringify(value));
const rejects = (operation, code = INVALID) => assert.throws(operation, error => {
  assert.equal(error.code, code);
  assert.equal(error.message, 'Maintenance record rejected');
  assert.deepEqual(Object.keys(error), ['code']);
  return true;
});
const invalid = (kind, value) => {
  rejects(() => encode(kind, value));
  rejects(() => hash(kind, value));
  rejects(() => decode(kind, raw(value)));
};

// Independent explicit proposal table; never use the product encoder as an oracle.
function proposalFrom(anchor) {
  return {
    version: anchor.version, instanceId: anchor.instanceId, instanceCreatedAt: anchor.instanceCreatedAt,
    centerEpoch: anchor.centerEpoch, previousGeneration: anchor.previousGeneration,
    previousAnchorHash: anchor.previousAnchorHash, sessionNonce: anchor.sessionNonce,
    proposedAt: anchor.proposedAt, proposalExpiresAt: anchor.proposalExpiresAt,
    candidateWallAt: anchor.candidateWallAt, acceptNotBefore: anchor.acceptNotBefore,
    acceptNotAfter: anchor.acceptNotAfter, globalFloorObservedAt: anchor.globalFloorObservedAt,
    maxForwardJumpMs: anchor.maxForwardJumpMs,
  };
}
const proposalDigest = proposal => createHash('sha256').update('im-maintenance-time-proposal-v1\n').update(raw(proposal)).digest('hex');
const planDigest = plan => createHash('sha256').update('im-center-schema-conversion-plan-v1\n').update(raw(plan)).digest('hex');
const anchorWith = updates => {
  const anchor = { ...sample('anchorEvidence'), ...updates };
  anchor.proposalHash = proposalDigest(proposalFrom(anchor));
  return anchor;
};
const reverse = value => Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, item && typeof item === 'object' ? reverse(item) : item]));

test('public API has exactly three synchronous pure helpers', () => {
  assert.deepEqual(Object.keys(api).sort(), ['decodeMaintenanceV5Record','encodeMaintenanceV5Record','hashMaintenanceV5Record']);
});

for (const vector of vectors) {
  test(`${vector.kind}: independent full bytes, fixed newline-domain hash and canonical order`, () => {
    const value = JSON.parse(vector.canonical);
    assert.equal(encode(vector.kind, value).toString('utf8'), vector.canonical);
    assert.equal(hash(vector.kind, value), vector.hash);
    assert.deepEqual(decode(vector.kind, Buffer.from(vector.canonical)), value);
    assert.deepEqual(decode(vector.kind, new Uint8Array(Buffer.from(vector.canonical))), value);
    assert.equal(encode(vector.kind, reverse(value)).toString('utf8'), vector.canonical);
    assert.equal(hash(vector.kind, reverse(value)), vector.hash);
    rejects(() => decode(vector.kind, raw(reverse(value))));
  });

  test(`${vector.kind}: detached deeply frozen output and independently owned buffers`, () => {
    const input = JSON.parse(vector.canonical);
    const first = encode(vector.kind, input);
    const second = encode(vector.kind, input);
    assert.notEqual(first.buffer, second.buffer);
    assert.equal(first.byteOffset, 0);
    assert.equal(first.buffer.byteLength, first.byteLength);
    first.fill(0);
    assert.equal(second.toString(), vector.canonical);
    const decoded = decode(vector.kind, second);
    second.fill(0);
    assert.deepEqual(decoded, JSON.parse(vector.canonical));
    assert.notEqual(decoded, input);
    assert.ok(Object.isFrozen(decoded));
    assert.throws(() => { decoded.version = 2; }, TypeError);
    assert.equal(Object.isFrozen(input), false);
    if (decoded.plan) {
      assert.ok(Object.isFrozen(decoded.plan));
      assert.notEqual(decoded.plan, input.plan);
      input.plan.preparationRef = 'mutated';
      assert.equal(decoded.plan.preparationRef, 'prepare/初期');
      assert.throws(() => { decoded.plan.createdAt = 0; }, TypeError);
    }
  });

  test(`${vector.kind}: every missing field and every nonnullable NULL rejects`, () => {
    const value = JSON.parse(vector.canonical);
    for (const field of Object.keys(value)) {
      const missing = { ...value }; delete missing[field];
      invalid(vector.kind, missing);
      if (value[field] !== null) invalid(vector.kind, { ...value, [field]: null });
    }
    for (const extra of ['constructor','__proto__','authority','target','timestamp','anchorHash']) {
      invalid(vector.kind, Object.fromEntries([...Object.entries(value), [extra, 'extension']]));
    }
    invalid(vector.kind, { ...value, version: 2 });
    invalid(vector.kind, { ...value, version: '1' });
  });

  test(`${vector.kind}: strict canonical lexical bytes, duplicates and escaped aliases`, () => {
    const text = vector.canonical;
    const noncanonical = [
      ` ${text}`, `${text}\n`, `${text} `, `\uFEFF${text}`, text.replace('{', '{\n'),
      text.replace('"version":1', '"version":1.0'), text.replace('"version":1', '"version":1e0'),
      text.replace('"version":1', '"version":1,"version":1'),
      text.replace('"version":1', '"version":1,"\\u0076ersion":1'),
      text.replace('"version"', '"\\u0076ersion"'),
      text.replace('"version":1', '"version":0,"version":1'),
      text.replace('"version":1', '"version":+1'), `${text}{}`, text.slice(0, -1),
    ];
    for (const candidate of noncanonical) rejects(() => decode(vector.kind, Buffer.from(candidate)));
    for (const malformed of [Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf4, 0x90, 0x80, 0x80]), Buffer.from([0xe4, 0xb8])]) {
      rejects(() => decode(vector.kind, Buffer.concat([Buffer.from(text), malformed])));
    }
  });
}

test('strict numeric, UUID, SHA and Ref scalar matrix', () => {
  const plan = sample('conversionPlan');
  for (const value of [-0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '100', true, undefined, 1n, new Number(1)]) {
    rejects(() => encode('conversionPlan', { ...plan, instanceCreatedAt: value }));
    rejects(() => hash('conversionPlan', { ...plan, instanceCreatedAt: value }));
  }
  for (const value of [U.toUpperCase().replace('6', 'A'), U.replaceAll('-', ''), `${U}\n`, ` ${U}`, 1, {}, '00000000-0000-0000-0000-00000000000g']) invalid('conversionPlan', { ...plan, instanceId: value });
  for (const value of [H.toUpperCase(), H.slice(1), `${H}0`, `${H}\n`, 1, {}, 'g'.repeat(64)]) invalid('conversionPlan', { ...plan, fromChecksum: value });
  for (const value of ['', 'a'.repeat(256), '\0', 'a\nb', 'a\rb', 'a\tb', '\x1f', '\x7f', '\ud800', '\udfff', '\ud800x', 1, {}]) invalid('conversionPlan', { ...plan, preparationRef: value });
  for (const preparationRef of ['a', '汉'.repeat(255), '😀'.repeat(127), 'e\u0301', 'é', '"\\']) {
    const value = { ...plan, preparationRef };
    assert.deepEqual(decode('conversionPlan', encode('conversionPlan', value)), value);
  }
  assert.notEqual(hash('conversionPlan', { ...plan, preparationRef: 'e\u0301' }), hash('conversionPlan', { ...plan, preparationRef: 'é' }));
  rejects(() => decode('conversionPlan', Buffer.from(vectors[2].canonical.replace('初期', '\\u521d\\u671f'))));
  rejects(() => decode('conversionPlan', Buffer.from(vectors[2].canonical.replace('"instanceCreatedAt":100', '"instanceCreatedAt":-0'))));
});

test('proposal pairs, actual sample equalities, TTL/window limits and safe addition', () => {
  const p = sample('timeProposal');
  for (const update of [
    { previousGeneration: 1 }, { previousAnchorHash: H }, { previousGeneration: 0, previousAnchorHash: H },
    { previousGeneration: -0, previousAnchorHash: H }, { proposedAt: 1001 }, { candidateWallAt: 1001 },
    { acceptNotBefore: 1001 }, { proposalExpiresAt: 1000 }, { proposalExpiresAt: 999 },
    { proposalExpiresAt: 301001 }, { acceptNotAfter: 1000 }, { acceptNotAfter: 999 },
    { acceptNotAfter: 6001 }, { maxForwardJumpMs: 0 }, { maxForwardJumpMs: 86400001 },
  ]) invalid('timeProposal', { ...p, ...update });
  for (const update of [
    { previousGeneration: Number.MAX_SAFE_INTEGER, previousAnchorHash: H },
    { maxForwardJumpMs: 1 }, { proposalExpiresAt: 1001, acceptNotAfter: 1001 },
    { proposedAt: 0, candidateWallAt: 0, acceptNotBefore: 0, proposalExpiresAt: 1, acceptNotAfter: 1, globalFloorObservedAt: 0 },
  ]) assert.ok(encode('timeProposal', { ...p, ...update }));
  const max = Number.MAX_SAFE_INTEGER;
  const nearMax = { ...p, proposedAt: max - 1, candidateWallAt: max - 1, acceptNotBefore: max - 1, proposalExpiresAt: max, acceptNotAfter: max };
  assert.ok(encode('timeProposal', nearMax));
  invalid('timeProposal', { ...nearMax, proposalExpiresAt: max + 1 });
  invalid('timeProposal', { ...nearMax, acceptNotAfter: max + 1 });
});

test('anchor first/successor/cross-epoch local shapes and exact proposal reconstruction', () => {
  const first = sample('anchorEvidence');
  assert.deepEqual(proposalFrom(first), sample('timeProposal'));
  assert.equal(proposalDigest(proposalFrom(first)), vectors[0].hash);
  for (const centerEpoch of [first.centerEpoch, U]) {
    const successor = anchorWith({ generation: 2, previousGeneration: 1, previousAnchorHash: vectors[1].hash, centerEpoch });
    assert.deepEqual(decode('anchorEvidence', encode('anchorEvidence', successor)), successor);
  }
  for (const update of [
    { generation: 0 }, { generation: 2 }, { generation: 1, previousGeneration: 1, previousAnchorHash: H },
    { generation: 3, previousGeneration: 1, previousAnchorHash: H },
    { generation: 2, previousGeneration: 3, previousAnchorHash: H },
    { generation: Number.MAX_SAFE_INTEGER + 1, previousGeneration: Number.MAX_SAFE_INTEGER, previousAnchorHash: H },
    { generation: Number.MAX_SAFE_INTEGER, previousGeneration: Number.MAX_SAFE_INTEGER, previousAnchorHash: H },
    { acceptedWallAt: 999 }, { acceptedWallAt: 6001 }, { globalFloorAtApproval: 899 },
    { globalFloorAtApproval: 1501 }, { executorId: first.approverId },
  ]) invalid('anchorEvidence', anchorWith(update));
  assert.ok(encode('anchorEvidence', anchorWith({ generation: Number.MAX_SAFE_INTEGER, previousGeneration: Number.MAX_SAFE_INTEGER - 1, previousAnchorHash: H })));
  assert.ok(encode('anchorEvidence', anchorWith({ acceptedWallAt: 1000, globalFloorAtApproval: 1000 })));
  assert.ok(encode('anchorEvidence', anchorWith({ acceptedWallAt: 6000 })));
  assert.ok(encode('anchorEvidence', anchorWith({ acceptedWallAt: 1500, proposalExpiresAt: 1501 })));
  invalid('anchorEvidence', anchorWith({ acceptedWallAt: 1500, proposalExpiresAt: 1500 }));
  invalid('anchorEvidence', { ...first, globalFloorObservedAt: first.globalFloorAtApproval });
  invalid('anchorEvidence', { ...first, proposalHash: H });
  invalid('anchorEvidence', { ...first, instanceId: U });
  invalid('anchorEvidence', { ...first, sessionNonce: U });
  // Caller hashes cannot prove the actual predecessor, historical epoch or DB identity.
  assert.ok(encode('anchorEvidence', anchorWith({ generation: 2, previousGeneration: 1, previousAnchorHash: H, instanceId: U, centerEpoch: U })));
});

test('all three conversion shapes, precise nullability and derived candidate reference', () => {
  const plan = sample('conversionPlan');
  for (const candidateKind of ['fresh_bootstrap','v3_import','snapshot_recovery']) {
    for (const preparationRef of [null, 'prep']) for (const sourceEvidenceHash of [null, H]) {
      const value = { ...plan, candidateKind, preparationRef, sourceEvidenceHash };
      const valid = candidateKind === 'fresh_bootstrap' ? preparationRef !== null && sourceEvidenceHash === null
        : candidateKind === 'v3_import' ? preparationRef !== null && sourceEvidenceHash !== null
          : preparationRef === null && sourceEvidenceHash !== null;
      if (!valid) invalid('conversionPlan', value);
      else {
        assert.deepEqual(decode('conversionPlan', encode('conversionPlan', value)), value);
        const proof = { ...sample('conversionProof'), plan: value, planHash: planDigest(value) };
        assert.deepEqual(decode('conversionProof', encode('conversionProof', proof)), proof);
      }
    }
  }
  for (const candidateKind of ['fresh','snapshot', '', null, {}]) invalid('conversionPlan', { ...plan, candidateKind });
  for (const kind of ['conversionPlan','conversionComplete']) {
    for (const candidateReference of ['/tmp/candidate.sqlite','D:\\candidate.sqlite', '../candidate.sqlite', 'runs/../candidate.sqlite', `runs/${U}/candidate.sqlite`, `${plan.candidateReference}/`, plan.candidateReference.replaceAll('/', '\\')]) invalid(kind, { ...sample(kind), candidateReference });
  }
  for (const update of [{ fromVersion: 5 }, { toVersion: 4 }, { expiresAt: 2000 }, { expiresAt: 1999 }, { expiresAt: 302001 }]) invalid('conversionPlan', { ...plan, ...update });
  assert.ok(encode('conversionPlan', { ...plan, expiresAt: 2001 }));
  assert.ok(encode('conversionPlan', { ...plan, createdAt: Number.MAX_SAFE_INTEGER - 1, expiresAt: Number.MAX_SAFE_INTEGER }));
  invalid('conversionPlan', { ...plan, createdAt: Number.MAX_SAFE_INTEGER, expiresAt: Number.MAX_SAFE_INTEGER + 1 });
  // Checksums are H syntax here. Exact V4/V5 manifest pairs belong to the schema validator.
  assert.ok(encode('conversionPlan', { ...plan, fromChecksum: H, toChecksum: H }));
  assert.ok(encode('conversionComplete', { ...sample('conversionComplete'), schemaChecksum: H, conversionProofHash: H, postconversionFileHash: H }));
  invalid('conversionComplete', { ...sample('conversionComplete'), schemaVersion: 4 });
});

test('conversion proof nested hash, distinct actors and inclusive-start/strict-expiry', () => {
  const proof = sample('conversionProof');
  for (const update of [{ planHash: H }, { convertedAt: 1999 }, { convertedAt: 302000 }, { executorId: proof.approverId }]) invalid('conversionProof', { ...proof, ...update });
  assert.ok(encode('conversionProof', { ...proof, convertedAt: 301999 }));
  invalid('conversionProof', { ...proof, plan: { ...proof.plan, createdAt: 2001 } });
  invalid('conversionProof', { ...proof, plan: { ...proof.plan, sourceEvidenceHash: H } });
  for (const field of Object.keys(proof.plan)) {
    const plan = { ...proof.plan }; delete plan[field];
    invalid('conversionProof', { ...proof, plan });
  }
  rejects(() => decode('conversionProof', Buffer.from(vectors[3].canonical.replace('"plan":{"version":1', '"plan":{"version":1,"version":1'))));
  rejects(() => decode('conversionProof', Buffer.from(vectors[3].canonical.replace('"plan":{"version":1', '"plan":{"version":1,"\\u0076ersion":1'))));
});

test('ordinary data only; no accessors, Symbols, hidden fields or coercion hooks run', () => {
  let called = 0;
  const attack = () => { called++; throw new Error('SECRET'); };
  const plan = sample('conversionPlan');
  for (const value of [null, [], new Date(), Object.create(null), Object.create(plan), new (class Plan {})()]) {
    rejects(() => encode('conversionPlan', value));
    rejects(() => hash('conversionPlan', value));
  }
  for (const field of Object.keys(plan)) {
    const value = { ...plan };
    Object.defineProperty(value, field, { enumerable: true, get: attack });
    rejects(() => encode('conversionPlan', value));
    rejects(() => hash('conversionPlan', value));
  }
  for (const key of [Symbol('secret'), 'secret', 'toJSON']) {
    const value = { ...plan };
    Object.defineProperty(value, key, { get: attack, enumerable: false });
    rejects(() => encode('conversionPlan', value));
  }
  const hidden = { ...plan };
  Object.defineProperty(hidden, 'version', { value: 1, enumerable: false });
  rejects(() => encode('conversionPlan', hidden));
  const hostileScalar = { toString: attack, valueOf: attack, [Symbol.toPrimitive]: attack };
  for (const field of Object.keys(plan)) rejects(() => encode('conversionPlan', { ...plan, [field]: hostileScalar }));
  assert.equal(called, 0);
});

test('all Proxy inputs rejected before any reflection, including revoked and nested proxies', () => {
  let traps = 0;
  const trap = () => { traps++; throw new Error('SECRET'); };
  const handler = { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, has: trap };
  const plan = sample('conversionPlan');
  const proxy = new Proxy(plan, handler);
  const revoked = Proxy.revocable(plan, handler); revoked.revoke();
  for (const value of [proxy, revoked.proxy]) {
    rejects(() => encode('conversionPlan', value));
    rejects(() => hash('conversionPlan', value));
    rejects(() => encode('conversionProof', { ...sample('conversionProof'), plan: value }));
  }
  rejects(() => decode('conversionPlan', new Proxy(Buffer.from(vectors[2].canonical), handler)));
  rejects(() => encode(proxy, plan));
  rejects(() => hash(proxy, plan));
  rejects(() => decode(proxy, Buffer.from(vectors[2].canonical)));
  rejects(() => encode('conversionPlan', { ...plan, preparationRef: proxy }));
  assert.equal(traps, 0);
});

test('byte input ownership and hostile property guards', () => {
  let calls = 0;
  const poison = () => { calls++; throw new Error('SECRET'); };
  for (const field of ['buffer','byteLength','length', Symbol.iterator]) {
    const value = Buffer.from(vectors[0].canonical);
    Object.defineProperty(value, field, { get: poison });
    rejects(() => decode('timeProposal', value));
  }
  const badInputs = [vectors[0].canonical, null, [], new ArrayBuffer(1), new DataView(new ArrayBuffer(1)), new Uint16Array(1), new Uint8Array(new SharedArrayBuffer(1)), new (class Bytes extends Uint8Array {})()];
  for (const value of badInputs) rejects(() => decode('timeProposal', value));
  const detached = new Uint8Array(10);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  rejects(() => decode('timeProposal', detached));
  const surrounding = Buffer.concat([Buffer.from('prefix'), Buffer.from(vectors[0].canonical), Buffer.from('suffix')]);
  assert.deepEqual(decode('timeProposal', surrounding.subarray(6, -6)), sample('timeProposal'));
  assert.equal(calls, 0);
});

test('foreign errors cannot spoof internal identity or expose hostile properties', t => {
  let reads = 0;
  const foreign = {};
  for (const key of ['code','message','stack']) Object.defineProperty(foreign, key, { get() { reads++; throw new Error('SECRET'); } });
  const proxy = new Proxy(foreign, { get() { reads++; throw new Error('SECRET'); }, getPrototypeOf() { reads++; throw new Error('SECRET'); } });
  for (const error of [foreign, proxy, { code: LIMIT, message: 'SECRET' }, null, 'SECRET']) {
    const mock = t.mock.method(JSON, 'parse', () => { throw error; });
    rejects(() => decode('timeProposal', Buffer.from(vectors[0].canonical)));
    mock.mock.restore();
  }
  assert.equal(reads, 0);
});

test('65536 UTF-8 byte ceiling applies to entire raw input before parsing', () => {
  // Fixed field/Ref bounds make a valid 64 KiB record impossible. Exercise the
  // independent raw-input ceiling using padded invalid records, including nesting.
  for (const vector of [vectors[0], vectors[3]]) {
    const length = Buffer.byteLength(vector.canonical);
    for (const total of [65535, 65536, 65537]) {
      const bytes = Buffer.concat([Buffer.from(vector.canonical), Buffer.alloc(total - length, 0x20)]);
      rejects(() => decode(vector.kind, bytes), total > 65536 ? LIMIT : INVALID);
    }
  }
  const multibyte = Buffer.from('汉'.repeat(21846));
  assert.equal(multibyte.length, 65538);
  assert.ok('汉'.repeat(21846).length < 65536);
  rejects(() => decode('conversionProof', multibyte), LIMIT);
});

test('UTF-8 scalar bytes are preserved without normalization or replacement decoding', () => {
  const value = { ...sample('conversionPlan'), preparationRef: 'a�😀é汉z' };
  const bytes = encode('conversionPlan', value);
  assert.deepEqual(decode('conversionPlan', bytes), value);
  const index = bytes.indexOf(Buffer.from('�'));
  for (const malformed of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xe4, 0xb8])]) {
    rejects(() => decode('conversionPlan', Buffer.concat([bytes.subarray(0, index), malformed, bytes.subarray(index + 3)])));
  }
  rejects(() => decode('conversionPlan', Buffer.from(JSON.stringify(value).replace('a�😀é汉z', '\\ud800'))));
});

test('only the five exact kind strings are admitted without coercion', () => {
  for (const kind of [undefined, null, '', 'constructor', '__proto__', 'toString', 'timeproposal', 'maintenancePlan', new String('timeProposal'), 1, Symbol('timeProposal')]) {
    rejects(() => encode(kind, sample('timeProposal')));
    rejects(() => hash(kind, sample('timeProposal')));
    rejects(() => decode(kind, Buffer.from(vectors[0].canonical)));
  }
});
