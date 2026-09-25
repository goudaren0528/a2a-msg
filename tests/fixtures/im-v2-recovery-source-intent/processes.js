import assert from 'node:assert/strict';
import { fork } from 'node:child_process';

async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(message)), ms);
  })]); } finally { clearTimeout(timer); }
}
export function processes() {
  const owned = [];
  function start(input) {
    const child = fork(new URL('./child.js', import.meta.url), [], {
      execArgv: ['--unhandled-rejections=throw'], stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'pipe'],
    });
    let closed = false, exited = false, failure, output = '', pending;
    const messages = [];
    const exit = new Promise(resolve => child.once('exit', (code, signal) => {
      exited = true; resolve({ code, signal });
    }));
    const close = new Promise(resolve => child.once('close', (code, signal) => {
      closed = true; pending?.reject(Error(`child closed before IPC: ${output}`));
      resolve({ code, signal });
    }));
    const fail = error => { failure = error; pending?.reject(error); };
    child.on('error', fail); // An error event is never treated as process exit/close.
    child.stdio[4].on('error', fail);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-16000); });
    child.on('message', message => {
      if (pending) { const waiter = pending; pending = undefined; waiter.resolve(message); }
      else messages.push(message);
    });
    const api = {
      pid: child.pid,
      async next(phase) {
        if (failure) throw failure;
        const message = messages.length ? messages.shift() : await bounded(new Promise((resolve, reject) => {
          if (closed) reject(Error(`child already closed: ${output}`)); else pending = { resolve, reject };
        }), 10000, `IPC deadline waiting for ${phase}`);
        assert.equal(message.phase, phase, JSON.stringify(message) + '\n' + output);
        return message;
      },
      async go() {
        await api.next('ready');
        await bounded(new Promise((resolve, reject) => child.send(input, error => error ? reject(error) : resolve())), 3000, 'IPC send deadline');
      },
      async release(sequence) {
        await bounded(new Promise((resolve, reject) => child.stdio[4].write(`go:${sequence}\n`, error => error ? reject(error) : resolve())), 3000, 'barrier release deadline');
      },
      async ended(expected = { code: 0, signal: null }) {
        const actualExit = await bounded(exit, 4000, 'child exit deadline');
        const actualClose = await bounded(close, 4000, 'child close deadline');
        assert.deepEqual(actualExit, expected, output); assert.deepEqual(actualClose, expected, output);
        assert.ok(exited && closed);
        return { exit: actualExit, close: actualClose };
      },
      async stop() {
        if (!closed) {
          child.kill('SIGTERM');
          try { await bounded(close, 1000, 'TERM deadline'); }
          catch { child.kill('SIGKILL'); await bounded(close, 3000, 'KILL close unconfirmed; retain fixtures'); }
        }
        if (child.pid) await bounded(exit, 1000, 'exit unconfirmed; retain fixtures');
      },
    };
    owned.push(api); return api;
  }
  return { start, async stop() {
    const results = await Promise.allSettled(owned.map(child => child.stop()));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  } };
}
