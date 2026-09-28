# B0.2a recovery conversion ownership bridge (NONRELEASE)

**Parent-approved frozen B0.2a behavior boundary; independent acceptance remains
outstanding.** Checked committed HEAD:
`7c982499920354706ffa973aa74cfe478222c34a`.
The finite DTO/signature decisions in §10 are frozen by the parent. This is a
bridge-only implementation boundary, not permission to execute a conversion.

Read with the [schema-v5 contract](im-v2-maintenance-schema-v5-contract.md),
[recovery prepare contract](im-v2-recovery-prepare-contract.md),
[recovery activation contract](im-v2-recovery-activation-contract.md),
[recovery storage contract](im-v2-recovery-storage-contract.md), and
[maintenance handoff](im-v2-maintenance-contract.md).
The parent-approved B0.2a/B0.2b split here refines the older combined B0.2 scope;
it does not change B0.1 codecs, historical schemas or P5 canonical formats.

## 1. Package boundary and order

| Package | Finite responsibility | Exit boundary |
| --- | --- | --- |
| B0.2a | Genuine private recovery ownership bridge; canonical conversion owner/pause records; exclusion of claimed branches from all eight old v4 facade operations | Independently verified ownership, claim, candidate-only pause, conservative retries and old-facade exclusion; candidate remains schema 4 |
| B0.2b, future | Approved schema-4-to-5 converter transaction and protected conversion plan/proof/completion integration | Starts only after B0.2a independently passes and its integration signatures are frozen |
| B0.3 and compatibility work, future | Owned-v5 time authority, version-aware runtime/backup/recovery family | Separately scoped and accepted before operational converter exposure |

B0.2a does not include `migration-v5.js`, converter factory exposure, a time
writer, schema-5 runtime/service support or a broad v5 format redesign. Its only
candidate logical mutation is the fixed pause in §6. No original active center,
source or backup is a conversion target. It starts from an already completed
genuine stage; it creates no replacement prepare artifacts.

The public recovery facade keeps exactly these eight keys:

```text
stageCandidate, previewRecovery, prepareRecovery, getRecoveryStatus,
verifyRecovery, previewActivation, activateRecovery, releaseRecoveryHold
```

The bridge is an internal composition API, not a ninth facade method, network
route, caller-selected database endpoint or production switch.

## 2. Committed composition evidence and required differences

These are observations of the checked committed files, not claims that the
specified bridge already exists. The prepare/activation documents retain their
historical package statuses; the actual checked facade has all eight methods.

| Committed location | Actual boundary and consequence for B0.2a |
| --- | --- |
| [recovery.js](../src/im/v2/recovery.js), `createImV2RecoveryServices`, `workspace`, `byRun`, `bindingCheck` | Root, source table, run lookup, locator checks, authority and limits are factory-local closures. `workspace` controls `requests/coordination.sqlite`; run paths derive from the root and run UUID. The returned frozen facade is not currently registered in a recovery-owned WeakMap. |
| Same file, `records`, `validated`, `observedBinding` | Records bind stage/staged, source closure and historical normalization/pause chains. `validated` fully inspects schema 4 and compares an unprepared snapshot's current bytes to `normalized.normalizedCandidateHash`. That obsolete-byte equality cannot be reused after conversion pause. `observedBinding` rejects an authoritative prepare binding without its matching plan. |
| Same file, `readScope`, `candidateScope` | Registered reads use held-source control, then workspace, then candidate coordinator. Locator and local hold receipt are rechecked inside controls. A local `hold.json` is a cross-check, not source authority. `candidateScope` calls the old validator before its consumer and has ordinary active-completion semantics; it is not a conversion scope as-is. |
| Same file, `stageCandidate`, `prepareRecovery`, `verifyTerminal`, `releaseRecoveryHold` | Stage retry has a distinct path and can republish records/establish a hold before `stageDatabase`. Prepare's mutation pass takes its own source scope. Release enters A first, then verifies the terminal chain inside its callback. Guarding only `readScope` leaves these routes uncovered. |
| [recovery-source.js](../src/im/v2/recovery-source.js), `sourceTable.withSource` | Registered `held` uses `withRecoveryHold` with current binding/release facts. Fresh has no source lock/hold. Closed v3 uses genuine private capability, trusted isolation and before/after source inspection, not a registry coordinator or machine-global fence. Final source/isolation callbacks can still fail after the consumer returns. |
| [backup-registry.js](../src/im/v2/backup-registry.js), `withRecoveryHold`, `withRecoveryHoldLocked` | Registry identity is WeakMap-authenticated; held evidence includes actual hold, binding and release under one coordinator. The checked held scope creates its own `operationBudget(bounds)` and does not accept a shared inherited budget. A shared-budget private composition seam still needs parent-scoped integration; nesting public registry methods is not a solution. |
| [recovery-candidate.js](../src/im/v2/recovery-candidate.js), `database`, `candidateFacts`, `assertStaged`, `stageDatabase` | These exported internal helpers take paths/stage objects; they are not opaque ownership authority. `candidateFacts` uses a read transaction and full v4 validation. `actual.run` looks up the new stage's run ID, not every historical recovery row. Snapshot staging can preserve an old active center and enabled mode. |
| Same file, `prepareDatabase`, `transitionDatabase` | These use the ordinary v4 clock guard and mutate recovery/epoch/state facts. Neither is the conversion-only pause operation or a v5 transaction engine. The v3 staging pause is historical pre-migration evidence, not the new conversion pause proof. |
| [recovery-records.js](../src/im/v2/recovery-records.js), `protectedPath`, `fileHash`, `publishBytes`, `resyncPublished`, `operationBudget` | Protected single-link files, exact no-replace publication and explicit file/directory resync are existing mechanisms. An authenticated inherited-budget facility exists here, but is not threaded through the held-source API above. Native strict protection rejects Windows; documentation checks on Windows prove no runtime support. |
| [recovery-plan.js](../src/im/v2/recovery-plan.js), `hashRecoveryRecord` | Existing stage/staged/source hashes are SHA-256 of their existing canonical encoded bytes. They do not acquire the new conversion-record domain prefix. |

The bridge must supply its own private lifetime/poison discipline across this
composition. Existing individual callbacks and path helpers do not collectively
prove that discipline. No caller-supplied closure, path, DB, stage object, record,
writer, SQL string or successful pure validation can mint ownership.

## 3. Genuine mint and expiring scope

### 3.1 Factory-owned provenance

Add a module-private WeakMap in `recovery.js`, keyed only by the exact frozen
facade created by `createImV2RecoveryServices`. Its value retains the genuine
closure over `root`, `sources`, `byRun`, `bindingCheck`, `workspace`, `runPath`,
`records`, `validated`, `authority` and `bounds`, with the private helpers needed
to enforce their original bindings. Registration occurs only within that genuine
factory. No generic exported registrar may accept arbitrary closures or register
caller targets, even if described as trusted/test-only.

The approved internal composition export from `recovery.js` is:

```text
createRecoveryConversionTarget(recoveryServices, {runId}, ctx)
  -> frozen {invalidate}
```

It authenticates facade identity, strictly snapshots the exact ordinary-data
`{runId}` input and validates its canonical lowercase UUID. Authenticate current
admin authority before reading/disclosing run metadata. Resolve the genuine
locator/source and validate the intake under source -> workspace -> candidate
control. Bind the target privately to the actual run, instance and immutable
stage; callers cannot redirect it through a copied facade, changed input or a
logical reference. A genuine facade for another workspace is not authority over
this target. An original active center cannot be supplied instead of its owned
independent candidate.

Construction validates only: it does not claim, pause, publish a conversion plan,
create a hold/binding or repair missing stage evidence. When reopening a claimed
branch, use §7's conversion-specific phase validation, not a new intake proof.
Current source/isolation/admin gates still apply on every operation; factory-time
authorization is not permanent permission.

`invalidate` is sticky for that target and any live session using it. It never
deletes an owner or cancels the persisted branch. Invalidation during a callback
or final cleanup prevents outer success; it cannot undo a durable claim/pause.
Exact invalidation call/return conventions are frozen in D6 in §10.

### 3.2 Internal scope surface

The new internal `recovery-conversion-target.js` exports:

```text
withRecoveryConversionScope(target, ctx, consume)
```

Only a genuinely minted target can enter this synchronous scope. Its private
authenticated session expires on exit and has only the following B0.2a fixed
operations. Their names, responsibilities and argument/result DTOs are frozen
by D1-D5 in §10.

| Operation | Authorized finite responsibility |
| --- | --- |
| `inspectIntake` | Inspect actual eligible v4 intake or validate the retained intake binding/current conversion phase; no claim, pause, resync or plan publication |
| `readConversionRecords` | Strict bounded observation of the owner/pause chain; absent and malformed/conflicting evidence are distinct; no repair/resync |
| `claimConversion` | Derive the immutable owner solely from the locked authenticated intake and durably publish/exact-retry it; no caller record/hash adoption |
| `ensurePaused` | Require the durable owner, establish/retry the fixed intent/pause sequence and return only after candidate/evidence durability and binding checks |

The oracle's future full-session operations `publishConversionPlan`,
`applyApprovedConversion` and `finishConversion` belong to B0.2b integration.
They are **not operational placeholders in B0.2a**: do not expose stub methods,
generic consumers of DB handles, optional writers or callbacks that execute
arbitrary transactions. The B0.2a session cannot execute v5 DDL or publish a
conversion plan/completion.

The cross-module mint-to-scope dispatch must authenticate private identities
without exporting a generic registrar or closure extractor. Its precise internal
linkage is D8; declaring a wrapper around the current path-taking helpers does
not meet it. Neither the target nor session exposes DB/path/SQL/writer access.
Deeply frozen descriptive DTOs convey evidence, never transferable capabilities.

### 3.3 Whole-scope control, budget and poison

Retain one source -> workspace -> candidate control span across the consumer,
native candidate pause, connection close, candidate file/directory sync and
evidence publication. Registered source hold checks use the already-held private
scope; never acquire another public registry lock inside it. Fresh has no fake
source coordinator; closed v3 retains genuine isolation/source checks rather
than pretending to gain a registry/global fence.

One authenticated shared budget starts before metadata/source verification and
covers intake, scans, DB validation, callbacks, hashing, publication and final
checks. Do not restart it for a nested source verifier or phase. Preserve the
existing lower-only defaults: messages 10000, verified content bytes 104857600,
other records 10000, elapsed 10000 ms, file bytes 134217728, metadata entries
10000. Use length/count projections and bounded inventory before allocation;
native calls remain soft-budgeted between calls, not promised interruptible.
D8 must freeze the private budget plumbing without an operation-level budget
override or raised limits.

Every operation rechecks session liveness, target identity/invalidation, current
authority and its bound phase. Reject known async callbacks before their prefix;
reject/observe unexpected thenables without extending locks or lifetimes.
Reentry, conflicting calls, caught operation faults, capability misuse and
expired/escaped calls cannot be swallowed into success. Latch a fault before
classifying a hostile thrown value (including falsy throws, proxy/getter traps).
Any such attempt affecting an active outer scope poisons that scope; a completed
scope cannot be retroactively undone, and its escaped methods never regain
authority in a later scope.

Recheck authority, source/hold/stage/candidate identity and phase under controls
before mutation/publication. Expire the consumer session before callback-bearing
cleanup can reuse it. Perform final poison/invalidation checks **after all
callback-bearing cleanup**, including source-isolation/final-verifier callbacks;
do not return a previously computed successful DTO first. Unresolved close and
unlock failures also preclude success; §12.6 narrowly distinguishes a resolved
B0.2b native close response exception from unresolved closure. Retain evidence
after a fault following publication; do not claim rollback of already durable
filesystem or DB effects. Connection ownership and fault poisoning still apply.

## 4. Eligible intake and exact inventory

| Genuine completed stage | Intake requirement |
| --- | --- |
| Fresh bootstrap | Actual P1 schema-4 preparation, paused; no source/hold; no recovery row for this new run |
| Closed-v3 or registered-v3 import | Completed P1 v3-to-4 migration and staged record, original normalization/v3-pause/P1 preparation chain valid, current schema 4 and paused; genuine source still verifies |
| Registered-v4 snapshot | Independent completed normalized schema-4 candidate, actual identity/epoch/source/hold bindings; inherited historical active center is allowed, even with enabled write mode; explicit conversion pause is mandatory |

All routes require actual full v4 validation, integrity/FK/business invariants,
protected stable standalone DELETE candidate, no sidecars (including empty
residue), `nlink=1`, genuine locator and complete immutable stage/staged evidence.
Before first claim use the actual `validated` v4 scope, plus the stricter
conversion exclusions/inventory. Reject any prepare plan, authoritative prepare
binding, new-workflow recovery row already prepared/verified/active (or any
contradictory run fact), seal, activation plan/completion, released hold, alias or
unexplained candidate change. A prepared P1 bootstrap is not an already-prepared
new recovery run; a snapshot's old active run is not the new workflow run.

The run directory inventory is bounded and exact; there is no catch-all extra
file allowance:

| Files | Presence rule |
| --- | --- |
| `coordination.sqlite`, `candidate.sqlite`, `stage.json`, `staged.json` | Required for every completed intake |
| `source-closed.json`, `source-verified.sqlite`, `copy-intent.json`, `base.json`, `normalization-intent.json`, `normalized.json` | Required for nonfresh routes; forbidden for fresh |
| `hold.json` | Required only for registered sources; forbidden for fresh/closed v3 |
| Historical `pause-intent.json`, `paused.json` | Required only for completed v3 import; forbidden for fresh/snapshot |
| `conversion-owner.json`, `conversion-pause-intent.json`, `conversion-paused.json` | Allowed only in the valid dependency/phase order in §§5-7; all absent at first intake |

No `seals/`, `prepare-*`, `activation-*`, future `conversion-plan.json` or
`conversion-complete.json` is accepted by the bridge-only phase validator.
Unknown files/directories, aliases and unknown pending files are refusals, not
cleanup opportunities. A publication can track only its own newly allocated
pending identity for the specified no-replace sequence; a later invocation does
not adopt/delete an unknown leftover. Recheck inventory at phase boundaries.
Workspace locator lookup remains bounded and rejects duplicate/contradictory
run mappings, orphan runs and unknown pending evidence. Other genuine runs do
not become part of this target's authority. Source-registry evidence remains
validated by the genuine source scope.

## 5. New canonical owner and pause records

The new internal `recovery-conversion-records.js` is limited to these pure record
shapes/encoding/hash checks. It provides no I/O, provenance, path resolution or
writer capability. Its export/kind/validator signatures remain D7; existing
B0.1 `maintenance-v5-records.js` and old P5 encoders are untouched.

All three records use exact ordered ordinary-data objects, strict canonical
UTF-8 JSON, no BOM, formatting whitespace or trailing newline, and at most
65536 bytes. Reject extra/missing/duplicate keys, accessor/symbol fields,
nonordinary data, malformed UTF-8, coercions and unsafe integers. Decode by
strict validation and byte-identical canonical re-encoding. Record data is
deeply frozen on exposure. Document files themselves retain a final newline.

Types: `U` is the existing lowercase canonical UUID; `H` is 64 lowercase hex;
`N` is a nonnegative safe integer millisecond value; `Ref` is the existing
1..255 UTF-16-unit, no-C0/DEL reference. Version is literal 1; booleans are strict
JSON booleans. Candidate kind is `fresh_bootstrap|v3_import|snapshot_recovery`.

For each new record, its hash is lowercase hex:

```text
SHA256(ASCII(domain) || 0x00 || canonicalRecordBytes)
```

There is exactly one NUL separator and no newline in these domains. This is
intentionally distinct from B0.1's newline-domain conversion plan/proof hashes
and from P5's undomained historical record hashes; change neither family.

### 5.1 Owner

File: `conversion-owner.json`. Domain: `im-recovery-conversion-owner-v1`.
Exact field order:

```text
version, runId, stageHash, stagedHash, candidateReference,
instanceId, instanceCreatedAt, centerEpoch, candidateKind, preparationRef,
sourceEvidenceHash, holdId, intakeFileHash, intakeWriteMode, claimedAt
```

`runId/instanceId/centerEpoch` are U; `instanceCreatedAt/claimedAt` are N;
`stageHash/stagedHash/intakeFileHash` are H. `candidateReference` is exactly
`runs/${runId}/candidate.sqlite`, never a caller filesystem path.
`intakeWriteMode` is `paused|enabled`; fresh/completed import must be paused.
`preparationRef` is the real existing Ref for fresh/import and null for snapshot.
`sourceEvidenceHash` is null only for fresh; otherwise H over the actual stage's
complete source evidence using the existing registered/closed-source canonical
algorithm. `holdId` is U for registered sources and null only for fresh or
closed-source import. Pure shape checks cannot distinguish both import source
forms from candidate kind alone; actual scope validation must do so.

`stageHash = hashRecoveryRecord('stage', stage)` and
`stagedHash = hashRecoveryRecord('staged', staged)`. The source hash uses
`registeredSourceEvidence` or `closedSourceEvidence`, respectively, with that
same existing canonical hash algorithm. It is not a source file hash, registry
record's other provenance hash or closure-proof hash. `intakeFileHash` hashes the
**actual closed schema-4 candidate at claim**, after any prior P1 migration;
never substitute the source/base/normalized/historical-v3-pause hash.

Every owner field is derived from authenticated locked facts, not accepted as a
caller record. Bind identity/epoch to actual DB/staged facts, source to today's
verified proof and hold to authoritative unreleased/unbound A evidence. Keep
the original locator, stage/staged and all intake chains unchanged.
`claimedAt` must not precede staged completion, actual instance creation or the
applicable source/hold chronology. Values are sampled/checked internally,
never supplied through an operation time adapter or clamped.

### 5.2 Pause intent

File: `conversion-pause-intent.json`.
Domain: `im-recovery-conversion-pause-intent-v1`.
Exact field order:

```text
version, ownerHash, inputFileHash, originalWriteMode, targetWriteMode, createdAt
```

Hashes are H; original mode is `paused|enabled`; target mode is literal `paused`;
`createdAt` is N. `ownerHash` is the §5.1 hash, `inputFileHash` equals the owner's
actual `intakeFileHash`, and original mode equals `intakeWriteMode`.
`createdAt >= owner.claimedAt`. Persist and establish intent file/directory
durability **before** changing candidate bytes.

### 5.3 Paused evidence

File: `conversion-paused.json`. Domain: `im-recovery-conversion-paused-v1`.
Exact field order:

```text
version, ownerHash, pauseIntentHash, inputFileHash, pausedFileHash, changed, pausedAt
```

Hashes are H; `changed` is boolean; `pausedAt` is N and at least intent
`createdAt`. Bind owner and intent hashes to those exact records; input hash
equals both prior input bindings. `changed` is exactly whether original mode
was enabled. Original paused requires `changed:false` and identical input/paused
hashes; enabled requires actual candidate-only pause and changed-file evidence.
The paused hash is measured after all owned DB connections close and candidate
file/directory sync succeeds. It is not an asserted replacement intake proof.

Full crossbinding checks must use actual source, locator, stage, staged, hold,
DB identity/epoch/preparation, current mode and phase-specific file bytes. Pure
codec success alone proves none of those facts. Retain original timestamps on
exact retries; validate phase chronology without inventing fresh earlier proofs.

### 5.4 Durable publication and permanence

For each record use protected exclusive pending -> file sync -> hard-link
no-replace -> unlink only own pending -> directory sync. Never replace a final
record. A visible existing exact retry must compare canonical bytes and resync
that file and directory; visibility across processes is not proof of prior
durability. Conflicting/malformed evidence is retained and refused. A directory
sync failure may leave a visible owner; it still excludes the old facade.

Once an owner exists, the run is permanently on the conversion branch. No
silent cancellation, owner deletion, v4-workflow reversion, intake/hash rewrite
or expiry-based reset is authorized. A fresh genuine target may reenter only
the same persisted branch under current authority and full bindings.

## 6. Fixed candidate-only pause and interruption matrix

1. Under the full control span validate current authority, complete intake or
   claimed phase, owner, unreleased/unbound hold, inventory and current closed
   candidate hash. `claimConversion` must have established the durable owner
   before `ensurePaused` can write its intent or candidate.
2. Derive the exact intent from that owner and actual original bytes/mode.
   Publish/exact-resync it durably before any writable candidate open/mutation.
3. If originally paused, perform **no UPDATE and no clock/guard write**. Verify
   current paused state, retain identical hash and sync candidate/file directory
   before publishing `changed:false` evidence.
4. For an enabled snapshot, use one internally owned fixed transaction with
   `BEGIN IMMEDIATE`. Revalidate actual v4 identity/epoch/state, mode and current
   authority inside it. Change only `im_settings.write_mode` from enabled to
   paused. No business rows, recovery/center state, epoch, audit, policy,
   `im_clock`, source or backup facts change. Do not invoke the ordinary v4
   write/clock guard. Repeat authority/fault/binding checks before commit.
5. Close every owned candidate connection; verify stable protected standalone
   DELETE file with no sidecars; sync file and directory; hash actual bytes;
   validate/publish exact paused evidence. Finish with all final scope checks.

There is no caller transaction to commit or roll back. Uncertain native outcomes
retain intent/evidence; rollback is limited to the bridge's own still-open
transaction. Closing/inspection must not normalize unknown bytes into success.

| Retained phase | Allowed result/retry |
| --- | --- |
| No owner and no conversion records | Validate genuine intake; read/mint alone does not claim |
| Exact owner, no intent | Validate unchanged intake file; explicit claim retry resyncs owner; explicit pause can publish intent |
| Owner + durable intent, no paused record; exact original input bytes and original mode | Exact bytes prove no changed pause committed; retry same intent and fixed pause/no-op route; no new intake or timestamp replacement |
| Owner + intent, no paused record; candidate bytes changed | Conservative `RECOVERY_INDETERMINATE`, even if current mode is paused; do not adopt a new hash or reconstruct a pause completion from mode alone |
| Complete exact chain and actual paused file/mode | Observe safely; explicit ensure-paused retry resyncs candidate and exact required records/files/directories, retains hashes/timestamps and does no UPDATE |
| Pause evidence without owner/intent, conflicting chain, unknown pending/sidecar, replaced candidate, released/bound hold | Refuse as evidence mismatch/indeterminate; no cleanup, overwrite, recopy or fallback |

No raw WAL/SHM/journal deletion, checkpoint-based repair, normalization-hash
rewrite or fresh intake proof cures the unknown pause window. Original v3 pause
and normalization evidence remain historical. Source and original backup bytes
must be identical before/after all bridge operations.

## 7. Phase-aware validation and old-facade exclusion

After claim, a conversion-specific validator checks the unchanged locator and
canonical stage/staged/source hashes against owner; original closure evidence,
source isolation, actual identity/epoch/preparation and live hold remain bound.
Registered hold must remain unreleased **and unbound**, including on restart.
Current phase selects the only accepted file hash: owner input before pause,
exact original input for retry of an incomplete intent, or recorded paused hash
after complete pause evidence. Unexplained changed bytes remain indeterminate.
Do not compare the legitimately paused candidate to an obsolete snapshot
normalized hash; do not bypass full current v4 validation either. No marker-5
acceptance is part of B0.2a; future B0.2b must add its own exact v5 proof branch.

Every ordinary facade operation must check `conversion-owner.json` before
mutating or reporting ordinary v4 workflow state. Admin authorization precedes
metadata disclosure. A correctly bound valid owner yields the fixed local error
`RECOVERY_CONVERSION_PENDING`, including while the candidate is still schema 4.
Malformed/conflicting owner yields fixed `RECOVERY_EVIDENCE_MISMATCH` or existing
indeterminate/manual handling where the run binding is trustworthy; it is never
treated as no owner. Safe errors contain no paths, SQL, records or callback text.
Keep old codecs/status shapes unchanged; a valid owner's pending error must not
be swallowed by status's ordinary partial-state classifier.

| Old route | Required locked exclusion point |
| --- | --- |
| `stageCandidate` exact retry | Resolve existing locator, then check under source/workspace/candidate control before republishing stage/hold, staging or returning `staged`; restructure its current pre-candidate publications as needed |
| `previewRecovery` | Before generating/persisting any prepare plan or ordinary preview result |
| `prepareRecovery` | Both completed recognition and mutation path; refuse before creating an authoritative prepare binding and recheck under candidate control before DB mutation |
| `verifyRecovery` | Before transition, sync/seal publication or ordinary verified return |
| `previewActivation` / `activateRecovery` | Before plan publication, activation/clock work, completion repair/resync or completed return |
| `getRecoveryStatus` | Before ordinary state/action/release-plan reporting; no false staged/active report for claimed branch |
| `releaseRecoveryHold` / private terminal verifier | Check under already-held source then workspace/candidate control before terminal proof or release publication; no nested source lock |

Early reads can reject but cannot be the only race protection. Claim/pause and
old-operation final checks share the existing controls; a prepared/bound branch
cannot be claimed, and a claimed branch cannot start prepare or release. Enforce
these races before pause, not only after a schema-5 marker appears. Missing owner
and absent conversion evidence retain legacy v4 behavior. Stray pause files or
unknown pending evidence are not a clean missing-owner legacy case.

## 8. Future B0.2b integration, not bridge scope

The already-approved converter shapes remain:

```text
createCandidateSchemaV5Converter({target,authority,approvalAuthority,executorId,limits})
  -> frozen {previewConversion,convertCandidate}
previewConversion({},ctx) -> {plan,planHash}
convertCandidate({transitionId,planHash,approvalRef},ctx)
  -> {transitionId,planHash,conversionProofHash,schemaVersion:5,schemaChecksum,replayed}
```

`previewConversion` **is not read-only**: the future integration may claim, pause
and publish immutable `conversion-plan.json` through fixed protected operations.
Generate one internal transition UUID per branch/plan; an exact existing preview
returns the original plan. An expired plan is not silently renewed or replaced;
new work requires a new workflow. Plan `preconversionFileHash` binds the actual
closed **paused** candidate, not historical stage/base/normalized bytes. Retain
all old stage evidence as intake history. Use B0.1's existing plan/proof/complete
encoders unchanged.

### 8.1 Approval and privately owned time

Resolve independent approval synchronously with exactly:

```text
resolveApproval({kind:'candidate-schema-conversion',planHash,approvalRef,
  instanceId,instanceCreatedAt,centerEpoch,executorId},ctx)
  -> strict {approverId}
authorizeApproval({kind:'candidate-schema-conversion',planHash,approvalRef,
  instanceId,instanceCreatedAt,centerEpoch,executorId,approverId},ctx) === true
```

The second call contains the **same resolved approverId**, bound to that actual
plan/instance/epoch/executor and valid approval reference. Require distinct
executor/approver, current admin and literal-true approval before mutation and
at final commit checks. Strictly snapshot exact inputs/results, reject async,
thenables/truthy substitutes and poison caught callback failures. A reference
alone and an old prepare approval confer no conversion authority.

Use privately owned native wall/monotonic time (`Date.now()` and
`process.hrtime.bigint()`), not arbitrary operation clock adapters. Wall samples
must meet the actual candidate floor and phase/private observations, safe
arithmetic and strict plan expiry (equality expired). Apply the private
monotonic deadline as well; final authority/time checks occur immediately before
commit. Restart must enforce persisted wall TTL and actual floor/phase bounds
without claiming a persisted monotonic baseline. Preserve `im_clock` and issue
no maintenance anchor/head. The ordinary v4 clock guard is inappropriate after
marker 5 and cannot be reused as this transaction engine.

### 8.2 Fixed transaction, uncertain commit and completion

The future fixed engine owns its connection and `BEGIN IMMEDIATE`. Under the
same controls it validates exact v4 plus actual plan/paused facts, creates only
the three approved tables and index, replaces only the marker definition/row,
inserts the one typed transition, performs full v5 and FK/integrity checks, then
final admin/approval/time checks and commit. Preserve inherited data,
identity/epoch/policy/paused mode and `im_clock`; anchor/head remain empty. Do not
disable foreign keys, accept caller SQL/transactions or roll back another owner.

If COMMIT throws, inspect transaction state and roll back only the engine's own
still-open transaction. Close/reopen and inspect actual protected state while
controls remain held: exact unchanged v4 permits retry; exact v5 with the same
approved transition/proof permits completion; any other state is indeterminate.
Never redo DDL on v5, generate another transition ID or report a guessed rollback.

After confirmed exact v5, close all candidate connections and verify standalone
state -> candidate file/directory sync -> actual posthash -> reconstructed DB
proof -> no-replace `conversion-complete.json`. Completion binds the closed file;
its postconversion hash is not stored inside the DB. Every explicit exact
completion retry, including already-visible completion after restart, validates
and syncs both candidate and completion file/directory. Conflicting proof is
never overwritten. Completion reconstruction also requires a valid protected
namespace with no unknown pending residue; see §12.6 for the bounded retry and
close-response clarification. Source and original backup stay unchanged.

These future fixed operations need their own reviewed integration signatures;
they are not B0.2a session methods. No runtime facade is wired until v5 backup,
runtime and coherent new recovery-family support pass their separate gates. Old
P5 formats/validators do not gain v5 support from a conversion marker.

## 9. Required independent B0.2a evidence

Source/test owners are assigned only after parent review and §10 freeze. Tests
must exercise actual composed operations, not only codecs or mocked ownership:

1. Genuine fresh, closed-v3 import, registered-v3 import and registered-v4
   snapshot stages; include paused and enabled historical-active snapshots.
   Prove full intake/owner/pause bindings with actual schema-4 candidates.
2. Reject fake/copied/proxied facades/targets, wrong-workspace/run targets,
   stale/replaced bindings, escaped/copied session capabilities and reentry.
   Invalidation before/during/final-cleanup is sticky and cannot return success.
   No DB/path/SQL/writer or generic registration authority leaks.
3. Prior prepare plan, authoritative binding without a local plan, current-run
   prepared/verified/active facts, seal, activation plan/completion, released hold,
   unknown inventory/pending/aliases and unexplained byte changes all refuse.
   Original live center and source backup cannot be targeted.
4. Real two-process source/workspace/candidate contention spans claim, intent,
   native pause, close, sync and evidence publication. Prove prepare/binding and
   release races cannot cross the owner guard. Closed-source isolation remains
   externally trusted, not invented process fencing.
5. All eight old facade methods reject a claimed branch before ordinary v4
   mutation/status, including schema 4 before pause; malformed/conflicting owner
   fails closed; unauthorized callers get no owner metadata. Exact eight-key
   facade and unchanged P5/B0.1 canonical vectors regress cleanly on legacy runs.
6. Already-paused path does no UPDATE and keeps exact file hash. Enabled snapshot
   changes only candidate `im_settings.write_mode`; full logical comparisons
   retain business/clock/identity/epoch/policy facts. Original source/backup hashes
   remain identical. Historical normalization/v3-pause/stage bytes do not change.
7. Inject process faults at owner/intent publication, native pause commit/close,
   candidate sync and paused publication. Changed bytes without paused proof are
   conservative indeterminate; exact input proves the retry boundary. Existing
   visible records after injected sync failure require exact-byte resync; no
   timestamp/new-hash adoption, raw sidecar deletion or recopy repair.
8. Independent literal canonical/hash vectors for the three ordered records,
   NUL-domain separation, 64 KiB boundary, malformed UTF-8/BOM/duplicate fields,
   nullability and cross-phase time/reference/hash disagreement.
9. Shared lower-only count/byte/elapsed limits across native/source/consumer and
   cleanup work. Inject caught/falsy/hostile faults, async-prefix denial,
   unexpected thenables, authority revocation and final cleanup reentry: none
   can return success, including after a durable publication.

Bind evidence to the actual reviewed source tree. Process-kill/fault tests are
not power-loss durability or machine-global fencing proof. Native strict
protection must not turn Windows UNSUPPORTED into PASS. H1 actual isolation,
RPO/auth review and restore/switching approvals, H2 retention/deletion approval,
and H3 listeners/network/deployment/cost remain separate operational gates.

## 10. Frozen bridge DTO/signature decisions (D1-D8)

All four session methods require the original session receiver and exactly one
ordinary empty object `{}`. Omitted/extra arguments, fields, accessors, symbols,
Proxies and nonordinary inputs refuse before reflective access. Methods and
sessions expire on scope exit. All returned DTOs are detached and deeply frozen.

### D1 — inspectIntake({})

Exact ordered fields:

```text
version:1, runId, stageHash, stagedHash, candidateReference, instanceId,
instanceCreatedAt, centerEpoch, candidateKind, preparationRef,
sourceEvidenceHash, holdId, executionPolicyHash, phase, intakeFileHash,
intakeWriteMode, currentFileHash, currentWriteMode, ownerHash,
pauseIntentHash, pausedHash
```

Identity/reference/hash/nullability follow §5.1; executionPolicyHash is the
actual stage policyHash. The final three hashes are null when absent. Phase is
`UNCLAIMED|CLAIMED|PAUSE_INTENT|PAUSED`. Before claim, intake hash/mode are actual
closed v4 facts; after claim they are immutable owner facts. Current hash/mode
always describe the actual phase-validated closed candidate. An incomplete
intent permits only original input bytes/mode; changed bytes without paused
proof are indeterminate, never observed completion.

### D2 — readConversionRecords({})

Ordered result `{version:1,owner,pauseIntent,paused}`. Each evidence value is null
or `{record,recordHash}` in that order, using only §5's three record kinds.
Absence is legal only in dependency order. Full actual-scope crossbindings,
canonicality and phase validation apply; reading never repairs or resyncs.

### D3 — claimConversion({})

Ordered result `{version:1,owner:{record,recordHash},replayed}`. Derive all owner
fields internally. Publish/resync exact owner bytes and file/directory before
setting private successful-claim state. `replayed` means the final owner file
existed at method entry. Every repeated call resyncs, retaining original times.
Visibility after uncertain publication excludes the old facade but confers no
successful-claim state until exact retry establishes durability.

### D4 — ensurePaused({})

Ordered result `{version:1,owner:{record,recordHash},pauseIntent:{record,recordHash},
paused:{record,recordHash},replayed}`. Require a successful claim in this current
scope, including when an owner already persists. No DTO substitutes for that
private state. `replayed` is true only if valid final paused evidence existed at
entry. Intent precedes mutation; exact retry resyncs candidate and all three
records without new times or hashes. Only §6's fixed candidate pause is allowed.

### D5 — consume result identity

Each scope keeps a private WeakSet of successful top-level method results.
`consume(session)` must return the exact identity of one of those results from
this scope. Undefined/null/falsy values, copies, foreign results, sessions and
thenables refuse. Known async/generator consumers refuse before their prefix;
unexpected thenables have rejection observed. A prior valid result cannot mask
a later caught fault. Expire before callback-bearing cleanup and check final
fault/invalidation after every unlock and source post-verification.

### D6 — invalidation

`target.invalidate()` requires zero arguments and its original target receiver;
returns undefined, including repeated valid calls. Permanently revoke the target
and poison any active scope. Copied/detached/malformed calls refuse and poison
the affected active scope. Persistent ownership remains; independently minting
a new genuine target can reopen the same branch under current authorization.

### D7 — pure codec

`encodeRecoveryConversionRecord(kind,value)` returns owned canonical Uint8Array bytes;
`decodeRecoveryConversionRecord(kind,bytes)` returns deeply frozen records;
`hashRecoveryConversionRecord(kind,value)` returns the §5 NUL-domain hash.
Kinds are exactly `owner|pauseIntent|paused`. The codec is pure and bounded at
64 KiB; runtime full crossbindings belong exclusively to the genuine bridge.
Codec rejection uses fixed `RECOVERY_INVALID`; the bridge maps malformed stored
evidence to `RECOVERY_EVIDENCE_MISMATCH`. No old codec changes.

### D8 — private composition and inherited budget

`recovery.js` owns genuine facade, target and session WeakMaps and the complete
bridge. Facades register only inside `createImV2RecoveryServices`. Its exports
are `createRecoveryConversionTarget(recoveryServices,{runId},ctx)` and
`withRecoveryConversionScope(target,ctx,consume)`. The new
`recovery-conversion-target.js` only reexports the latter; no circular dependency,
generic registrar, closure extractor, path/DB endpoint or writer accessor.

`withRecoveryHold(registry,input,ctx,callback,inheritedBudget?)` passes its fifth
argument to private held scope's `operationBudget(bounds,inheritedBudget)`.
Existing four-argument callers retain behavior. Recovery source-held composition
passes the genuine operation budget. Its existing WeakSet authentication and
lower-ceiling compatibility check reject forged/incompatible inheritance before
registry work; no reset/replacement/raised limits. One budget starts before run
lookup and spans source checks, DB metadata/schema reads, callback, publication
and cleanup. Native calls are soft-budgeted, not hard interruptible.

## 11. Implementation and independent handoff

The runtime lane owns only recovery.js, recovery-source.js, the narrow registry
budget seam, the thin target module, a necessary fixed candidate pause helper,
and dedicated conversion-target tests/fixtures. A separate owner supplies the
pure codec and its vectors; integration waits for its stable terminal hash.
Verification follows §9 on an immutable committed base plus explicit owned
runtime overlays, with native environment and before/after execution hashes.
Parent independent review/QA precedes B0.2b; this contract supplies no converter,
time authority, service rollout or operational release approval.

## 12. Frozen B0.2b source integration specification (NONRELEASE)

This section records the parent-frozen B0.2b source/contract assignment against
committed HEAD `d9d090701af3c85813a0092388332f134ea8aaba`. It supersedes the
future-only method/result descriptions in §8 for this bounded implementation
assignment; it does not change any B0.1 codec, historical record shape, schema,
checksum, policy, registry or P6-A contract. It grants no B0.2b acceptance,
maintenance authority, converter rollout or B0.3 time-authority scope.

### 12.1 Exact construction and public operations

`recovery.js` owns `createCandidateSchemaV5Converter(options)`; the new internal
`candidate-schema-v5-converter.js` is a thin reexport only. Construction requires
exact ordinary-data fields `{target,authority,approvalAuthority,executorId,limits}`.
The target is authenticated through the existing private WeakMap. Construction
invokes no adapter and performs no database or filesystem mutation.

`limits` has exactly these required positive safe-integer fields:

```text
maxMessages, maxVerifiedContentBytes, maxOtherRecords, maxElapsedMs,
maxFileBytes, maxMetadataEntries, planTtlMs
```

Limits may only lower the target's ceilings; `planTtlMs <= 300000`. Each call
creates one authentic operation budget before metadata access and carries that
same object through source, workspace, candidate, engine, hash, publication and
cleanup work. There is no operation-level limit, clock or budget override.

The frozen converter has exactly these methods and ordered results:

```text
previewConversion({},ctx)
  -> {version:1,plan,planHash,replayed}
convertCandidate({transitionId,planHash,approvalRef},ctx)
  -> {version:1,transitionId,planHash,conversionProofHash,
      schemaVersion:5,schemaChecksum,replayed}
```

Inputs are exact ordinary data and detached before callbacks. Check Proxies
before reflection. Reject known async/generator callbacks before their prefix;
observe and refuse unexpected thenables. Errors cross a fixed safe boundary
without invoking foreign code or retaining foreign message/cause. Reentry,
caught faults and late invalidation poison success through all callback-bearing
finalization. Current converter admin authorization is always required.

Preview is a write operation: it claims, pauses and publishes immutable
`conversion-plan.json`. Generate one internal transition UUID for that plan.
An exact existing unexpired plan is resynchronized unchanged and returns
`replayed:true`; an expired plan yields `MAINTENANCE_PLAN_STALE`, with no
replacement or new ID. Preview on an already converted branch yields
`MAINTENANCE_CONVERSION_CONFLICT`.

### 12.2 Private session binding and issued results

Extend the authenticated session with exactly:

```text
publishConversionPlan({})
applyApprovedConversion({transitionId,planHash,approvalRef})
finishConversion({transitionId,planHash})
```

Their exact ordered results are, respectively, the public preview DTO,
`{version:1,proof,proofHash,replayed}`, and the public convert DTO. Register each
successful result in the existing invocation-local issued-object WeakSet. The
converter returns the exact issued publish/finish result, never a copy.

Construction adapters, executor and limits travel in a private converter-bound
scope, not an extra argument to public `withRecoveryConversionScope`. Ordinary
B0.2a consumers cannot successfully use the three new methods without that
binding. Existing four method input/result shapes remain unchanged. Publication
requires successful claim and pause in the current scope. Apply reads the
protected plan itself, accepting no caller plan. Finish requires a successful
current-scope apply tracked privately, never a DTO presented as authority. No
database, path, SQL, verifier or generic writer escapes.

### 12.3 Approval and immutable plan bindings

The trusted synchronous approval calls have exactly these bindings:

```text
resolveApproval({kind:'candidate-schema-conversion',planHash,approvalRef,
  instanceId,instanceCreatedAt,centerEpoch,executorId},ctx)
  -> strict {approverId}
authorizeApproval({kind:'candidate-schema-conversion',planHash,approvalRef,
  instanceId,instanceCreatedAt,centerEpoch,executorId,approverId},ctx)
  -> literal true
```

Require valid references and distinct executor/approver. Snapshot the resolved
actor and repeat authorization with that same binding before mutation and
immediately before commit. An accurate committed retry uses retained proof
actors matching the configured executor and requested approval reference. It
does not resolve an approver, request new mutation approval or apply obsolete
plan TTL checks; current admin and source authority still apply.

Use B0.1 plan/proof/completion codecs unchanged. Derive plan facts from the
actual owner, stage, source, preparation, instance, current epoch, exact V4/V5
checksums and registered policy. Its preconversion hash is the actual closed
paused candidate hash and must equal the retained paused hash. The only new
inventory filenames are `conversion-plan.json` and `conversion-complete.json`.

### 12.4 Phase dispatch and old-facade exclusion

First validate locator, owner, intake, pause, source and unreleased/unbound hold.
A bounded marker observation then selects exactly the v4 or v5 full validator.
V4 retains its phase-specific original/paused prehash binding and the existing
interrupted-pause manual-reconciliation behavior.

V5 receives the same parent budget and must have exactly one transition matching
the protected plan hash, actual instance, current epoch and approval actors,
paused mode and empty maintenance anchors/head. Although B0.1's general validator
allows a historical conversion epoch after later recovery, this unfinished
conversion branch requires `plan.centerEpoch === currentEpoch`. Do not compare
current v5 bytes with the old paused hash: the original prehash remains bound
through the chain, and any completion posthash binds the current bytes.

A newly minted target after restart must recognize the exact v5 branch. The old
four session methods then refuse with `RECOVERY_CONVERSION_PENDING`; converter
operations can finish/replay it. Each old facade guard validates ownership before
the v4 full phase validator, returning pending for valid ownership even on v5,
and `RECOVERY_EVIDENCE_MISMATCH` for malformed/conflicting ownership. This is
guard-outcome shorthand, not a requirement that `getRecoveryStatus` always throw.
As in §7, when the independent locator/run/candidate-reference binding remains
authenticated, its existing classifier may return the exact conservative
`statusV2` DTO: `state:'indeterminate'`, `nextAction:'MANUAL_RECONCILIATION'`, and `preparePlanHash`,
`newEpoch`, `holdId`, `writeMode`, `releasePlan` and `releasePlanHash` all null.
Identity fields derive from the authenticated locator, never the corrupt owner.
An invalid or unauthenticated locator must not produce a trusted partial DTO.
Other operations continue to refuse; a valid conversion owner still yields
`RECOVERY_CONVERSION_PENDING`, including on valid v5, and must not be swallowed
by this classifier. No owner/proof check is weakened. Status performs zero
writes, syncs, repairs or evidence regeneration; no old-workflow repair or resync
is permitted on the conversion branch.

### 12.5 Fixed owned engine and private time

The new internal `migration-v5.js` exports only the fixed engine
`applyOwnedCandidateSchemaV5(resources)`, not a public ownership boundary. Its
private resources have exactly these fields:

```text
candidatePath, plan, planHash, approvalRef, executorId, approverId,
budget, checkAuthorizationAndTime
```

Only the bridge supplies resources. The callback receives no DB and returns a
validated time sample or refuses. The engine owns its connection and transaction;
there is no caller handle or arbitrary SQL callback. Under the outer locks, the
bridge checks the closed prehash before any mutable open.

The engine validates exact v4, plan bindings and paused mode, uses
`BEGIN IMMEDIATE`, repeats identity/epoch/policy/mode/authority/time checks, keeps
foreign keys enabled, creates the frozen three tables and index, drops/recreates
only `im_schema` with the exact v5 definition, and inserts marker and typed
transition. Full v5 validation uses the shared budget before final
authority/time/poison checks and native COMMIT. Prepare fresh statements after
DDL. Do not rewrite marker 5 to 4 for validation or use a v4 clock guard after
marker replacement. Preserve every inherited row, including clock, policy,
epoch and identity; insert no audit, anchor or head.

Capture native `Date.now` and `process.hrtime.bigint` privately; expose no sampler.
Preview wall time must meet candidate floor, phase and instance chronology, with
checked TTL addition. Apply wall time must meet plan creation, actual floor and
private observations and be strictly before expiry. Establish a monotonic
deadline from remaining TTL, without a nested reset. Persist `convertedAt` from
one accepted mutation sample; the final sample must be at least `convertedAt`
and satisfy both deadlines. No clamping or anchor write is allowed. Restart on
uncommitted v4 rechecks wall TTL/floor without claiming persistent monotonic
state. Tests may control `Date.now` only in an isolated child before imports.

### 12.6 Uncertain COMMIT and completion durability

If COMMIT throws, inspect the engine's own transaction state and roll back only
if it remains active. Never roll back the committed writer. Close properly;
unresolved close is fixed `MAINTENANCE_DURABILITY_UNCERTAIN`. Retain ownership of
any unresolved resource: no candidate hashing, completion publication or success
is permitted until it is safely closed. Neither a thrown close error nor a final
filename proves closure.

If native close actually establishes `isOpen === false` after successful COMMIT,
a close response exception alone does not require refusal. Success still requires
an actual reopen and full exact schema-5 plus same-transition/proof recognition,
all candidate and completion file/directory durability, and exact completion
validation below. This narrowly resolved native response does not relax
connection ownership or fault poisoning; no second DDL/transition or rollback
of the committed writer is allowed. Assertions must distinguish a later reader's
read-transaction rollback from rollback of that committed writer.

Reopen and inspect actual state under the same outer locks and budget; exact
committed proof permits completion only when the protected namespace is valid:

| Actual state | Outcome |
| --- | --- |
| Exact v4, original prehash, no new metadata | This attempt fails; a later explicit retry is allowed |
| Exact v5 with the same plan/transition/proof and valid protected namespace | Conversion committed; continue completion under the rules below |
| Conflicting or partial state | Conflict or durability uncertainty; retain evidence |

Never automatically retry DDL or generate a new transition ID. `replayed:true`
means the exact transition already existed at locked operation entry, not that
the first attempt recovered a committed result after a COMMIT response failure.

Finish validates exact v5/proof/approval bindings and closes all readers. Require
standalone DELETE, stable identity, no aliases and no unknown sidecars. Sync the
candidate file and directory, hash actual closed bytes, reconstruct B0.1 proof
hash/completion, then no-replace publish or compare exact existing bytes and sync
the completion file/directory. Every explicit exact retry reestablishes both
durability boundaries; a visible completion is no bypass. Missing completion may
be reconstructed from exact committed DB evidence **only if the protected
namespace is otherwise valid**, including no unknown pending residue.

| Completion/namespace observation | Required explicit-retry outcome |
| --- | --- |
| Missing completion, no residue, otherwise valid protected namespace | Exact committed proof permits reconstruction and durable no-replace publication; no second DDL/transition |
| Final visible completion with publication durability uncertainty | Validate exact bytes/bindings and resync candidate and completion files/directories before success; visibility never establishes durability |
| Conflicting completion/posthash | Reject without overwrite or adoption of changed bytes |
| Pending artifact without a supported durable ownership/reconciliation record | Indeterminate/manual conservative refusal; preserve the artifact even if its bytes match expected completion |

Test-observer provenance is not restart authority. No deletion, adoption, rename,
generic pending cleanup or new reconciliation protocol is authorized by this
package; §4's unknown-residue refusal remains in force. This is a bounded
availability limitation, not automatic recovery from every crash. All successful
explicit exact retries require the candidate and completion file/directory syncs
above. Source/workspace/candidate locks span finish and final source checks.
Original source, backup and old records remain untouched.

### 12.7 Safe errors and bounded verification ownership

Public converter errors are fixed local literals:

```text
MAINTENANCE_INVALID, MAINTENANCE_AUTH_DENIED, MAINTENANCE_APPROVAL_DENIED,
MAINTENANCE_TARGET_STALE, MAINTENANCE_PLAN_STALE,
MAINTENANCE_CONVERSION_CONFLICT, MAINTENANCE_READ_UNAVAILABLE,
MAINTENANCE_DURABILITY_UNCERTAIN
```

Map recovery/storage failures conservatively through safe private identity or
nonreflective handling, never foreign exception text. Old facade errors retain
their `RECOVERY_*` vocabulary; §12.4's status-only conservative classification
does not turn a malformed owner into valid ownership or ordinary workflow state.

The three adjudicated expectation clarifications in §§12.4 and 12.6 require new
native assertions for resolved close responses, unknown pending residue and
status-specific classification. Retain the original RED evidence (207 pass,
3 fail); these documentation corrections neither relabel it PASS nor claim that
amended tests have executed. Parent QA independently checks the frozen contract
and new evidence. The seven private session methods are the approved §12.2
B0.2b extension; the public recovery facade remains exactly eight methods with
no converter operational wiring or migration rollout, time-authority or schema-5
backup-readiness claim.

The source lane owns recovery.js, the two new internal modules and only a
narrowly necessary fixed recovery-candidate helper, plus this contract. It owns
syntax/pure probes and source-hash handoff. An independent test lane owns the
new candidate-schema-v5 test and dedicated fixtures, including later native
private-candidate lifecycle, preserved-row, approval/time, fault/COMMIT and
durability checks. Source work neither reads nor runs that lane's moving tests.
No dependencies, commits, pushes, services, production DB/config changes,
server/MCP/CLI/export-barrel wiring or actual rollout belong to this assignment.

### 12.8 Finite authenticated recovery-budget prerequisite

The parent-approved prerequisite adds only
`isRecoveryOperationBudget(value) -> boolean` to `recovery-records.js`: its
entire implementation is the existing module-private WeakSet's `has(value)`.
It exposes no registrar, callback or mutable private state. Copies, Proxies and
primitives do not acquire identity. Existing budget construction, frozen
facades and record formats remain unchanged; records do not import v5.

`assertImSchemaV5Internal(db,parentBudget)` retains three budget forms:

1. Omitted parent: existing standalone defaults.
2. Trusted standalone composition: ordinary own-data `tick` and `limits`, with
   partial lower-only schema limits and missing keys defaulted. Ordinary caller
   metadata such as `start` remains compatible. The six permitted schema keys
   are the four common DB limits below plus `maxMaintenanceAnchors=10000` and
   `maxMaintenanceMetadataBytes=10485760`. This is trusted composition, not
   ownership authentication.
3. Exact authenticated recovery-budget identity: exactly the six positive
   safe-integer limits `maxMessages<=10000`,
   `maxVerifiedContentBytes<=104857600`, `maxOtherRecords<=10000`,
   `maxElapsedMs<=10000`, `maxFileBytes<=134217728`,
   `maxMetadataEntries<=10000`. No unknown/symbol/accessor/nonenumerable fields
   are accepted. Native Proxy guards precede reflection of parent, limits and
   tick; tick must be synchronous, non-Proxy, non-async and nongenerator.
   Known thenables are refused without accessor evaluation; ordinary rejected
   native promises are observed. Unbranded recovery-shaped parents (file/entry
   methods or either filesystem limit) refuse instead of falling back to form 2.

At composition boundaries pass the **same original parent object**, never a
filtered external substitute. The existing legitimate private v5 accounting
normalizer snapshots limits and tick once, projects only the four common DB
limits, and retains its separate maintenance defaults. It neither drops nor
reinterprets the parent's filesystem caps. Original `file`/`entry` functions and
their accumulated accounting remain available to the rest of the same operation.
No new converter public limits are introduced.

The captured original tick runs with its original receiver before the first DB
read, throughout validation and immediately before valid return. The local
wrapper clock is supplementary: it never refreshes the original elapsed
deadline, including time consumed before entry. Only an actual authenticated
parent-tick invocation may translate an own-data `RECOVERY_BUSY` into a freshly
generated `IM_V2_BUDGET_EXCEEDED`. Other errors from that invocation become fixed
`IM_SCHEMA_MISMATCH`. Arbitrary DB/callback/standalone `RECOVERY_BUSY` is not
globally translated. The accepted B0.1 own-data `IM_V2_BUDGET_EXCEEDED`
classification for standalone/inherited failures is preserved. Error Proxies
are rejected before reflection; no foreign error getters, messages, causes or
raw SQL are exposed. Budget identity does not authenticate arbitrary DB authority
and does not establish a general same-process sandbox.

The dedicated `im-v2-schema-v5-recovery-budget.test.js` suite exercised actual
`operationBudget(validationLimits(...))` against stable legal synthetic v5
fixtures, transition/anchor/business corruption, lower DB caps, retained
filesystem caps, hostile inputs and deterministic original-deadline exhaustion.
Its initial native Node 24.19.0 / SQLite 3.53.3 run passed 25 tests with zero
failures/skips, replacing the concrete shape-incompatibility blocker above.
Parent independent review remains required before resuming the converter lane.
This prerequisite implements no converter, time writer, maintenance execution or
schema-5 operational rollout and grants no B0.2b acceptance.
