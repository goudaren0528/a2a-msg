// All native wrappers live only in this owned isolated child. Original operations
// run first; injected exceptions are observations of precise durable boundaries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join,dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createImV2RecoveryServices } from '../../../src/im/v2/recovery.js';
import { validateRecoveryNormalizationBindings,validateRecoveryPauseBindings } from '../../../src/im/v2/recovery-plan.js';
import { setup,context,request,openOptions,tree,query,rowsDigest,hashFile,header,json,assertChain,records } from './helpers.js';
import { filenames,bytes,rechain,chainForStage } from './records.js';
import { runChild } from './processes.js';

function locator(s) {
  const names=fs.readdirSync(join(s.root,'requests')).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));assert.equal(names.length,1);
  const path=join(s.root,'requests',names[0]);return {path,bytes:fs.readFileSync(path),...json(path)};
}
function watch(s,{point=null,observe=false}={}) {
  const original=Object.fromEntries(['openSync','closeSync','fsyncSync','linkSync','unlinkSync','writeSync'].map(k=>[k,fs[k]]));
  const exec=DatabaseSync.prototype.exec,prepare=DatabaseSync.prototype.prepare,close=DatabaseSync.prototype.close,descriptors=new Map(),events=[],copyWrites=[];
  let reached=false,lastPublication=null,candidateSynced=false,phase=false,normalizationRows,normalizedHash,pauseRows,normalizationNativeClosed=false;
  const normalizationConnections=new WeakSet();
  const fault=label=>{reached=true;events.push(['FAULT',label]);throw Error('test-only '+label);};
  fs.openSync=(...args)=>{const fd=original.openSync(...args);descriptors.set(fd,String(args[0]));events.push(['open',String(args[0]),args[1]]);if(phase)events.push(['normalization-open',String(args[0]),args[1]]);return fd;};
  fs.closeSync=fd=>{const out=original.closeSync(fd);descriptors.delete(fd);return out;};
  fs.linkSync=(...args)=>{
    const out=original.linkSync(...args),target=String(args[1]);events.push(['link',target]);lastPublication=target;
    if(target.endsWith('/candidate.sqlite')) {
      const writes=copyWrites.filter(e=>e.path===String(args[0]));
      assert.ok(writes.length>0,'real candidate streaming copy observed');
      for(const write of writes)assert.equal(write.intentDurable,true,'copyIntent directory fsync before every candidate copy byte');
    }
      if(target.endsWith('/normalized.json')) {
      phase=false;
      const path=join(dirname(target),'candidate.sqlite');
      assert.deepEqual(header(path),[1,1]);normalizedHash=hashFile(path);
      normalizationRows=query(path,db=>rowsDigest(db));
      assert.deepEqual(normalizationRows,s.sourceRows,'normalization preserves every typed row and schema entry');
    }
    if(target.endsWith('/paused.json')) {
      const candidate=join(dirname(target),'candidate.sqlite');
      pauseRows=query(candidate,db=>rowsDigest(db,{exclude:['im_settings']}));
      assert.equal(json(target).pausedCandidateHash,hashFile(candidate),'paused hash is actual pre-P1 candidate bytes');
      assert.equal(query(candidate,db=>db.prepare('SELECT write_mode FROM im_settings').get().write_mode),'paused');
    }
    if(point==='doublelink'&&target.endsWith('/candidate.sqlite')&&!reached)fault('candidate-link-before-temp-unlink');
    return out;
  };
  fs.unlinkSync=(...args)=>{const out=original.unlinkSync(...args);events.push(['unlink',String(args[0])]);return out;};
  fs.writeSync=(...args)=>{
    if(args[1]?.subarray?.(0,16).toString()==='SQLite format 3\0') {
      const candidateDirectory=dirname(descriptors.get(args[0]));
      const intent=join(candidateDirectory,'copy-intent.json');
      const published=events.findIndex(e=>e[0]==='link'&&e[1]===intent);
      const intentDurable=published>=0&&events.slice(published).some(e=>e[0]==='fsync'&&e[1]===candidateDirectory)&&fs.existsSync(intent);
      copyWrites.push({path:descriptors.get(args[0]),intentDurable});
      events.push([intentDurable?'candidate-copy-start':'source-observation-copy-start']);
    }
    if(point==='partial16'&&!reached&&args[1]?.subarray?.(0,16).toString()==='SQLite format 3\0'&&
        fs.existsSync(join(dirname(descriptors.get(args[0])),'copy-intent.json'))) {
      const count=original.writeSync(args[0],args[1],args[2],16);assert.equal(count,16);fault('partial16');
    }
    return original.writeSync(...args);
  };
  fs.fsyncSync=fd=>{
    const out=original.fsyncSync(fd),path=descriptors.get(fd);events.push(['fsync',path]);
    if(path?.endsWith('/candidate.sqlite'))candidateSynced=true;
    if(path&&/\/runs\/[a-f0-9-]{36}$/.test(path)) {
      const candidate=join(path,'candidate.sqlite');
      if(lastPublication===join(path,'normalization-intent.json')) {
        phase=true;
        if(point==='intent-durable'&&!reached)fault('normalization-intent-file-link-unlink-dirfsync-complete');
      }
      if(point==='copy-durable'&&!reached&&lastPublication===candidate&&fs.existsSync(candidate)&&!fs.existsSync(join(path,'base.json'))) {
        assert.equal(fs.readdirSync(path).some(n=>n.endsWith('.pending')),false);
        assert.equal(fs.statSync(candidate).nlink,1);
        const linked=events.findIndex(e=>e[0]==='link'&&e[1]===candidate);
        assert.ok(linked>=0);assert.ok(events.slice(0,linked).some(e=>e[0]==='fsync'&&e[1]?.endsWith('.pending')));
        assert.ok(events.slice(linked).some(e=>e[0]==='unlink'&&e[1]?.endsWith('.pending')));
        assert.ok(fs.existsSync(join(path,'copy-intent.json')));
        assert.equal(hashFile(candidate),json(join(path,'copy-intent.json')).candidateBaseHash);
        fault('candidate-filefsync-link-tempunlink-directoryfsync-complete-before-base');
      }
      if(point==='normalization-committed'&&!reached&&candidateSynced&&fs.existsSync(join(path,'normalization-intent.json'))&&!fs.existsSync(join(path,'normalized.json'))&&header(candidate).every(v=>v===1)) {
        assert.equal(normalizationNativeClosed,true,'observed original native close after conversion SQL');
        assert.equal(fs.readdirSync(path).some(n=>/^candidate\.sqlite-(wal|shm|journal)$/.test(n)),false);
        assert.deepEqual(query(candidate,db=>rowsDigest(db)),s.sourceRows);
        fault('normalization-native-closed-file-and-directory-synced-before-normalized');
      }
      if(point==='p1-committed'&&!reached&&candidateSynced&&fs.existsSync(join(path,'paused.json'))&&!fs.existsSync(join(path,'staged.json'))) {
        const version=query(candidate,db=>db.prepare('SELECT version FROM im_schema').get().version);
        if(version===4)fault('p1-commit-closed-synced-before-staged');
      }
    }
    return out;
  };
  DatabaseSync.prototype.exec=function(sql){const out=exec.call(this,sql);if(phase){events.push(['normalization-sql','exec',sql]);if(/journal_mode\s*=\s*DELETE/i.test(sql))normalizationConnections.add(this);}return out;};
  DatabaseSync.prototype.prepare=function(sql){const out=prepare.call(this,sql);if(phase){events.push(['normalization-sql','prepare',sql]);if(/journal_mode\s*=\s*DELETE/i.test(sql))normalizationConnections.add(this);}return out;};
  DatabaseSync.prototype.close=function(){const out=close.call(this);if(normalizationConnections.has(this)){normalizationNativeClosed=true;events.push(['normalization-native-close']);}return out;};
  syncBuiltinESMExports();
  return {events,get reached(){return reached;},get normalizationRows(){return normalizationRows;},get normalizedHash(){return normalizedHash;},get pauseRows(){return pauseRows;},
    restore(){Object.assign(fs,original);DatabaseSync.prototype.exec=exec;DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.close=close;syncBuiltinESMExports();}};
}

function readonlyStatus(s,runId) {
  const before=tree(s.root),registryBefore=s.services?tree(s.registryRoot):null,
    original=Object.fromEntries(['openSync','writeSync','writeFileSync','fsyncSync','linkSync','mkdirSync','unlinkSync','renameSync'].map(k=>[k,fs[k]]));
  const exec=DatabaseSync.prototype.exec,prepare=DatabaseSync.prototype.prepare;let writes=0;
  for(const key of Object.keys(original))fs[key]=(...args)=>{
    if(key==='openSync') {
      const flag=args[1];
      // Existing coordinator initialization probe fails EEXIST before any write.
      // Call the original: an actual successful creation remains a test failure.
      if(typeof flag==='number'&&(flag&fs.constants.O_EXCL)&&(flag&fs.constants.O_CREAT)) {
        const fd=original.openSync(...args);fs.closeSync(fd);writes++;throw Error('status created lockfile');
      }
      if(typeof flag==='number'?(flag&(fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_WRONLY))!==0:/[wa+]/.test(flag)){writes++;throw Error('status filesystem write open');}
      return original[key](...args);
    }
    writes++;throw Error('status filesystem mutation '+key);
  };
  const sqlCheck=sql=>{if(/\b(UPDATE|INSERT|DELETE|REPLACE|CREATE|DROP|CHECKPOINT|VACUUM)\b/i.test(sql)){writes++;throw Error('status mutating SQL');}};
  DatabaseSync.prototype.exec=function(sql){sqlCheck(sql);return exec.call(this,sql);};
  DatabaseSync.prototype.prepare=function(sql){sqlCheck(sql);return prepare.call(this,sql);};
  syncBuiltinESMExports();let result;
  try{result=s.open().getRecoveryStatus({runId},context);}finally{Object.assign(fs,original);DatabaseSync.prototype.exec=exec;DatabaseSync.prototype.prepare=prepare;syncBuiltinESMExports();}
  assert.equal(writes,0);assert.deepEqual(tree(s.root),before);
  if(registryBefore)assert.deepEqual(tree(s.registryRoot),registryBefore,'readonly status retains registry evidence');
  return result;
}

async function scenario(input) {
  if(input.scenario==='reopen') {
    const options=openOptions(input.root,input.source,input.now),api=createImV2RecoveryServices(options),before=tree(input.root);
    const writes=fs.writeSync;let copies=0;
    fs.writeSync=(...args)=>{if(args[1]?.subarray?.(0,16).toString()==='SQLite format 3\0')copies++;return writes(...args);};syncBuiltinESMExports();
    let staged;try{staged=api.stageCandidate(request(),context);}finally{fs.writeSync=writes;syncBuiltinESMExports();}
    assert.equal(copies,0,'reopen must not recopy');
    return {scenario:'reopen',passed:true,staged,copies,beforeFiles:Object.keys(before).length};
  }
  const name=input.scenario,registered=name.startsWith('registered-'),snapshot=name.startsWith('snapshot-');
  const wal=!['delete-noop','snapshot-delete','snapshot-stale-hash'].includes(name),mode=snapshot||name.endsWith('enabled')?'enabled':'paused';
  const s=await setup({route:registered?'registered':snapshot?'snapshot':'closed',wal,mode});
  const childCleanups=[],t={after:fn=>childCleanups.push(fn),diagnostic:message=>console.log(message)};
  let observation;
  try {
    if(name.startsWith('fresh-evidence-')) {
      const kind=name.slice('fresh-evidence-'.length),freshInput={requestRef:'fresh',candidateKind:'fresh_bootstrap',sourceRef:null,isolationAckRef:null};
      const stage=s.open().stageCandidate(freshInput,context),dir=join(s.root,'runs',stage.runId);
      for(const file of Object.values(filenames))assert.equal(fs.existsSync(join(dir,file)),false,'fresh has no source evidence');
      const original=json(join(dir,'stage.json'));
      const synthetic={...original,candidateKind:'v3_import',sourceEvidence:{fileHash:'a'.repeat(64),schemaVersion:3,
        schemaChecksum:query(s.artifact,db=>db.prepare('SELECT migration_checksum FROM im_schema').get().migration_checksum,{immutable:true})}};
      const injected=chainForStage(synthetic)[kind];fs.writeFileSync(join(dir,filenames[kind]),bytes(kind,injected),{mode:0o600});
      const status=readonlyStatus(s,stage.runId);assert.equal(status.state,'indeterminate');assert.equal(status.nextAction,'MANUAL_RECONCILIATION');
      const before=tree(s.root);assert.throws(()=>s.open().stageCandidate(freshInput,context));assert.deepEqual(tree(s.root),before);
      return {scenario:name,passed:true};
    }
    if(name.startsWith('source-')&&name!=='sourcechanged') {
      const suffix='-'+name.slice('source-'.length);fs.writeFileSync(s.source+suffix,'',{mode:0o600});
      const before=tree(s.root),sourceHash=hashFile(s.source);
      assert.throws(()=>s.open().stageCandidate(s.input,context));
      assert.deepEqual(tree(s.root),before);assert.equal(hashFile(s.source),sourceHash);assert.equal(fs.statSync(s.source+suffix).size,0);
      return {scenario:name,passed:true,sourceSidecar:suffix};
    }
    const negative=['partial16','wronghash','missing-copy-intent','doublelink','pending','sourcechanged','candidate-wal','candidate-shm','candidate-journal','old-base-v1'];
    const faultPoint=negative.includes(name)?(['partial16','doublelink'].includes(name)?name:'copy-durable'):
      ['copy-durable','intent-durable','normalization-committed'].includes(name)?name:
      ['p1-committed','p1-broken-chain'].includes(name)?'p1-committed':null;
    observation=watch(s,{point:faultPoint,observe:true});
    let staged;
    try {
      if(faultPoint)assert.throws(()=>s.open().stageCandidate(s.input,context));
      else staged=s.open().stageCandidate(s.input,context);
    }finally{observation.restore();}
    if(faultPoint)assert.equal(observation.reached,true,`precise phase not reached: ${faultPoint}`);
    const l=locator(s),dir=join(s.root,'runs',l.runId),candidate=join(dir,'candidate.sqlite');
    const originalCopy=fs.existsSync(join(dir,'copy-intent.json'))?fs.readFileSync(join(dir,'copy-intent.json')):null;
    const sourceHash=hashFile(s.artifact);
    if(negative.includes(name)) {
      if(name==='partial16') {const pending=fs.readdirSync(dir).filter(n=>n.endsWith('.pending'));assert.equal(pending.length,1);assert.equal(fs.statSync(join(dir,pending[0])).size,16);}
      if(name==='wronghash'){const data=fs.readFileSync(candidate);data[data.length-1]^=1;fs.writeFileSync(candidate,data);}
      if(name==='missing-copy-intent')fs.unlinkSync(join(dir,'copy-intent.json'));
      if(name==='old-base-v1') {
        const c=json(join(dir,'copy-intent.json'));
        const old={version:1,runId:c.runId,stageHash:c.stageHash,candidateReference:c.candidateReference,candidateBaseHash:c.candidateBaseHash,
          sourceSchemaVersion:c.sourceSchemaVersion,sourceSchemaChecksum:c.sourceSchemaChecksum,sourceWriteMode:c.sourceWriteMode,copiedAt:c.copyStartedAt};
        fs.writeFileSync(join(dir,'base.json'),JSON.stringify(old),{mode:0o600});
      }
      if(name==='pending')fs.writeFileSync(join(dir,'unknown.pending'),'unproven',{mode:0o600});
      if(name==='sourcechanged'){const data=fs.readFileSync(s.source);data[data.length-1]^=1;fs.writeFileSync(s.source,data);}
      if(name.startsWith('candidate-'))fs.writeFileSync(candidate+'-'+name.slice(10),'',{mode:0o600});
      const before=tree(s.root),sourceBefore=hashFile(s.source);
      assert.throws(()=>s.open().stageCandidate(s.input,context));assert.deepEqual(tree(s.root),before);
      // A changed authenticated source cannot pass the outer source authority;
      // facade rejection is stronger than merely classifying candidate bytes.
      if(name==='sourcechanged')assert.throws(()=>s.open().getRecoveryStatus({runId:l.runId},context),{code:'RECOVERY_EVIDENCE_MISMATCH'});
      else {const status=readonlyStatus(s,l.runId);assert.equal(status.state,'indeterminate');assert.equal(status.nextAction,'MANUAL_RECONCILIATION');}
      assert.deepEqual(tree(s.root),before);assert.equal(hashFile(s.source),sourceBefore);
      return {scenario:name,passed:true,faultPhases:observation.events.filter(e=>e[0]==='FAULT'),retained:Object.keys(before)};
    }
    if(name==='normalization-committed') {
      assert.deepEqual(header(candidate),[1,1]);assert.notEqual(hashFile(candidate),sourceHash);
      assert.equal(fs.existsSync(join(dir,'normalized.json')),false);assert.ok(fs.existsSync(join(dir,'normalization-intent.json')));
      const before=tree(s.root);assert.throws(()=>s.open().stageCandidate(s.input,context),{code:'RECOVERY_INDETERMINATE'});
      const status=readonlyStatus(s,l.runId);assert.equal(status.state,'indeterminate');assert.equal(status.nextAction,'MANUAL_RECONCILIATION');
      assert.deepEqual(tree(s.root),before);s.unchanged();return {scenario:name,passed:true,faultPhases:observation.events.filter(e=>e[0]==='FAULT')};
    }
    if(name==='p1-broken-chain') {
      const f=records(dir);f.normalizationIntent.originalHeaderMode='DELETE';rechain(f);
      for(const kind of ['normalizationIntent','normalized','pauseIntent','paused'])fs.writeFileSync(join(dir,filenames[kind]),bytes(kind,f[kind]));
      const before=tree(s.root);assert.throws(()=>s.open().stageCandidate(s.input,context));assert.deepEqual(tree(s.root),before);
      assert.equal(readonlyStatus(s,l.runId).nextAction,'MANUAL_RECONCILIATION');
      return {scenario:name,passed:true};
    }
    if(['copy-durable','intent-durable','p1-committed'].includes(name)) {
      if(name==='copy-durable'){assert.equal(fs.existsSync(join(dir,'base.json')),false);assert.equal(hashFile(candidate),sourceHash);}
      if(name==='intent-durable'){assert.equal(fs.existsSync(join(dir,'normalized.json')),false);assert.equal(hashFile(candidate),sourceHash);assert.deepEqual(header(candidate),[2,2]);}
      const identity=name==='p1-committed'?query(candidate,db=>db.prepare('SELECT initial_epoch,import_epoch FROM im_schema_preparations WHERE preparation_ref=?').get(l.stage.preparationRef)):null;
      const result=await runChild(t,{scenario:'reopen',root:s.root,source:s.source,now:s.now+1000});
      s.options.clock=()=>s.now+1000;
      staged=result.staged;assert.equal(staged.runId,l.runId);assert.deepEqual(fs.readFileSync(l.path),l.bytes);
      assert.deepEqual(fs.readFileSync(join(dir,'copy-intent.json')),originalCopy);
      if(identity){assert.equal(staged.initialEpoch,identity.initial_epoch);assert.equal(staged.importEpoch,identity.import_epoch);}
    }
    if(['broken-chain-status','coherent-tamper-status'].includes(name)) {
      const f=assertChain(dir);assert.deepEqual(validateRecoveryPauseBindings(f),f.paused);
      if(name==='broken-chain-status')f.normalized.normalizationIntentHash='a'.repeat(64);
      else {
        for(const kind of Object.keys(filenames))f[kind].candidateBaseHash='a'.repeat(64);
        rechain(f);
        assert.deepEqual(f.stage,json(join(dir,'stage.json')));
      }
      for(const kind of Object.keys(filenames))fs.writeFileSync(join(dir,filenames[kind]),bytes(kind,f[kind]));
      const status=readonlyStatus(s,l.runId);assert.equal(status.state,'indeterminate');assert.equal(status.nextAction,'MANUAL_RECONCILIATION');
      s.unchanged();return {scenario:name,passed:true};
    }
    const chain=assertChain(dir,{paused:!snapshot});assert.deepEqual(validateRecoveryNormalizationBindings(chain),chain.normalized);
    if(!snapshot)assert.deepEqual(validateRecoveryPauseBindings(chain),chain.paused);
    assert.equal(chain.base.candidateBaseHash,sourceHash);
    if(!faultPoint) {
      assert.equal(chain.normalized.normalizedCandidateHash,observation.normalizedHash);
      assert.deepEqual(observation.normalizationRows,s.sourceRows);
      if(!snapshot)assert.deepEqual(observation.pauseRows,rowsDigest(s.sourceDb,{exclude:['im_settings']}),'pause changes only write_mode');
    }
    if(wal){assert.equal(chain.normalized.changed,true);assert.equal(chain.normalizationIntent.originalHeaderMode,'WAL');assert.notEqual(chain.normalized.normalizedCandidateHash,sourceHash);}
    else {assert.equal(chain.normalized.changed,false);assert.equal(chain.normalized.normalizedCandidateHash,sourceHash);}
    if(name==='delete-noop') {
      assert.deepEqual(observation.events.filter(e=>e[0]==='normalization-sql'),[],'DELETE normalization does not open SQLite or run PRAGMA');
      assert.deepEqual(observation.events.filter(e=>e[0]==='normalization-open'&&e[1]===candidate&&
        (typeof e[2]==='number'?(e[2]&(fs.constants.O_RDWR|fs.constants.O_WRONLY))!==0:/[wa+]/.test(e[2]))),[],
        'DELETE no-op has no writable candidate file open');
    }
    if(name==='snapshot-stale-hash') {
      const db=new DatabaseSync(candidate);try{db.exec("UPDATE im_agents SET display_name='tampered candidate'");}finally{db.close();}
      const before=tree(s.root);assert.throws(()=>s.open().previewRecovery({runId:l.runId},context),{code:'RECOVERY_EVIDENCE_MISMATCH'});
      assert.equal(readonlyStatus(s,l.runId).nextAction,'MANUAL_RECONCILIATION');assert.deepEqual(tree(s.root),before);return {scenario:name,passed:true};
    }
    const api=s.open();
    if(snapshot) {
      const status=readonlyStatus(s,staged.runId);assert.equal(status.state,'staged');
      assert.equal(status.newEpoch,null);assert.equal(status.writeMode,'enabled');
    }
    const preview=api.previewRecovery({runId:staged.runId},context);
    if(snapshot)assert.equal(hashFile(candidate),chain.normalized.normalizedCandidateHash,'snapshot preview validates pre-run normalized candidate hash');
    const prepared=api.prepareRecovery({runId:staged.runId,preparePlanHash:preview.preparePlanHash,approvalRef:'prepare-ok'},context);
    assert.equal(prepared.status,'prepared');assert.deepEqual(header(candidate),[1,1]);
    query(candidate,db=>{
      assert.equal(db.prepare('SELECT write_mode FROM im_settings').get().write_mode,'paused');
      const run=db.prepare('SELECT * FROM im_recovery_runs').get();assert.equal(run.status,'prepared');assert.equal(run.activation_ref,null);
      if(registered||snapshot){assert.equal(run.candidate_base_hash,sourceHash);assert.equal(run.backup_file_hash,sourceHash);}
      assert.equal(db.prepare('SELECT count(*) n FROM im_receiver_leases').get().n,0);
    });
    assert.equal(readonlyStatus(s,staged.runId).state,'prepared');
    if(snapshot) {
      assert.notEqual(hashFile(candidate),chain.normalized.normalizedCandidateHash,'legitimate prepare changes snapshot bytes');
      const before=tree(s.root),registryBefore=tree(s.registryRoot);
      assert.deepEqual(s.open().prepareRecovery({runId:staged.runId,preparePlanHash:preview.preparePlanHash,approvalRef:'prepare-ok'},context),prepared);
      assert.deepEqual(tree(s.root),before);assert.deepEqual(tree(s.registryRoot),registryBefore);
    }
    s.unchanged();
    return {scenario:name,passed:true,faultPhases:observation.events.filter(e=>e[0]==='FAULT'),baseHash:sourceHash,normalizedHash:chain.normalized.normalizedCandidateHash,
      typedRows:s.sourceRows,unreachable:snapshot?'current public A v4 producer normalizes DELETE; genuine registered WAL-v4 not minted':null};
  }finally{
    observation?.restore();
    for(const cleanup of childCleanups)await cleanup();
    await s.cleanup();
  }
}

process.once('message',async input=>{
  try {const result=await scenario(input);process.send({phase:'result',...result},()=>process.disconnect());}
  catch(error){console.error(error.stack);process.exitCode=1;process.send({phase:'failure',message:error.message,stack:error.stack},()=>process.disconnect());}
});
process.send({phase:'ready'});
