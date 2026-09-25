// TEST ONLY deterministic evidence. No activation, authorization or runtime DB proof.
import { createHash } from 'node:crypto';
export const U='00000000-0000-0000-0000-000000000001', B='00000000-0000-0000-0000-000000000002', E='00000000-0000-0000-0000-000000000003';
export const H='a'.repeat(64), F='b'.repeat(64), M='c'.repeat(64), P='d'.repeat(64);
export const V4='c950eb40692a72f918c8976d4bef8cab0b9e357495b01df75e0ab2d1b0b5f216';
export const sha=x=>createHash('sha256').update(x).digest('hex');
export const digest=x=>sha(JSON.stringify(x));
export function chain(route='fresh',v3Checksum) {
  const fresh=route==='fresh',closed=route==='closed',snapshot=route==='snapshot';
  const candidateKind=fresh?'fresh_bootstrap':snapshot?'snapshot_recovery':'v3_import';
  const sourceRef=fresh?null:'catalog:key',isolationAckRef=fresh?null:'isolated',schemaChecksum=snapshot?V4:v3Checksum;
  const sourceEvidence=fresh?null:closed?{version:1,kind:'closed-source',sourceRef,instanceId:U,instanceCreatedAt:10,schemaVersion:3,schemaChecksum,closedSourceFileHash:F,observedAt:21,isolationAckRef}:
    {version:1,kind:'registered-backup',sourceRef:`backup:${B}`,registryFormat:snapshot?3:2,instanceId:U,instanceCreatedAt:10,backupId:B,fileHash:F,manifestHash:M,schemaVersion:snapshot?4:3,schemaChecksum,completedAt:20,importedRecordHash:snapshot?null:H};
  const sourceClosedEvidence=fresh?null:{version:1,evidenceRef:'proof:one',sourceRef,isolationAckRef,sourceKind:closed?'closed-source':'registered-backup',instanceId:U,instanceCreatedAt:10,schemaVersion:snapshot?4:3,schemaChecksum,fileHash:F,backupId:closed?null:B,manifestHash:closed?null:M,issuedAt:19};
  const stage={version:1,requestRef:'request',requestHash:digest([candidateKind,sourceRef,isolationAckRef,P]),runId:U,candidateKind,sourceRef,sourceEvidence,sourceClosedEvidenceRef:sourceClosedEvidence?.evidenceRef??null,sourceClosedEvidenceHash:sourceClosedEvidence?digest(sourceClosedEvidence):null,isolationAckRef,policyHash:P,candidateReference:`runs/${U}/candidate.sqlite`,preparationRef:snapshot?null:'prepare:one',createdAt:22};
  const stageHash=digest(stage);
  const staged={version:1,runId:U,stageHash,candidateBaseHash:fresh?null:F,preparationRef:stage.preparationRef,instanceId:U,instanceCreatedAt:10,initialEpoch:E,importEpoch:fresh||snapshot?null:B,stagedAt:23};
  const base=fresh?null:{version:2,runId:U,stageHash,candidateReference:stage.candidateReference,copyIntentHash:H,candidateBaseHash:F,sourceSchemaVersion:snapshot?4:3,sourceSchemaChecksum:schemaChecksum,sourceWriteMode:'paused',copyStartedAt:22};
  const rpoReport=fresh?null:{status:'unknown',snapshotCompletedAt:closed?null:20,sourceObservedAt:closed?21:null,missingAcceptedCount:null,missingAckCount:null,missingReadCount:null,comparisonEvidenceHash:null,authChanges:'unknown',notesCode:'COMPARISON_INCOMPLETE'};
  const preparePlan={version:1,runId:U,candidateKind,preparationRef:stage.preparationRef,instanceId:U,instanceCreatedAt:10,backupId:fresh||closed?null:B,backupFileHash:fresh||closed?null:F,manifestHash:fresh||closed?null:M,sourceSchemaVersion:fresh?null:snapshot?4:3,sourceSchemaChecksum:fresh?null:schemaChecksum,candidateReference:stage.candidateReference,oldEpoch:snapshot?E:null,newEpoch:snapshot?B:E,recoveryCounter:snapshot?8:0,policyHash:P,rpoReport,sourceEvidence,sourceClosedEvidenceRef:sourceClosedEvidence?.evidenceRef??null,isolationAckRef,createdAt:100,expiresAt:300100};
  const prepareEvidence={stage,staged,sourceClosedEvidence,base,previousRecoveryCounter:snapshot?7:null};
  const seal={version:1,runId:U,preparePlanHash:digest(preparePlan),newEpoch:preparePlan.newEpoch,candidateReference:stage.candidateReference,candidateFileHash:F,schemaChecksum:V4,verifiedAt:200,verification:{integrity:true,foreignKeys:true,schema:true,invariants:true}};
  const sealEvidence={preparePlan,prepareEvidence,candidateFileHash:F,schemaChecksum:V4,verifiedAt:200,sealReference:`runs/${U}/seals/${digest(seal)}.json`};
  const activationPlan={version:1,runId:U,preparePlanHash:digest(preparePlan),sealHash:digest(seal),candidateReference:stage.candidateReference,newEpoch:preparePlan.newEpoch,authReviewRef:'review',isolationAckRef,createdAt:300,expiresAt:300300,activationRef:'activate'};
  const activationEvidence={seal,sealEvidence};
  const completion={version:1,runId:U,preparePlanHash:digest(preparePlan),activationPlanHash:digest(activationPlan),activationApprovalRef:'approval:activate',activationRef:'activate',sealHash:digest(seal),candidateReference:stage.candidateReference,instanceId:U,instanceCreatedAt:10,newEpoch:preparePlan.newEpoch,recoveryCounter:preparePlan.recoveryCounter,activatedAt:400,writeMode:'paused'};
  const actual={run:{runId:U,preparePlanHash:digest(preparePlan),prepareApprovalRef:'approval:prepare',candidateReference:stage.candidateReference,newEpoch:preparePlan.newEpoch,status:'active',verifiedAt:200,activationPlanHash:digest(activationPlan),activationApprovalRef:'approval:activate',activationRef:'activate',activatedAt:400,authReviewRef:'review',isolationAckRef,failureCode:null},
    center:{runId:U,newEpoch:preparePlan.newEpoch,status:'active',activationRef:'activate',updatedAt:400,recoveryCounter:preparePlan.recoveryCounter},instance:{instanceId:U,instanceCreatedAt:10},epoch:{newEpoch:preparePlan.newEpoch,recoveryCounter:preparePlan.recoveryCounter},writeMode:'paused'};
  const completionEvidence={activationPlan,activationEvidence,prepareApprovalRef:'approval:prepare',actual};
  const hold={version:1,holdId:E,backupId:B,recoveryRunId:U,stageHash,createdAt:90};
  const binding={version:1,holdId:E,stageHash,preparePlanHash:digest(preparePlan),boundAt:100};
  const releasePlan={version:1,runId:U,holdId:E,backupId:B,stageHash,preparePlanHash:digest(preparePlan),activationCompletionHash:digest(completion),terminalState:'active',candidateReference:stage.candidateReference,newEpoch:preparePlan.newEpoch};
  const releaseEvidence={completion,completionEvidence,hold,binding};
  return {seal,sealEvidence,activationPlan,activationEvidence,completion,completionEvidence,releasePlan,releaseEvidence};
}

// Literal field ordering is independent of production code. Hash vectors are
// pinned separately using Python hashlib over these UTF-8 strings.
export const literals={
  seal:`{"version":1,"runId":"${U}","preparePlanHash":"${H}","newEpoch":"${E}","candidateReference":"runs/${U}/candidate.sqlite","candidateFileHash":"${F}","schemaChecksum":"${V4}","verifiedAt":42,"verification":{"integrity":true,"foreignKeys":true,"schema":true,"invariants":true}}`,
  activationPlan:`{"version":1,"runId":"${U}","preparePlanHash":"${H}","sealHash":"${F}","candidateReference":"runs/${U}/candidate.sqlite","newEpoch":"${E}","authReviewRef":"review","isolationAckRef":null,"createdAt":42,"expiresAt":300042,"activationRef":"activate"}`,
  activationCompletion:`{"version":1,"runId":"${U}","preparePlanHash":"${H}","activationPlanHash":"${M}","activationApprovalRef":"approval","activationRef":"activate","sealHash":"${F}","candidateReference":"runs/${U}/candidate.sqlite","instanceId":"${B}","instanceCreatedAt":10,"newEpoch":"${E}","recoveryCounter":0,"activatedAt":50,"writeMode":"paused"}`,
  releasePlan:`{"version":1,"runId":"${U}","holdId":"${E}","backupId":"${B}","stageHash":"${P}","preparePlanHash":"${H}","activationCompletionHash":"${M}","terminalState":"active","candidateReference":"runs/${U}/candidate.sqlite","newEpoch":"${E}"}`
};
