# B0.3 isolated maintenance time engine (NONRELEASE)

**Parent-accepted Oracle specification; document-only implementation appendix.**
Checked committed HEAD: `cc5bed7bb18eac36ee3cc2a412ac47fb29c1b96e`.
This freezes the bounded internal implementation assignment, not implementation,
runtime acceptance, production ownership, migration or activation permission.

Read with the [schema-v5 contract](im-v2-maintenance-schema-v5-contract.md),
[maintenance handoff](im-v2-maintenance-contract.md),
[plan/timeEvidence contract](im-v2-maintenance-plan-contract.md), and
[conversion ownership/engine contract](im-v2-recovery-conversion-contract.md).
This appendix refines the earlier B0.3 target/sampler wording. B0.1 storage,
checksums, five-kind codecs and B0.2 history remain unchanged.

## 1. Scope and committed reference points

The goal is an isolated internal time engine over a legally constructed synthetic
schema-5 database. It is neither a recovery extension nor production composition.
Its test owner is planned at `tests/fixtures/im-v2-maintenance-time/owner.js`:
construct genuine legal synthetic v5, **close the construction connection**, then
retain exclusive file and protected-location ownership for the engine lifetime.
An ACTIVE fixture must satisfy the full inherited activation/recovery relations;
changing a status label alone does not produce a legal fixture.

| Committed reference | Relevance, not additional authority |
| --- | --- |
| [schema-v5-internal.js](../src/im/v2/schema-v5-internal.js) | Exact v5 DDL/manifest/checksum, inherited validation, transition reconstruction and database-wide anchor chain; supports standalone `{limits,tick}` composition. Its manifest scope is IM names/owners, so the engine additionally needs a whole-database object allowlist. |
| [schema-v5.js](../src/im/v2/schema-v5.js), [schema-dispatch.js](../src/im/v2/schema-dispatch.js) | Existing exact version validation exports; no time capability is conferred by their success. |
| [maintenance-v5-records.js](../src/im/v2/maintenance-v5-records.js) | Existing three pure exports and five canonical kinds; unchanged record bytes, orders, domains and codec errors. |
| [schema-internal.js](../src/im/v2/schema-internal.js) | Historical v4 DDL/checksum and inherited business/active relations remain the validation baseline. |
| [maintenance-read-target.js](../src/im/v2/maintenance-read-target.js) | Borrowed read-only v4 capability is not an owned-v5 writer target. Its path/native/protection observations are references, not a reusable ownership certificate. |
| [recovery-records.js](../src/im/v2/recovery-records.js) | Native strict ancestry, private directory, nonsymlink single-link identity checks; no Windows protection override or fabricated recovery-budget identity. |
| [recovery-candidate.js](../src/im/v2/recovery-candidate.js), [migration-v5.js](../src/im/v2/migration-v5.js) | Standalone/sidecar and unresolved-close precedents; their recovery path-taking resources and conversion engine are not B0.3 target authority. |

### Scope checklist

- [x] Freeze one isolated engine, native time, private provenance, fixed approval
  transaction and descriptive DTOs in this document.
- [x] Require synthetic ACTIVE v5 with PAUSED write mode and full valid inherited
  relations; legitimate historical anchor chain without a head is permitted.
- [x] Exclude enabled, prepared, verified and real production targets. SQL values
  remain the existing lowercase `active` and `paused`.
- [x] Exclude **both unfinished and completed conversion candidates**. Anchor
  writes would invalidate the completed conversion's closed-file posthash; a
  completion record is not a handoff to this engine.
- [x] Exclude all backup, recovery and conversion workflows from the harness-owned
  target lifetime; retain existing B0.1/B0.2 records and operational boundaries.
- [x] Expose no barrel/server/MCP/CLI/recovery-facade wiring, converter-readiness
  claim, P6 executor, deletion, generic callback registrar, DB handle, SQL executor,
  transaction-extension API or public clock setter.
- [ ] Implement and independently verify the bounded source/test package.
- [ ] Separately design/approve production ownership integration and complete
  runtime, backup and recovery compatibility gates before any operational use.

No migration, compensation script, repair, rollout switch or implicit live-v5
activation path is supplied. Historical callers/configuration/records retain
their existing behavior. Fault rollback here concerns only the engine's own
active transaction; production rollback is not an operation in this package.

## 2. Exact module and call surfaces

Planned `src/im/v2/maintenance-time-internal.js` owns the target and authority
WeakMaps, private connections, pending proposal, session and fixed transaction.
It has **exactly three exports**:

```text
openIsolatedMaintenanceTimeTarget({databasePath,limits})
  -> frozen {invalidate,close}
createMaintenanceTimeAuthority({target,authority,approvalAuthority,executorId,limits})
  -> frozen {previewMaintenanceTimeAnchor,approveMaintenanceTimeAnchor,getMaintenanceTimeStatus}
checkMaintenanceTimeSession(timeAuthority,{},ctx)
  -> frozen existing timeEvidence
```

Planned `src/im/v2/maintenance-time-authority.js` **only reexports**
`createMaintenanceTimeAuthority`. No extra export or recovery session extension
is authorized. The checker delegates to module-private authenticated logic; it
is not a callback-taking transaction wrapper.

| Call | Exact arguments / receiver | Exact ordered success result |
| --- | --- | --- |
| `openIsolatedMaintenanceTimeTarget` | One exact `{databasePath,limits}` | Frozen target with keys `invalidate,close` |
| `createMaintenanceTimeAuthority` | One exact `{target,authority,approvalAuthority,executorId,limits}` | Frozen three-operation facade in the order above |
| `target.invalidate()` | Zero arguments, genuine target receiver | Returns `undefined`; valid repeated invalidation is idempotent; lifecycle effect in §3 |
| `target.close()` | Zero arguments, genuine target receiver | Successful closure returns `undefined`; positively confirmed closed target repeats are idempotent with no I/O; lifecycle effect in §3 |
| `previewMaintenanceTimeAnchor({},ctx)` | Exactly two arguments, genuine authority receiver | Frozen `{proposal,proposalHash}` |
| `approveMaintenanceTimeAnchor({proposal,proposalHash,approvalRef},ctx)` | Exactly two arguments, genuine authority receiver | Frozen `{anchor,anchorHash,replayed,sessionEstablished}` |
| `getMaintenanceTimeStatus({},ctx)` | Exactly two arguments, genuine authority receiver | Frozen ordered status in §5 |
| `checkMaintenanceTimeSession(timeAuthority,{},ctx)` | Exactly three arguments; actual WeakMap-authenticated authority | Frozen ordered `timeEvidence` in §9 |

Options, limits, operation inputs and adapter result/binding records are strict
ordinary objects with exact enumerable own data fields. Reject Proxies **before
reflection**, accessors, symbols, unknown/missing/nonenumerable fields and
nonordinary objects. No coercion or caller-owned mutable alias survives input
capture. Snapshot operation inputs and canonical proposal bytes **before any
callback**. Canonical field order is constructed from valid data, not inferred
from the caller's insertion order. Returned evidence is detached and deeply
frozen. Context is passed to the trusted adapters; it supplies no target, clock,
nonce, baseline, DB or limit authority.

Known async/generator functions refuse before their prefix executes. Unexpected
promises/thenables latch poison **before observation**; refusal cannot extend the
operation lifetime. Refuse accessor-thenables without evaluating the getter.
Observe unexpected rejections safely without treating resolution as approval.
Callback faults, falsy/hostile throws, invalidation, reentry, caught inner faults
and late cleanup faults cannot be swallowed into outer success. Classify foreign
errors only after latching the fault and without invoking foreign getters or
exposing their text/cause.

## 3. Target provenance, admission and lifetime

`databasePath` is supplied solely by trusted test composition which already owns
the closed isolated synthetic v5 file and protected location. It is **not a
certificate of arbitrary production ownership**. The harness excludes all other
connections/users/writers, schema operations, rename/replacement, aliases and
backup/recovery/conversion work for the complete capability lifetime. Path,
`lstat` or SQLite filename observations alone cannot establish that exclusion.

The constructor checks native-supported private ancestry and protected directory,
nonsymlink regular file, single link, stable identity and absence of `-wal`,
`-shm` and `-journal` sidecars, **including empty files**. Open only the existing
file, never create it. Own the native connection privately for the lifetime;
require DELETE journaling, foreign keys ON, synchronous FULL, busy timeout 0 and
no external transaction. Connection-local initialization occurs only at open.
Do not switch journal mode, alter schema/policy/write mode or mutate data during
construction. Native strict protection unavailable means refusal, including on
unsupported Windows environments; document checks there are not runtime support.

Before branding, run full v5 validation in the actual snapshot plus a bounded
**whole-database object allowlist**. Only the exact v5 objects and their required
SQLite automatic objects are allowed; inspect main and temporary schema objects
and exclude non-IM side-effect triggers and other objects the IM manifest ignores.
Do not adopt an extra object because it has a non-IM name. Validate complete
inherited relations, actual ACTIVE/PAUSED
state and conversion-transition history; marker/checksum alone is insufficient.

Bind and recheck file `dev/ino`, protected directory/ancestry identity, genuine
native connection, schema cookie, version/checksum, instance ID/birth, current
epoch, ACTIVE/PAUSED facts and separate head/tip. Unexpected identity, epoch or
schema-cookie drift permanently stales the target; never transparently rebind.
Head changes may be adopted only from this engine's acknowledged or reconciled
fixed transaction. Unexpected tip/head changes are not an external reanchor.
Epoch drift never clears the head automatically.

Only **one authority per target** is allowed; a second factory call refuses.
Copies, proxies, P6-A read targets, recovery conversion targets and decoded
records cannot pass either private WeakMap. Restart creates a new generation;
persisted nonces never restore a private session or pending registration.

Both lifecycle methods revoke pending proposals and sessions and poison any
active operation. `invalidate()` must not reentrantly close a connection.
`close()` closes only the owned connection outside an operation; an in-operation
attempt cannot disrupt a live native frame or yield outer success. Unresolved
closure retains the resource privately, reports durability uncertainty and
permits no replacement connection while unresolved. A close response exception
is resolved only by positively establishing native `isOpen === false`; a thrown
error or pathname does not prove closure. Release harness ownership only after
safe closure. The exact lifecycle success-return/repeated-close convention is
not inferred from a different target's API; see §12.

## 4. Exact limits and one shared budget

Every target limit below is required, positive, safe-integer, rejects `-0`, and
is lower-only. There are exactly six fields, no default/optional limit fields:

| Target field, in specified order | Hard maximum |
| --- | ---: |
| `maxMessages` | 10000 |
| `maxVerifiedContentBytes` | 104857600 |
| `maxOtherRecords` | 10000 |
| `maxElapsedMs` | 10000 |
| `maxMaintenanceAnchors` | 10000 |
| `maxMaintenanceMetadataBytes` | 10485760 |

Authority limits contain **the same six required fields**, each no greater than
the target's configured ceiling, followed by these three required positive safe
integers (also reject `-0`):

| Additional authority field | Hard maximum |
| --- | ---: |
| `proposalTtlMs` | 300000 |
| `acceptanceWindowMs` | 5000 |
| `maxForwardJumpMs` | 86400000 |

TTL need not exceed the acceptance window. Wall and monotonic TTL are separate
strict checks, even when the inclusive acceptance window remains open. No
operation-level limits, budget or time adapter exists.

Start one `performance.now()` deadline before callbacks or reads and retain it
through validation, fixed follow-up reads, encoding, capacity checks and cleanup.
Pass the supported trusted standalone v5 parent `{limits:six,tick}`; do not forge
a recovery budget, add filesystem caps or reset the parent's start. Full v5
validation occurs in the actual operation snapshot with that shared deadline.
Supplementary validator timing cannot replace or extend it. Status/replay may
sample this independent budget timer, which is not authority time observation.

Use capped counts and length-first metadata/content projections before fetch or
allocation. Charge follow-up facts, canonical proposal/anchor bytes and new
anchor row/metadata capacity **before writing**. Include a final deadline tick
before fixed writes and before COMMIT; neither can call an arbitrary provider.
Native calls are soft-budgeted between calls, not interruptible deadlines.
Elapsed, row or verified-content exhaustion maps to `MAINTENANCE_READ_UNAVAILABLE`;
metadata exhaustion maps to `MAINTENANCE_METADATA_LIMIT`. Existing schema
validators retain their fixed errors; engine accounting must preserve this
public distinction without reading foreign exception text.

## 5. Exact records and DTO fields

Types retain the existing codec meanings: `U` canonical lowercase UUID; `H`
64 lowercase hex; `N` nonnegative safe integer excluding `-0`; `N+` positive safe
integer; `Ref` well-formed string of 1..255 UTF-16 units with no C0/DEL controls.
Null means explicit null, never omitted. Booleans are literal booleans.
All records below have exactly the table order, no extensions.

### 5.1 `timeProposal` (existing codec, unchanged)

| # | Field | Type / binding |
| --- | --- | --- |
| 1 | `version` | Literal 1 |
| 2 | `instanceId` | U, actual instance |
| 3 | `instanceCreatedAt` | N, actual birth |
| 4 | `centerEpoch` | U, current epoch at registration |
| 5 | `previousGeneration` | N+ or null, history tip, not head |
| 6 | `previousAnchorHash` | H or null, paired with previous generation |
| 7 | `sessionNonce` | U, freshly generated and privately registered |
| 8 | `proposedAt` | N, single preview wall sample |
| 9 | `proposalExpiresAt` | N, checked `proposedAt + proposalTtlMs` |
| 10 | `candidateWallAt` | N, equals `proposedAt` |
| 11 | `acceptNotBefore` | N, equals `candidateWallAt` |
| 12 | `acceptNotAfter` | N, checked `candidateWallAt + acceptanceWindowMs` |
| 13 | `globalFloorObservedAt` | N, actual preview floor |
| 14 | `maxForwardJumpMs` | Positive safe integer, configured lowered bound <=86400000 |

`proposalHash` is SHA-256 of UTF-8 `im-maintenance-time-proposal-v1\n` followed by
canonical proposal bytes; `\n` denotes one newline byte. The preview envelope
contains exactly `proposal,proposalHash`, with no version or replay field added.

### 5.2 `anchorEvidence` (existing codec, unchanged)

| # | Field | Type / binding |
| --- | --- | --- |
| 1 | `version` | Literal 1 |
| 2 | `instanceId` | U, actual instance |
| 3 | `instanceCreatedAt` | N, actual birth |
| 4 | `generation` | N+, history tip + 1; first is 1 |
| 5 | `centerEpoch` | U, approved actual epoch |
| 6 | `previousGeneration` | N+ or null, exact historical predecessor |
| 7 | `previousAnchorHash` | H or null, paired exact predecessor |
| 8 | `proposalHash` | H, canonical original proposal hash |
| 9 | `sessionNonce` | U, registered proposal nonce |
| 10 | `proposedAt` | N, original proposal |
| 11 | `proposalExpiresAt` | N, original proposal |
| 12 | `candidateWallAt` | N, original proposal |
| 13 | `acceptNotBefore` | N, original proposal |
| 14 | `acceptNotAfter` | N, original proposal |
| 15 | `acceptedWallAt` | N, final accepted native wall sample |
| 16 | `globalFloorObservedAt` | N, original preview floor, never replaced |
| 17 | `globalFloorAtApproval` | N, actual locked approval floor, >= observed floor |
| 18 | `maxForwardJumpMs` | Original proposal's configured lowered bound |
| 19 | `approvalRef` | Ref, approved reference |
| 20 | `executorId` | Ref, configured executor |
| 21 | `approverId` | Ref, resolved actor distinct from executor |

`anchorHash` uses UTF-8 `im-maintenance-time-anchor-v1\n` plus canonical anchor
bytes. Reconstruct both hashes with the unchanged codec; the observed floor and
approval floor are distinct facts. Retain the existing 65536-UTF-8-byte record
ceiling, exact canonical decoding, and all five kinds (`timeProposal`,
`anchorEvidence`, `conversionPlan`, `conversionProof`, `conversionComplete`).
Codec acceptance is pure evidence, not executable authority or nonce registration.

The approval envelope order is `anchor,anchorHash,replayed,sessionEstablished`.
The first two are canonical anchor evidence and H; the last two are booleans.
No extra completion file, JSON overload, audit row or transition rewrite exists.

### 5.3 Status

| # | Field | Type / meaning |
| --- | --- | --- |
| 1 | `version` | Literal 1 |
| 2 | `instanceId` | U, actual instance |
| 3 | `instanceCreatedAt` | N, actual birth |
| 4 | `centerEpoch` | U, actual current epoch |
| 5 | `headGeneration` | N+ or null, actual head |
| 6 | `headHash` | H or null, paired with head generation |
| 7 | `sessionPresent` | Boolean, current matching private session exists |
| 8 | `reason` | Exactly null, `TIME_ANCHOR_REQUIRED` or `PROCESS_REANCHOR_REQUIRED` |

Status makes bounded read-only observations of actual facts. No head means
false/`TIME_ANCHOR_REQUIRED`; a head without a matching private session means
false/`PROCESS_REANCHOR_REQUIRED`; matching private state means true/null. It
makes **no wall or authority-monotonic sample**, repair or session restoration.
A present session is not a promise that a future time check will pass.

## 6. Current authorization and exact approval binding

Every operation, including status, replay and internal checking, requires current
`authority.authorizeAdmin(ctx) === true` before DB data/exact truth is disclosed.
Only synchronous literal true authorizes. A reference is not authorization.
For a new approval call exactly:

```text
approvalAuthority.resolveApproval(binding,ctx) -> strict {approverId}
approvalAuthority.authorizeApproval({...binding,approverId},ctx) -> literal true
```

Resolve once per new approval. Snapshot the returned valid Ref actor; require
`approverId !== executorId`. The authorize record appends `approverId` to the
following exact ordered binding, without other fields:

| # | Field | Source |
| --- | --- | --- |
| 1 | `kind` | Literal `maintenance-time-anchor` |
| 2 | `proposalHash` | Canonical registered proposal hash |
| 3 | `approvalRef` | Strict requested Ref |
| 4 | `instanceId` | Registered and locked actual identity |
| 5 | `instanceCreatedAt` | Registered and locked actual birth |
| 6 | `centerEpoch` | Registered and locked actual epoch |
| 7 | `previousGeneration` | Registered proposal's history tip, rechecked under lock |
| 8 | `previousAnchorHash` | Paired registered tip hash |
| 9 | `headGeneration` | Old head from private registration and locked DB, nullable |
| 10 | `headHash` | Paired old head hash, never new user input |
| 11 | `sessionNonce` | Registered process-generation nonce |
| 12 | `proposedAt` | Exact proposal |
| 13 | `proposalExpiresAt` | Exact proposal |
| 14 | `candidateWallAt` | Exact proposal |
| 15 | `acceptNotBefore` | Exact proposal |
| 16 | `acceptNotAfter` | Exact proposal |
| 17 | `globalFloorObservedAt` | Exact proposal's observed floor |
| 18 | `maxForwardJumpMs` | Exact proposal's lowered bound |
| 19 | `executorId` | Configured trusted Ref |

Final current admin and `authorizeApproval` rechecks use **the same actor and
binding**, before the final native time pair. Do not resolve a replacement actor,
substitute a new approval floor into the binding or accept truthy objects. Final
callback cleanup/poison checks must complete before entering the callback-free
final sample/write interval.

## 7. Preview and private pending registration

1. Strictly capture input; begin the shared budget and authorize current admin.
   Perform bounded read-only full validation and actual target/tip/head/floor
   observations in one snapshot.
2. Take **exactly one** native `Date.now()` sample. It is simultaneously
   `proposedAt`, `candidateWallAt` and `acceptNotBefore`; require it >= actual
   global floor, instance chronology, history-tip accepted wall and private
   highwater. Add the configured window/TTL safely, with no clamping.
3. Capture native `process.hrtime.bigint()` as the private proposal origin.
   Generate a fresh in-process nonce and construct/hash canonical proposal bytes.
4. Complete final authorization, bounded rechecks and cleanup. Only then install
   a successful private registration and return the frozen preview envelope.

Each authority has exactly one private pending proposal. Its registration stores
canonical bytes/hash, authority generation, target binding, old history tip,
old head and preview monotonic origin. A successful preview supersedes the old
uncommitted proposal; failed preview does not install a new registration. Copies
and decoding alone never register, and a superseded nonce cannot authorize a new
write. Fault invalidation may revoke state under the lifecycle rules.

Preview changes no DB floor/history/head, accepted baseline, private highwater or
last-runtime-elapsed observation. Its sole successful private state change is
pending nonce/proposal registration. In particular it cannot wash out an unsafe
clock jump or turn accepted pure-codec JSON into time authority.

## 8. Approval, replay, atomicity and uncertainty

### 8.1 Exact immutable replay first

After input capture and current admin authorization, check for an exact persisted
approval **before** new-approval/nonce/TTL/time handling. Fully validate actual
state and match canonical proposal bytes/hash, instance/birth, configured
executor, requested approval reference, retained approver and reconstructed
anchor hash. A hash hit alone is insufficient. There is no caller-supplied actor
override; retained actor evidence must remain valid and distinct from executor.

An earlier epoch or earlier anchor is allowed as immutable replay evidence,
**not current permission**. Return `replayed:true,sessionEstablished:false` with
zero resolver calls, new approval requests, wall/authority-monotonic samples,
writes, generation allocation or session mutation. Preserve any existing valid
session. An old nonce is not restored. Budget `performance.now()` remains allowed.

### 8.2 New approval's fixed owned transaction

1. Own `BEGIN IMMEDIATE`; never accept an external transaction. Under that lock
   validate exact full v5, target binding, current private pending canonical
   bytes/hash/nonce/generation, original tip and old head, actual floor and
   capacity for the new anchor/metadata.
2. Require current admin, resolve once, and authorize the exact binding/actor.
   The actual approval floor must be >= the proposal's observed floor. Validate
   preliminary native wall/monotonic observations and retain private observations
   conservatively, including after rejected approval.
3. Complete final bounded schema/binding/fact/capacity validation and final admin
   plus same-actor/binding authorization. Complete callback-bearing cleanup and
   poison checks. Then take the **final native wall/monotonic pair immediately
   before the fixed writes**.
4. Require inclusive `acceptNotBefore <= acceptedWallAt <= acceptNotAfter` and
   **strict** `acceptedWallAt < proposalExpiresAt`. Require wall >= actual floor,
   private highwater, instance chronology and history-tip accepted wall. Require
   nonnegative, nonregressing monotonic observations and strictly
   `finalMono - previewMono < BigInt(proposalTtlMs) * 1000000n`. Validate all safe
   arithmetic. No ordinary v4 clock guard may run before anchoring.
5. Allocate first generation 1 or safe `historyTip.generation + 1`. Never reset
   at an epoch boundary; the predecessor is history tip even when head is absent.
   Construct exact canonical anchor/hash with original observed floor and actual
   approval floor. Preflight byte/capacity bounds before the first write.
6. Perform only **INSERT anchor, UPSERT head, UPDATE `im_clock` to accepted wall,
   COMMIT**, in that order in the one owned transaction. No arbitrary callback
   occurs after the final pair and before COMMIT. Internal deadline/poison checks
   do not introduce a provider callback or a replacement authority time sample.

On rejection before COMMIT, roll back only the engine's own still-active
transaction: anchor, head and floor roll back together. Never roll back an
already committed writer, another connection's transaction or claim a partial
anchor/floor success. Conservatively retained private observations are not a
new accepted baseline. All inherited rows remain unchanged except `im_clock`;
the only other row changes are the new anchor and head.

### 8.3 Session installation and COMMIT response failures

Install a new private baseline only after acknowledged COMMIT and successful
final **non-callback** cleanup/poison checks. Retain the final **precommit**
monotonic origin: commit/response delay is elapsed time, not a reason to sample a
new origin. A successful fresh approval returns
`replayed:false,sessionEstablished:true`. Committed reanchor revokes the old
session and pending proposal even if the new session cannot be established.

If COMMIT throws, inspect native transaction state. Roll back only if the owned
transaction remains active. Safely close before reopening if reconciliation
requires it, retaining exclusive ownership and the same budget. Reconcile actual
immutable proof, target identity and exact full v5 state; never automatically
retry writes or mint a session from proof.

| Actual outcome | Required behavior |
| --- | --- |
| Rejection / owned transaction still active | Roll back anchor/head/floor together; no success evidence |
| Exact committed proof resolved on this first attempt | Return `replayed:false,sessionEstablished:false` only after safe reconciliation and successful final cleanup; no baseline mint |
| Later exact explicit retry of persisted proof | Return `replayed:true,sessionEstablished:false`; preserve any independently valid current session |
| Committed reanchor, new session unavailable | Old session remains revoked; persisted proof is evidence only |
| Unresolved transaction state or native close | Fixed durability uncertainty; privately retain unresolved resource, no replacement open or guessed rollback/success |
| Close threw but native `isOpen === false` is positively established | Closure response is resolved; exact reconciliation and remaining gates still apply, and no session is minted from reconciliation |

Cleanup failure or latched callback fault cannot be converted into success merely
because an anchor exists. Reading an anchor's `session_nonce`, after response
loss or a new process, never resurrects the private baseline. There is no external
file-completion publication or recovery-style resynchronization in B0.3.

## 9. Internal session check and existing `timeEvidence`

`checkMaintenanceTimeSession(timeAuthority,{},ctx)` authenticates the actual
authority WeakMap and its target/session, applies current admin, and takes a
fixed bounded read-only snapshot. No nonce/baseline/path/DB/limit JSON input is
accepted. It returns the existing ordered DTO, without new fields:

| # | Field | Type / actual binding |
| --- | --- | --- |
| 1 | `version` | Literal 1 |
| 2 | `schemaVersion` | Literal 5 in B0.3; existing pure codec also supports 4 |
| 3 | `observedWallAt` | N, native current wall |
| 4 | `globalFloorObservedAt` | N, actual `im_clock.last_observed_at` |
| 5 | `anchorGeneration` | N+ or null, actual head generation |
| 6 | `anchorHash` | H or null, actual head hash |
| 7 | `sessionNonce` | U or null, matching private session only |
| 8 | `anchorWallAt` | N or null, actual head anchor accepted wall |
| 9 | `monotonicElapsedMs` | N or null, reporting-only floor after nanosecond checks |
| 10 | `maxForwardJumpMs` | Positive safe integer <=86400000, authority's configured lowered bound; a matching private session retains that approved bound |
| 11 | `executable` | Boolean, time readiness only |
| 12 | `reason` | null, `TIME_ANCHOR_REQUIRED`, `PROCESS_REANCHOR_REQUIRED` or `CLOCK_UNSAFE` |

| Actual state (with representable otherwise-safe observations) | Evidence |
| --- | --- |
| No head | All five nullable anchor/session fields null; false / `TIME_ANCHOR_REQUIRED` |
| Head, no matching private session | Actual generation/hash/wall; null nonce/elapsed; false / `PROCESS_REANCHOR_REQUIRED` |
| Matching private session and safe observation | All five populated; true / null |
| Well-formed representable unsafe time | false / `CLOCK_UNSAFE`; never invent missing anchor/session facts |
| Malformed or unrepresentable observation/projection | Throw `MAINTENANCE_CLOCK_UNSAFE`; no clamping or fabricated DTO |

Retain the existing plan contract's diagnostic precedence and nullable rules:
representable time faults precede missing-head/session reasons; v4's existing
pure diagnostic remains false/`SCHEMA_UPGRADE_REQUIRED` and is not an admitted
B0.3 target. Pure codec success does not perform these runtime checks.

For a matching private session use native wall and `process.hrtime.bigint()`:

```text
elapsedNs = currentMonoNs - retainedPrecommitMonoNs
expectedWallNs = BigInt(acceptedWallAt) * 1000000n + elapsedNs
abs(BigInt(now) * 1000000n - expectedWallNs)
  <= BigInt(maxForwardJumpMs) * 1000000n
now >= actualGlobalFloor AND now >= privateHighwater
```

Require elapsed >=0, nonregression against retained private observations and
representable projected wall/reporting values. Compare exact bigint nanoseconds
**before** reporting `floor(elapsedNs / 1000000n)` as safe integer milliseconds.
Fractional milliseconds cannot disappear before the deviation comparison.
Only private observation state advances; accepted baseline and DB floor do not.
An ordinary global-floor advance cannot refresh the origin or wash out a jump.

Future B1 must call the **module-private check in its genuine own transaction
frame**, at both pre-write and final time gates. This DTO is not a transferable
writer token. No generic transaction extension is included now. Future recovery
must atomically clear head on epoch change and preserve chain history; B0.3
itself treats epoch drift as stale and performs no recovery/head repair.

## 10. Fixed engine errors

Only these fixed local engine codes cross the boundary; messages are safe fixed
literals with no native SQL, path, provider exception/cause or row data:

| Code | Meaning |
| --- | --- |
| `MAINTENANCE_INVALID` | Strict shape, arity, receiver or synchronous-interface refusal |
| `MAINTENANCE_AUTH_DENIED` | Current admin not literal true |
| `MAINTENANCE_APPROVAL_DENIED` | Independent approval/actor authorization refused |
| `MAINTENANCE_TARGET_STALE` | Revoked or drifted target/generation binding |
| `MAINTENANCE_SCHEMA_UNSUPPORTED` | Target is outside the admitted exact schema/state boundary |
| `MAINTENANCE_FACT_MISMATCH` | Canonical, registration, retained proof or actual fact mismatch |
| `MAINTENANCE_CLOCK_UNSAFE` | Unsafe/unrepresentable time, chronology, TTL or arithmetic |
| `MAINTENANCE_READ_UNAVAILABLE` | Required protected/bounded observation unavailable, including elapsed/row/content exhaustion |
| `MAINTENANCE_METADATA_LIMIT` | Metadata/canonical byte capacity exhausted |
| `MAINTENANCE_DURABILITY_UNCERTAIN` | Unresolved transaction/closure/durability outcome |

Status/timeEvidence reasons are not replacement error codes. The pure codec
keeps its existing `MAINTENANCE_CODEC_INVALID` and `MAINTENANCE_METADATA_LIMIT`;
full schema validators retain `IM_SCHEMA_MISMATCH` and
`IM_V2_BUDGET_EXCEEDED`. This does not add recovery/conversion/policy error codes
to the finite engine surface or permit foreign-error reflection.

## 11. Required source-bound acceptance matrix (not executed here)

| Area | Required cases and evidence |
| --- | --- |
| Provenance and admission | Reject fake/copied/proxied targets/authorities, read target, unfinished and completed conversion targets, production target composition, aliases/hardlinks/symlinks, every sidecar including empty, unsupported native protection, non-IM side-effect objects; prove existing-file-only open and closed fixture-owner handoff. |
| Lifetime | Changed file/directory/native connection, cookie/version/checksum/birth/epoch, unexpected head/tip and ACTIVE/PAUSED drift; permanent staleness, second-authority refusal, zero-argument genuine lifecycle receiver, invalidation/reentry poison, unresolved closure retained with no replacement connection. |
| Legal chains | Full inherited ACTIVE/PAUSED relations; first anchor, same-epoch reanchor, legal cross-epoch history with no head; contiguous global generations, tip rather than head predecessor, no overflow/reset. No recovery operation is needed to exercise a synthetic historical fixture. |
| Proposal registration | Internal nonce, exact canonical bytes before callbacks, successful supersession, failed preview no new registration, copied/decoded proposal no authority, wrong generation/target/head/tip, stale/superseded nonce. |
| Approval and replay | Wrong proposal/hash/reference/configured executor, invalid or same executor/approver, actor changes at final check, truthy substitutes; old-epoch/old-anchor exact replay remains evidence only and calls no resolver/new approval. |
| Hostile interfaces | Accessor/symbol/nonordinary/nonenumerable/unknown fields and Proxy rejection before traps; async/generator prefix refusal, unexpected promise/thenable poison before observation, accessor-thenable rejection without getter; caught/falsy/hostile faults and late cleanup/reentry never false success. |
| Time | Inclusive window endpoints, strict wall and proposal-monotonic TTL equality, TTL shorter than window, backward/regressing mono, safe-integer addition/generation/projected-wall overflow, fractional-ms deviation, instance/tip/highwater chronology, floor raised since preview, global-floor washout refusal. |
| Atomicity | Failure at each fixed write and final sample; anchor/head/floor all roll back before commit; no rollback of committed writer; no other inherited row or transition/audit mutation. |
| Commit and close | Slow COMMIT counted from precommit origin; before/after-COMMIT response faults, exact first-attempt reconciliation flags, resolved close-response vs unresolved resource retention, no automatic write retry or session mint, committed reanchor revokes old session. Distinguish writer rollback from later reader snapshot cleanup. |
| Restart | New process exact replay has no session, stored nonce cannot restore it, current valid session preserved by replay, fresh proposal/new independent approval required for new session. |
| Read-only evidence | Preview/status/replay perform zero SQL writes and no main/sidecar content or mtime change, creation/deletion/replacement/sync; preview does not ratchet highwater/baseline/runtime elapsed; status/replay have zero authority wall/mono samples. OS atime equality is not promised. |
| Budget | All six target caps and nine authority limits are required/lower-only; one deadline spans callbacks/full validation/follow-ups/encoding/cleanup; projected metadata and new-anchor capacity preflight; correct read-exhaustion vs metadata error; no forged recovery brand or nested reset. |
| Surface preservation | Exact three internal exports, thin factory-only reexport, exact facade/DTO orders; unchanged five-kind bytes/domains, DDL/checksum and historical APIs; no service/barrel/CLI/MCP/recovery integration, executor or deletion path. |

Run meaningful native/process-fault evidence against the reviewed source and
dedicated synthetic fixtures during implementation. Process faults and process
kills are **not hardware power-loss proof**. Unsupported/skipped native protection
cases are not passes. This appendix runs no code/runtime tests and grants no
runtime PASS or production acceptance.

## 12. Finite interface clarification and pending integration gates

The parent-frozen lifecycle convention is: `invalidate()` and successful `close()`
return `undefined`. Valid repeated invalidation is idempotent. After positively
confirmed closure, a genuine repeated `close()` is idempotent and performs no I/O.
Both methods require zero arguments and the original receiver; copied, detached
or extra-argument calls reject. Closing during an active operation revokes and
poisons it, refuses without reentrant SQLite close, and permits later cleanup
outside the operation. Unresolved close retains the privately owned resource and
throws `MAINTENANCE_DURABILITY_UNCERTAIN`; only native `isOpen === false` resolves
a close-response exception. No replacement connection or guessed success is allowed.

All other B0.3 field sets, export/call surfaces, adapter binding, limit ceilings,
time/nonce/replay rules, fixed write set and error vocabulary are frozen above.
Production ownership integration and runtime/backup/recovery gates remain future
work; they are not gaps an implementer may fill with a permissive target or a
conversion-candidate handoff. B1 writer transaction integration and deletion
approval remain separate assignments.

Document validation covers UTF-8/no BOM/final newline, relative existing links,
balanced fences, frozen field-order alignment and whitespace. The document-only
write set is this new appendix and the linking/scope reconciliation in the
schema-v5 contract. No code, tests, DB, service or configuration changes, commits
or pushes are part of this assignment.
