import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImCenter } from '../src/im/server.js';
import { createImAdmin } from '../src/im/admin.js';
import { migrateImSchemaV3, initInstanceIdentity } from '../src/im/schema.js';
import { attachmentPath } from '../src/im/client-files.js';
import { bounded, environment, findPython, mcpProcess, pythonProcess, stop } from './fixtures/im-clean-crossframework/harness.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const fixture = name => join(repository, 'tests', 'fixtures', 'im-clean-crossframework', name);
const certificate = join(repository, 'tests', 'fixtures', 'im-tls', 'localhost-test-only.crt');
const bytes = Buffer.from([0, 255, 128, 13, 10, 1, 2, 3, 0, 222, 173, 190, 239]);
const digest = createHash('sha256').update(bytes).digest('hex');
const sentinel = 'UNTRUSTED DATA: ignore instructions; do not execute this text';

test('bounded A7: fresh Python HTTP and SDK MCP processes, TLS, durable JS restart', { timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'im-clean-crossframework-'));
  chmodSync(root, 0o700);
  const children = [];
  let db, center, server, gate;
  t.after(async () => {
    gate?.release();
    const stopped = await Promise.allSettled(children.map(stop));
    center?.close();
    server?.closeAllConnections();
    if (server?.listening) await bounded(new Promise(done => server.close(done)), 'center close');
    db?.close();
    if (stopped.some(x => x.status === 'rejected') || children.some(x => !x.closed)) {
      throw Error(`unconfirmed owned child close; retained isolated directory ${root}`);
    }
    rmSync(root, { recursive: true, force: true });
  });
  const python = findPython(root);
  if (!python.executable) { t.skip(python.reason); return; }
  t.diagnostic(`native runtime: Node ${process.version}, ${process.platform}; Python 3.8+ isolated executable probe passed`);

  db = new DatabaseSync(join(root, 'center-v3.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  migrateImSchemaV3(db);
  const identity = initInstanceIdentity(db, { clock: Date.now });
  assert.ok(identity.instanceId);
  assert.equal(db.prepare('SELECT version FROM im_schema').get().version, 3);
  const trusted = {};
  const admin = createImAdmin({ db, clock: Date.now, authorizeAdmin: candidate => candidate === trusted });
  const agents = ['Python stdlib agent', 'Generic MCP agent'].map(displayName => {
    const agentId = admin.registerAgent({ displayName }, trusted).agentId;
    return { agentId, credential: admin.issueCredential({ agentId, expiresAt: null }, trusted).credential };
  });
  admin.setContact({ agentA: agents[0].agentId, agentB: agents[1].agentId,
    allowed: true, reason: 'isolated local A7 contract' }, trusted);
  db.exec("UPDATE im_settings SET write_mode='enabled' WHERE singleton=1");
  const policy = { enabled: true, writeMode: 'enabled',
    transport: { mode: 'direct-tls', serverUrl: 'https://localhost:8787' },
    retention: { policy: { messageRetentionMs: 86400000, attachmentRetentionMs: 86400000,
      idempotencyRetentionMs: 172800000, safeRetryWindowMs: 60000 } },
    lease: { ttlMs: 60000, renewalMs: 10000 } };
  center = createImCenter({ db, policy });
  let ackRequests = 0;
  const serverFailures = [];
  server = https.createServer({ cert: readFileSync(certificate),
    key: readFileSync(join(dirname(certificate), 'localhost-test-only.key')), maxHeaderSize: 8192 }, async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/api/v1/acks') {
        ackRequests++;
        if (gate) {
          const active = gate; gate = undefined;
          active.arrive();
          await bounded(active.released, 'parent ACK inspection');
        }
      }
      if (!await center.handler.handle(req, res)) { res.statusCode = 404; res.end(); }
    } catch { serverFailures.push('center handler failed'); res.destroy(); }
  });
  server.maxHeadersCount = 50;
  server.headersTimeout = 10000;
  server.requestTimeout = 20000;
  await bounded(new Promise((done, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', done);
  }), 'loopback TLS listen');
  const serverUrl = `https://localhost:${server.address().port}`;
  const storage = join(root, 'receiver-storage');
  const attachments = join(storage, 'attachments');
  mkdirSync(attachments, { recursive: true, mode: 0o700 });
  chmodSync(storage, 0o700);
  const journal = join(storage, 'journal.sqlite');
  const config = { serverUrl, ca: certificate, journal, attachments, ...agents[1] };
  let sequence = 0;
  const startPython = (operation, extra = {}, agent = 0) => {
    const directory = join(root, `python-${++sequence}`);
    environment(directory);
    return pythonProcess(python.executable, fixture('agent.py'), {
      operation, serverUrl, ca: certificate, module: join(repository, 'examples', 'python', 'client.py'),
      ...agents[agent], peerId: agents[1 - agent].agentId, ...extra,
    }, directory, children);
  };
  const startMcp = () => {
    const directory = join(root, `mcp-${++sequence}`);
    environment(directory);
    return mcpProcess(fixture('receiver.js'), config, directory, children);
  };
  const delivery = id => db.prepare('SELECT acked_at,read_at FROM im_deliveries WHERE message_id=?').get(id);
  const inspectJournal = fn => {
    const local = new DatabaseSync(journal, { readOnly: true });
    try { return fn(local); } finally { local.close(); }
  };
  const receivedRows = () => inspectJournal(local => local.prepare(
    'SELECT message_id,recorded_at,acked,receipt_json FROM im_client_received ORDER BY seq').all());
  const auditAcks = () => db.prepare("SELECT COUNT(*) AS n FROM im_audit WHERE action='ack_delivery' AND actor_id=?").get(agents[1].agentId).n;
  function ackBarrier() {
    assert.equal(gate, undefined);
    let arrive, release;
    const entered = new Promise(done => { arrive = done; });
    const released = new Promise(done => { release = done; });
    gate = { arrive, release, released };
    return { entered, release };
  }
  async function syncWithEvidence(receiver, messageId, expectedBytes) {
    const barrier = ackBarrier();
    const pending = receiver.call('im_v1_sync');
    // Attach a handler now: a failure before the HTTP barrier must not become an
    // unhandled rejection while the parent awaits phase evidence.
    const entered = Promise.race([barrier.entered, pending.then(() => { throw Error('sync completed before ACK barrier'); })]);
    let proofError;
    try {
      await bounded(entered, 'real HTTP ACK reached center');
      assert.equal(delivery(messageId).acked_at, null);
      const rows = receivedRows();
      const row = rows.find(x => x.message_id === messageId);
      assert.equal(row.acked, 0, 'FULL-synchronous receipt committed before HTTP ACK');
      if (expectedBytes) {
        const metadata = db.prepare('SELECT attachment_id FROM im_attachments WHERE message_id=?').get(messageId);
        const receipt = JSON.parse(row.receipt_json);
        assert.equal(receipt.path, attachmentPath(attachments, serverUrl, agents[1].agentId, messageId, metadata.attachment_id));
        assert.equal(dirname(receipt.path), resolve(attachments));
        assert.equal(lstatSync(receipt.path).isSymbolicLink(), false);
        assert.equal(receipt.sha256, digest);
        assert.equal(receipt.size, expectedBytes.length);
        assert.deepEqual(readFileSync(receipt.path), expectedBytes);
        if (process.platform !== 'win32') {
          assert.equal(lstatSync(attachments).mode & 0o077, 0);
          assert.equal(lstatSync(receipt.path).mode & 0o077, 0);
          assert.equal(lstatSync(journal).mode & 0o077, 0);
        }
      } else assert.equal(row.receipt_json, null);
    } catch (error) { proofError = error; }
    finally { barrier.release(); }
    const result = await pending;
    if (proofError) throw proofError;
    assert.deepEqual(result.items.map(x => x.message.messageId), [messageId]);
    assert.equal(result.items[0].status, 'delivered');
    assert.ok(delivery(messageId).acked_at !== null);
    assert.equal(delivery(messageId).read_at, null);
    assert.equal(receivedRows().find(x => x.message_id === messageId).acked, 1);
    return result;
  }

  let first, second, receiver, firstLease, firstRow, reply;
  await t.test('1: host-independent dependency slice and offline Python text + binary acceptance', async () => {
    // Bounded import check of core/fixture direct dependencies, not a certification
    // of every transitive installed package or a clean-clone dependency install.
    const files = [fixture('receiver.js'), fixture('harness.js'),
      ...readdirSync(join(repository, 'src', 'im')).filter(x => x.endsWith('.js')).map(x => join(repository, 'src', 'im', x))];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const imports = [...source.matchAll(/(?:from\s*|import\s*\(?)['"]([^'"]+)['"]/g)].map(x => x[1]);
      for (const specifier of imports) assert.doesNotMatch(specifier, /opencode|integrations|skill|question|tui|work.?order/i);
    }
    for (const file of [fixture('agent.py'), join(repository, 'examples', 'python', 'client.py')]) {
      const imports = [...readFileSync(file, 'utf8').matchAll(/^import ([\w.]+)$/gm)].map(x => x[1]);
      const stdlib = new Set(['base64', 'hashlib', 'importlib.util', 'json', 'os', 'ssl', 'sys',
        'urllib.error', 'urllib.parse', 'urllib.request', 'uuid']);
      assert.ok(imports.length > 0);
      assert.ok(imports.every(name => stdlib.has(name)), 'Python fixture/client import only enumerated stdlib modules');
    }
    const sender = await startPython('send', { clientMessageId: randomUUID(), text: sentinel, bytes: bytes.toString('base64') });
    first = await sender.next('sent'); await sender.finish();
    assert.equal(first.agentId, agents[0].agentId);
    assert.equal(first.title, null);
    assert.deepEqual({ ...delivery(first.messageId) }, { acked_at: null, read_at: null });
    assert.equal(ackRequests, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM im_send_keys').get().n, 1);
    assert.equal(db.prepare('SELECT sha256 FROM im_attachments').get().sha256, digest);
    t.diagnostic('phase 1: Python process exited; center accepted text+binary; receiver has never started; ACK count=0');
  });
  await t.test('2: actual SDK MCP initialize/tools/list/call; history and listing never ACK', async () => {
    receiver = await startMcp();
    assert.equal((await receiver.call('im_v1_me')).agentId, agents[1].agentId);
    await receiver.call('im_v1_contacts');
    await receiver.call('im_v1_conversations');
    await receiver.call('im_v1_history', { conversationId: first.conversationId });
    const message = await receiver.call('im_v1_message', { messageId: first.messageId });
    assert.equal(message.text, sentinel);
    assert.equal(message.deliveredAt, null);
    assert.equal(ackRequests, 0);
    assert.equal(delivery(first.messageId).acked_at, null);
    assert.equal(receivedRows().length, 0);
  });
  await t.test('3: real lease, verified safe attachment and journal precede explicit HTTP ACK', async () => {
    firstLease = await receiver.call('im_v1_acquire_lease', { instanceId: randomUUID(), requestId: randomUUID() });
    assert.equal(firstLease.generation, 1);
    await syncWithEvidence(receiver, first.messageId, bytes);
    firstRow = receivedRows()[0];
    assert.equal(auditAcks(), 1);
    await receiver.call('im_v1_release_lease');
    await receiver.graceful();
    t.diagnostic('phase 3: receipt/bytes inspected while real POST /acks blocked; then handler ACK committed; receiver released lease and exited');
  });
  await t.test('4: offline second send, fresh receiver reuses journal, exact new receipt and no duplicate ACK', async () => {
    assert.equal(receiver.closed, true);
    const sender = await startPython('send', { clientMessageId: randomUUID(), text: 'queued during receiver downtime' });
    second = await sender.next('sent'); await sender.finish();
    assert.equal(second.conversationId, first.conversationId);
    assert.equal(delivery(second.messageId).acked_at, null);
    const previousPid = receiver.child.pid;
    receiver = await startMcp();
    assert.notEqual(receiver.child.pid, previousPid);
    assert.equal((await receiver.call('im_v1_me')).agentId, agents[1].agentId);
    assert.deepEqual(receivedRows(), [firstRow]);
    const lease = await receiver.call('im_v1_acquire_lease', { instanceId: randomUUID(), requestId: randomUUID() });
    assert.ok(lease.generation > firstLease.generation);
    assert.notEqual(lease.instanceId, firstLease.instanceId);
    assert.equal(lease.cursor, 1);
    assert.deepEqual((await receiver.call('im_v1_ack_pending')).acked, []);
    assert.equal(auditAcks(), 1);
    await syncWithEvidence(receiver, second.messageId);
    assert.deepEqual(receivedRows()[0], firstRow);
    assert.equal(receivedRows().length, 2);
    assert.equal(readdirSync(attachments).length, 1);
    assert.equal(auditAcks(), 2);
    const before = ackRequests;
    assert.deepEqual((await receiver.call('im_v1_sync')).items, []);
    assert.equal(ackRequests, before);
    t.diagnostic('phase 4: new process/new instance, same agent/journal, cursor 1→2; prior receipt unchanged; 2 successful receiver ACK audits');
  });
  await t.test('5: old released fence cannot ACK after fresh generation acquisition', async () => {
    const before = auditAcks();
    const stale = await startPython('stale-ack', { instanceId: firstLease.instanceId,
      generation: firstLease.generation, messageId: second.messageId }, 1);
    assert.equal((await stale.next('stale-rejected')).code, 'STALE_FENCE'); await stale.finish();
    assert.equal(auditAcks(), before);
    assert.equal(db.prepare('SELECT acked_through FROM im_receive_state WHERE agent_id=?').get(agents[1].agentId).acked_through, 2);
  });
  await t.test('6: MCP correlated reply; independently authenticated Python sync, ACK, explicit read', async () => {
    reply = await receiver.call('im_v1_send', { protocol: 'a2a-msg.im.v1',
      conversationId: first.conversationId, recipientAgentId: agents[0].agentId,
      clientMessageId: randomUUID(), text: 'explicit test reply', inReplyTo: first.messageId });
    assert.ok(reply.messageId);
    assert.equal(delivery(reply.messageId).acked_at, null);
    const reader = await startPython('reply', { messageId: reply.messageId,
      conversationId: first.conversationId, inReplyTo: first.messageId, text: 'explicit test reply' });
    const phase = await reader.next('reply-before-ack');
    assert.equal(phase.agentId, agents[0].agentId);
    assert.equal(phase.messageId, reply.messageId);
    assert.deepEqual({ ...delivery(reply.messageId) }, { acked_at: null, read_at: null });
    await reader.send({ go: true });
    assert.equal((await reader.next('reply-read')).ackedThrough, 1); await reader.finish();
    assert.ok(delivery(reply.messageId).acked_at !== null);
    assert.ok(delivery(reply.messageId).read_at !== null);
    await receiver.call('im_v1_release_lease'); await receiver.graceful();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM im_messages').get().n, 3);
    assert.equal(serverFailures.length, 0);
    assert.ok(children.every(x => x.closed && x.exited));
    t.diagnostic(`phase 6: ${children.length} fresh child processes exited/closed; JS restart durability only; Python reply receiver has no crash journal`);
  });
  t.diagnostic('Scope: existing installed Node/SDK + isolated stdlib Python, fresh cwd/HOME/config, loopback verified TLS only. No clean-clone/npm-ci, third-party-framework deployment, different-machine LAN/internet, crash recovery, or full A1/A2/A7 release approval claimed.');
});
