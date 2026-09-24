import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export function bounded(promise, description, ms = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`timeout: ${description}`)), ms);
  })]).finally(() => clearTimeout(timer));
}

export function environment(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env = { HOME: directory, USERPROFILE: directory, APPDATA: directory,
    LOCALAPPDATA: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory,
    XDG_DATA_HOME: directory, TMPDIR: directory, TMP: directory, TEMP: directory };
  // Absolute executables need no inherited PATH, module paths, proxies or credentials.
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export function findPython(root) {
  const attempts = [];
  for (const name of ['python', 'python3']) {
    const probe = spawnSync(name, ['-I', '-S', '-B', '-c',
      'import sys; print(sys.executable); sys.exit(0 if sys.version_info >= (3, 8) else 2)'],
    // PATH is used only for isolated interpreter discovery. Without it CPython
    // on Unix can run successfully yet report an empty sys.executable. Actual
    // agents below use the resolved absolute executable and the minimal env.
    { cwd: root, env: { ...environment(join(root, `probe-${name}`)), PATH: process.env.PATH ?? '' },
      encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
    if (probe.status === 0 && probe.stdout.trim()) return { executable: probe.stdout.trim() };
    attempts.push(`${name}: ${probe.error?.code ?? `exit=${probe.status},signal=${probe.signal}`}`);
  }
  return { reason: `No native Python 3.8+ interpreter (${attempts.join('; ')}). Cross-language chain NOT executed; WSL must be run as a separate native test.` };
}

// Observers are installed synchronously after spawn: error is NOT evidence of exit.
export function trackedSpawn(command, args, options, children) {
  const child = spawn(command, args, { ...options, windowsHide: true, shell: false });
  const state = { child, closed: false, exited: false, errors: [], queue: [], pending: null, outputBytes: 0 };
  children.push(state);
  state.exit = new Promise(resolve => child.once('exit', (code, signal) => {
    state.exited = true; state.outcome = { code, signal }; resolve(state.outcome);
  }));
  state.close = new Promise(resolve => child.once('close', (code, signal) => {
    state.closed = true; state.outcome ??= { code, signal }; resolve(state.outcome);
    state.pending?.reject(Error('child closed before expected phase'));
  }));
  const error = () => {
    state.errors.push('child/stream error');
    state.pending?.reject(Error('child/stream error (details suppressed)'));
  };
  child.on('error', error);
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', error);
  // Drain, count and discard stderr: never forward exception details or credentials.
  child.stderr?.on('data', bytes => { state.outputBytes += bytes.length; });
  state.push = message => {
    if (state.pending) { const pending = state.pending; state.pending = null; pending.resolve(message); }
    else if (state.queue.length < 8) state.queue.push(message);
    else error();
  };
  state.next = async phase => {
    let message;
    if (state.queue.length) message = state.queue.shift();
    else {
      assert.equal(state.closed, false, `child already closed awaiting ${phase}`);
      assert.equal(state.pending, null);
      try {
        message = await bounded(new Promise((resolve, reject) => { state.pending = { resolve, reject }; }), phase);
      } finally { state.pending = null; }
    }
    assert.equal(message?.phase, phase, `unexpected child phase (expected ${phase})`);
    return message;
  };
  state.finish = async () => {
    const outcome = await bounded(state.close, 'child close');
    assert.equal(state.exited, true);
    assert.deepEqual(outcome, { code: 0, signal: null });
    assert.equal(state.errors.length, 0);
    assert.equal(state.queue.length, 0);
  };
  return state;
}

export async function stop(state) {
  if (!state.closed && !state.exited) state.child.kill('SIGTERM');
  try { await bounded(state.close, 'TERM close', 2000); }
  catch {
    if (!state.closed) state.child.kill('SIGKILL');
    await bounded(state.close, 'KILL close', 3000);
  }
}

export async function pythonProcess(executable, fixture, config, directory, children) {
  const state = trackedSpawn(executable, ['-I', '-S', '-B', fixture], {
    cwd: directory, env: environment(directory), stdio: ['pipe', 'pipe', 'pipe'],
  }, children);
  let pending = Buffer.alloc(0), frames = 0;
  state.child.stdout.on('data', bytes => {
    pending = Buffer.concat([pending, bytes]);
    if (pending.length > 65536 || ++frames > 100) {
      state.errors.push('Python bounded output exceeded'); state.child.kill('SIGTERM'); return;
    }
    let end;
    while ((end = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
      try { state.push(JSON.parse(line.toString('utf8'))); }
      catch { state.errors.push('invalid Python frame'); state.child.kill('SIGTERM'); }
    }
  });
  state.child.stdout.on('end', () => { if (pending.length) state.errors.push('truncated Python frame'); });
  state.send = input => bounded(new Promise((resolve, reject) => {
    const frame = `${JSON.stringify(input)}\n`;
    assert.ok(Buffer.byteLength(frame) <= 65536);
    state.child.stdin.write(frame, error => error ? reject(Error('Python IPC write failed')) : resolve());
  }), 'Python IPC write');
  const ready = await state.next('ready');
  assert.equal(ready.pid, state.child.pid);
  assert.equal(ready.clean, true);
  await state.send(config);
  return state;
}

export async function mcpProcess(fixture, config, directory, children) {
  const state = trackedSpawn(process.execPath, [fixture], {
    cwd: directory, env: environment(directory), stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  }, children);
  state.child.on('message', state.push);
  const ready = await state.next('ready');
  assert.equal(ready.pid, state.child.pid);
  assert.equal(ready.clean, true);
  await bounded(new Promise((resolve, reject) => {
    state.child.send(config, error => error ? reject(Error('MCP configuration IPC failed')) : resolve());
  }), 'MCP configuration IPC');
  await state.next('configured');
  // SDK's stream transport is symmetric JSON-RPC framing. Supplying owned child
  // pipes lets us install immediate exit/close observers without reaching into
  // StdioClientTransport's private _process. Both endpoints use SDK stdio framing;
  // Client.connect performs the real initialize/initialized handshake.
  const transport = new StdioServerTransport(state.child.stdout, state.child.stdin, { maxBufferSize: 262144 });
  const client = new Client({ name: 'isolated-a7-parent', version: '1.0.0' });
  state.client = client;
  await bounded(client.connect(transport), 'MCP initialize');
  const listed = await bounded(client.listTools(), 'MCP tools/list');
  assert.equal(listed.tools.length, 16);
  state.call = async (name, args = {}) => {
    const response = await bounded(client.callTool({ name, arguments: args }), `MCP ${name}`);
    const data = JSON.parse(response.content[0].text);
    assert.equal(response.isError, undefined, `MCP ${name}: ${data.error?.code ?? 'invalid response'}`);
    return data;
  };
  state.graceful = async () => {
    await bounded(client.close(), 'MCP client close');
    state.child.stdin.end();
    await state.finish();
  };
  return state;
}
