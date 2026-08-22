#!/usr/bin/env node

/**
 * #268: idempotent, recoverable publication of manager authority.
 *
 * Recording a grant in the local ledger and announcing it on GitHub cannot be
 * one atomic act. Publishing naively therefore has two failure windows, and
 * both strand real work:
 *
 *  - the local ledger says the issue is granted and leased, but no consumable
 *    packet exists, so the worker has nothing to claim and the next
 *    reconciliation sees the issue as already owned and never retries;
 *  - GitHub accepted the comment but the process died before confirming
 *    locally, so a blind retry posts a second packet.
 *
 * The fix is to make publication a reconciled transition rather than a single
 * call:
 *
 *   pin the issuance snapshot
 *     -> persist the publication intent            (pending)
 *     -> re-read the issue's comments
 *     -> if the exact canonical packet is already there, heal to confirmed
 *     -> otherwise post exactly one packet
 *     -> re-read and verify the exact authority key and packet digest
 *     -> only then mark confirmed
 *
 * Every step is safe to repeat. An ambiguous POST result is never guessed at:
 * the record stays pending and the next pass re-reads first. A packet that
 * carries this authority's identity but a different immutable body is a
 * `conflict` -- it is never overwritten and never silently accepted.
 *
 * The pending record is itself ownership evidence, so no second authority can
 * be issued for that issue while a publication is unresolved.
 */

import { ManagementControlStore } from './agent-runner-management-control-store.mjs';
import {
  MANAGER_PREFLIGHT_MARKER,
  packetBodyDigest,
  parseManagerPreflightPacket,
} from './agent-runner-manager-authority.mjs';
import {
  assertNormalizedWorkerAuthorityShape,
  renderManagerWorkerAuthorityPacket,
  workerAuthorityPacketDigest,
} from './agent-runner-manager-worker-authority.mjs';
import { assertNormalizedContinuationAuthorityShape } from './agent-runner-manager-lifecycle-settlement.mjs';
import { isPlainObject, nonEmptyString } from './agent-runner-manager-planner-safety.mjs';

export const MANAGEMENT_PUBLICATION_SCHEMA_VERSION = 'agent-runner-management-publication/v1';

/** The bounded outcomes one ensure-published pass can report. */
export const PUBLICATION_OUTCOMES = Object.freeze([
  'published',
  'already-published',
  'pending-retry',
  'conflict',
]);

/**
 * The continuation notice marker.
 *
 * This is deliberately **not** a second worker-authority format: it mints no
 * authority and starts nothing. The manager-preflight packet remains the only
 * authority a worker may consume, and a continuation reuses the already
 * published one on the same pull request. This record exists so a continuation
 * decision is visible and idempotent, carrying identity and bounded defect
 * classification only.
 */
export const MANAGER_CONTINUATION_MARKER = '<!-- agent-runner:manager-continuation -->';

const MAX_DEFECTS = 20;

function fail(message) {
  throw new Error(`Refusing agent runner authority publication: ${message}`);
}

function assertTransport(transport) {
  if (!isPlainObject(transport)
    || typeof transport.listIssueComments !== 'function'
    || typeof transport.createIssueComment !== 'function') {
    fail('a publication transport with listIssueComments and createIssueComment is required');
  }
  return transport;
}

/**
 * Find a comment already carrying this exact authority identity.
 *
 * Identity is the immutable pair the accepted parser exposes: the authority key
 * (revision + fingerprint) and the packet body digest. A comment matching the
 * key but not the digest is a conflict, not a match.
 */
function findPublishedPacket(comments, authorityKey, packetDigest) {
  for (const comment of comments) {
    const body = String(comment?.body ?? '');
    if (!body.includes(MANAGER_PREFLIGHT_MARKER)) continue;
    const parsed = parseManagerPreflightPacket(comment);
    if (!parsed.authorityKey || parsed.authorityKey !== authorityKey) continue;
    if (parsed.packetDigest === packetDigest) return { match: comment, conflict: null };
    return { match: null, conflict: comment };
  }
  return { match: null, conflict: null };
}

function findPublishedContinuation(comments, continuationKey) {
  for (const comment of comments) {
    const body = String(comment?.body ?? '');
    if (!body.includes(MANAGER_CONTINUATION_MARKER)) continue;
    if (body.includes(continuationKey)) return comment;
  }
  return null;
}

/**
 * Render the bounded continuation notice. Identity and bounded defect
 * classification only: no prose, no provider output, no instruction to start.
 */
export function renderContinuationNotice(continuation) {
  assertNormalizedContinuationAuthorityShape(continuation);
  const defects = continuation.defects.slice(0, MAX_DEFECTS)
    .map((defect) => `- ${defect.source}:${defect.id}:${defect.classification}`);
  return [
    MANAGER_CONTINUATION_MARKER,
    '',
    '## Manager continuation',
    '',
    '```yaml',
    `schema_version: ${MANAGEMENT_PUBLICATION_SCHEMA_VERSION}`,
    `continuation_key: ${continuation.continuationAuthorityKey}`,
    `continuation_revision: ${continuation.continuationRevision}`,
    `kind: ${continuation.kind}`,
    `project_id: ${continuation.projectId}`,
    `repository: ${continuation.repository.full}`,
    `issue: ${continuation.issueNumber}`,
    `pull_request: ${continuation.pullRequestNumber}`,
    `approved_branch: ${continuation.branch}`,
    `base_commit: ${continuation.baseSha}`,
    `head_commit: ${continuation.headSha}`,
    `parent_authority_key: ${continuation.parentAuthorityKey}`,
    '```',
    '',
    '### Bounded defects to correct',
    '',
    ...(defects.length > 0 ? defects : ['- none']),
    '',
  ].join('\n');
}

/**
 * The shared ensure-published reconciliation used by both publication kinds.
 *
 * `find` locates an existing publication in the re-read comments and reports
 * either a match or a conflict; `body` is what would be posted if neither.
 */
function ensurePublished({
  controlStore, transport, publicationKey, kind, projectId, repository,
  issueNumber, pullRequestNumber = null, authorityKey, packetDigest, body, find, now,
}) {
  assertTransport(transport);
  if (!(controlStore instanceof ManagementControlStore)) fail('a ManagementControlStore is required');

  const existing = controlStore.getPublication(publicationKey);
  if (existing && existing.state === 'confirmed') {
    // Already reconciled. Repeating this is a no-op by design.
    return Object.freeze({ outcome: 'already-published', publicationKey, posted: false, publication: existing });
  }
  if (existing && existing.state === 'conflict') {
    return Object.freeze({ outcome: 'conflict', publicationKey, posted: false, publication: existing });
  }

  // Intent first: whatever happens next, the next pass knows a publication was
  // owed for this exact identity.
  controlStore.recordPublicationIntent({
    publicationKey, kind, projectId, repository, issueNumber, pullRequestNumber, authorityKey, packetDigest, now,
  });

  // Re-read before posting. This is what turns "the side effect landed but we
  // died before confirming" into a heal rather than a duplicate.
  let comments;
  try {
    comments = transport.listIssueComments({ repository, issueNumber }) ?? [];
  } catch {
    return Object.freeze({
      outcome: 'pending-retry',
      publicationKey,
      posted: false,
      publication: controlStore.setPublicationState({ publicationKey, state: 'pending', detail: 'comments-unreadable', now }),
    });
  }

  const before = find(comments);
  if (before.conflict) {
    return Object.freeze({
      outcome: 'conflict',
      publicationKey,
      posted: false,
      publication: controlStore.setPublicationState({ publicationKey, state: 'conflict', detail: 'immutable-body-mismatch', now }),
    });
  }
  if (before.match) {
    return Object.freeze({
      outcome: 'already-published',
      publicationKey,
      posted: false,
      publication: controlStore.setPublicationState({ publicationKey, state: 'confirmed', detail: 'reconciled-existing', now }),
    });
  }

  // Exactly one post.
  let postFailed = false;
  try {
    transport.createIssueComment({ repository, issueNumber, body });
  } catch {
    // The result is ambiguous: the request may or may not have reached GitHub.
    // Nothing is guessed -- the record stays pending and the next pass re-reads.
    postFailed = true;
  }

  // Verify by re-reading, whatever the POST appeared to do.
  let verifyComments;
  try {
    verifyComments = transport.listIssueComments({ repository, issueNumber }) ?? [];
  } catch {
    return Object.freeze({
      outcome: 'pending-retry',
      publicationKey,
      posted: !postFailed,
      publication: controlStore.setPublicationState({ publicationKey, state: 'pending', detail: 'verification-unreadable', now }),
    });
  }

  const after = find(verifyComments);
  if (after.conflict) {
    return Object.freeze({
      outcome: 'conflict',
      publicationKey,
      posted: !postFailed,
      publication: controlStore.setPublicationState({ publicationKey, state: 'conflict', detail: 'immutable-body-mismatch', now }),
    });
  }
  if (!after.match) {
    return Object.freeze({
      outcome: 'pending-retry',
      publicationKey,
      posted: false,
      publication: controlStore.setPublicationState({ publicationKey, state: 'pending', detail: postFailed ? 'post-failed' : 'post-unverified', now }),
    });
  }

  // Confirmed only against proof that the exact packet is present.
  return Object.freeze({
    outcome: 'published',
    publicationKey,
    posted: !postFailed,
    publication: controlStore.setPublicationState({ publicationKey, state: 'confirmed', detail: 'verified', now }),
  });
}

/**
 * Ensure the canonical manager-preflight packet for one issued authority exists
 * on its exact issue, exactly once.
 *
 * The packet is the accepted `#267` rendering, so the existing Agent Runner
 * consumer resolves it unchanged. This publishes; it never consumes, claims or
 * dispatches the authority it announces.
 */
export function ensureWorkerAuthorityPublished({ controlStore, transport, authority, now = new Date().toISOString() } = {}) {
  assertNormalizedWorkerAuthorityShape(authority);
  const body = renderManagerWorkerAuthorityPacket(authority);
  const packetDigest = workerAuthorityPacketDigest(authority);
  // Belt and braces: the digest must be the digest of exactly what is posted.
  if (packetBodyDigest(body) !== packetDigest) fail('the rendered packet does not match its digest');

  return ensurePublished({
    controlStore,
    transport,
    publicationKey: `pub-authority-${authority.authorityRevision}`,
    kind: 'worker-authority',
    projectId: authority.projectId,
    repository: authority.repository.full,
    issueNumber: authority.issueNumber,
    pullRequestNumber: null,
    authorityKey: authority.authorityKey,
    packetDigest,
    body,
    find: (comments) => findPublishedPacket(comments, authority.authorityKey, packetDigest),
    now,
  });
}

/**
 * Ensure the bounded continuation notice for one authorised continuation
 * exists on its exact issue, exactly once.
 *
 * Identity is bound by `#267` to the same repository, issue, pull request,
 * branch, base, exact head and parent authority, so a continuation can never
 * drift onto other work.
 */
export function ensureContinuationPublished({ controlStore, transport, continuation, now = new Date().toISOString() } = {}) {
  assertNormalizedContinuationAuthorityShape(continuation);
  const body = renderContinuationNotice(continuation);
  const packetDigest = packetBodyDigest(body);

  return ensurePublished({
    controlStore,
    transport,
    publicationKey: `pub-continuation-${continuation.continuationRevision}`,
    kind: 'continuation-authority',
    projectId: continuation.projectId,
    repository: continuation.repository.full,
    issueNumber: continuation.issueNumber,
    pullRequestNumber: continuation.pullRequestNumber,
    authorityKey: continuation.continuationAuthorityKey,
    packetDigest,
    body,
    find: (comments) => {
      const match = findPublishedContinuation(comments, continuation.continuationAuthorityKey);
      if (!match) return { match: null, conflict: null };
      // Same identity, different immutable body is a conflict, never a match.
      return packetBodyDigest(String(match.body ?? '')) === packetDigest
        ? { match, conflict: null }
        : { match: null, conflict: match };
    },
    now,
  });
}

/**
 * Resume every publication still owed for a project.
 *
 * This is what makes an interrupted publication recover on the next management
 * reconciliation rather than needing an operator. It rebuilds each owed
 * authority from its pinned issuance snapshot and re-runs the same
 * ensure-published reconciliation.
 */
export function resumePendingPublications({
  controlStore, transport, projectId, rebuildAuthority, now = new Date().toISOString(), limit = 20,
} = {}) {
  if (!(controlStore instanceof ManagementControlStore)) fail('a ManagementControlStore is required');
  if (typeof rebuildAuthority !== 'function') fail('a rebuildAuthority function is required');
  const pending = controlStore.listPendingPublications({ projectId, limit });
  const results = [];
  for (const record of pending) {
    // Only worker-authority publications can be rebuilt from a pinned issuance
    // snapshot; a continuation is republished by its own reconciliation.
    if (record.kind !== 'worker-authority') continue;
    let authority = null;
    try {
      authority = rebuildAuthority(record);
    } catch {
      results.push(Object.freeze({ publicationKey: record.publicationKey, outcome: 'pending-retry', reason: 'authority-unrebuildable' }));
      continue;
    }
    if (!authority) {
      results.push(Object.freeze({ publicationKey: record.publicationKey, outcome: 'pending-retry', reason: 'authority-unavailable' }));
      continue;
    }
    const result = ensureWorkerAuthorityPublished({ controlStore, transport, authority, now });
    results.push(Object.freeze({ publicationKey: record.publicationKey, outcome: result.outcome, reason: null }));
  }
  return Object.freeze({
    schemaVersion: MANAGEMENT_PUBLICATION_SCHEMA_VERSION,
    pendingCount: pending.length,
    results: Object.freeze(results),
  });
}

/**
 * Issues whose publication is still unresolved.
 *
 * A pending publication is ownership evidence in its own right: the grant
 * exists locally, so the issue is not free even though nothing is announced yet.
 */
export function unresolvedPublicationIssues({ controlStore, projectId, limit = 50 } = {}) {
  if (!(controlStore instanceof ManagementControlStore)) fail('a ManagementControlStore is required');
  const unresolved = controlStore.listPublications({ projectId, limit })
    .filter((record) => record.state !== 'confirmed');
  return Object.freeze([...new Set(unresolved.map((record) => record.issueNumber))]);
}

/** Whether a body carries the canonical manager-preflight marker. */
export function isCanonicalAuthorityBody(body) {
  return nonEmptyString(body) && body.includes(MANAGER_PREFLIGHT_MARKER);
}
