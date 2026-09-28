# Recovery-v5 terminal, API and inventory contract (NONRELEASE)

**Conceptual proposal: PASS. Terminal/API/inventory DOCUMENT artifact: ACCEPTED
after independent review (2026-09-29). Whole C2 remains IN_PROGRESS; codec/runtime
implementation and S3/H4 NOT READY; Q5 blocked.**

Checked HEAD: `ff82d3971a153aec5f86c2afeed7349d6b53e1e0` (2026-09-28).
This is document-only transcription, accepted after independent review including
the 11-field policy count correction and explicit inventory refinements. It
defines the terminal/API/inventory document artifact; no implementation, SQLite
operation, test evidence or whole-C2 readiness follows from document acceptance.

Read with accepted [intake](im-v2-recovery-v5-intake-contract.md),
[admission](im-v2-recovery-v5-admission-contract.md),
[phase](im-v2-recovery-v5-phase-contract.md),
[entry/plan](im-v2-recovery-v5-entry-plan-contract.md),
[state manifest](im-v2-recovery-v5-state-manifest.md),
[state-v1 grammar](im-v2-recovery-v5-state-digest-contract.md), and the
[current ledger](im-v2-implementation-plan.md#52-接下来按依赖推进的-todo).
Those technical documents and all historical codecs remain unchanged. New
decisions below resolve their deferred facade, auth-review adapter, terminal and
physical-inventory subjects only as an accepted document artifact.

## 1. Strict data, primitive and hash rules

Exactly nine terminal/API record kinds: `stageResult`, `prepareResult`,
`verifyResult`, `activationResult`, `activationCompletion`, `releasePlan`,
`releaseIntent`, `releaseResult`, `status`. Each has literal version1, exact ordered
fields below and C2-A's 65536-byte complete-record cap including nested releasePlan.
These receipt kinds are **distinct from central persisted `phaseResult`**. The
prepareResultHash/verifyResultHash/activationResultHash fields name phaseResult
hashes, not self-hashes of similarly named public receipts.

Use C2-A exact recursive ordinary own-data checks: reject Proxy before reflection,
require Object.prototype and exact enumerable own data fields, reject accessors,
symbols, hidden/extra/missing keys, exotic data and coercion/getter/toJSON/iterator
execution. Required nullable fields explicitly null; no omission/undefined. Strict
snapshot before historical codecs. Encode in declared order with JSON.stringify
UTF-8, no BOM/formatting/trailing newline. Decode owned bounded ordinary nonshared
Buffer/Uint8Array bytes using fatal UTF-8 and byte-identical canonical re-encoding;
reject duplicate/escaped aliases, reordered bytes, alternate spellings and trailing
data. Bytes owned; returned DTOs detached and deeply frozen. No record grants a
source, DB, filesystem, approval, ownership, durability or publication capability.

| Symbol | Exact rule |
| --- | --- |
| U | Lowercase UUID, length36, `^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$` |
| H | 64 lowercase hexadecimal characters |
| N | Nonnegative safe integer through 9007199254740991, reject -0; times in milliseconds |
| R | P5 Ref, 1..255 UTF-16 units, no C0/DEL, no normalization; lossless JSON surrogate escaping |
| T? | Required T or explicit null |
| Route | native-v5 or converted-v4 |
| Source pair | Original source: null/null fresh, 3/exact V3 import, 4/exact V4 converted snapshot, 5/exact V5 native snapshot |
| Target pair | Exactly5 / V5_CHECKSUM |

Checksums remain actual reviewed constants, including V5
`80eba5e6ce61261d31ec495216c3b6eb8c7a8f0c87edcbb1440372353f495435`.

```text
Hnew(kind, record) = SHA256(UTF8('a2a-msg.im.v2/recovery-v5/' + kind + '\n')
                          || canonicalRecordBytes)
```

One LF separator, no NUL. New receipt and terminal kinds use their exact names;
entry/plan/phase/seal/intake domains remain their accepted kinds. Historical C1
record/source and old source/stage/closure hashes remain raw; conversion owner/pause
NUL and maintenance conversion newline domains remain unchanged. Registry release
marker hash is **raw SHA-256 of old `canonical('release',marker)` bytes**, never
Hnew(releaseResult) or a re-encoded new marker. State digest and actual file hash
remain separate accepted algorithms, not descriptive JSON hashes.

Encode/hash invalidity uses RECOVERY_INVALID; decode/pure binding mismatch uses
RECOVERY_EVIDENCE_MISMATCH, preserving entry validators' explicit invalid selector
rules. Runtime fixed vocabulary includes RECOVERY_AUTH_DENIED, APPROVAL_DENIED,
EVIDENCE_MISMATCH, UNSUPPORTED, BUSY, NOT_FOUND, INDETERMINATE,
DURABILITY_UNCERTAIN and PLAN_STALE (all with RECOVERY_ prefix). Never inspect
hostile exceptions for authorization or disclose raw native/adapter text/paths.

## 2. Proposed factory and exactly eight operations

Trusted in-process construction:

```text
createImV5RecoveryServices({root,sourceCatalog,authority,approvalAuthority,
  evidenceAuthority,policy,clock,limits})
```

First six fields are required: root, sourceCatalog, authority, approvalAuthority,
evidenceAuthority, policy. Only clock and limits are optional; omitted clock is
Date.now, omitted limits use existing six defaults. Unknown fields reject. Strict
descriptor snapshots preserve actual genuine facade identity/brands; do not clone
capabilities into lookalikes. Source catalog is exactly accepted B1's genuine
registered-backup/completed-conversion union. Root is protected canonical workspace
configuration, never an operation-selected candidate path. Constructor performs
**no directory or coordination DB creation/initialization**. Authorized stage owns
needed new namespace/coordination initialization in §10; observation cannot do it.

Clock is a trusted constructor adapter, never operation-supplied time. It must
produce valid N under the phase freshness rules; no actor/epoch/digest/time override
is added to an operation. Release timestamp sampling stays registry-internal in
the private release scope. Existing old converter keeps its own explicit executor,
approval and native time behavior; stage never implicitly converts or approves.

### 2.1 Exact retained policy and limits

Policy has exactly the following **11 source-declared** ordered fields and values:

| Field | Required value |
| --- | --- |
| version | 2 |
| effectiveAt | N |
| messageRetentionMs | 7776000000 |
| attachmentRetentionMs | 7776000000 |
| safeRetryWindowMs | 604800000 |
| auditRetentionMs | 15552000000 |
| keyReservation | indefinite |
| expiryEnabled | false |
| purgeEnabled | false |
| backupCleanupEnabled | false |
| backupRetentionMs | null |

Its hash is existing raw SHA-256 of UTF-8 JSON.stringify in that order, not a new
policy domain. Actual policy validation/hash is
[recovery.js](../src/im/v2/recovery.js):186-197. Apply new strict scalar/object
firewall without changing historical byte preimage or accepting -0.
**Transcription discrepancy for review:** the supplied proposal calls this the
“old12fieldpolicy”, but the actual exact source list has eleven fields. This
document retains that complete eleven-field list and existing hash; it does not
invent a twelfth field. Parent review must confirm the count wording, not silently
change policy shape or canonical bytes.

| Limit | Default / hard ceiling |
| --- | ---: |
| maxMessages | 10000 |
| maxVerifiedContentBytes | 104857600 |
| maxOtherRecords | 10000 |
| maxElapsedMs | 10000 |
| maxFileBytes | 134217728 |
| maxMetadataEntries | 10000 |

Limits may only lower existing ceilings, with positive safe integers and no unknown
keys ([backup.js](../src/im/v2/backup.js):14-21). Every operation creates one original
authentic budget and first ticks **before filesystem work**; all source/workspace/
candidate, baseline/replay/digest, copy/hash/sync/publication/callback/final checks
inherit that object. No fresh public wrapper budget, reset, raised cap, five-second
reservation window or hard-native interruption claim. Valid-size work can exceed
the original elapsed deadline.

### 2.2 Exact synchronous input/result surface

Each operation is synchronous `(input,ctx)` with exact ordinary-data input and
detached deeply frozen output. The facade has exactly these eight methods:

| Operation | Exact ordered input | Exact output |
| --- | --- | --- |
| stageCandidate | `{requestRef,selectionRef,isolationAckRef}` | stageResult |
| previewRecovery | `{runId}` | `{preparePlan,preparePlanHash}` |
| prepareRecovery | `{runId,preparePlanHash,approvalRef}` | prepareResult |
| getRecoveryStatus | `{runId}` | status |
| verifyRecovery | `{runId,preparePlanHash}` | verifyResult |
| previewActivation | `{runId,sealReference,authReviewRef,isolationAckRef,activationRef}` | `{activationPlan,activationPlanHash}` |
| activateRecovery | `{runId,activationPlanHash,activationApprovalRef,sealReference}` | activationResult |
| releaseRecoveryHold | `{runId,holdId,releasePlanHash,approvalRef}` | releaseResult |

runId/holdId U; every *Hash H; refs R. isolationAckRef is required R or null and
null **only for converted fresh**, agreeing with actual selected source/entry.
sealReference is an exact derived R `v5-runs/<runId>/seals/<sealHash>` without suffix,
not an arbitrary path. Public inputs accept no candidateKind/schema/identity/
actor/time/epoch/digest/DB/SQL/path/proof/hash override beyond the named persisted
plan hash selectors. Preview envelopes contain exact accepted entry/plan records;
their hashes are Hnew(preparePlan/activationPlan), not caller-authored plans.

### 2.3 Side effects, frontier and retries

| Operation | Authorized bounded work / retry boundary |
| --- | --- |
| stageCandidate | Locator-first genuine entry publication; native independent copy/intake/normalization or precompleted-conversion C2-A archive handoff. Initial run allocated once native, retained converted; historical stage retry validates entire current frontier and returns retained stage receipt without recopy/renormalize |
| previewRecovery | **WRITEFUL**: create/complete pausePlan -> pauseIntent -> pauseResult, then publish immutable preparePlan; no implicit conversion. Existing artifacts exact-reused/resynced, no earlier repause or renewal |
| prepareRecovery | Exact plan/current mutation approval, same-intent atomic prepare or explicit completion; receipt binds prepare phaseResult. Registered prepare binding established under correct hold stage before mutation |
| getRecoveryStatus | Observation-only §9; existing coordination housekeeping allowed; no creation, resync, hold establishment, completion or repair |
| verifyRecovery | Create verifyPlan/intent/result, then exact seal2; retry can finish seal publication after valid result. No old seal reuse or arbitrary verify plan input |
| previewActivation | Validate seal/current boundary and mandatory exact auth-review subject, publish/exact-retry activationPlan; no candidate business mutation |
| activateRecovery | Atomic activation or completion-only reconciliation, phaseResult -> activationCompletion -> registered releasePlan; explicit retry also creates missing releasePlan, with no ninth operation |
| releaseRecoveryHold | Registered terminal-only private release scope: intent -> authoritative registry marker -> local releaseResult; exact terminal/source/current authority and §8 branches |

Only current creation frontier may mutate. Historical completed operation retries
validate whole Entry/Chain/Terminal and **actual current frontier**, source/hold/
closure, baseline/replay and current authority/durability before returning retained
receipt. Receipt state labels describe that historical completion, not a claim
that current state reverted. Pending/indeterminate later frontier cannot be hidden
by an old successful receipt. After prepare/activate, never require obsolete live
intake, normalization or seal file hash; validate archive/history plus later chain.

## 3. Current authorization and exact auth-review interface

Retain B1 admin/executor/approval protocols unchanged:

```text
authority.authorizeAdmin(ctx) -> true
authority.resolveExecutor(ctx) -> {executorId}
approvalAuthority.resolveApproval(binding,ctx) -> {approverId}
approvalAuthority.authorizeApproval(resolvedBinding,ctx) -> true
```

B1 binding exact order: kind,runId,planHash,approvalRef,instanceId,instanceCreatedAt,
sourceSchemaVersion,sourceSchemaChecksum,targetSchemaVersion,targetSchemaChecksum,
executorId; resolved adds approverId. kind prepare-v5/activate-v5/release-hold-v5,
distinct R actor strings, actual source/target pairs. Capture once in new intent;
current mutation checks use persisted pair, never replacement identities. Pause/
verify actors/approval stay null; central completion reconciliation stays unchanged.
Native B1 closure adapters and original converted closure authorization/isolation
also stay unchanged. Current source/closure/admin checks precede metadata disclosure.

### 3.1 Mandatory trusted auth-review adapter

```text
evidenceAuthority.assertAuthReview(
  {runId,preparePlanHash,sealHash,newEpoch,authReviewRef},ctx) -> literal true
```

This is the exact subject order from the accepted entry binding. All values derive
from actual validated run/prepare plan/seal; newEpoch is validated prepare effect's
epoch and equals seal.newEpoch, reference equals activation effect. Authorization
of a reference alone or another run/plan/seal/epoch does not authorize this subject.
Actual old precedent [recovery.js](../src/im/v2/recovery.js):989-991 and 1033-1054
constructs that tuple and checks it around preview. Refusal is fixed
RECOVERY_EVIDENCE_MISMATCH, consistent with existing evidence authority behavior.

Mandatory checks: before activationPlan publication, on preview retry, before
activationIntent, before COMMIT, before activationCompletion, and throughout
terminal release's required current/final checks. **Status always calls it when
activationPlan exists**, after validating the chain and before disclosure, and at
final checks. No activationPlan means no auth-review call. No undeclared policy
flag makes this optional; internal hash recognition grants no disclosure authority.

### 3.2 Completion-only release reconciliation

```text
approvalAuthority.authorizeRecoveryV5ReleaseReconciliation(binding,ctx) -> true
```

Exact ordered binding:

| Field | Type / binding |
| --- | --- |
| kind | reconcile-release-v5 |
| runId | U |
| releasePlanHash | H |
| releaseIntentHash | H |
| activationCompletionHash | H |
| backupId | U |
| holdId | U |
| approvalRef | R; retained release intent |
| executorId | R; retained release intent |
| approverId | R; retained distinct approver |
| releasedAt | N; retained intent/actual marker time |

Current policy may deny revoked historical actors/caller even when marker is exact.
No actor replacement, new release sample or mutation approval to bless an already
published marker. Current admin/source/isolation/closure/auth-review still apply.
Central `authorizeRecoveryV5Reconciliation` for pause/prepare/verify/activate is a
different unchanged binding, never substituted for this release adapter.

All adapters/results are strict synchronous own-data and literal true where stated;
reject Proxy/accessor/symbol, async/generator/Promise/thenable and truthy non-true.
Latch faults before classification, reject reentry/escaped capabilities and caught
callback failures, expire live scopes before callback-bearing finalization, and
check sticky outer failure after final authority/source/unlock work.

## 4. Exact nine terminal/API record layouts

### 4.1 stageResult

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| candidateReference | Exact route path |
| route | Route |
| stageHash | Hnew(stage) |
| stagedHash | Hnew(staged) |
| intakeKind | nativeIntake or convertedIntake |
| intakeHash | Hnew(intakeKind) |
| instanceId | U |
| instanceCreatedAt | N |
| initialEpoch | U; retained intake |
| previousRecoveryCounter | N; retained intake |
| holdId | U?; null only fresh/closed3 |

Derived from validated complete Entry, not partial stage metadata. No status field
is added; the receipt remains the entry receipt after later phases.

### 4.2 prepareResult

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| candidateReference | Exact route path |
| preparePlanHash | Hnew(preparePlan) |
| prepareIntentHash | Hnew(phaseIntent, prepareIntent) |
| prepareResultHash | Hnew(phaseResult, prepareResult in Chain) |
| newEpoch | U; prepare effect |
| recoveryCounter | N; prepare effect |
| state | prepared |

Public receipt `prepareResult` is not the central Chain.prepareResult record, whose
serialized kind is phaseResult. Hash links always use the appropriate family.

### 4.3 verifyResult

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| candidateReference | Exact route path |
| preparePlanHash | Hnew(preparePlan) |
| verifyPlanHash | Hnew(verifyPlan) |
| verifyIntentHash | Hnew(phaseIntent, verifyIntent) |
| verifyResultHash | Hnew(phaseResult, verifyResult in Chain) |
| sealReference | Exact suffixless derived reference |
| sealHash | Hnew(seal) |
| state | verified |

Requires valid verify phase result **and** seal. Missing seal is an explicit retry
frontier, never a successful public verified receipt with invented seal hash.

### 4.4 activationResult

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| candidateReference | Exact route path |
| activationPlanHash | Hnew(activationPlan) |
| activationIntentHash | Hnew(phaseIntent, activationIntent) |
| activationResultHash | Hnew(phaseResult, activationResult in Chain) |
| activationCompletionHash | Hnew(activationCompletion) |
| newEpoch | U; prepare effect |
| recoveryCounter | N; prepare effect |
| activationRef | R; activation effect |
| state | active |
| writeMode | paused |
| releasePlan | Exact releasePlan?; registered nonnull, fresh/closed3 null |
| releasePlanHash | H?; both-null or Hnew(releasePlan) |

No successful registered activation receipt until its releasePlan exists and
validates. Phase activationResult can already exist while completion/plan publication
requires retry; distinguish that from this public receipt. Active never enables
write_mode, listener or operational time/maintenance authority.

### 4.5 activationCompletion

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| stageHash | Hnew(new stage) |
| stagedHash | Hnew(staged) |
| intakeKind | nativeIntake or convertedIntake |
| intakeHash | Hnew(intakeKind) |
| handoffHash | H?; null native |
| candidateReference | Exact route path |
| instanceId | U |
| instanceCreatedAt | N |
| sourceSchemaVersion | Required null,3,4,5; original-source pair |
| sourceSchemaChecksum | H?; exact correlated checksum |
| targetSchemaVersion | 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| holdId | U?; registered nonnull |
| holdStageHash | H?; native new stage / converted historical stage; null fresh/closed3 |
| preparePlanHash | Hnew(preparePlan) |
| prepareIntentHash | Hnew(phaseIntent, prepareIntent) |
| prepareResultHash | Hnew(phaseResult, prepareResult) |
| verifyPlanHash | Hnew(verifyPlan) |
| verifyIntentHash | Hnew(phaseIntent, verifyIntent) |
| verifyResultHash | Hnew(phaseResult, verifyResult) |
| sealHash | Hnew(seal) |
| activationPlanHash | Hnew(activationPlan) |
| activationIntentHash | Hnew(phaseIntent, activationIntent) |
| activationResultHash | Hnew(phaseResult, activationResult) |
| activationApprovalRef | R; activationIntent.approvalRef |
| executorId | R; activationIntent captured executor |
| approverId | R; same intent's distinct approver |
| authReviewRef | R; activation effect |
| isolationAckRef | R?; null fresh only |
| activationRef | R; activation effect |
| newEpoch | U; prepare effect, seal and actual active epoch |
| recoveryCounter | N; prepare effect, seal and actual counter |
| candidateFileHash | H; activation phaseResult closed synced bytes |
| stateDigest | H; activation phaseResult / intent.afterStateDigest |
| clockFloor | N; activation phaseResult.clockFloor |
| activatedAt | N; activationIntent.reservedAt = phaseResult.phaseAt |
| writeMode | paused |

Every field derives from validated entire Chain, not caller proof. No new
completion timestamp. Order: actual closed/synced candidate -> activation
phaseResult -> full terminal validation/current auth-review -> completion publication
or exact resync at `activation-complete.json`. Explicit retries reestablish required
durability; later active bytes are never checked against obsolete preactivation
seal file hash. The seal is validated historically through Chain and current active
boundary through phaseResult/completion/replay.

### 4.6 releasePlan

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| candidateReference | Exact route path |
| instanceId | U |
| instanceCreatedAt | N |
| sourceSchemaVersion | 3,4,5; registered original source only |
| sourceSchemaChecksum | Exact original checksum |
| targetSchemaVersion | 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| backupId | U; actual original registered source |
| holdId | U |
| holdStageHash | H; actual hold.stageHash |
| stageHash | Hnew(new stage), distinct from converted historical holdStageHash |
| preparePlanHash | Hnew(new preparePlan) |
| activationCompletionHash | Hnew(activationCompletion) |
| newEpoch | U |
| recoveryCounter | N |
| terminalState | active |
| writeMode | paused |
| createdAt | N; sampled once after completion exists, >= completion.activatedAt |
| expiresAt | N; exactly createdAt+300000 with safe arithmetic |

Registered routes only. Creation is explicit activateRecovery work/retry after
validated completion; status cannot create a missing plan. Immutable TTL, no
renewal/replacement. An expired existing plan remains expired; do not silently
generate a new release plan for the same workflow.

### 4.7 releaseIntent

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| releasePlanHash | Hnew(releasePlan) |
| activationCompletionHash | Hnew(activationCompletion) |
| backupId | U |
| holdId | U |
| holdStageHash | H; actual hold.stageHash |
| preparePlanHash | Hnew(new preparePlan) |
| approvalRef | R; independently approved release-hold-v5 reference |
| executorId | R; captured release executor |
| approverId | R; captured distinct release approver |
| minimumReleasedAt | N; exactly completion.activatedAt |
| releasedAt | N; one internal registry sample, retained forever |

Require releasedAt >= actual binding.boundAt, minimumReleasedAt and
releasePlan.createdAt, and releasedAt < releasePlan.expiresAt. Publish/sync this
intent **before marker**. No caller-supplied timestamp; missing marker does not
authorize replacing the intent's time. Before later marker publication, current
freshness also has to satisfy §8's retained-time/expiry checks.

### 4.8 releaseResult

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| holdId | U |
| backupId | U |
| releasePlanHash | Hnew(releasePlan) |
| releaseIntentHash | Hnew(releaseIntent) |
| activationCompletionHash | Hnew(activationCompletion) |
| releaseMarkerHash | H; raw old canonical release marker hash |
| releasedAt | N; intent and actual registry marker time |
| state | released |

Persist locally in release-result.json only after real marker publication/exact
reconciliation with current-frame opaque receipt. Local result cannot stand in
for missing authoritative registry release, recreate it or certify backup cleanup.

### 4.9 status

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U; authenticated locator |
| candidateReference | Exact route path from locator, even when candidate absent |
| route | Route |
| entryState | partial or complete |
| frontier | entry, planned, intended, ready-next, seal-pending or active-complete |
| phase | Required null or pause/prepare/verify/activate; single subject §9 |
| classification | Required null or initial/committed/noop-matched/indeterminate |
| stageHash | H; always authenticated locator stage hash |
| stagedHash | H?; null iff entryState partial |
| planHash | H?; selected phase's plan, never substituted releasePlanHash |
| intentHash | H?; selected phase's central intent |
| resultHash | H?; selected phase's central phaseResult |
| sealHash | H?; iff valid seal actually present |
| activationCompletionHash | H?; iff valid completion actually present |
| holdId | U?; exact known hold; route-aware partial rules §9.4 |
| releaseState | not-applicable, unplanned, planned, intended, marker-visible or result-visible |
| releasePlan | Exact releasePlan?; iff valid persisted plan present |
| releasePlanHash | H?; paired null or Hnew(releasePlan) |
| writeMode | Required null partial; otherwise actual inspected paused/enabled |
| evidenceMode | observed |
| nextAction | Exact finite action vocabulary/priority in §9.3 |

Status is a single phase subject with separately reported release facts, not a
mixture of a planned phase hash and a previous phase's intent/result. Observed
evidence never claims durability. Release applicability is derived from source
route, not merely holdId null (a partial registered route may not yet know its hold).

## 5. Historical release marker and exact bundle surfaces

### 5.1 Unchanged registry marker

The old `release` canonical shape remains exactly:

| Field | Type / new composition requirement |
| --- | --- |
| version | 1 |
| holdId | U; retained actual hold |
| recoveryRunId | U; new recovery run |
| terminalState | active in this new composition |
| stateEvidenceHash | Hnew(activationCompletion) |
| approvalRef | R; releaseIntent.approvalRef |
| releasedAt | N; releaseIntent.releasedAt |

Stored **only** in genuine registry `registry/releases/<holdId>.json`; no copied
marker authority file in the recovery workspace. Historical codec still accepts
active/failed; the new active-only wrapper/composition does not alter it or declare
all historical failed markers invalid. Source
[recovery-records.js](../src/im/v2/recovery-records.js):99-104 also preserves hold
and binding orders:

```text
hold: version,holdId,backupId,recoveryRunId,stageHash,createdAt
binding: version,holdId,stageHash,preparePlanHash,boundAt
```

### 5.2 Terminal, held and operation exact envelopes

Terminal exact order:

```text
chain,activationCompletion,releasePlan,releaseIntent,releaseMarker,releaseResult
```

chain is exact accepted nonnull Entry/Chain envelope, not just active fields. Each
following field is required nullable and contiguous: completion requires Chain's
activation phaseResult; plan requires completion and registered route; intent
requires plan; marker requires intent; result requires marker. Completion may be
absent after activation phaseResult. Fresh/closed3 require all four release fields
null forever. A marker without local intent or a result without marker is mismatch.
Terminal.releaseMarker is the actual marker observation in an envelope, not a
second stored marker. Unknown/malformed later records cannot be hidden by selecting
an earlier completion.

Held exact order:

```text
record,sourceEvidence,hold,binding,release
```

All are required nonnull except release (required nullable). This is the release
validator's authoritative held snapshot, not the pre-stage nullable observer DTO.
Native record/source use C1 exact shapes; converted registered uses unchanged B2
historical record/source family. No copyTo, establish, durable boolean or arbitrary
callback is part of Held. Pure consistency cannot mint its runtime authority.

Operation exact order:

```text
backupId,runId,holdId,releasePlanHash,approvalRef
```

IDs U, plan hash H, approvalRef R. backupId is resolved internally from actual
source; public release input does not supply it. Validate selectors **before**
mutation/reconciliation, not only after publisher callback.

### 5.3 Proposed pure exports

```text
encodeRecoveryV5TerminalRecord(kind, record) -> owned Buffer
decodeRecoveryV5TerminalRecord(kind, bytes) -> detached deeply frozen record
hashRecoveryV5TerminalRecord(kind, record) -> lowercase SHA-256 hex
validateRecoveryV5CompletionBindings({terminal}) -> activationCompletion
validateRecoveryV5ReleaseBindings({terminal,held,operation})
  -> releaseResult if present, else releaseIntent if present, else releasePlan
```

Release validator requires a nonnull releasePlan. Completion validator requires
selected completion. **Validate the entire envelope, entire Chain and every
present terminal record first**, then select detached deeply frozen output. No
implicit creation mode, source authorization, publication capability or runtime
success flag. Module placement is not an additional production API in this proposal.

## 6. Complete binding requirements and acyclic hashes

### 6.1 Completion and public receipt bindings

Recompute all hashes with exact kind/legacy family. Completion fields for run,
path, new stage/staged/intake/handoff, identity/birth and source/target pairs equal
validated Entry; holdId/holdStageHash equal Entry.staged and actual hold conventions.
All prepare/verify/activation plan/intent/result and seal hashes equal whole Chain.
Actor/approval fields equal **activation** intent, not release actors. authReviewRef,
isolationAckRef and activationRef equal activation effect. newEpoch/counter equal
prepare effect and seal; file/digest/clock equal activation phaseResult; activatedAt
equals its phaseAt and activation reservedAt; writeMode paused. No new time sample.

stageResult derives precisely from Entry.staged/intake; prepare receipt from
prepare phase and effect; verify receipt additionally requires exact seal/reference;
activation receipt requires completion and, if registered, exact persisted releasePlan
and paired hash. Receipt state is historical, never permission to ignore later
invalid frontier. Nonnull public releasePlan must be complete strict nested record
and hash-correlated; no loose subset or stale alternate plan.

### 6.2 Release chain and selectors

releasePlan matches completion/Entry actual registered backup, run/path/identity,
source-target pairs, stage/holdStage/hold IDs, prepare plan hash, epoch/counter,
completion hash, active/paused and immutable safe300000 TTL. createdAt is sampled
once after completion exists, at least activatedAt. Existing plan exact-reused.

releaseIntent repeats plan run/hash/backup/hold/holdStage/prepare/completion facts,
has distinct captured R actors and approval, minimumReleasedAt=activatedAt,
releasedAt meeting boundAt/minimum/plan creation and original expiry. Marker matches
intent hold/run/approval/time, active, stateEvidenceHash=completion hash. Local
releaseResult matches plan/intent/completion hashes, backup/hold/run/time and raw
marker hash. No stage/prepare hash is invented inside the historical marker.

operation.backupId/runId/holdId/releasePlanHash must equal actual selected plan/
source/hold. If intent exists, operation.approvalRef equals retained intent/marker
approval. If absent, operation.approvalRef is a proposed nonsecret selector, not
proof of independent approval; runtime resolves/authorizes it before intent.

**Authoritative-marker equality:** terminal.releaseMarker is null **iff** held.release
is null. Otherwise their unchanged old canonical bytes must be identical. Local
result with missing or conflicting actual marker is RECOVERY_EVIDENCE_MISMATCH;
never repair actual registry state from local JSON. Existing result can be returned
only after actual marker equality and current source/terminal/authority checks.

Hold.backupId/runId must match source/Entry; hold.stageHash equals native new stage
or original converted historical stage, never substituted with completion/new stage
hash on converted route. Binding.holdId/stageHash match hold; binding.preparePlanHash
equals **new target5 preparePlanHash**, boundAt>=hold.createdAt. ReleasedAt must meet
binding.boundAt and actual terminal minimum. Pure validators verify all represented
chronology; source existence, durable protection, current actual state and authority
still require the private scope.

### 6.3 Current source versus retained witness

| Route | Required held-source comparison |
| --- | --- |
| Native5 | C1 record4/native-v5 and source2/registry4/exact5; current record and source canonical bytes both equal retained locator.nativeRecord/sourceEvidence, including retained registeredAt as part of record bytes |
| Converted registered3 | B2 record3/imported-registered-v3, old source1/registry2/exact3, nonnull importedRecordHash; source canonical bytes equal retained historical source |
| Converted registered4 | B2 record3/native-v4, old source1/registry3/exact4, importedRecordHash null; source canonical bytes equal retained historical source |

In all registered families compare actual record/source backupId, identity/birth,
schema/checksum, fileHash, manifestHash and completedAt; raw source hash equals
record.sourceEvidenceHash; sourceRef=`backup:<backupId>`, artifactReference=
`registry/artifacts/<backupId>.sqlite`. Converted Entry retained no whole B2 record
witness: **do not invent registeredAt equality to an absent witness** or a new time
inequality. Valid scalar registeredAt and actual genuine record verification still
apply. Converted source is original3/4 despite target5 candidate, never source2
relabeling. Genuine artifact/manifest/import bytes and ownership must verify in
runtime; matching Held JSON cannot supply provenance.

Actual source-family code: [backup-registry.js](../src/im/v2/backup-registry.js):28-37,
129-182; C1 field orders/constraints at
[backup-v5-records.js](../src/im/v2/backup-v5-records.js):8-13,65-95; old families
at recovery-records.js:84-104. Native5 B2 verification resync remains unchanged;
status uses accepted private observation-only seam, never public skipSync.

### 6.4 Directed hash graph

```text
Entry + pause/prepare/verify/activation Chain + seal
  -> activationCompletion
  -> releasePlan
  -> releaseIntent
  -> actual registry release marker (stateEvidenceHash = activationCompletion hash)
  -> releaseResult (raw marker hash + intent/plan/completion hashes)
```

No record hashes itself or a future record. Public receipts point at prior durable
records, never back into Chain. Activation receipt's nested releasePlan is already
published; completion does not contain that receipt hash. Status transiently
describes actual records and never becomes terminal or source authority.

## 7. Activation terminal publication and immutable retry

After activation exact post-state, follow central completion authorization and
settled close/durability protocol: immutable baseline/replay/full5, close readers,
candidate file/directory sync, closed hash, publish/exact-resync activation phaseResult,
validate full terminal/current exact auth-review, then publish/exact-resync
activation-complete.json. Original seal remains historical; do not compare current
active file to obsolete verified file bytes. Full active boundary file/digest/clock
must match activation result/completion.

Registered releasePlan creation follows completion. If absent, explicit
activateRecovery retry samples createdAt once and publishes it; status returns
COMPLETE_RELEASE_PLAN until then, which means **activateRecovery retry**, not a
ninth facade operation. Fresh/closed3 have no release records and may complete
activation with both releasePlan fields null. If an existing registered plan is
expired, preserve it; do not use activation retry to renew it.

Only genuinely absent records permit first time/ID sampling. Valid visible files
after sync uncertainty are reused verbatim with exact resync by explicit owner;
never regenerate activation time, plan creation/expiry, epoch, captured actors,
releasedAt, locator/intake/base/normalization/staged/closure timestamps. Unknown
pending is not absence and is not adopted/deleted. No filesystem rollback is
claimed for already visible publication after a later failed final check.

## 8. Genuine private release scope, two branches and authority

Proposed trusted private composition only:

```text
withRecoveryV5ReleaseScope(genuineRegistry,operation,ctx,
  inheritedBudget,trustedOwnerConsumer)
```

Authenticate registry and new private owner brand; trustedOwnerConsumer is a fixed
owned composition consumer, **not a caller-supplied terminal callback**. Resolve
actual source/hold/binding/marker internally. Carry original authentic budget;
acquire source -> workspace -> candidate once. Do not call a public old wrapper
that creates a fresh budget, add a bypass flag or weaken old target4 native5
release guard. Actual old guard is backup-registry.js:493-496; old release owns
its own budget at467, so it is not the new seam as-is.

### 8.1 Intent absent or marker absent: new publication

1. Validate entire Entry/Chain/Terminal, actual active PAUSED candidate/baseline,
   source/closure/isolation, held binding, selectors and exact auth-review subject.
2. If intent absent, resolve distinct release actors and independently authorize
   B1 release-hold-v5 binding for actual plan/source/target. Sample **internally in
   registry** once: releasedAt >= boundAt, activatedAt and plan.createdAt, and
   < plan.expiresAt. Persist durable release-intent.json before marker.
3. Existing intent is validated and exact-resynced first; no actor/time replacement.
   Before an **absent** marker is published, current freshness sample must be
   >= retained releasedAt and plan.createdAt, < plan.expiresAt, monotonic within
   invocation; original budget/current approval/source/auth-review/final gates apply.
4. Only private publisher input is `{stateEvidenceHash,minimumReleasedAt}`:
   stateEvidenceHash=completion hash, minimumReleasedAt=activatedAt. It uses the
   retained intent's internal releasedAt, not a new sample and not caller timestamp.
   Require exact matches if repeated within one scope, scope lifetime/reentry poison.
5. Marker publication/no-replace sync succeeds only under current checks; issue
   opaque current-live-frame receipt. Its identity is required before local
   release-result.json publication. JSON/old/copied receipt cannot authorize it.

The publisher shape/opaque identity precedent is backup-registry.js:498-543, but
that old code samples a missing marker directly. This new protocol adds durable
intent **before** marker with retained time; no old implementation change is claimed.
Expired plan with intent but no marker cannot publish even if the earlier reserved
releasedAt was within TTL. Preserve intent and return PLAN_STALE; no renewal.

### 8.2 Marker present: exact completion/replay

Require marker canonical-equal actual held.release and exact local intent/plan/
completion, selectors and bindings. No marker without local intent, no replacement
actors or time, no new mutation approval. This is expiry-exempt **completion-only**
release reconciliation, subject to current release reconciliation adapter,
admin/source/isolation/closure and mandatory auth-review. Revocation can deny success.

Every explicit exact retry validates/resyncs candidate, activationCompletion,
releaseIntent, actual marker and local releaseResult (publishing missing result
only after current-frame opaque receipt). Resync required existing plan/evidence
as their immutable publication contracts require. Close all candidate readers
before candidate sync/hash; recheck actual active file/digest/clock, current source,
identity, scope poison and authority after finalization. Existing visible files
are never assumed durable from visibility. No DB business/clock mutation on this
completion branch. Missing backup remains refusal, even after release; no cleanup.

| Release condition | Authorization / expiry / permissible work |
| --- | --- |
| Plan present, intent absent | Current independent release mutation approval/distinct pair; fresh plan; new internal sample and durable intent |
| Intent present, actual marker absent | Reuse/resync intent; same pair/current mutation approval/freshness before marker; expired => PLAN_STALE |
| Actual marker present, local result absent | Exact marker/intent equality; current release reconciliation, expiry-exempt; resync chain and publish local result via genuine receipt |
| Result and actual marker exact | Same reconciliation/current authority, expiry-exempt; exact resync then return retained result |
| Marker without intent, local result without actual marker, conflicting marker | EVIDENCE_MISMATCH; no reconstruction from local JSON |
| Source missing, unsafe file/close/unknown pending, authority denied | Fixed refusal; no repair, cleanup or partial success |

## 9. Total status protocol and single-subject action table

### 9.1 Observation order and frontier derivation

Current admin/source/closure/isolation + existing protected coordination + bounded
inventory precede disclosure. Validate a safe partial entry (§9.4), or **entire
Entry + Chain + Terminal**, with actual authoritative marker comparison whenever
release facts exist. If activationPlan exists, mandatory assertAuthReview after
chain validation and before disclosure, and again at final checks. Absent plan:
no call. No optional policy flag.

Derive first plan lacking result as planned/intended; otherwise verifyResult with
no seal => seal-pending; otherwise activation phaseResult => active-complete;
otherwise latest completed phase => ready-next; otherwise entry. For planned,
actual DB still must exactly match prior result/seal/entry boundary. For intended,
recognize settled same-intent state under central rules. Completed boundaries
require **actual file hash, state digest and clock** exactly equal retained result,
and seal when it is the current boundary. Conflicts throw, never demote completed
facts to initial or hide bad later records with historical success.

### 9.2 Exact status field/null correlation

| Frontier | phase | planHash / intentHash / resultHash | classification |
| --- | --- | --- | --- |
| entry, partial or complete before pausePlan | null | all null | null |
| planned | Plan's phase | plan nonnull; intent/result null | null; prior boundary inspected internally, not reported under another phase |
| intended | Current intent's phase | plan/intent nonnull; result null | Actual initial/committed/noop-matched/indeterminate |
| ready-next | Latest completed phase | all three nonnull for that same phase | committed or noop-matched according to its mode |
| seal-pending | verify | all three verify hashes nonnull | committed |
| active-complete | activate | all three activation hashes nonnull | committed, even if activationCompletion still missing |

entryState partial iff staged incomplete; stagedHash null iff partial. stageHash
always equals authenticated locator hash. sealHash/activationCompletionHash and
paired releasePlan fields are nonnull iff their exact valid records actually
exist. No “expected future hash.” writeMode null for partial even if a safe partial
candidate inspection occurred; otherwise actual inspected mode. After pause result
mode must be paused; before that native entry/initial enabled pause can be enabled.
Converted entry is paused. evidenceMode always observed, never durable.

Release-state total correlation:

| Source / actual evidence | releaseState |
| --- | --- |
| Fresh or closed3, regardless of holdId null | not-applicable; all release records/plan fields null |
| Registered, no releasePlan (including partial/preterminal) | unplanned |
| Registered valid releasePlan only | planned |
| Registered valid releaseIntent but no actual marker | intended |
| Registered exact actual marker, local result absent | marker-visible |
| Registered exact actual marker and local releaseResult | result-visible |

A registered partial holdId null remains unplanned, not not-applicable. Marker
with missing intent/plan, result with missing marker or invalid terminal prefix
throws; no status state legitimizes them. After staged, holdId is nonnull on every
registered route and must match genuine original/native hold.

### 9.3 nextAction priority and exhaustive reachable rows

First priority for **every intended phase**: valid complete-facts indeterminate
classification => MANUAL_RECONCILIATION. Then exact initial transaction with
expired phase plan => PLAN_EXPIRED. Exact committed/noop completion is not expired
merely because its mutation plan expired. Planned phase uses current plan expiry;
completed historical phases are not rejected by their old TTL. Apply release TTL
only at its actual new-marker publication frontier, not to completed marker replay.

| Reachable frontier/evidence | nextAction |
| --- | --- |
| Safe partial entry | RETRY_STAGE |
| Complete entry, no pausePlan | PREVIEW_PREPARE |
| pausePlan only, fresh | PREVIEW_PREPARE |
| pausePlan only, expired | PLAN_EXPIRED |
| pauseIntent initial, fresh | PREVIEW_PREPARE |
| pauseIntent committed or noop-matched | PREVIEW_PREPARE |
| pauseResult, no preparePlan | PREVIEW_PREPARE |
| preparePlan only, fresh | APPROVE_PREPARE |
| preparePlan only, expired | PLAN_EXPIRED |
| prepareIntent initial fresh or committed | RETRY_PREPARE |
| prepareResult, no verifyPlan | VERIFY |
| verifyPlan only, fresh | VERIFY |
| verifyPlan only, expired | PLAN_EXPIRED |
| verifyIntent initial fresh or committed | RETRY_VERIFY |
| verifyResult, no seal | RETRY_VERIFY |
| Seal present, no activationPlan | PREVIEW_ACTIVATION |
| activationPlan only, fresh | APPROVE_ACTIVATION |
| activationPlan only, expired | PLAN_EXPIRED |
| activationIntent initial fresh or committed | RETRY_ACTIVATE |
| activation phaseResult, no activationCompletion | RETRY_ACTIVATE |
| activationCompletion, fresh/closed3 route | NONE |
| activationCompletion, registered, no releasePlan | COMPLETE_RELEASE_PLAN (explicit activateRecovery retry, not ninth method) |
| releasePlan only, fresh | APPROVE_RELEASE |
| releasePlan only, expired | PLAN_EXPIRED |
| releaseIntent, actual marker absent, fresh | RETRY_RELEASE |
| releaseIntent, actual marker absent, expired | PLAN_EXPIRED |
| Exact actual marker, local releaseResult absent | RETRY_RELEASE, expiry-exempt |
| Exact local releaseResult plus actual marker | NONE |

All four phases' intended indeterminate cases use the top-priority action; all
initial transaction expiry cases use the second priority, including pause. Noop
matching is allowed only already-paused pause; prepare/verify/activate cannot use
it. Classification is not a reason to bypass current authority/closure/auth-review.
Unsafe/unreadable/contradictory prefixes throw fixed errors rather than inventing
partial facts. NONE means no remaining recovery action, not listener/time/cleanup
permission or enabled writes.

### 9.4 Safe partial entry, hold receipt gaps and coordination

Metadata-only partial status may inspect authenticated locator/stage/closure/
conversionSelection/exact hold receipt/copyIntent when candidate is **absent**, under
existing workspace coordination; no candidate coordinator or candidate facts are
needed for this bounded case. Never call a missing coordinator constructor to
make status possible. StageHash/path/route come from the locator, not guessed disk
paths. Safe partial reports entryState partial/frontier entry, null phase/
classification/three phase hashes/stagedHash/writeMode and RETRY_STAGE.

Once candidate, archive, normalization or intake inspection is required, the
appropriate existing candidate coordinator is required or refuse. A safely
inspected partial candidate still reports mode null/phase null/RETRY_STAGE; it does
not turn incomplete Entry into a phase receipt. Unknown pending/sidecars, changed
normalization without completion, or corrupt/untrusted locator throw. Missing
stage/closure is only the accepted exact-locator embedded-witness repair case for
explicit stage, not permission for status to write it.

Native hold cross-check absent **before staged**: call private B1 observer with
explicit holdId null, no discovery/enumeration, even if registry has a hold from a
lost response. Status may retain holdId null; explicit stage retry uses genuine
idempotent establishment for same run/stage to recover exact receipt. After staged,
missing required hold cross-check or actual hold is EVIDENCE_MISMATCH.

Converted registered has original `O/hold.json` exact ID available; partial status
may observe that original hold without writing V. **New completed-stage inventory
requires `V/hold.json`** as canonical original-hold cross-check. Pre-staged explicit
stage may publish it without creating a new hold; post-staged missing file is
mismatch. Fresh/closed3 forbid V/hold.json. This refines the accepted entry proposal's
previously optional converted local cross-check; it never changes old hold bytes,
stageHash, genuine authority or original O inventory.

Status source observation is no business/evidence mutation, publication, sync or
durability establishment. Existing validated registry/workspace/candidate lock
housekeeping via writable SQLite BEGIN IMMEDIATE/ROLLBACK is allowed; no extra
SQL/data change/COMMIT, no initialization/repair of missing lock DB, no raw fd open/
close/fsync of held coordination inode. B2 durable verify guarantees unchanged.

## 10. Exact physical namespaces and inventory

Let `R` be protected canonical workspace root, `V=R/v5-runs/<runId>` and
`O=R/runs/<runId>`. These are derived internal references, never caller filesystem
authority. Source registry has its own existing private coordination scope.

| Control / namespace | Exact location and ownership |
| --- | --- |
| Workspace coordinator | `R/requests/coordination.sqlite`, shared old/new workflows |
| New locator | `R/v5-requests/<SHA256(UTF8(JSON.stringify(requestRef)))>.json` |
| Native candidate coordinator | `V/coordination.sqlite` |
| Converted candidate coordinator | Original `O/coordination.sqlite`; **no second V candidate coordinator** |
| Native live candidate | `V/candidate.sqlite` |
| Converted live candidate | Original `O/candidate.sqlite` |
| Source coordinator | Genuine source registry's existing private lock; no public nested lock |

Old workspace mapping precedent is recovery.js:236-242. Constructor creates none
of these. Authorized stage creates owned directories/workspace coordination if
needed; under source + workspace collision control publish locator first, then
create native owned run/coordinator and enter candidate control. Converted uses
existing O coordinator and publishes new V evidence under that one control span.
Observation never creates coordination files or opens a nonexistent run lock.

### 10.1 Exact conversion archive trio

```text
O/conversion-archive-intent.json
O/conversion-archive.sqlite
O/conversion-handoff.json
```

Metadata basenames are **new explicit decisions here**, resolving deferred physical
inventory. Independent archive basename was already fixed by C2-A; it is never
`archive.sqlite`. All C2-A archiveIntent/conversionHandoff fields/hashes/copy/sync/
no-replace constraints remain unchanged. Old conversion inventory must gain exactly
these reviewed additions and transfer exclusion, not a wildcard allowing any
conversion-* file. Visible handoff excludes converter before obsolete current
posthash checks; old target4 exclusion remains permanent.

### 10.2 V record inventory, exact lower-case filenames

| File / artifact | Presence rule |
| --- | --- |
| `V/stage.json` | Both routes, exact locator.stage |
| `V/intake.json` | Both routes, unchanged C2-A intake of correct kind |
| `V/staged.json` | Both completed entries, last entry publication |
| `V/coordination.sqlite`, `V/candidate.sqlite` | Native only; forbidden as second converted candidate/control |
| `V/source-closed.json` | Native new B1 proof only in this first facade; converted retains original O/source-closed.json nonfresh |
| `V/hold.json` | Native required; converted registered required by completed staged; fresh/closed3 forbidden |
| `V/copy-intent.json`, `V/base.json` | Native only, dependency order; converted new files forbidden |
| `V/normalization-intent.json`, `V/normalization-completion.json` | Native only, exact spelling; intake before normalization, intent before writable open |
| `V/conversion-selection.json` | Converted only, exact B1 locator witness |
| `V/pause-plan.json`, `V/pause-intent.json`, `V/pause-result.json` | Both, contiguous plan/central intent/central phaseResult |
| `V/prepare-plan.json`, `V/prepare-intent.json`, `V/prepare-result.json` | Both, requires pauseResult; these are not public receipt files |
| `V/verify-plan.json`, `V/verify-intent.json`, `V/verify-result.json` | Both, requires prepareResult |
| `V/seals/<sealHash>` | Exactly one when seal present; suffixless; requires verifyResult; no alternate seal/hash regeneration |
| `V/activation-plan.json`, `V/activation-intent.json`, `V/activation-result.json` | Both, requires seal; phase tag activate for intent/result |
| `V/activation-complete.json` | Both, after activation phaseResult; exact activationCompletion |
| `V/release-plan.json`, `V/release-intent.json`, `V/release-result.json` | Registered only, contiguous terminal dependency order |
| Actual release marker | Only source registry `registry/releases/<holdId>.json`, never V/release-marker.json |
| Public stage/prepare/verify/activation receipts and status | Returned derived DTOs, no extra receipt/status authority files |

Plan/request witnesses embedded in locator stay embedded; no extra stageRequest
file. Old O stage/staged/source/hold/copy/normalization/conversion files retain
their accepted route inventory. No extra converted new-source-closed file is
introduced by this first facade; optional later new-owner attestation is not an
unannounced option here. Fresh has no original source/hold artifacts; closed3 no
registered hold; converted registered keeps original O hold and required V cross-check.

Own exclusive publication pending form is `.<lowercase-UUID>.pending`; only the
current owner may complete its known no-replace publication sequence. An unknown
pending file is preserved/refused, not “absent”, adopted or deleted even if bytes
look plausible. Bound inventory scans and all file/hash work to original authentic
budget. Existing coordination files are SQLite-owned; never raw-open/close/fsync
their held inode. Candidate/archive/evidence sync never authorizes source mutation.

## 11. Terminal/publication fault and retry matrix

| Observed window / counterexample | Required result / explicit action |
| --- | --- |
| Constructor called against uninitialized workspace | No initialization side effects; authorized stage owns later creation; status cannot repair |
| Locator durable, native run coordinator not yet created | Stage exact retry completes owned setup same run; metadata-only safe status may RETRY_STAGE under existing workspace lock |
| Native registry hold exists but V receipt lost before staged | Status explicit holdId null, no search; stage idempotent establish recovers exact hold/receipt |
| Converted V hold missing before staged / after staged | Before: stage can publish original canonical cross-check; after: mismatch, never new hold |
| Native normalization changed bytes/header without completion | INDETERMINATE even if logical equality; no auto-completion or journal bypass |
| Unknown pending, sidecar, unresolved close or ownership mismatch | Preserve/refuse; no phantom partial DTO, cleanup or repeated transaction based on guess |
| Activation intent exact prestate expired | PLAN_STALE, no reseal/replan/actor replacement |
| Activation committed exact poststate but phaseResult missing | Current central reconciliation may publish result after expiry; no COMMIT rerun, no obsolete seal live-byte check |
| Activation phaseResult visible, completion missing | Status RETRY_ACTIVATE; explicit retry resyncs candidate/result, validates full terminal/auth-review, publishes completion with reserved activatedAt |
| Completion present, registered releasePlan missing | Status COMPLETE_RELEASE_PLAN; explicit activateRecovery retry creates immutable plan once |
| ReleasePlan exists but expired | Status PLAN_EXPIRED; no activation retry renewal |
| ReleaseIntent published, marker absent | Retain sampled time/actors; resync intent, require current mutation approval and fresh plan/time before marker; expired cannot publish |
| Marker visible after uncertain sync, result missing | Exact authoritative-marker equality + current release reconciliation; expiry-exempt explicit resync and local result publication |
| Local releaseResult present, authoritative marker missing/conflicting | EVIDENCE_MISMATCH; no registry repair from receipt |
| Marker exists without local intent | EVIDENCE_MISMATCH; do not reconstruct sampled actors/time/intent |
| Valid completed marker/result but historical actor now revoked | Current reconciliation can deny; no replacement actor or hash-based disclosure |
| Status has activationPlan, authReview reference recognized only for another epoch | Mandatory exact tuple authorization fails EVIDENCE_MISMATCH before disclosure and at final checks |
| Intended pause/prepare/verify/activate has valid but unexplained complete state delta | Highest action MANUAL_RECONCILIATION, never stale-plan action hiding indeterminate state |
| Planned next phase with actual prior completed file hash drift | Throw evidence mismatch; do not combine next plan hash with prior intent/result/classification |
| Exact later phase completed, caller retries historical stage/prepare | Whole current frontier and terminal/source/auth/durability validation, retained historical receipt; no recopy/renormalize/reprepare |
| Released hold but original backup missing | Refuse; no source-proof reconstruction or cleanup authorization |

All visible immutable metadata is reused verbatim. File/directory sync uncertainty
is not absence or permission to resample. Native snapshot timeout/ownership and
explicit converter prerequisites remain their separate accepted contracts; this
facade adds no cancellation, auto-release, TTL cleanup, listener or production
time session. Active remains PAUSED, maintenance unanchored unless separately
authorized outside recovery; no source/anchor-history mutation is inferred.

## 12. Actual source map, proposal refinements and remaining gate

| Checked actual source | Consequence for this new proposal |
| --- | --- |
| recovery.js:186-197 | Exact eleven-field source policy order/values and raw canonical hash retained; supplied “12” count discrepancy explicitly flagged in §2.1 |
| backup.js:14-21 | Existing six lower-only limit ceilings retained |
| recovery.js:236-242 | Existing workspace coordinator is requests/, separate from source registry; new physical mapping shares it |
| recovery.js:989-991,1033-1054 | Exact assertAuthReview tuple/denial precedent; new status mandatory checks are additional proposed composition |
| recovery.js:1174-1177 | Old frozen eight-key facade remains old target4; no added ninth method |
| recovery-records.js:84-104 | Historical record/source/hold/binding/release field orders unchanged |
| backup-registry.js:129-182 | Actual version-family verification and native5 resync; private observation separation still needed |
| backup-registry.js:274-290,439-458 | Exact hold/binding/release correlations; genuine release observation active-only |
| backup-registry.js:464-543 | Old own-budget releaser, native5 guard, two-field publisher and opaque receipt precedent; not new inherited-budget intent protocol |
| backup-registry.js:579-585 | Existing internal operation backupId/runId/holdId/releasePlanHash/approvalRef order |
| registry-lock.js:74-99 | Existing writable coordination BEGIN IMMEDIATE/ROLLBACK housekeeping, not business/evidence publication |

This accepted document fixes deferred auth-review adapter name/mandatory status behavior,
terminal/release records and marker equality, nine receipt/terminal kinds, exact
eight operations, status single-subject/action matrix, coordination mapping and
archive metadata basenames. It explicitly refines converted V hold from optional
pre-staged cross-check to **required completed-stage inventory**. Cross-contract
status/enum/inventory references are reconciled separately without changing the
record/API tables, weakening the old4 guard or relabeling an existing codec.

Current instruction (2026-09-29): retain these accepted documents and pause further
development for [PRD closeout](im-v2-prd-closeout.md). No new source/fixture
assignment follows. Independent literal/golden vectors and native source-bound
fault/retry/authorization/lock/budget evidence remain unexecuted future work,
subject to a separate human scope decision. Module/file placement
and native operational mechanics must be
assigned in implementation scope, not exposed as extra caller options. No missing
public authority field is filled by a loose proof bag. Any reviewer-discovered
technical contradiction must be resolved explicitly rather than marking whole C2
complete. This text claims no test, runtime or operational acceptance.

## 13. Document-only checks and bounded handoff

Validate exact nine record orders, factory/operation/adapter/envelope orders and
types/null rules, receipt-versus-phase hash names, acyclic terminal dependencies,
status subject/action priority and inherited source citations. Check UTF-8/no BOM,
final newline, fences, relative links, whitespace and only current C2-B ledger
subitem change. Preserve all accepted contracts, source, tests/config/dependencies.

Writes are limited to this new document and that current ledger subitem. No other
files, tests/probes/DB/services/install, commit or push. Final text hashes identify
pending-review transcription only. Conceptual PASS does not authorize a writer;
whole C2 remains IN_PROGRESS and implementation/runtime readiness is not earned.
