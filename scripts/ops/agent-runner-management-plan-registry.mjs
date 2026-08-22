#!/usr/bin/env node

/**
 * #268: the explicitly registered per-project **management plan document**.
 *
 * The #261 planner family is a pure validator chain: it validates a brief and a
 * plan proposal but deliberately produces neither. Something must therefore
 * supply the authored parts of a plan -- the objective, the milestones, the
 * proposed work and the approved execution parameters -- before the programme
 * role can reconcile anything.
 *
 * This module is that source, and it is deliberately the least powerful one
 * that works: a checked-in JSON document per registered project, loaded by
 * explicit registration exactly as `#259` loads manager profiles. There is no
 * directory scan, no provider call, no clone and no network access. A project
 * with no registered plan document simply has no management plan, and the
 * programme role reconciles nothing for it rather than inventing work.
 *
 * Everything time- or revision-dependent is deliberately **absent** here and
 * injected by the collector at read time: the exact source SHA, the evidence
 * timestamps and the live GitHub queue state. A checked-in document can
 * therefore never pin a stale base or manufacture a state transition.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertBoundedSafeText,
  assertBoundedSafeTextArray,
  assertNoUnknownFields,
  freezeArray,
  isPlainObject,
  nonEmptyString,
} from './agent-runner-manager-planner-safety.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MANAGEMENT_PLAN_SCHEMA_VERSION = 'agent-runner-management-plan/v1';

/**
 * Explicit registration only, mirroring `MANAGER_PROFILE_REGISTRY`. A plan is
 * never auto-discovered, and only a project that also has a registered manager
 * profile can be managed.
 */
export const MANAGEMENT_PLAN_REGISTRY = Object.freeze([
  Object.freeze({ projectId: 'agent-runner', configPath: '../../config/manager-plans/agent-runner.json' }),
]);

const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion', 'projectId', 'tooling', 'acceptanceCommands', 'brief',
  'milestones', 'proposedIssues', 'planBlockers', 'escalations', 'execution', 'request',
]);
const BRIEF_FIELDS = new Set([
  'objective', 'outcome', 'constraints', 'nonGoals', 'architectureSummary',
  'risks', 'assumptions', 'blockers', 'escalationQuestions', 'definitionOfDone',
]);
const MILESTONE_FIELDS = new Set(['id', 'title', 'description', 'dependsOn']);
const PROPOSED_ISSUE_FIELDS = new Set(['id', 'milestoneId', 'title', 'scope', 'acceptanceCriteria', 'decisionType']);
const EXECUTION_FIELDS = new Set(['adapter', 'capabilityProfile', 'model', 'effort']);
const REQUEST_FIELDS = new Set(['branchPrefix', 'scope', 'stopConditions']);
const TOOLING_FIELDS = new Set(['languages', 'packageManagers', 'buildTools', 'workflows']);

const TOKEN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Narrower than a refname: the prefix is concatenated with a plan item id and an
// issue number, and the result must still be a bounded implementation branch.
const BRANCH_PREFIX_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,40}\/$/;

const MAX_MILESTONES = 20;
const MAX_PROPOSED_ISSUES = 50;

function fail(path, errors) {
  throw new Error(`Invalid agent runner management plan at ${path}: ${errors.join('; ')}`);
}

function validateTooling(tooling, errors) {
  if (!isPlainObject(tooling)) {
    errors.push('tooling must be an object');
    return null;
  }
  assertNoUnknownFields(tooling, TOOLING_FIELDS, 'tooling', errors);
  const normalized = {};
  for (const field of TOOLING_FIELDS) {
    normalized[field] = assertBoundedSafeTextArray(tooling[field] ?? [], `tooling.${field}`, errors, {
      max: 20, itemMax: 60, allowWriteActionScan: false,
    }) ?? freezeArray([]);
  }
  return Object.freeze(normalized);
}

function validateBrief(brief, errors) {
  if (!isPlainObject(brief)) {
    errors.push('brief must be an object');
    return null;
  }
  assertNoUnknownFields(brief, BRIEF_FIELDS, 'brief', errors);
  assertBoundedSafeText(brief.objective, 'brief.objective', errors, { max: 300 });
  assertBoundedSafeText(brief.outcome, 'brief.outcome', errors, { max: 300 });
  assertBoundedSafeText(brief.architectureSummary, 'brief.architectureSummary', errors, { max: 600 });
  for (const field of ['constraints', 'nonGoals', 'risks', 'assumptions', 'blockers', 'escalationQuestions', 'definitionOfDone']) {
    assertBoundedSafeTextArray(brief[field] ?? [], `brief.${field}`, errors, { max: 20, itemMax: 300 });
  }
  return brief;
}

function validateMilestones(milestones, errors) {
  if (!Array.isArray(milestones) || milestones.length === 0 || milestones.length > MAX_MILESTONES) {
    errors.push(`milestones must be an array with between 1 and ${MAX_MILESTONES} entries`);
    return null;
  }
  milestones.forEach((milestone, index) => {
    const label = `milestones[${index}]`;
    if (!isPlainObject(milestone)) {
      errors.push(`${label} must be an object`);
      return;
    }
    assertNoUnknownFields(milestone, MILESTONE_FIELDS, label, errors);
    if (!nonEmptyString(milestone.id) || !TOKEN_PATTERN.test(milestone.id)) {
      errors.push(`${label}.id must be a safe lowercase token`);
    }
    assertBoundedSafeText(milestone.title, `${label}.title`, errors, { max: 200 });
    assertBoundedSafeText(milestone.description, `${label}.description`, errors, { max: 400 });
    if (!Array.isArray(milestone.dependsOn ?? [])) errors.push(`${label}.dependsOn must be an array`);
  });
  return milestones;
}

function validateProposedIssues(issues, errors) {
  if (!Array.isArray(issues) || issues.length === 0 || issues.length > MAX_PROPOSED_ISSUES) {
    errors.push(`proposedIssues must be an array with between 1 and ${MAX_PROPOSED_ISSUES} entries`);
    return null;
  }
  const seen = new Set();
  issues.forEach((issue, index) => {
    const label = `proposedIssues[${index}]`;
    if (!isPlainObject(issue)) {
      errors.push(`${label} must be an object`);
      return;
    }
    assertNoUnknownFields(issue, PROPOSED_ISSUE_FIELDS, label, errors);
    // The id becomes half of the stable `qc:<projectId>:<id>` curation key, so
    // it must be a safe lowercase token and unique within the plan.
    if (!nonEmptyString(issue.id) || !TOKEN_PATTERN.test(issue.id)) {
      errors.push(`${label}.id must be a safe lowercase token`);
    } else if (seen.has(issue.id)) {
      errors.push(`${label}.id duplicates an already-listed proposed issue`);
    } else {
      seen.add(issue.id);
    }
    if (!nonEmptyString(issue.milestoneId) || !TOKEN_PATTERN.test(issue.milestoneId)) {
      errors.push(`${label}.milestoneId must be a safe lowercase token`);
    }
    assertBoundedSafeText(issue.title, `${label}.title`, errors, { max: 200 });
    assertBoundedSafeText(issue.scope, `${label}.scope`, errors, { max: 600 });
    assertBoundedSafeTextArray(issue.acceptanceCriteria ?? [], `${label}.acceptanceCriteria`, errors, { max: 20, itemMax: 300 });
  });
  return issues;
}

function validateExecution(execution, errors) {
  if (!isPlainObject(execution)) {
    errors.push('execution must be an object');
    return null;
  }
  assertNoUnknownFields(execution, EXECUTION_FIELDS, 'execution', errors);
  for (const field of EXECUTION_FIELDS) {
    if (!nonEmptyString(execution[field])) errors.push(`execution.${field} is required`);
  }
  return Object.freeze({ ...execution });
}

function validateRequest(request, errors) {
  if (!isPlainObject(request)) {
    errors.push('request must be an object');
    return null;
  }
  assertNoUnknownFields(request, REQUEST_FIELDS, 'request', errors);
  if (!nonEmptyString(request.branchPrefix) || !BRANCH_PREFIX_PATTERN.test(request.branchPrefix)) {
    errors.push('request.branchPrefix must be a bounded lowercase branch prefix ending in "/"');
  }
  const scope = assertBoundedSafeTextArray(request.scope ?? [], 'request.scope', errors, { max: 12, itemMax: 300, minLength: 1 });
  const stopConditions = assertBoundedSafeTextArray(request.stopConditions ?? [], 'request.stopConditions', errors, {
    max: 12, itemMax: 200, minLength: 1, allowWriteActionScan: false,
  });
  return Object.freeze({ branchPrefix: request.branchPrefix, scope, stopConditions });
}

/**
 * Validate one plan document against the registered manager profile it belongs
 * to. Cross-checks that would otherwise only surface deep inside the #261/#267
 * validators are made here, where the error names the offending document.
 */
export function validateManagementPlan(input, { profile, path = '<memory>' } = {}) {
  if (!isPlainObject(profile)) throw new Error('validateManagementPlan requires the registered manager profile');
  const errors = [];
  if (!isPlainObject(input)) fail(path, ['plan must be a JSON object']);
  assertNoUnknownFields(input, TOP_LEVEL_FIELDS, 'plan', errors);
  if (input.schemaVersion !== MANAGEMENT_PLAN_SCHEMA_VERSION) {
    errors.push(`schemaVersion must equal "${MANAGEMENT_PLAN_SCHEMA_VERSION}"`);
  }
  if (input.projectId !== profile.projectId) {
    errors.push(`projectId must equal the registered profile projectId '${profile.projectId}'`);
  }
  if (errors.length) fail(path, errors);

  const tooling = validateTooling(input.tooling, errors);
  const brief = validateBrief(input.brief, errors);
  const milestones = validateMilestones(input.milestones, errors);
  const proposedIssues = validateProposedIssues(input.proposedIssues, errors);
  const execution = validateExecution(input.execution, errors);
  const request = validateRequest(input.request, errors);

  // Acceptance commands must be a subset of the profile's approved required
  // checks; #261 enforces this too, but failing here names the plan file.
  const acceptanceCommands = Array.isArray(input.acceptanceCommands) ? input.acceptanceCommands : null;
  if (!acceptanceCommands || acceptanceCommands.length === 0) {
    errors.push('acceptanceCommands must be a non-empty array');
  } else {
    for (const command of acceptanceCommands) {
      if (!profile.validation.requiredChecks.includes(command)) {
        errors.push(`acceptanceCommands entry '${String(command)}' is not one of the profile's validation.requiredChecks`);
      }
    }
  }
  if (execution) {
    if (!profile.capabilities.allowlist.includes(execution.adapter)) {
      errors.push(`execution.adapter '${execution.adapter}' is not in the profile capability allowlist`);
    }
    if (execution.capabilityProfile !== profile.validation.profile) {
      errors.push(`execution.capabilityProfile must equal the profile validation profile '${profile.validation.profile}'`);
    }
  }
  // Every proposed issue must name a declared milestone.
  if (milestones && proposedIssues) {
    const milestoneIds = new Set(milestones.map((milestone) => milestone.id));
    for (const issue of proposedIssues) {
      if (isPlainObject(issue) && nonEmptyString(issue.milestoneId) && !milestoneIds.has(issue.milestoneId)) {
        errors.push(`proposedIssues '${issue.id}' names undeclared milestone '${issue.milestoneId}'`);
      }
    }
  }
  if (errors.length) fail(path, errors);

  return Object.freeze({
    schemaVersion: MANAGEMENT_PLAN_SCHEMA_VERSION,
    projectId: input.projectId,
    tooling,
    acceptanceCommands: freezeArray(acceptanceCommands),
    brief: Object.freeze({ ...brief }),
    milestones: freezeArray(milestones.map((milestone) => Object.freeze({ ...milestone, dependsOn: freezeArray(milestone.dependsOn ?? []) }))),
    proposedIssues: freezeArray(proposedIssues.map((issue) => Object.freeze({ ...issue }))),
    planBlockers: freezeArray(input.planBlockers ?? []),
    escalations: freezeArray(input.escalations ?? []),
    execution,
    request,
  });
}

function readPlanFile(absolutePath) {
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid agent runner management plan JSON at ${absolutePath}: ${error.message}`);
    throw new Error(`Unable to read agent runner management plan at ${absolutePath}: ${error.message}`);
  }
}

/**
 * Resolve the registered plan for one project, or `null` when that project has
 * no registered plan. A missing plan is a legitimate state -- the project is
 * simply not planned yet -- and must never be confused with an invalid one,
 * which throws.
 */
export function resolveRegisteredManagementPlan({
  projectId,
  profile,
  entries = MANAGEMENT_PLAN_REGISTRY,
  baseDir = __dirname,
} = {}) {
  if (!nonEmptyString(projectId)) throw new Error('resolveRegisteredManagementPlan requires a projectId');
  const entry = entries.find((candidate) => candidate.projectId === projectId) ?? null;
  if (!entry) return null;
  const absolutePath = resolve(baseDir, entry.configPath);
  return validateManagementPlan(readPlanFile(absolutePath), { profile, path: absolutePath });
}
