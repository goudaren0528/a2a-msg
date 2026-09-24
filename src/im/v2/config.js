import { createHash } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { ImV2Error, MAX_ATTACHMENT_BYTES, MAX_JSON_BODY_BYTES, MAX_FILE_BODY_BYTES } from './contracts.js';

const positive=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const ms=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash=z.string().regex(/^[0-9a-f]{64}$/);
const policySchema=z.object({
  version:z.literal(2),effectiveAt:ms,messageRetentionMs:z.literal(7776000000),
  attachmentRetentionMs:z.literal(7776000000),safeRetryWindowMs:z.literal(604800000),
  auditRetentionMs:z.literal(15552000000),keyReservation:z.literal('indefinite'),
  expiryEnabled:z.boolean(),purgeEnabled:z.boolean(),backupCleanupEnabled:z.boolean(),backupRetentionMs:positive.nullable(),
}).strict();
const POLICY_KEYS=Object.freeze(['version','effectiveAt','messageRetentionMs','attachmentRetentionMs','safeRetryWindowMs',
  'auditRetentionMs','keyReservation','expiryEnabled','purgeEnabled','backupCleanupEnabled','backupRetentionMs']);
const maintenanceSchema=z.object({maxRows:positive.max(100),maxBytes:positive.max(10485760),
  maxScanRows:positive.max(10000),maxScanBytes:positive.max(104857600),maxScanMs:positive.max(1000),
  maxWriteMs:positive.max(1000),planTtlMs:positive.max(300000),maxForwardJumpMs:positive.max(86400000),
  maxKeyReservations:positive}).strict();
const limitsSchema=z.object({maxAttachmentBytes:positive.max(MAX_ATTACHMENT_BYTES),maxBodyBytes:positive.max(MAX_JSON_BODY_BYTES),
  maxFileBodyBytes:positive.max(MAX_FILE_BODY_BYTES),maxConnections:positive,maxRequestsPerMinute:positive}).strict();
const configSchema=z.object({enabled:z.boolean().optional(),writeMode:z.enum(['paused','enabled']).optional(),
  transport:z.object({mode:z.enum(['local-test','direct-tls']),serverUrl:z.string().min(1)}).strict().optional(),
  retention:z.object({policy:policySchema,policyHash:hash}).strict().optional(),
  lease:z.object({ttlMs:positive,renewalMs:positive}).strict().optional(),limits:limitsSchema.optional(),
  maintenance:maintenanceSchema.optional(),
}).strict();
export const DEFAULT_POLICY = Object.freeze({version:2,effectiveAt:0,messageRetentionMs:7776000000,
  attachmentRetentionMs:7776000000,safeRetryWindowMs:604800000,auditRetentionMs:15552000000,
  keyReservation:'indefinite',expiryEnabled:false,purgeEnabled:false,backupCleanupEnabled:false,backupRetentionMs:null});
export const DEFAULT_MAINTENANCE = Object.freeze({maxRows:100,maxBytes:10485760,maxScanRows:10000,
  maxScanBytes:104857600,maxScanMs:1000,maxWriteMs:1000,planTtlMs:300000,maxForwardJumpMs:86400000});
const DEFAULT_LIMITS=Object.freeze({maxAttachmentBytes:MAX_ATTACHMENT_BYTES,maxBodyBytes:MAX_JSON_BODY_BYTES,
  maxFileBodyBytes:MAX_FILE_BODY_BYTES,maxConnections:100,maxRequestsPerMinute:600});

export function hashRetentionPolicy(policy) {
  const result=policySchema.safeParse(policy);
  if (!result.success) throw new ImV2Error('INVALID_REQUEST');
  const canonical=Object.fromEntries(POLICY_KEYS.map(key=>[key,result.data[key]]));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
function transportCheck({mode,serverUrl}) {
  let url;
  try { url=new URL(serverUrl); } catch { throw new ImV2Error('INVALID_REQUEST'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname!=='/')
    throw new ImV2Error('INVALID_REQUEST');
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const loopback=host==='localhost' || (ipaddr.isValid(host) && ipaddr.parse(host).range()==='loopback');
  if (mode==='local-test' ? !loopback : url.protocol!=='https:') throw new ImV2Error('TLS_REQUIRED');
  // A URL cannot establish TLS certificate validity. Runtime TLS must verify the actual peer.
}
function safeDeadline(start,duration) { return start<=Number.MAX_SAFE_INTEGER-duration; }
function freezeTree(value) {
  if (value && typeof value==='object') { for (const child of Object.values(value)) freezeTree(child); Object.freeze(value); }
  return value;
}
export function parseImV2Config(input={}) {
  const parsed=configSchema.safeParse(input);
  if (!parsed.success) throw new ImV2Error('INVALID_REQUEST');
  const raw=parsed.data;
  const enabled=raw.enabled??false,writeMode=raw.writeMode??'paused';
  if (raw.retention && hashRetentionPolicy(raw.retention.policy)!==raw.retention.policyHash) throw new ImV2Error('POLICY_NOT_CONFIGURED');
  if (raw.lease && raw.lease.renewalMs>=raw.lease.ttlMs) throw new ImV2Error('POLICY_NOT_CONFIGURED');
  if (raw.transport) transportCheck(raw.transport);
  const limits=raw.limits??(!enabled && writeMode==='paused' ? DEFAULT_LIMITS : null);
  const maintenance=raw.maintenance??(!enabled && writeMode==='paused' ? {...DEFAULT_MAINTENANCE,maxKeyReservations:null} : null);
  if (enabled || writeMode==='enabled') {
    if (!raw.transport || !raw.retention || !raw.lease || !raw.limits || !raw.maintenance ||
        raw.retention.policy.effectiveAt===0 || !safeDeadline(raw.retention.policy.effectiveAt,raw.retention.policy.messageRetentionMs) ||
        !safeDeadline(raw.retention.policy.effectiveAt,raw.retention.policy.auditRetentionMs) ||
        !safeDeadline(raw.retention.policy.effectiveAt,raw.retention.policy.safeRetryWindowMs) ||
        !safeDeadline(raw.retention.policy.effectiveAt,raw.lease.ttlMs) ||
        !safeDeadline(raw.retention.policy.effectiveAt,raw.maintenance.planTtlMs)) throw new ImV2Error('POLICY_NOT_CONFIGURED');
  }
  if (raw.retention && (raw.retention.policy.purgeEnabled && !raw.retention.policy.expiryEnabled ||
      raw.retention.policy.backupCleanupEnabled && raw.retention.policy.backupRetentionMs===null ||
      raw.retention.policy.backupRetentionMs!==null && !safeDeadline(raw.retention.policy.effectiveAt,raw.retention.policy.backupRetentionMs))) throw new ImV2Error('POLICY_NOT_CONFIGURED');
  if (raw.retention && ![raw.retention.policy.messageRetentionMs,raw.retention.policy.attachmentRetentionMs,
    raw.retention.policy.auditRetentionMs,raw.retention.policy.safeRetryWindowMs].every(duration=>safeDeadline(raw.retention.policy.effectiveAt,duration))) throw new ImV2Error('POLICY_NOT_CONFIGURED');
  return freezeTree({enabled,writeMode,transport:raw.transport??null,retention:raw.retention??null,
    lease:raw.lease??null,limits,maintenance});
}
