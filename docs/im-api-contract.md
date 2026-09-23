# IM v1 bounded contract (implementation slice)

This document describes only `src/im/contracts.js` and `src/im/config.js`, not a deployed API. `PROTOCOL = 'a2a-msg.im.v1'`. New IM is disabled and new writes paused by default. No server authentication, endpoint, TLS termination, storage, lease enforcement or purge is implemented by these pure functions.

## Message input

`normalizeMessageRequest(raw, { maxAttachmentBytes = 10485760 })` accepts only these request fields: `protocol` (exact protocol literal), `conversationId`, `recipientAgentId`, `clientMessageId` (UUID strings), `title` (optional null or string up to 100 UTF-16 code units), `text` (optional string up to 32000 UTF-16 code units), `attachment` (optional null or `{name, mime?, sha256, dataBase64}`), `inReplyTo` (optional null or UUID), `correlation` (optional null or string up to 200 UTF-16 code units). Unknown keys, including sender/from/auth/workspace, fail; identity must come from a separate authenticated server context. No title/text trimming. Missing title, attachment, reply and correlation become null; missing text becomes empty string. Text-empty without attachment fails. A title of null is valid. An explicitly present zero-byte attachment is invalid even when text is nonempty.

Attachment name is a nonempty basename of at most 200 UTF-16 code units; separators, `..`, controls and DEL are rejected (never silently sanitized). MIME, if present, is nonempty and at most 100 UTF-16 code units; absent/null becomes null. SHA-256 is lowercase 64-digit hex. Base64 is canonical standard padded encoding (no whitespace/URL-safe variant), bounded before decoding and round-trip checked; decoded bytes are checked against SHA-256. The resulting attachment contains `{name,mime,size,sha256,bytes:Buffer}`. Maximum original attachment is 10 MiB, and caller overrides may only reduce it. `fingerprintMessage(normalized)` returns lowercase SHA-256 of an ordered JSON tuple containing protocol, conversation ID, recipient ID, client message ID, title, text, attachment name/MIME/size/digest (not raw bytes), reply and correlation. It excludes generated server IDs/timestamps. Caller must validate and normalize before fingerprinting.

`ImError(code)` has fixed safe `message`, HTTP `status` and `retryable`, never message payload or credentials. Code → HTTP status / retryable: INVALID_REQUEST 400/no; UNSUPPORTED_VERSION 400/no; INVALID_ATTACHMENT 400/no; AUTH_REQUIRED 401/no; INVALID_CREDENTIAL 401/no; TLS_REQUIRED 403/no; OPERATION_FORBIDDEN 403/no; RESOURCE_NOT_FOUND 404/no; IDEMPOTENCY_CONFLICT 409/no; LEASE_CONFLICT 409/yes; STALE_FENCE 409/no; LEASE_EXPIRED 409/yes; DELIVERY_REQUIRED 409/no; SYNC_BLOCKED 409/yes; CURSOR_RESET_REQUIRED 410/no; IDEMPOTENCY_WINDOW_EXPIRED 410/no; PAYLOAD_TOO_LARGE 413/no; RATE_LIMITED 429/yes; IM_DISABLED 503/no; NEW_WRITES_DISABLED 503/no; POLICY_NOT_CONFIGURED 503/no; STORAGE_UNAVAILABLE 503/yes; CLOCK_UNSAFE 503/no. Retryable is guidance only; send retries must first query by original client key and use the original payload.

## Configuration

`parseImConfig(input = {})` accepts only the following nested object (all unknown keys are rejected):

```js
{
  enabled: true, writeMode: 'enabled', // optional defaults false / 'paused'
  transport: { mode: 'local-test', serverUrl: 'http://127.0.0.1:8787' },
  retention: { policy: {
    messageRetentionMs: 2592000000, attachmentRetentionMs: 1728000000,
    idempotencyRetentionMs: 2678400000, safeRetryWindowMs: 604800000,
  } },
  lease: { ttlMs: 90000, renewalMs: 30000 },
  limits: { maxAttachmentBytes: 10485760, maxBodyBytes: 65536,
    maxFileBodyBytes: 16777216, maxConnections: 100, maxRequestsPerMinute: 600 },
}
```

Numbers are positive safe integers. This example policy is **test-only**, not a production retention decision. `limits` defaults to a fresh copy of the shown finite values if omitted or explicitly `undefined`; `enabled` and `writeMode` also default when explicitly `undefined`; when supplied, all five fields are required and attachment/body/file ceilings can only decrease. Enabled mode requires transport even while writes are paused: `local-test` permits HTTP/HTTPS only at `localhost` or actual loopback IP; `direct-tls` requires HTTPS. Userinfo, query, fragment and non-root path are rejected. Proxy TLS, skipTLS and insecure options are unsupported. Config validation does not verify the actual HTTP adapter/certificate; that enforcement is a separate required task. Enabled writes require explicitly supplied complete retention policy and lease: attachment retention ≤ message retention, idempotency retention ≥ both message retention and safe retry window, renewal < lease TTL. Absent/incomplete policy fails closed; no retention defaults or purge mechanism are assumed. No environment or config files are written.
