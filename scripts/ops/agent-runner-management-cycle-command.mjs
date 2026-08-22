#!/usr/bin/env node

/**
 * #268: the bounded **production** management controller entrypoint.
 *
 * This is the shipped path that actually runs the event-driven control plane on
 * Dell. One invocation performs, in order:
 *
 *   1. load the canonical project registry and the registered manager profiles;
 *   2. open the existing controller SQLite database on one shared connection;
 *   3. resolve the persisted control mode, failing closed on anything unknown;
 *   4. observe material transitions from live bounded evidence and durably
 *      enqueue any whose semantic fingerprint moved;
 *   5. run generic recovery (expired leases, lost wakes, delayed eligibility);
 *   6. drain due events through `runManagementControlCycle()` with the real
 *      production evidence collectors;
 *   7. emit bounded operational output and exit.
 *
 * It is not a scheduler. It has no timer, no loop and no sleep: it processes
 * what is due now and returns, exiting cleanly when there is no work. Something
 * generic and already accepted decides when to call it -- the existing Dell
 * event-polling unit, or the best-effort wake a producer fires.
 *
 * It fails closed. A malformed registry, an unknown mode, a missing management
 * plan or a collector failure stops that project rather than guessing, and one
 * project's failure never aborts another's.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { openManagementStores } from './agent-runner-management-control-store.mjs';
import { resolveManagementControlMode } from './agent-runner-management-control-mode.mjs';
import { runManagementControlCycle } from './agent-runner-management-controller.mjs';
import { createProductionManagementPorts } from './agent-runner-management-collectors.mjs';
import { createDellManagementAdapters } from './agent-runner-management-dell-adapters.mjs';
import { observeMaterialTransitions } from './agent-runner-management-observer.mjs';
import { produceManagementEvents, recoverDueManagementWork } from './agent-runner-management-producers.mjs';
import { resolveManagementWake } from './agent-runner-management-wake.mjs';
import { resolveRegisteredManagementPlan } from './agent-runner-management-plan-registry.mjs';
import {
  loadManagerProfileRegistry,
  resolveRegisteredManagerProfile,
} from './agent-runner-manager-profile-registry.mjs';
import {
  loadProjectRegistry,
  resolveProjectRegistryPath,
  stripProjectRegistryArgs,
} from './agent-runner-project-registry.mjs';

export const MANAGEMENT_CYCLE_SCHEMA_VERSION = 'agent-runner-management-cycle/v1';
export const USAGE_ERROR_EXIT_CODE = 2;
export const FAILURE_EXIT_CODE = 1;

const DEFAULT_DB_PATH = join(homedir(), '.local', 'state', 'agent-runner', 'controller', 'controller.sqlite');

export function usageText() {
  return [
    'Usage: agent-runner-management-cycle [options]',
    '',
    'Observe material transitions, recover due events and drain the management',
    'event graph once. Exits cleanly when there is no work.',
    '',
    'Options:',
    '  --project-registry <path>  canonical project registry manifest (required)',
    '  --db <path>                controller database (default: XDG state path)',
    '  --scope <id>               control scope (default: global)',
    '  --controller-id <id>       bounded controller identity (default: hostname-derived)',
    '  --max-events <n>           bounded events to drain this cycle (default: 10)',
    '  --expected-source-sha <s>  the accepted source revision to compare against',
    '  --observe-only             observe and enqueue, but drain nothing',
    '  --no-observe               drain only, observing no new transitions',
    '',
    'This command never merges, closes an issue, deploys, activates source,',
    'dispatches a worker, or enables/disables any timer, service or external',
    'scheduled management task.',
  ].join('\n');
}

function optionValue(argv, name) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === name) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
      return value;
    }
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return null;
}

export function parseManagementCycleOptions(argv = [], env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) return Object.freeze({ help: true });
  const registryPath = resolveProjectRegistryPath(argv, env);
  const remaining = stripProjectRegistryArgs(argv);
  const maxRaw = optionValue(remaining, '--max-events');
  const maxEvents = maxRaw == null ? 10 : Number(maxRaw);
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 100) {
    throw new Error('--max-events must be an integer from 1 to 100');
  }
  const expectedSourceSha = optionValue(remaining, '--expected-source-sha');
  if (expectedSourceSha != null && !/^[0-9a-f]{40}$/.test(expectedSourceSha)) {
    throw new Error('--expected-source-sha must be an exact 40-character lowercase commit SHA');
  }
  return Object.freeze({
    help: false,
    registryPath: registryPath ? resolve(registryPath) : null,
    dbPath: resolve(optionValue(remaining, '--db') || env.AGENT_RUNNER_CONTROLLER_DB || DEFAULT_DB_PATH),
    scope: optionValue(remaining, '--scope') || 'global',
    controllerId: optionValue(remaining, '--controller-id') || null,
    maxEvents,
    expectedSourceSha,
    observe: !remaining.includes('--no-observe'),
    drain: !remaining.includes('--observe-only'),
  });
}

/**
 * A bounded controller identity plus a fresh per-run claim identity.
 *
 * The controller id is stable and machine-safe so an operator can recognise it;
 * the claim token is generated per run and never persisted in raw form -- the
 * ledger stores only its hash, and so does the manager lock.
 */
export function resolveControllerIdentity({ controllerId = null, env = process.env, uuid = randomUUID } = {}) {
  const configured = controllerId || env.AGENT_RUNNER_MANAGEMENT_CONTROLLER_ID || null;
  const base = configured && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/.test(configured)
    ? configured
    : 'agent-runner-management-controller';
  return Object.freeze({ controllerId: base, claimToken: `mgmt-${uuid().replace(/-/g, '')}` });
}

/**
 * Observe one registered project and durably enqueue anything whose semantic
 * evidence moved. Returns a bounded per-project summary; a project that cannot
 * be observed is reported and skipped, never allowed to stop the cycle.
 */
function observeProject({ project, profileRegistry, planEntries, adapters, stores, wake, expectedSourceSha, now }) {
  let profile;
  try {
    profile = resolveRegisteredManagerProfile({
      projectId: project.projectId,
      repository: project.githubRepo,
      ...(profileRegistry ? { registry: profileRegistry } : {}),
    });
  } catch (error) {
    return { projectId: project.projectId, observed: false, reason: 'profile-unavailable', message: error.message };
  }
  if (!profile.enabled) return { projectId: project.projectId, observed: false, reason: 'profile-disabled' };

  // A project with no registered management plan is simply not planned yet.
  // Producing events for it would wake a role that has nothing to reconcile.
  let plan = null;
  try {
    plan = resolveRegisteredManagementPlan({
      projectId: project.projectId, profile, ...(planEntries ? { entries: planEntries } : {}),
    });
  } catch (error) {
    return { projectId: project.projectId, observed: false, reason: 'plan-invalid', message: error.message };
  }
  if (!plan) return { projectId: project.projectId, observed: false, reason: 'no-management-plan' };

  try {
    const transitions = observeMaterialTransitions({
      project, profile, adapters, controlStore: stores.controlStore, expectedSourceSha,
    });
    const produced = produceManagementEvents({
      eventStore: stores.eventStore,
      controlStore: stores.controlStore,
      transitions,
      wake,
      now,
    });
    return {
      projectId: project.projectId,
      observed: true,
      transitions: transitions.length,
      enqueued: produced.insertedCount,
      coalesced: produced.coalescedCount,
      suppressed: produced.suppressedCount,
    };
  } catch (error) {
    return { projectId: project.projectId, observed: false, reason: 'observation-failed', message: error.message };
  }
}

/**
 * Run one bounded production management cycle.
 *
 * Exported separately from the CLI wrapper so the end-to-end tests drive the
 * real production path with bounded fake adapters rather than a parallel
 * test-only implementation.
 */
export async function runManagementCycleCommand({
  options,
  registry,
  profileRegistry = null,
  planEntries = null,
  adapters,
  wake = null,
  now = () => new Date().toISOString(),
  uuid = randomUUID,
} = {}) {
  const stores = openManagementStores(options.dbPath, { registry, now });
  try {
    const configuredMode = stores.controlStore.getControlMode(options.scope).mode;
    const resolvedMode = resolveManagementControlMode({ mode: configuredMode });
    if (!resolvedMode.ok || !resolvedMode.processing) {
      // Fail closed and cheaply: nothing is observed, enqueued or drained.
      return Object.freeze({
        schemaVersion: MANAGEMENT_CYCLE_SCHEMA_VERSION,
        ran: false,
        mode: resolvedMode.mode,
        refusal: resolvedMode.ok ? `mode-${resolvedMode.mode}` : resolvedMode.reason,
        observations: Object.freeze([]),
        recovery: null,
        cycle: null,
      });
    }

    const identity = resolveControllerIdentity({ controllerId: options.controllerId, uuid });
    const timestamp = typeof now === 'function' ? now() : now;
    const wakeFn = wake ? wake.wake : null;

    // ---- 1. observe material transitions and durably enqueue what moved ----
    const observations = [];
    if (options.observe) {
      for (const project of registry.projects) {
        observations.push(observeProject({
          project, profileRegistry, planEntries, adapters, stores,
          wake: wakeFn, expectedSourceSha: options.expectedSourceSha, now: timestamp,
        }));
      }
    }

    // ---- 2. generic recovery: lost wakes, expired leases, delayed eligibility ----
    const recovery = recoverDueManagementWork({ store: stores.eventStore, now: timestamp, limit: 100 });

    // ---- 3. drain due events through the real collectors ----
    let cycle = null;
    if (options.drain) {
      const resolvePorts = createProductionManagementPorts({
        adapters,
        controlStore: stores.controlStore,
        ...(profileRegistry ? { profileRegistry } : {}),
        ...(planEntries ? { planEntries } : {}),
        producerId: identity.controllerId,
        expectedSourceSha: options.expectedSourceSha,
        now,
      });
      cycle = await runManagementControlCycle({
        eventStore: stores.eventStore,
        controlStore: stores.controlStore,
        registry,
        scope: options.scope,
        controllerId: identity.controllerId,
        claimToken: identity.claimToken,
        resolvePorts,
        now,
        wake: wakeFn,
        maxEvents: options.maxEvents,
      });
    }

    return Object.freeze({
      schemaVersion: MANAGEMENT_CYCLE_SCHEMA_VERSION,
      ran: true,
      mode: resolvedMode.mode,
      refusal: null,
      controllerId: identity.controllerId,
      wakeEnabled: Boolean(wake?.enabled),
      observations: Object.freeze(observations),
      recovery: Object.freeze({ ...recovery.recovery, dueCount: recovery.due.length }),
      cycle,
    });
  } finally {
    stores.close();
  }
}

export async function main(argv = process.argv.slice(2), env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  let options;
  try {
    options = parseManagementCycleOptions(argv, env);
  } catch (error) {
    io.stderr.write(`${error.message}\n\n${usageText()}\n`);
    return USAGE_ERROR_EXIT_CODE;
  }
  if (options.help) {
    io.stdout.write(`${usageText()}\n`);
    return 0;
  }
  if (!options.registryPath) {
    io.stderr.write(`project registry is required\n\n${usageText()}\n`);
    return USAGE_ERROR_EXIT_CODE;
  }
  try {
    const registry = loadProjectRegistry({ registryPath: options.registryPath });
    const summary = await runManagementCycleCommand({
      options,
      registry,
      profileRegistry: loadManagerProfileRegistry({ projectRegistry: registry }),
      adapters: createDellManagementAdapters({ env }),
      wake: resolveManagementWake({ env }),
    });
    io.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return FAILURE_EXIT_CODE;
  }
}

/* c8 ignore start -- process entrypoint */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; });
}
/* c8 ignore stop */
