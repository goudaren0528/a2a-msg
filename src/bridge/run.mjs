import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createBridgeConfig } from './config.js';
import { createTaskStore } from './tasks.js';
import { createOpenCodeRunner, discoverService } from './opencode.js';
import { createBridge } from './bridge.js';
import { createImClient } from '../im/client.js';
import { createImJournal } from '../im/journal.js';

async function main() {
  // Break-glass operator path, only after independently verifying the remote
  // session is stopped or never started: node run.mjs CONFIG --resolve SENDER TASK EVIDENCE
  // A migrated null-project row blocks every project until explicitly resolved.
  const resolving = process.argv[3] === '--resolve';
  if (process.argv.length !== (resolving ? 7 : 3))
    throw new TypeError('Usage: node src/bridge/run.mjs CONFIG [--resolve SENDER TASK EVIDENCE]');
  process.umask(0o077);
  const raw = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
  // projects[].permissions: ordered OpenCode {action,resource,effect} rules;
  // omit for the restrictive built-in deny-first default, never use machine defaults.
  const config = createBridgeConfig(raw);
  const service = discoverService();
  const journalDb = new DatabaseSync(config.journalPath);
  let tasks, imClient, leaseHeld = false;
  try {
    journalDb.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    mkdirSync(join(dirname(config.journalPath), 'attachments'), { recursive: true, mode: 0o700 });
    tasks = createTaskStore(config.statePath);
    imClient = createImClient({ serverUrl: config.serverUrl, agentId: config.agentId,
      getCredential: async () => readFileSync(config.credentialFile, 'utf8').trim(),
      attachmentDirectory: join(dirname(config.journalPath), 'attachments'),
      journal: scope => createImJournal({ db: journalDb, ...scope }) });
    // Journal receipts remain available after ACK; the bridge reconciles them on every poll.
    const client = Object.create(imClient);
    client.listReceived = () => journalDb.prepare('SELECT message_json FROM im_client_received WHERE center=? AND agent=? ORDER BY recorded_at,seq')
      .all(new URL(config.serverUrl).origin, config.agentId).map(row => ({ message: JSON.parse(row.message_json) }));
    const basic = service.headers.Authorization.slice('Basic '.length);
    const password = Buffer.from(basic, 'base64').toString('utf8').slice('opencode:'.length);
    const bridge = createBridge({ config, tasks, runner: createOpenCodeRunner(service), imClient: client,
      secrets: [readFileSync(config.credentialFile, 'utf8').trim(), password, basic] });
    let stop = false;
    process.once('SIGINT', () => { stop = true; });
    process.once('SIGTERM', () => { stop = true; });
    await imClient.acquire({ instanceId: randomUUID(), requestId: randomUUID() });
    leaseHeld = true;
    if (resolving) {
      await bridge.resolveBlockedTask({ senderAgentId: process.argv[4], taskId: process.argv[5], evidence: process.argv[6] });
      process.stderr.write('Operator-verified task resolved.\n');
      return;
    }
    // Schedule renewal ahead of the actual server expiry; the bridge serializes
    // this path with receive-path renewal/reacquire through one lease gate.
    let renewal;
    let renewalStopped = false;
    const scheduleRenewal = expiresAt => {
      if (renewalStopped) return;
      const delay = Math.max(1000, Math.min(30000, expiresAt - Date.now() - 5000));
      renewal = setTimeout(async () => {
        try { scheduleRenewal(await bridge.maintainLease()); }
        catch {
          process.stderr.write('IM lease renewal failed; scheduling paused.\n');
          scheduleRenewal(Date.now() + 6000);
        }
      }, delay);
    };
    scheduleRenewal(await bridge.maintainLease());
    try {
      await bridge.recoverOnRestart();
      while (!stop) {
        try { await bridge.processOnce(); }
        catch { process.stderr.write('Bridge poll failed; durable receipts will be retried.\n'); }
        if (!stop) await new Promise(done => setTimeout(done, 2000));
      }
    } finally { renewalStopped = true; clearTimeout(renewal); }
  } finally {
    if (leaseHeld) try { await imClient.release(); } catch { /* Lease may already have expired. */ }
    imClient?.close();
    tasks?.close();
    journalDb.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('Bridge stopped; inspect service configuration and connectivity.\n'); process.exitCode = 1; });
}
