import { installObserver } from './observer.js';
import { runScenario } from './scenarios.js';

const observer = installObserver();
console.log(JSON.stringify({ phase: 'ready', pid: process.pid, scenario: process.argv[2] }));
try {
  // Deliberately dynamic: sampling/native wrappers are child-local and installed
  // before the first evaluation of either isolated time-engine module.
  const api = await import('../../../src/im/v2/maintenance-time-internal.js');
  await runScenario(process.argv[2], api, observer);
  console.log(JSON.stringify({ phase: 'complete', scenario: process.argv[2] }));
} catch (error) {
  observer.cleanup(); console.error(error); process.exitCode = 1;
}
