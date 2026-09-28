// Test-owned field tables transcribed from C2-A §§2/4/5/6, baseline e161f37.
// Pure consistency only. This helper imports no product codec and mints no authority.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const V3 = '523f5b8448226076dc78f32096888871d899150d4cb70d6728490aee033f9814';
export const V4 = 'c950eb40692a72f918c8976d4bef8cab0b9e357495b01df75e0ab2d1b0b5f216';
export const V5 = '80eba5e6ce61261d31ec495216c3b6eb8c7a8f0c87edcbb1440372353f495435';
export const FIELDS = {
  archiveIntent: 'version runId legacyStageHash legacyStagedHash candidateReference candidateKind preparationRef sourceSchemaVersion sourceSchemaChecksum sourceEvidenceHash instanceId instanceCreatedAt centerEpoch executionPolicyHash holdId ownerHash pauseIntentHash pausedHash conversionPlanHash conversionProofHash conversionCompletionHash conversionPosthash archiveReference createdAt',
  conversionHandoff: 'version runId archiveIntentHash legacyStageHash legacyStagedHash candidateReference instanceId instanceCreatedAt centerEpoch sourceSchemaVersion sourceSchemaChecksum targetSchemaVersion targetSchemaChecksum ownerHash pauseIntentHash pausedHash conversionPlanHash conversionProofHash conversionCompletionHash conversionPosthash archiveReference archiveFileHash liveInitialHash handedOffAt',
  nativeIntake: 'version route runId candidateReference sourceRef sourceEvidence sourceEvidenceHash instanceId instanceCreatedAt sourceSchemaVersion sourceSchemaChecksum targetSchemaVersion targetSchemaChecksum candidateInitialHash initialEpoch previousRecoveryCounter executionPolicyHash holdId acceptedAt',
  convertedIntake: 'version route runId candidateReference handoffHash archiveIntentHash candidateKind preparationRef sourceSchemaVersion sourceSchemaChecksum sourceEvidenceHash instanceId instanceCreatedAt targetSchemaVersion targetSchemaChecksum candidateInitialHash initialEpoch previousRecoveryCounter executionPolicyHash holdId acceptedAt',
  source: 'version kind sourceRef registryFormat instanceId instanceCreatedAt backupId fileHash manifestHash schemaVersion schemaChecksum completedAt importedRecordHash',
  registeredSourceEvidence: 'version kind sourceRef registryFormat instanceId instanceCreatedAt backupId fileHash manifestHash schemaVersion schemaChecksum completedAt importedRecordHash',
  closedSourceEvidence: 'version kind sourceRef instanceId instanceCreatedAt schemaVersion schemaChecksum closedSourceFileHash observedAt isolationAckRef',
  stage: 'version requestRef requestHash runId candidateKind sourceRef sourceEvidence sourceClosedEvidenceRef sourceClosedEvidenceHash isolationAckRef policyHash candidateReference preparationRef createdAt',
  staged: 'version runId stageHash candidateBaseHash preparationRef instanceId instanceCreatedAt initialEpoch importEpoch stagedAt',
  owner: 'version runId stageHash stagedHash candidateReference instanceId instanceCreatedAt centerEpoch candidateKind preparationRef sourceEvidenceHash holdId intakeFileHash intakeWriteMode claimedAt',
  pauseIntent: 'version ownerHash inputFileHash originalWriteMode targetWriteMode createdAt',
  paused: 'version ownerHash pauseIntentHash inputFileHash pausedFileHash changed pausedAt',
  conversionPlan: 'version transitionId instanceId instanceCreatedAt centerEpoch recoveryRunId stageHash candidateReference candidateKind preparationRef sourceEvidenceHash fromVersion fromChecksum toVersion toChecksum preconversionFileHash executionPolicyHash createdAt expiresAt',
  conversionProof: 'version plan planHash approvalRef executorId approverId convertedAt',
  conversionComplete: 'version transitionId planHash conversionProofHash instanceId instanceCreatedAt centerEpoch recoveryRunId stageHash candidateReference schemaVersion schemaChecksum preconversionFileHash postconversionFileHash',
  hold: 'version holdId backupId recoveryRunId stageHash createdAt',
  archiveBundle: 'archiveIntent handoff legacyStage legacyStaged owner pauseIntent paused conversionPlan conversionProof conversionCompletion hold',
  intakeBundle: 'intake sourceEvidence archiveEvidence actual',
  actual: 'instanceId instanceCreatedAt schemaVersion schemaChecksum centerEpoch recoveryCounter fileHash writeMode',
};
for (const key of Object.keys(FIELDS)) FIELDS[key] = Object.freeze(FIELDS[key].split(' '));
Object.freeze(FIELDS);
export const NEW_KINDS = ['archiveIntent', 'conversionHandoff', 'nativeIntake', 'convertedIntake'];
export const clone = value => structuredClone(value);
export const sourceKind = source => source.version === 2 ? 'source' : source.kind === 'closed-source' ? 'closedSourceEvidence' : 'registeredSourceEvidence';
export function ordered(kind, value) {
  assert.deepEqual(Object.keys(value).sort(), [...FIELDS[kind]].sort(), `${kind} oracle field set`);
  return Object.fromEntries(FIELDS[kind].map(key => {
    let child = value[key];
    if (key === 'sourceEvidence' && child !== null) child = ordered(sourceKind(child), child);
    if (key === 'plan') child = ordered('conversionPlan', child);
    return [key, child];
  }));
}
export const text = (kind, value) => JSON.stringify(ordered(kind, value));
export const rawHash = value => createHash('sha256').update(value).digest('hex');
export function prefix(kind) {
  if (NEW_KINDS.includes(kind)) return `a2a-msg.im.v2/recovery-v5/${kind}\n`;
  const domains = {
    owner: 'im-recovery-conversion-owner-v1\0',
    pauseIntent: 'im-recovery-conversion-pause-intent-v1\0',
    paused: 'im-recovery-conversion-paused-v1\0',
    conversionPlan: 'im-center-schema-conversion-plan-v1\n',
    conversionProof: 'im-center-schema-conversion-proof-v1\n',
    conversionComplete: 'im-center-schema-conversion-complete-v1\n',
  };
  return domains[kind] ?? '';
}
export const digest = (kind, value) => rawHash(Buffer.from(prefix(kind) + text(kind, value), 'utf8'));
export const requestHash = s => rawHash(JSON.stringify([s.candidateKind, s.sourceRef, s.isolationAckRef, s.policyHash]));
export const ARCHIVE_KINDS = { archiveIntent: 'archiveIntent', handoff: 'conversionHandoff', legacyStage: 'stage', legacyStaged: 'staged', owner: 'owner', pauseIntent: 'pauseIntent', paused: 'paused', conversionPlan: 'conversionPlan', conversionProof: 'conversionProof', conversionCompletion: 'conversionComplete', hold: 'hold' };

export function fromVector(vector) {
  const read = key => vector.records[key] === null ? null : JSON.parse(vector.records[key].canonical);
  const intake = read('intake');
  const archiveEvidence = vector.name === 'native5' ? null : Object.fromEntries(Object.keys(ARCHIVE_KINDS).map(key => [key, read(key)]));
  return { intake, sourceEvidence: read('sourceEvidence'), archiveEvidence, actual: clone(vector.actual) };
}

// Repair ONLY digest edges after semantic mutations. No identity, time, route,
// file, policy or hold comparison is repaired. This prevents stale-hash negatives.
export function rehashArchive(b, { copyPlan = true } = {}) {
  const { archiveIntent: a, handoff: h, legacyStage: s, legacyStaged: t, owner: o,
    pauseIntent: i, paused: p, conversionPlan: l, conversionProof: f, conversionCompletion: c, hold: d } = b;
  s.requestHash = requestHash(s);
  const sh = digest('stage', s);
  for (const r of [t, o, l, c, ...(d ? [d] : [])]) r.stageHash = sh;
  a.legacyStageHash = h.legacyStageHash = sh;
  a.legacyStagedHash = digest('staged', t);
  h.legacyStagedHash = o.stagedHash = a.legacyStagedHash;
  a.sourceEvidenceHash = o.sourceEvidenceHash = l.sourceEvidenceHash = s.sourceEvidence === null ? null : digest(sourceKind(s.sourceEvidence), s.sourceEvidence);
  a.ownerHash = h.ownerHash = i.ownerHash = p.ownerHash = digest('owner', o);
  a.pauseIntentHash = h.pauseIntentHash = p.pauseIntentHash = digest('pauseIntent', i);
  a.pausedHash = h.pausedHash = digest('paused', p);
  if (copyPlan) f.plan = clone(l);
  f.planHash = digest('conversionPlan', f.plan);
  a.conversionPlanHash = h.conversionPlanHash = c.planHash = digest('conversionPlan', l);
  a.conversionProofHash = h.conversionProofHash = c.conversionProofHash = digest('conversionProof', f);
  a.conversionCompletionHash = h.conversionCompletionHash = digest('conversionComplete', c);
  h.archiveIntentHash = digest('archiveIntent', a);
  return b;
}

export function assertHashGraph(b) {
  const { archiveIntent: a, handoff: h, legacyStage: s, legacyStaged: t, owner: o,
    pauseIntent: i, paused: p, conversionPlan: l, conversionProof: f, conversionCompletion: c, hold: d } = b;
  const eq = (expected, ...values) => values.forEach(value => assert.equal(value, expected));
  eq(requestHash(s), s.requestHash);
  eq(digest('stage', s), a.legacyStageHash, h.legacyStageHash, t.stageHash, o.stageHash, l.stageHash, c.stageHash, ...(d ? [d.stageHash] : []));
  eq(digest('staged', t), a.legacyStagedHash, h.legacyStagedHash, o.stagedHash);
  eq(s.sourceEvidence === null ? null : digest(sourceKind(s.sourceEvidence), s.sourceEvidence), a.sourceEvidenceHash, o.sourceEvidenceHash, l.sourceEvidenceHash);
  eq(digest('owner', o), a.ownerHash, h.ownerHash, i.ownerHash, p.ownerHash);
  eq(digest('pauseIntent', i), a.pauseIntentHash, h.pauseIntentHash, p.pauseIntentHash);
  eq(digest('paused', p), a.pausedHash, h.pausedHash);
  eq(digest('conversionPlan', l), a.conversionPlanHash, h.conversionPlanHash, c.planHash);
  eq(digest('conversionPlan', f.plan), f.planHash);
  eq(digest('conversionProof', f), a.conversionProofHash, h.conversionProofHash, c.conversionProofHash);
  eq(digest('conversionComplete', c), a.conversionCompletionHash, h.conversionCompletionHash);
  eq(digest('archiveIntent', a), h.archiveIntentHash);
}

export function assertArchiveGraph(b) {
  assertHashGraph(b);
  assert.deepEqual(Object.keys(b), FIELDS.archiveBundle);
  const { archiveIntent: a, handoff: h, legacyStage: s, legacyStaged: t, owner: o,
    pauseIntent: i, paused: p, conversionPlan: l, conversionProof: f, conversionCompletion: c, hold: d } = b;
  const e = s.sourceEvidence;
  const eq = (...values) => values.slice(1).forEach(value => assert.equal(value, values[0]));
  eq(a.runId, h.runId, s.runId, t.runId, o.runId, l.recoveryRunId, c.recoveryRunId);
  eq(`runs/${a.runId}/candidate.sqlite`, a.candidateReference, h.candidateReference, s.candidateReference, o.candidateReference, l.candidateReference, c.candidateReference);
  for (const key of ['instanceId', 'instanceCreatedAt']) eq(a[key], h[key], t[key], o[key], l[key], c[key], ...(e ? [e[key]] : []));
  eq(a.centerEpoch, h.centerEpoch, o.centerEpoch, l.centerEpoch, c.centerEpoch, t.initialEpoch);
  eq(a.candidateKind, s.candidateKind, o.candidateKind, l.candidateKind);
  eq(a.preparationRef, s.preparationRef, t.preparationRef, o.preparationRef, l.preparationRef);
  eq(a.sourceSchemaVersion, h.sourceSchemaVersion, e?.schemaVersion ?? null);
  eq(a.sourceSchemaChecksum, h.sourceSchemaChecksum, e?.schemaChecksum ?? null);
  eq(a.executionPolicyHash, s.policyHash, l.executionPolicyHash);
  if (e?.kind === 'registered-backup') {
    assert.ok(d); eq(a.holdId, o.holdId, d.holdId); eq(d.backupId, e.backupId); eq(d.recoveryRunId, a.runId);
    eq(e.sourceRef, `backup:${e.backupId}`);
    eq(e.registryFormat, e.schemaVersion === 3 ? 2 : 3);
    eq(e.schemaChecksum, e.schemaVersion === 3 ? V3 : V4);
    if (e.schemaVersion === 3) assert.match(e.importedRecordHash, /^[a-f0-9]{64}$/); else eq(e.importedRecordHash, null);
  } else eq(null, a.holdId, o.holdId, d);
  if (!e) {
    eq(a.candidateKind, 'fresh_bootstrap'); eq(null, t.candidateBaseHash, t.importEpoch, s.sourceRef, s.sourceClosedEvidenceRef, s.sourceClosedEvidenceHash, s.isolationAckRef);
  } else {
    assert.ok(s.sourceClosedEvidenceRef); assert.match(s.sourceClosedEvidenceHash, /^[a-f0-9]{64}$/); assert.ok(s.isolationAckRef);
    eq(t.candidateBaseHash, e.fileHash ?? e.closedSourceFileHash);
    eq(e.schemaVersion, a.candidateKind === 'v3_import' ? 3 : 4);
    if (e.kind === 'closed-source') { eq(e.sourceRef, s.sourceRef); eq(e.isolationAckRef, s.isolationAckRef); eq(e.schemaChecksum, V3); }
  }
  if (a.candidateKind === 'snapshot_recovery') eq(null, a.preparationRef, t.importEpoch);
  else { assert.ok(a.preparationRef); eq(o.intakeWriteMode, 'paused'); }
  if (a.candidateKind === 'v3_import') { assert.ok(t.importEpoch); assert.notEqual(t.importEpoch, t.initialEpoch); }
  eq(i.inputFileHash, p.inputFileHash, o.intakeFileHash); eq(i.originalWriteMode, o.intakeWriteMode); eq(i.targetWriteMode, 'paused');
  eq(p.changed, o.intakeWriteMode === 'enabled');
  if (p.changed) assert.notEqual(p.pausedFileHash, o.intakeFileHash); else eq(p.pausedFileHash, o.intakeFileHash);
  eq(l.fromVersion, 4); eq(l.fromChecksum, V4); eq(l.toVersion, c.schemaVersion, h.targetSchemaVersion, 5); eq(l.toChecksum, c.schemaChecksum, h.targetSchemaChecksum, V5);
  eq(l.preconversionFileHash, p.pausedFileHash, c.preconversionFileHash); eq(c.transitionId, l.transitionId);
  eq(text('conversionPlan', f.plan), text('conversionPlan', l));
  eq(a.conversionPosthash, h.conversionPosthash, c.postconversionFileHash, h.archiveFileHash, h.liveInitialHash);
  eq(a.archiveReference, h.archiveReference, `runs/${a.runId}/conversion-archive.sqlite`);
  assert.ok(t.stagedAt >= s.createdAt);
  for (const floor of [t.stagedAt, t.instanceCreatedAt, e?.completedAt ?? e?.observedAt ?? 0, d?.createdAt ?? 0]) assert.ok(o.claimedAt >= floor);
  assert.ok(i.createdAt >= o.claimedAt && p.pausedAt >= i.createdAt && l.createdAt >= p.pausedAt && l.createdAt >= l.instanceCreatedAt);
  assert.ok(l.expiresAt > l.createdAt && l.expiresAt - l.createdAt <= 300000 && Number.isSafeInteger(l.expiresAt));
  assert.notEqual(f.executorId, f.approverId); assert.ok(f.convertedAt >= l.createdAt && f.convertedAt < l.expiresAt);
  assert.ok(h.handedOffAt >= a.createdAt && a.createdAt >= f.convertedAt);
}

export function assertIntakeGraph(b) {
  assert.deepEqual(Object.keys(b), FIELDS.intakeBundle);
  assert.deepEqual(Object.keys(b.actual), FIELDS.actual);
  const { intake: r, actual: x, sourceEvidence: e, archiveEvidence: b5 } = b;
  for (const key of ['instanceId', 'instanceCreatedAt']) assert.equal(x[key], r[key]);
  assert.equal(x.schemaVersion, 5); assert.equal(x.schemaChecksum, V5);
  assert.equal(r.targetSchemaVersion, x.schemaVersion); assert.equal(r.targetSchemaChecksum, x.schemaChecksum);
  assert.equal(x.centerEpoch, r.initialEpoch); assert.equal(x.recoveryCounter, r.previousRecoveryCounter); assert.equal(x.fileHash, r.candidateInitialHash);
  if (r.route === 'native-v5') {
    assert.equal(b5, null); assert.equal(text('source', e), text('source', r.sourceEvidence));
    assert.equal(digest('source', e), r.sourceEvidenceHash); assert.equal(r.sourceRef, e.sourceRef);
    assert.equal(r.instanceId, e.instanceId); assert.equal(r.instanceCreatedAt, e.instanceCreatedAt);
    assert.equal(r.candidateInitialHash, e.fileHash); assert.equal(r.sourceSchemaVersion, 5); assert.equal(r.sourceSchemaChecksum, V5);
    assert.equal(e.version, 2); assert.equal(e.registryFormat, 4); assert.equal(e.schemaVersion, 5); assert.equal(e.schemaChecksum, V5); assert.equal(e.importedRecordHash, null);
    assert.equal(e.sourceRef, `backup:${e.backupId}`); assert.ok(r.holdId); assert.equal(r.candidateReference, `v5-runs/${r.runId}/candidate.sqlite`);
    assert.ok(['paused', 'enabled'].includes(x.writeMode));
  } else {
    assert.equal(r.route, 'converted-v4'); assertArchiveGraph(b5);
    const { archiveIntent: a, handoff: h } = b5;
    assert.equal(r.handoffHash, digest('conversionHandoff', h)); assert.equal(r.archiveIntentHash, digest('archiveIntent', a));
    for (const key of ['runId', 'candidateReference', 'instanceId', 'instanceCreatedAt', 'sourceSchemaVersion', 'sourceSchemaChecksum']) { assert.equal(r[key], h[key]); assert.equal(r[key], a[key]); }
    for (const key of ['candidateKind', 'preparationRef', 'sourceEvidenceHash', 'executionPolicyHash', 'holdId']) assert.equal(r[key], a[key]);
    assert.equal(r.candidateInitialHash, h.liveInitialHash); assert.equal(r.initialEpoch, h.centerEpoch); assert.ok(r.acceptedAt >= h.handedOffAt);
    if (e === null) assert.equal(r.candidateKind, 'fresh_bootstrap'); else assert.equal(text(sourceKind(e), e), text(sourceKind(e), b5.legacyStage.sourceEvidence));
    if (r.candidateKind !== 'snapshot_recovery') assert.equal(r.previousRecoveryCounter, 0);
    assert.equal(x.writeMode, 'paused');
  }
}
