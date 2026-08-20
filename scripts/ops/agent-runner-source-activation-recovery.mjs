#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { normalizeImplementationApprovers } from './agent-runner-admission.mjs';
import { packetBodyDigest } from './agent-runner-manager-authority.mjs';
import {
  SOURCE_ACTIVATION_AUTHORITY_MARKER,
  SOURCE_ACTIVATION_STATE_SCHEMA_VERSION,
  exitCodeForSourceActivationResult,
  fetchSourceActivationComments,
  parseSourceActivationAuthority,
  readSourceActivationState,
  resolveSourceActivationControlIssue,
  sourceActivationEnabled,
  writeSourceActivationState,
} from './agent-runner-source-activation-authority.mjs';
import {
  REPOSITORY_ROOT,
  SourceActivationRefusal,
  activateAgentRunnerSource,
} from './agent-runner-source-activation.mjs';

const FULL_SHA_PATTERN = /^[a-f0-9]{40}$/;

function commentId(comment) {
  const value = Number(comment?.id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function commentAuthor(comment) {
  return String(comment?.user?.login || comment?.author?.login || '').trim().toLowerCase();
}

function sourceMarkerComments(comments) {
  const marked = comments.filter((comment) => String(comment?.body || '').includes(SOURCE_ACTIVATION_AUTHORITY_MARKER));
  if (marked.some((comment) => !commentId(comment))) {
    return null;
  }
  return marked.sort((a, b) => commentId(a) - commentId(b));
}

function defaultReadHead({ cwd = REPOSITORY_ROOT } = {}) {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const head = String(result.stdout || '').trim().toLowerCase();
  return result.status === 0 && FULL_SHA_PATTERN.test(head) ? head : null;
}

function halt(reason, extra = {}) {
  return { action: 'halt', reason, ...extra };
}

/**
 * #281 bounded recovery for one otherwise-unrecoverable state: durable source
 * activation says an older exact SHA was applied, while the canonical checkout
 * has legitimately advanced outside that durable state and a newer immutable
 * source authority already names exactly the current accepted HEAD.
 *
 * This helper never chooses a moving target and never rewrites Git directly.
 * Before replacing the stale applied record it runs the accepted #232 activator
 * against the current exact HEAD. In its already-active path that primitive
 * still proves canonical repository identity, main branch, a completely clean
 * checkout, exact fetched origin/main equality and the global implementation
 * lock. Any failure leaves the old durable state untouched.
 */
export async function recoverAppliedSourceActivationHeadMismatch({
  env = process.env,
  fetchComments = fetchSourceActivationComments,
  readState = () => readSourceActivationState({ env }),
  writeState = (state) => writeSourceActivationState(state, { env }),
  readHead = defaultReadHead,
  activateSource = ({ target }) => activateAgentRunnerSource({ target, env }),
  now = () => new Date().toISOString(),
} = {}) {
  if (!sourceActivationEnabled(env)) {
    return { action: 'continue', reason: 'source-activation-recovery-disabled' };
  }

  const issueNumber = resolveSourceActivationControlIssue(env);
  const { approvers, invalid } = normalizeImplementationApprovers(env.CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS);
  if (invalid.length > 0 || approvers.length === 0) {
    return halt('source-activation-recovery-approver-policy-invalid');
  }

  const state = readState();
  if (!state || state.sourceIssueNumber !== issueNumber || state.status !== 'applied') {
    return { action: 'continue', reason: 'source-activation-recovery-not-applicable' };
  }
  if (state.finalHead !== state.targetCommit) {
    return halt('source-activation-applied-head-mismatch', { sourceCommentId: state.sourceCommentId });
  }

  const currentHead = readHead();
  if (!currentHead || !FULL_SHA_PATTERN.test(currentHead)) {
    return halt('source-activation-recovery-head-unavailable', { sourceCommentId: state.sourceCommentId });
  }
  if (currentHead === state.targetCommit) {
    return { action: 'continue', reason: 'source-activation-recovery-not-needed' };
  }

  const comments = fetchComments(issueNumber, { env });
  const markerComments = sourceMarkerComments(comments);
  if (!markerComments) {
    return halt('source-activation-recovery-comment-identity-invalid', { sourceCommentId: state.sourceCommentId });
  }

  const boundComment = markerComments.find((comment) => commentId(comment) === state.sourceCommentId) || null;
  if (!boundComment) {
    return halt('source-activation-authority-comment-missing', { sourceCommentId: state.sourceCommentId });
  }
  if (packetBodyDigest(String(boundComment.body || '')) !== state.bodyDigest) {
    return halt('source-activation-authority-edited-after-consumption', { sourceCommentId: state.sourceCommentId });
  }

  const newer = markerComments.filter((comment) => commentId(comment) > state.sourceCommentId);
  if (newer.length === 0) {
    return halt('source-activation-applied-head-mismatch', { sourceCommentId: state.sourceCommentId });
  }

  // Recovery may legitimately span multiple accepted-source generations. Every
  // intervening marker must still be a valid immutable authority from an
  // approved manager; only the uniquely newest marker may reconcile the
  // durable state, and it must target the exact current HEAD. This lets a
  // stale .5 state recover through historical .6 to a current .7 authority
  // without reinterpreting or skipping an invalid authority in the chain.
  const parsedNewer = [];
  for (const comment of newer) {
    const parsed = parseSourceActivationAuthority(comment);
    if (!parsed.valid) {
      return halt('source-activation-recovery-authority-invalid', { sourceCommentId: parsed.commentId || state.sourceCommentId });
    }
    if (!approvers.includes(commentAuthor(comment))) {
      return halt('source-activation-recovery-author-unapproved', { sourceCommentId: parsed.commentId });
    }
    parsedNewer.push(parsed);
  }

  const parsed = parsedNewer.at(-1);
  if (parsed.targetCommit !== currentHead) {
    return halt('source-activation-recovery-target-head-mismatch', { sourceCommentId: parsed.commentId });
  }

  let activation;
  try {
    activation = await activateSource({ target: currentHead, env });
  } catch (error) {
    if (error?.code === 'AGENT_RUNNER_LOCKED' || error?.reason === 'implementation-lock-unavailable') {
      return halt('implementation-lock-unavailable', { sourceCommentId: parsed.commentId });
    }
    if (error instanceof SourceActivationRefusal || error?.code === 'AGENT_RUNNER_SOURCE_ACTIVATION_REFUSED') {
      return halt(error.reason || 'source-activation-recovery-refused', { sourceCommentId: parsed.commentId });
    }
    throw error;
  }

  if (!activation?.ok || activation.finalHead !== currentHead || activation.result !== 'already-active') {
    return halt('source-activation-recovery-result-invalid', { sourceCommentId: parsed.commentId });
  }

  const applied = {
    schemaVersion: SOURCE_ACTIVATION_STATE_SCHEMA_VERSION,
    sourceIssueNumber: issueNumber,
    sourceCommentId: parsed.commentId,
    authorityKey: parsed.authorityKey,
    revision: parsed.revision,
    fingerprint: parsed.fingerprint,
    bodyDigest: parsed.bodyDigest,
    targetCommit: parsed.targetCommit,
    status: 'applied',
    refusalReason: null,
    appliedAt: now(),
    finalHead: activation.finalHead,
  };
  writeState(applied);

  return {
    action: 'reexec',
    reason: 'source-activation-applied-head-reconciled',
    sourceCommentId: parsed.commentId,
    previousSourceCommentId: state.sourceCommentId,
    targetCommit: parsed.targetCommit,
  };
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  try {
    const result = await recoverAppliedSourceActivationHeadMismatch();
    console.log(JSON.stringify(result));
    process.exitCode = exitCodeForSourceActivationResult(result);
  } catch {
    console.error(JSON.stringify({
      action: 'halt',
      reason: 'source-activation-recovery-systemic-failure',
      systemic: true,
    }));
    process.exitCode = 1;
  }
}
