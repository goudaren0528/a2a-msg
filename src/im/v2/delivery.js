import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ImV2Error, scopeSchema, fenceSchema, deliveryRefSchema, dataSchemas, MAX_PREFIX_STEPS } from './contracts.js';
import { parseImV2Config } from './config.js';
import { resolveImV2TimeGuard } from './clock.js';
import { assertImV2AuthBinding } from './auth.js';
import { createImV2MessageView } from './message-view.js';

const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const acquireArgs = z.object({ instanceId: uuid, requestId: uuid }).strict();
const syncArgs = fenceSchema.extend({ streamEpoch: uuid, after: integer.optional(), limit: integer.min(1).max(100).optional() }).strict();
const batchArgs = fenceSchema.extend({ streamEpoch: uuid, items: z.array(deliveryRefSchema).min(1).max(100) }).strict()
  .refine(v => new Set(v.items.map(i => i.seq)).size === v.items.length &&
    new Set(v.items.map(i => i.messageId)).size === v.items.length);
const fail = code => { throw new ImV2Error(code); };
const valid = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) fail('INVALID_REQUEST');
  return result.data;
};
const safe = number => Number.isSafeInteger(number) && number >= 0;

export function createImV2Delivery({ db, auth, acl, policy, clock = Date.now, timeGuard } = {}) {
  const config = parseImV2Config(policy);
  const guard = resolveImV2TimeGuard(db, clock, timeGuard);
  assertImV2AuthBinding(auth, db, guard);
  if (!acl || typeof acl.requireMessage !== 'function') fail('INVALID_REQUEST');
  const view = createImV2MessageView({ db });
  const sql = {
    lease: 'SELECT instance_id,generation,expires_at,credential_id FROM im_receiver_leases WHERE agent_id=?',
    receive: 'SELECT next_seq,acked_through,retained_floor,stream_epoch FROM im_receive_state WHERE agent_id=?',
    progress: 'SELECT handled_through FROM im_sync_progress WHERE recipient_id=? AND center_epoch=? AND stream_epoch=?',
    request: 'SELECT request_hash,instance_id,generation,result_json FROM im_lease_requests WHERE agent_id=? AND request_id=?',
    item: 'SELECT seq,message_id,acked_at FROM im_deliveries WHERE recipient_id=? AND seq=?',
    page: 'SELECT seq,message_id FROM im_deliveries WHERE recipient_id=? AND seq>? ORDER BY seq LIMIT ?',
    fact: `SELECT d.seq,d.message_id,d.acked_at,e.message_id AS receipt_message
      ,c.state AS content_state FROM im_deliveries d
      LEFT JOIN im_content_state c ON c.message_id=d.message_id
      LEFT JOIN im_expiry_receipts e ON e.recipient_id=d.recipient_id AND e.seq=d.seq
        AND e.center_epoch=? AND e.stream_epoch=? WHERE d.recipient_id=? AND d.seq=?`,
    content: 'SELECT state FROM im_content_state WHERE message_id=?',
    receiptIdentity: `SELECT message_id FROM im_expiry_receipts
      WHERE recipient_id=? AND center_epoch=? AND stream_epoch=? AND seq=?`,
    putLease: `INSERT INTO im_receiver_leases(agent_id,instance_id,generation,expires_at,credential_id)
      VALUES (?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET instance_id=excluded.instance_id,
      generation=excluded.generation,expires_at=excluded.expires_at,credential_id=excluded.credential_id`,
    putRequest: 'INSERT INTO im_lease_requests(agent_id,request_id,request_hash,instance_id,generation,result_json) VALUES (?,?,?,?,?,?)',
    renew: 'UPDATE im_receiver_leases SET expires_at=? WHERE agent_id=? AND instance_id=? AND generation=? AND credential_id=?',
    ack: 'UPDATE im_deliveries SET acked_at=? WHERE recipient_id=? AND seq=? AND message_id=? AND acked_at IS NULL',
    receipt: `INSERT OR IGNORE INTO im_expiry_receipts(recipient_id,center_epoch,stream_epoch,seq,message_id,recorded_at)
      VALUES (?,?,?,?,?,?)`,
    advanceAck: 'UPDATE im_receive_state SET acked_through=? WHERE agent_id=? AND acked_through=?',
    advanceHandled: `UPDATE im_sync_progress SET handled_through=?,updated_at=?
      WHERE recipient_id=? AND center_epoch=? AND stream_epoch=? AND handled_through=?`,
    audit: `INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json)
      VALUES ('agent',?,?,?,?,?)`,
  };
  let statements;
  try { statements = Object.fromEntries(Object.entries(sql).map(([name, text]) => [name, db.prepare(text)])); }
  catch { fail('STORAGE_UNAVAILABLE'); }
  function get(name, ...values) {
    try { return statements[name].get(...values); } catch { fail('STORAGE_UNAVAILABLE'); }
  }
  function all(name, ...values) {
    try { return statements[name].all(...values); } catch { fail('STORAGE_UNAVAILABLE'); }
  }
  function run(name, ...values) {
    try { return statements[name].run(...values); } catch { fail('STORAGE_UNAVAILABLE'); }
  }
  function dto(name, value) {
    const result = dataSchemas[name].safeParse(value);
    if (!result.success) fail('STORAGE_UNAVAILABLE');
    return result.data;
  }
  function audit(principal, action, details, now) {
    run('audit', principal.agentId, action, JSON.stringify({ agentId: principal.agentId }), now, JSON.stringify(details));
  }
  function deadline(now) {
    if (!config.lease) fail('POLICY_NOT_CONFIGURED');
    if (now > Number.MAX_SAFE_INTEGER - config.lease.ttlMs) fail('CLOCK_UNSAFE');
    return now + config.lease.ttlMs;
  }
  function receiver(principal) {
    const state = get('receive', principal.agentId);
    if (!state || !safe(state.next_seq) || state.next_seq < 1 || !safe(state.acked_through) ||
        !safe(state.retained_floor) || state.retained_floor < 1 || state.acked_through >= state.next_seq ||
        state.retained_floor > state.next_seq) fail('STORAGE_UNAVAILABLE');
    return state;
  }
  function progress(principal, scope, state) {
    const row = get('progress', principal.agentId, scope.centerEpoch, state.stream_epoch);
    if (!row || !safe(row.handled_through) || row.handled_through >= state.next_seq) fail('STORAGE_UNAVAILABLE');
    return row;
  }
  function lease(principal, args, now) {
    const row = get('lease', principal.agentId);
    if (!row || row.instance_id !== args.instanceId || row.generation !== args.generation ||
        row.credential_id !== principal.credentialId) fail('STALE_FENCE');
    if (!safe(row.expires_at) || row.expires_at <= now) fail('LEASE_EXPIRED');
    return row;
  }
  function refreshLease(principal, args) { guard.refreshCurrent(); lease(principal, args, guard.current()); }
  function finalLease(principal, args, expectedExpiresAt) {
    const row = lease(principal, args, guard.current());
    if (expectedExpiresAt !== undefined && row.expires_at !== expectedExpiresAt) fail('STORAGE_UNAVAILABLE');
  }
  function checkedFact(row, seq) {
    if (!row || row.seq !== seq ||
        (row.receipt_message !== null &&
          (row.receipt_message !== row.message_id || row.content_state !== 'expired')))
      fail('STORAGE_UNAVAILABLE');
    return row;
  }
  function stream(state, args) {
    if (args.streamEpoch !== state.stream_epoch) fail('CURSOR_RESET_REQUIRED');
  }
  function authorized(principal, scope, id, syncPage = false) {
    try { return acl.requireMessage(principal, scope, id); }
    catch (error) { if (syncPage && error?.code === 'RESOURCE_NOT_FOUND') fail('SYNC_BLOCKED'); throw error; }
  }
  // A shared seq cache charges each distinct delivery once across both cursor advances.
  // Never probe beyond one next item per cursor when the budget is exhausted.
  function facts(principal, scope, state, handled, acked, mutate, now) {
    const seen = new Map();
    let examined = 0;
    function candidate(seq, probe = false) {
      if (seen.has(seq)) return seen.get(seq);
      if (!probe && examined >= MAX_PREFIX_STEPS) return undefined;
      const row = checkedFact(get('fact', scope.centerEpoch, state.stream_epoch, principal.agentId, seq), seq);
      if (!probe) { seen.set(seq, row); examined++; }
      return row;
    }
    const end = state.next_seq - 1;
    while (acked < end && (examined < MAX_PREFIX_STEPS || seen.has(acked + 1))) {
      const row = candidate(acked + 1);
      if (row.acked_at === null) break;
      acked++;
    }
    while (handled < end && (examined < MAX_PREFIX_STEPS || seen.has(handled + 1))) {
      const row = candidate(handled + 1);
      if (row.acked_at === null && row.receipt_message !== row.message_id) break;
      handled++;
    }
    const pendingAt = (seq, type) => seq <= end && (seen.has(seq) ?
      (type === 'ack' ? seen.get(seq).acked_at !== null :
        seen.get(seq).acked_at !== null || seen.get(seq).receipt_message === seen.get(seq).message_id) :
      examined >= MAX_PREFIX_STEPS && (() => {
        const row = candidate(seq, true);
        return type === 'ack' ? row.acked_at !== null : row.acked_at !== null || row.receipt_message === row.message_id;
      })());
    const progressPending = Boolean(pendingAt(acked + 1, 'ack') || pendingAt(handled + 1, 'handled'));
    if (mutate) {
      if (acked !== state.acked_through && run('advanceAck', acked, principal.agentId, state.acked_through).changes !== 1) fail('STORAGE_UNAVAILABLE');
      const old = progress(principal, scope, state).handled_through;
      if (handled !== old && run('advanceHandled', handled, now, principal.agentId, scope.centerEpoch, state.stream_epoch, old).changes !== 1) fail('STORAGE_UNAVAILABLE');
    }
    return { streamEpoch: state.stream_epoch, handledThrough: handled, ackedThrough: acked, progressPending };
  }
  function progressDto(principal, scope, state) {
    const p = progress(principal, scope, state);
    const canAdvance = (seq, kind) => {
      if (seq >= state.next_seq) return false;
      const row = checkedFact(get('fact', scope.centerEpoch, state.stream_epoch, principal.agentId, seq), seq);
      return row.acked_at !== null || kind === 'handled' && row.receipt_message === row.message_id;
    };
    return { streamEpoch: state.stream_epoch, handledThrough: p.handled_through,
      ackedThrough: state.acked_through, progressPending: canAdvance(state.acked_through + 1, 'ack') ||
        canAdvance(p.handled_through + 1, 'handled') };
  }
  function acquire(principal, scope, input) {
    const s = valid(scopeSchema, scope), args = valid(acquireArgs, input);
    let acquired;
    return auth.withWrite(principal, s, () => {
      const now = guard.current(), state = receiver(principal);
      progress(principal, s, state);
      const requestId = `v2:${s.centerEpoch}:${args.requestId}`;
      const hash = createHash('sha256').update(JSON.stringify([s.centerEpoch, args.instanceId, principal.credentialId])).digest('hex');
      const prior = get('request', principal.agentId, requestId);
      if (prior) {
        if (prior.request_hash !== hash || prior.instance_id !== args.instanceId) fail('IDEMPOTENCY_CONFLICT');
        let result;
        try { result = JSON.parse(prior.result_json); } catch { fail('STORAGE_UNAVAILABLE'); }
        if (!dataSchemas.lease.safeParse(result).success || result.centerEpoch !== s.centerEpoch ||
            result.instanceId !== args.instanceId || result.generation !== prior.generation ||
            result.historical !== false) fail('STORAGE_UNAVAILABLE');
        guard.refreshCurrent();
        return dto('lease', { ...result, historical: true });
      }
      const held = get('lease', principal.agentId);
      if (held && held.expires_at > now) fail('LEASE_CONFLICT');
      if (held && (!safe(held.generation) || held.generation < 1)) fail('STORAGE_UNAVAILABLE');
      if (held?.generation === Number.MAX_SAFE_INTEGER) fail('STORAGE_UNAVAILABLE');
      const result = dto('lease', { centerEpoch: s.centerEpoch, instanceId: args.instanceId,
        generation: (held?.generation ?? 0) + 1, expiresAt: deadline(now), historical: false,
        streamEpoch: state.stream_epoch });
      run('putLease', principal.agentId, args.instanceId, result.generation, result.expiresAt, principal.credentialId);
      acquired = { instanceId: args.instanceId, generation: result.generation, expiresAt: result.expiresAt };
      run('putRequest', principal.agentId, requestId, hash, args.instanceId, result.generation, JSON.stringify(result));
      audit(principal, 'acquire_receiver', { generation: result.generation }, now);
      refreshLease(principal, result);
      return result;
    }, () => {
      // Historical responses are immutable facts, never a claim to the current lease.
      if (acquired) finalLease(principal, acquired, acquired.expiresAt);
    });
  }
  function renew(principal, scope, input) {
    const s = valid(scopeSchema, scope), args = valid(fenceSchema, input);
    let expiresAt;
    return auth.withWrite(principal, s, () => {
      const now = guard.current(); lease(principal, args, now);
      const state = receiver(principal); progress(principal, s, state);
      expiresAt = deadline(now);
      if (run('renew', expiresAt, principal.agentId, args.instanceId, args.generation, principal.credentialId).changes !== 1) fail('STORAGE_UNAVAILABLE');
      audit(principal, 'renew_receiver', { generation: args.generation }, now);
      refreshLease(principal, args);
      return dto('renew', { centerEpoch: s.centerEpoch, instanceId: args.instanceId,
        generation: args.generation, expiresAt, streamEpoch: state.stream_epoch });
    }, () => finalLease(principal, args, expiresAt));
  }
  function release(principal, scope, input) {
    const s = valid(scopeSchema, scope), args = valid(fenceSchema, input);
    let releasedAt;
    return auth.withWrite(principal, s, () => {
      const now = guard.current(); lease(principal, args, now);
      releasedAt = now;
      if (run('renew', now, principal.agentId, args.instanceId, args.generation, principal.credentialId).changes !== 1) fail('STORAGE_UNAVAILABLE');
      audit(principal, 'release_receiver', { generation: args.generation }, now);
      guard.refreshCurrent();
      const row = get('lease', principal.agentId);
      if (!row || row.instance_id !== args.instanceId || row.generation !== args.generation ||
          row.credential_id !== principal.credentialId || row.expires_at !== now) fail('STORAGE_UNAVAILABLE');
      return dto('release', { instanceId: args.instanceId, generation: args.generation, released: true });
    }, () => {
      const row = get('lease', principal.agentId);
      if (!row || row.instance_id !== args.instanceId || row.generation !== args.generation ||
          row.credential_id !== principal.credentialId || row.expires_at !== releasedAt ||
          row.expires_at > guard.current()) fail('STORAGE_UNAVAILABLE');
    });
  }
  function sync(principal, scope, input) {
    const s = valid(scopeSchema, scope), args = valid(syncArgs, input);
    return auth.withRead(principal, s, () => {
      lease(principal, args, guard.current());
      const state = receiver(principal); stream(state, args);
      const progressRow = progress(principal, s, state);
      const after = args.after ?? progressRow.handled_through;
      if (after < state.retained_floor - 1) fail('CURSOR_RESET_REQUIRED');
      if (after > progressRow.handled_through) fail('INVALID_REQUEST');
      const limit = args.limit ?? 20;
      const rows = all('page', principal.agentId, after, limit + 1);
      const expected = Math.min(limit + 1, state.next_seq - 1 - after);
      if (rows.length !== expected || rows.some((row, i) => row.seq !== after + i + 1)) fail('STORAGE_UNAVAILABLE');
      const items = rows.slice(0, limit).map(row => {
        const metadata = authorized(principal, s, row.message_id, true);
        if (metadata.recipientAgentId !== principal.agentId || metadata.messageId !== row.message_id) fail('SYNC_BLOCKED');
        const item = view.historyItem(row.message_id);
        return { ...item, centerEpoch: s.centerEpoch, streamEpoch: state.stream_epoch, seq: row.seq };
      });
      const value = progressDto(principal, s, state);
      lease(principal, args, guard.current());
      return dto('sync', { ...value, items, pageAfter: items.at(-1)?.seq ?? after, hasMore: rows.length > limit });
    });
  }
  function batch(name, principal, scope, input) {
    const s = valid(scopeSchema, scope), args = valid(batchArgs, input);
    return auth.withWrite(principal, s, () => {
      const now = guard.current(); lease(principal, args, now);
      const state = receiver(principal); stream(state, args);
      const old = progress(principal, s, state);
      const rows = args.items.map(item => {
        if (item.seq >= state.next_seq || item.seq < state.retained_floor) fail('INVALID_REQUEST');
        const row = get('item', principal.agentId, item.seq);
        if (!row || row.message_id !== item.messageId) fail('INVALID_REQUEST');
        const metadata = authorized(principal, s, item.messageId);
        if (metadata.messageId !== item.messageId || metadata.recipientAgentId !== principal.agentId) fail('RESOURCE_NOT_FOUND');
        const content = get('content', item.messageId);
        if (!content || !['live','expired'].includes(content.state) || metadata.contentState !== content.state) fail('STORAGE_UNAVAILABLE');
        if (name === 'acks' ? content.state === 'expired' && row.acked_at === null : content.state !== 'expired')
          fail(name === 'acks' ? 'EXPIRY_RECEIPT_REQUIRED' : 'CONTENT_NOT_EXPIRED');
        return { ...item, acked: row.acked_at !== null };
      });
      let changed = 0;
      for (const row of rows) {
        if (name === 'acks') {
          if (!row.acked) changed += run('ack', now, principal.agentId, row.seq, row.messageId).changes;
        } else {
          const inserted = run('receipt', principal.agentId, s.centerEpoch, state.stream_epoch,
            row.seq, row.messageId, now).changes;
          if (inserted !== 1) {
            const stored = get('receiptIdentity', principal.agentId, s.centerEpoch, state.stream_epoch, row.seq);
            if (!stored || stored.message_id !== row.messageId) fail('STORAGE_UNAVAILABLE');
          }
          changed += inserted;
        }
      }
      const result = facts(principal, s, state, old.handled_through, state.acked_through, true, now);
      if (changed) audit(principal, name === 'acks' ? 'ack_delivery' : 'expiry_receipt', { count: changed }, now);
      refreshLease(principal, args);
      return dto(name, result);
    }, () => finalLease(principal, args));
  }
  return Object.freeze({ acquire, renew, release, sync,
    ack: (principal, scope, args) => batch('acks', principal, scope, args),
    recordExpiryReceipts: (principal, scope, args) => batch('expiryReceipts', principal, scope, args) });
}
