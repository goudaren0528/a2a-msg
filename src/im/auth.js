import { createHash, timingSafeEqual } from 'node:crypto';
import { assertImSchema } from './schema.js';
import { ImError } from './contracts.js';
import { resolveImTimeGuard } from './clock.js';

const CREDENTIAL = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export function createImAuth({ db, clock = Date.now, timeGuard } = {}) {
  assertImSchema(db);
  const guard = resolveImTimeGuard(db, clock, timeGuard);
  const issued = new WeakSet();
  const lookup = db.prepare(`SELECT c.agent_id,c.secret_hash,c.expires_at,c.revoked_at,a.status,a.revoked_at AS agent_revoked_at
    FROM im_credentials c JOIN im_agents a ON a.agent_id=c.agent_id WHERE c.credential_id=?`);
  const invalid = () => { throw new ImError('INVALID_CREDENTIAL'); };
  function active(credentialId, agentId) {
    const now = guard.current();
    const row = lookup.get(credentialId);
    if (!row || (agentId !== undefined && row.agent_id !== agentId) || row.revoked_at !== null || row.agent_revoked_at !== null ||
        row.status !== 'active' || (row.expires_at !== null && row.expires_at <= now)) invalid();
    return row;
  }
  function authenticate(rawCredential) { return guard.runRead(() => {
    if (typeof rawCredential !== 'string' || rawCredential.length !== 80) invalid();
    const match = CREDENTIAL.exec(rawCredential);
    if (!match || Buffer.from(match[2], 'base64url').length !== 32 ||
        Buffer.from(match[2], 'base64url').toString('base64url') !== match[2]) invalid();
    const now = guard.current();
    const row = lookup.get(match[1]);
    const actual = createHash('sha256').update(match[2]).digest();
    const expected = row && /^[0-9a-f]{64}$/.test(row.secret_hash) ? Buffer.from(row.secret_hash, 'hex') : Buffer.alloc(32);
    if (!timingSafeEqual(actual, expected)) invalid();
    if (!row || row.revoked_at !== null || row.agent_revoked_at !== null || row.status !== 'active' ||
        (row.expires_at !== null && row.expires_at <= now)) invalid();
    const principal = Object.freeze({ agentId: row.agent_id, credentialId: match[1] });
    issued.add(principal);
    return principal;
  }); }
  function assertActive(principal) { return guard.runRead(() => {
    if (!principal || typeof principal !== 'object' || !issued.has(principal)) invalid();
    active(principal.credentialId, principal.agentId);
    return principal;
  }); }
  return Object.freeze({ authenticate, assertActive });
}
