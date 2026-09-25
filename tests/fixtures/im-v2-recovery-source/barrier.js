import { parentPort, workerData } from 'node:worker_threads';
import { Socket } from 'node:net';

// A separate thread services the pipe while the holder's callback is synchronous.
const state = new Int32Array(workerData.state);
const pipe = new Socket({ fd: 4, readable: true, writable: false });
let pending = '', sequence = 0;
const fail = () => { Atomics.store(state, 1, 1); Atomics.notify(state, 0); };
pipe.setEncoding('utf8');
pipe.on('data', bytes => {
  pending += bytes;
  let end;
  while ((end = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    if (line !== `go:${sequence + 1}`) { fail(); return; }
    Atomics.store(state, 0, ++sequence); Atomics.notify(state, 0);
  }
});
pipe.on('error', fail);
pipe.on('end', fail);
parentPort.postMessage('ready');
