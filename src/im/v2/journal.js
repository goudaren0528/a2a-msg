import { createHash } from 'node:crypto';
import { ImV2Error, PROTOCOL, normalizeMessageRequest, fingerprintMessage, operationSchema, deliveryRefSchema, messageSchema, tombstoneSchema, dataSchemas } from './contracts.js';
import { withImmediateTransaction } from '../transaction.js';
import { JOURNAL_DDL, JOURNAL_CHECKSUM } from './journal-schema.js';

const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const fail=code=>{throw new ImV2Error(code);};
const integer=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
const hash=v=>createHash('sha256').update(v).digest('hex');
const utf8=v=>Buffer.byteLength(v??'');
// Reserved logical bytes: 64 per row; fixed widths for identity, enums and mutable
// fields; only origin and immutable JSON payloads use actual UTF-8 byte lengths.
const RESERVED=Object.freeze({
  meta:64+8+8+64,
  partition:r=>64+64+utf8(r.center_origin)+36*3+23+64+1020+8,
  outgoing:r=>64+64+36+36+13+64+utf8(r.payload_json)+8+14+36+8+8,
  received:r=>64+64+36+8+36+15+utf8(r.fact_json)+64+utf8(r.attachment_receipt_json)+8+8,
  receiver:()=>64+64+36+8*4+36+8+8,
  batch:r=>64+64+64+36+6+utf8(r.items_json)+64+9+8+8+4096,
});
const obj=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).every(k=>keys.includes(k));
function exact(v,keys) { if(!obj(v,keys)||keys.some(k=>!Object.hasOwn(v,k))) fail('INVALID_REQUEST'); return v; }
function id(v) { if(typeof v!=='string'||!UUID.test(v)) fail('INVALID_REQUEST'); return v; }
function h(v) { if(typeof v!=='string'||!HASH.test(v)) fail('INVALID_REQUEST'); return v; }
function origin(v) { let url; try { url=new URL(v); } catch { fail('INVALID_REQUEST'); } if(typeof v!=='string'||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||v!==url.origin||Buffer.byteLength(v)>2048) fail('INVALID_REQUEST'); return v; }
function identity(v) { exact(v,['centerOrigin','stableInstanceId','agentId','centerEpoch']); return {centerOrigin:origin(v.centerOrigin),stableInstanceId:id(v.stableInstanceId),agentId:id(v.agentId),centerEpoch:id(v.centerEpoch)}; }
function partition(v) { return hash(JSON.stringify([v.centerOrigin,v.stableInstanceId,v.agentId,v.centerEpoch])); }
function json(v,limit) { const value=JSON.stringify(v); if(typeof value!=='string'||Buffer.byteLength(value)>limit) fail('PAYLOAD_TOO_LARGE'); return value; }
function limitOption(v) { if(!obj(v,['limit'])) fail('INVALID_REQUEST'); const n=v.limit??20; if(!integer(n,1)||n>100) fail('INVALID_REQUEST'); return n; }
function operation(v) { if(!operationSchema.safeParse(v).success) fail('INVALID_REQUEST'); return v; }
function receipt(v,p,m) { if(m.attachment===null) { if(v!==null) fail('INVALID_REQUEST'); return null; } exact(v,['relativeName','sha256','size','durability']); const a=m.attachment; if(v.relativeName!==`${p}-${m.messageId}-${a.attachmentId}.bin`||v.sha256!==a.sha256||v.size!==a.size||v.durability!=='durable') fail('INVALID_ATTACHMENT'); return v; }
function mismatch() { fail('STORAGE_UNAVAILABLE'); }
function verifiedPartition(r) {
  if(!r)mismatch();
  let v;try{v=identity({centerOrigin:r.center_origin,stableInstanceId:r.stable_instance_id,agentId:r.agent_id,centerEpoch:r.center_epoch});}catch{mismatch();}
  if(partition(v)!==r.partition_id||!['active','reconciliation_required','archived'].includes(r.status)||!integer(r.created_at))mismatch();
  return r;
}
function verifiedFact(r,scope,expected) {
  if(!r||!HASH.test(r.partition_id)||!UUID.test(r.stream_epoch)||!integer(r.seq,1)||!UUID.test(r.message_id)||!integer(r.recorded_at)||![0,1].includes(r.server_confirmed)||!HASH.test(r.fact_hash)||typeof r.fact_json!=='string'||utf8(r.fact_json)>262144||hash(r.fact_json)!==r.fact_hash)mismatch();
  if(!scope||r.partition_id!==scope.partition_id||expected&&(r.stream_epoch!==expected.streamEpoch||r.seq!==expected.seq||r.message_id!==expected.messageId||r.kind!==expected.kind))mismatch();
  let value;try{value=JSON.parse(r.fact_json);}catch{mismatch();}
  if(JSON.stringify(value)!==r.fact_json)mismatch();
  if(r.kind==='message'){
    if(!obj(value,['messageId','conversationId','senderAgentId','recipientAgentId','originEpoch','clientMessageId','title','text','inReplyTo','correlation','acceptedAt','expiresAt','attachment'])||Object.keys(value).length!==13||!messageSchema.safeParse({...value,deliveredAt:null,readAt:null}).success||value.messageId!==r.message_id||value.recipientAgentId!==scope.agent_id||value.recipientAgentId===value.senderAgentId)mismatch();
    let proof=null;if(r.attachment_receipt_json!==null){if(typeof r.attachment_receipt_json!=='string'||utf8(r.attachment_receipt_json)>4096)mismatch();try{proof=JSON.parse(r.attachment_receipt_json);}catch{mismatch();}if(JSON.stringify(proof)!==r.attachment_receipt_json)mismatch();}
    try{receipt(proof,r.partition_id,value);}catch{mismatch();}
  }else if(r.kind==='content_expired'){
    if(!tombstoneSchema.safeParse(value).success||value.messageId!==r.message_id||r.attachment_receipt_json!==null)mismatch();
  }else mismatch();
  return r;
}
function verifiedBatch(r){
  if(!r||!HASH.test(r.batch_id)||!HASH.test(r.partition_id)||!UUID.test(r.stream_epoch)||!['ack','expiry'].includes(r.kind)||!['pending','confirmed'].includes(r.state)||!integer(r.created_at)||r.state==='pending'&&r.confirmed_at!==null||r.state==='confirmed'&&!integer(r.confirmed_at)||!HASH.test(r.items_hash)||typeof r.items_json!=='string'||utf8(r.items_json)>16384||hash(r.items_json)!==r.items_hash)mismatch();
  let items;try{items=JSON.parse(r.items_json);}catch{mismatch();}
  if(!Array.isArray(items)||items.length<1||items.length>100||items.some(x=>!deliveryRefSchema.safeParse(x).success)||items.some((x,i)=>i>0&&x.seq<=items[i-1].seq)||new Set(items.map(x=>x.messageId)).size!==items.length||JSON.stringify(items)!==r.items_json||hash(JSON.stringify([r.partition_id,r.stream_epoch,r.kind,items]))!==r.batch_id)mismatch();
  if(r.last_response_json!==null){let response;try{response=JSON.parse(r.last_response_json);}catch{mismatch();}if(!(r.kind==='ack'?dataSchemas.acks:dataSchemas.expiryReceipts).safeParse(response).success||response.streamEpoch!==r.stream_epoch||utf8(r.last_response_json)>4096)mismatch();}
  return items;
}

export function createImV2Journal({db,limits={},clock=Date.now}={}) {
  if(!db||typeof db.prepare!=='function'||typeof db.exec!=='function'||db.isTransaction!==false||typeof clock!=='function') fail('STORAGE_UNAVAILABLE');
  const defaults={maxPartitions:32,maxOutgoing:10000,maxReceivedFacts:20000,maxBatches:10000,maxLogicalBytes:268435456};
  if(!obj(limits,Object.keys(defaults))) fail('INVALID_REQUEST');
  const bounds={...defaults,...limits};
  for(const k of Object.keys(defaults)) if(!integer(bounds[k],1)||bounds[k]>defaults[k]) fail('INVALID_REQUEST');
  const maxPartition=RESERVED.partition({center_origin:'x'.repeat(2048)});
  const control=Math.min(4,Math.max(0,bounds.maxPartitions-1),Math.max(0,Math.floor((bounds.maxLogicalBytes-RESERVED.meta-maxPartition)/maxPartition)));
  try {
    const files=db.prepare('PRAGMA database_list').all();
    if(!files.some(r=>r.name==='main'&&r.file&&r.file!==':memory:')||db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1||db.prepare('PRAGMA synchronous').get().synchronous!==2&&db.prepare('PRAGMA synchronous').get().synchronous!==3) mismatch();
    withImmediateTransaction(db,()=>{
      const found=db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
      if(found.length===0) { if(bounds.maxLogicalBytes<RESERVED.meta+RESERVED.partition({center_origin:'https://a'})+control*maxPartition) fail('CAPACITY_EXHAUSTED');for(const sql of Object.values(JOURNAL_DDL)) db.exec(sql); db.prepare('INSERT INTO im_v2_client_meta(singleton,version,checksum) VALUES (1,2,?)').run(JOURNAL_CHECKSUM); }
      else {
        if(found.length!==Object.keys(JOURNAL_DDL).length||found.some(r=>!Object.hasOwn(JOURNAL_DDL,r.name)||r.sql!==JOURNAL_DDL[r.name]||r.type!==(r.name==='im_v2_client_one_active'||r.name.endsWith('_pending')?'index':'table'))) mismatch();
        const rows=db.prepare('SELECT singleton,version,checksum FROM im_v2_client_meta LIMIT 2').all();
       if(rows.length!==1||rows[0].singleton!==1||rows[0].version!==2||rows[0].checksum!==JOURNAL_CHECKSUM) mismatch();
      }
      if(db.prepare('PRAGMA foreign_key_check').get()) mismatch();
    });
  } catch(e) { if(e instanceof ImV2Error) throw e; fail('STORAGE_UNAVAILABLE'); }
  const now=()=>{let n;try{n=clock();}catch{fail('CLOCK_UNSAFE');}if(!integer(n)) fail('CLOCK_UNSAFE');return n;};
  function connection() {try{if(db.isTransaction!==false||db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1||![2,3].includes(db.prepare('PRAGMA synchronous').get().synchronous))mismatch();}catch{mismatch();}}
  const get=(sql,...a)=>db.prepare(sql).get(...a);
  const all=(sql,...a)=>db.prepare(sql).all(...a);
  const run=(sql,...a)=>db.prepare(sql).run(...a);
  const tx=fn=>{connection();try{return withImmediateTransaction(db,fn);}catch(e){if(e instanceof ImV2Error)throw e;fail('STORAGE_UNAVAILABLE');} };
  function row(p) { h(p); return get('SELECT * FROM im_v2_client_partitions WHERE partition_id=?',p); }
  function trustedPartition(p) { return verifiedPartition(row(p)); }
  function active(p) { const r=row(p);if(!r||r.status!=='active') fail('RECOVERY_RECONCILIATION_REQUIRED');return r; }
  function scopedFact(r,scope,expected) { return verifiedFact(r,scope,expected); }
  const tables={partition:['im_v2_client_partitions',bounds.maxPartitions],outgoing:['im_v2_client_outgoing',bounds.maxOutgoing],received:['im_v2_client_received',bounds.maxReceivedFacts],receiver:['im_v2_client_receiver',bounds.maxReceivedFacts],batch:['im_v2_client_batches',bounds.maxBatches]};
  function reservedUsage() {
    let total=RESERVED.meta, reconcile=0,primary=0;
    for(const [type,[table,max]] of Object.entries(tables)) {
      const statement=db.prepare(`SELECT ${type==='partition'?'center_origin,predecessor_id':type==='outgoing'?'payload_json':type==='received'?'fact_json,attachment_receipt_json':type==='batch'?'items_json':'partition_id'} FROM ${table} LIMIT ?`);
      let count=0;
      for(const r of statement.iterate(max+1)){if(++count>max)fail('CAPACITY_EXHAUSTED');total+=RESERVED[type](r);if(type==='partition')r.predecessor_id===null?primary++:reconcile++;}
    }
    if(primary>bounds.maxPartitions-control||reconcile>control||total+(control-reconcile)*maxPartition>bounds.maxLogicalBytes)fail('CAPACITY_EXHAUSTED');
    return {total,reconcile,primary};
  }
  function capacity(newRows,{reconciliation=false}={}) {
    const used=reservedUsage(),increments={};let growth=0;
    for(const [type,rowValue] of newRows) {increments[type]=(increments[type]??0)+1;growth+=RESERVED[type](rowValue);}
    for(const [type,count] of Object.entries(increments))if(get(`SELECT 1 FROM ${tables[type][0]} LIMIT 1 OFFSET ?`,tables[type][1]-count))fail('CAPACITY_EXHAUSTED');
    if(used.primary+(reconciliation?0:(increments.partition??0))>bounds.maxPartitions-control||used.reconcile+(reconciliation?1:0)>control||
       used.total+growth+(control-used.reconcile-(reconciliation?1:0))*maxPartition>bounds.maxLogicalBytes)fail('CAPACITY_EXHAUSTED');
  }
  function bindIdentity(raw) {
    const v=identity(raw),p=partition(v);
    const result=tx(()=>{
      const existing=get('SELECT * FROM im_v2_client_partitions WHERE center_origin=? AND agent_id=? AND status=?',v.centerOrigin,v.agentId,'active');
      if(existing&&existing.partition_id!==p) { run('UPDATE im_v2_client_partitions SET status=? WHERE partition_id=?','reconciliation_required',existing.partition_id); return null; }
      if(existing) return p;
      if(get("SELECT 1 FROM im_v2_client_partitions WHERE center_origin=? AND agent_id=? AND status='reconciliation_required' LIMIT 1",v.centerOrigin,v.agentId)) return null;
      const prior=row(p); if(prior) return null;
      capacity([['partition',{center_origin:v.centerOrigin}]]);
      run('INSERT INTO im_v2_client_partitions(partition_id,center_origin,stable_instance_id,agent_id,center_epoch,status,created_at) VALUES (?,?,?,?,?,?,?)',p,v.centerOrigin,v.stableInstanceId,v.agentId,v.centerEpoch,'active',now()); return p;
    });
    if(result===null) fail('RECOVERY_RECONCILIATION_REQUIRED');return result;
  }
  function reconcilePartition({oldPartitionId,newIdentity,decisionRef}={}) {
    h(oldPartitionId);const v=identity(newIdentity),p=partition(v);
    if(typeof decisionRef!=='string'||!decisionRef.length||decisionRef.length>255||/[\x00-\x1f\x7f]/.test(decisionRef)) fail('INVALID_REQUEST');
    return tx(()=>{
      const old=row(oldPartitionId);if(!old||old.center_origin!==v.centerOrigin||old.agent_id!==v.agentId||old.partition_id===p) fail('INVALID_REQUEST');
      const previous=row(p);
      if(previous) { if(previous.predecessor_id!==oldPartitionId||previous.decision_ref!==decisionRef||previous.status!=='active') fail('RECOVERY_RECONCILIATION_REQUIRED');return p; }
      if(old.status!=='reconciliation_required'||get("SELECT 1 FROM im_v2_client_partitions WHERE center_origin=? AND agent_id=? AND status='active'",v.centerOrigin,v.agentId)) fail('RECOVERY_RECONCILIATION_REQUIRED');
      capacity([['partition',{center_origin:v.centerOrigin}]],{reconciliation:true});
      run('UPDATE im_v2_client_partitions SET status=? WHERE partition_id=?','archived',oldPartitionId);
      run('INSERT INTO im_v2_client_partitions(partition_id,center_origin,stable_instance_id,agent_id,center_epoch,status,predecessor_id,decision_ref,created_at) VALUES (?,?,?,?,?,?,?,?,?)',p,v.centerOrigin,v.stableInstanceId,v.agentId,v.centerEpoch,'active',oldPartitionId,decisionRef,now());return p;
    });
  }
  function outgoing(p,op) { const r=get('SELECT * FROM im_v2_client_outgoing WHERE partition_id=? AND origin_epoch=? AND client_message_id=?',p,op.originEpoch,op.clientMessageId); if(!r)return null;let request=null;
    if(r.payload_json!==null){try{request=JSON.parse(r.payload_json);const normalized=normalizeMessageRequest(request);if(JSON.stringify(request)!==r.payload_json||fingerprintMessage(normalized)!==r.fingerprint||normalized.originEpoch!==op.originEpoch||normalized.clientMessageId!==op.clientMessageId||normalized.centerEpoch!==row(p).center_epoch||r.source_protocol!==PROTOCOL) mismatch();}catch{mismatch();}}
    if(!UUID.test(r.origin_epoch)||!UUID.test(r.client_message_id)||!HASH.test(r.fingerprint)||!['a2a-msg.im.v1',PROTOCOL].includes(r.source_protocol)||!['pending','accepted'].includes(r.acceptance_state)||!['none','required','remote_unknown'].includes(r.reconciliation_state)||!integer(r.created_at)||r.acceptance_state==='accepted'&&(!UUID.test(r.message_id)||!integer(r.accepted_at))||r.acceptance_state==='pending'&&(r.message_id!==null||r.accepted_at!==null))mismatch();
    const {payload_json,...rest}=r;return {...rest,request}; }
  function validateStored() {
    for(const r of db.prepare('SELECT * FROM im_v2_client_partitions LIMIT ?').iterate(bounds.maxPartitions+1)){
      verifiedPartition(r);
      if(r.predecessor_id===null&&r.decision_ref!==null||r.predecessor_id!==null&&(!HASH.test(r.predecessor_id)||r.predecessor_id===r.partition_id||typeof r.decision_ref!=='string'||!r.decision_ref.length||r.decision_ref.length>255||/[\x00-\x1f\x7f]/.test(r.decision_ref)))mismatch();
      if(r.predecessor_id!==null){const prior=row(r.predecessor_id);if(!prior||prior.center_origin!==r.center_origin||prior.agent_id!==r.agent_id||prior.stable_instance_id===r.stable_instance_id&&prior.center_epoch===r.center_epoch)mismatch();}
    }
    for(const r of db.prepare('SELECT partition_id,origin_epoch,client_message_id FROM im_v2_client_outgoing LIMIT ?').iterate(bounds.maxOutgoing+1))outgoing(r.partition_id,{originEpoch:r.origin_epoch,clientMessageId:r.client_message_id});
    for(const r of db.prepare('SELECT * FROM im_v2_client_received LIMIT ?').iterate(bounds.maxReceivedFacts+1)){
      const scope=trustedPartition(r.partition_id);
      scopedFact(r,scope,{streamEpoch:r.stream_epoch,seq:r.seq,messageId:r.message_id,kind:r.kind});
      const cross=get('SELECT message_id,seq FROM im_v2_client_received WHERE partition_id=? AND stream_epoch=? AND seq=? AND kind<>? LIMIT 1',r.partition_id,r.stream_epoch,r.seq,r.kind);
      if(cross&&cross.message_id!==r.message_id)mismatch();
      if(get('SELECT 1 FROM im_v2_client_received WHERE partition_id=? AND stream_epoch=? AND message_id=? AND seq<>? LIMIT 1',r.partition_id,r.stream_epoch,r.message_id,r.seq))mismatch();
    }
    for(const r of db.prepare('SELECT * FROM im_v2_client_receiver LIMIT ?').iterate(bounds.maxReceivedFacts+1)){
      if(!row(r.partition_id)||!UUID.test(r.stream_epoch)||![r.handled_cursor,r.acked_cursor,r.server_handled,r.server_acked].every(x=>integer(x))||r.acked_cursor>r.handled_cursor||r.instance_id===null&&(r.generation!==null||r.expires_at!==null)||r.instance_id!==null&&(!UUID.test(r.instance_id)||!integer(r.generation,1)||!integer(r.expires_at)))mismatch();
      for(const [cursor,kind] of [[r.handled_cursor,null],[r.acked_cursor,'message']])if(cursor>0){
        if(cursor>bounds.maxReceivedFacts||get(`SELECT count(DISTINCT seq) AS n FROM im_v2_client_received WHERE partition_id=? AND stream_epoch=? AND seq<=? AND server_confirmed=1 ${kind?"AND kind='message'":''}`,r.partition_id,r.stream_epoch,cursor).n!==cursor)mismatch();
      }
    }
    for(const b of db.prepare('SELECT * FROM im_v2_client_batches LIMIT ?').iterate(bounds.maxBatches+1)){
      const items=verifiedBatch(b);if(!receiver(b.partition_id,b.stream_epoch))mismatch();const scope=trustedPartition(b.partition_id);for(const item of items){const kind=b.kind==='ack'?'message':'content_expired';const fact=scopedFact(get('SELECT * FROM im_v2_client_received WHERE partition_id=? AND stream_epoch=? AND seq=? AND message_id=? AND kind=?',b.partition_id,b.stream_epoch,item.seq,item.messageId,kind),scope,{streamEpoch:b.stream_epoch,seq:item.seq,messageId:item.messageId,kind});if(b.state==='confirmed'&&fact.server_confirmed!==1)mismatch();}
    }
  }
  try{withImmediateTransaction(db,()=>{reservedUsage();validateStored();});}catch(e){if(e instanceof ImV2Error)throw e;mismatch();}
  function stageOutgoing(p,request) {
    active(p);
    const v=request?.attachment?.bytes instanceof Uint8Array ? request : normalizeMessageRequest(request);
    const fingerprint=fingerprintMessage(v);
    if(v.centerEpoch!==row(p).center_epoch||v.originEpoch!==v.centerEpoch) fail('RECOVERY_RECONCILIATION_REQUIRED');
    const wire={protocol:PROTOCOL,centerEpoch:v.centerEpoch,originEpoch:v.originEpoch,clientMessageId:v.clientMessageId,conversationId:v.conversationId,recipientAgentId:v.recipientAgentId,title:v.title,text:v.text,attachment:v.attachment===null?null:{name:v.attachment.name,mime:v.attachment.mime,sha256:v.attachment.sha256,dataBase64:Buffer.from(v.attachment.bytes).toString('base64')},inReplyTo:v.inReplyTo,correlation:v.correlation};
    const payload=json(wire,16777216),op={originEpoch:v.originEpoch,clientMessageId:v.clientMessageId};
    return tx(()=>{active(p);const old=outgoing(p,op);if(old) {if(old.fingerprint!==fingerprint||JSON.stringify(old.request)!==payload) fail('IDEMPOTENCY_CONFLICT');return old;}
      capacity([['outgoing',{payload_json:payload}]]);
      run('INSERT INTO im_v2_client_outgoing(partition_id,origin_epoch,client_message_id,source_protocol,fingerprint,payload_json,acceptance_state,reconciliation_state,created_at) VALUES (?,?,?,?,?,?,?,?,?)',p,v.originEpoch,v.clientMessageId,PROTOCOL,fingerprint,payload,'pending','none',now());return outgoing(p,op);});
  }
  function markAccepted(p,op,evidence) { h(p);operation(op);if(!dataSchemas.sendResult.safeParse(evidence).success) fail('INVALID_REQUEST');return tx(()=>{if(!row(p))fail('INVALID_REQUEST');const r=outgoing(p,op);if(!r||r.fingerprint!==evidence.payloadHash||evidence.originEpoch!==op.originEpoch||evidence.clientMessageId!==op.clientMessageId||evidence.sourceProtocol!==r.source_protocol) fail('INVALID_REQUEST');if(r.acceptance_state==='accepted') {if(r.message_id!==evidence.messageId||r.accepted_at!==evidence.acceptedAt) fail('IDEMPOTENCY_CONFLICT');return r;}run('UPDATE im_v2_client_outgoing SET acceptance_state=?,message_id=?,accepted_at=? WHERE partition_id=? AND origin_epoch=? AND client_message_id=?','accepted',evidence.messageId,evidence.acceptedAt,p,op.originEpoch,op.clientMessageId);return outgoing(p,op);}); }
  function receiver(p,s) {return get('SELECT * FROM im_v2_client_receiver WHERE partition_id=? AND stream_epoch=?',p,s);}
  function ensureReceiver(p,s) {if(!receiver(p,s)) run('INSERT INTO im_v2_client_receiver(partition_id,stream_epoch) VALUES (?,?)',p,s); }
  function fact(p,s,seq,kind,value,proof) {
    return tx(()=>{const r=active(p),scope=trustedPartition(p);id(s);if(!integer(seq,1))fail('INVALID_REQUEST');const m=kind==='message'?messageSchema.safeParse(value):tombstoneSchema.safeParse(value);
      if(!m.success||kind==='message'&&(m.data.recipientAgentId!==r.agent_id||m.data.senderAgentId===m.data.recipientAgentId)) fail('INVALID_REQUEST');
      const item=m.data;const receiptValue=kind==='message'?receipt(proof,p,item):null;
      if(kind==='content_expired'&&proof!==undefined) fail('INVALID_REQUEST');
      const content=kind==='message'?{...item,deliveredAt:undefined,readAt:undefined}:item;
      const serialized=json(content,262144),receiptJson=receiptValue===null?null:json(receiptValue,4096),digest=hash(serialized);
      const conflicts=all('SELECT * FROM im_v2_client_received WHERE partition_id=? AND stream_epoch=? AND (seq=? OR message_id=?) LIMIT 4',p,s,seq,item.messageId);
      let repeated=null;
      for(const old of conflicts) {scopedFact(old,scope,{streamEpoch:s,seq:old.seq,messageId:old.message_id,kind:old.kind});if(old.seq!==seq||old.message_id!==item.messageId) fail('IDEMPOTENCY_CONFLICT');if(old.kind===kind) {if(old.fact_json!==serialized||old.fact_hash!==digest||old.attachment_receipt_json!==receiptJson)fail('IDEMPOTENCY_CONFLICT');repeated=old;} }
      if(repeated)return repeated;
      capacity([['received',{fact_json:serialized,attachment_receipt_json:receiptJson}],...(!receiver(p,s)?[['receiver',{}]]:[])]);
      ensureReceiver(p,s);
      run('INSERT INTO im_v2_client_received(partition_id,stream_epoch,seq,message_id,kind,fact_json,fact_hash,attachment_receipt_json,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)',p,s,seq,item.messageId,kind,serialized,digest,receiptJson,now());
      return get('SELECT * FROM im_v2_client_received WHERE partition_id=? AND stream_epoch=? AND seq=? AND kind=?',p,s,seq,kind);
    });
  }
  function batch(p,{streamEpoch,kind,items}={}) {
    h(p);id(streamEpoch);if(kind!=='ack'&&kind!=='expiry'||!Array.isArray(items)||items.length<1||items.length>100||items.some(x=>!deliveryRefSchema.safeParse(x).success))fail('INVALID_REQUEST');
    const sorted=items.map(x=>({...x})).sort((a,b)=>a.seq-b.seq);
    if(new Set(sorted.map(x=>x.seq)).size!==sorted.length||new Set(sorted.map(x=>x.messageId)).size!==sorted.length) fail('INVALID_REQUEST');
    const text=json(sorted,16384),bid=hash(JSON.stringify([p,streamEpoch,kind,sorted]));
    return tx(()=>{active(p);const scope=trustedPartition(p);for(const i of sorted) {const factKind=kind==='ack'?'message':'content_expired';const r=get('SELECT * FROM im_v2_client_received WHERE partition_id=? AND stream_epoch=? AND seq=? AND message_id=? AND kind=?',p,streamEpoch,i.seq,i.messageId,factKind);if(!r)fail('INVALID_REQUEST');scopedFact(r,scope,{streamEpoch,seq:i.seq,messageId:i.messageId,kind:factKind});}
      const existing=get('SELECT * FROM im_v2_client_batches WHERE batch_id=?',bid);if(existing)return {...existing,items:verifiedBatch(existing)};
      capacity([['batch',{items_json:text}],...(!receiver(p,streamEpoch)?[['receiver',{}]]:[])]);
      ensureReceiver(p,streamEpoch);run('INSERT INTO im_v2_client_batches(batch_id,partition_id,stream_epoch,kind,items_json,items_hash,state,created_at) VALUES (?,?,?,?,?,?,?,?)',bid,p,streamEpoch,kind,text,hash(text),'pending',now());return {...get('SELECT * FROM im_v2_client_batches WHERE batch_id=?',bid),items:sorted};});
  }
  function advance(p,s,scope) {
    const r=receiver(p,s);let handled=r.handled_cursor,acked=r.acked_cursor;
    // Boundary proofs and forward proofs share one 1000-distinct-seq budget.
    // Cache confirmed kinds so an already checked boundary is never read again.
    const cache=new Map();
    // Persisted cursor boundaries must still have durable confirmed proof. A
    // formerly crossed fact cannot be treated as authority after native tamper.
    for(const [cursor,kind] of [[handled,null],[acked,'message']])if(cursor>0){
      if(!cache.has(cursor)){
        if(cache.size>=1000)mismatch();
        const boundary=all('SELECT * FROM im_v2_client_received WHERE partition_id=? AND stream_epoch=? AND seq=? LIMIT 2',p,s,cursor);
        for(const f of boundary)scopedFact(f,scope,{streamEpoch:s,seq:cursor,messageId:f.message_id,kind:f.kind});
        cache.set(cursor,{message:boundary.some(f=>f.kind==='message'&&f.server_confirmed===1),expiry:boundary.some(f=>f.kind==='content_expired'&&f.server_confirmed===1)});
      }
      const proof=cache.get(cursor);
      if(!(kind==='message'?proof.message:proof.message||proof.expiry))mismatch();
    }
    const next=seq=>{if(!integer(seq,1))return null;if(cache.has(seq))return cache.get(seq);if(cache.size>=1000)return null;
      const kinds=all('SELECT * FROM im_v2_client_received WHERE partition_id=? AND stream_epoch=? AND seq=? AND server_confirmed=1 LIMIT 2',p,s,seq);
      for(const stored of kinds)scopedFact(stored,scope,{streamEpoch:s,seq,messageId:stored.message_id,kind:stored.kind});
      const fact={message:kinds.some(x=>x.kind==='message'),expiry:kinds.some(x=>x.kind==='content_expired')};cache.set(seq,fact);return fact;};
    while(true){const f=next(handled+1);if(!f||!(f.message||f.expiry))break;handled++;}
    while(acked<handled){const f=next(acked+1);if(!f?.message)break;acked++;}
    run('UPDATE im_v2_client_receiver SET handled_cursor=?,acked_cursor=? WHERE partition_id=? AND stream_epoch=?',handled,acked,p,s);
    const pendingProof=(seq,kind)=>{const found=get(`SELECT * FROM im_v2_client_received WHERE partition_id=? AND stream_epoch=? AND seq=? ${kind?"AND kind='message'":''} AND server_confirmed=1 LIMIT 1`,p,s,seq);
      if(found)scopedFact(found,scope,{streamEpoch:s,seq,messageId:found.message_id,kind:found.kind});return !!found;};
    const handledPending=pendingProof(handled+1,null),ackPending=pendingProof(acked+1,'message');
    const pending=handledPending||ackPending;
    return {handledCursor:handled,ackedCursor:acked,progressPending:pending};
  }
  function confirmBatch(batchId,progressResponse) {h(batchId);exact(progressResponse,['protocol','centerEpoch','data']);if(progressResponse.protocol!==PROTOCOL)fail('INVALID_REQUEST');const response=progressResponse.data;id(progressResponse.centerEpoch);return tx(()=>{
    const b=get('SELECT * FROM im_v2_client_batches WHERE batch_id=?',batchId);if(!b) fail('INVALID_REQUEST');active(b.partition_id);const scope=trustedPartition(b.partition_id);
    if(!(b.kind==='ack'?dataSchemas.acks:dataSchemas.expiryReceipts).safeParse(response).success)fail('INVALID_REQUEST');
    if(progressResponse.centerEpoch!==row(b.partition_id).center_epoch||response.streamEpoch!==b.stream_epoch||response.handledThrough<response.ackedThrough) fail('INVALID_REQUEST');
    const items=verifiedBatch(b);
    for(const x of items) {const kind=b.kind==='ack'?'message':'content_expired';const fact=scopedFact(get('SELECT * FROM im_v2_client_received WHERE partition_id=? AND stream_epoch=? AND seq=? AND message_id=? AND kind=?',b.partition_id,b.stream_epoch,x.seq,x.messageId,kind),scope,{streamEpoch:b.stream_epoch,seq:x.seq,messageId:x.messageId,kind});if(b.state==='confirmed'&&fact.server_confirmed!==1)mismatch();}
    const text=json(response,4096);if(b.state==='pending') {run('UPDATE im_v2_client_batches SET state=?,confirmed_at=?,last_response_json=? WHERE batch_id=?','confirmed',now(),text,batchId);for(const x of items) {const change=run('UPDATE im_v2_client_received SET server_confirmed=1 WHERE partition_id=? AND stream_epoch=? AND seq=? AND message_id=? AND kind=?',b.partition_id,b.stream_epoch,x.seq,x.messageId,b.kind==='ack'?'message':'content_expired');if(change.changes!==1)mismatch();}}
    else run('UPDATE im_v2_client_batches SET last_response_json=? WHERE batch_id=?',text,batchId);
    const r=receiver(b.partition_id,b.stream_epoch);run('UPDATE im_v2_client_receiver SET server_handled=?,server_acked=? WHERE partition_id=? AND stream_epoch=?',Math.max(r.server_handled,response.handledThrough),Math.max(r.server_acked,response.ackedThrough),b.partition_id,b.stream_epoch);
    return {...advance(b.partition_id,b.stream_epoch,scope),serverHandled:Math.max(r.server_handled,response.handledThrough),serverAcked:Math.max(r.server_acked,response.ackedThrough)};
  }); }
  const facade={bindIdentity,requireActivePartition:p=>({...active(p)}),markReconciliationRequired:p=>tx(()=>{const r=active(p);run('UPDATE im_v2_client_partitions SET status=? WHERE partition_id=?','reconciliation_required',r.partition_id);return true;}),reconcilePartition,
    stageOutgoing,getOutgoing:(p,op)=>{h(p);operation(op);return outgoing(p,op);},markAccepted,
    markRemoteUnknown:(p,op)=>{h(p);operation(op);return tx(()=>{const r=outgoing(p,op);if(!r)fail('INVALID_REQUEST');run('UPDATE im_v2_client_outgoing SET reconciliation_state=? WHERE partition_id=? AND origin_epoch=? AND client_message_id=?','remote_unknown',p,op.originEpoch,op.clientMessageId);return outgoing(p,op);});},
    listPendingOutgoing:(p,opts={})=>{h(p);const n=limitOption(opts);return all("SELECT origin_epoch,client_message_id FROM im_v2_client_outgoing WHERE partition_id=? AND acceptance_state='pending' ORDER BY created_at,origin_epoch,client_message_id LIMIT ?",p,n).map(r=>outgoing(p,{originEpoch:r.origin_epoch,clientMessageId:r.client_message_id}));},
    getReceiver:(p,s)=>{h(p);id(s);return receiver(p,s)??null;},
    setLease:(p,evidence)=>{h(p);if(!dataSchemas.lease.safeParse(evidence).success||evidence.historical)fail('INVALID_REQUEST');return tx(()=>{const r=active(p);if(evidence.centerEpoch!==r.center_epoch)fail('RECOVERY_RECONCILIATION_REQUIRED');if(!receiver(p,evidence.streamEpoch))capacity([['receiver',{}]]);ensureReceiver(p,evidence.streamEpoch);run('UPDATE im_v2_client_receiver SET instance_id=?,generation=?,expires_at=? WHERE partition_id=? AND stream_epoch=?',evidence.instanceId,evidence.generation,evidence.expiresAt,p,evidence.streamEpoch);return receiver(p,evidence.streamEpoch);});},
    recordMessage:(p,{streamEpoch,seq,message,receipt:proof}={})=>fact(p,streamEpoch,seq,'message',message,proof),
    recordExpiry:(p,{streamEpoch,seq,tombstone}={})=>fact(p,streamEpoch,seq,'content_expired',tombstone),
    prepareBatch:batch,confirmBatch,
    listPendingBatches:(p,opts={})=>{h(p);const n=limitOption(opts);return all("SELECT * FROM im_v2_client_batches WHERE partition_id=? AND state='pending' ORDER BY created_at,batch_id LIMIT ?",p,n).map(r=>({...r,items:verifiedBatch(r)}));}
  };
  return Object.freeze(facade);
}
