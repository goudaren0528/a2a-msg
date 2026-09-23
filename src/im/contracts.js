import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PROTOCOL = 'a2a-msg.im.v1';
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const errors = Object.freeze({
  INVALID_REQUEST: [400, false, 'Invalid request'],
  UNSUPPORTED_VERSION: [400, false, 'Unsupported protocol version'],
  INVALID_ATTACHMENT: [400, false, 'Invalid attachment'],
  AUTH_REQUIRED: [401, false, 'Authentication required'],
  INVALID_CREDENTIAL: [401, false, 'Invalid credential'],
  TLS_REQUIRED: [403, false, 'TLS required'],
  OPERATION_FORBIDDEN: [403, false, 'Operation forbidden'],
  RESOURCE_NOT_FOUND: [404, false, 'Resource not found'],
  IDEMPOTENCY_CONFLICT: [409, false, 'Idempotency conflict'],
  LEASE_CONFLICT: [409, true, 'Receive lease conflict'],
  STALE_FENCE: [409, false, 'Stale receive fence'],
  LEASE_EXPIRED: [409, true, 'Receive lease expired'],
  DELIVERY_REQUIRED: [409, false, 'Delivery acknowledgement required'],
  SYNC_BLOCKED: [409, true, 'Synchronization blocked'],
  CURSOR_RESET_REQUIRED: [410, false, 'Cursor reset required'],
  IDEMPOTENCY_WINDOW_EXPIRED: [410, false, 'Idempotency window expired'],
  PAYLOAD_TOO_LARGE: [413, false, 'Payload too large'],
  RATE_LIMITED: [429, true, 'Rate limited'],
  IM_DISABLED: [503, false, 'IM disabled'],
  NEW_WRITES_DISABLED: [503, false, 'New writes disabled'],
  POLICY_NOT_CONFIGURED: [503, false, 'Required policy not configured'],
  STORAGE_UNAVAILABLE: [503, true, 'Storage unavailable'],
  CLOCK_UNSAFE: [503, false, 'Server clock unsafe'],
});

export class ImError extends Error {
  constructor(code) {
    const detail = errors[code];
    if (!detail) throw new TypeError('Unknown IM error code');
    super(detail[2]);
    this.name = 'ImError';
    this.code = code;
    this.status = detail[0];
    this.retryable = detail[1];
  }
}

const uuid = z.string().uuid();
const attachmentSchema = z.object({
  name: z.string().min(1).max(200).refine(name =>
    name !== '.' && !name.includes('..') && !/[\\/\x00-\x1f\x7f]/.test(name),
  ),
  mime: z.string().min(1).max(100).nullable().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  dataBase64: z.string(),
}).strict();

export const messageRequestSchema = z.object({
  protocol: z.literal(PROTOCOL),
  conversationId: uuid,
  recipientAgentId: uuid,
  clientMessageId: uuid,
  title: z.string().max(100).nullable().optional(),
  text: z.string().max(32_000).optional(),
  attachment: attachmentSchema.nullable().optional(),
  inReplyTo: uuid.nullable().optional(),
  correlation: z.string().max(200).nullable().optional(),
}).strict();

function canonicalBase64(encoded) {
  if (encoded.length % 4 !== 0) return false;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  for (let i = 0; i < encoded.length - padding; i++) {
    const c = encoded.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
          (c >= 48 && c <= 57) || c === 43 || c === 47)) return false;
  }
  for (let i = encoded.length - padding; i < encoded.length; i++) {
    if (encoded.charCodeAt(i) !== 61) return false;
  }
  return true;
}

export function normalizeMessageRequest(raw, { maxAttachmentBytes = MAX_ATTACHMENT_BYTES } = {}) {
  if (!Number.isSafeInteger(maxAttachmentBytes) || maxAttachmentBytes < 1 || maxAttachmentBytes > MAX_ATTACHMENT_BYTES) {
    throw new ImError('INVALID_REQUEST');
  }
  if (raw?.protocol !== undefined && raw.protocol !== PROTOCOL) throw new ImError('UNSUPPORTED_VERSION');
  const parsed = messageRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ImError(raw?.attachment && !attachmentSchema.safeParse(raw.attachment).success
      ? 'INVALID_ATTACHMENT' : 'INVALID_REQUEST');
  }
  const { attachment: inputAttachment, ...request } = parsed.data;
  let attachment = null;
  if (inputAttachment) {
    const encoded = inputAttachment.dataBase64;
    const maxEncoded = Math.ceil(maxAttachmentBytes / 3) * 4;
    if (encoded.length > maxEncoded) throw new ImError('PAYLOAD_TOO_LARGE');
    if (!canonicalBase64(encoded)) {
      throw new ImError('INVALID_ATTACHMENT');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > maxAttachmentBytes) throw new ImError('PAYLOAD_TOO_LARGE');
    if (bytes.length === 0 || bytes.toString('base64') !== encoded ||
        createHash('sha256').update(bytes).digest('hex') !== inputAttachment.sha256) {
      throw new ImError('INVALID_ATTACHMENT');
    }
    attachment = {
      name: inputAttachment.name,
      mime: inputAttachment.mime ?? null,
      size: bytes.length,
      sha256: inputAttachment.sha256,
      bytes,
    };
  }
  if (!(request.text ?? '').length && !attachment) throw new ImError('INVALID_REQUEST');
  return {
    ...request,
    title: request.title ?? null,
    text: request.text ?? '',
    attachment,
    inReplyTo: request.inReplyTo ?? null,
    correlation: request.correlation ?? null,
  };
}

export function fingerprintMessage(normalized) {
  const { protocol, conversationId, recipientAgentId, clientMessageId, title, text,
    attachment, inReplyTo, correlation } = normalized;
  const payload = [protocol, conversationId, recipientAgentId, clientMessageId, title, text,
    attachment && [attachment.name, attachment.mime, attachment.size, attachment.sha256],
    inReplyTo, correlation];
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
