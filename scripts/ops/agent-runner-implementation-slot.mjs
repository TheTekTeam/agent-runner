#!/usr/bin/env node

// #51: write-capable implementation execution is protected by an exact lane
// lease rather than one machine-global execution mutex. Dell remains the sole
// scheduler/controller; this module protects worker execution from collisions.
//
// Compatibility is deliberately fail-closed: callers that do not provide an
// explicit lane continue to use the historical global implementation lock.
// Only the generic scheduler is allowed to assign independent lane identities.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import {
  acquireRecoverableCronLock,
  parseCronLock,
  processIsAlive,
} from './agent-runner-cron-lock.mjs';

export const GLOBAL_LOCK_ENV = 'AGENT_RUNNER_IMPLEMENTATION_LOCK';
export const IMPLEMENTATION_LANE_ENV = 'AGENT_RUNNER_IMPLEMENTATION_LANE';
export const IMPLEMENTATION_LANE_ROOT_ENV = 'AGENT_RUNNER_IMPLEMENTATION_LANE_ROOT';

/**
 * Set by a process that already owns an implementation lane, to the pid owning
 * that exact lane. Descendants independently verify lock ownership and process
 * ancestry before inheritance is accepted.
 */
export const SLOT_INHERITED_ENV = 'AGENT_RUNNER_IMPLEMENTATION_SLOT_PID';

export const SLOT_UNAVAILABLE = 'implementation-slot-unavailable';
export const SLOT_INHERITANCE_STALE = 'implementation-slot-inheritance-stale';
export const SLOT_INVALID_LANE = 'implementation-slot-invalid-lane';

export function resolveGlobalLockPath(env = process.env) {
  return env[GLOBAL_LOCK_ENV]
    || resolve(String(env.HOME || homedir()), '.local/state/agent-runner/implementation-recurrence.lock');
}

export function sanitizeImplementationLane(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.length > 180) return null;
  if (!/^[A-Za-z0-9._:#@/-]+$/.test(raw)) return null;
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

/**
 * Resolve the lock for one write-capable execution lane.
 *
 * No lane => historical global mutex (safe compatibility for direct/manual
 * callers). Explicit scheduler-assigned lane => independent recoverable lock.
 */
export function resolveImplementationLaneLockPath(env = process.env) {
  const declared = String(env[IMPLEMENTATION_LANE_ENV] || '').trim();
  if (!declared) return resolveGlobalLockPath(env);
  const lane = sanitizeImplementationLane(declared);
  if (!lane) return null;
  const root = env[IMPLEMENTATION_LANE_ROOT_ENV]
    || resolve(String(env.HOME || homedir()), '.local/state/agent-runner/implementation-lanes');
  return resolve(root, `${lane}.lock`);
}

/**
 * Stamp an about-to-be-spawned child's environment as running inside this
 * process's already-held exact lane. Never grants a lane on its own.
 */
export function markInheritedImplementationSlot(env = {}, pid = process.pid) {
  return { ...env, [SLOT_INHERITED_ENV]: String(pid) };
}

const NOOP_RELEASE = () => {};
const MAX_PROCESS_ANCESTRY_DEPTH = 128;

function defaultReadLockOwner(lockPath) {
  const parsed = parseCronLock(readFileSync(lockPath, 'utf8'));
  return parsed?.pid || null;
}

function defaultReadParentPid(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const boundary = stat.lastIndexOf(') ');
  if (boundary < 0) return null;
  const fields = stat.slice(boundary + 2).trim().split(/\s+/);
  const parent = Number(fields[1]);
  return Number.isSafeInteger(parent) && parent > 0 ? parent : null;
}

export function processDescendsFromOwner({
  ownerPid,
  currentPid = process.pid,
  readParentPid = defaultReadParentPid,
} = {}) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0
    || !Number.isSafeInteger(currentPid) || currentPid <= 0) return false;

  let pid = currentPid;
  const visited = new Set();
  for (let depth = 0; depth < MAX_PROCESS_ANCESTRY_DEPTH; depth += 1) {
    if (pid === ownerPid) return true;
    if (pid <= 1 || visited.has(pid)) return false;
    visited.add(pid);
    try {
      const parent = readParentPid(pid);
      if (!Number.isSafeInteger(parent) || parent <= 0 || parent === pid) return false;
      pid = parent;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Acquire (or inherit) one exact implementation lane.
 *
 * Explicit independent lanes may coexist. The same lane cannot. Direct callers
 * without a scheduler-assigned lane retain the historical global mutex.
 */
export function acquireImplementationSlot({
  env = process.env,
  acquireLock = acquireRecoverableCronLock,
  isAlive = processIsAlive,
  readLockOwner = defaultReadLockOwner,
  currentPid = process.pid,
  readParentPid = defaultReadParentPid,
} = {}) {
  const lockPath = resolveImplementationLaneLockPath(env);
  if (!lockPath) {
    return Object.freeze({
      held: false,
      inherited: false,
      lockPath: null,
      lane: String(env[IMPLEMENTATION_LANE_ENV] || ''),
      failureReason: SLOT_INVALID_LANE,
      detail: 'implementation lane identity is invalid',
      release: NOOP_RELEASE,
    });
  }

  const lane = String(env[IMPLEMENTATION_LANE_ENV] || '').trim() || 'legacy-global';
  const declared = String(env[SLOT_INHERITED_ENV] || '').trim();

  if (declared) {
    const pid = Number(declared);
    if (!/^\d+$/.test(declared) || !Number.isSafeInteger(pid) || pid <= 0 || !isAlive(pid)) {
      return Object.freeze({
        held: false, inherited: false, lockPath, lane,
        failureReason: SLOT_INHERITANCE_STALE,
        detail: `declared implementation-slot owner ${declared} is not a live process`,
        release: NOOP_RELEASE,
      });
    }

    let observedOwner = null;
    try {
      observedOwner = readLockOwner(lockPath);
    } catch {
      observedOwner = null;
    }
    if (observedOwner !== pid) {
      return Object.freeze({
        held: false, inherited: false, lockPath, lane,
        failureReason: SLOT_INHERITANCE_STALE,
        detail: `declared implementation-slot owner ${declared} does not own the exact lane lock`,
        release: NOOP_RELEASE,
      });
    }

    if (!processDescendsFromOwner({ ownerPid: pid, currentPid, readParentPid })) {
      return Object.freeze({
        held: false, inherited: false, lockPath, lane,
        failureReason: SLOT_INHERITANCE_STALE,
        detail: `current process ${currentPid} is not a descendant of implementation-slot owner ${declared}`,
        release: NOOP_RELEASE,
      });
    }

    return Object.freeze({
      held: true, inherited: true, lockPath, lane,
      failureReason: null, detail: null, release: NOOP_RELEASE,
    });
  }

  try {
    const release = acquireLock(lockPath);
    return Object.freeze({
      held: true, inherited: false, lockPath, lane,
      failureReason: null, detail: null, release,
    });
  } catch (error) {
    return Object.freeze({
      held: false, inherited: false, lockPath, lane,
      failureReason: SLOT_UNAVAILABLE,
      detail: String(error?.message || error),
      release: NOOP_RELEASE,
    });
  }
}
