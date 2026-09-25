# P6 schema 5 and maintenance time contract (NONRELEASE)

**Oracle-approved specification; unimplemented; no runtime acceptance.**
Baseline HEAD: `609a97acd1fc78e5393a2e52154be809353df9d6`.
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
and runtime acceptance are not done. Its approval does not freeze the remaining
exact v5 anchor/conversion/versioned-P5 formats or grant execution authority.

## 1. Version decision and implementation boundary

- Center schema **5** is an additive, explicit migration from validated schema
  4. Historical schemas 1–4, their DDL/checksums/goldens, and the exact existing
  `schema.js` exports including `assertImSchemaV4` remain immutable.
- Existing fresh-4 and v3-import-to-4 APIs remain unchanged. Legacy center 3,
  wire `a2a-msg.im.v2` and client journal 2 keep their versions and semantics.
- Future new modules are `src/im/v2/schema-v5.js`,
  `src/im/v2/schema-v5-internal.js`, `src/im/v2/schema-dispatch.js`,
  `src/im/v2/migration-v5.js`, and `src/im/v2/maintenance-time.js`.
  These are proposed implementation files, not files created by this handoff.
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

| Column, in the proposed table order | Type / constraint |
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
| `global_floor_at_approval` | `N` |
| `max_forward_jump_ms` | INTEGER, strict integer range `1..86400000` |
| `approval_ref` | `Ref` |
| `executor_id` | `Ref` |
| `approver_id` | `Ref` |

Required table constraints:

- Previous generation/hash are either both NULL or both non-NULL; when present,
  `previous_generation < generation`.
- `proposal_expires_at > proposed_at`.
- `accept_not_before <= candidate_wall_at <= accept_not_after` and
  `accept_not_before <= accepted_wall_at <= accept_not_after`.
- `accepted_wall_at >= global_floor_at_approval`.
- `executor_id <> approver_id`.
- `UNIQUE(center_epoch,generation,anchor_hash)`.

The full validator verifies predecessor identity/hash and the canonical hash
chain, including actual instance identity. A self-FK only proves row existence;
it cannot prove that `previous_anchor_hash` is that predecessor's hash. Proposal
TTL/window rules and actual authority/time checks also apply at service level.
Anchor history is retained; neither ordinary audit expiry nor maintenance run
cleanup removes it.

### 2.2 `im_maintenance_time_head`

| Column | Type / constraint |
| --- | --- |
| `singleton` | INTEGER PRIMARY KEY, strict integer, CHECK `singleton=1` |
| `center_epoch` | `U`, FK `im_center_epochs(center_epoch)` |
| `generation` | `N+` |
| `anchor_hash` | `H` |

Composite FK `(center_epoch,generation,anchor_hash)` references the identical
unique triple in `im_maintenance_time_anchors`. **No row means unanchored**;
do not synthesize a head from `im_clock`. An executable head must match the
actual center epoch. Create index
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
| `approved_plan_hash` | `H`, UNIQUE |
| `approval_ref` | `Ref` |
| `executor_id` | `Ref` |
| `converted_at` | `N` |

Validate these proof bindings against the actual DB, reviewed manifests and
approved conversion plan. Preserve transition history. Schema 5 retains every
v4 business table, including `im_maintenance_runs`, unchanged; no anchor is
hidden in JSON and no historical action/enum is repurposed. Replace only the
schema-marker definition for the new version: the schema-5 form of `im_schema`
has the version-5 check and new manifest checksum; the historical v4 definition
and hash are not edited.

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
Conversion API/plan/proof byte layouts and exact retry results remain §8 freezes.

| Requested route | Approved behavior |
| --- | --- |
| Existing fresh 4 / v3 import 4 | Existing P1 APIs and behavior unchanged |
| Opt-in fresh 5 / v3 import 5 | P1 produces 4, then separately approved explicit candidate conversion |
| v4 snapshot targeting 4 | Existing route and old canonical records unchanged |
| v4 snapshot explicitly targeting 5 | Copy, normalize and pause candidate, then convert **before** the new versioned prepare plan |
| v5 snapshot targeting 5 | Future explicitly versioned route and validators |
| v5 targeting 4 | Refuse; no downgrade |

Old seals are never updated or reused across conversion. Conversion evidence
must bind pre/post phases; it cannot relabel an old file hash or seal as v5.
Closed-v3 and registered-v3 bridge behavior stays on its existing route unless
an explicit target-5 workflow subsequently converts the owned v4 candidate.

## 4. Time administration and proposal encoding

Separate synchronous local operations are approved:

```text
previewMaintenanceTimeAnchor({},ctx)
approveMaintenanceTimeAnchor({proposal,proposalHash,approvalRef},ctx)
getMaintenanceTimeStatus({},ctx)
```

All require literal-true synchronous admin authority before disclosure. The
independent approval adapter must also synchronously return literal `true` and
is separately bound to actual DB/instance/epoch, prior head/hash, current process
nonce and exact proposal/hash; executor and independent approver must differ.
No deletion approval substitutes for it. The maintenance handoff's strict
snapshot, async/thenable denial and capability-lifetime rules apply.

Proposal field order is exact:

```text
version, instanceId, instanceCreatedAt, centerEpoch,
previousGeneration, previousAnchorHash, sessionNonce, proposedAt,
proposalExpiresAt, candidateWallAt, acceptNotBefore, acceptNotAfter,
globalFloorObservedAt, maxForwardJumpMs
```

`version=1`; identity/epoch/nonce use `U`, hashes use `H`, time values use `N`,
generation is `N+` or null. Previous generation/hash are paired null or paired
values from the actual head. `sessionNonce` is internally generated and bound
to the current private session. `maxForwardJumpMs` is `1..86400000`, lower-only.
Proposal TTL is positive and at most **300000 ms**. The approval window is
lower-only, at most **5000 ms** wide: `candidateWallAt` is the actual trusted
wall sample, `acceptNotBefore=candidateWallAt`, and
`acceptNotAfter=candidateWallAt+windowMs`, with safe addition and no clamping.
Preview is read-only; it does not establish an accepted baseline or ratchet
private highwater/global floor. These proposal fields are evidence, not authority.

Canonical records follow strict ordered `JSON.stringify`, UTF-8 without BOM,
formatting whitespace or trailing newline, exact re-encoding equality and the
maintenance contract's bounds discipline. Domain hashes are:

```text
proposalHash = SHA256(UTF8("im-maintenance-time-proposal-v1\n") || canonicalProposalBytes)
anchorHash   = SHA256(UTF8("im-maintenance-time-anchor-v1\n") || canonicalAnchorEvidenceBytes)
```

Anchor evidence must include **all anchor columns except `anchor_hash`, plus
actual instance ID and creation time**. Its exact camelCase field mapping/order
is **not approved yet**. The table order in §2 is not a substitute hash preimage;
the schema author must freeze that field table and golden vectors before any
anchor codec, chain validator or writer consumes it.

## 5. Approval transaction, process baseline and retry

Under the actual DB write lock, verify the previous head/hash and current
private process nonce, fresh independent approval, executor/approver distinction,
actual wall/monotonic samples, current global floor/private highwater, proposal
window and strict proposal expiry. Check again using the final samples and
authority immediately before commit. New anchor insertion, head installation
and global-floor update are **one atomic transaction**.

Rejected approval writes **no anchor, head or global floor**. Private highwater
may advance conservatively after an observed sample. Never floor-drop, clamp a
time into the window, or silently accept a different time proposal.

Install the private trusted baseline only after **acknowledged commit**, retaining
the final **precommit monotonic sample** as origin. A postcommit sample would
understate elapsed time during commit/response delay and must not replace it.
In the same private session:

```text
expectedWall = acceptedWall + monotonicElapsed
abs(now - expectedWall) <= maxForwardJumpMs <= 86400000
now >= actualGlobalFloor AND now >= privateHighwater
```

Use safe arithmetic; elapsed must not be negative or regress. Ordinary
`im_clock` changes never refresh this anchor or its private origin. Runtime
sampling units/rounding/native adapter details require the exact API freeze in
§8, not an injected caller JSON claim.

Restart loses the private baseline: reading historical anchors is diagnostic,
not execution authority. A **new nonce, proposal and independent approval** are
required. Exact completed-approval retry returns immutable persisted evidence
without a new write or clock call, but **cannot mint a session**. Read resolution
of an uncertain commit has the same restriction. An already valid private
session is not recreated by retry; without one, reanchor is required.

A new recovery epoch resets head authorization; historical anchors remain.
No old-epoch head or private session transfers to it. The new versioned recovery
transaction and head transition must make this explicit (§8), not silently
reinterpret the old head as current. Any reanchor invalidates old maintenance
plans bound to the previous anchor.

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
DTO. Actual v5 time adapters remain §8 gates. `executable:true` describes time readiness only, not
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

## 8. Finite remaining artifacts and evidence gates

| Artifact still to freeze or validate | Exact scope |
| --- | --- |
| DDL/manifest golden | Expand §2 constraints into exact SQL, marker replacement and index bytes; generate/review V5 checksum and full validator fixtures without modifying 1–4 goldens |
| Anchor evidence field table | Exact camelCase mapping/order of every non-hash anchor column plus instance identity, encoding bounds, domain-hash vectors and predecessor-chain validation; generation allocation/first-anchor and epoch-reset predecessor rules |
| Conversion API and evidence | Exact migration export/options/results, strict conversion-plan/proof fields/order, pre/post hash scope, approval binding, retry/conflict and bounded validation; candidate ownership and workflow eligibility verification |
| Time/target adapters and envelopes | Factory placement, exact DB/read/write/session capabilities, native wall/monotonic units/rounding and sample ordering, trusted actors/approval arguments; preview/approval/status responses, fixed errors and unsafe timeEvidence cross-field cases |
| New versioned P5 field tables | Manifest-3 tag/fields; registry-4/sourceEvidence-2; source/target schema and conversion bindings across stage/prepare/verification/seal-2/activation/completion/status; exact record version tags, phase digests/3–5 allowlists and head reset transaction |
| Hold/release verification | Prove retained formats bind the correct new-version records through real version-aware verification; otherwise freeze an explicit new variant before use |
| Maintenance plan handoff | P6-A selection/cursor, candidates/digest, budget/scan, metadata caps and preview DTO are approved in the plan contract; implementation/vectors remain. Future writer result/status schemas and actual v5 execution authority remain separate gates |

Gate order is **read-only preview -> schema/converter -> runtime dispatch ->
backup/recovery formats -> time approval -> execution -> process QA**. Converter
implementation is distinguishable from its blocked rollout. Assign one owner
per shared source file; future changes to shared runtime modules are separate
approved write-sets, not permission from this document lane.

Required future evidence: immutable P1/historical exports and golden regression;
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
UTF-8/no BOM, relative existing links and whitespace.
