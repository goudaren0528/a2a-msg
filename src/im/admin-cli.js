import { createImAdmin } from './admin.js';
import { createImMigration } from './migration.js';
import { createAdminAuthority, createLocalKeystore } from './keystore.js';

// The caller provides an isolated, already migrated DB and a secret delivered out of band.
// Never accept the admin secret as a command line argument or echo any rejected input.
export function createImAdminCli({ db, secretFile, credentialDirectory, clock = Date.now,
  trustWindowsPermissions = false, report = console.warn, storageFault } = {}) {
  const authority = createAdminAuthority({ secretFile, trustWindowsPermissions, report });
  const store = createLocalKeystore({ directory: credentialDirectory, trustWindowsPermissions, report, fault: storageFault });
  const admin = createImAdmin({ db, clock, authorizeAdmin: authority.authorizeAdmin,
    protectCredential: issued => store.storeCredential(issued) });
  const migration = createImMigration({ db, clock, authorizeAdmin: ctx =>
    authority.authorizeAdmin(ctx) === true ? 'local-admin' : false });

  function execute(command, input, context) {
    try {
      // Explicit boundary check before validation, filesystem writes, and every delegated operation.
      if (authority.authorizeAdmin(context) !== true) throw new Error('denied');
      switch (command) {
        case 'register-agent': return admin.registerAgent(input, context);
        case 'issue-credential': return admin.issueCredential(input, context);
        case 'revoke-credential': {
          const revoked = admin.revokeCredential(input, context);
          store.recordRevocation(revoked.credentialId);
          return revoked;
        }
        case 'set-status': return admin.setAgentStatus(input, context);
        case 'set-contact': return admin.setContact(input, context);
        case 'takeover-receiver': return admin.takeoverReceiver(input, context);
        case 'write-mode': return migration.setImWriteMode(input, context);
        default: throw new Error('unknown command');
      }
    } catch (error) {
      if ((error?.code === 'STORAGE_UNAVAILABLE' || error?.cleanupIncomplete) && error.credentialId) {
        const failure = new Error('ADMIN_CLEANUP_INCOMPLETE');
        failure.credentialId = error.credentialId;
        throw failure;
      }
      throw new Error('ADMIN_OPERATION_FAILED');
    }
  }
  return Object.freeze({ execute });
}
