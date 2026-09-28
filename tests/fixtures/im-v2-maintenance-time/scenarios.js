import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { crossTargetNames, runCrossTarget } from './cross-target.js';
import { escapedErrorNames, runEscapedError } from './escaped-error.js';
import { createOwner, TARGET_LIMITS, AUTHORITY_LIMITS, CONTEXT, digest, proposalOf, fileImage,
  assertApprovalOnly, proposalFields, anchorFields, bindingFields, evidenceFields, statusFields } from './owner.js';

export const scenarioNames = [
  'first-anchor-readonly-replay', 'same-epoch-reanchor', 'cross-epoch-replay', 'nonce-supersession', 'failed-preview-preserves-pending',
  'unregistered-copy', 'wrong-ref-hash', 'binding-and-snapshot', 'actor-denied', 'final-approval-revocation', 'final-admin-revocation',
  'callback-hostile-throw', 'callback-thenable', 'callback-accessor-then', 'callback-async-prefix', 'callback-generator-prefix',
  'callback-reentry', 'callback-caught-invalid', 'callback-invalidate', 'callback-close', 'late-final-sample-invalidate',
  'window-start', 'window-end', 'wall-ttl-equality', 'mono-ttl-equality', 'wall-backward', 'fractional-backward', 'fractional-forward',
  'mono-regression', 'mono-malformed', 'wall-malformed', 'projection-overflow', 'safe-add-overflow', 'floor-washout',
  'preview-no-highwater-ratchet', 'floor-advance-after-preview', 'commit-before-native', 'commit-after-native', 'reanchor-commit-after-native',
  'slow-commit', 'insert-response-fault', 'head-response-fault', 'floor-response-fault', 'close-response-loss', 'close-still-open',
  'target-shapes-lifecycle', 'strict-shapes-limits', 'admission-sidecars', 'admission-aliases', 'admission-trigger',
  'admission-states', 'admission-existing-only', 'capacity-anchor', 'capacity-metadata', 'capacity-content', 'capacity-rows',
  'budget-callback-deadline', 'status-no-time', 'stored-proof-new-target',
  'authority-limit-matrix', 'approval-input-shapes', 'async-admin-prefix', 'admin-literal-true', 'approval-literal-true',
  'stale-schema-cookie', 'stale-epoch', 'stale-head', 'stale-file-identity', 'stale-directory-identity',
  'forward-bound-equality', 'negative-mono', 'negative-zero-wall', 'runtime-private-highwater',
  'preview-no-runtime-elapsed-ratchet', 'final-wall-expired', 'approval-floor-regression', 'whole-db-nonim-trigger',
  'budget-shared-fullvalidator', 'read-target-not-owned', 'fake-conversion-target', 'preview-auth-final-fault',
  'proposal-before-callback-snapshot', 'retained-actor-immutable', 'replay-current-admin', 'status-safe-does-not-assert-clock',
  'legacy-four-refused', 'identity-birth-drift', 'mode-drift-permanent', 'approval-actor-result-proxy',
  'promise-rejection-observed', 'callback-falsy-throw',
  ...crossTargetNames,
  ...escapedErrorNames,
];
export function rejects(operation, code) {
  assert.throws(operation, error => {
    assert.ok(error instanceof Error); assert.match(error.code, /^MAINTENANCE_/);
    if (code) assert.equal(error.code, `MAINTENANCE_${code}`);
    assert.ok(!/test-only|secret-provider|SELECT|sqlite|owned\.sqlite/i.test(error.message));
    assert.equal(Object.hasOwn(error, 'cause'), false); return true;
  });
}
function frozen(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) if (child && typeof child === 'object') frozen(child);
}
function noWrites(observer) {
  const writes = observer.events.filter(e => e.fs || e.method !== 'prepare' && /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX|BEGIN IMMEDIATE)\b/i.test(e.sql ?? ''));
  assert.deepEqual(writes, [], 'diagnostic must perform zero writes / write reservations / filesystem mutations');
}
export async function runScenario(name, api, observer) {
  const owners = [], targets = [];
  const own = options => { const result = createOwner(options); owners.push(result); return result; };
  const target = (owner, limits = TARGET_LIMITS) => {
    const value = api.openIsolatedMaintenanceTimeTarget({ databasePath: owner.databasePath, limits: { ...limits } }); targets.push(value); return value;
  };
  const clock = observer.clock;
  const resetCounts = () => { clock.wallCalls = clock.monoCalls = 0; };
  function fixture(options = {}) {
    observer.stop(); const owner = own(options.owner), t = target(owner, options.targetLimits);
    const callbacks = { admin: null, resolve: null, approve: null };
    const calls = { admin: 0, resolve: [], approve: [] };
    const authority = { authorizeAdmin(ctx) { assert.equal(ctx, CONTEXT); calls.admin++;
      return callbacks.admin ? callbacks.admin(ctx) : true; } };
    const approvalAuthority = { resolveApproval(binding, ctx) { assert.equal(ctx, CONTEXT); calls.resolve.push(binding);
      return callbacks.resolve ? callbacks.resolve(binding, ctx) : { approverId: 'approver' }; },
    authorizeApproval(binding, ctx) { assert.equal(ctx, CONTEXT); calls.approve.push(binding);
      return callbacks.approve ? callbacks.approve(binding, ctx) : true; } };
    const limits = { ...AUTHORITY_LIMITS, ...options.limits };
    const facade = api.createMaintenanceTimeAuthority({ target: t, authority, approvalAuthority, executorId: 'executor', limits });
    const f = { owner, t, facade, callbacks, calls, authority, approvalAuthority, limits,
      preview: () => facade.previewMaintenanceTimeAnchor({}, CONTEXT),
      approve: (p, approvalRef = 'approval') => facade.approveMaintenanceTimeAnchor({ ...p, approvalRef }, CONTEXT),
      status: () => facade.getMaintenanceTimeStatus({}, CONTEXT),
      check: () => api.checkMaintenanceTimeSession(facade, {}, CONTEXT) };
    return f;
  }
  function approve(f) {
    const p = f.preview(); const result = f.approve(p);
    assert.equal(result.replayed, false); assert.equal(result.sessionEstablished, true); return { p, result };
  }
  function readonly(f, action, { timeless = false } = {}) {
    const before = observer.image(), files = fileImage(f.owner.dir); observer.start(); resetCounts();
    try { return action(); } finally {
      observer.stop(); assert.deepEqual(observer.image(), before); assert.deepEqual(fileImage(f.owner.dir), files);
      noWrites(observer); if (timeless) { assert.equal(clock.wallCalls, 0); assert.equal(clock.monoCalls, 0); }
    }
  }
  try {
    if (escapedErrorNames.includes(name)) {
      runEscapedError(name, { observer, fixture });
    } else if (crossTargetNames.includes(name)) {
      runCrossTarget(name, { api, observer, fixture, own, target, rejects });
    } else if (name === 'first-anchor-readonly-replay') {
      const f = fixture(); const before = observer.image();
      const status = readonly(f, () => f.status(), { timeless: true });
      assert.deepEqual(Object.keys(status), statusFields); assert.equal(status.reason, 'TIME_ANCHOR_REQUIRED'); frozen(status);
      const empty = readonly(f, () => f.check()); assert.deepEqual(Object.keys(empty), evidenceFields);
      for (const key of ['anchorGeneration', 'anchorHash', 'sessionNonce', 'anchorWallAt', 'monotonicElapsedMs']) assert.equal(empty[key], null);
      assert.equal(empty.executable, false); assert.equal(empty.reason, 'TIME_ANCHOR_REQUIRED');
      const p = readonly(f, () => f.preview()); assert.equal(clock.wallCalls, 1);
      frozen(p); assert.deepEqual(Object.keys(p), ['proposal', 'proposalHash']); assert.deepEqual(Object.keys(p.proposal), proposalFields);
      assert.equal(p.proposalHash, digest('timeProposal', p.proposal));
      observer.start(); const result = f.approve(p); observer.stop();
      frozen(result); assert.deepEqual(Object.keys(result), ['anchor', 'anchorHash', 'replayed', 'sessionEstablished']);
      assert.deepEqual(Object.keys(result.anchor), anchorFields); assert.equal(result.anchorHash, digest('anchorEvidence', result.anchor));
      assert.equal(result.anchor.generation, 1); assert.equal(result.sessionEstablished, true); assert.equal(result.replayed, false);
      assertApprovalOnly(before, observer.image());
      const writes = observer.events.filter(e => e.phase === 'after-native' && e.method !== 'prepare' && /^(INSERT|UPDATE|REPLACE)/i.test(e.sql.trim()));
      assert.equal(writes.length, 3); assert.match(writes[0].sql, /im_maintenance_time_anchors/); assert.match(writes[1].sql, /im_maintenance_time_head/); assert.match(writes[2].sql, /im_clock/);
      assert.equal(f.status().sessionPresent, true); const evidence = readonly(f, () => f.check()); frozen(evidence);
      assert.equal(evidence.executable, true); assert.equal(evidence.reason, null); assert.equal(evidence.sessionNonce, p.proposal.sessionNonce);
      const resolveCount = f.calls.resolve.length, approvalCount = f.calls.approve.length;
      clock.wall = NaN; clock.mono = 'malformed';
      const replay = readonly(f, () => f.approve(p), { timeless: true });
      assert.deepEqual(replay, { anchor: result.anchor, anchorHash: result.anchorHash, replayed: true, sessionEstablished: false });
      assert.equal(f.calls.resolve.length, resolveCount); assert.equal(f.calls.approve.length, approvalCount);
      assert.equal(f.status().sessionPresent, true);
    } else if (name === 'same-epoch-reanchor') {
      const f = fixture(), first = approve(f); clock.wall++; clock.mono += 1000000n;
      const second = approve(f); assert.equal(second.result.anchor.generation, 2);
      assert.equal(second.result.anchor.previousAnchorHash, first.result.anchorHash);
      const nonce = f.check().sessionNonce;
      readonly(f, () => assert.equal(f.approve(first.p).replayed, true), { timeless: true });
      assert.equal(f.check().sessionNonce, nonce);
    } else if (name === 'cross-epoch-replay') {
      const f = fixture({ owner: { crossEpoch: true } });
      assert.equal(f.status().headGeneration, null); const p = f.preview(); assert.equal(p.proposal.previousGeneration, 1);
      assert.equal(p.proposal.previousAnchorHash, f.owner.historic.anchorHash);
      const result = f.approve(p); assert.equal(result.anchor.generation, 2);
      assert.notEqual(result.anchor.centerEpoch, f.owner.historic.anchor.centerEpoch);
      const { proposal, proposalHash, approvalRef } = f.owner.historic;
      readonly(f, () => assert.equal(f.approve({ proposal, proposalHash }, approvalRef).replayed, true), { timeless: true });
      assert.equal(f.status().sessionPresent, true);
    } else if (name === 'nonce-supersession') {
      const f = fixture(), old = f.preview(), current = f.preview(); assert.notEqual(old.proposal.sessionNonce, current.proposal.sessionNonce);
      const before = observer.image(); rejects(() => f.approve(old), 'FACT_MISMATCH'); assert.deepEqual(observer.image(), before);
      assert.equal(f.approve(current).sessionEstablished, true);
    } else if (name === 'failed-preview-preserves-pending') {
      const f = fixture(), p = f.preview(); clock.wall = 50;
      rejects(() => f.preview(), 'CLOCK_UNSAFE'); clock.wall = 100000;
      assert.equal(f.approve(p).sessionEstablished, true);
    } else if (name === 'unregistered-copy') {
      const f = fixture(), p = f.preview();
      const forged = JSON.parse(JSON.stringify(p)); forged.proposal.sessionNonce = randomUUID(); forged.proposalHash = digest('timeProposal', forged.proposal);
      const before = observer.image(); rejects(() => f.approve(forged), 'FACT_MISMATCH'); assert.deepEqual(observer.image(), before);
      assert.equal(f.approve(JSON.parse(JSON.stringify(p))).sessionEstablished, true, 'copy of actually registered bytes remains a valid request');
    } else if (name === 'wrong-ref-hash') {
      const f = fixture(), p = f.preview(); rejects(() => f.approve({ ...p, proposalHash: 'f'.repeat(64) }), 'FACT_MISMATCH');
      f.approve(p, 'fixed-reference'); const before = observer.image();
      rejects(() => f.approve(p, 'different-reference'), 'FACT_MISMATCH'); assert.deepEqual(observer.image(), before);
    } else if (name === 'binding-and-snapshot') {
      const f = fixture(), p = f.preview(), mutable = JSON.parse(JSON.stringify(p));
      f.callbacks.admin = () => { mutable.proposal.candidateWallAt = 1; mutable.proposalHash = 'f'.repeat(64); return true; };
      const result = f.approve(mutable); assert.equal(result.anchor.candidateWallAt, p.proposal.candidateWallAt);
      assert.equal(f.calls.resolve.length, 1); assert.equal(f.calls.approve.length, 2);
      const binding = f.calls.resolve[0]; frozen(binding); assert.deepEqual(Object.keys(binding), bindingFields);
      assert.equal(binding.kind, 'maintenance-time-anchor'); assert.equal(binding.proposalHash, p.proposalHash);
      assert.equal(binding.headGeneration, null); assert.equal(binding.headHash, null);
      for (const b of f.calls.approve) { frozen(b); assert.deepEqual(Object.keys(b), [...bindingFields, 'approverId']); assert.deepEqual(b, { ...binding, approverId: 'approver' }); }
    } else if (name === 'actor-denied') {
      for (const result of [{ approverId: 'executor' }, { approverId: '' }, { approverId: 'approver', extra: 1 }]) {
        const f = fixture(), p = f.preview(), before = observer.image(); f.callbacks.resolve = () => result;
        rejects(() => f.approve(p)); assert.deepEqual(observer.image(), before); f.t.close();
      }
    } else if (name === 'final-approval-revocation' || name === 'final-admin-revocation') {
      const f = fixture(), p = f.preview(), before = observer.image();
      if (name === 'final-approval-revocation') f.callbacks.approve = () => f.calls.approve.length < 2;
      else { let n = 0; f.callbacks.admin = () => ++n === 1; }
      rejects(() => f.approve(p), name === 'final-approval-revocation' ? 'APPROVAL_DENIED' : 'AUTH_DENIED'); assert.deepEqual(observer.image(), before);
    } else if (name.startsWith('callback-') && name !== 'callback-falsy-throw') {
      const f = fixture(), p = f.preview(), before = observer.image(); let touched = 0;
      if (name === 'callback-hostile-throw') f.callbacks.approve = () => { throw Object.defineProperties({}, {
        code: { get() { touched++; throw new Error('secret-provider'); } }, message: { get() { touched++; throw new Error('secret-provider'); } } }); };
      if (name === 'callback-thenable') f.callbacks.approve = () => ({ then(resolve) { touched++; resolve(true); } });
      if (name === 'callback-accessor-then') f.callbacks.approve = () => Object.defineProperty({}, 'then', { get() { touched++; return () => {}; } });
      if (name === 'callback-async-prefix' || name === 'callback-generator-prefix') {
        // The actual supplied interface itself, rather than a synchronous test
        // wrapper around it, must be refused before its prefix.
        f.t.close(); const owner = own(), t = target(owner);
        const authorizeApproval = name === 'callback-async-prefix' ? async function () { touched++; return true; } : function* () { touched++; yield true; };
        rejects(() => {
          const facade = api.createMaintenanceTimeAuthority({ target: t, authority: { authorizeAdmin() { return true; } },
            approvalAuthority: { resolveApproval() { return { approverId: 'approver' }; }, authorizeApproval }, executorId: 'executor', limits: { ...AUTHORITY_LIMITS } });
          const preview = facade.previewMaintenanceTimeAnchor({}, CONTEXT); facade.approveMaintenanceTimeAnchor({ ...preview, approvalRef: 'approval' }, CONTEXT);
        }, 'INVALID'); assert.equal(touched, 0); return;
      }
      if (name === 'callback-reentry') f.callbacks.approve = () => { try { f.status(); } catch {} return true; };
      if (name === 'callback-caught-invalid') f.callbacks.approve = () => { try { f.t.invalidate(1); } catch {} return true; };
      if (name === 'callback-invalidate') f.callbacks.approve = () => { f.t.invalidate(); return true; };
      if (name === 'callback-close') f.callbacks.approve = () => { try { f.t.close(); } catch {} return true; };
      rejects(() => f.approve(p)); assert.deepEqual(observer.image(), before);
      if (name === 'callback-hostile-throw' || name === 'callback-accessor-then') assert.equal(touched, 0);
    } else if (name === 'late-final-sample-invalidate') {
      const f = fixture(), p = f.preview(), before = observer.image();
      clock.wallHook = () => { if (f.calls.approve.length >= 2) f.t.invalidate(); return clock.wall; };
      rejects(() => f.approve(p)); assert.deepEqual(observer.image(), before); clock.wallHook = null;
    } else if (['window-start', 'window-end', 'wall-ttl-equality', 'mono-ttl-equality', 'wall-backward'].includes(name)) {
      const ttl = name === 'wall-ttl-equality' || name === 'mono-ttl-equality' ? 100 : 300000;
      const f = fixture({ limits: { proposalTtlMs: ttl } }), p = f.preview(), before = observer.image();
      if (name === 'window-end') { clock.wall += 5000; clock.mono += 5000000000n; }
      if (name === 'wall-ttl-equality') { clock.wall += ttl; clock.mono += BigInt(ttl) * 1000000n; }
      if (name === 'mono-ttl-equality') clock.mono += BigInt(ttl) * 1000000n;
      if (name === 'wall-backward') clock.wall--;
      if (name.startsWith('window-')) { const result = f.approve(p); assert.equal(result.anchor.acceptedWallAt, clock.wall); assert.equal(result.sessionEstablished, true); }
      else { rejects(() => f.approve(p), 'CLOCK_UNSAFE'); assert.deepEqual(observer.image(), before); }
    } else if (name === 'fractional-backward' || name === 'fractional-forward') {
      const f = fixture({ limits: { maxForwardJumpMs: 1 } }); approve(f);
      if (name === 'fractional-backward') { clock.mono += 1000000n; assert.equal(f.check().executable, true); clock.mono += 1n;
        const result = f.check(); assert.equal(result.monotonicElapsedMs, 1); assert.equal(result.reason, 'CLOCK_UNSAFE'); }
      else { clock.wall += 2; clock.mono += 999999n; assert.equal(f.check().reason, 'CLOCK_UNSAFE', '1ns over bound must not disappear into floored elapsed'); }
    } else if (name === 'mono-regression' || name === 'mono-malformed' || name === 'wall-malformed' || name === 'projection-overflow') {
      const f = fixture(); approve(f); const before = observer.image();
      if (name === 'mono-regression') { clock.mono += 1000000n; assert.equal(f.check().executable, true); clock.mono--; assert.equal(f.check().reason, 'CLOCK_UNSAFE'); }
      if (name === 'mono-malformed') { clock.mono = 1; rejects(() => f.check(), 'CLOCK_UNSAFE'); }
      if (name === 'wall-malformed') { clock.wall = NaN; rejects(() => f.check(), 'CLOCK_UNSAFE'); }
      if (name === 'projection-overflow') { clock.mono += BigInt(Number.MAX_SAFE_INTEGER) * 1000000n; rejects(() => f.check(), 'CLOCK_UNSAFE'); }
      assert.deepEqual(observer.image(), before);
    } else if (name === 'safe-add-overflow') {
      const f = fixture(); clock.wall = Number.MAX_SAFE_INTEGER - 1; rejects(() => f.preview(), 'CLOCK_UNSAFE');
    } else if (name === 'floor-washout') {
      const f = fixture({ limits: { maxForwardJumpMs: 10 } }); approve(f);
      clock.wall += 1000000; observer.ordinaryFloor(clock.wall);
      const before = observer.image(); assert.equal(f.check().reason, 'CLOCK_UNSAFE'); assert.deepEqual(observer.image(), before);
    } else if (name === 'preview-no-highwater-ratchet') {
      const f = fixture({ limits: { maxForwardJumpMs: 10 } }); approve(f);
      clock.wall += 1000000; f.preview(); clock.wall -= 1000000;
      assert.equal(f.check().executable, true, 'preview must not ratchet accepted highwater');
    } else if (name === 'floor-advance-after-preview') {
      const f = fixture(), p = f.preview(); clock.wall += 1; clock.mono += 1000000n;
      observer.ordinaryFloor(clock.wall); const result = f.approve(p);
      assert.equal(result.anchor.globalFloorObservedAt, 100); assert.equal(result.anchor.globalFloorAtApproval, clock.wall);
      assert.equal(f.calls.resolve[0].globalFloorObservedAt, 100);
    } else if (['commit-before-native', 'commit-after-native', 'reanchor-commit-after-native', 'slow-commit', 'insert-response-fault', 'head-response-fault', 'floor-response-fault'].includes(name)) {
      const f = fixture({ limits: { maxForwardJumpMs: 5 } }); if (name === 'reanchor-commit-after-native') approve(f);
      const p = f.preview(), before = observer.image(); observer.start();
      const match = name === 'insert-response-fault' ? /^INSERT\s+INTO\s+im_maintenance_time_anchors/i :
        name === 'head-response-fault' ? /^(INSERT|REPLACE)\s+INTO\s+im_maintenance_time_head/i :
          name === 'floor-response-fault' ? /^UPDATE\s+im_clock/i : 'commit';
      const when = name === 'commit-before-native' ? 'before' : name === 'slow-commit' ? 'observe' : 'after';
      observer.arm(match, when, name === 'slow-commit' ? () => { clock.mono += 20000000n; } : undefined);
      if (name === 'commit-before-native' || name.endsWith('response-fault')) {
        rejects(() => f.approve(p)); observer.stop(); assert.deepEqual(observer.image(), before);
        if (name === 'commit-before-native') assert.ok(observer.events.some(e => e.phase === 'before-native-refusal' && e.nativeCalled === false));
        else assert.ok(observer.events.some(e => e.phase === 'after-native' && e.method === 'run' && match.test(e.sql) && e.image), 'actual write observed before response exception');
      } else {
        const result = f.approve(p); observer.stop(); assert.equal(result.replayed, false);
        const commits = observer.events.filter(e => /^COMMIT/i.test(e.sql ?? '') && e.phase === 'after-native' && e.image);
        assert.ok(commits.length); assert.equal(commits.at(-1).transaction, false); assertApprovalOnly(before, observer.image());
        const writerId = commits.at(-1).connection;
        const afterCommit = observer.events.slice(observer.events.indexOf(commits.at(-1)) + 1);
        assert.equal(afterCommit.some(e => e.connection === writerId && /^ROLLBACK/i.test(e.sql ?? '') && e.transaction), false);
        if (name === 'slow-commit') { assert.equal(result.sessionEstablished, true); const checked = f.check(); assert.equal(checked.monotonicElapsedMs, 20); assert.equal(checked.reason, 'CLOCK_UNSAFE'); }
        else { assert.equal(result.sessionEstablished, false); assert.equal(f.status().sessionPresent, false);
          readonly(f, () => { const retry = f.approve(p); assert.equal(retry.replayed, true); assert.equal(retry.sessionEstablished, false); }, { timeless: true }); }
      }
    } else if (name === 'close-response-loss' || name === 'close-still-open') {
      const f = fixture(); approve(f); observer.start(); observer.closeFault(name === 'close-response-loss' ? 'response-loss' : 'still-open');
      if (name === 'close-response-loss') { assert.equal(f.t.close(), undefined); assert.equal(observer.allClosed(), true);
        const count = observer.events.length; assert.equal(f.t.close(), undefined); assert.equal(observer.events.length, count); }
      else { rejects(() => f.t.close(), 'DURABILITY_UNCERTAIN'); assert.equal(observer.allClosed(), false);
        rejects(() => f.status()); assert.equal(observer.events.filter(e => e.method === 'close').every(e => e.nativeCalled === false), true);
        observer.closeFault(null); f.t.close(); assert.equal(observer.allClosed(), true); }
      observer.stop();
    } else if (name === 'target-shapes-lifecycle') {
      const f = fixture(); assert.deepEqual(Object.keys(f.t), ['invalidate', 'close']); frozen(f.t); frozen(f.facade);
      assert.deepEqual(Object.keys(f.facade), ['previewMaintenanceTimeAnchor', 'approveMaintenanceTimeAnchor', 'getMaintenanceTimeStatus']);
      for (const fake of [{}, { ...f.t }, new Proxy(f.t, {})]) rejects(() => api.createMaintenanceTimeAuthority({ target: fake,
        authority: f.authority, approvalAuthority: f.approvalAuthority, executorId: 'executor', limits: { ...AUTHORITY_LIMITS } }), 'INVALID');
      for (const fake of [{}, { ...f.facade }, new Proxy(f.facade, {})]) rejects(() => api.checkMaintenanceTimeSession(fake, {}, CONTEXT), 'INVALID');
      rejects(() => api.createMaintenanceTimeAuthority({ target: f.t, authority: f.authority, approvalAuthority: f.approvalAuthority,
        executorId: 'executor', limits: { ...AUTHORITY_LIMITS } }));
      for (const method of [f.t.invalidate, f.t.close]) { rejects(() => method(), 'INVALID'); rejects(() => method.call({}, 1), 'INVALID'); }
      for (const method of ['previewMaintenanceTimeAnchor', 'getMaintenanceTimeStatus']) {
        rejects(() => f.facade[method]({}, CONTEXT, 1), 'INVALID'); rejects(() => f.facade[method].call({}, {}, CONTEXT), 'INVALID');
      }
      assert.equal(f.t.invalidate(), undefined); assert.equal(f.t.invalidate(), undefined); rejects(() => f.status(), 'TARGET_STALE');
      assert.equal(f.t.close(), undefined); observer.start(); assert.equal(f.t.close(), undefined); assert.deepEqual(observer.events, []); observer.stop();
    } else if (name === 'strict-shapes-limits') {
      const owner = own(); let traps = 0;
      const proxy = new Proxy({ ...TARGET_LIMITS }, { getOwnPropertyDescriptor() { traps++; throw new Error('trap'); }, ownKeys() { traps++; throw new Error('trap'); }, getPrototypeOf() { traps++; throw new Error('trap'); } });
      const invalid = [proxy, { ...TARGET_LIMITS, extra: 1 }, Object.create(null), { ...TARGET_LIMITS, get maxMessages() { traps++; return 1; } }];
      for (const field of Object.keys(TARGET_LIMITS)) {
        const missing = { ...TARGET_LIMITS }; delete missing[field]; invalid.push(missing);
        for (const value of [0, -0, -1, 1.5, NaN, Infinity, TARGET_LIMITS[field] + 1]) invalid.push({ ...TARGET_LIMITS, [field]: value });
      }
      for (const limits of invalid) rejects(() => api.openIsolatedMaintenanceTimeTarget({ databasePath: owner.databasePath, limits }), 'INVALID');
      assert.equal(traps, 0);
      const f = fixture();
      for (const input of [{ extra: true }, Object.create(null), new Proxy({}, { ownKeys() { traps++; throw new Error('trap'); } }),
        Object.defineProperty({}, 'hidden', { value: 1 }), { [Symbol('extra')]: 1 }]) rejects(() => f.facade.getMaintenanceTimeStatus(input, CONTEXT), 'INVALID');
      assert.equal(traps, 0);
    } else if (name === 'admission-sidecars') {
      for (const suffix of ['-wal', '-shm', '-journal']) { const owner = own(); const before = fileImage(owner.dir);
        fs.writeFileSync(owner.databasePath + suffix, ''); rejects(() => target(owner));
        fs.unlinkSync(owner.databasePath + suffix); assert.deepEqual(fileImage(owner.dir), before); }
    } else if (name === 'admission-aliases') {
      for (const kind of ['symlink', 'hardlink']) { const owner = own(), alias = join(owner.dir, 'alias.sqlite');
        if (kind === 'symlink') { fs.renameSync(owner.databasePath, alias); fs.symlinkSync(alias, owner.databasePath); }
        else fs.linkSync(owner.databasePath, alias);
        rejects(() => target(owner)); }
    } else if (name === 'admission-trigger') {
      const owner = own(); owner.arrange(db => db.exec('CREATE TABLE unrelated_sink(value INTEGER); CREATE TRIGGER unrelated_side_effect AFTER UPDATE ON im_clock BEGIN INSERT INTO unrelated_sink VALUES(new.last_observed_at); END'));
      const before = owner.inspect(); rejects(() => target(owner)); assert.deepEqual(owner.inspect(), before);
    } else if (name === 'admission-states') {
      for (const options of [{ mode: 'enabled' }, { state: 'prepared' }, { state: 'verified' }]) {
        const owner = own(options); rejects(() => target(owner), 'SCHEMA_UNSUPPORTED');
      }
    } else if (name === 'admission-existing-only') {
      const owner = own(); fs.unlinkSync(owner.databasePath); rejects(() => target(owner)); assert.equal(fs.existsSync(owner.databasePath), false);
    } else if (name === 'capacity-anchor') {
      const f = fixture({ targetLimits: { ...TARGET_LIMITS, maxMaintenanceAnchors: 1 }, limits: { maxMaintenanceAnchors: 1 } });
      approve(f); const p = f.preview(), before = observer.image(); rejects(() => f.approve(p), 'READ_UNAVAILABLE'); assert.deepEqual(observer.image(), before);
    } else if (['capacity-metadata', 'capacity-content', 'capacity-rows'].includes(name)) {
      const owner = own(), before = owner.inspect();
      const limits = { ...TARGET_LIMITS, ...(name === 'capacity-metadata' ? { maxMaintenanceMetadataBytes: 1 } :
        name === 'capacity-content' ? { maxVerifiedContentBytes: 1 } : { maxMessages: 1 }) };
      rejects(() => target(owner, limits), name === 'capacity-metadata' ? 'METADATA_LIMIT' : 'READ_UNAVAILABLE');
      assert.deepEqual(owner.inspect(), before);
    } else if (name === 'budget-callback-deadline') {
      const f = fixture({ limits: { maxElapsedMs: 20 } }); f.callbacks.admin = () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40); return true;
      };
      const before = observer.image(); rejects(() => f.preview(), 'READ_UNAVAILABLE'); assert.deepEqual(observer.image(), before);
    } else if (name === 'status-no-time') {
      const f = fixture(); approve(f); clock.wallHook = () => { throw new Error('status wall observation'); };
      clock.monoHook = () => { throw new Error('status mono observation'); };
      readonly(f, () => assert.equal(f.status().sessionPresent, true), { timeless: true });
    } else if (name === 'stored-proof-new-target') {
      const f = fixture(), { p } = approve(f); f.t.close(); assert.equal(observer.allClosed(), true);
      const second = target(f.owner), facade = api.createMaintenanceTimeAuthority({ target: second, authority: f.authority,
        approvalAuthority: f.approvalAuthority, executorId: 'executor', limits: { ...AUTHORITY_LIMITS } });
      const status = facade.getMaintenanceTimeStatus({}, CONTEXT); assert.equal(status.reason, 'PROCESS_REANCHOR_REQUIRED');
      resetCounts(); const replay = facade.approveMaintenanceTimeAnchor({ ...p, approvalRef: 'approval' }, CONTEXT);
      assert.equal(replay.replayed, true); assert.equal(replay.sessionEstablished, false); assert.equal(clock.wallCalls, 0); assert.equal(clock.monoCalls, 0);
      const check = api.checkMaintenanceTimeSession(facade, {}, CONTEXT); assert.equal(check.reason, 'PROCESS_REANCHOR_REQUIRED'); assert.equal(check.sessionNonce, null);
    } else if (name === 'authority-limit-matrix') {
      const owner = own(), t = target(owner); let touched = 0;
      const create = limits => api.createMaintenanceTimeAuthority({ target: t, authority: { authorizeAdmin() { return true; } },
        approvalAuthority: { resolveApproval() { return { approverId: 'approver' }; }, authorizeApproval() { return true; } }, executorId: 'executor', limits });
      const invalid = [{ ...AUTHORITY_LIMITS, extra: 1 }, new Proxy({ ...AUTHORITY_LIMITS }, {
        ownKeys() { touched++; throw new Error('trap'); }, getPrototypeOf() { touched++; throw new Error('trap'); } }),
      { ...AUTHORITY_LIMITS, get proposalTtlMs() { touched++; return 100; } }];
      for (const field of Object.keys(AUTHORITY_LIMITS)) {
        const missing = { ...AUTHORITY_LIMITS }; delete missing[field]; invalid.push(missing);
        for (const value of [0, -0, -1, 1.5, NaN, Infinity, AUTHORITY_LIMITS[field] + 1]) invalid.push({ ...AUTHORITY_LIMITS, [field]: value });
      }
      for (const limits of invalid) rejects(() => create(limits), 'INVALID');
      assert.equal(touched, 0); const facade = create({ ...AUTHORITY_LIMITS }); assert.equal(facade.getMaintenanceTimeStatus({}, CONTEXT).reason, 'TIME_ANCHOR_REQUIRED');
      t.close();
      const lowOwner = own(), lowTarget = target(lowOwner, { ...TARGET_LIMITS, maxMaintenanceAnchors: 2 });
      rejects(() => api.createMaintenanceTimeAuthority({ target: lowTarget, authority: { authorizeAdmin() { return true; } },
        approvalAuthority: { resolveApproval() { return { approverId: 'approver' }; }, authorizeApproval() { return true; } }, executorId: 'executor', limits: { ...AUTHORITY_LIMITS } }), 'INVALID');
    } else if (name === 'approval-input-shapes') {
      const f = fixture(), p = f.preview(); let touched = 0; const before = observer.image();
      const valid = { ...p, approvalRef: 'approval' }, variants = [{ ...valid, extra: 1 }, Object.create(null),
        new Proxy(valid, { ownKeys() { touched++; throw new Error('trap'); }, getPrototypeOf() { touched++; throw new Error('trap'); } }),
        { ...valid, get approvalRef() { touched++; return 'approval'; } }, { ...valid, [Symbol('x')]: 1 }];
      for (const field of Object.keys(valid)) { const missing = { ...valid }; delete missing[field]; variants.push(missing); }
      for (const input of variants) rejects(() => f.facade.approveMaintenanceTimeAnchor(input, CONTEXT), 'INVALID');
      assert.equal(touched, 0); assert.equal(f.calls.resolve.length, 0); assert.deepEqual(observer.image(), before);
    } else if (name === 'async-admin-prefix') {
      const owner = own(), t = target(owner); let touched = 0;
      rejects(() => {
        const facade = api.createMaintenanceTimeAuthority({ target: t, authority: { async authorizeAdmin() { touched++; return true; } },
          approvalAuthority: { resolveApproval() { return { approverId: 'approver' }; }, authorizeApproval() { return true; } }, executorId: 'executor', limits: { ...AUTHORITY_LIMITS } });
        facade.getMaintenanceTimeStatus({}, CONTEXT);
      }, 'INVALID'); assert.equal(touched, 0);
    } else if (name === 'admin-literal-true' || name === 'approval-literal-true') {
      for (const value of [1, 'true', {}, false, null, undefined]) {
        const f = fixture(), p = f.preview(), before = observer.image();
        if (name === 'admin-literal-true') f.callbacks.admin = () => value; else f.callbacks.approve = () => value;
        rejects(() => f.approve(p), name === 'admin-literal-true' ? 'AUTH_DENIED' : 'APPROVAL_DENIED');
        assert.deepEqual(observer.image(), before); f.t.close();
      }
    } else if (name === 'stale-schema-cookie') {
      const f = fixture(); f.status(); const cookie = observer.read('PRAGMA schema_version')[0].schema_version;
      const before = observer.image();
      // Defensive mode intentionally ignores direct schema_version assignment.
      // Real DDL followed by its removal leaves the exact manifest/rows intact
      // but advances the genuine native schema cookie twice.
      observer.arrangeDrift(db => db.exec('CREATE INDEX test_cookie_drift ON im_clock(last_observed_at); DROP INDEX test_cookie_drift'));
      const drifted = observer.read('PRAGMA schema_version')[0].schema_version;
      assert.equal(drifted, cookie + 2, 'actual native cookie drift, not ignored PRAGMA assignment');
      assert.deepEqual(observer.image(), before, 'all schema objects and rows restored before target observation');
      rejects(() => f.status(), 'TARGET_STALE'); rejects(() => f.status(), 'TARGET_STALE');
    } else if (name === 'stale-epoch') {
      const f = fixture(), epoch = observer.read('SELECT center_epoch FROM im_center_state')[0].center_epoch;
      const next = randomUUID(); observer.arrangeDrift(db => {
        db.run('INSERT INTO im_center_epochs(center_epoch,created_at,origin,recovery_counter) VALUES(?,1000,\'recovery\',1)', next);
        db.run('UPDATE im_center_state SET center_epoch=?', next);
      }); rejects(() => f.status());
      observer.arrangeDrift(db => db.run('UPDATE im_center_state SET center_epoch=?', epoch)); rejects(() => f.status(), 'TARGET_STALE');
    } else if (name === 'stale-head') {
      const f = fixture(); approve(f); const head = observer.read('SELECT * FROM im_maintenance_time_head')[0];
      observer.arrangeDrift(db => db.exec('DELETE FROM im_maintenance_time_head')); rejects(() => f.status(), 'TARGET_STALE');
      observer.arrangeDrift(db => db.run('INSERT INTO im_maintenance_time_head VALUES(?,?,?,?)', head.singleton, head.center_epoch, head.generation, head.anchor_hash));
      rejects(() => f.status(), 'TARGET_STALE');
    } else if (name === 'stale-file-identity') {
      const f = fixture(), saved = join(f.owner.dir, 'retained-original.sqlite');
      fs.renameSync(f.owner.databasePath, saved); fs.copyFileSync(saved, f.owner.databasePath); fs.chmodSync(f.owner.databasePath, 0o600);
      rejects(() => f.status(), 'TARGET_STALE'); fs.unlinkSync(f.owner.databasePath); fs.renameSync(saved, f.owner.databasePath);
      rejects(() => f.status(), 'TARGET_STALE');
    } else if (name === 'stale-directory-identity') {
      const f = fixture(), moved = f.owner.dir + '-retained';
      fs.renameSync(f.owner.dir, moved); fs.mkdirSync(f.owner.dir, { mode: 0o700 });
      for (const file of fs.readdirSync(moved)) fs.copyFileSync(join(moved, file), join(f.owner.dir, file));
      try { rejects(() => f.status(), 'TARGET_STALE'); }
      finally { fs.rmSync(f.owner.dir, { recursive: true }); fs.renameSync(moved, f.owner.dir); }
      rejects(() => f.status(), 'TARGET_STALE');
    } else if (name === 'forward-bound-equality') {
      const f = fixture({ limits: { maxForwardJumpMs: 1 } }); approve(f); clock.wall++; assert.equal(f.check().executable, true);
    } else if (name === 'negative-mono' || name === 'negative-zero-wall') {
      const f = fixture(); approve(f); if (name === 'negative-mono') clock.mono = -1n; else clock.wall = -0;
      rejects(() => f.check(), 'CLOCK_UNSAFE');
    } else if (name === 'runtime-private-highwater') {
      const f = fixture(); approve(f); clock.wall += 5; assert.equal(f.check().executable, true); clock.wall--;
      assert.equal(f.check().reason, 'CLOCK_UNSAFE');
    } else if (name === 'preview-no-runtime-elapsed-ratchet') {
      const f = fixture(); approve(f); clock.mono += 1000000000n; f.preview(); clock.mono -= 1000000000n;
      assert.equal(f.check().executable, true, 'preview origin is not a runtime elapsed observation');
    } else if (name === 'final-wall-expired') {
      const f = fixture({ limits: { proposalTtlMs: 100 } }), p = f.preview(), before = observer.image();
      f.callbacks.approve = () => { if (f.calls.approve.length === 2) clock.wall = p.proposal.proposalExpiresAt; return true; };
      rejects(() => f.approve(p), 'CLOCK_UNSAFE'); assert.deepEqual(observer.image(), before); assert.equal(f.calls.approve.length, 2);
    } else if (name === 'approval-floor-regression') {
      const f = fixture(), p = f.preview(); observer.ordinaryFloor(99); const before = observer.image();
      rejects(() => f.approve(p)); assert.deepEqual(observer.image(), before);
    } else if (name === 'whole-db-nonim-trigger') {
      const owner = own(); owner.arrange(db => db.exec('CREATE TABLE foreign_table(x INTEGER); CREATE TRIGGER foreign_trigger AFTER INSERT ON foreign_table BEGIN UPDATE im_clock SET last_observed_at=999999; END'));
      const before = owner.inspect(); rejects(() => target(owner)); assert.deepEqual(owner.inspect(), before);
    } else if (name === 'budget-shared-fullvalidator') {
      const f = fixture({ limits: { maxElapsedMs: 80 } }); let callbacks = 0, delayed = false;
      f.callbacks.admin = () => { if (++callbacks === 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 45); return true; };
      const before = observer.image(); observer.start();
      observer.statementHook(sql => {
        if (!delayed && /im_(messages|attachments|center_schema_transitions)/i.test(sql)) {
          delayed = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 45);
        }
      });
      rejects(() => f.preview(), 'READ_UNAVAILABLE'); observer.statementHook(null); observer.stop();
      assert.equal(delayed, true, 'deadline crosses an actual full-validator content/transition query');
      assert.deepEqual(observer.image(), before);
    } else if (name === 'read-target-not-owned') {
      const owner = own(); const { DatabaseSync } = await import('node:sqlite');
      const { createImV2MaintenanceReadTarget } = await import('../../../src/im/v2/maintenance-read-target.js');
      const db = new DatabaseSync(owner.databasePath);
      try {
        const readTarget = createImV2MaintenanceReadTarget({ db, databasePath: owner.databasePath });
        rejects(() => api.createMaintenanceTimeAuthority({ target: readTarget, authority: { authorizeAdmin() { return true; } },
          approvalAuthority: { resolveApproval() { return { approverId: 'approver' }; }, authorizeApproval() { return true; } },
          executorId: 'executor', limits: { ...AUTHORITY_LIMITS } }), 'INVALID');
        readTarget.invalidate();
      } finally { db.close(); }
    } else if (name === 'fake-conversion-target') {
      const fake = Object.freeze({ invalidate() {}, close() {}, conversionComplete: Object.freeze({ version: 1 }) });
      rejects(() => api.createMaintenanceTimeAuthority({ target: fake, authority: { authorizeAdmin() { return true; } },
        approvalAuthority: { resolveApproval() { return { approverId: 'approver' }; }, authorizeApproval() { return true; } },
        executorId: 'executor', limits: { ...AUTHORITY_LIMITS } }), 'INVALID');
    } else if (name === 'preview-auth-final-fault') {
      const f = fixture(), before = observer.image(); let n = 0;
      f.callbacks.admin = () => ++n === 1; rejects(() => f.preview(), 'AUTH_DENIED'); assert.equal(n, 2); assert.deepEqual(observer.image(), before);
    } else if (name === 'proposal-before-callback-snapshot') {
      const f = fixture(), p = f.preview(), mutable = JSON.parse(JSON.stringify(p));
      f.callbacks.resolve = () => { mutable.proposal.sessionNonce = randomUUID(); mutable.proposalHash = 'f'.repeat(64); return { approverId: 'approver' }; };
      const result = f.approve(mutable); assert.equal(result.anchor.sessionNonce, p.proposal.sessionNonce); assert.equal(result.anchor.proposalHash, p.proposalHash);
    } else if (name === 'retained-actor-immutable') {
      const f = fixture(), p = f.preview(), actor = { approverId: 'approver' };
      f.callbacks.resolve = () => actor;
      f.callbacks.approve = binding => { actor.approverId = 'substituted'; assert.equal(binding.approverId, 'approver'); return true; };
      const result = f.approve(p); assert.equal(result.anchor.approverId, 'approver'); assert.equal(f.calls.resolve.length, 1); assert.equal(f.calls.approve.length, 2);
    } else if (name === 'replay-current-admin') {
      const f = fixture(), { p } = approve(f); f.callbacks.admin = () => false;
      readonly(f, () => rejects(() => f.approve(p), 'AUTH_DENIED'), { timeless: true });
    } else if (name === 'status-safe-does-not-assert-clock') {
      const f = fixture({ limits: { maxForwardJumpMs: 1 } }); approve(f); clock.wall += 100;
      readonly(f, () => { assert.equal(f.status().sessionPresent, true); assert.equal(f.status().reason, null); }, { timeless: true });
      assert.equal(f.check().reason, 'CLOCK_UNSAFE');
    } else if (name === 'legacy-four-refused') {
      const owner = own();
      const { V4_DDL, V4_CHECKSUM, assertImSchemaV4Internal } = await import('../../../src/im/v2/schema-internal.js');
      owner.arrange(db => {
        db.exec('DROP TABLE im_center_schema_transitions; DROP TABLE im_maintenance_time_head; DROP TABLE im_maintenance_time_anchors; DROP TABLE im_schema');
        db.exec(V4_DDL[0]); db.prepare('INSERT INTO im_schema VALUES(4,?)').run(V4_CHECKSUM); assertImSchemaV4Internal(db);
      }); rejects(() => target(owner), 'SCHEMA_UNSUPPORTED');
    } else if (name === 'identity-birth-drift') {
      const f = fixture(); observer.arrangeDrift(db => db.exec('UPDATE im_instance_identity SET created_at=2'));
      rejects(() => f.status()); observer.arrangeDrift(db => db.exec('UPDATE im_instance_identity SET created_at=1'));
      rejects(() => f.status(), 'TARGET_STALE');
    } else if (name === 'mode-drift-permanent') {
      const f = fixture(); observer.arrangeDrift(db => db.exec("UPDATE im_settings SET write_mode='enabled'")); rejects(() => f.status());
      observer.arrangeDrift(db => db.exec("UPDATE im_settings SET write_mode='paused'")); rejects(() => f.status(), 'TARGET_STALE');
    } else if (name === 'approval-actor-result-proxy') {
      const f = fixture(), p = f.preview(), before = observer.image(); let touched = 0;
      f.callbacks.resolve = () => new Proxy({ approverId: 'approver' }, { ownKeys() { touched++; throw new Error('trap'); },
        getPrototypeOf() { touched++; throw new Error('trap'); }, get() { touched++; throw new Error('trap'); } });
      rejects(() => f.approve(p)); assert.equal(touched, 0); assert.deepEqual(observer.image(), before);
    } else if (name === 'promise-rejection-observed') {
      const f = fixture(), p = f.preview(), before = observer.image();
      f.callbacks.approve = () => Promise.reject(new Error('secret-provider'));
      rejects(() => f.approve(p)); assert.deepEqual(observer.image(), before);
      await new Promise(resolve => setImmediate(resolve));
    } else if (name === 'callback-falsy-throw') {
      for (const value of [null, undefined, false, 0, '']) {
        const f = fixture(), p = f.preview(), before = observer.image(); let calls = 0;
        f.callbacks.approve = () => { calls++; throw value; };
        rejects(() => f.approve(p)); assert.equal(calls, 1, 'falsy throw callback actually invoked'); assert.deepEqual(observer.image(), before); f.t.close();
      }
    } else throw new Error(`unknown isolated scenario ${name}`);
  } finally {
    observer.stop(); clock.wallHook = clock.monoHook = null; observer.closeFault(null);
    for (const t of targets.reverse()) { try { t.close(); } catch {} }
    const closedBeforeCleanup = observer.allClosed(); observer.cleanup();
    assert.equal(observer.allClosed(), true, 'all test-owned native resources closed before filesystem ownership release');
    for (const owner of owners.reverse()) owner.dispose();
    console.log(JSON.stringify({ phase: 'cleanup', closedBeforeCleanup, confirmedClosed: true }));
    assert.equal(closedBeforeCleanup, true, 'engine must close its owned resources; forced test cleanup is not product success');
  }
}
