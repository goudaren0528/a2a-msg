import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { V4_DDL, V4_CHECKSUM, projectCandidateBudget, assertInheritedImBusiness } from './schema-internal.js';
import { hashMaintenanceV5Record } from './maintenance-v5-records.js';

const MAX = Number.MAX_SAFE_INTEGER;
const check = (c, expr, nullable) => `CHECK(${nullable ? `${c} IS NULL OR ` : ''}(${expr}))`;
const column = (c, type, expr, extra = '', nullable = false) => `${c} ${type}${nullable ? '' : ' NOT NULL'} ${extra} ${check(c, expr, nullable)}`;
const u = (c, extra = '', nullable = false) => column(c, 'TEXT', `typeof(${c})='text' AND length(${c})=36 AND ${c} GLOB '${[8,4,4,4,12].map(n => '[0-9a-f]'.repeat(n)).join('-')}'`, extra, nullable);
const h = (c, extra = '', nullable = false) => column(c, 'TEXT', `typeof(${c})='text' AND length(${c})=64 AND ${c} NOT GLOB '*[^0-9a-f]*'`, extra, nullable);
const ref = (c, extra = '', nullable = false) => column(c, 'TEXT', `typeof(${c})='text' AND length(${c}) BETWEEN 1 AND 255`, extra, nullable);
const n = (c, extra = '', nullable = false, min = 0, max = MAX) => column(c, 'INTEGER', `typeof(${c})='integer' AND ${c} BETWEEN ${min} AND ${max}`, extra, nullable);
const table = (name, fields) => `CREATE TABLE ${name} (${fields.join(', ')})`;

export const V5_SCHEMA = 'CREATE TABLE im_schema (version INTEGER NOT NULL PRIMARY KEY CHECK(version=5), migration_checksum TEXT NOT NULL CHECK(length(migration_checksum)=64))';
export const V5_TABLES = Object.freeze([
  table('im_maintenance_time_anchors', [
    n('generation','PRIMARY KEY',false,1), u('center_epoch','REFERENCES im_center_epochs(center_epoch)'),
    n('previous_generation','REFERENCES im_maintenance_time_anchors(generation)',true,1), h('previous_anchor_hash','',true),
    h('proposal_hash','UNIQUE'), h('anchor_hash','UNIQUE'), u('session_nonce','UNIQUE'),
    ...['proposed_at','proposal_expires_at','candidate_wall_at','accept_not_before','accept_not_after','accepted_wall_at','global_floor_observed_at','global_floor_at_approval'].map(c => n(c)),
    n('max_forward_jump_ms','',false,1,86400000), ref('approval_ref'), ref('executor_id'), ref('approver_id'),
    'CHECK ((previous_generation IS NULL AND previous_anchor_hash IS NULL) OR (previous_generation IS NOT NULL AND previous_anchor_hash IS NOT NULL AND previous_generation<generation))',
    'CHECK (proposed_at=candidate_wall_at AND accept_not_before=candidate_wall_at)',
    'CHECK (proposal_expires_at>proposed_at AND proposal_expires_at-proposed_at<=300000)',
    'CHECK (accept_not_after>accept_not_before AND accept_not_after-accept_not_before<=5000)',
    'CHECK (accepted_wall_at>=accept_not_before AND accepted_wall_at<=accept_not_after AND accepted_wall_at<proposal_expires_at)',
    'CHECK (global_floor_at_approval>=global_floor_observed_at AND accepted_wall_at>=global_floor_at_approval)',
    'CHECK (executor_id<>approver_id)', 'UNIQUE(center_epoch,generation,anchor_hash)',
  ]),
  table('im_maintenance_time_head', [
    n('singleton','PRIMARY KEY',false,1,1), u('center_epoch','REFERENCES im_center_epochs(center_epoch)'),
    n('generation','',false,1), h('anchor_hash'),
    'FOREIGN KEY(center_epoch,generation,anchor_hash) REFERENCES im_maintenance_time_anchors(center_epoch,generation,anchor_hash)',
  ]),
  table('im_center_schema_transitions', [
    u('transition_id','PRIMARY KEY'), n('from_version','',false,4,4), n('to_version','',false,5,5),
    u('instance_id'), n('instance_created_at'), u('center_epoch','REFERENCES im_center_epochs(center_epoch)'),
    h('from_checksum'), h('to_checksum'), u('recovery_run_id'), h('stage_hash'), ref('candidate_reference'),
    column('candidate_kind','TEXT',"typeof(candidate_kind)='text' AND candidate_kind IN ('fresh_bootstrap','v3_import','snapshot_recovery')"),
    ref('preparation_ref','REFERENCES im_schema_preparations(preparation_ref)',true), h('source_evidence_hash','',true),
    h('preconversion_file_hash'), h('execution_policy_hash','REFERENCES im_retention_policies(policy_hash)'),
    n('plan_created_at'), n('plan_expires_at'), ref('approver_id'), h('approved_plan_hash','UNIQUE'),
    ref('approval_ref'), ref('executor_id'), n('converted_at'),
    "CHECK ((candidate_kind='fresh_bootstrap' AND preparation_ref IS NOT NULL AND source_evidence_hash IS NULL) OR (candidate_kind='v3_import' AND preparation_ref IS NOT NULL AND source_evidence_hash IS NOT NULL) OR (candidate_kind='snapshot_recovery' AND preparation_ref IS NULL AND source_evidence_hash IS NOT NULL))",
    "CHECK (candidate_reference='runs/'||recovery_run_id||'/candidate.sqlite')",
    'CHECK (plan_expires_at>plan_created_at AND plan_expires_at-plan_created_at<=300000)',
    'CHECK (converted_at>=plan_created_at AND converted_at<plan_expires_at)', 'CHECK (executor_id<>approver_id)',
  ]),
]);
export const V5_INDEXES = Object.freeze(['CREATE INDEX im_maintenance_time_epoch ON im_maintenance_time_anchors(center_epoch,generation)']);
export const V5_DDL = Object.freeze([V5_SCHEMA,...V4_DDL.slice(1),...V5_TABLES,...V5_INDEXES]);
const normalize = sql => sql.trim().replace(/\s+/g,' ');
const manifest = rows => rows.map(({type,name,tbl_name,sql}) => [type,name,tbl_name,normalize(sql)]).sort((a,b) => a[1].localeCompare(b[1]));
export const V5_MANIFEST = Object.freeze(manifest(V5_DDL.map(sql => {
  const [,kind,name] = /^CREATE (TABLE|INDEX) (im_\w+)/.exec(sql);
  return {type:kind.toLowerCase(),name,tbl_name:kind==='TABLE'?name:/ ON (im_\w+)/.exec(sql)[1],sql};
})).map(Object.freeze));
export const V5_CHECKSUM = createHash('sha256').update(JSON.stringify(V5_MANIFEST)).digest('hex');
// Autoindexes have NULL SQL and are excluded from the historical checksum. Their
// exact names/owners still follow from the immutable table UNIQUE/PK clauses.
const autoindexes=V5_DDL.filter(sql => sql.startsWith('CREATE TABLE ')).flatMap(sql => {
  const name=/^CREATE TABLE (im_\w+)/.exec(sql)[1];
  const keys=sql.match(/\bUNIQUE\b|\bPRIMARY KEY\b/g) ?? [];
  const integerPrimary=/\b\w+ INTEGER NOT NULL PRIMARY KEY\b|\b\w+ INTEGER PRIMARY KEY\b/.test(sql);
  return Array.from({length:keys.length-Number(integerPrimary)},(_,index) => [`sqlite_autoindex_${name}_${index+1}`,name]);
}).sort((a,b) => a[0].localeCompare(b[0]));

const DEFAULTS = Object.freeze({maxMessages:10000,maxVerifiedContentBytes:104857600,maxOtherRecords:10000,maxElapsedMs:10000,maxMaintenanceAnchors:10000,maxMaintenanceMetadataBytes:10485760});
const errors = new WeakSet();
function fail(code = 'IM_SCHEMA_MISMATCH') {
  const error = Object.assign(new Error(code),{code});
  errors.add(error);
  throw error;
}
// Never read a thrown value's properties: native/provider error getters are untrusted.
function safeFailure(error) {
  if (errors.has(error)) throw error;
  if (error===null || (typeof error!=='object' && typeof error!=='function') || types.isProxy(error)) fail();
  let budgetExceeded=false;
  try {
    const descriptor=Object.getOwnPropertyDescriptor(error,'code');
    budgetExceeded=!!descriptor && Object.hasOwn(descriptor,'value') && descriptor.value==='IM_V2_BUDGET_EXCEEDED';
  } catch {}
  if (budgetExceeded) fail('IM_V2_BUDGET_EXCEEDED');
  fail();
}
function makeBudget(parent) {
  const start = performance.now();
  const limits = {...DEFAULTS};
  if (parent !== undefined) {
    if (!parent || typeof parent.tick!=='function' || !parent.limits) fail();
    for (const key of Object.keys(parent.limits)) {
      const value = parent.limits[key];
      if (!Object.hasOwn(DEFAULTS,key) || !Number.isSafeInteger(value) || value<1 || value>DEFAULTS[key]) fail();
      limits[key]=value;
    }
  }
  let metadataBytes = 0;
  return {limits, tick() {
    if (performance.now()-start>limits.maxElapsedMs) fail('IM_V2_BUDGET_EXCEEDED');
    if (parent) parent.tick();
  }, reserve(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes<0) fail();
    metadataBytes+=bytes;
    if (!Number.isSafeInteger(metadataBytes) || metadataBytes>limits.maxMaintenanceMetadataBytes) fail('IM_V2_BUDGET_EXCEEDED');
    this.tick();
  }};
}
function count(db, tableName, limit, budget) {
  const value=db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${tableName} LIMIT ?)`).get(limit+1).n;
  budget.tick();
  if (!Number.isSafeInteger(value) || value<0) fail();
  if (value>limit) fail('IM_V2_BUDGET_EXCEEDED');
  return value;
}
function assertManifest(db,budget) {
  if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys!==1) fail();
  if (db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'im_%' OR tbl_name LIKE 'im_%' LIMIT 1").get()) fail();
  budget.tick();
  const scope="(name LIKE 'im_%' OR tbl_name LIKE 'im_%') AND name NOT LIKE 'sqlite_autoindex_%'";
  const size=db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM sqlite_master WHERE ${scope} LIMIT ?)`).get(V5_MANIFEST.length+1).n;
  budget.tick();
  if (size!==V5_MANIFEST.length) fail();
  for (const row of db.prepare(`SELECT length(CAST(type AS BLOB))+length(CAST(name AS BLOB))+length(CAST(tbl_name AS BLOB))+coalesce(length(CAST(sql AS BLOB)),0) AS bytes FROM sqlite_master WHERE ${scope} LIMIT ?`).iterate(V5_MANIFEST.length)) budget.reserve(row.bytes+64);
  const rows=db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE ${scope} ORDER BY name LIMIT ?`).all(V5_MANIFEST.length);
  budget.tick();
  if (JSON.stringify(manifest(rows))!==JSON.stringify(V5_MANIFEST)) fail();
  const automaticCount=db.prepare("SELECT count(*) AS n FROM (SELECT 1 FROM sqlite_master WHERE name LIKE 'sqlite_autoindex_%' AND tbl_name LIKE 'im_%' LIMIT ?)").get(autoindexes.length+1).n;
  budget.tick();
  if (automaticCount!==autoindexes.length) fail();
  for (const row of db.prepare("SELECT length(CAST(name AS BLOB))+length(CAST(tbl_name AS BLOB))+coalesce(length(CAST(sql AS BLOB)),0) AS bytes FROM sqlite_master WHERE name LIKE 'sqlite_autoindex_%' AND tbl_name LIKE 'im_%' LIMIT ?").iterate(autoindexes.length)) budget.reserve(row.bytes+32);
  const automatic=db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'sqlite_autoindex_%' AND tbl_name LIKE 'im_%' ORDER BY name LIMIT ?").all(autoindexes.length+1);
  budget.tick();
  if (automatic.some(row => row.sql!==null) || JSON.stringify(automatic.map(row => [row.name,row.tbl_name]).sort((a,b) => a[0].localeCompare(b[0])))!==JSON.stringify(autoindexes)) fail();
  const marker=db.prepare('SELECT version,length(CAST(migration_checksum AS BLOB)) AS bytes FROM im_schema LIMIT 2').all();
  budget.tick();
  if (marker.length!==1 || marker[0].version!==5 || marker[0].bytes!==64) fail();
  budget.reserve(64);
  if (db.prepare('SELECT migration_checksum FROM im_schema LIMIT 1').get().migration_checksum!==V5_CHECKSUM) fail();
  budget.tick();
}

// Project all TEXT metadata, including inherited refs/policies, before shared checks
// materialize any of it. Content/BLOB projections keep their inherited byte ceiling.
function projectMetadata(db,budget) {
  const names=V5_MANIFEST.filter(row => row[0]==='table').map(row => row[1]);
  for (const name of names) {
    const limit=name==='im_maintenance_time_anchors' ? budget.limits.maxMaintenanceAnchors
      : name==='im_maintenance_time_head' || name==='im_center_schema_transitions' ? 1
        : budget.limits.maxMessages+budget.limits.maxOtherRecords;
    if (name==='im_center_schema_transitions' || name==='im_maintenance_time_head') {
      const size=db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${name} LIMIT 2)`).get().n;
      budget.tick();
      if (size>1 || name==='im_center_schema_transitions' && size!==1) fail();
    } else count(db,name,limit,budget);
    const fields=db.prepare(`PRAGMA table_info(${name})`).all().filter(row => row.type==='TEXT'
      && !(name==='im_messages' && ['text','title','correlation'].includes(row.name))
      && !(name==='im_attachments' && ['name','mime'].includes(row.name))).map(row => row.name);
    budget.tick();
    if (!fields.length) continue;
    const expression=fields.map(field => `coalesce(length(CAST(${field} AS BLOB)),0)`).join('+');
    for (const row of db.prepare(`SELECT ${expression} AS bytes FROM ${name} LIMIT ?`).iterate(limit+1)) {
      // Six bytes per input byte bounds JSON escaping; fixed allowance covers field
      // names, punctuation and integer/null framing for both reconstructed records.
      const evidence=name==='im_maintenance_time_anchors' || name==='im_center_schema_transitions';
      budget.reserve(evidence ? row.bytes*12+4096 : row.bytes+fields.length*32);
    }
  }
}
function planFromRow(row) {
  return {version:1,transitionId:row.transition_id,instanceId:row.instance_id,instanceCreatedAt:row.instance_created_at,
    centerEpoch:row.center_epoch,recoveryRunId:row.recovery_run_id,stageHash:row.stage_hash,candidateReference:row.candidate_reference,
    candidateKind:row.candidate_kind,preparationRef:row.preparation_ref,sourceEvidenceHash:row.source_evidence_hash,
    fromVersion:row.from_version,fromChecksum:row.from_checksum,toVersion:row.to_version,toChecksum:row.to_checksum,
    preconversionFileHash:row.preconversion_file_hash,executionPolicyHash:row.execution_policy_hash,
    createdAt:row.plan_created_at,expiresAt:row.plan_expires_at};
}
function assertTransition(db,identity,center,budget) {
  const rows=db.prepare('SELECT * FROM im_center_schema_transitions LIMIT 2').all();
  budget.tick();
  if (rows.length!==1) fail();
  const row=rows[0];
  if (row.instance_id!==identity.instance_id || row.instance_created_at!==identity.created_at || row.from_checksum!==V4_CHECKSUM || row.to_checksum!==V5_CHECKSUM) fail();
  const epoch=db.prepare('SELECT center_epoch FROM im_center_epochs WHERE center_epoch=?').get(row.center_epoch);
  const policy=db.prepare('SELECT policy_hash FROM im_retention_policies WHERE policy_hash=?').get(row.execution_policy_hash);
  budget.tick();
  if (!epoch || !policy) fail();
  // The original conversion epoch survives recovery. Follow retained recovery
  // lineage rather than demanding that the conversion epoch is still current.
  const predecessors=new Map();
  for (const run of db.prepare('SELECT new_epoch,old_epoch FROM im_recovery_runs').iterate()) {
    budget.tick();
    predecessors.set(run.new_epoch,run.old_epoch);
  }
  const visited=new Set();
  let cursor=center.center_epoch;
  while (cursor!==row.center_epoch) {
    budget.tick();
    if (visited.has(cursor) || !predecessors.has(cursor)) fail();
    visited.add(cursor);
    cursor=predecessors.get(cursor);
    if (cursor===null) fail();
  }
  if (row.preparation_ref!==null) {
    const preparation=db.prepare('SELECT kind,initial_epoch FROM im_schema_preparations WHERE preparation_ref=?').get(row.preparation_ref);
    budget.tick();
    if (!preparation || preparation.initial_epoch!==row.center_epoch || preparation.kind!==(row.candidate_kind==='fresh_bootstrap'?'fresh':'v3_import')) fail();
  }
  const plan=planFromRow(row);
  if (hashMaintenanceV5Record('conversionPlan',plan)!==row.approved_plan_hash) fail();
  // A proof has no in-DB hash column: reconstruct its canonical hash from facts.
  hashMaintenanceV5Record('conversionProof',{version:1,plan,planHash:row.approved_plan_hash,
    approvalRef:row.approval_ref,executorId:row.executor_id,approverId:row.approver_id,convertedAt:row.converted_at});
  budget.tick();
}
function assertAnchors(db,identity,center,budget) {
  let tip=null;
  for (const row of db.prepare('SELECT * FROM im_maintenance_time_anchors ORDER BY generation LIMIT ?').iterate(budget.limits.maxMaintenanceAnchors+1)) {
    budget.tick();
    if (tip ? tip.generation===MAX || row.generation!==tip.generation+1 || row.previous_generation!==tip.generation || row.previous_anchor_hash!==tip.anchor_hash || row.accepted_wall_at<tip.accepted_wall_at
      : row.generation!==1 || row.previous_generation!==null || row.previous_anchor_hash!==null) fail();
    const proposal={version:1,instanceId:identity.instance_id,instanceCreatedAt:identity.created_at,centerEpoch:row.center_epoch,
      previousGeneration:row.previous_generation,previousAnchorHash:row.previous_anchor_hash,sessionNonce:row.session_nonce,
      proposedAt:row.proposed_at,proposalExpiresAt:row.proposal_expires_at,candidateWallAt:row.candidate_wall_at,
      acceptNotBefore:row.accept_not_before,acceptNotAfter:row.accept_not_after,globalFloorObservedAt:row.global_floor_observed_at,maxForwardJumpMs:row.max_forward_jump_ms};
    if (hashMaintenanceV5Record('timeProposal',proposal)!==row.proposal_hash) fail();
    const evidence={...proposal,generation:row.generation,proposalHash:row.proposal_hash,acceptedWallAt:row.accepted_wall_at,
      globalFloorAtApproval:row.global_floor_at_approval,approvalRef:row.approval_ref,executorId:row.executor_id,approverId:row.approver_id};
    if (hashMaintenanceV5Record('anchorEvidence',evidence)!==row.anchor_hash) fail();
    tip=row;
    budget.tick();
  }
  const rows=db.prepare('SELECT * FROM im_maintenance_time_head LIMIT 2').all();
  budget.tick();
  if (rows.length>1) fail();
  if (rows.length) {
    const head=rows[0];
    if (!tip || head.singleton!==1 || head.center_epoch!==center.center_epoch || head.center_epoch!==tip.center_epoch || head.generation!==tip.generation || head.anchor_hash!==tip.anchor_hash) fail();
  }
}
export function assertImSchemaV5Internal(db,parentBudget) {
  try {
    const budget=makeBudget(parentBudget);
    budget.tick();
    assertManifest(db,budget);
    projectCandidateBudget(db,budget,4);
    projectMetadata(db,budget);
    assertInheritedImBusiness(db,budget);
    budget.tick();
    const identity=db.prepare('SELECT instance_id,created_at FROM im_instance_identity LIMIT 1').get();
    const center=db.prepare('SELECT center_epoch FROM im_center_state LIMIT 1').get();
    assertTransition(db,identity,center,budget);
    assertAnchors(db,identity,center,budget);
    budget.tick();
  } catch (error) { safeFailure(error); }
}
