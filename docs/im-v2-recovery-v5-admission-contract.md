# C2-B1 recovery-v5 admission proposal (NONRELEASE)

**C2-B1: ACCEPTED PREREQUISITE DOCUMENT SUBSET after independent review
(2026-09-28); not codec implementation or runtime evidence. Whole C2:
IN_PROGRESS. S3 and H4: NOT READY. Q5: blocked / NOT RUN.**

Checked HEAD: `cf7c90f6aa36cf07f6829738a809b7e91ccd4c32` (2026-09-28).
This is document-only transcription and local consistency checking against the
actual historical APIs. Independent review closed three findings: the new
wrapper/observer is active only in its new scope while the old codec stays
unchanged; exact hold selection includes explicit null semantics; coordination
locking is distinct from evidence writes. No implementation was validated.
The [C2-A archive/intake contract](im-v2-recovery-v5-intake-contract.md) remains
accepted within its pure-codec scope and technically unchanged. Neither the full
target5 facade nor terminal tables are frozen by this proposal.

Read with the [current ledger](im-v2-implementation-plan.md#52-接下来按依赖推进的-todo),
[compatibility contract](im-v2-schema-v5-compatibility-contract.md),
[prepare contract](im-v2-recovery-prepare-contract.md),
[conversion contract](im-v2-recovery-conversion-contract.md), and
[storage contract](im-v2-recovery-storage-contract.md). Older package-status
snapshots in those documents are historical; the current ledger governs status.
Source line citations below were checked at the HEAD above, with no local changes
to the cited `src/im/v2/` files. No new codec or runtime seam is implemented here.

## 1. Admission routes and explicit precompleted-conversion prerequisite

The converted route is an explicit sequence of separately authorized operations:

```text
old stage: fresh4 / completed import3to4 / registered4 snapshot
  -> genuine createRecoveryConversionTarget(oldServices, {runId}, ctx)
  -> converter previewConversion({}, ctx)
  -> independent approval
  -> converter convertCandidate({transitionId,planHash,approvalRef}, ctx) complete
  -> new catalog selects that genuine completed run
  -> future target5 stageCandidate performs the protected C2-A archive/handoff
```

The genuine old stage, including P1 initialization/import, is a **precondition**,
not part of the new stage operation. `stageCandidate` never silently runs a
conversion, grants conversion approval, repairs missing conversion completion or
resolves a replacement historical conversion approver. Converter executor identity
comes from authenticated trusted composition, never an operation-supplied actor
reference. Existing converter construction still explicitly receives `executorId`;
its `resolveApproval`, distinct actors and completed-retry rules stay unchanged.
New target5 admission verifies the historical conversion chain; it does not
reauthorize that historical conversion as a new mutation.

Actual APIs: [recovery.js](../src/im/v2/recovery.js) lines 104-137 construct the
converter with exact `{target,authority,approvalAuthority,executorId,limits}` and
expose `previewConversion` / `convertCandidate`; lines 158-179 authenticate target
mint/scope, 698-719 publish preview, 720-759 resolve/authorize conversion approval
or use retained committed actors, and 760-775 sync/publish completion. Preview is
a write operation. There is no historical `converter.complete()` method: “complete”
above means successful `convertCandidate` plus genuine current completion evidence.

| Route | Run / live candidate | Archive / phase namespace |
| --- | --- | --- |
| Converted fresh, closed3/registered3 import, registered4 snapshot | Retain original run and `runs/<runId>/candidate.sqlite` in the **same protected canonical workspace** | C2-A independent `runs/<runId>/conversion-archive.sqlite`; new phase records `v5-runs/<runId>/`; new request locators `v5-requests/` |
| Native registered5 snapshot | Internally generated independent new run, `v5-runs/<runId>/candidate.sqlite` | No converter and no conversion archive; new phase/locator namespaces above |

Do not move or recopy the converted live candidate, regenerate its run, rewrite
the original `requests/` locator, or treat an equal-looking root string as private
same-workspace ownership. Native5 retains its sole original conversion transition;
there is no second conversion. Fresh/import retain P1's actual initial epoch and
counter0; snapshot retains actual intake epoch/counter until its later approved
prepare transition. C2-A route/epoch tables remain authoritative.

For converted registered sources, **original `hold.stageHash` remains the historical
stage hash forever**. The new target5 stage hash is a different new-family hash.
A future target5 prepare-plan hash may be stored in a prepare binding whose
`stageHash` is still that historical hold stage. Never replace the hold's stage
hash with selection, intake, handoff or target5-stage hash. Native5's genuine new
hold instead binds its own new stage. Actual unchanged binding construction copies
`hold.stageHash` internally: [backup-registry.js](../src/im/v2/backup-registry.js)
lines 315-344. Exact new-stage/hash relationships still require the remaining C2
phase package; this decision supplies no new stage field table.

## 2. Proposed trusted source catalog

Construction accepts an ordinary own-data map keyed by P5 Ref. Each value is
exactly one of these unions, with the displayed field order:

```text
{kind:'registered-backup', registry:genuineB2Facade, backupId:UUID}
{kind:'completed-conversion', recoveryServices:genuineOldFacade, runId:UUID}
```

These are trusted-construction capability entries, not serialized operation DTOs.
Snapshot keys/descriptors strictly; reject Proxy before reflection, accessors,
symbols, hidden/unknown/missing fields, null-prototype/exotic maps and lookalike,
copied or proxied facades. UUID is U in §4. Private brand validation, not presence
of similarly named methods, proves genuine construction.

| Catalog branch | Actual admission requirement | Refusal / retained boundary |
| --- | --- | --- |
| registered-backup | Only actual record4 / `native-v5`, source2 / registry4, manifest3, exact schema5/checksum, full B2 artifact/content binding | Direct registered3 or registered4 is `RECOVERY_UNSUPPORTED`; perform the explicit old-stage/conversion route first |
| completed-conversion | Genuine old facade, same canonical protected workspace/run, current completed conversion, matching execution policy, original source/closure/hold validation privately | No old prepare plan, recovery row for **this run**, authoritative prepare binding or release at initial admission; complete phase allowlists remain a later gate |

There is no direct fresh, closed3, raw source, raw closed5, caller-proof or caller-path
entry. Fresh and v3 are supported through the completed-conversion branch. A
historical snapshot's old active run is not this new recovery run; P1's preparation
is not an old recovery prepare for this run. The selected catalog key
`selectionRef` is distinct from `originalSourceRef`; equality is neither required
nor authority. Resolve the original catalog source/isolation and hold internally
through the genuine old facade. Decoded selection/intake JSON never becomes a
brand, conversion-completion capability or source-copy capability.

Actual baseline: [recovery.js](../src/im/v2/recovery.js) lines 21, 1174-1177 own
the facade WeakMap; 426-507 validate retained conversion bindings and forbid old
plan/current-run/binding/release. Its current private registration retains only
`mint`, not a public root extractor or completed-handoff API. The old
[recovery-source.js](../src/im/v2/recovery-source.js) lines 73-87 catalog accepts
registered backups or `closed-v3`, not the new union; lines 106-132 preserve old
target4 native5 refusal. Those APIs are not relabeled target5 entry points.

## 3. Proposed trusted authority protocol for future mutations

```text
authority.authorizeAdmin(ctx) -> literal true
authority.resolveExecutor(ctx) -> exact {executorId}
approvalAuthority.resolveApproval(binding, ctx) -> exact {approverId}
approvalAuthority.authorizeApproval(resolvedBinding, ctx) -> literal true
```

`binding` has exactly this order. `resolvedBinding` has the identical prefix plus
`approverId` as its final field. These are adapter bindings, not extra record kinds.

| Field | Type / requirement |
| --- | --- |
| kind | `prepare-v5`, `activate-v5` or `release-hold-v5` |
| runId | U |
| planHash | H; actual appropriate persisted plan |
| approvalRef | R |
| instanceId | U |
| instanceCreatedAt | N |
| sourceSchemaVersion | Required null, 3, 4 or 5, correlated to route |
| sourceSchemaChecksum | Required null iff source version null; otherwise its exact checksum |
| targetSchemaVersion | Literal 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| executorId | R |

Fresh converted source is null/null, imported source 3/V3, converted snapshot
4/V4, native snapshot 5/V5. Source fields never become 4 simply because P1 made
the converter's schema4 input. `approverId` is R and differs from `executorId`.

Capture primitive actor strings once when creating a new durable mutation intent;
use that exact pair and approval reference at subsequent authorization checks.
Retries use the persisted pair, never identity replacement. Current admin,
source isolation and closure authorization remain necessary on retries. New
mutations require their current exact approval binding; exact completed retries
must be distinguished by future phase contracts, not invented from this table.

All adapters/results are synchronous ordinary own-data with strict fields and
Proxy/accessor/symbol rejection; no Promise, thenable or truthy non-true authority
result is accepted. Known async/generator adapters reject before their prefix;
unexpected asynchronous results refuse and cannot extend scope lifetime. Capture
before callback mutation, latch faults/reentry before classification, sanitize
errors and recheck final authority. The identity persistence fields and exact
operation DTOs are **NOT YET FROZEN**; these protocols do not make operations ready.

Historical contrast: [recovery-source.js](../src/im/v2/recovery-source.js) lines
19-28 provide the old adapter; [recovery.js](../src/im/v2/recovery.js) lines 46-85
and 729-743 implement converter-specific strict resolution and authorization.
The converter uses `candidate-schema-conversion` with `centerEpoch`; do not change
its binding to this proposed source/target-schema protocol.

## 4. Proposed pure module, primitives, bytes and hashes

Proposed `src/im/v2/recovery-v5-admission-records.js` exports exactly:

```text
encodeRecoveryV5AdmissionRecord(kind, record) -> owned Buffer
decodeRecoveryV5AdmissionRecord(kind, bytes) -> detached deeply frozen record
hashRecoveryV5AdmissionRecord(kind, record) -> lowercase SHA-256 hex
validateRecoveryV5ClosureBindings(bundle) -> detached deeply frozen closureProof
validateRecoveryV5ConversionSelection(bundle) -> detached deeply frozen conversionSelection
```

Exactly four kinds: `closureBinding`, `closureProof`, `conversionSelection`,
`sourceObservation`. No I/O, DB access, callback, factory, timestamp/ID generation,
capability registrar or authority follows from this pure module.

Reuse C2-A §1.1 **exactly**, including recursive historical-object firewall:
ordinary `Object.prototype`, exact enumerable own data descriptors; Proxy rejection
before reflection; no symbols/accessors/hidden fields/arrays/exotic objects, getter,
coercion, `toJSON` or caller iterator execution. Every nullable field is required:
explicit null, never omission or undefined. Build canonical declared order from
valid JS objects regardless of insertion order. Historical nested data is detached
and strictly inspected before any old helper sees it.

Canonical bytes are ordered `JSON.stringify` UTF-8 without BOM, whitespace or
trailing newline, **65536 bytes maximum including nested records**. Encode returns
dedicated owned Buffer storage. Decode accepts only ordinary Buffer/Uint8Array
with C2-A intrinsic byte/backing checks, no shared backing/shadow fields/subclasses,
bounded owned copy and fatal UTF-8. Reject detached/empty/oversize input, duplicate
or escaped-alias keys, reordered byte preimages, BOM, whitespace, alternate escaping
or number spelling and trailing bytes. Byte-identical canonical re-encoding is
required. Output is detached and deeply frozen. Document files have final newlines;
serialized record bytes do not.

Encode/hash failures use fixed `RECOVERY_INVALID`; decode and either pure validator
use fixed `RECOVERY_EVIDENCE_MISMATCH`, including historical-helper failures. Emit
a fresh safe error without reading foreign thrown properties/prototype/code/message/
cause/thenability. Historical public codecs and their error behavior remain unchanged.
Actual C2-A firewall/primitive implementation is in
[recovery-v5-intake-records.js](../src/im/v2/recovery-v5-intake-records.js) lines
15-90 and 261-274; C1 byte/decode discipline is in
[backup-v5-records.js](../src/im/v2/backup-v5-records.js) lines 98-144.

| Symbol | Exact rule |
| --- | --- |
| U | Lowercase UUID string, length36, `^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$` |
| H | Exactly 64 lowercase hexadecimal characters |
| N | Nonnegative safe integer through 9007199254740991, explicitly no `-0`; timestamps are milliseconds |
| R / P5Ref | 1..255 UTF-16 code units, no C0 or DEL; no normalization; lossless JSON lone-surrogate escaping retained |
| T? | Required T or explicit null, never optional |
| V3_CHECKSUM | Exact `V3_CHECKSUM` from `schema-history.js` |
| V4_CHECKSUM | Exact `V4_CHECKSUM` from `schema-internal.js` |
| V5_CHECKSUM | Exact `V5_CHECKSUM` from `schema-v5-internal.js` |

```text
SHA256(UTF8('a2a-msg.im.v2/recovery-v5/' + kind + '\n') || canonicalRecordBytes)
```

Use one newline, no NUL. The four new kind names above select the domain. Historical
nested hashes stay unchanged: `hashRecoveryRecord` is raw canonical SHA-256
([recovery-plan.js](../src/im/v2/recovery-plan.js) lines 115-132); C1 source/record
hashes are raw ([backup-v5-records.js](../src/im/v2/backup-v5-records.js) lines
143-144). Registry `canonical` bytes retain raw hashes. Conversion owner/pause
hashes retain their ASCII domain plus NUL
([recovery-conversion-records.js](../src/im/v2/recovery-conversion-records.js)
lines 46-49, 115-119); maintenance conversion plan/proof/completion retain their
original newline domains ([maintenance-v5-records.js](../src/im/v2/maintenance-v5-records.js)
lines 12-21, 224-225). File hashes are hashes of file bytes. No historical proof
is rehashed under the new domain or relabeled as a new proof.

## 5. Exact proposed closure records and validator

### 5.1 closureBinding ordered fields

| Field | Type / fixed value |
| --- | --- |
| version | Literal 1 |
| sourceRef | R; closure's catalog/source reference |
| isolationAckRef | R |
| sourceKind | `registered-backup` or `closed-source` |
| instanceId | U |
| instanceCreatedAt | N |
| sourceSchemaVersion | 3, 4 or 5; route-correlated |
| sourceSchemaChecksum | Exact checksum for source version |
| sourceFileHash | H |
| backupId | U?; registered nonnull, closed null |
| manifestHash | H?; registered nonnull, closed null |
| sourceEvidenceHash | H; original raw source-evidence hash |
| targetSchemaVersion | Literal 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |

### 5.2 closureProof ordered fields

| Field | Type / fixed value |
| --- | --- |
| version | Literal 1 |
| evidenceRef | R |
| sourceRef | R |
| isolationAckRef | R |
| sourceKind | `registered-backup` or `closed-source` |
| instanceId | U |
| instanceCreatedAt | N |
| sourceSchemaVersion | 3, 4 or 5; route-correlated |
| sourceSchemaChecksum | Exact checksum for source version |
| sourceFileHash | H |
| backupId | U?; registered nonnull, closed null |
| manifestHash | H?; registered nonnull, closed null |
| sourceEvidenceHash | H; original raw source-evidence hash |
| targetSchemaVersion | Literal 5 |
| targetSchemaChecksum | Exact V5_CHECKSUM |
| issuedAt | N |

### 5.3 Source dispatch, equality graph and authority

| Source | Exact evidence | Binding file/backup facts |
| --- | --- | --- |
| closed-source | Historical version1 closedSourceEvidence; schema3/exact V3 only | `sourceFileHash = closedSourceFileHash`; backupId/manifestHash both null |
| registered3 | Historical source1, registry2, schema3/exact V3, importedRecordHash H | fileHash/backupId/manifestHash from unchanged evidence |
| registered4 | Historical source1, registry3, schema4/exact V4, importedRecordHash null | Same registered facts |
| registered5 | C1 source2, registry4, schema5/exact V5, importedRecordHash null | Same registered facts |

Exact validator bundle order: `binding, proof, sourceEvidence`. All three fields
are required nonnull records. Validate strict shapes first; every binding field,
including version and target facts, equals proof. Compare sourceKind, identity,
birth, exact source schema/checksum, actual evidence file hash, backupId and
manifestHash with the selected source family. Recompute `sourceEvidenceHash` using
the historical registered/closed raw codec or C1 raw `source` codec as appropriate.
It is not a file hash, manifest hash, imported-record hash or closure-proof hash.

For registered evidence, closure `sourceRef` is the catalog key and may differ
from embedded `backup:<backupId>`; `isolationAckRef` is independently bound, not
derived from that embedded ref (which has no isolation field). For closed evidence,
both `sourceRef` and `isolationAckRef` MUST equal the historical evidence fields.
Return only a detached deeply frozen proof, without authority or a success flag.
No extra issuedAt/creation inequality is invented beyond N and inherited contracts.

Future trusted calls are exactly:

```text
evidenceAuthority.getRecoveryV5SourceClosedEvidence(binding, ctx) -> proof
evidenceAuthority.authorizeRecoveryV5SourceClosedEvidence(proof, ctx) -> literal true
evidenceAuthority.assertSourceIsolation(sourceRef, isolationAckRef, ctx) -> literal true
```

The source owner derives binding from genuinely verified facts; pure validation
cannot authenticate those observations. Strict synchronous adapter rules in §3
apply. Converted original closure remains the old full `closureProof`, old raw hash
and original `authorizeSourceClosedEvidence` authorization; never relabel or replace
it. A new target5 attestation is optional only on an explicit new-owner request,
and supplements rather than overwrites the old proof. Its request/phase DTO remains
unfrozen. Native5 needs its genuine new-source closure protocol.

Historical comparison: [recovery-plan.js](../src/im/v2/recovery-plan.js) lines
26-28, 65-68 define old `schemaVersion/schemaChecksum/fileHash` closure fields,
without new sourceEvidenceHash/target fields (old binding also has no version).
Lines 144-147 and 157-165 bind old proof/source/stage. Actual old generation and
reauthorization: [recovery-source.js](../src/im/v2/recovery-source.js) lines 57-71,
99-104. New fields must not be passed through those old closure codecs as if equal.

## 6. Exact proposed conversion selection and validator

### 6.1 conversionSelection ordered fields

| Field | Type / fixed value |
| --- | --- |
| version | Literal 1 |
| selectionRef | R; new catalog key, not necessarily originalSourceRef |
| runId | U; original run |
| legacyStageHash | H; historical raw stage hash |
| legacyStagedHash | H; historical raw staged hash |
| candidateKind | `fresh_bootstrap`, `v3_import` or `snapshot_recovery` |
| candidateReference | Exactly `runs/<runId>/candidate.sqlite` |
| instanceId | U |
| instanceCreatedAt | N |
| initialEpoch | U; original staged initialEpoch |
| preparationRef | R?; route table below |
| originalSourceRef | R?; original stage catalog/source key |
| originalSourceSchemaVersion | Required null, 3 or 4 |
| originalSourceSchemaChecksum | H?; paired exact original checksum |
| originalSourceEvidenceHash | H?; historical raw source hash |
| originalClosureProofHash | H?; historical raw closureProof hash |
| executionPolicyHash | H; old stage.policyHash |
| holdId | U?; route table below |

| candidateKind / original source | preparationRef | Original source fields / closure | holdId |
| --- | --- | --- | --- |
| fresh_bootstrap | Nonnull actual P1 R | originalSourceRef/schema version/checksum/evidence hash/closure hash all null | null |
| v3_import / closed-source | Nonnull actual P1 R | Nonnull originalSourceRef, 3/exact V3, evidence and closure hashes | null |
| v3_import / registered-backup | Nonnull actual P1 R | Nonnull originalSourceRef, 3/exact V3, evidence and closure hashes | Nonnull U |
| snapshot_recovery / registered-backup | null | Nonnull originalSourceRef, 4/exact V4, evidence and closure hashes | Nonnull U |

Selection describes old intake; it does not assert current schema4 or authorize
conversion completion. No completion/owner/proof/hash is invented inside selection.
Private admission still validates the completed chain; C2-A archive bundle retains
the separate full conversion evidence.

### 6.2 Exact bundle and comparisons

Exact validator bundle order:

```text
selection, legacyStage, legacyStaged, legacyClosureProof, hold
```

Last two fields are required nullable. The first three are required nonnull.
Use unchanged historical codecs after the strict recursive firewall. Historical
ordered layouts, verified in [recovery-plan.js](../src/im/v2/recovery-plan.js)
lines 27-32, 44 and [recovery-records.js](../src/im/v2/recovery-records.js) lines
99-100, are:

```text
legacyStage: version,requestRef,requestHash,runId,candidateKind,sourceRef,
 sourceEvidence,sourceClosedEvidenceRef,sourceClosedEvidenceHash,isolationAckRef,
 policyHash,candidateReference,preparationRef,createdAt
legacyStaged: version,runId,stageHash,candidateBaseHash,preparationRef,
 instanceId,instanceCreatedAt,initialEpoch,importEpoch,stagedAt
legacyClosureProof: version,evidenceRef,sourceRef,isolationAckRef,sourceKind,
 instanceId,instanceCreatedAt,schemaVersion,schemaChecksum,fileHash,backupId,
 manifestHash,issuedAt
```

| Binding group | Required equality / check |
| --- | --- |
| Hash/run/ref | selection.legacyStageHash = raw hash(stage) = staged.stageHash; legacyStagedHash = raw hash(staged); all run IDs agree; selection/stage reference exactly `runs/<runId>/candidate.sqlite` |
| Kind/identity/epoch/preparation | selection kind = stage kind; identity/birth/initialEpoch = staged; preparationRef = stage and staged, with route nullability; nonfresh source identity/birth also agree |
| Request | Stage retains its original ordered request-input hash algorithm and unchanged requestRef/isolation/source fields; no new selection-key substitution |
| Original source | selection originalSourceRef = stage.sourceRef; source version/checksum and originalSourceEvidenceHash = actual historical stage evidence, or all null fresh; original hash uses registeredSourceEvidence or closedSourceEvidence |
| Closure | Nonfresh old proof required; raw hash equals selection.originalClosureProofHash and stage.sourceClosedEvidenceHash; proof.evidenceRef = stage.sourceClosedEvidenceRef; all old closure sourceRef/isolation/kind/identity/schema/file/backup/manifest comparisons from recovery-plan lines 144-147 apply |
| Policy | selection.executionPolicyHash = stage.policyHash |
| Hold | Registered source requires strict old hold, selection.holdId = hold.holdId, hold.backupId = source.backupId, hold.recoveryRunId = runId, hold.stageHash = **old** stage hash; fresh/closed require hold and holdId null |
| Staged history | stagedAt >= stage.createdAt; fresh candidateBaseHash/importEpoch null; nonfresh candidateBaseHash = original source file hash; v3 importEpoch nonnull and different from initialEpoch; snapshot importEpoch null |

Fresh also requires legacyClosureProof null and all original closure/source fields
null. Closed source refs/isolation equal stage; registered embedded backup ref may
differ from stage.sourceRef. Preserve original `observedAt`, `issuedAt`, stage and
staged times; no regeneration. Return only detached deeply frozen selection.
This bundle cannot prove current source authority, durability, current completion,
unbound/unreleased hold or canonical workspace ownership; those are private gates.

## 7. Exact proposed sourceObservation and nested B2 families

### 7.1 sourceObservation ordered fields

| Field | Type / fixed value |
| --- | --- |
| version | Literal 1 |
| kind | Literal `registered-source-observation` |
| backupId | U |
| record | Exact correlated B2 registry record below |
| sourceEvidence | Exact correlated B2 source evidence below |
| hold | Required null or unchanged strict registry hold |
| binding | Required null or unchanged strict registry binding |
| release | Required null or unchanged strict registry release with terminalState exactly `active`; the new wrapper rejects `failed` |

No copied bytes, raw path, `copyTo`, `establish`, durability boolean, receipt,
source-proof capability or terminal certification belongs in this DTO. Its nested
record's historical derived `artifactReference` remains unchanged metadata, not an
exposed filesystem path/copy authority. Observation is not stored as authority.

### 7.2 Exact family dispatch and nested field orders

| Actual B2 family | record | sourceEvidence | Artifact provenance |
| --- | --- | --- | --- |
| Registered3 imported | recovery-records `record`, recordVersion3, `imported-registered-v3`, schema3/exact V3 | recovery-records `source`, version1, registryFormat2, schema3/exact V3, importedRecordHash H | Original raw legacy recordVersion2 and raw legacy v3 manifest, genuine independent-copy import |
| Native4 | recovery-records `record`, recordVersion3, `native-v4`, schema4/exact V4 | recovery-records `source`, version1, registryFormat3, schema4/exact V4, importedRecordHash null | Manifest2, `im-v2-backup-1`, exact4 |
| Native5 | C1 `record`, recordVersion4, `native-v5`, schema5/exact V5 | C1 `source`, version2, registryFormat4, schema5/exact V5, importedRecordHash null | Manifest3, `im-v2-backup-2`, exact5 |

Do not confuse imported B2 recordVersion3 with the original legacy recordVersion2,
or a source's registryFormat with its enclosing recordVersion. No crossed tag,
unknown version or decoder fallback is allowed. Source kind is registered-backup
for all three. Manifest and import bytes are privately verified, not extra DTO
fields. Native families forbid an import file.

Exact nested orders are shared across old/new families where stated, **by reference
to the actual codecs** with these verified expansions:

| Nested kind / code reference | Canonical ordered fields |
| --- | --- |
| Old `record`: recovery-records lines 84-90; C1 `record`: backup-v5-records line10 | recordVersion, backupId, instanceId, instanceCreatedAt, schemaVersion, schemaChecksum, fileHash, manifestHash, completedAt, artifactReference, publicationKind, sourceEvidenceHash, registeredAt |
| Old `source`: recovery-records lines 91-98; C1 `source`: backup-v5-records line11 | version, kind, sourceRef, registryFormat, instanceId, instanceCreatedAt, backupId, fileHash, manifestHash, schemaVersion, schemaChecksum, completedAt, importedRecordHash |
| Unchanged registry `hold`: recovery-records lines 99-100 | version, holdId, backupId, recoveryRunId, stageHash, createdAt |
| Unchanged registry `binding`: recovery-records lines 101-102 | version, holdId, stageHash, preparePlanHash, boundAt |
| Unchanged registry `release`: recovery-records lines 103-104 | version, holdId, recoveryRunId, terminalState, stateEvidenceHash, approvalRef, releasedAt |
| Native `manifest` (private validation only): recovery-records lines 79-83; backup-v5-records lines 9,13 | formatVersion, backupId, sourceId, sourceCreatedAt, schemaVersion, schemaChecksum, fileHash, completedAt, toolVersion, approval; nested approval: approvalRef, executorActorId, approverActorId |

Here [recovery-records.js](../src/im/v2/recovery-records.js) and
[backup-v5-records.js](../src/im/v2/backup-v5-records.js) are the referenced files.
Registry/source identity and backup/run/hold fields are U; all hash fields H;
creation/completion/registration/binding/release times N; refs/approval/actors R;
hold/binding/release version1. `sourceRef` is exactly `backup:<backupId>`;
`artifactReference` exactly `registry/artifacts/<backupId>.sqlite`. Native approval
actors differ. Exact checksums and family tags above supplement weaker historical
hash-only shape predicates; no new native timestamp inequalities are added.

### 7.3 Required content consistency and limits

Encoding/hashing/decoding sourceObservation validates the whole correlated nested DTO:
outer backupId = record.backupId = sourceEvidence.backupId; record and source
identity/birth/schema/checksum/fileHash/manifestHash/completedAt all equal;
record.sourceEvidenceHash is the raw canonical source hash of that exact family.
Any hold.backupId equals outer backupId. Null hold requires null binding and
release. Binding requires hold and matches holdId/stageHash, with
`boundAt >= hold.createdAt`. Nonnull release requires `terminalState === 'active'`
and binding, matches holdId and recoveryRunId, and has
`releasedAt >= binding.boundAt`. These are content/chronology checks, not a claim
of terminal authority.

The stageHash equals the original hold stage: historical stage on converted routes,
native target5 stage on native routes. The DTO has **no stage record**; pure
consistency can compare binding to hold but cannot authenticate either to a stage.
Future owner composition must compare the actual historical/native stage and
prepare plan. Likewise release has **no preparePlanHash or stageHash field**;
do not invent either to make a stronger pure terminal claim.

Historical shape distinction is explicit: the `release` codec accepts `active|failed`
([recovery-records.js](../src/im/v2/recovery-records.js) lines 103-104), but genuine
`holdLocked(..., allowRelease=true)` rejects `failed`, because no approved failed
terminal verifier exists ([backup-registry.js](../src/im/v2/backup-registry.js)
lines 274-290). Both the **new pure sourceObservation encode/hash/decode wrapper**
and the future private observer require active-only nonnull release. Preserve the
historical codec and its `active|failed` vocabulary unchanged; this wrapper rule
does not declare every historical failed release record invalid. A coherent failed
marker still refuses in the new wrapper. Encode/hash use `RECOVERY_INVALID`, decode
uses `RECOVERY_EVIDENCE_MISMATCH` under §4, and actual observer evidence refusal uses
`RECOVERY_EVIDENCE_MISMATCH`, matching the old genuine held scope.

| New wrapper acceptance case | Pure encode/hash/decode | Future observer |
| --- | --- | --- |
| Coherent hold/binding/release with release.terminalState `failed`, all other fields matching | Reject: encode/hash `RECOVERY_INVALID`; decode `RECOVERY_EVIDENCE_MISMATCH` | Reject with `RECOVERY_EVIDENCE_MISMATCH` |
| Coherent hold/binding/release with release.terminalState `active`, all other fields matching | Eligible content, subject to all strict family/binding rules | Eligible only after genuine requested-source/hold and scope checks; never terminal authority |

Legacy v3 manifest bytes are another historical boundary: current imported-v3
verification parses retained raw bytes and verifies original hashes/selected
fields, not a new canonical manifest3-like table (backup-registry lines 67-115,
154-163). Do not invent a fixed replacement manifest order or canonicalize original
import bytes. The exact B2 record/source order above is defined; it does not freeze
a new legacy manifest grammar. Actual full artifact/manifest/import verification
stays private, beyond this content-only DTO.

## 8. Future private observation-only registry seam

Proposed private composition only:

```text
withRecoverySourceObservation(registry, {backupId,holdId}, ctx,
  inheritedAuthenticatedBudget, consume)
```

Both input fields are required; backupId U, holdId U or explicit null. Authenticate
the genuine registry brand and current admin **before metadata disclosure**. Use
one source lock and the same authentic inherited budget for full version-family
artifact/content checks, callback and final checks. `observation.backupId` MUST
equal input.backupId, as must the actual record/source backup IDs. Resolve hold,
binding and release internally with these exact request bindings:

- Nonnull input.holdId loads exactly that existing hold; returned hold.holdId MUST
  equal input.holdId and hold.backupId MUST equal input.backupId. Load correlated
  binding/release only for that requested hold. A missing requested hold refuses;
  never degrade to null, select another hold or scan for an arbitrary replacement.
- Null input.holdId means **no hold selection, enumeration or discovery**. Return
  hold, binding and release all null, even when other holds exist for that backup.
- These are private seam requirements, not additional DTO fields or exports: the
  pure DTO cannot compare itself to a request absent from its record.

The actual missing-requested-hold code is `RECOVERY_EVIDENCE_MISMATCH`, not
`RECOVERY_NOT_FOUND`. Source is checked first in
[backup-registry.js](../src/im/v2/backup-registry.js) lines 439-442; `holdLocked`
then reads the exact record at lines 274-276 through `read` at line 127. Missing
file failure flows through [recovery-records.js](../src/im/v2/recovery-records.js)
lines 127-129, 162-164 and 187-190; `storage.withLock` maps it to that fixed code
at lines 270-273. Wrong hold identity or backup linkage also gives evidence
mismatch (backup-registry lines 276,442). The future content-only path preserves
this refusal without invoking the existing verifier's artifact resync.

| Request-binding counterexample | Required observer outcome |
| --- | --- |
| Nonnull requested holdId is missing, even though another hold exists for the requested backup | `RECOVERY_EVIDENCE_MISMATCH`; no null fallback or substitute hold |
| Requested hold record names a different holdId or belongs to a different backup | `RECOVERY_EVIDENCE_MISMATCH`; no relabeling or cross-backup selection |
| input.holdId is null while that backup has existing holds | Return hold/binding/release all null after source checks; no enumeration/discovery |

No caller proof or path is accepted. Supply detached frozen §7 DTO to a synchronous
callback, with no facility to establish holds, copy bytes or mint a brand.
Reject thenables, known async/generator callbacks,
reentry and caught faults; expire the scope before callback-bearing cleanup and
postvalidate actual content/authority/identity before success. Detached DTOs can
remain readable but never retain source-proof capability or active-scope authority.

Observation permits **no source/candidate/business/evidence mutation, publication,
repair, resync or durability establishment**, including hold/binding creation,
artifact copy or establish capability. “Read-only” here means observation-only
business/evidence behavior, not literally zero filesystem writes. Existing
validated coordination-state locking housekeeping is allowed through the current
writable SQLite connection, `BEGIN IMMEDIATE` and `ROLLBACK` protocol in
[registry-lock.js](../src/im/registry-lock.js) lines 74-99, including its existing
validation and connection close. No extra SQL/data change or committed coordination
DB transaction beyond that lock protocol is authorized.

Existing acceptable protected coordination state is REQUIRED. Do not create,
initialize or repair a missing/unacceptable lock DB; fail closed. The constructor's
initialization path at registry-lock lines 20-38 is not an observer operation;
existing-state checks are at lines 46-73. No raw-descriptor open/close or fsync of
the held coordination inode, artifact resync, status repair or lock redesign is
permitted. Missing required state refuses/classifies; no status-time repair.
Missing completion means status reports an explicit retry requirement; status
itself cannot manufacture completion. Exact target5 status/result DTOs remain open.

Actual [backup-registry.js](../src/im/v2/backup-registry.js) lines 129-182 couple
content verification and native5 resync; lines 223-272 add a copy capability, and
435-458 held inspection still passes through that resyncing verifier. Therefore
existing `verify`, `withVerifiedBackup` and `withRecoveryHold` are not the new
observation-only seam. Future implementation must split private content validation
from the durable wrapper, with separate authentic scope issuance. **Never add a
public `skipSync` flag**, abuse the refusal-only old-P5 `admit` argument, or expose
pre-durability metadata as B2 proof. B2 verify/reopen resync guarantees remain
unchanged. Branding and existing facade keys are at lines 555-574.

## 9. Future completed handoff, controls and budget integration

Use the C2-A proposed private completed-handoff seam, not a public converter call
inside a new stage callback. Authenticate same canonical root/run and genuine old
facade; internally resolve original source/closure/hold. Acquire **source ->
workspace -> candidate exactly ONCE**, preserving original closed-source isolation
scope (fresh has no fake source lock). Validate current completed conversion,
original locator/stage/staged/policy/hold, full schema5 identity/epoch and completion
posthash **before** archive intent or copy.

Then use unchanged C2-A archiveIntent -> independent byte copy -> full protection,
standalone/inode separation, file/directory fsync and no-replace archive publication
-> handoff protocol. Never hardlink live candidate to archive, sync a held
coordination inode through a raw descriptor, or overwrite unexplained residue.
Only durable handoff issues the private target5 ownership receipt. A visible
handoff with uncertain sync already excludes converter entry pending explicit
handoff durability completion; observation cannot issue a successful receipt.

After handoff, converter refuses **before obsolete current-posthash checks**.
Target5 reads the immutable archived conversion plus its later valid phase chain,
not the obsolete initial live hash. Old target4 exclusion is permanent from the
conversion branch; no owner deletion or return-to-v4 path. Existing exclusion
logic does not yet implement new handoff inventory: recovery.js lines 389-400,
457-507 and 509-525 require future reviewed integration, not unchecked new files.

The original authenticated new-operation budget covers lookup, observation,
validation, hash/copy, callbacks, publication, handoff and final checks, without
reset or cap increase. Native operations remain soft-budgeted. Existing
`operationBudget(limits,inherited)` authenticates/reuses object identity
([recovery-records.js](../src/im/v2/recovery-records.js) lines 18-39), and registry
internal scopes already accept inherited budgets (backup-registry lines 562-574).
But old target mint and converter entries create budgets independently
([recovery.js](../src/im/v2/recovery.js) lines 548-573). A **new private inherited
entry is needed**; wrapping public mint/converter calls does not propagate the
new stage's budget. Old P1 stage and explicit converter prerequisite operations
have their own original budgets; they are not falsely included in the future
handoff operation's elapsed/accounting span.

## 10. Clock mutation and retry gates remain unresolved

Actual [clock.js](../src/im/v2/clock.js) lines 94-111 retain sampled high-water and
write an anchor; 178-209 perform an independently durable anchor **before** the
business transaction and persist high-water after business savepoint rollback.
Even `runRead` anchors at lines 127-154. Old prepare and verify/activate call
`runWriteFresh` ([recovery-candidate.js](../src/im/v2/recovery-candidate.js) lines
499-545). Therefore “initial hash unchanged or a prepared row exists” is not an
adequate retry grammar: a rejected operation can legitimately change clock bytes
without committing its business phase.

Future durable prepare intent must precede the first **writing clock-guard entry**
or other prepare write and bind exact intake, plan, captured actors and initial
hash. Derive the permitted clock interval/projection from durable evidence; an
arbitrary monotonic increase is not proof of an authorized sample. All nonclock
facts must remain unchanged in a clock-only outcome, using exact phase digests;
unknown deltas remain `RECOVERY_INDETERMINATE`. Intent presence alone cannot make
every greater clock floor admissible.

Verify and activate need their **own** intents and exact projections; a failed
activation may alter clock bytes and must not reuse an obsolete seal. Completed
phase recognition must bind the real later chain and full schema5 state. Exact
clock intents, reservations, digest allowlists and mutation records are **NOT
FROZEN**. Do not invent reservation fields, mutation receipts or a partial phase
protocol here. This is a blocking C2 requirement, not a claim that old clock APIs
already supply the necessary durable evidence.

Future snapshot prepare still atomically establishes epoch/counter/run/center/
progress, revokes leases, remains paused and **DELETE HEAD ONLY**; preserve anchor
history/generations, sole conversion transition, business history and floor, with
full exact5 validation before commit. Fresh/import retain original P1 epoch/counter0.
No maintenance session, operational time owner or production opener is transferred.

## 11. Proposed inventory additions and conservative crash matrix

Only these admission additions are proposed; this is not a full phase inventory:

| Derived reference | Presence / interpretation |
| --- | --- |
| `v5-runs/<runId>/conversion-selection.json` | Converted route; descriptive selection, never ownership/completion capability |
| `v5-runs/<runId>/source-closed.json` | Only if a NEW target5 closure is required/requested; never overwrite `runs/<runId>/source-closed.json` |
| C2-A archive intent/archive/handoff files | C2-A exact fields, references and rules unchanged |
| sourceObservation | Transient detached observation; never stored as source or terminal authority |

| Observed interruption / state | Permitted classification / next behavior |
| --- | --- |
| Selection exists without handoff | Selection is not ownership; revalidate genuine completed run before an explicit stage/handoff operation |
| Unknown pending or conflicting evidence | Preserve and refuse; indeterminate/manual reconciliation, no adoption/deletion even if apparent bytes match |
| Final archive, no handoff | Explicit exact retry only: validate original intent/chain/live/archive hashes, protection and inode separation, resync required files/directories, then publish same handoff |
| Visible handoff, sync uncertain | Converter excluded immediately; explicit handoff retry validates/resyncs and completes durability before target5 receipt |
| Durable handoff, unchanged live initial bytes | Initial boundary remains verifiable; mutation eligibility requires the later accepted phase protocol, not automatic prepare readiness |
| Live changed without matching durable phase intent/evidence | INDETERMINATE; no adoption as “probably clock,” no obsolete posthash rewrite |
| Conversion/activation completion missing | Status only reports retry required; explicit owning operation must establish completion; no status repair |
| Hold released, backup still present | Observe real source/hold/binding/release and later terminal chain as appropriate; cleanup remains false |
| Source missing after release | Unsupported; no cleanup/deletion acceptance or synthetic source proof |

Error vocabulary for future target5 boundaries is the existing fixed local family:
`RECOVERY_INVALID`, `RECOVERY_AUTH_DENIED`, `RECOVERY_APPROVAL_DENIED`,
`RECOVERY_EVIDENCE_MISMATCH`, `RECOVERY_UNSUPPORTED`, `RECOVERY_BUSY`,
`RECOVERY_NOT_FOUND`, `RECOVERY_INDETERMINATE`, `RECOVERY_DURABILITY_UNCERTAIN`,
`RECOVERY_PLAN_STALE`. No raw adapter/native exceptions, paths, SQL or secret
details cross the boundary. Existing converter `MAINTENANCE_*` and old facade
`RECOVERY_CONVERSION_PENDING` semantics remain unchanged; a future boundary must
map only authenticated internal errors, not trust an arbitrary thrown `code`.
Exact per-method error/result/status tables remain in the later package.

## 12. Actual API map and remaining historical ambiguities

These are baseline observations, not proposed target5 DTOs. All source paths below
are under `src/im/v2/`; operation names alone do not freeze target5 inputs/results.

| Actual API / location | Checked behavior / consequence |
| --- | --- |
| recovery.js:194-195,1174-1177 `createImV2RecoveryServices` | Existing factory and frozen eight-operation facade, private WeakMap; no target5 factory signature is defined here |
| recovery.js:852-856 `stageCandidate` | Old input `{requestRef,candidateKind,sourceRef,isolationAckRef}`; uses old route and its own budget |
| recovery.js:937-950 `previewRecovery` / `prepareRecovery` | Old `{runId}` / `{runId,preparePlanHash,approvalRef}`; not the new schema/actor protocol |
| recovery.js:1002-1005,1028-1032 `verifyRecovery` / `previewActivation` | Old `{runId,preparePlanHash}` / `{runId,sealReference,authReviewRef,isolationAckRef,activationRef}` |
| recovery.js:1060-1063,1109-1110 `activateRecovery` / `getRecoveryStatus` | Old `{runId,activationPlanHash,activationApprovalRef,sealReference}` / `{runId}` |
| recovery.js:1166-1172 `releaseRecoveryHold` | Old `{runId,holdId,releasePlanHash,approvalRef}`; genuine source/terminal composition required |
| recovery.js:104-179,698-775 converter and target | Explicit executor, genuine target, preview/convert, old resolveApproval and distinct actors; public result is not archive ownership |
| recovery-source.js:57-71,73-87,106-132 | Old closure names/fields and catalog union differ; target4 refuses native5 before old codec/copy/hold use |
| backup-registry.js:129-182,435-458,555-574 | Versioned B2 verification/held scopes authenticate registry; native5 resync means they cannot implement observation-only source/evidence behavior directly; existing coordination locking remains allowed under §8 |
| backup-registry.js:464-543,579-586 | Existing releaser rejects native5; callback publisher input is exactly `{stateEvidenceHash,minimumReleasedAt}`, returns a private receipt; target5 needs its own actual terminal publisher |
| recovery-records.js:99-104; backup-registry.js:274-290,336-344 | Hold/binding/release fields unchanged; binding stage inherited from hold; release lacks stage/plan hash; codec failed marker is not supported genuine terminal evidence |
| recovery-candidate.js:105-156 | Existing logical digest is explicit old3/4 selection; it is not a literal schema5 digest/phase grammar |
| clock.js:94-111,127-154,178-209 | Clock advancement can survive business failure; no status clock call or generic changed-byte adoption |

Do not silently resolve these shape mismatches by adding fields: the future concept
often called `minReleasedAt` is **`minimumReleasedAt` in the actual old publisher**,
not a release-marker field; new publisher spelling/table is still unfrozen. The
old closure uses schemaVersion/fileHash, while the new proposal uses source-prefixed
names and adds version/sourceEvidenceHash/target. New sourceObservation contains
neither stage nor manifest nor terminal chain and cannot certify facts absent from
that DTO. Legacy v3 raw manifest and release failed-marker boundaries are as §7.3.
The present old conversion inventory will reject new archive files until a reviewed
phase-aware bridge is implemented. None of these gaps permits changing C2-A.

## 13. Complete unresolved C2 package and next gate

The following remain **unresolved / NOT FROZEN** and must be documented as one
substantive phase-protocol package after independent B1 review. No final target5
factory signature is proposed here.

| Remaining contract | Required complete decision |
| --- | --- |
| Stage/request locator/staged/result and eight-method DTOs | Exact ordered records/options/inputs/results/nullability, request identity/retry rules, native versus converted stage/intake/hash relationship and old-run/new-locator binding |
| Native5 copy/base/normalization/pause | Complete source-copy durability and candidate phase records, byte ownership, normalization/no-op outcomes and pause rules |
| Literal 3/4/5 digest grammar and phase projections | Full table/column/type/row order and framing, schema objects, every v5 history/head/transition fact, count/length bounds and permitted exact deltas; preserve old3/4 algorithms |
| Prepare plan/intent/result and clocks | Full source/target/approval/expiry fields, durable initial binding, clock intervals/reservations and clock-only/committed/retry projections |
| Verify intent/result and seal2 | Full new version2 seal fields/hash, schema5/checksum, clock/verification projection, exact byte binding and failed-retry rules |
| Activate intent/plan/completion | Full fields, approvals/actors, epoch/source/target/chronology, transaction and interrupted completion protocol; obsolete seal exclusion |
| Release/status/results and new terminal publisher | Actual new-family terminal proof, min-release-time protocol, exact result/status/null/error tables, release ownership/durability and current authority checks |
| Inventories and independent golden fixtures | Every required/forbidden file per phase, pending/response-loss/crash classifications, exact references, independent canonical byte/hash literals and all historical regressions |

Next: **parent independent C2-B1 document review -> remaining C2 substantive
phase-protocol document package together -> acceptance of complete required
contracts -> S3 -> H4 -> Q5**. A pure-codec writer may start only after its own
accepted complete contract and independent-fixture assignment; this proposal is
not that acceptance. Runtime S3/H4 and Q5 remain blocked until their required
records/phase contracts exist and are accepted. C2-A's accepted technical scope
stays unchanged. Operational ownership/time, B1 writer, P6 faults, P7 and H1-H3
remain later separate gates; C2-B1 is not whole-C2 completion.

## 14. Document-only local checks and handoff scope

This lane owns completeness of transcription against actual old APIs. Check both
owned documents for strict UTF-8/no BOM, final newline, balanced fences, valid
relative link targets and whitespace; compare the four ordered field tables,
authority binding and exact validator bundle orders with the supplied decisions.
Check historical nested orders against the cited source and preserve all plan
bytes outside the current C2-B subitem. Parent owns the subsequent independent
review. Document validation is not codec or runtime test evidence.

Writes are limited to this new document and the current C2-B TODO subitem in
`docs/im-v2-implementation-plan.md`. No code/tests/config/dependencies, other docs,
DB or service work, commit or push. No production enabling, operational time owner,
cleanup or listener work. Defaults stay disabled/paused; expiry/purge/backup cleanup
OFF; 90/7/180-day policy and null/unconfirmed backup TTL unchanged. Final document
hashes identify only this pending-review handoff, not runtime acceptance.
