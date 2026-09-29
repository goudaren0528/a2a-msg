import assert from 'node:assert/strict';
import https from 'node:https';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImCenter } from '../src/im/server.js';
import { createImAdmin } from '../src/im/admin.js';
import { migrateImSchemaV3, initInstanceIdentity } from '../src/im/schema.js';
import { createImClient } from '../src/im/client.js';
import { createImJournal } from '../src/im/journal.js';
import { createBridgeConfig } from '../src/bridge/config.js';
import { createTaskStore } from '../src/bridge/tasks.js';
import { createBridge } from '../src/bridge/bridge.js';
import { discoverService, createOpenCodeRunner } from '../src/bridge/opencode.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const cert = join(repo, 'tests/fixtures/im-tls/localhost-test-only.crt');
const key = join(repo, 'tests/fixtures/im-tls/localhost-test-only.key');
const projectKey = 'BridgeDemo';
const wait = ms => new Promise(done => setTimeout(done, ms));
function privateRoot(target) {
  if (!isAbsolute(target) || existsSync(target)) throw Error('root must be an absolute, nonexistent path');
  const parent = dirname(target);
  if (!existsSync(parent)) throw Error('root parent must exist');
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw Error('root parent contains a symlink');
  }
  mkdirSync(target, { mode: 0o700 });
  return target;
}
function bounded(promise, label, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out after ${ms}ms`)), ms); })])
    .finally(() => clearTimeout(timer));
}
// Evidence never includes service credentials, remote response bodies, or machine paths.
function safe(value, root) {
  return String(value ?? '').split(/\r?\n/).filter(line => !/(?:password|credential|authorization|api[_-]?key|bearer|secret|token|private[_-]?key|-----BEGIN)/i.test(line))
    .join(' ').replaceAll(root, '[demo-root]')
    .replace(/\b[A-Za-z]:[\\/][^\s,;。，]+|\/(?:[^\s/]+\/)+[^\s,;。，]+/g, '[path]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .slice(0, 1600);
}
async function main() {
  if (process.argv[2] === '--help' && process.argv.length === 3) {
    console.log('Usage: node examples/im-bridge-demo.mjs [--root ABSOLUTE_NONEXISTENT_PATH]'); return;
  }
  if (process.argv.length !== 2 && !(process.argv.length === 4 && process.argv[2] === '--root'))
    throw Error('usage: node examples/im-bridge-demo.mjs [--root ABSOLUTE_NONEXISTENT_PATH]');
  const root = process.argv[2] === '--root' ? privateRoot(process.argv[3]) : mkdtempSync(join(tmpdir(), 'im-bridge-demo-'));
  chmodSync(root, 0o700);
  console.log(`Demo directory (retained): ${root}`);
  const evidence = { pass: false, runtime: process.version, root, projectKey, checks: {} };
  let db, center, server, senderDb, bridgeDb, sender, bridgeClient, tasks, bridgeLease = false, senderLease = false;
  let runPromise;
  try {
    // Discovery uses the real user registration; neither credentials nor registration are copied to the temp root.
    let service;
    try { service = discoverService(); }
    catch (error) { throw Error(`OpenCode service discovery failed (${error.code ?? 'unknown'}); start a local OpenCode v2 service first`); }
    let probe;
    try { probe = await fetch(`${service.baseUrl}/api/session`, { headers: service.headers, signal: AbortSignal.timeout(5000) }); }
    catch { throw Error('OpenCode service is not reachable; start a local OpenCode v2 service first'); }
    if (!probe.ok) throw Error(`OpenCode service probe failed (HTTP ${probe.status}); verify the running v2 service`);
    evidence.checks.serviceDiscovered = true;

    const project = join(root, 'project');
    mkdirSync(project, { mode: 0o700 });
    writeFileSync(join(project, 'note.txt'), 'Bridge demo says hello.\n', { mode: 0o600 });
    db = new DatabaseSync(join(root, 'center-v3.sqlite'));
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    migrateImSchemaV3(db);
    initInstanceIdentity(db, { clock: Date.now });
    const trusted = {};
    const admin = createImAdmin({ db, clock: Date.now, authorizeAdmin: value => value === trusted });
    const agents = ['Demo upstream', 'Demo bridge'].map(displayName => {
      const agentId = admin.registerAgent({ displayName }, trusted).agentId;
      return { agentId, credential: admin.issueCredential({ agentId, expiresAt: null }, trusted).credential };
    });
    admin.setContact({ agentA: agents[0].agentId, agentB: agents[1].agentId, allowed: true,
      reason: 'isolated bridge demo contact' }, trusted);
    db.exec("UPDATE im_settings SET write_mode='enabled' WHERE singleton=1");
    center = createImCenter({ db, policy: { enabled: true, writeMode: 'enabled',
      transport: { mode: 'direct-tls', serverUrl: 'https://localhost:8787' },
      retention: { policy: { messageRetentionMs: 86400000, attachmentRetentionMs: 86400000,
        idempotencyRetentionMs: 172800000, safeRetryWindowMs: 60000 } },
      lease: { ttlMs: 60000, renewalMs: 10000 } } });
    server = https.createServer({ cert: readFileSync(cert), key: readFileSync(key), maxHeaderSize: 8192 }, async (req, res) => {
      try { if (!await center.handler.handle(req, res)) { res.statusCode = 404; res.end(); } }
      catch { res.destroy(); }
    });
    server.maxHeadersCount = 50;
    server.headersTimeout = 10000;
    server.requestTimeout = 20000;
    await bounded(new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); }), 'TLS listen', 10000);
    const serverUrl = `https://127.0.0.1:${server.address().port}`;
    // Node 24 per-process CA trust; never disable TLS verification or alter the user's global config.
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), readFileSync(cert, 'utf8')]);
    const credentialFile = join(root, 'bridge-credential');
    writeFileSync(credentialFile, agents[1].credential, { mode: 0o600 });
    const config = createBridgeConfig({ agentId: agents[1].agentId, serverUrl, credentialFile,
      journalPath: join(root, 'bridge-journal.sqlite'), statePath: join(root, 'bridge-tasks.sqlite'),
      allowedSenders: [agents[0].agentId], projects: [{ projectKey, directory: project,
        description: 'Isolated read-only demo project' }] }); // Built-in deny-first rules: read/glob/grep only.
    function client(agent, path) {
      const journalDb = new DatabaseSync(path);
      journalDb.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
      const attachments = join(root, `${agent.agentId}-attachments`);
      mkdirSync(attachments, { mode: 0o700 });
      return { journalDb, im: createImClient({ serverUrl, agentId: agent.agentId,
        getCredential: async () => agent.credential, attachmentDirectory: attachments,
        journal: scope => createImJournal({ db: journalDb, ...scope }) }) };
    }
    ({ journalDb: senderDb, im: sender } = client(agents[0], join(root, 'sender-journal.sqlite')));
    ({ journalDb: bridgeDb, im: bridgeClient } = client(agents[1], config.journalPath));
    tasks = createTaskStore(config.statePath);
    const received = [];
    const clientWithReceipts = Object.create(bridgeClient);
    clientWithReceipts.listReceived = () => bridgeDb.prepare('SELECT message_json FROM im_client_received WHERE center=? AND agent=? ORDER BY recorded_at,seq')
      .all(new URL(serverUrl).origin, config.agentId).map(row => ({ message: JSON.parse(row.message_json) }));
    let executions = 0;
    const realRunner = createOpenCodeRunner(service);
    const runner = { runTask: input => { executions++; return realRunner.runTask(input); } };
    const basic = service.headers.Authorization.slice('Basic '.length);
    const password = Buffer.from(basic, 'base64').toString('utf8').slice('opencode:'.length);
    const bridge = createBridge({ config, tasks, runner, imClient: clientWithReceipts,
      secrets: [readFileSync(config.credentialFile, 'utf8').trim(), password, basic] });
    await bridgeClient.acquire({ instanceId: randomUUID(), requestId: randomUUID() }); bridgeLease = true;
    await sender.acquire({ instanceId: randomUUID(), requestId: randomUUID() }); senderLease = true;
    await bridge.recoverOnRestart();
    const conversationId = (await sender.ensureConversation({ peerAgentId: agents[1].agentId })).conversationId;
    async function send(payload) {
      await sender.send({ protocol: 'a2a-msg.im.v1', conversationId, recipientAgentId: agents[1].agentId,
        clientMessageId: randomUUID(), title: 'Bridge demo request', text: JSON.stringify(payload),
        inReplyTo: null, correlation: null });
    }
    async function collect() {
      const page = await sender.receiveOnce();
      for (const item of page.items) received.push(JSON.parse(item.message.text));
    }
    async function expectReply(match, label, ms = 15000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        await collect();
        const index = received.findIndex(match);
        if (index !== -1) return received.splice(index, 1)[0];
        await wait(250);
      }
      throw Error(`${label} timed out after ${ms}ms`);
    }
    console.log('1/4: project-list query');
    await send({ type: 'project_list' });
    await bounded(bridge.processOnce(), 'project-list bridge poll', 15000);
    const list = await expectReply(value => Array.isArray(value.projects), 'project-list reply');
    assert.deepEqual(list.projects, [{ projectKey, description: 'Isolated read-only demo project' }]);
    assert.equal(JSON.stringify(list).includes(project), false);
    assert.equal(/(?:[A-Za-z]:[\\/]|\/(?:home|Users|tmp)\/)/.test(JSON.stringify(list)), false);
    evidence.checks.projectList = true;

    console.log('2/4: dispatch real read-only OpenCode task');
    const taskId = `Demo${randomUUID().replaceAll('-', '')}`;
    const requirement = 'Read note.txt in this project using the read tool. In one sentence report its exact contents. Do not edit files, run shell commands, install dependencies, or access outside this project.';
    const task = { taskId, projectKey, requirement };
    await send(task);
    runPromise = bridge.processOnce();
    const accepted = await expectReply(value => value.taskId === taskId && value.status === 'accepted', 'accepted reply', 20000);
    assert.ok(accepted.summary);
    evidence.checks.accepted = true;
    const terminal = await expectReply(value => value.taskId === taskId && ['completed', 'failed', 'needs_approval'].includes(value.status),
      'real OpenCode terminal reply', 120000);
    await bounded(runPromise, 'bridge task completion', 10000); runPromise = null;
    assert.ok(terminal.summary?.trim());
    const stored = tasks.getTask(agents[0].agentId, taskId);
    assert.equal(terminal.status, stored.status);
    evidence.task = { taskId, sessionID: stored.sessionID, status: terminal.status,
      summary: safe(terminal.summary, root), outcomeConfirmed: stored.outcomeConfirmed };
    console.log(`OpenCode session: ${stored.sessionID}`);
    console.log(`OpenCode terminal: ${terminal.status} — ${evidence.task.summary}`);

    console.log('3/4: unknown project refusal');
    const refusedId = `Unknown${randomUUID().replaceAll('-', '')}`;
    await send({ taskId: refusedId, projectKey: 'UnknownProject', requirement });
    await bounded(bridge.processOnce(), 'unknown project poll', 15000);
    const refusal = await expectReply(value => value.taskId === refusedId && value.status === 'failed', 'unknown project refusal');
    assert.equal(refusal.summary, 'UNKNOWN_OR_UNAUTHORIZED_PROJECT');
    assert.deepEqual(refusal.projects, list.projects);
    assert.equal(executions, 1);
    evidence.checks.unknownProjectRefused = true;

    console.log('4/4: duplicate taskId');
    await send(task);
    await bounded(bridge.processOnce(), 'duplicate poll', 15000);
    const duplicate = await expectReply(value => value.taskId === taskId && value.status === terminal.status, 'duplicate known status');
    assert.ok(duplicate.summary);
    assert.equal(executions, 1);
    evidence.checks.deduplicated = true;
    evidence.executions = executions;
    if (terminal.status !== 'completed' || !stored.outcomeConfirmed)
      throw Error(`real OpenCode outcome was ${terminal.status}; not claiming PASS`);
    evidence.checks.realOutcomeCompleted = true;
  } catch (error) {
    evidence.error = safe(error.message, root);
    throw error;
  } finally {
    if (runPromise) {
      try { await bounded(runPromise, 'aborted bridge task', 10000); } catch { /* Preserve failure evidence. */ }
    }
    if (senderLease) try { await sender.release(); evidence.checks.senderLeaseRelease = true; }
    catch { evidence.checks.senderLeaseRelease = false; }
    if (bridgeLease) try { await bridgeClient.release(); evidence.checks.bridgeLeaseRelease = true; }
    catch { evidence.checks.bridgeLeaseRelease = false; }
    sender?.close(); bridgeClient?.close(); tasks?.close(); senderDb?.close(); bridgeDb?.close();
    center?.close(); server?.closeAllConnections();
    if (server?.listening) await bounded(new Promise(done => server.close(done)), 'center close', 10000);
    db?.close();
    if (evidence.checks.realOutcomeCompleted && (!evidence.checks.senderLeaseRelease || !evidence.checks.bridgeLeaseRelease))
      evidence.error = 'IM lease release failed; demo cannot claim clean completion';
    evidence.pass = evidence.checks.realOutcomeCompleted === true && !evidence.error;
    writeFileSync(join(root, 'summary.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (evidence.checks.realOutcomeCompleted && !evidence.pass) throw Error(evidence.error);
    if (evidence.pass) console.log('PASS: real OpenCode completed; project list, refusal and dedup verified.');
  }
}
main().catch(error => {
  const message = /root must be an absolute, nonexistent path/.test(error.message) ? error.message :
    /OpenCode/.test(error.message) ? error.message : 'inspect retained summary.json for redacted details';
  console.error(`Demo failed: ${message}`); process.exitCode = 1;
});
