# IM v1 self-service enrollment (implementation slice)

This document describes the v4 enrollment slice in `src/im/schema.js`, `src/im/enrollment.js`, `src/im/admin.js`, `src/im/http.js` and the `scripts/im-register.mjs` / `scripts/im-migrate-v4.mjs` helpers. It is **not** a deployment procedure or an internet-facing authentication design. Registration is disabled by default and is intended for a LAN/VPN center that already has TLS (or the explicit loopback `local-test` transport).

## Schema v5

`IM_SCHEMA_VERSION` is `5`; `SUPPORTED_IM_SCHEMA_VERSIONS` is `[1,2,3,4,5]`. v5 is additive over v4 and adds one column plus one index to the invite table: `inviter_agent_id TEXT REFERENCES im_agents(agent_id)` (NULL means an administrator invite) and `im_enrollment_invites_inviter(inviter_agent_id,created_at)`. `migrateImSchemaV5(db)` creates a fresh v5 database, upgrades v4 → v5, is repeatable on v5, and refuses v1/v2/v3 with `IM_SCHEMA_MISMATCH` (they must take their original explicit upgrades first). The fresh and migrated paths store byte-identical DDL. **Back up and verify the center database before migrating**, then run `node scripts/im-migrate-v5.mjs <existing-center-config.json>` (accepts v4/v5, `MIGRATION_STALE` for older markers, prints `{status,from,to,schemaChecksum}`). A center with `policy.enrollment.enabled` and `agentsCanInvite=true` refuses to start on a v4 database (`POLICY_NOT_CONFIGURED`) instead of silently dropping inviter binding.

## Schema v4 (previous slice)

v4 is additive over v3 and adds two tables plus two indexes:

- `im_enrollment_invites(invite_id PK, code_hash UNIQUE, created_at, expires_at, used_at, used_agent_id, revoked_at)`. Only the SHA-256 of the invite code is stored. `used_at`/`used_agent_id` are set together, and `revoked_at` is independent.
- `im_contact_requests(request_id PK, requester_id, target_id, status, version, created_at, updated_at)` with `status IN ('pending','accepted','rejected','revoked')` and a unique requester/target pair. v4 creates the table; the friend state machine lands in a later package.

`migrateImSchemaV4(db)` is explicit: fresh → v4, v3 → v4, repeated v4 → `true`; v1/v2 must take their original upgrades first. A failed step rolls back both tables and the marker. `migrateImSchema` and `migrateImSchemaV3` keep their original default targets and remain the only entry points for v1→v2 and v2→v3.

`src/im/migration-runner.js` and `src/im/backup-publisher.js` accept schema version 3 or 4 for the legacy v1 line; the plan/identity comparison still requires the exact marker observed at preview time.

## Invite lifecycle

The authenticated Agent path lives in the same module (`createImEnrollment({db,clock,policy,auth})`):

- `createInvite(principal,{ttlMs?})` → `{inviteId,code,expiresAt,ttlMs}`. `ttlMs` is optional and limited to 60 000–86 400 000 (default 24 h). The invite stores `inviter_agent_id`; only `sha256(code)` is persisted and the code is returned once. Requires `policy.enrollment.enabled`, `agentsCanInvite !== false`, an active principal, and the same write gate as friend requests (`policy.writeMode='enabled'` **and** `im_settings.write_mode='enabled'`), otherwise `ENROLLMENT_DISABLED`, `AGENT_INVITES_DISABLED`, `NEW_WRITES_DISABLED` or `IM_DISABLED`. At most `dailyInviteLimit` (default 5) invites per inviter in a rolling 24-hour window; the next attempt is `INVITE_LIMIT_REACHED`. The window is rolling, not calendar-day, so there is no timezone ambiguity.
- `revokeInvite(principal,{inviteId})` → `{inviteId,revokedAt}`. Only the creator may revoke, only before redemption; unknown, foreign and used ids are all `RESOURCE_NOT_FOUND`. Revocation is allowed even when `agentsCanInvite` is off (safety action).

`redeem()` on a v5 invite with an inviter, in the same immediate transaction as agent/credential creation, also inserts `im_contacts(agent_low,agent_high,allowed=1)` and one `im_contact_requests(status='accepted')` row for exactly that pair. No other contact row is touched, so invitees of different inviters never become contacts. If the inviter is disabled or revoked at redemption time the whole transaction rolls back with `INVITER_UNAVAILABLE` and the invite is still unused. Administrator invites (no inviter) keep the previous behavior: no contact is created. The enrollment audit row records `{inviteId}` plus `{inviterAgentId,autoFriend:true}` for the agent path; invite codes are never audited.

`createImAdmin({db,clock,authorizeAdmin})` adds the administrator path:

- `createEnrollmentInvite({ttlMs}, ctx)` → `{inviteId, code, expiresAt}`. `ttlMs` is an integer between 60,000 (1 minute) and 2,592,000,000 (30 days). `code` is 32 random bytes in unpadded base64url (43 characters) and is returned **once**. The database stores only `sha256(code)`; audit details hold `{expiresAt}` only.
- `revokeEnrollmentInvite({inviteId, reason}, ctx)` → `{inviteId, revokedAt}`. Used invites cannot be revoked (they are already spent); missing, used or previously revoked invites return `RESOURCE_NOT_FOUND`.

Redemption is performed by `createImEnrollment({db,clock})`, which only operates on a v4 database. It validates the code format and display name, then in one immediate transaction: re-reads the invite, creates the agent and its receive state, issues a non-expiring credential (`expiresAt: null`), marks the invite used, and appends a `system/enrollment` audit row. The credential plaintext is returned once and is never written to `im_audit`, logs or error bodies.

Invalid, expired, used and revoked invites are deliberately distinguishable fixed codes:

| code | HTTP | meaning |
| --- | --- | --- |
| `ENROLLMENT_DISABLED` | 403 | `policy.enrollment.enabled` is not `true` |
| `INVITE_NOT_FOUND` | 404 | no invite has this code hash |
| `INVITE_ALREADY_USED` | 409 | the invite was already redeemed |
| `INVITE_EXPIRED` | 410 | `expires_at <= now` |
| `INVITE_REVOKED` | 403 | an administrator revoked the invite |
| `INVALID_REQUEST` | 400 | malformed body, code format or display name |
| `RATE_LIMITED` | 429 | the handler's bounded per-IP request budget was exceeded |

Expiry is exclusive. A successful redemption followed by a lost HTTP response consumes the invite; issue another one rather than retrying store-side.

## HTTP route

`POST /api/v1/enroll` is the only unauthenticated `/api/v1` route. It is handled before the Bearer boundary, so it must not be added to any authenticated route table. It:

- requires `Content-Type: application/json`, no query keys and no transfer-encoding/body ambiguity;
- accepts exactly `{inviteCode, displayName}` and rejects unknown fields;
- returns `201 {agentId, displayName, credentialId, credential, expiresAt}` on success;
- requires `enrollment: {enabled: true}` in the parsed policy, otherwise `ENROLLMENT_DISABLED`;
- is subject to the center's existing TLS check, concurrent-connection cap and per-IP request limiter.

The returned `agentId` and `credential` can be used immediately with `GET /api/v1/me`. `createImCenter` constructs the enrollment module only when the validated policy enables enrollment, so enabling it on a pre-v4 database fails closed at startup.

When the center configuration sets `tls.caCertPath`, the center process also serves that CA bundle on the public `GET /ca.pem` so a join link can fetch and pin it; see the [HTTP contract](im-http-contract.md). This is the only unauthenticated route outside `/api/v1`; it does not expose the enrollment route or any identity data.

## Device-side registration

There are three equivalent entry points; `bin/a2a-msg.mjs` only checks the Node version and forwards to `scripts/im-register.mjs`.

```sh
# one command from the link an administrator hands over (recommended)
node scripts/im-register.mjs --join 'https://<center>/join#invite=<code>&ca=sha256:<hex>' [--display-name <name>] [--state-dir <dir>]

# explicit form; --ca-url requires --ca-sha256 (first trust, pinned)
node scripts/im-register.mjs --center <url> --invite <code> [--display-name <name>] [--state-dir <dir>] [--ca-url <url> --ca-sha256 sha256:<hex>]
```

- Requires Node 24 (`NODE_VERSION_UNSUPPORTED` otherwise).
- Accepts HTTPS, or plain HTTP only for a literal loopback center. Userinfo, query, fragment and non-root paths are rejected for `--center`; a join link must be `<origin>/join` with a fragment holding exactly one `invite` and one `ca` value.
- **Without `--ca-url`** a private CA is trusted exactly as before through `NODE_EXTRA_CA_CERTS`; no certificate-skipping option exists.
- **With `--ca-url`/`--ca-sha256`** (or a join link) the device first fetches that URL without validating the server certificate, because the fingerprint is the only anchor available yet. It computes the SHA-256 of the returned PEM bytes and compares it with `sha256:<hex>` (`sha256sum ca.pem`); only a match is then used as the `ca` for the enrollment request, which keeps full chain and hostname verification and does not follow redirects. The CA is not persisted, so `~/.a2a-msg` keeps only `identity.json` and `credentials/`; an MCP host still needs `NODE_EXTRA_CA_CERTS` for routine traffic.
- `--display-name` is optional: it defaults to the sanitized system hostname (characters outside `[A-Za-z0-9._-]` become `-`, runs collapse, empty becomes `device`, capped at 255) and is still validated by the center.
- Fixed failure codes on stderr, exit code 1, and never an identity artifact: `INVALID_JOIN_LINK` (malformed/unpinned link), `CA_FETCH_FAILED` (unreachable or non-200 CA URL), `CA_INVALID` (body is not a PEM certificate), `CA_FINGERPRINT_MISMATCH` (pinned value does not match), `CA_NOT_TRUSTED` (the pinned CA did not verify the center chain or hostname), plus the existing `INVALID_ARGUMENTS`, `INVALID_INVITE`, `INVALID_CENTER`, `TLS_REQUIRED`, `CENTER_UNAVAILABLE`, `ENROLLMENT_FAILED`, `STATE_DIR_UNSAFE`, `IDENTITY_EXISTS` and `STATE_WRITE_FAILED`. A failed fetch/pin happens before redemption, so the invite is still unused.
- Default state directory is `~/.a2a-msg` (`0700`). After a successful redemption it contains: `identity.json` (`0600`, agent id/display name/center URL/credential record path), `credentials/` (`0700`, keystore record + a bare `*.credential` file), `ca.pem` (`0600`, only when the CA was fetched and pinned), a strict `nana.json` (`0600`) and `attachments/` (`0700`).
- `nana.json` is directly usable by `a2a-msg mcp --config <nana.json>` and `scripts/im-nana-session.mjs`: `{serverUrl, agentId, credentialFile (bare credential), journalPath, attachmentDirectory, statePath, caFile?}`. With `caFile` present the host needs no `NODE_EXTRA_CA_CERTS`; chain and hostname verification stay enabled. A `register --center --invite` without `--ca-url` writes `identity.json` + `nana.json` (no `caFile`) and no `ca.pem`.
- Prints `{agentId, displayName, centerUrl, credentialFile, identityFile, nanaCredentialFile, nanaConfigFile, caFile, mcp}` where `mcp` is a stdio host snippet (`npx --yes <ref> mcp --config <nana.json>`); replace `<ref>` with the pinned Git commit or local tarball the device installed from. The credential is never printed, the invite code is never echoed, and errors contain no response body.
- Fixed center codes on stderr (exit 1) include `INVITE_NOT_FOUND`, `INVITE_ALREADY_USED`, `INVITE_EXPIRED`, `INVITE_REVOKED`, `ENROLLMENT_DISABLED`, `AGENT_INVITES_DISABLED`, `INVITER_UNAVAILABLE`, `INVITE_LIMIT_REACHED` and `NEW_WRITES_DISABLED`; unknown response bodies collapse to `ENROLLMENT_FAILED`.

## Device-side invitations (`a2a-msg invite`)

Any active Agent that holds a `nana.json` (and the local `ca.pem`) can mint its own invite:

```sh
a2a-msg invite --config ~/.a2a-msg/nana.json                 # {inviteId,code,expiresAt,ttlMs,serverUrl,caFingerprint,joinUrl}
a2a-msg invite --config ~/.a2a-msg/nana.json --revoke <id>   # {inviteId,revokedAt}
```

The join link is `${nana.json.serverUrl}/join#invite=<code>&ca=sha256:<local ca.pem bytes>`. It deliberately uses the caller's own public `serverUrl`, never the center's internal `transport.serverUrl`. The CA is located at `nana.json.caFile` or `<config dir>/ca.pem`; without either the command fails with `CA_NOT_CONFIGURED` rather than emit an unpinned link. The code is printed once and not stored locally. Center limits (24 h TTL, rolling daily cap, revocation, `agentsCanInvite`) apply unchanged, and any redemption still only befriends the inviter.
- Refuses to overwrite an existing `identity.json` (`IDENTITY_EXISTS`) before spending the invite.

A device that already holds a credential uses it as a Bearer token; enrollment is not re-run for routine use. The TOFU model assumes the join link reaches the device through a trusted channel; a fingerprint mismatch or an untrusted chain must stop the operator, not be worked around.

## Explicit migration

`node scripts/im-migrate-v4.mjs <existing-center-config.json>` / `node scripts/im-migrate-v5.mjs <existing-center-config.json>` open the `dbPath` from the same strict center configuration shape (`dbPath`, optional `policy`, optional `tls`), verify `PRAGMA foreign_keys=ON`, and run `migrateImSchemaV4` / `migrateImSchemaV5`. Each prints `{status:'migrated', from, to, schemaChecksum}` and is repeatable on its own target version. The v4 script refuses anything but v3/v4 and the v5 script refuses anything but v4/v5 (`MIGRATION_STALE`); neither creates or backs up a database. **Take and verify a backup, and record the deployed ref, before running either on a real center.**
