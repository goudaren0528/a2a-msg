import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Wait for close, not error/exit alone. Timers kill only this owned child.
export async function runChild(script, args = [], timeout = 45000) {
  const argv = [fileURLToPath(new URL(script, import.meta.url)), ...args];
  const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  const result = { argv: [process.execPath, ...argv], pid: child.pid, stdout: '', stderr: '', errors: [], exit: null, close: null, timedOut: false };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { result.stdout += value; }); child.stderr.on('data', value => { result.stderr += value; });
  child.on('error', error => { result.errors.push({ code: error.code, message: error.message }); });
  child.on('exit', (code, signal) => { result.exit = { code, signal }; });
  let hardTimer;
  const timer = setTimeout(() => { result.timedOut = true; child.kill('SIGTERM'); hardTimer = setTimeout(() => child.kill('SIGKILL'), 1000); }, timeout);
  await new Promise(resolve => child.once('close', (code, signal) => {
    result.close = { code, signal }; clearTimeout(timer); clearTimeout(hardTimer); resolve();
  }));
  return result;
}
export function successful(result) {
  assert.deepEqual(result.errors, [], JSON.stringify(result)); assert.equal(result.timedOut, false, JSON.stringify(result));
  assert.deepEqual(result.exit, { code: 0, signal: null }, result.stderr + result.stdout);
  assert.deepEqual(result.close, { code: 0, signal: null }, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}
