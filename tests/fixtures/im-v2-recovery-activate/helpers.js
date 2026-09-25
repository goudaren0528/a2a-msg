import { mkdirSync, chmodSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { fixture, context } from '../im-v2-backup/helpers.js';
import { legacyPublished } from '../im-v2-backup/legacy-published.js';
import { policy, snapshot } from '../im-v2-schema/helpers.js';
import { createTrustedImV2BackupServices } from '../../../src/im/v2/backup-registry.js';
import { createClosedV3Source, createImV2RecoveryServices } from '../../../src/im/v2/recovery.js';
import { sha } from '../../../src/im/v2/recovery-records.js';
export { context, snapshot };
export function query(path, callback) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return callback(db); } finally { db.close(); }
}
export function tree(path) {
  return Object.fromEntries(readdirSync(path, { recursive: true }).sort().map(name => {
    const p = join(path, name), s = statSync(p);
    return [name, s.isDirectory() ? 'directory' : `${sha(readFileSync(p))}:${s.mtimeMs}:${s.size}`];
  }));
}
export function business(path) {
  const all = query(path, snapshot);
  for (const name of ['im_clock', 'im_center_state', 'im_recovery_runs', 'im_audit']) delete all.rows[name];
  return all;
}
export function typedBusiness(path) {
  return query(path, db => {
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'im_%' ORDER BY name").all()
      .map(row => row.name).filter(name => !['im_clock', 'im_center_state', 'im_recovery_runs', 'im_audit'].includes(name));
    const rows = {};
    for (const name of names) {
      const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name);
      const statement = db.prepare(`SELECT rowid,${columns.map((column, i) => `typeof(${column}) AS t${i},CASE typeof(${column}) WHEN 'text' THEN hex(CAST(${column} AS BLOB)) WHEN 'blob' THEN hex(${column}) ELSE ${column} END AS v${i}`).join(',')} FROM ${name} ORDER BY rowid`);
      statement.setReadBigInts(true);
      rows[name] = statement.all().map(row => JSON.stringify(row, (_, value) => typeof value === 'bigint' ? value.toString() : value));
    }
    return { rows, hash: sha(JSON.stringify(rows)) };
  });
}
export async function setup(t, route = 'fresh', configureSource = () => {}) {
  const f = fixture(t, { v3: route.includes('v3') });
  configureSource(f);
  // Independent clocks are fixed from initial composition, including A. The
  // future offset accommodates P1's own trusted initialization timestamp.
  const state = { now: Date.now() + 60000, admin: true, prepare: true, activate: true, isolated: true, reviewed: true, calls: [] };
  const registryClock = { now: state.now };
  f.options.clock = () => registryClock.now;
  const root = join(f.root, 'workspace'); mkdirSync(root, { mode: 0o700 });
  const evidenceAuthority = {
    assertSourceIsolation: () => state.isolated,
    getSourceClosedEvidence: binding => ({ version: 1, evidenceRef: 'closure', ...binding, issuedAt: state.now }),
    authorizeSourceClosedEvidence: () => state.isolated,
    assertAuthReview: (input, ctx) => { state.calls.push(input); return ctx === context && input.authReviewRef === 'review' && state.reviewed; },
  };
  let sourcePath = null, services = null;
  const sourceCatalog = {};
  if (route === 'closed-v3') {
    sourcePath = join(f.root, 'closed.sqlite'); await backup(f.db, sourcePath); chmodSync(sourcePath, 0o600);
    sourceCatalog.source = { kind: 'closed-v3', source: createClosedV3Source({ path: sourcePath, sourceRef: 'source', evidenceAuthority }) };
  } else if (route !== 'fresh') {
    services = createTrustedImV2BackupServices(f.options);
    let record;
    if (route === 'registered-v3') {
      const old = await legacyPublished(t, f);
      ({ record } = services.publisher.importRegisteredV3({ sourceRegistry: old.old.registry, backupId: old.output.backupId }, context));
    } else {
      ({ record } = await services.publisher.publish({ approvalRef: 'test-approved' }, context));
      await services.publisher.drain();
    }
    sourceCatalog.source = { kind: 'registered-backup', registry: services.registry, backupId: record.backupId };
    sourcePath = join(f.registryRoot, record.artifactReference);
  }
  const options = { root, sourceCatalog, policy: policy(), clock: () => state.now,
    authority: { authorizeAdmin: ctx => ctx === context && state.admin }, evidenceAuthority,
    approvalAuthority: { authorizeApproval: (input, ctx) => ctx === context &&
      (input.kind === 'prepare' ? state.prepare && input.approvalRef === 'prepare-ok' :
        input.kind === 'activate' && state.activate && input.approvalRef.startsWith('activate-ok')) } };
  const open = () => createImV2RecoveryServices(options), api = open();
  const staged = api.stageCandidate({ requestRef: 'request', candidateKind: route === 'fresh' ? 'fresh_bootstrap' : route.includes('v3') ? 'v3_import' : 'snapshot_recovery',
    sourceRef: route === 'fresh' ? null : 'source', isolationAckRef: route === 'fresh' ? null : 'isolated' }, context);
  const preview = api.previewRecovery({ runId: staged.runId }, context);
  const prepareInput = { runId: staged.runId, preparePlanHash: preview.preparePlanHash, approvalRef: 'prepare-ok' };
  api.prepareRecovery(prepareInput, context);
  const verifyInput = { runId: staged.runId, preparePlanHash: preview.preparePlanHash };
  const previewInput = seal => ({ runId: staged.runId, sealReference: seal.sealReference, authReviewRef: 'review',
    isolationAckRef: route === 'fresh' ? null : 'isolated', activationRef: 'activation' });
  const activateInput = (seal, plan, approvalRef = 'activate-ok') => ({ runId: staged.runId,
    activationPlanHash: plan.activationPlanHash, activationApprovalRef: approvalRef, sealReference: seal.sealReference });
  return { f, root, state, registryClock, options, open, api, staged, preview, prepareInput, verifyInput, previewInput, activateInput,
    path: join(root, staged.candidateReference), dir: join(root, 'runs', staged.runId), sourcePath, services };
}
