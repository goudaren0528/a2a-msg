import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCoreFixture, seedMessage, expireFixtureContent } from './fixtures/im-v2-core/helpers.js';
import { createImV2Delivery } from '../src/im/v2/delivery.js';
import { createImV2Auth } from '../src/im/v2/auth.js';
import { createImV2Acl } from '../src/im/v2/acl.js';
import { observe } from './fixtures/im-v2-schema/helpers.js';
import { dataSchemas, PROTOCOL, storageOperationKey, fingerprintMessage } from '../src/im/v2/contracts.js';

const error = code => e => e?.code === code;
const create = (f, clock = f.clock) => createImV2Delivery({ db:f.db, auth:f.auth, acl:f.acl, policy:f.policy, clock });
const stream = f => f.native.prepare('SELECT stream_epoch FROM im_receive_state WHERE agent_id=?').get(f.b).stream_epoch;
const fence = lease => ({ instanceId:lease.instanceId, generation:lease.generation });
const leased = (d, f, p) => d.acquire(p,f.scope,{instanceId:randomUUID(),requestId:randomUUID()});
const snapshot = f => ({ clock:f.native.prepare('SELECT last_observed_at AS n FROM im_clock').get().n,
  lease:f.native.prepare('SELECT instance_id,generation,expires_at FROM im_receiver_leases WHERE agent_id=?').get(f.b),
  ack:f.native.prepare('SELECT seq,acked_at FROM im_deliveries WHERE recipient_id=? ORDER BY seq').all(f.b),
  receipts:f.native.prepare('SELECT seq,message_id,recorded_at FROM im_expiry_receipts WHERE recipient_id=? ORDER BY seq').all(f.b),
  requests:f.native.prepare('SELECT request_id FROM im_lease_requests WHERE agent_id=? ORDER BY request_id').all(f.b),
  audits:f.native.prepare('SELECT action,occurred_at FROM im_audit ORDER BY rowid').all(),
  state:f.native.prepare('SELECT acked_through FROM im_receive_state WHERE agent_id=?').get(f.b),
  progress:f.native.prepare('SELECT handled_through FROM im_sync_progress WHERE recipient_id=?').get(f.b) });
function controlled(t) {
  let now=103, trigger=null, final=false, observerFailure=null;
  let writes=[];
  const f=createCoreFixture(t);
  const db=observe(f.native,({sql,method,result}) => {
    if (trigger && method==='run') writes.push(sql);
    if (trigger && method==='get' && /SELECT instance_id,generation,expires_at,credential_id FROM im_receiver_leases/.test(sql)) {
      try { if (trigger({sql,result,writes:[...writes]})) { final=true; trigger=null; } }
      catch (failure) { observerFailure=failure; throw failure; }
    }
  });
  const clock=()=>now, auth=createImV2Auth({db,policy:f.policy,clock});
  const acl=createImV2Acl({db,auth,clock});
  const d=createImV2Delivery({db,auth,acl,policy:f.policy,clock});
  return {f,d,p:auth.authenticate(f.credentials[1]),setNow:v=>{now=v;},
    onLease:callback=>{trigger=callback; final=false; observerFailure=null; writes=[];},
    didTrigger:()=>final, observerFailure:()=>observerFailure};
}

test('lease request epochs, exact credential binding, current fence and strict DTOs', t => {
  const f = createCoreFixture(t), d = create(f), b = f.principals[1];
  const instanceId = randomUUID(), requestId = randomUUID(), args = { instanceId, requestId };
  const acquired = d.acquire(b,f.scope,args);
  assert.deepEqual(dataSchemas.lease.parse(acquired),acquired);
  assert.equal(acquired.historical,false);
  assert.equal(d.acquire(b,f.scope,args).historical,true);
  assert.equal(f.native.prepare('SELECT request_id FROM im_lease_requests').get().request_id,`v2:${f.centerEpoch}:${requestId}`);
  assert.throws(() => d.acquire(b,f.scope,{ ...args, instanceId:randomUUID() }), error('IDEMPOTENCY_CONFLICT'));
  const renewed = d.renew(b,f.scope,fence(acquired));
  assert.deepEqual(dataSchemas.renew.parse(renewed),renewed);
  assert.deepEqual(dataSchemas.release.parse(d.release(b,f.scope,fence(acquired))),
    {instanceId,generation:acquired.generation,released:true});
  assert.throws(() => d.release(b,f.scope,fence(acquired)),error('LEASE_EXPIRED'));
  assert.equal(d.acquire(b,f.scope,{instanceId:randomUUID(),requestId:randomUUID()}).generation,2);
  assert.throws(() => d.renew(b,f.scope,fence(acquired)),error('STALE_FENCE'));
  assert.throws(() => d.acquire(b,f.scope,{...args,extra:1}),error('INVALID_REQUEST'));
  assert.throws(() => d.acquire(b,{...f.scope,centerEpoch:randomUUID()},args),error('RECOVERY_RECONCILIATION_REQUIRED'));
});

test('continuous page, expiry receipts never ACK and all-invalid batches roll back', t => {
  const f = createCoreFixture(t), d = create(f), principal = f.principals[1];
  const first=seedMessage(f), middle=seedMessage(f), last=seedMessage(f);
  expireFixtureContent(f,middle,{scrub:true});
  const acquired=d.acquire(principal,f.scope,{instanceId:randomUUID(),requestId:randomUUID()});
  const base={...fence(acquired),streamEpoch:stream(f)};
  const ref=(seq,seed)=>({seq,messageId:seed.messageId});
  const refs=[ref(1,first),ref(2,middle),ref(3,last)];
  const page=d.sync(principal,f.scope,{...base,after:0,limit:3});
  assert.deepEqual(dataSchemas.sync.parse(page),page);
  assert.deepEqual(page.items.map(x=>x.kind),['message','content_expired','message']);
  assert.equal(page.pageAfter,3); assert.equal(page.hasMore,false);
  assert.throws(()=>d.ack(principal,f.scope,{...base,items:refs}),error('EXPIRY_RECEIPT_REQUIRED'));
  assert.equal(f.native.prepare('SELECT count(*) AS n FROM im_deliveries WHERE acked_at IS NOT NULL').get().n,0);
  assert.throws(()=>d.recordExpiryReceipts(principal,f.scope,{...base,items:[refs[1],refs[0]]}),error('CONTENT_NOT_EXPIRED'));
  assert.equal(f.native.prepare('SELECT count(*) AS n FROM im_expiry_receipts').get().n,0);
  assert.deepEqual(dataSchemas.acks.parse(d.ack(principal,f.scope,{...base,items:[refs[0],refs[2]]})),
    {streamEpoch:base.streamEpoch,handledThrough:1,ackedThrough:1,progressPending:false});
  const receipt=d.recordExpiryReceipts(principal,f.scope,{...base,items:[refs[1]]});
  assert.deepEqual(dataSchemas.expiryReceipts.parse(receipt),receipt);
  assert.equal(receipt.handledThrough,3); assert.equal(receipt.ackedThrough,1);
  assert.equal(f.native.prepare('SELECT acked_at FROM im_deliveries WHERE recipient_id=? AND seq=2').get(f.b).acked_at,null);
  assert.equal(d.recordExpiryReceipts(principal,f.scope,{...base,items:[refs[1]]}).handledThrough,3);
  assert.throws(()=>d.sync(principal,f.scope,{...base,after:4}),error('INVALID_REQUEST'));
  assert.throws(()=>d.ack(principal,f.scope,{...base,items:[refs[0],{...refs[2],messageId:randomUUID()}]}),error('INVALID_REQUEST'));
  assert.throws(()=>d.ack(principal,f.scope,{...base,items:[refs[0],refs[0]]}),error('INVALID_REQUEST'));
  assert.throws(()=>d.ack(principal,f.scope,{...base,streamEpoch:randomUUID(),items:[refs[0]]}),error('CURSOR_RESET_REQUIRED'));
});

test('missing skeleton fails closed', t => {
  const f=createCoreFixture(t), d=create(f), principal=f.principals[1];
  const seeded=seedMessage(f), lease=d.acquire(principal,f.scope,{instanceId:randomUUID(),requestId:randomUUID()});
  const args={...fence(lease),streamEpoch:stream(f)};
  f.native.prepare('DELETE FROM im_deliveries WHERE recipient_id=? AND seq=1').run(f.b);
  assert.throws(()=>d.sync(principal,f.scope,args),error('STORAGE_UNAVAILABLE'));
  // Missing skeleton must not be skipped by an inner join.
  assert.equal(seeded.messageId.length,36);
  assert.throws(()=>d.sync(principal,f.scope,{...args,after:0,unknown:1}),error('INVALID_REQUEST'));
});

test('query budget shares 1000 distinct seq across both prefixes; replay finishes without duplicate facts', t => {
  let inspected=0;
  const f=createCoreFixture(t,{onStatement: ({sql,method}) => { if (method==='get' && /LEFT JOIN im_expiry_receipts/.test(sql)) inspected++; }});
  const first=seedMessage(f,{deliveredAt:30});
  const message=f.native.prepare(`INSERT INTO im_messages(message_id,conversation_id,sender_id,recipient_id,client_message_id,title,text,in_reply_to,correlation,accepted_at)
    VALUES (?,?,?,?,?,NULL,'test message',NULL,NULL,10)`);
  const key=f.native.prepare(`INSERT INTO im_send_keys(sender_id,client_message_id,payload_hash,message_id,created_at,retry_until,status)
    VALUES (?,?,?,?,10,604800010,'live')`);
  const op=f.native.prepare(`INSERT INTO im_send_operation_keys(sender_id,origin_epoch,client_message_id,storage_client_message_id,source_protocol,message_id)
    VALUES (?,?,?,?,?,?)`);
  const content=f.native.prepare(`INSERT INTO im_content_state(message_id,state,expires_at,expired_at,scrubbed_at,policy_hash,expiry_run_id,scrub_run_id)
    VALUES (?,'live',7776000010,NULL,NULL,?,NULL,NULL)`);
  const delivery=f.native.prepare('INSERT INTO im_deliveries(recipient_id,seq,message_id,acked_at,read_at) VALUES (?,?,?,30,NULL)');
  f.native.exec('BEGIN IMMEDIATE');
  try {
    for (let seq=2;seq<=1002;seq++) {
      const messageId=randomUUID(),clientMessageId=randomUUID(),storageKey=storageOperationKey(f.centerEpoch,clientMessageId);
      const digest=fingerprintMessage({protocol:PROTOCOL,centerEpoch:f.centerEpoch,originEpoch:f.centerEpoch,
        clientMessageId,conversationId:f.conversationId,recipientAgentId:f.b,title:null,text:'test message',
        attachment:null,inReplyTo:null,correlation:null});
      message.run(messageId,f.conversationId,f.a,f.b,storageKey);
      key.run(f.a,storageKey,digest,messageId);
      op.run(f.a,f.centerEpoch,clientMessageId,storageKey,PROTOCOL,messageId);
      content.run(messageId,f.hash);
      delivery.run(f.b,seq,messageId);
    }
    f.native.prepare('UPDATE im_receive_state SET next_seq=1003,acked_through=1 WHERE agent_id=?').run(f.b);
    f.native.prepare('UPDATE im_sync_progress SET handled_through=1 WHERE recipient_id=? AND center_epoch=? AND stream_epoch=?')
      .run(f.b,f.centerEpoch,stream(f));
    f.native.exec('COMMIT');
  } catch (e) { f.native.exec('ROLLBACK'); throw e; }
  const d=create(f), principal=f.principals[1];
  const l=d.acquire(principal,f.scope,{instanceId:randomUUID(),requestId:randomUUID()});
  const args={...fence(l),streamEpoch:stream(f),items:[{seq:1,messageId:first.messageId}]};
  assert.equal(d.sync(principal,f.scope,{...fence(l),streamEpoch:stream(f)}).progressPending,true);
  assert.equal(f.native.prepare('SELECT acked_through FROM im_receive_state WHERE agent_id=?').get(f.b).acked_through,1);
  inspected=0;
  const initial=d.ack(principal,f.scope,args);
  assert.equal(initial.progressPending,true);
  assert.equal(initial.ackedThrough,1001);
  assert.ok(inspected<=1002,`bounded queries ${inspected}`);
  inspected=0;
  const replay=d.ack(principal,f.scope,args);
  assert.equal(replay.ackedThrough,1002);
  assert.equal(replay.handledThrough,1002);
  assert.equal(replay.progressPending,false);
  assert.ok(inspected<=1002,`bounded replay ${inspected}`);
  assert.equal(f.native.prepare("SELECT count(*) AS n FROM im_audit WHERE action='ack_delivery'").get().n,0);
});

test('revoked contact hides entire sync page and rejects batch without modifying facts', t => {
  const f=createCoreFixture(t), d=create(f), p=f.principals[1];
  const seed=seedMessage(f), l=d.acquire(p,f.scope,{instanceId:randomUUID(),requestId:randomUUID()});
  const args={...fence(l),streamEpoch:stream(f)},ref={seq:1,messageId:seed.messageId};
  f.native.prepare('UPDATE im_contacts SET allowed=0 WHERE agent_low=? AND agent_high=?').run(...[f.a,f.b].sort());
  assert.throws(()=>d.sync(p,f.scope,args),error('SYNC_BLOCKED'));
  assert.throws(()=>d.ack(p,f.scope,{...args,items:[ref]}),error('RESOURCE_NOT_FOUND'));
  assert.equal(f.native.prepare('SELECT acked_at FROM im_deliveries WHERE recipient_id=? AND seq=1').get(f.b).acked_at,null);
});

test('native write failure after a real ACK rolls back every business mutation', t => {
  let fault=false;
  const f=createCoreFixture(t,{onStatement: ({sql,method}) => {
    if (fault && method==='run' && /UPDATE im_deliveries SET acked_at/.test(sql)) throw new Error('injected after native ACK');
  }});
  const d=create(f),p=f.principals[1],seed=seedMessage(f);
  const l=d.acquire(p,f.scope,{instanceId:randomUUID(),requestId:randomUUID()});
  fault=true;
  assert.throws(()=>d.ack(p,f.scope,{...fence(l),streamEpoch:stream(f),items:[{seq:1,messageId:seed.messageId}]}),error('STORAGE_UNAVAILABLE'));
  assert.equal(f.native.prepare('SELECT acked_at FROM im_deliveries WHERE recipient_id=? AND seq=1').get(f.b).acked_at,null);
  assert.equal(f.native.prepare('SELECT acked_through FROM im_receive_state WHERE agent_id=?').get(f.b).acked_through,0);
});

test('auth final clock at exclusive lease expiry rolls back ACK, receipt, acquire and renew but persists floor', t => {
  for (const operation of ['ack','receipt','acquire','renew']) {
    const c=controlled(t),{f,d,p}=c;
    const seed=seedMessage(f);
    if (operation==='receipt') expireFixtureContent(f,seed);
    const l=operation==='acquire' ? null : leased(d,f,p);
    const before=snapshot(f), expiry=l?.expiresAt ?? 1103;
    const acquireInput={instanceId:randomUUID(),requestId:randomUUID()};
    let reads=0;
    c.onLease(({result,writes})=>{
      reads++;
      if (operation==='acquire') {
        if (reads===1) {
          assert.equal(result,undefined,'first acquire lease read precedes business writes');
          assert.equal(writes.some(sql=>/INSERT INTO im_receiver_leases/.test(sql)),false);
          return false;
        }
        assert.equal(reads,2,'second acquire lease read is internal refreshLease');
        for (const pattern of [/INSERT INTO im_receiver_leases/,/INSERT INTO im_lease_requests/,/INSERT INTO im_audit/])
          assert.equal(writes.some(sql=>pattern.test(sql)),true,`acquire write ${pattern} ran before clock transition`);
        assert.equal(result.instance_id,acquireInput.instanceId);
        assert.equal(result.generation,1);
        assert.equal(result.expires_at,expiry);
        assert.deepEqual({...f.native.prepare('SELECT instance_id,generation,expires_at FROM im_receiver_leases WHERE agent_id=?').get(f.b)},
          {instance_id:acquireInput.instanceId,generation:1,expires_at:expiry});
        assert.equal(f.native.prepare('SELECT count(*) AS n FROM im_lease_requests WHERE agent_id=? AND request_id=?').get(
          f.b,`v2:${f.centerEpoch}:${acquireInput.requestId}`).n,1);
        assert.equal(f.native.prepare("SELECT count(*) AS n FROM im_audit WHERE action='acquire_receiver' AND actor_id=?").get(f.b).n,1);
        assert.equal(f.native.prepare('SELECT last_observed_at AS n FROM im_clock').get().n,expiry-1000,
          'delivery internal refresh has not sampled the final auth time');
      } else if (reads!==2) return false;
      c.setNow(expiry);
      return true;
    });
    const act=()=>operation==='acquire' ? d.acquire(p,f.scope,acquireInput) : operation==='renew' ? d.renew(p,f.scope,fence(l)) :
      operation==='ack' ? d.ack(p,f.scope,{...fence(l),streamEpoch:stream(f),items:[{seq:1,messageId:seed.messageId}]}) :
        d.recordExpiryReceipts(p,f.scope,{...fence(l),streamEpoch:stream(f),items:[{seq:1,messageId:seed.messageId}]});
    let thrown;
    try { act(); } catch (e) { thrown=e; }
    assert.equal(c.observerFailure(),null,`${operation} native observer assertions`);
    assert.equal(thrown?.code,'LEASE_EXPIRED',operation);
    assert.equal(c.observerFailure(),null,`${operation} native observer assertions`);
    assert.equal(c.didTrigger(),true,operation);
    assert.equal(reads,2,`${operation} reached internal refreshLease before auth final refresh`);
    const after=snapshot(f);
    assert.deepEqual({...after,clock:before.clock},{...before,clock:before.clock},operation);
    assert.equal(after.clock,expiry,operation);
  }
});

test('release final hook verifies inactive exact tuple; historical replay is not current lease authority', t => {
  const c=controlled(t),{f,d,p}=c, l=leased(d,f,p);
  c.onLease(()=>false);
  assert.deepEqual(d.release(p,f.scope,fence(l)),{instanceId:l.instanceId,generation:l.generation,released:true});
  assert.equal(snapshot(f).lease.expires_at,103);
  c.setNow(1103);
  assert.equal(d.acquire(p,f.scope,{instanceId:l.instanceId,requestId:f.native.prepare('SELECT request_id FROM im_lease_requests WHERE agent_id=?').get(f.b).request_id.split(':').at(-1)}).historical,true);
  const newer=leased(d,f,p);
  assert.equal(newer.generation,l.generation+1);
  assert.throws(()=>d.sync(p,f.scope,{...fence(l),streamEpoch:stream(f)}),error('STALE_FENCE'));
  assert.throws(()=>d.ack(p,f.scope,{...fence(l),streamEpoch:stream(f),items:[{seq:1,messageId:seedMessage(f).messageId}]}),error('STALE_FENCE'));
});

test('final auth credential revocation and expiry roll back business ACK and persistent clock floor survives', t => {
  for (const kind of ['revoked','expired']) {
    const c=controlled(t),{f,d,p}=c, seed=seedMessage(f),l=leased(d,f,p), before=snapshot(f);
    let hits=0;
    c.onLease(()=>{ if (++hits===2) {
      if (kind==='revoked') f.native.prepare('UPDATE im_credentials SET revoked_at=? WHERE credential_id=?').run(103,p.credentialId);
      else f.native.prepare('UPDATE im_credentials SET expires_at=? WHERE credential_id=?').run(104,p.credentialId);
      c.setNow(104); return true;
    } return false; });
    assert.throws(()=>d.ack(p,f.scope,{...fence(l),streamEpoch:stream(f),items:[{seq:1,messageId:seed.messageId}]}),error('INVALID_CREDENTIAL'));
    assert.equal(c.didTrigger(),true);
    const after=snapshot(f);
    assert.deepEqual({...after,clock:before.clock},{...before,clock:before.clock});
    assert.equal(after.clock,104);
  }
});

test('lease generation and deadline arithmetic overflow refuse mutation', t => {
  const f=createCoreFixture(t), d=create(f),p=f.principals[1],l=leased(d,f,p);
  f.native.prepare('UPDATE im_receiver_leases SET generation=?,expires_at=? WHERE agent_id=?')
    .run(Number.MAX_SAFE_INTEGER,103,f.b);
  const prior=snapshot(f);
  assert.throws(()=>leased(d,f,p),error('STORAGE_UNAVAILABLE'));
  assert.deepEqual(snapshot(f),prior);
  const c=controlled(t),first=snapshot(c.f);
  c.setNow(Number.MAX_SAFE_INTEGER-999);
  assert.throws(()=>leased(c.d,c.f,c.p),error('CLOCK_UNSAFE'));
  assert.deepEqual({...snapshot(c.f),clock:first.clock},first);
  assert.equal(snapshot(c.f).clock,Number.MAX_SAFE_INTEGER-999);
});

test('receipt with live or missing content fails in prefix facts and pending probes, while legitimate expiry passes', t => {
  for (const corrupt of ['live','missing']) {
    const f=createCoreFixture(t), d=create(f),p=f.principals[1],seed=seedMessage(f),l=leased(d,f,p);
    const second=seedMessage(f);
    expireFixtureContent(f,seed);
    const args={...fence(l),streamEpoch:stream(f)},ref={seq:1,messageId:seed.messageId};
    d.recordExpiryReceipts(p,f.scope,{...args,items:[ref]});
    assert.equal(d.sync(p,f.scope,args).progressPending,false);
    f.native.prepare('UPDATE im_sync_progress SET handled_through=0 WHERE recipient_id=?').run(f.b);
    if (corrupt==='live') f.native.prepare("UPDATE im_content_state SET state='live',expired_at=NULL,expiry_run_id=NULL WHERE message_id=?").run(seed.messageId);
    else f.native.prepare('DELETE FROM im_content_state WHERE message_id=?').run(seed.messageId);
    const before=snapshot(f);
    assert.throws(()=>d.sync(p,f.scope,args),error('STORAGE_UNAVAILABLE'),corrupt);
    assert.throws(()=>d.ack(p,f.scope,{...args,items:[{seq:2,messageId:second.messageId}]}),error('STORAGE_UNAVAILABLE'),corrupt);
    assert.deepEqual(snapshot(f),before);
  }
});

test('ignored receipt collision with wrong existing message identity rejects and rolls back', t => {
  const f=createCoreFixture(t),d=create(f),p=f.principals[1];
  const first=seedMessage(f),other=seedMessage(f);
  expireFixtureContent(f,first); expireFixtureContent(f,other);
  const l=leased(d,f,p),args={...fence(l),streamEpoch:stream(f)};
  const inserted=f.native.prepare(`INSERT INTO im_expiry_receipts
    (recipient_id,center_epoch,stream_epoch,seq,message_id,recorded_at) VALUES (?,?,?,?,?,?)`)
    .run(f.b,f.centerEpoch,args.streamEpoch,1,other.messageId,103);
  assert.equal(inserted.changes,1);
  const before=snapshot(f);
  assert.throws(()=>d.recordExpiryReceipts(p,f.scope,{...args,items:[{seq:1,messageId:first.messageId}]}),error('STORAGE_UNAVAILABLE'));
  assert.deepEqual(snapshot(f),before);
});

test('exactly 100 unique ACK items accepted, 101 rejected; expired replay retains first timestamp', t => {
  const f=createCoreFixture(t),d=create(f),p=f.principals[1],refs=[];
  for (let seq=1;seq<=101;seq++) refs.push({seq,messageId:seedMessage(f).messageId});
  const l=leased(d,f,p),args={...fence(l),streamEpoch:stream(f)};
  const before=snapshot(f);
  assert.throws(()=>d.ack(p,f.scope,{...args,items:refs}),error('INVALID_REQUEST'));
  assert.deepEqual(snapshot(f),before);
  assert.equal(d.ack(p,f.scope,{...args,items:refs.slice(0,100)}).ackedThrough,100);
  const first=f.native.prepare('SELECT acked_at FROM im_deliveries WHERE recipient_id=? AND seq=1').get(f.b).acked_at;
  expireFixtureContent(f,{messageId:refs[0].messageId,expiresAt:7776000010});
  expireFixtureContent(f,{messageId:refs[100].messageId,expiresAt:7776000010});
  assert.throws(()=>d.ack(p,f.scope,{...args,items:[refs[0],refs[100]]}),error('EXPIRY_RECEIPT_REQUIRED'));
  assert.equal(f.native.prepare('SELECT acked_at FROM im_deliveries WHERE recipient_id=? AND seq=101').get(f.b).acked_at,null);
  assert.equal(d.ack(p,f.scope,{...args,items:[refs[0]]}).ackedThrough,100);
  assert.equal(f.native.prepare('SELECT acked_at FROM im_deliveries WHERE recipient_id=? AND seq=1').get(f.b).acked_at,first);
});
