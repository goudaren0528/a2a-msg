import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { ImError, MAX_ATTACHMENT_BYTES } from './contracts.js';

const positive = z.number().int().positive().safe();
const schema = z.object({
  enabled: z.boolean().optional(),
  writeMode: z.enum(['paused', 'enabled']).optional(),
  transport: z.object({
    mode: z.enum(['local-test', 'direct-tls']),
    serverUrl: z.string().min(1),
  }).strict().optional(),
  retention: z.object({
    policy: z.object({
      messageRetentionMs: positive,
      attachmentRetentionMs: positive,
      idempotencyRetentionMs: positive,
      safeRetryWindowMs: positive,
    }).strict(),
  }).strict().optional(),
  lease: z.object({ ttlMs: positive, renewalMs: positive }).strict().optional(),
  limits: z.object({
    maxAttachmentBytes: positive.max(MAX_ATTACHMENT_BYTES),
    maxBodyBytes: positive.max(64 * 1024),
    maxFileBodyBytes: positive.max(16 * 1024 * 1024),
    maxConnections: positive,
    maxRequestsPerMinute: positive,
  }).strict().optional(),
}).strict();

const DEFAULT_LIMITS = Object.freeze({
  maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
  maxBodyBytes: 64 * 1024,
  maxFileBodyBytes: 16 * 1024 * 1024,
  maxConnections: 100,
  maxRequestsPerMinute: 600,
});

function validateTransport(transport) {
  if (!transport) throw new ImError('POLICY_NOT_CONFIGURED');
  let url;
  try { url = new URL(transport.serverUrl); } catch { throw new ImError('INVALID_REQUEST'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ImError('INVALID_REQUEST');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || (ipaddr.isValid(host) && ipaddr.parse(host).range() === 'loopback');
  if (transport.mode === 'local-test') {
    if (!loopback || !['http:', 'https:'].includes(url.protocol)) throw new ImError('TLS_REQUIRED');
  } else if (url.protocol !== 'https:') {
    throw new ImError('TLS_REQUIRED');
  }
}

export function parseImConfig(input = {}) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const incompletePolicy = parsed.error.issues.some(issue =>
      ['retention', 'lease'].includes(issue.path[0]) &&
      issue.code === 'invalid_type' && issue.received === 'undefined');
    throw new ImError(incompletePolicy ? 'POLICY_NOT_CONFIGURED' : 'INVALID_REQUEST');
  }
  const config = {
    ...parsed.data,
    enabled: parsed.data.enabled ?? false,
    writeMode: parsed.data.writeMode ?? 'paused',
    limits: parsed.data.limits ?? { ...DEFAULT_LIMITS },
  };
  if (!config.enabled) return config;
  validateTransport(config.transport);
  if (config.lease && config.lease.renewalMs >= config.lease.ttlMs) {
    throw new ImError('POLICY_NOT_CONFIGURED');
  }
  if (config.writeMode === 'enabled') {
    const policy = config.retention?.policy;
    if (!policy || !config.lease ||
        policy.attachmentRetentionMs > policy.messageRetentionMs ||
        policy.idempotencyRetentionMs < policy.messageRetentionMs ||
        policy.idempotencyRetentionMs < policy.safeRetryWindowMs) {
      throw new ImError('POLICY_NOT_CONFIGURED');
    }
  }
  return config;
}
