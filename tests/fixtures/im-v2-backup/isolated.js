import assert from 'node:assert/strict';
import { fork } from 'node:child_process';

// Every native fault and unhandled-rejection observer lives in an owned child.
// An error is a failure signal, never evidence that the process has stopped.
export async function isolated(mode, { rejectionObserver = false } = {}) {
  const child = fork(new URL('./regression-worker.js', import.meta.url), [], {
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let closed = false, failure, output = '';
  const messages = [], waiters = [];
  const close = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter.reject(Error('child closed before expected IPC'));
    resolve({ code, signal });
  }));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    output = (output + bytes.toString()).slice(-16000);
  });
  child.on('error', error => {
    failure = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  child.on('message', message => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message); else messages.push(message);
  });
  function next() {
    if (failure) return Promise.reject(failure);
    if (messages.length) return Promise.resolve(messages.shift());
    if (closed) return Promise.reject(Error('child already closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('bounded child IPC timeout')), 8000);
      waiters.push({ resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); } });
    });
  }
  async function waitClose(ms) {
    let timer;
    try { return await Promise.race([close, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
    finally { clearTimeout(timer); }
  }
  try {
    assert.deepEqual(await next(), { phase: 'ready' });
    child.send({ phase: 'go', mode, rejectionObserver });
    const result = await next();
    assert.equal(result.phase, 'complete', `${JSON.stringify(result)}\n${output}`);
    assert.deepEqual(await waitClose(5000), { code: 0, signal: null }, output);
    return result;
  } finally {
    if (!closed) child.kill('SIGTERM');
    if (!await waitClose(1000)) {
      child.kill('SIGKILL');
      if (!await waitClose(2000)) throw Error('owned regression child close unconfirmed; fixtures retained');
    }
  }
}
