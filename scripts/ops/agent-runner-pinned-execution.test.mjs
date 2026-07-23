import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PINNED_CHILD_ENTRYPOINT,
  resolvePinnedExecutionAuthority,
  runChildWithPinnedAuthority,
} from './agent-runner-pinned-atomic-cron.mjs';
import {
  createPinnedFetch,
  pinManagerAuthorityComments,
  pinnedAuthorityFromEnv,
} from './agent-runner-pinned-child.mjs';
import {
  findLatestClaudeCommand,
  latestManagerPreflightComment,
} from './claude-runner-selection.mjs';
import { commentRevision } from './claude-runner-comment-identity.mjs';

const OLD_CONTINUE = {
  id: 5033672061,
  createdAt: '2026-07-20T10:00:00Z',
  user: { login: 'gpcola' },
  body: '## Claude continue command\n\nContinue the old attempt.',
};

const FRESH_PREFLIGHT = {
  id: 5058216754,
  createdAt: '2026-07-23T12:10:00Z',
  user: { login: 'gpcola' },
  body: '## Manager preflight packet — supervised acceptance\n\nPhase: implementation',
};

function stateFor(row) {
  return {
    invoke(name, attemptId) {
      assert.equal(name, 'recoveryAttempt');
      assert.equal(attemptId, row.attempt_id);
      return row;
    },
  };
}

test('resolves preflight-direct authority from the persisted scheduler attempt', () => {
  const row = {
    attempt_id: 'TheTekTeam/modelspend#686:attempt',
    issue_number: 686,
    claim_id: 'github-comment:database:5058216754',
    preflight_revision: 'github-comment:database:5058216754',
  };
  const authority = resolvePinnedExecutionAuthority({
    state: stateFor(row),
    attemptId: row.attempt_id,
  });
  assert.equal(authority.allowed, true);
  assert.equal(authority.selectionMode, 'preflight-direct');
  assert.equal(authority.preflightRevision, 'github-comment:database:5058216754');
  assert.equal(authority.claimRevision, 'github-comment:database:5058216754');
});

test('injects persisted authority and replaces only the child entrypoint', async () => {
  const row = {
    attempt_id: 'TheTekTeam/modelspend#686:attempt',
    issue_number: 686,
    claim_id: 'github-comment:database:5058216754',
    preflight_revision: 'github-comment:database:5058216754',
  };
  let observed = null;
  const result = await runChildWithPinnedAuthority({
    command: process.execPath,
    commandArgs: ['/runner/scripts/ops/claude-runner.mjs', '--issue', '686', '--execute'],
    options: { env: { SAFE: 'yes' } },
    state: stateFor(row),
    attemptId: row.attempt_id,
  }, {
    baseRunChild: async (input) => {
      observed = input;
      return { status: 0, signal: null, stdout: '{}', stderr: '', error: null };
    },
  });

  assert.equal(result.status, 0);
  assert.equal(observed.commandArgs[0], PINNED_CHILD_ENTRYPOINT);
  assert.deepEqual(observed.commandArgs.slice(1), ['--issue', '686', '--execute']);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_CHILD_ENTRYPOINT, '/runner/scripts/ops/claude-runner.mjs');
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_SELECTION_MODE, 'preflight-direct');
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_PREFLIGHT_REVISION, 'github-comment:database:5058216754');
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_CLAIM_REVISION, 'github-comment:database:5058216754');
  assert.equal(observed.options.env.SAFE, 'yes');
});

test('fails closed without a persisted preflight identity', async () => {
  const row = {
    attempt_id: 'TheTekTeam/modelspend#686:attempt',
    issue_number: 686,
    claim_id: null,
    preflight_revision: null,
  };
  let invoked = false;
  const result = await runChildWithPinnedAuthority({
    commandArgs: ['/runner/scripts/ops/claude-runner.mjs'],
    options: { env: {} },
    state: stateFor(row),
    attemptId: row.attempt_id,
  }, {
    baseRunChild: async () => {
      invoked = true;
      return {};
    },
  });

  assert.equal(invoked, false);
  assert.equal(result.status, 4);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureReason, 'pinned-authority-preflight-identity-missing');
});

test('preflight-direct pinning removes the old continue authority', () => {
  const authority = pinnedAuthorityFromEnv({
    AGENT_RUNNER_PINNED_ISSUE: '686',
    AGENT_RUNNER_PINNED_SELECTION_MODE: 'preflight-direct',
    AGENT_RUNNER_PINNED_PREFLIGHT_REVISION: 'github-comment:database:5058216754',
    AGENT_RUNNER_PINNED_CLAIM_REVISION: 'github-comment:database:5058216754',
  });
  const result = pinManagerAuthorityComments([OLD_CONTINUE, FRESH_PREFLIGHT], authority);

  assert.equal(result.allowed, true);
  assert.equal(findLatestClaudeCommand(result.comments), null);
  assert.equal(
    commentRevision(latestManagerPreflightComment(result.comments)),
    'github-comment:database:5058216754',
  );
  assert.match(result.comments[0].body, /Superseded Claude command/);
});

test('refuses a pinned preflight that is no longer current', () => {
  const authority = pinnedAuthorityFromEnv({
    AGENT_RUNNER_PINNED_ISSUE: '686',
    AGENT_RUNNER_PINNED_SELECTION_MODE: 'preflight-direct',
    AGENT_RUNNER_PINNED_PREFLIGHT_REVISION: 'github-comment:database:5058216754',
    AGENT_RUNNER_PINNED_CLAIM_REVISION: 'github-comment:database:5058216754',
  });
  const newer = {
    id: 5059000000,
    createdAt: '2026-07-23T13:00:00Z',
    user: { login: 'gpcola' },
    body: '## Manager preflight packet — replacement\n\nPhase: implementation',
  };
  const result = pinManagerAuthorityComments([FRESH_PREFLIGHT, newer], authority);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'pinned-child-preflight-not-current');
});

test('proceed-command pinning retains only the exact selected command', () => {
  const selectedProceed = {
    id: 5058200000,
    createdAt: '2026-07-23T12:09:00Z',
    user: { login: 'gpcola' },
    body: '## Claude proceed command\n\nProceed with the pinned task.',
  };
  const authority = pinnedAuthorityFromEnv({
    AGENT_RUNNER_PINNED_ISSUE: '686',
    AGENT_RUNNER_PINNED_SELECTION_MODE: 'proceed-command',
    AGENT_RUNNER_PINNED_PREFLIGHT_REVISION: 'github-comment:database:5058216754',
    AGENT_RUNNER_PINNED_CLAIM_REVISION: 'github-comment:database:5058200000',
  });
  const result = pinManagerAuthorityComments([OLD_CONTINUE, selectedProceed, FRESH_PREFLIGHT], authority);

  assert.equal(result.allowed, true);
  const command = findLatestClaudeCommand(result.comments);
  assert.equal(command.kind, 'proceed');
  assert.equal(command.sourceCommentRevision, 'github-comment:database:5058200000');
});

test('pinned fetch rewrites only the expected issue comments response', async () => {
  const authority = pinnedAuthorityFromEnv({
    AGENT_RUNNER_PINNED_ISSUE: '686',
    AGENT_RUNNER_PINNED_SELECTION_MODE: 'preflight-direct',
    AGENT_RUNNER_PINNED_PREFLIGHT_REVISION: 'github-comment:database:5058216754',
    AGENT_RUNNER_PINNED_CLAIM_REVISION: 'github-comment:database:5058216754',
  });
  const originalFetch = async () => new Response(JSON.stringify([OLD_CONTINUE, FRESH_PREFLIGHT]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const pinnedFetch = createPinnedFetch({ authority, originalFetch });

  const response = await pinnedFetch('https://api.github.com/repos/TheTekTeam/modelspend/issues/686/comments?per_page=100');
  const comments = await response.json();
  assert.equal(findLatestClaudeCommand(comments), null);
  assert.equal(commentRevision(latestManagerPreflightComment(comments)), 'github-comment:database:5058216754');
});
