import { parentPort, workerData } from 'node:worker_threads';
import { Socket } from 'node:net';

// A separate thread receives GO while the process's main thread is inside a
// synchronous real SQLite/registry callback. No event-loop IPC deadlock or sleeps.
const state = new Int32Array(workerData.state);
const input = new Socket({ fd: 4, readable: true, writable: false });
let pending = '', sequence = 0;
input.setEncoding('utf8');
input.on('data', chunk => {
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (line !== `go:${sequence + 1}`) throw Error('out-of-order barrier GO');
    Atomics.store(state, 0, ++sequence);
    Atomics.notify(state, 0);
  }
});
input.on('error', error => { throw error; });
parentPort.postMessage('ready');
