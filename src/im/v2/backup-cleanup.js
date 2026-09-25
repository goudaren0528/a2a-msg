import { types } from 'node:util';
import { parseImV2Config } from './config.js';

const MESSAGE = 'Maintenance preview rejected';
const ASYNC = Object.getPrototypeOf(async function () {});
const ASYNC_GENERATOR = Object.getPrototypeOf(async function* () {});

function reject(code) {
  const error = new Error(MESSAGE);
  error.code = code;
  throw error;
}

// Read descriptors rather than properties: no caller getter is needed to copy data.
function fields(value, names) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key))) throw new Error();
  const result = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
    Object.defineProperty(result, name, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function copyData(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'object' || types.isProxy(value) || depth > 16 || seen.has(value)) throw new Error();
  seen.add(value);
  let result;
  if (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || value.length > 10000) throw new Error();
    result = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
      result.push(copyData(descriptor.value, seen, depth + 1));
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
    result = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
      Object.defineProperty(result, key, { value: copyData(descriptor.value, seen, depth + 1), enumerable: true, writable: true, configurable: true });
    }
  }
  seen.delete(value);
  return result;
}

function callback(adapter, method) {
  if (adapter === null || typeof adapter !== 'object' || types.isProxy(adapter)) throw new Error();
  const descriptor = Object.getOwnPropertyDescriptor(adapter, method);
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' ||
      types.isProxy(descriptor.value) ||
      types.isAsyncFunction(descriptor.value) || Object.getPrototypeOf(descriptor.value) === ASYNC ||
      Object.getPrototypeOf(descriptor.value) === ASYNC_GENERATOR) throw new Error();
  return descriptor.value;
}

function synchronousResult(result, code) {
  if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
    // A provider Proxy can run a get trap for "then" before the data-copy gate.
    if (types.isProxy(result)) reject(code);
    let then;
    try { then = result.then; } catch { reject(code); }
    if (typeof then === 'function') {
      // Native promises and arbitrary thenables must not generate unhandled rejections.
      try { Promise.resolve(result).then(undefined, () => {}); } catch { /* refuse regardless */ }
      reject(code);
    }
  }
  return result;
}

function validatedConfig(raw) {
  const snapshot = copyData(raw);
  // A disabled/paused parser normally supplies defaults; the preview cannot infer
  // a missing full retention policy, maintenance budget or explicit mode.
  for (const name of ['enabled', 'writeMode', 'retention', 'maintenance']) {
    if (!Object.hasOwn(snapshot, name)) throw new Error();
  }
  if (!snapshot.retention || !snapshot.maintenance || !Object.hasOwn(snapshot.retention, 'policy') ||
      !Object.hasOwn(snapshot.retention, 'policyHash')) throw new Error();
  const config = parseImV2Config(snapshot);
  const p = config.retention.policy;
  if (p.effectiveAt <= 0 || !Number.isSafeInteger(p.effectiveAt) ||
      [p.messageRetentionMs, p.attachmentRetentionMs, p.safeRetryWindowMs,
        p.auditRetentionMs, config.maintenance.planTtlMs,
        ...(p.backupRetentionMs === null ? [] : [p.backupRetentionMs])]
        .some(duration => p.effectiveAt > Number.MAX_SAFE_INTEGER - duration)) throw new Error();
  return config;
}

// Compare typed data rather than property order; both copies come from validated
// configuration, so there are no caller aliases or callback-controlled accessors.
function equalData(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every(k => Object.hasOwn(b, k) && equalData(a[k], b[k]));
}

export function createImV2BackupCleanupPreview(options) {
  let authority, policyProvider, authorize, getConfig;
  try {
    ({ authority, policyProvider } = fields(options, ['authority', 'policyProvider']));
    authorize = callback(authority, 'authorize');
    getConfig = callback(policyProvider, 'getConfig');
  } catch { reject('MAINTENANCE_INVALID'); }

  let busy = false;
  let poisoned = false;
  function previewBackupCleanup(request, adminContext) {
    if (busy) { poisoned = true; reject('MAINTENANCE_INVALID'); }
    busy = true;
    try {
      try { fields(request, []); } catch { reject('MAINTENANCE_INVALID'); }
      const gate = () => {
        let authorized;
        try { authorized = synchronousResult(authorize.call(authority, adminContext), 'MAINTENANCE_INVALID'); }
        catch { reject('MAINTENANCE_AUTH_DENIED'); }
        if (poisoned || authorized !== true) reject('MAINTENANCE_AUTH_DENIED');
      };
      const config = () => {
        let result;
        try { result = synchronousResult(getConfig.call(policyProvider), 'MAINTENANCE_INVALID'); }
        catch { reject('MAINTENANCE_POLICY_INVALID'); }
        if (poisoned) reject('MAINTENANCE_POLICY_INVALID');
        try { return validatedConfig(result); } catch { reject('MAINTENANCE_POLICY_INVALID'); }
      };
      gate();
      const initial = config();
      gate();
      const final = config();
      gate();
      if (!equalData(initial, final)) reject('MAINTENANCE_POLICY_STALE');
      if (poisoned) reject('MAINTENANCE_AUTH_DENIED');
      return Object.freeze({
        version: 1, scope: 'configuration-only', executable: false,
        configuredBackupRetentionMs: initial.retention.policy.backupRetentionMs,
        backupRetentionMs: null,
        reasons: Object.freeze(['BACKUP_TTL_UNCONFIRMED', 'BACKUP_DELETE_UNAVAILABLE', 'REGISTRY_ENUMERATION_UNAVAILABLE']),
        protectedRefs: Object.freeze([]), complete: false, nextCursor: null,
      });
    } finally { busy = false; poisoned = false; }
  }
  return Object.freeze({ previewBackupCleanup });
}
