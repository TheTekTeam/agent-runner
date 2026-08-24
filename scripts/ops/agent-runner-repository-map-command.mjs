#!/usr/bin/env node

import { loadAgentRunnerConfig } from './agent-runner-config.mjs';
import { loadProjectRegistry, projectFromRegistryById } from './agent-runner-project-registry.mjs';
import {
  buildRepositoryNavigationCapsule,
  loadOrBuildRepositoryMap,
  queryRepositoryMap,
} from './agent-runner-repository-map.mjs';

function valueFor(argv, name) {
  const exact = argv.indexOf(name);
  if (exact !== -1) {
    const value = argv[exact + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
  }
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : null;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function selectedProject(argv, env) {
  const registryPath = valueFor(argv, '--project-registry') || env.AGENT_RUNNER_PROJECT_REGISTRY || null;
  if (!registryPath) return loadAgentRunnerConfig({ argv, env });
  const registry = loadProjectRegistry({ argv, env, registryPath });
  const projectId = valueFor(argv, '--project') || registry.defaultProjectId;
  const project = projectFromRegistryById(registry, projectId);
  if (!project) throw new Error(`project '${projectId}' is not enabled in the configured registry`);
  return project;
}

function queryFromArgs(argv) {
  const kind = valueFor(argv, '--query');
  if (!kind) return null;
  if (kind === 'files') return { kind, term: valueFor(argv, '--term') };
  return { kind, path: valueFor(argv, '--path') };
}

function capsuleRequest(argv) {
  const paths = (valueFor(argv, '--paths') || '').split(',').map((item) => item.trim()).filter(Boolean);
  const terms = (valueFor(argv, '--terms') || '').split(',').map((item) => item.trim()).filter(Boolean);
  return paths.length || terms.length ? { paths, terms } : null;
}

function help() {
  process.stdout.write([
    'Usage: agent-runner-repository-map-command.mjs [project selection] [query]',
    '',
    'Project selection:',
    '  --config <path>                         canonical single-project config',
    '  --project-registry <path> --project <id>  canonical registry project (default project when omitted)',
    '',
    'Queries:',
    '  --query files --term <term>',
    '  --query subtree|package|tests|dependencies|instructions --path <repo-relative-path>',
    '  --paths <p1,p2> [--terms <t1,t2>]       bounded navigation capsule',
    '',
    'Without a query the command emits bounded map identity/count metadata only.',
    'The command never emits source bodies, raw git output, credentials or the local cache path.',
    '',
  ].join('\n'));
}

export function runRepositoryMapCommand({ argv = process.argv.slice(2), env = process.env } = {}) {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    help();
    return 0;
  }
  const project = selectedProject(argv, env);
  const loaded = loadOrBuildRepositoryMap({ project, repositoryRoot: project.localRepoPath });
  const query = queryFromArgs(argv);
  const capsule = capsuleRequest(argv);
  let output;
  if (query) output = queryRepositoryMap(loaded.map, query);
  else if (capsule) output = buildRepositoryNavigationCapsule(loaded.map, capsule);
  else {
    output = {
      schemaVersion: loaded.map.schemaVersion,
      projectId: loaded.map.project.projectId,
      githubRepo: loaded.map.project.githubRepo,
      sourceFingerprint: loaded.map.source.sourceFingerprint,
      mapDigest: loaded.map.mapDigest,
      reused: loaded.reused,
      truncated: loaded.map.truncated,
      counts: {
        files: loaded.map.files.length,
        packages: loaded.map.packages.length,
        instructions: loaded.map.instructions.length,
        dependencies: loaded.map.dependencies.length,
      },
    };
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = runRepositoryMapCommand();
  } catch (error) {
    process.stderr.write(`ERROR: ${String(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}
