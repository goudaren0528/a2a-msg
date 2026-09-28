import { runChild, successful } from './process.js';
const lifecycle = await runChild('./probe.js', [process.argv[2]], 10000);
const result = successful(lifecycle);
process.stdout.write(JSON.stringify({ ...result, lifecycle }));
