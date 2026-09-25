import { join } from 'node:path';
import { setup as activationSetup, context } from '../im-v2-recovery-activate/helpers.js';
export { context, tree, query, snapshot } from '../im-v2-recovery-activate/helpers.js';
export async function setup(t, route = 'snapshot', activate = true, configureSource) {
  const s = await activationSetup(t, route, configureSource);
  const prior = s.options.approvalAuthority.authorizeApproval;
  s.state.release = true;
  s.options.approvalAuthority.authorizeApproval = (input, ctx) => input.kind === 'release-hold'
    ? ctx === context && s.state.release && input.approvalRef === 'release-ok' : prior(input, ctx);
  if (activate) {
    const seal = s.api.verifyRecovery(s.verifyInput, context);
    const plan = s.api.previewActivation(s.previewInput(seal), context);
    s.activationInput = s.activateInput(seal, plan);
    s.active = s.api.activateRecovery(s.activationInput, context);
  }
  s.status = () => s.api.getRecoveryStatus({ runId: s.staged.runId }, context);
  s.releaseInput = () => ({ runId: s.staged.runId, holdId: s.staged.holdId,
    releasePlanHash: s.status().releasePlanHash, approvalRef: 'release-ok' });
  s.completion = join(s.dir, 'activation-complete.json');
  s.marker = s.staged.holdId && join(s.f.registryRoot, 'registry/releases', `${s.staged.holdId}.json`);
  s.locks = [join(s.f.registryRoot, 'coordination.sqlite'), join(s.root, 'requests/coordination.sqlite'), join(s.dir, 'coordination.sqlite')];
  return s;
}
