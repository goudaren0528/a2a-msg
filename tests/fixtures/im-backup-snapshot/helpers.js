import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { V1_DDL, V1_CHECKSUM } from '../im-schema/v1.js';
import { V2_DDL, V2_CHECKSUM } from '../im-schema/v2.js';
import { assertImSchema, getInstanceIdentity } from '../../../src/im/schema.js';
import { createImBackup } from '../../../src/im/backup.js';
import { createTrustedBackupServices } from '../../../src/im/backup-registry.js';

// Frozen historical evidence, independent of runtime migration/schema builders.
const v3 = JSON.parse(readFileSync(new URL('../im-v2-schema/v3-manifest.json', import.meta.url), 'utf8'));
export const checksums = Object.freeze({ 1: V1_CHECKSUM, 2: V2_CHECKSUM,
  3: '523f5b8448226076dc78f32096888871d899150d4cb70d6728490aee033f9814' });
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const context = Object.freeze({ actor: 'synthetic-snapshot-executor' });
export const authority = Object.freeze({ authorizeAdmin: value => value === context,
  publicationActors: () => ({ executorActorId: 'synthetic-snapshot-executor', backupApproverId: 'synthetic-snapshot-approver' }) });
export const sideSuffixes = ['-wal', '-shm', '-journal'];

export function sidecars(path) {
  return Object.fromEntries(sideSuffixes.map(suffix => {
    try { return [suffix, readFileSync(`${path}${suffix}`)]; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return [suffix, null]; }
  }));
}
export function noSidecars(path) {
  assert.deepEqual(sidecars(path), { '-wal': null, '-shm': null, '-journal': null }, 'closed snapshot must not acquire SQLite sidecars');
}
export function preserved(path, before, manifestPath, manifestBefore) {
  const actual = readFileSync(path);
  assert.ok(actual.equals(before), 'published main bytes unchanged');
  assert.equal(sha(actual), sha(before));
  assert.deepEqual([...actual.subarray(18, 20)], [...before.subarray(18, 20)], 'disk journal header unchanged');
  if (manifestPath) assert.ok(readFileSync(manifestPath).equals(manifestBefore), 'manifest bytes unchanged');
}

export function sourceFixture(t, version, mode) {
  const root = mkdtempSync(join(tmpdir(), 'im-old-snapshot-'));
  const directory = join(root, '快照 space #percent%'); mkdirSync(directory, { mode: 0o700 });
  const sourcePath = join(directory, 'live source.sqlite');
  const db = new DatabaseSync(sourcePath); chmodSync(sourcePath, 0o600);
  const connections = [db];
  let runner;
  t.after(async () => {
    await runner?.drain();
    for (const connection of connections.reverse()) connection.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec('PRAGMA foreign_keys=ON');
  const ddl = version === 1 ? V1_DDL : version === 2 ? V2_DDL :
    [...v3.filter(row => row[0] === 'table'), ...v3.filter(row => row[0] === 'index')].map(row => row[3]);
  for (const sql of ddl) db.exec(sql);
  db.prepare('INSERT INTO im_schema(version,migration_checksum) VALUES (?,?)').run(version, checksums[version]);
  db.exec("INSERT INTO im_settings VALUES (1,'paused'); INSERT INTO im_clock VALUES (1,0)");
  if (version >= 2) db.prepare('INSERT INTO im_instance_identity(singleton,instance_id,created_at) VALUES (1,?,10)').run(randomUUID());
  assert.equal(assertImSchema(db), true);
  assert.equal(db.prepare(`PRAGMA journal_mode=${mode}`).get().journal_mode, mode.toLowerCase());
  if (mode === 'WAL') db.exec('PRAGMA wal_autocheckpoint=0');
  const agentId = randomUUID(), displayName = `${mode} committed business agent v${version}`;
  db.exec('BEGIN IMMEDIATE');
  db.prepare("INSERT INTO im_agents(agent_id,display_name,status,created_at) VALUES (?,?,'active',11)").run(agentId, displayName);
  db.exec('COMMIT');
  if (mode === 'WAL') assert.ok(lstatSync(`${sourcePath}-wal`).size > 0, 'business commit is in the live source WAL');
  runner = createImBackup({ db, authority, durability: process.platform === 'win32' ? 'best-effort' : 'strict' });
  return { root, directory, sourcePath, db, connections, version, mode, agentId, displayName, runner };
}

export function assertSource(f) {
  assert.equal(f.db.prepare('PRAGMA journal_mode').get().journal_mode, f.mode.toLowerCase());
  assert.equal(f.db.prepare('SELECT display_name FROM im_agents WHERE agent_id=?').get(f.agentId).display_name, f.displayName);
  assert.deepEqual({ ...f.db.prepare('SELECT version,migration_checksum FROM im_schema').get() },
    { version: f.version, migration_checksum: checksums[f.version] });
  if (f.mode === 'WAL') assert.ok(lstatSync(`${f.sourcePath}-wal`).size > 0);
}

// Copy ONLY a closed, native-created standalone snapshot. Ordinary SQLite
// observation may create sidecars here, never at the protected artifact path.
export function observeClosedSnapshot(f, path) {
  const observation = join(f.directory, `observation-${randomUUID()}.sqlite`);
  copyFileSync(path, observation); chmodSync(observation, 0o600);
  const db = new DatabaseSync(observation, { readOnly: true });
  try {
    db.exec('PRAGMA foreign_keys=ON');
    assert.equal(assertImSchema(db), true);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual({ ...db.prepare('SELECT version,migration_checksum FROM im_schema').get() },
      { version: f.version, migration_checksum: checksums[f.version] });
    assert.equal(db.prepare('SELECT display_name FROM im_agents WHERE agent_id=?').get(f.agentId).display_name, f.displayName);
  } finally { db.close(); }
}

export async function nativeFixture(f) {
  const path = join(f.directory, `native-${randomUUID()}.sqlite`);
  await sqliteBackup(f.db, path); chmodSync(path, 0o600);
  return path;
}

export async function primitiveFixture(f) {
  const destinationPath = join(f.directory, `published-${randomUUID()}.sqlite`);
  try {
    return await f.runner.backup({ destinationPath, sourceId: 'synthetic-historical-source',
      approvalId: 'synthetic-approved', adminContext: context });
  } finally { await f.runner.drain(); }
}

export async function registeredFixture(f) {
  assert.equal(f.version, 3, 'only the current v3 publisher is exercised');
  const dir = join(f.directory, 'registry'); mkdirSync(dir, { mode: 0o700 });
  mkdirSync(join(dir, 'artifacts'), { mode: 0o700 });
  const services = createTrustedBackupServices({ db: f.db, dir, authority });
  const output = await services.publisher.publish({ adminContext: context, approvalId: 'synthetic-approved' });
  const path = join(dir, output.artifactReference), manifestPath = `${path}.manifest.json`;
  const expected = { ...getInstanceIdentity(f.db), registrationGeneration: 1,
    fileHash: output.manifest.fileHash, manifestHash: sha(readFileSync(manifestPath)),
    schemaVersion: 3, schemaChecksum: checksums[3] };
  expected.instanceCreatedAt = expected.createdAt; delete expected.createdAt;
  return { ...services, dir, output, path, manifestPath, expected };
}
