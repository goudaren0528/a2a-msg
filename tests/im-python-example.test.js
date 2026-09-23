import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createImCenter } from '../src/im/server.js';
import { migrateImSchema } from '../src/im/schema.js';
import { createImAdmin } from '../src/im/admin.js';

const certificate = resolve('tests/fixtures/im-tls/localhost-test-only.crt');
const key = resolve('tests/fixtures/im-tls/localhost-test-only.key');
const demo = resolve('examples/python/demo.py');

test('Python example performs send → sync → verified attachment → ack over verified localhost TLS', async t => {
  const python = ['python', 'python3'].find(name => {
    const probe = spawnSync(name, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'],
      { encoding: 'utf8', timeout: 5000 });
    return probe.status === 0;
  });
  if (!python) {
    t.diagnostic('Python 3.8+ unavailable: real Python HTTP chain NOT executed');
    t.skip('Python 3.8+ unavailable');
    return;
  }
  t.diagnostic(`Python executable available: ${python}; real HTTPS chain will run`);
  const dir = mkdtempSync(join(tmpdir(), 'im-python-example-'));
  const db = new DatabaseSync(join(dir, 'isolated.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  migrateImSchema(db);
  const trusted = {}, clock = () => Date.now();
  const admin = createImAdmin({ db, clock, authorizeAdmin: ctx => ctx === trusted });
  const sender = admin.registerAgent({ displayName: 'Python sender' }, trusted).agentId;
  const receiver = admin.registerAgent({ displayName: 'Python receiver' }, trusted).agentId;
  admin.setContact({ agentA: sender, agentB: receiver, allowed: true, reason: 'isolated test' }, trusted);
  const senderCredential = admin.issueCredential({ agentId: sender, expiresAt: null }, trusted).credential;
  const receiverCredential = admin.issueCredential({ agentId: receiver, expiresAt: null }, trusted).credential;
  db.exec("UPDATE im_settings SET write_mode='enabled' WHERE singleton=1");
  const policy = { enabled: true, writeMode: 'enabled',
    transport: { mode: 'direct-tls', serverUrl: 'https://localhost:8787' },
    retention: { policy: { messageRetentionMs: 86400000, attachmentRetentionMs: 86400000,
      idempotencyRetentionMs: 172800000, safeRetryWindowMs: 60000 } },
    lease: { ttlMs: 60000, renewalMs: 10000 } };
  const im = createImCenter({ db, policy, clock });
  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(certificate),
    maxHeaderSize: 8192 }, async (req, res) => {
    if (!await im.handler.handle(req, res)) { res.statusCode = 404; res.end(); }
  });
  server.maxHeadersCount = 50;
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  try {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });
    const result = await new Promise((done, reject) => {
      const child = spawn(python, [demo], { timeout: 90000,
        env: { ...process.env, IM_URL: `https://localhost:${server.address().port}`,
        IM_CA_FILE: certificate, IM_CREDENTIAL: senderCredential,
        IM_RECEIVER_CREDENTIAL: receiverCredential, IM_PEER_ID: receiver } });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes.toString().slice(0, 1024); });
      child.stderr.on('data', bytes => { stderr += bytes.toString().slice(0, 1024); });
      child.once('error', reject);
      child.once('close', (status, signal) => done({ status, signal, stdout, stderr }));
    });
    assert.equal(result.status, 0, `Python scenario failed (${result.signal ?? 'nonzero exit'}): ${result.stdout} ${result.stderr}`);
    assert.match(result.stdout, /send sync attachment ack passed/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM im_messages').get().n, 1);
    assert.equal(db.prepare('SELECT acked_through FROM im_receive_state WHERE agent_id=?').get(receiver).acked_through, 1);
    t.diagnostic('Executed: /me, contacts, ensure, send, send-result, history, get-message, lease acquire/renew, sync, verified attachment, ack, read; release method not exercised');
  } finally {
    im.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
