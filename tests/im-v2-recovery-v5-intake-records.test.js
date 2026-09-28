// C2-A independent vectors/consistency tests. No filesystem protection, registry,
// provenance, restoration, authorization or recovery-runtime claim is made here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as api from '../src/im/v2/recovery-v5-intake-records.js';
import { encodeRecoveryRecord, hashRecoveryRecord } from '../src/im/v2/recovery-plan.js';
import { encodeRecoveryConversionRecord, hashRecoveryConversionRecord } from '../src/im/v2/recovery-conversion-records.js';
import { encodeMaintenanceV5Record, hashMaintenanceV5Record } from '../src/im/v2/maintenance-v5-records.js';
import { encodeImV5BackupRecord, hashImV5BackupRecord } from '../src/im/v2/backup-v5-records.js';
import { canonical as canonicalHold } from '../src/im/v2/recovery-records.js';
import { V3_CHECKSUM } from '../src/im/v2/schema-history.js';
import { V4_CHECKSUM } from '../src/im/v2/schema-internal.js';
import { V5_CHECKSUM } from '../src/im/v2/schema-v5-internal.js';
import { FIELDS, NEW_KINDS, V3, V4, V5, clone, text, prefix, digest, rawHash,
  sourceKind, fromVector, rehashArchive, assertHashGraph, assertArchiveGraph, assertIntakeGraph,
} from './fixtures/im-v2-recovery-v5-intake-records/oracle.js';

const { encodeRecoveryV5IntakeRecord: encode, decodeRecoveryV5IntakeRecord: decode,
  hashRecoveryV5IntakeRecord: hash, validateRecoveryV5ArchiveBindings: archive,
  validateRecoveryV5IntakeBindings: intake } = api;
const vectors = JSON.parse(readFileSync(new URL('./fixtures/im-v2-recovery-v5-intake-records/vectors.json', import.meta.url), 'utf8'));
const records = vectors.flatMap(v => Object.values(v.records).filter(r => r && NEW_KINDS.includes(r.kind)).map(r => ({ ...r, routeName: v.name })));
const vector = name => vectors.find(v => v.name === name);
const bundle = name => fromVector(vector(name));
const sample = (kind, name = kind === 'nativeIntake' ? 'native5' : 'fresh') => JSON.parse(Object.values(vector(name).records).find(r => r?.kind === kind).canonical);
const B = text => Buffer.from(text, 'utf8');
const U = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const H = 'fedcba9876543210'.repeat(4);
const INVALID = 'RECOVERY_INVALID', MISMATCH = 'RECOVERY_EVIDENCE_MISMATCH';
const reverse = value => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverse(child)])) : value;

function rejects(operation, code = MISMATCH) {
  // A caught flag is essential: `throw undefined` must never count as no throw.
  let caught = false, error;
  try { operation(); } catch (value) { caught = true; error = value; }
  assert.equal(caught, true, `expected ${code}`);
  assert.ok(error instanceof Error, 'fresh safe Error, not foreign thrown value');
  assert.equal(Object.getPrototypeOf(error), Error.prototype);
  assert.equal(error.code, code); assert.equal(error.message, code);
  assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ['code', 'message', 'stack']);
  assert.deepEqual(Object.getOwnPropertySymbols(error), []);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return error;
}
function rejectRecord(kind, value) {
  const first = rejects(() => encode(kind, value), INVALID);
  const second = rejects(() => hash(kind, value), INVALID);
  assert.notEqual(first, second);
}
function rejectJson(kind, value) {
  rejectRecord(kind, value);
  rejects(() => decode(kind, B(JSON.stringify(value))));
}
function accepted(kind, value) {
  const expected = text(kind, value);
  assert.equal(encode(kind, value).toString('utf8'), expected);
  assert.equal(hash(kind, value), digest(kind, value));
  assert.deepEqual(decode(kind, B(expected)), value);
}
function frozenDetached(output, input) {
  assert.notEqual(output, input); assert.ok(Object.isFrozen(output));
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  for (const key of Object.keys(output)) if (output[key] !== null && typeof output[key] === 'object') frozenDetached(output[key], input[key]);
}
function at(root, path) { return path.split('.').reduce((value, key) => value[key], root); }
function set(root, path, value) {
  const keys = path.split('.'), key = keys.pop();
  const parent = keys.reduce((value, part) => value[part], root);
  parent[key] = value;
}
function syncConverted(b) {
  const a = b.archiveEvidence.archiveIntent, h = b.archiveEvidence.handoff;
  b.intake.handoffHash = digest('conversionHandoff', h);
  b.intake.archiveIntentHash = digest('archiveIntent', a);
  b.intake.sourceEvidenceHash = a.sourceEvidenceHash;
  b.sourceEvidence = clone(b.archiveEvidence.legacyStage.sourceEvidence);
  return b;
}

test('C2-A exact five functions, exact frozen checksum authorities, five literal routes', () => {
  assert.deepEqual(Object.keys(api).sort(), ['decodeRecoveryV5IntakeRecord', 'encodeRecoveryV5IntakeRecord', 'hashRecoveryV5IntakeRecord', 'validateRecoveryV5ArchiveBindings', 'validateRecoveryV5IntakeBindings']);
  for (const fn of Object.values(api)) assert.equal(typeof fn, 'function');
  assert.deepEqual([V3_CHECKSUM, V4_CHECKSUM, V5_CHECKSUM], [V3, V4, V5]);
  assert.deepEqual(vectors.map(v => v.name), ['native5', 'fresh', 'closed3', 'registered3', 'registered4']);
  assert.equal(records.length, 13);
});

test('51 literal historical/new preimages independently check; historical codecs are secondary only', () => {
  let count = 0;
  for (const v of vectors) {
    assertIntakeGraph(fromVector(v));
    for (const r of Object.values(v.records).filter(Boolean)) {
      count++;
      const value = JSON.parse(r.canonical);
      assert.equal(text(r.kind, value), r.canonical);
      assert.equal(r.prefix, prefix(r.kind));
      assert.equal(rawHash(B(r.prefix + r.canonical)), r.sha256);
      if (NEW_KINDS.includes(r.kind)) continue;
      let encoded, hashed;
      if (['stage', 'staged', 'registeredSourceEvidence', 'closedSourceEvidence'].includes(r.kind)) {
        encoded = encodeRecoveryRecord(r.kind, value); hashed = hashRecoveryRecord(r.kind, value);
      } else if (['owner', 'pauseIntent', 'paused'].includes(r.kind)) {
        encoded = encodeRecoveryConversionRecord(r.kind, value); hashed = hashRecoveryConversionRecord(r.kind, value);
      } else if (r.kind === 'source') {
        encoded = encodeImV5BackupRecord('source', value); hashed = hashImV5BackupRecord('source', value);
      } else if (r.kind === 'hold') {
        encoded = canonicalHold('hold', value); hashed = rawHash(encoded);
      } else {
        encoded = encodeMaintenanceV5Record(r.kind, value); hashed = hashMaintenanceV5Record(r.kind, value);
      }
      assert.equal(Buffer.from(encoded).toString('utf8'), r.canonical);
      assert.equal(hashed, r.sha256);
    }
  }
  assert.equal(count, 51);
});

for (const r of records) {
  test(`${r.routeName}/${r.kind}: literal bytes/hash, insertion independence, domains and owned output`, () => {
    const value = JSON.parse(r.canonical), before = clone(value);
    assert.deepEqual(Object.keys(value), FIELDS[r.kind]);
    const first = encode(r.kind, value), second = encode(r.kind, reverse(value));
    for (const bytes of [first, second]) {
      assert.ok(Buffer.isBuffer(bytes)); assert.equal(Object.getPrototypeOf(bytes), Buffer.prototype);
      assert.equal(bytes.toString('utf8'), r.canonical); assert.equal(bytes.byteOffset, 0);
      assert.equal(bytes.buffer.byteLength, bytes.byteLength);
    }
    assert.notEqual(first.buffer, second.buffer);
    assert.equal(hash(r.kind, reverse(value)), r.sha256);
    assert.equal(digest(r.kind, value), r.sha256);
    for (const wrongPrefix of ['', prefix(r.kind).replace('\n', '\0'), prefix(r.kind) + '\n', 'a2a-msg.im.v2/recovery-v5/wrong\n']) assert.notEqual(rawHash(B(wrongPrefix + r.canonical)), r.sha256);
    const result = decode(r.kind, first);
    assert.deepEqual(result, value); frozenDetached(result, value);
    assert.deepEqual(value, before); assert.equal(Object.isFrozen(value), false);
    first.fill(0); value.version = 9;
    if (value.sourceEvidence) value.sourceEvidence.completedAt++;
    assert.deepEqual(result, before); assert.equal(second.toString(), r.canonical);
    assert.throws(() => { result.version = 2; }, TypeError);
    const padded = Buffer.concat([B('xx'), second, B('yy')]);
    assert.deepEqual(decode(r.kind, padded.subarray(2, -2)), before);
    assert.deepEqual(decode(r.kind, new Uint8Array(second)), before);
  });
}

for (const kind of NEW_KINDS) {
  test(`${kind}: exact fields/nulls, symbols/hidden/accessors/exotics, malformed primitive types`, () => {
    const base = sample(kind);
    let reads = 0;
    const trap = () => { reads++; throw undefined; };
    for (const key of Object.keys(base)) {
      const missing = clone(base); delete missing[key]; rejectJson(kind, missing);
      rejectRecord(kind, { ...base, [key]: undefined });
      if (base[key] !== null) rejectJson(kind, { ...base, [key]: null });
      const hidden = clone(base); Object.defineProperty(hidden, key, { enumerable: false }); rejectRecord(kind, hidden);
      const accessor = clone(base); Object.defineProperty(accessor, key, { get: trap }); rejectRecord(kind, accessor);
      const setter = clone(base); Object.defineProperty(setter, key, { set: trap }); rejectRecord(kind, setter);
      for (const value of [{ toJSON: trap, valueOf: trap, [Symbol.toPrimitive]: trap }, [], true, 1n, Symbol('bad')]) rejectRecord(kind, { ...base, [key]: value });
    }
    for (const key of ['unknown', '__proto__', 'toJSON', 'then', Symbol('secret')]) {
      const extra = clone(base); Object.defineProperty(extra, key, { get: trap }); rejectRecord(kind, extra);
    }
    for (const value of [null, undefined, [], new Date(0), new Map(), Object.assign(Object.create(null), base), Object.assign(Object.create({}), base)]) rejectRecord(kind, value);
    rejectJson(kind, { ...base, version: 2 });
    assert.equal(reads, 0);
  });

  test(`${kind}: canonical lexical decoder rejects duplicate/escaped alias/order/number/BOM/whitespace`, () => {
    const canonical = text(kind, sample(kind));
    const variants = [
      '', '{}', 'null', '[]', 'true', '1', '"string"', '{', canonical.slice(0, -1),
      ` ${canonical}`, `${canonical} `, `${canonical}\n`, `\ufeff${canonical}`, `${canonical}{}`, `${canonical}null`,
      JSON.stringify(reverse(sample(kind))), canonical.replace(':', ': '),
      canonical.replace('"version":1', '"version":1,"version":1'),
      canonical.replace('"version":1', '"version":1,"\\u0076ersion":1'),
      canonical.replace('"version":1', '"\\u0076ersion":1'),
      canonical.replace('"version":1', '"version":1.0'), canonical.replace('"version":1', '"version":1e0'),
      canonical.replace('"instanceCreatedAt":100', '"instanceCreatedAt":-0'),
      canonical.replace('"instanceCreatedAt":100', '"instanceCreatedAt":1e2'),
      canonical.replace('"instanceCreatedAt":100', '"instanceCreatedAt":1e400'),
      canonical.replace('candidate.sqlite', '\\u0063andidate.sqlite'),
    ];
    for (const value of variants) rejects(() => decode(kind, B(value)));
  });

  test(`${kind}: safe integer, UUID/hash/checksum and exact derived paths`, () => {
    const base = sample(kind);
    for (const key of Object.keys(base).filter(k => /At$|Counter$/.test(k))) {
      for (const value of [-0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '0', new Number(0)]) rejectRecord(kind, { ...base, [key]: value });
    }
    for (const [key, original] of Object.entries(base)) {
      if (typeof original !== 'string' || ![36, 64].includes(original.length)) continue;
      for (const value of ['', original.slice(1), original + '0', original + '\n', 'G' + original.slice(1)]) rejectJson(kind, { ...base, [key]: value });
    }
    for (const key of ['sourceSchemaChecksum', 'targetSchemaChecksum'].filter(k => base[k] !== undefined && base[k] !== null)) rejectJson(kind, { ...base, [key]: H });
    for (const key of ['candidateReference', 'archiveReference'].filter(k => base[k] !== undefined)) {
      for (const value of [base[key].replaceAll('/', '\\'), '/' + base[key], 'D:/' + base[key], '../candidate.sqlite', base[key].replace(base.runId, U), base[key].replace('runs/', 'v5-runs/'), base[key] + '/', base[key].replace('candidate', '%63andidate')]) {
        if (value !== base[key]) rejectJson(kind, { ...base, [key]: value });
      }
    }
  });
}

test('strict native nested source keys, tags, nulls, independent local field relations', () => {
  const base = sample('nativeIntake');
  for (const key of Object.keys(base.sourceEvidence)) {
    for (const mode of ['missing', 'undefined', 'hidden', 'accessor']) {
      const value = clone(base);
      if (mode === 'missing') delete value.sourceEvidence[key];
      if (mode === 'undefined') value.sourceEvidence[key] = undefined;
      if (mode === 'hidden') Object.defineProperty(value.sourceEvidence, key, { enumerable: false });
      if (mode === 'accessor') Object.defineProperty(value.sourceEvidence, key, { get() { assert.fail('nested getter invoked'); } });
      rejectRecord('nativeIntake', value);
    }
  }
  for (const [path, value] of [
    ['sourceEvidence.version', 1], ['sourceEvidence.registryFormat', 3], ['sourceEvidence.registryFormat', 2],
    ['sourceEvidence.schemaVersion', 4], ['sourceEvidence.schemaChecksum', V4], ['sourceEvidence.importedRecordHash', H],
    ['sourceEvidence.kind', 'closed-source'], ['sourceEvidence.sourceRef', 'backup:' + U],
    ['sourceRef', 'backup:' + U], ['sourceSchemaVersion', 4], ['targetSchemaVersion', 4],
    ['sourceSchemaChecksum', V4], ['holdId', null], ['instanceId', U], ['instanceCreatedAt', 101],
    ['candidateInitialHash', H], ['sourceEvidenceHash', H], ['route', 'converted-v4'],
  ]) { const valueRecord = clone(base); set(valueRecord, path, value); rejectJson('nativeIntake', valueRecord); }
  for (const key of ['extra', Symbol('extra')]) rejectRecord('nativeIntake', { ...base, sourceEvidence: { ...base.sourceEvidence, [key]: 1 } });
  const literal = text('nativeIntake', base);
  for (const changed of [
    literal.replace('"sourceEvidence":{"version":2', '"sourceEvidence":{"version":2,"version":2'),
    literal.replace('"sourceEvidence":{"version":2', '"sourceEvidence":{"version":2,"\\u0076ersion":2'),
    literal.replace('"sourceEvidence":{"version":2', '"sourceEvidence":{"version":2.0'),
    JSON.stringify({ ...base, sourceEvidence: reverse(base.sourceEvidence) }),
  ]) rejects(() => decode('nativeIntake', B(changed)));
});

test('P5 Ref UTF16/lone-surrogate rules preserved; embedded maintenance keeps well-formed restriction', () => {
  for (const preparationRef of ['a', '中'.repeat(255), '😀'.repeat(127) + 'x', '\ud800', '\udfff', '\u0080', '\ufeff', 'é', 'e\u0301', 'quote"back\\slash']) {
    for (const kind of ['archiveIntent', 'convertedIntake']) accepted(kind, { ...sample(kind), preparationRef });
  }
  for (const preparationRef of ['', 'x'.repeat(256), '😀'.repeat(128), '\0', '\x01', '\x1f', '\x7f', 'line\nbreak']) rejectJson('archiveIntent', { ...sample('archiveIntent'), preparationRef });
  assert.notEqual(hash('archiveIntent', { ...sample('archiveIntent'), preparationRef: 'é' }), hash('archiveIntent', { ...sample('archiveIntent'), preparationRef: 'e\u0301' }));
  const lone = { ...sample('archiveIntent'), preparationRef: '\ud800' };
  assert.ok(encode('archiveIntent', lone).includes(B('"preparationRef":"\\ud800"')));
  rejects(() => decode('archiveIntent', B(text('archiveIntent', lone).replace('\\ud800', '\\uD800'))));
  // Historical P5-only fields can preserve a lone surrogate through the wrapper.
  const p5 = bundle('closed3').archiveEvidence;
  p5.legacyStage.requestRef = '\ud800'; p5.legacyStage.sourceClosedEvidenceRef = '\udfff';
  p5.legacyStage.sourceRef = p5.legacyStage.sourceEvidence.sourceRef = '\ud800';
  p5.legacyStage.isolationAckRef = p5.legacyStage.sourceEvidence.isolationAckRef = '\udfff';
  rehashArchive(p5); assertArchiveGraph(p5); assert.deepEqual(archive(p5), p5.handoff);
  // A preparationRef shared with the maintenance plan must remain well formed.
  const bad = bundle('fresh').archiveEvidence;
  for (const name of ['archiveIntent', 'legacyStage', 'legacyStaged', 'owner', 'conversionPlan']) bad[name].preparationRef = '\ud800';
  rehashArchive(bad); assertHashGraph(bad); rejects(() => archive(bad));
  for (const key of ['approvalRef', 'executorId', 'approverId']) {
    const b = bundle('fresh').archiveEvidence; b.conversionProof[key] = '\udfff'; rehashArchive(b); assertHashGraph(b); rejects(() => archive(b));
  }
});

test('exact local route/nullability matrix and cross-kind/cross-family dispatch', () => {
  for (const name of ['fresh', 'closed3', 'registered3', 'registered4']) {
    for (const kind of ['archiveIntent', 'convertedIntake']) {
      const base = sample(kind, name);
      for (const changes of [
        { sourceSchemaVersion: 5, sourceSchemaChecksum: V5 },
        { sourceSchemaVersion: name === 'registered4' ? 3 : 4, sourceSchemaChecksum: name === 'registered4' ? V3 : V4 },
        { preparationRef: name === 'registered4' ? 'unexpected' : null },
        { sourceEvidenceHash: name === 'fresh' ? H : null },
        ...(name === 'fresh' ? [{ holdId: U }] : name === 'registered4' ? [{ holdId: null }] : []),
        { sourceSchemaChecksum: H }, { candidateKind: 'native-v5' },
      ]) rejectJson(kind, { ...base, ...changes });
    }
  }
  // Shape alone permits both v3 hold variants; source kind resolves them in §5.
  for (const holdId of [null, U]) accepted('archiveIntent', { ...sample('archiveIntent', 'closed3'), holdId });
  for (const kind of NEW_KINDS) for (const other of NEW_KINDS) if (kind !== other) {
    rejectRecord(kind, sample(other)); rejects(() => decode(kind, B(text(other, sample(other)))));
  }
  for (const kind of [undefined, null, '', 'hold', 'source', 'owner', 'conversionComplete', '__proto__', 'constructor', 'toString', 'NativeIntake', 1, Symbol('kind'), new String('nativeIntake')]) {
    rejectRecord(kind, sample('nativeIntake')); rejects(() => decode(kind, B(text('nativeIntake', sample('nativeIntake')))));
  }
  const relabeled = sample('nativeIntake'); relabeled.route = 'converted-v4';
  rejects(() => intake({ ...bundle('native5'), intake: relabeled }));
  const other = bundle('fresh'); other.intake.route = 'native-v5'; rejects(() => intake(other));
  const merged = bundle('native5'); merged.intake.handoffHash = H; rejects(() => intake(merged));
});

for (const v of vectors) {
  test(`${v.name}: exact bundle, reordered input, no input mutation; detached frozen result only`, () => {
    const b = fromVector(v), before = clone(b);
    assertIntakeGraph(b);
    const result = intake(reverse(b));
    assert.deepEqual(result, b.intake); assert.deepEqual(Object.keys(result), FIELDS[v.name === 'native5' ? 'nativeIntake' : 'convertedIntake']);
    frozenDetached(result, b.intake); assert.deepEqual(b, before);
    b.intake.acceptedAt++; if (b.sourceEvidence) b.sourceEvidence.instanceCreatedAt++;
    assert.deepEqual(result, before.intake);
    if (result.sourceEvidence) assert.throws(() => { result.sourceEvidence.completedAt++; }, TypeError);
    if (before.archiveEvidence) {
      const a = before.archiveEvidence, snapshot = clone(a), handoff = archive(reverse(a));
      assert.deepEqual(handoff, a.handoff); frozenDetached(handoff, a.handoff); assert.deepEqual(a, snapshot);
      a.handoff.handedOffAt++; assert.deepEqual(handoff, snapshot.handoff);
    }
  });
}

// Each row changes a relational fact and rehashes every affected ancestor with
// test-owned algorithms. Thus no row can pass merely by stopping on stale hashes.
const archiveRelations = [
  ['run', 'owner.runId', U], ['stage request identity', 'legacyStage.policyHash', H],
  ['staged birth', 'legacyStaged.instanceCreatedAt', 101], ['staged identity', 'legacyStaged.instanceId', U],
  ['owner epoch', 'owner.centerEpoch', U], ['original P1 epoch', 'legacyStaged.initialEpoch', U],
  ['owner identity', 'owner.instanceId', U], ['owner birth', 'owner.instanceCreatedAt', 101],
  ['plan identity', 'conversionPlan.instanceId', U], ['plan birth', 'conversionPlan.instanceCreatedAt', 101],
  ['completion identity', 'conversionCompletion.instanceId', U], ['completion birth', 'conversionCompletion.instanceCreatedAt', 101],
  ['completion epoch', 'conversionCompletion.centerEpoch', U], ['plan epoch', 'conversionPlan.centerEpoch', U],
  ['staged preparation', 'legacyStaged.preparationRef', 'prepare:different'],
  ['plan preparation', 'conversionPlan.preparationRef', 'prepare:different'],
  ['owner preparation', 'owner.preparationRef', 'prepare:different'],
  ['plan policy', 'conversionPlan.executionPolicyHash', H],
  ['pause input', 'pauseIntent.inputFileHash', H], ['paused input', 'paused.inputFileHash', H],
  ['pause mode', 'pauseIntent.originalWriteMode', 'enabled'], ['pause target', 'pauseIntent.targetWriteMode', 'enabled'],
  ['paused changed', 'paused.changed', true], ['unchanged differing hash', 'paused.pausedFileHash', H],
  ['plan input', 'conversionPlan.preconversionFileHash', H],
  ['converter from version', 'conversionPlan.fromVersion', 3], ['converter from checksum', 'conversionPlan.fromChecksum', V3],
  ['converter output version', 'conversionPlan.toVersion', 4], ['converter output checksum', 'conversionPlan.toChecksum', V4],
  ['completion transition', 'conversionCompletion.transitionId', U],
  ['completion prehash', 'conversionCompletion.preconversionFileHash', H],
  ['completion posthash', 'conversionCompletion.postconversionFileHash', H],
  ['completion checksum', 'conversionCompletion.schemaChecksum', V4],
  ['completion schema', 'conversionCompletion.schemaVersion', 4],
  ['fresh base must null', 'legacyStaged.candidateBaseHash', H], ['fresh import epoch must null', 'legacyStaged.importEpoch', U],
  ['staged before stage', 'legacyStaged.stagedAt', 199], ['owner before staged', 'owner.claimedAt', 299],
  ['pause before owner', 'pauseIntent.createdAt', 399], ['paused before intent', 'paused.pausedAt', 499],
  ['plan before pause', 'conversionPlan.createdAt', 599], ['intent before proof', 'archiveIntent.createdAt', 799],
  ['handoff before intent', 'handoff.handedOffAt', 899],
  ['TTL zero', 'conversionPlan.expiresAt', 700], ['TTL oversized', 'conversionPlan.expiresAt', 300701],
  ['proof too early', 'conversionProof.convertedAt', 699], ['proof at expiry', 'conversionProof.convertedAt', 300700],
  ['distinct actors', 'conversionProof.approverId', 'actor:executor'],
  ['archive file hash', 'handoff.archiveFileHash', H], ['live file hash', 'handoff.liveInitialHash', H],
];
for (const [label, path, value] of archiveRelations) test(`§5 coherent hash graph rejects ${label}`, () => {
  const b = bundle('fresh').archiveEvidence; set(b, path, value); rehashArchive(b); assertHashGraph(b);
  rejects(() => archive(b));
});

const sourceRelations = [
  ['registered3', 'registered source birth', 'legacyStage.sourceEvidence.instanceCreatedAt', 101],
  ['registered3', 'registered source identity', 'legacyStage.sourceEvidence.instanceId', U],
  ['closed3', 'closed source identity', 'legacyStage.sourceEvidence.instanceId', U],
  ['closed3', 'closed source birth', 'legacyStage.sourceEvidence.instanceCreatedAt', 101],
  ['closed3', 'closed base file', 'legacyStaged.candidateBaseHash', H],
  ['registered4', 'snapshot base file', 'legacyStaged.candidateBaseHash', H],
  ['registered3', 'registered import base file', 'legacyStaged.candidateBaseHash', H],
  ['registered3', 'import epoch required', 'legacyStaged.importEpoch', null],
  ['closed3', 'import epoch distinct', 'legacyStaged.importEpoch', '33333333-3333-3333-3333-333333333333'],
  ['registered4', 'snapshot import epoch null', 'legacyStaged.importEpoch', U],
  ['registered3', 'source completed floor', 'legacyStage.sourceEvidence.completedAt', 401],
  ['closed3', 'source observed floor', 'legacyStage.sourceEvidence.observedAt', 401],
  ['registered3', 'hold created floor', 'hold.createdAt', 401],
  ['registered3', 'hold backup', 'hold.backupId', U], ['registered4', 'hold run', 'hold.recoveryRunId', U],
  ['registered3', 'hold ID', 'hold.holdId', U], ['registered4', 'registered requires hold', 'hold', null],
  ['closed3', 'closed cannot gain owner hold', 'owner.holdId', U],
  ['registered4', 'enabled changed required', 'paused.changed', false],
  ['registered4', 'enabled changed requires different hash', 'paused.pausedFileHash', '1'.repeat(64)],
  ['closed3', 'closed source ref equality', 'legacyStage.sourceEvidence.sourceRef', 'closed:different'],
  ['closed3', 'closed isolation equality', 'legacyStage.sourceEvidence.isolationAckRef', 'isolation:different'],
];
for (const [name, label, path, value] of sourceRelations) test(`§5 ${name}: coherent hashes reject ${label}`, () => {
  const b = bundle(name).archiveEvidence; set(b, path, value); rehashArchive(b); assertHashGraph(b); rejects(() => archive(b));
});

test('§5 isolated plan-to-paused input mismatch with coherent proof and completion', () => {
  const b = bundle('fresh').archiveEvidence;
  assertArchiveGraph(b);
  b.conversionPlan.preconversionFileHash = H;
  b.conversionCompletion.preconversionFileHash = H;
  rehashArchive(b); assertHashGraph(b);
  assert.equal(b.conversionPlan.preconversionFileHash, b.conversionCompletion.preconversionFileHash);
  assert.equal(text('conversionPlan', b.conversionProof.plan), text('conversionPlan', b.conversionPlan));
  assert.notEqual(b.conversionPlan.preconversionFileHash, b.paused.pausedFileHash);
  assert.ok(encodeRecoveryConversionRecord('paused', b.paused));
  assert.ok(encodeMaintenanceV5Record('conversionPlan', b.conversionPlan));
  assert.ok(encodeMaintenanceV5Record('conversionProof', b.conversionProof));
  assert.ok(encodeMaintenanceV5Record('conversionComplete', b.conversionCompletion));
  // Repair just the targeted relation in a detached control; all other §5
  // comparisons already hold, including completion/plan and proof/plan inputs.
  const control = clone(b);
  control.conversionPlan.preconversionFileHash = control.conversionCompletion.preconversionFileHash = control.paused.pausedFileHash;
  rehashArchive(control); assertArchiveGraph(control);
  rejects(() => archive(b), MISMATCH);
});

test('§5 isolated enabled changed-true equal-file-hash rejection with coherent conversion inputs', () => {
  const b = bundle('registered4').archiveEvidence;
  assertArchiveGraph(b);
  b.paused.pausedFileHash = b.owner.intakeFileHash;
  b.conversionPlan.preconversionFileHash = b.paused.pausedFileHash;
  b.conversionCompletion.preconversionFileHash = b.paused.pausedFileHash;
  rehashArchive(b); assertHashGraph(b);
  assert.equal(b.owner.intakeWriteMode, 'enabled');
  assert.equal(b.pauseIntent.originalWriteMode, 'enabled');
  assert.equal(b.paused.changed, true);
  assert.equal(b.paused.inputFileHash, b.owner.intakeFileHash);
  assert.equal(b.paused.pausedFileHash, b.owner.intakeFileHash);
  assert.equal(b.conversionPlan.preconversionFileHash, b.paused.pausedFileHash);
  assert.equal(b.conversionCompletion.preconversionFileHash, b.conversionPlan.preconversionFileHash);
  assert.equal(text('conversionPlan', b.conversionProof.plan), text('conversionPlan', b.conversionPlan));
  // Historical standalone paused deliberately permits changed:true/equal hash;
  // the new archive binding must enforce the stronger pause-outcome relation.
  assert.ok(encodeRecoveryConversionRecord('owner', b.owner));
  assert.ok(encodeRecoveryConversionRecord('pauseIntent', b.pauseIntent));
  assert.ok(encodeRecoveryConversionRecord('paused', b.paused));
  assert.ok(encodeMaintenanceV5Record('conversionPlan', b.conversionPlan));
  assert.ok(encodeMaintenanceV5Record('conversionProof', b.conversionProof));
  assert.ok(encodeMaintenanceV5Record('conversionComplete', b.conversionCompletion));
  const control = clone(b);
  control.paused.pausedFileHash = control.conversionPlan.preconversionFileHash = control.conversionCompletion.preconversionFileHash = H;
  assert.notEqual(H, control.owner.intakeFileHash);
  rehashArchive(control); assertArchiveGraph(control);
  rejects(() => archive(b), MISMATCH);
});

test('§5 isolated plan-before-pause chronology rejection with valid TTL and proof window', () => {
  const b = bundle('fresh').archiveEvidence;
  assertArchiveGraph(b);
  b.conversionPlan.createdAt = 599;
  b.conversionPlan.expiresAt = 300599;
  rehashArchive(b); assertHashGraph(b);
  assert.equal(b.paused.pausedAt, 600);
  assert.equal(b.conversionProof.convertedAt, 800);
  assert.equal(b.conversionPlan.expiresAt - b.conversionPlan.createdAt, 300000);
  assert.ok(b.conversionPlan.createdAt < b.paused.pausedAt);
  assert.ok(b.conversionPlan.createdAt >= b.conversionPlan.instanceCreatedAt);
  assert.ok(b.conversionProof.convertedAt >= b.conversionPlan.createdAt);
  assert.ok(b.conversionProof.convertedAt < b.conversionPlan.expiresAt);
  assert.equal(b.conversionProof.executorId, 'actor:executor');
  assert.equal(b.conversionProof.approverId, 'actor:approver');
  assert.notEqual(b.conversionProof.executorId, b.conversionProof.approverId);
  assert.equal(text('conversionPlan', b.conversionProof.plan), text('conversionPlan', b.conversionPlan));
  assert.ok(encodeMaintenanceV5Record('conversionPlan', b.conversionPlan));
  assert.ok(encodeMaintenanceV5Record('conversionProof', b.conversionProof));
  assert.ok(encodeMaintenanceV5Record('conversionComplete', b.conversionCompletion));
  const control = clone(b);
  control.conversionPlan.createdAt = control.paused.pausedAt;
  rehashArchive(control); assertArchiveGraph(control);
  rejects(() => archive(b), MISMATCH);
});

test('§5 syntactically valid disjoint nested plan, wrong kind/run, and original-source versus converter-input', () => {
  const different = bundle('fresh').archiveEvidence;
  different.conversionProof.plan.executionPolicyHash = H;
  rehashArchive(different, { copyPlan: false }); assertHashGraph(different);
  // Both individual plans and proof are valid old records; only equality fails.
  assert.ok(encodeMaintenanceV5Record('conversionProof', different.conversionProof));
  rejects(() => archive(different));
  for (const name of ['fresh', 'closed3', 'registered3']) {
    const b = bundle(name).archiveEvidence;
    b.archiveIntent.sourceSchemaVersion = b.handoff.sourceSchemaVersion = 4;
    b.archiveIntent.sourceSchemaChecksum = b.handoff.sourceSchemaChecksum = V4;
    rehashArchive(b); assertHashGraph(b); rejects(() => archive(b));
  }
  const wrongKind = bundle('closed3').archiveEvidence;
  wrongKind.owner.candidateKind = 'snapshot_recovery'; wrongKind.owner.preparationRef = null; wrongKind.owner.holdId = U;
  rehashArchive(wrongKind); assertHashGraph(wrongKind); rejects(() => archive(wrongKind));
  const wrongRun = bundle('fresh').archiveEvidence;
  wrongRun.conversionPlan.recoveryRunId = U; wrongRun.conversionPlan.candidateReference = `runs/${U}/candidate.sqlite`;
  rehashArchive(wrongRun); assertHashGraph(wrongRun);
  assert.ok(encodeMaintenanceV5Record('conversionPlan', wrongRun.conversionPlan)); rejects(() => archive(wrongRun));
});

test('§5 registered snapshot supports unchanged paused input; chronology equality and TTL edges', () => {
  const b = bundle('registered4').archiveEvidence;
  b.owner.intakeWriteMode = b.pauseIntent.originalWriteMode = 'paused';
  b.paused.changed = false; b.paused.pausedFileHash = b.owner.intakeFileHash;
  b.conversionPlan.preconversionFileHash = b.conversionCompletion.preconversionFileHash = b.paused.pausedFileHash;
  rehashArchive(b); assertArchiveGraph(b); assert.deepEqual(archive(b), b.handoff);
  for (const duration of [1, 300000]) {
    const equal = bundle('fresh').archiveEvidence;
    equal.legacyStage.createdAt = equal.legacyStaged.stagedAt = equal.owner.claimedAt = equal.pauseIntent.createdAt = equal.paused.pausedAt = equal.conversionPlan.createdAt = equal.conversionProof.convertedAt = equal.archiveIntent.createdAt = equal.handoff.handedOffAt = 700;
    equal.conversionPlan.expiresAt = 700 + duration;
    rehashArchive(equal); assertArchiveGraph(equal); assert.deepEqual(archive(equal), equal.handoff);
  }
});

test('§5 archive/handoff semantic endpoints bind even after intent hash refresh', () => {
  const rows = [
    ['archiveIntent.instanceId', U], ['archiveIntent.instanceCreatedAt', 101], ['archiveIntent.centerEpoch', U],
    ['archiveIntent.preparationRef', 'prepare:other'], ['archiveIntent.executionPolicyHash', H],
    ['archiveIntent.conversionPosthash', H], ['handoff.instanceId', U], ['handoff.instanceCreatedAt', 101],
    ['handoff.centerEpoch', U], ['handoff.sourceSchemaVersion', 3], ['handoff.sourceSchemaChecksum', V3],
    ['handoff.targetSchemaVersion', 4], ['handoff.targetSchemaChecksum', V4], ['handoff.conversionPosthash', H],
    ['archiveIntent.archiveReference', sample('archiveIntent').candidateReference],
    ['handoff.archiveReference', sample('conversionHandoff').candidateReference],
    ['archiveIntent.candidateReference', `v5-runs/${sample('archiveIntent').runId}/candidate.sqlite`],
    ['handoff.candidateReference', `v5-runs/${sample('conversionHandoff').runId}/candidate.sqlite`],
  ];
  for (const [path, value] of rows) {
    const b = bundle('fresh').archiveEvidence; set(b, path, value); rehashArchive(b); assertHashGraph(b); rejects(() => archive(b));
  }
  for (const name of ['archiveIntent', 'handoff']) {
    const b = bundle('fresh').archiveEvidence;
    b[name].runId = U; b[name].candidateReference = `runs/${U}/candidate.sqlite`; b[name].archiveReference = `runs/${U}/conversion-archive.sqlite`;
    rehashArchive(b); assertHashGraph(b); rejects(() => archive(b));
  }
  for (const name of ['fresh', 'closed3', 'registered3']) {
    const b = bundle(name).archiveEvidence;
    b.owner.intakeWriteMode = b.pauseIntent.originalWriteMode = 'enabled';
    b.paused.changed = true; b.paused.pausedFileHash = H;
    b.conversionPlan.preconversionFileHash = b.conversionCompletion.preconversionFileHash = H;
    rehashArchive(b); assertHashGraph(b); rejects(() => archive(b));
  }
});

test('§5 source exact schema/import markers and selected registered/closed hold variants', () => {
  const rows = [
    ['registered3', 'legacyStage.sourceEvidence.schemaChecksum', V4],
    ['registered4', 'legacyStage.sourceEvidence.schemaChecksum', V3],
    ['closed3', 'legacyStage.sourceEvidence.schemaChecksum', V4],
    ['registered3', 'legacyStage.sourceEvidence.importedRecordHash', null],
    ['registered4', 'legacyStage.sourceEvidence.importedRecordHash', H],
    ['registered3', 'legacyStage.sourceEvidence.registryFormat', 3],
    ['registered4', 'legacyStage.sourceEvidence.version', 2],
    ['closed3', 'legacyStage.sourceEvidence.schemaVersion', 4],
    ['registered3', 'archiveIntent.holdId', null], ['registered3', 'owner.holdId', null],
    ['registered4', 'archiveIntent.holdId', U], ['registered4', 'owner.holdId', U],
    ['closed3', 'archiveIntent.holdId', U],
  ];
  for (const [name, path, value] of rows) {
    const b = bundle(name).archiveEvidence; set(b, path, value); rehashArchive(b); assertHashGraph(b); rejects(() => archive(b));
  }
  for (const name of ['fresh', 'closed3']) {
    const b = bundle(name).archiveEvidence; b.hold = clone(bundle('registered3').archiveEvidence.hold);
    rehashArchive(b); assertHashGraph(b); rejects(() => archive(b));
  }
  // Pure handoff permits null/3/4 originals, but not arbitrary checksum/version pairs.
  for (const changes of [{ sourceSchemaVersion: 5, sourceSchemaChecksum: V5 },
    { sourceSchemaVersion: 3, sourceSchemaChecksum: V4 }, { sourceSchemaVersion: null, sourceSchemaChecksum: V4 },
    { sourceSchemaVersion: 4, sourceSchemaChecksum: null }]) rejectJson('conversionHandoff', { ...sample('conversionHandoff'), ...changes });
});

test('§5 all supplied digest edges are checked, with original historical hash domains', () => {
  const hashPaths = [
    'legacyStage.requestHash', 'legacyStaged.stageHash', 'owner.stageHash', 'owner.stagedHash',
    'owner.sourceEvidenceHash', 'pauseIntent.ownerHash', 'paused.ownerHash', 'paused.pauseIntentHash',
    'conversionPlan.stageHash', 'conversionPlan.sourceEvidenceHash', 'conversionProof.planHash',
    'conversionCompletion.stageHash', 'conversionCompletion.planHash', 'conversionCompletion.conversionProofHash',
    'hold.stageHash',
    ...['archiveIntent', 'handoff'].flatMap(name => ['legacyStageHash', 'legacyStagedHash', 'ownerHash', 'pauseIntentHash', 'pausedHash', 'conversionPlanHash', 'conversionProofHash', 'conversionCompletionHash'].map(key => `${name}.${key}`)),
    'archiveIntent.sourceEvidenceHash', 'handoff.archiveIntentHash',
  ];
  for (const path of hashPaths) { const b = bundle('registered3').archiveEvidence; set(b, path, H); rejects(() => archive(b)); }
  for (const wrong of [rawHash(B(text('archiveIntent', sample('archiveIntent')))), rawHash(B(prefix('archiveIntent').replace('\n', '\0') + text('archiveIntent', sample('archiveIntent'))))]) {
    const b = bundle('fresh').archiveEvidence; b.handoff.archiveIntentHash = wrong; rejects(() => archive(b));
  }
  for (const wrongSource of ['fileHash', 'manifestHash', 'importedRecordHash']) {
    const b = bundle('registered3').archiveEvidence, wrong = b.legacyStage.sourceEvidence[wrongSource];
    b.archiveIntent.sourceEvidenceHash = b.owner.sourceEvidenceHash = b.conversionPlan.sourceEvidenceHash = wrong;
    // Rehash downstream, retaining the intentionally wrong source hash family.
    b.archiveIntent.ownerHash = b.handoff.ownerHash = b.pauseIntent.ownerHash = b.paused.ownerHash = digest('owner', b.owner);
    b.archiveIntent.pauseIntentHash = b.handoff.pauseIntentHash = b.paused.pauseIntentHash = digest('pauseIntent', b.pauseIntent);
    b.archiveIntent.pausedHash = b.handoff.pausedHash = digest('paused', b.paused);
    b.conversionProof.plan = clone(b.conversionPlan);
    b.archiveIntent.conversionPlanHash = b.handoff.conversionPlanHash = b.conversionProof.planHash = b.conversionCompletion.planHash = digest('conversionPlan', b.conversionPlan);
    b.archiveIntent.conversionProofHash = b.handoff.conversionProofHash = b.conversionCompletion.conversionProofHash = digest('conversionProof', b.conversionProof);
    b.archiveIntent.conversionCompletionHash = b.handoff.conversionCompletionHash = digest('conversionComplete', b.conversionCompletion);
    b.handoff.archiveIntentHash = digest('archiveIntent', b.archiveIntent); rejects(() => archive(b));
  }
});

for (const name of ['native5', 'fresh', 'closed3', 'registered3', 'registered4']) {
  test(`§6 ${name}: actual exact fields all bind; route-specific write mode`, () => {
    const changes = { instanceId: U, instanceCreatedAt: 101, schemaVersion: 4, schemaChecksum: V4,
      centerEpoch: U, recoveryCounter: 8, fileHash: H, writeMode: 'unknown' };
    for (const [key, value] of Object.entries(changes)) { const b = bundle(name); b.actual[key] = value; rejects(() => intake(b)); }
    const b = bundle(name); b.actual.writeMode = 'enabled';
    if (name === 'native5') assert.deepEqual(intake(b), b.intake); else rejects(() => intake(b));
    const paused = bundle(name); paused.actual.writeMode = 'paused'; assert.deepEqual(intake(paused), paused.intake);
  });
}

test('§6 native source2 exact/rawhash bindings, independent N times, no invented time order', () => {
  for (const [createdAt, completedAt, acceptedAt, counter] of [[100, 90, 0, 7], [Number.MAX_SAFE_INTEGER, 0, 1, Number.MAX_SAFE_INTEGER], [0, Number.MAX_SAFE_INTEGER, 0, 0]]) {
    const b = bundle('native5');
    b.intake.instanceCreatedAt = b.actual.instanceCreatedAt = b.sourceEvidence.instanceCreatedAt = b.intake.sourceEvidence.instanceCreatedAt = createdAt;
    b.sourceEvidence.completedAt = b.intake.sourceEvidence.completedAt = completedAt;
    b.intake.acceptedAt = acceptedAt; b.actual.recoveryCounter = b.intake.previousRecoveryCounter = counter;
    b.intake.sourceEvidenceHash = digest('source', b.sourceEvidence);
    assertIntakeGraph(b); assert.deepEqual(intake(b), b.intake); accepted('nativeIntake', b.intake);
  }
  for (const key of Object.keys(bundle('native5').sourceEvidence)) {
    const b = bundle('native5');
    const v = b.sourceEvidence[key];
    b.sourceEvidence[key] = typeof v === 'number' ? v + 1 : v === null ? H : v + 'x';
    rejects(() => intake(b));
  }
  for (const sourceEvidence of [null, bundle('registered4').sourceEvidence, bundle('registered3').sourceEvidence, bundle('closed3').sourceEvidence]) {
    const b = bundle('native5'); b.sourceEvidence = sourceEvidence; rejects(() => intake(b));
  }
  for (const sourceEvidenceHash of [H, rawHash(B('a2a-msg.im.v2/recovery-v5/source\n' + text('source', bundle('native5').sourceEvidence)))]) {
    const b = bundle('native5'); b.intake.sourceEvidenceHash = sourceEvidenceHash; rejects(() => intake(b));
  }
  const b = bundle('native5'); b.archiveEvidence = bundle('fresh').archiveEvidence; rejects(() => intake(b));
});

const intakeChanges = [
  ['runId', U], ['candidateReference', `runs/${U}/candidate.sqlite`], ['instanceId', U], ['instanceCreatedAt', 101],
  ['candidateKind', 'v3_import'], ['preparationRef', 'prepare:different'], ['executionPolicyHash', H],
  ['initialEpoch', U], ['candidateInitialHash', H], ['acceptedAt', 999], ['archiveIntentHash', H], ['handoffHash', H],
];
for (const [key, value] of intakeChanges) test(`§6 converted fact ${key} disagrees with archive after matching actual`, () => {
  const b = bundle('fresh'); b.intake[key] = value;
  const actualKey = { instanceId: 'instanceId', instanceCreatedAt: 'instanceCreatedAt', initialEpoch: 'centerEpoch', candidateInitialHash: 'fileHash' }[key];
  if (actualKey) b.actual[actualKey] = value;
  rejects(() => intake(b));
});

test('§6 converted original source, hold, actual counter/epoch, posthash and acceptedAt boundaries', () => {
  for (const name of ['fresh', 'closed3', 'registered3', 'registered4']) {
    const b = bundle(name); b.intake.acceptedAt = b.archiveEvidence.handoff.handedOffAt; assert.deepEqual(intake(b), b.intake);
    b.intake.previousRecoveryCounter = b.actual.recoveryCounter = 8;
    if (name === 'registered4') assert.deepEqual(intake(b), b.intake); else rejects(() => intake(b));
    const noArchive = bundle(name); noArchive.archiveEvidence = null; rejects(() => intake(noArchive));
    const wrongSource = bundle(name); wrongSource.sourceEvidence = bundle('native5').sourceEvidence; rejects(() => intake(wrongSource));
    const noSource = bundle(name); noSource.sourceEvidence = null;
    if (name === 'fresh') assert.deepEqual(intake(noSource), noSource.intake); else rejects(() => intake(noSource));
    const hold = bundle(name); hold.intake.holdId = name === 'fresh' || name === 'closed3' ? U : null; rejects(() => intake(hold));
    const originalFile = bundle(name);
    originalFile.intake.candidateInitialHash = originalFile.actual.fileHash = originalFile.archiveEvidence.owner.intakeFileHash;
    rejects(() => intake(originalFile));
  }
  for (const name of ['closed3', 'registered3', 'registered4']) {
    const b = bundle(name); b.sourceEvidence.instanceCreatedAt++; rejects(() => intake(b));
    const translated = bundle(name); translated.archiveEvidence.legacyStage.sourceEvidence = bundle('native5').sourceEvidence;
    rehashArchive(translated.archiveEvidence); syncConverted(translated); rejects(() => intake(translated));
  }
  for (const name of ['closed3', 'registered3']) {
    const b = bundle(name);
    b.intake.sourceSchemaVersion = 4; b.intake.sourceSchemaChecksum = V4;
    rejects(() => intake(b));
    const h = bundle(name); h.intake.sourceEvidenceHash = h.sourceEvidence.fileHash ?? h.sourceEvidence.closedSourceFileHash;
    rejects(() => intake(h));
  }
  const snapshot = bundle('registered4'); snapshot.intake.preparationRef = 'invented:P1'; rejects(() => intake(snapshot));
  // Corrupt relational evidence, update every new digest, match all actual facts:
  // converted intake must still execute the full archive validator.
  const nested = bundle('registered3'); nested.archiveEvidence.hold.backupId = U;
  rehashArchive(nested.archiveEvidence); syncConverted(nested); assertHashGraph(nested.archiveEvidence); rejects(() => intake(nested));
  const raw = bundle('fresh'); raw.intake.handoffHash = rawHash(B(text('conversionHandoff', raw.archiveEvidence.handoff))); rejects(() => intake(raw));
});

// Exact-object boundaries, including historically permissive records. Each path
// gets an otherwise valid complete bundle; no malformed parent masks this check.
const archivePaths = ['', 'archiveIntent', 'handoff', 'legacyStage', 'legacyStage.sourceEvidence', 'legacyStaged', 'owner', 'pauseIntent', 'paused', 'conversionPlan', 'conversionProof', 'conversionProof.plan', 'conversionCompletion', 'hold'];
const intakePaths = ['', 'intake', 'intake.sourceEvidence', 'sourceEvidence', 'actual'];
function strictBoundaries(make, paths, validate) {
  let reads = 0;
  const foreign = new Proxy({}, { get() { reads++; throw undefined; }, getPrototypeOf() { reads++; throw null; } });
  const trap = () => { reads++; throw foreign; };
  const handler = Object.fromEntries(['get', 'ownKeys', 'getPrototypeOf', 'getOwnPropertyDescriptor', 'has'].map(key => [key, trap]));
  for (const path of paths) {
    const base = make(), node = path ? at(base, path) : base;
    const invoke = replacement => {
      const root = make(); if (path) set(root, path, replacement);
      rejects(() => validate(path ? root : replacement));
    };
    for (const key of Object.keys(node)) {
      const missing = clone(node); delete missing[key]; invoke(missing);
      invoke({ ...node, [key]: undefined });
      const hidden = clone(node); Object.defineProperty(hidden, key, { enumerable: false }); invoke(hidden);
      const accessor = clone(node); Object.defineProperty(accessor, key, { get: trap }); invoke(accessor);
    }
    for (const key of ['extra', 'toJSON', 'then', Symbol('extra')]) {
      const extra = clone(node); Object.defineProperty(extra, key, { get: trap }); invoke(extra);
    }
    const revoked = Proxy.revocable(clone(node), handler); revoked.revoke();
    for (const invalid of [new Proxy(clone(node), handler), revoked.proxy, [], Object.assign(Object.create(null), node), Object.assign(Object.create({}), node)]) invoke(invalid);
    const scalar = Object.keys(node).find(key => node[key] !== null && typeof node[key] !== 'object');
    if (scalar !== undefined) invoke({ ...node, [scalar]: new Proxy({}, handler) });
  }
  assert.equal(reads, 0, 'zero descriptor/getter/error/proxy traps');
}
test('§1/5 every archive object boundary rejects hostile/missing/hidden records before traps', () => {
  strictBoundaries(() => bundle('registered3').archiveEvidence, archivePaths, archive);
  strictBoundaries(() => bundle('closed3').archiveEvidence, ['legacyStage.sourceEvidence'], archive);
});
test('§1/6 native and converted bundles reject strict nested boundaries before traps', () => {
  strictBoundaries(() => bundle('native5'), intakePaths, intake);
  strictBoundaries(() => bundle('registered3'), ['archiveEvidence', ...archivePaths.filter(Boolean).map(path => 'archiveEvidence.' + path), 'sourceEvidence'], intake);
});

test('old codecs may accept -0/hidden fields; wrapper rejects them before legacy delegation', () => {
  for (const path of ['legacyStage.createdAt', 'legacyStaged.instanceCreatedAt', 'legacyStage.sourceEvidence.completedAt', 'hold.createdAt']) {
    const b = bundle('registered3').archiveEvidence; set(b, path, -0); rejects(() => archive(b));
  }
  const c = bundle('closed3').archiveEvidence; c.legacyStage.sourceEvidence.observedAt = -0; rejects(() => archive(c));
  const n = bundle('native5'); n.intake.sourceEvidence.completedAt = -0; rejectRecord('nativeIntake', n.intake);
  for (const field of ['instanceCreatedAt', 'recoveryCounter']) { const b = bundle('native5'); b.actual[field] = -0; rejects(() => intake(b)); }
});

test('Proxy-before-reflection for kinds, all records, scalar slots, byte inputs and revoked proxies', () => {
  let reads = 0;
  const trap = () => { reads++; throw undefined; };
  const handler = Object.fromEntries(['get', 'getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor', 'has'].map(key => [key, trap]));
  const revoked = Proxy.revocable({}, handler); revoked.revoke();
  for (const kind of NEW_KINDS) {
    const base = sample(kind);
    rejectRecord(kind, new Proxy(base, handler)); rejectRecord(kind, revoked.proxy);
    rejectRecord(kind, Object.setPrototypeOf(clone(base), new Proxy({}, handler)));
    for (const key of Object.keys(base)) rejectRecord(kind, { ...base, [key]: new Proxy({}, handler) });
    rejects(() => decode(kind, new Proxy(B(text(kind, base)), handler))); rejects(() => decode(kind, revoked.proxy));
  }
  rejectRecord(new Proxy({}, handler), sample('nativeIntake'));
  rejects(() => decode(new Proxy({}, handler), B(text('nativeIntake', sample('nativeIntake')))));
  const b = sample('nativeIntake'); b.sourceEvidence = new Proxy(b.sourceEvidence, handler); rejectRecord('nativeIntake', b);
  assert.equal(reads, 0);
});

test('fatal UTF8 and bounded byte input reject malformed data before parse when appropriate', () => {
  const base = text('archiveIntent', sample('archiveIntent'));
  const [before, after] = base.split('初');
  for (const sequence of [[0x80], [0xc0, 0xaf], [0xe0, 0x80, 0xaf], [0xc2], [0xe2, 0x28, 0xa1], [0xed, 0xa0, 0x80], [0xf0, 0x80, 0x80, 0xaf], [0xf4, 0x90, 0x80, 0x80], [0xff]]) {
    rejects(() => decode('archiveIntent', Buffer.concat([B(before), Buffer.from(sequence), B(after)])));
  }
  const parse = JSON.parse; let calls = 0;
  try {
    JSON.parse = (...args) => { calls++; return parse(...args); };
    // Bounded Ref/fixed schemas cannot make a valid 64 KiB record; use valid UTF8
    // JSON with noncanonical padding to distinguish byte cap from record failure.
    for (const length of [65535, 65536, 65537]) {
      const bytes = Buffer.alloc(length, 0x20); bytes.write(base);
      const count = calls; rejects(() => decode('archiveIntent', bytes));
      assert.equal(calls - count, length <= 65536 ? 1 : 0);
    }
    const bytes = B('"' + '中'.repeat(21845) + '"'); assert.equal(bytes.length, 65537);
    const count = calls; rejects(() => decode('nativeIntake', bytes)); assert.equal(calls, count);
    rejects(() => decode('nativeIntake', Buffer.from([0xff]))); assert.equal(calls, count);
  } finally { JSON.parse = parse; }
  const maxRef = { ...sample('archiveIntent'), preparationRef: '\ud800'.repeat(255) };
  accepted('archiveIntent', maxRef); assert.ok(encode('archiveIntent', maxRef).length < 65536);
  rejectRecord('archiveIntent', { ...maxRef, preparationRef: 'x'.repeat(65537) });
});

test('byte input forbids shared/detached memory, subclasses, shadow fields and caller iterators', () => {
  const canonical = B(text('nativeIntake', sample('nativeIntake')));
  const shared = new SharedArrayBuffer(canonical.length), sharedBytes = new Uint8Array(shared); sharedBytes.set(canonical);
  const detached = new Uint8Array(canonical); structuredClone(detached.buffer, { transfer: [detached.buffer] });
  class Subclass extends Uint8Array {}
  for (const bytes of [sharedBytes, Buffer.from(shared), detached, new Subclass(canonical), canonical.buffer,
    new DataView(canonical.buffer), new Uint16Array(2), new Uint8ClampedArray(2), Array.from(canonical), canonical.toString(), null, undefined, new Uint8Array()]) rejects(() => decode('nativeIntake', bytes));
  let calls = 0;
  for (const key of ['length', 'byteLength', 'buffer', 'byteOffset', 'toString', Symbol.iterator, Symbol('extra')]) {
    const bytes = Buffer.from(canonical); Object.defineProperty(bytes, key, { get() { calls++; throw undefined; } });
    rejects(() => decode('nativeIntake', bytes));
  }
  const exoticBacking = new Uint8Array(canonical); Object.setPrototypeOf(exoticBacking.buffer, {});
  rejects(() => decode('nativeIntake', exoticBacking));
  assert.equal(calls, 0);
});

test('all five public boundaries normalize thrown undefined/hostile errors without reflection', () => {
  let reads = 0;
  const trap = () => { reads++; throw 'RAW_EVIDENCE'; };
  const foreign = {};
  for (const key of ['code', 'message', 'stack', 'cause', 'then']) Object.defineProperty(foreign, key, { get: trap });
  const proxy = new Proxy(foreign, Object.fromEntries(['get', 'getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor', 'has'].map(key => [key, trap])));
  const parse = JSON.parse, stringify = JSON.stringify;
  const native = sample('nativeIntake'), nativeBytes = B(text('nativeIntake', native));
  const archiveBundle = bundle('fresh').archiveEvidence, intakeBundle = bundle('native5');
  const errors = [];
  try {
    for (const exception of [undefined, null, 1, 'RAW_EVIDENCE', foreign, proxy, { code: INVALID, message: 'RAW_EVIDENCE' }]) {
      JSON.parse = () => { throw exception; };
      errors.push(rejects(() => decode('nativeIntake', nativeBytes)));
      JSON.parse = parse;
      JSON.stringify = () => { throw exception; };
      errors.push(rejects(() => encode('nativeIntake', native), INVALID));
      errors.push(rejects(() => hash('nativeIntake', native), INVALID));
      errors.push(rejects(() => archive(archiveBundle)));
      errors.push(rejects(() => intake(intakeBundle)));
      JSON.stringify = stringify;
    }
  } finally { JSON.parse = parse; JSON.stringify = stringify; }
  assert.equal(new Set(errors).size, errors.length, 'fresh fixed error for every public rejection');
  assert.equal(reads, 0);
});
