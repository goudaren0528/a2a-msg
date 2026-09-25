import assert from 'node:assert/strict';
import { fork } from 'node:child_process';

async function bounded(promise,ms,label) {
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]);}
  finally{clearTimeout(timer);}
}
export async function runChild(t,input) {
  const child=fork(new URL('./child.js',import.meta.url),[],{execArgv:['--unhandled-rejections=throw'],stdio:['ignore','pipe','pipe','ipc']});
  let output='',error,closed=false,pending;
  const queue=[];
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const close=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;pending?.reject(Error(`early close: ${output}`));resolve({code,signal});}));
  child.on('error',e=>{error=e;pending?.reject(e);});
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b;});
  child.on('message',m=>{if(pending){const p=pending;pending=null;p.resolve(m);}else queue.push(m);});
  const next=async phase=>{
    if(error)throw error;
    const m=queue.length?queue.shift():await bounded(new Promise((resolve,reject)=>{if(closed)reject(Error(output));else pending={resolve,reject};}),15000,`IPC ${phase} timeout`);
    assert.equal(m.phase,phase,JSON.stringify(m)+'\n'+output);return m;
  };
  t.after(async()=>{
    if(!closed){child.kill('SIGTERM');try{await bounded(close,1000,'TERM');}catch{child.kill('SIGKILL');await bounded(close,3000,'KILL close');}}
    if(child.pid)await bounded(exit,1000,'exit missing');
  });
  await next('ready');
  await bounded(new Promise((resolve,reject)=>child.send(input,e=>e?reject(e):resolve())),3000,'send timeout');
  const result=await next('result');
  const exitResult=await bounded(exit,3000,'exit timeout'),closeResult=await bounded(close,3000,'close timeout');
  t.diagnostic(JSON.stringify({scenario:input.scenario,pid:child.pid,exit:exitResult,close:closeResult,result,output}));
  assert.deepEqual(exitResult,{code:0,signal:null},output);assert.deepEqual(closeResult,exitResult,output);
  return result;
}
