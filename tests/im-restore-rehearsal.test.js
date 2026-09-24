import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { assertImSchema, migrateImSchemaV3, initInstanceIdentity, getInstanceIdentity } from '../src/im/schema.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImMigration } from '../src/im/migration.js';
import { createAdminAuthority, createLocalKeystore } from '../src/im/keystore.js';
import { createImBackup } from '../src/im/backup.js';
import { createImCenter } from '../src/im/server.js';
import { createImClient } from '../src/im/client.js';
import { createImJournal } from '../src/im/journal.js';
import { PROTOCOL } from '../src/im/contracts.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = path => sha(readFileSync(path));
const policy = {
  enabled: true, writeMode: 'enabled', transport: { mode: 'direct-tls', serverUrl: 'https://localhost:8787' },
  retention: { policy: { messageRetentionMs: 1000000, attachmentRetentionMs: 900000,
    idempotencyRetentionMs: 1100000, safeRetryWindowMs: 100000 } },
  lease: { ttlMs: 5000, renewalMs: 1000 },
};

function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  return db;
}

// Test-local, trusted-directory copy only. Never consumes source.sqlite or its WAL.
// Verification is content evidence, not production restore authorization/provenance.
function copyVerifiedCandidate(runner, backup, destination) {
  assert.equal(runner.verify(backup).ok, true);
  assert.notEqual(destination, backup.backupPath);
  copyFileSync(backup.backupPath, destination, constants.COPYFILE_EXCL);
}

function rows(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'im_%' ORDER BY name")
    .all().map(({ name }) => {
      assert.match(name, /^im_[a-z_]+$/);
      return [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()];
    }));
}

function assertHealthy(db) {
  assert.equal(assertImSchema(db), true);
  assert.equal(db.prepare('SELECT version FROM im_schema').get().version, 3);
  assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

function localAuthority(directory) {
  const options = { trustWindowsPermissions: process.platform === 'win32', report: () => {} };
  const keystore = createLocalKeystore({ directory, ...options });
  const secretFile = join(directory, 'test-only-admin.secret');
  const context = { adminSecret: keystore.createAdminSecret(secretFile) };
  return { keystore, context, authority: createAdminAuthority({ secretFile, ...options }) };
}

// Both halves use the real center, HTTP handler and client over CA-verified TLS.
// There are no children, SSE streams, polling loops or automatic lease renewers.
async function listenCenter(db, clock, directory, accounts) {
  const center = createImCenter({ db, clock, policy });
  const cert = readFileSync(new URL('./fixtures/im-tls/localhost-test-only.crt', import.meta.url));
  const key = readFileSync(new URL('./fixtures/im-tls/localhost-test-only.key', import.meta.url));
  const agent = new https.Agent({ ca: cert, rejectUnauthorized: true, keepAlive: false });
  const server = https.createServer({ cert, key, maxHeaderSize: 8192, headersTimeout: 5000,
    requestTimeout: 5000 }, (req, res) => {
    center.handler.handle(req, res).catch(() => res.destroy());
  });
  server.maxHeadersCount = 64;
  const clients = [], requests = new Set();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const entry of clients) { entry.client.close(); entry.db.close(); }
    for (const req of requests) req.destroy();
    center.close(); agent.destroy();
    if (server.listening) {
      const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await stopped;
    }
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const url = `https://localhost:${server.address().port}`;
    const transport = input => new Promise((resolve, reject) => {
      let settled = false, size = 0, chunks = [];
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(deadline); requests.delete(req);
        if (error) { req.destroy(); reject(error); } else resolve(result);
      };
      const req = https.request(new URL(input.path, url), { method: input.method, agent, family: 4,
        headers: { Authorization: `Bearer ${input.credential}`, ...input.headers,
          ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }) } }, res => {
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) finish(new Error('test response exceeded bound'));
          else chunks.push(chunk);
        });
        res.on('end', () => finish(res.complete ? null : new Error('incomplete response'),
          { status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on('error', finish);
        res.on('aborted', () => finish(new Error('aborted response')));
      });
      const deadline = setTimeout(() => finish(new Error('test request deadline')), 5000);
      requests.add(req);
      req.on('error', finish);
      req.on('close', () => { if (!settled) finish(new Error('request closed')); });
      req.end(input.body);
    });
    for (const account of accounts) {
      const attachmentDirectory = join(directory, account.agentId); mkdirSync(attachmentDirectory);
      const journalPath = join(directory, `${account.agentId}.sqlite`);
      const journalDb = openDatabase(journalPath);
      const entry = { db: journalDb, journalPath, client: { close() {} }, ackChecks: 0 };
      clients.push(entry);
      entry.client = createImClient({ serverUrl: url, agentId: account.agentId,
        getCredential: account.getCredential, attachmentDirectory,
        journal: scope => createImJournal({ db: journalDb, ...scope }),
        transport: async input => {
          if (input.path === '/api/v1/acks') {
            // Observe committed receipt from a DIFFERENT connection before any wire ACK.
            const observer = new DatabaseSync(journalPath, { readOnly: true });
            try {
              for (const messageId of JSON.parse(input.body).messageIds) {
                const receipt = observer.prepare('SELECT * FROM im_client_received WHERE message_id=?').get(messageId);
                assert.ok(receipt, 'ACK requires a committed journal receipt');
                if (receipt.receipt_json) {
                  const saved = JSON.parse(receipt.receipt_json), bytes = readFileSync(saved.path);
                  assert.equal(sha(bytes), saved.sha256); assert.equal(bytes.length, saved.size);
                }
                entry.ackChecks++;
              }
            } finally { observer.close(); }
          }
          return transport(input);
        } });
    }
    return { center, clients, transport, close, get closed() { return closed; } };
  } catch (error) { await close(); throw error; }
}

function assertReceived(entry, page, sent, bytes) {
  const item = page.items.find(item => item.message.messageId === sent.messageId);
  assert.ok(item); assert.equal(item.status, 'delivered');
  assert.equal(entry.db.prepare('SELECT acked FROM im_client_received WHERE message_id=?').get(sent.messageId).acked, 1);
  if (bytes) {
    assert.deepEqual(readFileSync(item.attachmentReceipt.path), bytes);
    assert.equal(item.message.attachment.sha256, sha(bytes));
  }
  return item;
}

test('platform-neutral native v3 backup primitive: verified exclusive candidate copy refuses overwrite', { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'im-restore-copy-'));
  let db, runner;
  t.after(async () => { await runner?.drain(); db?.close(); rmSync(root, { recursive: true, force: true }); });
  db = openDatabase(join(root, 'source.sqlite')); migrateImSchemaV3(db);
  const identity = initInstanceIdentity(db, { clock: () => 1000 });
  const { authority, context } = localAuthority(root);
  runner = createImBackup({ db, authority, durability: process.platform === 'win32' ? 'best-effort' : 'strict' });
  const backup = await runner.backup({ destinationPath: join(root, 'backup.sqlite'),
    approvalId: 'local-copy-test', sourceId: identity.instanceId, adminContext: context });
  assert.equal(backup.durability, process.platform === 'win32' ? 'degraded' : 'durable');
  await runner.drain(); db.close(); db = null;
  const candidateDirectory = join(root, 'exclusive'); mkdirSync(candidateDirectory);
  const candidate = join(candidateDirectory, 'candidate.sqlite');
  assert.equal(existsSync(candidate), false);
  copyVerifiedCandidate(runner, backup, candidate);
  const before = fileHash(candidate);
  assert.throws(() => copyVerifiedCandidate(runner, backup, candidate), { code: 'EEXIST' });
  assert.equal(fileHash(candidate), before); assert.equal(fileHash(backup.backupPath), backup.manifest.fileHash);
  db = new DatabaseSync(candidate, { readOnly: true }); db.exec('PRAGMA foreign_keys=ON');
  assertHealthy(db); assert.deepEqual(getInstanceIdentity(db), identity);
  t.diagnostic(`native backup durability=${backup.durability}; this primitive check alone is not a restore/resume drill`);
});

test('bounded local v3 writable candidate: snapshot RPO, retained-fence expiry and fresh-journal TLS resume; source stays closed', {
  timeout: 45000,
  skip: process.platform === 'win32' ? 'Strict native backup directory fsync is unsupported on Windows; run this drill on native Unix (no platform override).' : false,
}, async t => {
  const sourceDirectory = mkdtempSync(join(tmpdir(), 'im-restore-source-'));
  const candidateDirectory = mkdtempSync(join(tmpdir(), 'im-restore-candidate-'));
  let sourceDb, candidateDb, source, candidate, runner;
  t.after(async () => {
    await source?.close(); await candidate?.close(); await runner?.drain();
    sourceDb?.close(); candidateDb?.close();
    rmSync(sourceDirectory, { recursive: true, force: true });
    rmSync(candidateDirectory, { recursive: true, force: true });
  });
  let now = 10000;
  const clock = () => now;
  const sourcePath = join(sourceDirectory, 'source.sqlite');
  sourceDb = openDatabase(sourcePath); migrateImSchemaV3(sourceDb);
  const identity = initInstanceIdentity(sourceDb, { clock });
  const { authority, context, keystore } = localAuthority(sourceDirectory);
  const admin = createImAdmin({ db: sourceDb, clock, authorizeAdmin: authority.authorizeAdmin,
    protectCredential: record => keystore.storeCredential(record) });
  const accounts = ['Restore sender', 'Restore receiver'].map(displayName => {
    const { agentId } = admin.registerAgent({ displayName }, context);
    const { credentialId } = admin.issueCredential({ agentId, expiresAt: null }, context);
    return { agentId, getCredential: () => keystore.loadCredential(credentialId) };
  });
  const [a, b] = accounts;
  admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: true, reason: 'isolated rehearsal' }, context);
  createImMigration({ db: sourceDb, clock,
    authorizeAdmin: ctx => authority.authorizeAdmin(ctx) ? 'local-rehearsal-operator' : null })
    .setImWriteMode({ mode: 'enabled', reason: 'isolated rehearsal', policy }, context);
  source = await listenCenter(sourceDb, clock, sourceDirectory, accounts);
  const [sender, receiver] = source.clients;
  const { conversationId } = await sender.client.ensureConversation({ peerAgentId: b.agentId });
  const bytes = Buffer.from('trusted local pre-backup attachment\0bytes');
  const request = { protocol: PROTOCOL, conversationId, recipientAgentId: b.agentId,
    clientMessageId: randomUUID(), text: 'accepted before snapshot',
    attachment: { name: 'snapshot.bin', sha256: sha(bytes), dataBase64: bytes.toString('base64') } };
  const before = await sender.client.send(request);
  await assert.rejects(sender.client.read(before.messageId), { code: 'RESOURCE_NOT_FOUND' });
  const unread = sourceDb.prepare('SELECT acked_at,read_at FROM im_deliveries WHERE message_id=?').get(before.messageId);
  assert.equal(unread.acked_at, null); assert.equal(unread.read_at, null, 'sender cannot mark recipient read');
  const oldLease = await receiver.client.acquire({ instanceId: randomUUID(), requestId: randomUUID() });
  assertReceived(receiver, await receiver.client.receiveOnce(), before, bytes);
  await receiver.client.read(before.messageId);
  assert.equal(receiver.ackChecks, 1);
  const baseline = rows(sourceDb);
  assert.equal(baseline.im_send_keys[0].message_id, before.messageId);
  assert.equal(baseline.im_deliveries[0].acked_at, now);
  assert.equal(baseline.im_deliveries[0].read_at, now);
  assert.equal(baseline.im_receiver_leases[0].generation, oldLease.generation);

  runner = createImBackup({ db: sourceDb, authority, clock, durability: 'strict', backupTimeBudgetMs: 10000 });
  const input = { destinationPath: join(sourceDirectory, 'immutable-backup.sqlite'),
    approvalId: 'local-bounded-rehearsal', sourceId: identity.instanceId };
  await assert.rejects(runner.backup(input), { code: 'BACKUP_AUTH_DENIED' });
  assert.equal(existsSync(input.destinationPath), false);
  const backup = await runner.backup({ ...input, adminContext: context });
  await runner.drain();
  assert.equal(runner.status().nativeInFlight, false);
  assert.equal(backup.durability, 'durable'); assert.equal(runner.verify(backup).ok, true);
  assert.equal(backup.manifest.schemaVersion, 3);
  const backupHash = fileHash(backup.backupPath), manifestHash = fileHash(backup.manifestPath);
  assert.equal(backupHash, backup.manifest.fileHash);

  // Deliberately advance source ACK/read AND generation beyond the snapshot.
  now = oldLease.expiresAt + 1;
  const advancedLease = await receiver.client.acquire({ instanceId: randomUUID(), requestId: randomUUID() });
  assert.equal(advancedLease.generation, oldLease.generation + 1);
  const later = await sender.client.send({ protocol: PROTOCOL, conversationId, recipientAgentId: b.agentId,
    clientMessageId: randomUUID(), text: 'accepted only on original after snapshot' });
  assertReceived(receiver, await receiver.client.receiveOnce(), later);
  await receiver.client.read(later.messageId);
  const sourceExpected = rows(sourceDb);
  assert.equal(sourceExpected.im_messages.length, 2);
  assert.equal(sourceExpected.im_send_keys.length, 2);
  assert.equal(sourceExpected.im_receive_state.find(row => row.agent_id === b.agentId).acked_through, 2);
  assert.equal(sourceExpected.im_deliveries.find(row => row.message_id === later.messageId).read_at, now);
  const sourceJournalPaths = source.clients.map(entry => entry.journalPath);
  await source.close(); sourceDb.close(); sourceDb = null;
  assert.equal(source.closed, true);
  const sourceJournalHashes = sourceJournalPaths.map(fileHash);
  const closedSourceHash = fileHash(sourcePath);

  const candidatePath = join(candidateDirectory, 'candidate.sqlite');
  assert.notEqual(dirname(candidatePath), dirname(sourcePath));
  assert.equal(existsSync(candidatePath), false);
  copyVerifiedCandidate(runner, backup, candidatePath);
  assert.equal(fileHash(candidatePath), backupHash);
  assert.throws(() => copyVerifiedCandidate(runner, backup, candidatePath), { code: 'EEXIST' });
  assert.equal(fileHash(candidatePath), backupHash);
  // Only now may the preserved identity be opened writable in this isolated drill.
  candidateDb = openDatabase(candidatePath);
  assertHealthy(candidateDb); assert.deepEqual(getInstanceIdentity(candidateDb), identity);
  assert.deepEqual(rows(candidateDb), baseline, 'all snapshot rows, BLOB bytes, keys, ACK/read, identity and fences survive');
  assert.equal(candidateDb.prepare('SELECT 1 FROM im_messages WHERE message_id=?').get(later.messageId), undefined);
  assert.equal(candidateDb.prepare('SELECT 1 FROM im_send_keys WHERE client_message_id=?').get(later.clientMessageId), undefined);
  const restoredBlob = candidateDb.prepare('SELECT data,sha256 FROM im_attachments WHERE message_id=?').get(before.messageId);
  assert.deepEqual(Buffer.from(restoredBlob.data), bytes); assert.equal(sha(restoredBlob.data), restoredBlob.sha256);

  now = advancedLease.expiresAt + 1;
  assert.ok(now > candidateDb.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at);
  candidate = await listenCenter(candidateDb, clock, candidateDirectory, accounts);
  const [freshSender, freshReceiver] = candidate.clients;
  assert.equal(freshReceiver.db.prepare('SELECT count(*) n FROM im_client_received').get().n, 0);
  const oldAck = () => candidate.transport({ method: 'POST', path: '/api/v1/acks', credential: b.getCredential(),
    body: JSON.stringify({ instanceId: oldLease.instanceId, generation: oldLease.generation, messageIds: [before.messageId] }) });
  const expired = await oldAck();
  assert.equal(expired.status, 409); assert.equal(JSON.parse(expired.body).error.code, 'LEASE_EXPIRED');
  const freshLease = await freshReceiver.client.acquire({ instanceId: randomUUID(), requestId: randomUUID() });
  assert.equal(freshLease.generation, oldLease.generation + 1);
  assert.notEqual(freshLease.instanceId, oldLease.instanceId);
  // Snapshot recovery cannot promise a globally newer fence than post-backup source state.
  assert.equal(freshLease.generation, advancedLease.generation);
  assert.notEqual(freshLease.instanceId, advancedLease.instanceId);
  const stale = await oldAck();
  assert.equal(stale.status, 409); assert.equal(JSON.parse(stale.body).error.code, 'STALE_FENCE');
  assert.deepEqual(candidateDb.prepare('SELECT * FROM im_deliveries').all(), baseline.im_deliveries);
  assert.equal((await freshSender.client.send(request)).messageId, before.messageId, 'preserved send key deduplicates exact payload');
  const newBytes = Buffer.from('trusted candidate-only attachment');
  const resumed = await freshSender.client.send({ ...request, clientMessageId: randomUUID(), text: 'candidate-only new message',
    attachment: { name: 'resumed.bin', sha256: sha(newBytes), dataBase64: newBytes.toString('base64') } });
  const resumedPage = await freshReceiver.client.receiveOnce();
  assert.equal(resumedPage.items.length, 2, 'fresh journal revalidates retained history from zero, not advanced source cursor');
  assertReceived(freshReceiver, resumedPage, before, bytes);
  assertReceived(freshReceiver, resumedPage, resumed, newBytes);
  await freshReceiver.client.read(resumed.messageId);
  const reply = await freshReceiver.client.send({ protocol: PROTOCOL, conversationId, recipientAgentId: a.agentId,
    clientMessageId: randomUUID(), text: 'candidate reply', inReplyTo: resumed.messageId });
  await freshSender.client.acquire({ instanceId: randomUUID(), requestId: randomUUID() });
  const receivedReply = assertReceived(freshSender, await freshSender.client.receiveOnce(), reply);
  assert.equal(receivedReply.message.inReplyTo, resumed.messageId);
  await freshSender.client.read(reply.messageId);
  assert.equal((await freshReceiver.client.receiveOnce()).items.length, 0);
  assert.equal(freshReceiver.ackChecks, 2); assert.equal(freshSender.ackChecks, 1);
  assert.equal(candidateDb.prepare('SELECT count(*) n FROM im_messages').get().n, 3);
  assert.equal(candidateDb.prepare('SELECT count(*) n FROM im_send_keys').get().n, 3);
  for (const message of [resumed, reply]) {
    const delivery = candidateDb.prepare('SELECT acked_at,read_at FROM im_deliveries WHERE message_id=?').get(message.messageId);
    assert.equal(delivery.acked_at, now); assert.equal(delivery.read_at, now);
  }
  assertHealthy(candidateDb);
  const candidateJournalPaths = candidate.clients.map(entry => entry.journalPath);
  await candidate.close(); candidateDb.close(); candidateDb = null;
  for (const [index, path] of candidateJournalPaths.entries()) {
    const journal = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(journal.prepare('SELECT count(*) n FROM im_client_received WHERE acked=1').get().n, index === 0 ? 1 : 2);
      assert.equal(journal.prepare('SELECT count(*) n FROM im_client_received WHERE acked=0').get().n, 0);
    } finally { journal.close(); }
  }
  assert.equal(candidate.closed, true);
  assert.equal(fileHash(sourcePath), closedSourceHash);
  sourceDb = new DatabaseSync(sourcePath, { readOnly: true }); sourceDb.exec('PRAGMA foreign_keys=ON');
  assertHealthy(sourceDb);
  assert.deepEqual(rows(sourceDb), sourceExpected, 'candidate writes must not overwrite any original post-backup row');
  assert.equal(sourceDb.prepare('SELECT 1 FROM im_messages WHERE message_id=?').get(resumed.messageId), undefined);
  assert.equal(sourceDb.prepare('SELECT 1 FROM im_messages WHERE message_id=?').get(reply.messageId), undefined);
  assert.deepEqual(sourceJournalPaths.map(fileHash), sourceJournalHashes);
  assert.equal(fileHash(backup.backupPath), backupHash); assert.equal(fileHash(backup.manifestPath), manifestHash);
  assert.equal(runner.verify(backup).ok, true);
  t.diagnostic('Local RPO evidence: snapshot=1 message; original=2; isolated candidate=3. Original writers closed before candidate opened.');
  t.diagnostic('Fresh journals + loopback TLS resume only; no production restore, automatic failover, cross-network or full A3/A5 acceptance claim.');
});
