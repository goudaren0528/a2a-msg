import { createHash, randomUUID } from 'node:crypto';
import { withImmediateTransaction } from './transaction.js';

export const IM_SCHEMA_VERSION = 3;
export const SUPPORTED_IM_SCHEMA_VERSIONS = Object.freeze([1, 2, 3]);
const MAX_INT = 9007199254740991;
const MAX_JSON = 65536;
const id = (column) => `CHECK(length(${column}) BETWEEN 1 AND 255)`;
const time = (column) => `CHECK(${column} IS NULL OR (typeof(${column}) = 'integer' AND ${column} BETWEEN 0 AND ${MAX_INT}))`;
const uuid = (column) => `CHECK(length(${column}) = 36 AND substr(${column},9,1) = '-' AND substr(${column},14,1) = '-' AND substr(${column},19,1) = '-' AND substr(${column},24,1) = '-' AND ${column} NOT GLOB '*[^0-9a-f-]*')`;
const identityUuid = (column) => `CHECK(typeof(${column}) = 'text' AND length(${column}) = 36 AND ${column} GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')`;
const json = (column) => `CHECK(length(${column}) BETWEEN 2 AND ${MAX_JSON} AND json_valid(${column}))`;

// This is an immutable v1 manifest. Change it only by introducing a reviewed v2 migration.
const TABLES = [
  `CREATE TABLE im_schema (version INTEGER NOT NULL PRIMARY KEY CHECK(version = 1), migration_checksum TEXT NOT NULL CHECK(length(migration_checksum) = 64))`,
  `CREATE TABLE im_agents (agent_id TEXT PRIMARY KEY ${id('agent_id')}, display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 255), status TEXT NOT NULL CHECK(status IN ('active','disabled')), created_at INTEGER NOT NULL ${time('created_at')}, revoked_at INTEGER ${time('revoked_at')})`,
  `CREATE TABLE im_credentials (credential_id TEXT PRIMARY KEY ${id('credential_id')}, agent_id TEXT NOT NULL REFERENCES im_agents(agent_id) ${id('agent_id')}, secret_hash TEXT NOT NULL CHECK(length(secret_hash) BETWEEN 1 AND 512), created_at INTEGER NOT NULL ${time('created_at')}, expires_at INTEGER ${time('expires_at')}, revoked_at INTEGER ${time('revoked_at')})`,
  `CREATE TABLE im_contacts (agent_low TEXT NOT NULL REFERENCES im_agents(agent_id), agent_high TEXT NOT NULL REFERENCES im_agents(agent_id), allowed INTEGER NOT NULL CHECK(allowed IN (0,1)), version INTEGER NOT NULL ${time('version')} CHECK(version >= 1), updated_at INTEGER NOT NULL ${time('updated_at')}, PRIMARY KEY(agent_low,agent_high), CHECK(agent_low < agent_high))`,
  `CREATE TABLE im_conversations (conversation_id TEXT PRIMARY KEY ${id('conversation_id')}, agent_low TEXT NOT NULL REFERENCES im_agents(agent_id), agent_high TEXT NOT NULL REFERENCES im_agents(agent_id), created_at INTEGER NOT NULL ${time('created_at')}, UNIQUE(agent_low,agent_high), CHECK(agent_low < agent_high))`,
  `CREATE TABLE im_messages (message_id TEXT PRIMARY KEY ${id('message_id')}, conversation_id TEXT NOT NULL REFERENCES im_conversations(conversation_id), sender_id TEXT NOT NULL REFERENCES im_agents(agent_id), recipient_id TEXT NOT NULL REFERENCES im_agents(agent_id), client_message_id TEXT NOT NULL ${id('client_message_id')}, title TEXT CHECK(title IS NULL OR length(title) <= 512), text TEXT NOT NULL CHECK(length(text) <= 1048576), in_reply_to TEXT REFERENCES im_messages(message_id), correlation TEXT CHECK(correlation IS NULL OR length(correlation) <= 255), accepted_at INTEGER NOT NULL ${time('accepted_at')}, CHECK(sender_id <> recipient_id))`,
  `CREATE TABLE im_attachments (attachment_id TEXT PRIMARY KEY ${id('attachment_id')}, message_id TEXT NOT NULL UNIQUE REFERENCES im_messages(message_id), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 255), mime TEXT CHECK(mime IS NULL OR length(mime) <= 255), size INTEGER NOT NULL CHECK(typeof(size) = 'integer' AND size BETWEEN 1 AND 10485760), sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'), data BLOB NOT NULL CHECK(typeof(data) = 'blob' AND length(data) = size))`,
  `CREATE TABLE im_send_keys (sender_id TEXT NOT NULL REFERENCES im_agents(agent_id), client_message_id TEXT NOT NULL ${id('client_message_id')}, payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'), message_id TEXT NOT NULL UNIQUE REFERENCES im_messages(message_id), created_at INTEGER NOT NULL ${time('created_at')}, retry_until INTEGER NOT NULL ${time('retry_until')}, status TEXT NOT NULL CHECK(status IN ('live','expired')), PRIMARY KEY(sender_id,client_message_id), CHECK(retry_until >= created_at))`,
  `CREATE TABLE im_receive_state (agent_id TEXT PRIMARY KEY REFERENCES im_agents(agent_id), next_seq INTEGER NOT NULL DEFAULT 1 ${time('next_seq')} CHECK(next_seq >= 1), acked_through INTEGER NOT NULL DEFAULT 0 ${time('acked_through')}, retained_floor INTEGER NOT NULL DEFAULT 1 ${time('retained_floor')} CHECK(retained_floor >= 1), stream_epoch TEXT NOT NULL ${uuid('stream_epoch')}, CHECK(acked_through < next_seq AND retained_floor <= next_seq))`,
  `CREATE TABLE im_deliveries (recipient_id TEXT NOT NULL REFERENCES im_agents(agent_id), seq INTEGER NOT NULL ${time('seq')} CHECK(seq >= 1), message_id TEXT NOT NULL UNIQUE REFERENCES im_messages(message_id), acked_at INTEGER ${time('acked_at')}, read_at INTEGER ${time('read_at')}, PRIMARY KEY(recipient_id,seq), CHECK(read_at IS NULL OR acked_at IS NOT NULL))`,
  `CREATE TABLE im_receiver_leases (agent_id TEXT PRIMARY KEY REFERENCES im_agents(agent_id), instance_id TEXT NOT NULL ${uuid('instance_id')}, generation INTEGER NOT NULL ${time('generation')} CHECK(generation >= 1), expires_at INTEGER NOT NULL ${time('expires_at')}, credential_id TEXT NOT NULL REFERENCES im_credentials(credential_id))`,
  `CREATE TABLE im_lease_requests (agent_id TEXT NOT NULL REFERENCES im_agents(agent_id), request_id TEXT NOT NULL ${id('request_id')}, request_hash TEXT NOT NULL CHECK(length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'), instance_id TEXT NOT NULL ${uuid('instance_id')}, generation INTEGER NOT NULL ${time('generation')} CHECK(generation >= 1), result_json TEXT NOT NULL ${json('result_json')}, PRIMARY KEY(agent_id,request_id))`,
  `CREATE TABLE im_audit (id INTEGER PRIMARY KEY, actor_kind TEXT NOT NULL CHECK(actor_kind IN ('admin','agent','system')), actor_id TEXT NOT NULL ${id('actor_id')}, action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 128), target_ids_json TEXT NOT NULL ${json('target_ids_json')}, occurred_at INTEGER NOT NULL ${time('occurred_at')}, safe_details_json TEXT NOT NULL ${json('safe_details_json')})`,
  `CREATE TABLE im_legacy_bindings (legacy_member TEXT NOT NULL UNIQUE ${id('legacy_member')}, agent_id TEXT NOT NULL UNIQUE REFERENCES im_agents(agent_id), approval_ref TEXT NOT NULL ${id('approval_ref')}, migration_run_id TEXT NOT NULL REFERENCES im_migration_runs(run_id), status TEXT NOT NULL CHECK(status IN ('active','revoked')), source TEXT NOT NULL DEFAULT 'legacy_ip' CHECK(source = 'legacy_ip'))`,
  `CREATE TABLE im_migration_runs (run_id TEXT PRIMARY KEY ${id('run_id')}, preview_hash TEXT NOT NULL CHECK(length(preview_hash) = 64 AND preview_hash NOT GLOB '*[^0-9a-f]*'), status TEXT NOT NULL CHECK(status IN ('previewed','approved','completed','failed')), actor_id TEXT NOT NULL ${id('actor_id')}, created_at INTEGER NOT NULL ${time('created_at')}, completed_at INTEGER ${time('completed_at')})`,
  `CREATE TABLE im_settings (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), write_mode TEXT NOT NULL DEFAULT 'paused' CHECK(write_mode IN ('paused','enabled')))`,
  `CREATE TABLE im_clock (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), last_observed_at INTEGER NOT NULL DEFAULT 0 ${time('last_observed_at')})`,
];
const INDEXES = [
  `CREATE INDEX im_credentials_agent ON im_credentials(agent_id)`,
  `CREATE INDEX im_messages_conversation ON im_messages(conversation_id,accepted_at,message_id)`,
  `CREATE INDEX im_messages_sender ON im_messages(sender_id,client_message_id)`,
  `CREATE INDEX im_deliveries_message ON im_deliveries(message_id)`,
  `CREATE INDEX im_send_keys_retry ON im_send_keys(retry_until,status)`,
  `CREATE INDEX im_audit_occurred ON im_audit(occurred_at,id)`,
];
const DDL = [...TABLES, ...INDEXES];
const normalize = (sql) => sql.trim().replace(/\s+/g, ' ');
const manifest = (rows) => rows.map(({ type, name, tbl_name, sql }) =>
  [type, name, tbl_name, normalize(sql)]).sort((a, b) => a[1].localeCompare(b[1]));
const EXPECTED = manifest(DDL.map((sql) => {
  const [, type, name] = /^CREATE (TABLE|INDEX) (im_\w+)/.exec(sql);
  return { type: type.toLowerCase(), name, tbl_name: type === 'TABLE' ? name : / ON (im_\w+)/.exec(sql)[1], sql };
}));
const CHECKSUM = createHash('sha256').update(JSON.stringify(EXPECTED)).digest('hex');
const V2_SCHEMA = `CREATE TABLE im_schema (version INTEGER NOT NULL PRIMARY KEY CHECK(version = 2), migration_checksum TEXT NOT NULL CHECK(length(migration_checksum) = 64))`;
const IDENTITY_SCHEMA = `CREATE TABLE im_instance_identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), instance_id TEXT NOT NULL ${identityUuid('instance_id')}, created_at INTEGER NOT NULL ${time('created_at')})`;
const V2_DDL = [V2_SCHEMA, ...TABLES.slice(1), IDENTITY_SCHEMA, ...INDEXES];
const V2_EXPECTED = manifest(V2_DDL.map((sql) => {
  const [, type, name] = /^CREATE (TABLE|INDEX) (im_\w+)/.exec(sql);
  return { type: type.toLowerCase(), name, tbl_name: type === 'TABLE' ? name : / ON (im_\w+)/.exec(sql)[1], sql };
}));
const V2_CHECKSUM = createHash('sha256').update(JSON.stringify(V2_EXPECTED)).digest('hex');
const V3_INDEX = `CREATE INDEX im_legacy_bindings_run ON im_legacy_bindings(migration_run_id)`;
const V3_SCHEMA = `CREATE TABLE im_schema (version INTEGER NOT NULL PRIMARY KEY CHECK(version = 3), migration_checksum TEXT NOT NULL CHECK(length(migration_checksum) = 64))`;
const V3_DDL = [V3_SCHEMA, ...V2_DDL.slice(1), V3_INDEX];
const V3_EXPECTED = manifest(V3_DDL.map((sql) => {
  const [, type, name] = /^CREATE (TABLE|INDEX) (im_\w+)/.exec(sql);
  return { type: type.toLowerCase(), name, tbl_name: type === 'TABLE' ? name : / ON (im_\w+)/.exec(sql)[1], sql };
}));
const V3_CHECKSUM = createHash('sha256').update(JSON.stringify(V3_EXPECTED)).digest('hex');

function mismatch() {
  const error = new Error('IM storage schema does not match the supported migration');
  error.code = 'IM_SCHEMA_MISMATCH';
  return error;
}

function objects(db) {
  return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE (name LIKE 'im_%' OR tbl_name LIKE 'im_%') AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name`).all();
}

function requireForeignKeys(db) {
  if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw mismatch();
}

function checkImSchema(db, allowUninitializedIdentity = false) {
  requireForeignKeys(db);
  const rows = objects(db);
  let marker;
  try { marker = db.prepare('SELECT version,migration_checksum FROM im_schema').all(); }
  catch { throw mismatch(); }
  if (marker.length !== 1) throw mismatch();
  const { version, migration_checksum: checksum } = marker[0];
  const expected = version === 1 ? EXPECTED : version === 2 ? V2_EXPECTED : version === 3 ? V3_EXPECTED : null;
  const expectedChecksum = version === 1 ? CHECKSUM : version === 2 ? V2_CHECKSUM : version === 3 ? V3_CHECKSUM : null;
  if (!expected || checksum !== expectedChecksum || JSON.stringify(manifest(rows)) !== JSON.stringify(expected)) throw mismatch();
  if (db.prepare('SELECT singleton,write_mode FROM im_settings').all().length !== 1 ||
      db.prepare('SELECT singleton,last_observed_at FROM im_clock').all().length !== 1) throw mismatch();
  if (version === 2 || version === 3) {
    const identities = db.prepare('SELECT singleton,instance_id,created_at FROM im_instance_identity').all();
    if ((!allowUninitializedIdentity && identities.length !== 1) || identities.length > 1 || identities.some(row => row.singleton !== 1 ||
        typeof row.instance_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.instance_id) ||
        !Number.isSafeInteger(row.created_at) || row.created_at < 0)) throw mismatch();
  }
  if (db.prepare('PRAGMA foreign_key_check').all().some((row) => row.table.startsWith('im_'))) throw mismatch();
  return true;
}

export function assertImSchema(db) {
  return checkImSchema(db, true);
}

export function assertInstanceIdentity(db) {
  assertImSchema(db);
  if (![2, 3].includes(db.prepare('SELECT version FROM im_schema').get().version)) throw mismatch();
  if (!db.prepare('SELECT 1 FROM im_instance_identity WHERE singleton=1').get())
    throw Object.assign(new Error('Instance identity not initialized'), { code: 'IM_IDENTITY_MISSING' });
  return true;
}

// Legacy explicit v1 -> v2 path: never silently upgrade an existing database to v3.
export function migrateImSchema(db, { expectedVersion = 2 } = {}) {
  if (expectedVersion !== 2) throw mismatch();
  requireForeignKeys(db);
  // Both the existence probe and creation must happen under the same write lock.
  return withImmediateTransaction(db, () => {
    if (objects(db).length) {
      checkImSchema(db, true);
      const version = db.prepare('SELECT version FROM im_schema').get().version;
       if (version === 2) return true;
       if (version !== 1) throw mismatch();
      // Preserve the immutable v1 manifest; only the marker table is replaced in v2.
      db.exec('DROP TABLE im_schema');
      db.exec(V2_SCHEMA);
      db.prepare('INSERT INTO im_schema(version,migration_checksum) VALUES (?,?)').run(2, V2_CHECKSUM);
      db.exec(IDENTITY_SCHEMA);
      return checkImSchema(db, true);
    }
    for (const sql of V2_DDL) db.exec(sql);
    db.prepare('INSERT INTO im_schema(version,migration_checksum) VALUES (?,?)').run(2, V2_CHECKSUM);
    db.exec("INSERT INTO im_settings(singleton,write_mode) VALUES (1,'paused')");
    db.exec('INSERT INTO im_clock(singleton,last_observed_at) VALUES (1,0)');
    return checkImSchema(db, true);
  });
}

// Explicit v2 -> v3 only. A fresh database may be initialized directly at v3;
// existing v1 databases must take the original v1 -> v2 path first.
export function migrateImSchemaV3(db) {
  requireForeignKeys(db);
  return withImmediateTransaction(db, () => {
    if (!objects(db).length) {
      for (const sql of V3_DDL) db.exec(sql);
      db.prepare('INSERT INTO im_schema(version,migration_checksum) VALUES (?,?)').run(3, V3_CHECKSUM);
      db.exec("INSERT INTO im_settings(singleton,write_mode) VALUES (1,'paused')");
      db.exec('INSERT INTO im_clock(singleton,last_observed_at) VALUES (1,0)');
      return checkImSchema(db, true);
    }
    checkImSchema(db, true);
    const version = db.prepare('SELECT version FROM im_schema').get().version;
    if (version === 3) return true;
    if (version !== 2) throw mismatch();
    db.exec(V3_INDEX);
    db.exec('DROP TABLE im_schema');
    db.exec(V3_SCHEMA);
    db.prepare('INSERT INTO im_schema(version,migration_checksum) VALUES (?,?)').run(3, V3_CHECKSUM);
    return checkImSchema(db, true);
  });
}

export function initInstanceIdentity(db, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => key !== 'clock') || Object.getOwnPropertySymbols(options).length)
    throw Object.assign(new Error('Invalid identity initialization options'), { code: 'IM_IDENTITY_INPUT_INVALID' });
  const { clock = Date.now } = options;
  if (typeof clock !== 'function')
    throw Object.assign(new Error('Invalid identity initialization clock'), { code: 'IM_IDENTITY_INPUT_INVALID' });
  return withImmediateTransaction(db, () => {
    checkImSchema(db, true);
    if (![2, 3].includes(db.prepare('SELECT version FROM im_schema').get().version)) throw mismatch();
    if (db.prepare('SELECT 1 FROM im_instance_identity').get()) throw Object.assign(new Error('Instance identity already initialized'), { code: 'IM_IDENTITY_EXISTS' });
    const createdAt = clock();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw Object.assign(new Error('Invalid identity time'), { code: 'IM_IDENTITY_TIME_INVALID' });
    const instanceId = randomUUID();
    db.prepare('INSERT INTO im_instance_identity(singleton,instance_id,created_at) VALUES (1,?,?)').run(instanceId, createdAt);
    return { instanceId, createdAt };
  });
}

export function getInstanceIdentity(db) {
  assertInstanceIdentity(db);
  const row = db.prepare('SELECT instance_id,created_at FROM im_instance_identity WHERE singleton=1').get();
  return { instanceId: row.instance_id, createdAt: row.created_at };
}
