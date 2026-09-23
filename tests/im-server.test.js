import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../src/server.js';
import { createImCenter } from '../src/im/server.js';
import { migrateImSchema } from '../src/im/schema.js';
import { createImAdmin } from '../src/im/admin.js';
import { accessConfig } from './helpers.js';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const policy = { enabled: true, transport: { mode: 'local-test', serverUrl: 'http://127.0.0.1:8787' },
  writeMode: 'paused' };

async function setup(t, imPolicy = policy, mountLegacy = false, trustedTimers) {
  const dir = mkdtempSync(join(tmpdir(), 'im-server-test-'));
  const db = new DatabaseSync(join(dir, 'im.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  migrateImSchema(db);
  const clock = () => 10000;
  // Test-only trusted authorization; production does not expose this callback via HTTP.
  const context = {}, admin = createImAdmin({ db, clock, authorizeAdmin: c => c === context });
  const agentId = admin.registerAgent({ displayName: 'Test Agent' }, context).agentId;
  const credential = admin.issueCredential({ agentId, expiresAt: null }, context).credential;
  const im = createImCenter({ db, clock, policy: imPolicy, trustedTimers });
  let server, legacy;
  if (mountLegacy) {
    const accessConfigPath = join(dir, 'access.json');
    writeFileSync(accessConfigPath, JSON.stringify(accessConfig));
    legacy = createServer({ accessConfigPath, dbPath: join(dir, 'legacy.sqlite'), imHandler: im.handler });
    server = legacy.server;
  } else {
    server = http.createServer(async (req, res) => {
      if (!await im.handler.handle(req, res)) { res.statusCode = 418; res.end('legacy'); }
    });
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    im.close();
    if (legacy) await legacy.close();
    else await new Promise(resolve => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const request = (path, { method = 'GET', bearer = credential, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method,
      headers: { ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, text,
          json: res.headers['content-type']?.includes('json') ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { db, im, request, agentId, credential, port: server.address().port };
}

function rawRequest(port, target, { method = 'GET', body, bearer } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    socket.on('error', reject);
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.on('end', () => {
      const [status] = response.split('\r\n', 1);
      if (!status?.startsWith('HTTP/')) return reject(Error(`No HTTP response for ${target}`));
      let text = response.slice(response.indexOf('\r\n\r\n') + 4);
      if (/\r\ntransfer-encoding: chunked\r\n/i.test(response.slice(0, response.indexOf('\r\n\r\n') + 2))) {
        const parts = [];
        while (text.length) {
          const line = text.indexOf('\r\n');
          const size = Number.parseInt(text.slice(0, line), 16);
          if (!size) break;
          parts.push(text.slice(line + 2, line + 2 + size));
          text = text.slice(line + 2 + size + 2);
        }
        text = parts.join('');
      }
      resolve({ status: Number(status.split(' ')[1]), text, json: JSON.parse(text) });
    });
    socket.on('connect', () => socket.end(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${bearer ? `Authorization: Bearer ${bearer}\r\n` : ''}${body === undefined ? '' : `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`}\r\n${body ?? ''}`));
  });
}

function runCenter(configPath) {
  return spawnSync(process.execPath, [resolve('scripts/im-center.mjs'), configPath],
    { cwd: tmpdir(), encoding: 'utf8', timeout: 5000 });
}

test('center rejects missing database without creating it or listening', t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-center-missing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'missing.sqlite');
  const configPath = join(dir, 'center.json');
  writeFileSync(configPath, JSON.stringify({ dbPath, policy }));
  const result = runCenter(configPath);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.includes('listening'), false);
  assert.equal(existsSync(dbPath), false);
});

test('center rejects existing wrong schema without migration or listener', t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-center-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'wrong.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES (\'unchanged\')');
  db.close();
  const before = readFileSync(dbPath);
  const configPath = join(dir, 'center.json');
  writeFileSync(configPath, JSON.stringify({ dbPath, policy }));
  const result = runCenter(configPath);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.includes('listening'), false);
  assert.deepEqual(readFileSync(dbPath), before);
  const check = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(check.prepare('SELECT value FROM sentinel').get().value, 'unchanged');
  assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'im_%'").get().n, 0);
  check.close();
});

test('composition shares one guard and authenticates without IP fallback; paused writes denied', async t => {
  const f = await setup(t);
  assert.equal(f.im.guard.current instanceof Function, true);
  assert.deepEqual((await f.request('/api/v1/me')).json, { agentId: f.agentId });
  const denied = await f.request('/api/v1/me', { bearer: 'invalid' });
  assert.equal(denied.status, 401);
  assert.equal(denied.json.error.code, 'INVALID_CREDENTIAL');
  assert.equal(denied.text.includes(f.credential), false);
  assert.equal((await f.request('/api/v1/me', { bearer: null })).json.error.code, 'AUTH_REQUIRED');
  assert.equal((await f.request('/api/v1/conversations', { method: 'POST', body: { peerAgentId: f.agentId } })).json.error.code, 'NEW_WRITES_DISABLED');
  assert.equal((await f.request('/api/v1/unknown-resource')).json.error.code, 'RESOURCE_NOT_FOUND');
  assert.equal((await f.request('/api/v1?x=1')).json.error.code, 'INVALID_REQUEST');
  assert.equal((await f.request('/api/v1x/me')).status, 418);
  f.im.close();
  assert.equal((await f.request('/api/v1/me')).json.error.code, 'IM_DISABLED');
});

test('disabled defaults to 503; unexpected errors are redacted', async t => {
  const disabled = await setup(t, { enabled: false });
  const off = await disabled.request('/api/v1/me', { bearer: null });
  assert.equal(off.status, 503);
  assert.equal(off.json.error.code, 'IM_DISABLED');
  assert.equal(off.headers['cache-control'], 'no-store');
  const missing = await setup(t, {});
  assert.equal((await missing.request('/api/v1/me')).json.error.code, 'IM_DISABLED');
  const broken = await setup(t, policy, false, {
    setTimeout() { throw Error('private failure detail'); }, clearTimeout() {},
  });
  const error = await broken.request('/api/v1/me');
  assert.equal(error.status, 503);
  assert.equal(error.json.error.code, 'STORAGE_UNAVAILABLE');
  assert.equal(error.text.includes('private failure detail'), false);
});

test('legacy mount isolates namespace and preserves existing health and 404 behavior', async t => {
  const f = await setup(t, policy, true);
  assert.equal((await f.request('/api/v1/me')).json.agentId, f.agentId);
  assert.equal((await f.request('/api/v1', { bearer: null })).json.error.code, 'AUTH_REQUIRED');
  assert.equal((await f.request('/api/v1/unknown-resource')).json.error.code, 'RESOURCE_NOT_FOUND');
  assert.equal((await f.request('/health')).json.member.name, 'A');
  assert.equal((await f.request('/api/unknown')).json.error, 'Not Found');
  assert.equal((await f.request('/api/v1x/me')).json.error, 'Not Found');
});

test('raw request-target namespace matrix does not route ambiguous IM paths to legacy sends', async t => {
  const f = await setup(t, policy, true);
  for (const [target, im] of [
    ['/api/v1', true], ['/api/v1/me', true], ['/api/v1?x=1', true],
    ['/api/v1x/me', false], ['/API/v1', false], ['//api/v1', false],
    ['/api%2fv1', false], ['/api/v1/../messages', true], ['/api/v1/%2fmessages', true],
  ]) {
    const response = await rawRequest(f.port, target, { bearer: f.credential });
    if (im) {
      if (target === '/api/v1/me') assert.equal(response.status, 200, target);
      else assert.ok(response.status >= 400, target);
      assert.equal(target === '/api/v1/me' ? response.json.agentId : typeof response.json?.error?.code,
        target === '/api/v1/me' ? f.agentId : 'string', target);
    } else {
      assert.equal(response.status, 404, target);
      assert.equal(response.json?.error, 'Not Found', target);
    }
    assert.notEqual(response.json?.error, 'Validation failed', target);
  }
  const count = () => f.db.prepare('SELECT count(*) AS n FROM im_messages').get().n;
  const before = count();
  const payload = JSON.stringify({ to: 'B', text: 'must not route to legacy' });
  for (const target of ['/api/v1/../messages', '/api/v1/%2fmessages']) {
    const response = await rawRequest(f.port, target, { method: 'POST', body: payload, bearer: f.credential });
    assert.ok(response.json?.error?.code, `${target} fell through to legacy: ${response.text}`);
    assert.equal(count(), before);
  }
});

test('legacy default IM is disabled, and an injected false handler cannot fall back', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-legacy-test-'));
  const accessConfigPath = join(dir, 'access.json');
  writeFileSync(accessConfigPath, JSON.stringify(accessConfig));
  const app = createServer({ accessConfigPath, dbPath: join(dir, 'legacy.sqlite'),
    imHandler: { handle: async () => false } });
  await app.start(0, '127.0.0.1');
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const res = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${app.server.address().port}/api/v1/me`, response => {
    let text = ''; response.on('data', chunk => { text += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
  }).on('error', reject));
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'IM_DISABLED');
});

test('schema mismatch fails closed before constructing modules', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  assert.throws(() => createImCenter({ db, policy }), { code: 'IM_SCHEMA_MISMATCH' });
  db.close();
});
