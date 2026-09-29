import { createHash } from 'node:crypto';
import { PROJECT_KEY } from './config.js';

const fields = (value, required, optional = []) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
  required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const invalid = () => { throw new TypeError('Invalid bridge message'); };
const token = value => typeof value === 'string' && PROJECT_KEY.test(value);

export function parseTaskMessage(value) {
  if (!fields(value, ['taskId', 'projectKey', 'requirement'], ['projectName']) ||
      !token(value.taskId) || !token(value.projectKey) ||
      typeof value.requirement !== 'string' || !value.requirement.trim() || value.requirement.length > 32000 ||
      Object.hasOwn(value, 'projectName') &&
        (typeof value.projectName !== 'string' || !value.projectName.trim() || value.projectName.length > 200)) invalid();
  return { taskId: value.taskId, projectKey: value.projectKey, requirement: value.requirement,
    ...(Object.hasOwn(value, 'projectName') ? { projectName: value.projectName } : {}) };
}

export function parseProjectListQuery(value) {
  if (!fields(value, ['type']) || value.type !== 'project_list') invalid();
  return { type: 'project_list' };
}

export function requirementFingerprint(requirement) {
  if (typeof requirement !== 'string' || !requirement.trim() || requirement.length > 32000) invalid();
  return createHash('sha256').update(requirement, 'utf8').digest('hex');
}

export function buildTaskReply(value) {
  if (!fields(value, ['taskId', 'status', 'summary'], ['changedFiles', 'testResult']) ||
      !token(value.taskId) || !['accepted', 'running', 'needs_approval', 'completed', 'failed'].includes(value.status) ||
      typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 32000 ||
      Object.hasOwn(value, 'changedFiles') && (!Array.isArray(value.changedFiles) ||
        value.changedFiles.some(file => typeof file !== 'string' || !file || file.length > 4096)) ||
      Object.hasOwn(value, 'testResult') &&
        (typeof value.testResult !== 'string' || value.testResult.length > 32000)) invalid();
  return { taskId: value.taskId, status: value.status, summary: value.summary,
    ...(Object.hasOwn(value, 'changedFiles') ? { changedFiles: [...value.changedFiles] } : {}),
    ...(Object.hasOwn(value, 'testResult') ? { testResult: value.testResult } : {}) };
}

export function buildProjectListReply(projects) {
  if (!Array.isArray(projects) || projects.some(project =>
    !fields(project, ['projectKey'], ['description']) || !token(project.projectKey) ||
    Object.hasOwn(project, 'description') &&
      (typeof project.description !== 'string' || project.description.length > 200))) invalid();
  return { projects: projects.map(project => ({ projectKey: project.projectKey,
    ...(Object.hasOwn(project, 'description') ? { description: project.description } : {}) })) };
}
