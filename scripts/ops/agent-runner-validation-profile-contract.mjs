import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { localExecutorProjectPolicy } from './agent-runner-local-executor-policy.mjs';

export const VALIDATION_EVIDENCE_SCHEMA_VERSION = 1;
export const VALIDATION_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
export const VALIDATION_REQUEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const VALIDATION_FINAL_STATES = new Set(['succeeded', 'failed']);
export const VALIDATION_INTERNAL_MARKER_PREFIX = 'AGENT_RUNNER_INTERNAL_VALIDATION_';

export class ValidationEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ValidationEvidenceError';
    this.code = code;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validationStableValue(value) {
  if (Array.isArray(value)) return value.map(validationStableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, validationStableValue(value[key])]),
  );
}

export function validationStableJson(value) {
  return JSON.stringify(validationStableValue(value));
}

export function validationDigest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function validationIso(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ValidationEvidenceError('invalid-request', `${name} is invalid`);
  }
  return date.toISOString();
}

function profileContract(projectPolicy, profileName) {
  const profile = projectPolicy?.validationProfiles?.[profileName];
  if (!profile) {
    throw new ValidationEvidenceError(
      'validation-profile-not-allowed',
      'validation profile is not configured',
    );
  }
  for (const command of profile.commands) {
    if (
      command.environment.some(
        (name) => name.startsWith(VALIDATION_INTERNAL_MARKER_PREFIX),
      )
    ) {
      throw new ValidationEvidenceError(
        'reserved-environment-name',
        'validation profile uses a reserved environment name',
      );
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    profile: profileName,
    commands: Object.freeze(
      profile.commands.map((command, ordinal) => Object.freeze({
        ordinal,
        argv: Object.freeze([...command.argv]),
        workingDirectory: command.workingDirectory,
        environmentNames: Object.freeze([...command.environment]),
        timeoutSeconds: command.timeoutSeconds,
      })),
    ),
    requireCleanBefore: profile.requireCleanBefore,
    requireCleanAfter: profile.requireCleanAfter,
    artifacts: Object.freeze([...profile.artifacts]),
    evidenceTtlSeconds: profile.evidenceTtlSeconds,
    maxOutputBytes: projectPolicy.maxOutputBytes,
    maxArtifactCount: projectPolicy.maxValidationArtifactCount,
    maxArtifactBytes: projectPolicy.maxValidationArtifactBytes,
  });
}

export function validationProfileContractSha256(
  policy,
  projectId,
  profileName,
) {
  const projectPolicy = localExecutorProjectPolicy(policy, projectId);
  if (!projectPolicy) {
    throw new ValidationEvidenceError(
      'project-not-enabled',
      'validation project is not enabled',
    );
  }
  return validationDigest(
    validationStableJson(profileContract(projectPolicy, profileName)),
  );
}

export function validationCommandContract(
  policy,
  projectId,
  profileName,
) {
  const projectPolicy = localExecutorProjectPolicy(policy, projectId);
  const profile = projectPolicy?.validationProfiles?.[profileName];
  if (!profile) {
    throw new ValidationEvidenceError(
      'validation-profile-not-allowed',
      'validation profile is not configured',
    );
  }
  return Object.freeze(
    profile.commands.map((command, ordinal) => Object.freeze({
      ordinal,
      executable: basename(command.argv[0]),
      argvSha256: validationDigest(validationStableJson(command.argv)),
      workingDirectory: command.workingDirectory,
      environmentNames: Object.freeze([...command.environment]),
      timeoutSeconds: command.timeoutSeconds,
    })),
  );
}

export function requiredProfilesForRisk(policy, projectId, riskClass) {
  const projectPolicy = localExecutorProjectPolicy(policy, projectId);
  if (!projectPolicy) {
    throw new ValidationEvidenceError(
      'project-not-enabled',
      'validation project is not enabled',
    );
  }
  const profiles = projectPolicy.requiredValidationProfiles?.[riskClass];
  if (!profiles || profiles.length === 0) {
    throw new ValidationEvidenceError(
      'risk-profile-not-configured',
      'validation risk class has no configured profile mapping',
    );
  }
  return Object.freeze([...profiles]);
}

export function evaluateValidationFreshness(evidence, {
  projectId = evidence?.projectId,
  profile = evidence?.profile,
  expectedSha = evidence?.expectedSha,
  currentProfileContractSha256 = null,
  now = new Date().toISOString(),
} = {}) {
  if (!evidence || evidence.state !== 'succeeded') {
    return Object.freeze({
      fresh: false,
      reason: 'validation-not-successful',
    });
  }
  if (evidence.projectId !== projectId || evidence.profile !== profile) {
    return Object.freeze({
      fresh: false,
      reason: 'validation-contract-mismatch',
    });
  }
  if (evidence.schemaVersion === VALIDATION_EVIDENCE_SCHEMA_VERSION) {
    if (!currentProfileContractSha256) {
      return Object.freeze({
        fresh: false,
        reason: 'validation-profile-contract-not-revalidated',
      });
    }
    if (evidence.profileContractSha256 !== currentProfileContractSha256) {
      return Object.freeze({
        fresh: false,
        reason: 'validation-profile-contract-changed',
      });
    }
  } else if (
    currentProfileContractSha256
    && evidence.profileContractSha256 !== currentProfileContractSha256
  ) {
    return Object.freeze({
      fresh: false,
      reason: 'validation-profile-contract-changed',
    });
  }
  if (
    evidence.expectedSha !== expectedSha
    || evidence.observedSha !== expectedSha
  ) {
    return Object.freeze({
      fresh: false,
      reason: 'validation-sha-mismatch',
    });
  }
  if (
    !Number.isFinite(Date.parse(evidence.expiresAt))
    || Date.parse(evidence.expiresAt)
      <= Date.parse(validationIso(now, 'freshness timestamp'))
  ) {
    return Object.freeze({
      fresh: false,
      reason: 'validation-expired',
    });
  }
  return Object.freeze({ fresh: true, reason: 'validation-fresh' });
}

function commandComparison(value) {
  return value.commands.map((command) => ({
    ordinal: command.ordinal,
    argvSha256: command.argvSha256,
    workingDirectory: command.workingDirectory,
    environmentNames: command.environmentNames,
    timeoutSeconds: command.timeoutSeconds,
  }));
}

export function comparePostMergeValidation(preMerge, postMerge) {
  if (
    !preMerge
    || !postMerge
    || preMerge.state !== 'succeeded'
    || postMerge.state !== 'succeeded'
  ) {
    return Object.freeze({
      comparable: false,
      reason: 'validation-not-successful',
    });
  }
  if (
    preMerge.projectId !== postMerge.projectId
    || preMerge.profile !== postMerge.profile
  ) {
    return Object.freeze({
      comparable: false,
      reason: 'validation-contract-mismatch',
    });
  }
  if (
    preMerge.expectedSha !== preMerge.observedSha
    || postMerge.expectedSha !== postMerge.observedSha
  ) {
    return Object.freeze({
      comparable: false,
      reason: 'validation-sha-mismatch',
    });
  }
  if (
    preMerge.schemaVersion === VALIDATION_EVIDENCE_SCHEMA_VERSION
    || postMerge.schemaVersion === VALIDATION_EVIDENCE_SCHEMA_VERSION
  ) {
    if (
      !VALIDATION_SHA_PATTERN.test(preMerge.profileContractSha256 || '')
      || !VALIDATION_SHA_PATTERN.test(postMerge.profileContractSha256 || '')
      || preMerge.profileContractSha256 !== postMerge.profileContractSha256
    ) {
      return Object.freeze({
        comparable: false,
        reason: 'command-contract-changed',
      });
    }
  } else if (
    preMerge.profileContractSha256
    && postMerge.profileContractSha256
    && preMerge.profileContractSha256 !== postMerge.profileContractSha256
  ) {
    return Object.freeze({
      comparable: false,
      reason: 'command-contract-changed',
    });
  }
  if (Date.parse(postMerge.finishedAt) < Date.parse(preMerge.finishedAt)) {
    return Object.freeze({
      comparable: false,
      reason: 'post-merge-validation-older',
    });
  }
  const commandsEqual = validationStableJson(commandComparison(preMerge))
    === validationStableJson(commandComparison(postMerge));
  const preArtifacts = Object.fromEntries(
    preMerge.artifacts.map(
      (artifact) => [artifact.relativePath, artifact.sha256],
    ),
  );
  const postArtifacts = Object.fromEntries(
    postMerge.artifacts.map(
      (artifact) => [artifact.relativePath, artifact.sha256],
    ),
  );
  return Object.freeze({
    comparable: commandsEqual,
    reason: commandsEqual
      ? 'validation-comparable'
      : 'command-contract-changed',
    preMergeSha: preMerge.observedSha,
    postMergeSha: postMerge.observedSha,
    artifactDigestsEqual:
      validationStableJson(preArtifacts) === validationStableJson(postArtifacts),
  });
}
