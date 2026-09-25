# P5-C verify / activation / hold-release implementation handoff

**Status: approved finite behavior contract with parent-approved C1 durability
and C2 publication-time corrections; NONRELEASE only; runtime acceptance pending.**
Checked source baseline: `9e3bca504f93c2b1f40762e0d582c72bd4bc379d`.
C0 interfaces in §10 are frozen except for the explicitly parent-approved C2
private publisher minimum-time amendment below. Following the four terminal C1
reviews, the parent approved the narrow retry/observation semantics in §§6/8/9 below. This
correction does not grant runtime acceptance, P5 completion or release approval.

References: [design §6](im-recovery-retention-v2-design.md),
[P5 implementation plan](im-v2-implementation-plan.md),
[B prepare contract](im-v2-recovery-prepare-contract.md), and
[A storage contract](im-v2-recovery-storage-contract.md).
Source checks used [recovery-plan.js](../src/im/v2/recovery-plan.js),
[recovery.js](../src/im/v2/recovery.js),
[recovery-candidate.js](../src/im/v2/recovery-candidate.js),
[recovery-source.js](../src/im/v2/recovery-source.js),
[backup-registry.js](../src/im/v2/backup-registry.js),
[recovery-records.js](../src/im/v2/recovery-records.js), and the existing
[P1 schema/validator](../src/im/v2/schema-internal.js).

## 1. Scope and explicit supersession

C adds verification, activation, active-only release and their readonly evidence
reconciliation to B. A/B source provenance, locator-first staging, normalization,
prepare identity/epoch and approval architecture remain the established basis.

The following are explicit C extensions to older wording, not descriptions of
the checked implementation:

| Earlier contract / checked code | C extension governing implementation |
| --- | --- |
| B facade has four methods | Add the four synchronous methods in §2; retain factory options |
| Design activation input omits `runId`; activation plan omits `version` | Use the exact input and version-1 record below |
| Design/plan verify mentions proactive WAL checkpoint | Current C candidates must already be DELETE-mode, sidecar-free; reject unknown/non-DELETE state, do not checkpoint it into acceptability |
| B `readScope` obtains `getHold` before taking source/workspace/candidate control | Consume A's new single-coordinator `withRecoveryHold`; candidate control is inside its callback |
| A `holdLocked`/`scanHolds` and B source reader reject every release file | Strictly decode releases and let C match them against actual completion; a consistent release is not automatically indeterminate |
| Design allows active or failed release | Current C supports **active only**; no approved failure-terminal workflow exists |
| B status has the strict unversioned field set called v1 here | Extend explicitly to status v2 after the parent chooses §10; never silently pass extra fields through the v1 decoder |

B's candidate-only WAL-to-DELETE normalization remains a staging operation. Its
immutable reader allowance for proven completed source copies is not permission
to ignore candidate WAL during C. No P1 DDL, enum, historical checksum, P1/P4
semantics, new migration or failure-transition workflow is introduced. B's RPO
report stays unknown-only; auth review does not rewrite that report.

## 2. Frozen facade and authority

Trusted in-process factory options are unchanged:

```text
createImV2RecoveryServices({root,sourceCatalog,authority,approvalAuthority,
  evidenceAuthority,policy,clock=Date.now,limits})

verifyRecovery({runId,preparePlanHash},ctx)
  -> {runId,status:'verified',sealReference,sealHash}
previewActivation({runId,sealReference,authReviewRef,isolationAckRef,activationRef},ctx)
  -> {activationPlan,activationPlanHash}
activateRecovery({runId,activationPlanHash,activationApprovalRef,sealReference},ctx)
  -> {runId,candidateReference,newEpoch,status:'active',writeMode:'paused',activationRef}
releaseRecoveryHold({runId,holdId,releasePlanHash,approvalRef},ctx)
  -> {runId,holdId,state:'released',releasePlanHash}
```

The C1 facade has **seven methods**: the four existing B methods plus verify,
activation preview and activation. `releaseRecoveryHold` is reserved for C2,
which will bring the facade to eight methods and explicitly migrate runtime
status to v2. C1 has no release placeholder or release-writer construction.
Strict operation shapes reject unknown fields. No operation accepts a
path, DB handle, caller plan/proof, verifier, terminal boolean, identity or epoch.
The factory owns candidate/coordinator/source connection lifecycles. References
are non-secret bounded identifiers, not permission or general path accessors.

- Every operation requires `authority.authorizeAdmin(ctx) === true`.
- New activation requires
  `approvalAuthority.authorizeApproval({kind:'activate',planHash,approvalRef},ctx)
  to return literal `true`, binding the stored `activationPlanHash` and supplied
  `activationApprovalRef`. Prepare approval does not satisfy this gate.
- Release independently requires the same adapter with `kind:'release-hold'`,
  `planHash:releasePlanHash` and the supplied `approvalRef`, returning literal true.
- Existing nonfresh `assertSourceIsolation(sourceRef,isolationAckRef,ctx)` and
  original source-closure proof authorization remain mandatory. Reauthorize the
  stored proof against the actual protected source; do not mint a replacement
  proof timestamp or substitute backup existence for closure.
- Auth review uses the new method on the **existing** evidence adapter:
  `evidenceAuthority.assertAuthReview({runId,preparePlanHash,sealHash,newEpoch,authReviewRef},ctx) === true`.
  It is required for all candidate kinds and is independent of activation
  approval. The binding comes from validated stored records, not caller claims.

Known async functions/callbacks/adapters are rejected before invocation, with
zero executed prefix. Unexpected returned thenables are rejected, rejection is
observed, and any scope-bound capability expires. Truthy/falsy substitutes and
adapter exceptions never authorize. Already-started arbitrary async effects
cannot be undone. Use fixed sanitized local errors, never raw adapter errors or
context. Retain the existing local `RECOVERY_*` error family, including
`RECOVERY_NOT_FOUND`; add no wire error codes. Malformed inputs use
`RECOVERY_INVALID`, authorization/approval use their respective denial codes,
evidence conflicts use `RECOVERY_EVIDENCE_MISMATCH`, and the clock-anchor case
uses `RECOVERY_REVERIFY_REQUIRED` as specified below.

## 3. Canonical records and publication

All records below have exactly the displayed field order, including nested
verification fields. Build ordinary objects, `JSON.stringify`, encode UTF-8 with
no BOM, formatting whitespace or trailing newline; each record is at most 65536
bytes. Strictly validate shape/types and reencode/byte-compare on read. Hash the
actual canonical bytes with SHA-256, lowercase hex. IDs use existing lowercase
UUID rules, references 1..255 UTF-16 units without C0/DEL, times/counters
nonnegative safe integers. Unknown fields, unsafe arithmetic and inconsistent
derived references fail closed. Record `version` is exactly 1.

Use A/B protected files and trusted ancestors, stable inode checks, 0700
directories/0600 files and single-link completed files. Publication is exclusive
pending -> file fsync -> hard-link no-replace -> unlink only owned pending ->
directory fsync. Never replace a final record. An uncertain close/fsync is not
durable success; retain evidence. Exact authorized durability retries resync the
same bytes/file/directory, not regenerate timestamps. Readonly status never does
that work. Do not raw-open/close a held coordination inode and invalidate its lock.

### Seal v1

```text
{version:1,runId,preparePlanHash,newEpoch,candidateReference,candidateFileHash,
 schemaChecksum,verifiedAt,
 verification:{integrity:true,foreignKeys:true,schema:true,invariants:true}}
```

`sealHash` hashes the complete canonical seal. Its only accepted reference is
`runs/<runId>/seals/<sealHash>.json`; `candidateReference` is
`runs/<runId>/candidate.sqlite`. `schemaChecksum` is the actual frozen v4
checksum. Neither the seal nor its hash is written into the candidate DB.

### Activation plan v1

```text
{version:1,runId,preparePlanHash,sealHash,candidateReference,newEpoch,
 authReviewRef,isolationAckRef,createdAt,expiresAt,activationRef}
```

Persist at `runs/<runId>/activation-<activationPlanHash>.json`, where the hash
covers the complete canonical bytes. `expiresAt=createdAt+300000`, with safe
addition; only `now<expiresAt` is valid, equality is expired. Auth review is
required for fresh as well as nonfresh. Fresh isolation is explicitly null;
nonfresh isolation must match prepare and pass current authorization.

Same run/activationRef and exact input retry returns the stored plan and original
times, subject to freshness for preview. Changed input for that reference
conflicts. Expiration requires a **new activationRef**, never overwrite or
silently refresh the old plan. Multiple immutable plans can remain as evidence;
the DB records exactly which one was activated.

### Activation completion v1

```text
{version:1,runId,preparePlanHash,activationPlanHash,activationApprovalRef,
 activationRef,sealHash,candidateReference,instanceId,instanceCreatedAt,newEpoch,
 recoveryCounter,activatedAt,writeMode:'paused'}
```

Persist at `runs/<runId>/activation-complete.json` **only after actual active DB
commit, all owned candidate connections close, candidate file fsync and directory
fsync**. `activationCompletionHash` is the SHA-256 of these canonical completion
bytes. There is deliberately no whole-active-DB file hash in this record.

Every field must agree with the complete B/C chain and actual DB evidence:

| Completion / chain fact | Required actual match |
| --- | --- |
| runId / preparePlanHash | run `run_id` / `approved_plan_hash`; original B prepare approval and every B plan binding remain intact |
| activationPlanHash / activationApprovalRef | run `activation_plan_hash` / `activation_approval_ref` and exact protected plan |
| activationRef / activatedAt | run `activation_ref` / `activated_at`; center activation ref and transition time agree |
| candidateReference | derived run reference, prepare plan, activation plan, run `candidate_reference` |
| instanceId / instanceCreatedAt | actual instance identity and B prepare/staged evidence |
| newEpoch / recoveryCounter | prepare plan, actual epoch row and center; run `new_epoch` |
| sealHash / authReviewRef / isolationAckRef | activation plan, canonical seal and its prepare/epoch/verifiedAt binding; run auth-review/isolation fields agree |
| status / paused | run and center active, center recovery run matches, actual `im_settings.write_mode='paused'`, no failure fact |

`verifiedAt` remains the persisted run `verified_at`; seal binding does not require
the **active** DB bytes to equal the preactivation hash. A status word alone is
never completion proof. If DB activation committed but completion is missing,
only the same stored activation plan, exact approval reference and accurate DB
evidence can reconstruct the same deterministic completion (§6).

## 4. Verify: prepared to verified, then seal

1. Authenticate admin; load the protected locator/full B records and the exact
   prepare plan. Preparation must already have been approved and executed.
   **An expired original prepare TTL does not block verification of that completed
   prepare.** Do not create another prepare task, identity, epoch or approval.
2. Reverify actual source, original closure proof, isolation, live unreleased hold
   and prepare binding. For registered sources acquire the A source/hold coordinator, then
   workspace, then candidate control, then any candidate transaction. Fresh and
   closed-v3 have no fabricated hold. Check full B copy/normalization/pause/P1
   preparation chains as applicable, integrity/FK/schema/content/invariants and
   actual paused state under the existing lower-only bounded budget.
3. For a prepared run, use a fresh-clock transaction to change run and center to
   verified, persist run `verified_at` and center `updated_at`, retain epoch,
   counter and paused mode. Reauthorize and repeat final state/point checks before
   commit. The center has **no** `verified_at` column; use existing P1 columns.
   An active run cannot be downgraded or resealed as verified.
4. Require an already-normalized DELETE candidate. Reject WAL/SHM/journal residue
   (including empty residue), non-DELETE headers or unknown writers as unresolved
   evidence/indeterminate. No proactive checkpoint, `immutable=1` to hide WAL,
   raw sidecar unlink, mode conversion or source mutation is a C repair path.
5. Commit -> close **all owned** candidate connections -> verify no sidecars and
   stable protected file -> file and directory fsync -> closed-file hash ->
   canonical no-replace seal publication. Success returns the exact §2 DTO.

Already-verified retry is a read/validate path before any clock guard. Do not
unconditionally update `verified_at`, center time or a clock anchor. If a matching
seal exists, validate it, reestablish its durability as needed and return it. If
verified commit succeeded but seal is missing, fully validate and publish with
the **persisted original verifiedAt**. Uncertain seal publication retries retain
the same bytes/hash. A failed activation that committed a clock anchor may require
a new seal over the current verified candidate hash, keeping original verifiedAt.
Retain old seals; never overwrite them or use them as current-byte proof.

## 5. Activation preview

Under source -> workspace -> candidate control, require accurate verified/paused
state, complete B/C bindings and a live unreleased registered-source hold. Verify
the **specified** canonical seal/hash and closed candidate file hash before any
clock anchor. Recheck auth review and isolation/closure authority. Build and
persist the immutable activation plan in §3. Preview makes no DB mutation or
guard/anchor write. Return `{activationPlan,activationPlanHash}` only after
durable publication. Same-reference retry/conflict/expiry follows §3, not a fresh
epoch or refreshed approval under old bytes.

## 6. Activation, clock failure and exact completion retry

The first branch is readonly accurate completed recognition under the same lock
order. Compare all input references, stored plans, B/C chain and actual run,
center, epoch, identity, counter and paused mode. An exact already-active retry
may succeed after the old activation TTL expires. It needs no obsolete
preactivation file-hash match, fresh anchor, new epoch, second audit or second
activation. A consistent released hold can support completed recognition;
release does not authorize another activation.

**Parent-approved C1 durability correction:** every exact already-active
`activateRecovery` retry performs **no logical DB changes**, but must reestablish
durability even when a matching completion file is visible. A final name can
remain visible after directory fsync failed; neither visibility nor a
process-local uncertainty set proves a prior successful fsync after restart.

Under the same source -> workspace -> candidate controls, first validate the
actual active/paused DB projection, full B/C chain and all exact input bindings.
An existing protected completion must have exactly the reconstructed canonical
bytes. This readonly recognition precedes expired TTL and new-mutation approval
checks. Then close all owned candidate readers, verify the protected standalone
candidate and stable identity, fsync its file and directory, and finally fsync the
existing exact completion file and directory. When completion is genuinely
missing, publish only the same deterministically reconstructed canonical record
after candidate sync. Use existing protected, identity-checked helpers and the
shared bounded budget. A closed-file hash used during this work is not a new
approved baseline; never compare active bytes to the obsolete preactivation hash.

Any file/directory resync failure refuses success with
`RECOVERY_DURABILITY_UNCERTAIN`; retained evidence permits another exact retry.
Do not update logical DB state, clock floor, epoch, activatedAt or audit; create
no guard/time anchor, new approval reference, extra completion marker or recursive
"completion-complete" record. Malformed/conflicting completion is refused without
overwrite or deletion. Repair/resync preserves exact bytes and timestamps and
never repeats the activation state transition or audit.

Readonly status and B completed reads never perform this resync/publication work.
They report matching visible DB/record facts consistently across processes,
without claiming prior fsync success or authorizing later hold release.

For an operation that is not already accurately completed:

1. Reverify source, live hold/binding, stored plan/seal/closure, admin, independent
   activation approval, auth review and current isolation. Retain all locks.
2. Verify canonical seal and **closed-file hash before opening the writable
   guard or causing any time-anchor write**. A hash mismatch cannot be cured by
   accepting a different hash. No full-DB file hash is taken inside a write lock.
3. Open the owned DELETE-mode DB and point-check run/epoch/schema/state. Within a
   fresh-clock transaction repeat all authorization gates, plan expiry and
   run/epoch/schema checks. Atomically set run/center active, run auth review,
   activation plan/approval/ref/time, center ref/time and a minimal activation
   audit. Keep `write_mode='paused'`, identity, epoch and counter fixed to the plan.
4. Perform final clock refresh, expiry (`now<expiresAt`), authorization and point
   checks before commit. Close all owned candidate connections, verify no
   sidecars, fsync candidate and directory, then publish completion. Return §2's
   exact active result only on the appropriate completed/durable path.

If a clock anchor committed but activation is refused, the candidate file changed:
report `RECOVERY_REVERIFY_REQUIRED`. Retain the clock floor, old seal/plans and
hold. Require verify of current bytes, a new seal, new activation plan/reference
and **new activation approval**. Do not silently change an approved hash, roll
back the floor, or reuse old approval. On uncertain commit/close, reconcile actual
DB facts: never label a possibly committed active run failed or erase active facts.

Activation changes no credentials, messages, send keys or genuine ACK/read facts.
It does not listen, switch routing, start services or enable writes. Active and
status `NONE` are not service permission.

## 7. Active-only release plan and release operation

Readonly status v2 may derive the following exact ordered plan only from accurate
active/paused DB state, matching protected completion and the actual A hold/binding.
This is an observational proposal, not proof of prior successful fsync:

```text
{version:1,runId,holdId,backupId,stageHash,preparePlanHash,
 activationCompletionHash,terminalState:'active',candidateReference,newEpoch}
```

`releasePlanHash` hashes these canonical bytes. This derived plan needs no new
plan file or clock anchor. Fresh/closed-source runs have no hold and return null
releasePlan/hash. An active DB with missing completion also returns nulls and an
action asking for an exact activate retry; it is not failed. Current C does not
release failed candidates. There is no release TTL or backup retention timer.

`releaseRecoveryHold` must rebuild the plan from actual protected DB, durable
records and A-held evidence under all relevant locks; match input run/hold/hash,
reauthorize admin and independently authorize `kind:'release-hold'`. No caller
terminal proof, standalone marker or status response supplies release authority.
C2 must independently strictly verify the actual chain and reestablish candidate
and completion file/directory durability under these same controls before hold
release publication. It must not use readonly status as a durability shortcut.
Use the A capability in §8 to publish the existing ordered marker format:

```text
{version:1,holdId,recoveryRunId,terminalState:'active',
 stateEvidenceHash,approvalRef,releasedAt}
```

Here `stateEvidenceHash=activationCompletionHash`, and the path is the existing
`registry/releases/<holdId>.json`. A fixes identity to the actual current hold and
timestamps internally; C supplies terminal verification while controls are held.
The private publisher also receives mandatory `minimumReleasedAt`, derived from
the verified actual completion's `activatedAt`. A's single timestamp sample must
meet both that minimum and the actual prepare binding's `boundAt` before any
pending or final marker write. A lagging clock fails with
`RECOVERY_EVIDENCE_MISMATCH`; retry may succeed once the clock catches up, without
leaving an immutable bad-time marker. No clamping or separate preflight clock
sample substitutes for checking the actual publication timestamp.
Exact same approval/evidence retry preserves original releasedAt/bytes and
resyncs file/directory. It checks the retained timestamp against both bounds and
does not sample the current clock. Different approval reference or evidence
conflicts, even if separately authorized. Malformed/uncertain proof is conservatively held, not
cleanup permission. Return only `{runId,holdId,state:'released',releasePlanHash}`.
Never delete the hold/binding or source backup. `checkCleanup().allowed` remains
false; release is neither automatic cleanup nor permission to enable cleanup.

## 8. A C0 primitives and B integration

The required readonly primitive is a new module-level export, not a duck-typed
registry method:

```text
withRecoveryHold(genuineRegistry,{backupId,holdId},ctx,callback)
  callback(deeplyFrozen {record,sourceEvidence,hold,binding,release})
```

Authenticate the genuine registry through A's private registry identity. A single
coordinator verifies the backup, actual hold and binding and strictly reads the
optional release marker. Binding/release are null when genuinely absent. Match
backup and hold identity and structural bindings. This scope creates or resyncs
**nothing** and exposes no copy/path/writer. Caller return is synchronous and
subject to thenable/error handling. C/B take workspace and candidate controls
inside this callback, eliminating getHold-then-lock races. The existing local
`hold.json` receipt is a locator/cross-check, never release authority.

Strict marker structure proves only its format/binding, not terminal authority;
recovery must compare it to actual completion. C0 must replace A's unconditional
release-file refusal in the paths needed for this scope; it must not make raw A
marker presence authorize cleanup. Source backup must still exist and verify in
this phase. P6 post-deletion status semantics are future work.

The required trusted constructor is:

```text
createRecoveryHoldReleaser({registry,authority,approvalAuthority,verifyTerminal})
```

Its result is held privately by the recovery factory, never added to the registry
facade, network configuration or operation inputs. Under A's coordinator it reads
actual records and invokes C's internal
`verifyTerminal(heldEvidence,operation,context,publish)`. That internal verifier
takes workspace/candidate control, rebuilds active completion and release plan,
checks literal approval and invokes scope-bound `publish` **before releasing any
of those locks**. A writes only the fixed current hold's active marker.

No generic caller-record writer, operation-time verifier, escaped/stale publisher
or asynchronous lock continuation is permitted. Reject known async callbacks
before invocation; observe/reject thenables, reject falsy verifier outcomes, and
latch invalid/conflicting/reentrant publication attempts even when caught.
Publication authority expires with the scope. An exception after a durable
publication cannot undo bytes: retain evidence, refuse success and reconcile on
exact authorized retry, never claim clean rollback. The exact releaser facade,
operation, publisher input/result and verifier success token remain the bounded
parent freeze in §10.

B exact prepare retries must use the same held readonly scope and preserve the
true prepared/verified/active completed state without writes or downgrade. Extend
their reconciliation with C's actual chain; do not blindly reuse B's weaker
active recognition. Matching visible completion permits readonly active
recognition even if a prior process reported sync failure; this is observation,
not a new durability guarantee. No fsync, repair or guard/clock-anchor write is
permitted on this B completed-read path. Missing completion remains conservative
in C1 (see §9) and never licenses a new prepare mutation. Released evidence
consistent with completion must not force every later B read to indeterminate.

## 9. Readonly status requirements

`getRecoveryStatus({runId},ctx)` remains synchronous, admin-gated and readonly:
zero DB writes, anchor/guard writes, file creation, fsync, checkpoint, repair or
sidecar deletion. Use existing controls and retain accurate nullable facts.

**C1 v1 compatibility:** matching actual active/paused DB evidence and protected
canonical completion returns `active/NONE`, consistently in the original or a
new process, including after a previously reported completion-sync failure.
This readonly result observes visible evidence; it establishes no new durability
and is not permission for C2 release. Missing/mismatched/unprovable completion
remains `indeterminate/MANUAL_RECONCILIATION` (or the existing binding error where
run authentication fails). Only exact `activateRecovery` enters completion
repair/resync. No process-local uncertainty set is a correctness authority.

The following table describes the future C2 status-v2 surface, not an expansion
of the seven-method C1 runtime:

| Actual reconciled evidence | Required observation |
| --- | --- |
| Prepared B chain | prepared; verification required; releasePlan/hash null |
| Verified, seal absent/obsolete | verified if DB/B chain is accurate; verification/seal work required; no repair in status |
| Verified, valid current seal | verified; activation still separately planned/approved |
| Exact active DB/C chain, completion missing | active with repair-needed nextAction asking for exact activate retry; releasePlan/hash null, never false failed |
| Active with valid completion and live hold | active; derive exact release plan/hash for independent approval |
| Active with matching released marker/completion | active remains recognizable; report completion consistently, no automatic indeterminate |
| Fresh/closed-source, no hold | no synthetic hold/release plan/hash |
| Contradictory/unprovable evidence or unknown sidecars | indeterminate/manual reconciliation, or existing binding-authentication error where no trustworthy run binding exists |

Status may describe a separate action; it does not perform it or authorize
release/listen/write. The committed `status` encoder is strict, unversioned and
permits active `nextAction` only `NONE`. Thus status v2's field order, new action
names and v1 compatibility require an explicit choice, not an implementation
assumption. §10 proposes the smallest extension.

## 10. Frozen C0 interfaces (parent approved)

The parent has approved Q1-Q3 with the refinements below. C0 implements only pure
records and A prerequisites; C1/C2 runtime integration remains separately gated.

### Q1. Private releaser facade / operation

The constructor, lock-owning callback, return shape and strict operation are frozen:

```text
createRecoveryHoldReleaser(...) -> frozen {release}
release({backupId,runId,holdId,releasePlanHash,approvalRef},ctx)
```

Use the same exact ordered operation snapshot for internal `verifyTerminal`.
`backupId` is resolved by recovery's trusted source catalog, not added to the
public recovery operation. Match actual hold `recoveryRunId` to `runId`; the
constructor binds genuine registry and authorities once. Snapshot the exact
operation before callbacks. This exported factory is a trusted local composition
capability, never a registry facade/network method. It cannot prevent malicious
same-process JavaScript from importing a trusted factory.

### Q2. Scoped publisher fields and terminal verifier result

**Frozen with parent-approved C2 minimum-time amendment; A's marker encoder is unchanged**:

```text
publish({stateEvidenceHash,minimumReleasedAt}) -> private frozen publicationReceipt
verifyTerminal(heldEvidence,operation,context,publish) -> that same receipt
release(...) -> frozen {releaseMarker}
```

C derives `stateEvidenceHash` solely from the rebuilt completion and proves it
matches the input releasePlanHash while candidate control is held. It derives
`minimumReleasedAt` from that verified actual completion's `activatedAt`. This
mandatory nonnegative safe integer is trusted verifier evidence, not caller
policy: the public release operation has no minimum/time override, and a missing
minimum has no backward-compatible zero default. A snapshots both publisher
fields immutably before its clock, authorization callbacks or filesystem work.
A fixes version, current holdId/recoveryRunId, terminalState active and approvalRef from
actual hold/operation, using A's existing internal clock for releasedAt. First
publication samples that clock exactly once and requires the sampled safe integer
to be at least both actual `binding.boundAt` and `minimumReleasedAt` before any
marker/pending-file write. Invalid or too-early time fails with fixed
`RECOVERY_EVIDENCE_MISMATCH`; it is neither clamped nor published for later repair.
Existing exact marker retry checks its retained `releasedAt` against both bounds
without sampling the current clock, preserves bytes/inode/time and still resyncs
file/directory. A bad existing timestamp is refused unchanged, never corrected or
deleted. A independently enforces admin and the literal-true release approval
bound to operation hash/ref at publication. The
receipt is private identity, valid only for this scope's successful publication;
it is not a caller terminal boolean, portable proof or generic write capability.
C maps verified result to the public §2 DTO. Receipt is opaque frozen identity
with no setter or mutable fields; verifier must return that exact receipt.
Exact same-scope two-field publication repeats return the same receipt. Changing
either hash or minimum, malformed arguments, reentrancy, unexpected thenables and
invalid verifier returns poison/refuse outer success, even when caught. Capabilities expire on exit. Reject
known async callbacks/adapters before executing their prefix; observe unexpected
promise rejection. Falsy throws are failures, never truthiness-based success.
A enforces its own admin authority and independent release-hold approval bound
to operation hash/ref immediately before publication. Durable publication followed
by verifier failure retains the marker and reports failure/uncertainty, without
deletion compensation. Cross-scope exact retry validates and resyncs file and
directory, retaining releasedAt; changed approval/evidence refuses. A requires a
prepare binding and fixes marker backup/hold/run to actual evidence. Future C must
derive completion/release hashes and call publish while holding workspace/candidate
locks. Never publish a returned terminal object after those locks are released.

`withRecoveryHold` uses the same private locked helpers and bounded source scope,
reads deeply frozen `{record,sourceEvidence,hold,binding,release}`, and performs no
creation, resync or publication. An absent binding/release is null. A strict active
marker must match the current hold/run and times; historical `failed` marker format
is unsupported here and fails closed pending an approved verifier. Marker structure
alone is not authorization: future C compares its stateEvidenceHash to completion.
Existing getHold/withRecoverySource behavior still refuses release files; C0 does
not adapt B readScope. Cleanup never returns allowed true. Source -> workspace ->
candidate lock order is preserved; publication uses the already-held source lock.

### Q3. Status v2 DTO and v1 compatibility

**Frozen ordered DTO**, with existing nullable rules for B facts:

```text
{version:2,runId,candidateReference,state,stageHash,preparePlanHash,newEpoch,
 holdId,writeMode,nextAction,releasePlan,releasePlanHash}
```

`releasePlan` and `releasePlanHash` are both null or both validated/matching.
Keep B's action strings for existing states. Additional active actions:
`RETRY_ACTIVATE` for missing/uncertain completion and
`APPROVE_RELEASE_HOLD` for valid completion plus unreleased hold. Use `NONE` for
completed no-hold or consistently released cases. Released observation
retains the same derived releasePlan/hash so exact retry remains inspectable;
`NONE` does not invite a new approval. No extra holdState or completion flag is
needed in this minimum, since state/nextAction convey repair requirements.

NONRELEASE migration keeps the existing pure `status` (v1) codec intact and adds
`statusV2`. C0 does not change runtime output. C integration later explicitly makes
`getRecoveryStatus({runId},ctx)` return v2, breaking strict v1 consumers, with no
selector or silent compatibility claim. RETRY_ACTIVATE requires null release pair;
APPROVE_RELEASE_HOLD requires a hold and matching pair. NONE with a hold requires
the same pair representing runtime-verified release. Scope pair to run/hold/epoch/
candidate/prepare/stage. Preserve staged prepreview null epoch/enabled snapshot
and indeterminate unknown facts. Encoding itself authenticates no completion.

### C0 pure helper signatures for the C1 consumer

`encodeRecoveryRecord` / `decodeRecoveryRecord` / `hashRecoveryRecord` add kinds
`seal`, `activationPlan`, `activationCompletion`, `releasePlan`, `statusV2` with
the exact records in §§3/7/Q3. Existing B encodings are retained.

```text
prepareEvidence = {stage,staged,sourceClosedEvidence,base,previousRecoveryCounter}
sealEvidence = {preparePlan,prepareEvidence,candidateFileHash,schemaChecksum,
  verifiedAt,sealReference}
activationEvidence = {seal,sealEvidence}
completionEvidence = {activationPlan,activationEvidence,prepareApprovalRef,actual}
releaseEvidence = {completion,completionEvidence,hold,binding}

validateRecoverySealBindings(seal,sealEvidence) -> frozen owned seal
validateRecoveryActivationPlanBindings(activationPlan,activationEvidence)
  -> frozen owned activationPlan
validateRecoveryCompletionBindings(completion,completionEvidence)
  -> frozen owned activationCompletion
validateRecoveryReleasePlanBindings(releasePlan,releaseEvidence)
  -> frozen owned releasePlan
assertRecoveryActivationPlanFresh(activationPlan,now) -> frozen owned activationPlan
```

Every evidence key is required; lawful absent B evidence uses explicit null,
never undefined or an omitted validation switch. The full existing B prepare
binding validator is applied. Binding helpers validate supplied evidence only;
C1 must independently obtain it from protected records and actual DB inspection.
`candidateFileHash` is the seal-time closed-file evidence; completed recognition
does not substitute or require a whole-active-DB hash. Original verifiedAt and
canonical sealReference are required. Fresh/nonfresh isolation matches prepare.
TTL structure is always checked; freshness is a separate explicit `now` check,
so completed recognition can occur after expiration without a clock read here.

The exact runtime projection `actual` is:

```text
{run:{runId,preparePlanHash,prepareApprovalRef,candidateReference,newEpoch,status,
      verifiedAt,activationPlanHash,activationApprovalRef,activationRef,activatedAt,
      authReviewRef,isolationAckRef,failureCode},
 center:{runId,newEpoch,status,activationRef,updatedAt,recoveryCounter},
 instance:{instanceId,instanceCreatedAt},epoch:{newEpoch,recoveryCounter},writeMode}
```

All projection shapes are exact. Run/center must be active, failureCode null,
writeMode paused, and all references, identity/epoch/counter/time fields must
match the validated B/C chain. `prepareApprovalRef` is the independently loaded
original prepare approval, compared to `actual.run.prepareApprovalRef`. activatedAt must fall inside
the original activation-plan time window; evaluating an old completion itself
does not use current time. Future C must still verify original approval, complete
B copy/normalization/P1 evidence, actual rows, source closure and authorization.

## 11. Ordered implementation and evidence gates

1. **C0, one owner:** parent freezes §10; pure seal/activation/completion/release
   encodings and status-v2 codec plus A held-read/release primitives and focused
   tests; review before runtime consumption.
2. **C1, one sequential owner:** verify/preview/activate runtime in recovery and
   candidate modules, with matching candidate tests. Parent assigns exact files;
   this document grants no source write scope.
3. **C2, sequential ownership of the same files:** release and readonly status/B
   readScope integration; no concurrent writer to the recovery files.
4. **C critical process faults after stable runtime:** targeted crash/response-loss
   evidence and independent review. Full P5-D remains the four-source matrix,
   followed by P6/P7 and their separate acceptance gates.

Required implementation evidence (not executed by this documentation lane):

- Tampered/noncanonical/replaced seal and changed current candidate refuse;
  no pre-seal guard write; unknown WAL/non-DELETE candidate refuses.
- Verified commit with missing/uncertain seal; retries preserve verifiedAt and
  avoid unconditional anchor writes; failed-activation anchor reseals current
  bytes and requires new plan/reference/approval.
- Independent prepare/activation/release approvals and auth-review refs; wrong
  binding, revocation, known async zero-prefix, thenable rejection observation,
  final authorization/time checks, safe TTL overflow and equality expiry.
- Active commit/response loss recognizes exact actual completion after expiry;
  every exact activate retry syncs candidate and completion files/directories,
  with no logical DB/clock/audit/epoch changes. Cross-process tests must inject
  failure before native file/directory fsync, retain visible evidence and prove
  refusal until exact retry establishes durability. Status/B completed reads
  remain zero-write observations; missing completion repair belongs only to an
  exact accurate activate retry, never status.
- Two-process source/workspace/candidate locking, release race closure, poisoned
  publisher callbacks, escaped capability, forged terminal evidence, changed
  approval/evidence and file/directory-fsync failure all fail conservatively.
- Source originals, backup bytes/provenance, credentials and accepted/key/ACK/read
  facts remain unchanged; fresh and closed v3 never gain fake holds.
- Windows native strict protection is **UNSUPPORTED**, not skipped-to-PASS or a
  fake-platform result. Native ext4 process-kill evidence proves software-crash
  behavior, not hardware power-loss durability; tie it to the actual tested tree.

Full P5-D/P6/P7 are future gates. H1 still gates real source isolation, RPO/auth
review and production restore/activation/switching; H2 gates actual deletion and
retention (backup 30 days remains unconfirmed); H3 gates listeners/network,
deployment and cost. User authorization is NONRELEASE development only. No
actual restore, activation, delete, listen or enable-writes operation is authorized
by this handoff.

## 12. Original handoff validation boundary and C1 correction scope

The original documentation-only handoff wrote only this document. Its validation
was limited to expected HEAD,
local contract/source fidelity, UTF-8 without BOM, existing relative link targets
and whitespace checks. The checked HEAD matches; UTF-8/no-BOM, all 11 relative
link targets and trailing-whitespace/EOF checks pass. No source/tests/existing docs, configuration, runtime DB,
services, staging, commit or push was part of that original handoff. Runtime tests
were not required or executed for the original documentation-only handoff.

The subsequent parent-approved C1 correction is bounded to completion retry
durability and readonly observation semantics. Source scope is `recovery.js` and,
only for exact completion validation, `recovery-terminal.js`; this contract is
the sole document scope. Independent test ownership covers native cross-process
fault probes and B expectation updates. Source syntax/whitespace/hash checks are
not native runtime acceptance; final code/oracle/QA review and native execution
follow terminal source and test writers. C2 release/statusV2, full P5-D and
production approval remain separate gates.

Following the four terminal C2 reviews, the parent approved a narrow publication
chronology correction in `backup-registry.js`, `recovery.js` and this contract.
The private publisher's mandatory `minimumReleasedAt` closes the case where A's
clock is at or after prepare binding but before actual activation. The actual
publication sample is checked before writing; a post-return consistency check
is only defense in depth. The public release API and persisted marker format
remain unchanged. Independent test ownership updates trusted C0 publisher
callsites to supply the mandatory minimum and verifies the chronology, retry and
poison cases. This amendment declares neither C2/P5 acceptance nor production
approval; independent original-code/oracle closeout remains pending.
