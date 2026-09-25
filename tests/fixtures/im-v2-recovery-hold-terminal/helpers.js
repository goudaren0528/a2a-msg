// TEST ONLY C verifier fixture: models a trusted composition callback, not actual
// candidate activation. Real registry holds/sources are always used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { createRecoveryHoldReleaser,withRecoverySource } from '../../../src/im/v2/backup-registry.js';
import { authority,context } from '../im-v2-backup/helpers.js';
import { setup as sourceSetup,hash } from '../im-v2-recovery-source-intent/helpers.js';
export { thrown,deeplyFrozen,directoryState } from '../im-v2-recovery-source-intent/helpers.js';
export { authority,context,unsupported } from '../im-v2-backup/helpers.js';
export const evidenceHash='c'.repeat(64),planHash='d'.repeat(64);
export const approvalAuthority={authorizeApproval:(input,ctx)=>ctx===context&&input.kind==='release-hold'&&input.planHash===planHash&&input.approvalRef==='release-approved'};
export async function setup(t,{v3=false,bound=true}={}) {
  const f=await sourceSetup(t,{v3}),runId=randomUUID();
  let held;
  withRecoverySource(f.registry,{backupId:f.record.backupId,recoveryRunId:runId,stageHash:'a'.repeat(64),preparePlanHash:bound?'b'.repeat(64):null},context,p=>{ held=p; });
  const operation={backupId:f.record.backupId,runId,holdId:held.hold.holdId,releasePlanHash:planHash,approvalRef:'release-approved'};
  const releasePath=join(f.registryRoot,'registry/releases',`${operation.holdId}.json`);
  const make=(verifyTerminal=terminal,options={})=>createRecoveryHoldReleaser({registry:f.registry,authority,approvalAuthority,verifyTerminal,...options});
  t.diagnostic(JSON.stringify({TEST_ONLY:true,sourceKind:f.record.publicationKind,backupId:f.record.backupId,sourceHash:hash(fs.readFileSync(f.artifact)),manifestHash:hash(fs.readFileSync(f.manifest))}));
  return {...f,held,operation,releasePath,make};
}
export function terminal(proof,operation,ctx,publish) {
  assert.equal(ctx,context);assert.equal(proof.record.backupId,operation.backupId);
  assert.equal(proof.hold.recoveryRunId,operation.runId);assert.ok(proof.binding);
  assert.equal(operation.releasePlanHash,planHash);
  return publish({stateEvidenceHash:evidenceHash});
}
export function wrap(replacements) {
  const original={};
  for (const [key,factory] of Object.entries(replacements)) {original[key]=fs[key];fs[key]=factory(fs[key]);}
  syncBuiltinESMExports();
  return ()=>{Object.assign(fs,original);syncBuiltinESMExports();};
}
