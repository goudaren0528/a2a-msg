import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bytes as recordBytes, chainForStage, recordHash, rechain } from './fixtures/im-v2-recovery-normalization/records.js';
import { V3_CHECKSUM } from '../src/im/v2/schema-history.js';
import { V4_CHECKSUM } from '../src/im/v2/schema-internal.js';
import { encodeRecoveryRecord as encode, decodeRecoveryRecord as decode, hashRecoveryRecord as digest,
  hashRecoveryRequestRef, hashRecoveryRequestInput, validateRecoveryLocator, validateRecoveryPlanBindings,
  assertRecoveryPlanFresh, validateRecoveryNormalizationBindings, validateRecoveryPauseBindings } from '../src/im/v2/recovery-plan.js';

const U='00000000-0000-0000-0000-000000000001', B='00000000-0000-0000-0000-000000000002', E='00000000-0000-0000-0000-000000000003';
const H='a'.repeat(64), F='b'.repeat(64), M='c'.repeat(64), P='d'.repeat(64);
const sha=x=>createHash('sha256').update(x).digest('hex');
const bad=(fn,code='RECOVERY_INVALID')=>assert.throws(fn,e=>e.code===code);
function fixture(route='fresh') {
  const fresh=route==='fresh',closed=route==='closed',snapshot=route==='snapshot';
  const candidateKind=fresh?'fresh_bootstrap':snapshot?'snapshot_recovery':'v3_import';
  const sourceRef=fresh?null:'catalog:key';
  const isolationAckRef=fresh?null:'isolated';
  const schemaChecksum=snapshot?V4_CHECKSUM:V3_CHECKSUM;
  const sourceEvidence=fresh?null:closed?{version:1,kind:'closed-source',sourceRef,instanceId:U,instanceCreatedAt:10,schemaVersion:3,schemaChecksum,closedSourceFileHash:F,observedAt:21,isolationAckRef}:
    {version:1,kind:'registered-backup',sourceRef:`backup:${B}`,registryFormat:snapshot?3:2,instanceId:U,instanceCreatedAt:10,backupId:B,fileHash:F,manifestHash:M,schemaVersion:snapshot?4:3,schemaChecksum,completedAt:20,importedRecordHash:snapshot?null:H};
  const proof=fresh?null:{version:1,evidenceRef:'proof:one',sourceRef,isolationAckRef,sourceKind:closed?'closed-source':'registered-backup',instanceId:U,instanceCreatedAt:10,schemaVersion:snapshot?4:3,schemaChecksum,fileHash:F,backupId:closed?null:B,manifestHash:closed?null:M,issuedAt:19};
  const stage={version:1,requestRef:'request',requestHash:hashRecoveryRequestInput({candidateKind,sourceRef,isolationAckRef,policyHash:P}),runId:U,candidateKind,sourceRef,sourceEvidence,sourceClosedEvidenceRef:proof?.evidenceRef??null,sourceClosedEvidenceHash:proof?digest('closureProof',proof):null,isolationAckRef,policyHash:P,candidateReference:`runs/${U}/candidate.sqlite`,preparationRef:snapshot?null:'prepare:one',createdAt:22};
  const stageHash=digest('stage',stage);
  const staged={version:1,runId:U,stageHash,candidateBaseHash:fresh?null:F,preparationRef:stage.preparationRef,instanceId:U,instanceCreatedAt:10,initialEpoch:E,importEpoch:fresh||snapshot?null:B,stagedAt:23};
  const base=fresh?null:chainForStage(stage).base;
  const rpoReport=fresh?null:{status:'unknown',snapshotCompletedAt:closed?null:20,sourceObservedAt:closed?21:null,missingAcceptedCount:null,missingAckCount:null,missingReadCount:null,comparisonEvidenceHash:null,authChanges:'unknown',notesCode:'COMPARISON_INCOMPLETE'};
  const plan={version:1,runId:U,candidateKind,preparationRef:stage.preparationRef,instanceId:U,instanceCreatedAt:10,backupId:fresh||closed?null:B,backupFileHash:fresh||closed?null:F,manifestHash:fresh||closed?null:M,sourceSchemaVersion:fresh?null:snapshot?4:3,sourceSchemaChecksum:fresh?null:schemaChecksum,candidateReference:stage.candidateReference,oldEpoch:snapshot?E:null,newEpoch:snapshot?B:E,recoveryCounter:snapshot?8:0,policyHash:P,rpoReport,sourceEvidence,sourceClosedEvidenceRef:proof?.evidenceRef??null,isolationAckRef,createdAt:100,expiresAt:300100};
  const locator={version:1,requestRef:'request',requestHash:stage.requestHash,runId:U,stage,sourceClosedEvidence:proof,stageHash};
  const binding=proof&&Object.fromEntries(['sourceRef','isolationAckRef','sourceKind','instanceId','instanceCreatedAt','schemaVersion','schemaChecksum','fileHash','backupId','manifestHash'].map(k=>[k,proof[k]]));
  return {plan,stage,staged,base,proof,locator,binding,previousRecoveryCounter:snapshot?7:null};
}
test('literal ordered bytes and independently fixed SHA-256 vectors',()=>{
  const intent={version:2,runId:U,stageHash:H,candidateBaseHash:F,normalizedRecordHash:M,pauseInputHash:F,originalWriteMode:'enabled',targetWriteMode:'paused',createdAt:42};
  const literal=`{"version":2,"runId":"${U}","stageHash":"${H}","candidateBaseHash":"${F}","normalizedRecordHash":"${M}","pauseInputHash":"${F}","originalWriteMode":"enabled","targetWriteMode":"paused","createdAt":42}`;
  assert.equal(encode('pauseIntent',{...intent}).toString(),literal);
  assert.equal(digest('pauseIntent',intent),'0aa5d2b3ebb3c243ecf28516fd6c927e21e111caf70e3d35f1da6c9702fa8f6b');
  assert.deepEqual(decode('pauseIntent',Buffer.from(literal)),intent);
  assert.equal(hashRecoveryRequestRef('é'),'f2886017e9c7abacf804b54d64787dce2b611c9544ba21f3affdd126a6e50086');
  assert.equal(hashRecoveryRequestRef('e\u0301'),sha(Buffer.from('"e\u0301"')));
  assert.notEqual(hashRecoveryRequestRef('é'),hashRecoveryRequestRef('e\u0301'));
});
test('four source routes, locator full proof, plan bindings and detached deep freeze',()=>{
  for (const route of ['fresh','registered','closed','snapshot']) {
    const f=fixture(route);
    assert.deepEqual(validateRecoveryLocator(f.locator,{binding:f.binding}),f.locator);
    assert.deepEqual(validateRecoveryPlanBindings(f.plan,{stage:f.stage,staged:f.staged,sourceClosedEvidence:f.proof,base:f.base,previousRecoveryCounter:f.previousRecoveryCounter}),f.plan);
    const read=decode('requestLocator',encode('requestLocator',f.locator));
    assert(Object.isFrozen(read)&&Object.isFrozen(read.stage)&& (read.stage.sourceEvidence===null||Object.isFrozen(read.stage.sourceEvidence)));
    f.locator.stage.requestRef='modified'; assert.equal(read.stage.requestRef,'request');
  }
});
test('tampered bindings cannot be disguised by canonical record hashes',()=>{
  for (const route of ['fresh','registered','closed','snapshot']) {
    const f=fixture(route);
    bad(()=>validateRecoveryPlanBindings({...f.plan,policyHash:H},{stage:f.stage,staged:f.staged,sourceClosedEvidence:f.proof,base:f.base,previousRecoveryCounter:f.previousRecoveryCounter}),'RECOVERY_EVIDENCE_MISMATCH');
  }
  const f=fixture('closed');
  bad(()=>validateRecoveryLocator({...f.locator,sourceClosedEvidence:{...f.proof,issuedAt:20}},{binding:f.binding}),'RECOVERY_EVIDENCE_MISMATCH');
  bad(()=>validateRecoveryLocator(f.locator,{binding:{...f.binding,fileHash:H}}),'RECOVERY_EVIDENCE_MISMATCH');
  bad(()=>encode('stage',{...f.stage,candidateReference:'../candidate.sqlite'}));
});
test('noncanonical decoding, strict shape and unsupported inputs',()=>{
  const f=fixture();const bytes=encode('stage',f.stage);
  for (const raw of [Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),bytes]),Buffer.concat([bytes,Buffer.from('\n')]),Buffer.from(bytes.toString().replace('"version":1','"version":1,"version":1')),Buffer.from(bytes.toString().replace('"version":1,"requestRef"','"requestRef":"request","version":1,"requestRef"')),Buffer.from([0xff]),Buffer.alloc(65537)]) bad(()=>decode('stage',raw),'RECOVERY_EVIDENCE_MISMATCH');
  bad(()=>encode('stage',{...f.stage,extra:1}));bad(()=>encode('stage',[]));bad(()=>encode('stage',{...f.stage,createdAt:Number.MAX_SAFE_INTEGER+1}));
  bad(()=>encode('unknown',f.stage));bad(()=>encode('stage',{...f.stage,requestRef:'\u0000'}));
  const access=Object.defineProperty({...f.stage},'createdAt',{get(){throw Error('getter invoked');}});bad(()=>encode('stage',access));
  bad(()=>hashRecoveryRequestRef('😀'.repeat(128)));
});
test('plan expiry and snapshot counter overflow',()=>{
  const f=fixture('snapshot');assertRecoveryPlanFresh(f.plan,300099);
  bad(()=>assertRecoveryPlanFresh(f.plan,300100),'RECOVERY_PLAN_STALE');
  bad(()=>encode('preparePlan',{...f.plan,createdAt:Number.MAX_SAFE_INTEGER}));
  bad(()=>validateRecoveryPlanBindings({...f.plan,recoveryCounter:0},{stage:f.stage,staged:f.staged,sourceClosedEvidence:f.proof,base:f.base,previousRecoveryCounter:7}),'RECOVERY_EVIDENCE_MISMATCH');
});
test('pause chain and exact status action combinations',()=>{
  const f=fixture('registered');
  const chain=chainForStage(f.stage), {paused}=chain;
  assert.deepEqual(validateRecoveryPauseBindings(chain),paused);
  bad(()=>validateRecoveryPauseBindings({...chain,paused:{...paused,changed:true}}),'RECOVERY_EVIDENCE_MISMATCH');
  const status={runId:U,candidateReference:f.stage.candidateReference,state:'staged',stageHash:f.staged.stageHash,preparePlanHash:null,newEpoch:E,holdId:null,writeMode:'paused',nextAction:'PREVIEW_PREPARE'};
  assert.deepEqual(decode('status',encode('status',status)),status);
  bad(()=>encode('status',{...status,nextAction:'NONE'}));
  assert.equal(hashRecoveryRequestRef('\ud800'),sha(Buffer.from(JSON.stringify('\ud800'))));
});

// Frozen contract §§2–8. Hash oracles below use explicit fixture field order,
// independently of the production encoder and request-hash helper.
const copy=value=>structuredClone(value);
const pauseHash=intent=>recordHash('pauseIntent',intent);
function checkPlan(f) {
  return validateRecoveryPlanBindings(f.plan,{stage:f.stage,staged:f.staged,
    sourceClosedEvidence:f.proof,base:f.base,previousRecoveryCounter:f.previousRecoveryCounter});
}
function pauseFixture(route,mode='paused') {
  const f=fixture(route);
  const chain=chainForStage(f.stage,mode);
  chain.pauseIntent.createdAt=24;chain.paused.pausedAt=25;
  return rechain(chain);
}
function stageResultFixture(route) {
  const f=fixture(route);
  return {runId:U,candidateReference:f.stage.candidateReference,status:'staged',stageHash:f.staged.stageHash,
    preparationRef:f.staged.preparationRef,instanceId:f.staged.instanceId,
    instanceCreatedAt:f.staged.instanceCreatedAt,initialEpoch:f.staged.initialEpoch,
    importEpoch:f.staged.importEpoch,holdId:route==='registered'||route==='snapshot'?B:null};
}
function statusFixture(state='active',route='fresh') {
  const f=fixture(route);
  const nextAction={prepared:'P5C_VERIFY_REQUIRED',verified:'P5C_SEAL_ACTIVATION_REQUIRED',active:'NONE'}[state];
  return {runId:U,candidateReference:f.stage.candidateReference,state,stageHash:f.staged.stageHash,
    preparePlanHash:digest('preparePlan',f.plan),newEpoch:f.plan.newEpoch,
    holdId:route==='registered'||route==='snapshot'?B:null,
    writeMode:state==='active'?'enabled':'paused',nextAction};
}
function roundTrip(kind,record) {
  assert.deepEqual(decode(kind,encode(kind,record)),record);
}

for (const route of ['registered','closed','snapshot']) {
  for (const [field,value] of [['instanceId',B],['instanceCreatedAt',11]]) {
    test(`E1 ${route}: matching plan/staged ${field} cannot replace original source identity`,()=>{
      const control=fixture(route);
      assert.deepEqual(checkPlan(control),control.plan);
      assert.deepEqual(validateRecoveryLocator(control.locator,{binding:control.binding}),control.locator);
      const forged=copy(control);
      forged.plan[field]=value;
      forged.staged[field]=value;
      // Both records remain canonical and individually hashable. Only the two
      // candidate identity fields change; source, proof, stage and base stay put.
      for (const [kind,key] of [['preparePlan','plan'],['staged','staged']]) {
        roundTrip(kind,forged[key]);
        assert.equal(digest(kind,forged[key]),sha(encode(kind,forged[key])));
      }
      for (const key of ['stage','proof','base','binding']) assert.deepEqual(forged[key],control[key]);
      assert.deepEqual({...forged.plan,[field]:control.plan[field]},control.plan);
      assert.deepEqual({...forged.staged,[field]:control.staged[field]},control.staged);
      bad(()=>checkPlan(forged),'RECOVERY_EVIDENCE_MISMATCH');
    });
  }
}

for (const route of ['registered','closed']) {
  for (const mode of ['paused','enabled']) {
    test(`E2 ${route}/${mode}: coherent pause hash substitution stays bound to source`,()=>{
      const control=pauseFixture(route,mode);
      assert.deepEqual(validateRecoveryPauseBindings(control),control.paused);
      assert.equal(digest('pauseIntent',control.pauseIntent),pauseHash(control.pauseIntent));
      const forged=copy(control);
      for(const kind of ['copyIntent','base','normalizationIntent','normalized','pauseIntent','paused']) forged[kind].candidateBaseHash=H;
      forged.normalized.normalizedCandidateHash=H;
      forged.pauseIntent.pauseInputHash=H;
      forged.paused.pauseInputHash=H;
      if (mode==='paused') forged.paused.pausedCandidateHash=H;
      rechain(forged);
      assert.deepEqual(forged.stage,control.stage);
      assert.equal(forged.base.stageHash,sha(encode('stage',forged.stage)));
      for (const kind of ['copyIntent','base','normalizationIntent','normalized','pauseIntent','paused']) roundTrip(kind,forged[kind]);
      bad(()=>validateRecoveryPauseBindings(forged),'RECOVERY_EVIDENCE_MISMATCH');
    });
    for (const [field,value] of [['sourceSchemaVersion',4],['sourceSchemaChecksum',H]]) {
      test(`E2 ${route}/${mode}: base ${field} alone cannot disagree with source`,()=>{
        const control=pauseFixture(route,mode);
        assert.deepEqual(validateRecoveryPauseBindings(control),control.paused);
        const forged=copy(control);
        forged.base[field]=value;
        assert.deepEqual({...forged.base,[field]:control.base[field]},control.base);
        for (const key of ['stage','pauseIntent','paused']) assert.deepEqual(forged[key],control[key]);
        assert.equal(forged.base.stageHash,sha(encode('stage',forged.stage)));
        // The approved encoder rejects an intrinsically invalid version/checksum
        // pair; the binding boundary still reports an evidence mismatch.
        assert.throws(()=>encode('base',forged.base),{code:'RECOVERY_INVALID'});
        assert.throws(()=>decode('base',recordBytes('base',forged.base)),{code:'RECOVERY_EVIDENCE_MISMATCH'});
        bad(()=>validateRecoveryPauseBindings(forged),'RECOVERY_EVIDENCE_MISMATCH');
      });
    }
    test(`E2 ${route}/${mode}: valid v4 metadata and coherent full chain cannot replace v3 source`,()=>{
      const original=fixture(route),control=pauseFixture(route,mode);
      assert.deepEqual(checkPlan(original),original.plan);
      assert.deepEqual(validateRecoveryLocator(original.locator,{binding:original.binding}),original.locator);
      assert.deepEqual(validateRecoveryNormalizationBindings(control),control.normalized);
      assert.deepEqual(validateRecoveryPauseBindings(control),control.paused);
      const sourceBefore=copy(original),forged=copy(control);
      // Independent pinned fixture checksum; pure counterexample, not provenance.
      const pinnedV4='c950eb40692a72f918c8976d4bef8cab0b9e357495b01df75e0ab2d1b0b5f216';
      for(const kind of ['copyIntent','base']) {
        forged[kind].sourceSchemaVersion=4;
        forged[kind].sourceSchemaChecksum=pinnedV4;
      }
      rechain(forged);
      for(const kind of ['copyIntent','base','normalizationIntent','normalized','pauseIntent','paused']) {
        roundTrip(kind,forged[kind]);
        assert.deepEqual(encode(kind,forged[kind]),recordBytes(kind,forged[kind]));
        assert.equal(digest(kind,forged[kind]),recordHash(kind,forged[kind]));
        assert.equal(forged[kind].stageHash,sha(encode('stage',control.stage)));
        assert.equal(forged[kind].candidateBaseHash,control[kind].candidateBaseHash);
      }
      for(const [child,field,parent]of [
        ['base','copyIntentHash','copyIntent'],['normalizationIntent','baseRecordHash','base'],
        ['normalized','normalizationIntentHash','normalizationIntent'],['pauseIntent','normalizedRecordHash','normalized'],
        ['paused','pauseIntentHash','pauseIntent']
      ]) {
        assert.equal(forged[child][field],recordHash(parent,forged[parent]));
        assert.notEqual(forged[child][field],control[child][field],'old hash must not survive rechain');
      }
      assert.deepEqual(forged.stage,control.stage);
      assert.deepEqual(forged.stage,original.stage);
      assert.deepEqual(original,sourceBefore,'plan, closure, locator and original source remain unchanged');
      assert.equal(forged.stage.sourceEvidence.schemaVersion,3);
      assert.throws(()=>validateRecoveryNormalizationBindings(forged),{code:'RECOVERY_EVIDENCE_MISMATCH'});
      assert.throws(()=>validateRecoveryPauseBindings(forged),{code:'RECOVERY_EVIDENCE_MISMATCH'});
    });
  }
  test(`E2 ${route}: pause run/stage/reference/mode/hash/changed consistency`,()=>{
    const mutations=[
      ['base run',x=>{x.base.runId=B;x.base.candidateReference=`runs/${B}/candidate.sqlite`;}],
      ['intent run',x=>{x.pauseIntent.runId=B;x.paused.pauseIntentHash=pauseHash(x.pauseIntent);}],
      ['paused run',x=>{x.paused.runId=B;}],
      ['base stage',x=>{x.base.stageHash=H;}],
      ['intent stage',x=>{x.pauseIntent.stageHash=H;x.paused.pauseIntentHash=pauseHash(x.pauseIntent);}],
      ['paused stage',x=>{x.paused.stageHash=H;}],
      ['intent base',x=>{x.pauseIntent.candidateBaseHash=H;x.paused.pauseIntentHash=pauseHash(x.pauseIntent);}],
      ['paused base',x=>{x.paused.candidateBaseHash=H;}],
      ['intent hash',x=>{x.paused.pauseIntentHash=H;}],
      ['original mode',x=>{x.pauseIntent.originalWriteMode='enabled';x.paused.pauseIntentHash=pauseHash(x.pauseIntent);}],
      ['unchanged candidate hash',x=>{x.paused.pausedCandidateHash=H;}],
      ['changed flag',x=>{x.paused.changed=true;}]
    ];
    for (const [label,mutate] of mutations) {
      const control=pauseFixture(route);
      assert.deepEqual(validateRecoveryPauseBindings(control),control.paused,label);
      const forged=copy(control);mutate(forged);
      assert.throws(()=>validateRecoveryPauseBindings(forged),{code:'RECOVERY_EVIDENCE_MISMATCH'},label);
    }
    const enabled=pauseFixture(route,'enabled');
    assert.deepEqual(validateRecoveryPauseBindings(enabled),enabled.paused);
    bad(()=>validateRecoveryPauseBindings({...copy(enabled),paused:{...enabled.paused,changed:false}}),'RECOVERY_EVIDENCE_MISMATCH');
  });
}
test('E2 snapshot stage is not a v3 pause chain; its source evidence is preserved',()=>{
  const control=pauseFixture('registered');
  assert.deepEqual(validateRecoveryPauseBindings(control),control.paused);
  const snapshot=pauseFixture('snapshot');
  const original=copy(snapshot);
  roundTrip('stage',snapshot.stage);
  roundTrip('base',snapshot.base);
  assert.equal(snapshot.base.stageHash,sha(encode('stage',snapshot.stage)));
  bad(()=>validateRecoveryPauseBindings(snapshot),'RECOVERY_EVIDENCE_MISMATCH');
  assert.deepEqual(snapshot,original);
});

for (const candidateKind of ['v3_import','snapshot_recovery','fresh_bootstrap']) {
  test(`E3 ${candidateKind}: public request input helper requires the correct reference pair`,()=>{
    const fresh=candidateKind==='fresh_bootstrap';
    const control={candidateKind,sourceRef:fresh?null:'catalog:key',isolationAckRef:fresh?null:'isolated',policyHash:P};
    const expected=sha(JSON.stringify([candidateKind,control.sourceRef,control.isolationAckRef,P]));
    assert.equal(hashRecoveryRequestInput(control),expected);
    const pairs=fresh?[['catalog:key',null],[null,'isolated'],['catalog:key','isolated']]:
      [[null,'isolated'],['catalog:key',null],[null,null]];
    for (const [sourceRef,isolationAckRef] of pairs) {
      assert.equal(hashRecoveryRequestInput(copy(control)),expected);
      bad(()=>hashRecoveryRequestInput({...copy(control),sourceRef,isolationAckRef}));
    }
  });
}

for (const route of ['fresh','registered','closed','snapshot']) {
  test(`E3 ${route}: stage result retains documented P1 metadata and an exact run reference`,()=>{
    const control=stageResultFixture(route);
    roundTrip('stageResult',control);
    assert.equal(control.preparationRef,route==='snapshot'?null:'prepare:one');
    assert.equal(control.importEpoch,route==='registered'||route==='closed'?B:null);
    for (const candidateReference of ['../candidate.sqlite','/candidate.sqlite','C:\\candidate.sqlite',`runs/${B}/candidate.sqlite`]) {
      roundTrip('stageResult',control);
      bad(()=>encode('stageResult',{...copy(control),candidateReference}));
    }
    for (const field of Object.keys(control)) {
      const missing=copy(control);delete missing[field];
      bad(()=>encode('stageResult',missing));
    }
  });
}

for (const state of ['prepared','verified','active']) {
  test(`E3 ${state}: completed status requires authenticated candidate and known completed facts`,()=>{
    const control=statusFixture(state);
    roundTrip('status',control);
    for (const route of ['registered','closed','snapshot']) roundTrip('status',statusFixture(state,route));
    for (const field of ['candidateReference','stageHash','preparePlanHash','newEpoch','writeMode']) {
      roundTrip('status',control);
      bad(()=>encode('status',{...copy(control),[field]:null}));
      const omitted=copy(control);delete omitted[field];
      bad(()=>encode('status',omitted));
    }
    for (const candidateReference of ['../candidate.sqlite','/candidate.sqlite','C:\\candidate.sqlite',`runs/${B}/candidate.sqlite`]) {
      roundTrip('status',control);
      bad(()=>encode('status',{...copy(control),candidateReference}));
    }
    if (state!=='active') bad(()=>encode('status',{...copy(control),writeMode:'enabled'}));
    else roundTrip('status',{...copy(control),writeMode:'paused'});
    bad(()=>encode('status',{...copy(control),writeMode:'unknown'}));
  });
}
test('E3 empty active status cannot substitute nulls for completed facts',()=>{
  const control=statusFixture();
  roundTrip('status',control);
  bad(()=>encode('status',{...copy(control),candidateReference:null,stageHash:null,
    preparePlanHash:null,newEpoch:null,holdId:null,writeMode:null}));
});
test('E3 failed metadata needs identifiable candidate/stage evidence, not completed facts',()=>{
  // Pure DTO consistency only; encoding does not establish trusted failure or authorization.
  const f=fixture('fresh');
  const control={runId:U,candidateReference:f.stage.candidateReference,state:'failed',
    stageHash:f.staged.stageHash,preparePlanHash:null,newEpoch:null,holdId:null,
    writeMode:null,nextAction:'MANUAL_RECONCILIATION'};
  roundTrip('status',control);
  for (const field of ['candidateReference','stageHash']) {
    roundTrip('status',control);
    bad(()=>encode('status',{...copy(control),[field]:null}));
  }
  for (const candidateReference of ['../candidate.sqlite','/candidate.sqlite',`runs/${B}/candidate.sqlite`]) {
    roundTrip('status',control);
    bad(()=>encode('status',{...copy(control),candidateReference}));
  }
});
test('E3 legal partial snapshot, retry-stage and hold-free active statuses remain representable',()=>{
  const f=fixture('snapshot');
  const staged={runId:U,candidateReference:f.stage.candidateReference,state:'staged',
    stageHash:f.staged.stageHash,preparePlanHash:null,newEpoch:null,holdId:B,
    writeMode:'enabled',nextAction:'PREVIEW_PREPARE'};
  roundTrip('status',staged);
  const partial={...staged,state:'indeterminate',stageHash:null,preparePlanHash:null,
    newEpoch:null,holdId:null,writeMode:null,nextAction:'RETRY_STAGE'};
  roundTrip('status',partial);
  for (const control of [staged,partial]) {
    for (const candidateReference of ['../candidate.sqlite','/candidate.sqlite',`runs/${B}/candidate.sqlite`]) {
      roundTrip('status',control);
      bad(()=>encode('status',{...copy(control),candidateReference}));
    }
  }
  for (const route of ['fresh','closed']) {
    const active=statusFixture('active',route);
    assert.equal(active.holdId,null);
    assert.equal(active.nextAction,'NONE');
    for (const writeMode of ['enabled','paused']) roundTrip('status',{...active,writeMode});
  }
});
test('canonical order-only permutation and exact TTL stay independently enforced',()=>{
  const f=fixture('fresh');
  roundTrip('stage',f.stage);
  const {version,...rest}=f.stage;
  bad(()=>decode('stage',Buffer.from(JSON.stringify({...rest,version}))),'RECOVERY_EVIDENCE_MISMATCH');
  roundTrip('preparePlan',f.plan);
  bad(()=>encode('preparePlan',{...f.plan,expiresAt:f.plan.expiresAt+1}));
  assertRecoveryPlanFresh(f.plan,f.plan.expiresAt-1);
  bad(()=>assertRecoveryPlanFresh(f.plan,f.plan.expiresAt),'RECOVERY_PLAN_STALE');
});
