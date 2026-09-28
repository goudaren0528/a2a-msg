// Independent B0.1 field/hash oracle. No migration-engine helpers or synthetic
// positive v5 fixture: every positive transition comes from the real converter.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const V4 = 'c950eb40692a72f918c8976d4bef8cab0b9e357495b01df75e0ab2d1b0b5f216';
export const V5 = '80eba5e6ce61261d31ec495216c3b6eb8c7a8f0c87edcbb1440372353f495435';
export const limits = Object.freeze({ maxMessages: 10000, maxVerifiedContentBytes: 104857600,
  maxOtherRecords: 10000, maxElapsedMs: 10000, maxFileBytes: 134217728, maxMetadataEntries: 10000, planTtlMs: 300000 });
export const fields = Object.freeze({
  conversionPlan: 'version transitionId instanceId instanceCreatedAt centerEpoch recoveryRunId stageHash candidateReference candidateKind preparationRef sourceEvidenceHash fromVersion fromChecksum toVersion toChecksum preconversionFileHash executionPolicyHash createdAt expiresAt'.split(' '),
  conversionProof: 'version plan planHash approvalRef executorId approverId convertedAt'.split(' '),
  conversionComplete: 'version transitionId planHash conversionProofHash instanceId instanceCreatedAt centerEpoch recoveryRunId stageHash candidateReference schemaVersion schemaChecksum preconversionFileHash postconversionFileHash'.split(' '),
});
const domains = { conversionPlan: 'im-center-schema-conversion-plan-v1\n',
  conversionProof: 'im-center-schema-conversion-proof-v1\n', conversionComplete: 'im-center-schema-conversion-complete-v1\n' };
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const fileHash = path => sha(readFileSync(path));
export function canonical(kind, value) {
  assert.deepEqual(Object.keys(value).sort(), [...fields[kind]].sort());
  const ordered = Object.fromEntries(fields[kind].map(key => [key, key === 'plan'
    ? JSON.parse(canonical('conversionPlan', value[key])) : value[key]]));
  return JSON.stringify(ordered);
}
export const hash = (kind, value) => sha(domains[kind] + canonical(kind, value));
export function record(path, kind) {
  const bytes = readFileSync(path), value = JSON.parse(bytes);
  assert.equal(bytes.toString('utf8'), canonical(kind, value));
  assert.ok(bytes.length <= 65536);
  return value;
}
export function withDb(path, read) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}
const quote = name => '"' + name.replaceAll('"', '""') + '"';
export function snapshot(path) {
  return withDb(path, snapshotDb);
}
export function snapshotDb(db) {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex_%' AND (name LIKE 'im_%' OR tbl_name LIKE 'im_%') ORDER BY name").all()
      .map(row => [row.type, row.name, row.tbl_name, row.sql.trim().replace(/\s+/g, ' ')]);
    const rows = Object.fromEntries(schema.filter(row => row[0] === 'table').map(([, name]) => [name,
      db.prepare(`SELECT * FROM ${quote(name)}`).all().map(row => JSON.stringify(row, (_, v) => v instanceof Uint8Array ? [...v] : v)).sort()]));
    return { schema, rows };
}
export function inherited(before, after, paused = false) {
  for (const [table, rows] of Object.entries(before.rows)) {
    if (table === 'im_schema') continue;
    assert.deepEqual(after.rows[table], paused && table === 'im_settings'
      ? rows.map(row => JSON.stringify({ ...JSON.parse(row), write_mode: 'paused' })) : rows, `all inherited rows: ${table}`);
  }
  assert.deepEqual(after.schema.filter(row => before.schema.some(old => old[1] === row[1]) && row[1] !== 'im_schema'),
    before.schema.filter(row => row[1] !== 'im_schema'), 'all inherited DDL unchanged except marker');
}
export function files(dir) {
  // Only called outside held operations: never raw-open a live coordination inode.
  return Object.fromEntries(readdirSync(dir).sort().map(name => {
    const path = join(dir, name), st = statSync(path, { bigint: true });
    return [name, { hash: st.isFile() ? fileHash(path) : null, size: String(st.size),
      mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs) }];
  }));
}
export function retained(before, after, exceptions = []) {
  for (const [name, value] of Object.entries(before)) if (!exceptions.includes(name)) assert.deepEqual(after[name], value, name);
}
export function checkPlan(s, preview, pausedHash) {
  assert.deepEqual(Object.keys(preview), ['version', 'plan', 'planHash', 'replayed']);
  assert.equal(preview.version, 1); assert.equal(preview.replayed, false);
  const p = preview.plan, owner = JSON.parse(readFileSync(join(s.dir, 'conversion-owner.json')));
  const paused = JSON.parse(readFileSync(join(s.dir, 'conversion-paused.json')));
  const stage = JSON.parse(readFileSync(join(s.dir, 'stage.json')));
  assert.deepEqual(Object.keys(p), fields.conversionPlan);
  assert.ok(Object.isFrozen(preview)); assert.ok(Object.isFrozen(p));
  assert.match(p.transitionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  for (const field of ['instanceId', 'instanceCreatedAt', 'centerEpoch', 'candidateReference', 'candidateKind', 'preparationRef', 'sourceEvidenceHash', 'stageHash']) assert.equal(p[field], owner[field], field);
  assert.equal(p.recoveryRunId, s.staged.runId); assert.equal(p.version, 1);
  assert.equal(p.fromVersion, 4); assert.equal(p.fromChecksum, V4); assert.equal(p.toVersion, 5); assert.equal(p.toChecksum, V5);
  assert.equal(p.stageHash, sha(readFileSync(join(s.dir, 'stage.json'))));
  assert.equal(p.executionPolicyHash, stage.policyHash);
  assert.equal(p.preconversionFileHash, pausedHash); assert.equal(p.preconversionFileHash, paused.pausedFileHash);
  assert.ok(p.createdAt >= paused.pausedAt); assert.ok(p.createdAt >= p.instanceCreatedAt);
  const clock = withDb(s.path, db => db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at);
  assert.ok(p.createdAt >= clock); assert.equal(p.expiresAt - p.createdAt, limits.planTtlMs);
  assert.equal(preview.planHash, hash('conversionPlan', p));
  assert.deepEqual(record(join(s.dir, 'conversion-plan.json'), 'conversionPlan'), p);
}
export function checkConverted(s, preview, result, before, validateV5, { replayed = false, executorId = 'executor', approvalRef = 'approved', approverId = 'independent' } = {}) {
  assert.deepEqual(Object.keys(result), ['version', 'transitionId', 'planHash', 'conversionProofHash', 'schemaVersion', 'schemaChecksum', 'replayed']);
  const { plan: p, planHash } = preview;
  assert.deepEqual({ ...result, conversionProofHash: null }, { version: 1, transitionId: p.transitionId, planHash,
    conversionProofHash: null, schemaVersion: 5, schemaChecksum: V5, replayed });
  let transition;
  withDb(s.path, db => {
    assert.equal(validateV5(db), undefined);
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    for (const table of ['im_maintenance_time_anchors', 'im_maintenance_time_head']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    const rows = db.prepare('SELECT * FROM im_center_schema_transitions').all(); assert.equal(rows.length, 1); transition = rows[0];
  });
  const reconstructed = { version: 1 };
  for (const key of fields.conversionPlan.slice(1)) reconstructed[key] = transition[key === 'createdAt' ? 'plan_created_at' : key === 'expiresAt' ? 'plan_expires_at' : key.replace(/[A-Z]/g, c => '_' + c.toLowerCase())];
  assert.deepEqual(reconstructed, p); assert.equal(transition.approved_plan_hash, planHash);
  assert.equal(transition.executor_id, executorId); assert.equal(transition.approval_ref, approvalRef); assert.equal(transition.approver_id, approverId);
  assert.ok(transition.converted_at >= p.createdAt && transition.converted_at < p.expiresAt);
  const proof = { version: 1, plan: reconstructed, planHash, approvalRef, executorId, approverId, convertedAt: transition.converted_at };
  assert.equal(result.conversionProofHash, hash('conversionProof', proof));
  const expected = { version: 1, transitionId: p.transitionId, planHash, conversionProofHash: result.conversionProofHash,
    instanceId: p.instanceId, instanceCreatedAt: p.instanceCreatedAt, centerEpoch: p.centerEpoch, recoveryRunId: p.recoveryRunId,
    stageHash: p.stageHash, candidateReference: p.candidateReference, schemaVersion: 5, schemaChecksum: V5,
    preconversionFileHash: p.preconversionFileHash, postconversionFileHash: fileHash(s.path) };
  assert.deepEqual(record(join(s.dir, 'conversion-complete.json'), 'conversionComplete'), expected);
  const after = snapshot(s.path); inherited(before, after);
  const golden = JSON.parse(readFileSync(new URL('../im-v2-schema-v5/v5-manifest.json', import.meta.url)));
  assert.deepEqual([...after.schema].sort((a, b) => a[1].localeCompare(b[1])), golden);
  assert.equal(readdirSync(s.dir).some(name => /-(wal|shm|journal)$|\.pending$/.test(name)), false);
  assert.equal(statSync(s.path).nlink, 1);
  return { proof, completion: expected, snapshot: after };
}
export function safeError(call, code) {
  let error; try { call(); } catch (caught) { error = caught; }
  assert.ok(error, `expected ${code}`); assert.equal(error.code, code); assert.equal(error.message, code);
  return { code: error.code, message: error.message };
}
