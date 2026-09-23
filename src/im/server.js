import { assertImSchema } from './schema.js';
import { createImClockGuard } from './clock-guard.js';
import { createImAuth } from './auth.js';
import { createImAcl } from './acl.js';
import { createImMessages } from './messages.js';
import { createImDelivery } from './delivery.js';
import { createImHandler } from './http.js';

// The caller owns the already-open, already-migrated database and the HTTP listener.
export function createImCenter({ db, policy, clock = Date.now, onCommitted, trustedTimers } = {}) {
  assertImSchema(db);
  const guard = createImClockGuard({ db, clock });
  const auth = createImAuth({ db, clock, timeGuard: guard });
  const acl = createImAcl({ db, auth, clock, timeGuard: guard });
  const messages = createImMessages({ db, auth, acl, clock, timeGuard: guard, policy, onCommitted });
  const delivery = createImDelivery({ db, auth, acl, clock, timeGuard: guard, policy });
  const handler = createImHandler({ auth, acl, messages, delivery, policy, trustedTimers });
  return Object.freeze({ handler, close: () => handler.close(), guard,
    modules: Object.freeze({ auth, acl, messages, delivery }) });
}
