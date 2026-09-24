import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createImV2Delivery } from '../src/im/v2/delivery.js';
import { createImV2ClockGuard } from '../src/im/v2/clock.js';
import { dataSchemas } from '../src/im/v2/contracts.js';
import { createCompositionFixture, assertCandidate, businessDigest, cursors, expireForComposition,
  capture, assertOneWrite, assertPrefixBudget, sha } from './fixtures/im-v2-composition/helpers.js';

// Real A/B API composition only. No HTTP, recovery executor, expiry executor,
// verifier/auth stubs, preseeded ACKs or externally nested auth.withWrite calls.
const bounded = { timeout: 120000 };
const error = code => e => e?.code === code;
const fence = lease => ({ instanceId: lease.instanceId, generation: lease.generation });
const streamFence = lease => ({ ...fence(lease), streamEpoch: lease.streamEpoch });
const ref = (message, seq) => ({ seq, messageId: message.messageId });
const request = (f, extra = {}) => ({ originEpoch: f.centerEpoch, clientMessageId: randomUUID(),
  conversationId: f.conversationId, recipientAgentId: f.b, text: 'composition text', ...extra });
const row = (f, seq) => f.native.prepare('SELECT * FROM im_deliveries WHERE recipient_id=? AND seq=?').get(f.b, seq);
const auditCount = f => f.native.prepare('SELECT count(*) AS n FROM im_audit').get().n;
const attachDelivery = f => { f.delivery = createImV2Delivery(f); };
const acquire = f => f.delivery.acquire(f.principals[1], f.scope,
  { instanceId: randomUUID(), requestId: randomUUID() });
const write = (f, operation) => {
  const observed = capture(f, operation);
  assertOneWrite(observed.events);
  return observed.value;
};
const progressWrite = (f, method, args) => {
  const before = cursors(f);
  const { value, events } = capture(f, () => f.delivery[method](f.principals[1], f.scope, args));
  const after = cursors(f);
  assertOneWrite(events);
  assertPrefixBudget(events, before, after);
  assert.deepEqual(dataSchemas[method === 'ack' ? 'acks' : 'expiryReceipts'].parse(value), value);
  assert.equal(value.ackedThrough, after.ackedThrough);
  assert.equal(value.handledThrough, after.handledThrough);
  return value;
};

function sendMany(f, count) {
  const messages = [];
  for (let index = 0; index < count; index++) {
    const sent = f.messages.send(f.principals[0], f.scope, request(f, { text: `sequence ${index + 1}` }));
    assert.equal(sent.replayed, false);
    assert.equal(sent.message.deliveredAt, null);
    assert.equal(sent.message.readAt, null);
    messages.push(sent.message);
  }
  assert.equal(f.native.prepare('SELECT count(*) AS n FROM im_deliveries WHERE acked_at IS NOT NULL').get().n, 0);
  assert.equal(f.native.prepare('SELECT count(*) AS n FROM im_messages').get().n, count);
  assert.equal(f.native.prepare('SELECT next_seq FROM im_receive_state WHERE agent_id=?').get(f.b).next_seq, count + 1);
  assertCandidate(f.native);
  return messages;
}

function ackTailWithFirstGap(f, lease, messages) {
  // 1,001 ACK facts are written exclusively through real <=100-item API batches.
  f.now = 104;
  for (let start = 1; start < messages.length; start += 100) {
    const items = messages.slice(start, start + 100).map((message, offset) => ref(message, start + offset + 1));
    assert.ok(items.length <= 100);
    const result = progressWrite(f, 'ack', { ...streamFence(lease), items });
    assert.equal(result.ackedThrough, 0);
    assert.equal(result.handledThrough, 0);
    assert.equal(result.progressPending, false, 'a real unhandled first gap blocks contiguous progress');
  }
  const facts = f.native.prepare('SELECT seq,acked_at,read_at FROM im_deliveries WHERE recipient_id=? ORDER BY seq').all(f.b);
  assert.equal(facts[0].acked_at, null);
  assert.ok(facts.slice(1).every(item => item.acked_at === 104 && item.read_at === null));
  assertCandidate(f.native);
}

function reopenPending(f) {
  const before = businessDigest(f.native), progress = { ...cursors(f) };
  assertCandidate(f.native);
  f.reopen(); // closes the only native connection and drops all old module owners
  attachDelivery(f);
  assert.equal(createImV2ClockGuard({ db: f.db, clock: f.clock }), f.timeGuard);
  assert.deepEqual(businessDigest(f.native), before);
  assert.deepEqual({ ...cursors(f) }, progress);
  assertCandidate(f.native);
}

test('A/B composition: accepted binary send -> leased sync -> real ACK -> read; exact retries preserve facts', bounded, t => {
  const f = createCompositionFixture(t);
  attachDelivery(f);
  assert.deepEqual(Object.keys(f.messages).sort(), ['ensureConversation', 'listContacts', 'listConversations',
    'send', 'getSendResult', 'listHistory', 'getMessage', 'getAttachment', 'markRead'].sort());
  assert.deepEqual(Object.keys(f.delivery).sort(), ['acquire', 'renew', 'release', 'sync', 'ack', 'recordExpiryReceipts'].sort());
  const bytes = Buffer.from([0, 255, 128, 13, 10, 0, 1, 127, 195, 40, 254]);
  const input = request(f, { title: 'Binary integration', text: 'text plus actual binary', attachment: {
    name: 'binary.dat', mime: 'application/octet-stream', sha256: sha(bytes), dataBase64: bytes.toString('base64') } });
  const auditsBefore = auditCount(f);
  const sent = write(f, () => f.messages.send(f.principals[0], f.scope, input));
  assert.equal(sent.replayed, false);
  assert.equal(sent.message.acceptedAt, 103);
  assert.equal(sent.message.deliveredAt, null);
  assert.equal(sent.message.readAt, null);
  assert.equal(sent.message.text, input.text);
  assert.equal(auditCount(f), auditsBefore + 1);
  const attachment = sent.message.attachment;
  assert.deepEqual(attachment, { attachmentId: attachment.attachmentId, name: 'binary.dat',
    mime: 'application/octet-stream', size: bytes.length, sha256: sha(bytes) });
  const accepted = f.messages.getSendResult(f.principals[0], f.scope,
    { originEpoch: input.originEpoch, clientMessageId: input.clientMessageId });
  assert.equal(accepted.messageId, sent.message.messageId);
  assert.equal(accepted.acceptedAt, 103);
  assert.equal(accepted.contentState, 'live');
  assert.equal(row(f, 1).acked_at, null, 'acceptance exists before receiver ACK');
  const acceptedDigest = businessDigest(f.native);
  f.now = 104;
  assert.deepEqual(write(f, () => f.messages.send(f.principals[0], f.scope, input)), { ...sent, replayed: true });
  assert.deepEqual(businessDigest(f.native), acceptedDigest);
  assert.throws(() => f.messages.markRead(f.principals[1], f.scope, { messageId: sent.message.messageId }), error('DELIVERY_REQUIRED'));
  assert.deepEqual(businessDigest(f.native), acceptedDigest);

  const lease = write(f, () => acquire(f));
  assert.deepEqual(dataSchemas.lease.parse(lease), lease);
  const page = f.delivery.sync(f.principals[1], f.scope, { ...streamFence(lease), after: 0, limit: 1 });
  assert.deepEqual(dataSchemas.sync.parse(page), page);
  assert.deepEqual(page.items.map(item => [item.kind, item.seq]), [['message', 1]]);
  assert.deepEqual(page.items[0].message, sent.message);
  assert.equal(page.pageAfter, 1);
  assert.equal(page.hasMore, false);
  const downloaded = f.messages.getAttachment(f.principals[1], f.scope, { attachmentId: attachment.attachmentId });
  assert.deepEqual(downloaded.data, bytes);
  assert.equal(sha(downloaded.data), attachment.sha256);
  for (const key of ['attachmentId', 'name', 'mime', 'size', 'sha256']) assert.equal(downloaded[key], attachment[key]);

  f.now = 105;
  const args = { ...streamFence(lease), items: [ref(sent.message, 1)] };
  const beforeAck = auditCount(f);
  assert.deepEqual(progressWrite(f, 'ack', args), { streamEpoch: lease.streamEpoch,
    ackedThrough: 1, handledThrough: 1, progressPending: false });
  assert.equal(row(f, 1).acked_at, 105);
  assert.equal(row(f, 1).read_at, null);
  assert.equal(auditCount(f), beforeAck + 1);
  const ackDigest = businessDigest(f.native);
  f.now = 106;
  progressWrite(f, 'ack', args);
  assert.deepEqual(businessDigest(f.native), ackDigest);
  const beforeRead = auditCount(f);
  const read = write(f, () => f.messages.markRead(f.principals[1], f.scope, { messageId: sent.message.messageId }));
  assert.deepEqual(read, { messageId: sent.message.messageId, readAt: 106, changed: true });
  assert.equal(auditCount(f), beforeRead + 1);
  const readDigest = businessDigest(f.native);
  f.now = 107;
  assert.deepEqual(write(f, () => f.messages.markRead(f.principals[1], f.scope,
    { messageId: sent.message.messageId })), { ...read, changed: false });
  progressWrite(f, 'ack', args);
  const retry = write(f, () => f.messages.send(f.principals[0], f.scope, input));
  assert.equal(retry.replayed, true);
  assert.equal(retry.message.acceptedAt, 103);
  assert.equal(retry.message.deliveredAt, 105);
  assert.equal(retry.message.readAt, 106);
  assert.deepEqual(businessDigest(f.native), readDigest);
  assertCandidate(f.native);
});

test('A/B composition: live/expired/live sync stays contiguous; expiry receipt creates no ACK/read fact', bounded, t => {
  const f = createCompositionFixture(t);
  attachDelivery(f);
  const messages = sendMany(f, 3);
  expireForComposition(f, messages[1]);
  const lease = acquire(f), base = streamFence(lease);
  const refs = messages.map((message, index) => ref(message, index + 1));
  const page = f.delivery.sync(f.principals[1], f.scope, { ...base, after: 0, limit: 3 });
  assert.deepEqual(dataSchemas.sync.parse(page), page);
  assert.deepEqual(page.items.map(item => [item.kind, item.seq]), [['message', 1], ['content_expired', 2], ['message', 3]]);
  assert.deepEqual(page.items.map(item => item.message?.messageId ?? item.tombstone.messageId), messages.map(message => message.messageId));
  assert.equal(page.pageAfter, 3);
  assert.equal(page.hasMore, false);
  const untouched = businessDigest(f.native);
  assert.throws(() => f.delivery.ack(f.principals[1], f.scope, { ...base, items: refs }), error('EXPIRY_RECEIPT_REQUIRED'));
  assert.throws(() => f.delivery.recordExpiryReceipts(f.principals[1], f.scope,
    { ...base, items: [refs[1], refs[2]] }), error('CONTENT_NOT_EXPIRED'));
  assert.deepEqual(businessDigest(f.native), untouched, 'invalid mixed batches roll back all facts and audits');
  const ack = progressWrite(f, 'ack', { ...base, items: [refs[0], refs[2]] });
  assert.equal(ack.ackedThrough, 1);
  assert.equal(ack.handledThrough, 1);
  const beforeReceipt = businessDigest(f.native), originalExpiryDelivery = { ...row(f, 2) };
  const auditsBeforeReceipt = auditCount(f);
  const receiptArgs = { ...base, items: [refs[1]] };
  const receipt = progressWrite(f, 'recordExpiryReceipts', receiptArgs);
  assert.equal(receipt.handledThrough, 3);
  assert.equal(receipt.ackedThrough, 1);
  assert.equal(receipt.progressPending, false);
  assert.equal(auditCount(f), auditsBeforeReceipt + 1);
  assert.deepEqual({ ...row(f, 2) }, originalExpiryDelivery);
  assert.equal(row(f, 2).acked_at, null);
  assert.equal(row(f, 2).read_at, null);
  const afterReceipt = businessDigest(f.native);
  for (const table of Object.keys(beforeReceipt).filter(name => !['im_expiry_receipts', 'im_audit'].includes(name)))
    assert.equal(afterReceipt[table], beforeReceipt[table], `${table} unchanged by receipt`);
  f.now = 104;
  assert.deepEqual(progressWrite(f, 'recordExpiryReceipts', receiptArgs), receipt);
  assert.throws(() => f.messages.markRead(f.principals[1], f.scope, { messageId: messages[1].messageId }), error('CONTENT_EXPIRED'));
  assert.deepEqual(businessDigest(f.native), afterReceipt);
  assert.equal(f.native.prepare('SELECT count(*) AS n FROM im_expiry_receipts').get().n, 1);
  assertCandidate(f.native);
});

test('A/B composition: 1,002 real out-of-order ACKs leave lawful bounded v4 cursor; close/reopen exact batch resumes', bounded, t => {
  const f = createCompositionFixture(t);
  attachDelivery(f);
  const messages = sendMany(f, 1002), lease = acquire(f);
  ackTailWithFirstGap(f, lease, messages);
  f.now = 105;
  const originalBatch = { ...streamFence(lease), items: [ref(messages[0], 1)] };
  const initial = progressWrite(f, 'ack', originalBatch);
  assert.ok(initial.ackedThrough > 0 && initial.ackedThrough <= 1000);
  assert.ok(initial.handledThrough >= initial.ackedThrough && initial.handledThrough <= 1000);
  assert.equal(initial.progressPending, true);
  const actual = f.native.prepare(`SELECT count(*) AS n,max(seq) AS maximum,min(seq) AS minimum
    FROM im_deliveries WHERE recipient_id=? AND acked_at IS NOT NULL`).get(f.b);
  assert.deepEqual({ ...actual }, { n: 1002, maximum: 1002, minimum: 1 });
  assert.equal(row(f, 1).acked_at, 105);
  assertCandidate(f.native); // regression: safely lagging cursor MUST be reopenable
  const frozenFacts = businessDigest(f.native), auditRows = auditCount(f);
  const pendingPage = f.delivery.sync(f.principals[1], f.scope,
    { ...streamFence(lease), after: 1000, limit: 2 });
  assert.equal(pendingPage.progressPending, true);
  assert.deepEqual(businessDigest(f.native), frozenFacts);
  assert.equal(cursors(f).ackedThrough, initial.ackedThrough, 'sync must not advance stored prefix');
  reopenPending(f);
  f.now = 106;
  let resumed;
  for (let round = 0; round < 10; round++) {
    resumed = progressWrite(f, 'ack', originalBatch); // same tuple/items after NEW auth/guard
    assert.deepEqual(businessDigest(f.native), frozenFacts, 'only cursors may change on exact replay');
    if (!resumed.progressPending) break;
  }
  assert.equal(resumed.progressPending, false);
  assert.equal(resumed.ackedThrough, 1002);
  assert.equal(resumed.handledThrough, 1002);
  assert.equal(auditCount(f), auditRows);
  assert.equal(row(f, 1).acked_at, 105);
  assert.equal(row(f, 1002).acked_at, 104);
  assert.deepEqual(progressWrite(f, 'ack', originalBatch), resumed);
  assert.deepEqual(businessDigest(f.native), frozenFacts);
  assertCandidate(f.native);
  // Strict maximal-prefix v3 import is independently covered by existing
  // im-v2-migration.test.js, malformed import case 'ACK prefix' (sets 0 over
  // an ACKed legacy message); this lane does not relax or edit that oracle.
});

test('A/B composition: expired first gap keeps ACK prefix zero while receipt resumes >1,000 handled facts across reopen', bounded, t => {
  const f = createCompositionFixture(t);
  attachDelivery(f);
  const messages = sendMany(f, 1002), lease = acquire(f);
  expireForComposition(f, messages[0]);
  ackTailWithFirstGap(f, lease, messages);
  const before = businessDigest(f.native), firstDelivery = { ...row(f, 1) };
  f.now = 105;
  const originalBatch = { ...streamFence(lease), items: [ref(messages[0], 1)] };
  const initial = progressWrite(f, 'recordExpiryReceipts', originalBatch);
  assert.equal(initial.ackedThrough, 0);
  assert.ok(initial.handledThrough > 0 && initial.handledThrough <= 1000,
    'known unACKed obstacle may consume the shared budget; do not require exactly 1,000');
  assert.equal(initial.progressPending, true);
  assert.deepEqual({ ...row(f, 1) }, firstDelivery);
  const frozenFacts = businessDigest(f.native);
  for (const table of Object.keys(before).filter(name => !['im_expiry_receipts', 'im_audit'].includes(name)))
    assert.equal(frozenFacts[table], before[table], `${table} unchanged by receipt`);
  const proof = f.native.prepare('SELECT * FROM im_expiry_receipts').get();
  assert.equal(proof.recorded_at, 105);
  assert.equal(proof.message_id, messages[0].messageId);
  assertCandidate(f.native);
  reopenPending(f);
  f.now = 106;
  let resumed;
  for (let round = 0; round < 10; round++) {
    resumed = progressWrite(f, 'recordExpiryReceipts', originalBatch);
    assert.equal(resumed.ackedThrough, 0, 'expiry receipt is never an ACK, including after restart');
    assert.deepEqual(businessDigest(f.native), frozenFacts);
    if (!resumed.progressPending) break;
  }
  assert.equal(resumed.progressPending, false);
  assert.equal(resumed.handledThrough, 1002);
  assert.deepEqual(progressWrite(f, 'recordExpiryReceipts', originalBatch), resumed);
  assert.equal(row(f, 1).acked_at, null);
  assert.equal(row(f, 1).read_at, null);
  assert.equal(f.native.prepare('SELECT count(*) AS n FROM im_expiry_receipts').get().n, 1);
  assert.deepEqual(f.native.prepare('SELECT * FROM im_expiry_receipts').get(), proof);
  assert.deepEqual(businessDigest(f.native), frozenFacts);
  assertCandidate(f.native);
});

test('A/B composition: missing middle delivery fails closed without cursor/fact advance', bounded, t => {
  const f = createCompositionFixture(t);
  attachDelivery(f);
  const messages = sendMany(f, 3), lease = acquire(f), base = streamFence(lease);
  progressWrite(f, 'ack', { ...base, items: [ref(messages[2], 3)] });
  // TEST ONLY corruption injection after lawful construction, not startup data.
  f.native.prepare('DELETE FROM im_deliveries WHERE recipient_id=? AND seq=2').run(f.b);
  const facts = businessDigest(f.native), progress = { ...cursors(f) };
  assert.throws(() => f.delivery.sync(f.principals[1], f.scope, { ...base, after: 0, limit: 3 }), error('STORAGE_UNAVAILABLE'));
  assert.throws(() => f.delivery.ack(f.principals[1], f.scope,
    { ...base, items: [ref(messages[0], 1)] }), error('STORAGE_UNAVAILABLE'));
  assert.deepEqual({ ...cursors(f) }, progress);
  assert.deepEqual(businessDigest(f.native), facts);
  assert.equal(row(f, 1).acked_at, null, 'failed prefix proof rolls back new ACK');
});

test('A/B composition: reused sequence number cannot cross epoch scope; new instance rejects old fence', bounded, t => {
  const old = createCompositionFixture(t), current = createCompositionFixture(t);
  attachDelivery(old);
  attachDelivery(current);
  const [oldMessage] = sendMany(old, 1), oldLease = acquire(old);
  const [message] = sendMany(current, 1), lease = acquire(current);
  assert.notEqual(old.centerEpoch, current.centerEpoch);
  assert.equal(row(old, 1).seq, row(current, 1).seq);
  const unchanged = businessDigest(current.native);
  // Current principal/fence/stream and even current message ID cannot authorize
  // an old scope merely because seq=1 is reused. These are independent lawful
  // centers, not a simulated P5 restore/activation claim.
  const currentArgs = { ...streamFence(lease), items: [ref(message, 1)] };
  assert.throws(() => current.delivery.ack(current.principals[1], old.scope, currentArgs), error('RECOVERY_RECONCILIATION_REQUIRED'));
  assert.throws(() => current.delivery.ack(current.principals[1], old.scope,
    { ...streamFence(oldLease), items: [ref(oldMessage, 1)] }), error('RECOVERY_RECONCILIATION_REQUIRED'));
  assert.throws(() => current.delivery.ack(current.principals[1], current.scope,
    { ...currentArgs, streamEpoch: oldLease.streamEpoch }), error('CURSOR_RESET_REQUIRED'));
  assert.deepEqual(businessDigest(current.native), unchanged);
  write(current, () => current.delivery.release(current.principals[1], current.scope, fence(lease)));
  const replacement = write(current, () => acquire(current));
  assert.notEqual(replacement.instanceId, lease.instanceId);
  assert.equal(replacement.generation, lease.generation + 1);
  const replaced = businessDigest(current.native);
  assert.throws(() => current.delivery.ack(current.principals[1], current.scope, currentArgs), error('STALE_FENCE'));
  assert.throws(() => current.delivery.renew(current.principals[1], current.scope, fence(lease)), error('STALE_FENCE'));
  assert.throws(() => current.delivery.sync(current.principals[1], current.scope, streamFence(lease)), error('STALE_FENCE'));
  assert.deepEqual(businessDigest(current.native), replaced);
  assert.equal(row(current, 1).acked_at, null);
  progressWrite(current, 'ack', { ...streamFence(replacement), items: [ref(message, 1)] });
  assert.equal(row(current, 1).acked_at, current.now);
  assertCandidate(current.native);
});
