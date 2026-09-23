import { ImError } from './contracts.js';
import { createImClockGuard } from './clock-guard.js';

// Trusted in-process injection only; never accept a guard from HTTP input.
export function resolveImTimeGuard(db, clock, timeGuard) {
  const expected = createImClockGuard({ db, clock });
  if (timeGuard !== undefined && timeGuard !== expected) throw new ImError('INVALID_REQUEST');
  return expected;
}

export function readImClock(db, clock = Date.now) {
  return resolveImTimeGuard(db, clock).current();
}

export function observeImClock(db, clock = Date.now) {
  return readImClock(db, clock);
}
