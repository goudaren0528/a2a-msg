import assert from 'node:assert/strict';
import { fork } from 'node:child_process';

export const deadlines = Object.freeze({ ready: 3000, phase: 8000, go: 5000, term: 1000, kill: 3000, case: 60000 });
export function bounded(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`timeout: ${label}`)), ms); })])
    .finally(() => clearTimeout(timer));
}
export class OwnedProcesses {
  constructor(record = () => {}) { this.children = new Set(); this.record = record; this.unconfirmed = false; }
  start(descriptor, mode, options = {}) {
    const child = fork(new URL('./child.js', import.meta.url), [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'pipe'], serialization: 'json', execArgv: [],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const state = { child, messages: [], waiters: new Set(), stdout: '', stderr: '', exit: null, close: null, error: null };
    this.children.add(state);
    // Register BOTH lifecycle events immediately. An error is never an exit.
    state.exited = new Promise(resolve => child.once('exit', (code, signal) => {
      state.exit = { code, signal }; this.record({ type: 'exit', pid: child.pid, ...state.exit }); resolve(state.exit); wake();
    }));
    state.closed = new Promise(resolve => child.once('close', (code, signal) => {
      state.close = { code, signal }; this.record({ type: 'close', pid: child.pid, ...state.close }); resolve(state.close); wake();
    }));
    const wake = () => { for (const fn of [...state.waiters]) fn(); };
    child.on('error', error => { state.error = error.code ?? 'SPAWN_ERROR'; wake(); });
    for (const name of ['stdout', 'stderr']) child[name].on('data', bytes => {
      state[name] += bytes.toString();
      if (state[name].length > 262144) state[name] = state[name].slice(-262144);
    });
    child.on('message', message => { state.messages.push(message); this.record(message); wake(); });
    state.wait = (phase, timeout = deadlines.phase) => bounded(new Promise((resolve, reject) => {
      const inspect = () => {
        const found = state.messages.find(message => message.phase === phase);
        const failure = state.messages.find(message => message.phase === 'failure');
        if (found) { state.waiters.delete(inspect); resolve(found); }
        else if (failure || state.error || state.exit) {
          state.waiters.delete(inspect);
          reject(Error(`child ${child.pid} missing ${phase}: ${JSON.stringify(failure ?? state.error ?? state.exit)}`));
        }
      };
      state.waiters.add(inspect); inspect();
    }), timeout, `${child.pid}/${phase}`);
    state.go = sequence => child.stdio[4].write(`go:${sequence}\n`);
    state.begin = async () => {
      await state.wait('ready', deadlines.ready);
      child.send({ descriptor, mode, ...options });
      return state;
    };
    return state;
  }
  async killAt(state, expected) {
    const message = await state.wait(expected);
    assert.equal(message.nativeCompleted, true);
    assert.equal(message.pid, state.child.pid);
    assert.equal(message.sequence, 1);
    assert.equal(state.child.kill('SIGKILL'), true);
    const [exit, close] = await bounded(Promise.all([state.exited, state.closed]), deadlines.kill, 'SIGKILL exit AND close');
    assert.deepEqual(exit, { code: null, signal: 'SIGKILL' });
    assert.deepEqual(close, exit);
    return message;
  }
  async complete(state) {
    const result = await state.wait('complete');
    const [exit, close] = await bounded(Promise.all([state.exited, state.closed]), deadlines.kill, 'normal exit AND close');
    assert.deepEqual(exit, { code: 0, signal: null }); assert.deepEqual(close, exit);
    return result;
  }
  async stop() {
    for (const state of this.children) {
      if (state.close && state.exit) continue;
      if (!state.exit) state.child.kill('SIGTERM');
      try { await bounded(Promise.all([state.exited, state.closed]), deadlines.term, 'owned TERM'); }
      catch {
        if (!state.exit) state.child.kill('SIGKILL');
        try { await bounded(Promise.all([state.exited, state.closed]), deadlines.kill, 'owned KILL'); }
        catch { this.unconfirmed = true; }
      }
    }
    assert.equal(this.unconfirmed, false, 'owned child exit unconfirmed; preserve evidence');
  }
}
