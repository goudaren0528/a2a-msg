import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, native, attachment, acquireArgs, expireFixtureContent, bounded, kill,
  lockHeld, inspectJournal, journalRows } from './fixtures/im-v2-client-process/harness.js';

const partition = x => x.db.prepare('SELECT partition_id FROM im_v2_client_partitions').get().partition_id;
const facts = storage => inspectJournal(storage, db => db.prepare('SELECT * FROM im_v2_client_received ORDER BY kind').all());
const batchRows = storage => inspectJournal(storage, db => db.prepare('SELECT * FROM im_v2_client_batches ORDER BY kind').all());
const deliveries = f => f.inspect(db => db.prepare('SELECT message_id,acked_at,read_at FROM im_deliveries').all());
const audit = (f, action) => f.inspect(db => db.prepare('SELECT * FROM im_audit WHERE action=?').all(action));
async function phase(x, expected) {
  const p = await x.next('phase'); assert.equal(p.phase, expected); return p;
}
async function restart(f, storage, args) {
  const x = f.client(storage), before = f.count('/receiver/lease/renew');
  const lease = await x.c.acquire(args);
  assert.equal(f.count('/receiver/lease/renew'), before + 1, 'actual historical acquire must renew');
  return { ...x, lease, p: partition(x) };
}

for (const accepted of [false, true]) test(`SIGKILL send: ${accepted ? 'P3 durable acceptance before undelivered response' : 'stage COMMIT before POST'}`, native, async t => {
  const f = await fixture(t), storage = f.provision();
  const input = { clientMessageId: randomUUID(), conversationId: f.conversationId,
    recipientAgentId: f.b, text: 'immutable original payload', attachment: attachment() };
  const hold = accepted ? f.hold('/messages') : null;
  const child = await f.start(storage, { operation: 'send', input, phase: accepted ? null : 'stageOutgoing' }, 0);
  let acceptedId;
  if (accepted) {
    const response = await bounded(hold.entered.promise, 'P3 committed send response');
    assert.equal(response.status, 201); assert.equal(response.socketBytesWritten, 0); assert.equal(response.writableEnded, false);
    acceptedId = response.body.data.message.messageId;
    assert.equal(f.inspect(db => db.prepare('SELECT message_id FROM im_messages').get().message_id), acceptedId);
    assert.equal(f.db.isTransaction, false);
    await child.send({ type: 'server-commit-observed' }); await phase(child, 'server-response-withheld');
  } else await phase(child, 'stageOutgoing-committed');
  lockHeld(storage);
  const staged = inspectJournal(storage, db => db.prepare('SELECT * FROM im_v2_client_outgoing').get());
  assert.equal(staged.acceptance_state, 'pending'); assert.equal(staged.client_message_id, input.clientMessageId);
  assert.equal(f.count('/messages'), accepted ? 1 : 0);
  await kill(child);
  const x = f.client(storage, 0), op = { originEpoch: f.centerEpoch, clientMessageId: input.clientMessageId };
  const requestStart = f.requests.length;
  const result = await x.c.recoverSend(op);
  const requests = f.requests.slice(requestStart);
  const query = requests.findIndex(r => r.path === `/api/v2/sends/${op.originEpoch}/${op.clientMessageId}`);
  assert.ok(query >= 0, 'actual result query before recovery decision');
  const post = requests.findIndex(r => r.path === '/api/v2/messages');
  if (accepted) { assert.equal(post, -1); assert.equal(result.messageId, acceptedId); }
  else { assert.ok(post > query); assert.deepEqual(requests[post].body, JSON.parse(staged.payload_json)); }
  assert.equal(f.count('/messages'), 1);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM im_messages').get().n), 1);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM im_send_operation_keys').get().n), 1);
  assert.equal(x.db.prepare('SELECT count(*) n FROM im_v2_client_outgoing').get().n, 1);
  assert.equal(x.journal.getOutgoing(partition(x), op).message_id, result.messageId);
  t.diagnostic(`observed ${accepted ? 'disk P3 COMMIT / withheld ServerResponse.end' : 'native stageOutgoing returned / transaction=false'} -> SIGKILL exit+close -> query/recover original key`);
});

test('SIGKILL after final durable file publication before recordMessage; resync reuses same inode without download', native, async t => {
  const f = await fixture(t), storage = f.provision(), args = acquireArgs();
  const message = f.directSend({ attachment: attachment() });
  const child = await f.start(storage, { acquire: args, phase: 'file' }); await child.next('leased');
  const p = await phase(child, 'file-published-durable'); lockHeld(storage);
  const path = join(storage.files, p.evidence.receipt.relativeName), before = statSync(path), bytes = readFileSync(path);
  assert.equal(facts(storage).length, 0); assert.equal(batchRows(storage).length, 0); assert.equal(f.count('/acks'), 0);
  await kill(child);
  const downloads = f.requests.filter(r => r.path.startsWith('/api/v2/attachments/')).length;
  const x = await restart(f, storage, args), result = await x.c.receiveOnce();
  assert.equal(result.items[0].message.messageId, message.messageId); assert.equal(result.items[0].status, 'delivered');
  assert.equal(statSync(path).ino, before.ino); assert.deepEqual(readFileSync(path), bytes);
  assert.equal(f.requests.filter(r => r.path.startsWith('/api/v2/attachments/')).length, downloads);
  assert.equal(f.count('/acks'), 1); assert.equal(deliveries(f)[0].read_at, null);
  t.diagnostic('native save completed fsync/publication -> zero journal receipt/ACK -> SIGKILL -> native save verifies/reuses exact inode');
});

for (const mutation of ['none', 'removed', 'same-size']) test(`SIGKILL receipt+batch COMMIT before ACK: persisted file ${mutation}`, native, async t => {
  const f = await fixture(t), storage = f.provision(), args = acquireArgs(); f.directSend({ attachment: attachment() });
  const child = await f.start(storage, { acquire: args, phase: 'prepareBatch' }); await child.next('leased');
  await phase(child, 'prepareBatch-committed'); lockHeld(storage);
  const beforeFacts = facts(storage), beforeBatches = batchRows(storage);
  assert.equal(beforeFacts.length, 1); assert.equal(beforeFacts[0].server_confirmed, 0);
  assert.equal(beforeBatches.length, 1); assert.equal(beforeBatches[0].state, 'pending');
  assert.equal(f.count('/acks'), 0); assert.equal(deliveries(f)[0].acked_at, null);
  const receipt = JSON.parse(beforeFacts[0].attachment_receipt_json), path = join(storage.files, receipt.relativeName);
  const bytes = readFileSync(path); await kill(child);
  if (mutation === 'removed') unlinkSync(path);
  if (mutation === 'same-size') { writeFileSync(path, Buffer.alloc(bytes.length, 0x78)); assert.equal(statSync(path).size, bytes.length); }
  const x = await restart(f, storage, args);
  if (mutation === 'none') {
    assert.equal((await x.c.ackPending()).pending, false);
    assert.deepEqual(f.requests.find(r => r.path === '/api/v2/acks').body.items, JSON.parse(beforeBatches[0].items_json));
    assert.equal(batchRows(storage)[0].batch_id, beforeBatches[0].batch_id);
    assert.equal(batchRows(storage)[0].state, 'confirmed'); assert.deepEqual(readFileSync(path), bytes);
  } else {
    await assert.rejects(x.c.ackPending(), { code: mutation === 'removed' ? 'STORAGE_UNAVAILABLE' : 'INVALID_ATTACHMENT' });
    assert.equal(f.count('/acks'), 0); assert.equal(deliveries(f)[0].acked_at, null);
    assert.deepEqual(facts(storage), beforeFacts); assert.deepEqual(batchRows(storage), beforeBatches);
    if (mutation === 'same-size') assert.deepEqual(readFileSync(path), Buffer.alloc(bytes.length, 0x78));
  }
  assert.equal(deliveries(f)[0].read_at, null);
  t.diagnostic(`native receipt + prepareBatch committed -> SIGKILL -> renewed lease -> real file ${mutation} verification`);
});

for (const kind of ['ack', 'expiry']) test(`SIGKILL ${kind}: actual P3 COMMIT, withheld response, exact durable batch replay`, native, async t => {
  const f = await fixture(t), storage = f.provision(), args = acquireArgs();
  const message = f.directSend({ attachment: attachment() });
  // Expiry case first crashes with a genuine downloaded message fact, preserving
  // the old receipt/ACK batch. TEST ONLY SQL expiry is not a P6 executor claim.
  if (kind === 'expiry') {
    const first = await f.start(storage, { acquire: args, phase: 'prepareBatch' }); await first.next('leased');
    await phase(first, 'prepareBatch-committed'); await kill(first);
    expireFixtureContent(f, message);
  }
  const route = kind === 'ack' ? '/acks' : '/expiry-receipts', hold = f.hold(route);
  const child = await f.start(storage, { acquire: args, operation: kind === 'expiry' ? 'ack' : 'receive' });
  const { lease } = await child.next('leased');
  const response = await bounded(hold.entered.promise, 'P3 receipt commit');
  assert.equal(response.status, 200); assert.equal(response.socketBytesWritten, 0); assert.equal(response.writableEnded, false);
  assert.equal(f.db.isTransaction, false);
  await child.send({ type: 'server-commit-observed' }); await phase(child, 'server-response-withheld');
  // Full native rows, not counts/projections: a replay that refreshes an existing
  // recorded_at/acked_at or changes receipt identity must fail this comparison.
  const businessState = () => f.inspect(db => ({
    receipts: db.prepare('SELECT * FROM im_expiry_receipts ORDER BY recipient_id,center_epoch,stream_epoch,seq').all(),
    deliveries: db.prepare('SELECT * FROM im_deliveries ORDER BY recipient_id,seq').all(),
    audits: db.prepare(`SELECT * FROM im_audit WHERE action IN
      ('ack_delivery','expiry_receipt','message.read','message.accepted') ORDER BY id`).all(),
  }));
  const committed = businessState(), remote = committed.deliveries[0];
  assert.equal(committed.deliveries.length, 1);
  assert.equal(remote.acked_at !== null, kind === 'ack'); assert.equal(remote.read_at, null);
  assert.equal(committed.receipts.length, kind === 'expiry' ? 1 : 0);
  const action = kind === 'ack' ? 'ack_delivery' : 'expiry_receipt';
  assert.equal(committed.audits.filter(row => row.action === action).length, 1); lockHeld(storage);
  const originalTimestamp = kind === 'ack' ? remote.acked_at : committed.receipts[0].recorded_at;
  assert.equal(originalTimestamp, f.clock());
  // Read actual validity bounds before changing only the clock variable. The
  // fixture credentials/policy have no upper expiry; never extend stored rows.
  const bounds = f.inspect(db => ({
    lease: db.prepare('SELECT instance_id,generation,expires_at FROM im_receiver_leases WHERE agent_id=?').get(f.b),
    credentials: db.prepare('SELECT created_at,expires_at,revoked_at FROM im_credentials WHERE agent_id=?').all(f.b),
    policy: db.prepare('SELECT effective_at FROM im_retention_policies WHERE policy_hash=?').get(f.hash),
    content: db.prepare('SELECT expires_at FROM im_content_state WHERE message_id=?').get(message.messageId),
  }));
  assert.equal(bounds.lease.instance_id, lease.instanceId); assert.equal(bounds.lease.generation, lease.generation);
  assert.equal(bounds.lease.expires_at, lease.expiresAt);
  const advancedTime = originalTimestamp + 1;
  assert.ok(advancedTime > originalTimestamp && advancedTime < bounds.lease.expires_at);
  assert.ok(bounds.credentials.length > 0);
  for (const credential of bounds.credentials) {
    assert.equal(credential.revoked_at, null); assert.ok(advancedTime >= credential.created_at);
    assert.ok(credential.expires_at === null || advancedTime < credential.expires_at);
  }
  assert.ok(advancedTime >= bounds.policy.effective_at);
  if (kind === 'ack') assert.ok(advancedTime < bounds.content.expires_at);
  const batches = batchRows(storage), saved = batches.find(b => b.kind === kind);
  assert.equal(saved.state, 'pending'); assert.ok(facts(storage).every(row => row.server_confirmed === 0));
  const wire = f.requests.find(r => r.path === `/api/v2${route}`).body;
  await kill(child);
  f.advanceClock(advancedTime);
  assert.equal(f.clock(), advancedTime);
  const x = await restart(f, storage, args); assert.equal(x.lease.streamEpoch, lease.streamEpoch);
  assert.ok(x.lease.expiresAt > advancedTime, 'actual renewal supplies a currently valid lease');
  assert.equal(f.inspect(db => db.prepare('SELECT last_observed_at FROM im_clock WHERE singleton=1').get().last_observed_at),
    advancedTime, 'real cached guard consumed the advanced clock during recovery');
  assert.equal((await x.c.ackPending()).pending, false);
  const sent = f.requests.filter(r => r.path === `/api/v2${route}`);
  // The preserved obsolete ACK and the pending expiry from the same list page
  // may both schedule the same exact expiry batch. This remains bounded and
  // idempotent; absence of duplicate BUSINESS facts/audits is the contract.
  assert.ok(sent.length >= 2 && sent.length <= (kind === 'expiry' ? 3 : 2));
  for (const replay of sent.slice(1)) {
    assert.deepEqual(replay.body.items, wire.items);
    assert.equal(replay.body.generation, x.lease.generation);
    assert.equal(replay.body.streamEpoch, wire.streamEpoch);
    assert.equal(replay.body.centerEpoch, wire.centerEpoch);
  }
  assert.equal(batchRows(storage).find(b => b.kind === kind).batch_id, saved.batch_id);
  assert.deepEqual(businessState(), committed, 'exact replay must preserve complete receipt/delivery/business-audit rows, including timestamps');
  const receiver = x.journal.getReceiver(x.p, x.lease.streamEpoch);
  assert.equal(receiver.handled_cursor, 1); assert.equal(receiver.acked_cursor, kind === 'ack' ? 1 : 0);
  if (kind === 'expiry') {
    const old = x.journal.getReceivedFact(x.p, { streamEpoch: x.lease.streamEpoch, seq: 1, kind: 'message' });
    const expired = x.journal.getReceivedFact(x.p, { streamEpoch: x.lease.streamEpoch, seq: 1, kind: 'content_expired' });
    assert.equal(old.serverConfirmed, false); assert.equal(expired.serverConfirmed, true);
    assert.ok(old.attachmentReceipt); assert.ok(readFileSync(join(storage.files, old.attachmentReceipt.relativeName)).length);
    assert.equal(f.count('/acks'), 1, 'only pre-expiry-error ACK; no fake ACK on replay');
    assert.equal(batchRows(storage).find(b => b.kind === 'ack').state, 'pending');
  }
  t.diagnostic(`disk ${kind} committed timestamp=${originalTimestamp}, old lease expiry=${bounds.lease.expires_at}, ` +
    `policy effective=${bounds.policy.effective_at}, credential expiries=${JSON.stringify(bounds.credentials.map(row => row.expires_at))}; ` +
    `SIGKILL -> clock=${advancedTime}, actual renewed lease expiry=${x.lease.expiresAt} -> ${sent.length - 1} exact replay(s); ` +
    'complete receipt/delivery/business-audit rows unchanged, no timestamp refresh');
});

for (const kind of ['ack', 'expiry']) test(`SIGKILL after journal confirmBatch COMMIT before ${kind} operation response`, native, async t => {
  const f = await fixture(t), storage = f.provision(), args = acquireArgs();
  const message = f.directSend(); if (kind === 'expiry') expireFixtureContent(f, message);
  const child = await f.start(storage, { acquire: args, phase: 'confirmBatch' });
  const { lease } = await child.next('leased'); await phase(child, 'confirmBatch-committed'); lockHeld(storage);
  const before = inspectJournal(storage, journalRows), remote = deliveries(f), route = kind === 'ack' ? '/acks' : '/expiry-receipts';
  assert.equal(batchRows(storage)[0].state, 'confirmed'); assert.equal(facts(storage)[0].server_confirmed, 1);
  assert.equal(before.im_v2_client_receiver[0].handled_cursor, 1);
  const auditBefore = audit(f, kind === 'ack' ? 'ack_delivery' : 'expiry_receipt');
  await kill(child);
  const x = await restart(f, storage, args); assert.equal(x.lease.streamEpoch, lease.streamEpoch);
  const posts = f.count(route); assert.equal((await x.c.ackPending()).pending, false);
  assert.equal(f.count(route), posts, 'no unnecessary fresh receipt');
  assert.deepEqual(facts(storage), before.im_v2_client_received);
  assert.deepEqual(batchRows(storage), before.im_v2_client_batches);
  assert.deepEqual(deliveries(f), remote); assert.deepEqual(audit(f, kind === 'ack' ? 'ack_delivery' : 'expiry_receipt'), auditBefore);
  assert.equal(x.journal.getReceiver(x.p, lease.streamEpoch).handled_cursor, 1);
  t.diagnostic('native confirmBatch returned transaction=false -> SIGKILL before result IPC -> persisted cursor/fact/batch restored, zero new ACK/receipt');
});
