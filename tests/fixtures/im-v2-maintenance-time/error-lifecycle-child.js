import { installObserver } from './observer.js';
import { runErrorLifecycle } from './error-lifecycle.js';
const observer = installObserver();
console.log(JSON.stringify({ phase: 'ready', pid: process.pid, scenario: process.argv[2] }));
try {
  const api = await import('../../../src/im/v2/maintenance-time-internal.js');
  runErrorLifecycle(process.argv[2], api, observer);
  console.log(JSON.stringify({ phase: 'complete', scenario: process.argv[2] }));
} catch (error) {
  // No blind resource/directory cleanup: the scenario retains an unconfirmed
  // handle's fixture and reports its own test-owned cleanup distinctly.
  console.error(error); process.exitCode = 1;
}
