// TEST ONLY: exercise escaped engine errors through genuine approval callbacks.
import assert from 'node:assert/strict';
import { CONTEXT, fileImage } from './owner.js';

export const escapedErrorNames = [
  'escaped-error-code-getter', 'escaped-error-valid-code-data',
  'escaped-error-arbitrary-code-data', 'escaped-error-message-cause-getters',
  'escaped-error-cross-target-code-getter', 'escaped-error-cross-target-data',
];

function capture(operation) {
  try { operation(); } catch (error) { return error; }
  assert.fail('operation must throw');
}

function safeError(error, reference, foreignError, secret) {
  assert.notEqual(error, foreignError, 'provider exception must not escape by identity');
  assert.ok(error instanceof Error);
  const descriptors = Object.getOwnPropertyDescriptors(error);
  assert.deepEqual(Reflect.ownKeys(descriptors).sort(), ['code', 'message', 'stack']);
  for (const key of ['code', 'message']) {
    assert.ok(Object.hasOwn(descriptors[key], 'value'), `${key} must be an own data field`);
    assert.equal(typeof descriptors[key].value, 'string');
    assert.equal(descriptors[key].value.includes(secret), false, `${key} must not carry callback data`);
  }
  assert.equal(descriptors.code.value, 'MAINTENANCE_INVALID');
  assert.equal(descriptors.message.value, reference.message);
  // Node 24 itself exposes Error.stack through a lazy native accessor. Check
  // its rendered value, without requiring the implementation to replace it.
  assert.equal(typeof error.stack, 'string');
  assert.equal(error.stack.includes(secret), false, 'mutated stack must not escape');
  assert.equal(Object.hasOwn(error, 'cause'), false);
}

export function runEscapedError(name, { observer, fixture }) {
  const a = fixture(), cross = name.includes('cross-target'), b = cross ? fixture() : null;
  const controls = [a, ...(b ? [b] : [])];
  const initial = a.status(), pending = a.preview();
  assert.equal(initial.reason, 'TIME_ANCHOR_REQUIRED');
  assert.equal(initial.sessionPresent, false);
  let bPending, bSession;
  if (b) {
    const first = b.approve(b.preview(), 'b-first');
    assert.equal(first.sessionEstablished, true);
    bSession = b.check(); bPending = b.preview();
  }
  const reference = capture(() => a.facade.getMaintenanceTimeStatus({ extra: 1 }, CONTEXT));
  assert.equal(reference.code, 'MAINTENANCE_INVALID');
  const secret = 'test-only-callback-private-marker';
  const foreignError = new Error(secret);
  const customSymbol = Symbol(secret);
  const before = controls.map(f => ({ rows: observer.image(f.owner.databasePath), files: fileImage(f.owner.dir) }));
  const bCalls = b && structuredClone(b.calls);
  const connection = observer.connectionId(a.owner.databasePath);
  const attempts = [], mutationFailures = [];
  let caught, calls = 0, getterCalls = 0, nestedEvents, nestedClock, phaseTransaction;
  function mutate(error, key, descriptor) {
    attempts.push(typeof key === 'symbol' ? 'symbol' : key);
    // A frozen public Error is also valid: only mutation exceptions are caught
    // here, independently from the engine reentry exception, without getters.
    try { Object.defineProperty(error, key, { configurable: true, ...descriptor }); }
    catch (mutationError) { mutationFailures.push(mutationError); }
  }
  a.callbacks.approve = () => {
    calls++;
    const start = observer.events.length;
    const wall = observer.clock.wallCalls, mono = observer.clock.monoCalls;
    phaseTransaction = observer.events.filter(e => e.connection === connection).at(-1)?.transaction;
    try { (b ?? a).status(); } catch (error) { caught = error; }
    nestedEvents = observer.events.slice(start);
    nestedClock = { wall: observer.clock.wallCalls - wall, mono: observer.clock.monoCalls - mono };
    if (caught !== undefined) {
      const getter = { get() { getterCalls++; throw foreignError; } };
      if (name.endsWith('code-getter')) mutate(caught, 'code', getter);
      else if (name.endsWith('message-cause-getters')) {
        mutate(caught, 'message', getter); mutate(caught, 'cause', getter);
      } else {
        mutate(caught, 'code', { value: name.includes('arbitrary') ? secret : 'MAINTENANCE_METADATA_LIMIT' });
        for (const key of ['message', 'stack', 'custom', 'cause']) mutate(caught, key, { value: secret });
        mutate(caught, customSymbol, { value: secret });
      }
    }
    return true;
  };
  observer.start();
  const outerError = capture(() => a.approve(pending, 'a-pending'));
  observer.stop();
  // All decisive assertions are outside callbacks: their own exceptions cannot
  // be sanitized by the engine and mistaken for a successful regression check.
  assert.equal(calls, 1); assert.ok(caught instanceof Error);
  assert.notEqual(caught, foreignError); assert.notEqual(caught, reference);
  assert.notEqual(outerError, reference);
  assert.ok(attempts.length > 0);
  for (const error of mutationFailures) assert.ok(error instanceof TypeError);
  safeError(outerError, reference, foreignError, secret);
  assert.equal(getterCalls, 0, 'no mutated error getter is evaluated');
  assert.deepEqual(nestedEvents, []); assert.deepEqual(nestedClock, { wall: 0, mono: 0 });
  assert.equal(phaseTransaction, true);
  assert.equal(a.calls.resolve.length, 1); assert.equal(a.calls.approve.length, 1);
  const native = observer.events.filter(e => e.phase === 'after-native' && e.nativeCalled && e.connection === connection);
  const begin = native.findIndex(e => /^BEGIN IMMEDIATE/i.test(e.sql ?? ''));
  const rollback = native.findIndex((e, index) => index > begin && /^ROLLBACK/i.test(e.sql ?? '') && !e.transaction);
  assert.ok(begin >= 0 && native[begin].transaction, 'real owned BEGIN IMMEDIATE');
  assert.ok(rollback > begin, 'owned native transaction positively rolled back');
  assert.equal(native.some(e => /^(INSERT|UPDATE|DELETE|REPLACE)/i.test(e.sql ?? '')), false);
  assert.equal(observer.events.some(e => e.fs || e.method === 'constructor' || e.method === 'close'), false);
  if (b) {
    assert.deepEqual(b.calls, bCalls);
    assert.equal(observer.events.some(e => e.connection === observer.connectionId(b.owner.databasePath)), false);
  }
  for (const [index, f] of controls.entries()) {
    assert.deepEqual(observer.image(f.owner.databasePath), before[index].rows, 'anchors/head/floor/transition/all inherited rows unchanged');
    assert.deepEqual(fileImage(f.owner.dir), before[index].files, 'inventory/identity/bytes/mtime unchanged');
    f.owner.seedUnchanged();
  }
  a.callbacks.approve = null;
  assert.deepEqual(a.status(), initial, 'no deferred session installation');
  assert.equal(a.check().sessionNonce, null);
  const secondError = capture(() => a.facade.getMaintenanceTimeStatus({ extra: 1 }, CONTEXT));
  safeError(secondError, reference, foreignError, secret);
  assert.notEqual(secondError, reference); assert.notEqual(secondError, outerError);
  assert.notEqual(secondError, caught, 'later public errors are independently emitted');
  const approved = a.approve(pending, 'a-pending');
  assert.equal(approved.replayed, false); assert.equal(approved.sessionEstablished, true);
  assert.equal(approved.anchor.sessionNonce, pending.proposal.sessionNonce, 'same pending proposal retained');
  assert.equal(a.check().executable, true);
  if (b) {
    assert.deepEqual(b.check(), bSession);
    const approvedB = b.approve(bPending, 'b-pending');
    assert.equal(approvedB.sessionEstablished, true);
    assert.equal(approvedB.anchor.sessionNonce, bPending.proposal.sessionNonce);
  }
  assert.equal(getterCalls, 0);
  console.log(JSON.stringify({ phase: 'escaped-error-proof', scenario: name, calls, attempts,
    mutationRefusals: mutationFailures.length, getterCalls, phaseTransaction,
    nativeTransaction: native.filter(e => /^(BEGIN IMMEDIATE|ROLLBACK)/i.test(e.sql ?? '')),
    outerCode: outerError.code, unchangedRowsAndFiles: true, pendingRetained: true, frameReleased: true }));
}
