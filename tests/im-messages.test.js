import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { migrateImSchema } from '../src/im/schema.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImAuth } from '../src/im/auth.js';
import { createImAcl } from '../src/im/acl.js';
import { createImMessages } from '../src/im/messages.js';
import { PROTOCOL } from '../src/im/contracts.js';
import { createImClockGuard } from '../src/im/clock-guard.js';

const policy = { enabled: true, writeMode: 'enabled', transport: { mode: 'local-test', serverUrl: 'http://localhost:8787' },
  retention: { policy: { messageRetentionMs: 100000, attachmentRetentionMs: 90000,
    idempotencyRetentionMs: 110000, safeRetryWindowMs: 1000 } }, lease: { ttlMs: 1000, renewalMs: 500 } };
const error = code => e => e.code === code;
function setup() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrateImSchema(db);
  let time = 10000; const clock = () => time;
  const ctx = {}; const admin = createImAdmin({ db, clock, authorizeAdmin: c => c === ctx });
  const auth = createImAuth({ db, clock }); const acl = createImAcl({ db, auth, clock });
  const persons = Array.from({ length: 3 }, (_, i) => {
    const agentId = admin.registerAgent({ displayName: `Agent ${i}` }, ctx).agentId;
    const issued = admin.issueCredential({ agentId, expiresAt: null }, ctx);
    return { agentId, credentialId: issued.credentialId, credential: issued.credential, principal: auth.authenticate(issued.credential) };
  });
  admin.setContact({ agentA: persons[0].agentId, agentB: persons[1].agentId, allowed: true, reason: 'test' }, ctx);
  db.exec("UPDATE im_settings SET write_mode='enabled'");
  const events = [];
  const service = createImMessages({ db, auth, acl, clock, policy, onCommitted: e => events.push(e) });
  const request = (conversationId, recipientAgentId, fields = {}) => ({ protocol: PROTOCOL, conversationId,
    recipientAgentId, clientMessageId: randomUUID(), text: 'hello', ...fields });
  return { db, admin, auth, acl, clock, ctx, persons, service, request, events, advance: n => { time += n; }, close: () => db.close() };
}

test('real principals and ACL, canonical conversation, strict input, history and revoke', () => {
  const f = setup(); try {
    const [a, b, outsider] = f.persons;
    assert.throws(() => f.service.listContacts({ ...a.principal }), error('INVALID_CREDENTIAL'));
    const conv = f.service.ensureConversation(a.principal, { peerAgentId: b.agentId });
    assert.equal(f.service.ensureConversation(b.principal, { peerAgentId: a.agentId }).conversationId, conv.conversationId);
    assert.equal(f.service.listContacts(a.principal).items.length, 1);
    assert.equal(f.service.listConversations(b.principal).items.length, 1);
    const sent = f.service.send(a.principal, f.request(conv.conversationId, b.agentId, { title: null }));
    assert.equal(sent.title, null); assert.equal(sent.deliveredAt, null);
    assert.equal(f.service.listHistory(b.principal, { conversationId: conv.conversationId }).items[0].messageId, sent.messageId);
    assert.throws(() => f.service.getMessage(outsider.principal, { messageId: sent.messageId }), error('RESOURCE_NOT_FOUND'));
    assert.throws(() => f.service.send(a.principal, f.request(conv.conversationId, b.agentId, { senderAgentId: outsider.agentId })), error('INVALID_REQUEST'));
    assert.throws(() => f.service.send(a.principal, f.request(conv.conversationId, b.agentId, { text: '', title: 'only title' })), error('INVALID_REQUEST'));
    assert.throws(() => f.service.markRead(a.principal, { messageId: sent.messageId }), error('RESOURCE_NOT_FOUND'));
    assert.throws(() => f.service.markRead(b.principal, { messageId: sent.messageId }), error('DELIVERY_REQUIRED'));
    f.db.prepare('UPDATE im_deliveries SET acked_at=? WHERE message_id=?').run(10000, sent.messageId); // messages-only ACK fixture
    assert.equal(f.service.markRead(b.principal, { messageId: sent.messageId }).changed, true);
    assert.equal(f.service.markRead(b.principal, { messageId: sent.messageId }).changed, false);
    f.admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: false, reason: 'test' }, f.ctx);
    assert.throws(() => f.service.getMessage(a.principal, { messageId: sent.messageId }), error('RESOURCE_NOT_FOUND'));
    assert.equal(f.service.listConversations(a.principal).items.length, 0);
  } finally { f.close(); }
});

test('attachment BLOB, idempotency conflict/expiry, paused lookup, callback failure', () => {
  const f = setup(); try {
    const [a, b, outsider] = f.persons;
    const conv = f.service.ensureConversation(a.principal, { peerAgentId: b.agentId });
    const bytes = Buffer.from('sample file');
    const raw = f.request(conv.conversationId, b.agentId, { text: '', attachment: { name: 'file.txt', mime: null,
      sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') } });
    const sent = f.service.send(a.principal, raw);
    assert.equal(f.service.getSendResult(a.principal, { clientMessageId: raw.clientMessageId }).messageId, sent.messageId);
    assert.equal(f.service.send(a.principal, raw).messageId, sent.messageId);
    assert.throws(() => f.service.send(a.principal, { ...raw, text: 'different' }), error('IDEMPOTENCY_CONFLICT'));
    assert.deepEqual(f.service.getAttachment(b.principal, { attachmentId: sent.attachment.attachmentId }).data, bytes);
    assert.throws(() => f.service.getAttachment(outsider.principal, { attachmentId: sent.attachment.attachmentId }), error('RESOURCE_NOT_FOUND'));
    f.db.exec("UPDATE im_settings SET write_mode='paused'");
    assert.equal(f.service.getSendResult(a.principal, { clientMessageId: raw.clientMessageId }).messageId, sent.messageId);
    assert.throws(() => f.service.send(a.principal, raw), error('NEW_WRITES_DISABLED'));
    f.db.exec("UPDATE im_settings SET write_mode='enabled'");
    f.advance(1000);
    assert.throws(() => f.service.send(a.principal, raw), error('IDEMPOTENCY_WINDOW_EXPIRED'));
    assert.throws(() => f.service.getSendResult(a.principal, { clientMessageId: raw.clientMessageId }), error('IDEMPOTENCY_WINDOW_EXPIRED'));
    f.db.prepare('UPDATE im_attachments SET data=? WHERE attachment_id=?').run(new Uint8Array(Buffer.from('sample filE')), sent.attachment.attachmentId);
    assert.throws(() => f.service.getAttachment(a.principal, { attachmentId: sent.attachment.attachmentId }), error('STORAGE_UNAVAILABLE'));
     const noisy = createImMessages({ db: f.db, auth: f.auth, acl: f.acl, clock: f.clock, policy, onCommitted: () => { throw Error('notify'); } });
    assert.ok(noisy.send(a.principal, f.request(conv.conversationId, b.agentId)).messageId);
  } finally { f.close(); }
});

test('pagination scope and deterministic keyset, cross conversation reply, rollback on every insert/audit failure', () => {
  const f = setup(); try {
    const [a, b, c] = f.persons;
    const id = f.service.ensureConversation(a.principal, { peerAgentId: b.agentId }).conversationId;
    f.admin.setContact({ agentA: a.agentId, agentB: c.agentId, allowed: true, reason: 'test' }, f.ctx);
    const other = f.service.ensureConversation(a.principal, { peerAgentId: c.agentId }).conversationId;
    const first = f.service.send(a.principal, f.request(id, b.agentId));
    assert.throws(() => f.service.send(a.principal, f.request(other, c.agentId, { inReplyTo: first.messageId })), error('RESOURCE_NOT_FOUND'));
    for (let i = 0; i < 4; i++) f.service.send(a.principal, f.request(id, b.agentId));
    const all = []; let after;
    do { const page = f.service.listHistory(a.principal, { conversationId: id, limit: 2, ...(after ? { after } : {}) });
      all.push(...page.items.map(m => m.messageId)); after = page.nextCursor;
    } while (after);
    assert.equal(new Set(all).size, 5);
    const page = f.service.listHistory(a.principal, { conversationId: id, limit: 1 });
    assert.throws(() => f.service.listHistory(b.principal, { conversationId: id, after: page.nextCursor }), error('INVALID_REQUEST'));
    assert.throws(() => f.service.listHistory(a.principal, { conversationId: other, after: page.nextCursor }), error('INVALID_REQUEST'));
    for (const table of ['im_messages', 'im_attachments', 'im_send_keys', 'im_deliveries', 'im_receive_state', 'im_audit']) {
      const before = f.db.prepare('SELECT next_seq FROM im_receive_state WHERE agent_id=?').get(b.agentId).next_seq;
      const count = f.db.prepare('SELECT count(*) AS n FROM im_messages').get().n;
      const trigger = `fail_${table}`;
      f.db.exec(`CREATE TEMP TRIGGER ${trigger} BEFORE ${table === 'im_receive_state' ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END`);
      const data = Buffer.from('x');
      assert.throws(() => f.service.send(a.principal, f.request(id, b.agentId, { attachment: { name: 'x',
        sha256: createHash('sha256').update(data).digest('hex'), dataBase64: data.toString('base64') } })));
      f.db.exec(`DROP TRIGGER ${trigger}`);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM im_messages').get().n, count, table);
      assert.equal(f.db.prepare('SELECT next_seq FROM im_receive_state WHERE agent_id=?').get(b.agentId).next_seq, before, table);
    }
  } finally { f.close(); }
});

test('disabled config and policy snapshot block writes without trusting mutable caller', () => {
  const f = setup(); try {
    const [a, b] = f.persons;
    const disabled = createImMessages({ db: f.db, auth: f.auth, acl: f.acl, clock: f.clock, policy: { enabled: false } });
    assert.throws(() => disabled.listContacts(a.principal), error('IM_DISABLED'));
    const local = structuredClone(policy);
    const svc = createImMessages({ db: f.db, auth: f.auth, acl: f.acl, clock: f.clock, policy: local });
    local.enabled = false; local.writeMode = 'paused'; local.retention.policy.safeRetryWindowMs = 999999;
    assert.ok(svc.ensureConversation(a.principal, { peerAgentId: b.agentId }).conversationId);
    f.admin.revokeCredential({ credentialId: a.credentialId, reason: 'test' }, f.ctx);
    assert.throws(() => svc.listContacts(a.principal), error('INVALID_CREDENTIAL'));
  } finally { f.close(); }
});

test('outer write refuses all message mutations before rows, keys, audit or notification', () => {
  const f = setup(); try {
    const [a, b] = f.persons;
    const guard = createImClockGuard({ db: f.db, clock: f.clock });
    const counts = () => ['im_conversations', 'im_messages', 'im_send_keys', 'im_deliveries', 'im_audit']
      .map(table => f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
    const before = counts();
    assert.throws(() => guard.runWrite(() => f.service.ensureConversation(a.principal, { peerAgentId: b.agentId })), error('INVALID_REQUEST'));
    assert.deepEqual(counts(), before);
    const conversationId = f.service.ensureConversation(a.principal, { peerAgentId: b.agentId }).conversationId;
    const sent = f.service.send(a.principal, f.request(conversationId, b.agentId));
    f.db.prepare('UPDATE im_deliveries SET acked_at=? WHERE message_id=?').run(10000, sent.messageId);
    const baseline = counts(), notifications = f.events.length;
    const nextSeq = f.db.prepare('SELECT next_seq FROM im_receive_state WHERE agent_id=?').get(b.agentId).next_seq;
    assert.throws(() => guard.runWrite(() => f.service.send(a.principal, f.request(conversationId, b.agentId))), error('INVALID_REQUEST'));
    assert.throws(() => guard.runWrite(() => f.service.markRead(b.principal, { messageId: sent.messageId })), error('INVALID_REQUEST'));
    assert.deepEqual(counts(), baseline);
    assert.equal(f.db.prepare('SELECT next_seq FROM im_receive_state WHERE agent_id=?').get(b.agentId).next_seq, nextSeq);
    assert.equal(f.db.prepare('SELECT read_at FROM im_deliveries WHERE message_id=?').get(sent.messageId).read_at, null);
    assert.equal(f.events.length, notifications);
  } finally { f.close(); }
});

test('top-level commit precedes notification, idempotency replay and failed business writes never notify', () => {
  const f = setup(); try {
    const [a, b] = f.persons;
    const notices = [];
    const service = createImMessages({ db: f.db, auth: f.auth, acl: f.acl, clock: f.clock, policy,
      onCommitted: event => notices.push({ event, inTransaction: f.db.isTransaction,
        rows: f.db.prepare('SELECT count(*) n FROM im_messages').get().n }) });
    const conversationId = service.ensureConversation(a.principal, { peerAgentId: b.agentId }).conversationId;
    const raw = f.request(conversationId, b.agentId);
    const sent = service.send(a.principal, raw);
    assert.deepEqual(notices.map(n => n.event.kind), ['conversation_created', 'message_sent']);
    assert.deepEqual(notices.map(n => n.inTransaction), [false, false]);
    assert.equal(notices[1].rows, 1);
    assert.equal(service.send(a.principal, raw).messageId, sent.messageId);
    assert.equal(notices.length, 2);
    f.db.exec("CREATE TEMP TRIGGER fail_send_audit BEFORE INSERT ON im_audit BEGIN SELECT RAISE(ABORT,'injected audit failure'); END");
    assert.throws(() => service.send(a.principal, f.request(conversationId, b.agentId)), /injected audit failure/);
    f.db.exec('DROP TRIGGER fail_send_audit');
    assert.equal(notices.length, 2);
    assert.equal(f.db.prepare('SELECT count(*) n FROM im_messages').get().n, 1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM im_send_keys').get().n, 1);
  } finally { f.close(); }
});

test('real COMMIT failure rolls back message and suppresses post-commit notification', () => {
  const f = setup(); try {
    const [a, b] = f.persons;
    const conversationId = f.service.ensureConversation(a.principal, { peerAgentId: b.agentId }).conversationId;
    const notices = [];
    const db = new Proxy(f.db, { get(target, key) {
      if (key === 'exec') return sql => {
        if (sql === 'COMMIT' && target.prepare('SELECT count(*) n FROM im_messages').get().n > 0) throw Error('real commit failure');
        return target.exec(sql);
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const auth = createImAuth({ db, clock: f.clock });
    const acl = createImAcl({ db, auth, clock: f.clock });
    const service = createImMessages({ db, auth, acl, clock: f.clock, policy, onCommitted: event => notices.push(event) });
    const principal = auth.authenticate(a.credential);
    const raw = f.request(conversationId, b.agentId);
    const audit = f.db.prepare('SELECT count(*) n FROM im_audit').get().n;
    const nextSeq = f.db.prepare('SELECT next_seq FROM im_receive_state WHERE agent_id=?').get(b.agentId).next_seq;
    assert.throws(() => service.send(principal, raw), /real commit failure/);
    assert.equal(notices.length, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM im_messages').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM im_send_keys').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM im_deliveries').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM im_audit').get().n, audit);
    assert.equal(f.db.prepare('SELECT next_seq FROM im_receive_state WHERE agent_id=?').get(b.agentId).next_seq, nextSeq);
  } finally { f.close(); }
});

test('notification throw and rejected promise cannot reverse accepted send or leak rejection', async () => {
  const f = setup();
  const unhandled = [];
  const observer = reason => unhandled.push(reason);
  process.on('unhandledRejection', observer);
  try {
    const [a, b] = f.persons;
    const conversationId = f.service.ensureConversation(a.principal, { peerAgentId: b.agentId }).conversationId;
    const throwing = createImMessages({ db: f.db, auth: f.auth, acl: f.acl, clock: f.clock, policy,
      onCommitted: () => { throw Error('notification failed'); } });
    const rejecting = createImMessages({ db: f.db, auth: f.auth, acl: f.acl, clock: f.clock, policy,
      onCommitted: () => Promise.reject(Error('notification rejected')) });
    assert.ok(throwing.send(a.principal, f.request(conversationId, b.agentId)).messageId);
    assert.ok(rejecting.send(a.principal, f.request(conversationId, b.agentId)).messageId);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(f.db.prepare('SELECT count(*) n FROM im_messages').get().n, 2);
  } finally { process.off('unhandledRejection', observer); f.close(); }
});
