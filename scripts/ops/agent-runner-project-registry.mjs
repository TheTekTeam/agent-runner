import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { loadAgentRunnerConfig } from './agent-runner-config.mjs';

const REGISTRY_ENV = 'AGENT_RUNNER_PROJECT_REGISTRY';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function cleanPathForError(path) {
  return path ? resolve(path) : path;
}

function readRegistryFile(registryPath) {
  try {
    return JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid agent runner project registry JSON at ${cleanPathForError(registryPath)}: ${error.message}`);
    }
    throw new Error(`Unable to read agent runner project registry at ${cleanPathForError(registryPath)}: ${error.message}`);
  }
}

function normalizeEntry(entry, index) {
  if (nonEmptyString(entry)) return { configPath: entry, enabled: true };
  if (!isPlainObject(entry)) {
    throw new Error(`Invalid agent runner project registry: projects[${index}] must be a config path string or object`);
  }
  if (!nonEmptyString(entry.configPath)) {
    throw new Error(`Invalid agent runner project registry: projects[${index}].configPath is required`);
  }
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
    throw new Error(`Invalid agent runner project registry: projects[${index}].enabled must be boolean`);
  }
  return { configPath: entry.configPath, enabled: entry.enabled !== false };
}

export function resolveProjectRegistryPath(argv = [], env = process.env) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project-registry') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--project-registry requires a value');
      return value;
    }
    if (arg.startsWith('--project-registry=')) return arg.slice('--project-registry='.length);
  }
  return env[REGISTRY_ENV] || null;
}

export function stripProjectRegistryArgs(argv = []) {
  const stripped = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project-registry') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--project-registry=')) continue;
    stripped.push(arg);
  }
  return stripped;
}

export function validateProjectRegistryManifest(input) {
  const errors = [];
  if (!isPlainObject(input)) errors.push('registry must be a JSON object');
  if (input?.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (!Array.isArray(input?.projects) || input.projects.length === 0) {
    errors.push('projects must contain at least one entry');
  }
  if (input?.defaultProjectId !== undefined && !nonEmptyString(input.defaultProjectId)) {
    errors.push('defaultProjectId must be a non-empty string');
  }
  if (errors.length > 0) throw new Error(`Invalid agent runner project registry: ${errors.join('; ')}`);

  return {
    schemaVersion: 1,
    defaultProjectId: input.defaultProjectId ?? null,
    projects: input.projects.map(normalizeEntry),
  };
}

function uniquenessValue(config, field) {
  if (field === 'projectId') return config.projectId;
  if (field === 'githubRepo') return config.githubRepo.toLowerCase();
  if (field === 'localRepoPath') return resolve(config.localRepoPath);
  if (field === 'stateDbPath') return resolve(config.localRepoPath, config.stateDbPath);
  if (field === 'lockPath') return resolve(config.localRepoPath, config.runner.lockPath);
  throw new Error(`Unsupported uniqueness field: ${field}`);
}

function assertUniqueProjects(entries) {
  const fields = ['projectId', 'githubRepo', 'localRepoPath', 'stateDbPath', 'lockPath'];
  for (const field of fields) {
    const seen = new Map();
    for (const entry of entries) {
      const value = uniquenessValue(entry.config, field);
      const existing = seen.get(value);
      if (existing) {
        throw new Error(
          `Invalid agent runner project registry: duplicate ${field} '${value}' in ${existing} and ${entry.configPath}`,
        );
      }
      seen.set(value, entry.configPath);
    }
  }
}

/**
 * Read every registry entry — including disabled ones — with its project
 * config already loaded through the canonical `validateAgentRunnerConfig`
 * contract. Uniqueness and enabled/default admission rules are *not* applied
 * here; `resolveProjectRegistrySelection()` owns those so the same rules can
 * also be run against a proposed in-memory registry state before anything is
 * written to disk (issue #177).
 */
export function readProjectRegistryEntries({
  argv = [],
  env = process.env,
  registryPath = resolveProjectRegistryPath(argv, env),
} = {}) {
  if (!registryPath) {
    throw new Error(
      'No agent runner project registry configured; use --project-registry or AGENT_RUNNER_PROJECT_REGISTRY',
    );
  }

  const absoluteRegistryPath = resolve(registryPath);
  const manifest = validateProjectRegistryManifest(readRegistryFile(absoluteRegistryPath));
  const registryDir = dirname(absoluteRegistryPath);
  const entries = manifest.projects.map((entry) => {
    const configPath = resolve(registryDir, entry.configPath);
    return {
      configPath,
      relativeConfigPath: entry.configPath,
      enabled: entry.enabled,
      config: loadAgentRunnerConfig({ argv: [], env: {}, configPath }),
    };
  });

  return { registryPath: absoluteRegistryPath, registryDir, manifest, entries };
}

/**
 * Apply the canonical duplicate-ownership, enabled-project and default-project
 * admission rules to a set of loaded entries. Pure: the entries may come from
 * disk or from a proposed mutation held only in memory.
 */
export function resolveProjectRegistrySelection({ manifest, entries }) {
  assertUniqueProjects(entries);

  const projects = entries.filter((entry) => entry.enabled).map((entry) => entry.config);
  if (projects.length === 0) {
    throw new Error('Invalid agent runner project registry: at least one project must be enabled');
  }

  const projectsById = Object.fromEntries(projects.map((project) => [project.projectId, project]));
  const projectsByRepository = Object.fromEntries(
    projects.map((project) => [project.githubRepo.toLowerCase(), project]),
  );
  const defaultProjectId = manifest.defaultProjectId ?? projects[0].projectId;
  if (!projectsById[defaultProjectId]) {
    throw new Error(
      `Invalid agent runner project registry: defaultProjectId '${defaultProjectId}' is not an enabled project`,
    );
  }

  return { defaultProjectId, projects, projectsById, projectsByRepository };
}

export function loadProjectRegistry(options = {}) {
  const { registryPath, manifest, entries } = readProjectRegistryEntries(options);
  const selection = resolveProjectRegistrySelection({ manifest, entries });

  return Object.freeze({
    schemaVersion: 1,
    registryPath,
    defaultProjectId: selection.defaultProjectId,
    projects: Object.freeze([...selection.projects]),
    projectsById: Object.freeze(selection.projectsById),
    projectsByRepository: Object.freeze(selection.projectsByRepository),
  });
}

export function projectFromRegistryById(registry, projectId) {
  return registry.projectsById[projectId] ?? null;
}

export function projectFromRegistryByRepository(registry, githubRepo) {
  if (!nonEmptyString(githubRepo)) return null;
  return registry.projectsByRepository[githubRepo.toLowerCase()] ?? null;
}
