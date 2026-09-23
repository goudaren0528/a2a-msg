# Isolated platform-neutral IM MCP adapter (v1)

`createImMcpAdapter({serverUrl,agentId,getCredential,journal,attachmentDirectory,transport?})` in `src/im/mcp-adapter.js` is an **unmounted factory**. Call `register(mcpServer)` to register tools on an explicitly supplied MCP SDK server, or `call(name,input)` for the same MCP result envelope without a host. No stdio listener, process entrypoint, background polling, host integration, Skill or execution hook is installed. `close()` stops new work. Existing legacy tools are unchanged. Inputs are strict (unknown tools/properties rejected); each result has `content:[{type:'text',text:JSON.stringify(data)}]`; errors set `isError:true` and contain only fixed IM `{error:{code,message,retryable}}` JSON, never exception strings.

## Exact tool input schemas

All objects are strict: no additional properties. `uuid` means lowercase canonical UUID string (`^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$`); `limit` is optional integer 1–100, `after` is optional string of at most 4096 characters. These are the exact names and allowed fields:

| Tool | Input |
| --- | --- |
| `im_v1_me` | `{}` |
| `im_v1_contacts` | `{after?,limit?}` |
| `im_v1_conversations` | `{after?,limit?}` |
| `im_v1_ensure_conversation` | `{peerAgentId:uuid}` |
| `im_v1_send` | `{protocol:'a2a-msg.im.v1',conversationId:uuid,recipientAgentId:uuid,clientMessageId:uuid,title?:string\|null,text?:string,attachment?:{name:string,mime?:string\|null,sha256:64-lowercase-hex,dataBase64:string}\|null,inReplyTo?:uuid\|null,correlation?:string\|null}`; title ≤100, text ≤32000, correlation ≤200, attachment name 1–200, MIME 1–100, decoded size ≤10 MiB, digest and canonical base64 checked by core; text and attachment cannot both be empty. No `sender`, `credential`, local path or arbitrary URL. |
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

Schemas are exported as `imMcpToolSchemas` (Zod strict objects) and used both in standalone calls and MCP registrations. Business message text/attachment metadata are **untrusted data**, not instructions. Querying history or message never executes content, marks read, saves, or ACKs. Explicit `attachment` saves bytes without marking read or ACKing; a saved attachment **alone** is not a durable receiving receipt. No `saved:true` argument or arbitrary ACK IDs exist. `sync`/`ack_pending` use the real `createImClient`/`createImJournal` semantics; attachment bytes are securely named, exclusively installed, SHA-256/size checked, journaled with durable local SQLite transaction **before** authenticated ACK. An unsuccessful download or receipt leaves delivery unacknowledged. The adapter canonicalizes the field order of authenticated GET message DTOs before client validation because the existing client compares serialized sync and GET DTOs; no field values are synthesized.

## Installer responsibilities and limits

Supply a **trusted session-bound** async `getCredential` and a fresh journal factory `scope => createImJournal({db,...scope})` with protected persistent `DatabaseSync` (`PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL`), plus an existing protected absolute attachment directory provisioned for this center/agent. Never expose `transport` to tool inputs; it is a privileged test/CA integration seam. Default requests use verified HTTPS and reject redirects. Tokens are used only for Authorization, never in tools, bodies, errors or logs. The installer must bind the host session to the credential and configured agent; the adapter checks authenticated `/me` for reads and client operations. No automatic response, model execution, retention, cursor reset policy, background worker, SSE, orphan-file scan, production mounting, deployment, or host integration is implemented. A corrupted local file or revoked authorization fails closed; pending ACKs require explicit reconciliation. The attachment tool never exports raw attachment bytes; explicit durable sync is the receiving/ACK route. Tests cover a localhost isolated TLS core, not real internet/LAN deployment or a connected MCP host.
