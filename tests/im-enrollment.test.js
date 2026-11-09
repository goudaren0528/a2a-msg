import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { migrateImSchema, migrateImSchemaV3, migrateImSchemaV4 } from '../src/im/schema.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImEnrollment, defaultDisplayName, INVITE_CODE_PATTERN } from '../src/im/enrollment.js';
import { createImAuth } from '../src/im/auth.js';
import { createImCenter } from '../src/im/server.js';

const run = promisify(execFile);
const context = {};
const TTL = 60_000;
const policy = { enabled: true, writeMode: 'enabled', transport: { mode: 'local-test', serverUrl: 'http://127.0.0.1:8787' },
  retention: { policy: { messageRetentionMs: 100000, attachmentRetentionMs: 90000,
    idempotencyRetentionMs: 110000, safeRetryWindowMs: 1000 } }, lease: { ttlMs: 90000, renewalMs: 30000 },
  enrollment: { enabled: true } };

function database(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  migrateImSchemaV4(db);
  t.after(() => db.close());
  return db;
}

function unit(t) {
  const db = database(t);
  let now = 1_000_000;
  const clock = () => now;
  const admin = createImAdmin({ db, clock, authorizeAdmin: candidate => candidate === context });
  const enrollment = createImEnrollment({ db, clock });
  return { db, admin, enrollment, clock, advance: value => { now = value; }, now: () => now };
}

async function center(t, { enabled = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  migrateImSchemaV4(db);
  let now = 1_000_000;
  const clock = () => now;
  const admin = createImAdmin({ db, clock, authorizeAdmin: candidate => candidate === context });
  const composed = createImCenter({ db, clock, policy: { ...policy, enrollment: { enabled } } });
  const server = http.createServer((req, res) => {
    composed.handler.handle(req, res).then(handled => {
      if (!handled) { res.statusCode = 418; res.end('legacy'); }
    }, () => { if (!res.headersSent) { res.statusCode = 503; res.end(); } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    composed.close();
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, { headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, json: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const get = path => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'GET' }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, json: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject); req.end();
  });
  return { db, admin, url, post, get, advance: value => { now = value; } };
}

test('invite creation stores only a hash and never audits the code', t => {
  const f = unit(t);
  const invite = f.admin.createEnrollmentInvite({ ttlMs: TTL }, context);
  assert.match(invite.code, INVITE_CODE_PATTERN);
  assert.equal(invite.expiresAt, f.now() + TTL);
  const row = f.db.prepare('SELECT * FROM im_enrollment_invites').get();
  assert.equal(row.code_hash, createHash('sha256').update(invite.code).digest('hex'));
  assert.equal(JSON.stringify(row).includes(invite.code), false);
  const audit = f.db.prepare('SELECT * FROM im_audit').all().map(value => JSON.stringify(value)).join(' ');
  assert.equal(audit.includes(invite.code), false);
  assert.equal(audit.includes(row.code_hash), false);
  assert.equal(f.db.prepare("SELECT count(*) n FROM im_audit WHERE action='create_enrollment_invite'").get().n, 1);
  for (const ttlMs of [0, 59_999, 30 * 24 * 60 * 60 * 1000 + 1, 1.5, '60000']) {
    assert.throws(() => f.admin.createEnrollmentInvite({ ttlMs }, context), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => f.admin.createEnrollmentInvite({ ttlMs: TTL, extra: 1 }, context), { code: 'INVALID_REQUEST' });
});

test('redemption creates one agent and credential; replay, expiry, revocation and unknown codes are distinct', t => {
  const f = unit(t);
  const invite = f.admin.createEnrollmentInvite({ ttlMs: TTL }, context);
  const enrolled = f.enrollment.redeem({ inviteCode: invite.code, displayName: 'device-one' });
  assert.match(enrolled.agentId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.match(enrolled.credential, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(enrolled.credential.slice(0, 36), enrolled.credentialId);
  assert.deepEqual(createImAuth({ db: f.db, clock: f.clock }).authenticate(enrolled.credential),
    Object.freeze({ agentId: enrolled.agentId, credentialId: enrolled.credentialId }));
  const used = f.db.prepare('SELECT used_at,used_agent_id FROM im_enrollment_invites WHERE invite_id=?').get(invite.inviteId);
  assert.equal(used.used_agent_id, enrolled.agentId);
  assert.equal(used.used_at, f.now());
  const audit = f.db.prepare("SELECT * FROM im_audit WHERE action='enroll_agent'").all();
  assert.equal(audit.length, 1);
  assert.equal(JSON.stringify(audit).includes(enrolled.credential), false);
  assert.equal(JSON.stringify(audit).includes(invite.code), false);

  assert.throws(() => f.enrollment.redeem({ inviteCode: invite.code, displayName: 'again' }), { code: 'INVITE_ALREADY_USED' });
  assert.equal(f.db.prepare('SELECT count(*) n FROM im_agents').get().n, 1);

  const expired = f.admin.createEnrollmentInvite({ ttlMs: TTL }, context);
  f.advance(expired.expiresAt);
  assert.throws(() => f.enrollment.redeem({ inviteCode: expired.code, displayName: 'late' }), { code: 'INVITE_EXPIRED' });

  const revoked = f.admin.createEnrollmentInvite({ ttlMs: TTL }, context);
  f.admin.revokeEnrollmentInvite({ inviteId: revoked.inviteId, reason: 'test' }, context);
  assert.throws(() => f.enrollment.redeem({ inviteCode: revoked.code, displayName: 'revoked' }), { code: 'INVITE_REVOKED' });

  const unknown = randomBytes(32).toString('base64url');
  assert.throws(() => f.enrollment.redeem({ inviteCode: unknown, displayName: 'nobody' }), { code: 'INVITE_NOT_FOUND' });

  const pending = f.admin.createEnrollmentInvite({ ttlMs: TTL }, context);
  for (const input of [{ inviteCode: 'short', displayName: 'x' }, { inviteCode: pending.code, displayName: '' },
    { inviteCode: pending.code, displayName: 'bad\u0007name' }, { inviteCode: pending.code, displayName: 'ok', extra: 1 }]) {
    assert.throws(() => f.enrollment.redeem(input), { code: 'INVALID_REQUEST' });
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM im_agents').get().n, 1);
});

test('HTTP enrollment precedes Bearer auth, works, and fails with fixed codes', t => center(t).then(async f => {
  const first = f.admin.createEnrollmentInvite({ ttlMs: TTL }, context);
  const enrolled = await f.post('/api/v1/enroll', { inviteCode: first.code, displayName: 'device-http' });
  assert.equal(enrolled.status, 201);
  assert.equal(Object.hasOwn(enrolled.json, 'credential'), true);
  assert.equal(JSON.stringify(enrolled.json).length > 0, true);
  assert.equal((await f.get('/api/v1/me')).status, 401);
  const me = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: new URL(f.url).port, path: '/api/v1/me', method: 'GET',
      headers: { Authorization: `Bearer ${enrolled.json.credential}` } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () =>
        resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); req.end();
  });
  assert.deepEqual(me, { status: 200, json: { agentId: enrolled.json.agentId } });

  assert.equal((await f.post('/api/v1/enroll', { inviteCode: first.code, displayName: 'again' })).json.error.code,
    'INVITE_ALREADY_USED');
  assert.equal((await f.post('/api/v1/enroll', { inviteCode: 'x'.repeat(44), displayName: 'x' })).json.error.code,
    'INVALID_REQUEST');
  assert.equal((await f.post('/api/v1/enroll', { inviteCode: randomBytes(32).toString('base64url'), displayName: 'x' }))
    .json.error.code, 'INVITE_NOT_FOUND');
  assert.equal((await f.post('/api/v1/enroll?limit=1', { inviteCode: randomBytes(32).toString('base64url'),
    displayName: 'x' })).json.error.code, 'INVALID_REQUEST');
  const noType = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: new URL(f.url).port, path: '/api/v1/enroll', method: 'POST',
      headers: { 'content-type': 'text/plain' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(noType, 400);
}));

test('HTTP enrollment is disabled by policy and never opens a write path', async t => {
  const f = await center(t, { enabled: false });
  const invite = f.admin.createEnrollmentInvite({ ttlMs: TTL }, context);
  const disabled = await f.post('/api/v1/enroll', { inviteCode: invite.code, displayName: 'device' });
  assert.equal(disabled.status, 403);
  assert.equal(disabled.json.error.code, 'ENROLLMENT_DISABLED');
  assert.equal(f.db.prepare('SELECT count(*) n FROM im_agents').get().n, 0);
  assert.equal(f.db.prepare('SELECT used_at FROM im_enrollment_invites WHERE invite_id=?').get(invite.inviteId).used_at, null);
});

test('im-register.mjs writes protected artifacts, prints no credential, and refuses to overwrite identity', { timeout: 20000 },
  async t => {
    const f = await center(t);
    const root = mkdtempSync(join(tmpdir(), 'im-register-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const state = join(root, 'state');
    const invite = f.admin.createEnrollmentInvite({ ttlMs: TTL }, context);
    const { stdout } = await run(process.execPath, ['scripts/im-register.mjs', '--center', f.url,
      '--invite', invite.code, '--display-name', 'device-cli', '--state-dir', state], { cwd: new URL('..', import.meta.url) });
    const output = JSON.parse(stdout);
    assert.match(output.agentId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.equal(stdout.includes(invite.code), false);
    assert.equal(Object.hasOwn(output, 'credential'), false);
    const identity = JSON.parse(readFileSync(join(state, 'identity.json'), 'utf8'));
    const record = JSON.parse(readFileSync(identity.credentialFile, 'utf8'));
    assert.equal(record.agentId, output.agentId);
    if (process.platform !== 'win32') {
      assert.equal(statSync(state).mode & 0o777, 0o700);
      assert.equal(statSync(join(state, 'identity.json')).mode & 0o777, 0o600);
      assert.equal(statSync(identity.credentialFile).mode & 0o777, 0o600);
    }
    const me = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: new URL(f.url).port, path: '/api/v1/me', method: 'GET',
        headers: { Authorization: `Bearer ${record.credential}` } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () =>
          resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on('error', reject); req.end();
    });
    assert.deepEqual(me, { status: 200, json: { agentId: output.agentId } });

    const second = f.admin.createEnrollmentInvite({ ttlMs: TTL }, context);
    await assert.rejects(run(process.execPath, ['scripts/im-register.mjs', '--center', f.url,
      '--invite', second.code, '--display-name', 'second', '--state-dir', state],
      { cwd: new URL('..', import.meta.url) }), error => {
      assert.equal(error.stderr.includes('IDENTITY_EXISTS'), true);
      assert.equal(error.stderr.includes(second.code), false);
      return true;
    });
    assert.equal(f.db.prepare('SELECT used_at FROM im_enrollment_invites WHERE invite_id=?').get(second.inviteId).used_at, null);
  });

test('im-migrate-v4.mjs performs the explicit v3 to v4 upgrade and is repeatable', { timeout: 20000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'im-migrate-v4-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, 'center.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON'); migrateImSchemaV3(db);
  db.exec("INSERT INTO im_agents VALUES ('a','A','active',1,NULL)");
  db.close();
  const configPath = join(root, 'center-config.json');
  writeFileSync(configPath, JSON.stringify({ dbPath }));
  const first = JSON.parse((await run(process.execPath, ['scripts/im-migrate-v4.mjs', configPath],
    { cwd: new URL('..', import.meta.url) })).stdout);
  assert.deepEqual({ status: first.status, from: first.from, to: first.to }, { status: 'migrated', from: 3, to: 4 });
  assert.match(first.schemaChecksum, /^[0-9a-f]{64}$/);
  const second = JSON.parse((await run(process.execPath, ['scripts/im-migrate-v4.mjs', configPath],
    { cwd: new URL('..', import.meta.url) })).stdout);
  assert.equal(second.from, 4);
  const check = new DatabaseSync(dbPath, { readOnly: true });
  try {
    check.exec('PRAGMA foreign_keys=ON');
    assert.equal(check.prepare('SELECT version FROM im_schema').get().version, 4);
    assert.equal(check.prepare('SELECT display_name FROM im_agents WHERE agent_id=?').get('a').display_name, 'A');
  } finally { check.close(); }

  const v2Path = join(root, 'v2.sqlite');
  const v2 = new DatabaseSync(v2Path); v2.exec('PRAGMA foreign_keys=ON'); migrateImSchema(v2); v2.close();
  const v2Config = join(root, 'v2-config.json');
  writeFileSync(v2Config, JSON.stringify({ dbPath: v2Path }));
  await assert.rejects(run(process.execPath, ['scripts/im-migrate-v4.mjs', v2Config],
    { cwd: new URL('..', import.meta.url) }), error => error.stderr.includes('MIGRATION_STALE'));
});

// ---- device-side join / pinned CA registration (AC-R2, AC-R3) ----

const REGISTER = 'scripts/im-register.mjs';
const BIN = 'bin/a2a-msg.mjs';
const TLS_KEY = fileURLToPath(new URL('./fixtures/im-tls/localhost-test-only.key', import.meta.url));
const TLS_CERT = fileURLToPath(new URL('./fixtures/im-tls/localhost-test-only.crt', import.meta.url));
const UNRELATED_CA = fileURLToPath(new URL('./fixtures/im-tls/unrelated-ca.crt', import.meta.url));
const fingerprint = path => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

// Real center process (scripts/im-center.mjs) so GET /ca.pem and the enrollment
// route are exercised end to end. The invite is issued before the process opens
// the same database. `caCertPath` changes what /ca.pem publishes.
async function tlsCenter(t, { caCertPath = TLS_CERT } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'im-join-center-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'center.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON');
  migrateImSchemaV4(db);
  const admin = createImAdmin({ db, authorizeAdmin: candidate => candidate === context });
  const invite = admin.createEnrollmentInvite({ ttlMs: TTL }, context);
  db.close();
  const port = await freePort();
  const configPath = join(dir, 'center.json');
  writeFileSync(configPath, JSON.stringify({ dbPath, policy: {
    enabled: true, writeMode: 'paused',
    transport: { mode: 'direct-tls', serverUrl: `https://localhost:${port}` },
    enrollment: { enabled: true },
  }, tls: { keyPath: TLS_KEY, certPath: TLS_CERT, ...(caCertPath === undefined ? {} : { caCertPath }) } }));
  const child = spawn(process.execPath, ['scripts/im-center.mjs', configPath],
    { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '', settled = false;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((done, reject) => {
    const finish = error => {
      if (settled) return;
      settled = true;
      error ? reject(error) : done();
    };
    child.once('exit', code => finish(Error(`center exited ${code}: ${stderr}`)));
    child.stdout.on('data', () => { if (stdout.includes('IM center listening')) finish(null); });
    setTimeout(() => finish(Error(`center did not start: ${stderr}`)), 15000).unref();
  });
  return {
    url: `https://localhost:${port}`, invite, dir,
    // Read-only, after the child is gone: proves a failed attempt never spent the invite.
    usedAt: () => {
      const check = new DatabaseSync(dbPath, { readOnly: true });
      try { return check.prepare('SELECT used_at FROM im_enrollment_invites WHERE invite_id=?')
        .get(invite.inviteId).used_at; } finally { check.close(); }
    },
  };
}

// Registration never inherits a private CA from the test runner's environment.
function runRegister(script, args) {
  const env = { ...process.env };
  delete env.NODE_EXTRA_CA_CERTS;
  return run(process.execPath, [script, ...args], { cwd: new URL('..', import.meta.url), env });
}

test('defaultDisplayName turns any hostname into a valid, bounded display name', async () => {
  assert.equal(defaultDisplayName('MacBook-Air.local'), 'MacBook-Air.local');
  assert.equal(defaultDisplayName('MacBook Air 的电脑'), 'MacBook-Air');
  assert.equal(defaultDisplayName('a\tb\nc'), 'a-b-c');
  assert.equal(defaultDisplayName('   '), 'device');
  assert.equal(defaultDisplayName('/ /'), 'device');
  assert.equal(defaultDisplayName(''), 'device');
  assert.equal(defaultDisplayName(undefined), 'device');
  assert.equal(defaultDisplayName('a'.repeat(300)), 'a'.repeat(255));
  for (const value of ['MacBook Air 的电脑', 'a\tb', '']) {
    const name = defaultDisplayName(value);
    assert.ok(name.length >= 1 && name.length <= 255, name);
    assert.equal(/[\x00-\x1f\x7f]/.test(name), false, name);
  }
});

test('register --ca-url pins the fetched CA and only then enrolls', { timeout: 30000 }, async t => {
  const f = await tlsCenter(t);
  const state = join(f.dir, 'state');
  const caFingerprint = fingerprint(TLS_CERT);
  const { stdout } = await runRegister(REGISTER, ['--center', f.url, '--invite', f.invite.code,
    '--ca-url', `${f.url}/ca.pem`, '--ca-sha256', caFingerprint, '--state-dir', state]);
  const output = JSON.parse(stdout);
  assert.equal(output.centerUrl, f.url);
  assert.equal(output.displayName, defaultDisplayName(hostname()), 'display-name defaults to the hostname');
  const identity = JSON.parse(readFileSync(join(state, 'identity.json'), 'utf8'));
  assert.equal(identity.agentId, output.agentId);
  assert.equal(identity.centerUrl, f.url);
  assert.notEqual(f.usedAt(), null, 'the invite was spent exactly once');
  // The pinned CA is not persisted: the state dir keeps the pre-existing layout.
  assert.deepEqual(readdirSync(state).sort(), ['credentials', 'identity.json']);
});

test('register with a wrong --ca-sha256 fails closed before any identity artifact', { timeout: 30000 }, async t => {
  const f = await tlsCenter(t);
  const state = join(f.dir, 'state');
  await assert.rejects(runRegister(REGISTER, ['--center', f.url, '--invite', f.invite.code,
    '--ca-url', `${f.url}/ca.pem`, '--ca-sha256', `sha256:${'0'.repeat(64)}`, '--state-dir', state]),
  error => {
    assert.match(error.stderr, /"code":"CA_FINGERPRINT_MISMATCH"/);
    assert.equal(error.stderr.includes(f.invite.code), false, 'the invite code is never echoed');
    return true;
  });
  assert.equal(existsSync(join(state, 'identity.json')), false);
  assert.deepEqual(readdirSync(join(state, 'credentials')), []);
  assert.equal(f.usedAt(), null, 'the invite is untouched');
});

test('a pinned CA that did not issue the center certificate fails closed', { timeout: 30000 }, async t => {
  // /ca.pem publishes an unrelated self-signed CA whose fingerprint matches the
  // link, so only the TLS chain check can stop enrollment.
  const f = await tlsCenter(t, { caCertPath: UNRELATED_CA });
  const state = join(f.dir, 'state');
  await assert.rejects(runRegister(REGISTER, ['--center', f.url, '--invite', f.invite.code,
    '--ca-url', `${f.url}/ca.pem`, '--ca-sha256', fingerprint(UNRELATED_CA), '--state-dir', state]),
  error => {
    assert.match(error.stderr, /"code":"CA_NOT_TRUSTED"/);
    return true;
  });
  assert.equal(existsSync(join(state, 'identity.json')), false);
  assert.equal(f.usedAt(), null, 'the invite is untouched');
});

test('an unreachable --ca-url fails closed and writes nothing', { timeout: 30000 }, async t => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'im-join-ca-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  await assert.rejects(runRegister(REGISTER, ['--center', `https://localhost:${port}`,
    '--invite', `a${'b'.repeat(42)}`, '--ca-url', `https://localhost:${port}/ca.pem`,
    '--ca-sha256', `sha256:${'1'.repeat(64)}`, '--state-dir', state]),
  error => {
    assert.match(error.stderr, /"code":"CA_FETCH_FAILED"/);
    return true;
  });
  assert.equal(existsSync(join(state, 'identity.json')), false);
});

test('join <link> registers in one command and keeps the default state layout', { timeout: 30000 }, async t => {
  const f = await tlsCenter(t);
  const home = join(f.dir, 'home');
  mkdirSync(home, { recursive: true });
  const link = `${f.url}/join#invite=${f.invite.code}&ca=${encodeURIComponent(fingerprint(TLS_CERT))}`;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.NODE_EXTRA_CA_CERTS;
  const { stdout } = await run(process.execPath, [BIN, 'join', link], { cwd: new URL('..', import.meta.url), env });
  const output = JSON.parse(stdout);
  assert.equal(output.centerUrl, f.url);
  assert.equal(output.displayName, defaultDisplayName(hostname()));
  assert.equal(stdout.includes(f.invite.code), false, 'the invite code is never printed');
  const state = join(home, '.a2a-msg');
  assert.deepEqual(readdirSync(state).sort(), ['credentials', 'identity.json'], 'default state layout is unchanged');
  const identity = JSON.parse(readFileSync(join(state, 'identity.json'), 'utf8'));
  assert.equal(identity.agentId, output.agentId);
  assert.equal(identity.centerUrl, f.url);
  assert.equal(statSync(state).mode & 0o777, 0o700);
  assert.equal(statSync(join(state, 'identity.json')).mode & 0o777, 0o600);
});

test('join accepts --display-name and rejects malformed or unpinned links', { timeout: 30000 }, async t => {
  const f = await tlsCenter(t);
  const state = join(f.dir, 'named');
  const link = `${f.url}/join#ca=${encodeURIComponent(fingerprint(TLS_CERT))}&invite=${f.invite.code}`;
  const env = { ...process.env };
  delete env.NODE_EXTRA_CA_CERTS;
  const { stdout } = await run(process.execPath, [BIN, 'join', link, '--display-name', 'office-mac', '--state-dir', state],
    { cwd: new URL('..', import.meta.url), env });
  assert.equal(JSON.parse(stdout).displayName, 'office-mac');

  for (const bad of [
    `${f.url}/join#invite=${f.invite.code}`, // no CA fingerprint: unpinned
    `${f.url}/join#invite=${f.invite.code}&ca=sha256:nothex`,
    `${f.url}/wrong#invite=${f.invite.code}&ca=sha256:${'a'.repeat(64)}`,
    `http://example.invalid/join#invite=${f.invite.code}&ca=sha256:${'a'.repeat(64)}`,
  ]) {
    await assert.rejects(run(process.execPath, [BIN, 'join', bad, '--state-dir', join(f.dir, 'bad')],
      { cwd: new URL('..', import.meta.url) }), error => {
      assert.equal(/INVALID_JOIN_LINK|TLS_REQUIRED/.test(error.stderr), true, bad);
      return true;
    });
  }
});
