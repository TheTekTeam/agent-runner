import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePrContinuationBinding } from './agent-runner-pr-continuation-binding.mjs';

const dependencies = {
  resolveDispatchIdentity: () => { throw new Error('must not reach dispatch identity'); },
  prepareWorkspace: () => { throw new Error('must not reach workspace preparation'); },
  captureEvidence: () => { throw new Error('must not reach worktree evidence'); },
};

function resolveWithPr(pullRequest) {
  return resolvePrContinuationBinding({
    pullRequest,
    issue: { number: 241 },
    ...dependencies,
  });
}

test('missing PR state fails closed before authority or workspace work', () => {
  const result = resolveWithPr({ number: 99, body: 'Fixes #241' });
  assert.equal(result.allowed, false);
  assert.equal(result.failureReason, 'pr-continuation-pr-not-open');
});

test('closed PR fails closed before authority or workspace work', () => {
  const result = resolveWithPr({ number: 99, state: 'closed', body: 'Fixes #241' });
  assert.equal(result.allowed, false);
  assert.equal(result.failureReason, 'pr-continuation-pr-not-open');
});

test('missing, zero or non-integer PR number fails closed before authority or workspace work', () => {
  for (const number of [undefined, 0, -1, 1.5, '99']) {
    const result = resolveWithPr({ number, state: 'open', body: 'Fixes #241' });
    assert.equal(result.allowed, false, `number=${String(number)}`);
    assert.equal(result.failureReason, 'pr-continuation-pr-number-invalid', `number=${String(number)}`);
  }
});
