import { readFileSync } from 'node:fs';
import { isAbsolute, posix, resolve } from 'node:path';

const POLICY_ENV = 'AGENT_RUNNER_LOCAL_EXECUTOR_POLICY';
const OPERATION_NAMES = Object.freeze([
  'project.inspect',
  'repository.fetch',
  'repository.sync-default',
  'worktree.create',
  'worktree.inspect',
  'worktree.remove',
  'validation.run',
]);
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const RISK_CLASSES = Object.freeze(['R0', 'R1', 'R2', 'R3', 'R4']);
const MAX_ARTIFACT_COUNT = 32;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value, fallback, { min = 1, max = 24 * 60 * 60 } = {}) {
  if (value == null) return fallback;
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function normalizeRelativePath(value, name, { allowDot = true } = {}) {
  if (!nonEmptyString(value) || isAbsolute(value) || value.includes('\\')) {
    throw new Error(`Invalid local executor policy: ${name} must be a relative POSIX path`);
  }
  const normalized = posix.normalize(value);
  if ((!allowDot && normalized === '.') || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid local executor policy: ${name} escapes the validation target`);
  }
  if (normalized.length > 512) {
    throw new Error(`Invalid local executor policy: ${name} exceeds bounds`);
  }
  return normalized;
}

function normalizeCommand(command, profileName, index) {
  if (!isPlainObject(command)) {
    throw new Error(`Invalid local executor policy: validationProfiles.${profileName}.commands[${index}] must be an object`);
  }
  if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some((part) => !nonEmptyString(part))) {
    throw new Error(`Invalid local executor policy: validationProfiles.${profileName}.commands[${index}].argv must contain strings`);
  }
  if (command.argv.length > 128 || command.argv.some((part) => part.length > 4_096)) {
    throw new Error(`Invalid local executor policy: validationProfiles.${profileName}.commands[${index}].argv exceeds bounds`);
  }
  const timeoutSeconds = positiveInteger(command.timeoutSeconds, 1_800);
  if (timeoutSeconds == null) {
    throw new Error(`Invalid local executor policy: validationProfiles.${profileName}.commands[${index}].timeoutSeconds is invalid`);
  }
  const environment = command.environment ?? [];
  if (!Array.isArray(environment) || environment.some((name) => !ENV_NAME_PATTERN.test(name))) {
    throw new Error(`Invalid local executor policy: validationProfiles.${profileName}.commands[${index}].environment is invalid`);
  }
  if (environment.length > 64) {
    throw new Error(`Invalid local executor policy: validationProfiles.${profileName}.commands[${index}].environment exceeds bounds`);
  }
  return Object.freeze({
    argv: Object.freeze([...command.argv]),
    timeoutSeconds,
    environment: Object.freeze([...new Set(environment)]),
    workingDirectory: normalizeRelativePath(
      command.workingDirectory ?? '.',
      `validationProfiles.${profileName}.commands[${index}].workingDirectory`,
    ),
  });
}

function normalizeArtifacts(value, profileName) {
  const artifacts = value ?? [];
  if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACT_COUNT) {
    throw new Error(`Invalid local executor policy: validationProfiles.${profileName}.artifacts exceeds bounds`);
  }
  const normalized = artifacts.map((artifact, index) => normalizeRelativePath(
    artifact,
    `validationProfiles.${profileName}.artifacts[${index}]`,
    { allowDot: false },
  ));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Invalid local executor policy: validationProfiles.${profileName}.artifacts contains duplicates`);
  }
  return Object.freeze(normalized);
}

function normalizeRiskClasses(value, profileName) {
  const riskClasses = value ?? [];
  if (!Array.isArray(riskClasses) || riskClasses.some((riskClass) => !RISK_CLASSES.includes(riskClass))) {
    throw new Error(`Invalid local executor policy: validationProfiles.${profileName}.riskClasses is invalid`);
  }
  return Object.freeze([...new Set(riskClasses)]);
}

function normalizeValidationProfiles(value, projectId) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw new Error(`Invalid local executor policy: project ${projectId} requires validationProfiles`);
  }
  const profiles = {};
  for (const [name, profile] of Object.entries(value)) {
    if (!PROFILE_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid local executor policy: invalid validation profile '${name}' for ${projectId}`);
    }
    if (!isPlainObject(profile) || !Array.isArray(profile.commands) || profile.commands.length === 0) {
      throw new Error(`Invalid local executor policy: validationProfiles.${name}.commands is required`);
    }
    if (profile.commands.length > 64) {
      throw new Error(`Invalid local executor policy: validationProfiles.${name}.commands exceeds bounds`);
    }
    const evidenceTtlSeconds = positiveInteger(profile.evidenceTtlSeconds, 6 * 60 * 60, {
      min: 60,
      max: 7 * 24 * 60 * 60,
    });
    if (evidenceTtlSeconds == null) {
      throw new Error(`Invalid local executor policy: validationProfiles.${name}.evidenceTtlSeconds is invalid`);
    }
    profiles[name] = Object.freeze({
      commands: Object.freeze(profile.commands.map((command, index) => normalizeCommand(command, name, index))),
      requireCleanBefore: profile.requireCleanBefore !== false,
      requireCleanAfter: profile.requireCleanAfter !== false,
      artifacts: normalizeArtifacts(profile.artifacts, name),
      evidenceTtlSeconds,
      riskClasses: normalizeRiskClasses(profile.riskClasses, name),
    });
  }
  return Object.freeze(profiles);
}

function normalizeRequiredValidationProfiles(value, profiles, projectId) {
  const mapping = value ?? {};
  if (!isPlainObject(mapping)) {
    throw new Error(`Invalid local executor policy: project ${projectId} requiredValidationProfiles must be an object`);
  }
  const normalized = {};
  for (const [riskClass, names] of Object.entries(mapping)) {
    if (!RISK_CLASSES.includes(riskClass) || !Array.isArray(names) || names.length === 0) {
      throw new Error(`Invalid local executor policy: project ${projectId} requiredValidationProfiles.${riskClass} is invalid`);
    }
    if (names.some((name) => !PROFILE_NAME_PATTERN.test(name) || !profiles[name])) {
      throw new Error(`Invalid local executor policy: project ${projectId} requiredValidationProfiles.${riskClass} references an unknown profile`);
    }
    normalized[riskClass] = Object.freeze([...new Set(names)]);
  }
  return Object.freeze(normalized);
}

function normalizeProject(input, index) {
  if (!isPlainObject(input)) throw new Error(`Invalid local executor policy: projects[${index}] must be an object`);
  if (!PROJECT_ID_PATTERN.test(input.projectId || '')) {
    throw new Error(`Invalid local executor policy: projects[${index}].projectId is invalid`);
  }
  if (!nonEmptyString(input.defaultBranch)) {
    throw new Error(`Invalid local executor policy: project ${input.projectId} requires defaultBranch`);
  }
  if (!nonEmptyString(input.worktreeRoot) || !isAbsolute(input.worktreeRoot)) {
    throw new Error(`Invalid local executor policy: project ${input.projectId} worktreeRoot must be absolute`);
  }
  const allowedOperations = input.allowedOperations ?? [];
  if (!Array.isArray(allowedOperations) || allowedOperations.length === 0) {
    throw new Error(`Invalid local executor policy: project ${input.projectId} requires allowedOperations`);
  }
  for (const operation of allowedOperations) {
    if (!OPERATION_NAMES.includes(operation)) {
      throw new Error(`Invalid local executor policy: unsupported operation '${operation}' for ${input.projectId}`);
    }
  }
  const maxOutputBytes = positiveInteger(input.maxOutputBytes, 2 * 1024 * 1024, {
    min: 1_024,
    max: 50 * 1024 * 1024,
  });
  if (maxOutputBytes == null) {
    throw new Error(`Invalid local executor policy: project ${input.projectId} maxOutputBytes is invalid`);
  }
  const maxValidationArtifactCount = positiveInteger(input.maxValidationArtifactCount, 16, {
    min: 1,
    max: MAX_ARTIFACT_COUNT,
  });
  if (maxValidationArtifactCount == null) {
    throw new Error(`Invalid local executor policy: project ${input.projectId} maxValidationArtifactCount is invalid`);
  }
  const maxValidationArtifactBytes = positiveInteger(input.maxValidationArtifactBytes, 5 * 1024 * 1024, {
    min: 1,
    max: MAX_ARTIFACT_BYTES,
  });
  if (maxValidationArtifactBytes == null) {
    throw new Error(`Invalid local executor policy: project ${input.projectId} maxValidationArtifactBytes is invalid`);
  }
  const validationProfiles = normalizeValidationProfiles(input.validationProfiles, input.projectId);
  return Object.freeze({
    projectId: input.projectId,
    defaultBranch: input.defaultBranch,
    worktreeRoot: resolve(input.worktreeRoot),
    allowedOperations: Object.freeze([...new Set(allowedOperations)]),
    validationProfiles,
    requiredValidationProfiles: normalizeRequiredValidationProfiles(
      input.requiredValidationProfiles,
      validationProfiles,
      input.projectId,
    ),
    maxOutputBytes,
    maxValidationArtifactCount,
    maxValidationArtifactBytes,
  });
}

export function validateLocalExecutorPolicy(input) {
  if (!isPlainObject(input)) throw new Error('Invalid local executor policy: policy must be a JSON object');
  if (input.schemaVersion !== 1) throw new Error('Invalid local executor policy: schemaVersion must equal 1');
  if (!Array.isArray(input.projects) || input.projects.length === 0) {
    throw new Error('Invalid local executor policy: projects must contain at least one entry');
  }
  const projects = input.projects.map(normalizeProject);
  const byId = {};
  const worktreeRoots = new Map();
  for (const project of projects) {
    if (byId[project.projectId]) {
      throw new Error(`Invalid local executor policy: duplicate projectId '${project.projectId}'`);
    }
    const rootOwner = worktreeRoots.get(project.worktreeRoot);
    if (rootOwner) {
      throw new Error(`Invalid local executor policy: duplicate worktreeRoot '${project.worktreeRoot}' for ${rootOwner} and ${project.projectId}`);
    }
    byId[project.projectId] = project;
    worktreeRoots.set(project.worktreeRoot, project.projectId);
  }
  return Object.freeze({
    schemaVersion: 1,
    projects: Object.freeze(projects),
    projectsById: Object.freeze(byId),
  });
}

export function resolveLocalExecutorPolicyPath(argv = [], env = process.env) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--executor-policy') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--executor-policy requires a value');
      return value;
    }
    if (arg.startsWith('--executor-policy=')) return arg.slice('--executor-policy='.length);
  }
  return env[POLICY_ENV] || null;
}

export function stripLocalExecutorPolicyArgs(argv = []) {
  const result = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--executor-policy') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--executor-policy=')) continue;
    result.push(arg);
  }
  return result;
}

export function loadLocalExecutorPolicy({
  argv = [],
  env = process.env,
  policyPath = resolveLocalExecutorPolicyPath(argv, env),
} = {}) {
  if (!policyPath) {
    throw new Error('No local executor policy configured; use --executor-policy or AGENT_RUNNER_LOCAL_EXECUTOR_POLICY');
  }
  const absolutePath = resolve(policyPath);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid local executor policy JSON at ${absolutePath}: ${error.message}`);
    throw new Error(`Unable to read local executor policy at ${absolutePath}: ${error.message}`);
  }
  return Object.freeze({ ...validateLocalExecutorPolicy(parsed), policyPath: absolutePath });
}

export function localExecutorProjectPolicy(policy, projectId) {
  return policy?.projectsById?.[projectId] ?? null;
}

export {
  OPERATION_NAMES as LOCAL_EXECUTOR_OPERATION_NAMES,
  RISK_CLASSES as LOCAL_EXECUTOR_RISK_CLASSES,
};
