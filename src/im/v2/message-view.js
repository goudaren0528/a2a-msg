import { ImV2Error, attachmentSchema, historyItemSchema, messageSchema, storageOperationKey } from './contracts.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;

// Internal projection only. An active SQLite transaction is a misuse check, NOT
// authentication or authorization. Callers must check scoped auth and resource ACL
// within that same transaction before invoking either method.
export function createImV2MessageView({ db } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new ImV2Error('INVALID_REQUEST');
  const statements = [
    `SELECT message_id,conversation_id,sender_id,recipient_id,client_message_id,title,text,
      in_reply_to,correlation,accepted_at FROM im_messages WHERE message_id=?`,
    `SELECT message_id,state,expires_at,expired_at,scrubbed_at,policy_hash,expiry_run_id,scrub_run_id
      FROM im_content_state WHERE message_id=?`,
    `SELECT sender_id,origin_epoch,client_message_id,storage_client_message_id,source_protocol,message_id
      FROM im_send_operation_keys WHERE message_id=?`,
    `SELECT sender_id,client_message_id,message_id,created_at,retry_until,payload_hash,status
      FROM im_send_keys WHERE message_id=?`,
    `SELECT recipient_id,seq,message_id,acked_at,read_at FROM im_deliveries WHERE message_id=?`,
    `SELECT attachment_id,message_id,size,sha256 FROM im_attachment_reservations WHERE message_id=?`,
    `SELECT attachment_id,message_id,name,mime,size,sha256 FROM im_attachments WHERE message_id=?`,
  ];
  let queries;
  try { queries = statements.map(sql => db.prepare(sql)); }
  catch { throw new ImV2Error('STORAGE_UNAVAILABLE'); }
  const unavailable = () => { throw new ImV2Error('STORAGE_UNAVAILABLE'); };
  function row(index, id) {
    try { return queries[index].get(id); } catch { unavailable(); }
  }
  function project(id) {
    if (db.isTransaction !== true) throw new ImV2Error('INVALID_REQUEST');
    if (typeof id !== 'string') unavailable();
    const m = row(0, id), c = row(1, id), op = row(2, id), key = row(3, id), d = row(4, id);
    if (!m || !c || !op || !key || !d || m.message_id !== id || c.message_id !== id ||
        op.message_id !== id || key.message_id !== id || d.message_id !== id ||
        op.sender_id !== m.sender_id || key.sender_id !== m.sender_id ||
        op.storage_client_message_id !== m.client_message_id || key.client_message_id !== m.client_message_id ||
        key.created_at !== m.accepted_at || !Number.isSafeInteger(key.retry_until) ||
        key.retry_until < key.created_at || !/^[0-9a-f]{64}$/.test(key.payload_hash) ||
        d.recipient_id !== m.recipient_id ||
        !Number.isSafeInteger(d.seq) || d.seq < 1 ||
        (d.read_at !== null && (d.acked_at === null || d.read_at < d.acked_at)) ||
        !['a2a-msg.im.v1','a2a-msg.im.v2'].includes(op.source_protocol) ||
        (op.source_protocol === 'a2a-msg.im.v1' && op.storage_client_message_id !== op.client_message_id) ||
        (op.source_protocol === 'a2a-msg.im.v2' &&
          op.storage_client_message_id !== `v2:${op.origin_epoch}:${op.client_message_id}`)) unavailable();
    // Validate the wire mapping, never derive a wire ID from the storage key.
    try { storageOperationKey(op.origin_epoch, op.client_message_id); } catch { unavailable(); }
    if (!Number.isSafeInteger(c.expires_at) || c.expires_at < m.accepted_at ||
        !hex.test(c.policy_hash)) unavailable();
    const reservation = row(5, id), payload = row(6, id);
    // The reservation is retained even after scrub; its immutable identity and
    // evidence must be valid independently of whether payload still exists.
    if (reservation && (reservation.message_id !== id || !uuid.test(reservation.attachment_id) ||
        !Number.isSafeInteger(reservation.size) || reservation.size < 1 || reservation.size > 10485760 ||
        !hex.test(reservation.sha256))) unavailable();
    if (payload && (payload.message_id !== id || !reservation ||
        payload.attachment_id !== reservation.attachment_id || payload.size !== reservation.size ||
        payload.sha256 !== reservation.sha256)) unavailable();
    const attachment = payload ? { attachmentId: payload.attachment_id, name: payload.name,
      mime: payload.mime, size: reservation.size, sha256: reservation.sha256 } : null;
    if (attachment && !attachmentSchema.safeParse(attachment).success) unavailable();
    const dto = { messageId: m.message_id, conversationId: m.conversation_id,
      senderAgentId: m.sender_id, recipientAgentId: m.recipient_id,
      originEpoch: op.origin_epoch, clientMessageId: op.client_message_id,
      title: m.title, text: m.text, inReplyTo: m.in_reply_to, correlation: m.correlation,
      acceptedAt: m.accepted_at, expiresAt: c.expires_at,
      deliveredAt: d.acked_at, readAt: d.read_at, attachment };
    if (c.state === 'expired') {
      if (c.expired_at === null || c.expiry_run_id === null || c.expired_at < c.expires_at ||
          (c.scrubbed_at === null) !== (c.scrub_run_id === null) ||
          (c.scrubbed_at !== null && c.scrubbed_at < c.expired_at)) unavailable();
      if (c.scrubbed_at !== null) {
        if (m.text !== '' || m.title !== null || m.correlation !== null || payload ||
            !uuid.test(m.sender_id) || !uuid.test(m.recipient_id) ||
            (m.in_reply_to !== null && !uuid.test(m.in_reply_to))) unavailable();
      } else if (Boolean(reservation) !== Boolean(payload) || !messageSchema.safeParse(dto).success) unavailable();
      const tombstone = { messageId: m.message_id, conversationId: m.conversation_id,
        acceptedAt: m.accepted_at, expiresAt: c.expires_at, expiredAt: c.expired_at };
      const parsed = historyItemSchema.safeParse({ kind: 'content_expired', tombstone });
      if (!parsed.success) unavailable();
      return Object.freeze({ kind: 'content_expired', tombstone: Object.freeze(parsed.data.tombstone) });
    }
    if (c.state !== 'live' || c.expired_at !== null || c.expiry_run_id !== null ||
        c.scrubbed_at !== null || c.scrub_run_id !== null) unavailable();
    if (Boolean(reservation) !== Boolean(payload)) unavailable();
    const parsed = messageSchema.safeParse(dto);
    if (!parsed.success) unavailable();
    if (parsed.data.attachment) Object.freeze(parsed.data.attachment);
    return Object.freeze(parsed.data);
  }
  return Object.freeze({
    historyItem(id) {
      const value = project(id);
      return value.kind === 'content_expired' ? value : Object.freeze({ kind: 'message', message: value });
    },
    message(id) {
      const value = project(id);
      if (value.kind === 'content_expired') throw new ImV2Error('CONTENT_EXPIRED');
      return value;
    },
  });
}
