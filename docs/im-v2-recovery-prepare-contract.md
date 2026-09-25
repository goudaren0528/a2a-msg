# P5-B stage / preview / prepare / status handoff

**Status: normative handoff with approved four-blocker amendment, NONRELEASE;
source corrections in progress, independent acceptance pending.**
Committed context: `2085da6f3400e7202710de0005575f1a9a290e85`.
The A `withRecoverySource` prerequisite has **SOURCE PASS; signature frozen;
bounded source-scope runtime QA PASS** (parent-reconciled gen72 evidence). All four
Oracle gaps are frozen below. **P5-B source exists; corrected-tree acceptance is pending.** The prerequisite
verdict covers its source scope and process tests, not whole-P5-B acceptance.
This source/contract-only repair records the approved B1-B4 amendment before
implementation. Independent test authors and parent review own acceptance.

References: [recovery design, especially §6](im-recovery-retention-v2-design.md),
[implementation plan, P5-B](im-v2-implementation-plan.md),
[A storage contract](im-v2-recovery-storage-contract.md), and committed stable
P1 [migration](../src/im/v2/migration.js) /
[schema](../src/im/v2/schema-internal.js). Links identify repository files;
the commit above identifies the context actually checked. The four-method B
surface and `candidateKind` input below refine the older full-lifecycle facade
and `kind` spelling in the design/plan. No P1 DDL or enum changes follow.

## 1. Frozen B surface and authority

Trusted in-process construction only:

```text
createImV2RecoveryServices({root,sourceCatalog,authority,approvalAuthority,
  evidenceAuthority,policy,clock=Date.now,limits})
  -> frozen {stageCandidate,previewRecovery,prepareRecovery,getRecoveryStatus}

stageCandidate({requestRef,candidateKind,sourceRef,isolationAckRef},ctx)
previewRecovery({runId},ctx) -> {preparePlan,preparePlanHash}
prepareRecovery({runId,preparePlanHash,approvalRef},ctx)
  -> {runId,candidateReference,newEpoch,status}
getRecoveryStatus({runId},ctx)
```

New prepare success has `status:"prepared"`; exact completed retries report the
actual prepared or consistent later state (§7), without repeating mutation.

All four methods are synchronous. There are no placeholder C verify, activation
or release methods. B owns its DB connections internally; operation inputs have
no paths, DB handles, caller plans, metadata, identity, epochs or writers. It
creates no listener, enables no writes, and adds no DDL.

- Every operation requires `authority.authorizeAdmin(ctx) === true`.
- Prepare requires
  `approvalAuthority.authorizeApproval({kind:'prepare',planHash,approvalRef},ctx)`
  to return literal `true`; `planHash` is the stored `preparePlanHash`.
- Nonfresh isolation requires
  `evidenceAuthority.assertSourceIsolation(sourceRef,isolationAckRef,ctx)`
  to return literal `true`.
- Every nonfresh source also requires the exact trusted proof and synchronous
  literal-true proof authorization in §2, including registered backups.
- Strict input shapes reject unknown fields. Adapter exceptions, truthy values
  and thenables refuse authorization; references alone authorize nothing.
  Known async callbacks/sinks are rejected before invocation, with zero prefix.
  Unexpected returned thenables are refused, their rejection observed and scope
  expired; already-started arbitrary async effects cannot be undone. Adapter
  errors are sanitized, never serialized as arbitrary exception details.

UUIDs are internally generated lowercase canonical UUIDs; hashes are lowercase
SHA-256 hex, times nonnegative safe integer milliseconds. References use the A
non-secret string bounds; `requestRef` has the exact identity rules in §4.
Limits retain A/P1 lower-only bounds and shared bounded verification/copy work;
no raised budgets or production fixture authority are implied.

## 2. Source catalog and the new A prerequisite

`sourceCatalog` is an immutable constructor table, not caller JSON routing:

```text
sourceRef -> {kind:'registered-backup',registry:genuineNEWregistry,backupId}
          | {kind:'closed-v3',source:genuinePrivateCapability}
```

| Candidate kind | Required actual source |
| --- | --- |
| `fresh_bootstrap` | `sourceRef=null`, `isolationAckRef=null`; no catalog source |
| `v3_import` | registered schema 3 in the NEW registry, or genuine closed v3 |
| `snapshot_recovery` | registered schema 4 in the NEW registry |

Kind/version mismatches and provenance downgrades refuse. Every old registered
v3 source first goes through A's verified independent-copy import into the new
registry. B never directly consumes an old registry. Old cleanup cannot remove
that new independent artifact.

**A prerequisite: SOURCE PASS, signature frozen; bounded source-scope runtime QA PASS:**

```text
withRecoverySource(registry,
  {backupId,recoveryRunId,stageHash,preparePlanHash:null|hash},context,callback)
```

The registry is authenticated by the module's private WeakMap, not duck typing.
One coordinator scope verifies the backup, finds or creates the durable stage
hold, optionally establishes the immutable prepare binding, then invokes the
synchronous callback with deeply frozen `record`, `sourceEvidence`, `hold`,
`binding` and scope-bound `copyTo`. Binding is null when this call supplies no
prepare-plan hash; it does not prove that no binding already exists on disk.
The existing A metadata-only/copy methods are not permission to synthesize this
combined scope by nesting public registry locks.

**Locator-first prerequisite (signature unchanged by this repair):**

```text
withRecoverySourceIntent(registry,{backupId},context,callback)
  callback({record,sourceEvidence,establish})
  establish({recoveryRunId,stageHash,preparePlanHash:null|hash})
    -> {record,sourceEvidence,hold,binding,copyTo}
```

The genuine new-registry facade is private-WeakMap authenticated. Admin authority
must synchronously return literal true; the outer input has exactly `backupId`.
One held source coordinator and one bounded budget cover source verification,
callback, establishment and final verification. Initial frozen proof exposes no
copy capability. `establish` fixes the outer backup identity internally, durably
creates or exact-retries the stage hold and optional binding using private locked
helpers, then returns frozen proof with a scope-bound copy capability. Identical
same-scope calls return the same result. Invalid/conflicting/reentrant establishment
poisons the scope even when caught; further copying is refused and the outer call
fails. Escaped establishment and copy capabilities expire at scope end. No
establishment means no hold or binding is created. A durable hold survives any
later callback failure; no filesystem rollback or candidate cleanup is promised.
This API proves neither that B saved a locator nor that a candidate exists; it
accepts no `stagePersisted` assertion or caller path.

The callback owns its private destination sink and completes destination
verification before returning. No raw source path or registration writer escapes;
copy expires with scope. Durable hold precedes any backup-to-candidate copy.
Acquire source/registry before candidate control, then the candidate transaction;
never nest a public registry lock inside this scope. Exact hold/binding retries
retain original identities and bytes and reestablish durability under A rules.
B never releases holds, including on failure.

### Closed-v3 capability and evidence authority

`createClosedV3Source({path,sourceRef,evidenceAuthority})` is a trusted constructor
only; operation-time paths are rejected. Its genuine private capability requires
externally trusted source isolation, not a ping or missing process response.
Literal-true isolation precedes readonly actual-v3 validation and streaming copy;
source hash/inode stability and isolation are rechecked afterwards. Reject every
WAL/SHM/journal, including empty residue; do not checkpoint or delete source
sidecars. Closed-source inspection cannot manufacture closure of a live DB.

For **every nonfresh** source, including registered backups, use:

```text
evidenceAuthority.getSourceClosedEvidence(binding,ctx) -> exactProof
evidenceAuthority.authorizeSourceClosedEvidence(proof,ctx) === true

binding = {sourceRef,isolationAckRef,sourceKind,instanceId,instanceCreatedAt,
 schemaVersion,schemaChecksum,fileHash,backupId,manifestHash}
proof = {version:1,evidenceRef,sourceRef,isolationAckRef,sourceKind,instanceId,
 instanceCreatedAt,schemaVersion,schemaChecksum,fileHash,backupId,manifestHash,
 issuedAt}
```

Both shapes have exactly the ordered fields above. `sourceKind` is
`registered-backup|closed-source`, `schemaVersion` is 3 or 4 (closed source is 3),
and closed-source `backupId/manifestHash` are null. Validate strict shapes, safe
refs, UUIDs, hashes and times; every binding field in the proof must exactly match
B's binding derived from the **actual verified source**. Proof/binding `sourceRef`
is the external catalog reference. For a registered backup,
`fileHash` is the snapshot hash, not a claim about current live-source bytes.
Known async adapters refuse before invocation; returned thenables refuse;
authorization must synchronously return literal true, with sanitized errors.

Preserve the complete proof at `runs/<runId>/source-closed.json` and bind its
`evidenceRef` and canonical hash in stage. Fresh has null evidence and no proof
file. Retry reads the **original proof**, compares the current actual source
binding, rechecks isolation and reauthorizes that proof. Do not regenerate
`issuedAt` or source `observedAt` merely because time passed. Changed source or
isolation reference conflicts; backup existence and arbitrary strings are not
proof. This is trusted operational evidence, not machine-global isolation proof.

## 3. Frozen source evidence and B RPO scope

Registered evidence is the **exact A output**, retained without remapping. Its
`sourceRef` is A's `backup:<backupId>`, not the external catalog key; stage binds
the catalog key separately. Preserve native/imported registryFormat and the
original manifest evidence. Imported v3 retains A's hash of the complete raw old
record bytes; never fabricate or drop its backup provenance.

Closed-source evidence has this exact ordered shape:

```text
{version:1,kind:"closed-source",sourceRef,instanceId,instanceCreatedAt,
 schemaVersion:3,schemaChecksum,closedSourceFileHash,observedAt,isolationAckRef}
```

Identity, schema/checksum, hash and observation come from actual protected source
inspection. Closed-source `observedAt` and stage `createdAt` retain their first
actual observation values on retries. Fresh `sourceEvidence`,
`sourceClosedEvidenceRef` and `sourceClosedEvidenceHash` are null.

B deliberately emits **unknown-only** RPO for every nonfresh source, in this
order (fresh `rpoReport=null`):

```text
{status:"unknown",snapshotCompletedAt,sourceObservedAt,
 missingAcceptedCount:null,missingAckCount:null,missingReadCount:null,
 comparisonEvidenceHash:null,authChanges:"unknown",notesCode}
```

`snapshotCompletedAt` is real registered-backup `completedAt`, otherwise null.
`sourceObservedAt` is the actual closed-source observation, otherwise null.
`notesCode` is `COMPARISON_INCOMPLETE`, or `SOURCE_UNAVAILABLE` only when genuinely
unavailable. Unknown RPO does not waive required source/closure validation.
No measured API, caller counts, count subtraction, comparison-proof fiction or
auth-review completion is introduced by B.

## 4. Immutable request, stage and staged records

External records use their explicitly declared versions below and ordered ordinary-object
`JSON.stringify`, UTF-8, no BOM, formatting whitespace or trailing newline,
at most 65536 bytes. Strict read
validation reencodes and byte-compares; hashes cover original canonical bytes.
Publish exclusive pending -> file sync -> hard-link no-replace -> unlink only
own pending -> directory sync. Final records are immutable, never overwritten.
Each locator, stage and proof independently satisfies the 64 KiB bound; reject
oversize before publication. A visible file after uncertain fsync is not durable
success: retry resyncs file and directory. A pending file is not a completed
locator and cannot be deleted to bypass its recovery constraints.

`requestRef` is 1..255 **UTF-16 code units**, contains no C0/DEL, and is compared
exactly without NFC normalization. Its locator is:

```text
requests/<SHA256(UTF8(JSON.stringify(requestRef)))>.json
requestHash = SHA256(UTF8(JSON.stringify(
  [candidateKind,sourceRef,isolationAckRef,policyHash])))
```

The locator must compare the raw `requestRef`, not trust only its filename hash.
Its exact ordered DTO is:

```text
{version:1,requestRef,requestHash,runId,stage,sourceClosedEvidence,stageHash}
```

`stage` is the complete ordered stage record; `sourceClosedEvidence` is the full
proof or fresh null. `stageHash` hashes canonical stage bytes, with no locator
self-hash cycle.

Generate the internal run UUID and applicable preparation ref once. Derive
`candidateReference = runs/<runId>/candidate.sqlite`; fresh/import preparation
refs are internal, snapshot `preparationRef=null`. Under proper source/workspace
control, persist the **locator FIRST**, as the irreversible requestRef-to-runId
  promise; then create the run directory, full proof (nonfresh) and stage. Verify
  their bytes agree with the embedded records, **then** establish the hold and
  create/copy the candidate. For registered backup new-stage and locator repair,
  enter `withRecoverySourceIntent` first, use its verified source metadata for
  closure evidence and locator/stage publication, then call `establish` only
  after the durable embedded locator/proof/stage records agree. Copy the candidate
  using the returned capability before the callback returns. A scope ending
  without `establish` publishes no hold; locator repair must retain the original
  run identity. B, not A, enforces the persisted-locator-before-establish order.

A complete locator with missing stage/proof requires source/isolation
reverification, then publication of the missing embedded records for the **same
run**. Mismatches never overwrite. An orphan run/candidate without an authenticated
locator is indeterminate, not adopted or assigned a new UUID. Same requestRef
with changed parameters is `RECOVERY_INVALID`; same parameters with changed
actual source is `RECOVERY_EVIDENCE_MISMATCH`.

Exact ordered records:

```text
stage.json = {version:1,requestRef,requestHash,runId,candidateKind,sourceRef,
 sourceEvidence,sourceClosedEvidenceRef,sourceClosedEvidenceHash,isolationAckRef,
 policyHash,candidateReference,preparationRef,createdAt}

staged.json = {version:1,runId,stageHash,candidateBaseHash,preparationRef,
 instanceId,instanceCreatedAt,initialEpoch,importEpoch,stagedAt}
```

`stageHash` hashes canonical `stage.json`. `candidateBaseHash` is null for fresh,
otherwise the verified independent copy's hash **before mutation**, matching the
registered file hash or closed-source file hash. `sourceClosedEvidenceHash`
immediately follows its ref and hashes the canonical full proof; both are null
for fresh. `initialEpoch` is P1's actual initial epoch for fresh/import. Snapshot
`initialEpoch` is the **copied actual current `center_epoch`**, not a preparation's
initial epoch; snapshot `preparationRef/importEpoch` are null. V3 `importEpoch`
comes from P1; fresh `importEpoch` is null. Snapshot recovery `newEpoch` is
generated once at preview and persisted.

## 5. Candidate ownership and staging

Use a private coordinator per controlled run under the approved SQLite lock
rules: no raw open/close of a held coordination inode, stable protected paths,
0700 directories/0600 files and trusted ancestors. Internally owned candidate DB
connections are separate from the source capability. No source connection or
candidate handle is supplied by an operation caller.

- **Fresh:** exclusive owned candidate, actual P1
  `initializeImSchemaV4(db,{policy,creationRef,limits})` on the owned DB; prepared
  and paused. Identity/time/initial epoch come from actual P1 output.
- **V3:** stream to independent exclusive pending storage; verify the base hash
  and publish candidate-base evidence before modification. Pause **only the new
  candidate**, recording that action; explicitly invoke
  `migrateImSchemaV4(db,{expectedVersion:3,policy,migrationRef,limits})` with the
  internal migration ref. Do not alter the source or original backup, even if
  its write mode was enabled.
- **Snapshot:** copy a verified registered v4 backup. The staged candidate may
  retain the old active marker, but is a sealed-off workspace, never server
  input. Prepare performs the new epoch/state transition.

Stage hold is durable before registered candidate copy; closed v3 and fresh
have no fake hold. `staged` is an external workspace state, not a new DB enum.
P1 generates IDs/epochs and uses its own actual time; facade clock cannot preselect
them. If P1 completed before `staged.json` publication, retry validates the actual
persistent preparation and recovers its IDs instead of rerunning identity creation.

### Approved B2/B3 finite amendment: copy, normalization and pause

This amendment changes external evidence only: no A/P1 DDL, checksums, source
authority, staged fields or prepare-plan fields change. Old experimental B
`base` v1 is unsupported/indeterminate, never auto-accepted; it was not released.
Every nonfresh route (closed v3, registered v3 and registered v4) uses the exact
ordered records below. Fresh creates none of these records and stays actual P1
DELETE-mode initialization.

```text
copy-intent.json = {version:1,runId,stageHash,candidateReference,
 candidateBaseHash,sourceSchemaVersion,sourceSchemaChecksum,sourceWriteMode,
 copyStartedAt}
base.json = {version:2,runId,stageHash,candidateReference,copyIntentHash,
 candidateBaseHash,sourceSchemaVersion,sourceSchemaChecksum,sourceWriteMode,
 copyStartedAt}
normalization-intent.json = {version:1,runId,stageHash,baseRecordHash,
 candidateReference,candidateBaseHash,originalHeaderMode,targetHeaderMode:"DELETE",
 createdAt}
normalized.json = {version:1,runId,stageHash,normalizationIntentHash,
 candidateBaseHash,normalizedCandidateHash,changed,normalizedAt}
pause-intent.json = {version:2,runId,stageHash,candidateBaseHash,
 normalizedRecordHash,pauseInputHash,originalWriteMode,targetWriteMode:"paused",
 createdAt}
paused.json = {version:2,runId,stageHash,pauseIntentHash,candidateBaseHash,
 pauseInputHash,pausedCandidateHash,changed,pausedAt}
```

`copyStartedAt` is sampled before candidate copying and remains fixed forever;
there is no `copiedAt`. All copy/base facts come from real verified source bytes.
A's genuine proof exposes a bounded `copyTo`, not source mode/path/DB access.
B may first create a protected independent `source-verified.sqlite` through that
capability, within the same held source scope and after the durable A hold. It
must verify exact source hash, schema/checksum, identity and actual write mode
using the closed-snapshot reader before publishing the copy intent. This local
verification artifact is never source authority; the genuine source scope is
still required on every operation. Failed evidence is retained.

Order is source -> workspace -> candidate: durable locator/proof/stage, A hold,
verified source facts, copy intent, exclusive pending copy + fsync + source hash,
no-replace candidate publication, closed-snapshot verification and base v2.
The immutable reader is permitted only for these source-bound, proven completed,
sidecar-free copies, including legal WAL header 2/2. Existing candidate with no
base requires matching original copy intent, locator and current verified source,
no unknown pending, protected single-link file, no sidecars and exact source hash,
schema/identity/mode. Resync file/directory and publish the same base with the
original `copyStartedAt`; never recopy or overwrite. Partial/modified bytes,
missing intent or source mismatch remain manual indeterminate.

Normalize only the exclusively controlled candidate. Verify base hash and no
sidecars, then durably publish intent before mutation. `originalHeaderMode` is
`DELETE|WAL`. DELETE does no writable open or journal PRAGMA: changed false and
normalized hash equals base. WAL uses a module-owned SQLite connection, busy 0,
synchronous FULL, checkpoint and `journal_mode=DELETE`; reject BUSY or uncertain
close. SQLite alone removes sidecars. Verify same inode, no WAL/SHM/journal,
header 1/1 and complete bounded type-preserving logical row/schema digests before
and after, not counts alone. Stream at most one BLOB in memory with the shared
operation budget. Sync candidate and directory before normalized publication.

Intent plus exact base bytes/no sidecars can retry normalization. Changed bytes
with missing normalized record (even header DELETE) are manual indeterminate;
never adopt an unknown hash or reconvert. Before a later phase starts, current
hash must equal normalized hash. After a legitimate later phase, validate its
full chain rather than obsolete base/normalized bytes.

V3 order: base -> normalized -> pause v2 -> P1 migration -> staged.
`pauseInputHash=normalized.normalizedCandidateHash`. Original paused requires no
UPDATE, changed false and paused hash equals pause input, which may differ from
base after WAL normalization. Original enabled performs candidate-only pause.
Pause commit without paused proof permits retry only while bytes still exactly
equal pause input; otherwise preserve evidence for manual reconciliation. Validate
the entire copy/normalization/pause chain before recovering actual P1 preparation
refs/IDs after P1-complete/staged-missing. Snapshot order is base -> normalized ->
staged -> preview -> prepare: before this run's recovery row, verify normalized
hash; afterwards validate durable plan/run/center. Registered DB candidate base
and staged base remain the ORIGINAL backup hash; closed-v3 DB quartet stays null.

Pure `validateRecoveryNormalizationBindings({stage,copyIntent,base,
normalizationIntent,normalized})` and extended `validateRecoveryPauseBindings`
require every record. Bind run, stage hash, derived candidate ref, actual stage
source version/checksum/base hash, all canonical chain hashes and source mode.
All step times are safe/nondecreasing; rollback refuses new timestamps, never
rewrites old proof. Pure validation claims no file-state or approval authority.
Canonical 64 KiB bounds, deep freezing, E1/E2 identity proofs and nullable status
rules remain intact. Missing/contradictory chains yield readonly manual status.

Normalization query budget: use the existing operation budget across verification
copies, hashing, both logical scans and publication; no fresh budget per scan.
Project the existing P1 row/content limits before each logical scan. Read schema
objects with `maxMetadataEntries+1`, at most 128 columns per frozen table and
`maxMessages+maxOtherRecords+1` rows per table; overflow refuses. Stream in rowid
order, include row identity and every column with SQLite storage-class tags,
length framing, exact text bytes, integer values, REAL bits and BLOB bytes. Hash
full logical schema plus user version/application ID/encoding, excluding physical
root-page placement. Bound each complete logical byte stream by `maxFileBytes`
in addition to the projected content limit; time checks share the operation's
original deadline. Only the frozen tables are accepted for normalization.

Exact stage success DTO:

```text
{runId,candidateReference,status:"staged",stageHash,preparationRef,instanceId,
 instanceCreatedAt,initialEpoch,importEpoch,holdId}
```

Return it only when the actual candidate and durable staged record agree;
`holdId` is null for fresh/closed source. External staged status does not confer
DB service authority.

## 6. Frozen prepare plan and actual-schema mapping

Persist `runs/<runId>/prepare-<preparePlanHash>.json` using the canonical rules:

```text
{version:1,runId,candidateKind,preparationRef,instanceId,instanceCreatedAt,
 backupId,backupFileHash,manifestHash,sourceSchemaVersion,sourceSchemaChecksum,
 candidateReference,oldEpoch,newEpoch,recoveryCounter,policyHash,rpoReport,
 sourceEvidence,sourceClosedEvidenceRef,isolationAckRef,createdAt,expiresAt}
```

`preparePlanHash` hashes the entire canonical plan, including full source evidence.
Its field set is unchanged: **do not add `sourceClosedEvidenceHash` to the plan**.
Validate the proof chain through `stageHash`, stored stage/ref/hash and full proof,
even though the approved plan hash has no new proof-hash field.
`expiresAt=createdAt+300000` requires safe integer addition; valid iff
`now<expiresAt`. Repeated preview returns the original persisted plan, without
new identity/epoch or overwrite. Expiration reports PLAN_STALE semantics using
the local `RECOVERY_PLAN_STALE` code; B does not silently refresh the same run.

| Kind | Plan and epoch rules |
| --- | --- |
| Fresh | P1 fresh preparation, actual identity, `newEpoch=initialEpoch`, counter 0; old epoch, backup fields, source-schema fields, RPO and all source/isolation evidence null |
| Registered v3 import | P1 import preparation and actual identity; `newEpoch=initialEpoch`, counter 0, `oldEpoch=null`; real backup trio, source schema 3/checksum, RPO and closure/isolation evidence present |
| Closed v3 import | Same P1 epoch/preparation rules; plan backup trio null, source schema 3/checksum and real closed-source/RPO/isolation evidence present |
| Snapshot | `preparationRef=null`, actual backup identity/schema 4/checksum and backup trio; old epoch from candidate; new epoch generated once at preview, safely incremented recovery counter; RPO/closure/isolation evidence present |

The **actual P1 DB backup quartet** in `im_recovery_runs` is
`backup_id,backup_file_hash,manifest_hash,candidate_base_hash`. It is all present
for registered v3/snapshot, all null for fresh/closed v3. Registered candidate
base equals the verified pre-mutation backup hash. Closed-v3 `staged.json` still
retains its real copy hash, but its DB quartet is entirely null. Plan
`sourceSchemaVersion/sourceSchemaChecksum` are separate evidence fields, not DB
backup columns; closed v3 keeps them. No fake backup, new column or DDL is needed.

## 7. Prepare transaction and exact retries

Read the protected stored plan and validate its canonical hash, run/stage/policy
and source binding. Reverify source, hold/binding, trusted isolation and the
original source-closure proof authorization, obtain prepare approval, then take
candidate control in source-before-candidate order.
For a new prepare mutation on an existing verified stage, use the existing
`withRecoverySource` scope with this plan hash so the immutable binding is durable
before the candidate write phase. Fully validate the actual candidate. Exact
completed-prepare retries instead use `withVerifiedBackup` and previously obtained
`getHold` evidence, acquired outside workspace/candidate locks, solely to reverify
the persisted proof. They create **no** new hold or binding and do not call the
hold-writing scope; C's future release proof may require revising this readonly
hold strategy. Status likewise uses readonly verification and never creates
hold/binding records.

Within a fresh-clock transaction, reauthorize and recheck approval, isolation/proof,
identity/epoch/state and `now<expiresAt`; bind `approved_plan_hash` and approval
to the actual run. Fresh/import retain P1's initial epoch. Snapshot inserts the
approved new epoch and safe higher counter, sets run/center prepared and write
mode paused. Invalidate existing leases; preserve old epochs, lease_requests,
messages, send keys/mappings, genuine ACK/read and historical progress/receipts.
New-epoch progress is based on the **actual maximum contiguous genuine ACK
prefix**, not an old expiry receipt or a possibly lagging persisted cursor;
stream identity is preserved. No source facts are rewritten.

**B1:** New prepare has no bare-clock expiry rejection before `prepareDatabase`.
Structural/source/admin/approval prechecks remain; authoritative entry and final
expiry checks execute inside `runWriteFresh`. Equality expires while persisting
the observed clock floor, so a subsequent rollback clock refuses even on a new
connection. Completed exact retries precede guard/expiry/new binding writes.

**B4:** A shared observed-state check applies to ALL authoritative prepare bindings,
including STAGED: a binding without the stored plan or with a different plan hash
means preview/prepare `RECOVERY_EVIDENCE_MISMATCH`, readonly status indeterminate /
`MANUAL_RECONCILIATION`. Matching response-loss retry is legitimate. Never mint a
plan/new epoch to fit an immutable binding, overwrite/delete it, or replace A
authority with a local hold receipt.

Perform a final fresh expiry check before commit, then close/persist owned
connections. B has no C seal yet, so pre-seal clock anchor writes are permitted;
this does not relax C's future seal-before-anchor rule. Exact run/plan completed
retries, including lost response, return the actual prepared or consistent later
state from completed proof, **without new writes or epochs**, despite expiration
of the old approval. This readonly completion path precedes mutation-only
approval/expiry and binding-write steps; it does not authorize new mutation with
expired approval. New mutation still requires the fresh 300000 ms plan TTL and
approval, with equality expired. Never overwrite active facts with failed,
downgrade or reprepare later C states. Uncertain commit/close/fsync retains
hold/files and requires evidence reconciliation, not fabricated failure.

## 8. Readonly status and partial-state reconciliation

Exact safe status field set:

```text
{runId,candidateReference,state,stageHash,preparePlanHash,newEpoch,holdId,
 writeMode,nextAction}
state = "staged" | "prepared" | "verified" | "active" | "failed" | "indeterminate"
writeMode = null | "paused" | "enabled"
```

Hashes, epoch, hold and other nullable facts are null when unknown, never
fabricated. B produces only staged/prepared transitions; status may readonly
recognize consistent later C verified/active facts without downgrade/reprepare.

| Reconciled evidence | state / nextAction |
| --- | --- |
| Recoverable missing stage | `indeterminate` / `RETRY_STAGE` |
| Staged, no plan | `staged` / `PREVIEW_PREPARE` |
| Staged, valid plan | `staged` / `APPROVE_PREPARE` |
| Staged, expired plan | `staged` / `PLAN_EXPIRED` |
| Prepared | `prepared` / `P5C_VERIFY_REQUIRED` |
| Consistent later verified | `verified` / `P5C_SEAL_ACTIVATION_REQUIRED` |
| Consistent later active | `active` / `NONE` |
| Trusted failed | `failed` / `MANUAL_RECONCILIATION` |
| Partial candidate, missing pause proof, contradictions or unknown WAL | `indeterminate` / `MANUAL_RECONCILIATION` |

`NONE` is not listener/write permission. Invalid run UUID is `RECOVERY_INVALID`;
no durable evidence is `RECOVERY_NOT_FOUND`, a new **local management** code, not
a wire code. Corrupt evidence with a still-trusted run/candidate binding yields
indeterminate; inability to authenticate that binding yields
`RECOVERY_EVIDENCE_MISMATCH`.

Status returns safe internal references, no raw paths, secrets or source content.
It reconciles persisted evidence, not an in-memory map. It performs **zero writes**:
no clock guard/anchor, lock-file creation, checkpoint, repair or sidecar deletion.
Use existing candidate control only. Candidate WAL must not be hidden with
`immutable=1`; readonly observation must account for committed
WAL or return indeterminate. The closed standalone backup reader is not a live
candidate status shortcut. Unsupported/unprovable evidence remains fail-closed.

Partial copy or unknown identity refuses overwrite/adoption. Partial locator
publication keeps the original run. P1-complete/staged-record-missing retries use
actual preparation; prepare-commit/lost-response retries use exact completed
proof. Fsync/close uncertainty retains files and holds. `failed` requires actual
failure evidence and never erases active facts. Status is not terminal proof for
release; B has no release operation. Retry actions describe a separate authorized
operation; status itself never repairs records.

## 9. Ordered implementation and evidence ownership

1. A scope prerequisite: `withRecoverySource` has SOURCE PASS and a frozen
   signature and prior bounded runtime QA. This repair consumes the existing
   locator-first `withRecoverySourceIntent`; it changes neither A API nor authority.
2. Then implement the now-frozen pure B encoding in
   `src/im/v2/recovery-plan.js`.
3. One B core owner writes `recovery.js`, `recovery-candidate.js`,
   `recovery-source.js` under `src/im/v2/`; the same owner handles needed
   `recovery-records.js` encoder extensions under parent-assigned write scope.
4. B evidence covers all four source routes, new-process exact retries and
   conflicts, durable hold-before-copy, candidate-only v3 pause, approval
   expiry/revocation and final-check rollback, async zero-prefix refusals,
   source drift/provenance refusal and readonly status zero writes. Tie execution
   evidence to the actual tree. C/D retain terminal proof, release, seals and the
   full crash/response-loss matrix.

H1 still gates real isolation, RPO/auth review and production switching. H2 gates
policies, actual deletion and backup retention; 30 days is unconfirmed. H3 gates
network/listeners/deployment/cost. Local fixture approval is not production
authorization. This four-file source/contract lane supplies bounded source-only
checks; independent tests/review must reconcile the corrected tree. It supplies
no whole-P5-B acceptance or release PASS.

## 10. Oracle gaps NOW FROZEN; remaining implementation gates

| Resolved gap | Frozen decision location |
| --- | --- |
| Trusted closed evidence | §2 exact binding/proof and adapters; original proof retention, actual-source matching and reauthorization for all nonfresh sources |
| Request locator and publication | §4 exact embedded-record DTO, locator-first irreversible run promise, missing-record recovery and conflict/durability rules |
| Record versions, epochs and pause evidence | §§4-5 copy/normalization v1, base/pause v2; unchanged stage/proof/plan, actual snapshot epoch and conservative crash rules |
| Stage/status DTO and reconciliation | §§5, 7-8 exact stage result, readonly completed retry, status states/actions/nullability and local errors |

`withRecoverySource` retains its previous bounded source-scope result.
The existing `withRecoverySourceIntent` remains the locator-first prerequisite.
Parent independent source/code/QA review follows completion of the independent
prepare-guard and normalization/pure-fixture test-author lanes. Existing tests
that assume bare expiry never writes a clock floor need an authorized test-owner
update. No execution acceptance is claimed by this document.

C/D retain seals, terminal/release authority and the full crash matrix; measured
comparison is outside B's unknown-only scope. These are later implementation and
evidence gates, not unresolved B technical choices. P1-P4 semantics, P5-A quotas,
locking and write boundaries remain as approved.
