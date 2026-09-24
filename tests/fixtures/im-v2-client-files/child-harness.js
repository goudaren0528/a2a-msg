import assert from 'node:assert/strict';
import { fork } from 'node:child_process';

// Only owned children are signalled. An error event never counts as exit/close.
export function createChildHarness(report = () => {}) {
  const children = new Set();
  const within = async (promise, milliseconds, label) => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  };
  async function stop(record) {
    if (record.confirmed) return;
    record.child.kill('SIGTERM');
    try { await within(record.finished, 1000, 'TERM deadline'); }
    catch {
      record.child.kill('SIGKILL');
      await within(record.finished, 5000, 'unconfirmed child termination; retain artifacts');
    }
  }
  return {
    async settle() {
      const settled = await Promise.allSettled([...children].map(stop));
      assert.equal(settled.every(r => r.status === 'fulfilled'), true,
        'unconfirmed owned child exit/close: artifacts must be retained');
    },
    async run(input, { crash = false, onPhase } = {}) {
      const child = fork(new URL('./fault-child.js', import.meta.url), [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [],
      });
      const record = { child, closed: false, confirmed: false };
      // Register both immediately, before input or phase messages can run.
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      const closed = new Promise(resolve => child.once('close', () => { record.closed = true; resolve(); }));
      record.finished = Promise.all([exited, closed]).then(result => {
        record.confirmed = true;
        return result;
      });
      children.add(record);
      let output = '', result, phaseError;
      const phases = [];
      child.stdout.on('data', data => { output = (output + data).slice(-16384); });
      child.stderr.on('data', data => { output = (output + data).slice(-16384); });
      const failed = new Promise((_, reject) => child.on('error', reject));
      child.on('message', message => {
        if (message.type === 'result') result = message;
        if (message.type !== 'phase') return;
        phases.push(message);
        Promise.resolve().then(() => onPhase?.(message)).then(() => {
          if (child.connected) child.send({ type: 'continue', phase: message.phase });
        }).catch(e => { phaseError = e; child.kill('SIGTERM'); });
      });
      try {
        child.send(input);
        const [exit] = await within(Promise.race([record.finished, failed]), 30000, 'filesystem child deadline');
        report({ mode: input.mode, exit, phases, result });
        if (phaseError) throw phaseError;
        assert.equal(exit.signal, null, output);
        assert.equal(exit.code, crash ? 73 : 0, output);
        if (crash) {
          assert.equal(result, undefined, 'crashed child must not report a durable receipt');
          assert.equal(phases.some(p => p.phase === 'linked-before-unlink'), true);
        } else assert.ok(result, `missing child result: ${output}`);
        return { result, phases, exit };
      } finally {
        if (!record.confirmed) await stop(record);
        if (record.confirmed) children.delete(record);
      }
    },
  };
}
