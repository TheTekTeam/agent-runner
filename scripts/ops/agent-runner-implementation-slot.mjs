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

import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { acquireRecoverableCronLock, processIsAlive } from './agent-runner-cron-lock.mjs';

export const GLOBAL_LOCK_ENV = 'AGENT_RUNNER_IMPLEMENTATION_LOCK';

/**
 * Set by a process that already owns the global implementation slot, to the
 * pid owning it, immediately before spawning a descendant that will perform
 * the implementation. A descendant treats the slot as inherited only when
 * this names a still-live pid, so a stale value left exported in an operator
 * shell can never be mistaken for a held slot.
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
 * process's already-held slot. Never grants a slot on its own: the child
 * still verifies the declared pid is alive.
 */
export function markInheritedImplementationSlot(env = {}, pid = process.pid) {
  return { ...env, [SLOT_INHERITED_ENV]: String(pid) };
}

const NOOP_RELEASE = () => {};

/**
 * Acquire (or inherit) the one machine-global implementation slot.
 *
 * Fails closed in every ambiguous case: a declared inherited pid that is not
 * alive is a refusal, not a fallback to taking the lock, because a stale
 * declaration means the environment is misreporting who owns the slot.
 */
export function acquireImplementationSlot({
  env = process.env,
  acquireLock = acquireRecoverableCronLock,
  isAlive = processIsAlive,
} = {}) {
  const lockPath = resolveGlobalLockPath(env);
  const declared = String(env[SLOT_INHERITED_ENV] || '').trim();

  if (declared) {
    const pid = Number(declared);
    if (/^\d+$/.test(declared) && Number.isSafeInteger(pid) && pid > 0 && isAlive(pid)) {
      return Object.freeze({
        held: true, inherited: true, lockPath, failureReason: null, detail: null, release: NOOP_RELEASE,
      });
    }
    return Object.freeze({
      held: false,
      inherited: false,
      lockPath,
      failureReason: SLOT_INHERITANCE_STALE,
      detail: `declared implementation-slot owner ${declared} is not a live process`,
      release: NOOP_RELEASE,
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
