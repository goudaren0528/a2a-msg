// TEST ONLY terminal verifier and syscall barrier; never activates a candidate.
import assert from 'node:assert/strict';
import { dirname,join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createImV2BackupRegistry,createRecoveryHoldReleaser } from '../../../src/im/v2/backup-registry.js';
import { authority,approvalAuthority,context,evidenceHash,terminal,wrap } from './helpers.js';
const send=message=>process.send({...message,pid:process.pid});
process.once('message',async({mode,root,operation,exceptional})=>{
  let worker,restore=()=>{};
  try {
    const registry=createImV2BackupRegistry({root,authority});
    if(mode==='contender') {
      let outcome;
      try{registry.verify({backupId:operation.backupId},context);outcome={ok:true};}
      catch(e){outcome={ok:false,code:e?.code??'UNEXPECTED'};}
      send({phase:'complete',outcome});
    } else {
      assert.equal(mode,'holder');const state=new Int32Array(new SharedArrayBuffer(8));
      worker=new Worker(new URL('./barrier.js',import.meta.url),{workerData:{state:state.buffer}});
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('worker readiness deadline')),3000);
        worker.once('message',message=>{clearTimeout(timer);assert.equal(message,'ready');resolve();});
        worker.once('error',error=>{clearTimeout(timer);reject(error);});
      });
      let sequence=0,published=false;
      const barrier=phase=>{
        send({phase,sequence:++sequence});const deadline=performance.now()+10000;
        while(Atomics.load(state,0)<sequence){assert.equal(Atomics.load(state,1),0);const remaining=deadline-performance.now();assert(remaining>0,'barrier deadline');Atomics.wait(state,0,sequence-1,remaining);}
      };
      restore=wrap({linkSync:real=>(...args)=>{const result=real(...args);if(dirname(args[1])===join(root,'registry/releases')){published=true;barrier('publication');}return result;}});
      const releaser=createRecoveryHoldReleaser({registry,authority,approvalAuthority,verifyTerminal:(p,o,c,publish)=>{
        barrier('terminal');const receipt=terminal(p,o,c,publish);assert(published);if(exceptional)throw null;return receipt;
      }});
      let failed=false;
      try{releaser.release(operation,context);}catch(e){if(!exceptional)throw e;assert.equal(e.code,'RECOVERY_CALLBACK_FAILED');failed=true;}
      assert.equal(failed,exceptional);assert.equal(evidenceHash.length,64);send({phase:'complete',failed});
    }
  } catch(e){process.exitCode=1;send({phase:'failure',code:e?.code,message:e?.message,stack:e?.stack});}
  finally{restore();if(worker)await worker.terminate();process.disconnect();}
});
send({phase:'ready'});
