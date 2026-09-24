import { createHash } from 'node:crypto';
import { assertImSchema } from './schema.js';
import { fingerprintMessage, PROTOCOL } from './contracts.js';

const DEFAULT_MAX_FORWARD_JUMP_MS = 24 * 60 * 60 * 1000;
const DEFAULTS = Object.freeze({ maxCandidates: 10000, maxCandidateBytes: 100 * 1024 * 1024,
  maxScanRows: 10000, maxScanBytes: 100 * 1024 * 1024, maxRows: 100, maxBytes: 10 * 1024 * 1024 });
const fields = ['safeRetryWindowMs', 'attachmentRetentionMs', 'messageRetentionMs', 'idempotencyRetentionMs'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const empty = reason => ({ valid: false, complete: false, reason, subjects: [], candidates: [],
  totals: { count: 0, sizeBytes: 0, batches: [] }, protections: [] });
const stop = (reason, protection = reason) => ({ ...empty(reason), protections: [protection] });

function policyError(policy) {
  if (!plain(policy) || Object.keys(policy).some(key => !['version', 'enabled', 'writeMode', ...fields].includes(key)) ||
      !['version', 'enabled', 'writeMode', ...fields].every(key => Object.hasOwn(policy, key))) return 'POLICY_NOT_CONFIGURED';
  if (policy.version !== 1) return 'UNKNOWN_POLICY_VERSION';
  if (policy.enabled !== true || policy.writeMode !== 'enabled') return 'POLICY_INACTIVE';
  if (fields.some(key => !integer(policy[key], 1))) return 'INVALID_POLICY_DURATION';
  const { safeRetryWindowMs: retry, attachmentRetentionMs: attachment, messageRetentionMs: message, idempotencyRetentionMs: key } = policy;
  if (retry > attachment || attachment > message || message > key) return 'INVALID_POLICY_ORDER';
  return null;
}

// Reconstruct the sender's persisted metadata fingerprint; never synthesize a missing attachment.
function material(row) {
  if (!row.message_id || !row.key_message_id || row.key_message_id !== row.message_id ||
      row.sender_id !== row.key_sender_id || row.client_message_id !== row.key_client_message_id ||
      !integer(row.accepted_at) || !integer(row.key_created_at) || row.key_created_at !== row.accepted_at ||
      !integer(row.retry_until) || row.retry_until < row.accepted_at ||
      !integer(row.content_bytes) || !integer(row.attachment_bytes) ||
      (row.attachment_id !== null && (!integer(row.size, 1) || row.size !== row.attachment_bytes))) return false;
  const attachment = row.attachment_id === null ? null : {
    name: row.name, mime: row.mime, size: row.size, sha256: row.sha256,
  };
  const hash = fingerprintMessage({ protocol: PROTOCOL, conversationId: row.conversation_id,
    recipientAgentId: row.message_recipient_id, clientMessageId: row.client_message_id,
    title: row.title, text: row.text, attachment, inReplyTo: row.in_reply_to, correlation: row.correlation });
  if (hash !== row.payload_hash) return false;
  return true;
}

/** Advisory only. Requires a real synchronous SQLite connection and trusted pure callbacks. */
export function planImRetention({ db, policy, clock = Date.now, timeGuard, limits } = {}) {
  const badPolicy = policyError(policy);
  if (badPolicy) return empty(badPolicy);
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function' || db.isTransaction !== false ||
      typeof clock !== 'function' || clock.constructor?.name === 'AsyncFunction' ||
      (timeGuard !== undefined && (typeof timeGuard !== 'function' || timeGuard.constructor?.name === 'AsyncFunction')) ||
      (limits !== undefined && (!plain(limits) || Object.keys(limits).some(k => ![...Object.keys(DEFAULTS), 'maxForwardJumpMs', 'deepVerifyBytes'].includes(k)) ||
        Object.entries(limits).some(([k, v]) => k === 'deepVerifyBytes' ? typeof v !== 'boolean' : !integer(v, 1))))) return empty('INVALID_INPUT');
  let opened = false;
  try {
    db.exec('BEGIN'); opened = true;
    assertImSchema(db);
    const now = clock();
    const last = db.prepare('SELECT last_observed_at FROM im_clock WHERE singleton=1').get()?.last_observed_at;
    if (!integer(now) || !integer(last) || now < last || (timeGuard && timeGuard(now, last) !== true)) return empty('CLOCK_UNSAFE');
    if (now - last > (limits?.maxForwardJumpMs ?? DEFAULT_MAX_FORWARD_JUMP_MS)) return stop('FORWARD_CLOCK_JUMP');
    const maxScanRows = limits?.maxScanRows ?? DEFAULTS.maxScanRows;
    const states = db.prepare('SELECT agent_id,next_seq,acked_through,retained_floor FROM im_receive_state ORDER BY agent_id LIMIT ?').all(maxScanRows + 1);
    if (states.length > maxScanRows) return stop('SCAN_ROW_LIMIT');
    // The first pass projects only identifiers and lengths. Neither body nor BLOB is
    // materialized until all applicable scan limits have passed inside this snapshot.
    const probes = db.prepare(`SELECT d.recipient_id,d.seq,
      coalesce(length(CAST(m.title AS BLOB)),0)+coalesce(length(CAST(m.text AS BLOB)),0) AS content_bytes,
      coalesce(length(a.data),0) AS attachment_bytes
      FROM im_deliveries d LEFT JOIN im_messages m ON m.message_id=d.message_id AND m.recipient_id=d.recipient_id
      LEFT JOIN im_attachments a ON a.message_id=m.message_id
      ORDER BY d.recipient_id,d.seq LIMIT ?`).iterate(maxScanRows + 1);
    const rows = [];
    let scannedBytes = 0;
    for (const probe of probes) {
      if (rows.length >= maxScanRows) return stop('SCAN_ROW_LIMIT');
      scannedBytes += probe.content_bytes + probe.attachment_bytes;
      if (!integer(scannedBytes) || scannedBytes > (limits?.maxScanBytes ?? DEFAULTS.maxScanBytes)) return stop('SCAN_BYTE_LIMIT');
      rows.push(probe);
    }
    const detail = db.prepare(`SELECT d.recipient_id,d.seq,d.acked_at,d.message_id AS delivery_message_id,
      m.message_id,m.recipient_id AS message_recipient_id,m.conversation_id,m.sender_id,m.client_message_id,
      m.accepted_at,m.title,m.text,m.in_reply_to,m.correlation,
      k.message_id AS key_message_id,k.sender_id AS key_sender_id,k.client_message_id AS key_client_message_id,
      k.created_at AS key_created_at,k.retry_until,k.payload_hash,
      a.attachment_id,a.name,a.mime,a.size,a.sha256,
      coalesce(length(CAST(m.title AS BLOB)),0)+coalesce(length(CAST(m.text AS BLOB)),0) AS content_bytes,
      coalesce(length(a.data),0) AS attachment_bytes
      FROM im_deliveries d LEFT JOIN im_messages m ON m.message_id=d.message_id AND m.recipient_id=d.recipient_id
      LEFT JOIN im_send_keys k ON k.message_id=m.message_id
      LEFT JOIN im_attachments a ON a.message_id=m.message_id
      WHERE d.recipient_id=? AND d.seq=?`);
    const attachmentBytes = limits?.deepVerifyBytes ? db.prepare('SELECT data FROM im_attachments WHERE attachment_id=? AND message_id=?') : null;
    const subjects = [], candidates = [], groups = [], protections = [];
    let index = 0, sizeBytes = 0;
    for (const state of states) {
      const { agent_id: agentId, next_seq: nextSeq, acked_through: ackedThrough, retained_floor: retainedFloor } = state;
      if (![nextSeq, ackedThrough, retainedFloor].every(n => integer(n)) || retainedFloor < 1 ||
          retainedFloor > ackedThrough + 1 || ackedThrough + 1 > nextSeq) return empty('CURSOR_INVARIANT');
      const holds = [];
      if (index < rows.length && rows[index].recipient_id < agentId) return empty('ORPHAN_DELIVERY');
      let proposedFloor = retainedFloor, blocked = false, expected = retainedFloor;
      while (index < rows.length && rows[index].recipient_id === agentId) {
        const probe = rows[index++];
        const row = detail.get(probe.recipient_id, probe.seq);
        if (!row || row.content_bytes !== probe.content_bytes || row.attachment_bytes !== probe.attachment_bytes) return empty('MATERIAL_UNVERIFIED');
        if (!integer(row.seq, 1) || row.seq >= nextSeq) return empty('DELIVERY_GAP');
        if (row.seq < retainedFloor) continue;
        if (row.seq !== expected) return empty('DELIVERY_GAP');
        expected++;
        // Even un-ACKed rows must have verifiable material before any advisory plan is complete.
        if (!material(row) || row.message_recipient_id !== agentId ||
            row.delivery_message_id !== row.message_id) return empty('MATERIAL_UNVERIFIED');
        if (attachmentBytes && row.attachment_id !== null) {
          const raw = attachmentBytes.get(row.attachment_id, row.message_id)?.data;
          if (!(raw instanceof Uint8Array) || raw.byteLength !== row.size ||
              createHash('sha256').update(Buffer.from(raw)).digest('hex') !== row.sha256) return empty('MATERIAL_UNVERIFIED');
        }
        let reason;
        if (row.seq > ackedThrough || row.acked_at === null) reason = 'NOT_CONTIGUOUSLY_ACKED';
        else if (now <= row.retry_until) reason = 'RETRY_WINDOW';
        else if (now - row.accepted_at <= policy.messageRetentionMs) reason = 'MESSAGE_TTL';
        else if (row.attachment_id !== null && now - row.accepted_at <= policy.attachmentRetentionMs) reason = 'ATTACHMENT_TTL';
        else if (now - row.accepted_at <= policy.idempotencyRetentionMs) reason = 'IDEMPOTENCY_RETENTION';
        if (reason || blocked) { holds.push({ seq: row.seq, reason: reason ?? 'EARLIER_HOLD' }); blocked = true; continue; }
        const ageMs = now - row.accepted_at;
        const group = [
          { kind: 'delivery', id: `${agentId}:${row.seq}`, sizeBytes: 0, ageMs, reason: 'CONTIGUOUS_ACK_TTL_AND_RETRY_EXPIRED' },
          { kind: 'message', id: row.message_id, sizeBytes: row.content_bytes, ageMs, reason: 'CONTIGUOUS_ACK_TTL_AND_RETRY_EXPIRED' },
        ];
        if (row.attachment_id !== null) group.push({ kind: 'attachment', id: row.attachment_id, sizeBytes: row.size, ageMs, reason: 'REFERENCE_TTL_AND_RETRY_EXPIRED' });
        const bytes = group.reduce((sum, item) => sum + item.sizeBytes, 0);
        sizeBytes += bytes;
        if (!integer(sizeBytes) || sizeBytes > (limits?.maxCandidateBytes ?? DEFAULTS.maxCandidateBytes) ||
            candidates.length + group.length > (limits?.maxCandidates ?? DEFAULTS.maxCandidates)) return stop('CANDIDATE_LIMIT');
        groups.push({ messageId: row.message_id, agentId, seq: row.seq, count: group.length, sizeBytes: bytes });
        candidates.push(...group);
        proposedFloor = row.seq + 1;
      }
      if (expected !== nextSeq) return empty('DELIVERY_GAP');
      subjects.push({ agentId, ackedThrough, retainedFloor, nextSeq, proposedFloor, holds });
    }
    if (index !== rows.length) return empty('ORPHAN_DELIVERY');
    const batches = [];
    const maxRows = limits?.maxRows ?? DEFAULTS.maxRows, maxBytes = limits?.maxBytes ?? DEFAULTS.maxBytes;
    for (const group of groups) {
      if (group.count > maxRows || group.sizeBytes > maxBytes) {
        protections.push('OVERSIZED_GROUP');
        batches.push({ count: group.count, sizeBytes: group.sizeBytes, groups: [group], oversized: true });
        continue;
      }
      let batch = batches.at(-1);
      if (!batch || batch.oversized || batch.count + group.count > maxRows || batch.sizeBytes + group.sizeBytes > maxBytes) {
        batch = { count: 0, sizeBytes: 0, groups: [], oversized: false }; batches.push(batch);
      }
      batch.count += group.count; batch.sizeBytes += group.sizeBytes; batch.groups.push(group);
    }
    return { valid: true, complete: true, reason: null, subjects, candidates,
      totals: { count: candidates.length, sizeBytes, batches }, protections };
  } catch {
    return empty('STORAGE_OR_CLOCK_UNAVAILABLE');
  } finally {
    if (opened) {
      try { db.exec('ROLLBACK'); } catch { return empty('STORAGE_OR_CLOCK_UNAVAILABLE'); }
    }
  }
}
