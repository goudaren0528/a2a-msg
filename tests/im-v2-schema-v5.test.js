import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import * as v4 from '../src/im/v2/schema.js';
import * as v5 from '../src/im/v2/schema-v5.js';
import * as dispatch from '../src/im/v2/schema-dispatch.js';
import { V4_DDL } from '../src/im/v2/schema-internal.js';
import { V5_DDL,V5_SCHEMA,V5_TABLES,V5_INDEXES,V5_CHECKSUM,V5_MANIFEST,assertImSchemaV5Internal } from '../src/im/v2/schema-v5-internal.js';
import { initializeImSchemaV4 } from '../src/im/v2/migration.js';
import { encodeMaintenanceV5Record,hashMaintenanceV5Record } from '../src/im/v2/maintenance-v5-records.js';
import { database,freshOptions,insert,manifest,snapshot,observe,putPolicy,policy } from './fixtures/im-v2-schema/helpers.js';
import { fixture,anchor,head,recover,rehashTransition,recordHash,transitionPlan,GOLDEN,MANIFEST,DDL,V4 } from './fixtures/im-v2-schema-v5/helpers.js';

const mismatch={code:'IM_SCHEMA_MISMATCH'};
const exhausted={code:'IM_V2_BUDGET_EXCEEDED'};
const sha=value => createHash('sha256').update(value).digest('hex');
const checkFailure=error => error.code==='ERR_SQLITE_ERROR' && /CHECK constraint failed/.test(error.message);
const budget=limits => ({limits,tick(){}});
const publicValidators=[v5.assertImSchemaV5,dispatch.assertSupportedImV2Center];
function fixedError(code) {
  return error => {
    assert.ok(error instanceof Error);
    assert.equal(error.code,code);
    assert.equal(error.message,code);
    assert.equal('cause' in error,false);
    assert.deepEqual(Object.getOwnPropertyNames(error).sort(),['code','message','stack']);
    return true;
  };
}
function validPublicControl(db) {
  assert.equal(v5.assertImSchemaV5(db),undefined);
  assert.deepEqual(dispatch.assertSupportedImV2Center(db),{schemaVersion:5,schemaChecksum:GOLDEN.checksum});
}
// Explicit contract section 4.2 projection, independent of validator reconstruction.
function anchorRecords(row,identity) {
  const proposal={version:1,instanceId:identity.instance_id,instanceCreatedAt:identity.created_at,
    centerEpoch:row.center_epoch,previousGeneration:row.previous_generation,previousAnchorHash:row.previous_anchor_hash,
    sessionNonce:row.session_nonce,proposedAt:row.proposed_at,proposalExpiresAt:row.proposal_expires_at,
    candidateWallAt:row.candidate_wall_at,acceptNotBefore:row.accept_not_before,acceptNotAfter:row.accept_not_after,
    globalFloorObservedAt:row.global_floor_observed_at,maxForwardJumpMs:row.max_forward_jump_ms};
  const evidence={...proposal,generation:row.generation,proposalHash:row.proposal_hash,acceptedWallAt:row.accepted_wall_at,
    globalFloorAtApproval:row.global_floor_at_approval,approvalRef:row.approval_ref,executorId:row.executor_id,approverId:row.approver_id};
  return {proposal,evidence};
}
function canonicalHashControl(kind,value) {
  const expected=recordHash(kind,value); // Test-owned explicit field order and SHA-256 domain oracle.
  assert.match(expected,/^[0-9a-f]{64}$/);
  assert.ok(encodeMaintenanceV5Record(kind,value).length>0,'reviewed codec accepts canonical shape');
  assert.equal(hashMaintenanceV5Record(kind,value),expected);
  return expected;
}
function bypassChecks(db,sql,values=[]) {
  db.exec('PRAGMA ignore_check_constraints=ON');
  try {assert.ok(db.prepare(sql).run(...values).changes>0);} finally {db.exec('PRAGMA ignore_check_constraints=OFF');}
}
function rejectedUnchanged(db) {
  const before=snapshot(db);
  assert.throws(() => v5.assertImSchemaV5(db),mismatch);
  assert.throws(() => dispatch.assertSupportedImV2Center(db),mismatch);
  assert.deepEqual(snapshot(db),before);
}

test('B0.1 exact API, independent literal 58-object manifest and full-byte additive DDL',t => {
  assert.deepEqual(Object.keys(v5).sort(),['IM_V5_SCHEMA_VERSION','assertImSchemaV5'].sort());
  assert.deepEqual(Object.keys(dispatch),['assertSupportedImV2Center']);
  assert.deepEqual(Object.keys(v4).sort(),['IM_V2_SCHEMA_VERSION','SUPPORTED_IM_V2_SCHEMA_VERSIONS','assertImSchemaV4'].sort());
  assert.equal(v5.IM_V5_SCHEMA_VERSION,5);
  assert.equal(GOLDEN.checksum,'80eba5e6ce61261d31ec495216c3b6eb8c7a8f0c87edcbb1440372353f495435');
  assert.equal(GOLDEN.addedDdlHash,'a3e6b496ffcdc1d5863bacf56af261ec53c2892de44199b796f71a6abdf4a552');
  assert.equal(V5_CHECKSUM,GOLDEN.checksum);
  assert.equal(sha([V5_SCHEMA,...V5_TABLES,...V5_INDEXES].join('\n')),GOLDEN.addedDdlHash);
  assert.equal(sha(V5_DDL.join('\n')),'ba794191aac30e3cfeca1a14fbbd4e0ae8b48fd076c735310fe6b313517b6606','full ordered DDL bytes, inherited bytes independently pinned by P1 goldens');
  assert.deepEqual([V5_SCHEMA,...V5_TABLES,...V5_INDEXES],DDL);
  assert.deepEqual(V5_MANIFEST,MANIFEST);
  assert.equal(V5_MANIFEST.length,58);
  assert.deepEqual(V5_DDL.slice(1,54),V4_DDL.slice(1));
  const old=JSON.parse(readFileSync(new URL('./fixtures/im-v2-schema/v4-manifest.json',import.meta.url)));
  assert.equal(old.length,54);assert.equal(sha(JSON.stringify(old)),V4);
  const {db}=fixture(t);
  assert.deepEqual(manifest(db),MANIFEST);
  assert.equal(v5.assertImSchemaV5(db),undefined);
  assert.throws(() => v4.assertImSchemaV4(db),mismatch);
  const result=dispatch.assertSupportedImV2Center(db);
  assert.deepEqual(result,{schemaVersion:5,schemaChecksum:GOLDEN.checksum});
  assert.ok(Object.isFrozen(result));
  const legacy=database(t);initializeImSchemaV4(legacy,freshOptions());
  assert.equal(v4.assertImSchemaV4(legacy),true);
  assert.deepEqual(dispatch.assertSupportedImV2Center(legacy),{schemaVersion:4,schemaChecksum:V4});
  assert.throws(() => v5.assertImSchemaV5(legacy),mismatch);
});

test('B0.1 exact column order, nullability, composite target, unique keys, self FK and no new-workflow recovery FK',t => {
  const {db}=fixture(t);
  const columns={
    im_maintenance_time_anchors:'generation center_epoch previous_generation previous_anchor_hash proposal_hash anchor_hash session_nonce proposed_at proposal_expires_at candidate_wall_at accept_not_before accept_not_after accepted_wall_at global_floor_observed_at global_floor_at_approval max_forward_jump_ms approval_ref executor_id approver_id',
    im_maintenance_time_head:'singleton center_epoch generation anchor_hash',
    im_center_schema_transitions:'transition_id from_version to_version instance_id instance_created_at center_epoch from_checksum to_checksum recovery_run_id stage_hash candidate_reference candidate_kind preparation_ref source_evidence_hash preconversion_file_hash execution_policy_hash plan_created_at plan_expires_at approver_id approved_plan_hash approval_ref executor_id converted_at',
  };
  for (const [name,fields] of Object.entries(columns)) {
    const info=db.prepare(`PRAGMA table_info(${name})`).all();
    assert.deepEqual(info.map(row => row.name),fields.split(' '));
    const nullable=name==='im_maintenance_time_anchors'?['previous_generation','previous_anchor_hash']:name==='im_center_schema_transitions'?['preparation_ref','source_evidence_hash']:[];
    assert.deepEqual(info.filter(row => !row.notnull).map(row => row.name),nullable);
  }
  const refs=db.prepare('PRAGMA foreign_key_list(im_center_schema_transitions)').all();
  assert.deepEqual(refs.map(row => row.from).sort(),['center_epoch','execution_policy_hash','preparation_ref']);
  const self=db.prepare('PRAGMA foreign_key_list(im_maintenance_time_anchors)').all();
  assert.ok(self.some(row => row.from==='previous_generation' && row.table==='im_maintenance_time_anchors' && row.to==='generation'));
  const triple=db.prepare('PRAGMA foreign_key_list(im_maintenance_time_head)').all().filter(row => row.table==='im_maintenance_time_anchors');
  assert.deepEqual(triple.map(row => row.from),['center_epoch','generation','anchor_hash']);
  assert.deepEqual(triple.map(row => row.to),['center_epoch','generation','anchor_hash']);
  assert.deepEqual(db.prepare('PRAGMA index_info(im_maintenance_time_epoch)').all().map(row => row.name),['center_epoch','generation']);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('B0.1 marker-only, missing/mixed/extra schema and unknown version rejected',async t => {
  for (const [name,mutate] of [
    ['missing new index',db => db.exec('DROP INDEX im_maintenance_time_epoch')],
    ['wrong index',db => db.exec('DROP INDEX im_maintenance_time_epoch; CREATE INDEX im_maintenance_time_epoch ON im_maintenance_time_anchors(generation,center_epoch)')],
    ['extra view',db => db.exec('CREATE VIEW im_extra AS SELECT 1')],
    ['nonprefixed trigger',db => db.exec('CREATE TRIGGER extra AFTER INSERT ON im_maintenance_time_anchors BEGIN SELECT 1; END')],
    ['extra table',db => db.exec('CREATE TABLE im_extra(x)')],
    ['temporary shadow',db => db.exec('CREATE TEMP TABLE im_maintenance_time_anchors(x)')],
    ['checksum',db => db.prepare('UPDATE im_schema SET migration_checksum=?').run(V4)],
    ['v4 marker',db => bypassChecks(db,'UPDATE im_schema SET version=4')],
    ['unknown marker',db => bypassChecks(db,'UPDATE im_schema SET version=6')],
    ['no transition',db => db.exec('DELETE FROM im_center_schema_transitions')],
    ['FK disabled',db => db.exec('PRAGMA foreign_keys=OFF')],
  ]) await t.test(name,t => {const {db}=fixture(t);mutate(db);rejectedUnchanged(db);});
  await t.test('only marker replaced on lawful v4',t => {
    const db=database(t);initializeImSchemaV4(db,freshOptions());
    db.exec('DROP TABLE im_schema');db.exec(DDL[0]);insert(db,'im_schema',{version:5,migration_checksum:GOLDEN.checksum});
    rejectedUnchanged(db);
  });
});

test('B0.1 lawful fresh/import/snapshot typed transitions, retained business and zero writes',async t => {
  for (const kind of ['fresh_bootstrap','v3_import','snapshot_recovery']) await t.test(kind,t => {
    const {db}=fixture(t,{kind});
    const before=snapshot(db),changes=db.prepare('SELECT total_changes() AS n').get().n;
    const calls=[];
    const target=observe(db,call => calls.push(call));
    assert.equal(v5.assertImSchemaV5(target),undefined);
    assert.equal(dispatch.assertSupportedImV2Center(target).schemaVersion,5);
    assert.deepEqual(snapshot(db),before);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n,changes);
    assert.equal(calls.filter(call => call.method==='run' || call.method==='exec').length,0);
    assert.equal(db.isTransaction,false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM im_maintenance_time_anchors').get().n,0);
  });
});

test('B0.1 inherited corruption still rejects in v5 after narrow extraction',async t => {
  for (const [name,mutate] of [
    ['fingerprint',db => db.exec("UPDATE im_send_keys SET payload_hash='"+'0'.repeat(64)+"'")],
    ['operation mapping',db => db.exec('DELETE FROM im_send_operation_keys')],
    ['payload bytes',db => db.exec("UPDATE im_attachments SET data=zeroblob(size)")],
    ['content deadline',db => db.exec('UPDATE im_content_state SET expires_at=expires_at+1')],
    ['epoch counter',db => db.exec('UPDATE im_center_state SET recovery_counter=1')],
    ['credential crossbinding',db => db.exec('UPDATE im_receiver_leases SET credential_id=(SELECT credential_id FROM im_credentials WHERE agent_id<>im_receiver_leases.agent_id LIMIT 1)')],
    ['policy shape',db => putPolicy(db,{...policy(),effectiveAt:1,purgeEnabled:'false'})],
    ['preparation hash',db => db.prepare('UPDATE im_schema_preparations SET input_hash=?').run('f'.repeat(64))],
    ['FK row',db => {db.exec('PRAGMA foreign_keys=OFF');db.prepare('UPDATE im_content_state SET policy_hash=?').run('f'.repeat(64));db.exec('PRAGMA foreign_keys=ON');}],
  ]) await t.test(name,t => {const {db}=fixture(t,{business:true});assert.equal(v5.assertImSchemaV5(db),undefined);mutate(db);rejectedUnchanged(db);});
});

test('B0.1 anchor chain is database-wide, head optional/current/tip, conversion epoch retained',t => {
  const {db}=fixture(t);
  assert.equal(v5.assertImSchemaV5(db),undefined);
  const first=anchor(db);assert.equal(v5.assertImSchemaV5(db),undefined);
  head(db,first);assert.equal(v5.assertImSchemaV5(db),undefined);
  const epoch=recover(db);
  assert.throws(() => v5.assertImSchemaV5(db),mismatch,'stale head is not auto-repaired');
  db.exec('DELETE FROM im_maintenance_time_head');
  assert.equal(v5.assertImSchemaV5(db),undefined,'retained history with no head');
  const second=anchor(db);assert.equal(second.center_epoch,epoch);assert.equal(second.generation,2);
  assert.equal(second.previous_anchor_hash,first.anchor_hash);
  head(db,second);assert.equal(v5.assertImSchemaV5(db),undefined);
  const sql=[];v5.assertImSchemaV5(observe(db,call => sql.push(call.sql)));
  assert.equal(sql.filter(value => /FROM im_maintenance_time_anchors WHERE/.test(value)).length,0,'no per-row predecessor query');
});

test('B0.1 actual inserted chain/hash/identity/head corruption rejects, not fixture CHECK failure',async t => {
  const cases=[
    ['first generation gap',db => anchor(db,{generation:2})],
    ['successor gap',db => {anchor(db);anchor(db,{generation:3});}],
    ['wrong previous hash',db => {anchor(db);anchor(db,{previousAnchorHash:'f'.repeat(64)});}],
    ['backward cross-epoch wall',db => {anchor(db);recover(db);anchor(db,{proposedAt:900,candidateWallAt:900,acceptNotBefore:900,acceptNotAfter:5900,proposalExpiresAt:300900,acceptedWallAt:900,globalFloorObservedAt:800,globalFloorAtApproval:850});}],
    ['observed floor hashes original proposal',db => {anchor(db);db.exec('UPDATE im_maintenance_time_anchors SET global_floor_observed_at=global_floor_observed_at-1');}],
    ['proposal hash',db => {anchor(db);db.prepare('UPDATE im_maintenance_time_anchors SET proposal_hash=?').run('e'.repeat(64));}],
    ['anchor hash',db => {anchor(db);db.prepare('UPDATE im_maintenance_time_anchors SET anchor_hash=?').run('e'.repeat(64));}],
    ['identity',db => {anchor(db);db.prepare('UPDATE im_instance_identity SET instance_id=?').run(randomUUID());}],
    ['non-tip head',db => {const first=anchor(db);anchor(db);head(db,first);}],
    ['safe-max generation is no first generation',db => anchor(db,{generation:Number.MAX_SAFE_INTEGER})],
    ['same actors through bypassed SQL constraint',db => {anchor(db);bypassChecks(db,'UPDATE im_maintenance_time_anchors SET approver_id=executor_id');}],
    ['control ref',db => {anchor(db);db.prepare('UPDATE im_maintenance_time_anchors SET approval_ref=?').run('bad\u0001ref');}],
    ['overlong TTL through bypass',db => {anchor(db);bypassChecks(db,'UPDATE im_maintenance_time_anchors SET proposal_expires_at=proposed_at+300001');}],
    ['empty window through bypass',db => {anchor(db);bypassChecks(db,'UPDATE im_maintenance_time_anchors SET accept_not_after=accept_not_before');}],
  ];
  for (const [name,mutate] of cases) await t.test(name,t => {
    const {db}=fixture(t);mutate(db);
    assert.ok(db.prepare('SELECT count(*) AS n FROM im_maintenance_time_anchors').get().n>0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    rejectedUnchanged(db);
  });
});

test('B0.1 stored unsafe integer cannot escape as native conversion exception',t => {
  const {db}=fixture(t);anchor(db);
  bypassChecks(db,'UPDATE im_maintenance_time_anchors SET generation=9007199254740992');
  assert.equal(db.prepare('SELECT CAST(generation AS TEXT) AS value FROM im_maintenance_time_anchors').get().value,'9007199254740992');
  assert.throws(() => v5.assertImSchemaV5(db),mismatch);
});

test('B0.1 coherent cross-instance proposal and anchor hashes reject with legitimate identity and conversion untouched',t => {
    const {db,identity}=fixture(t);
    validPublicControl(db);
    const row=anchor(db);
    validPublicControl(db);
    const before=snapshot(db);
    const foreignIdentity={...identity,instance_id:randomUUID()};
    assert.notEqual(foreignIdentity.instance_id,identity.instance_id);
    const actual=anchorRecords(row,identity),foreign=anchorRecords(row,foreignIdentity);
    assert.equal(canonicalHashControl('timeProposal',actual.proposal),row.proposal_hash);
    assert.equal(canonicalHashControl('anchorEvidence',actual.evidence),row.anchor_hash);
    const proposalHash=canonicalHashControl('timeProposal',foreign.proposal);
    const evidence={...foreign.evidence,proposalHash};
    const anchorHash=canonicalHashControl('anchorEvidence',evidence);
    assert.notEqual(anchorHash,row.anchor_hash);
    assert.notEqual(proposalHash,row.proposal_hash);
    assert.equal(db.prepare('UPDATE im_maintenance_time_anchors SET proposal_hash=?,anchor_hash=? WHERE generation=?')
      .run(proposalHash,anchorHash,row.generation).changes,1,'setup succeeds before observing validation');
    assert.deepEqual(db.prepare('SELECT * FROM im_maintenance_time_anchors').get(),
      Object.assign(Object.create(null),row,{proposal_hash:proposalHash,anchor_hash:anchorHash}));
    const after=snapshot(db);
    for (const [name,rows] of Object.entries(before.rows)) if (name!=='im_maintenance_time_anchors')
      assert.deepEqual(after.rows[name],rows,`${name} remains the valid baseline, including identity/transition/policy/epoch`);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    for (const validator of publicValidators) {
      const calls=[];
      assert.throws(() => validator(observe(db,call => calls.push(call))),fixedError('IM_SCHEMA_MISMATCH'));
      assert.ok(calls.some(call => /SELECT \* FROM im_maintenance_time_anchors/.test(call.sql) &&
        (Array.isArray(call.result)?call.result:[call.result]).some(value => value?.anchor_hash===anchorHash)),
      'real native anchor retrieval reached; an earlier transition mismatch cannot stand in for this case');
    }
    assert.deepEqual(snapshot(db),after);
    assert.equal(db.prepare('UPDATE im_maintenance_time_anchors SET proposal_hash=?,anchor_hash=? WHERE generation=?')
      .run(row.proposal_hash,row.anchor_hash,row.generation).changes,1);
    validPublicControl(db);
});

test('B0.1 inclusive acceptance edge and strict expiry are independently exercised',t => {
  const {db}=fixture(t);
  anchor(db,{acceptedWallAt:6000});
  assert.equal(v5.assertImSchemaV5(db),undefined,'accepted exactly at inclusive window end');
  assert.throws(() => anchor(db,{proposalExpiresAt:11010,acceptedWallAt:11010}),checkFailure,'DDL refuses expiry equality even at window end');
  assert.equal(db.prepare('SELECT count(*) AS n FROM im_maintenance_time_anchors').get().n,1);
});

test('B0.1 native DDL rejects unsafe type/range/null/duplicate/TTL/window/actor facts',async t => {
  for (const [name,sql,params=[]] of [
    ['negative','UPDATE im_maintenance_time_anchors SET proposed_at=-1'],
    ['fraction','UPDATE im_maintenance_time_anchors SET max_forward_jump_ms=1.5'],
    ['overflow','UPDATE im_maintenance_time_anchors SET generation=9007199254740992'],
    ['UUID','UPDATE im_maintenance_time_anchors SET session_nonce=?',['-'.repeat(36)]],
    ['hash','UPDATE im_maintenance_time_anchors SET anchor_hash=?',['G'.repeat(64)]],
    ['unpaired predecessor','UPDATE im_maintenance_time_anchors SET previous_anchor_hash=?',['a'.repeat(64)]],
    ['zero TTL','UPDATE im_maintenance_time_anchors SET proposal_expires_at=proposed_at'],
    ['excess TTL','UPDATE im_maintenance_time_anchors SET proposal_expires_at=proposed_at+300001'],
    ['zero window','UPDATE im_maintenance_time_anchors SET accept_not_after=accept_not_before'],
    ['excess window','UPDATE im_maintenance_time_anchors SET accept_not_after=accept_not_before+5001'],
    ['expiry strict','UPDATE im_maintenance_time_anchors SET proposal_expires_at=accepted_wall_at'],
    ['floor order','UPDATE im_maintenance_time_anchors SET global_floor_at_approval=global_floor_observed_at-1'],
    ['accepted floor','UPDATE im_maintenance_time_anchors SET global_floor_at_approval=accepted_wall_at+1'],
    ['actors','UPDATE im_maintenance_time_anchors SET approver_id=executor_id'],
  ]) await t.test(name,t => {const {db}=fixture(t);anchor(db);assert.throws(() => db.prepare(sql).run(...params),checkFailure);assert.equal(v5.assertImSchemaV5(db),undefined);});
  await t.test('duplicate generation/nonce/proposal/anchor unique keys',t => {
    const {db}=fixture(t),first=anchor(db),second=anchor(db);
    for (const field of ['generation','session_nonce','proposal_hash','anchor_hash'])
      assert.throws(() => db.prepare(`UPDATE im_maintenance_time_anchors SET ${field}=? WHERE generation=?`).run(first[field],second.generation),error => error.code==='ERR_SQLITE_ERROR');
  });
});

test('B0.1 typed transition tamper and disconnected historical epoch reject',async t => {
  for (const [name,mutate] of [
    ['instance',db => {db.prepare('UPDATE im_center_schema_transitions SET instance_id=?').run(randomUUID());rehashTransition(db);}],
    ['birth',db => {db.exec('UPDATE im_center_schema_transitions SET instance_created_at=instance_created_at+1');rehashTransition(db);}],
    ['from checksum',db => {db.prepare('UPDATE im_center_schema_transitions SET from_checksum=?').run('f'.repeat(64));rehashTransition(db);}],
    ['to checksum',db => {db.prepare('UPDATE im_center_schema_transitions SET to_checksum=?').run('f'.repeat(64));rehashTransition(db);}],
    ['plan hash',db => db.prepare('UPDATE im_center_schema_transitions SET approved_plan_hash=?').run('f'.repeat(64))],
    ['candidate ref',db => bypassChecks(db,"UPDATE im_center_schema_transitions SET candidate_reference='runs/wrong/candidate.sqlite'")],
    ['actors',db => bypassChecks(db,'UPDATE im_center_schema_transitions SET approver_id=executor_id')],
    ['converted expiry',db => bypassChecks(db,'UPDATE im_center_schema_transitions SET converted_at=plan_expires_at')],
    ['kind/preparation',db => {db.exec("UPDATE im_center_schema_transitions SET candidate_kind='v3_import',source_evidence_hash='"+'b'.repeat(64)+"'");rehashTransition(db);}],
    ['disconnected snapshot epoch',db => {
      const epoch=randomUUID();insert(db,'im_center_epochs',{center_epoch:epoch,created_at:100,origin:'recovery',recovery_counter:1});
      db.prepare("UPDATE im_center_schema_transitions SET candidate_kind='snapshot_recovery',preparation_ref=NULL,source_evidence_hash=?,center_epoch=?").run('b'.repeat(64),epoch);rehashTransition(db);
    }],
    ['two transitions',db => {
      const row=db.prepare('SELECT * FROM im_center_schema_transitions').get();
      insert(db,'im_center_schema_transitions',{...row,transition_id:randomUUID(),approved_plan_hash:'f'.repeat(64)});
    }],
  ]) await t.test(name,t => {const {db}=fixture(t);mutate(db);assert.ok(db.prepare('SELECT count(*) AS n FROM im_center_schema_transitions').get().n>0);rejectedUnchanged(db);});
});

test('B0.1 transition DDL precisely enforces kind NULL rules and strict TTL/actors',async t => {
  for (const [kind,sql] of [
    ['fresh_bootstrap','UPDATE im_center_schema_transitions SET preparation_ref=NULL'],
    ['fresh_bootstrap',"UPDATE im_center_schema_transitions SET source_evidence_hash='"+'a'.repeat(64)+"'"],
    ['v3_import','UPDATE im_center_schema_transitions SET source_evidence_hash=NULL'],
    ['v3_import','UPDATE im_center_schema_transitions SET preparation_ref=NULL'],
    ['snapshot_recovery','UPDATE im_center_schema_transitions SET source_evidence_hash=NULL'],
    ['snapshot_recovery',"UPDATE im_center_schema_transitions SET preparation_ref='fresh-fixture'"],
    ['fresh_bootstrap','UPDATE im_center_schema_transitions SET plan_expires_at=plan_created_at'],
    ['fresh_bootstrap','UPDATE im_center_schema_transitions SET plan_expires_at=plan_created_at+300001'],
    ['fresh_bootstrap','UPDATE im_center_schema_transitions SET converted_at=plan_expires_at'],
    ['fresh_bootstrap','UPDATE im_center_schema_transitions SET approver_id=executor_id'],
  ]) await t.test(`${kind}: ${sql}`,t => {
    const {db}=fixture(t,{kind});assert.throws(() => db.exec(sql),checkFailure);
    assert.equal(v5.assertImSchemaV5(db),undefined);
  });
});

test('B0.1 correctly rehashed transition to an unregistered policy is rejected (FK-equivalent storage gate)',t => {
  const {db}=fixture(t,{kind:'snapshot_recovery'});
  validPublicControl(db);
  const before=snapshot(db),original=db.prepare('SELECT * FROM im_center_schema_transitions').get();
  const absent=sha('B0.1 unregistered transition execution policy');
  assert.match(absent,/^[0-9a-f]{64}$/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM im_retention_policies WHERE policy_hash=?').get(absent).n,0);
  const plan=transitionPlan(db,{executionPolicyHash:absent});
  const planHash=canonicalHashControl('conversionPlan',plan);
  assert.notEqual(planHash,original.approved_plan_hash);
  assert.equal(db.isTransaction,false);
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    assert.equal(db.prepare('UPDATE im_center_schema_transitions SET execution_policy_hash=?,approved_plan_hash=? WHERE transition_id=?')
      .run(absent,planHash,original.transition_id).changes,1);
  } finally {db.exec('PRAGMA foreign_keys=ON');}
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  const mutated=db.prepare('SELECT * FROM im_center_schema_transitions').get();
  assert.deepEqual({...mutated},{...original,execution_policy_hash:absent,approved_plan_hash:planHash},'only policy and its approved plan hash changed');
  assert.equal(canonicalHashControl('conversionPlan',transitionPlan(db)),mutated.approved_plan_hash);
  assert.equal(db.prepare('SELECT count(*) AS n FROM im_retention_policies WHERE policy_hash=?').get(mutated.execution_policy_hash).n,0);
  const violations=db.prepare('PRAGMA foreign_key_check').all();
  assert.equal(violations.length,1);
  assert.equal(violations[0].table,'im_center_schema_transitions');
  assert.equal(violations[0].parent,'im_retention_policies');
  const after=snapshot(db);
  for (const [name,rows] of Object.entries(before.rows)) if (name!=='im_center_schema_transitions') assert.deepEqual(after.rows[name],rows,name);
  for (const validator of publicValidators) {
    const calls=[];
    assert.throws(() => validator(observe(db,call => calls.push(call))),fixedError('IM_SCHEMA_MISMATCH'));
    assert.ok(calls.some(call => /pragma_foreign_key_check|PRAGMA foreign_key_check/i.test(call.sql)),
      'full validation observes native FK evidence; this does not claim the later semantic transition branch ran');
    assert.equal(calls.filter(call => call.method==='run' || call.method==='exec').length,0);
  }
  assert.deepEqual(snapshot(db),after);
  assert.equal(db.prepare('UPDATE im_center_schema_transitions SET execution_policy_hash=?,approved_plan_hash=? WHERE transition_id=?')
    .run(original.execution_policy_hash,original.approved_plan_hash,original.transition_id).changes,1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  validPublicControl(db);
});

test('B0.1 native observers prove capped counts and length-first reservations before variable fetch',t => {
  const {db}=fixture(t,{business:true});anchor(db);anchor(db);
  const calls=[];
  const target=observe(db,call => calls.push(call));
  assert.throws(() => assertImSchemaV5Internal(target,budget({maxMaintenanceAnchors:1})),exhausted);
  assert.ok(calls.some(call => /count\(\*\).*im_maintenance_time_anchors LIMIT \?/.test(call.sql)));
  assert.equal(calls.filter(call => /SELECT \* FROM im_maintenance_time_anchors/.test(call.sql)).length,0);
  calls.length=0;
  assert.throws(() => assertImSchemaV5Internal(target,budget({maxMaintenanceMetadataBytes:1})),exhausted);
  assert.ok(calls.some(call => /length\(CAST\(type AS BLOB\)\)/.test(call.sql)));
  assert.equal(calls.filter(call => /SELECT type,name,tbl_name,sql/.test(call.sql)).length,0);
  calls.length=0;
  assert.throws(() => assertImSchemaV5Internal(target,budget({maxVerifiedContentBytes:1})),exhausted);
  assert.equal(calls.filter(call => /a\.data/.test(call.sql)).length,0);
  assert.equal(v5.assertImSchemaV5(target),undefined);
  const anchorLength=calls.findIndex(call => /length\(CAST\(.*FROM im_maintenance_time_anchors/.test(call.sql));
  const anchorFetch=calls.findIndex(call => /SELECT \* FROM im_maintenance_time_anchors/.test(call.sql));
  assert.ok(anchorLength>=0 && anchorFetch>anchorLength);
});

test('B0.1 new refs and inherited policy metadata are length-first even when SQL CHECK is bypassed',async t => {
  for (const [table,column] of [['im_center_schema_transitions','approval_ref'],['im_retention_policies','canonical_json']]) await t.test(table,t => {
    const {db}=fixture(t);bypassChecks(db,`UPDATE ${table} SET ${column}=?`,['x'.repeat(11000000)]);
    const calls=[];assert.throws(() => v5.assertImSchemaV5(observe(db,call => calls.push(call))),exhausted);
    assert.equal(calls.filter(call => call.sql===`SELECT * FROM ${table}` || call.sql===`SELECT * FROM ${table} LIMIT 2`).length,0);
  });
});

test('B0.1 lower-only and actual late elapsed exhaustion share inherited and v5 stages',t => {
  const {db}=fixture(t);
  for (const limits of [{maxMaintenanceAnchors:10001},{maxMessages:10001},{maxElapsedMs:10001},{maxMaintenanceMetadataBytes:10485761},{maxOtherRecords:0}])
    assert.throws(() => assertImSchemaV5Internal(db,budget(limits)),mismatch);
  let observed=false;
  const target=observe(db,call => {
    if (call.sql==='SELECT * FROM im_center_schema_transitions LIMIT 2') {
      observed=true;const start=performance.now();while (performance.now()-start<80) {}
    }
  });
  assert.throws(() => assertImSchemaV5Internal(target,budget({maxElapsedMs:50})),exhausted);
  assert.equal(observed,true,'elapsed failed after native transition fetch');
  const start=performance.now();let ticks=0;
  const parent={limits:{},tick(){ticks++;if (performance.now()-start>40) throw Object.assign(new Error('private'),{code:'IM_V2_BUDGET_EXCEEDED'});}};
  const wait=performance.now();while (performance.now()-wait<50) {}
  assert.throws(() => assertImSchemaV5Internal(db,parent),exhausted);
  assert.ok(ticks>0,'parent elapsed clock was not restarted');
});

test('B0.1 malformed/native/hostile errors never leak properties or SQL',t => {
  const {db}=fixture(t);
  for (const validator of [v5.assertImSchemaV5,dispatch.assertSupportedImV2Center]) {
    for (const target of [null,{}, {prepare(){throw new Error('secret SQL row');}}, {prepare(){throw null;}}]) {
      assert.throws(() => validator(target),error => error.code==='IM_SCHEMA_MISMATCH' && error.message==='IM_SCHEMA_MISMATCH');
    }
    let accessed=false;
    const hostile=Object.defineProperty({},'code',{get(){accessed=true;throw new Error('secret getter');}});
    assert.throws(() => validator({prepare(){throw hostile;}}),mismatch);assert.equal(accessed,false);
    assert.throws(() => validator({prepare(){throw new Proxy({},{getOwnPropertyDescriptor(){throw 'private';}});}}),mismatch);
  }
  assert.equal(v5.assertImSchemaV5(db),undefined);
});

test('B0.1 public boundaries reject Proxies without reflection and sanitize inherited data-code budget classification',async t => {
  const traps=['apply','construct','defineProperty','deleteProperty','get','getOwnPropertyDescriptor','getPrototypeOf',
    'has','isExtensible','ownKeys','preventExtensions','set','setPrototypeOf'];
  for (const validator of publicValidators) for (const kind of ['fabricated budget descriptor','throwing descriptor','revoked proxy',
    'callable proxy','revoked callable proxy','throwing code getter','inherited code','inherited code getter',
    'ordinary own data budget','unknown code','native error','null','undefined','string','number','boolean','symbol','bigint'])
    await t.test(`${validator.name}: ${kind}`,t => {
      const {db}=fixture(t);validPublicControl(db);
      const counts=Object.fromEntries([...traps,'codeGetter','messageGetter','causeGetter','privateGetter'].map(name => [name,0]));
      const zero={...counts};
      const handler=Object.fromEntries(traps.map(name => [name,() => {counts[name]++;throw new Error('private trap details');}]));
      if (kind==='fabricated budget descriptor') handler.getOwnPropertyDescriptor=(_target,key) => {
        counts.getOwnPropertyDescriptor++;
        return {configurable:true,enumerable:true,writable:true,value:key==='code'?'IM_V2_BUDGET_EXCEEDED':'private fabricated details'};
      };
      let thrown;
      if (kind==='fabricated budget descriptor' || kind==='throwing descriptor') thrown=new Proxy({},handler);
      else if (kind==='revoked proxy') {const pair=Proxy.revocable({},handler);pair.revoke();thrown=pair.proxy;}
      else if (kind==='callable proxy') thrown=new Proxy(function(){},handler);
      else if (kind==='revoked callable proxy') {const pair=Proxy.revocable(function(){},handler);pair.revoke();thrown=pair.proxy;}
      else if (kind==='throwing code getter') {
        thrown={};
        for (const key of ['code','message','cause']) Object.defineProperty(thrown,key,{get(){counts[`${key}Getter`]++;throw new Error('private getter details');}});
      } else if (kind==='inherited code') thrown=Object.create({code:'IM_V2_BUDGET_EXCEEDED'});
      else if (kind==='inherited code getter') thrown=Object.create(Object.defineProperty({},'code',{
        get(){counts.codeGetter++;throw new Error('private inherited getter');},
      }));
      else if (kind==='ordinary own data budget') {
        thrown={code:'IM_V2_BUDGET_EXCEEDED',message:'private forged details',cause:'private cause',custom:'private custom value'};
        Object.defineProperty(thrown,'privateDetails',{get(){counts.privateGetter++;throw new Error('private getter');}});
      } else if (kind==='unknown code') thrown={code:'PRIVATE_UNKNOWN',message:'private SQL row'};
      else if (kind==='native error') thrown=new Error('private native SQL row');
      else thrown={null:null,undefined:undefined,string:'private SQL row',number:17,boolean:true,symbol:Symbol('private'),bigint:17n}[kind];
      // Adjudicated compatibility: historical v4 errors have no new private brand.
      // Only an ordinary own DATA budget code preserves this exact classification.
      const expected=kind==='ordinary own data budget'?'IM_V2_BUDGET_EXCEEDED':'IM_SCHEMA_MISMATCH';
      let prepares=0;
      try {
        assert.throws(() => validator({prepare(){prepares++;throw thrown;}}),error => {
          assert.notEqual(error,thrown,'boundary must create a fresh sanitized error');
          fixedError(expected)(error); // Exact code/message, no cause or custom own properties.
          assert.doesNotMatch(error.stack,/private (?:forged|cause|custom|native|SQL|getter)/);
          return true;
        });
      } finally {
        assert.equal(prepares,1,'failure originates from the first real public entry prepare call');
        assert.deepEqual(counts,zero,'no trap or getter may run during error classification');
      }
      validPublicControl(db);
    });
});

test('B0.1 genuine inherited content budget survives sanitization through internal lower-only composition',t => {
  const {db}=fixture(t,{business:true});validPublicControl(db);
  assert.ok(db.prepare('SELECT sum(size) AS bytes FROM im_attachments').get().bytes>1);
  const before=snapshot(db),calls=[];
  assert.throws(() => assertImSchemaV5Internal(observe(db,call => calls.push(call)),budget({maxVerifiedContentBytes:1})),
    fixedError('IM_V2_BUDGET_EXCEEDED'));
  assert.ok(calls.some(call => /im_attachments/.test(call.sql)),'real inherited rows entered the bounded validator');
  assert.equal(calls.filter(call => /a\.data/.test(call.sql)).length,0,'content is not fetched after its budget fails');
  assert.deepEqual(snapshot(db),before);
  validPublicControl(db);
});

test('B0.1 genuine new maintenance-row metadata budget survives both public sanitizers',t => {
  const {db}=fixture(t);validPublicControl(db);
  const original=db.prepare('SELECT approval_ref FROM im_center_schema_transitions').get().approval_ref;
  bypassChecks(db,'UPDATE im_center_schema_transitions SET approval_ref=?',['x'.repeat(10485761)]);
  assert.equal(db.prepare('SELECT length(CAST(approval_ref AS BLOB)) AS bytes FROM im_center_schema_transitions').get().bytes,10485761);
  assert.equal(db.prepare('PRAGMA ignore_check_constraints').get().ignore_check_constraints,0);
  const changes=db.prepare('SELECT total_changes() AS n').get().n;
  for (const validator of publicValidators) {
    const calls=[];
    assert.throws(() => validator(observe(db,call => calls.push(call))),fixedError('IM_V2_BUDGET_EXCEEDED'));
    assert.ok(calls.some(call => /length\(CAST\(.*FROM im_center_schema_transitions/.test(call.sql)),
      'length projection of the actual stored maintenance row exhausted the budget');
    assert.equal(calls.filter(call => /SELECT \* FROM im_center_schema_transitions/.test(call.sql)).length,0);
  }
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n,changes);
  assert.equal(db.prepare('UPDATE im_center_schema_transitions SET approval_ref=?').run(original).changes,1);
  validPublicControl(db);
});
