import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Keep spawn error, native exit and stdio close distinct. Timeout cleanup owns
// only this child, awaits TERM/KILL, and completes before fixture removal.
export function child(file, args = [], ipc = false) {
  const path = fileURLToPath(new URL(file, import.meta.url));
  const argv = ['--unhandled-rejections=throw', path, ...args];
  const proc = ipc ? fork(path, args, { execArgv: argv.slice(0, 1), silent: true }) : spawn(process.execPath, argv);
  let exit, error = null, output = '', stdout = '', stderr = '', closed = false;
  const messages = [], waiters = [];
  proc.stdout.on('data', data => { stdout += data; output += data; }); proc.stderr.on('data', data => { stderr += data; output += data; });
  proc.on('error', e => { error = e.code ?? 'spawn-error'; });
  proc.on('exit', (code, signal) => { exit = { code, signal }; });
  proc.on('message', message => {
    const waiter = waiters.shift(); if (waiter) waiter.resolve(message); else messages.push(message);
  });
  const done = new Promise(resolve => proc.on('close', (code, signal) => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter.reject(Error(`owned child closed before phase barrier: ${JSON.stringify({ error, exit, close: { code, signal }, stdout, stderr })}`));
    resolve({ argv: [process.execPath, ...argv], pid: proc.pid, error, exit, close: { code, signal }, stdout, stderr, output });
  }));
  async function bounded(promise, milliseconds) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('owned child timeout')), milliseconds); })]); }
    finally { clearTimeout(timer); }
  }
  async function stop() {
    if (closed) return done;
    proc.kill('SIGTERM');
    try { return await bounded(done, 3000); }
    catch { proc.kill('SIGKILL'); return bounded(done, 3000); }
  }
  return { proc, stop, async result() { try { return await bounded(done, 20000); } catch (error) { await stop(); throw error; } },
    async message() { try { return await bounded(messages.length ? Promise.resolve(messages.shift()) : closed ? Promise.reject(Error(`owned child already closed: ${output}`)) : new Promise((resolve, reject) => waiters.push({ resolve, reject })), 10000); }
      catch (error) { await stop(); throw error; } } };
}
