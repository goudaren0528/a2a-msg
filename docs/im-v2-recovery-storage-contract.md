# P5-A recovery storage contract

Status: A-specific encoding/interface frozen before implementation; implemented,
targeted verification complete, independent review pending. NONRELEASE only;
P5-B/C candidate operations and P5-D fault matrix remain separate gates.
Baseline: `f3d17094106c1833a2d0019a4c3cb19b25918fe7` plus approved design §6.

## Trust and interfaces

All factories are trusted in-process composition, never HTTP/JSON configuration.
`authority.authorizeAdmin(context)` and
`approvalAuthority.authorizeBackup({approvalRef, executorActorId, approverActorId}, context)`
must return synchronous literal `true`. Actor references come from synchronous
`authority.publicationActors(context) -> {executorActorId, approverActorId}`.
No context or adapter exception is serialized. References are non-secret strings,
1..255 UTF-16 units, no C0/DEL. Actors must differ. UUIDs are lowercase canonical;
hashes are lowercase SHA-256 hex; times are nonnegative safe integer milliseconds.

`backup.js`: `createImV2Backup({db,root,authority,approvalAuthority,clock=Date.now,
limits,backupTimeBudgetMs=30000,backupRate=256})` returns frozen
`{publish,verify,status,drain}`. `publish({approvalRef},context)` asynchronously
creates an actual native SQLite snapshot; no destination, identity, verifier or
native-backup override is accepted. It returns `{manifest,manifestHash}`.
`verify({backupId})` returns verified content `{manifest,manifestHash}` or throws;
it does not establish registry provenance. `status()` returns `{nativeInFlight}`;
`drain()` waits for any native backup to settle, including after timeout. Caller
must drain before closing its source DB. Native timeout never cancels SQLite.
Only prepared/verified/active v4 candidates accepted by the full P1 validator
are backed up; a legitimate fresh prepared bootstrap is allowed, without implying
activation. Trusted `limits` accepts only the following positive safe-integer
fields; each default is also its hard ceiling and may only be lowered:

| Field | Default / hard ceiling |
| --- | ---: |
| `maxMessages` | 10000 |
| `maxVerifiedContentBytes` | 104857600 (100 MiB) |
| `maxOtherRecords` | 10000 |
| `maxElapsedMs` | 10000 |
| `maxFileBytes` | 134217728 (128 MiB) |
| `maxMetadataEntries` | 10000 |

These are parent-selected P5 implementation budgets, not customer retention
policy. Size is checked before hashing/large reads, and streaming checks the
same operation budget before/after every chunk and after final hashing. Nested
verification and hold scans share that budget; they do not reset per hold or
chunk. Elapsed validation is soft: synchronous SQLite statements and fsync cannot
be interrupted; deadlines are checked before/after them and before success.
Integrity/FK result iteration stops at the first error without collecting all
errors. The native backup deadline remains separate and cannot cancel native work.
Budget exhaustion reports `RECOVERY_BUSY`, never an empty/no-hold result.
After native backup settles, its exclusively owned pending destination is opened
through SQLite, checkpointed with TRUNCATE and changed to DELETE journal mode;
SQLite closes/removes its own sidecars. The source's journal mode is not changed.
No raw sidecar deletion or VACUUM fallback occurs. Pending output is retained on
failure/timeout and is never recognized as a completed backup.

Internal content-only exports `validationLimits`, `inspectV4`, `verifyV4` support
the sibling registry adapter. They cannot register provenance and are not the B
transport interface. The P1 internal validator receives an explicit `{limits,tick}`.

`backup-registry.js`: `createImV2BackupRegistry({root,authority,clock,limits})`
returns frozen `{verify,withVerifiedBackup,createStageHold,bindPrepareHold,
getHold,checkCleanup}`. `verify({backupId},context)` returns
`{record,sourceEvidence}`; both are detached, recursively frozen metadata. `withVerifiedBackup` takes
the same input, context, then a synchronous callback receiving metadata plus
`copyTo(writeChunk)`; the latter is scope-bound and copies verified independent
bytes, without paths. It is the exact A transport seam for B's sourceCatalog.
The callback must finish destination verification before returning; no Promise.
Known async consume callbacks and sinks are rejected before invocation (zero
sink prefix). Plain functions returning thenables are rejected after invocation;
Promise rejections are observed without awaiting under the lock and the copy
capability expires. Already-started arbitrary async effects cannot be cancelled.
Rejecting a known async sink before invocation leaves the enclosing synchronous
scope usable if the caller catches that rejection. A thenable returned after
invocation expires the capability. Synchronous sink errors propagate the caller's
original exception after releasing the lock; this API does not promise destination
cleanup. V2 contract violations report `RECOVERY_EVIDENCE_MISMATCH`; use after
scope reports `RECOVERY_INVALID`.
B must create its candidate sink itself and hold candidate control inside this
scope, after a durable stage hold. B's four-source catalog routing is pending.

`createTrustedImV2BackupServices({...registryOptions,db,approvalAuthority,
backupTimeBudgetMs,backupRate})` returns `{publisher,registry}`; publisher has
`publish({approvalRef},context)`, `importRegisteredV3({sourceRegistry,backupId},context)`,
`status()`, `drain()`. Source registry must be a genuine legacy facade, proven by
the old module's private WeakMap, not a duck-typed callback or caller JSON.
Publication returns `{record,sourceEvidence}`. There is no registration writer,
path accessor, platform override or general registerArtifact API.

The narrow legacy addition is exported
`withProtectedBackupCopy(registry,{backupId,adminContext,limits?,tick?},consume)`.
Optional trusted-internal `limits` contains only lower-only `maxFileBytes`
(134217728) and `maxElapsedMs` (10000). Optional synchronous `tick()` joins the
consumer's operation budget; unknown input/limit fields are rejected with
`REGISTRY_INVALID_INPUT`. Size is checked before full verification. The bridge
uses immutable full integrity/FK iteration and the unchanged historical schema/
identity validator; SQLite statements are synchronous and noninterruptible, with
soft checks on both sides. Copy chunks and final hashes check deadlines. Bridge exhaustion is
`REGISTRY_BUSY`, sanitized to `RECOVERY_BUSY` by the v2 import adapter. Async
sink/returned-Promise violations are `REGISTRY_ASYNC_CALLBACK`; expired bridge
capabilities report `REGISTRY_USE_EXPIRED`. Existing legacy public methods keep
their semantics and key set.
It verifies provenance/schema/identity under the existing discovered lock and
calls synchronous `consume({recordBytes,manifestBytes,copyTo})`. It rechecks
source bytes afterwards. `copyTo(writeChunk)` reads via a protected no-follow fd,
streams bounded chunks, and expires when consume returns. New storage supplies
the destination sink privately, independently copies bytes (no cross-root link),
verifies actual destination SQLite/identity/hash before returning. Old revoke and
cleanup contend throughout. Existing facade keys and old behavior are unchanged.

### Registered-v3 WAL-header compatibility

Node **24.19.0** supports SQLite URI strings: tagged `src/node_sqlite.cc` enables
`SQLITE_OPEN_URI` and passes a string path unchanged to `sqlite3_open_v2`.
All legacy artifact SQLite opens and the imported-v3 verifier use the private
`withClosedBackupSnapshot(path, inspect)` helper, which constructs
`pathToFileURL(resolve(path))`, sets `mode=ro` and `immutable=1` search parameters,
and opens the URL with `readOnly:true`, solely
for provenance-bound **closed standalone native-backup snapshots**. This is not
an arbitrary live-database route. Full integrity/FK checks, historical exact
schema/identity validation, original raw manifest checks, and protected file
hash/inode checks still apply. V3 destination validation also applies the P1
message/content/other-record budgets before its full SQLite checks.

No original or imported main bytes are normalized, no manifest hash is replaced,
and no source journal mode is changed. Any preexisting WAL, SHM, or journal is
refused as unresolved state, even when empty; unknown sidecars are never deleted.
The former old artifact read paths left empty read-sidecars before the bridge
was entered. The authorized WAL correction routes primitive `inspect`, publisher
copy-identity inspection, registry registration/full verification, protected-copy
inspection, and imported-v3 inspection through the helper. New publications no
longer create those sidecars. Previously produced artifacts with residual
sidecars remain refused; this change neither repairs nor deletes them.

The helper accepts filesystem strings, not caller URI options. It rejects a
nonregular/symlink leaf or noncanonical real path and captures main-file identity
and stat fields. It checks sidecar absence before opening and after closing, and
checks dev/inode/size/mtime/ctime/mode/owner/link-count stability after closing.
Callers retain their permission/isolation, provenance, manifest and hash checks;
the helper neither mints provenance nor hashes the file or resets a P5 budget.
Legacy primitive verification additionally rechecks its existing manifest hash
after inspection. Schema support remains 1/2/3; trusted publisher remains v3.

Inspection is synchronous: known async callbacks are refused before invocation;
unexpected returned thenables have rejection observed and are refused. The owned
read connection is closed and both postcondition groups are attempted even after
callback/open/close failure. The first failure is preserved, including a thrown
non-Error; a postcondition failure prevents success. Caller mappings retain
`BACKUP_VERIFY_FAILED`, `BACKUP_IDENTITY_MISMATCH`, `REGISTRY_ARTIFACT_MISMATCH`,
and the existing P5 sanitization. Source factory/live DB connections are never
passed through the helper and are not closed by it. Public facade signatures and
keysets and manifest/record formats are unchanged. This is a compatibility
tightening: empty as well as nonempty sidecars are refused, not ignored.

Native probes (new isolated ext4 directories; no existing evidence overwritten):
`/root/team-mailbox-unix-ab-6d98adn4/p5-source-wal-Y3S81y/proof.json` proves a
real SQLite backup from committed WAL frames retains header bytes `[2,2]`, is
readable using immutable URI with `integrity_check=ok`, creates no sidecars, and
preserves SHA-256 while the source remains WAL. The genuine publication probe
`p5-source-legacy-mxmiQk/proof.json` records preexisting old-publisher sidecars
and the original failed import. In the separately owned probe
`p5-source-legacy-TZpp5a/proof.json`, SQLite itself closed its newly-created
empty read-sidecars without changing main SHA-256 or WAL header; import and
reverification then succeeded, keeping the original hash and source WAL mode.
That probe-only close is not a production cleanup API or an import side effect.
The subsequent `p5-source-legacy-763FMa/proof.json` adds passing isolated checks
for exact hold/binding retry, cleanup blocking, frozen metadata, async sink zero
prefix, returned-Promise rejection observation (zero unhandled events), and the
metadata cap. It is focused probe evidence, not the final targeted test run.
The direct immutable-mode probe `p5-source-legacy-uGhYED/proof.json` confirms
schema validation and integrity succeed with no sidecars and identical before/
after SHA-256. Important SQLite distinction: the immutable connection reports
`PRAGMA journal_mode=delete`, while the on-disk header remains `[2,2]` and the
live source reports `wal`. No journal-mode assignment or main-file rewrite is
performed. Requiring that immutable connection itself report `wal` is not a
valid oracle for preservation of the artifact's WAL header.

## Canonical records and dependency order

New metadata uses ordinary objects in the exact order below, JSON.stringify UTF-8,
no whitespace/newline/BOM, <=65536 bytes. Read: strict fields/types, reencode and
byte-compare. Hash the raw canonical bytes, not a parsed or reordered object.

```
manifest = {formatVersion:2,backupId,sourceId,sourceCreatedAt,schemaVersion:4,
  schemaChecksum,fileHash,completedAt,toolVersion:"im-v2-backup-1",
  approval:{approvalRef,executorActorId,approverActorId}}
record = {recordVersion:3,backupId,instanceId,instanceCreatedAt,schemaVersion,
  schemaChecksum,fileHash,manifestHash,completedAt,artifactReference,
  publicationKind,sourceEvidenceHash,registeredAt}
sourceEvidence = {version:1,kind:"registered-backup",sourceRef,registryFormat,
  instanceId,instanceCreatedAt,backupId,fileHash,manifestHash,schemaVersion,
  schemaChecksum,completedAt,importedRecordHash}
stageHold = {version:1,holdId,backupId,recoveryRunId,stageHash,createdAt}
prepareBinding = {version:1,holdId,stageHash,preparePlanHash,boundAt}
releaseMarker = {version:1,holdId,recoveryRunId,terminalState,
  stateEvidenceHash,approvalRef,releasedAt}
```

Record schemaVersion is exactly 4 for `native-v4`, 3 for
`imported-registered-v3`. All fields are required. Only importedRecordHash is
nullable: native=null, import=hash of the **raw complete old recordVersion=2
backup record bytes**, retained unchanged. Import keeps original backupId and raw
old manifest bytes; duplicate IDs conflict, never overwrite. Native evidence
registryFormat=3; imported evidence registryFormat=2. sourceRef is internally
`backup:<backupId>` in this A storage scope, not a network address or pathname.
All instance/manifest fields derive from verified actual SQLite and original
publication. Hash order: snapshot -> manifest -> old record bytes (import only)
-> sourceEvidence -> record. Neither sourceEvidence nor source proof includes the
new record hash: no self-reference. Native manifest itself is the source proof;
imports additionally preserve complete old record evidence. Old record bytes are
validated under old rules, not canonicalized into the new encoding.

Paths (fixed grammar, only internally allocated UUID leaves):
`coordination.sqlite`, `registry/{artifacts,records,holds,releases}/`;
`artifacts/<backupId>.sqlite`, `<backupId>.manifest.json`;
`records/<backupId>.json`, `<backupId>.source.json`, `<backupId>.import.json`;
`holds/<holdId>.json`, `<holdId>.binding.json`;
`releases/<holdId>.json`. artifactReference is exactly
`registry/artifacts/<backupId>.sqlite`. Run IDs and hold IDs are UUIDs in A.

`createStageHold({backupId,recoveryRunId,stageHash},context)` performs a bounded
scan under the same coordinator. One exact logical match returns its original
holdId/createdAt after canonical validation and protected file + directory fsync.
The same recoveryRunId with a different backup/stage, or multiple matches, fails
with `RECOVERY_EVIDENCE_MISMATCH`; no first-match selection occurs. Only a new
identity generates holdId/createdAt internally. `bindPrepareHold({holdId,preparePlanHash},context)`
loads stageHash internally. Exact binding retry preserves existing bytes and
reestablishes protected file + directory durability; changed plan is rejected.
Visible metadata after a directory-sync failure is not proof of success: retry
continues to report `RECOVERY_DURABILITY_UNCERTAIN` while syncing fails, including
after reopening a facade. No final record is deleted or overwritten as rollback.
`getHold({holdId},context)`
returns `{hold,binding:null|prepareBinding,release:null|releaseMarker}`.
`checkCleanup({backupId},context)` is a fail-closed advisory and always returns
`{allowed:false,reason:"HOLD"|"DISABLED"}`; scans every hold/binding/release and
rejects malformed/orphan records. A streaming `opendir` scan counts all directory
entries (including unrelated names) across owned hold/release directories against
one `maxMetadataEntries` cap. Canonical hold/binding bytes are read once per
operation, and a backup referenced by many holds is verified once in that scan.
Unbound holds still block cleanup. There is no deletion or TTL executor.
Release encoding/storage remains private for B/C composition: A exposes **no
release writer** and accepts no caller terminal boolean. Any release file in A
is untrusted until C supplies independently verified candidate terminal proof
and independent approval; it blocks cleanup. This intentionally retains holds.

## Protection and verification route

Directories are 0700/euid-owned and files 0600/euid-owned, no symlinks, stable
inodes, single links. Ancestors must be root/euid owned and non-writable by others
(sticky trusted temp ancestor permitted). Publish exclusive UUID pending, fsync
file, hardlink no-replace, unlink only own pending, fsync directory. Failures
retain evidence and report RECOVERY_DURABILITY_UNCERTAIN. No unknown cleanup.
Existing coordination inodes are inspected only by lstat/realpath and managed
SQLite, never raw-opened/closed. DELETE mode/user_version=1/busy_timeout=0;
coarse lock order old source -> new registry -> candidate. Native asynchronous
snapshot finishes in unique pending storage before taking the registry lock;
the durable record is the publication commit point.

A evidence owner: this implementation lane. Targeted native Linux/ext4 tests
exercise populated v4 snapshots, lower budgets, corruption, canonical metadata,
permissions/link rejection, independent v3 copy, lock contention, hold persistence
and fsync uncertainty. Windows tests establish explicit UNSUPPORTED only. Native
wrappers may inject faults in test processes; no production fault/platform option.
Affected legacy registry regression is required. Full-suite/release/production
and candidate lifecycle claims await independent review and B/C/D.

## Implementation ownership and evidence notes

Owned source files: new `src/im/v2/{backup,backup-registry,recovery-records}.js`;
legacy `src/im/backup-registry.js` adds its WeakMap-authenticated copy bridge.
The parent subsequently authorized artifact-only read changes in legacy backup,
publisher and registry, plus private `src/im/backup-snapshot.js`, for WAL closure.
Owned tests: new `tests/im-v2-backup.test.js`, `tests/im-v2-backup-registry.test.js`,
`tests/fixtures/im-v2-backup/*`; old registry test changes only the expected export
list to include `withProtectedBackupCopy`. Historical schema/checksums remain
unchanged; backup primitive/publisher changes are limited to artifact verification.

Native evidence runner:
`wsl.exe -e python3 /mnt/d/team-mailbox/tests/fixtures/im-v2-backup/run-native.py`.
It creates a new private ext4 snapshot on each run, reuses retained Node 24.19.0
and isolated dependencies, records per-file source hashes, command, node version,
filesystem, native exit and full targeted log. It accesses only src/tests and
explicit package/contract files. Source credentials/runtime data are not inputs.
Targeted command is `node --test tests/im-v2-backup.test.js
tests/im-v2-backup-registry.test.js tests/im-backup-registry.test.js`.

The initial native run found and corrected inherited WAL-mode sidecar behavior.
A subsequent test-only timeout wrapper initially used an ESM binding which
Node's SQLite module does not refresh via syncBuiltinESMExports; that experiment
timed out and is not passing evidence. Production has no injection option; tests
now wrap the actual native module function and still execute real SQLite backup.
Evidence from failed runs is retained. No full suite was run.

Remaining gates: B freezes four-source sourceCatalog routing, candidate sink and
stage/status DTOs; C supplies actual terminal-state evidence and independent
release approval before any release writer is composed. The release schema is
implemented privately; A does not expose a way to publish release markers. D must
complete crash/response-loss phase matrix, richer process hold cases, and closed
source/candidate/seal behavior. Independent code/security/QA review is required
before B consumes this seam. These tests do not establish production isolation,
hardware power-loss durability or platform support beyond native local ext4.

### Historical targeted result (2026-09-25; before reconciled review corrections)

- Final native snapshot: `/root/team-mailbox-unix-ab-6d98adn4/p5-a-jr70stzl`.
  `metadata.json` has actual tested source hashes; `targeted.log` is the native
  UTF-8 log; `native-exit.json` is `{exitCode:0,timeout:false}`. Node 24.19.0:
  **34 tests, 32 pass, 0 fail, 2 Windows-only skips**. `findmnt -T` confirms ext4
  (`stat -f` labels the shared ext-family filesystem magic as `ext2/ext3`).
- Outer native exit/log:
  `C:/Users/ttx/AppData/Local/Temp/opencode/p5-a-native-cdbfe9c6-38ff-44a7-b405-e30f63997217`;
  outer exit 0. Native log is authoritative for Unicode text (PowerShell rendering
  of checkmark characters is lossy).
- Windows targeted run:
  `C:/Users/ttx/AppData/Local/Temp/opencode/p5-a-windows-2708e84c-48ff-4d9b-82b8-f14bee12d755`;
  Node 24.19.0, exit 0, **30 tests, 4 pass, 26 native-protection skips**.
  This run preceded the final legacy-error sanitization; its Windows unsupported
  branch and canonical parser were unchanged by that final edit.
- Tested source SHA-256:
  - `src/im/backup-registry.js`: `e603a65f8f8d5dc02653c82717b824d3db0b2eb929f34f8f23b4721d81d01c52`
  - `src/im/v2/backup.js`: `aa1b2a94292d4e163b3d40589e565a55aba75ae52ea3e1f59ccf702cc584e85b`
  - `src/im/v2/backup-registry.js`: `099ec49cd4649a9c72305562054d65464dd2cbb465d31af478182a7373b26a3c`
  - `src/im/v2/recovery-records.js`: `bc3bdf6803a38b7a0d8d747bd073755a6db557658f499770f8b8f42d3c640b49`

The hashes above describe that historical snapshot, not the subsequent bounded
validation, async callback, or durable retry corrections. Those corrections await
the independent test lane's final targeted run. No commits or push.

### Integrated review-correction result (2026-09-25)

Independent test lane completed; all three target test files and P5 fixtures were
read and executed without test edits. Command: `node --test
tests/im-v2-backup.test.js tests/im-v2-backup-registry.test.js
tests/im-backup-registry.test.js`.

Final native snapshot: `/root/team-mailbox-unix-ab-6d98adn4/p5-a-mpi88gb1`.
Node 24.19.0, `findmnt` filesystem ext4. `metadata.json` records all source/test
hashes, `targeted.log` is the authoritative native log, and `native-exit.json`
is `{exitCode:1,timeout:false}`. **52 tests: 48 pass, 2 fail, 2 Windows-only
skips; no cancellation.** Outer evidence:
`C:/Users/ttx/AppData/Local/Temp/opencode/p5-a-integrated-native-52652a6d-0dcd-4345-b26e-5822a99a0e93`,
outer exit 1. Earlier failed snapshots `p5-a-m0_pld5o` (45 pass / 5 fail / 2 skip)
and `p5-a-i3ym1g6q` (47 pass / 3 fail / 2 skip) remain retained. Their callback
scope/error-propagation and metadata-conflict regressions were corrected in
source; independent tests were not changed.

Passing coverage includes lower-only limits, pre-heavy-read file caps (native and
legacy bridge), initial/final hash and copy deadlines, bounded cached metadata
scans, both generations' async-prefix and Promise-rejection checks with default
and observed unhandled-rejection behavior, real next lock acquisitions, exact
stage-hold identity and conflict checks, both persistent fsync-failure retry
cases including facade reopen, lock IPC, and legacy registry regression.

The two remaining failures are reported without weakening the assertions:

1. `tests/im-v2-backup-registry.test.js:255`: the genuine old WAL publication
   fails its no-sidecar assertion at line 271 **before the bridge is invoked**;
   old publication has already left `-wal`.
2. Same file, line 308: the new-side committed-WAL negative case fails during
   its initial import at line 312 because of those old preexisting sidecars.
   It does not reach its new-side committed-WAL assertion. The old-side committed
   nonempty-WAL negative case at line 325 passes.

Resolving the old publication's pre-bridge state requires a scope/provenance
decision outside the authorized old protected-copy extension. This result is
**not a passing WAL end-to-end acceptance**.

Windows evidence:
`C:/Users/ttx/AppData/Local/Temp/opencode/p5-a-integrated-windows-6a7f2dcd-6b16-47e0-8568-b498c53a46f8`;
exit 0, **48 tests: 5 pass, 0 fail, 43 native-protection skips**. This run preceded
the final native-only sink-exception propagation correction; its passing Windows
branches were unchanged. It establishes unsupported behavior, not POSIX support.

Final native tested executable SHA-256:

- `src/im/backup-registry.js`: `8179835c7ffd6a7960cfddd4be4b445198a4068a7564c444d16aad6d73c2dfef`
- `src/im/v2/backup.js`: `f4f28da1f36050f021f8848770ca26cd431ea04dea124ac2e4d896bbc418f496`
- `src/im/v2/backup-registry.js`: `f143d5e6553cea1b8dceaf9461b470cf3eab0012f86bd7164c64078bbbbc93c4`
- `src/im/v2/recovery-records.js`: `a10dbbff5a7bfe96b8e3c0e8c49f5b61749a111056300423041ee14d39c82706`

This result section was added after that snapshot. No subsequent executable
source edit, full suite, commit, push, dependency change or service operation.

### Authorized WAL artifact-read correction (2026-09-25)

The prior 48-pass/2-fail snapshot remains historical evidence. Following the
parent's oracle decision, only the artifact read paths listed above changed.
New native snapshot: `/root/team-mailbox-unix-ab-6d98adn4/p5-wal-source-te6tdmob`.
Node 24.19.0, ext4, same matching retained dependencies. Exact argv is in
`metadata.json`; it executes the frozen three-file command above. `targeted.log`
records **52 tests: 50 pass, 0 fail, 2 Windows-only skips**; native `exit.json`
is `{exitCode:0,timeout:false}`. `metadata.json` and `source-after.json` record
before/after source and frozen-test hashes. Outer argv/exit/log:
`C:/Users/ttx/AppData/Local/Temp/opencode/p5-wal-source-outer-3183ae2f-47dc-4afe-92ef-42a483a66f6a`;
outer exit 0. No previous evidence was overwritten.

Both formerly failing WAL tests now pass, including the genuine old publication,
main WAL-header/hash/raw-manifest preservation, absent artifact sidecars through
import/reopen and independent new-copy verification after old cleanup. Both old
and new committed-nonempty-WAL refusal cases pass. All four non-WAL correction
groups and old-registry public keyset regression passed again in this snapshot.

The active independent historical/helper tests were not read or executed. Their
pinned v1/v2/v3 DELETE/native-WAL matrix, empty-residue negatives, private-helper
failure behavior and parent oracle/code review remain pending. The existing
Windows result predates this legacy artifact-read change and does not establish
portable legacy backup compatibility for the new helper. Overall P5-A remains
blocked on those independent gates; this frozen-suite pass is not full release
acceptance. No tests/fixtures, schema/constants, v4 validator, runtime config,
dependency or service changes; no commit/push or actual artifact cleanup.

### Final six-file integrated execution (2026-09-25)

After gen66 became terminal, its new historical tests and fixtures were read and
included unchanged. Executable sources stayed at the preceding WAL-fix hashes.
The following six files were run together on both platforms:

```
node --test tests/im-backup-snapshot.test.js tests/im-backup.test.js
  tests/im-backup-publisher.test.js tests/im-backup-registry.test.js
  tests/im-v2-backup.test.js tests/im-v2-backup-registry.test.js
```

- **Native Node 24.19.0 / Linux ext4:** `/root/team-mailbox-unix-ab-6d98adn4/p5-wal-six-psOmVR`.
  **100 tests, 97 pass, 0 fail, 3 Windows-only skips**, no cancellations.
  Native exit 0, signal null, errorCode null. Outer evidence:
  `C:/Users/ttx/AppData/Local/Temp/opencode/p5-wal-six-native-outer-89d1f1ba-8f5b-4fa6-abd1-88ecac4d7a8c`,
  outer exit 0.
- **Windows Node 24.19.0:**
  `C:/Users/ttx/AppData/Local/Temp/opencode/p5-wal-six-SOJVCk`.
  **96 tests, 43 pass, 0 fail, 53 platform skips**, no cancellations.
  Process exit 0, signal null, errorCode null. Outer evidence:
  `C:/Users/ttx/AppData/Local/Temp/opencode/p5-wal-six-windows-outer-a2e562d0-3123-4f5f-8245-647054dae03d`,
  outer exit 0. Portable legacy primitive tests use their explicit best-effort
  Windows durability fixture; this is not strict registry durability support.

Each run has `metadata.json` (exact executable argv, version, platform and input
hashes), `targeted.log`, `exit.json`, and `source-after.json`. All captured
source/test/fixture/package hashes match before and after each run, and the
native and Windows input hash maps are identical. No test assertion was changed.
The total-count difference is the four nested corruption subtests inside a P5
parent skipped on Windows.

The native run reaches and passes both formerly failing assertions: genuine old
WAL publication through import/reopen/old cleanup and independent new-copy
verification, plus the initialized new-side committed-WAL refusal. It also passes
the old-side committed-WAL refusal. The historical 23-case file passes in full
on native: pinned v1/v2/v3 DELETE/WAL, special paths, empty WAL/SHM/journal,
nonempty committed WAL, and old publisher/registry artifact scopes. Windows runs
the portable historical cases and skips four strict-registry cases. Old backup,
publisher and registry regressions and all four non-WAL P5 correction groups
pass in the combined native run. This is fresh integrated evidence, not a reuse
of gen66's earlier qualified 23-pass result.

Tested source SHA-256 (same on both platforms):

- `src/im/backup-snapshot.js`: `d2e065f35854bcd9c802ae68b11828d76ab5de05cb6ba03ad2f9c91fe8259f2b`
- `src/im/backup.js`: `a57737a257e50ca352d5309ec1a75ea5e2e88e52c14605d263f541629d9d26ac`
- `src/im/backup-publisher.js`: `bb37b40b891e7a17716ab0d25524ac27ba36649b6d9cc4358545272f181ebc37`
- `src/im/backup-registry.js`: `f1e077da9084061c193e821898f1897f3b86b0c0fe9ef29771ee3e44e9035775`
- `src/im/v2/backup-registry.js`: `4e87159f6fc178123bd5a39fe3a48fe6e97820f00d95286646fd63f8284dd900`
- `src/im/v2/backup.js`: `f4f28da1f36050f021f8848770ca26cd431ea04dea124ac2e4d896bbc418f496`
- `src/im/v2/recovery-records.js`: `a10dbbff5a7bfe96b8e3c0e8c49f5b61749a111056300423041ee14d39c82706`

This execution closes the source author's combined test gate. Parent oracle/
gen63 review and independent execution QA remain separate approval gates; no
overall P5-A release/production claim follows from this result. This section is
documentation added after the snapshots; executable sources remain unchanged.
