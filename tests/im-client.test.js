import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, linkSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { saveAttachment, verifyAttachment, attachmentPath } from '../src/im/client-files.js';
import { createImClient } from '../src/im/client.js';
import { createImJournal } from '../src/im/journal.js';
import { migrateImSchema } from '../src/im/schema.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImAuth } from '../src/im/auth.js';
import { createImAcl } from '../src/im/acl.js';
import { createImMessages } from '../src/im/messages.js';
import { createImDelivery } from '../src/im/delivery.js';
import { createImHandler } from '../src/im/http.js';
import { PROTOCOL } from '../src/im/contracts.js';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555', F = '66666666-6666-4666-8666-666666666666';
const I = '77777777-7777-4777-8777-777777777777', R = '88888888-8888-4888-8888-888888888888';
const request = { protocol: PROTOCOL, conversationId: C, recipientAgentId: B, clientMessageId: D, text: 'hello' };
const sent = { messageId: E, conversationId: C, senderAgentId: A, recipientAgentId: B,
  clientMessageId: D, title: null, text: 'hello', inReplyTo: null, correlation: null, acceptedAt: 100, attachment: null };
const inbound = { ...sent, senderAgentId: B, recipientAgentId: A };
const err = code => e => e.code === code;
const ok = data => ({ status: 200, body: Buffer.from(JSON.stringify(data)) });
function fixture(handler) {
  const root = mkdtempSync(join(tmpdir(), 'im-client-'));
  const directory = join(root, 'attachments'); mkdirSync(directory);
  const file = join(root, 'journal.sqlite'); let db, client, calls = [];
  function open() {
    db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    client = createImClient({ serverUrl: 'https://example.test', agentId: A, getCredential: async () => 'test-token',
      attachmentDirectory: directory, journal: scope => createImJournal({ db, ...scope }),
      transport: async req => { calls.push(req); return handler(req); } });
    return client;
  }
  open();
  return { get client() { return client; }, get db() { return db; }, get calls() { return calls; }, directory,
    reopen() { client.close(); db.close(); calls = []; return open(); },
    close() { client.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('credential is snapped once across /me and side effects; revoked credential keeps staged key', async () => {
  for (const operation of ['send','ensureConversation','read','receiveOnce']) {
    let token = 'agent-a', calls = 0;
    const root = mkdtempSync(join(tmpdir(), 'im-identity-')), directory = join(root, 'files'); mkdirSync(directory);
    const db = new DatabaseSync(':memory:'); db.exec('PRAGMA synchronous=FULL');
    const client = createImClient({ serverUrl: 'https://example.test', agentId: A,
      getCredential: () => token, journal: scope => createImJournal({ db, ...scope, testOnlyMemory: true }),
      attachmentDirectory: directory, transport: async req => {
        if (req.path === '/api/v1/me') { token = 'agent-b'; return ok({ agentId: A }); }
        assert.equal(req.credential, 'agent-a'); calls++;
        if (req.path === '/api/v1/messages') return ok(sent);
        if (req.path === `/api/v1/messages/${E}`) return ok(sent);
        if (req.path === '/api/v1/conversations') return ok({ conversationId: C });
        if (req.path.endsWith('/read')) return ok({ readAt: 100 });
        throw Error('stop');
      } });
    try {
      if (operation === 'send') await client.send(request);
      else if (operation === 'ensureConversation') await client.ensureConversation({ peerAgentId: B });
      else if (operation === 'read') await client.read(E);
      else await assert.rejects(client.receiveOnce(), err('STALE_FENCE'));
      assert.equal(calls, operation === 'send' ? 2 : operation === 'receiveOnce' ? 0 : 1);
    } finally { client.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
  }
  let revoked = false, post = 0;
  const f = fixture(req => {
    if (req.path === '/api/v1/me') return revoked ? { status: 401, body: Buffer.from('{"error":{"code":"INVALID_CREDENTIAL"}}') } : ok({ agentId: A });
    if (req.path === '/api/v1/messages') { post++; revoked = true; throw Error('credential revoked during send'); }
    throw Error('unexpected');
  });
  try {
    await assert.rejects(f.client.send(request), err('STORAGE_UNAVAILABLE'));
    assert.equal(f.db.prepare('SELECT client_id FROM im_client_outgoing').get().client_id, D);
    await assert.rejects(f.client.recoverSend(D), err('INVALID_CREDENTIAL'));
    assert.equal(post, 1);
  } finally { f.close(); }
});

test('published temp hardlink recovers; unrelated links and symlinks fail closed', async t => {
  const root = mkdtempSync(join(tmpdir(), 'im-files-')), directory = join(root, 'files'); mkdirSync(directory);
  const bytes = Buffer.from('verified bytes'), attachment = { attachmentId: F, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  const path = attachmentPath(directory, 'https://example.test', A, E, F);
  try {
    const temp = `${path}.12345678-1234-4234-8234-123456789abc.tmp`;
    writeFileSync(temp, bytes); linkSync(temp, path);
    await saveAttachment({ directory, center: 'https://example.test', agent: A, messageId: E, attachment, download: () => { throw Error('download should not run'); } });
    assert.equal(existsSync(temp), false);
    const other = join(root, 'other'); linkSync(path, other);
    await assert.rejects(verifyAttachment(path, attachment, directory), err('INVALID_ATTACHMENT'));
    rmSync(other); rmSync(path);
    let fileLinkChecked = false, parentLinkChecked = false;
    try {
      symlinkSync(other, path);
      await assert.rejects(verifyAttachment(path, attachment, directory), err('INVALID_ATTACHMENT'));
      fileLinkChecked = true;
      rmSync(path);
    } catch (e) { if (e.code !== 'EPERM') throw e; t.diagnostic(`final symlink check unavailable (${e.code}); no privilege escalation attempted`); }
    const linkedDirectory = join(root, 'linked');
    try {
      symlinkSync(directory, linkedDirectory, 'junction');
      await assert.rejects(verifyAttachment(join(linkedDirectory, 'x'), attachment, linkedDirectory), err('INVALID_ATTACHMENT'));
      parentLinkChecked = true;
    } catch (e) { if (e.code !== 'EPERM') throw e; t.diagnostic(`parent junction check unavailable (${e.code}); no privilege escalation attempted`); }
    t.diagnostic(`symlink checks: final=${fileLinkChecked ? 'passed' : 'skipped (EPERM)'}, parent=${parentLinkChecked ? 'passed' : 'skipped (EPERM)'}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('default HTTPS transport deadline, abort, oversized late end, and close settle safely', async t => {
  const root = mkdtempSync(join(tmpdir(), 'im-transport-')), directory = join(root, 'files'); mkdirSync(directory);
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA synchronous=FULL');
  const requests = [];
  t.mock.method(https, 'request', (url, options, onResponse) => {
    const req = new EventEmitter();
    req.destroyed = false; req.destroyCount = 0;
    req.destroy = () => { req.destroyCount++; req.destroyed = true; req.emit('close'); };
    req.end = () => {
      if (url.pathname !== '/api/v1/me') return;
      const res = new EventEmitter(); res.statusCode = 200; res.complete = true;
      onResponse(res); res.emit('data', Buffer.from(JSON.stringify({ agentId: A }))); res.emit('end');
    };
    requests.push({ req, url, onResponse, options });
    return req;
  });
  const client = createImClient({ serverUrl: 'https://example.test', agentId: A,
    getCredential: () => 'test-token', journal: scope => createImJournal({ db, ...scope, testOnlyMemory: true }),
    attachmentDirectory: directory });
  const start = async () => {
    const promise = client.contacts();
    await new Promise(resolve => setImmediate(resolve));
    const request = requests.at(-1);
    assert.equal(request.url.pathname, '/api/v1/contacts');
    return { promise, ...request };
  };
  try {
    const aborted = await start();
    const abortResponse = new EventEmitter(); abortResponse.statusCode = 200; abortResponse.complete = false;
    aborted.onResponse(abortResponse);
    abortResponse.emit('data', Buffer.from('{'));
    abortResponse.emit('aborted'); abortResponse.emit('end'); abortResponse.emit('close');
    await assert.rejects(aborted.promise, err('STORAGE_UNAVAILABLE'));
    assert.equal(aborted.req.destroyCount, 1);

    const oversize = await start();
    const largeResponse = new EventEmitter(); largeResponse.statusCode = 200; largeResponse.complete = false;
    oversize.onResponse(largeResponse);
    largeResponse.emit('data', Buffer.alloc(16 * 1024 * 1024 + 1));
    await assert.rejects(oversize.promise, err('PAYLOAD_TOO_LARGE'));
    assert.equal(oversize.req.destroyCount, 1);
    largeResponse.complete = true;
    // A late end must not concatenate chunks, settle again, or resurrect success.
    const concatMock = t.mock.method(Buffer, 'concat', () => { throw Error('late Buffer.concat'); });
    largeResponse.emit('end'); largeResponse.emit('close');
    assert.equal(oversize.req.destroyCount, 1);
    concatMock.mock.restore();

    const closing = await start();
    client.close();
    await assert.rejects(closing.promise, err('STORAGE_UNAVAILABLE'));
    assert.equal(closing.req.destroyCount, 1);
    assert.equal(aborted.req.destroyCount, 1);
  } finally { client.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('default HTTPS total deadline cancels an incomplete response exactly once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = mkdtempSync(join(tmpdir(), 'im-deadline-')), directory = join(root, 'files'); mkdirSync(directory);
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA synchronous=FULL');
  let request, response;
  t.mock.method(https, 'request', (url, options, onResponse) => {
    const req = new EventEmitter(); req.destroyed = false; req.destroyCount = 0;
    req.destroy = () => { req.destroyed = true; req.destroyCount++; req.emit('close'); };
    req.end = () => {
      if (url.pathname === '/api/v1/me') {
        const res = new EventEmitter(); res.statusCode = 200; res.complete = true;
        onResponse(res); res.emit('data', Buffer.from(JSON.stringify({ agentId: A }))); res.emit('end');
      } else {
        request = req; response = new EventEmitter(); response.statusCode = 200; response.complete = false;
        onResponse(response); response.emit('data', Buffer.from('{'));
      }
    };
    return req;
  });
  const client = createImClient({ serverUrl: 'https://example.test', agentId: A,
    getCredential: () => 'test-token', journal: scope => createImJournal({ db, ...scope, testOnlyMemory: true }),
    attachmentDirectory: directory });
  try {
    const pending = client.contacts();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(request);
    t.mock.timers.tick(30_000);
    await assert.rejects(pending, err('STORAGE_UNAVAILABLE'));
    assert.equal(request.destroyCount, 1);
    response.complete = true; response.emit('end'); response.emit('aborted');
    assert.equal(request.destroyCount, 1);
  } finally { client.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('fake ACK watermarks leave receipt pending; legitimate out-of-order watermark respects gaps', async () => {
  for (const watermark of [0, 999]) {
    const f = fixture(req => {
      if (req.path === '/api/v1/me') return ok({ agentId: A });
      if (req.path === '/api/v1/receiver/lease') return ok({ instanceId: I, generation: 1, expiresAt: Date.now() + 600000, historical: false });
      if (req.path === '/api/v1/receiver/lease/renew') return ok({ instanceId: I, generation: 1, expiresAt: Date.now() + 600000 });
      if (req.path.startsWith('/api/v1/sync')) return ok({ streamEpoch: R, ackedThrough: 0, pageAfter: 1, hasMore: false, items: [{ seq: 1, message: inbound }] });
      if (req.path === `/api/v1/messages/${E}`) return ok(inbound);
      if (req.path === '/api/v1/acks') return ok({ ackedThrough: watermark });
      throw Error('unexpected');
    });
    try {
      await f.client.acquire({ instanceId: I, requestId: D });
      await assert.rejects(f.client.receiveOnce(), e => ['INVALID_REQUEST','CURSOR_RESET_REQUIRED'].includes(e.code));
      assert.equal(f.db.prepare('SELECT acked FROM im_client_received').get().acked, 0);
    } finally { f.close(); }
  }
});

test('strict HTTPS origin rejects userinfo, paths and insecure schemes', () => {
  for (const url of ['http://example.test','https://user:pass@example.test','https://example.test/path',
    'https://example.test/?secret=x','https://example.test/#x']) {
    assert.throws(() => createImClient({ serverUrl: url, agentId: A }), err('INVALID_REQUEST'));
  }
});

test('stage failure precedes network; lost response reuses exact key, no blind resend', async () => {
  let posts = 0;
  const f = fixture(req => {
    if (req.path === '/api/v1/me') return ok({ agentId: A });
    if (req.path === `/api/v1/sends/${D}`) return ok(sent);
    if (req.path === `/api/v1/messages/${E}`) return ok(sent);
    if (req.path === '/api/v1/messages') { posts++; throw new Error('lost'); }
    throw Error('unexpected request');
  });
  try {
    await assert.rejects(f.client.send({ ...request, text: '' }), err('INVALID_REQUEST'));
    assert.equal(posts, 0);
    await assert.rejects(f.client.send(request), err('STORAGE_UNAVAILABLE'));
    assert.equal(posts, 1);
    f.reopen();
    const record = await f.client.send(request);
    assert.equal(record.messageId, E);
    assert.equal(posts, 1);
    assert.equal(f.calls.some(x => x.credential !== 'test-token' || x.body?.includes('test-token')), false);
  } finally { f.close(); }
});

test('cross-identity send proof rejected, redirects never followed', async () => {
  let redirect = false;
  const f = fixture(req => req.path === '/api/v1/me' ? ok({ agentId: A }) :
    req.path === '/api/v1/messages' || req.path === `/api/v1/sends/${D}` ?
      redirect ? { status: 302, body: Buffer.from('{}') } : ok({ ...sent, senderAgentId: B }) : ok(sent));
  try {
    await assert.rejects(f.client.send(request), err('STORAGE_UNAVAILABLE'));
    assert.equal(f.calls.filter(x => x.path.includes(`/messages/${E}`)).length, 0);
    redirect = true;
    await assert.rejects(f.client.recoverSend(D), err('STORAGE_UNAVAILABLE'));
  } finally { f.close(); }
});

test('attachment digest failure never ACKs; saved file survives journal failure and reopen', async () => {
  const bytes = Buffer.from('safe bytes');
  const attachment = { attachmentId: F, name: 'untrusted.txt', mime: 'text/plain', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  let corrupt = true, ack = 0, downloads = 0;
  const m = { ...inbound, attachment };
  const f = fixture(req => {
    if (req.path === '/api/v1/me') return ok({ agentId: A });
    if (req.path === '/api/v1/receiver/lease') return ok({ instanceId: I, generation: 1, expiresAt: Date.now() + 600000, historical: false });
    if (req.path === '/api/v1/receiver/lease/renew') return ok({ instanceId: I, generation: 1, expiresAt: Date.now() + 600000 });
    if (req.path.startsWith('/api/v1/sync')) return ok({ streamEpoch: R, ackedThrough: 0, pageAfter: 1, hasMore: false, items: [{ seq: 1, message: m }] });
    if (req.path === `/api/v1/attachments/${F}`) { downloads++; return { status: 200, body: corrupt ? Buffer.from('bad bytes!') : bytes }; }
    if (req.path === `/api/v1/messages/${E}`) return ok(m);
    if (req.path === '/api/v1/acks') { ack++; return ok({ ackedThrough: 1 }); }
    throw Error('unexpected');
  });
  try {
    await f.client.acquire({ instanceId: I, requestId: D });
    await assert.rejects(f.client.receiveOnce(), err('INVALID_ATTACHMENT'));
    assert.equal(ack, 0);
    corrupt = false;
    // Simulate crash after durable file save, before journal transaction.
    f.db.exec("CREATE TRIGGER fail_client_insert BEFORE INSERT ON im_client_received BEGIN SELECT RAISE(ABORT,'simulated crash'); END");
    await assert.rejects(f.client.receiveOnce());
    assert.equal(ack, 0);
    f.db.exec('DROP TRIGGER fail_client_insert');
    f.reopen();
    await f.client.renewLease();
    const result = await f.client.receiveOnce();
    assert.equal(result.items[0].status, 'delivered');
    assert.equal(downloads, 2);
    assert.equal(ack, 1);
  } finally { f.close(); }
});

test('lost ACK leaves durable pending; reopen revalidates fence and retries exact IDs', async () => {
  let lost = true, ack = 0;
  const f = fixture(req => {
    if (req.path === '/api/v1/me') return ok({ agentId: A });
    if (req.path === '/api/v1/receiver/lease') return ok({ instanceId: I, generation: 1, expiresAt: Date.now() + 600000, historical: false });
    if (req.path === '/api/v1/receiver/lease/renew') return ok({ instanceId: I, generation: 1, expiresAt: Date.now() + 600000 });
    if (req.path.startsWith('/api/v1/sync')) return ok({ streamEpoch: R, ackedThrough: 0, pageAfter: 1, hasMore: false, items: [{ seq: 1, message: inbound }] });
    if (req.path === `/api/v1/messages/${E}`) return ok(inbound);
    if (req.path === '/api/v1/acks') {
      assert.deepEqual(JSON.parse(req.body).messageIds, [E]); ack++;
      if (lost) throw Error('lost ACK');
      return ok({ ackedThrough: 1 });
    }
    throw Error('unexpected');
  });
  try {
    await f.client.acquire({ instanceId: I, requestId: D });
    await assert.rejects(f.client.receiveOnce(), err('STORAGE_UNAVAILABLE'));
    assert.equal(f.db.prepare('SELECT acked FROM im_client_received').get().acked, 0);
    f.reopen(); lost = false;
    assert.deepEqual(await f.client.ackPending(), { acked: [E] });
    assert.equal(ack, 2);
    assert.equal(f.db.prepare('SELECT acked FROM im_client_received').get().acked, 1);
  } finally { f.close(); }
});

test('revocation and stale fence block ACK of pending durable records', async () => {
  let revoked = false, ack = 0;
  const f = fixture(req => {
    if (req.path === '/api/v1/me') return revoked ? { status: 401, body: Buffer.from('{"error":{"code":"INVALID_CREDENTIAL"}}') } : ok({ agentId: A });
    if (req.path === '/api/v1/receiver/lease') return ok({ instanceId: I, generation: 1, expiresAt: Date.now() + 600000, historical: false });
    if (req.path === '/api/v1/receiver/lease/renew') return { status: 409, body: Buffer.from('{"error":{"code":"STALE_FENCE"}}') };
    if (req.path === '/api/v1/acks') { ack++; return ok({ ackedThrough: 1 }); }
    throw Error('unexpected');
  });
  try {
    await f.client.acquire({ instanceId: I, requestId: D });
    await assert.rejects(f.client.receiveOnce(), err('STALE_FENCE'));
    revoked = true;
    await assert.rejects(f.client.ackPending(), err('INVALID_CREDENTIAL'));
    assert.equal(ack, 0);
  } finally { f.close(); }
});

test('real HTTPS handler + CA verified client send, attachment receipt, ACK and reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'im-client-tls-'));
  const directory = join(root, 'attachments'); mkdirSync(directory);
  const cert = readFileSync(new URL('./fixtures/im-tls/localhost-test-only.crt', import.meta.url));
  const key = readFileSync(new URL('./fixtures/im-tls/localhost-test-only.key', import.meta.url));
  // TLS CA supplied via trusted HTTPS Agent, never a rejectUnauthorized:false option.
  const agent = new https.Agent({ ca: cert, rejectUnauthorized: true });
  const central = new DatabaseSync(':memory:'); central.exec('PRAGMA foreign_keys=ON'); migrateImSchema(central);
  const context = {}, clock = () => 10000;
  const admin = createImAdmin({ db: central, clock, authorizeAdmin: c => c === context });
  const auth = createImAuth({ db: central, clock }), acl = createImAcl({ db: central, auth, clock });
  const agents = [0, 1].map(i => {
    const agentId = admin.registerAgent({ displayName: `TLS Agent ${i}` }, context).agentId;
    return { agentId, ...admin.issueCredential({ agentId, expiresAt: null }, context) };
  });
  admin.setContact({ agentA: agents[0].agentId, agentB: agents[1].agentId, allowed: true, reason: 'test' }, context);
  central.exec("UPDATE im_settings SET write_mode='enabled'");
  const policy = { enabled: true, writeMode: 'enabled', transport: { mode: 'direct-tls', serverUrl: 'https://localhost:8787' },
    retention: { policy: { messageRetentionMs: 100000, attachmentRetentionMs: 90000,
      idempotencyRetentionMs: 110000, safeRetryWindowMs: 1000 } }, lease: { ttlMs: 90000, renewalMs: 30000 } };
  const messages = createImMessages({ db: central, auth, acl, clock, policy });
  const delivery = createImDelivery({ db: central, auth, acl, clock, policy });
  const handler = createImHandler({ auth, acl, messages, delivery, policy });
  const server = https.createServer({ key, cert }, (req, res) => { handler.handle(req, res).catch(() => res.destroy()); });
  server.maxHeadersCount = 64;
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  const center = `https://localhost:${server.address().port}`;
  const filename = join(root, 'journal.sqlite');
  let db = new DatabaseSync(filename); db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  const transport = input => new Promise((resolve, reject) => {
    const req = https.request(new URL(input.path, center), { method: input.method, agent, timeout: 30000,
      headers: { Authorization: `Bearer ${input.credential}`, ...input.headers,
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }) } }, res => {
      let chunks = [], size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) { req.destroy(); reject(Error('oversized')); } else chunks.push(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy()); req.end(input.body);
  });
  const client = index => createImClient({ serverUrl: center, agentId: agents[index].agentId,
    getCredential: async () => agents[index].credential, journal: scope => createImJournal({ db, ...scope }),
    attachmentDirectory: directory, transport });
  let sender = client(0), receiver = client(1);
  try {
    const conversationId = (await sender.ensureConversation({ peerAgentId: agents[1].agentId })).conversationId;
    const bytes = Buffer.from('verified TLS binary');
    const sent = await sender.send({ protocol: PROTOCOL, conversationId, recipientAgentId: agents[1].agentId,
      clientMessageId: D, text: 'real TLS message', attachment: { name: 'ignored.bin',
        sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') } });
    assert.ok(sent.messageId);
    await receiver.acquire({ instanceId: I, requestId: R });
    const page = await receiver.receiveOnce();
    assert.equal(page.items[0].status, 'delivered');
    assert.equal(page.items[0].message.messageId, sent.messageId);
    assert.equal(readFileSync(page.items[0].attachmentReceipt.path).toString(), bytes.toString());
    assert.equal(central.prepare('SELECT acked_at FROM im_deliveries WHERE message_id=?').get(sent.messageId).acked_at !== null, true);
    sender.close(); receiver.close(); db.close();
    db = new DatabaseSync(filename); db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    sender = client(0);
    assert.equal((await sender.send({ protocol: PROTOCOL, conversationId, recipientAgentId: agents[1].agentId,
      clientMessageId: D, text: 'real TLS message', attachment: { name: 'ignored.bin',
        sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') } })).messageId, sent.messageId);
  } finally {
    sender.close(); receiver.close(); db.close(); handler.close(); agent.destroy();
    await new Promise(resolve => server.close(resolve)); central.close(); rmSync(root, { recursive: true, force: true });
  }
});
