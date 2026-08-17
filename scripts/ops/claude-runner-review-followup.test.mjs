import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReviewFollowUpPrompt,
  detectUnresolvedReviewFollowUp,
  findLinkedOpenPullRequests,
  linkedIssueNumberFromPr,
  linkedIssueNumbersFromPr,
} from './claude-runner-review-followup.mjs';

test('detects unresolved follow-up when the latest review per author requested changes', () => {
  const reviews = [
    { user: { login: 'manager-bot' }, state: 'COMMENTED', body: 'looks close', submitted_at: '2026-07-01T10:00:00Z' },
    { user: { login: 'manager-bot' }, state: 'CHANGES_REQUESTED', body: 'please fix the redaction gap', submitted_at: '2026-07-02T10:00:00Z' },
  ];
  const result = detectUnresolvedReviewFollowUp({ reviews });
  assert.equal(result.hasUnresolvedFollowUp, true);
  assert.match(result.reasons.join(','), /changes-requested:manager-bot/);
  assert.equal(result.unresolvedComments.some((c) => /redaction gap/.test(c.body)), true);
});

test('does not trigger when the latest review per author is approved, even after an earlier changes-requested', () => {
  const reviews = [
    { user: { login: 'manager-bot' }, state: 'CHANGES_REQUESTED', body: 'fix this', submitted_at: '2026-07-01T10:00:00Z' },
    { user: { login: 'manager-bot' }, state: 'APPROVED', body: 'looks good now', submitted_at: '2026-07-02T10:00:00Z' },
  ];
  const result = detectUnresolvedReviewFollowUp({ reviews });
  assert.equal(result.hasUnresolvedFollowUp, false);
});

test('detects unresolved review threads independently of review state', () => {
  const result = detectUnresolvedReviewFollowUp({
    reviews: [],
    reviewThreads: [
      { isResolved: false, comments: [{ user: { login: 'reviewer' }, body: 'this needs a fix', created_at: '2026-07-01T10:00:00Z' }] },
      { isResolved: true, comments: [{ user: { login: 'reviewer' }, body: 'already fine' }] },
    ],
  });
  assert.equal(result.hasUnresolvedFollowUp, true);
  assert.equal(result.unresolvedComments.some((c) => /needs a fix/.test(c.body)), true);
  assert.equal(result.unresolvedComments.some((c) => /already fine/.test(c.body)), false);
});

test('returns no follow-up when there is nothing unresolved', () => {
  const result = detectUnresolvedReviewFollowUp({ reviews: [{ user: { login: 'a' }, state: 'APPROVED' }], reviewThreads: [], comments: [] });
  assert.equal(result.hasUnresolvedFollowUp, false);
  assert.deepEqual(result.reasons, []);
});

test('linkedIssueNumberFromPr extracts the latest accepted linkage reference', () => {
  assert.equal(linkedIssueNumberFromPr({ body: 'Fixes #123' }), 123);
  assert.equal(linkedIssueNumberFromPr({ body: 'Closes #10\n\nAlso resolves #20' }), 20);
  assert.equal(linkedIssueNumberFromPr({ body: 'Implements #629 from an allowlisted manager preflight.' }), 629);
  assert.equal(linkedIssueNumberFromPr({ body: 'No linkage here' }), null);
});

test('linkedIssueNumbersFromPr exposes the distinct linked issue set without changing latest-wins compatibility', () => {
  const input = { title: 'Fixes #10', body: 'Closes #10\nAlso resolves #20\nImplements #20' };
  assert.deepEqual(linkedIssueNumbersFromPr(input), [10, 20]);
  assert.equal(linkedIssueNumberFromPr(input), 20);
  assert.deepEqual(linkedIssueNumbersFromPr({ body: 'No linkage here' }), []);
});

test('findLinkedOpenPullRequests matches by accepted linkage keyword or branch suffix', () => {
  const prs = [
    { number: 1, title: 'unrelated', body: 'no link', headRefName: 'feature/other' },
    { number: 2, title: 'fix', body: 'Fixes #629', headRefName: 'claude/something-629' },
    { number: 3, title: 'fix', body: 'no keyword', headRefName: 'claude/ops-claude-runner-dell-queue-629' },
    { number: 4, title: 'runner publication', body: 'Implements #629 from an allowlisted manager preflight.', headRefName: 'claude/something-629-v4' },
  ];
  const linked = findLinkedOpenPullRequests({ issueNumber: 629, pullRequests: prs });
  assert.deepEqual(linked.map((pr) => pr.number).sort(), [2, 3, 4]);
});

test('buildReviewFollowUpPrompt includes branch, PR, linked issue, and stay-on-branch instructions', () => {
  const unresolved = detectUnresolvedReviewFollowUp({
    reviews: [{ user: { login: 'manager-bot' }, state: 'CHANGES_REQUESTED', body: 'add tests for redaction', submitted_at: '2026-07-02T10:00:00Z' }],
  });
  const prompt = buildReviewFollowUpPrompt({
    pr: { number: 629, title: 'Adapt Claude runner', url: 'https://github.com/TheTekTeam/modelspend/pull/629' },
    issueNumber: 629,
    branch: 'claude/ops-claude-runner-dell-queue-629',
    unresolved,
  });
  assert.match(prompt, /PR: #629/);
  assert.match(prompt, /Linked issue: #629/);
  assert.match(prompt, /claude\/ops-claude-runner-dell-queue-629/);
  assert.match(prompt, /Stay on branch/);
  assert.match(prompt, /Do not merge, approve, or close/);
  assert.match(prompt, /add tests for redaction/);
  assert.equal(prompt.startsWith('/clear'), false);
});
