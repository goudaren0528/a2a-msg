import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as c from '../src/im/v2/contracts.js';
import { DEFAULT_POLICY, DEFAULT_MAINTENANCE, hashRetentionPolicy, parseImV2Config } from '../src/im/v2/config.js';
import { assertImSchemaV4 } from '../src/im/v2/schema.js';
import { migrateImSchemaV4 } from '../src/im/v2/migration.js';
import { legacy, addMessage, insert, importOptions } from './fixtures/im-v2-schema/helpers.js';

const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const C='cccccccc-cccc-cccc-cccc-cccccccccccc';
const H=bytes=>createHash('sha256').update(bytes).digest('hex');
const request=()=>({protocol:c.PROTOCOL,centerEpoch:A,originEpoch:A,clientMessageId:B,conversationId:C,
  recipientAgentId:B,text:'hello'});
const throws=(fn,code,label)=>assert.throws(fn,e=>e instanceof c.ImV2Error && e.code===code,label);
const scope=()=>({protocol:c.PROTOCOL,centerEpoch:A});
const id=n=>`00000000-0000-0000-0000-${n.toString(16).padStart(12,'0')}`;
const message=(messageId=A)=>({messageId,conversationId:C,senderAgentId:A,recipientAgentId:B,
  originEpoch:A,clientMessageId:B,title:null,text:'hello',inReplyTo:null,correlation:null,
  acceptedAt:1,expiresAt:7776000001,deliveredAt:null,readAt:null,attachment:null});
const tombstone=(messageId=B)=>({messageId,conversationId:C,acceptedAt:1,expiresAt:7776000001,expiredAt:7776000001});
const historyItem=(messageId=A)=>({kind:'message',message:message(messageId)});
const expiredItem=(messageId=B)=>({kind:'content_expired',tombstone:tombstone(messageId)});
const syncItem=(seq,messageId=id(seq))=>({centerEpoch:A,streamEpoch:B,seq,...historyItem(messageId)});
const progress=()=>({streamEpoch:B,handledThrough:0,ackedThrough:0,progressPending:false});
const syncPage=items=>({...progress(),items,pageAfter:items.at(-1)?.seq??0,hasMore:false});
const page=items=>({items,nextCursor:null});
const ack=items=>({...scope(),instanceId:B,generation:1,streamEpoch:C,items});
// Independent frozen wire encoding; malformed tuples must never go through encodeCursor.
const cursorTuple=tuple=>Buffer.from(JSON.stringify(tuple)).toString('base64url');
function accepts(schema,value,label) {
  const result=schema.safeParse(value);
  assert.equal(result.success,true,`${label}: ${result.success ? '' : result.error.message}`);
}
const rejects=(schema,value,label)=>assert.equal(schema.safeParse(value).success,false,label);
const config=()=>({enabled:true,writeMode:'paused',transport:{mode:'direct-tls',serverUrl:'https://example.test:8443/'},
  retention:{policy:{...DEFAULT_POLICY,effectiveAt:100000},policyHash:hashRetentionPolicy({...DEFAULT_POLICY,effectiveAt:100000})},
  lease:{ttlMs:60000,renewalMs:20000},limits:{maxAttachmentBytes:10485760,maxBodyBytes:65536,
    maxFileBodyBytes:16777216,maxConnections:20,maxRequestsPerMinute:200},
  maintenance:{...DEFAULT_MAINTENANCE,maxKeyReservations:10000}});

test('strict scope, version and query duplication',()=>{
  assert.equal(c.scopeSchema.parse(scope()).centerEpoch,A);
  for (const changed of [{centerEpoch:undefined},{protocol:'a2a-msg.im.v1'},{extra:1},{centerEpoch:A.toUpperCase()}])
    assert.equal(c.scopeSchema.safeParse({...scope(),...changed}).success,false);
  throws(()=>c.normalizeMessageRequest({...request(),centerEpoch:undefined}),'INVALID_REQUEST');
  throws(()=>c.normalizeMessageRequest({...request(),protocol:'a2a-msg.im.v1'}),'UNSUPPORTED_VERSION');
  throws(()=>c.normalizeMessageRequest({...request(),originEpoch:B}),'RECOVERY_RECONCILIATION_REQUIRED');
  throws(()=>c.parseQuery([['limit','1'],['limit','2']],{allowed:['limit']}),'INVALID_REQUEST');
  throws(()=>c.parseQuery([['extra','1']],{allowed:['limit']}),'INVALID_REQUEST');
  assert.equal(c.parseQuery([],{allowed:['limit']}).limit,'20');
});
test('76-byte key bijection and epoch collision separation',()=>{
  const key=c.storageOperationKey(A,B);
  assert.equal(key.length,76); assert.deepEqual(c.parseStorageOperationKey(key),{originEpoch:A,clientMessageId:B});
  assert.notEqual(key,c.storageOperationKey(C,B));
  for (const malformed of [key.toUpperCase(),key.slice(0,-1),key.replace(':', '/'),'v2:'+A+':'+B+':'])
    throws(()=>c.parseStorageOperationKey(malformed),'INVALID_REQUEST');
  assert.equal(c.operationSchema.safeParse({originEpoch:A,clientMessageId:B.toUpperCase()}).success,false);
});
test('nullable title, attachment-only, double-empty, canonical bytes and real digest',()=>{
  const bytes=Buffer.from('verified payload');
  const attachment={name:'safe.txt',mime:null,sha256:H(bytes),dataBase64:bytes.toString('base64')};
  const normalized=c.normalizeMessageRequest({...request(),title:null,text:'',attachment});
  assert.equal(normalized.attachment.size,bytes.length);
  assert.equal(normalized.title,null);
  assert.equal(c.normalizeMessageRequest(request()).title,null);
  throws(()=>c.normalizeMessageRequest({...request(),text:'',attachment:null}),'INVALID_REQUEST');
  for (const invalid of [{...attachment,dataBase64:'Zg=='}, {...attachment,dataBase64:'!!!!'},
    {...attachment,sha256:'0'.repeat(64)}, {...attachment,name:'../bad'}])
    throws(()=>c.normalizeMessageRequest({...request(),attachment:invalid}),'INVALID_ATTACHMENT');
  throws(()=>c.normalizeMessageRequest({...request(),attachment}, {maxAttachmentBytes:bytes.length-1}),'PAYLOAD_TOO_LARGE');
  assert.equal(c.normalizeMessageRequest({...request(),attachment}).attachment.bytes.toString(),bytes.toString());
});
test('fingerprint is independent literal v2 serialization and excludes current center',()=>{
  const normalized=c.normalizeMessageRequest(request());
  const literal=H(JSON.stringify(['a2a-msg.im.v2',A,C,B,B,null,'hello',null,null,null]));
  assert.equal(c.fingerprintMessage(normalized),literal);
  const bytes=Buffer.from('abc');
  const withFile=c.normalizeMessageRequest({...request(),text:'',attachment:{name:'a',sha256:H(bytes),dataBase64:bytes.toString('base64')}});
  assert.equal(c.fingerprintMessage(withFile),H(JSON.stringify(['a2a-msg.im.v2',A,C,B,B,null,'',['a',null,3,H(bytes)],null,null])));
  assert.equal(c.fingerprintMessage({...normalized,centerEpoch:C}),literal,'only current center changes');
  assert.notEqual(c.fingerprintMessage({...normalized,originEpoch:C}),literal,'only origin changes');
  assert.equal(c.fingerprintMessage({...normalized,originEpoch:C}),
    H(JSON.stringify(['a2a-msg.im.v2',C,C,B,B,null,'hello',null,null,null])));
  throws(()=>c.fingerprintMessage({...withFile,attachment:{...withFile.attachment,sha256:'0'.repeat(64)}}),'INVALID_REQUEST');
});
test('minimal tombstone, sync pending and error mapping',()=>{
  const tombstone={messageId:A,conversationId:B,acceptedAt:1,expiresAt:2,expiredAt:3};
  assert.equal(c.tombstoneSchema.safeParse(tombstone).success,true);
  assert.equal(c.tombstoneSchema.safeParse({...tombstone,text:''}).success,false);
  const base={streamEpoch:A,handledThrough:0,ackedThrough:0,items:[],pageAfter:0,hasMore:false};
  assert.equal(c.dataSchemas.sync.safeParse(base).success,false);
  assert.equal(c.dataSchemas.sync.safeParse({...base,progressPending:0}).success,false);
  assert.equal(c.dataSchemas.sync.safeParse({...base,progressPending:false}).success,true);
  for(const schema of [c.dataSchemas.acks,c.dataSchemas.expiryReceipts]) {
    assert.equal(schema.safeParse({streamEpoch:A,handledThrough:0,ackedThrough:0}).success,false);
    assert.equal(schema.safeParse({streamEpoch:A,handledThrough:0,ackedThrough:0,progressPending:true}).success,true);
  }
  assert.equal(c.dataSchemas.message.safeParse(tombstone).success,false);
  assert.equal(c.historyItemSchema.safeParse({kind:'content_expired',tombstone}).success,true);
  assert.equal(c.historyItemSchema.safeParse({kind:'content_expired',tombstone,message:{}}).success,false);
  for(const [code,status] of [['CONTENT_EXPIRED',410],['EXPIRY_RECEIPT_REQUIRED',409],['PROTOCOL_UPGRADE_REQUIRED',426],['SEND_OUTCOME_UNKNOWN',409]]) {
    const e=new c.ImV2Error(code);assert.equal(e.status,status);assert.equal(e.retryable,false);
    assert.equal(c.errorEnvelope(e,'r').error.code,code);
  }
  rejects(c.errorEnvelopeSchema,{protocol:c.PROTOCOL,error:{code:'CONTENT_EXPIRED',message:'Content expired',retryable:false},
    requestId:'r',currentCenterEpoch:A},'currentCenterEpoch only accompanies reconciliation');
  assert.throws(()=>c.errorEnvelope(new c.ImV2Error('CONTENT_EXPIRED'),'r',A),{name:'ZodError'});
  assert.equal(c.errorEnvelope(new c.ImV2Error('RECOVERY_RECONCILIATION_REQUIRED'),'r',A).currentCenterEpoch,A);
  assert.equal(c.MAX_BATCH_ITEMS,100);assert.equal(c.MAX_PREFIX_STEPS,1000);assert.equal(c.MAX_CLIENT_PROGRESS_ROUNDS,10);
  accepts(c.postSchemas.acks,ack([{seq:1,messageId:A}]),'exact ACK baseline');
  rejects(c.postSchemas.acks,ack([]),'empty ACK with otherwise valid fields');
});
test('cursor shape and canonical encoding with scope/epoch binding',()=>{
  const cursor=c.encodeCursor('history',A,B,C,[10,A]);
  assert.deepEqual(c.decodeCursor(cursor,{kind:'history',centerEpoch:A,agentId:B,scope:C}),[10,A]);
  throws(()=>c.decodeCursor(cursor,{kind:'history',centerEpoch:B,agentId:B,scope:C}),'RECOVERY_RECONCILIATION_REQUIRED');
  throws(()=>c.decodeCursor(cursor+'=',{kind:'history',centerEpoch:A,agentId:B,scope:C}),'INVALID_REQUEST');
  throws(()=>c.decodeCursor(cursor,{kind:'history',centerEpoch:A,agentId:B,scope:A}),'INVALID_REQUEST');
});
test('exact policy hash, defaults off, immutable copy and explicit enable prerequisites',()=>{
  assert.equal(parseImV2Config().enabled,false);
  assert.equal(parseImV2Config().writeMode,'paused');
  assert.equal(parseImV2Config().maintenance.maxKeyReservations,null);
  assert.equal(DEFAULT_POLICY.backupRetentionMs,null);
  assert.deepEqual(DEFAULT_POLICY,{version:2,effectiveAt:0,messageRetentionMs:7776000000,
    attachmentRetentionMs:7776000000,safeRetryWindowMs:604800000,auditRetentionMs:15552000000,
    keyReservation:'indefinite',expiryEnabled:false,purgeEnabled:false,backupCleanupEnabled:false,backupRetentionMs:null});
  const cfg=config(),serialized=JSON.stringify(cfg.retention.policy);
  assert.equal(cfg.retention.policyHash,H(serialized));
  assert.equal(cfg.retention.policyHash,'122c5b9730ae0ddf14e2c5da7bf07a79d8717467ea3ba4f0791a9e3c480fbca2');
  const parsed=parseImV2Config(cfg);
  assert.notStrictEqual(parsed,cfg);assert.notStrictEqual(parsed.retention.policy,cfg.retention.policy);
  assert.equal(Object.isFrozen(parsed.maintenance),true);
  for (const value of [parsed,parsed.transport,parsed.retention,parsed.retention.policy,parsed.lease,parsed.limits])
    assert.equal(Object.isFrozen(value),true);
  assert.throws(()=>{parsed.retention.policy.expiryEnabled=true;},TypeError);
  assert.equal(parsed.retention.policy.expiryEnabled,false);
  assert.equal(hashRetentionPolicy(Object.fromEntries(Object.entries(cfg.retention.policy).reverse())),H(serialized));
  cfg.maintenance.maxRows=1;assert.equal(parsed.maintenance.maxRows,100);
  for(const field of ['lease','limits','maintenance','transport','retention']) {
    const changed=config();delete changed[field];throws(()=>parseImV2Config(changed),'POLICY_NOT_CONFIGURED');
  }
  for (const field of Object.keys(DEFAULT_POLICY)) {
    const changed=config();delete changed.retention.policy[field];
    throws(()=>parseImV2Config(changed),'INVALID_REQUEST',`policy requires ${field}`);
  }
  const invalid=config();invalid.retention.policyHash='0'.repeat(64);
  throws(()=>parseImV2Config(invalid),'POLICY_NOT_CONFIGURED');
  const unknown=config();unknown.rogue=true;throws(()=>parseImV2Config(unknown),'INVALID_REQUEST');
});
test('capacity/lease limits, overflow, transport TLS and loopback distinction',()=>{
  for (const [code,mutate] of [
    ['POLICY_NOT_CONFIGURED',x=>{x.lease.renewalMs=x.lease.ttlMs;}],
    ['INVALID_REQUEST',x=>{x.maintenance.maxRows=101;}],
    ['INVALID_REQUEST',x=>{x.maintenance.maxKeyReservations=0;}],
    ['POLICY_NOT_CONFIGURED',x=>{x.retention.policy.effectiveAt=Number.MAX_SAFE_INTEGER-2; x.retention.policyHash=hashRetentionPolicy(x.retention.policy);}],
  ]) { const x=config();mutate(x);throws(()=>parseImV2Config(x),code); }
  const local=config();local.transport={mode:'local-test',serverUrl:'http://127.0.0.1:7777/'};
  assert.equal(parseImV2Config(local).transport.mode,'local-test');
  local.transport.serverUrl='http://example.test:7777/';throws(()=>parseImV2Config(local),'TLS_REQUIRED');
  local.transport={mode:'direct-tls',serverUrl:'http://127.0.0.1:7777/'};throws(()=>parseImV2Config(local),'TLS_REQUIRED');
  local.transport.serverUrl='https://example.test:7777/';assert.equal(parseImV2Config(local).enabled,true);
  const missing=config();missing.retention.policy.backupCleanupEnabled=true;
  missing.retention.policyHash=hashRetentionPolicy(missing.retention.policy);
  throws(()=>parseImV2Config(missing),'POLICY_NOT_CONFIGURED');
});

test('canonical base64 accepts real 4 MiB and exact 10 MiB payloads without a regex stack overflow',async t=>{
  // Sequential subtests retain only one large payload at a time; no checked-in blobs.
  for (const size of [4*1024*1024,10*1024*1024]) await t.test(`${size} bytes`,()=>{
    const bytes=Buffer.alloc(size,0xa5),sha256=H(bytes);
    const attachment={name:'large.bin',mime:'application/octet-stream',sha256,dataBase64:bytes.toString('base64')};
    const normalized=c.normalizeMessageRequest({...request(),text:'',attachment});
    assert.equal(normalized.text,'');
    assert.deepEqual(Object.keys(normalized.attachment).sort(),['bytes','mime','name','sha256','size']);
    const {bytes:actual,...metadata}=normalized.attachment;
    assert.deepEqual(metadata,{name:'large.bin',mime:'application/octet-stream',size,sha256});
    assert.ok(actual instanceof Uint8Array);
    assert.equal(Buffer.compare(actual,bytes),0,'every decoded byte matches the supplied payload');
    assert.equal(H(actual),sha256);
  });
  await t.test('10 MiB + 1 returns the public size error, never RangeError',()=>{
    const bytes=Buffer.alloc(10*1024*1024+1,0xa5);
    throws(()=>c.normalizeMessageRequest({...request(),attachment:{name:'large.bin',sha256:H(bytes),
      dataBase64:bytes.toString('base64')}}),'PAYLOAD_TOO_LARGE');
  });
});

test('bounded base64 alphabet, padding, pad bits, whitespace, digest and unknown wire size are isolated',async t=>{
  for (const plain of ['f','fo','foo']) {
    const bytes=Buffer.from(plain);
    const value=c.normalizeMessageRequest({...request(),text:'',attachment:{name:'a',sha256:H(bytes),dataBase64:bytes.toString('base64')}});
    assert.equal(value.attachment.size,bytes.length);
    assert.equal(Buffer.compare(value.attachment.bytes,bytes),0);
  }
  const attachment={name:'a',sha256:H(Buffer.from('f')),dataBase64:'Zg=='};
  for (const [label,dataBase64] of [
    ['alphabet','!g=='],['URL-safe alphabet','_w=='],['missing padding','Zg'],['short padding','Zg='],
    ['extra padding','Zg==='],['interior padding','Z=g='],['nonzero four pad bits','Zh=='],
    ['nonzero two pad bits','Zm9='],['leading whitespace',' Zg=='],['trailing newline','Zg==\n'],
    ['embedded whitespace','Z g=='],['empty payload',''],
  ]) await t.test(label,()=>{
    // Pad-bit cases have the correct digest for the permissively decoded bytes.
    const sha256=H(Buffer.from(dataBase64,'base64'));
    throws(()=>c.normalizeMessageRequest({...request(),attachment:{...attachment,dataBase64,sha256}}),'INVALID_ATTACHMENT',label);
  });
  throws(()=>c.normalizeMessageRequest({...request(),attachment:{...attachment,sha256:'0'.repeat(64)}}),'INVALID_ATTACHMENT');
  // Frozen POST shape derives size from bytes; a caller-declared size is an unknown field.
  throws(()=>c.normalizeMessageRequest({...request(),attachment:{...attachment,size:1}}),'INVALID_ATTACHMENT');
  throws(()=>c.normalizeMessageRequest({...request(),attachment:{...attachment,mime:undefined,extra:1}}),'INVALID_ATTACHMENT');
  throws(()=>c.normalizeMessageRequest({...request(),extra:1}),'INVALID_REQUEST');
});

test('fingerprint accepts complete normalized input only and never silently defaults required fields',async t=>{
  const textOnly=c.normalizeMessageRequest(request());
  const fileOnly=c.normalizeMessageRequest({...request(),text:'',attachment:{name:'a',dataBase64:'YWJj',sha256:H('abc')}});
  assert.deepEqual(Object.keys(textOnly).sort(),['protocol','centerEpoch','originEpoch','clientMessageId','conversationId',
    'recipientAgentId','title','text','attachment','inReplyTo','correlation'].sort());
  assert.deepEqual({title:fileOnly.title,text:fileOnly.text,inReplyTo:fileOnly.inReplyTo,correlation:fileOnly.correlation,
    mime:fileOnly.attachment.mime},{title:null,text:'',inReplyTo:null,correlation:null,mime:null});
  for (const [name,normalized] of [['text',textOnly],['file',fileOnly]]) {
    accepts(c.normalizedMessageSchema,normalized,`${name} complete normalized input`);
    assert.match(c.fingerprintMessage(normalized),/^[0-9a-f]{64}$/);
    for (const field of ['protocol','centerEpoch','originEpoch','clientMessageId','conversationId','recipientAgentId',
      'title','text','attachment','inReplyTo','correlation']) await t.test(`${name}: missing ${field}`,()=>{
      const incomplete={...normalized};delete incomplete[field];
      rejects(c.normalizedMessageSchema,incomplete,`${name} normalized schema requires ${field}`);
      throws(()=>c.fingerprintMessage(incomplete),'INVALID_REQUEST');
      throws(()=>c.fingerprintMessage({...normalized,[field]:undefined}),'INVALID_REQUEST');
    });
  }
  throws(()=>c.fingerprintMessage({...fileOnly,text:null}),'INVALID_REQUEST','file-only text must remain empty string');
  throws(()=>c.fingerprintMessage({...textOnly,text:''}),'INVALID_REQUEST','double-empty normalized operation');
  throws(()=>c.fingerprintMessage({...textOnly,extra:true}),'INVALID_REQUEST');
  for (const field of ['name','mime','size','sha256','bytes']) await t.test(`attachment: missing ${field}`,()=>{
    const attachment={...fileOnly.attachment};delete attachment[field];
    throws(()=>c.fingerprintMessage({...fileOnly,attachment}),'INVALID_REQUEST');
  });
  for (const changed of [{size:2},{size:4},{size:1.5},{size:0},{size:10485761},{sha256:'0'.repeat(64)},
    {sha256:fileOnly.attachment.sha256.toUpperCase()},{bytes:Buffer.from('abd')},{bytes:'abc'},
    {bytes:[97,98,99]},{bytes:null},{extra:1},{dataBase64:'YWJj'}])
    throws(()=>c.fingerprintMessage({...fileOnly,attachment:{...fileOnly.attachment,...changed}}),'INVALID_REQUEST');
  const literal=H(JSON.stringify(['a2a-msg.im.v2',A,C,B,B,null,'',['a',null,3,H('abc')],null,null]));
  assert.equal(c.fingerprintMessage(fileOnly),literal);
  assert.equal(c.fingerprintMessage({...fileOnly,attachment:{...fileOnly.attachment,bytes:new Uint8Array([97,98,99])}}),literal);
  const rich=c.normalizeMessageRequest({...request(),title:'标题',text:'hello 🌍',inReplyTo:C,correlation:'correlation-α',
    attachment:{name:'résumé.txt',mime:'text/plain',sha256:H('abc'),dataBase64:'YWJj'}});
  assert.equal(c.fingerprintMessage(rich),H(JSON.stringify(['a2a-msg.im.v2',A,C,B,B,'标题','hello 🌍',
    ['résumé.txt','text/plain',3,H('abc')],C,'correlation-α'])));
  throws(()=>c.fingerprintMessage({...rich,protocol:'a2a-msg.im.v1'}),'INVALID_REQUEST');
});

test('normalized v2 hash is accepted by the existing P1 validator in a legal isolated database',t=>{
  const f=legacy(t,{attachment:false});const {db}=f;
  const {initialEpoch}=migrateImSchemaV4(db,importOptions());
  const messageId=addMessage(f,{text:'new v2 fixture',title:null});
  const clientMessageId=db.prepare('SELECT client_message_id FROM im_messages WHERE message_id=?').get(messageId).client_message_id;
  const storage=`v2:${initialEpoch}:${clientMessageId}`;
  const literal=H(JSON.stringify(['a2a-msg.im.v2',initialEpoch,f.conversation,f.b,clientMessageId,null,'new v2 fixture',null,null,null]));
  const normalized=c.normalizeMessageRequest({protocol:'a2a-msg.im.v2',centerEpoch:initialEpoch,originEpoch:initialEpoch,
    conversationId:f.conversation,recipientAgentId:f.b,clientMessageId,title:null,text:'new v2 fixture'});
  assert.equal(c.fingerprintMessage(normalized),literal);
  db.prepare('UPDATE im_messages SET client_message_id=? WHERE message_id=?').run(storage,messageId);
  db.prepare('UPDATE im_send_keys SET client_message_id=?,payload_hash=? WHERE message_id=?').run(storage,literal,messageId);
  insert(db,'im_content_state',{message_id:messageId,state:'live',expires_at:7776000100,
    policy_hash:db.prepare('SELECT policy_hash FROM im_schema_preparations').get().policy_hash});
  insert(db,'im_send_operation_keys',{sender_id:f.a,origin_epoch:initialEpoch,client_message_id:clientMessageId,
    storage_client_message_id:storage,source_protocol:'a2a-msg.im.v2',message_id:messageId});
  assert.equal(assertImSchemaV4(db),true);
  db.prepare('UPDATE im_send_keys SET payload_hash=? WHERE message_id=?').run('0'.repeat(64),messageId);
  assert.throws(()=>assertImSchemaV4(db),{code:'IM_SCHEMA_MISMATCH'},'validator actually checks the persisted v2 hash');
});

test('success envelope requires serializable data; endpoint payloads retain strict exact shapes',async t=>{
  const envelope={protocol:c.PROTOCOL,centerEpoch:A,data:null};
  accepts(c.successEnvelopeSchema,envelope,'generic envelope permits explicit null');
  const missing={...envelope};delete missing.data;
  rejects(c.successEnvelopeSchema,missing,'missing mandatory data');
  rejects(c.successEnvelopeSchema,{...envelope,data:undefined},'undefined data disappears on JSON serialization');
  rejects(c.successEnvelopeSchema,{...envelope,extra:1},'unknown envelope key');
  const fixtures={
    me:{agentId:A,instanceId:B,centerEpoch:A,recoveryCounter:0,state:'active'},
    contacts:page([{peerAgentId:B,displayName:'Bob'}]),
    conversations:page([{conversationId:C,peerAgentId:B,createdAt:0}]),
    conversation:{conversationId:C,peerAgentId:B,createdAt:0},
    send:{message:message(),replayed:false},
    sendResult:{originEpoch:A,clientMessageId:B,messageId:C,acceptedAt:1,payloadHash:H('payload'),
      sourceProtocol:'a2a-msg.im.v2',contentState:'live',retryUntil:604800001},
    history:page([historyItem(),expiredItem()]),message:message(),
    read:{messageId:A,readAt:1,changed:true},
    lease:{centerEpoch:A,instanceId:B,generation:1,expiresAt:100,historical:false,streamEpoch:C},
    renew:{centerEpoch:A,instanceId:B,generation:1,expiresAt:100,streamEpoch:C},
    release:{instanceId:B,generation:1,released:true},sync:syncPage([syncItem(1)]),
    acks:progress(),expiryReceipts:progress(),
  };
  for (const [name,data] of Object.entries(fixtures)) await t.test(name,()=>{
    const schema=c.dataSchemas[name];
    accepts(schema,data,`${name} baseline`);
    accepts(c.successEnvelopeSchema,{...envelope,data},`${name} envelope`);
    accepts(schema,JSON.parse(JSON.stringify(data)),`${name} JSON roundtrip`);
    rejects(schema,{...data,extra:1},`${name} unknown field`);
    rejects(schema,null,`${name} endpoint data is an object`);
    for (const key of Object.keys(data)) {
      const incomplete={...data};delete incomplete[key];
      rejects(schema,incomplete,`${name} missing ${key}`);
    }
  });
  rejects(c.dataSchemas.send,{...fixtures.send,message:{...message(),extra:1}},'nested message strictness');
  rejects(c.dataSchemas.me,{...fixtures.me,recoveryCounter:0.5},'one malformed endpoint field');
  const attachment={attachmentId:C,name:'a',mime:null,size:3,sha256:H('abc')};
  accepts(c.attachmentSchema,attachment,'exact live attachment baseline');
  accepts(c.messageSchema,{...message(),text:'',attachment},'live attachment-only message');
  rejects(c.attachmentSchema,{...attachment,bytes:Buffer.from('abc')},'wire metadata excludes bytes');
  rejects(c.attachmentSchema,{...attachment,size:0},'wire attachment size lower bound');
  rejects(c.messageSchema,{...message(),text:''},'double-empty wire response');
});

test('response lists reject duplicate identities, including message/tombstone collisions',async t=>{
  const cases=[
    ['contacts',c.dataSchemas.contacts,page([{peerAgentId:A,displayName:'Alice'},{peerAgentId:B,displayName:'Bob'}]),
      page([{peerAgentId:A,displayName:'Alice'},{peerAgentId:A,displayName:'Renamed'}])],
    ['conversations',c.dataSchemas.conversations,page([{conversationId:A,peerAgentId:B,createdAt:0},{conversationId:B,peerAgentId:C,createdAt:1}]),
      page([{conversationId:A,peerAgentId:B,createdAt:0},{conversationId:A,peerAgentId:C,createdAt:1}])],
    ['history mixed kinds',c.dataSchemas.history,page([historyItem(A),expiredItem(B)]),page([historyItem(A),expiredItem(A)])],
    ['history live',c.dataSchemas.history,page([historyItem(A),historyItem(B)]),page([historyItem(A),{kind:'message',message:{...message(A),text:'changed'}}])],
    ['history tombstones',c.dataSchemas.history,page([expiredItem(A),expiredItem(B)]),page([expiredItem(A),{kind:'content_expired',tombstone:{...tombstone(A),expiredAt:7776000002}}])],
    ['sync seq',c.dataSchemas.sync,syncPage([syncItem(1,A),syncItem(2,B)]),syncPage([syncItem(1,A),syncItem(1,B)])],
    ['sync message',c.dataSchemas.sync,syncPage([syncItem(1,A),syncItem(2,B)]),syncPage([syncItem(1,A),syncItem(2,A)])],
    ['sync mixed kinds',c.dataSchemas.sync,syncPage([syncItem(1,A),{centerEpoch:A,streamEpoch:B,seq:2,...expiredItem(B)}]),
      syncPage([syncItem(1,A),{centerEpoch:A,streamEpoch:B,seq:2,...expiredItem(A)}])],
  ];
  for (const [name,schema,valid,invalid] of cases) await t.test(name,()=>{
    accepts(schema,valid,`${name} distinct baseline`);
    accepts(schema,{...valid,items:[]},`${name} empty response`);
    rejects(schema,invalid,`${name} identity collision with distinct payloads`);
    rejects(schema,{...valid,items:[valid.items[0],valid.items[0]]},`${name} exact duplicate`);
  });
});

test('response and receipt batches allow exactly 100 distinct items and reject 101',async t=>{
  const cases=[
    ['contacts',c.dataSchemas.contacts,n=>page(Array.from({length:n},(_,i)=>({peerAgentId:id(i),displayName:'peer'})))],
    ['conversations',c.dataSchemas.conversations,n=>page(Array.from({length:n},(_,i)=>({conversationId:id(i),peerAgentId:B,createdAt:i})))],
    ['history',c.dataSchemas.history,n=>page(Array.from({length:n},(_,i)=>i%2 ? expiredItem(id(i)) : historyItem(id(i))))],
    ['sync',c.dataSchemas.sync,n=>syncPage(Array.from({length:n},(_,i)=>syncItem(i+1)))],
    ['acks',c.postSchemas.acks,n=>ack(Array.from({length:n},(_,i)=>({seq:i+1,messageId:id(i)})))],
    ['expiryReceipts',c.postSchemas.expiryReceipts,n=>ack(Array.from({length:n},(_,i)=>({seq:i+1,messageId:id(i)})))],
  ];
  for (const [name,schema,build] of cases) await t.test(name,()=>{
    accepts(schema,build(100),`${name} 100 distinct items`);
    rejects(schema,build(101),`${name} 101 distinct items`);
  });
  for (const name of ['acks','expiryReceipts']) {
    const schema=c.postSchemas[name],item={seq:1,messageId:A};
    accepts(schema,ack([item]),`${name} exact valid Scope/Fence/body`);
    rejects(schema,ack([]),`${name} empty items only`);
    rejects(schema,ack([item,{...item}]),`${name} duplicate items only`);
  }
});

test('cursor decoding independently checks intrinsic scope, canonical bytes and route bindings',async t=>{
  for (const kind of ['contacts','conversations','history']) await t.test(kind,()=>{
    const expected={kind,centerEpoch:A,agentId:B,scope:kind==='history' ? C : B};
    const key=kind==='history' ? [10,A] : C;
    const tuple=[2,kind,A,B,expected.scope,key],encoded=cursorTuple(tuple);
    assert.equal(c.encodeCursor(kind,A,B,expected.scope,key),encoded,'frozen literal cursor bytes');
    assert.deepEqual(c.decodeCursor(encoded,expected),key);
    throws(()=>c.decodeCursor(encoded,{...expected,centerEpoch:C}),'RECOVERY_RECONCILIATION_REQUIRED');
    throws(()=>c.decodeCursor(encoded,{...expected,agentId:A}),'INVALID_REQUEST');
    throws(()=>c.decodeCursor(encoded,{...expected,scope:A}),'INVALID_REQUEST');
    throws(()=>c.decodeCursor(encoded,{...expected,kind:kind==='history' ? 'contacts' : 'history'}),'INVALID_REQUEST');
    if (kind!=='history') {
      const malformed=cursorTuple([2,kind,A,B,C,key]);
      throws(()=>c.decodeCursor(malformed,{...expected,scope:C}),'INVALID_REQUEST','wrong tuple scope is invalid even when expected repeats it');
    }
    for (const malformed of [cursorTuple(tuple.slice(0,-1)),cursorTuple([...tuple,'extra']),
      cursorTuple([3,...tuple.slice(1)]),cursorTuple([2,kind,A.toUpperCase(),B,expected.scope,key]),
      cursorTuple([2,kind,A,B,expected.scope,kind==='history' ? A : [10,A]]),
      encoded+'=',encoded+'!',encoded+'\n','!!!!','eA','a'.repeat(1025),'',
      Buffer.from(JSON.stringify(tuple,null,1)).toString('base64url')])
      throws(()=>c.decodeCursor(malformed,expected),'INVALID_REQUEST');
  });
  const expected={kind:'history',centerEpoch:A,agentId:B,scope:C};
  for (const key of [[-1,A],[0.5,A],[Number.MAX_SAFE_INTEGER+1,A],[1,A,'extra']])
    throws(()=>c.decodeCursor(cursorTuple([2,'history',A,B,C,key]),expected),'INVALID_REQUEST');
});

test('pagination after remains an opaque canonical cursor and is decoded against its expected scope',()=>{
  const encoded=cursorTuple([2,'history',A,B,C,[10,A]]);
  const parsed=c.parseQuery([['after',encoded]],{allowed:['after','limit']});
  assert.equal(parsed.after,encoded);
  assert.equal(parsed.limit,'20');
  assert.deepEqual(c.decodeCursor(parsed.after,{kind:'history',centerEpoch:A,agentId:B,scope:C}),[10,A]);
  throws(()=>c.decodeCursor(parsed.after,{kind:'history',centerEpoch:A,agentId:B,scope:B}),'INVALID_REQUEST');
  for (const limit of ['0','101','-1','1.5','1e1',' 1','01','9007199254740992'])
    throws(()=>c.parseQuery([['limit',limit]],{allowed:['after','limit']}),'INVALID_REQUEST');
  assert.equal(c.parseQuery([['limit','100']],{allowed:['after','limit']}).limit,'100');
});

test('parseSyncQuery enforces route-specific canonical safe-integer syntax independently of runtime watermarks',async t=>{
  assert.equal(typeof c.parseSyncQuery,'function','agreed public route-specific parser must be exported');
  const base=[['streamEpoch',B]];
  // Syntax and normalized query output only; watermark checks require runtime state.
  const defaults=c.parseSyncQuery(base);
  assert.equal(defaults.streamEpoch,B);
  assert.equal(defaults.limit,'20');
  assert.equal(Object.hasOwn(defaults,'after'),false,'runtime supplies handledThrough when after is absent');
  for (const after of ['0','1','9007199254740991']) await t.test(`valid after=${after}`,()=>{
    assert.equal(c.parseSyncQuery([...base,['after',after]]).after,after,'canonical after remains a string');
  });
  for (const after of ['-1','-0','0.5','1.0','1e2','1E2','9007199254740992','999999999999999999999',
    ' 1','1 ','1\n','\t1','+1','01','00','','NaN','Infinity','0x10']) await t.test(`invalid after=${JSON.stringify(after)}`,()=>{
    throws(()=>c.parseSyncQuery([...base,['after',after]]),'INVALID_REQUEST');
  });
  for (const [label,entries] of [
    ['missing required streamEpoch',[]],
    ['malformed streamEpoch',[['streamEpoch','invalid']]],
    ['noncanonical streamEpoch',[['streamEpoch',B.toUpperCase()]]],
    ['duplicate streamEpoch',[...base,['streamEpoch',B]]],
    ['duplicate after',[...base,['after','0'],['after','0']]],
    ['duplicate limit',[...base,['limit','20'],['limit','20']]],
    ['unknown query',[...base,['extra','1']]],
    ['opaque cursor in numeric sync after',[...base,['after',cursorTuple([2,'history',A,B,C,[10,A]])]]],
  ]) await t.test(label,()=>throws(()=>c.parseSyncQuery(entries),'INVALID_REQUEST'));
  for (const limit of ['1','100'])
    assert.equal(c.parseSyncQuery([...base,['limit',limit]]).limit,limit);
  for (const limit of ['0','101','-1','1.5','1e1',' 1','01','9007199254740992'])
    throws(()=>c.parseSyncQuery([...base,['limit',limit]]),'INVALID_REQUEST');
});
