import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const demo = fileURLToPath(new URL('../examples/im-bridge-demo.mjs', import.meta.url));

test('help works; existing non-empty root is never adopted or overwritten', () => {
  const help = spawnSync(process.execPath, [demo, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  const root = mkdtempSync(join(tmpdir(), 'im-bridge-demo-refusal-'));
  try {
    const marker = join(root, 'keep.txt');
    writeFileSync(marker, 'unchanged');
    const refused = spawnSync(process.execPath, [demo, '--root', root], { encoding: 'utf8', timeout: 5000 });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /nonexistent path/);
    assert.equal(readFileSync(marker, 'utf8'), 'unchanged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
