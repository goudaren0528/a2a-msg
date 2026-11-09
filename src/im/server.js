import { assertImSchema } from './schema.js';
import { createImClockGuard } from './clock-guard.js';
import { createImAuth } from './auth.js';
import { createImAcl } from './acl.js';
import { createImMessages } from './messages.js';
import { createImContacts } from './contacts.js';
import { createImDelivery } from './delivery.js';
import { createImHandler } from './http.js';
import { createImEvents } from './events.js';
import { createImEnrollment } from './enrollment.js';
import { parseImConfig } from './config.js';
import { ImError } from './contracts.js';

// The caller owns the already-open, already-migrated database and the HTTP listener.
export function createImCenter({ db, policy, clock = Date.now, onCommitted, trustedTimers, eventsOptions } = {}) {
  assertImSchema(db);
  const guard = createImClockGuard({ db, clock });
  const auth = createImAuth({ db, clock, timeGuard: guard });
  const acl = createImAcl({ db, auth, clock, timeGuard: guard });
  const contactPeers = db.prepare(`SELECT CASE WHEN c.agent_low=? THEN c.agent_high ELSE c.agent_low END AS peer_id
    FROM im_contacts c JOIN im_agents a ON a.agent_id=c.agent_low
    JOIN im_agents b ON b.agent_id=c.agent_high WHERE (c.agent_low=? OR c.agent_high=?)
    AND c.allowed=1 AND a.status='active' AND b.status='active'
    AND a.revoked_at IS NULL AND b.revoked_at IS NULL LIMIT 1001`);
  const validate = (principal, peers) => guard.runRead(() => {
    auth.assertActive(principal);
    for (const peer of peers) acl.requirePeer(principal, peer);
  });
  const listEventPeers = principal => guard.runRead(() => {
    auth.assertActive(principal);
    const rows = contactPeers.all(principal.agentId, principal.agentId, principal.agentId);
    if (rows.length > 1000) throw new ImError('RATE_LIMITED');
    return new Set(rows.map(row => row.peer_id));
  });
  const events = createImEvents({ ...eventsOptions, validate, trustedTimers });
  const recipient = db.prepare('SELECT sender_id,recipient_id FROM im_messages WHERE message_id=?');
  const messages = createImMessages({ db, auth, acl, clock, timeGuard: guard, policy, onCommitted: event => {
    if (event.kind === 'message_sent') {
      const row = recipient.get(event.messageId);
      if (row) events.publish(row.recipient_id, row.sender_id);
    }
    onCommitted?.(event);
  } });
  const delivery = createImDelivery({ db, auth, acl, clock, timeGuard: guard, policy });
  // Friend-request routes are only usable when policy.contacts.requests='enabled';
  // the module keeps the existing contact allow-list in sync for ACL enforcement.
  // An enabled policy on a pre-v4 database fails closed instead of silently
  // falling back to legacy contact semantics.
  let contactRequestsEnabled = false;
  try { contactRequestsEnabled = parseImConfig(policy).contacts?.requests === 'enabled'; } catch { /* invalid policy fails elsewhere */ }
  let contacts;
  if (contactRequestsEnabled) {
    if (![4, 5].includes(db.prepare('SELECT version FROM im_schema').get()?.version)) throw new ImError('POLICY_NOT_CONFIGURED');
    contacts = createImContacts({ db, auth, clock, timeGuard: guard, policy });
  }
  // Enrollment is only constructed when the validated policy enables it; an
  // enabled policy on a pre-v4 database fails closed at startup. Agent-created
  // invites need the v5 inviter column, so a v4 database refuses to start while
  // `agentsCanInvite` is on instead of silently dropping the capability.
  let enrollment;
  let enrollPolicy;
  try { enrollPolicy = parseImConfig(policy).enrollment; } catch { enrollPolicy = undefined; }
  if (enrollPolicy?.enabled) {
    if (enrollPolicy.agentsCanInvite !== false && db.prepare('SELECT version FROM im_schema').get()?.version !== 5)
      throw new ImError('POLICY_NOT_CONFIGURED');
    enrollment = createImEnrollment({ db, clock, timeGuard: guard, policy, auth });
  }
  const handler = createImHandler({ auth, acl, messages, contacts, delivery, events, listEventPeers, enrollment, policy, trustedTimers });
  return Object.freeze({ handler, close: () => { events.close(); handler.close(); }, guard,
    modules: Object.freeze({ auth, acl, messages, contacts, delivery, events }) });
}
