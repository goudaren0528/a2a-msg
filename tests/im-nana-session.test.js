import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createImAdmin } from '../src/im/admin.js';
import { createImCenter } from '../src/im/server.js';
import { initInstanceIdentity, migrateImSchemaV3 } from '../src/im/schema.js';
import { createNanaSession } from '../src/nana/session.js';
import { parseNanaConfig } from '../src/nana/config.js';

const certificate = readFileSync(new URL('./fixtures/im-tls/localhost-test-only.crt', import.meta.url));
const key = readFileSync(new URL('./fixtures/im-tls/localhost-test-only.key', import.meta.url));
const UUID = () => randomUUID();

function hostConfig(root, name, agent, serverUrl) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const attachmentDirectory = join(directory, 'attachments');
  mkdirSync(attachmentDirectory, { recursive: true, mode: 0o700 });
  const credentialFile = join(directory, 'credential');
  writeFileSync(credentialFile, `${agent.credential}\n`, { mode: 0o600 });
  return { serverUrl, agentId: agent.agentId, credentialFile,
    journalPath: join(directory, 'journal.sqlite'), attachmentDirectory,
    statePath: join(directory, 'session-state.json'), evidencePath: join(directory, 'evidence.jsonl') };
}

async function startCenter() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'im-nana-session-'));
  const db = new DatabaseSync(join(root, 'center.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  migrateImSchemaV3(db);
  initInstanceIdentity(db, { clock: Date.now });
  const trusted = {}, clock = () => Date.now();
  const admin = createImAdmin({ db, clock, authorizeAdmin: context => context === trusted });
  const agents = ['nana-home', 'nana-office', 'outsider'].map(displayName => {
    const agentId = admin.registerAgent({ displayName }, trusted).agentId;
    return { agentId, credential: admin.issueCredential({ agentId, expiresAt: null }, trusted).credential };
  });
  admin.setContact({ agentA: agents[0].agentId, agentB: agents[1].agentId, allowed: true, reason: 'isolated test' }, trusted);
  db.exec("UPDATE im_settings SET write_mode='enabled' WHERE singleton=1");
  const policy = { enabled: true, writeMode: 'enabled', transport: { mode: 'direct-tls', serverUrl: 'https://127.0.0.1:8787' },
    retention: { policy: { messageRetentionMs: 86400000, attachmentRetentionMs: 86400000,
      idempotencyRetentionMs: 172800000, safeRetryWindowMs: 60000 } },
    lease: { ttlMs: 60000, renewalMs: 10000 } };
  const center = createImCenter({ db, policy, clock });
  const server = https.createServer({ key, cert: certificate, maxHeaderSize: 8192 }, async (req, res) => {
    try { if (!await center.handler.handle(req, res)) { res.statusCode = 404; res.end(); } }
    catch { res.destroy(); }
  });
  server.maxHeadersCount = 50;
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const serverUrl = `https://127.0.0.1:${server.address().port}`;
  const agent = new https.Agent({ ca: certificate, rejectUnauthorized: true });
  const transport = input => new Promise((resolve, reject) => {
    const req = https.request(new URL(input.path, serverUrl), { method: input.method, agent, timeout: 30000,
      headers: { Authorization: `Bearer ${input.credential}`, ...input.headers,
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }) } }, res => {
      const chunks = [];
      let length = 0;
      res.on('data', chunk => {
        length += chunk.length;
        if (length > 16 * 1024 * 1024) req.destroy();
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks, length) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy());
    req.end(input.body);
  });
  const sessions = [];
  return {
    root, db, agents, serverUrl, transport,
    open(name, agent = agents[1]) {
      const session = createNanaSession({ config: hostConfig(root, name, agent, serverUrl), transport });
      sessions.push(session);
      return session;
    },
    async close() {
      for (const session of sessions) { try { session.close(); } catch { /* already closed */ } }
      center.close();
      server.closeAllConnections();
      await new Promise(done => server.close(done));
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const journal = session => {
  const db = new DatabaseSync(session.config.journalPath, { readOnly: true });
  try {
    return db.prepare('SELECT seq,message_id,acked FROM im_client_received ORDER BY seq').all()
      .map(row => ({ seq: row.seq, messageId: row.message_id, acked: row.acked }));
  } finally { db.close(); }
};
const evidence = session => readFileSync(session.config.evidencePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const delivery = (db, messageId) => db.prepare('SELECT acked_at,read_at FROM im_deliveries WHERE message_id=?').get(messageId);

test('Nana session: journal-before-ACK receive, durable handoff cursor, dedupe, restart, reply/read', async () => {
  const fixture = await startCenter();
  let a, b, restarted;
  try {
    a = fixture.open('host-a', fixture.agents[0]);
    b = fixture.open('host-b', fixture.agents[1]);
    const first = UUID();
    const text = 'T2 往返测试';
    const sent = await a.send({ toAgentId: b.config.agentId, text, clientMessageId: first });
    assert.equal(sent.status, 'accepted');
    assert.equal(fixture.db.prepare('SELECT COUNT(*) n FROM im_messages').get().n, 1);
    assert.equal(delivery(fixture.db, sent.messageId).acked_at, null);
    assert.deepEqual(b.queue(), { agentId: b.config.agentId, received: 0, handedThrough: 0, pending: 0, cursor: 0 });

    const received = await b.receive();
    assert.deepEqual(received.received.map(item => item.messageId), [sent.messageId]);
    assert.equal(received.received[0].acked, true);
    assert.equal(received.releaseError, null);
    assert.deepEqual(journal(b), [{ seq: 1, messageId: sent.messageId, acked: 1 }]);
    assert.ok(delivery(fixture.db, sent.messageId).acked_at !== null);
    assert.deepEqual(b.queue(), { agentId: b.config.agentId, received: 1, handedThrough: 0, pending: 1, cursor: 1 });

    const handoff = b.handoff();
    assert.equal(handoff.handedThrough, 1);
    assert.deepEqual(handoff.items.map(item => [item.text, item.acked]), [[text, true]]);
    assert.equal(b.queue().pending, 0);
    assert.deepEqual(b.handoff().items, []);
    assert.deepEqual(evidence(b).map(item => item.type), ['receive', 'handoff']);

    const duplicate = await a.send({ toAgentId: b.config.agentId, text, clientMessageId: first });
    assert.equal(duplicate.messageId, sent.messageId);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) n FROM im_messages').get().n, 1);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) n FROM im_send_keys').get().n, 1);
    assert.deepEqual((await b.receive()).received, []);
    assert.deepEqual(journal(b), [{ seq: 1, messageId: sent.messageId, acked: 1 }]);
    assert.deepEqual(b.handoff().items, []);
    assert.equal(evidence(a).filter(item => item.type === 'send' && item.messageId === sent.messageId).length, 2);
    assert.equal(evidence(b).filter(item => item.type === 'receive').length, 1);
    await assert.rejects(a.send({ toAgentId: b.config.agentId, text: 'different', clientMessageId: first }),
      error => error.code === 'IDEMPOTENCY_CONFLICT');

    b.close();
    restarted = fixture.open('host-b', fixture.agents[1]);
    const second = await a.send({ toAgentId: restarted.config.agentId, text: 'restart recovery' });
    const resumed = await restarted.receive();
    assert.deepEqual(resumed.received.map(item => item.messageId), [second.messageId]);
    assert.deepEqual(journal(restarted), [
      { seq: 1, messageId: sent.messageId, acked: 1 },
      { seq: 2, messageId: second.messageId, acked: 1 },
    ]);
    assert.deepEqual(restarted.handoff().items.map(item => item.text), ['restart recovery']);
    assert.equal(restarted.queue().handedThrough, 2);
    const receiveInstances = evidence(restarted).filter(item => item.type === 'receive').map(item => item.instanceId);
    assert.equal(new Set(receiveInstances).size, receiveInstances.length);
    assert.ok(fixture.db.prepare('SELECT generation g FROM im_receiver_leases WHERE agent_id=?')
      .get(restarted.config.agentId).g >= 2);

    const reply = await restarted.send({ toAgentId: a.config.agentId, text: 'reply',
      clientMessageId: UUID(), inReplyTo: sent.messageId });
    const receivedByA = await a.receive();
    assert.deepEqual(receivedByA.received.map(item => item.messageId), [reply.messageId]);
    const beforeRead = await a.message({ messageId: reply.messageId });
    assert.ok(beforeRead.deliveredAt !== null);
    assert.equal(beforeRead.readAt, null);
    const marked = await a.read({ messageId: reply.messageId });
    assert.equal(marked.changed, true);
    const senderView = await restarted.message({ messageId: reply.messageId });
    assert.equal(senderView.deliveredAt, beforeRead.deliveredAt);
    assert.equal(senderView.readAt, marked.readAt);
  } finally {
    await fixture.close();
  }
});

test('Nana session: lease conflict, bad credential, unknown contact and strict input/config validation', async () => {
  const fixture = await startCenter();
  let a, b, secondReceiver, bad;
  try {
    a = fixture.open('host-a', fixture.agents[0]);
    b = fixture.open('host-b', fixture.agents[1]);
    const sent = await a.send({ toAgentId: b.config.agentId, text: 'lease test' });

    const held = await b.acquire();
    assert.ok(held.generation >= 1);
    secondReceiver = fixture.open('host-b', fixture.agents[1]);
    await assert.rejects(secondReceiver.receive(), error => error.code === 'LEASE_CONFLICT');
    await assert.rejects(secondReceiver.acquire(), error => error.code === 'LEASE_CONFLICT');
    await b.release();
    assert.deepEqual((await secondReceiver.receive()).received.map(item => item.messageId), [sent.messageId]);

    const badConfig = { ...a.config, credentialFile: join(fixture.root, 'bad-credential') };
    writeFileSync(badConfig.credentialFile, `${UUID()}.${'A'.repeat(43)}\n`, { mode: 0o600 });
    bad = createNanaSession({ config: badConfig, transport: fixture.transport });
    await assert.rejects(bad.message({ messageId: sent.messageId }), error => error.code === 'INVALID_CREDENTIAL');
    await assert.rejects(bad.send({ toAgentId: b.config.agentId, text: 'x' }), error => error.code === 'INVALID_CREDENTIAL');

    await assert.rejects(a.send({ toAgentId: fixture.agents[2].agentId, text: 'no contact' }),
      error => error.code === 'RESOURCE_NOT_FOUND');
    await assert.rejects(a.send({ toAgentId: 'not-a-uuid', text: 'x' }), error => error.code === 'INVALID_REQUEST');
    await assert.rejects(a.send({ toAgentId: b.config.agentId, text: '' }), error => error.code === 'INVALID_REQUEST');
    await assert.rejects(a.message({ messageId: 'not-a-uuid' }), error => error.code === 'INVALID_REQUEST');
    await assert.rejects(b.receive({ limit: 0 }), error => error.code === 'INVALID_REQUEST');
    await assert.rejects(b.receive({ limit: 101 }), error => error.code === 'INVALID_REQUEST');
    assert.throws(() => b.handoff({ limit: 101 }), error => error.code === 'INVALID_REQUEST');
    assert.throws(() => parseNanaConfig({ ...a.config, extra: true }), error => error.code === 'INVALID_REQUEST');
    assert.throws(() => parseNanaConfig({ ...a.config, serverUrl: 'http://127.0.0.1:1' }), error => error.code === 'INVALID_REQUEST');
    assert.throws(() => parseNanaConfig({ ...a.config, journalPath: 'relative.sqlite' }), error => error.code === 'INVALID_REQUEST');
    assert.throws(() => createNanaSession({ config: { ...a.config, attachmentDirectory: join(fixture.root, 'missing') } }),
      error => error.code === 'INVALID_REQUEST');
  } finally {
    bad?.close();
    await fixture.close();
  }
});
