import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { validationLimits } from './backup.js';
import { adapter, closureBinding, closureProof, recordCopy, sourceTable } from './recovery-source.js';
export { createClosedV3Source } from './recovery-source.js';
import { assertStaged, candidateFacts, completed, directory, lock, prepareDatabase, putRecord, readRecord, stageDatabase, standalone, transitionDatabase } from './recovery-candidate.js';
import { activeEvidence, readActivation, readSeal, sealEvidence, sealReference } from './recovery-terminal.js';
import { assertRecoveryActivationPlanFresh, assertRecoveryPlanFresh, hashRecoveryRecord, hashRecoveryRequestInput, hashRecoveryRequestRef,
  validateRecoverySealBindings, validateRecoveryActivationPlanBindings,
  validateRecoveryLocator, validateRecoveryNormalizationBindings, validateRecoveryPauseBindings, validateRecoveryPlanBindings } from './recovery-plan.js';
import { canonical, decode, directoryEntries, exists, fail, hash, invalid, operationBudget,
  fileHash, privateDirectory, protectedPath, publishBytes, readBytes, ref, resyncPublished, same, sha, shape, time, uuid } from './recovery-records.js';

function inputCopy(value, keys) {
  try { shape(value, keys); return Object.freeze(Object.fromEntries(keys.map(k => [k, value[k]]))); }
  catch { throw fail('RECOVERY_INVALID'); }
}
function policyCopy(value) {
  const p = inputCopy(value, ['version', 'effectiveAt', 'messageRetentionMs', 'attachmentRetentionMs', 'safeRetryWindowMs',
    'auditRetentionMs', 'keyReservation', 'expiryEnabled', 'purgeEnabled', 'backupCleanupEnabled', 'backupRetentionMs']);
  if (p.version !== 2 || !time(p.effectiveAt) || p.messageRetentionMs !== 7776000000 || p.attachmentRetentionMs !== 7776000000 ||
      p.safeRetryWindowMs !== 604800000 || p.auditRetentionMs !== 15552000000 || p.keyReservation !== 'indefinite' ||
      p.expiryEnabled !== false || p.purgeEnabled !== false || p.backupCleanupEnabled !== false || p.backupRetentionMs !== null) throw fail('RECOVERY_INVALID');
  return p;
}
export function createImV2RecoveryServices({ root, sourceCatalog, authority, approvalAuthority, evidenceAuthority,
  policy: suppliedPolicy, clock = Date.now, limits } = {}) {
  root = privateDirectory(root);
  const policy = policyCopy(suppliedPolicy), policyHash = sha(JSON.stringify(policy)), bounds = validationLimits(limits);
  if (typeof clock !== 'function' || Object.prototype.toString.call(clock) === '[object AsyncFunction]') throw fail('RECOVERY_INVALID');
  const now = () => { const value = adapter({ clock }, 'clock', [], 'RECOVERY_INVALID', false); if (!time(value)) throw fail('RECOVERY_INVALID'); return value; };
  const sources = sourceTable(sourceCatalog, evidenceAuthority, now);
  const requests = join(root, 'requests'), runs = join(root, 'runs');
  const runPath = id => join(runs, id);
  const locatorPath = requestRef => join(requests, `${hashRecoveryRequestRef(requestRef)}.json`);
  const admin = ctx => adapter(authority, 'authorizeAdmin', [ctx], 'RECOVERY_AUTH_DENIED');
  function boundary(action) {
    try { return action(); }
    catch (error) {
      let code;
      try { code = error?.code; } catch { /* hostile exceptions are never authority */ }
      if (typeof code === 'string' && /^RECOVERY_[A-Z_]+$/.test(code)) throw fail(code);
      if (code === 'IM_V2_BUDGET_EXCEEDED') throw fail('RECOVERY_BUSY');
      throw fail('RECOVERY_EVIDENCE_MISMATCH');
    }
  }
  function workspace(create, consume) {
    privateDirectory(root);
    if (create) { directory(requests); directory(runs); }
    else if (!exists(requests) || !exists(runs)) throw fail('RECOVERY_NOT_FOUND');
    // A may use root/coordination.sqlite. B's workspace coordinator is separate,
    // preserving source -> workspace -> candidate -> business lock order.
    return lock(requests, create, consume);
  }
  function byRun(runId, budget) {
    if (!exists(requests)) throw fail('RECOVERY_NOT_FOUND');
    let found;
    directoryEntries(requests, budget, name => {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) return;
      const l = readRecord(join(requests, name), 'requestLocator', budget);
      if (name !== `${hashRecoveryRequestRef(l.requestRef)}.json`) invalid();
      if (l.runId === runId) { if (found) invalid(); found = l; }
    });
    if (!found) {
      if (exists(runPath(runId))) invalid();
      throw fail('RECOVERY_NOT_FOUND');
    }
    if (found.stage.policyHash !== policyHash) invalid();
    return found;
  }
  function bindingCheck(locator, proof, ctx) {
    validateRecoveryLocator(locator, { binding: proof.sourceBinding });
    // Closed-source observation time is an immutable first-observation fact.
    if (JSON.stringify(locator.stage.sourceEvidence) !== JSON.stringify(proof.sourceEvidence)) invalid();
    closureProof(evidenceAuthority, proof.sourceBinding, ctx, locator.sourceClosedEvidence);
  }
  function holdReceipt(locator, budget) {
    const path = join(runPath(locator.runId), 'hold.json');
    if (!exists(path)) return null;
    const hold = decode('hold', readBytes(path, budget));
    if (hold.recoveryRunId !== locator.runId || hold.stageHash !== locator.stageHash || hold.backupId !== locator.stage.sourceEvidence?.backupId) invalid();
    return hold;
  }
  function records(locator, budget) {
    const dir = runPath(locator.runId), stage = readRecord(join(dir, 'stage.json'), 'stage', budget);
    if (!stage) throw fail('RECOVERY_RETRY_STAGE');
    if (hashRecoveryRecord('stage', stage) !== locator.stageHash || JSON.stringify(stage) !== JSON.stringify(locator.stage)) invalid();
    const closure = readRecord(join(dir, 'source-closed.json'), 'closureProof', budget);
    if (closure === null && locator.sourceClosedEvidence !== null) throw fail('RECOVERY_RETRY_STAGE');
    if (JSON.stringify(closure) !== JSON.stringify(locator.sourceClosedEvidence)) invalid();
    const staged = readRecord(join(dir, 'staged.json'), 'staged', budget);
    const base = readRecord(join(dir, 'base.json'), 'base', budget);
    const copyIntent = readRecord(join(dir, 'copy-intent.json'), 'copyIntent', budget);
    const normalizationIntent = readRecord(join(dir, 'normalization-intent.json'), 'normalizationIntent', budget);
    const normalized = readRecord(join(dir, 'normalized.json'), 'normalized', budget);
    const pauseIntent = readRecord(join(dir, 'pause-intent.json'), 'pauseIntent', budget);
    const paused = readRecord(join(dir, 'paused.json'), 'paused', budget);
    if (!staged) throw fail('RECOVERY_INDETERMINATE');
    const chain = { stage, copyIntent, base, normalizationIntent, normalized, pauseIntent, paused };
    if (stage.candidateKind === 'fresh_bootstrap') {
      if (base || copyIntent || normalizationIntent || normalized || pauseIntent || paused || exists(join(dir, 'source-verified.sqlite'))) invalid();
    } else {
      validateRecoveryNormalizationBindings(chain);
      if (stage.candidateKind === 'v3_import') validateRecoveryPauseBindings(chain);
      else if (pauseIntent || paused) invalid();
    }
    if (staged.stagedAt < (paused?.pausedAt ?? normalized?.normalizedAt ?? stage.createdAt)) invalid();
    let plan = null, planHash = null;
    directoryEntries(dir, budget, name => {
      if (!name.startsWith('prepare-')) return;
      if (!/^prepare-[0-9a-f]{64}\.json$/.test(name) || plan) invalid();
      plan = readRecord(join(dir, name), 'preparePlan', budget); planHash = hashRecoveryRecord('preparePlan', plan);
      if (name !== `prepare-${planHash}.json`) invalid();
    });
    return { ...chain, staged, sourceClosedEvidence: closure, plan, planHash };
  }
  function validated(locator, budget) {
    const data = records(locator, budget);
    const actual = candidateFacts(join(runPath(locator.runId), 'candidate.sqlite'), data.stage, budget);
    assertStaged(data.stage, data.staged, actual, data.base);
    if (data.stage.candidateKind === 'snapshot_recovery' && !actual.run &&
        fileHash(join(runPath(locator.runId), 'candidate.sqlite'), budget) !== data.normalized.normalizedCandidateHash) invalid();
    const previousRecoveryCounter = data.stage.candidateKind === 'snapshot_recovery'
      ? (actual.run ? actual.center.recovery_counter - 1 : actual.center.recovery_counter) : null;
    if (data.plan) {
      validateRecoveryPlanBindings(data.plan, { ...data, previousRecoveryCounter });
      if (data.plan.createdAt < data.staged.stagedAt) invalid();
      if (actual.run) completed(data.plan, data.planHash, actual);
    }
    else {
      const e = data.stage.sourceEvidence, b = data.base;
      if (e === null ? b !== null : !b || b.runId !== data.stage.runId || b.stageHash !== locator.stageHash ||
          b.candidateReference !== data.stage.candidateReference || b.candidateBaseHash !== (e.fileHash ?? e.closedSourceFileHash) ||
          b.sourceSchemaVersion !== e.schemaVersion || b.sourceSchemaChecksum !== e.schemaChecksum) invalid();
      if (actual.run || (data.stage.candidateKind !== 'snapshot_recovery' &&
          (actual.center.center_epoch !== data.staged.initialEpoch || actual.center.recovery_run_id !== null ||
           actual.center.status !== 'prepared' || actual.writeMode !== 'paused'))) invalid();
    }
    return { ...data, actual };
  }
  function makePlan(data, actual, createdAt) {
    const { stage, staged, base, sourceClosedEvidence } = data, e = stage.sourceEvidence;
    const snapshot = stage.candidateKind === 'snapshot_recovery', registered = e?.kind === 'registered-backup';
    if (createdAt < staged.stagedAt || createdAt > Number.MAX_SAFE_INTEGER - 300000 || (snapshot && actual.center.recovery_counter >= Number.MAX_SAFE_INTEGER)) throw fail('RECOVERY_INVALID');
    const plan = recordCopy('preparePlan', { version: 1, runId: stage.runId, candidateKind: stage.candidateKind,
      preparationRef: stage.preparationRef, instanceId: staged.instanceId, instanceCreatedAt: staged.instanceCreatedAt,
      backupId: registered ? e.backupId : null, backupFileHash: registered ? e.fileHash : null, manifestHash: registered ? e.manifestHash : null,
      sourceSchemaVersion: e?.schemaVersion ?? null, sourceSchemaChecksum: e?.schemaChecksum ?? null,
      candidateReference: stage.candidateReference, oldEpoch: snapshot ? staged.initialEpoch : null,
      newEpoch: snapshot ? randomUUID() : staged.initialEpoch, recoveryCounter: snapshot ? actual.center.recovery_counter + 1 : 0,
      policyHash, rpoReport: e ? { status: 'unknown', snapshotCompletedAt: registered ? e.completedAt : null,
        sourceObservedAt: registered ? null : e.observedAt, missingAcceptedCount: null, missingAckCount: null,
        missingReadCount: null, comparisonEvidenceHash: null, authChanges: 'unknown', notesCode: 'COMPARISON_INCOMPLETE' } : null,
      sourceEvidence: e, sourceClosedEvidenceRef: stage.sourceClosedEvidenceRef, isolationAckRef: stage.isolationAckRef,
      createdAt, expiresAt: createdAt + 300000 });
    return validateRecoveryPlanBindings(plan, { stage, staged, base, sourceClosedEvidence,
      previousRecoveryCounter: snapshot ? actual.center.recovery_counter : null });
  }
  function persistEvidence(locator, data, held, budget) {
    // A previous publication may have become visible before its directory sync
    // failed. Mutating operations reestablish durability; readonly paths never do.
    const dir = runPath(locator.runId);
    putRecord(locatorPath(locator.requestRef), 'requestLocator', locator, budget);
    if (locator.sourceClosedEvidence) putRecord(join(dir, 'source-closed.json'), 'closureProof', locator.sourceClosedEvidence, budget);
    putRecord(join(dir, 'stage.json'), 'stage', data.stage, budget);
    if (data.base) putRecord(join(dir, 'base.json'), 'base', data.base, budget);
    if (data.normalized) {
      for (const [name, kind] of [['copy-intent.json', 'copyIntent'], ['normalization-intent.json', 'normalizationIntent'], ['normalized.json', 'normalized']])
        putRecord(join(dir, name), kind, data[kind], budget);
    }
    if (data.stage.candidateKind === 'v3_import') {
      for (const [name, kind] of [['pause-intent.json', 'pauseIntent'], ['paused.json', 'paused']])
        putRecord(join(dir, name), kind, readRecord(join(dir, name), kind, budget), budget);
    }
    putRecord(join(dir, 'staged.json'), 'staged', data.staged, budget);
    if (held) publishBytes(join(dir, 'hold.json'), canonical('hold', held.hold), budget);
    if (data.plan) putRecord(join(dir, `prepare-${data.planHash}.json`), 'preparePlan', data.plan, budget);
  }
  function observedBinding(data, held) {
    // Only A's observed getHold/binding has authority. In particular STAGED is
    // not permission to fabricate a replacement plan after binding response loss.
    if (held?.binding && (!data.plan || held.binding.preparePlanHash !== data.planHash)) invalid();
    if (data.actual.run && held !== null && held.binding?.preparePlanHash !== data.planHash) invalid();
    return data;
  }
  function readScope(locator, ctx, budget, consume, allowCompletionRepair = false) {
    const receipt = holdReceipt(locator, budget);
    const registered = locator.stage.sourceEvidence?.kind === 'registered-backup';
    if (registered ? !receipt : receipt !== null) throw fail('RECOVERY_INDETERMINATE');
    return sources.withSource(locator.stage, ctx, budget, registered ? 'held' : 'read', { sourceEvidence: locator.stage.sourceEvidence, receipt }, proof => {
      const held = registered ? proof : null;
      bindingCheck(locator, proof, ctx);
      return workspace(false, () => {
        const current = byRun(locator.runId, budget);
        if (JSON.stringify(current) !== JSON.stringify(locator)) invalid();
        return lock(runPath(locator.runId), false, () => {
          if (JSON.stringify(holdReceipt(current, budget)) !== JSON.stringify(receipt)) invalid();
          if (!exists(join(runPath(locator.runId), 'candidate.sqlite'))) throw fail('RECOVERY_INDETERMINATE');
          const identity = protectedPath(join(runPath(locator.runId), 'candidate.sqlite'));
          const data = observedBinding(validated(current, budget), held);
          if (data.actual.run?.status === 'active') {
            const evidence = activeEvidence(root, data, held, budget);
            // Visible matching evidence is an observation, not proof of a prior
            // successful fsync. Only explicit activation reestablishes durability.
            if (!evidence.stored && !allowCompletionRepair) throw fail('RECOVERY_INDETERMINATE');
          } else if (held?.release) invalid();
          const result = consume({ ...data, candidateIdentity: identity }, held);
          if (!same(identity, protectedPath(join(runPath(locator.runId), 'candidate.sqlite')))) invalid();
          return result;
        });
      });
    });
  }
  function stageCandidate(value, ctx) { return boundary(() => {
    const input = inputCopy(value, ['requestRef', 'candidateKind', 'sourceRef', 'isolationAckRef']); admin(ctx);
    if (!ref(input.requestRef)) throw fail('RECOVERY_INVALID');
    const requestHash = hashRecoveryRequestInput({ candidateKind: input.candidateKind, sourceRef: input.sourceRef, isolationAckRef: input.isolationAckRef, policyHash });
    const budget = operationBudget(bounds); budget.tick();
    // A prior closed-source observation must survive facade/clock replacement.
    const previous = exists(requests) ? readRecord(locatorPath(input.requestRef), 'requestLocator', budget) : null;
    if (previous && (previous.requestRef !== input.requestRef || previous.requestHash !== requestHash)) throw fail('RECOVERY_INVALID');
    return sources.withSource(input, ctx, budget, 'stage', { sourceEvidence: previous?.stage.sourceEvidence }, proof => workspace(true, () => {
      let locator = readRecord(locatorPath(input.requestRef), 'requestLocator', budget);
      if (locator) {
        if (locator.requestRef !== input.requestRef || locator.requestHash !== requestHash) throw fail('RECOVERY_INVALID');
        bindingCheck(locator, proof, ctx);
      } else {
        // Pending locators have unknown irreversible identities. Do not bypass them.
        const boundRuns = new Set();
        directoryEntries(requests, budget, name => {
          if (name.endsWith('.pending')) throw fail('RECOVERY_INDETERMINATE');
          if (/^[0-9a-f]{64}\.json$/.test(name)) {
            const saved = readRecord(join(requests, name), 'requestLocator', budget);
            if (name !== `${hashRecoveryRequestRef(saved.requestRef)}.json` || boundRuns.has(saved.runId)) invalid();
            boundRuns.add(saved.runId);
          }
        });
        directoryEntries(runs, budget, name => { if (!uuid(name) || !boundRuns.has(name)) throw fail('RECOVERY_INDETERMINATE'); });
        const closure = closureProof(evidenceAuthority, proof.sourceBinding, ctx), runId = randomUUID();
        const stage = recordCopy('stage', { version: 1, requestRef: input.requestRef, requestHash, runId,
          candidateKind: input.candidateKind, sourceRef: input.sourceRef, sourceEvidence: proof.sourceEvidence,
          sourceClosedEvidenceRef: closure?.evidenceRef ?? null, sourceClosedEvidenceHash: closure ? hashRecoveryRecord('closureProof', closure) : null,
          isolationAckRef: input.isolationAckRef, policyHash, candidateReference: `runs/${runId}/candidate.sqlite`,
          preparationRef: input.candidateKind === 'snapshot_recovery' ? null : randomUUID(), createdAt: now() });
        locator = recordCopy('requestLocator', { version: 1, requestRef: input.requestRef, requestHash, runId, stage,
          sourceClosedEvidence: closure, stageHash: hashRecoveryRecord('stage', stage) });
        validateRecoveryLocator(locator, { binding: proof.sourceBinding });
      }
      // Irreversible locator first, then run/proof/stage, then hold, then copy.
      putRecord(locatorPath(input.requestRef), 'requestLocator', locator, budget);
      const dir = directory(runPath(locator.runId));
      if (locator.sourceClosedEvidence) putRecord(join(dir, 'source-closed.json'), 'closureProof', locator.sourceClosedEvidence, budget);
      else if (exists(join(dir, 'source-closed.json')) || exists(join(dir, 'hold.json'))) invalid();
      putRecord(join(dir, 'stage.json'), 'stage', locator.stage, budget);
      const held = proof.establish ? proof.establish({ recoveryRunId: locator.runId, stageHash: locator.stageHash, preparePlanHash: null }) : proof;
      if (held.hold) publishBytes(join(dir, 'hold.json'), canonical('hold', held.hold), budget);
      return lock(dir, true, () => {
        directoryEntries(dir, budget, name => { if (name.endsWith('.pending')) throw fail('RECOVERY_INDETERMINATE'); });
        const staged = stageDatabase({ runRoot: dir, stage: locator.stage, proof: held, policy, budget, now });
        return recordCopy('stageResult', { runId: locator.runId, candidateReference: locator.stage.candidateReference,
          status: 'staged', stageHash: locator.stageHash, preparationRef: staged.preparationRef, instanceId: staged.instanceId,
          instanceCreatedAt: staged.instanceCreatedAt, initialEpoch: staged.initialEpoch, importEpoch: staged.importEpoch, holdId: held.hold?.holdId ?? null });
      });
    }));
  }); }
  function runInput(value, ctx, fields = ['runId']) {
    const input = inputCopy(value, fields);
    if (!uuid(input.runId) || fields.some(key => key !== 'runId' &&
        (key === 'isolationAckRef' && input[key] === null ? false :
          key.endsWith('Hash') ? !hash(input[key]) : !ref(input[key])))) throw fail('RECOVERY_INVALID');
    admin(ctx); return input;
  }
  function previewRecovery(value, ctx) { return boundary(() => {
    const input = runInput(value, ctx), budget = operationBudget(bounds), locator = byRun(input.runId, budget);
    return readScope(locator, ctx, budget, (data, held) => {
      if (data.actual.run) invalid();
      const preparePlan = data.plan ?? makePlan(data, data.actual, now());
      assertRecoveryPlanFresh(preparePlan, now());
      const preparePlanHash = hashRecoveryRecord('preparePlan', preparePlan);
      persistEvidence(locator, data, held, budget);
      putRecord(join(runPath(input.runId), `prepare-${preparePlanHash}.json`), 'preparePlan', preparePlan, budget);
      return Object.freeze({ preparePlan, preparePlanHash });
    });
  }); }
  function prepareRecovery(value, ctx) { return boundary(() => {
    const input = runInput(value, ctx, ['runId', 'preparePlanHash', 'approvalRef']);
    if (!hash(input.preparePlanHash) || !ref(input.approvalRef)) throw fail('RECOVERY_INVALID');
    const budget = operationBudget(bounds), locator = byRun(input.runId, budget);
    const observed = readScope(locator, ctx, budget, (data, held) => {
      if (!data.plan || data.planHash !== input.preparePlanHash) invalid();
      const status = completed(data.plan, data.planHash, data.actual, input.approvalRef);
      if (status && held?.binding?.preparePlanHash !== data.planHash && held !== null) invalid();
      return { data, status };
    });
    if (observed.status) return Object.freeze({ runId: input.runId, candidateReference: locator.stage.candidateReference,
      newEpoch: observed.data.plan.newEpoch, status: observed.status });
    const approve = () => {
      admin(ctx); sources.isolation(locator.stage, ctx);
      closureProof(evidenceAuthority, closureBinding(locator.stage, locator.stage.sourceEvidence), ctx, locator.sourceClosedEvidence);
      adapter(approvalAuthority, 'authorizeApproval', [Object.freeze({ kind: 'prepare', planHash: input.preparePlanHash, approvalRef: input.approvalRef }), ctx], 'RECOVERY_APPROVAL_DENIED');
    };
    approve();
    return sources.withSource(locator.stage, ctx, budget, 'prepare', { recoveryRunId: input.runId, stageHash: locator.stageHash,
      preparePlanHash: input.preparePlanHash, sourceEvidence: locator.stage.sourceEvidence }, proof => {
      bindingCheck(locator, proof, ctx);
      return workspace(false, () => lock(runPath(input.runId), false, () => {
        const current = byRun(input.runId, budget); if (JSON.stringify(current) !== JSON.stringify(locator)) invalid();
        const data = observedBinding(validated(current, budget), proof.hold ? proof : null);
        if (data.planHash !== input.preparePlanHash) invalid();
        const done = completed(data.plan, data.planHash, data.actual, input.approvalRef);
        if (done === 'active' && !activeEvidence(root, data, proof.hold ? proof : null, budget).stored) throw fail('RECOVERY_INDETERMINATE');
        if (done) return Object.freeze({ runId: input.runId, candidateReference: locator.stage.candidateReference, newEpoch: data.plan.newEpoch, status: done });
        if (proof.hold && (proof.hold.stageHash !== locator.stageHash || proof.binding?.preparePlanHash !== input.preparePlanHash)) invalid();
        persistEvidence(locator, data, proof.hold ? proof : null, budget);
        return prepareDatabase({ path: join(runPath(input.runId), 'candidate.sqlite'), ...data, planHash: data.planHash,
          approvalRef: input.approvalRef, budget, clock: now, authorize: approve, fresh: value => assertRecoveryPlanFresh(data.plan, value) });
      }));
    });
  }); }
  function reauthorize(locator, ctx) {
    admin(ctx); sources.isolation(locator.stage, ctx);
    closureProof(evidenceAuthority, closureBinding(locator.stage, locator.stage.sourceEvidence), ctx, locator.sourceClosedEvidence);
  }
  function authReview(data, sealHash, authReviewRef, ctx) {
    adapter(evidenceAuthority, 'assertAuthReview', [Object.freeze({ runId: data.stage.runId,
      preparePlanHash: data.planHash, sealHash, newEpoch: data.plan.newEpoch, authReviewRef }), ctx], 'RECOVERY_EVIDENCE_MISMATCH');
  }
  function candidatePath(data) { return join(runPath(data.stage.runId), 'candidate.sqlite'); }
  function closedHash(data, budget, sync = false) {
    const path = candidatePath(data);
    standalone(path, budget);
    if (sync) resyncPublished(path, budget);
    const digest = fileHash(path, budget);
    standalone(path, budget);
    return digest;
  }
  function verifyRecovery(value, ctx) { return boundary(() => {
    const input = runInput(value, ctx, ['runId', 'preparePlanHash']);
    if (!hash(input.preparePlanHash)) throw fail('RECOVERY_INVALID');
    const budget = operationBudget(bounds), locator = byRun(input.runId, budget);
    return readScope(locator, ctx, budget, data => {
      if (!data.plan || data.planHash !== input.preparePlanHash || !['prepared', 'verified'].includes(data.actual.run?.status)) invalid();
      const authorize = () => reauthorize(locator, ctx);
      authorize();
      if (data.actual.run.status === 'prepared') {
        transitionDatabase({ path: candidatePath(data), data, budget, clock: now, authorize });
        data = validated(locator, budget);
      }
      if (data.actual.run.status !== 'verified') invalid();
      const candidateFileHash = closedHash(data, budget, true);
      const seal = recordCopy('seal', { version: 1, runId: input.runId, preparePlanHash: data.planHash,
        newEpoch: data.plan.newEpoch, candidateReference: data.plan.candidateReference, candidateFileHash,
        schemaChecksum: data.actual.schemaChecksum, verifiedAt: data.actual.run.verified_at,
        verification: { integrity: true, foreignKeys: true, schema: true, invariants: true } });
      const sealHash = hashRecoveryRecord('seal', seal), reference = sealReference(input.runId, sealHash);
      validateRecoverySealBindings(seal, sealEvidence(data, reference, candidateFileHash));
      authorize();
      directory(join(runPath(input.runId), 'seals'));
      putRecord(join(root, reference), 'seal', seal, budget);
      return Object.freeze({ runId: input.runId, status: 'verified', sealReference: reference, sealHash });
    });
  }); }
  function previewActivation(value, ctx) { return boundary(() => {
    const input = runInput(value, ctx, ['runId', 'sealReference', 'authReviewRef', 'isolationAckRef', 'activationRef']);
    if (!ref(input.sealReference) || !ref(input.authReviewRef) || !ref(input.activationRef) ||
        input.isolationAckRef !== null && !ref(input.isolationAckRef)) throw fail('RECOVERY_INVALID');
    const budget = operationBudget(bounds), locator = byRun(input.runId, budget);
    return readScope(locator, ctx, budget, data => {
      if (!data.plan || data.actual.run?.status !== 'verified' || input.isolationAckRef !== data.plan.isolationAckRef) invalid();
      const evidence = readSeal(root, data, input.sealReference, budget, closedHash(data, budget));
      const sealHash = hashRecoveryRecord('seal', evidence.seal);
      const authorize = () => { reauthorize(locator, ctx); authReview(data, sealHash, input.authReviewRef, ctx); };
      authorize();
      let found = null;
      directoryEntries(runPath(input.runId), budget, name => {
        if (!name.startsWith('activation-') || name === 'activation-complete.json') return;
        if (!/^activation-[0-9a-f]{64}\.json$/.test(name)) invalid();
        const saved = readRecord(join(runPath(input.runId), name), 'activationPlan', budget);
        if (name !== `activation-${hashRecoveryRecord('activationPlan', saved)}.json` || saved.runId !== input.runId) invalid();
        if (saved.activationRef === input.activationRef) { if (found) invalid(); found = saved; }
      });
      if (found && (found.sealHash !== sealHash || found.authReviewRef !== input.authReviewRef || found.isolationAckRef !== input.isolationAckRef)) invalid();
      const createdAt = found?.createdAt ?? now();
      if (createdAt > Number.MAX_SAFE_INTEGER - 300000) throw fail('RECOVERY_INVALID');
      const activationPlan = found ?? recordCopy('activationPlan', { version: 1, runId: input.runId,
        preparePlanHash: data.planHash, sealHash, candidateReference: data.plan.candidateReference, newEpoch: data.plan.newEpoch,
        authReviewRef: input.authReviewRef, isolationAckRef: input.isolationAckRef, createdAt, expiresAt: createdAt + 300000, activationRef: input.activationRef });
      validateRecoveryActivationPlanBindings(activationPlan, evidence);
      authorize(); assertRecoveryActivationPlanFresh(activationPlan, now());
      const activationPlanHash = hashRecoveryRecord('activationPlan', activationPlan);
      putRecord(join(runPath(input.runId), `activation-${activationPlanHash}.json`), 'activationPlan', activationPlan, budget);
      return Object.freeze({ activationPlan, activationPlanHash });
    });
  }); }
  function activateRecovery(value, ctx) { return boundary(() => {
    const input = runInput(value, ctx, ['runId', 'activationPlanHash', 'activationApprovalRef', 'sealReference']);
    if (!hash(input.activationPlanHash) || !ref(input.activationApprovalRef) || !ref(input.sealReference)) throw fail('RECOVERY_INVALID');
    const budget = operationBudget(bounds), locator = byRun(input.runId, budget);
    return readScope(locator, ctx, budget, (data, held) => {
      const finish = () => {
        const evidence = activeEvidence(root, data, held, budget, input);
        const completionPath = join(runPath(input.runId), 'activation-complete.json');
        // All owned candidate readers are closed. Every exact retry, including
        // after restart, syncs candidate file+directory before exact completion
        // resync/publication under these same controls. Visibility is insufficient.
        // This hash is not adopted as a baseline or compared to the old seal.
        closedHash(data, budget, true);
        putRecord(completionPath, 'activationCompletion', evidence.completion, budget);
        return Object.freeze({ runId: input.runId, candidateReference: data.plan.candidateReference,
          newEpoch: data.plan.newEpoch, status: 'active', writeMode: 'paused', activationRef: evidence.completion.activationRef });
      };
      // Completed recognition precedes obsolete TTL, mutation approval and any
      // candidate fsync. It creates no guard/anchor; status and B completed reads
      // can never enter this durability-reestablishment branch.
      if (data.actual.run?.status === 'active') return finish();
      if (!data.plan || data.actual.run?.status !== 'verified' || held?.release) invalid();
      const beforeHash = closedHash(data, budget);
      const { activationPlan } = readActivation(root, data, input.activationPlanHash, input.sealReference, budget, beforeHash);
      const authorize = () => {
        reauthorize(locator, ctx);
        adapter(approvalAuthority, 'authorizeApproval', [Object.freeze({ kind: 'activate', planHash: input.activationPlanHash,
          approvalRef: input.activationApprovalRef }), ctx], 'RECOVERY_APPROVAL_DENIED');
        authReview(data, activationPlan.sealHash, activationPlan.authReviewRef, ctx);
      };
      authorize();
      if (closedHash(data, budget) !== beforeHash || !same(data.candidateIdentity, protectedPath(candidatePath(data)))) invalid();
      let failed = false, failure;
      try {
        transitionDatabase({ path: candidatePath(data), data, budget, clock: now, authorize, activationPlan,
          activationPlanHash: input.activationPlanHash, activationApprovalRef: input.activationApprovalRef });
      } catch (error) { failed = true; failure = error; }
      // Native commit/close results can be uncertain. Actual active evidence wins;
      // never compensate, erase a clock floor, or manufacture a failed run.
      data = validated(locator, budget);
      if (data.actual.run?.status === 'active') return finish();
      if (failed) {
        if (data.actual.run?.status === 'verified' && closedHash(data, budget) !== beforeHash)
          throw fail('RECOVERY_REVERIFY_REQUIRED');
        throw failure;
      }
      invalid();
    }, true);
  }); }
  function getRecoveryStatus(value, ctx) { return boundary(() => {
    const input = runInput(value, ctx), budget = operationBudget(bounds), locator = byRun(input.runId, budget);
    const partial = action => recordCopy('status', { runId: input.runId, candidateReference: locator.stage.candidateReference,
      state: 'indeterminate', stageHash: locator.stageHash, preparePlanHash: null, newEpoch: null, holdId: null, writeMode: null, nextAction: action });
    // Authenticate the complete locator/source proof before classifying partials.
    const receipt = holdReceipt(locator, budget);
    sources.withSource(locator.stage, ctx, budget, receipt ? 'held' : 'read', { sourceEvidence: locator.stage.sourceEvidence, receipt }, proof => {
      bindingCheck(locator, proof, ctx);
    });
      try {
        if (!exists(join(runPath(input.runId), 'stage.json'))) return partial('RETRY_STAGE');
        return readScope(locator, ctx, budget, (data, held) => {
          const state = data.plan ? completed(data.plan, data.planHash, data.actual) ?? 'staged' : 'staged';
          if (state !== 'staged' && held !== null && held.binding?.preparePlanHash !== data.planHash) invalid();
          const actions = { prepared: 'P5C_VERIFY_REQUIRED', verified: 'P5C_SEAL_ACTIVATION_REQUIRED', active: 'NONE', failed: 'MANUAL_RECONCILIATION' };
          const nextAction = state === 'staged' ? !data.plan ? 'PREVIEW_PREPARE' : now() >= data.plan.expiresAt ? 'PLAN_EXPIRED' : 'APPROVE_PREPARE' : actions[state];
          return recordCopy('status', { runId: input.runId, candidateReference: locator.stage.candidateReference, state,
            stageHash: locator.stageHash, preparePlanHash: data.planHash, newEpoch: data.plan?.newEpoch ?? null,
            holdId: held?.hold.holdId ?? null, writeMode: data.actual.writeMode, nextAction });
        });
      } catch (error) {
        if (['RECOVERY_INDETERMINATE', 'RECOVERY_EVIDENCE_MISMATCH', 'RECOVERY_RETRY_STAGE'].includes(error?.code))
          return partial(error.code === 'RECOVERY_RETRY_STAGE' ? 'RETRY_STAGE' : 'MANUAL_RECONCILIATION');
        throw error;
      }
  }); }
  return Object.freeze({ stageCandidate, previewRecovery, prepareRecovery, getRecoveryStatus,
    verifyRecovery, previewActivation, activateRecovery });
}
