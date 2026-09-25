import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createBackupRegistry } from '../../../src/im/backup-registry.js';
import { createTrustedImV2BackupServices } from '../../../src/im/v2/backup-registry.js';
import { authority, context } from './helpers.js';

process.once('message', ({ oldRoot, newRoot, backupId }) => {
  try {
    const old = createBackupRegistry({ dir: oldRoot, authority });
    const services = createTrustedImV2BackupServices({ root: newRoot, authority });
    let paused = false, targetIdentity, verifiedPaused = false;
    const original = fs.writeSync, originalRead = fs.readSync;
    fs.writeSync = (...args) => {
      const result = original(...args);
      if (!paused) {
        paused = true;
        targetIdentity = fs.fstatSync(args[0]);
        // Reopen both facades while their SQLite coordinators are held. Managed
        // probes must not drop POSIX locks by raw-closing the coordination inode.
        for (const operation of [
          () => createBackupRegistry({ dir: oldRoot, authority }).getInstance(),
          () => createTrustedImV2BackupServices({ root: newRoot, authority }).registry.verify({ backupId }, context),
        ]) {
          try { operation(); throw Error('unexpected coordinator acquisition'); }
          catch (e) { if (!['REGISTRY_BUSY', 'RECOVERY_BUSY'].includes(e.code)) throw e; }
        }
        process.send({ type: 'copy-held' });
        const signal = Buffer.alloc(1);
        if (fs.readSync(0, signal, 0, 1, null) !== 1 || signal[0] !== 1) throw Error('barrier not released');
      }
      return result;
    };
    fs.readSync = (...args) => {
      const result = originalRead(...args);
      if (targetIdentity && !verifiedPaused && result > 0) {
        const identity = fs.fstatSync(args[0]);
        if (identity.dev === targetIdentity.dev && identity.ino === targetIdentity.ino) {
          verifiedPaused = true;
          process.send({ type: 'target-verification-held' });
          const signal = Buffer.alloc(1);
          if (originalRead(0, signal, 0, 1, null) !== 1 || signal[0] !== 1) throw Error('verification barrier not released');
        }
      }
      return result;
    };
    syncBuiltinESMExports();
    let result;
    try { result = services.publisher.importRegisteredV3({ sourceRegistry: old, backupId }, context); }
    finally { fs.writeSync = original; fs.readSync = originalRead; syncBuiltinESMExports(); }
    if (!verifiedPaused) throw Error('no actual target verification read observed');
    process.send({ type: 'complete', record: result.record }, () => process.disconnect());
  } catch (e) {
    process.send({ type: 'failure', code: e.code ?? 'TEST_FAILURE' }, () => { process.exitCode = 1; process.disconnect(); });
  }
});
