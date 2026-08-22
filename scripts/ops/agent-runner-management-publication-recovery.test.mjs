import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDellManagementWriteAdapters } from './agent-runner-management-write-adapters.mjs';
import {
  ensureContinuationPublished,
  ensureWorkerAuthorityPublished,
  renderContinuationNotice,
} from './agent-runner-management-publication.mjs';
import { openManagementStores } from './agent-runner-management-control-store.mjs';
import { authorizeManagerContinuation, settleManagerLifecycle } from './agent-runner-manager-lifecycle-settlement.mjs';
import {
  MANAGER_PREFLIGHT_MARKER,
  resolveCurrentManagerAuthority,
  resolveManagerPreflightExecutionMetadata,
} from './agent-runner-manager-authority.mjs';
import { evaluateExecutionAuthorization } from './claude-runner-execution-policy.mjs';
import { renderManagerWorkerAuthorityPacket } from './agent-runner-manager-worker-authority.mjs';
import {
  REGISTRY,
  T0,
  buildAuthority,
  buildSettlementEvidence,
  fakeWriteTransport,
  producer,
  publicationInput,
} from './agent-runner-management-test-fixtures.mjs';

/**
 * #268: publication must stay idempotent across pagination boundaries and must
 * recover after a total process loss, for continuations as well as authorities.
 */

const REPOSITORY = 'FixtureOrg/fixture-repo';
const APPROVED_PUBLISHER = 'build-manager';

// ---------------------------------------------------------------- pagination

/**
 * A paginating GitHub emulator behind the real write adapter's `spawn`.
 *
 * `existing` are comments that already sit on the issue; the packet under test
 * is placed beyond the first page so a single unpaginated read could not see it.
 */
function paginatingSpawn({ existing = [], posted = [], pages = 20, failPage = null } = {}) {
  const all = existing;
  return (command, args, options = {}) => {
    if (command !== 'gh') return { status: 1, stdout: '', stderr: 'unexpected' };
    const method = args[2];
    const endpoint = args[3];
    if (method === 'POST' && /\/comments$/.test(endpoint)) {
      const body = JSON.parse(options.input).body;
      posted.push(body);
      all.push({ id: all.length + 1, body, created_at: T0, user: { login: APPROVED_PUBLISHER } });
      return { status: 0, stdout: JSON.stringify({ id: all.length }), stderr: '' };
    }
    const commentsPage = /\/comments\?per_page=(\d+)&page=(\d+)$/.exec(endpoint);
    if (method === 'GET' && commentsPage) {
      const perPage = Number(commentsPage[1]);
      const page = Number(commentsPage[2]);
      if (failPage !== null && page === failPage) return { status: 1, stdout: '', stderr: 'read failed' };
      // A ceiling test keeps every page full so absence can never be proven.
      if (pages === Infinity) {
        return { status: 0, stdout: JSON.stringify(Array.from({ length: perPage }, (unused, i) => ({ id: (page - 1) * perPage + i + 1, body: 'noise', created_at: T0, user: { login: 'someone' } }))), stderr: '' };
      }
      const slice = all.slice((page - 1) * perPage, page * perPage);
      return { status: 0, stdout: JSON.stringify(slice), stderr: '' };
    }
    return { status: 0, stdout: 'null', stderr: '' };
  };
}

/** A validated continuation on the same authorised pull request. */
function buildContinuation(authority = buildAuthority()) {
  const evidence = buildSettlementEvidence(authority, { publication: publicationInput({ completionState: 'incomplete' }) });
  const settlement = settleManagerLifecycle({ evidence, previousSettlement: null });
  return authorizeManagerContinuation({
    authority, settlement, producer: producer(), request: null,
    ownership: { activeLeases: [], openPullRequests: [], workspace: null },
  });
}

function noise(count, from = 0) {
  return Array.from({ length: count }, (unused, i) => ({
    id: from + i + 1, body: `unrelated comment ${from + i + 1}`, created_at: T0, user: { login: 'someone' },
  }));
}

async function withControlStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-publication-recovery-'));
  try {
    const stores = openManagementStores(join(dir, 'controller.sqlite'), { registry: REGISTRY, now: () => T0 });
    try {
      return await fn({ controlStore: stores.controlStore, dir });
    } finally {
      stores.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an exact authority packet beyond the first comment page is discovered, and nothing is posted', async () => {
  await withControlStore(async ({ controlStore }) => {
    const authority = buildAuthority();
    // 120 unrelated comments, then the real packet at position 121.
    const existing = [
      ...noise(120),
      { id: 121, body: renderManagerWorkerAuthorityPacket(authority), created_at: T0, user: { login: APPROVED_PUBLISHER } },
    ];
    const posted = [];
    const transport = createDellManagementWriteAdapters({ spawn: paginatingSpawn({ existing, posted }), env: {} });

    const result = ensureWorkerAuthorityPublished({ controlStore, transport, authority, now: T0 });
    assert.equal(result.outcome, 'already-published');
    assert.deepEqual(posted, [], 'a packet beyond the first page must never be duplicated');
  });
});

test('an exact continuation notice beyond the first comment page is discovered, and nothing is posted', async () => {
  await withControlStore(async ({ controlStore }) => {
    const continuation = buildContinuation();
    const existing = [
      ...noise(150),
      { id: 151, body: renderContinuationNotice(continuation), created_at: T0, user: { login: APPROVED_PUBLISHER } },
    ];
    const posted = [];
    const transport = createDellManagementWriteAdapters({ spawn: paginatingSpawn({ existing, posted }), env: {} });

    const result = ensureContinuationPublished({ controlStore, transport, continuation, now: T0 });
    assert.equal(result.outcome, 'already-published');
    assert.deepEqual(posted, []);
  });
});

test('a conflicting packet beyond the first page fails closed without posting', async () => {
  await withControlStore(async ({ controlStore }) => {
    const authority = buildAuthority();
    const existing = [
      ...noise(120),
      { id: 121, body: `${renderManagerWorkerAuthorityPacket(authority)}\ntampered\n`, created_at: T0, user: { login: 'someone' } },
    ];
    const posted = [];
    const transport = createDellManagementWriteAdapters({ spawn: paginatingSpawn({ existing, posted }), env: {} });

    const result = ensureWorkerAuthorityPublished({ controlStore, transport, authority, now: T0 });
    assert.equal(result.outcome, 'conflict');
    assert.deepEqual(posted, []);
  });
});

test('a pagination read failure is pending-retry, never a blind post', async () => {
  await withControlStore(async ({ controlStore }) => {
    const authority = buildAuthority();
    const posted = [];
    // Page 1 is full, page 2 fails: absence is unproven.
    const transport = createDellManagementWriteAdapters({
      spawn: paginatingSpawn({ existing: noise(150), posted, failPage: 2 }),
      env: {},
    });
    const result = ensureWorkerAuthorityPublished({ controlStore, transport, authority, now: T0 });
    assert.equal(result.outcome, 'pending-retry');
    assert.deepEqual(posted, [], 'an unproven absence must never license a post');
  });
});

test('exceeding the bounded discovery ceiling fails closed rather than duplicating', async () => {
  await withControlStore(async ({ controlStore }) => {
    const authority = buildAuthority();
    const posted = [];
    // Every page comes back full, so the ceiling is reached with absence unproven.
    const transport = createDellManagementWriteAdapters({
      spawn: paginatingSpawn({ existing: [], posted, pages: Infinity }),
      env: {},
    });
    const result = ensureWorkerAuthorityPublished({ controlStore, transport, authority, now: T0 });
    assert.equal(result.outcome, 'pending-retry');
    assert.deepEqual(posted, [], 'the ceiling must fail closed, never post');
  });
});

test('a fully-read comment set still publishes exactly once', async () => {
  await withControlStore(async ({ controlStore }) => {
    const authority = buildAuthority();
    const posted = [];
    const transport = createDellManagementWriteAdapters({
      spawn: paginatingSpawn({ existing: noise(250), posted }), env: {},
    });
    assert.equal(ensureWorkerAuthorityPublished({ controlStore, transport, authority, now: T0 }).outcome, 'published');
    assert.equal(posted.length, 1);
    // And a replay across the same paginated set posts nothing further.
    assert.equal(ensureWorkerAuthorityPublished({ controlStore, transport, authority, now: T0 }).outcome, 'already-published');
    assert.equal(posted.length, 1);
  });
});

// ---------------------------------------------------------------- approved-author consumer gate

test('the published authority is consumable through the approved-author candidate gate', async () => {
  await withControlStore(async ({ controlStore }) => {
    const authority = buildAuthority();
    const comments = new Map();
    const transport = fakeWriteTransport({ comments });
    assert.equal(ensureWorkerAuthorityPublished({ controlStore, transport, authority, now: T0 }).outcome, 'published');

    const published = (comments.get(`${REPOSITORY}#${authority.issueNumber}`) ?? [])
      .filter((comment) => String(comment.body).includes(MANAGER_PREFLIGHT_MARKER));
    assert.equal(published.length, 1);
    const packet = published[0];

    // The accepted consumer path resolves it as the current authority...
    assert.equal(resolveCurrentManagerAuthority([packet]).allowed, true);

    // ...and the real candidate-admission author gate admits it when the
    // publisher is a configured implementation approver.
    const metadata = resolveManagerPreflightExecutionMetadata(packet);
    const approved = evaluateExecutionAuthorization({
      metadata,
      currentPreflight: packet,
      profileName: 'complex',
      env: {
        CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: packet.user.login,
        CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: '1',
      },
    });
    assert.equal(approved.allowed, true, approved.violations.join(', '));
    assert.equal(approved.phase, 'implementation');
    assert.equal(approved.preflightApprover, packet.user.login);
  });
});

test('an unapproved publisher remains refused by the candidate gate', async () => {
  await withControlStore(async ({ controlStore }) => {
    const authority = buildAuthority();
    const comments = new Map();
    const transport = fakeWriteTransport({ comments });
    ensureWorkerAuthorityPublished({ controlStore, transport, authority, now: T0 });
    const packet = (comments.get(`${REPOSITORY}#${authority.issueNumber}`) ?? [])
      .filter((comment) => String(comment.body).includes(MANAGER_PREFLIGHT_MARKER))[0];

    const refused = evaluateExecutionAuthorization({
      metadata: resolveManagerPreflightExecutionMetadata(packet),
      currentPreflight: packet,
      profileName: 'complex',
      env: {
        // The publisher is not in the allowlist.
        CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'someone-else',
        CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: '1',
      },
    });
    assert.equal(refused.allowed, false);
    assert.ok(refused.violations.includes('manager-preflight-author-not-allowlisted'));

    // An empty allowlist is refused too: the gate is never satisfied by default.
    const empty = evaluateExecutionAuthorization({
      metadata: resolveManagerPreflightExecutionMetadata(packet),
      currentPreflight: packet,
      profileName: 'complex',
      env: { CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: '1' },
    });
    assert.equal(empty.allowed, false);
    assert.ok(empty.violations.includes('manager-approver-allowlist-empty'));
  });
});
