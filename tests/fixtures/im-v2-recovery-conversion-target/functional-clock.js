// Imported first by the dedicated bridge TEST module, never by production or
// unrelated regression suites. node --test isolates this module in its child.
const nativeNow = Date.now;
const supplied = 1800000000000;
const installed = process.platform !== 'win32';
if (installed) {
  if (!process.env.NODE_TEST_CONTEXT) throw Error('functional test clock requires isolated node:test child');
  Date.now = () => supplied;
  process.once('exit', () => { Date.now = nativeNow; });
}
export function functionalWall() {
  return { installed, domain: installed ? supplied : null, actualNativeWall: nativeNow(),
    pid: process.pid, testContext: process.env.NODE_TEST_CONTEXT ?? null,
    scope: 'dedicated bridge test child only; fresh-clock children have independent domains' };
}
