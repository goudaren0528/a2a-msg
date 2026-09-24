import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createImV2MessageView } from '../src/im/v2/message-view.js';
import { messageSchema, historyItemSchema } from '../src/im/v2/contracts.js';
import { assertImSchemaV4 } from '../src/im/v2/schema.js';
import { createCoreFixture, seedMessage, expireFixtureContent } from './fixtures/im-v2-core/helpers.js';

const error = code => ({ code });
const access = (f, id, principal = f.principals[0], method = 'historyItem') =>
  f.auth.withRead(principal, f.scope, () => {
    f.acl.requireMessage(principal, f.scope, id);
    return createImV2MessageView({ db: f.db })[method](id);
  });

test('exact live v2 text and attachment DTO, independent order, immutable detached values', t => {
  const f = createCoreFixture(t), first = seedMessage(f, { text: 'first', title: 'title', deliveredAt: 20 });
  const second = seedMessage(f, { text: '', attachment: true, deliveredAt: 30, readAt: 40 });
  const view = createImV2MessageView({ db: f.db });
  assert.equal(Object.isFrozen(view), true);
  assert.throws(() => view.message(first.messageId), error('INVALID_REQUEST'));
  const item = access(f, second.messageId), text = access(f, first.messageId, f.principals[0], 'message');
  assert.equal(historyItemSchema.safeParse(item).success, true);
  assert.equal(messageSchema.safeParse(text).success, true);
  assert.deepEqual(Object.keys(item), ['kind','message']);
  assert.deepEqual(item.message, { messageId: second.messageId, conversationId: f.conversationId,
    senderAgentId: f.a, recipientAgentId: f.b, originEpoch: second.originEpoch,
    clientMessageId: second.clientMessageId, title: null, text: '', inReplyTo: null,
    correlation: null, acceptedAt: second.acceptedAt, expiresAt: second.expiresAt,
    deliveredAt: 30, readAt: 40, attachment: { attachmentId: second.attachmentId,
      name: 'test.txt', mime: 'text/plain', size: second.bytes.length, sha256: second.sha256 } });
  assert.equal(text.text, 'first');
  for (const value of [item, item.message, item.message.attachment, text]) assert.equal(Object.isFrozen(value), true);
  assert.equal(JSON.stringify(item).includes(second.storageKey), false);
  assert.equal(JSON.stringify(item).includes(second.fingerprint), false);
  f.db.prepare('UPDATE im_messages SET text=? WHERE message_id=?').run('changed', second.messageId);
  assert.equal(item.message.text, '');
  assert.equal(item.message.attachment.name, 'test.txt');
  assert.throws(() => assertImSchemaV4(f.db), { code: 'IM_SCHEMA_MISMATCH' });
});

test('imported v1 mapping projects wire UUID and original fingerprint remains unchanged', t => {
  const f = createCoreFixture(t), s = seedMessage(f, { protocol: 'a2a-msg.im.v1', text: 'imported' });
  const item = access(f, s.messageId);
  assert.equal(item.message.clientMessageId, s.clientMessageId);
  assert.equal(item.message.originEpoch, s.originEpoch);
  assert.equal(item.message.text, 'imported');
  assert.equal(f.db.prepare('SELECT payload_hash FROM im_send_keys WHERE message_id=?').get(s.messageId).payload_hash, s.fingerprint);
  assert.equal(historyItemSchema.safeParse(item).success, true);
});

for (const scrub of [false, true]) test(`expired ${scrub ? 'scrubbed' : 'unscrubbed'} returns minimal tombstone`, t => {
  const f = createCoreFixture(t), s = seedMessage(f, { attachment: true, title: 'secret title',
    correlation: 'secret correlation' });
  const expiredAt = expireFixtureContent(f, s, { scrub });
  const item = access(f, s.messageId);
  assert.deepEqual(item, { kind: 'content_expired', tombstone: { messageId: s.messageId,
    conversationId: f.conversationId, acceptedAt: s.acceptedAt, expiresAt: s.expiresAt, expiredAt } });
  assert.equal(historyItemSchema.safeParse(item).success, true);
  assert.equal(Object.isFrozen(item), true);
  assert.equal(Object.isFrozen(item.tombstone), true);
  assert.throws(() => access(f, s.messageId, f.principals[0], 'message'), error('CONTENT_EXPIRED'));
  for (const sensitive of [f.a, f.b, s.clientMessageId, s.storageKey, s.sha256, 'secret title', 'secret correlation', 'test.txt'])
    assert.equal(JSON.stringify(item).includes(sensitive), false);
});

for (const [scrub, sql, invalid] of [
  [false, 'UPDATE im_attachments SET name=? WHERE message_id=?', '../secret'],
  [true, 'UPDATE im_attachment_reservations SET attachment_id=? WHERE message_id=?', 'not-a-uuid'],
]) test(`expired ${scrub ? 'scrubbed reservation' : 'unscrubbed payload'} corruption fails closed without payload reads`, t => {
  const events = [];
  let recording = false;
  const f = createCoreFixture(t, { onStatement: e => { if (recording) events.push(e); } });
  const s = seedMessage(f, { attachment: true, title: 'retained' });
  expireFixtureContent(f, s, { scrub });
  recording = true;
  try {
    assert.equal(access(f, s.messageId).kind, 'content_expired', 'valid expired control');
    assert.throws(() => access(f, s.messageId, f.principals[0], 'message'), error('CONTENT_EXPIRED'));
  } finally { recording = false; }
  assert.equal(f.native.prepare(sql).run(invalid, s.messageId).changes, 1, 'corruption actually reached SQLite');
  assert.throws(() => assertImSchemaV4(f.native), { code: 'IM_SCHEMA_MISMATCH' });
  recording = true;
  try {
    assert.throws(() => access(f, s.messageId), error('STORAGE_UNAVAILABLE'));
    assert.throws(() => access(f, s.messageId, f.principals[0], 'message'), error('STORAGE_UNAVAILABLE'));
  } finally { recording = false; }
  const projection = events.filter(e => /FROM im_(?:send_operation_keys|attachment_reservations|attachments) WHERE message_id=\?/i.test(e.sql));
  assert.equal(projection.length, 12, 'four scoped calls, three projected metadata records each');
  for (const { sql, method } of projection) {
    assert.equal(method, 'get');
    assert.doesNotMatch(sql, /\bdata\b|sqlite_master|foreign_key_check|SELECT\s+\*|\bJOIN\b/i);
    assert.match(sql, /WHERE message_id=\?/i);
  }
});

test('fixture ACK gap stays unhandled: later ACK never jumps an earlier unproved delivery', t => {
  const f = createCoreFixture(t);
  seedMessage(f);
  seedMessage(f, { deliveredAt: 30 });
  const state = f.native.prepare('SELECT stream_epoch,acked_through FROM im_receive_state WHERE agent_id=?').get(f.b);
  const progress = f.native.prepare(`SELECT handled_through FROM im_sync_progress
    WHERE recipient_id=? AND center_epoch=? AND stream_epoch=?`).get(f.b, f.centerEpoch, state.stream_epoch);
  assert.equal(state.acked_through, 0);
  assert.equal(progress.handled_through, 0);
  assert.equal(assertImSchemaV4(f.native), true);
});

test('two distinct fixture expiry operations, including scrub, retain independent lawful proof rows', t => {
  const f = createCoreFixture(t);
  const first = seedMessage(f, { attachment: true, deliveredAt: 30 });
  const second = seedMessage(f, { attachment: true });
  expireFixtureContent(f, first);
  expireFixtureContent(f, second, { scrub: true });
  assert.equal(assertImSchemaV4(f.native), true);
  const rows = f.native.prepare('SELECT run_id,plan_hash,kind FROM im_maintenance_runs').all();
  assert.deepEqual(rows.map(r => r.kind).sort(), ['expire','expire','scrub']);
  assert.equal(new Set(rows.map(r => r.run_id)).size, 3);
  assert.equal(new Set(rows.map(r => r.plan_hash)).size, 3);
  assert.equal(access(f, first.messageId).kind, 'content_expired');
  assert.equal(access(f, second.messageId).kind, 'content_expired');
});

test('scope and ACL happen before projection: outsiders, stale epoch and revoked contact cannot reach it', t => {
  let recording = false;
  const events = [];
  const f = createCoreFixture(t, { onStatement: event => { if (recording) events.push(event); } });
  const s = seedMessage(f, { attachment: true });
  expireFixtureContent(f, s);
  recording = true;
  try {
    assert.throws(() => access(f, s.messageId, f.principals[2]), error('RESOURCE_NOT_FOUND'));
    assert.throws(() => f.auth.withRead(f.principals[0], { ...f.scope, centerEpoch: randomUUID() }, () => {
      assert.fail('no callback');
    }), error('RECOVERY_RECONCILIATION_REQUIRED'));
    f.native.prepare('UPDATE im_contacts SET allowed=0').run();
    assert.throws(() => access(f, s.messageId), error('RESOURCE_NOT_FOUND'));
  } finally { recording = false; }
  assert.equal(events.some(e => /FROM im_send_operation_keys|FROM im_send_keys WHERE message_id/i.test(e.sql)), false);
  // This internal projector is not an authorization API: a raw SQL transaction alone is not proof of ACL.
});

const damage = [
  ['content', 'DELETE FROM im_content_state WHERE message_id=?'],
  ['mapping', 'DELETE FROM im_send_operation_keys WHERE message_id=?'],
  ['delivery', 'DELETE FROM im_deliveries WHERE message_id=?'],
  ['wrong delivery recipient', 'UPDATE im_deliveries SET recipient_id=? WHERE message_id=?', f => f.outsider],
  ['wrong mapped message storage', 'UPDATE im_messages SET client_message_id=? WHERE message_id=?', () => randomUUID()],
  ['missing payload', 'DELETE FROM im_attachments WHERE message_id=?'],
  ['payload hash mismatch', 'UPDATE im_attachments SET sha256=? WHERE message_id=?', () => '0'.repeat(64)],
  ['reservation size mismatch', 'UPDATE im_attachment_reservations SET size=size+1 WHERE message_id=?'],
  ['invalid wire title not defaulted', 'UPDATE im_messages SET title=? WHERE message_id=?', () => 'x'.repeat(101)],
];
for (const [label, sql, value] of damage) test(`inconsistent ${label} fails closed`, t => {
  const f = createCoreFixture(t), s = seedMessage(f, { attachment: true });
  const args = value ? [value(f), s.messageId] : [s.messageId];
  f.native.prepare(sql).run(...args);
  assert.throws(() => access(f, s.messageId), error('STORAGE_UNAVAILABLE'));
});

test('unknown message is internal storage failure; ACL hides it first on the real scoped path', t => {
  const f = createCoreFixture(t), id = randomUUID();
  assert.throws(() => access(f, id), error('RESOURCE_NOT_FOUND'));
  f.auth.withRead(f.principals[0], f.scope, () =>
    assert.throws(() => createImV2MessageView({ db: f.db }).message(id), error('STORAGE_UNAVAILABLE')));
});

test('projection uses metadata point reads only, without BLOB/hash/full scans/writes/transactions', t => {
  const events = [];
  let recording = false;
  const f = createCoreFixture(t, { onStatement: e => { if (recording) events.push(e); } });
  const s = seedMessage(f, { attachment: true });
  const view = createImV2MessageView({ db: f.db });
  f.auth.withRead(f.principals[0], f.scope, () => {
    f.acl.requireMessage(f.principals[0], f.scope, s.messageId);
    recording = true;
    try { assert.equal(view.message(s.messageId).attachment.sha256, s.sha256); }
    finally { recording = false; }
  });
  assert.equal(events.length, 7);
  for (const event of events) {
    assert.equal(event.method, 'get');
    assert.match(event.sql, /^SELECT\s/i);
    assert.match(event.sql, /WHERE\s+message_id=\?/i);
    assert.doesNotMatch(event.sql, /\bdata\b|sqlite_master|sqlite_schema|foreign_key_check|integrity_check|SELECT\s+\*|\bJOIN\b/i);
  }
  assert.equal(f.db.isTransaction, false);
});
