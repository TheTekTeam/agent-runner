#!/usr/bin/env node

// Top-level dispatcher for the consolidated operator CLI (issue #67,
// required by #5 finding F10). This file contains no scheduler, admission,
// repair, state or dashboard policy of its own -- it only routes to the
// four already-implemented command modules:
//   doctor        -> agent-runner-operator-doctor.mjs
//   queue explain -> agent-runner-queue-explain.mjs
//   queue repair  -> agent-runner-queue-repair.mjs (existing canonical
//                    deterministic incident-repair implementation, called
//                    verbatim; dry-run remains its own default)
//   status        -> agent-runner-operator-status.mjs
//   projects      -> agent-runner-projects-command.mjs (issue #177 project
//                    registry management; read-only by default, every
//                    mutation is lock-protected, validated and rollback-safe
//                    inside agent-runner-project-registry-store.mjs)

import { pathToFileURL } from 'node:url';

import { main as doctorMain } from './agent-runner-operator-doctor.mjs';
import { main as explainMain } from './agent-runner-queue-explain.mjs';
import { main as projectsMain } from './agent-runner-projects-command.mjs';
import { main as repairMain } from './agent-runner-queue-repair.mjs';
import { main as statusMain } from './agent-runner-operator-status.mjs';

export const USAGE_ERROR_EXIT_CODE = 2;

export function usageText() {
  return [
    'Usage: agent-runner <command> [options]',
    '',
    'Commands:',
    '  doctor --project <id>',
    '  queue explain --project <id>',
    '  queue repair --incident <id> [--dry-run|--execute]',
    '  status --json',
    '  projects <list|show|add|enable|disable|remove|set-default|validate>',
    '',
    'All commands accept --config <path> to select a project config file.',
    'doctor, queue explain and status are read-only. queue repair is',
    'dry-run by default; mutation requires the explicit --execute flag.',
    'projects list/show/validate are read-only; projects add/enable/disable/',
    'remove/set-default mutate the machine-local registry atomically and',
    'never delete a checkout, worktree, branch, state database or evidence.',
    '',
  ].join('\n');
}

function usageError(io, reason) {
  io.stderr.write(`${JSON.stringify({ ok: false, reason })}\n`);
  return USAGE_ERROR_EXIT_CODE;
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  io = { stdout: process.stdout, stderr: process.stderr },
  dependencies = {},
) {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h') {
    io.stdout.write(usageText());
    return 0;
  }

  try {
    if (command === 'doctor') {
      return await (dependencies.doctorMain || doctorMain)(rest, env, io);
    }

    if (command === 'status') {
      return await (dependencies.statusMain || statusMain)(rest, env, io);
    }

    if (command === 'projects') {
      return await (dependencies.projectsMain || projectsMain)(rest, env, io, dependencies.projectsDependencies || {});
    }

    if (command === 'queue') {
      const [subcommand, ...queueRest] = rest;
      if (subcommand === 'explain') {
        return await (dependencies.explainMain || explainMain)(queueRest, env, io);
      }
      if (subcommand === 'repair') {
        try {
          return await (dependencies.repairMain || repairMain)(queueRest, env, dependencies.repairDependencies || {});
        } catch {
          // agent-runner-queue-repair.mjs's argument parser throws a raw
          // Error on malformed/unsupported arguments (e.g. an unsupported
          // --incident value) before its own try/finally begins. Every
          // other failure path inside that module already returns a typed
          // exit code (0/1/2) without throwing, so anything reaching here
          // is a usage-shaped problem -- never forward the raw exception
          // text.
          return usageError(io, 'queue-repair-invocation-error');
        }
      }
      return usageError(io, subcommand ? `Unknown queue subcommand: ${subcommand}` : 'queue subcommand is required');
    }
  } catch {
    // Backstop: every dispatched module's own run()/main() already fails
    // closed on a malformed --config (see agent-runner-operator-doctor.mjs
    // etc.), but a future change to any of them must not be able to leak a
    // raw stack trace or local path through this dispatcher.
    return usageError(io, 'command-invocation-error');
  }

  return usageError(io, `Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write(`${JSON.stringify({ ok: false, reason: 'cli-internal-error' })}\n`);
    process.exitCode = 1;
  });
}
