#!/usr/bin/env node

/**
 * #268: the real Dell wake.
 *
 * When a material transition durably enqueues a management event, the
 * controller should start draining it within seconds rather than at the next
 * generic recovery pass. That is all this module does: it best-effort nudges
 * the **existing generic** Agent Runner unit that already runs the controller
 * cycle on Dell.
 *
 * What this deliberately is not:
 *
 *  - It is not a scheduler. It starts an existing oneshot unit on demand; it
 *    creates no timer, installs no unit and decides nothing about when work
 *    should next happen on its own.
 *  - It is not a second manager. It carries no project, issue or decision --
 *    only "there is due work" -- and the unit it starts re-reads authoritative
 *    state like any other controller run.
 *  - It is not required for correctness. The event is already durable before a
 *    wake is ever attempted, so a failed, disabled or absent wake degrades to
 *    generic recovery latency and never loses work. Every failure path here
 *    therefore returns quietly instead of throwing.
 *
 * It is off unless explicitly configured, so a fresh checkout, a test run or a
 * developer machine can never poke a service by accident.
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';

export const MANAGEMENT_WAKE_SCHEMA_VERSION = 'agent-runner-management-wake/v1';

/** The environment variable that names the generic unit to nudge. */
export const MANAGEMENT_WAKE_UNIT_ENV = 'AGENT_RUNNER_MANAGEMENT_WAKE_UNIT';

/**
 * The only units a wake may start. Each is an existing, generic, project- and
 * role-neutral Agent Runner unit. A unit outside this list is refused, so the
 * wake can never be pointed at an arbitrary service.
 */
export const ALLOWED_WAKE_UNITS = Object.freeze([
  'agent-runner-event-polling.service',
  'agent-runner-implementation.service',
]);

const DEFAULT_TIMEOUT_MS = 5_000;

/** A wake that does nothing. The durable event plus generic recovery still advances work. */
export function createNoopManagementWake() {
  return Object.freeze({
    enabled: false,
    unit: null,
    wake: () => Object.freeze({ attempted: false, ok: true, reason: 'wake-disabled' }),
  });
}

/**
 * Build the production wake.
 *
 * Returns a disabled wake -- never an error -- when nothing is configured or the
 * configured unit is not allowlisted, because a control plane that cannot nudge
 * a service must still run.
 */
export function createSystemdManagementWake({
  env = process.env,
  spawn = defaultSpawnSync,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const unit = typeof env[MANAGEMENT_WAKE_UNIT_ENV] === 'string' ? env[MANAGEMENT_WAKE_UNIT_ENV].trim() : '';
  if (!unit) return createNoopManagementWake();
  if (!ALLOWED_WAKE_UNITS.includes(unit)) return createNoopManagementWake();
  if (typeof spawn !== 'function') return createNoopManagementWake();

  const bounded = Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 30_000 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  return Object.freeze({
    enabled: true,
    unit,
    /**
     * `--no-block` returns immediately: the wake must never hold up the
     * producer that already persisted the event.
     */
    wake: () => {
      try {
        const result = spawn('systemctl', ['--user', 'start', '--no-block', unit], {
          encoding: 'utf8',
          stdio: ['ignore', 'ignore', 'ignore'],
          timeout: bounded,
        });
        const ok = result && result.status === 0;
        return Object.freeze({ attempted: true, ok: Boolean(ok), reason: ok ? null : 'wake-start-failed' });
      } catch {
        // A missing systemctl, a denied start or a timeout are all the same to
        // the control plane: the event is durable and recovery will find it.
        return Object.freeze({ attempted: true, ok: false, reason: 'wake-unavailable' });
      }
    },
  });
}

/**
 * Resolve the wake for a production run: the configured systemd wake when one
 * is available, otherwise an explicit no-op.
 */
export function resolveManagementWake({ env = process.env, spawn = defaultSpawnSync } = {}) {
  return createSystemdManagementWake({ env, spawn });
}
