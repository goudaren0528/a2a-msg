# C2-B2 recovery-v5 central phase protocol (NONRELEASE)

**Conceptual architecture: PASS (parent-reviewed decisions). This central
protocol DOCUMENT subset: ACCEPTED after independent review (2026-09-28).
Whole C2: IN_PROGRESS. Codec lanes and S3/H4: NOT READY. Q5: blocked / NOT RUN.**

Checked HEAD: `2b9334ca168682885391fa9ce2d75c6f817afe47` (2026-09-28).
This is faithful central-protocol transcription, not implementation or runtime
evidence. Independent central-protocol document review passed; the remaining
artifact design and review gate is still pending.
Accepted [C2-A archive/intake](im-v2-recovery-v5-intake-contract.md) and
[C2-B1 admission](im-v2-recovery-v5-admission-contract.md) remain unchanged.
The [current ledger](im-v2-implementation-plan.md#52-接下来按依赖推进的-todo)
retains the dependency order. Read with the
[compatibility](im-v2-schema-v5-compatibility-contract.md),
[prepare](im-v2-recovery-prepare-contract.md) and
[conversion](im-v2-recovery-conversion-contract.md) contracts.

The literal schema/object/column manifest is **PENDING** a separate read-only
extraction and independent artifact review. This document does not expand that
manifest, invent unresolved byte framing or claim complete binding bundles, a
final facade signature, or ready pure-codec exports. Sections below distinguish
central decisions from still-missing exact artifacts.

## 1. Private owned executor and original operation budget

The future executor owns a genuine closed candidate, authenticated privately by
WeakMap identity. Hold genuine **source -> workspace -> candidate** control once
across validation, prediction, intent, transaction, close, sync, result publication
and final checks. Fresh has no fabricated source lock; closed3 keeps original
trusted isolation. There is no caller DB handle, path, clock/time override, SQL,
transform callback, generic writer or DTO-to-brand registrar. Descriptive hashes
and records cannot mint ownership. Synchronous adapter lifetime, caught-fault
poison, reentry rejection and final authorization remain mandatory.

Use one original authenticated inherited budget through baseline/source validation,
bounded chain replay, all full validation/digests, copying/hashing, sync/publication,
callbacks and final checks. No reset, replacement object, raised/new limit or
per-phase/per-scan fresh budget. Existing 10000 ms or lower elapsed ceiling remains;
native SQLite/fsync work is soft-budgeted, not hard interruptible. A candidate that
fits all size limits may still refuse for elapsed time. Budget ticks surround native
calls and every row/chunk; length/count projections precede variable reads.

Existing authentic inheritance is in
[recovery-records.js](../src/im/v2/recovery-records.js) lines 18-39. Existing mint
and converter entry budgets in [recovery.js](../src/im/v2/recovery.js) lines 548-573
do not by themselves provide the new inherited entry. C2-B1's required private
integration remains. Old stage/P1 and explicit conversion are separate prerequisite
operations, not retrospectively included in this operation's budget.

## 2. Reserved time and one atomic clock/business transaction

The ordinary clock guard is **unsuitable** for this executor. Actual
[clock.js](../src/im/v2/clock.js) lines 94-111, 178-209 independently anchor before
business work and retain high-water after business rollback; even `runRead` anchors
at lines 127-154. The new executor does not call that guard, copy its savepoint
behavior, or authorize clock-only leftovers. Historical clock/runtime APIs remain
unchanged. C2-B1's requirement for durable intent before clock mutation is preserved;
this central decision supplies a separate atomic executor rather than admitting
arbitrary monotonic clock deltas.

For a new intent:

1. Authenticate original baseline, chain, predecessor, current source/hold/closure
   and actual candidate; do expensive timestamp-independent validation first.
2. Take one trusted `reservedAt` sample. Require it to be at least the virtual
   predecessor clock, persisted plan.createdAt and all applicable prior phase
   times, and strictly less than persisted plan.expiresAt.
3. Derive timestamp-dependent fixed effects and predicted post-state/digest using
   that one sample, under the same budget. Prediction still consumes time/budget;
   this is **not** a promise that all expensive work precedes time sampling.
4. Bind and durably publish immutable intent before any writable candidate open.
   Set `executeBefore = actual persisted plan.expiresAt` exactly.
5. Before BEGIN and immediately before COMMIT, take trusted freshness-only samples:
   each must be >= reservedAt and < executeBefore, and nondecreasing within the
   invocation. They do not replace reservedAt or write extra clock samples.

There is **no 5000 ms reservation window**, no `min(expiresAt,reservedAt+5000)`,
and no new budget ceiling. Exact-prestate after expiry is `RECOVERY_PLAN_STALE`;
preserve intent/plan, do not automatically renew, abandon, replan, reseal or switch
run. A possible future manual path is not an existing operation or approval.

For prepare/verify/activate, clock and business effects commit in one SQLite
transaction, with `im_clock.last_observed_at = reservedAt`. Pause never changes
clock. Result.phaseAt is reservedAt, **not publication/completion wall time**.
Current completion authorization is distinct from mutation freshness (§10).

## 3. Immutable baseline and route-specific intake

| Route | Authenticated immutable replay baseline | Initial candidate requirement |
| --- | --- | --- |
| Native registered5 | Genuine B2 registered artifact, actual record4/source2/manifest3 and full exact5/hash under durable source scope | Independent copy whose initial file hash equals source artifact; candidate-only header normalization with intent/completion and full logical/schema/rowid equality |
| Converted fresh/import/snapshot | C2-A independent conversion archive with actual completion posthash and genuine handoff | Retained live `runs/<runId>/candidate.sqlite`, initially equal handoff live/posthash; original source/closure/hold still required |

The native baseline is not the mutable copy; converted baseline is not the live
candidate. Missing/corrupt baseline refuses: no cache, alternate file or candidate
bytes may substitute. Revalidate original baseline hash, full schema/object
inventory, identity and protection before and after replay/operation. Converted
archive/handoff remain immutable after valid live mutation; converter exclusion
precedes obsolete live-posthash checking and old target4 exclusion is permanent.

Native5 copying preserves source bytes. A completed protected backup with legal
closed WAL header is read only through its genuine immutable backup scope; that
exception never permits opening a mutable candidate with an immutable/journal
bypass. Normalize only the owned candidate, under its own durable intent/completion,
with all logical schema, cells and rowids identical. Copy/base/normalization exact
records, byte-retry rules and links are **PENDING**, not inferred from this paragraph.

### 3.1 baseline exact ordered nested layout

| Field | Type / requirement |
| --- | --- |
| kind | `registered-native5` or `conversion-archive` |
| reference | R; exact genuine artifactReference or C2-A archiveReference |
| fileHash | H; actual immutable baseline bytes |
| sourceEvidenceHash | H?; raw C1 source hash native, null converted |
| handoffHash | H?; null native, new-domain C2-A handoff hash converted |
| stateDigest | H; exact logical baseline digest under §5 |

Native reference is actual `registry/artifacts/<backupId>.sqlite`, fileHash equals
source.fileHash, and sourceEvidenceHash is the raw C1 source2 hash. Converted
reference is `runs/<runId>/conversion-archive.sqlite`, fileHash equals archive hash
and completion posthash, handoffHash binds the C2-A conversionHandoff. Converted
baseline.sourceEvidenceHash is null even when the original source is registered;
original source remains bound through intake/handoff and private source validation.
Reference is descriptive, never path authority. This nested object is not a new
standalone capability or a claimed independent codec export.

## 4. Bounded virtual replay and explicit row identity

Replay at most four fixed phases, in order **pause -> prepare -> verify -> activate**.
All prior phases need complete exact results; the current intent may lack its
result. Later-phase artifacts, duplicate phases and unknown pending evidence refuse.
The final literal inventories remain an artifact gate; absence of that artifact
does not permit a catch-all file allowance.

Authenticate baseline actual bytes/schema/object inventory, then the bounded exact
intent/result chain. Stream fixed virtual transforms from baseline through each
predecessor. Derive virtual pre-state facts, rowid maxima and expected before/after
digests independently; compare them with intent digests. Independently inspect and
digest the actual candidate. Never adopt an actual candidate hash as expected
output, use a temporary oracle DB, materialize the whole DB or retain BLOBs across
rows. Final source/baseline checks remain required after callbacks and native work.

Existing rowids are signed 64-bit BigInt facts and must be preserved, not converted
through unsafe JavaScript Number. For each table receiving inserted rows:

```text
startRowid = max(0, virtualPredecessorMAX(rowid)) + 1
1 <= allocated rowid <= 9223372036854775807
```

Empty table uses the zero base. Allocate subsequent inserted rows consecutively,
check the whole allocation for signed64 overflow before mutation, and refuse on
overflow. No SQLite implicit allocation, `OR REPLACE`, AUTOINCREMENT or random
fallback. Allocations derive from virtual predecessor, never an actual post-state
maximum. Existing negative/zero rowids remain unchanged where admitted.

| Fixed insertion | Count / deterministic order |
| --- | --- |
| Snapshot prepare `im_center_epochs` | Exactly one new approved epoch row; explicit rowid |
| Every prepare `im_recovery_runs` | Exactly one row for this run; explicit rowid |
| Snapshot prepare `im_sync_progress` | Exactly one per actual recipient from predecessor receive state, ordered by binary raw UTF-8 recipient ID; explicit hidden rowid despite composite PK |
| Activate `im_audit` | Exactly one row; explicitly allocated `id` equals rowid because id is INTEGER PRIMARY KEY |

The historical audit IPK definition is in
[schema-history.js](../src/im/v2/schema-history.js) line 25. The complete literal
table/column/autoindex artifact is deliberately not expanded here.

Freeze mutation expectations: this run must not exist before prepare; snapshot
newEpoch and each new progress key must be absent; conflicting existing rows refuse,
never adopt/replace. Expected singleton/run transitions affect exactly one row.
Lease deletion affects exactly the virtual predecessor lease set; head deletion
removes only its actual zero-or-one singleton. All insert cardinalities and
unchanged rows must match the virtual projection; row-count coincidence alone is
not equality. Complete binding bundles will encode these requirements, not omit
them because a query reports success.

## 5. Proposed state digest and strict inventory boundary

```text
stateDigest = SHA256(UTF8('a2a-msg.im.v2/recovery-v5/state-v1\n') || stream)
frame(tag, bytes) = ASCII(tag) || ':' || ASCII(decimalByteLength) || ':' || bytes
```

Lengths count bytes, decimal with no leading zero (zero is `0`). The complete
stream is bounded under the inherited limits. No unframed ambiguous concatenation
or physical root-page hash. Prefix has exactly one newline and no NUL.

Central stream order:

1. schemaVersion and exact schemaChecksum.
2. PRAGMA user_version, application_id, encoding, in that order, each name/value.
3. All schema objects in binary name order: type, name, tbl_name, sql; exclude
   rootpage as physical placement, not object identity.
4. Tables in binary name order; each declared column name/type in DDL order; rows
   in signed rowid order; typed rowid then each cell in column order, using its
   **actual storage class**, separately from declared type.
5. Per-table rowCount and tableEnd framing.

Exact tag vocabulary:

```text
schemaVersion schemaChecksum pragmaName pragmaValue
objectType objectName objectTable objectSql
table columnName columnType rowid null integer real text blob rowCount tableEnd
```

Cell integer is canonical signed BigInt decimal, REAL is binary64 big-endian,
TEXT is raw UTF-8 bytes obtained via `CAST(... AS BLOB)`, BLOB is raw bytes. Null
has its own tag and is distinct from empty text/blob frames. Rowid must preserve
signed64 precision. Count/length/metadata probes precede variable fetches; include
all maintenance-history/head/transition rows in caps and scans. Stream at most one
row and one BLOB at a time; do not accumulate row arrays or retained BLOBs. Budget
checks surround native calls and each row/chunk, with all original caps preserved.

**Artifact gate remains open:** the supplied tag/order decisions do not yet fully
specify, for example, nullable objectSql framing versus empty SQL, pragmaValue
scalar spelling, rowid versus integer frame composition, or tableEnd payload.
Literal framing examples/golden bytes must resolve every such ambiguity, together
with the exact schema/column/type/object manifest. Do not silently choose encodings
or claim digest implementation readiness. The separate read-only explorer's
literal extraction is an input to review, not automatic acceptance.

The parallel static-DDL review's corrected summary is **32 tables + 26 explicit
indexes = 58 manifest objects**, plus **42 derived automatic indexes**, for a
global allowlist total of **100**. Its item-by-item check reported no omissions.
These are static DDL deductions, not SQLite runtime observations. Earlier totals
of 31 tables / 27 explicit indexes and 44 automatic indexes were report arithmetic
errors and are superseded, not evidence to reuse. This summary does not expand or
accept the full literal manifest; that artifact remains PENDING.

New recovery admission is stricter than general `im_*` validation: allow only the
exact V5 manifest objects/DDL and declared autoindex names/owners/null SQL. Reject
extra non-IM objects, statistics/sequence tables, views/triggers, virtual/shadow
tables, WITHOUT ROWID, temp objects or unexpected attached DBs. System catalog
metadata is validated/encoded as schema metadata, not streamed as a business
table. No general schema-validator behavior changes. Old3/4 logical digest byte
algorithms remain unchanged; actual old digest in
[recovery-candidate.js](../src/im/v2/recovery-candidate.js) lines 105-156 uses its
own tags/structure and only old3/4 selection. It cannot be renamed state-v1.

## 6. Core ordered layouts and strict record rules

Use C2-A exact ordinary-object/byte discipline: Proxy rejection before reflection,
Object.prototype, exact enumerable own data keys, no accessor/symbol/hidden/extra
or omitted fields, no coercion/getter/toJSON/iterator invocation. Required nullable
fields are explicit null. Strict recursive snapshots protect historical nested
records before old codecs; preserve their original canonical hashes.

Canonical record bytes are ordered JSON.stringify UTF-8, no BOM/whitespace/newline,
at most 65536 bytes including nested objects. Encode returns detached owned bytes;
decode uses bounded owned nonshared ordinary Buffer/Uint8Array input, fatal UTF-8
and byte-identical canonical re-encoding. Reject duplicates/escaped aliases,
reordered bytes, alternate escaping/numbers and trailing data. Outputs detached
deeply frozen. Fixed encode/hash error `RECOVERY_INVALID`; decode/binding error
`RECOVERY_EVIDENCE_MISMATCH`, with no foreign exception inspection or raw disclosure.

| Primitive | Rule |
| --- | --- |
| U | Lowercase UUID, length36, `^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$` |
| H | Exactly 64 lowercase hex characters |
| N | Nonnegative safe integer, explicitly not -0; milliseconds for times |
| R | P5 Ref: 1..255 UTF-16 units, no C0/DEL, no normalization |
| T? | Required T or explicit null |
| Source pair | null/null fresh, 3/exact V3 import, 4/exact V4 converted snapshot, 5/exact V5 native snapshot |
| Target pair | Exactly 5 / V5_CHECKSUM |

V3/V4/V5 checksums are the existing constants identified by C2-A, not arbitrary H.
These layouts are central decisions **pending document and full binding-artifact
review**. No pure-codec module/export list is ready with incomplete bindings.

```text
newRecordHash = SHA256(UTF8('a2a-msg.im.v2/recovery-v5/' + kind + '\n')
                      || canonicalRecordBytes)
```

Named record kinds here are phaseIntent, phaseResult, phaseObservation and seal;
seal.version is 2, other core records version1. Plan names below identify pending
plan artifacts, not completed record definitions. Baseline/effect are nested layouts.
Historical raw, NUL-domain and maintenance newline-domain hashes remain unchanged.

### 6.1 phaseIntent

| Field | Type / binding |
| --- | --- |
| version | Literal 1 |
| phase | pause, prepare, verify or activate |
| executionMode | observe-noop or transaction; §8 mode restrictions |
| runId | U |
| candidateReference | Exact C2-A route path |
| stageHash | H; new target5 stage, not converted historical hold.stageHash |
| intakeKind | nativeIntake or convertedIntake, correlated to route |
| intakeHash | H; new-domain exact intake hash |
| handoffHash | H?; null native, C2-A handoff hash converted |
| baseline | Exact §3.1 nested layout |
| predecessorKind | Phase-correlated; §6.4 unresolved pause link |
| predecessorHash | H; actual appropriate persisted predecessor |
| planKind | pausePlan, preparePlan, verifyPlan or activationPlan, phase-correlated |
| planHash | H; actual persisted corresponding plan |
| approvalRef | R?; null pause/verify, nonnull prepare/activate |
| executorId | R?; null pause/verify, captured nonnull prepare/activate |
| approverId | R?; null pause/verify, captured distinct nonnull prepare/activate |
| sourceSchemaVersion | Required null, 3, 4 or 5; original-source pair |
| sourceSchemaChecksum | H?; exact correlated original-source checksum |
| targetSchemaVersion | Literal 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| instanceId | U |
| instanceCreatedAt | N |
| initialFileHash | H; actual first phase-admission predecessor file binding, retained on same-intent retry |
| beforeStateDigest | H; independently replay-derived virtual predecessor |
| afterStateDigest | H; independently replay-derived fixed effect |
| previousClock | N; virtual predecessor floor |
| reservedAt | N; §2 single persisted reservation |
| executeBefore | N; exactly persisted plan.expiresAt |
| effect | Exact phase union in §7, bound to actual persisted plan |

### 6.2 phaseResult

| Field | Type / binding |
| --- | --- |
| version | Literal 1 |
| phase | pause, prepare, verify or activate |
| outcome | observed-noop or committed, selected by executionMode |
| runId | U |
| candidateReference | Exact route path |
| intentHash | H; new-domain phaseIntent hash |
| planHash | H; same persisted plan |
| intakeHash | H; same intake |
| handoffHash | H?; null native, same handoff converted |
| instanceId | U |
| instanceCreatedAt | N |
| targetSchemaVersion | Literal 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| stateDigest | H; exactly intent.afterStateDigest |
| candidateFileHash | H; actual closed, synced candidate bytes |
| clockFloor | N; previousClock for pause, reservedAt otherwise |
| phaseAt | N; exactly intent.reservedAt, not publication time |
| state | paused, prepared, verified or active, correlated to phase |

### 6.3 phaseObservation

| Field | Type / binding |
| --- | --- |
| version | Literal 1 |
| runId | U |
| phase | pause, prepare, verify or activate |
| intentHash | H; actual authenticated intent |
| classification | noop-matched, initial, committed or indeterminate |
| actualStateDigest | H when actual settled state can be authenticated |
| actualFileHash | H when actual settled bytes can be authenticated |
| actualClock | N when actual settled floor can be authenticated |
| resultHash | H?; exact existing result hash or null when absent |

This is descriptive observation, not mutation/completion/disclosure authority.
**Pending status artifact:** exact unknown-fact nullability and whether an
unauthenticated/unsafe state throws rather than yields partial phaseObservation
must be frozen in complete binding/result tables. Do not fabricate actual facts
for indeterminate state or infer optional omitted fields from these descriptions.

### 6.4 Shared route and predecessor bindings

Native candidateReference is `v5-runs/<runId>/candidate.sqlite`; converted is
`runs/<runId>/candidate.sqlite` retaining old run/workspace. New records live under
`v5-runs/<runId>/`; new locators under `v5-requests/`. Intake/handoff/identity/source
schema pairs must agree with C2-A and B1; hashes never replace genuine ownership.
The same baseline and intake must bind every phase of the run.

| Phase | Required predecessor / plan relationship |
| --- | --- |
| pause native | Completed native normalization precedes pause; **exact predecessor enum/hash/link PENDING** |
| pause converted | C2-A converted intake/handoff precedes pause; **exact predecessor enum/hash/link PENDING** |
| prepare | pauseResult / pause result hash; preparePlan |
| verify | prepareResult / prepare result hash; verifyPlan |
| activate | seal / seal hash; activationPlan |

An earlier intake-only pause predecessor proposal conflicts with revised native
normalization dependency. Do not silently choose `intake` or fabricate a
normalization record kind. The next artifact must resolve the exact union/link.
Prior phase results and seal remain fully crossbound, not merely hash-equal DTOs.

## 7. Fixed effect unions and actual database projections

Each effect contains exactly these fields in the declared order. Fixed transforms
derive from an authenticated persisted plan and virtual predecessor; no hidden
mutable outputs or caller transforms. All cells outside the listed changes,
including their rowids/storage classes, remain identical.

### 7.1 Pause effect

| Field | Type / requirement |
| --- | --- |
| originalWriteMode | paused or enabled; actual predecessor |
| targetWriteMode | Literal paused |

Already paused uses observe-noop with no candidate writable open/transaction and
identical before/after digest/clock. Enabled uses transaction changing only the
singleton write mode to paused, exactly one row; clock unchanged. Converted intake
is already paused; native snapshots may be paused or enabled.

### 7.2 Prepare effect

| Field | Type / requirement |
| --- | --- |
| candidateKind | fresh_bootstrap, v3_import or snapshot_recovery |
| preparationRef | R?; real P1 ref fresh/import, null snapshot |
| backupId | U?; genuine registered source tuple |
| backupFileHash | H?; original backup bytes |
| manifestHash | H?; original manifest |
| candidateBaseHash | H?; registered equals backupFileHash |
| oldEpoch | U?; null fresh/import, actual snapshot predecessor epoch |
| newEpoch | U; original P1 initialEpoch fresh/import, distinct approved epoch snapshot |
| recoveryCounter | N; 0 fresh/import, safe actual predecessor +1 snapshot |
| isolationAckRef | R?; null fresh only |
| rpoReport | Required null fresh or exact old unknown-only shape below |

Registered3/import, registered4/converted snapshot and native5 snapshot have the
whole backup quartet nonnull and candidateBaseHash equal original backupFileHash,
not normalized/converted/current candidate hash. Fresh and closed3 import have
all four null; closed3 retains real external source copy evidence but no fabricated
DB backup tuple. Fresh/import keep actual original P1 initialEpoch/counter0 and
nonnull preparationRef; snapshot has null preparationRef, distinct newEpoch and
safe counter increment. P1 preparations and original identity remain unchanged.

Exact old nested RPO order:

```text
status,snapshotCompletedAt,sourceObservedAt,missingAcceptedCount,missingAckCount,
missingReadCount,comparisonEvidenceHash,authChanges,notesCode
```

status/authChanges are `unknown`; missing counts and comparisonEvidenceHash null;
registered snapshotCompletedAt is real original completion, sourceObservedAt null;
closed3 sourceObservedAt is retained observation, snapshotCompletedAt null.
notesCode is `COMPARISON_INCOMPLETE`. No measured RPO or source-unavailable shortcut.
The actual old shape is [recovery-plan.js](../src/im/v2/recovery-plan.js) line 29,
with source-correlated comparisons at lines 150-153.

### 7.3 Every prepare row and center change

The following transcribes **all** actual old insert fields from
[recovery-candidate.js](../src/im/v2/recovery-candidate.js) lines 562-568, with the
new reserved-time/plan bindings. This is a projection, not replacement DDL:

| im_recovery_runs column (old insert order) | New fixed value |
| --- | --- |
| run_id | intent.runId |
| candidate_kind | effect.candidateKind |
| preparation_ref | effect.preparationRef |
| backup_id | effect.backupId |
| backup_file_hash | effect.backupFileHash |
| manifest_hash | effect.manifestHash |
| candidate_base_hash | effect.candidateBaseHash, equal backupFileHash when registered |
| candidate_reference | intent.candidateReference |
| old_epoch | effect.oldEpoch |
| new_epoch | effect.newEpoch |
| approved_plan_hash | intent.planHash |
| approval_ref | intent.approvalRef |
| isolation_ack_ref | effect.isolationAckRef |
| rpo_report_json | null fresh, otherwise exact ordered JSON.stringify(effect.rpoReport) |
| auth_review_ref | null |
| activation_plan_hash | null |
| activation_approval_ref | null |
| status | prepared |
| created_at | reservedAt |
| verified_at | null |
| activated_at | null |
| activation_ref | null |
| failure_code | null |

Explicit new rowid is allocated under §4 in addition to these named columns;
existing implementation's implicit allocation is not reused. No new actor columns
are invented in the historical table: persisted actor pair belongs in phase intent.

Set im_center_state singleton: center_epoch=newEpoch, recovery_counter=effect
counter, status=prepared, activation_ref=null, recovery_run_id=runId,
updated_at=reservedAt. Set write_mode=paused; DELETE all actual receiver leases.
Clock singleton becomes reservedAt in the same transaction. Require exactly one
center/settings/clock singleton, and full projected deletion/cardinality checks.

Snapshot additionally inserts one im_center_epochs row with approved newEpoch,
creation reservedAt, reason `recovery`, new recoveryCounter; inserts new progress
for each actual predecessor recipient/stream. Compute the maximum contiguous
genuine ACK prefix by seq starting at 1, stopping at first gap or null acked_at;
do not use an expiry receipt or lagging cursor. Progress values are recipient,
newEpoch, original streamEpoch, that prefix, updatedAt=reservedAt, with explicit
rowids/order from §4. Reject existing new epoch/progress keys. Actual old value
mapping and algorithm are at recovery-candidate lines 552-559.

Snapshot deletes **maintenance HEAD ONLY**, zero or one singleton, atomically with
epoch change. Preserve all anchor history and global generation, sole original
conversion transition, old epochs, business rows, lease request history, send keys/
mappings, ACK/read history and original P1 facts. Fresh/import do not invent a
snapshot epoch/progress transition or second conversion. Full exact5 validation,
integrity/FK and projected digest are required before commit. The old code at
lines 569-572 validates v4 and has no head deletion; it is mapping evidence, not
an already suitable target5 executor.

### 7.4 Verify effect and projection

| Field | Type / requirement |
| --- | --- |
| preparePlanHash | H; actual persisted prepare plan |
| prepareResultHash | H; exact complete predecessor prepare result |

Only change clock to reservedAt; this run prepared->verified and
verified_at=reservedAt; center prepared->verified and updated_at=reservedAt.
Exactly one matched run and center row; keep write mode paused, all other columns,
rows/rowids and history unchanged. Old corresponding transitions are at
recovery-candidate lines 528-529. Verify result is followed by a bound seal2;
neither old v4 seal nor a mode-only observation can substitute.

### 7.5 Activate effect and projection

| Field | Type / requirement |
| --- | --- |
| preparePlanHash | H |
| prepareResultHash | H |
| verifyResultHash | H |
| sealHash | H; exact predecessor seal2 |
| authReviewRef | R; actual persisted plan binding |
| isolationAckRef | R?; route-correlated, null fresh only |
| activationRef | R; actual persisted plan binding |

Only change clock to reservedAt; matched verified run becomes active with
auth_review_ref=effect.authReviewRef, activation_plan_hash=intent.planHash,
activation_approval_ref=intent.approvalRef, activation_ref=effect.activationRef,
activated_at=reservedAt. Matched center becomes active with that activation_ref
and updated_at=reservedAt. Preserve verified_at and all other run facts.

Insert exactly one audit row with explicit id=rowid from §4:
actor_kind=`system`, actor_id=runId, action=`recovery.activate`,
target_ids_json=`JSON.stringify([runId])`, occurred_at=reservedAt,
safe_details_json=`JSON.stringify({activationPlanHash:intent.planHash})`.
Actual old mapping is recovery-candidate lines 520-526, with checks at 533-535.
Mode stays **PAUSED** even when center state is active; no listener, enabled writes,
maintenance authority/session or operational time owner is created.

## 8. Mode-first classification and settled-state requirement

Dispatch executionMode **before** comparing digests:

| Mode / actual settled state | phaseObservation.classification | Meaning |
| --- | --- | --- |
| observe-noop, pause already paused, before=after and actual equals both | noop-matched | No transaction happened; result outcome observed-noop, never a COMMIT claim |
| transaction, actual equals expected before | initial | Retry only same intent with freshness/current applicable mutation authorization |
| transaction, actual equals expected after | committed | Recognizable fixed transaction post-state; completion still requires §10 authority and §9 durability |
| Either mode, unexplained actual state/chain | indeterminate | Preserve/refuse; no hash adoption or repair |

observe-noop is allowed **only** for already-paused native/converted pause.
No candidate writable open/transaction, beforeStateDigest=afterStateDigest,
clock unchanged. An explicit authorized completion can finish this no-op after
expiry and reestablish candidate/evidence durability, but calls it observed-noop.
Enabled pause uses transaction and changes mode only. Every transaction phase
requires different before/after digests; prepare/verify/activate never borrow
the no-op branch even if a caller claims nothing needs changing.

Recognize pre/post only after settled closure: if an owned transaction remains
active, confirmed rollback is required, followed by a successful close ledger for
all owned connections. Then verify protected file identity, DELETE header and no
WAL/SHM/journal (including unknown residue). Unknown sidecars, unresolved close or
unconfirmed transaction state are indeterminate. No automatic journal recovery,
checkpoint/cleanup or immutable-candidate bypass to force a recognizable state.
An exception is not proof of rollback or commit. Only after settled close may
the operation classify actual pre/post against immutable-baseline replay.

On first phase admission require exact predecessor file hash and logical digest.
After intent exists, confirmed rollback can leave different physical bytes with
the exact logical pre-state; that permits only the **same intent** retry, not a
new intent, fresh seal or altered initialFileHash. First activation requires seal
file hash and logical match **before** intent; subsequent same-intent logical
prestate follows this rollback rule. Expired prestate is stale, never automatic
reseal/new activation plan. Exact poststate can reconcile after expiry.

## 9. Fixed transaction sequence and completion durability

For transaction mode, durable immutable intent precedes writable candidate open.
Use one owned connection and one `BEGIN IMMEDIATE`, foreign_keys ON,
synchronous FULL, DELETE journal mode and busy_timeout=0. This is an already
validated standalone DELETE candidate, not permission to normalize unknown state.

Recheck actual before-state/identity in the transaction, apply only the fixed
phase projection (clock and business atomically except pause's unchanged clock),
then full exact5/integrity/FK checks and exact independently predicted post-digest.
Recheck current authority, budget and pre-COMMIT freshness immediately before
COMMIT. Do not write later freshness samples or retain high-water outside that
transaction. On throw, settle owned transaction/connection and classify under §8;
never rerun a transaction simply because external result publication failed.

Explicit completion, including already-visible result retry:

```text
current authorization
 -> immutable baseline + bounded replay + actual full5/projected state
 -> close all readers and verify settled protected standalone identity
 -> candidate file and directory sync
 -> actual closed file hash
 -> publish no-replace / exact-resync phaseResult
 -> final identity, baseline/source, authority and budget checks
```

Observe-noop follows this candidate/evidence durability sequence without writable
candidate open/transaction. Result binds exact reserved phaseAt and actual synced
file hash. Visible result or handoff metadata alone never proves durability.
Retain uncertain publication and refuse success; exact retry validates/resyncs,
never overwrites conflicting results or deletes unknown pending files. Do not
fsync/close a raw descriptor on the held coordination inode.

## 10. Mutation authorization versus completion-only reconciliation

Pause/verify intents have null approvalRef/executorId/approverId and require current
admin/source/isolation/closure checks. Prepare/activate have captured distinct
resolved actors and independent mutation approval under accepted C2-B1. Persist
the pair once in the intent; no retry identity replacement. Release remains a
separate independently authorized operation.

New trusted **completion-only** protocol:

```text
approvalAuthority.authorizeRecoveryV5Reconciliation(binding, ctx) -> literal true
```

Exact binding order:

| Field | Type / binding |
| --- | --- |
| kind | Literal reconcile-v5 |
| phase | pause, prepare, verify or activate |
| runId | U |
| intentHash | H |
| planHash | H |
| outcome | observed-noop or committed |
| approvalRef | R?; persisted intent value |
| executorId | R?; persisted intent value |
| approverId | R?; persisted intent value |
| instanceId | U |
| instanceCreatedAt | N |
| sourceSchemaVersion | Required null, 3, 4 or 5; original-source pair |
| sourceSchemaChecksum | H?; exact correlated checksum |
| targetSchemaVersion | Literal 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |

Strict synchronous adapter, exact own-data binding; no Proxy/accessor/symbol,
Promise/thenable/truthy non-true acceptance. Current policy **may deny** a revoked
historical actor or caller even when exact committed state is internally
recognizable. Pause/verify persisted actors remain null. Never resolve replacement
historical actors, ask for new mutation approval to bless an old commit, or use a
hash match as permission to disclose/complete. Current admin/source/isolation/
closure and reconciliation policy apply before successful completion and at final
checks. Internal recognition is not authorization.

| Phase / state | Fresh mutation path | Completion-only path |
| --- | --- | --- |
| Pause enabled, exact prestate | Same intent, unexpired plan, current admin/source/isolation/closure; no independent mutation actor pair | Exact committed mode change may complete after expiry with current checks + reconciliation |
| Pause already paused, observe-noop | New intent reservation must be fresh; no candidate transaction | noop-matched may complete after expiry with current checks + reconciliation; observed-noop outcome |
| Prepare exact prestate | Same persisted distinct pair, current independent mutation authorization and freshness | Exact poststate expiry-exempt, current checks + reconciliation using retained actors |
| Verify exact prestate | Same intent and freshness, current checks, actors remain null | Exact poststate expiry-exempt, current checks + reconciliation; seal bindings still required |
| Activate exact prestate | First seal-byte/digest check before intent; same-intent retry fresh and current independent approval for same pair | Exact poststate expiry-exempt with current checks + reconciliation; no obsolete seal reuse for new mutation |
| Any exact prestate after expiry | RECOVERY_PLAN_STALE; preserve evidence, no renewal/replan | Cannot call initial transaction state committed to bypass expiry |
| Indeterminate / unsettled | No mutation/reconciliation adoption | Refuse, preserve evidence; policy approval cannot manufacture a post-state proof |

Status remains B1 observation-only: no file/directory resync, publication, repair,
clock update or completion. Existing validated coordination housekeeping via
writable SQLite BEGIN IMMEDIATE/ROLLBACK is allowed under
[registry-lock.js](../src/im/registry-lock.js) lines 74-99, without lock creation,
initialization, extra SQL/data changes or committed coordination transaction.
It is not a literal zero-filesystem-write promise. Missing completion reports a
separate explicit retry requirement; complete status/result/disclosure DTOs await
their artifact gate. B2 durability proof is not bypassed with a public skipSync.

## 11. Seal2 ordered record and binding requirements

| Field | Type / binding |
| --- | --- |
| version | Literal 2 |
| runId | U |
| stageHash | H; target5 stage |
| intakeHash | H |
| handoffHash | H?; null native |
| preparePlanHash | H |
| verifyIntentHash | H |
| verifyResultHash | H |
| candidateReference | Exact route path |
| instanceId | U |
| instanceCreatedAt | N |
| sourceSchemaVersion | Required null, 3, 4 or 5 |
| sourceSchemaChecksum | H?; exact correlated original checksum |
| targetSchemaVersion | Literal 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| newEpoch | U; actual approved prepared epoch |
| recoveryCounter | N; actual approved counter |
| candidateFileHash | H; verified phaseResult file hash |
| stateDigest | H; verified phaseResult digest |
| verifiedAt | N; verify reservedAt / result.phaseAt |
| writeMode | Literal paused |
| verification | Exact ordered integrity, foreignKeys, schema, invariants; each literal true |

Reference: `v5-runs/<runId>/seals/<sealHash>`, with new-domain seal hash; no suffix
is added to this supplied reference.
Seal binds actual full verification and completed verify result, identity/intake/
stage/source-target/epoch/counter and exact closed candidate. Pure booleans alone
do not certify verification. Exact seal binding bundle, issuance/durability and
later activation comparisons still require artifact review. No old seal reuse or
hash regeneration to conceal changed bytes. §8 same-intent rollback allowance is
not a general permission to issue a new seal over changed candidate bytes.

## 12. Release and preserved ownership boundaries

Future release validates the actual new-family active-but-PAUSED terminal chain,
original source/closure and genuine hold/binding. Converted registered hold keeps
historical hold.stageHash forever, while prepare binding may bind the new prepare
plan hash under it. Native hold binds genuine new stage. New target5 stageHash in
phase records does not rewrite either historical hold or conversion chain.

Retain the C0 publisher input concept exactly
`{stateEvidenceHash,minimumReleasedAt}`. Actual spelling/chronology is in
[backup-registry.js](../src/im/v2/backup-registry.js) lines 498-523: release time
meets both boundAt and terminal minimum. New terminal evidence/hash/result bundles
are pending; phaseResult alone is not invented activationCompletion or terminal
capability. Existing target4 native5 release guard at lines 493-496 remains unchanged.
Release needs its own independent approval, not reconciliation or old conversion
approval. Source missing after release remains unsupported; cleanup stays false.
No backup deletion, automatic release, operational time/session, write enablement
or listener follows from active recovery state.

## 13. Four counterexamples and their central closures

| Counterexample | Required closure / limitation |
| --- | --- |
| Ordinary guard anchors, business fails, clock-only bytes survive and are adopted as acceptable monotonic drift | Private executor reserves once; clock/business atomic with intent before writable open; settled pre/post replay only; unknown clock delta indeterminate, old guard excluded |
| Paused pause has before=after and a digest-first reader calls it committed | Dispatch executionMode first; observe-noop only paused pause, no writable open/transaction, classification noop-matched and outcome observed-noop; explicit completion establishes durability without claiming COMMIT |
| Modified live candidate becomes the oracle, or implicit rowid allocation makes replay match by adopting actual maxima | Authenticate immutable B2 artifact/C2-A archive; independent streaming virtual replay, explicit signed64 predecessor-derived rowids and conflict/cardinality checks; actual hash never expected output; missing baseline refuses |
| Exact expired poststate is either remutated under a new actor or accepted solely because hashes match, despite revocation | Completion-only reconciliation policy with persisted actors/current authority may deny; exact preexpired remains stale with no automatic replan, exact post/noop completion may be expiry-exempt; recognition never grants disclosure |

Limits remain: literal manifest/framing and complete binding artifacts pending;
size-admissible workloads can exhaust the existing elapsed budget; native calls
are not hard interruptible; settled-close uncertainty remains indeterminate;
unknown pending files preserved; no five-second reservation or automatic manual
replan mechanism. This document closes conceptual protocol choices, not these
artifact gaps or runtime validation obligations.

## 14. Remaining artifact gate and explicit unresolved contradictions

| Required artifact before implementation | Still-required complete decision |
| --- | --- |
| Literal manifest and frame specifics | Exact V5 tables/columns/types/DDL/autoindexes/object inventory, scalar/null/rowid/tableEnd framing, independent byte examples; read-only extraction and independent review pending |
| Stage/locator/copy/normalization/predecessor links/phase plans | Exact native/converted field sets, persisted plan TTL and identity, initial file/hash links and normalization result; resolve native normalization versus older intake-only pause predecessor union |
| Complete binding bundles | Exhaustive ordered validator inputs/nullability/equality/chronology for intent/result/observation/effect/baseline/seal and all routes; no ready codec exports until accepted |
| Activation completion/release/status/eight DTOs | Actual new terminal chain/publisher/minimum time, exact status/unknown-fact nulls/errors and all operation inputs/results/factory; not inferred from these core records |
| Inventories/goldens | Every phase's required/forbidden/pending files, exact publication/retry boundaries, independent canonical/hash/digest fixtures and historical regressions |

Real differences are explicit rather than silently normalized:

- Old prepare/verify/activate use ordinary guard and implicit rowid insertion;
  new executor requires atomic reserved clock and explicit rowids. Old source is
  behavioral field mapping, not implementation that already satisfies this design.
- Native pause must follow normalization, whereas an earlier intake-only link
  omitted it; exact predecessor enum/hash remains unresolved.
- Supplied digest tag vocabulary leaves nullable metadata and several payload
  spellings unspecified; no literal digest or manifest is frozen here.
- phaseObservation's unreadable/indeterminate actual-fact handling still needs
  exact nullable/throw rules; do not fabricate successful observation metadata.

Next: **parent independent central-document review -> literal and remaining
binding/API/inventory artifact gate -> accepted complete required contracts ->
S3 -> H4 -> Q5**. No source or pure codec work starts from incomplete bindings.
C2-A/B1 stay accepted unchanged; whole C2 remains IN_PROGRESS, S3/H4 NOT READY.
Operational ownership/time, later writer/fault/production gates remain separate.

## 15. Document-only validation and bounded handoff

This lane owns faithful complete central-protocol transcription and local document
consistency checks. Validate strict UTF-8/no BOM, final newline, balanced fences,
relative links, whitespace, exact core/effect/baseline/seal/authority field orders,
actual historical mutation mapping and untouched accepted contracts. Parent owns
independent review and subsequent artifact acceptance; no runtime PASS is claimed.

Writes only this new document and the current remaining C2-B ledger subitem;
preserve all other plan bytes/history/order. No code/tests/other docs/config/deps,
runtime probes, DB/services, install, commit or push. No literal-manifest expansion
in this lane. Document hashes identify pending-review text only, not executed
recovery, durability, power-loss or production evidence.
