import { createHash, randomUUID } from 'node:crypto';
import { assertImV2AuthBinding } from './auth.js';
import { resolveImV2TimeGuard } from './clock.js';
import { parseImV2Config } from './config.js';
import { createImV2MessageView } from './message-view.js';
import { ImV2Error, PROTOCOL, operationSchema, attachmentSchema, dataSchemas,
  normalizeMessageRequest, fingerprintMessage, storageOperationKey, encodeCursor, decodeCursor } from './contracts.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail = code => { throw new ImV2Error(code); };
const safeAdd = (a, b) => Number.isSafeInteger(a) && a >= 0 && Number.isSafeInteger(b) && b >= 0 && a <= Number.MAX_SAFE_INTEGER - b
  ? a + b : fail('CLOCK_UNSAFE');
const snapshot = (value, allowed, required = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Reflect.ownKeys(value).some(k => typeof k !== 'string' || !allowed.includes(k)) ||
      required.some(k => !Object.hasOwn(value, k))) fail('INVALID_REQUEST');
  const copy = {};
  for (const key of allowed) if (Object.hasOwn(value, key)) copy[key] = value[key];
  return copy;
};
const idArg = (args, name) => {
  const value = snapshot(args, [name], [name]);
  if (typeof value[name] !== 'string' || !uuid.test(value[name])) fail('INVALID_REQUEST');
  return value[name];
};
const pageArgs = (args, extra = []) => {
  const value = snapshot(args, [...extra, 'after', 'limit'], extra);
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100)) fail('INVALID_REQUEST');
  if (value.after !== undefined && (typeof value.after !== 'string' || !value.after.length)) fail('INVALID_REQUEST');
  for (const key of extra) if (typeof value[key] !== 'string' || !uuid.test(value[key])) fail('INVALID_REQUEST');
  return { ...value, limit: value.limit ?? 20 };
};

export function createImV2Messages({ db, auth, acl, policy, clock = Date.now, timeGuard } = {}) {
  const config = parseImV2Config(policy);
  const guard = resolveImV2TimeGuard(db, clock, timeGuard);
  assertImV2AuthBinding(auth, db, guard);
  if (!acl || typeof acl !== 'object' ||
      ['requirePeer','requireConversation','requireMessage','requireLiveMessage','assertAttachmentAccess']
        .some(name => typeof acl[name] !== 'function')) fail('INVALID_REQUEST');
  const view = createImV2MessageView({ db });
  const statements = {
    conversationByPair: 'SELECT conversation_id,created_at FROM im_conversations WHERE agent_low=? AND agent_high=?',
    addConversation: 'INSERT INTO im_conversations(conversation_id,agent_low,agent_high,created_at) VALUES(?,?,?,?)',
    contacts: `SELECT CASE WHEN agent_low=? THEN agent_high ELSE agent_low END peer_agent_id,
      CASE WHEN agent_low=? THEN high.display_name ELSE low.display_name END display_name
      FROM im_contacts JOIN im_agents low ON low.agent_id=agent_low JOIN im_agents high ON high.agent_id=agent_high
      WHERE (agent_low=? OR agent_high=?) AND allowed=1
      AND low.status='active' AND high.status='active' AND low.revoked_at IS NULL AND high.revoked_at IS NULL
      AND (CASE WHEN agent_low=? THEN agent_high ELSE agent_low END)>?
      ORDER BY peer_agent_id LIMIT ?`,
    conversations: `SELECT c.conversation_id,c.agent_low,c.agent_high,c.created_at FROM im_conversations c
      JOIN im_contacts contact ON contact.agent_low=c.agent_low AND contact.agent_high=c.agent_high
      JOIN im_agents low ON low.agent_id=c.agent_low JOIN im_agents high ON high.agent_id=c.agent_high
      WHERE (c.agent_low=? OR c.agent_high=?) AND contact.allowed=1
      AND low.status='active' AND high.status='active' AND low.revoked_at IS NULL AND high.revoked_at IS NULL
      AND c.conversation_id>? ORDER BY c.conversation_id LIMIT ?`,
    history: `SELECT message_id,accepted_at FROM im_messages WHERE conversation_id=? AND
      (accepted_at,message_id)>(?,?) ORDER BY accepted_at,message_id LIMIT ?`,
    mapping: `SELECT origin_epoch,client_message_id,storage_client_message_id,source_protocol,message_id
      FROM im_send_operation_keys WHERE sender_id=? AND origin_epoch=? AND client_message_id=?`,
    key: 'SELECT message_id,payload_hash,created_at,retry_until,status FROM im_send_keys WHERE sender_id=? AND client_message_id=?',
    mappedMessage: 'SELECT sender_id,client_message_id,accepted_at FROM im_messages WHERE message_id=?',
    content: 'SELECT state FROM im_content_state WHERE message_id=?',
    capacity: 'SELECT 1 AS hit FROM im_send_keys LIMIT 1 OFFSET ?',
    receive: 'SELECT next_seq,stream_epoch FROM im_receive_state WHERE agent_id=?',
    progress: `SELECT 1 AS hit FROM im_sync_progress WHERE recipient_id=? AND center_epoch=? AND stream_epoch=?`,
    advance: 'UPDATE im_receive_state SET next_seq=? WHERE agent_id=? AND next_seq=?',
    addMessage: `INSERT INTO im_messages(message_id,conversation_id,sender_id,recipient_id,client_message_id,title,text,in_reply_to,correlation,accepted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
    addAttachment: 'INSERT INTO im_attachments(attachment_id,message_id,name,mime,size,sha256,data) VALUES(?,?,?,?,?,?,?)',
    addReservation: 'INSERT INTO im_attachment_reservations(attachment_id,message_id,size,sha256) VALUES(?,?,?,?)',
    addKey: `INSERT INTO im_send_keys(sender_id,client_message_id,payload_hash,message_id,created_at,retry_until,status) VALUES(?,?,?,?,?,?,'live')`,
    addMapping: 'INSERT INTO im_send_operation_keys(sender_id,origin_epoch,client_message_id,storage_client_message_id,source_protocol,message_id) VALUES(?,?,?,?,?,?)',
    addContent: `INSERT INTO im_content_state(message_id,state,expires_at,expired_at,scrubbed_at,policy_hash,expiry_run_id,scrub_run_id)
      VALUES(?,'live',?,NULL,NULL,?,NULL,NULL)`,
    addDelivery: 'INSERT INTO im_deliveries(recipient_id,seq,message_id,acked_at,read_at) VALUES(?,?,?,NULL,NULL)',
    delivery: 'SELECT recipient_id,acked_at,read_at FROM im_deliveries WHERE message_id=?',
    read: 'UPDATE im_deliveries SET read_at=? WHERE message_id=? AND recipient_id=? AND read_at IS NULL AND acked_at IS NOT NULL',
    blob: 'SELECT data FROM im_attachments WHERE attachment_id=? AND message_id=?',
    audit: 'INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json) VALUES(?,?,?,?,?,?)',
  };
  let q;
  try { q = Object.fromEntries(Object.entries(statements).map(([name, sql]) => [name, db.prepare(sql)])); }
  catch { fail('STORAGE_UNAVAILABLE'); }
  const get = (name, ...params) => { try { return q[name].get(...params); } catch { fail('STORAGE_UNAVAILABLE'); } };
  const all = (name, ...params) => { try { return q[name].all(...params); } catch { fail('STORAGE_UNAVAILABLE'); } };
  const run = (name, ...params) => { try { return q[name].run(...params); } catch { fail('STORAGE_UNAVAILABLE'); } };
  const audit = (actor, action, ids) => run('audit', 'agent', actor, action, JSON.stringify(ids), guard.current(), '{}');
  const result = (schema, value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) fail('STORAGE_UNAVAILABLE');
    return parsed.data;
  };
  const scopeCopy = scope => snapshot(scope, ['protocol','centerEpoch'], ['protocol','centerEpoch']);
  const read = (principal, scope, fn) => auth.withRead(principal, scopeCopy(scope), fn);
  const write = (principal, scope, fn) => auth.withWrite(principal, scopeCopy(scope), fn);
  function mapped(principal, scope, originEpoch, clientMessageId) {
    const sender = principal.agentId;
    const op = get('mapping', sender, originEpoch, clientMessageId);
    if (!op) {
      // A v2 storage key is bijective for this authenticated sender and logical
      // operation. A retained key without its mapping is corruption, not absence.
      // A legacy v1 UUID key alone cannot establish its origin epoch: that binding
      // exists only in the mapping, so never infer an origin for an unmapped v1 key.
      const retained = get('key', sender, storageOperationKey(originEpoch, clientMessageId));
      if (retained) {
        if (!get('mappedMessage', retained.message_id)) fail('STORAGE_UNAVAILABLE');
        acl.requireMessage(principal, scope, retained.message_id);
        fail('STORAGE_UNAVAILABLE');
      }
      return null;
    }
    const key = get('key', sender, op.storage_client_message_id);
    const message = get('mappedMessage', op.message_id);
    const content = get('content', op.message_id);
    if (!key || !message || !content || !['live','expired'].includes(content.state) ||
        op.origin_epoch !== originEpoch || op.client_message_id !== clientMessageId ||
        op.storage_client_message_id !== (op.source_protocol === PROTOCOL ? storageOperationKey(originEpoch, clientMessageId) : clientMessageId) ||
        !['a2a-msg.im.v1',PROTOCOL].includes(op.source_protocol) ||
        key.message_id !== op.message_id || message.sender_id !== sender ||
        message.client_message_id !== op.storage_client_message_id || message.accepted_at !== key.created_at ||
        !Number.isSafeInteger(key.retry_until) || key.retry_until < key.created_at ||
        !/^[0-9a-f]{64}$/.test(key.payload_hash) || !['live','expired'].includes(key.status)) fail('STORAGE_UNAVAILABLE');
    return { op, key, content };
  }
  function ensureConversation(principal, scope, args) {
    const peer = idArg(args, 'peerAgentId');
    const captured = scopeCopy(scope);
    return write(principal, captured, () => {
      const pair = acl.requirePeer(principal, captured, peer);
      let row = get('conversationByPair', pair.agentLow, pair.agentHigh);
      if (!row) {
        const conversationId = randomUUID(), createdAt = guard.current();
        run('addConversation', conversationId, pair.agentLow, pair.agentHigh, createdAt);
        audit(principal.agentId, 'conversation.created', { conversationId });
        row = { conversation_id: conversationId, created_at: createdAt };
      }
      return result(dataSchemas.conversation, { conversationId: row.conversation_id, peerAgentId: peer, createdAt: row.created_at });
    });
  }
  function listContacts(principal, scope, args) {
    const p = pageArgs(args), captured = scopeCopy(scope);
    return read(principal, captured, () => {
      const after = p.after === undefined ? '' : decodeCursor(p.after,
        {kind:'contacts',centerEpoch:captured.centerEpoch,agentId:principal.agentId,scope:principal.agentId});
      // Empty page starts below all canonical UUIDs, not at the requesting ID.
      const rows = all('contacts', principal.agentId, principal.agentId, principal.agentId, principal.agentId,
        principal.agentId, p.after === undefined ? '' : after, p.limit + 1);
      const items = rows.slice(0,p.limit).filter(row => {
        try { acl.requirePeer(principal, captured, row.peer_agent_id); return true; }
        catch (e) { if (e?.code === 'RESOURCE_NOT_FOUND') return false; throw e; }
      }).map(row => ({ peerAgentId: row.peer_agent_id, displayName: row.display_name }));
      return result(dataSchemas.contacts, { items, nextCursor: rows.length > p.limit ? encodeCursor('contacts',captured.centerEpoch,principal.agentId,principal.agentId,rows[p.limit-1].peer_agent_id) : null });
    });
  }
  function listConversations(principal, scope, args) {
    const p = pageArgs(args), captured = scopeCopy(scope);
    return read(principal, captured, () => {
      const after = p.after === undefined ? '' : decodeCursor(p.after,
        {kind:'conversations',centerEpoch:captured.centerEpoch,agentId:principal.agentId,scope:principal.agentId});
      const rows = all('conversations',principal.agentId,principal.agentId,after,p.limit+1);
      const items = rows.slice(0,p.limit).flatMap(row => {
        try { const c = acl.requireConversation(principal,captured,row.conversation_id);
          return [{conversationId:c.conversationId,peerAgentId:c.peerAgentId,createdAt:c.createdAt}]; }
        catch (e) { if (e?.code === 'RESOURCE_NOT_FOUND') return []; throw e; }
      });
      return result(dataSchemas.conversations,{items,nextCursor:rows.length>p.limit ?
        encodeCursor('conversations',captured.centerEpoch,principal.agentId,principal.agentId,rows[p.limit-1].conversation_id):null});
    });
  }
  function send(principal, scope, args) {
    const captured = scopeCopy(scope);
    const raw = snapshot(args,['originEpoch','clientMessageId','conversationId','recipientAgentId','title','text','attachment','inReplyTo','correlation'],
      ['originEpoch','clientMessageId','conversationId','recipientAgentId']);
    if (!operationSchema.safeParse({originEpoch:raw.originEpoch,clientMessageId:raw.clientMessageId}).success) fail('INVALID_REQUEST');
    if (raw.originEpoch !== captured.centerEpoch) fail('RECOVERY_RECONCILIATION_REQUIRED');
    const normalized = normalizeMessageRequest({ ...raw,protocol:PROTOCOL,centerEpoch:captured.centerEpoch },
      {maxAttachmentBytes:config.limits?.maxAttachmentBytes});
    // Clone binary input before entering callbacks; parsed wire data and normalized bytes are owned snapshots.
    const attachment = normalized.attachment && {...normalized.attachment, bytes:Buffer.from(normalized.attachment.bytes)};
    const request = {...normalized,attachment};
    const hash = fingerprintMessage(request), storageKey = storageOperationKey(request.originEpoch,request.clientMessageId);
    return write(principal,captured,() => {
      const existing = mapped(principal,captured,request.originEpoch,request.clientMessageId);
      if (existing) {
        acl.requireMessage(principal,captured,existing.op.message_id);
        if (existing.key.payload_hash !== hash) fail('IDEMPOTENCY_CONFLICT');
        if (existing.key.retry_until <= guard.current()) fail('IDEMPOTENCY_WINDOW_EXPIRED');
        if (existing.content.state !== 'live') fail('CONTENT_EXPIRED');
        return result(dataSchemas.send,{message:view.message(existing.op.message_id),replayed:true});
      }
      const c = acl.requireConversation(principal,captured,request.conversationId);
      if (c.peerAgentId !== request.recipientAgentId) fail('RESOURCE_NOT_FOUND');
      if (request.inReplyTo) {
        const parent = acl.requireLiveMessage(principal,captured,request.inReplyTo);
        if (parent.conversationId !== request.conversationId) fail('RESOURCE_NOT_FOUND');
      }
      const cap = config.maintenance?.maxKeyReservations;
      if (!Number.isSafeInteger(cap) || cap < 1) fail('POLICY_NOT_CONFIGURED');
      if (get('capacity',cap-1)) fail('CAPACITY_EXHAUSTED');
      const state = get('receive',request.recipientAgentId);
      if (!state || !Number.isSafeInteger(state.next_seq) || state.next_seq < 1 ||
          !get('progress',request.recipientAgentId,captured.centerEpoch,state.stream_epoch)) fail('STORAGE_UNAVAILABLE');
      const seqNext = safeAdd(state.next_seq,1), now = guard.current();
      const retry = safeAdd(now,config.retention.policy.safeRetryWindowMs);
      const expires = safeAdd(now,config.retention.policy.messageRetentionMs);
      const messageId = randomUUID(), attachmentId = attachment && randomUUID();
      run('addMessage',messageId,request.conversationId,principal.agentId,request.recipientAgentId,storageKey,
        request.title,request.text,request.inReplyTo,request.correlation,now);
      if (attachment) {
        run('addAttachment',attachmentId,messageId,attachment.name,attachment.mime,attachment.size,attachment.sha256,attachment.bytes);
        run('addReservation',attachmentId,messageId,attachment.size,attachment.sha256);
      }
      run('addKey',principal.agentId,storageKey,hash,messageId,now,retry);
      run('addMapping',principal.agentId,request.originEpoch,request.clientMessageId,storageKey,PROTOCOL,messageId);
      run('addContent',messageId,expires,config.retention.policyHash);
      run('addDelivery',request.recipientAgentId,state.next_seq,messageId);
      if (run('advance',seqNext,request.recipientAgentId,state.next_seq).changes !== 1) fail('STORAGE_UNAVAILABLE');
      audit(principal.agentId,'message.accepted',{messageId});
      return result(dataSchemas.send,{message:view.message(messageId),replayed:false});
    });
  }
  function getSendResult(principal,scope,args) {
    const a = snapshot(args,['originEpoch','clientMessageId'],['originEpoch','clientMessageId']);
    if (!operationSchema.safeParse(a).success) fail('INVALID_REQUEST');
    const captured = scopeCopy(scope);
    return read(principal,captured,() => {
      const known = mapped(principal,captured,a.originEpoch,a.clientMessageId);
      if (!known) fail(a.originEpoch === captured.centerEpoch ? 'RESOURCE_NOT_FOUND':'SEND_OUTCOME_UNKNOWN');
      acl.requireMessage(principal,captured,known.op.message_id);
      return result(dataSchemas.sendResult,{originEpoch:a.originEpoch,clientMessageId:a.clientMessageId,
        messageId:known.op.message_id,acceptedAt:known.key.created_at,payloadHash:known.key.payload_hash,
        sourceProtocol:known.op.source_protocol,contentState:known.content.state,retryUntil:known.key.retry_until});
    });
  }
  function listHistory(principal,scope,args) {
    const p = pageArgs(args,['conversationId']), captured = scopeCopy(scope);
    return read(principal,captured,() => {
      acl.requireConversation(principal,captured,p.conversationId);
      const key = p.after === undefined ? [0,''] : decodeCursor(p.after,
        {kind:'history',centerEpoch:captured.centerEpoch,agentId:principal.agentId,scope:p.conversationId});
      const rows = all('history',p.conversationId,key[0],key[1],p.limit+1);
      const items = rows.slice(0,p.limit).map(row => { acl.requireMessage(principal,captured,row.message_id); return view.historyItem(row.message_id); });
      const last = rows[p.limit-1];
      return result(dataSchemas.history,{items,nextCursor:rows.length>p.limit ?
        encodeCursor('history',captured.centerEpoch,principal.agentId,p.conversationId,[last.accepted_at,last.message_id]):null});
    });
  }
  function getMessage(principal,scope,args) {
    const id = idArg(args,'messageId'), captured = scopeCopy(scope);
    return read(principal,captured,() => {
      acl.requireLiveMessage(principal,captured,id);
      return result(dataSchemas.message,view.message(id));
    });
  }
  function getAttachment(principal,scope,args) {
    const id = idArg(args,'attachmentId'), captured = scopeCopy(scope);
    return read(principal,captured,() => {
      const meta = acl.assertAttachmentAccess(principal,captured,id);
      if (meta.attachmentId !== id || !uuid.test(meta.messageId) ||
          !attachmentSchema.safeParse({attachmentId:meta.attachmentId,name:meta.name,mime:meta.mime,
            size:meta.size,sha256:meta.sha256}).success) fail('STORAGE_UNAVAILABLE');
      const data = get('blob',id,meta.messageId)?.data;
      if (!(data instanceof Uint8Array) || data.length !== meta.size || data.length > 10485760 ||
          createHash('sha256').update(data).digest('hex') !== meta.sha256) fail('STORAGE_UNAVAILABLE');
      return {...meta,data:Buffer.from(data)};
    });
  }
  function markRead(principal,scope,args) {
    const id = idArg(args,'messageId'), captured = scopeCopy(scope);
    return write(principal,captured,() => {
      const meta = acl.requireLiveMessage(principal,captured,id);
      if (meta.recipientAgentId !== principal.agentId) fail('RESOURCE_NOT_FOUND');
      const delivery = get('delivery',id);
      if (!delivery || delivery.recipient_id !== principal.agentId) fail('STORAGE_UNAVAILABLE');
      if (delivery.acked_at === null) fail('DELIVERY_REQUIRED');
      if (delivery.read_at !== null) return result(dataSchemas.read,{messageId:id,readAt:delivery.read_at,changed:false});
      const at = Math.max(guard.current(),delivery.acked_at);
      if (!Number.isSafeInteger(at) || at < 0) fail('STORAGE_UNAVAILABLE');
      if (run('read',at,id,principal.agentId).changes !== 1) fail('STORAGE_UNAVAILABLE');
      audit(principal.agentId,'message.read',{messageId:id});
      return result(dataSchemas.read,{messageId:id,readAt:at,changed:true});
    });
  }
  return Object.freeze({ensureConversation,listContacts,listConversations,send,getSendResult,listHistory,getMessage,getAttachment,markRead});
}
