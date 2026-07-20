#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { normalizeImplementationApprovers } from './agent-runner-admission.mjs';
import {
  commentRevision,
  normalizeCommentIdentity,
  sameCommentIdentity,
} from './claude-runner-comment-identity.mjs';

export const CANDIDATE_PAUSED_EXIT_CODE = 3;

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
  return {
    issueNumber: selected.issue?.number || null,
    statusLabel: selected.issue?.statusLabel || null,
    agentLabel: selected.issue?.agentLabel || null,
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
  if (current.selectionMode === 'preflight-direct') {
    return initial.commandKind !== null
      || current.commandKind !== null
      || initial.commandIdentity !== null
      || current.commandIdentity !== null;
  }
  if (current.selectionMode === 'proceed-command') {
    return initial.commandKind !== current.commandKind
      || !initial.commandIdentity
      || !current.commandIdentity
      || !sameCommentIdentity(initial.commandIdentity, current.commandIdentity);
  }
  return true;
}

export function evaluateCandidateAdmission({ initial, current, approvers = [] } = {}) {
  if (!initial?.issueNumber || !current?.issueNumber) {
    return { allowed: false, reason: 'candidate-no-longer-runnable' };
  }
  if (initial.issueNumber !== current.issueNumber) {
    return { allowed: false, reason: 'candidate-selection-changed' };
  }
  if (initial.statusLabel !== current.statusLabel || !['status:ready', 'status:in-progress'].includes(current.statusLabel)) {
    return { allowed: false, reason: 'candidate-status-changed' };
  }
  if (initial.agentLabel !== current.agentLabel) {
    return { allowed: false, reason: 'candidate-agent-changed' };
  }
  if (initial.selectionMode !== current.selectionMode || !['proceed-command', 'preflight-direct'].includes(current.selectionMode)) {
    return { allowed: false, reason: 'candidate-dispatch-mode-changed' };
  }
  if (commandRevisionChanged(initial, current)) {
    return { allowed: false, reason: 'candidate-command-revision-changed' };
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
    safeNextAction: 'Refresh the candidate and obtain a current manager preflight from an approved ChatGPT manager identity.',
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
