// TEST ONLY. Each case has its own process and genuine synthetic ACTIVE/PAUSED v5.
import assert from 'node:assert/strict';
import { createOwner, TARGET_LIMITS, AUTHORITY_LIMITS, CONTEXT, fileImage } from './owner.js';

export const errorLifecycleNames = [
  'error-lifecycle-caught-reentry-rollback-refused',
  'error-lifecycle-ordinary-denial-rollback-refused',
  'error-lifecycle-constructor-close-refused',
  'error-lifecycle-constructor-close-response-loss',
];
function capture(fn) { try { fn(); } catch (error) { return error; } assert.fail('must throw'); }
const secret = 'test-only-error-lifecycle-private-marker';
function sanitized(error, code, reference) {
  assert.ok(error instanceof Error);
  const fields = Object.getOwnPropertyDescriptors(error);
  assert.deepEqual(Reflect.ownKeys(fields).sort(), ['code', 'message', 'stack']);
  for (const key of ['code', 'message']) assert.equal(typeof fields[key]?.value, 'string');
  assert.equal(fields.code.value, `MAINTENANCE_${code}`);
  assert.doesNotMatch(fields.message.value, /test-only|SELECT|sqlite|owned\.|private-marker/i);
  assert.equal(error.stack.includes(secret), false);
  if (reference) { assert.notEqual(error, reference); assert.equal(error.message, reference.message); }
}
function poison(error, counters) {
  for (const [key, descriptor] of Object.entries({
    code: { get() { counters.getters++; throw counters.foreign; } },
    message: { value: secret }, stack: { value: secret }, cause: { value: secret }, data: { value: secret },
  })) {
    counters.attempts++;
    try { Object.defineProperty(error, key, { configurable: true, ...descriptor }); }
    catch (failure) { counters.refusals.push(failure); }
  }
}

export function runErrorLifecycle(name, api, observer) {
  const owners = [], targets = [];
  const own = () => { const owner = createOwner(); owners.push(owner); return owner; };
  const open = (owner, limits = TARGET_LIMITS) => {
    const target = api.openIsolatedMaintenanceTimeTarget({ databasePath: owner.databasePath, limits: { ...limits } });
    targets.push(target); return target;
  };
  const fixture = () => {
    const owner = own(), target = open(owner), callbacks = { approve: null }, calls = { resolve: 0, approve: 0 };
    const facade = api.createMaintenanceTimeAuthority({ target, executorId: 'executor', limits: { ...AUTHORITY_LIMITS },
      authority: { authorizeAdmin() { return true; } },
      approvalAuthority: { resolveApproval() { calls.resolve++; return { approverId: 'approver' }; },
        authorizeApproval() { calls.approve++; return callbacks.approve ? callbacks.approve() : true; } } });
    return { owner, target, facade, callbacks, calls,
      status: () => facade.getMaintenanceTimeStatus({}, CONTEXT),
      preview: () => facade.previewMaintenanceTimeAnchor({}, CONTEXT),
      check: () => api.checkMaintenanceTimeSession(facade, {}, CONTEXT),
      approve: preview => facade.approveMaintenanceTimeAnchor({ ...preview, approvalRef: 'lifecycle-approval' }, CONTEXT) };
  };
  const counters = { getters: 0, attempts: 0, refusals: [], foreign: new Error(secret) };
  let unresolvedPath;
  try {
    // Independent legitimate durability control establishes the fixed message.
    const control = fixture(); assert.equal(control.status().sessionPresent, false);
    control.target.invalidate(); const stale = capture(control.status); sanitized(stale, 'TARGET_STALE');
    observer.start(); observer.closeFault('still-open');
    const durability = capture(() => control.target.close());
    const controlEvents = [...observer.events]; observer.stop();
    sanitized(durability, 'DURABILITY_UNCERTAIN');
    assert.equal(observer.ownedState(control.owner.databasePath).open, true);
    assert.ok(controlEvents.some(e => e.method === 'close' && !e.nativeCalled && e.open));
    observer.closeFault(null); control.target.close(); assert.equal(observer.allClosed(), true);
    console.log(JSON.stringify({ phase: 'durability-control', scenario: name, events: controlEvents }));

    const f = fixture(); assert.equal(f.status().sessionPresent, false);
    const invalid = capture(() => f.facade.getMaintenanceTimeStatus({ extra: 1 }, CONTEXT));
    sanitized(invalid, 'INVALID');
    if (name.includes('rollback-refused')) {
      const pending = f.preview(), before = observer.image(f.owner.databasePath), files = fileImage(f.owner.dir);
      const writer = observer.connectionId(f.owner.databasePath);
      let caught, nestedEvents, callbackState;
      const reentry = name.includes('caught-reentry');
      f.callbacks.approve = () => {
        callbackState = observer.ownedState(f.owner.databasePath);
        observer.arm(/^ROLLBACK\s*;?\s*$/i, 'before');
        const start = observer.events.length;
        if (reentry) {
          try { f.status(); } catch (error) { caught = error; }
          nestedEvents = observer.events.slice(start);
          if (caught) poison(caught, counters);
          return true;
        }
        return false; // Ordinary literal approval denial, no latched reentry.
      };
      unresolvedPath = f.owner.databasePath;
      observer.start();
      const outer = capture(() => f.approve(pending));
      const events = [...observer.events], state = observer.ownedState(unresolvedPath);
      observer.stop();
      console.log(JSON.stringify({ phase: 'rollback-failure-observed', scenario: name, writer, callbackState,
        firstFault: reentry ? 'caught-reentry' : 'approval-denied', outerCode: Object.getOwnPropertyDescriptor(outer, 'code')?.value,
        state, events: events.filter(e => /^(BEGIN|ROLLBACK|COMMIT|INSERT|UPDATE)/i.test(e.sql ?? '')) }));
      sanitized(outer, 'DURABILITY_UNCERTAIN', durability);
      assert.notEqual(outer, caught); assert.notEqual(outer, counters.foreign);
      assert.deepEqual(state, { connection: writer, open: true, transaction: true });
      assert.deepEqual(callbackState, state); assert.deepEqual(f.calls, { resolve: 1, approve: 1 });
      if (reentry) { assert.ok(caught instanceof Error); assert.deepEqual(nestedEvents, []); assert.equal(counters.attempts, 5); }
      assert.equal(counters.getters, 0);
      const begin = events.findIndex(e => /^BEGIN IMMEDIATE/i.test(e.sql ?? '') && e.nativeCalled && e.transaction);
      const refusal = events.findIndex((e, i) => i > begin && /^ROLLBACK/i.test(e.sql ?? '') && e.phase === 'before-native-refusal');
      assert.ok(begin >= 0 && refusal > begin);
      assert.equal(events[refusal].nativeCalled, false); assert.equal(events[refusal].connection, writer);
      assert.equal(events[refusal].transaction, true);
      const writerEvents = events.slice(begin);
      assert.equal(writerEvents.some(e => /^ROLLBACK/i.test(e.sql ?? '') && e.nativeCalled), false,
        'no product rollback of the unresolved writer; earlier replay-reader cleanup is a different phase');
      assert.equal(events.some(e => e.method === 'constructor' || e.method === 'close' || e.fs), false);
      assert.equal(writerEvents.some(e => /^(INSERT|UPDATE|DELETE|REPLACE|COMMIT)/i.test(e.sql ?? '') && e.nativeCalled), false);
      assert.deepEqual(observer.image(unresolvedPath), before); assert.deepEqual(fileImage(f.owner.dir), files);
      f.callbacks.approve = null;
      observer.start();
      // Unresolved target must stay revoked: no status/session/proposal/retry can
      // succeed or perform SQL. Private registration fields are not observable.
      for (const action of [f.status, f.check, f.preview, () => f.approve(pending)]) {
        const revoked = capture(action), code = Object.getOwnPropertyDescriptor(revoked, 'code')?.value;
        // Both fixed revoked-state labels express refusal on LATER calls. The
        // original failed approval above must specifically report durability.
        assert.ok(['MAINTENANCE_TARGET_STALE', 'MAINTENANCE_DURABILITY_UNCERTAIN'].includes(code));
        sanitized(revoked, code.slice('MAINTENANCE_'.length), code === 'MAINTENANCE_TARGET_STALE' ? stale : durability);
      }
      assert.deepEqual(observer.events, []); observer.stop();
      assert.deepEqual(observer.ownedState(unresolvedPath), state);
      console.log(JSON.stringify({ phase: 'error-lifecycle-proof', scenario: name, getterCalls: counters.getters,
        noDeferredSuccess: true, unchangedRowsAndFiles: true, retainedOriginalWriter: writer }));
    } else {
      const owner = own(), valid = open(owner); valid.close();
      const before = owner.inspect(), files = fileImage(owner.dir);
      const low = { ...TARGET_LIMITS, maxMaintenanceMetadataBytes: 1 };
      // Actual full validation/capacity failure after real native open; no fake
      // isOpen or constructor stub. Normal cleanup first proves the phase.
      observer.start(); const admission = capture(() => open(owner, low));
      const admissionEvents = [...observer.events]; observer.stop();
      sanitized(admission, 'METADATA_LIMIT');
      assert.ok(admissionEvents.some(e => e.method === 'constructor' && e.nativeCalled && e.open));
      assert.ok(admissionEvents.some(e => e.method === 'close' && e.nativeCalled && !e.open));
      const responseLoss = name.endsWith('response-loss');
      unresolvedPath = owner.databasePath;
      observer.start(); observer.closeFault(responseLoss ? 'response-loss' : 'still-open');
      let returned;
      const outer = capture(() => { returned = open(owner, low); });
      const events = [...observer.events]; observer.stop();
      console.log(JSON.stringify({ phase: 'constructor-cleanup-observed', scenario: name,
        outerCode: Object.getOwnPropertyDescriptor(outer, 'code')?.value, events }));
      assert.equal(returned, undefined);
      sanitized(outer, responseLoss ? 'METADATA_LIMIT' : 'DURABILITY_UNCERTAIN', responseLoss ? admission : durability);
      assert.equal(events.filter(e => e.method === 'constructor' && e.phase === 'before-native').length, 1);
      const opened = events.find(e => e.method === 'constructor' && e.nativeCalled);
      const closes = events.filter(e => e.method === 'close'); assert.equal(closes.length, 1);
      assert.equal(closes[0].connection, opened.connection);
      assert.equal(closes[0].nativeCalled, responseLoss); assert.equal(closes[0].open, !responseLoss);
      if (responseLoss) unresolvedPath = undefined;
      else {
        assert.equal(observer.ownedState(owner.databasePath).open, true);
        assert.deepEqual(observer.image(owner.databasePath), before);
      }
      assert.deepEqual(fileImage(owner.dir), files);
      poison(outer, counters);
      const later = capture(() => api.openIsolatedMaintenanceTimeTarget({}));
      sanitized(later, 'INVALID', invalid); assert.notEqual(later, outer);
      // A healthy approval callback throws unbranded foreign/public input, without
      // reentry: it cannot resurrect the constructor's private classification.
      observer.closeFault(null);
      const pending = f.preview(), healthyPath = f.owner.databasePath;
      const healthyBefore = observer.image(healthyPath), healthyFiles = fileImage(f.owner.dir);
      const healthyWriter = observer.connectionId(healthyPath), callsBefore = { ...f.calls };
      const retainedState = responseLoss ? null : observer.ownedState(owner.databasePath);
      let callbackState;
      f.callbacks.approve = () => { callbackState = observer.ownedState(healthyPath); throw outer; };
      observer.start(); const propagated = capture(() => f.approve(pending));
      const propagatedEvents = [...observer.events]; observer.stop();
      sanitized(propagated, 'APPROVAL_DENIED'); assert.notEqual(propagated, outer);
      assert.notEqual(propagated, counters.foreign); assert.notEqual(propagated, later);
      assert.equal(propagated.message, 'Maintenance time operation rejected');
      assert.equal(counters.attempts, 5);
      assert.equal(counters.getters, 0);
      assert.deepEqual(callbackState, { connection: healthyWriter, open: true, transaction: true });
      assert.deepEqual(f.calls, { resolve: callsBefore.resolve + 1, approve: callsBefore.approve + 1 });
      const propagatedBegin = propagatedEvents.findIndex(e => /^BEGIN IMMEDIATE/i.test(e.sql ?? '') && e.transaction && e.nativeCalled);
      assert.ok(propagatedBegin >= 0);
      assert.equal(propagatedEvents[propagatedBegin].connection, healthyWriter);
      const writerEvents = propagatedEvents.slice(propagatedBegin);
      const rollback = writerEvents.find(e => /^ROLLBACK/i.test(e.sql ?? '') && !e.transaction && e.nativeCalled);
      assert.ok(rollback); assert.equal(rollback.connection, healthyWriter); assert.equal(rollback.open, true);
      assert.equal(propagatedEvents.some(e => e.method === 'constructor' || e.method === 'close' || e.fs), false);
      assert.equal(propagatedEvents.some(e => /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(e.sql ?? '')), false);
      assert.equal(writerEvents.some(e => /^COMMIT\b/i.test(e.sql ?? '')), false,
        'no writer COMMIT; earlier read-snapshot cleanup is a separate phase');
      assert.equal(propagatedEvents.some(e => e.connection !== undefined && e.connection !== healthyWriter), false);
      assert.deepEqual(observer.ownedState(healthyPath), { connection: healthyWriter, open: true, transaction: false });
      assert.deepEqual(observer.image(healthyPath), healthyBefore, 'all healthy DB rows including anchor/head/floor preserved');
      assert.deepEqual(fileImage(f.owner.dir), healthyFiles);
      f.callbacks.approve = null; assert.equal(f.status().sessionPresent, false);
      const noSession = f.check(); assert.equal(noSession.executable, false); assert.equal(noSession.sessionNonce, null);
      if (!responseLoss) {
        assert.notEqual(retainedState.connection, healthyWriter);
        assert.deepEqual(observer.ownedState(owner.databasePath), retainedState);
        assert.deepEqual(observer.image(owner.databasePath), before);
      }
      assert.deepEqual(fileImage(owner.dir), files);
      const recovered = f.approve(pending);
      assert.equal(recovered.replayed, false); assert.equal(recovered.sessionEstablished, true);
      assert.equal(recovered.anchor.sessionNonce, pending.proposal.sessionNonce);
      assert.equal(f.check().executable, true); assert.equal(f.status().sessionPresent, true);
      if (!responseLoss) assert.deepEqual(observer.ownedState(owner.databasePath), retainedState,
        'constructor resource remains separately retained until explicit test cleanup');
      assert.equal(counters.getters, 0); f.owner.seedUnchanged(); owner.seedUnchanged();
      console.log(JSON.stringify({ phase: 'error-lifecycle-proof', scenario: name, getterCalls: counters.getters,
        mutationAttempts: counters.attempts, mutationRefusals: counters.refusals.length,
        constructorReturned: false, freshErrors: true, propagatedCode: propagated.code, propagatedMessage: propagated.message,
        propagatedOwnFields: Reflect.ownKeys(propagated), healthyWriter, callbackState, retainedConstructorState: retainedState,
        allRowsAndFilesPreserved: true, sessionAbsentAfterFailure: true, laterHealthyApprovalSucceeded: true,
        propagatedTransaction: writerEvents.filter(e => /^(BEGIN IMMEDIATE|ROLLBACK)/i.test(e.sql ?? '')) }));
    }
    for (const failure of counters.refusals) assert.ok(failure instanceof TypeError);
  } finally {
    observer.stop(); observer.closeFault(null);
    try {
      if (unresolvedPath) observer.testCleanup(unresolvedPath);
      for (const target of targets.reverse()) { try { target.close(); } catch {} }
      assert.equal(observer.allClosed(), true, 'retain fixtures if native close cannot be confirmed');
      observer.cleanup();
      for (const owner of owners) owner.dispose();
      console.log(JSON.stringify({ phase: 'cleanup', scenario: name, confirmedClosed: true, unresolvedCleanupIsTestAction: true }));
    } catch (error) {
      console.log(JSON.stringify({ phase: 'cleanup-unconfirmed-retained', directories: owners.map(owner => owner.dir) }));
      throw error;
    }
  }
}
