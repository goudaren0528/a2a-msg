import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
async function bounded(promise,ms,label) {
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]);}
  finally{clearTimeout(timer);}
}
export function processes() {
  const owned=[];
  function start(input) {
    const child=fork(new URL('./child.js',import.meta.url),[],{execArgv:['--unhandled-rejections=throw'],stdio:['ignore','pipe','pipe','ipc','pipe']});
    let closed=false,exited=false,failure,output='',pending;
    const messages=[];
    const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal});}));
    const close=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;pending?.reject(Error(`child closed: ${output}`));resolve({code,signal});}));
    const fail=error=>{failure=error;pending?.reject(error);};
    child.on('error',fail);child.stdio[4].on('error',fail); // Error is not exit/close.
    for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{output+=bytes;});
    child.on('message',message=>{if(pending){const p=pending;pending=undefined;p.resolve(message);}else messages.push(message);});
    const api={pid:child.pid,
      async next(phase){
        if(failure)throw failure;
        const message=messages.length?messages.shift():await bounded(new Promise((resolve,reject)=>{if(closed)reject(Error(output));else pending={resolve,reject};}),10000,`IPC deadline ${phase}`);
        assert.equal(message.phase,phase,JSON.stringify(message)+'\n'+output);return message;
      },
      async go(){await api.next('ready');await bounded(new Promise((resolve,reject)=>child.send(input,e=>e?reject(e):resolve())),3000,'send deadline');},
      async release(sequence){await bounded(new Promise((resolve,reject)=>child.stdio[4].write(`go:${sequence}\n`,e=>e?reject(e):resolve())),3000,'release deadline');},
      async ended(){const a=await bounded(exit,4000,'exit deadline'),b=await bounded(close,4000,'close deadline');assert.deepEqual(a,{code:0,signal:null},output);assert.deepEqual(b,a,output);assert(exited&&closed);return {argv:[process.execPath,...child.spawnargs.slice(1)],exit:a,close:b,rawOutput:output};},
      async stop(){
        if(!closed){child.kill('SIGTERM');try{await bounded(close,1000,'TERM deadline');}catch{child.kill('SIGKILL');await bounded(close,3000,'KILL close unconfirmed; retain fixture');}}
        if(child.pid)await bounded(exit,1000,'exit unconfirmed; retain fixture');
      }
    };
    owned.push(api);return api;
  }
  return {start,async stop(){const results=await Promise.allSettled(owned.map(child=>child.stop()));for(const r of results)if(r.status==='rejected')throw r.reason;}};
}
