import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { V4_DDL, V4_CHECKSUM } from '../../../src/im/v2/schema-internal.js';
import { DEFAULT_POLICY, DEFAULT_MAINTENANCE } from '../../../src/im/v2/config.js';
export const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
export const sha = value => createHash('sha256').update(value).digest('hex');
export const policy = { ...DEFAULT_POLICY, effectiveAt: 1 };
export const policyHash = sha(JSON.stringify(policy));
export function configuration(overrides = {}) {
  return { enabled: true, writeMode: 'paused', transport: { mode: 'local-test', serverUrl: 'http://127.0.0.1/' },
    retention: { policy: { ...policy }, policyHash }, lease: { ttlMs: 1000, renewalMs: 500 },
    limits: { maxAttachmentBytes: 10485760, maxBodyBytes: 65536, maxFileBodyBytes: 15000000, maxConnections: 1, maxRequestsPerMinute: 1 },
    maintenance: { ...DEFAULT_MAINTENANCE, maxKeyReservations: 1000 }, ...overrides };
}
export function insert(db, table, row) {
  db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
}
export function fixture(t, mode = 'paused') {
  const dir = fs.mkdtempSync(join(tmpdir(), 'retention-preview-'));
  fs.chmodSync(dir, 0o700);
  const databasePath = join(dir, 'candidate.db'), db = new DatabaseSync(databasePath);
  db.enableDefensive(false);
  db.exec('PRAGMA journal_mode=DELETE');
  for (const ddl of V4_DDL) db.exec(ddl);
  insert(db, 'im_schema', { version: 4, migration_checksum: V4_CHECKSUM });
  insert(db, 'im_settings', { singleton: 1, write_mode: mode });
  insert(db, 'im_clock', { singleton: 1, last_observed_at: 100 });
  insert(db, 'im_instance_identity', { singleton: 1, instance_id: id(1), created_at: 1 });
  insert(db, 'im_retention_policies', { policy_hash: policyHash, version: 2, effective_at: 1, message_retention_ms: 7776000000,
    attachment_retention_ms: 7776000000, safe_retry_window_ms: 604800000, audit_retention_ms: 15552000000, canonical_json: JSON.stringify(policy) });
  insert(db, 'im_center_epochs', { center_epoch: id(2), created_at: 1, origin: 'fresh', recovery_counter: 0 });
  insert(db, 'im_schema_preparations', { preparation_ref: 'fixture-preparation', kind: 'fresh',
    input_hash: sha(JSON.stringify(['fresh', null, null, policy, 'fixture-preparation'])), source_version: null,
    source_schema_checksum: null, import_epoch: null, initial_epoch: id(2), policy_hash: policyHash, created_at: 1 });
  insert(db, 'im_recovery_runs', { run_id: 'fixture-run', candidate_kind: 'fresh_bootstrap', preparation_ref: 'fixture-preparation',
    backup_id: null, backup_file_hash: null, manifest_hash: null, candidate_base_hash: null, candidate_reference: 'fixture-candidate',
    old_epoch: null, new_epoch: id(2), approved_plan_hash: sha('approval'), approval_ref: 'approval', isolation_ack_ref: null,
    rpo_report_json: null, auth_review_ref: 'review', activation_plan_hash: sha('activation'), activation_approval_ref: 'activation-approval',
    status: 'active', created_at: 1, verified_at: 2, activated_at: 3, activation_ref: 'activation', failure_code: null });
  insert(db, 'im_center_state', { singleton: 1, center_epoch: id(2), recovery_counter: 0, status: 'active',
    activation_ref: 'activation', recovery_run_id: 'fixture-run', updated_at: 3 });
  for (const n of [10, 11]) insert(db, 'im_agents', { agent_id: id(n), display_name: 'synthetic', status: 'active', created_at: 1 });
  insert(db, 'im_conversations', { conversation_id: id(12), agent_low: id(10), agent_high: id(11), created_at: 1 });
  insert(db, 'im_receive_state', { agent_id: id(11), stream_epoch: id(16) });
  insert(db, 'im_sync_progress', { recipient_id: id(11), center_epoch: id(2), stream_epoch: id(16), handled_through: 0, updated_at: 1 });
  fs.chmodSync(databasePath, 0o600);
  const beforeClose = [];
  t.after(() => { for (const fn of beforeClose) fn(); if (db.isOpen) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, databasePath, db, beforeClose };
}
export function content(f, n = 100, { expired = false, bytes = Buffer.from([0, 255, 195, 169]), text = '字é', title = null, correlation = '', keyStatus, attachment = true } = {}) {
  const { db } = f, messageId = id(n), wire = id(n + 1000), storage = `v2:${id(2)}:${wire}`, attachmentId = id(n + 2000);
  const metadata = attachment ? ['秘密é.bin', null, bytes.length, sha(bytes)] : null;
  insert(db, 'im_messages', { message_id: messageId, conversation_id: id(12), sender_id: id(10), recipient_id: id(11),
    client_message_id: storage, accepted_at: 100, in_reply_to: null, title, text, correlation });
  if (attachment) {
    insert(db, 'im_attachment_reservations', { attachment_id: attachmentId, message_id: messageId, size: bytes.length, sha256: sha(bytes) });
    insert(db, 'im_attachments', { attachment_id: attachmentId, message_id: messageId, name: metadata[0], mime: metadata[1], size: bytes.length, sha256: sha(bytes), data: bytes });
  }
  insert(db, 'im_send_keys', { sender_id: id(10), client_message_id: storage, payload_hash: sha(JSON.stringify(['a2a-msg.im.v2', id(2), id(12), id(11), wire, title, text, metadata, null, correlation])),
    message_id: messageId, created_at: 100, retry_until: 604800100, status: keyStatus ?? (expired ? 'expired' : 'live') });
  insert(db, 'im_send_operation_keys', { sender_id: id(10), origin_epoch: id(2), client_message_id: wire, storage_client_message_id: storage, source_protocol: 'a2a-msg.im.v2', message_id: messageId });
  if (expired && !db.prepare("SELECT 1 FROM im_maintenance_runs WHERE run_id='fixture-expire'").get()) {
    insert(db, 'im_maintenance_runs', { run_id: 'fixture-expire', center_epoch: id(2), kind: 'expire', execution_policy_hash: policyHash,
      plan_hash: sha('expire'), approved_batch_hash: sha('batch'), approval_ref: 'approval', executor_id: 'fixture', status: 'completed',
      candidate_json: '[]', result_json: '{}', previewed_at: 7776000100, expires_at: 7776000200, completed_at: 7776000100,
      scan_rows: 1, scan_bytes: 1, changed_rows: 1, changed_bytes: 0 });
  }
  insert(db, 'im_content_state', { message_id: messageId, state: expired ? 'expired' : 'live', expires_at: 7776000100,
    expired_at: expired ? 7776000100 : null, scrubbed_at: null, policy_hash: policyHash, expiry_run_id: expired ? 'fixture-expire' : null, scrub_run_id: null });
  const seq = db.prepare('SELECT next_seq FROM im_receive_state').get().next_seq;
  insert(db, 'im_deliveries', { recipient_id: id(11), seq, message_id: messageId, acked_at: 101, read_at: 102 });
  db.prepare('UPDATE im_receive_state SET next_seq=?,acked_through=?').run(seq + 1, seq);
  db.prepare('UPDATE im_sync_progress SET handled_through=?').run(seq);
  return messageId;
}
export function audit(f, id, action = 'conversation.created', time = 100, details = '{"字":"é"}') {
  insert(f.db, 'im_audit', { id, actor_kind: 'system', actor_id: 'private-actor', action, target_ids_json: '[]', occurred_at: time, safe_details_json: details });
}

// Independent literal recursive frame oracle, not imported from product helpers.
export function F(v) {
  if (v === null) return Buffer.from('n;');
  if (typeof v === 'boolean') return Buffer.from(v ? 'b1;' : 'b0;');
  if (typeof v === 'number') return Buffer.from('i' + v + ';');
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('a' + v.length + ':'), ...v.map(F)]);
  const b = typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v);
  return Buffer.concat([Buffer.from((typeof v === 'string' ? 's' : 'x') + b.length + ':'), b]);
}
export const H = (tag, value) => sha(Buffer.concat([Buffer.from(tag), Buffer.from([0]), F(value)]));
const T = x => x === null ? null : [Buffer.byteLength(x), H('a2a-msg.im.maintenance.text.v1', x)];
export function messageDescriptor(db, id) {
  const get = table => db.prepare(`SELECT * FROM ${table} WHERE message_id=?`).get(id) ?? null;
  const m = get('im_messages'), c = get('im_content_state'), k = get('im_send_keys'), o = get('im_send_operation_keys');
  const r = get('im_attachment_reservations'), a = get('im_attachments'), d = get('im_deliveries');
  const p = db.prepare('SELECT * FROM im_retention_policies WHERE policy_hash=?').get(c.policy_hash);
  const v = db.prepare('SELECT * FROM im_conversations WHERE conversation_id=?').get(m.conversation_id);
  return [1, 'message-group',
    [m.message_id, m.conversation_id, m.sender_id, m.recipient_id, m.client_message_id, m.accepted_at, m.in_reply_to, T(m.title), T(m.text), T(m.correlation)],
    [c.message_id, c.state, c.expires_at, c.expired_at, c.scrubbed_at, c.policy_hash, T(c.expiry_run_id), T(c.scrub_run_id)],
    [p.policy_hash, p.version, p.effective_at, p.message_retention_ms, p.attachment_retention_ms, p.safe_retry_window_ms, p.audit_retention_ms, T(p.canonical_json)],
    [k.sender_id, k.client_message_id, k.payload_hash, k.message_id, k.created_at, k.retry_until, k.status],
    [o.sender_id, o.origin_epoch, o.client_message_id, o.storage_client_message_id, o.source_protocol, o.message_id],
    r && [r.attachment_id, r.message_id, r.size, r.sha256],
    a && [a.attachment_id, a.message_id, T(a.name), T(a.mime), a.size, a.sha256, [a.data.length, H('a2a-msg.im.maintenance.blob.v1', a.data), sha(a.data)]],
    [d.recipient_id, d.seq, d.message_id, d.acked_at, d.read_at], [v.conversation_id, v.agent_low, v.agent_high, v.created_at]];
}
export const messageOracle = (db, id) => H('a2a-msg.im.maintenance.message.v1', messageDescriptor(db, id));
export function auditDescriptor(db, id) {
  const a = db.prepare('SELECT * FROM im_audit WHERE id=?').get(id);
  return [1, 'audit-row', a.id, T(a.actor_kind), T(a.actor_id), T(a.action), T(a.target_ids_json), a.occurred_at, T(a.safe_details_json)];
}
export const auditOracle = (db, id) => H('a2a-msg.im.maintenance.audit.v1', auditDescriptor(db, id));
