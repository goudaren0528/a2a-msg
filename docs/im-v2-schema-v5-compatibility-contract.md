# Schema 5 runtime and versioned backup/recovery compatibility (NONRELEASE)

**Approved architectural handoff; R1 and C1 are IN_PROGRESS, not accepted.**
Checked committed baseline: `f74b20de1e503e6cc00bf29be0b33d512eabc074`
(2026-09-28). B0.3 is complete only within its accepted isolated scope.
This document records the parent's decisions; it supplies no runtime acceptance,
new recovery field layouts, or production authorization.

Read with the [PRD](prd/a2a-msg-agent-im-v1.md), [roadmap](roadmap.md),
[current implementation ledger](im-v2-implementation-plan.md#52-接下来按依赖推进的-todo),
[maintenance contract](im-v2-maintenance-contract.md),
[schema-v5 contract](im-v2-maintenance-schema-v5-contract.md),
[conversion contract](im-v2-recovery-conversion-contract.md),
[time contract](im-v2-maintenance-time-contract.md),
[P5 storage contract](im-v2-recovery-storage-contract.md),
[P5 prepare contract](im-v2-recovery-prepare-contract.md), and
[P5 activation contract](im-v2-recovery-activation-contract.md).
Their historical statuses and evidence remain historical. This handoff refines
the schema-v5 compatibility gate with the approved decisions below; unspecified
new recovery encodings remain explicitly pending.

## 1. Ownership, version boundaries and dependency order

The document lane writes only this new file and the implementation plan's current
TODO section. Active gen159 owns `src/im/v2/clock.js` and its new runtime tests;
gen160 owns the new `src/im/v2/backup-v5-records.js` and dedicated tests/fixtures.
Their moving files are not inputs to this handoff. Assignment is not acceptance;
the parent must review stable source-bound evidence before accepting either lane.

| Package | Exact current status | Dependency / exit |
| --- | --- | --- |
| B0.3 | Completed, limited scope | Existing isolated synthetic ACTIVE/PAUSED time evidence only |
| R1 runtime clock | IN_PROGRESS; review/acceptance pending | Exact 4/5 constructor admission and bounded pinned hot checks; §2 evidence |
| C1 backup pure codec | IN_PROGRESS; review/acceptance pending | Exact three-kind codec in §3 and independent literal goldens |
| B2 backup/registry composition | FUTURE; not accepted | Starts after both R1 and C1 acceptance; §4 |
| C2 exact recovery-family document gate | PENDING; no recovery writer authorized | Finite complete package in §6 before recovery source work |
| S3 source/digest/candidate | FUTURE; NOT READY | Accepted B2 and frozen C2; exact 3/4/5 validation/digests |
| H4 protected handoff/new facade | FUTURE; NOT READY | S3 plus C2; protected conversion boundary and prepare intent |
| Q5 roundtrips | FUTURE; NOT RUN | H4; native5 and converted4 backup/register/restore/verify/ACTIVE-PAUSED |
| Operational ownership/time | Separate FUTURE gate | Genuine production ownership and time approval composition |
| B1 writer, then P6 fault / P7 / H1–H3 | PENDING | Separate writer contracts, implementation, evidence and human gates |

Execution order is **R1 || C1 -> B2 -> C2 document gate -> S3 -> H4 -> Q5 ->
separate operational ownership/time gate -> B1 writer -> P6 fault / P7 H1–H3**.
Preparing the C2 document does not authorize implementing its writer. No failed
or incomplete predecessor is converted into a completed TODO.

Preserve `schema.js`'s exact v4 exports and v4-only behavior, all historical
DDL/checksums and golden bytes, fresh4/import-to4 APIs, wire v2, client journal 2,
and legacy LAN/center 3. No global version replacement or implicit migration.
This compatibility work does not establish v5 operational readiness.

## 2. R1: unchanged clock APIs, full admission and pinned hot checks

Existing clock factory APIs remain unchanged. During the constructor's `BEGIN`
snapshot, call existing `assertSupportedImV2Center` for **full exact schema 4 or
5 validation**. Pin the schema cookie and the validated
`{schemaVersion,schemaChecksum}` pair, and cross-check the marker within that
admission boundary. A marker alone cannot admit a center.

Hot checks compare the current cookie and marker pair to that pinned binding.
Drift rejects with existing `STORAGE_UNAVAILABLE` **before a business callback
or clock write**. No automatic version adoption, validator fallback, transparent
rebind or hot-path full-history scan is allowed.

For schema 5, also perform bounded checks of the optional maintenance head
against the **actual current epoch and actual anchor-chain tip**. A head must
match both; stale-epoch or non-tip head is corruption. Empty history requires
no head; retained history with no head is valid and means unanchored. Full
history validation belongs to constructor admission, not every business call.
Do not permanently pin the epoch: genuine owned recovery changes the epoch and
deletes the head atomically. Existing transaction-level epoch/fence checks still
apply to the actual current state.

Ordinary business-clock updates write only `im_clock`; they never update
maintenance anchor history, head or private time session, and never establish or
refresh maintenance authority. This is the clock component's write boundary,
not a prohibition on the separately authorized business transaction's own rows.
Paused denial, auth/ACL/revocation, leases and wire/fingerprint behavior remain
the existing runtime semantics. R1's source scope is only `clock.js` plus new
tests pending review; no backup, recovery or operational readiness follows.

## 3. C1: exact native-v5 backup pure codec

New `src/im/v2/backup-v5-records.js` has exactly three exports:

```text
encodeImV5BackupRecord(kind,record) -> Buffer
decodeImV5BackupRecord(kind,bytes) -> detached deeply frozen record
hashImV5BackupRecord(kind,record) -> lowercase SHA-256 hex
```

Kinds are exactly `manifest`, `record`, `source`. This is pure encoding,
decoding and hashing: no I/O, registration, source ownership or provenance.
Successful hashing never authenticates a backup.

### 3.1 Strict data and byte rules

- Accept only ordinary objects with the exact own enumerable data fields;
  reject Proxies **before reflection**, accessors, symbols, nonenumerable,
  unknown or missing fields and nonordinary values, including nested approval.
- Follow existing P5 lowercase UUID and 64-lowercase-hex hash conventions.
  `Ref` is a nonempty string of at most 255 UTF-16 units with no C0/DEL.
  Time/creation/registration numbers are nonnegative safe integers; reject `-0`,
  unsafe integers and coercions.
- Encoding constructs the exact order below from valid ordinary data regardless
  of input insertion order. Canonical JSON uses UTF-8 with no BOM, formatting
  whitespace or trailing newline, at most **65536 bytes** per complete record.
- Decode uses fatal UTF-8 validation, strict shape checks and byte-identical
  canonical re-encoding. Reject reordered keys, duplicates, BOM, formatting
  whitespace, trailing bytes/newline, malformed UTF-8 and noncanonical numbers.
  Returned records are detached and deeply frozen.
- Invalid encode/hash inputs use fixed `RECOVERY_INVALID`; invalid decode bytes
  use fixed `RECOVERY_EVIDENCE_MISMATCH`. No hostile exception text is exposed.
- Hash **raw canonical JSON bytes**: `SHA256(canonicalUTF8Bytes)`. There is **no
  domain prefix**. Maintenance/conversion domains are not reused, and the future
  recovery-v5 domain in §5 is not applied to these three backup kinds.

`V5_CHECKSUM` below denotes the existing reviewed schema-5 manifest checksum,
not any syntactically valid hash. This handoff invents no checksum or golden hash.
Historical v4 manifest-2/native-v4 record-3/source-1 bytes remain unchanged.

### 3.2 Manifest: exact ordered fields

```text
formatVersion, backupId, sourceId, sourceCreatedAt, schemaVersion,
schemaChecksum, fileHash, completedAt, toolVersion, approval
approval: approvalRef, executorActorId, approverActorId
```

| Field | Fixed value / type |
| --- | --- |
| formatVersion | `3` |
| backupId, sourceId | P5 UUID |
| sourceCreatedAt, completedAt | Nonnegative safe integer, not -0 |
| schemaVersion, schemaChecksum | `5`, exact `V5_CHECKSUM` |
| fileHash | Lowercase SHA-256 hex |
| toolVersion | Exact `im-v2-backup-2` |
| approval | Exact ordered nested object; three Ref fields; executorActorId differs from approverActorId |

### 3.3 Registry record: exact ordered fields

```text
recordVersion, backupId, instanceId, instanceCreatedAt, schemaVersion,
schemaChecksum, fileHash, manifestHash, completedAt, artifactReference,
publicationKind, sourceEvidenceHash, registeredAt
```

| Field | Fixed value / type |
| --- | --- |
| recordVersion | `4` |
| backupId, instanceId | P5 UUID |
| instanceCreatedAt, completedAt, registeredAt | Nonnegative safe integer, not -0 |
| schemaVersion, schemaChecksum | `5`, exact `V5_CHECKSUM` |
| fileHash, manifestHash, sourceEvidenceHash | Lowercase SHA-256 hex |
| artifactReference | Exactly `registry/artifacts/<backupId>.sqlite`, derived from this record's backupId |
| publicationKind | Exact `native-v5` |

### 3.4 Registered source evidence: exact ordered fields

```text
version, kind, sourceRef, registryFormat, instanceId, instanceCreatedAt,
backupId, fileHash, manifestHash, schemaVersion, schemaChecksum,
completedAt, importedRecordHash
```

| Field | Fixed value / type |
| --- | --- |
| version, kind | `2`, exact `registered-backup` |
| sourceRef | Exactly `backup:<backupId>`, derived from this evidence's backupId |
| registryFormat | `4` |
| instanceId, backupId | P5 UUID |
| instanceCreatedAt, completedAt | Nonnegative safe integer, not -0 |
| fileHash, manifestHash | Lowercase SHA-256 hex |
| schemaVersion, schemaChecksum | `5`, exact `V5_CHECKSUM` |
| importedRecordHash | Required literal `null` |

Full publication/verification binds actual snapshot identity, checksum and file
hash to manifest, source evidence and registry record. Preserve acyclic order:
snapshot -> manifest -> source evidence -> record. These cross-record actual
bindings are B2 proof obligations, not provenance minted by the pure codec.
Independent **literal** bytes/hash golden vectors for all three kinds are
required before C1 acceptance; expected values cannot be generated solely by
the implementation under test. No literal vector/hash is fabricated here.

## 4. B2: future native backup and private registry composition

B2 depends on accepted R1 and C1. Existing factories and caller DTOs remain
unchanged: no caller-schema selector, tag, path or generic register method.
The fully validated **actual snapshot** selects its native version. Use separate
exact v4/v5 inspectors; a marker or caller claim is not a version proof.

| Actual validated native snapshot | Canonical publication family |
| --- | --- |
| Schema 4 | Existing manifest 2 / schema 4 -> old native-v4 record 3 / source 1 |
| Schema 5 | Manifest 3 / schema 5 -> native-v5 record 4 / source 2 from §3 |

Reject mixed format/schema/checksum families. Imported registered v3 retains its
existing route and original evidence bytes. Native backup timeout/drain and
source-connection ownership remain unchanged: timeout does not cancel native
work, and the caller must drain before closing its owned source connection.

The registry writer remains private and follows genuine version-aware proof of
actual snapshot/verified source ownership. No public generic registration,
arbitrary path or metadata object can mint provenance. Hold, prepare-binding
and release encodings may remain **only because** a real version-aware verifier
proves their hash chain binds the actual correct source and terminal evidence.
Shape compatibility or a hash hit alone is insufficient.

Pass the **original authenticated operation budget object** into the selected
exact internal validator. Preserve accumulated source/filesystem accounting and
the original elapsed deadline; no filtered substitute, reset or raised cap.
Count/length projections precede fetching variable data. Native calls remain
soft-budgeted, not promised interruptible. Cleanup remains always false; there
is no TTL adoption, automatic hold release or backup deletion executor.

## 5. Future target-5 recovery direction (NOT READY for source work)

The approved direction is a separate proposed internal
`createImV5RecoveryServices` factory with the same eight operation names:

```text
stageCandidate, previewRecovery, prepareRecovery, getRecoveryStatus,
verifyRecovery, previewActivation, activateRecovery, releaseRecoveryHold
```

It is **target-5-only**, consuming a new strict evidence family. The old target-4
factory, operation contracts and canonical family remain unchanged. The name and
operation set do not freeze new options, inputs, DTOs or field orders; C2 must
do that before source work. No new network/admin endpoint is implied.

| Source / requested target | Approved route |
| --- | --- |
| Genuine registered native5 snapshot -> 5 | New versioned snapshot route; retain sole original conversion transition; no second conversion |
| Genuine registered4 snapshot explicitly -> 5 | Genuine owned v4 candidate -> approved conversion -> protected handoff -> recover5 |
| Fresh or v3 import explicitly -> 5 | Existing genuine P1 fresh4/import4 candidate -> approved conversion -> protected handoff -> recover5 |
| Existing target4 route | Existing behavior and bytes unchanged |
| Raw closed5 / caller path | Unsupported; cannot substitute for registered source/ownership |

New-family records and hashes explicitly bind **source and target schema
versions/checksums**. Its separate hash family is:

```text
SHA256(UTF8('a2a-msg.im.v2/recovery-v5/' + kind + '\n') || canonicalRecordBytes)
```

The separator is one newline byte. Exact `kind` vocabulary, version tags and
ordered record preimages remain C2 gates; do not guess them. Seal version 2
explicitly binds schema 5 and its checksum. Never reuse, relabel or update an old
seal/activation chain to bless conversion or later changed bytes.

### 5.1 Protected independent conversion handoff

Under **source -> workspace -> candidate** control, validate the current complete
conversion owner/pause/plan/proof/completion chain and actual completion posthash.
Create a protected **independent byte archive**, not a hardlink to the mutable
candidate. Its bytes must equal the completion posthash; establish file/directory
sync and no-replace publication. Archive and live candidate must remain distinct
byte ownership domains after recovery mutates the candidate.

The immutable handoff must bind run/stage, identity, source/target schema facts,
owner/paused/plan/proof/completion hashes, conversion posthash, derived archive
reference/hash, live initial hash and time. These are required binding groups,
**not a newly invented field order or DTO**. C2 freezes exact encoding, grammar,
chronology, inventory and interruption classification.

Only durable handoff transfers the mutable candidate to the new recovery owner.
After it, converter operations refuse **before obsolete current-posthash checks**;
the old v4 facade's exclusion is permanent. New recovery validates the archived
conversion boundary plus subsequent phase evidence. Never rewrite old conversion
completion to make legitimately changed live bytes appear original.

Before the first clock-floor or prepare write, publish a durable prepare intent
binding plan, approval, handoff and initial hash. On interruption, recognize only
an exact committed projection or require manual reconciliation. An unexplained
hash change is never adopted as “probably clock”; mode/marker plausibility alone
does not prove the committed phase.

### 5.2 Atomic v5 prepare and authority separation

V5 prepare atomically establishes the approved new epoch/counter/run/center/
progress state, revokes leases, keeps paused mode and **deletes the maintenance
head only**. Preserve all anchor history and the sole conversion transition;
perform full v5 validation before commit. Never reset history-tip generation or
lower the clock floor. Exact fresh/import/snapshot phase bindings and committed
projections remain part of C2, not guessed old-family DTO reuse.

The new closed target owns **no maintenance authority/session**. Stored nonce
does not transfer private process authority; recovery revokes the old session
and leaves the new epoch unanchored. Production time ownership is a separate
future gate: do not reuse the B0.3 synthetic-time opener or recovery conversion
target as a production time capability.

### 5.3 Explicit logical digests and validators

S3 requires exact **3/4/5 table/validator allowlists** and phase digests, including
all v5 anchor history, optional head and conversion metadata. Preserve old 3/4
byte algorithms. Use bounded count/length-before-fetch accounting and the same
authentic operation budget through source, validation, candidate and final
checks. A global version replacement or dropping unknown tables is not v5
support. Full table orders, projections and phase allowances are C2 artifacts.

## 6. C2 finite contract package required before recovery implementation

**PENDING; no recovery writer is ready.** The following finite package must be
fixed and reviewed together, rather than invented incrementally by consumers:

| Required artifact | Must freeze |
| --- | --- |
| New record family | Exact fields/order/types/nullability/version/kind/hash preimages for stage, locator, staged, closure, copy, base, normalize, intake union, handoff, prepare intent, prepare result/plan, seal, activation, completion, release and status |
| API and source bindings | Exact factory/options, all eight operation inputs/results, native5 vs converted4/fresh/v3 source unions, actual source/target schema and identity/checksum/hash bindings; capability ownership, authorization and budget plumbing |
| Protected phase inventory | Exact derived references, filenames, required/forbidden files per phase, independent archive lifetime/protection, no-replace/sync boundaries and permanent old-facade/converter exclusion |
| Crash classifications | Before/after archive and handoff durability, first floor write, prepare intent/transaction, seal/activation/completion/release; exact committed projection vs conservative manual reconciliation, including unknown pending evidence |
| Digests and validation | Exact 3/4/5 allowlists/order/projections, unchanged historical 3/4 algorithms, all v5 metadata, source/target/phase validators and original-budget propagation |
| Literal vectors | Independently reviewed canonical bytes and hashes for every new kind and route union, mixed-family rejection and old-family golden regression |

This table is the finite remaining contract gate, not an assertion that these
layouts or new DTOs already exist. S3/H4 source work waits for its acceptance.

## 7. Required evidence and truthful acceptance scope

| Gate | Required source-bound evidence; not run by this handoff |
| --- | --- |
| R1 | Full exact4/exact5 constructor admission; marker/checksum/cookie drift before callback and clock write; unchanged wires/fingerprints/ACL/revocation/leases; paused denial; head/current-epoch/actual-tip checks; history-without-head valid; no hot full-history scan and no maintenance writes/session refresh |
| C1 | Independent literal bytes/hash vectors for all three kinds; exact exports/frozen detached decoding; insertion-order encode vs decode-order rejection; mixed formats/checksums/tags, malformed UTF-8/BOM/whitespace/duplicates/unknown fields, Proxy-before-reflection/accessors/symbols, safe integer/-0 and 65536-byte boundary |
| B2 | Actual native4/native5 snapshot dispatch; authenticated provenance, original-budget exhaustion/no reset; v3 import and v4 canonical compatibility; timeout/drain/source ownership; version-bound hold/binding/release and cleanup always false |
| S3/H4 | Exact accepted C2 package; complete source/schema/digest dispatch; durable independent archive and transfer, converter refusal ordering and permanent old-facade exclusion; prepare intent precedes first floor/write; exact interrupted projection or manual reconciliation |
| Q5 | Genuine native5 and converted4 backup -> register -> restore -> verify -> ACTIVE/PAUSED roundtrips; preserved anchor history and sole transition; atomic epoch/head-only removal and lease revocation; unchanged archive after live mutation; no old seal reuse; native publication/prepare/activation/completion fault and retry evidence |

Evidence must state reviewed source hashes, platform, commands, exits and actual
pass/fail/skip counts. Native Linux strict protection and Windows portable
coverage/strict UNSUPPORTED must be reported truthfully; skips are not native
passes. Process-kill/fault evidence is not a hardware power-loss claim.

Only after the future required tests and reviews pass may an audit/release output
use this limited scope statement:

> isolated schema 5 runtime + versioned backup/restore verified;
> ACTIVE/PAUSED, maintenance unanchored, no operational time authority.

That statement is **not earned by this document or current R1/C1 work**. It is
not converter rollout, maintenance execution, production migration or full PRD
acceptance. Separate production ownership/time, B1, P6 faults, P7 and H1–H3 gates
remain explicit in the current ledger.

## 8. Continuing boundaries and document validation

Defaults remain disabled/paused; expiry, purge and backup cleanup are OFF.
Content/retry/ordinary-audit policy remains 90/7/180 days; backup TTL remains
null/unconfirmed, never an inferred 30-day default. Cleanup is nonexecutable.
No production migration, actual restore/cutover, deletion, listener, public
resource, service/config operation, stage/commit or push is authorized.
The separately completed local MCP dependency repair and existing service are
unaffected and do not become PRD TODO items.

Document validation is UTF-8 without BOM, final newline, balanced fences,
existing relative links and whitespace checks, plus preservation of the plan's
historical order/status/evidence. Planned modules are code references, not
links to nonexistent files. No DB, test or service operation forms part of this
handoff; no runtime acceptance is inferred from document checks.
