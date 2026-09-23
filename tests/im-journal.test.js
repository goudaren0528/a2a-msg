import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createImJournal } from '../src/im/journal.js';
import { PROTOCOL } from '../src/im/contracts.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';
const request = { protocol: PROTOCOL, conversationId: C, recipientAgentId: B, clientMessageId: D, text: 'hello' };
const message = { messageId: E, conversationId: C, senderAgentId: B, recipientAgentId: A,
  clientMessageId: D, title: null, text: 'hello', inReplyTo: null, correlation: null,
  acceptedAt: 100, attachment: null };
const epoch = '66666666-6666-4666-8666-666666666666';
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-journal-'));
  const file = join(dir, 'journal.sqlite');
  let db;
  const open = () => { db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL'); return db; };
  const close = () => db.close();
  const clean = () => { try { db.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); };
  open();
  return { open, close, clean, get db() { return db; } };
};
const create = (db, agentId = A, centerId = 'https://example.test') => createImJournal({ db, centerId, agentId });
const error = code => e => e.code === code;

test('outgoing replay, conflict, lost response, scope isolation and file reopen', () => {
  const env = setup();
  try {
    let j = create(env.db);
    const staged = j.stageOutgoing(request);
    assert.deepEqual(staged.request, { ...request, title: null, attachment: null, inReplyTo: null, correlation: null });
    assert.deepEqual(j.stageOutgoing(request), staged);
    assert.throws(() => j.stageOutgoing({ ...request, text: 'different' }), error('IDEMPOTENCY_CONFLICT'));
    assert.equal(j.listPendingOutgoing().length, 1);
    assert.equal(create(env.db, B).getOutgoing(D), null);
    assert.equal(create(env.db, A, 'https://other.test').getOutgoing(D), null);
    env.close(); env.open(); j = create(env.db);
    assert.deepEqual(j.getOutgoing(D), staged);
    j.markAccepted(D, { messageId: E, acceptedAt: 123 });
    assert.equal(j.listPendingOutgoing().length, 0);
    assert.throws(() => j.markAccepted(D, { messageId: C, acceptedAt: 123 }), error('IDEMPOTENCY_CONFLICT'));
    assert.equal(j.getOutgoing(D).request.clientMessageId, D);
  } finally { env.clean(); }
});

test('received pending survives restart; durable ACK and contiguous cursor', () => {
  const env = setup();
  try {
    let j = create(env.db);
    const received = j.recordReceived({ streamEpoch: epoch, seq: 1, message });
    assert.deepEqual(j.recordReceived({ streamEpoch: epoch, seq: 1, message }), received);
    assert.throws(() => j.recordReceived({ streamEpoch: epoch, seq: 1, message: { ...message, text: 'changed' } }), error('IDEMPOTENCY_CONFLICT'));
    assert.equal(j.listPendingAcks().length, 1);
    env.close(); env.open(); j = create(env.db);
    assert.deepEqual(j.getReceived(E), received);
    assert.throws(() => j.markAcked({ streamEpoch: epoch, messageIds: [C], ackedThrough: 1, syncAckedThrough: 0, localCursor: 0, seqs: [1] }), error('DELIVERY_REQUIRED'));
    assert.equal(j.getReceived(E).acked, false);
    assert.throws(() => j.markAcked({ streamEpoch: epoch, messageIds: [E], ackedThrough: 999, syncAckedThrough: 0, localCursor: 0, seqs: [1] }), error('CURSOR_RESET_REQUIRED'));
    assert.equal(j.getReceived(E).acked, false);
    assert.deepEqual(j.markAcked({ streamEpoch: epoch, messageIds: [E], ackedThrough: 1, syncAckedThrough: 0, localCursor: 0, seqs: [1] }), { streamEpoch: epoch, cursor: 1 });
    assert.equal(j.getReceived(E).acked, true);
    assert.equal(j.listPendingAcks().length, 0);
    assert.equal(create(env.db, B).getReceived(E), null);
  } finally { env.clean(); }
});

test('lease rollback, invalid input and schema mismatch', () => {
  const env = setup();
  try {
    const j = create(env.db);
    j.setLease({ instanceId: D, generation: 2, expiresAt: 200, streamEpoch: epoch });
    assert.throws(() => j.setLease({ instanceId: D, generation: 1, expiresAt: 300 }), error('STALE_FENCE'));
    assert.equal(j.getLease().generation, 2);
    assert.throws(() => j.recordReceived({ streamEpoch: epoch, seq: 1, message: { ...message, recipientAgentId: B } }), error('INVALID_REQUEST'));
    assert.throws(() => j.recordReceived({ streamEpoch: epoch, seq: 1, message, attachmentReceipt: { path: 'x', sha256: '0'.repeat(64), size: 1 } }), error('INVALID_ATTACHMENT'));
    assert.equal(j.getReceived(E), null);
    env.db.prepare('UPDATE im_client_meta SET version=99').run();
    assert.throws(() => create(env.db), error('IM_SCHEMA_MISMATCH'));
  } finally { env.clean(); }
});

test('journal requires durable file and FULL/EXTRA synchronous; explicit memory is test-only', () => {
  const memory = new DatabaseSync(':memory:');
  try {
    assert.throws(() => create(memory), error('STORAGE_UNAVAILABLE'));
    memory.exec('PRAGMA synchronous=FULL');
    assert.throws(() => create(memory), error('STORAGE_UNAVAILABLE'));
    assert.ok(createImJournal({ db: memory, centerId: 'https://example.test', agentId: A, testOnlyMemory: true }));
  } finally { memory.close(); }
  const env = setup();
  try {
    env.db.exec('PRAGMA synchronous=NORMAL');
    assert.throws(() => create(env.db), error('STORAGE_UNAVAILABLE'));
    env.db.exec('PRAGMA synchronous=FULL');
    assert.ok(create(env.db));
  } finally { env.clean(); }
});

test('ACK bridges prior confirmed row after filling hole; false highs, regression and missing rows roll back', () => {
  const env = setup();
  try {
    const j = create(env.db);
    j.recordReceived({ streamEpoch: epoch, seq: 2, message });
    const first = { streamEpoch: epoch, messageIds: [E], seqs: [2], localCursor: 0, syncAckedThrough: 0 };
    assert.throws(() => j.markAcked({ streamEpoch: epoch, messageIds: [E], seqs: [2],
      ackedThrough: 0, syncAckedThrough: 1, localCursor: 0 }), error('INVALID_REQUEST'));
    assert.throws(() => j.markAcked({ ...first, ackedThrough: 999 }), error('CURSOR_RESET_REQUIRED'));
    assert.equal(j.getReceived(E).acked, false);
    assert.throws(() => j.markAcked({ ...first, messageIds: [C], ackedThrough: 0 }), error('DELIVERY_REQUIRED'));
    assert.equal(j.getReceived(E).acked, false);
    assert.deepEqual(j.markAcked({ ...first, ackedThrough: 0 }), { streamEpoch: epoch, cursor: 0 });
    assert.equal(j.getReceived(E).acked, true);
    const firstMessage = { ...message, messageId: C, clientMessageId: '77777777-7777-4777-8777-777777777777' };
    j.recordReceived({ streamEpoch: epoch, seq: 1, message: firstMessage });
    const fill = { streamEpoch: epoch, messageIds: [C], seqs: [1], syncAckedThrough: 0, localCursor: 0 };
    assert.throws(() => j.markAcked({ ...fill, ackedThrough: 999 }), error('CURSOR_RESET_REQUIRED'));
    assert.equal(j.getReceived(C).acked, false);
    assert.deepEqual(j.markAcked({ ...fill, ackedThrough: 2 }), { streamEpoch: epoch, cursor: 2 });
    assert.equal(j.getReceived(C).acked, true);
    assert.equal(j.getLease(), null);
  } finally { env.clean(); }
});

test('maximum valid escaped multilingual bodies and attachment base64 fit journal budget', () => {
  const env = setup();
  try {
    const j = create(env.db), bytes = Buffer.alloc(10 * 1024 * 1024, 0x61);
    const staged = j.stageOutgoing({ ...request, text: '中'.repeat(31_998) + '\\"',
      attachment: { name: '文'.repeat(200), sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') } });
    assert.equal(staged.request.text.length, 32_000);
    assert.equal(staged.request.attachment.dataBase64.length, bytes.toString('base64').length);
    const inbound = { ...message, text: '中'.repeat(31_998) + '\\"', attachment: {
      attachmentId: D, name: '文'.repeat(200), mime: null, size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') } };
    assert.equal(j.recordReceived({ streamEpoch: epoch, seq: 1, message: inbound,
      attachmentReceipt: { path: '/safe', sha256: inbound.attachment.sha256, size: bytes.length } }).message.text, inbound.text);
  } finally { env.clean(); }
});
