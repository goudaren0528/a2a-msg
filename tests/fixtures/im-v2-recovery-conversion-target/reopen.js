import { createRecoveryConversionTarget } from '../../../src/im/v2/recovery.js';
import { withRecoveryConversionScope } from '../../../src/im/v2/recovery-conversion-target.js';
import { openWorkspace, context } from './helpers.js';

const [root, runId] = process.argv.slice(2);
const api = openWorkspace(root).open();
const target = createRecoveryConversionTarget(api, { runId }, context);
const result = withRecoveryConversionScope(target, context, session => {
  session.claimConversion({}); return session.ensurePaused({});
});
process.stdout.write(JSON.stringify(result));
