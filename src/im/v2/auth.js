import { createHash, timingSafeEqual } from 'node:crypto';
import { ImV2Error, PROTOCOL, scopeSchema, dataSchemas } from './contracts.js';
import { parseImV2Config } from './config.js';
import { resolveImV2TimeGuard } from './clock.js';

const credentialPattern = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const hex = /^[0-9a-f]{64}$/;
const error = code => new ImV2Error(code);
const query = (statement, ...args) => {
  try { return statement.get(...args); } catch { throw error('STORAGE_UNAVAILABLE'); }
};
const authBindings = new WeakMap();
// Internal constructor check only: registration remains private to this module.
export function assertImV2AuthBinding(auth, db, guard) {
  if (!auth || (typeof auth !== 'object' && typeof auth !== 'function') ||
      authBindings.get(auth)?.db !== db ||
      (guard !== undefined && authBindings.get(auth)?.guard !== guard))
    throw error('INVALID_REQUEST');
}
const safeTime = value => Number.isSafeInteger(value) && value >= 0;

export function createImV2Auth({ db, policy, clock = Date.now, timeGuard } = {}) {
  const config = parseImV2Config(policy);
  const guard = resolveImV2TimeGuard(db, clock, timeGuard);
  let credential, center, epoch, run, preparation, identity, setting, registered;
  try {
    credential = db.prepare(`SELECT c.agent_id,c.secret_hash,c.expires_at,c.revoked_at,a.status,a.revoked_at AS agent_revoked_at
      FROM im_credentials c LEFT JOIN im_agents a ON a.agent_id=c.agent_id WHERE c.credential_id=?`);
    center = db.prepare('SELECT center_epoch,recovery_counter,status,activation_ref,recovery_run_id,updated_at FROM im_center_state WHERE singleton=1');
    epoch = db.prepare('SELECT origin,recovery_counter,created_at FROM im_center_epochs WHERE center_epoch=?');
    run = db.prepare(`SELECT status,new_epoch,activation_ref,auth_review_ref,activation_plan_hash,activation_approval_ref,
      verified_at,activated_at,failure_code,candidate_kind,preparation_ref,old_epoch,created_at
      FROM im_recovery_runs WHERE run_id=?`);
    preparation = db.prepare('SELECT kind,initial_epoch,created_at FROM im_schema_preparations WHERE preparation_ref=?');
    identity = db.prepare('SELECT instance_id FROM im_instance_identity WHERE singleton=1');
    setting = db.prepare('SELECT write_mode FROM im_settings WHERE singleton=1');
    registered = db.prepare('SELECT canonical_json,effective_at FROM im_retention_policies WHERE policy_hash=?');
  } catch { throw error('STORAGE_UNAVAILABLE'); }
  const issued = new WeakMap();
  const invalid = () => { throw error('INVALID_CREDENTIAL'); };
  function check(principal) {
    if (!principal || typeof principal !== 'object' || !issued.has(principal)) invalid();
    const binding = issued.get(principal);
    if (principal.agentId !== binding.agentId || principal.credentialId !== binding.credentialId ||
        Reflect.ownKeys(principal).length !== 2 || !Object.isFrozen(principal)) invalid();
    const row = query(credential, binding.credentialId);
    if (!row || row.agent_id !== binding.agentId || row.secret_hash !== binding.hash ||
        row.revoked_at !== null || row.agent_revoked_at !== null || row.status !== 'active' ||
        (row.expires_at !== null && row.expires_at <= guard.current())) invalid();
    return principal;
  }
  function authenticate(rawCredential) {
    if (rawCredential === undefined || rawCredential === null) throw error('AUTH_REQUIRED');
    if (typeof rawCredential !== 'string' || rawCredential.length !== 80) invalid();
    const match = credentialPattern.exec(rawCredential);
    if (!match || Buffer.from(match[2], 'base64url').length !== 32 ||
        Buffer.from(match[2], 'base64url').toString('base64url') !== match[2]) invalid();
    return guard.runRead(() => {
      const row = query(credential, match[1]);
      const actual = createHash('sha256').update(match[2]).digest();
      const expected = row && typeof row.secret_hash === 'string' && hex.test(row.secret_hash)
        ? Buffer.from(row.secret_hash, 'hex') : Buffer.alloc(32);
      if (!timingSafeEqual(actual, expected) || !row || row.status !== 'active' ||
          row.revoked_at !== null || row.agent_revoked_at !== null ||
          (row.expires_at !== null && row.expires_at <= guard.current())) invalid();
      const principal = Object.freeze({ agentId: row.agent_id, credentialId: match[1] });
      issued.set(principal, { agentId: row.agent_id, credentialId: match[1], hash: row.secret_hash });
      return principal;
    });
  }
  function assertActive(principal) { guard.current(); return check(principal); }
  function state() {
    const c = query(center);
    if (!c) throw error('STORAGE_UNAVAILABLE');
    const e = query(epoch, c.center_epoch);
    if (!e || e.recovery_counter !== c.recovery_counter || !safeTime(e.recovery_counter) ||
        !safeTime(e.created_at) || !safeTime(c.updated_at)) throw error('STORAGE_UNAVAILABLE');
    if (c.status !== 'active') {
      if (!['prepared', 'verified'].includes(c.status)) throw error('STORAGE_UNAVAILABLE');
      if (c.activation_ref !== null || (c.status === 'verified' && !c.recovery_run_id)) throw error('STORAGE_UNAVAILABLE');
      if (c.recovery_run_id) {
        const pending = query(run, c.recovery_run_id);
        if (!pending || pending.new_epoch !== c.center_epoch ||
            !((pending.status === c.status && pending.activation_ref === null) ||
              (c.status === 'prepared' && pending.status === 'failed' && pending.activation_ref === null)))
          throw error('STORAGE_UNAVAILABLE');
      }
      throw error('IM_DISABLED');
    }
    const r = c.recovery_run_id && query(run, c.recovery_run_id);
    if (!r || r.status !== 'active' || r.new_epoch !== c.center_epoch || r.activation_ref !== c.activation_ref ||
        !c.activation_ref || !r.auth_review_ref || !r.activation_approval_ref ||
        typeof r.activation_plan_hash !== 'string' || !hex.test(r.activation_plan_hash) ||
        !safeTime(r.created_at) || !safeTime(r.verified_at) || !safeTime(r.activated_at) ||
        r.created_at > r.verified_at || r.activated_at < r.verified_at || r.failure_code !== null)
      throw error('STORAGE_UNAVAILABLE');
    if (r.candidate_kind === 'fresh_bootstrap' || r.candidate_kind === 'v3_import') {
      const p = r.preparation_ref && query(preparation, r.preparation_ref);
      if (!p || p.kind !== (r.candidate_kind === 'fresh_bootstrap' ? 'fresh' : 'v3_import') ||
          p.initial_epoch !== c.center_epoch || !safeTime(p.created_at) || r.old_epoch !== null ||
          e.origin !== p.kind || e.recovery_counter !== 0) throw error('STORAGE_UNAVAILABLE');
    } else if (r.candidate_kind === 'snapshot_recovery') {
      const old = r.old_epoch && query(epoch, r.old_epoch);
      if (r.preparation_ref !== null || !old || r.old_epoch === c.center_epoch ||
          !['fresh', 'v3_import', 'recovery'].includes(old.origin) ||
          !safeTime(old.created_at) || !safeTime(old.recovery_counter) ||
          e.origin !== 'recovery' || e.recovery_counter <= old.recovery_counter)
        throw error('STORAGE_UNAVAILABLE');
    } else throw error('STORAGE_UNAVAILABLE');
    if (!config.enabled) throw error('IM_DISABLED');
    return c;
  }
  function scoped(principal, scope) {
    check(principal);
    if (scope.protocol !== PROTOCOL) throw error('INVALID_REQUEST');
    const c = state();
    if (scope.centerEpoch !== c.center_epoch) throw error('RECOVERY_RECONCILIATION_REQUIRED');
    return c;
  }
  function writeGate() {
    const s = query(setting);
    if (!s) throw error('STORAGE_UNAVAILABLE');
    if (config.writeMode !== 'enabled' || s.write_mode !== 'enabled') throw error('NEW_WRITES_DISABLED');
    const p = config.retention;
    if (!p) throw error('POLICY_NOT_CONFIGURED');
    const row = query(registered, p.policyHash);
    if (!row || row.effective_at !== p.policy.effectiveAt || row.effective_at > guard.current() ||
        row.canonical_json !== JSON.stringify(p.policy) ||
        createHash('sha256').update(row.canonical_json).digest('hex') !== p.policyHash)
      throw error('POLICY_NOT_CONFIGURED');
  }
  function callbackCheck(callback) {
    if (typeof callback !== 'function' || callback.constructor?.name === 'AsyncFunction' ||
        Object.prototype.toString.call(callback) === '[object AsyncFunction]') throw error('INVALID_REQUEST');
  }
  function scopeSnapshot(scope) {
    const parsed = scopeSchema.safeParse(scope);
    if (!parsed.success) throw error('INVALID_REQUEST');
    return Object.freeze(parsed.data);
  }
  function withRead(principal, scope, callback) {
    callbackCheck(callback);
    return guard.runRead(() => {
      check(principal);
      const captured = scopeSnapshot(scope);
      scoped(principal, captured);
      return callback();
    });
  }
  function withWrite(principal, scope, callback, finalCheck) {
    callbackCheck(callback);
    if (finalCheck !== undefined) callbackCheck(finalCheck);
    return guard.runWriteFresh(() => {
      check(principal);
      const captured = scopeSnapshot(scope);
      scoped(principal, captured); writeGate();
      const value = callback();
      // The guard rejects thenables before releasing its business savepoint.
      if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function')
        throw error('INVALID_REQUEST');
      guard.refreshCurrent();
      scoped(principal, captured); writeGate();
      // Trusted internal check sees the FINAL observed time via guard.current().
      // It must not refresh time or control the transaction; failure is signaled by throwing.
      if (finalCheck !== undefined) {
        const checked = finalCheck(value);
        if (checked !== null && (typeof checked === 'object' || typeof checked === 'function') &&
            typeof checked.then === 'function') throw error('INVALID_REQUEST');
      }
      return value;
    });
  }
  function me(rawCredential, options = {}) {
    const principal = authenticate(rawCredential);
    return guard.runRead(() => {
      check(principal);
      const centerEpoch = options?.centerEpoch;
      const c = state();
      if (centerEpoch !== undefined) {
        if (!scopeSchema.safeParse({ protocol: PROTOCOL, centerEpoch }).success) throw error('INVALID_REQUEST');
        if (centerEpoch !== c.center_epoch) throw error('RECOVERY_RECONCILIATION_REQUIRED');
      }
      const id = query(identity);
      if (!id) throw error('STORAGE_UNAVAILABLE');
      const parsed = dataSchemas.me.safeParse({ agentId: principal.agentId, instanceId: id.instance_id,
        centerEpoch: c.center_epoch, recoveryCounter: c.recovery_counter, state: 'active' });
      if (!parsed.success) throw error('STORAGE_UNAVAILABLE');
      return Object.freeze(parsed.data);
    });
  }
  const facade = Object.freeze({ authenticate, me, assertActive, withRead, withWrite });
  authBindings.set(facade, Object.freeze({ db, guard }));
  return facade;
}
