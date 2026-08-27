// Focused tests for #239: scheduler selection/invocation of the accepted
// #238/#242 `--pr <n> --execute` continuation for exactly one safely-bound
// unresolved linked PR, before any fresh issue attempt/claim/workspace side
// effect. Continuation security/binding is owned by the `--pr` child and is
// not re-tested here.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  prFollowUpArgs,
  readPullRequestHeadSha,
  resolvePrFollowUpDispatch,
  runnerArgs,
  selectPrFollowUpDispatch,
} from './claude-runner-cron.mjs';

const HEAD_SHA_A = 'a'.repeat(40);
const HEAD_SHA_B = 'b'.repeat(40);

function candidate(prNumber, reasons = ['unresolved-review-threads:1']) {
  return {
    pr: { number: prNumber, headRefName: `issue-${prNumber}`, headSha: HEAD_SHA_A },
    unresolved: { hasUnresolvedFollowUp: true, reasons, unresolvedComments: [] },
  };
}

test('no linked-PR follow-up candidates preserves ordinary issue dispatch', () => {
  assert.equal(selectPrFollowUpDispatch({ candidates: [] }).mode, 'issue');
});

test('exactly one valid follow-up candidate selects pr-followup dispatch', () => {
  const decision = selectPrFollowUpDispatch({ candidates: [candidate(233)] });
  assert.equal(decision.mode, 'pr-followup');
  assert.equal(decision.candidate.pr.number, 233);
});

test('two ambiguous linked PRs with unresolved follow-up fail closed', () => {
  assert.equal(selectPrFollowUpDispatch({ candidates: [candidate(233), candidate(234)] }).mode, 'ambiguous');
});

test('unavailable/unfetchable candidate state fails closed', () => {
  assert.equal(selectPrFollowUpDispatch({ candidates: null }).mode, 'unavailable');
});

const linkedPrList = [{ number: 233, title: 'x', body: 'Fixes #226', headRefName: 'issue-226', url: '' }];

test('resolvePrFollowUpDispatch preserves ordinary issue dispatch with zero review fetch when no PR is linked', async () => {
  const decision = await resolvePrFollowUpDispatch({
    repo: 'TheTekTeam/agent-runner',
    issueNumber: 226,
    token: 'x',
    listPullRequests: () => [],
    fetchCandidates: async () => { throw new Error('must not be called when no PR is linked'); },
  });
  assert.equal(decision.mode, 'issue');
});

test('resolvePrFollowUpDispatch fails closed when the linked-PR list itself is unavailable', async () => {
  const decision = await resolvePrFollowUpDispatch({
    repo: 'TheTekTeam/agent-runner',
    issueNumber: 226,
    token: 'x',
    listPullRequests: () => { throw new Error('gh pr list failed'); },
  });
  assert.equal(decision.mode, 'unavailable');
});

test('resolvePrFollowUpDispatch fails closed when the #188 fetch throws (thread state unavailable)', async () => {
  const decision = await resolvePrFollowUpDispatch({
    repo: 'TheTekTeam/agent-runner',
    issueNumber: 226,
    token: 'x',
    listPullRequests: () => linkedPrList,
    fetchCandidates: async () => { throw new Error('graphql unavailable'); },
  });
  assert.equal(decision.mode, 'unavailable');
});

test('resolvePrFollowUpDispatch selects the single genuine candidate', async () => {
  const decision = await resolvePrFollowUpDispatch({
    repo: 'TheTekTeam/agent-runner',
    issueNumber: 226,
    token: 'x',
    listPullRequests: () => linkedPrList,
    fetchCandidates: async ({ issue }) => (issue === 226 ? [candidate(233)] : []),
  });
  assert.equal(decision.mode, 'pr-followup');
  assert.equal(decision.candidate.pr.number, 233);
});

test('resolvePrFollowUpDispatch fails closed on two linked unresolved PRs', async () => {
  const decision = await resolvePrFollowUpDispatch({
    repo: 'TheTekTeam/agent-runner',
    issueNumber: 226,
    token: 'x',
    listPullRequests: () => [
      { number: 233, title: 'x', body: 'Fixes #226', headRefName: 'issue-226-a', url: '' },
      { number: 234, title: 'y', body: 'Fixes #226', headRefName: 'issue-226-b', url: '' },
    ],
    fetchCandidates: async () => [candidate(233), candidate(234)],
  });
  assert.equal(decision.mode, 'ambiguous');
});

test('prFollowUpArgs builds a canonical --pr child invocation, never --issue', () => {
  const args = prFollowUpArgs(233, { configPath: '/tmp/c.json', outputDir: '.var/claude-runner', execute: true });
  assert.ok(args.includes('--pr'));
  assert.equal(args[args.indexOf('--pr') + 1], '233');
  assert.equal(args.includes('--issue'), false);
  assert.ok(args.includes('--execute'));
  assert.equal(args[args.indexOf('--config') + 1], '/tmp/c.json');
});

test('runnerArgs (ordinary issue dispatch) is unaffected and still uses --issue', () => {
  const args = runnerArgs(226, { configPath: null, outputDir: '.var/claude-runner', execute: true });
  assert.ok(args.includes('--issue'));
  assert.equal(args.includes('--pr'), false);
});

test('readPullRequestHeadSha returns the proven head SHA for the same PR number', () => {
  const calls = [];
  const sha = readPullRequestHeadSha('TheTekTeam/agent-runner', 233, (argv) => {
    calls.push(argv);
    return JSON.stringify({ headRefOid: HEAD_SHA_B, state: 'OPEN' });
  });
  assert.equal(sha, HEAD_SHA_B);
  assert.deepEqual(calls[0], ['pr', 'view', '233', '--repo', 'TheTekTeam/agent-runner', '--json', 'headRefOid,state']);
});

test('readPullRequestHeadSha returns null (never a mode/reason string) when the read fails', () => {
  assert.equal(readPullRequestHeadSha('r', 1, () => { throw new Error('gh down'); }), null);
  assert.equal(readPullRequestHeadSha('r', 1, () => 'not json'), null);
  assert.equal(readPullRequestHeadSha('r', 1, () => JSON.stringify({ headRefOid: 'short' })), null);
  assert.equal(readPullRequestHeadSha('r', 1, () => JSON.stringify({ state: 'OPEN' })), null);
});
