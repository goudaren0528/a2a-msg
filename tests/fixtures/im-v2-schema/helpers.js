// Test-owned builders. No v4 internals: historical DDL and fingerprint are independent oracles.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fingerprintMessage } from '../../../src/im/contracts.js';

export const sha = value => createHash('sha256').update(value).digest('hex');
export const golden = JSON.parse(readFileSync(new URL('./checksums.json', import.meta.url), 'utf8'));
export const v3Manifest = JSON.parse(readFileSync(new URL('./v3-manifest.json', import.meta.url), 'utf8'));
export const policy = () => ({ version: 2, effectiveAt: 0, messageRetentionMs: 7776000000,
  attachmentRetentionMs: 7776000000, safeRetryWindowMs: 604800000, auditRetentionMs: 15552000000,
  keyReservation: 'indefinite', expiryEnabled: false, purgeEnabled: false,
  backupCleanupEnabled: false, backupRetentionMs: null });
export const importOptions = (overrides = {}) => ({ expectedVersion: 3, migrationRef: 'import-fixture', policy: policy(), ...overrides });
export const freshOptions = (overrides = {}) => ({ creationRef: 'fresh-fixture', policy: policy(), ...overrides });
export const mismatch = { code: 'IM_SCHEMA_MISMATCH' };
export const budgetError = { code: 'IM_V2_BUDGET_EXCEEDED' };
export const normalize = sql => sql.trim().replace(/\s+/g, ' ');
export function manifest(db) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE (name LIKE 'im_%' OR tbl_name LIKE 'im_%') AND name NOT LIKE 'sqlite_autoindex_%'")
    .all().map(r => [r.type, r.name, r.tbl_name, normalize(r.sql)]).sort((a, b) => a[1].localeCompare(b[1]));
}
export function database(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  return db;
}
export function insert(db, table, row) {
  const columns = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
}
export function snapshot(db) {
  const schema = manifest(db);
  const rows = Object.fromEntries(schema.filter(r => r[0] === 'table').map(([, name]) => [name,
    db.prepare(`SELECT * FROM ${name}`).all().map(r => JSON.stringify(r, (_, v) => v instanceof Uint8Array ? [...v] : v)).sort()]));
  return { schema, rows };
}
export function legacy(t, { messages = 1, attachment = true, acks = [true], leases = false } = {}) {
  const db = database(t);
  for (const [, , , sql] of v3Manifest.filter(r => r[0] === 'table')) db.exec(sql);
  for (const [, , , sql] of v3Manifest.filter(r => r[0] === 'index')) db.exec(sql);
  insert(db, 'im_schema', { version: 3, migration_checksum: golden.v3 });
  insert(db, 'im_settings', { singleton: 1, write_mode: 'paused' });
  insert(db, 'im_clock', { singleton: 1, last_observed_at: 0 });
  const f = { db, a: randomUUID(), b: randomUUID(), c: randomUUID(), conversation: randomUUID(),
    credential: randomUUID(), receiverCredential: randomUUID(), stream: randomUUID(), instanceId: randomUUID(), messages: [] };
  insert(db, 'im_instance_identity', { singleton: 1, instance_id: f.instanceId, created_at: 10 });
  for (const [id, name] of [[f.a, 'Alice'], [f.b, 'Bob'], [f.c, 'Charlie']])
    insert(db, 'im_agents', { agent_id: id, display_name: name, status: 'active', created_at: 0, revoked_at: null });
  for (const [credential, agent] of [[f.credential, f.a], [f.receiverCredential, f.b]])
    insert(db, 'im_credentials', { credential_id: credential, agent_id: agent, secret_hash: 'synthetic-fixture', created_at: 0 });
  const [low, high] = [f.a, f.b].sort();
  insert(db, 'im_conversations', { conversation_id: f.conversation, agent_low: low, agent_high: high, created_at: 0 });
  insert(db, 'im_contacts', { agent_low: low, agent_high: high, allowed: 1, version: 1, updated_at: 0 });
  insert(db, 'im_receive_state', { agent_id: f.b, stream_epoch: f.stream });
  for (let i = 0; i < messages; i++) addMessage(f, { attachment: attachment && i === 0, ack: acks[i] ?? false });
  if (leases) addLease(f);
  return f;
}
export function addMessage(f, { attachment = false, ack = false, conversation = f.conversation,
  sender = f.a, recipient = f.b, text = 'text', title = 'title', correlation = null, reply = null } = {}) {
  const { db } = f;
  const row = { message_id: randomUUID(), conversation_id: conversation, sender_id: sender, recipient_id: recipient,
    client_message_id: randomUUID(), title, text, in_reply_to: reply, correlation, accepted_at: 100 };
  insert(db, 'im_messages', row);
  if (attachment) {
    const bytes = Buffer.from('fixture attachment');
    insert(db, 'im_attachments', { attachment_id: randomUUID(), message_id: row.message_id, name: 'file.txt',
      mime: 'text/plain', size: bytes.length, sha256: sha(bytes), data: bytes });
  }
  insert(db, 'im_send_keys', { sender_id: sender, client_message_id: row.client_message_id, payload_hash: messageHash(db, row.message_id),
    message_id: row.message_id, created_at: 100, retry_until: 604800100, status: 'live' });
  const state = db.prepare('SELECT * FROM im_receive_state WHERE agent_id=?').get(recipient);
  assert.ok(state, 'builder requires a real receive state');
  insert(db, 'im_deliveries', { recipient_id: recipient, seq: state.next_seq, message_id: row.message_id,
    acked_at: ack ? 100 : null, read_at: ack ? 100 : null });
  db.prepare('UPDATE im_receive_state SET next_seq=?,acked_through=? WHERE agent_id=?')
    .run(state.next_seq + 1, ack && state.acked_through === state.next_seq - 1 ? state.next_seq : state.acked_through, recipient);
  f.messages.push(row.message_id);
  return row.message_id;
}
export function messageHash(db, id) {
  const m = db.prepare('SELECT * FROM im_messages WHERE message_id=?').get(id);
  const a = db.prepare('SELECT name,mime,size,sha256 FROM im_attachments WHERE message_id=?').get(id);
  return fingerprintMessage({ protocol: 'a2a-msg.im.v1', conversationId: m.conversation_id, recipientAgentId: m.recipient_id,
    clientMessageId: m.client_message_id, title: m.title, text: m.text, attachment: a ?? null, inReplyTo: m.in_reply_to, correlation: m.correlation });
}
export function rehash(db, id) { db.prepare('UPDATE im_send_keys SET payload_hash=? WHERE message_id=?').run(messageHash(db, id), id); }
export function addLease(f) {
  const instance = randomUUID();
  const result = { instanceId: instance, generation: 1, expiresAt: 1000, historical: false };
  insert(f.db, 'im_receiver_leases', { agent_id: f.b, instance_id: instance, generation: 1, expires_at: 1000, credential_id: f.receiverCredential });
  insert(f.db, 'im_lease_requests', { agent_id: f.b, request_id: randomUUID(), request_hash: sha(JSON.stringify([instance, f.receiverCredential])),
    instance_id: instance, generation: 1, result_json: JSON.stringify(result) });
  return result;
}
// Delegates every operation to native SQLite; hooks observe AFTER actual execution (including writes).
export function observe(db, after) {
  return new Proxy(db, { get(target, key) {
    if (key === 'exec') return sql => { const result = target.exec(sql); after({ sql, method: 'exec', result }); return result; };
    if (key === 'prepare') return sql => {
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(s, method) {
        if (method === 'iterate') return function* (...args) {
          for (const row of s.iterate(...args)) { after({ sql, method, result: row }); yield row; }
          after({ sql, method: 'iterate:end' });
        };
        if (['get', 'all', 'run'].includes(method)) return (...args) => {
          const result = s[method](...args); after({ sql, method, result }); return result;
        };
        return typeof s[method] === 'function' ? s[method].bind(s) : s[method];
      } });
    };
    return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
  } });
}
export function putPolicy(db, p) {
  const hash = sha(JSON.stringify(p));
  insert(db, 'im_retention_policies', { policy_hash: hash, version: 2, effective_at: p.effectiveAt,
    message_retention_ms: p.messageRetentionMs, attachment_retention_ms: p.attachmentRetentionMs,
    safe_retry_window_ms: p.safeRetryWindowMs, audit_retention_ms: p.auditRetentionMs, canonical_json: JSON.stringify(p) });
  return hash;
}
export function preparationHash(kind, p, ref) {
  return sha(JSON.stringify([kind, kind === 'fresh' ? null : 3, kind === 'fresh' ? null : golden.v3, p, ref]));
}
// SQL fixtures only: deliberately no P5 recovery/activation API implementation.
export function recoveryRow(db, candidateKind, overrides = {}) {
  const prep = db.prepare('SELECT * FROM im_schema_preparations').get();
  return { run_id: 'run-fixture', candidate_kind: candidateKind, preparation_ref: prep.preparation_ref,
    backup_id: null, backup_file_hash: null, manifest_hash: null, candidate_base_hash: null,
    candidate_reference: 'candidate-fixture', old_epoch: null, new_epoch: prep.initial_epoch,
    approved_plan_hash: 'a'.repeat(64), approval_ref: 'prepare-approval',
    isolation_ack_ref: candidateKind === 'fresh_bootstrap' ? null : 'isolation',
    rpo_report_json: candidateKind === 'fresh_bootstrap' ? null : JSON.stringify({ status: 'unknown', snapshotCompletedAt: null,
      sourceObservedAt: null, missingAcceptedCount: null, missingAckCount: null, missingReadCount: null,
      comparisonEvidenceHash: null, authChanges: 'unknown', notesCode: 'SOURCE_UNAVAILABLE' }),
    auth_review_ref: null, activation_plan_hash: null, activation_approval_ref: null, status: 'prepared',
    created_at: 100, verified_at: null, activated_at: null, activation_ref: null, failure_code: null, ...overrides };
}
export function bindRun(db, row) {
  insert(db, 'im_recovery_runs', row);
  db.prepare('UPDATE im_center_state SET recovery_run_id=?,status=?,activation_ref=?').run(row.run_id,
    row.status === 'failed' ? 'prepared' : row.status, row.activation_ref);
}
export function maintenance(db, kind) {
  const center = db.prepare('SELECT center_epoch FROM im_center_state').get();
  const prep = db.prepare('SELECT policy_hash FROM im_schema_preparations').get();
  const id = `maintenance-${kind}`;
  insert(db, 'im_maintenance_runs', { run_id: id, center_epoch: center.center_epoch, kind,
    execution_policy_hash: prep.policy_hash, plan_hash: sha(id), approved_batch_hash: sha(id + '-batch'),
    approval_ref: 'approval', executor_id: 'fixture', status: 'completed', candidate_json: '[]', result_json: '{}',
    previewed_at: 7776000100, expires_at: 7776000200, completed_at: 7776000100,
    scan_rows: 1, scan_bytes: 1, changed_rows: 1, changed_bytes: 1 });
  return id;
}
