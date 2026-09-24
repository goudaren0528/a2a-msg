import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { IM_SCHEMA_VERSION, migrateImSchema, migrateImSchemaV3, assertImSchema, getInstanceIdentity, initInstanceIdentity } from '../src/im/schema.js';
import { createHash } from 'node:crypto';
import { V2_DDL, V2_CHECKSUM } from './fixtures/im-schema/v2.js';
import { V1_DDL, V1_CHECKSUM } from './fixtures/im-schema/v1.js';
import { withImmediateTransaction } from '../src/im/transaction.js';

function database(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  t.after(() => db.close());
  return db;
}

function agent(db, agentId) {
  db.prepare("INSERT INTO im_agents(agent_id,display_name,status,created_at) VALUES (?,?,'active',1)").run(agentId, agentId);
}

test('first migration, repeat migration, manifest and isolated defaults', (t) => {
  const db = database(t);
  assert.equal(IM_SCHEMA_VERSION, 3);
  assert.equal(migrateImSchema(db), true);
  const before = db.prepare('SELECT * FROM im_schema').get();
  assert.match(before.migration_checksum, /^[0-9a-f]{64}$/);
  assert.equal(migrateImSchema(db), true);
  assert.deepEqual(db.prepare('SELECT * FROM im_schema').get(), before);
  assert.equal(assertImSchema(db), true);
  assert.deepEqual({ ...db.prepare('SELECT * FROM im_settings').get() }, { singleton: 1, write_mode: 'paused' });
  assert.deepEqual({ ...db.prepare('SELECT * FROM im_clock').get() }, { singleton: 1, last_observed_at: 0 });
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'im_%' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(names, ['im_agents','im_attachments','im_audit','im_clock','im_contacts','im_conversations','im_credentials','im_deliveries','im_instance_identity','im_lease_requests','im_legacy_bindings','im_messages','im_migration_runs','im_receive_state','im_receiver_leases','im_schema','im_send_keys','im_settings']);
  assert.throws(() => migrateImSchema(db, { expectedVersion: 1 }), { code: 'IM_SCHEMA_MISMATCH' });
});

const manifest = ddl => ddl.map(sql => {
  const [, type, name] = /^CREATE (TABLE|INDEX) (im_\w+)/.exec(sql);
  return [type.toLowerCase(), name, type === 'TABLE' ? name : / ON (im_\w+)/.exec(sql)[1], sql.trim().replace(/\s+/g, ' ')];
}).sort((a, b) => a[1].localeCompare(b[1]));
const snapshot = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'im_%' AND name NOT IN ('im_schema') ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));

test('frozen v2 DDL/checksum remain immutable and are independently accepted', t => {
  assert.equal(createHash('sha256').update(JSON.stringify(manifest(V2_DDL))).digest('hex'), V2_CHECKSUM);
  const db = database(t);
  for (const sql of V2_DDL) db.exec(sql);
  db.prepare('INSERT INTO im_schema VALUES (2,?)').run(V2_CHECKSUM);
  db.exec("INSERT INTO im_settings VALUES (1,'paused'); INSERT INTO im_clock VALUES (1,0)");
  assert.equal(assertImSchema(db), true);
  assert.equal(migrateImSchema(db), true);
  assert.deepEqual({ ...db.prepare('SELECT * FROM im_schema').get() }, { version: 2, migration_checksum: V2_CHECKSUM });
});

test('fresh v3 has only the additive run index and explicitly preserves existing v2', t => {
  const db = database(t), old = database(t);
  assert.equal(migrateImSchemaV3(db), true);
  assert.equal(assertImSchema(db), true);
  assert.equal(db.prepare('SELECT version FROM im_schema').get().version, 3);
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='im_legacy_bindings_run'").get().sql,
    'CREATE INDEX im_legacy_bindings_run ON im_legacy_bindings(migration_run_id)');
  assert.equal(migrateImSchemaV3(db), true);
  migrateImSchema(old);
  assert.equal(migrateImSchema(old), true);
  assert.equal(old.prepare('SELECT version FROM im_schema').get().version, 2);
});

test('explicit v2 to v3 keeps all IM rows and identity without touching business tables', t => {
  const db = database(t);
  migrateImSchema(db);
  const identity = initInstanceIdentity(db, { clock: () => 7 });
  db.exec(`INSERT INTO im_agents VALUES ('a','A','active',1,NULL),('b','B','active',1,NULL);
    INSERT INTO im_credentials VALUES ('credential','b','hash',1,NULL,NULL);
    INSERT INTO im_conversations VALUES ('conversation','a','b',2);
    INSERT INTO im_messages(message_id,conversation_id,sender_id,recipient_id,client_message_id,text,accepted_at) VALUES ('message','conversation','a','b','client','retained',3);
    INSERT INTO im_attachments VALUES ('attachment','message','x.bin',NULL,1,'${'a'.repeat(64)}',x'00');
    INSERT INTO im_send_keys VALUES ('a','client','${'b'.repeat(64)}','message',3,40,'live');
    INSERT INTO im_receive_state VALUES ('b',2,1,1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO im_deliveries VALUES ('b',1,'message',4,5);
    INSERT INTO im_receiver_leases VALUES ('b','00000000-0000-4000-8000-000000000002',1,100,'credential');
    INSERT INTO im_migration_runs VALUES ('run','${'c'.repeat(64)}','completed','admin',1,2);
    INSERT INTO im_legacy_bindings VALUES ('old','a','approval','run','active','legacy_ip');`);
  const before = snapshot(db);
  migrateImSchemaV3(db);
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(getInstanceIdentity(db), identity);
  assert.match(db.prepare("EXPLAIN QUERY PLAN SELECT legacy_member FROM im_legacy_bindings WHERE migration_run_id=?").all().map(r => r.detail).join(' '), /SEARCH im_legacy_bindings USING INDEX im_legacy_bindings_run/);
  assert.equal(migrateImSchemaV3(db), true);
  assert.deepEqual(snapshot(db), before);
  assert.throws(() => migrateImSchema(db), { code: 'IM_SCHEMA_MISMATCH' });
});

test('v2 to v3 failure rolls back index and marker together; corruption is never repaired', t => {
  for (const stage of ['index', 'marker']) {
    const db = database(t);
    migrateImSchema(db);
    const proxy = new Proxy(db, { get(target, prop) {
      if (prop === 'exec') return sql => {
        const result = target.exec(sql);
        if ((stage === 'index' && sql.startsWith('CREATE INDEX im_legacy_bindings_run')) ||
            (stage === 'marker' && sql.startsWith('CREATE TABLE im_schema'))) throw new Error('injected fault');
        return result;
      };
      const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    assert.throws(() => migrateImSchemaV3(proxy), /injected fault/);
    assert.equal(db.isTransaction, false);
    assert.deepEqual({ ...db.prepare('SELECT * FROM im_schema').get() }, { version: 2, migration_checksum: V2_CHECKSUM });
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='im_legacy_bindings_run'").get().n, 0);
    assert.equal(assertImSchema(db), true);
  }
  for (const mutation of ["UPDATE im_schema SET migration_checksum='0' || substr(migration_checksum,2)",
    'CREATE INDEX im_unexpected ON im_legacy_bindings(status)', 'CREATE INDEX im_legacy_bindings_run ON im_legacy_bindings(migration_run_id)']) {
    const db = database(t); migrateImSchema(db); db.exec(mutation);
    assert.throws(() => migrateImSchemaV3(db), { code: 'IM_SCHEMA_MISMATCH' });
    assert.equal(db.prepare('SELECT version FROM im_schema').get().version, 2);
  }
  const db = database(t);
  db.exec('CREATE TABLE im_partial(x)');
  assert.throws(() => migrateImSchemaV3(db), { code: 'IM_SCHEMA_MISMATCH' });
});

test('corrupted v3 rejects both assertion and repeated explicit migration without repair', t => {
  const mutations = [
    'DROP INDEX im_legacy_bindings_run',
    'DROP INDEX im_legacy_bindings_run; CREATE INDEX im_legacy_bindings_run ON im_legacy_bindings(status)',
    'CREATE INDEX im_extra ON im_legacy_bindings(status)',
    'CREATE TRIGGER im_extra AFTER INSERT ON im_agents BEGIN SELECT 1; END',
    "UPDATE im_schema SET migration_checksum='0' || substr(migration_checksum,2)",
  ];
  for (const mutation of mutations) {
    const db = database(t);
    migrateImSchemaV3(db);
    db.exec("INSERT INTO im_agents VALUES ('a','A','active',1,NULL)");
    db.exec(mutation);
    const rows = snapshot(db);
    const marker = { ...db.prepare('SELECT * FROM im_schema').get() };
    const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'im_%' OR tbl_name LIKE 'im_%' ORDER BY name").all();
    assert.throws(() => assertImSchema(db), { code: 'IM_SCHEMA_MISMATCH' }, mutation);
    assert.throws(() => migrateImSchemaV3(db), { code: 'IM_SCHEMA_MISMATCH' }, mutation);
    assert.deepEqual(snapshot(db), rows, mutation);
    assert.deepEqual({ ...db.prepare('SELECT * FROM im_schema').get() }, marker, mutation);
    assert.deepEqual(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'im_%' OR tbl_name LIKE 'im_%' ORDER BY name").all(), objects, mutation);
  }
});

test('frozen v1 cannot directly migrate to v3 and keeps its marker, schema and data', t => {
  const db = database(t);
  for (const sql of V1_DDL) db.exec(sql);
  db.prepare('INSERT INTO im_schema VALUES (1,?)').run(V1_CHECKSUM);
  db.exec("INSERT INTO im_settings VALUES (1,'paused'); INSERT INTO im_clock VALUES (1,0)");
  db.exec("INSERT INTO im_agents VALUES ('old','Old','active',1,NULL)");
  assert.equal(assertImSchema(db), true);
  const rows = snapshot(db);
  const marker = { ...db.prepare('SELECT * FROM im_schema').get() };
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'im_%' OR tbl_name LIKE 'im_%' ORDER BY name").all();
  assert.throws(() => migrateImSchemaV3(db), { code: 'IM_SCHEMA_MISMATCH' });
  assert.deepEqual(snapshot(db), rows);
  assert.deepEqual({ ...db.prepare('SELECT * FROM im_schema').get() }, marker);
  assert.deepEqual(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'im_%' OR tbl_name LIKE 'im_%' ORDER BY name").all(), objects);
  assert.equal(assertImSchema(db), true);
});

test('fresh v3 fault after index and marker rolls back every IM object', t => {
  for (const stage of ['index', 'marker']) {
    const db = database(t);
    let fired = false;
    const proxy = new Proxy(db, { get(target, property) {
      if (property === 'exec') return sql => {
        const result = target.exec(sql);
        if (stage === 'index' && sql.startsWith('CREATE INDEX im_legacy_bindings_run')) {
          fired = true; throw new Error('fresh v3 index fault');
        }
        return result;
      };
      if (property === 'prepare') return sql => {
        const statement = target.prepare(sql);
        if (stage !== 'marker' || !sql.startsWith('INSERT INTO im_schema(version,migration_checksum)')) return statement;
        return new Proxy(statement, { get(prepared, key) {
          if (key === 'run') return (...args) => {
            const result = prepared.run(...args);
            fired = true; throw new Error('fresh v3 marker fault');
          };
          const value = prepared[key]; return typeof value === 'function' ? value.bind(prepared) : value;
        } });
      };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    assert.throws(() => migrateImSchemaV3(proxy), /fresh v3 (index|marker) fault/);
    assert.equal(fired, true);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'im_%' OR tbl_name LIKE 'im_%'").all(), []);
  }
});

test('foreign keys must be explicitly enabled; no implicit initialization on import', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = OFF');
  assert.throws(() => migrateImSchema(db), { code: 'IM_SCHEMA_MISMATCH' });
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'im_%'").get().n, 0);
  db.exec('PRAGMA foreign_keys = ON');
  migrateImSchema(db);
  db.exec('PRAGMA foreign_keys = OFF');
  assert.throws(() => assertImSchema(db), { code: 'IM_SCHEMA_MISMATCH' });
});

test('unknown marker, counterfeit marker, missing column/index, and extra trigger fail closed', (t) => {
  for (const mutation of [
    "UPDATE im_schema SET version=99",
    "UPDATE im_schema SET migration_checksum='0' || substr(migration_checksum,2)",
    'DELETE FROM im_schema',
    'DROP INDEX im_messages_conversation',
    'CREATE TRIGGER im_unexpected AFTER INSERT ON im_agents BEGIN SELECT 1; END',
  ]) {
    const db = database(t);
    migrateImSchema(db);
    if (mutation.includes('version=99')) db.exec('PRAGMA ignore_check_constraints = ON');
    db.exec(mutation);
    db.exec('PRAGMA ignore_check_constraints = OFF');
    assert.throws(() => assertImSchema(db), { code: 'IM_SCHEMA_MISMATCH' }, mutation);
    assert.throws(() => migrateImSchema(db), { code: 'IM_SCHEMA_MISMATCH' }, mutation);
  }
  const db = database(t);
  migrateImSchema(db);
  db.exec('ALTER TABLE im_agents DROP COLUMN display_name');
  assert.throws(() => assertImSchema(db), { code: 'IM_SCHEMA_MISMATCH' });
});

test('old incomplete experiments cannot be adopted or overwritten', (t) => {
  const db = database(t);
  db.exec('CREATE TABLE im_agents(agent_id TEXT PRIMARY KEY)');
  assert.throws(() => migrateImSchema(db), { code: 'IM_SCHEMA_MISMATCH' });
  assert.deepEqual(db.prepare('PRAGMA table_info(im_agents)').all().map(r => r.name), ['agent_id']);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='im_schema'").get().n, 0);
});

test('injected initialization failure rolls back every new object', (t) => {
  const db = database(t);
  const proxy = new Proxy(db, { get(target, prop) {
    if (prop === 'exec') return (sql) => {
      if (sql.startsWith('CREATE TABLE im_messages ')) throw new Error('injected fault');
      return target.exec(sql);
    };
    const value = target[prop];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.throws(() => migrateImSchema(proxy), /injected fault/);
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'im_%'").get().n, 0);
  assert.equal(migrateImSchema(db), true);
});

test('legacy fixture survives byte-for-byte with IDs, read state, and attachment intact', (t) => {
  const db = database(t);
  db.exec(`CREATE TABLE members(name TEXT PRIMARY KEY,display_name TEXT,created_at TEXT,revoked_at TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,from_name TEXT,to_name TEXT,text TEXT,read_at TEXT);
    CREATE TABLE attachments(id INTEGER PRIMARY KEY,message_id INTEGER,name TEXT,data BLOB);
    INSERT INTO members VALUES ('alice','Alice','old',NULL);
    INSERT INTO messages VALUES (7,'alice','bob','old message','old read');`);
  db.prepare('INSERT INTO attachments VALUES (9,7,?,?)').run('old.bin', Buffer.from([0, 1, 255]));
  const snapshot = ['members','messages','attachments'].map(table => db.prepare(`SELECT * FROM ${table}`).all());
  migrateImSchema(db);
  assert.deepEqual(['members','messages','attachments'].map(table => db.prepare(`SELECT * FROM ${table}`).all()), snapshot);
});

test('FK, ordered pair, single attachment, send key and recipient sequence constraints', (t) => {
  const db = database(t);
  migrateImSchema(db);
  agent(db, 'a'); agent(db, 'b');
  assert.throws(() => db.exec("INSERT INTO im_contacts VALUES ('a','missing',1,1,1)"), /FOREIGN KEY/);
  db.exec("INSERT INTO im_contacts VALUES ('a','b',1,1,1)");
  assert.throws(() => db.exec("INSERT INTO im_contacts VALUES ('b','a',1,1,1)"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO im_contacts VALUES ('a','b',1,1,1)"), /UNIQUE/);
  db.exec("INSERT INTO im_conversations VALUES ('c','a','b',1)");
  assert.throws(() => db.exec("INSERT INTO im_conversations VALUES ('d','a','b',1)"), /UNIQUE/);
  db.exec("INSERT INTO im_messages(message_id,conversation_id,sender_id,recipient_id,client_message_id,text,accepted_at) VALUES ('m','c','a','b','key','hello',1)");
  db.exec("INSERT INTO im_send_keys VALUES ('a','key','" + 'a'.repeat(64) + "','m',1,2,'live')");
  assert.throws(() => db.exec("INSERT INTO im_send_keys VALUES ('a','key','" + 'a'.repeat(64) + "','m',1,2,'live')"), /UNIQUE/);
  db.exec("INSERT INTO im_deliveries(recipient_id,seq,message_id) VALUES ('b',1,'m')");
  assert.throws(() => db.exec("INSERT INTO im_deliveries(recipient_id,seq,message_id) VALUES ('b',1,'m')"), /UNIQUE/);
  assert.throws(() => db.exec("UPDATE im_deliveries SET read_at=2 WHERE message_id='m'"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO im_attachments(attachment_id,message_id,name,size,sha256,data) VALUES ('bad','m','x',0,'" + 'a'.repeat(64) + "',x'00')"), /CHECK/);
  db.exec("INSERT INTO im_attachments(attachment_id,message_id,name,size,sha256,data) VALUES ('att','m','x',1,'" + 'a'.repeat(64) + "',x'00')");
  assert.throws(() => db.exec("INSERT INTO im_attachments(attachment_id,message_id,name,size,sha256,data) VALUES ('att2','m','x',1,'" + 'a'.repeat(64) + "',x'00')"), /UNIQUE/);
});

test('immediate transaction commits, rolls back, rejects nesting and async callbacks', (t) => {
  const db = database(t);
  db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY)');
  assert.equal(withImmediateTransaction(db, () => { db.exec('INSERT INTO sample VALUES (1)'); return 42; }), 42);
  assert.throws(() => withImmediateTransaction(db, () => {
    db.exec('INSERT INTO sample VALUES (2)');
    throw new Error('original failure');
  }), /original failure/);
  assert.throws(() => withImmediateTransaction(db, () => withImmediateTransaction(db, () => 1)), { code: 'IM_TRANSACTION_INVALID' });
  assert.throws(() => withImmediateTransaction(db, async () => 1), { code: 'IM_TRANSACTION_INVALID' });
  assert.throws(() => withImmediateTransaction(db, () => { db.exec('INSERT INTO sample VALUES (3)'); return { then() {} }; }), { code: 'IM_TRANSACTION_INVALID' });
  assert.deepEqual(db.prepare('SELECT id FROM sample').all().map(r => r.id), [1]);
  assert.equal(db.isTransaction, false);
});
