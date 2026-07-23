#!/usr/bin/env node

import { pathToFileURL, fileURLToPath } from 'node:url';

import { main as atomicMain } from './agent-runner-atomic-cron.mjs';
import {
  runChildWithWatchdog,
} from './claude-runner-cron.mjs';
import {
  commentRevision,
  deserializeCommentIdentity,
} from './claude-runner-comment-identity.mjs';

export const PINNED_CHILD_ENTRYPOINT = fileURLToPath(
  new URL('./agent-runner-pinned-child.mjs', import.meta.url),
);

function persistedIdentity(row, jsonKey, revisionKey, context) {
  return deserializeCommentIdentity(
    row?.[jsonKey] || row?.[revisionKey] || null,
    context,
  );
}

export function resolvePinnedExecutionAuthority({ state, attemptId } = {}) {
  if (!attemptId) return { allowed: false, reason: 'pinned-authority-attempt-id-missing' };
  const attempt = state?.invoke?.('recoveryAttempt', attemptId) || null;
  if (!attempt) return { allowed: false, reason: 'pinned-authority-attempt-row-missing', attemptId };

  const preflightIdentity = persistedIdentity(attempt, 'preflight_identity_json', 'preflight_revision', 'pinned-child-preflight');
  if (!preflightIdentity) {
    return { allowed: false, reason: 'pinned-authority-preflight-identity-missing', attemptId, issueNumber: attempt.issue_number || null };
  }
  if (!attempt.manager_preflight_revision || !attempt.manager_preflight_fingerprint || !attempt.manager_preflight_body_digest || !attempt.manager_authority_key) {
    return { allowed: false, reason: 'pinned-authority-immutable-manager-packet-missing', attemptId, issueNumber: attempt.issue_number || null };
  }

  return {
    allowed: true,
    reason: 'pinned-authority-resolved',
    attemptId,
    issueNumber: attempt.issue_number || null,
    selectionMode: 'preflight-direct',
    preflightIdentity,
    preflightCommentRevision: commentRevision(preflightIdentity),
    managerPreflightRevision: attempt.manager_preflight_revision,
    managerPreflightFingerprint: attempt.manager_preflight_fingerprint,
    managerPreflightBodyDigest: attempt.manager_preflight_body_digest,
    managerAuthorityKey: attempt.manager_authority_key,
    claimIdentity: preflightIdentity,
    claimRevision: commentRevision(preflightIdentity),
  };
}

function blockedChildResult(authority) {
  const payload = {
    mode: 'pinned-execution-authority',
    blocked: true,
    reason: authority.reason,
    failureReason: authority.reason,
    issue: authority.issueNumber || null,
    sourcePreflightCommentId: authority.preflightRevision || null,
    sourcePreflightCommentIdentity: authority.preflightIdentity || null,
    pinnedExecutionAuthority: {
      allowed: false,
      reason: authority.reason,
      attemptId: authority.attemptId || null,
    },
  };
  return {
    status: 4,
    signal: null,
    error: null,
    stdout: `${JSON.stringify(payload)}\n`,
    stderr: '',
  };
}

export async function runChildWithPinnedAuthority(input, {
  baseRunChild = runChildWithWatchdog,
} = {}) {
  const authority = resolvePinnedExecutionAuthority({
    state: input?.state,
    attemptId: input?.attemptId,
  });
  if (!authority.allowed) return blockedChildResult(authority);

  const commandArgs = [...(input.commandArgs || [])];
  const originalEntrypoint = commandArgs[0] || null;
  if (!originalEntrypoint) {
    return blockedChildResult({
      ...authority,
      allowed: false,
      reason: 'pinned-authority-child-entrypoint-missing',
    });
  }

  commandArgs[0] = PINNED_CHILD_ENTRYPOINT;
  const options = {
    ...(input.options || {}),
    env: {
      ...(input.options?.env || {}),
      AGENT_RUNNER_PINNED_CHILD_ENTRYPOINT: originalEntrypoint,
      AGENT_RUNNER_PINNED_ISSUE: String(authority.issueNumber || ''),
      AGENT_RUNNER_PINNED_SELECTION_MODE: authority.selectionMode,
      AGENT_RUNNER_PINNED_PREFLIGHT_COMMENT_REVISION: authority.preflightCommentRevision,
      AGENT_RUNNER_PINNED_MANAGER_REVISION: authority.managerPreflightRevision,
      AGENT_RUNNER_PINNED_MANAGER_FINGERPRINT: authority.managerPreflightFingerprint,
      AGENT_RUNNER_PINNED_MANAGER_BODY_DIGEST: authority.managerPreflightBodyDigest,
      AGENT_RUNNER_PINNED_MANAGER_AUTHORITY_KEY: authority.managerAuthorityKey,
      AGENT_RUNNER_PINNED_ATTEMPT_ID: String(authority.attemptId),
    },
  };

  return baseRunChild({
    ...input,
    commandArgs,
    options,
  });
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const baseRunChild = dependencies.baseRunChild || runChildWithWatchdog;
  return atomicMain(argv, env, {
    ...dependencies,
    runChild: (input) => runChildWithPinnedAuthority(input, { baseRunChild }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
