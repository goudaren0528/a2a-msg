import assert from 'node:assert/strict';
import { fork } from 'node:child_process';

function bounded(promise, label, ms = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`B2 owned child ${label} timeout`)), ms); })]).finally(() => clearTimeout(timer));
}
export function start(t, input) {
  const child = fork(new URL('./worker.js', import.meta.url), [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let error, exited = false, closed = false, stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const queue = [], waiters = []; let readyObserved = false, readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  child.on('message', message => {
    if (message.type === 'ready') { readyObserved = true; readyResolve(); return; }
    const waiter = waiters.shift(); if (waiter) waiter.resolve(message); else queue.push(message);
  });
  child.on('error', value => { error = value; for (const waiter of waiters.splice(0)) waiter.reject(value); });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));
  const close = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
  async function next(type) {
    if (error) throw error;
    await bounded(ready, 'ready');
    if (error) throw error;
    const message = await bounded(queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => waiters.push({ resolve, reject })), type);
    assert.equal(message.type, type, JSON.stringify({ message, stderr })); return message;
  }
  const stop = async () => {
    if (!exited) child.kill('SIGTERM');
    try { await bounded(exit, 'cleanup exit', 2000); }
    catch { if (!exited) child.kill('SIGKILL'); await bounded(exit, 'cleanup killed exit', 3000); }
    if (!closed) await bounded(close, 'cleanup close', 3000);
  };
  (t.own ?? t.after).call(t, stop);
  child.send(input);
  return { child, next, release: () => child.stdin.write(Buffer.from([1])), async done() {
    const result = await next('result');
    assert.deepEqual(await bounded(exit, 'exit'), { code: 0, signal: null }, stderr);
    assert.deepEqual(await bounded(close, 'close'), { code: 0, signal: null }, stderr);
    assert.equal(error, undefined);
    t.diagnostic(JSON.stringify({ ownedChild: 'b2-worker', pid: child.pid, phase: input.mode, ready: readyObserved, result, exit: 0, close: 0, error: null }));
    return { ...result, stdout, stderr };
  }, stop };
}
