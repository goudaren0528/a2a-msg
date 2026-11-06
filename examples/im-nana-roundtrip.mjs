import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const cert = join(repo, 'tests/fixtures/im-tls/localhost-test-only.crt');
const provisionScript = join(repo, 'scripts/im-nana-provision.mjs');
const centerScript = join(repo, 'scripts/im-center.mjs');
const sessionScript = join(repo, 'scripts/im-nana-session.mjs');
const limit = (promise, label, ms = 30000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`timeout: ${label}`)), ms);
  })]).finally(() => clearTimeout(timer));
};

function environment(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env = { HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir,
    XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, XDG_DATA_HOME: dir,
    TEMP: dir, TMP: dir, TMPDIR: dir };
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  if (process.env.PATH) env.PATH = process.env.PATH;
  return env;
}

function privateRoot(target) {
  if (!isAbsolute(target) || existsSync(target)) throw Error('root must be an absolute, nonexistent path');
  const parent = dirname(target);
  if (!existsSync(parent)) throw Error('root parent must exist');
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw Error('root parent contains a symlink');
  }
  return target;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: options.cwd ?? repo, env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '', killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, options.timeout ?? 60000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 1024 * 1024) { killed = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8').slice(0, 65536); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      if (killed) reject(Error(`child killed: ${args[1] ?? args[0]}`));
      else resolve({ status, signal, stdout, stderr });
    });
  });
}

function json(result, label) {
  assert.equal(result.status, 0, `${label} failed (${result.signal ?? 'nonzero exit'}): ${result.stderr.trim()}`);
  try { return JSON.parse(result.stdout); } catch { throw Error(`${label} returned invalid JSON`); }
}

function errorCode(result, label) {
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  let value;
  try { value = JSON.parse(result.stderr.trim()); } catch { throw Error(`${label} returned invalid error JSON: ${result.stderr.slice(0, 200)}`); }
  return value?.error?.code;
}

function readCenter(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return {
    count: sql => db.prepare(sql).get().n,
    row: (sql, ...args) => db.prepare(sql).get(...args),
    close: () => db.close(),
  };
}

async function run() {
  if (process.argv.length > 4 || process.argv[2] === '--help' && process.argv.length !== 3 ||
      process.argv.length > 2 && !['--help', '--root'].includes(process.argv[2]) ||
      process.argv[2] === '--root' && process.argv.length !== 4)
    throw Error('usage: node examples/im-nana-roundtrip.mjs [--root ABSOLUTE_NONEXISTENT_PATH]');
  if (process.argv[2] === '--help') {
    console.log('Usage: node examples/im-nana-roundtrip.mjs [--root ABSOLUTE_NONEXISTENT_PATH]');
    return;
  }
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'im-nana-roundtrip-'));
  const root = process.argv[2] === '--root' ? privateRoot(process.argv[3]) : privateRoot(join(parent, 'instance'));
  console.log(`Roundtrip directory (retained): ${root}`);
  const port = await freePort();
  // 127.0.0.1 keeps the listener and the client on the same loopback family on every OS;
  // the repository test certificate carries an IP SAN for it.
  const serverUrl = `https://127.0.0.1:${port}`;
  let center = null;
  const stopCenter = async () => {
    if (!center || center.exitCode !== null) return;
    center.kill('SIGTERM');
    try { await limit(new Promise(done => center.once('close', done)), 'center close', 5000); }
    catch { if (center.exitCode === null) center.kill('SIGKILL'); }
  };
  try {
    console.log('1/8: provision isolated center and two synthetic Nana identities');
    const trust = process.platform === 'win32' ? ['--trust-windows-permissions'] : [];
    const provision = await runNode([provisionScript, '--root', root, '--agent-a-display', 'nana-home',
      '--agent-b-display', 'nana-office', '--server-url', serverUrl, ...trust],
    { env: environment(join(parent, 'provision-env')), timeout: 30000 });
    assert.equal(provision.status, 0, `provision failed: ${provision.stderr.trim()}`);
    const hostAPath = join(root, 'host-a/nana.json');
    const hostBPath = join(root, 'host-b/nana.json');
    const hostA = JSON.parse(readFileSync(hostAPath, 'utf8'));
    const hostB = JSON.parse(readFileSync(hostBPath, 'utf8'));
    assert.notEqual(hostA.agentId, hostB.agentId);
    assert.equal(hostA.serverUrl, serverUrl);

    console.log('2/8: start isolated HTTPS IM v1 center (separate process)');
    center = spawn(process.execPath, [centerScript, join(root, 'center-config.json')],
      { cwd: repo, env: environment(join(parent, 'center-env')), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const centerErrors = [];
    center.stderr.on('data', chunk => { if (centerErrors.length < 20) centerErrors.push(chunk.toString('utf8').slice(0, 200)); });
    await limit(new Promise((resolve, reject) => {
      let buffered = '';
      center.once('error', reject);
      center.once('exit', code => reject(Error(`center exited before listening (${code}): ${centerErrors.join('')}`)));
      center.stdout.on('data', chunk => {
        buffered += chunk.toString('utf8');
        if (buffered.includes('IM center listening')) resolve();
      });
    }), 'center listen', 15000);

    const cliEnv = dir => ({ ...environment(dir), NODE_EXTRA_CA_CERTS: cert });
    let sequence = 0;
    const cli = async (args, label) => {
      const dir = join(parent, `cli-${++sequence}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const result = await runNode([sessionScript, ...args], { cwd: dir, env: cliEnv(dir), timeout: 60000 });
      return { ...result, label };
    };

    const centerDb = () => readCenter(join(root, 'center-v3.sqlite'));
    const journalRows = host => {
      const db = new DatabaseSync(host.journalPath, { readOnly: true });
      try {
        return db.prepare('SELECT seq,message_id,acked FROM im_client_received ORDER BY seq').all()
          .map(row => ({ seq: row.seq, message_id: row.message_id, acked: row.acked }));
      } finally { db.close(); }
    };
    const evidence = host => readFileSync(host.evidencePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

    const messageA = randomUUID();
    const textA = 'T2 往返测试 001';
    console.log('3/8: A sends to B while B is offline; center accepts exactly one message');
    const sent1 = json(await cli(['send', '--config', hostAPath, '--to-agent', hostB.agentId,
      '--text', textA, '--client-message-id', messageA], 'send 001'), 'send 001');
    assert.equal(sent1.status, 'accepted');
    assert.equal(sent1.clientMessageId, messageA);
    let db = centerDb();
    assert.equal(db.count('SELECT COUNT(*) n FROM im_messages'), 1);
    assert.equal(db.row('SELECT acked_at FROM im_deliveries WHERE message_id=?', sent1.messageId).acked_at, null);
    db.close();
    assert.deepEqual(json(await cli(['status', '--config', hostBPath], 'status B'), 'status B'),
      { agentId: hostB.agentId, received: 0, handedThrough: 0, pending: 0, cursor: 0 });

    console.log('4/8: B receives in a separate process; journal is durable before ACK');
    const received1 = json(await cli(['receive', '--config', hostBPath], 'receive B'), 'receive B');
    assert.deepEqual(received1.received.map(item => item.messageId), [sent1.messageId]);
    assert.equal(received1.received[0].acked, true);
    assert.equal(received1.releaseError, null);
    assert.deepEqual(journalRows(hostB), [{ seq: 1, message_id: sent1.messageId, acked: 1 }]);
    db = centerDb();
    assert.ok(db.row('SELECT acked_at FROM im_deliveries WHERE message_id=?', sent1.messageId).acked_at !== null);
    db.close();

    console.log('5/8: B hands the queued message to the host session (own durable cursor)');
    assert.deepEqual(json(await cli(['status', '--config', hostBPath], 'status B'), 'status B'),
      { agentId: hostB.agentId, received: 1, handedThrough: 0, pending: 1, cursor: 1 });
    const handoff1 = json(await cli(['handoff', '--config', hostBPath], 'handoff B'), 'handoff B');
    assert.equal(handoff1.handedThrough, 1);
    assert.equal(handoff1.items.length, 1);
    assert.equal(handoff1.items[0].text, textA);
    assert.equal(handoff1.items[0].acked, true);
    assert.equal(json(await cli(['status', '--config', hostBPath], 'status B'), 'status B').pending, 0);

    console.log('6/8: duplicate delivery (same clientMessageId + text) is deduplicated end to end');
    const duplicate = json(await cli(['send', '--config', hostAPath, '--to-agent', hostB.agentId,
      '--text', textA, '--client-message-id', messageA], 'duplicate send'), 'duplicate send');
    assert.equal(duplicate.messageId, sent1.messageId);
    db = centerDb();
    assert.equal(db.count('SELECT COUNT(*) n FROM im_messages'), 1);
    assert.equal(db.count('SELECT COUNT(*) n FROM im_send_keys'), 1);
    db.close();
    const afterDuplicate = json(await cli(['receive', '--config', hostBPath], 'receive B'), 'receive B');
    assert.deepEqual(afterDuplicate.received, []);
    assert.deepEqual(journalRows(hostB), [{ seq: 1, message_id: sent1.messageId, acked: 1 }]);
    assert.deepEqual(json(await cli(['handoff', '--config', hostBPath], 'handoff B'), 'handoff B').items, []);
    const hostAEvidence = evidence(hostA);
    assert.equal(hostAEvidence.filter(item => item.type === 'send' && item.messageId === sent1.messageId).length, 2);
    assert.equal(evidence(hostB).filter(item => item.type === 'receive' && item.messageId === sent1.messageId).length, 1);

    console.log('7/8: restart recovery — new receiver process continues the same journal cursor');
    const messageB = randomUUID();
    const textB = 'T2 重启恢复测试 002';
    const sent2 = json(await cli(['send', '--config', hostAPath, '--to-agent', hostB.agentId,
      '--text', textB, '--client-message-id', messageB], 'send 002'), 'send 002');
    const received2 = json(await cli(['receive', '--config', hostBPath], 'receive B restart'), 'receive B restart');
    assert.deepEqual(received2.received.map(item => item.messageId), [sent2.messageId]);
    assert.equal(received2.received[0].acked, true);
    assert.deepEqual(journalRows(hostB), [
      { seq: 1, message_id: sent1.messageId, acked: 1 },
      { seq: 2, message_id: sent2.messageId, acked: 1 },
    ]);
    const handoff2 = json(await cli(['handoff', '--config', hostBPath], 'handoff B'), 'handoff B');
    assert.deepEqual(handoff2.items.map(item => item.text), [textB]);
    assert.equal(handoff2.handedThrough, 2);
    db = centerDb();
    assert.ok(db.row('SELECT generation FROM im_receiver_leases WHERE agent_id=?', hostB.agentId).generation >= 3);
    db.close();
    const receiverEvidence = evidence(hostB).filter(item => item.type === 'receive');
    assert.equal(new Set(receiverEvidence.map(item => item.instanceId)).size, receiverEvidence.length);

    console.log('8/8: B replies; A receives, marks read; delivered/read receipts are observable');
    const messageC = randomUUID();
    const reply = json(await cli(['send', '--config', hostBPath, '--to-agent', hostA.agentId,
      '--text', 'T2 回复 003', '--client-message-id', messageC, '--in-reply-to', sent1.messageId], 'reply'), 'reply');
    assert.equal(reply.status, 'accepted');
    const receivedA = json(await cli(['receive', '--config', hostAPath], 'receive A'), 'receive A');
    assert.deepEqual(receivedA.received.map(item => item.messageId), [reply.messageId]);
    const beforeRead = json(await cli(['message', '--config', hostAPath, '--message-id', reply.messageId], 'message A'), 'message A');
    assert.ok(beforeRead.deliveredAt !== null);
    assert.equal(beforeRead.readAt, null);
    const read = json(await cli(['read', '--config', hostAPath, '--message-id', reply.messageId], 'read A'), 'read A');
    assert.equal(read.changed, true);
    const senderView = json(await cli(['message', '--config', hostBPath, '--message-id', reply.messageId], 'message B'), 'message B');
    assert.ok(senderView.deliveredAt !== null);
    assert.equal(senderView.readAt, read.readAt);

    console.log('negative checks: wrong credential is 401, unknown peer is 404');
    const badCredential = join(root, 'host-a/bad-credential');
    writeFileSync(badCredential, `${randomUUID()}.${'A'.repeat(43)}\n`, { mode: 0o600 });
    const badConfigPath = join(root, 'host-a/nana-bad-credential.json');
    writeFileSync(badConfigPath, JSON.stringify({ ...hostA, credentialFile: badCredential }), { mode: 0o600 });
    assert.equal(errorCode(await cli(['send', '--config', badConfigPath, '--to-agent', hostB.agentId,
      '--text', 'should fail'], 'bad credential'), 'bad credential'), 'INVALID_CREDENTIAL');
    assert.equal(errorCode(await cli(['send', '--config', hostAPath, '--to-agent', randomUUID(),
      '--text', 'should fail'], 'unknown peer'), 'unknown peer'), 'RESOURCE_NOT_FOUND');

    db = centerDb();
    const summary = {
      pass: true,
      protocol: 'a2a-msg.im.v1',
      schema: 3,
      runtime: { node: process.version, platform: process.platform },
      root,
      serverUrl,
      agents: {
        a: { agentId: hostA.agentId, displayName: db.row('SELECT display_name d FROM im_agents WHERE agent_id=?', hostA.agentId).d },
        b: { agentId: hostB.agentId, displayName: db.row('SELECT display_name d FROM im_agents WHERE agent_id=?', hostB.agentId).d },
      },
      messages: { first: sent1.messageId, second: sent2.messageId, reply: reply.messageId },
      accepted: db.count('SELECT COUNT(*) n FROM im_messages'),
      delivered: db.count('SELECT COUNT(*) n FROM im_deliveries WHERE acked_at IS NOT NULL'),
      sendKeys: db.count('SELECT COUNT(*) n FROM im_send_keys'),
      duplicateAttempts: 1,
      receiverProcessStarts: 3,
      receiverLeaseGeneration: db.row('SELECT generation g FROM im_receiver_leases WHERE agent_id=?', hostB.agentId).g,
      handoffCursors: [handoff1.handedThrough, handoff2.handedThrough],
      evidence: { hostA: hostA.evidencePath, hostB: hostB.evidencePath },
      negativeChecks: { wrongCredential: 'INVALID_CREDENTIAL', unknownPeer: 'RESOURCE_NOT_FOUND',
        leaseConflict: 'covered by tests/im-nana-session.test.js' },
      note: 'accepted = center stored; delivered = receiver journaled then ACKed. Message text is untrusted data, never executed.',
    };
    db.close();
    assert.equal(summary.accepted, 3);
    assert.equal(summary.delivered, 3);
    assert.equal(summary.sendKeys, 3);
    writeFileSync(join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log('PASS: 3 accepted, 3 delivered/ACKed; duplicate deduplicated; restart cursor continued; reply delivered then read.');
  } finally {
    await stopCenter();
    if (center && center.exitCode === null) throw Error('center process close unconfirmed; inspect retained demo directory');
  }
}

run().catch(error => { console.error(`Roundtrip failed: ${error.message}`); process.exitCode = 1; });
