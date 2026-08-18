#!/usr/bin/env node

/**
 * #259 (BUILD.MANAGER.PROFILES.2/.3 correction): a read-only comparison
 * between the existing canonical managed project registry
 * (`agent-runner-project-registry.mjs`) and the #259 manager-profile
 * resolver, wired at the one existing Execution Manager recurrence this
 * repository already runs -- `runImplementationRecurrence()`
 * (`agent-runner-implementation-recurrence.mjs`). This module never
 * selects, claims, invokes or mutates anything; it only records whether a
 * profile-resolved manager context would currently agree with the
 * project's canonical registry identity, field by field. A missing,
 * invalid or mismatched profile is recorded as evidence and never blocks
 * or alters the real recurrence.
 */

import { loadManagerProfileRegistry } from './agent-runner-manager-profile-registry.mjs';
import { resolveManagerContext } from './agent-runner-manager-context.mjs';

export const MANAGER_PROFILE_SHADOW_SCHEMA_VERSION = 'agent-runner-manager-profile-shadow/v1';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Every behaviour-affecting field expressible by both the canonical
 * project config (`agent-runner-config.mjs`) and the normalized profile
 * (`agent-runner-manager-context.mjs`), in comparison order. A field
 * returns `'non-comparable'` rather than silently passing when the
 * canonical config does not currently carry that data at all (e.g.
 * `branches`/`instructionPaths`, which the config schema does not yet
 * define per-project) -- that gap is recorded as explicit evidence, never
 * treated as a match.
 */
const FIELD_COMPARATORS = Object.freeze({
  projectId: (config, profile) => {
    if (typeof config.projectId !== 'string' || !config.projectId.trim()) return 'non-comparable';
    return config.projectId === profile.projectId ? 'match' : 'mismatch';
  },
  repository: (config, profile) => {
    if (typeof config.githubRepo !== 'string' || !config.githubRepo.trim()) return 'non-comparable';
    return config.githubRepo.toLowerCase() === profile.repository.full.toLowerCase() ? 'match' : 'mismatch';
  },
  // Every config reaching this comparison is drawn from the canonical
  // registry's already-enabled/admitted project set (see
  // `loadEnabledProjectsWithConfigPaths`); there is no separate canonical
  // "enabled" flag on the config object itself to compare against, so
  // admission is asserted true by construction. A profile that is not also
  // enabled would silently drop an admitted project once cutover makes the
  // profile authoritative -- that divergence is exactly what this compares.
  enabled: (config, profile) => (profile.enabled === true ? 'match' : 'mismatch'),
  branches: (config, profile) => {
    if (!isPlainObject(config.branches) || !Array.isArray(config.branches.allowed) || typeof config.branches.default !== 'string') {
      return 'non-comparable';
    }
    const { allowed, default: defaultBranch } = config.branches;
    const sameAllowed = allowed.length === profile.branches.allowed.length
      && allowed.every((branch) => profile.branches.allowed.includes(branch));
    return sameAllowed && defaultBranch === profile.branches.default ? 'match' : 'mismatch';
  },
  instructionPaths: (config, profile) => {
    if (!Array.isArray(config.instructionPaths)) return 'non-comparable';
    const { instructionPaths } = config;
    const same = instructionPaths.length === profile.instructionPaths.length
      && instructionPaths.every((path) => profile.instructionPaths.includes(path));
    return same ? 'match' : 'mismatch';
  },
});

const COMPARABLE_FIELD_ORDER = Object.freeze(Object.keys(FIELD_COMPARATORS));

function compareFields(config, profile) {
  const mismatches = [];
  const nonComparable = [];
  for (const field of COMPARABLE_FIELD_ORDER) {
    const result = FIELD_COMPARATORS[field](config, profile);
    if (result === 'mismatch') mismatches.push(field);
    else if (result === 'non-comparable') nonComparable.push(field);
  }
  return { mismatches: Object.freeze(mismatches), nonComparable: Object.freeze(nonComparable) };
}

/**
 * Compare one canonical project's registered identity against its manager
 * profile (if any), field by field. Never throws: every failure mode is
 * captured as a bounded `reason` string so a caller can log/record it as
 * evidence without risking the read-only shadow computation itself
 * becoming a new failure surface for the real recurrence.
 */
export function computeManagerProfileShadowForProject({ config, profileRegistry }) {
  const projectId = config?.projectId ?? null;
  const profile = projectId ? profileRegistry.projectsById[projectId] : null;

  if (!profile) {
    return Object.freeze({
      projectId,
      available: false,
      matches: false,
      reason: 'manager-profile-unregistered',
      mismatches: Object.freeze([]),
      nonComparable: Object.freeze([]),
    });
  }

  const { mismatches, nonComparable } = compareFields(config, profile);

  let context;
  try {
    context = resolveManagerContext(profile);
  } catch (error) {
    return Object.freeze({
      projectId,
      available: false,
      matches: false,
      reason: `manager-profile-context-error:${error.message}`,
      mismatches,
      nonComparable,
    });
  }

  return Object.freeze({
    projectId,
    available: true,
    matches: mismatches.length === 0,
    reason: null,
    mismatches,
    nonComparable,
    profileEnabled: context.enabled,
    mutationAuthority: context.mutationAuthority,
  });
}

/**
 * Compute the shadow comparison for every enabled canonical project the
 * real recurrence is about to probe. Pure and read-only: does not resolve
 * or require a live GitHub call, and a registry/profile load failure is
 * captured as a single top-level `unavailable` entry rather than thrown, so
 * it can never interrupt the actual recurrence it is only observing.
 *
 * The manager-profile registry load is bound against the *exact* canonical
 * managed project set this call was given -- not a second, independently
 * (re)loaded copy of the registry -- so every enabled profile is checked
 * against the same canonical identity the real recurrence just used to
 * probe/select, failing the shadow load closed on any repository mismatch
 * or unregistered enabled profile (see
 * `agent-runner-manager-profile-registry.mjs#assertManagerProfileRegisteredInProjectRegistry`).
 */
export function computeManagerProfileShadow(projects, { loadRegistry } = {}) {
  const projectsById = Object.freeze(
    Object.fromEntries(projects.map((entry) => [entry.config.projectId, entry.config])),
  );
  const boundProjectRegistry = Object.freeze({ projectsById });
  const resolveRegistry = loadRegistry || (() => loadManagerProfileRegistry({ projectRegistry: boundProjectRegistry }));

  let profileRegistry;
  try {
    profileRegistry = resolveRegistry();
  } catch (error) {
    return Object.freeze({
      schemaVersion: MANAGER_PROFILE_SHADOW_SCHEMA_VERSION,
      available: false,
      reason: `manager-profile-registry-error:${error.message}`,
      projects: Object.freeze([]),
    });
  }

  const results = projects.map((entry) => computeManagerProfileShadowForProject({ config: entry.config, profileRegistry }));
  return Object.freeze({
    schemaVersion: MANAGER_PROFILE_SHADOW_SCHEMA_VERSION,
    available: true,
    reason: null,
    projects: Object.freeze(results),
  });
}
