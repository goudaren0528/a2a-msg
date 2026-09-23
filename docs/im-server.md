# IM center entry point (not deployed)

`createImCenter({ db, policy, clock, onCommitted, trustedTimers })` in `src/im/server.js` checks the immutable IM schema, shares one clock guard on the supplied connection, and composes auth, ACL, messages, delivery and the HTTP handler. It returns `{ handler, close, guard, modules }`. The caller owns database creation, schema migration, listener, credentials, and shutdown; this factory does not enable IM, open or close the DB, or migrate anything. An absent policy is disabled, and writing defaults to paused. Administrator registration and credential issuance are **not** exposed through HTTP.

For an explicitly approved, existing migrated DB, run `node scripts/im-center.mjs <existing-config.json>`. This is an opt-in entry point, **not** a default npm start command. Supply the pre-existing configuration file by absolute path; `dbPath` and, for direct TLS, `tls.keyPath` and `tls.certPath` must also be absolute paths to existing regular files (not symlinks, directories, or SQLite `:memory:`/URI names). The paths are not resolved against the process working directory. The DB must have the migrated IM schema and the `policy` must match `src/im/config.js`. Example deliberately disabled and paused:

```json
{
  "dbPath": "<existing-migrated-database-path>",
  "policy": {
    "enabled": false,
    "writeMode": "paused",
    "transport": { "mode": "local-test", "serverUrl": "http://127.0.0.1:8787" }
  }
}
```

`local-test` binds loopback HTTP only, never a LAN address. For direct TLS use `transport: {"mode":"direct-tls","serverUrl":"https://<approved-host>:<port>"}` and explicit `tls: {"keyPath":"<absolute-key-path>","certPath":"<absolute-certificate-path>"}`. Configure and protect certs and keys outside this repository; proxy-forwarded headers cannot substitute for TLS. No policy, no transport, malformed policy, missing DB, or mismatched schema prevents listener startup. The script first verifies the existing DB schema through a read-only connection, then opens it writable; directory permissions and ownership **must** prevent path replacement between these opens. This is not a guarantee against concurrent replacement in an untrusted directory. The script enables SQLite FK and FULL synchronization but never runs migration. The HTTP host limits header bytes, header count, request time, and connections. Additional host-level rate/connection limits and operational approval are required for actual deployment; localhost tests are **not** proof of internet availability.

The legacy `createServer` accepts an optional injected `imHandler`; it forwards only the exact `/api/v1` prefix to that handler **before** IP-to-member authentication. With no handler, or a handler declining a versioned request, the boundary responds `IM_DISABLED` (503). Other paths retain their legacy routing and IP identity. No default process mounts an enabled IM handler. Stop new writes before a planned shutdown; this entry point does not implement backup, release or migration procedures.
