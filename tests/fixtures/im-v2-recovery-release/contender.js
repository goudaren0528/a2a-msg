import fs from 'node:fs';
import { lock } from '../../../src/im/v2/recovery-candidate.js';
const [request, response] = process.argv.slice(2);
let sequence = 0;
const timer = setInterval(() => {
  if (!fs.existsSync(request)) return;
  let message;
  try { message = JSON.parse(fs.readFileSync(request)); } catch { return; }
  if (message.sequence === sequence) return;
  sequence = message.sequence;
  let code = 'entered';
  try { lock(message.directory, false, () => {}); } catch (error) { code = error.code; }
  fs.writeFileSync(response, JSON.stringify({ sequence, code }), { mode: 0o600 });
}, 2);
process.on('message', message => { if (message.mode === 'stop') { clearInterval(timer); process.disconnect(); } });
process.send({ phase: 'ready' });
