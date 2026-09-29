import { createHash, randomUUID } from 'node:crypto';
import { parseTaskMessage, parseProjectListQuery, buildTaskReply, buildProjectListReply, requirementFingerprint } from './protocol.js';

const INTERRUPTED = '状态未知：桥接重启，执行结果无法确认；不会自动重新提交。';
const LEASE_LOST = new Set(['LEASE_EXPIRED', 'STALE_FENCE', 'LEASE_CONFLICT']);
const safeSession = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? ` 会话 ID：${id}。` : '';
// Exact-value redaction bounds this process's own credentials only; arbitrary model output is not guaranteed safe.
function safeText(value, secrets) {
  if (typeof value !== 'string') return '';
  let text = value;
  for (const secret of secrets) if (typeof secret === 'string' && secret) text = text.split(secret).join('[REDACTED]');
  return text.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 1500);
}
const detail = (result, secrets) => safeText(result?.summary, secrets) || safeText(result?.reason, secrets) || '没有可安全转发的详细输出';
// Stable outbound id makes retries of the same terminal state idempotent in the IM journal.
function terminalID(sender, taskId, status = 'failed', confirmed = false) {
  const hex = createHash('sha256').update(`${sender.toLowerCase()}\0${taskId}\0${status}\0${confirmed}\0terminal`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createBridge({ config, tasks, runner, imClient, clock = Date.now, secrets = [] }) {
  if (!config || !tasks || !runner || !imClient || typeof clock !== 'function') throw new TypeError('Bridge dependencies required');
  const queues = new Map();
  const delivered = new Set();
  const envelopes = new Map();
  const active = new Set();
  let leaseGate = Promise.resolve(), leaseExpiresAt = 0, fenced = false;
  // The same gate serves the background renewal and every scheduling path.
  function maintainLease(force = false) {
    const operation = leaseGate.catch(() => {}).then(async () => {
      if (typeof imClient.renewLease !== 'function') { fenced = true; return leaseExpiresAt; }
      if (!force && fenced && clock() < leaseExpiresAt - 5000) return leaseExpiresAt;
      let lease;
      try { lease = await imClient.renewLease(); }
      catch (error) {
        fenced = false;
        if (!LEASE_LOST.has(error?.code) || typeof imClient.acquire !== 'function') throw error;
        lease = await imClient.acquire({ instanceId: randomUUID(), requestId: randomUUID() });
      }
      if (!Number.isFinite(lease?.expiresAt) || lease.expiresAt <= clock()) {
        fenced = false; throw Error('IM lease not valid');
      }
      leaseExpiresAt = lease.expiresAt; fenced = true;
      return leaseExpiresAt;
    });
    leaseGate = operation;
    return operation;
  }
  const key = directory => process.platform === 'win32' ? directory.toLowerCase() : directory;
  const blockingSummary = task => `该项目有未完成/待确认任务 ${task.taskId}，不能启动新任务；需人工核查远端会话。`;

  async function send(message, payload, clientMessageId = randomUUID(), title = 'Bridge reply') {
    const conversationId = message.conversationId || (await imClient.ensureConversation({ peerAgentId: message.senderAgentId })).conversationId;
    const request = { protocol: 'a2a-msg.im.v1', conversationId, recipientAgentId: message.senderAgentId,
      clientMessageId, title, text: JSON.stringify(payload), inReplyTo: message.messageId ?? null,
      correlation: message.correlation ?? null };
    const result = await imClient.send(request);
    if (result?.status === 'pending') await imClient.recoverSend(clientMessageId);
  }
  const reply = (message, taskId, status, summary, extra = {}, id) =>
    send(message, { ...buildTaskReply({ taskId, status, summary }), ...extra }, id);
  async function terminal(message, task) {
    // Use the same envelope for every retry, including a restart. Conversation and reply
    // metadata are recovered from the persisted incoming message where available.
    const id = terminalID(task.senderAgentId, task.taskId, task.status, task.outcomeConfirmed);
    if (envelopes.has(id)) message = envelopes.get(id);
    else envelopes.set(id, message);
    if (delivered.has(id)) return;
    try {
      const recovered = typeof imClient.recoverSend === 'function' ? await imClient.recoverSend(id).catch(error => {
        if (error?.code !== 'RESOURCE_NOT_FOUND') throw error;
        return null;
      }) : null;
      if (recovered?.status === 'pending') {
        await imClient.recoverSend(id);
      } else if (!recovered) await reply(message, task.taskId, task.status, task.summary, {}, id);
      delivered.add(id);
    }
    catch { /* Staged outgoing remains in the IM journal; next reconciliation retries it. */ }
  }
  async function bestEffort(message, taskId, status, summary) {
    try { await reply(message, taskId, status, summary); }
    catch { /* IM failure must not turn an unsubmitted task into an unknown submission. */ }
  }
  async function inspectBlocking() {
    if (typeof runner.inspectSession !== 'function') return;
    if (typeof imClient.listReceived !== 'function') return;
    for (const receipt of await imClient.listReceived()) {
      const message = receipt.message ?? receipt;
      let input;
      try { input = parseTaskMessage(JSON.parse(message.text)); } catch { continue; }
      const task = tasks.getTask(message.senderAgentId, input.taskId);
      if (!task || !task.sessionID || task.outcomeConfirmed && ['failed', 'completed'].includes(task.status) ||
          task.projectKey !== input.projectKey || task.requirementFingerprint !== requirementFingerprint(input.requirement)) continue;
      const project = config.resolveProject(message.senderAgentId, task.projectKey);
      if (!project.ok) continue;
      let result;
      try { result = await runner.inspectSession({ sessionID: task.sessionID, directory: project.directory }); }
      catch { continue; }
      if (!['completed', 'failed'].includes(result?.status)) continue;
      const summary = result.status === 'completed' ? `OpenCode 已报告完成：${detail(result, secrets)}。${safeSession(task.sessionID)}` :
        `${result.reason === 'OpenCode run interrupted' ? 'OpenCode 已确认执行中断' : 'OpenCode 已报告执行失败'}：${detail(result, secrets)}。${safeSession(task.sessionID)}`;
      const updated = tasks.recordStatus(task.senderAgentId, task.taskId, result.status, summary, { outcomeConfirmed: true });
      await terminal(message, updated);
    }
  }

  async function execute(message, input, project) {
    const directory = project.directory;
    const projectKey = input.projectKey;
    const previous = queues.get(key(directory));
    const work = (async () => {
      if (previous) await previous.catch(() => {});
      const current = tasks.getTask(message.senderAgentId, input.taskId);
      if (!current || !['accepted', 'running'].includes(current.status) || current.submittedOutcomeUnknown) return;
      if (!fenced || clock() >= leaseExpiresAt) throw Error('IM lease lost before execution');
      const blocker = tasks.listUnassociatedUnfinished()[0] ?? tasks.listUnfinishedByProject(projectKey).find(task =>
        (task.senderAgentId !== message.senderAgentId.toLowerCase() || task.taskId !== input.taskId) &&
        (task.submittedOutcomeUnknown || active.has(`${task.senderAgentId}\0${task.taskId}`) || task.status === 'needs_approval'));
      if (blocker) {
        const summary = blockingSummary(blocker);
        const failed = tasks.recordStatus(message.senderAgentId, input.taskId, 'failed', summary, { outcomeConfirmed: true });
        await terminal(message, failed);
        return;
      }
      // The external request has not begun yet. No IM reply may wedge submission.
      if (current.status !== 'running') tasks.recordStatus(message.senderAgentId, input.taskId, 'running', 'OpenCode 正在执行。');
      // Persist uncertainty before any external submission; crash recovery never reposts it.
      tasks.markSubmittedOutcomeUnknown(message.senderAgentId, input.taskId);
      active.add(`${message.senderAgentId.toLowerCase()}\0${input.taskId}`);
      await bestEffort(message, input.taskId, 'running', 'OpenCode 正在执行。');
      let result, beforePromptFailure = false;
      try { result = await runner.runTask({ directory, requirement: input.requirement, permissions: project.permissions,
        onSessionCreated: async sessionID => {
          try {
            // Force a fenced server-side renewal AFTER the potentially slow running reply.
            await maintainLease(true);
            tasks.setSessionID(message.senderAgentId, input.taskId, sessionID);
          } catch (error) { beforePromptFailure = true; throw error; }
        } }); }
      catch (error) { result = { status: 'runner_exception', category: error?.name === 'OpenCodeTransportError' ? '传输异常' : '执行器异常' }; }
      if (result?.status === 'session_record_error' || beforePromptFailure ||
          result?.status === 'transport_error' && !result.sessionID && !tasks.getTask(message.senderAgentId, input.taskId).sessionID) {
        const failed = tasks.recordStatus(message.senderAgentId, input.taskId, 'failed',
          beforePromptFailure ? 'IM 接收租约失效或会话登记失败；提示未提交。' : 'OpenCode 会话创建或登记失败；提示未提交。', { outcomeConfirmed: true });
        active.delete(`${message.senderAgentId.toLowerCase()}\0${input.taskId}`);
        await terminal(message, failed); return;
      }
      if (typeof result?.sessionID === 'string' && result.sessionID.trim() && !tasks.getTask(message.senderAgentId, input.taskId).sessionID)
        tasks.setSessionID(message.senderAgentId, input.taskId, result.sessionID);
      const suffix = safeSession(result?.sessionID);
      let status = 'failed', confirmed = false, summary;
      switch (result?.status) {
        case 'completed':
          status = 'completed'; confirmed = true; summary = `OpenCode 已报告完成：${detail(result, secrets)}。${suffix}`; break;
        case 'failed':
          confirmed = true;
          summary = `${result.reason === 'OpenCode run interrupted' ? 'OpenCode 已确认执行中断' : 'OpenCode 已报告执行失败'}：${detail(result, secrets)}。${suffix}`; break;
        case 'needs_approval':
          if (Array.isArray(result.pendingPermissions) && result.pendingPermissions.length) {
            status = 'needs_approval';
            const actions = result.pendingPermissions.map(p => p?.action).filter(a => typeof a === 'string' && /^[a-z_]{1,50}$/.test(a));
            summary = `等待人工批准：${result.pendingPermissions.length} 项权限请求${actions.length ? `（${actions.join(', ')}）` : ''}；不会自动批准。${suffix}`;
          } else summary = `状态未知：OpenCode 未提供待批准权限请求；执行结果无法确认。${suffix}`;
          break;
        case 'unknown': summary = `状态未知：OpenCode 已返回空闲，但执行结果无法确认：${detail(result, secrets)}。${suffix}`; break;
        case 'transport_error': summary = `OpenCode 传输失败；执行结果无法确认${Number.isInteger(result.httpStatus) ? `（HTTP ${result.httpStatus}）` : ''}，不会自动重新提交。${suffix}`; break;
        case 'runner_exception': summary = `OpenCode ${result.category}；执行结果无法确认，不会自动重新提交。`; break;
        default: summary = `状态未知：OpenCode 返回无法识别的执行状态；执行结果无法确认。${suffix}`;
      }
      const updated = tasks.recordStatus(message.senderAgentId, input.taskId, status, summary,
        status === 'needs_approval' ? {} : { outcomeConfirmed: confirmed });
      active.delete(`${message.senderAgentId.toLowerCase()}\0${input.taskId}`);
      if (status === 'completed' || status === 'failed') await terminal(message, updated);
      else await bestEffort(message, input.taskId, status, summary);
    })();
    queues.set(key(directory), work);
    try { await work; } finally { if (queues.get(key(directory)) === work) queues.delete(key(directory)); }
  }

  async function handle(message) {
    if (!message || typeof message.senderAgentId !== 'string') return;
    let payload;
    try { payload = JSON.parse(message.text); } catch { return; }
    if (payload?.type === 'project_list') {
      try { parseProjectListQuery(payload); } catch { return; }
      await send(message, buildProjectListReply(config.visibleProjects(message.senderAgentId)), randomUUID(), 'Project list');
      return;
    }
    let input;
    try { input = parseTaskMessage(payload); } catch { return; }
    const project = config.resolveProject(message.senderAgentId, input.projectKey);
    if (!project.ok) {
      const projects = project.code === 'UNKNOWN_SENDER' ? [] : config.visibleProjects(message.senderAgentId);
      try { await reply(message, input.taskId, 'failed', project.code,
        projects.length ? buildProjectListReply(projects) : {}); } catch { /* Receipt is durable. */ }
      return;
    }
    const registration = tasks.registerTask({ senderAgentId: message.senderAgentId, taskId: input.taskId,
      projectKey: input.projectKey, requirementFingerprint: requirementFingerprint(input.requirement),
      summary: '已接单，排队等待执行。' });
    if (registration.kind === 'conflict') {
      await bestEffort(message, input.taskId, 'failed', 'taskId 冲突：需求与已登记任务不同。'); return;
    }
    if (registration.kind === 'existing') {
      const old = registration.task;
      if (old.submittedOutcomeUnknown && ['accepted', 'running'].includes(old.status) && !queues.has(key(project.directory))) {
        const failed = tasks.recordStatus(message.senderAgentId, input.taskId, 'failed', INTERRUPTED, { outcomeConfirmed: false });
        await terminal(message, failed);
      } else if (['completed', 'failed'].includes(old.status)) {
        if (delivered.has(terminalID(old.senderAgentId, old.taskId, old.status, old.outcomeConfirmed))) await bestEffort(message, input.taskId, old.status, old.summary);
        else await terminal(message, old);
      }
      else await bestEffort(message, input.taskId, old.status, old.summary);
      return;
    }
    if (!Array.isArray(project.permissions) || !project.permissions.length ||
        project.permissions[0].action !== '*' || project.permissions[0].effect !== 'deny') {
      const failed = tasks.recordStatus(message.senderAgentId, input.taskId, 'failed', '项目缺少安全权限规则，拒绝执行。', { outcomeConfirmed: true });
      await terminal(message, failed); return;
    }
    const blocker = tasks.listUnassociatedUnfinished()[0] ?? tasks.listUnfinishedByProject(input.projectKey).find(task =>
      (task.senderAgentId !== message.senderAgentId.toLowerCase() || task.taskId !== input.taskId) &&
      (task.submittedOutcomeUnknown || active.has(`${task.senderAgentId}\0${task.taskId}`) || task.status === 'needs_approval'));
    if (blocker) {
      const failed = tasks.recordStatus(message.senderAgentId, input.taskId, 'failed', blockingSummary(blocker), { outcomeConfirmed: true });
      await terminal(message, failed); return;
    }
    await bestEffort(message, input.taskId, 'accepted', registration.task.summary);
    await execute(message, input, project);
  }

  async function reconcile() {
    if (typeof imClient.listReceived !== 'function') return;
    await inspectBlocking();
    for (const receipt of await imClient.listReceived()) {
      const message = receipt.message ?? receipt;
      let input;
      try { input = parseTaskMessage(JSON.parse(message.text)); } catch { continue; }
      const existing = tasks.getTask(message.senderAgentId, input.taskId);
      if (!existing) await handle(message);
      else if (existing.requirementFingerprint !== requirementFingerprint(input.requirement) ||
          existing.projectKey !== input.projectKey) {
        await bestEffort(message, input.taskId, 'failed', 'taskId 冲突：需求或项目与已登记任务不同。');
      } else if (['completed', 'failed'].includes(existing.status)) await terminal(message, existing);
      else if (['accepted', 'running'].includes(existing.status) && !existing.submittedOutcomeUnknown) {
        const project = config.resolveProject(message.senderAgentId, input.projectKey);
        if (project.ok) await handlePending(message, input, project);
      }
    }
  }
  async function handlePending(message, input, project) {
    if (!Array.isArray(project.permissions) || !project.permissions.length ||
        project.permissions[0].action !== '*' || project.permissions[0].effect !== 'deny') {
      const failed = tasks.recordStatus(message.senderAgentId, input.taskId, 'failed',
        '项目缺少安全权限规则，拒绝执行。', { outcomeConfirmed: true });
      await terminal(message, failed);
      return;
    }
    await execute(message, input, project);
  }
  async function receive() {
    try { await imClient.ackPending(); return await imClient.receiveOnce(); }
    catch (error) {
      if (!LEASE_LOST.has(error?.code) || typeof imClient.acquire !== 'function') throw error;
      fenced = false;
      await maintainLease();
      await imClient.ackPending();
      return imClient.receiveOnce();
    }
  }
  async function processOnce() {
    await maintainLease();
    await reconcile();
    await maintainLease();
    const page = await receive();
    await Promise.allSettled((page.items ?? []).map(item => handle(item.message ?? item)));
    await reconcile();
    return page;
  }
  async function recoverOnRestart() {
    await maintainLease();
    // Mark prior submissions BEFORE touching receipts. A failed status with unconfirmed
    // outcome remains in listUnfinishedByProject and must block subsequent work.
    const interrupted = tasks.listSubmittedWithoutOutcome();
    for (const task of interrupted) {
      if (!task.submittedOutcomeUnknown) continue;
      const failed = tasks.recordStatus(task.senderAgentId, task.taskId, 'failed', INTERRUPTED, { outcomeConfirmed: false });
      // Reconciliation with the original receipt supplies the original envelope.
      if (typeof imClient.listReceived !== 'function') await terminal({ senderAgentId: task.senderAgentId }, failed);
    }
    await reconcile();
    return interrupted;
  }
  // Operator-only break-glass: after independent verification that the remote run
  // is stopped/never started, attest explicitly; never infer this from a 404/timeout.
  // In particular, this resolves migrated projectKey=null rows that block all projects.
  async function resolveBlockedTask({ senderAgentId, taskId, evidence } = {}) {
    if (typeof evidence !== 'string' || !evidence.trim() || evidence.length > 500) throw new TypeError('Verification evidence required');
    await maintainLease(true);
    const task = tasks.getTask(senderAgentId, taskId);
    if (!task || task.outcomeConfirmed && ['completed', 'failed'].includes(task.status))
      throw new TypeError('No unresolved task');
    const project = task.projectKey && config.resolveProject(senderAgentId, task.projectKey);
    if (active.has(`${senderAgentId.toLowerCase()}\0${taskId}`) || project?.ok && queues.has(key(project.directory)))
      throw new TypeError('Task is active in this bridge');
    const summary = `操作员已独立确认远端执行停止或未开始；任务 ${taskId} 已关闭，不会自动重投。`;
    return tasks.recordStatus(senderAgentId, taskId, 'failed', summary, { outcomeConfirmed: true });
  }
  return Object.freeze({ processOnce, recoverOnRestart, maintainLease, resolveBlockedTask });
}
