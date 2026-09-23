# Trusted local IM administration (library boundary)

This is a local library entry point, **not** a registered shell executable, HTTP endpoint, OS administrator login, production migration runner, or approval workflow. Nothing starts a service or changes runtime config. Pass an already migrated, foreign-key-enabled `DatabaseSync`; use only an operator-controlled local process and protect its inputs, memory, filesystem, and output. Do not pass keys on shell command lines, persist the return value of `issue-credential` in logs, or put secrets in `reason`/display names. A possession check on a local key file is **not OS administrator authentication**.

## API

```js
import { createImAdminCli } from './src/im/admin-cli.js';
import { createLocalKeystore, createAdminAuthority } from './src/im/keystore.js';

// Create and secure protectedCredentialDirectory BEFORE using the keystore.
const store = createLocalKeystore({ directory: protectedCredentialDirectory });
const adminSecret = store.createAdminSecret(secretFile); // capture securely once, never log
const cli = createImAdminCli({ db, secretFile, credentialDirectory: protectedCredentialDirectory });
const context = { adminSecret }; // deliver out of band, NOT a CLI argument
const agent = cli.execute('register-agent', { displayName: 'example-agent' }, context);
const issued = cli.execute('issue-credential', { agentId: agent.agentId, expiresAt: null }, context);
// Handle issued.credential securely; never include in logs or messages.
```

`createAdminAuthority({ secretFile, trustWindowsPermissions?, report? })` exposes synchronous `authorizeAdmin(ctx)`: literal `true` only when `ctx.adminSecret` matches the protected 64-hex-character local key (newline allowed on disk). Missing, malformed, inaccessible or overly permissive key fails closed. Wrong key returns `false`. `createLocalKeystore({ directory, trustWindowsPermissions?, report? })` exposes `createAdminSecret(path)`, `storeCredential({credentialId,agentId,credential})`, `loadCredential(credentialId)`, `recordRevocation(credentialId)`, and `recordRotation(oldCredentialId,newCredentialId)`. Local credential files contain plaintext and require secure transfer to the intended Agent; a local authorized file reader can retrieve it, so one-time plaintext means **one issuance response**, not an impossible one-time read of an Agent's stored key. The server SQLite table stores only the secret hash. Revocation takes effect in DB immediately; local markers provide a record, not an alternative to DB enforcement. Rotation is explicit: issue a new credential, revoke the old one, then record the old/new IDs; no automatic rotation occurs.

CLI issuance requires its parent directory to exist and be protected first, then exclusively writes/fsyncs local material and checks its identity and permissions **before** the admin transaction inserts a usable credential. Local storage failure attempts to remove its partial file without inserting a DB row; DB registration failure rolls back and removes the local artifact. If cleanup fails, `ADMIN_CLEANUP_INCOMPLETE` carries nonsecret `credentialId` for mandatory manual local-file inspection; DB never activated the credential. A failed cleanup after partial local write may leave a secret file requiring operator inspection, even though no DB row exists. The trusted generation callback is not a model/HTTP input. Changing file mode cannot defend against someone with write access to the parent.

`createImAdminCli({db,secretFile,credentialDirectory,clock?,trustWindowsPermissions?,report?})` exposes `execute(command,input,context)`. Inputs match the underlying modules exactly:

| command | input | underlying method |
| --- | --- | --- |
| `register-agent` | `{displayName}` | `createImAdmin.registerAgent` |
| `issue-credential` | `{agentId,expiresAt}` | `createImAdmin.issueCredential` |
| `revoke-credential` | `{credentialId,reason}` | `createImAdmin.revokeCredential` |
| `set-status` | `{agentId,status,reason}` | `createImAdmin.setAgentStatus` |
| `set-contact` | `{agentA,agentB,allowed,reason}` | `createImAdmin.setContact` |
| `takeover-receiver` | `{agentId,reason}` | `createImAdmin.takeoverReceiver` |
| `write-mode` | `{mode,reason,policy?}` | `createImMigration.setImWriteMode` |

All commands check the protected key and then delegate authorization to the real admin/migration module; ordinary failures become fixed `ADMIN_OPERATION_FAILED` without echoing input or secrets. Failed post-transaction cleanup instead returns `ADMIN_CLEANUP_INCOMPLETE` with `credentialId`. `write-mode` defaults to the schema's `paused`; enabling requires an explicitly supplied **complete** policy accepted by `parseImConfig` (`enabled:true`, `writeMode:'enabled'`, transport, retention and lease). It persists only the mode, not policy or runtime configuration. A runtime integration must separately enforce current policy before any write; this library does not start listeners. No retention values are chosen or changed by this CLI. `write-mode` uses migration's trusted nonempty actor ID (`local-admin`), whereas `createImAdmin` requires literal `true`.

## Filesystem trust and limitations

On POSIX, protected files must be regular non-symlink files owned by the current effective user, with one hard link and no group/other permission bits (mode `0600` recommended); new files are exclusive-created with `0600`, and file identity is checked before and after opening. Protect parent directories in advance (`0700` recommended), prevent other users modifying them, and secure backups. No guarantee is made against a privileged local attacker, same-user processes, memory disclosure, or filesystem/ACL changes after verification. Keystore files must be in a private location; never share with the server's general message data directory.

**Windows defaults to fail closed:** Node file mode cannot reliably verify NTFS ACL restrictions. To proceed, an operator must explicitly pass `trustWindowsPermissions: true` to both the keystore and admin CLI/authority (as needed), after separately verifying restrictive ACLs and parent directory protection. Each protected-file check emits `WINDOWS_PERMISSION_UNVERIFIED: filesystem ACLs cannot be verified; operator trust required` via `report` (default `console.warn`). This flag is an explicit acceptance of unverified ACLs, **not proof of OS administrator authentication**. If an operator cannot validate ACLs, do not use this boundary.

This is a local isolated implementation/test surface only: no deployed administrator endpoint, shell bin, production backup/restore, actual OS admin authentication, internet TLS rollout, or complete runtime write gate is provided. Follow `docs/im-migration.md` for activation and recovery constraints.
