// Contract-first cross-target controls. Uses only genuine independently admitted
// native targets; every hook is armed after legal positive controls and snapshots.
import assert from 'node:assert/strict';
import { AUTHORITY_LIMITS, CONTEXT, fileImage } from './owner.js';

export const crossTargetNames = [
  'cross-target-status', 'cross-target-preview', 'cross-target-approve', 'cross-target-check',
  'cross-target-open', 'cross-target-factory', 'cross-target-late-approval', 'cross-target-final-admin',
  'cross-target-invalidate', 'cross-target-close',
];

export function runCrossTarget(name, { api, observer, fixture, own, target, rejects }) {
  const a = fixture(), b = fixture(), clock = observer.clock;
  assert.notEqual(a.owner.databasePath, b.owner.databasePath);
  assert.equal(a.owner.constructionClosed, true); assert.equal(b.owner.constructionClosed, true);
  const aStatus = a.status(); assert.equal(aStatus.reason, 'TIME_ANCHOR_REQUIRED');
  assert.equal(a.check().reason, 'TIME_ANCHOR_REQUIRED');
  const aPending = a.preview();
  const bFirst = b.preview(), bApproved = b.approve(bFirst, 'b-control');
  assert.equal(bApproved.sessionEstablished, true); assert.equal(bApproved.replayed, false);
  assert.notEqual(bApproved.anchor.executorId, bApproved.anchor.approverId);
  assert.equal(b.status().sessionPresent, true);
  const bSession = b.check(); assert.equal(bSession.executable, true);
  const bPending = b.preview();
  assert.notEqual(aPending.proposal.instanceId, bPending.proposal.instanceId);
  assert.ok(clock.wall >= bPending.proposal.acceptNotBefore && clock.wall < bPending.proposal.acceptNotAfter);
  assert.ok(clock.wall < bPending.proposal.proposalExpiresAt);

  let extraOwner, extraTarget, create, published;
  const extraCalls = { admin: 0, resolve: 0, approve: 0 };
  if (name === 'cross-target-open' || name === 'cross-target-factory') {
    extraOwner = own(); assert.equal(extraOwner.constructionClosed, true);
    // The exact file passes real admission outside a frame; return ownership to
    // a positively closed state before testing constructor reentry.
    extraTarget = target(extraOwner);
    if (name === 'cross-target-open') { assert.equal(extraTarget.close(), undefined); extraTarget = null; }
    else create = () => api.createMaintenanceTimeAuthority({ target: extraTarget,
      authority: { authorizeAdmin() { extraCalls.admin++; return true; } },
      approvalAuthority: { resolveApproval() { extraCalls.resolve++; return { approverId: 'c-approver' }; },
        authorizeApproval() { extraCalls.approve++; return true; } }, executorId: 'c-executor', limits: { ...AUTHORITY_LIMITS } });
  }
  const both = [a, b];
  const before = both.map(f => ({ rows: observer.image(f.owner.databasePath), files: fileImage(f.owner.dir) }));
  const extraFiles = extraOwner && fileImage(extraOwner.dir);
  const extraRows = extraTarget && observer.image(extraOwner.databasePath);
  const bCalls = structuredClone(b.calls), cCalls = { ...extraCalls };
  const bId = observer.connectionId(b.owner.databasePath);
  const lifecycle = name === 'cross-target-invalidate' || name === 'cross-target-close';
  let caught, returned, hookCalls = 0, nestedEvents, nestedClock, phaseTransaction;
  function attempt() {
    hookCalls++;
    const eventStart = observer.events.length;
    const wall = clock.wallCalls, mono = clock.monoCalls;
    phaseTransaction = observer.events.filter(e => e.databasePath === a.owner.databasePath).at(-1)?.transaction ?? false;
    try {
      if (name === 'cross-target-status') returned = b.status();
      else if (name === 'cross-target-preview') returned = b.preview();
      else if (name === 'cross-target-check') returned = b.check();
      else if (name === 'cross-target-open') published = target(extraOwner);
      else if (name === 'cross-target-factory') published = create();
      else if (name === 'cross-target-invalidate') returned = b.t.invalidate();
      else if (name === 'cross-target-close') returned = b.t.close();
      else returned = b.approve(bPending, 'b-pending');
    } catch (error) { caught = error; }
    nestedEvents = observer.events.slice(eventStart);
    nestedClock = { wall: clock.wallCalls - wall, mono: clock.monoCalls - mono };
    return true; // Deliberately swallow the exact inner fault; outer must poison.
  }
  let phaseCalls = 0;
  if (name === 'cross-target-late-approval') a.callbacks.approve = () => ++phaseCalls === 2 ? attempt() : true;
  else if (name === 'cross-target-final-admin') a.callbacks.admin = () => ++phaseCalls === 3 ? attempt() : true;
  else a.callbacks.admin = attempt;
  observer.start();
  let outerError;
  try { a.approve(aPending, 'a-pending'); } catch (error) { outerError = error; }
  observer.stop();
  // Assertions are outside trusted callbacks so their own errors cannot be
  // swallowed by the engine and mistaken for the required reentry refusal.
  assert.equal(hookCalls, 1, 'armed cross-target hook was reached exactly once');
  if (name === 'cross-target-invalidate') { assert.equal(caught, undefined); assert.equal(returned, undefined); }
  else rejects(() => { throw caught; }, lifecycle ? 'TARGET_STALE' : 'INVALID');
  rejects(() => { throw outerError; }, lifecycle ? 'TARGET_STALE' : 'INVALID');
  assert.equal(published, undefined, 'no target/authority publication');
  assert.deepEqual(nestedEvents, [], 'nested entry must refuse before any SQL/read/open/FS/native close');
  assert.deepEqual(nestedClock, { wall: 0, mono: 0 });
  assert.deepEqual(b.calls, bCalls); assert.deepEqual(extraCalls, cCalls);
  assert.equal(observer.events.some(e => e.connection === bId), false, 'entire failed A phase has zero B SQL reads/writes');
  assert.equal(observer.events.some(e => e.method === 'constructor' || e.method === 'close' || e.fs), false);
  for (const [i, f] of both.entries()) {
    assert.deepEqual(observer.image(f.owner.databasePath), before[i].rows, 'anchor/head/floor/generation and every inherited row unchanged');
    assert.deepEqual(fileImage(f.owner.dir), before[i].files, 'inventory/identity/bytes/mtime unchanged'); f.owner.seedUnchanged();
  }
  if (extraOwner) assert.deepEqual(fileImage(extraOwner.dir), extraFiles);
  if (extraTarget) assert.deepEqual(observer.image(extraOwner.databasePath), extraRows);
  if (name === 'cross-target-late-approval' || name === 'cross-target-final-admin') {
    assert.equal(phaseCalls, name === 'cross-target-final-admin' ? 3 : 2);
    assert.equal(a.calls.resolve.length, 1, 'final phase is after the real resolver');
    assert.equal(a.calls.approve.length, name === 'cross-target-final-admin' ? 1 : 2);
    assert.equal(phaseTransaction, true, 'late hook reached in actual approval transaction');
    assert.ok(observer.events.some(e => /^BEGIN IMMEDIATE/i.test(e.sql ?? '') && e.phase === 'after-native'));
    assert.ok(observer.events.some(e => /^ROLLBACK/i.test(e.sql ?? '') && e.phase === 'after-native' && !e.transaction));
  }
  a.callbacks.admin = a.callbacks.approve = null;
  assert.deepEqual(a.status(), aStatus, 'failed approval did not install a session');
  assert.equal(a.check().sessionNonce, null);
  assert.equal(a.approve(aPending, 'a-pending').sessionEstablished, true, 'A frame released and registration retained');
  if (lifecycle) {
    rejects(() => b.status(), 'TARGET_STALE'); rejects(() => b.approve(bPending, 'b-pending'), 'TARGET_STALE');
    assert.equal(b.t.invalidate(), undefined); assert.equal(b.t.invalidate(), undefined);
    observer.start(); assert.equal(b.t.close(), undefined);
    assert.equal(observer.events.filter(e => e.method === 'close' && e.nativeCalled).length, 1);
    const count = observer.events.length; assert.equal(b.t.close(), undefined); assert.equal(observer.events.length, count); observer.stop();
  } else {
    assert.deepEqual(b.check(), bSession, 'B private session nonce and elapsed baseline unchanged');
    assert.equal(b.status().sessionPresent, true);
    const result = b.approve(bPending, 'b-pending');
    assert.equal(result.replayed, false); assert.equal(result.sessionEstablished, true);
    assert.equal(result.anchor.generation, bApproved.anchor.generation + 1);
    assert.equal(result.anchor.sessionNonce, bPending.proposal.sessionNonce, 'same pending registration remains usable');
  }
  if (name === 'cross-target-open') {
    observer.start(); const admitted = target(extraOwner); observer.stop();
    assert.ok(observer.events.some(e => e.method === 'constructor' && e.nativeCalled), 'native constructor instrumentation positive control');
    assert.equal(admitted.close(), undefined);
  }
  if (name === 'cross-target-factory') {
    const facade = create(); assert.equal(facade.getMaintenanceTimeStatus({}, CONTEXT).reason, 'TIME_ANCHOR_REQUIRED');
    const proposal = facade.previewMaintenanceTimeAnchor({}, CONTEXT);
    assert.equal(facade.approveMaintenanceTimeAnchor({ ...proposal, approvalRef: 'c-control' }, CONTEXT).sessionEstablished, true);
    assert.ok(extraCalls.admin > 0 && extraCalls.resolve === 1 && extraCalls.approve === 2, 'factory refusal did not consume C authority slot');
  }
  console.log(JSON.stringify({ phase: 'cross-target-proof', scenario: name, validIndependentControls: true,
    nestedCode: caught?.code ?? null, outerCode: outerError.code, nestedEvents, nestedClock, phaseTransaction,
    unchangedRowsAndFiles: true, pendingRetained: !lifecycle, frameReleased: true }));
}
