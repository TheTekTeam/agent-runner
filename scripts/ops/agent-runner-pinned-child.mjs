#!/usr/bin/env node

import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { resolveDispatchAuthority } from './agent-runner-dispatch-authority.mjs';
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
const RUNNER_STARTED_PATTERN = /^## Claude runner started\s*$/im;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ATTEMPT_PATTERN = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*):(.+)$/;

/**
 * Every reason this module is allowed to publish. Nothing else may ever reach the
 * structured failure payload: a raw exception message from the child (GitHub transport
 * errors in particular embed a response body slice), a provider diagnostic or any other
 * free text is replaced by `pinned-child-authority-failed` rather than emitted.
 */
export const PINNED_PUBLIC_FAILURE_REASONS = Object.freeze([
  'pinned-child-issue-invalid',
  'pinned-child-issue-repository-invalid',
  'pinned-child-selection-mode-invalid',
  'pinned-child-claim-mode-invalid',
  'pinned-child-preflight-invalid',
  'pinned-child-runner-start-invalid',
  'pinned-child-immutable-manager-packet-invalid',
  'pinned-child-manager-authority-key-mismatch',
  'pinned-child-dispatch-authority-invalid',
  'pinned-child-attempt-id-mismatch',
  'pinned-child-invocation-mismatch',
  'pinned-child-comments-invalid',
  'pinned-child-preflight-not-found',
  'pinned-child-preflight-not-current',
  'pinned-child-preflight-comment-changed',
  'pinned-child-dispatch-authority-mismatch',
  'pinned-child-runner-start-not-found',
  'pinned-child-runner-start-duplicate',
  'pinned-child-runner-start-mismatch',
  'pinned-child-inherited-authority-not-current',
  'pinned-child-fetch-unavailable',
  'pinned-child-authority-failed',
]);

function boundedFailureReason(error) {
  const reason = typeof error?.message === 'string' ? error.message : '';
  return PINNED_PUBLIC_FAILURE_REASONS.includes(reason) ? reason : 'pinned-child-authority-failed';
}

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

function markerField(comment, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(comment?.body || '').match(new RegExp(escaped + ':\\s*`?([^\\s`]+)`?', 'i'))?.[1] || null;
}

function matchingRunnerStartedComments(comments, authorityKey) {
  return comments.filter((comment) => RUNNER_STARTED_PATTERN.test(String(comment?.body || ''))
    && markerField(comment, 'Manager packet authority') === authorityKey);
}

function pinnedDispatchIdentity(currentAuthority, authority) {
  return resolveDispatchAuthority({
    preflight: currentAuthority.comment,
    legacyMetadata: {},
    argsRepo: authority.issueRepository,
    config: {
      githubRepo: authority.approvedRepository,
      localRepoPath: '/pinned-authority-project',
    },
    runnerCheckout: '/pinned-authority-runner',
  });
}

export function pinnedAuthorityFromEnv(env = process.env) {
  const issueNumber = Number.parseInt(env.AGENT_RUNNER_PINNED_ISSUE || '', 10);
  const attemptId = String(env.AGENT_RUNNER_PINNED_ATTEMPT_ID || '').trim();
  const attempt = attemptId.match(ATTEMPT_PATTERN);
  const issueRepository = String(env.AGENT_RUNNER_PINNED_ISSUE_REPOSITORY || attempt?.[1] || '').trim();
  const selectionMode = String(env.AGENT_RUNNER_PINNED_SELECTION_MODE || '').trim();
  const claimMode = String(env.AGENT_RUNNER_PINNED_CLAIM_MODE || 'unclaimed').trim();
  const preflightIdentity = normalizeCommentIdentity(
    env.AGENT_RUNNER_PINNED_PREFLIGHT_COMMENT_REVISION,
    { context: 'pinned-child-preflight' },
  );
  const runnerStartedIdentity = normalizeCommentIdentity(
    env.AGENT_RUNNER_PINNED_RUNNER_STARTED_COMMENT_REVISION,
    { context: 'pinned-child-runner-start' },
  );
  const managerPreflightRevision = String(env.AGENT_RUNNER_PINNED_MANAGER_REVISION || '').trim();
  const managerPreflightFingerprint = String(env.AGENT_RUNNER_PINNED_MANAGER_FINGERPRINT || '').trim().toLowerCase();
  const managerPreflightBodyDigest = String(env.AGENT_RUNNER_PINNED_MANAGER_BODY_DIGEST || '').trim().toLowerCase();
  const managerAuthorityKey = String(env.AGENT_RUNNER_PINNED_MANAGER_AUTHORITY_KEY || '').trim();
  const approvedRepository = String(env.AGENT_RUNNER_PINNED_APPROVED_REPOSITORY || '').trim();
  const approvedBranch = String(env.AGENT_RUNNER_PINNED_APPROVED_BRANCH || '').trim();
  const approvedBaseCommit = String(env.AGENT_RUNNER_PINNED_APPROVED_BASE_COMMIT || '').trim().toLowerCase();
  const approvedAgent = String(env.AGENT_RUNNER_PINNED_APPROVED_AGENT || '').trim();

  if (!Number.isInteger(issueNumber) || issueNumber < 1) return { allowed: false, reason: 'pinned-child-issue-invalid' };
  if (!REPO_PATTERN.test(issueRepository)) return { allowed: false, reason: 'pinned-child-issue-repository-invalid', issueNumber };
  if (selectionMode !== 'preflight-direct') return { allowed: false, reason: 'pinned-child-selection-mode-invalid', issueNumber };
  if (!['claimed', 'unclaimed'].includes(claimMode)) return { allowed: false, reason: 'pinned-child-claim-mode-invalid', issueNumber, selectionMode };
  if (!preflightIdentity) return { allowed: false, reason: 'pinned-child-preflight-invalid', issueNumber, selectionMode };
  if (claimMode === 'claimed' && !runnerStartedIdentity) return { allowed: false, reason: 'pinned-child-runner-start-invalid', issueNumber, selectionMode };
  if (!managerPreflightRevision || !FINGERPRINT_PATTERN.test(managerPreflightFingerprint)
    || !FINGERPRINT_PATTERN.test(managerPreflightBodyDigest) || !managerAuthorityKey) {
    return { allowed: false, reason: 'pinned-child-immutable-manager-packet-invalid', issueNumber, selectionMode };
  }
  if (managerAuthorityKey !== `manager-preflight:${managerPreflightRevision}:${managerPreflightFingerprint}`) {
    return { allowed: false, reason: 'pinned-child-manager-authority-key-mismatch', issueNumber, selectionMode };
  }
  const completeDispatchProjection = REPO_PATTERN.test(approvedRepository)
    && Boolean(approvedBranch)
    && COMMIT_PATTERN.test(approvedBaseCommit)
    && Boolean(approvedAgent);
  if (claimMode === 'claimed' && !completeDispatchProjection) {
    return { allowed: false, reason: 'pinned-child-dispatch-authority-invalid', issueNumber, selectionMode };
  }
  if (!attempt || attempt[1] !== issueRepository || Number(attempt[2]) !== issueNumber) {
    return { allowed: false, reason: 'pinned-child-attempt-id-mismatch', issueNumber, selectionMode };
  }

  return {
    allowed: true,
    reason: 'pinned-child-authority-valid',
    issueNumber,
    issueRepository,
    selectionMode,
    claimMode,
    preflightIdentity,
    preflightCommentRevision: commentRevision(preflightIdentity),
    runnerStartedIdentity,
    runnerStartedCommentRevision: commentRevision(runnerStartedIdentity),
    managerPreflightRevision,
    managerPreflightFingerprint,
    managerPreflightBodyDigest,
    managerAuthorityKey,
    approvedRepository,
    approvedBranch,
    approvedBaseCommit,
    approvedAgent,
    claimIdentity: preflightIdentity,
    claimRevision: commentRevision(preflightIdentity),
    attemptId,
  };
}

function argvOption(argv, name) {
  const index = Array.isArray(argv) ? argv.indexOf(name) : -1;
  return index >= 0 ? argv[index + 1] || null : null;
}

function childInvocationMatchesAuthority(argv, authority) {
  const issueNumber = Number.parseInt(argvOption(argv, '--issue') || '', 10);
  const attemptId = argvOption(argv, '--attempt-id');
  return issueNumber === Number(authority.issueNumber) && attemptId === authority.attemptId;
}

export function pinManagerAuthorityComments(comments = [], authority = {}) {
  if (authority.allowed !== true) return { allowed: false, reason: authority.reason, comments: [] };
  if (!Array.isArray(comments)) return { allowed: false, reason: 'pinned-child-comments-invalid', comments: [] };

  const pinnedPreflight = exactComment(comments, authority.preflightIdentity);
  if (!pinnedPreflight) return { allowed: false, reason: 'pinned-child-preflight-not-found', comments: [] };

  const current = resolveCurrentManagerAuthority(comments);
  const currentForPinnedAttempt = authority.claimMode === 'claimed'
    ? current.reason === MANAGER_PREFLIGHT_ALREADY_CLAIMED
    : current.allowed === true;
  if (!currentForPinnedAttempt
    || current.authority?.authorityKey !== authority.managerAuthorityKey
    || current.authority?.revision !== authority.managerPreflightRevision
    || current.authority?.fingerprint !== authority.managerPreflightFingerprint
    || current.authority?.packetDigest !== authority.managerPreflightBodyDigest
    || (authority.approvedAgent && current.authority?.approvedAgent !== authority.approvedAgent)) {
    return { allowed: false, reason: 'pinned-child-preflight-not-current', comments: [] };
  }
  if (!sameCommentIdentity(current.authority.comment, authority.preflightIdentity)) {
    return { allowed: false, reason: 'pinned-child-preflight-comment-changed', comments: [] };
  }

  const hasDispatchProjection = Boolean(
    authority.approvedRepository
    || authority.approvedBranch
    || authority.approvedBaseCommit
    || authority.approvedAgent,
  );
  if (authority.claimMode === 'claimed' || hasDispatchProjection) {
    const dispatch = pinnedDispatchIdentity(current.authority, authority);
    if (!dispatch.ok
      || dispatch.repository !== authority.approvedRepository
      || dispatch.branch !== authority.approvedBranch
      || String(dispatch.baseCommit).toLowerCase() !== authority.approvedBaseCommit
      || current.authority.approvedAgent !== authority.approvedAgent) {
      return { allowed: false, reason: 'pinned-child-dispatch-authority-mismatch', comments: [] };
    }
  }

  let ownRunnerStarted = null;
  if (authority.claimMode === 'claimed') {
    const markers = matchingRunnerStartedComments(comments, authority.managerAuthorityKey);
    if (markers.length !== 1) {
      return { allowed: false, reason: markers.length === 0 ? 'pinned-child-runner-start-not-found' : 'pinned-child-runner-start-duplicate', comments: [] };
    }
    ownRunnerStarted = exactComment(markers, authority.runnerStartedIdentity);
    if (!ownRunnerStarted
      || markerField(ownRunnerStarted, 'Source preflight comment') !== authority.preflightCommentRevision
      || markerField(ownRunnerStarted, 'Manager packet revision') !== authority.managerPreflightRevision
      || markerField(ownRunnerStarted, 'Manager packet fingerprint') !== authority.managerPreflightFingerprint
      || markerField(ownRunnerStarted, 'Manager packet authority') !== authority.managerAuthorityKey
      || markerField(ownRunnerStarted, 'Manager packet body digest') !== authority.managerPreflightBodyDigest) {
      return { allowed: false, reason: 'pinned-child-runner-start-mismatch', comments: [] };
    }
  }

  const filtered = comments
    .filter((comment) => !ownRunnerStarted || !sameCommentIdentity(comment, authority.runnerStartedIdentity))
    .map(commentWithCommandAuthorityRemoved);
  const inheritedCurrent = resolveCurrentManagerAuthority(filtered);
  if (inheritedCurrent.allowed !== true
    || inheritedCurrent.authority?.authorityKey !== authority.managerAuthorityKey
    || inheritedCurrent.authority?.packetDigest !== authority.managerPreflightBodyDigest) {
    return { allowed: false, reason: 'pinned-child-inherited-authority-not-current', comments: [] };
  }

  return {
    allowed: true,
    reason: 'pinned-child-comments-authorized',
    comments: filtered,
    noChangePolicy: parseNoChangeCompletionPolicy(pinnedPreflight.body || ''),
    evidence: {
      issueNumber: authority.issueNumber,
      issueRepository: authority.issueRepository,
      selectionMode: 'preflight-direct',
      claimMode: authority.claimMode,
      preflightCommentRevision: authority.preflightCommentRevision,
      runnerStartedCommentRevision: authority.runnerStartedCommentRevision,
      managerPreflightRevision: authority.managerPreflightRevision,
      managerPreflightFingerprint: authority.managerPreflightFingerprint,
      managerPreflightBodyDigest: authority.managerPreflightBodyDigest,
      managerAuthorityKey: authority.managerAuthorityKey,
      approvedRepository: authority.approvedRepository,
      approvedBranch: authority.approvedBranch,
      approvedBaseCommit: authority.approvedBaseCommit,
      approvedAgent: authority.approvedAgent,
      attemptId: authority.attemptId,
      pinnedPreflightFound: true,
      pinnedRunnerStartedFound: authority.claimMode === 'claimed',
      pinnedCommandFound: false,
    },
  };
}

const GITHUB_API_ORIGIN = 'https://api.github.com';

function requestUrl(input) {
  return typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
}

function commentsRequestForIssue(input, issueNumber) {
  return new RegExp(`/issues/${issueNumber}/comments(?:\\?|$)`).test(requestUrl(input));
}

// The only retained delay, and it no longer polls a list. GitHub's exact single-comment
// endpoint can still answer 404 for a few hundred milliseconds for a comment this runner
// published moments earlier, so exactly two short re-reads cover that publication window.
// A 404 is the only retried outcome: every other exact-read failure is terminal on the
// first read, and no configuration or environment input can widen this compiled-in bound.
export const PINNED_EXACT_COMMENT_NOT_FOUND_RETRY_DELAYS_MS = Object.freeze([200, 400]);
export const PINNED_EXACT_COMMENT_READ_ATTEMPTS = PINNED_EXACT_COMMENT_NOT_FOUND_RETRY_DELAYS_MS.length + 1;
export const PINNED_EXACT_COMMENT_READ_WINDOW_MS = PINNED_EXACT_COMMENT_NOT_FOUND_RETRY_DELAYS_MS
  .reduce((total, ms) => total + ms, 0);

/**
 * Issue #143 (PINNED.CONSISTENCY.4): the public refusal stays exactly
 * `pinned-child-preflight-not-found`, which is correct but covers eleven distinct
 * boundaries. Issues #137, #139 and #141 each shipped a plausible repair for one of them
 * without production ever proving which boundary it actually reached. These literals are
 * the whole diagnostic vocabulary, and a diagnostic is assembled only from them plus a
 * comment role, a bounded HTTP status and immutable database identities. No response
 * body, header, credential, URL, prompt, provider output or exception text can reach it,
 * because none of those values is ever read into the payload.
 */
export const PINNED_DIAGNOSTIC_REASONS = Object.freeze([
  'exact-url-invalid',
  'direct-preflight-404',
  'direct-preflight-non-success',
  'direct-preflight-malformed',
  'direct-preflight-identity-mismatch',
  'direct-runner-start-404',
  'direct-runner-start-non-success',
  'direct-runner-start-malformed',
  'direct-runner-start-identity-mismatch',
  'exact-comment-merge-conflict',
  'post-merge-authority-rejected',
]);

export const PINNED_COMMENT_ROLES = Object.freeze(['manager-preflight', 'runner-start']);

// The exact-read outcomes, per comment role. A transport exception carries no status and
// is classified as a non-successful direct read; the exception itself is discarded unread.
const DIRECT_READ_REASONS = Object.freeze({
  'manager-preflight': Object.freeze({
    'not-found': 'direct-preflight-404',
    'non-success': 'direct-preflight-non-success',
    malformed: 'direct-preflight-malformed',
    'identity-mismatch': 'direct-preflight-identity-mismatch',
  }),
  'runner-start': Object.freeze({
    'not-found': 'direct-runner-start-404',
    'non-success': 'direct-runner-start-non-success',
    malformed: 'direct-runner-start-malformed',
    'identity-mismatch': 'direct-runner-start-identity-mismatch',
  }),
});

function boundedHttpStatus(status) {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function boundedDatabaseId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * The only constructor of a diagnostic payload, and the only place its shape is decided.
 * An unrecognised reason yields no diagnostic at all, and every retained field is bounded
 * by value shape rather than trusted from its caller.
 */
function pinnedDiagnostic({ reason, commentRole = null, httpStatus = null, commentDatabaseId = null, attemptId = null } = {}) {
  if (!PINNED_DIAGNOSTIC_REASONS.includes(reason)) return null;
  return Object.freeze({
    reason,
    commentRole: PINNED_COMMENT_ROLES.includes(commentRole) ? commentRole : null,
    httpStatus: boundedHttpStatus(httpStatus),
    commentDatabaseId: boundedDatabaseId(commentDatabaseId),
    attemptId: typeof attemptId === 'string' && ATTEMPT_PATTERN.test(attemptId) ? attemptId : null,
  });
}

// Re-runs the bounded constructor over anything claiming to be a diagnostic, so a payload
// that reached this module from elsewhere can never widen what is emitted.
function sanitizedDiagnostic(value) {
  return value && typeof value === 'object' ? pinnedDiagnostic(value) : null;
}

function pinnedFailure(reason, diagnostic) {
  const error = new Error(reason);
  error.pinnedDiagnostic = diagnostic || null;
  return error;
}

/**
 * Issue #141 (PINNED.CONSISTENCY.3): issue #136 packet .4 pinned preflight comment
 * 5160875310 and runner-start comment 5160880611, and the child exhausted the whole
 * eight-second issue-comments-list ladder because the replica it kept re-reading never
 * exposed them. Re-reading the same list endpoint cannot repair that, so the exact
 * comments are read by their immutable database identity instead.
 *
 * Exactly one condition opens that path: the list this child already read does not
 * contain one of the exact comments the pinned attempt requires. Every other fail-closed
 * verdict — identity, revision, fingerprint, body digest, authority key, duplicate
 * marker, stale or edited authority, dispatch projection, malformed or non-successful
 * responses — is reached with the required exact comments already present in the list
 * and stays single-pass.
 */
function requiredExactCommentsAbsent(listComments, authority) {
  if (!Array.isArray(listComments)) return false;
  const absent = (identity) => identity?.databaseId != null
    && !listComments.some((comment) => sameCommentIdentity(comment, identity));
  return absent(authority.preflightIdentity)
    || (authority.claimMode === 'claimed' && absent(authority.runnerStartedIdentity));
}

function revalidatedCommentRead(input, init) {
  const inheritedHeaders = init?.headers
    ?? (typeof Request === 'function' && input instanceof Request ? input.headers : undefined);
  const headers = new Headers(inheritedHeaders);
  headers.set('cache-control', 'no-cache');
  headers.set('pragma', 'no-cache');
  return { ...(init || {}), headers, cache: 'no-store' };
}

function boundedRepositoryIdentity(issueRepository) {
  const repository = String(issueRepository || '').trim();
  if (!REPO_PATTERN.test(repository)) return null;
  const [owner, repo] = repository.split('/');
  return owner && repo ? { owner, repo } : null;
}

/**
 * GET /repos/{owner}/{repo}/issues/comments/{comment_id}. The owner and repository
 * segments come only from the validated `authority.issueRepository` projection, never
 * from the observed request; the origin and any API path prefix are inherited from the
 * list request the child already issued so enterprise hosts keep working. Anything that
 * does not resolve to the expected bounded list path yields no URL, and the caller then
 * fails closed on the original reason.
 */
function exactCommentUrl(input, authority, databaseId) {
  const identity = boundedRepositoryIdentity(authority.issueRepository);
  if (!identity) return null;
  if (!Number.isSafeInteger(databaseId) || databaseId < 1) return null;
  let listUrl;
  try {
    listUrl = new URL(requestUrl(input), GITHUB_API_ORIGIN);
  } catch {
    return null;
  }
  const listPath = `/repos/${identity.owner}/${identity.repo}/issues/${authority.issueNumber}/comments`;
  if (!listUrl.pathname.endsWith(listPath)) return null;
  const prefix = listUrl.pathname.slice(0, listUrl.pathname.length - listPath.length);
  return `${listUrl.origin}${prefix}/repos/${identity.owner}/${identity.repo}/issues/comments/${databaseId}`;
}

/**
 * Reads exactly one comment by immutable database id. Success of the endpoint alone
 * proves nothing: the payload must be a single JSON object whose own proven database
 * identity is the identity that was requested. Every other outcome returns a bounded
 * `failure` classification so the pinned attempt still fails closed on its original
 * reason, now with the stage that produced it recorded.
 */
async function readExactComment({ originalFetch, input, init, url, identity, sleep }) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await originalFetch(url, revalidatedCommentRead(input, init));
    } catch {
      // A transport failure is never retried and never authorizes.
      return { failure: 'non-success', httpStatus: null };
    }
    const httpStatus = boundedHttpStatus(response?.status);
    if (response?.status === 404) {
      if (attempt < PINNED_EXACT_COMMENT_NOT_FOUND_RETRY_DELAYS_MS.length) {
        await sleep(PINNED_EXACT_COMMENT_NOT_FOUND_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return { failure: 'not-found', httpStatus };
    }
    if (!response?.ok) return { failure: 'non-success', httpStatus };
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { failure: 'malformed', httpStatus };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { failure: 'malformed', httpStatus };
    }
    let payloadIdentity = null;
    try {
      payloadIdentity = normalizeCommentIdentity(payload, { context: 'pinned-child-exact-comment' });
    } catch {
      return { failure: 'identity-mismatch', httpStatus };
    }
    if (!payloadIdentity
      || payloadIdentity.databaseId === null
      || payloadIdentity.databaseId !== identity.databaseId
      || !sameCommentIdentity(payloadIdentity, identity)) {
      return { failure: 'identity-mismatch', httpStatus };
    }
    return { comment: payload, httpStatus };
  }
}

// The immutable content a stale list row and an exact direct row must agree on before
// they may collapse into one row.
function commentContentSignature(comment) {
  return JSON.stringify([
    String(comment?.body ?? ''),
    String(comment?.user?.login ?? comment?.author?.login ?? comment?.login ?? ''),
    String(comment?.created_at ?? comment?.createdAt ?? ''),
    String(comment?.updated_at ?? comment?.updatedAt ?? ''),
  ]);
}

/**
 * Combines the original list payload with the directly read exact comments purely so the
 * existing validator sees them. A list row is never replaced: an exact row with the same
 * database identity may only collapse into the row already present, and only when their
 * content is equivalent. Conflicting content reports the conflicting exact row and fails
 * the attempt closed.
 */
function mergedExactComments(listComments, exactComments) {
  const merged = [...listComments];
  for (const exact of exactComments) {
    const index = merged.findIndex((comment) => sameCommentIdentity(comment, exact.comment));
    if (index === -1) {
      merged.push(exact.comment);
      continue;
    }
    if (commentContentSignature(merged[index]) !== commentContentSignature(exact.comment)) {
      return { conflict: exact };
    }
  }
  return { merged };
}

/**
 * Unclaimed mode reads only the exact manager-preflight comment; claimed mode also reads
 * this attempt's own exact runner-start comment. Both must succeed, and the merged
 * payload still has to satisfy every existing pinned validation unchanged. A refusal
 * returns the bounded diagnostic for the stage that produced it and nothing else.
 */
async function authorizeFromExactComments({ authority, listComments, input, init, originalFetch, sleep }) {
  const diagnose = (fields) => ({ diagnostic: pinnedDiagnostic({ ...fields, attemptId: authority.attemptId }) });
  const required = [{ role: 'manager-preflight', identity: authority.preflightIdentity }];
  if (authority.claimMode === 'claimed') {
    required.push({ role: 'runner-start', identity: authority.runnerStartedIdentity });
  }

  const exactComments = [];
  for (const { role, identity } of required) {
    const databaseId = identity?.databaseId ?? null;
    const url = databaseId === null ? null : exactCommentUrl(input, authority, databaseId);
    if (!url) {
      return diagnose({ reason: 'exact-url-invalid', commentRole: role, commentDatabaseId: databaseId });
    }
    const read = await readExactComment({ originalFetch, input, init, url, identity, sleep });
    if (!read.comment) {
      return diagnose({
        reason: DIRECT_READ_REASONS[role][read.failure],
        commentRole: role,
        httpStatus: read.httpStatus,
        commentDatabaseId: databaseId,
      });
    }
    exactComments.push({ role, databaseId, comment: read.comment });
  }

  const merged = mergedExactComments(listComments, exactComments);
  if (merged.conflict) {
    return diagnose({
      reason: 'exact-comment-merge-conflict',
      commentRole: merged.conflict.role,
      commentDatabaseId: merged.conflict.databaseId,
    });
  }
  const pinned = pinManagerAuthorityComments(merged.merged, authority);
  return pinned.allowed ? { pinned } : diagnose({ reason: 'post-merge-authority-rejected' });
}

export function createPinnedFetch({
  authority,
  originalFetch = globalThis.fetch,
  onPinned = null,
  onDiagnostic = null,
  sleep = delay,
} = {}) {
  if (typeof originalFetch !== 'function') throw new Error('pinned-child-fetch-unavailable');
  return async (input, init) => {
    const response = await originalFetch(input, init);
    if (!commentsRequestForIssue(input, authority.issueNumber)) return response;
    let listComments = null;
    try {
      listComments = await response.clone().json();
    } catch {
      listComments = null; // A malformed list never authorizes and is never re-read.
    }
    let pinned = pinManagerAuthorityComments(listComments, authority);
    const originalReason = pinned.allowed ? null : pinned.reason;
    let diagnostic = null;

    if (!pinned.allowed && response.ok && requiredExactCommentsAbsent(listComments, authority)) {
      const exact = await authorizeFromExactComments({
        authority, listComments, input, init, originalFetch, sleep,
      });
      diagnostic = exact.diagnostic || null;
      pinned = exact.pinned || pinned;
    }

    // An exact read never invents a new verdict: the first fail-closed reason is what the
    // child reports, and any harder failure seen on the exact rows still fails closed.
    // The diagnostic only records which bounded stage produced that refusal.
    if (!pinned.allowed) {
      if (diagnostic) onDiagnostic?.(diagnostic);
      throw pinnedFailure(originalReason, diagnostic);
    }
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

function projectionEvidence(authority, allowed, reason) {
  return {
    allowed,
    reason,
    issueNumber: authority.issueNumber || null,
    issueRepository: authority.issueRepository || null,
    selectionMode: authority.selectionMode || null,
    claimMode: authority.claimMode || null,
    preflightCommentRevision: authority.preflightCommentRevision || null,
    runnerStartedCommentRevision: authority.runnerStartedCommentRevision || null,
    managerPreflightRevision: authority.managerPreflightRevision || null,
    managerPreflightFingerprint: authority.managerPreflightFingerprint || null,
    managerPreflightBodyDigest: authority.managerPreflightBodyDigest || null,
    managerAuthorityKey: authority.managerAuthorityKey || null,
    approvedRepository: authority.approvedRepository || null,
    approvedBranch: authority.approvedBranch || null,
    approvedBaseCommit: authority.approvedBaseCommit || null,
    approvedAgent: authority.approvedAgent || null,
    attemptId: authority.attemptId || null,
  };
}

function structuredFailure(authority, reason, diagnostic = null) {
  return {
    mode: 'pinned-execution-authority',
    blocked: true,
    reason,
    failureReason: reason,
    issue: authority.issueNumber || null,
    sourcePreflightCommentId: authority.preflightCommentRevision || null,
    sourcePreflightCommentIdentity: authority.preflightIdentity || null,
    pinnedExecutionAuthority: projectionEvidence(authority, false, reason),
    pinnedAuthorityDiagnostic: sanitizedDiagnostic(diagnostic),
  };
}

function withPinnedAuthorityEvidence(payload, authority) {
  return {
    ...payload,
    pinnedExecutionAuthority: projectionEvidence(authority, true, 'pinned-child-authority-applied'),
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const authority = pinnedAuthorityFromEnv(env);
  if (!authority.allowed) {
    console.log(JSON.stringify(structuredFailure(authority, authority.reason), null, 2));
    return 4;
  }
  const invocationIdentityPresent = argvOption(argv, '--issue') || argvOption(argv, '--attempt-id');
  if ((authority.claimMode === 'claimed' || invocationIdentityPresent)
    && !childInvocationMatchesAuthority(argv, authority)) {
    const reason = 'pinned-child-invocation-mismatch';
    console.log(JSON.stringify(structuredFailure(authority, reason), null, 2));
    return 4;
  }

  const originalFetch = dependencies.originalFetch || globalThis.fetch;
  const runChildMain = dependencies.childMain || childMain;
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  let noChangePolicy = parseNoChangeCompletionPolicy('');
  let noChangeAccepted = false;
  let pinnedFetchDiagnostic = null;

  globalThis.fetch = createPinnedFetch({
    authority,
    originalFetch,
    onPinned: (pinned) => { noChangePolicy = pinned.noChangePolicy; },
    onDiagnostic: (value) => { pinnedFetchDiagnostic = value; },
  });
  console.log = (...values) => {
    if (values.length === 1 && typeof values[0] === 'string') {
      try {
        const payload = JSON.parse(values[0]);
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const completion = evaluateManagerAuthorizedNoChange({ payload, policy: noChangePolicy, authority });
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
    // Only a reason this module itself publishes may be emitted. Anything else — a
    // GitHub transport error carrying a response-body slice, a provider diagnostic, any
    // raw exception text — is replaced by the bounded generic reason.
    const reason = boundedFailureReason(error);
    const diagnostic = pinnedFetchDiagnostic || error?.pinnedDiagnostic || null;
    previousLog(JSON.stringify(structuredFailure(authority, reason, diagnostic), null, 2));
    return 4;
  } finally {
    globalThis.fetch = previousFetch;
    console.log = previousLog;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    const reason = boundedFailureReason(error);
    console.log(JSON.stringify({
      mode: 'pinned-execution-authority',
      blocked: true,
      reason,
      failureReason: reason,
      pinnedAuthorityDiagnostic: sanitizedDiagnostic(error?.pinnedDiagnostic),
    }, null, 2));
    process.exitCode = 4;
  });
}
