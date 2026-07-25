#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveDispatchAuthority } from './agent-runner-dispatch-authority.mjs';
import {
  MANAGER_PREFLIGHT_ALREADY_CLAIMED,
  resolveCurrentManagerAuthority,
} from './agent-runner-manager-authority.mjs';
import { runnerOwnCheckoutRoot } from './agent-runner-repository-context.mjs';
import { main as atomicMain } from './agent-runner-atomic-cron.mjs';
import { runChildWithWatchdog } from './claude-runner-cron.mjs';
import {
  commentRevision,
  deserializeCommentIdentity,
  normalizeCommentIdentity,
  sameCommentIdentity,
} from './claude-runner-comment-identity.mjs';

export const PINNED_CHILD_ENTRYPOINT = fileURLToPath(
  new URL('./agent-runner-pinned-child.mjs', import.meta.url),
);

const RUNNER_STARTED_PATTERN = /^## Claude runner started\s*$/im;
const ATTEMPT_PATTERN = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*):(.+)$/;

function persistedIdentity(row, jsonKey, revisionKey, context) {
  return deserializeCommentIdentity(row?.[jsonKey] || row?.[revisionKey] || null, context);
}

function parseJsonObject(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function markerField(comment, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(comment?.body || '').match(new RegExp(escaped + ':\\s*`?([^\\s`]+)`?', 'i'))?.[1] || null;
}

function matchingRunnerStartedComments(comments, authorityKey) {
  return comments.filter((comment) => RUNNER_STARTED_PATTERN.test(String(comment?.body || ''))
    && markerField(comment, 'Manager packet authority') === authorityKey);
}

function issueComments(repo, issueNumber, ghRunner) {
  if (typeof ghRunner !== 'function') throw new Error('pinned-authority-gh-runner-missing');
  const raw = ghRunner(['issue', 'view', String(issueNumber), '--repo', repo, '--comments', '--json', 'comments']);
  const parsed = JSON.parse(String(raw || '{}'));
  if (!Array.isArray(parsed.comments)) throw new Error('pinned-authority-comments-invalid');
  return parsed.comments;
}

function fail(reason, extra = {}) {
  return { allowed: false, reason, ...extra };
}

export function resolvePinnedExecutionAuthority({ state, attemptId, comments = [], args = {} } = {}) {
  if (!attemptId) return fail('pinned-authority-attempt-id-missing');
  const attempt = state?.invoke?.('recoveryAttempt', attemptId) || null;
  if (!attempt) return fail('pinned-authority-attempt-row-missing', { attemptId });
  const attemptIdentity = String(attemptId).match(ATTEMPT_PATTERN);
  if (!attemptIdentity
    || attemptIdentity[1] !== attempt.repo
    || Number(attemptIdentity[2]) !== Number(attempt.issue_number)
    || (args.repo && args.repo !== attempt.repo)) {
    return fail('pinned-authority-attempt-identity-mismatch', { attemptId, issueNumber: attempt.issue_number || null });
  }

  const preflightIdentity = persistedIdentity(attempt, 'preflight_identity_json', 'preflight_revision', 'pinned-child-preflight');
  if (!preflightIdentity) return fail('pinned-authority-preflight-identity-missing', { attemptId, issueNumber: attempt.issue_number || null });
  if (!attempt.manager_preflight_revision || !attempt.manager_preflight_fingerprint || !attempt.manager_preflight_body_digest || !attempt.manager_authority_key) {
    return fail('pinned-authority-immutable-manager-packet-missing', { attemptId, issueNumber: attempt.issue_number || null });
  }

  const current = resolveCurrentManagerAuthority(comments);
  const claimMode = current.reason === MANAGER_PREFLIGHT_ALREADY_CLAIMED
    ? 'claimed'
    : current.allowed === true
      ? 'unclaimed'
      : null;
  if (!claimMode || !current.authority) {
    return fail('pinned-authority-current-claim-not-found', { attemptId, issueNumber: attempt.issue_number || null });
  }
  if (current.authority.authorityKey !== attempt.manager_authority_key
    || current.authority.revision !== attempt.manager_preflight_revision
    || current.authority.fingerprint !== attempt.manager_preflight_fingerprint
    || current.authority.packetDigest !== attempt.manager_preflight_body_digest
    || !sameCommentIdentity(current.authority.commentIdentity, preflightIdentity)) {
    return fail('pinned-authority-current-packet-mismatch', { attemptId, issueNumber: attempt.issue_number || null });
  }
  if (!attempt.agent || current.authority.approvedAgent !== attempt.agent) {
    return fail('pinned-authority-approved-agent-mismatch', { attemptId, issueNumber: attempt.issue_number || null });
  }

  let runnerStartedIdentity = null;
  if (claimMode === 'claimed') {
    const claimRows = state?.invoke?.('allRows', 'claims') || [];
    const claims = claimRows
      .filter((row) => row.repo === attempt.repo && Number(row.issue_number) === Number(attempt.issue_number))
      .map((row) => ({ row, payload: parseJsonObject(row.payload_json) }))
      .filter(({ payload }) => payload?.managerAuthorityKey === attempt.manager_authority_key);
    if (claims.length !== 1) {
      return fail(claims.length === 0 ? 'pinned-authority-claim-row-missing' : 'pinned-authority-claim-row-duplicate', { attemptId, issueNumber: attempt.issue_number || null });
    }
    const claim = claims[0].payload;
    const claimPreflightIdentity = normalizeCommentIdentity(claim.sourcePreflightCommentIdentity || claim.sourcePreflightCommentId);
    runnerStartedIdentity = normalizeCommentIdentity(claim.runnerStartedCommentIdentity);
    if (!sameCommentIdentity(claimPreflightIdentity, preflightIdentity) || !runnerStartedIdentity) {
      return fail('pinned-authority-claim-identity-mismatch', { attemptId, issueNumber: attempt.issue_number || null });
    }
    if (claim.managerPreflightRevision !== attempt.manager_preflight_revision
      || claim.managerPreflightFingerprint !== attempt.manager_preflight_fingerprint
      || claim.managerPreflightBodyDigest !== attempt.manager_preflight_body_digest) {
      return fail('pinned-authority-claim-packet-mismatch', { attemptId, issueNumber: attempt.issue_number || null });
    }

    const markers = matchingRunnerStartedComments(comments, attempt.manager_authority_key);
    if (markers.length !== 1) {
      return fail(markers.length === 0 ? 'pinned-authority-runner-start-missing' : 'pinned-authority-runner-start-duplicate', { attemptId, issueNumber: attempt.issue_number || null });
    }
    if (!sameCommentIdentity(markers[0], runnerStartedIdentity)
      || markerField(markers[0], 'Source preflight comment') !== commentRevision(preflightIdentity)
      || markerField(markers[0], 'Manager packet revision') !== attempt.manager_preflight_revision
      || markerField(markers[0], 'Manager packet fingerprint') !== attempt.manager_preflight_fingerprint
      || markerField(markers[0], 'Manager packet body digest') !== attempt.manager_preflight_body_digest) {
      return fail('pinned-authority-runner-start-mismatch', { attemptId, issueNumber: attempt.issue_number || null });
    }
  }

  const dispatch = resolveDispatchAuthority({
    preflight: current.authority.comment,
    legacyMetadata: {},
    argsRepo: args.repo || attempt.repo,
    config: {
      githubRepo: args.project?.repo || args.repo || attempt.repo,
      localRepoPath: args.project?.localRepoPath || args.project?.checkout || '/pinned-project-checkout',
    },
    runnerCheckout: runnerOwnCheckoutRoot(import.meta.url),
  });
  if (!dispatch.ok) return fail(`pinned-authority-${dispatch.failureReason}`, { attemptId, issueNumber: attempt.issue_number || null });
  const worktreeIdentity = parseJsonObject(attempt.worktree_identity_json);
  const implementationDispatch = current.authority.executionPhase === 'implementation';
  if (implementationDispatch && (!worktreeIdentity?.expectedBranch || worktreeIdentity.expectedBranch !== dispatch.branch)) {
    return fail('pinned-authority-worktree-branch-mismatch', { attemptId, issueNumber: attempt.issue_number || null });
  }
  if (!implementationDispatch && worktreeIdentity?.expectedBranch && worktreeIdentity.expectedBranch !== dispatch.branch) {
    return fail('pinned-authority-worktree-branch-mismatch', { attemptId, issueNumber: attempt.issue_number || null });
  }

  return {
    allowed: true,
    reason: 'pinned-authority-resolved',
    attemptId,
    issueNumber: attempt.issue_number || null,
    issueRepository: attempt.repo,
    selectionMode: 'preflight-direct',
    claimMode,
    preflightIdentity,
    preflightCommentRevision: commentRevision(preflightIdentity),
    runnerStartedIdentity,
    runnerStartedCommentRevision: commentRevision(runnerStartedIdentity),
    managerPreflightRevision: attempt.manager_preflight_revision,
    managerPreflightFingerprint: attempt.manager_preflight_fingerprint,
    managerPreflightBodyDigest: attempt.manager_preflight_body_digest,
    managerAuthorityKey: attempt.manager_authority_key,
    approvedRepository: dispatch.repository,
    approvedBranch: dispatch.branch,
    approvedBaseCommit: String(dispatch.baseCommit).toLowerCase(),
    approvedAgent: current.authority.approvedAgent,
    claimIdentity: preflightIdentity,
    claimRevision: commentRevision(preflightIdentity),
  };
}

function commandOption(commandArgs, name) {
  const index = Array.isArray(commandArgs) ? commandArgs.indexOf(name) : -1;
  return index >= 0 ? commandArgs[index + 1] || null : null;
}

function childInvocationMatchesAuthority(commandArgs, authority) {
  const issueNumber = Number.parseInt(commandOption(commandArgs, '--issue') || '', 10);
  const childAttemptId = commandOption(commandArgs, '--attempt-id');
  return issueNumber === Number(authority.issueNumber) && childAttemptId === authority.attemptId;
}

function blockedChildResult(authority) {
  const payload = {
    mode: 'pinned-execution-authority',
    blocked: true,
    reason: authority.reason,
    failureReason: authority.reason,
    issue: authority.issueNumber || null,
    sourcePreflightCommentId: authority.preflightCommentRevision || null,
    sourcePreflightCommentIdentity: authority.preflightIdentity || null,
    pinnedExecutionAuthority: {
      allowed: false,
      reason: authority.reason,
      attemptId: authority.attemptId || null,
    },
  };
  return { status: 4, signal: null, error: null, stdout: `${JSON.stringify(payload)}\n`, stderr: '' };
}

export async function runChildWithPinnedAuthority(input, {
  baseRunChild = runChildWithWatchdog,
  loadComments = issueComments,
} = {}) {
  let comments;
  try {
    comments = loadComments(input?.args?.repo, input?.args?.issueNumber || input?.state?.invoke?.('recoveryAttempt', input?.attemptId)?.issue_number, input?.ghRunner);
  } catch {
    return blockedChildResult({ allowed: false, reason: 'pinned-authority-comments-read-failed', attemptId: input?.attemptId || null });
  }
  const authority = resolvePinnedExecutionAuthority({ state: input?.state, attemptId: input?.attemptId, comments, args: input?.args });
  if (!authority.allowed) return blockedChildResult(authority);

  const commandArgs = [...(input.commandArgs || [])];
  const originalEntrypoint = commandArgs[0] || null;
  if (!originalEntrypoint) return blockedChildResult({ ...authority, allowed: false, reason: 'pinned-authority-child-entrypoint-missing' });
  if (!childInvocationMatchesAuthority(commandArgs, authority)) {
    return blockedChildResult({ ...authority, allowed: false, reason: 'pinned-authority-child-invocation-mismatch' });
  }

  commandArgs[0] = PINNED_CHILD_ENTRYPOINT;
  const options = {
    ...(input.options || {}),
    env: {
      ...(input.options?.env || {}),
      AGENT_RUNNER_PINNED_CHILD_ENTRYPOINT: originalEntrypoint,
      AGENT_RUNNER_PINNED_ISSUE: String(authority.issueNumber || ''),
      AGENT_RUNNER_PINNED_ISSUE_REPOSITORY: authority.issueRepository,
      AGENT_RUNNER_PINNED_SELECTION_MODE: authority.selectionMode,
      AGENT_RUNNER_PINNED_CLAIM_MODE: authority.claimMode,
      AGENT_RUNNER_PINNED_PREFLIGHT_COMMENT_REVISION: authority.preflightCommentRevision,
      AGENT_RUNNER_PINNED_RUNNER_STARTED_COMMENT_REVISION: authority.runnerStartedCommentRevision,
      AGENT_RUNNER_PINNED_MANAGER_REVISION: authority.managerPreflightRevision,
      AGENT_RUNNER_PINNED_MANAGER_FINGERPRINT: authority.managerPreflightFingerprint,
      AGENT_RUNNER_PINNED_MANAGER_BODY_DIGEST: authority.managerPreflightBodyDigest,
      AGENT_RUNNER_PINNED_MANAGER_AUTHORITY_KEY: authority.managerAuthorityKey,
      AGENT_RUNNER_PINNED_APPROVED_REPOSITORY: authority.approvedRepository,
      AGENT_RUNNER_PINNED_APPROVED_BRANCH: authority.approvedBranch,
      AGENT_RUNNER_PINNED_APPROVED_BASE_COMMIT: authority.approvedBaseCommit,
      AGENT_RUNNER_PINNED_APPROVED_AGENT: authority.approvedAgent,
      AGENT_RUNNER_PINNED_ATTEMPT_ID: String(authority.attemptId),
    },
  };

  return baseRunChild({ ...input, commandArgs, options });
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const baseRunChild = dependencies.baseRunChild || runChildWithWatchdog;
  return atomicMain(argv, env, {
    ...dependencies,
    runChild: (input) => runChildWithPinnedAuthority(input, { baseRunChild, loadComments: dependencies.loadComments || issueComments }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
