import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRecoveryRecord as encode,decodeRecoveryRecord as decode,hashRecoveryRecord as hash,
  validateRecoverySealBindings as seal,validateRecoveryActivationPlanBindings as activation,
  validateRecoveryCompletionBindings as completion,validateRecoveryReleasePlanBindings as release,
  assertRecoveryActivationPlanFresh as fresh } from '../src/im/v2/recovery-plan.js';
import { V3_CHECKSUM } from '../src/im/v2/schema-history.js';
import { chain,literals,digest,H,F,U,B,E } from './fixtures/im-v2-recovery-hold-terminal/records.js';

const mismatch={code:'RECOVERY_EVIDENCE_MISMATCH'},invalid={code:'RECOVERY_INVALID'};
const fixture=route=>chain(route,V3_CHECKSUM);
const checks=[['seal',seal,'sealEvidence'],['activationPlan',activation,'activationEvidence'],['completion',completion,'completionEvidence'],['releasePlan',release,'releaseEvidence']];
const kind=key=>key==='completion'?'activationCompletion':key;
const vectors={seal:'e5e7d57ca2e536e10b6a844edc452f83d49dcc1835e428cba09b4f1c70614afd',activationPlan:'c9a784b3b715de7a7cb1b2cf9fd90f6cfc76fc082fc04cf6edb806b27c47c3f3',activationCompletion:'44becd9d8d3499a71e8f16a7f89d8620859491e7e108e0de69cda31cc4fe1534',releasePlan:'722519b4fb8a84465032e7e996d674bc9978b2c8a16bb0957110e9be6cac3eb1'};
for (const [name,literal] of Object.entries(literals)) test(`C canonical ${name}: independent ordered literal and strict byte decoding`,()=>{
  const value=JSON.parse(literal),bytes=Buffer.from(literal);
  assert.deepEqual(encode(name,Object.fromEntries(Object.entries(value).reverse())),bytes);
  assert.deepEqual(decode(name,bytes),value);
  assert.equal(hash(name,value),vectors[name]);
  for (const bad of [Buffer.concat([Buffer.from([239,187,191]),bytes]),Buffer.concat([bytes,Buffer.from('\n')]),Buffer.from(literal.replace('"version":1','"version":1,"version":1')),Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(value).reverse()))),Buffer.alloc(65537),Buffer.from([255])]) assert.throws(()=>decode(name,bad),mismatch);
  for (const key of Object.keys(value)) { const bad={...value}; delete bad[key]; assert.throws(()=>encode(name,bad),invalid); }
  for (const bad of [{...value,extra:true},{...value,runId:U.toUpperCase()+'x'},{...value,preparePlanHash:'A'.repeat(64)},{...value,candidateReference:`runs/${B}/candidate.sqlite`}]) assert.throws(()=>encode(name,bad),invalid);
  const owned=encode(name,value);owned.fill(0);assert.deepEqual(encode(name,value),bytes);
});
test('C nested verification has exactly four literal true values and is owned/deep frozen',()=>{
  const input=JSON.parse(literals.seal),decoded=decode('seal',encode('seal',input));
  assert(Object.isFrozen(decoded)&&Object.isFrozen(decoded.verification));input.verification.integrity=false;assert.equal(decoded.verification.integrity,true);
  for (const key of ['integrity','foreignKeys','schema','invariants']) for (const value of [false,1,'true',null]) assert.throws(()=>encode('seal',{...decoded,verification:{...decoded.verification,[key]:value}}),invalid);
  assert.throws(()=>encode('seal',{...decoded,schemaChecksum:H}),invalid);
});
for (const route of ['fresh','registered','closed','snapshot']) test(`C required full B/C evidence, isolation and identity bindings: ${route}`,()=>{
  const f=fixture(route);
  for (const [key,check,evidence] of checks) {
    if (key==='releasePlan'&&['fresh','closed'].includes(route)) { assert.throws(()=>check(f[key],f[evidence]),mismatch);continue; }
    assert.deepEqual(check(f[key],f[evidence]),f[key]);
    for (const required of Object.keys(f[evidence])) { const partial={...f[evidence]};delete partial[required];assert.throws(()=>check(f[key],partial),mismatch); }
    const clone=structuredClone(f[key]); const output=check(clone,f[evidence]);assert(Object.isFrozen(output));clone.runId=B;assert.equal(output.runId,U);
  }
  for (const isolationAckRef of route==='fresh'?['isolated']:[null,'other']) assert.throws(()=>activation({...f.activationPlan,isolationAckRef},f.activationEvidence),mismatch);
  assert.throws(()=>seal({...f.seal,newEpoch:U},f.sealEvidence),mismatch);
  assert.throws(()=>seal(f.seal,{...f.sealEvidence,sealReference:`runs/${B}/seals/${digest(f.seal)}.json`}),mismatch);
  assert.throws(()=>seal(f.seal,{...f.sealEvidence,candidateFileHash:H}),mismatch);
});
test('C coherent rehashed chain cannot replace original prepare, actual DB, completion or hold facts',()=>{
  for (const route of ['registered','snapshot']) {
    let f=fixture(route);
    f.activationPlan.newEpoch=U;f.completion.newEpoch=U;f.completion.activationPlanHash=digest(f.activationPlan);f.releasePlan.newEpoch=U;f.releasePlan.activationCompletionHash=digest(f.completion);
    for (const key of ['activationPlan','completion','releasePlan']) decode(kind(key),encode(kind(key),f[key]));
    assert.throws(()=>release(f.releasePlan,f.releaseEvidence),mismatch);
    for (const [section,key,value] of [['run','authReviewRef','changed'],['run','prepareApprovalRef','changed'],['run','verifiedAt',201],['run','failureCode','failed'],['run','status','failed'],['center','updatedAt',401],['center','recoveryCounter',99],['instance','instanceId',B],['epoch','newEpoch',U]]) {
      f=fixture(route);f.completionEvidence.actual[section][key]=value;assert.throws(()=>release(f.releasePlan,f.releaseEvidence),mismatch);
    }
    for (const [key,value] of [['activationApprovalRef','other'],['activatedAt',401],['instanceCreatedAt',11],['recoveryCounter',99]]) {
      f=fixture(route);f.completion[key]=value;f.releasePlan.activationCompletionHash=digest(f.completion);assert.throws(()=>release(f.releasePlan,f.releaseEvidence),mismatch);
    }
    for (const [section,key,value] of [['hold','recoveryRunId',B],['hold','backupId',U],['hold','stageHash',H],['binding','preparePlanHash',H],['binding','holdId',U]]) {
      f=fixture(route);f.releaseEvidence[section][key]=value;assert.throws(()=>release(f.releasePlan,f.releaseEvidence),mismatch);
    }
    f=fixture(route);f.releasePlan.activationCompletionHash=H;assert.throws(()=>release(f.releasePlan,f.releaseEvidence),mismatch);
  }
});
test('activation TTL equality/overflow and completed original TTL are explicit',()=>{
  const f=fixture();fresh(f.activationPlan,300299);assert.throws(()=>fresh(f.activationPlan,300300),{code:'RECOVERY_PLAN_STALE'});
  for (const value of [{...f.activationPlan,expiresAt:300301},{...f.activationPlan,createdAt:Number.MAX_SAFE_INTEGER,expiresAt:Number.MAX_SAFE_INTEGER},{...f.activationPlan,createdAt:-1}]) assert.throws(()=>encode('activationPlan',value),invalid);
  assert.throws(()=>completion({...f.completion,activatedAt:300300},f.completionEvidence),mismatch);
  // Completed checks never read a clock or reject merely because time passed.
  assert.deepEqual(completion(f.completion,f.completionEvidence),f.completion);
});
function status(route='snapshot') {
  const f=fixture(route),held=['registered','snapshot'].includes(route);
  return {version:2,runId:U,candidateReference:f.seal.candidateReference,state:'active',stageHash:f.releasePlan.stageHash,preparePlanHash:f.seal.preparePlanHash,newEpoch:f.seal.newEpoch,holdId:held?E:null,writeMode:'paused',nextAction:held?'APPROVE_RELEASE_HOLD':'NONE',releasePlan:held?f.releasePlan:null,releasePlanHash:held?digest(f.releasePlan):null};
}
test('statusV2 order, strict v1 separation, completion link and nullable B observations',()=>{
  for (const route of ['fresh','registered','closed','snapshot']) {
    const s=status(route);assert.deepEqual(decode('statusV2',encode('statusV2',s)),s);
    assert.deepEqual(Object.keys(decode('statusV2',encode('statusV2',s))),['version','runId','candidateReference','state','stageHash','preparePlanHash','newEpoch','holdId','writeMode','nextAction','releasePlan','releasePlanHash']);
    assert.throws(()=>encode('status',s),invalid);
    const {version,releasePlan,releasePlanHash,...v1}=s;v1.nextAction='NONE';assert.deepEqual(decode('status',encode('status',v1)),v1);assert.throws(()=>encode('statusV2',v1),invalid);
    assert.deepEqual(decode('statusV2',encode('statusV2',{...s,nextAction:'NONE'})),{...s,nextAction:'NONE'});
    assert.doesNotThrow(()=>encode('statusV2',{...s,nextAction:'RETRY_ACTIVATE',releasePlan:null,releasePlanHash:null}));
  }
  const s=status();
  for (const bad of [{...s,releasePlan:null},{...s,releasePlanHash:null},{...s,holdId:null},{...s,nextAction:'RETRY_ACTIVATE'},{...s,nextAction:'NONE',releasePlan:null,releasePlanHash:null}]) assert.throws(()=>encode('statusV2',bad),invalid);
  for (const [key,value] of [['runId',B],['holdId',U],['stageHash',H],['preparePlanHash',F],['newEpoch',U]]) {
    const plan={...s.releasePlan,[key]:value};if(key==='runId')plan.candidateReference=`runs/${B}/candidate.sqlite`;
    assert.throws(()=>encode('statusV2',{...s,releasePlan:plan,releasePlanHash:digest(plan)}),invalid);
  }
  assert.doesNotThrow(()=>encode('statusV2',{...s,state:'staged',nextAction:'PREVIEW_PREPARE',preparePlanHash:null,newEpoch:null,writeMode:'enabled',releasePlan:null,releasePlanHash:null}));
  assert.doesNotThrow(()=>encode('statusV2',{...s,state:'indeterminate',nextAction:'MANUAL_RECONCILIATION',candidateReference:null,stageHash:null,preparePlanHash:null,newEpoch:null,holdId:null,writeMode:null,releasePlan:null,releasePlanHash:null}));
  const missing={...s.releasePlan};delete missing.activationCompletionHash;assert.throws(()=>encode('releasePlan',missing),invalid);
});
