// Synthetic test transactions, never a runtime converter or time authority.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertImSchemaV4 } from '../../../src/im/v2/schema.js';
import { initializeImSchemaV4, migrateImSchemaV4 } from '../../../src/im/v2/migration.js';
import { database, legacy, freshOptions, importOptions, insert, snapshot, recoveryRow, bindRun } from '../im-v2-schema/helpers.js';

export const GOLDEN=JSON.parse(readFileSync(new URL('./checksums.json',import.meta.url),'utf8'));
export const DDL=JSON.parse(readFileSync(new URL('./v5-additive-ddl.json',import.meta.url),'utf8'));
export const MANIFEST=JSON.parse(readFileSync(new URL('./v5-manifest.json',import.meta.url),'utf8'));
export const V4='c950eb40692a72f918c8976d4bef8cab0b9e357495b01df75e0ab2d1b0b5f216';
const sha=bytes => createHash('sha256').update(bytes).digest('hex');
const fields={
  timeProposal:'version instanceId instanceCreatedAt centerEpoch previousGeneration previousAnchorHash sessionNonce proposedAt proposalExpiresAt candidateWallAt acceptNotBefore acceptNotAfter globalFloorObservedAt maxForwardJumpMs',
  anchorEvidence:'version instanceId instanceCreatedAt generation centerEpoch previousGeneration previousAnchorHash proposalHash sessionNonce proposedAt proposalExpiresAt candidateWallAt acceptNotBefore acceptNotAfter acceptedWallAt globalFloorObservedAt globalFloorAtApproval maxForwardJumpMs approvalRef executorId approverId',
  conversionPlan:'version transitionId instanceId instanceCreatedAt centerEpoch recoveryRunId stageHash candidateReference candidateKind preparationRef sourceEvidenceHash fromVersion fromChecksum toVersion toChecksum preconversionFileHash executionPolicyHash createdAt expiresAt',
};
const domains={timeProposal:'im-maintenance-time-proposal-v1\n',anchorEvidence:'im-maintenance-time-anchor-v1\n',conversionPlan:'im-center-schema-conversion-plan-v1\n'};
export function recordHash(kind,value) {
  return sha(domains[kind]+JSON.stringify(Object.fromEntries(fields[kind].split(' ').map(key => [key,value[key]]))));
}
export const snake=key => key.replace(/[A-Z]/g,letter => '_'+letter.toLowerCase());
export function transitionPlan(db,patch={}) {
  const row=db.prepare('SELECT * FROM im_center_schema_transitions').get();
  const plan={version:1};
  for (const field of fields.conversionPlan.split(' ').slice(1)) plan[field]=row[field==='createdAt'?'plan_created_at':field==='expiresAt'?'plan_expires_at':snake(field)];
  return {...plan,...patch};
}
export function rehashTransition(db,patch={}) {
  const plan=transitionPlan(db,patch);
  db.prepare('UPDATE im_center_schema_transitions SET approved_plan_hash=?').run(recordHash('conversionPlan',plan));
}
export function fixture(t,{business=false,kind=business?'v3_import':'fresh_bootstrap'}={}) {
  const f=business || kind==='v3_import' ? legacy(t,{leases:true}) : {db:database(t)};
  const {db}=f;
  if (business || kind==='v3_import') migrateImSchemaV4(db,importOptions());
  else initializeImSchemaV4(db,freshOptions());
  assert.equal(assertImSchemaV4(db),true,'P1 baseline before synthetic construction');
  const before=snapshot(db);
  const identity=db.prepare('SELECT * FROM im_instance_identity').get();
  const preparation=db.prepare('SELECT * FROM im_schema_preparations').get();
  const epoch=db.prepare('SELECT center_epoch FROM im_center_state').get().center_epoch;
  const now=Math.max(identity.created_at,preparation.created_at)+100;
  const run=randomUUID();
  const plan={version:1,transitionId:randomUUID(),instanceId:identity.instance_id,instanceCreatedAt:identity.created_at,
    centerEpoch:epoch,recoveryRunId:run,stageHash:'a'.repeat(64),candidateReference:`runs/${run}/candidate.sqlite`,
    candidateKind:kind,preparationRef:kind==='snapshot_recovery'?null:preparation.preparation_ref,
    sourceEvidenceHash:kind==='fresh_bootstrap'?null:'b'.repeat(64),fromVersion:4,fromChecksum:V4,toVersion:5,toChecksum:GOLDEN.checksum,
    preconversionFileHash:'c'.repeat(64),executionPolicyHash:preparation.policy_hash,createdAt:now,expiresAt:now+300000};
  const row=Object.fromEntries(Object.entries(plan).filter(([key]) => key!=='version').map(([key,value]) => [key==='createdAt'?'plan_created_at':key==='expiresAt'?'plan_expires_at':snake(key),value]));
  Object.assign(row,{approver_id:'independent-reviewer',approved_plan_hash:recordHash('conversionPlan',plan),approval_ref:'conversion-approval',executor_id:'fixture-builder',converted_at:now+1});
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DROP TABLE im_schema');
    for (const sql of DDL) db.exec(sql);
    insert(db,'im_schema',{version:5,migration_checksum:GOLDEN.checksum});
    insert(db,'im_center_schema_transitions',row);
    db.exec('COMMIT');
  } catch (error) {db.exec('ROLLBACK');throw error;}
  const after=snapshot(db);
  for (const [name,rows] of Object.entries(before.rows)) if (name!=='im_schema') assert.deepEqual(after.rows[name],rows,`${name} unchanged`);
  return {...f,identity,epoch,now,plan};
}
export function anchor(db,patch={}) {
  const identity=db.prepare('SELECT * FROM im_instance_identity').get();
  const previous=db.prepare('SELECT * FROM im_maintenance_time_anchors ORDER BY generation DESC LIMIT 1').get();
  const wall=previous?previous.accepted_wall_at+10:1000;
  const proposal={version:1,instanceId:identity.instance_id,instanceCreatedAt:identity.created_at,
    centerEpoch:db.prepare('SELECT center_epoch FROM im_center_state').get().center_epoch,
    previousGeneration:previous?.generation??null,previousAnchorHash:previous?.anchor_hash??null,sessionNonce:randomUUID(),
    proposedAt:wall,proposalExpiresAt:wall+300000,candidateWallAt:wall,acceptNotBefore:wall,acceptNotAfter:wall+5000,
    globalFloorObservedAt:wall-2,maxForwardJumpMs:86400000,...patch};
  const evidence={...proposal,generation:previous?previous.generation+1:1,proposalHash:recordHash('timeProposal',proposal),
    acceptedWallAt:wall,globalFloorAtApproval:wall-1,approvalRef:'time-approval',executorId:'executor',approverId:'approver',...patch};
  const row=Object.fromEntries(fields.anchorEvidence.split(' ').filter(key => !['version','instanceId','instanceCreatedAt'].includes(key)).map(key => [snake(key),evidence[key]]));
  row.anchor_hash=recordHash('anchorEvidence',evidence);
  insert(db,'im_maintenance_time_anchors',row);
  return row;
}
export function head(db,row) {
  insert(db,'im_maintenance_time_head',{singleton:1,center_epoch:row.center_epoch,generation:row.generation,anchor_hash:row.anchor_hash});
}
export function recover(db) {
  const old=db.prepare('SELECT * FROM im_center_state').get();
  const epoch=randomUUID();
  insert(db,'im_center_epochs',{center_epoch:epoch,created_at:2000,origin:'recovery',recovery_counter:old.recovery_counter+1});
  const row=recoveryRow(db,'snapshot_recovery',{run_id:randomUUID(),preparation_ref:null,old_epoch:old.center_epoch,new_epoch:epoch,
    backup_id:randomUUID(),backup_file_hash:'d'.repeat(64),manifest_hash:'e'.repeat(64),candidate_base_hash:'d'.repeat(64)});
  db.prepare('UPDATE im_center_state SET center_epoch=?,recovery_counter=?').run(epoch,old.recovery_counter+1);
  bindRun(db,row);
  return epoch;
}
