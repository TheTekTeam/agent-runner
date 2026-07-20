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
  if (initial.commandKind !== current.commandKind || !sameCommentIdentity(initial.commandIdentity, current.commandIdentity)) {
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

export async function admitCurrentCandidate({ argv = [], env = process.env, select } = {}) {
  const { approvers, invalid } = normalizeImplementationApprovers(env.CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS);
  if (invalid.length || approvers.length === 0) {
    const current = {};
    return { admission: { allowed: false, reason: 'candidate-approver-policy-invalid' }, initial: current, current };
  }

  let selector = select;
  let args;
  if (!selector) {
    const cron = await import('./claude-runner-cron.mjs');
    args = cron.parseArgs([...argv, '--dry-run', '--skip-quota-preflight'], env);
    selector = () => cron.selectIssue(args);
  }

  const initialSelection = await selector();
  const initial = candidateSnapshot(initialSelection);
  const currentSelection = await selector();
  const current = candidateSnapshot(currentSelection);
  return { admission: evaluateCandidateAdmission({ initial, current, approvers }), initial, current };
}

export async function main(argv = process.argv.slice(2), env = process.env, logger = console) {
  const result = await admitCurrentCandidate({ argv, env });
  if (result.admission.allowed) {
    logger.log(JSON.stringify({
      candidateAdmitted: true,
      selectedIssue: result.current.issueNumber,
      candidateRevision: result.current.preflightRevision,
      selectionMode: result.current.selectionMode,
    }));
    return 0;
  }
  logger.log(JSON.stringify(candidatePausePayload(result.admission, result.current), null, 2));
  return CANDIDATE_PAUSED_EXIT_CODE;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
