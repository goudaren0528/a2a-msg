import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { migrateImSchema } from '../src/im/schema.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImAuth } from '../src/im/auth.js';
import { createImAcl } from '../src/im/acl.js';
import { createImMessages } from '../src/im/messages.js';
import { createImDelivery } from '../src/im/delivery.js';
import { createImHandler } from '../src/im/http.js';
import { PROTOCOL } from '../src/im/contracts.js';

const policy = { enabled: true, writeMode: 'enabled', transport: { mode: 'local-test', serverUrl: 'http://127.0.0.1:8787' },
  retention: { policy: { messageRetentionMs: 100000, attachmentRetentionMs: 90000,
    idempotencyRetentionMs: 110000, safeRetryWindowMs: 1000 } }, lease: { ttlMs: 90000, renewalMs: 30000 } };

async function fixture(options = {}) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrateImSchema(db);
  const blobReads = [];
  const store = options.traceBlob ? new Proxy(db, { get(target, key) {
    if (key === 'prepare') return sql => {
      const statement = target.prepare(sql);
      if (!/\bFROM\s+im_attachments\b/i.test(sql) || !/SELECT\s+\*/i.test(sql)) return statement;
      return new Proxy(statement, { get(stmt, method) {
        if (method === 'get' || method === 'all') return (...args) => { blobReads.push(sql); return stmt[method](...args); };
        const value = stmt[method]; return typeof value === 'function' ? value.bind(stmt) : value;
      } });
    };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } }) : db;
  const clock = () => 10000, context = {};
  const admin = createImAdmin({ db: store, clock, authorizeAdmin: c => c === context });
  const auth = createImAuth({ db: store, clock }), acl = createImAcl({ db: store, auth, clock });
  const agents = Array.from({ length: 3 }, (_, i) => {
    const agentId = admin.registerAgent({ displayName: `Agent ${i}` }, context).agentId;
    const credential = admin.issueCredential({ agentId, expiresAt: null }, context);
    return { agentId, ...credential };
  });
  admin.setContact({ agentA: agents[0].agentId, agentB: agents[1].agentId, allowed: true, reason: 'test' }, context);
  db.exec("UPDATE im_settings SET write_mode='enabled'");
  const messages = createImMessages({ db: store, auth, acl, clock, policy });
  const delivery = createImDelivery({ db: store, auth, acl, clock, policy });
  const adapter = createImHandler({ auth, acl, messages, delivery, policy: options.policy ?? policy,
    ...(options.trustedTimers ? { trustedTimers: options.trustedTimers } : {}) });
  // Test-only localhost certificate/private key. Never load outside this isolated fixture.
  const tls = options.tls ? { key: readFileSync(new URL('./fixtures/im-tls/localhost-test-only.key', import.meta.url)),
    cert: readFileSync(new URL('./fixtures/im-tls/localhost-test-only.crt', import.meta.url)) } : null;
  const server = (tls ? https.createServer(tls, listener) : http.createServer(listener));
  function listener(req, res) {
    adapter.handle(req, res).then(handled => { if (!handled) { res.statusCode = 418; res.end('legacy'); } });
  }
  server.maxHeadersCount = 64;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = (path, { agent = 0, method = 'GET', body, headers = {}, host = '127.0.0.1', ca = tls?.cert } = {}) => new Promise((resolve, reject) => {
    const req = (tls ? https : http).request({ host, port: server.address().port, path, method,
      ...(tls ? { ca, rejectUnauthorized: true } : {}),
      headers: { Authorization: `Bearer ${agents[agent].credential}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, raw,
          json: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(raw.toString()) : null });
      });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
  });
  return { db, admin, auth, agents, context, adapter, request, port: server.address().port, server, blobReads,
    close: async () => { adapter.close(); await new Promise(resolve => server.close(resolve)); db.close(); } };
}

test('isolated HTTP identity, send/replay, binary ACL, lease sync ACK read and legacy boundary', async () => {
  const f = await fixture(); try {
    const [a, b] = f.agents;
    assert.equal((await f.request('/old')).status, 418);
    assert.equal((await f.request('/api/v1x/me')).status, 418);
    assert.equal((await f.request('/api/v1/unknown-resource')).status, 404);
    assert.deepEqual((await f.request('/api/v1/me')).json, { agentId: a.agentId });
    assert.equal((await f.request('/api/v1/contacts')).json.items[0].peerAgentId, b.agentId);
    const conv = (await f.request('/api/v1/conversations', { method: 'POST', body: { peerAgentId: b.agentId } })).json;
    const data = Buffer.from('test bytes');
    const message = { protocol: PROTOCOL, conversationId: conv.conversationId, recipientAgentId: b.agentId,
      clientMessageId: randomUUID(), title: null, text: '', attachment: { name: 'hello.txt',
        sha256: createHash('sha256').update(data).digest('hex'), dataBase64: data.toString('base64') } };
    const sent = await f.request('/api/v1/messages', { method: 'POST', body: message });
    assert.equal(sent.status, 201); assert.equal(sent.json.title, null);
    assert.equal((await f.request('/api/v1/messages', { method: 'POST', body: message })).status, 200);
    assert.equal((await f.request(`/api/v1/sends/${message.clientMessageId}`)).json.messageId, sent.json.messageId);
    assert.equal((await f.request(`/api/v1/conversations/${conv.conversationId}/messages`, { agent: 1 })).json.items.length, 1);
    const attachmentId = sent.json.attachment.attachmentId;
    assert.deepEqual((await f.request(`/api/v1/attachments/${attachmentId}`, { agent: 1 })).raw, data);
    assert.equal((await f.request(`/api/v1/attachments/${attachmentId}`, { agent: 2 })).status, 404);
    const instanceId = randomUUID();
    const lease = await f.request('/api/v1/receiver/lease', { agent: 1, method: 'POST', body: { instanceId, requestId: randomUUID() } });
    assert.equal(lease.status, 200);
    const fence = { instanceId, generation: lease.json.generation };
    const sync = await f.request('/api/v1/sync', { agent: 1, headers: { 'X-A2A-Instance-Id': instanceId, 'X-A2A-Generation': String(fence.generation) } });
    assert.equal(sync.json.items[0].message.messageId, sent.json.messageId);
    assert.equal((await f.request('/api/v1/acks', { agent: 1, method: 'POST', body: { ...fence, messageIds: [sent.json.messageId] } })).status, 200);
    assert.equal((await f.request(`/api/v1/messages/${sent.json.messageId}/read`, { agent: 1, method: 'POST', body: {} })).json.changed, true);
    assert.equal((await f.request('/api/v1/receiver/lease/renew', { agent: 1, method: 'POST', body: fence })).status, 200);
    assert.equal((await f.request('/api/v1/receiver/lease/release', { agent: 1, method: 'POST', body: fence })).status, 200);
  } finally { await f.close(); }
});

test('disabled, strict input, unknown principal, duplicate query and contact revocation', async () => {
  const f = await fixture(); try {
    assert.equal((await f.request('/api/v1/me', { headers: { Authorization: 'Bearer invalid' } })).status, 401);
    assert.equal((await f.request('/api/v1/me', { headers: { Authorization: '' } })).status, 401);
    assert.equal((await f.request('/api/v1/me?limit=1&limit=2')).status, 400);
    assert.equal((await f.request('/api/v1/contacts?extra=1')).status, 400);
    assert.equal((await f.request('/api/v1/conversations', { method: 'POST', body: { peerAgentId: f.agents[1].agentId, from: f.agents[2].agentId } })).status, 400);
    assert.equal((await f.request('/api/v1/messages', { method: 'POST', body: 'x'.repeat(16 * 1024 * 1024 + 1) })).status, 413);
    const conv = (await f.request('/api/v1/conversations', { method: 'POST', body: { peerAgentId: f.agents[1].agentId } })).json;
    f.admin.setContact({ agentA: f.agents[0].agentId, agentB: f.agents[1].agentId, allowed: false, reason: 'test' }, f.context);
    assert.equal((await f.request(`/api/v1/conversations/${conv.conversationId}/messages`)).status, 404);
    assert.equal((await f.request(`/api/v1/messages/${randomUUID()}`)).status, 404);
    const disabled = createImHandler({});
    assert.equal(typeof disabled.close, 'function'); disabled.close();
  } finally { await f.close(); }
});

test('transport cannot be forged by proxy headers; paused and disabled policies fail closed', async () => {
  const tlsPolicy = { ...policy, transport: { mode: 'direct-tls', serverUrl: 'https://localhost:8787' } };
  const f = await fixture({ policy: tlsPolicy }); try {
    const res = await f.request('/api/v1/me', { headers: { 'X-Forwarded-Proto': 'https', Forwarded: 'proto=https' } });
    assert.equal(res.status, 403); assert.equal(res.json.error.code, 'TLS_REQUIRED');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  } finally { await f.close(); }
  const off = await fixture({ policy: { enabled: false } }); try {
    assert.equal((await off.request('/api/v1/me')).json.error.code, 'IM_DISABLED');
  } finally { await off.close(); }
  const paused = await fixture({ policy: { ...policy, writeMode: 'paused' } }); try {
    assert.equal((await paused.request('/api/v1/me')).status, 200);
    assert.equal((await paused.request('/api/v1/conversations', { method: 'POST', body: { peerAgentId: paused.agents[1].agentId } })).json.error.code, 'NEW_WRITES_DISABLED');
  } finally { await paused.close(); }
});

test('bounded pre-auth socket rate state, no credential leak and raw header duplicates', async () => {
  const tight = { ...policy, limits: { maxAttachmentBytes: 10485760, maxBodyBytes: 65536,
    maxFileBodyBytes: 16777216, maxConnections: 2, maxRequestsPerMinute: 2 } };
  const f = await fixture({ policy: tight }); try {
    for (let i = 0; i < 2; i++) assert.equal((await f.request('/api/v1/me', { headers: { Authorization: 'Bearer bad' } })).status, 401);
    const limited = await f.request('/api/v1/me');
    assert.equal(limited.status, 429); assert.equal(limited.headers['retry-after'], '60');
    assert.doesNotMatch(JSON.stringify(limited.json), /Bearer|credential|SELECT/i);
  } finally { await f.close(); }
  const g = await fixture(); try {
    const duplicate = await g.request('/api/v1/me', { headers: { Authorization: [`Bearer ${g.agents[0].credential}`, `Bearer ${g.agents[1].credential}`] } });
    assert.equal(duplicate.status, 400);
    assert.equal((await g.request('/api/v1/sync', { headers: { 'X-A2A-Instance-Id': randomUUID(), 'X-A2A-Generation': '01' } })).status, 400);
  } finally { await g.close(); }
});

test('real localhost TLS verifies certificate and hostname; identity, send, attachment and sync', async () => {
  const direct = { ...policy, transport: { mode: 'direct-tls', serverUrl: 'https://127.0.0.1:8787' } };
  const f = await fixture({ tls: true, policy: direct }); try {
    assert.deepEqual((await f.request('/api/v1/me')).json, { agentId: f.agents[0].agentId });
    await assert.rejects(f.request('/api/v1/me', { ca: Buffer.from('not a certificate') }));
    const conv = (await f.request('/api/v1/conversations', { method: 'POST', body: { peerAgentId: f.agents[1].agentId } })).json;
    const bytes = Buffer.from('HTTPS-only local test');
    const sent = await f.request('/api/v1/messages', { method: 'POST', body: { protocol: PROTOCOL,
      conversationId: conv.conversationId, recipientAgentId: f.agents[1].agentId, clientMessageId: randomUUID(), text: '',
      attachment: { name: 'tls.txt', sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') } } });
    assert.equal(sent.status, 201); assert.equal(sent.json.senderAgentId, f.agents[0].agentId);
    assert.deepEqual((await f.request(`/api/v1/attachments/${sent.json.attachment.attachmentId}`, { agent: 1 })).raw, bytes);
    assert.equal((await f.request(`/api/v1/attachments/${sent.json.attachment.attachmentId}`, { agent: 2 })).status, 404);
    const instanceId = randomUUID();
    const lease = await f.request('/api/v1/receiver/lease', { agent: 1, method: 'POST', body: { instanceId, requestId: randomUUID() } });
    assert.equal((await f.request('/api/v1/sync', { agent: 1,
      headers: { 'X-A2A-Instance-Id': instanceId, 'X-A2A-Generation': String(lease.json.generation) } })).json.items[0].message.messageId, sent.json.messageId);
    // Force hostname verification mismatch while still connecting to the real TLS listener.
    await assert.rejects(new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', servername: 'wrong.localhost', port: f.port,
        ca: readFileSync(new URL('./fixtures/im-tls/localhost-test-only.crt', import.meta.url)),
        path: '/api/v1/me', headers: { Authorization: `Bearer ${f.agents[0].credential}` } }, resolve);
      req.on('error', reject); req.end();
    }), /hostname|altname|certificate/i);
  } finally { await f.close(); }
});

test('body budgets enforce 64 KiB text and 16 MiB file with chunked transport', async () => {
  const f = await fixture(); try {
    const conv = (await f.request('/api/v1/conversations', { method: 'POST', body: { peerAgentId: f.agents[1].agentId } })).json;
    const plain = { protocol: PROTOCOL, conversationId: conv.conversationId, recipientAgentId: f.agents[1].agentId,
      clientMessageId: randomUUID(), text: 'a'.repeat(65536) };
    const oversizedText = await f.request('/api/v1/messages', { method: 'POST', body: plain,
      headers: { 'Transfer-Encoding': 'chunked' } });
    assert.equal(oversizedText.status, 413, JSON.stringify(oversizedText.json));
    assert.equal((await f.request('/api/v1/messages', { method: 'POST', body: { ...plain, attachment: { name: 'x',
      sha256: '0'.repeat(64), dataBase64: 'A'.repeat(16 * 1024 * 1024) } },
      headers: { 'Transfer-Encoding': 'chunked' } })).status, 413);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM im_messages').get().n, 0);
  } finally { await f.close(); }
});

test('attachment download stops on contact revocation during backpressure', async () => {
  const f = await fixture(); try {
    const conv = (await f.request('/api/v1/conversations', { method: 'POST', body: { peerAgentId: f.agents[1].agentId } })).json;
    const bytes = Buffer.alloc(2 * 1024 * 1024, 97);
    const sent = await f.request('/api/v1/messages', { method: 'POST', body: { protocol: PROTOCOL,
      conversationId: conv.conversationId, recipientAgentId: f.agents[1].agentId, clientMessageId: randomUUID(),
      attachment: { name: 'large.bin', sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') } } });
    assert.equal(sent.status, 201);
    const result = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: f.port, path: `/api/v1/attachments/${sent.json.attachment.attachmentId}`,
        headers: { Authorization: `Bearer ${f.agents[1].credential}` } }, res => {
        let received = 0, revoked = false;
        res.on('data', chunk => {
          received += chunk.length;
          if (!revoked) {
            revoked = true;
            res.pause();
            f.admin.setContact({ agentA: f.agents[0].agentId, agentB: f.agents[1].agentId,
              allowed: false, reason: 'test' }, f.context);
            setTimeout(() => res.resume(), 10);
          }
        });
        res.on('error', () => resolve({ received, complete: res.complete }));
        res.on('end', () => resolve({ received, complete: res.complete }));
        res.on('close', () => resolve({ received, complete: res.complete }));
      });
      req.on('error', reject);
    });
    assert.equal(result.complete, false);
    assert.ok(result.received < bytes.length);
  } finally { await f.close(); }
});

test('full 10 MiB download hashes correctly with one BLOB SELECT; unauthorized gets none', async () => {
  const f = await fixture({ traceBlob: true }); try {
    const conv = (await f.request('/api/v1/conversations', { method: 'POST', body: { peerAgentId: f.agents[1].agentId } })).json;
    const bytes = Buffer.alloc(10 * 1024 * 1024, 42);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const sent = await f.request('/api/v1/messages', { method: 'POST', body: { protocol: PROTOCOL,
      conversationId: conv.conversationId, recipientAgentId: f.agents[1].agentId, clientMessageId: randomUUID(),
      attachment: { name: 'max.bin', sha256, dataBase64: bytes.toString('base64') } } });
    assert.equal(sent.status, 201);
    f.blobReads.length = 0;
    const got = await f.request(`/api/v1/attachments/${sent.json.attachment.attachmentId}`, { agent: 1 });
    assert.equal(got.status, 200);
    assert.equal(got.raw.length, bytes.length);
    assert.equal(createHash('sha256').update(got.raw).digest('hex'), sha256);
    assert.equal(f.blobReads.length, 1, 'one initial authorized BLOB SELECT, not one per 64 KiB chunk');
    f.blobReads.length = 0;
    assert.equal((await f.request(`/api/v1/attachments/${sent.json.attachment.attachmentId}`, { agent: 2 })).status, 404);
    assert.equal(f.blobReads.length, 0, 'unauthorized recipient never selects attachment BLOB');
  } finally { await f.close(); }
});

test('credential revocation during download terminates response without subsequent BLOB reads', async () => {
  const f = await fixture({ traceBlob: true }); try {
    const conv = (await f.request('/api/v1/conversations', { method: 'POST', body: { peerAgentId: f.agents[1].agentId } })).json;
    const bytes = Buffer.alloc(2 * 1024 * 1024, 97);
    const sent = await f.request('/api/v1/messages', { method: 'POST', body: { protocol: PROTOCOL,
      conversationId: conv.conversationId, recipientAgentId: f.agents[1].agentId, clientMessageId: randomUUID(),
      attachment: { name: 'large.bin', sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') } } });
    assert.equal(sent.status, 201);
    f.blobReads.length = 0;
    const result = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: f.port, path: `/api/v1/attachments/${sent.json.attachment.attachmentId}`,
        headers: { Authorization: `Bearer ${f.agents[1].credential}` } }, res => {
        let received = 0, revoked = false;
        res.on('data', chunk => {
          received += chunk.length;
          if (!revoked) {
            revoked = true; res.pause();
            f.admin.revokeCredential({ credentialId: f.agents[1].credentialId, reason: 'test' }, f.context);
            setTimeout(() => res.resume(), 10);
          }
        });
        res.on('error', () => resolve({ received, complete: res.complete }));
        res.on('end', () => resolve({ received, complete: res.complete }));
        res.on('close', () => resolve({ received, complete: res.complete }));
      });
      req.on('error', reject);
    });
    assert.equal(result.complete, false);
    assert.ok(result.received < bytes.length);
    assert.equal(f.blobReads.length, 1);
  } finally { await f.close(); }
});

test('close aborts an active download but leaves the caller-owned HTTP listener open', async () => {
  const f = await fixture(); try {
    const conv = (await f.request('/api/v1/conversations', { method: 'POST', body: { peerAgentId: f.agents[1].agentId } })).json;
    const bytes = Buffer.alloc(2 * 1024 * 1024, 97);
    const sent = await f.request('/api/v1/messages', { method: 'POST', body: { protocol: PROTOCOL,
      conversationId: conv.conversationId, recipientAgentId: f.agents[1].agentId, clientMessageId: randomUUID(),
      attachment: { name: 'large.bin', sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') } } });
    assert.equal(sent.status, 201);
    const result = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: f.port, path: `/api/v1/attachments/${sent.json.attachment.attachmentId}`,
        headers: { Authorization: `Bearer ${f.agents[1].credential}` } }, res => {
        let received = 0, stopped = false;
        res.on('data', chunk => {
          received += chunk.length;
          if (!stopped) { stopped = true; res.pause(); f.adapter.close(); res.resume(); }
        });
        res.on('error', () => resolve({ received, complete: res.complete }));
        res.on('end', () => resolve({ received, complete: res.complete }));
        res.on('close', () => resolve({ received, complete: res.complete }));
      });
      req.on('error', reject);
    });
    assert.equal(result.complete, false);
    assert.ok(result.received < bytes.length);
    assert.equal(f.server.listening, true);
    assert.equal((await f.request('/api/v1/me')).json.error.code, 'IM_DISABLED');
  } finally { await f.close(); }
});

test('fatal UTF-8 rejects invalid continuation and truncated sequences without persisting messages', async () => {
  const f = await fixture(); try {
    const conv = (await f.request('/api/v1/conversations', { method: 'POST', body: { peerAgentId: f.agents[1].agentId } })).json;
    const raw = Buffer.from(JSON.stringify({ protocol: PROTOCOL, conversationId: conv.conversationId,
      recipientAgentId: f.agents[1].agentId, clientMessageId: randomUUID(), text: 'x' }));
    const point = raw.indexOf(Buffer.from('x'));
    for (const replacement of [Buffer.from([0xc3, 0x28]), Buffer.from([0xe4, 0xb8])]) {
      const malformed = Buffer.concat([raw.subarray(0, point), replacement, raw.subarray(point + 1)]);
      const response = await f.request('/api/v1/messages', { method: 'POST', body: malformed });
      assert.equal(response.status, 400);
      assert.equal(response.json.error.code, 'INVALID_REQUEST');
    }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM im_messages').get().n, 0);
  } finally { await f.close(); }
});

test('UTF-8 Chinese and emoji split across request chunks are preserved; byte budget wins over malformed encoding', async () => {
  const f = await fixture(); try {
    const conv = (await f.request('/api/v1/conversations', { method: 'POST', body: { peerAgentId: f.agents[1].agentId } })).json;
    const text = '中文🌐中文';
    const raw = Buffer.from(JSON.stringify({ protocol: PROTOCOL, conversationId: conv.conversationId,
      recipientAgentId: f.agents[1].agentId, clientMessageId: randomUUID(), text }));
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/api/v1/messages',
        headers: { Authorization: `Bearer ${f.agents[0].credential}`, 'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked' } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode,
          json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      for (const byte of raw) req.write(Buffer.from([byte]));
      req.end();
    });
    assert.equal(result.status, 201); assert.equal(result.json.text, text);
    const tooLarge = Buffer.concat([Buffer.from('['), Buffer.alloc(16 * 1024 * 1024, 0xff), Buffer.from(']')]);
    const oversized = await f.request('/api/v1/messages', { method: 'POST', body: tooLarge });
    assert.equal(oversized.status, 413);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM im_messages').get().n, 1);
  } finally { await f.close(); }
});

test('RFC 5987 filename escapes apostrophe, parens and Unicode without changing binary bytes', async () => {
  const f = await fixture(); try {
    const conv = (await f.request('/api/v1/conversations', { method: 'POST', body: { peerAgentId: f.agents[1].agentId } })).json;
    const bytes = Buffer.from('x'), name = "中🌐'()*.txt";
    const sent = await f.request('/api/v1/messages', { method: 'POST', body: { protocol: PROTOCOL,
      conversationId: conv.conversationId, recipientAgentId: f.agents[1].agentId, clientMessageId: randomUUID(),
      attachment: { name, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') } } });
    assert.equal(sent.status, 201);
    const response = await f.request(`/api/v1/attachments/${sent.json.attachment.attachmentId}`, { agent: 1 });
    assert.deepEqual(response.raw, bytes);
    assert.match(response.headers['content-disposition'], /%27%28%29%2A\.txt$/);
    assert.equal(decodeURIComponent(response.headers['content-disposition'].split("''")[1]), name);
  } finally { await f.close(); }
});

test('trusted timeout aborts incomplete POST and cleanup cancels only after response finish or close', async () => {
  const scheduled = new Map(), cancelled = new Set();
  let next = 0, waiter = null;
  const trustedTimers = { setTimeout(callback, milliseconds) {
    assert.equal(milliseconds, 30000);
    const token = ++next; scheduled.set(token, callback);
    waiter?.(); waiter = null;
    return { token, unref() {} };
  }, clearTimeout(timer) { cancelled.add(timer.token); scheduled.delete(timer.token); } };
  const f = await fixture({ trustedTimers }); try {
    const ok = await f.request('/api/v1/me');
    assert.equal(ok.status, 200);
    assert.equal(scheduled.size, 0, 'finish clears normal response timeout');
    assert.equal(cancelled.size, 1);
    let started;
    const startedPromise = new Promise(resolve => { started = resolve; });
    const completed = new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/api/v1/messages',
        headers: { Authorization: `Bearer ${f.agents[0].credential}`, 'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked' } });
      req.on('error', error => { if (error.code === 'ECONNRESET') resolve(); else reject(error); });
      req.on('response', res => { res.resume(); res.on('close', resolve); });
      req.write('{'); req.once('socket', () => started());
    });
    await startedPromise;
    // The socket event fires before the server parses the request; wait for the handler's
    // trusted timer registration rather than assuming a fixed number of event-loop ticks.
    const registered = new Promise(resolve => { if (scheduled.size > 0) resolve(); else waiter = resolve; });
    await registered;
    assert.equal(scheduled.size, 1);
    [...scheduled.values()][0]();
    await completed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scheduled.size, 0);
    assert.equal(cancelled.size, 2, 'aborted request releases timer exactly once');
    assert.equal(f.server.listening, true);
  } finally { await f.close(); }
});
