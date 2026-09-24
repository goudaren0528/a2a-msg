import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDutyConsumer } from '../src/duty/consumer.js';
import { CONFIG } from '../src/config.js';

const bytes=Buffer.from('approved attachment');
const sha=v=>createHash('sha256').update(v).digest('hex');
const ctx=()=>({sessionActive:true,memberEnabled:true,currentMember:'worker',grantId:1,
  auth:{credential:'a'.repeat(40),member:'worker',sessionBinding:'host-session',role:'FIX',repo:'repo',environment:'test'}});
const message=()=>({id:7,from:'sender',to:'worker',title:'work',text:'secret body',project:'project',
  time:'2026-01-01',sourceVerificationRef:'proof',attachment:{id:8,name:'file.txt',size:bytes.length,
    mime:'text/plain',sha256:sha(bytes),data:Buffer.from(bytes)}});
const request=()=>({workId:2,fence:3});
async function fixture(t,opts={}) {
  const dir=await mkdtemp(join(tmpdir(),'duty-consumer-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  let trusted=ctx(), calls=0, saves=0, verification=true, revoked=false;
  let payload={workId:2,messages:[message()]};
  const store={getPayload:()=>{calls++;if(revoked) throw Object.assign(new Error('SQL secret'),{code:'GRANT_REVOKED'});return payload;},
    claim:()=>{calls++;return {workId:2};}};
  const save=async(_params,download)=>{
    saves++;
    const meta=await download();
    if (opts.failSave) throw new Error('SQL password secret stack');
    const file=join(dir,`saved-${saves}`);
    await writeFile(file,Buffer.from(meta.data_base64,'base64'));
    return {path:file,size:meta.size,sha256:meta.sha256,cleanupWarning:opts.cleanupWarning};
  };
  const verify=async(file,hash,size)=>verification && (await readFile(file)).length===size && sha(await readFile(file))===hash;
  const make=(extra={})=>createDutyConsumer({enabled:true,store,getTrustedContext:()=>trusted,
    saveAttachment:save,verifySavedAttachment:verify,...extra});
  return {make,store,dir,save,verify,get calls(){return calls;},get saves(){return saves;},
    setContext:v=>trusted=v,setPayload:v=>payload=v,setVerified:v=>verification=v,revoke:()=>revoked=true};
}
const denied=async(p,code='WORK_PROTOCOL_INVALID')=>assert.rejects(p,e=>e.code===code&&e.message===code&&
  !/SQL|password|stack|secret/i.test(e.message));

test('disabled never calls trusted context or store; management methods absent',async t=>{
  const f=await fixture(t);let invoked=false;
  const consumer=f.make({enabled:false,getTrustedContext:()=>{invoked=true;return ctx();}});
  await denied(consumer.claim({requestId:randomUUID()}),'AUTH_REQUIRED');
  assert.equal(invoked,false);assert.equal(f.calls,0);
  for (const name of ['approve','revoke','confirmUat','migrate','getPayload']) assert.equal(consumer[name],undefined);
  assert.deepEqual(Object.keys(consumer).sort(),['claim','renew','status','payload','update','recover',
    'resumeBlocked','replySend','replyQuery'].sort());
});

test('host identity only, strict inputs, inactive session fails closed',async t=>{
  const f=await fixture(t),consumer=f.make();
  await denied(consumer.claim({requestId:randomUUID(),auth:ctx().auth}));
  await denied(consumer.payload({...request(),grantId:1}));
  await denied(consumer.payload({...request(),sessionBinding:'fake'}));
  await denied(consumer.replySend({workId:2,fence:3,expectedVersion:0,requestId:'invalid',title:'ok',text:'ok'}));
  assert.equal(f.calls,0);
  f.setContext({...ctx(),sessionActive:false});
  await denied(consumer.payload(request()),'AUTH_REQUIRED');
  assert.equal(f.calls,0);
});

test('size and SHA tampering never save or return body',async t=>{
  const f=await fixture(t),consumer=f.make();
  for (const mutate of [m=>m.attachment.size++,m=>m.attachment.sha256='0'.repeat(64),
    m=>m.attachment.size=10*1024*1024+1,m=>m.attachment.data='base64']) {
    const m=message();mutate(m);f.setPayload({workId:2,messages:[m]});
    await denied(consumer.payload(request()),'DIGEST_MISMATCH');
  }
  assert.equal(f.saves,0);
});

test('startup receive ceiling remains fixed after config raises; runtime lowering still applies',async t=>{
  const original=CONFIG.maxAttachmentBytes;
  let createWithStartupCap;
  try {
    CONFIG.maxAttachmentBytes=bytes.length-1;
    ({createDutyConsumer:createWithStartupCap}=await import(`../src/duty/consumer.js?cap-regression=${randomUUID()}`));
  } finally {
    CONFIG.maxAttachmentBytes=original;
  }
  const f=await fixture(t);
  // Use the freshly imported consumer, which captured the lower startup cap.
  const capped=createWithStartupCap({enabled:true,store:f.store,getTrustedContext:ctx,
    saveAttachment:f.save,verifySavedAttachment:f.verify});
  await denied(capped.payload(request()),'DIGEST_MISMATCH');
  assert.equal(f.saves,0);
  const small=Buffer.from('ok');
  f.setPayload({workId:2,messages:[{...message(),attachment:{...message().attachment,
    size:small.length,sha256:sha(small),data:small}}]});
  try {
    CONFIG.maxAttachmentBytes=small.length-1;
    await denied(capped.payload(request()),'DIGEST_MISMATCH');
    assert.equal(f.saves,0);
  } finally {
    CONFIG.maxAttachmentBytes=original;
  }
  assert.equal((await capped.payload(request())).messages[0].attachment.size,small.length);
  assert.equal(f.saves,1);
});

test('save failure hides body; successful save precedes body; cleanup warning is success',async t=>{
  const f=await fixture(t,{cleanupWarning:true});
  await denied(f.make({saveAttachment:async()=>{throw new Error('SQL secret stack');}}).payload(request()));
  assert.equal(f.saves,0);
  const output=await f.make().payload(request());
  assert.equal(f.saves,1);
  assert.equal(output.messages[0].text,'secret body');
  assert.equal(output.messages[0].attachment.sha256,sha(bytes));
  assert.match(output.messages[0].attachment.cleanupWarning,/Do not save again/);
  assert.equal(output.messages[0].attachment.data,undefined);
  assert.equal(output.messages[0].attachment.data_base64,undefined);
  assert.deepEqual(await readFile(output.messages[0].attachment.savedPath),bytes);
});

test('same payload concurrency deduplicates; cached reuse requires verifier; invalid cache resaves',async t=>{
  const f=await fixture(t),consumer=f.make();
  const results=await Promise.all(Array.from({length:5},()=>consumer.payload(request())));
  assert.equal(f.saves,1);assert.equal(results.length,5);
  await consumer.payload(request());assert.equal(f.saves,1);
  f.setVerified(false);
  await consumer.payload(request());assert.equal(f.saves,2);
  const noVerify=f.make({verifySavedAttachment:undefined});
  await noVerify.payload(request());await noVerify.payload(request());assert.equal(f.saves,4);
});

test('revocation during save fails final reauthorization without exposing body',async t=>{
  const f=await fixture(t);
  const consumer=f.make({saveAttachment:async(params,download)=>{const result=await f.save(params,download);f.revoke();return result;}});
  await denied(consumer.payload(request()),'GRANT_REVOKED');
  assert.equal(f.saves,1);
});

test('a mutable trusted auth object changed during saving cannot authorize the original snapshot',async t=>{
  const f=await fixture(t);
  const original=ctx();f.setContext(original);
  const consumer=f.make({saveAttachment:async(params,download)=>{
    const result=await f.save(params,download);
    original.auth.credential='b'.repeat(40);
    return result;
  }});
  await denied(consumer.payload(request()),'AUTH_REQUIRED');
  assert.equal(f.saves,1);
});

test('Uint8Array subview copies only its bytes; arbitrary arrays and strings never save',async t=>{
  const f=await fixture(t),consumer=f.make();
  const sliced=Buffer.concat([Buffer.from('prefix'),bytes,Buffer.from('suffix')]);
  const view=new Uint8Array(sliced.buffer,sliced.byteOffset+6,bytes.length);
  f.setPayload({workId:2,messages:[{...message(),attachment:{...message().attachment,data:view}}]});
  assert.equal((await consumer.payload(request())).messages[0].attachment.sha256,sha(bytes));
  assert.equal(f.saves,1);
  for (const data of [Array.from(bytes),bytes.toString('base64')]) {
    f.setPayload({workId:2,messages:[{...message(),attachment:{...message().attachment,data}}]});
    await denied(consumer.payload(request()),'DIGEST_MISMATCH');
  }
  assert.equal(f.saves,1);
});

test('reply title matches store 100-character boundary before store invocation',async t=>{
  const f=await fixture(t),consumer=f.make();
  await denied(consumer.replySend({workId:2,fence:3,expectedVersion:0,requestId:randomUUID(),
    title:'T'.repeat(101),text:'progress'}));
  assert.equal(f.calls,0);
});
