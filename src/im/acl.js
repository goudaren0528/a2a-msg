import { assertImSchema } from './schema.js';
import { ImError } from './contracts.js';
import { resolveImTimeGuard } from './clock.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hidden = () => { throw new ImError('RESOURCE_NOT_FOUND'); };

export function createImAcl({ db, auth, clock = Date.now, timeGuard }) {
  assertImSchema(db);
  const guard = resolveImTimeGuard(db, clock, timeGuard);
  if (!auth || typeof auth.assertActive !== 'function') throw new ImError('POLICY_NOT_CONFIGURED');
  const contact = db.prepare(`SELECT 1 FROM im_contacts c JOIN im_agents a ON a.agent_id=c.agent_low
    JOIN im_agents b ON b.agent_id=c.agent_high WHERE c.agent_low=? AND c.agent_high=? AND c.allowed=1
    AND a.status='active' AND b.status='active' AND a.revoked_at IS NULL AND b.revoked_at IS NULL`);
  function requirePeer(principal, peerAgentId) { return guard.runRead(() => {
    auth.assertActive(principal);
    if (typeof peerAgentId !== 'string' || !UUID.test(peerAgentId) || peerAgentId === principal.agentId) hidden();
    const [low, high] = [principal.agentId, peerAgentId].sort();
    if (!contact.get(low, high)) hidden();
    return Object.freeze({ agentLow: low, agentHigh: high, peerAgentId });
  }); }
  const conversation = db.prepare('SELECT * FROM im_conversations WHERE conversation_id=?');
  function requireConversation(principal, conversationId) { return guard.runRead(() => {
    auth.assertActive(principal);
    if (typeof conversationId !== 'string' || !UUID.test(conversationId)) hidden();
    const row = conversation.get(conversationId);
    if (!row || (principal.agentId !== row.agent_low && principal.agentId !== row.agent_high)) hidden();
    requirePeer(principal, principal.agentId === row.agent_low ? row.agent_high : row.agent_low);
    return row;
  }); }
  const message = db.prepare(`SELECT m.* FROM im_messages m JOIN im_conversations c ON c.conversation_id=m.conversation_id
    WHERE m.message_id=? AND m.sender_id IN (c.agent_low,c.agent_high)
    AND m.recipient_id IN (c.agent_low,c.agent_high) AND m.sender_id<>m.recipient_id`);
  function requireMessage(principal, messageId) { return guard.runRead(() => {
    auth.assertActive(principal);
    if (typeof messageId !== 'string' || !UUID.test(messageId)) hidden();
    const row = message.get(messageId);
    if (!row) hidden();
    requireConversation(principal, row.conversation_id);
    return row;
  }); }
  const attachmentOwner = db.prepare('SELECT attachment_id,message_id,name,mime,size,sha256 FROM im_attachments WHERE attachment_id=?');
  const attachment = db.prepare('SELECT * FROM im_attachments WHERE attachment_id=?');
  function assertAttachmentAccess(principal, attachmentId) { return guard.runRead(() => {
    auth.assertActive(principal);
    if (typeof attachmentId !== 'string' || !UUID.test(attachmentId)) hidden();
    const owner = attachmentOwner.get(attachmentId);
    if (!owner) hidden();
    requireMessage(principal, owner.message_id);
    return Object.freeze(owner);
  }); }
  function requireAttachment(principal, attachmentId) { return guard.runRead(() => {
    const owner = assertAttachmentAccess(principal, attachmentId);
    const row = attachment.get(attachmentId);
    if (!row || row.message_id !== owner.message_id) hidden();
    return row;
  }); }
  return Object.freeze({ requirePeer, requireConversation, requireMessage, requireAttachment, assertAttachmentAccess });
}
