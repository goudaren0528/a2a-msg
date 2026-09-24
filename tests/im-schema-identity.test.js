import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { IM_SCHEMA_VERSION, assertImSchema, assertInstanceIdentity, migrateImSchema, migrateImSchemaV3, initInstanceIdentity, getInstanceIdentity } from '../src/im/schema.js';
import { createImBackup } from '../src/im/backup.js';
import { V1_DDL, V1_CHECKSUM } from './fixtures/im-schema/v1.js';

const schemaRows = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE (name LIKE 'im_%' OR tbl_name LIKE 'im_%') AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name").all();
const manifest = rows => rows.map(({ type, name, tbl_name, sql }) =>
  [type, name, tbl_name, sql.trim().replace(/\s+/g, ' ')]).sort((a, b) => a[1].localeCompare(b[1]));
const ddlManifest = manifest(V1_DDL.map(sql => {
  const [, type, name] = /^CREATE (TABLE|INDEX) (im_\w+)/.exec(sql);
  return { type: type.toLowerCase(), name, tbl_name: type === 'TABLE' ? name : / ON (im_\w+)/.exec(sql)[1], sql };
}));

// Never derive v1 schema or its checksum from the current v2 implementation.
function v1(db) {
  for (const sql of V1_DDL) db.exec(sql);
  db.prepare('INSERT INTO im_schema VALUES (1,?)').run(V1_CHECKSUM);
  db.exec("INSERT INTO im_settings VALUES (1,'paused'); INSERT INTO im_clock VALUES (1,0)");
  assert.deepEqual(manifest(schemaRows(db)), ddlManifest);
  assert.equal(assertImSchema(db), true);
}

function populatedV1(db) {
  v1(db);
  db.exec(`INSERT INTO im_agents VALUES ('a','A','active',1,NULL),('b','B','active',1,NULL);
    INSERT INTO im_credentials VALUES ('credential','b','hash',1,NULL,NULL);
    INSERT INTO im_conversations VALUES ('conversation','a','b',2);
    INSERT INTO im_messages(message_id,conversation_id,sender_id,recipient_id,client_message_id,text,accepted_at)
      VALUES ('message','conversation','a','b','client','retained',3);
    INSERT INTO im_attachments VALUES ('attachment','message','x.bin',NULL,1,'${'a'.repeat(64)}',x'00');
    INSERT INTO im_send_keys VALUES ('a','client','${'b'.repeat(64)}','message',3,40,'live');
    INSERT INTO im_receive_state VALUES ('b',2,1,1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO im_deliveries VALUES ('b',1,'message',4,5);
    INSERT INTO im_receiver_leases VALUES ('b','00000000-0000-4000-8000-000000000002',1,100,'credential');
    INSERT INTO im_migration_runs VALUES ('run','${'c'.repeat(64)}','completed','admin',1,2);
    INSERT INTO im_legacy_bindings VALUES ('old','a','approval','run','active','legacy_ip');`);
}

function snapshot(db) {
  const objects = schemaRows(db).filter(row => row.name !== 'im_schema' && row.name !== 'im_instance_identity');
  const data = Object.fromEntries(objects.filter(row => row.type === 'table').map(row =>
    [row.name, db.prepare(`SELECT * FROM ${row.name} ORDER BY rowid`).all()]));
  return { objects, data };
}

test('frozen v1 DDL and checksum match original manifest and current v1 verifier', t => {
  assert.equal(createHash('sha256').update(JSON.stringify(ddlManifest)).digest('hex'), V1_CHECKSUM);
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  v1(db); // A change to shared TABLES must fail here even if implementation checksums drift together.
});

test('v1 upgrade preserves every business table row and object SQL without rebuilding', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  populatedV1(db);
  const before = snapshot(db);
  assert.equal(migrateImSchema(db), true);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare('SELECT version FROM im_schema').get().version, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM im_instance_identity').get().n, 0);
  assert.equal(assertImSchema(db), true);
});

test('all v1 upgrade write stages roll back marker, schema and populated rows', t => {
  const stages = [
    { name: 'after DROP marker', event: 'exec', match: sql => sql === 'DROP TABLE im_schema', after: true },
    { name: 'after CREATE marker', event: 'exec', match: sql => sql === 'CREATE TABLE im_schema (version INTEGER NOT NULL PRIMARY KEY CHECK(version = 2), migration_checksum TEXT NOT NULL CHECK(length(migration_checksum) = 64))', after: true },
    { name: 'after marker INSERT', event: 'run', match: sql => sql.startsWith('INSERT INTO im_schema(version,migration_checksum)'), after: true },
    { name: 'at CREATE identity', event: 'exec', match: sql => sql.startsWith('CREATE TABLE im_instance_identity'), after: false },
  ];
  for (const stage of stages) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec('PRAGMA foreign_keys=ON');
    populatedV1(db);
    const before = snapshot(db);
    const marker = { ...db.prepare('SELECT * FROM im_schema').get() };
    let fired = false;
    const throwFault = () => { fired = true; throw new Error(stage.name); };
    const proxy = new Proxy(db, { get(target, property) {
      if (property === 'exec') return sql => {
        if (stage.event === 'exec' && stage.match(sql) && !stage.after) throwFault();
        const result = target.exec(sql);
        if (stage.event === 'exec' && stage.match(sql) && stage.after) throwFault();
        return result;
      };
      if (property === 'prepare') return sql => {
        const statement = target.prepare(sql);
        if (stage.event !== 'run' || !stage.match(sql)) return statement;
        return new Proxy(statement, { get(prepared, key) {
          if (key === 'run') return (...args) => {
            if (!stage.after) throwFault();
            const result = prepared.run(...args);
            throwFault();
            return result;
          };
          const value = prepared[key];
          return typeof value === 'function' ? value.bind(prepared) : value;
        } });
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    assert.throws(() => migrateImSchema(proxy), new RegExp(stage.name));
    assert.equal(fired, true, stage.name);
    assert.equal(db.isTransaction, false, stage.name);
    assert.equal(assertImSchema(db), true, stage.name);
    assert.deepEqual({ ...db.prepare('SELECT * FROM im_schema').get() }, marker, stage.name);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='im_instance_identity'").get().n, 0, stage.name);
    assert.deepEqual(snapshot(db), before, stage.name);
  }
});

test('two independent connections preserve initialized v2 identity on repeated migration', t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-upgrade-two-connections-'));
  const path = join(dir, 'source.sqlite');
  const a = new DatabaseSync(path);
  const b = new DatabaseSync(path);
  t.after(() => { b.close(); a.close(); rmSync(dir, { recursive: true, force: true }); });
  a.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
  b.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000');
  populatedV1(a);
  const before = snapshot(a);
  assert.equal(b.prepare('SELECT version FROM im_schema').get().version, 1);
  assert.equal(migrateImSchema(a), true);
  assert.equal(migrateImSchema(b), true);
  assert.equal(assertImSchema(a), true);
  assert.equal(assertImSchema(b), true);
  assert.equal(a.prepare('SELECT version FROM im_schema').get().version, 2);
  assert.deepEqual(snapshot(b), before);
  const identity = initInstanceIdentity(a, { clock: () => 123 });
  assert.equal(migrateImSchema(b), true);
  assert.deepEqual(getInstanceIdentity(b), identity);
});

test('concurrent independent processes upgrade one v1 database to exactly one complete v2', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-upgrade-race-'));
  const path = join(dir, 'source.sqlite');
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
  populatedV1(db);
  const before = snapshot(db);
  const worker = `import { DatabaseSync } from 'node:sqlite';
    import { migrateImSchema } from './src/im/schema.js';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    try { migrateImSchema(db); } finally { db.close(); }`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, path], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`upgrade worker exit ${code}: ${stderr}`)));
  });
  await Promise.all([run(), run()]);
  assert.equal(db.prepare('SELECT version FROM im_schema').get().version, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM im_instance_identity').get().n, 0);
  assert.equal(assertImSchema(db), true);
  assert.deepEqual(snapshot(db), before);
});

test('v1 upgrade rejects unknown marker, counterfeit checksum and extra objects without writes', t => {
  for (const mutation of [
    "UPDATE im_schema SET version=99",
    "UPDATE im_schema SET migration_checksum='0' || substr(migration_checksum,2)",
    'CREATE INDEX im_counterfeit ON im_messages(message_id)',
  ]) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec('PRAGMA foreign_keys=ON');
    populatedV1(db);
    if (mutation.includes('version=99')) db.exec('PRAGMA ignore_check_constraints=ON');
    db.exec(mutation);
    db.exec('PRAGMA ignore_check_constraints=OFF');
    const before = snapshot(db);
    const marker = { ...db.prepare('SELECT * FROM im_schema').get() };
    assert.throws(() => migrateImSchema(db), { code: 'IM_SCHEMA_MISMATCH' }, mutation);
    assert.deepEqual({ ...db.prepare('SELECT * FROM im_schema').get() }, marker, mutation);
    assert.deepEqual(snapshot(db), before, mutation);
  }
});

test('v1 upgrade is additive and identity requires one explicit initialization, persists across reopen', t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-identity-'));
  const path = join(dir, 'source.sqlite');
  let db = new DatabaseSync(path);
  t.after(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('PRAGMA foreign_keys=ON');
  v1(db);
  assert.equal(IM_SCHEMA_VERSION, 3);
  assert.equal(migrateImSchema(db), true);
  assert.equal(db.prepare('SELECT version FROM im_schema').get().version, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM im_instance_identity').get().n, 0);
  assert.equal(assertImSchema(db), true);
  assert.throws(() => assertInstanceIdentity(db), { code: 'IM_IDENTITY_MISSING' });
  assert.throws(() => getInstanceIdentity(db), { code: 'IM_IDENTITY_MISSING' });
  const identity = initInstanceIdentity(db, { clock: () => 1234 });
  assert.match(identity.instanceId, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.deepEqual(getInstanceIdentity(db), identity);
  assert.equal(assertImSchema(db), true);
  assert.equal(assertInstanceIdentity(db), true);
  assert.throws(() => initInstanceIdentity(db, { clock: () => 999 }), { code: 'IM_IDENTITY_EXISTS' });
  db.close(); db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
  assert.deepEqual(getInstanceIdentity(db), identity);
  db.exec('DELETE FROM im_instance_identity');
  assert.equal(assertImSchema(db), true);
  assert.throws(() => assertInstanceIdentity(db), { code: 'IM_IDENTITY_MISSING' });
  db.exec('PRAGMA ignore_check_constraints=ON');
  db.prepare('INSERT INTO im_instance_identity VALUES (1,?,?)').run(identity.instanceId, 1234);
  db.prepare('INSERT INTO im_instance_identity VALUES (2,?,?)').run(identity.instanceId, 1234);
  db.exec('PRAGMA ignore_check_constraints=OFF');
  assert.throws(() => assertInstanceIdentity(db), { code: 'IM_SCHEMA_MISMATCH' });
  db.exec('DELETE FROM im_instance_identity');
  db.exec('PRAGMA ignore_check_constraints=ON; UPDATE im_schema SET version=99; PRAGMA ignore_check_constraints=OFF');
  assert.throws(() => assertImSchema(db), { code: 'IM_SCHEMA_MISMATCH' });
});

test('identity assertion rejects corrupted identity values and schema despite permissive bootstrap', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  migrateImSchema(db);
  db.exec('PRAGMA ignore_check_constraints=ON');
  db.exec("INSERT INTO im_instance_identity VALUES (1,'not-a-uuid',123)");
  db.exec('PRAGMA ignore_check_constraints=OFF');
  assert.throws(() => assertInstanceIdentity(db), { code: 'IM_SCHEMA_MISMATCH' });
  db.exec('DELETE FROM im_instance_identity; DROP INDEX im_messages_conversation');
  assert.throws(() => assertImSchema(db), { code: 'IM_SCHEMA_MISMATCH' });
});

test('v2 identity DDL rejects extra hyphens and initialization rejects unexpected inputs', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  migrateImSchema(db);
  const bad = '0000000--0000-4000-8000-000000000001';
  assert.equal(bad.length, 36);
  assert.throws(() => db.prepare('INSERT INTO im_instance_identity VALUES (1,?,1)').run(bad), /CHECK constraint failed/);
  assert.throws(() => initInstanceIdentity(db, { instanceId: '00000000-0000-4000-8000-000000000001' }), { code: 'IM_IDENTITY_INPUT_INVALID' });
  assert.throws(() => initInstanceIdentity(db, { clock: () => 1, unexpected: true }), { code: 'IM_IDENTITY_INPUT_INVALID' });
  assert.equal(db.prepare('SELECT count(*) n FROM im_instance_identity').get().n, 0);
  const identity = initInstanceIdentity(db, { clock: () => 1 });
  assert.deepEqual(getInstanceIdentity(db), identity);
});

test('legacy v1 backup remains verifiable with its own marker and manifest', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-v1-backup-'));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('PRAGMA foreign_keys=ON');
  v1(db);
  const runner = createImBackup({ db, authority: { authorizeAdmin: () => true }, durability: process.platform === 'win32' ? 'best-effort' : 'strict' });
  const result = await runner.backup({ destinationPath: join(dir, 'snapshot.sqlite'), approvalId: 'test', sourceId: 'test' });
  assert.equal(result.manifest.schemaVersion, 1);
  assert.equal(runner.verify(result).ok, true);
});

test('initialized v2 backup verifies with matching schema marker', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-v2-backup-'));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('PRAGMA foreign_keys=ON');
  migrateImSchema(db);
  initInstanceIdentity(db);
  const runner = createImBackup({ db, authority: { authorizeAdmin: () => true }, durability: process.platform === 'win32' ? 'best-effort' : 'strict' });
  const result = await runner.backup({ destinationPath: join(dir, 'snapshot.sqlite'), approvalId: 'test', sourceId: 'test' });
  assert.equal(result.manifest.schemaVersion, 2);
  assert.equal(runner.verify(result).ok, true);
});

test('uninitialized v2 bootstrap backup verifies its structure without creating an identity', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-v2-bootstrap-backup-'));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('PRAGMA foreign_keys=ON');
  migrateImSchema(db);
  const runner = createImBackup({ db, authority: { authorizeAdmin: () => true }, durability: process.platform === 'win32' ? 'best-effort' : 'strict' });
  const result = await runner.backup({ destinationPath: join(dir, 'snapshot.sqlite'), approvalId: 'test', sourceId: 'test' });
  assert.equal(result.manifest.schemaVersion, 2);
  assert.equal(runner.verify(result).ok, true);
  assert.throws(() => assertInstanceIdentity(db), { code: 'IM_IDENTITY_MISSING' });
});

test('initialized and bootstrap v3 backups verify against v3 while retaining v2 backup compatibility', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-v3-backup-'));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('PRAGMA foreign_keys=ON');
  migrateImSchema(db);
  const runner = createImBackup({ db, authority: { authorizeAdmin: () => true }, durability: process.platform === 'win32' ? 'best-effort' : 'strict' });
  const old = await runner.backup({ destinationPath: join(dir, 'v2.sqlite'), approvalId: 'test', sourceId: 'test' });
  await runner.drain();
  migrateImSchemaV3(db);
  const bootstrap = await runner.backup({ destinationPath: join(dir, 'v3-bootstrap.sqlite'), approvalId: 'test', sourceId: 'test' });
  await runner.drain();
  assert.equal(bootstrap.manifest.schemaVersion, 3);
  assert.equal(runner.verify(bootstrap).ok, true);
  assert.equal(runner.verify(old).schemaVersion, 2);
  assert.throws(() => getInstanceIdentity(db), { code: 'IM_IDENTITY_MISSING' });
  initInstanceIdentity(db);
  const initialized = await runner.backup({ destinationPath: join(dir, 'v3-initialized.sqlite'), approvalId: 'test', sourceId: 'test' });
  assert.equal(runner.verify(initialized).schemaVersion, 3);
  assert.equal(runner.verify({ backupPath: bootstrap.backupPath, manifestPath: old.manifestPath }).ok, false);
});
