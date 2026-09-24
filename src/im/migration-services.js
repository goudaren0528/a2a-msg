import { createTrustedBackupServices } from './backup-registry.js';
import { createImMigrationRunner } from './migration-runner.js';
import { resolveImTimeGuard } from './clock.js';

const fail = () => Object.assign(new Error('MIGRATION_INVALID'), { code: 'MIGRATION_INVALID' });
const allowed = ['db', 'dir', 'authority', 'approvalAuthority', 'actorId', 'clock', 'approvalTtlMs'];

// Production composition has no platform, writer, resolver, backup, or guard injection switches.
export function createTrustedMigrationServices(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Reflect.ownKeys(options).some(key => !allowed.includes(key))) throw fail();
  const { db, dir, authority, approvalAuthority, actorId, clock = Date.now, approvalTtlMs } = options;
  const guard = resolveImTimeGuard(db, clock);
  const { publisher, registry } = createTrustedBackupServices({ db, dir, authority, clock });
  const runner = createImMigrationRunner({ db, publisher, registry, authority, approvalAuthority,
    actorId, clock, approvalTtlMs, timeGuard: guard });
  return Object.freeze({ publisher, registry, runner });
}
