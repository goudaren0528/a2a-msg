import { createHash } from 'node:crypto';
import { assertImSchema } from './schema.js';
import { ImError } from './contracts.js';
import { parseImConfig } from './config.js';
import { resolveImTimeGuard } from './clock.js';

const own = (value, keys) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)) &&
  Object.keys(value).length === keys.length;
const safe = value => typeof value === 'string' && value.length >= 1 && value.length <= 255 &&
  !/[\x00-\x1f\x7f]/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuidFromHash = digest => `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;

function bindingsInput(value) {
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw new ImError('INVALID_REQUEST');
  const seenMembers = new Set();
  const seenAgents = new Set();
  const result = value.map(item => {
    if (!own(item, ['legacyMember', 'agentId']) || !safe(item.legacyMember) || !safe(item.agentId) ||
        seenMembers.has(item.legacyMember) || seenAgents.has(item.agentId)) throw new ImError('INVALID_REQUEST');
    seenMembers.add(item.legacyMember);
    seenAgents.add(item.agentId);
    return { legacyMember: item.legacyMember, agentId: item.agentId };
  });
  return result.sort((a, b) => a.legacyMember < b.legacyMember ? -1 : a.legacyMember > b.legacyMember ? 1 :
    a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0);
}

function snapshot(db, bindings) {
  const member = db.prepare('SELECT name,revoked_at FROM members WHERE name=?');
  const agent = db.prepare('SELECT agent_id,status,revoked_at FROM im_agents WHERE agent_id=?');
  const byMember = db.prepare('SELECT legacy_member,agent_id,status,migration_run_id FROM im_legacy_bindings WHERE legacy_member=?');
  const byAgent = db.prepare('SELECT legacy_member,agent_id,status,migration_run_id FROM im_legacy_bindings WHERE agent_id=?');
  const states = bindings.map(({ legacyMember, agentId }) => {
    const m = member.get(legacyMember);
    const a = agent.get(agentId);
    const existingMember = byMember.get(legacyMember) ?? null;
    const existingAgent = byAgent.get(agentId) ?? null;
    return [legacyMember, agentId, m ? [m.name, m.revoked_at] : null,
      a ? [a.agent_id, a.status, a.revoked_at] : null,
      existingMember && [existingMember.legacy_member, existingMember.agent_id, existingMember.status, existingMember.migration_run_id],
      existingAgent && [existingAgent.legacy_member, existingAgent.agent_id, existingAgent.status, existingAgent.migration_run_id]];
  });
  return { states, sourceFingerprint: hash(['im-legacy-bindings-v1', states]) };
}

function validSnapshot(states) {
  if (states.some(([, , member, agent, existingMember, existingAgent]) =>
    !member || member[1] !== null || !agent || agent[1] !== 'active' || agent[2] !== null ||
    existingMember || existingAgent)) throw new ImError('IDEMPOTENCY_CONFLICT');
}

function requireAdmin(authorizeAdmin, context) {
  if (typeof authorizeAdmin !== 'function') throw new ImError('OPERATION_FORBIDDEN');
  let actor;
  try { actor = authorizeAdmin(context); } catch { throw new ImError('OPERATION_FORBIDDEN'); }
  // A boolean or a caller-supplied admin:true assertion is not a trusted identity.
  const actorId = typeof actor === 'string' ? actor : actor?.actorId;
  if (actor?.then || !safe(actorId) || actor === context || (typeof actor !== 'string' &&
      !own(actor, ['actorId']))) throw new ImError('OPERATION_FORBIDDEN');
  return actorId;
}

export function createImMigration({ db, clock = Date.now, timeGuard, authorizeAdmin } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof clock !== 'function') throw new ImError('INVALID_REQUEST');
  assertImSchema(db);
  const guard = resolveImTimeGuard(db, clock, timeGuard);
  const writeMode = db.prepare('SELECT write_mode FROM im_settings WHERE singleton=1');
  const authorized = context => requireAdmin(authorizeAdmin, context);
  function previewLegacyBindings(proposedBindings, adminContext) {
    authorized(adminContext);
    const bindings = bindingsInput(proposedBindings);
    const { states, sourceFingerprint } = snapshot(db, bindings);
    validSnapshot(states);
    return { previewId: uuidFromHash(sourceFingerprint), sourceFingerprint, proposedBindings: bindings };
  }
  function commitLegacyBindings(request, adminContext) {
    const actorId = authorized(adminContext);
    if (!own(request, ['previewId', 'sourceFingerprint', 'approvedBindings', 'approvalRef']) ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(request.previewId) ||
        !/^[0-9a-f]{64}$/.test(request.sourceFingerprint) || !safe(request.approvalRef)) throw new ImError('INVALID_REQUEST');
    const bindings = bindingsInput(request.approvedBindings);
    return guard.runWrite(() => {
      const { states, sourceFingerprint } = snapshot(db, bindings);
      if (sourceFingerprint !== request.sourceFingerprint || uuidFromHash(sourceFingerprint) !== request.previewId) {
        // Completed batches may be retried with the original approval, but not altered.
        const run = db.prepare('SELECT preview_hash,status,actor_id,created_at,completed_at FROM im_migration_runs WHERE run_id=?').get(request.previewId);
        const saved = db.prepare('SELECT legacy_member,agent_id,approval_ref,status FROM im_legacy_bindings WHERE migration_run_id=? ORDER BY legacy_member').all(request.previewId);
        if (run?.status === 'completed' && run.preview_hash === request.sourceFingerprint && run.actor_id === actorId &&
            saved.length === bindings.length && saved.every((row, index) => row.legacy_member === bindings[index].legacyMember &&
              row.agent_id === bindings[index].agentId && row.approval_ref === request.approvalRef && row.status === 'active')) {
          return { runId: request.previewId, status: 'completed', bindingCount: saved.length, completedAt: run.completed_at };
        }
        throw new ImError('IDEMPOTENCY_CONFLICT');
      }
      validSnapshot(states);
      const now = guard.current();
      db.prepare('INSERT INTO im_migration_runs(run_id,preview_hash,status,actor_id,created_at,completed_at) VALUES (?,?,?,?,?,?)')
        .run(request.previewId, sourceFingerprint, 'completed', actorId, now, now);
      const insert = db.prepare("INSERT INTO im_legacy_bindings(legacy_member,agent_id,approval_ref,migration_run_id,status,source) VALUES (?,?,?,?,'active','legacy_ip')");
      for (const binding of bindings) insert.run(binding.legacyMember, binding.agentId, request.approvalRef, request.previewId);
      db.prepare('INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json) VALUES (?,?,?,?,?,?)')
        .run('admin', actorId, 'legacy_bindings_committed', JSON.stringify(bindings.map(b => b.agentId)), now,
          JSON.stringify({ runId: request.previewId, bindingCount: bindings.length, source: 'legacy_ip' }));
      return { runId: request.previewId, status: 'completed', bindingCount: bindings.length, completedAt: now };
    });
  }
  function setImWriteMode(request, adminContext) {
    const actorId = authorized(adminContext);
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some(key => !['mode', 'reason', 'policy'].includes(key)) ||
        !['paused', 'enabled'].includes(request.mode) || !safe(request.reason)) throw new ImError('INVALID_REQUEST');
    if (request.mode === 'enabled') {
      if (!Object.hasOwn(request, 'policy')) throw new ImError('POLICY_NOT_CONFIGURED');
      const config = parseImConfig(request.policy);
      if (config.enabled !== true || config.writeMode !== 'enabled') throw new ImError('POLICY_NOT_CONFIGURED');
    } else if (Object.hasOwn(request, 'policy')) throw new ImError('INVALID_REQUEST');
    return guard.runWrite(() => {
      const now = guard.current();
      db.prepare('UPDATE im_settings SET write_mode=? WHERE singleton=1').run(request.mode);
      db.prepare('INSERT INTO im_audit(actor_kind,actor_id,action,target_ids_json,occurred_at,safe_details_json) VALUES (?,?,?,?,?,?)')
        .run('admin', actorId, 'im_write_mode_changed', '[]', now, JSON.stringify({ mode: request.mode, reason: request.reason }));
      return { mode: request.mode };
    });
  }
  function getWriteMode() {
    return guard.runRead(() => writeMode.get().write_mode);
  }
  return { previewLegacyBindings, commitLegacyBindings, setImWriteMode, getWriteMode };
}
