import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeArgs,
  buildClaudePrompt,
  evaluateClaudeCostAdmission,
  resolveProfile,
} from './claude-runner.mjs';

test('resolved execution profiles contain no interaction-count control', () => {
  for (const name of ['docs', 'narrow', 'complex', 'critical']) {
    const profile = resolveProfile(name);
    assert.equal(Object.keys(profile).includes(['max', 'Turns'].join('')), false);
  }
});

test('Claude command construction uses resource controls without an interaction-count flag', () => {
  const profile = resolveProfile('complex', { permissionMode: 'dontAsk' });
  const args = buildClaudeArgs({ prompt: 'complete the issue', profile });
  assert.equal(args.includes(['--max', 'turns'].join('-')), false);
  assert.ok(args.includes('--max-budget-usd'));
  assert.ok(args.includes('--permission-mode'));
});

test('generated implementation prompt directs completion without interaction-count language', () => {
  const profile = resolveProfile('complex', { permissionMode: 'dontAsk' });
  const prompt = buildClaudePrompt({
    issue: { number: 27, title: 'Remove obsolete execution control' },
    commandText: '## Claude proceed command\nComplete the approved implementation.',
    profile,
    clearContext: true,
  });
  assert.doesNotMatch(prompt, /max\s+turns/i);
  assert.match(prompt, /Continue until the issue is complete or a genuine blocker is reached/);
});

test('resource admission remains bounded by model, effort and monetary policy only', () => {
  const result = evaluateClaudeCostAdmission(
    { model: 'opus', effort: 'xhigh', maxBudgetUsd: '8.00' },
    {},
  );
  assert.deepEqual(result.violations, [
    'opus-requires-explicit-machine-opt-in',
    'high-effort-requires-explicit-machine-opt-in',
    'budget-cap-exceeds-machine-policy',
  ]);
  assert.equal(Object.keys(result.requested).includes(['max', 'Turns'].join('')), false);
  assert.equal(Object.keys(result.policy).includes(['max', 'Turns'].join('')), false);
});
