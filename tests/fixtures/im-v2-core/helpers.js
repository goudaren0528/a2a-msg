// TEST ONLY: isolated lawful SQL candidate, not recovery/activation implementation.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { initializeImSchemaV4 } from '../../../src/im/v2/migration.js';
import { assertImSchemaV4 } from '../../../src/im/v2/schema.js';
import { createImV2Auth } from '../../../src/im/v2/auth.js';
import { createImV2Acl } from '../../../src/im/v2/acl.js';
import { DEFAULT_POLICY, DEFAULT_MAINTENANCE } from '../../../src/im/v2/config.js';
import { PROTOCOL, fingerprintMessage, storageOperationKey } from '../../../src/im/v2/contracts.js';
import { database, freshOptions, insert, recoveryRow, bindRun, observe, putPolicy } from '../im-v2-schema/helpers.js';

// TEST ONLY proof rows; unique per operation and phase, never an activation or purge authority.
function maintenanceProof(f, kind, messageId) {
  const id = `fixture-${kind}-${randomUUID()}`;
  const sha = value => createHash('sha256').update(value).digest('hex');
  insert(f.native, 'im_maintenance_runs', { run_id: id, center_epoch: f.centerEpoch, kind,
    execution_policy_hash: f.hash, plan_hash: sha(id), approved_batch_hash: sha(`${id}:${messageId}:batch`),
    approval_ref: `test-approval-${id}`, executor_id: 'test-only', status: 'completed',
    candidate_json: JSON.stringify([{ messageId }]), result_json: JSON.stringify({ messageId, kind }),
    previewed_at: 7776000010, expires_at: 7776000020, completed_at: 7776000010,
    scan_rows: 1, scan_bytes: 1, changed_rows: 1, changed_bytes: 1 });
  return id;
}

export function createCoreFixture(t, { onStatement } = {}) {
  const native = database(t);
  native.exec('PRAGMA synchronous=FULL');
  initializeImSchemaV4(native, freshOptions());
  const p = { ...DEFAULT_POLICY, effectiveAt: 1 }, hash = putPolicy(native, p);
  const run = recoveryRow(native, 'fresh_bootstrap', { status: 'active', verified_at: 101,
    activated_at: 102, activation_ref: 'test-activation', auth_review_ref: 'test-auth-review',
    activation_plan_hash: 'a'.repeat(64), activation_approval_ref: 'test-activation-approval' });
  bindRun(native, run);
  native.prepare("UPDATE im_settings SET write_mode='enabled'").run();
  const centerEpoch = run.new_epoch, scope = { protocol: PROTOCOL, centerEpoch };
  const agents = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, agent] of agents.entries()) {
    insert(native, 'im_agents', { agent_id: agent, display_name: `Test ${index}`, status: 'active',
      created_at: 0, revoked_at: null });
    const streamEpoch = randomUUID();
    insert(native, 'im_receive_state', { agent_id: agent, next_seq: 1, acked_through: 0,
      retained_floor: 1, stream_epoch: streamEpoch });
    insert(native, 'im_sync_progress', { recipient_id: agent, center_epoch: centerEpoch,
      stream_epoch: streamEpoch, handled_through: 0, updated_at: 0 });
  }
  const [a, b, outsider] = agents, [agentLow, agentHigh] = [a,b].sort();
  insert(native, 'im_contacts', { agent_low: agentLow, agent_high: agentHigh, allowed: 1,
    version: 1, updated_at: 0 });
  const conversationId = randomUUID();
  insert(native, 'im_conversations', { conversation_id: conversationId, agent_low: agentLow,
    agent_high: agentHigh, created_at: 0 });
  const credentials = agents.map(agent => {
    const credentialId = randomUUID(), secret = randomBytes(32).toString('base64url');
    insert(native, 'im_credentials', { credential_id: credentialId, agent_id: agent,
      secret_hash: createHash('sha256').update(secret).digest('hex'), created_at: 0,
      expires_at: null, revoked_at: null });
    return `${credentialId}.${secret}`;
  });
  assert.equal(assertImSchemaV4(native), true);
  const db = onStatement ? observe(native, onStatement) : native;
  const policy = { enabled: true, writeMode: 'enabled', transport: { mode: 'local-test', serverUrl: 'http://localhost/' },
    retention: { policy: p, policyHash: hash }, lease: { ttlMs: 1000, renewalMs: 500 },
    limits: { maxAttachmentBytes: 10485760, maxBodyBytes: 65536, maxFileBodyBytes: 16777216,
      maxConnections: 10, maxRequestsPerMinute: 100 },
    maintenance: { ...DEFAULT_MAINTENANCE, maxKeyReservations: 1000 } };
  const clock = () => 103;
  const auth = createImV2Auth({ db, policy, clock });
  const acl = createImV2Acl({ db, auth, clock });
  const principals = credentials.map(credential => auth.authenticate(credential));
  return { db, native, scope, auth, acl, policy, clock, principals, credentials,
    a, b, outsider, conversationId, centerEpoch, hash };
}

export function seedMessage(f, { protocol = PROTOCOL, attachment = false, text = 'test message',
  title = null, correlation = null, deliveredAt = null, readAt = null } = {}) {
  const db = f.native, messageId = randomUUID(), clientMessageId = randomUUID();
  const originEpoch = protocol === PROTOCOL ? f.centerEpoch : randomUUID();
  if (protocol !== PROTOCOL) insert(db, 'im_center_epochs', { center_epoch: originEpoch, created_at: 0,
    origin: 'v3_import', recovery_counter: 0 });
  const key = protocol === PROTOCOL ? storageOperationKey(originEpoch, clientMessageId) : clientMessageId;
  const acceptedAt = 10, expiresAt = acceptedAt + 7776000000;
  const bytes = attachment ? Buffer.from('test attachment bytes') : null;
  const attachmentId = bytes ? randomUUID() : null;
  const sha256 = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
  insert(db, 'im_messages', { message_id: messageId, conversation_id: f.conversationId,
    sender_id: f.a, recipient_id: f.b, client_message_id: key, title, text,
    in_reply_to: null, correlation, accepted_at: acceptedAt });
  if (bytes) {
    insert(db, 'im_attachments', { attachment_id: attachmentId, message_id: messageId,
      name: 'test.txt', mime: 'text/plain', size: bytes.length, sha256, data: bytes });
    insert(db, 'im_attachment_reservations', { attachment_id: attachmentId, message_id: messageId,
      size: bytes.length, sha256 });
  }
  const attachmentMeta = bytes && { name: 'test.txt', mime: 'text/plain', size: bytes.length, sha256, bytes };
  const fingerprint = protocol === PROTOCOL ? fingerprintMessage({ protocol: PROTOCOL,
    centerEpoch: originEpoch, originEpoch, clientMessageId, conversationId: f.conversationId,
    recipientAgentId: f.b, title, text, attachment: attachmentMeta,
    inReplyTo: null, correlation }) : createHash('sha256').update(JSON.stringify([
    protocol, f.conversationId, f.b, clientMessageId, title, text,
    attachmentMeta && [attachmentMeta.name,attachmentMeta.mime,attachmentMeta.size,attachmentMeta.sha256],
    null,correlation])).digest('hex');
  insert(db, 'im_send_keys', { sender_id: f.a, client_message_id: key, payload_hash: fingerprint,
    message_id: messageId, created_at: acceptedAt, retry_until: acceptedAt + 604800000, status: 'live' });
  insert(db, 'im_send_operation_keys', { sender_id: f.a, origin_epoch: originEpoch,
    client_message_id: clientMessageId, storage_client_message_id: key, source_protocol: protocol,
    message_id: messageId });
  insert(db, 'im_content_state', { message_id: messageId, state: 'live', expires_at: expiresAt,
    expired_at: null, scrubbed_at: null, policy_hash: f.hash, expiry_run_id: null, scrub_run_id: null });
  const state = db.prepare('SELECT next_seq FROM im_receive_state WHERE agent_id=?').get(f.b);
  insert(db, 'im_deliveries', { recipient_id: f.b, seq: state.next_seq, message_id: messageId,
    acked_at: deliveredAt, read_at: readAt });
  const receive = db.prepare('SELECT acked_through FROM im_receive_state WHERE agent_id=?').get(f.b);
  db.prepare('UPDATE im_receive_state SET next_seq=?,acked_through=? WHERE agent_id=?')
    .run(state.next_seq + 1, deliveredAt !== null && receive.acked_through === state.next_seq - 1
      ? state.next_seq : receive.acked_through, f.b);
  const currentStream = db.prepare('SELECT stream_epoch FROM im_receive_state WHERE agent_id=?').get(f.b).stream_epoch;
  const progress = db.prepare(`SELECT handled_through FROM im_sync_progress
    WHERE recipient_id=? AND center_epoch=? AND stream_epoch=?`).get(f.b, f.centerEpoch, currentStream);
  assert.ok(progress, 'fixture requires current-epoch/current-stream progress');
  let handled = progress.handled_through;
  const next = db.prepare(`SELECT d.message_id,d.acked_at,c.state,e.message_id AS receipt_message
    FROM im_deliveries d JOIN im_content_state c ON c.message_id=d.message_id
    LEFT JOIN im_expiry_receipts e ON e.recipient_id=d.recipient_id AND e.seq=d.seq
      AND e.center_epoch=? AND e.stream_epoch=?
    WHERE d.recipient_id=? AND d.seq=?`);
  while (handled < state.next_seq) {
    const item = next.get(f.centerEpoch, currentStream, f.b, handled + 1);
    if (!item || (item.acked_at === null && !(item.state === 'expired' &&
        item.receipt_message === item.message_id))) break;
    handled++;
  }
  db.prepare(`UPDATE im_sync_progress SET handled_through=?
    WHERE recipient_id=? AND center_epoch=? AND stream_epoch=?`)
    .run(handled, f.b, f.centerEpoch, currentStream);
  assert.equal(assertImSchemaV4(db), true);
  return { messageId, clientMessageId, originEpoch, attachmentId, acceptedAt, expiresAt,
    fingerprint, bytes, sha256, storageKey: key };
}

export function expireFixtureContent(f, seeded, { scrub = false } = {}) {
  const db = f.native;
  const expiryRun = maintenanceProof(f, 'expire', seeded.messageId);
  const expiredAt = seeded.expiresAt + 1;
  db.prepare("UPDATE im_content_state SET state='expired',expired_at=?,expiry_run_id=? WHERE message_id=?")
    .run(expiredAt, expiryRun, seeded.messageId);
  if (scrub) {
    const scrubRun = maintenanceProof(f, 'scrub', seeded.messageId);
    db.prepare('UPDATE im_messages SET text=?,title=NULL,correlation=NULL WHERE message_id=?').run('', seeded.messageId);
    db.prepare('DELETE FROM im_attachments WHERE message_id=?').run(seeded.messageId);
    db.prepare('UPDATE im_content_state SET scrubbed_at=?,scrub_run_id=? WHERE message_id=?')
      .run(expiredAt + 1, scrubRun, seeded.messageId);
  }
  assert.equal(assertImSchemaV4(db), true);
  return expiredAt;
}
