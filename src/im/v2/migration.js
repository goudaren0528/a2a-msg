import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { withImmediateTransaction } from '../transaction.js';
import { V3_CHECKSUM, assertFrozenV3Structure, fingerprintFrozenV1 } from './schema-history.js';
import { assertImSchemaV4Internal, V4_DDL, V4_SCHEMA, V4_TABLES, V4_INDEXES, V4_CHECKSUM, projectCandidateBudget } from './schema-internal.js';

const fail = (code='IM_SCHEMA_MISMATCH') => { throw Object.assign(new Error('IM v4 candidate rejected'),{code,blockers:Object.freeze([{code,count:1}])}); };
const sha = value => createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const safe = x => typeof x==='string' && x.length>=1 && x.length<=255 && !/[\x00-\x1f\x7f]/.test(x);
const exact = (x,keys) => x && typeof x==='object' && !Array.isArray(x) && Object.getPrototypeOf(x)===Object.prototype && Object.keys(x).length===keys.length && Object.keys(x).every(k=>keys.includes(k)) && Object.getOwnPropertySymbols(x).length===0;
const POLICY = ['version','effectiveAt','messageRetentionMs','attachmentRetentionMs','safeRetryWindowMs','auditRetentionMs','keyReservation','expiryEnabled','purgeEnabled','backupCleanupEnabled','backupRetentionMs'];
const DEFAULTS = Object.freeze({maxMessages:10000,maxVerifiedContentBytes:104857600,maxOtherRecords:10000,maxElapsedMs:10000});
function inputs(options,kind) {
  const keys=kind==='fresh'?['policy','creationRef','limits']:['expectedVersion','policy','migrationRef','limits'];
  if (!options || typeof options!=='object' || Array.isArray(options) || Object.getPrototypeOf(options)!==Object.prototype || Object.keys(options).some(k=>!keys.includes(k)) || Object.getOwnPropertySymbols(options).length || (kind!=='fresh' && options.expectedVersion!==3)) fail('IM_V2_INPUT_INVALID');
  const ref=options[kind==='fresh'?'creationRef':'migrationRef'];
  if (!safe(ref) || !exact(options.policy,POLICY)) fail('IM_V2_INPUT_INVALID');
  const p=options.policy;
  if (p.version!==2 || !Number.isSafeInteger(p.effectiveAt) || p.effectiveAt<0 || p.keyReservation!=='indefinite' || !['expiryEnabled','purgeEnabled','backupCleanupEnabled'].every(k=>p[k]===false) || p.backupRetentionMs!==null || p.messageRetentionMs!==7776000000 || p.attachmentRetentionMs!==7776000000 || p.safeRetryWindowMs!==604800000 || p.auditRetentionMs!==15552000000) fail('IM_V2_INPUT_INVALID');
  const policy=Object.fromEntries(POLICY.map(k=>[k,p[k]]));
  const limits={...DEFAULTS};
  if (options.limits!==undefined) {
    if (!options.limits || typeof options.limits!=='object' || Array.isArray(options.limits) || Object.getPrototypeOf(options.limits)!==Object.prototype || Object.keys(options.limits).some(k=>!Object.hasOwn(DEFAULTS,k)) || Object.getOwnPropertySymbols(options.limits).length) fail('IM_V2_INPUT_INVALID');
    for (const [k,v] of Object.entries(options.limits)) {if (!Number.isSafeInteger(v) || v<1 || v>DEFAULTS[k]) fail('IM_V2_INPUT_INVALID'); limits[k]=v;}
  }
  return {ref,policy,limits,policyHash:sha(JSON.stringify(policy))};
}
const makeBudget = limits => ({limits,start:performance.now(),tick(){if(performance.now()-this.start>this.limits.maxElapsedMs) fail('IM_V2_BUDGET_EXCEEDED');}});
function result(db,ref,kind,inputHash,policyHash,budget) {
  assertImSchemaV4Internal(db,budget);
  const preparation=db.prepare('SELECT * FROM im_schema_preparations WHERE preparation_ref=?').get(ref);
  if (!preparation || preparation.kind!==kind || preparation.input_hash!==inputHash || preparation.policy_hash!==policyHash) fail('IM_V2_PREPARATION_CONFLICT');
  const identity=db.prepare('SELECT instance_id,created_at FROM im_instance_identity WHERE singleton=1').get();
  const center=db.prepare('SELECT center_epoch,status FROM im_center_state WHERE singleton=1').get();
  const settings=db.prepare('SELECT write_mode FROM im_settings WHERE singleton=1').get();
  if (center.center_epoch!==preparation.initial_epoch || (kind==='v3_import' && (!preparation.import_epoch || preparation.source_version!==3 || preparation.source_schema_checksum!==V3_CHECKSUM))) fail();
  budget.tick();
  return {preparationRef:ref,instanceId:identity.instance_id,instanceCreatedAt:identity.created_at,initialEpoch:preparation.initial_epoch,importEpoch:preparation.import_epoch,schemaVersion:4,status:center.status,writeMode:settings.write_mode};
}
function insertBase(db,kind,ref,policy,policyHash,inputHash,now,initial,importEpoch) {
  db.prepare('INSERT INTO im_retention_policies VALUES (?,?,?,?,?,?,?,?)').run(policyHash,2,policy.effectiveAt,policy.messageRetentionMs,policy.attachmentRetentionMs,policy.safeRetryWindowMs,policy.auditRetentionMs,JSON.stringify(policy));
  const epoch=db.prepare('INSERT INTO im_center_epochs VALUES (?,?,?,0)');
  if (importEpoch) epoch.run(importEpoch,now,'v3_import');
  epoch.run(initial,now,kind==='fresh'?'fresh':'v3_import');
  db.prepare('INSERT INTO im_schema_preparations VALUES (?,?,?,?,?,?,?,?,?)').run(ref,kind,inputHash,kind==='fresh'?null:3,kind==='fresh'?null:V3_CHECKSUM,importEpoch,initial,policyHash,now);
  db.prepare("INSERT INTO im_center_state(singleton,center_epoch,recovery_counter,status,activation_ref,recovery_run_id,updated_at) VALUES (1,?,0,'prepared',NULL,NULL,?)").run(initial,now);
}
function validateWire(db,budget) {
  const checks=[['im_agents',['agent_id']],['im_credentials',['credential_id','agent_id']],['im_contacts',['agent_low','agent_high']],['im_conversations',['conversation_id','agent_low','agent_high']],['im_messages',['message_id','conversation_id','sender_id','recipient_id','client_message_id','in_reply_to']],['im_attachments',['attachment_id','message_id']],['im_send_keys',['sender_id','client_message_id','message_id']],['im_receive_state',['agent_id','stream_epoch']],['im_receiver_leases',['agent_id','instance_id','credential_id']],['im_lease_requests',['agent_id','request_id','instance_id']],['im_deliveries',['recipient_id','message_id']],['im_legacy_bindings',['agent_id']]];
  for (const [table,fields] of checks) for (const row of db.prepare(`SELECT ${fields.join(',')} FROM ${table}`).iterate()) {
    for (const field of fields) if (row[field]===null ? field!=='in_reply_to' : typeof row[field]!=='string' || !UUID.test(row[field])) fail('IM_V2_WIRE_INVALID');
    budget.tick();
  }
  for (const row of db.prepare('SELECT next_seq,acked_through,retained_floor FROM im_receive_state').iterate()) {if (![row.next_seq,row.acked_through,row.retained_floor].every(x=>Number.isSafeInteger(x)&&x>=0)) fail('IM_V2_WIRE_INVALID');budget.tick();}
  for (const row of db.prepare('SELECT seq,acked_at,read_at FROM im_deliveries').iterate()) {if (![row.seq,row.acked_at,row.read_at].every(x=>x===null||Number.isSafeInteger(x)&&x>=0)) fail('IM_V2_WIRE_INVALID');budget.tick();}
  for (const row of db.prepare('SELECT sender_id,client_message_id,message_id,created_at,retry_until FROM im_send_keys').iterate()) {if (!Number.isSafeInteger(row.created_at)||row.created_at<0||!Number.isSafeInteger(row.retry_until)||row.retry_until<row.created_at) fail('IM_V2_WIRE_INVALID');budget.tick();}
  for (const row of db.prepare('SELECT agent_id,generation,expires_at FROM im_receiver_leases').iterate()) {if (!Number.isSafeInteger(row.generation)||row.generation<1||!Number.isSafeInteger(row.expires_at)||row.expires_at<0) fail('IM_V2_WIRE_INVALID');budget.tick();}
  for (const row of db.prepare('SELECT l.agent_id,l.credential_id,c.agent_id AS credential_agent FROM im_receiver_leases l LEFT JOIN im_credentials c ON c.credential_id=l.credential_id').iterate()) {if (row.agent_id!==row.credential_agent) fail('IM_V2_LEASE_INVALID');budget.tick();}
  const requestCredentials=db.prepare('SELECT credential_id FROM im_credentials WHERE agent_id=?');
  for (const row of db.prepare('SELECT agent_id,request_id,request_hash,instance_id,generation,result_json FROM im_lease_requests').iterate()) {
    budget.tick();
    let result;
    try {result=JSON.parse(row.result_json);} catch {fail('IM_V2_LEASE_INVALID');}
    if (!result || Array.isArray(result) || Object.keys(result).length!==4 || !['instanceId','generation','expiresAt','historical'].every(k=>Object.hasOwn(result,k)) || result.instanceId!==row.instance_id || result.generation!==row.generation || result.historical!==false || !Number.isSafeInteger(result.expiresAt) || result.expiresAt<0 || !Number.isSafeInteger(row.generation) || row.generation<1 || !HEX.test(row.request_hash)) fail('IM_V2_LEASE_INVALID');
    let bound=false;
    for (const credential of requestCredentials.iterate(row.agent_id)) {
      budget.tick();
      if (sha(JSON.stringify([row.instance_id,credential.credential_id]))===row.request_hash) bound=true;
    }
    if (!bound) fail('IM_V2_LEASE_INVALID');
  }
  // The old schema permits UTF-16 strings longer than the frozen wire contract.
  const messageQuery=db.prepare(`SELECT m.*, k.payload_hash,k.sender_id AS key_sender,k.created_at AS key_created,a.attachment_id,a.name,a.mime,a.size,a.sha256,a.data FROM im_messages m LEFT JOIN im_send_keys k ON k.message_id=m.message_id LEFT JOIN im_attachments a ON a.message_id=m.message_id ORDER BY m.message_id`);
  return messageQuery;
}
function backfill(db,policyHash,importEpoch,budget,now,initial) {
  const query=validateWire(db,budget);
  const content=db.prepare("INSERT INTO im_content_state(message_id,state,expires_at,policy_hash) VALUES (?,'live',?,?)");
  const reserve=db.prepare('INSERT INTO im_attachment_reservations VALUES (?,?,?,?)');
  const mapping=db.prepare("INSERT INTO im_send_operation_keys VALUES (?,?,?,?, 'a2a-msg.im.v1',?)");
  let count=0;
  for (const r of query.iterate()) {
    if (!r.payload_hash || r.key_sender!==r.sender_id || r.key_created!==r.accepted_at || typeof r.client_message_id!=='string' || r.client_message_id.startsWith('v2:') || !UUID.test(r.client_message_id) || !HEX.test(r.payload_hash) || typeof r.text!=='string' || r.text.length>32000 || (r.title!==null && (typeof r.title!=='string' || r.title.length>100)) || (r.correlation!==null && (typeof r.correlation!=='string' || r.correlation.length>200)) || (!r.text.length && !r.attachment_id)) fail('IM_V2_WIRE_INVALID');
    const pair=db.prepare('SELECT agent_low,agent_high FROM im_conversations WHERE conversation_id=?').get(r.conversation_id);
    if (!pair || ![pair.agent_low,pair.agent_high].includes(r.sender_id) || ![pair.agent_low,pair.agent_high].includes(r.recipient_id)) fail();
    if (r.in_reply_to && db.prepare('SELECT conversation_id FROM im_messages WHERE message_id=?').get(r.in_reply_to)?.conversation_id!==r.conversation_id) fail('IM_V2_WIRE_INVALID');
    let attachment=null;
    if (r.attachment_id) {
      if (typeof r.name!=='string' || !r.name.length || r.name.length>200 || r.name==='.' || r.name.includes('..') || /[\\/\x00-\x1f\x7f]/.test(r.name) || (r.mime!==null && (typeof r.mime!=='string' || !r.mime.length || r.mime.length>100)) || !HEX.test(r.sha256) || !(r.data instanceof Uint8Array) || r.data.length!==r.size || sha(r.data)!==r.sha256) fail();
      attachment={name:r.name,mime:r.mime,size:r.size,sha256:r.sha256};
      reserve.run(r.attachment_id,r.message_id,r.size,r.sha256);
    }
    const fingerprint=fingerprintFrozenV1(r,attachment);
    if (fingerprint!==r.payload_hash || r.accepted_at>Number.MAX_SAFE_INTEGER-7776000000) fail();
    content.run(r.message_id,r.accepted_at+7776000000,policyHash);
    mapping.run(r.sender_id,importEpoch,r.client_message_id,r.client_message_id,r.message_id);
    count++;
    budget.tick();
  }
  for (const table of ['im_send_keys','im_deliveries']) {let rows=0;for (const _ of db.prepare(`SELECT 1 FROM ${table}`).iterate()){if(++rows>count) fail();budget.tick();}if(rows!==count) fail();}
  const progress=db.prepare('INSERT INTO im_sync_progress VALUES (?,?,?,?,?)');
  for (const state of db.prepare('SELECT * FROM im_receive_state').iterate()) {
    if (state.retained_floor!==1) fail('IM_V2_RETAINED_FLOOR');
    let seq=0,ack=0,awaiting=false;
    for (const d of db.prepare('SELECT seq,message_id,acked_at,read_at FROM im_deliveries WHERE recipient_id=? ORDER BY seq').iterate(state.agent_id)) {
      if (d.seq!==++seq || (d.acked_at===null && d.read_at!==null)) fail('IM_V2_DELIVERY_INVALID');
      const message=db.prepare('SELECT recipient_id FROM im_messages WHERE message_id=?').get(d.message_id);
      if (message?.recipient_id!==state.agent_id) fail('IM_V2_DELIVERY_INVALID');
      if (d.acked_at===null) awaiting=true;
      else if (!awaiting) ack=seq;
      budget.tick();
    }
    if (state.next_seq!==seq+1 || state.acked_through!==ack) fail('IM_V2_ACK_PREFIX_INVALID');
    progress.run(state.agent_id,initial,state.stream_epoch,ack,now);
    budget.tick();
  }
  for (const d of db.prepare('SELECT recipient_id FROM im_deliveries').iterate()) {if (!db.prepare('SELECT 1 FROM im_receive_state WHERE agent_id=?').get(d.recipient_id)) fail('IM_V2_DELIVERY_INVALID');budget.tick();}
}
function run(db,options,kind) {
  const {ref,policy,limits,policyHash}=inputs(options,kind);
  if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys!==1) fail();
  const budget=makeBudget(limits);
  try {return withImmediateTransaction(db,()=>{
    const exists=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'im_%' OR tbl_name LIKE 'im_%' LIMIT 1").get();
    if (exists && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='im_schema'").get()?.name && db.prepare('SELECT version FROM im_schema').get()?.version===4) {
      const saved=db.prepare('SELECT source_version,source_schema_checksum FROM im_schema_preparations WHERE preparation_ref=?').get(ref);
      const inputHash=sha(JSON.stringify([kind,saved?.source_version??null,saved?.source_schema_checksum??null,policy,ref]));
      return result(db,ref,kind,inputHash,policyHash,budget);
    }
    if (kind==='fresh' && exists || kind==='v3_import' && !exists) fail();
    if (kind==='v3_import') {
      // Establish the bounded workload before any row-level identity/content verification.
      const marker=db.prepare('SELECT version,migration_checksum FROM im_schema LIMIT 2').all();
      if (marker.length!==1 || marker[0].version!==3 || marker[0].migration_checksum!==V3_CHECKSUM) fail();
      try {projectCandidateBudget(db,budget,3);} catch (error) {if(error?.code==='IM_V2_BUDGET_EXCEEDED') throw error;fail();}
      assertFrozenV3Structure(db,budget);
      if (db.prepare('SELECT write_mode FROM im_settings').get().write_mode!=='paused') fail();
      budget.tick();if (db.prepare('SELECT 1 FROM pragma_foreign_key_check LIMIT 1').get()) fail();budget.tick();
    }
    const now=Date.now();
    if (!Number.isSafeInteger(now) || now<0 || now>Number.MAX_SAFE_INTEGER-7776000000) fail();
    const inputHash=sha(JSON.stringify([kind,kind==='fresh'?null:3,kind==='fresh'?null:V3_CHECKSUM,policy,ref]));
    const initial=randomUUID(),importEpoch=kind==='fresh'?null:randomUUID();
    if (kind==='fresh') {
      for (const sql of V4_DDL) {db.exec(sql);budget.tick();}
      db.prepare('INSERT INTO im_instance_identity VALUES (1,?,?)').run(randomUUID(),now);
      db.exec("INSERT INTO im_settings(singleton,write_mode) VALUES (1,'paused')");
      db.exec('INSERT INTO im_clock(singleton,last_observed_at) VALUES (1,0)');
    } else {
      db.exec('DROP TABLE im_schema'); db.exec(V4_SCHEMA);
      for (const sql of [...V4_TABLES,...V4_INDEXES]) {db.exec(sql); budget.tick();}
    }
    insertBase(db,kind,ref,policy,policyHash,inputHash,now,initial,importEpoch);
    if (kind==='v3_import') backfill(db,policyHash,importEpoch,budget,now,initial);
    // Publish the v4 marker only once the entire candidate is backfilled. The
    // final full assertion still runs inside this same transaction before commit.
    db.prepare('INSERT INTO im_schema VALUES (4,?)').run(V4_CHECKSUM);
    budget.tick();
    return result(db,ref,kind,inputHash,policyHash,budget);
  });} catch (error) {
    if (error?.code==='IM_V2_BUDGET_EXCEEDED') fail('IM_V2_BUDGET_EXCEEDED');
    if (error?.code==='IM_IDENTITY_MISSING') throw Object.assign(new Error('IM v3 identity missing'),{code:'IM_IDENTITY_MISSING',blockers:Object.freeze([{code:'IM_IDENTITY_MISSING',count:1}])});
    if (error?.code?.startsWith('IM_V2_') && error.code!=='IM_V2_INPUT_INVALID' && error.code!=='IM_V2_PREPARATION_CONFLICT') {
      throw Object.assign(new Error('IM v4 candidate rejected'),{code:'IM_SCHEMA_MISMATCH',blockers:error.blockers??Object.freeze([{code:error.code,count:1}])});
    }
    if (error?.code==='IM_V2_INPUT_INVALID' || error?.code==='IM_V2_PREPARATION_CONFLICT') throw error;
    fail();
  }
}
export function initializeImSchemaV4(db,options) {return run(db,options,'fresh');}
export function migrateImSchemaV4(db,options) {return run(db,options,'v3_import');}
