# P6 schema 5 and maintenance time contract (NONRELEASE)

**Oracle-approved P6-B0 specification; B0 unimplemented; no runtime acceptance.**
Reconciliation HEAD: `65d0727cde532f6909a5166c5028b3998e54d6a7`.
This records the additive center-schema decision and its compatibility gates.
It authorizes no production migration, enablement or deletion.

Read with the [maintenance handoff](im-v2-maintenance-contract.md),
[original schema/retention design](im-recovery-retention-v2-design.md),
[v4 schema exports](../src/im/v2/schema.js),
[v4 DDL/validator](../src/im/v2/schema-internal.js),
[config](../src/im/v2/config.js),
[recovery storage contract](im-v2-recovery-storage-contract.md), and
[recovery activation contract](im-v2-recovery-activation-contract.md).
The completed [P6-A plan/codec contract](im-v2-maintenance-plan-contract.md) is
design-approved with the Oracle amendments: offline borrowed-connection v4
preview, pure codec, and configuration-only backup diagnostic. Implementation
and runtime acceptance are separate evidence. This reconciliation freezes the
v5 anchor/conversion records below; the new versioned recovery family remains a
later compatibility gate. Neither specification grants execution authority.

## 1. Version decision and implementation boundary

- Center schema **5** is an additive, explicit migration from validated schema
  4. Historical schemas 1–4, their DDL/checksums/goldens, and the exact existing
  `schema.js` exports including `assertImSchemaV4` remain immutable.
- Existing fresh-4 and v3-import-to-4 APIs remain unchanged. Legacy center 3,
  wire `a2a-msg.im.v2` and client journal 2 keep their versions and semantics.
- **B0.1: storage, strict pure codecs and bounded validators only.** Future files
  are `src/im/v2/schema-v5-internal.js`, `src/im/v2/schema-v5.js`,
  `src/im/v2/schema-dispatch.js` and `src/im/v2/maintenance-v5-records.js`, plus
  narrow mechanical extraction of inherited business validation into a shared
  internal helper. No converter or time-service exports belong to B0.1.
- **B0.2:** candidate converter only after a genuine private recovery ownership
  bridge. **B0.3:** time authority only after a separately branded owned-v5 target
  seam. Their interfaces below are specifications, not B0.1 implementation scope.
  No implementation files are created by this document handoff.
- The center dispatcher accepts **only fully validated** `(4,V4_CHECKSUM)` or
  `(5,V5_CHECKSUM)` pairs. `V5_CHECKSUM` is a symbolic name: generate it from the
  reviewed exact new manifest and freeze golden bytes; no literal hash has yet
  been approved. Marker-only acceptance and a global `4 -> 5` replacement are
  forbidden. Source-specific historical v3 validation remains explicit.
- P6-A starts with read-only v4 preview and nonexecutable
  `SCHEMA_UPGRADE_REQUIRED` time evidence. No converter is exposed for rollout
  until runtime, backup/registry/recovery and time gates below are validated.

## 2. Approved additive schema

Use the existing strict type conventions: `U` is canonical lowercase UUID
TEXT; `H` is 64 lowercase hex TEXT; `N` is INTEGER with `typeof='integer'` and
range `0..9007199254740991`; `N+` starts at 1. `Ref` is TEXT length 1..255 with
the existing SQL type/length checks and service rejection of control characters.
The existing `B` convention is strict INTEGER 0/1; these new tables need no
boolean column. All columns are **NOT NULL** except those explicitly marked `?`.
Checks must not accidentally accept NULL through SQL three-valued logic.
Existing UUID/hash/type checks must be expanded into reviewed exact DDL bytes.

### 2.1 `im_maintenance_time_anchors`

| Column, in the frozen table order | Type / constraint |
| --- | --- |
| `generation` | `N+`, PRIMARY KEY |
| `center_epoch` | `U`, FK `im_center_epochs(center_epoch)` |
| `previous_generation` | `N+?`, self-FK to `generation` |
| `previous_anchor_hash` | `H?` |
| `proposal_hash` | `H`, UNIQUE |
| `anchor_hash` | `H`, UNIQUE |
| `session_nonce` | `U`, UNIQUE |
| `proposed_at` | `N` |
| `proposal_expires_at` | `N` |
| `candidate_wall_at` | `N` |
| `accept_not_before` | `N` |
| `accept_not_after` | `N` |
| `accepted_wall_at` | `N` |
| `global_floor_observed_at` | `N` |
| `global_floor_at_approval` | `N` |
| `max_forward_jump_ms` | INTEGER, strict integer range `1..86400000` |
| `approval_ref` | `Ref` |
| `executor_id` | `Ref` |
| `approver_id` | `Ref` |

Required table constraints:

- Previous generation/hash are either both NULL or both non-NULL; when present,
  `previous_generation < generation`.
- `proposed_at = candidate_wall_at` and `accept_not_before = candidate_wall_at`.
- `0 < proposal_expires_at - proposed_at <= 300000`.
- `0 < accept_not_after - accept_not_before <= 5000`.
- `accept_not_before <= accepted_wall_at <= accept_not_after` and
  `accepted_wall_at < proposal_expires_at` (window inclusive, expiry strict).
- `global_floor_at_approval >= global_floor_observed_at` and
  `accepted_wall_at >= global_floor_at_approval`.
- `executor_id <> approver_id`.
- `UNIQUE(center_epoch,generation,anchor_hash)`.

The full validator reconstructs the original proposal, including its stored
`global_floor_observed_at`, and verifies `proposal_hash`; the approval floor or
current floor cannot substitute for the observed floor. It reconstructs anchor
evidence using actual instance identity and verifies every `anchor_hash`.

History is **one database-wide contiguous chain**: first generation 1 has paired
NULL predecessor fields; each later generation is exactly previous generation
plus 1 with the exact preceding anchor hash. Accepted wall time is nondecreasing.
Reject safe-integer overflow when allocating the next generation. Cross-epoch
predecessors are allowed and generations never reset. A self-FK alone does not
prove any of these properties. Retain history through recovery and maintenance;
ordinary audit expiry and maintenance-run cleanup never remove it.

### 2.2 `im_maintenance_time_head`

| Column | Type / constraint |
| --- | --- |
| `singleton` | INTEGER PRIMARY KEY, strict integer, CHECK `singleton=1` |
| `center_epoch` | `U`, FK `im_center_epochs(center_epoch)` |
| `generation` | `N+` |
| `anchor_hash` | `H` |

Composite FK `(center_epoch,generation,anchor_hash)` references the identical
unique triple in `im_maintenance_time_anchors`. The optional head must reference
the **chain tip** and actual current center epoch. Empty history requires no
head; retained history without a head is valid after recovery. A
stale-epoch head is corruption, not an automatic repair opportunity. **No row
means unanchored**; do not synthesize a head from history or `im_clock`. Future
recovery's epoch transaction deletes the head only, atomically with the epoch
change, preserves history and revokes the private process session. Create index
`im_maintenance_time_epoch ON im_maintenance_time_anchors(center_epoch,generation)`.

### 2.3 `im_center_schema_transitions`

| Column | Type / constraint |
| --- | --- |
| `transition_id` | `U`, PRIMARY KEY |
| `from_version` | INTEGER, strict integer, CHECK `=4` |
| `to_version` | INTEGER, strict integer, CHECK `=5` |
| `instance_id` | `U` |
| `instance_created_at` | `N` |
| `center_epoch` | `U`, FK `im_center_epochs(center_epoch)` |
| `from_checksum` | `H` |
| `to_checksum` | `H` |
| `recovery_run_id` | `U`; deliberately no FK to `im_recovery_runs` before prepare |
| `stage_hash` | `H` |
| `candidate_reference` | `Ref`, derived from `recovery_run_id` |
| `candidate_kind` | strict TEXT enum `fresh_bootstrap`, `v3_import`, `snapshot_recovery` |
| `preparation_ref` | `Ref?`, FK `im_schema_preparations(preparation_ref)` |
| `source_evidence_hash` | `H?` |
| `preconversion_file_hash` | `H` |
| `execution_policy_hash` | `H`, FK `im_retention_policies(policy_hash)` |
| `plan_created_at` | `N` |
| `plan_expires_at` | `N` |
| `approver_id` | `Ref` |
| `approved_plan_hash` | `H`, UNIQUE |
| `approval_ref` | `Ref` |
| `executor_id` | `Ref` |
| `converted_at` | `N` |

The added typed columns are immediately after `to_checksum`; all inherited
transition columns retain their relative order. Required checks: fresh bootstrap
has non-NULL preparation and NULL source evidence; v3 import has both non-NULL;
snapshot recovery has NULL preparation and non-NULL source evidence.
`0 < plan_expires_at - plan_created_at <= 300000`,
`plan_created_at <= converted_at < plan_expires_at`, and executor differs from
approver. `candidate_reference` equals
`runs/${recovery_run_id}/candidate.sqlite`, a derived logical reference, never an
arbitrary filesystem path. Preparation kind/identity/epoch and registered policy
bindings are checked against the retained facts, not merely nullable FKs.

The full v5 validator requires **exactly one** 4-to-5 transition with actual
instance ID/creation time and exact V4/V5 checksums. It reconstructs the approved
plan/hash and conversion proof from typed row facts and verifies identity,
epoch, preparation and policy bindings. Its epoch is the conversion epoch,
which remains in epoch history; later recovery need not keep it current.
Restoring an already-v5 snapshot retains the original conversion proof and adds
no second transition. The new workflow run ID is not a recovery-run FK because
the conversion precedes that workflow's prepare. No postconversion file hash
is stored in the DB: doing so would create a self-hash cycle.

Schema 5 retains every v4 business table, including `im_maintenance_runs`,
unchanged; no anchor is
hidden in JSON and no historical action/enum is repurposed. Replace only the
schema-marker definition for the new version: the schema-5 form of `im_schema`
has the version-5 check and new manifest checksum; the historical v4 definition
and hash are not edited.

### 2.4 B0.1 validator composition and budgets

`schema-v5.js` exports **only** `IM_V5_SCHEMA_VERSION = 5` and
`assertImSchemaV5(db)`, returning `undefined` on success. `schema-dispatch.js`
exports `assertSupportedImV2Center(db)`, returning frozen
`{schemaVersion,schemaChecksum}` only after full validation of exact 4 or 5.
Internal `assertImSchemaV5Internal(db,budget)` accepts a trusted composition
budget, not caller authority or a bypass. Preserve `schema.js`'s exact three
exports (`IM_V2_SCHEMA_VERSION`, `SUPPORTED_IM_V2_SCHEMA_VERSIONS`,
`assertImSchemaV4`), v4-only entrypoint, marker and manifest checks.

Mechanically extract inherited business checks **after** v4-specific manifest
and budget selection. Each version verifies its own exact schema and selects
its own budget, then runs shared inherited validation; v5 additionally validates
its metadata. Never rewrite marker 5 to 4 for validation or validate a modified
DB copy. Historical DDL, checksums and fresh4/v3-to-4 behavior remain byte-exact.

Retain inherited ceilings: `maxMessages=10000`,
`maxVerifiedContentBytes=104857600`, `maxOtherRecords=10000`,
`maxElapsedMs=10000`. Add `maxMaintenanceAnchors=10000` and
`maxMaintenanceMetadataBytes=10485760`, lower-only. Use capped count probes
(`limit+1`) and length projections before fetching SQL or variable metadata;
reserve/check bytes before retrieval, including new table metadata and evidence.
Perform one generation-ordered chain pass. All stages share the same elapsed
budget; nested validation must not reset its start. SQLite native calls are
soft-budgeted between calls, not promised interruptible. Fixed safe errors are
`IM_SCHEMA_MISMATCH` and `IM_V2_BUDGET_EXCEEDED`; no SQL, row data or native error
details leak through them.

## 3. Explicit conversion and route matrix

Conversion is supported only for an **exclusive, paused, owned recovery or
bootstrap candidate before its new prepare plan**. In-place conversion of a
running active target, sealed candidate or existing prepared/activation workflow
is unsupported. Candidate handling of a snapshot follows its dedicated new
route; this does not grant live-source conversion permission.

First validate exact v4, actual identity/epoch, approved conversion plan and
preconversion evidence. In **one transaction**, create the new tables/index,
replace only the marker definition, insert the transition proof, install marker
5/checksum, then perform full v5 validation before commit. Preserve business
rows, identity, epoch, policy and paused write mode. Create **no anchor or head**.
A crash leaves a complete v4 or complete v5, never a partial committed upgrade.
The API/record/retry contract below is frozen for B0.2; its private ownership
bridge and implementation evidence remain prerequisites.

| Requested route | Approved behavior |
| --- | --- |
| Existing fresh 4 / v3 import 4 | Existing P1 APIs and behavior unchanged |
| Opt-in fresh 5 / v3 import 5 | P1 produces 4, then separately approved explicit candidate conversion |
| v4 snapshot targeting 4 | Existing route and old canonical records unchanged |
| v4 snapshot explicitly targeting 5 | Copy, normalize and pause candidate, then convert **before** the new versioned prepare plan |
| v5 snapshot targeting 5 | Future explicitly versioned route; retain original conversion proof, no second conversion row |
| v5 targeting 4 | Refuse; no downgrade |

Old seals are never updated or reused across conversion. Conversion evidence
must bind pre/post phases; it cannot relabel an old file hash or seal as v5.
Closed-v3 and registered-v3 bridge behavior stays on its existing route unless
an explicit target-5 workflow subsequently converts the owned v4 candidate.

### 3.1 B0.2 private bridge and converter (not B0.1)

Only genuine new-workflow source/workspace/candidate ownership may privately
mint the converter's branded target. Verify paused mode; no **new workflow**
prepare, seal or activation; actual closed-file prehash, identity, single-link
file (`nlink=1`), stage, source and preparation bindings. A snapshot's inherited
old active recovery row is not the current workflow being active. No arbitrary
path, DB connection or caller stage object is an ownership authorizer.

```text
createCandidateSchemaV5Converter({target,authority,approvalAuthority,executorId,limits})
  -> frozen {previewConversion,convertCandidate}
previewConversion({},ctx) -> {plan,planHash}
convertCandidate({transitionId,planHash,approvalRef},ctx)
  -> {transitionId,planHash,conversionProofHash,schemaVersion:5,schemaChecksum,replayed}
```

The target's protected publication owns the plan, with an internally generated
transition ID generated once for that plan. No caller replacement plan is
accepted. Require synchronous literal-true admin authority before disclosure,
literal-true independent approval and distinct trusted executor/approver before
conversion and at final transaction checks. Verify the exact approved plan and
locked actual bindings. One owned transaction creates tables/index, replaces
only the marker definition/row and inserts the typed transition; full v5
validation precedes commit. Preserve every business/identity/epoch/policy/paused
fact and leave anchor/head empty. Roll back only a transaction owned here.

An accurate v5 retry verifies the original transition and plan rather than
redoing conversion or changing time. **Every explicit retry** redoes the required
closed-file and directory synchronization and exact completion publication or
resynchronization. Missing/uncertain completion is repairable from accurate DB
evidence only; conflicting proof/publication is never overwritten. External
`conversionComplete` binds the closed postconversion file without a new timestamp.
Retain the local `MAINTENANCE_*` error vocabulary in §4.3 and add fixed
`MAINTENANCE_CONVERSION_CONFLICT` and `MAINTENANCE_DURABILITY_UNCERTAIN`.
No provider/native exception text, SQL, paths or records appear in errors.

## 4. Time administration and proposal encoding

### 4.1 B0.3 time authority boundary (not B0.1)

The internal synchronous factory and operations are approved:

```text
createMaintenanceTimeAuthority({target,authority,approvalAuthority,executorId,limits})
  -> frozen {previewMaintenanceTimeAnchor,approveMaintenanceTimeAnchor,getMaintenanceTimeStatus}
previewMaintenanceTimeAnchor({},ctx)
  -> {proposal,proposalHash}
approveMaintenanceTimeAnchor({proposal,proposalHash,approvalRef},ctx)
  -> {anchor,anchorHash,replayed,sessionEstablished}
getMaintenanceTimeStatus({},ctx)
  -> {version:1,instanceId,instanceCreatedAt,centerEpoch,headGeneration,headHash,sessionPresent,reason}
```

All require literal-true synchronous admin authority before disclosure. The
independent approval adapter must also synchronously return literal `true` and
is separately bound to actual DB/instance/epoch, history tip and current head,
current process nonce and exact proposal/hash; executor and independent approver
must differ.
No deletion approval substitutes for it. The maintenance handoff's strict
snapshot, async/thenable denial and capability-lifetime rules apply.

The target must be a separately branded genuine **owned-v5 private capability**,
not the P6-A read-only target. Composition remains test-only until rollout gates
pass. Wall time is native `Date.now()` and monotonic time is native
`process.hrtime.bigint()`; injection is private test composition only, with no
operation-level adapter. Each proposal has a freshly generated nonce registered
by the current authority generation. Decoding/replaying caller proposal bytes
cannot register a nonce or establish authority.

Status fields have exactly the order shown. `headGeneration`/`headHash` are
paired null or the actual head; `sessionPresent` is boolean and `reason` is null,
`TIME_ANCHOR_REQUIRED` (no head), or `PROCESS_REANCHOR_REQUIRED` (head but no
valid private session). Status does not observe time, write or restore a session.
Callback faults latch before classification; even a swallowed callback fault
poisons success. Perform the final poison check after callback cleanup.

### 4.2 B0.1 pure records and canonical field order

`maintenance-v5-records.js` has **exactly three exports**:

```text
encodeMaintenanceV5Record(kind,value)
decodeMaintenanceV5Record(kind,bytes)
hashMaintenanceV5Record(kind,value)
```

Exactly five kinds are accepted: `timeProposal`, `anchorEvidence`,
`conversionPlan`, `conversionProof`, `conversionComplete`. Encoding constructs
the frozen field order from strict ordinary data objects; decoding requires
byte-identical canonical re-encoding. Use strict canonical UTF-8 (no BOM,
formatting whitespace or trailing newline), exact field sets, no duplicate
keys, unsafe integers, raw filesystem paths, JSON extensions or coercions.
Each complete record, including a nested plan, is at most **65536 UTF-8 bytes**.
Version is literal 1 for all five kinds. U/H/N/N+/Ref rules in §2 apply; strict
nullability and cross-field shape checks below are part of the pure codec.
DB identity/checksum/chain/ownership crossbindings belong to full validators and
services: successful pure encoding never confers authority.

Proposal field order is exact:

```text
version, instanceId, instanceCreatedAt, centerEpoch,
previousGeneration, previousAnchorHash, sessionNonce, proposedAt,
proposalExpiresAt, candidateWallAt, acceptNotBefore, acceptNotAfter,
globalFloorObservedAt, maxForwardJumpMs
```

`version=1`; identity/epoch/nonce use `U`, hashes use `H`, time values use `N`,
generation is `N+` or null. Previous generation/hash are paired null or paired
values from the **history tip, not necessarily the head**. `sessionNonce` is
internally generated and registered with the current authority generation.
`maxForwardJumpMs` is `1..86400000`, lower-only.
Proposal TTL is positive and at most **300000 ms**. The approval window is
positive and lower-only, at most **5000 ms** wide: `candidateWallAt` is the actual trusted
wall sample, `proposedAt=candidateWallAt`, `acceptNotBefore=candidateWallAt`, and
`acceptNotAfter=candidateWallAt+windowMs`, with safe addition and no clamping.
Preview is read-only; it does not establish an accepted baseline or ratchet
private highwater/global floor. These proposal fields are evidence, not authority.

`anchorEvidence` order is exact:

```text
version, instanceId, instanceCreatedAt, generation, centerEpoch,
previousGeneration, previousAnchorHash, proposalHash, sessionNonce, proposedAt,
proposalExpiresAt, candidateWallAt, acceptNotBefore, acceptNotAfter,
acceptedWallAt, globalFloorObservedAt, globalFloorAtApproval, maxForwardJumpMs,
approvalRef, executorId, approverId
```

It includes every anchor row fact except `anchor_hash`, plus actual instance
identity. CamelCase maps directly to the corresponding snake_case column;
`instanceCreatedAt` comes from identity `created_at`. Reconstruct `timeProposal`
by its frozen field order and verify `proposalHash`; never replace its observed
floor with the approval/current floor. Enforce §2.1 time/actor/predecessor rules.

`conversionPlan` order is exact:

```text
version, transitionId, instanceId, instanceCreatedAt, centerEpoch, recoveryRunId,
stageHash, candidateReference, candidateKind, preparationRef, sourceEvidenceHash,
fromVersion, fromChecksum, toVersion, toChecksum, preconversionFileHash,
executionPolicyHash, createdAt, expiresAt
```

`fromVersion=4`, `toVersion=5`; hashes are H, IDs are U except `preparationRef`
and `candidateReference` (Ref), times N, and candidate kind/nullability follow
§2.3. `candidateReference` is exactly `runs/${recoveryRunId}/candidate.sqlite`.
`createdAt`/`expiresAt` map to `plan_created_at`/`plan_expires_at`; TTL is positive
and at most 300000 ms. Full validation requires exact manifest checksums.

`conversionProof` order is exact:

```text
version, plan, planHash, approvalRef, executorId, approverId, convertedAt
```

`plan` is a strict nested `conversionPlan`; `planHash` must equal its canonical
hash and maps to `approved_plan_hash`. Actors/approval are Ref, actors differ,
and N `convertedAt` satisfies `plan.createdAt <= convertedAt < plan.expiresAt`.
Every proof fact is reconstructible from the one typed transition row; no JSON
extension column or separate in-DB proof hash is required.

`conversionComplete` order is exact:

```text
version, transitionId, planHash, conversionProofHash, instanceId,
instanceCreatedAt, centerEpoch, recoveryRunId, stageHash, candidateReference,
schemaVersion, schemaChecksum, preconversionFileHash, postconversionFileHash
```

`schemaVersion=5`; IDs U, hashes H, creation time N, and derived candidate Ref
as above. This is external closed-file evidence only, with **no additional
timestamp**. Full verification binds all common plan/proof/identity/checksum
facts and the actual closed file. Storing `postconversionFileHash` in the DB is
forbidden because it would alter its own preimage.

All hashes are lowercase SHA-256 hex of the exact UTF-8 domain prefix followed
by canonical record bytes, with the explicit newline shown below:

```text
proposalHash = SHA256(UTF8("im-maintenance-time-proposal-v1\n") || canonicalProposalBytes)
anchorHash   = SHA256(UTF8("im-maintenance-time-anchor-v1\n") || canonicalAnchorEvidenceBytes)
planHash = SHA256(UTF8("im-center-schema-conversion-plan-v1\n") || canonicalConversionPlanBytes)
conversionProofHash = SHA256(UTF8("im-center-schema-conversion-proof-v1\n") || canonicalConversionProofBytes)
conversionCompleteHash = SHA256(UTF8("im-center-schema-conversion-complete-v1\n") || canonicalConversionCompleteBytes)
```

These domains do not silently change any prior P6-A hash domain. DDL full-byte
hash and schema manifest checksum are generated from the reviewed implementation
later, then independently golden-checked; this document fabricates no constant.

### 4.3 Fixed local maintenance error vocabulary

Retain `MAINTENANCE_INVALID`, `MAINTENANCE_AUTH_DENIED`, `MAINTENANCE_DISABLED`,
`MAINTENANCE_SCHEMA_UNSUPPORTED`, `MAINTENANCE_TARGET_STALE`,
`MAINTENANCE_POLICY_INVALID`, `MAINTENANCE_POLICY_STALE`,
`MAINTENANCE_CLOCK_UNSAFE`, `MAINTENANCE_READ_UNAVAILABLE`,
`MAINTENANCE_FACT_MISMATCH`, `MAINTENANCE_CODEC_INVALID`,
`MAINTENANCE_METADATA_LIMIT`. Add `MAINTENANCE_CONVERSION_CONFLICT` for conflicting
conversion evidence and `MAINTENANCE_DURABILITY_UNCERTAIN` for unacknowledged
durability/publication. Messages are fixed safe literals, not callback/SQL/path
or row data. Pure shape/canonical errors use `MAINTENANCE_CODEC_INVALID` and the
65536-byte ceiling uses `MAINTENANCE_METADATA_LIMIT`; storage validators retain
the two schema errors in §2.4. Time status reasons are not replacement error codes.

## 5. Approval transaction, process baseline and retry

Under the actual DB write lock, verify the previous history tip/hash, head and current
private process nonce, fresh independent approval, executor/approver distinction,
actual wall/monotonic samples, current global floor/private highwater, proposal
window and strict proposal expiry. Perform final authority checks **then** take
the final wall/monotonic pair immediately before the anchor write, rechecking
inclusive window, strict expiry, floor/private highwater and safe arithmetic.
New anchor insertion, head installation and global-floor update are **one atomic
transaction**.

Rejected approval writes **no anchor, head or global floor**. Private highwater
may advance conservatively after an observed sample. Never floor-drop, clamp a
time into the window, or silently accept a different time proposal.

Install the private trusted baseline only after **acknowledged commit**, retaining
the final **precommit monotonic sample** as origin. A postcommit sample would
understate elapsed time during commit/response delay and must not replace it.
In the same private session:

```text
expectedWallNs = BigInt(acceptedWallAt) * 1000000n + elapsedNs
abs(BigInt(now) * 1000000n - expectedWallNs) <= BigInt(maxForwardJumpMs) * 1000000n
now >= actualGlobalFloor AND now >= privateHighwater
```

`elapsedNs` uses native monotonic bigint subtraction from the retained precommit
origin, including commit/response delay; it must not be negative or regress.
Validate wall values and projection/range overflow before reporting
`monotonicElapsedMs = floor(elapsedNs / 1000000n)` as a safe integer. Compare
deviation in nanoseconds before this reporting-only truncation. Use safe
arithmetic, bound at most 86400000 ms, and never regress floor/private highwater.
Ordinary `im_clock` changes never refresh this anchor or its private origin. Runtime
sampling cannot be replaced by an injected caller JSON claim. An uncertain
commit installs no private session.

Restart loses the private baseline: reading historical anchors is diagnostic,
not execution authority. A **new nonce, proposal and independent approval** are
required. Exact completed-approval retry returns immutable persisted evidence,
`replayed:true,sessionEstablished:false`, without a new write, clock call or
generation, and **cannot mint a session**. Read resolution
of an uncertain commit has the same restriction. An already valid private
session is left untouched by retry; without one, reanchor is required. Successful
new acknowledged approval returns `replayed:false,sessionEstablished:true` with
the canonical anchor evidence and hash.

A new recovery epoch atomically deletes only the head in its epoch transaction,
preserves history and revokes the private process session. No old-epoch head or
private session transfers to it; stale-epoch head is corruption. The next anchor
continues the history tip across epochs, never resetting generation. The future
versioned recovery implementation must prove this transaction. Any reanchor
invalidates old maintenance plans bound to the previous anchor.

## 6. Ordered maintenance `timeEvidence`

The field order is approved and shared with the completed P6-A nested codec tables:

```text
version, schemaVersion, observedWallAt, globalFloorObservedAt,
anchorGeneration, anchorHash, sessionNonce, anchorWallAt,
monotonicElapsedMs, maxForwardJumpMs, executable, reason
```

`version=1`, `schemaVersion=4|5`; wall/floor values are `N`, anchor generation is
`N+|null`, anchor hash is `H|null`, session nonce is `U|null`, anchor wall and
elapsed are `N|null`. The lowered maximum is `1..86400000`; `executable` is a
strict JSON boolean. `reason` is exactly null or one of
`SCHEMA_UPGRADE_REQUIRED`, `TIME_ANCHOR_REQUIRED`, `PROCESS_REANCHOR_REQUIRED`,
`CLOCK_UNSAFE`.

| Observed state | Anchor fields / executable evidence |
| --- | --- |
| Valid v4 | All five nullable anchor/session fields null; false / `SCHEMA_UPGRADE_REQUIRED` |
| Valid v5, no head | All five null; false / `TIME_ANCHOR_REQUIRED` |
| Valid v5, historical head but no trusted session | Actual generation/hash/wall; nonce/elapsed null; false / `PROCESS_REANCHOR_REQUIRED` |
| Valid v5, matching private capability and safe current time | All five populated from actual state; true / null |
| Unsafe observation | false / `CLOCK_UNSAFE`; invalid samples cannot be coerced into safe integers or invent anchor facts |

The approved plan contract §4 fixes diagnostic precedence and pure-codec
nullable/error fallback: every successful v4 diagnostic retains the upgrade
reason and null anchor fields; malformed samples fail rather than fabricating a
DTO. The specified B0.3 private time authority still requires implementation and
owned-target evidence. `executable:true` describes time readiness only, not
policy enablement or batch approval. It requires a real private capability
matching actual instance/epoch/head/time. Passing the pure codec or presenting
caller JSON never establishes that capability.

## 7. Backup/recovery compatibility and rollout gate

| Evidence family | Existing v4 route, immutable | Future v5 route |
| --- | --- | --- |
| Native backup manifest | format 2 / schema 4 / tool 1 | format 3 / schema 5 / new explicit tag (exact tag pending) |
| Registry | record 3 / `native-v4` | record 4 / `native-v5` |
| Source evidence | version 1 | version 2, exact new schema/checksum binding |
| P5 canonical records | Current family unchanged | Coherent new versioned family with explicit source **and** target schemas |
| Seal | Existing v4 format/hash semantics | seal v2, `schemaVersion:5` and exact v5 checksum |

The new P5 family must bind conversion plan/proof and pre/post-phase hashes
through prepare, verify/seal, activation and completion/status. Do not splice a
v5 seal into an old activation chain or rename old formats. Exact new field
layouts, version tags and canonical hashes are still a finite compatibility
gate, not claimed frozen by this matrix. Review new goldens separately.

Logical digests and normalization require explicit **3/4/5 table allowlists**,
including v5 anchor history, head and transition proofs. Do not replace a
hard-coded version number and assume backup, registry/sourceEvidence, recovery
checksum/seal or normalization checks now understand the new schema.
Current hold/release-marker formats may remain only where a genuine
version-aware verifier proves their hash-bound evidence. Release markers remain
incapable of authorizing deletion.

Implement consumer dispatch in order: **schema -> runtime clock -> backup ->
registry/source catalog -> recovery codecs/candidate -> facade**. Converter
rollout remains blocked until a converted v5 candidate can round-trip through
backup, registration, restore, verification and activation **still paused**,
with runtime and time-approval gates validated. No live converter is exposed
merely because its isolated migration transaction passes.

## 8. Package exits and genuinely remaining artifacts

| Package / artifact | Exact scope and remaining evidence |
| --- | --- |
| B0.1 ready specification | Implement only §2 storage/validators and §4.2 pure codecs; strict types, table/record order, domains, contiguous chain, head semantics, transition reconstruction, APIs and budgets are frozen |
| B0.1 generated artifacts | Expand constraints into exact SQL/marker/index bytes, generate DDL full-byte hash and V5 manifest checksum and independently review goldens; no literal V5 constant is claimed here; retain 1–4 bytes/goldens |
| B0.2 prerequisite | Genuine private new-workflow recovery ownership bridge and protected plan/completion publication implementation; §3.1 converter API, typed plan/proof/complete records and retry semantics are fixed, not permission to implement in B0.1 |
| B0.3 prerequisite | Separately branded owned-v5 private target seam and time implementation evidence; §4–5 fix factory/operations/status, native clock units, sample ordering, nonce registration, chain and replay/session rules; test composition only until rollout |
| New versioned P5 field tables | Still unfrozen: manifest-3 exact tool tag/fields; registry-4/sourceEvidence-2; source/target/conversion bindings across the coherent stage/prepare/verification/seal-2/activation/completion/status family; exact version tags, phase digests and 3–5 allowlists. Head-only reset behavior is fixed; integration evidence remains |
| Hold/release verification | Prove retained formats bind the correct new-version records through real version-aware verification; otherwise freeze an explicit new variant before use |
| B1 writer handoff | Future persisted result/status, candidate projection/completion audit and execution approval/rejection semantics remain separate freezes; B0 time approval is not deletion approval |

Development gate order is **P6-A -> B0.1 -> B0.2 ownership bridge/converter ->
B0.3 owned-v5 seam/time authority -> B1 execution -> process QA**. Runtime,
backup/registry and the new recovery-family roundtrip are independent mandatory
operational rollout gates before exposing the converter. Assign one owner
per shared source file; future changes to shared runtime modules are separate
approved write-sets, not permission from this document lane.

**B0.1 acceptance evidence to produce:** independent literal vectors for all five
record kinds (not expected bytes/hashes generated by the implementation under
test); exact inherited v4 golden/API regression and v4 rejection of v5; mixed
schema/marker/checksum corruption; observed-floor proposal reconstruction;
contiguous generation, cross-epoch predecessor, optional tip/current-epoch head,
cross-instance and safe-overflow rejection; capped counts, length-first metadata
and shared elapsed budgets. Use a synthetic conversion-shaped fixture with
empty anchors/head and one valid typed transition. This fixture exposes no
runtime conversion/time writer and is not migration or rollout evidence.

Later-package required evidence: immutable P1/historical exports and golden regression;
strict mixed version/checksum rejection; full-v4/full-v5 atomic crash outcomes;
preserved business/identity/epoch/policy/paused facts and empty anchor on convert;
old route and v5 round-trip compatibility; no reused seals; canonical chain and
independent-approver checks; zero-write preview/rejected time approval; TTL/window
equality and final-sample failures; backward/forward/global-floor-washout cases;
restart/new-nonce reanchor; exact retries without session minting; uncertain
commit and real process-kill boundaries. All evidence must bind the reviewed
source. P5 process-kill tests are not power-loss proof; native Windows strict
protection gates and legacy LAN/journal compatibility remain intact.

## 9. Retained operational boundaries

Expiry, purge and backup cleanup remain OFF; content/retry/audit remain
90/7/180 days and backup TTL remains null/unconfirmed. Backup cleanup is always
preview-only, including with an explicit TTL: source-deletion and archived-status
semantics still require a separate decision, and no deletion adapter is added.
Ordinary audit allowlist remains only `conversation.created` and `message.read`.

H1–H3 operational approvals and P7 external-network/resource gates remain as
recorded in the maintenance handoff. This document supplies no code, migration,
runtime test or production acceptance evidence. Its checks are document-only:
UTF-8/no BOM/final newline, canonical field order, balanced fences, relative
existing links and whitespace. This reconciliation edits only this contract and
the maintenance handoff; it does not stage, commit or push.
