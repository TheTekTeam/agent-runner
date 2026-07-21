import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildWorktreeIdentity } from './claude-runner-execution-policy.mjs';
import {
  claimRevisionIsCurrent,
  runnerAttentionCommentBody,
  upsertGitHubAttentionComment,
} from './claude-runner-cron.mjs';
import {
  commentRevision,
  deserializeCommentIdentity,
  normalizeCommentIdentity,
  sameCommentIdentity,
} from './claude-runner-comment-identity.mjs';
import { commentId } from './claude-runner-selection.mjs';
import { openRunnerStateStore } from './claude-runner-state.mjs';

const PREFLIGHT_NODE_ID = 'IC_kwDOSAKVps8AAAABKwq7Lg';
const PREFLIGHT_DATABASE_ID = 5017090862;
const ATTENTION_NODE_ID = 'IC_kwDOSAKVps8AAAABKwpaBQ';
const ATTENTION_DATABASE_ID = 5017065989;

const managerBody = '## Manager preflight packet\n\nPhase: implementation';

test('typed boundary preserves GraphQL node and REST database identifiers without ambiguity', () => {
  const graphql = normalizeCommentIdentity({ id: PREFLIGHT_NODE_ID, databaseId: PREFLIGHT_DATABASE_ID });
  const rest = normalizeCommentIdentity({ id: PREFLIGHT_DATABASE_ID, node_id: PREFLIGHT_NODE_ID });
  assert.deepEqual(graphql, { version: 1, nodeId: PREFLIGHT_NODE_ID, databaseId: PREFLIGHT_DATABASE_ID });
  assert.deepEqual(rest, graphql);
  assert.equal(sameCommentIdentity(graphql, rest), true);
  assert.equal(commentRevision(graphql), `github-comment:database:${PREFLIGHT_DATABASE_ID}`);
  assert.throws(
    () => normalizeCommentIdentity({ id: PREFLIGHT_DATABASE_ID, databaseId: PREFLIGHT_DATABASE_ID + 1 }),
    /Conflicting GitHub comment identity evidence/,
  );
});

test('captured #300 GraphQL scheduler and REST child shapes are one deterministic manager revision', () => {
  const schedulerComment = {
    id: PREFLIGHT_NODE_ID,
    databaseId: PREFLIGHT_DATABASE_ID,
    body: managerBody,
    createdAt: '2026-07-19T19:00:00Z',
  };
  const childComment = {
    id: PREFLIGHT_DATABASE_ID,
    node_id: PREFLIGHT_NODE_ID,
    body: managerBody,
    created_at: '2026-07-19T19:00:00Z',
  };

  const schedulerRevision = commentId(schedulerComment);
  const childRevision = commentId(childComment);
  assert.equal(schedulerRevision, childRevision);
  assert.equal(claimRevisionIsCurrent([schedulerComment], childRevision), true);
  assert.deepEqual(
    buildWorktreeIdentity({ issueNumber: 300, sourceCommentId: schedulerRevision }),
    buildWorktreeIdentity({ issueNumber: 300, sourceCommentId: childRevision }),
  );
});

test('captured #300 attention update uses only the numeric REST database id', () => {
  const calls = [];
  const ghRunner = (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'view') {
      return JSON.stringify({ comments: [{
        id: ATTENTION_NODE_ID,
        databaseId: ATTENTION_DATABASE_ID,
        body: '<!-- agent-runner:attention:v1 -->\n\nold',
        createdAt: '2026-07-19T19:01:00Z',
      }] });
    }
    return '';
  };

  const result = upsertGitHubAttentionComment(
    { repo: 'TheTekTeam/modelspend' },
    { number: 300 },
    { reason: 'provider_execution_limit', detectedAt: '2026-07-19T19:02:00Z' },
    ghRunner,
  );

  assert.equal(result.updated, true);
  const patchCall = calls.find((call) => call[0] === 'api' && call[2] === 'PATCH');
  assert.ok(patchCall);
  assert.equal(patchCall[3], `repos/TheTekTeam/modelspend/issues/comments/${ATTENTION_DATABASE_ID}`);
  assert.equal(calls.some((call) => call.join(' ').includes(ATTENTION_NODE_ID)), false);
});

test('attention update without a numeric REST identity fails closed and never claims delivery', () => {
  const calls = [];
  const ghRunner = (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'view') {
      return JSON.stringify({ comments: [{
        id: ATTENTION_NODE_ID,
        body: '<!-- agent-runner:attention:v1 -->\n\nold',
        createdAt: '2026-07-19T19:01:00Z',
      }] });
    }
    return '';
  };

  assert.throws(
    () => upsertGitHubAttentionComment(
      { repo: 'TheTekTeam/modelspend' },
      { number: 300 },
      { reason: 'provider_execution_limit', detectedAt: '2026-07-19T19:02:00Z' },
      ghRunner,
    ),
    /numeric REST database id/i,
  );
  assert.equal(calls.some((call) => call[0] === 'api' && call[2] === 'PATCH'), false);
});

test('repeated identical attention remains deduplicated without requiring a mutation identity', () => {
  const issue = { number: 300 };
  const failure = { reason: 'provider_execution_limit', detectedAt: '2026-07-19T19:02:00Z' };
  const body = runnerAttentionCommentBody(issue, failure);
  const calls = [];
  const ghRunner = (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'view') {
      return JSON.stringify({ comments: [{ id: ATTENTION_NODE_ID, body, createdAt: '2026-07-19T19:01:00Z' }] });
    }
    throw new Error('deduplicated attention must not mutate GitHub');
  };

  assert.equal(upsertGitHubAttentionComment({ repo: 'TheTekTeam/modelspend' }, issue, failure, ghRunner).deduplicated, true);
  assert.equal(upsertGitHubAttentionComment({ repo: 'TheTekTeam/modelspend' }, issue, failure, ghRunner).deduplicated, true);
  assert.equal(calls.filter((call) => call[0] === 'issue' && call[1] === 'view').length, 2);
  assert.equal(calls.some((call) => call[0] === 'api' || call[1] === 'comment'), false);
});

test('restart persistence retains both typed identifiers for selection, claim, result, and recovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-comment-identity-'));
  const dbPath = join(dir, 'state.sqlite');
  const identity = normalizeCommentIdentity({ id: PREFLIGHT_NODE_ID, databaseId: PREFLIGHT_DATABASE_ID });
  try {
    let store = openRunnerStateStore(dbPath);
    store.recordIssueSelection({
      repo: 'TheTekTeam/modelspend', issueNumber: 300, selectionMode: 'preflight-direct',
      sourcePreflightCommentId: commentRevision(identity), sourcePreflightCommentIdentity: identity,
      dryRun: false, payload: { sourcePreflightCommentIdentity: identity },
    });
    store.recordClaim({
      repo: 'TheTekTeam/modelspend', issueNumber: 300,
      claim: { action: 'claim-ready-issue', selectionMode: 'preflight-direct', sourcePreflightCommentId: commentRevision(identity), sourcePreflightCommentIdentity: identity },
    });
    store.recordRunResult({
      repo: 'TheTekTeam/modelspend', issueNumber: 300, mode: 'cron', exitCode: 1,
      payload: { sourcePreflightCommentIdentity: identity },
    });
    store.recordRecoveryAttempt({
      attemptId: 'TheTekTeam/modelspend#300:captured', repo: 'TheTekTeam/modelspend', issueNumber: 300,
      claimId: commentRevision(identity), claimIdentity: identity,
      preflightRevision: commentRevision(identity), preflightIdentity: identity,
      startedAt: '2026-07-19T19:02:00Z', outcome: 'provider_execution_limit', resolutionState: 'unresolved',
    });
    store.close();

    store = openRunnerStateStore(dbPath);
    const selection = store.allRows('issue_selections')[0];
    const claim = store.allRows('claims')[0];
    const runResult = store.allRows('run_results')[0];
    const attempt = store.allRows('recovery_attempts')[0];
    assert.deepEqual(deserializeCommentIdentity(selection.source_preflight_comment_identity_json), identity);
    assert.deepEqual(deserializeCommentIdentity(claim.source_preflight_comment_identity_json), identity);
    assert.deepEqual(JSON.parse(runResult.payload_json).sourcePreflightCommentIdentity, identity);
    assert.deepEqual(deserializeCommentIdentity(attempt.claim_identity_json), identity);
    assert.deepEqual(deserializeCommentIdentity(attempt.preflight_identity_json), identity);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
