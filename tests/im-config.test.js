import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImError } from '../src/im/contracts.js';
import { parseImConfig } from '../src/im/config.js';

const policy = () => ({
  messageRetentionMs: 30 * 86400000,
  attachmentRetentionMs: 20 * 86400000,
  idempotencyRetentionMs: 31 * 86400000,
  safeRetryWindowMs: 7 * 86400000,
});
const enabled = () => ({ enabled: true, writeMode: 'enabled',
  transport: { mode: 'local-test', serverUrl: 'http://127.0.0.1:8787' },
  retention: { policy: policy() }, lease: { ttlMs: 90000, renewalMs: 30000 } });
const rejects = (config, code) => assert.throws(() => parseImConfig(config),
  e => e instanceof ImError && e.code === code);

test('disabled defaults and explicit complete test policy', () => {
  assert.equal(parseImConfig().enabled, false);
  assert.equal(parseImConfig().writeMode, 'paused');
  assert.equal(parseImConfig({ enabled: false }).retention, undefined);
  const config = parseImConfig(enabled());
  assert.equal(config.lease.ttlMs, 90000);
  assert.equal(config.limits.maxAttachmentBytes, 10 * 1024 * 1024);
});

test('explicit undefined optional defaults remain complete and cannot mutate subsequent defaults', () => {
  const config = parseImConfig({ enabled: undefined, writeMode: undefined, limits: undefined });
  assert.equal(config.enabled, false);
  assert.equal(config.writeMode, 'paused');
  assert.deepEqual(config.limits, parseImConfig().limits);
  config.limits.maxAttachmentBytes = 1;
  assert.equal(parseImConfig().limits.maxAttachmentBytes, 10 * 1024 * 1024);
  const live = parseImConfig({ ...enabled(), limits: undefined });
  assert.equal(live.limits.maxAttachmentBytes, 10 * 1024 * 1024);
  assert.equal(parseImConfig({ ...enabled(), writeMode: undefined }).writeMode, 'paused');
  rejects({ ...enabled(), limits: { maxAttachmentBytes: 100 } }, 'INVALID_REQUEST');
});

test('enabled requires safe transport even while paused; unknown/insecure keys rejected', () => {
  rejects({ enabled: true }, 'POLICY_NOT_CONFIGURED');
  rejects({ enabled: true, transport: { mode: 'proxy-tls', serverUrl: 'https://example.test' } }, 'INVALID_REQUEST');
  rejects({ enabled: true, transport: { mode: 'direct-tls', serverUrl: 'http://example.test' } }, 'TLS_REQUIRED');
  rejects({ enabled: true, transport: { mode: 'local-test', serverUrl: 'http://127evil.test' } }, 'TLS_REQUIRED');
  rejects({ enabled: true, transport: { mode: 'local-test', serverUrl: 'http://192.168.1.2' } }, 'TLS_REQUIRED');
  rejects({ enabled: true, transport: { mode: 'direct-tls', serverUrl: 'https://u:p@example.test' } }, 'INVALID_REQUEST');
  rejects({ enabled: true, transport: { mode: 'direct-tls', serverUrl: 'https://example.test/?token=x' } }, 'INVALID_REQUEST');
  rejects({ ...enabled(), skipTLS: true }, 'INVALID_REQUEST');
  rejects({ ...enabled(), transport: { ...enabled().transport, insecure: true } }, 'INVALID_REQUEST');
  assert.equal(parseImConfig({ enabled: true, transport: { mode: 'local-test', serverUrl: 'http://[::1]:8787' } }).writeMode, 'paused');
  assert.equal(parseImConfig({ enabled: true, transport: { mode: 'direct-tls', serverUrl: 'https://example.test' } }).writeMode, 'paused');
});

test('write policies fail closed for absent, incomplete or incoherent retention and lease', () => {
  rejects({ ...enabled(), retention: undefined }, 'POLICY_NOT_CONFIGURED');
  rejects({ ...enabled(), retention: { policy: { messageRetentionMs: 100 } } }, 'POLICY_NOT_CONFIGURED');
  rejects({ ...enabled(), lease: undefined }, 'POLICY_NOT_CONFIGURED');
  rejects({ ...enabled(), lease: { ttlMs: 90000 } }, 'POLICY_NOT_CONFIGURED');
  rejects({ ...enabled(), lease: { ttlMs: 100, renewalMs: 100 } }, 'POLICY_NOT_CONFIGURED');
  rejects({ ...enabled(), retention: { policy: { ...policy(), idempotencyRetentionMs: 1 } } }, 'POLICY_NOT_CONFIGURED');
  rejects({ ...enabled(), retention: { policy: { ...policy(), attachmentRetentionMs: policy().messageRetentionMs + 1 } } }, 'POLICY_NOT_CONFIGURED');
  rejects({ ...enabled(), limits: { ...parseImConfig().limits, maxAttachmentBytes: 10 * 1024 * 1024 + 1 } }, 'INVALID_REQUEST');
});
