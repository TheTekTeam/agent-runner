#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { normalizeImplementationApprovers } from './agent-runner-admission.mjs';
import { executionLabelAuthority } from './agent-runner-label-authority.mjs';
import {
  commentRevision,
  normalizeCommentIdentity,
  sameCommentIdentity,
} from './claude-runner-comment-identity.mjs';

export const CANDIDATE_PAUSED_EXIT_CODE = 3;
export const NEW_CLAIM_AUTHORIZATION_MODE = 'preflight-direct';

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
  const labelAuthority = selected.issue ? executionLabelAuthority(selected.issue) : {
    allowed: false,
    reason: 'candidate-no-longer-runnable',
    statusLabel: null,
    agentLabel: null,
    evidence: { statusLabels: [], agentLabels: [] },
  };
  return {
    issueNumber: selected.issue?.number || null,
    statusLabel: labelAuthority.statusLabel,
    agentLabel: labelAuthority.agentLabel,
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
    preflightRevision: commentRevision(preflightIdentity),
    preflightAuthor: preflightAuthor(selected.currentPreflight),
  };
}

export function normalizeCandidateSnapshot(snapshot = {}) {
  const commandIdentity = normalizeCommentIdentity(snapshot.commandIdentity || snapshot.commandRevision);
  const preflightIdentity = normalizeCommentIdentity(snapshot.preflightIdentity || snapshot.preflightRevision);
  return {
    issueNumber: snapshot.issueNumber || null,
    statusLabel: snapshot.statusLabel || null,
    agentLabel: snapshot.agentLabel || null,
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
    preflightRevision: commentRevision(preflightIdentity),
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
  if (initial.selectionMode !== current.selectionMode) {
    return { allowed: false, reason: 'candidate-dispatch-mode-changed' };
  }
  if (current.selectionMode !== NEW_CLAIM_AUTHORIZATION_MODE) {
    return { allowed: false, reason: 'candidate-manager-preflight-required' };
  }
  if (commandRevisionChanged(initial, current)) {
    return { allowed: false, reason: 'candidate-proceed-command-not-authoritative' };
  }
  if (!current.preflightIdentity || !sameCommentIdentity(initial.preflightIdentity, current.preflightIdentity)) {
    return { allowed: false, reason: 'candidate-preflight-revision-changed' };
  }
  if (!current.preflightAuthor || !approvers.includes(current.preflightAuthor)) {
    return { allowed: false, reason: 'candidate-preflight-author-not-approved' };
  }
  return { allowed: true, reason: 'candidate-admitted' };
}

export function candidatePausePayload(admission, snapshot) {
  return {
    candidatePaused: true,
    failureScope: 'issue_not_runnable',
    reason: admission.reason,
    safeNextAction: 'Repair execution-critical status/agent labels or provide a current immutable manager preflight from an approved ChatGPT manager identity. Proceed or continue comments cannot authorize a new claim.',
    selectedIssue: snapshot?.issueNumber || null,
    candidateRevision: snapshot?.preflightRevision || null,
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

export async function admitExpectedCandidate({ expected, argv = [], env = process.env, select } = {}) {
  const policy = approverPolicy(env);
  if (policy.admission) return { admission: policy.admission, initial: normalizeCandidateSnapshot(expected), current: {} };
  const selector = await selectorFor({ argv, env, select });
  const initial = normalizeCandidateSnapshot(expected);
  const current = candidateSnapshot(await selector());
  return { admission: evaluateCandidateAdmission({ initial, current, approvers: policy.approvers }), initial, current };
}

export async function admitCurrentCandidate({ argv = [], env = process.env, select } = {}) {
  const policy = approverPolicy(env);
  if (policy.admission) {
    const current = {};
    return { admission: policy.admission, initial: current, current };
  }
  const selector = await selectorFor({ argv, env, select });
  const initial = candidateSnapshot(await selector());
  const current = candidateSnapshot(await selector());
  return { admission: evaluateCandidateAdmission({ initial, current, approvers: policy.approvers }), initial, current };
}

export async function main(argv = process.argv.slice(2), env = process.env, logger = console) {
  let result;
  if (env.AGENT_RUNNER_ATOMIC_EXPECTED_JSON) {
    const expected = JSON.parse(env.AGENT_RUNNER_ATOMIC_EXPECTED_JSON);
    const atomicArgv = env.AGENT_RUNNER_ATOMIC_ARGV_JSON ? JSON.parse(env.AGENT_RUNNER_ATOMIC_ARGV_JSON) : argv;
    result = await admitExpectedCandidate({ expected, argv: atomicArgv, env });
  } else {
    result = await admitCurrentCandidate({ argv, env });
  }
  logger.log(JSON.stringify(result));
  return result.admission.allowed ? 0 : CANDIDATE_PAUSED_EXIT_CODE;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
