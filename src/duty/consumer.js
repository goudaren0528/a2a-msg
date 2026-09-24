import { createHash } from 'node:crypto';
import path from 'node:path';
import { CONFIG } from '../config.js';

// Capture the validated startup ceiling; runtime config may only lower it.
const MAX_RECEIVED_ATTACHMENT_BYTES = CONFIG.maxAttachmentBytes;

// Local, offline adapter only. The host must independently authenticate its caller,
// establish the live session/member and supply the scoped store credential.
const error = code => Object.assign(new Error(code), { code });
const allowedCodes = new Set(['WORK_PROTOCOL_INVALID','AUTH_REQUIRED','GRANT_REVOKED','GRANT_EXPIRED',
  'SCOPE_DENIED','STALE_FENCE','LEASE_LOST','RECOVERY_REQUIRED','MESSAGE_NOT_APPROVED',
  'DIGEST_MISMATCH','STATE_CONFLICT','MEMBER_BUSY','IDEMPOTENCY_CONFLICT','WORK_CONFLICT']);
const safeError = e => error(allowedCodes.has(e?.code) ? e.code : 'WORK_PROTOCOL_INVALID');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const integer = v => Number.isSafeInteger(v) && v > 0;
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const sha = v => typeof v === 'string' && /^[a-fA-F0-9]{64}$/.test(v);
const check = (v, yes) => { if (!yes(v)) throw error('WORK_PROTOCOL_INVALID'); return v; };
const keys = (v, names) => {
  check(v, object);
  if (Object.keys(v).some(k => !names.includes(k))) throw error('WORK_PROTOCOL_INVALID');
};
const copy = value => {
  try {
    const json = JSON.stringify(value);
    if (json === undefined || json.length > 64_000) throw error('WORK_PROTOCOL_INVALID');
    return JSON.parse(json);
  } catch { throw error('WORK_PROTOCOL_INVALID'); }
};

export function createDutyConsumer({ enabled = false, store, getTrustedContext, saveAttachment,
  verifySavedAttachment } = {}) {
  if (typeof getTrustedContext !== 'function' || !store || typeof saveAttachment !== 'function' ||
      (verifySavedAttachment !== undefined && typeof verifySavedAttachment !== 'function'))
    throw new TypeError('store, getTrustedContext and saveAttachment are required');
  const cache = new Map();
  const pending = new Map();
  async function trusted() {
    if (enabled !== true) throw error('AUTH_REQUIRED');
    const ctx = await getTrustedContext();
    if (!object(ctx) || ctx.sessionActive !== true || ctx.memberEnabled !== true ||
        typeof ctx.currentMember !== 'string' || !ctx.currentMember || !integer(ctx.grantId) ||
        !object(ctx.auth) || ctx.auth.member !== ctx.currentMember ||
        typeof ctx.auth.credential !== 'string' || ctx.auth.credential.length < 32 ||
        !['sessionBinding','role','repo','environment'].every(k => typeof ctx.auth[k] === 'string' && !!ctx.auth[k]))
      throw error('AUTH_REQUIRED');
    keys(ctx.auth,['credential','member','sessionBinding','role','repo','environment']);
    // Do not retain a mutable host object across asynchronous attachment saving.
    const {credential,member,sessionBinding,role,repo,environment}=ctx.auth;
    return { auth:{credential,member,sessionBinding,role,repo,environment}, grantId:ctx.grantId };
  }
  const specs = {
    claim:['requestId'], renew:['workId','fence'], status:['workId'], payload:['workId','fence'],
    update:['workId','fence','expectedVersion','requestId','state','record'],
    recover:['workId','fence','expectedVersion','requestId','record'],
    resumeBlocked:['workId','expectedVersion','requestId','record'],
    replySend:['workId','fence','expectedVersion','requestId','title','text'], replyQuery:['workId'],
  };
  function validate(kind, input) {
    keys(input, specs[kind]);
    for (const key of specs[kind]) if (!Object.hasOwn(input,key)) throw error('WORK_PROTOCOL_INVALID');
    for (const key of ['workId','fence']) if (key in input) check(input[key],integer);
    if ('expectedVersion' in input) check(input.expectedVersion,v=>Number.isSafeInteger(v)&&v>=0);
    if ('requestId' in input) check(input.requestId,uuid);
    if ('record' in input) { check(input.record,object); copy(input.record); }
    if ('state' in input) check(input.state,v=>['PROCESSING','AWAITING_UAT','BLOCKED'].includes(v));
    if ('title' in input) check(input.title,v=>typeof v==='string'&&v.length>0&&v.length<=100);
    if ('text' in input) check(input.text,v=>typeof v==='string'&&v.length>0&&v.length<=16_000);
  }
  const methods = {claim:'claim',renew:'renew',status:'getStatus',update:'update',recover:'recover',
    resumeBlocked:'resumeBlocked',replySend:'replySend',replyQuery:'replyQuery'};
  async function call(kind,input) {
    try {
      const scope = await trusted();
      validate(kind,input);
      return copy(await store[methods[kind]]({...input,...scope}));
    } catch (e) { throw safeError(e); }
  }
  function inspect(raw, workId) {
    if (!object(raw) || raw.workId !== workId || !Array.isArray(raw.messages) || !raw.messages.length || raw.messages.length>100)
      throw error('WORK_PROTOCOL_INVALID');
    const messages = raw.messages.map(m => {
      if (!object(m) || !integer(m.id) || !['from','to','title','text','project','time','sourceVerificationRef']
        .every(k=>typeof m[k]==='string') || !Object.hasOwn(m,'attachment')) throw error('WORK_PROTOCOL_INVALID');
      let attachment = null;
      if (m.attachment !== null) {
        const a=m.attachment;
        if (!object(a) || !integer(a.id) || typeof a.name!=='string' || !a.name || a.name.length>CONFIG.maxAttachmentNameChars ||
            (a.mime!==null && (typeof a.mime!=='string' || a.mime.length>CONFIG.maxAttachmentMimeChars)) ||
            !Number.isSafeInteger(a.size) || a.size<1 || a.size>Math.min(MAX_RECEIVED_ATTACHMENT_BYTES,CONFIG.maxAttachmentBytes) ||
            !sha(a.sha256) || !(Buffer.isBuffer(a.data) || a.data instanceof Uint8Array) ||
            a.data.byteLength!==a.size) throw error('DIGEST_MISMATCH');
        // Buffer.from(view) copies only the view's bytes, respecting offset and length.
        const data=Buffer.from(a.data);
        if (data.length!==a.size || createHash('sha256').update(data).digest('hex')!==a.sha256.toLowerCase())
          throw error('DIGEST_MISMATCH');
        attachment={id:a.id,name:a.name,size:a.size,mime:a.mime,sha256:a.sha256.toLowerCase(),data};
      }
      return {id:m.id,from:m.from,to:m.to,title:m.title,text:m.text,project:m.project,
        time:m.time,sourceVerificationRef:m.sourceVerificationRef,attachment};
    });
    // Hash body + verified bytes metadata, without retaining raw bytes in the cache.
    const signature = createHash('sha256').update(JSON.stringify(messages.map(m=>({...m,attachment:m.attachment &&
      {id:m.attachment.id,name:m.attachment.name,size:m.attachment.size,mime:m.attachment.mime,sha256:m.attachment.sha256}})))).digest('hex');
    return {messages,signature};
  }
  async function materialize(scope, workId, fence, snapshot, key) {
    const prior=cache.get(key);
    if (prior && verifySavedAttachment &&
        (await Promise.all(prior.map(item=>!item || verifySavedAttachment(item.savedPath,item.sha256,item.size)))).every(Boolean))
      return prior;
    cache.delete(key);
    const results=[];
    for (const m of snapshot.messages) {
      if (!m.attachment) { results.push(null); continue; }
      const a=m.attachment;
      // Compatible with src/attachment-save.js: the injected saver controls its
      // trusted directory; callers cannot provide a path/overwrite or a downloader.
      const saved=await saveAttachment({attachment_id:a.id}, async()=>({
        name:a.name,mime:a.mime,from:m.from,to:m.to,size:a.size,sha256:a.sha256,data_base64:a.data.toString('base64'),
      }));
      if (!object(saved) || typeof saved.path!=='string' || !path.isAbsolute(saved.path) ||
          saved.size!==a.size || saved.sha256!==a.sha256 || saved.overwritten===true)
        throw error('DIGEST_MISMATCH');
      results.push({savedPath:saved.path,sha256:a.sha256,size:a.size,
        ...(saved.cleanupWarning ? {cleanupWarning:'Attachment saved; temporary cleanup incomplete. Do not save again.'} : {})});
    }
    cache.set(key,results);
    return results;
  }
  async function payload(input) {
    try {
      const scope=await trusted(); validate('payload',input);
      const snapshot=inspect(await store.getPayload({...input,...scope}),input.workId);
      const key=JSON.stringify([scope.grantId,scope.auth.member,scope.auth.sessionBinding,input.workId,input.fence,snapshot.signature]);
      let flight=pending.get(key);
      if (!flight) {
        flight=materialize(scope,input.workId,input.fence,snapshot,key);
        pending.set(key,flight);
        flight.finally(()=>{if(pending.get(key)===flight) pending.delete(key);}).catch(()=>{});
      }
      const saved=await flight;
      // Re-establish both trusted host session and store grant/lease/approval after
      // asynchronous disk I/O; no body is released on a stale fence or digest.
      const current=await trusted();
      if (current.grantId!==scope.grantId || JSON.stringify(current.auth)!==JSON.stringify(scope.auth)) throw error('AUTH_REQUIRED');
      const latest=inspect(await store.getPayload({...input,...current}),input.workId);
      if (latest.signature!==snapshot.signature) throw error('DIGEST_MISMATCH');
      return copy({workId:input.workId,messages:snapshot.messages.map((m,i)=>({
        id:m.id,from:m.from,to:m.to,title:m.title,text:m.text,project:m.project,time:m.time,
        sourceVerificationRef:m.sourceVerificationRef,attachment:m.attachment ? {
          id:m.attachment.id,name:m.attachment.name,size:m.attachment.size,mime:m.attachment.mime,
          sha256:m.attachment.sha256,...saved[i],
        } : null,
      }))});
    } catch (e) { throw safeError(e); }
  }
  return Object.freeze({claim:input=>call('claim',input),renew:input=>call('renew',input),
    status:input=>call('status',input),payload,update:input=>call('update',input),
    recover:input=>call('recover',input),resumeBlocked:input=>call('resumeBlocked',input),
    replySend:input=>call('replySend',input),replyQuery:input=>call('replyQuery',input)});
}
