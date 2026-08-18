#!/usr/bin/env node

/**
 * #259 (BUILD.MANAGER.PROFILES.2 correction): a read-only comparison
 * between the existing canonical managed project registry
 * (`agent-runner-project-registry.mjs`) and the #259 manager-profile
 * resolver, wired at the one existing Execution Manager recurrence this
 * repository already runs -- `runImplementationRecurrence()`
 * (`agent-runner-implementation-recurrence.mjs`). This module never
 * selects, claims, invokes or mutates anything; it only records whether a
 * profile-resolved manager context would currently agree with the
 * project's canonical registry identity. A missing, invalid or mismatched
 * profile is recorded as evidence and never blocks or alters the real
 * recurrence.
 */

import {
  assertManagerProfileRegisteredInProjectRegistry,
  loadManagerProfileRegistry,
} from './agent-runner-manager-profile-registry.mjs';
import { resolveManagerContext } from './agent-runner-manager-context.mjs';

export const MANAGER_PROFILE_SHADOW_SCHEMA_VERSION = 'agent-runner-manager-profile-shadow/v1';

/**
 * Compare one canonical project's registered identity against its manager
 * profile (if any). Never throws: every failure mode is captured as a
 * bounded `reason` string so a caller can log/record it as evidence without
 * risking the read-only shadow computation itself becoming a new failure
 * surface for the real recurrence.
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
    });
  }

  const mismatches = [];
  try {
    assertManagerProfileRegisteredInProjectRegistry(profile, {
      projectsById: { [projectId]: config },
    });
  } catch {
    mismatches.push('repository');
  }

  let context;
  try {
    context = resolveManagerContext(profile);
  } catch (error) {
    return Object.freeze({
      projectId,
      available: false,
      matches: false,
      reason: `manager-profile-context-error:${error.message}`,
      mismatches: Object.freeze(mismatches),
    });
  }

  return Object.freeze({
    projectId,
    available: true,
    matches: mismatches.length === 0,
    reason: null,
    mismatches: Object.freeze(mismatches),
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
 */
export function computeManagerProfileShadow(projects, { loadRegistry = loadManagerProfileRegistry } = {}) {
  let profileRegistry;
  try {
    profileRegistry = loadRegistry();
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
