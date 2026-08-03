import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  PINNED_CHILD_ENTRYPOINT,
  resolvePinnedExecutionAuthority,
  runChildWithPinnedAuthority,
} from './agent-runner-pinned-atomic-cron.mjs';
import {
  PINNED_COMMENT_ROLES,
  PINNED_DIAGNOSTIC_REASONS,
  PINNED_EXACT_COMMENT_NOT_FOUND_RETRY_DELAYS_MS,
  PINNED_EXACT_COMMENT_READ_ATTEMPTS,
  PINNED_EXACT_COMMENT_READ_WINDOW_MS,
  PINNED_PUBLIC_FAILURE_REASONS,
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
import { sameCommentIdentity } from './claude-runner-comment-identity.mjs';
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

// ---------------------------------------------------------------------------
// Issue #143 (PINNED.CONSISTENCY.4): the exact issue #136 packet .5 production
// boundary. Everything below reproduces the real child request shape — a string URL
// built by claude-runner's githubJson, its inherited Authorization/Accept headers,
// database-only authority identities whose nodeId is null, and realistic REST
// issue-comment payloads carrying both `id` and `node_id`.
// ---------------------------------------------------------------------------
const P5_REPOSITORY = 'TheTekTeam/agent-runner';
const P5_ISSUE = 136;
const P5_PREFLIGHT_COMMENT_ID = 5160984382;
const P5_RUNNER_STARTED_COMMENT_ID = 5167317080;
const P5_REVISION = 'AR136-PR-CONTRACT-IMPLEMENTATION-2026-08-03.5';
const P5_FINGERPRINT = 'sha256:b3b8a9af0e64ee9122ab1977e92524a64c7619338e50b2ff6f499a1f91fb2aed';
const P5_BASE = '38a38daa20d2dfbc5eb19c14170498f92971a068';
const P5_BRANCH = 'claude/pinned-production-diagnostics-143';
const P5_AGENT = 'claude-code-cli';
const P5_ATTEMPT_ID = `${P5_REPOSITORY}#${P5_ISSUE}:2026-08-03T13:59:22.801Z`;
const P5_AUTHORITY_KEY = `manager-preflight:${P5_REVISION}:${P5_FINGERPRINT}`;
// The manager packet body digest recorded in the production evidence. A digest binds to
// exact bytes and the production packet body itself is not reproducible here, so the
// fixture binds its own reconstructed body through packetBodyDigest and this recorded
// value is used to prove the digest comparison is live rather than assumed.
const P5_PRODUCTION_BODY_DIGEST = 'sha256:a35845a21fdc69f2561604e40cb321b1d573423c93ecb0147afae389919a610c';

const P5_PREFLIGHT_BODY = `<!-- agent-runner:manager-preflight -->

\`\`\`yaml
schema_version: agent-runner-manager-preflight/v1
revision: ${P5_REVISION}
fingerprint: ${P5_FINGERPRINT}
producer_type: normal_chatgpt_manager_session
approved_agent: ${P5_AGENT}
execution_phase: implementation
approved_repository_scope:
  - ${P5_REPOSITORY}
approved_branch: ${P5_BRANCH}
base_commit: ${P5_BASE}
scope:
  - one bounded internal pinned-authority diagnostic reason
required_validation:
  - node --test scripts/ops/agent-runner-pinned-execution.test.mjs
stop_conditions:
  - fail closed before worktree/model launch
\`\`\``;
const P5_BODY_DIGEST = packetBodyDigest(P5_PREFLIGHT_BODY);

// The REST shape the child actually receives: numeric `id`, GraphQL `node_id`,
// snake_case timestamps, an API `url` and an `html_url` carrying `#issuecomment-<id>`.
function restIssueComment({ id, body, createdAt, login = 'gpcola' }) {
  return {
    url: `https://api.github.com/repos/${P5_REPOSITORY}/issues/comments/${id}`,
    html_url: `https://github.com/${P5_REPOSITORY}/issues/${P5_ISSUE}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/${P5_REPOSITORY}/issues/${P5_ISSUE}`,
    id,
    node_id: `IC_kwDOPinned${id}`,
    user: { login, id: 424242, node_id: 'U_kgDOPinnedAuthor', type: 'User' },
    created_at: createdAt,
    updated_at: createdAt,
    author_association: 'OWNER',
    body,
  };
}

const P5_PREFLIGHT = restIssueComment({
  id: P5_PREFLIGHT_COMMENT_ID,
  createdAt: '2026-08-03T13:57:41Z',
  body: P5_PREFLIGHT_BODY,
});

function p5RunnerStartedComment(overrides = {}) {
  const { id = P5_RUNNER_STARTED_COMMENT_ID, bodyDigest = P5_BODY_DIGEST, authorityKey = P5_AUTHORITY_KEY } = overrides;
  return restIssueComment({
    id,
    createdAt: '2026-08-03T13:59:23Z',
    login: 'gpcola',
    body: `## Claude runner started

- Runner action: claim-ready-issue
- Selection mode: preflight-direct
- Source preflight comment: github-comment:database:${P5_PREFLIGHT_COMMENT_ID}
- Manager packet revision: ${P5_REVISION}
- Manager packet fingerprint: ${P5_FINGERPRINT}
- Manager packet authority: ${authorityKey}
- Manager packet body digest: ${bodyDigest}
- Started at: 2026-08-03T13:59:23Z
- Output directory: /home/gp/.local/state/agent-runner/agent-runner

This marker records consumption of exactly this immutable manager packet revision and fingerprint.`,
  });
}

const P5_RUNNER_STARTED = p5RunnerStartedComment();
const P5_OLD_COMMAND = restIssueComment({
  id: 5033672061,
  createdAt: '2026-08-01T09:00:00Z',
  body: '## Claude continue command\n\nContinue the old attempt.',
});
// The replica the child actually read: the pinned packet .5 comments are not in it.
const P5_STALE_LIST = [P5_OLD_COMMAND];

function p5Env(overrides = {}) {
  return {
    AGENT_RUNNER_PINNED_ISSUE: String(P5_ISSUE),
    AGENT_RUNNER_PINNED_ISSUE_REPOSITORY: P5_REPOSITORY,
    AGENT_RUNNER_PINNED_SELECTION_MODE: 'preflight-direct',
    AGENT_RUNNER_PINNED_CLAIM_MODE: 'claimed',
    AGENT_RUNNER_PINNED_PREFLIGHT_COMMENT_REVISION: `github-comment:database:${P5_PREFLIGHT_COMMENT_ID}`,
    AGENT_RUNNER_PINNED_RUNNER_STARTED_COMMENT_REVISION: `github-comment:database:${P5_RUNNER_STARTED_COMMENT_ID}`,
    AGENT_RUNNER_PINNED_MANAGER_REVISION: P5_REVISION,
    AGENT_RUNNER_PINNED_MANAGER_FINGERPRINT: P5_FINGERPRINT,
    AGENT_RUNNER_PINNED_MANAGER_BODY_DIGEST: P5_BODY_DIGEST,
    AGENT_RUNNER_PINNED_MANAGER_AUTHORITY_KEY: P5_AUTHORITY_KEY,
    AGENT_RUNNER_PINNED_APPROVED_REPOSITORY: P5_REPOSITORY,
    AGENT_RUNNER_PINNED_APPROVED_BRANCH: P5_BRANCH,
    AGENT_RUNNER_PINNED_APPROVED_BASE_COMMIT: P5_BASE,
    AGENT_RUNNER_PINNED_APPROVED_AGENT: P5_AGENT,
    AGENT_RUNNER_PINNED_ATTEMPT_ID: P5_ATTEMPT_ID,
    ...overrides,
  };
}

const P5_AUTHORITY = pinnedAuthorityFromEnv(p5Env());

// Exactly the headers claude-runner's githubJson attaches to the comments-list request.
const P5_REQUEST_HEADERS = Object.freeze({
  Accept: 'application/vnd.github+json',
  Authorization: 'Bearer ghs_pinned_child_token',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'modelspend-claude-runner',
});

function p5ExactUrl(id, { origin = 'https://api.github.com', prefix = '' } = {}) {
  return `${origin}${prefix}/repos/${P5_REPOSITORY}/issues/comments/${id}`;
}

function urlOf(input) {
  return typeof input === 'string' ? input : String(input?.url || input);
}

/**
 * Drives createPinnedFetch exactly as production does. `requestAs: 'request'` sends the
 * same URL as a Request object with the same inherited headers; `origin`/`prefix` cover
 * api.github.com and a GitHub Enterprise `/api/v3` API prefix; `listUrl` overrides the
 * request the child issues without changing the pinned authority projection.
 */
function productionBoundary({
  authority = P5_AUTHORITY,
  origin = 'https://api.github.com',
  prefix = '',
  listUrl = null,
  list = P5_STALE_LIST,
  exact = {},
  requestAs = 'string',
} = {}) {
  const requestUrl = listUrl || `${origin}${prefix}/repos/${P5_REPOSITORY}/issues/${P5_ISSUE}/comments?per_page=100`;
  const calls = [];
  const delays = [];
  const diagnostics = [];
  const pinnedFetch = createPinnedFetch({
    authority,
    originalFetch: async (input, init) => {
      const url = urlOf(input);
      calls.push({ url, init });
      if (url.includes(`/issues/${P5_ISSUE}/comments?`)) {
        return typeof list === 'function' ? list() : jsonResponse(list);
      }
      const handler = exact[url];
      if (handler === undefined) return notFoundResponse();
      return typeof handler === 'function' ? handler() : jsonResponse(handler);
    },
    onDiagnostic: (value) => { diagnostics.push(value); },
    sleep: async (ms) => { delays.push(ms); },
  });
  const input = requestAs === 'request'
    ? new Request(requestUrl, { headers: { ...P5_REQUEST_HEADERS } })
    : requestUrl;
  const init = requestAs === 'request' ? undefined : { headers: { ...P5_REQUEST_HEADERS } };
  return {
    calls,
    delays,
    diagnostics,
    requestUrl,
    run: () => pinnedFetch(input, init),
  };
}

async function p5Failure(boundary) {
  try {
    await boundary.run();
  } catch (error) {
    return { message: String(error?.message || error), diagnostic: error?.pinnedDiagnostic || null };
  }
  return { message: null, diagnostic: null };
}

function p5ExactReads({ origin = 'https://api.github.com', prefix = '', preflight = P5_PREFLIGHT, runnerStarted = P5_RUNNER_STARTED } = {}) {
  return {
    [p5ExactUrl(P5_PREFLIGHT_COMMENT_ID, { origin, prefix })]: preflight,
    [p5ExactUrl(P5_RUNNER_STARTED_COMMENT_ID, { origin, prefix })]: runnerStarted,
  };
}

test('the packet .5 production fixture carries the exact recorded production identities', () => {
  assert.equal(P5_AUTHORITY.allowed, true);
  assert.equal(P5_AUTHORITY.claimMode, 'claimed');
  assert.equal(P5_AUTHORITY.issueRepository, P5_REPOSITORY);
  assert.equal(P5_AUTHORITY.issueNumber, P5_ISSUE);
  assert.equal(P5_AUTHORITY.managerPreflightRevision, P5_REVISION);
  assert.equal(P5_AUTHORITY.managerPreflightFingerprint, P5_FINGERPRINT);
  assert.equal(P5_AUTHORITY.managerAuthorityKey, P5_AUTHORITY_KEY);
  assert.equal(P5_AUTHORITY.approvedBranch, P5_BRANCH);
  assert.equal(P5_AUTHORITY.approvedBaseCommit, P5_BASE);
  assert.equal(P5_AUTHORITY.attemptId, P5_ATTEMPT_ID);
  assert.equal(P5_AUTHORITY.preflightIdentity.databaseId, P5_PREFLIGHT_COMMENT_ID);
  assert.equal(P5_AUTHORITY.runnerStartedIdentity.databaseId, P5_RUNNER_STARTED_COMMENT_ID);
});

test('the packet .5 production fixture authorizes claimed mode from the exact reads', async () => {
  const boundary = productionBoundary({ exact: p5ExactReads() });
  const comments = await (await boundary.run()).json();
  assert.equal(comments.some((comment) => comment.id === P5_PREFLIGHT_COMMENT_ID), true);
  assert.equal(comments.some((comment) => comment.id === P5_RUNNER_STARTED_COMMENT_ID), false);
  const inherited = resolveCurrentManagerAuthority(comments);
  assert.equal(inherited.allowed, true);
  assert.equal(inherited.authority.authorityKey, P5_AUTHORITY_KEY);
  assert.equal(inherited.authority.packetDigest, P5_BODY_DIGEST);
  assert.equal(inherited.authority.approvedAgent, P5_AGENT);
  assert.deepEqual(boundary.diagnostics, []);
  assert.deepEqual(boundary.delays, []);
});

// The recorded production digest belongs to bytes this fixture cannot reproduce, so it
// must not authorize this reconstructed body. The refusal proves the body-digest
// comparison is live rather than assumed by the fixture.
test('the recorded production body digest does not authorize a different packet body', async () => {
  const authority = pinnedAuthorityFromEnv(p5Env({ AGENT_RUNNER_PINNED_MANAGER_BODY_DIGEST: P5_PRODUCTION_BODY_DIGEST }));
  assert.equal(authority.allowed, true);
  assert.notEqual(P5_PRODUCTION_BODY_DIGEST, P5_BODY_DIGEST);
  const failure = await p5Failure(productionBoundary({ authority, exact: p5ExactReads() }));
  assert.equal(failure.message, 'pinned-child-preflight-not-found');
  assert.equal(failure.diagnostic.reason, 'post-merge-authority-rejected');
});

test('a database-only authority identity matches a REST comment carrying id and node_id', () => {
  assert.deepEqual({ ...P5_AUTHORITY.preflightIdentity }, { version: 1, nodeId: null, databaseId: P5_PREFLIGHT_COMMENT_ID });
  assert.deepEqual({ ...P5_AUTHORITY.runnerStartedIdentity }, { version: 1, nodeId: null, databaseId: P5_RUNNER_STARTED_COMMENT_ID });
  assert.match(P5_PREFLIGHT.node_id, /^IC_[A-Za-z0-9_-]+$/);
  assert.equal(typeof P5_PREFLIGHT.id, 'number');
  assert.equal(sameCommentIdentity(P5_PREFLIGHT, P5_AUTHORITY.preflightIdentity), true);
  assert.equal(sameCommentIdentity(P5_RUNNER_STARTED, P5_AUTHORITY.runnerStartedIdentity), true);
  assert.equal(sameCommentIdentity(P5_PREFLIGHT, P5_AUTHORITY.runnerStartedIdentity), false);
  const pinned = pinManagerAuthorityComments([P5_OLD_COMMAND, P5_PREFLIGHT, P5_RUNNER_STARTED], P5_AUTHORITY);
  assert.equal(pinned.allowed, true);
});

const p5RequestInputCases = ['string', 'request'];

for (const requestAs of p5RequestInputCases) {
  test(`a ${requestAs} comments-list input derives the exact expected direct URLs`, async () => {
    const boundary = productionBoundary({ requestAs, exact: p5ExactReads() });
    await boundary.run();
    assert.equal(boundary.calls.length, 3);
    assert.equal(boundary.calls[1].url, `https://api.github.com/repos/${P5_REPOSITORY}/issues/comments/${P5_PREFLIGHT_COMMENT_ID}`);
    assert.equal(boundary.calls[2].url, `https://api.github.com/repos/${P5_REPOSITORY}/issues/comments/${P5_RUNNER_STARTED_COMMENT_ID}`);
    assert.equal(boundary.calls[1].url.includes('?'), false);
  });

  test(`a ${requestAs} comments-list input keeps its Authorization and Accept headers on the direct reads`, async () => {
    const boundary = productionBoundary({ requestAs, exact: p5ExactReads() });
    await boundary.run();
    for (const call of boundary.calls.slice(1)) {
      assert.equal(call.init.headers.get('authorization'), P5_REQUEST_HEADERS.Authorization);
      assert.equal(call.init.headers.get('accept'), P5_REQUEST_HEADERS.Accept);
      assert.equal(call.init.headers.get('x-github-api-version'), P5_REQUEST_HEADERS['X-GitHub-Api-Version']);
      assert.equal(call.init.headers.get('cache-control'), 'no-cache');
      assert.equal(call.init.cache, 'no-store');
    }
  });

  test(`a ${requestAs} GitHub Enterprise comments-list input keeps its API path prefix`, async () => {
    const origin = 'https://github.enterprise.example';
    const prefix = '/api/v3';
    const boundary = productionBoundary({
      requestAs,
      origin,
      prefix,
      exact: p5ExactReads({ origin, prefix }),
    });
    const comments = await (await boundary.run()).json();
    assert.equal(comments.some((comment) => comment.id === P5_PREFLIGHT_COMMENT_ID), true);
    assert.equal(boundary.calls[1].url, `${origin}${prefix}/repos/${P5_REPOSITORY}/issues/comments/${P5_PREFLIGHT_COMMENT_ID}`);
    assert.equal(boundary.calls[2].url, `${origin}${prefix}/repos/${P5_REPOSITORY}/issues/comments/${P5_RUNNER_STARTED_COMMENT_ID}`);
  });
}

// Every bounded stage, each reached by the one condition that produces it. The public
// reason is whatever the list already proved and never changes; only the diagnostic
// distinguishes the stage.
const p5DiagnosticStages = [
  ['exact-url-invalid', {
    // The production defect this issue repairs: the child's comments-list request named a
    // repository other than the pinned one, so no direct URL can be derived at all.
    listUrl: `https://api.github.com/repos/TheTekTeam/modelspend/issues/${P5_ISSUE}/comments?per_page=100`,
    exact: p5ExactReads(),
    publicReason: 'pinned-child-preflight-not-found',
    commentRole: 'manager-preflight',
    httpStatus: null,
    commentDatabaseId: P5_PREFLIGHT_COMMENT_ID,
    delays: [],
  }],
  ['direct-preflight-404', {
    exact: {},
    publicReason: 'pinned-child-preflight-not-found',
    commentRole: 'manager-preflight',
    httpStatus: 404,
    commentDatabaseId: P5_PREFLIGHT_COMMENT_ID,
    delays: [...PINNED_EXACT_COMMENT_NOT_FOUND_RETRY_DELAYS_MS],
  }],
  ['direct-preflight-non-success', {
    exact: { [p5ExactUrl(P5_PREFLIGHT_COMMENT_ID)]: () => jsonResponse({ message: 'server error' }, 503, 'Service Unavailable') },
    publicReason: 'pinned-child-preflight-not-found',
    commentRole: 'manager-preflight',
    httpStatus: 503,
    commentDatabaseId: P5_PREFLIGHT_COMMENT_ID,
    delays: [],
  }],
  ['direct-preflight-malformed', {
    exact: { [p5ExactUrl(P5_PREFLIGHT_COMMENT_ID)]: () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }) },
    publicReason: 'pinned-child-preflight-not-found',
    commentRole: 'manager-preflight',
    httpStatus: 200,
    commentDatabaseId: P5_PREFLIGHT_COMMENT_ID,
    delays: [],
  }],
  ['direct-preflight-identity-mismatch', {
    exact: { [p5ExactUrl(P5_PREFLIGHT_COMMENT_ID)]: restIssueComment({ id: P5_PREFLIGHT_COMMENT_ID + 3, createdAt: '2026-08-03T13:57:41Z', body: P5_PREFLIGHT_BODY }) },
    publicReason: 'pinned-child-preflight-not-found',
    commentRole: 'manager-preflight',
    httpStatus: 200,
    commentDatabaseId: P5_PREFLIGHT_COMMENT_ID,
    delays: [],
  }],
  ['direct-runner-start-404', {
    exact: { [p5ExactUrl(P5_PREFLIGHT_COMMENT_ID)]: P5_PREFLIGHT },
    publicReason: 'pinned-child-preflight-not-found',
    commentRole: 'runner-start',
    httpStatus: 404,
    commentDatabaseId: P5_RUNNER_STARTED_COMMENT_ID,
    delays: [...PINNED_EXACT_COMMENT_NOT_FOUND_RETRY_DELAYS_MS],
  }],
  ['direct-runner-start-non-success', {
    exact: {
      [p5ExactUrl(P5_PREFLIGHT_COMMENT_ID)]: P5_PREFLIGHT,
      [p5ExactUrl(P5_RUNNER_STARTED_COMMENT_ID)]: () => jsonResponse({ message: 'server error' }, 500, 'Internal Server Error'),
    },
    publicReason: 'pinned-child-preflight-not-found',
    commentRole: 'runner-start',
    httpStatus: 500,
    commentDatabaseId: P5_RUNNER_STARTED_COMMENT_ID,
    delays: [],
  }],
  ['direct-runner-start-malformed', {
    exact: {
      [p5ExactUrl(P5_PREFLIGHT_COMMENT_ID)]: P5_PREFLIGHT,
      [p5ExactUrl(P5_RUNNER_STARTED_COMMENT_ID)]: () => jsonResponse([P5_RUNNER_STARTED]),
    },
    publicReason: 'pinned-child-preflight-not-found',
    commentRole: 'runner-start',
    httpStatus: 200,
    commentDatabaseId: P5_RUNNER_STARTED_COMMENT_ID,
    delays: [],
  }],
  ['direct-runner-start-identity-mismatch', {
    exact: {
      [p5ExactUrl(P5_PREFLIGHT_COMMENT_ID)]: P5_PREFLIGHT,
      [p5ExactUrl(P5_RUNNER_STARTED_COMMENT_ID)]: p5RunnerStartedComment({ id: P5_RUNNER_STARTED_COMMENT_ID + 7 }),
    },
    publicReason: 'pinned-child-preflight-not-found',
    commentRole: 'runner-start',
    httpStatus: 200,
    commentDatabaseId: P5_RUNNER_STARTED_COMMENT_ID,
    delays: [],
  }],
  ['exact-comment-merge-conflict', {
    // The list already holds this exact database identity with different immutable
    // content, so the direct row may not collapse into it.
    list: [P5_OLD_COMMAND, { ...P5_PREFLIGHT, body: `${P5_PREFLIGHT_BODY}\nExpanded scope after claim.` }],
    exact: p5ExactReads(),
    publicReason: 'pinned-child-preflight-not-current',
    commentRole: 'manager-preflight',
    httpStatus: null,
    commentDatabaseId: P5_PREFLIGHT_COMMENT_ID,
    delays: [],
  }],
  ['post-merge-authority-rejected', {
    // Both direct reads succeed, and the merged payload then carries two distinct claim
    // markers for one immutable authority key.
    list: [P5_OLD_COMMAND, p5RunnerStartedComment({ id: P5_RUNNER_STARTED_COMMENT_ID + 11 })],
    exact: p5ExactReads(),
    publicReason: 'pinned-child-preflight-not-found',
    commentRole: null,
    httpStatus: null,
    commentDatabaseId: null,
    delays: [],
  }],
];

for (const [reason, fixture] of p5DiagnosticStages) {
  test(`the ${reason} stage fails closed with only its bounded diagnostic`, async () => {
    const boundary = productionBoundary({
      listUrl: fixture.listUrl || null,
      list: fixture.list || P5_STALE_LIST,
      exact: fixture.exact,
    });
    const failure = await p5Failure(boundary);
    assert.equal(failure.message, fixture.publicReason);
    assert.deepEqual(boundary.delays, fixture.delays);
    assert.deepEqual(boundary.diagnostics.length, 1);
    assert.deepEqual({ ...failure.diagnostic }, {
      reason,
      commentRole: fixture.commentRole,
      httpStatus: fixture.httpStatus,
      commentDatabaseId: fixture.commentDatabaseId,
      attemptId: P5_ATTEMPT_ID,
    });
    assert.equal(Object.isFrozen(failure.diagnostic), true);
  });
}

test('every required bounded diagnostic reason is covered and the vocabulary is closed', () => {
  assert.deepEqual([...PINNED_DIAGNOSTIC_REASONS].sort(), [...new Set(PINNED_DIAGNOSTIC_REASONS)].sort());
  assert.equal(Object.isFrozen(PINNED_DIAGNOSTIC_REASONS), true);
  assert.equal(Object.isFrozen(PINNED_COMMENT_ROLES), true);
  assert.deepEqual([...PINNED_COMMENT_ROLES], ['manager-preflight', 'runner-start']);
  assert.deepEqual(p5DiagnosticStages.map(([reason]) => reason).sort(), [...PINNED_DIAGNOSTIC_REASONS].sort());
});

test('an exact read never reports a stage diagnostic when the pinned attempt is authorized', async () => {
  const boundary = productionBoundary({ exact: p5ExactReads() });
  await boundary.run();
  assert.deepEqual(boundary.diagnostics, []);
});

// A response body, an Authorization header, a token, a query-bearing URL, a prompt and a
// raw exception message are all present in this boundary; none of them may appear in the
// refusal the child publishes.
const P5_FORBIDDEN_SUBSTRINGS = [
  'ghs_pinned_child_token',
  'Bearer',
  'authorization',
  'per_page',
  'documentation_url',
  'socket hang up',
  'Not Found',
  'https://',
];

test('a bounded diagnostic never carries a body, credential, URL or exception text', async () => {
  const boundary = productionBoundary({
    exact: {
      [p5ExactUrl(P5_PREFLIGHT_COMMENT_ID)]: () => { throw new Error('socket hang up to https://api.github.com'); },
    },
  });
  const failure = await p5Failure(boundary);
  assert.equal(failure.message, 'pinned-child-preflight-not-found');
  assert.deepEqual(Object.keys(failure.diagnostic).sort(), ['attemptId', 'commentDatabaseId', 'commentRole', 'httpStatus', 'reason']);
  assert.equal(failure.diagnostic.reason, 'direct-preflight-non-success');
  assert.equal(failure.diagnostic.httpStatus, null);
  const serialized = JSON.stringify(failure.diagnostic);
  for (const forbidden of P5_FORBIDDEN_SUBSTRINGS) {
    assert.equal(serialized.includes(forbidden), false, `diagnostic leaked ${forbidden}`);
  }
});

async function capturedPinnedChild({ childEnv, childMain, originalFetch = async () => jsonResponse([]) }) {
  const previousLog = console.log;
  const lines = [];
  console.log = (...values) => { lines.push(values.map(String).join(' ')); };
  try {
    const exitCode = await pinnedChildMain(
      ['--issue', String(P5_ISSUE), '--execute', '--attempt-id', P5_ATTEMPT_ID],
      childEnv,
      { originalFetch, childMain },
    );
    return { exitCode, output: lines.join('\n') };
  } finally {
    console.log = previousLog;
  }
}

// The child's own entrypoint compiles in the bounded 404 ladder, so this end-to-end case
// uses a non-404 direct failure: it reaches the identical publication path without any
// test ever sleeping.
test('the published refusal keeps the public reason and adds only the bounded diagnostic', async () => {
  const { exitCode, output } = await capturedPinnedChild({
    childEnv: p5Env(),
    originalFetch: async (input) => (urlOf(input).includes(`/issues/${P5_ISSUE}/comments?`)
      ? jsonResponse(P5_STALE_LIST)
      : jsonResponse({ message: 'server error' }, 503, 'Service Unavailable')),
    childMain: async () => {
      await globalThis.fetch(`https://api.github.com/repos/${P5_REPOSITORY}/issues/${P5_ISSUE}/comments?per_page=100`, {
        headers: { ...P5_REQUEST_HEADERS },
      });
      return 0;
    },
  });
  assert.equal(exitCode, 4);
  const payload = JSON.parse(output);
  assert.equal(payload.blocked, true);
  assert.equal(payload.reason, 'pinned-child-preflight-not-found');
  assert.equal(payload.failureReason, 'pinned-child-preflight-not-found');
  assert.equal(payload.pinnedExecutionAuthority.allowed, false);
  assert.equal(payload.pinnedAuthorityDiagnostic.reason, 'direct-preflight-non-success');
  assert.equal(payload.pinnedAuthorityDiagnostic.commentRole, 'manager-preflight');
  assert.equal(payload.pinnedAuthorityDiagnostic.httpStatus, 503);
  assert.equal(payload.pinnedAuthorityDiagnostic.commentDatabaseId, P5_PREFLIGHT_COMMENT_ID);
  assert.equal(payload.pinnedAuthorityDiagnostic.attemptId, P5_ATTEMPT_ID);
  for (const forbidden of ['server error', 'ghs_pinned_child_token', 'per_page']) {
    assert.equal(output.includes(forbidden), false, `published refusal leaked ${forbidden}`);
  }
});

// GitHub transport errors raised inside the child embed a slice of the response body, so
// the published refusal may never repeat an exception message verbatim.
test('a raw child exception message is never published by the pinned child', async () => {
  const leaked = 'GitHub request failed 404 Not Found: {"message":"Not Found","documentation_url":"https://docs.github.com/rest"}';
  const { exitCode, output } = await capturedPinnedChild({
    childEnv: p5Env(),
    childMain: async () => { throw new Error(leaked); },
  });
  assert.equal(exitCode, 4);
  const payload = JSON.parse(output);
  assert.equal(payload.reason, 'pinned-child-authority-failed');
  assert.equal(payload.failureReason, 'pinned-child-authority-failed');
  assert.equal(payload.pinnedAuthorityDiagnostic, null);
  assert.equal(output.includes('documentation_url'), false);
  assert.equal(output.includes('GitHub request failed'), false);
});

test('the published failure reason vocabulary is a closed allowlist of this module', () => {
  assert.equal(Object.isFrozen(PINNED_PUBLIC_FAILURE_REASONS), true);
  assert.deepEqual([...PINNED_PUBLIC_FAILURE_REASONS].sort(), [...new Set(PINNED_PUBLIC_FAILURE_REASONS)].sort());
  const source = readFileSync(new URL('./agent-runner-pinned-child.mjs', import.meta.url), 'utf8');
  // Identity-normalisation contexts share the prefix but are never published reasons.
  const identityContexts = new Set(['pinned-child-preflight', 'pinned-child-runner-start', 'pinned-child-exact-comment']);
  const literals = new Set([...source.matchAll(/'(pinned-child-[a-z0-9-]+)'/g)].map((match) => match[1]));
  for (const literal of literals) {
    if (identityContexts.has(literal)) continue;
    assert.equal(
      PINNED_PUBLIC_FAILURE_REASONS.includes(literal) || literal === 'pinned-child-comments-authorized' || literal === 'pinned-child-authority-valid' || literal === 'pinned-child-authority-applied',
      true,
      `${literal} is not in the published failure reason allowlist`,
    );
  }
});

test('the scheduler pins the child GitHub request repository to the pinned issue repository', async () => {
  const { observed } = await schedulerDispatch();
  assert.equal(observed.options.env.GITHUB_REPOSITORY, ISSUE_REPOSITORY);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_ISSUE_REPOSITORY, ISSUE_REPOSITORY);
});
