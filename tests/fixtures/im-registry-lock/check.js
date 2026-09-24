import { createBackupRegistry } from '../../../src/im/backup-registry.js';

try {
  const [dir, backupId, expected] = process.argv.slice(2);
  const result = createBackupRegistry({ dir }).withVerifiedBackup({ backupId, expected: JSON.parse(expected) }, proof => proof.backupId);
  process.send?.(result);
} catch (error) { process.send?.(error.code ?? 'unknown'); }
