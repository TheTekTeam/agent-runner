#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { main as childMain } from './claude-runner.mjs';
import {
  evaluateManagerAuthorizedNoChange,
  parseNoChangeCompletionPolicy,
} from './agent-runner-no-change-completion.mjs';
import {
  MANAGER_PREFLIGHT_ALREADY_CLAIMED,
  resolveCurrentManagerAuthority,
} from './agent-runner-manager-authority.mjs';
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
    env.AGENT_RUNNER_PINNED_PREFLIGHT_COMMENT_REVISION,
    { context: 'pinned-child-preflight' },
  );
  const managerPreflightRevision = String(env.AGENT_RUNNER_PINNED_MANAGER_REVISION || '').trim();
  const managerPreflightFingerprint = String(env.AGENT_RUNNER_PINNED_MANAGER_FINGERPRINT || '').trim().toLowerCase();
  const managerPreflightBodyDigest = String(env.AGENT_RUNNER_PINNED_MANAGER_BODY_DIGEST || '').trim().toLowerCase();
  const managerAuthorityKey = String(env.AGENT_RUNNER_PINNED_MANAGER_AUTHORITY_KEY || '').trim();

  if (!Number.isInteger(issueNumber) || issueNumber < 1) return { allowed: false, reason: 'pinned-child-issue-invalid' };
  if (selectionMode !== 'preflight-direct') return { allowed: false, reason: 'pinned-child-selection-mode-invalid', issueNumber };
  if (!preflightIdentity) return { allowed: false, reason: 'pinned-child-preflight-invalid', issueNumber, selectionMode };
  if (!managerPreflightRevision || !managerPreflightFingerprint || !managerPreflightBodyDigest || !managerAuthorityKey) {
    return { allowed: false, reason: 'pinned-child-immutable-manager-packet-invalid', issueNumber, selectionMode };
  }
  if (managerAuthorityKey !== `manager-preflight:${managerPreflightRevision}:${managerPreflightFingerprint}`) {
    return { allowed: false, reason: 'pinned-child-manager-authority-key-mismatch', issueNumber, selectionMode };
  }

  return {
    allowed: true, reason: 'pinned-child-authority-valid', issueNumber, selectionMode,
    preflightIdentity, preflightCommentRevision: commentRevision(preflightIdentity),
    managerPreflightRevision, managerPreflightFingerprint, managerPreflightBodyDigest, managerAuthorityKey,
    claimIdentity: preflightIdentity, claimRevision: commentRevision(preflightIdentity),
    attemptId: String(env.AGENT_RUNNER_PINNED_ATTEMPT_ID || '').trim() || null,
  };
}

export function pinManagerAuthorityComments(comments = [], authority = {}) {
  if (authority.allowed !== true) return { allowed: false, reason: authority.reason, comments: [] };
  if (!Array.isArray(comments)) return { allowed: false, reason: 'pinned-child-comments-invalid', comments: [] };

  const pinnedPreflight = exactComment(comments, authority.preflightIdentity);
  if (!pinnedPreflight) return { allowed: false, reason: 'pinned-child-preflight-not-found', comments: [] };

  const current = resolveCurrentManagerAuthority(comments);
  const currentForPinnedAttempt = current.allowed === true
    || current.reason === MANAGER_PREFLIGHT_ALREADY_CLAIMED;
  if (!currentForPinnedAttempt
    || current.authority?.authorityKey !== authority.managerAuthorityKey
    || current.authority?.packetDigest !== authority.managerPreflightBodyDigest) {
    return { allowed: false, reason: 'pinned-child-preflight-not-current', comments: [] };
  }
  if (!sameCommentIdentity(current.authority.comment, authority.preflightIdentity)) {
    return { allowed: false, reason: 'pinned-child-preflight-comment-changed', comments: [] };
  }

  const filtered = comments.map(commentWithCommandAuthorityRemoved);
  return {
    allowed: true, reason: 'pinned-child-comments-authorized', comments: filtered,
    noChangePolicy: parseNoChangeCompletionPolicy(pinnedPreflight.body || ''),
    evidence: {
      issueNumber: authority.issueNumber, selectionMode: 'preflight-direct',
      preflightCommentRevision: authority.preflightCommentRevision,
      managerPreflightRevision: authority.managerPreflightRevision,
      managerPreflightFingerprint: authority.managerPreflightFingerprint,
      managerPreflightBodyDigest: authority.managerPreflightBodyDigest,
      managerAuthorityKey: authority.managerAuthorityKey,
      pinnedPreflightFound: true, pinnedCommandFound: false,
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
    sourcePreflightCommentId: authority.preflightCommentRevision || null,
    sourcePreflightCommentIdentity: authority.preflightIdentity || null,
    pinnedExecutionAuthority: {
      allowed: false,
      reason,
      issueNumber: authority.issueNumber || null,
      selectionMode: authority.selectionMode || null,
      preflightCommentRevision: authority.preflightCommentRevision || null,
      managerPreflightRevision: authority.managerPreflightRevision || null,
      managerPreflightFingerprint: authority.managerPreflightFingerprint || null,
      managerAuthorityKey: authority.managerAuthorityKey || null,
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
      preflightCommentRevision: authority.preflightCommentRevision,
      managerPreflightRevision: authority.managerPreflightRevision,
      managerPreflightFingerprint: authority.managerPreflightFingerprint,
      managerPreflightBodyDigest: authority.managerPreflightBodyDigest,
      managerAuthorityKey: authority.managerAuthorityKey,
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
          noChangeAccepted = completion.accepted;
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
