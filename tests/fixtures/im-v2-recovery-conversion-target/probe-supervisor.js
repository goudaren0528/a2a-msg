import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = [fileURLToPath(new URL('./probe-lock.js', import.meta.url)), process.argv[2]];
const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', exit, closed, lifecycleError, timedOut = false, killTimer;
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
child.on('error', error => { lifecycleError = error.code ?? 'CHILD_ERROR'; });
child.on('exit', (code, signal) => { exit = { code, signal }; });
const timer = setTimeout(() => {
  timedOut = true; child.kill('SIGTERM');
  killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
}, 12000);
await new Promise(resolve => child.on('close', (code, signal) => {
  closed = { code, signal }; clearTimeout(timer); clearTimeout(killTimer); resolve();
}));
if (lifecycleError || timedOut || exit?.code !== 0 || closed?.code !== 0 || exit.signal || closed.signal) {
  process.stderr.write(JSON.stringify({ lifecycleError, timedOut, exit, closed, stderr })); process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ ...JSON.parse(stdout), lifecycle: { exit, close: closed, timedOut, argv } }));
}
