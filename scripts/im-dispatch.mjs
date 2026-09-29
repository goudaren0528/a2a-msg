import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImClient } from '../src/im/client.js';
import { createImJournal } from '../src/im/journal.js';
import { PROJECT_KEY } from '../src/bridge/config.js';
import { parseProjectListQuery, parseTaskMessage, buildProjectListReply, buildTaskReply } from '../src/bridge/protocol.js';

const usage = `Usage:
  node scripts/im-dispatch.mjs --root <ABSOLUTE bootstrap root> --bridge <bridge agentId> projects [--timeout <seconds>]
  node scripts/im-dispatch.mjs --root <ABSOLUTE bootstrap root> --bridge <bridge agentId> task --id <taskId> --project <projectKey> (--requirement <text|-> | --requirement-file <file>) [--timeout <seconds>]
  node scripts/im-dispatch.mjs --root <ABSOLUTE bootstrap root> --bridge <bridge agentId> watch
Use --requirement - to read stdin. Default timeout: projects 30 seconds, task 600 seconds.`;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const wait = ms => new Promise(done => setTimeout(done, ms));
// A full 20-message page can cost ~27 requests. Five seconds keeps this drain
// below ~324 requests/minute, leaving room under the shared 600/minute limit.
const BACKLOG_PAGE_DELAY_MS = 5000;
const RETRY_START_MS = 5000;
const RETRY_MAX_MS = 60000;

export const projectQuery = () => parseProjectListQuery({ type: 'project_list' });
export const taskMessage = (taskId, projectKey, requirement) => {
  try { return parseTaskMessage({ taskId, projectKey, requirement }); }
  catch { throw Error('invalid --requirement: expected nonempty text of at most 32000 characters'); }
};

export function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return null;
  const values = {};
  let command;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (['projects', 'task', 'watch'].includes(word)) {
      if (command) throw Error(`unexpected command: ${word}`);
      command = word;
      continue;
    }
    if (!['--root', '--bridge', '--id', '--project', '--requirement', '--requirement-file', '--timeout'].includes(word))
      throw Error(`unknown argument: ${word}`);
    if (Object.hasOwn(values, word)) throw Error(`duplicate ${word}`);
    const value = argv[++i];
    if (value === undefined || value === '' || value.startsWith('--')) throw Error(`missing value for ${word}`);
    values[word] = value;
  }
  if (!values['--root'] || !isAbsolute(values['--root'])) throw Error('--root must be an absolute path');
  if (!UUID.test(values['--bridge'] ?? '')) throw Error('--bridge must be a bridge agentId (UUID)');
  if (!command) throw Error('missing command: projects, task or watch');
  const only = command === 'task' ? ['--root', '--bridge', '--id', '--project', '--requirement', '--requirement-file', '--timeout'] :
    command === 'projects' ? ['--root', '--bridge', '--timeout'] : ['--root', '--bridge'];
  for (const key of Object.keys(values)) if (!only.includes(key)) throw Error(`${key} is not valid for ${command}`);
  let timeout = command === 'task' ? 600 : 30;
  if (values['--timeout'] !== undefined) {
    if (!/^[1-9][0-9]*$/.test(values['--timeout']) || !Number.isSafeInteger(Number(values['--timeout'])) || Number(values['--timeout']) > 86400)
      throw Error('--timeout must be an integer from 1 to 86400 seconds');
    timeout = Number(values['--timeout']);
  }
  if (command === 'task') {
    if (!PROJECT_KEY.test(values['--id'] ?? '')) throw Error('--id taskId must start with a letter and contain at most 64 letters, digits, _ or -');
    if (!PROJECT_KEY.test(values['--project'] ?? '')) throw Error('--project projectKey must start with a letter and contain at most 64 letters, digits, _ or -');
    if (Boolean(values['--requirement']) === Boolean(values['--requirement-file'])) throw Error('provide exactly one of --requirement or --requirement-file');
  }
  return { root: values['--root'], bridgeId: values['--bridge'].toLowerCase(), command, timeout,
    taskId: values['--id'], projectKey: values['--project'], requirement: values['--requirement'], requirementFile: values['--requirement-file'] };
}

function payload(message, sender, bridgeId) {
  if (message.senderAgentId?.toLowerCase() !== bridgeId || message.recipientAgentId?.toLowerCase() !== sender) return null;
  try { return JSON.parse(message.text); } catch { return null; }
}

export async function runReceiveLoop({ im, input, sender, sentMessageId, now = Date.now, sleep = wait,
  log = console.log, report = console.error, isStopped = () => false }) {
  const deadline = input.command === 'watch' ? Infinity : now() + input.timeout * 1000;
  let previousStatus, retryDelay = RETRY_START_MS;
  while (!isStopped() && now() < deadline) {
    let page;
    try { page = await im.receiveOnce(); } // Durable journal receipt and ACK happen before presentation.
    catch (error) {
      if (error?.code !== 'RATE_LIMITED') throw error;
      const delay = Math.min(retryDelay, Math.max(0, deadline - now()));
      if (delay > 0 && !isStopped()) {
        report(`Upstream rate limited; retrying receive in ${delay / 1000} seconds.`);
        await sleep(delay);
      }
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      continue;
    }
    retryDelay = RETRY_START_MS;
    for (const item of page.items) {
      const value = payload(item.message, sender, input.bridgeId);
      if (!value) continue;
      if (input.command === 'projects') {
        if (item.message.inReplyTo !== sentMessageId) continue;
        let list;
        try { list = buildProjectListReply(value.projects); } catch { continue; }
        for (const project of list.projects) log(`${project.projectKey}${project.description ? ` — ${project.description}` : ''}`);
        return { outcome: 'reply', exitCode: 0 };
      }
      let reply;
      try {
        // Unknown-project refusals may additionally carry a project list; display only reply fields.
        reply = buildTaskReply({ taskId: value.taskId, status: value.status, summary: value.summary,
          ...(Object.hasOwn(value, 'changedFiles') ? { changedFiles: value.changedFiles } : {}),
          ...(Object.hasOwn(value, 'testResult') ? { testResult: value.testResult } : {}) });
      } catch { continue; }
      if (input.command === 'task' && reply.taskId !== input.taskId) continue;
      if (input.command === 'watch' || reply.status !== previousStatus) {
        log(`${reply.taskId} ${reply.status}: ${reply.summary}`);
        if (input.command === 'task') previousStatus = reply.status;
      }
      if (input.command === 'task' && ['completed', 'failed', 'needs_approval'].includes(reply.status)) {
        if (reply.status === 'needs_approval') report('Human approval required on the target machine; the bridge deliberately does not auto-approve.');
        return { outcome: 'reply', exitCode: reply.status === 'completed' ? 0 : 1 };
      }
    }
    if (!isStopped()) await sleep(Math.min(page.hasMore ? BACKLOG_PAGE_DELAY_MS : 1000, Math.max(0, deadline - now())));
  }
  if (!isStopped() && input.command !== 'watch') {
    report(input.command === 'task'
      ? `no terminal reply within ${input.timeout} seconds; this is a timeout, not a task failure.`
      : `no project-list reply within ${input.timeout} seconds; this is a timeout, not a bridge failure.`);
    return { outcome: 'timeout', exitCode: 1 };
  }
  return { outcome: 'stopped', exitCode: 0 };
}

export async function releaseLease(im, report = console.error) {
  try { await im.release(); return true; }
  catch (error) {
    report(error?.code === 'RATE_LIMITED'
      ? 'Could not release upstream receive lease (RATE_LIMITED); it will expire at the center. This is a cleanup note.'
      : 'Could not release upstream receive lease; it will expire at the center.');
    return error?.code === 'RATE_LIMITED' ? 'rate-limited' : false;
  }
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  if (!input) { console.log(usage); return; }
  // Reject malformed requests before opening a database or contacting the center.
  const request = input.command === 'task' ? taskMessage(input.taskId, input.projectKey,
    input.requirementFile ? readFileSync(input.requirementFile, 'utf8') : input.requirement === '-' ? readFileSync(0, 'utf8') : input.requirement) :
    input.command === 'projects' ? projectQuery() : null;
  process.umask(0o077);
  const bridge = JSON.parse(readFileSync(join(input.root, 'bridge.json'), 'utf8'));
  const sender = bridge.allowedSenders?.[0]?.toLowerCase();
  if (!UUID.test(sender ?? '') || bridge.allowedSenders.length !== 1 || !UUID.test(bridge.agentId ?? '') ||
      bridge.agentId.toLowerCase() !== input.bridgeId || sender === input.bridgeId || typeof bridge.serverUrl !== 'string')
    throw Error('bridge.json does not match --bridge or has no distinct bootstrap upstream identity');
  const db = new DatabaseSync(join(input.root, 'upstream-journal.sqlite'));
  let im, leased = false, stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    const attachments = join(input.root, 'upstream-attachments');
    mkdirSync(attachments, { recursive: true, mode: 0o700 });
    im = createImClient({ serverUrl: bridge.serverUrl, agentId: sender,
      getCredential: async () => readFileSync(join(input.root, 'credentials', 'upstream-credential'), 'utf8').trim(),
      attachmentDirectory: attachments, journal: scope => createImJournal({ db, ...scope }) });
    try { await im.acquire({ instanceId: randomUUID(), requestId: randomUUID() }); }
    catch (error) {
      if (error.code === 'LEASE_CONFLICT') throw Error('Upstream receive lease is already held (possibly by the bridge using the same identity); refusing to steal it');
      throw error;
    }
    leased = true;
    // Reconcile previously durably recorded replies before polling newer ones.
    await im.ackPending();
    let sentMessageId;
    if (request && !stopped) {
      const conversationId = (await im.ensureConversation({ peerAgentId: input.bridgeId })).conversationId;
      const sent = await im.send({ protocol: 'a2a-msg.im.v1', conversationId, recipientAgentId: input.bridgeId,
        clientMessageId: randomUUID(), title: 'Bridge request', text: JSON.stringify(request), inReplyTo: null, correlation: null });
      sentMessageId = sent.messageId;
      if (input.command === 'task') console.log(`taskId: ${input.taskId}`);
    }
    const result = await runReceiveLoop({ im, input, sender, sentMessageId, isStopped: () => stopped });
    if (result.exitCode) process.exitCode = result.exitCode;
  } finally {
    if (leased && await releaseLease(im) === false) process.exitCode ??= 1;
    im?.close(); db.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Dispatch error: ${error.code ?? error.message}`); process.exitCode = 1; });
}
