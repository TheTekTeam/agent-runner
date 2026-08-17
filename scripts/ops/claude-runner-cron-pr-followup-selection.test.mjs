// Focused tests for #236: scheduler selection of `pr-followup` dispatch vs
// ordinary `--issue` dispatch, before any attempt/claim mutation.

import assert from 'node:assert/strict';
import test from 'node:test';

import { prFollowUpArgs, resolvePrFollowUpDispatch, runnerArgs, selectPrFollowUpDispatch } from './claude-runner-cron.mjs';

function candidate(prNumber, reasons = ['unresolved-review-threads:1']) {
  return {
    pr: { number: prNumber, headRefName: `issue-${prNumber}`, headSha: `sha-${prNumber}` },
    unresolved: { hasUnresolvedFollowUp: true, reasons, unresolvedComments: [] },
  };
}

test('no linked-PR follow-up candidates preserves ordinary issue dispatch', () => {
  const decision = selectPrFollowUpDispatch({ candidates: [] });
  assert.equal(decision.mode, 'issue');
});

test('exactly one valid follow-up candidate selects pr-followup dispatch', () => {
  const decision = selectPrFollowUpDispatch({ candidates: [candidate(233)] });
  assert.equal(decision.mode, 'pr-followup');
  assert.equal(decision.candidate.pr.number, 233);
});

test('two ambiguous linked PRs with unresolved follow-up fail closed', () => {
  const decision = selectPrFollowUpDispatch({ candidates: [candidate(233), candidate(234)] });
  assert.equal(decision.mode, 'ambiguous');
});

test('unavailable/unfetchable candidate state fails closed', () => {
  const decision = selectPrFollowUpDispatch({ candidates: null });
  assert.equal(decision.mode, 'unavailable');
});

const linkedPrList = [{ number: 233, title: 'x', body: 'Fixes #226', headRefName: 'issue-226', url: '' }];

test('resolvePrFollowUpDispatch preserves ordinary issue dispatch with zero network calls when no PR is linked', async () => {
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

test('resolvePrFollowUpDispatch fails closed when the #188 fetch throws', async () => {
  const decision = await resolvePrFollowUpDispatch({
    repo: 'TheTekTeam/agent-runner',
    issueNumber: 226,
    token: 'x',
    listPullRequests: () => linkedPrList,
    fetchCandidates: async () => { throw new Error('graphql unavailable'); },
  });
  assert.equal(decision.mode, 'unavailable');
});

test('resolvePrFollowUpDispatch selects the single genuine candidate (#233 shape)', async () => {
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

test('prFollowUpArgs builds a canonical --pr child invocation, not --issue', () => {
  const args = prFollowUpArgs(233, { configPath: null, outputDir: '.var/claude-runner', execute: true });
  assert.ok(args.includes('--pr'));
  assert.equal(args[args.indexOf('--pr') + 1], '233');
  assert.equal(args.includes('--issue'), false);
  assert.ok(args.includes('--execute'));
});

test('runnerArgs (ordinary issue dispatch) is unaffected and still uses --issue', () => {
  const args = runnerArgs(226, { configPath: null, outputDir: '.var/claude-runner', execute: true });
  assert.ok(args.includes('--issue'));
  assert.equal(args.includes('--pr'), false);
});
