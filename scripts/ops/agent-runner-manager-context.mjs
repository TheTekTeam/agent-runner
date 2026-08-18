#!/usr/bin/env node

/**
 * #259: resolve one validated management profile into the single bounded,
 * normalized manager context the existing management recurrence consumes.
 * This module performs no GitHub call, no clone and no mutation; it is pure
 * data shaping over an already-validated profile
 * (see agent-runner-manager-profile-schema.mjs).
 */

import { assertNormalizedManagerProfileShape } from './agent-runner-manager-profile-schema.mjs';

export const MANAGER_CONTEXT_SCHEMA_VERSION = 'agent-runner-manager-context/v1';

/**
 * A disabled profile (`enabled: false`) must resolve to a context whose
 * mutation authority is entirely false, regardless of what the profile's
 * mutationAuthority block declares. This is the single point that
 * guarantees "enabled: false produces zero manager mutations".
 */
function effectiveMutationAuthority(profile) {
  if (!profile.enabled) {
    return Object.freeze({
      issueMutation: false,
      authorityIssuance: false,
      merge: false,
      close: false,
      deploy: false,
      sourceActivation: false,
    });
  }
  return profile.mutationAuthority;
}

/**
 * Resolve a validated manager profile into the normalized manager context.
 * Deterministic and idempotent: calling this repeatedly with the same
 * profile always yields a deep-equal, independently frozen result.
 */
export function resolveManagerContext(profile) {
  assertNormalizedManagerProfileShape(profile);
  const mutationAuthority = effectiveMutationAuthority(profile);
  const mutationBounds = profile.enabled
    ? profile.mutationBounds
    : Object.freeze({ maxIssueMutationsPerRecurrence: 0, maxCommentsPerRecurrence: 0 });

  return Object.freeze({
    schemaVersion: MANAGER_CONTEXT_SCHEMA_VERSION,
    profileSchemaVersion: profile.schemaVersion,
    projectId: profile.projectId,
    enabled: profile.enabled,
    repository: profile.repository,
    branches: profile.branches,
    objective: profile.objective,
    nonGoals: profile.nonGoals,
    instructionPaths: profile.instructionPaths,
    controlIssue: profile.controlIssue,
    labels: profile.labels,
    capabilities: profile.capabilities,
    validation: profile.validation,
    quotaPolicyRef: profile.quotaPolicyRef,
    mutationBounds,
    escalation: profile.escalation,
    mutationAuthority,
  });
}
