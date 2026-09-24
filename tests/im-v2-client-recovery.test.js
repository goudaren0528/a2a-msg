import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fixture, native, acquireArgs, attachment, expireFixtureContent, changeEpoch, count,
  parsedResponse, mutateResponse, authenticatedMeGate, observeJournal, syncPage,
  postBatch, recordMessages, boundedAck, deferred } from './fixtures/im-v2-client/harness.js';
import { PROTOCOL } from '../src/im/v2/contracts.js';

for (const kind of ['ack', 'expiry']) test(`${kind} commit-response loss survives orderly journal reopen and exact batch/current lease replay`, native, async t => {
  const f = await fixture(t), message = f.directSend({ attachment: kind === 'ack' ? attachment() : undefined });
  if (kind === 'expiry') expireFixtureContent(f, message);
  const path = kind === 'ack' ? '/api/v2/acks' : '/api/v2/expiry-receipts';
  let drop = true; const sent = [];
  const transport = async input => {
    const response = await f.forward(input);
    if (input.path === path) {
      sent.push(JSON.parse(input.body));
      if (drop) { drop = false; throw new Error('TEST committed response lost'); }
    }
    return response;
  };
  const x = f.client(1, { transport }), args = acquireArgs();
  const lease = await x.c.acquire(args), p = (await x.c.connect()).partitionId;
  await assert.rejects(x.c.receiveOnce(), { code: 'STORAGE_UNAVAILABLE' });
  const batch = x.journal.listBatches(p, { state: 'pending' }).items[0];
  assert.equal(batch.kind, kind);
  assert.equal(x.journal.getReceiver(p, lease.streamEpoch).handled_cursor, 0);
  const remote = f.native.prepare('SELECT acked_at,read_at FROM im_deliveries').get();
  assert.equal(remote.read_at, null);
  assert.equal(remote.acked_at !== null, kind === 'ack');
  await x.c.close(); x.db.close();
  const y = f.client(1, { transport }, f.open(x));
  const replayLease = await y.c.acquire(args);
  assert.equal(count(f, '/receiver/lease/renew'), 1, 'historical acquisition is renewed on actual center');
  assert.equal(replayLease.streamEpoch, lease.streamEpoch);
  const result = await y.c.ackPending();
  assert.equal(result.pending, false);
  assert.deepEqual(sent[1].items, sent[0].items);
  assert.equal(sent[1].generation, replayLease.generation);
  assert.equal(y.journal.listBatches(p, { state: 'confirmed' }).items[0].batchId, batch.batchId);
  assert.equal(y.journal.getReceiver(p, lease.streamEpoch).handled_cursor, 1);
  assert.equal(y.journal.getReceiver(p, lease.streamEpoch).acked_cursor, kind === 'ack' ? 1 : 0);
  assert.equal(f.native.prepare('SELECT read_at FROM im_deliveries').get().read_at, null);
});

test('ACK race resyncs tombstone, preserves file/message fact and obsolete pending batch, then processes live remainder', native, async t => {
  const f = await fixture(t), expired = f.directSend({ attachment: attachment() }), live = f.directSend();
  let race = true;
  const x = f.client(1, { transport: async input => {
    if (input.path === '/api/v2/acks' && race) { race = false; expireFixtureContent(f, expired); }
    return f.forward(input);
  } });
  const lease = await x.c.acquire(acquireArgs()), p = (await x.c.connect()).partitionId;
  const result = await x.c.receiveOnce();
  assert.deepEqual(result.items.map(x => [x.kind, x.status]), [['content_expired', 'expired_processed'], ['message', 'delivered']]);
  assert.equal(x.journal.getReceivedFact(p, { streamEpoch: lease.streamEpoch, seq: 1, kind: 'message' }).serverConfirmed, false);
  assert.equal(x.journal.getReceivedFact(p, { streamEpoch: lease.streamEpoch, seq: 1, kind: 'content_expired' }).serverConfirmed, true);
  const old = x.journal.listBatches(p, { state: 'pending' }).items[0];
  assert.equal(old.items.length, 2); assert.equal(old.ackDisposition.replayAllowed, false);
  assert.deepEqual(old.ackDisposition.expiryConfirmed, [{ seq: 1, messageId: expired.messageId }]);
  assert.deepEqual(old.ackDisposition.liveItems, [{ seq: 2, messageId: live.messageId }]);
  assert.equal(x.journal.getReceiver(p, lease.streamEpoch).handled_cursor, 2);
  assert.equal(x.journal.getReceiver(p, lease.streamEpoch).acked_cursor, 0);
  const before = count(f, '/acks');
  assert.equal((await x.c.ackPending()).pending, false);
  assert.equal(count(f, '/acks'), before, 'obsolete original is not replayed');
  assert.equal(f.native.prepare('SELECT acked_at FROM im_deliveries WHERE seq=1').get().acked_at, null);
});

test('authenticated expired download resyncs accurate tombstone; no fabricated delivery', native, async t => {
  const f = await fixture(t), message = f.directSend({ attachment: attachment() });
  let race = true;
  const x = f.client(1, { transport: async input => {
    if (input.binary && race) { race = false; expireFixtureContent(f, message); }
    return f.forward(input);
  } });
  await x.c.acquire(acquireArgs());
  const result = await x.c.receiveOnce();
  assert.equal(result.items[0].kind, 'content_expired'); assert.equal(result.items[0].status, 'expired_processed');
  assert.equal(count(f, '/acks'), 0); assert.equal(count(f, '/expiry-receipts'), 1);
  assert.equal(x.db.prepare("SELECT count(*) AS n FROM im_v2_client_received WHERE kind='message'").get().n, 0);
});

test('epoch change freezes send/ACK before mutation; manual reconciliation preserves old facts/outgoing; UNKNOWN remains original', native, async t => {
  const f = await fixture(t), sender = f.client(), receiver = f.client(1);
  const input = f.sendArgs(), accepted = await sender.c.send(input);
  const senderOld = (await sender.c.connect()).partitionId;
  await receiver.c.acquire(acquireArgs()); await receiver.c.receiveOnce();
  const receiverOld = (await receiver.c.connect()).partitionId;
  const pendingInput = f.sendArgs();
  sender.journal.stageOutgoing(senderOld, { ...pendingInput, protocol: PROTOCOL, centerEpoch: f.centerEpoch, originEpoch: f.centerEpoch });
  const before = f.requests.filter(x => x.method === 'POST').length;
  const nextEpoch = changeEpoch(f);
  await assert.rejects(sender.c.send(f.sendArgs()), { code: 'RECOVERY_RECONCILIATION_REQUIRED' });
  await assert.rejects(receiver.c.ackPending(), { code: 'RECOVERY_RECONCILIATION_REQUIRED' });
  assert.equal(f.requests.filter(x => x.method === 'POST').length, before);
  assert.equal(sender.db.prepare('SELECT status FROM im_v2_client_partitions').get().status, 'reconciliation_required');
  const next = await sender.c.reconcileEpoch({ oldPartitionId: senderOld, decisionRef: 'test explicit local consent' });
  assert.equal(next.centerEpoch, nextEpoch);
  const receiverNext = await receiver.c.reconcileEpoch({ oldPartitionId: receiverOld, decisionRef: 'test receiver consent' });
  assert.notEqual(receiverNext.partitionId, receiverOld);
  assert.equal(receiver.db.prepare('SELECT count(*) AS n FROM im_v2_client_received WHERE partition_id=?').get(receiverOld).n, 1);
  assert.equal(receiver.db.prepare('SELECT count(*) AS n FROM im_v2_client_received WHERE partition_id=?').get(receiverNext.partitionId).n, 0);
  const op = { originEpoch: f.centerEpoch, clientMessageId: pendingInput.clientMessageId };
  await assert.rejects(sender.c.recoverSend(op), { code: 'SEND_OUTCOME_UNKNOWN' });
  assert.equal(sender.journal.findOutgoing({ centerOrigin: f.origin, agentId: f.a, ...op }).outgoing.reconciliation_state, 'remote_unknown');
  assert.equal((await sender.c.getSendResult({ originEpoch: f.centerEpoch, clientMessageId: input.clientMessageId })).messageId, accepted.messageId);
  assert.equal(count(f, '/messages'), 1);
});

test('snapshot-restored missing accepted operation keeps local accepted ID/time while marking remote_unknown', native, async t => {
  const f = await fixture(t), sender = f.client();
  const snapshot = await f.snapshot();
  const original = f.sendArgs(), result = await sender.c.send(original);
  const old = (await sender.c.connect()).partitionId;
  // Actual SQLite backup predates acceptance; switch only this test's loopback
  // handler to a separately opened candidate, preserving accepted source DB.
  f.restore(snapshot);
  await assert.rejects(sender.c.connect(), { code: 'RECOVERY_RECONCILIATION_REQUIRED' });
  await sender.c.reconcileEpoch({ oldPartitionId: old, decisionRef: 'test manual consent' });
  await assert.rejects(sender.c.getSendResult({ originEpoch: f.centerEpoch, clientMessageId: original.clientMessageId }), { code: 'SEND_OUTCOME_UNKNOWN' });
  const retained = sender.journal.getOutgoing(old, { originEpoch: f.centerEpoch, clientMessageId: original.clientMessageId });
  assert.equal(retained.acceptance_state, 'accepted'); assert.equal(retained.message_id, result.messageId);
  assert.equal(retained.accepted_at, result.acceptedAt); assert.equal(retained.reconciliation_state, 'remote_unknown');
  assert.equal(f.native.prepare('SELECT message_id FROM im_messages').get().message_id, result.messageId);
  assert.equal(count(f, '/messages'), 1);
});

test('pending scan continuation walks obsolete pages instead of oldest-page starvation', native, async t => {
  const f = await fixture(t), x = f.client(1), lease = await x.c.acquire(acquireArgs());
  const p = (await x.c.connect()).partitionId;
  // Real sends + authentic sync DTOs; prepare overlapping distinct ACK batches
  // to exercise more than the ten-page budget without manufacturing facts.
  for (let i = 0; i < 5; i++) f.directSend();
  const reply = await f.forward({ method: 'GET', path: `/api/v2/sync?streamEpoch=${lease.streamEpoch}&after=0&limit=100`,
    credential: f.credentials[1], headers: { 'x-a2a-protocol': PROTOCOL, 'x-a2a-center-epoch': f.centerEpoch,
      'x-a2a-instance-id': lease.instanceId, 'x-a2a-generation': String(lease.generation) } });
  const items = parsedResponse(reply).data.items;
  for (const item of items) {
    x.journal.recordMessage(p, { streamEpoch: lease.streamEpoch, seq: item.seq, message: item.message, receipt: null });
    expireFixtureContent(f, item.message);
  }
  const expired = await f.forward({ method: 'GET', path: `/api/v2/sync?streamEpoch=${lease.streamEpoch}&after=0&limit=100`,
    credential: f.credentials[1], headers: { 'x-a2a-protocol': PROTOCOL, 'x-a2a-center-epoch': f.centerEpoch,
      'x-a2a-instance-id': lease.instanceId, 'x-a2a-generation': String(lease.generation) } });
  for (const item of parsedResponse(expired).data.items) x.journal.recordExpiry(p,
    { streamEpoch: lease.streamEpoch, seq: item.seq, tombstone: item.tombstone });
  for (let mask = 1; mask < 32; mask++) x.journal.prepareBatch(p, { streamEpoch: lease.streamEpoch, kind: 'ack',
    items: items.filter((_, i) => mask & (1 << i)).map(x => ({ seq: x.seq, messageId: x.message.messageId })) });
  let result = await x.c.ackPending({ limit: 1 });
  assert.equal(result.pending, true); assert.ok(result.continuation);
  const tokens = new Set(); let calls = 1;
  while (result.continuation && calls < 15) {
    const token = JSON.stringify(result.continuation);
    assert.equal(tokens.has(token), false, 'continuation moves past obsolete batches'); tokens.add(token);
    result = await x.c.ackPending({ limit: 1, continuation: result.continuation }); calls++;
  }
  assert.equal(result.pending, false); assert.ok(calls > 1 && calls < 15);
  assert.equal(count(f, '/acks'), 0);
  assert.equal(x.journal.getReceiver(p, lease.streamEpoch).handled_cursor, 5);
  assert.equal(x.journal.listBatches(p, { state: 'pending', limit: 100 }).items.length, 31);
  await assert.rejects(x.c.ackPending({ continuation: { partitionId: 'a'.repeat(64), pendingAfter: null, confirmedAfter: null, phase: 'pending' } }), { code: 'INVALID_REQUEST' });
});

test('ten mutation rounds maximum and continuation resumes remaining exact batches', native, async t => {
  const f = await fixture(t), x = f.client(1), lease = await x.c.acquire(acquireArgs());
  const p = (await x.c.connect()).partitionId;
  // 12 real, individual pending batches force the global per-call round cap.
  for (let i = 0; i < 12; i++) f.directSend();
  const reply = await f.forward({ method: 'GET', path: `/api/v2/sync?streamEpoch=${lease.streamEpoch}&after=0&limit=100`,
    credential: f.credentials[1], headers: { 'x-a2a-protocol': PROTOCOL, 'x-a2a-center-epoch': f.centerEpoch,
      'x-a2a-instance-id': lease.instanceId, 'x-a2a-generation': String(lease.generation) } });
  for (const item of parsedResponse(reply).data.items) {
    x.journal.recordMessage(p, { streamEpoch: lease.streamEpoch, seq: item.seq, message: item.message, receipt: null });
    x.journal.prepareBatch(p, { streamEpoch: lease.streamEpoch, kind: 'ack', items: [{ seq: item.seq, messageId: item.message.messageId }] });
  }
  const result = await x.c.ackPending();
  assert.equal(result.rounds, 10); assert.equal(count(f, '/acks'), 10); assert.equal(result.pending, true);
  assert.ok(result.continuation);
  const final = await x.c.ackPending({ continuation: result.continuation });
  assert.equal(final.pending, false); assert.equal(x.journal.getReceiver(p, lease.streamEpoch).handled_cursor, 12);
});

test('confirmed progressPending batch is rediscovered after reopen; 1000-prefix replay never invents local facts',
  { ...native, timeout: 90000 }, async t => {
    const f = await fixture(t), messages = [];
    for (let i = 0; i < 1100; i++) messages.push(f.directSend());
    let ackCalls = 0;
    const transport = async input => {
      const response = await f.forward(input);
      if (input.path === '/api/v2/acks' && ++ackCalls === 2) throw new Error('TEST second committed progress response lost');
      return response;
    };
    const x = f.client(1, { transport }), args = acquireArgs();
    const lease = await x.c.acquire(args), p = (await x.c.connect()).partitionId;
    // Actual center accepts ACKs for 2..1100 while seq 1 remains a hole. This
    // models an earlier receiver with durable facts not present in this journal.
    for (let start = 1; start < messages.length; start += 100) {
      const body = { protocol: PROTOCOL, centerEpoch: f.centerEpoch, instanceId: lease.instanceId,
        generation: lease.generation, streamEpoch: lease.streamEpoch,
        items: messages.slice(start, start + 100).map((m, i) => ({ seq: start + i + 1, messageId: m.messageId })) };
      const response = await f.forward({ method: 'POST', path: '/api/v2/acks', credential: f.credentials[1],
        headers: { 'x-a2a-protocol': PROTOCOL, 'x-a2a-center-epoch': f.centerEpoch, 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(body)) });
      assert.equal(response.status, 200);
      assert.equal(parsedResponse(response).data.handledThrough, 0);
    }
    await assert.rejects(x.c.receiveOnce({ limit: 1 }), { code: 'STORAGE_UNAVAILABLE' });
    const confirmed = x.journal.listBatches(p, { state: 'confirmed' }).items[0];
    assert.equal(confirmed.lastResponse.progressPending, true);
    assert.equal(confirmed.lastResponse.handledThrough, 1000);
    assert.equal(x.journal.getReceiver(p, lease.streamEpoch).handled_cursor, 1);
    await x.c.close(); x.db.close();
    const y = f.client(1, { transport }, f.open(x)); await y.c.acquire(args);
    const result = await y.c.ackPending();
    assert.equal(result.resyncRequired, true);
    assert.equal(result.pending, true);
    assert.equal(y.journal.getReceiver(p, lease.streamEpoch).handled_cursor, 1);
    assert.equal(y.journal.getReceiver(p, lease.streamEpoch).server_handled, 1100);
    assert.equal(y.db.prepare('SELECT count(*) AS n FROM im_v2_client_received').get().n, 1);
    assert.equal(ackCalls, 3, 'confirmed batch is replayed exactly once after reopen');
  });

test('ordinary repeated pending send is query-only on real current-epoch 404; explicit recovery alone may replay', native, async t => {
  const f = await fixture(t), attempts = []; let drop = true;
  const x = f.client(0, { transport: input => {
    if (input.path === '/api/v2/messages') {
      attempts.push(JSON.parse(input.body));
      if (drop) { drop = false; throw new Error('TEST before any server acceptance'); }
    }
    return f.forward(input);
  } });
  const input = f.sendArgs({ attachment: attachment() });
  await assert.rejects(x.c.send(input), { code: 'STORAGE_UNAVAILABLE' });
  const scope = { centerOrigin: f.origin, agentId: f.a, originEpoch: f.centerEpoch, clientMessageId: input.clientMessageId };
  const staged = x.journal.findOutgoing(scope);
  assert.equal(count(f, '/messages'), 0); assert.equal(staged.outgoing.acceptance_state, 'pending');
  for (let i = 0; i < 2; i++) {
    await assert.rejects(x.c.send(input), { code: 'SEND_OUTCOME_UNKNOWN' });
    assert.equal(attempts.length, 1, 'ordinary send never invokes POST for an existing pending operation');
    const saved = x.journal.findOutgoing(scope);
    assert.equal(saved.outgoing.acceptance_state, 'pending'); assert.deepEqual(saved.outgoing.request, staged.outgoing.request);
  }
  assert.equal(f.requests.filter(request => request.path === `/api/v2/sends/${f.centerEpoch}/${input.clientMessageId}`).length, 2);
  await x.c.recoverSend({ originEpoch: f.centerEpoch, clientMessageId: input.clientMessageId });
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[1], attempts[0]); assert.equal(count(f, '/messages'), 1);
});

test('same epoch/new stable identity reconciliation cannot copy, duplicate or repost old-partition outgoing', native, async t => {
  const f = await fixture(t); let replacement = null, drop = true, posts = 0;
  const gate = authenticatedMeGate(f, response => replacement ? mutateResponse(response, body => {
    body.data.instanceId = replacement;
  }) : response);
  const x = f.client(0, { transport: input => {
    if (input.path === '/api/v2/messages') { posts++; if (drop) { drop = false; throw new Error('TEST preaccept'); } }
    return gate.transport(input);
  } });
  const input = f.sendArgs(); await assert.rejects(x.c.send(input), { code: 'STORAGE_UNAVAILABLE' });
  const old = await x.c.connect(), op = { originEpoch: f.centerEpoch, clientMessageId: input.clientMessageId };
  const scope = { centerOrigin: f.origin, agentId: f.a, ...op }, saved = x.journal.findOutgoing(scope).outgoing;
  replacement = randomUUID();
  await assert.rejects(x.c.connect(), { code: 'RECOVERY_RECONCILIATION_REQUIRED' });
  const current = await x.c.reconcileEpoch({ oldPartitionId: old.partitionId, decisionRef: 'TEST stable instance replacement' });
  assert.equal(current.centerEpoch, old.centerEpoch); assert.notEqual(current.partitionId, old.partitionId);
  const retained = () => {
    assert.equal(x.journal.getOutgoing(current.partitionId, op), null);
    const found = x.journal.findOutgoing(scope); assert.equal(found.partition.partitionId, old.partitionId);
    assert.deepEqual(found.outgoing.request, saved.request); assert.equal(found.outgoing.acceptance_state, 'pending');
    assert.equal(x.db.prepare('SELECT count(*) AS n FROM im_v2_client_outgoing').get().n, 1);
    assert.equal(posts, 1); assert.equal(count(f, '/messages'), 0);
  };
  await assert.rejects(x.c.send({ ...input, text: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' }); retained();
  await assert.rejects(x.c.send(input), { code: 'SEND_OUTCOME_UNKNOWN' }); retained();
  assert.ok(f.requests.some(request => request.path === `/api/v2/sends/${op.originEpoch}/${op.clientMessageId}`));
  await assert.rejects(x.c.recoverSend(op), { code: 'SEND_OUTCOME_UNKNOWN' }); retained();
});

for (const knownUnrelatedExpiry of [false, true]) test(
  `far expired ACK at local zero (${knownUnrelatedExpiry ? 'known unrelated tombstone' : 'all live first page'}) yields bounded resync and later work`,
  { ...native, timeout: 60000 }, async t => {
    const f = await fixture(t); let recordedAt = 1000;
    const x = f.client(1, {}, observeJournal(f.open(f.provision(), { clock: () => ++recordedAt })));
    const lease = await x.c.acquire(acquireArgs()), p = (await x.c.connect()).partitionId;
    for (let i = 0; i < 102; i++) f.directSend();
    const first = await syncPage(f, lease);
    // Prior authenticated consumer has advanced the CENTER only. Local cursor
    // stays zero. This makes seq101 available without a fabricated sync page.
    await postBatch(f, lease, first.items.map(item => ({ seq: item.seq, messageId: item.message.messageId })));
    const far = await syncPage(f, lease, 100), target = far.items[0], later = far.items[1];
    recordMessages(x, p, lease.streamEpoch, far.items);
    const obsolete = x.journal.listBatches(p, { state: 'pending' }).items.find(batch => batch.items[0].seq === 101);
    expireFixtureContent(f, target.message);
    if (knownUnrelatedExpiry) {
      expireFixtureContent(f, first.items[0].message);
      const authentic = (await syncPage(f, lease)).items[0];
      x.journal.recordExpiry(p, { streamEpoch: lease.streamEpoch, seq: authentic.seq, tombstone: authentic.tombstone });
    }
    assert.equal(x.journal.getReceiver(p, lease.streamEpoch).handled_cursor, 0);
    let call = await boundedAck(f, x, { limit: 1 });
    assert.equal(call.result.pending, true); assert.equal(call.result.resyncRequired, true);
    const syncs = call.requests.filter(request => request.path.startsWith('/api/v2/sync?'));
    assert.ok(syncs.length >= 1 && syncs.length <= 2, 'no ten identical resync attempts due to unrelated expiry');
    for (const request of syncs) assert.equal(new URL(request.path, f.origin).searchParams.get('after'), '0');
    assert.equal(x.journal.getReceivedFact(p, { streamEpoch: lease.streamEpoch, seq: 101, kind: 'content_expired' }), null);
    assert.equal(x.journal.getReceiver(p, lease.streamEpoch).handled_cursor, 0);
    // A blocked batch must not starve the following live batch across explicit
    // continuations; a single call need not empty the queue.
    const tokens = new Set();
    for (let i = 0; i < 4 && !x.journal.getReceivedFact(p, { streamEpoch: lease.streamEpoch, seq: 102, kind: 'message' }).serverConfirmed; i++) {
      assert.ok(call.result.continuation);
      const token = JSON.stringify(call.result.continuation); assert.equal(tokens.has(token), false); tokens.add(token);
      call = await boundedAck(f, x, { limit: 1, continuation: call.result.continuation });
    }
    assert.equal(x.journal.getReceivedFact(p, { streamEpoch: lease.streamEpoch, seq: 102, kind: 'message' }).serverConfirmed, true);
    assert.equal(f.native.prepare('SELECT read_at FROM im_deliveries WHERE message_id=?').get(later.message.messageId).read_at, null);
    // Finish the issued scan through the confirmed phase/empty tail. The
    // deferred target-resync flag is private; four-field JSON copies cannot
    // discard it merely because no further batch page remains.
    for (let i = 0; call.result.continuation && i < 8; i++) {
      call = await boundedAck(f, x, { limit: 1, continuation: JSON.parse(JSON.stringify(call.result.continuation)) });
      assert.equal(call.result.pending, true); assert.equal(call.result.resyncRequired, true);
    }
    assert.equal(call.result.continuation, null);
    assert.equal(call.result.pending, true); assert.equal(call.result.resyncRequired, true);
    // Explicit receives traverse earlier real pages and eventually obtain the
    // exact target tombstone. No caller cursor or guessed expiry proof is used.
    for (let i = 0; i < 5 && !x.journal.getReceivedFact(p, { streamEpoch: lease.streamEpoch, seq: 101, kind: 'content_expired' })?.serverConfirmed; i++) {
      await x.c.receiveOnce({ limit: 100 });
    }
    const fact = x.journal.getReceivedFact(p, { streamEpoch: lease.streamEpoch, seq: 101, kind: 'content_expired' });
    assert.equal(fact?.serverConfirmed, true); assert.equal(fact.messageId, target.message.messageId);
    const authenticTarget = (await syncPage(f, lease, 100)).items[0];
    assert.deepEqual(fact.fact, authenticTarget.tombstone);
    const old = x.journal.listBatches(p, { state: 'pending', limit: 100 }).items.find(batch => batch.batchId === obsolete.batchId);
    assert.ok(old); assert.equal(old.kind, 'ack'); assert.equal(old.itemsHash, obsolete.itemsHash); assert.deepEqual(old.items, obsolete.items);
    assert.equal(old.ackDisposition.replayAllowed, false);
  });

test('durable confirmed gap survives empty continuation, tampering and total per-operation scan budget', native, async t => {
  const f = await fixture(t), x = f.client(1, {}, observeJournal(f.open(f.provision())));
  const lease = await x.c.acquire(acquireArgs()), p = (await x.c.connect()).partitionId;
  for (let i = 0; i < 11; i++) f.directSend();
  const items = (await syncPage(f, lease)).items;
  const response = await postBatch(f, lease, items.map(item => ({ seq: item.seq, messageId: item.message.messageId })));
  assert.equal(response.data.handledThrough, 11);
  recordMessages(x, p, lease.streamEpoch, items.slice(1));
  for (const batch of x.journal.listBatches(p, { state: 'pending' }).items) x.journal.confirmBatch(batch.batchId, response);
  const invariant = () => {
    assert.equal(x.journal.getReceiver(p, lease.streamEpoch).handled_cursor, 0);
    assert.equal(x.journal.getReceiver(p, lease.streamEpoch).server_handled, 11);
    assert.equal(x.journal.getReceivedFact(p, { streamEpoch: lease.streamEpoch, seq: 1, kind: 'message' }), null);
    assert.equal(x.db.prepare('SELECT count(*) AS n FROM im_v2_client_received').get().n, 10);
  };
  invariant();
  const first = (await boundedAck(f, x)).result;
  assert.equal(first.rounds, 10); assert.equal(first.pending, true); assert.equal(first.resyncRequired, true); assert.ok(first.continuation);
  const next = (await boundedAck(f, x, { continuation: first.continuation })).result;
  assert.equal(next.pending, true); assert.equal(next.resyncRequired, true); invariant();
  assert.equal(next.progressPending, true); assert.equal(next.continuation, null);
  // Scoped tokens may guide scanning but must not confer authority to erase a
  // durable stream gap. Preserve optional proof fields introduced by the writer.
  const tampered = { ...structuredClone(first.continuation), pendingAfter: null, phase: 'confirmed',
    confirmedAfter: Buffer.from(JSON.stringify([2, 'batches', p, 'confirmed', Number.MAX_SAFE_INTEGER, 'f'.repeat(64)])).toString('base64url') };
  if ('resyncRequired' in tampered) tampered.resyncRequired = false;
  try {
    const result = (await boundedAck(f, x, { continuation: tampered })).result;
    assert.equal(result.pending, true); assert.equal(result.resyncRequired, true);
  } catch (error) { assert.equal(error.code, 'INVALID_REQUEST'); }
  invariant();
  await assert.rejects(boundedAck(f, x, { continuation: { ...first.continuation, partitionId: 'f'.repeat(64) } }), { code: 'INVALID_REQUEST' });
  await assert.rejects(boundedAck(f, x, { continuation: { ...first.continuation,
    confirmedAfter: Buffer.from(JSON.stringify([2, 'batches', 'f'.repeat(64), 'confirmed', 0, 'a'.repeat(64)])).toString('base64url') } }), { code: 'INVALID_REQUEST' });
  invariant();
  const fresh = (await boundedAck(f, x)).result;
  assert.equal(fresh.pending, true); assert.equal(fresh.progressPending, true); assert.equal(fresh.resyncRequired, true);
  invariant();
  // Only explicit receive obtains the genuinely missing seq1 fact. Replaying
  // confirmed batches or exhausting their scan cannot invent that fact.
  await x.c.receiveOnce({ limit: 11 });
  await finishScan(f, x);
  const recovered = x.journal.getReceiver(p, lease.streamEpoch);
  for (const field of ['handled_cursor', 'acked_cursor', 'server_handled', 'server_acked']) assert.equal(recovered[field], 11);
  assert.equal(x.journal.getReceivedFact(p, { streamEpoch: lease.streamEpoch, seq: 1, kind: 'message' }).serverConfirmed, true);
});

test('undiscovered far-expiry deferral survives continuation with all durable watermarks equal', native, async t => {
  const f = await fixture(t), x = f.client(1, {}, observeJournal(f.open(f.provision())));
  const lease = await x.c.acquire(acquireArgs()), p = (await x.c.connect()).partitionId;
  for (let i = 0; i < 105; i++) f.directSend();
  const first = await syncPage(f, lease);
  await postBatch(f, lease, first.items.map(item => ({ seq: item.seq, messageId: item.message.messageId })));
  const far = await syncPage(f, lease, 100);
  assert.equal(far.items.length, 5);
  recordMessages(x, p, lease.streamEpoch, far.items, { batches: false });
  for (const item of far.items) expireFixtureContent(f, item.message);
  for (let mask = 1; mask < 32; mask++) x.journal.prepareBatch(p, { streamEpoch: lease.streamEpoch, kind: 'ack',
    items: far.items.filter((_, i) => mask & (1 << i)).map(item => ({ seq: item.seq, messageId: item.message.messageId })) });
  const unchanged = () => {
    const row = x.journal.getReceiver(p, lease.streamEpoch);
    for (const field of ['handled_cursor', 'acked_cursor', 'server_handled', 'server_acked']) assert.equal(row[field], 0);
    for (const item of far.items) assert.equal(x.journal.getReceivedFact(p,
      { streamEpoch: lease.streamEpoch, seq: item.seq, kind: 'content_expired' }), null);
  };
  unchanged();
  let result = (await boundedAck(f, x, { limit: 1 })).result, calls = 1;
  assert.ok(result.continuation);
  while (result.continuation && calls < 10) {
    assert.equal(result.pending, true); assert.equal(result.resyncRequired, true); unchanged();
    result = (await boundedAck(f, x, { limit: 1, continuation: JSON.parse(JSON.stringify(result.continuation)) })).result;
    calls++;
  }
  assert.ok(calls > 1 && calls < 10);
  assert.equal(result.continuation, null); assert.equal(result.pending, true);
  assert.equal(result.progressPending, true); assert.equal(result.resyncRequired, true); unchanged();
  assert.equal(x.journal.listBatches(p, { state: 'pending', limit: 100 }).items.length, 31);
  assert.equal(count(f, '/expiry-receipts'), 0);
});

for (const forgery of ['confirmed-phase', 'pending-fake-tail', 'confirmed-fake-tail']) test(
  `unissued continuation ${forgery} cannot report completion over a real pending ACK at zero watermarks`, native, async t => {
    const f = await fixture(t), x = f.client(1, {}, observeJournal(f.open(f.provision())));
    const lease = await x.c.acquire(acquireArgs()), p = (await x.c.connect()).partitionId;
    const message = f.directSend();
    recordMessages(x, p, lease.streamEpoch, (await syncPage(f, lease)).items);
    const original = x.journal.listBatches(p, { state: 'pending' }).items[0];
    const before = x.journal.getReceiver(p, lease.streamEpoch);
    for (const field of ['handled_cursor', 'acked_cursor', 'server_handled', 'server_acked']) assert.equal(before[field], 0);
    assert.equal(count(f, '/acks'), 0);
    // Valid journal cursor encoding/scope, deliberately beyond every real row.
    // It is a scan position, not proof that preceding work has been handled.
    const tail = state => Buffer.from(JSON.stringify([
      2, 'batches', p, state, Number.MAX_SAFE_INTEGER, 'f'.repeat(64),
    ])).toString('base64url');
    const continuation = { partitionId: p, pendingAfter: null, confirmedAfter: null, phase: 'confirmed' };
    if (forgery === 'pending-fake-tail') {
      continuation.phase = 'pending'; continuation.pendingAfter = tail('pending');
    }
    if (forgery === 'confirmed-fake-tail') {
      continuation.pendingAfter = tail('pending'); continuation.confirmedAfter = tail('confirmed');
    }
    await assert.rejects(boundedAck(f, x, { continuation }), { code: 'INVALID_REQUEST' });
    const fact = x.journal.getReceivedFact(p, { streamEpoch: lease.streamEpoch, seq: 1, kind: 'message' });
    const remote = f.native.prepare('SELECT acked_at,read_at FROM im_deliveries WHERE message_id=?').get(message.messageId);
    assert.equal(remote.read_at, null); assert.equal(remote.acked_at, null);
    assert.equal(fact.serverConfirmed, false); assert.equal(count(f, '/acks'), 0);
    assert.equal(x.journal.getReceiver(p, lease.streamEpoch).handled_cursor, 0);
    const retained = x.journal.listBatches(p, { state: 'pending' }).items.find(batch => batch.batchId === original.batchId);
    assert.ok(retained); assert.equal(retained.itemsHash, original.itemsHash); assert.deepEqual(retained.items, original.items);
    const final = (await boundedAck(f, x)).result;
    assert.equal(final.pending, false);
    assert.equal(x.journal.getReceivedFact(p, { streamEpoch: lease.streamEpoch, seq: 1, kind: 'message' }).serverConfirmed, true);
    assert.equal(count(f, '/acks'), 1);
  });

test('restart rejects prior live-client continuation; fresh head scan rediscovers exact remaining ACKs', native, async t => {
  const f = await fixture(t), x = f.client(1, {}, observeJournal(f.open(f.provision()))), args = acquireArgs();
  const lease = await x.c.acquire(args), p = (await x.c.connect()).partitionId;
  for (let i = 0; i < 12; i++) f.directSend();
  recordMessages(x, p, lease.streamEpoch, (await syncPage(f, lease)).items);
  let result = (await boundedAck(f, x)).result;
  assert.equal(result.pending, true); assert.ok(result.continuation);
  const remaining = x.journal.listBatches(p, { state: 'pending' }).items;
  assert.equal(remaining.length, 2); assert.equal(count(f, '/acks'), 10);
  const continuation = structuredClone(result.continuation);
  await x.c.close(); x.db.close();
  const sent = [];
  const y = f.client(1, { transport: input => {
    if (input.path === '/api/v2/acks') sent.push(JSON.parse(input.body));
    return f.forward(input);
  } }, observeJournal(f.open(x)));
  const renewed = await y.c.acquire(args);
  assert.equal(renewed.streamEpoch, lease.streamEpoch);
  await assert.rejects(boundedAck(f, y, { continuation }), { code: 'INVALID_REQUEST' });
  assert.equal(sent.length, 0);
  result = (await boundedAck(f, y)).result;
  const seen = new Set();
  for (let i = 0; result.pending && i < 4; i++) {
    assert.ok(result.continuation, 'bounded legitimate continuation remains resumable');
    const key = JSON.stringify(result.continuation); assert.equal(seen.has(key), false); seen.add(key);
    result = (await boundedAck(f, y, { continuation: result.continuation })).result;
  }
  assert.equal(result.pending, false); assert.equal(count(f, '/acks'), 12);
  assert.deepEqual(sent.map(body => body.items), remaining.map(batch => batch.items));
  assert.equal(y.journal.getReceiver(p, lease.streamEpoch).handled_cursor, 12);
  assert.equal(y.journal.listBatches(p, { state: 'pending' }).items.length, 0);
});

// Five genuine messages provide 31 distinct canonical overlapping ACK batches.
// Sorting the independently computed IDs establishes a deliberately omitted
// lowest key without relying on UUID randomness or backdating SQL rows.
async function continuationFixture(t, { hooks, transport } = {}) {
  const f = await fixture(t), opened = f.open(f.provision(), { clock: () => 1000 });
  const x = f.client(1, transport ? { transport: input => transport(input, f) } : {}, observeJournal(opened, hooks));
  const args = acquireArgs(), lease = await x.c.acquire(args), p = (await x.c.connect()).partitionId;
  for (let i = 0; i < 5; i++) f.directSend();
  const items = (await syncPage(f, lease)).items;
  recordMessages(x, p, lease.streamEpoch, items, { batches: false });
  const candidates = [];
  for (let mask = 1; mask < 32; mask++) {
    const refs = items.filter((_, i) => mask & (1 << i)).map(item => ({ seq: item.seq, messageId: item.message.messageId }));
    const id = createHash('sha256').update(JSON.stringify([p, lease.streamEpoch, 'ack', refs])).digest('hex');
    candidates.push({ id, refs });
  }
  candidates.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const insert = (journal, candidate) => {
    const batch = journal.prepareBatch(p, { streamEpoch: lease.streamEpoch, kind: 'ack', items: candidate.refs });
    assert.equal(batch.batch_id, candidate.id); assert.equal(batch.created_at, 1000);
    return batch;
  };
  for (const candidate of candidates.slice(1)) insert(x.journal, candidate);
  assert.deepEqual(x.journal.listBatches(p, { state: 'pending', limit: 100 }).items.map(batch => batch.batchId), candidates.slice(1).map(c => c.id));
  return { f, x, lease, p, candidates, insert, opened, args };
}

async function finishScan(f, x, options = { limit: 1 }) {
  let call = await boundedAck(f, x, options), calls = 1;
  const seen = new Set();
  while (call.result.pending && calls < 15) {
    assert.ok(call.result.continuation, 'finite scan has an explicit continuation');
    const copy = JSON.parse(JSON.stringify(call.result.continuation));
    assert.deepEqual(Object.keys(copy).sort(), ['confirmedAfter', 'partitionId', 'pendingAfter', 'phase']);
    const key = JSON.stringify(copy); assert.equal(seen.has(key), false); seen.add(key);
    call = await boundedAck(f, x, { limit: 1, continuation: copy }); calls++;
  }
  assert.equal(call.result.pending, false); assert.ok(calls < 15);
  assert.equal(call.result.progressPending, false); assert.equal(call.result.resyncRequired, false);
  assert.equal(call.result.continuation, null);
  return calls;
}

test('continuation fixture uses real frozen change stamps and independently ordered native batches', native, async t => {
  const { f, x, p, candidates, insert } = await continuationFixture(t);
  const first = x.journal.getChangeStamp();
  assert.equal(Object.isFrozen(first), true); assert.equal(typeof first.connectionId, 'string');
  assert.equal(typeof first.localChanges, 'bigint'); assert.equal(typeof first.externalVersion, 'bigint');
  assert.deepEqual(x.journal.getChangeStamp(), first);
  insert(x.journal, candidates[0]);
  const local = x.journal.getChangeStamp();
  assert.equal(local.connectionId, first.connectionId); assert.ok(local.localChanges > first.localChanges);
  assert.equal(local.externalVersion, first.externalVersion);
  const other = f.open(x, { clock: () => 1000 });
  assert.notEqual(other.journal.getChangeStamp().connectionId, first.connectionId);
  assert.equal(other.journal.listBatches(p, { state: 'pending', limit: 100 }).items.length, 31);
});

test('last-issued JSON continuation works across >=11 real pages; superseded token is rejected', native, async t => {
  const { f, x, p } = await continuationFixture(t);
  const first = await boundedAck(f, x, { limit: 1 }); assert.ok(first.result.continuation);
  const old = JSON.parse(JSON.stringify(first.result.continuation));
  const second = await boundedAck(f, x, { limit: 1, continuation: JSON.parse(JSON.stringify(old)) });
  assert.ok(second.result.continuation); assert.notDeepEqual(second.result.continuation, old);
  assert.ok(first.stampReads > 0 && second.stampReads > 0);
  await assert.rejects(boundedAck(f, x, { limit: 1, continuation: old }), { code: 'INVALID_REQUEST' });
  // Invalid invocation clears issuance. A fresh head scan is always usable.
  await assert.rejects(boundedAck(f, x, { continuation: second.result.continuation }), { code: 'INVALID_REQUEST' });
  await finishScan(f, x);
  assert.equal(x.journal.listBatches(p, { state: 'pending', limit: 100 }).items.length, 0);
});

test('unchanged native journal completes >=11 pages with own confirmations and JSON-copy continuations', native, async t => {
  const { f, x, p } = await continuationFixture(t);
  const calls = await finishScan(f, x);
  assert.ok(calls > 1, 'thirty batches at limit one exceed a single ten-page operation');
  assert.equal(x.journal.listBatches(p, { state: 'confirmed', limit: 100 }).items.length, 30);
  assert.equal(count(f, '/acks'), 30);
});

test('issued continuation cannot cross partition or another live client', native, async t => {
  const { f, x, args } = await continuationFixture(t);
  const first = (await boundedAck(f, x, { limit: 1 })).result;
  const y = f.client(1, {}, observeJournal(f.open(f.provision())));
  await y.c.acquire(args);
  // Same origin/agent/identity partition, distinct live consumer/journal: scope
  // equality alone is insufficient to establish private issuance authority.
  const before = count(f, '/acks');
  await assert.rejects(boundedAck(f, y, { continuation: JSON.parse(JSON.stringify(first.continuation)) }), { code: 'INVALID_REQUEST' });
  await assert.rejects(boundedAck(f, x, { continuation: { ...first.continuation, partitionId: 'f'.repeat(64) } }), { code: 'INVALID_REQUEST' });
  assert.equal(count(f, '/acks'), before);
});

for (const connection of ['same', 'second']) test(
  `issued continuation detects ${connection}-connection public batch insertion behind its exact cursor`, native, async t => {
    const { f, x, p, candidates, insert } = await continuationFixture(t);
    const first = (await boundedAck(f, x, { limit: 1 })).result;
    assert.ok(first.continuation?.pendingAfter);
    const cursor = JSON.parse(Buffer.from(first.continuation.pendingAfter, 'base64url').toString('utf8'));
    assert.equal(cursor[2], p); assert.equal(cursor[3], 'pending'); assert.equal(cursor[4], 1000);
    assert.ok(candidates[0].id < cursor[5], 'inserted key is demonstrably before issued cursor at identical createdAt');
    // Second connection is a trusted storage writer, not a second client owner.
    const writer = connection === 'same' ? x : f.open(x, { clock: () => 1000 });
    const beforeStamp = x.journal.getChangeStamp(), beforePosts = count(f, '/acks');
    insert(writer.journal, candidates[0]);
    const afterStamp = x.journal.getChangeStamp();
    if (connection === 'same') assert.ok(afterStamp.localChanges > beforeStamp.localChanges);
    else assert.ok(afterStamp.externalVersion > beforeStamp.externalVersion);
    await assert.rejects(boundedAck(f, x, { limit: 1, continuation: JSON.parse(JSON.stringify(first.continuation)) }), { code: 'PLAN_STALE' });
    assert.equal(count(f, '/acks'), beforePosts);
    assert.ok(x.journal.listBatches(p, { state: 'pending', limit: 100 }).items.some(batch => batch.batchId === candidates[0].id));
    await assert.rejects(boundedAck(f, x, { continuation: first.continuation }), { code: 'INVALID_REQUEST' });
    await finishScan(f, x);
    assert.ok(x.journal.listBatches(p, { state: 'confirmed', limit: 100 }).items.some(batch => batch.batchId === candidates[0].id));
  });

test('public batch write during authenticated ACK await invalidates scan and fresh head recovers', native, async t => {
  const entered = deferred(), release = deferred(); let gate = false;
  const setup = await continuationFixture(t, { transport: async (input, f) => {
    const response = await f.forward(input);
    if (gate && input.path === '/api/v2/acks') { gate = false; entered.resolve(); await release.promise; }
    return response;
  } });
  const { f, x, candidates, insert, p, lease } = setup;
  gate = true;
  const outcome = boundedAck(f, x, { limit: 1 }).then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([entered.promise, outcome.then(result => { throw result.error ?? new Error('TEST ACK gate not reached'); })]);
    insert(x.journal, candidates[0]);
  } finally { release.resolve(); }
  assert.equal((await outcome).error?.code, 'PLAN_STALE');
  await finishScan(f, x);
  assert.equal(x.journal.listBatches(p, { state: 'confirmed', limit: 100 }).items.length, 31);
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM im_v2_client_received').get().n, 5);
  assert.equal(x.journal.listBatches(p, { state: 'pending', limit: 100 }).items.length, 0);
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM im_v2_client_received WHERE server_confirmed=1').get().n, 5);
  const receiver = x.journal.getReceiver(p, lease.streamEpoch);
  for (const field of ['handled_cursor', 'acked_cursor', 'server_handled', 'server_acked']) assert.equal(receiver[field], 5);
});

test('external commit after own confirm stays committed while PLAN_STALE prevents false completion', native, async t => {
  let armed = false, injected = false, writer, setup, confirmedId;
  const hooks = { after(name, args) {
    if (armed && name === 'confirmBatch') {
      armed = false; confirmedId = args[0];
      setup.insert(writer.journal, setup.candidates[0]); injected = true;
    }
  } };
  setup = await continuationFixture(t, { hooks });
  const { f, x, p } = setup; writer = f.open(x, { clock: () => 1000 }); armed = true;
  await assert.rejects(boundedAck(f, x, { limit: 1 }), { code: 'PLAN_STALE' });
  assert.equal(injected, true);
  const confirmed = x.journal.listBatches(p, { state: 'confirmed', limit: 100 }).items.find(batch => batch.batchId === confirmedId);
  assert.ok(confirmed, 'already committed confirmation is not compensated away');
  for (const item of confirmed.items) assert.equal(x.journal.getReceivedFact(p, {
    streamEpoch: confirmed.streamEpoch, seq: item.seq, kind: 'message',
  }).serverConfirmed, true);
  await finishScan(f, x);
  assert.equal(x.journal.listBatches(p, { state: 'confirmed', limit: 100 }).items.length, 31);
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM im_v2_client_received').get().n, 5);
});

test('new batch after final empty page but before actual stamp check cannot yield complete', native, async t => {
  const f = await fixture(t); let armed = false, inserted = false, add;
  const x = f.client(1, {}, observeJournal(f.open(f.provision()), { after(name, args, value) {
    if (armed && name === 'listBatches' && args[1].state === 'confirmed' && value.items.length === 0 && value.nextCursor === null) {
      armed = false; add(); inserted = true;
    }
  } }));
  const lease = await x.c.acquire(acquireArgs()), p = (await x.c.connect()).partitionId;
  f.directSend(); const items = (await syncPage(f, lease)).items;
  recordMessages(x, p, lease.streamEpoch, items, { batches: false });
  add = () => x.journal.prepareBatch(p, { streamEpoch: lease.streamEpoch, kind: 'ack',
    items: [{ seq: 1, messageId: items[0].message.messageId }] });
  armed = true;
  await assert.rejects(boundedAck(f, x), { code: 'PLAN_STALE' });
  assert.equal(inserted, true); assert.equal(count(f, '/acks'), 0);
  assert.equal(x.journal.getReceivedFact(p, { streamEpoch: lease.streamEpoch, seq: 1, kind: 'message' }).serverConfirmed, false);
  await finishScan(f, x);
  assert.equal(count(f, '/acks'), 1);
});

test('continuation is consumed on entry and cleared by transport error; replay requires fresh head scan', native, async t => {
  let drop = false;
  const { f, x, p } = await continuationFixture(t, { transport: (input, f) => {
    if (drop && input.path === '/api/v2/acks') { drop = false; throw new Error('TEST before ACK on resumed scan'); }
    return f.forward(input);
  } });
  const first = (await boundedAck(f, x, { limit: 1 })).result;
  const token = JSON.parse(JSON.stringify(first.continuation)); drop = true;
  await assert.rejects(boundedAck(f, x, { limit: 1, continuation: token }), { code: 'STORAGE_UNAVAILABLE' });
  const before = count(f, '/acks');
  await assert.rejects(boundedAck(f, x, { continuation: token }), { code: 'INVALID_REQUEST' });
  assert.equal(count(f, '/acks'), before);
  await finishScan(f, x);
  assert.equal(x.journal.listBatches(p, { state: 'pending', limit: 100 }).items.length, 0);
});

test('final completion clears last issued token without granting replay authority', native, async t => {
  const { f, x } = await continuationFixture(t);
  let result = (await boundedAck(f, x, { limit: 1 })).result, last;
  for (let i = 0; result.pending && i < 12; i++) {
    last = JSON.parse(JSON.stringify(result.continuation));
    result = (await boundedAck(f, x, { limit: 1, continuation: last })).result;
  }
  assert.equal(result.pending, false); assert.ok(last);
  const before = count(f, '/acks');
  await assert.rejects(boundedAck(f, x, { continuation: last }), { code: 'INVALID_REQUEST' });
  assert.equal(count(f, '/acks'), before);
});

test('batch insertion during genuine attachment verification await invalidates ACK scan', native, async t => {
  const f = await fixture(t), firstMessage = f.directSend({ attachment: attachment() }); f.directSend();
  const opened = f.open(f.provision()), entered = deferred(), release = deferred();
  let blockVerify = false, drop = true;
  const x = f.client(1, {
    attachments: { ...opened.attachments, async verify(input) {
      const result = await opened.attachments.verify(input);
      if (blockVerify) { blockVerify = false; entered.resolve(); await release.promise; }
      return result;
    } },
    transport(input) {
      if (drop && input.path === '/api/v2/acks') { drop = false; throw new Error('TEST initial ACK not sent'); }
      return f.forward(input);
    },
  }, observeJournal(opened));
  const lease = await x.c.acquire(acquireArgs()), p = (await x.c.connect()).partitionId;
  await assert.rejects(x.c.receiveOnce({ limit: 1 }), { code: 'STORAGE_UNAVAILABLE' });
  const page = await syncPage(f, lease);
  const other = page.items[1];
  x.journal.recordMessage(p, { streamEpoch: lease.streamEpoch, seq: other.seq, message: other.message, receipt: null });
  blockVerify = true;
  const outcome = boundedAck(f, x).then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([entered.promise, outcome.then(result => { throw result.error ?? new Error('TEST file verify gate not reached'); })]);
    x.journal.prepareBatch(p, { streamEpoch: lease.streamEpoch, kind: 'ack', items: [{ seq: other.seq, messageId: other.message.messageId }] });
  } finally { release.resolve(); }
  assert.equal((await outcome).error?.code, 'PLAN_STALE');
  assert.equal(count(f, '/acks'), 0);
  const fact = x.journal.getReceivedFact(p, { streamEpoch: lease.streamEpoch, seq: 1, kind: 'message' });
  assert.equal(fact.messageId, firstMessage.messageId); assert.equal(fact.serverConfirmed, false);
  assert.equal(fact.attachmentReceipt.durability, 'durable');
  await finishScan(f, x);
  assert.equal(x.journal.getReceiver(p, lease.streamEpoch).handled_cursor, 2);
});

test('epoch freeze and explicit reconciliation clear previously issued continuation', native, async t => {
  const { f, x, p } = await continuationFixture(t);
  const first = (await boundedAck(f, x, { limit: 1 })).result;
  assert.ok(first.continuation);
  changeEpoch(f);
  await assert.rejects(x.c.connect(), { code: 'RECOVERY_RECONCILIATION_REQUIRED' });
  const next = await x.c.reconcileEpoch({ oldPartitionId: p, decisionRef: 'TEST token invalidation after recovery' });
  assert.notEqual(next.partitionId, p);
  await x.c.acquire(acquireArgs());
  const before = count(f, '/acks');
  await assert.rejects(boundedAck(f, x, { continuation: first.continuation }), { code: 'INVALID_REQUEST' });
  await assert.rejects(boundedAck(f, x, { continuation: { ...first.continuation, partitionId: next.partitionId } }), { code: 'INVALID_REQUEST' });
  assert.equal(count(f, '/acks'), before);
});
