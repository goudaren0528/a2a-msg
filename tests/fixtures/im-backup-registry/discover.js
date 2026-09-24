import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createTrustedBackupServices, createBackupRegistry } from '../../../src/im/backup-registry.js';
import { getInstanceIdentity } from '../../../src/im/schema.js';

const [mode, root, dir, backupId] = process.argv.slice(2);
let db;
try {
  db = new DatabaseSync(join(root, 'source.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  if (mode === 'publish') {
    const authority = { authorizeAdmin: () => true,
      publicationActors: () => ({ executorActorId: 'executor', backupApproverId: 'backup-reviewer' }) };
    const { publisher } = createTrustedBackupServices({ db, dir, authority });
    const result = await publisher.publish({ adminContext: {}, approvalId: 'publication-only' });
    process.send({ backupId: result.backupId, fileHash: result.manifest.fileHash,
      artifactReference: result.artifactReference });
  } else if (mode === 'discover') {
    const live = getInstanceIdentity(db);
    const registry = createBackupRegistry({ dir });
    const proof = registry.withDiscoveredBackup({ backupId, expectedIdentity: {
      instanceId: live.instanceId, instanceCreatedAt: live.createdAt, registrationGeneration: 1 } },
    evidence => ({ backupId: evidence.backupId, fileHash: evidence.fileHash,
      manifestHash: evidence.manifestHash, schemaVersion: evidence.schemaVersion,
      schemaChecksum: evidence.schemaChecksum }));
    process.send(proof);
  } else throw Error('unknown worker mode');
} catch (error) {
  process.send({ error: error?.code ?? String(error) });
  process.exitCode = 1;
} finally { db?.close(); }
