import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PROTOCOL = 'a2a-msg.im.v2';
export const MAX_ATTACHMENT_BYTES = 10485760;
export const MAX_BATCH_ITEMS = 100;
export const MAX_PREFIX_STEPS = 1000;
export const MAX_CLIENT_PROGRESS_ROUNDS = 10;
export const MAX_JSON_BODY_BYTES = 65536;
export const MAX_FILE_BODY_BYTES = 16777216;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const uuid = z.string().regex(UUID);
const hash = z.string().regex(HEX);
const ms = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = ms.min(1);
const nullableUuid = uuid.nullable();
const title = z.string().max(100).nullable();
const text = z.string().max(32000);
const correlation = z.string().max(200).nullable();
const fileName = z.string().min(1).max(200).refine(v => v !== '.' && !v.includes('..') && !/[\\/\x00-\x1f\x7f]/.test(v));
const mime = z.string().min(1).max(100).nullable();
const list = schema => z.array(schema).max(MAX_BATCH_ITEMS);
const unique = schema => list(schema).min(1).refine(items => new Set(items.map(item => JSON.stringify(item))).size === items.length);

const ERROR_DETAILS = Object.freeze({
  INVALID_REQUEST: [400,false,'Invalid request'], UNSUPPORTED_VERSION: [400,false,'Unsupported protocol version'],
  INVALID_ATTACHMENT: [400,false,'Invalid attachment'], AUTH_REQUIRED: [401,false,'Authentication required'],
  INVALID_CREDENTIAL: [401,false,'Invalid credential'], TLS_REQUIRED: [403,false,'TLS required'],
  OPERATION_FORBIDDEN: [403,false,'Operation forbidden'], RESOURCE_NOT_FOUND: [404,false,'Resource not found'],
  IDEMPOTENCY_CONFLICT: [409,false,'Idempotency conflict'], LEASE_CONFLICT: [409,true,'Receive lease conflict'],
  STALE_FENCE: [409,false,'Stale receive fence'], LEASE_EXPIRED: [409,true,'Receive lease expired'],
  DELIVERY_REQUIRED: [409,false,'Delivery acknowledgement required'], SYNC_BLOCKED: [409,true,'Synchronization blocked'],
  CURSOR_RESET_REQUIRED: [410,false,'Cursor reset required'], IDEMPOTENCY_WINDOW_EXPIRED: [410,false,'Idempotency window expired'],
  PAYLOAD_TOO_LARGE: [413,false,'Payload too large'], RATE_LIMITED: [429,true,'Rate limited'],
  IM_DISABLED: [503,false,'IM disabled'], NEW_WRITES_DISABLED: [503,false,'New writes disabled'],
  POLICY_NOT_CONFIGURED: [503,false,'Required policy not configured'], STORAGE_UNAVAILABLE: [503,true,'Storage unavailable'],
  CLOCK_UNSAFE: [503,false,'Server clock unsafe'],
  PROTOCOL_UPGRADE_REQUIRED: [426,false,'Use /api/v2 with a2a-msg.im.v2'],
  RECOVERY_RECONCILIATION_REQUIRED: [409,false,'Recovery reconciliation required'],
  SEND_OUTCOME_UNKNOWN: [409,false,'Send outcome unknown'], CONTENT_EXPIRED: [410,false,'Content expired'],
  EXPIRY_RECEIPT_REQUIRED: [409,false,'Expiry receipt required'], CONTENT_NOT_EXPIRED: [409,false,'Content not expired'],
  MAINTENANCE_DISABLED: [503,false,'Maintenance disabled'], PLAN_STALE: [409,false,'Plan stale'],
  CAPACITY_EXHAUSTED: [503,false,'Capacity exhausted'],
});
export class ImV2Error extends Error {
  constructor(code) {
    const detail = ERROR_DETAILS[code];
    if (!detail) throw new TypeError('Unknown IM v2 error code');
    super(detail[2]);
    this.name = 'ImV2Error'; this.code = code; this.status = detail[0]; this.retryable = detail[1];
  }
}
export const scopeSchema = z.object({protocol:z.literal(PROTOCOL),centerEpoch:uuid}).strict();
export const fenceSchema = z.object({instanceId:uuid,generation:positive}).strict();
export const operationSchema = z.object({originEpoch:uuid,clientMessageId:uuid}).strict();
export const attachmentSchema = z.object({attachmentId:uuid,name:fileName,mime,size:positive.max(MAX_ATTACHMENT_BYTES),sha256:hash}).strict();
export const messageSchema = z.object({messageId:uuid,conversationId:uuid,senderAgentId:uuid,recipientAgentId:uuid,
  originEpoch:uuid,clientMessageId:uuid,title,text,inReplyTo:nullableUuid,correlation,acceptedAt:ms,expiresAt:ms,
  deliveredAt:ms.nullable(),readAt:ms.nullable(),attachment:attachmentSchema.nullable()}).strict()
  .refine(v => v.text.length>0 || v.attachment!==null);
export const tombstoneSchema = z.object({messageId:uuid,conversationId:uuid,acceptedAt:ms,expiresAt:ms,expiredAt:ms}).strict();
export const historyItemSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('message'),message:messageSchema}).strict(),
  z.object({kind:z.literal('content_expired'),tombstone:tombstoneSchema}).strict(),
]);
export const syncItemSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('message'),centerEpoch:uuid,streamEpoch:uuid,seq:positive,message:messageSchema}).strict(),
  z.object({kind:z.literal('content_expired'),centerEpoch:uuid,streamEpoch:uuid,seq:positive,tombstone:tombstoneSchema}).strict(),
]);
export const deliveryRefSchema = z.object({seq:positive,messageId:uuid}).strict();
const sendAttachment = z.object({name:fileName,mime:mime.optional(),sha256:hash,dataBase64:z.string()}).strict();
export const messageRequestSchema = scopeSchema.extend({originEpoch:uuid,clientMessageId:uuid,conversationId:uuid,
  recipientAgentId:uuid,title:title.optional(),text:text.optional(),attachment:sendAttachment.nullable().optional(),
  inReplyTo:nullableUuid.optional(),correlation:correlation.optional()}).strict();
export const postSchemas = Object.freeze({
  conversation:scopeSchema.extend({peerAgentId:uuid}).strict(), message:messageRequestSchema,
  read:scopeSchema, lease:scopeSchema.extend({instanceId:uuid,requestId:uuid}).strict(),
  renew:scopeSchema.extend({instanceId:uuid,generation:positive}).strict(),
  release:scopeSchema.extend({instanceId:uuid,generation:positive}).strict(),
  acks:scopeSchema.extend({instanceId:uuid,generation:positive,streamEpoch:uuid,items:unique(deliveryRefSchema)}).strict(),
  expiryReceipts:scopeSchema.extend({instanceId:uuid,generation:positive,streamEpoch:uuid,items:unique(deliveryRefSchema)}).strict(),
});
const distinct = (items, key) => new Set(items.map(key)).size === items.length;
const page = (items,key) => z.object({items:list(items).refine(values=>distinct(values,key)),nextCursor:z.string().max(1024).nullable()}).strict();
const progress = z.object({streamEpoch:uuid,handledThrough:ms,ackedThrough:ms,progressPending:z.boolean()}).strict();
export const dataSchemas = Object.freeze({
  me:z.object({agentId:uuid,instanceId:uuid,centerEpoch:uuid,recoveryCounter:ms,state:z.literal('active')}).strict(),
  contacts:page(z.object({peerAgentId:uuid,displayName:z.string().max(255)}).strict(),v=>v.peerAgentId),
  conversations:page(z.object({conversationId:uuid,peerAgentId:uuid,createdAt:ms}).strict(),v=>v.conversationId),
  conversation:z.object({conversationId:uuid,peerAgentId:uuid,createdAt:ms}).strict(),
  send:z.object({message:messageSchema,replayed:z.boolean()}).strict(),
  sendResult:z.object({originEpoch:uuid,clientMessageId:uuid,messageId:uuid,acceptedAt:ms,payloadHash:hash,
    sourceProtocol:z.enum(['a2a-msg.im.v1',PROTOCOL]),contentState:z.enum(['live','expired']),retryUntil:ms}).strict(),
  history:page(historyItemSchema,v=>v.kind==='message'?v.message.messageId:v.tombstone.messageId),message:messageSchema,
  read:z.object({messageId:uuid,readAt:ms,changed:z.boolean()}).strict(),
  lease:z.object({centerEpoch:uuid,instanceId:uuid,generation:positive,expiresAt:ms,historical:z.boolean(),streamEpoch:uuid}).strict(),
  renew:z.object({centerEpoch:uuid,instanceId:uuid,generation:positive,expiresAt:ms,streamEpoch:uuid}).strict(),
  release:z.object({instanceId:uuid,generation:positive,released:z.literal(true)}).strict(),
  sync:progress.extend({items:list(syncItemSchema).refine(values=>distinct(values,v=>v.seq) &&
    distinct(values,v=>v.kind==='message'?v.message.messageId:v.tombstone.messageId)),pageAfter:ms,hasMore:z.boolean()}).strict(),
  acks:progress,expiryReceipts:progress,
});
export const successEnvelopeSchema = z.object({protocol:z.literal(PROTOCOL),centerEpoch:uuid,data:z.unknown()}).strict()
  .refine(v=>Object.hasOwn(v,'data') && v.data!==undefined,{message:'data is required'});
export const errorEnvelopeSchema = z.object({protocol:z.literal(PROTOCOL),error:z.object({code:z.enum(Object.keys(ERROR_DETAILS)),message:z.string(),retryable:z.boolean()}).strict(),requestId:z.string().min(1).max(255),currentCenterEpoch:uuid.optional()}).strict().superRefine((v,ctx) => {
  if (v.currentCenterEpoch !== undefined && v.error.code !== 'RECOVERY_RECONCILIATION_REQUIRED') ctx.addIssue({code:'custom',message:'Current epoch only on authenticated reconciliation'});
});
export function errorEnvelope(error,requestId,currentCenterEpoch) {
  if (!(error instanceof ImV2Error)) throw new TypeError('Expected ImV2Error');
  return errorEnvelopeSchema.parse({protocol:PROTOCOL,error:{code:error.code,message:error.message,retryable:error.retryable},requestId,
    ...(currentCenterEpoch === undefined ? {} : {currentCenterEpoch})});
}

export function storageOperationKey(originEpoch,clientMessageId) {
  operationSchema.parse({originEpoch,clientMessageId});
  return `v2:${originEpoch}:${clientMessageId}`;
}
export function parseStorageOperationKey(key) {
  if (typeof key !== 'string' || key.length !== 76 || !key.startsWith('v2:')) throw new ImV2Error('INVALID_REQUEST');
  const originEpoch=key.slice(3,39),clientMessageId=key.slice(40);
  if (key[39] !== ':' || !operationSchema.safeParse({originEpoch,clientMessageId}).success) throw new ImV2Error('INVALID_REQUEST');
  return {originEpoch,clientMessageId};
}
function canonicalBase64(encoded) {
  if (encoded.length===0 || encoded.length%4!==0) return false;
  const padding=encoded.endsWith('==')?2:encoded.endsWith('=')?1:0;
  for(let i=0;i<encoded.length-padding;i++) {
    const c=encoded.charCodeAt(i);
    if (!((c>=65&&c<=90)||(c>=97&&c<=122)||(c>=48&&c<=57)||c===43||c===47)) return false;
  }
  for(let i=encoded.length-padding;i<encoded.length;i++) if(encoded.charCodeAt(i)!==61) return false;
  return true;
}
export function normalizeMessageRequest(raw,{maxAttachmentBytes=MAX_ATTACHMENT_BYTES}={}) {
  if (!Number.isSafeInteger(maxAttachmentBytes) || maxAttachmentBytes<1 || maxAttachmentBytes>MAX_ATTACHMENT_BYTES) throw new ImV2Error('INVALID_REQUEST');
  if (raw?.protocol !== undefined && raw.protocol !== PROTOCOL) throw new ImV2Error('UNSUPPORTED_VERSION');
  const result=messageRequestSchema.safeParse(raw);
  if (!result.success) throw new ImV2Error(raw?.attachment && !sendAttachment.safeParse(raw.attachment).success ? 'INVALID_ATTACHMENT':'INVALID_REQUEST');
  const v=result.data;
  if (v.originEpoch!==v.centerEpoch) throw new ImV2Error('RECOVERY_RECONCILIATION_REQUIRED');
  let attachment=null;
  if (v.attachment) {
    const encoded=v.attachment.dataBase64;
    if (encoded.length>Math.ceil(maxAttachmentBytes/3)*4) throw new ImV2Error('PAYLOAD_TOO_LARGE');
    if (!canonicalBase64(encoded)) throw new ImV2Error('INVALID_ATTACHMENT');
    const bytes=Buffer.from(encoded,'base64');
    if (bytes.length>maxAttachmentBytes) throw new ImV2Error('PAYLOAD_TOO_LARGE');
    if (!bytes.length || bytes.toString('base64')!==encoded || createHash('sha256').update(bytes).digest('hex')!==v.attachment.sha256) throw new ImV2Error('INVALID_ATTACHMENT');
    attachment={name:v.attachment.name,mime:v.attachment.mime??null,size:bytes.length,sha256:v.attachment.sha256,bytes};
  }
  if (!(v.text??'').length && !attachment) throw new ImV2Error('INVALID_REQUEST');
  return {...v,title:v.title??null,text:v.text??'',attachment,inReplyTo:v.inReplyTo??null,correlation:v.correlation??null};
}
// This shape is the COMPLETE normalized output, not the optional-field wire request.
// centerEpoch is validated as scope, but deliberately absent from the hash array.
const normalizedAttachmentSchema=z.object({name:fileName,mime,size:positive.max(MAX_ATTACHMENT_BYTES),sha256:hash,
  bytes:z.instanceof(Uint8Array)}).strict();
export const normalizedMessageSchema=scopeSchema.extend({originEpoch:uuid,clientMessageId:uuid,
  conversationId:uuid,recipientAgentId:uuid,title,text,attachment:normalizedAttachmentSchema.nullable(),
  inReplyTo:nullableUuid,correlation}).strict().refine(v=>v.text.length>0 || v.attachment!==null);
export function fingerprintMessage(v) {
  const parsed=normalizedMessageSchema.safeParse(v);
  if (!parsed.success) throw new ImV2Error('INVALID_REQUEST');
  const a=parsed.data.attachment;
  if (a && (a.bytes.length!==a.size || createHash('sha256').update(a.bytes).digest('hex')!==a.sha256))
    throw new ImV2Error('INVALID_REQUEST');
  return createHash('sha256').update(JSON.stringify([PROTOCOL,v.originEpoch,v.conversationId,v.recipientAgentId,
    v.clientMessageId,v.title,v.text,a && [a.name,a.mime,a.size,a.sha256],v.inReplyTo,v.correlation])).digest('hex');
}
const cursorKind=z.enum(['contacts','conversations','history']);
const cursorSchema=z.tuple([z.literal(2),cursorKind,uuid,uuid,uuid,z.union([uuid,z.tuple([ms,uuid])])]);
export function encodeCursor(kind,centerEpoch,agentId,scope,key) {
  const value=cursorSchema.parse([2,kind,centerEpoch,agentId,scope,key]);
  if ((kind==='history') !== Array.isArray(key) || (kind!=='history' && scope!==agentId)) throw new ImV2Error('INVALID_REQUEST');
  const encoded=Buffer.from(JSON.stringify(value)).toString('base64url');
  if (encoded.length>1024) throw new ImV2Error('INVALID_REQUEST');
  return encoded;
}
export function decodeCursor(encoded,{kind,centerEpoch,agentId,scope}) {
  if (typeof encoded!=='string' || !encoded.length || encoded.length>1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new ImV2Error('INVALID_REQUEST');
  let decoded;
  try { decoded=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')); } catch { throw new ImV2Error('INVALID_REQUEST'); }
  if (Buffer.from(JSON.stringify(decoded)).toString('base64url')!==encoded || !cursorSchema.safeParse(decoded).success || decoded[1]!==kind || decoded[3]!==agentId || decoded[4]!==scope || (kind==='history')!==Array.isArray(decoded[5]) || (kind!=='history' && decoded[4]!==decoded[3])) throw new ImV2Error('INVALID_REQUEST');
  if (decoded[2]!==centerEpoch) throw new ImV2Error('RECOVERY_RECONCILIATION_REQUIRED');
  return decoded[5]; // Caller must recheck ACL; cursor never grants access.
}
export function parseQuery(entries,{allowed=[],required=[]}={}) {
  const values=Object.create(null);
  for (const [key,value] of entries) {
    if (!allowed.includes(key) || Object.hasOwn(values,key) || typeof value!=='string') throw new ImV2Error('INVALID_REQUEST');
    values[key]=value;
  }
  if (required.some(k=>!Object.hasOwn(values,k))) throw new ImV2Error('INVALID_REQUEST');
  if (Object.hasOwn(values,'limit') && (!/^[1-9][0-9]*$/.test(values.limit) || Number(values.limit)>100)) throw new ImV2Error('INVALID_REQUEST');
  if (Object.hasOwn(values,'streamEpoch') && !UUID.test(values.streamEpoch)) throw new ImV2Error('INVALID_REQUEST');
  return Object.freeze({...values,...(allowed.includes('limit') && !Object.hasOwn(values,'limit') ? {limit:'20'} : {})});
}
// /sync's numeric after is not an opaque pagination cursor. Watermark/fence checks remain transactional.
export function parseSyncQuery(entries) {
  const values=parseQuery(entries,{allowed:['streamEpoch','after','limit'],required:['streamEpoch']});
  if (Object.hasOwn(values,'after') && (!/^(?:0|[1-9][0-9]*)$/.test(values.after) ||
      !Number.isSafeInteger(Number(values.after)))) throw new ImV2Error('INVALID_REQUEST');
  return values;
}
