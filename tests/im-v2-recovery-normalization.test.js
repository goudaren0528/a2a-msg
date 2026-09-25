import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRecoveryRecord as encode, decodeRecoveryRecord as decode, hashRecoveryRecord as digest,
  validateRecoveryNormalizationBindings as validate, validateRecoveryPauseBindings as pause } from '../src/im/v2/recovery-plan.js';
import { fields, bytes, sha, recordHash, chainForStage, rechain } from './fixtures/im-v2-recovery-normalization/records.js';
import { runChild } from './fixtures/im-v2-recovery-normalization/processes.js';
import { readFileSync } from 'node:fs';

const golden=JSON.parse(readFileSync(new URL('./fixtures/im-v2-schema/checksums.json',import.meta.url)));
const U='00000000-0000-0000-0000-000000000001', V='00000000-0000-0000-0000-000000000002';
const H='a'.repeat(64), F='b'.repeat(64), P='d'.repeat(64);
function fixture({mode='paused',header='DELETE',route='closed'}={}) {
  const snapshot=route==='snapshot',fresh=route==='fresh',registered=route!=='closed';
  const candidateKind=fresh?'fresh_bootstrap':snapshot?'snapshot_recovery':'v3_import';
  const schemaVersion=snapshot?4:3,schemaChecksum=snapshot?golden.v4:golden.v3;
  const sourceEvidence=fresh?null:registered?{version:1,kind:'registered-backup',sourceRef:`backup:${V}`,registryFormat:snapshot?3:2,
    instanceId:U,instanceCreatedAt:1,backupId:V,fileHash:F,manifestHash:H,schemaVersion,schemaChecksum,completedAt:10,importedRecordHash:snapshot?null:H}:
    {version:1,kind:'closed-source',sourceRef:'source',instanceId:U,instanceCreatedAt:1,schemaVersion,schemaChecksum,closedSourceFileHash:F,observedAt:10,isolationAckRef:'isolated'};
  const stage={version:1,requestRef:'normalization',requestHash:sha(JSON.stringify([candidateKind,fresh?null:'source',fresh?null:'isolated',P])),
    runId:U,candidateKind,sourceRef:fresh?null:'source',sourceEvidence,sourceClosedEvidenceRef:fresh?null:'synthetic-proof',
    sourceClosedEvidenceHash:fresh?null:H,isolationAckRef:fresh?null:'isolated',policyHash:P,candidateReference:`runs/${U}/candidate.sqlite`,
    preparationRef:snapshot?null:'preparation',createdAt:20};
  if(fresh)return {stage,copyIntent:null,base:null,normalizationIntent:null,normalized:null,pauseIntent:null,paused:null};
  return chainForStage(stage,mode,header);
}
const mismatch=fn=>assert.throws(fn,{code:'RECOVERY_EVIDENCE_MISMATCH'});
const clone=x=>structuredClone(x);

for(const route of ['closed','registered','snapshot'])for(const header of ['DELETE','WAL'])for(const mode of ['paused','enabled']) {
  test(`pure ${route}/${header}/${mode}: canonical chain with original source base`,()=>{
    const f=fixture({route,header,mode});
    assert.deepEqual(validate(f),f.normalized);
    if(route!=='snapshot')assert.deepEqual(pause(f),f.paused);
    for(const kind of Object.keys(fields)) {
      assert.equal(encode(kind,f[kind]).toString(),bytes(kind,f[kind]).toString());
      assert.equal(digest(kind,f[kind]),recordHash(kind,f[kind]));
      assert.deepEqual(decode(kind,bytes(kind,f[kind])),f[kind]);
    }
    assert.equal(f.stage.sourceEvidence.fileHash??f.stage.sourceEvidence.closedSourceFileHash,F);
    assert.equal(f.paused.pauseInputHash,f.normalized.normalizedCandidateHash);
    if(header==='WAL'&&mode==='paused') {
      assert.notEqual(f.paused.pausedCandidateHash,F);
      assert.equal(f.paused.changed,false);
      assert.equal(f.paused.pausedCandidateHash,f.normalized.normalizedCandidateHash);
    }
  });
}

test('literal copy-intent bytes and fixed independent SHA-256 vector',()=>{
  const literal=`{"version":1,"runId":"${U}","stageHash":"${H}","candidateReference":"runs/${U}/candidate.sqlite","candidateBaseHash":"${F}","sourceSchemaVersion":3,"sourceSchemaChecksum":"${golden.v3}","sourceWriteMode":"paused","copyStartedAt":42}`;
  const record=JSON.parse(literal);
  assert.equal(encode('copyIntent',record).toString(),literal);
  assert.equal(digest('copyIntent',record),'0d9e80d9dbdee0a366e76553297161f87238aa7ba2308a865ec15f0c6ac636af');
  assert.deepEqual(decode('copyIntent',Buffer.from(literal)),record);
});

test('amended records reject omitted/extra/reordered fields, old experimental versions and unsafe timestamps',()=>{
  const f=fixture();assert.deepEqual(validate(f),f.normalized);
  for(const [kind,keys]of Object.entries(fields)) {
    for(const field of keys) {const r=clone(f[kind]);delete r[field];assert.throws(()=>encode(kind,r),{code:'RECOVERY_INVALID'});}
    assert.throws(()=>encode(kind,{...f[kind],extra:1}),{code:'RECOVERY_INVALID'});
    const reordered=Object.fromEntries(Object.entries(f[kind]).reverse());
    mismatch(()=>decode(kind,Buffer.from(JSON.stringify(reordered))));
    mismatch(()=>decode(kind,Buffer.concat([bytes(kind,f[kind]),Buffer.from('\n')])));
    const timeKey=keys.at(-1);
    for(const value of [-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>encode(kind,{...f[kind],[timeKey]:value}),{code:'RECOVERY_INVALID'});
  }
  const oldBase={...f.base,version:1,copiedAt:20};delete oldBase.copyIntentHash;delete oldBase.copyStartedAt;
  assert.throws(()=>encode('base',oldBase),{code:'RECOVERY_INVALID'});
  for(const kind of ['pauseIntent','paused'])assert.throws(()=>encode(kind,{...f[kind],version:1}),{code:'RECOVERY_INVALID'});
});

test('all proofs required; fresh forbids every copy/normalization/pause evidence record',()=>{
  const f=fixture();assert.deepEqual(validate(f),f.normalized);assert.deepEqual(pause(f),f.paused);
  for(const kind of Object.keys(fields)) {
    const missing=clone(f);delete missing[kind];mismatch(()=>pause(missing));
    if(!['pauseIntent','paused'].includes(kind))mismatch(()=>validate(missing));
    const fresh=fixture({route:'fresh'});
    // Normalization's successful return is specified for nonfresh chains only.
    // A fresh route must reject injected evidence; no synthetic success DTO is assumed.
    assert.deepEqual(validate(f),f.normalized);
    fresh[kind]=f[kind];mismatch(()=>validate(fresh));
  }
});

test('coherent complete rehash cannot replace original source hash, schema or candidate subject',()=>{
  for(const [field,value]of [['candidateBaseHash',H],['sourceSchemaVersion',4],['sourceSchemaChecksum',H],['runId',V],['candidateReference',`runs/${V}/candidate.sqlite`]]) {
    const f=fixture({header:'WAL'});assert.deepEqual(validate(f),f.normalized);assert.deepEqual(pause(f),f.paused);
    const changed=clone(f);
    for(const kind of Object.keys(fields))if(field in changed[kind])changed[kind][field]=value;
    if(field==='runId'||field==='candidateReference')for(const kind of Object.keys(fields)) {
      changed[kind].runId=V;
      if('candidateReference'in changed[kind])changed[kind].candidateReference=`runs/${V}/candidate.sqlite`;
    }
    if(field==='sourceSchemaVersion'||field==='sourceSchemaChecksum')for(const kind of ['copyIntent','base']) {
      changed[kind].sourceSchemaVersion=4;changed[kind].sourceSchemaChecksum=golden.v4;
    }
    rechain(changed);
    for(const kind of Object.keys(fields))assert.deepEqual(decode(kind,bytes(kind,changed[kind])),changed[kind]);
    assert.deepEqual(changed.stage,f.stage);mismatch(()=>validate(changed));mismatch(()=>pause(changed));
  }
});

test('each chain hash, copied mode/time, header semantics and step time cross-binding is enforced',()=>{
  const changes=[
    f=>{f.base.copyIntentHash=H;},f=>{f.normalizationIntent.baseRecordHash=H;},
    f=>{f.normalized.normalizationIntentHash=H;},f=>{f.pauseIntent.normalizedRecordHash=H;f.paused.pauseIntentHash=recordHash('pauseIntent',f.pauseIntent);},
    f=>{f.paused.pauseIntentHash=H;},f=>{f.base.sourceWriteMode='enabled';rechain(f);},
    f=>{f.base.copyStartedAt++;rechain(f);},f=>{f.copyIntent.copyStartedAt=19;f.base.copyStartedAt=19;rechain(f);},
    f=>{f.normalizationIntent.createdAt=19;rechain(f);},f=>{f.normalized.normalizedAt=19;rechain(f);},
    f=>{f.pauseIntent.createdAt=19;rechain(f);},f=>{f.paused.pausedAt=19;},
    f=>{f.normalized.changed=true;rechain(f);},f=>{f.normalized.normalizedCandidateHash=H;rechain(f);},
    f=>{f.pauseIntent.pauseInputHash=H;rechain(f);},f=>{f.paused.pauseInputHash=H;},
  ];
  for(const mutate of changes) {const f=fixture();assert.deepEqual(pause(f),f.paused);mutate(f);mismatch(()=>pause(f));}
  for(const kind of ['copyIntent','base','normalizationIntent','normalized','pauseIntent','paused']) {
    const f=fixture();assert.deepEqual(pause(f),f.paused);f[kind].stageHash=H;rechain(f);mismatch(()=>pause(f));
  }
  const wal=fixture({header:'WAL'});assert.deepEqual(pause(wal),wal.paused);
  wal.normalized.changed=false;rechain(wal);mismatch(()=>pause(wal));
  for(const mode of ['PERSIST','TRUNCATE','wal'])assert.throws(()=>encode('normalizationIntent',{...fixture().normalizationIntent,originalHeaderMode:mode}),{code:'RECOVERY_INVALID'});
  assert.throws(()=>encode('normalizationIntent',{...fixture().normalizationIntent,targetHeaderMode:'WAL'}),{code:'RECOVERY_INVALID'});
});

const scenarios=[
  'registered-wal-paused','registered-wal-enabled','closed-wal-paused','closed-wal-enabled',
  'snapshot-delete','copy-durable','intent-durable','normalization-committed','delete-noop','p1-committed',
  'partial16','wronghash','missing-copy-intent','doublelink','pending','sourcechanged',
  'candidate-wal','candidate-shm','candidate-journal','source-wal','source-shm','source-journal',
  'broken-chain-status','coherent-tamper-status','p1-broken-chain','snapshot-stale-hash','old-base-v1',
  ...Object.keys(fields).map(kind=>`fresh-evidence-${kind}`),
];
for(const scenario of scenarios)test(`native normalization: ${scenario}`,{skip:process.platform==='win32',timeout:30000},async t=>{
  const result=await runChild(t,{scenario});
  assert.equal(result.scenario,scenario);assert.equal(result.passed,true);
});
