# C2-B2 literal recovery-v5 state manifest (NONRELEASE)

**ACCEPTED DOCUMENT ARTIFACT after independent joint review (2026-09-28).
Static source transcription only; no SQLite runtime observation or runtime
validation. Whole C2 remains IN_PROGRESS; codec lanes and S3/H4 NOT READY.**

Checked HEAD: `f1b2bd781ce343e9a41b676eac26a995a3e61b59` (2026-09-28).
This document supplies the literal schema inventory requested by the accepted
[central phase protocol](im-v2-recovery-v5-phase-contract.md), especially §5 and
its remaining artifact gates. Independent joint document/manifest review passed:
32 tables, 237 columns, 26 explicit and 42 automatic indexes (100 objects),
with nine source anchors/checksum fixtures checked statically; no product runtime
or SQLite observation is inferred.
The phase contract, ledger, accepted C2-A/B1, source and fixtures are unchanged.
Digest byte grammar is owned by a separate read-only oracle: this artifact makes
**no new framing, record API, codec export or digest-encoding decision**.

## 1. Authorities, extraction method and pinned provenance

Source abbreviations in the tables below refer to these committed files/lines:

| Label | Source authority |
| --- | --- |
| H | [schema-history.js](../src/im/v2/schema-history.js): helper constraints lines 3-9; inherited tables 13-29; indexes 31-38; identity 49; V3 marker/index/assembly 56-63 |
| F | [schema-internal.js](../src/im/v2/schema-internal.js): V4 helper constraints 7-23; marker 24; 11 tables 25-37; 18 indexes 38-40; assembly/manifest/checksum 41-45 |
| V | [schema-v5-internal.js](../src/im/v2/schema-v5-internal.js): V5 helpers 8-15; marker 17; three tables 18-52; index 53; assembly/manifest/checksum 54-61; autoindex derivation 62-69 |
| M | [maintenance-time-internal.js](../src/im/v2/maintenance-time-internal.js): AUTOMATIC/OBJECTS 57-63; whole-database manifest checks 333-355 |
| C | [recovery-candidate.js](../src/im/v2/recovery-candidate.js): historical transforms 520-573; old logical digest 105-156 |

Full table SQL is authoritative in those source lines, with helper interpolation;
every ordered column and object name/owner is nevertheless expanded literally in
this document. No table is represented only as “same as v4.” Constraint summaries
below do not replace full CHECK text, nor relax exact manifest comparison.

Static extraction evaluated only inspected, bounded DDL-construction prefixes in
an isolated Node `vm` context with built-in crypto and the already-extracted prior
DDL arrays. Imports/exports were removed; extraction stopped before validator/
operational functions. No product module import, DatabaseSync, SQLite invocation,
test runner or runtime probe was used. A quote/parenthesis-aware text split separated
column clauses from table constraints. Static self-checks compare these literal
columns, object unions and counts back to the expanded source strings.

### 1.1 SHA-256 of checked source/fixture files

These are file-byte hashes, not schema checksums or state digests.

| Path | SHA-256 |
| --- | --- |
| `src/im/v2/schema-history.js` | `2d78272771b86c9cc76ad93240d128e67e57f46210e603c52eb3403346deac62` |
| `src/im/v2/schema-internal.js` | `d9ce1ff3dca31e099c763b9661659d834290335979e178e2c74198dbc7c09e92` |
| `src/im/v2/schema-v5-internal.js` | `e61bc17e9b782bf539837d68b37e26ad05f830c7b09e25de4172071ba645b93f` |
| `src/im/v2/maintenance-time-internal.js` | `605e1f74191160b708514f0212b9674637c78d7069e4bb6c7bcd4992ed5956f9` |
| `tests/fixtures/im-v2-schema-v5/v5-manifest.json` | `fdecf6193964d8f6551c46423a70495a489a01ffd42e0092e4b432170026384d` |
| `tests/fixtures/im-v2-schema-v5/v5-additive-ddl.json` | `6a395466521cea3509063f5e68a7ae49dc0f3dcd7d35f9113ee3ca548ed2de33` |
| `tests/fixtures/im-v2-schema-v5/checksums.json` | `da71c803405cafe9e70bbcaafcac8bb2cd6abf855b92fab4de89a7dcaaff99fa` |
| `tests/fixtures/im-v2-schema/v4-manifest.json` | `5a422c3673e2ebdd2a00386ba27d153a1ca9c5f0e659088f89c235703c05abdc` |
| `docs/im-v2-recovery-v5-phase-contract.md` | `5fdbacbdca400493c987daf67f20506a892a885f826e55acf3c81050394e4436` |

Existing fixture authorities:
[v5-manifest.json](../tests/fixtures/im-v2-schema-v5/v5-manifest.json),
[v5-additive-ddl.json](../tests/fixtures/im-v2-schema-v5/v5-additive-ddl.json),
[checksums.json](../tests/fixtures/im-v2-schema-v5/checksums.json), and
[v4-manifest.json](../tests/fixtures/im-v2-schema/v4-manifest.json).
The corresponding assertions are in
[im-v2-schema-v5.test.js](../tests/im-v2-schema-v5.test.js) lines 65-80. Reading and
statically comparing these literals is not running those tests or revalidating
their historical execution results.

### 1.2 Checksums, normalization and stored SQL are distinct

| Static representation | SHA-256 |
| --- | --- |
| V3 normalized explicit manifest checksum | `523f5b8448226076dc78f32096888871d899150d4cb70d6728490aee033f9814` |
| V4 normalized explicit manifest checksum | `c950eb40692a72f918c8976d4bef8cab0b9e357495b01df75e0ab2d1b0b5f216` |
| V5 normalized explicit manifest checksum | `80eba5e6ce61261d31ec495216c3b6eb8c7a8f0c87edcbb1440372353f495435` |
| V5 full ordered `V5_DDL.join('\n')` bytes | `ba794191aac30e3cfeca1a14fbbd4e0ae8b48fd076c735310fe6b313517b6606` |
| V5 marker + three added tables + added index, joined by newline | `a3e6b496ffcdc1d5863bacf56af261ec53c2892de44199b796f71a6abdf4a552` |

The source checksum hashes JSON of `[type,name,tbl_name,normalizedSQL]` rows,
using `trim().replace(/\s+/g,' ')` and source `localeCompare` name ordering.
Only 58 explicit V5 objects participate; automatic indexes with SQL null are
excluded. Original constructed DDL can have double spaces from empty helper
extras, which normalized manifest SQL intentionally collapses. Byte hashes above
distinguish those representations.

Actual stored `sqlite_schema.sql`, normalized manifest SQL, and proposed state
digest bytes are separate concepts. This artifact does not select one as the new
digest preimage, normalize observed SQL on behalf of the oracle, or encode null SQL
as empty text. Binary name order below is inventory presentation/phase intent,
not a change to historical checksum sorting. No stored-SQL bytes were observed.

## 2. Complete inheritance comparison and counts

| Version | Tables | Explicit named indexes | Explicit manifest objects | Derived automatic indexes | Global object total |
| --- | ---: | ---: | ---: | ---: | ---: |
| V3 | 18 | 7 | 25 | 18 | 43 |
| V4 | 29 | 25 | 54 | 36 | 90 |
| V5 | 32 | 26 | 58 | 42 | 100 |

These are source-DDL derivations, not SQLite observations. V5 has **237 declared
columns** across its 32 tables. The global allowlist is exactly the disjoint union
of the 32 literal table names in §3, 26 named indexes in §4, and 42 automatic
indexes in §5. No omitted “other objects” category exists.

V3's complete table set, retained in V4/V5 except for marker definition replacement:

```text
im_agents
im_attachments
im_audit
im_clock
im_contacts
im_conversations
im_credentials
im_deliveries
im_instance_identity
im_lease_requests
im_legacy_bindings
im_messages
im_migration_runs
im_receive_state
im_receiver_leases
im_schema
im_send_keys
im_settings
```

V4 adds exactly these 11 tables (all retained byte-for-byte in V5):

```text
im_attachment_reservations
im_center_epochs
im_center_state
im_content_state
im_expiry_receipts
im_maintenance_runs
im_recovery_runs
im_retention_policies
im_schema_preparations
im_send_operation_keys
im_sync_progress
```

V5 adds exactly these three tables:

```text
im_center_schema_transitions
im_maintenance_time_anchors
im_maintenance_time_head
```

Each version replaces only the marker definition, with actual source SQL:

```sql
CREATE TABLE im_schema (version INTEGER NOT NULL PRIMARY KEY CHECK(version = 3), migration_checksum TEXT NOT NULL CHECK(length(migration_checksum) = 64))
CREATE TABLE im_schema (version INTEGER NOT NULL PRIMARY KEY CHECK(version=4), migration_checksum TEXT NOT NULL CHECK(length(migration_checksum)=64))
CREATE TABLE im_schema (version INTEGER NOT NULL PRIMARY KEY CHECK(version=5), migration_checksum TEXT NOT NULL CHECK(length(migration_checksum)=64))
```

F:41 assembles `[V4_SCHEMA,...V3_DDL.slice(1),...V4_TABLES,...V4_INDEXES]`;
V:54 analogously retains `V4_DDL.slice(1)` plus V5 additions. The 7 V3 indexes
remain; 18 V4 and 1 V5 index additions are labeled in §4. All original 3/4 digest
algorithms stay unchanged; this is not a new implementation of them.

## 3. All 32 V5 tables, ordered columns and constraints

Tables are in binary ASCII-name order. Each subsection is one explicit object of
type `table`; its owner/tbl_name equals the literal table name in the heading.
Column rows are in exact DDL order; names and declared types are literal.

`NN` means an explicit `NOT NULL` clause. `ND` means **no explicit NOT NULL in
the DDL**; it does not assert that every null value is semantically admissible.
`none` means no DEFAULT clause (omission normally supplies SQL NULL, subject to
constraints). Listed defaults are actual SQL literals. Primary key, UNIQUE, FK,
CHECK and business validation must be considered separately. In particular,
legacy TEXT PRIMARY KEY does not imply a declared NN clause; INTEGER PRIMARY KEY
aliases rowid even when marked ND. No declared type is REAL; actual SQLite storage
classes are a separate observation, not inferred from declared affinity alone.

Constraint shorthand used only in prose: legacy `id` checks length1..255 without
an explicit typeof; legacy `time` permits null or integer0..9007199254740991;
legacy JSON checks length2..65536 and json_valid. F/V helpers additionally check
typeof text/integer explicitly, use lowercase UUID/hex forms, and allow null only
when their nullable flag is set. Full helper SQL remains H:3-9, F:7-23, V:8-15.
FKs below are declared without DEFERRABLE or ON DELETE/UPDATE actions; do not
invent deferred or cascading behavior.

### 3.1 im_agents

Authority H:14; PK(agent_id), hidden rowid. agent_id uses legacy id; display_name
length1..255; status active/disabled; created_at/revoked_at legacy time.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| agent_id | TEXT | ND | none |
| display_name | TEXT | NN | none |
| status | TEXT | NN | none |
| created_at | INTEGER | NN | none |
| revoked_at | INTEGER | ND | none |

### 3.2 im_attachment_reservations

Authority F:32; PK(attachment_id); UNIQUE(message_id); message_id FK to
im_messages(message_id). Both IDs F-id; size integer1..10485760; sha256 F-hash.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| attachment_id | TEXT | NN | none |
| message_id | TEXT | NN | none |
| size | INTEGER | NN | none |
| sha256 | TEXT | NN | none |

### 3.3 im_attachments

Authority H:19; PK(attachment_id); UNIQUE(message_id), FK to im_messages.
attachment_id legacy id; name length1..255; mime null or <=255 chars;
size integer1..10485760; sha256 64 lowercase hex; data typeof blob and length=size.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| attachment_id | TEXT | ND | none |
| message_id | TEXT | NN | none |
| name | TEXT | NN | none |
| mime | TEXT | ND | none |
| size | INTEGER | NN | none |
| sha256 | TEXT | NN | none |
| data | BLOB | NN | none |

### 3.4 im_audit

Authority H:25; id INTEGER PRIMARY KEY is the rowid alias, **ND in DDL**.
No FK. actor_kind admin/agent/system; actor_id legacy id; action length1..128;
both JSON columns legacy JSON; occurred_at legacy time. No id default clause
or AUTOINCREMENT. Null/omitted id allocation behavior is not a nullable stored rowid.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| id | INTEGER | ND | none |
| actor_kind | TEXT | NN | none |
| actor_id | TEXT | NN | none |
| action | TEXT | NN | none |
| target_ids_json | TEXT | NN | none |
| occurred_at | INTEGER | NN | none |
| safe_details_json | TEXT | NN | none |

### 3.5 im_center_epochs

Authority F:26; TEXT PK(center_epoch), hidden rowid; no FK. center_epoch F-UUID;
created_at/recovery_counter F-nonnegative safe integer; origin fresh/v3_import/recovery.
No default values; inserting a snapshot epoch requires all four named values.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| center_epoch | TEXT | NN | none |
| created_at | INTEGER | NN | none |
| origin | TEXT | NN | none |
| recovery_counter | INTEGER | NN | none |

### 3.6 im_center_schema_transitions

Authority V:38-51; PK(transition_id); UNIQUE(approved_plan_hash). FKs:
center_epoch -> im_center_epochs(center_epoch), preparation_ref ->
im_schema_preparations(preparation_ref), execution_policy_hash ->
im_retention_policies(policy_hash). **recovery_run_id is not an FK**: conversion
precedes this recovery run's prepare insertion. Version bounds exactly4 and5;
UUID/hash/ref/time helper checks apply. The schema checks hash shape, while actual
validator binds exact from/to checksums and transition facts.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| transition_id | TEXT | NN | none |
| from_version | INTEGER | NN | none |
| to_version | INTEGER | NN | none |
| instance_id | TEXT | NN | none |
| instance_created_at | INTEGER | NN | none |
| center_epoch | TEXT | NN | none |
| from_checksum | TEXT | NN | none |
| to_checksum | TEXT | NN | none |
| recovery_run_id | TEXT | NN | none |
| stage_hash | TEXT | NN | none |
| candidate_reference | TEXT | NN | none |
| candidate_kind | TEXT | NN | none |
| preparation_ref | TEXT | ND | none |
| source_evidence_hash | TEXT | ND | none |
| preconversion_file_hash | TEXT | NN | none |
| execution_policy_hash | TEXT | NN | none |
| plan_created_at | INTEGER | NN | none |
| plan_expires_at | INTEGER | NN | none |
| approver_id | TEXT | NN | none |
| approved_plan_hash | TEXT | NN | none |
| approval_ref | TEXT | NN | none |
| executor_id | TEXT | NN | none |
| converted_at | INTEGER | NN | none |

CHECKs: kind fresh_bootstrap/v3_import/snapshot_recovery. Fresh requires prep and
null source hash; import requires both; snapshot requires null prep/non-null source
hash. candidate_reference exactly `runs/` + recovery_run_id + `/candidate.sqlite`.
Plan expiry > creation and difference <=300000; converted_at in [creation,expiry);
executor_id differs from approver_id. Single-transition cardinality is validator
behavior, not a UNIQUE constant/version clause in this table.

### 3.7 im_center_state

Authority F:27; singleton INTEGER NN PRIMARY KEY, CHECK=1, rowid alias.
UNIQUE(center_epoch) FK to im_center_epochs; recovery_run_id FK to im_recovery_runs.
Status prepared/verified/active; active iff activation_ref nonnull; non-active
activation_ref null. Status other than prepared requires recovery_run_id nonnull.
Epoch UUID; refs F-id; counter/update F-N. No defaults.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| singleton | INTEGER | NN | none |
| center_epoch | TEXT | NN | none |
| recovery_counter | INTEGER | NN | none |
| status | TEXT | NN | none |
| activation_ref | TEXT | ND | none |
| recovery_run_id | TEXT | ND | none |
| updated_at | INTEGER | NN | none |

### 3.8 im_clock

Authority H:29; singleton INTEGER PRIMARY KEY CHECK=1, rowid alias with ND DDL.
last_observed_at legacy time, explicitly NN and DEFAULT0. No FK or extra UNIQUE.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| singleton | INTEGER | ND | none |
| last_observed_at | INTEGER | NN | 0 |

### 3.9 im_contacts

Authority H:16; composite PK(agent_low,agent_high), hidden rowid; both FKs to
im_agents(agent_id). CHECK agent_low<agent_high, allowed in0/1, version>=1 plus
legacy time check, updated_at legacy time.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| agent_low | TEXT | NN | none |
| agent_high | TEXT | NN | none |
| allowed | INTEGER | NN | none |
| version | INTEGER | NN | none |
| updated_at | INTEGER | NN | none |

### 3.10 im_content_state

Authority F:31; PK(message_id), FK to im_messages; policy_hash FK to
im_retention_policies; expiry_run_id/scrub_run_id FKs to im_maintenance_runs.
state live/expired. Live has all four expiry/scrub time/run fields null. Expired
requires expired_at/expiry_run_id and expired_at>=expires_at; scrub pair either
both null or both nonnull with scrubbed_at>=expired_at. F-id/hash/time checks.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| message_id | TEXT | NN | none |
| state | TEXT | NN | none |
| expires_at | INTEGER | NN | none |
| expired_at | INTEGER | ND | none |
| scrubbed_at | INTEGER | ND | none |
| policy_hash | TEXT | NN | none |
| expiry_run_id | TEXT | ND | none |
| scrub_run_id | TEXT | ND | none |

### 3.11 im_conversations

Authority H:17; PK(conversation_id), legacy id; UNIQUE(agent_low,agent_high),
both FKs to im_agents; CHECK agent_low<agent_high; created_at legacy time.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| conversation_id | TEXT | ND | none |
| agent_low | TEXT | NN | none |
| agent_high | TEXT | NN | none |
| created_at | INTEGER | NN | none |

### 3.12 im_credentials

Authority H:15; PK(credential_id), legacy id; agent_id FK to im_agents with
legacy id check; secret_hash length1..512; created/expires/revoked legacy time.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| credential_id | TEXT | ND | none |
| agent_id | TEXT | NN | none |
| secret_hash | TEXT | NN | none |
| created_at | INTEGER | NN | none |
| expires_at | INTEGER | ND | none |
| revoked_at | INTEGER | ND | none |

### 3.13 im_deliveries

Authority H:22; composite PK(recipient_id,seq); UNIQUE(message_id); FKs recipient
to im_agents and message to im_messages. seq legacy time and >=1; acked_at/read_at
legacy time; read_at nonnull requires acked_at nonnull. Hidden rowid retained.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| recipient_id | TEXT | NN | none |
| seq | INTEGER | NN | none |
| message_id | TEXT | NN | none |
| acked_at | INTEGER | ND | none |
| read_at | INTEGER | ND | none |

### 3.14 im_expiry_receipts

Authority F:35; PK(recipient_id,center_epoch,stream_epoch,seq);
UNIQUE(recipient_id,center_epoch,stream_epoch,message_id). FKs: message_id to
im_messages; (recipient_id,center_epoch,stream_epoch) to im_sync_progress;
(recipient_id,seq) to im_deliveries. Recipient/message F-id, epoch/stream UUID,
seq positive safe integer, recorded_at nonnegative safe integer. Hidden rowid.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| recipient_id | TEXT | NN | none |
| center_epoch | TEXT | NN | none |
| stream_epoch | TEXT | NN | none |
| seq | INTEGER | NN | none |
| message_id | TEXT | NN | none |
| recorded_at | INTEGER | NN | none |

### 3.15 im_instance_identity

Authority H:49; singleton INTEGER PRIMARY KEY CHECK=1, rowid alias ND. instance_id
uses strict identity UUID helper; created_at legacy time. No UNIQUE(instance_id)
or FK is declared; singleton/identity validator adds actual cardinality checks.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| singleton | INTEGER | ND | none |
| instance_id | TEXT | NN | none |
| created_at | INTEGER | NN | none |

### 3.16 im_lease_requests

Authority H:24; PK(agent_id,request_id); agent_id FK to im_agents. request_id
legacy id; request_hash lowercase64 hex; instance_id legacy UUID; generation
legacy time >=1; result_json legacy JSON. Hidden rowid; no generation UNIQUE.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| agent_id | TEXT | NN | none |
| request_id | TEXT | NN | none |
| request_hash | TEXT | NN | none |
| instance_id | TEXT | NN | none |
| generation | INTEGER | NN | none |
| result_json | TEXT | NN | none |

### 3.17 im_legacy_bindings

Authority H:26; **no declared PK**, hidden rowid; UNIQUE(legacy_member) and
UNIQUE(agent_id). agent_id FK to im_agents; migration_run_id FK to
im_migration_runs. legacy_member/approval_ref legacy id; status active/revoked;
source DEFAULT 'legacy_ip' and CHECK source='legacy_ip'.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| legacy_member | TEXT | NN | none |
| agent_id | TEXT | NN | none |
| approval_ref | TEXT | NN | none |
| migration_run_id | TEXT | NN | none |
| status | TEXT | NN | none |
| source | TEXT | NN | 'legacy_ip' |

### 3.18 im_maintenance_runs

Authority F:36; PK(run_id), UNIQUE(plan_hash); center_epoch FK to im_center_epochs,
execution_policy_hash FK to im_retention_policies. kind expire/scrub/audit;
status previewed/approved/completed/rejected. expires_at>=previewed_at; completed
iff completed_at nonnull; approved/completed requires approval_ref and
approved_batch_hash. F-ref/hash/UUID/JSON/nonnegative integer helpers apply;
no defaults, hidden rowid.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| run_id | TEXT | NN | none |
| center_epoch | TEXT | NN | none |
| kind | TEXT | NN | none |
| execution_policy_hash | TEXT | NN | none |
| plan_hash | TEXT | NN | none |
| approved_batch_hash | TEXT | ND | none |
| approval_ref | TEXT | ND | none |
| executor_id | TEXT | NN | none |
| status | TEXT | NN | none |
| candidate_json | TEXT | NN | none |
| result_json | TEXT | NN | none |
| previewed_at | INTEGER | NN | none |
| expires_at | INTEGER | NN | none |
| completed_at | INTEGER | ND | none |
| scan_rows | INTEGER | NN | none |
| scan_bytes | INTEGER | NN | none |
| changed_rows | INTEGER | NN | none |
| changed_bytes | INTEGER | NN | none |

### 3.19 im_maintenance_time_anchors

Authority V:19-32; generation INTEGER NN PRIMARY KEY (positive safe integer),
rowid alias. center_epoch FK to im_center_epochs; previous_generation FK to this
table(generation). UNIQUE(proposal_hash), UNIQUE(anchor_hash), UNIQUE(session_nonce),
UNIQUE(center_epoch,generation,anchor_hash). Four automatic indexes, not five.
UUID/hash/ref helpers apply; time integers nonnegative safe; max_forward_jump_ms
integer1..86400000; previous_generation positive when nonnull.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| generation | INTEGER | NN | none |
| center_epoch | TEXT | NN | none |
| previous_generation | INTEGER | ND | none |
| previous_anchor_hash | TEXT | ND | none |
| proposal_hash | TEXT | NN | none |
| anchor_hash | TEXT | NN | none |
| session_nonce | TEXT | NN | none |
| proposed_at | INTEGER | NN | none |
| proposal_expires_at | INTEGER | NN | none |
| candidate_wall_at | INTEGER | NN | none |
| accept_not_before | INTEGER | NN | none |
| accept_not_after | INTEGER | NN | none |
| accepted_wall_at | INTEGER | NN | none |
| global_floor_observed_at | INTEGER | NN | none |
| global_floor_at_approval | INTEGER | NN | none |
| max_forward_jump_ms | INTEGER | NN | none |
| approval_ref | TEXT | NN | none |
| executor_id | TEXT | NN | none |
| approver_id | TEXT | NN | none |

Previous generation/hash both null or both nonnull with previous_generation<generation.
proposed_at=candidate_wall_at=accept_not_before. Proposal TTL positive <=300000;
accept_not_after>accept_not_before with difference<=5000. accepted_wall_at in
inclusive acceptance interval, strictly before proposal expiry. Approval floor
>= observed floor, accepted_wall_at>=approval floor; executor differs from approver.
These are existing maintenance-anchor constraints: the 5000 bound is **not** a new
recovery-phase reservation window. Recovery preserves history/generation.

### 3.20 im_maintenance_time_head

Authority V:33-37; singleton INTEGER NN PRIMARY KEY, integer exactly1, rowid alias.
center_epoch FK to im_center_epochs; composite FK(center_epoch,generation,anchor_hash)
to anchors' matching UNIQUE key. generation positive safe; epoch UUID/hash checks.
No additional UNIQUE/automatic index or defaults. DELETE HEAD ONLY does not delete
anchors and does not require a generated new head or session.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| singleton | INTEGER | NN | none |
| center_epoch | TEXT | NN | none |
| generation | INTEGER | NN | none |
| anchor_hash | TEXT | NN | none |

### 3.21 im_messages

Authority H:18; PK(message_id), legacy id; FKs conversation to im_conversations,
sender/recipient to im_agents, in_reply_to self-reference. client_message_id legacy
id; title null or <=512; text length<=1048576; correlation null or <=255;
accepted_at legacy time; sender<>recipient. No sender/client UNIQUE in this table.
Business validator imposes narrower UUID/content constraints separately.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| message_id | TEXT | ND | none |
| conversation_id | TEXT | NN | none |
| sender_id | TEXT | NN | none |
| recipient_id | TEXT | NN | none |
| client_message_id | TEXT | NN | none |
| title | TEXT | ND | none |
| text | TEXT | NN | none |
| in_reply_to | TEXT | ND | none |
| correlation | TEXT | ND | none |
| accepted_at | INTEGER | NN | none |

### 3.22 im_migration_runs

Authority H:27; PK(run_id), legacy id; no FK. preview_hash lowercase64 hex;
status previewed/approved/completed/failed; actor_id legacy id;
created_at/completed_at legacy time. No default or extra UNIQUE.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| run_id | TEXT | ND | none |
| preview_hash | TEXT | NN | none |
| status | TEXT | NN | none |
| actor_id | TEXT | NN | none |
| created_at | INTEGER | NN | none |
| completed_at | INTEGER | ND | none |

### 3.23 im_receive_state

Authority H:21; PK(agent_id), FK to im_agents, **ND**; hidden rowid. stream_epoch
legacy UUID. next_seq>=1, retained_floor>=1, all three counters legacy time;
acked_through<next_seq and retained_floor<=next_seq. Actual defaults1/0/1 below.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| agent_id | TEXT | ND | none |
| next_seq | INTEGER | NN | 1 |
| acked_through | INTEGER | NN | 0 |
| retained_floor | INTEGER | NN | 1 |
| stream_epoch | TEXT | NN | none |

### 3.24 im_receiver_leases

Authority H:23; PK(agent_id), FK to im_agents, ND; credential_id FK to
im_credentials. instance_id legacy UUID; generation legacy time>=1; expires_at
legacy time. No default, no explicit rowid alias. Credential/agent agreement is
checked by business validator, not a composite FK here. Recovery deletes leases,
not im_lease_requests history.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| agent_id | TEXT | ND | none |
| instance_id | TEXT | NN | none |
| generation | INTEGER | NN | none |
| expires_at | INTEGER | NN | none |
| credential_id | TEXT | NN | none |

### 3.25 im_recovery_runs

Authority F:29; PK(run_id); UNIQUE(new_epoch). preparation_ref FK to
im_schema_preparations; old_epoch/new_epoch FKs to im_center_epochs. No FK to an
external backup registry; backup tuple is correlated evidence, not local backup
tables. F-id/UUID/hash/JSON/N helper checks; no DEFAULT clauses, hidden rowid.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| run_id | TEXT | NN | none |
| candidate_kind | TEXT | NN | none |
| preparation_ref | TEXT | ND | none |
| backup_id | TEXT | ND | none |
| backup_file_hash | TEXT | ND | none |
| manifest_hash | TEXT | ND | none |
| candidate_base_hash | TEXT | ND | none |
| candidate_reference | TEXT | NN | none |
| old_epoch | TEXT | ND | none |
| new_epoch | TEXT | NN | none |
| approved_plan_hash | TEXT | NN | none |
| approval_ref | TEXT | NN | none |
| isolation_ack_ref | TEXT | ND | none |
| rpo_report_json | TEXT | ND | none |
| auth_review_ref | TEXT | ND | none |
| activation_plan_hash | TEXT | ND | none |
| activation_approval_ref | TEXT | ND | none |
| status | TEXT | NN | none |
| created_at | INTEGER | NN | none |
| verified_at | INTEGER | ND | none |
| activated_at | INTEGER | ND | none |
| activation_ref | TEXT | ND | none |
| failure_code | TEXT | ND | none |

Exact CHECK semantics relevant to transforms:

- snapshot_recovery: prep null; backup_id/backup_file_hash/manifest_hash/
  candidate_base_hash/old_epoch/isolation_ack_ref/rpo_report_json all nonnull.
- fresh_bootstrap: prep nonnull; that backup quartet, old_epoch, isolation and RPO
  all null. v3_import: prep nonnull, old_epoch null, isolation/RPO nonnull; backup
  quartet either all null or all nonnull.
- old_epoch null or differs from new_epoch. Status prepared/verified/active/failed;
  verified/active requires verified_at; prepared requires verified_at null.
- Active requires activated_at, activation_ref, auth_review_ref,
  activation_plan_hash and activation_approval_ref all nonnull. Non-active requires
  activated_at/activation_ref/activation_plan_hash/activation_approval_ref null;
  it does **not** add a CHECK forcing auth_review_ref null for every non-active row.
- Failed iff failure_code nonnull. verified_at>=created_at when present;
  activated_at requires verified_at and activated_at>=verified_at.

DB candidate_base_hash=backup_file_hash is a phase/business binding, not a general
DDL equality CHECK for every route. Current validator's registered-v3 comparison
is F:199-201; new phase binding remains the accepted phase protocol.

### 3.26 im_retention_policies

Authority F:30; PK(policy_hash); no FK. version=2; effective_at F-N; retention
fields positive integer helpers plus exact constants7776000000/7776000000/
604800000/15552000000. canonical_json F-JSON. Business validator hashes and checks
the canonical policy (F:120-125); DDL alone does not prove JSON/hash agreement.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| policy_hash | TEXT | NN | none |
| version | INTEGER | NN | none |
| effective_at | INTEGER | NN | none |
| message_retention_ms | INTEGER | NN | none |
| attachment_retention_ms | INTEGER | NN | none |
| safe_retry_window_ms | INTEGER | NN | none |
| audit_retention_ms | INTEGER | NN | none |
| canonical_json | TEXT | NN | none |

### 3.27 im_schema

Authority V:17; version INTEGER NN PRIMARY KEY CHECK=5, rowid alias.
migration_checksum length64, no DDL hex/equality-to-constant CHECK; actual marker
validator requires exact V5_CHECKSUM (V:187-191). No FK/default/automatic index.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| version | INTEGER | NN | none |
| migration_checksum | TEXT | NN | none |

### 3.28 im_schema_preparations

Authority F:28; PK(preparation_ref); UNIQUE(initial_epoch). import_epoch and
initial_epoch FKs to im_center_epochs; policy_hash FK to im_retention_policies.
kind fresh/v3_import; source_version null or integer3. Fresh requires source
version/checksum/import epoch all null; import requires all nonnull and import
epoch different from initial epoch. F-ref/hash/UUID/N checks, no defaults.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| preparation_ref | TEXT | NN | none |
| kind | TEXT | NN | none |
| input_hash | TEXT | NN | none |
| source_version | INTEGER | ND | none |
| source_schema_checksum | TEXT | ND | none |
| import_epoch | TEXT | ND | none |
| initial_epoch | TEXT | NN | none |
| policy_hash | TEXT | NN | none |
| created_at | INTEGER | NN | none |

### 3.29 im_send_keys

Authority H:20; PK(sender_id,client_message_id); UNIQUE(message_id). sender FK to
im_agents; message FK to im_messages. client_message_id legacy id; payload_hash
lowercase64 hex; created_at/retry_until legacy time, retry_until>=created_at;
status live/expired. Composite PK does not alias hidden rowid.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| sender_id | TEXT | NN | none |
| client_message_id | TEXT | NN | none |
| payload_hash | TEXT | NN | none |
| message_id | TEXT | NN | none |
| created_at | INTEGER | NN | none |
| retry_until | INTEGER | NN | none |
| status | TEXT | NN | none |

### 3.30 im_send_operation_keys

Authority F:33; PK(sender_id,origin_epoch,client_message_id);
UNIQUE(message_id); UNIQUE(sender_id,storage_client_message_id). FKs sender to
im_agents, origin_epoch to im_center_epochs, message to im_messages, composite
(sender_id,storage_client_message_id) to im_send_keys(sender_id,client_message_id).
origin/client UUID, other IDs F-id. Protocol a2a-msg.im.v1/v2: v2 storage ID must
be `'v2:'||origin_epoch||':'||client_message_id`; v1 storage ID=client_message_id.
Hidden rowid, three automatic indexes; no default.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| sender_id | TEXT | NN | none |
| origin_epoch | TEXT | NN | none |
| client_message_id | TEXT | NN | none |
| storage_client_message_id | TEXT | NN | none |
| source_protocol | TEXT | NN | none |
| message_id | TEXT | NN | none |

### 3.31 im_settings

Authority H:28; singleton INTEGER PRIMARY KEY CHECK=1, rowid alias ND.
write_mode explicitly NN, DEFAULT 'paused', allowed paused/enabled. No FK.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| singleton | INTEGER | ND | none |
| write_mode | TEXT | NN | 'paused' |

### 3.32 im_sync_progress

Authority F:34; composite PK(recipient_id,center_epoch,stream_epoch), hidden rowid.
recipient_id FK to im_receive_state(agent_id); center_epoch FK to im_center_epochs.
recipient F-id, epochs F-UUID, handled_through/updated_at F-N. No defaults or
extra UNIQUE; a new progress row needs all five named values and future explicit rowid.

| Column | Type | Null clause | Default |
| --- | --- | --- | --- |
| recipient_id | TEXT | NN | none |
| center_epoch | TEXT | NN | none |
| stream_epoch | TEXT | NN | none |
| handled_through | INTEGER | NN | none |
| updated_at | INTEGER | NN | none |

## 4. All 26 explicit named indexes

Each row is type `index`, with literal name, owner and full source CREATE SQL.
Every index is non-UNIQUE, non-partial, ordinary ascending column indexing;
uniqueness comes from the table clauses/automatic indexes, not these named indexes.
Names are in binary order. V3 origin includes indexes retained from earlier DDL.

| Name | Owner / tbl_name | Origin / source | Definition |
| --- | --- | --- | --- |
| im_audit_occurred | im_audit | V3 H:37 | `CREATE INDEX im_audit_occurred ON im_audit(occurred_at,id)` |
| im_center_recovery | im_center_state | V4 F:39 | `CREATE INDEX im_center_recovery ON im_center_state(recovery_run_id)` |
| im_content_expiry | im_content_state | V4 F:39 | `CREATE INDEX im_content_expiry ON im_content_state(state,expires_at,message_id)` |
| im_content_expiry_run | im_content_state | V4 F:39 | `CREATE INDEX im_content_expiry_run ON im_content_state(expiry_run_id)` |
| im_content_policy | im_content_state | V4 F:39 | `CREATE INDEX im_content_policy ON im_content_state(policy_hash,message_id)` |
| im_content_scrub | im_content_state | V4 F:39 | `CREATE INDEX im_content_scrub ON im_content_state(state,scrubbed_at,expires_at,message_id)` |
| im_content_scrub_run | im_content_state | V4 F:39 | `CREATE INDEX im_content_scrub_run ON im_content_state(scrub_run_id)` |
| im_credentials_agent | im_credentials | V3 H:32 | `CREATE INDEX im_credentials_agent ON im_credentials(agent_id)` |
| im_deliveries_message | im_deliveries | V3 H:35 | `CREATE INDEX im_deliveries_message ON im_deliveries(message_id)` |
| im_expiry_delivery | im_expiry_receipts | V4 F:39 | `CREATE INDEX im_expiry_delivery ON im_expiry_receipts(recipient_id,seq)` |
| im_expiry_message | im_expiry_receipts | V4 F:39 | `CREATE INDEX im_expiry_message ON im_expiry_receipts(message_id)` |
| im_legacy_bindings_run | im_legacy_bindings | V3 H:56 | `CREATE INDEX im_legacy_bindings_run ON im_legacy_bindings(migration_run_id)` |
| im_maintenance_completed | im_maintenance_runs | V4 F:39 | `CREATE INDEX im_maintenance_completed ON im_maintenance_runs(status,completed_at,run_id)` |
| im_maintenance_epoch | im_maintenance_runs | V4 F:39 | `CREATE INDEX im_maintenance_epoch ON im_maintenance_runs(center_epoch,run_id)` |
| im_maintenance_policy | im_maintenance_runs | V4 F:39 | `CREATE INDEX im_maintenance_policy ON im_maintenance_runs(execution_policy_hash,run_id)` |
| im_maintenance_time_epoch | im_maintenance_time_anchors | V5 V:53 | `CREATE INDEX im_maintenance_time_epoch ON im_maintenance_time_anchors(center_epoch,generation)` |
| im_messages_conversation | im_messages | V3 H:33 | `CREATE INDEX im_messages_conversation ON im_messages(conversation_id,accepted_at,message_id)` |
| im_messages_sender | im_messages | V3 H:34 | `CREATE INDEX im_messages_sender ON im_messages(sender_id,client_message_id)` |
| im_operation_epoch | im_send_operation_keys | V4 F:39 | `CREATE INDEX im_operation_epoch ON im_send_operation_keys(origin_epoch,sender_id,client_message_id)` |
| im_preparation_import_epoch | im_schema_preparations | V4 F:39 | `CREATE INDEX im_preparation_import_epoch ON im_schema_preparations(import_epoch,preparation_ref)` |
| im_preparation_policy | im_schema_preparations | V4 F:39 | `CREATE INDEX im_preparation_policy ON im_schema_preparations(policy_hash,preparation_ref)` |
| im_recovery_backup | im_recovery_runs | V4 F:39 | `CREATE INDEX im_recovery_backup ON im_recovery_runs(backup_id,run_id)` |
| im_recovery_old_epoch | im_recovery_runs | V4 F:39 | `CREATE INDEX im_recovery_old_epoch ON im_recovery_runs(old_epoch,run_id)` |
| im_recovery_preparation | im_recovery_runs | V4 F:39 | `CREATE INDEX im_recovery_preparation ON im_recovery_runs(preparation_ref,run_id)` |
| im_send_keys_retry | im_send_keys | V3 H:36 | `CREATE INDEX im_send_keys_retry ON im_send_keys(retry_until,status)` |
| im_sync_epoch | im_sync_progress | V4 F:39 | `CREATE INDEX im_sync_epoch ON im_sync_progress(center_epoch,recipient_id,stream_epoch)` |

## 5. All 42 derived automatic indexes, with null SQL

Derivation reproduces V:64-69 and independently compares M:57-63: count table
UNIQUE/PRIMARY KEY clauses, subtract one for INTEGER PRIMARY KEY rowid alias,
emit contiguous suffixes starting1 per owner. This frozen-DDL-specific source
algorithm is not advertised as a general SQL parser. These exact names/owners
and **SQL null** form the remaining global allowlist, not runtime observations.
No fabricated CREATE INDEX statement is assigned to an automatic index.

| Type | Name | Owner / tbl_name | SQL |
| --- | --- | --- | --- |
| index | sqlite_autoindex_im_agents_1 | im_agents | null |
| index | sqlite_autoindex_im_attachment_reservations_1 | im_attachment_reservations | null |
| index | sqlite_autoindex_im_attachment_reservations_2 | im_attachment_reservations | null |
| index | sqlite_autoindex_im_attachments_1 | im_attachments | null |
| index | sqlite_autoindex_im_attachments_2 | im_attachments | null |
| index | sqlite_autoindex_im_center_epochs_1 | im_center_epochs | null |
| index | sqlite_autoindex_im_center_schema_transitions_1 | im_center_schema_transitions | null |
| index | sqlite_autoindex_im_center_schema_transitions_2 | im_center_schema_transitions | null |
| index | sqlite_autoindex_im_center_state_1 | im_center_state | null |
| index | sqlite_autoindex_im_contacts_1 | im_contacts | null |
| index | sqlite_autoindex_im_content_state_1 | im_content_state | null |
| index | sqlite_autoindex_im_conversations_1 | im_conversations | null |
| index | sqlite_autoindex_im_conversations_2 | im_conversations | null |
| index | sqlite_autoindex_im_credentials_1 | im_credentials | null |
| index | sqlite_autoindex_im_deliveries_1 | im_deliveries | null |
| index | sqlite_autoindex_im_deliveries_2 | im_deliveries | null |
| index | sqlite_autoindex_im_expiry_receipts_1 | im_expiry_receipts | null |
| index | sqlite_autoindex_im_expiry_receipts_2 | im_expiry_receipts | null |
| index | sqlite_autoindex_im_lease_requests_1 | im_lease_requests | null |
| index | sqlite_autoindex_im_legacy_bindings_1 | im_legacy_bindings | null |
| index | sqlite_autoindex_im_legacy_bindings_2 | im_legacy_bindings | null |
| index | sqlite_autoindex_im_maintenance_runs_1 | im_maintenance_runs | null |
| index | sqlite_autoindex_im_maintenance_runs_2 | im_maintenance_runs | null |
| index | sqlite_autoindex_im_maintenance_time_anchors_1 | im_maintenance_time_anchors | null |
| index | sqlite_autoindex_im_maintenance_time_anchors_2 | im_maintenance_time_anchors | null |
| index | sqlite_autoindex_im_maintenance_time_anchors_3 | im_maintenance_time_anchors | null |
| index | sqlite_autoindex_im_maintenance_time_anchors_4 | im_maintenance_time_anchors | null |
| index | sqlite_autoindex_im_messages_1 | im_messages | null |
| index | sqlite_autoindex_im_migration_runs_1 | im_migration_runs | null |
| index | sqlite_autoindex_im_receive_state_1 | im_receive_state | null |
| index | sqlite_autoindex_im_receiver_leases_1 | im_receiver_leases | null |
| index | sqlite_autoindex_im_recovery_runs_1 | im_recovery_runs | null |
| index | sqlite_autoindex_im_recovery_runs_2 | im_recovery_runs | null |
| index | sqlite_autoindex_im_retention_policies_1 | im_retention_policies | null |
| index | sqlite_autoindex_im_schema_preparations_1 | im_schema_preparations | null |
| index | sqlite_autoindex_im_schema_preparations_2 | im_schema_preparations | null |
| index | sqlite_autoindex_im_send_keys_1 | im_send_keys | null |
| index | sqlite_autoindex_im_send_keys_2 | im_send_keys | null |
| index | sqlite_autoindex_im_send_operation_keys_1 | im_send_operation_keys | null |
| index | sqlite_autoindex_im_send_operation_keys_2 | im_send_operation_keys | null |
| index | sqlite_autoindex_im_send_operation_keys_3 | im_send_operation_keys | null |
| index | sqlite_autoindex_im_sync_progress_1 | im_sync_progress | null |

## 6. Rowid semantics and fixed-transform target facts

### 6.1 Exactly eight INTEGER PRIMARY KEY aliases

| Table | Declared alias | Explicit NOT NULL? |
| --- | --- | --- |
| im_audit | id | No |
| im_center_state | singleton | Yes |
| im_clock | singleton | No |
| im_instance_identity | singleton | No |
| im_maintenance_time_anchors | generation | Yes |
| im_maintenance_time_head | singleton | Yes |
| im_schema | version | Yes |
| im_settings | singleton | No |

All other 24 tables have hidden rowid, including TEXT/composite PK tables and
im_legacy_bindings with no PK. All 32 are ordinary rowid tables. No declared
column is named rowid, _rowid_ or oid; no alias-shadowing, WITHOUT ROWID, virtual
table or AUTOINCREMENT occurs in source DDL. IPK alias identity must be preserved
in replay; composite primary keys do not erase row identity. Audit id's ND DDL
must not be confused with a nullable stored rowid, nor with a DEFAULT declaration.

The future phase protocol requires positive new allocations from
`max(0,virtualPredecessorMAX(rowid))+1`, explicit signed64 BigInt handling and
overflow refusal beyond 9223372036854775807. This is **phase behavior**, not a
claim that old SQL already supplies explicit rowids. Anchor generation remains
its existing safe-integer constrained semantic key, preserved rather than allocated
by recovery. No OR REPLACE, implicit reallocation or automatic adoption follows.

### 6.2 Prepare insertion order, defaults and constraint dependencies

Current C:552-571 supplies a useful field mapping but uses old guard/implicit
rowids. Future snapshot prepare must create the new epoch before progress/run/
center references to it. Original im_receive_state recipients must exist before
new progress FKs; P1 preparation/policy facts remain present. Insert run before
updating center.recovery_run_id. No declared deferred FK makes arbitrary reordering
safe. Reject existing run/new epoch/progress key rather than replacing them.

| Target | Exact supplied values and preservation |
| --- | --- |
| im_center_epochs | Explicit future hidden rowid; center_epoch=new approved epoch, created_at=reservedAt, origin=recovery, recovery_counter=approved increment; no defaults. Fresh/import retain P1 epoch/counter0 instead of inserting a snapshot epoch |
| im_sync_progress | Explicit future hidden rowid per recipient in binary UTF-8 order; recipient_id, new center_epoch, original stream_epoch, genuine contiguous ACK prefix as handled_through, updated_at=reservedAt; no defaults. Do not borrow expiry receipts or overwrite old progress |
| im_recovery_runs | Explicit future hidden rowid; all 23 columns supplied as listed below; run_id PK and new_epoch UNIQUE/FKs require exact absence/parent presence |
| im_center_state | Existing singleton/rowid1 updated, not replaced: approved epoch/counter, prepared, activation_ref null, recovery_run_id this new run, updated_at reservedAt; singleton/UNIQUE/FKs preserved |
| im_clock | Existing singleton/rowid1 floor becomes reservedAt atomically with business phase, except pause leaves it unchanged; DEFAULT0 is not a reset permission |
| im_settings | Existing singleton/rowid1 stays paused through prepare/verify/activate; enabled->paused pause changes only this value. DEFAULT paused does not authorize row replacement |
| im_receiver_leases | Delete exactly all predecessor leases during prepare; preserve request history and other rowids; PK/FK facts do not grant source mutation |
| im_maintenance_time_head | Snapshot prepare deletes only actual zero-or-one head row; preserve all anchors/generation/transition and no new head/session. FK references from head to anchors are not reverse deletion permission |

Exact prepare row values in DDL order (no omitted nullable columns/default guesses):

| Column | Prepared value |
| --- | --- |
| run_id | intent.runId |
| candidate_kind | effect.candidateKind |
| preparation_ref | effect.preparationRef |
| backup_id | effect.backupId |
| backup_file_hash | effect.backupFileHash |
| manifest_hash | effect.manifestHash |
| candidate_base_hash | effect.candidateBaseHash; registered equals backupFileHash |
| candidate_reference | intent.candidateReference |
| old_epoch | effect.oldEpoch |
| new_epoch | effect.newEpoch |
| approved_plan_hash | intent.planHash |
| approval_ref | intent.approvalRef |
| isolation_ack_ref | effect.isolationAckRef |
| rpo_report_json | null fresh; otherwise exact ordered JSON of effect.rpoReport |
| auth_review_ref | null |
| activation_plan_hash | null |
| activation_approval_ref | null |
| status | prepared |
| created_at | reservedAt |
| verified_at | null |
| activated_at | null |
| activation_ref | null |
| failure_code | null |

Fresh/closed3 have null backup quartet; registered routes have all four nonnull,
with base equal original backup hash, not converted/live hash. Fresh/import use
nonnull preparationRef, null oldEpoch, original P1 initial epoch/counter0;
snapshot uses null prep, genuine nonnull backup/isolation/RPO, distinct new epoch
and safe counter increment. Phase intent actor identities are not new DB columns.

### 6.3 Verify/activate and audit IPK

Verify changes this run's status/verified_at and center status/updated_at plus
clock in the atomic phase projection. It inserts no new run/epoch/audit. Active
transition changes existing verified run to active and sets auth_review_ref,
activation_plan_hash, activation_approval_ref, activated_at and activation_ref;
center becomes active with activation_ref/update time. Preserve verified_at and
all other history, clock floor rules and paused write mode.

Activate inserts exactly one audit with future explicit `id=rowid` allocation:
actor_kind system; actor_id runId; action recovery.activate; target_ids_json is
JSON.stringify([runId]); occurred_at reservedAt; safe_details_json is JSON.stringify
of the single activationPlanHash binding. No id default clause exists.
**Current old activation SQL at C:525-526 omits id**, allowing implicit rowid
allocation; future explicit allocation is required by the phase protocol. This
artifact neither implements that change nor treats the old insert as compliant.

## 7. Whole allowlist, validator scope and PRAGMA facts

For strict future recovery admission, the exact global object membership is:
**§3's 32 tables + §4's 26 explicit indexes + §5's 42 automatic indexes = 100**.
Names are unique across the union, each index owner is one of the 32 tables, and
every explicit table/index definition comes from the committed DDL authority.
Automatic indexes require type index, exact owner and SQL **null**, not empty SQL.

General V5 validator scope is narrower: V:168-193 verifies the IM-named/owned
manifest, IM automatic indexes and marker, with an IM-scoped temp check. It does
not claim the future whole-database exclusion by rejecting every unrelated main
object. H:69-78 and F:90-105 likewise keep their historical scope. Do not silently
broaden these validators from documentation.

M:57-63 constructs an OBJECTS map from exactly the same V5 manifest plus automatic
indexes. M:333-355 compares all main objects and rejects any temp object, with
length projection and normalized SQL comparison. That static code is a useful
cross-check of allowlist intent, not evidence that a live DB was inspected here,
nor a replacement for new recovery ownership/budget/phase checks.

The committed phase protocol's stronger admission rejects foreign/non-IM objects,
statistics tables, sqlite_sequence, views/triggers, virtual/shadow tables,
WITHOUT ROWID, temp objects and unexpected attached DBs. Neither name prefixes
nor count100 alone suffice: exact type/name/owner/definition membership is required.
SQLite system catalogs are metadata sources, not a 33rd streamed table or an extra
allowlist entry. Do not generate sqlite_sequence: no AUTOINCREMENT is declared.

Source inspection finds no fixed encoding/application_id/user_version/page_size
pin in the general schema validators. The `im_schema.version` marker is not
PRAGMA user_version; schema_version cookie is not the migration version either.
foreign_keys is required ON by general assertions; maintenance-time connection
checks at M:386-389 additionally check DELETE/FULL/busy0. Those connection controls
do not pin the four file PRAGMAs named above. This is a code-scope fact, not an
observed PRAGMA value. New digest spelling/admission treatment, page_size inclusion
or exclusion, and attached-DB checks belong to the separate byte-grammar/phase
review; no guessed SQLite defaults are fixed by this manifest.

## 8. Static validation, open boundaries and handoff

Static completeness checks for this document cover:

- Exactly 32 distinct table headings in binary name order, 237 column rows in exact
  source order, exact declared types/explicit-NOT-NULL/default mapping; no duplicate
  column names within a table and no rowid/_rowid_/oid shadowing.
- Exact 26 named index SQL/name/owner entries and 42 automatic name/owner/null-SQL
  entries in binary order; union exactly100 unique objects with valid owners.
- V3/V4/V5 source-derived counts18/7/18,29/25/36,32/26/42; unchanged inherited DDL
  excluding only marker replacement, exact added table sets and eight IPK aliases.
- Source normalized V5 manifest equals the existing literal fixture; V4 fixture
  and V5 additive/full-DDL/checksum pins agree as static strings/hashes.
- UTF-8 without BOM, final newline, balanced fences, valid relative links and
  whitespace; only this new document is writable in this lane.

These are exhaustive **text/static** checks, not SQL execution or runtime test
PASS. PK nullable-DDL versus business invariants, IPK alias semantics, source SQL
normalization versus stored SQL, and general IM scope versus strict global scope
are real distinctions, not ambiguities to erase. Autoindex names are the current
source derivation, not a fabricated sqlite_master transcript.

Still outside this artifact: exact digest byte framing (including null SQL and
scalar/type payloads), complete phase binding bundles/predecessor links/DTOs,
publication inventories and independent runtime evidence. No inventory discrepancy
authorizes changing DDL/checksums or narrowing historical null semantics. Parent
independent review must accept this literal manifest and combine it with the
separate byte-grammar proposal before any corresponding implementation gate.
No status changes to other documents, runtime DB/probes/tests/services, dependency
installation, source edit, commit or push are part of this handoff.
