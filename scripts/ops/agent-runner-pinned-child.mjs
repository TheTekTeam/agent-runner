#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { main as childMain } from './claude-runner.mjs';
import {
  evaluateManagerAuthorizedNoChange,
  parseNoChangeCompletionPolicy,
} from './agent-runner-no-change-completion.mjs';
import {
  hasManagerPreflight,
  latestManagerPreflightComment,
} from './claude-runner-selection.mjs';
import {
  commentRevision,
  normalizeCommentIdentity,
  sameCommentIdentity,
} from './claude-runner-comment-identity.mjs';

const COMMAND_HEADING = /^## Claude (?:proceed|continue) command\s*$/gim;

function commentWithCommandAuthorityRemoved(comment) {
  const body = String(comment?.body || '').replace(
    COMMAND_HEADING,
    '## Superseded Claude command — ignored by pinned execution authority',
  );
  return { ...comment, body };
}

function exactComment(comments, identity) {
  return comments.find((comment) => sameCommentIdentity(comment, identity)) || null;
}

export function pinnedAuthorityFromEnv(env = process.env) {
  const issueNumber = Number.parseInt(env.AGENT_RUNNER_PINNED_ISSUE || '', 10);
  const selectionMode = String(env.AGENT_RUNNER_PINNED_SELECTION_MODE || '').trim();
  const preflightIdentity = normalizeCommentIdentity(
    env.AGENT_RUNNER_PINNED_PREFLIGHT_REVISION,
    { context: 'pinned-child-preflight' },
  );
  const claimIdentity = normalizeCommentIdentity(
    env.AGENT_RUNNER_PINNED_CLAIM_REVISION || null,
    { context: 'pinned-child-claim' },
  );

  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    return { allowed: false, reason: 'pinned-child-issue-invalid' };
  }
  if (!['preflight-direct', 'proceed-command'].includes(selectionMode)) {
    return { allowed: false, reason: 'pinned-child-selection-mode-invalid', issueNumber };
  }
  if (!preflightIdentity) {
    return { allowed: false, reason: 'pinned-child-preflight-invalid', issueNumber, selectionMode };
  }
  if (selectionMode === 'proceed-command' && !claimIdentity) {
    return { allowed: false, reason: 'pinned-child-command-invalid', issueNumber, selectionMode, preflightIdentity };
  }

  return {
    allowed: true,
    reason: 'pinned-child-authority-valid',
    issueNumber,
    selectionMode,
    preflightIdentity,
    preflightRevision: commentRevision(preflightIdentity),
    claimIdentity,
    claimRevision: commentRevision(claimIdentity),
    attemptId: String(env.AGENT_RUNNER_PINNED_ATTEMPT_ID || '').trim() || null,
  };
}

export function pinManagerAuthorityComments(comments = [], authority = {}) {
  if (authority.allowed !== true) return { allowed: false, reason: authority.reason, comments: [] };
  if (!Array.isArray(comments)) {
    return { allowed: false, reason: 'pinned-child-comments-invalid', comments: [] };
  }

  const pinnedPreflight = exactComment(comments, authority.preflightIdentity);
  if (!pinnedPreflight) {
    return { allowed: false, reason: 'pinned-child-preflight-not-found', comments: [] };
  }
  if (!hasManagerPreflight(pinnedPreflight.body || '')) {
    return { allowed: false, reason: 'pinned-child-preflight-not-valid', comments: [] };
  }

  const currentPreflight = latestManagerPreflightComment(comments);
  if (!currentPreflight || !sameCommentIdentity(currentPreflight, authority.preflightIdentity)) {
    return { allowed: false, reason: 'pinned-child-preflight-not-current', comments: [] };
  }

  let pinnedCommand = null;
  if (authority.selectionMode === 'proceed-command') {
    pinnedCommand = exactComment(comments, authority.claimIdentity);
    if (!pinnedCommand || !COMMAND_HEADING.test(String(pinnedCommand.body || ''))) {
      COMMAND_HEADING.lastIndex = 0;
      return { allowed: false, reason: 'pinned-child-command-not-found', comments: [] };
    }
    COMMAND_HEADING.lastIndex = 0;
  }

  const filtered = comments.map((comment) => {
    if (authority.selectionMode === 'proceed-command'
      && sameCommentIdentity(comment, authority.claimIdentity)) {
      return comment;
    }
    return commentWithCommandAuthorityRemoved(comment);
  });

  return {
    allowed: true,
    reason: 'pinned-child-comments-authorized',
    comments: filtered,
    noChangePolicy: parseNoChangeCompletionPolicy(pinnedPreflight.body || ''),
    evidence: {
      issueNumber: authority.issueNumber,
      selectionMode: authority.selectionMode,
      preflightRevision: authority.preflightRevision,
      claimRevision: authority.claimRevision || null,
      pinnedPreflightFound: true,
      pinnedCommandFound: authority.selectionMode === 'preflight-direct' || Boolean(pinnedCommand),
    },
  };
}

function commentsRequestForIssue(input, issueNumber) {
  const raw = typeof input === 'string' || input instanceof URL
    ? String(input)
    : String(input?.url || '');
  return new RegExp(`/issues/${issueNumber}/comments(?:\\?|$)`).test(raw);
}

export function createPinnedFetch({
  authority,
  originalFetch = globalThis.fetch,
  onPinned = null,
} = {}) {
  if (typeof originalFetch !== 'function') throw new Error('pinned-child-fetch-unavailable');
  return async (input, init) => {
    const response = await originalFetch(input, init);
    if (!commentsRequestForIssue(input, authority.issueNumber)) return response;

    const comments = await response.clone().json();
    const pinned = pinManagerAuthorityComments(comments, authority);
    if (!pinned.allowed) throw new Error(pinned.reason);
    onPinned?.(pinned);

    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(JSON.stringify(pinned.comments), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function structuredFailure(authority, reason) {
  return {
    mode: 'pinned-execution-authority',
    blocked: true,
    reason,
    failureReason: reason,
    issue: authority.issueNumber || null,
    sourcePreflightCommentId: authority.preflightRevision || null,
    sourcePreflightCommentIdentity: authority.preflightIdentity || null,
    pinnedExecutionAuthority: {
      allowed: false,
      reason,
      issueNumber: authority.issueNumber || null,
      selectionMode: authority.selectionMode || null,
      preflightRevision: authority.preflightRevision || null,
      claimRevision: authority.claimRevision || null,
      attemptId: authority.attemptId || null,
    },
  };
}

function withPinnedAuthorityEvidence(payload, authority) {
  return {
    ...payload,
    pinnedExecutionAuthority: {
      allowed: true,
      reason: 'pinned-child-authority-applied',
      issueNumber: authority.issueNumber,
      selectionMode: authority.selectionMode,
      preflightRevision: authority.preflightRevision,
      claimRevision: authority.claimRevision || null,
      attemptId: authority.attemptId || null,
    },
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const authority = pinnedAuthorityFromEnv(env);
  if (!authority.allowed) {
    console.log(JSON.stringify(structuredFailure(authority, authority.reason), null, 2));
    return 4;
  }

  const originalFetch = dependencies.originalFetch || globalThis.fetch;
  const runChildMain = dependencies.childMain || childMain;
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  let noChangePolicy = parseNoChangeCompletionPolicy('');
  let noChangeAccepted = false;

  globalThis.fetch = createPinnedFetch({
    authority,
    originalFetch,
    onPinned: (pinned) => {
      noChangePolicy = pinned.noChangePolicy;
    },
  });
  console.log = (...values) => {
    if (values.length === 1 && typeof values[0] === 'string') {
      try {
        const payload = JSON.parse(values[0]);
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const completion = evaluateManagerAuthorizedNoChange({
            payload,
            policy: noChangePolicy,
            authority,
          });
          const effectivePayload = completion.accepted ? completion.payload : payload;
          if (completion.accepted) noChangeAccepted = true;
          previousLog(JSON.stringify(withPinnedAuthorityEvidence(effectivePayload, authority), null, 2));
          return;
        }
      } catch {
        // Preserve non-JSON diagnostics exactly.
      }
    }
    previousLog(...values);
  };

  try {
    const exitCode = await runChildMain(argv, env);
    return noChangeAccepted ? 0 : exitCode;
  } catch (error) {
    const reason = String(error?.message || error || 'pinned-child-authority-failed');
    previousLog(JSON.stringify(structuredFailure(authority, reason), null, 2));
    return 4;
  } finally {
    globalThis.fetch = previousFetch;
    console.log = previousLog;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.log(JSON.stringify({
      mode: 'pinned-execution-authority',
      blocked: true,
      reason: String(error?.message || error),
      failureReason: String(error?.message || error),
    }, null, 2));
    process.exitCode = 4;
  });
}
