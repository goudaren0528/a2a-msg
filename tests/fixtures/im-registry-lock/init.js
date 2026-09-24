import { createBackupRegistry } from '../../../src/im/backup-registry.js';

process.send?.('ready-to-start');
process.once('message', message => {
  if (message !== 'go') { process.send?.('unexpected-start-command'); return; }
  try {
    createBackupRegistry({ dir: process.argv[2] });
    process.send?.('ready');
  } catch (error) { process.send?.(error.code ?? 'unknown'); }
});
