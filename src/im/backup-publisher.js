import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { withClosedBackupSnapshot } from './backup-snapshot.js';
import { getInstanceIdentity, IM_SCHEMA_VERSION } from './schema.js';

const fail = code => Object.assign(new Error(code), { code });
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

// Called only by the trusted services factory; neither writer nor directory reaches its facade.
export function createBackupPublisher({ db, registry, writer, artifactDirectory, backup, authority } = {}) {
  async function publish({ adminContext, approvalId, instanceId: _ignoredInstanceId, sourceId: _ignoredSourceId } = {}) {
    let allowed = false;
    try { allowed = authority?.authorizeAdmin(adminContext) === true; } catch { /* deny */ }
    if (!allowed) throw fail('BACKUP_AUTH_DENIED');

    // Actor identity is supplied by the trusted authorization adapter, never by operation input.
    let actors;
    try { actors = authority.publicationActors(adminContext); } catch { throw fail('BACKUP_AUTH_DENIED'); }
    if (!actors || typeof actors.then === 'function' || !text(actors.executorActorId) ||
        !text(actors.backupApproverId)) throw fail('BACKUP_AUTH_DENIED');
    if (!text(approvalId) || !db || !registry || !writer || !backup) throw fail('BACKUP_PUBLISH_INVALID');

    let identity;
    try { identity = getInstanceIdentity(db); } catch { throw fail('BACKUP_IDENTITY_MISMATCH'); }
    const location = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
    if (!location || !isAbsolute(location)) throw fail('BACKUP_PUBLISH_INVALID');
    let registered;
    try { registered = registry.getInstance(); }
    catch (error) {
      if (error?.code !== 'REGISTRY_INSTANCE_NOT_FOUND') throw error;
      registered = writer.registerInstance({ instanceId: identity.instanceId, instanceCreatedAt: identity.createdAt, dbLocation: location, adminContext });
    }
    if (registered?.instanceId !== identity.instanceId || registered?.instanceCreatedAt !== identity.createdAt || registered?.registrationGeneration !== 1)
      throw fail('BACKUP_IDENTITY_MISMATCH');

    const directory = artifactDirectory;
    if (typeof directory !== 'string' || !isAbsolute(directory) || basename(directory) !== 'artifacts')
      throw fail('BACKUP_PUBLISH_INVALID');
    const name = `${randomUUID()}.sqlite`;
    const destinationPath = join(resolve(directory), name);
    const result = await backup.backup({ destinationPath, approvalId, sourceId: identity.instanceId, adminContext });
    if (result?.durability !== 'durable') throw fail('BACKUP_DURABILITY_DEGRADED');
    if (result.backupPath !== destinationPath || result.manifestPath !== `${destinationPath}.manifest.json`)
      throw fail('BACKUP_PUBLISH_INVALID');

    // Check real SQLite content before interpreting the snapshot identity; schema identity
    // checks also reject foreign-key corruption, but cannot replace this explicit verifier.
    if (backup.verify({ backupPath: destinationPath, manifestPath: result.manifestPath })?.ok !== true)
      throw fail('BACKUP_VERIFY_FAILED');
    // Open the produced copy, not the current DB and not the caller's manifest assertion.
    try {
      withClosedBackupSnapshot(destinationPath, copy => {
        const copied = getInstanceIdentity(copy);
        if (copied.instanceId !== identity.instanceId || copied.instanceId !== registered.instanceId ||
            copied.createdAt !== identity.createdAt) throw fail('BACKUP_IDENTITY_MISMATCH');
      });
    } catch { throw fail('BACKUP_IDENTITY_MISMATCH'); }

    let manifest;
    try { manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')); }
    catch { throw fail('BACKUP_VERIFY_FAILED'); }
    if (manifest.sourceId !== identity.instanceId || manifest.approvalId !== approvalId ||
        manifest.fileHash !== hash(destinationPath) || manifest.schemaVersion !== IM_SCHEMA_VERSION ||
        manifest.backupId !== result.manifest?.backupId || manifest.fileHash !== result.manifest?.fileHash)
      throw fail('BACKUP_VERIFY_FAILED');
    // The source identity may have changed while the asynchronous native backup ran.
    let current;
    try { current = getInstanceIdentity(db); } catch { throw fail('BACKUP_IDENTITY_MISMATCH'); }
    if (current.instanceId !== identity.instanceId || current.createdAt !== identity.createdAt)
      throw fail('BACKUP_IDENTITY_MISMATCH');
    const stillRegistered = registry.getInstance();
    if (stillRegistered.instanceId !== identity.instanceId || stillRegistered.instanceCreatedAt !== identity.createdAt ||
        stillRegistered.registrationGeneration !== registered.registrationGeneration)
      throw fail('BACKUP_IDENTITY_MISMATCH');
    const artifactReference = `artifacts/${name}`;
    const publication = writer.registerPublishedBackup({ instanceId: identity.instanceId, instanceCreatedAt: identity.createdAt,
      registrationGeneration: registered.registrationGeneration, backupId: manifest.backupId,
      fileHash: manifest.fileHash, schemaVersion: manifest.schemaVersion, schemaChecksum: manifest.schemaChecksum,
      completedAt: manifest.completedAt, executorActorId: actors.executorActorId,
      backupApprovalId: approvalId, backupApproverId: actors.backupApproverId,
      toolVersion: manifest.toolVersion, artifactReference, manifestHash: hash(result.manifestPath), adminContext });
    if (publication?.publicationState !== 'published' || publication?.durability !== 'durable')
      throw fail('BACKUP_PUBLISH_INVALID');
    return { backupId: manifest.backupId, artifactReference, manifest,
      publicationState: 'published', provenance: 'registry-recorded' };
  }
  return Object.freeze({ publish });
}
