import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createImBackup } from '../src/im/backup.js';
import { createBackupRegistry, withProtectedBackupCopy } from '../src/im/backup-registry.js';
import { IM_SCHEMA_VERSION, SUPPORTED_IM_SCHEMA_VERSIONS } from '../src/im/schema.js';
import { sourceFixture, nativeFixture, primitiveFixture, registeredFixture, observeClosedSnapshot,
  assertSource, checksums, sha, noSidecars, sidecars, sideSuffixes, preserved, authority, context } from './fixtures/im-backup-snapshot/helpers.js';

const rejected = { ok: false, code: 'BACKUP_VERIFY_FAILED' };
const nativeOnly = process.platform === 'win32' ? 'strict protected registry requires native Unix' : false;

test('fixture proof: frozen v1/v2/v3 DDL and real native DELETE/WAL snapshots contain the post-mode committed business fact',
  { timeout: 20000 }, async t => {
    assert.equal(IM_SCHEMA_VERSION, 3);
    assert.deepEqual(SUPPORTED_IM_SCHEMA_VERSIONS, [1, 2, 3]);
    for (const version of [1, 2, 3]) for (const mode of ['DELETE', 'WAL']) {
      const f = sourceFixture(t, version, mode), path = await nativeFixture(f);
      const before = readFileSync(path);
      assert.deepEqual([...before.subarray(18, 20)], mode === 'WAL' ? [2, 2] : [1, 1]);
      noSidecars(path);
      observeClosedSnapshot(f, path);
      preserved(path, before); noSidecars(path); assertSource(f);
      t.diagnostic(`valid native fixture v${version} ${mode}: pinned schema, committed agent, standalone header verified`);
    }
  });

for (const version of [1, 2, 3]) for (const mode of ['DELETE', 'WAL']) {
  test(`old primitive v${version} ${mode}: repeated verification preserves main/manifest/header and creates no sidecars`,
    { timeout: 10000 }, async t => {
      const f = sourceFixture(t, version, mode), result = await primitiveFixture(f);
      const before = readFileSync(result.backupPath), manifest = readFileSync(result.manifestPath);
      assert.equal(result.manifest.schemaVersion, version);
      assert.equal(result.manifest.schemaChecksum, checksums[version]);
      assert.equal(result.manifest.fileHash, sha(before));
      assert.deepEqual([...before.subarray(18, 20)], mode === 'WAL' ? [2, 2] : [1, 1]);
      noSidecars(result.backupPath);
      observeClosedSnapshot(f, result.backupPath);
      for (let n = 0; n < 3; n++) {
        assert.deepEqual(createImBackup({}).verify(result), { ok: true, code: 'BACKUP_VERIFIED',
          backupId: result.manifest.backupId, schemaVersion: version, fileHash: sha(before) });
        preserved(result.backupPath, before, result.manifestPath, manifest);
        noSidecars(result.backupPath); assertSource(f);
      }
    });
}

for (const version of [1, 2, 3]) for (const suffix of sideSuffixes) {
  test(`old primitive v${version}: preexisting empty ${suffix} refuses without altering any evidence`, { timeout: 10000 }, async t => {
    const f = sourceFixture(t, version, 'WAL'), result = await primitiveFixture(f);
    noSidecars(result.backupPath);
    writeFileSync(`${result.backupPath}${suffix}`, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
    const before = readFileSync(result.backupPath), manifest = readFileSync(result.manifestPath), sideBefore = sidecars(result.backupPath);
    const verdict = createImBackup({}).verify(result);
    preserved(result.backupPath, before, result.manifestPath, manifest);
    assert.deepEqual(sidecars(result.backupPath), sideBefore, 'refusal preserves even empty sidecars and creates no others');
    assert.deepEqual(verdict, rejected); assertSource(f);
  });
}

for (const version of [1, 2, 3]) {
  test(`old primitive v${version}: owned live artifact writer has committed WAL absent from unchanged main; verification refuses`,
    { timeout: 10000 }, async t => {
      const f = sourceFixture(t, version, 'WAL'), result = await primitiveFixture(f);
      noSidecars(result.backupPath);
      const before = readFileSync(result.backupPath), manifest = readFileSync(result.manifestPath);
      // This deliberately ceases to be a closed standalone snapshot. Keep the
      // owned writer alive until AFTER all refusal/preservation assertions.
      const writer = new DatabaseSync(result.backupPath); f.connections.push(writer);
      writer.exec('PRAGMA wal_autocheckpoint=0');
      writer.prepare('UPDATE im_agents SET display_name=? WHERE agent_id=?').run('synthetic committed artifact WAL', f.agentId);
      assert.ok(lstatSync(`${result.backupPath}-wal`).size > 0);
      assert.equal(writer.prepare('SELECT display_name FROM im_agents WHERE agent_id=?').get(f.agentId).display_name,
        'synthetic committed artifact WAL');
      preserved(result.backupPath, before, result.manifestPath, manifest);
      const sideBefore = sidecars(result.backupPath);
      const verdict = createImBackup({}).verify(result);
      preserved(result.backupPath, before, result.manifestPath, manifest);
      assert.deepEqual(sidecars(result.backupPath), sideBefore, 'refusal neither checkpoints nor edits/removes live sidecars');
      assert.deepEqual(verdict, rejected); assertSource(f);
    });
}

test('old genuine v3 WAL publisher and each registry artifact-reading scope leave no sidecars or changed bytes',
  { skip: nativeOnly, timeout: 15000 }, async t => {
    const f = sourceFixture(t, 3, 'WAL'), r = await registeredFixture(f);
    const before = readFileSync(r.path), manifest = readFileSync(r.manifestPath);
    assert.deepEqual([...before.subarray(18, 20)], [2, 2]);
    assert.equal(r.output.manifest.fileHash, sha(before));
    const unchanged = () => { preserved(r.path, before, r.manifestPath, manifest); noSidecars(r.path); assertSource(f); };
    unchanged(); // Includes publisher's verify, copied identity and private registration reads.
    observeClosedSnapshot(f, r.path);
    for (let n = 0; n < 2; n++) {
      const registry = createBackupRegistry({ dir: r.dir, authority });
      assert.equal(registry.resolveForMigration({ backupId: r.output.backupId, expected: r.expected }).fileHash, sha(before));
      unchanged();
      registry.withVerifiedBackup({ backupId: r.output.backupId, expected: r.expected }, proof => {
        assert.equal(proof.recheck().fileHash, sha(before));
      });
      unchanged();
      registry.withDiscoveredBackup({ backupId: r.output.backupId, expectedIdentity: registry.getInstance() }, proof => {
        assert.equal(proof.recheck().fileHash, sha(before));
      });
      unchanged();
      withProtectedBackupCopy(registry, { backupId: r.output.backupId, adminContext: context }, proof => {
        const chunks = []; proof.copyTo(chunk => chunks.push(Buffer.from(chunk)));
        assert.ok(Buffer.concat(chunks).equals(before));
        assert.ok(proof.manifestBytes.equals(manifest));
      });
      unchanged();
    }
  });

for (const suffix of sideSuffixes) {
  test(`old authentic registered DELETE snapshot with empty ${suffix}: reader/copy refuse and retain evidence`,
    { skip: nativeOnly, timeout: 10000 }, async t => {
      const f = sourceFixture(t, 3, 'DELETE'), r = await registeredFixture(f);
      noSidecars(r.path);
      writeFileSync(`${r.path}${suffix}`, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
      const before = readFileSync(r.path), manifest = readFileSync(r.manifestPath), sideBefore = sidecars(r.path);
      let callbacks = 0;
      const operations = [
        () => r.registry.withVerifiedBackup({ backupId: r.output.backupId, expected: r.expected }, () => { callbacks++; }),
        () => withProtectedBackupCopy(r.registry, { backupId: r.output.backupId, adminContext: context }, () => { callbacks++; }),
      ];
      for (const operation of operations) {
        let error; try { operation(); } catch (caught) { error = caught; }
        preserved(r.path, before, r.manifestPath, manifest);
        assert.deepEqual(sidecars(r.path), sideBefore);
        assert.ok(error, 'registered reader refuses preexisting sidecar');
        assert.equal(callbacks, 0);
      }
    });
}
