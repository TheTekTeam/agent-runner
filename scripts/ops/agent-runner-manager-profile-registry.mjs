#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateManagerProfile } from './agent-runner-manager-profile-schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * #259: explicit registration only. Profiles are never auto-discovered from
 * a directory scan and no live repository is ever cloned or contacted to
 * populate this list; each entry is a stable projectId paired with a
 * checked-in fixture file path.
 */
export const MANAGER_PROFILE_REGISTRY = Object.freeze([
  Object.freeze({ projectId: 'agent-runner', configPath: '../../config/manager-profiles/agent-runner.json' }),
  Object.freeze({ projectId: 'modelspend', configPath: '../../config/manager-profiles/modelspend.json' }),
  Object.freeze({ projectId: 'fixture-third-project', configPath: '../../config/manager-profiles/fixture-third-project.json' }),
]);

function readProfileFile(absolutePath) {
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid agent runner manager profile JSON at ${absolutePath}: ${error.message}`);
    }
    throw new Error(`Unable to read agent runner manager profile at ${absolutePath}: ${error.message}`);
  }
}

/**
 * Load and validate every explicitly registered profile. Pure/read-only:
 * no GitHub call, no clone, no mutation.
 */
export function loadManagerProfileRegistry({ entries = MANAGER_PROFILE_REGISTRY, baseDir = __dirname } = {}) {
  const projectsById = {};
  const projectsByRepository = {};
  for (const entry of entries) {
    if (projectsById[entry.projectId]) {
      throw new Error(`Invalid agent runner manager profile registry: duplicate projectId '${entry.projectId}'`);
    }
    const absolutePath = resolve(baseDir, entry.configPath);
    const profile = validateManagerProfile(readProfileFile(absolutePath));
    if (profile.projectId !== entry.projectId) {
      throw new Error(
        `Invalid agent runner manager profile registry: registry entry projectId '${entry.projectId}' does not match profile.projectId '${profile.projectId}' in ${absolutePath}`,
      );
    }
    const repositoryKey = profile.repository.full.toLowerCase();
    if (projectsByRepository[repositoryKey]) {
      throw new Error(`Invalid agent runner manager profile registry: duplicate repository '${profile.repository.full}'`);
    }
    projectsById[entry.projectId] = profile;
    projectsByRepository[repositoryKey] = profile;
  }
  return Object.freeze({ projectsById: Object.freeze(projectsById), projectsByRepository: Object.freeze(projectsByRepository) });
}

/**
 * Resolve exactly one profile by projectId, failing closed for an
 * unregistered project or a repository that does not exactly match the
 * profile's declared owner/repository.
 */
export function resolveRegisteredManagerProfile({ projectId, repository, registry = loadManagerProfileRegistry() }) {
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new Error('resolveRegisteredManagerProfile requires a non-empty projectId');
  }
  const profile = registry.projectsById[projectId];
  if (!profile) {
    throw new Error(`Unregistered agent runner manager project: '${projectId}'`);
  }
  if (repository && repository.toLowerCase() !== profile.repository.full.toLowerCase()) {
    throw new Error(
      `Repository mismatch for project '${projectId}': profile declares '${profile.repository.full}', caller supplied '${repository}'`,
    );
  }
  return profile;
}
