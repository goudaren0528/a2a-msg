import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backup, DatabaseSync } from 'node:sqlite';
import { createClosedV3Source, createImV2RecoveryServices, createRecoveryConversionTarget } from '../../../src/im/v2/recovery.js';
import { createTrustedImV2BackupServices } from '../../../src/im/v2/backup-registry.js';
import { sha } from '../../../src/im/v2/recovery-records.js';
import { context, authority, approvalAuthority } from '../im-v2-backup/helpers.js';
import { legacyPublished } from '../im-v2-backup/legacy-published.js';
import { policy, snapshot, legacy, importOptions } from '../im-v2-schema/helpers.js';
import { migrateImSchemaV4 } from '../../../src/im/v2/migration.js';

export { context };
function fixture(t, { v3 }) {
  const root = mkdtempSync(join(tmpdir(), 'b02a-conversion-'));
  const registryRoot = join(root, 'new'); mkdirSync(registryRoot, { mode: 0o700 });
  const f = legacy(t, { messages: 2, attachment: true, acks: [true, false], leases: true });
  if (!v3) migrateImSchemaV4(f.db, importOptions());
  t.after(() => {
    if (process.env.B02A_RETAIN_FIXTURES === '1') t.diagnostic(`retained fixture: ${root}`);
    else rmSync(root, { recursive: true, force: true });
  });
  return { ...f, root, registryRoot, options: { root: registryRoot, db: f.db, authority, approvalAuthority } };
}
// One wall domain for the publisher, registry and recovery fixtures. Native
// bridge time remains native; the fixture never manufactures future times.
function nondecreasingClock() {
  let last = 0;
  return () => (last = Math.max(last, Date.now()));
}
export function openWorkspace(root, catalog = {}, hooks = {}) {
  hooks.clock ??= nondecreasingClock();
  const evidenceAuthority = {
    assertSourceIsolation: () => { hooks.isolation?.(); return true; },
    getSourceClosedEvidence: binding => ({ version: 1, evidenceRef: 'conversion-fixture', ...binding, issuedAt: hooks.clock() }),
    authorizeSourceClosedEvidence: () => { hooks.sourceEvidence?.(); return true; },
    assertAuthReview: () => true,
  };
  const options = { root, sourceCatalog: catalog, policy: policy(), evidenceAuthority, clock: hooks.clock ?? nondecreasingClock(),
    authority: { authorizeAdmin: ctx => { hooks.admin?.(); return ctx === context; } },
    approvalAuthority: { authorizeApproval: () => true }, ...hooks.options };
  return { options, evidenceAuthority, open: () => createImV2RecoveryServices(options) };
}
export async function setup(t, route = 'fresh', enabled = false, hooks = {}) {
  const f = fixture(t, { v3: route.includes('v3') });
  f.options.clock = nondecreasingClock();
  hooks.clock ??= f.options.clock;
  const originalAuthority = f.options.authority;
  f.options.authority = { ...originalAuthority, authorizeAdmin: ctx => {
    hooks.sourceAdmin?.(); return originalAuthority.authorizeAdmin(ctx);
  } };
  if (enabled) f.db.exec("UPDATE im_settings SET write_mode='enabled'");
  const root = join(f.root, 'conversion-workspace'); mkdirSync(root, { mode: 0o700 });
  const workspace = openWorkspace(root, {}, hooks);
  let source, services;
  if (route === 'closed-v3') {
    source = join(f.root, 'closed.sqlite'); await backup(f.db, source); chmodSync(source, 0o600);
    workspace.options.sourceCatalog.source = { kind: 'closed-v3', source: createClosedV3Source({ path: source,
      sourceRef: 'source', evidenceAuthority: workspace.evidenceAuthority }) };
  } else if (route !== 'fresh') {
    services = createTrustedImV2BackupServices(f.options);
    let record;
    if (route === 'registered-v3') {
      const old = await legacyPublished(t, f);
      ({ record } = services.publisher.importRegisteredV3({ sourceRegistry: old.old.registry, backupId: old.output.backupId }, context));
    } else {
      ({ record } = await services.publisher.publish({ approvalRef: 'test-approved' }, context));
      await services.publisher.drain();
      // Build a genuine historical active recovery, then publish that center as
      // the new workflow's immutable source. Never fabricate recovery rows.
      const historyRoot = join(f.root, 'historical-workspace'); mkdirSync(historyRoot, { mode: 0o700 });
      const history = openWorkspace(historyRoot, { source: { kind: 'registered-backup', registry: services.registry, backupId: record.backupId } }, { clock: f.options.clock }).open();
      const historicalStage = history.stageCandidate({ requestRef: 'historical', candidateKind: 'snapshot_recovery', sourceRef: 'source', isolationAckRef: 'isolated' }, context);
      const run = { runId: historicalStage.runId };
      const preview = history.previewRecovery(run, context);
      history.prepareRecovery({ ...run, preparePlanHash: preview.preparePlanHash, approvalRef: 'prepare' }, context);
      const seal = history.verifyRecovery({ ...run, preparePlanHash: preview.preparePlanHash }, context);
      const activation = history.previewActivation({ ...run, sealReference: seal.sealReference, authReviewRef: 'review', isolationAckRef: 'isolated', activationRef: 'activate' }, context);
      history.activateRecovery({ ...run, activationPlanHash: activation.activationPlanHash, activationApprovalRef: 'activate', sealReference: seal.sealReference }, context);
      const historicalDb = new DatabaseSync(join(historyRoot, historicalStage.candidateReference));
      t.after(() => historicalDb.close());
      historicalDb.exec('PRAGMA foreign_keys=ON');
      if (enabled) historicalDb.exec("UPDATE im_settings SET write_mode='enabled'");
      services = createTrustedImV2BackupServices({ ...f.options, db: historicalDb });
      ({ record } = await services.publisher.publish({ approvalRef: 'test-approved' }, context));
      await services.publisher.drain();
    }
    source = join(f.registryRoot, record.artifactReference);
    workspace.options.sourceCatalog.source = { kind: 'registered-backup', registry: services.registry, backupId: record.backupId };
  }
  const input = { requestRef: 'conversion', candidateKind: route === 'fresh' ? 'fresh_bootstrap' : route.includes('v3') ? 'v3_import' : 'snapshot_recovery',
    sourceRef: route === 'fresh' ? null : 'source', isolationAckRef: route === 'fresh' ? null : 'isolated' };
  const api = workspace.open(), staged = api.stageCandidate(input, context);
  const path = join(root, staged.candidateReference), dir = join(root, 'runs', staged.runId);
  return { f, root, dir, path, source, services, ...workspace, api, staged, input,
    target: () => createRecoveryConversionTarget(workspace.open(), { runId: staged.runId }, context) };
}
export function bytes(path) { return sha(readFileSync(path)); }
export function logical(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return snapshot(db); } finally { db.close(); }
}
export function tree(path) {
  return Object.fromEntries(readdirSync(path, { recursive: true }).sort().map(name => {
    const item = join(path, name), st = statSync(item, { bigint: true });
    return [name, st.isDirectory() ? 'directory' : `${bytes(item)}:${st.mtimeNs}:${st.ctimeNs}:${st.size}`];
  }));
}
export const intakeKeys = ['version', 'runId', 'stageHash', 'stagedHash', 'candidateReference', 'instanceId',
  'instanceCreatedAt', 'centerEpoch', 'candidateKind', 'preparationRef', 'sourceEvidenceHash', 'holdId',
  'executionPolicyHash', 'phase', 'intakeFileHash', 'intakeWriteMode', 'currentFileHash', 'currentWriteMode',
  'ownerHash', 'pauseIntentHash', 'pausedHash'];
