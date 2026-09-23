import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { migrateImSchema } from '../src/im/schema.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImAuth } from '../src/im/auth.js';
import { createImAcl } from '../src/im/acl.js';
import { createImDelivery } from '../src/im/delivery.js';

const policy = { enabled: true, writeMode: 'enabled', transport: { mode: 'local-test', serverUrl: 'http://localhost/' },
  lease: { ttlMs: 90, renewalMs: 30 }, retention: { policy: { messageRetentionMs: 1000,
    attachmentRetentionMs: 500, idempotencyRetentionMs: 2000, safeRetryWindowMs: 1000 } } };
const code = expected => error => error.code === expected;
function fixture(path = ':memory:') {
  const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON'); migrateImSchema(db);
  let now = 1000; const clock = () => now;
  const trusted = Object.freeze({ secret: Symbol('test admin') });
  const admin = createImAdmin({ db, clock, authorizeAdmin: context => context === trusted });
  const auth = createImAuth({ db, clock }); const acl = createImAcl({ db, auth, clock });
  db.prepare("UPDATE im_settings SET write_mode='enabled' WHERE singleton=1").run();
  const delivery = createImDelivery({ db, auth, acl, clock, policy });
  function agent() {
    const a = admin.registerAgent({ displayName: 'Agent' }, trusted);
    const credential = admin.issueCredential({ agentId: a.agentId, expiresAt: null }, trusted);
    return { ...a, ...credential, principal: auth.authenticate(credential.credential) };
  }
  return { db, clock, admin, auth, acl, trusted, delivery, agent, setNow: value => { now = value; } };
}
function seed(f, sender, recipient, { bytes = false } = {}) {
  const conversationId = randomUUID(), messageId = randomUUID();
  f.admin.setContact({ agentA: sender.agentId, agentB: recipient.agentId, allowed: true, reason: 'test' }, f.trusted);
  const [low, high] = [sender.agentId, recipient.agentId].sort();
  f.db.prepare('INSERT INTO im_conversations(conversation_id,agent_low,agent_high,created_at) VALUES (?,?,?,?)')
    .run(conversationId, low, high, 1000);
  const insert = f.db.prepare(`INSERT INTO im_messages(message_id,conversation_id,sender_id,recipient_id,client_message_id,text,accepted_at)
    VALUES (?,?,?,?,?,?,?)`);
  const append = (id = randomUUID()) => {
    insert.run(id, conversationId, sender.agentId, recipient.agentId, randomUUID(), 'hello', 1000);
    const state = f.db.prepare('SELECT next_seq FROM im_receive_state WHERE agent_id=?').get(recipient.agentId);
    f.db.prepare('INSERT INTO im_deliveries(recipient_id,seq,message_id) VALUES (?,?,?)').run(recipient.agentId, state.next_seq, id);
    f.db.prepare('UPDATE im_receive_state SET next_seq=next_seq+1 WHERE agent_id=?').run(recipient.agentId);
    return id;
  };
  append(messageId);
  if (bytes) {
    const data = Buffer.from('private attachment bytes');
    f.db.prepare('INSERT INTO im_attachments(attachment_id,message_id,name,mime,size,sha256,data) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), messageId, 'a.txt', 'text/plain', data.length, createHash('sha256').update(data).digest('hex'), data);
  }
  return { messageId, append };
}

test('lease replay, single receiver, credential scope, expiry, renewal, restart and takeover', () => {
  const f = fixture(); const a = f.agent(), instanceId = randomUUID(), requestId = randomUUID();
  const lease = f.delivery.acquire(a.principal, { instanceId, requestId });
  assert.deepEqual(lease, { instanceId, generation: 1, expiresAt: 1090, historical: false });
  f.setNow(1010);
  assert.deepEqual(f.delivery.acquire(a.principal, { instanceId, requestId }), { ...lease, historical: true });
  assert.throws(() => f.delivery.acquire(a.principal, { instanceId, requestId: randomUUID() }), code('LEASE_CONFLICT'));
  assert.throws(() => f.delivery.acquire(a.principal, { instanceId: randomUUID(), requestId }), code('IDEMPOTENCY_CONFLICT'));
  const other = f.admin.issueCredential({ agentId: a.agentId, expiresAt: null }, f.trusted);
  const pOther = f.auth.authenticate(other.credential);
  assert.throws(() => f.delivery.acquire(pOther, { instanceId, requestId }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => f.delivery.renew(pOther, { instanceId, generation: 1 }), code('STALE_FENCE'));
  assert.deepEqual(f.delivery.renew(a.principal, { instanceId, generation: 1 }).expiresAt, 1100);
  const restarted = createImDelivery({ db: f.db, auth: f.auth, acl: f.acl, clock: f.clock, policy });
  assert.deepEqual(restarted.acquire(a.principal, { instanceId, requestId }), { ...lease, historical: true });
  f.admin.takeoverReceiver({ agentId: a.agentId, reason: 'test' }, f.trusted);
  assert.deepEqual(restarted.acquire(a.principal, { instanceId, requestId }), { ...lease, historical: true });
  assert.throws(() => f.delivery.renew(a.principal, { instanceId, generation: 1 }), code('STALE_FENCE'));
  const next = restarted.acquire(pOther, { instanceId: randomUUID(), requestId: randomUUID() });
  assert.equal(next.generation, 3);
  f.admin.revokeCredential({ credentialId: other.credentialId, reason: 'rotate' }, f.trusted);
  assert.throws(() => f.delivery.sync(pOther, { instanceId: next.instanceId, generation: 3 }), code('INVALID_CREDENTIAL'));
  assert.throws(() => f.delivery.acquire(a.principal, { instanceId: randomUUID(), requestId: randomUUID() }), code('LEASE_CONFLICT'));
  f.setNow(next.expiresAt);
  assert.deepEqual(restarted.acquire(a.principal, { instanceId, requestId }), { ...lease, historical: true });
  assert.throws(() => restarted.renew(a.principal, { instanceId: next.instanceId, generation: 3 }), code('STALE_FENCE'));
  assert.equal(restarted.acquire(a.principal, { instanceId: randomUUID(), requestId: randomUUID() }).generation, 4);
  f.db.close();
});

test('released and expired acquisition replay remains historical and never restores old fence', () => {
  const f = fixture(); const a = f.agent(); const instanceId = randomUUID(), requestId = randomUUID();
  const first = f.delivery.acquire(a.principal, { instanceId, requestId });
  f.delivery.release(a.principal, { instanceId, generation: first.generation });
  assert.deepEqual(f.delivery.acquire(a.principal, { instanceId, requestId }), { ...first, historical: true });
  assert.throws(() => f.delivery.renew(a.principal, { instanceId, generation: first.generation }), code('LEASE_EXPIRED'));
  const second = f.delivery.acquire(a.principal, { instanceId: randomUUID(), requestId: randomUUID() });
  f.setNow(second.expiresAt);
  assert.deepEqual(f.delivery.acquire(a.principal, { instanceId: second.instanceId, requestId: randomUUID() }).historical, false);
  assert.deepEqual(f.delivery.acquire(a.principal, { instanceId, requestId }), { ...first, historical: true });
  assert.throws(() => f.delivery.renew(a.principal, { instanceId, generation: first.generation }), code('STALE_FENCE'));
  f.db.close();
});

test('closed/reopened file database keeps lease generation and historical replay across factory reconstruction', () => {
  const directory = mkdtempSync(join(tmpdir(), 'im-delivery-reopen-'));
  try {
    const file = join(directory, 'state.sqlite');
    const f = fixture(file), a = f.agent();
    const instanceId = randomUUID(), requestId = randomUUID();
    const first = f.delivery.acquire(a.principal, { instanceId, requestId });
    f.db.close();
    const db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON');
    const clock = () => 1090;
    const auth = createImAuth({ db, clock });
    const acl = createImAcl({ db, auth, clock });
    const reopened = createImDelivery({ db, auth, acl, clock, policy });
    const principal = auth.authenticate(a.credential);
    assert.deepEqual(reopened.acquire(principal, { instanceId, requestId }), { ...first, historical: true });
    assert.equal(reopened.acquire(principal, { instanceId: randomUUID(), requestId: randomUUID() }).generation, 2);
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('sync rejects middle and tail stream gaps without exposing partial pages or advancing state', () => {
  const f = fixture(), a = f.agent(), b = f.agent();
  const { instanceId, generation } = f.delivery.acquire(b.principal, { instanceId: randomUUID(), requestId: randomUUID() });
  const fence = { instanceId, generation };
  assert.deepEqual(f.delivery.sync(b.principal, fence).items, []);
  assert.equal(f.delivery.sync(b.principal, fence).hasMore, false);
  const { append } = seed(f, a, b); const middle = append(), tail = append();
  const epoch = f.db.prepare('SELECT stream_epoch FROM im_receive_state WHERE agent_id=?').get(b.agentId).stream_epoch;
  const before = f.db.prepare('SELECT acked_through FROM im_receive_state WHERE agent_id=?').get(b.agentId).acked_through;
  assert.deepEqual(f.delivery.sync(b.principal, { ...fence, limit: 1 }).items.map(item => item.seq), [1]);
  assert.equal(f.delivery.sync(b.principal, { ...fence, limit: 1 }).hasMore, true);
  f.db.prepare('DELETE FROM im_deliveries WHERE message_id=?').run(middle);
  assert.throws(() => f.delivery.sync(b.principal, { ...fence, limit: 1 }), code('STORAGE_UNAVAILABLE'));
  assert.throws(() => f.delivery.sync(b.principal, fence), code('STORAGE_UNAVAILABLE'));
  assert.equal(f.db.prepare('SELECT acked_through FROM im_receive_state WHERE agent_id=?').get(b.agentId).acked_through, before);
  assert.throws(() => f.delivery.sync(b.principal, { ...fence, streamEpoch: randomUUID() }), code('CURSOR_RESET_REQUIRED'));
  f.db.prepare('INSERT INTO im_deliveries(recipient_id,seq,message_id) VALUES (?,?,?)').run(b.agentId, 2, middle);
  f.db.prepare('DELETE FROM im_deliveries WHERE message_id=?').run(tail);
  assert.throws(() => f.delivery.sync(b.principal, { ...fence, limit: 2 }), code('STORAGE_UNAVAILABLE'));
  assert.throws(() => f.delivery.sync(b.principal, fence), code('STORAGE_UNAVAILABLE'));
  f.db.prepare('INSERT INTO im_deliveries(recipient_id,seq,message_id) VALUES (?,?,?)').run(b.agentId, 3, tail);
  const first = f.delivery.sync(b.principal, { ...fence, limit: 1, streamEpoch: epoch });
  assert.deepEqual(first.items.map(item => item.seq), [1]); assert.equal(first.hasMore, true);
  assert.deepEqual(f.delivery.sync(b.principal, { ...fence, limit: 2 }).items.map(item => item.seq), [1, 2]);
  assert.equal(f.delivery.sync(b.principal, { ...fence, limit: 2 }).hasMore, true);
  const end = f.delivery.sync(b.principal, { ...fence, limit: 3 });
  assert.deepEqual(end.items.map(item => item.seq), [1, 2, 3]); assert.equal(end.hasMore, false);
  f.delivery.ack(b.principal, { ...fence, messageIds: end.items.map(item => item.message.messageId) });
  const empty = f.delivery.sync(b.principal, fence);
  assert.deepEqual(empty.items, []); assert.equal(empty.pageAfter, 3); assert.equal(empty.hasMore, false);
  f.db.prepare('UPDATE im_receive_state SET retained_floor=3 WHERE agent_id=?').run(b.agentId);
  assert.deepEqual(f.delivery.sync(b.principal, { ...fence, after: 2 }).items.map(item => item.seq), [3]);
  assert.throws(() => f.delivery.sync(b.principal, { ...fence, after: 1 }), code('CURSOR_RESET_REQUIRED'));
  f.db.close();
});

test('sync paging, durable holes, idempotent ACK, ownership, ACL block, cursor and no bytes/read side effects', () => {
  const f = fixture(); const a = f.agent(), b = f.agent(), c = f.agent();
  const { messageId: first, append } = seed(f, a, b, { bytes: true });
  const second = append(), third = append();
  const { instanceId, generation } = f.delivery.acquire(b.principal, { instanceId: randomUUID(), requestId: randomUUID() });
  const fence = { instanceId, generation };
  const page = f.delivery.sync(b.principal, { ...fence, limit: 1 });
  assert.equal(page.items.length, 1); assert.equal(page.pageAfter, 1); assert.equal(page.hasMore, true);
  assert.equal(page.items[0].message.attachment.size, Buffer.byteLength('private attachment bytes'));
  assert.ok(!JSON.stringify(page).includes('private attachment bytes'));
  assert.equal(f.db.prepare('SELECT read_at FROM im_deliveries WHERE message_id=?').get(first).read_at, null);
  assert.throws(() => f.delivery.sync(b.principal, { ...fence, after: 1 }), code('INVALID_REQUEST'));
  assert.deepEqual(f.delivery.ack(b.principal, { ...fence, messageIds: [third] }), { ackedThrough: 0 });
  assert.equal(f.delivery.sync(b.principal, fence).items.length, 3);
  assert.deepEqual(f.delivery.ack(b.principal, { ...fence, messageIds: [first] }), { ackedThrough: 1 });
  assert.deepEqual(f.delivery.ack(b.principal, { ...fence, messageIds: [third] }), { ackedThrough: 1 });
  assert.equal(f.delivery.ack(b.principal, { ...fence, messageIds: [second] }).ackedThrough, 3);
  assert.deepEqual(f.delivery.sync(b.principal, fence).items, []);
  assert.throws(() => f.delivery.sync(b.principal, { ...fence, streamEpoch: randomUUID() }), code('CURSOR_RESET_REQUIRED'));
  f.db.prepare('UPDATE im_receive_state SET retained_floor=3 WHERE agent_id=?').run(b.agentId);
  assert.throws(() => f.delivery.sync(b.principal, { ...fence, after: 1 }), code('CURSOR_RESET_REQUIRED'));
  const foreign = seed(f, a, c).messageId;
  const audits = f.db.prepare("SELECT COUNT(*) AS n FROM im_audit WHERE action='ack_delivery'").get().n;
  assert.throws(() => f.delivery.ack(b.principal, { ...fence, messageIds: [second, foreign] }), code('RESOURCE_NOT_FOUND'));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM im_audit WHERE action='ack_delivery'").get().n, audits);
  const fourth = append();
  f.admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: false, reason: 'test' }, f.trusted);
  assert.throws(() => f.delivery.sync(b.principal, fence), code('SYNC_BLOCKED'));
  assert.throws(() => f.delivery.ack(b.principal, { ...fence, messageIds: [fourth] }), code('RESOURCE_NOT_FOUND'));
  assert.equal(f.db.prepare('SELECT acked_at FROM im_deliveries WHERE message_id=?').get(fourth).acked_at, null);
  f.db.close();
});

test('validation, pauses, clock regressions and atomic audit failure', () => {
  const f = fixture(); const a = f.agent(), b = f.agent(); const { messageId } = seed(f, a, b);
  assert.throws(() => f.delivery.acquire({ ...b.principal }, { instanceId: randomUUID(), requestId: randomUUID() }), code('INVALID_CREDENTIAL'));
  assert.throws(() => f.delivery.acquire(b.principal, { instanceId: randomUUID(), requestId: randomUUID(), extra: 1 }), code('INVALID_REQUEST'));
  const lease = f.delivery.acquire(b.principal, { instanceId: randomUUID(), requestId: randomUUID() });
  const fence = { instanceId: lease.instanceId, generation: lease.generation };
  assert.throws(() => f.delivery.ack(b.principal, { ...fence, messageIds: [messageId, messageId] }), code('INVALID_REQUEST'));
  f.db.prepare("UPDATE im_settings SET write_mode='paused' WHERE singleton=1").run();
  assert.equal(f.delivery.sync(b.principal, fence).items.length, 1);
  for (const fn of [() => f.delivery.acquire(b.principal, { instanceId: randomUUID(), requestId: randomUUID() }),
    () => f.delivery.renew(b.principal, fence), () => f.delivery.release(b.principal, fence),
    () => f.delivery.ack(b.principal, { ...fence, messageIds: [messageId] })]) assert.throws(fn, code('NEW_WRITES_DISABLED'));
  f.db.prepare("UPDATE im_settings SET write_mode='enabled' WHERE singleton=1").run();
  f.db.exec("CREATE TRIGGER fail_ack_audit BEFORE INSERT ON im_audit WHEN NEW.action='ack_delivery' BEGIN SELECT RAISE(ABORT,'fail'); END");
  assert.throws(() => f.delivery.ack(b.principal, { ...fence, messageIds: [messageId] }));
  assert.equal(f.db.prepare('SELECT acked_at FROM im_deliveries WHERE message_id=?').get(messageId).acked_at, null);
  f.db.exec('DROP TRIGGER fail_ack_audit');
  f.setNow(999);
  assert.throws(() => f.delivery.sync(b.principal, fence), code('CLOCK_UNSAFE'));
  assert.throws(() => f.delivery.renew(b.principal, fence), code('CLOCK_UNSAFE'));
  f.db.close();
});

test('two separate processes contend on one SQLite receive lease: exactly one winner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'im-delivery-'));
  try {
    const file = join(directory, 'shared.sqlite'); const f = fixture(file); const a = f.agent(); f.db.close();
    const moduleUrl = new URL('../src/im/delivery.js', import.meta.url).href;
    const schemaUrl = new URL('../src/im/auth.js', import.meta.url).href;
    const aclUrl = new URL('../src/im/acl.js', import.meta.url).href;
    const worker = `import { DatabaseSync } from 'node:sqlite';
import { createImAuth } from ${JSON.stringify(schemaUrl)};
import { createImAcl } from ${JSON.stringify(aclUrl)};
import { createImDelivery } from ${JSON.stringify(moduleUrl)};
import { randomUUID } from 'node:crypto';
const [path,credential,config] = process.argv.slice(1);
const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
const clock = () => 1000; const auth = createImAuth({db,clock});
const service = createImDelivery({db,auth,acl:createImAcl({db,auth,clock}),clock,policy:JSON.parse(config)});
process.stdout.write('ready\\n');
process.stdin.once('data', () => { try { service.acquire(auth.authenticate(credential),{instanceId:randomUUID(),requestId:randomUUID()}); process.stdout.write('won\\n'); }
catch(error) { process.stdout.write(error.code + '\\n'); } db.close(); });`;
    const start = () => spawn(process.execPath, ['--input-type=module', '-e', worker, file, a.credential, JSON.stringify(policy)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const children = [start(), start()];
    const ready = new Set();
    const results = await Promise.all(children.map(child => new Promise((resolve, reject) => {
      let out = '', err = '';
      child.stdout.on('data', data => {
        out += data;
        if (out.includes('ready\n') && !ready.has(child)) {
          ready.add(child);
          if (ready.size === children.length) children.forEach(p => p.stdin.end('go'));
        }
      });
      child.stderr.on('data', data => { err += data; });
      child.on('error', reject); child.on('exit', exit => exit === 0 ? resolve(out) : reject(new Error(err)));
    })));
    assert.deepEqual(results.map(output => output.trim().split('\n').at(-1)).sort(), ['LEASE_CONFLICT', 'won']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
