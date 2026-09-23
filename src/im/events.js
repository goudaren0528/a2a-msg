import { ImError } from './contracts.js';

// Volatile hints only. No replay, payload, sequence, message ID or cursor is retained.
export function createImEvents({ validate, trustedTimers, heartbeatMs = 15000,
  idleMs = 120000, maxPerAgent = 2, maxSubscribers = 100 } = {}) {
  const timers = trustedTimers ?? { setTimeout, clearTimeout };
  if (typeof validate !== 'function' ||
      typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function' ||
      !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > 30000 ||
      !Number.isSafeInteger(idleMs) || idleMs < heartbeatMs || idleMs > 300000 ||
      !Number.isSafeInteger(maxPerAgent) || maxPerAgent < 1 || maxPerAgent > 10 ||
      !Number.isSafeInteger(maxSubscribers) || maxSubscribers < 1 || maxSubscribers > 1000)
    throw new ImError('POLICY_NOT_CONFIGURED');
  const subscribers = new Map();
  const queued = new Map();
  let closed = false;

  function subscribe(principal, res, peers) {
    if (closed) throw new ImError('IM_DISABLED');
    validate(principal, peers);
    const agentId = principal.agentId;
    const group = subscribers.get(agentId) ?? new Set();
    if (group.size >= maxPerAgent || [...subscribers.values()].reduce((n, set) => n + set.size, 0) >= maxSubscribers)
      throw new ImError('RATE_LIMITED');
    let heartbeat, idle, ended = false;
    const cleanup = () => {
      if (ended) return;
      ended = true;
      timers.clearTimeout(heartbeat);
      timers.clearTimeout(idle);
      group.delete(entry);
      if (!group.size) subscribers.delete(agentId);
      res.off('finish', cleanup);
      res.off('close', cleanup);
    };
    const stop = () => {
      if (ended) return;
      cleanup();
      if (!res.destroyed) res.destroy();
    };
    const valid = () => {
      try {
        validate(principal, peers);
        return true;
      } catch { stop(); return false; }
    };
    const write = chunk => {
      if (ended || !valid()) return;
      try { if (!res.write(chunk)) stop(); } catch { stop(); }
    };
    const tick = () => {
      if (ended) return;
      write(': heartbeat\n\n');
      if (!ended) {
        try { heartbeat = timers.setTimeout(tick, heartbeatMs); heartbeat.unref?.(); }
        catch { stop(); }
      }
    };
    const entry = { peers, write, stop };
    group.add(entry);
    subscribers.set(agentId, group);
    res.once('finish', cleanup);
    res.once('close', cleanup);
    try {
      idle = timers.setTimeout(stop, idleMs); idle.unref?.();
      heartbeat = timers.setTimeout(tick, heartbeatMs); heartbeat.unref?.();
    } catch (error) { stop(); throw error; }
    return Object.freeze({ write, stop });
  }

  function publish(agentId, peerId) {
    if (closed || !subscribers.has(agentId)) return;
    // Defer post-commit authorization/IO so slow subscribers cannot delay a send response.
    // One bounded pending hint per recipient; the hint has no durable semantics.
    if (queued.has(agentId)) return;
    try {
      const timer = timers.setTimeout(() => {
        queued.delete(agentId);
        if (closed) return;
        for (const entry of [...(subscribers.get(agentId) ?? [])])
          if (entry.peers.has(peerId)) entry.write('event: change\ndata: sync\n\n');
      }, 0);
      queued.set(agentId, timer);
      timer.unref?.();
    } catch { /* hints are expendable */ }
  }
  function close() {
    closed = true;
    for (const timer of queued.values()) timers.clearTimeout(timer);
    queued.clear();
    for (const group of [...subscribers.values()]) for (const entry of [...group]) entry.stop();
  }
  return Object.freeze({ subscribe, publish, close });
}
