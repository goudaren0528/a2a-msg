# P6-A maintenance plan v2: approved codec and read-only planner contract

Status: **P6-A design APPROVED with the incorporated Oracle amendments.**
Implementation and runtime acceptance are **NOT DONE**; pure codec is ready for
implementation first. Approval of this design grants no execution authority.
Evidence baseline: `609a97acd1fc78e5393a2e52154be809353df9d6`.
This is a field-table and bounded API handoff, not a release or execution approval.
The first implementation is a **schema-v4, strictly read-only, non-executable
diagnostic preview**. All algorithms below are specification requirements, not
claims of implemented or tested behavior.

## 1. Scope, authority, and committed evidence

This approved contract refines P6 in [the design](im-recovery-retention-v2-design.md#7-留存批次和备份清理)
and [the implementation plan](im-v2-implementation-plan.md). In particular it
specifies plan **version 2**, replacing the design's preliminary version-1 plan
shape for future P6 consumers only. It does not reinterpret existing records.

Approved constraints remain: content/attachments 90 days, retry 7 days, ordinary
audit 180 days; expiry, purge and backup cleanup default false. Wire v2, client
journal v2, old LAN/schema3, and all v4 DDL/checksum goldens stay unchanged.
Schema5 and its independent maintenance time anchor require a later explicit
migration and reviewed backup/recovery/runtime support. There is no maintenance
writer, apply stub, deletion adapter, automatic migration, or public admin route
in this handoff. A plan/hash, including JSON saying `executable:true`, is never
authority to mutate anything.

Committed source facts checked for this table:

| Evidence | Relevant fact |
| --- | --- |
| [v2 config](../src/im/v2/config.js) | Full policy order, exact durations, lower-only maintenance limits; disabled/paused config may lack retention, which is insufficient for this preview. |
| [v4 schema internals](../src/im/v2/schema-internal.js) and [frozen inherited schema](../src/im/v2/schema-history.js) | Actual columns/indexes below; `im_maintenance_runs.kind` is only expire/scrub/audit; `candidate_json` has SQLite `length(...) BETWEEN 2 AND 65536` and JSON validity checks. |
| [schema dispatcher](../src/im/v2/schema.js) | Current supported versions are exactly `[4]`; no schema5 support is implied. |
| [messages](../src/im/v2/messages.js), [delivery](../src/im/v2/delivery.js) | Storage client key and wire operation key differ; ACK/read are original durable facts; the only ordinary audit actions eligible for a future approved deletion are `conversation.created` and `message.read`. |
| [clock](../src/im/v2/clock.js), [auth](../src/im/v2/auth.js), [server](../src/im/v2/server.js) | `runRead`, `auth.withRead`, authentication and center construction can reach durable clock anchoring. None is a read-only preview wrapper. Active state has run/epoch/activation invariants beyond a status string. |
| [v2 backup registry](../src/im/v2/backup-registry.js) | Public registry has verify/withVerifiedBackup/createStageHold/bindPrepareHold/getHold/checkCleanup, no list API. `checkCleanup` always returns `allowed:false`; it is not a deletion capability. |

This final reconciliation also reads and aligns the completed
[maintenance handoff](im-v2-maintenance-contract.md) and
[schema5 contract](im-v2-maintenance-schema-v5-contract.md). P6-A approval does
not freeze the remaining schema5 execution formats or claim their implementation.

## 2. Primitive types, canonical bytes, and limits

In every table, fields are **required in exactly the listed canonical order**;
nullable means an explicit JSON null, never omission. No extension fields are
allowed. The object encoder accepts ordinary data objects in any insertion order
and constructs the listed order; the byte decoder rejects noncanonical order.

| Type | Exact rule |
| --- | --- |
| `N` | JSON number, nonnegative safe integer, at most 9007199254740991; reject negative zero, fractions, exponent notation in canonical bytes, NaN/Infinity and integer strings. |
| `P` | `N` greater than zero. |
| `Ms` | `N`, milliseconds since Unix epoch; arithmetic checked before addition/subtraction. |
| `UUID` | Lowercase ASCII `8-4-4-4-12` hex/hyphen form used by existing v2 validators; do not add an RFC version-bit restriction. |
| `Hash` | Exactly 64 lowercase hexadecimal characters representing SHA-256. |
| `Kind` | Exactly `expire`, `scrub`, or `audit`. Backup preview has a separate DTO. |
| `Key` | Two-element array `[time,id]`: content uses `[expires_at,UUID]`; audit uses `[occurred_at,AuditId]`. Compare time numerically then UUID ASCII/BINARY or AuditId numerically. |
| `AuditId` | Signed safe integer, including zero and negative values; SQLite `im_audit.id INTEGER PRIMARY KEY` has no positive-ID CHECK. Reject values outside JS safe range; negative zero is noncanonical. |
| `Cursor` | Canonical, unpadded base64url string of at most 1024 ASCII characters, decoded bytes at most 768; exact form in section 5. |

`C(x)` is UTF-8 of `JSON.stringify` on a freshly constructed ordinary object with
the field orders here (arrays retain their specified order), without BOM,
indentation, extra whitespace, or trailing newline. Unicode is not normalized.
Strings must contain valid Unicode scalar sequences, rejecting lone surrogates;
decode UTF-8 fatally, never with replacement. Raw stored text is hashed as its
actual UTF-8 bytes, with fatal decoding before interpreting it as text. Do not
silently turn invalid stored bytes into a different valid value.

The byte decoder tokenizes first to reject duplicate object keys (including
escaped aliases) at every depth, then validates the exact shape, then requires
byte-for-byte equality with `C(value)`. Thus key permutations, alternative
escapes, reordered candidates/held entries, whitespace and noncanonical numeric
spellings fail rather than being normalized on input. All inputs must be data:
reject accessors, symbol/non-enumerable extra properties, exotic prototypes,
functions, undefined, cycles and sparse arrays. Copy byte inputs immediately;
accept only ordinary non-shared Uint8Array/Buffer storage. Decoded DTOs are
deep-frozen ordinary objects/arrays. A returned byte array is a defensive copy,
not a mutable alias to the codec's state; do not claim Object.freeze protects
typed-array contents. Maximum nesting depth is 16, root depth 1.

Additional conservative P6 bounds: **each canonical plan and each standalone
metadata DTO at most 65536 UTF-8 bytes**; envelope bytes, when serialized, have
the same 65536-byte ceiling. Stop a normal batch early to fit the envelope too.
The serialized `candidates` array must additionally satisfy the existing
`candidate_json` **SQLite character** ceiling of 65536. These are separate
checks: the DDL is not a 64KiB UTF-8 check. P6-A writes neither candidate_json nor
a preview row. Future persistence must not assume an envelope fits merely
because its candidates do. Budget/range planning reserves worst-case scalar
widths and cursor/envelope overhead before accepting a group; final exact
serialization must satisfy both checks.

Domain-separated hash definition (approved new plan formats only):

```text
H(tag, bytes) = lowercaseHex(SHA256(ASCII(tag) || 0x00 || bytes))
planHash = H("a2a-msg.im.maintenance.plan.v2", C(plan))
```

Tags below have no trailing NUL in the tag itself. Existing retention-policy,
send-fingerprint, schema, backup and recovery hashes keep their existing
algorithms; do not retroactively add this domain prefix to them.

## 3. Complete plan field table

| Order | Field | Type and source/invariant |
| --- | --- | --- |
| 1 | version | Literal `2`. |
| 2 | runId | Fresh internal UUID for this preview, generated after admin and target gates. No caller-chosen runId; no durable run is created. |
| 3 | instanceId | UUID read from `im_instance_identity.instance_id`. |
| 4 | instanceCreatedAt | Ms from the same singleton's `created_at`; part of identity and every cursor scope. |
| 5 | centerEpoch | UUID from validated active `im_center_state.center_epoch`. |
| 6 | kind | Kind. |
| 7 | executionPolicyHash | Hash of the complete current canonical policy, checked against trusted configuration and the matching `im_retention_policies` row. |
| 8 | createdAt | Ms, fresh trusted wall sample taken in this read snapshot, equal to clockObservedAt. |
| 9 | expiresAt | Checked `createdAt + budget.planTtlMs`; reject overflow. Valid only while `now < expiresAt`; equality is expired. |
| 10 | clockObservedAt | Ms, same sample as timeEvidence.observedWallAt; no persisted clock update. |
| 11 | timeEvidence | Exact object in section 4. |
| 12 | selection | Exact object in section 5. |
| 13 | candidates | Array of 0..100 candidate summaries below; unique identity/key, strict increasing Key order. |
| 14 | candidateDigest | Hash in section 7; binds actual contents and the classified approved range, not counts alone. |
| 15 | budget | Exact object in section 8. |
| 16 | scan | Exact object in section 9. |

Candidate summary order (same object shape for all kinds):

| Order | Field | Type / invariant |
| --- | --- | --- |
| 1 | key | Key used for selection and sorting. |
| 2 | messageId | UUID for expire/scrub; null for audit. |
| 3 | auditId | AuditId for audit; null otherwise. |
| 4 | contentPolicyHash | Historical `im_content_state.policy_hash` Hash for content; null for audit. |
| 5 | expectedState | `live` for expire, `expired` for scrub, null for audit. |
| 6 | expiresAt | Original content deadline Ms, equal to key[0]; null for audit. |
| 7 | expectedFingerprint | Hash of the original group/row descriptor in section 7. |
| 8 | expectedBytes | N logical scrub bytes, as defined in section 8; zero for expire-only. |
| 9 | expectedRows | P actual business rows whose stored values would change, not the number of groups. |

Summaries expose only minimal IDs, times, sizes and hashes. They do not expose
body/title/correlation, attachment names/mime/data, arbitrary audit strings,
credentials, filesystem paths, exception text, or raw JSON payload metadata.
Raw fields exist transiently only inside the bounded verifier/hash stream.

## 4. Frozen timeEvidence shape and interpretation

Order is exactly:

```text
{version:1, schemaVersion:4|5, observedWallAt:Ms, globalFloorObservedAt:Ms,
 anchorGeneration:null|P, anchorHash:null|Hash, sessionNonce:null|UUID,
 anchorWallAt:null|Ms, monotonicElapsedMs:null|N, maxForwardJumpMs:P,
 executable:boolean,
 reason:null|"SCHEMA_UPGRADE_REQUIRED"|"TIME_ANCHOR_REQUIRED"|
        "PROCESS_REANCHOR_REQUIRED"|"CLOCK_UNSAFE"}
```

`globalFloorObservedAt` reads `im_clock.last_observed_at` without writing.
`maxForwardJumpMs` equals budget.maxForwardJumpMs, at most 86400000. The anchor
fields describe the independent maintenance anchor, never im_clock disguised as
an anchor. No anchor/session is manufactured by the codec, a cursor, a wall
sample, or importing a historical JSON object.

| Source state | Exact evidence |
| --- | --- |
| v4 | All five anchor/session fields null; executable false; reason SCHEMA_UPGRADE_REQUIRED. This is every successful first-release preview. |
| v5 without validated anchor head | All five fields null; executable false; reason TIME_ANCHOR_REQUIRED unless a separately established clock fault takes precedence below. |
| v5 validated historical head, no private current session | Expose validated generation/hash/wall; nonce/elapsed null; executable false; reason PROCESS_REANCHOR_REQUIRED unless clock fault takes precedence. |
| v5 with genuine current private anchor capability | Generation/hash/wall/nonce/elapsed nonnull, checked by the separately reviewed time authority; executable true and reason null only if that authority passes. Failed check yields executable false/reason CLOCK_UNSAFE. |

Precedence: unauthorized/unsafe storage or malformed clock value is a safe local
error, not a misleading plan. If observed wall/floor is not a nonnegative safe
integer, or TTL cannot be safely formed, return MAINTENANCE_CLOCK_UNSAFE. For
otherwise representable diagnostics: v4 always keeps the mandated upgrade
reason; on v5 an independently established rollback/unsafe elapsed/forward-jump
fault yields CLOCK_UNSAFE before missing-head/session reasons; otherwise missing
head precedes missing session. A missing anchor alone does not discard a useful
diagnostic. No inference of a safe maintenance interval from a recently advanced
global floor is permitted. The anchor algorithm/DDL is outside this document.

The codec may validate a future v5 true-shaped object structurally, but neither
decode nor hash mints a current capability. It cannot return an executable
authorization object. TimeEvidence.executable is time evidence only; even an
authentic future true value cannot bypass complete=false, gates, plan expiry,
independent approval or the missing writer. First planner schema dispatch remains
v4-only and returns MAINTENANCE_SCHEMA_UNSUPPORTED for v5 until explicitly extended.

## 5. Selection, cursor, and indexed source predicates

Selection object order:

| Order | Field | Exact type / meaning |
| --- | --- | --- |
| 1 | version | Literal `1`. |
| 2 | cutoffAt | Ms; first page's observedWallAt, subsequent page's original cursor cutoff. Fixed for every page in this traversal. Must be <= current observed wall, otherwise cursor stale. |
| 3 | eligibleThroughAt | Content: cutoffAt. Audit: cutoffAt-15552000000 if nonnegative, otherwise null (no eligible audit row). Never saturate to zero and accidentally select occurred_at=0. |
| 4 | sortVersion | Literal `1`. |
| 5 | after | Key or null, decoded lower exclusive bound; not the original opaque cursor string. |
| 6 | limit | P, 1..100, default 20. Maximum base rows classified in this page, including held rows; not a promise of this many mutable groups. |
| 7 | effect | Exact kind mapping: expire -> `expire-only`, scrub -> `scrub`, audit -> `audit-delete`. purgeEnabled never changes the expire effect; scrub requires already-expired content. |
| 8 | auditActions | Audit: exactly `["conversation.created","message.read"]` in this order; content: empty array. |

Gate values are not caller inputs. Disabled gates still allow a diagnostic of
potential effects; expectedRows/Bytes describe those effects, not permission.
Effect is bound by executionPolicyHash. Policy `purgeEnabled=true` with
`expiryEnabled=false` is invalid, matching config validation.

Canonical decoded cursor is this exact array:

```text
[2,"maintenance",instanceId,instanceCreatedAt,centerEpoch,kind,
 executionPolicyHash,cutoffAt,1,[lastTime,lastId]]
```

Encode `C(array)` with unpadded base64url. Decode with strict byte/shape/canonical
re-encode checks. It binds instance birth, epoch, policy, cutoff and sort version.
It is a seek hint, not authority or a stored plan; no caller plan/fingerprint is
accepted with it. The local admin gate runs before disclosing whether IDs match.
Kind mismatch/malformed key is INVALID; valid but changed identity/epoch/policy
is TARGET_STALE or POLICY_STALE as appropriate. `limit` may change between pages;
it does not change the cursor's population. Traversal is not a cross-page SQLite
snapshot; inserts before an already passed key require a fresh traversal.

Exact base queries use actual schema columns. For after=null omit the seek
clause altogether. For a nonnull lower key use the **whole composite seek**:

```sql
-- expire: im_content_expiry(state,expires_at,message_id)
SELECT expires_at,message_id
FROM im_content_state
WHERE state='live' AND expires_at<=:eligibleThroughAt
  AND (expires_at,message_id)>(:afterTime,:afterId)
ORDER BY expires_at,message_id LIMIT :probeLimit;

-- scrub: im_content_scrub(state,scrubbed_at,expires_at,message_id)
SELECT expires_at,message_id
FROM im_content_state
WHERE state='expired' AND scrubbed_at IS NULL AND expires_at<=:eligibleThroughAt
  AND (expires_at,message_id)>(:afterTime,:afterId)
ORDER BY expires_at,message_id LIMIT :probeLimit;

-- audit: im_audit_occurred(occurred_at,id)
SELECT occurred_at,id
FROM im_audit
WHERE occurred_at<=:eligibleThroughAt
  AND (occurred_at,id)>(:afterTime,:afterId)
ORDER BY occurred_at,id LIMIT :probeLimit;
```

These row-value seeks mean `time>afterTime OR (time=afterTime AND id>afterId)`;
the indexed tuple form is the approved SQL, with numeric audit IDs and BINARY
content IDs. A future range verifier adds the corresponding
`(expires_at,message_id)<=(:endTime,:endId)` or
`(occurred_at,id)<=(:endTime,:endId)` upper bound, never an ID-only filter.

`:probeLimit` never exceeds remaining page slots plus one, nor the pre-reserved
remaining scan-row capacity. One-row keyset stepping is permitted. Queries must
use an indexed range, with no unbounded COUNT, OFFSET, full-DB hash, join
materialization or preloaded BLOB. Audit intentionally does **not** filter action
in SQL: protected/unknown actions must be classified, counted and traversed.
Body and payload are read only after section 8's projection/budget reservation.
Absent payload/reservation is represented explicitly, not hidden by an inner join.

### 5.1 Fixed approved range and lookahead

A page processes at most selection.limit base rows in key order, one complete
logical group at a time. Every processed base row becomes either a candidate or
one held entry. The approved interval is `(selection.after, scan.plannedRangeEnd]`
within the predicate above. A null end means an empty interval. The planner stops
normally at the first of: page limit, remaining mutation budget insufficient for
the next otherwise admissible group, or remaining serialized metadata capacity
insufficient. It never skips that next normal group to pack later small groups.
The stop occurs before adding the group to the interval. A group's intrinsic
oversize is instead a held classification and **does** advance the interval.

The last processed row is plannedRangeEnd/lastScanned. At normal termination,
one base-key lookahead determines hasMore; it is charged to scan cost but is not
a candidate, held row or interval member. It may have been the projected group
that could not fit. Its contents/hash are not authorization. At source end,
hasMore=false proves the exhausted suffix to eligibleThroughAt in this snapshot.

Future verification must enumerate the same bounded interval afresh with the
same predicate, inclusive upper composite key and strict lower composite key,
then reclassify and rehash every original fact. Compare the ordered per-key
outcomes, not just IDs/counts or an `IN(approvedIds)` query. Deletion, insertion,
state/action change, key move and content change **inside** the interval fail.
Moving an original member outside the range also fails because that member is
missing. When hasMore=false, verification additionally checks there is still no
eligible row after the end (or anywhere after selection.after for an empty
interval). When hasMore=true, outside-range changes are not silently pulled into
this approval; they belong to another preview. Limits still apply to verification;
an extra row beyond expected membership is sufficient to reject without reading
its payload. Never re-run `LIMIT n` from the old start and approve whatever now fits.

## 6. Held classifications and audit retention

Each held entry has fixed order:

```text
{key:Key, messageId:UUID|null, auditId:AuditId|null,
 reason:"OVERSIZED_GROUP"|"AUDIT_PROTECTED"|"AUDIT_ACTION_UNKNOWN",
 expectedFingerprint:Hash, expectedRows:N, expectedBytes:N}
```

Identity nullability matches candidate summaries. Oversize means the **whole**
effect cannot fit the total business-row or logical-byte cap, even in an empty
batch. It is not a partially scrubbed candidate. Fingerprint every held row/group
fully within scan limits; if that cannot be done, return incomplete, do not
pretend it was classified. An unknown/retained audit has expectedRows=0 and
expectedBytes=0. An oversized content group retains its full hypothetical costs.
All held outcomes are included in the interval digest. A held group's changed
facts/reason on future verification requires a new plan; it cannot become an
extra deletion under the old approval.

The audit delete allowlist is **only** `conversation.created` and `message.read`.
AUDIT_PROTECTED covers the following known retained actions:

```text
message.accepted, ack_delivery, expiry_receipt,
acquire_receiver, renew_receiver, release_receiver
```

All other actions are AUDIT_ACTION_UNKNOWN and held, including governance,
credential/security, migration, recovery, activation, backup provenance and
maintenance completion actions. This is an exact classification rule, not a
prefix-based permission or a suggestion to delete unfamiliar proof actions.
No `im_migration_runs`, `im_recovery_runs`, `im_maintenance_runs`, key reservation,
operation mapping, delivery, receipt or recovery/backup proof is audit-candidate
material. Referenced proof remains retained even if a future producer reuses an
allowlisted action: such producer changes require a new allowlist review before
writer implementation. Current sources use the two allowlisted actions only for
ordinary conversation/read events; the read fact itself remains in deliveries.

Held entries consume page slots, so a page of 100 held rows still advances its
cursor. There is no infinite retry of the first oversized/unknown group. A
normal remainder-budget stop does not advance past the unapproved group. At
least one individually admissible group fits an empty valid configured batch;
otherwise it is OVERSIZED_GROUP. A row whose fixed minimum summary cannot fit the
metadata cap is an invalid codec/configuration condition, not silently skipped.

## 7. Original-fact descriptors and deterministic digests

Descriptors are private transient values, not raw JSON attached to the plan.
The exact type-aware streaming frame below avoids NULL/empty/type ambiguity and
permits hashing a BLOB without buffering a whole message descriptor:

```text
F(null)       = ASCII("n;")
F(false)      = ASCII("b0;")
F(true)       = ASCII("b1;")
F(integer)   = ASCII("i" + canonicalSignedDecimal + ";")
F(text)      = ASCII("s" + utf8ByteLength + ":") || UTF8(text)
F(blob)      = ASCII("x" + byteLength + ":") || exactBlobBytes
F([v1..vn])  = ASCII("a" + n + ":") || F(v1) || ... || F(vn)
```

Decimal lengths have no leading zero except zero itself; nested arrays are
self-delimiting via their element counts. No objects occur inside F. A text
cell is `T(value) = null` for SQL NULL, otherwise
`[utf8ByteLength,H("a2a-msg.im.maintenance.text.v1",F(value))]`.
A payload cell is `[byteLength,H("a2a-msg.im.maintenance.blob.v1",F(blob)),
SHA256(exactBlobBytes)]`. The last hash has no domain prefix and must equal the
declared attachment SHA-256. Empty text T("") differs from null; SQL BLOB is not
text even if it contains valid UTF-8. Attachment payloads of length zero violate
the existing schema and are rejected, not normalized to absent payload.

### 7.1 Message-group descriptor (exact ordered arrays)

```text
[
  1, "message-group",
  [m.message_id,m.conversation_id,m.sender_id,m.recipient_id,
   m.client_message_id,m.accepted_at,m.in_reply_to,
   T(m.title),T(m.text),T(m.correlation)],
  [c.message_id,c.state,c.expires_at,c.expired_at,c.scrubbed_at,c.policy_hash,
   T(c.expiry_run_id),T(c.scrub_run_id)],
  [p.policy_hash,p.version,p.effective_at,p.message_retention_ms,
   p.attachment_retention_ms,p.safe_retry_window_ms,p.audit_retention_ms,
   T(p.canonical_json)],
  [k.sender_id,k.client_message_id,k.payload_hash,k.message_id,
   k.created_at,k.retry_until,k.status],
  [o.sender_id,o.origin_epoch,o.client_message_id,o.storage_client_message_id,
   o.source_protocol,o.message_id],
  reservationOrNull,
  payloadOrNull,
  [d.recipient_id,d.seq,d.message_id,d.acked_at,d.read_at],
  [v.conversation_id,v.agent_low,v.agent_high,v.created_at]
]

reservationOrNull = null | [r.attachment_id,r.message_id,r.size,r.sha256]
payloadOrNull = null | [a.attachment_id,a.message_id,T(a.name),T(a.mime),
                       a.size,a.sha256,payloadCell(a.data)]
```

Aliases refer exactly to im_messages/content_state/retention_policies/send_keys/
send_operation_keys/attachment_reservations/attachments/deliveries/conversations.
There is exactly one required message, content, history policy, sender key,
operation, delivery and conversation; zero-or-one reservation and payload, with
their actual presence encoded. Point lookups must reject duplicate/missing or
cross-linked required facts, not hide them through joins. The descriptor binds
all original columns of these rows, including full routing/identity, accepted
and reply facts, historical deadlines/policy, key retry/status and sourceProtocol.
The conversation row validates the sender/recipient pair. No agents/credentials
or entire recipient stream are pulled into this content fingerprint; they are
unchanged by these effects and do not substitute for local admin authority.

Validate canonical IDs, safe integers, FK-equivalent identity relationships,
content state/run nullability, historical policy hash and exact deadline
`accepted_at + message_retention_ms`, reservation/payload equivalence and actual
BLOB length/hash. Send key created_at must equal accepted_at and retry_until
must be >= created_at; preserve actual imported retry_until rather than
recalculating it from the current policy. Read requires a real nonnull ACK.
If content is not scrubbed, verify the stored send fingerprint using its actual
sourceProtocol (frozen v1 or v2 array algorithm) and the original bytes/metadata.
After scrub, the original send payload_hash is retained evidence; **never**
reconstruct it from empty fields or turn a v1 sourceProtocol into v2.
No new fields named originEpoch or recipientAgentId are assumed in im_messages.
The wire operation UUID comes from `o.client_message_id`; the stored message/key
client ID may be the 76-character `v2:<epoch>:<uuid>` storage ID.

`expectedFingerprint = H("a2a-msg.im.maintenance.message.v1", F(descriptor))`.
Every potentially mutable or retained identity/ACK fact in this group affects
that fingerprint. A corrupted declared hash cannot mask same-size altered BLOB
bytes. At most one payload BLOB is materialized at a time; hash it, release it,
then proceed. Projection and actual reads must come from the same snapshot.

### 7.2 Audit descriptor (exact ordered array)

```text
[1,"audit-row",a.id,T(a.actor_kind),T(a.actor_id),T(a.action),
 T(a.target_ids_json),a.occurred_at,T(a.safe_details_json)]
```

`expectedFingerprint = H("a2a-msg.im.maintenance.audit.v1", F(descriptor))`.
Validate actual JSON storage values, length and safe integers; retain their
**original text bytes**, not parsed/reformatted JSON, for hashing. Unknown action
strings and actor IDs appear only as text-cell hashes. Same count or same
occurred_at with changed metadata is a different row fingerprint. Audit JSON
may contain content-like data: neither it nor error strings appear in summaries.

### 7.3 Range and candidate digest (independently reproducible)

Make an ordered outcome array by merging candidates and held on Key. For each
candidate use `[key,"candidate",expectedFingerprint,expectedRows,expectedBytes]`;
for each held use `[key,reason,expectedFingerprint,expectedRows,expectedBytes]`.
Every classified base row appears exactly once. No elapsed time or incidental
number of repeated SQL probes is in an outcome.

```text
selectionIdentity = [2,instanceId,instanceCreatedAt,centerEpoch,kind,
 executionPolicyHash,selection.version,selection.cutoffAt,
 selection.eligibleThroughAt,selection.sortVersion,selection.after,
 selection.limit,selection.effect,selection.auditActions]

rangeDigest = H("a2a-msg.im.maintenance.range.v1",
 F([selectionIdentity,scan.plannedRangeEnd,scan.hasMore,outcomes]))

candidateDigest = H("a2a-msg.im.maintenance.candidates.v2",
 F([selectionIdentity,scan.plannedRangeEnd,rangeDigest,
    candidates.map(c => [c.key,c.messageId,c.auditId,c.contentPolicyHash,
      c.expectedState,c.expiresAt,c.expectedFingerprint,c.expectedBytes,c.expectedRows])]))
```

runId, createdAt, expiresAt, timeEvidence and observed scan cost are excluded
from candidateDigest but included in planHash via C(plan). A later verifier
recomputes facts under the approved selection identity; it must not demand an
identical elapsed execution time or replace fixed cutoff with its current time.
Budget caps remain independently bound by planHash. Incomplete plans may carry
a prefix digest; complete=false prevents treating it as a full approved range.
The digest is an integrity comparison, not an admin/approval signature.

## 8. Budgets: actual mutation units, logical bytes, scan reads

Budget object has this exact field order:

| Order | Field | Maximum/default and meaning |
| --- | --- | --- |
| 1 | maxRows | P <=100, default100, actual affected business rows. |
| 2 | maxProofRows | Literal2; at most one run row plus one completion audit row, never two extra business groups. |
| 3 | maxBytes | P <=10485760, default10485760 logical scrub bytes. |
| 4 | maxScanRows | P <=10000, default10000 row reads under the accounting below. |
| 5 | maxScanBytes | P <=104857600, default104857600 read-and-framing logical bytes. |
| 6 | maxScanMs | P <=1000, default1000 monotonic soft duration. |
| 7 | maxWriteMs | P <=1000, default1000 future transaction soft duration, no writer supplied. |
| 8 | planTtlMs | P <=300000, default300000. |
| 9 | maxForwardJumpMs | P <=86400000, default86400000. |
| 10 | plannedRows | N, sum candidate.expectedRows <=maxRows. |
| 11 | plannedBytes | N, sum candidate.expectedBytes <=maxBytes. |

Caps come only from validated trusted configuration; API inputs cannot raise or
override them. maxKeyReservations remains a required positive production
capacity configuration, not a candidate count or reason to delete reservations.
It does not require an unbounded reservation COUNT for this preview.

### 8.1 Mutation accounting (future intent only)

| Effect | Actual business rows and logical scrub bytes |
| --- | --- |
| expire-only | One im_content_state row changes live to expired with expiry time/run; one im_send_keys row iff status changes to expired. No message/payload changes. Bytes=0. |
| scrub | One content row for scrub time/run; key row iff status changes; message row iff stored fields differ; payload row iff present. Bytes=content scrub formula. |
| audit-delete | One selected im_audit row. Bytes=UTF8(actor_kind)+UTF8(actor_id)+UTF8(action)+UTF8(target_ids_json)+UTF8(safe_details_json), i.e. all removed text columns. Numeric columns have zero logical scrub bytes. |

Content scrub formula is
`UTF8Bytes(m.text)+nullableUTF8Bytes(m.title)+nullableUTF8Bytes(m.correlation)`
plus, if payload exists,
`actualBLOBBytes(a.data)+UTF8Bytes(a.name)+nullableUTF8Bytes(a.mime)`.
NULL contributes zero, empty contributes zero bytes but remains a distinct
original fact and can still require a row mutation (e.g. title empty to NULL).
Do not include immutable IDs/hash columns in logical content bytes, or count
entire serialized SQL rows as content bytes. Metadata framing *does* count under
scan bytes below. Changed timestamps/run IDs count as changing that row but have
zero scrub bytes. Suppress no-op UPDATEs by exact precondition, not by trusting
SQLite changes() to mean values differed. A plan selecting content always has
at least its content row change; already scrubbed rows are outside the predicate.

No key, mapping, message, reservation, delivery, receive-state, progress or
receipt row is deleted; no ACK/read timestamp is synthesized/cleared. Payload
DELETE removes name/mime/data together; never UPDATE data=x'' or size=0.
All mutations for a logical message group must fit together. A 10485760-byte
attachment plus its nonempty name alone exceeds maxBytes and is held for a
scrubbing effect; no larger-budget exception, attachment-only partial clear or
later-group substitution within that group's approval exists. The same group
when live is an expire-only candidate with zero scrub bytes regardless of purge.
The 100-row rule cannot be implemented as 100 messages. Example: already-expired,
unscrubbed groups with already-expired keys, nonempty message text and present
small payloads each change three rows (content/message/payload). With limit=100
and sufficient byte/scan capacity, 33 such groups consume 99 business rows; the
34th cannot fit and waits for the next batch. The unchanged key costs zero rows.
The two proof rows are not added by preview; a future writer's planned
proof work must stay within that separately reviewed allowance.

These are application-visible bytes, not a guarantee about SQLite pages,
freelist, WAL, filesystem snapshots, backups, physical disk size or secure erase.
No checkpoint/VACUUM belongs to preview or this logical-byte promise.

### 8.2 Scan ledger (charged before heavy reads)

Start a monotonic timer before entering the target's read snapshot. Include
schema/identity/active/policy checks, base-key probes, lookahead, length projections,
detail reads and hashing in the same ledger. Factory creation does not pre-scan
the database, stash payloads or hide work outside this budget.

Row units are each source-row access deliberately requested by the planner's
bounded statements, including repeated point/projection/detail/BLOB reads of
the same row and each row in schema/PRAGMA results. A missing point lookup costs
one probe unit. A query with multiple source rows must charge each participating
row, not merely one joined output; the specified implementation uses separate indexed
point reads for the descriptor to keep the ledger auditable. One extra
lookahead costs one base row read. Cached immutable history policy/conversation
rows read once within the snapshot need no second SQL read charge; reuse does
not remove per-descriptor framing charges. Do not describe these logical units
as physical page reads or instrumented SQLite VM visits.

For each SQL projection/detail result, charge the full F frame of its ordered
result-column array, including IDs, numbers, nulls and lengths. For raw text/BLOB
material charge its bytes plus its F header on **each actual read**. Hashing a
materialized value again does not constitute a second DB read; additionally
charge the F bytes of each completed message/audit descriptor and range/digest
input once. This deliberately conservative total includes serialized metadata
and framing, not just payload length. No uncharged `SELECT *` or full P1 content
validator may execute as a supposedly constant-time preview check.

Schema, identity, active-state and policy trust metadata obey the same length-first
rule as content. For schema enumeration first obtain at most the exact expected
object count plus one identifiers/types and `length(CAST(sql AS BLOB))`, with
identifier/type lengths bounded before materialization. Reserve byte/frame budget
before retrieving any SQL text; then compare the exact v4 manifest and marker/
checksum. The exact schema-object set is checked, including unexpected objects;
a global SQL-object wildcard or accepting objects merely because their names
match a prefix is not trust. Length-project every variable-width identity,
epoch/run/activation/preparation and policy field before retrieval, including
canonical_json, refs and hashes even when their expected valid sizes are small.
Every probe/retrieval and post-snapshot recheck is charged. Do not call the full
`assertImSchemaV4` content validator as uncharged setup. If schema/identity/active/
policy trust cannot be established or finally rechecked within the budget, fail
MAINTENANCE_READ_UNAVAILABLE (budget failure) without a plan or untrusted IDs;
only exhaustion after established trust may produce an incomplete diagnostic.

Before each SQL call reserve its maximum row units and small fixed projection
frame bound. For variable-width stored TEXT/BLOB first perform an indexed
length-only projection using `length(CAST(textColumn AS BLOB))` and `length(data)`;
NULL is separately projected with `IS NULL`, never coalesced into an empty fact.
Reserve the measured exact material/frame cost before fetching the bytes.
Audit's action is length-projected too, then classified from its actual value.
If the exact remaining scan budget cannot cover a full group including hashes,
stop incomplete without reading its heavy payload and without advancing past it.
Oversized mutation groups may still be fully scanned and held if scan budget
allows. Reserved capacity is not reported as observed cost until consumed;
projection work already done remains charged if a later reservation fails.

Duration observation is `ceil(monotonicNow - start)` in integer milliseconds;
negative/nonfinite/unsafe elapsed is MAINTENANCE_CLOCK_UNSAFE. Check before and
after SQL/hash steps. A call can overrun the soft time cap; after it returns the
plan is incomplete. SQLite calls are not promised interruptible. Rows/bytes
cannot exceed their hard limits via a speculative heavy read. Candidate/range
hashing and serialization time are included; final scalar times/lengths use a
fixed reserved metadata allowance, avoiding a measurement/hash fixed-point loop.

## 9. Scan object, completeness, and output invariants

| Order | Field | Exact type / meaning |
| --- | --- | --- |
| 1 | version | Literal1. |
| 2 | rowsRead | N actual consumed row/probe units. |
| 3 | bytesRead | N actual read/framing bytes as section 8; not logical scrub bytes. |
| 4 | elapsedMs | N final observed monotonic soft duration. |
| 5 | plannedRangeEnd | Key or null, last fully classified interval member. |
| 6 | lastScanned | Key or null; equal to plannedRangeEnd. A partially projected or lookahead row does not advance it. |
| 7 | nextCursor | Cursor or null. Complete and hasMore=true: cursor of lastScanned. Complete and hasMore=false: null. Incomplete with lastScanned nonnull: continuation at that key; incomplete without progress: null. |
| 8 | hasMore | true/false/null; null when bounded lookahead/end-of-source was not established because scan stopped incomplete. |
| 9 | complete | Boolean; true only if every interval member fully classified and the bounded next/end observation finished within scan limits. |
| 10 | stopReason | `END`, `LIMIT`, `ROW_BUDGET`, `BYTE_BUDGET`, `METADATA_LIMIT`, `SCAN_ROWS`, `SCAN_BYTES`, or `SCAN_TIME`. |
| 11 | candidateCount | N equal to candidates.length. |
| 12 | heldCount | N equal to held.length. |
| 13 | skippedCount | N equal to heldCount; skipping means retained, never silently deleted. |
| 14 | held | Array of held entries from section 6, strictly sorted and disjoint from candidates; combined length <=selection.limit. |
| 15 | heldCounts | Object order `{oversizedGroup:N,auditProtected:N,auditActionUnknown:N}`; sum equals heldCount and agrees with held reasons. |
| 16 | rangeDigest | Hash from section 7.3. |

`complete=true` with a nonnull nextCursor is a normal bounded batch, **not**
evidence that the whole eligible population was enumerated. Normal ROW_BUDGET,
BYTE_BUDGET, METADATA_LIMIT or LIMIT stops are complete only after successful
lookahead. SCAN_* stops are always incomplete, hasMore=null, and cannot be applied
even if a prefix contains apparently good candidates. If several limits meet
simultaneously: a detected scan cap takes precedence (rows, bytes, time in that
order); otherwise END if no next row, then LIMIT, ROW_BUDGET, BYTE_BUDGET,
METADATA_LIMIT in that order. A normal stop must have lastScanned nonnull when
hasMore=true; no-progress normal budget stops must instead classify the intrinsic
oversize or fail invalid configuration, preventing a cursor loop.

If scan exhaustion occurs during the lookahead after a full page, the page is
still incomplete. Its prefix is diagnostic only. A continuation can explore the
remaining range, but it cannot authorize the skipped incomplete prefix; to
approve that prefix later, re-preview from its original lower bound with a
smaller requested limit. No held/incomplete prefix is silently asserted applied.

An empty eligible interval with END, empty candidates/held, zero plannedRows/
Bytes and complete=true is valid diagnostic output. An all-held page is also
valid. Neither creates a destructive completion/run proof, nor a no-op writer
permission. Scan checks may themselves exhaust budget before any selection;
then return an incomplete empty prefix only if identity/policy/read trust was
established; otherwise fail safely without IDs.

## 10. Pure codec and local read-only planner APIs

The names in this section are approved new local APIs, not claims of implemented
exports. Their implementation and acceptance evidence remain pending.

### 10.1 Pure codec

`src/im/v2/maintenance-plan.js` has exactly these five exports:

```text
encodeMaintenancePlan(plan) -> Uint8Array
decodeMaintenancePlan(bytes) -> deepFrozenPlan
hashMaintenancePlan(plan) -> Hash
encodeMaintenanceCursor(cursorTuple) -> Cursor
decodeMaintenanceCursor(cursor) -> deepFrozenCursorTuple
```

The encoder accepts ordinary data objects in any insertion order, validates
their exact field set, candidates/held
sorting, arithmetic/count consistency and digest cross-checks. It builds fresh
canonical objects and does not accept caller-provided toJSON methods. The decoder
uses section 2's strict parser and returns an isolated frozen value. A codec can
verify summary/range digest consistency using the hashes in a plan; it cannot
verify original database facts without reading them and cannot issue approvals.
Hashing is pure and deterministic. No codec method calls clock, SQL, filesystem,
registry, auth, random generator, migrations or services. runId generation belongs
only to the planner. No parser accepts a plan as a trusted apply proof.

### 10.2 Factory and methods

```text
createImV2MaintenancePreview({readTarget,authority,policyProvider,clock?})
  -> Object.freeze({previewMaintenance})

previewMaintenance({kind,after?,limit?}, adminContext)
  -> {plan,planHash,complete,nextCursor}
```

Return envelope order is exactly that shown; complete and nextCursor must equal
plan.scan's fields. clock is a trusted construction-time synchronous wall clock,
default Date.now; monotonic timing is internal. Constructor exact keys are the
four shown (clock optional); no limits override, raw DB handle/path, runId,
plan/proof object, now, epoch, target metadata, deletion or apply method.
Request exact keys are kind/after/limit, where absent after means null and absent
limit means20; if present after must be a nonempty Cursor, and limit a P<=100.
Explicit null/undefined fields are rejected rather than treated as omission.
Request data is synchronously snapshotted before invoking any injected callback.

`authority.authorize(adminContext)` must return literal true synchronously.
It runs before entering readTarget, selection, IDs, counts, policy disclosure or
runId generation. Invoke again within the snapshot before returning metadata.
The authority owns authentication and receives the opaque local context; do not
serialize credentials/context into the plan or wrap business auth.withRead.
`policyProvider.getConfig()` synchronously returns a detached full configuration
snapshot in the current v2 shape, including explicit complete retention.policy,
policyHash, maintenance and the configured enabled/writeMode values. Validate
with current config semantics, canonical policy order, effectiveAt>0 and
effectiveAt<=observedWallAt; match the registered current policy's columns and
canonical JSON/hash in the same snapshot. No caller counts or hash-only policy.
Snapshot it immediately and compare a second fresh provider snapshot before
return; change fails POLICY_STALE. Historical content policies are independently
validated by their original rows; never replace deadlines with the current policy.

Canonical full policy field order remains exactly:

```text
{version:2,effectiveAt:Ms,messageRetentionMs:7776000000,
 attachmentRetentionMs:7776000000,safeRetryWindowMs:604800000,
 auditRetentionMs:15552000000,keyReservation:"indefinite",
 expiryEnabled:boolean,purgeEnabled:boolean,backupCleanupEnabled:boolean,
 backupRetentionMs:null|P}
```

All fields must exist; no caller-derived partial defaults. Its hash is the
existing unprefixed SHA-256 of its canonical UTF-8 JSON, not H with a new tag.
The raw canonical_json bytes and structured column values must agree. Config
backupCleanupEnabled requires a configured nonnull TTL under existing parsing,
but even this well-formed config never authorizes the preview-only deletion path.

Known AsyncFunction/async-generator callbacks are rejected **before invocation**
(zero synchronous-prefix execution). A returned Promise/thenable is observed
and rejected; observe native rejection/attach a rejection sink so rejection is
not unhandled. Accessing a throwing then property also rejects. Do not await it
and do not treat eventual true as authorization. Arbitrary malicious synchronous
JavaScript may already have side effects before returning a thenable; these are
trusted pure adapters, not a same-process sandbox. All callbacks are synchronous,
non-reentrant and cannot control the SQLite transaction. Literal true applies
to authorization gates, not to data-producing provider/clock callbacks.

### 10.3 Offline borrowed-connection readTarget

P6-A supports **offline, quiescent, borrowed-connection preview only**. The new
`src/im/v2/maintenance-read-target.js` has these approved APIs:

```text
createImV2MaintenanceReadTarget({db,databasePath}) -> frozen {invalidate}
withMaintenanceReadSnapshot(readTarget,ledger,consume) -> consumeResult
```

The second export is internal trusted composition for the planner, not an
application-facing reader. A private WeakMap authenticates the genuine frozen
facade; copies and duck-typed substitutes fail. The facade has no SQL, DB-handle,
path accessor or read method. Operations accept no paths. The constructor accepts
an exact ordinary options object containing the preowned native DB object and a
nonempty absolute databasePath string, rejects extra/accessor fields and validates
argument forms/brand only. It performs **no DB rows/queries, filesystem reads or
opens, or other factory construction**. Registration of a facade is not a trusted
database binding. Neither this constructor nor the preview factory constructs a
center, auth, clock guard, schema, registry or backup service.

The trusted offline composition owner already owns the connection and protected
location, opened that connection against that path while preventing rename or
replacement, and retains exclusion for the capability lifetime. There are no
other connection users, writes, close/reopen or schema operations during preview.
Call `invalidate()` **before** releasing ownership or closing the DB. Invalidation
is irreversible and revokes any session; the target never closes the borrowed DB.
This preexisting db/path pairing is an explicit trusted offline assumption:
lstat and database_list cannot certify which arbitrary inode an already-open
connection originally opened. No revived live-owner/inode-certification claim is
made. The exclusion cannot be supplied by caller JSON or a permissive verifier.

Only after literal-true admin authorization may first use check the actual native
connection, no external transaction, main filename consistent with databasePath,
and a protected nonsymlink regular single-link file with stable identity before
and after the snapshot. Verify protected ancestors/location using metadata-only
checks. Platform protection unavailable means MAINTENANCE_READ_UNAVAILABLE;
there is no Windows trust override. Verify **quiescent DELETE journaling only**
and absence of every `-wal`, `-shm` and `-journal` residue, even empty. Residue or
an unusable connection is rejected before a read transaction could recover it.
No new read-only SQLite open, module file open, immutable-live trick, query_only
mutation, journal-mode change, chmod, checkpoint or VACUUM is permitted. No raw
open/close of a coordinator inode occurs; metadata inspection is not a file open.

Use BEGIN read snapshot with guaranteed transaction cleanup, never a write
transaction. Apply section 8.2's charged, bounded, length-first checks to the
schema cookie, exact v4 manifest/marker/checksum, actual instance birth/epoch,
im_clock floor, active center/epoch/run/activation/preparation relations and
registered policy. The full `assertImSchemaV4` content validator is not setup.
Only **actual active v4 with config.enabled=true** is eligible. Config and
persisted write modes may each be paused or enabled, but both cases still require
offline writer exclusion. Prepared/verified P5 candidates, schema3, client
journal2 and schema5 are rejected; no migration or activation happens here.

First successful authorized establishment binds the actual connection/file,
instance birth/epoch, schema cookie/manifest/checksum and validated active state.
Failed establishment installs no trusted binding. Subsequent uses recheck those
bindings in and after the snapshot under the retained exclusion; changed target,
cookie, epoch, ownership or invalidation fails closed, with no transparent rebind.
Schema rejection uses MAINTENANCE_SCHEMA_UNSUPPORTED; drift of an established
binding uses MAINTENANCE_TARGET_STALE. Missing native/offline/protection/read
preconditions use MAINTENANCE_READ_UNAVAILABLE. Checks and final rechecks consume
the shared ledger; a trust-gate budget failure yields an error, never metadata
under an unestablished or unrechecked trust assumption.

`consume` receives only a private planner session of fixed allowlisted read
operations and the shared ledger, never caller SQL or a general prepare/exec/DB
handle. Every query is charged. The session expires on scope exit. Reentry,
thenables, invalidation, a session fault caught by consume, or transaction
interference poison the outer operation. Known async callbacks are rejected
before invocation and unexpected thenable rejections are observed. Always release
the read transaction; cleanup failure cannot return success. Reauthorize and
recheck configuration before disclosure. No auth.withRead, clock guard anchor,
runRead/runWriteFresh/refreshCurrent or local time-highwater ratchet is called.

The zero-write promise covers logical DB rows, im_clock/run/schema state,
main/sidecar contents and mtimes, no file creation/deletion/replacement, fsync or
write SQL. It does **not** promise unchanged OS access time (atime). This contract
is not a physical storage/hardware durability guarantee. There is no live-runtime
reader ownership API or execution capability in P6-A; its future implementation
must demonstrate these offline and zero-write requirements before acceptance.

### 10.4 Exact local error set

Errors are local Error objects with a `code` from this table and exactly the
fixed message `Maintenance preview rejected`. No SQL, filesystem absolute path,
raw input, nested cause, payload or provider error text is returned. No wire
error code/HTTP endpoint is added. Error precedence is request shape, admin,
target/schema/active trust, policy/time, cursor scope, then selection/codec.

| Code | Use |
| --- | --- |
| MAINTENANCE_INVALID | Bad options/request/cursor/shape, unknown fields, callback type or returned thenable. |
| MAINTENANCE_AUTH_DENIED | Authority not literal true, throws, or revokes at final check. No selection or ID disclosure. |
| MAINTENANCE_DISABLED | Not an active center, or config.enabled=false. |
| MAINTENANCE_SCHEMA_UNSUPPORTED | Source/schema other than supported4, wrong marker/checksum/structure. No new DDL. |
| MAINTENANCE_TARGET_STALE | Identity/createdAt/epoch/cookie/connection replacement or cursor target mismatch. |
| MAINTENANCE_POLICY_INVALID | Missing/incomplete/noncanonical policy, invalid hash/effectiveAt, unsafe limits or registered-policy mismatch. |
| MAINTENANCE_POLICY_STALE | Policy changed during preview or cursor belongs to an older execution policy. |
| MAINTENANCE_CLOCK_UNSAFE | Unrepresentable/unusable wall, floor or monotonic observation, overflow or cursor cutoff newer than observed wall. Representable missing anchor follows section4 instead. |
| MAINTENANCE_READ_UNAVAILABLE | No genuine offline readTarget/native connection/protection; unsafe snapshot establishment/cleanup, trust-gate budget failure or unexpected SQL/read error. |
| MAINTENANCE_FACT_MISMATCH | Candidate metadata/relationships/hash/payload/integer invariant fails; do not silently skip corruption. |
| MAINTENANCE_CODEC_INVALID | Malformed/duplicate/noncanonical bytes, sort/shape/digest inconsistency, unsupported plan/cursor version. |
| MAINTENANCE_METADATA_LIMIT | Even minimal required metadata/envelope cannot fit or supplied codec input exceeds 65536 bytes. Normal batch truncation uses scan.stopReason instead. |

Scan exhaustion with established trusted context is a diagnostic incomplete
return, not an exception. Missing future anchor is likewise diagnostic. For
ambiguous broken-target cleanup, never return a successful plan claiming zero
writes were proven merely because an exception was caught.

## 11. Configuration-only backup cleanup diagnostic

Backup cleanup is not an im_maintenance_runs kind and does not share a content
plan or readTarget. The exact independent local API is:

```text
createImV2BackupCleanupPreview({authority,policyProvider})
  -> frozen {previewBackupCleanup}
previewBackupCleanup({},ctx)
  -> {version:1,scope:"configuration-only",executable:false,
      configuredBackupRetentionMs:null|positiveSafeInteger,
      backupRetentionMs:null,
      reasons:["BACKUP_TTL_UNCONFIRMED","BACKUP_DELETE_UNAVAILABLE",
               "REGISTRY_ENUMERATION_UNAVAILABLE"],
      protectedRefs:[],complete:false,nextCursor:null}
```

The DTO order is exactly shown. Both factory options are required, with no extra
keys. The request is a strict empty ordinary data object: no registry, cursor,
limit, TTL, folder, path, released marker or proof is accepted. The returned
configuredBackupRetentionMs is exactly the validated trusted full configuration's
retention.policy.backupRetentionMs, either null or a positive safe integer.
It is a configuration observation, **not** an adopted business retention policy.
The approved cleanup TTL remains backupRetentionMs=null/unconfirmed even when
configuredBackupRetentionMs is positive or gates are true. Thirty days remains
unconfirmed; no default number or deletion authority is inferred.

Use the same authority.authorize(ctx), policyProvider.getConfig(), strict full
v2 config/policy/hash validation, synchronous detached snapshots, known-async
zero-prefix rejection, thenable observation, final configuration equality and
literal-true reauthorization before disclosure as section 10.2. This standalone
diagnostic validates configuration only: it has no DB registration/effective-time
comparison, active-target gate or clock sample, and invents none. effectiveAt and
all duration arithmetic must satisfy the existing config parser's constraints.
Missing complete retention policy/hash is MAINTENANCE_POLICY_INVALID; a final
snapshot change is MAINTENANCE_POLICY_STALE. Provider exception text is never
returned. Data and the returned exact <=65536-byte DTO are detached/deep-frozen.
This can be implemented after common pure validation, independently of readTarget.

There is zero registry/folder enumeration, lock acquisition, store construction,
filesystem access or DB access. No backup count, newest-backup status or actual
protection conclusion is made. Empty protectedRefs means **not enumerated**, not
that no backups are protected. The three reasons, complete=false and nextCursor=null
are unconditional; no enumeration precursor or cursor is part of this API.
Existing registry and checkCleanup remain unchanged and allowed:false. A released
marker alone is never terminal/deletion authority. Genuine registry enumeration,
deletion, and status after a source is gone require separate future gates; this
configuration-only diagnostic defines no archived-source semantics or adapter.

## 12. Canonical vector outline and minimum implementation evidence

The codec owner must freeze literal byte/hex/hash vectors for this approved design
in new maintenance fixtures, with a second independent oracle calculation. Do
not regenerate or modify v4 schema goldens to make a new vector pass. The vector
format should record `name,tag,inputBytesHex,expectedSha256` in that order for
hash primitives, and literal canonical UTF-8 text plus expected plan/cursor bytes
and hashes for full DTOs. A producer roundtrip alone is insufficient evidence.

Required exact frame anchors:

```text
F(null)          = 6e3b
F("")            = 73303a
F(empty BLOB)    = 78303a              # framing test only, not a valid attachment
F(0)            = 69303b
F(-1)           = 692d313b
F([null,"",0])   = 61333a6e3b73303a69303b
F("é")          = 73323ac3a9          # two UTF-8 bytes, one scalar
```

For a primitive hash vector use bytes `6e3b` under tag
`a2a-msg.im.maintenance.text.v1`: SHA input is the ASCII tag, then byte00,
then bytes6e3b. This is a domain/framing test, not T(null), which is literal null.
Full fixtures use all-zero-shaped canonical UUID strings with distinct final
digits, fixed safe timestamps, and policy bytes with their **actually computed**
existing policy hash. No placeholders are accepted by a decoder. Include an
empty v4 END plan, one expire-only group, one already-expired attachment scrub group,
one scrub group retaining imported-v1 source fingerprint, tied-time content
keys, audit negative/zero/positive IDs, and mixed candidate/held pages. All
literal expected SHA-256 outputs remain an implementation-oracle deliverable;
this document does not assert uncomputed hash values as test evidence.

| Area | Minimum future checks and decisive assertions |
| --- | --- |
| Pure codec | Object encoder accepts any insertion order and emits canonical order; byte decoder rejects key permutations. Unknown/missing/duplicate/escaped-alias keys, candidate/held sorting, duplicate IDs; unsafe integer, -0, signed audit ID, BOM/trailing newline, invalid UTF-8, lone surrogate, sparse/accessor/toJSON/cycle input; 65536-byte exact edge and over; deep-frozen decoded trees and defensive byte copies. |
| Hash binding | Alter every descriptor column individually, including same-length body/BLOB and ACK/read/null-to-empty; fingerprint changes or validation rejects. Same counts/different rows do not match. v1 source fingerprint preserved; post-scrub never reconstructed. Plan timing change changes planHash but not candidateDigest. Distinct tags yield distinct hash inputs. |
| Cursor/selection | Full composite seeks with equal times; first page/fixed-cutoff continuation; instance birth/epoch/policy/kind/sort mismatch; cursor not authority. Audit before day180 selects none, equality selects; content equality eligible; TTL equality expired and safe-add overflow rejected. Indexed EXPLAIN evidence for the three predicates. |
| Range drift | Insert/delete/reorder/change inside interval rejects; moved-out original member rejects; outside-range rows on a hasMore page never get included. Exhausted suffix gains row -> stale. Lookahead is charged and never approved; incomplete prefix cannot be applied. |
| Groups/budgets | Kind fixes effect regardless of purge gate; scrub only already-expired content. 33 three-row scrub groups with already-expired keys cost99, next three-row group waits; no phantom key update. Typed UTF-8/BLOB/framing costs and no-op suppression; oversized10MiB+name held whole; held-only and unknown-audit pages advance with digested outcomes. No partial payload clear or later-group packing. |
| Read accounting | Length-first schema/identity/active/policy metadata, including oversized SQL/JSON/refs; trust-gate budget exhaustion errors without plan/IDs. All probes/detail/BLOB reads/rechecks charged; one BLOB resident; no hidden full validator/count/hash. Slow single SQL may exceed soft time, then error if trust unresolved, otherwise incomplete. Normal batch stop complete=true with nextCursor; selection scan exhaustion complete=false. |
| Time evidence | Exact v4 null fields/false/upgrade reason; malformed sample error; future v5 missing head/session diagnostics and precedence; historical JSON and forged true metadata cannot mint a private capability. No automatic migration/reanchor. |
| Admin/policy | Literal true before target/IDs; denied/throw/truthy/known async zero-prefix; thenable rejected and rejection observed; callback mutation cannot alter captured request; full canonical policy/gates/effectiveAt checked, provider drift detected. |
| Target trust | Constructor form/brand only and no pre-admin rows/FS inspection; actual active v4 paused/enabled accepted only offline with enabled config. Fake/invalidated/changed file/connection/instance birth/epoch/cookie/manifest fail; failed establishment installs no binding. DELETE-only; any sidecar residue evenempty rejects; unsupported protection fails with no Windows override. No borrow close; invalidation before owner release; expired session/reentry/thenable/caught session fault poison outer; cleanup failure no success. |
| Zero-write contract | Factory, denied, success, empty, budget-incomplete and error paths: logical DB/im_clock/schema/im_maintenance_runs unchanged; main and any preexisting rejected residue bytes/mtimes unchanged, no file creation/deletion/replacement/fsync/write SQL or guard/auth anchor. No module file open/new SQLite open/query_only/journal-mode change. Offline exclusion is mandatory; deliberate ownership violation rejects, not a supported live-write mode. OS atime equality is not promised. |
| Version dispatch | Supported source exactly schema4 for first planner; v1/v2/v3/v5/unknown rejected with no new DDL. Pure codec v5-shaped fixture support does not extend runtime dispatch or change v4 golden. |
| Backup preview | Strict empty input; exact ordered configuration-only DTO/reasons; null/positive configured TTL accurately observed while approved TTL staysnull/executablefalse. Admin/config final checks, async/thenable/exception denial. Zero registry/folder/lock/store/DB/clock access, no enumeration/protection claims; emptyrefs meansnotenumerated. |

No DB, service, implementation test, or production operation was run to author
this document. Verification for this lane is document UTF-8/no-BOM, relative
links to committed files, whitespace and field/SQL/source consistency only.

## 13. Approved P6-A closure and future execution gates

**P6-A design APPROVED with the incorporated Oracle amendments; READY PURECODEC.**
The 16 plan fields, nested tables, signed audit IDs, typed F/T hashes, fixed
selection ranges and held outcomes, scan/mutation accounting, encoder/decoder
distinction, offline borrowed-target APIs and configuration-only backup DTO are
closed design decisions. There is no remaining design blocker to the five-export
pure codec. Literal independently checked vectors and all implementation/runtime
acceptance evidence remain to be produced; none is claimed by these documents.

Dispatch pure codec first. The planner must then implement the approved offline
ownership/length-first/trust/session/zero-write contract; configuration-only backup
diagnostic can follow common pure validation independently. Every successful v4
preview has null anchor/session fields, executable=false and
SCHEMA_UPGRADE_REQUIRED even with gates true. No apply/status stubs are part of A.

Future schema5 exact DDL/manifest/golden and converter proof/API, runtime dispatch,
versioned backup/registry/recovery field tables and compatibility evidence, private
time-approval/session adapters, batch approval/execution/completion/status formats
and process-fault evidence remain their explicit gates in the
[schema5 contract](im-v2-maintenance-schema-v5-contract.md). P6-A approval does not
freeze those still-unspecified formats or authorize a converter rollout/writer.
Pure future-v5 DTO validation grants neither schema5 source support nor a private
session. H1/H2/H3, production migration/enablement/deletion approvals, unconfirmed
backup TTL (including 30 days), and physical-vs-logical/no-hardware guarantees
remain unchanged. No execution or runtime PASS is asserted.
