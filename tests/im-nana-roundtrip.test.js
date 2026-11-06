import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const demo = fileURLToPath(new URL('../examples/im-nana-roundtrip.mjs', import.meta.url));

test('help does not create a root; existing root is never adopted or overwritten', () => {
  const help = spawnSync(process.execPath, [demo, '--help'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'im-nana-roundtrip-refusal-'));
  try {
    const root = join(parent, 'instance');
    mkdirSync(root);
    const marker = join(root, 'keep.txt');
    writeFileSync(marker, 'unchanged');
    const refused = spawnSync(process.execPath, [demo, '--root', root], { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /nonexistent path/);
    assert.equal(readFileSync(marker, 'utf8'), 'unchanged');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('isolated roundtrip: send → journaled receive → ACK → handoff, dedupe, restart, reply/read', () => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'im-nana-roundtrip-test-'));
  try {
    const root = join(parent, 'instance');
    const result = spawnSync(process.execPath, [demo, '--root', root], { encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, `demo failed (${result.signal ?? 'nonzero exit'}): ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PASS: 3 accepted, 3 delivered\/ACKed; duplicate deduplicated; restart cursor continued; reply delivered then read\./);
    assert.equal(existsSync(root), true);
    const summary = JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8'));
    assert.equal(summary.pass, true);
    assert.equal(summary.accepted, 3);
    assert.equal(summary.delivered, 3);
    assert.equal(summary.sendKeys, 3);
    assert.equal(summary.duplicateAttempts, 1);
    assert.equal(summary.receiverProcessStarts, 3);
    assert.ok(summary.receiverLeaseGeneration >= 3);
    assert.deepEqual(summary.handoffCursors, [1, 2]);
    assert.deepEqual(summary.negativeChecks.wrongCredential, 'INVALID_CREDENTIAL');
    assert.deepEqual(summary.negativeChecks.unknownPeer, 'RESOURCE_NOT_FOUND');
    const linesOf = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const hostAEvidence = linesOf(summary.evidence.hostA);
    const hostBEvidence = linesOf(summary.evidence.hostB);
    assert.ok(hostAEvidence.some(item => item.type === 'receive' && item.acked === true));
    assert.ok(hostBEvidence.some(item => item.type === 'receive' && item.acked === true));
    assert.ok(hostBEvidence.some(item => item.type === 'handoff'));
    assert.equal(hostAEvidence.filter(item => item.type === 'send').length, 3);
    assert.equal(existsSync(join(root, 'center-v3.sqlite')), true);
    assert.equal(existsSync(join(root, 'host-b/journal.sqlite')), true);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
