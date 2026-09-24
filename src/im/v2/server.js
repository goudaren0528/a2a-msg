import { ImV2Error } from './contracts.js';
import { parseImV2Config } from './config.js';
import { createImV2ClockGuard } from './clock.js';
import { createImV2Auth } from './auth.js';
import { createImV2Acl } from './acl.js';
import { createImV2Messages } from './messages.js';
import { createImV2Delivery } from './delivery.js';
import { createImV2Handler } from './http.js';

const fail = () => { throw new ImV2Error('STORAGE_UNAVAILABLE'); };
const time = n => Number.isSafeInteger(n) && n >= 0;
const hex = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

// Private constructor proof; deliberately does not authenticate a fabricated user or call /me.
// auth.withRead/withWrite repeat this gate on every business transaction.
function assertActivated(db) {
  try {
    const c = db.prepare('SELECT center_epoch,recovery_counter,status,activation_ref,recovery_run_id,updated_at FROM im_center_state WHERE singleton=1').get();
    if (!c || c.status !== 'active' || !c.recovery_run_id || !c.activation_ref || !time(c.updated_at) || !time(c.recovery_counter)) fail();
    const e = db.prepare('SELECT origin,recovery_counter,created_at FROM im_center_epochs WHERE center_epoch=?').get(c.center_epoch);
    const r = db.prepare(`SELECT status,new_epoch,activation_ref,auth_review_ref,activation_plan_hash,activation_approval_ref,
      verified_at,activated_at,failure_code,candidate_kind,preparation_ref,old_epoch,created_at
      FROM im_recovery_runs WHERE run_id=?`).get(c.recovery_run_id);
    if (!e || e.recovery_counter !== c.recovery_counter || !time(e.created_at) || !r ||
        r.status !== 'active' || r.new_epoch !== c.center_epoch || r.activation_ref !== c.activation_ref ||
        !r.auth_review_ref || !r.activation_approval_ref || !hex(r.activation_plan_hash) ||
        !time(r.created_at) || !time(r.verified_at) || !time(r.activated_at) ||
        r.created_at > r.verified_at || r.activated_at < r.verified_at || r.failure_code !== null) fail();
    if (r.candidate_kind === 'fresh_bootstrap' || r.candidate_kind === 'v3_import') {
      const p = r.preparation_ref && db.prepare('SELECT kind,initial_epoch,created_at FROM im_schema_preparations WHERE preparation_ref=?').get(r.preparation_ref);
      if (!p || p.kind !== (r.candidate_kind === 'fresh_bootstrap' ? 'fresh' : 'v3_import') ||
          p.initial_epoch !== c.center_epoch || !time(p.created_at) || r.old_epoch !== null ||
          e.origin !== p.kind || e.recovery_counter !== 0) fail();
    } else if (r.candidate_kind === 'snapshot_recovery') {
      const old = r.old_epoch && db.prepare('SELECT origin,recovery_counter,created_at FROM im_center_epochs WHERE center_epoch=?').get(r.old_epoch);
      if (r.preparation_ref !== null || !old || r.old_epoch === c.center_epoch ||
          !['fresh','v3_import','recovery'].includes(old.origin) || !time(old.created_at) ||
          !time(old.recovery_counter) || e.origin !== 'recovery' || e.recovery_counter <= old.recovery_counter) fail();
    } else fail();
  } catch (error) { if (error instanceof ImV2Error) throw error; fail(); }
}

export function createImV2Center(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Reflect.ownKeys(options).some(k => !['db','policy','clock'].includes(k))) throw new ImV2Error('INVALID_REQUEST');
  const { db, policy, clock = Date.now } = options;
  const config = parseImV2Config(policy);
  if (!config.enabled) throw new ImV2Error('IM_DISABLED');
  const guard = createImV2ClockGuard({ db, clock }); // one full P1 validation + baseline snapshot
  guard.runRead(() => assertActivated(db));
  const auth = createImV2Auth({ db, policy, clock, timeGuard:guard });
  const acl = createImV2Acl({ db, auth, clock, timeGuard:guard });
  const messages = createImV2Messages({ db, auth, acl, policy, clock, timeGuard:guard });
  const delivery = createImV2Delivery({ db, auth, acl, policy, clock, timeGuard:guard });
  const handler = createImV2Handler({ auth, acl, messages, delivery, policy });
  return Object.freeze({ handler, close: () => handler.close(), modules:Object.freeze({ auth, acl, messages, delivery }) });
}
