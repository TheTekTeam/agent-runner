import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findLinkedOpenPullRequests,
  linkedIssueNumberFromPr,
  linkedIssueNumbersFromPr,
} from './claude-runner-review-followup.mjs';

test('runner deterministic Implements wording is canonical PR continuation linkage', () => {
  const body = 'Implements #629 from an allowlisted manager preflight.';
  assert.deepEqual(linkedIssueNumbersFromPr({ body }), [629]);
  assert.equal(linkedIssueNumberFromPr({ body }), 629);
});

test('distinct linked issue set is exposed while legacy latest-wins helper remains compatible', () => {
  const input = { title: 'Fixes #10', body: 'Closes #10\nAlso resolves #20\nImplements #20' };
  assert.deepEqual(linkedIssueNumbersFromPr(input), [10, 20]);
  assert.equal(linkedIssueNumberFromPr(input), 20);
  assert.deepEqual(linkedIssueNumbersFromPr({ body: 'No linkage here' }), []);
});

test('runner-published PR remains linked when its approved branch has a version suffix', () => {
  const prs = [
    {
      number: 99,
      title: 'bounded runner publication',
      body: 'Implements #629 from an allowlisted manager preflight.',
      headRefName: 'claude/candidate-cost-admission-629-v4',
    },
  ];
  const linked = findLinkedOpenPullRequests({ issueNumber: 629, pullRequests: prs });
  assert.deepEqual(linked.map((pr) => pr.number), [99]);
});
