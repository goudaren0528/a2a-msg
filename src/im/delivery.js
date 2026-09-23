import { createHash } from 'node:crypto';
import { assertImSchema } from './schema.js';
import { resolveImTimeGuard } from './clock.js';
import { parseImConfig } from './config.js';
import { ImError } from './contracts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () => { throw new ImError('INVALID_REQUEST'); };
const validInt = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
function input(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(k => ![...required, ...optional].includes(k)) || required.some(k => !Object.hasOwn(value, k))) invalid();
}
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) invalid(); }
function fence(value) {
  input(value, ['instanceId', 'generation']);
  uuid(value.instanceId);
  if (!validInt(value.generation, 1)) invalid();
}
function add(now, duration) {
  if (!validInt(duration, 1) || duration > Number.MAX_SAFE_INTEGER - now) throw new ImError('CLOCK_UNSAFE');
  return now + duration;
}

export function createImDelivery({ db, auth, acl, clock = Date.now, timeGuard, policy } = {}) {
  assertImSchema(db);
  const guard = resolveImTimeGuard(db, clock, timeGuard);
  if (!auth || typeof auth.assertActive !== 'function' || !acl || typeof acl.requireMessage !== 'function' ||
      typeof clock !== 'function') throw new ImError('POLICY_NOT_CONFIGURED');
  const config = structuredClone(parseImConfig(policy));
  const lease = db.prepare('SELECT instance_id,generation,expires_at,credential_id FROM im_receiver_leases WHERE agent_id=?');
  const state = db.prepare('SELECT next_seq,acked_through,retained_floor,stream_epoch FROM im_receive_state WHERE agent_id=?');
  const settings = db.prepare('SELECT write_mode FROM im_settings WHERE singleton=1');
  const audit = db.prepare(`INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json)
    VALUES ('agent',?,?,?,?,?)`);
  function active(principal) {
    auth.assertActive(principal);
    if (!config.enabled) throw new ImError('IM_DISABLED');
  }
  function writable() {
    if (config.writeMode !== 'enabled' || settings.get()?.write_mode !== 'enabled') throw new ImError('NEW_WRITES_DISABLED');
    if (!config.lease) throw new ImError('POLICY_NOT_CONFIGURED');
  }
  function record(principal, action, details, now) {
    audit.run(principal.agentId, action, JSON.stringify({ agentId: principal.agentId }), now, JSON.stringify(details));
  }
  function mutation(principal, fn) {
    return guard.runWrite(() => {
      const now = guard.current();
      active(principal);
      auth.assertActive(principal);
      writable();
      return fn(now);
    });
  }
  function requireLease(principal, args, now) {
    const row = lease.get(principal.agentId);
    if (!row || row.instance_id !== args.instanceId || row.generation !== args.generation ||
        row.credential_id !== principal.credentialId) throw new ImError('STALE_FENCE');
    if (row.expires_at <= now) throw new ImError('LEASE_EXPIRED');
    return row;
  }
  function acquire(principal, args) {
    input(args, ['instanceId', 'requestId']); uuid(args.instanceId); uuid(args.requestId);
    return mutation(principal, (now) => {
      const hash = createHash('sha256').update(JSON.stringify([args.instanceId, principal.credentialId])).digest('hex');
      const replay = db.prepare('SELECT request_hash,result_json FROM im_lease_requests WHERE agent_id=? AND request_id=?')
        .get(principal.agentId, args.requestId);
      if (replay) {
        if (replay.request_hash !== hash) throw new ImError('IDEMPOTENCY_CONFLICT');
        return { ...JSON.parse(replay.result_json), historical: true };
      }
      const prior = lease.get(principal.agentId);
      // Even a revoked credential holds its old lease until its bounded TTL expires;
      // credential rotation never steals a still-live receiver's fence.
      if (prior?.expires_at > now) throw new ImError('LEASE_CONFLICT');
      if (prior?.generation === Number.MAX_SAFE_INTEGER) throw new ImError('STORAGE_UNAVAILABLE');
      const result = { instanceId: args.instanceId, generation: (prior?.generation ?? 0) + 1,
        expiresAt: add(now, config.lease.ttlMs), historical: false };
      db.prepare(`INSERT INTO im_receiver_leases(agent_id,instance_id,generation,expires_at,credential_id) VALUES (?,?,?,?,?)
        ON CONFLICT(agent_id) DO UPDATE SET instance_id=excluded.instance_id,generation=excluded.generation,
        expires_at=excluded.expires_at,credential_id=excluded.credential_id`)
        .run(principal.agentId, result.instanceId, result.generation, result.expiresAt, principal.credentialId);
      db.prepare('INSERT INTO im_lease_requests(agent_id,request_id,request_hash,instance_id,generation,result_json) VALUES (?,?,?,?,?,?)')
        .run(principal.agentId, args.requestId, hash, args.instanceId, result.generation, JSON.stringify(result));
      record(principal, 'acquire_receiver', { generation: result.generation }, now);
      return result;
    });
  }
  function renew(principal, args) {
    fence(args);
    return mutation(principal, (now) => {
      requireLease(principal, args, now);
      const expiresAt = add(now, config.lease.ttlMs);
      db.prepare('UPDATE im_receiver_leases SET expires_at=? WHERE agent_id=?').run(expiresAt, principal.agentId);
      record(principal, 'renew_receiver', { generation: args.generation }, now);
      return { instanceId: args.instanceId, generation: args.generation, expiresAt };
    });
  }
  function release(principal, args) {
    fence(args);
    return mutation(principal, (now) => {
      requireLease(principal, args, now);
      db.prepare('UPDATE im_receiver_leases SET expires_at=? WHERE agent_id=?').run(now, principal.agentId);
      record(principal, 'release_receiver', { generation: args.generation }, now);
      return { instanceId: args.instanceId, generation: args.generation, released: true };
    });
  }
  const delivery = db.prepare(`SELECT d.seq,m.message_id,m.conversation_id,m.sender_id,m.recipient_id,m.client_message_id,
    m.title,m.text,m.in_reply_to,m.correlation,m.accepted_at,a.attachment_id,a.name,a.mime,a.size,a.sha256
    FROM im_deliveries d JOIN im_messages m ON m.message_id=d.message_id
    LEFT JOIN im_attachments a ON a.message_id=m.message_id WHERE d.recipient_id=? AND d.seq>? ORDER BY d.seq LIMIT ?`);
  function sync(principal, args) {
    input(args, ['instanceId', 'generation'], ['after', 'streamEpoch', 'limit']);
    uuid(args.instanceId); if (!validInt(args.generation, 1)) invalid();
    if (args.after !== undefined && !validInt(args.after)) invalid();
    if (args.streamEpoch !== undefined) uuid(args.streamEpoch);
    if (args.limit !== undefined && (!validInt(args.limit, 1) || args.limit > 100)) invalid();
    return guard.runRead(() => {
    active(principal);
    const now = guard.current();
    requireLease(principal, args, now);
    const s = state.get(principal.agentId);
    if (!s) throw new ImError('STORAGE_UNAVAILABLE');
    const after = args.after ?? s.acked_through;
    if ((args.streamEpoch !== undefined && args.streamEpoch !== s.stream_epoch) || after < s.retained_floor - 1)
      throw new ImError('CURSOR_RESET_REQUIRED');
    if (after > s.acked_through) invalid();
    const limit = args.limit ?? 100;
    const expected = Math.min(limit + 1, Math.max(0, s.next_seq - 1 - after));
    const rows = delivery.all(principal.agentId, after, limit + 1);
    // A JOIN cannot return a delivery whose message is missing. Compare against
    // the durable stream watermark before exposing a truncated/empty page.
    if (rows.length !== expected || rows.some((row, index) => row.seq !== after + index + 1))
      throw new ImError('STORAGE_UNAVAILABLE');
    const items = [];
    for (const row of rows.slice(0, limit)) {
      try { acl.requireMessage(principal, row.message_id); }
      catch (error) {
        if (error?.code === 'RESOURCE_NOT_FOUND') throw new ImError('SYNC_BLOCKED');
        throw error;
      }
      items.push({ seq: row.seq, message: {
        messageId: row.message_id, conversationId: row.conversation_id, senderAgentId: row.sender_id,
        recipientAgentId: row.recipient_id, clientMessageId: row.client_message_id, title: row.title,
        text: row.text, inReplyTo: row.in_reply_to, correlation: row.correlation, acceptedAt: row.accepted_at,
        attachment: row.attachment_id === null ? null : { attachmentId: row.attachment_id,
          name: row.name, mime: row.mime, size: row.size, sha256: row.sha256 },
      } });
    }
    return { streamEpoch: s.stream_epoch, ackedThrough: s.acked_through,
      items, pageAfter: items.at(-1)?.seq ?? after, hasMore: rows.length > items.length };
    });
  }
  function ack(principal, args) {
    input(args, ['instanceId', 'generation', 'messageIds']);
    uuid(args.instanceId); if (!validInt(args.generation, 1)) invalid();
    if (!Array.isArray(args.messageIds) || args.messageIds.length < 1 || args.messageIds.length > 100) invalid();
    for (const id of args.messageIds) uuid(id);
    if (new Set(args.messageIds).size !== args.messageIds.length) invalid();
    return mutation(principal, (now) => {
      requireLease(principal, args, now);
      const lookup = db.prepare('SELECT seq FROM im_deliveries WHERE recipient_id=? AND message_id=?');
      const sequences = args.messageIds.map(id => {
        const row = lookup.get(principal.agentId, id);
        if (!row) throw new ImError('RESOURCE_NOT_FOUND');
        acl.requireMessage(principal, id);
        return row.seq;
      });
      const update = db.prepare('UPDATE im_deliveries SET acked_at=? WHERE recipient_id=? AND seq=? AND acked_at IS NULL');
      for (const seq of sequences) update.run(now, principal.agentId, seq);
      const s = state.get(principal.agentId);
      if (!s) throw new ImError('STORAGE_UNAVAILABLE');
      let through = s.acked_through;
      const next = db.prepare('SELECT acked_at FROM im_deliveries WHERE recipient_id=? AND seq=?');
      while (through < s.next_seq - 1) {
        const candidate = next.get(principal.agentId, through + 1);
        if (!candidate || candidate.acked_at === null) break;
        through++;
      }
      if (through !== s.acked_through) db.prepare('UPDATE im_receive_state SET acked_through=? WHERE agent_id=?').run(through, principal.agentId);
      record(principal, 'ack_delivery', { count: sequences.length, ackedThrough: through }, now);
      return { ackedThrough: through };
    });
  }
  return Object.freeze({ acquire, renew, release, sync, ack });
}
