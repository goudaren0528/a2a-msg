import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createImV2Client } from '../src/im/v2/client.js';
import { acquireImV2JournalOwner } from '../src/im/v2/journal-owner.js';
import { runCredentialChild } from './fixtures/im-v2-client/child-harness.js';
import { fixture, native, supported, acquireArgs, attachment, count, mutateResponse,
  deferred, authenticatedMeGate, changeEpoch, observeJournal, syncPage, recordMessages,
  boundedAck } from './fixtures/im-v2-client/harness.js';

test('strict construction rejects noncanonical origins, foreign options and unregistered facades before callbacks', () => {
  let called = 0;
  const valid = { serverUrl: 'https://localhost', agentId: randomUUID(), getCredential: () => { called++; }, journal: Object.freeze({}) };
  for (const serverUrl of ['http://localhost', 'https://localhost/', 'https://user@localhost', 'https://localhost/x',
    'https://localhost?x=1', 'https://localhost#x', 'https://LOCALHOST', 'https://localhost:443']) {
    assert.throws(() => createImV2Client({ ...valid, serverUrl }), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => createImV2Client({ ...valid, skipLock: true }), { code: 'INVALID_REQUEST' });
  assert.throws(() => createImV2Client(valid), { code: supported ? 'INVALID_REQUEST' : 'STORAGE_UNAVAILABLE' });
  const db = new DatabaseSync(':memory:');
  try { assert.throws(() => createImV2Client({ ...valid, journal: db }), { code: supported ? 'INVALID_REQUEST' : 'STORAGE_UNAVAILABLE' }); }
  finally { db.close(); }
  assert.equal(called, 0);
});

test('default real TLS, optional JSON response headers, staged-before-POST, accepted loss resolves by GET once', native, async t => {
  const f = await fixture(t);
  let x, drop = true;
  const transport = async input => {
    if (input.path === '/api/v2/messages') {
      const body = JSON.parse(input.body);
      const known = x.journal.findOutgoing({ centerOrigin: f.origin, agentId: f.a, originEpoch: f.centerEpoch,
        clientMessageId: body.clientMessageId });
      assert.equal(known.outgoing.acceptance_state, 'pending');
      assert.deepEqual(known.outgoing.request, body, 'exact durable original precedes network mutation');
    }
    const response = await f.forward(input);
    assert.equal(response.headers['x-a2a-protocol'], undefined, 'actual P3 JSON has no protocol response header');
    if (input.path === '/api/v2/messages' && drop) { drop = false; throw new Error('TEST response loss with secret-do-not-echo'); }
    return response;
  };
  x = f.client(0, { transport });
  const identity = await x.c.connect();
  assert.equal(identity.centerEpoch, f.centerEpoch);
  const input = f.sendArgs();
  await assert.rejects(x.c.send(input), error => error.code === 'STORAGE_UNAVAILABLE' && !error.message.includes('secret'));
  const op = { originEpoch: f.centerEpoch, clientMessageId: input.clientMessageId };
  const result = await x.c.recoverSend(op);
  assert.equal(count(f, '/messages'), 1);
  assert.equal(result.messageId, f.native.prepare('SELECT message_id FROM im_messages').get().message_id);
  assert.equal((await x.c.send(input)).messageId, result.messageId);
  assert.equal(count(f, '/messages'), 1);
  assert.equal(x.journal.findOutgoing({ centerOrigin: f.origin, agentId: f.a, ...op }).outgoing.acceptance_state, 'accepted');
  await x.c.close();
  const real = f.client(0, {}, x);
  assert.equal((await real.c.connect()).partitionId, identity.partitionId, 'default transport verifies fixture CA/hostname');
});

test('current-epoch authenticated 404 permits only immutable original retry; payload/key conflict rejected', native, async t => {
  const f = await fixture(t); let drop = true;
  const x = f.client(0, { transport: async input => {
    if (input.path === '/api/v2/messages' && drop) { drop = false; throw new Error('TEST before request'); }
    return f.forward(input);
  } });
  const input = f.sendArgs();
  await assert.rejects(x.c.send(input), { code: 'STORAGE_UNAVAILABLE' });
  const result = await x.c.recoverSend({ originEpoch: f.centerEpoch, clientMessageId: input.clientMessageId });
  assert.equal(count(f, '/messages'), 1);
  assert.ok(f.requests.some(x => x.path === `/api/v2/sends/${f.centerEpoch}/${input.clientMessageId}`));
  await assert.rejects(x.c.send({ ...input, text: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(x.c.send({ ...input, centerEpoch: f.centerEpoch }), { code: 'INVALID_REQUEST' });
  await assert.rejects(x.c.recoverSend({ originEpoch: f.centerEpoch, clientMessageId: randomUUID() }), { code: 'SEND_OUTCOME_UNKNOWN' });
  assert.equal(count(f, '/messages'), 1); assert.ok(result.messageId);
});

test('attachment file and durable journal/batch precede ACK; delivered does not imply read', native, async t => {
  const f = await fixture(t), m = f.directSend({ attachment: attachment() });
  let x;
  x = f.client(1, { transport: async input => {
    if (input.path === '/api/v2/acks') {
      const p = awaitPartition(x);
      const batch = x.journal.listBatches(p, { state: 'pending' }).items[0];
      assert.equal(batch.kind, 'ack');
      const fact = x.journal.getReceivedFact(p, { streamEpoch: batch.streamEpoch, seq: 1, kind: 'message' });
      assert.equal(fact.serverConfirmed, false);
      assert.equal(fact.attachmentReceipt.durability, 'durable');
      const identity = { centerOrigin: f.origin, agentId: f.b, stableInstanceId: f.center.modules.auth.me(f.credentials[1]).instanceId,
        centerEpoch: f.centerEpoch, partitionId: p };
      assert.equal(await x.attachments.verify({ partition: identity, messageId: m.messageId,
        attachment: m.attachment, receipt: fact.attachmentReceipt }), true);
    }
    return f.forward(input);
  } });
  await x.c.acquire(acquireArgs());
  const result = await x.c.receiveOnce();
  assert.equal(result.items[0].status, 'delivered'); assert.equal(result.pending, false);
  assert.equal(f.native.prepare('SELECT read_at FROM im_deliveries').get().read_at, null);
  assert.equal((await x.c.read({ messageId: m.messageId })).changed, true);
  assert.equal((await x.c.release()).localCleared, true);
  await assert.rejects(x.c.receiveOnce(), { code: 'STALE_FENCE' });
});
function awaitPartition(x) { return x.db.prepare("SELECT partition_id FROM im_v2_client_partitions WHERE status='active'").get().partition_id; }

for (const corruption of ['missing', 'hash']) test(`persisted ${corruption} attachment prevents retry ACK`, native, async t => {
  const f = await fixture(t); f.directSend({ attachment: attachment() }); let drop = true;
  const x = f.client(1, { transport: async input => {
    if (input.path === '/api/v2/acks' && drop) { drop = false; throw new Error('TEST before ACK'); }
    return f.forward(input);
  } });
  await x.c.acquire(acquireArgs());
  await assert.rejects(x.c.receiveOnce(), { code: 'STORAGE_UNAVAILABLE' });
  const p = awaitPartition(x), batch = x.journal.listBatches(p, { state: 'pending' }).items[0];
  const fact = x.journal.getReceivedFact(p, { streamEpoch: batch.streamEpoch, seq: 1, kind: 'message' });
  const file = `${x.files}/${fact.attachmentReceipt.relativeName}`;
  if (corruption === 'missing') unlinkSync(file); else writeFileSync(file, Buffer.alloc(readFileSync(file).length));
  await assert.rejects(x.c.ackPending(), error => ['STORAGE_UNAVAILABLE', 'INVALID_ATTACHMENT'].includes(error.code));
  assert.equal(count(f, '/acks'), 0);
  assert.equal(f.native.prepare('SELECT acked_at FROM im_deliveries').get().acked_at, null);
});

test('historical acquire must renew before local effective lease; stale historical cannot replace local evidence', native, async t => {
  let now = 103;
  const f = await fixture(t, { clock: () => now }), x = f.client(1), args = acquireArgs();
  const first = await x.c.acquire(args);
  const repeated = await x.c.acquire(args);
  assert.equal(repeated.historical, false); assert.equal(repeated.generation, first.generation);
  assert.equal(count(f, '/receiver/lease/renew'), 1);
  now = first.expiresAt;
  const replacement = await x.c.acquire(acquireArgs());
  await assert.rejects(x.c.acquire(args), { code: 'STALE_FENCE' });
  const row = x.journal.getReceiver(awaitPartition(x), first.streamEpoch);
  assert.equal(row.generation, replacement.generation);
});

test('close rejects concurrent work, aborts owned HTTP, releases owner and leaves caller DB usable', native, async t => {
  const entered = deferred();
  const f = await fixture(t, { handler: (req, res, real) => {
    if (req.url === '/api/v2/me') { entered.resolve(); return; }
    return real.handle(req, res);
  } });
  const x = f.client(); const pending = x.c.connect();
  const rejection = assert.rejects(pending, error => ['IM_DISABLED', 'STORAGE_UNAVAILABLE'].includes(error.code));
  await entered.promise;
  await assert.rejects(x.c.connect(), { code: 'OPERATION_FORBIDDEN' });
  const close = x.c.close();
  await assert.rejects(x.c.connect(), { code: 'IM_DISABLED' });
  await close; await rejection;
  assert.equal(x.db.prepare('SELECT 1 AS n').get().n, 1);
  const owner = acquireImV2JournalOwner(x.journal); owner.assertHeld(); owner.release();
});

test('close waits for owned file work before releasing owner', native, async t => {
  const f = await fixture(t); f.directSend({ attachment: attachment() });
  const entered = deferred(), finish = deferred(), opened = f.open(f.provision());
  const x = f.client(1, { attachments: { ...opened.attachments, async save(input) {
    const receipt = await opened.attachments.save(input); entered.resolve(); await finish.promise; return receipt;
  } } }, opened);
  await x.c.acquire(acquireArgs());
  const receive = assert.rejects(x.c.receiveOnce(), { code: 'IM_DISABLED' });
  await entered.promise;
  const close = x.c.close();
  assert.throws(() => acquireImV2JournalOwner(x.journal), { code: 'STORAGE_UNAVAILABLE' });
  finish.resolve(); await close; await receive;
  assert.equal(count(f, '/acks'), 0);
  const owner = acquireImV2JournalOwner(x.journal); owner.release();
});

test('TLS CA rejection, redirect rejection and strict malformed envelopes fail closed', native, async t => {
  const f = await fixture(t);
  const untrusted = f.client(0, { ca: undefined });
  await assert.rejects(untrusted.c.connect(), { code: 'STORAGE_UNAVAILABLE' });
  const cases = [
    r => ({ ...r, status: 302, headers: { ...r.headers, location: 'https://localhost/elsewhere' } }),
    r => mutateResponse(r, b => { b.data.extra = true; }),
    r => mutateResponse(r, b => { b.data.agentId = randomUUID(); }),
    r => ({ ...r, headers: { ...r.headers, 'x-a2a-protocol': 'a2a-msg.im.v1' } }),
    r => ({ ...r, headers: { ...r.headers, 'x-a2a-center-epoch': randomUUID() } }),
    r => ({ ...r, body: Buffer.from([0xff]), headers: { ...r.headers, 'content-length': '1' } }),
    r => ({ ...r, headers: { ...r.headers, 'content-type': 'text/plain' } }),
  ];
  for (const alter of cases) {
    const x = f.client(0, { transport: async input => alter(await f.forward(input)) });
    await assert.rejects(x.c.connect(), { code: 'INVALID_REQUEST' });
    assert.equal(x.db.prepare('SELECT count(*) AS n FROM im_v2_client_partitions').get().n, 0);
  }
  assert.equal(f.requests.some(x => x.path === '/elsewhere'), false);
});

test('binary success requires protocol and epoch headers even though JSON does not', native, async t => {
  const f = await fixture(t); f.directSend({ attachment: attachment() });
  const x = f.client(1, { transport: async input => {
    const response = await f.forward(input);
    if (input.binary) { const headers = { ...response.headers }; delete headers['x-a2a-protocol']; return { ...response, headers }; }
    return response;
  } });
  await x.c.acquire(acquireArgs());
  await assert.rejects(x.c.receiveOnce(), { code: 'INVALID_ATTACHMENT' });
  assert.equal(count(f, '/acks'), 0);
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM im_v2_client_received').get().n, 0);
});

// Two distinct boundaries: mutation in the calling stack (before the first
// microtask) and while a genuine authenticated /me response is gated.
for (const timing of ['invocation', 'authenticated-me']) {
  async function mutateDuring(gate, invoke, mutate) {
    const held = timing === 'authenticated-me' ? gate.arm() : null;
    const operation = invoke();
    // Attach immediately, even when a broken implementation rejects early.
    const settled = operation.then(value => ({ value }), error => ({ error }));
    try {
      if (held) await Promise.race([held.entered, settled.then(result => {
        throw result.error ?? new Error('TEST operation completed before its authenticated /me gate');
      })]);
      mutate();
    } finally { held?.release(); }
    const result = await settled;
    if (result.error) throw result.error;
    return result.value;
  }

  test(`snapshot ${timing}: send retains validated text and nested attachment metadata without freezing caller`, native, async t => {
    const f = await fixture(t), gate = authenticatedMeGate(f), x = f.client(0, { transport: gate.transport });
    const input = f.sendArgs({ attachment: attachment() }), original = structuredClone(input);
    const result = await mutateDuring(gate, () => x.c.send(input), () => {
      assert.equal(Object.isFrozen(input), false); assert.equal(Object.isFrozen(input.attachment), false);
      input.text = 'changed caller text'; input.attachment.name = 'changed.bin'; input.attachment.mime = 'text/plain';
      input.foreign = true; input.attachment.foreign = true;
    });
    const saved = x.journal.findOutgoing({ centerOrigin: f.origin, agentId: f.a,
      originEpoch: f.centerEpoch, clientMessageId: original.clientMessageId }).outgoing;
    assert.equal(saved.request.text, original.text); assert.deepEqual(saved.request.attachment, original.attachment);
    const remote = f.native.prepare('SELECT text FROM im_messages WHERE message_id=?').get(result.messageId);
    assert.equal(remote.text, original.text);
    assert.equal(f.native.prepare('SELECT name,mime FROM im_attachments WHERE message_id=?').get(result.messageId).name, original.attachment.name);
    assert.equal(input.text, 'changed caller text');
  });

  test(`snapshot ${timing}: acquire uses invocation instance and request IDs`, native, async t => {
    const f = await fixture(t), gate = authenticatedMeGate(f), sent = [];
    const x = f.client(1, { transport: input => {
      if (input.path === '/api/v2/receiver/lease') sent.push(JSON.parse(input.body));
      return gate.transport(input);
    } });
    const input = acquireArgs(), original = structuredClone(input);
    const lease = await mutateDuring(gate, () => x.c.acquire(input), () => {
      input.instanceId = randomUUID(); input.requestId = randomUUID(); input.foreign = true;
    });
    assert.equal(lease.instanceId, original.instanceId);
    assert.equal(sent.length, 1); assert.equal(sent[0].instanceId, original.instanceId); assert.equal(sent[0].requestId, original.requestId);
  });

  test(`snapshot ${timing}: read object retains original messageId, not a later valid message`, native, async t => {
    const f = await fixture(t), first = f.directSend(), second = f.directSend(), gate = authenticatedMeGate(f);
    const x = f.client(1, { transport: gate.transport }); await x.c.acquire(acquireArgs()); await x.c.receiveOnce();
    const input = { messageId: first.messageId };
    await mutateDuring(gate, () => x.c.read(input), () => { input.messageId = second.messageId; input.foreign = true; });
    const rows = f.native.prepare('SELECT message_id,read_at FROM im_deliveries ORDER BY seq').all();
    assert.notEqual(rows[0].read_at, null); assert.equal(rows[1].read_at, null);
    assert.equal(rows[0].message_id, first.messageId);
  });

  test(`snapshot ${timing}: recoverSend queries and replays the original operation`, native, async t => {
    const f = await fixture(t), gate = authenticatedMeGate(f); let drop = true;
    const x = f.client(0, { transport: input => {
      if (input.path === '/api/v2/messages' && drop) { drop = false; throw new Error('TEST before acceptance'); }
      return gate.transport(input);
    } });
    const send = f.sendArgs(); await assert.rejects(x.c.send(send), { code: 'STORAGE_UNAVAILABLE' });
    const input = { originEpoch: f.centerEpoch, clientMessageId: send.clientMessageId };
    const result = await mutateDuring(gate, () => x.c.recoverSend(input), () => {
      input.originEpoch = randomUUID(); input.clientMessageId = randomUUID(); input.foreign = true;
    });
    assert.ok(result.messageId); assert.equal(result.clientMessageId, send.clientMessageId);
    assert.ok(f.requests.some(request => request.path === `/api/v2/sends/${f.centerEpoch}/${send.clientMessageId}`));
    assert.equal(count(f, '/messages'), 1);
  });

  test(`snapshot ${timing}: manual reconciliation persists invocation decision and predecessor`, native, async t => {
    const f = await fixture(t), gate = authenticatedMeGate(f), x = f.client(0, { transport: gate.transport });
    const old = await x.c.connect(); changeEpoch(f);
    await assert.rejects(x.c.connect(), { code: 'RECOVERY_RECONCILIATION_REQUIRED' });
    const input = { oldPartitionId: old.partitionId, decisionRef: 'invocation decision' };
    const result = await mutateDuring(gate, () => x.c.reconcileEpoch(input), () => {
      input.oldPartitionId = 'f'.repeat(64); input.decisionRef = 'changed decision'; input.foreign = true;
    });
    const row = x.db.prepare('SELECT predecessor_id,decision_ref FROM im_v2_client_partitions WHERE partition_id=?').get(result.partitionId);
    assert.equal(row.predecessor_id, old.partitionId); assert.equal(row.decision_ref, 'invocation decision');
  });

  test(`snapshot ${timing}: ackPending owns a deep continuation snapshot`, native, async t => {
    const f = await fixture(t), gate = authenticatedMeGate(f), opened = observeJournal(f.open(f.provision()));
    const x = f.client(1, { transport: gate.transport }, opened), lease = await x.c.acquire(acquireArgs());
    const p = (await x.c.connect()).partitionId;
    for (let i = 0; i < 12; i++) f.directSend();
    recordMessages(x, p, lease.streamEpoch, (await syncPage(f, lease)).items);
    const first = (await boundedAck(f, x)).result; assert.ok(first.continuation);
    const input = { continuation: structuredClone(first.continuation) };
    const final = await mutateDuring(gate, () => x.c.ackPending(input), () => {
      assert.equal(Object.isFrozen(input.continuation), false);
      input.continuation.partitionId = 'f'.repeat(64); input.continuation.phase = 'confirmed';
      input.continuation.foreign = true; input.foreign = true;
    });
    assert.equal(final.pending, false); assert.equal(x.journal.getReceiver(p, lease.streamEpoch).handled_cursor, 12);
    assert.equal(count(f, '/acks'), 12);
  });
}

test('snapshot validation rejects invocation unknown fields even if the caller deletes them immediately', native, async t => {
  const f = await fixture(t), x = f.client();
  const cases = [
    ['send', () => f.sendArgs({ foreign: true })],
    ['send', () => f.sendArgs({ attachment: { ...attachment(), foreign: true } })],
    ['acquire', () => ({ ...acquireArgs(), foreign: true })],
    ['read', () => ({ messageId: randomUUID(), foreign: true })],
    ['recoverSend', () => ({ originEpoch: f.centerEpoch, clientMessageId: randomUUID(), foreign: true })],
    ['getSendResult', () => ({ originEpoch: f.centerEpoch, clientMessageId: randomUUID(), foreign: true })],
    ['reconcileEpoch', () => ({ oldPartitionId: 'a'.repeat(64), decisionRef: 'test', foreign: true })],
    ['ackPending', () => ({ foreign: true })],
    ['ackPending', () => ({ continuation: { partitionId: 'a'.repeat(64), pendingAfter: null,
      confirmedAfter: null, phase: 'pending', foreign: true } })],
  ];
  for (const [method, make] of cases) {
    const input = make(), operation = x.c[method](input);
    const rejected = assert.rejects(operation, { code: 'INVALID_REQUEST' });
    delete input.foreign; if (input.attachment) delete input.attachment.foreign;
    if (input.continuation) delete input.continuation.foreign;
    await rejected;
  }
  assert.equal(f.requests.length, 0, 'invalid invocation inputs fail before credentials/network');
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM im_v2_client_outgoing').get().n, 0);
});

for (const cause of ['close', 'deadline']) for (const outcome of ['never', 'resolve', 'reject']) {
  test(`credential cancellation ${cause}/${outcome}: ignored signal cannot hold owner or resume client work`, native, async () => {
    const result = await runCredentialChild(`${cause}-${outcome}`);
    assert.equal(result.timedOut, false, result.stderr);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stderr);
    const evidence = JSON.parse(result.stdout.trim());
    assert.equal(evidence.signalAborted, true); assert.equal(evidence.transportCalls, 0);
    assert.equal(evidence.stagingCalls, 0); assert.equal(evidence.unhandled, 0);
    assert.equal(evidence.ownerReacquired, true); assert.equal(evidence.callerDatabaseOpen, true);
    assert.equal(evidence.deadlineCallbacks, cause === 'deadline' ? 1 : 0);
  });
}
