// Independent P4 contract: literal field inventory and RESERVED BILLING rules.
// Deliberately imports no journal/schema implementation. This is a structural
// oracle, not an implementation-generated SQL/checksum golden.
import {createHash} from 'node:crypto';

export const PROTOCOL = 'a2a-msg.im.v2';
export const MAX = Number.MAX_SAFE_INTEGER;
export const U = n => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
export const H = value => createHash('sha256').update(value).digest('hex');
export const bytes = value => value == null ? 0 : Buffer.byteLength(value, 'utf8');
export const identity = (overrides = {}) => ({centerOrigin:'https://example.test', stableInstanceId:U(1), agentId:U(2), centerEpoch:U(3), ...overrides});
export const partitionId = v => H(JSON.stringify([v.centerOrigin, v.stableInstanceId, v.agentId, v.centerEpoch]));
export const request = (overrides = {}) => ({protocol:PROTOCOL, centerEpoch:U(3), originEpoch:U(3), clientMessageId:U(4), conversationId:U(5), recipientAgentId:U(6), text:'hello', ...overrides});
export const message = (seq = 1, overrides = {}) => ({messageId:U(10000 + seq), conversationId:U(5), senderAgentId:U(6), recipientAgentId:U(2), originEpoch:U(3), clientMessageId:U(20000 + seq), title:null, text:'hello', inReplyTo:null, correlation:null, acceptedAt:100, expiresAt:1000, deliveredAt:null, readAt:null, attachment:null, ...overrides});
export const tombstone = m => ({messageId:m.messageId, conversationId:m.conversationId, acceptedAt:m.acceptedAt, expiresAt:m.expiresAt, expiredAt:1000});
export const operation = r => ({originEpoch:r.originEpoch, clientMessageId:r.clientMessageId});
export const fingerprint = r => H(JSON.stringify([PROTOCOL, r.originEpoch, r.conversationId, r.recipientAgentId, r.clientMessageId, r.title ?? null, r.text ?? '', r.attachment == null ? null : [r.attachment.name, r.attachment.mime ?? null, Buffer.from(r.attachment.dataBase64, 'base64').length, r.attachment.sha256], r.inReplyTo ?? null, r.correlation ?? null]));
export const accepted = (r, overrides = {}) => ({...operation(r), messageId:U(7000), acceptedAt:500, payloadHash:fingerprint(r), sourceProtocol:PROTOCOL, contentState:'live', retryUntil:10000, ...overrides});
export const progress = (streamEpoch, handledThrough = 0, ackedThrough = 0, overrides = {}) => ({protocol:PROTOCOL, centerEpoch:U(3), data:{streamEpoch, handledThrough, ackedThrough, progressPending:false}, ...overrides});
export const lease = (streamEpoch, overrides = {}) => ({centerEpoch:U(3), instanceId:U(90), generation:1, expiresAt:10000, historical:false, streamEpoch, ...overrides});

// Codes: H=64 lower hex, U=canonical UUID, N/N+=safe integer, B=0/1,
// O=canonical HTTPS origin, R=decision reference, J*=bounded JSON, E=enum.
const c = (type, charge, nullable = false) => ({type, charge, nullable});
export const TABLES = Object.freeze({
  im_v2_client_meta: {
    singleton:c('N',8), version:c('N',8), checksum:c('H',64),
  },
  im_v2_client_partitions: {
    partition_id:c('H',64), center_origin:c('O','bytes'), stable_instance_id:c('U',36), agent_id:c('U',36), center_epoch:c('U',36),
    status:c('E',23), predecessor_id:c('H',64,true), decision_ref:c('R',1020,true), created_at:c('N',8),
  },
  im_v2_client_outgoing: {
    partition_id:c('H',64), origin_epoch:c('U',36), client_message_id:c('U',36), source_protocol:c('E',13), fingerprint:c('H',64),
    payload_json:c('J16777216','bytes',true), acceptance_state:c('E',8), reconciliation_state:c('E',14), message_id:c('U',36,true), accepted_at:c('N',8,true), created_at:c('N',8),
  },
  im_v2_client_received: {
    partition_id:c('H',64), stream_epoch:c('U',36), seq:c('N+',8), message_id:c('U',36), kind:c('E',15), fact_json:c('J262144','bytes'),
    fact_hash:c('H',64), attachment_receipt_json:c('J4096','bytes',true), recorded_at:c('N',8), server_confirmed:c('B',8),
  },
  im_v2_client_receiver: {
    partition_id:c('H',64), stream_epoch:c('U',36), handled_cursor:c('N',8), acked_cursor:c('N',8), server_handled:c('N',8), server_acked:c('N',8),
    instance_id:c('U',36,true), generation:c('N+',8,true), expires_at:c('N',8,true),
  },
  im_v2_client_batches: {
    batch_id:c('H',64), partition_id:c('H',64), stream_epoch:c('U',36), kind:c('E',6), items_json:c('J16384','bytes'), items_hash:c('H',64),
    state:c('E',9), created_at:c('N',8), confirmed_at:c('N',8,true), last_response_json:c('J4096',4096,true),
  },
});
export const PRIMARY_KEYS = {
  im_v2_client_meta:['singleton'], im_v2_client_partitions:['partition_id'],
  im_v2_client_outgoing:['partition_id','origin_epoch','client_message_id'],
  im_v2_client_received:['partition_id','stream_epoch','seq','kind'],
  im_v2_client_receiver:['partition_id','stream_epoch'], im_v2_client_batches:['batch_id'],
};
export const INDEXES = {
  im_v2_client_one_active:{table:'im_v2_client_partitions', columns:['center_origin','agent_id'], unique:1, partial:1},
  im_v2_client_outgoing_pending:{table:'im_v2_client_outgoing', columns:['partition_id','reconciliation_state','acceptance_state','created_at','origin_epoch','client_message_id'], unique:0, partial:0},
  im_v2_client_received_pending:{table:'im_v2_client_received', columns:['partition_id','stream_epoch','server_confirmed','seq','kind'], unique:0, partial:0},
  im_v2_client_batches_pending:{table:'im_v2_client_batches', columns:['partition_id','state','created_at','batch_id'], unique:0, partial:0},
};
export const DEFAULTS = {maxPartitions:32, maxOutgoing:10000, maxReceivedFacts:20000, maxBatches:10000, maxLogicalBytes:256 * 1024 * 1024};
export function charge(table, row) {
  return 64 + Object.entries(TABLES[table]).reduce((sum, [column, spec]) => sum + (spec.charge === 'bytes' ? bytes(row[column]) : spec.charge), 0);
}
export const META_CHARGE = 64 + 8 + 8 + 64;
export const PARTITION_MAX_CHARGE = 64 + 64 + 2048 + 36 + 36 + 36 + 23 + 64 + 1020 + 8;
export function reserveCount(P, B) {
  return Math.min(4, Math.max(0, P - 1), Math.max(0, Math.floor((B - META_CHARGE - PARTITION_MAX_CHARGE) / PARTITION_MAX_CHARGE)));
}
export function databaseCharge(db) {
  return Object.keys(TABLES).reduce((sum, table) => sum + db.prepare(`SELECT * FROM ${table}`).all().reduce((n, row) => n + charge(table, row), 0), 0);
}
export function snapshot(db) {
  return Object.fromEntries(Object.keys(TABLES).map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY ${PRIMARY_KEYS[table].join(',')}`).all().map(row => ({...row}))]));
}
