#!/usr/bin/env node

// Bounded non-root operator CLI for machine-local project registry
// management (issue #177).
//
// This module contains no registry policy of its own: every read and every
// mutation is delegated to the typed contract in
// `agent-runner-project-registry-store.mjs`, which is the same contract a
// later authenticated dashboard must call. The command surface here is the
// stable part -- `list`, `show`, `add`, `enable`, `disable`, `remove`,
// `set-default`, `validate` -- so a dashboard never needs a second
// JSON-writing path.
//
// Nothing in this command starts, stops, installs or alters a systemd unit,
// timer, scheduler or service, clones a repository, or performs any GitHub
// mutation.

import { pathToFileURL } from 'node:url';

import {
  ProjectRegistryManagementError,
  addProject,
  listProjects,
  removeProject,
  resolveOperatorActor,
  setDefaultProject,
  setProjectEnabled,
  showProject,
  validateRegistry,
} from './agent-runner-project-registry-store.mjs';

export const USAGE_ERROR_EXIT_CODE = 2;
export const FAILURE_EXIT_CODE = 1;

const VALUE_FLAGS = new Map([
  ['--registry', 'registry'],
  ['--project-id', 'projectId'],
  ['--repo', 'githubRepo'],
  ['--local-path', 'localRepoPath'],
  ['--display-name', 'displayName'],
  ['--config-path', 'configPath'],
]);

const BOOLEAN_FLAGS = new Map([
  ['--json', 'json'],
  ['--verbose', 'verbose'],
  ['--enable', 'enable'],
  ['--allow-missing-checkout', 'allowMissingCheckout'],
]);

// Only these keys of a management error's `details` are ever echoed: field
// name lists and the operator's own project id. Nothing path-, credential-
// or config-body-shaped can reach output through this allowlist.
const SAFE_DETAIL_KEYS = ['missing', 'invalid', 'projectId', 'rolledBack'];

export function usageText() {
  return [
    'Usage: agent-runner projects <subcommand> [options]',
    '',
    'Subcommands:',
    '  list                       list registered projects',
    '  show <project-id>          show one registered project',
    '  add --project-id <id> --repo <owner/name> --local-path <abs path>',
    '                             register a project (disabled unless --enable)',
    '  enable <project-id>        admit an already registered project',
    '  disable <project-id>       withdraw admission; deletes no config or state',
    '  remove <project-id>        withdraw admission and archive the config',
    '  set-default <project-id>   select the default project',
    '  validate                   validate the whole registry',
    '',
    'Options:',
    '  --registry <path>          registry file (default AGENT_RUNNER_PROJECT_REGISTRY',
    '                             or ~/.config/agent-runner/projects.json)',
    '  --json                     machine-readable bounded output',
    '  --verbose                  include canonical local paths (local CLI only)',
    '  --enable                   add: admit the project immediately',
    '  --allow-missing-checkout   add: register before the checkout exists',
    '  --display-name <name>      add: human-readable project name',
    '  --config-path <path>       add: explicit project config location',
    '',
    'add never clones a repository and no subcommand performs any GitHub',
    'mutation. remove is non-destructive: repository checkouts, worktrees,',
    'branches, SQLite state, credentials and evidence are never deleted.',
    '',
  ].join('\n');
}

export function parseProjectsArgs(argv = []) {
  const [subcommand, ...rest] = argv;
  const options = { json: false, verbose: false, enable: false, allowMissingCheckout: false };
  const positional = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (BOOLEAN_FLAGS.has(arg)) {
      options[BOOLEAN_FLAGS.get(arg)] = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} requires a value` };
      options[VALUE_FLAGS.get(arg)] = value;
      index += 1;
      continue;
    }
    const equals = arg.indexOf('=');
    if (arg.startsWith('--') && equals > 0) {
      const name = arg.slice(0, equals);
      const value = arg.slice(equals + 1);
      if (!VALUE_FLAGS.has(name)) return { error: `Unknown argument: ${name}` };
      if (!value) return { error: `${name} requires a value` };
      options[VALUE_FLAGS.get(name)] = value;
      continue;
    }
    if (arg.startsWith('-')) return { error: `Unknown argument: ${arg}` };
    positional.push(arg);
  }

  return { subcommand: subcommand ?? null, positional, options };
}

function safeDetails(details = {}) {
  const output = {};
  for (const key of SAFE_DETAIL_KEYS) {
    if (details[key] !== undefined) output[key] = details[key];
  }
  return output;
}

function writeJson(io, payload) {
  io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function failure(io, reason, { details = {}, message = null, verbose = false } = {}) {
  const payload = { ok: false, reason };
  const bounded = safeDetails(details);
  if (Object.keys(bounded).length > 0) payload.details = bounded;
  // Raw validator messages can embed absolute machine paths, so they are
  // only ever shown when the local operator explicitly asked for verbose.
  if (verbose && message) payload.message = message;
  io.stderr.write(`${JSON.stringify(payload)}\n`);
  return FAILURE_EXIT_CODE;
}

function usageError(io, reason) {
  io.stderr.write(`${JSON.stringify({ ok: false, reason })}\n`);
  return USAGE_ERROR_EXIT_CODE;
}

function projectLine(project) {
  const flags = [
    project.enabled ? 'enabled' : 'disabled',
    project.isDefault ? 'default' : null,
    project.configValid ? null : `config:${project.configReason}`,
    project.checkoutReady ? 'checkout:ready' : 'checkout:missing',
  ].filter(Boolean);
  return `  ${project.projectId ?? '<unreadable>'}\t${project.githubRepo ?? '-'}\t${flags.join(' ')}`;
}

function writeListText(io, view) {
  io.stdout.write(`registry: ${view.registryValid ? 'valid' : `invalid (${view.registryReason})`}\n`);
  io.stdout.write(`default project: ${view.defaultProjectId ?? '<none>'}\n`);
  if (view.projects.length === 0) io.stdout.write('  <no registered projects>\n');
  for (const project of view.projects) io.stdout.write(`${projectLine(project)}\n`);
}

function writeMutationText(io, result) {
  const state = result.changed ? 'applied' : 'no change';
  io.stdout.write(`${result.action}: ${state} for ${result.projectId ?? '<unknown>'} (${result.githubRepo ?? '-'})\n`);
  for (const [key, value] of Object.entries(result.details ?? {})) {
    io.stdout.write(`  ${key}: ${value}\n`);
  }
  io.stdout.write(`  registry digest: ${result.beforeDigest ?? '<none>'} -> ${result.afterDigest ?? '<none>'}\n`);
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  io = { stdout: process.stdout, stderr: process.stderr },
  deps = {},
) {
  const uid = typeof deps.getuid === 'function'
    ? deps.getuid()
    : (typeof process.getuid === 'function' ? process.getuid() : null);
  if (uid === 0) {
    // Registry management writes machine-local operator configuration; it
    // must never run with root authority.
    io.stderr.write(`${JSON.stringify({ ok: false, reason: 'root-not-permitted' })}\n`);
    return USAGE_ERROR_EXIT_CODE;
  }

  const parsed = parseProjectsArgs(argv);
  if (parsed.error) return usageError(io, parsed.error);

  const { subcommand, positional, options } = parsed;
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    io.stdout.write(usageText());
    return 0;
  }

  const registryPath = options.registry ?? null;
  const shared = { env, registryPath, deps: deps.storeDeps || {} };
  const actor = resolveOperatorActor(env);
  const store = {
    listProjects, showProject, validateRegistry, addProject, setProjectEnabled, setDefaultProject, removeProject,
    ...(deps.store || {}),
  };

  try {
    if (subcommand === 'list') {
      if (positional.length > 0) return usageError(io, `Unexpected argument: ${positional[0]}`);
      const view = store.listProjects({ ...shared, verbose: options.verbose });
      if (options.json) writeJson(io, { ok: true, ...view });
      else writeListText(io, view);
      return 0;
    }

    if (subcommand === 'show') {
      const projectId = options.projectId ?? positional[0];
      if (!projectId) return usageError(io, 'show requires a project id');
      if (positional.length > 1) return usageError(io, `Unexpected argument: ${positional[1]}`);
      const view = store.showProject({ ...shared, projectId, verbose: options.verbose });
      if (options.json) writeJson(io, { ok: true, ...view });
      else writeListText(io, { ...view, projects: [view.project] });
      return 0;
    }

    if (subcommand === 'validate') {
      if (positional.length > 0) return usageError(io, `Unexpected argument: ${positional[0]}`);
      const result = store.validateRegistry({ ...shared, verbose: options.verbose });
      if (options.json) writeJson(io, result);
      else io.stdout.write(`registry: ${result.ok ? 'valid' : `invalid (${result.reason})`}; projects=${result.projectCount} enabled=${result.enabledCount} default=${result.defaultProjectId ?? '<none>'}\n`);
      return result.ok ? 0 : FAILURE_EXIT_CODE;
    }

    if (subcommand === 'add') {
      if (positional.length > 0) return usageError(io, `Unexpected argument: ${positional[0]}`);
      const result = store.addProject({
        ...shared,
        projectId: options.projectId,
        githubRepo: options.githubRepo,
        localRepoPath: options.localRepoPath,
        displayName: options.displayName ?? null,
        configPath: options.configPath ?? null,
        enable: options.enable === true,
        allowMissingCheckout: options.allowMissingCheckout === true,
        actor,
        source: 'operator-cli',
      });
      if (options.json) writeJson(io, result);
      else writeMutationText(io, result);
      return 0;
    }

    if (subcommand === 'enable' || subcommand === 'disable') {
      const projectId = options.projectId ?? positional[0];
      if (!projectId) return usageError(io, `${subcommand} requires a project id`);
      if (positional.length > 1) return usageError(io, `Unexpected argument: ${positional[1]}`);
      const result = store.setProjectEnabled({
        ...shared, projectId, enabled: subcommand === 'enable', actor, source: 'operator-cli',
      });
      if (options.json) writeJson(io, result);
      else writeMutationText(io, result);
      return 0;
    }

    if (subcommand === 'set-default') {
      const projectId = options.projectId ?? positional[0];
      if (!projectId) return usageError(io, 'set-default requires a project id');
      if (positional.length > 1) return usageError(io, `Unexpected argument: ${positional[1]}`);
      const result = store.setDefaultProject({ ...shared, projectId, actor, source: 'operator-cli' });
      if (options.json) writeJson(io, result);
      else writeMutationText(io, result);
      return 0;
    }

    if (subcommand === 'remove') {
      const projectId = options.projectId ?? positional[0];
      if (!projectId) return usageError(io, 'remove requires a project id');
      if (positional.length > 1) return usageError(io, `Unexpected argument: ${positional[1]}`);
      const result = store.removeProject({ ...shared, projectId, actor, source: 'operator-cli' });
      if (options.json) writeJson(io, result);
      else writeMutationText(io, result);
      return 0;
    }
  } catch (error) {
    if (error instanceof ProjectRegistryManagementError) {
      return failure(io, error.code, {
        details: error.details,
        message: error.message,
        verbose: options.verbose,
      });
    }
    return failure(io, 'projects-command-error', { message: error?.message, verbose: options.verbose });
  }

  return usageError(io, `Unknown projects subcommand: ${subcommand}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write(`${JSON.stringify({ ok: false, reason: 'projects-command-internal-error' })}\n`);
    process.exitCode = 1;
  });
}
