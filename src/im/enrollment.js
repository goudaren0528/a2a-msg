import { createHash, randomBytes } from 'node:crypto';
import { assertImSchema } from './schema.js';
import { ImError } from './contracts.js';
import { resolveImTimeGuard } from './clock.js';
import { parseImConfig } from './config.js';

// One-time invite codes are 32 random bytes in unpadded base64url (43 characters).
export const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// Agent-created invites are deliberately short-lived and capped per rolling day.
export const AGENT_INVITE_MIN_TTL_MS = 60_000;
export const AGENT_INVITE_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const AGENT_INVITE_DEFAULT_TTL_MS = AGENT_INVITE_MAX_TTL_MS;
export const DEFAULT_DAILY_INVITE_LIMIT = 5;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const own = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const allowKeys = (value, allowed) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(key => allowed.includes(key));
const displayName = value => typeof value === 'string' && value.length >= 1 && value.length <= 255 &&
  !/[\x00-\x1f\x7f]/.test(value);

// Device-side default display name: the local hostname reduced to a printable
// label. Characters outside [A-Za-z0-9._-] (spaces, Unicode, control bytes) are
// replaced, runs collapse to one '-', and an empty result falls back to
// 'device', so the value always passes the enrollment displayName check.
export function defaultDisplayName(hostname) {
  const cleaned = String(hostname ?? '').replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 255).replace(/^-+|-+$/g, '');
  return cleaned.length >= 1 ? cleaned : 'device';
}
const schemaMismatch = () => Object.assign(
  new Error('IM storage schema does not match the supported migration'), { code: 'IM_SCHEMA_MISMATCH' });

/**
 * Enrollment module.
 *
 * `redeem` is the public, unauthenticated redemption path. On a v5 invite that
 * carries `inviter_agent_id`, redemption also makes the inviter and the new
 * Agent accepted contacts (one `im_contacts` row plus one accepted
 * `im_contact_requests` row) inside the same transaction, so no follow-up
 * request/accept round-trip is needed. Administrator invites (no inviter) keep
 * the previous behavior and establish no contact.
 *
 * `createInvite` / `revokeInvite` are the authenticated Agent path. They require
 * the validated policy and an `auth` module; construction without them keeps the
 * public redemption-only shape used by older callers.
 */
export function createImEnrollment({ db, clock = Date.now, timeGuard, random = randomBytes, policy, auth } = {}) {
  assertImSchema(db);
  const version = db.prepare('SELECT version FROM im_schema').get()?.version;
  // Redemption works on v4 (administrator invites only) and v5 (inviter-bound invites).
  if (![4, 5].includes(version)) throw schemaMismatch();
  const guard = resolveImTimeGuard(db, clock, timeGuard);
  // Selecting `inviter_agent_id` on a v4 database would fail: pin the statement
  // shape to the observed version instead of migrating implicitly.
  const lookup = version === 5
    ? db.prepare(`SELECT invite_id,expires_at,used_at,revoked_at,inviter_agent_id
        FROM im_enrollment_invites WHERE code_hash=?`)
    : db.prepare(`SELECT invite_id,expires_at,used_at,revoked_at,NULL AS inviter_agent_id
        FROM im_enrollment_invites WHERE code_hash=?`);
  const hash = value => createHash('sha256').update(value).digest('hex');
  let config;
  try { config = policy === undefined ? undefined : parseImConfig(policy); }
  catch { config = undefined; }
  const agentPath = () => {
    if (version !== 5) throw schemaMismatch();
    if (!config || typeof auth?.assertActive !== 'function') throw new ImError('POLICY_NOT_CONFIGURED');
  };
  const writesEnabled = () => config.writeMode === 'enabled' &&
    db.prepare('SELECT write_mode FROM im_settings WHERE singleton=1').get()?.write_mode === 'enabled';
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
  // Missing, used, revoked and expired are deliberately distinct fixed codes.
  function classify(row, now) {
    if (!row) throw new ImError('INVITE_NOT_FOUND');
    if (row.used_at !== null) throw new ImError('INVITE_ALREADY_USED');
    if (row.revoked_at !== null) throw new ImError('INVITE_REVOKED');
    if (row.expires_at <= now) throw new ImError('INVITE_EXPIRED');
  }
  // The inviter must still be able to hold contacts at redemption time; a
  // disabled or revoked inviter aborts before the invite is spent.
  function requireInviter(inviterAgentId) {
    const inviter = db.prepare('SELECT status,revoked_at FROM im_agents WHERE agent_id=?').get(inviterAgentId);
    if (!inviter || inviter.status !== 'active' || inviter.revoked_at !== null) throw new ImError('INVITER_UNAVAILABLE');
  }
  // Only this exact pair receives a contact row; nothing global is touched.
  function establishFriendship(inviterAgentId, agentId, now) {
    const [agentLow, agentHigh] = [inviterAgentId, agentId].sort();
    const existing = db.prepare('SELECT version FROM im_contacts WHERE agent_low=? AND agent_high=?')
      .get(agentLow, agentHigh);
    if (existing && existing.version >= Number.MAX_SAFE_INTEGER) throw new ImError('STORAGE_UNAVAILABLE');
    const contactVersion = (existing?.version ?? 0) + 1;
    db.prepare(`INSERT INTO im_contacts(agent_low,agent_high,allowed,version,updated_at) VALUES (?,?,1,?,?)
      ON CONFLICT(agent_low,agent_high) DO UPDATE SET allowed=1,version=excluded.version,updated_at=excluded.updated_at`)
      .run(agentLow, agentHigh, contactVersion, now);
    // A single accepted row per pair keeps `/contact-requests` consistent with the
    // ACL and lets either side revoke the relationship later.
    db.prepare(`INSERT INTO im_contact_requests(request_id,requester_id,target_id,status,version,created_at,updated_at)
      VALUES (?,?,?,'accepted',1,?,?)`).run(newId(), inviterAgentId, agentId, now, now);
    return contactVersion;
  }
  function redeem(input) {
    if (!own(input, ['inviteCode', 'displayName']) || typeof input.inviteCode !== 'string' ||
        !INVITE_CODE_PATTERN.test(input.inviteCode) || !displayName(input.displayName)) {
      throw new ImError('INVALID_REQUEST');
    }
    const codeHash = hash(input.inviteCode);
    return guard.runWrite(() => {
      const now = guard.current();
      const row = lookup.get(codeHash);
      classify(row, now);
      if (row.inviter_agent_id !== null) requireInviter(row.inviter_agent_id);
      const agentId = newId();
      const streamEpoch = newId();
      db.prepare("INSERT INTO im_agents(agent_id,display_name,status,created_at) VALUES (?,?,'active',?)")
        .run(agentId, input.displayName, now);
      db.prepare('INSERT INTO im_receive_state(agent_id,next_seq,acked_through,retained_floor,stream_epoch) VALUES (?,1,0,1,?)')
        .run(agentId, streamEpoch);
      const credentialId = newId();
      const secret = bytes(32).toString('base64url');
      const credential = `${credentialId}.${secret}`;
      db.prepare('INSERT INTO im_credentials(credential_id,agent_id,secret_hash,created_at,expires_at) VALUES (?,?,?,?,NULL)')
        .run(credentialId, agentId, createHash('sha256').update(secret).digest('hex'), now);
      const applied = db.prepare(`UPDATE im_enrollment_invites SET used_at=?,used_agent_id=?
        WHERE invite_id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
        .run(now, agentId, row.invite_id, now);
      if (applied.changes !== 1) classify(lookup.get(codeHash), now);
      const details = row.inviter_agent_id === null
        ? { inviteId: row.invite_id }
        : { inviteId: row.invite_id, inviterAgentId: row.inviter_agent_id, autoFriend: true };
      if (row.inviter_agent_id !== null) establishFriendship(row.inviter_agent_id, agentId, now);
      db.prepare(`INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json)
        VALUES ('system','enrollment','enroll_agent',?,?,?)`)
        .run(JSON.stringify([agentId]), now, JSON.stringify(details));
      return { agentId, displayName: input.displayName, credentialId, credential, expiresAt: null };
    });
  }
  // An active Agent may invite a new device bound to itself. Limits are fixed
  // server-side: TTL <= 24h, a rolling 24h creation cap per inviter, and the
  // administrator kill switch `policy.enrollment.agentsCanInvite`.
  function createInvite(principal, input = {}) {
    agentPath();
    if (!allowKeys(input, ['ttlMs']) || (Object.hasOwn(input, 'ttlMs') &&
        (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < AGENT_INVITE_MIN_TTL_MS ||
         input.ttlMs > AGENT_INVITE_MAX_TTL_MS))) {
      throw new ImError('INVALID_REQUEST');
    }
    const ttlMs = Object.hasOwn(input, 'ttlMs') ? input.ttlMs : AGENT_INVITE_DEFAULT_TTL_MS;
    return guard.runWrite(() => {
      if (!config.enabled) throw new ImError('IM_DISABLED');
      auth.assertActive(principal);
      if (config.enrollment.agentsCanInvite !== true) throw new ImError('AGENT_INVITES_DISABLED');
      if (!writesEnabled()) throw new ImError('NEW_WRITES_DISABLED');
      const now = guard.current();
      const limit = config.enrollment.dailyInviteLimit ?? DEFAULT_DAILY_INVITE_LIMIT;
      const used = db.prepare(`SELECT count(*) AS n FROM im_enrollment_invites
        WHERE inviter_agent_id=? AND created_at > ?`).get(principal.agentId, now - DAILY_WINDOW_MS).n;
      if (used >= limit) throw new ImError('INVITE_LIMIT_REACHED');
      const expiresAt = now + ttlMs;
      const inviteId = newId();
      // The plaintext code is returned once and never stored or audited.
      const code = bytes(32).toString('base64url');
      db.prepare(`INSERT INTO im_enrollment_invites(invite_id,code_hash,created_at,expires_at,inviter_agent_id)
        VALUES (?,?,?,?,?)`)
        .run(inviteId, hash(code), now, expiresAt, principal.agentId);
      db.prepare(`INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json)
        VALUES ('agent',?,?,?,?,?)`).run(principal.agentId, 'create_enrollment_invite',
        JSON.stringify([inviteId]), now, JSON.stringify({ expiresAt, ttlMs }));
      return { inviteId, code, expiresAt, ttlMs };
    });
  }
  // Only the inviter may revoke, and only before redemption. Revocation stays
  // available even when `agentsCanInvite` was turned off: it is a safety action.
  function revokeInvite(principal, input = {}) {
    agentPath();
    if (!own(input, ['inviteId']) || typeof input.inviteId !== 'string' || !UUID.test(input.inviteId))
      throw new ImError('INVALID_REQUEST');
    return guard.runWrite(() => {
      if (!config.enabled) throw new ImError('IM_DISABLED');
      auth.assertActive(principal);
      const now = guard.current();
      const row = db.prepare(`SELECT inviter_agent_id,used_at,revoked_at FROM im_enrollment_invites
        WHERE invite_id=?`).get(input.inviteId);
      // Unknown, non-owned and already-used invites are indistinguishable.
      if (!row || row.inviter_agent_id !== principal.agentId || row.used_at !== null)
        throw new ImError('RESOURCE_NOT_FOUND');
      if (row.revoked_at !== null) return { inviteId: input.inviteId, revokedAt: row.revoked_at };
      const applied = db.prepare(`UPDATE im_enrollment_invites SET revoked_at=?
        WHERE invite_id=? AND revoked_at IS NULL AND used_at IS NULL`).run(now, input.inviteId);
      if (applied.changes !== 1) throw new ImError('RESOURCE_NOT_FOUND');
      db.prepare(`INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json)
        VALUES ('agent',?,?,?,?,?)`).run(principal.agentId, 'revoke_enrollment_invite',
        JSON.stringify([input.inviteId]), now, JSON.stringify({}));
      return { inviteId: input.inviteId, revokedAt: now };
    });
  }
  return Object.freeze({ redeem, createInvite, revokeInvite });
}
