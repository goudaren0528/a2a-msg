// P5-B pure, local evidence serialization. No authorization, source inspection or publication.
import { createHash } from 'node:crypto';
import { V3_CHECKSUM } from './schema-history.js';
import { V4_CHECKSUM } from './schema-internal.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const invalid = () => fail('RECOVERY_INVALID');
const mismatch = () => fail('RECOVERY_EVIDENCE_MISMATCH');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(x);
const hash = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const time = x => Number.isSafeInteger(x) && x >= 0;
const ref = x => typeof x === 'string' && x.length >= 1 && x.length <= 255 && !/[\x00-\x1f\x7f]/.test(x);
const nullable = test => x => x === null || test(x);
const one = x => x === 1;
const two = x => x === 2;
const kind = x => ['fresh_bootstrap', 'v3_import', 'snapshot_recovery'].includes(x);
const mode = x => x === 'paused' || x === 'enabled';
const schema = x => x === 3 || x === 4;
const fields = {
  closureBinding: { sourceRef:ref,isolationAckRef:ref,sourceKind:x=>x==='registered-backup'||x==='closed-source',instanceId:uuid,instanceCreatedAt:time,schemaVersion:schema,schemaChecksum:hash,fileHash:hash,backupId:nullable(uuid),manifestHash:nullable(hash) },
  closureProof: { version:one,evidenceRef:ref,sourceRef:ref,isolationAckRef:ref,sourceKind:x=>x==='registered-backup'||x==='closed-source',instanceId:uuid,instanceCreatedAt:time,schemaVersion:schema,schemaChecksum:hash,fileHash:hash,backupId:nullable(uuid),manifestHash:nullable(hash),issuedAt:time },
  closedSourceEvidence: { version:one,kind:x=>x==='closed-source',sourceRef:ref,instanceId:uuid,instanceCreatedAt:time,schemaVersion:x=>x===3,schemaChecksum:hash,closedSourceFileHash:hash,observedAt:time,isolationAckRef:ref },
  rpoReport: { status:x=>x==='unknown',snapshotCompletedAt:nullable(time),sourceObservedAt:nullable(time),missingAcceptedCount:x=>x===null,missingAckCount:x=>x===null,missingReadCount:x=>x===null,comparisonEvidenceHash:x=>x===null,authChanges:x=>x==='unknown',notesCode:x=>x==='COMPARISON_INCOMPLETE'||x==='SOURCE_UNAVAILABLE' },
  stage: { version:one,requestRef:ref,requestHash:hash,runId:uuid,candidateKind:kind,sourceRef:nullable(ref),sourceEvidence:x=>x===null||object(x,'registeredSourceEvidence')||object(x,'closedSourceEvidence'),sourceClosedEvidenceRef:nullable(ref),sourceClosedEvidenceHash:nullable(hash),isolationAckRef:nullable(ref),policyHash:hash,candidateReference:ref,preparationRef:nullable(ref),createdAt:time },
  requestLocator: { version:one,requestRef:ref,requestHash:hash,runId:uuid,stage:x=>object(x,'stage'),sourceClosedEvidence:x=>x===null||object(x,'closureProof'),stageHash:hash },
  staged: { version:one,runId:uuid,stageHash:hash,candidateBaseHash:nullable(hash),preparationRef:nullable(ref),instanceId:uuid,instanceCreatedAt:time,initialEpoch:uuid,importEpoch:nullable(uuid),stagedAt:time },
  copyIntent: { version:one,runId:uuid,stageHash:hash,candidateReference:ref,candidateBaseHash:hash,sourceSchemaVersion:schema,sourceSchemaChecksum:hash,sourceWriteMode:mode,copyStartedAt:time },
  base: { version:two,runId:uuid,stageHash:hash,candidateReference:ref,copyIntentHash:hash,candidateBaseHash:hash,sourceSchemaVersion:schema,sourceSchemaChecksum:hash,sourceWriteMode:mode,copyStartedAt:time },
  normalizationIntent: { version:one,runId:uuid,stageHash:hash,baseRecordHash:hash,candidateReference:ref,candidateBaseHash:hash,originalHeaderMode:x=>x==='DELETE'||x==='WAL',targetHeaderMode:x=>x==='DELETE',createdAt:time },
  normalized: { version:one,runId:uuid,stageHash:hash,normalizationIntentHash:hash,candidateBaseHash:hash,normalizedCandidateHash:hash,changed:x=>typeof x==='boolean',normalizedAt:time },
  pauseIntent: { version:two,runId:uuid,stageHash:hash,candidateBaseHash:hash,normalizedRecordHash:hash,pauseInputHash:hash,originalWriteMode:mode,targetWriteMode:x=>x==='paused',createdAt:time },
  paused: { version:two,runId:uuid,stageHash:hash,pauseIntentHash:hash,candidateBaseHash:hash,pauseInputHash:hash,pausedCandidateHash:hash,changed:x=>typeof x==='boolean',pausedAt:time },
  preparePlan: { version:one,runId:uuid,candidateKind:kind,preparationRef:nullable(ref),instanceId:uuid,instanceCreatedAt:time,backupId:nullable(uuid),backupFileHash:nullable(hash),manifestHash:nullable(hash),sourceSchemaVersion:nullable(schema),sourceSchemaChecksum:nullable(hash),candidateReference:ref,oldEpoch:nullable(uuid),newEpoch:uuid,recoveryCounter:time,policyHash:hash,rpoReport:x=>x===null||object(x,'rpoReport'),sourceEvidence:x=>x===null||object(x,'registeredSourceEvidence')||object(x,'closedSourceEvidence'),sourceClosedEvidenceRef:nullable(ref),isolationAckRef:nullable(ref),createdAt:time,expiresAt:time },
  stageResult: { runId:uuid,candidateReference:ref,status:x=>x==='staged',stageHash:hash,preparationRef:nullable(ref),instanceId:uuid,instanceCreatedAt:time,initialEpoch:uuid,importEpoch:nullable(uuid),holdId:nullable(uuid) },
  status: { runId:uuid,candidateReference:nullable(ref),state:x=>['staged','prepared','verified','active','failed','indeterminate'].includes(x),stageHash:nullable(hash),preparePlanHash:nullable(hash),newEpoch:nullable(uuid),holdId:nullable(uuid),writeMode:nullable(mode),nextAction:ref }
};
// A's exact registered evidence shape, without modifying or extending A's public encoder.
const registered = { version:one,kind:x=>x==='registered-backup',sourceRef:ref,registryFormat:x=>x===2||x===3,instanceId:uuid,instanceCreatedAt:time,backupId:uuid,fileHash:hash,manifestHash:hash,schemaVersion:schema,schemaChecksum:hash,completedAt:time,importedRecordHash:nullable(hash) };
fields.registeredSourceEvidence = registered;
Object.freeze(fields);
function own(x, keys) {
  if (!x || Object.getPrototypeOf(x)!==Object.prototype || Reflect.ownKeys(x).length!==keys.length) invalid();
  for (const k of keys) if (!Object.hasOwn(x,k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(x,k),'value')) invalid();
}
function object(x, name) { try { normalize(name,x); return true; } catch { return false; } }
function freeze(x) { for (const value of Object.values(x)) if (value && typeof value==='object') freeze(value); return Object.freeze(x); }
function normalize(name, value) {
  const rules=fields[name]; if (!rules) invalid();
  const keys=Object.keys(rules); own(value,keys);
  const out={};
  for (const key of keys) {
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if (!rules[key](descriptor.value)) invalid();
    out[key]=descriptor.value;
  }
  if (name==='registeredSourceEvidence' && (out.sourceRef!==`backup:${out.backupId}` || (out.registryFormat===3 ? out.schemaVersion!==4||out.importedRecordHash!==null : out.schemaVersion!==3||!hash(out.importedRecordHash)))) invalid();
  if (name==='registeredSourceEvidence' && out.schemaChecksum!==(out.schemaVersion===3?V3_CHECKSUM:V4_CHECKSUM)) invalid();
  if (name==='closureBinding'||name==='closureProof') {
    if (out.schemaChecksum!==(out.schemaVersion===3?V3_CHECKSUM:V4_CHECKSUM) || (out.sourceKind==='closed-source' ? out.schemaVersion!==3||out.backupId!==null||out.manifestHash!==null : !uuid(out.backupId)||!hash(out.manifestHash))) invalid();
  }
  if (name==='closedSourceEvidence' && out.schemaChecksum!==V3_CHECKSUM) invalid();
  if (name==='stage') {
    if (out.candidateReference!==`runs/${out.runId}/candidate.sqlite` || out.requestHash!==hashRecoveryRequestInput({candidateKind:out.candidateKind,sourceRef:out.sourceRef,isolationAckRef:out.isolationAckRef,policyHash:out.policyHash}) ||
      (out.candidateKind==='fresh_bootstrap' ? out.sourceRef!==null||out.sourceEvidence!==null||out.sourceClosedEvidenceRef!==null||out.sourceClosedEvidenceHash!==null||out.isolationAckRef!==null||out.preparationRef===null : out.sourceRef===null||out.sourceEvidence===null||out.sourceClosedEvidenceRef===null||out.sourceClosedEvidenceHash===null||out.isolationAckRef===null|| (out.candidateKind==='snapshot_recovery' ? out.preparationRef!==null : out.preparationRef===null))) invalid();
    if (out.sourceEvidence!==null && (out.sourceEvidence.kind==='closed-source' ? out.candidateKind!=='v3_import'||out.sourceEvidence.sourceRef!==out.sourceRef||out.sourceEvidence.isolationAckRef!==out.isolationAckRef : out.candidateKind==='snapshot_recovery' ? out.sourceEvidence.schemaVersion!==4 : out.sourceEvidence.schemaVersion!==3)) invalid();
  }
  if (name==='requestLocator' && (out.stage.runId!==out.runId || out.stage.requestRef!==out.requestRef || out.stage.requestHash!==out.requestHash || out.stageHash!==hashRecoveryRecord('stage',out.stage) || (out.sourceClosedEvidence===null ? out.stage.sourceClosedEvidenceRef!==null : out.sourceClosedEvidence.evidenceRef!==out.stage.sourceClosedEvidenceRef||hashRecoveryRecord('closureProof',out.sourceClosedEvidence)!==out.stage.sourceClosedEvidenceHash))) invalid();
  if (name==='preparePlan' && (out.createdAt>Number.MAX_SAFE_INTEGER-300000 || out.expiresAt!==out.createdAt+300000)) invalid();
  if (name==='preparePlan' && (out.candidateReference!==`runs/${out.runId}/candidate.sqlite` || (out.candidateKind==='fresh_bootstrap' ? out.preparationRef===null||out.backupId!==null||out.backupFileHash!==null||out.manifestHash!==null||out.sourceSchemaVersion!==null||out.sourceSchemaChecksum!==null||out.oldEpoch!==null||out.rpoReport!==null||out.sourceEvidence!==null||out.sourceClosedEvidenceRef!==null||out.isolationAckRef!==null||out.recoveryCounter!==0 : (out.preparationRef===null)!==(out.candidateKind==='snapshot_recovery') || out.rpoReport===null||out.sourceEvidence===null||out.sourceClosedEvidenceRef===null||out.isolationAckRef===null))) invalid();
  if (name==='pauseIntent' && out.targetWriteMode!=='paused') invalid();
  if (['copyIntent','base'].includes(name) && (out.candidateReference!==`runs/${out.runId}/candidate.sqlite` || out.sourceSchemaChecksum!==(out.sourceSchemaVersion===3?V3_CHECKSUM:V4_CHECKSUM))) invalid();
  if (name==='normalizationIntent' && out.candidateReference!==`runs/${out.runId}/candidate.sqlite`) invalid();
  if (name==='normalized' && !out.changed && out.normalizedCandidateHash!==out.candidateBaseHash) invalid();
  if (name==='paused' && !out.changed && out.pausedCandidateHash!==out.pauseInputHash) invalid();
  if (name==='stageResult' && out.candidateReference!==`runs/${out.runId}/candidate.sqlite`) invalid();
  if (name==='status') {
    const actions={staged:['PREVIEW_PREPARE','APPROVE_PREPARE','PLAN_EXPIRED'],prepared:['P5C_VERIFY_REQUIRED'],verified:['P5C_SEAL_ACTIVATION_REQUIRED'],active:['NONE'],failed:['MANUAL_RECONCILIATION'],indeterminate:['RETRY_STAGE','MANUAL_RECONCILIATION']};
    if (!actions[out.state].includes(out.nextAction) ||
        (out.candidateReference!==null && out.candidateReference!==`runs/${out.runId}/candidate.sqlite`) ||
        (out.state==='staged' && (out.candidateReference===null || out.stageHash===null || out.writeMode===null ||
          (out.nextAction==='PREVIEW_PREPARE' ? out.preparePlanHash!==null : out.preparePlanHash===null || out.newEpoch===null))) ||
        (['prepared','verified','active'].includes(out.state) && (out.candidateReference===null || out.stageHash===null || out.preparePlanHash===null || out.newEpoch===null ||
          (out.state==='active' ? out.writeMode===null : out.writeMode!=='paused'))) ||
        (out.state==='failed' && (out.candidateReference===null || out.stageHash===null)) ||
        (out.state==='indeterminate' && out.nextAction==='RETRY_STAGE' && out.preparePlanHash!==null)) invalid();
  }
  // Rebuild nested objects in declaration order, never retain caller-owned references.
  for (const [key,nested] of Object.entries({sourceEvidence:out.sourceEvidence?.kind==='registered-backup'?'registeredSourceEvidence':'closedSourceEvidence',sourceClosedEvidence:'closureProof',stage:'stage',rpoReport:'rpoReport'})) if (out[key]!==undefined && out[key]!==null) out[key]=normalize(nested,out[key]);
  return freeze(out);
}
export function encodeRecoveryRecord(kind, record) { const bytes=Buffer.from(JSON.stringify(normalize(kind,record)),'utf8'); if (bytes.length>65536) invalid(); return bytes; }
export function decodeRecoveryRecord(kind, bytes) {
  try {
    if (!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>65536) mismatch();
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    const result=normalize(kind,value);
    if (!encodeRecoveryRecord(kind,result).equals(bytes)) mismatch();
    return result;
  } catch { mismatch(); }
}
export function hashRecoveryRecord(kind, record) { return sha(encodeRecoveryRecord(kind,record)); }
export function hashRecoveryRequestRef(value) { if (!ref(value)) invalid(); return sha(Buffer.from(JSON.stringify(value),'utf8')); }
export function hashRecoveryRequestInput(input) {
  own(input,['candidateKind','sourceRef','isolationAckRef','policyHash']);
  const {candidateKind,sourceRef,isolationAckRef,policyHash}=input;
  if (!kind(candidateKind)||!nullable(ref)(sourceRef)||!nullable(ref)(isolationAckRef)||!hash(policyHash)||
      (candidateKind==='fresh_bootstrap' ? sourceRef!==null||isolationAckRef!==null : sourceRef===null||isolationAckRef===null)) invalid();
  return sha(Buffer.from(JSON.stringify([candidateKind,sourceRef,isolationAckRef,policyHash]),'utf8'));
}
export function assertRecoveryPlanFresh(plan,now) { const p=normalize('preparePlan',plan); if (!time(now)) invalid(); if (now>=p.expiresAt) fail('RECOVERY_PLAN_STALE'); return p; }
export function validateRecoveryPlanBindings(plan,{stage,staged,sourceClosedEvidence=null,base=null,previousRecoveryCounter=null}={}) {
  let p,s,t;
  try { p=normalize('preparePlan',plan); s=normalize('stage',stage); t=normalize('staged',staged); } catch { mismatch(); }
  const agree=(...values)=>values.every(v=>v===values[0]);
  if (!agree(p.runId,s.runId,t.runId)||!agree(p.candidateKind,s.candidateKind)||!agree(p.preparationRef,s.preparationRef,t.preparationRef)||!agree(p.instanceId,t.instanceId)||!agree(p.instanceCreatedAt,t.instanceCreatedAt)||!agree(p.candidateReference,s.candidateReference)||!agree(p.policyHash,s.policyHash)||!agree(p.sourceClosedEvidenceRef,s.sourceClosedEvidenceRef)||!agree(p.isolationAckRef,s.isolationAckRef)||t.stageHash!==hashRecoveryRecord('stage',s)||JSON.stringify(p.sourceEvidence)!==JSON.stringify(s.sourceEvidence)) mismatch();
  if (s.candidateKind==='fresh_bootstrap') {
    if (sourceClosedEvidence!==null||base!==null||t.candidateBaseHash!==null||t.importEpoch!==null||p.oldEpoch!==null||p.newEpoch!==t.initialEpoch||p.recoveryCounter!==0||p.rpoReport!==null||p.sourceSchemaVersion!==null||p.sourceSchemaChecksum!==null||p.backupId!==null||p.backupFileHash!==null||p.manifestHash!==null) mismatch();
  } else {
    let proof; try { proof=normalize('closureProof',sourceClosedEvidence); } catch { mismatch(); }
    const e=s.sourceEvidence, registered=e.kind==='registered-backup',file=registered?e.fileHash:e.closedSourceFileHash;
    if (p.instanceId!==e.instanceId||t.instanceId!==e.instanceId||p.instanceCreatedAt!==e.instanceCreatedAt||t.instanceCreatedAt!==e.instanceCreatedAt) mismatch();
    if (proof.evidenceRef!==s.sourceClosedEvidenceRef||hashRecoveryRecord('closureProof',proof)!==s.sourceClosedEvidenceHash||proof.sourceRef!==s.sourceRef||proof.isolationAckRef!==s.isolationAckRef||proof.sourceKind!==(registered?'registered-backup':'closed-source')||proof.instanceId!==e.instanceId||proof.instanceCreatedAt!==e.instanceCreatedAt||proof.schemaVersion!==e.schemaVersion||proof.schemaChecksum!==e.schemaChecksum||proof.fileHash!==file||proof.backupId!==(registered?e.backupId:null)||proof.manifestHash!==(registered?e.manifestHash:null)) mismatch();
    let b; try { b=normalize('base',base); } catch { mismatch(); }
    if (b.runId!==s.runId||b.stageHash!==t.stageHash||b.candidateReference!==s.candidateReference||b.candidateBaseHash!==file||t.candidateBaseHash!==file||b.sourceSchemaVersion!==e.schemaVersion||b.sourceSchemaChecksum!==e.schemaChecksum||p.sourceSchemaVersion!==e.schemaVersion||p.sourceSchemaChecksum!==e.schemaChecksum||p.backupId!==(registered?e.backupId:null)||p.backupFileHash!==(registered?file:null)||p.manifestHash!==(registered?e.manifestHash:null)) mismatch();
    let r; try { r=normalize('rpoReport',p.rpoReport); } catch { mismatch(); }
    if (r.snapshotCompletedAt!==(registered?e.completedAt:null)||r.sourceObservedAt!==(registered?null:e.observedAt)||r.notesCode!=='COMPARISON_INCOMPLETE') mismatch();
    if (s.candidateKind==='v3_import') { if (e.schemaVersion!==3||t.importEpoch===null||t.importEpoch===t.initialEpoch||p.oldEpoch!==null||p.newEpoch!==t.initialEpoch||p.recoveryCounter!==0) mismatch(); }
    else if (e.schemaVersion!==4||t.importEpoch!==null||p.oldEpoch!==t.initialEpoch||p.newEpoch===p.oldEpoch||previousRecoveryCounter===null||!time(previousRecoveryCounter)||previousRecoveryCounter>=Number.MAX_SAFE_INTEGER||p.recoveryCounter!==previousRecoveryCounter+1) mismatch();
  }
  return p;
}
export function validateRecoveryLocator(locator,{binding=null}={}) {
  let l; try { l=normalize('requestLocator',locator); } catch { mismatch(); }
  if (l.sourceClosedEvidence!==null) {
    let b; try { b=normalize('closureBinding',binding); } catch { mismatch(); }
    const p=l.sourceClosedEvidence;
    for (const key of Object.keys(fields.closureBinding)) if (p[key]!==b[key]) mismatch();
    const e=l.stage.sourceEvidence;
    if (b.sourceRef!==l.stage.sourceRef||b.isolationAckRef!==l.stage.isolationAckRef||b.instanceId!==e.instanceId||b.instanceCreatedAt!==e.instanceCreatedAt||b.schemaVersion!==e.schemaVersion||b.schemaChecksum!==e.schemaChecksum||b.fileHash!==(e.kind==='registered-backup'?e.fileHash:e.closedSourceFileHash)||b.backupId!==(e.kind==='registered-backup'?e.backupId:null)||b.manifestHash!==(e.kind==='registered-backup'?e.manifestHash:null)) mismatch();
  } else if (binding!==null) mismatch();
  return l;
}
export function validateRecoveryNormalizationBindings({stage,copyIntent,base,normalizationIntent,normalized}={}) {
  let s,c,b,i,n;
  try { s=normalize('stage',stage); c=normalize('copyIntent',copyIntent); b=normalize('base',base); i=normalize('normalizationIntent',normalizationIntent); n=normalize('normalized',normalized); } catch { mismatch(); }
  const stageHash=hashRecoveryRecord('stage',s), e=s.sourceEvidence;
  if (s.candidateKind==='fresh_bootstrap'||!e) mismatch();
  const sourceHash=e.kind==='registered-backup'?e.fileHash:e.closedSourceFileHash;
  for (const r of [c,b,i,n]) if (r.runId!==s.runId||r.stageHash!==stageHash||r.candidateBaseHash!==sourceHash) mismatch();
  for (const r of [c,b,i]) if (r.candidateReference!==s.candidateReference) mismatch();
  for (const r of [c,b]) if (r.sourceSchemaVersion!==e.schemaVersion||r.sourceSchemaChecksum!==e.schemaChecksum) mismatch();
  if (b.copyIntentHash!==hashRecoveryRecord('copyIntent',c)||b.sourceWriteMode!==c.sourceWriteMode||b.copyStartedAt!==c.copyStartedAt||
      i.baseRecordHash!==hashRecoveryRecord('base',b)||n.normalizationIntentHash!==hashRecoveryRecord('normalizationIntent',i)||
      n.changed!==(i.originalHeaderMode==='WAL')||(i.originalHeaderMode==='DELETE'&&n.normalizedCandidateHash!==sourceHash)||
      (i.originalHeaderMode==='WAL'&&n.normalizedCandidateHash===sourceHash)||
      c.copyStartedAt<s.createdAt||i.createdAt<c.copyStartedAt||n.normalizedAt<i.createdAt) mismatch();
  return n;
}
export function validateRecoveryPauseBindings({stage,copyIntent,base,normalizationIntent,normalized,pauseIntent,paused}={}) {
  const n=validateRecoveryNormalizationBindings({stage,copyIntent,base,normalizationIntent,normalized});
  let s,b,i,p;
  try { s=normalize('stage',stage); b=normalize('base',base); i=normalize('pauseIntent',pauseIntent); p=normalize('paused',paused); } catch { mismatch(); }
  const stageHash=hashRecoveryRecord('stage',s);
  if (s.candidateKind!=='v3_import'||b.sourceSchemaVersion!==3||i.runId!==s.runId||p.runId!==s.runId||i.stageHash!==stageHash||p.stageHash!==stageHash||
      i.candidateBaseHash!==b.candidateBaseHash||p.candidateBaseHash!==b.candidateBaseHash||i.originalWriteMode!==b.sourceWriteMode||
      i.normalizedRecordHash!==hashRecoveryRecord('normalized',n)||i.pauseInputHash!==n.normalizedCandidateHash||p.pauseInputHash!==i.pauseInputHash||
      p.pauseIntentHash!==hashRecoveryRecord('pauseIntent',i)||p.changed!==(i.originalWriteMode==='enabled')||
      (!p.changed&&p.pausedCandidateHash!==i.pauseInputHash)||i.createdAt<n.normalizedAt||p.pausedAt<i.createdAt) mismatch();
  return p;
}
