import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join,dirname } from 'node:path';
import { createImV2BackupRegistry,createRecoveryHoldReleaser,withRecoveryHold,withRecoverySource } from '../src/im/v2/backup-registry.js';
import { setup,terminal,publication,wrap,thrown,deeplyFrozen,directoryState,authority,approvalAuthority,context,unsupported,evidenceHash,planHash } from './fixtures/im-v2-recovery-hold-terminal/helpers.js';
import { processes } from './fixtures/im-v2-recovery-hold-terminal/processes.js';
import { fail } from '../src/im/v2/recovery-records.js';
const invalid={code:'RECOVERY_INVALID'},mismatch={code:'RECOVERY_EVIDENCE_MISMATCH'};
const read=(f,cb)=>withRecoveryHold(f.registry,{backupId:f.operation.backupId,holdId:f.operation.holdId},context,cb);
const names=f=>fs.readdirSync(join(f.registryRoot,'registry/holds')).sort();
const invoke=(f,verifier=terminal,options={})=>f.make(verifier,options).release(f.operation,context);
const fileState=path=>{const {ino,dev}=fs.statSync(path);return {bytes:fs.readFileSync(path),ino,dev};};
const protectedState=f=>[f.artifact,f.manifest,
  join(f.registryRoot,'registry/holds',`${f.operation.holdId}.json`),
  join(f.registryRoot,'registry/holds',`${f.operation.holdId}.binding.json`)].map(fileState);
function fixedFailure(error,code) {
  assert(error instanceof Error);assert.equal(error.name,'Error');assert.equal(error.code,code);
  assert.equal(error.message,code);assert.doesNotMatch(error.stack,/TEST_ONLY_SECRET|TypeError|startsWith is not a function/);
}

for (const kind of ['missing','undefined','null','negative','fraction','unsafe','string','nan','infinity'])
test(`C0 mandatory safeinteger minimum ${kind} refuses before publication`,{skip:unsupported},async t=>{
  const f=await setup(t),before=directoryState(join(f.registryRoot,'registry'));let calls=0,links=0,syncs=0;
  const values={undefined:undefined,null:null,negative:-1,fraction:1.5,unsafe:Number.MAX_SAFE_INTEGER+1,string:'1',nan:NaN,infinity:Infinity};
  const input={stateEvidenceHash:evidenceHash};if(kind!=='missing')input.minimumReleasedAt=values[kind];
  const registry=createImV2BackupRegistry({...f.options,clock:()=>{calls++;return Date.now();}});
  const restore=wrap({linkSync:real=>(...args)=>{links++;return real(...args);},fsyncSync:real=>fd=>{syncs++;return real(fd);}});
  try {assert.throws(()=>invoke(f,(p,o,c,publish)=>publish(input),{registry}),mismatch);} finally {restore();}
  assert.equal(calls,0);assert.equal(links,0);assert.equal(syncs,0);assert.equal(fs.existsSync(f.releasePath),false);
  assert.deepEqual(directoryState(join(f.registryRoot,'registry')),before);f.unchanged();
});

for (const change of ['hash','minimum','both']) test(`C0 caught changed ${change} after durable receipt poisons exact scope`,{skip:unsupported},async t=>{
  const f=await setup(t),before=protectedState(f);let receipt,returned,marker,published=false;
  assert.throws(()=>invoke(f,(p,o,c,publish)=>{
    const input=publication(p);receipt=publish(input);marker=fileState(f.releasePath);published=true;
    assert.strictEqual(publish({...input}),receipt,'both unchanged fields return identical receipt');
    const changed={...input};if(change!=='minimum')changed.stateEvidenceHash='f'.repeat(64);
    if(change!=='hash')changed.minimumReleasedAt++;
    assert.throws(()=>publish(changed),mismatch);returned=receipt;return receipt;
  }),mismatch);
  assert.equal(published,true);assert.strictEqual(returned,receipt);assert.deepEqual(fileState(f.releasePath),marker);
  assert.deepEqual(protectedState(f),before);f.unchanged();
});

test('C0 existing marker at binding but below trusted minimum refuses without clock, rewrite, delete or sync',{skip:unsupported},async t=>{
  const f=await setup(t),bound=f.held.binding.boundAt;
  let clockCalls=0;const registry=createImV2BackupRegistry({...f.options,clock:()=>{clockCalls++;return bound;}});
  const initial=invoke(f,terminal,{registry});assert.equal(initial.releaseMarker.releasedAt,bound);assert.equal(clockCalls,1);
  const before=directoryState(join(f.registryRoot,'registry')),marker=fileState(f.releasePath);clockCalls=0;
  const operations=[];
  const restore=wrap(Object.fromEntries(['writeSync','linkSync','unlinkSync','fsyncSync'].map(name=>[name,real=>(...args)=>{operations.push(name);return real(...args); }])));
  try {assert.throws(()=>invoke(f,(p,o,c,publish)=>publish({...publication(p),minimumReleasedAt:bound+1}),{registry}),mismatch);} finally {restore();}
  assert.equal(clockCalls,0);assert.deepEqual(operations,[]);assert.deepEqual(fileState(f.releasePath),marker);
  assert.deepEqual(directoryState(join(f.registryRoot,'registry')),before);f.unchanged();
});

test('C0 publication input snapshots both fields before registry clock and approval callback effects',{skip:unsupported},async t=>{
  const f=await setup(t),minimum=f.held.binding.boundAt,input=publication(f.held);let calls=0;
  const registry=createImV2BackupRegistry({...f.options,clock:()=>{calls++;input.minimumReleasedAt=Number.MAX_SAFE_INTEGER;input.stateEvidenceHash='f'.repeat(64);return minimum;}});
  const result=invoke(f,(p,o,c,publish)=>{
    const receipt=publish(input);assert.strictEqual(publish(publication(p)),receipt);return receipt;
  },{registry,approvalAuthority:{authorizeApproval:()=>{if(calls)input.minimumReleasedAt=-1;return true;}}});
  assert.equal(calls,1);assert.equal(result.releaseMarker.releasedAt,minimum);assert.equal(result.releaseMarker.stateEvidenceHash,evidenceHash);
  assert.equal(input.minimumReleasedAt,-1);f.unchanged();
});

for (const floor of ['binding','completion']) test(`C0 actual registry sample below ${floor} floor refuses all marker mutation`,{skip:unsupported},async t=>{
  const f=await setup(t),bound=f.held.binding.boundAt;
  const minimum=floor==='binding'?bound-1:bound+2,clockValue=floor==='binding'?bound-1:bound+1;
  assert(bound>0);let calls=0;
  const registry=createImV2BackupRegistry({...f.options,clock:()=>{calls++;return clockValue;}});
  const before=directoryState(join(f.registryRoot,'registry')),operations=[];
  const restore=wrap(Object.fromEntries(['writeSync','linkSync','unlinkSync','fsyncSync'].map(name=>[name,real=>(...args)=>{operations.push(name);return real(...args); }])));
  try {assert.throws(()=>invoke(f,(p,o,c,publish)=>publish({...publication(p),minimumReleasedAt:minimum}),{registry}),mismatch);} finally {restore();}
  assert.equal(calls,1);assert.deepEqual(operations,[]);assert.equal(fs.existsSync(f.releasePath),false);
  assert.deepEqual(directoryState(join(f.registryRoot,'registry')),before);f.unchanged();
});

for (const kind of ['getter','proxy']) test(`C0 caught hostile minimum ${kind} after durable receipt preserves poison`,{skip:unsupported},async t=>{
  const f=await setup(t);let reached=0,marker,receipt,returned;
  assert.throws(()=>invoke(f,(p,o,c,publish)=>{
    receipt=terminal(p,o,c,publish);marker=fileState(f.releasePath);
    const hostile=kind==='getter'?{stateEvidenceHash:evidenceHash,get minimumReleasedAt(){reached++;throw null;}}:
      new Proxy(publication(p),{get(target,key){if(key==='minimumReleasedAt'){reached++;throw false;}return Reflect.get(target,key);}});
    assert.throws(()=>publish(hostile),mismatch);returned=receipt;return receipt;
  }),mismatch);
  assert.equal(reached,kind==='getter'?0:1,'descriptor rejection must not invoke an accessor; data-shaped proxy traps are exercised');
  assert.strictEqual(returned,receipt);assert.deepEqual(fileState(f.releasePath),marker);f.unchanged();
});

for (const kind of ['non-string-code','throwing-code-getter','null','false','zero','empty','undefined','genuine-recovery'])
  test(`C poison after genuine durable publication: ${kind}`,{skip:unsupported},async t=>{
    const f=await setup(t),before=protectedState(f);let escaped,receipt,returnedReceipt,marker,registryAfterPublish;
    let thenCalls=0,codeCalls=0,links=0,secondary,outer,outerFailed=false,published=false;
    const syncs=[],rejections=[],observe=error=>rejections.push(error);
    process.on('unhandledRejection',observe);
    const restore=wrap({
      linkSync:real=>(...args)=>{const result=real(...args);if(dirname(args[1])===dirname(f.releasePath))links++;return result;},
      fsyncSync:real=>fd=>{const result=real(fd),s=fs.fstatSync(fd);syncs.push({ino:s.ino,dev:s.dev,directory:s.isDirectory()});return result;},
    });
    try {
      try {invoke(f,(proof,op,ctx,publish)=>{
        escaped=publish;receipt=terminal(proof,op,ctx,publish);
        // Establish the real success phase BEFORE provoking error classification.
        assert.equal(Object.getPrototypeOf(receipt),null);assert(Object.isFrozen(receipt));assert.deepEqual(Reflect.ownKeys(receipt),[]);
        marker=fileState(f.releasePath);const record=JSON.parse(marker.bytes),dir=fs.statSync(dirname(f.releasePath));
        assert.equal(record.holdId,f.operation.holdId);assert.equal(record.recoveryRunId,f.operation.runId);
        assert.equal(record.stateEvidenceHash,evidenceHash);assert.equal(record.terminalState,'active');assert.equal(links,1);
        assert(syncs.some(s=>!s.directory&&s.ino===marker.ino&&s.dev===marker.dev),'real marker file fsync completed');
        assert(syncs.some(s=>s.directory&&s.ino===dir.ino&&s.dev===dir.dev),'real release directory fsync completed');
        registryAfterPublish=directoryState(join(f.registryRoot,'registry'));published=true;
        let value;
        if(kind==='non-string-code')value={code:1,message:'TEST_ONLY_SECRET non-string'};
        if(kind==='throwing-code-getter')value={get code(){codeCalls++;throw Error('TEST_ONLY_SECRET classifier');}};
        if(kind==='null')value=null;if(kind==='false')value=false;if(kind==='zero')value=0;if(kind==='empty')value='';
        if(kind==='genuine-recovery')value=fail('RECOVERY_INVALID');
        const input={...publication(proof),get then(){thenCalls++;throw value;}};
        try {publish(input);} catch(error) {secondary=error;}
        returnedReceipt=receipt;return receipt;
      });} catch(error) {outerFailed=true;outer=error;}
    } finally {restore();}
    try {
      await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
      assert.equal(published,true,'must reach genuine durable publication, not fail in fixture/auth/hold setup');
      assert.strictEqual(returnedReceipt,receipt,'verifier returns the original genuine publication receipt');
      assert.equal(thenCalls,1,'secondary publish must actually execute the throwing then getter');
      t.diagnostic(JSON.stringify({kind,published,thenCalls,codeCalls,links,outerFailed,returnedOriginalReceipt:returnedReceipt===receipt}));
      assert.equal(outerFailed,true,'caught secondary poison must refuse outer success');
      const code=kind==='genuine-recovery'?'RECOVERY_INVALID':'RECOVERY_EVIDENCE_MISMATCH';
      fixedFailure(secondary,code);fixedFailure(outer,code);
      assert.deepEqual(fileState(f.releasePath),marker);assert.deepEqual(protectedState(f),before);
      assert.deepEqual(directoryState(join(f.registryRoot,'registry')),registryAfterPublish);assert.equal(links,1);
      assert.throws(()=>escaped(publication(f.held)),invalid);assert.deepEqual(rejections,[]);f.unchanged();
      t.diagnostic(JSON.stringify({kind,phase:'durable-publish -> throwing-then -> caught -> original-receipt -> outer-refusal',thenCalls,codeCalls,links,outerCode:outer.code}));
    } finally {process.off('unhandledRejection',observe);}
  });

test('C structurally valid active marker is readonly HOLD advice, never terminal or current authority',{skip:unsupported},async t=>{
  const f=await setup(t);
  const marker={version:1,holdId:f.operation.holdId,recoveryRunId:f.operation.runId,terminalState:'active',
    stateEvidenceHash:evidenceHash,approvalRef:f.operation.approvalRef,releasedAt:f.held.binding.boundAt};
  // Private fixture marker only. Its time is lawful by construction; no global clock rollback.
  fs.writeFileSync(f.releasePath,JSON.stringify(marker),{mode:0o600,flag:'wx'});
  const before=protectedState(f),releaseBefore=fileState(f.releasePath),registryBefore=directoryState(join(f.registryRoot,'registry'));
  let syncs=0,links=0,verified=0;
  const restore=wrap({fsyncSync:real=>fd=>{syncs++;return real(fd);},linkSync:real=>(...args)=>{links++;return real(...args);}});
  try {
    assert.deepEqual(f.registry.checkCleanup({backupId:f.record.backupId},context),{allowed:false,reason:'HOLD'});
    assert.deepEqual(read(f,p=>{deeplyFrozen(p);assert.deepEqual(Object.keys(p),['record','sourceEvidence','hold','binding','release']);return p.release;}),marker);
    assert.throws(()=>f.registry.getHold({holdId:f.operation.holdId},context),mismatch);
    assert.throws(()=>withRecoverySource(f.registry,{backupId:f.record.backupId,recoveryRunId:f.operation.runId,
      stageHash:f.held.hold.stageHash,preparePlanHash:f.held.binding.preparePlanHash},context,()=>assert.fail('old source callback must not run')),mismatch);
    const refusal=()=>{verified++;throw Error('TEST_ONLY_SECRET explicit terminal refusal');};
    assert.throws(()=>invoke(f,refusal),error=>{fixedFailure(error,'RECOVERY_CALLBACK_FAILED');return true;});
    assert.equal(verified,1,'existing structurally valid marker still requires the actual verifier');
    assert.throws(()=>invoke(f,refusal,{authority:{authorizeAdmin:()=>false}}),{code:'RECOVERY_AUTH_DENIED'});
    assert.throws(()=>invoke(f,refusal,{approvalAuthority:{authorizeApproval:()=>false}}),{code:'RECOVERY_APPROVAL_DENIED'});
    assert.equal(verified,1,'current authorization refusals precede the verifier');
  } finally {restore();}
  assert.equal(syncs,0);assert.equal(links,0);assert.deepEqual(protectedState(f),before);
  assert.deepEqual(fileState(f.releasePath),releaseBefore);assert.deepEqual(directoryState(join(f.registryRoot,'registry')),registryBefore);f.unchanged();
});

for (const kind of ['orphan','wrong-hold','wrong-run','failed','before-hold','noncanonical'])
  test(`C cleanup and held read reject ${kind} marker exactly`,{skip:unsupported},async t=>{
    const f=await setup(t),before=protectedState(f);
    const marker={version:1,holdId:f.operation.holdId,recoveryRunId:f.operation.runId,terminalState:'active',
      stateEvidenceHash:evidenceHash,approvalRef:f.operation.approvalRef,releasedAt:f.held.binding.boundAt};
    assert(f.held.hold.createdAt>0,'before-hold fixture needs a legal nonnegative predecessor');
    if(kind==='orphan'||kind==='wrong-hold')marker.holdId=f.operation.runId;
    if(kind==='wrong-run')marker.recoveryRunId=f.operation.backupId;
    if(kind==='failed')marker.terminalState='failed';
    if(kind==='before-hold')marker.releasedAt=f.held.hold.createdAt-1;
    const path=kind==='orphan'?join(dirname(f.releasePath),`${marker.holdId}.json`):f.releasePath;
    fs.writeFileSync(path,JSON.stringify(marker)+(kind==='noncanonical'?'\n':''),{mode:0o600,flag:'wx'});
    const markerBefore=fileState(path),registryBefore=directoryState(join(f.registryRoot,'registry'));
    assert.throws(()=>f.registry.checkCleanup({backupId:f.record.backupId},context),mismatch);
    // An orphan is found by the full cleanup scan; the scoped held reader is not a global scan.
    if(kind!=='orphan')assert.throws(()=>read(f,()=>assert.fail('invalid marker must not reach callback')),mismatch);
    assert.deepEqual(protectedState(f),before);assert.deepEqual(fileState(path),markerBefore);
    assert.deepEqual(directoryState(join(f.registryRoot,'registry')),registryBefore);f.unchanged();
  });

for (const v3 of [false,true]) test(`C held read and exact release retry on real ${v3?'imported v3':'native v4'} registered source`,{skip:unsupported},async t=>{
  const f=await setup(t,{v3}),before=directoryState(join(f.registryRoot,'registry')),holdNames=names(f);
  let fsyncs=0;const restore=wrap({fsyncSync:real=>fd=>{fsyncs++;return real(fd);}});
  try {
    assert.equal(read(f,p=>{deeplyFrozen(p);assert.deepEqual(Object.keys(p),['record','sourceEvidence','hold','binding','release']);assert.equal(p.release,null);return 42;}),42);
    assert.equal(fsyncs,0);assert.deepEqual(directoryState(join(f.registryRoot,'registry')),before);
  } finally {restore();}
  let escaped,receipt;
  const result=invoke(f,(proof,op,ctx,publish)=>{
    deeplyFrozen(proof);deeplyFrozen(op);assert.deepEqual(op,f.operation);escaped=publish;
    receipt=terminal(proof,op,ctx,publish);assert.strictEqual(publish(publication(proof)),receipt);
    assert.equal(Object.getPrototypeOf(receipt),null);assert(Object.isFrozen(receipt));assert.deepEqual(Reflect.ownKeys(receipt),[]);return receipt;
  });
  deeplyFrozen(result);assert.deepEqual(Object.keys(result),['releaseMarker']);
  assert.equal(result.releaseMarker.terminalState,'active');assert.equal(result.releaseMarker.stateEvidenceHash,evidenceHash);
  assert.throws(()=>escaped(publication(f.held)),invalid);
  const bytes=fs.readFileSync(f.releasePath),st=fs.statSync(f.releasePath);
  const after=directoryState(join(f.registryRoot,'registry'));
  const stop=wrap({fsyncSync:real=>fd=>{fsyncs++;return real(fd);}});fsyncs=0;
  try {assert.deepEqual(read(f,p=>p.release),result.releaseMarker);assert.equal(fsyncs,0);} finally {stop();}
  assert.deepEqual(directoryState(join(f.registryRoot,'registry')),after);
  assert.deepEqual(invoke(f),result);assert.deepEqual(fs.readFileSync(f.releasePath),bytes);assert.equal(fs.statSync(f.releasePath).ino,st.ino);
  assert.deepEqual(names(f),holdNames);assert.deepEqual(f.registry.checkCleanup({backupId:f.record.backupId},context),{allowed:false,reason:'HOLD'});
  assert.throws(()=>f.registry.getHold({holdId:f.operation.holdId},context),mismatch);
  assert.throws(()=>withRecoverySource(f.registry,{backupId:f.record.backupId,recoveryRunId:f.operation.runId,stageHash:f.held.hold.stageHash,preparePlanHash:f.held.binding.preparePlanHash},context,()=>{}),mismatch);
  f.unchanged();
});
test('C genuine registry identity, strict operation snapshots and unbound refusal',{skip:unsupported},async t=>{
  const f=await setup(t),before=names(f);let calls=0;
  for (const registry of [{...f.registry},Object.create(f.registry),new Proxy(f.registry,{})]) {
    assert.throws(()=>createRecoveryHoldReleaser({registry,authority,approvalAuthority,verifyTerminal:terminal}),mismatch);
    assert.throws(()=>withRecoveryHold(registry,{backupId:f.record.backupId,holdId:f.operation.holdId},context,()=>{calls++;}),mismatch);
  }
  const api=f.make(()=>{calls++;});assert(Object.isFrozen(api));assert.deepEqual(Object.keys(api),['release']);
  for (const input of [null,{}, {...f.operation,extra:1},{...f.operation,path:f.root},{...f.operation,runId:'bad'}]) assert.throws(()=>api.release(input,context),invalid);
  const input={...f.operation};
  const mutate={authorizeAdmin:()=>{input.runId='bad';input.releasePlanHash='bad';return true;}};
  f.make((p,op,c,publish)=>{assert.equal(op.runId,f.operation.runId);assert.equal(op.releasePlanHash,planHash);return publish(publication(p));},{authority:mutate}).release(input,context);
  assert.equal(calls,0);assert.deepEqual(names(f),before);
  const unbound=await setup(t,{bound:false});assert.equal(read(unbound,p=>p.binding),null);
  assert.throws(()=>invoke(unbound),mismatch);assert.equal(fs.existsSync(unbound.releasePath),false);unbound.unchanged();
});
test('C independent approval/admin gates, revocation and known async zero-prefix',{skip:unsupported},async t=>{
  const f=await setup(t);let prefixes=0,approved=true;
  assert.throws(()=>f.make(async()=>{prefixes++;}),invalid);
  assert.throws(()=>read(f,async()=>{prefixes++;}),invalid);
  for (const options of [{authority:{authorizeAdmin:async()=>{prefixes++;return true;}}},{approvalAuthority:{authorizeApproval:async()=>{prefixes++;return true;}}}]) thrown(()=>invoke(f,terminal,options));
  const badRegistry=createImV2BackupRegistry({...f.options,authority:{authorizeAdmin:async()=>{prefixes++;return true;}}});
  assert.throws(()=>withRecoveryHold(badRegistry,{backupId:f.record.backupId,holdId:f.operation.holdId},context,()=>{prefixes++;}),{code:'RECOVERY_AUTH_DENIED'});
  for (const value of [false,0,1,'true',{},null,undefined]) for (const gate of ['authority','approvalAuthority']) {
    const method=gate==='authority'?'authorizeAdmin':'authorizeApproval';
    thrown(()=>invoke(f,terminal,{[gate]:{[method]:()=>value}}));
  }
  const approval={authorizeApproval:()=>approved};
  assert.throws(()=>invoke(f,(p,o,c,publish)=>{approved=false;return publish(publication(p));},{approvalAuthority:approval}),{code:'RECOVERY_APPROVAL_DENIED'});
  assert.equal(prefixes,0);assert.equal(fs.existsSync(f.releasePath),false);f.unchanged();
});
test('C mismatched current hold/run/hash, failed proof and changed exact-retry refs refuse',{skip:unsupported},async t=>{
  const f=await setup(t);let calls=0;
  for (const bad of [{...f.operation,runId:f.operation.backupId},{...f.operation,holdId:f.operation.runId},{...f.operation,backupId:f.operation.runId},{...f.operation,releasePlanHash:'f'.repeat(64)}]) thrown(()=>f.make(()=>{calls++;}).release(bad,context));
  assert.equal(calls,0);
  thrown(()=>invoke(f,()=>({terminalState:'failed',stateEvidenceHash:evidenceHash})));assert.equal(fs.existsSync(f.releasePath),false);
  thrown(()=>invoke(f,(p,o,c,pub)=>pub({...publication(p),terminalState:'failed'})));assert.equal(fs.existsSync(f.releasePath),false);
  invoke(f);const original=fs.readFileSync(f.releasePath);
  thrown(()=>invoke(f,(p,o,c,pub)=>pub({...publication(p),stateEvidenceHash:'f'.repeat(64)})));
  thrown(()=>f.make(terminal,{approvalAuthority:{authorizeApproval:()=>true}}).release({...f.operation,approvalRef:'different'},context));
  assert.deepEqual(fs.readFileSync(f.releasePath),original);f.unchanged();
});
test('C publication receipt identity, caught poison and escaped capability expiration',{skip:unsupported},async t=>{
  const f=await setup(t);let escaped,prior;
  for (const after of ['changed','malformed','counterfeit','prior','falsy']) {
    thrown(()=>invoke(f,(p,o,c,publish)=>{
      escaped=publish;const receipt=publish(publication(p));
      if(after==='changed')thrown(()=>publish({...publication(p),stateEvidenceHash:'f'.repeat(64)}));
      if(after==='malformed')thrown(()=>publish({...publication(p),extra:true}));
      if(after==='counterfeit')return Object.freeze(Object.create(null));
      if(after==='prior')return prior;
      if(after==='falsy')return false;
      prior=receipt;return receipt;
    }));
    assert.throws(()=>escaped(publication(f.held)),invalid);
    assert.equal(fs.existsSync(f.releasePath),true,'published evidence is retained after verifier failure');
    assert.deepEqual(read(f,p=>p.release),JSON.parse(fs.readFileSync(f.releasePath)));
  }
  for (const bad of [null,{}, {...publication(f.held),stateEvidenceHash:'bad'}]) thrown(()=>invoke(f,(p,o,c,pub)=>{thrown(()=>pub(bad));thrown(()=>pub(publication(p)));return prior;}));
  assert.doesNotThrow(()=>invoke(f));f.unchanged();
});
test('C all falsy throws are failures; read callback preserves thrown identity, release sanitizes',{skip:unsupported},async t=>{
  const f=await setup(t);
  for (const value of [null,false,0,'',undefined]) {
    thrown(()=>read(f,()=>{throw value;}),error=>error===value);
    assert.throws(()=>invoke(f,()=>{throw value;}),{code:'RECOVERY_CALLBACK_FAILED'});
    assert.throws(()=>invoke(f,(p,o,c,pub)=>{pub(publication(p));throw value;}),{code:'RECOVERY_CALLBACK_FAILED'});
    assert.equal(fs.existsSync(f.releasePath),true);
    for (const gate of ['authority','approvalAuthority']) {
      const key=gate==='authority'?'authorizeAdmin':'authorizeApproval';
      thrown(()=>invoke(f,terminal,{[gate]:{[key]:()=>{throw value;}}}));
    }
  }
  assert.doesNotThrow(()=>invoke(f));assert.equal(f.registry.checkCleanup({backupId:f.record.backupId},context).allowed,false);f.unchanged();
});
test('C unexpected promises are observed; malformed promise publisher poisons even if caught',{skip:unsupported},async t=>{
  const f=await setup(t);
  thrown(()=>read(f,()=>Promise.reject(Error('TEST_ONLY read rejection'))));
  thrown(()=>invoke(f,()=>Promise.reject(Error('TEST_ONLY verifier rejection'))));
  for (const gate of ['authority','approvalAuthority']) {
    const method=gate==='authority'?'authorizeAdmin':'authorizeApproval';
    thrown(()=>invoke(f,terminal,{[gate]:{[method]:()=>Promise.reject(Error('TEST_ONLY gate rejection'))}}));
  }
  thrown(()=>invoke(f,(p,o,c,pub)=>{thrown(()=>pub(Promise.reject(Error('TEST_ONLY publisher rejection'))));return {}; }));
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(fs.existsSync(f.releasePath),false);f.unchanged();
});
test('C rejection after durable publish refuses outer success and preserves the exact marker',{skip:unsupported},async t=>{
  const f=await setup(t);let escaped;
  thrown(()=>invoke(f,(p,o,c,pub)=>{escaped=pub;pub(publication(p));return Promise.reject(Error('TEST_ONLY post-publication rejection'));}));
  const bytes=fs.readFileSync(f.releasePath),ino=fs.statSync(f.releasePath).ino;
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.throws(()=>escaped(publication(f.held)),invalid);
  invoke(f);assert.deepEqual(fs.readFileSync(f.releasePath),bytes);assert.equal(fs.statSync(f.releasePath).ino,ino);f.unchanged();
});
test('C registry own admin gate is rechecked at publication independently of composition admin',{skip:unsupported},async t=>{
  const f=await setup(t);let permitted=true;
  const registry=createImV2BackupRegistry({...f.options,authority:{authorizeAdmin:()=>permitted}});
  assert.throws(()=>invoke(f,(p,o,c,pub)=>{permitted=false;return pub(publication(p));},{registry}),{code:'RECOVERY_AUTH_DENIED'});
  assert.equal(fs.existsSync(f.releasePath),false);assert.equal(names(f).length,2);f.unchanged();
});
for (const at of ['clock','publication']) test(`C caught reentrant ${at} poisons even if publication has durable bytes`,{skip:unsupported},async t=>{
  const f=await setup(t);let publish,reentered=false;
  const reenter=()=>{if(!reentered){reentered=true;thrown(()=>publish(publication(f.held)));}};
  const registry=at==='clock'?createImV2BackupRegistry({...f.options,clock:()=>{reenter();return Date.now();}}):f.registry;
  const restore=wrap({linkSync:real=>(...args)=>{const result=real(...args);if(at==='publication'&&dirname(args[1])===dirname(f.releasePath))reenter();return result;}});
  try {thrown(()=>invoke(f,(p,o,c,pub)=>{publish=pub;try{return pub(publication(p));}catch{return {};}},{registry}));} finally {restore();}
  assert.equal(reentered,true);assert.throws(()=>publish(publication(f.held)),invalid);
  assert.equal(fs.existsSync(f.releasePath),at==='publication');assert.doesNotThrow(()=>invoke(f));f.unchanged();
});
for (const faultAt of ['file','directory']) test(`C real ${faultAt} fsync failure: persistent refusal, same-inode/time durable retry`,{skip:unsupported},async t=>{
  const f=await setup(t),holds=names(f);let fault=true,failed=0,resynced=0,linked=0;
  // First leave a genuine durable marker behind a verifier exception; retry is
  // the same protected final inode for both file and directory fault injection.
  thrown(()=>invoke(f,(p,o,c,pub)=>{pub(publication(p));throw null;}));
  const bytes=fs.readFileSync(f.releasePath),identity=fs.statSync(f.releasePath),dir=fs.statSync(dirname(f.releasePath));
  const matches=s=>s.ino===(faultAt==='file'?identity:dir).ino&&s.dev===(faultAt==='file'?identity:dir).dev;
  const restore=wrap({linkSync:real=>(...args)=>{linked++;return real(...args);},fsyncSync:real=>fd=>{const result=real(fd);if(matches(fs.fstatSync(fd))){if(fault){failed++;throw Error('TEST_ONLY after real fsync');}resynced++;}return result;}});
  try {
    for(let n=0;n<2;n++) assert.throws(()=>invoke(f),{code:'RECOVERY_DURABILITY_UNCERTAIN'});
    fault=false;assert.deepEqual(invoke(f).releaseMarker,JSON.parse(bytes));
  } finally {restore();}
  assert.equal(failed,2);assert.ok(resynced>0);assert.equal(linked,0);assert.deepEqual(fs.readFileSync(f.releasePath),bytes);assert.equal(fs.statSync(f.releasePath).ino,identity.ino);assert.deepEqual(names(f),holds);f.unchanged();
});
test('C first publication directory failure retains marker and exact retry cannot trust visibility',{skip:unsupported},async t=>{
  const f=await setup(t),dir=fs.statSync(dirname(f.releasePath));let fault=true,failures=0;
  const restore=wrap({fsyncSync:real=>fd=>{const result=real(fd),s=fs.fstatSync(fd);if(fault&&s.ino===dir.ino&&s.dev===dir.dev){failures++;throw Error('TEST_ONLY dir uncertainty');}return result;}});
  try {
    assert.throws(()=>invoke(f),{code:'RECOVERY_DURABILITY_UNCERTAIN'});const bytes=fs.readFileSync(f.releasePath),ino=fs.statSync(f.releasePath).ino;
    assert.throws(()=>invoke(f),{code:'RECOVERY_DURABILITY_UNCERTAIN'});fault=false;invoke(f);
    assert.deepEqual(fs.readFileSync(f.releasePath),bytes);assert.equal(fs.statSync(f.releasePath).ino,ino);assert.equal(failures,2);
  } finally {restore();}f.unchanged();
});
test('C first publication file fsync failure retains owned pending evidence and cannot claim release',{skip:unsupported},async t=>{
  const f=await setup(t),dir=dirname(f.releasePath);let fault=true,failures=0;
  const restore=wrap({fsyncSync:real=>fd=>{
    const result=real(fd),s=fs.fstatSync(fd);
    if(fault&&s.isFile()&&fs.readdirSync(dir).some(name=>{const p=fs.statSync(join(dir,name));return p.ino===s.ino&&p.dev===s.dev;})){failures++;throw Error('TEST_ONLY initial file uncertainty');}
    return result;
  }});
  try {
    for(let n=0;n<2;n++)assert.throws(()=>invoke(f),{code:'RECOVERY_DURABILITY_UNCERTAIN'});
    assert.equal(fs.existsSync(f.releasePath),false);assert.equal(failures,2);
    const pending=fs.readdirSync(dir);assert.equal(pending.length,2);assert(pending.every(name=>name.endsWith('.pending')));
    fault=false;invoke(f);for(const name of pending)assert(fs.existsSync(join(dir,name)),'uncertain pending evidence retained');
  } finally {restore();}assert.equal(names(f).length,2);f.unchanged();
});
test('C strict marker read fails closed for historical failed or mismatched current run',{skip:unsupported},async t=>{
  const f=await setup(t);invoke(f);const original=JSON.parse(fs.readFileSync(f.releasePath));
  // Test-only corruptions, never a production marker writer.
  for (const bad of [{...original,terminalState:'failed'},{...original,recoveryRunId:f.operation.backupId},{...original,holdId:f.operation.runId},{...original,extra:true}]) {
    fs.writeFileSync(f.releasePath,JSON.stringify(bad));assert.throws(()=>read(f,()=>{}),mismatch);thrown(()=>invoke(f));
  }
  f.unchanged();
});
for (const v3 of [false,true]) for (const exceptional of [false,true]) test(`C two-process terminal + publication barrier ${v3?'v3':'v4'} ${exceptional?'failure':'success'}`,{skip:unsupported,timeout:60000},async t=>{
  // If owned child termination cannot be confirmed, retain all fixture files.
  const children=processes(),cleanups=[];
  t.after(async()=>{await children.stop();for(const cleanup of cleanups)await cleanup();});
  const f=await setup({after:callback=>cleanups.push(callback),diagnostic:value=>t.diagnostic(value)},{v3});
  const holder=children.start({mode:'holder',root:f.registryRoot,operation:f.operation,exceptional});await holder.go();
  for(const phase of ['terminal','publication']) {
    const message=await holder.next(phase);
    const contender=children.start({mode:'contender',root:f.registryRoot,operation:f.operation});await contender.go();const observed=await contender.next('complete');const lifecycle=await contender.ended();
    assert.notEqual(observed.pid,holder.pid);assert.deepEqual(observed.outcome,{ok:false,code:'RECOVERY_BUSY'});
    t.diagnostic(JSON.stringify({phase,holderPid:holder.pid,contenderPid:observed.pid,...lifecycle}));await holder.release(message.sequence);
  }
  const complete=await holder.next('complete');assert.equal(complete.failed,exceptional);t.diagnostic(JSON.stringify({holderPid:holder.pid,...await holder.ended()}));
  const after=children.start({mode:'contender',root:f.registryRoot,operation:f.operation});await after.go();assert.deepEqual((await after.next('complete')).outcome,{ok:true});t.diagnostic(JSON.stringify({postReleasePid:after.pid,...await after.ended()}));
  assert.equal(fs.existsSync(f.releasePath),true);assert.equal(names(f).length,2);f.unchanged();
});
test('Windows strict native registry is honestly unsupported',{skip:!unsupported},()=>{
  assert.throws(()=>createImV2BackupRegistry({root:process.cwd()}),{code:'RECOVERY_UNSUPPORTED'});
});
