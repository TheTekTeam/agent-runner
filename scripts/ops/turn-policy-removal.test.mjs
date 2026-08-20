import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeArgs,
  buildClaudePrompt,
  evaluateClaudeCostAdmission,
  resolveProfile,
} from './claude-runner.mjs';

test('resolved execution profiles contain neither turn nor dollar-budget limits', () => {
  for (const name of ['docs', 'narrow', 'complex', 'critical']) {
    const profile = resolveProfile(name);
    assert.equal(Object.prototype.hasOwnProperty.call(profile, 'maxTurns'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(profile, 'maxBudgetUsd'), false);
  }
});

test('Claude command construction contains neither interaction-count nor dollar-budget flags', () => {
  const profile = resolveProfile('complex', { permissionMode: 'dontAsk' });
  const args = buildClaudeArgs({ prompt: 'complete the issue', profile });

  assert.equal(args.includes('--max-turns'), false);
  assert.equal(args.includes('--max-budget-usd'), false);
  assert.ok(args.includes('--permission-mode'));
});

test('generated implementation prompt directs completion without turn or dollar-budget language', () => {
  const profile = resolveProfile('complex', { permissionMode: 'dontAsk' });
  const prompt = buildClaudePrompt({
    issue: { number: 264, title: 'Remove obsolete execution limits' },
    commandText: '## Claude proceed command\nComplete the approved implementation.',
    profile,
    clearContext: true,
  });

  assert.doesNotMatch(prompt, /max\s+turns/i);
  assert.doesNotMatch(prompt, /max\s+budget/i);
  assert.doesNotMatch(prompt, /monetary/i);
  assert.match(prompt, /Continue until the issue is complete or a genuine blocker is reached/);
});

test('unattended admission remains bounded by explicit model/effort policy only', () => {
  const result = evaluateClaudeCostAdmission(
    { model: 'opus', effort: 'xhigh' },
    { CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '0.01' },
  );

  assert.deepEqual(result.violations, [
    'opus-requires-explicit-machine-opt-in',
    'high-effort-requires-explicit-machine-opt-in',
  ]);

  assert.equal(Object.prototype.hasOwnProperty.call(result.requested, 'maxBudgetUsd'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.policy, 'maxBudgetUsd'), false);
});
