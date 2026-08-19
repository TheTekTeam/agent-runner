#!/usr/bin/env node

/**
 * #261: versioned, normalized project brief derived from an already-
 * validated project-evidence snapshot (see
 * agent-runner-manager-project-evidence.mjs). Pure data shaping/validation;
 * never contacts GitHub, a provider or the filesystem -- see
 * docs/ops/AGENT-RUNNER-MANAGER-PLANNER.md.
 */

import { assertNormalizedManagerProjectEvidenceShape } from './agent-runner-manager-project-evidence.mjs';
import {
  assertBoundedSafeText,
  assertBoundedSafeTextArray,
  assertNoUnknownFields,
  contentFingerprint,
  isPlainObject,
} from './agent-runner-manager-planner-safety.mjs';

export const MANAGER_PROJECT_BRIEF_SCHEMA_VERSION = 'agent-runner-manager-project-brief/v1';

const MAX_LIST = 20;
const MAX_ITEM = 300;
const MAX_LONG = 600;

const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'objective',
  'outcome',
  'constraints',
  'nonGoals',
  'architectureSummary',
  'risks',
  'assumptions',
  'blockers',
  'escalationQuestions',
  'definitionOfDone',
]);

const VALIDATED_BRIEFS = new WeakSet();

/**
 * Validate a raw project-brief object against an already-validated evidence
 * snapshot. Fails closed on unknown/missing fields, over-bound lists and
 * unsafe free text (paths, secrets, shell payloads, write-action phrasing).
 * The architecture/tooling summary is derived directly from the evidence
 * snapshot's own `tooling` block rather than accepted from the caller, so
 * "grounded in supplied evidence" is structural, not merely claimed.
 */
export function validateManagerProjectBrief(input, { evidence } = {}) {
  assertNormalizedManagerProjectEvidenceShape(evidence);
  const errors = [];
  if (!isPlainObject(input)) throw new Error('Invalid agent runner manager project brief: brief must be a JSON object');
  assertNoUnknownFields(input, TOP_LEVEL_FIELDS, 'brief', errors);
  for (const field of TOP_LEVEL_FIELDS) {
    if (!(field in input)) errors.push(`brief.${field} is required`);
  }
  if (errors.length) throw new Error(`Invalid agent runner manager project brief: ${errors.join('; ')}`);

  if (input.schemaVersion !== MANAGER_PROJECT_BRIEF_SCHEMA_VERSION) errors.push(`schemaVersion must equal "${MANAGER_PROJECT_BRIEF_SCHEMA_VERSION}"`);

  assertBoundedSafeText(input.objective, 'brief.objective', errors, { max: MAX_LONG, allowWriteActionScan: false });
  assertBoundedSafeText(input.outcome, 'brief.outcome', errors, { max: MAX_LONG, allowWriteActionScan: false });
  assertBoundedSafeText(input.architectureSummary, 'brief.architectureSummary', errors, { max: MAX_LONG, allowWriteActionScan: false });

  const constraints = assertBoundedSafeTextArray(input.constraints, 'brief.constraints', errors, { max: MAX_LIST, itemMax: MAX_ITEM });
  const nonGoals = assertBoundedSafeTextArray(input.nonGoals, 'brief.nonGoals', errors, { max: MAX_LIST, itemMax: MAX_ITEM, minLength: 1, allowWriteActionScan: false });
  const risks = assertBoundedSafeTextArray(input.risks, 'brief.risks', errors, { max: MAX_LIST, itemMax: MAX_ITEM });
  const assumptions = assertBoundedSafeTextArray(input.assumptions, 'brief.assumptions', errors, { max: MAX_LIST, itemMax: MAX_ITEM });
  const blockers = assertBoundedSafeTextArray(input.blockers, 'brief.blockers', errors, { max: MAX_LIST, itemMax: MAX_ITEM });
  const escalationQuestions = assertBoundedSafeTextArray(input.escalationQuestions, 'brief.escalationQuestions', errors, { max: MAX_LIST, itemMax: MAX_ITEM });
  const definitionOfDone = assertBoundedSafeTextArray(input.definitionOfDone, 'brief.definitionOfDone', errors, { max: MAX_LIST, itemMax: MAX_ITEM, minLength: 1, allowWriteActionScan: false });

  if (errors.length) throw new Error(`Invalid agent runner manager project brief: ${errors.join('; ')}`);

  const architecture = Object.freeze({
    languages: evidence.tooling.languages,
    packageManagers: evidence.tooling.packageManagers,
    buildTools: evidence.tooling.buildTools,
    workflows: evidence.tooling.workflows,
    summary: input.architectureSummary.trim(),
  });

  const fingerprintPayload = Object.freeze({
    schemaVersion: input.schemaVersion,
    projectId: evidence.projectId,
    repository: evidence.repository.full,
    branch: evidence.branch,
    sourceSha: evidence.sourceSha,
    evidenceRevision: evidence.evidenceRevision,
    evidenceFingerprint: evidence.evidenceFingerprint,
    objective: input.objective.trim(),
    outcome: input.outcome.trim(),
    constraints,
    nonGoals,
    architecture,
    risks,
    assumptions,
    blockers,
    escalationQuestions,
    definitionOfDone,
  });
  const briefFingerprint = contentFingerprint(fingerprintPayload);
  const normalized = Object.freeze({ ...fingerprintPayload, briefFingerprint, evidence });
  VALIDATED_BRIEFS.add(normalized);
  return normalized;
}

/**
 * Refuse anything that merely *looks* like a validated brief; provenance is
 * checked against a `WeakSet` populated only by
 * `validateManagerProjectBrief()` itself.
 */
export function assertNormalizedManagerProjectBriefShape(brief) {
  if (!isPlainObject(brief) || !Object.isFrozen(brief) || !VALIDATED_BRIEFS.has(brief)) {
    throw new Error('requires an already-validated manager project brief: object was not produced by validateManagerProjectBrief');
  }
}
