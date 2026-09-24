# IM clock guard: opt-in fresh writes

`createImClockGuard({ db, clock })` returns a per-connection cached guard. Reusing
the connection with a different clock is rejected (`INVALID_REQUEST`). Existing
`runRead`, `runWrite`, and `current` keep their single-observation behavior.
The guard requires an open connection outside a transaction with SQLite
`synchronous=FULL` or `EXTRA`; it does not change durability PRAGMAs. Use the
same canonical guard and the same clock function reference for a connection.
Read scopes must not perform manual SQL writes.

`runWriteFresh(callback)` is synchronous and cannot be nested inside another
guard scope. It commits an independent clock anchor, then acquires a new
`BEGIN IMMEDIATE` lock and samples again against the persisted floor and
process highwater before entering the callback. `current()` reports the most
recent safely observed value. Inside **only** this fresh write scope,
`refreshCurrent()` samples the injected clock again, checks both floors,
updates the transaction's clock floor, and returns the new observation. The
caller must explicitly refresh after potentially lengthy authorization or
approval checks when it needs a fresh expiry decision; the guard does not
evaluate business expiry rules.

Business effects are enclosed in an internal SQLite savepoint. Success
releases it and commits business plus clock. On callback failure, business
effects are rolled back to the savepoint, the maximum safely sampled floor is
reapplied outside it, and the outer transaction commits clock alone before
rethrowing the callback error. An unsafe/failed refresh cannot be suppressed by
catching it in the callback; storage/commit failure also never returns business
success. No observation in an uncommitted outer transaction is claimed to
survive a process death: only the earlier independent anchor is durable then.
Callbacks returning thenables, nested fresh/writes, and refresh outside fresh
write scopes are rejected. Do not use `transaction.js` inside the callback or
manually alter the guard's transaction/savepoint.
Unit tests cover logical SQLite outcomes, not power-loss durability. Callbacks
are trusted synchronous code, not an arbitrary-callback sandbox; do not change
transaction state or interfere with the internal savepoint.
