# C2-A recovery-v5 archive and intake records (NONRELEASE)

**C2 document gate IN PROGRESS. C2-A pure-codec subset accepted within its
bounded scope; C2-B remains PENDING. No recovery runtime writer is ready.**
Checked committed baseline: `e161f37f8a690b9a54310393d04b5c923306fbc1`
(2026-09-28). This document records the accepted C2-A pure-codec subset and
maps it to the committed historical codecs; see the [bounded validation record](im-v2-recovery-v5-intake-validation.md).
It does not provide a recovery runtime seam.
R1, C1 and B2 retain their accepted limited scopes in the
[current ledger](im-v2-implementation-plan.md#52-接下来按依赖推进的-todo).

Read with the [compatibility contract](im-v2-schema-v5-compatibility-contract.md),
[prepare contract](im-v2-recovery-prepare-contract.md),
[conversion contract](im-v2-recovery-conversion-contract.md), and
[maintenance schema-v5 contract](im-v2-maintenance-schema-v5-contract.md).
Their older package-status snapshots do not replace the current ledger. This
subset supplies the four records and two pure binding validators below; it does
not freeze the rest of C2 or claim runtime, provenance or operational readiness.

## 1. Exact future pure module and boundaries

Future `src/im/v2/recovery-v5-intake-records.js` has exactly five exports:

```text
encodeRecoveryV5IntakeRecord(kind, record) -> owned Buffer
decodeRecoveryV5IntakeRecord(kind, bytes) -> detached deeply frozen record
hashRecoveryV5IntakeRecord(kind, record) -> lowercase SHA-256 hex
validateRecoveryV5ArchiveBindings(bundle) -> detached deeply frozen conversionHandoff
validateRecoveryV5IntakeBindings(bundle) -> detached deeply frozen nativeIntake | convertedIntake
```

Kinds are exactly `archiveIntent`, `conversionHandoff`, `nativeIntake`,
`convertedIntake`. All four top-level records have `version:1`. There are no
additional record kinds, generic evidence bags, extension fields, filesystem
operations, database access, clock sampling, random-ID generation, callbacks,
capability registrars or operational factories in this module. A validator
returns the validated detached record, not its input bundle or a success flag.
Syntactically valid JSON, matching hashes and an `actual` DTO prove only pure
consistency; none authenticates the filesystem, source, registry or ownership.

### 1.1 Strict objects, bytes and errors

- At every object boundary, including bundles and historical nested records,
  reject Proxies before any reflection. Require `Object.prototype`, exact own
  enumerable data properties, no accessors, symbols, nonenumerable, missing or
  unknown fields. Arrays, null-prototype objects and exotic objects are not
  ordinary records. Read validated descriptors into detached ordinary data;
  never invoke getters, coercion, `toJSON` or caller iterators.
- Every required nullable field is present and explicitly `null` when absent;
  omission and `undefined` reject. Validation constructs the declared field
  order; valid JavaScript input insertion order does not affect encode/hash.
  Bundle tables declare their normalized traversal order and exact field sets;
  they are not additional serialized record kinds.
- Canonical bytes are ordinary ordered `JSON.stringify` encoded as UTF-8, with
  no BOM, formatting whitespace or trailing newline. The complete record,
  including nested source evidence, is at most **65536 bytes**. No Unicode
  normalization or alternative JSON string/number spelling is introduced.
- Encode returns a fresh Buffer with dedicated backing storage, not an alias
  of input or the small-buffer pool. Decode accepts an ordinary Buffer or
  Uint8Array using the C1 byte-input discipline: Proxy-before-reflection,
  intrinsic byte length/backing checks, nonshared ArrayBuffer, no shadow fields
  or exotic subclasses, a bounded owned copy before decoding. Empty, oversized,
  detached or otherwise invalid byte input refuses.
- Decode uses fatal UTF-8 validation and byte-identical canonical re-encoding.
  Reject duplicates (including escaped key aliases), reordered keys, BOM,
  whitespace, trailing bytes/newline, malformed UTF-8, noncanonical escaping or
  numbers. Encoding can reorder valid JS keys; decoding cannot accept reordered
  byte preimages. Returned data is detached and recursively frozen.
- Encode/hash rejection, including unknown kind, is fixed `RECOVERY_INVALID`.
  Decode and either binding validator reject with fixed
  `RECOVERY_EVIDENCE_MISMATCH`, including failures from embedded legacy codecs.
  The public boundary emits a fresh fixed safe error; it never reads a foreign
  exception's properties, prototype, `code`, `message`, `cause` or thenability.
  Historical modules themselves and their public error semantics are unchanged.
- Strictly snapshot all embedded historical data before passing it to an old
  codec. Some historical helpers lack the new Proxy/enumerability/-0 guards;
  their existence is not permission to pass hostile data through them. Preserve
  their accepted canonical byte algorithms, not their weaker input inspection.

### 1.2 Primitive vocabulary and checksum authority

| Symbol | Exact type / rule |
| --- | --- |
| U | String matching lowercase `^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`, length 36; no coercion or uppercase |
| H | String of exactly 64 lowercase hex characters |
| N | Nonnegative safe integer `0..9007199254740991`, explicitly excluding `-0`; time values are milliseconds |
| Ref | String of 1..255 UTF-16 code units, no C0 (`U+0000..001F`) or DEL (`U+007F`); exact comparison, no normalization |
| K | Exactly `fresh_bootstrap`, `v3_import` or `snapshot_recovery` |
| T? | Required field, either T or explicit null; not optional |
| S? | Original-source version: null, 3 or 4, with paired exact checksum and route rules in §3 |
| V3_CHECKSUM | Existing `V3_CHECKSUM` from `src/im/v2/schema-history.js` |
| V4_CHECKSUM | Existing `V4_CHECKSUM` from `src/im/v2/schema-internal.js` |
| V5_CHECKSUM | Existing `V5_CHECKSUM` from `src/im/v2/schema-v5-internal.js` |

Checksums mean those exact reviewed constants, never any syntactically valid H.
Ref follows P5/C1, including lossless JSON escaping of lone surrogates. Embedded
maintenance records additionally retain their historical well-formed-string
restriction; the new wrapper does not relax a historical codec's requirements.

### 1.3 New hash preimage and historical separation

```text
SHA256(UTF8('a2a-msg.im.v2/recovery-v5/' + kind + '\n') || canonicalRecordBytes)
```

There is exactly one newline separator and no NUL. The kind is one of the four
exact names above. All new record hashes use this preimage; embedded historical
records retain §4's original raw, NUL-domain or newline-domain algorithm. Never
rehash a historical stage, source, owner or conversion plan with the new domain.
File hashes remain SHA-256 of actual file bytes, not of descriptive JSON.

## 2. Four exact ordered field tables

Each row below is one field, in canonical order. Types and route constraints
are exhaustive when read with §3. No other fields are permitted.

### 2.1 archiveIntent

| Field | Type / fixed value |
| --- | --- |
| version | Literal 1 |
| runId | U |
| legacyStageHash | H; old stage canonical hash |
| legacyStagedHash | H; old staged canonical hash |
| candidateReference | Ref; exactly `runs/<runId>/candidate.sqlite` |
| candidateKind | K |
| preparationRef | Ref?; §3 |
| sourceSchemaVersion | S?; §3 |
| sourceSchemaChecksum | H?; exact original-source checksum or null |
| sourceEvidenceHash | H?; historical source hash or null |
| instanceId | U |
| instanceCreatedAt | N |
| centerEpoch | U |
| executionPolicyHash | H; original stage policyHash |
| holdId | U?; §3 |
| ownerHash | H; historical conversion owner hash |
| pauseIntentHash | H; historical conversion pause-intent hash |
| pausedHash | H; historical conversion paused-record hash |
| conversionPlanHash | H; historical maintenance conversion-plan hash |
| conversionProofHash | H; historical maintenance conversion-proof hash |
| conversionCompletionHash | H; historical maintenance conversionComplete hash |
| conversionPosthash | H; completion.postconversionFileHash |
| archiveReference | Ref; exactly `runs/<runId>/conversion-archive.sqlite` |
| createdAt | N |

### 2.2 conversionHandoff

| Field | Type / fixed value |
| --- | --- |
| version | Literal 1 |
| runId | U |
| archiveIntentHash | H; new-domain archiveIntent hash |
| legacyStageHash | H |
| legacyStagedHash | H |
| candidateReference | Ref; exactly `runs/<runId>/candidate.sqlite` |
| instanceId | U |
| instanceCreatedAt | N |
| centerEpoch | U |
| sourceSchemaVersion | S?; original source, never substituted converter input |
| sourceSchemaChecksum | H?; null with null version, otherwise exact V3/V4 checksum |
| targetSchemaVersion | Literal 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| ownerHash | H |
| pauseIntentHash | H |
| pausedHash | H |
| conversionPlanHash | H |
| conversionProofHash | H |
| conversionCompletionHash | H |
| conversionPosthash | H |
| archiveReference | Ref; exactly `runs/<runId>/conversion-archive.sqlite` |
| archiveFileHash | H; must equal conversionPosthash |
| liveInitialHash | H; must equal conversionPosthash |
| handedOffAt | N |

### 2.3 nativeIntake

| Field | Type / fixed value |
| --- | --- |
| version | Literal 1 |
| route | Literal `native-v5` |
| runId | U; internally generated new recovery run in future owner |
| candidateReference | Ref; exactly `v5-runs/<runId>/candidate.sqlite` |
| sourceRef | Ref; exactly embedded sourceEvidence.sourceRef |
| sourceEvidence | Exact nested C1 source2 in §2.5 |
| sourceEvidenceHash | H; raw canonical C1 source hash, no new domain |
| instanceId | U; equal sourceEvidence.instanceId |
| instanceCreatedAt | N; equal sourceEvidence.instanceCreatedAt |
| sourceSchemaVersion | Literal 5 |
| sourceSchemaChecksum | Exact V5_CHECKSUM |
| targetSchemaVersion | Literal 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| candidateInitialHash | H; equal sourceEvidence.fileHash |
| initialEpoch | U; actual snapshot intake epoch |
| previousRecoveryCounter | N; actual snapshot intake counter |
| executionPolicyHash | H |
| holdId | U; required nonnull genuine stage hold in future composition |
| acceptedAt | N |

### 2.4 convertedIntake

| Field | Type / fixed value |
| --- | --- |
| version | Literal 1 |
| route | Literal `converted-v4` |
| runId | U; retain original conversion/recovery run |
| candidateReference | Ref; exactly `runs/<runId>/candidate.sqlite` |
| handoffHash | H; new-domain conversionHandoff hash |
| archiveIntentHash | H; new-domain archiveIntent hash |
| candidateKind | K |
| preparationRef | Ref?; §3 |
| sourceSchemaVersion | S?; §3 original source |
| sourceSchemaChecksum | H?; §3 |
| sourceEvidenceHash | H?; historical source hash or null |
| instanceId | U |
| instanceCreatedAt | N |
| targetSchemaVersion | Literal 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| candidateInitialHash | H; equal handoff.liveInitialHash |
| initialEpoch | U; equal handoff.centerEpoch |
| previousRecoveryCounter | N; fresh/import 0, snapshot actual intake counter |
| executionPolicyHash | H |
| holdId | U?; §3 |
| acceptedAt | N; at least handoff.handedOffAt |

### 2.5 Embedded native source: exact C1 order and types

This is C1 `source`, not a fifth recovery-v5 kind. Its version is 2 even though
the enclosing intake version is 1. Consume the existing
[C1 codec](../src/im/v2/backup-v5-records.js) unchanged.

| Field | Type / fixed value |
| --- | --- |
| version | Literal 2 |
| kind | Literal `registered-backup` |
| sourceRef | Exactly `backup:<backupId>` |
| registryFormat | Literal 4 |
| instanceId | U |
| instanceCreatedAt | N |
| backupId | U |
| fileHash | H |
| manifestHash | H |
| schemaVersion | Literal 5 |
| schemaChecksum | Exact V5_CHECKSUM |
| completedAt | N |
| importedRecordHash | Required literal null |

The full source is encoded in this order within nativeIntake. Its raw C1
canonical bytes hash to `sourceEvidenceHash`. No native timestamp inequalities
are added between creation, completion, acceptance or registration beyond N
types; inherited genuine hold/binding/release checks remain their own contracts.

## 3. Route, source, namespace and epoch rules

| Converted candidateKind / original source | preparationRef | sourceSchemaVersion / checksum | sourceEvidenceHash | holdId |
| --- | --- | --- | --- | --- |
| fresh_bootstrap | Nonnull actual P1 Ref | null / null | null | null |
| v3_import / closed-source | Nonnull actual P1 Ref | 3 / exact V3_CHECKSUM | Nonnull historical closedSourceEvidence hash | null |
| v3_import / registered-backup | Nonnull actual P1 Ref | 3 / exact V3_CHECKSUM | Nonnull historical registeredSourceEvidence hash | Nonnull U |
| snapshot_recovery / registered-backup | null | 4 / exact V4_CHECKSUM | Nonnull historical registeredSourceEvidence hash | Nonnull U |

The pure archiveIntent/convertedIntake shape can admit either v3 hold variant;
the binding validators select the exact variant from the unchanged source kind.
Conversion input is always `(4,V4_CHECKSUM)` and output `(5,V5_CHECKSUM)`.
`sourceSchemaVersion` in the new records describes the **original source**:
fresh null, import 3, snapshot 4. It never becomes 4 merely because P1 produced
the converter's v4 input. Handoff source fields match archiveIntent exactly.

Converted routes keep the original run and candidate in the **same protected
workspace**. Archive reference is exactly the original run's
`runs/<runId>/conversion-archive.sqlite`; new-phase records live under
`v5-runs/<runId>/`, and new request locators under `v5-requests/`. This does not
move, rename, recopy or regenerate the converted candidate/run, and does not
rewrite the original `requests/` locator or historical records. Exact remaining
phase filenames and inventories are C2-B gates, not inferred here.

Fresh/import intake keeps the actual original P1 `initialEpoch`, with
`previousRecoveryCounter:0`. Snapshot intake records the actual current epoch
and recovery counter; later prepare generates a distinct epoch and safely adds
one to the counter. Intake does not preselect that later epoch, increment early,
or fabricate a bootstrap epoch. For all converted routes,
`initialEpoch = handoff.centerEpoch = owner.centerEpoch = legacyStaged.initialEpoch`.

Native5 is solely a genuine registered-v5 snapshot route: a new internally
generated run, candidate under `v5-runs/`, source and target exact5, nonnull hold,
and the original source's sole conversion transition retained. No converter or
second transition runs on native5. Raw closed5 and caller paths are unsupported.
Pure UUID validation cannot prove internal generation; genuine ownership must.

## 4. Historical codec map: exact fields and original algorithms

The checked files have no working-tree differences from the baseline:
[recovery-plan.js](../src/im/v2/recovery-plan.js),
[recovery-records.js](../src/im/v2/recovery-records.js),
[recovery-conversion-records.js](../src/im/v2/recovery-conversion-records.js),
[maintenance-v5-records.js](../src/im/v2/maintenance-v5-records.js), and
[backup-v5-records.js](../src/im/v2/backup-v5-records.js).
The following are ordered **historical** preimages, not new layouts.

```text
legacyStage = recovery-plan stage:
version, requestRef, requestHash, runId, candidateKind, sourceRef,
sourceEvidence, sourceClosedEvidenceRef, sourceClosedEvidenceHash,
isolationAckRef, policyHash, candidateReference, preparationRef, createdAt

legacyStaged = recovery-plan staged:
version, runId, stageHash, candidateBaseHash, preparationRef, instanceId,
instanceCreatedAt, initialEpoch, importEpoch, stagedAt

historical registeredSourceEvidence:
version, kind, sourceRef, registryFormat, instanceId, instanceCreatedAt,
backupId, fileHash, manifestHash, schemaVersion, schemaChecksum,
completedAt, importedRecordHash

historical closedSourceEvidence:
version, kind, sourceRef, instanceId, instanceCreatedAt, schemaVersion,
schemaChecksum, closedSourceFileHash, observedAt, isolationAckRef

owner = recovery-conversion owner:
version, runId, stageHash, stagedHash, candidateReference, instanceId,
instanceCreatedAt, centerEpoch, candidateKind, preparationRef,
sourceEvidenceHash, holdId, intakeFileHash, intakeWriteMode, claimedAt

pauseIntent = recovery-conversion pauseIntent:
version, ownerHash, inputFileHash, originalWriteMode, targetWriteMode, createdAt

paused = recovery-conversion paused:
version, ownerHash, pauseIntentHash, inputFileHash, pausedFileHash, changed, pausedAt

conversionPlan = maintenance conversionPlan:
version, transitionId, instanceId, instanceCreatedAt, centerEpoch, recoveryRunId,
stageHash, candidateReference, candidateKind, preparationRef, sourceEvidenceHash,
fromVersion, fromChecksum, toVersion, toChecksum, preconversionFileHash,
executionPolicyHash, createdAt, expiresAt

conversionProof = maintenance conversionProof:
version, plan, planHash, approvalRef, executorId, approverId, convertedAt

conversionCompletion = maintenance conversionComplete:
version, transitionId, planHash, conversionProofHash, instanceId,
instanceCreatedAt, centerEpoch, recoveryRunId, stageHash, candidateReference,
schemaVersion, schemaChecksum, preconversionFileHash, postconversionFileHash

hold = recovery-records hold:
version, holdId, backupId, recoveryRunId, stageHash, createdAt
```

| Embedded record / hash | Exact existing algorithm |
| --- | --- |
| legacyStageHash, legacyStagedHash | `hashRecoveryRecord('stage'|'staged', record)`; raw canonical SHA-256 |
| Historical sourceEvidenceHash | `hashRecoveryRecord('registeredSourceEvidence'|'closedSourceEvidence', record)`; raw canonical SHA-256 |
| ownerHash | SHA-256 of ASCII `im-recovery-conversion-owner-v1`, one NUL, canonical owner bytes |
| pauseIntentHash | SHA-256 of ASCII `im-recovery-conversion-pause-intent-v1`, one NUL, canonical conversion pauseIntent bytes |
| pausedHash | SHA-256 of ASCII `im-recovery-conversion-paused-v1`, one NUL, canonical conversion paused bytes |
| conversionPlanHash | SHA-256 of UTF-8 `im-center-schema-conversion-plan-v1\n` followed by canonical plan bytes |
| conversionProofHash | SHA-256 of UTF-8 `im-center-schema-conversion-proof-v1\n` followed by canonical proof bytes |
| conversionCompletionHash | SHA-256 of UTF-8 `im-center-schema-conversion-complete-v1\n` followed by canonical conversionComplete bytes |
| hold | `canonical('hold', hold)` from recovery-records; raw canonical bytes, raw SHA-256 if hashing is needed; no new hold-hash field |
| Native sourceEvidenceHash | `hashImV5BackupRecord('source', source)`; raw canonical SHA-256 |

Historical registered source is version 1: registryFormat 2 / schema3 /
exact V3_CHECKSUM with nonnull importedRecordHash, or registryFormat 3 / schema4 /
exact V4_CHECKSUM with importedRecordHash null. Its sourceRef remains
`backup:<backupId>`, even when legacyStage.sourceRef is a different catalog key.
Closed source is version 1, kind `closed-source`, schema3 / exact V3_CHECKSUM;
its sourceRef/isolationAckRef equal the stage's. Both retain every original field.
The full source is not relabeled source2 when its candidate becomes schema5.

All listed historical records have version 1. Hold IDs/backup/run use U,
stageHash H and createdAt N; no invented target/version/prepare fields are added
to hold. The conversion owner fields and chronology remain those of the old
codec/bridge. Conversion completion has **no timestamp**. Conversion proof
retains a full nested plan, distinct Ref executor/approver, Ref approval and
`plan.createdAt <= convertedAt < plan.expiresAt`; plan TTL is positive and at
most 300000 ms with safe arithmetic. Historical v3 staging pause v2 is not the
conversion pauseIntent/paused pair above. No domain or field alias conflates them.

## 5. validateRecoveryV5ArchiveBindings

Exact required bundle field order:

```text
archiveIntent, handoff, legacyStage, legacyStaged, owner, pauseIntent, paused,
conversionPlan, conversionProof, conversionCompletion, hold
```

All fields are exact records of the corresponding §2/§4 kind. Only `hold` is
nullable; it is required even when null. No byte buffers, `{record,recordHash}`
wrappers, optional evidence, registry facade or arbitrary verifier belongs here.
Strictly snapshot, validate and canonicalize every record before crossbinding.
Return only the detached deeply frozen validated `handoff`.

### 5.1 Required equality graph

Let A be archiveIntent, H handoff, S legacyStage, T legacyStaged, O owner,
I pauseIntent, P paused, L conversionPlan, F conversionProof, C completion,
E S.sourceEvidence and D hold. Recompute every named hash with §1.3 or §4.

| Binding group | Exact required comparisons |
| --- | --- |
| Run | A.runId = H.runId = S.runId = T.runId = O.runId = L.recoveryRunId = C.recoveryRunId; nonnull D.recoveryRunId equals that run |
| Historical stage | A.legacyStageHash = H.legacyStageHash = O.stageHash = T.stageHash = L.stageHash = C.stageHash = old hash(S); nonnull D.stageHash equals old hash(S) |
| Historical staged | A.legacyStagedHash = H.legacyStagedHash = O.stagedHash = old hash(T) |
| Candidate reference | A/H/S/O/L/C candidateReference all equal `runs/<runId>/candidate.sqlite` |
| Identity | A/H/T/O/L/C instanceId and instanceCreatedAt all equal; when E is nonnull its identity equals both |
| Epoch | A/H/O/L/C centerEpoch = T.initialEpoch |
| Kind and preparation | A.candidateKind = S.candidateKind = O.candidateKind = L.candidateKind; A/S/T/O/L preparationRef all equal, with §3 route nullability |
| Original source | A.sourceSchemaVersion/checksum = H.sourceSchemaVersion/checksum = E.schemaVersion/checksum when E exists, otherwise both null; exact §3 route/schema dispatch |
| Source evidence hash | A.sourceEvidenceHash = O.sourceEvidenceHash = L.sourceEvidenceHash = old hash(E), or all null for fresh; never source file hash, closure hash or importedRecordHash |
| Policy | A.executionPolicyHash = L.executionPolicyHash = S.policyHash |
| Hold | A.holdId = O.holdId = D.holdId for registered E; D.backupId = E.backupId; fresh/closed E require A/O holdId null and D null |
| Owner | A.ownerHash = H.ownerHash = I.ownerHash = P.ownerHash = historical hash(O) |
| Pause input | I.inputFileHash = P.inputFileHash = O.intakeFileHash; I.originalWriteMode = O.intakeWriteMode; I.targetWriteMode = `paused` |
| Pause chain | A.pauseIntentHash = H.pauseIntentHash = P.pauseIntentHash = historical hash(I); A.pausedHash = H.pausedHash = historical hash(P) |
| Pause outcome | P.changed iff O.intakeWriteMode is `enabled`; changed requires P.pausedFileHash different from O.intakeFileHash, unchanged requires equality; fresh/import intakeWriteMode must be paused |
| Plan input/target | L.fromVersion/checksum = 4/exact V4_CHECKSUM; L.toVersion/checksum = 5/exact V5_CHECKSUM; L.preconversionFileHash = P.pausedFileHash |
| Plan/proof | F.plan is canonical-byte-identical to L; A.conversionPlanHash = H.conversionPlanHash = F.planHash = C.planHash = historical hash(L) |
| Proof/completion | A.conversionProofHash = H.conversionProofHash = C.conversionProofHash = historical hash(F); C.transitionId = L.transitionId |
| Completion schema/prehash | C.schemaVersion/checksum = L.toVersion/checksum = 5/exact V5_CHECKSUM; C.preconversionFileHash = L.preconversionFileHash |
| Completion hash/posthash | A.conversionCompletionHash = H.conversionCompletionHash = historical hash(C); A.conversionPosthash = H.conversionPosthash = C.postconversionFileHash |
| Archive/handoff | A.archiveReference = H.archiveReference = `runs/<runId>/conversion-archive.sqlite`; H.archiveFileHash = H.liveInitialHash = H.conversionPosthash; H.archiveIntentHash = new-domain hash(A) |
| Handoff target | H.targetSchemaVersion/checksum = 5/exact V5_CHECKSUM |

Validate inherited stage requestHash with its original ordered request-input
algorithm and keep source/closure ref/hash/isolation fields intact. Fresh requires
T.candidateBaseHash and T.importEpoch null. For nonfresh,
T.candidateBaseHash equals E.fileHash for registered source or
E.closedSourceFileHash for closed source. V3 import has a nonnull importEpoch
different from initialEpoch; snapshot importEpoch is null. These historical
facts are not overwritten with the converted posthash or a future prepare epoch.

### 5.2 Chronology and limits of this proof

Require T.stagedAt >= S.createdAt. Preserve the bridge's representable chronology:
O.claimedAt >= T.stagedAt, T.instanceCreatedAt, E.completedAt (registered) or
E.observedAt (closed), and D.createdAt when present. Require
I.createdAt >= O.claimedAt; P.pausedAt >= I.createdAt;
L.createdAt >= P.pausedAt and instanceCreatedAt. Retain the historical TTL,
distinct-actor and convertedAt rules in §4. Finally:

```text
H.handedOffAt >= A.createdAt >= F.convertedAt
```

Actual clock-floor, private monotonic/approval, source-closure authorization,
locator, base/normalization, file protection and unreleased/unbound-hold checks
remain mandatory in genuine composition. Those facts are not all in this exact
bundle; the pure validator neither invents missing fields nor certifies them.
A matching D is the actual hold record supplied by the future registry scope,
not proof by itself that a hold is genuine, durable, unreleased or unbound.

## 6. validateRecoveryV5IntakeBindings

Exact required bundle field order:

```text
intake, sourceEvidence, archiveEvidence, actual
```

`intake` is exactly nativeIntake or convertedIntake, selected by its strict route
tag and then validated with that kind's complete field table. No mixed union or
fallback dispatch is allowed. `sourceEvidence` and `archiveEvidence` are required
even when null. `actual` is an exact ordinary-data observation, in this order:

| Field | Type / allowed value |
| --- | --- |
| instanceId | U |
| instanceCreatedAt | N |
| schemaVersion | Literal 5 |
| schemaChecksum | Exact V5_CHECKSUM |
| centerEpoch | U |
| recoveryCounter | N |
| fileHash | H |
| writeMode | Exactly `paused` or `enabled` |

For both routes, require actual.instanceId/instanceCreatedAt equal intake's,
actual.schemaVersion/schemaChecksum equal intake.targetSchemaVersion/checksum,
actual.centerEpoch = intake.initialEpoch,
actual.recoveryCounter = intake.previousRecoveryCounter and
actual.fileHash = intake.candidateInitialHash. Return only the detached deeply
frozen intake. These are initial-admission bindings; after a legitimate later
mutation, future phase validation must use its own completed chain rather than
requiring the obsolete initial file hash.

### 6.1 Native branch

`archiveEvidence` is null. `sourceEvidence` is exact C1 source2 and canonical-byte
identical to intake.sourceEvidence. Recompute its **raw** C1 canonical hash and
match intake.sourceEvidenceHash; sourceRef, identity, exact schema5/checksum and
source.fileHash match §2.3. `holdId` is nonnull U. actual.writeMode may be paused
or enabled because this is snapshot intake, not prepared recovery. No extra
timestamp inequality is introduced. The JSON bundle does not prove the hold or
mint B2 provenance, a copy capability, conversion or maintenance authority.

### 6.2 Converted branch

`archiveEvidence` is the full exact §5 archive bundle; validate it first. Let H
and A be its validated handoff and intent. Require:

- intake.handoffHash = new-domain hash(H), and intake.archiveIntentHash =
  H.archiveIntentHash = new-domain hash(A).
- intake runId, candidateReference, instanceId, instanceCreatedAt and source
  schema version/checksum equal both H and A; target fields equal H's exact5.
- intake candidateKind, preparationRef, sourceEvidenceHash, executionPolicyHash
  and holdId equal A's, including explicit nulls and registered/closed distinction.
- intake.candidateInitialHash = H.liveInitialHash; intake.initialEpoch =
  H.centerEpoch; intake.acceptedAt >= H.handedOffAt.
- sourceEvidence is null exactly for fresh; otherwise it is the **unchanged
  historical source** canonical-byte-identical to archiveEvidence.legacyStage's
  sourceEvidence, validated with its old kind/algorithm. No source2 translation.
- Fresh/import previousRecoveryCounter is 0 and epoch is the original P1
  initialEpoch bound through legacyStaged; snapshot retains actual intake
  counter/epoch. actual.writeMode is required `paused` for every converted route.

Native source2 cannot be substituted into a converted archive, even if identity
and file hashes look plausible. A converted candidate's initial file hash is the
handoff live/postconversion hash, not the original backup/base/paused hash.

## 7. Required rejection and independent-literal matrix

All rejection rows use `RECOVERY_INVALID` for encode/hash and
`RECOVERY_EVIDENCE_MISMATCH` for decode/binding, as applicable. Future tests must
cover these finite cases, with no authority inference from a passing codec.

| Dimension | Required accepted case | Required rejection |
| --- | --- | --- |
| Four-kind surface | Exactly the five exports and four kinds in §1 | Unknown kind, extra export/record option, cross-kind object, wrong version |
| Native route/schema | source2/registry4/schema5 and source=target exact5 | source1/registry2 or 3, source3/4, source2 relabeled schema4, wrong checksum, target4, missing or nonnull archiveEvidence |
| Converted fresh | Null source schema/checksum/evidence/hold, nonnull prep, counter0 | Fake schema4 source, source/hold fabrication, missing prep, nonzero counter |
| Converted v3 | Historical closed3 or registered3, exact V3 checksum, nonnull prep/hash, counter0 | Source4/5, C1 source2 replacement, closed hold nonnull, registered hold null, missing prep/hash, nonzero counter |
| Converted snapshot | Historical registered4, exact V4 checksum, prep null, hold/hash nonnull, actual counter/epoch | Closed4/5, source3/5, prep nonnull, missing hold, counter/epoch mismatch |
| Native/converted tag | Tag chooses its exact field set | A native record labeled converted or vice versa; merged fields, permissive fallback |
| Derived refs | Native candidate `v5-runs/`; converted candidate and archive `runs/`; source `backup:<backupId>` | Cross-run ref, wrong namespace, arbitrary/absolute path, alternate separators, archive equal candidate, sourceRef mismatch |
| Hash families | New recovery newline prefix; historical raw/NUL/newline retained | Raw new-record hash, NUL new separator, wrong kind/domain, new-domain historical hashes, file hash used as record hash |
| Whole archive chain | All §5 comparisons and actors/chronology | Any single run/stage/staged/identity/epoch/kind/prep/source/policy/hold/hash mismatch, unequal nested plan, wrong 4-to-5 checksums, wrong transition/prehash/posthash |
| Pause outcome | Original paused unchanged; original enabled changed hash | changed flag/mode mismatch, unchanged with unequal hashes, changed with equal hashes |
| Handoff | archiveFileHash = liveInitialHash = conversionPosthash | Any unequal one; handoff intent hash mismatch; time before intent or conversion |
| Actual intake | All §6 actual fields agree; native mode paused/enabled, converted paused | Any schema/checksum/identity/birth/epoch/counter/file hash mismatch; converted enabled; unknown mode |
| Native time | Independently valid N values without new inequalities | Unsafe/fractional/negative/-0 values; tests must not invent native acceptance-versus-completion ordering |
| Converted time | acceptedAt >= handedOffAt >= intent.createdAt >= convertedAt | Any reversed required inequality; inherited plan TTL/actor failure |
| Nullable fields | Every required null explicitly present | Missing, undefined, wrong null variant, unknown nested or top field |
| Strict data | Ordinary own enumerable data, detached frozen output | Proxy/revoked Proxy before traps, getter/setter, symbols, hidden field, exotic prototype, hostile thrown value; no foreign error-property reads |
| Canonical bytes | Exact order, fatal valid UTF-8, <=65536 bytes | Duplicates/escaped aliases, reordered bytes, malformed UTF-8, BOM, whitespace/newline/trailing text, alternate escapes/numbers, 65537 bytes |
| Ownership of output | Fresh owned Buffer; recursively detached/frozen DTO | Input mutation changing output, nested alias retention, pooled/shared backing or mutable returned subtree |

After parent review of C2-A, assign separate parallel **codec implementation**
and **independent fixture-author** lanes with disjoint write sets. Fixture
authors must supply independently authored literal canonical bytes and literal
SHA-256 values for every kind and all native/fresh/closed3/registered3/snapshot4
route variants, plus mixed-family rejection and historical golden regressions.
Use the checked algorithms and constants; expected values cannot be produced
solely by the implementation under test. Boundary and hostile-object tests must
exercise the real public codec/validators. **This document fabricates no golden
hashes and reports no implementation or test PASS.**

## 8. Future H4 protected handoff architecture (not implemented by C2-A)

The future private seam is:

```text
withCompletedConversionHandoff(genuineRecoveryServices, {runId}, ctx,
  inheritedAuthenticBudget, consume)
```

It authenticates the genuine existing recovery facade/private ownership, resolves
the original run, and acquires **source -> workspace -> candidate exactly once**.
Carry the same authentic inherited budget through lookup, full validation,
hash/copy, callbacks, publication and final checks; no resetting or raising caps,
no nested public source lock. Fresh has no fake source lock; closed3 retains its
genuine source/isolation scope. Current admin/source authority, scope lifetime,
reentry/async/caught-fault poison and final checks remain mandatory.

Within those controls, verify the completed original conversion and actual live
completion posthash, exact full schema5/identity/epoch/proof, original locator,
intake chain and actual unbound/unreleased hold. Publish/resync immutable
archiveIntent before archive publication. Create an **independent byte copy**,
never a hardlink from the live candidate: original completion posthash must equal
the archive bytes and live initial bytes. Validate full exact5, identity and
inode separation, protected single-link standalone files, no sidecars, stable
pre/posthash, file/directory sync and no-replace publication. Do not sync the held
coordination inode through a raw descriptor. A no-replace publication link for
an owned pending archive is not permission to share the live candidate inode.

Publish/resync the exact handoff only after archive and live initial durability
are established; then privately brand the new target5 receipt for `consume`.
JSON return values never mint that receipt. No DB handle, raw path, arbitrary
verifier or generic mutation callback is exposed. Its operational callback/result
DTOs and remaining exact inventories still require C2-B/H4 review.

### 8.1 Transfer exclusion and interruption constraints

- Converter entry checks transfer evidence **before** obsolete current-posthash
  validation. A visible handoff excludes converter operations even when its
  publication durability is uncertain. Only an explicit handoff retry may
  validate/resync that boundary; converter retry cannot reacquire the candidate.
- Durable handoff transfers mutable candidate ownership; future recovery checks
  archived conversion evidence plus its later phase chain. Original completion
  and archive stay immutable when live candidate bytes legitimately change.
  Old target4 facade exclusion remains permanent from conversion ownership.
- An unknown pending file is preserved as indeterminate, even if its apparent
  bytes match. No generic cleanup/adoption, overwrite or recopy protocol exists.
- Final archive without handoff permits only the explicit exact retry: validate
  immutable intent, complete original chain, actual archive/live hashes and
  protection/inode separation; resync required files/directories; publish the
  same handoff. Conflicting or unexplained state refuses and retains evidence.
- A visible handoff with uncertain durability requires exact handoff retry and
  resync before successful receipt issuance. Observation alone never repairs it.
- **Before the first clock-floor or prepare mutation**, a durable prepare intent
  is required. Its exact later record/plan/result layouts and clock-only versus
  committed projections are **not yet frozen**. Later records cannot be guessed
  from these four intake kinds; unknown byte changes require reconciliation.

## 9. Future read-only registry observation and release boundaries

Future status needs a **new genuine read-only registry observation seam**:

```text
withRecoverySourceObservation(registry, {backupId,holdId}, ctx,
  inheritedBudget, consume)
```

Authenticate the real registry privately. Perform full version-aware chain,
actual-source and hold validation under the original authentic shared budget,
with protected scope pre/postchecks and lifetime/poison checks. This observation
has **no resync, copy or establish capability** and makes no durable publication,
hold/binding creation or repair. Its detached frozen observation is neither a
durable B2 proof nor terminal/release authority. Exact observation DTOs remain
with the C2-B status/API tables. This seam is **not implemented by C2-A**.

Existing B2 durable-proof scopes continue their native5 artifact/manifest/source/
record resync requirements. Do not weaken them into read-only proofs or use them
to satisfy zero-write status. Existing old target4 admission/release guards
continue denying native5. Future target5 release requires the new-family actual
terminal composition and `minReleasedAt`, including genuine version-aware source,
hold, binding, terminal chain and approval checks; matching pure JSON is not a
release authorizer. Missing backup after release remains unsupported, pending
the separate future P6 decision. Cleanup remains nonexecutable.

## 10. C2-B NOT READY tables and downstream gates

C2-A is a finite schema subset, not the complete C2 contract. The following
remaining tables must be frozen and reviewed before S3/H4 runtime source work:

| C2-B table / artifact | Exact remaining responsibility |
| --- | --- |
| Request/stage/locator/staged/results | Complete ordered fields, versions/types/nulls, request identity, native-versus-converted stage/intake/hash relationship, new locator binding to retained old run |
| Source catalog | Genuine source capability union and old-target selection, original workspace ownership, registered3/4/5 dispatch, raw closed5 refusal |
| Executor and conversion approval orchestration | Trusted executor resolution and distinct-approver binding, explicit opt-in conversion, factory/operation ownership and authentic budgets |
| Source closure | Exact source3/4/5 closure binding/proof unions and authorization, source catalog ref versus embedded backup ref, immutable original evidence |
| Copy/base/normalization and digest grammar | Exact records and phase projections, complete explicit 3/4/5 table/column/type/row framing and ordering, all v5 history/head/transition metadata; historical 3/4 algorithms unchanged |
| Prepare plan/intent/result | Full ordered records, approvals/expiry, intent before first write, exact clock-only and committed projections, interruption/retry binding |
| Seal2 | Complete new seal version2 table, explicit schema5/checksum, phase hash/preimage and verification binding; no old seal reuse |
| Activation plan/completion | Exact fields, source/target/epoch/hash/approval/chronology, transaction and completed retry proofs |
| Release/status/results | New-family actual terminal composition and minReleasedAt, read-only observation DTOs, release markers/guards and exact nullable result/status tables |
| Eight-operation DTOs | Exact factory/options plus all inputs/results for stageCandidate, previewRecovery, prepareRecovery, getRecoveryStatus, verifyRecovery, previewActivation, activateRecovery, releaseRecoveryHold |
| Phase inventories/crash classifications | Every required/forbidden file and derived reference, pending ownership, durability/transfer/clock/prepare/seal/activation/release windows and conservative exact-retry versus indeterminate cases |
| Independent literals | Remaining kinds/route unions and independently reviewed bytes/hash vectors, cross-route rejection, historical regression |

Direction remains a separate target5-only `createImV5RecoveryServices` factory
with the same eight operation names, not new loose evidence bags or extensions
to old target4 APIs. Exact options/DTOs await the above tables. Raw closed5 stays
unsupported. No global schema substitution or implicit conversion is permitted.

For snapshot prepare, atomically establish the new epoch/counter/run/center/
progress, revoke leases, keep paused mode and **DELETE HEAD ONLY**. Preserve all
anchor history, generations, original sole conversion transition, business
history and clock floor; perform full v5 validation before commit. Fresh/import
uses original P1 initialEpoch/counter0, with no fake extra epoch. No inherited
private time session or new operational-time opener follows from this work.

Dependency order is **R1/C1 completed -> B2 completed -> C2-A subset review ->
C2-B remaining document gate -> S3 -> H4 -> Q5 -> separate operational
ownership/time -> B1 -> P6 fault -> P7 / H1-H3**. C2-A codec/fixture work, when
separately authorized after review, is pure subset work, not permission to skip
C2-B or start a runtime writer. Q5 roundtrips and all later evidence remain
future work; no v5 recovery operational-readiness statement is earned here.

## 11. Document-only verification and handoff

This lane writes only this new document and the current C2 TODO subitem in
`docs/im-v2-implementation-plan.md`. Verify strict UTF-8 without BOM, final
newline, balanced fences, existing relative link targets, whitespace, four
field-table orders/types and preservation of the historical TODO order. Report
the final document hashes to the parent; they identify this document handoff,
not executable-source or runtime-test evidence.

No source/tests, database, services/config, production migration, restore,
cleanup, listener, commit or push is part of this handoff. Defaults remain
disabled/paused, expiry/purge/backup cleanup OFF; 90/7/180-day policy and null /
unconfirmed backup TTL remain unchanged. Parent review of this C2-A subset is
the next gate; C2-B's explicit outstanding tables are not concealed as completion.
