import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const FAILURE_SCOPES = Object.freeze({
  SYSTEMIC: 'systemic',
  MACHINE_PROFILE: 'machine_profile',
  ISSUE_NOT_RUNNABLE: 'issue_not_runnable',
  TASK_ATTEMPT: 'task_attempt',
  COMPLETED: 'completed',
});

const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function normalizeImplementationApprovers(value) {
  const entries = String(value || '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(entries)];
  const invalid = unique.filter((entry) => !LOGIN.test(entry));
  return { approvers: unique, invalid };
}

export function executionRequested(argv = [], env = process.env) {
  if (argv.includes('--dry-run')) return false;
  return argv.includes('--execute') || truthy(env.CLAUDE_RUNNER_CRON_EXECUTE);
}

export function configurationFingerprint({ env = process.env, approvers = [] } = {}) {
  const material = JSON.stringify({
    implementationEnabled: truthy(env.CLAUDE_RUNNER_ALLOW_IMPLEMENTATION),
    generatedPreflightImplementationEnabled: truthy(env.CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION),
    approvers,
    acceptedAgentLabels: String(env.CLAUDE_RUNNER_CRON_AGENT_LABELS || '').trim().toLowerCase(),
  });
  return `sha256:${createHash('sha256').update(material).digest('hex')}`;
}

export function admitMachineProfile({ argv = [], env = process.env } = {}) {
  const requested = executionRequested(argv, env);
  const { approvers, invalid } = normalizeImplementationApprovers(env.CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS);
  const fingerprint = configurationFingerprint({ env, approvers });

  if (!requested) {
    return {
      allowed: true,
      scope: null,
      reason: 'dry-run',
      safeNextAction: 'Continue with non-mutating scheduler inspection.',
      configurationFingerprint: fingerprint,
      candidateRevision: null,
    };
  }

  if (truthy(env.CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION)) {
    return {
      allowed: false,
      scope: FAILURE_SCOPES.MACHINE_PROFILE,
      reason: 'generated-preflight-implementation-prohibited',
      safeNextAction: 'Unset CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION. Only a normal ChatGPT manager packet may authorise implementation.',
      configurationFingerprint: fingerprint,
      candidateRevision: null,
    };
  }

  if (!truthy(env.CLAUDE_RUNNER_ALLOW_IMPLEMENTATION)) {
    return {
      allowed: false,
      scope: FAILURE_SCOPES.MACHINE_PROFILE,
      reason: 'implementation-machine-opt-in-disabled',
      safeNextAction: 'Enable implementation explicitly through the approved installer after confirming the approver allowlist.',
      configurationFingerprint: fingerprint,
      candidateRevision: null,
    };
  }

  if (approvers.length === 0) {
    return {
      allowed: false,
      scope: FAILURE_SCOPES.MACHINE_PROFILE,
      reason: 'implementation-approver-allowlist-empty',
      safeNextAction: 'Configure one or more approved lowercase GitHub logins before enabling execution.',
      configurationFingerprint: fingerprint,
      candidateRevision: null,
    };
  }

  if (invalid.length > 0) {
    return {
      allowed: false,
      scope: FAILURE_SCOPES.MACHINE_PROFILE,
      reason: 'implementation-approver-allowlist-invalid',
      safeNextAction: 'Replace malformed approver entries with valid GitHub logins.',
      configurationFingerprint: fingerprint,
      candidateRevision: null,
    };
  }

  return {
    allowed: true,
    scope: null,
    reason: 'machine-profile-admitted',
    safeNextAction: 'Continue to candidate-specific admission before creating an attempt or mutating GitHub.',
    configurationFingerprint: fingerprint,
    candidateRevision: null,
  };
}

export function machineProfilePausePayload(admission) {
  return {
    profilePaused: true,
    failureScope: admission.scope,
    reason: admission.reason,
    safeNextAction: admission.safeNextAction,
    configurationFingerprint: admission.configurationFingerprint,
    selectedIssue: null,
    childLaunched: false,
    issueMutation: false,
    systemdOutcome: 'handled',
  };
}

export function main(argv = process.argv.slice(2), env = process.env, logger = console) {
  const admission = admitMachineProfile({ argv, env });
  if (admission.allowed) return 0;
  logger.log(JSON.stringify(machineProfilePausePayload(admission), null, 2));
  return 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
