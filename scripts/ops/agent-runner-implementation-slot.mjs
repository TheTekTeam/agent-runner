#!/usr/bin/env node

// #242: one machine-global implementation slot for every write-capable
// implementation launch, not only for the systemd recurrence tick.
//
// `agent-runner-implementation-recurrence.mjs` already takes this exact lock
// before it selects and invokes a project. A *direct* operator invocation of
// `claude-runner.mjs` -- including the `--pr <n> --execute` continuation
// wired by this issue -- previously took no lock at all, so the "one global
// implementation slot" rule depended entirely on an operator remembering to
// hold the recurrence lock by hand. That is a practical bypass: a direct
// continuation could run a second write-capable worker while the
// timer-driven recurrence was already running one.
//
// This module closes the gap without adding a second scheduler or a second
// lock system. It reuses the same canonical lock path and the same
// `acquireRecoverableCronLock` primitive, and it additionally understands
// *inheritance*, so the existing
//   recurrence -> bin/run-project.sh -> pinned cron -> claude-runner.mjs
// chain (whose ancestor already owns the slot) can never deadlock against
// itself. The lock is still taken in exactly one place per process tree.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import {
  acquireRecoverableCronLock,
  parseCronLock,
  processIsAlive,
} from './agent-runner-cron-lock.mjs';

export const GLOBAL_LOCK_ENV = 'AGENT_RUNNER_IMPLEMENTATION_LOCK';

/**
 * Set by a process that already owns the global implementation slot, to the
 * pid owning it, immediately before spawning a descendant that will perform
 * the implementation. This marker is only a claim: descendants independently
 * verify that the canonical lock names the same owner and that their process
 * ancestry actually descends from that owner before inheritance is accepted.
 */
export const SLOT_INHERITED_ENV = 'AGENT_RUNNER_IMPLEMENTATION_SLOT_PID';

export const SLOT_UNAVAILABLE = 'implementation-slot-unavailable';
export const SLOT_INHERITANCE_STALE = 'implementation-slot-inheritance-stale';

export function resolveGlobalLockPath(env = process.env) {
  return env[GLOBAL_LOCK_ENV]
    || resolve(String(env.HOME || homedir()), '.local/state/agent-runner/implementation-recurrence.lock');
}

/**
 * Stamp an about-to-be-spawned child's environment as running inside this
 * process's already-held slot. Never grants a slot on its own: the descendant
 * must prove this pid owns the canonical lock and is in its ancestor chain.
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

/**
 * Linux production ancestry reader. `/proc/<pid>/stat` has the command name
 * in parentheses (which may itself contain spaces), followed by state and
 * parent pid. Parsing from the final `) ` boundary avoids splitting comm.
 */
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
 * Acquire (or inherit) the one machine-global implementation slot.
 *
 * Fails closed in every ambiguous case. A declared inherited pid is accepted
 * only when all three facts agree at this instant:
 *   1. the declared owner is live;
 *   2. the canonical lock file names that exact pid as its owner; and
 *   3. the current process is that owner or one of its descendants.
 *
 * This prevents an operator/caller from exporting an arbitrary live pid to
 * bypass the global lock while preserving deadlock-free recurrence children.
 */
export function acquireImplementationSlot({
  env = process.env,
  acquireLock = acquireRecoverableCronLock,
  isAlive = processIsAlive,
  readLockOwner = defaultReadLockOwner,
  currentPid = process.pid,
  readParentPid = defaultReadParentPid,
} = {}) {
  const lockPath = resolveGlobalLockPath(env);
  const declared = String(env[SLOT_INHERITED_ENV] || '').trim();

  if (declared) {
    const pid = Number(declared);
    if (!/^\d+$/.test(declared) || !Number.isSafeInteger(pid) || pid <= 0 || !isAlive(pid)) {
      return Object.freeze({
        held: false,
        inherited: false,
        lockPath,
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
        held: false,
        inherited: false,
        lockPath,
        failureReason: SLOT_INHERITANCE_STALE,
        detail: `declared implementation-slot owner ${declared} does not own the canonical lock`,
        release: NOOP_RELEASE,
      });
    }

    if (!processDescendsFromOwner({ ownerPid: pid, currentPid, readParentPid })) {
      return Object.freeze({
        held: false,
        inherited: false,
        lockPath,
        failureReason: SLOT_INHERITANCE_STALE,
        detail: `current process ${currentPid} is not a descendant of implementation-slot owner ${declared}`,
        release: NOOP_RELEASE,
      });
    }

    return Object.freeze({
      held: true, inherited: true, lockPath, failureReason: null, detail: null, release: NOOP_RELEASE,
    });
  }

  try {
    const release = acquireLock(lockPath);
    return Object.freeze({
      held: true, inherited: false, lockPath, failureReason: null, detail: null, release,
    });
  } catch (error) {
    return Object.freeze({
      held: false,
      inherited: false,
      lockPath,
      failureReason: SLOT_UNAVAILABLE,
      detail: String(error?.message || error),
      release: NOOP_RELEASE,
    });
  }
}
