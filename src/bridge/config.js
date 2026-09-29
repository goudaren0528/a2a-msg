import { isAbsolute, resolve } from 'node:path';

// Stable identifiers: ASCII letter first, then up to 63 letters/digits/_/-; never a path.
export const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const own = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(key => keys.includes(key));
const invalid = () => { throw new TypeError('Invalid bridge configuration'); };
const absolute = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
  isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const agent = value => typeof value === 'string' && UUID.test(value);
// OpenCode Permission.Ruleset: ordered {action,resource,effect}; later rules win.
// The first rule denies every tool, including MCP; shell/execute remain ask-only.
const BASE = Object.freeze({ action: '*', resource: '*', effect: 'deny' });
const DEFAULT_RULES = Object.freeze([BASE,
  ...['read', 'glob', 'grep'].map(action => Object.freeze({ action, resource: '*', effect: 'allow' })),
  ...['edit', 'shell', 'execute', 'external_directory'].map(action => Object.freeze({ action, resource: '*', effect: 'ask' }))]);
function permissionRules(input) {
  if (input === undefined) return DEFAULT_RULES;
  if (!Array.isArray(input) || !input.length || input.length > 100 ||
      input.some(rule => !own(rule, ['action', 'resource', 'effect']) || Object.keys(rule).length !== 3 ||
        !['action', 'resource'].every(key => typeof rule[key] === 'string' && rule[key].length > 0 &&
          rule[key].length <= 4096 && !/[\x00-\x1f\x7f]/.test(rule[key])) ||
        !['allow', 'deny', 'ask'].includes(rule.effect)) ||
      input[0].action !== '*' || input[0].resource !== '*' || input[0].effect !== 'deny' ||
      input.slice(1).some(rule => rule.effect === 'allow' &&
        (!['read', 'glob', 'grep'].includes(rule.action) || rule.resource !== '*'))) invalid();
  return Object.freeze(input.map(rule => Object.freeze({ ...rule })));
}

export function createBridgeConfig(raw) {
  if (!own(raw, ['agentId', 'serverUrl', 'credentialFile', 'journalPath', 'statePath', 'allowedSenders', 'projects']) ||
      Object.keys(raw).length !== 7 || !agent(raw.agentId) ||
      typeof raw.serverUrl !== 'string' || !raw.serverUrl || raw.serverUrl.length > 2048 ||
      !absolute(raw.credentialFile) || !absolute(raw.journalPath) || !absolute(raw.statePath) ||
      !Array.isArray(raw.allowedSenders) || !raw.allowedSenders.length ||
      raw.allowedSenders.some(value => !agent(value)) || !Array.isArray(raw.projects) || !raw.projects.length) invalid();
  const senders = new Set(raw.allowedSenders.map(value => value.toLowerCase()));
  if (senders.size !== raw.allowedSenders.length) invalid();
  const keys = new Set(), directories = new Set();
  const projects = raw.projects.map(project => {
    if (!own(project, ['projectKey', 'directory', 'description', 'allowedSenders', 'permissions']) ||
        typeof project.projectKey !== 'string' || !PROJECT_KEY.test(project.projectKey) || !absolute(project.directory) ||
        project.description !== undefined && (typeof project.description !== 'string' || project.description.length > 200) ||
        project.allowedSenders !== undefined && (!Array.isArray(project.allowedSenders) || !project.allowedSenders.length ||
          project.allowedSenders.some(value => !agent(value) || !senders.has(value.toLowerCase())))) invalid();
    const permitted = project.allowedSenders ?? raw.allowedSenders;
    const scoped = new Set(permitted.map(value => value.toLowerCase()));
    const directory = resolve(project.directory);
    const directoryKey = process.platform === 'win32' ? directory.toLowerCase() : directory;
    if (scoped.size !== permitted.length || keys.has(project.projectKey) || directories.has(directoryKey)) invalid();
    keys.add(project.projectKey);
    directories.add(directoryKey);
    return Object.freeze({ projectKey: project.projectKey, directory, permissions: permissionRules(project.permissions),
      description: project.description, senders: scoped });
  });
  const byKey = new Map(projects.map(project => [project.projectKey, project]));
  const known = sender => agent(sender) && senders.has(sender.toLowerCase());
  function resolveProject(senderAgentId, projectKey) {
    if (!known(senderAgentId)) return { ok: false, code: 'UNKNOWN_SENDER' };
    const project = byKey.get(projectKey);
    if (!project || !project.senders.has(senderAgentId.toLowerCase()))
      return { ok: false, code: 'UNKNOWN_OR_UNAUTHORIZED_PROJECT' };
    return { ok: true, directory: project.directory, permissions: project.permissions };
  }
  function visibleProjects(senderAgentId) {
    if (!known(senderAgentId)) return [];
    return projects.filter(project => project.senders.has(senderAgentId.toLowerCase()))
      .map(project => project.description === undefined ? { projectKey: project.projectKey } :
        { projectKey: project.projectKey, description: project.description });
  }
  return Object.freeze({ agentId: raw.agentId.toLowerCase(), serverUrl: raw.serverUrl,
    credentialFile: raw.credentialFile, journalPath: raw.journalPath, statePath: raw.statePath,
    resolveProject, visibleProjects });
}
