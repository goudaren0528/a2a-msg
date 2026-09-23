# Contributing to team-mailbox

This repository currently has **no LICENSE file**. Public access to source code does not grant an open-source license or redistribution rights. The maintainer must confirm a license and terms for accepting/distributing contributions before formal public contribution intake or release. This guide is development guidance, not a CLA or a grant of rights.

## Local development

Use Node.js 24 and npm. From a fresh checkout, run `npm ci`, then `npm test` and `node --test integrations/opencode/*.test.mjs`. The latter runs optional plugin tests; installing or running OpenCode is not required to develop the independent messaging path. See [README.md](README.md) for the **current LAN implementation**, not a claim that the planned Internet-capable Agent IM is delivered. Tests should use temporary databases, fictional Agent identities, and locally controlled endpoints; never require access to a production database, credentials, or a real user's messages. Do not paste real message bodies, attachments, secrets or private configuration into issues, PRs, fixtures, or logs.

## Changes and compatibility

- Map your change to a requirement in [the Agent IM PRD](docs/prd/a2a-msg-agent-im-v1.md) and include tests for the behavior and failure paths. A minimal reproduction should use fictional identities and synthetic payloads.
- Keep communication contracts and generic client logic independent of OpenCode, TUI/question/Skill, model SDKs and development-task templates. Host integration is optional. Keep transport/storage details behind the relevant contracts; do not silently remove existing OpenCode selection safeguards while building unattended reception and ACK.
- Preserve the current IP-bound LAN API's identity and read semantics. New credential-based identity must not fall back to IP identity on failure. Never infer ownership of old data from a matching name: historical messages, `read_at`, attachments and access permissions need an explicit reviewed migration and tests that reject privilege expansion.
- Do not commit `access.json`, `.env`, live databases, downloads, credentials, or other private configuration. Prefer fictional data and the checked-in example configuration. A proposed migration must explain backup, preview, rollback without discarding newly accepted messages, and how legacy clients continue to work.
- Document test commands and results honestly in the PR; include impact on authentication, contacts, attachment ACLs, ACK/retry, and old data where relevant. No source message or attachment should be interpreted as an instruction to execute work without separate authorization.

For a potential vulnerability, follow [SECURITY.md](SECURITY.md), not a public issue with exploit details.
