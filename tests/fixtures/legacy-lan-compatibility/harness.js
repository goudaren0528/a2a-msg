import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const budget = 10_000;
const MAX_READY_BYTES = 64 * 1024;
const MAX_HTTP_BYTES = 16 * 1024 * 1024; // 10 MiB attachment encoded as base64 + JSON
const MAX_SSE_BYTES = 256 * 1024;

// Keep draining stdout after readiness: pausing the pipe can block the owned CLI.
export function readServerUrl(stdout, maxBytes = MAX_READY_BYTES) {
  return new Promise((resolve, reject) => {
    let output = Buffer.alloc(0);
    let ready = false;
    stdout.on('data', bytes => {
      if (ready) return;
      if (bytes.length > maxBytes - output.length) {
        ready = true; output = null;
        reject(new Error('Legacy CLI readiness stdout byte limit exceeded'));
        return;
      }
      output = Buffer.concat([output, bytes]);
      const match = output.toString('utf8').match(/team-mailbox server listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { ready = true; output = null; resolve(match[1]); }
    });
  });
}

export async function bounded(promise, label, ms = budget) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Attach before awaiting spawn/initialize/readiness. Error is NOT evidence of exit.
function observe(child, label) {
  const errors = [];
  let exit, closed, stderr = '';
  child.on('error', error => errors.push(error));
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  const close = new Promise(resolve => child.once('close', (code, signal) => {
    closed = { code, signal }; resolve(closed);
  }));
  child.stderr?.on('data', bytes => { stderr = (stderr + bytes).slice(-8192); });
  const record = {
    child, close,
    async ready(promise) {
      return bounded(Promise.race([promise, close.then(result => {
        throw new Error(`${label} closed before ready: ${JSON.stringify(result)} ${stderr}`);
      })]), `${label} readiness`);
    },
    async stop() {
      const early = closed;
      if (!closed) {
        child.kill('SIGTERM');
        try { await bounded(close, `${label} SIGTERM`, 2000); }
        catch {
          if (!closed) child.kill('SIGKILL');
          await bounded(close, `${label} SIGKILL close`);
        }
      }
      assert.ok(closed, `${label}: actual close, not just exit, observed`);
      assert.ok(exit || errors.length, `${label}: exit or spawn error observed`);
      assert.equal(errors.length, 0, `${label}: ${errors.map(e => e.message).join('; ')}`);
      if (early) assert.equal(early.code, 0, `${label}: premature failure ${stderr}`);
      return closed;
    },
  };
  return record;
}

// No inherited MSG_*, NODE_OPTIONS, proxy settings or credentials. Absolute Node command.
function environment(extra) {
  const env = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

export function lane(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-lan-compatibility-'));
  fs.chmodSync(dir, 0o700);
  const cleanups = [];
  const config = path.join(dir, 'access.json');
  const dbPath = path.join(dir, 'legacy.sqlite');
  fs.writeFileSync(config, JSON.stringify({
    allowedCidrs: ['127.0.0.0/24'],
    members: [
      { name: 'LegacyA', ips: ['127.0.0.1'] },
      { name: 'LegacyB', ips: ['127.0.0.2'] },
      { name: 'LegacyC', ips: ['127.0.0.3'] },
    ],
  }), { mode: 0o600 });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  } else t.diagnostic('Windows fixture uses inherited temp-directory ACLs; POSIX mode checks are not applicable.');
  t.after(async () => {
    const failures = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    // Never remove files underneath a child whose actual close was not confirmed.
    if (failures.length) throw new AggregateError(failures, `Cleanup failed; retained ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, config, dbPath, cleanup: fn => cleanups.push(fn) };
}

export async function server(f, t, maxReadyBytes = MAX_READY_BYTES) {
  const child = spawn(process.execPath, [path.join(root, 'src/server.js')], {
    cwd: f.dir, env: environment({ MSG_ACCESS_CONFIG: f.config, MSG_DB_PATH: f.dbPath,
      MSG_HOST: '127.0.0.1', MSG_PORT: '0' }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = observe(child, 'legacy CLI');
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    const result = await record.stop(); stopped = true;
    t.diagnostic(`legacy CLI pid=${child.pid} close=${JSON.stringify(result)}`);
  };
  f.cleanup(stop);
  let url;
  try { url = await record.ready(readServerUrl(child.stdout, maxReadyBytes)); }
  catch (error) { await stop(); throw error; }
  assert.notEqual(new URL(url).port, '0');
  return { url, stop };
}

export async function mcp(f, t, url) {
  let record;
  // Pinned SDK 1.30.0 creates _process synchronously in start(). Observe it before
  // awaiting SDK initialization; use the real transport/framing, never a mock client.
  class ObservedTransport extends StdioClientTransport {
    start() {
      const starting = super.start();
      record = observe(this._process, 'legacy MCP');
      return starting;
    }
  }
  const transport = new ObservedTransport({ command: process.execPath,
    args: [path.join(root, 'src/mcp.js')], cwd: f.dir, stderr: 'pipe',
    env: environment({ MSG_SERVER_URL: url, MSG_DOWNLOAD_DIR: f.dir, MSG_DEVICE_NAME: 'synthetic-legacy-client' }),
  });
  transport.stderr.on('data', () => {});
  const sdk = new Client({ name: 'legacy-compatibility-acceptance', version: '1.0.0' });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    if (record) {
      const result = await record.stop();
      t.diagnostic(`legacy MCP pid=${record.child.pid} close=${JSON.stringify(result)}`);
    }
    await bounded(sdk.close(), 'SDK close');
    stopped = true;
  };
  f.cleanup(stop);
  const connecting = sdk.connect(transport);
  await record.ready(connecting);
  assert.equal(sdk.getServerVersion().name, 'team-mailbox-bridge');
  return { sdk, stop };
}

export async function call(sdk, name, args = {}) {
  const result = await bounded(sdk.callTool({ name, arguments: args }), name);
  assert.ok(!result.isError, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

export function request(url, localAddress = '127.0.0.1', method = 'GET', body, headers = {}, maxBytes = MAX_HTTP_BYTES) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(url, { localAddress, method, agent: false,
      signal: AbortSignal.timeout(budget),
      headers: { ...(raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, res => {
      const chunks = [];
      let length = 0;
      res.on('data', chunk => {
        if (chunk.length > maxBytes - length) {
          fail(new Error('Legacy HTTP response byte limit exceeded'));
          res.destroy(); req.destroy();
          return;
        }
        length += chunk.length; chunks.push(chunk);
      });
      res.on('error', fail);
      res.on('end', () => {
        if (settled) return;
        try {
          const data = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
          settled = true; resolve({ status: res.statusCode, data });
        }
        catch (error) { fail(error); }
      });
    });
    req.on('error', fail); req.end(raw);
  });
}

export async function relay(f, target, localAddress) {
  const active = new Set();
  const proxy = http.createServer((req, res) => {
    // Identity is the upstream TCP source address, never forwarded headers.
    const upstream = http.request(new URL(req.url, target), {
      method: req.method, localAddress, agent: false, headers: req.headers,
      signal: AbortSignal.timeout(budget),
    }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    active.add(upstream);
    upstream.on('close', () => active.delete(upstream));
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => upstream.destroy());
    req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
  });
  f.cleanup(async () => {
    const closed = new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    for (const upstream of active) upstream.destroy();
    proxy.closeAllConnections();
    await bounded(closed, 'relay close');
  });
  await bounded(new Promise((resolve, reject) => {
    proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve);
  }), 'relay listening');
  return `http://127.0.0.1:${proxy.address().port}`;
}

export function snapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    assert.deepEqual(tables, ['attachments', 'members', 'messages', 'sqlite_sequence'], 'no IM tables or forced migration');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
    return {
      messages: db.prepare('SELECT * FROM messages ORDER BY id').all().map(row => ({ ...row })),
      attachments: db.prepare('SELECT * FROM attachments ORDER BY id').all()
        .map(row => ({ ...row, data: Buffer.from(row.data).toString('base64') })),
    };
  } finally { db.close(); }
}

export async function events(f, url, maxBytes = MAX_SSE_BYTES) {
  const controller = new AbortController();
  let reader;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    controller.abort();
    try { await bounded(reader?.cancel(), 'SSE cancellation'); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
    stopped = true;
  };
  f.cleanup(stop);
  const response = await fetch(`${url}/api/unread-events`, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(budget)]),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream\b/);
  reader = response.body.getReader();
  let pending = [];
  let pendingBytes = 0;
  let chunk = Buffer.alloc(0), offset = 0, previous = -1;
  return {
    stop,
    async next() {
      for (;;) {
        if (offset === chunk.length) {
          const read = await bounded(reader.read(), 'SSE unread frame');
          assert.equal(read.done, false, 'stream must deliver an actual unread event');
          chunk = Buffer.from(read.value.buffer, read.value.byteOffset, read.value.byteLength);
          offset = 0;
        }
        // Walk bytes, not decoded code units: a large read may contain many small
        // valid frames, and UTF-8 sequences may straddle reads.
        const start = offset;
        let end = -1;
        while (offset < chunk.length) {
          const byte = chunk[offset++];
          if (previous === 10 && byte === 10) { end = offset; previous = -1; break; }
          previous = byte;
        }
        const slice = chunk.subarray(start, offset);
        if (slice.length > maxBytes - pendingBytes) {
          controller.abort();
          try { await stop(); } catch { /* The byte-limit error is deterministic. */ }
          throw new Error('Legacy SSE frame byte limit exceeded');
        }
        pending.push(slice); pendingBytes += slice.length;
        if (end === -1) continue;
        const frame = Buffer.concat(pending, pendingBytes).subarray(0, pendingBytes - 2).toString('utf8');
        pending = []; pendingBytes = 0;
        if (frame.startsWith(':')) continue;
        assert.match(frame, /\nevent: unread\n/);
        return JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6));
      }
    },
  };
}
