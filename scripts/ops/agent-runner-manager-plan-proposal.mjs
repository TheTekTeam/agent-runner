#!/usr/bin/env node

/**
 * #261: versioned, normalized plan proposal derived from an already-
 * validated project brief (and, through it, its evidence snapshot). Pure
 * validation/normalization; never contacts GitHub, a provider, or dispatches
 * work -- see docs/ops/AGENT-RUNNER-MANAGER-PLANNER.md. This module never
 * itself performs a merge, close, deploy, label, dispatch, provider-run or
 * source-activation action, and rejects any proposal text that describes one.
 */

import { assertNormalizedManagerProjectBriefShape } from './agent-runner-manager-project-brief.mjs';
import {
  assertBoundedSafeText,
  assertBoundedSafeTextArray,
  assertNoUnknownFields,
  contentFingerprint,
  freezeArray,
  isPlainObject,
  nonEmptyString,
  stableJson,
} from './agent-runner-manager-planner-safety.mjs';

export const MANAGER_PLAN_PROPOSAL_SCHEMA_VERSION = 'agent-runner-manager-plan-proposal/v1';

const MAX_MILESTONES = 12;
const MAX_ISSUES = 40;
const MAX_DEPENDENCIES_PER_MILESTONE = 6;
const MAX_ACCEPTANCE_CRITERIA = 10;
const MAX_ITEM = 300;
const MAX_TITLE = 160;
const MAX_LIST = 20;

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ID_LENGTH = 60;
const DECISION_TYPES = new Set(['product', 'implementation']);

const TOP_LEVEL_FIELDS = new Set(['schemaVersion', 'grounding', 'milestones', 'proposedIssues', 'blockers', 'escalations']);
const VALIDATED_PROPOSALS = new WeakSet();

function validateGrounding(grounding, evidence, errors) {
  if (!isPlainObject(grounding)) {
    errors.push('grounding must be an object identifying the exact repository/branch/source revision this proposal was built from');
    return;
  }
  assertNoUnknownFields(grounding, new Set(['repository', 'branch', 'sourceSha']), 'grounding', errors);
  const { repository, branch, sourceSha } = grounding;
  if (repository !== evidence.repository.full) errors.push(`grounding.repository must exactly match the evidence repository '${evidence.repository.full}'`);
  if (branch !== evidence.branch) errors.push(`grounding.branch must exactly match the evidence branch '${evidence.branch}'`);
  if (!nonEmptyString(sourceSha) || String(sourceSha).toLowerCase() !== evidence.sourceSha) {
    errors.push(`grounding.sourceSha must exactly match the evidence sourceSha '${evidence.sourceSha}'`);
  }
}

function validateMilestones(milestones, errors) {
  if (!Array.isArray(milestones) || milestones.length === 0 || milestones.length > MAX_MILESTONES) {
    errors.push(`milestones must be a non-empty array of at most ${MAX_MILESTONES} entries`);
    return null;
  }
  const ids = new Set();
  const normalized = [];
  const dependsOnById = new Map();
  milestones.forEach((milestone, index) => {
    const label = `milestones[${index}]`;
    const before = errors.length;
    if (!isPlainObject(milestone)) {
      errors.push(`${label} must be an object`);
      return;
    }
    assertNoUnknownFields(milestone, new Set(['id', 'title', 'description', 'dependsOn']), label, errors);
    const { id, title, description, dependsOn } = milestone;
    if (!nonEmptyString(id) || !ID_PATTERN.test(id) || id.length > MAX_ID_LENGTH) errors.push(`${label}.id must be a safe lowercase token`);
    else if (ids.has(id)) errors.push(`${label}.id duplicates an already-listed milestone id`);
    assertBoundedSafeText(title, `${label}.title`, errors, { max: MAX_TITLE });
    assertBoundedSafeText(description, `${label}.description`, errors, { max: MAX_ITEM });
    let dependsOnList = null;
    if (dependsOn === undefined) dependsOnList = [];
    else if (!Array.isArray(dependsOn)) errors.push(`${label}.dependsOn must be an array of milestone ids`);
    else if (dependsOn.length > MAX_DEPENDENCIES_PER_MILESTONE) errors.push(`${label}.dependsOn must contain at most ${MAX_DEPENDENCIES_PER_MILESTONE} entries`);
    else if (!dependsOn.every((dep) => nonEmptyString(dep) && ID_PATTERN.test(dep))) errors.push(`${label}.dependsOn entries must be safe lowercase milestone id tokens`);
    else if (nonEmptyString(id) && dependsOn.includes(id)) errors.push(`${label}.dependsOn must not depend on itself`);
    else dependsOnList = dependsOn;
    if (errors.length === before) {
      ids.add(id);
      const frozenDeps = freezeArray(dependsOnList);
      dependsOnById.set(id, frozenDeps);
      normalized.push(Object.freeze({ id, title: title.trim(), description: description.trim(), dependsOn: frozenDeps }));
    }
  });
  if (errors.length) return null;

  for (const milestone of normalized) {
    for (const dep of milestone.dependsOn) {
      if (!ids.has(dep)) errors.push(`milestone '${milestone.id}' depends on unknown milestone '${dep}'`);
    }
  }
  if (errors.length) return null;

  // Acyclic dependency graph, checked with a standard three-colour DFS.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map(normalized.map((milestone) => [milestone.id, WHITE]));
  const stack = [];
  let cycleFound = false;
  const visit = (id) => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of dependsOnById.get(id)) {
      if (cycleFound) return;
      if (color.get(dep) === GRAY) {
        const cycleStart = stack.indexOf(dep);
        errors.push(`milestones contain a dependency cycle: ${[...stack.slice(cycleStart), dep].join(' -> ')}`);
        cycleFound = true;
        return;
      }
      if (color.get(dep) === WHITE) visit(dep);
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const milestone of normalized) {
    if (cycleFound) break;
    if (color.get(milestone.id) === WHITE) visit(milestone.id);
  }
  if (errors.length) return null;
  return freezeArray(normalized);
}

function validateProposedIssues(issues, milestoneIds, errors) {
  if (!Array.isArray(issues) || issues.length === 0 || issues.length > MAX_ISSUES) {
    errors.push(`proposedIssues must be a non-empty array of at most ${MAX_ISSUES} entries`);
    return null;
  }
  const ids = new Set();
  const normalized = [];
  issues.forEach((issue, index) => {
    const label = `proposedIssues[${index}]`;
    const before = errors.length;
    if (!isPlainObject(issue)) {
      errors.push(`${label} must be an object`);
      return;
    }
    assertNoUnknownFields(issue, new Set(['id', 'milestoneId', 'title', 'scope', 'acceptanceCriteria', 'decisionType']), label, errors);
    const {
      id, milestoneId, title, scope, acceptanceCriteria, decisionType,
    } = issue;
    if (!nonEmptyString(id) || !ID_PATTERN.test(id) || id.length > MAX_ID_LENGTH) errors.push(`${label}.id must be a safe lowercase token`);
    else if (ids.has(id)) errors.push(`${label}.id duplicates an already-listed proposed issue id`);
    if (!nonEmptyString(milestoneId) || !milestoneIds.has(milestoneId)) errors.push(`${label}.milestoneId must reference a milestone declared in this proposal`);
    assertBoundedSafeText(title, `${label}.title`, errors, { max: MAX_TITLE });
    assertBoundedSafeText(scope, `${label}.scope`, errors, { max: MAX_ITEM });
    const normalizedCriteria = assertBoundedSafeTextArray(acceptanceCriteria, `${label}.acceptanceCriteria`, errors, {
      max: MAX_ACCEPTANCE_CRITERIA,
      itemMax: MAX_ITEM,
      minLength: 1,
    });
    if (!DECISION_TYPES.has(decisionType)) errors.push(`${label}.decisionType must be one of ${[...DECISION_TYPES].join(', ')}`);
    if (errors.length === before) {
      ids.add(id);
      normalized.push(Object.freeze({
        id,
        milestoneId,
        title: title.trim(),
        scope: scope.trim(),
        acceptanceCriteria: normalizedCriteria,
        decisionType,
      }));
    }
  });
  if (errors.length) return null;
  return freezeArray(normalized);
}

/**
 * Validate a raw plan-proposal object against an already-validated project
 * brief. Fails closed on unknown/missing fields, repository/branch/SHA
 * mismatch against the underlying evidence, dependency cycles, unknown
 * milestone references, over-bound lists and unsafe free text (paths,
 * secrets, shell payloads, and write-action phrasing such as merge/deploy/
 * close/dispatch/source-activation/label mutation).
 */
export function validateManagerPlanProposal(input, { brief } = {}) {
  assertNormalizedManagerProjectBriefShape(brief);
  const errors = [];
  if (!isPlainObject(input)) throw new Error('Invalid agent runner manager plan proposal: proposal must be a JSON object');
  assertNoUnknownFields(input, TOP_LEVEL_FIELDS, 'proposal', errors);
  for (const field of TOP_LEVEL_FIELDS) {
    if (!(field in input)) errors.push(`proposal.${field} is required`);
  }
  if (errors.length) throw new Error(`Invalid agent runner manager plan proposal: ${errors.join('; ')}`);

  if (input.schemaVersion !== MANAGER_PLAN_PROPOSAL_SCHEMA_VERSION) errors.push(`schemaVersion must equal "${MANAGER_PLAN_PROPOSAL_SCHEMA_VERSION}"`);

  validateGrounding(input.grounding, brief.evidence, errors);
  const milestones = validateMilestones(input.milestones, errors);
  const milestoneIds = new Set((milestones ?? []).map((milestone) => milestone.id));
  const proposedIssues = milestones ? validateProposedIssues(input.proposedIssues, milestoneIds, errors) : null;
  const blockers = assertBoundedSafeTextArray(input.blockers, 'proposal.blockers', errors, { max: MAX_LIST, itemMax: MAX_ITEM });
  const escalations = assertBoundedSafeTextArray(input.escalations, 'proposal.escalations', errors, { max: MAX_LIST, itemMax: MAX_ITEM });

  if (errors.length) throw new Error(`Invalid agent runner manager plan proposal: ${errors.join('; ')}`);

  const fingerprintPayload = Object.freeze({
    schemaVersion: input.schemaVersion,
    projectId: brief.projectId,
    repository: brief.repository,
    branch: brief.branch,
    sourceSha: brief.sourceSha,
    briefFingerprint: brief.briefFingerprint,
    milestones,
    proposedIssues,
    blockers,
    escalations,
  });
  const proposalFingerprint = contentFingerprint(fingerprintPayload);
  const normalized = Object.freeze({ ...fingerprintPayload, proposalFingerprint, brief });
  VALIDATED_PROPOSALS.add(normalized);
  return normalized;
}

/**
 * Refuse anything that merely *looks* like a validated proposal; provenance
 * is checked against a `WeakSet` populated only by
 * `validateManagerPlanProposal()` itself.
 */
export function assertNormalizedManagerPlanProposalShape(proposal) {
  if (!isPlainObject(proposal) || !Object.isFrozen(proposal) || !VALIDATED_PROPOSALS.has(proposal)) {
    throw new Error('requires an already-validated manager plan proposal: object was not produced by validateManagerPlanProposal');
  }
}

/** Stable, deterministic serialization: identical evidence/brief/input always yields identical bytes. */
export function serializeManagerPlanProposal(proposal) {
  assertNormalizedManagerPlanProposalShape(proposal);
  const { brief, ...serializable } = proposal;
  return stableJson(serializable);
}
