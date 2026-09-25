// Child-only trusted test composition. No network or real workspace discovery.
import { createImV2RecoveryServices } from '../../../src/im/v2/recovery.js';
import { policy } from '../im-v2-schema/helpers.js';

const input = JSON.parse(process.argv[2]);
const api = createImV2RecoveryServices({ root: input.root, sourceCatalog: {}, policy: policy(),
  authority: { authorizeAdmin: () => true }, approvalAuthority: { authorizeApproval: () => false },
  evidenceAuthority: {}, clock: () => input.now });
const result = input.operation === 'stage' ? api.stageCandidate(input.request, {})
  : input.operation === 'prepare' ? api.prepareRecovery(input.request, {})
    : api.getRecoveryStatus(input.request, {});
process.stdout.write(JSON.stringify(result));
