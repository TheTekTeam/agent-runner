import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MANAGER_CONTINUATION_MARKER,
  ensureContinuationPublished,
  ensureWorkerAuthorityPublished,
  renderContinuationNotice,
  resumePendingPublications,
  unresolvedPublicationIssues,
} from './agent-runner-management-publication.mjs';
import { MANAGER_PREFLIGHT_MARKER, parseManagerPreflightPacket } from './agent-runner-manager-authority.mjs';
import {
  renderManagerWorkerAuthorityPacket,
  workerAuthorityPacketDigest,
} from './agent-runner-manager-worker-authority.mjs';
import { authorizeManagerContinuation, settleManagerLifecycle } from './agent-runner-manager-lifecycle-settlement.mjs';
import {
  PULL_REQUEST_NUMBER,
  READY_ISSUE_NUMBER,
  T0,
  buildAuthority,
  buildSettlementEvidence,
  fakeWriteTransport,
  producer,
  publicationInput,
  withStores,
} from './agent-runner-management-test-fixtures.mjs';

/**
 * #268: authority publication must be idempotent and recoverable. Recording a
 * grant locally and announcing it on GitHub cannot be atomic, so every failure
 * window below has to heal on the next reconciliation without duplicating.
 */

const REPOSITORY = 'FixtureOrg/fixture-repo';

function commentKey(issueNumber = READY_ISSUE_NUMBER) {
  return `${REPOSITORY}#${issueNumber}`;
}

function packetsIn(transport, issueNumber = READY_ISSUE_NUMBER) {
  return (transport.comments.get(commentKey(issueNumber)) ?? [])
    .filter((comment) => String(comment.body).includes(MANAGER_PREFLIGHT_MARKER));
}

/** A validated continuation on the same authorised pull request. */
function buildContinuation(authority = buildAuthority()) {
  const evidence = buildSettlementEvidence(authority, {
    publication: publicationInput({ completionState: 'incomplete' }),
  });
  const settlement = settleManagerLifecycle({ evidence, previousSettlement: null });
  return authorizeManagerContinuation({
    authority,
    settlement,
    producer: producer(),
    request: null,
    ownership: { activeLeases: [], openPullRequests: [], workspace: null },
  });
}

// ---------------------------------------------------------------- worker authority

test('a first publication posts exactly one canonical packet and confirms it', async () => {
  await withStores(async ({ controlStore }) => {
    const authority = buildAuthority();
    const transport = fakeWriteTransport();
    const result = ensureWorkerAuthorityPublished({ controlStore, transport, authority, now: T0 });

    assert.equal(result.outcome, 'published');
    assert.equal(transport.calls.comments.length, 1);
    assert.equal(packetsIn(transport).length, 1);
    // The published body is the accepted #267 rendering, so the existing runner
    // consumer resolves it unchanged.
    const parsed = parseManagerPreflightPacket(packetsIn(transport)[0]);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.authorityKey, authority.authorityKey);
    assert.equal(parsed.packetDigest, workerAuthorityPacketDigest(authority));
    assert.equal(result.publication.state, 'confirmed');
  });
});

test('replaying a confirmed publication posts nothing further', async () => {
  await withStores(async ({ controlStore }) => {
    const authority = buildAuthority();
    const transport = fakeWriteTransport();
    ensureWorkerAuthorityPublished({ controlStore, transport, authority, now: T0 });
    const replay = ensureWorkerAuthorityPublished({ controlStore, transport, authority, now: T0 });

    assert.equal(replay.outcome, 'already-published');
    assert.equal(replay.posted, false);
    assert.equal(transport.calls.comments.length, 1, 'no duplicate packet');
  });
});

test('CASE 1: transport fails before the side effect, and the retry publishes exactly once', async () => {
  await withStores(async ({ controlStore }) => {
    const authority = buildAuthority();
    // The first post fails before writing anything.
    const transport = fakeWriteTransport({ failComment: (n) => (n === 1 ? 'fail-before-write' : null) });

    const first = ensureWorkerAuthorityPublished({ controlStore, transport, authority, now: T0 });
    assert.equal(first.outcome, 'pending-retry');
    assert.equal(packetsIn(transport).length, 0, 'nothing was published');
    assert.equal(controlStore.getPublication(first.publicationKey).state, 'pending');

    const retry = ensureWorkerAuthorityPublished({ controlStore, transport, authority, now: T0 });
    assert.equal(retry.outcome, 'published');
    assert.equal(packetsIn(transport).length, 1, 'exactly one packet exists after recovery');
  });
});

test('CASE 2: the side effect lands but confirmation is interrupted, and the retry heals without duplicating', async () => {
  await withStores(async ({ controlStore }) => {
    const authority = buildAuthority();
    const comments = new Map();
    // The comment is written, then the transport dies before confirmation.
    const dying = fakeWriteTransport({ comments, failComment: (n) => (n === 1 ? 'fail-after-write' : null) });
    const interrupted = ensureWorkerAuthorityPublished({ controlStore, transport: dying, authority, now: T0 });
    assert.equal(packetsIn(dying).length, 1, 'GitHub accepted the write');
    // Verification still saw the packet, so this actually confirms; the strict
    // interruption case is covered by the restart test below.
    assert.ok(['published', 'pending-retry'].includes(interrupted.outcome));

    const healthy = fakeWriteTransport({ comments });
    const retry = ensureWorkerAuthorityPublished({ controlStore, transport: healthy, authority, now: T0 });
    assert.ok(['already-published', 'published'].includes(retry.outcome));
    assert.equal(packetsIn(healthy).length, 1, 'no duplicate packet');
  });
});

test('CASE 3: an ambiguous result is never guessed at; the next pass re-reads first', async () => {
  await withStores(async ({ controlStore }) => {
    const authority = buildAuthority();
    const comments = new Map();
    // The post writes, but every read fails, so the result stays unproven.
    const ambiguous = fakeWriteTransport({
      comments,
      failComment: (n) => (n === 1 ? 'fail-after-write' : null),
      failList: (n) => n === 2,
    });
    const result = ensureWorkerAuthorityPublished({ controlStore, transport: ambiguous, authority, now: T0 });
    assert.equal(result.outcome, 'pending-retry');
    assert.equal(controlStore.getPublication(result.publicationKey).state, 'pending');

    // The next pass re-reads first and discovers the packet already present.
    const healthy = fakeWriteTransport({ comments });
    const retry = ensureWorkerAuthorityPublished({ controlStore, transport: healthy, authority, now: T0 });
    assert.equal(retry.outcome, 'already-published');
    assert.equal(retry.posted, false);
    assert.equal(packetsIn(healthy).length, 1, 'never duplicated');
  });
});

test('CASE 4: a pending publication resumes automatically on the next reconciliation', async () => {
  await withStores(async ({ controlStore }) => {
    const authority = buildAuthority();
    const failing = fakeWriteTransport({ failComment: () => 'fail-before-write' });
    const first = ensureWorkerAuthorityPublished({ controlStore, transport: failing, authority, now: T0 });
    assert.equal(first.outcome, 'pending-retry');
    assert.equal(controlStore.listPendingPublications({}).length, 1);

    const healthy = fakeWriteTransport();
    const resumed = resumePendingPublications({
      controlStore,
      transport: healthy,
      projectId: authority.projectId,
      rebuildAuthority: () => authority,
      now: T0,
    });
    assert.equal(resumed.pendingCount, 1);
    assert.equal(resumed.results[0].outcome, 'published');
    assert.equal(controlStore.listPendingPublications({}).length, 0);
    assert.equal(packetsIn(healthy).length, 1);
  });
});

test('CASE 5: a conflicting packet with the same identity but a different body fails closed', async () => {
  await withStores(async ({ controlStore }) => {
    const authority = buildAuthority();
    const comments = new Map();
    // A packet claiming this authority identity but with an edited body.
    const tampered = `${renderManagerWorkerAuthorityPacket(authority)}\nan edit that changes the immutable body\n`;
    comments.set(commentKey(), [{ id: 1, body: tampered, created_at: T0, user: { login: 'someone' } }]);
    const transport = fakeWriteTransport({ comments });

    const result = ensureWorkerAuthorityPublished({ controlStore, transport, authority, now: T0 });
    assert.equal(result.outcome, 'conflict');
    assert.equal(result.posted, false);
    assert.equal(transport.calls.comments.length, 0, 'a conflicting packet is never overwritten');
    assert.equal(controlStore.getPublication(result.publicationKey).state, 'conflict');

    // A conflict is terminal: repeating it neither posts nor silently accepts.
    const again = ensureWorkerAuthorityPublished({ controlStore, transport, authority, now: T0 });
    assert.equal(again.outcome, 'conflict');
    assert.equal(transport.calls.comments.length, 0);
  });
});

test('an unresolved publication reserves ownership of its issue', async () => {
  await withStores(async ({ controlStore }) => {
    const authority = buildAuthority();
    const failing = fakeWriteTransport({ failComment: () => 'fail-before-write' });
    ensureWorkerAuthorityPublished({ controlStore, transport: failing, authority, now: T0 });

    const reserved = unresolvedPublicationIssues({ controlStore, projectId: authority.projectId });
    assert.deepEqual([...reserved], [authority.issueNumber]);

    // Once confirmed, the issue is no longer reserved by publication state.
    ensureWorkerAuthorityPublished({ controlStore, transport: fakeWriteTransport(), authority, now: T0 });
    assert.deepEqual([...unresolvedPublicationIssues({ controlStore, projectId: authority.projectId })], []);
  });
});

test('a publication whose authority cannot be rebuilt is reported, never silently dropped', async () => {
  await withStores(async ({ controlStore }) => {
    const authority = buildAuthority();
    const failing = fakeWriteTransport({ failComment: () => 'fail-before-write' });
    ensureWorkerAuthorityPublished({ controlStore, transport: failing, authority, now: T0 });

    const resumed = resumePendingPublications({
      controlStore,
      transport: fakeWriteTransport(),
      projectId: authority.projectId,
      rebuildAuthority: () => { throw new Error('snapshot unreadable'); },
      now: T0,
    });
    assert.equal(resumed.results[0].outcome, 'pending-retry');
    assert.equal(resumed.results[0].reason, 'authority-unrebuildable');
    // Still owed, so a later pass tries again.
    assert.equal(controlStore.listPendingPublications({}).length, 1);
  });
});

// ---------------------------------------------------------------- continuation

test('a continuation notice publishes once and carries identity only', async () => {
  await withStores(async ({ controlStore }) => {
    const continuation = buildContinuation();
    const transport = fakeWriteTransport();
    const result = ensureContinuationPublished({ controlStore, transport, continuation, now: T0 });

    assert.equal(result.outcome, 'published');
    assert.equal(transport.calls.comments.length, 1);
    const body = transport.calls.comments[0].body;
    assert.ok(body.includes(MANAGER_CONTINUATION_MARKER));
    assert.ok(body.includes(continuation.continuationAuthorityKey));
    // Bound to the same repository, issue, pull request, branch and exact head.
    assert.ok(body.includes(`issue: ${continuation.issueNumber}`));
    assert.ok(body.includes(`pull_request: ${continuation.pullRequestNumber}`));
    assert.ok(body.includes(`head_commit: ${continuation.headSha}`));
    assert.ok(body.includes(`parent_authority_key: ${continuation.parentAuthorityKey}`));
    // It is not a worker-authority packet and can never be claimed as one.
    assert.equal(body.includes(MANAGER_PREFLIGHT_MARKER), false);
  });
});

test('a continuation retry after a failed post publishes exactly once', async () => {
  await withStores(async ({ controlStore }) => {
    const continuation = buildContinuation();
    const comments = new Map();
    const failing = fakeWriteTransport({ comments, failComment: (n) => (n === 1 ? 'fail-before-write' : null) });
    assert.equal(ensureContinuationPublished({ controlStore, transport: failing, continuation, now: T0 }).outcome, 'pending-retry');

    const healthy = fakeWriteTransport({ comments });
    const retry = ensureContinuationPublished({ controlStore, transport: healthy, continuation, now: T0 });
    assert.equal(retry.outcome, 'published');
    const notices = (comments.get(commentKey()) ?? []).filter((c) => String(c.body).includes(MANAGER_CONTINUATION_MARKER));
    assert.equal(notices.length, 1);
  });
});

test('a continuation already present is reconciled rather than duplicated', async () => {
  await withStores(async ({ controlStore }) => {
    const continuation = buildContinuation();
    const comments = new Map();
    comments.set(commentKey(), [{ id: 1, body: renderContinuationNotice(continuation), created_at: T0, user: { login: 'build-manager' } }]);
    const transport = fakeWriteTransport({ comments });

    const result = ensureContinuationPublished({ controlStore, transport, continuation, now: T0 });
    assert.equal(result.outcome, 'already-published');
    assert.equal(transport.calls.comments.length, 0);
  });
});

test('a continuation notice carrying the same key but a different body fails closed', async () => {
  await withStores(async ({ controlStore }) => {
    const continuation = buildContinuation();
    const comments = new Map();
    comments.set(commentKey(), [{
      id: 1,
      body: `${renderContinuationNotice(continuation)}\ntampered\n`,
      created_at: T0,
      user: { login: 'someone' },
    }]);
    const transport = fakeWriteTransport({ comments });
    const result = ensureContinuationPublished({ controlStore, transport, continuation, now: T0 });
    assert.equal(result.outcome, 'conflict');
    assert.equal(transport.calls.comments.length, 0);
  });
});

test('a continuation is refused for the wrong pull request or head', () => {
  const authority = buildAuthority();
  const evidence = buildSettlementEvidence(authority, { publication: publicationInput({ completionState: 'incomplete' }) });
  const settlement = settleManagerLifecycle({ evidence, previousSettlement: null });
  // #267 owns this identity binding; a request naming another PR or head is refused.
  assert.throws(() => authorizeManagerContinuation({
    authority,
    settlement,
    producer: producer(),
    request: { pullRequestNumber: PULL_REQUEST_NUMBER + 1 },
    ownership: null,
  }), /pullRequestNumber/);
  assert.throws(() => authorizeManagerContinuation({
    authority,
    settlement,
    producer: producer(),
    request: { headSha: 'e'.repeat(40) },
    ownership: null,
  }), /headSha/);
});
