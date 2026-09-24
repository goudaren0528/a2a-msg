import { createBackupRegistry } from '../../../src/im/backup-registry.js';

const [dir, backupId, expected] = process.argv.slice(2);
const registry = createBackupRegistry({ dir });
registry.withVerifiedBackup({ backupId, expected: JSON.parse(expected) }, () => {
  // Construct AND invoke a second facade in this same holder process. Its
  // validation must not open/close the coordination inode and drop our lock.
  try {
    createBackupRegistry({ dir }).getInstance();
    process.send?.('secondary-acquired');
    throw Error('second facade acquired holder lock');
  } catch (error) {
    if (error.code !== 'REGISTRY_BUSY') throw error;
  }
  process.send?.('locked');
  // IPC barrier: parent kills this holder; OS releases SQLite locks upon death.
  const shared = new Int32Array(new SharedArrayBuffer(4));
  while (Atomics.load(shared, 0) === 0) Atomics.wait(shared, 0, 0, 100);
});
