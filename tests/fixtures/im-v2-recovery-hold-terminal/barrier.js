import { Socket } from 'node:net';
import { parentPort,workerData } from 'node:worker_threads';
const state=new Int32Array(workerData.state);
const pipe=new Socket({fd:4,readable:true,writable:false});
let text='',sequence=0;
const fail=()=>{Atomics.store(state,1,1);Atomics.notify(state,0);};
pipe.setEncoding('utf8');
pipe.on('data',bytes=>{
  text+=bytes;let end;
  while((end=text.indexOf('\n'))>=0){
    const line=text.slice(0,end);text=text.slice(end+1);
    if(line!==`go:${sequence+1}`){fail();return;}
    Atomics.store(state,0,++sequence);Atomics.notify(state,0);
  }
});
pipe.on('error',fail);pipe.on('end',fail);
parentPort.postMessage('ready');
