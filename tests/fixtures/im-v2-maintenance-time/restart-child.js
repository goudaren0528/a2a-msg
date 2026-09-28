// Parent constructs and exclusively retains the synthetic location. The next
// child is launched only after this child's actual exit AND stdio close.
import assert from 'node:assert/strict';
import { installObserver } from './observer.js';
import { TARGET_LIMITS, AUTHORITY_LIMITS, CONTEXT, fileImage } from './owner.js';
import { dirname } from 'node:path';

let input = '';
for await (const bytes of process.stdin) input += bytes;
const request = JSON.parse(input);
const observer = installObserver(); let target;
console.log(JSON.stringify({ phase: 'ready', pid: process.pid, step: request.step }));
try {
  const api = await import('../../../src/im/v2/maintenance-time-internal.js');
  target = api.openIsolatedMaintenanceTimeTarget({ databasePath: request.databasePath, limits: { ...TARGET_LIMITS } });
  let resolves = 0, approvals = 0;
  const facade = api.createMaintenanceTimeAuthority({ target, authority: { authorizeAdmin() { return true; } },
    approvalAuthority: { resolveApproval() { resolves++; return { approverId: 'approver' }; }, authorizeApproval() { approvals++; return true; } },
    executorId: 'executor', limits: { ...AUTHORITY_LIMITS } });
  if (request.step === 'first') {
    const preview = facade.previewMaintenanceTimeAnchor({}, CONTEXT);
    const result = facade.approveMaintenanceTimeAnchor({ ...preview, approvalRef: 'restart-proof' }, CONTEXT);
    assert.equal(result.sessionEstablished, true);
    console.log(JSON.stringify({ phase: 'proof', preview, result }));
  } else {
    assert.equal(facade.getMaintenanceTimeStatus({}, CONTEXT).reason, 'PROCESS_REANCHOR_REQUIRED');
    const before = observer.image(), files = fileImage(dirname(request.databasePath));
    observer.start();
    const replay = facade.approveMaintenanceTimeAnchor({ ...request.preview, approvalRef: 'restart-proof' }, CONTEXT);
    observer.stop(); assert.equal(observer.clock.wallCalls, 0); assert.equal(observer.clock.monoCalls, 0);
    assert.equal(resolves, 0); assert.equal(approvals, 0); assert.equal(replay.replayed, true); assert.equal(replay.sessionEstablished, false);
    assert.deepEqual(observer.image(), before); assert.deepEqual(fileImage(dirname(request.databasePath)), files);
    assert.equal(observer.events.some(e => e.fs || e.method !== 'prepare' && /^(INSERT|UPDATE|DELETE|BEGIN IMMEDIATE)/i.test(e.sql ?? '')), false);
    const missing = api.checkMaintenanceTimeSession(facade, {}, CONTEXT);
    assert.equal(missing.executable, false); assert.equal(missing.reason, 'PROCESS_REANCHOR_REQUIRED'); assert.equal(missing.sessionNonce, null); assert.equal(missing.monotonicElapsedMs, null);
    const fresh = facade.previewMaintenanceTimeAnchor({}, CONTEXT); assert.notEqual(fresh.proposal.sessionNonce, request.preview.proposal.sessionNonce);
    const restored = facade.approveMaintenanceTimeAnchor({ ...fresh, approvalRef: 'new-process-approval' }, CONTEXT);
    assert.equal(restored.sessionEstablished, true); assert.equal(restored.anchor.generation, 2); assert.equal(resolves, 1); assert.equal(approvals, 2);
    assert.equal(api.checkMaintenanceTimeSession(facade, {}, CONTEXT).executable, true);
  }
  target.close(); assert.equal(observer.allClosed(), true);
  console.log(JSON.stringify({ phase: 'cleanup', confirmedClosed: true }));
  console.log(JSON.stringify({ phase: 'complete', step: request.step }));
} catch (error) { console.error(error); process.exitCode = 1; }
finally { observer.cleanup(); }
