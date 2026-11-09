import { randomUUID } from 'node:crypto';
import { assertImSchema } from './schema.js';
import { ImError } from './contracts.js';
import { resolveImTimeGuard } from './clock.js';
import { parseImConfig } from './config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIRECTIONS = Object.freeze(['incoming', 'outgoing', 'all']);
const fail = code => { throw new ImError(code); };
const valid = value => typeof value === 'string' && UUID.test(value);
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(key => keys.includes(key));
const requiredInput = (value, required, optional = []) => {
  if (!exact(value, [...required, ...optional]) || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_REQUEST');
};

// The canonical contact row (`im_contacts.allowed`) remains the ACL source of
// truth. This module keeps it in sync with the request state machine so the
// existing requirePeer checks enforce ACCEPTED on the server for every route.
export function createImContacts({ db, auth, clock = Date.now, timeGuard, policy } = {}) {
  assertImSchema(db);
  if (![4, 5].includes(db.prepare('SELECT version FROM im_schema').get()?.version)) {
    throw Object.assign(new Error('IM storage schema does not match the supported migration'),
      { code: 'IM_SCHEMA_MISMATCH' });
  }
  const guard = resolveImTimeGuard(db, clock, timeGuard);
  if (typeof auth?.assertActive !== 'function' || typeof clock !== 'function') fail('POLICY_NOT_CONFIGURED');
  const config = structuredClone(parseImConfig(policy));
  const enabled = () => { if (!config.enabled) fail('IM_DISABLED'); };
  const requestsEnabled = () => { if (config.contacts.requests !== 'enabled') fail('POLICY_NOT_CONFIGURED'); };
  const readable = principal => { enabled(); auth.assertActive(principal); requestsEnabled(); };
  const writable = principal => {
    readable(principal);
    if (config.writeMode !== 'enabled' ||
        db.prepare('SELECT write_mode FROM im_settings WHERE singleton=1').get()?.write_mode !== 'enabled')
      fail('NEW_WRITES_DISABLED');
  };

  const agent = db.prepare('SELECT display_name,status,revoked_at FROM im_agents WHERE agent_id=?');
  const contact = db.prepare('SELECT allowed,version FROM im_contacts WHERE agent_low=? AND agent_high=?');
  const byId = db.prepare('SELECT * FROM im_contact_requests WHERE request_id=?');
  const byPair = db.prepare(`SELECT * FROM im_contact_requests
    WHERE (requester_id=? AND target_id=?) OR (requester_id=? AND target_id=?)`);
  const audit = db.prepare(`INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json)
    VALUES ('agent',?,?,?,?,?)`);

  function activePeer(agentId) {
    const row = agent.get(agentId);
    if (!row || row.status !== 'active' || row.revoked_at !== null) fail('RESOURCE_NOT_FOUND');
    return row;
  }
  function nextVersion(version) {
    if (!Number.isSafeInteger(version) || version < 1 || version >= Number.MAX_SAFE_INTEGER) fail('STORAGE_UNAVAILABLE');
    return version + 1;
  }
  function record(principal, action, row, now) {
    audit.run(principal.agentId, action, JSON.stringify([row.request_id, row.requester_id, row.target_id]),
      now, JSON.stringify({ status: row.status, version: row.version }));
  }
  function setAllowed(principal, peerAgentId, allowed, now) {
    const [agentLow, agentHigh] = [principal.agentId, peerAgentId].sort();
    const existing = contact.get(agentLow, agentHigh);
    if (!allowed && (!existing || existing.allowed === 0)) return existing?.version ?? null;
    const version = (existing?.version ?? 0) + 1;
    if (version > Number.MAX_SAFE_INTEGER) fail('STORAGE_UNAVAILABLE');
    db.prepare(`INSERT INTO im_contacts(agent_low,agent_high,allowed,version,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(agent_low,agent_high) DO UPDATE SET allowed=excluded.allowed,version=excluded.version,
      updated_at=excluded.updated_at`).run(agentLow, agentHigh, allowed ? 1 : 0, version, now);
    return version;
  }
  function peerOf(row, principal) {
    const direction = row.requester_id === principal.agentId ? 'outgoing' : 'incoming';
    return { direction, peerAgentId: direction === 'outgoing' ? row.target_id : row.requester_id };
  }
  function dto(row, principal) {
    const { direction, peerAgentId } = peerOf(row, principal);
    const peer = agent.get(peerAgentId);
    return { requestId: row.request_id, requesterAgentId: row.requester_id, targetAgentId: row.target_id,
      peerAgentId, peerDisplayName: peer?.display_name ?? null, direction, status: row.status,
      version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function pairRow(agentA, agentB) { return byPair.get(agentA, agentB, agentB, agentA); }
  function setStatus(row, status, now) {
    const version = nextVersion(row.version);
    db.prepare('UPDATE im_contact_requests SET status=?,version=?,updated_at=? WHERE request_id=?')
      .run(status, version, now, row.request_id);
    return byId.get(row.request_id);
  }
  function resetDirection(row, requesterId, targetId, now) {
    const version = nextVersion(row.version);
    db.prepare(`UPDATE im_contact_requests SET requester_id=?,target_id=?,status='pending',version=?,updated_at=?
      WHERE request_id=?`).run(requesterId, targetId, version, now, row.request_id);
    return byId.get(row.request_id);
  }
  function accept(row, principal, now, action = 'contact_request_accepted') {
    const peer = row.requester_id === principal.agentId ? row.target_id : row.requester_id;
    activePeer(peer);
    const accepted = setStatus(row, 'accepted', now);
    setAllowed(principal, peer, true, now);
    record(principal, action, accepted, now);
    return dto(accepted, principal);
  }

  // A request is pending, or - when the other person already asked - accepting
  // it is mutual consent. One row per pair keeps the state and ACL unambiguous.
  function request(principal, input) {
    requiredInput(input, ['peerAgentId']);
    if (!valid(input.peerAgentId) || input.peerAgentId === principal.agentId) fail('INVALID_REQUEST');
    return guard.runWrite(() => {
      writable(principal);
      activePeer(input.peerAgentId);
      const now = guard.current();
      const [agentLow, agentHigh] = [principal.agentId, input.peerAgentId].sort();
      const allowed = contact.get(agentLow, agentHigh)?.allowed === 1;
      const existing = pairRow(principal.agentId, input.peerAgentId);
      if (allowed) {
        if (existing?.status === 'accepted') return dto(existing, principal);
        // An administrator may have granted the contact without an accepted row.
        const row = existing
          ? setStatus(existing, 'accepted', now)
          : (() => {
              const requestId = randomUUID();
              db.prepare(`INSERT INTO im_contact_requests(request_id,requester_id,target_id,status,version,created_at,updated_at)
                VALUES (?,?,?,'accepted',1,?,?)`).run(requestId, principal.agentId, input.peerAgentId, now, now);
              return byId.get(requestId);
            })();
        record(principal, 'contact_request_accepted', row, now);
        return dto(row, principal);
      }
      if (existing?.status === 'pending') {
        if (existing.requester_id === principal.agentId) return dto(existing, principal);
        return accept(existing, principal, now);
      }
      // rejected/revoked rows are reusable; a stale accepted row (administrator
      // revoked the contact) starts a new pending cycle in the caller's direction.
      const row = existing
        ? resetDirection(existing, principal.agentId, input.peerAgentId, now)
        : (() => {
            const requestId = randomUUID();
            db.prepare(`INSERT INTO im_contact_requests(request_id,requester_id,target_id,status,version,created_at,updated_at)
              VALUES (?,?,?,'pending',1,?,?)`).run(requestId, principal.agentId, input.peerAgentId, now, now);
            return byId.get(requestId);
          })();
      record(principal, 'contact_request_sent', row, now);
      return dto(row, principal);
    });
  }

  function respond(principal, input) {
    requiredInput(input, ['requestId', 'action']);
    if (!valid(input.requestId) || !['accept', 'reject'].includes(input.action)) fail('INVALID_REQUEST');
    return guard.runWrite(() => {
      writable(principal);
      const row = byId.get(input.requestId);
      if (!row) fail('RESOURCE_NOT_FOUND');
      if (row.target_id !== principal.agentId) fail('RESOURCE_NOT_FOUND');
      if (row.status !== 'pending') fail('CONTACT_REQUEST_CONFLICT');
      const now = guard.current();
      if (input.action === 'accept') return accept(row, principal, now);
      const rejected = setStatus(row, 'rejected', now);
      record(principal, 'contact_request_rejected', rejected, now);
      return dto(rejected, principal);
    });
  }

  // The requester cancels their own pending request; either party may revoke an
  // accepted relationship. Revocation immediately denies the shared contact, so
  // existing conversations, history, attachments and receive cursors go hidden.
  function revoke(principal, input) {
    requiredInput(input, ['requestId']);
    if (!valid(input.requestId)) fail('INVALID_REQUEST');
    return guard.runWrite(() => {
      writable(principal);
      const row = byId.get(input.requestId);
      if (!row) fail('RESOURCE_NOT_FOUND');
      const requester = row.requester_id === principal.agentId;
      const target = row.target_id === principal.agentId;
      if (!requester && !target) fail('RESOURCE_NOT_FOUND');
      if (row.status === 'revoked') return dto(row, principal);
      if (row.status === 'rejected' || row.status === 'pending' && target) fail('CONTACT_REQUEST_CONFLICT');
      const now = guard.current();
      const revoked = setStatus(row, 'revoked', now);
      if (row.status === 'accepted') {
        const peer = requester ? row.target_id : row.requester_id;
        setAllowed(principal, peer, false, now);
      }
      record(principal, 'contact_revoked', revoked, now);
      return dto(revoked, principal);
    });
  }

  const cursor = (scope, key) => Buffer.from(JSON.stringify(['contact-requests', scope, key])).toString('base64url');
  function page(input, agentId) {
    requiredInput(input, [], ['direction', 'after', 'limit']);
    const direction = input.direction ?? 'all';
    if (!DIRECTIONS.includes(direction)) fail('INVALID_REQUEST');
    const scope = `${agentId}:${direction}`;
    const limit = input.limit === undefined ? 20 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_REQUEST');
    let after = null;
    if (input.after !== undefined) {
      if (typeof input.after !== 'string' || input.after.length > 512 || !/^[A-Za-z0-9_-]+$/.test(input.after))
        fail('INVALID_REQUEST');
      try {
        if (Buffer.from(input.after, 'base64url').toString('base64url') !== input.after) fail('INVALID_REQUEST');
        const value = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8'));
        if (!Array.isArray(value) || value.length !== 3 || value[0] !== 'contact-requests' || value[1] !== scope ||
            !Array.isArray(value[2]) || value[2].length !== 2 || !Number.isSafeInteger(value[2][0]) ||
            !valid(value[2][1])) fail('INVALID_REQUEST');
        after = value[2];
      } catch { fail('INVALID_REQUEST'); }
    }
    return { direction, limit, after, scope };
  }

  function list(principal, input = {}) {
    return guard.runRead(() => {
      readable(principal);
      const { direction, limit, after, scope } = page(input, principal.agentId);
      const filters = ['(requester_id=? OR target_id=?)'];
      const args = [principal.agentId, principal.agentId];
      if (direction === 'outgoing') { filters.push('requester_id=?'); args.push(principal.agentId); }
      if (direction === 'incoming') { filters.push('target_id=?'); args.push(principal.agentId); }
      if (after) {
        filters.push('(updated_at>? OR (updated_at=? AND request_id>?))');
        args.push(after[0], after[0], after[1]);
      }
      const rows = db.prepare(`SELECT * FROM im_contact_requests WHERE ${filters.join(' AND ')}
        ORDER BY updated_at,request_id LIMIT ?`).all(...args, limit + 1);
      return {
        items: rows.slice(0, limit).map(row => dto(row, principal)),
        nextCursor: rows.length > limit
          ? cursor(scope, [rows[limit - 1].updated_at, rows[limit - 1].request_id]) : null,
      };
    });
  }

  return Object.freeze({ request, respond, revoke, list });
}
