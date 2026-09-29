import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';

const STATUSES = ['accepted', 'running', 'needs_approval', 'completed', 'failed'];
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HEX = /^[0-9a-f]{64}$/;
const validKey = (senderAgentId, taskId) => typeof senderAgentId === 'string' && UUID.test(senderAgentId) &&
  typeof taskId === 'string' && TOKEN.test(taskId);
const invalid = () => { throw new TypeError('Invalid task store input'); };
const rowTask = row => row && { senderAgentId: row.sender_agent_id, taskId: row.task_id,
  requirementFingerprint: row.requirement_fingerprint, projectKey: row.project_key,
  sessionID: row.session_id, status: row.status, summary: row.summary,
  submittedOutcomeUnknown: !!row.submitted_outcome_unknown, outcomeConfirmed: !!row.outcome_confirmed };

export function createTaskStore(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) invalid();
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS bridge_tasks (
        sender_agent_id TEXT NOT NULL, task_id TEXT NOT NULL, requirement_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('accepted','running','needs_approval','completed','failed')),
        summary TEXT NOT NULL, submitted_outcome_unknown INTEGER NOT NULL DEFAULT 0 CHECK(submitted_outcome_unknown IN (0,1)),
        project_key TEXT, session_id TEXT,
        outcome_confirmed INTEGER NOT NULL DEFAULT 1 CHECK(outcome_confirmed IN (0,1)),
        PRIMARY KEY(sender_agent_id,task_id)
      )`);
    // Additive migration for pre-project/session DBs. Legacy rows have no known project;
    // previously flagged failed rows have no confirmed remote outcome.
    const columns = new Set(db.prepare('PRAGMA table_info(bridge_tasks)').all().map(row => row.name));
    if (!columns.has('project_key')) db.exec('ALTER TABLE bridge_tasks ADD COLUMN project_key TEXT');
    if (!columns.has('session_id')) db.exec('ALTER TABLE bridge_tasks ADD COLUMN session_id TEXT');
    if (!columns.has('outcome_confirmed')) {
      db.exec(`ALTER TABLE bridge_tasks ADD COLUMN outcome_confirmed INTEGER NOT NULL DEFAULT 1
        CHECK(outcome_confirmed IN (0,1));
        UPDATE bridge_tasks SET outcome_confirmed=0 WHERE submitted_outcome_unknown=1 AND status!='completed'`);
    }
    if (db.prepare('PRAGMA synchronous').get().synchronous !== 2 ||
        db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) invalid();
  } catch (error) { db.close(); throw error; }
  const getTask = (senderAgentId, taskId) => {
    if (!validKey(senderAgentId, taskId)) invalid();
    return rowTask(db.prepare('SELECT * FROM bridge_tasks WHERE sender_agent_id=? AND task_id=?')
      .get(senderAgentId.toLowerCase(), taskId)) ?? null;
  };
  function registerTask({ senderAgentId, taskId, requirementFingerprint, summary = 'Accepted', projectKey = null }) {
    if (!validKey(senderAgentId, taskId) || typeof requirementFingerprint !== 'string' ||
        !HEX.test(requirementFingerprint) || typeof summary !== 'string' || !summary.trim() ||
        projectKey !== null && (typeof projectKey !== 'string' || !TOKEN.test(projectKey))) invalid();
    senderAgentId = senderAgentId.toLowerCase();
    // A single INSERT handles concurrent registrants without replacing an existing outcome.
    const inserted = db.prepare(`INSERT INTO bridge_tasks
      (sender_agent_id,task_id,requirement_fingerprint,status,summary,project_key) VALUES (?,?,?,'accepted',?,?)
      ON CONFLICT(sender_agent_id,task_id) DO NOTHING`).run(senderAgentId, taskId, requirementFingerprint, summary, projectKey);
    const task = getTask(senderAgentId, taskId);
    return task.requirementFingerprint !== requirementFingerprint ? { kind: 'conflict', task } :
      { kind: inserted.changes ? 'registered' : 'existing', task };
  }
  function recordStatus(senderAgentId, taskId, status, summary, { outcomeConfirmed } = {}) {
    if (!validKey(senderAgentId, taskId) || !STATUSES.includes(status) ||
        typeof summary !== 'string' || !summary.trim() ||
        outcomeConfirmed !== undefined && (typeof outcomeConfirmed !== 'boolean' ||
          !['completed', 'failed'].includes(status))) invalid();
    const current = getTask(senderAgentId, taskId);
    if (!current) return null;
    if (['completed', 'failed'].includes(current.status) && current.status !== status &&
        !(current.status === 'failed' && !current.outcomeConfirmed && status === 'completed' &&
          outcomeConfirmed === true)) invalid();
    // A confirmed terminal result cannot be made uncertain again.
    if (['completed', 'failed'].includes(current.status) && current.outcomeConfirmed &&
        outcomeConfirmed === false) invalid();
    // An unknown submission remains unconfirmed if subsequently marked locally failed.
    // A completed outcome is confirmed, even if submission was once uncertain.
    const confirmed = outcomeConfirmed === undefined ?
      (status === 'completed' || current.outcomeConfirmed ? 1 : 0) : Number(outcomeConfirmed);
    db.prepare('UPDATE bridge_tasks SET status=?,summary=?,outcome_confirmed=? WHERE sender_agent_id=? AND task_id=?')
      .run(status, summary, confirmed, senderAgentId.toLowerCase(), taskId);
    return getTask(senderAgentId, taskId);
  }
  function markSubmittedOutcomeUnknown(senderAgentId, taskId) {
    const task = getTask(senderAgentId, taskId);
    if (!task) return null;
    if (['completed', 'failed'].includes(task.status)) invalid();
    db.prepare('UPDATE bridge_tasks SET submitted_outcome_unknown=1,outcome_confirmed=0 WHERE sender_agent_id=? AND task_id=?')
      .run(senderAgentId.toLowerCase(), taskId);
    return getTask(senderAgentId, taskId);
  }
  function setSessionID(senderAgentId, taskId, sessionID) {
    if (typeof sessionID !== 'string' || !sessionID.trim() || sessionID.length > 256 ||
        /[\x00-\x1f\x7f]/.test(sessionID)) invalid();
    const task = getTask(senderAgentId, taskId);
    if (!task) return null;
    db.prepare('UPDATE bridge_tasks SET session_id=? WHERE sender_agent_id=? AND task_id=?')
      .run(sessionID, senderAgentId.toLowerCase(), taskId);
    return getTask(senderAgentId, taskId);
  }
  function listUnfinishedByProject(projectKey) {
    if (typeof projectKey !== 'string' || !TOKEN.test(projectKey)) invalid();
    return db.prepare(`SELECT * FROM bridge_tasks WHERE project_key=?
      AND (status NOT IN ('completed','failed') OR (status='failed' AND outcome_confirmed=0))
      ORDER BY sender_agent_id,task_id`).all(projectKey).map(rowTask);
  }
  const listUnassociatedUnfinished = () => db.prepare(`SELECT * FROM bridge_tasks WHERE project_key IS NULL
    AND (status NOT IN ('completed','failed') OR (status='failed' AND outcome_confirmed=0))
    ORDER BY sender_agent_id,task_id`).all().map(rowTask);
  const listSubmittedWithoutOutcome = () => db.prepare(`SELECT * FROM bridge_tasks
    WHERE submitted_outcome_unknown=1 AND status NOT IN ('completed','failed') ORDER BY sender_agent_id,task_id`)
    .all().map(rowTask);
  return Object.freeze({ registerTask, getTask, recordStatus, markSubmittedOutcomeUnknown,
    setSessionID, listUnfinishedByProject, listUnassociatedUnfinished,
    listSubmittedWithoutOutcome, close: () => db.close() });
}
