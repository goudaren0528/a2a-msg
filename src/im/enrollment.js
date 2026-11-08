import { createHash, randomBytes } from 'node:crypto';
import { assertImSchema } from './schema.js';
import { ImError } from './contracts.js';
import { resolveImTimeGuard } from './clock.js';

// One-time invite codes are 32 random bytes in unpadded base64url (43 characters).
export const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const own = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const displayName = value => typeof value === 'string' && value.length >= 1 && value.length <= 255 &&
  !/[\x00-\x1f\x7f]/.test(value);
const schemaMismatch = () => Object.assign(
  new Error('IM storage schema does not match the supported migration'), { code: 'IM_SCHEMA_MISMATCH' });

// Public, unauthenticated redemption. Invite creation/revocation stays in createImAdmin.
export function createImEnrollment({ db, clock = Date.now, timeGuard, random = randomBytes } = {}) {
  assertImSchema(db);
  if (db.prepare('SELECT version FROM im_schema').get()?.version !== 4) throw schemaMismatch();
  const guard = resolveImTimeGuard(db, clock, timeGuard);
  const lookup = db.prepare(`SELECT invite_id,expires_at,used_at,revoked_at
    FROM im_enrollment_invites WHERE code_hash=?`);
  const hash = value => createHash('sha256').update(value).digest('hex');
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
      db.prepare(`INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json)
        VALUES ('system','enrollment','enroll_agent',?,?,?)`)
        .run(JSON.stringify([agentId]), now, JSON.stringify({ inviteId: row.invite_id }));
      return { agentId, displayName: input.displayName, credentialId, credential, expiresAt: null };
    });
  }
  return Object.freeze({ redeem });
}
