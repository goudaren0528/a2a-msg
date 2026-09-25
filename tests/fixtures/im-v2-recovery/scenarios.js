// Finite P5-D inventory. K is SIGKILL inside a facade; P is a normal-exit
// independent-process lineage. Neither exceptions nor facade reopen count as K.
const cases = [];
function add(id, route, phase, operation, recovery, extra = {}) {
  cases.push(Object.freeze({ id, route, phase, operation, recovery, death: 'K', ...extra }));
}
for (const [prefix, route] of [['A1', 'registered-v3'], ['A2', 'snapshot']]) {
  for (const [index, phase] of ['artifact', 'manifest', 'registry-record'].entries())
    add(`${prefix}${index + 1}`, route, phase, 'publish', phase === 'registry-record' ? 'verify-publication' : 'refuse-publication');
}
for (const [index, phase] of ['locator', 'source-closure', 'stage', 'stage-hold', 'source-verified', 'copy-intent',
  'candidate-publication', 'base', 'normalization-intent', 'normalized', 'staged', 'prepare-plan', 'prepare-binding'].entries()) {
  add(`B${String(index + 1).padStart(2, '0')}`, 'snapshot', phase,
    index === 12 ? 'prepare' : index === 11 ? 'preview' : 'stage',
    index === 12 ? 'prepare' : index === 11 ? 'preview' : 'stage', { contenders: phase === 'candidate-publication' });
}
for (const [index, [phase, operation, recovery]] of [
  ['prepare-commit', 'prepare', 'prepare'], ['verified-commit', 'verify', 'verify'],
  ['verified-close-sync', 'verify', 'verify'], ['seal', 'verify', 'verify'],
  ['activation-plan', 'activation-preview', 'activation-preview'], ['activation-anchor', 'activate', 'reverify'],
  ['active-commit', 'activate', 'activate'], ['active-close-sync', 'activate', 'activate'],
  ['completion', 'activate', 'activate'], ['release-marker', 'release', 'release'],
].entries()) add(`C${String(index + 1).padStart(2, '0')}`, 'snapshot', phase, operation, recovery,
  { contenders: phase === 'completion' });
add('D1', 'closed-v3', 'normalization-intent', 'stage', 'stage', { wal: true });
add('D2', 'closed-v3', 'normalization-close-sync', 'stage', 'refuse-stage', { wal: true });
add('D3', 'closed-v3', 'pause-commit', 'stage', 'refuse-stage', { enabled: true });
add('D4', 'registered-v3', 'p1-commit', 'stage', 'stage', { wal: true });
add('D5', 'fresh', 'p1-commit', 'stage', 'stage');
add('E1', 'snapshot', 'locator-two-links', 'stage', 'refuse-stage');
add('E2', 'registered-v3', 'candidate-partial-write', 'stage', 'refuse-stage', { wal: true });
add('E3', 'fresh', 'candidate-publication', 'stage', 'refuse-stage');
for (const [index, route] of ['fresh', 'registered-v3', 'closed-v3', 'snapshot'].entries())
  add(`F${index + 1}`, route, 'independent-lineage', 'lineage', 'lineage', { death: 'P', wal: route.includes('v3'), enabled: route.includes('v3') });
add('G1', 'snapshot', 'candidate-publication', 'stage', 'refuse-stage', { alias: 'symlink' });
add('G2', 'snapshot', 'candidate-publication', 'stage', 'refuse-stage', { alias: 'hardlink' });
export const scenarios = Object.freeze(cases);
export const operationOrder = Object.freeze(['stage', 'preview', 'prepare', 'verify', 'activation-preview', 'activate', 'release']);
export const expectedGroups = Object.freeze({ A: 6, B: 13, C: 10, D: 5, E: 3, F: 4, G: 2 });
export const baseHead = '4884b65c0f9848bf2024638295d3f69b4bcc33cf';
