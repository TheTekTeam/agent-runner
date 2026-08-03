import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PINNED_CHILD_ENTRYPOINT,
  resolvePinnedExecutionAuthority,
  runChildWithPinnedAuthority,
} from './agent-runner-pinned-atomic-cron.mjs';
import {
  PINNED_EXACT_COMMENT_NOT_FOUND_RETRY_DELAYS_MS,
  PINNED_EXACT_COMMENT_READ_ATTEMPTS,
  PINNED_EXACT_COMMENT_READ_WINDOW_MS,
  createPinnedFetch,
  main as pinnedChildMain,
  pinManagerAuthorityComments,
  pinnedAuthorityFromEnv,
} from './agent-runner-pinned-child.mjs';
import {
  MANAGER_PREFLIGHT_ALREADY_CLAIMED,
  packetBodyDigest,
  resolveCurrentManagerAuthority,
} from './agent-runner-manager-authority.mjs';
import { findLatestClaudeCommand } from './claude-runner-selection.mjs';

const ISSUE = 743;
const ISSUE_REPOSITORY = 'TheTekTeam/modelspend';
const REVISION = 'AR743-SUPERVISED-CANARY-2026-07-25.2';
const FINGERPRINT = 'sha256:20cdfe95e6363775147aa501b94a6f108de9ebf9163d91a06f8ab02ff8f13155';
const AUTHORITY_KEY = `manager-preflight:${REVISION}:${FINGERPRINT}`;
const APPROVED_REPOSITORY = ISSUE_REPOSITORY;
const APPROVED_BRANCH = 'claude/supervised-canary-743';
const APPROVED_BASE = 'fb83e1c8ec6a918c100f0278a4aacc67f89560a9';
const APPROVED_AGENT = 'claude-code-cli';
const ATTEMPT_ID = `${ISSUE_REPOSITORY}#${ISSUE}:2026-07-25T13:20:06.769Z`;
const PREFLIGHT_COMMENT_ID = 5058216754;
const RUNNER_STARTED_COMMENT_ID = 5058217000;

const OLD_CONTINUE = {
  id: 5033672061,
  createdAt: '2026-07-20T10:00:00Z',
  user: { login: 'gpcola' },
  body: '## Claude continue command\n\nContinue the old attempt.',
};

const FRESH_PREFLIGHT = {
  id: PREFLIGHT_COMMENT_ID,
  createdAt: '2026-07-25T13:19:00Z',
  user: { login: 'gpcola' },
  body: `<!-- agent-runner:manager-preflight -->

\`\`\`yaml
schema_version: agent-runner-manager-preflight/v1
revision: ${REVISION}
fingerprint: ${FINGERPRINT}
producer_type: normal_chatgpt_manager_session
approved_agent: ${APPROVED_AGENT}
execution_phase: implementation
approved_repository_scope:
  - ${APPROVED_REPOSITORY}
approved_branch: ${APPROVED_BRANCH}
base_commit: ${APPROVED_BASE}
scope:
  - supervised canary
required_validation:
  - focused scheduler-to-child claim tests
stop_conditions:
  - fail closed before model launch
\`\`\``,
};
const BODY_DIGEST = packetBodyDigest(FRESH_PREFLIGHT.body);

function runnerStartedComment(overrides = {}) {
  return {
    id: RUNNER_STARTED_COMMENT_ID,
    createdAt: '2026-07-25T13:20:07Z',
    user: { login: 'github-actions[bot]' },
    body: `## Claude runner started

- Runner action: claim-ready-issue
- Selection mode: preflight-direct
- Source preflight comment: github-comment:database:${PREFLIGHT_COMMENT_ID}
- Manager packet revision: ${REVISION}
- Manager packet fingerprint: ${FINGERPRINT}
- Manager packet authority: ${AUTHORITY_KEY}
- Manager packet body digest: ${BODY_DIGEST}
- Started at: 2026-07-25T13:20:07Z
- Output directory: /home/gp/.local/state/agent-runner/modelspend

This marker records consumption of exactly this immutable manager packet revision and fingerprint.`,
    ...overrides,
  };
}

const RUNNER_STARTED = runnerStartedComment();
const CLAIMED_COMMENTS = [OLD_CONTINUE, FRESH_PREFLIGHT, RUNNER_STARTED];

function attemptRow(overrides = {}) {
  return {
    attempt_id: ATTEMPT_ID,
    repo: ISSUE_REPOSITORY,
    issue_number: ISSUE,
    claim_id: `github-comment:database:${PREFLIGHT_COMMENT_ID}`,
    claim_identity_json: JSON.stringify({ databaseId: PREFLIGHT_COMMENT_ID }),
    preflight_revision: `github-comment:database:${PREFLIGHT_COMMENT_ID}`,
    preflight_identity_json: JSON.stringify({ databaseId: PREFLIGHT_COMMENT_ID }),
    manager_preflight_revision: REVISION,
    manager_preflight_fingerprint: FINGERPRINT,
    manager_preflight_body_digest: BODY_DIGEST,
    manager_authority_key: AUTHORITY_KEY,
    agent: APPROVED_AGENT,
    worktree_identity_json: JSON.stringify({
      name: `agent-runner-${ISSUE}-github-comment-database-${PREFLIGHT_COMMENT_ID}`,
      expectedBranch: APPROVED_BRANCH,
    }),
    ...overrides,
  };
}

function durableClaim(overrides = {}) {
  return {
    repo: ISSUE_REPOSITORY,
    issue_number: ISSUE,
    payload_json: JSON.stringify({
      action: 'claim-ready-issue',
      selectionMode: 'preflight-direct',
      sourcePreflightCommentIdentity: { databaseId: PREFLIGHT_COMMENT_ID },
      sourcePreflightCommentId: `github-comment:database:${PREFLIGHT_COMMENT_ID}`,
      managerPreflightRevision: REVISION,
      managerPreflightFingerprint: FINGERPRINT,
      managerPreflightBodyDigest: BODY_DIGEST,
      managerAuthorityKey: AUTHORITY_KEY,
      runnerStartedCommentIdentity: { databaseId: RUNNER_STARTED_COMMENT_ID },
      ...overrides,
    }),
  };
}

function fakeState({ attempt = attemptRow(), claims = [durableClaim()] } = {}) {
  return {
    invoke(name, value) {
      if (name === 'recoveryAttempt') {
        assert.equal(value, ATTEMPT_ID);
        return attempt;
      }
      if (name === 'allRows') {
        assert.equal(value, 'claims');
        return claims;
      }
      throw new Error(`unexpected state method: ${name}`);
    },
  };
}

function schedulerArgs(overrides = {}) {
  return {
    repo: ISSUE_REPOSITORY,
    execute: true,
    project: {
      repo: ISSUE_REPOSITORY,
      localRepoPath: '/home/gp/projects/modelspend',
    },
    ...overrides,
  };
}

function env(overrides = {}) {
  return {
    AGENT_RUNNER_PINNED_ISSUE: String(ISSUE),
    AGENT_RUNNER_PINNED_ISSUE_REPOSITORY: ISSUE_REPOSITORY,
    AGENT_RUNNER_PINNED_SELECTION_MODE: 'preflight-direct',
    AGENT_RUNNER_PINNED_CLAIM_MODE: 'claimed',
    AGENT_RUNNER_PINNED_PREFLIGHT_COMMENT_REVISION: `github-comment:database:${PREFLIGHT_COMMENT_ID}`,
    AGENT_RUNNER_PINNED_RUNNER_STARTED_COMMENT_REVISION: `github-comment:database:${RUNNER_STARTED_COMMENT_ID}`,
    AGENT_RUNNER_PINNED_MANAGER_REVISION: REVISION,
    AGENT_RUNNER_PINNED_MANAGER_FINGERPRINT: FINGERPRINT,
    AGENT_RUNNER_PINNED_MANAGER_BODY_DIGEST: BODY_DIGEST,
    AGENT_RUNNER_PINNED_MANAGER_AUTHORITY_KEY: AUTHORITY_KEY,
    AGENT_RUNNER_PINNED_APPROVED_REPOSITORY: APPROVED_REPOSITORY,
    AGENT_RUNNER_PINNED_APPROVED_BRANCH: APPROVED_BRANCH,
    AGENT_RUNNER_PINNED_APPROVED_BASE_COMMIT: APPROVED_BASE,
    AGENT_RUNNER_PINNED_APPROVED_AGENT: APPROVED_AGENT,
    AGENT_RUNNER_PINNED_ATTEMPT_ID: ATTEMPT_ID,
    ...overrides,
  };
}

function commentsResponse(comments = CLAIMED_COMMENTS) {
  return new Response(JSON.stringify(comments), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function childCommentsUrl(issue = ISSUE) {
  return `https://api.github.com/repos/${ISSUE_REPOSITORY}/issues/${issue}/comments?per_page=100`;
}

function resolveFixture(overrides = {}) {
  return resolvePinnedExecutionAuthority({
    state: overrides.state || fakeState(),
    attemptId: overrides.attemptId || ATTEMPT_ID,
    comments: overrides.comments || CLAIMED_COMMENTS,
    args: overrides.args || schedulerArgs(),
  });
}

async function schedulerDispatch(overrides = {}) {
  let launches = 0;
  let observed = null;
  const result = await runChildWithPinnedAuthority({
    command: process.execPath,
    commandArgs: overrides.commandArgs || ['/runner/scripts/ops/claude-runner.mjs', '--issue', String(ISSUE), '--execute', '--attempt-id', ATTEMPT_ID],
    options: { env: { SAFE: 'yes' } },
    state: overrides.state || fakeState(),
    args: overrides.args || schedulerArgs(),
    attemptId: overrides.attemptId || ATTEMPT_ID,
    ghRunner() { return JSON.stringify({ comments: overrides.comments || CLAIMED_COMMENTS }); },
  }, {
    loadComments() { return overrides.comments || CLAIMED_COMMENTS; },
    baseRunChild: async (input) => {
      launches += 1;
      observed = input;
      return { status: 0, signal: null, stdout: '{}', stderr: '', error: null };
    },
  });
  return { result, launches, observed };
}

async function runPinnedChild({ childEnv = env(), comments = CLAIMED_COMMENTS } = {}) {
  let workspacePreparations = 0;
  const previousLog = console.log;
  console.log = () => {};
  try {
    const exitCode = await pinnedChildMain(['--issue', String(ISSUE), '--execute', '--attempt-id', ATTEMPT_ID], childEnv, {
      originalFetch: async () => commentsResponse(comments),
      childMain: async () => {
        const response = await globalThis.fetch(childCommentsUrl());
        const inheritedComments = await response.json();
        const inherited = resolveCurrentManagerAuthority(inheritedComments);
        assert.equal(inherited.allowed, true);
        assert.equal(inherited.authority.authorityKey, AUTHORITY_KEY);
        workspacePreparations += 1;
        return 0;
      },
    });
    return { exitCode, workspacePreparations };
  } finally {
    console.log = previousLog;
  }
}

test('direct child invocation retains canonical already-claimed protection', () => {
  const current = resolveCurrentManagerAuthority(CLAIMED_COMMENTS);
  assert.equal(current.allowed, false);
  assert.equal(current.reason, MANAGER_PREFLIGHT_ALREADY_CLAIMED);
});

test('scheduler resolves the exact immutable claim projection from durable state', () => {
  const authority = resolveFixture();
  assert.equal(authority.allowed, true);
  assert.equal(authority.claimMode, 'claimed');
  assert.equal(authority.issueNumber, ISSUE);
  assert.equal(authority.preflightCommentRevision, `github-comment:database:${PREFLIGHT_COMMENT_ID}`);
  assert.equal(authority.runnerStartedCommentRevision, `github-comment:database:${RUNNER_STARTED_COMMENT_ID}`);
  assert.equal(authority.managerPreflightRevision, REVISION);
  assert.equal(authority.managerPreflightFingerprint, FINGERPRINT);
  assert.equal(authority.managerPreflightBodyDigest, BODY_DIGEST);
  assert.equal(authority.managerAuthorityKey, AUTHORITY_KEY);
  assert.equal(authority.approvedRepository, APPROVED_REPOSITORY);
  assert.equal(authority.approvedBranch, APPROVED_BRANCH);
  assert.equal(authority.approvedBaseCommit, APPROVED_BASE);
  assert.equal(authority.approvedAgent, APPROVED_AGENT);
  assert.equal(authority.attemptId, ATTEMPT_ID);
});

test('scheduler injects the full projection and replaces only the child entrypoint', async () => {
  const { result, launches, observed } = await schedulerDispatch();
  assert.equal(result.status, 0);
  assert.equal(launches, 1);
  assert.equal(observed.commandArgs[0], PINNED_CHILD_ENTRYPOINT);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_ISSUE, String(ISSUE));
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_PREFLIGHT_COMMENT_REVISION, `github-comment:database:${PREFLIGHT_COMMENT_ID}`);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_RUNNER_STARTED_COMMENT_REVISION, `github-comment:database:${RUNNER_STARTED_COMMENT_ID}`);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_MANAGER_REVISION, REVISION);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_MANAGER_FINGERPRINT, FINGERPRINT);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_MANAGER_BODY_DIGEST, BODY_DIGEST);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_MANAGER_AUTHORITY_KEY, AUTHORITY_KEY);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_APPROVED_REPOSITORY, APPROVED_REPOSITORY);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_APPROVED_BRANCH, APPROVED_BRANCH);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_APPROVED_BASE_COMMIT, APPROVED_BASE);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_APPROVED_AGENT, APPROVED_AGENT);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_ATTEMPT_ID, ATTEMPT_ID);
  assert.equal(observed.options.env.SAFE, 'yes');
});

test('scheduler claim followed by child execution accepts the same exact packet once', async () => {
  const { result, launches, observed } = await schedulerDispatch();
  assert.equal(result.status, 0);
  assert.equal(launches, 1);
  const child = await runPinnedChild({ childEnv: observed.options.env });
  assert.equal(child.exitCode, 0);
  assert.equal(child.workspacePreparations, 1);
});

test('child removes only its own verified claim marker and no longer reports already-claimed', () => {
  const authority = pinnedAuthorityFromEnv(env());
  assert.equal(authority.allowed, true);
  const pinned = pinManagerAuthorityComments(CLAIMED_COMMENTS, authority);
  assert.equal(pinned.allowed, true);
  assert.equal(pinned.comments.some((comment) => comment.id === RUNNER_STARTED_COMMENT_ID), false);
  assert.equal(pinned.comments.some((comment) => comment.id === PREFLIGHT_COMMENT_ID), true);
  const current = resolveCurrentManagerAuthority(pinned.comments);
  assert.equal(current.allowed, true);
  assert.notEqual(current.reason, MANAGER_PREFLIGHT_ALREADY_CLAIMED);
});

const schedulerMismatchCases = [
  ['preflight comment identity', {
    state: fakeState({ attempt: attemptRow({ preflight_identity_json: JSON.stringify({ databaseId: PREFLIGHT_COMMENT_ID + 1 }) }) }),
    reason: 'pinned-authority-current-packet-mismatch',
  }],
  ['revision', {
    state: fakeState({ attempt: attemptRow({ manager_preflight_revision: `${REVISION}.tampered` }) }),
    reason: 'pinned-authority-current-packet-mismatch',
  }],
  ['fingerprint', {
    state: fakeState({ attempt: attemptRow({ manager_preflight_fingerprint: `sha256:${'b'.repeat(64)}` }) }),
    reason: 'pinned-authority-current-packet-mismatch',
  }],
  ['body digest', {
    state: fakeState({ attempt: attemptRow({ manager_preflight_body_digest: `sha256:${'c'.repeat(64)}` }) }),
    reason: 'pinned-authority-current-packet-mismatch',
  }],
  ['authority key', {
    state: fakeState({ attempt: attemptRow({ manager_authority_key: `${AUTHORITY_KEY}:tampered` }) }),
    reason: 'pinned-authority-current-packet-mismatch',
  }],
  ['branch', {
    state: fakeState({ attempt: attemptRow({ worktree_identity_json: JSON.stringify({ expectedBranch: 'claude/wrong-branch' }) }) }),
    reason: 'pinned-authority-worktree-branch-mismatch',
  }],
];

for (const [name, fixture] of schedulerMismatchCases) {
  test(`mismatched ${name} fails closed before child/model launch`, async () => {
    const { result, launches } = await schedulerDispatch(fixture);
    assert.equal(result.status, 4);
    assert.equal(launches, 0);
    assert.equal(JSON.parse(result.stdout).failureReason, fixture.reason);
  });
}


test('scheduler rejects a mismatched child issue before spawning the pinned child', async () => {
  const commandArgs = ['/runner/scripts/ops/claude-runner.mjs', '--issue', String(ISSUE + 1), '--execute', '--attempt-id', ATTEMPT_ID];
  const { result, launches } = await schedulerDispatch({ commandArgs });
  assert.equal(result.status, 4);
  assert.equal(launches, 0);
  assert.equal(JSON.parse(result.stdout).failureReason, 'pinned-authority-child-invocation-mismatch');
});

test('scheduler rejects a mismatched child attempt id before spawning the pinned child', async () => {
  const commandArgs = ['/runner/scripts/ops/claude-runner.mjs', '--issue', String(ISSUE), '--execute', '--attempt-id', `${ATTEMPT_ID}:tampered`];
  const { result, launches } = await schedulerDispatch({ commandArgs });
  assert.equal(result.status, 4);
  assert.equal(launches, 0);
  assert.equal(JSON.parse(result.stdout).failureReason, 'pinned-authority-child-invocation-mismatch');
});

test('mismatched issue projection fails closed before child/model launch', async () => {
  const child = await runPinnedChild({ childEnv: env({ AGENT_RUNNER_PINNED_ISSUE: String(ISSUE + 1) }) });
  assert.equal(child.exitCode, 4);
  assert.equal(child.workspacePreparations, 0);
});

test('mismatched attempt id fails closed before child/model launch', async () => {
  const child = await runPinnedChild({ childEnv: env({ AGENT_RUNNER_PINNED_ATTEMPT_ID: `${ISSUE_REPOSITORY}#${ISSUE + 1}:tampered` }) });
  assert.equal(child.exitCode, 4);
  assert.equal(child.workspacePreparations, 0);
});

const childMismatchCases = [
  ['preflight comment identity', { AGENT_RUNNER_PINNED_PREFLIGHT_COMMENT_REVISION: `github-comment:database:${PREFLIGHT_COMMENT_ID + 1}` }],
  ['revision', { AGENT_RUNNER_PINNED_MANAGER_REVISION: `${REVISION}.tampered` }],
  ['fingerprint', { AGENT_RUNNER_PINNED_MANAGER_FINGERPRINT: `sha256:${'b'.repeat(64)}` }],
  ['body digest', { AGENT_RUNNER_PINNED_MANAGER_BODY_DIGEST: `sha256:${'c'.repeat(64)}` }],
  ['authority key', { AGENT_RUNNER_PINNED_MANAGER_AUTHORITY_KEY: `${AUTHORITY_KEY}:tampered` }],
  ['branch', { AGENT_RUNNER_PINNED_APPROVED_BRANCH: 'claude/wrong-branch' }],
];

for (const [name, overrides] of childMismatchCases) {
  test(`tampered child ${name} projection fails closed before worktree/model launch`, async () => {
    const child = await runPinnedChild({ childEnv: env(overrides) });
    assert.equal(child.exitCode, 4);
    assert.equal(child.workspacePreparations, 0);
  });
}

test('an independently prior claim marker still blocks execution', async () => {
  const prior = runnerStartedComment({ id: RUNNER_STARTED_COMMENT_ID + 1, createdAt: '2026-07-25T13:20:06Z' });
  const comments = [OLD_CONTINUE, FRESH_PREFLIGHT, prior, RUNNER_STARTED];
  const { result, launches } = await schedulerDispatch({ comments });
  assert.equal(result.status, 4);
  assert.equal(launches, 0);
  assert.equal(JSON.parse(result.stdout).failureReason, 'pinned-authority-runner-start-duplicate');
});

test('duplicate scheduler execution remains blocked by duplicate durable claim evidence', async () => {
  const state = fakeState({ claims: [durableClaim(), durableClaim()] });
  const { result, launches } = await schedulerDispatch({ state });
  assert.equal(result.status, 4);
  assert.equal(launches, 0);
  assert.equal(JSON.parse(result.stdout).failureReason, 'pinned-authority-claim-row-duplicate');
});

test('supervised canary path reaches worktree creation with one packet and one claim', async () => {
  const state = fakeState();
  const { result, launches, observed } = await schedulerDispatch({ state });
  assert.equal(result.status, 0);
  assert.equal(launches, 1);
  const child = await runPinnedChild({ childEnv: observed.options.env });
  assert.equal(child.exitCode, 0);
  assert.equal(child.workspacePreparations, 1);
  assert.equal(CLAIMED_COMMENTS.filter((comment) => comment.id === PREFLIGHT_COMMENT_ID).length, 1);
  assert.equal(CLAIMED_COMMENTS.filter((comment) => comment.id === RUNNER_STARTED_COMMENT_ID).length, 1);
  assert.equal(state.invoke('allRows', 'claims').length, 1);
});

test('preflight-direct pinning still neutralises historical command authority', () => {
  const authority = pinnedAuthorityFromEnv(env());
  const result = pinManagerAuthorityComments(CLAIMED_COMMENTS, authority);
  assert.equal(result.allowed, true);
  assert.equal(findLatestClaudeCommand(result.comments), null);
  assert.match(result.comments[0].body, /Superseded Claude command/);
});

test('refuses edited packet content without a new manager revision', () => {
  const authority = pinnedAuthorityFromEnv(env());
  const edited = { ...FRESH_PREFLIGHT, body: `${FRESH_PREFLIGHT.body}\nExpanded scope after claim.` };
  const result = pinManagerAuthorityComments([OLD_CONTINUE, edited, RUNNER_STARTED], authority);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'pinned-child-preflight-not-current');
});

test('refuses a newer immutable manager packet', () => {
  const authority = pinnedAuthorityFromEnv(env());
  const newerFingerprint = `sha256:${'d'.repeat(64)}`;
  const newer = {
    id: PREFLIGHT_COMMENT_ID + 10,
    createdAt: '2026-07-25T13:21:00Z',
    user: { login: 'gpcola' },
    body: `<!-- agent-runner:manager-preflight -->

\`\`\`yaml
schema_version: agent-runner-manager-preflight/v1
revision: AR743-SUPERVISED-CANARY-2026-07-25.3
fingerprint: ${newerFingerprint}
producer_type: normal_chatgpt_manager_session
approved_agent: ${APPROVED_AGENT}
execution_phase: implementation
approved_repository_scope:
  - ${APPROVED_REPOSITORY}
approved_branch: ${APPROVED_BRANCH}
base_commit: ${APPROVED_BASE}
scope:
  - replacement packet
required_validation:
  - focused tests
stop_conditions:
  - fail closed
\`\`\``,
  };
  const result = pinManagerAuthorityComments([...CLAIMED_COMMENTS, newer], authority);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'pinned-child-preflight-not-current');
});

test('proceed-command pinned mode remains retired', () => {
  const authority = pinnedAuthorityFromEnv(env({ AGENT_RUNNER_PINNED_SELECTION_MODE: 'proceed-command' }));
  assert.equal(authority.allowed, false);
  assert.equal(authority.reason, 'pinned-child-selection-mode-invalid');
});

test('pinned fetch rewrites only the expected issue comments response', async () => {
  const authority = pinnedAuthorityFromEnv(env());
  const pinnedFetch = createPinnedFetch({ authority, originalFetch: async () => commentsResponse() });
  const response = await pinnedFetch(childCommentsUrl());
  const comments = await response.json();
  assert.equal(comments.some((comment) => comment.id === RUNNER_STARTED_COMMENT_ID), false);
  assert.equal(comments.some((comment) => comment.id === PREFLIGHT_COMMENT_ID), true);
});

// Issue #141 (PINNED.CONSISTENCY.3): issue #136 packet .4 pinned preflight comment
// 5160875310 and runner-start comment 5160880611, and the child exhausted the whole
// eight-second issue-comments-list ladder against a replica that never exposed either
// comment. The list is now read once; absent exact comments are read by their immutable
// database identity through GET /repos/{owner}/{repo}/issues/comments/{comment_id}.
const REPLICATED_LATE = [OLD_CONTINUE];

// The same claim marker comment as read from a replica that has not yet exposed the
// manager packet authority line, so this attempt's own marker is not locatable even
// though a comment with the right database identity is returned.
const PARTIALLY_REPLICATED_RUNNER_STARTED = runnerStartedComment({
  body: `## Claude runner started

- Runner action: claim-ready-issue
- Selection mode: preflight-direct
- Source preflight comment: github-comment:database:${PREFLIGHT_COMMENT_ID}
- Manager packet revision: ${REVISION}
- Manager packet fingerprint: ${FINGERPRINT}
- Started at: 2026-07-25T13:20:07Z`,
});

const UNCLAIMED_AUTHORITY = pinnedAuthorityFromEnv(env({ AGENT_RUNNER_PINNED_CLAIM_MODE: 'unclaimed' }));
const UNCLAIMED_LIST = [OLD_CONTINUE, FRESH_PREFLIGHT];
const EXACT_PREFLIGHT_URL = `https://api.github.com/repos/${ISSUE_REPOSITORY}/issues/comments/${PREFLIGHT_COMMENT_ID}`;
const EXACT_RUNNER_STARTED_URL = `https://api.github.com/repos/${ISSUE_REPOSITORY}/issues/comments/${RUNNER_STARTED_COMMENT_ID}`;

function jsonResponse(value, status = 200, statusText = '') {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

function notFoundResponse() {
  return jsonResponse({ message: 'Not Found' }, 404, 'Not Found');
}

// `list` answers the intercepted issue comments-list request; `exact` maps the direct
// single-comment URLs the child is expected to derive. Any unmapped exact URL answers
// 404, which is exactly how GitHub reports a comment this replica cannot see yet.
function pinnedExactReads({
  authority = pinnedAuthorityFromEnv(env()),
  list = REPLICATED_LATE,
  exact = {},
} = {}) {
  const calls = [];
  const delays = [];
  const pinnedFetch = createPinnedFetch({
    authority,
    originalFetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes(`/issues/${ISSUE}/comments`)) {
        return typeof list === 'function' ? list() : commentsResponse(list);
      }
      const handler = exact[url];
      if (handler === undefined) return notFoundResponse();
      return typeof handler === 'function' ? handler() : jsonResponse(handler);
    },
    sleep: async (ms) => { delays.push(ms); },
  });
  return { pinnedFetch, calls, delays };
}

async function pinnedFetchFailure(pinnedFetch, url = childCommentsUrl()) {
  try {
    await pinnedFetch(url);
  } catch (error) {
    return String(error?.message || error);
  }
  return null;
}

function listReads(calls) {
  return calls.filter(({ url }) => url.includes(`/issues/${ISSUE}/comments`));
}

// The eight-second list-polling ladder is gone. All that remains is a bounded re-read of
// an exact 404 for a comment this runner published moments earlier.
test('the only retained delay is a very small bounded exact-read 404 ladder', () => {
  assert.deepEqual([...PINNED_EXACT_COMMENT_NOT_FOUND_RETRY_DELAYS_MS], [200, 400]);
  assert.equal(PINNED_EXACT_COMMENT_READ_ATTEMPTS, 3);
  assert.equal(PINNED_EXACT_COMMENT_READ_ATTEMPTS, PINNED_EXACT_COMMENT_NOT_FOUND_RETRY_DELAYS_MS.length + 1);
  assert.equal(PINNED_EXACT_COMMENT_READ_WINDOW_MS, 600);
  assert.ok(PINNED_EXACT_COMMENT_READ_WINDOW_MS <= 1000);
  assert.equal(Object.isFrozen(PINNED_EXACT_COMMENT_NOT_FOUND_RETRY_DELAYS_MS), true);
});

test('a stale comments list plus the exact preflight read authorizes unclaimed mode', async () => {
  const { pinnedFetch, calls, delays } = pinnedExactReads({
    authority: UNCLAIMED_AUTHORITY,
    list: REPLICATED_LATE,
    exact: { [EXACT_PREFLIGHT_URL]: FRESH_PREFLIGHT },
  });
  const comments = await (await pinnedFetch(childCommentsUrl())).json();
  assert.equal(comments.some((comment) => comment.id === PREFLIGHT_COMMENT_ID), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, EXACT_PREFLIGHT_URL);
  assert.deepEqual(delays, []);
});

test('unclaimed mode never reads a runner-start comment', async () => {
  const { pinnedFetch, calls } = pinnedExactReads({
    authority: UNCLAIMED_AUTHORITY,
    exact: { [EXACT_PREFLIGHT_URL]: FRESH_PREFLIGHT, [EXACT_RUNNER_STARTED_URL]: RUNNER_STARTED },
  });
  await pinnedFetch(childCommentsUrl());
  assert.equal(calls.length, 2);
  assert.equal(calls.some(({ url }) => url.includes(String(RUNNER_STARTED_COMMENT_ID))), false);
});

test('a stale comments list plus both exact reads authorizes claimed mode', async () => {
  const { pinnedFetch, calls, delays } = pinnedExactReads({
    list: REPLICATED_LATE,
    exact: { [EXACT_PREFLIGHT_URL]: FRESH_PREFLIGHT, [EXACT_RUNNER_STARTED_URL]: RUNNER_STARTED },
  });
  const comments = await (await pinnedFetch(childCommentsUrl())).json();
  assert.equal(comments.some((comment) => comment.id === PREFLIGHT_COMMENT_ID), true);
  assert.equal(comments.some((comment) => comment.id === RUNNER_STARTED_COMMENT_ID), false);
  assert.equal(resolveCurrentManagerAuthority(comments).authority.authorityKey, AUTHORITY_KEY);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, []);
});

test('exact direct URLs come from the authority repository and immutable database ids', async () => {
  const { pinnedFetch, calls } = pinnedExactReads({
    exact: { [EXACT_PREFLIGHT_URL]: FRESH_PREFLIGHT, [EXACT_RUNNER_STARTED_URL]: RUNNER_STARTED },
  });
  await pinnedFetch(childCommentsUrl());
  assert.equal(calls[1].url, `https://api.github.com/repos/${ISSUE_REPOSITORY}/issues/comments/${PREFLIGHT_COMMENT_ID}`);
  assert.equal(calls[2].url, `https://api.github.com/repos/${ISSUE_REPOSITORY}/issues/comments/${RUNNER_STARTED_COMMENT_ID}`);
});

test('the exact-read path never re-polls the issue comments list', async () => {
  const { pinnedFetch, calls } = pinnedExactReads({ authority: UNCLAIMED_AUTHORITY });
  assert.equal(await pinnedFetchFailure(pinnedFetch), 'pinned-child-preflight-not-found');
  assert.equal(listReads(calls).length, 1);
});

test('exact direct reads keep caller authentication and request cache revalidation', async () => {
  const { pinnedFetch, calls } = pinnedExactReads({
    authority: UNCLAIMED_AUTHORITY,
    exact: { [EXACT_PREFLIGHT_URL]: FRESH_PREFLIGHT },
  });
  await pinnedFetch(childCommentsUrl(), { headers: { authorization: 'token pinned' } });
  assert.equal(calls[0].init.headers.authorization, 'token pinned');
  assert.equal(calls[1].init.headers.get('authorization'), 'token pinned');
  assert.equal(calls[1].init.headers.get('cache-control'), 'no-cache');
  assert.equal(calls[1].init.headers.get('pragma'), 'no-cache');
  assert.equal(calls[1].init.cache, 'no-store');
});

test('an exact 404 immediately after publication is re-read within the bounded window', async () => {
  let reads = 0;
  const { pinnedFetch, calls, delays } = pinnedExactReads({
    authority: UNCLAIMED_AUTHORITY,
    exact: {
      [EXACT_PREFLIGHT_URL]: () => {
        reads += 1;
        return reads === 1 ? notFoundResponse() : jsonResponse(FRESH_PREFLIGHT);
      },
    },
  });
  const comments = await (await pinnedFetch(childCommentsUrl())).json();
  assert.equal(comments.some((comment) => comment.id === PREFLIGHT_COMMENT_ID), true);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [PINNED_EXACT_COMMENT_NOT_FOUND_RETRY_DELAYS_MS[0]]);
});

const exactReadTransportFailureCases = [
  ['an exhausted 404', notFoundResponse, {
    reads: PINNED_EXACT_COMMENT_READ_ATTEMPTS,
    delays: [...PINNED_EXACT_COMMENT_NOT_FOUND_RETRY_DELAYS_MS],
  }],
  ['a non-successful status', () => jsonResponse({ message: 'server error' }, 500, 'Internal Server Error'), { reads: 1, delays: [] }],
  ['malformed JSON', () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }), { reads: 1, delays: [] }],
  ['a JSON array payload', () => jsonResponse([FRESH_PREFLIGHT]), { reads: 1, delays: [] }],
  ['a transport exception', () => { throw new Error('socket hang up'); }, { reads: 1, delays: [] }],
];

for (const [name, handler, expected] of exactReadTransportFailureCases) {
  test(`${name} on an exact read fails closed`, async () => {
    const { pinnedFetch, calls, delays } = pinnedExactReads({
      authority: UNCLAIMED_AUTHORITY,
      exact: { [EXACT_PREFLIGHT_URL]: handler },
    });
    assert.equal(await pinnedFetchFailure(pinnedFetch), 'pinned-child-preflight-not-found');
    assert.equal(calls.length, 1 + expected.reads);
    assert.deepEqual(delays, expected.delays);
  });
}

// Endpoint success alone proves nothing: the returned comment still has to satisfy every
// existing identity, revision, fingerprint, body-digest and authority-marker check.
const exactPreflightRejectionCases = [
  ['a mismatched database identity', { ...FRESH_PREFLIGHT, id: PREFLIGHT_COMMENT_ID + 3 }],
  ['a missing database identity', { ...FRESH_PREFLIGHT, id: undefined }],
  ['an edited packet body', { ...FRESH_PREFLIGHT, body: `${FRESH_PREFLIGHT.body}\nExpanded scope after claim.` }],
  ['a tampered manager revision', { ...FRESH_PREFLIGHT, body: FRESH_PREFLIGHT.body.replace(REVISION, `${REVISION}.tampered`) }],
  ['a tampered packet fingerprint', { ...FRESH_PREFLIGHT, body: FRESH_PREFLIGHT.body.replace(FINGERPRINT, `sha256:${'e'.repeat(64)}`) }],
  ['a missing manager packet marker', { ...FRESH_PREFLIGHT, body: '## Claude continue command\n\nnot a manager packet' }],
];

for (const [name, comment] of exactPreflightRejectionCases) {
  test(`an exact preflight read with ${name} fails closed`, async () => {
    const { pinnedFetch, calls } = pinnedExactReads({
      authority: UNCLAIMED_AUTHORITY,
      exact: { [EXACT_PREFLIGHT_URL]: comment },
    });
    assert.equal(await pinnedFetchFailure(pinnedFetch), 'pinned-child-preflight-not-found');
    assert.equal(listReads(calls).length, 1);
  });
}

test('an exact runner-start read missing its authority marker fails closed', async () => {
  const { pinnedFetch } = pinnedExactReads({
    exact: {
      [EXACT_PREFLIGHT_URL]: FRESH_PREFLIGHT,
      [EXACT_RUNNER_STARTED_URL]: PARTIALLY_REPLICATED_RUNNER_STARTED,
    },
  });
  assert.equal(await pinnedFetchFailure(pinnedFetch), 'pinned-child-preflight-not-found');
});

test('an exact runner-start read for another comment identity fails closed', async () => {
  const { pinnedFetch } = pinnedExactReads({
    exact: {
      [EXACT_PREFLIGHT_URL]: FRESH_PREFLIGHT,
      [EXACT_RUNNER_STARTED_URL]: runnerStartedComment({ id: RUNNER_STARTED_COMMENT_ID + 7 }),
    },
  });
  assert.equal(await pinnedFetchFailure(pinnedFetch), 'pinned-child-preflight-not-found');
});

test('equivalent list and direct rows with the same id deduplicate safely', async () => {
  const { pinnedFetch, calls } = pinnedExactReads({
    list: UNCLAIMED_LIST,
    exact: { [EXACT_PREFLIGHT_URL]: FRESH_PREFLIGHT, [EXACT_RUNNER_STARTED_URL]: RUNNER_STARTED },
  });
  const comments = await (await pinnedFetch(childCommentsUrl())).json();
  assert.equal(comments.filter((comment) => comment.id === PREFLIGHT_COMMENT_ID).length, 1);
  assert.equal(comments.some((comment) => comment.id === RUNNER_STARTED_COMMENT_ID), false);
  assert.equal(calls.length, 3);
});

const conflictingDirectRowCases = [
  ['body', { ...FRESH_PREFLIGHT, body: `${FRESH_PREFLIGHT.body}\nExpanded scope after claim.` }],
  ['author', { ...FRESH_PREFLIGHT, user: { login: 'impostor' } }],
  ['creation time', { ...FRESH_PREFLIGHT, createdAt: '2026-07-25T13:19:30Z' }],
];

for (const [name, conflicting] of conflictingDirectRowCases) {
  test(`a direct row conflicting with the list row on ${name} fails closed`, async () => {
    const { pinnedFetch } = pinnedExactReads({
      list: UNCLAIMED_LIST,
      exact: { [EXACT_PREFLIGHT_URL]: conflicting, [EXACT_RUNNER_STARTED_URL]: RUNNER_STARTED },
    });
    assert.equal(await pinnedFetchFailure(pinnedFetch), 'pinned-child-preflight-not-current');
  });
}

test('distinct duplicate authority markers fail closed without any exact read', async () => {
  const list = [OLD_CONTINUE, FRESH_PREFLIGHT, RUNNER_STARTED, runnerStartedComment({ id: RUNNER_STARTED_COMMENT_ID + 1 })];
  const { pinnedFetch, calls, delays } = pinnedExactReads({ list });
  assert.equal(await pinnedFetchFailure(pinnedFetch), 'pinned-child-runner-start-duplicate');
  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
});

test('distinct duplicate authority markers surviving the merge still fail closed', async () => {
  const list = [OLD_CONTINUE, runnerStartedComment({ id: RUNNER_STARTED_COMMENT_ID + 1 })];
  const { pinnedFetch, calls } = pinnedExactReads({
    list,
    exact: { [EXACT_PREFLIGHT_URL]: FRESH_PREFLIGHT, [EXACT_RUNNER_STARTED_URL]: RUNNER_STARTED },
  });
  assert.equal(await pinnedFetchFailure(pinnedFetch), 'pinned-child-preflight-not-found');
  assert.equal(listReads(calls).length, 1);
});

// A foreign marker for this authority key makes this attempt's own runner-start comment
// absent from the list, so the exact reads run — and the merged payload then carries two
// distinct markers for one authority key, which fails closed exactly as before.
test('a foreign runner-start marker still fails closed after the exact reads', async () => {
  const { pinnedFetch, calls } = pinnedExactReads({
    list: [OLD_CONTINUE, FRESH_PREFLIGHT, runnerStartedComment({ id: RUNNER_STARTED_COMMENT_ID + 7 })],
    exact: { [EXACT_PREFLIGHT_URL]: FRESH_PREFLIGHT, [EXACT_RUNNER_STARTED_URL]: RUNNER_STARTED },
  });
  assert.equal(await pinnedFetchFailure(pinnedFetch), 'pinned-child-runner-start-mismatch');
  assert.equal(listReads(calls).length, 1);
});

const singlePassFailureCases = [
  ['duplicate runner-start markers', {
    comments: [OLD_CONTINUE, FRESH_PREFLIGHT, RUNNER_STARTED, runnerStartedComment({ id: RUNNER_STARTED_COMMENT_ID + 1 })],
    reason: 'pinned-child-runner-start-duplicate',
  }],
  ['changed packet content', {
    comments: [OLD_CONTINUE, { ...FRESH_PREFLIGHT, body: `${FRESH_PREFLIGHT.body}\nExpanded scope after claim.` }, RUNNER_STARTED],
    reason: 'pinned-child-preflight-not-current',
  }],
];

for (const [name, fixture] of singlePassFailureCases) {
  test(`${name} is never re-read and never triggers an exact read`, async () => {
    const { pinnedFetch, calls, delays } = pinnedExactReads({
      list: fixture.comments,
      exact: { [EXACT_PREFLIGHT_URL]: FRESH_PREFLIGHT, [EXACT_RUNNER_STARTED_URL]: RUNNER_STARTED },
    });
    assert.equal(await pinnedFetchFailure(pinnedFetch), fixture.reason);
    assert.equal(calls.length, 1);
    assert.deepEqual(delays, []);
  });
}

test('a non-successful comments response is never followed by an exact read', async () => {
  const failed = () => new Response('[]', { status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'application/json' } });
  const { pinnedFetch, calls, delays } = pinnedExactReads({
    list: failed,
    exact: { [EXACT_PREFLIGHT_URL]: FRESH_PREFLIGHT, [EXACT_RUNNER_STARTED_URL]: RUNNER_STARTED },
  });
  assert.equal(await pinnedFetchFailure(pinnedFetch), 'pinned-child-preflight-not-found');
  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
});

test('a malformed comments list fails closed without any exact read', async () => {
  const malformed = () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } });
  const { pinnedFetch, calls } = pinnedExactReads({
    list: malformed,
    exact: { [EXACT_PREFLIGHT_URL]: FRESH_PREFLIGHT, [EXACT_RUNNER_STARTED_URL]: RUNNER_STARTED },
  });
  assert.equal(await pinnedFetchFailure(pinnedFetch), 'pinned-child-comments-invalid');
  assert.equal(calls.length, 1);
});

test('requests outside the pinned comments endpoint remain single-pass and unchanged', async () => {
  const original = new Response('{"number":743}', { status: 200, headers: { 'content-type': 'application/json' } });
  const calls = [];
  const pinnedFetch = createPinnedFetch({
    authority: pinnedAuthorityFromEnv(env()),
    originalFetch: async (input) => { calls.push(String(input)); return original; },
    sleep: async () => { throw new Error('unexpected pinned retry delay'); },
  });
  const issueResponse = await pinnedFetch(`https://api.github.com/repos/${ISSUE_REPOSITORY}/issues/${ISSUE}`);
  assert.equal(issueResponse, original);
  const otherIssueResponse = await pinnedFetch(childCommentsUrl(ISSUE + 1));
  assert.equal(otherIssueResponse, original);
  const exactResponse = await pinnedFetch(EXACT_PREFLIGHT_URL);
  assert.equal(exactResponse, original);
  assert.equal(calls.length, 3);
});
