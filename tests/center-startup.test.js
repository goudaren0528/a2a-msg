import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { initDb } from '../src/db.js';

const launcher = path.resolve('scripts/run-center-foreground.mjs');
const installer = path.resolve('scripts/install-center-startup.ps1');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('foreground task runs one real Node center on isolated DB; occupied port refuses takeover', async t => {
  fs.mkdirSync(path.resolve('.test-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(path.resolve('.test-tmp'), 'center-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Copy the full src tree: the center entry imports its own module graph
  // (including src/im for the versioned namespace), so an isolated deployment
  // must contain all of it rather than a hand-listed subset.
  fs.cpSync(path.resolve('src'), path.join(root, 'src'), { recursive: true });
  // Real imports use project dependencies, not production data or service.
  fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'junction');
  const dbPath = path.join(root, 'data.sqlite');
  const db = initDb(dbPath); db.close();
  const access = path.join(root, 'access.json');
  fs.writeFileSync(access, JSON.stringify({ allowedCidrs: ['127.0.0.0/8'], members: [{ name: 'fixture', ips: ['127.0.0.1'] }] }));
  const port = await freePort();
  const args = [launcher, '--root', root, '--node', process.execPath, '--db', dbPath, '--access', access, '--host', '127.0.0.1', '--port', String(port)];
  const child = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let healthy = false;
  for (let i = 0; i < 80; i++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); healthy = response.status === 200; if (healthy) break; } catch {}
    if (child.exitCode !== null) break;
    await pause(50);
  }
  assert.equal(healthy, true, 'isolated center became healthy');
  const conflict = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 });
  assert.equal(conflict.status, 1, 'second instance refuses an occupied port');
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200, 'first instance remains running');
  assert.equal(fs.existsSync(path.join(root, 'log', 'server.pid')), false, 'does not rewrite legacy pidfile');
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(2000)]);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true, 'foreground exits on termination');
  assert.equal(fs.statSync(path.join(root, 'log', 'server.stderr.log')).size > 0, true, 'conflict writes a fixed diagnostic');
});

test('missing DB cannot be created; PowerShell installer parses without executing', () => {
  const missing = path.join(os.tmpdir(), `missing-center-${process.pid}.sqlite`);
  const result = spawnSync(process.execPath, [launcher, '--root', path.resolve('.'), '--node', process.execPath, '--db', missing, '--access', path.resolve('access.json')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(missing), false);
  const parse = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${installer.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){exit 1}`], { encoding: 'utf8' });
  assert.equal(parse.status, 0, parse.stderr);
  const script = fs.readFileSync(installer, 'utf8');
  for (const marker of ['-AtStartup', '-LogonType S4U', '-RunLevel Limited', '-MultipleInstances IgnoreNew', '-RestartCount 3', '-RestartInterval', '-ExecutionTimeLimit', '-AllowStartIfOnBatteries', '-DontStopIfGoingOnBatteries', 'if (-not $Apply)', 'if ($existing)']) assert.ok(script.includes(marker), marker);
});
