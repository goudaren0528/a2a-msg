import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_POLICY, DEFAULT_MAINTENANCE } from '../src/im/v2/config.js';
import { createImV2BackupCleanupPreview } from '../src/im/v2/backup-cleanup.js';

const message = 'Maintenance preview rejected';
const policyKeys = Object.keys(DEFAULT_POLICY);
const ordered = ['version','scope','executable','configuredBackupRetentionMs','backupRetentionMs','reasons','protectedRefs','complete','nextCursor'];
function configuration(ttl = null) {
  const policy = { ...DEFAULT_POLICY, effectiveAt: 1, backupRetentionMs: ttl };
  const policyHash = createHash('sha256').update(JSON.stringify(Object.fromEntries(policyKeys.map(k => [k, policy[k]])))).digest('hex');
  return { enabled: false, writeMode: 'paused', retention: { policy, policyHash }, maintenance: { ...DEFAULT_MAINTENANCE, maxKeyReservations: 1 } };
}
function factory({ authorize = () => true, getConfig = () => configuration() } = {}) {
  return createImV2BackupCleanupPreview({ authority: { authorize }, policyProvider: { getConfig } });
}
function rejected(fn, code) {
  assert.throws(fn, error => error instanceof Error && error.code === code && error.message === message && !Object.hasOwn(error, 'cause'));
}

test('canonical ordered detached deep-frozen diagnostic, null and configured positive TTL', () => {
  for (const ttl of [null, 86400000, 2592000000]) {
    const mutable = configuration(ttl);
    const view = factory({ getConfig: () => mutable });
    assert.deepEqual(Object.keys(view), ['previewBackupCleanup']);
    assert(Object.isFrozen(view));
    const result = view.previewBackupCleanup({}, {});
    assert.deepEqual(Object.keys(result), ordered);
    assert.deepEqual(result, { version: 1, scope: 'configuration-only', executable: false,
      configuredBackupRetentionMs: ttl, backupRetentionMs: null,
      reasons: ['BACKUP_TTL_UNCONFIRMED','BACKUP_DELETE_UNAVAILABLE','REGISTRY_ENUMERATION_UNAVAILABLE'],
      protectedRefs: [], complete: false, nextCursor: null });
    mutable.retention.policy.backupRetentionMs = 3;
    assert.equal(result.configuredBackupRetentionMs, ttl);
    assert(Object.isFrozen(result));
    assert(Object.isFrozen(result.reasons));
    assert(Object.isFrozen(result.protectedRefs));
    assert.notEqual(result.configuredBackupRetentionMs, ttl === null ? 2592000000 : null);
  }
});

test('strict constructor/request and no fabricated registry getter access', () => {
  for (const input of [undefined, null, {}, { authority: {}, policyProvider: {} },
    { authority: { authorize: () => true }, policyProvider: { getConfig: () => configuration() }, registry: {} },
    { authority: { authorize: () => true }, policyProvider: { getConfig: () => configuration() }, get registry() { throw new Error('secret'); } }]) {
    rejected(() => createImV2BackupCleanupPreview(input), 'MAINTENANCE_INVALID');
  }
  const preview = factory().previewBackupCleanup;
  for (const input of [undefined, null, { cursor: 'x' }, { limit: 1 }, { databasePath: '/secret' },
    { registry: {} }, { get path() { throw new Error('secret'); } }, Object.create(null)]) {
    rejected(() => preview(input, {}), 'MAINTENANCE_INVALID');
  }
});

test('admin literal true before provider disclosure, async zero-prefix and hostile exceptions sanitized', () => {
  let calls = 0;
  for (const auth of [() => 1, () => 'true', () => Promise.resolve(true), () => { throw { get code() { throw Error('secret'); }, get message() { throw Error('secret'); } }; }]) {
    rejected(() => factory({ authorize: auth, getConfig: () => { calls++; return configuration(); } }).previewBackupCleanup({}, {}), 'MAINTENANCE_AUTH_DENIED');
  }
  assert.equal(calls, 0);
  let prefix = 0;
  rejected(() => factory({ authorize: async () => { prefix++; return true; } }).previewBackupCleanup({}, {}), 'MAINTENANCE_INVALID');
  rejected(() => factory({ getConfig: async function* () { prefix++; yield configuration(); } }).previewBackupCleanup({}, {}), 'MAINTENANCE_INVALID');
  assert.equal(prefix, 0);
  rejected(() => factory({ getConfig: () => { throw { get code() { throw Error('secret'); }, get message() { throw Error('secret'); } }; } }).previewBackupCleanup({}, {}), 'MAINTENANCE_POLICY_INVALID');
  rejected(() => factory({ getConfig: () => ({ get then() { throw Error('secret'); } }) }).previewBackupCleanup({}, {}), 'MAINTENANCE_POLICY_INVALID');
  rejected(() => factory({ getConfig: () => Promise.reject(Error('secret')) }).previewBackupCleanup({}, {}), 'MAINTENANCE_POLICY_INVALID');
  rejected(() => factory({ authorize: () => Promise.reject(Error('secret')) }).previewBackupCleanup({}, {}), 'MAINTENANCE_AUTH_DENIED');
});

test('strict complete policy and TTL arithmetic, with no thirty-day inferred default', () => {
  for (const ttl of [0, -1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1, '2592000000']) {
    rejected(() => factory({ getConfig: () => configuration(ttl) }).previewBackupCleanup({}, {}), 'MAINTENANCE_POLICY_INVALID');
  }
  for (const change of [cfg => delete cfg.retention, cfg => delete cfg.retention.policyHash,
    cfg => delete cfg.retention.policy, cfg => delete cfg.maintenance,
    cfg => { cfg.retention.policy.effectiveAt = Number.MAX_SAFE_INTEGER; },
    cfg => { cfg.retention.policy.backupCleanupEnabled = true; },
    cfg => { cfg.retention.policy.extra = 'not allowed'; },
    cfg => { cfg.maintenance.maxRows = 101; }]) {
    const cfg = configuration(); change(cfg);
    rejected(() => factory({ getConfig: () => cfg }).previewBackupCleanup({}, {}), 'MAINTENANCE_POLICY_INVALID');
  }
});

test('dynamic config/admin revocation and insertion order normalization', () => {
  const config = configuration(20);
  let n = 0;
  rejected(() => factory({ getConfig: () => { n++; return n === 1 ? config : configuration(21); } }).previewBackupCleanup({}, {}), 'MAINTENANCE_POLICY_STALE');
  let gate = 0;
  rejected(() => factory({ authorize: () => ++gate < 3 }).previewBackupCleanup({}, {}), 'MAINTENANCE_AUTH_DENIED');
  const reordered = Object.fromEntries(Object.entries(config).reverse());
  reordered.retention = Object.fromEntries(Object.entries(config.retention).reverse());
  reordered.retention.policy = Object.fromEntries(Object.entries(config.retention.policy).reverse());
  assert.equal(factory({ getConfig: () => ++n % 2 ? reordered : config }).previewBackupCleanup({}, {}).configuredBackupRetentionMs, 20);
});

test('caught reentry poisons outer call; no forbidden dependency imports', () => {
  let preview;
  preview = factory({ getConfig: () => {
    rejected(() => preview({}, {}), 'MAINTENANCE_INVALID');
    return configuration();
  } }).previewBackupCleanup;
  rejected(() => preview({}, {}), 'MAINTENANCE_POLICY_INVALID');
  const source = readFileSync(new URL('../src/im/v2/backup-cleanup.js', import.meta.url), 'utf8');
  assert(!/from\s*['"][^'"]*(?:registry|sqlite|database|node:fs|maintenance-read-target)/i.test(source));
});

test('proxy request is refused before traps or nested preview; normal retry succeeds', () => {
  const preview = factory().previewBackupCleanup;
  let traps = 0;
  const input = new Proxy({}, { ownKeys() {
    traps++;
    try { preview({}, {}); } catch { /* detect any reentrant execution */ }
    return [];
  }, getPrototypeOf() { traps++; return Object.prototype; } });
  rejected(() => preview(input, {}), 'MAINTENANCE_INVALID');
  assert.equal(traps, 0);
  assert.equal(preview({}, {}).scope, 'configuration-only');
});

test('proxy options/adapters rejected without traps, getters or callback invocation', () => {
  let traps = 0;
  let callbacks = 0;
  const guard = { ownKeys() { traps++; return []; }, getPrototypeOf() { traps++; return Object.prototype; },
    getOwnPropertyDescriptor() { traps++; return undefined; }, get() { traps++; return undefined; } };
  const authority = { authorize() { callbacks++; return true; } };
  const policyProvider = { getConfig() { callbacks++; return configuration(); } };
  for (const options of [
    new Proxy({ authority, policyProvider }, guard),
    { authority: new Proxy(authority, guard), policyProvider },
    { authority, policyProvider: new Proxy(policyProvider, guard) },
    { authority: { authorize: new Proxy(authority.authorize, guard) }, policyProvider },
    { authority, policyProvider: { getConfig: new Proxy(policyProvider.getConfig, guard) } },
  ]) rejected(() => createImV2BackupCleanupPreview(options), 'MAINTENANCE_INVALID');
  assert.equal(traps, 0);
  assert.equal(callbacks, 0);
  const revoked = Proxy.revocable({ authority, policyProvider }, {});
  revoked.revoke();
  rejected(() => createImV2BackupCleanupPreview(revoked.proxy), 'MAINTENANCE_INVALID');
});

test('recursive proxy configuration refusal blocks mutation during second snapshot', () => {
  let traps = 0;
  const guard = { ownKeys() { traps++; return []; }, getPrototypeOf() { traps++; return Object.prototype; },
    getOwnPropertyDescriptor() { traps++; return undefined; }, get() { traps++; return undefined; } };
  for (const location of ['top', 'nested', 'revoked']) {
    const live = configuration(20);
    let calls = 0;
    const returned = configuration(20);
    let payload;
    if (location === 'top') payload = new Proxy(returned, guard);
    if (location === 'nested') payload = { ...returned, retention: { ...returned.retention, policy: new Proxy(returned.retention.policy, guard) } };
    if (location === 'revoked') {
      const revocable = Proxy.revocable(returned.maintenance, guard);
      revocable.revoke();
      payload = { ...returned, maintenance: revocable.proxy };
    }
    rejected(() => factory({ getConfig: () => ++calls === 1 ? live : payload }).previewBackupCleanup({}, {}), 'MAINTENANCE_POLICY_INVALID');
    assert.equal(calls, 2);
  }
  assert.equal(traps, 0);
});

test('provider result Proxy never reads then or mutates live TTL, first and second call', () => {
  for (const position of [1, 2]) {
    const live = configuration(20);
    let calls = 0;
    let gets = 0;
    const proxy = new Proxy(configuration(20), { get(_target, key) {
      gets++;
      if (key === 'then') live.retention.policy.backupRetentionMs = 21;
      throw Error('secret');
    } });
    const view = factory({ getConfig: () => ++calls === position ? proxy : live });
    rejected(() => view.previewBackupCleanup({}, {}), 'MAINTENANCE_POLICY_INVALID');
    assert.equal(calls, position);
    assert.equal(gets, 0);
    assert.equal(live.retention.policy.backupRetentionMs, 20);
    assert.equal(view.previewBackupCleanup({}, {}).configuredBackupRetentionMs, 20);
  }
  const revoked = Proxy.revocable(configuration(20), { get() { throw Error('secret'); } });
  revoked.revoke();
  rejected(() => factory({ getConfig: () => revoked.proxy }).previewBackupCleanup({}, {}), 'MAINTENANCE_POLICY_INVALID');
  const proxiedFunction = new Proxy(function () {}, { get() { throw Error('secret'); } });
  rejected(() => factory({ getConfig: () => proxiedFunction }).previewBackupCleanup({}, {}), 'MAINTENANCE_POLICY_INVALID');
});

test('plain shared configuration mutation during second snapshot is stale', () => {
  const live = configuration(20);
  let calls = 0;
  const view = factory({ getConfig: () => {
    if (++calls === 2) {
      live.retention.policy.backupRetentionMs = 21;
      live.retention.policyHash = createHash('sha256').update(JSON.stringify(Object.fromEntries(policyKeys.map(k => [k, live.retention.policy[k]])))).digest('hex');
    }
    return live;
  } });
  rejected(() => view.previewBackupCleanup({}, {}), 'MAINTENANCE_POLICY_STALE');
});
