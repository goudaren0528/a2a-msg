# Recovery-v5 entry-to-plan bindings (NONRELEASE)

**Conceptual proposal: PASS. Entry/plan DOCUMENT subset: ACCEPTED after
independent review (2026-09-28). Whole C2: IN_PROGRESS; codec/runtime lanes
and S3/H4 NOT READY; Q5 blocked.**

Checked HEAD: `876dbd6a2be28083fbb9eb80bab3856c3b8a28da` (2026-09-28).
This is document-only transcription of the accepted-concept entry/plan decisions.
Independent document review passed. This document acceptance is not codec
implementation, SQLite validation or runtime authority.

Read with the accepted [C2-A intake](im-v2-recovery-v5-intake-contract.md),
[B1 admission](im-v2-recovery-v5-admission-contract.md),
[central phase protocol](im-v2-recovery-v5-phase-contract.md),
[literal state manifest](im-v2-recovery-v5-state-manifest.md),
[state-v1 byte grammar](im-v2-recovery-v5-state-digest-contract.md), and
[current ledger](im-v2-implementation-plan.md#52-接下来按依赖推进的-todo).
All those technical documents stay unchanged. This **accepted, unimplemented document subset**
resolves the central document's pending predecessor enum and observation null/throw
rules; it does not change a C2-A record, validator or hash algorithm.

## 1. Common strict rules, primitives and hash authorities

Exactly eight entry record kinds are defined here: `stageRequest`, `stage`,
`requestLocator`, `staged`, `copyIntent`, `base`, `normalizationIntent`,
`normalizationCompletion`. Each is version1. Four further plan kinds are fully
expanded in §6: `pausePlan`, `preparePlan`, `verifyPlan`, `activationPlan`, also
version1. Central phaseIntent/result/observation and seal2 retain their layouts,
with the explicitly proposed enum/observation refinements below. No final module
signature, codec export list or public eight-operation DTO is implied.

Use exact C2-A discipline recursively: ordinary Object.prototype records, exact
enumerable own data keys, Proxy rejection before reflection; no accessors, symbols,
hidden/extra/missing keys, exotic objects, coercions, toJSON or caller iterators.
Nullable fields are required and explicitly null, not undefined/omitted. Strictly
snapshot historical nested objects before invoking old codecs. Detached deeply
frozen normalized records; canonical ordered JSON.stringify UTF-8 bytes, no BOM,
whitespace or trailing newline, **65536 bytes per complete encoded record including
nested witnesses**. A native locator exceeding that cap refuses; do not trim its
nativeRecord witness or raise the cap. Aggregate validator bundles are not extra
serialized record kinds; every contained record retains its own cap.

Decode uses bounded owned ordinary Buffer/Uint8Array bytes, intrinsic length/backing
checks, no shared/shadowed/exotic byte input, fatal UTF-8 and byte-identical canonical
re-encoding. Reject duplicate/escaped-alias/reordered keys, alternate numbers/escapes
and trailing data. Encode/hash errors are fixed RECOVERY_INVALID; decode/content
binding failures RECOVERY_EVIDENCE_MISMATCH. Explicit invalid phase/observation
selection uses RECOVERY_INVALID as stated in §9. No foreign exception properties,
messages, paths or causes become error authority or output.

| Primitive | Exact meaning |
| --- | --- |
| U | Lowercase UUID string, length36, `^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$` |
| H | Exactly 64 lowercase hex characters |
| N | Nonnegative safe integer through 9007199254740991; reject -0; times are milliseconds |
| R | P5 Ref, 1..255 UTF-16 units, no C0/DEL; no normalization, lossless JSON lone-surrogate escaping |
| T? | Required T or explicit null |
| Route | `native-v5` or `converted-v4`, matching C2-A |
| K | fresh_bootstrap, v3_import or snapshot_recovery |
| Source pair | Native5:5/exact V5; converted fresh:null/null, import:3/exact V3, snapshot:4/exact V4 |
| Target pair | Always literal5 / exact V5_CHECKSUM |

Checksums use the actual constants in schema-history.js, schema-internal.js and
schema-v5-internal.js. V5 is
`80eba5e6ce61261d31ec495216c3b6eb8c7a8f0c87edcbb1440372353f495435`.

```text
Hnew(kind, record) = SHA256(UTF8('a2a-msg.im.v2/recovery-v5/' + kind + '\n')
                          || canonicalRecordBytes)
requestHash = Hnew('stageRequest', request)
locatorReference = 'v5-requests/' + SHA256(UTF8(JSON.stringify(requestRef))) + '.json'
```

The newline is one LF, not NUL. stageHash means Hnew('stage', newStage), not old
raw stage hash. Staged/entry/plan links use their exact new kinds. File hashes
hash actual bytes, not JSON. State digests use the accepted state-v1 stream, not
the 64KiB record grammar. Historical raw/NUL/newline hashes remain unchanged:

| Evidence | Existing algorithm / verified source |
| --- | --- |
| C1 record4/source2 hashes | Raw canonical SHA-256, backup-v5-records.js:143-144 |
| Old stage/staged/source/closureProof | Raw hashRecoveryRecord, recovery-plan.js:115-125; old closure kind is closureProof even when this proposal labels its role legacyClosureProof |
| requestRef locator component | Raw JSON string hash, recovery-plan.js:126; **not** old request-input hash at127-132 |
| Conversion owner/pause | Existing recovery-conversion-records.js:46-49,115-119 ASCII domain + NUL |
| Historical conversion plan/proof/completion | Existing maintenance-v5-records.js:12-21,224-225 newline domains |
| C2-A intake/handoff/archiveIntent; B1 conversionSelection/new closure | Their existing recovery-v5 kind domains |

Sources: [backup-v5-records.js](../src/im/v2/backup-v5-records.js),
[recovery-plan.js](../src/im/v2/recovery-plan.js),
[recovery-conversion-records.js](../src/im/v2/recovery-conversion-records.js),
[maintenance-v5-records.js](../src/im/v2/maintenance-v5-records.js).
New request fingerprint is owner-constructed from authenticated selection facts.
Callers never provide record hashes, stage hashes, source witnesses or plan objects.
Actual public operation input DTOs are still pending, not inferred from these records.

## 2. Selection, source identity and immutable locator

### 2.1 stageRequest ordered fields

| Field | Type / binding |
| --- | --- |
| version | 1 |
| requestRef | R |
| selectionRef | R; genuine constructor catalog key |
| route | Route |
| selection | Exact native or converted nested union below |
| isolationAckRef | R?; null only converted fresh |
| executionPolicyHash | H; actual approved execution policy |
| targetSchemaVersion | 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |

Native selection exact order:

| Field | Type / binding |
| --- | --- |
| kind | registered-native5 |
| backupId | U |
| recordHash | H; raw C1 record hash |
| sourceEvidenceHash | H; raw C1 source2 hash |

Converted selection exact order:

| Field | Type / binding |
| --- | --- |
| kind | completed-conversion |
| runId | U; original genuine old run |
| legacyStageHash | H; old raw stage |
| legacyStagedHash | H; old raw staged |
| conversionPlanHash | H; historical maintenance conversion plan |
| conversionProofHash | H; historical maintenance conversion proof |
| conversionCompletionHash | H; historical maintenance conversionComplete |

Native run is generated internally once. Converted retains original run, candidate
and canonical protected workspace. Under workspace control reserve **one unique
target5 locator for that converted run before handoff**; bounded collision checks
must include other requestRef mappings. Same requestRef with a different fingerprint
rejects; a second target5 reservation for the same converted run is not a new run.
Compare raw requestRef as well as filename hash. No implicit conversion/approval
occurs at stage: old stage -> genuine target -> preview -> independent approval ->
completed conversion remains B1's separate prerequisite.

### 2.2 stage ordered fields

| Field | Type / binding |
| --- | --- |
| version | 1 |
| requestRef | R; request.requestRef |
| requestHash | Hnew(stageRequest) |
| selectionRef | R; request.selectionRef |
| route | Route; request.route |
| runId | U |
| candidateReference | Native `v5-runs/<runId>/candidate.sqlite`; converted `runs/<runId>/candidate.sqlite` |
| candidateKind | K |
| preparationRef | R? |
| instanceId | U |
| instanceCreatedAt | N |
| sourceRef | R?; original closure/catalog reference, not necessarily embedded backup ref |
| sourceSchemaVersion | Required null,3,4,5 per route |
| sourceSchemaChecksum | H?; exact paired checksum |
| sourceEvidenceHash | H?; correct raw source hash, null fresh |
| closureKind | Required null, closureProof or legacyClosureProof |
| closureHash | H?; new B1 closure hash or old raw proof hash, null fresh |
| isolationAckRef | R?; request value, original isolation for converted |
| executionPolicyHash | H; request policy |
| selectionHash | H?; null native, Hnew(conversionSelection) converted |
| targetSchemaVersion | 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| createdAt | N; retained first stage time |

Stage deliberately contains **no intake or hold field**. This removes the stage ->
hold -> intake -> stage cycle. Stage hash is computed before a native hold exists.

| Route | Required stage facts |
| --- | --- |
| Native | snapshot_recovery; prep null; genuine record/source identity; source5; raw C1 sourceEvidenceHash; sourceRef is selected catalog/closure key (selectionRef), closureKind closureProof with new B1 hash; selectionHash null |
| Converted fresh | Old fresh kind/prep/identity; sourceRef/schema/checksum/evidence/closureKind/closureHash/isolation all null; selectionHash nonnull even though original source absent |
| Converted import | Old v3_import/prep/identity; original sourceRef/schema3/evidence/isolation, legacyClosureProof/old raw hash; registered or closed historical variant retained |
| Converted snapshot | Old snapshot_recovery, prep null; original registered4 sourceRef/schema4/evidence/isolation and legacyClosureProof/old hash |

Converted originalSourceRef is **not replaced by selectionRef**. Native stage
sourceRef/catalog key may differ from source2.sourceRef=`backup:<backupId>`.
Unchanged C2-A nativeIntake.sourceRef still equals that embedded backup ref; it
is not silently changed to the stage's catalog key. Closed3 sourceRef/isolation
must equal original evidence. No new attestation relabels an old closure proof.

### 2.3 requestLocator ordered fields

| Field | Type / binding |
| --- | --- |
| version | 1 |
| request | Exact stageRequest |
| requestHash | Hnew(stageRequest, request) |
| stage | Exact new stage |
| stageHash | Hnew(stage, stage) |
| nativeRecord | Exact C1 record4 native-v5 native; required null converted |
| sourceEvidence | Native C1 source2; converted original historical source; null fresh |
| sourceClosedEvidence | Native new B1 closureProof; converted old proof; null fresh |
| conversionSelection | Native null; exact B1 conversionSelection converted |

The full native record witness is durably retained in locator; backup ID alone is
insufficient. Its exact unchanged order (backup-v5-records.js:10) is:

```text
recordVersion,backupId,instanceId,instanceCreatedAt,schemaVersion,schemaChecksum,
fileHash,manifestHash,completedAt,artifactReference,publicationKind,
sourceEvidenceHash,registeredAt
```

Require recordVersion4/publicationKind native-v5/schema5/exact checksum, U backup/
identity, N birth/completion/registeredAt, H file/manifest/source hashes, and
artifactReference exactly `registry/artifacts/<backupId>.sqlite`. Recompute
request.selection.recordHash with **raw C1** hash. Source exact order (same file:11):

```text
version,kind,sourceRef,registryFormat,instanceId,instanceCreatedAt,backupId,
fileHash,manifestHash,schemaVersion,schemaChecksum,completedAt,importedRecordHash
```

Require version2/kind registered-backup/registryFormat4/exact5, importedRecordHash
null, sourceRef exactly `backup:<backupId>`. Record/source backupId, identity/birth,
schema/checksum, fileHash, manifestHash and completedAt all agree. Record's
sourceEvidenceHash and request.selection.sourceEvidenceHash equal raw C1 source
hash. Do **not** fabricate registeredAt versus created/completed chronology;
C1 explicitly keeps scalar times without those inequalities (lines93-95).
Runtime compares actual genuine B2 record **and** source canonical bytes with the
retained locator witnesses on every relevant admission, not only IDs/hash syntax.

Native closure validates B1 bundle from actual source facts, stage sourceRef/
isolation, source hash and target pair; locator proof hash equals stage.closureHash.
Converted locator has canonical original source/proof, and conversionSelection
binds old stage/staged/source/closure/hold per B1. Its selectionRef=request key,
run/kind/prep/identity/policy match new stage; selectionHash is its new hash.
Request's conversion plan/proof/completion hashes match the actual full C2-A
archive bundle. Fresh converted has sourceEvidence/sourceClosedEvidence null;
conversionSelection remains nonnull. Every request/stage/locator common field and
hash is checked, with no extra self-hash field on locator.

## 3. Native-only copy, base and normalization

Converted routes have **none** of these four new records. Their old intake copy/
normalization history remains untouched inside the original protected workflow.
Native5 source artifact is immutable; candidate copy is independent, never a live
source hardlink. Native full5 content and accepted state digest grammar apply.

### 3.1 copyIntent ordered fields

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| stageHash | H; new stage |
| candidateReference | Exact native path |
| backupId | U; locator record/source |
| sourceEvidenceHash | H; raw C1 source hash |
| sourceFileHash | H; exact source.fileHash |
| sourceSchemaVersion | 5 |
| sourceSchemaChecksum | Exact V5_CHECKSUM |
| targetSchemaVersion | 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| createdAt | N; >= stage.createdAt |

### 3.2 base ordered fields

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| stageHash | H |
| candidateReference | Exact native path |
| copyIntentHash | Hnew(copyIntent) |
| candidateBaseHash | H; exactly sourceFileHash and actual independent-copy bytes |
| stateDigest | H; exact5 complete initial logical state |
| headerMode | DELETE or WAL; actual closed copied file header |
| writeMode | paused or enabled; actual copied setting |
| instanceId | U; actual source identity |
| instanceCreatedAt | N; actual birth |
| initialEpoch | U; actual initial snapshot epoch |
| previousRecoveryCounter | N; actual initial snapshot counter |
| completedAt | N; >= copyIntent.createdAt |

Publish base only after exact source hash copy, full5/digest/identity/epoch/counter/
mode/header/protection checks, and copy file/directory durability. No source
normalization. copied-WAL reading exception is solely an **exclusively owned,
completed, exact-source-hash pre-mutation copy**, protected stable identity with
no sidecars; never a mutable/post-mutation journal bypass.

Native C2-A intake is issued **before normalization**, using independent actual
inspection and unchanged C2-A intake validator. candidateInitialHash=base hash=
source file hash; retain observed initial facts and genuine hold. Additional new
entry ordering requires intake.acceptedAt >= base.completedAt and hold.createdAt.
This is entry-publication chronology, not a modification of C2-A's pure codec or
C1 registeredAt time rules.

### 3.3 normalizationIntent ordered fields

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| stageHash | H |
| candidateReference | Exact native path |
| baseHash | Hnew(base) |
| intakeHash | Hnew(nativeIntake) |
| inputFileHash | H; base.candidateBaseHash |
| stateDigest | H; base.stateDigest |
| originalHeaderMode | DELETE or WAL; base.headerMode |
| targetHeaderMode | DELETE |
| createdAt | N; >= intake.acceptedAt |

Publish and sync intent **before writable candidate open**. DELETE-original path
does no writable open or normalization transaction. WAL path is candidate-only
owned normalization; verify full logical schema/rows/rowids/storage classes,
encoded pragmas and original SQL bytes equal before/after. No raw sidecar deletion,
unknown journal recovery or source mutation. Actual byte grammar remains the
accepted state-v1 contract, including all100 objects and 32 tables.

### 3.4 normalizationCompletion ordered fields

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| stageHash | H |
| candidateReference | Exact native path |
| normalizationIntentHash | Hnew(normalizationIntent) |
| baseHash | Hnew(base) |
| intakeHash | Hnew(nativeIntake) |
| inputFileHash | H; original exact copy hash |
| normalizedFileHash | H; actual closed normalized candidate |
| stateDigest | H; unchanged base/intent digest |
| outcome | observed-noop for DELETE original; normalized for WAL original |
| completedAt | N; >= normalizationIntent.createdAt |

DELETE-original observed-noop requires normalizedFileHash=inputFileHash. WAL-original
normalized requires standalone DELETE, no sidecars, same complete logical state;
**no forced file-hash inequality** is introduced. Sync candidate/evidence before
success. Completion absent: only original exact input hash, original header and
no sidecars allow retry of same intent. Changed bytes/header remain INDETERMINATE
even if logical digest appears equal. Existing completion must validate exactly
and resync on explicit retry; no generic adoption, repair or new timestamp.

## 4. staged and hold identities

### 4.1 staged ordered fields

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| stageHash | H; new stage |
| candidateReference | Exact route path |
| route | Route |
| intakeKind | nativeIntake or convertedIntake |
| intakeHash | Hnew of exact intakeKind |
| handoffHash | H?; null native, C2-A conversionHandoff hash converted |
| normalizationHash | H?; Hnew(normalizationCompletion) native, null converted |
| pausePredecessorKind | normalizationCompletion native; convertedIntake converted |
| pausePredecessorHash | H; corresponding completion/intake hash |
| instanceId | U |
| instanceCreatedAt | N |
| initialEpoch | U; exact retained intake |
| previousRecoveryCounter | N; exact retained intake |
| candidateKind | K; stage |
| preparationRef | R?; stage |
| holdId | U? |
| holdStageHash | H? |
| stagedAt | N; last entry publication time |

stagedAt >= stage.createdAt, intake.acceptedAt and, native only,
normalizationCompletion.completedAt. It is **not a pause proof**. Native staged
candidate may still be enabled; a later pause phase establishes paused state.

| Source route | hold / holdStageHash |
| --- | --- |
| Native registered5 | Nonnull genuine hold, hold.backupId=source backup, recoveryRunId=runId; hold.stageHash=new stageHash; staged holdId/hash and intake.holdId agree |
| Converted registered3/4 | Nonnull original hold; hold.stageHash=**historical raw legacyStageHash forever**, not new stage/intake hash; B1 selection, C2-A archive and staged/intake holdIds agree |
| Converted fresh or closed3 | hold null; staged holdId/holdStageHash and intake holdId both null |

Historical hold exact order remains
`version,holdId,backupId,recoveryRunId,stageHash,createdAt`
([recovery-records.js](../src/im/v2/recovery-records.js):99-100). Future prepare
binding may bind the new preparePlanHash under the original converted hold stage;
do not rewrite hold.stageHash. Initial admission requires genuinely unreleased/
unbound source hold, later operations require the exact appropriate existing
prepare binding and current source state. Pure JSON hold consistency proves none
of those private lifecycle facts.

## 5. Exact Entry bundle and initial consistency projection

Entry has exactly these required fields in this order:

```text
locator,staged,intake,hold,copyIntent,base,normalizationIntent,
normalizationCompletion,archiveEvidence,legacyClosureProof
```

| Branch | Required nonnull | Required null |
| --- | --- | --- |
| Native | locator/staged/nativeIntake/hold and all four copy/base/normalization records; locator.nativeRecord/sourceEvidence/new closure | archiveEvidence, legacyClosureProof, locator.conversionSelection |
| Converted registered | locator/staged/convertedIntake/hold/full C2-A archiveEvidence/nonfresh old legacyClosureProof; locator.conversionSelection/original source/proof | all four new copy/base/normalization records, locator.nativeRecord |
| Converted closed3 | As converted, with original closed source/proof and full archiveEvidence | hold plus converted nulls above |
| Converted fresh | locator/staged/convertedIntake/full archiveEvidence/conversionSelection | hold, all four new copy/base/normalization records, legacyClosureProof, locator nativeRecord/sourceEvidence/sourceClosedEvidence |

archiveEvidence is exactly the **complete unchanged C2-A archive bundle**, ordered
archiveIntent,handoff,legacyStage,legacyStaged,owner,pauseIntent,paused,conversionPlan,
conversionProof,conversionCompletion,hold. Its hold must canonically equal Entry.hold.
legacyClosureProof equals locator.sourceClosedEvidence for nonfresh converted,
passes B1 conversionSelection validator with old stage/staged/hold, and binds old
stage ref/hash/isolation/source facts. No source1->source2 translation. Converted
request selection hashes must match actual archive historical plan/proof/completion
and old stage/staged; new stage source facts/kind/prep/identity/policy agree with
B1 selection and C2-A intake/archive.

Validate every entry record, route null rule, request/stage/locator hash, source/
closure witness, candidate reference, identity/birth, schema/checksum, initial
epoch/counter, policy and hold relation in §§2-4. Native compare actual source
hashes across locator/copy/base/intake and unchanged stateDigest through normalization.
Converted require staged handoffHash/intakeHash/pause predecessor and all C2-A
archive/intake comparisons. No timestamps or identity are regenerated for a retry.

### 5.1 Runtime initial observation versus pure historical consistency

**Before first intake publication**, runtime must independently inspect the closed,
protected actual candidate under genuine controls and call unchanged
`validateRecoveryV5IntakeBindings({intake,sourceEvidence,archiveEvidence,actual})`.
Source/hold/closure authentication is additional to that pure call. A constructed
DTO is never substituted for actual runtime observation at initial admission.

For later **pure Entry** validation only, construct named internal
`initialConsistencyProjection` in exactly C2-A actual-field order:

| Field | Native from base | Converted from handoff/intake |
| --- | --- | --- |
| instanceId | base.instanceId | handoff.instanceId |
| instanceCreatedAt | base.instanceCreatedAt | handoff.instanceCreatedAt |
| schemaVersion | 5 | handoff.targetSchemaVersion=5 |
| schemaChecksum | Exact V5_CHECKSUM | handoff.targetSchemaChecksum |
| centerEpoch | base.initialEpoch | handoff.centerEpoch |
| recoveryCounter | base.previousRecoveryCounter | intake.previousRecoveryCounter |
| fileHash | base.candidateBaseHash | handoff.liveInitialHash |
| writeMode | base.writeMode | paused |

Pass that projection to the unchanged pure C2-A validator solely to check retained
record consistency. It is not observed data, source/ownership brand or new export.
Converted fresh/import counter must be0; converted snapshot counter here is a
**retained claim, not independently proven by the pure projection**. Runtime
immutable-baseline/replay/current-state checks independently establish actual facts.
Never use an advanced current DB's facts as initial `actual`, or demand current
bytes equal the obsolete base/intake/normalized hash after a legitimate phase.

## 6. Four fully expanded plan records

All plans bind exact Entry.stage/staged/intake/handoff/hold/policy and the same
genuine immutable baseline across the run. Baseline is the accepted ordered six
fields `kind,reference,fileHash,sourceEvidenceHash,handoffHash,stateDigest`:
native registered-native5 actual artifact reference/file/raw C1 source hash/null
handoff; converted conversion-archive actual archive reference/hash/null source
hash/new-domain handoff. Native baseline stateDigest equals base/normalization
digest; converted baseline digest is independently inspected immutable archive
state. Pure matching baseline claims do not authenticate a filesystem observation.

Every expiresAt is exactly createdAt+300000 with safe arithmetic; reject overflow.
No refresh/renew/replan of an existing immutable plan. All IDs/epochs selected once
by trusted owner before publication. Approval reference/actors are **not plan
fields**; capture them later in intent under B1/central authorization.

### 6.1 pausePlan ordered fields

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| stageHash | Hnew(stage) |
| stagedHash | Hnew(staged) |
| route | Route |
| candidateReference | Exact route path |
| intakeKind | nativeIntake or convertedIntake |
| intakeHash | Hnew(intakeKind) |
| handoffHash | H?; null native |
| baseline | Exact six-field baseline |
| instanceId | U |
| instanceCreatedAt | N |
| sourceSchemaVersion | Required null,3,4,5 |
| sourceSchemaChecksum | H?; exact pair |
| targetSchemaVersion | 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| executionPolicyHash | H |
| holdId | U?; Entry hold |
| holdStageHash | H?; Entry hold.stageHash |
| predecessorKind | normalizationCompletion or convertedIntake |
| predecessorHash | H; staged.pausePredecessorHash |
| predecessorFileHash | H; native normalizedFileHash or converted candidateInitialHash |
| predecessorStateDigest | H; native normalization digest or converted baseline digest |
| previousClock | N; actual replay-derived predecessor clock |
| effect | Exact central pause effect |
| createdAt | N; >= staged.stagedAt |
| expiresAt | N; exactly createdAt+300000 |

Native predecessor is normalizationCompletion; converted is convertedIntake whose
candidateInitialHash=handoff.liveInitialHash. Converted effect originalWriteMode is
paused; native uses retained base mode (normalization cannot change it). target
mode paused. previousClock is replay-derived; do not substitute a publication time.

### 6.2 preparePlan ordered fields

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| stageHash | Hnew(stage) |
| stagedHash | Hnew(staged) |
| route | Route |
| candidateReference | Exact route path |
| intakeKind | nativeIntake or convertedIntake |
| intakeHash | Hnew(intakeKind) |
| handoffHash | H?; null native |
| baseline | Same exact six-field baseline |
| instanceId | U |
| instanceCreatedAt | N |
| sourceSchemaVersion | Required null,3,4,5 |
| sourceSchemaChecksum | H?; exact pair |
| targetSchemaVersion | 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| executionPolicyHash | H |
| holdId | U? |
| holdStageHash | H? |
| pauseResultHash | Hnew(phaseResult, pauseResult) |
| predecessorFileHash | H; pauseResult.candidateFileHash |
| predecessorStateDigest | H; pauseResult.stateDigest |
| previousClock | N; pauseResult.clockFloor |
| effect | Exact central prepare effect |
| createdAt | N; >= pauseResult.phaseAt |
| expiresAt | N; exactly createdAt+300000 |

Prepare effect exact order:

```text
candidateKind,preparationRef,backupId,backupFileHash,manifestHash,candidateBaseHash,
oldEpoch,newEpoch,recoveryCounter,isolationAckRef,rpoReport
```

Bind kind/prep/isolation to stage. Registered quartet comes from **original**
source evidence: backupId, fileHash, manifestHash, and candidateBaseHash=fileHash;
never use converted archive, normalized or current candidate hash. Fresh/closed3
quartet all null. Fresh/import oldEpoch null, newEpoch=actual P1 initialEpoch,
counter0; snapshot oldEpoch=staged.initialEpoch, internal approved newEpoch distinct,
previousRecoveryCounter+1 safely. Generate that epoch once before approval and
retain it across retries. RPO null fresh; otherwise exact old unknown-only order:

```text
status,snapshotCompletedAt,sourceObservedAt,missingAcceptedCount,missingAckCount,
missingReadCount,comparisonEvidenceHash,authChanges,notesCode
```

status/authChanges unknown; counts/comparison null; actual original source completion
or observation time in the appropriate one field, the other null; notesCode
COMPARISON_INCOMPLETE. No new measured RPO or source-unavailable bypass. Central
fixed row projections, explicit rowids, head-only deletion and history preservation
remain unchanged; full effect binding is not authorization to run them.

### 6.3 verifyPlan ordered fields

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| stageHash | Hnew(stage) |
| stagedHash | Hnew(staged) |
| route | Route |
| candidateReference | Exact route path |
| intakeKind | nativeIntake or convertedIntake |
| intakeHash | Hnew(intakeKind) |
| handoffHash | H?; null native |
| baseline | Same exact six-field baseline |
| instanceId | U |
| instanceCreatedAt | N |
| sourceSchemaVersion | Required null,3,4,5 |
| sourceSchemaChecksum | H?; exact pair |
| targetSchemaVersion | 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| executionPolicyHash | H |
| holdId | U? |
| holdStageHash | H? |
| preparePlanHash | Hnew(preparePlan) |
| prepareResultHash | Hnew(phaseResult, prepareResult) |
| predecessorFileHash | H; prepareResult.candidateFileHash |
| predecessorStateDigest | H; prepareResult.stateDigest |
| previousClock | N; prepareResult.clockFloor |
| effect | Exact ordered preparePlanHash,prepareResultHash; equal plan's corresponding fields |
| createdAt | N; >= prepareResult.phaseAt |
| expiresAt | N; exactly createdAt+300000 |

### 6.4 activationPlan ordered fields

| Field | Type / binding |
| --- | --- |
| version | 1 |
| runId | U |
| stageHash | Hnew(stage) |
| stagedHash | Hnew(staged) |
| route | Route |
| candidateReference | Exact route path |
| intakeKind | nativeIntake or convertedIntake |
| intakeHash | Hnew(intakeKind) |
| handoffHash | H?; null native |
| baseline | Same exact six-field baseline |
| instanceId | U |
| instanceCreatedAt | N |
| sourceSchemaVersion | Required null,3,4,5 |
| sourceSchemaChecksum | H?; exact pair |
| targetSchemaVersion | 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| executionPolicyHash | H |
| holdId | U? |
| holdStageHash | H? |
| preparePlanHash | Hnew(preparePlan) |
| prepareResultHash | Hnew(phaseResult, prepareResult) |
| verifyPlanHash | Hnew(verifyPlan) |
| verifyResultHash | Hnew(phaseResult, verifyResult) |
| sealHash | Hnew(seal) |
| sealReference | Exactly `v5-runs/<runId>/seals/<sealHash>`; **suffixless** |
| predecessorFileHash | H; seal.candidateFileHash=verifyResult.candidateFileHash |
| predecessorStateDigest | H; seal.stateDigest=verifyResult.stateDigest |
| previousClock | N; verifyResult.clockFloor |
| effect | Exact central activation effect |
| createdAt | N; >= seal.verifiedAt |
| expiresAt | N; exactly createdAt+300000 |

Activation effect exact order is preparePlanHash,prepareResultHash,verifyResultHash,
sealHash,authReviewRef,isolationAckRef,activationRef. Hashes equal this plan and
actual prior records; isolation agrees with entry route. authReviewRef and
activationRef require independent trusted authorization/binding, not arbitrary
strings treated as approval. Trusted auth-review authorization MUST cover the exact
subject tuple `{runId,preparePlanHash,sealHash,newEpoch,authReviewRef}` for this
activation: runId from the actual validated run, preparePlanHash from its actual
validated prepare plan, sealHash from the actual validated seal, newEpoch from
the validated prepare effect and equal to that seal's newEpoch, and authReviewRef
equal to the activation effect's reference. Recognizing the reference alone or
authorizing a tuple for another run, prepare plan, seal or epoch is insufficient.
An authReviewRef authorized for subject A cannot authorize subject B. Pure string/
hash presence does not authorize activation; runtime trusted authorization of this
same tuple MUST be rechecked according to the phase protocol.

Actual old precedent is [recovery.js](../src/im/v2/recovery.js) lines 989-991,
which constructs this subject tuple; lines 1033-1054 validate the run/prepare/seal
and recheck authorization around activation-plan binding. This citation does not
freeze a new adapter API. Exact adapter name, public DTO and full runtime signature
remain PENDING (§13); these required subject-binding facts are **not pending**.

## 7. Full Chain, public binding validator contracts and pure graphs

Chain is exactly this ordinary own-data envelope, in order:

```text
entry,pausePlan,pauseIntent,pauseResult,preparePlan,prepareIntent,prepareResult,
verifyPlan,verifyIntent,verifyResult,seal,activationPlan,activationIntent,activationResult
```

entry is required nonnull Entry. All 13 later fields are required nullable.
For each phase, absence -> plan -> intent -> result is contiguous: no intent
without plan, no result without intent, no next plan before prior result. Seal
requires verify result; activationPlan requires seal. verifyResult with no seal
is valid seal-pending. There are at most four phase executions, no duplicates or
extra phase records; unknown keys reject. Whole namespace pending-file rules are
runtime requirements beyond this content envelope.

Proposed public **binding validator contracts**, denoted by role (not a new module
export naming decision):

| Role | Exact input | Success output |
| --- | --- | --- |
| Entry | Entry envelope directly | Detached deeply frozen entry.staged |
| Plan | `{chain,phase}` | Detached deeply frozen selected persisted phase plan |
| Intent | `{chain,phase}` | Detached deeply frozen selected persisted phaseIntent |
| Result | `{chain,phase}` | Detached deeply frozen selected persisted phaseResult |
| Seal | `{chain}` | Detached deeply frozen chain.seal |
| Observation | `{chain,phase,observation}` | Detached deeply frozen validated phaseObservation |

phase is exactly pause/prepare/verify/activate. Selected record must exist; invalid
selection/phase is RECOVERY_INVALID, malformed content/crossbindings mismatch.
**Every Chain validator first validates the whole envelope, Entry, all present
records, all contiguous prefixes and all hash relations**, including later records
than the selected one. Only then select a historical record or form a prefix
projection. Malformed later evidence cannot be hidden by selecting an earlier
plan/result. There is no implicit creation mode that tolerates missing prerequisites
or lets supplied JSON establish source/ownership authority.

### 7.1 Exact plan and phaseIntent comparisons

Every plan's common entry fields equal the validated stage/staged/intake, including
stageHash/stagedHash, route/candidate path, kind/hash, handoff, identity/birth, original
source and exact target pair, executionPolicyHash and holdId/holdStageHash. Baseline
six-field canonical bytes are identical across all plans/intents; route-specific
source/archive facts and stateDigest links follow §6. Check each plan's full effect,
predecessor bindings, TTL/chronology and every repeated plan/result/seal hash.

Proposed exact **phaseIntent.predecessorKind enum**:

```text
normalizationCompletion | convertedIntake | phaseResult | seal
```

| Selected phase | Required intent predecessorKind/hash |
| --- | --- |
| pause native | normalizationCompletion / Hnew(normalizationCompletion) |
| pause converted | convertedIntake / Hnew(convertedIntake) |
| prepare | phaseResult / Hnew(phaseResult, pauseResult) |
| verify | phaseResult / Hnew(phaseResult, prepareResult) |
| activate | seal / Hnew(seal) |

This resolves the pending native normalization versus provisional intake link, and
uses generic serialized kind phaseResult rather than treating semantic roles
pauseResult/prepareResult as new record kinds. This **unimplemented pending-review
enum amendment** changes no C2-A field or existing codec. Prior accepted document
snapshots are not edited to suggest runtime implementation already exists.

Intent must match plan/entry run/path/stage/intake/handoff/baseline/identity/source/
target facts, exact planKind and planHash, predecessorKind/hash, initialFileHash=
plan.predecessorFileHash, beforeStateDigest=plan.predecessorStateDigest,
previousClock=plan.previousClock and canonical effect. No omitted policy check:
plan binds executionPolicyHash to entry even though intent carries it only through
plan/baseline links. executeBefore exactly plan.expiresAt. reservedAt >= plan.createdAt,
previousClock and all applicable prior phase times, and reservedAt < expiresAt.

Pause/verify approvalRef/executorId/approverId all null. Prepare/activate all nonnull
R with executorId != approverId, captured under B1 approval and persisted once.
Mode observe-noop only pause with originalWriteMode paused, beforeDigest=afterDigest;
transaction requires unequal digests (pause enabled changes only mode; all other
phases transaction). **afterStateDigest remains a prediction claim in pure JSON**:
runtime independently derives it by immutable baseline replay and exact fixed
projection; pure crossbinding cannot prove execution or actual state.

### 7.2 Result and seal comparisons

Result phase/run/path/identity/target/intake/handoff fields equal intent/plan;
intentHash and planHash recomputed with exact new kinds. stateDigest=intent.afterStateDigest;
phaseAt=intent.reservedAt; clockFloor=previousClock for pause, reservedAt otherwise.
state is paused/prepared/verified/active according to phase. outcome is observed-noop
only for observe-noop pause, committed for transaction. candidateFileHash is H
claimed by durable closed-file result; actual matching is runtime/Observation work.
No publication-time replacement of phaseAt and no COMMIT claim for no-op.

Seal2 binds all entry stage/intake/handoff/identity/source-target fields; actual
preparePlanHash, verifyIntentHash and verifyResultHash; newEpoch/recoveryCounter
from prepare effect; file/digest from verifyResult; verifiedAt=verifyResult.phaseAt;
paused mode and exact verification object order integrity,foreignKeys,schema,
invariants, each true. Its reference uses new-domain seal hash and suffixless path.
Activation plan/intent must bind that seal. Completed active result does not
invent terminal activationCompletion/release records.

### 7.3 Directed dependency graph (no self/future hash cycles)

```text
genuine source / completed old conversion -> owner stageRequest
stageRequest + old facts / closure / B1 selection -> new stage
request + stage + retained witnesses -> requestLocator
new stage -> native hold -> copyIntent -> base -> nativeIntake
base + nativeIntake -> normalizationIntent -> normalizationCompletion
new locator reservation + completed conversion -> C2-A archive/handoff -> convertedIntake
stage + intake + route predecessor + actual hold -> staged
Entry -> pausePlan -> pauseIntent -> pauseResult
pauseResult -> preparePlan -> prepareIntent -> prepareResult
prepareResult -> verifyPlan -> verifyIntent -> verifyResult -> seal
seal -> activationPlan -> activationIntent -> activationResult
```

Embedded witnesses/repeated old hashes point backward to immutable facts. Stage
has no intake/holdHash; nativeIntake holds only the allocated hold ID, not a staged
hash. Converted B1 selection points at old stage, never new stage. Plans contain
no future intent/result/seal hash of their own phase (activation binds prior verify
seal); none stores its own hash. Nested baseline/effect add only prior facts.
Full-chain validation is not a backwards mutation or record creation dependency.

## 8. Runtime frontier is separate from historical pure validation

After complete Entry/Chain validation, derive runtime frontier in this order:

1. First phase with plan but no result is `planned` (no intent) or `intended`
   (intent present). Contiguity prevents a later completed phase past it.
2. Otherwise verifyResult without seal is `seal-pending`.
3. Otherwise highest completed phase is ready for next phase, or activate complete.
4. Before pausePlan, Entry is complete and ready for pause planning.

Plan-only leaves the DB at the previous boundary; a plan is not a mutation/result.
Creation may target only the current frontier. Never remutate an earlier completed
phase, silently recreate an old plan or advance across an incomplete frontier.

A historical completed operation retry validates **whole Entry + whole Chain +
actual current frontier**, current authority, durability and immutable baseline/
replay, then returns the retained receipt for that operation. It does not recopy,
renormalize, repause, regenerate IDs/times or remint ownership. If current frontier
is pending/indeterminate/conflicting, classify/refuse it rather than returning old
success that hides the problem. Stage retry after prepare/active never requires
obsolete intake/normalization live file hashes; converter history is checked through
immutable archive plus the later phase chain.

Source/isolation/closure authorization and correct current hold/binding remain
required. New prepare binds new plan hash under native new-stage hold or converted
historical-stage hold. Completion-only reconciliation follows central rules:
exact committed/noop completion can be expiry-exempt with current admin/source/
closure and reconciliation policy for persisted actors; exact prestate mutation
retry needs same intent, unexpired plan and current applicable mutation approval.
No replacement actor, renewal, implicit five-second window or authorization from
hashes. Current reconciliation policy may deny a revoked historical actor/caller.

## 9. Complete-facts observations or refusal

This proposal resolves the previous observation unknown-fact gate as follows:
phaseObservation actualStateDigest **H**, actualFileHash **H**, actualClock **N**
are always nonnull when returned; resultHash is required H or null. Other ordered
fields stay version,runId,phase,intentHash,classification before those facts and
resultHash. Classification remains noop-matched/initial/committed/indeterminate.
No fabricated partial observation DTO or invented unknown hash/clock value.

Observation validator first validates entire Chain, then requires selected intent
to exist. Selected phase must be the current intended frontier, or the latest
completed phase when **no later intent/result** exists. A later plan-only may still
observe the preceding completed boundary. Plan-only has no observation for its own
phase. Earlier current-DB observation after a later intent exists is RECOVERY_INVALID,
even though separate historical Plan/Intent/Result inspection is valid.

### 9.1 Selected result is present

Require all of:

```text
actualStateDigest = result.stateDigest = intent.afterStateDigest
actualClock = result.clockFloor
actualFileHash = result.candidateFileHash
resultHash = Hnew('phaseResult', result)   (nonnull)
```

classification is committed for transaction, noop-matched for observe-noop. Any
conflict is RECOVERY_EVIDENCE_MISMATCH, **not** initial, null-result retry or an
indeterminate DTO that discards the existing completion. Result presence enforces
its exact physical file boundary until a later intent takes ownership.

### 9.2 Selected result is absent

resultHash must be null. Dispatch mode before digest comparisons:

| Mode/state | Required classification / condition |
| --- | --- |
| observe-noop pause | noop-matched iff actual equals equal before/after digest and previousClock, and actualFileHash=intent.initialFileHash; no writable mutation or COMMIT claim |
| transaction exact logical before | initial with actualClock=previousClock; physical hash must satisfy first admission or the settled same-intent rollback rule |
| transaction exact logical after | committed with actualClock=reservedAt, except pause retains previousClock; file hash is actual settled closed bytes awaiting result |
| Valid complete observations with unexplained delta | indeterminate, resultHash null; no adoption/replanning or successful completion |

Full state digests include clock facts: a contradictory scalar clock is not repaired
from a digest string. Pure validator can compare scalar/digest relationships but
cannot prove rollback settlement, file protection or that a supplied H genuinely
hashes the DB. Runtime validates those facts independently. First admission checks
exact predecessor file/digest. After durable same intent and confirmed rollback/
settled close, logical prestate with different physical bytes may retry **that intent
only**; no fresh seal or initialFileHash replacement.

verifyResult without seal uses the strict result-present boundary. Seal present
without activationIntent also requires exact seal/result file and digest, even if
activationPlan exists. Once activationIntent exists, it alone owns the central
same-intent logical rollback exception; never use an obsolete seal to authorize
a new activation intent over changed bytes. Expired prestate is stale; exact post
may reconcile after expiry under current policy.

### 9.3 Runtime refusal before a DTO

| Failure | Required safe behavior |
| --- | --- |
| Current admin/approval/reconciliation denial | Fixed AUTH_DENIED/APPROVAL_DENIED family as applicable; no metadata permission from internal recognition |
| Source/hold unavailable or mismatched | Existing fixed source/hold errors; B1 missing requested hold is RECOVERY_EVIDENCE_MISMATCH, not null fallback |
| Unresolved close, transaction settlement, sidecars or unknown pending | RECOVERY_INDETERMINATE; preserve, no partial facts or journal recovery |
| Corrupt/mismatched record or inconsistent completed boundary | RECOVERY_EVIDENCE_MISMATCH |
| Original budget exhausted | RECOVERY_BUSY |
| Complete settled facts with unsupported unexplained state delta and no result | Only the bounded indeterminate classification above, not a fabricated successful phase |

All codes use RECOVERY_ prefix; source-specific existing refusal vocabulary is
preserved and safely mapped, not raw exception disclosure. Status uses B1 observation
only: no sync, repair, hold establishment or completion. Existing validated
coordination SQLite BEGIN IMMEDIATE/ROLLBACK housekeeping is permitted, not a zero
filesystem-write claim; missing lock DB is not initialized by status.

## 10. Publication order, exact retries and ownership

### 10.1 Native publication sequence

1. Authenticate genuine B2 source under durable source scope and original budget;
   capture exact C1 record/source and new B1 closure with current isolation.
2. Under workspace control resolve requestRef/collision. Build owner request and
   immutable stage once, allocate native run once, and publish **locator first**
   with complete witnesses. Never lock a nonexistent run as if it already exists.
3. Create the exclusively owned run/coordination state after locator, then enter
   candidate control while retaining source -> workspace order. Publish exact
   stage/source closure from locator; establish genuine stage hold before copy and
   retain exact local hold cross-check. Local hold file is never source authority.
4. Publish copyIntent; make exclusive independent exact source copy, verify actual
   full5/source hash/protection, sync file/directory and publish base.
5. Independently inspect initial actual facts, validate/publish unchanged C2-A
   nativeIntake with base/hold chronology; publish normalizationIntent before any
   normalization writable open, normalize candidate only and publish completion.
6. Validate complete Entry and publish staged last. This finishes entry, not pause.

### 10.2 Converted publication sequence

1. Separate old stage/conversion is already genuinely complete. Authenticate same
   canonical root/run, original source/closure/hold and current completed conversion;
   derive request selection and exact B1 conversionSelection.
2. Under source -> workspace controls perform unique target5 locator reservation
   for original run, before any new handoff. Retain old request locator unchanged.
3. Establish new phase namespace/owned coordination only after that locator, while
   using original candidate control once. Publish new stage and selection witness;
   cross-check optional local original hold. Never create a replacement native hold.
4. Use C2-A genuine completed-conversion archive/handoff under same controls/budget:
   validate original current completion posthash; durable archive intent, independent
   archive copy/protection/sync/no-replace; handoff. New target5 takes ownership only
   through genuine durable handoff, never selection/intake JSON.
5. Independently inspect initial candidate, validate/publish convertedIntake with
   retained original source/hold and archive evidence; publish staged last. All four
   new native copy/base/normalization files are forbidden on this route.

Keep sticky outer fault frames through all callbacks, unlock/close and final source/
authority checks; expire capabilities before callback-bearing cleanup. Never nest
public source scopes or reset authentic budget. Existing converter must refuse
visible handoff before obsolete current-posthash validation; new owner validates
immutable archive and later replay, not converter's obsolete live posthash.

### 10.3 Immutable facts and phase creation

Sample/generate facts only when a record is genuinely **ABSENT**. A visible valid
record, even after fsync uncertainty, is reused **verbatim** and exact-resynced by
the explicit owning operation. Never resample base.completedAt, intake.acceptedAt,
normalization times, stagedAt, closure.issuedAt, stage time, plan.createdAt, epoch,
actors or reservation. Unknown pending is not absence and is not deleted/adopted.
Missing locator-embedded records can be republished only as original exact bytes
after current source/closure and namespace verification, same original run.

Phase creation order: pausePlan -> pauseIntent -> pauseResult -> preparePlan ->
prepareIntent -> prepareResult -> verifyPlan -> verifyIntent -> verifyResult ->
seal -> activationPlan -> activationIntent -> activationResult. Plans do not mutate
the candidate. Every intent precedes its writable open; central atomic reserved-time
executor, full replay/digest/rowid rules and source/candidate/evidence durability
remain mandatory. Result phaseAt=reservedAt, not publication time. Completion
reconciliation may establish missing result durability, never rerun known commit.

## 11. Proposed filename inventory for these records

These derived record filenames are part of this **pending-review proposal**, not
claims of files already supported by the old conversion inventory. `V` below means
`v5-runs/<runId>/` and is expanded only for presentation; no caller path is accepted.
Protected ownership/coordination/pending-file rules remain central/B1 requirements.

| Record / role | Derived filename | Route / presence |
| --- | --- | --- |
| requestLocator | `v5-requests/<SHA256(UTF8(JSON.stringify(requestRef)))>.json` | Both; first durable request/run reservation |
| stageRequest | Embedded in locator, no extra stage-request file | Both |
| stage | `V/stage.json` | Both; canonical equal locator.stage |
| intake | `V/intake.json` | Both; exact C2-A nativeIntake or convertedIntake |
| staged | `V/staged.json` | Both; last complete entry publication |
| sourceClosedEvidence | `V/source-closed.json` | Native new B1 closure; converted retains old `runs/<runId>/source-closed.json` for nonfresh |
| hold cross-check | `V/hold.json` | Native genuine new hold; converted registered may retain exact optional old-hold cross-check, never authority |
| conversionSelection | `V/conversion-selection.json` | Converted only; canonical equal locator witness |
| copyIntent | `V/copy-intent.json` | Native only |
| base | `V/base.json` | Native only |
| normalizationIntent | `V/normalization-intent.json` | Native only |
| normalizationCompletion | `V/normalization-completion.json` | Native only |
| pausePlan / intent / result | `V/pause-plan.json`, `V/pause-intent.json`, `V/pause-result.json` | Both; intent/result encode central phaseIntent/phaseResult with phase pause |
| preparePlan / intent / result | `V/prepare-plan.json`, `V/prepare-intent.json`, `V/prepare-result.json` | Both; same phase tag rule |
| verifyPlan / intent / result | `V/verify-plan.json`, `V/verify-intent.json`, `V/verify-result.json` | Both; same phase tag rule |
| seal | `v5-runs/<runId>/seals/<sealHash>` | Both; suffixless, exact seal2 |
| activationPlan / intent / result | `V/activation-plan.json`, `V/activation-intent.json`, `V/activation-result.json` | Both; phase activate in intent/result |
| phaseObservation | Transient DTO, no stored observation authority file | Both |

Candidate remains `v5-runs/<runId>/candidate.sqlite` native or original
`runs/<runId>/candidate.sqlite` converted. Converted archive remains
`runs/<runId>/conversion-archive.sqlite`; C2-A archive intent/handoff fields and
publication rules unchanged. Original historical files stay under runs/requests.
No public copy path, DB handle, receipt factory or decoded-record brand is added.

**Remaining physical inventory detail:** exact final archiveIntent/handoff metadata
basenames were not fixed in the supplied accepted C2-A tables; preserve their
contract rather than guess names here. The same-root private mapping of new phase
coordination versus original converted candidate coordination, pending identities
and optional extra new-owner closure request needs final operational inventory
review. These gaps do not relax one acquisition, locator-first ownership or any
forbidden-file rule. No second converted closure file is silently required by Entry.

## 12. Conservative fault matrix and counterexample closures

| State / counterexample | Required outcome |
| --- | --- |
| New request with different fingerprint under same requestRef, or different locator reserving same converted run | Reject conflict; never overwrite locator, mint second run or handoff twice |
| Locator visible but stage/closure missing | Current source/isolation verification then explicit publication of identical embedded witnesses/run; no new timestamps |
| Orphan run/candidate without authentic locator, unknown pending or conflicting witnesses | Preserve/refuse INDETERMINATE or EVIDENCE_MISMATCH as appropriate; no adoption/deletion |
| Native locator omits nativeRecord, or actual same backupId has different canonical record/source | Strict record/binding refusal; matching ID cannot replace durable C1 witness |
| Copy incomplete or bytes not exact source hash | Preserve/refuse; no base/intake success or normalization fallback |
| Complete source-bound copy, base not yet visible | Explicit copy owner must prove exact copyIntent/actual source hash/protection/durability before base; absent record may be first published, unknown pending cannot be treated as absence |
| Intake attempted after normalization using changed current file hash as original | Reject; intake binds original exact-copy facts and precedes normalization |
| Normalization completion absent but bytes/header changed, even logical equality | RECOVERY_INDETERMINATE; no adoption of a guessed completion |
| Completion visible with sync uncertain | Exact validate/resync, retain original hash/time/IDs; visibility is not durability |
| Converted new copy/base/normalization record appears | Route/inventory mismatch; no source re-copy or second normalization workflow |
| Native catalog sourceRef differs from embedded backup ref | Allowed only in stage/closure role; C2-A native intake/source keep embedded backup ref; never overwrite it |
| Converted hold.stageHash replaced by target5 stageHash | EVIDENCE_MISMATCH; original historical stage binding retained forever |
| Pure initialConsistencyProjection presented as genuine observation | No capability; actual initial inspection and current baseline/replay still required |
| Caller requests earlier result while later chain record malformed | Full-chain validation refuses before historical selection |
| Stage retry after prepare compares current bytes to intake initial hash | Wrong protocol; validate current frontier plus immutable history, return retained receipt only if whole current state is valid |
| Observe prepare after verify/activate intent exists | RECOVERY_INVALID selected frontier; historical Result inspection remains separate |
| Existing selected result but changed actual file hash with same logical digest | RECOVERY_EVIDENCE_MISMATCH; cannot erase result or downgrade to initial/null-result retry |
| Activation plan only, no activation intent, candidate differs from seal | Strict prior seal/result boundary refusal; rollback exception not owned yet |
| Same activation intent confirmed rollback changes physical bytes but logical prestate exact | Only same-intent fresh authorized retry; no new seal/plan/initial hash |
| Exact prestate after expiry | RECOVERY_PLAN_STALE, preserve intent/plan; no automatic renew/abandon/replan |
| Exact committed/noop state after expiry, completion missing | Explicit current completion reconciliation may finish; no new mutation approval/actors or COMMIT claim for noop |
| Unreadable/unauthorized/unsettled current facts | Fixed refusal before DTO; no fake hashes/null actual facts or historical-success cover-up |

All exact completion retries revalidate current authority, immutable baseline/replay,
source/hold/closure, file protection and original authentic budget. Sync/no-replace
publication, final identity/authority checks and conservative close handling are
central requirements, not waived by this document's pure graph checks. Released
hold/source-gone/cleanup remain separate terminal gates; no backup deletion here.

## 13. Still pending and document-only validation

This proposal resolves entry/plan field orders, retained native record witness,
route chronology, full-envelope validation, predecessor enum and complete-facts
observation semantics. It does **not** freeze the public eight operations/factory,
terminal activationCompletion/release/status DTOs, independent golden vectors,
native fault evidence or runtime implementation. Entry/Chain role names above do
not invent export names or trusted callback APIs. The exact auth-review adapter
name, public DTO and full runtime signature remain PENDING; §6.4's required
`{runId,preparePlanHash,sealHash,newEpoch,authReviewRef}` subject binding is **not
deferred**. Those interface details and the remaining private coordination/archive
metadata names in §11 must be explicitly settled before consumers implement them.

Current admin/isolation/closure requirements, completion-only reconciliation and
separate release approval remain accepted central/B1 protocols. Plans/intents do
not enable production time ownership, maintenance sessions, writes/listeners,
cleanup or historical converter reauthorization. Unknowns are kept explicit,
not filled with a generic evidence bag, caller path or new authority DTO.

Static validation for this lane checks strict UTF-8/no BOM/final newline, balanced
fences/relative links/whitespace, all eight entry and four expanded plan ordered
tables, nested selections/C1 order, Entry/Chain/projection orders and directed
hash graph acyclicity. Check source and all accepted technical-document hashes
unchanged, and only current C2-B ledger subitem differs. Parent independent review
then decides acceptance; these checks are not tests or runtime validation.

Writes only this new document and current C2-B subitem of the implementation plan.
No code/tests/other docs/config/deps, tests/probes/DB/services/install/commit/push.
Whole C2 stays IN_PROGRESS, runtime NOT READY. Final hashes identify this
pending-review transcription, not operation or durability evidence.
