#!/usr/bin/env node

/**
 * #259: one versioned, provider-neutral, schema-validated per-project
 * management profile. This module only defines and validates the profile
 * shape; it never generates manager authority, contacts GitHub, clones a
 * repository or performs any mutation. See docs/ops/AGENT-RUNNER-MANAGER-PROFILES.md.
 */

export const MANAGER_PROFILE_SCHEMA_VERSION = 'agent-runner-manager-profile/v1';

const MUTATION_AUTHORITY_FIELDS = Object.freeze([
  'issueMutation',
  'authorityIssuance',
  'merge',
  'close',
  'deploy',
  'sourceActivation',
]);

// Every label-state semantic name any registered profile is allowed to use.
// Anything outside this exact set fails closed rather than being silently
// accepted as an ad hoc state -- including any attempt to smuggle an
// account-credit/balance-style key in through the one nested object whose
// keys are otherwise caller-controlled data rather than a fixed field list.
const SUPPORTED_LABEL_STATES = Object.freeze(['ready', 'inProgress', 'blocked', 'done', 'needsReview']);

// GitHub label strings and capability/adapter identifiers must be plain,
// lowercase, machine-safe tokens: no whitespace, control characters or
// unbounded content that could later be interpreted as something other than
// an exact label/capability string.
const LABEL_VALUE_PATTERN = /^[a-z0-9]+(?:[-_:][a-z0-9]+)*$/i;
const CAPABILITY_VALUE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Refused at any nesting depth, not merely at the top level: no field
// anywhere in a manager profile may be named after an account-credit or
// balance concept, since #256/#259 both require quota-only, credit-free
// admission.
const FORBIDDEN_FIELD_NAME_PATTERN = /^(account[-_]?credit|balance|account[-_]?balance|credit[-_]?balance)$/i;

/**
 * Every actual profile object returned by `validateManagerProfile()` is
 * recorded here. This makes profile provenance unforgeable inside the
 * process: `assertNormalizedManagerProfileShape()` refuses any object that
 * merely *looks* like a validated profile (right shape, right values, even
 * deeply frozen) but was never actually produced by this validator -- a
 * `WeakSet` cannot be forged or replayed by constructing a look-alike object.
 */
const VALIDATED_PROFILES = new WeakSet();

const REQUIRED_TOP_LEVEL_FIELDS = Object.freeze([
  'schemaVersion',
  'projectId',
  'enabled',
  'repository',
  'branches',
  'objective',
  'nonGoals',
  'instructionPaths',
  'controlIssue',
  'labels',
  'capabilities',
  'validation',
  'quotaPolicyRef',
  'mutationBounds',
  'escalation',
  'mutationAuthority',
]);

const ALLOWED_TOP_LEVEL_FIELDS = new Set(REQUIRED_TOP_LEVEL_FIELDS);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value) {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function isBoolean(value) {
  return typeof value === 'boolean';
}

/**
 * Every array embedded in a normalized profile must itself be frozen, not
 * merely the object that holds it -- otherwise `Object.freeze(parent)`
 * leaves the array reference mutable and a caller could push into it after
 * validation. Values here are always already-checked string/number
 * primitives, so a shallow array freeze is sufficient.
 */
function freezeArray(array) {
  return Object.freeze([...array]);
}

function assertNoUnknownFields(object, allowed, label, errors) {
  if (!isPlainObject(object)) return;
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) errors.push(`${label}.${key} is not a recognised field`);
  }
}

/**
 * Refuse an account-credit or balance style field name anywhere in the raw
 * profile object, not merely at the top level. This runs before every other
 * check so a forbidden field cannot hide inside a part of the schema (such
 * as `labels`, whose keys are otherwise caller-controlled state names) that
 * would not already reject it as an unrecognised field.
 */
function assertNoForbiddenFieldNamesRecursive(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFieldNamesRecursive(item, `${path}[${index}]`, errors));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_FIELD_NAME_PATTERN.test(key)) {
      errors.push(`${path}.${key} must not carry an account-credit or balance field`);
    }
    assertNoForbiddenFieldNamesRecursive(nested, `${path}.${key}`, errors);
  }
}

const REPOSITORY_PATTERN = /^[^\s/]+\/[^\s/]+$/;

function validateRepository(repository, errors) {
  if (!isPlainObject(repository)) {
    errors.push('repository must be an object with owner and name');
    return null;
  }
  assertNoUnknownFields(repository, new Set(['owner', 'name']), 'repository', errors);
  const { owner, name } = repository;
  if (!nonEmptyString(owner)) errors.push('repository.owner is required');
  if (!nonEmptyString(name)) errors.push('repository.name is required');
  if (!nonEmptyString(owner) || !nonEmptyString(name)) return null;
  const full = `${owner}/${name}`;
  if (!REPOSITORY_PATTERN.test(full)) errors.push('repository.owner/repository.name must form an exact owner/repository pair');
  return Object.freeze({ owner, name, full });
}

function validateBranches(branches, errors) {
  if (!isPlainObject(branches)) {
    errors.push('branches must be an object with allowed and default');
    return null;
  }
  assertNoUnknownFields(branches, new Set(['allowed', 'default']), 'branches', errors);
  const { allowed, default: defaultBranch } = branches;
  if (!stringArray(allowed) || allowed.length === 0) errors.push('branches.allowed must be a non-empty array of strings');
  if (!nonEmptyString(defaultBranch)) errors.push('branches.default is required');
  if (stringArray(allowed) && nonEmptyString(defaultBranch) && !allowed.includes(defaultBranch)) {
    errors.push('branches.default must be a member of branches.allowed');
  }
  if (errors.length) return null;
  return Object.freeze({ allowed: freezeArray(allowed), default: defaultBranch });
}

function validateControlIssue(controlIssue, errors) {
  if (!isPlainObject(controlIssue)) {
    errors.push('controlIssue must be an object identifying exactly one control/status surface');
    return null;
  }
  assertNoUnknownFields(controlIssue, new Set(['mode', 'issueNumber', 'labelSelector']), 'controlIssue', errors);
  const { mode, issueNumber, labelSelector } = controlIssue;
  if (!['fixedIssue', 'labelSelector'].includes(mode)) {
    errors.push('controlIssue.mode must be "fixedIssue" or "labelSelector"');
    return null;
  }
  if (mode === 'fixedIssue') {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) errors.push('controlIssue.issueNumber is required and must be a positive integer for mode "fixedIssue"');
    if (labelSelector !== undefined) errors.push('controlIssue.labelSelector must not be set when mode is "fixedIssue"');
    if (errors.length) return null;
    return Object.freeze({ mode, issueNumber });
  }
  if (!nonEmptyString(labelSelector)) errors.push('controlIssue.labelSelector is required for mode "labelSelector"');
  if (issueNumber !== undefined) errors.push('controlIssue.issueNumber must not be set when mode is "labelSelector"');
  if (errors.length) return null;
  return Object.freeze({ mode, labelSelector });
}

function validateLabels(labels, errors) {
  if (!isPlainObject(labels)) {
    errors.push('labels must be an object mapping stable state names to exact GitHub label strings');
    return null;
  }
  const entries = Object.entries(labels);
  if (entries.length === 0) errors.push('labels must contain at least one state/label mapping');
  const normalized = {};
  const stateByLabelValue = new Map();
  for (const [state, label] of entries) {
    if (!SUPPORTED_LABEL_STATES.includes(state)) {
      errors.push(`labels.${state} is not a recognised label-state key (supported: ${SUPPORTED_LABEL_STATES.join(', ')})`);
      continue;
    }
    if (!nonEmptyString(label) || !LABEL_VALUE_PATTERN.test(label)) {
      errors.push(`labels.${state} must be a safe label string (lowercase letters/digits with -, _ or : separators)`);
      continue;
    }
    const existingState = stateByLabelValue.get(label);
    if (existingState) {
      errors.push(`labels.${state} duplicates label "${label}" already assigned to state "${existingState}"`);
      continue;
    }
    stateByLabelValue.set(label, state);
    normalized[state] = label;
  }
  if (errors.length) return null;
  return Object.freeze(normalized);
}

function validateCapabilities(capabilities, errors) {
  if (!isPlainObject(capabilities)) {
    errors.push('capabilities must be an object with an allowlist');
    return null;
  }
  assertNoUnknownFields(capabilities, new Set(['allowlist']), 'capabilities', errors);
  const { allowlist } = capabilities;
  if (!Array.isArray(allowlist) || !allowlist.every(nonEmptyString)) {
    errors.push('capabilities.allowlist must be an array of strings');
    return null;
  }
  const seen = new Set();
  const normalized = [];
  for (const capability of allowlist) {
    if (!CAPABILITY_VALUE_PATTERN.test(capability)) {
      errors.push(`capabilities.allowlist entry "${capability}" is not a safe capability identifier (lowercase letters/digits with - separators)`);
      continue;
    }
    if (seen.has(capability)) {
      errors.push(`capabilities.allowlist contains a duplicate capability "${capability}"`);
      continue;
    }
    seen.add(capability);
    normalized.push(capability);
  }
  if (errors.length) return null;
  return Object.freeze({ allowlist: freezeArray(normalized) });
}

function validateValidation(validation, errors) {
  if (!isPlainObject(validation)) {
    errors.push('validation must be an object with profile and requiredChecks');
    return null;
  }
  assertNoUnknownFields(validation, new Set(['profile', 'requiredChecks']), 'validation', errors);
  const { profile, requiredChecks } = validation;
  if (!nonEmptyString(profile)) errors.push('validation.profile is required');
  if (!stringArray(requiredChecks) || requiredChecks.length === 0) errors.push('validation.requiredChecks must be a non-empty array of strings');
  if (errors.length) return null;
  return Object.freeze({ profile, requiredChecks: freezeArray(requiredChecks) });
}

function validateMutationBounds(mutationBounds, errors) {
  if (!isPlainObject(mutationBounds)) {
    errors.push('mutationBounds must be an object bounding mutation volume per recurrence');
    return null;
  }
  const allowed = new Set(['maxIssueMutationsPerRecurrence', 'maxCommentsPerRecurrence']);
  assertNoUnknownFields(mutationBounds, allowed, 'mutationBounds', errors);
  const normalized = {};
  for (const key of allowed) {
    const value = mutationBounds[key];
    if (!Number.isInteger(value) || value < 0) {
      errors.push(`mutationBounds.${key} must be a non-negative integer`);
      continue;
    }
    normalized[key] = value;
  }
  if (errors.length) return null;
  return Object.freeze(normalized);
}

function validateEscalation(escalation, errors) {
  if (!isPlainObject(escalation)) {
    errors.push('escalation must be an object with rules');
    return null;
  }
  assertNoUnknownFields(escalation, new Set(['rules']), 'escalation', errors);
  const { rules } = escalation;
  if (!stringArray(rules) || rules.length === 0) errors.push('escalation.rules must be a non-empty array of strings');
  if (errors.length) return null;
  return Object.freeze({ rules: freezeArray(rules) });
}

function validateMutationAuthority(mutationAuthority, errors) {
  if (!isPlainObject(mutationAuthority)) {
    errors.push('mutationAuthority must be an object with explicit booleans for every mutation capability');
    return null;
  }
  assertNoUnknownFields(mutationAuthority, new Set(MUTATION_AUTHORITY_FIELDS), 'mutationAuthority', errors);
  const normalized = {};
  for (const field of MUTATION_AUTHORITY_FIELDS) {
    const value = mutationAuthority[field];
    if (!isBoolean(value)) {
      errors.push(`mutationAuthority.${field} is required and must be a boolean`);
      continue;
    }
    normalized[field] = value;
  }
  if (errors.length) return null;

  // Fail closed on capability combinations that would authorise a mutation
  // without the authority needed to issue or account for it.
  if ((normalized.merge || normalized.close || normalized.deploy || normalized.sourceActivation) && !normalized.authorityIssuance) {
    errors.push('mutationAuthority: merge/close/deploy/sourceActivation require authorityIssuance to also be true');
  }
  if (normalized.deploy && !normalized.merge) {
    errors.push('mutationAuthority: deploy requires merge to also be true');
  }
  if (normalized.close && !normalized.issueMutation) {
    errors.push('mutationAuthority: close requires issueMutation to also be true');
  }
  if (errors.length) return null;
  return Object.freeze(normalized);
}

/**
 * Validate a raw profile object against the versioned schema. Fails closed
 * (throws) on unknown fields, missing required fields, invalid types and
 * unsafe capability combinations. Never mutates GitHub, the filesystem or
 * any other external system.
 */
export function validateManagerProfile(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    throw new Error('Invalid agent runner manager profile: profile must be a JSON object');
  }
  assertNoForbiddenFieldNamesRecursive(input, 'profile', errors);
  assertNoUnknownFields(input, ALLOWED_TOP_LEVEL_FIELDS, 'profile', errors);
  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (!(field in input)) errors.push(`profile.${field} is required`);
  }
  if (errors.length) throw new Error(`Invalid agent runner manager profile: ${errors.join('; ')}`);

  if (input.schemaVersion !== MANAGER_PROFILE_SCHEMA_VERSION) errors.push(`schemaVersion must equal "${MANAGER_PROFILE_SCHEMA_VERSION}"`);
  if (!nonEmptyString(input.projectId)) errors.push('projectId is required');
  if (!isBoolean(input.enabled)) errors.push('enabled is required and must be a boolean');
  if (!nonEmptyString(input.objective)) errors.push('objective is required');
  if (!stringArray(input.nonGoals)) errors.push('nonGoals must be an array of strings');
  if (!stringArray(input.instructionPaths) || input.instructionPaths.length === 0) errors.push('instructionPaths must be a non-empty array of strings');
  if (!nonEmptyString(input.quotaPolicyRef)) errors.push('quotaPolicyRef is required');

  const repository = validateRepository(input.repository, errors);
  const branches = validateBranches(input.branches, errors);
  const controlIssue = validateControlIssue(input.controlIssue, errors);
  const labels = validateLabels(input.labels, errors);
  const capabilities = validateCapabilities(input.capabilities, errors);
  const validation = validateValidation(input.validation, errors);
  const mutationBounds = validateMutationBounds(input.mutationBounds, errors);
  const escalation = validateEscalation(input.escalation, errors);
  const mutationAuthority = validateMutationAuthority(input.mutationAuthority, errors);

  if (errors.length) throw new Error(`Invalid agent runner manager profile: ${errors.join('; ')}`);

  const normalized = Object.freeze({
    schemaVersion: input.schemaVersion,
    projectId: input.projectId,
    enabled: input.enabled,
    repository,
    branches,
    objective: input.objective,
    nonGoals: freezeArray(input.nonGoals),
    instructionPaths: freezeArray(input.instructionPaths),
    controlIssue,
    labels,
    capabilities,
    validation,
    quotaPolicyRef: input.quotaPolicyRef,
    mutationBounds,
    escalation,
    mutationAuthority,
  });
  VALIDATED_PROFILES.add(normalized);
  return normalized;
}

export function managerProfileRepositoryFull(profile) {
  return profile?.repository?.full ?? null;
}

function isFrozenPlainObject(value) {
  return isPlainObject(value) && Object.isFrozen(value);
}

function isFrozenStringArray(value) {
  return Array.isArray(value) && Object.isFrozen(value) && value.every((item) => typeof item === 'string');
}

/**
 * A profile carrying the right `schemaVersion` -- even one that is deeply
 * frozen and otherwise shaped exactly like a real validated profile -- is
 * not proof it passed `validateManagerProfile()`: an adversarial or
 * hand-built object could replicate every field and freeze it identically.
 * `resolveManagerContext` must refuse to trust anything that merely *looks*
 * validated, so provenance is checked against `VALIDATED_PROFILES`, a
 * `WeakSet` populated only by `validateManagerProfile()` itself and
 * therefore unforgeable by constructing a look-alike object. The exact
 * frozen, normalized shape `validateManagerProfile()` produces is still
 * checked afterwards as defense in depth.
 */
export function assertNormalizedManagerProfileShape(profile) {
  const errors = [];
  if (!isFrozenPlainObject(profile) || !VALIDATED_PROFILES.has(profile)) {
    throw new Error('resolveManagerContext requires an already-validated manager profile: object was not produced by validateManagerProfile');
  }
  if (profile.schemaVersion !== MANAGER_PROFILE_SCHEMA_VERSION) errors.push('schemaVersion');
  if (!nonEmptyString(profile.projectId)) errors.push('projectId');
  if (!isBoolean(profile.enabled)) errors.push('enabled');
  if (!nonEmptyString(profile.objective)) errors.push('objective');
  if (!isFrozenStringArray(profile.nonGoals)) errors.push('nonGoals');
  if (!isFrozenStringArray(profile.instructionPaths) || profile.instructionPaths.length === 0) errors.push('instructionPaths');
  if (!nonEmptyString(profile.quotaPolicyRef)) errors.push('quotaPolicyRef');
  if (!isFrozenPlainObject(profile.repository) || !nonEmptyString(profile.repository.full)) errors.push('repository');
  if (!isFrozenPlainObject(profile.branches) || !isFrozenStringArray(profile.branches.allowed)) errors.push('branches');
  if (!isFrozenPlainObject(profile.controlIssue) || !['fixedIssue', 'labelSelector'].includes(profile.controlIssue.mode)) errors.push('controlIssue');
  if (!isFrozenPlainObject(profile.labels)) errors.push('labels');
  if (!isFrozenPlainObject(profile.capabilities) || !isFrozenStringArray(profile.capabilities.allowlist)) errors.push('capabilities');
  if (!isFrozenPlainObject(profile.validation) || !isFrozenStringArray(profile.validation.requiredChecks)) errors.push('validation');
  if (!isFrozenPlainObject(profile.mutationBounds)) errors.push('mutationBounds');
  if (!isFrozenPlainObject(profile.escalation) || !isFrozenStringArray(profile.escalation.rules)) errors.push('escalation');
  if (!isFrozenPlainObject(profile.mutationAuthority)
    || !MUTATION_AUTHORITY_FIELDS.every((field) => isBoolean(profile.mutationAuthority[field]))) {
    errors.push('mutationAuthority');
  }
  if (errors.length) {
    throw new Error(`resolveManagerContext requires an already-validated manager profile: invalid or unfrozen fields: ${errors.join(', ')}`);
  }
}
