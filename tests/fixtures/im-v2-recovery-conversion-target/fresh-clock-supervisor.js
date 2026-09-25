import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mode = process.argv[2], root = mkdtempSync(join(tmpdir(), 'b02a-clock-'));
const argv = [fileURLToPath(new URL('./fresh-clock-child.js', import.meta.url)), mode, join(root, 'report.json')];
writeFileSync(join(root, 'argv.json'), JSON.stringify({ executable: process.execPath, argv, cwd: process.cwd() }));
const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', exit, closed, lifecycleError, timedOut = false, killTimer;
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
child.on('error', error => { lifecycleError = error.code ?? 'CHILD_ERROR'; });
child.on('exit', (code, signal) => { exit = { code, signal }; });
const timer = setTimeout(() => {
  timedOut = true;
  if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  killTimer = setTimeout(() => {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 1000);
}, 12000);
await new Promise(resolve => child.on('close', (code, signal) => {
  closed = { code, signal }; clearTimeout(timer); clearTimeout(killTimer); resolve();
}));
const lifecycle = { pid: child.pid, exit, close: closed, lifecycleError, timedOut, argv, root };
writeFileSync(join(root, 'stdout.log'), stdout); writeFileSync(join(root, 'stderr.log'), stderr);
writeFileSync(join(root, 'lifecycle.json'), JSON.stringify(lifecycle, null, 2));
if (lifecycleError || timedOut || exit?.code !== 0 || closed?.code !== 0 || exit.signal || closed.signal) {
  process.stderr.write(JSON.stringify({ lifecycle, stdout, stderr })); process.exitCode = 1;
} else {
  try {
    const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
    const allowed = mode === 'natural' ? ['SUCCESS', 'CLOCK_REGRESSION_OBSERVED_SAFE_REFUSAL'] : ['SUCCESS'];
    if (report.mode !== mode || !report.completed || !report.validated || !allowed.includes(report.outcome) ||
        report.assertionError || report.reportError || report.cleanupErrors || JSON.stringify(report) !== JSON.stringify(JSON.parse(stdout))) {
      throw Error('child report not fully validated');
    }
    process.stdout.write(JSON.stringify({ mode, completed: report.completed, validated: report.validated, outcome: report.outcome,
      reportPath: join(root, 'report.json'), clockOverride: report.clockOverride, floor: report.floor,
      failurePhase: report.failurePhase, refusalInvariants: report.refusalInvariants, retryCount: report.retryCount, lifecycle }));
  } catch (error) { process.stderr.write(JSON.stringify({ lifecycle, reportValidationError: error.message, stdout, stderr })); process.exitCode = 1; }
}
