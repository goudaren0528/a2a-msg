import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseImConfig } from '../src/im/config.js';
import { migrateImSchema } from '../src/im/schema.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImAuth } from '../src/im/auth.js';
import { createImAcl } from '../src/im/acl.js';
import { createImMessages } from '../src/im/messages.js';
import { createImDelivery } from '../src/im/delivery.js';
import { PROTOCOL } from '../src/im/contracts.js';
import { fingerprintMessage } from '../src/im/contracts.js';
import { planImRetention } from '../src/im/retention.js';

const retention = { version: 1, enabled: true, writeMode: 'enabled', safeRetryWindowMs: 100,
  attachmentRetentionMs: 200, messageRetentionMs: 300, idempotencyRetentionMs: 400 };
const config = { enabled: true, writeMode: 'enabled', transport: { mode: 'local-test', serverUrl: 'http://localhost/' },
  lease: { ttlMs: 1000, renewalMs: 500 }, retention: { policy: {
    safeRetryWindowMs: 100, attachmentRetentionMs: 200, messageRetentionMs: 300, idempotencyRetentionMs: 400,
  } } };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'im-retention-'));
  const file = join(dir, 'state.sqlite');
  const db = new DatabaseSync(file);
  const extraConnections = [];
  t.after(() => { for (const connection of extraConnections) connection.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL'); migrateImSchema(db);
  let now = 1000; const clock = () => now;
  const context = {}; const admin = createImAdmin({ db, clock, authorizeAdmin: c => c === context });
  const auth = createImAuth({ db, clock }); const acl = createImAcl({ db, auth, clock });
  const agent = () => { const { agentId } = admin.registerAgent({ displayName: 'agent' }, context);
    const issued = admin.issueCredential({ agentId, expiresAt: null }, context);
    return { agentId, principal: auth.authenticate(issued.credential) }; };
  const a = agent(), b = agent(); admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: true, reason: 'test' }, context);
  db.exec("UPDATE im_settings SET write_mode='enabled'");
  const messages = createImMessages({ db, auth, acl, clock, policy: config });
  const delivery = createImDelivery({ db, auth, acl, clock, policy: config });
  const conversationId = messages.ensureConversation(a.principal, { peerAgentId: b.agentId }).conversationId;
  const fence = delivery.acquire(b.principal, { instanceId: randomUUID(), requestId: randomUUID() });
  const send = (attachment = false, overrides = {}) => {
    const bytes = Buffer.from('blob');
    return messages.send(a.principal, { protocol: PROTOCOL, conversationId, recipientAgentId: b.agentId,
      clientMessageId: randomUUID(), text: 'hello', ...(attachment ? { attachment: { name: 'blob',
        sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') } } : {}), ...overrides });
  };
  const plan = (policy = retention, more = {}) => planImRetention({ db, policy, clock, ...more });
  return { db, file, extraConnections, a, b, send, plan, ack: (...items) => delivery.ack(b.principal, { instanceId: fence.instanceId,
    generation: fence.generation, messageIds: items.map(item => item.messageId) }), setNow: n => { now = n; } };
}

test('missing/partial/invalid/disabled policies fail closed', t => {
  const f = fixture(t); const m = f.send(true); f.ack(m); f.setNow(1500);
  const invalid = [undefined, {}, { ...retention, messageRetentionMs: undefined },
    { ...retention, attachmentRetentionMs: 301 }, { ...retention, safeRetryWindowMs: -1 },
    { ...retention, safeRetryWindowMs: Number.MAX_SAFE_INTEGER + 1 }, { ...retention, extra: true },
    { ...retention, version: 2 }, { ...retention, enabled: false }, { ...retention, writeMode: 'paused' }];
  for (const policy of invalid) { const report = policy === undefined ? planImRetention({ db: f.db }) : f.plan(policy);
    assert.equal(report.valid, false); assert.deepEqual(report.candidates, []); }
});

test('retry deadline, TTL, missing ACK, out-of-order ACK and continuous prefix', t => {
  const f = fixture(t); const one = f.send(true), two = f.send();
  f.ack(two); f.setNow(1500);
  let report = f.plan();
  assert.equal(report.subjects.find(s => s.agentId === f.b.agentId).proposedFloor, 1);
  assert.deepEqual(report.candidates, []);
  assert.equal(report.subjects.find(s => s.agentId === f.b.agentId).holds[0].reason, 'NOT_CONTIGUOUSLY_ACKED');
  f.ack(one);
  report = f.plan(); assert.equal(report.subjects.find(s => s.agentId === f.b.agentId).proposedFloor, 3);
  assert.deepEqual(report.candidates.map(c => c.kind).sort(), ['attachment', 'delivery', 'delivery', 'message', 'message']);
  assert.equal(report.totals.count, 5);
});

test('TTL expiry alone cannot overcome original retry_until', t => {
  const f = fixture(t); const m = f.send(true); f.ack(m);
  // Simulate an originally negotiated later deadline; never recompute it from current policy.
  f.db.prepare('UPDATE im_send_keys SET retry_until=? WHERE message_id=?').run(2000, m.messageId);
  f.setNow(1500);
  assert.deepEqual(f.plan().candidates, []);
  assert.equal(f.plan().subjects.find(s => s.agentId === f.b.agentId).holds[0].reason, 'RETRY_WINDOW');
});

test('unsafe clock and forward jump stop planning', t => {
  const f = fixture(t); const m = f.send(); f.ack(m);
  f.setNow(999); assert.equal(f.plan().reason, 'CLOCK_UNSAFE');
  f.setNow(1500); assert.equal(f.plan(retention, { timeGuard: () => false }).reason, 'CLOCK_UNSAFE');
  const jump = f.plan(retention, { limits: { maxForwardJumpMs: 100 } });
  assert.deepEqual(jump.candidates, []); assert.deepEqual(jump.protections, ['FORWARD_CLOCK_JUMP']);
});

test('only permitted row kinds; planner works on read-only connection without any writes', t => {
  const f = fixture(t); const m = f.send(true); f.ack(m);
  f.db.prepare(`INSERT INTO im_migration_runs(run_id,preview_hash,status,actor_id,created_at) VALUES (?,?,'previewed','admin',1000)`)
    .run(randomUUID(), 'a'.repeat(64));
  f.setNow(1500);
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'im_%' ORDER BY name").all().map(r => r.name);
  const snapshot = () => tables.map(name => [name, f.db.prepare(`SELECT * FROM ${name}`).all()]);
  const before = snapshot();
  const readonly = new DatabaseSync(f.file, { readOnly: true });
  f.extraConnections.push(readonly);
  readonly.exec('PRAGMA foreign_keys=ON');
  const plan = (more = {}) => planImRetention({ db: readonly, policy: retention, clock: () => 1500, ...more });
  const report = plan({ limits: { maxRows: 2, maxBytes: 100 } });
  assert.equal(report.valid, true); assert.equal(report.totals.batches.length, 1);
  assert.equal(report.totals.batches[0].oversized, true);
  assert.deepEqual(new Set(report.candidates.map(c => c.kind)), new Set(['message', 'attachment', 'delivery']));
  assert.equal(plan({ policy: {} }).valid, false);
  assert.equal(plan({ clock: () => { throw Error('clock'); } }).valid, false);
  assert.equal(plan({ timeGuard: () => false }).reason, 'CLOCK_UNSAFE');
  assert.equal(plan({ timeGuard: () => { throw Error('guard'); } }).valid, false);
  assert.equal(plan({ limits: { maxCandidates: 2 } }).reason, 'CANDIDATE_LIMIT');
  assert.equal(plan({ limits: { maxScanRows: 1 } }).reason, 'SCAN_ROW_LIMIT');
  readonly.prepare('SELECT 1').get();
  assert.deepEqual(snapshot(), before);
});

test('strict policy duration matrix and ordering', t => {
  const f = fixture(t);
  for (const field of ['safeRetryWindowMs', 'attachmentRetentionMs', 'messageRetentionMs', 'idempotencyRetentionMs']) {
    for (const value of [undefined, 0, -1, 1.5, NaN, Infinity, '200', Number.MAX_SAFE_INTEGER + 1]) {
      const policy = { ...retention, [field]: value };
      assert.equal(f.plan(policy).valid, false, `${field}:${value}`);
    }
    const missing = { ...retention }; delete missing[field]; assert.equal(f.plan(missing).valid, false);
  }
  for (const policy of [null, [], { ...retention, extra: 1 }, { ...retention, version: 5 },
    { ...retention, safeRetryWindowMs: 201 }, { ...retention, attachmentRetentionMs: 301 },
    { ...retention, messageRetentionMs: 401 }, parseImConfig({})]) assert.equal(f.plan(policy).valid, false);
  assert.equal(f.plan({ ...retention, safeRetryWindowMs: 1, attachmentRetentionMs: 1,
    messageRetentionMs: 1, idempotencyRetentionMs: 1 }).valid, true);
});

test('material fingerprints and persisted retry boundaries', t => {
  const f = fixture(t); const m = f.send(true); f.ack(m); f.setNow(1500);
  assert.equal(f.plan().valid, true);
  f.db.prepare('DELETE FROM im_attachments WHERE message_id=?').run(m.messageId);
  assert.equal(f.plan().reason, 'MATERIAL_UNVERIFIED');
  const bytes = Buffer.from('blob');
  f.db.prepare(`INSERT INTO im_attachments(attachment_id,message_id,name,mime,size,sha256,data) VALUES (?,?,?,?,?,?,?)`)
    .run(randomUUID(), m.messageId, 'blob', null, 4, createHash('sha256').update(bytes).digest('hex'), bytes);
  assert.equal(f.plan().valid, true);
  f.db.prepare('UPDATE im_send_keys SET client_message_id=? WHERE message_id=?').run(randomUUID(), m.messageId);
  assert.equal(f.plan().reason, 'MATERIAL_UNVERIFIED');
  f.db.prepare('DELETE FROM im_send_keys WHERE message_id=?').run(m.messageId);
  assert.equal(f.plan().reason, 'MATERIAL_UNVERIFIED');
});

test('original retry deadline independent of later policy and exact boundary', t => {
  const f = fixture(t); const m = f.send(); f.ack(m);
  const longer = { ...retention, safeRetryWindowMs: 300, attachmentRetentionMs: 300 };
  for (const [now, reason] of [[1099, 'RETRY_WINDOW'], [1100, 'RETRY_WINDOW'], [1101, 'MESSAGE_TTL']]) {
    f.setNow(now); assert.equal(f.plan(longer).subjects.find(s => s.agentId === f.b.agentId).holds[0].reason, reason);
  }
  f.setNow(1500); assert.equal(f.plan(longer).valid, true);
});

test('scan/candidate absolute caps, groups and UTF-8 bytes', t => {
  const f = fixture(t); const first = f.send(true), second = f.send(); f.ack(first, second); f.setNow(1500);
  assert.equal(f.plan(retention, { limits: { maxScanRows: 1 } }).reason, 'SCAN_ROW_LIMIT');
  assert.equal(f.plan(retention, { limits: { maxScanBytes: 1 } }).reason, 'SCAN_BYTE_LIMIT');
  assert.equal(f.plan(retention, { limits: { maxCandidateBytes: 1 } }).reason, 'CANDIDATE_LIMIT');
  assert.equal(f.plan(retention, { limits: { maxCandidates: 5 } }).valid, true);
  assert.equal(f.plan(retention, { limits: { maxCandidates: 4 } }).reason, 'CANDIDATE_LIMIT');
  const report = f.plan(retention, { limits: { maxRows: 3, maxBytes: 100 } });
  assert.deepEqual(report.totals.batches.map(b => b.groups.map(g => g.count)), [[3], [2]]);
  assert.equal(report.totals.count, 5);
  assert.deepEqual(new Set(report.candidates.map(c => c.kind)), new Set(['delivery', 'message', 'attachment']));
  const unicode = fixture(t); const item = unicode.send(false, { text: '汉🙂', title: null }); unicode.ack(item); unicode.setNow(1500);
  assert.equal(unicode.plan().candidates.find(c => c.kind === 'message').sizeBytes, Buffer.byteLength('汉🙂'));
});

test('attachment-only valid and deep byte verification opt-in', t => {
  const f = fixture(t); const bytes = Buffer.from('blob');
  const item = f.send(false, { text: '', title: null, attachment: { name: 'blob',
    sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') } });
  f.ack(item); f.setNow(1500);
  assert.equal(f.plan().valid, true);
  assert.equal(f.plan(retention, { limits: { deepVerifyBytes: true } }).valid, true);
  f.db.prepare('UPDATE im_attachments SET data=? WHERE message_id=?').run(Buffer.from('xxxx'), item.messageId);
  assert.equal(f.plan().valid, true);
  assert.equal(f.plan(retention, { limits: { deepVerifyBytes: true } }).reason, 'MATERIAL_UNVERIFIED');
});

test('gaps, cursor corruption, orphan delivery, and pre-existing retained prefix fail closed', t => {
  const f = fixture(t); const one = f.send(), two = f.send(); f.ack(one, two); f.setNow(1500);
  f.db.prepare('UPDATE im_receive_state SET retained_floor=2 WHERE agent_id=?').run(f.b.agentId);
  assert.equal(f.plan().subjects.find(s => s.agentId === f.b.agentId).proposedFloor, 3);
  f.db.prepare('UPDATE im_receive_state SET retained_floor=3 WHERE agent_id=?').run(f.b.agentId);
  assert.equal(f.plan().subjects.find(s => s.agentId === f.b.agentId).proposedFloor, 3);
  f.db.prepare('UPDATE im_receive_state SET retained_floor=2,acked_through=0 WHERE agent_id=?').run(f.b.agentId);
  assert.equal(f.plan().reason, 'CURSOR_INVARIANT');
  f.db.prepare('UPDATE im_receive_state SET retained_floor=1,acked_through=2 WHERE agent_id=?').run(f.b.agentId);
  f.db.prepare('DELETE FROM im_deliveries WHERE message_id=?').run(one.messageId);
  assert.equal(f.plan().reason, 'DELIVERY_GAP');
});

test('empty stream, missing tail, absent state and recipient mismatch', t => {
  const f = fixture(t); f.setNow(1500);
  assert.equal(f.plan().valid, true);
  const first = f.send(), second = f.send(); f.ack(first, second);
  f.db.prepare('DELETE FROM im_deliveries WHERE message_id=?').run(second.messageId);
  assert.equal(f.plan().reason, 'DELIVERY_GAP');
  f.db.prepare('DELETE FROM im_receive_state WHERE agent_id=?').run(f.b.agentId);
  assert.equal(f.plan().reason, 'ORPHAN_DELIVERY');
});

test('pre-existing transaction is refused without changing caller transaction', t => {
  const f = fixture(t); f.db.exec('BEGIN');
  try { assert.equal(f.plan().reason, 'INVALID_INPUT'); assert.equal(f.db.isTransaction, true); }
  finally { f.db.exec('ROLLBACK'); }
});

test('scan caps reject before projecting body or BLOB, including read-only state cap', t => {
  const f = fixture(t); const item = f.send(true); f.ack(item); f.setNow(1500);
  let projected = 0;
  const db = { get isTransaction() { return f.db.isTransaction; }, exec: sql => f.db.exec(sql),
    prepare(sql) {
      if (/m\.title,m\.text|SELECT data FROM im_attachments/.test(sql)) projected++;
      return f.db.prepare(sql);
    } };
  const check = limits => {
    const result = planImRetention({ db, policy: retention, clock: () => 1500, limits });
    assert.equal(result.complete, false);
    assert.deepEqual(result.candidates, []);
    if (result.reason !== 'CANDIDATE_LIMIT') assert.equal(projected, 0);
    assert.equal(f.db.isTransaction, false);
    return result;
  };
  assert.equal(check({ maxScanBytes: 1, deepVerifyBytes: true }).reason, 'SCAN_BYTE_LIMIT');
  assert.equal(check({ maxScanRows: 1, deepVerifyBytes: true }).reason, 'SCAN_ROW_LIMIT');
  assert.equal(check({ maxForwardJumpMs: 1 }).reason, 'FORWARD_CLOCK_JUMP');
  assert.equal(check({ maxCandidates: 1 }).reason, 'CANDIDATE_LIMIT');
  assert.equal(projected, 1); // Candidate limit necessarily projects the one permitted row.
});

test('sender, timestamp, message and attachment metadata tampering fails closed', t => {
  for (const [table, column, value] of [
    ['im_send_keys', 'sender_id', 'attacker'], ['im_send_keys', 'created_at', 999],
    ['im_messages', 'text', 'changed'], ['im_messages', 'title', 'changed'],
    ['im_attachments', 'sha256', 'f'.repeat(64)],
  ]) {
    const f = fixture(t); const item = f.send(true); f.ack(item); f.setNow(1500);
    if (column === 'sender_id') {
      // FK-compliant wrong sender; all agents already exist in this fixture.
      f.db.prepare('UPDATE im_send_keys SET sender_id=? WHERE message_id=?').run(f.b.agentId, item.messageId);
    } else f.db.prepare(`UPDATE ${table} SET ${column}=? WHERE message_id=?`).run(value, item.messageId);
    assert.equal(f.plan().reason, 'MATERIAL_UNVERIFIED', `${table}.${column}`);
    assert.equal(f.db.isTransaction, false);
  }
});

test('middle gap, sequence at nextSeq, and blocked earlier retry never cross prefix', t => {
  const f = fixture(t); const a = f.send(), b = f.send(), c = f.send(); f.ack(a, b, c); f.setNow(1500);
  f.db.prepare('UPDATE im_send_keys SET retry_until=2000 WHERE message_id=?').run(a.messageId);
  const blocked = f.plan().subjects.find(s => s.agentId === f.b.agentId);
  assert.equal(blocked.proposedFloor, 1);
  assert.equal(blocked.holds[0].reason, 'RETRY_WINDOW');
  assert.equal(blocked.holds[1].reason, 'EARLIER_HOLD');
  f.db.prepare('DELETE FROM im_deliveries WHERE message_id=?').run(b.messageId);
  assert.equal(f.plan().reason, 'DELIVERY_GAP');
  f.db.prepare('UPDATE im_receive_state SET next_seq=3,acked_through=2 WHERE agent_id=?').run(f.b.agentId);
  assert.equal(f.plan().reason, 'DELIVERY_GAP');
});

test('recipient mismatch cannot turn LEFT JOIN absence into a candidate', t => {
  const f = fixture(t); const item = f.send(); f.ack(item); f.setNow(1500);
  f.db.prepare('UPDATE im_deliveries SET recipient_id=? WHERE message_id=?').run(f.a.agentId, item.messageId);
  const report = f.plan();
  assert.equal(report.valid, false);
  assert.deepEqual(report.candidates, []);
  assert.equal(f.db.isTransaction, false);
});

test('clock and schema exceptions always end snapshot', t => {
  const f = fixture(t); const item = f.send(); f.ack(item);
  assert.equal(f.plan(retention, { clock: () => { throw Error('clock'); } }).reason, 'STORAGE_OR_CLOCK_UNAVAILABLE');
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.plan(retention, { timeGuard: () => { throw Error('guard'); } }).reason, 'STORAGE_OR_CLOCK_UNAVAILABLE');
  assert.equal(f.db.isTransaction, false);
  f.db.prepare('UPDATE im_schema SET migration_checksum=?').run('0'.repeat(64));
  assert.equal(f.plan().reason, 'STORAGE_OR_CLOCK_UNAVAILABLE');
  assert.equal(f.db.isTransaction, false);
});

test('WAL snapshot survives second connection send/ACK during first connection clock callback', t => {
  const f = fixture(t); f.db.exec('PRAGMA journal_mode=WAL');
  const first = f.send(); f.ack(first);
  const writer = new DatabaseSync(f.file); f.extraConnections.push(writer);
  writer.exec('PRAGMA foreign_keys=ON');
  let injected = false;
  const report = planImRetention({ db: f.db, policy: retention, clock: () => {
    if (!injected) {
      injected = true;
      // Execute a genuine concurrent transaction after assertImSchema established the reader snapshot.
      writer.exec('BEGIN IMMEDIATE');
      try {
        const id = randomUUID(), client = randomUUID(), recipient = f.b.agentId, sender = f.a.agentId;
        const original = writer.prepare('SELECT * FROM im_messages WHERE message_id=?').get(first.messageId);
        writer.prepare(`INSERT INTO im_messages(message_id,conversation_id,sender_id,recipient_id,client_message_id,title,text,in_reply_to,correlation,accepted_at)
          VALUES (?,?,?,?,?,NULL,'next',NULL,NULL,1000)`).run(id, original.conversation_id, sender, recipient, client);
        const hash = fingerprintMessage({ protocol: PROTOCOL, conversationId: original.conversation_id,
          recipientAgentId: recipient, clientMessageId: client, title: null, text: 'next', attachment: null,
          inReplyTo: null, correlation: null });
        writer.prepare("INSERT INTO im_send_keys(sender_id,client_message_id,payload_hash,message_id,created_at,retry_until,status) VALUES (?,?,?,?,1000,1100,'live')")
          .run(sender, client, hash, id);
        writer.prepare('INSERT INTO im_deliveries(recipient_id,seq,message_id,acked_at) VALUES (?,?,?,1000)').run(recipient, 2, id);
        writer.prepare('UPDATE im_receive_state SET next_seq=3,acked_through=2 WHERE agent_id=?').run(recipient);
        writer.exec('COMMIT');
      } catch (error) { writer.exec('ROLLBACK'); throw error; }
    }
    return 1500;
  } });
  assert.equal(report.valid, true);
  assert.equal(report.totals.count, 2);
  assert.equal(f.db.isTransaction, false);
});

test('async callbacks rejected without invoking rejected promises', async t => {
  const f = fixture(t); let unhandled = false;
  const handler = () => { unhandled = true; }; process.on('unhandledRejection', handler);
  try {
    assert.equal(f.plan(retention, { clock: async () => { throw Error('async'); } }).reason, 'INVALID_INPUT');
    assert.equal(f.plan(retention, { timeGuard: async () => { throw Error('async'); } }).reason, 'INVALID_INPUT');
    await new Promise(resolve => setImmediate(resolve)); assert.equal(unhandled, false);
  } finally { process.off('unhandledRejection', handler); }
});
