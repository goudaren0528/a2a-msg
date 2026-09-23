import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateImSchema } from '../src/im/schema.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImCenter } from '../src/im/server.js';
import { createImEvents } from '../src/im/events.js';
import { PROTOCOL } from '../src/im/contracts.js';

const policy = { enabled: true, writeMode: 'enabled', transport: { mode: 'local-test', serverUrl: 'http://127.0.0.1:8787' },
  retention: { policy: { messageRetentionMs: 100000, attachmentRetentionMs: 90000,
    idempotencyRetentionMs: 110000, safeRetryWindowMs: 1000 } }, lease: { ttlMs: 90000, renewalMs: 30000 } };

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'im-events-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL'); migrateImSchema(db);
  const clock = () => { options.observeClock?.(); return 10000; }, context = {};
  const admin = createImAdmin({ db, clock, authorizeAdmin: value => value === context });
  const agents = Array.from({ length: 3 }, (_, index) => {
    const agentId = admin.registerAgent({ displayName: `Agent ${index}` }, context).agentId;
    return { agentId, ...admin.issueCredential({ agentId, expiresAt: null }, context) };
  });
  admin.setContact({ agentA: agents[0].agentId, agentB: agents[1].agentId, allowed: true, reason: 'test' }, context);
  if (options.extraContact) admin.setContact({ agentA: agents[1].agentId, agentB: agents[2].agentId,
    allowed: true, reason: 'test' }, context);
  if (options.manyContacts) {
    // Test-only bulk fixture, preserving schema keys and FK checks without 1001 durable admin transactions.
    const insertAgent = db.prepare(`INSERT INTO im_agents(agent_id,display_name,status,created_at,revoked_at)
      VALUES (?,?,'active',10000,NULL)`);
    const insertContact = db.prepare(`INSERT INTO im_contacts(agent_low,agent_high,allowed,version,updated_at)
      VALUES (?,?,1,1,10000)`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let i = 0; i < 1001; i++) {
        const peer = randomUUID();
        insertAgent.run(peer, `Test peer ${i}`);
        const [low, high] = [agents[1].agentId, peer].sort();
        insertContact.run(low, high);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  db.exec("UPDATE im_settings SET write_mode='enabled'");
  const im = createImCenter({ db, clock, policy: options.disabled ? { enabled: false } :
    options.maxConnections ? { ...policy, limits: { maxAttachmentBytes: 10485760,
      maxBodyBytes: 65536, maxFileBodyBytes: 16777216, maxConnections: options.maxConnections,
      maxRequestsPerMinute: 600 } } : policy,
    eventsOptions: options.eventsOptions, trustedTimers: options.trustedTimers });
  const server = http.createServer((req, res) => {
    if (options.slowResponse && req.url === '/api/v1/events') res.write = () => false;
    im.handler.handle(req, res).then(handled => { if (!handled) { res.statusCode = 418; res.end('legacy'); } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    im.close(); await new Promise(resolve => server.close(resolve)); db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const request = (path, { agent = 0, method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method,
      headers: { Authorization: `Bearer ${agents[agent].credential}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, text,
          json: res.headers['content-type']?.includes('json') ? JSON.parse(text) : null }); });
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const stream = (agent = 1) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/v1/events',
      headers: { Authorization: `Bearer ${agents[agent].credential}` } }, res => {
      let text = '';
      let ended = false;
      const waiters = [];
      res.on('data', chunk => { text += chunk.toString(); for (const waiter of waiters.splice(0)) waiter(); });
      res.on('end', () => { ended = true; for (const waiter of waiters.splice(0)) waiter(); });
      res.on('close', () => { ended = true; for (const waiter of waiters.splice(0)) waiter(); });
      resolve({ req, res, get text() { return text; }, get ended() { return ended; },
        wait: () => new Promise(done => { if (ended) done(); else waiters.push(done); }), close: () => req.destroy() });
    });
    req.on('error', reject);
  });
  return { db, admin, context, agents, im, request, stream, port };
}

test('recipient-only hint is payload-free; missing hints do not impede durable sync', async t => {
  const f = await fixture(t);
  const receiver = await f.stream(1), stranger = await f.stream(2);
  assert.equal(receiver.res.statusCode, 200);
  assert.equal(receiver.res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(receiver.res.headers['cache-control'], 'no-store');
  assert.match(receiver.res.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  const conv = (await f.request('/api/v1/conversations', { method: 'POST', body: { peerAgentId: f.agents[1].agentId } })).json;
  const bytes = Buffer.from('secret-attachment');
  const sent = await f.request('/api/v1/messages', { method: 'POST', body: {
    protocol: PROTOCOL, conversationId: conv.conversationId, recipientAgentId: f.agents[1].agentId,
    clientMessageId: randomUUID(), title: 'secret-title', text: 'secret-body',
    attachment: { name: 'secret-name.txt', sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') },
  } });
  assert.equal(sent.status, 201);
  if (!receiver.text.includes('data: sync')) await receiver.wait();
  assert.match(receiver.text, /event: change\ndata: sync/);
  for (const secret of ['secret-title', 'secret-body', 'secret-name.txt', f.agents[1].credential,
    sent.json.messageId, 'ackedThrough', 'streamEpoch', 'pageAfter']) assert.equal(receiver.text.includes(secret), false);
  assert.equal(stranger.text.includes('data: sync'), false);
  receiver.close(); stranger.close();
  const instanceId = randomUUID();
  const lease = await f.request('/api/v1/receiver/lease', { agent: 1, method: 'POST', body: { instanceId, requestId: randomUUID() } });
  assert.equal(lease.status, 200);
  const synced = await f.request('/api/v1/sync', { agent: 1, headers: {
    'X-A2A-Instance-Id': instanceId, 'X-A2A-Generation': String(lease.json.generation),
  } });
  assert.equal(synced.json.items[0].message.messageId, sent.json.messageId);
  assert.equal(synced.json.ackedThrough, 0);
});

test('revocation closes stream on trusted heartbeat; subscription quotas and strict request validation', async t => {
  const f = await fixture(t, { eventsOptions: { maxPerAgent: 1, maxSubscribers: 2, heartbeatMs: 20, idleMs: 1000 } });
  const receiver = await f.stream();
  const rejected = await f.request('/api/v1/events', { agent: 1 });
  assert.equal(rejected.status, 429); assert.equal(rejected.json.error.code, 'RATE_LIMITED');
  assert.equal((await f.request('/api/v1/events?credential=anything')).json.error.code, 'INVALID_REQUEST');
  assert.equal((await f.request('/api/v1/events', { headers: { 'X-Extra': '1' } })).json.error.code, 'INVALID_REQUEST');
  f.admin.revokeCredential({ credentialId: f.agents[1].credentialId, reason: 'test' }, f.context);
  await receiver.wait(); assert.equal(receiver.ended, true);
  assert.equal((await f.request('/api/v1/me')).status, 200);
});

test('idle timeout and close release subscribers and all trusted timers', async t => {
  const pending = new Set();
  const timers = { setTimeout(fn, ms) { const ticket = { fn, ms, unref() {} }; pending.add(ticket); return ticket; },
    clearTimeout(ticket) { pending.delete(ticket); } };
  const f = await fixture(t, { trustedTimers: timers, eventsOptions: { heartbeatMs: 100, idleMs: 200 } });
  const receiver = await f.stream();
  assert.equal([...pending].some(ticket => ticket.ms === 30000), false);
  for (const ticket of [...pending]) if (ticket.ms === 200) ticket.fn();
  await receiver.wait(); assert.equal(receiver.ended, true);
  assert.equal(pending.size, 0);
  const next = await f.stream(); next.close();
  f.im.close(); assert.equal(pending.size, 0);
});

test('disabled namespace returns IM_DISABLED without legacy fallback', async t => {
  const f = await fixture(t, { disabled: true });
  const response = await f.request('/api/v1/events');
  assert.equal(response.status, 503); assert.equal(response.json.error.code, 'IM_DISABLED');
  assert.equal(response.text.includes(f.agents[0].credential), false);
});

test('contact revocation terminates a stream and global subscriber cap remains bounded', async t => {
  const f = await fixture(t, { eventsOptions: { maxSubscribers: 1, heartbeatMs: 20, idleMs: 1000 } });
  const recipient = await f.stream(1);
  const limited = await f.request('/api/v1/events', { agent: 2 });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, 'RATE_LIMITED');
  f.admin.setContact({ agentA: f.agents[0].agentId, agentB: f.agents[1].agentId,
    allowed: false, reason: 'test' }, f.context);
  await recipient.wait();
  assert.equal(recipient.ended, true);
  const next = await f.stream(2);
  assert.equal(next.res.statusCode, 200);
  next.close();
});

test('controlled slow response destroys without waiting for end/finish, releases timers and subscriber', () => {
  const pending = new Set();
  const timers = { setTimeout(fn, ms) { const ticket = { fn, ms, unref() {} }; pending.add(ticket); return ticket; },
    clearTimeout(ticket) { pending.delete(ticket); } };
  const validate = () => {};
  const events = createImEvents({ validate, trustedTimers: timers, maxPerAgent: 1,
    maxSubscribers: 1, heartbeatMs: 10, idleMs: 20 });
  const principal = { agentId: randomUUID() }, peer = randomUUID();
  const response = (slow = false) => {
    const res = new EventEmitter();
    res.destroyed = false; res.writableEnded = false; res.ends = 0; res.destroys = 0;
    res.write = () => !slow;
    res.end = () => { res.ends++; }; // An unresponsive peer never emits finish.
    res.destroy = () => { res.destroys++; res.destroyed = true; res.emit('close'); };
    return res;
  };
  const blocked = response(true);
  const first = events.subscribe(principal, blocked, new Set([peer]));
  first.write(': connected\n\n');
  assert.equal(blocked.destroys, 1); assert.equal(blocked.ends, 0);
  assert.equal(pending.size, 0);
  const idle = response();
  events.subscribe(principal, idle, new Set([peer]));
  for (const ticket of [...pending]) if (ticket.ms === 20) ticket.fn();
  assert.equal(idle.destroys, 1); assert.equal(idle.ends, 0); assert.equal(pending.size, 0);
  const revoked = response();
  let active = true;
  const check = createImEvents({ validate: () => { if (!active) throw Error('revoked'); },
    trustedTimers: timers, heartbeatMs: 10, idleMs: 20 });
  check.subscribe(principal, revoked, new Set([peer]));
  active = false;
  for (const ticket of [...pending]) if (ticket.ms === 10) ticket.fn();
  assert.equal(revoked.destroys, 1); assert.equal(revoked.ends, 0);
  check.close();
  const last = response();
  events.subscribe(principal, last, new Set([peer]));
  events.close(); assert.equal(last.destroys, 1); assert.equal(pending.size, 0);
});

test('heartbeat timer rescheduling failure destroys response without uncaught exception', () => {
  let scheduled = 0, heartbeat;
  const timers = { setTimeout(fn, ms) {
    if (ms === 10 && ++scheduled === 2) throw Error('private timer error');
    const ticket = { fn, ms, unref() {} };
    if (ms === 10) heartbeat = ticket;
    return ticket;
  }, clearTimeout() {} };
  const events = createImEvents({ validate: () => {}, trustedTimers: timers,
    heartbeatMs: 10, idleMs: 20 });
  const res = new EventEmitter();
  res.destroyed = false;
  res.write = () => true;
  res.destroy = () => { res.destroyed = true; res.emit('close'); };
  events.subscribe({ agentId: randomUUID() }, res, new Set());
  assert.doesNotThrow(() => heartbeat.fn());
  assert.equal(res.destroyed, true);
  events.close();
});

test('real handler frees HTTP active slot after slow SSE and subsequent subscribe succeeds', async t => {
  let attempts = 0;
  const f = await fixture(t, { slowResponse: true, maxConnections: 1,
    eventsOptions: { maxSubscribers: 1 } });
  const request = () => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: f.port, path: '/api/v1/events',
      headers: { Authorization: `Bearer ${f.agents[1].credential}` } }, res => {
      attempts++;
      res.on('error', () => {});
      res.on('close', resolve);
      res.resume();
    });
    req.on('error', reject);
  });
  await request(); await request();
  assert.equal(attempts, 2);
  assert.equal((await f.request('/api/v1/me')).status, 200);
});

test('multiple contacts heartbeat and delayed publish each enter clock guard once', async t => {
  let observations = 0;
  const pending = new Set();
  const timers = { setTimeout(fn, ms) { const ticket = { fn, ms, unref() {} }; pending.add(ticket); return ticket; },
    clearTimeout(ticket) { pending.delete(ticket); } };
  const f = await fixture(t, { extraContact: true, observeClock: () => observations++, trustedTimers: timers,
    eventsOptions: { heartbeatMs: 100, idleMs: 200 } });
  const receiver = await f.stream(1);
  const before = observations;
  const heartbeat = [...pending].find(ticket => ticket.ms === 100);
  pending.delete(heartbeat); heartbeat.fn();
  assert.equal(observations - before, 1);
  f.im.modules.events.publish(f.agents[1].agentId, f.agents[0].agentId);
  const count = observations;
  const delivery = [...pending].find(ticket => ticket.ms === 0);
  pending.delete(delivery); delivery.fn();
  assert.equal(observations - count, 1);
  if (!receiver.text.includes('data: sync')) await receiver.wait();
  assert.match(receiver.text, /data: sync/);
  receiver.close();
});

test('over 1000 contacts returns safe 429 without SSE, timers or occupied HTTP slot', async t => {
  const pending = new Set();
  const timers = { setTimeout(fn, ms) {
    const ticket = { fn, ms, unref() {} }; pending.add(ticket); return ticket;
  }, clearTimeout(ticket) { pending.delete(ticket); } };
  const f = await fixture(t, { manyContacts: true, maxConnections: 1, trustedTimers: timers });
  const response = await f.request('/api/v1/events', { agent: 1 });
  assert.equal(response.status, 429);
  assert.equal(response.json.error.code, 'RATE_LIMITED');
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.text.includes('ReferenceError'), false);
  assert.equal(response.text.includes('ImError'), false);
  assert.equal(response.text.includes('STORAGE_UNAVAILABLE'), false);
  assert.equal(pending.size, 0);
  assert.equal((await f.request('/api/v1/me', { agent: 0 })).status, 200);
  assert.equal(pending.size, 0);
});
