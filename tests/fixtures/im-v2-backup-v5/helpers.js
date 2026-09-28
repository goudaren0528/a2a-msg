// TEST ONLY: synthetic sources, independent byte oracle, and native observers.
// Deliberately no backup/registry/recovery-source imports: safe stable preflight.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync, backup } from 'node:sqlite';
import { fixture as schemaFixture, anchor, head, GOLDEN, MANIFEST } from '../im-v2-schema-v5/helpers.js';
import { bindRun, recoveryRow, snapshot, manifest, addMessage, insert } from '../im-v2-schema/helpers.js';
import { assertImSchemaV5 } from '../../../src/im/v2/schema-v5.js';

export const unsupported = process.platform === 'win32';
export const context = Object.freeze({ actor: 'b2-test-executor' });
export const actors = Object.freeze({ executorActorId: 'b2-test-executor', approverActorId: 'b2-test-approver' });
export const authority = Object.freeze({ authorizeAdmin: value => value === context, publicationActors: () => ({ ...actors }) });
export const approvalAuthority = Object.freeze({ authorizeBackup: (value, ctx) => ctx === context && value.approvalRef === 'b2-approved' });
export const mismatch = { code: 'RECOVERY_EVIDENCE_MISMATCH' };
export const busy = { code: 'RECOVERY_BUSY' };
export const unsupportedError = { code: 'RECOVERY_UNSUPPORTED' };
export const uncertain = { code: 'RECOVERY_DURABILITY_UNCERTAIN' };
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export { snapshot, GOLDEN };

const fields = {
  manifest: 'formatVersion backupId sourceId sourceCreatedAt schemaVersion schemaChecksum fileHash completedAt toolVersion approval',
  record: 'recordVersion backupId instanceId instanceCreatedAt schemaVersion schemaChecksum fileHash manifestHash completedAt artifactReference publicationKind sourceEvidenceHash registeredAt',
  source: 'version kind sourceRef registryFormat instanceId instanceCreatedAt backupId fileHash manifestHash schemaVersion schemaChecksum completedAt importedRecordHash',
};
export function canonical(kind, value) {
  const ordered = Object.fromEntries(fields[kind].split(' ').map(key => [key, value[key]]));
  if (kind === 'manifest') ordered.approval = Object.fromEntries(['approvalRef', 'executorActorId', 'approverActorId'].map(key => [key, value.approval[key]]));
  return Buffer.from(JSON.stringify(ordered));
}
export function frozen(value) {
  assert.ok(Object.isFrozen(value));
  for (const item of Object.values(value)) if (item && typeof item === 'object') frozen(item);
}
export function fixture(t, { mode = 'paused' } = {}) {
  const cleanups = [];
  const f = schemaFixture({ after: callback => cleanups.push(callback) }, { business: true });
  const root = fs.mkdtempSync(join(tmpdir(), 'b2-v5-'));
  const registryRoot = join(root, 'backup'); fs.mkdirSync(registryRoot, { mode: 0o700 });
  // SQL construction is confined to this synthetic fixture; no private writer,
  // actual converted workspace, recovery owner or operational time capability.
  bindRun(f.db, recoveryRow(f.db, 'v3_import', { status: 'active', verified_at: 101, activated_at: 102,
    activation_ref: 'b2-synthetic-active', auth_review_ref: 'b2-synthetic-review',
    activation_plan_hash: sha('b2-synthetic-activation'), activation_approval_ref: 'b2-synthetic-approval' }));
  f.db.prepare('UPDATE im_settings SET write_mode=?').run(mode);
  anchor(f.db); const tip = anchor(f.db); head(f.db, tip);
  assertImSchemaV5(f.db);
  assert.deepEqual(manifest(f.db), MANIFEST, 'independent committed exact schema golden');
  assert.equal(f.db.prepare('SELECT migration_checksum FROM im_schema').get().migration_checksum, GOLDEN.checksum);
  assert.equal(f.db.prepare('SELECT status FROM im_center_state').get().status, 'active');
  assert.equal(f.db.prepare('SELECT count(*) n FROM im_maintenance_time_anchors').get().n, 2);
  assert.equal(f.db.prepare('SELECT generation FROM im_maintenance_time_head').get().generation, 2);
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
  return { ...f, root, registryRoot, own: callback => cleanups.push(callback), options: { root: registryRoot, db: f.db, authority, approvalAuthority } };
}
export async function liveSource(t, f, { wal = false } = {}) {
  const path = join(f.root, 'live.sqlite'); await backup(f.db, path); fs.chmodSync(path, 0o600);
  const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
  if (wal) {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    db.prepare('UPDATE im_agents SET display_name=? WHERE agent_id=?').run('b2 committed WAL fact', f.a);
    assert.ok(fs.statSync(`${path}-wal`).size > 0);
  }
  f.own(() => db.close());
  return { db, path };
}
export function paths(root, id) {
  return { artifact: join(root, 'registry/artifacts', `${id}.sqlite`),
    manifest: join(root, 'registry/artifacts', `${id}.manifest.json`),
    source: join(root, 'registry/records', `${id}.source.json`), record: join(root, 'registry/records', `${id}.json`) };
}
export function fileState(path) {
  const st = fs.lstatSync(path);
  return { bytes: fs.readFileSync(path), dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, mode: st.mode, nlink: st.nlink };
}
export function inventory(root) {
  const result = {};
  function visit(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const path = join(dir, name), key = `${prefix}${name}`, st = fs.lstatSync(path);
      if (st.isDirectory()) visit(path, `${key}/`);
      else result[key] = fileState(path);
    }
  }
  visit(root); return result;
}
export function readChain(root, id) {
  const p = paths(root, id);
  return { paths: p, manifest: JSON.parse(fs.readFileSync(p.manifest)), source: JSON.parse(fs.readFileSync(p.source)), record: JSON.parse(fs.readFileSync(p.record)) };
}
export function assertChain(f, result, expectedSnapshot = snapshot(f.db), expectedApproval = { approvalRef: 'b2-approved', ...actors }) {
  const { record, sourceEvidence } = result, id = record.backupId;
  const chain = readChain(f.registryRoot, id), { paths: p, manifest: m } = chain;
  const identity = f.db.prepare('SELECT * FROM im_instance_identity').get();
  const expectedManifest = { formatVersion: 3, backupId: id, sourceId: identity.instance_id, sourceCreatedAt: identity.created_at,
    schemaVersion: 5, schemaChecksum: GOLDEN.checksum, fileHash: sha(fs.readFileSync(p.artifact)), completedAt: m.completedAt,
    toolVersion: 'im-v2-backup-2', approval: expectedApproval };
  const manifestHash = sha(canonical('manifest', expectedManifest));
  const expectedSource = { version: 2, kind: 'registered-backup', sourceRef: `backup:${id}`, registryFormat: 4,
    instanceId: identity.instance_id, instanceCreatedAt: identity.created_at, backupId: id, fileHash: expectedManifest.fileHash,
    manifestHash, schemaVersion: 5, schemaChecksum: GOLDEN.checksum, completedAt: m.completedAt, importedRecordHash: null };
  const expectedRecord = { recordVersion: 4, backupId: id, instanceId: identity.instance_id, instanceCreatedAt: identity.created_at,
    schemaVersion: 5, schemaChecksum: GOLDEN.checksum, fileHash: expectedManifest.fileHash, manifestHash, completedAt: m.completedAt,
    artifactReference: `registry/artifacts/${id}.sqlite`, publicationKind: 'native-v5', sourceEvidenceHash: sha(canonical('source', expectedSource)), registeredAt: record.registeredAt };
  for (const [kind, value] of [['manifest', expectedManifest], ['source', expectedSource], ['record', expectedRecord]]) {
    assert.deepEqual(fs.readFileSync(p[kind]), canonical(kind, value), `${kind} independently reconstructed exact bytes`);
  }
  assert.deepEqual(record, expectedRecord); assert.deepEqual(sourceEvidence, expectedSource); frozen(record); frozen(sourceEvidence);
  assert.equal(fs.existsSync(join(f.registryRoot, 'registry/records', `${id}.import.json`)), false);
  const copy = new DatabaseSync(p.artifact, { readOnly: true });
  try { assertImSchemaV5(copy); assert.deepEqual(snapshot(copy), expectedSnapshot); } finally { copy.close(); }
  return chain;
}
export function rehashChain(root, id, change = () => {}) {
  const c = readChain(root, id); change(c);
  c.manifest.fileHash = sha(fs.readFileSync(c.paths.artifact));
  const mb = canonical('manifest', c.manifest); fs.writeFileSync(c.paths.manifest, mb);
  c.source.fileHash = c.manifest.fileHash; c.source.manifestHash = sha(mb);
  const sb = canonical('source', c.source); fs.writeFileSync(c.paths.source, sb);
  Object.assign(c.record, { fileHash: c.manifest.fileHash, manifestHash: sha(mb), sourceEvidenceHash: sha(sb) });
  fs.writeFileSync(c.paths.record, canonical('record', c.record));
  return c;
}
export function wrapFs(replacements) {
  const originals = {};
  for (const [key, build] of Object.entries(replacements)) { originals[key] = fs[key]; fs[key] = build(fs[key]); }
  syncBuiltinESMExports();
  return () => { Object.assign(fs, originals); syncBuiltinESMExports(); };
}
export const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;

export function addValidMessage(f) {
  const id = addMessage(f, { text: 'B2 second fully correlated message', attachment: true, ack: false });
  const m = f.db.prepare('SELECT * FROM im_messages WHERE message_id=?').get(id);
  const prep = f.db.prepare('SELECT * FROM im_schema_preparations').get();
  insert(f.db, 'im_send_operation_keys', { sender_id: m.sender_id, origin_epoch: prep.import_epoch,
    client_message_id: m.client_message_id, storage_client_message_id: m.client_message_id, source_protocol: 'a2a-msg.im.v1', message_id: id });
  insert(f.db, 'im_content_state', { message_id: id, state: 'live', expires_at: m.accepted_at + 7776000000, policy_hash: prep.policy_hash });
  const a = f.db.prepare('SELECT * FROM im_attachments WHERE message_id=?').get(id);
  insert(f.db, 'im_attachment_reservations', { attachment_id: a.attachment_id, message_id: id, size: a.size, sha256: a.sha256 });
  assertImSchemaV5(f.db);
  return id;
}

// Lawful large metadata, not oversized/corrupt refs: every Ref is exactly 255
// ASCII units. Independent helper hashes proposals/anchors; history stays linked.
export function growAnchors(db, total) {
  let count = db.prepare('SELECT count(*) n FROM im_maintenance_time_anchors').get().n, tip;
  db.exec('BEGIN IMMEDIATE');
  try {
    while (count++ < total) tip = anchor(db, { approvalRef: 'a'.repeat(255), executorId: 'e'.repeat(255), approverId: 'r'.repeat(255) });
    if (tip) db.prepare('UPDATE im_maintenance_time_head SET generation=?,anchor_hash=?').run(tip.generation, tip.anchor_hash);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  // This is the documented v5 projection charge, calculated independently from
  // actual rows, not a lower standalone maintenance limit or product encoder.
  const rows = db.prepare('SELECT * FROM im_maintenance_time_anchors ORDER BY generation').all();
  const bytes = rows.reduce((sum, row) => sum + 4096 + 12 * Object.values(row).reduce((n, v) => n + (typeof v === 'string' ? Buffer.byteLength(v) : 0), 0), 0);
  assert.equal(rows.length, total);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(rows[i].generation, i + 1);
    assert.equal(rows[i].previous_generation, i ? i : null);
    assert.equal(rows[i].previous_anchor_hash, i ? rows[i - 1].anchor_hash : null);
    for (const key of ['approval_ref', 'executor_id', 'approver_id']) assert.ok(rows[i][key].length <= 255);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('SELECT generation FROM im_maintenance_time_head').get().generation, total);
  return { anchors: total, anchorProjectionBytes: bytes };
}
