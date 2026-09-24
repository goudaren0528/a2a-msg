// TEST ONLY isolated process. Intercept the actual 30s native deadline BEFORE
// client import, retaining real handles/clearTimeout and invoking its callback.
// No parent test-runner timer patches and no production timeout option.
import assert from 'node:assert/strict';
import timers from 'node:timers';
import { syncBuiltinESMExports } from 'node:module';

const mode = process.argv[2], deadline = mode.startsWith('deadline');
const realSetTimeout = timers.setTimeout, realClearTimeout = timers.clearTimeout;
const captured = new Map();
if (deadline) {
  const controlled = (callback, delay, ...args) => {
    const timer = realSetTimeout(callback, delay, ...args);
    if (delay === 30000) captured.set(timer, () => {
      realClearTimeout(timer); captured.delete(timer); callback(...args);
    });
    return timer;
  };
  const clear = timer => { captured.delete(timer); return realClearTimeout(timer); };
  globalThis.setTimeout = timers.setTimeout = controlled;
  globalThis.clearTimeout = timers.clearTimeout = clear;
  syncBuiltinESMExports();
}
const { fixture, deferred, observeJournal } = await import('./harness.js');
const { acquireImV2JournalOwner } = await import('../../../src/im/v2/journal-owner.js');
const { ImV2Error } = await import('../../../src/im/v2/contracts.js');
const cleanup = [], unhandled = [];
process.on('unhandledRejection', error => unhandled.push(error));
const t = { after: fn => cleanup.push(fn) };
let f, x, provider, signal, transportCalls = 0, deadlineCallbacks = 0;
const bound = async promise => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = realSetTimeout(() => reject(new Error('TEST cancellation failed to settle within 1500ms')), 1500);
    })]);
  } finally { realClearTimeout(timer); }
};
try {
  f = await fixture(t);
  const entered = deferred(); provider = deferred();
  x = f.client(0, {
    getCredential(options) { signal = options?.signal; entered.resolve(); return provider.promise; },
    transport(input) { transportCalls++; return f.forward(input); },
  }, observeJournal(f.open(f.provision())));
  const operation = x.c.send(f.sendArgs());
  const settled = operation.then(() => ({ ok: true }), error => ({ error }));
  await bound(entered.promise);
  assert.ok(signal instanceof AbortSignal, 'provider receives the operation AbortSignal');
  assert.equal(signal.aborted, false);
  let closing;
  if (deadline) {
    assert.equal(captured.size, 1, 'exactly one actual 30-second operation deadline is armed while credential hangs');
    deadlineCallbacks = captured.size;
    for (const fire of [...captured.values()]) fire();
  } else closing = x.c.close();
  const result = await bound(settled);
  assert.equal(signal.aborted, true, 'abort precedes provider resolution/rejection');
  assert.equal(result.ok, undefined);
  // Existing active-HTTP close contract allows either fixed safe cancellation
  // code. Future work after close still has the strict IM_DISABLED contract.
  assert.ok((deadline ? ['STORAGE_UNAVAILABLE'] : ['IM_DISABLED', 'STORAGE_UNAVAILABLE']).includes(result.error.code));
  assert.equal(result.error.message, new ImV2Error(result.error.code).message);
  if (!deadline) await assert.rejects(x.c.connect(), { code: 'IM_DISABLED' });
  assert.equal(result.error.message.includes('provider-secret'), false);
  await bound(closing ?? x.c.close());
  const owner = acquireImV2JournalOwner(x.journal); owner.assertHeld(); owner.release();
  assert.equal(x.db.prepare('SELECT 1 AS n').get().n, 1);
  // Late provider outcomes arrive only AFTER both operation and close settled.
  // Drain actual event-loop turns (not sleeps) so unhandled rejection reporting
  // and any illicit resumed continuation are observable.
  if (mode.endsWith('resolve')) provider.resolve(f.credentials[0]);
  if (mode.endsWith('reject')) provider.reject(new Error('provider-secret-must-never-escape'));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unhandled.length, 0); assert.equal(transportCalls, 0); assert.equal(f.requests.length, 0);
  const business = x.journalCalls.filter(call => ['bindIdentity', 'stageOutgoing', 'recordMessage',
    'recordExpiry', 'prepareBatch', 'confirmBatch', 'reconcilePartition', 'setLease'].includes(call.name));
  assert.deepEqual(business, []);
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM im_v2_client_outgoing').get().n, 0);
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM im_v2_client_partitions').get().n, 0);
  console.log(JSON.stringify({ mode, signalAborted: signal.aborted, transportCalls, stagingCalls: 0,
    unhandled: unhandled.length, deadlineCallbacks, ownerReacquired: true, callerDatabaseOpen: true }));
} catch (error) {
  // Test failures print only fixed assertion diagnostics, never provider values.
  console.error(`CREDENTIAL_TEST_FAILURE ${error.code ?? error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  // Release a deliberately broken client's provider so cleanup itself cannot
  // obscure the cancellation assertion. Successful 'never' cases stay pending.
  if (process.exitCode && provider && f) provider.resolve(f.credentials[0]);
  for (const fn of cleanup.reverse()) await bound(Promise.resolve().then(fn));
  for (const timer of captured.keys()) realClearTimeout(timer);
}
