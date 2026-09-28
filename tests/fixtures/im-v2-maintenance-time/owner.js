// TEST ONLY. Synthetic construction owns this private directory for its lifetime.
// No recovery workspace, conversion completion, listener or user path is accepted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { assertImSchemaV5Internal } from '../../../src/im/v2/schema-v5-internal.js';
import { MANIFEST, GOLDEN, V4, recordHash, snake } from '../im-v2-schema-v5/helpers.js';
import { insert, policy, putPolicy, preparationHash, recoveryRow, bindRun } from '../im-v2-schema/helpers.js';

export const TARGET_LIMITS = Object.freeze({ maxMessages: 10000, maxVerifiedContentBytes: 104857600,
  maxOtherRecords: 10000, maxElapsedMs: 10000, maxMaintenanceAnchors: 10000, maxMaintenanceMetadataBytes: 10485760 });
export const AUTHORITY_LIMITS = Object.freeze({ ...TARGET_LIMITS, proposalTtlMs: 300000,
  acceptanceWindowMs: 5000, maxForwardJumpMs: 86400000 });
export const CONTEXT = Object.freeze({ purpose: 'isolated-synthetic-time-test' });
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const proposalFields = 'version instanceId instanceCreatedAt centerEpoch previousGeneration previousAnchorHash sessionNonce proposedAt proposalExpiresAt candidateWallAt acceptNotBefore acceptNotAfter globalFloorObservedAt maxForwardJumpMs'.split(' ');
export const anchorFields = 'version instanceId instanceCreatedAt generation centerEpoch previousGeneration previousAnchorHash proposalHash sessionNonce proposedAt proposalExpiresAt candidateWallAt acceptNotBefore acceptNotAfter acceptedWallAt globalFloorObservedAt globalFloorAtApproval maxForwardJumpMs approvalRef executorId approverId'.split(' ');
export const bindingFields = 'kind proposalHash approvalRef instanceId instanceCreatedAt centerEpoch previousGeneration previousAnchorHash headGeneration headHash sessionNonce proposedAt proposalExpiresAt candidateWallAt acceptNotBefore acceptNotAfter globalFloorObservedAt maxForwardJumpMs executorId'.split(' ');
export const evidenceFields = 'version schemaVersion observedWallAt globalFloorObservedAt anchorGeneration anchorHash sessionNonce anchorWallAt monotonicElapsedMs maxForwardJumpMs executable reason'.split(' ');
export const statusFields = 'version instanceId instanceCreatedAt centerEpoch headGeneration headHash sessionPresent reason'.split(' ');
export function ordered(fields, value) { return Object.fromEntries(fields.map(key => [key, value[key]])); }
export function proposalOf(anchor) { return ordered(proposalFields, anchor); }
export function digest(kind, value) {
  const fields = kind === 'timeProposal' ? proposalFields : anchorFields;
  return sha(`im-maintenance-time-${kind === 'timeProposal' ? 'proposal' : 'anchor'}-v1\n${JSON.stringify(ordered(fields, value))}`);
}
export function logicalImage(db, prepare = DatabaseSync.prototype.prepare) {
  const schema = prepare.call(db, 'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all();
  const rows = Object.fromEntries(schema.filter(r => r.type === 'table').map(r => [r.name,
    prepare.call(db, `SELECT * FROM "${r.name}"`).all().map(row => JSON.stringify(row,
      (_, value) => value instanceof Uint8Array ? Array.from(value) : value)).sort()]));
  return { schema: JSON.parse(JSON.stringify(schema)), rows };
}
export function fileImage(dir) {
  return fs.readdirSync(dir).sort().map(name => {
    const path = join(dir, name), stat = fs.lstatSync(path, { bigint: true });
    return { name, dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
      size: String(stat.size), mtimeNs: String(stat.mtimeNs), sha256: stat.isFile() ? sha(fs.readFileSync(path)) : null };
  }); // Deliberately no atime claim.
}
export function assertApprovalOnly(before, after) {
  assert.deepEqual(after.schema, before.schema, 'every schema object remains byte-identical');
  for (const [table, rows] of Object.entries(before.rows)) {
    if (!['im_clock', 'im_maintenance_time_anchors', 'im_maintenance_time_head'].includes(table))
      assert.deepEqual(after.rows[table], rows, `${table} inherited rows unchanged`);
  }
}
function addContent(db, epoch) {
  const a = '00000000-0000-0000-0000-000000000010', b = '00000000-0000-0000-0000-000000000011';
  const conversation = randomUUID(), stream = randomUUID();
  for (const agent_id of [a, b]) insert(db, 'im_agents', { agent_id, display_name: 'synthetic', status: 'active', created_at: 1 });
  insert(db, 'im_conversations', { conversation_id: conversation, agent_low: a, agent_high: b, created_at: 1 });
  insert(db, 'im_receive_state', { agent_id: b, next_seq: 3, acked_through: 0, retained_floor: 1, stream_epoch: stream });
  insert(db, 'im_sync_progress', { recipient_id: b, center_epoch: epoch, stream_epoch: stream, handled_through: 0, updated_at: 100 });
  const policyHash = db.prepare('SELECT policy_hash FROM im_retention_policies').get().policy_hash;
  for (let seq = 1; seq <= 2; seq++) {
    const message = randomUUID(), client = randomUUID(), attachment = randomUUID(), data = Buffer.from('isolated-payload-é字');
    const tuple = ['fixture.txt', 'text/plain', data.length, sha(data)];
    insert(db, 'im_messages', { message_id: message, conversation_id: conversation, sender_id: a, recipient_id: b,
      client_message_id: `v2:${epoch}:${client}`, accepted_at: 100, title: null, text: 'fixture-é字', correlation: null });
    insert(db, 'im_attachments', { attachment_id: attachment, message_id: message, name: tuple[0], mime: tuple[1], size: tuple[2], sha256: tuple[3], data });
    insert(db, 'im_attachment_reservations', { attachment_id: attachment, message_id: message, size: data.length, sha256: sha(data) });
    insert(db, 'im_send_keys', { sender_id: a, client_message_id: `v2:${epoch}:${client}`,
      payload_hash: sha(JSON.stringify(['a2a-msg.im.v2', epoch, conversation, b, client, null, 'fixture-é字', tuple, null, null])),
      message_id: message, created_at: 100, retry_until: 604800100, status: 'live' });
    insert(db, 'im_send_operation_keys', { sender_id: a, origin_epoch: epoch, client_message_id: client,
      storage_client_message_id: `v2:${epoch}:${client}`, source_protocol: 'a2a-msg.im.v2', message_id: message });
    insert(db, 'im_content_state', { message_id: message, state: 'live', expires_at: 7776000100, policy_hash: policyHash });
    insert(db, 'im_deliveries', { recipient_id: b, seq, message_id: message, acked_at: null, read_at: null });
  }
}
export function seedAnchor(db, { wall = 1000, head = true, epoch } = {}) {
  const identity = db.prepare('SELECT * FROM im_instance_identity').get();
  const tip = db.prepare('SELECT * FROM im_maintenance_time_anchors ORDER BY generation DESC LIMIT 1').get();
  const proposal = { version: 1, instanceId: identity.instance_id, instanceCreatedAt: identity.created_at,
    centerEpoch: epoch ?? db.prepare('SELECT center_epoch FROM im_center_state').get().center_epoch,
    previousGeneration: tip?.generation ?? null, previousAnchorHash: tip?.anchor_hash ?? null,
    sessionNonce: randomUUID(), proposedAt: wall, proposalExpiresAt: wall + 300000, candidateWallAt: wall,
    acceptNotBefore: wall, acceptNotAfter: wall + 5000, globalFloorObservedAt: 100, maxForwardJumpMs: 86400000 };
  const anchor = ordered(anchorFields, { ...proposal, generation: (tip?.generation ?? 0) + 1,
    proposalHash: digest('timeProposal', proposal), acceptedWallAt: wall, globalFloorAtApproval: 100,
    approvalRef: `historical-${(tip?.generation ?? 0) + 1}`, executorId: 'executor', approverId: 'approver' });
  const anchorHash = digest('anchorEvidence', anchor);
  insert(db, 'im_maintenance_time_anchors', { ...Object.fromEntries(Object.entries(anchor)
    .filter(([key]) => !['version', 'instanceId', 'instanceCreatedAt'].includes(key)).map(([key, value]) => [snake(key), value])), anchor_hash: anchorHash });
  if (head) insert(db, 'im_maintenance_time_head', { singleton: 1, center_epoch: anchor.centerEpoch, generation: anchor.generation, anchor_hash: anchorHash });
  db.prepare('UPDATE im_clock SET last_observed_at=?').run(wall);
  return { proposal, proposalHash: anchor.proposalHash, approvalRef: anchor.approvalRef, anchor, anchorHash };
}
export function createOwner({ history = false, crossEpoch = false, content = true, mode = 'paused', state = 'active' } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'im-time-owner-')); fs.chmodSync(dir, 0o700);
  const seedPath = join(dir, 'synthetic-seed.sqlite'), databasePath = join(dir, 'owned.sqlite');
  const db = new DatabaseSync(seedPath); let historic;
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0');
    for (const [, , , sql] of MANIFEST.filter(row => row[0] === 'table')) db.exec(sql);
    for (const [, , , sql] of MANIFEST.filter(row => row[0] === 'index')) db.exec(sql);
    const epoch = randomUUID(), instance = randomUUID(), prep = 'synthetic-preparation', p = policy();
    insert(db, 'im_schema', { version: 5, migration_checksum: GOLDEN.checksum });
    insert(db, 'im_settings', { singleton: 1, write_mode: mode });
    insert(db, 'im_clock', { singleton: 1, last_observed_at: 100 });
    insert(db, 'im_instance_identity', { singleton: 1, instance_id: instance, created_at: 1 });
    const policyHash = putPolicy(db, p);
    insert(db, 'im_center_epochs', { center_epoch: epoch, created_at: 1, origin: 'fresh', recovery_counter: 0 });
    insert(db, 'im_schema_preparations', { preparation_ref: prep, kind: 'fresh', input_hash: preparationHash('fresh', p, prep),
      source_version: null, source_schema_checksum: null, import_epoch: null, initial_epoch: epoch, policy_hash: policyHash, created_at: 1 });
    insert(db, 'im_center_state', { singleton: 1, center_epoch: epoch, recovery_counter: 0, status: 'prepared',
      activation_ref: null, recovery_run_id: null, updated_at: 10 });
    bindRun(db, recoveryRow(db, 'fresh_bootstrap', { status: state, created_at: 2,
      verified_at: state === 'prepared' ? null : 3, activated_at: state === 'active' ? 4 : null,
      activation_ref: state === 'active' ? 'synthetic-activation' : null,
      auth_review_ref: 'synthetic-auth-review', activation_plan_hash: state === 'active' ? sha('activation') : null,
      activation_approval_ref: state === 'active' ? 'synthetic-approval' : null }));
    const run = randomUUID();
    const plan = { version: 1, transitionId: randomUUID(), instanceId: instance, instanceCreatedAt: 1, centerEpoch: epoch,
      recoveryRunId: run, stageHash: sha('synthetic-stage'), candidateReference: `runs/${run}/candidate.sqlite`, candidateKind: 'fresh_bootstrap',
      preparationRef: prep, sourceEvidenceHash: null, fromVersion: 4, fromChecksum: V4, toVersion: 5, toChecksum: GOLDEN.checksum,
      preconversionFileHash: sha('synthetic-not-a-file-handoff'), executionPolicyHash: policyHash, createdAt: 5, expiresAt: 300005 };
    insert(db, 'im_center_schema_transitions', { ...Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'version')
      .map(([key, value]) => [key === 'createdAt' ? 'plan_created_at' : key === 'expiresAt' ? 'plan_expires_at' : snake(key), value])),
      approver_id: 'synthetic-reviewer', approved_plan_hash: recordHash('conversionPlan', plan), approval_ref: 'synthetic-conversion', executor_id: 'synthetic-builder', converted_at: 6 });
    if (content) addContent(db, epoch);
    if (history || crossEpoch) historic = seedAnchor(db, { head: !crossEpoch });
    if (crossEpoch) {
      const next = randomUUID();
      insert(db, 'im_center_epochs', { center_epoch: next, created_at: 1100, origin: 'recovery', recovery_counter: 1 });
      const row = recoveryRow(db, 'snapshot_recovery', { run_id: randomUUID(), preparation_ref: null, old_epoch: epoch, new_epoch: next,
        backup_id: randomUUID(), backup_file_hash: sha('backup'), manifest_hash: sha('manifest'), candidate_base_hash: sha('backup'),
        status: 'active', verified_at: 1101, activated_at: 1102, activation_ref: 'synthetic-second-activation',
        auth_review_ref: 'review', activation_plan_hash: sha('second'), activation_approval_ref: 'second-approval' });
      db.prepare('UPDATE im_center_state SET center_epoch=?,recovery_counter=1,updated_at=1102').run(next); bindRun(db, row);
      for (const r of db.prepare('SELECT * FROM im_sync_progress').all()) insert(db, 'im_sync_progress', { ...r, center_epoch: next });
      db.prepare('UPDATE im_clock SET last_observed_at=1102').run();
    }
    assert.equal(MANIFEST.length, 58);
    assertImSchemaV5Internal(db);
    assert.equal(db.prepare('SELECT count(*) n FROM im_center_schema_transitions').get().n, 1);
  } finally { db.close(); }
  assert.equal(db.isOpen, false, 'construction connection confirmed closed before handoff');
  fs.chmodSync(seedPath, 0o600); fs.copyFileSync(seedPath, databasePath); fs.chmodSync(databasePath, 0o600);
  const seedHash = sha(fs.readFileSync(seedPath)); let disposed = false;
  return { dir, seedPath, databasePath, historic, constructionClosed: !db.isOpen,
    seedUnchanged() { assert.equal(sha(fs.readFileSync(seedPath)), seedHash); },
    inspect() { const read = new DatabaseSync(databasePath, { readOnly: true }); try { return logicalImage(read); } finally { read.close(); } },
    // Only use before admission / after confirmed target close.
    arrange(callback) { const setup = new DatabaseSync(databasePath); try { setup.exec('PRAGMA foreign_keys=ON'); callback(setup); } finally { setup.close(); } },
    dispose() { if (!disposed) { this.seedUnchanged(); fs.rmSync(dir, { recursive: true, force: true }); disposed = true; } },
  };
}
