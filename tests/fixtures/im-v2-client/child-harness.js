// TEST ONLY owned child lifetime: completion means 'exit', not spawn/error.
import { spawn } from 'node:child_process';

export function runCredentialChild(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./credential-child.js', import.meta.url).pathname, mode],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', spawnError = null, timedOut = false, killTimer;
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { spawnError = error; });
    const timer = setTimeout(() => {
      timedOut = true; child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
    }, 12000);
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (spawnError) reject(spawnError);
      else resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}
