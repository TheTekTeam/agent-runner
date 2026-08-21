#!/usr/bin/env node

/**
 * #268: the bounded operator CLI for the event-driven management control plane.
 *
 * Every subcommand here is read-only except `mode`/`fence`, which change one
 * explicit, audited control-mode row. Nothing in this command starts, stops,
 * installs or alters a systemd unit, timer, scheduler or service; clones a
 * repository; performs a GitHub mutation; merges; closes an issue; deploys;
 * activates source; dispatches a worker; or touches the external scheduled
 * management tasks. Those boundaries are the point of the tool.
 *
 * Subcommands:
 *   status             bounded control-plane status for an operator or dashboard
 *   mode --set <mode>  explicitly and auditably set the control mode
 *   fence              shorthand for `mode --set fenced` (rollback step one)
 *   recover            generic due-event recovery (no management business logic)
 *   field-acceptance   evaluate the twenty bounded acceptance probes
 *   cutover            cutover-readiness gates and the ordered rollback plan
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MANAGEMENT_CONTROL_MODES,
  resolveManagementControlMode,
} from './agent-runner-management-control-mode.mjs';
import { ManagementControlStore } from './agent-runner-management-control-store.mjs';
import { ManagementEventStore } from './agent-runner-management-events.mjs';
import { buildFieldAcceptanceReport } from './agent-runner-management-field-acceptance.mjs';
import { buildCutoverReadiness, planManagementRollback } from './agent-runner-management-cutover.mjs';
import { recoverDueManagementWork } from './agent-runner-management-producers.mjs';
import {
  loadProjectRegistry,
  resolveProjectRegistryPath,
  stripProjectRegistryArgs,
} from './agent-runner-project-registry.mjs';

export const USAGE_ERROR_EXIT_CODE = 2;
export const FAILURE_EXIT_CODE = 1;

const DEFAULT_DB_PATH = join(homedir(), '.local', 'state', 'agent-runner', 'controller', 'controller.sqlite');

export const SUBCOMMANDS = Object.freeze(['status', 'mode', 'fence', 'recover', 'field-acceptance', 'cutover']);

export function usageText() {
  return [
    'Usage: agent-runner-management-control <subcommand> [options]',
    '',
    'Subcommands:',
    '  status                     bounded control-plane status',
    '  mode --set <mode>          set the control mode (disabled|shadow|active|fenced)',
    '  fence                      fence the event manager (rollback step one)',
    '  recover                    recover due/delayed events and expired leases',
    '  field-acceptance           evaluate the bounded field-acceptance probes',
    '  cutover                    cutover gates and the ordered rollback plan',
    '',
    'Options:',
    '  --db <path>                controller database (default: XDG state path)',
    '  --project-registry <path>  canonical project registry manifest',
    '  --scope <id>               control scope (default: global)',
    '  --actor <id>               operator identity, required for mode changes',
    '  --reason <text>            bounded reason, required for mode changes',
    '  --limit <n>                bounded list size for status output',
    '',
    'This command never enables, disables or edits the external scheduled',
    'management tasks, and never merges, closes, deploys or activates source.',
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

export function parseManagementControlOptions(argv = [], env = process.env) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    return Object.freeze({ subcommand: 'help' });
  }
  if (!SUBCOMMANDS.includes(subcommand)) throw new Error(`unknown subcommand: ${subcommand}`);
  const registryPath = resolveProjectRegistryPath(rest, env);
  const remaining = stripProjectRegistryArgs(rest);
  const limitRaw = optionValue(remaining, '--limit');
  const limit = limitRaw == null ? 20 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('--limit must be an integer from 1 to 200');
  return Object.freeze({
    subcommand,
    registryPath: registryPath ? resolve(registryPath) : null,
    dbPath: resolve(optionValue(remaining, '--db') || env.AGENT_RUNNER_CONTROLLER_DB || DEFAULT_DB_PATH),
    scope: optionValue(remaining, '--scope') || 'global',
    mode: optionValue(remaining, '--set'),
    actor: optionValue(remaining, '--actor'),
    reason: optionValue(remaining, '--reason'),
    limit,
  });
}

function openStores(options, registry) {
  const eventStore = new ManagementEventStore(options.dbPath, { registry });
  const controlStore = new ManagementControlStore(options.dbPath);
  return { eventStore, controlStore };
}

function statusReport({ eventStore, controlStore, options }) {
  const current = controlStore.getControlMode(options.scope);
  const resolved = resolveManagementControlMode({ mode: current.mode });
  const pending = eventStore.listEvents({ states: ['pending'], limit: options.limit });
  const claimed = eventStore.listEvents({ states: ['claimed'], limit: options.limit });
  const blocked = eventStore.listEvents({ states: ['blocked', 'dead-letter'], limit: options.limit });
  return {
    schemaVersion: 'agent-runner-management-control-status/v1',
    scope: options.scope,
    controlMode: current.mode,
    controlModeConfigured: current.configured,
    // The four operator questions, answered directly.
    managementRunning: resolved.ok && resolved.processing,
    mutationPermitted: resolved.ok && resolved.mutating,
    managerLock: controlStore.getManagerLock('manager-authority'),
    pendingEvents: pending.map((event) => ({
      eventId: event.eventId, eventType: event.eventType, projectId: event.projectId, notBefore: event.notBefore,
    })),
    claimedEvents: claimed.map((event) => ({ eventId: event.eventId, eventType: event.eventType, projectId: event.projectId })),
    blockedEvents: blocked.map((event) => ({ eventId: event.eventId, eventType: event.eventType, state: event.state, outcome: event.outcome })),
    projections: controlStore.listProjections({ limit: options.limit }),
    recentDecisions: controlStore.listDecisions({ limit: options.limit }),
    recentFindings: controlStore.listFindings({ limit: options.limit }),
    recentObservations: controlStore.listObservations({ limit: options.limit }),
    ownerAttentionRequired: controlStore.listProjections({ limit: options.limit })
      .some((entry) => entry.payload.ownerAttentionRequired === true),
  };
}

export function runManagementControlCommand(argv = [], env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  let options;
  try {
    options = parseManagementControlOptions(argv, env);
  } catch (error) {
    io.stderr.write(`${error.message}\n\n${usageText()}\n`);
    return USAGE_ERROR_EXIT_CODE;
  }
  if (options.subcommand === 'help') {
    io.stdout.write(`${usageText()}\n`);
    return 0;
  }

  if (options.subcommand === 'cutover') {
    // Pure reporting: needs no database and can never mutate anything.
    io.stdout.write(`${JSON.stringify({
      readiness: buildCutoverReadiness({}),
      rollback: planManagementRollback({}),
    }, null, 2)}\n`);
    return 0;
  }

  if (!options.registryPath) {
    io.stderr.write(`project registry is required\n\n${usageText()}\n`);
    return USAGE_ERROR_EXIT_CODE;
  }

  let stores = null;
  try {
    const registry = loadProjectRegistry({ registryPath: options.registryPath });
    stores = openStores(options, registry);
    const { eventStore, controlStore } = stores;

    switch (options.subcommand) {
      case 'status': {
        io.stdout.write(`${JSON.stringify(statusReport({ eventStore, controlStore, options }), null, 2)}\n`);
        return 0;
      }
      case 'mode':
      case 'fence': {
        const mode = options.subcommand === 'fence' ? 'fenced' : options.mode;
        if (!mode || !MANAGEMENT_CONTROL_MODES.includes(mode)) {
          io.stderr.write(`--set must be one of: ${MANAGEMENT_CONTROL_MODES.join(', ')}\n`);
          return USAGE_ERROR_EXIT_CODE;
        }
        if (!options.actor || !options.reason) {
          io.stderr.write('--actor and --reason are required: every control-mode change is explicit and audited\n');
          return USAGE_ERROR_EXIT_CODE;
        }
        const changed = controlStore.setControlMode({ scope: options.scope, mode, reason: options.reason, actor: options.actor });
        io.stdout.write(`${JSON.stringify({
          ...changed,
          externalScheduledTasksChanged: false,
        }, null, 2)}\n`);
        return 0;
      }
      case 'recover': {
        const recovered = recoverDueManagementWork({ store: eventStore, limit: options.limit });
        io.stdout.write(`${JSON.stringify({
          recovery: recovered.recovery,
          dueCount: recovered.due.length,
          due: recovered.due.map((event) => ({ eventId: event.eventId, eventType: event.eventType, projectId: event.projectId })),
        }, null, 2)}\n`);
        return 0;
      }
      case 'field-acceptance': {
        const report = buildFieldAcceptanceReport({ eventStore, controlStore, registry, scope: options.scope });
        io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        // A report that is merely un-evidenced is not a failure of the tool; a
        // probe that positively failed is.
        return report.failCount > 0 ? FAILURE_EXIT_CODE : 0;
      }
      default: {
        io.stderr.write(`unknown subcommand: ${options.subcommand}\n`);
        return USAGE_ERROR_EXIT_CODE;
      }
    }
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return FAILURE_EXIT_CODE;
  } finally {
    if (stores) {
      stores.eventStore.close();
      stores.controlStore.close();
    }
  }
}

/* c8 ignore start -- process entrypoint */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = runManagementControlCommand(process.argv.slice(2), process.env);
}
/* c8 ignore stop */
