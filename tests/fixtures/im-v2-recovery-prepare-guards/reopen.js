// Child-only exact completed retry. No service discovery or real authority.
import { createImV2RecoveryServices } from '../../../src/im/v2/recovery.js';
import { policy } from '../im-v2-schema/helpers.js';

const input = JSON.parse(process.argv[2]);
const api = createImV2RecoveryServices({ root: input.root, sourceCatalog: {}, policy: policy(),
  authority: { authorizeAdmin: () => true },
  approvalAuthority: { authorizeApproval() { throw new Error('completed retry must not authorize mutation'); } },
  evidenceAuthority: {}, clock: () => input.now });
process.stdout.write(JSON.stringify(api.prepareRecovery(input.request, {})));
