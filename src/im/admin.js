import { createHash, randomBytes } from 'node:crypto';
import { assertImSchema } from './schema.js';
import { ImError } from './contracts.js';
import { resolveImTimeGuard } from './clock.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const validId = (id) => typeof id === 'string' && UUID.test(id);
const required = (ok) => { if (!ok) throw new ImError('INVALID_REQUEST'); };
const safeTime = (value) => Number.isSafeInteger(value) && value >= 0;
const reasonOK = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);

export function createImAdmin({ db, clock = Date.now, timeGuard, random = randomBytes, authorizeAdmin, protectCredential } = {}) {
  assertImSchema(db);
  const guard = resolveImTimeGuard(db, clock, timeGuard);
  if (typeof authorizeAdmin !== 'function' || authorizeAdmin.constructor?.name === 'AsyncFunction') {
    throw new ImError('POLICY_NOT_CONFIGURED');
  }
  if (protectCredential !== undefined &&
      (typeof protectCredential !== 'function' || protectCredential.constructor?.name === 'AsyncFunction')) {
    throw new ImError('POLICY_NOT_CONFIGURED');
  }
  function thenable(value) {
    try {
      if (value === null || (typeof value !== 'object' && typeof value !== 'function') ||
          typeof value.then !== 'function') return false;
      // Observe eventual rejection without allowing an asynchronous result to count as completion.
      Promise.resolve(value).catch(() => {});
      return true;
    } catch { return true; }
  }
  function authorize(context) {
    const granted = authorizeAdmin(context);
    if (granted && typeof granted.then === 'function') throw new ImError('POLICY_NOT_CONFIGURED');
    if (granted !== true) throw new ImError('OPERATION_FORBIDDEN');
  }
  function bytes(length) {
    const value = random(length);
    if (!Buffer.isBuffer(value) || value.length !== length) throw new ImError('POLICY_NOT_CONFIGURED');
    return value;
  }
  function newId() {
    const value = Buffer.from(bytes(16));
    value[6] = (value[6] & 0x0f) | 0x40;
    value[8] = (value[8] & 0x3f) | 0x80;
    const hex = value.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function audit(action, targets, details, now) {
    db.prepare(`INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json)
      VALUES ('admin','admin',?,?,?,?)`).run(action, JSON.stringify(targets), now, JSON.stringify(details));
  }
  function write(context, callback) {
    authorize(context);
    return guard.runWrite(() => callback(guard.current()));
  }
  function registerAgent(input, context) {
    required(own(input, ['displayName']) && typeof input.displayName === 'string' &&
      input.displayName.length >= 1 && input.displayName.length <= 255 && !/[\x00-\x1f\x7f]/.test(input.displayName));
    return write(context, (now) => {
      const agentId = newId();
      const streamEpoch = newId();
      db.prepare(`INSERT INTO im_agents(agent_id,display_name,status,created_at) VALUES (?,?,'active',?)`).run(agentId, input.displayName, now);
      db.prepare('INSERT INTO im_receive_state(agent_id,next_seq,acked_through,retained_floor,stream_epoch) VALUES (?,1,0,1,?)').run(agentId, streamEpoch);
      audit('register_agent', { agentId }, {}, now);
      return { agentId, displayName: input.displayName, status: 'active', streamEpoch };
    });
  }
  function issueCredential(input, context) {
    required(own(input, ['agentId', 'expiresAt']) && validId(input.agentId) &&
      (input.expiresAt === null || safeTime(input.expiresAt)));
    let discard;
    let credentialIdForCleanup;
    try { return write(context, (now) => {
      required(input.expiresAt === null || input.expiresAt > now);
      const agent = db.prepare('SELECT status,revoked_at FROM im_agents WHERE agent_id=?').get(input.agentId);
      if (!agent || agent.status !== 'active' || agent.revoked_at !== null) throw new ImError('RESOURCE_NOT_FOUND');
      const credentialId = newId();
      credentialIdForCleanup = credentialId;
      const secret = bytes(32).toString('base64url');
      const credential = `${credentialId}.${secret}`;
      const hash = createHash('sha256').update(secret).digest('hex');
      // Trusted server-side callback protects generated material before activation.
      if (protectCredential !== undefined) {
        const protection = protectCredential({ credentialId, agentId: input.agentId, credential });
        if (thenable(protection) || typeof protection !== 'function') throw new ImError('POLICY_NOT_CONFIGURED');
        discard = protection;
        if (discard.constructor?.name === 'AsyncFunction') {
          discard = undefined;
          const failure = new ImError('STORAGE_UNAVAILABLE');
          failure.credentialId = credentialIdForCleanup;
          throw failure;
        }
      }
      db.prepare('INSERT INTO im_credentials(credential_id,agent_id,secret_hash,created_at,expires_at) VALUES (?,?,?,?,?)')
        .run(credentialId, input.agentId, hash, now, input.expiresAt);
      audit('issue_credential', { agentId: input.agentId, credentialId }, { expiresAt: input.expiresAt }, now);
      return { credentialId, agentId: input.agentId, credential, expiresAt: input.expiresAt };
    }); } catch (error) {
      if (discard) {
        let cleanupUnconfirmed = false;
        try { cleanupUnconfirmed = thenable(discard()); } catch { cleanupUnconfirmed = true; }
        if (cleanupUnconfirmed) {
          const failure = new ImError('STORAGE_UNAVAILABLE');
          failure.credentialId = credentialIdForCleanup;
          throw failure;
        }
      }
      throw error;
    }
  }
  function revokeCredential(input, context) {
    required(own(input, ['credentialId', 'reason']) && validId(input.credentialId) && reasonOK(input.reason));
    return write(context, (now) => {
      const result = db.prepare('UPDATE im_credentials SET revoked_at=? WHERE credential_id=? AND revoked_at IS NULL').run(now, input.credentialId);
      if (!result.changes) throw new ImError('RESOURCE_NOT_FOUND');
      audit('revoke_credential', { credentialId: input.credentialId }, { reason: input.reason }, now);
      return { credentialId: input.credentialId, revokedAt: now };
    });
  }
  function setAgentStatus(input, context) {
    required(own(input, ['agentId', 'status', 'reason']) && validId(input.agentId) &&
      ['active', 'disabled'].includes(input.status) && reasonOK(input.reason));
    return write(context, (now) => {
      const row = db.prepare('SELECT status,revoked_at FROM im_agents WHERE agent_id=?').get(input.agentId);
      if (!row || row.revoked_at !== null) throw new ImError('RESOURCE_NOT_FOUND');
      db.prepare('UPDATE im_agents SET status=? WHERE agent_id=?').run(input.status, input.agentId);
      audit('set_agent_status', { agentId: input.agentId }, { status: input.status, reason: input.reason }, now);
      return { agentId: input.agentId, status: input.status };
    });
  }
  function setContact(input, context) {
    required(own(input, ['agentA', 'agentB', 'allowed', 'reason']) && validId(input.agentA) &&
      validId(input.agentB) && input.agentA !== input.agentB && typeof input.allowed === 'boolean' && reasonOK(input.reason));
    return write(context, (now) => {
      const [agentLow, agentHigh] = [input.agentA, input.agentB].sort();
      for (const id of [agentLow, agentHigh]) {
        const row = db.prepare('SELECT status,revoked_at FROM im_agents WHERE agent_id=?').get(id);
        if (!row || (input.allowed && row.status !== 'active') || row.revoked_at !== null) throw new ImError('RESOURCE_NOT_FOUND');
      }
      const existing = db.prepare('SELECT version FROM im_contacts WHERE agent_low=? AND agent_high=?').get(agentLow, agentHigh);
      if (existing && existing.version === Number.MAX_SAFE_INTEGER) throw new ImError('STORAGE_UNAVAILABLE');
      const version = (existing?.version ?? 0) + 1;
      db.prepare(`INSERT INTO im_contacts(agent_low,agent_high,allowed,version,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(agent_low,agent_high) DO UPDATE SET allowed=excluded.allowed,version=excluded.version,updated_at=excluded.updated_at`)
        .run(agentLow, agentHigh, Number(input.allowed), version, now);
      audit('set_contact', { agentLow, agentHigh }, { allowed: input.allowed, version, reason: input.reason }, now);
      return { agentLow, agentHigh, allowed: input.allowed, version };
    });
  }
  function takeoverReceiver(input, context) {
    required(own(input, ['agentId', 'reason']) && validId(input.agentId) && reasonOK(input.reason));
    return write(context, (now) => {
      if (!db.prepare('SELECT 1 FROM im_agents WHERE agent_id=?').get(input.agentId)) throw new ImError('RESOURCE_NOT_FOUND');
      const lease = db.prepare('SELECT generation,expires_at FROM im_receiver_leases WHERE agent_id=?').get(input.agentId);
      let changed = false;
      let generation = lease?.generation ?? null;
      if (lease && lease.expires_at > now) {
        if (generation === Number.MAX_SAFE_INTEGER) throw new ImError('STORAGE_UNAVAILABLE');
        generation++;
        db.prepare('UPDATE im_receiver_leases SET generation=?,expires_at=? WHERE agent_id=?').run(generation, now, input.agentId);
        changed = true;
      }
      audit('takeover_receiver', { agentId: input.agentId }, { reason: input.reason, changed, generation }, now);
      return { agentId: input.agentId, changed, generation };
    });
  }
  return Object.freeze({ registerAgent, issueCredential, revokeCredential, setAgentStatus, setContact, takeoverReceiver });
}
