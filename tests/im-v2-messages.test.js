import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createCoreFixture, seedMessage, expireFixtureContent } from './fixtures/im-v2-core/helpers.js';
import { database, freshOptions, insert, recoveryRow, bindRun, putPolicy } from './fixtures/im-v2-schema/helpers.js';
import { createImV2Messages } from '../src/im/v2/messages.js';
import { PROTOCOL } from '../src/im/v2/contracts.js';
import { initializeImSchemaV4 } from '../src/im/v2/migration.js';
import { DEFAULT_POLICY, DEFAULT_MAINTENANCE } from '../src/im/v2/config.js';
import { createImV2Auth } from '../src/im/v2/auth.js';
import { createImV2Acl } from '../src/im/v2/acl.js';

const make = f => createImV2Messages(f);
const count = (f, table) => f.native.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const error = (code, fn) => assert.throws(fn, e => e.code === code);
const request = (f, changes = {}) => ({originEpoch:f.centerEpoch,clientMessageId:randomUUID(),
  conversationId:f.conversationId,recipientAgentId:f.b,text:'hello',...changes});

test('factory binding, strict arguments, contacts and conversations', t => {
  const f = createCoreFixture(t), m = make(f), a = f.principals[0];
  error('INVALID_REQUEST', () => createImV2Messages({...f,auth:{...f.auth}}));
  error('INVALID_REQUEST', () => createImV2Messages({...f,timeGuard:{current(){return 103;}}}));
  error('INVALID_REQUEST', () => m.getMessage(a,f.scope,{messageId:randomUUID(),protocol:PROTOCOL}));
  error('INVALID_REQUEST', () => m.send(a,f.scope,{...request(f),protocol:PROTOCOL}));
  assert.equal(m.listContacts(a,f.scope,{}).items[0].peerAgentId,f.b);
  assert.equal(m.listConversations(a,f.scope,{}).items[0].conversationId,f.conversationId);
  assert.equal(m.ensureConversation(a,f.scope,{peerAgentId:f.b}).conversationId,f.conversationId);
  error('RESOURCE_NOT_FOUND', () => m.ensureConversation(a,f.scope,{peerAgentId:f.outsider}));
});

test('send replay and conflict, retained known origin, unknown origin, expiry and capacity', t => {
  const f = createCoreFixture(t), m = make(f), a = f.principals[0], r = request(f);
  const first = m.send(a,f.scope,r);
  assert.equal(first.replayed,false);
  assert.equal(first.message.clientMessageId,r.clientMessageId);
  assert.equal(m.send(a,f.scope,r).replayed,true);
  error('IDEMPOTENCY_CONFLICT', () => m.send(a,f.scope,{...r,text:'different'}));
  assert.equal(count(f,'im_messages'),1);
  const old = seedMessage(f,{protocol:'a2a-msg.im.v1'});
  const oldResult = m.getSendResult(a,f.scope,{originEpoch:old.originEpoch,clientMessageId:old.clientMessageId});
  assert.equal(oldResult.sourceProtocol,'a2a-msg.im.v1');
  assert.equal(oldResult.messageId,old.messageId);
  error('SEND_OUTCOME_UNKNOWN', () => m.getSendResult(a,f.scope,{originEpoch:randomUUID(),clientMessageId:randomUUID()}));
  error('RESOURCE_NOT_FOUND', () => m.getSendResult(a,f.scope,{originEpoch:f.centerEpoch,clientMessageId:randomUUID()}));
  error('RECOVERY_RECONCILIATION_REQUIRED', () => m.send(a,f.scope,request(f,{originEpoch:old.originEpoch})));
  expireFixtureContent(f,old);
  assert.equal(m.getSendResult(a,f.scope,{originEpoch:old.originEpoch,clientMessageId:old.clientMessageId}).contentState,'expired');
  f.native.prepare('UPDATE im_send_keys SET retry_until=? WHERE message_id=?').run(103,first.message.messageId);
  error('IDEMPOTENCY_WINDOW_EXPIRED', () => m.send(a,f.scope,r));
  const policy = structuredClone(f.policy);
  policy.maintenance.maxKeyReservations = 2;
  const capped = createImV2Messages({...f,policy});
  assert.equal(capped.getSendResult(a,f.scope,{originEpoch:r.originEpoch,clientMessageId:r.clientMessageId}).messageId,first.message.messageId);
  error('CAPACITY_EXHAUSTED', () => capped.send(a,f.scope,request(f)));
});

test('history tombstone retains order; ACL revocation hides expired content', t => {
  const f = createCoreFixture(t), m = make(f), a = f.principals[0];
  const seeds = [seedMessage(f),seedMessage(f),seedMessage(f)].sort((a,b)=>a.messageId.localeCompare(b.messageId));
  const [x,y,z] = seeds;
  expireFixtureContent(f,y,{scrub:true});
  const page = m.listHistory(a,f.scope,{conversationId:f.conversationId,limit:2});
  assert.deepEqual(page.items.map(item=>item.kind),['message','content_expired']);
  assert.equal(m.listHistory(a,f.scope,{conversationId:f.conversationId,after:page.nextCursor}).items[0].message.messageId,z.messageId);
  error('CONTENT_EXPIRED', () => m.getMessage(a,f.scope,{messageId:y.messageId}));
  f.native.prepare('UPDATE im_contacts SET allowed=0').run();
  error('RESOURCE_NOT_FOUND', () => m.getMessage(a,f.scope,{messageId:y.messageId}));
  error('RESOURCE_NOT_FOUND', () => m.listHistory(a,f.scope,{conversationId:f.conversationId}));
});

test('read recipient ACK only, repeat unchanged; attachment integrity and hidden expiry', t => {
  const f = createCoreFixture(t), m = make(f), a = f.principals[0], b = f.principals[1];
  const delivered = seedMessage(f,{attachment:true,deliveredAt:11});
  const undelivered = seedMessage(f);
  error('DELIVERY_REQUIRED',()=>m.markRead(b,f.scope,{messageId:undelivered.messageId}));
  error('RESOURCE_NOT_FOUND',()=>m.markRead(a,f.scope,{messageId:delivered.messageId}));
  const before = count(f,'im_audit'), first = m.markRead(b,f.scope,{messageId:delivered.messageId});
  assert.equal(first.changed,true);
  assert.deepEqual(m.markRead(b,f.scope,{messageId:delivered.messageId}),{...first,changed:false});
  assert.equal(count(f,'im_audit'),before+1);
  assert.deepEqual(m.getAttachment(a,f.scope,{attachmentId:delivered.attachmentId}).data,delivered.bytes);
  f.native.prepare('UPDATE im_attachments SET data=?,sha256=? WHERE attachment_id=?').run(
    Buffer.alloc(delivered.bytes.length),createHash('sha256').update(Buffer.alloc(delivered.bytes.length)).digest('hex'),delivered.attachmentId);
  error('STORAGE_UNAVAILABLE',()=>m.getAttachment(a,f.scope,{attachmentId:delivered.attachmentId}));
  f.native.prepare('UPDATE im_attachments SET data=?,sha256=? WHERE attachment_id=?').run(
    delivered.bytes,delivered.sha256,delivered.attachmentId);
  expireFixtureContent(f,delivered);
  error('CONTENT_EXPIRED',()=>m.getAttachment(a,f.scope,{attachmentId:delivered.attachmentId}));
});

test('write fault rolls back message, BLOB, key, mapping, content, delivery and audit', t => {
  let fault = false;
  const f = createCoreFixture(t,{onStatement: ({sql,method}) => { if (fault && method === 'run' && sql.includes('INSERT INTO im_send_operation_keys')) throw Error('injected'); }});
  const m = make(f), before = ['im_messages','im_attachments','im_attachment_reservations','im_send_keys',
    'im_send_operation_keys','im_content_state','im_deliveries','im_audit'].map(table=>count(f,table));
  const bytes = Buffer.from('attachment');
  fault = true;
  error('STORAGE_UNAVAILABLE',()=>m.send(f.principals[0],f.scope,request(f,{attachment:{name:'a.txt',
    sha256:createHash('sha256').update(bytes).digest('hex'),dataBase64:bytes.toString('base64')}})));
  assert.deepEqual(['im_messages','im_attachments','im_attachment_reservations','im_send_keys',
    'im_send_operation_keys','im_content_state','im_deliveries','im_audit'].map(table=>count(f,table)),before);
});

test('attachment send, replay, immutable captured payload and exact retry deadline', t => {
  const f = createCoreFixture(t), m = make(f), bytes = Buffer.from('safe attachment');
  const r = request(f,{text:'',attachment:{name:'safe.txt',mime:'text/plain',
    sha256:createHash('sha256').update(bytes).digest('hex'),dataBase64:bytes.toString('base64')}});
  const sent = m.send(f.principals[0],f.scope,r);
  assert.equal(sent.message.attachment.size,bytes.length);
  assert.deepEqual(m.getAttachment(f.principals[1],f.scope,{attachmentId:sent.message.attachment.attachmentId}).data,bytes);
  const retry = m.send(f.principals[0],f.scope,r);
  assert.equal(retry.replayed,true);
  assert.equal(retry.message.messageId,sent.message.messageId);
  f.native.prepare('UPDATE im_send_keys SET retry_until=? WHERE message_id=?').run(103,sent.message.messageId);
  error('IDEMPOTENCY_WINDOW_EXPIRED',()=>m.send(f.principals[0],f.scope,r));
});

test('reply requires live same conversation and sender may not mark recipient read', t => {
  const f = createCoreFixture(t), m = make(f), a = f.principals[0];
  const parent = seedMessage(f);
  const reply = m.send(a,f.scope,request(f,{inReplyTo:parent.messageId}));
  assert.equal(reply.message.inReplyTo,parent.messageId);
  expireFixtureContent(f,parent);
  error('CONTENT_EXPIRED',()=>m.send(a,f.scope,request(f,{inReplyTo:parent.messageId})));
  error('RESOURCE_NOT_FOUND',()=>m.send(a,f.scope,request(f,{inReplyTo:randomUUID()})));
});

test('mutating caller input during transactional callbacks cannot change captured send or scope', t => {
  let input, scope, mutate = false;
  const f = createCoreFixture(t,{onStatement: ({sql,method}) => {
    if (mutate && method === 'get' && sql.includes('im_send_operation_keys')) {
      mutate = false;
      input.text = 'changed after snapshot';
      input.attachment.dataBase64 = Buffer.from('tamper').toString('base64');
      scope.centerEpoch = randomUUID();
    }
  }});
  const m = make(f), bytes = Buffer.from('captured');
  input = request(f,{attachment:{name:'capture.txt',sha256:createHash('sha256').update(bytes).digest('hex'),
    dataBase64:bytes.toString('base64')}});
  scope = {...f.scope};
  mutate = true;
  const sent = m.send(f.principals[0],scope,input);
  assert.equal(sent.message.text,'hello');
  assert.deepEqual(m.getAttachment(f.principals[0],f.scope,{attachmentId:sent.message.attachment.attachmentId}).data,bytes);
});

test('history cursor uses composite indexed seek, pages equal timestamps with tombstones exactly once', t => {
  const f = createCoreFixture(t), m = make(f), a = f.principals[0];
  const seeds = Array.from({length:9},()=>seedMessage(f)).sort((x,y)=>x.messageId.localeCompare(y.messageId));
  for (const index of [1,4,7]) expireFixtureContent(f,seeds[index],{scrub:index===4});
  const plan = f.native.prepare(`EXPLAIN QUERY PLAN SELECT message_id,accepted_at FROM im_messages
    WHERE conversation_id=? AND (accepted_at,message_id)>(?,?)
    ORDER BY accepted_at,message_id LIMIT ?`).all(f.conversationId,10,seeds[3].messageId,3);
  assert.ok(plan.some(row => /SEARCH im_messages USING COVERING INDEX im_messages_conversation.*accepted_at/.test(row.detail)),
    JSON.stringify(plan));
  const actual = [], kinds = [], cursors = new Set();
  let after;
  do {
    const page = m.listHistory(a,f.scope,{conversationId:f.conversationId,limit:2,...(after?{after}:{})});
    assert.ok(page.items.length<=2);
    for (const item of page.items) {
      actual.push(item.kind==='message'?item.message.messageId:item.tombstone.messageId);
      kinds.push(item.kind);
    }
    after = page.nextCursor;
    if (after) { assert.ok(!cursors.has(after)); cursors.add(after); }
  } while (after);
  assert.deepEqual(actual,seeds.map(seed=>seed.messageId));
  assert.deepEqual(kinds.filter(kind=>kind==='content_expired').length,3);
});

test('missing v2 operation mapping with retained canonical key is corruption, never absent or resent', t => {
  const f = createCoreFixture(t), m = make(f), a = f.principals[0], outsider = f.principals[2], r = request(f);
  const sent = m.send(a,f.scope,r), before = ['im_messages','im_send_keys','im_audit'].map(table=>count(f,table));
  assert.equal(f.native.prepare('DELETE FROM im_send_operation_keys WHERE message_id=?').run(sent.message.messageId).changes,1);
  error('STORAGE_UNAVAILABLE',()=>m.getSendResult(a,f.scope,{originEpoch:r.originEpoch,clientMessageId:r.clientMessageId}));
  error('STORAGE_UNAVAILABLE',()=>m.send(a,f.scope,r));
  assert.deepEqual(['im_messages','im_send_keys','im_audit'].map(table=>count(f,table)),before);
  error('RESOURCE_NOT_FOUND',()=>m.getSendResult(outsider,f.scope,{originEpoch:r.originEpoch,clientMessageId:r.clientMessageId}));
  f.native.prepare('UPDATE im_contacts SET allowed=0').run();
  error('RESOURCE_NOT_FOUND',()=>m.send(a,f.scope,r));
  assert.deepEqual(['im_messages','im_send_keys','im_audit'].map(table=>count(f,table)),before);
});

test('existing send orders ACL, conflict, retry deadline, then early expired content', t => {
  const f = createCoreFixture(t), m = make(f), a = f.principals[0], r = request(f);
  const sent = m.send(a,f.scope,r);
  const countBefore = ['im_messages','im_send_keys','im_audit'].map(table=>count(f,table));
  expireFixtureContent(f,{messageId:sent.message.messageId,expiresAt:sent.message.expiresAt});
  const op = {originEpoch:r.originEpoch,clientMessageId:r.clientMessageId};
  assert.equal(m.getSendResult(a,f.scope,op).contentState,'expired');
  error('CONTENT_EXPIRED',()=>m.send(a,f.scope,r)); // fixture expiry before 7-day window; not elapsed 90-day maintenance
  error('IDEMPOTENCY_CONFLICT',()=>m.send(a,f.scope,{...r,text:'different'}));
  f.native.prepare('UPDATE im_send_keys SET retry_until=? WHERE message_id=?').run(103,sent.message.messageId);
  error('IDEMPOTENCY_CONFLICT',()=>m.send(a,f.scope,{...r,text:'different'}));
  error('IDEMPOTENCY_WINDOW_EXPIRED',()=>m.send(a,f.scope,r));
  f.native.prepare('UPDATE im_contacts SET allowed=0').run();
  error('RESOURCE_NOT_FOUND',()=>m.send(a,f.scope,{...r,text:'different'}));
  assert.deepEqual(['im_messages','im_send_keys','im_audit'].map(table=>count(f,table)),countBefore);
});

test('attachment stored wire-invalid metadata fails closed after authorization before BLOB read', t => {
  let blobReads=0;
  const f = createCoreFixture(t,{onStatement:({sql,method})=>{
    if (method==='get' && sql.includes('SELECT data FROM im_attachments')) blobReads++;
  }}), m = make(f), seed = seedMessage(f,{attachment:true});
  const args = {attachmentId:seed.attachmentId};
  const corruptions = [
    ['name','../bad','test.txt'],
    ['mime','x'.repeat(101),'text/plain'],
    // SQLite rejects non-hex hashes by CHECK; a different canonical digest is
    // the native-valid corruption scenario (ACL checks reservation equality).
    ['sha256','a'.repeat(64)===seed.sha256?'b'.repeat(64):'a'.repeat(64),seed.sha256],
  ];
  for (const [column,bad,original] of corruptions) {
    f.native.prepare(`UPDATE im_attachments SET ${column}=? WHERE attachment_id=?`).run(bad,seed.attachmentId);
    const before = blobReads;
    error('STORAGE_UNAVAILABLE',()=>m.getAttachment(f.principals[0],f.scope,args));
    assert.equal(blobReads,before);
    error('RESOURCE_NOT_FOUND',()=>m.getAttachment(f.principals[2],f.scope,args));
    assert.equal(blobReads,before);
    f.native.prepare(`UPDATE im_attachments SET ${column}=? WHERE attachment_id=?`).run(original,seed.attachmentId);
  }
  const alternateId = randomUUID(), before = blobReads;
  f.native.prepare('UPDATE im_attachments SET attachment_id=? WHERE attachment_id=?').run(alternateId,seed.attachmentId);
  error('STORAGE_UNAVAILABLE',()=>m.getAttachment(f.principals[0],f.scope,args));
  error('RESOURCE_NOT_FOUND',()=>m.getAttachment(f.principals[2],f.scope,args));
  assert.equal(blobReads,before);
  f.native.prepare('UPDATE im_attachments SET attachment_id=? WHERE attachment_id=?').run(seed.attachmentId,alternateId);
  assert.deepEqual(m.getAttachment(f.principals[0],f.scope,args).data,seed.bytes);
  assert.equal(blobReads,1);
});

// Test-only lawful active candidate with a mutable clock bound BEFORE the first
// canonical guard is constructed. The shared core fixture intentionally fixes
// its clock at 103 and cannot be re-clocked on its already-bound DB.
function elapsedClockFixture(t) {
  const native = database(t);
  native.exec('PRAGMA synchronous=FULL');
  initializeImSchemaV4(native,freshOptions());
  const retention = {...DEFAULT_POLICY,effectiveAt:1};
  const hash = putPolicy(native,retention);
  const recovery = recoveryRow(native,'fresh_bootstrap',{status:'active',verified_at:101,
    activated_at:102,activation_ref:'test-activation',auth_review_ref:'test-auth-review',
    activation_plan_hash:'a'.repeat(64),activation_approval_ref:'test-activation-approval'});
  bindRun(native,recovery);
  native.prepare("UPDATE im_settings SET write_mode='enabled'").run();
  const centerEpoch = recovery.new_epoch, scope = {protocol:PROTOCOL,centerEpoch};
  const a = randomUUID(), b = randomUUID(), [low,high] = [a,b].sort();
  for (const [agentId,displayName] of [[a,'Alice'],[b,'Bob']]) {
    insert(native,'im_agents',{agent_id:agentId,display_name:displayName,status:'active',created_at:0,revoked_at:null});
    const streamEpoch = randomUUID();
    insert(native,'im_receive_state',{agent_id:agentId,next_seq:1,acked_through:0,retained_floor:1,stream_epoch:streamEpoch});
    insert(native,'im_sync_progress',{recipient_id:agentId,center_epoch:centerEpoch,stream_epoch:streamEpoch,
      handled_through:0,updated_at:0});
  }
  insert(native,'im_contacts',{agent_low:low,agent_high:high,allowed:1,version:1,updated_at:0});
  const conversationId = randomUUID();
  insert(native,'im_conversations',{conversation_id:conversationId,agent_low:low,agent_high:high,created_at:0});
  const credentialId = randomUUID(), secret = randomBytes(32).toString('base64url');
  insert(native,'im_credentials',{credential_id:credentialId,agent_id:a,
    secret_hash:createHash('sha256').update(secret).digest('hex'),created_at:0,expires_at:null,revoked_at:null});
  const policy = {enabled:true,writeMode:'enabled',transport:{mode:'local-test',serverUrl:'http://localhost/'},
    retention:{policy:retention,policyHash:hash},lease:{ttlMs:1000,renewalMs:500},
    limits:{maxAttachmentBytes:10485760,maxBodyBytes:65536,maxFileBodyBytes:16777216,
      maxConnections:10,maxRequestsPerMinute:100},
    maintenance:{...DEFAULT_MAINTENANCE,maxKeyReservations:1000}};
  let now = 103;
  const clock = () => now;
  const auth = createImV2Auth({db:native,policy,clock});
  const acl = createImV2Acl({db:native,auth,clock});
  const principal = auth.authenticate(`${credentialId}.${secret}`);
  return {native,db:native,scope,auth,acl,policy,clock,principal,a,b,conversationId,centerEpoch,hash,
    advance(value) { now = value; }};
}

test('90-day elapsed fixture expiry retains accepted fact, while 7-day retry window rejects replay', t => {
  const f = elapsedClockFixture(t), m = make(f), r = request(f);
  const sent = m.send(f.principal,f.scope,r);
  const original = m.getSendResult(f.principal,f.scope,{originEpoch:r.originEpoch,clientMessageId:r.clientMessageId});
  assert.equal(original.messageId,sent.message.messageId);
  assert.equal(original.acceptedAt,sent.message.acceptedAt);
  assert.equal(original.contentState,'live');
  const before = ['im_messages','im_send_keys','im_send_operation_keys'].map(table=>count(f,table));
  const acceptedAudits = () => f.native.prepare("SELECT count(*) AS n FROM im_audit WHERE action='message.accepted'").get().n;
  const audits = acceptedAudits();
  const elapsedAt = sent.message.expiresAt + 1;
  assert.ok(Number.isSafeInteger(elapsedAt));
  assert.ok(elapsedAt >= sent.message.acceptedAt + f.policy.retention.policy.messageRetentionMs);
  assert.ok(elapsedAt > original.retryUntil);
  f.advance(elapsedAt);
  // Fixture-only expiry proof, not an assertion about the P6 maintenance executor.
  expireFixtureContent(f,{messageId:sent.message.messageId,expiresAt:sent.message.expiresAt});
  error('IDEMPOTENCY_WINDOW_EXPIRED',()=>m.send(f.principal,f.scope,r));
  error('IDEMPOTENCY_CONFLICT',()=>m.send(f.principal,f.scope,{...r,text:'different'}));
  assert.deepEqual(m.getSendResult(f.principal,f.scope,{originEpoch:r.originEpoch,clientMessageId:r.clientMessageId}),
    {...original,contentState:'expired'});
  assert.deepEqual(['im_messages','im_send_keys','im_send_operation_keys'].map(table=>count(f,table)),before);
  assert.equal(acceptedAudits(),audits);
});
