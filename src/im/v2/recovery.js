import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { types as utilTypes } from 'node:util';
import { decodeRecoveryConversionRecord, encodeRecoveryConversionRecord, hashRecoveryConversionRecord } from './recovery-conversion-records.js';
import { validationLimits } from './backup.js';
import { createRecoveryHoldReleaser } from './backup-registry.js';
import { adapter, closureBinding, closureProof, recordCopy, sourceTable } from './recovery-source.js';
export { createClosedV3Source } from './recovery-source.js';
import { assertStaged, candidateFacts, completed, database, directory, lock, pauseConversionCandidate, prepareDatabase, putRecord, readRecord, stageDatabase, standalone, transitionDatabase } from './recovery-candidate.js';
import { activeEvidence, readActivation, readSeal, releaseEvidence, sealEvidence, sealReference } from './recovery-terminal.js';
import { assertRecoveryActivationPlanFresh, assertRecoveryPlanFresh, hashRecoveryRecord, hashRecoveryRequestInput, hashRecoveryRequestRef,
  validateRecoverySealBindings, validateRecoveryActivationPlanBindings,
  validateRecoveryLocator, validateRecoveryNormalizationBindings, validateRecoveryPauseBindings, validateRecoveryPlanBindings } from './recovery-plan.js';
import { canonical, decode, directoryEntries, exists, fail, hash, invalid, operationBudget,
  deepFreeze, fileHash, privateDirectory, protectedPath, publishBytes, readBytes, ref, resyncPublished, same, sha, shape, time, uuid } from './recovery-records.js';

const recoveryFacades = new WeakMap(), conversionTargets = new WeakMap(), conversionSessions = new WeakMap();
const activeConversionScopes = new Set();
const conversionNow = Date.now;
function conversionMisuse() {
  for (const frame of activeConversionScopes) frame.fault ??= fail('RECOVERY_INVALID');
  throw fail('RECOVERY_INVALID');
}
function conversionInput(value, keys) {
  if (utilTypes.isProxy(value)) conversionMisuse();
  try { shape(value, keys); } catch { conversionMisuse(); }
  return Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]])));
}
function conversionFailure(error) {
  // Never consult an accessor, prototype or proxy on a foreign thrown value.
  if (error && typeof error === 'object' && !utilTypes.isProxy(error)) {
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (typeof code === 'string' && /^RECOVERY_[A-Z_]+$/.test(code)) return fail(code);
    if (code === 'IM_V2_BUDGET_EXCEEDED') return fail('RECOVERY_BUSY');
  }
  return fail('RECOVERY_EVIDENCE_MISMATCH');
}
export function createRecoveryConversionTarget(recoveryServices, value, ctx) {
  const genuine = recoveryFacades.get(recoveryServices);
  if (!genuine || arguments.length !== 3 || activeConversionScopes.size) conversionMisuse();
  const input = conversionInput(value, ['runId']);
  if (!uuid(input.runId)) conversionMisuse();
  // Mint owns the same exclusion/poison span as an entered scope, including
  // source postchecks, unlocks and the final authorization callback. No target
  // is registered until that entire span has completed without a latched fault.
  const frame = { fault: null };
  activeConversionScopes.add(frame);
  try { return genuine.mint(input.runId, ctx, frame); }
  catch (error) {
    if (frame.fault) throw frame.fault;
    frame.fault = fail('RECOVERY_EVIDENCE_MISMATCH');
    frame.fault = conversionFailure(error); throw frame.fault;
  } finally { activeConversionScopes.delete(frame); }
}
export function withRecoveryConversionScope(target, ctx, consume) {
  const owned = conversionTargets.get(target);
  if (!owned || arguments.length !== 3 || owned.revoked || owned.active || activeConversionScopes.size || typeof consume !== 'function' ||
      utilTypes.isProxy(consume) || utilTypes.isAsyncFunction(consume) || utilTypes.isGeneratorFunction(consume)) conversionMisuse();
  return owned.enter(ctx, consume);
}

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
  const sources = sourceTable(sourceCatalog, evidenceAuthority, now, (registry, sourceRefs) => {
    // A sanitizes callback failures. Preserve our own fixed local failure across
    // that boundary, without accepting errors or verifiers from operation inputs.
    // Frames are synchronous and invocation-local, including reentrant denial.
    let frame;
    const releaser = createRecoveryHoldReleaser({ registry, authority, approvalAuthority,
      verifyTerminal(held, operation, ctx, publish) {
        try { return verifyTerminal(held, operation, ctx, publish, sourceRefs, completion => { frame.completion = completion; }); }
        catch (error) { frame.failure = error; throw error; }
      } });
    return (operation, ctx) => {
      const previous = frame, current = {}; frame = current;
      try {
        const result = releaser.release(operation, ctx);
        if (!current.completion || result.releaseMarker.releasedAt < current.completion.activatedAt ||
            result.releaseMarker.stateEvidenceHash !== hashRecoveryRecord('activationCompletion', current.completion)) invalid();
        return result;
      }
      catch (error) { throw current.failure ?? error; }
      finally { frame = previous; }
    };
  });
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
  function records(locator, budget, retainedStage = null) {
    const dir = runPath(locator.runId), stage = readRecord(join(dir, 'stage.json'), 'stage', budget) ?? retainedStage;
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
  function validated(locator, budget, data = records(locator, budget)) {
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
    // Only A's held scope/binding has authority. In particular STAGED is
    // not permission to fabricate a replacement plan after binding response loss.
    if (held?.binding && (!data.plan || held.binding.preparePlanHash !== data.planHash)) invalid();
    if (data.actual.run && held !== null && held.binding?.preparePlanHash !== data.planHash) invalid();
    return data;
  }
  const conversionFiles = Object.freeze({ owner: 'conversion-owner.json', pauseIntent: 'conversion-pause-intent.json', paused: 'conversion-paused.json' });
  function conversionRecords(locator, budget) {
    const result = {};
    for (const [kind, name] of Object.entries(conversionFiles)) {
      const path = join(runPath(locator.runId), name);
      let record = null;
      if (exists(path)) {
        const bytes = readBytes(path, budget);
        try { record = decodeRecoveryConversionRecord(kind, bytes); } catch { invalid(); }
      }
      result[kind] = record === null ? null : { record, recordHash: hashRecoveryConversionRecord(kind, record) };
    }
    if ((!result.owner && (result.pauseIntent || result.paused)) || (!result.pauseIntent && result.paused)) invalid();
    return result;
  }
  function conversionInventory(locator, budget, missingStage = false) {
    const stage = locator.stage, required = new Set(['coordination.sqlite', 'candidate.sqlite', 'stage.json', 'staged.json']);
    if (stage.sourceEvidence) for (const name of ['source-closed.json', 'source-verified.sqlite', 'copy-intent.json', 'base.json', 'normalization-intent.json', 'normalized.json']) required.add(name);
    if (stage.sourceEvidence?.kind === 'registered-backup') required.add('hold.json');
    if (stage.candidateKind === 'v3_import') for (const name of ['pause-intent.json', 'paused.json']) required.add(name);
    const allowed = new Set([...required, ...Object.values(conversionFiles)]);
    if (missingStage) required.delete('stage.json');
    directoryEntries(runPath(locator.runId), budget, name => {
      if (!allowed.has(name)) throw fail(name.endsWith('.pending') ? 'RECOVERY_INDETERMINATE' : 'RECOVERY_EVIDENCE_MISMATCH');
      protectedPath(join(runPath(locator.runId), name)); required.delete(name);
    });
    if (required.size) invalid();
  }
  function conversionWorkspaceInventory(budget) {
    const ids = new Set();
    directoryEntries(requests, budget, name => {
      if (name === 'coordination.sqlite') { protectedPath(join(requests, name)); return; }
      if (!/^[0-9a-f]{64}\.json$/.test(name)) throw fail('RECOVERY_INDETERMINATE');
      const item = readRecord(join(requests, name), 'requestLocator', budget);
      if (name !== `${hashRecoveryRequestRef(item.requestRef)}.json` || ids.has(item.runId)) invalid();
      ids.add(item.runId);
    });
    directoryEntries(runs, budget, name => {
      if (!uuid(name) || !ids.has(name)) throw fail('RECOVERY_INDETERMINATE');
      privateDirectory(runPath(name));
    });
  }
  function conversionBinding(data, held) {
    const { stage, staged, actual } = data;
    return { version: 1, runId: stage.runId, stageHash: hashRecoveryRecord('stage', stage),
      stagedHash: hashRecoveryRecord('staged', staged), candidateReference: stage.candidateReference,
      instanceId: actual.identity.instance_id, instanceCreatedAt: actual.identity.created_at,
      centerEpoch: actual.center.center_epoch, candidateKind: stage.candidateKind, preparationRef: stage.preparationRef,
      sourceEvidenceHash: stage.sourceEvidence === null ? null : hashRecoveryRecord(
        stage.sourceEvidence.kind === 'registered-backup' ? 'registeredSourceEvidence' : 'closedSourceEvidence', stage.sourceEvidence),
      holdId: held?.hold.holdId ?? null };
  }
  function conversionValidated(locator, held, budget) {
    conversionInventory(locator, budget);
    const chain = conversionRecords(locator, budget), owner = chain.owner?.record;
    const data = owner ? records(locator, budget) : validated(locator, budget);
    const path = join(runPath(locator.runId), 'candidate.sqlite');
    if (data.stage.sourceEvidence && fileHash(join(runPath(locator.runId), 'source-verified.sqlite'), budget) !==
        (data.stage.sourceEvidence.fileHash ?? data.stage.sourceEvidence.closedSourceFileHash)) invalid();
    if (owner) data.actual = candidateFacts(path, data.stage, budget);
    assertStaged(data.stage, data.staged, data.actual, data.base);
    if (data.plan || data.actual.run || held?.binding || held?.release) invalid();
    if (data.stage.candidateKind !== 'snapshot_recovery' &&
        (data.actual.center.center_epoch !== data.staged.initialEpoch || data.actual.center.recovery_run_id !== null ||
         data.actual.center.status !== 'prepared' || data.actual.writeMode !== 'paused')) invalid();
    const binding = conversionBinding(data, held);
    const currentFileHash = closedHash(data, budget), currentWriteMode = data.actual.writeMode;
    let phase = 'UNCLAIMED';
    if (owner) {
      if (Object.keys(binding).some(key => binding[key] !== owner[key]) ||
          owner.claimedAt < Math.max(data.staged.stagedAt, binding.instanceCreatedAt,
            data.stage.sourceEvidence?.completedAt ?? data.stage.sourceEvidence?.observedAt ?? 0, held?.hold.createdAt ?? 0)) invalid();
      if (data.stage.candidateKind !== 'snapshot_recovery' && owner.intakeWriteMode !== 'paused') invalid();
      phase = 'CLAIMED';
      const intent = chain.pauseIntent?.record, paused = chain.paused?.record;
      if (intent) {
        if (intent.ownerHash !== chain.owner.recordHash || intent.inputFileHash !== owner.intakeFileHash ||
            intent.originalWriteMode !== owner.intakeWriteMode || intent.targetWriteMode !== 'paused' || intent.createdAt < owner.claimedAt) invalid();
        phase = 'PAUSE_INTENT';
      }
      if (paused) {
        if (paused.ownerHash !== chain.owner.recordHash || paused.pauseIntentHash !== chain.pauseIntent.recordHash ||
            paused.inputFileHash !== owner.intakeFileHash || paused.pausedAt < intent.createdAt ||
            paused.changed !== (owner.intakeWriteMode === 'enabled') ||
            (!paused.changed && paused.pausedFileHash !== owner.intakeFileHash) ||
            (paused.changed && paused.pausedFileHash === owner.intakeFileHash)) invalid();
        phase = 'PAUSED';
      }
      if (currentFileHash !== (paused?.pausedFileHash ?? owner.intakeFileHash) ||
          currentWriteMode !== (paused ? 'paused' : owner.intakeWriteMode)) throw fail('RECOVERY_INDETERMINATE');
    }
    // Account for the actual complete metadata inventory, including objects the
    // historical schema checker deliberately filters out of its manifest query.
    const clockFloor = database(path, budget, false, db => {
      for (const row of db.prepare('SELECT name FROM sqlite_schema LIMIT ?').iterate(budget.limits.maxMetadataEntries + 1)) {
        budget.entry(); if (typeof row.name !== 'string') invalid();
      }
      budget.tick();
      return db.prepare('SELECT last_observed_at FROM im_clock WHERE singleton=1').get().last_observed_at;
    });
    if (owner && owner.claimedAt < clockFloor) invalid();
    return { data, chain, binding, phase, currentFileHash, currentWriteMode, clockFloor };
  }
  function conversionGuard(locator, held, budget) {
    let found = false;
    directoryEntries(runPath(locator.runId), budget, name => {
      if (Object.values(conversionFiles).includes(name)) found = true;
      else if (name.startsWith('conversion-')) invalid();
      else if (name.endsWith('.pending')) throw fail('RECOVERY_INDETERMINATE');
    });
    if (!found) return;
    const current = conversionValidated(locator, held, budget);
    if (!current.chain.owner) invalid();
    throw fail('RECOVERY_CONVERSION_PENDING');
  }
  function conversionControl(runId, ctx, budget, consume) {
    admin(ctx); budget.tick();
    const locator = byRun(runId, budget), receipt = holdReceipt(locator, budget);
    const registered = locator.stage.sourceEvidence?.kind === 'registered-backup';
    if (registered ? !receipt : receipt !== null) invalid();
    return sources.withSource(locator.stage, ctx, budget, registered ? 'held' : 'read',
      { sourceEvidence: locator.stage.sourceEvidence, receipt }, proof => {
        bindingCheck(locator, proof, ctx);
        return workspace(false, () => {
          conversionWorkspaceInventory(budget);
          const current = byRun(runId, budget);
          if (JSON.stringify(current) !== JSON.stringify(locator)) invalid();
          return lock(runPath(runId), false, () => {
            if (JSON.stringify(holdReceipt(current, budget)) !== JSON.stringify(receipt)) invalid();
            const held = registered ? proof : null;
            return consume(current, held);
          });
        });
      });
  }
  function mintConversion(runId, ctx, frame) {
    const budget = operationBudget(bounds); budget.tick();
    let binding, candidateIdentity;
    conversionControl(runId, ctx, budget, (locator, held) => {
      binding = conversionValidated(locator, held, budget).binding;
      candidateIdentity = standalone(join(runPath(runId), 'candidate.sqlite'), budget);
      admin(ctx); budget.tick();
    });
    if (frame.fault) throw frame.fault;
    admin(ctx); budget.tick();
    if (frame.fault) throw frame.fault;
    const owned = { revoked: false, active: null, binding, enter };
    const target = Object.freeze({ invalidate(...args) {
      if (this !== target || args.length !== 0) {
        if (owned.active) owned.active.fault ??= fail('RECOVERY_INVALID');
        conversionMisuse();
      }
      owned.revoked = true;
      if (owned.active) owned.active.fault ??= fail('RECOVERY_INVALID');
    } });
    conversionTargets.set(target, owned);
    function enter(context, consume) {
      const frame = { live: false, busy: false, fault: null, claimed: false, issued: new WeakSet() };
      const budget = operationBudget(bounds); budget.tick();
      owned.active = frame; activeConversionScopes.add(frame);
      const poison = error => {
        if (frame.fault) return frame.fault;
        frame.fault = fail('RECOVERY_EVIDENCE_MISMATCH');
        frame.fault = conversionFailure(error); return frame.fault;
      };
      const check = () => {
        if (owned.revoked || frame.fault) throw frame.fault ?? fail('RECOVERY_INVALID');
        budget.tick();
      };
      let session, result;
      try {
        result = conversionControl(runId, context, budget, (locator, held) => {
          const identity = standalone(join(runPath(runId), 'candidate.sqlite'), budget);
          if (!same(identity, candidateIdentity)) invalid();
          const current = () => {
            check(); reauthorize(locator, context); check();
            const facts = conversionValidated(locator, held, budget);
            if (Object.keys(binding).some(key => facts.binding[key] !== binding[key]) ||
                !same(identity, protectedPath(join(runPath(runId), 'candidate.sqlite')))) invalid();
            return facts;
          };
          current();
          const write = (kind, record) => {
            check(); reauthorize(locator, context); check();
            const bytes = Buffer.from(encodeRecoveryConversionRecord(kind, record));
            publishBytes(join(runPath(runId), conversionFiles[kind]), bytes, budget);
            check();
          };
          const timestamp = floor => { const value = conversionNow(); if (!time(value) || value < floor) invalid(); return value; };
          const invoke = (receiver, args, operation) => {
            if (receiver !== session || conversionSessions.get(receiver) !== frame || !frame.live || frame.busy || args.length !== 1) {
              frame.fault ??= fail('RECOVERY_INVALID'); conversionMisuse();
            }
            try {
              conversionInput(args[0], []); check(); frame.busy = true;
              const value = deepFreeze(operation(current())); check();
              frame.issued.add(value); return value;
            } catch (error) { throw poison(error); }
            finally { frame.busy = false; }
          };
          session = Object.freeze({
            inspectIntake(...args) { return invoke(this, args, value => {
              const { binding: b, chain, phase, currentFileHash, currentWriteMode } = value;
              return { ...b, executionPolicyHash: locator.stage.policyHash, phase,
                intakeFileHash: chain.owner?.record.intakeFileHash ?? currentFileHash,
                intakeWriteMode: chain.owner?.record.intakeWriteMode ?? currentWriteMode,
                currentFileHash, currentWriteMode, ownerHash: chain.owner?.recordHash ?? null,
                pauseIntentHash: chain.pauseIntent?.recordHash ?? null, pausedHash: chain.paused?.recordHash ?? null };
            }); },
            readConversionRecords(...args) { return invoke(this, args, value => ({ version: 1, ...value.chain })); },
            claimConversion(...args) { return invoke(this, args, value => {
              const replayed = value.chain.owner !== null;
              const record = value.chain.owner?.record ?? { ...value.binding,
                intakeFileHash: value.currentFileHash, intakeWriteMode: value.currentWriteMode,
                claimedAt: timestamp(Math.max(value.clockFloor, value.data.staged.stagedAt, value.binding.instanceCreatedAt,
                  locator.stage.sourceEvidence?.completedAt ?? locator.stage.sourceEvidence?.observedAt ?? 0, held?.hold.createdAt ?? 0)) };
              write('owner', record);
              const verified = current(); frame.claimed = true;
              return { version: 1, owner: verified.chain.owner, replayed };
            }); },
            ensurePaused(...args) { return invoke(this, args, value => {
              if (!frame.claimed) throw fail('RECOVERY_INVALID');
              const owner = value.chain.owner.record, replayed = value.chain.paused !== null;
              write('owner', owner);
              const intent = value.chain.pauseIntent?.record ?? { version: 1, ownerHash: value.chain.owner.recordHash,
                inputFileHash: owner.intakeFileHash, originalWriteMode: owner.intakeWriteMode,
                targetWriteMode: 'paused', createdAt: timestamp(owner.claimedAt) };
              write('pauseIntent', intent); current();
              if (!replayed && owner.intakeWriteMode === 'enabled') {
                pauseConversionCandidate({ path: join(runPath(runId), 'candidate.sqlite'), ...value.data, owner, budget,
                  authorize: () => { check(); reauthorize(locator, context); check(); } });
              }
              check(); reauthorize(locator, context); check();
              const pausedFileHash = closedHash(value.data, budget, true);
              const actual = candidateFacts(join(runPath(runId), 'candidate.sqlite'), locator.stage, budget);
              assertStaged(locator.stage, value.data.staged, actual, value.data.base);
              if (actual.writeMode !== 'paused' || actual.run || actual.center.center_epoch !== owner.centerEpoch ||
                  (owner.intakeWriteMode === 'paused' && pausedFileHash !== owner.intakeFileHash)) invalid();
              const paused = value.chain.paused?.record ?? { version: 1, ownerHash: value.chain.owner.recordHash,
                pauseIntentHash: hashRecoveryConversionRecord('pauseIntent', intent), inputFileHash: owner.intakeFileHash,
                pausedFileHash, changed: owner.intakeWriteMode === 'enabled', pausedAt: timestamp(intent.createdAt) };
              if (paused.pausedFileHash !== pausedFileHash) invalid();
              write('paused', paused);
              return { version: 1, ...current().chain, replayed };
            }); }
          });
          conversionSessions.set(session, frame); frame.live = true;
          try {
            let selected;
            try { selected = consume(session); }
            catch { throw poison(fail('RECOVERY_CALLBACK_FAILED')); }
            if (!frame.issued.has(selected)) {
              poison(fail('RECOVERY_INVALID'));
              // Observe native promises and unexpected thenables, but never pass
              // a proxy to reflection. No consumer result is returned directly.
              if (selected && (typeof selected === 'object' || typeof selected === 'function') && !utilTypes.isProxy(selected)) {
                try { if (typeof selected.then === 'function') void Promise.resolve(selected).catch(() => {}); } catch { /* fixed refusal */ }
              }
              throw poison(fail('RECOVERY_INVALID'));
            }
            check(); return selected;
          } finally {
            frame.live = false;
            // Authority/source callbacks here see an expired session and poison
            // the still-active outer frame if they attempt escaped operations.
            check(); reauthorize(locator, context); current(); check();
          }
        });
        check(); admin(context); check(); return result;
      } catch (error) { throw poison(error); }
      finally { frame.live = false; owned.active = null; activeConversionScopes.delete(frame); }
    }
    return target;
  }
  function readScope(locator, ctx, budget, consume, allowCompletionRepair = false, classify = error => { throw error; }, retryStage = false) {
    const receipt = holdReceipt(locator, budget);
    const registered = locator.stage.sourceEvidence?.kind === 'registered-backup';
    if (registered ? !receipt : receipt !== null) throw fail('RECOVERY_INDETERMINATE');
    return sources.withSource(locator.stage, ctx, budget, registered ? 'held' : 'read', { sourceEvidence: locator.stage.sourceEvidence, receipt }, proof => {
      const held = registered ? proof : null;
      bindingCheck(locator, proof, ctx);
      try { return candidateScope(locator, receipt, held, budget, consume, allowCompletionRepair, retryStage); }
      catch (error) { return classify(error); }
    });
  }
  function candidateScope(locator, receipt, held, budget, consume, allowCompletionRepair = false, retryStage = false) {
    return workspace(false, () => {
      const current = byRun(locator.runId, budget);
      if (JSON.stringify(current) !== JSON.stringify(locator)) invalid();
      // A durable locator can precede run-directory creation. lstat-based exists
      // distinguishes absence from a dangling link; existing paths still pass
      // through the candidate lock's strict directory checks and owner guard.
      privateDirectory(runs);
      if (!exists(runPath(locator.runId))) throw fail('RECOVERY_RETRY_STAGE');
      return lock(runPath(locator.runId), false, () => {
        if (JSON.stringify(holdReceipt(current, budget)) !== JSON.stringify(receipt)) invalid();
        conversionGuard(current, held, budget);
        const missingStage = !exists(join(runPath(locator.runId), 'stage.json'));
        if (missingStage && !retryStage) throw fail('RECOVERY_RETRY_STAGE');
        if (!exists(join(runPath(locator.runId), 'candidate.sqlite'))) throw fail('RECOVERY_INDETERMINATE');
        const identity = protectedPath(join(runPath(locator.runId), 'candidate.sqlite'));
        // Only the completed stage retry can inspect a missing stage using the
        // authenticated locator. Guard first: claimed, orphan or pending evidence
        // never reaches this fallback, and inspection itself publishes nothing.
        if (missingStage) conversionInventory(current, budget, true);
        const data = observedBinding(validated(current, budget,
          records(current, budget, missingStage ? current.stage : null)), held);
        if (missingStage && (data.plan || data.actual.run || held?.binding || held?.release)) invalid();
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
  }
  function stageCandidate(value, ctx) { return boundary(() => {
    const input = inputCopy(value, ['requestRef', 'candidateKind', 'sourceRef', 'isolationAckRef']); admin(ctx);
    if (!ref(input.requestRef)) throw fail('RECOVERY_INVALID');
    const requestHash = hashRecoveryRequestInput({ candidateKind: input.candidateKind, sourceRef: input.sourceRef, isolationAckRef: input.isolationAckRef, policyHash });
    const budget = operationBudget(bounds); budget.tick();
    // A prior closed-source observation must survive facade/clock replacement.
    const previous = exists(requests) ? readRecord(locatorPath(input.requestRef), 'requestLocator', budget) : null;
    if (previous && (previous.requestRef !== input.requestRef || previous.requestHash !== requestHash)) throw fail('RECOVERY_INVALID');
    if (previous && exists(join(runPath(previous.runId), 'staged.json'))) {
      // Completed retries acquire genuine held source before workspace/candidate.
      // The owner guard precedes every historical evidence resync/publication.
      return readScope(previous, ctx, budget, (data, held) => {
        persistEvidence(previous, data, held, budget);
        const staged = stageDatabase({ runRoot: runPath(previous.runId), stage: previous.stage,
          proof: held ?? {}, policy, budget, now });
        return recordCopy('stageResult', { runId: previous.runId, candidateReference: previous.stage.candidateReference,
          status: 'staged', stageHash: previous.stageHash, preparationRef: staged.preparationRef, instanceId: staged.instanceId,
          instanceCreatedAt: staged.instanceCreatedAt, initialEpoch: staged.initialEpoch, importEpoch: staged.importEpoch,
          holdId: held?.hold.holdId ?? null });
      }, true, undefined, true);
    }
    return sources.withSource(input, ctx, budget, 'stage', { sourceEvidence: previous?.stage.sourceEvidence }, proof => workspace(true, () => {
      let locator = readRecord(locatorPath(input.requestRef), 'requestLocator', budget);
      if (locator) {
        if (locator.requestRef !== input.requestRef || locator.requestHash !== requestHash) throw fail('RECOVERY_INVALID');
        bindingCheck(locator, proof, ctx);
        // A competing stage completed after our initial observation. Restart
        // through the held completed-retry route; never establish/resync here.
        if (exists(join(runPath(locator.runId), 'staged.json'))) throw fail('RECOVERY_BUSY');
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
      // A conversion owner requires completed staged evidence. Stray evidence on
      // an incomplete retry must refuse before any publication or hold creation.
      if (exists(runPath(locator.runId))) {
        const rejectStray = () => directoryEntries(runPath(locator.runId), budget, name => {
          if (name.startsWith('conversion-')) invalid();
          if (name.endsWith('.pending')) throw fail('RECOVERY_INDETERMINATE');
        });
        if (exists(join(runPath(locator.runId), 'coordination.sqlite'))) lock(runPath(locator.runId), false, rejectStray);
        else rejectStray();
      }
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
        conversionGuard(current, proof.hold ? proof : null, budget);
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
    const partial = action => recordCopy('statusV2', { version: 2, runId: input.runId, candidateReference: locator.stage.candidateReference,
      state: 'indeterminate', stageHash: locator.stageHash, preparePlanHash: null, newEpoch: null, holdId: null, writeMode: null,
      nextAction: action, releasePlan: null, releasePlanHash: null });
    return readScope(locator, ctx, budget, (data, held) => {
      const state = data.plan ? completed(data.plan, data.planHash, data.actual) ?? 'staged' : 'staged';
      if (state !== 'staged' && held !== null && held.binding?.preparePlanHash !== data.planHash) invalid();
      const actions = { prepared: 'P5C_VERIFY_REQUIRED', verified: 'P5C_SEAL_ACTIVATION_REQUIRED', active: 'NONE', failed: 'MANUAL_RECONCILIATION' };
      let nextAction = state === 'staged' ? !data.plan ? 'PREVIEW_PREPARE' : now() >= data.plan.expiresAt ? 'PLAN_EXPIRED' : 'APPROVE_PREPARE' : actions[state];
      let pair = { releasePlan: null, releasePlanHash: null };
      if (state === 'active') {
        const evidence = activeEvidence(root, data, held, budget);
        if (!evidence.stored) nextAction = 'RETRY_ACTIVATE';
        else if (held) {
          pair = releaseEvidence(data, held, evidence);
          nextAction = held.release ? 'NONE' : 'APPROVE_RELEASE_HOLD';
        }
      }
      return recordCopy('statusV2', { version: 2, runId: input.runId, candidateReference: locator.stage.candidateReference, state,
        stageHash: locator.stageHash, preparePlanHash: data.planHash, newEpoch: data.plan?.newEpoch ?? null,
        holdId: held?.hold.holdId ?? null, writeMode: data.actual.writeMode, nextAction, ...pair });
    }, true, error => {
      if (['RECOVERY_INDETERMINATE', 'RECOVERY_EVIDENCE_MISMATCH', 'RECOVERY_RETRY_STAGE'].includes(error?.code))
        return partial(error.code === 'RECOVERY_RETRY_STAGE' ? 'RETRY_STAGE' : 'MANUAL_RECONCILIATION');
      throw error;
    });
  }); }
  function verifyTerminal(held, operation, ctx, publish, sourceRefs, rememberCompletion) {
    const budget = operationBudget(bounds), locator = byRun(operation.runId, budget);
    if (!sourceRefs.includes(locator.stage.sourceRef) || locator.stage.sourceEvidence?.kind !== 'registered-backup' ||
        locator.stage.sourceEvidence.backupId !== operation.backupId || held.hold.holdId !== operation.holdId ||
        held.hold.recoveryRunId !== operation.runId || held.hold.stageHash !== locator.stageHash) invalid();
    const receipt = holdReceipt(locator, budget);
    if (JSON.stringify(receipt) !== JSON.stringify(held.hold)) invalid();
    bindingCheck(locator, { sourceEvidence: held.sourceEvidence, sourceBinding: closureBinding(locator.stage, held.sourceEvidence) }, ctx);
    reauthorize(locator, ctx);
    return candidateScope(locator, receipt, held, budget, data => {
      const evidence = activeEvidence(root, data, held, budget), pair = releaseEvidence(data, held, evidence);
      if (pair.releasePlanHash !== operation.releasePlanHash) invalid();
      if (held.release?.approvalRef !== undefined && held.release.approvalRef !== operation.approvalRef) invalid();
      reauthorize(locator, ctx);
      if (!same(data.candidateIdentity, protectedPath(candidatePath(data)))) invalid();
      const current = activeEvidence(root, observedBinding(validated(locator, budget), held), held, budget);
      if (!current.stored || releaseEvidence(data, held, current).releasePlanHash !== pair.releasePlanHash) invalid();
      // All candidate readers have closed. Reestablish durability on EVERY exact
      // attempt, including a new process observing an already-visible marker.
      closedHash(data, budget, true);
      const completionPath = join(runPath(operation.runId), 'activation-complete.json');
      resyncPublished(completionPath, budget);
      rememberCompletion(current.completion);
      // Return A's opaque identity, not a terminal object. Publication (and A's
      // final independent approval) occurs inside source/workspace/candidate.
      return publish({ stateEvidenceHash: pair.releasePlan.activationCompletionHash,
        minimumReleasedAt: current.completion.activatedAt });
    });
  }
  function releaseRecoveryHold(value, ctx) { return boundary(() => {
    const input = runInput(value, ctx, ['runId', 'holdId', 'releasePlanHash', 'approvalRef']);
    if (!uuid(input.holdId)) throw fail('RECOVERY_INVALID');
    const budget = operationBudget(bounds), locator = byRun(input.runId, budget);
    readScope(locator, ctx, budget, () => undefined, true);
    sources.release(locator.stage, input, ctx);
    return Object.freeze({ runId: input.runId, holdId: input.holdId, state: 'released', releasePlanHash: input.releasePlanHash });
  }); }
  const facade = Object.freeze({ stageCandidate, previewRecovery, prepareRecovery, getRecoveryStatus,
    verifyRecovery, previewActivation, activateRecovery, releaseRecoveryHold });
  recoveryFacades.set(facade, Object.freeze({ mint: mintConversion }));
  return facade;
}
