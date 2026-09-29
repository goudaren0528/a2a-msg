// OpenCode v2 HTTP adapter. The caller owns project authorization and permission rules.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_SUMMARY_LENGTH = 2000;
const NO_OUTPUT = '无可用的助手输出';

export class OpenCodeDiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OpenCodeDiscoveryError';
    this.code = code;
  }
}

export function discoverService({ registrationPath, env = process.env } = {}) {
  const home = env.USERPROFILE || env.HOME ||
    (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined) ||
    (env === process.env ? homedir() : undefined);
  if (!registrationPath && !home) {
    throw new OpenCodeDiscoveryError('HOME_MISSING', 'OpenCode registration home directory is unavailable');
  }
  const path = registrationPath ?? join(home, '.local', 'state', 'opencode', 'service.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Never propagate filesystem diagnostics: a caller-provided path may contain secrets.
    throw new OpenCodeDiscoveryError('REGISTRATION_UNREADABLE', 'OpenCode service registration file is missing or unreadable');
  }
  let registration;
  try {
    registration = JSON.parse(raw);
  } catch {
    throw new OpenCodeDiscoveryError('REGISTRATION_INVALID', 'OpenCode service registration is invalid JSON');
  }
  if (!registration || typeof registration !== 'object' || Array.isArray(registration)) {
    throw new OpenCodeDiscoveryError('REGISTRATION_INVALID', 'OpenCode service registration must be an object');
  }
  if (typeof registration.url !== 'string' || !registration.url.trim()) {
    throw new OpenCodeDiscoveryError('URL_MISSING', 'OpenCode service registration has no URL');
  }
  if (typeof registration.password !== 'string' || !registration.password) {
    throw new OpenCodeDiscoveryError('PASSWORD_MISSING', 'OpenCode service registration has no password');
  }
  let url;
  try {
    url = new URL(registration.url);
  } catch {
    throw new OpenCodeDiscoveryError('URL_INVALID', 'OpenCode service URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new OpenCodeDiscoveryError('URL_NOT_LOOPBACK', 'OpenCode service URL must be a loopback HTTP(S) origin');
  }
  return {
    baseUrl: url.origin,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${registration.password}`, 'utf8').toString('base64')}` },
    version: registration.version,
    pid: registration.pid,
  };
}

export function createOpenCodeRunner({ baseUrl, headers = {}, fetchImpl = globalThis.fetch } = {}) {
  if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl)) {
    throw new TypeError('baseUrl must be an explicit HTTP(S) service URL');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const root = baseUrl.replace(/\/+$/, '');

  async function request(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new OpenCodeTransportError('OpenCode transport failure', { cause: error });
    }
    if (!response?.ok) {
      throw new OpenCodeTransportError(`OpenCode HTTP failure (${response?.status ?? 'no status'})`, {
        httpStatus: response?.status,
      });
    }
    if (response.status === 204) return undefined;
    try {
      const json = await response.json();
      return json && typeof json === 'object' && !Array.isArray(json) && Object.hasOwn(json, 'data') ? json.data : json;
    } catch (error) {
      throw new OpenCodeTransportError('Invalid OpenCode JSON response', { cause: error });
    }
  }

  async function runTask({ directory, requirement, sessionID, agent, permissions, onSessionCreated } = {}) {
    if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('directory is required');
    if (typeof requirement !== 'string' || !requirement.trim()) throw new TypeError('requirement is required');
    if (onSessionCreated !== undefined && typeof onSessionCreated !== 'function') throw new TypeError('onSessionCreated must be a function');
    let id = sessionID;
    try {
      if (id) {
        const existing = await request('GET', `/api/session/${encodeURIComponent(id)}`);
        if (!existing || existing.id !== id) {
          throw new OpenCodeTransportError('OpenCode session validation failed');
        }
        if (existing.location?.directory && existing.location.directory !== directory) {
          throw new OpenCodeTransportError('OpenCode session directory mismatch');
        }
      } else {
        const created = await request('POST', '/api/session', {
          location: { directory },
          ...(agent === undefined ? {} : { agent }),
          ...(permissions === undefined ? {} : { permissions }),
        });
        if (typeof created?.id !== 'string' || !created.id) {
          throw new OpenCodeTransportError('OpenCode session creation returned no id');
        }
        id = created.id;
      }
      if (onSessionCreated) {
        try {
          await onSessionCreated(id);
        } catch {
          // The session cannot be durably associated with the task: do not prompt it.
          return { status: 'session_record_error', sessionID: id, summary: NO_OUTPUT, reason: 'OpenCode session recording failed' };
        }
      }

      const path = `/api/session/${encodeURIComponent(id)}`;
      await request('POST', `${path}/prompt`, { text: requirement });
      await request('POST', `/api/experimental/session/${encodeURIComponent(id)}/wait`);
      // Idle may mean an agent is blocked on a permission request, not that it succeeded.
      const pending = await request('GET', `${path}/permission`);
      validatePermissions(pending);
      if (pending.length) {
        let summary = null;
        try {
          const messages = await request('GET', `${path}/message`);
          validateMessages(messages);
          summary = assistantSummary(messages);
        } catch (error) {
          if (!(error instanceof OpenCodeTransportError)) throw error;
          // Already known to be waiting for approval; output retrieval is optional here.
        }
        return {
          status: 'needs_approval', sessionID: id,
          ...(summary === null ? {} : { summary }),
          pendingPermissions: pending.map(({ id: requestID, action, resources }) => ({
            requestID, action, resources,
          })),
        };
      }
      const session = await request('GET', path);
      const messages = await request('GET', `${path}/message`);
      validateMessages(messages);
      const summary = assistantSummary(messages);
      const detail = { sessionID: id, ...(summary === null ? {} : { summary }) };
      if (session?.outcome === 'succeeded') return { status: 'completed', ...detail };
      if (session?.outcome === 'failed') return { status: 'failed', ...detail, reason: 'OpenCode run failed' };
      if (session?.outcome === 'interrupted') {
        return { status: 'failed', ...detail, reason: 'OpenCode run interrupted' };
      }
      return { status: 'unknown', ...detail, reason: '状态未知：OpenCode outcome 未记载或无法识别' };
    } catch (error) {
      if (!(error instanceof OpenCodeTransportError)) throw error;
      return {
        status: 'transport_error', sessionID: id,
        summary: NO_OUTPUT, reason: error.message,
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      };
    }
  }

  // A 404 from either session endpoint means the session is gone, not completed.
  async function inspectSession({ sessionID, directory } = {}) {
    if (typeof sessionID !== 'string' || !sessionID.trim()) throw new TypeError('sessionID is required');
    if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('directory is required');
    const path = `/api/session/${encodeURIComponent(sessionID)}`;
    try {
      const pending = await request('GET', `${path}/permission`);
      validatePermissions(pending);
      if (pending.length) {
        let summary;
        try {
          const messages = await request('GET', `${path}/message`);
          validateMessages(messages);
          summary = assistantSummary(messages, null);
        } catch (error) {
          if (!(error instanceof OpenCodeTransportError)) throw error;
          // A known pending approval remains actionable even if messages cannot be read.
        }
        return {
          status: 'needs_approval', sessionID,
          ...(summary == null ? {} : { summary }),
          pendingPermissions: pending.map(({ id: requestID, action, resources }) => ({ requestID, action, resources })),
        };
      }
      const session = await request('GET', path);
      if (session?.id !== sessionID || (session.location?.directory && session.location.directory !== directory)) {
        throw new OpenCodeTransportError('OpenCode session validation failed');
      }
      const messages = await request('GET', `${path}/message`);
      validateMessages(messages);
      const summary = assistantSummary(messages, null);
      const detail = { sessionID, ...(summary === null ? {} : { summary }) };
      if (session.outcome === 'succeeded') return { status: 'completed', ...detail };
      if (session.outcome === 'failed') return { status: 'failed', ...detail, reason: 'OpenCode run failed' };
      if (session.outcome === 'interrupted') return { status: 'failed', ...detail, reason: 'OpenCode run interrupted' };
      return { status: 'unknown', ...detail, reason: '状态未知：OpenCode outcome 未记载或无法识别' };
    } catch (error) {
      if (!(error instanceof OpenCodeTransportError)) throw error;
      if (error.httpStatus === 404) return { status: 'unknown', sessionID, reason: 'OpenCode session not found', httpStatus: 404 };
      return {
        status: 'transport_error', sessionID, reason: error.message,
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      };
    }
  }

  async function replyPermission({ sessionID, requestID, decision, message } = {}) {
    if (!['once', 'always', 'reject'].includes(decision)) throw new TypeError('Invalid permission decision');
    if (!sessionID || !requestID) throw new TypeError('sessionID and requestID are required');
    return request('POST', `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`, {
      decision,
      ...(message === undefined ? {} : { message }),
    });
  }

  return { runTask, inspectSession, replyPermission };
}

export class OpenCodeTransportError extends Error {
  constructor(message, { cause, httpStatus } = {}) {
    super(message, { cause });
    this.name = 'OpenCodeTransportError';
    this.httpStatus = httpStatus;
  }
}

function assistantSummary(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== 'object') continue;
    if ((message.info?.role ?? message.role ?? message.type) !== 'assistant') continue;
    const content = message.parts ?? message.content;
    if (!Array.isArray(content)) continue;
    const text = content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text).join('\n').trim();
    if (text) return text.slice(0, MAX_SUMMARY_LENGTH);
  }
  return null;
}

function validateMessages(messages) {
  if (!Array.isArray(messages)) {
    throw new OpenCodeTransportError('Invalid message list response');
  }
}

function validatePermissions(pending) {
  if (!Array.isArray(pending) || !pending.every(permission => permission && typeof permission === 'object' &&
    typeof permission.id === 'string' && permission.id)) {
    throw new OpenCodeTransportError('Invalid permission list response');
  }
}
