import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ImError, PROTOCOL, MAX_ATTACHMENT_BYTES, normalizeMessageRequest, fingerprintMessage } from '../src/im/contracts.js';

const base = () => ({ protocol: PROTOCOL, conversationId: randomUUID(), recipientAgentId: randomUUID(),
  clientMessageId: randomUUID(), text: '  message  ' });
const file = (data = Buffer.from('attachment')) => ({ name: 'report.txt', mime: 'text/plain',
  sha256: createHash('sha256').update(data).digest('hex'), dataBase64: data.toString('base64') });
const rejected = (fn, code) => assert.throws(fn, e => e instanceof ImError && e.code === code &&
  !e.message.includes('secret'));

test('strict input, null title, file-only and normalization preserve meaning', () => {
  const request = base();
  const normal = normalizeMessageRequest({ ...request, title: null });
  assert.equal(normal.title, null);
  assert.equal(normal.text, '  message  ');
  assert.equal(normal.attachment, null);
  const onlyFile = normalizeMessageRequest({ ...request, text: '', attachment: file() });
  assert.equal(onlyFile.text, '');
  assert.deepEqual(onlyFile.attachment.bytes, Buffer.from('attachment'));
  assert.equal(onlyFile.attachment.size, 10);
  rejected(() => normalizeMessageRequest({ ...request, text: '', attachment: null }), 'INVALID_REQUEST');
  rejected(() => normalizeMessageRequest({ ...request, sender: 'secret' }), 'INVALID_REQUEST');
  rejected(() => normalizeMessageRequest({ ...request, protocol: 'old' }), 'UNSUPPORTED_VERSION');
  rejected(() => normalizeMessageRequest({ ...request, title: 'a'.repeat(101) }), 'INVALID_REQUEST');
  rejected(() => normalizeMessageRequest({ ...request, text: 'a'.repeat(32001) }), 'INVALID_REQUEST');
});

test('canonical base64, safe basename, digest and bounded bytes', () => {
  const request = base();
  rejected(() => normalizeMessageRequest({ ...request, attachment: { ...file(), name: '../x' } }), 'INVALID_ATTACHMENT');
  rejected(() => normalizeMessageRequest({ ...request, attachment: { ...file(), extra: 'secret' } }), 'INVALID_ATTACHMENT');
  rejected(() => normalizeMessageRequest({ ...request, attachment: { ...file(), dataBase64: 'YQ==' } }), 'INVALID_ATTACHMENT');
  rejected(() => normalizeMessageRequest({ ...request, attachment: { ...file(), dataBase64: 'YR==' } }), 'INVALID_ATTACHMENT');
  rejected(() => normalizeMessageRequest({ ...request, attachment: { ...file(), sha256: '0'.repeat(64) } }), 'INVALID_ATTACHMENT');
  rejected(() => normalizeMessageRequest({ ...request, attachment: file(Buffer.alloc(2)) }, { maxAttachmentBytes: 1 }), 'PAYLOAD_TOO_LARGE');
  rejected(() => normalizeMessageRequest(request, { maxAttachmentBytes: 10 * 1024 * 1024 + 1 }), 'INVALID_REQUEST');
});

test('maximum 10 MiB canonical attachment succeeds; oversized and malformed near-limit input fails with typed errors', () => {
  const request = base();
  const maximal = file(Buffer.alloc(MAX_ATTACHMENT_BYTES, 0x61));
  const normalized = normalizeMessageRequest({ ...request, attachment: maximal });
  assert.equal(normalized.attachment.size, MAX_ATTACHMENT_BYTES);
  rejected(() => normalizeMessageRequest({ ...request, attachment: file(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)) }), 'PAYLOAD_TOO_LARGE');
  for (const dataBase64 of [maximal.dataBase64.slice(0, -1) + '!',
    maximal.dataBase64.slice(0, -3) + '=A=', maximal.dataBase64.slice(0, -1)]) {
    rejected(() => normalizeMessageRequest({ ...request, attachment: { ...maximal, dataBase64 } }), 'INVALID_ATTACHMENT');
  }
  for (const text of ['', 'nonempty']) {
    rejected(() => normalizeMessageRequest({ ...request, text, attachment: file(Buffer.alloc(0)) }), 'INVALID_ATTACHMENT');
  }
});

test('fingerprint is deterministic and includes all meaningful fields but not buffer content', () => {
  const request = { ...base(), title: null, attachment: file(), correlation: 'c' };
  const normal = normalizeMessageRequest(request);
  const hash = fingerprintMessage(normal);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, fingerprintMessage(normalizeMessageRequest(request)));
  assert.equal(hash, fingerprintMessage({ ...normal, serverMessageId: randomUUID(), createdAt: Date.now() }));
  assert.notEqual(hash, fingerprintMessage({ ...normal, text: 'other' }));
  assert.notEqual(hash, fingerprintMessage({ ...normal, attachment: { ...normal.attachment, name: 'different' } }));
  assert.notEqual(hash, fingerprintMessage({ ...normal, inReplyTo: randomUUID() }));
  assert.notEqual(hash, fingerprintMessage({ ...normal, recipientAgentId: randomUUID() }));
});

test('error metadata is fixed and safe', () => {
  const err = new ImError('INVALID_CREDENTIAL');
  assert.equal(err.status, 401);
  assert.equal(err.retryable, false);
  assert.throws(() => new ImError('not-an-error'), TypeError);
  const status = {
    INVALID_REQUEST: [400, false], UNSUPPORTED_VERSION: [400, false], INVALID_ATTACHMENT: [400, false],
    AUTH_REQUIRED: [401, false], INVALID_CREDENTIAL: [401, false], TLS_REQUIRED: [403, false],
    OPERATION_FORBIDDEN: [403, false], RESOURCE_NOT_FOUND: [404, false],
    IDEMPOTENCY_CONFLICT: [409, false], LEASE_CONFLICT: [409, true], STALE_FENCE: [409, false],
    LEASE_EXPIRED: [409, true], DELIVERY_REQUIRED: [409, false], SYNC_BLOCKED: [409, true],
    CURSOR_RESET_REQUIRED: [410, false], IDEMPOTENCY_WINDOW_EXPIRED: [410, false],
    PAYLOAD_TOO_LARGE: [413, false], RATE_LIMITED: [429, true], IM_DISABLED: [503, false],
    NEW_WRITES_DISABLED: [503, false], POLICY_NOT_CONFIGURED: [503, false],
    STORAGE_UNAVAILABLE: [503, true], CLOCK_UNSAFE: [503, false],
  };
  for (const [name, [httpStatus, retryable]] of Object.entries(status)) {
    assert.deepEqual([new ImError(name).status, new ImError(name).retryable], [httpStatus, retryable], name);
  }
});
