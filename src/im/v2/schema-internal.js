import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { V3_DDL, V3_CHECKSUM, fingerprintFrozenV1 } from './schema-history.js';

const IM_V2_SCHEMA_VERSION = 4;
const SUPPORTED_IM_V2_SCHEMA_VERSIONS = Object.freeze([4]);
const MAX = 9007199254740991;
const check = (c, expr, nullable = false) => `CHECK(${nullable ? `${c} IS NULL OR ` : ''}(${expr}))`;
const U = (c, nullable = false) => check(c, `typeof(${c})='text' AND length(${c})=36 AND ${c} GLOB '${[8,4,4,4,12].map(n=>'[0-9a-f]'.repeat(n)).join('-')}'`, nullable);
const I = (c, nullable = false) => check(c, `typeof(${c})='text' AND length(${c}) BETWEEN 1 AND 255`, nullable);
const H = (c, nullable = false) => check(c, `typeof(${c})='text' AND length(${c})=64 AND ${c} NOT GLOB '*[^0-9a-f]*'`, nullable);
const N = (c, nullable = false, positive = false) => check(c, `typeof(${c})='integer' AND ${c} BETWEEN ${positive ? 1 : 0} AND ${MAX}`, nullable);
const B = c => check(c, `typeof(${c})='integer' AND ${c} IN (0,1)`);
const J = (c, nullable = false) => check(c, `typeof(${c})='text' AND length(${c}) BETWEEN 2 AND 65536 AND json_valid(${c})`, nullable);
const E = (c, values) => check(c, `typeof(${c})='text' AND ${c} IN (${values.map(v => `'${v}'`).join(',')})`);
const col = (name, type, constraint, extras = '', nullable = false) => `${name} ${type}${nullable ? '' : ' NOT NULL'} ${extras} ${constraint}`;
const u = (name, extras = '', nullable = false) => col(name, 'TEXT', U(name, nullable), extras, nullable);
const i = (name, extras = '', nullable = false) => col(name, 'TEXT', I(name, nullable), extras, nullable);
const h = (name, extras = '', nullable = false) => col(name, 'TEXT', H(name, nullable), extras, nullable);
const n = (name, extras = '', nullable = false, positive = false) => col(name, 'INTEGER', N(name, nullable, positive), extras, nullable);
const j = (name, extras = '', nullable = false) => col(name, 'TEXT', J(name, nullable), extras, nullable);
const e = (name, values) => col(name, 'TEXT', E(name, values));
const table = (name, fields) => `CREATE TABLE ${name} (${fields.join(', ')})`;
export const V4_SCHEMA = `CREATE TABLE im_schema (version INTEGER NOT NULL PRIMARY KEY CHECK(version=4), migration_checksum TEXT NOT NULL CHECK(length(migration_checksum)=64))`;
export const V4_TABLES = Object.freeze([
  table('im_center_epochs', [u('center_epoch','PRIMARY KEY'),n('created_at'),e('origin',['fresh','v3_import','recovery']),n('recovery_counter')]),
  table('im_center_state', ['singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1)',u('center_epoch','UNIQUE REFERENCES im_center_epochs(center_epoch)'),n('recovery_counter'),e('status',['prepared','verified','active']),i('activation_ref','',true),i('recovery_run_id','REFERENCES im_recovery_runs(run_id)',true),n('updated_at'),"CHECK ((status='active' AND activation_ref IS NOT NULL) OR (status<>'active' AND activation_ref IS NULL))","CHECK (status='prepared' OR recovery_run_id IS NOT NULL)"]),
  table('im_schema_preparations',[i('preparation_ref','PRIMARY KEY'),e('kind',['fresh','v3_import']),h('input_hash'),"source_version INTEGER CHECK (source_version IS NULL OR (typeof(source_version)='integer' AND source_version=3))",h('source_schema_checksum','',true),u('import_epoch','REFERENCES im_center_epochs(center_epoch)',true),u('initial_epoch','UNIQUE REFERENCES im_center_epochs(center_epoch)'),h('policy_hash','REFERENCES im_retention_policies(policy_hash)'),n('created_at'),"CHECK ((kind='fresh' AND source_version IS NULL AND source_schema_checksum IS NULL AND import_epoch IS NULL) OR (kind='v3_import' AND source_version IS NOT NULL AND typeof(source_version)='integer' AND source_version=3 AND source_schema_checksum IS NOT NULL AND import_epoch IS NOT NULL AND import_epoch<>initial_epoch))"]),
  table('im_recovery_runs',[i('run_id','PRIMARY KEY'),e('candidate_kind',['fresh_bootstrap','v3_import','snapshot_recovery']),i('preparation_ref','REFERENCES im_schema_preparations(preparation_ref)',true),u('backup_id','',true),h('backup_file_hash','',true),h('manifest_hash','',true),h('candidate_base_hash','',true),i('candidate_reference'),u('old_epoch','REFERENCES im_center_epochs(center_epoch)',true),u('new_epoch','UNIQUE REFERENCES im_center_epochs(center_epoch)'),h('approved_plan_hash'),i('approval_ref'),i('isolation_ack_ref','',true),j('rpo_report_json','',true),i('auth_review_ref','',true),h('activation_plan_hash','',true),i('activation_approval_ref','',true),e('status',['prepared','verified','active','failed']),n('created_at'),n('verified_at','',true),n('activated_at','',true),i('activation_ref','',true),i('failure_code','',true),"CHECK ((candidate_kind='snapshot_recovery' AND preparation_ref IS NULL AND backup_id IS NOT NULL AND backup_file_hash IS NOT NULL AND manifest_hash IS NOT NULL AND candidate_base_hash IS NOT NULL AND old_epoch IS NOT NULL AND isolation_ack_ref IS NOT NULL AND rpo_report_json IS NOT NULL) OR (candidate_kind='fresh_bootstrap' AND preparation_ref IS NOT NULL AND backup_id IS NULL AND backup_file_hash IS NULL AND manifest_hash IS NULL AND candidate_base_hash IS NULL AND old_epoch IS NULL AND isolation_ack_ref IS NULL AND rpo_report_json IS NULL) OR (candidate_kind='v3_import' AND preparation_ref IS NOT NULL AND old_epoch IS NULL AND isolation_ack_ref IS NOT NULL AND rpo_report_json IS NOT NULL AND ((backup_id IS NULL AND backup_file_hash IS NULL AND manifest_hash IS NULL AND candidate_base_hash IS NULL) OR (backup_id IS NOT NULL AND backup_file_hash IS NOT NULL AND manifest_hash IS NOT NULL AND candidate_base_hash IS NOT NULL))))","CHECK (old_epoch IS NULL OR old_epoch<>new_epoch)","CHECK (status NOT IN ('verified','active') OR verified_at IS NOT NULL)","CHECK (status<>'prepared' OR verified_at IS NULL)","CHECK ((status='active' AND activated_at IS NOT NULL AND activation_ref IS NOT NULL AND auth_review_ref IS NOT NULL AND activation_plan_hash IS NOT NULL AND activation_approval_ref IS NOT NULL) OR (status<>'active' AND activated_at IS NULL AND activation_ref IS NULL AND activation_plan_hash IS NULL AND activation_approval_ref IS NULL))","CHECK ((status='failed' AND failure_code IS NOT NULL) OR (status<>'failed' AND failure_code IS NULL))","CHECK (verified_at IS NULL OR verified_at>=created_at)","CHECK (activated_at IS NULL OR (verified_at IS NOT NULL AND activated_at>=verified_at))"]),
  table('im_retention_policies',[h('policy_hash','PRIMARY KEY'),"version INTEGER NOT NULL CHECK(version=2)",n('effective_at'),`${n('message_retention_ms','','',true)} CHECK(message_retention_ms=7776000000)`,`${n('attachment_retention_ms','','',true)} CHECK(attachment_retention_ms=7776000000)`,`${n('safe_retry_window_ms','','',true)} CHECK(safe_retry_window_ms=604800000)`,`${n('audit_retention_ms','','',true)} CHECK(audit_retention_ms=15552000000)`,j('canonical_json')]),
  table('im_content_state',[i('message_id','PRIMARY KEY REFERENCES im_messages(message_id)'),e('state',['live','expired']),n('expires_at'),n('expired_at','',true),n('scrubbed_at','',true),h('policy_hash','REFERENCES im_retention_policies(policy_hash)'),i('expiry_run_id','REFERENCES im_maintenance_runs(run_id)',true),i('scrub_run_id','REFERENCES im_maintenance_runs(run_id)',true),"CHECK ((state='live' AND expired_at IS NULL AND expiry_run_id IS NULL AND scrubbed_at IS NULL AND scrub_run_id IS NULL) OR (state='expired' AND expired_at IS NOT NULL AND expiry_run_id IS NOT NULL AND expired_at>=expires_at AND ((scrubbed_at IS NULL AND scrub_run_id IS NULL) OR (scrubbed_at IS NOT NULL AND scrub_run_id IS NOT NULL AND scrubbed_at>=expired_at))))"]),
  table('im_attachment_reservations',[i('attachment_id','PRIMARY KEY'),i('message_id','UNIQUE REFERENCES im_messages(message_id)'),"size INTEGER NOT NULL CHECK(typeof(size)='integer' AND size BETWEEN 1 AND 10485760)",h('sha256')]),
  table('im_send_operation_keys',[i('sender_id','REFERENCES im_agents(agent_id)'),u('origin_epoch','REFERENCES im_center_epochs(center_epoch)'),u('client_message_id'),i('storage_client_message_id'),e('source_protocol',['a2a-msg.im.v1','a2a-msg.im.v2']),i('message_id','UNIQUE REFERENCES im_messages(message_id)'),"PRIMARY KEY(sender_id,origin_epoch,client_message_id)","UNIQUE(sender_id,storage_client_message_id)","FOREIGN KEY(sender_id,storage_client_message_id) REFERENCES im_send_keys(sender_id,client_message_id)","CHECK ((source_protocol='a2a-msg.im.v2' AND storage_client_message_id='v2:'||origin_epoch||':'||client_message_id) OR (source_protocol='a2a-msg.im.v1' AND storage_client_message_id=client_message_id))"]),
  table('im_sync_progress',[i('recipient_id','REFERENCES im_receive_state(agent_id)'),u('center_epoch','REFERENCES im_center_epochs(center_epoch)'),u('stream_epoch'),n('handled_through'),n('updated_at'),"PRIMARY KEY(recipient_id,center_epoch,stream_epoch)"]),
  table('im_expiry_receipts',[i('recipient_id'),u('center_epoch'),u('stream_epoch'),n('seq','',false,true),i('message_id','REFERENCES im_messages(message_id)'),n('recorded_at'),"PRIMARY KEY(recipient_id,center_epoch,stream_epoch,seq)","UNIQUE(recipient_id,center_epoch,stream_epoch,message_id)","FOREIGN KEY(recipient_id,center_epoch,stream_epoch) REFERENCES im_sync_progress(recipient_id,center_epoch,stream_epoch)","FOREIGN KEY(recipient_id,seq) REFERENCES im_deliveries(recipient_id,seq)"]),
  table('im_maintenance_runs',[i('run_id','PRIMARY KEY'),u('center_epoch','REFERENCES im_center_epochs(center_epoch)'),e('kind',['expire','scrub','audit']),h('execution_policy_hash','REFERENCES im_retention_policies(policy_hash)'),h('plan_hash','UNIQUE'),h('approved_batch_hash','',true),i('approval_ref','',true),i('executor_id'),e('status',['previewed','approved','completed','rejected']),j('candidate_json'),j('result_json'),n('previewed_at'),n('expires_at'),n('completed_at','',true),n('scan_rows'),n('scan_bytes'),n('changed_rows'),n('changed_bytes'),"CHECK (expires_at>=previewed_at)","CHECK ((status='completed' AND completed_at IS NOT NULL) OR (status<>'completed' AND completed_at IS NULL))","CHECK (status NOT IN ('approved','completed') OR (approval_ref IS NOT NULL AND approved_batch_hash IS NOT NULL))"]),
]);
export const V4_INDEXES = Object.freeze([
  'im_content_expiry ON im_content_state(state,expires_at,message_id)', 'im_content_scrub ON im_content_state(state,scrubbed_at,expires_at,message_id)', 'im_content_policy ON im_content_state(policy_hash,message_id)', 'im_content_expiry_run ON im_content_state(expiry_run_id)', 'im_content_scrub_run ON im_content_state(scrub_run_id)', 'im_maintenance_completed ON im_maintenance_runs(status,completed_at,run_id)', 'im_maintenance_policy ON im_maintenance_runs(execution_policy_hash,run_id)', 'im_maintenance_epoch ON im_maintenance_runs(center_epoch,run_id)', 'im_recovery_backup ON im_recovery_runs(backup_id,run_id)', 'im_recovery_old_epoch ON im_recovery_runs(old_epoch,run_id)', 'im_recovery_preparation ON im_recovery_runs(preparation_ref,run_id)', 'im_preparation_import_epoch ON im_schema_preparations(import_epoch,preparation_ref)', 'im_preparation_policy ON im_schema_preparations(policy_hash,preparation_ref)', 'im_center_recovery ON im_center_state(recovery_run_id)', 'im_operation_epoch ON im_send_operation_keys(origin_epoch,sender_id,client_message_id)', 'im_sync_epoch ON im_sync_progress(center_epoch,recipient_id,stream_epoch)', 'im_expiry_delivery ON im_expiry_receipts(recipient_id,seq)', 'im_expiry_message ON im_expiry_receipts(message_id)',
].map(s => `CREATE INDEX ${s}`));
export const V4_DDL = Object.freeze([V4_SCHEMA,...V3_DDL.slice(1),...V4_TABLES,...V4_INDEXES]);
const normalize = sql => sql.trim().replace(/\s+/g,' ');
const manifest = rows => rows.map(({type,name,tbl_name,sql}) => [type,name,tbl_name,normalize(sql)]).sort((a,b) => a[1].localeCompare(b[1]));
const expected = manifest(V4_DDL.map(sql => { const [,kind,name] = /^CREATE (TABLE|INDEX) (im_\w+)/.exec(sql); return {type:kind.toLowerCase(),name,tbl_name:kind==='TABLE'?name:/ ON (im_\w+)/.exec(sql)[1],sql}; }));
export const V4_CHECKSUM = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
const mismatch = () => Object.assign(new Error('IM v4 storage schema mismatch'),{code:'IM_SCHEMA_MISMATCH'});
const bounded = (db,sql,limit,params=[]) => {
  // The inner LIMIT caps scanned rows at limit+1; the outer aggregate is only over that bounded probe.
  const count=db.prepare(`SELECT count(*) AS n FROM (${sql})`).get(...params).n;
  if (count>limit) throw Object.assign(new Error('IM v4 budget exceeded'),{code:'IM_V2_BUDGET_EXCEEDED'});
  return count;
};
export function projectCandidateBudget(db,budget,version) {
  const {maxMessages,maxVerifiedContentBytes,maxOtherRecords}=budget.limits;
  // This limit is explicitly defined over inherited v3 tables, not additive v4 backfill rows.
  const tables=V3_DDL.filter(x=>x.startsWith('CREATE TABLE ')).map(x=>/^CREATE TABLE (im_\w+)/.exec(x)[1]);
  bounded(db,'SELECT 1 FROM im_messages LIMIT ?',maxMessages,[maxMessages+1]); budget.tick();
  // Attachment rows are projected separately; a v3 message may have at most one.
  bounded(db,'SELECT 1 FROM im_attachments LIMIT ?',maxMessages,[maxMessages+1]); budget.tick();
  let others=0;
  for (const name of tables) {
    if (name==='im_messages' || name==='im_attachments') continue;
    others+=bounded(db,`SELECT 1 FROM ${name} LIMIT ?`,maxOtherRecords-others,[maxOtherRecords-others+1]);
    budget.tick();
  }
  if (version===4) {
    for (const name of V4_TABLES.map(sql=>/^CREATE TABLE (im_\w+)/.exec(sql)[1])) {
      if (name==='im_content_state' || name==='im_attachment_reservations' || name==='im_send_operation_keys' || name==='im_sync_progress' || name==='im_expiry_receipts') {
        bounded(db,`SELECT 1 FROM ${name} LIMIT ?`,maxMessages+maxOtherRecords,[maxMessages+maxOtherRecords+1]);
      } else bounded(db,`SELECT 1 FROM ${name} LIMIT ?`,maxOtherRecords,[maxOtherRecords+1]);
      budget.tick();
    }
  }
  let bytes=0;
  const measure = (sql,params=[]) => {
    for (const row of db.prepare(sql).iterate(...params)) {
      bytes+=row.bytes;
      if (!Number.isSafeInteger(bytes) || bytes>maxVerifiedContentBytes) throw Object.assign(new Error('IM v4 budget exceeded'),{code:'IM_V2_BUDGET_EXCEEDED'});
      budget.tick();
    }
  };
  measure('SELECT length(CAST(text AS BLOB))+coalesce(length(CAST(title AS BLOB)),0)+coalesce(length(CAST(correlation AS BLOB)),0) AS bytes FROM im_messages');
  measure('SELECT length(data)+length(CAST(name AS BLOB))+coalesce(length(CAST(mime AS BLOB)),0) AS bytes FROM im_attachments');
  if (version===4) {
    for (const [table,column] of [['im_maintenance_runs','candidate_json'],['im_maintenance_runs','result_json'],['im_recovery_runs','rpo_report_json']])
      measure(`SELECT coalesce(length(CAST(${column} AS BLOB)),0) AS bytes FROM ${table}`);
  }
  budget.tick();
}
export function assertImSchemaV4Internal(db, budget) {
  if (!budget) {
    const start=performance.now();
    budget={limits:{maxMessages:10000,maxVerifiedContentBytes:104857600,maxOtherRecords:10000,maxElapsedMs:10000},tick(){
      if (performance.now()-start>this.limits.maxElapsedMs) throw Object.assign(new Error('IM v4 validation budget exceeded'),{code:'IM_V2_BUDGET_EXCEEDED'});
    }};
  }
  const tick=()=>budget.tick();
  if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw mismatch();
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE (name LIKE 'im_%' OR tbl_name LIKE 'im_%') AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name LIMIT ?").all(expected.length+1);
  tick();
  if (JSON.stringify(manifest(rows)) !== JSON.stringify(expected)) throw mismatch();
  const marker = db.prepare('SELECT version,migration_checksum FROM im_schema LIMIT 2').all();
  if (marker.length!==1 || marker[0].version!==4 || marker[0].migration_checksum!==V4_CHECKSUM) throw mismatch();
  projectCandidateBudget(db,budget,4);
  const single = (table) => db.prepare(`SELECT * FROM ${table} LIMIT 2`).all();
  for (const table of ['im_settings','im_clock','im_instance_identity','im_center_state']) if (single(table).length!==1) throw mismatch();
  const identity = single('im_instance_identity')[0];
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(identity.instance_id) || !Number.isSafeInteger(identity.created_at) || identity.created_at<0) throw mismatch();
  const center = single('im_center_state')[0];
  const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (!db.prepare('SELECT 1 FROM im_center_epochs WHERE center_epoch=? AND recovery_counter=?').get(center.center_epoch,center.recovery_counter)) throw mismatch();
  if (center.status!=='prepared' && !center.recovery_run_id) throw mismatch();
  if (!center.recovery_run_id && (center.status!=='prepared' || center.recovery_counter!==0 || !db.prepare('SELECT 1 FROM im_schema_preparations WHERE initial_epoch=?').get(center.center_epoch))) throw mismatch();
  for (const row of db.prepare('SELECT * FROM im_retention_policies').iterate()) {
    tick();
    let policy;
    try { policy=JSON.parse(row.canonical_json); } catch { throw mismatch(); }
    const keys=['version','effectiveAt','messageRetentionMs','attachmentRetentionMs','safeRetryWindowMs','auditRetentionMs','keyReservation','expiryEnabled','purgeEnabled','backupCleanupEnabled','backupRetentionMs'];
    if (!policy || Object.keys(policy).length!==keys.length || Object.keys(policy).some(key=>!keys.includes(key)) || policy.version!==2 || policy.effectiveAt!==row.effective_at || policy.messageRetentionMs!==row.message_retention_ms || policy.attachmentRetentionMs!==row.attachment_retention_ms || policy.safeRetryWindowMs!==row.safe_retry_window_ms || policy.auditRetentionMs!==row.audit_retention_ms || policy.keyReservation!=='indefinite' || !['expiryEnabled','purgeEnabled','backupCleanupEnabled'].every(k=>typeof policy[k]==='boolean') || (policy.backupRetentionMs!==null && (!Number.isSafeInteger(policy.backupRetentionMs) || policy.backupRetentionMs<1)) || createHash('sha256').update(JSON.stringify(Object.fromEntries(keys.map(key=>[key,policy[key]])))).digest('hex')!==row.policy_hash) throw mismatch();
  }
  for (const row of db.prepare('SELECT agent_id,credential_id FROM im_receiver_leases').iterate()) {
    tick();
    if (db.prepare('SELECT agent_id FROM im_credentials WHERE credential_id=?').get(row.credential_id)?.agent_id!==row.agent_id) throw mismatch();
  }
  for (const row of db.prepare('SELECT message_id,state,expired_at,scrubbed_at,expiry_run_id,scrub_run_id FROM im_content_state').iterate()) {
    tick();
    if (row.state==='live' ? row.expired_at!==null || row.scrubbed_at!==null || row.expiry_run_id!==null || row.scrub_run_id!==null : row.state!=='expired' || row.expired_at===null || row.expiry_run_id===null || (row.scrubbed_at===null)!==(row.scrub_run_id===null)) throw mismatch();
  }
  // Revalidate retained payload on every assertion, including an exact retry. A scrubbed
  // message retains the original hash as evidence: deleted bytes cannot be rehashed.
  const contentRows=db.prepare(`SELECT m.message_id,m.conversation_id,m.sender_id,m.recipient_id,m.client_message_id,
    m.title,m.text,m.in_reply_to,m.correlation,m.accepted_at,k.payload_hash,k.created_at AS key_created,k.retry_until,
    o.origin_epoch,o.client_message_id AS wire_client_id,o.source_protocol,c.expires_at,c.scrubbed_at,
    p.message_retention_ms,a.attachment_id,a.name,a.mime,a.size,a.sha256,a.data,
    r.attachment_id AS reserved_id,r.size AS reserved_size,r.sha256 AS reserved_hash
    FROM im_messages m JOIN im_send_keys k ON k.message_id=m.message_id
    JOIN im_send_operation_keys o ON o.message_id=m.message_id
    JOIN im_content_state c ON c.message_id=m.message_id
    JOIN im_retention_policies p ON p.policy_hash=c.policy_hash
    LEFT JOIN im_attachment_reservations r ON r.message_id=m.message_id
    LEFT JOIN im_attachments a ON a.message_id=m.message_id ORDER BY m.message_id`);
  const hex=/^[0-9a-f]{64}$/;
  const safeInt=x=>Number.isSafeInteger(x)&&x>=0;
  for (const row of contentRows.iterate()) {
    tick();
    if (!safeInt(row.accepted_at) || !safeInt(row.message_retention_ms) ||
        row.accepted_at>Number.MAX_SAFE_INTEGER-row.message_retention_ms ||
        row.expires_at!==row.accepted_at+row.message_retention_ms ||
        row.key_created!==row.accepted_at || !safeInt(row.retry_until) || row.retry_until<row.key_created ||
        !hex.test(row.payload_hash) ||
        !uuid.test(row.message_id) || !uuid.test(row.conversation_id) ||
        !uuid.test(row.sender_id) || !uuid.test(row.recipient_id) ||
        row.in_reply_to!==null && !uuid.test(row.in_reply_to) ||
        !uuid.test(row.wire_client_id) || !uuid.test(row.origin_epoch) ||
        row.client_message_id!== (row.source_protocol==='a2a-msg.im.v1' ? row.wire_client_id : `v2:${row.origin_epoch}:${row.wire_client_id}`) ||
        row.reserved_id!==null && (!uuid.test(row.reserved_id) || !safeInt(row.reserved_size) ||
          row.reserved_size<1 || row.reserved_size>10485760 || !hex.test(row.reserved_hash))) throw mismatch();
    if (row.scrubbed_at!==null) {
      if (row.text!=='' || row.title!==null || row.correlation!==null || row.attachment_id!==null) throw mismatch();
      tick();
      continue;
    }
    if (typeof row.text!=='string' || row.text.length>32000 ||
        row.title!==null && (typeof row.title!=='string'||row.title.length>100) ||
        row.correlation!==null && (typeof row.correlation!=='string'||row.correlation.length>200) ||
        !row.text.length && row.attachment_id===null) throw mismatch();
    let attachment=null;
    if (row.attachment_id!==null) {
      if (row.reserved_id!==row.attachment_id || row.reserved_size!==row.size || row.reserved_hash!==row.sha256 ||
          !uuid.test(row.attachment_id) || typeof row.name!=='string' || !row.name.length || row.name.length>200 ||
          row.name==='.' || row.name.includes('..') || /[\\/\x00-\x1f\x7f]/.test(row.name) ||
          row.mime!==null && (typeof row.mime!=='string'||!row.mime.length||row.mime.length>100) ||
          !safeInt(row.size) || row.size<1 || row.size>10485760 || !hex.test(row.sha256) ||
          !(row.data instanceof Uint8Array) || row.data.length!==row.size ||
          createHash('sha256').update(row.data).digest('hex')!==row.sha256) throw mismatch();
      attachment={name:row.name,mime:row.mime,size:row.size,sha256:row.sha256};
    } else if (row.reserved_id!==null) throw mismatch();
    tick();
    const fingerprint=row.source_protocol==='a2a-msg.im.v1'
      ? fingerprintFrozenV1(row,attachment)
      : row.source_protocol==='a2a-msg.im.v2'
        ? createHash('sha256').update(JSON.stringify(['a2a-msg.im.v2',row.origin_epoch,row.conversation_id,row.recipient_id,
            row.wire_client_id,row.title,row.text,attachment && [attachment.name,attachment.mime,attachment.size,attachment.sha256],
            row.in_reply_to,row.correlation])).digest('hex') : null;
    if (fingerprint!==row.payload_hash) throw mismatch();
    tick();
  }
  for (const row of db.prepare('SELECT recipient_id,center_epoch,stream_epoch,seq,message_id FROM im_expiry_receipts').iterate()) {
    tick();
    const delivery=db.prepare('SELECT message_id FROM im_deliveries WHERE recipient_id=? AND seq=?').get(row.recipient_id,row.seq);
    if (delivery?.message_id!==row.message_id || db.prepare('SELECT state FROM im_content_state WHERE message_id=?').get(row.message_id)?.state!=='expired') throw mismatch();
  }
  for (const run of db.prepare('SELECT run_id,status,new_epoch,preparation_ref,candidate_kind,old_epoch,backup_id,backup_file_hash,manifest_hash,candidate_base_hash FROM im_recovery_runs').iterate()) {
    tick();
    if (run.candidate_kind==='snapshot_recovery' && (!run.old_epoch || run.old_epoch===run.new_epoch) || run.candidate_kind==='v3_import' && run.backup_id!==null && run.candidate_base_hash!==run.backup_file_hash) throw mismatch();
  }
  // SQLite CHECK permits NULL in legacy tables; a missing identity cannot become a v2 wire ID.
  const wireTables=[['im_agents',['agent_id']],['im_credentials',['credential_id','agent_id']],['im_contacts',['agent_low','agent_high']],['im_conversations',['conversation_id','agent_low','agent_high']],['im_messages',['message_id','conversation_id','sender_id','recipient_id','in_reply_to']],['im_attachments',['attachment_id','message_id']],['im_receive_state',['agent_id','stream_epoch']],['im_deliveries',['recipient_id','message_id']],['im_receiver_leases',['agent_id','instance_id','credential_id']]];
  for (const row of db.prepare('SELECT * FROM im_center_epochs').iterate()) {tick();if (!uuid.test(row.center_epoch) || !Number.isSafeInteger(row.recovery_counter)) throw mismatch();}
  for (const [table,fields] of wireTables) for (const row of db.prepare(`SELECT ${fields.join(',')} FROM ${table}`).iterate()) {
    tick();
    for (const field of fields) if (row[field]===null ? field!=='in_reply_to' : typeof row[field]!=='string'||!uuid.test(row[field])) throw mismatch();
  }
  for (const p of db.prepare('SELECT * FROM im_schema_preparations').iterate()) {
    tick();
    const policy=db.prepare('SELECT canonical_json FROM im_retention_policies WHERE policy_hash=?').get(p.policy_hash);
    if (!policy || p.kind==='v3_import' && (p.source_version!==3 || p.source_schema_checksum!==V3_CHECKSUM)) throw mismatch();
    let full;
    try {full=JSON.parse(policy.canonical_json);} catch {throw mismatch();}
    const hash=createHash('sha256').update(JSON.stringify([p.kind,p.source_version,p.source_schema_checksum,full,p.preparation_ref])).digest('hex');
    const initial=db.prepare('SELECT origin,recovery_counter FROM im_center_epochs WHERE center_epoch=?').get(p.initial_epoch);
    const imported=p.import_epoch && db.prepare('SELECT origin,recovery_counter FROM im_center_epochs WHERE center_epoch=?').get(p.import_epoch);
    if (p.input_hash!==hash || !initial || initial.origin!==p.kind || initial.recovery_counter!==0 || (p.kind==='v3_import' && (!imported || imported.origin!=='v3_import' || imported.recovery_counter!==0))) throw mismatch();
  }
  if (center.recovery_run_id) {
    const run=db.prepare('SELECT status,new_epoch,activation_ref,verified_at,activated_at,failure_code FROM im_recovery_runs WHERE run_id=?').get(center.recovery_run_id);
    if (!run || run.new_epoch!==center.center_epoch || (run.status==='failed' ? center.status!=='prepared' || center.activation_ref!==null || run.activated_at!==null || run.failure_code===null : run.status!==center.status || run.activation_ref!==center.activation_ref)) throw mismatch();
  }
  const corruption = [
    `SELECT 1 FROM im_schema_preparations p LEFT JOIN im_center_epochs a ON a.center_epoch=p.initial_epoch LEFT JOIN im_center_epochs b ON b.center_epoch=p.import_epoch WHERE a.center_epoch IS NULL OR (p.kind='v3_import' AND (b.center_epoch IS NULL OR p.source_schema_checksum IS NULL)) LIMIT 1`,
    `SELECT 1 FROM im_recovery_runs r LEFT JOIN im_schema_preparations p ON p.preparation_ref=r.preparation_ref WHERE (r.candidate_kind='fresh_bootstrap' AND (p.kind IS NOT 'fresh' OR r.new_epoch<>p.initial_epoch)) OR (r.candidate_kind='v3_import' AND (p.kind IS NOT 'v3_import' OR r.new_epoch<>p.initial_epoch)) LIMIT 1`,
    `SELECT 1 FROM im_send_operation_keys o JOIN im_send_keys k ON k.sender_id=o.sender_id AND k.client_message_id=o.storage_client_message_id JOIN im_messages m ON m.message_id=o.message_id WHERE k.message_id<>o.message_id OR m.sender_id<>o.sender_id OR m.client_message_id<>o.storage_client_message_id LIMIT 1`,
    `SELECT 1 FROM im_messages m JOIN im_conversations c ON c.conversation_id=m.conversation_id WHERE (m.sender_id<>c.agent_low AND m.sender_id<>c.agent_high) OR (m.recipient_id<>c.agent_low AND m.recipient_id<>c.agent_high) LIMIT 1`,
    `SELECT 1 FROM im_messages m LEFT JOIN im_content_state c ON c.message_id=m.message_id LEFT JOIN im_send_operation_keys o ON o.message_id=m.message_id LEFT JOIN im_deliveries d ON d.message_id=m.message_id WHERE c.message_id IS NULL OR o.message_id IS NULL OR d.message_id IS NULL OR d.recipient_id<>m.recipient_id LIMIT 1`,
    `SELECT 1 FROM im_send_keys k LEFT JOIN im_send_operation_keys o ON o.sender_id=k.sender_id AND o.storage_client_message_id=k.client_message_id WHERE o.message_id IS NULL OR o.message_id<>k.message_id LIMIT 1`,
    `SELECT 1 FROM im_content_state c LEFT JOIN im_messages m ON m.message_id=c.message_id WHERE m.message_id IS NULL LIMIT 1`,
    `SELECT 1 FROM im_send_operation_keys o LEFT JOIN im_center_epochs e ON e.center_epoch=o.origin_epoch WHERE e.center_epoch IS NULL OR (o.source_protocol='a2a-msg.im.v1' AND e.origin<>'v3_import') LIMIT 1`,
    `SELECT 1 FROM im_attachments a LEFT JOIN im_attachment_reservations r ON r.attachment_id=a.attachment_id LEFT JOIN im_content_state c ON c.message_id=a.message_id WHERE r.attachment_id IS NULL OR r.message_id<>a.message_id OR r.size<>a.size OR r.sha256<>a.sha256 OR c.message_id IS NULL OR c.scrubbed_at IS NOT NULL LIMIT 1`,
    `SELECT 1 FROM im_attachment_reservations r JOIN im_content_state c ON c.message_id=r.message_id LEFT JOIN im_attachments a ON a.attachment_id=r.attachment_id JOIN im_messages m ON m.message_id=r.message_id WHERE (c.scrubbed_at IS NULL AND (a.attachment_id IS NULL OR a.message_id<>r.message_id OR a.size<>r.size OR a.sha256<>r.sha256)) OR (c.scrubbed_at IS NOT NULL AND (a.attachment_id IS NOT NULL OR m.text<>'' OR m.title IS NOT NULL OR m.correlation IS NOT NULL)) LIMIT 1`,
    `SELECT 1 FROM im_content_state c JOIN im_messages m ON m.message_id=c.message_id WHERE c.scrubbed_at IS NOT NULL AND (m.text<>'' OR m.title IS NOT NULL OR m.correlation IS NOT NULL) LIMIT 1`,
    `SELECT 1 FROM im_attachment_reservations r LEFT JOIN im_content_state c ON c.message_id=r.message_id WHERE c.message_id IS NULL LIMIT 1`,
    `SELECT 1 FROM im_attachments a JOIN im_messages m ON m.message_id=a.message_id WHERE a.size<>length(a.data) OR m.message_id IS NULL LIMIT 1`,
    `SELECT 1 FROM im_sync_progress p LEFT JOIN im_receive_state r ON r.agent_id=p.recipient_id WHERE r.agent_id IS NULL OR p.handled_through>=r.next_seq LIMIT 1`,
    `SELECT 1 FROM im_deliveries d LEFT JOIN im_receive_state r ON r.agent_id=d.recipient_id WHERE r.agent_id IS NULL LIMIT 1`,
    `SELECT 1 FROM im_expiry_receipts e JOIN im_deliveries d ON d.recipient_id=e.recipient_id AND d.seq=e.seq JOIN im_content_state c ON c.message_id=e.message_id WHERE d.message_id<>e.message_id OR c.state<>'expired' LIMIT 1`,
    `SELECT 1 FROM im_send_operation_keys o JOIN im_center_epochs e ON e.center_epoch=o.origin_epoch WHERE o.source_protocol='a2a-msg.im.v2' AND (length(o.storage_client_message_id)<>76 OR o.storage_client_message_id<>'v2:'||o.origin_epoch||':'||o.client_message_id) LIMIT 1`,
  ];
  for (const sql of corruption) {tick();if (db.prepare(sql).get()) throw mismatch();tick();}
  for (const d of db.prepare('SELECT recipient_id,seq,message_id FROM im_deliveries').iterate()) {
    tick();
    const r=db.prepare('SELECT stream_epoch FROM im_receive_state WHERE agent_id=?').get(d.recipient_id);
    if (!r || !db.prepare('SELECT 1 FROM im_sync_progress WHERE recipient_id=? AND center_epoch=? AND stream_epoch=?').get(d.recipient_id,center.center_epoch,r.stream_epoch)) throw mismatch();
  }
  for (const row of db.prepare('SELECT m.message_id,m.conversation_id,m.in_reply_to FROM im_messages m WHERE m.in_reply_to IS NOT NULL').iterate()) {
    tick();
    if (db.prepare('SELECT conversation_id FROM im_messages WHERE message_id=?').get(row.in_reply_to)?.conversation_id!==row.conversation_id) throw mismatch();
  }
  for (const state of db.prepare('SELECT agent_id,stream_epoch,next_seq,retained_floor,acked_through FROM im_receive_state').iterate()) {
    tick();
    if (state.retained_floor!==1) throw mismatch();
    const progress=db.prepare('SELECT handled_through FROM im_sync_progress WHERE recipient_id=? AND center_epoch=? AND stream_epoch=?').get(state.agent_id,center.center_epoch,state.stream_epoch);
    if (!progress) throw mismatch();
    let seq=0,ack=0,prefix=true;
    for (const delivery of db.prepare('SELECT seq,acked_at FROM im_deliveries WHERE recipient_id=? ORDER BY seq').iterate(state.agent_id)) {
      tick();
      if (delivery.seq!==++seq) throw mismatch();
      if (delivery.acked_at===null) prefix=false;
      else if (prefix) ack=seq;
    }
    if (state.next_seq!==seq+1 || state.acked_through!==ack) throw mismatch();
  }
  for (const progress of db.prepare('SELECT recipient_id,center_epoch,stream_epoch,handled_through FROM im_sync_progress').iterate()) {
    tick();
    const state=db.prepare('SELECT stream_epoch,next_seq,acked_through FROM im_receive_state WHERE agent_id=?').get(progress.recipient_id);
    if (!state || progress.handled_through>=state.next_seq || progress.center_epoch===center.center_epoch && progress.stream_epoch!==state.stream_epoch) throw mismatch();
    // Each persisted epoch/stream must prove its own handled prefix; a receipt
    // for another epoch or stream is never transferable proof.
    const deliveries=db.prepare('SELECT seq,message_id,acked_at FROM im_deliveries WHERE recipient_id=? AND seq<=? ORDER BY seq');
    const receipt=db.prepare('SELECT message_id FROM im_expiry_receipts WHERE recipient_id=? AND center_epoch=? AND stream_epoch=? AND seq=?');
    const content=db.prepare('SELECT state FROM im_content_state WHERE message_id=?');
    let expectedSeq=0;
    for (const delivery of deliveries.iterate(progress.recipient_id,progress.handled_through)) {
      tick();
      if (delivery.seq!==++expectedSeq) throw mismatch();
      if (delivery.acked_at!==null) continue;
      const proof=receipt.get(progress.recipient_id,progress.center_epoch,progress.stream_epoch,delivery.seq);
      if (proof?.message_id!==delivery.message_id || content.get(delivery.message_id)?.state!=='expired') throw mismatch();
      tick();
    }
    if (expectedSeq!==progress.handled_through) throw mismatch();
  }
  // `LIMIT 1` avoids materializing every corrupt FK row in a damaged candidate.
  if (db.prepare('SELECT 1 FROM pragma_foreign_key_check LIMIT 1').get()) throw mismatch();
  tick();
  return true;
}
