import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCoreFixture, expireFixtureContent } from './fixtures/im-v2-core/helpers.js';
import { insert, recoveryRow } from './fixtures/im-v2-schema/helpers.js';
import { createImV2Center } from '../src/im/v2/server.js';
import { createImV2Handler } from '../src/im/v2/http.js';
import { assertImSchemaV4 } from '../src/im/v2/schema.js';
import { PROTOCOL, ImV2Error } from '../src/im/v2/contracts.js';
import { TIMEOUT, turn, bounded, scheduler, setup, exchange, listen, call, raw, frame,
  sendInput, attachment, sendAttachment, businessSnapshot } from './fixtures/im-v2-http/harness.js';

const options = { timeout: TIMEOUT };
function errorIs(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.body.error.code, code);
  assert.equal(response.body.protocol, PROTOCOL);
  assert.equal(typeof response.body.requestId, 'string');
}
function listenerBaseline(x) {
  return [x.req, x.res, x.socket].map(emitter => ({ emitter,
    events: new Map(['aborted', 'end', 'drain', 'finish', 'close', 'error'].map(name => [name, new Set(emitter.listeners(name))])) }));
}
function clean(x, timers, baseline) {
  assert.equal(timers.pending.size, 0, 'all owned deadlines cleared');
  assert.equal(x.res.listenerCount('drain'), 0, 'no stranded backpressure waiter');
  for (const { emitter, events } of baseline) {
    for (const [name, previous] of events) {
      for (const listener of emitter.listeners(name)) assert.ok(previous.has(listener), `no owned ${name} listener remains`);
    }
  }
}
async function syntheticResult(t, f, handler, settings) {
  const x = exchange(t, f, settings);
  await bounded(handler.handle(x.req, x.res), 'synthetic handler');
  await bounded(x.finished, 'native response finish');
  return { status: x.res.statusCode, body: x.json(), x };
}

// TEST ONLY SQL state transition, following the committed auth fixture. This is
// not a recovery/activation API. Preserve the request's original detached scope.
function changeFixtureEpoch(f) {
  const db = f.native;
  assert.equal(db.isTransaction, false, 'stream write is outside the old scoped transaction');
  const old = db.prepare('SELECT center_epoch,recovery_counter FROM im_center_state WHERE singleton=1').get();
  assert.equal(old.center_epoch, f.centerEpoch);
  const next = randomUUID(), counter = old.recovery_counter + 1;
  const row = recoveryRow(db, 'snapshot_recovery', { run_id: `http-snapshot-${next}`, preparation_ref: null,
    old_epoch: old.center_epoch, new_epoch: next, backup_id: randomUUID(), backup_file_hash: 'b'.repeat(64),
    manifest_hash: 'c'.repeat(64), candidate_base_hash: 'b'.repeat(64), status: 'active', verified_at: 101,
    activated_at: 102, activation_ref: `http-activation-${next}`, auth_review_ref: 'test-only-auth-review',
    activation_plan_hash: 'd'.repeat(64), activation_approval_ref: 'test-only-activation-approval' });
  db.exec('BEGIN IMMEDIATE');
  try {
    insert(db, 'im_center_epochs', { center_epoch: next, created_at: 100, origin: 'recovery', recovery_counter: counter });
    insert(db, 'im_recovery_runs', row);
    assert.equal(db.prepare(`UPDATE im_center_state SET center_epoch=?,recovery_counter=?,recovery_run_id=?,
      status='active',activation_ref=?,updated_at=102 WHERE singleton=1`)
      .run(next, counter, row.run_id, row.activation_ref).changes, 1);
    // All current receive streams retain their proven progress; old progress and
    // operation mappings remain historical. This fixture has no leases/receipts.
    const copied = db.prepare(`INSERT INTO im_sync_progress(recipient_id,center_epoch,stream_epoch,handled_through,updated_at)
      SELECT p.recipient_id,?,p.stream_epoch,p.handled_through,p.updated_at FROM im_sync_progress p
      JOIN im_receive_state r ON r.agent_id=p.recipient_id AND r.stream_epoch=p.stream_epoch WHERE p.center_epoch=?`)
      .run(next, old.center_epoch);
    assert.equal(copied.changes, db.prepare('SELECT count(*) AS n FROM im_receive_state').get().n);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(assertImSchemaV4(db), true, 'coherent epoch/run/center/current-progress state is P1-valid');
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  assert.equal(db.isTransaction, false);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(assertImSchemaV4(db), true, 'committed transition is fully valid');
  return next;
}

test('center rejects missing activation and mismatched proof; caller DB remains usable', options, t => {
  const f = createCoreFixture(t);
  f.native.prepare("UPDATE im_center_state SET status='verified',activation_ref=NULL").run();
  assert.throws(() => createImV2Center({ db: f.db, policy: f.policy, clock: f.clock }),
    e => e instanceof ImV2Error && e.code === 'STORAGE_UNAVAILABLE');
  f.native.prepare("UPDATE im_center_state SET status='active',activation_ref='test-activation'").run();
  f.native.prepare('UPDATE im_center_state SET recovery_counter=recovery_counter+1').run();
  assert.throws(() => createImV2Center({ db: f.db, policy: f.policy, clock: f.clock }),
    e => e instanceof ImV2Error && e.code === 'STORAGE_UNAVAILABLE');
  f.native.prepare('UPDATE im_center_state SET recovery_counter=recovery_counter-1').run();
  const center = createImV2Center({ db: f.db, policy: { ...f.policy, writeMode: 'paused' }, clock: f.clock });
  assert.equal(center.modules.auth.me(f.credentials[0]).state, 'active');
  assert.throws(() => center.modules.messages.ensureConversation(center.modules.auth.authenticate(f.credentials[0]),
    f.scope, { peerAgentId: f.b }), { code: 'NEW_WRITES_DISABLED' });
  center.close(); center.close();
  assert.equal(f.native.prepare('SELECT 1 AS n').get().n, 1);
  assert.throws(() => createImV2Center({ ...f, auth: f.auth }), { code: 'INVALID_REQUEST' });
  assert.throws(() => createImV2Handler({ ...center.modules, policy: f.policy, overridePermission: true }),
    { code: 'INVALID_REQUEST' });
});

test('synchronous deadline registration failure terminates transport before business calls and releases the slot for recovery', options, async t => {
  const f = createCoreFixture(t), { center, policy } = setup(t, f, { limits: { maxConnections: 1 } });
  const clockwork = scheduler();
  let failRegistration = true, registrations = 0;
  const timers = {
    setTimeout(fn, ms) {
      registrations++;
      if (failRegistration) throw new Error('TEST synchronous deadline registration failure');
      return clockwork.setTimeout(fn, ms);
    },
    clearTimeout(id) { clockwork.clearTimeout(id); },
  };
  const calls = { auth: [], messages: [] };
  // Delegating wrappers observe every real module entrypoint; no fake auth or
  // synthetic business result can make the zero-call/recovery assertions pass.
  const observed = (name, module) => Object.fromEntries(Object.entries(module).map(([key, value]) => [key,
    typeof value === 'function' ? function (...args) {
      calls[name].push(key); return Reflect.apply(value, module, args);
    } : value]));
  const handler = createImV2Handler({ ...center.modules, policy, trustedTimers: timers,
    auth: observed('auth', center.modules.auth), messages: observed('messages', center.modules.messages) });
  t.after(() => handler.close());
  const x = exchange(t, f, { stalled: true, path: '/api/v2/contacts' });
  const baseline = listenerBaseline(x), before = businessSnapshot(f);
  assert.equal(await bounded(handler.handle(x.req, x.res), 'timer registration failure handler'), true);
  await turn();
  assert.equal(registrations, 1, 'failure was injected at actual deadline registration');
  assert.deepEqual(calls, { auth: [], messages: [] }, 'no authentication or message entrypoint before a deadline exists');
  assert.equal(clockwork.pending.size, 0);
  assert.equal(x.req.destroyed, true, 'timer registration failure must terminate IncomingMessage');
  assert.equal(x.res.destroyed, true, 'timer registration failure must terminate ServerResponse');
  assert.equal(x.socket.destroyed, true, 'stalled transport cannot survive without a deadline');
  assert.equal(x.res.headersSent, false, 'must not emit an unbounded error response');
  assert.equal(x.socket.frames.length, 0);
  await bounded(x.socketClosed, 'registration failure socket close');
  await bounded(x.responseClosed, 'registration failure response close');
  clean(x, clockwork, baseline);
  assert.deepEqual(businessSnapshot(f), before);

  failRegistration = false;
  const recovered = await syntheticResult(t, f, handler, { path: '/api/v2/contacts' });
  assert.equal(recovered.status, 200, 'same maxConnections=1 handler has no leaked active slot');
  assert.equal(registrations, 2);
  assert.ok(calls.auth.includes('authenticate'), 'recovery uses real credential authentication');
  assert.deepEqual(calls.messages, ['listContacts']);
  assert.equal(recovered.body.data.items[0].peerAgentId, f.b);
  assert.equal(clockwork.pending.size, 0);
});

test('pending native JSON end retains connection slot and deadline until transport terminates', options, async t => {
  const f = createCoreFixture(t), { handler, timers } = setup(t, f, { limits: { maxConnections: 1 } });
  const first = exchange(t, f, { stalled: true }), baseline = listenerBaseline(first);
  const pending = handler.handle(first.req, first.res);
  await turn();
  assert.equal(first.res.statusCode, 200);
  assert.equal(first.res.writableEnded, true, 'real end() called');
  assert.equal(first.res.writableFinished, false, 'native writable callback held by transport');
  assert.equal(first.socket.destroyed, false);
  assert.equal(timers.pending.size, 1, 'end() alone must not cancel the original deadline');
  const originalDeadline = timers.pending.keys().next().value;
  const second = await syntheticResult(t, f, handler);
  errorIs(second, 429, 'RATE_LIMITED');
  assert.ok(timers.pending.has(originalDeadline), 'quota rejection cannot release the first slot');
  timers.fire(originalDeadline);
  await bounded(first.socketClosed, 'deadline closes stalled JSON transport');
  await bounded(pending, 'pending JSON handler settles');
  await turn();
  assert.equal(first.socket.destroyed, true);
  clean(first, timers, baseline);
  assert.equal((await syntheticResult(t, f, handler)).status, 200, 'terminated request releases the slot');
});

for (const kind of ['JSON', 'attachment final end']) {
  test(`handler.close terminates pending ${kind}, settles waiters, and is idempotent`, options, async t => {
    const f = createCoreFixture(t), { center, handler, timers } = setup(t, f);
    const message = kind === 'JSON' ? null : sendAttachment(f, center, Buffer.from('last bytes'));
    const x = exchange(t, f, { stalled: true, highWaterMark: 1024 * 1024,
      ...(message ? { path: `/api/v2/attachments/${message.attachment.attachmentId}`, credential: f.credentials[1] } : {}) });
    const baseline = listenerBaseline(x), pending = handler.handle(x.req, x.res);
    await turn();
    assert.equal(x.res.statusCode, 200);
    assert.equal(x.res.writableEnded, true);
    assert.equal(x.res.writableFinished, false);
    assert.equal(timers.pending.size, 1);
    handler.close(); handler.close();
    await bounded(x.socketClosed, 'close pending response socket');
    await bounded(pending, 'close pending response operation');
    await turn(); clean(x, timers, baseline);
    assert.equal(f.native.prepare('SELECT 1 AS n').get().n, 1, 'caller database still open');
    assert.equal(center.modules.auth.me(f.credentials[0]).agentId, f.a, 'caller modules still usable');
  });
}

test('native finish and client close each release slot, timers and response listeners', options, async t => {
  const f = createCoreFixture(t), { handler, timers } = setup(t, f, { limits: { maxConnections: 1 } });
  for (const terminal of ['finish', 'close']) {
    const x = exchange(t, f, { stalled: true }), baseline = listenerBaseline(x);
    const pending = handler.handle(x.req, x.res);
    await turn();
    assert.equal(x.res.writableFinished, false);
    if (terminal === 'finish') {
      x.socket.flush(); await bounded(x.finished, 'native successful finish');
      assert.equal(x.res.writableFinished, true);
      assert.equal(x.socket.destroyed, false);
    } else { x.peer.destroy(); await bounded(x.socketClosed, 'native peer close'); }
    await bounded(pending, 'terminal handler'); await turn(); clean(x, timers, baseline);
    assert.equal((await syntheticResult(t, f, handler)).status, 200);
  }
});

for (const scenario of [
  { label: 'oversized length', size: 70000, status: 413, code: 'PAYLOAD_TOO_LARGE' },
  { label: 'wrong credential', size: 100, credential: 'invalid', status: 401, code: 'INVALID_CREDENTIAL' },
  { label: 'wrong protocol', size: 100, protocol: 'wrong', status: 400, code: 'UNSUPPORTED_VERSION' },
]) {
  test(`early ${scenario.label} rejection completes JSON then closes unfinished raw upload`, options, async t => {
    const oversized = scenario.code === 'PAYLOAD_TOO_LARGE';
    const f = createCoreFixture(t), { handler, timers, policy } = setup(t, f,
      oversized ? { limits: { maxConnections: 1 } } : {});
    if (oversized) assert.equal(policy.limits.maxConnections, 1);
    const endpoint = await listen(t, handler);
    const before = businessSnapshot(f);
    const client = await raw(t, endpoint, frame(f, { ...scenario, method: 'POST', path: '/api/v2/conversations',
      fields: [['Content-Type', 'application/json'], ['Content-Length', scenario.size]], body: '{' }));
    const record = await bounded(endpoint.incoming, 'server parses partial request');
    assert.equal(record.completeAtEntry, false);
    const response = await bounded(client.response, 'complete early error response');
    errorIs(response, scenario.status, scenario.code);
    assert.equal(record.req.complete, false, 'one byte never completes the declared body');
    // Either transport has already closed, or its deadline must remain tracked.
    if (!record.req.socket.destroyed) {
      assert.ok(timers.pending.size > 0, 'unfinished rejected request cannot vanish from lifecycle tracking');
      timers.fire();
    }
    await bounded(client.closed, 'server closes early-rejected upload');
    await bounded(record.socketClosed.promise, 'server-side transport close');
    await bounded(Promise.all(endpoint.operations), 'early reject handlers settle');
    assert.equal(record.req.complete, false);
    assert.equal(record.ended, false, 'close/error is not a successful body-read end');
    assert.equal(record.req.destroyed, true);
    assert.equal(record.req.aborted, true, 'unfinished incoming message was aborted, not drained successfully');
    assert.equal(timers.pending.size, 0);
    assert.deepEqual(businessSnapshot(f), before);
    if (oversized) {
      assert.equal(record.req.socket.destroyed, true, 'server-side original socket has terminated');
      const next = await call(endpoint, f);
      assert.equal(next.status, 200, 'same handler reuses the released single connection slot');
      assert.equal(next.complete, true);
      assert.equal(next.body.data.agentId, f.a);
      assert.equal(next.body.data.centerEpoch, f.centerEpoch);
      assert.equal(endpoint.requests.length, 2);
      await bounded(Promise.all(endpoint.operations), 'same-handler follow-up settles');
      assert.equal(endpoint.requests[1].res.writableFinished, true, 'follow-up response finished normally');
      assert.equal(timers.pending.size, 0, 'normal finish also releases its deadline');
      assert.deepEqual(businessSnapshot(f), before);
    }
  });
}

test('blocked early error response retains a fallback deadline for unfinished request', options, async t => {
  const f = createCoreFixture(t), { handler, timers } = setup(t, f);
  const x = exchange(t, f, { stalled: true, complete: false, method: 'POST', path: '/api/v2/conversations',
    extraHeaders: { 'content-type': 'application/json', 'content-length': '70000' } });
  x.req.push(Buffer.from('{'));
  const baseline = listenerBaseline(x), before = businessSnapshot(f), pending = handler.handle(x.req, x.res);
  await turn();
  assert.equal(x.res.statusCode, 413);
  assert.equal(x.res.writableEnded, true);
  assert.equal(x.res.writableFinished, false);
  assert.equal(x.req.complete, false);
  assert.equal(timers.pending.size, 1);
  timers.fire();
  await bounded(x.socketClosed, 'blocked error fallback transport termination');
  await bounded(pending, 'blocked error handler settlement'); await turn();
  clean(x, timers, baseline);
  assert.equal(x.req.complete, false);
  assert.deepEqual(businessSnapshot(f), before);
});

for (const attachmentState of ['omitted', 'null']) {
  for (const representation of ['Unicode', 'JSON whitespace']) {
    test(`actual send body >64KiB rejected before writes: attachment ${attachmentState}, ${representation}`, options, async t => {
      let sendWrites = 0, sendCalls = 0;
      const f = createCoreFixture(t, { onStatement: ({ sql }) => {
        if (/INSERT\s+INTO\s+im_(?:messages|send_keys|attachments)\b/i.test(sql)) sendWrites++;
      } });
      const { handler } = setup(t, f, { onSend: () => sendCalls++ }), endpoint = await listen(t, handler);
      const input = sendInput(f, { text: representation === 'Unicode' ? '汉'.repeat(24000) : 'small',
        ...(attachmentState === 'null' ? { attachment: null } : {}) });
      assert.ok(input.text.length <= 32000);
      const payload = Buffer.from(JSON.stringify(input) + (representation === 'JSON whitespace' ? ' '.repeat(65537) : ''));
      assert.ok(payload.length > 65536 && payload.length < 16777216);
      const before = businessSnapshot(f), writesBefore = sendWrites;
      const result = await call(endpoint, f, { path: '/api/v2/messages', method: 'POST', payload });
      errorIs(result, 413, 'PAYLOAD_TOO_LARGE');
      assert.equal(result.complete, true);
      assert.equal(sendCalls, 0, 'rejected before the real messages.send entrypoint');
      assert.equal(sendWrites, writesBefore, 'no send business INSERT attempted');
      assert.deepEqual(businessSnapshot(f), before, 'message/attachment/reservation/key/mapping/content/delivery/audit unchanged');
    });
  }
}

test('genuine binary attachment uses the >64KiB file-body allowance with exact bytes/hash', options, async t => {
  const f = createCoreFixture(t), { handler } = setup(t, f), endpoint = await listen(t, handler);
  const bytes = Buffer.from(Array.from({ length: 65537 }, (_, i) => i % 256));
  const input = sendInput(f, { attachment: attachment(bytes) }), payload = Buffer.from(JSON.stringify(input));
  assert.ok(payload.length > 65536 && payload.length <= 16777216);
  const result = await call(endpoint, f, { path: '/api/v2/messages', method: 'POST', payload });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.data.message.attachment.sha256, input.attachment.sha256);
  const download = await call(endpoint, f, { path: `/api/v2/attachments/${result.body.data.message.attachment.attachmentId}`,
    credential: f.credentials[1] });
  assert.equal(download.complete, true); assert.deepEqual(download.bytes, bytes);
});

for (const stop of ['deadline', 'handler.close']) {
  test(`slow unfinished POST ${stop} cancels the body read without business writes`, options, async t => {
    const f = createCoreFixture(t), { handler, timers } = setup(t, f), endpoint = await listen(t, handler);
    const before = businessSnapshot(f);
    const client = await raw(t, endpoint, frame(f, { method: 'POST', path: '/api/v2/conversations',
      fields: [['Content-Type', 'application/json'], ['Content-Length', 100]], body: '{' }));
    const record = await bounded(endpoint.incoming, 'slow POST handler entry');
    assert.equal(record.req.complete, false);
    assert.equal(record.res.headersSent, false);
    assert.equal(timers.pending.size, 1);
    if (stop === 'deadline') timers.fire(); else { handler.close(); handler.close(); }
    await bounded(client.closed, 'slow POST transport terminated');
    await bounded(Promise.all(endpoint.operations), 'body iterator cancelled');
    assert.equal(record.req.complete, false); assert.equal(record.ended, false);
    assert.equal(record.req.destroyed, true); assert.equal(record.req.aborted, true);
    assert.equal(timers.pending.size, 0);
    assert.deepEqual(businessSnapshot(f), before);
    assert.equal(f.native.prepare('SELECT 1 AS n').get().n, 1);
    if (stop === 'handler.close') {
      assert.equal(endpoint.server.listening, true, 'handler.close leaves caller listener open');
      errorIs(await call(endpoint, f), 503, 'IM_DISABLED');
    }
  });
}

for (const stop of ['peer close', 'deadline', 'handler.close']) {
  test(`native write(false) then ${stop} settles without another download chunk`, options, async t => {
    const f = createCoreFixture(t), { center, handler, timers } = setup(t, f);
    const message = sendAttachment(f, center, Buffer.alloc(150000, 0x7a));
    const x = exchange(t, f, { stalled: true, path: `/api/v2/attachments/${message.attachment.attachmentId}`,
      credential: f.credentials[1] });
    let written = 0; const results = [], original = x.res.write;
    x.res.write = function (chunk, ...args) {
      written += chunk.length; const result = original.call(this, chunk, ...args); results.push(result); return result;
    };
    const baseline = listenerBaseline(x), before = businessSnapshot(f), pending = handler.handle(x.req, x.res);
    await turn();
    assert.deepEqual(results, [false], 'native ServerResponse backpressure, not a forced false return');
    assert.equal(written, 65536); assert.equal(x.res.writableEnded, false);
    assert.equal(x.res.listenerCount('drain'), 1);
    if (stop === 'peer close') x.peer.destroy();
    else if (stop === 'deadline') timers.fire();
    else handler.close();
    await bounded(x.socketClosed, 'backpressured socket termination');
    await bounded(pending, 'drain wait settles'); await turn();
    assert.equal(written, 65536); clean(x, timers, baseline);
    assert.deepEqual(businessSnapshot(f), before);
  });
}

for (const transition of ['contact revocation', 'persistent content expiry', 'coherent center epoch change']) {
  test(`actual HTTPS download stops after first 64KiB on ${transition}`, options, async t => {
    const f = createCoreFixture(t), { center, handler, timers } = setup(t, f);
    const bytes = Buffer.alloc(150000, 0x61), message = sendAttachment(f, center, bytes);
    let written = 0, transitions = 0, nextEpoch; const writeResults = [], mutationErrors = [];
    const endpoint = await listen(t, handler, { tls: true, instrument: (_req, res) => {
      const original = res.write;
      res.write = function (chunk, ...args) {
        written += chunk.length;
        const result = original.call(this, chunk, ...args); writeResults.push(result);
        if (written === 65536) {
          transitions++;
          try {
            if (transition === 'contact revocation') f.native.prepare('UPDATE im_contacts SET allowed=0').run();
            else if (transition === 'persistent content expiry') {
              expireFixtureContent(f, { messageId: message.messageId, expiresAt: message.expiresAt });
            } else {
              nextEpoch = changeFixtureEpoch(f);
              const me = center.modules.auth.me(f.credentials[1]);
              assert.equal(me.centerEpoch, nextEpoch, 'real authenticated unscoped discovery sees the valid new epoch');
              assert.equal(me.agentId, f.b);
              assert.equal(me.state, 'active');
            }
          } catch (error) { mutationErrors.push(error); }
        }
        return result;
      };
    } });
    const response = await call(endpoint, f, { path: `/api/v2/attachments/${message.attachment.attachmentId}`,
      credential: f.credentials[1] });
    assert.deepEqual(mutationErrors, [], 'SQL/validation/auth fixture exceptions must not masquerade as correct stream abort');
    assert.equal(response.status, 200); assert.equal(response.complete, false);
    assert.ok(response.bytes.length < bytes.length, 'incomplete response must not count as a file');
    assert.equal(written, 65536); assert.equal(transitions, 1); assert.equal(writeResults.length, 1);
    await bounded(Promise.all(endpoint.operations), 'revoked download handler');
    assert.equal(timers.pending.size, 0);
    if (transition === 'coherent center epoch change') {
      assert.notEqual(nextEpoch, f.centerEpoch);
      assert.equal(f.scope.centerEpoch, f.centerEpoch, 'old request scope was not rewritten');
      assert.equal(endpoint.requests[0].req.headers['x-a2a-center-epoch'], f.centerEpoch);
      assert.equal(response.headers['x-a2a-center-epoch'], f.centerEpoch);
      assert.deepEqual(f.native.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(assertImSchemaV4(f.native), true);
      assert.equal(center.modules.auth.me(f.credentials[1]).centerEpoch, nextEpoch);
      assert.throws(() => center.modules.messages.getAttachment(center.modules.auth.authenticate(f.credentials[1]),
        f.scope, { attachmentId: message.attachment.attachmentId }), { code: 'RECOVERY_RECONCILIATION_REQUIRED' });
    }
    if (transition === 'persistent content expiry') {
      const state = f.native.prepare('SELECT state,expiry_run_id FROM im_content_state WHERE message_id=?').get(message.messageId);
      assert.equal(state.state, 'expired'); assert.ok(state.expiry_run_id);
      assert.throws(() => center.modules.messages.getAttachment(center.modules.auth.authenticate(f.credentials[1]),
        f.scope, { attachmentId: message.attachment.attachmentId }), { code: 'CONTENT_EXPIRED' });
    }
  });
}

test('direct TLS: actual CA+hostname verified HTTPS succeeds, plaintext loopback is rejected', options, async t => {
  const f = createCoreFixture(t), { handler } = setup(t, f, {
    transport: { mode: 'direct-tls', serverUrl: 'https://localhost/' } });
  const secure = await listen(t, handler, { tls: true });
  const positive = await call(secure, f);
  assert.equal(positive.status, 200); assert.equal(positive.body.data.agentId, f.a);
  assert.equal(secure.requests[0].req.socket.encrypted, true);
  const plain = await listen(t, handler);
  errorIs(await call(plain, f, { extraHeaders: { 'x-forwarded-proto': 'https', forwarded: 'proto=https;for=127.0.0.1' } }),
    403, 'TLS_REQUIRED');
  assert.notEqual(plain.requests[0].req.socket.encrypted, true);
});

for (const endpoint of ['remoteAddress', 'localAddress']) {
  test(`local-test rejects nonloopback ${endpoint} despite forwarded headers (synthetic paired transport)`, options, async t => {
    const f = createCoreFixture(t), { handler } = setup(t, f);
    errorIs(await syntheticResult(t, f, handler, { [endpoint]: '192.0.2.10', extraHeaders: {
      forwarded: 'for=127.0.0.1;host=localhost;proto=https', 'x-forwarded-for': '127.0.0.1',
      'x-forwarded-proto': 'https', 'x-real-ip': '127.0.0.1' } }), 403, 'TLS_REQUIRED');
  });
}

test('case-varied duplicate auth/protocol/epoch/fence headers use real TLS raw frames and handler JSON', options, async t => {
  const f = createCoreFixture(t), { handler } = setup(t, f), endpoint = await listen(t, handler, { tls: true });
  for (const fields of [
    [['aUtHoRiZaTiOn', `Bearer ${f.credentials[0]}`]],
    [['x-a2a-PrOtOcOl', PROTOCOL]], [['x-A2a-CeNtEr-EpOcH', f.centerEpoch]],
    [['X-A2A-Instance-Id', randomUUID()], ['x-a2a-INStanCe-ID', randomUUID()]],
    [['X-A2A-Generation', '1'], ['x-a2a-GENERATION', '1']],
  ]) {
    const callsBefore = endpoint.requests.length;
    const client = await raw(t, endpoint, frame(f, { fields: [...fields, ['Connection', 'close']] }));
    errorIs(await bounded(client.response, 'duplicate header error JSON'), 400, 'INVALID_REQUEST');
    await bounded(client.closed, 'duplicate header connection close');
    assert.equal(endpoint.requests.length, callsBefore + 1, 'Node parsed the frame and invoked the handler');
  }
  assert.equal(endpoint.parserErrors.length, 0, 'these are handler rejections, not parser 400s');
});

test('raw Content-Length plus Transfer-Encoding is Node parser 400 before handler entry', options, async t => {
  const f = createCoreFixture(t), { handler, timers } = setup(t, f), endpoint = await listen(t, handler);
  const client = await raw(t, endpoint, frame(f, { method: 'POST', path: '/api/v2/conversations',
    fields: [['Content-Type', 'application/json'], ['Content-Length', '1'], ['Transfer-Encoding', 'chunked']], body: '0\r\n\r\n' }));
  const response = await bounded(client.response, 'Node parser 400');
  assert.equal(response.status, 400); assert.equal(response.body, undefined);
  await bounded(client.closed, 'Node closes ambiguous framing');
  assert.equal(endpoint.requests.length, 0); assert.equal(timers.pending.size, 0);
  assert.deepEqual(endpoint.parserErrors.map(error => error.code), ['HPE_INVALID_TRANSFER_ENCODING']);
});

test('GET body, malformed UTF-8 and path/query ambiguities reject with exact handler codes', options, async t => {
  const f = createCoreFixture(t), { handler } = setup(t, f), endpoint = await listen(t, handler);
  errorIs(await call(endpoint, f, { payload: Buffer.from('{}') }), 400, 'INVALID_REQUEST');
  errorIs(await call(endpoint, f, { path: '/api/v2/conversations', method: 'POST', payload: Buffer.from([0xff]) }),
    400, 'INVALID_REQUEST');
  errorIs(await call(endpoint, f, { path: '/api/v2/conversations', method: 'POST', payload: Buffer.from('hi'),
    extraHeaders: { 'content-type': 'multipart/form-data' } }), 400, 'INVALID_REQUEST');
  for (const path of ['/api/v2/%6de', '/api/v2//me', '/api/v2/./me', '/api/v2/x/../me',
    '/api/v2/\\me', '/api/v2/me#fragment', '/api/v2/contacts?after=%FF', '/api/v2/contacts?after=%ZZ',
    '/api/v2/contacts?limit=1&limit=2']) {
    const client = await raw(t, endpoint, frame(f, { path, fields: [['Connection', 'close']] }));
    errorIs(await bounded(client.response, `ambiguous URL ${path}`), 400, 'INVALID_REQUEST');
    await bounded(client.closed, 'ambiguous URL connection close');
  }
  assert.equal(endpoint.parserErrors.length, 0);
});

test('IP and credential rate limits are independent and expire at the window boundary', options, async t => {
  // Node's scoped mock controls existing Date.now; no production clock option.
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  const f = createCoreFixture(t);
  const ipLane = setup(t, f, { limits: { maxRequestsPerMinute: 2 } });
  errorIs(await syntheticResult(t, f, ipLane.handler, { credential: 'invalid' }), 401, 'INVALID_CREDENTIAL');
  errorIs(await syntheticResult(t, f, ipLane.handler, { credential: 'invalid' }), 401, 'INVALID_CREDENTIAL');
  errorIs(await syntheticResult(t, f, ipLane.handler), 429, 'RATE_LIMITED');
  now += 59999;
  errorIs(await syntheticResult(t, f, ipLane.handler), 429, 'RATE_LIMITED');
  now += 1;
  assert.equal((await syntheticResult(t, f, ipLane.handler)).status, 200);
  const credentialLane = setup(t, f, { limits: { maxRequestsPerMinute: 2 } });
  for (const remoteAddress of ['127.0.0.2', '127.0.0.3']) {
    assert.equal((await syntheticResult(t, f, credentialLane.handler, { remoteAddress })).status, 200);
  }
  errorIs(await syntheticResult(t, f, credentialLane.handler, { remoteAddress: '127.0.0.4' }), 429, 'RATE_LIMITED');
  assert.equal((await syntheticResult(t, f, credentialLane.handler, { remoteAddress: '127.0.0.5', credential: f.credentials[1] })).status, 200);
  now += 60000;
  assert.equal((await syntheticResult(t, f, credentialLane.handler, { remoteAddress: '127.0.0.6' })).status, 200);
});

test('rate map refuses a 4097th live identity and reclaims expired buckets (public behavior only)', { timeout: 30000 }, async t => {
  let now = 2000000;
  t.mock.method(Date, 'now', () => now);
  const f = createCoreFixture(t), { handler, timers } = setup(t, f);
  // Unique synthetic loopback source labels, not machine IP/firewall assumptions.
  // Invalid credentials charge only the IP bucket and never create auth rows.
  for (let i = 0; i < 4096; i++) {
    const result = await syntheticResult(t, f, handler, { credential: 'invalid', remoteAddress: `127.1.${i >> 8}.${i & 255}` });
    errorIs(result, 401, 'INVALID_CREDENTIAL');
    result.x.socket.destroy(); await bounded(result.x.socketClosed, 'rate probe socket release');
  }
  errorIs(await syntheticResult(t, f, handler, { credential: 'invalid', remoteAddress: '127.2.0.1' }), 429, 'RATE_LIMITED');
  now += 60000;
  errorIs(await syntheticResult(t, f, handler, { credential: 'invalid', remoteAddress: '127.2.0.1' }), 401, 'INVALID_CREDENTIAL');
  assert.equal((await syntheticResult(t, f, handler)).status, 200, 'reclamation creates space for IP and authenticated credential');
  assert.equal(timers.pending.size, 0);
});

test('v4 HTTPS end-to-end: send/replay, receiver/ACK/read, attachment/reply, strict v2 and v1 gates', options, async t => {
  const f = createCoreFixture(t), { handler } = setup(t, f), endpoint = await listen(t, handler, { tls: true });
  const get = (path, credential = f.credentials[0], extraHeaders) => call(endpoint, f, { path: `/api/v2${path}`, credential, extraHeaders });
  const post = (path, body, credential = f.credentials[0]) => call(endpoint, f, {
    path: `/api/v2${path}`, method: 'POST', credential, payload: Buffer.from(JSON.stringify({ ...f.scope, ...body })) });
  assert.equal((await get('/me')).body.data.agentId, f.a);
  const wrong = await get('/messages/not-a-uuid', 'invalid');
  errorIs(wrong, 401, 'INVALID_CREDENTIAL'); assert.equal(wrong.body.currentCenterEpoch, undefined);
  errorIs(await get('/me', f.credentials[0], { 'x-a2a-center-epoch': randomUUID() }), 409, 'RECOVERY_RECONCILIATION_REQUIRED');
  const bytes = Buffer.from('hello attachment'), input = sendInput(f, { attachment: attachment(bytes) });
  const sent = await post('/messages', input); assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const message = sent.body.data.message, replay = await post('/messages', input);
  assert.equal(replay.status, 200); assert.equal(replay.body.data.message.messageId, message.messageId);
  assert.equal((await get(`/sends/${input.originEpoch}/${input.clientMessageId}`)).status, 200);
  assert.equal((await get(`/messages/${message.messageId}`, f.credentials[1])).body.data.text, 'test');
  assert.deepEqual((await get(`/attachments/${message.attachment.attachmentId}`, f.credentials[1])).bytes, bytes);
  const instanceId = randomUUID();
  const lease = await post('/receiver/lease', { instanceId, requestId: randomUUID() }, f.credentials[1]);
  assert.equal(lease.status, 200, JSON.stringify(lease.body));
  const { generation, streamEpoch } = lease.body.data;
  const sync = await get(`/sync?streamEpoch=${streamEpoch}`, f.credentials[1], {
    'x-a2a-instance-id': instanceId, 'x-a2a-generation': String(generation) });
  assert.equal(sync.status, 200); assert.equal(sync.body.data.items[0].message.messageId, message.messageId);
  assert.equal((await post('/acks', { instanceId, generation, streamEpoch,
    items: [{ seq: 1, messageId: message.messageId }] }, f.credentials[1])).status, 200);
  assert.equal((await post(`/messages/${message.messageId}/read`, {}, f.credentials[1])).status, 200);
  assert.equal((await post('/messages', { ...sendInput(f), recipientAgentId: f.a,
    inReplyTo: message.messageId, text: 'reply' }, f.credentials[1])).status, 201);
  errorIs(await get('/events'), 404, 'RESOURCE_NOT_FOUND');
  errorIs(await get('/contacts', f.credentials[0], { 'x-a2a-center-epoch': randomUUID() }), 409, 'RECOVERY_RECONCILIATION_REQUIRED');
  errorIs(await get('/sync?streamEpoch=bad', f.credentials[1], { 'x-a2a-instance-id': randomUUID(), 'x-a2a-generation': '1' }),
    400, 'INVALID_REQUEST');
  const unrelated = { url: '/unowned', socket: {} };
  assert.equal(await handler.handle(unrelated, {}), false); assert.equal(unrelated.url, '/unowned');
  errorIs(await call(endpoint, f, { path: '/api/v1/me' }), 426, 'PROTOCOL_UPGRADE_REQUIRED');
});
