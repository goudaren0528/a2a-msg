# Changelog

## Unreleased

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
