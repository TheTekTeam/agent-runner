#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { configurationFingerprint, normalizeImplementationApprovers } from './agent-runner-admission.mjs';
import { resolveAgentForLabels } from './agent-runner-agents.mjs';
import { defaultCircuitDbPath } from './agent-runner-circuit-breaker.mjs';
import {
  CandidateProfileCircuitBreaker,
  candidateEffectiveCostFingerprint,
  candidateProfileCircuitPausePayload,
} from './agent-runner-candidate-profile-circuit.mjs';
import {
  parseManagerPreflightPacket,
  resolveManagerPreflightExecutionMetadata,
  resolveManagerPreflightRequiredCapabilities,
} from './agent-runner-manager-authority.mjs';
import { executionLabelAuthority } from './agent-runner-label-authority.mjs';
import {
  AVAILABLE_CAPABILITY_IDS,
  evaluateCapabilityCompatibility,
} from './claude-runner-capability-model.mjs';
import {
  commentRevision,
  normalizeCommentIdentity,
  sameCommentIdentity,
} from './claude-runner-comment-identity.mjs';
import {
  evaluateClaudeCostAdmission,
  inferProfile,
  resolveProfile,
} from './claude-runner.mjs';

export const CANDIDATE_PAUSED_EXIT_CODE = 3;
export const CANDIDATE_REVALIDATION_FAILURE_EXIT_CODE = 1;
export const CANDIDATE_REVALIDATION_FAILURE_SCOPE = 'candidate_revalidation';
export const DEFAULT_CANDIDATE_SELECTION_TIMEOUT_MS = 30_000;
export const NEW_CLAIM_AUTHORIZATION_MODE = 'preflight-direct';
export const IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH = 'implementation-tool-capability-mismatch';

const MIN_CANDIDATE_SELECTION_TIMEOUT_MS = 50;
const MAX_CANDIDATE_SELECTION_TIMEOUT_MS = 60_000;

export function candidateSelectionTimeoutMs(env = process.env) {
  const raw = String(env.AGENT_RUNNER_CANDIDATE_SELECTION_TIMEOUT_MS ?? '').trim();
  if (!raw) return DEFAULT_CANDIDATE_SELECTION_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_CANDIDATE_SELECTION_TIMEOUT_MS;
  return Math.max(
    MIN_CANDIDATE_SELECTION_TIMEOUT_MS,
    Math.min(MAX_CANDIDATE_SELECTION_TIMEOUT_MS, Math.trunc(parsed)),
  );
}

function preflightAuthor(preflight) {
  return String(
    preflight?.user?.login
      || preflight?.author?.login
      || preflight?.authorLogin
      || '',
  ).trim().toLowerCase() || null;
}

export function candidateSnapshot(selected = {}) {
  const commandIdentity = normalizeCommentIdentity(selected.command?.sourceCommentIdentity || selected.command?.sourceCommentId);
  const preflightIdentity = normalizeCommentIdentity(selected.currentPreflight);
  const managerAuthority = selected.selection?.managerAuthority?.valid
    ? selected.selection.managerAuthority
    : parseManagerPreflightPacket(selected.currentPreflight);
  const labelAuthority = selected.issue ? executionLabelAuthority(selected.issue) : {
    allowed: false,
    reason: 'candidate-no-longer-runnable',
    statusLabel: null,
    agentLabel: null,
    evidence: { statusLabels: [], agentLabels: [] },
  };
  const resolvedAgentId = labelAuthority.agentLabel
    ? resolveAgentForLabels([labelAuthority.agentLabel])?.agentId ?? null
    : null;
  return {
    issueNumber: selected.issue?.number || null,
    statusLabel: labelAuthority.statusLabel,
    agentLabel: labelAuthority.agentLabel,
    resolvedAgentId,
    labelAuthorityAllowed: labelAuthority.allowed,
    labelAuthorityReason: labelAuthority.reason,
    labelAuthorityEvidence: labelAuthority.evidence,
    selectedStatusLabel: selected.issue?.statusLabel || null,
    selectedAgentLabel: selected.issue?.agentLabel || null,
    selectionMode: selected.selection?.mode || null,
    commandKind: selected.command?.kind || null,
    commandIdentity,
    commandRevision: commentRevision(commandIdentity),
    preflightIdentity,
    preflightRevision: managerAuthority.valid ? managerAuthority.revision : null,
    preflightFingerprint: managerAuthority.valid ? managerAuthority.fingerprint : null,
    preflightAuthorityKey: managerAuthority.valid ? managerAuthority.authorityKey : null,
    preflightBodyDigest: managerAuthority.valid ? managerAuthority.packetDigest : null,
    preflightPacketValid: managerAuthority.valid === true,
    preflightPacketReason: managerAuthority.valid ? null : managerAuthority.reason,
    preflightApprovedAgent: managerAuthority.valid ? managerAuthority.approvedAgent : null,
    preflightCommentRevision: commentRevision(preflightIdentity),
    preflightAuthor: preflightAuthor(selected.currentPreflight),
  };
}

export function normalizeCandidateSnapshot(snapshot = {}) {
  const commandIdentity = normalizeCommentIdentity(snapshot.commandIdentity || snapshot.commandRevision);
  const preflightIdentity = normalizeCommentIdentity(snapshot.preflightIdentity || snapshot.preflightCommentRevision);
  return {
    issueNumber: snapshot.issueNumber || null,
    statusLabel: snapshot.statusLabel || null,
    agentLabel: snapshot.agentLabel || null,
    resolvedAgentId: snapshot.resolvedAgentId || null,
    labelAuthorityAllowed: snapshot.labelAuthorityAllowed !== false,
    labelAuthorityReason: snapshot.labelAuthorityReason || null,
    labelAuthorityEvidence: snapshot.labelAuthorityEvidence || null,
    selectedStatusLabel: snapshot.selectedStatusLabel || null,
    selectedAgentLabel: snapshot.selectedAgentLabel || null,
    selectionMode: snapshot.selectionMode || null,
    commandKind: snapshot.commandKind || null,
    commandIdentity,
    commandRevision: commentRevision(commandIdentity),
    preflightIdentity,
    preflightRevision: snapshot.preflightRevision || null,
    preflightFingerprint: snapshot.preflightFingerprint || null,
    preflightAuthorityKey: snapshot.preflightAuthorityKey || null,
    preflightBodyDigest: snapshot.preflightBodyDigest || null,
    preflightPacketValid: snapshot.preflightPacketValid === true,
    preflightPacketReason: snapshot.preflightPacketReason || null,
    preflightApprovedAgent: snapshot.preflightApprovedAgent ? String(snapshot.preflightApprovedAgent).trim().toLowerCase() : null,
    preflightCommentRevision: commentRevision(preflightIdentity),
    preflightAuthor: snapshot.preflightAuthor ? String(snapshot.preflightAuthor).trim().toLowerCase() : null,
  };
}

export function commandRevisionChanged(initial, current) {
  return initial.commandKind !== null
    || current.commandKind !== null
    || initial.commandIdentity !== null
    || current.commandIdentity !== null;
}

export function evaluateCandidateAdmission({ initial, current, approvers = [] } = {}) {
  if (!initial?.issueNumber || !current?.issueNumber) {
    return { allowed: false, reason: 'candidate-no-longer-runnable' };
  }
  if (initial.issueNumber !== current.issueNumber) {
    return { allowed: false, reason: 'candidate-selection-changed' };
  }
  if (initial.labelAuthorityAllowed !== true) {
    return { allowed: false, reason: initial.labelAuthorityReason || 'candidate-label-authority-invalid' };
  }
  if (current.labelAuthorityAllowed !== true) {
    return { allowed: false, reason: current.labelAuthorityReason || 'candidate-label-authority-invalid' };
  }
  if (current.selectedStatusLabel && current.selectedStatusLabel !== current.statusLabel) {
    return { allowed: false, reason: 'candidate-status-field-label-conflict' };
  }
  if (current.selectedAgentLabel && current.selectedAgentLabel !== current.agentLabel) {
    return { allowed: false, reason: 'candidate-agent-field-label-conflict' };
  }
  if (initial.statusLabel !== current.statusLabel || !['status:ready', 'status:in-progress'].includes(current.statusLabel)) {
    return { allowed: false, reason: 'candidate-status-changed' };
  }
  if (initial.agentLabel !== current.agentLabel) {
    return { allowed: false, reason: 'candidate-agent-changed' };
  }
  if (initial.resolvedAgentId !== current.resolvedAgentId) {
    return { allowed: false, reason: 'candidate-agent-changed' };
  }
  if (initial.selectionMode !== current.selectionMode) {
    return { allowed: false, reason: 'candidate-dispatch-mode-changed' };
  }
  if (current.selectionMode !== NEW_CLAIM_AUTHORIZATION_MODE) {
    return { allowed: false, reason: 'candidate-manager-preflight-required' };
  }
  if (commandRevisionChanged(initial, current)) {
    return { allowed: false, reason: 'candidate-proceed-command-not-authoritative' };
  }
  if (current.preflightPacketValid !== true || !current.preflightAuthorityKey) {
    return { allowed: false, reason: current.preflightPacketReason || 'candidate-manager-preflight-invalid' };
  }
  if (!current.resolvedAgentId || current.preflightApprovedAgent !== current.resolvedAgentId) {
    return { allowed: false, reason: 'candidate-preflight-agent-not-approved' };
  }
  if (!initial.preflightAuthorityKey || initial.preflightAuthorityKey !== current.preflightAuthorityKey) {
    return { allowed: false, reason: 'candidate-preflight-revision-changed' };
  }
  if (!initial.preflightBodyDigest || initial.preflightBodyDigest !== current.preflightBodyDigest) {
    return { allowed: false, reason: 'candidate-preflight-content-changed' };
  }
  if (!current.preflightIdentity) {
    return { allowed: false, reason: 'candidate-preflight-comment-identity-unavailable' };
  }
  if (!current.preflightAuthor || !approvers.includes(current.preflightAuthor)) {
    return { allowed: false, reason: 'candidate-preflight-author-not-approved' };
  }
  return { allowed: true, reason: 'candidate-admitted' };
}

/**
 * #229: compare the immutable manager-declared implementation capabilities
 * with the exact currently-available #228 Claude capability contract before
 * any attempt, workspace, child or provider launch. This is pure and does not
 * infer capabilities from prose or broaden the accepted mapping.
 */
export function evaluateCandidateCapabilityAdmission({
  preflight = null,
  adapterId = 'claude-code-cli',
} = {}) {
  const required = resolveManagerPreflightRequiredCapabilities(preflight);
  if (!required.valid) {
    return {
      allowed: false,
      scope: 'machine_profile',
      reason: IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH,
      requiredCapabilities: required.capabilities || Object.freeze([]),
      grantedCapabilities: Object.freeze([]),
      missingCapabilities: Object.freeze([]),
      unavailableCapabilities: Object.freeze([]),
      unknownCapabilities: required.unknown || Object.freeze([]),
      safeNextAction: 'Issue a fresh reviewed manager authority using only known implementation capability identifiers. Do not edit the existing immutable packet or infer permissions from prose.',
      childLaunched: false,
      providerInvocation: false,
    };
  }

  if (adapterId !== 'claude-code-cli') {
    return {
      allowed: false,
      scope: 'machine_profile',
      reason: IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH,
      requiredCapabilities: required.capabilities,
      grantedCapabilities: Object.freeze([]),
      missingCapabilities: required.capabilities,
      unavailableCapabilities: required.capabilities,
      unknownCapabilities: Object.freeze([]),
      safeNextAction: 'The selected adapter has no accepted #228 implementation-tool capability contract in this admission path. Qualify its own bounded capability contract before routing implementation work.',
      childLaunched: false,
      providerInvocation: false,
    };
  }

  const compatibility = evaluateCapabilityCompatibility({
    requiredCapabilities: required.capabilities,
    grantedCapabilities: AVAILABLE_CAPABILITY_IDS,
  });
  if (!compatibility.compatible) {
    return {
      allowed: false,
      scope: 'machine_profile',
      reason: IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH,
      requiredCapabilities: compatibility.requiredCapabilities,
      grantedCapabilities: compatibility.grantedCapabilities,
      missingCapabilities: compatibility.missingCapabilities,
      unavailableCapabilities: compatibility.unavailableCapabilities,
      unknownCapabilities: compatibility.unknownCapabilities,
      safeNextAction: 'Revise manager intent or add a separately reviewed bounded tool/harness mapping before provider launch. Do not broaden Bash/network/GitHub authority or interactively escalate permissions.',
      childLaunched: false,
      providerInvocation: false,
    };
  }

  return {
    allowed: true,
    scope: 'machine_profile',
    reason: 'candidate-tool-capability-admitted',
    requiredCapabilities: compatibility.requiredCapabilities,
    grantedCapabilities: compatibility.grantedCapabilities,
    missingCapabilities: compatibility.missingCapabilities,
    unavailableCapabilities: compatibility.unavailableCapabilities,
    unknownCapabilities: compatibility.unknownCapabilities,
  };
}

export function evaluateCandidateMachineProfileAdmission({
  issue = {},
  preflight = null,
  argsProfile,
  argsModel,
  argsEffort,
  env = process.env,
} = {}) {
  const managerExecutionMeta = resolveManagerPreflightExecutionMetadata(preflight);
  const profileName = inferProfile({
    explicitProfile: argsProfile || managerExecutionMeta.profile,
    issue,
  });
  const profile = resolveProfile(profileName, {
    model: argsModel || managerExecutionMeta.model,
    effort: argsEffort || managerExecutionMeta.effort,
  }, env);
  const costAdmission = evaluateClaudeCostAdmission(profile, env);
  if (!costAdmission.allowed) {
    return {
      allowed: false,
      scope: 'machine_profile',
      reason: 'candidate-machine-profile-cost-denied',
      violations: costAdmission.violations,
      safeNextAction: 'A changed manager intent/profile requires a fresh superseding immutable manager-preflight authority; the existing packet must not be edited. Where permitted, use a separately authorised machine-local policy change for Opus/xhigh.',
      profile,
      costAdmission,
    };
  }
  return {
    allowed: true,
    scope: 'machine_profile',
    reason: 'candidate-machine-profile-admitted',
    profile,
    costAdmission,
  };
}

export function evaluateCandidateCostAdmission({
  issue = {},
  preflight = null,
  env = process.env,
  circuitDbPath = defaultCircuitDbPath(env),
} = {}) {
  const decision = evaluateCandidateMachineProfileAdmission({ issue, preflight, env });
  if (decision.allowed) return { allowed: true, decision };

  const managerAuthority = parseManagerPreflightPacket(preflight);
  const { approvers } = normalizeImplementationApprovers(env.CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS);
  const effectiveFingerprint = candidateEffectiveCostFingerprint({
    machineConfigurationFingerprint: configurationFingerprint({ env, approvers }),
    managerAuthority,
    profile: decision.profile,
    costAdmission: decision.costAdmission,
  });

  const breaker = new CandidateProfileCircuitBreaker(circuitDbPath);
  let circuitResult;
  try {
    circuitResult = breaker.record({ effectiveFingerprint, reason: decision.reason });
  } finally {
    breaker.close();
  }

  return { allowed: false, decision, effectiveFingerprint, circuitResult };
}

export function candidatePausePayload(admission, snapshot) {
  if (admission.scope === 'machine_profile' && admission.reason === IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH) {
    return {
      candidatePaused: true,
      failureScope: 'machine_profile',
      reason: admission.reason,
      safeNextAction: admission.safeNextAction,
      requiredCapabilities: admission.requiredCapabilities || [],
      grantedCapabilities: admission.grantedCapabilities || [],
      missingCapabilities: admission.missingCapabilities || [],
      unavailableCapabilities: admission.unavailableCapabilities || [],
      unknownCapabilities: admission.unknownCapabilities || [],
      selectedIssue: snapshot?.issueNumber || null,
      attemptCreated: false,
      childLaunched: false,
      providerInvocation: false,
      issueMutation: false,
      systemdOutcome: 'handled',
    };
  }
  if (admission.scope === 'machine_profile') {
    return candidateProfileCircuitPausePayload({
      reason: admission.reason,
      safeNextAction: admission.safeNextAction,
      effectiveFingerprint: admission.effectiveFingerprint,
      occurrenceCount: admission.occurrenceCount,
    });
  }
  return {
    candidatePaused: true,
    failureScope: 'issue_not_runnable',
    reason: admission.reason,
    safeNextAction: admission.safeNextAction || 'Repair execution-critical status/agent labels or provide a current immutable manager preflight from an approved ChatGPT manager identity. Proceed or continue comments cannot authorize a new claim.',
    selectedIssue: snapshot?.issueNumber || null,
    candidateRevision: snapshot?.preflightRevision || null,
    candidateFingerprint: snapshot?.preflightFingerprint || null,
    childLaunched: false,
    attemptCreated: false,
    issueMutation: false,
    systemdOutcome: 'handled',
  };
}

async function selectorFor({ argv, env, select }) {
  if (select) return select;
  const moduleUrl = env.AGENT_RUNNER_CANDIDATE_CRON_MODULE || './claude-runner-cron.mjs';
  const cron = await import(moduleUrl);
  const args = cron.parseArgs([...argv, '--dry-run', '--skip-quota-preflight'], env);
  return () => cron.selectIssue(args);
}

function approverPolicy(env) {
  const { approvers, invalid } = normalizeImplementationApprovers(env.CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS);
  if (invalid.length || approvers.length === 0) {
    return { approvers, admission: { allowed: false, reason: 'candidate-approver-policy-invalid' } };
  }
  return { approvers, admission: null };
}

function candidateRevalidationFailure(reason, initial = {}) {
  return {
    admission: {
      allowed: false,
      scope: CANDIDATE_REVALIDATION_FAILURE_SCOPE,
      reason,
      safeNextAction: 'Repair the standalone candidate revalidation path before dispatching or mutating any issue. Candidate authority remains unconsumed.',
    },
    initial: normalizeCandidateSnapshot(initial),
    current: {},
  };
}

async function boundedOperation(operation, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('candidate revalidation timed out');
          error.code = 'CANDIDATE_REVALIDATION_TIMEOUT';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveSelector({ argv, env, select, timeoutMs }) {
  try {
    return {
      ok: true,
      selector: await boundedOperation(() => selectorFor({ argv, env, select }), timeoutMs),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === 'CANDIDATE_REVALIDATION_TIMEOUT'
        ? 'candidate-revalidation-timeout'
        : 'candidate-revalidation-unavailable',
    };
  }
}

async function selectBounded(selector, timeoutMs) {
  try {
    return { ok: true, selected: await boundedOperation(selector, timeoutMs) };
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === 'CANDIDATE_REVALIDATION_TIMEOUT'
        ? 'candidate-revalidation-timeout'
        : 'candidate-revalidation-unavailable',
    };
  }
}

export function revalidateCandidateInChild({
  expected,
  argv = [],
  env = process.env,
  spawn = spawnSync,
  processTimeoutMs = candidateSelectionTimeoutMs(env) + 5_000,
} = {}) {
  const initial = normalizeCandidateSnapshot(expected);
  let result;
  try {
    result = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: processTimeoutMs,
      env: {
        ...env,
        AGENT_RUNNER_ATOMIC_EXPECTED_JSON: JSON.stringify(initial),
        AGENT_RUNNER_ATOMIC_ARGV_JSON: JSON.stringify(argv),
      },
    });
  } catch {
    return candidateRevalidationFailure('candidate-revalidation-unavailable', initial);
  }

  if (result?.error) {
    return candidateRevalidationFailure(
      result.error.code === 'ETIMEDOUT'
        ? 'candidate-revalidation-timeout'
        : 'candidate-revalidation-unavailable',
      initial,
    );
  }

  let parsed = null;
  try {
    parsed = JSON.parse(String(result?.stdout || '').trim());
  } catch {
    parsed = null;
  }

  if (parsed?.admission && (
    result?.status === 0
    || result?.status === CANDIDATE_PAUSED_EXIT_CODE
    || (result?.status === CANDIDATE_REVALIDATION_FAILURE_EXIT_CODE
      && parsed.admission.scope === CANDIDATE_REVALIDATION_FAILURE_SCOPE)
  )) {
    return parsed;
  }

  return candidateRevalidationFailure('candidate-revalidation-unavailable', initial);
}

function admitCandidatePreProvider({ identityAdmission, currentSelected, env }) {
  if (identityAdmission.allowed !== true) return identityAdmission;

  const capability = evaluateCandidateCapabilityAdmission({
    preflight: currentSelected?.currentPreflight || null,
    adapterId: resolveAgentForLabels(currentSelected?.issue?.labels || [])?.agentId || null,
  });
  if (!capability.allowed) return capability;

  const cost = evaluateCandidateCostAdmission({
    issue: currentSelected?.issue || {},
    preflight: currentSelected?.currentPreflight || null,
    env,
  });
  if (cost.allowed) return identityAdmission;
  return {
    allowed: false,
    scope: 'machine_profile',
    reason: cost.decision.reason,
    violations: cost.decision.violations,
    safeNextAction: cost.decision.safeNextAction,
    effectiveFingerprint: cost.effectiveFingerprint,
    occurrenceCount: cost.circuitResult.occurrenceCount,
  };
}

export async function admitExpectedCandidate({
  expected,
  argv = [],
  env = process.env,
  select,
  selectorTimeoutMs = candidateSelectionTimeoutMs(env),
} = {}) {
  const policy = approverPolicy(env);
  const initial = normalizeCandidateSnapshot(expected);
  if (policy.admission) return { admission: policy.admission, initial, current: {} };

  const resolved = await resolveSelector({ argv, env, select, timeoutMs: selectorTimeoutMs });
  if (!resolved.ok) return candidateRevalidationFailure(resolved.reason, initial);

  const observed = await selectBounded(resolved.selector, selectorTimeoutMs);
  if (!observed.ok) return candidateRevalidationFailure(observed.reason, initial);

  const currentSelected = observed.selected;
  const current = candidateSnapshot(currentSelected);
  const identityAdmission = evaluateCandidateAdmission({ initial, current, approvers: policy.approvers });
  const admission = admitCandidatePreProvider({ identityAdmission, currentSelected, env });
  return { admission, initial, current };
}

export async function admitCurrentCandidate({
  argv = [],
  env = process.env,
  select,
  selectorTimeoutMs = candidateSelectionTimeoutMs(env),
  revalidate = revalidateCandidateInChild,
} = {}) {
  const policy = approverPolicy(env);
  if (policy.admission) {
    const current = {};
    return { admission: policy.admission, initial: current, current };
  }

  const resolved = await resolveSelector({ argv, env, select, timeoutMs: selectorTimeoutMs });
  if (!resolved.ok) return candidateRevalidationFailure(resolved.reason);

  const firstObservation = await selectBounded(resolved.selector, selectorTimeoutMs);
  if (!firstObservation.ok) return candidateRevalidationFailure(firstObservation.reason);

  const initial = candidateSnapshot(firstObservation.selected);

  if (select) {
    const secondObservation = await selectBounded(resolved.selector, selectorTimeoutMs);
    if (!secondObservation.ok) return candidateRevalidationFailure(secondObservation.reason, initial);
    const currentSelected = secondObservation.selected;
    const current = candidateSnapshot(currentSelected);
    const identityAdmission = evaluateCandidateAdmission({ initial, current, approvers: policy.approvers });
    const admission = admitCandidatePreProvider({ identityAdmission, currentSelected, env });
    return { admission, initial, current };
  }

  return revalidate({ expected: initial, argv, env });
}

export async function main(argv = process.argv.slice(2), env = process.env, logger = console) {
  let result;
  if (env.AGENT_RUNNER_ATOMIC_EXPECTED_JSON) {
    try {
      const expected = JSON.parse(env.AGENT_RUNNER_ATOMIC_EXPECTED_JSON);
      const atomicArgv = env.AGENT_RUNNER_ATOMIC_ARGV_JSON ? JSON.parse(env.AGENT_RUNNER_ATOMIC_ARGV_JSON) : argv;
      result = await admitExpectedCandidate({ expected, argv: atomicArgv, env });
    } catch {
      result = candidateRevalidationFailure('candidate-revalidation-unavailable');
    }
  } else {
    result = await admitCurrentCandidate({ argv, env });
  }
  logger.log(JSON.stringify(result));
  if (result.admission.allowed) return 0;
  return result.admission.scope === CANDIDATE_REVALIDATION_FAILURE_SCOPE
    ? CANDIDATE_REVALIDATION_FAILURE_EXIT_CODE
    : CANDIDATE_PAUSED_EXIT_CODE;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
