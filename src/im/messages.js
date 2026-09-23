import { createHash, randomUUID } from 'node:crypto';
import { assertImSchema } from './schema.js';
import { resolveImTimeGuard } from './clock.js';
import { parseImConfig } from './config.js';
import { ImError, normalizeMessageRequest, fingerprintMessage } from './contracts.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const valid = value => typeof value === 'string' && UUID.test(value);
const fail = code => { throw new ImError(code); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(key => keys.includes(key));
const required = (value, keys) => { if (!exact(value, keys)) fail('INVALID_REQUEST'); };
const plus = (a, b) => {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || a > Number.MAX_SAFE_INTEGER - b) fail('STORAGE_UNAVAILABLE');
  return a + b;
};

export function createImMessages({ db, auth, acl, clock = Date.now, timeGuard, policy, onCommitted } = {}) {
  assertImSchema(db);
  const guard = resolveImTimeGuard(db, clock, timeGuard);
  if (typeof auth?.assertActive !== 'function' || typeof acl?.requirePeer !== 'function' ||
      typeof acl?.requireConversation !== 'function' || typeof acl?.requireMessage !== 'function' ||
      typeof acl?.requireAttachment !== 'function' || typeof clock !== 'function' ||
      (onCommitted !== undefined && typeof onCommitted !== 'function')) fail('POLICY_NOT_CONFIGURED');
  const parsed = parseImConfig(policy);
  const config = Object.freeze({ enabled: parsed.enabled, writeMode: parsed.writeMode,
    maxAttachmentBytes: parsed.limits.maxAttachmentBytes,
    safeRetryWindowMs: parsed.retention?.policy?.safeRetryWindowMs ?? null });
  const available = () => { if (!config.enabled) fail('IM_DISABLED'); };
  const active = principal => { available(); auth.assertActive(principal); };
  const writable = principal => {
    active(principal);
    if (config.writeMode !== 'enabled' || db.prepare('SELECT write_mode FROM im_settings WHERE singleton=1').get()?.write_mode !== 'enabled') fail('NEW_WRITES_DISABLED');
  };
  const audit = (principal, action, ids, now) => db.prepare(`INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json)
    VALUES ('agent',?,?,?,?,?)`).run(principal.agentId, action, JSON.stringify(ids), now, '{}');
  function notify(kind, ids) {
    if (onCommitted) {
      try { const result = onCommitted(Object.freeze({ kind, ...ids }));
        // A rejected asynchronous notification must not turn a committed send into a failure.
        if (result && typeof result.then === 'function') result.catch(() => {});
      } catch { /* post-commit notification is best effort */ }
    }
  }
  const attachmentMeta = row => row?.attachment_id ? {
    attachmentId: row.attachment_id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256,
  } : null;
  const projection = `SELECT m.*,d.acked_at AS delivered_at,d.read_at,a.attachment_id,a.name,a.mime,a.size,a.sha256
    FROM im_messages m JOIN im_deliveries d ON d.message_id=m.message_id AND d.recipient_id=m.recipient_id
    LEFT JOIN im_attachments a ON a.message_id=m.message_id`;
  const dto = row => ({ messageId: row.message_id, conversationId: row.conversation_id,
    senderAgentId: row.sender_id, recipientAgentId: row.recipient_id, clientMessageId: row.client_message_id,
    title: row.title, text: row.text, inReplyTo: row.in_reply_to, correlation: row.correlation,
    acceptedAt: row.accepted_at, deliveredAt: row.delivered_at, readAt: row.read_at, attachment: attachmentMeta(row) });
  const projected = id => db.prepare(`${projection} WHERE m.message_id=?`).get(id);
  const cursor = (kind, scope, key) => Buffer.from(JSON.stringify([kind, scope, key])).toString('base64url');
  function page(input, kind, scope) {
    required(input, ['after', 'limit', ...(kind === 'history' ? ['conversationId'] : [])]);
    const limit = input.limit === undefined ? 20 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_REQUEST');
    let after = null;
    if (input.after !== undefined) {
      if (typeof input.after !== 'string' || input.after.length > 512 || !/^[A-Za-z0-9_-]+$/.test(input.after)) fail('INVALID_REQUEST');
      try {
        if (Buffer.from(input.after, 'base64url').toString('base64url') !== input.after) fail('INVALID_REQUEST');
        const value = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8'));
        if (!Array.isArray(value) || value.length !== 3 || value[0] !== kind || value[1] !== scope ||
            (kind === 'history' ? !Array.isArray(value[2]) || value[2].length !== 2 || !Number.isSafeInteger(value[2][0]) || !valid(value[2][1]) : !valid(value[2]))) fail('INVALID_REQUEST');
        after = value[2];
      } catch { fail('INVALID_REQUEST'); }
    }
    return { after, limit };
  }
  const list = (rows, limit, kind, scope, key, map) => ({
    items: rows.slice(0, limit).map(map), nextCursor: rows.length > limit ? cursor(kind, scope, key(rows[limit - 1])) : null,
  });
  function ensureConversation(principal, input) {
    required(input, ['peerAgentId']);
    const result = guard.runWrite(() => {
      writable(principal);
      const peer = acl.requirePeer(principal, input.peerAgentId);
      const existing = db.prepare('SELECT * FROM im_conversations WHERE agent_low=? AND agent_high=?').get(peer.agentLow, peer.agentHigh);
      if (existing) return { row: existing, created: false };
      const now = guard.current();
      const conversationId = randomUUID();
      db.prepare('INSERT INTO im_conversations(conversation_id,agent_low,agent_high,created_at) VALUES (?,?,?,?)')
        .run(conversationId, peer.agentLow, peer.agentHigh, now);
      audit(principal, 'conversation_created', { conversationId, peerAgentId: peer.peerAgentId }, now);
      return { row: { conversation_id: conversationId, agent_low: peer.agentLow, agent_high: peer.agentHigh, created_at: now }, created: true };
    });
    if (result.created) notify('conversation_created', { conversationId: result.row.conversation_id });
    return { conversationId: result.row.conversation_id, peerAgentId: input.peerAgentId, createdAt: result.row.created_at };
  }
  function listContacts(principal, input = {}) { return guard.runRead(() => {
    active(principal);
    const { after, limit } = page(input, 'contacts', principal.agentId);
    const rows = db.prepare(`SELECT CASE WHEN c.agent_low=? THEN c.agent_high ELSE c.agent_low END AS peer_agent_id,
      a.display_name FROM im_contacts c JOIN im_agents a ON a.agent_id=CASE WHEN c.agent_low=? THEN c.agent_high ELSE c.agent_low END
      JOIN im_agents self ON self.agent_id=? WHERE (c.agent_low=? OR c.agent_high=?) AND c.allowed=1
      AND a.status='active' AND a.revoked_at IS NULL AND self.status='active' AND self.revoked_at IS NULL
      AND (? IS NULL OR a.agent_id>?) ORDER BY a.agent_id LIMIT ?`).all(principal.agentId, principal.agentId,
      principal.agentId, principal.agentId, principal.agentId, after, after, limit + 1);
    return list(rows, limit, 'contacts', principal.agentId, r => r.peer_agent_id,
      r => ({ peerAgentId: r.peer_agent_id, displayName: r.display_name }));
  }); }
  function listConversations(principal, input = {}) { return guard.runRead(() => {
    active(principal);
    const { after, limit } = page(input, 'conversations', principal.agentId);
    const rows = db.prepare(`SELECT v.*,CASE WHEN v.agent_low=? THEN v.agent_high ELSE v.agent_low END AS peer_agent_id
      FROM im_conversations v JOIN im_contacts c ON c.agent_low=v.agent_low AND c.agent_high=v.agent_high
      JOIN im_agents a ON a.agent_id=v.agent_low JOIN im_agents b ON b.agent_id=v.agent_high
      WHERE (v.agent_low=? OR v.agent_high=?) AND c.allowed=1 AND a.status='active' AND b.status='active'
      AND a.revoked_at IS NULL AND b.revoked_at IS NULL AND (? IS NULL OR v.conversation_id>?)
      ORDER BY v.conversation_id LIMIT ?`).all(principal.agentId, principal.agentId, principal.agentId, after, after, limit + 1);
    return list(rows, limit, 'conversations', principal.agentId, r => r.conversation_id,
      r => ({ conversationId: r.conversation_id, peerAgentId: r.peer_agent_id, createdAt: r.created_at }));
  }); }
  function send(principal, rawMessageRequest) {
    const message = normalizeMessageRequest(rawMessageRequest, { maxAttachmentBytes: config.maxAttachmentBytes });
    if (message.attachment?.size === 0) fail('INVALID_ATTACHMENT');
    const hash = fingerprintMessage(message);
    const result = guard.runWrite(() => {
      writable(principal);
      const conversation = acl.requireConversation(principal, message.conversationId);
      if (message.recipientAgentId === principal.agentId || ![conversation.agent_low, conversation.agent_high].includes(message.recipientAgentId)) fail('RESOURCE_NOT_FOUND');
      const now = guard.current();
      const key = db.prepare('SELECT * FROM im_send_keys WHERE sender_id=? AND client_message_id=?').get(principal.agentId, message.clientMessageId);
      if (key) {
        if (key.status !== 'live' || key.retry_until <= now) fail('IDEMPOTENCY_WINDOW_EXPIRED');
        if (key.payload_hash !== hash) fail('IDEMPOTENCY_CONFLICT');
        const saved = projected(key.message_id);
        if (!saved) fail('STORAGE_UNAVAILABLE');
        return { ...dto(saved), replayed: true };
      }
      if (message.inReplyTo) {
        const parent = acl.requireMessage(principal, message.inReplyTo);
        if (parent.conversation_id !== message.conversationId) fail('RESOURCE_NOT_FOUND');
      }
      const retryUntil = plus(now, config.safeRetryWindowMs);
      const state = db.prepare('SELECT next_seq FROM im_receive_state WHERE agent_id=?').get(message.recipientAgentId);
      if (!state || !Number.isSafeInteger(state.next_seq) || state.next_seq < 1) fail('STORAGE_UNAVAILABLE');
      const next = plus(state.next_seq, 1);
      const messageId = randomUUID();
      db.prepare(`INSERT INTO im_messages(message_id,conversation_id,sender_id,recipient_id,client_message_id,title,text,in_reply_to,correlation,accepted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(messageId, message.conversationId, principal.agentId, message.recipientAgentId,
        message.clientMessageId, message.title, message.text, message.inReplyTo, message.correlation, now);
      if (message.attachment) {
        const a = message.attachment;
        db.prepare('INSERT INTO im_attachments(attachment_id,message_id,name,mime,size,sha256,data) VALUES (?,?,?,?,?,?,?)')
           .run(randomUUID(), messageId, a.name, a.mime, a.size, a.sha256, Buffer.from(a.bytes));
      }
      db.prepare(`INSERT INTO im_send_keys(sender_id,client_message_id,payload_hash,message_id,created_at,retry_until,status)
        VALUES (?,?,?,?,?,?,'live')`).run(principal.agentId, message.clientMessageId, hash, messageId, now, retryUntil);
      db.prepare('INSERT INTO im_deliveries(recipient_id,seq,message_id) VALUES (?,?,?)').run(message.recipientAgentId, state.next_seq, messageId);
      db.prepare('UPDATE im_receive_state SET next_seq=? WHERE agent_id=?').run(next, message.recipientAgentId);
      audit(principal, 'message_sent', { messageId, conversationId: message.conversationId }, now);
      return { ...dto(projected(messageId)), replayed: false };
    });
    if (!result.replayed) notify('message_sent', { messageId: result.messageId, conversationId: result.conversationId });
    return result;
  }
  function getSendResult(principal, input) { return guard.runRead(() => {
    active(principal); required(input, ['clientMessageId']);
    if (!valid(input.clientMessageId)) fail('INVALID_REQUEST');
    const key = db.prepare('SELECT * FROM im_send_keys WHERE sender_id=? AND client_message_id=?').get(principal.agentId, input.clientMessageId);
    if (!key) fail('RESOURCE_NOT_FOUND');
    if (key.status !== 'live' || key.retry_until <= guard.current()) fail('IDEMPOTENCY_WINDOW_EXPIRED');
    const row = projected(key.message_id);
    if (!row) fail('STORAGE_UNAVAILABLE');
    acl.requireMessage(principal, key.message_id);
    return { ...dto(row), replayed: true };
  }); }
  function listHistory(principal, input) { return guard.runRead(() => {
    active(principal); required(input, ['conversationId', 'after', 'limit']);
    acl.requireConversation(principal, input.conversationId);
    const scope = `${principal.agentId}:${input.conversationId}`;
    const { after, limit } = page(input, 'history', scope);
    const rows = db.prepare(`${projection} WHERE m.conversation_id=? AND
      (m.sender_id=? OR m.recipient_id=?) AND (? IS NULL OR m.accepted_at>? OR (m.accepted_at=? AND m.message_id>?))
      ORDER BY m.accepted_at,m.message_id LIMIT ?`).all(input.conversationId, principal.agentId, principal.agentId,
      after?.[0] ?? null, after?.[0] ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1);
    return list(rows, limit, 'history', scope, r => [r.accepted_at, r.message_id], dto);
  }); }
  function getMessage(principal, input) { return guard.runRead(() => {
    active(principal); required(input, ['messageId']);
    acl.requireMessage(principal, input.messageId);
    const row = projected(input.messageId);
    if (!row) fail('STORAGE_UNAVAILABLE');
    return dto(row);
  }); }
  function getAttachment(principal, input) { return guard.runRead(() => {
    active(principal); required(input, ['attachmentId']);
    const row = acl.requireAttachment(principal, input.attachmentId);
    const bytes = Buffer.from(row.data);
    if (bytes.length !== row.size || createHash('sha256').update(bytes).digest('hex') !== row.sha256) fail('STORAGE_UNAVAILABLE');
    return { ...attachmentMeta(row), data: bytes };
  }); }
  function markRead(principal, input) {
    required(input, ['messageId']);
    const result = guard.runWrite(() => {
      writable(principal);
      const message = acl.requireMessage(principal, input.messageId);
      if (message.recipient_id !== principal.agentId) fail('RESOURCE_NOT_FOUND');
      const delivery = db.prepare('SELECT acked_at,read_at FROM im_deliveries WHERE message_id=? AND recipient_id=?').get(input.messageId, principal.agentId);
      if (!delivery?.acked_at && delivery?.acked_at !== 0) fail('DELIVERY_REQUIRED');
      if (delivery.read_at !== null) return { messageId: input.messageId, readAt: delivery.read_at, changed: false };
      const now = guard.current();
      db.prepare('UPDATE im_deliveries SET read_at=? WHERE message_id=? AND recipient_id=?').run(now, input.messageId, principal.agentId);
      audit(principal, 'message_read', { messageId: input.messageId }, now);
      return { messageId: input.messageId, readAt: now, changed: true };
    });
    if (result.changed) notify('message_read', { messageId: result.messageId });
    return result;
  }
  return Object.freeze({ ensureConversation, listContacts, listConversations, send, getSendResult,
    listHistory, getMessage, getAttachment, markRead });
}
