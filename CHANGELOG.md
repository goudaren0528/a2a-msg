# Changelog

## Unreleased

### Attachments and download directory (source only, not deployed)

- The stdio entry (`scripts/im-mcp.mjs`) now registers a 21st tool, `im_v1_send_file`: it reads one absolute local regular file (1 byte–10 MiB, no symlinks; `dev/ino/size/mtime` checked across the read), computes SHA-256 locally and maps onto the existing `im_v1_send` contract. Results never echo file bytes or the staged base64 request; reused `clientMessageId` with different bytes is `IDEMPOTENCY_CONFLICT`.
- `nana.json` `attachmentDirectory` is optional for the MCP entry and defaults to `~/Downloads/a2a-msg/<center-host>[_<port>]` (created on demand, never inside an npx/tmp cache). `--download-dir <absolute existing dir>` overrides it; explicitly configured directories are never created and fail closed when missing or unwritable. The session CLI still requires an existing directory.
- Received files keep the existing exclusive-install plus SHA-256/size verification and journal-before-ACK path: a missing/unwritable directory or corrupt bytes leaves the message unacknowledged and unread, and retries re-deliver the same message exactly once.
- `bin/a2a-msg.mjs` does not exist on this baseline (P4); the `--download-dir` flag lives on `scripts/im-mcp.mjs` for now.

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
