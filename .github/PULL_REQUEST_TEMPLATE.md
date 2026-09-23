## Scope and requirements

- PRD requirement(s), or reason this is outside the [Agent IM PRD](../docs/prd/a2a-msg-agent-im-v1.md):
- Current-source behavior vs. planned behavior (do not claim unshipped features):

## Verification

- `npm test` result:
- `node --test integrations/opencode/*.test.mjs` result (if relevant; explain skip):
- Other tests and manual checks, with platform and limitations:

## Compatibility and security

- API/identity compatibility and new Agent framework or host dependencies (can independent clients operate without OpenCode?):
- Migration, backup, rollback, old message/read state and old-data permissions (or N/A with reason):
- Authentication, attachment ACL, ACK/retry and untrusted content effects (or N/A with reason):
- Confirm examples use fictional data only; no secrets, private config, production DB, real message bodies or attachments:

Do not submit exploit details in a PR; see [SECURITY.md](../SECURITY.md).
