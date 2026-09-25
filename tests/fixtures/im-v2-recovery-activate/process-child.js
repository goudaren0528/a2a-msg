import { DatabaseSync } from 'node:sqlite';
import { createImV2BackupRegistry } from '../../../src/im/v2/backup-registry.js';
import { createImV2RecoveryServices } from '../../../src/im/v2/recovery.js';
import { context, authority } from '../im-v2-backup/helpers.js';
import { policy } from '../im-v2-schema/helpers.js';
let held, api;
process.on('message', input => {
  try {
    if (input.mode === 'hold') {
      held = new DatabaseSync(input.path); held.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      process.send({ phase: 'held', pid: process.pid });
    } else if (input.mode === 'release') {
      held.exec('ROLLBACK'); held.close(); held = null;
      process.send({ phase: 'released' }); process.disconnect();
    } else if (input.mode === 'compose') {
      const registry = input.registryRoot && createImV2BackupRegistry({ root: input.registryRoot, authority });
      const sourceCatalog = registry ? { source: { kind: 'registered-backup', registry, backupId: input.backupId } } : {};
      api = createImV2RecoveryServices({ root: input.root, sourceCatalog, authority, policy: policy(), clock: () => input.now,
        evidenceAuthority: { assertSourceIsolation: () => true, authorizeSourceClosedEvidence: () => true } });
      process.send({ phase: 'composed' });
    } else {
      let code;
      try {
        if (input.mode === 'activate') api.activateRecovery(input.activateInput, context);
        else api.verifyRecovery(input.verifyInput, context);
        code = 'SUCCESS';
      } catch (error) { code = error.code; }
      process.send({ phase: 'complete', code }); process.disconnect();
    }
  } catch (error) { process.exitCode = 1; process.send({ phase: 'failure', code: error.code }); process.disconnect(); }
});
process.send({ phase: 'ready', pid: process.pid });
