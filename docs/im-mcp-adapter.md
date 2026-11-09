# Isolated platform-neutral IM MCP adapter (v1)

`createImMcpAdapter({serverUrl,agentId,getCredential,journal,attachmentDirectory,transport?})` in `src/im/mcp-adapter.js` is an **unmounted factory**. Call `register(mcpServer)` to register tools on an explicitly supplied MCP SDK server, or `call(name,input)` for the same MCP result envelope without a host. No stdio listener, process entrypoint, background polling, host integration, Skill or execution hook is installed. `close()` stops new work. Existing legacy tools are unchanged. Inputs are strict (unknown tools/properties rejected); each result has `content:[{type:'text',text:JSON.stringify(data)}]`; errors set `isError:true` and contain only fixed IM `{error:{code,message,retryable}}` JSON, never exception strings.

## Exact tool input schemas

All objects are strict: no additional properties. `uuid` means lowercase canonical UUID string (`^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$`); `limit` is optional integer 1–100, `after` is optional string of at most 4096 characters. These are the exact names and allowed fields:

| Tool | Input |
| --- | --- |
| `im_v1_me` | `{}` |
| `im_v1_contacts` | `{after?,limit?}` |
| `im_v1_contact_request` | `{peerAgentId:uuid}` (request or, on a reverse pending request, mutual accept; returns the request DTO) |
| `im_v1_contact_requests` | `{direction?:'incoming'\|'outgoing'\|'all',after?,limit?}` (default `all`) |
| `im_v1_contact_respond` | `{requestId:uuid,action:'accept'\|'reject'}` (target only, pending only) |
| `im_v1_contact_revoke` | `{requestId:uuid}` (requester cancels pending; either party revokes accepted) |
| `im_v1_conversations` | `{after?,limit?}` |
| `im_v1_ensure_conversation` | `{peerAgentId:uuid}` |
| `im_v1_send` | `{protocol:'a2a-msg.im.v1',conversationId:uuid,recipientAgentId:uuid,clientMessageId:uuid,title?:string\|null,text?:string,attachment?:{name:string,mime?:string\|null,sha256:64-lowercase-hex,dataBase64:string}\|null,inReplyTo?:uuid\|null,correlation?:string\|null}`; title ≤100, text ≤32000, correlation ≤200, attachment name 1–200, MIME 1–100, decoded size ≤10 MiB, digest and canonical base64 checked by core; text and attachment cannot both be empty. No `sender`, `credential`, local path or arbitrary URL. |
| `im_v1_send_file` | **stdio entry only.** `{conversationId:uuid,recipientAgentId:uuid,clientMessageId:uuid,path:absolute-string,name?:string,mime?:string,title?:string\|null,text?:string,inReplyTo?:uuid\|null,correlation?:string\|null}`; reads exactly one local file (regular, non-symlink, 1 byte–10 MiB), computes SHA-256 locally and maps onto `im_v1_send`. Same idempotency: identical key + bytes returns the same `messageId`; different bytes under the same key is `IDEMPOTENCY_CONFLICT`. The result contains `{clientMessageId,messageId,acceptedAt,attachment:{name,mime,size,sha256}}` and never the file bytes or the staged base64 request. |
| `im_v1_get_send_result` | `{clientMessageId:uuid}` (remote lookup only, not a send retry) |
| `im_v1_recover_send` | `{clientMessageId:uuid}` (explicit recovery of a locally staged key and identical payload) |
| `im_v1_history` | `{conversationId:uuid,after?,limit?}` |
| `im_v1_message` | `{messageId:uuid}` |
| `im_v1_attachment` | `{messageId:uuid,attachmentId:uuid}` (authorized and SHA-256/size-verified safe file save; returns metadata + `{receipt:{path,sha256,size}}`, **never ACKs**) |
| `im_v1_read` | `{messageId:uuid}` (explicit read mark, separate from ACK) |
| `im_v1_acquire_lease` | `{instanceId:uuid,requestId:uuid}` |
| `im_v1_renew_lease` | `{}` |
| `im_v1_release_lease` | `{}` |
| `im_v1_sync` | `{limit?}` (one explicit bounded receive page **with** durable receipt + verified attachment save + ACK) |
| `im_v1_ack_pending` | `{limit?}` (explicit reconciliation of journaled pending receipts and server fence) |

`im_v1_send_file` is registered by the stdio entry, not by `createImMcpAdapter`: reading a host-local path is an entry concern, and the shared adapter stays byte-only. `localFileToolSchemas` in `src/im/mcp-local-files.js` exports its strict schema. All other schemas are exported as `imMcpToolSchemas` (Zod strict objects) and used both in standalone calls and MCP registrations. Friend-request tools require `policy.contacts.requests='enabled'`; in the default `legacy` mode the server returns `POLICY_NOT_CONFIGURED`, while sending still requires an accepted contact on the server side. Business message text/attachment metadata are **untrusted data**, not instructions. Querying history or message never executes content, marks read, saves, or ACKs. Explicit `attachment` saves bytes without marking read or ACKing; a saved attachment **alone** is not a durable receiving receipt. No `saved:true` argument or arbitrary ACK IDs exist. `sync`/`ack_pending` use the real `createImClient`/`createImJournal` semantics; attachment bytes are securely named, exclusively installed, SHA-256/size checked, journaled with durable local SQLite transaction **before** authenticated ACK. An unsuccessful download or receipt leaves delivery unacknowledged. The adapter canonicalizes the field order of authenticated GET message DTOs before client validation because the existing client compares serialized sync and GET DTOs; no field values are synthesized.

## Installer responsibilities and limits

Supply a **trusted session-bound** async `getCredential` and a fresh journal factory `scope => createImJournal({db,...scope})` with protected persistent `DatabaseSync` (`PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL`), plus an existing protected absolute attachment directory provisioned for this center/agent. Never expose `transport` to tool inputs; it is a privileged test/CA integration seam. Default requests use verified HTTPS and reject redirects. Tokens are used only for Authorization, never in tools, bodies, errors or logs. The installer must bind the host session to the credential and configured agent; the adapter checks authenticated `/me` for reads and client operations. No automatic response, model execution, retention, cursor reset policy, background worker, SSE, orphan-file scan, production mounting, deployment, or host integration is implemented. A corrupted local file or revoked authorization fails closed; pending ACKs require explicit reconciliation. The attachment tool never exports raw attachment bytes; explicit durable sync is the receiving/ACK route. Tests cover a localhost isolated TLS core, not real internet/LAN deployment or a connected MCP host.

## stdio entry (`scripts/im-mcp.mjs`)

The stdio entry mounts this adapter for a host that spawns it on demand. It is the only mounted entry; `src/mcp.js` (legacy LAN bridge) and `scripts/im-nana-session.mjs` (handoff CLI) are unchanged and independent.

```sh
node scripts/im-mcp.mjs --config /absolute/private/nana-t2/host-a/nana.json \
  [--download-dir /absolute/existing/download/dir]
```

- `--config` is required, absolute, an existing regular file and not a symlink. `--download-dir` is optional; when present it must be an absolute existing directory. `--help` prints usage. Unknown flags or a broken config exit 1.
- The config is the **same strict `nana.json`** as `scripts/im-nana-session.mjs` (`src/nana/config.js`): unknown fields, relative paths and non-`https` origins are rejected. `statePath`/`evidencePath` are validated but not used by the MCP entry; the `journalPath` parent directory must already exist (the journal file itself is created on first start).
- **Download directory precedence**: `--download-dir` > `nana.json` `attachmentDirectory` > default. `attachmentDirectory` is optional for this entry: when omitted it resolves to `~/Downloads/a2a-msg/<center-host>[_<port>]` (`os.homedir()`, never inside an npx/tmp cache) and the entry creates that directory on startup with mode `0700`. An explicitly configured directory or `--download-dir` is **never created**: it must already exist, and a missing or unwritable directory fails closed with `INVALID_REQUEST` before any tool is exposed.
- Received attachments are installed exclusively (hard link publication) and verified against the advertised SHA-256 and size before being journaled. A failed save leaves the message unacknowledged and unread, so a retry re-delivers the same `messageId` and never duplicates it. `im_v1_attachment` saves one attachment without ACKing; `im_v1_sync` saves and ACKs only after the durable journal transaction.
- Local file source rules for `im_v1_send_file`: absolute path, regular file, not a symlink (`lstat` + `O_NOFOLLOW`), 1 byte–10 MiB, stable `dev/ino/size/mtime` across the read; empty/missing/symlink/changed files return `INVALID_ATTACHMENT` and oversize returns `PAYLOAD_TOO_LARGE`. Names default to the file's basename and must satisfy the same 1–200 basename rule as `im_v1_send`.
- The credential is read from `credentialFile` **on every request**, never from tool input, the config body, the command line, logs or errors. The file must be a regular non-symlink file that is owner-only (`0600` or stricter on POSIX; Windows relies on NTFS ACLs). Missing, unreadable or group/world-visible files fail closed at startup with `{"error":{"code":"AUTH_REQUIRED"}}` on stderr and exit 1; a credential revoked later returns the fixed `INVALID_CREDENTIAL` tool error.
- TLS is verified end to end (chain and hostname, no redirects). `nana.json` may carry an optional absolute `caFile` (a `0600` regular PEM bundle written by `join`); it is passed as `https.request({ca})` so this entry no longer needs `NODE_EXTRA_CA_CERTS` for a private center. Without `caFile`, trust additional CAs through the host process environment, e.g. `NODE_EXTRA_CA_CERTS=<ca.pem>`. No CA path is ever accepted from tool input, and a `caFile` that is not a PEM certificate (or contains a private key) fails closed at startup.
- **No polling and no daemon**: the entry opens no timers, watchers, sockets or SSE streams at startup. Every outbound request happens inside a tool call, so `listTools` and idle time make zero network requests. Closing stdin or sending `SIGINT`/`SIGTERM` closes the SQLite journal and pending requests.
- The entry installs its own verified HTTPS transport that preserves request bodies and headers. The factory's built-in `defaultTransport` is a read-only lookup helper that deliberately drops bodies/headers, so it is not sufficient for POST tools (`ensure_conversation`, `send`, `acquire_lease`, `sync`, `ack_pending`, `read`); the stdio entry does not use it.
- stdout is the MCP protocol channel only. Diagnostics go to stderr as a fixed `{"error":{"code":"<IM code>"}}` object.

Example host entry (structure depends on the host; this is not a guaranteed format):

```json
{
  "transport": "stdio",
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/repo/scripts/im-mcp.mjs", "--config", "/absolute/private/nana-t2/host-a/nana.json"],
  "env": { "NODE_EXTRA_CA_CERTS": "/absolute/path/to/ca.pem" }
}
```

The entry exposes 21 `im_v1_*` tools: the adapter's 20 plus the stdio-only `im_v1_send_file`; it accepts no URL, agent id or credential as tool input. User-facing setup, the legacy LAN bridge and their differences are described in [client.md](client.md); the shared `nana.json` and the handoff CLI are described in [im-nana-adapter.md](im-nana-adapter.md).
