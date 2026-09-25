# IM v2 P6 maintenance handoff (NONRELEASE; not implemented)

**Status:** P6-A design approved with incorporated Oracle amendments; future
execution decisions retain their finite implementation prerequisites;
**P6 is not implemented or execution-verified**. Checked HEAD:
`609a97acd1fc78e5393a2e52154be809353df9d6`.
This document records the specification and the Oracle-approved additive
[schema-5/time decision](im-v2-maintenance-schema-v5-contract.md). Exact new
manifest/hash and compatibility record layouts remain implementation gates.
It does not authorize enablement, deletion, deployment, network changes, or a
production operation.

References: [recovery/retention design](im-recovery-retention-v2-design.md),
[P6 implementation plan](im-v2-implementation-plan.md),
[config](../src/im/v2/config.js), [v4 schema](../src/im/v2/schema.js),
[v4 DDL and validator](../src/im/v2/schema-internal.js),
[clock](../src/im/v2/clock.js), [auth](../src/im/v2/auth.js),
[historical schema](../src/im/schema.js),
[P5 activation/release contract](im-v2-recovery-activation-contract.md), and
[P5 release evidence boundaries](im-v2-p5-release-validation.md).
The completed [plan/codec contract](im-v2-maintenance-plan-contract.md) is the
approved P6-A field/API specification. Existing unrelated worktree changes remain
outside this document-only reconciliation.

## 1. Approved sequence and explicit refinements

| Stage | Approved purpose | Required exit / next gate |
| --- | --- | --- |
| A | Pure codecs, offline borrowed-connection bounded preview, configuration-only backup diagnostic | Design approved; implement pure codec first, then prove bounded reads and zero preview writes; implementation/runtime acceptance not done |
| B0 | Approved additive schema 5 and explicit owned-candidate conversion | Reviewed exact DDL/hash, runtime/versioned backup/recovery and time gates before converter rollout or executable maintenance |
| B1 | Separately approved, bounded atomic maintenance execution | B0 complete; exact target/time/authority contracts frozen; independent batch approval |
| C | Process/fault and budget evidence for the actual implementation | Source-bound evidence and review; not hardware-power-loss proof |

These are NONRELEASE development stages, not permission to run maintenance on
real data. A does not acquire a writer by virtue of having an executable-looking
plan. B0 is a prerequisite to B1, not an implicit constructor migration.
Read-only v4 previews come first and report `SCHEMA_UPGRADE_REQUIRED`, never
execution authority. Delivery gates are read-only preview -> schema/converter
-> runtime dispatch -> backup/recovery formats -> time approval -> execution
-> process QA, with a single owner per shared implementation file.

This handoff explicitly refines design §7.2 and the P6 work package:

- The old version-1 plan outline is replaced by the **version-2 top-level order**
  in §4 and the approved nested tables in the plan/codec contract.
- Expire and scrub are distinct approved batches. Scrub selects only content
  already expired before its batch; an expire batch never also scrubs live data,
  even when both gates are enabled.
- Preview never persists a preview run, an approval, or a clock observation.
  Recovery's filesystem plan/completion publication protocol is not reused.
- A moving business clock floor cannot be the maintenance forward-jump anchor.
  Current schema 4 lacks the required independent anchor. Its existing checksum
  must not be replaced with a different schema under the same version.
- Backup cleanup is always a nonexecutable preview in this P6 scope, including
  when a policy or a release marker appears to permit cleanup.

Other P1–P5 semantics remain the local evidence baseline; their historical
checkboxes and reports are not new P6 completion evidence.

## 2. Policy, gates and bounds

The existing ordered retention policy remains:

```text
version, effectiveAt, messageRetentionMs, attachmentRetentionMs,
safeRetryWindowMs, auditRetentionMs, keyReservation, expiryEnabled,
purgeEnabled, backupCleanupEnabled, backupRetentionMs
```

Defaults are content/attachments **90 days** (`7776000000` ms), safe retry
**7 days** (`604800000` ms), ordinary audit **180 days** (`15552000000` ms),
`keyReservation:'indefinite'`, and all three deletion-related gates **false**:
`expiryEnabled`, `purgeEnabled`, `backupCleanupEnabled`.
`backupRetentionMs` is **null / unconfirmed**. Thirty days is not a default or
an inferred authorization. Maintenance does not change `writeMode` or enable
business writes. Config's default remains paused.

Changing an execution gate requires a new canonical policy/hash and the
applicable approval; do not update a referenced policy. A candidate retains its
historical `contentPolicyHash` and stored deadline. The execution policy hash
binds the current policy and its registered record; it does not recalculate or
extend historical deadlines. Existing config rejects purge without expiry and
backup cleanup without a retention duration; satisfying those checks is not
batch approval and does not enable a backup deletion implementation.

| Budget | Default and hard upper bound; callers may only lower |
| --- | --- |
| Business row mutations | 100, counting content/message/attachment/key updates and audit deletions individually |
| Proof rows | At most 2: maintenance run and minimal completion audit |
| Logical scrub bytes | 10485760 (10 MiB) |
| Scan rows / verified scan bytes | 10000 / 104857600 (100 MiB) |
| Scan / writer elapsed time | 1000 ms / 1000 ms, monotonic soft budgets |
| Plan TTL | At most 300000 ms |
| Wall-time deviation from independent anchor projection | At most 86400000 ms (24 hours) |

`maxKeyReservations` still requires a deployment-selected positive safe integer;
there is no automatic capacity choice. Capacity exhaustion blocks new acceptance
without recycling keys, identities, sequences or evidence.

Time values and counters must be nonnegative safe integers (positive where
required); check arithmetic overflow before adding durations. Equality means
expired: `now < expiresAt` is required for a plan or lease to remain valid, and
`now < retryUntil` for a send replay window. A passed content deadline is only
selection eligibility; it does not bypass a disabled expiry gate.

## 3. Approved offline local preview boundary

P6-A has only these approved preview/target APIs (exact details and local
MAINTENANCE_* errors are in plan-contract §10):

```text
createImV2MaintenancePreview({readTarget,authority,policyProvider,clock?})
  -> frozen {previewMaintenance}
previewMaintenance({kind,after?,limit?},ctx)
  -> {plan,planHash,complete,nextCursor}

createImV2MaintenanceReadTarget({db,databasePath}) -> frozen {invalidate}
withMaintenanceReadSnapshot(readTarget,ledger,consume)  // internal composition
```

The target module is `src/im/v2/maintenance-read-target.js`. Private WeakMap
branding admits only its genuine facade. Constructor forms/brand only: no DB
queries, file reads/opens or other factories until authorized use. No operation
path or application-facing SQL/DB reader is exposed. The trusted offline owner
preowns the connection/protected location, opened against the path under rename/
replacement exclusion and retains exclusion for the capability lifetime. It
invalidates before releasing ownership/closing; the target never closes the DB.
This is a trusted preexisting db/path pairing assumption, not a claim that lstat
or database_list can prove the inode of any arbitrary already-open connection.

Only quiescent DELETE journaling with no wal/shm/journal residue, even empty, is
supported. No other connection users/writes/close/reopen/schema operation during
preview; there is no live-runtime owner mode. First authorized use checks native
connection/no external transaction, main filename, protected nonsymlink regular
single-link stable file and actual schema/instance birth/epoch/active relations.
Failed establishment installs no binding; later drift/cookie/epoch change or
invalidation rejects without transparent rebind. Platform protection unavailable
fails MAINTENANCE_READ_UNAVAILABLE with no Windows override. Active v4 with
config.enabled=true permits paused or enabled write modes **only under offline
exclusion**; prepared/verified P5, schema3, journal2 and schema5 are rejected.

BEGIN read snapshot and guaranteed cleanup use a private expiring session of
fixed allowlisted planner reads with the shared ledger. No caller SQL. Reentry,
thenable, caught session fault or cleanup failure poisons outer success. Every
schema/identity/active/policy query is bounded and length-first before variable
metadata/SQL retrieval; reserve bytes, verify the exact v4 manifest/checksum, and
charge final rechecks. No uncharged full assertImSchemaV4 validator. Incomplete
trust gates or their budget exhaustion produce an error without plan/IDs.

`authority.authorize(ctx)` is synchronous literal true before target inspection
or disclosure, and again before return. `policyProvider.getConfig()` supplies a
strict detached full config/policy/hash; snapshot before callbacks and finally
compare again. Known async functions are rejected before invocation; unexpected
thenables are rejected/observed. No paths, raw bodies or provider exceptions leak.
Run IDs are internal with no preview persistence. Kinds map exactly expire ->
expire-only, scrub -> scrub, audit -> audit-delete; purge never alters expire.

No new SQLite/module file open, query_only mutation, journal-mode change, chmod,
checkpoint/VACUUM or raw coordinator-inode open/close occurs. No auth.withRead,
guard.runRead/anchor or private time-highwater ratchet. Zero writes covers logical
DB/clock/run rows, main/sidecar contents and mtimes, file creation/deletion/
replacement, fsync and write SQL; OS atime equality is not promised.

There are **no apply/status stubs in A**. Future execution/status and separate
time administration remain B0/B1 gates. The schema5-approved time inputs are
previewMaintenanceTimeAnchor({},ctx),
approveMaintenanceTimeAnchor({proposal,proposalHash,approvalRef},ctx) and
getMaintenanceTimeStatus({},ctx); their exact factory/adapters/envelopes remain
future freezes. Independent execution approval must bind actual instance birth,
epoch, kind, plan hash/gate and trusted actor identities, and cannot substitute
for time approval. No unspecified writer authority is created by this preview API.

## 4. Plan v2 and canonical evidence

The exact top-level ordered field set is:

```text
{
  version, runId, instanceId, instanceCreatedAt, centerEpoch, kind,
  executionPolicyHash, createdAt, expiresAt, clockObservedAt,
  timeEvidence, selection, candidates, candidateDigest, budget, scan
}
```

`version` is literal `2`. Identity/creation time/epoch come from the actual
target. The plan binds a fixed selection cutoff, internally generated run ID,
historical candidate policies, current execution policy and independent time
evidence. `planHash` is outside the plan; no self-referential hash field is added.

Canonical encoding accepts ordinary data objects in any insertion order, builds
plain objects in the frozen field order and serializes with `JSON.stringify`.
The approved plan hash is lowercase hex SHA-256 of
`ASCII("a2a-msg.im.maintenance.plan.v2") || 0x00 || canonicalUTF8Bytes`.
No BOM, formatting whitespace or trailing newline is part of the encoded
record. Strict decoding rejects unknown fields, wrong types, invalid/null
combinations, duplicate keys/noncanonical encodings and bounds violations;
canonical re-encoding must match the supplied bytes exactly. No silent Unicode
normalization, key sorting or lossy number/string coercion is permitted.

The [approved plan contract](im-v2-maintenance-plan-contract.md) §2–10 fixes the
complete nested timeEvidence, selection/cursor, candidate/held, budget/scan and
envelope tables, typed F/T framing and domain-separated candidate/range hashes.
Its decoder rejects noncanonical byte order; its encoder constructs canonical
order rather than rejecting an ordinary object's insertion order. All successful
v4 previews have null anchor/session fields, executable=false and upgrade reason
regardless of gates. Pure future-v5 shape validation grants no v5 source support
or private session. The five exports in maintenance-plan.js are approved for
pure-codec implementation first; independently checked literal vectors remain
implementation evidence, not an unresolved design approval.

The complete ordered candidate digest must cover these actual persisted facts:

| Evidence group | Required coverage |
| --- | --- |
| Message | Immutable ID, conversation, sender/recipient routing, storage client key, reply relationship, acceptance time; actual text/title/correlation hashes and UTF-8 lengths with explicit null distinctions |
| Content | State, historical policy hash, deadline, expired/scrubbed timestamps and run bindings |
| Send key | Immutable sender/client key and message binding, original payload fingerprint, created time, retry deadline, status |
| Operation mapping | Sender, origin epoch, wire client ID, storage client ID, source protocol, message ID |
| Attachment reservation | Presence/absence, attachment/message IDs, historical size and hash |
| Live payload | Presence/absence, IDs, name/mime evidence, declared size/hash, actual BLOB byte length and actual SHA-256 |
| Delivery | Recipient, sequence, message binding, actual ACK and read values |
| Audit candidate | ID, action, actor kind/ID, occurred time and exact target/details evidence sufficient to detect any row change |

No raw body or attachment bytes are included in the plan. Stored hashes alone
are insufficient while content exists: verify actual content/BLOB bytes and
their metadata before approving their fingerprints. Do not reconstruct or
replace a historical send fingerprint from scrubbed empty fields. Missing,
extra or inconsistent key/mapping/reservation/payload/delivery facts reject the
group; a JOIN silently omitting a required row is not a valid candidate.

`candidate_json` has the current SQL bound **2..65536 characters** and must
remain valid JSON. This is separate from UTF-8 metadata byte limits, candidate
count, scan bytes and logical scrub bytes. SQL `length(TEXT)`, JavaScript UTF-16
length, and UTF-8 byte length are not interchangeable. Plan, standalone metadata
and serialized preview envelope each have an additional 65536-UTF-8-byte ceiling;
enforce the candidates' independent SQL character bound too. Test multibyte input
rather than equating characters and bytes. Future persisted result/proof formats
remain §10 gates; `result_json` retains its existing JSON character bound.

## 5. Indexed selection and bounded complete batches

Selection uses one read snapshot and one fixed cutoff. The logical query
predicates and stable key orders are fixed:

| Kind | Predicate | Strict ascending keyset order / existing index |
| --- | --- | --- |
| expire | `state='live' AND expires_at <= cutoff` | `(expires_at,message_id)` / `im_content_expiry` |
| scrub | `state='expired' AND scrubbed_at IS NULL AND expires_at <= cutoff` | `(expires_at,message_id)` / `im_content_scrub` |
| audit | `occurred_at <= cutoff - 15552000000` | `(occurred_at,id)` / `im_audit_occurred` |

An `after` key is exclusive. Guard subtraction when the audit cutoff is younger
than 180 days; do not create a negative SQL time. Ordinary audit eligibility is
an exact allowlist: **`conversation.created` and `message.read` only**. Unknown,
security, governance, migration, recovery, activation, backup provenance,
maintenance, accepted-message, ACK, expiry-receipt and lease evidence is retained.
Filtering protected actions still consumes the scan budget; it cannot trigger
an unbounded search for deletable rows. Maintenance/recovery/migration run
records and completion proofs are not ordinary audit candidates.

Project IDs, lengths and row costs before bounded content reads. Count actual
UTF-8 text/title/correlation/name/mime bytes plus actual BLOB length. Fetch and
hash at most **one BLOB at a time**; no whole-DB hash, unrestricted materialized
join or backup operation belongs in a maintenance scan/write transaction.
Exact SQL, projections, bounded lookahead and accounting follow plan-contract
§5–9, including length-first schema/identity/active/policy checks;
index names alone do not prove bounded query plans.

A message and all its affected attachment/key/content rows form an indivisible
group. Never split a group or pack later groups after a remainder-budget stop.
An intrinsically oversized group is fully fingerprinted as held and advances
the classified range/cursor, with its retained outcome in the digest. A 10 MiB
attachment plus its nonempty filename already
exceeds the 10 MiB logical scrub budget: hold the entire group as
`OVERSIZED_GROUP`; there is no automatic exception or raised budget.

Distinguish two outcomes:

1. **Complete bounded batch:** normal row/byte/metadata batch limits stop at a
   verified group boundary, with a bounded lookahead and `nextCursor` if work
   remains. `complete:true` means this fixed batch is fully verified, not that
   the entire database has no further eligible work. Enabled gates, valid time
   evidence and independent approval remain necessary to execute it.
2. **Budget-incomplete batch:** scanning/time/verification cannot finish the
   required range. Return explicit complete=false evidence; the plan cannot be
   applied. Fully classified held outcomes can instead belong to a complete
   bounded batch (including all-held pages) and advance the cursor without
   authorizing their deletion. Trust-gate budget failure is an error without IDs.

At apply, re-enumerate the **approved fixed batch range** in its original order,
using the approved cutoff and boundary keys. Compare the entire ordered set and
full pre-fingerprints before the first mutation. Reject additions, deletions,
reordering, changed metadata/content or altered eligibility within that range.
Never extend the range to include newly eligible or newly inserted candidates
outside it. The approved plan contract fixes empty/end representation and requires
exhausted-suffix rechecking: a new row in a previously exhausted suffix is stale.
Do not rerun a fresh `LIMIT` query and call its different result approved.

## 6. Independent maintenance time anchor (B0 prerequisite)

The approved schema-5 contract fixes additive anchor-history, head and schema
transition tables, constraints, proposal/timeEvidence field order and explicit
candidate migration behavior. Anchor evidence binds actual instance identity,
creation time and epoch. Exact DDL bytes/checksum and anchor-evidence camelCase
hash field order remain to be generated/frozen; the table column order is not
an approved hash preimage. No code or runtime acceptance is claimed.

Current v4 contains the global `im_clock.last_observed_at` and maintenance run
records, but no adequate independent anchor storage. Do not hide the anchor
inside policy JSON, audit JSON, arbitrary maintenance JSON or `im_clock`.
Only an exclusive paused owned recovery/bootstrap candidate may explicitly
convert before its new prepare plan; migration creates no anchor. Preserve
schemas 1–4 DDL/checksums, exact existing v4 exports and fresh4/v3import4 APIs,
legacy center 3, wire v2 and journal 2. No same-version checksum overwrite,
global 4-to-5 replacement, downgrade or implicit auto-migration is permitted.

For new execution, trusted wall time must be a nonnegative safe integer and:

- be at least the persisted business global floor and process-local highwater;
- agree, within the lowered maximum 24-hour deviation, with
  `anchorWall + monotonicElapsed` from this process's approved anchor;
- satisfy plan TTL, policy effective time and all relevant deadline checks,
  including a final sample immediately before commit.

Reject backward time, unsafe arithmetic, invalid/regressing monotonic samples,
or excessive deviation. Business global-floor advances must **never refresh**
the maintenance anchor. Thus a large forward jump previously observed by a
business read/write cannot be washed out by comparing maintenance against that
already-raised floor. Preview observations neither accept the jump nor ratchet
the anchor/highwater.

A new process may read evidence and diagnose state, but cannot reuse another
process's private monotonic origin. Its writer requires a **separately approved
reanchor**. Reanchor invalidates old plans and binds the old generation/hash,
actual instance/epoch, exact proposed time and approved admissible range. Verify
the final trusted sample against that proposal/range; do not approve one time
and install another. No clamping to the floor, floor drop or implicit restart
reanchor is allowed. Deletion approval cannot repair a stale time anchor.

Time approval atomically inserts anchor/head and updates the global floor;
rejected approval writes none of those, though private highwater may advance.
Its private baseline is installed only after acknowledged commit using the
final precommit monotonic sample. Exact completed-approval retry or uncertain
commit read resolution cannot mint a session. Restart requires a new nonce,
proposal and approval; new recovery epochs do not inherit head authorization.

The approved time proposal TTL is at most 300000 ms and its lower-only acceptance
window at most 5000 ms, beginning at the actual candidate wall sample, without
clamping. Native sampling/adapters and exact codec envelopes remain unimplemented.
For maintenance execution (distinct from time approval), any global-floor
persistence on rejection still requires explicit transaction/error semantics;
it cannot retain partial business deletion or hidden completion evidence.

## 7. Future B1 atomic apply, retry and status (no P6-A exports)

The required execution order is:

1. Snapshot/strictly validate inputs and obtain literal-true admin authority.
   Read the actual bound target and inspect durable completion by run ID/hash.
2. **Exact completed retry precedes new time, TTL or new-execution approval
   checks.** Match the original plan, hash, approval binding, target and stored
   completion result. Return that same persisted result, with no new clock
   observation/write, audit, mutation or run. Conflicting run/hash/input/result
   evidence rejects; a hash hit alone cannot adopt another run. Current admin
   authorization is still required before disclosing the result.
3. For a new execution, require a complete approved plan and validate actual
   identity/epoch/schema, current policy, relevant gates, valid anchor, fresh
   time, TTL, limits and independent batch approval before taking the write
   transaction. Disabled gates give zero business changes.
4. Inside `BEGIN IMMEDIATE`, revalidate those bindings and authorities against
   the locked state. Re-enumerate the fixed range and verify **every** candidate's
   complete pre-fingerprint, including the last candidate, before any mutation.
5. Insert the run before its content FK references; perform the exact approved
   business changes and write completed run/result plus minimal completion
   audit in the **same atomic transaction**. No separately committed preview,
   approval or in-progress run is required for this protocol.
6. Recheck final admin/approval authority, current policy/gates, epoch/anchor,
   final trusted time/TTL and measured budgets before commit. Any failure rolls
   back every business and completion change. No successful prefix of a batch
   may be retained. Global-floor exception semantics, if any, follow §6's
   explicitly frozen contract and do not retain deletion/proof prefixes.

Do not call existing anchoring guards and assume they already enforce this
order or independent time evidence. Soft elapsed limits are checked between
iterations/statements; a SQLite call already running is not promised a hard
interrupt or 1000 ms real-time deadline.

| Operation | Permitted changes | Required retained facts |
| --- | --- | --- |
| expire | Content becomes expired with time/run binding; send-key status becomes expired | Actual payload, original key/fingerprint/retry deadline, operation mapping, message/delivery skeleton, reservation, ACK/read |
| scrub | Only already-expired unscrubbed content: delete its live attachment payload row, set text to empty string and title/correlation to null, record scrub time/run | Reservation and historical hash/size, original send fingerprint/key/mapping, routes/reply/acceptance, skeletons and real ACK/read |
| audit | Delete only individually approved eligible allowlisted rows | All protected/unknown actions, run records and minimum completion evidence |

Expiry does not fabricate an expiry receipt, ACK, delivered time or read time.
Receipt processing belongs to the existing authenticated delivery protocol.
Scrub does not write a zero-size/empty-BLOB attachment placeholder; the existing
payload CHECKs require deletion of the payload row while the reservation stays.
Neither retry-window expiry nor content scrub makes a send key reusable.

Status is a read-only lookup of **persisted completed/done run evidence** or
**not-recorded** for a preview/uncommitted run. The stored enum remains
`completed`; “done” describes the observation, not a new DB state. No in-memory
preview map, filesystem completion marker or recovery-style extra completion
protocol is authoritative. Exact external status/result shapes (including the
old outline's `replayed` field) must be frozen so retry returns the same stored
result rather than synthesizing a conflicting result. Malformed, mismatched or
unexpected legacy run states fail closed instead of being reported completed.

Logical content clearing is not secure erasure. This work authorizes no VACUUM,
WAL purge, checkpoint-based cleanup, filesystem snapshot deletion, client GC or
recovery overwrite of accepted data.

## 8. Configuration-only backup diagnostic

The approved independent factory is
`createImV2BackupCleanupPreview({authority,policyProvider}) -> frozen {previewBackupCleanup}`;
its only method is `previewBackupCleanup({},ctx)` with strict empty input. The
exact ordered result is fixed in plan-contract §11:

```text
{version:1,scope:"configuration-only",executable:false,
 configuredBackupRetentionMs:null|positiveSafeInteger,backupRetentionMs:null,
 reasons:["BACKUP_TTL_UNCONFIRMED","BACKUP_DELETE_UNAVAILABLE",
          "REGISTRY_ENUMERATION_UNAVAILABLE"],
 protectedRefs:[],complete:false,nextCursor:null}
```

The configured value is read from a validated actual trusted full configuration;
it is not adopted deletion policy. Null business-approved TTL remains unconfirmed
even if configured TTL is positive. Thirty days is not a default. Admin/config
snapshot validation and final rechecks follow the content planner; no target/DB
effective-time comparison is invented. This diagnostic is independent of target
implementation and may follow common pure validation.

No registry, folder, lock or store is accessed/constructed, no cursor/limit or
registry input exists, and no backup count/latest/protection claim is made.
Empty protectedRefs means not enumerated, not none protected. Existing registry/
checkCleanup remain unchanged and allowed:false; no deletion adapter is added.
Genuine enumeration, hold/provenance verification, deletion and status after
source loss remain separate future gates. A released marker alone is never
terminal/deletion authority; archived-source semantics are not invented here.

## 9. Required future evidence (not run for this document)

| Area | Required meaningful evidence |
| --- | --- |
| Pure/default OFF | P6-A factory/preview denied, error, budget and success paths perform zero logical DB/clock/run or main/sidecar-content/mtime changes, file creation/deletion/fsync/write SQL; no hidden anchor; OS atime excluded. No apply/status stubs. Future B1 status has separate evidence |
| Date equality | Content and audit cutoff equality eligible; plan/lease/retry equality expired; safe arithmetic/overflow, empty early audit interval and lowered TTL |
| Time trust | Backward and large-forward jumps; business-floor washout attempt; no preview ratchet; monotonic failures; restart diagnosis followed by mandatory reanchor; stale generations; reanchor proposal/final-sample mismatch |
| Canonical binding | Object encoder accepts insertion-order permutations, decoder rejects noncanonical bytes; typed F/T hash/null-vs-empty/signed audit IDs; policy/instance/epoch mutation, multibyte byte-vs-character bounds; fixed-range changes and exhausted-suffix insertion stale |
| Atomicity | Fault at each transaction boundary and between groups; last-candidate verification fails before mutation; approval/admin revocation at final check; budget failure rolls back all business/proof rows |
| Group limits | Actual changed business rows <=100 plus <=2 proof rows; no phantom key update: 33 three-row already-expired scrub groups cost99. Whole10MiB+metadata group held with digested cursor progress; no partial clear or remainder-budget packing; effect fixed by kind |
| Evidence preservation | Logical expiry retains bytes; scrub removes payload but retains reservation/routes/key/fingerprint/ACK/read; no key reuse after seven days; protected/unknown audits and legacy evidence retained |
| Retry/status | Lost response after commit returns exactly persisted result before time/TTL checks, with zero new clock/audit; mismatched retry conflicts; preview or precommit failure remains not-recorded |
| Process faults | Real SIGKILL before/after commit and process restart; committed run/business/audit agree, uncommitted group changes absent; bind source tree, native platform, command and exit status |
| Bounded work | Length-first schema SQL/identity/active/policy metadata, reserve before retrieval and no uncharged full validator; trust-budget failure errors without IDs. Indexed EXPLAIN, repeated row/byte/lookahead/framing charges, one BLOB maximum, complete held pages vs incomplete scan; no hard-interrupt claim |
| Offline target | No constructor/pre-admin inspection; fake/invalidated/changed connection/file/cookie/epoch rejected, failed establishment no binding; DELETE-only and any sidecar residue rejects, no Windows override; session expiry/reentry/thenable/caught faults poison outer and cleanup cannot succeed falsely |
| Backup diagnostic | Strict empty request and exact configuration-only DTO; actual null/positive configured TTL never adopted; zero registry/folder/lock/store/DB/clock access, no enumeration or protection claims |
| Excluded systems | Old LAN/legacy schema and APIs, journals, previous accepted facts and original backups are unaffected by the maintenance implementation; no implicit migration/enablement |

P5's existing process-kill evidence is not hardware power-loss proof. Native
Windows strict protection gates remain fail-closed/unsupported where currently
required; skipped strict-platform cases are not passes. New evidence must be
bound to the actual reviewed source and cannot be assembled from unrelated
historical passing runs. This document supplies no source-test/runtime evidence.

## 10. P6-A closure and finite future execution freezes

The parent has received the schema-impact map and Oracle's additive schema-5
decision, recorded in the schema-5 contract. The table distinguishes approved
decisions from finite encoding/implementation gates; implementers must not fill
remaining future gaps with permissive defaults. P6-A's completed plan-codec
contract is approved with the Oracle amendments and ready for pure-codec
implementation; this does not claim code or runtime acceptance.

| ID | Exact remaining freeze | Blocks |
| --- | --- | --- |
| S1 | **Approved:** additive schema 5, three tables and constraints, strict validated 4/hash or 5/hash dispatcher; historical 1–4 immutable. **Remaining:** exact expanded DDL/manifest and generated V5 golden hash; canonical anchor-evidence field table/chain vectors | B0 implementation and every writer |
| S2 | **Approved:** exclusive paused owned candidate, before new prepare; atomic conversion preserves business/identity/epoch/policy and creates no anchor; opt-in fresh/import via P1-to-4; no downgrade or seal reuse. **Remaining:** exact migration API, conversion plan/proof/pre-post hash fields, retry/conflict result and bounded validator | B0 converter implementation; rollout also requires S3 |
| S3 | **Approved:** v4 formats untouched; v5 manifest3/registry4/native-v5/sourceEvidence2/coherent new P5 family/seal2, source and target schema binding. **Remaining:** precise new record/tag/phase-digest tables and head reset; runtime dispatch, version-aware hold verification and converted5 backup/register/restore/verify/active-paused evidence before rollout | Runtime/backup/recovery compatibility gate |
| T1 | **A approved:** offline borrowed-target constructor/invalidate and internal withMaintenanceReadSnapshot, private branding, exclusion/lifetime, DELETE-only, length-first trust gates, active4 scope and poison/cleanup rules in plan §10.3. **Remaining:** implementation evidence; a future B1 writer target/BEGIN IMMEDIATE ownership API is not supplied by A | A readTarget acceptance; B1 executor design/implementation |
| T2 | **Approved:** safe `acceptedWall+monotonicElapsed`, absolute deviation bounded by lowered 24h, no business-floor refresh, acknowledged-commit baseline from final precommit sample; rejected time approval has no persistent writes. **Remaining:** exact native sampling adapter/units/rounding and maintenance-execution rejection semantics | Time implementation and B1 |
| T3 | **Approved:** three time operations and proposal order/domain hash, paired previous head, new process nonce, <=300000ms TTL/<=5000ms window, independent actors, atomic approval and no-session-mint retry. **Remaining:** factory/adapter signatures, response/status/error fields, generation allocation and epoch-reset predecessor encoding | B0/B1 time administration |
| C1 | **A approved:** exact timeEvidence shape, diagnostic precedence/error fallback in plan §4; v4 always false/upgrade, all anchor fieldsnull. Golden vectors and implementation evidence remain; private future-v5 time authority is not a pure-codec capability | A implementation/verification; future time runtime gates |
| C2 | **Approved:** selection/cursor scope, fixed lower/upper range, empty/end and exhausted suffix, lookahead/held cursor progression, duplicate/size bounds in plan §5/9 | A implementation/evidence, no open codec design gate |
| C3 | **Approved:** candidate summaries, full original-fact typed F/T frames, NULL/absence, actual text/BLOB hashes, range/candidate domain preimages in plan §3/6/7 | A implementation and independent literal vectors |
| C4 | **Approved:** budget/scan tables, actual no-op-aware business rows, full scan/framing cost, length-first trust metadata, exact keysets/lookahead and separate byte/character caps in plan §5/8/9 | A implementation/evidence; future writer revalidation |
| C5 | **A approved:** preview envelope and safe local errors. **Remaining B1:** persisted candidate/result projection, approved-batch-hash meaning, completion audit/details, executor attribution, exact retry tuple/replayed/status and empty-run semantics | B1 persistence/status only; no A stubs |
| A1 | **A approved:** authority.authorize(ctx), policyProvider.getConfig(), synchronous strict snapshots/final rechecks in plan §10/11. **Remaining B1:** approvalAuthority/actor binding and exact execution gate/revocation adapter records | A implementation evidence; B1 approval design |
| A2 | **Approved:** configuration-only factory/empty input/exact DTO in plan §11; no registry capability/precursor, no enumeration or deletion. Future genuine enumeration/deletion/source-gone status are separate gates | A independent config diagnostic implementation/evidence |

The remaining freezes do not reopen the approved 90d/7d/180d policy,
100-business-row-plus-two-proof-row limit, 10 MiB group rule, independent-anchor
requirement, or preview-only backup boundary. Approved schema constraints and
time-operation inputs are specifications, not existing modules. No generated
V5 hash, fully frozen new P5 family or implemented consumer API is claimed.

## 11. Operational gates and document-only delivery

- **H1:** actual source isolation, recovery/RPO/auth review, activation and
  cutover remain human operational approvals.
- **H2:** expiry/purge enablement, each physical deletion batch, backup TTL/window
  and deployment capacity decisions remain separate human approvals.
- **H3:** TLS/listener, DB/config location, platform deployment, external
  network/DNS/resources/costs remain separately approved operations.
- **P7:** real external-network integration remains pending. Local development
  and P5 evidence do not grant it.

This final reconciliation reads and edits only the three maintenance handoff,
plan-codec and schema5 contract documents. Verification is limited to HEAD,
UTF-8 without BOM/final newline, relative existing links, fences and whitespace.
No source edits, runtime tests, production
DB/config access, service operations, commits or pushes form part of this
handoff. No SyberMem initialization or automatic knowledge binding is created.
