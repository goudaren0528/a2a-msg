import { parentPort, workerData } from 'node:worker_threads';
import { Socket } from 'node:net';

// TEST ONLY: the worker owns the control pipe while the main thread is inside
// a synchronous, already-committed native journal call. Same pattern as the
// committed im-migration-process fixture; no event-loop IPC wait in that stack.
const state = new Int32Array(workerData.state);
const input = new Socket({ fd: 4, readable: true, writable: false });
let pending = '', sequence = 0;
input.setEncoding('utf8');
input.on('data', chunk => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    if (line !== `go:${sequence + 1}`) throw Error('out-of-order TEST barrier');
    Atomics.store(state, 0, ++sequence); Atomics.notify(state, 0);
  }
});
input.on('error', error => { throw error; });
parentPort.postMessage('ready');
