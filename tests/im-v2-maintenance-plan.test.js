import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encodeMaintenancePlan, decodeMaintenancePlan, hashMaintenancePlan, encodeMaintenanceCursor, decodeMaintenanceCursor } from '../src/im/v2/maintenance-plan.js';
import * as publicCodec from '../src/im/v2/maintenance-plan.js';

// Test oracle intentionally frames and hashes independently of the production codec.
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const hex = n => String(n).repeat(64);
function f(v) {
  if (v === null) return Buffer.from('n;');
  if (typeof v === 'boolean') return Buffer.from(v ? 'b1;' : 'b0;');
  if (typeof v === 'number') return Buffer.from(`i${v};`);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([Buffer.from(`s${b.length}:`), b]); }
  return Buffer.concat([Buffer.from(`a${v.length}:`), ...v.map(f)]);
}
function hash(tag, bytes) { return createHash('sha256').update(tag).update(Buffer.from([0])).update(bytes).digest('hex'); }
const fh = (tag, value) => hash(tag, f(value));
function fixture(kind = 'expire', mode = 'empty') {
  const audit = kind === 'audit';
  const cutoff = 20000000000;
  const key = [audit ? 4448000000 : cutoff, audit ? -1 : uuid(7)];
  const candidate = { key, messageId:audit ? null : uuid(7), auditId:audit ? -1 : null,
    contentPolicyHash:audit ? null : hex('b'), expectedState:audit ? null : kind === 'expire' ? 'live' : 'expired',
    expiresAt:audit ? null : cutoff, expectedFingerprint:hex('c'), expectedBytes:kind === 'expire' ? 0 : 12, expectedRows:kind === 'scrub' ? 3 : 1 };
  const held = {key:[key[0],audit ? 0 : uuid(8)],messageId:audit ? null : uuid(8),auditId:audit ? 0 : null,
    reason:audit ? 'AUDIT_PROTECTED' : 'OVERSIZED_GROUP',expectedFingerprint:hex('d'),expectedRows:audit ? 0 : kind === 'scrub' ? 4 : 2,expectedBytes:audit ? 0 : kind === 'scrub' ? 10485761 : 0};
  const candidates = mode === 'empty' || mode === 'held' ? [] : [candidate];
  const heldList = mode === 'held' || mode === 'mixed' ? [held] : [];
  const last = heldList.length ? held.key : candidates.length ? candidate.key : null;
  const hasMore = mode === 'incomplete' ? null : mode === 'mixed' ? true : false;
  const selection = {version:1,cutoffAt:cutoff,eligibleThroughAt:audit ? cutoff-15552000000 : cutoff,sortVersion:1,after:null,limit:20,
    effect:({expire:'expire-only',scrub:'scrub',audit:'audit-delete'})[kind],auditActions:audit ? ['conversation.created','message.read'] : []};
  const p = {version:2,runId:uuid(1),instanceId:uuid(2),instanceCreatedAt:100,centerEpoch:uuid(3),kind,
    executionPolicyHash:hex('a'),createdAt:cutoff,expiresAt:cutoff+300000,clockObservedAt:cutoff,
    timeEvidence:{version:1,schemaVersion:4,observedWallAt:cutoff,globalFloorObservedAt:cutoff,anchorGeneration:null,anchorHash:null,sessionNonce:null,
      anchorWallAt:null,monotonicElapsedMs:null,maxForwardJumpMs:86400000,executable:false,reason:'SCHEMA_UPGRADE_REQUIRED'},
    selection,candidates,candidateDigest:'',
    budget:{maxRows:100,maxProofRows:2,maxBytes:10485760,maxScanRows:10000,maxScanBytes:104857600,maxScanMs:1000,maxWriteMs:1000,
      planTtlMs:300000,maxForwardJumpMs:86400000,plannedRows:candidates.reduce((n,c)=>n+c.expectedRows,0),plannedBytes:candidates.reduce((n,c)=>n+c.expectedBytes,0)},
    scan:{version:1,rowsRead:4,bytesRead:200,elapsedMs:2,plannedRangeEnd:last,lastScanned:last,nextCursor:null,hasMore,
      complete:mode !== 'incomplete',stopReason:mode === 'incomplete' ? 'SCAN_BYTES' : mode === 'mixed' ? 'ROW_BUDGET' : 'END',
      candidateCount:candidates.length,heldCount:heldList.length,skippedCount:heldList.length,held:heldList,
      heldCounts:{oversizedGroup:audit ? 0 : heldList.length,auditProtected:audit ? heldList.length : 0,auditActionUnknown:0},rangeDigest:''}};
  if (last && (mode === 'mixed' || mode === 'incomplete')) p.scan.nextCursor = Buffer.from(JSON.stringify([2,'maintenance',p.instanceId,p.instanceCreatedAt,p.centerEpoch,kind,p.executionPolicyHash,cutoff,1,last])).toString('base64url');
  const identity = [2,p.instanceId,p.instanceCreatedAt,p.centerEpoch,kind,p.executionPolicyHash,1,cutoff,selection.eligibleThroughAt,1,null,20,selection.effect,selection.auditActions];
  const outcomes = [...candidates.map(c => [c.key,'candidate',c.expectedFingerprint,c.expectedRows,c.expectedBytes]),
    ...heldList.map(c => [c.key,c.reason,c.expectedFingerprint,c.expectedRows,c.expectedBytes])];
  p.scan.rangeDigest = fh('a2a-msg.im.maintenance.range.v1',[identity,last,hasMore,outcomes]);
  p.candidateDigest = fh('a2a-msg.im.maintenance.candidates.v2',[identity,last,p.scan.rangeDigest,
    candidates.map(c => [c.key,c.messageId,c.auditId,c.contentPolicyHash,c.expectedState,c.expiresAt,c.expectedFingerprint,c.expectedBytes,c.expectedRows])]);
  return p;
}
const invalid = fn => assert.throws(fn, e => e.message === 'Maintenance preview rejected' && e.code === 'MAINTENANCE_CODEC_INVALID' && !('cause' in e));

test('independent framing anchors, domains, and five exports', () => {
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/im-v2-maintenance-plan/primitive-vectors.json', import.meta.url),'utf8'));
  for (const v of vectors) assert.equal(hash(v.tag,Buffer.from(v.inputBytesHex,'hex')),v.expectedSha256);
  assert.deepEqual(Object.keys(awaitExports()).sort(), ['decodeMaintenanceCursor','decodeMaintenancePlan','encodeMaintenanceCursor','encodeMaintenancePlan','hashMaintenancePlan']);
  for (const [value,hexBytes] of [[null,'6e3b'],['','73303a'],[0,'69303b'],[-1,'692d313b'],[[null,'',0],'61333a6e3b73303a69303b'],['é','73323ac3a9']]) assert.equal(f(value).toString('hex'),hexBytes);
  assert.notEqual(fh('a2a-msg.im.maintenance.text.v1',null),fh('a2a-msg.im.maintenance.blob.v1',null));
});
function awaitExports() { return publicCodec; }

test('independent plans: empty, expire, scrub, audit, held and incomplete', () => {
  for (const [kind,mode] of [['expire','empty'],['expire','candidate'],['scrub','candidate'],['audit','candidate'],['audit','held'],['scrub','held'],['audit','mixed'],['expire','incomplete']]) {
    const p = fixture(kind,mode), literal = Buffer.from(JSON.stringify(p));
    assert.deepEqual(Buffer.from(encodeMaintenancePlan(p)),literal);
    assert.equal(hashMaintenancePlan(p),hash('a2a-msg.im.maintenance.plan.v2',literal));
    const result = decodeMaintenancePlan(literal);
    assert.deepEqual(result,p);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.scan.held) && Object.isFrozen(result.timeEvidence));
    if (p.scan.nextCursor) assert.deepEqual(decodeMaintenanceCursor(p.scan.nextCursor).at(-1),p.scan.lastScanned);
  }
});
test('cross bindings reject tampered valid baseline', () => {
  const changes = [
    p => p.selection.effect = 'scrub',p => p.selection.eligibleThroughAt = 0,p => p.timeEvidence.reason = null,
    p => p.timeEvidence.anchorHash = hex('e'),p => p.createdAt++,p => p.expiresAt++,p => p.budget.plannedRows++,
    p => p.budget.maxForwardJumpMs--,p => p.scan.heldCounts.auditProtected++,p => p.scan.candidateCount++,
    p => p.scan.plannedRangeEnd = null,p => p.scan.nextCursor = null,p => p.scan.hasMore = false,
    p => p.candidateDigest = hex('e'),p => p.scan.rangeDigest = hex('e'),p => p.candidates[0].expectedRows = 0,
    p => p.candidates[0].key[0]++,p => p.scan.held[0].key[1] = 1,p => p.scan.held[0].reason = 'AUDIT_ACTION_UNKNOWN',
  ];
  for (const mutate of changes) { const p = fixture('audit','mixed'); mutate(p); invalid(() => encodeMaintenancePlan(p)); }
});
test('canonical byte decoder and reordered object encoder', () => {
  const p = fixture();
  assert.deepEqual(Buffer.from(encodeMaintenancePlan(Object.fromEntries(Object.entries(p).reverse()))),Buffer.from(JSON.stringify(p)));
  const baseline = JSON.stringify(p);
  for (const bad of ['\uFEFF'+baseline,baseline+'\n',baseline.replace('"version":2','"version":2,"version":2'),
    baseline.replace('"version":2','"\\u0076ersion":2,"version":2'),baseline.replace('"version":2','"version":2e0'),
    JSON.stringify(Object.fromEntries(Object.entries(p).reverse()))]) invalid(() => decodeMaintenancePlan(Buffer.from(bad)));
  invalid(() => decodeMaintenancePlan(Uint8Array.from([0xff])));
  invalid(() => encodeMaintenancePlan({...p,extra:null}));
  const missing = {...p}; delete missing.scan; invalid(() => encodeMaintenancePlan(missing));
  const accessor = {...p}; Object.defineProperty(accessor,'runId',{get(){throw Error('secret');},enumerable:true}); invalid(() => encodeMaintenancePlan(accessor));
  const symbol = {...p,[Symbol('hidden')]:4}; invalid(() => encodeMaintenancePlan(symbol));
  const prototype = Object.assign(Object.create(null),p); invalid(() => encodeMaintenancePlan(prototype));
  const sparse = fixture('audit','candidate'); sparse.candidates = Array(1); invalid(() => encodeMaintenancePlan(sparse));
  for (const value of [-0,9007199254740992,NaN]) { const q = fixture(); q.createdAt = value; invalid(() => encodeMaintenancePlan(q)); }
  const unicode = fixture(); unicode.runId = '\ud800'; invalid(() => encodeMaintenancePlan(unicode));
});
test('cursor strict scope/bytes and defensive ownership', () => {
  const p = fixture('audit','mixed');
  const tuple = [2,'maintenance',p.instanceId,p.instanceCreatedAt,p.centerEpoch,p.kind,p.executionPolicyHash,p.selection.cutoffAt,1,p.scan.lastScanned];
  assert.equal(encodeMaintenanceCursor(tuple),p.scan.nextCursor);
  for (const mutation of [t => t[0]=1,t => t[5]='scrub',t => t[8]=2,t => t.push(0),t => t[9][1]=-0]) { const t = structuredClone(tuple); mutation(t); invalid(() => encodeMaintenanceCursor(t)); }
  for (const bad of [p.scan.nextCursor+'=',p.scan.nextCursor+'!',Buffer.from(JSON.stringify([...tuple,0])).toString('base64url'),
    Buffer.from(JSON.stringify(tuple).replace('"maintenance"','"\\u006daintenance"')).toString('base64url')]) invalid(() => decodeMaintenanceCursor(bad));
  const encoded = encodeMaintenancePlan(p); const frozen = decodeMaintenancePlan(encoded); encoded.fill(0);
  assert.equal(frozen.kind,'audit'); assert.throws(() => { frozen.scan.held[0].reason = 'tampered'; },TypeError);
  assert.equal(hashMaintenancePlan(frozen),hashMaintenancePlan(p));
});

// Literal goldens were authored offline from the approved field tables. Tests
// read them; neither this module nor its fixtures import/run the generator.
const fullVectors = JSON.parse(readFileSync(new URL('./fixtures/im-v2-maintenance-plan/full-vectors.json', import.meta.url), 'utf8'));
const literalVector = name => fullVectors.plans.find(v => v.name === name);
const literalPlan = name => JSON.parse(literalVector(name).canonicalUtf8);
const clone = value => structuredClone(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function reverseObjects(value) {
  if (Array.isArray(value)) return value.map(reverseObjects);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reverseObjects(v)]));
  return value;
}
function assertFrozenTree(value) {
  if (value !== null && typeof value === 'object') {
    assert.ok(Object.isFrozen(value));
    assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype);
    for (const item of Object.values(value)) assertFrozenTree(item);
  }
}
function rejection(fn, code = 'MAINTENANCE_CODEC_INVALID') {
  assert.throws(fn, error => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, code);
    assert.equal(error.message, 'Maintenance preview rejected');
    assert.equal('cause' in error, false);
    assert.deepEqual(Object.keys(error), ['code']);
    assert.equal(JSON.stringify(error).includes('SENSITIVE_CANARY'), false);
    return true;
  });
}
// Used only for valid mutation controls / focused negatives, never to produce or
// replace literal canonical/hash expectations. Implements contract section 7.3.
function rebind(p) {
  const s = p.selection, scan = p.scan;
  const identity = [2,p.instanceId,p.instanceCreatedAt,p.centerEpoch,p.kind,p.executionPolicyHash,s.version,s.cutoffAt,
    s.eligibleThroughAt,s.sortVersion,s.after,s.limit,s.effect,s.auditActions];
  const merged = [...p.candidates.map(c=>[c.key,'candidate',c.expectedFingerprint,c.expectedRows,c.expectedBytes]),
    ...scan.held.map(h=>[h.key,h.reason,h.expectedFingerprint,h.expectedRows,h.expectedBytes])]
    .sort((a,b)=>a[0][0]-b[0][0] || (a[0][1]<b[0][1] ? -1 : a[0][1]>b[0][1] ? 1 : 0));
  scan.rangeDigest = fh('a2a-msg.im.maintenance.range.v1',[identity,scan.plannedRangeEnd,scan.hasMore,merged]);
  p.candidateDigest = fh('a2a-msg.im.maintenance.candidates.v2',[identity,scan.plannedRangeEnd,scan.rangeDigest,
    p.candidates.map(c=>[c.key,c.messageId,c.auditId,c.contentPolicyHash,c.expectedState,c.expiresAt,c.expectedFingerprint,c.expectedBytes,c.expectedRows])]);
  return p;
}
function accepted(p) {
  assert.deepEqual(decodeMaintenancePlan(encodeMaintenancePlan(p)), p);
}
function negativePlan(name, vector, mutate, code = 'MAINTENANCE_CODEC_INVALID', refresh = false) {
  test(`isolated plan rejection: ${name}`, () => {
    const p = literalPlan(vector);
    accepted(p); // valid control for each individual constraint
    mutate(p);
    if (refresh) rebind(p);
    rejection(()=>encodeMaintenancePlan(p),code);
    rejection(()=>hashMaintenancePlan(p),code);
    // Object-only forms (-0, undefined, getters...) have dedicated tests below.
    if (JSON.stringify(p) !== literalVector(vector).canonicalUtf8) rejection(()=>decodeMaintenancePlan(Buffer.from(JSON.stringify(p))),code);
  });
}

test('literal fixture self-check: fixed policy, frames, digests, UTF-8 and SHA outputs', () => {
  assert.equal(sha256(Buffer.from(fullVectors.policyCanonicalUtf8)),fullVectors.policyHash);
  for (const fact of fullVectors.facts) {
    assert.equal(f(fact.descriptor).toString('hex'),fact.frameHex);
    assert.equal(hash(`a2a-msg.im.maintenance.${fact.descriptor[1] === 'audit-row' ? 'audit' : 'message'}.v1`,Buffer.from(fact.frameHex,'hex')),fact.expectedFingerprint);
  }
  for (const vector of fullVectors.plans) {
    const p = JSON.parse(vector.canonicalUtf8), bytes = Buffer.from(vector.canonicalUtf8);
    assert.equal(bytes.length,vector.utf8ByteLength);
    assert.equal(hash('a2a-msg.im.maintenance.plan.v2',bytes),vector.expectedPlanHash);
    assert.equal(hash('a2a-msg.im.maintenance.range.v1',Buffer.from(vector.rangeFrameHex,'hex')),p.scan.rangeDigest);
    assert.equal(hash('a2a-msg.im.maintenance.candidates.v2',Buffer.from(vector.candidateFrameHex,'hex')),p.candidateDigest);
    assert.equal(f([vector.selectionIdentity,p.scan.plannedRangeEnd,p.scan.hasMore,vector.outcomes]).toString('hex'),vector.rangeFrameHex);
    assert.deepEqual(rebind(clone(p)),p);
  }
});
for (const v of fullVectors.plans) test(`literal full PLAN: ${v.name}`, () => {
  const bytes = Buffer.from(v.canonicalUtf8), p = JSON.parse(v.canonicalUtf8);
  assert.deepEqual(Buffer.from(encodeMaintenancePlan(p)),bytes);
  assert.deepEqual(Buffer.from(encodeMaintenancePlan(reverseObjects(p))),bytes);
  assert.deepEqual(decodeMaintenancePlan(bytes),p);
  assert.equal(hashMaintenancePlan(p),v.expectedPlanHash);
  assert.equal(hashMaintenancePlan(reverseObjects(p)),v.expectedPlanHash);
  assertFrozenTree(decodeMaintenancePlan(bytes));
});
for (const v of fullVectors.cursors) test(`literal full CURSOR: ${v.name}`, () => {
  assert.equal(sha256(Buffer.from(v.canonicalUtf8)),v.expectedUtf8Sha256);
  assert.equal(Buffer.from(v.canonicalBase64url,'base64url').toString(),v.canonicalUtf8);
  assert.equal(encodeMaintenanceCursor(clone(v.decodedTuple)),v.canonicalBase64url);
  assert.deepEqual(decodeMaintenanceCursor(v.canonicalBase64url),v.decodedTuple);
  assertFrozenTree(decodeMaintenanceCursor(v.canonicalBase64url));
});

for (const [label, change] of [
  ['leading whitespace',s=>' '+s], ['internal whitespace',s=>s.replace('"version":2','"version": 2')],
  ['BOM',s=>'\ufeff'+s], ['trailing newline',s=>s+'\n'], ['root duplicate',s=>s.replace('"version":2','"version":2,"version":2')],
  ['escaped alias duplicate',s=>s.replace('"version":2','"version":2,"\\u0076ersion":2')],
  ['nested duplicate',s=>s.replace('"observedWallAt":','"schemaVersion":4,"observedWallAt":')],
  ['nested escaped duplicate',s=>s.replace('"observedWallAt":','"\\u0073chemaVersion":4,"observedWallAt":')],
  ['root key order',s=>JSON.stringify(reverseObjects(JSON.parse(s)))],
  ['nested key order',s=>{const p=JSON.parse(s);p.timeEvidence=reverseObjects(p.timeEvidence);return JSON.stringify(p);} ],
  ['alternative escape',s=>s.replace('"expire"','"\\u0065xpire"')],
  ['exponent',s=>s.replace('"version":2','"version":2e0')], ['decimal integer',s=>s.replace('"version":2','"version":2.0')],
  ['negative zero',s=>s.replace('"plannedRows":0','"plannedRows":-0')],
  ['unknown field',s=>s.replace('"version":2','"version":2,"SENSITIVE_CANARY":null')],
]) test(`strict canonical bytes: ${label}`, () => {
  const canonical = literalVector('empty-v4-end').canonicalUtf8;
  assert.deepEqual(decodeMaintenancePlan(Buffer.from(canonical)),JSON.parse(canonical));
  rejection(()=>decodeMaintenancePlan(Buffer.from(change(canonical))));
});
for (const bytes of [[0xff],[0xc0,0xaf],[0xed,0xa0,0x80],[0xf0,0x9f,0x99]]) test(`fatal UTF-8: ${Buffer.from(bytes).toString('hex')}`, () => {
  rejection(()=>decodeMaintenancePlan(Uint8Array.from(bytes)));
});

const planNegatives = [
  ['missing nullable anchor', 'empty-v4-end',p=>delete p.timeEvidence.anchorHash],
  ['null required clock','empty-v4-end',p=>p.clockObservedAt=null],
  ['unknown nested field','empty-v4-end',p=>p.timeEvidence.extra='SENSITIVE_CANARY'],
  ['uppercase UUID','empty-v4-end',p=>p.runId='aaaaaaaa-aaaa-aaaa-aaaa-AAAAAAAAAAAA'],
  ['bad UUID punctuation','empty-v4-end',p=>p.runId='SENSITIVE_CANARY'],
  ['uppercase hash','empty-v4-end',p=>p.executionPolicyHash=p.executionPolicyHash.toUpperCase()],
  ['short hash','empty-v4-end',p=>p.executionPolicyHash=p.executionPolicyHash.slice(1)],
  ['effect versus kind','expire-only',p=>p.selection.effect='scrub'],
  ['expire nonzero bytes','expire-only',p=>p.candidates[0].expectedBytes=1],
  ['scrub live state','scrub-attachment',p=>p.candidates[0].expectedState='live'],
  ['message identity reference','expire-only',p=>p.candidates[0].messageId=uuid(999)],
  ['content audit identity must null','expire-only',p=>p.candidates[0].auditId=0],
  ['audit content hash must null','audit-signed-unicode',p=>p.candidates[0].contentPolicyHash=fullVectors.policyHash],
  ['audit row identity reference','audit-signed-unicode',p=>p.candidates[0].auditId=-2],
  ['audit action order','audit-signed-unicode',p=>p.selection.auditActions.reverse()],
  ['audit eligible-through equality','audit-retention-equality',p=>p.selection.eligibleThroughAt=null],
  ['audit early cutoff cannot saturate zero','audit-before-retention',p=>p.selection.eligibleThroughAt=0],
  ['planned rows','scrub-attachment',p=>p.budget.plannedRows++],
  ['planned bytes','scrub-attachment',p=>p.budget.plannedBytes++],
  ['candidate count','expire-only',p=>p.scan.candidateCount++],
  ['held count','held-only',p=>p.scan.heldCount++],
  ['skipped count','held-only',p=>p.scan.skippedCount++],
  ['held reason counts','held-only',p=>p.scan.heldCounts.auditProtected++],
  ['candidate digest','expire-only',p=>p.candidateDigest='0'.repeat(64)],
  ['range digest','expire-only',p=>p.scan.rangeDigest='0'.repeat(64)],
  ['changed fingerprint','expire-only',p=>p.candidates[0].expectedFingerprint='0'.repeat(64)],
  ['changed cost under same digest','scrub-attachment',p=>{p.candidates[0].expectedBytes++;p.budget.plannedBytes++;}],
  ['range end mismatch','expire-only',p=>p.scan.plannedRangeEnd=[20000000000,uuid(99)]],
  ['last scanned mismatch','expire-only',p=>p.scan.lastScanned=null],
  ['next cursor missing on more','held-only',p=>p.scan.nextCursor=null],
  ['next cursor present at end','expire-only',p=>p.scan.nextCursor=fullVectors.cursors[0].canonicalBase64url],
  ['incomplete nonnull hasMore','incomplete-prefix',p=>p.scan.hasMore=true],
  ['incomplete END','incomplete-prefix',p=>p.scan.stopReason='END'],
  ['complete SCAN_BYTES','empty-v4-end',p=>p.scan.stopReason='SCAN_BYTES'],
  ['incomplete progress requires cursor','incomplete-prefix',p=>p.scan.nextCursor=null],
  ['complete null hasMore','empty-v4-end',p=>p.scan.hasMore=null],
  ['createdAt versus observed','empty-v4-end',p=>p.createdAt++],
  ['timeEvidence observed binding','empty-v4-end',p=>p.timeEvidence.observedWallAt++],
  ['expiresAt exact TTL','empty-v4-end',p=>p.expiresAt--],
  ['TTL maximum','empty-v4-end',p=>{p.budget.planTtlMs=300001;p.expiresAt=p.createdAt+300001;}],
  ['TTL zero','empty-v4-end',p=>{p.budget.planTtlMs=0;p.expiresAt=p.createdAt;}],
  ['max forward jump binding','empty-v4-end',p=>p.timeEvidence.maxForwardJumpMs--],
  ['max proof rows literal','empty-v4-end',p=>p.budget.maxProofRows=3],
  ['scan hard rows','empty-v4-end',p=>p.scan.rowsRead=10001],
  ['scan hard bytes','empty-v4-end',p=>p.scan.bytesRead=104857601],
];
for (const [name,vector,mutate] of planNegatives) negativePlan(name,vector,mutate);

for (const [name,vector,mutate] of [
  ['candidate order','tied-content-keys',p=>p.candidates.reverse()],
  ['duplicate candidate identity','tied-content-keys',p=>p.candidates[1]=clone(p.candidates[0])],
  ['held order','held-only',p=>p.scan.held.reverse()],
  ['duplicate held identity','held-only',p=>p.scan.held[1]=clone(p.scan.held[0])],
  ['candidate-held overlap','audit-mixed',p=>{p.scan.held[0].key=clone(p.candidates[0].key);p.scan.held[0].auditId=p.candidates[0].auditId;}],
  ['exclusive after equality','continuation-exclusive-bound',p=>p.selection.after=clone(p.candidates[0].key)],
  ['exclusive after later key','continuation-exclusive-bound',p=>p.selection.after=[20000000000,uuid(16)]],
  ['key beyond eligible cutoff','expire-only',p=>{p.selection.cutoffAt--;p.selection.eligibleThroughAt--;}],
  ['classified limit','tied-content-keys',p=>p.selection.limit=1],
]) negativePlan(`${name} with fresh integrity digests`,vector,mutate,'MAINTENANCE_CODEC_INVALID',true);

for (const [field,value] of [['anchorGeneration',1],['anchorHash',fullVectors.policyHash],['sessionNonce',uuid(4)],
  ['anchorWallAt',20000000000],['monotonicElapsedMs',0],['executable',true],['reason','TIME_ANCHOR_REQUIRED']]) {
  negativePlan(`v4 ${field} mandated null/false/upgrade with both gates true`,'empty-v4-end',p=>p.timeEvidence[field]=value);
}

test('UUID validator does not impose RFC version bits; safe maximum clock plus TTL is accepted', () => {
  const p = literalPlan('empty-v4-end');
  p.runId='ffffffff-ffff-ffff-ffff-ffffffffffff';
  p.createdAt=Number.MAX_SAFE_INTEGER-300000;p.clockObservedAt=p.createdAt;p.expiresAt=Number.MAX_SAFE_INTEGER;
  p.timeEvidence.observedWallAt=p.createdAt;p.timeEvidence.globalFloorObservedAt=p.createdAt;
  accepted(p);
});
for (const [label,value] of [['negative zero',-0],['overflow',9007199254740992],['fraction',1.5],['NaN',NaN],['Infinity',Infinity],['integer string','100'],['negative',-1]]) {
  test(`safe integer object constraint: ${label}`, () => {
    const p=literalPlan('empty-v4-end');accepted(p);p.instanceCreatedAt=value;
    rejection(()=>encodeMaintenancePlan(p));rejection(()=>hashMaintenancePlan(p));
  });
}
test('TTL checked addition overflow is rejected', () => {
  const p=literalPlan('empty-v4-end');accepted(p);
  p.createdAt=Number.MAX_SAFE_INTEGER;p.clockObservedAt=p.createdAt;p.timeEvidence.observedWallAt=p.createdAt;
  p.expiresAt=p.createdAt+300000;
  rejection(()=>encodeMaintenancePlan(p));
});

for (const [label,mutate] of [
  ['instance',t=>t[2]=uuid(99)],['instance birth',t=>t[3]++],['epoch',t=>t[4]=uuid(99)],
  ['policy',t=>t[6]='f'.repeat(64)],['cutoff',t=>t[7]--],['last key',t=>t[9][1]=2],
  ['kind',t=>{t[5]='expire';t[9][1]=uuid(7);}],
]) test(`internal nextCursor scope: ${label}`, () => {
  const p=literalPlan('audit-mixed');accepted(p);
  const tuple=JSON.parse(Buffer.from(p.scan.nextCursor,'base64url').toString());mutate(tuple);
  // A standalone tuple has no external expectedScope. It remains valid on its own.
  const standalone=Buffer.from(JSON.stringify(tuple)).toString('base64url');
  assert.equal(encodeMaintenanceCursor(tuple),standalone);
  assert.deepEqual(decodeMaintenanceCursor(standalone),tuple);
  p.scan.nextCursor=standalone;
  rejection(()=>encodeMaintenancePlan(p));
});

for (const [label,mutate] of [
  ['version',t=>t[0]=1],['namespace',t=>t[1]='SENSITIVE_CANARY'],['short tuple',t=>t.pop()],['long tuple',t=>t.push(null)],
  ['sort version',t=>t[8]=2],['kind',t=>t[5]='backup'],['string time',t=>t[7]='20000000000'],
  ['null key',t=>t[9]=null],['long key',t=>t[9].push(0)],['audit string ID',t=>t[9][1]='0'],
  ['audit overflow',t=>t[9][1]=9007199254740992],['null instance birth',t=>t[3]=null],
  ['content numeric ID',t=>t[5]='scrub'],
]) test(`cursor isolated invalid tuple: ${label}`, () => {
  const v=fullVectors.cursors[4];assert.equal(encodeMaintenanceCursor(v.decodedTuple),v.canonicalBase64url);
  const tuple=clone(v.decodedTuple);mutate(tuple);
  rejection(()=>encodeMaintenanceCursor(tuple));
  rejection(()=>decodeMaintenanceCursor(Buffer.from(JSON.stringify(tuple)).toString('base64url')));
});
test('cursor -0 preserves signed-ID rule on object and bytes', () => {
  const tuple=clone(fullVectors.cursors[4].decodedTuple);tuple[9][1]=-0;
  rejection(()=>encodeMaintenanceCursor(tuple));
  const text=fullVectors.cursors[4].canonicalUtf8.replace(',0]]',',-0]]');
  rejection(()=>decodeMaintenanceCursor(Buffer.from(text).toString('base64url')));
});
for (const [label,make] of [
  ['padding',s=>s+'='],['invalid alphabet',s=>s+'!'],['space',s=>' '+s],['non-ASCII',s=>s+'é'],
  ['oversize',()=> 'A'.repeat(1025)],['empty',()=> ''],['non-string',()=>Buffer.from('abc')],
  ['base64 encoded BOM',s=>Buffer.concat([Buffer.from([239,187,191]),Buffer.from(s,'base64url')]).toString('base64url')],
  ['base64 encoded newline',s=>Buffer.concat([Buffer.from(s,'base64url'),Buffer.from('\n')]).toString('base64url')],
  ['base64 encoded invalid UTF8',()=>Buffer.from([255]).toString('base64url')],
  ['alternative escaped text',s=>Buffer.from(Buffer.from(s,'base64url').toString().replace('maintenance','\\u006daintenance')).toString('base64url')],
]) test(`cursor strict transport: ${label}`, () => {
  const s=fullVectors.cursors[0].canonicalBase64url;
  assert.deepEqual(decodeMaintenanceCursor(s),fullVectors.cursors[0].decodedTuple);
  rejection(()=>decodeMaintenanceCursor(make(s)));
});

test('future v5 missing-head, historical-head and current-session shapes remain plain DTOs', () => {
  for (const shape of ['missing','historical','current','fault-missing','fault-historical','fault-current']) {
    const p=literalPlan('empty-v4-end'), t=p.timeEvidence;t.schemaVersion=5;
    if (!shape.includes('missing')) {t.anchorGeneration=1;t.anchorHash=fullVectors.policyHash;t.anchorWallAt=p.createdAt;}
    if (shape.includes('current')) {t.sessionNonce=uuid(70);t.monotonicElapsedMs=0;}
    t.executable=shape==='current';
    t.reason=shape.startsWith('fault') ? 'CLOCK_UNSAFE' : shape==='missing' ? 'TIME_ANCHOR_REQUIRED' : shape==='historical' ? 'PROCESS_REANCHOR_REQUIRED' : null;
    const output=decodeMaintenancePlan(encodeMaintenancePlan(p));
    assert.deepEqual(output,p);assertFrozenTree(output);
    assert.deepEqual(Reflect.ownKeys(output),Object.keys(p));
    assert.equal(typeof hashMaintenancePlan(output),'string');
  }
});
for (const [label,mutate] of [
  ['missing head claims reanchor',t=>t.reason='PROCESS_REANCHOR_REQUIRED'],
  ['missing head claims executable',t=>{t.executable=true;t.reason=null;}],
  ['partial head',t=>t.anchorGeneration=1],
  ['session without head',t=>{t.sessionNonce=uuid(70);t.monotonicElapsedMs=0;}],
  ['historical head claims missing',t=>{t.anchorGeneration=1;t.anchorHash=fullVectors.policyHash;t.anchorWallAt=20000000000;t.reason='TIME_ANCHOR_REQUIRED';}],
  ['historical head claims executable',t=>{t.anchorGeneration=1;t.anchorHash=fullVectors.policyHash;t.anchorWallAt=20000000000;t.reason=null;t.executable=true;}],
  ['v4 upgrade reason on v5',t=>t.reason='SCHEMA_UPGRADE_REQUIRED'],
]) test(`future v5 structural rejection: ${label}`, () => {
  const p=literalPlan('empty-v4-end');p.timeEvidence.schemaVersion=5;p.timeEvidence.reason='TIME_ANCHOR_REQUIRED';accepted(p);
  mutate(p.timeEvidence);rejection(()=>encodeMaintenancePlan(p));
});

for (const [label,mutate] of [
  ['undefined nullable',p=>p.timeEvidence.anchorHash=undefined],
  ['toJSON',p=>p.toJSON=()=>({SENSITIVE_CANARY:true})],
  ['nonenumerable extra',p=>Object.defineProperty(p,'hidden',{value:'SENSITIVE_CANARY'})],
  ['symbol',p=>p[Symbol('SENSITIVE_CANARY')]=1],
  ['exotic prototype',p=>Object.setPrototypeOf(p,{})],
  ['null prototype',p=>Object.setPrototypeOf(p,null)],
  ['cycle',p=>p.scan.held=p],
  ['sparse candidates',p=>p.candidates=new Array(1)],
  ['array extra',p=>p.candidates.extra='SENSITIVE_CANARY'],
  ['nested symbol',p=>p.selection[Symbol('SENSITIVE_CANARY')]=1],
  ['function',p=>p.runId=()=>{}],
  ['boxed primitive',p=>p.runId=new String(p.runId)],
  ['lone surrogate',p=>p.runId='\ud800'],
]) test(`data-only rejection: ${label}`, () => {
  const p=literalPlan('empty-v4-end');accepted(p);mutate(p);
  rejection(()=>encodeMaintenancePlan(p));rejection(()=>hashMaintenancePlan(p));
});
test('data-only accessors never execute, including nested/array/toJSON', () => {
  for (const target of ['root','nested','array','toJSON']) {
    const p=literalPlan('expire-only');accepted(p);let hits=0;
    const obj=target==='root' || target==='toJSON' ? p : target==='nested' ? p.candidates[0] : p.candidates;
    const key=target==='root' ? 'runId' : target==='nested' ? 'expectedRows' : target==='array' ? '0' : 'toJSON';
    Object.defineProperty(obj,key,{enumerable:true,get(){hits++;throw Error('SENSITIVE_CANARY');}});
    rejection(()=>encodeMaintenancePlan(p));assert.equal(hits,0);
  }
});
test('byte input is ordinary non-shared Uint8Array/Buffer storage only', () => {
  const bytes=Buffer.from(literalVector('empty-v4-end').canonicalUtf8);
  assert.deepEqual(decodeMaintenancePlan(new Uint8Array(bytes)),literalPlan('empty-v4-end'));
  for (const bad of [bytes.toString(),bytes.buffer,new DataView(bytes.buffer),new Uint16Array(2),
    new Uint8Array(new SharedArrayBuffer(bytes.length)),Buffer.from(new SharedArrayBuffer(bytes.length))]) rejection(()=>decodeMaintenancePlan(bad));
});
test('metadata input cap uses exact UTF-8 bytes at 65536 and 65537, before parsing', () => {
  const s=literalVector('empty-v4-end').canonicalUtf8;
  const edge=s+' '.repeat(65536-Buffer.byteLength(s));
  assert.equal(Buffer.byteLength(edge),65536);
  // Whitespace is deliberately noncanonical. At the ceiling this is a codec
  // error, not a size error. One more byte must take the metadata-limit path.
  rejection(()=>decodeMaintenancePlan(Buffer.from(edge)));
  rejection(()=>decodeMaintenancePlan(Buffer.from(edge+' ')),'MAINTENANCE_METADATA_LIMIT');
  const unicode='"'+'é'.repeat(32768)+'"';
  assert.ok(unicode.length<65536);assert.ok(Buffer.byteLength(unicode)>65536);
  rejection(()=>decodeMaintenancePlan(Buffer.from(unicode)),'MAINTENANCE_METADATA_LIMIT');
});
test('nested ownership and returned buffer defensive copies', () => {
  const v=literalVector('audit-mixed'), p=JSON.parse(v.canonicalUtf8), saved=clone(p);
  const first=encodeMaintenancePlan(p), second=encodeMaintenancePlan(p);
  assert.notEqual(first,second);first.fill(0);
  assert.deepEqual(Buffer.from(second),Buffer.from(v.canonicalUtf8));
  assert.deepEqual(p,saved);
  const view=Buffer.concat([Buffer.from('prefix'),Buffer.from(v.canonicalUtf8),Buffer.from('suffix')]);
  const decoded=decodeMaintenancePlan(view.subarray(6,view.length-6));view.fill(0);
  assert.deepEqual(decoded,saved);assertFrozenTree(decoded);
  p.candidates[0].key[1]=-99;p.scan.held[0].key[1]=-98;
  assert.equal(hashMaintenancePlan(decoded),v.expectedPlanHash);
  assert.throws(()=>decoded.candidates[0].key.push(1),TypeError);
  assert.throws(()=>decoded.scan.heldCounts.auditProtected++,TypeError);
  const t=clone(fullVectors.cursors[0].decodedTuple), text=encodeMaintenanceCursor(t), result=decodeMaintenanceCursor(text);
  t[9][0]++;assert.deepEqual(result,fullVectors.cursors[0].decodedTuple);assertFrozenTree(result);
});
test('plan timing is bound by plan hash but excluded from candidate digest', () => {
  const p=literalPlan('expire-only'), originalDigest=p.candidateDigest, originalHash=literalVector('expire-only').expectedPlanHash;
  p.createdAt++;p.expiresAt++;p.clockObservedAt++;p.timeEvidence.observedWallAt++;
  accepted(p);assert.equal(p.candidateDigest,originalDigest);assert.notEqual(hashMaintenancePlan(p),originalHash);
});

test('signed audit IDs retain negative and zero values in complete plan bytes', () => {
  const v=literalVector('audit-signed-unicode'), p=literalPlan('audit-signed-unicode');
  assert.deepEqual(p.candidates.map(c=>c.auditId),[-9007199254740991,0,9007199254740991]);
  assert.deepEqual(decodeMaintenancePlan(Buffer.from(v.canonicalUtf8)).candidates.map(c=>c.auditId),p.candidates.map(c=>c.auditId));
  for (const bad of [-0,9007199254740992,-9007199254740992]) {
    const q=clone(p);q.candidates[1].auditId=bad;q.candidates[1].key[1]=bad;
    rejection(()=>encodeMaintenancePlan(q));
  }
});
for (const [field,max] of [['maxRows',100],['maxBytes',10485760],['maxScanRows',10000],['maxScanBytes',104857600],
  ['maxScanMs',1000],['maxWriteMs',1000],['maxForwardJumpMs',86400000]]) {
  negativePlan(`budget ${field} maximum`,'empty-v4-end',p=>{
    p.budget[field]=max+1;
    if (field==='maxForwardJumpMs') p.timeEvidence.maxForwardJumpMs=max+1;
  });
  negativePlan(`budget ${field} positive`,'empty-v4-end',p=>{
    p.budget[field]=0;
    if (field==='maxForwardJumpMs') p.timeEvidence.maxForwardJumpMs=0;
  });
}
test('decoder duplicates inside candidate and held entries are rejected', () => {
  const text=literalVector('audit-mixed').canonicalUtf8;
  assert.deepEqual(decodeMaintenancePlan(Buffer.from(text)),JSON.parse(text));
  for (const modified of [text.replace('"expectedState":null','"expectedState":null,"expectedState":null'),
    text.replace('"reason":"AUDIT_PROTECTED"','"reason":"AUDIT_PROTECTED","\\u0072eason":"AUDIT_PROTECTED"')]) {
    rejection(()=>decodeMaintenancePlan(Buffer.from(modified)));
  }
});
test('cursor noncanonical base64 unused bits are rejected', () => {
  const v=fullVectors.cursors.find(v=>Buffer.byteLength(v.canonicalUtf8)%3!==0);
  assert.ok(v);
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const canonical=v.canonicalBase64url;
  const altered=canonical.slice(0,-1)+alphabet[alphabet.indexOf(canonical.at(-1))+1];
  assert.deepEqual(Buffer.from(altered,'base64url'),Buffer.from(canonical,'base64url'));
  rejection(()=>decodeMaintenanceCursor(altered));
});
test('cursor array data-only accessors, sparse, properties and symbols', () => {
  for (const mode of ['accessor','sparse','extra','symbol','nonenumerable','prototype','undefined']) {
    const t=clone(fullVectors.cursors[0].decodedTuple);let hits=0;
    assert.equal(encodeMaintenanceCursor(t),fullVectors.cursors[0].canonicalBase64url);
    if (mode==='accessor') Object.defineProperty(t[9],'0',{get(){hits++;throw Error('SENSITIVE_CANARY');},enumerable:true});
    if (mode==='sparse') delete t[9][0];
    if (mode==='extra') t[9].extra=1;
    if (mode==='symbol') t[9][Symbol('SENSITIVE_CANARY')]=1;
    if (mode==='nonenumerable') Object.defineProperty(t[9],'hidden',{value:1});
    if (mode==='prototype') Object.setPrototypeOf(t[9],{});
    if (mode==='undefined') t[9][0]=undefined;
    rejection(()=>encodeMaintenanceCursor(t));assert.equal(hits,0);
  }
});

negativePlan('same candidate identity at different eligible times','tied-content-keys',p=>{
  const first=p.candidates[0], second=p.candidates[1];
  first.key[0]--;first.expiresAt--;
  second.messageId=first.messageId;second.key[1]=first.key[1];
  p.scan.plannedRangeEnd=clone(second.key);p.scan.lastScanned=clone(second.key);
},'MAINTENANCE_CODEC_INVALID',true);
test('future v5 current session has coherent reason and both session fields', () => {
  const p=literalPlan('empty-v4-end'), t=p.timeEvidence;
  Object.assign(t,{schemaVersion:5,anchorGeneration:1,anchorHash:fullVectors.policyHash,anchorWallAt:p.createdAt,
    sessionNonce:uuid(70),monotonicElapsedMs:0,executable:true,reason:null});accepted(p);
  for (const mutate of [t=>t.sessionNonce=null,t=>t.monotonicElapsedMs=null,t=>t.reason='PROCESS_REANCHOR_REQUIRED',
    t=>{t.executable=false;t.reason=null;},t=>{t.executable=true;t.reason='CLOCK_UNSAFE';}]) {
    const q=clone(p);mutate(q.timeEvidence);rejection(()=>encodeMaintenancePlan(q));
  }
});
test('unknown nested data beyond depth sixteen is rejected safely', () => {
  const p=literalPlan('empty-v4-end');accepted(p);
  let nested=null;for (let i=0;i<17;i++) nested=[nested];
  p.extra=nested;rejection(()=>encodeMaintenancePlan(p));
  rejection(()=>decodeMaintenancePlan(Buffer.from(JSON.stringify(p))));
  // This establishes safe rejection only; exact-shape rejection may precede the
  // depth check. The public plan schema has no free-form depth-16 field.
});

// Oracle follow-up gates. These test public behavior only and intentionally
// remain failing on an unfixed source; no private codec helpers are imported.
for (const [api,invoke] of [
  ['encode',p=>encodeMaintenancePlan(p)],
  ['decode',p=>decodeMaintenancePlan(Buffer.from(JSON.stringify(p)))],
  ['hash',p=>hashMaintenancePlan(p)],
]) test(`oracle scan timeout: complete overrun rejected by ${api}`, () => {
  const p=literalPlan('empty-v4-end');
  p.scan.elapsedMs=p.budget.maxScanMs;invoke(p); // equality is within the cap
  p.scan.elapsedMs++;rejection(()=>invoke(p));
});
test('oracle scan timeout: incomplete SCAN_TIME overrun remains a valid diagnostic', () => {
  for (const name of ['incomplete-empty','incomplete-prefix']) {
    const p=literalPlan(name);
    p.scan.stopReason='SCAN_TIME';p.scan.elapsedMs=p.budget.maxScanMs+1;
    const canonical=Buffer.from(JSON.stringify(p));
    assert.deepEqual(Buffer.from(encodeMaintenancePlan(p)),canonical);
    assert.deepEqual(decodeMaintenancePlan(canonical),p);
    assert.equal(hashMaintenancePlan(p),hash('a2a-msg.im.maintenance.plan.v2',canonical));
  }
});

// Construct valid controls with two distinct IDs, then change only the second
// identity to the first. Times remain different, sorting remains strict, and
// every affected digest/cursor/range binding is independently recomputed.
function identityControl(kind, location, tied = false) {
  const p=literalPlan(kind==='audit' ? 'audit-signed-unicode' : 'scrub-attachment');
  const template=clone(p.candidates[0]);
  const time=p.selection.eligibleThroughAt;
  const ids=kind==='audit' ? [-7,0] : [uuid(81),uuid(82)];
  const items=ids.map((id,index)=>{
    const c=clone(template);c.key=[time-(tied ? 0 : 1-index),id];
    c.messageId=kind==='audit' ? null : id;c.auditId=kind==='audit' ? id : null;
    if(kind!=='audit') c.expiresAt=c.key[0];
    return c;
  });
  const asHeld=c=>({key:clone(c.key),messageId:c.messageId,auditId:c.auditId,
    reason:kind==='audit' ? 'AUDIT_PROTECTED' : 'OVERSIZED_GROUP',expectedFingerprint:c.expectedFingerprint,
    expectedRows:kind==='audit' ? 0 : 3,expectedBytes:kind==='audit' ? 0 : 10485761});
  p.candidates=location==='candidates' ? items : location==='cross' ? [items[0]] : [];
  p.scan.held=location==='held' ? items.map(asHeld) : location==='cross' ? [asHeld(items[1])] : [];
  p.budget.plannedRows=p.candidates.reduce((n,c)=>n+c.expectedRows,0);
  p.budget.plannedBytes=p.candidates.reduce((n,c)=>n+c.expectedBytes,0);
  p.scan.plannedRangeEnd=clone(items[1].key);p.scan.lastScanned=clone(items[1].key);
  p.scan.nextCursor=null;p.scan.hasMore=false;p.scan.complete=true;p.scan.stopReason='END';
  p.scan.candidateCount=p.candidates.length;p.scan.heldCount=p.scan.held.length;p.scan.skippedCount=p.scan.held.length;
  p.scan.heldCounts={oversizedGroup:kind==='audit' ? 0 : p.scan.held.length,
    auditProtected:kind==='audit' ? p.scan.held.length : 0,auditActionUnknown:0};
  return rebind(p);
}
for (const kind of ['scrub','audit']) for (const location of ['candidates','held','cross']) {
  test(`oracle distinct identity tied-time valid: ${kind}/${location}`,()=>{
    const p=identityControl(kind,location,true), canonical=Buffer.from(JSON.stringify(p));
    assert.deepEqual(Buffer.from(encodeMaintenancePlan(p)),canonical);
    assert.deepEqual(decodeMaintenancePlan(canonical),p);
    assert.equal(hashMaintenancePlan(p),hash('a2a-msg.im.maintenance.plan.v2',canonical));
  });
  for (const [api,invoke] of [
    ['encode',p=>encodeMaintenancePlan(p)],
    ['decode',p=>decodeMaintenancePlan(Buffer.from(JSON.stringify(p)))],
    ['hash',p=>hashMaintenancePlan(p)],
  ]) test(`oracle repeated identity across timestamps: ${kind}/${location}/${api}`,()=>{
    const p=identityControl(kind,location);accepted(p);invoke(p);
    const first=location==='held' ? p.scan.held[0] : p.candidates[0];
    const second=location==='candidates' ? p.candidates[1] : p.scan.held.at(-1);
    assert.notEqual(first.key[0],second.key[0]);
    second.key[1]=first.key[1];second.messageId=first.messageId;second.auditId=first.auditId;
    p.scan.plannedRangeEnd=clone(second.key);p.scan.lastScanned=clone(second.key);
    rebind(p);
    rejection(()=>invoke(p));
  });
}

function hostileException(mode, counters) {
  if(mode==='getter') {
    const error=new Error('SENSITIVE_CANARY original');
    Object.defineProperty(error,'code',{get(){counters.codeReads++;throw Error('SENSITIVE_CANARY getter');}});
    return error;
  }
  if(mode==='proxy') return new Proxy({}, {get(){counters.codeReads++;throw Error('SENSITIVE_CANARY proxy');}});
  if(mode==='forged-metadata') return {code:'MAINTENANCE_METADATA_LIMIT',message:'SENSITIVE_CANARY forged'};
  if(mode==='forged-error') return Object.assign(new Error('SENSITIVE_CANARY forged error'),{code:'MAINTENANCE_METADATA_LIMIT'});
  throw Error('unknown test exception mode');
}
for (const mode of ['getter','proxy','forged-metadata','forged-error']) {
  for (const api of ['encode-plan','hash-plan','encode-cursor','decode-plan']) {
    test(`oracle safe error boundary: ${mode}/${api}`,()=>{
      const counters={codeReads:0,traps:0}, thrown=hostileException(mode,counters);
      const trap=()=>{counters.traps++;throw thrown;};
      let invoke;
      if(api==='encode-plan' || api==='hash-plan') {
        const p=literalPlan('empty-v4-end');accepted(p);
        const hostile=new Proxy(p,{ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap});
        invoke=()=>api==='encode-plan' ? encodeMaintenancePlan(hostile) : hashMaintenancePlan(hostile);
      } else if(api==='encode-cursor') {
        const tuple=clone(fullVectors.cursors[0].decodedTuple);
        assert.equal(encodeMaintenanceCursor(tuple),fullVectors.cursors[0].canonicalBase64url);
        const hostile=new Proxy(tuple,{ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap,get:trap});
        invoke=()=>encodeMaintenanceCursor(hostile);
      } else {
        const bytes=Buffer.from(literalVector('empty-v4-end').canonicalUtf8);
        assert.deepEqual(decodeMaintenancePlan(bytes),literalPlan('empty-v4-end'));
        const hostile=new Proxy(bytes,{getPrototypeOf:trap,get:trap});
        invoke=()=>decodeMaintenancePlan(hostile);
      }
      rejection(invoke); // forged public code must not become metadata-limit
      assert.equal(counters.codeReads,0,'safe boundary must not inspect attacker exception.code');
      // Some byte brand checks can reject a Proxy before any trap; that is safe.
      if(api!=='decode-plan') assert.ok(counters.traps>0,'exercise an actual attacker-thrown exception');
    });
  }
}
test('oracle genuine metadata overflow preserves its fixed code after error hardening',()=>{
  const bytes=Buffer.from(literalVector('empty-v4-end').canonicalUtf8);
  assert.deepEqual(decodeMaintenancePlan(bytes),literalPlan('empty-v4-end'));
  const excessive=Buffer.alloc(65537,32);bytes.copy(excessive);
  rejection(()=>decodeMaintenancePlan(excessive),'MAINTENANCE_METADATA_LIMIT');
});
