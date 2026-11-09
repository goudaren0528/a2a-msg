# Changelog

## Unreleased

### One-command join (source only, not deployed, no npm release)

- The center process (`scripts/im-center.mjs`) accepts an optional `tls.caCertPath` in the strict direct-TLS configuration and serves those bytes on the only public route outside `/api/v1`: `GET /ca.pem` (`Content-Type: application/x-pem-file`, no authentication, `nosniff`, `no-store`). Without `tls.caCertPath`, for non-GET methods and for every other path it answers `404`, so the Bearer boundary is unchanged. A file that is not a PEM certificate or that contains a private key refuses startup.
- `scripts/im-register.mjs` gains `--ca-url` + `--ca-sha256`: the CA is fetched first-trust (server certificate not yet validated), the SHA-256 of the returned PEM bytes is compared with the pinned `sha256:<hex>`, and only a match is used as the `ca` for the enrollment request (chain and hostname still verified, redirects not followed). Without `--ca-url` behavior is unchanged (`fetch` + `NODE_EXTRA_CA_CERTS`).
- New `join <link>` subcommand (`bin/a2a-msg.mjs` forwards to `scripts/im-register.mjs --join`): `https://<center>/join#invite=<code>&ca=sha256:<hex>` is one command for fetch CA, pin, and enroll; the fragment is never sent to the server. `--display-name` is now optional and defaults to the sanitized system hostname (characters outside `[A-Za-z0-9._-]` become `-`).
- New fixed device-side errors: `INVALID_JOIN_LINK`, `CA_FETCH_FAILED`, `CA_INVALID`, `CA_FINGERPRINT_MISMATCH`, `CA_NOT_TRUSTED`. Every failure before identity writing leaves `identity.json`/credentials unwritten and the invite unspent; the state layout (`identity.json` + `credentials/`) is unchanged.
- Docs: `docs/install-npx.md` leads with "Node 24 + one command", states that a fingerprint mismatch must stop, and keeps `NODE_EXTRA_CA_CERTS`/`register --center --invite` as the legacy path; `docs/im-http-contract.md` and `docs/im-enrollment-contract.md` document the route, flags, fingerprint semantics and error codes.
- Tests: `tests/im-http.test.js` (public CA route, 404 matrix, invalid CA refuses startup), `tests/im-enrollment.test.js` (pinned CA success, wrong fingerprint, CA that did not issue the center certificate, unreachable CA, join link, hostname default), `tests/package.test.js` (join help/forwarding). New test-only fixture `tests/fixtures/im-tls/unrelated-ca.crt`.

### npx entry (source only, not published to npm)

- `package.json` gains `bin: {"a2a-msg": "bin/a2a-msg.mjs"}` and ships `bin/` and `scripts/` through `files`; the package stays `private` and nothing is published to npm. Local `docs/delivery/*/evidence/` and `shots/` worktree evidence is excluded from the tarball.
- `bin/a2a-msg.mjs` is a thin dispatcher over the existing entries: `mcp --config/--download-dir` forwards to `scripts/im-mcp.mjs`, and `register --center/--invite/--display-name/--state-dir` forwards to `scripts/im-register.mjs`. stdio, signals and exit codes pass through; `node src/mcp.js` and `node scripts/im-mcp.mjs` are unchanged.
- Any Node.js major other than 24 fails before argument parsing with fixed `NODE_VERSION_UNSUPPORTED` on stderr and exit code 1, matching `engines: ">=24 <25"`.
- `docs/install-npx.md` documents full-commit pinned `npx github:goudaren0528/a2a-msg#<sha>` usage, host configuration, local tarball installation, `NODE_EXTRA_CA_CERTS`, and the version error. This is source-level capability: the center has not been upgraded, no real two-device acceptance has run, and no npm release exists.

### Attachments and download directory (source only, not deployed)

- The stdio entry (`scripts/im-mcp.mjs`) now registers a 21st tool, `im_v1_send_file`: it reads one absolute local regular file (1 byte–10 MiB, no symlinks; `dev/ino/size/mtime` checked across the read), computes SHA-256 locally and maps onto the existing `im_v1_send` contract. Results never echo file bytes or the staged base64 request; reused `clientMessageId` with different bytes is `IDEMPOTENCY_CONFLICT`.
- `nana.json` `attachmentDirectory` is optional for the MCP entry and defaults to `~/Downloads/a2a-msg/<center-host>[_<port>]` (created on demand, never inside an npx/tmp cache). `--download-dir <absolute existing dir>` overrides it; explicitly configured directories are never created and fail closed when missing or unwritable. The session CLI still requires an existing directory.
- Received files keep the existing exclusive-install plus SHA-256/size verification and journal-before-ACK path: a missing/unwritable directory or corrupt bytes leaves the message unacknowledged and unread, and retries re-deliver the same message exactly once.
- `bin/a2a-msg.mjs` forwards `--download-dir` to `scripts/im-mcp.mjs`; the session CLI still requires an existing directory.

### Friend requests (source only, not deployed)

- `src/im/contacts.js` adds a `pending → accepted|rejected|revoked` request state machine over schema v4 `im_contact_requests`, with one row per agent pair and versioned transitions.
- `policy.contacts.requests='enabled'` opens `POST/GET /api/v1/contact-requests` and `/accept|/reject|/revoke` plus MCP tools `im_v1_contact_request`, `im_v1_contact_requests`, `im_v1_contact_respond`, `im_v1_contact_revoke`; the default `legacy` mode keeps administrator `set-contact` as the only path.
- Accepting sets `im_contacts.allowed=1`; rejecting or revoking keeps it `0`, so the unchanged server-side ACL immediately blocks sends and hides old conversations, messages, attachments and receive-sync pages after a revocation (q08 B).
- New fixed error `CONTACT_REQUEST_CONFLICT` (409). The MCP adapter now exposes 20 tools.

### Enrollment (source only, not deployed)

- Schema v4 adds `im_enrollment_invites` and `im_contact_requests` with an explicit, repeatable v3→v4 migration (`migrateImSchemaV4`, `scripts/im-migrate-v4.mjs`). v1/v2 must still take their original upgrade paths.
- One-time invite redemption: `createImAdmin.createEnrollmentInvite` / `revokeEnrollmentInvite`, `createImEnrollment.redeem`, and `POST /api/v1/enroll` (disabled by default via `policy.enrollment.enabled=false`). Only invite-code hashes are stored; plaintext credentials are returned once and never audited.
- Device-side `scripts/im-register.mjs` writes a `0600` credential and `identity.json` under `~/.a2a-msg` (or `--state-dir`) and prints no credential.
- Legacy binding migration and backup publication accept schema marker 3 or 4.

### Current source (not a release announcement)

- The repository contains a Node 24 private npm package for a source-IP-bound LAN messaging server and a generic MCP stdio bridge; OpenCode integration is optional.
- Source includes local tests for message and attachment handling, identity boundaries, SDK/MCP integration, and optional OpenCode plugin behavior.
- Repository governance guidance, templates, and a proposed CI workflow are being added. Presence in source does not mean a deployment has been updated or the workflow has run on GitHub.

### Not yet delivered or approved

- The planned Internet-capable Agent IM credential model, migration and cross-framework acceptance described in the [PRD](docs/prd/a2a-msg-agent-im-v1.md) are targets, not release notes for shipped behavior.
- No open-source license, release tag, release date, supported upgrade/rollback procedure, or verified private security-reporting channel is established here. Formal distribution and public release remain blocked on maintainer decisions and validation.
