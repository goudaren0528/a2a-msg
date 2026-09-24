import { ImV2Error } from './contracts.js';
import { resolveImV2TimeGuard } from './clock.js';
import { assertImV2AuthBinding } from './auth.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hidden = () => { throw new ImV2Error('RESOURCE_NOT_FOUND'); };
const storage = () => { throw new ImV2Error('STORAGE_UNAVAILABLE'); };

export function createImV2Acl({ db, auth, clock = Date.now, timeGuard } = {}) {
  assertImV2AuthBinding(auth, db);
  const guard = resolveImV2TimeGuard(db, clock, timeGuard);
  assertImV2AuthBinding(auth, db, guard);
  let contact, conversation, message, content, reservation, payload;
  try {
    contact = db.prepare(`SELECT c.allowed,a.status AS low_status,a.revoked_at AS low_revoked,
      b.status AS high_status,b.revoked_at AS high_revoked
      FROM im_contacts c JOIN im_agents a ON a.agent_id=c.agent_low
      JOIN im_agents b ON b.agent_id=c.agent_high WHERE c.agent_low=? AND c.agent_high=?`);
    conversation = db.prepare('SELECT conversation_id,agent_low,agent_high,created_at FROM im_conversations WHERE conversation_id=?');
    message = db.prepare(`SELECT message_id,conversation_id,sender_id,recipient_id,accepted_at
      FROM im_messages WHERE message_id=?`);
    content = db.prepare('SELECT state,expires_at,expired_at,scrubbed_at FROM im_content_state WHERE message_id=?');
    reservation = db.prepare('SELECT attachment_id,message_id,size,sha256 FROM im_attachment_reservations WHERE attachment_id=?');
    payload = db.prepare('SELECT attachment_id,message_id,name,mime,size,sha256 FROM im_attachments WHERE attachment_id=?');
  } catch { storage(); }
  function get(statement, ...args) {
    guard.current(); // Refuse a different auth factory's transaction/connection.
    try { return statement.get(...args); } catch { storage(); }
  }
  function peer(principal, peerAgentId) {
    if (typeof peerAgentId !== 'string' || !UUID.test(peerAgentId) || peerAgentId === principal.agentId) hidden();
    const [agentLow, agentHigh] = [principal.agentId, peerAgentId].sort();
    const row = get(contact, agentLow, agentHigh);
    if (!row || row.allowed !== 1 || row.low_status !== 'active' || row.high_status !== 'active' ||
        row.low_revoked !== null || row.high_revoked !== null) hidden();
    return Object.freeze({ agentLow, agentHigh, peerAgentId });
  }
  function conversationFor(principal, conversationId) {
    if (typeof conversationId !== 'string' || !UUID.test(conversationId)) hidden();
    const row = get(conversation, conversationId);
    if (!row || ![row.agent_low, row.agent_high].includes(principal.agentId) || row.agent_low >= row.agent_high) hidden();
    const { peerAgentId } = peer(principal, principal.agentId === row.agent_low ? row.agent_high : row.agent_low);
    return Object.freeze({ conversationId: row.conversation_id, peerAgentId, createdAt: row.created_at,
      agentLow: row.agent_low, agentHigh: row.agent_high });
  }
  function messageFor(principal, messageId) {
    if (typeof messageId !== 'string' || !UUID.test(messageId)) hidden();
    const row = get(message, messageId);
    if (!row) hidden();
    const c = conversationFor(principal, row.conversation_id);
    if (row.sender_id === row.recipient_id ||
        ![c.agentLow, c.agentHigh].includes(row.sender_id) ||
        ![c.agentLow, c.agentHigh].includes(row.recipient_id)) hidden();
    const status = get(content, messageId);
    if (!status || !['live','expired'].includes(status.state) ||
        (status.state === 'live' && (status.expired_at !== null || status.scrubbed_at !== null)) ||
        (status.state === 'expired' && status.expired_at === null)) storage();
    return Object.freeze({ messageId: row.message_id, conversationId: row.conversation_id,
      senderAgentId: row.sender_id, recipientAgentId: row.recipient_id, acceptedAt: row.accepted_at,
      contentState: status.state, expiresAt: status.expires_at, expiredAt: status.expired_at });
  }
  function live(metadata) {
    if (metadata.contentState === 'expired') throw new ImV2Error('CONTENT_EXPIRED');
    return metadata;
  }
  function requirePeer(principal, scope, peerAgentId) {
    return auth.withRead(principal, scope, () => peer(principal, peerAgentId));
  }
  function requireConversation(principal, scope, conversationId) {
    return auth.withRead(principal, scope, () => conversationFor(principal, conversationId));
  }
  function requireMessage(principal, scope, messageId) {
    return auth.withRead(principal, scope, () => messageFor(principal, messageId));
  }
  function requireLiveMessage(principal, scope, messageId) {
    return auth.withRead(principal, scope, () => live(messageFor(principal, messageId)));
  }
  function assertAttachmentAccess(principal, scope, attachmentId) {
    return auth.withRead(principal, scope, () => {
      if (typeof attachmentId !== 'string' || !UUID.test(attachmentId)) hidden();
      const owner = get(reservation, attachmentId);
      if (!owner) hidden();
      live(messageFor(principal, owner.message_id));
      const p = get(payload, attachmentId);
      if (!p || p.attachment_id !== owner.attachment_id || p.message_id !== owner.message_id ||
          p.size !== owner.size || p.sha256 !== owner.sha256) storage();
      return Object.freeze({ attachmentId: owner.attachment_id, messageId: owner.message_id,
        name: p.name, mime: p.mime, size: owner.size, sha256: owner.sha256 });
    });
  }
  return Object.freeze({ requirePeer, requireConversation, requireMessage, requireLiveMessage, assertAttachmentAccess });
}
