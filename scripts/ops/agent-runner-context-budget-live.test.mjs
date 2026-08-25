import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_MAX_TURNS_ENABLE_ENV,
  CLAUDE_MAX_TURNS_QUALIFICATION_ENV,
  CLAUDE_NATIVE_RESUME_ENABLE_ENV,
  buildAgentCommandArgs,
  claudeMaxTurnsPolicy,
  resolveAgentById,
} from './agent-runner-agents.mjs';

const claude = resolveAgentById('claude-code-cli');

function profile(name, effort = 'medium') {
  return {
    profile: name,
    model: 'sonnet',
    effort,
    permissionMode: 'dontAsk',
  };
}

function qualifiedEnv(extra = {}) {
  return {
    [CLAUDE_MAX_TURNS_ENABLE_ENV]: '1',
    [CLAUDE_MAX_TURNS_QUALIFICATION_ENV]: 'DELL-CLAUDE-MAX-TURNS-QUALIFIED-1',
    [CLAUDE_NATIVE_RESUME_ENABLE_ENV]: '1',
    ...extra,
  };
}

test('Claude turn ceilings are fail-closed and disabled without machine qualification', () => {
  assert.deepEqual(claudeMaxTurnsPolicy(profile('narrow'), {}), {
    active: false,
    qualificationRevision: null,
    taskClass: 'narrow',
    maxTurns: null,
    reason: 'machine-qualification-missing',
  });

  const enabledWithoutQualification = claudeMaxTurnsPolicy(profile('narrow'), {
    [CLAUDE_MAX_TURNS_ENABLE_ENV]: '1',
    [CLAUDE_NATIVE_RESUME_ENABLE_ENV]: '1',
  });
  assert.equal(enabledWithoutQualification.active, false);
  assert.equal(enabledWithoutQualification.reason, 'machine-qualification-missing');
});

test('qualification alone does not activate a material live behaviour change', () => {
  const policy = claudeMaxTurnsPolicy(profile('narrow'), {
    [CLAUDE_MAX_TURNS_QUALIFICATION_ENV]: 'DELL-CLAUDE-MAX-TURNS-QUALIFIED-1',
    [CLAUDE_NATIVE_RESUME_ENABLE_ENV]: '1',
  });
  assert.equal(policy.active, false);
  assert.equal(policy.reason, 'machine-enable-gate-off');
});

test('turn ceilings remain off when exact recovery capability is not enabled', () => {
  const policy = claudeMaxTurnsPolicy(profile('narrow'), {
    [CLAUDE_MAX_TURNS_ENABLE_ENV]: '1',
    [CLAUDE_MAX_TURNS_QUALIFICATION_ENV]: 'DELL-CLAUDE-MAX-TURNS-QUALIFIED-1',
  });
  assert.equal(policy.active, false);
  assert.equal(policy.maxTurns, null);
  assert.equal(policy.reason, 'native-resume-recovery-gate-off');
});

test('qualified task classes map to the accepted context-budget ceilings', () => {
  const env = qualifiedEnv();
  assert.equal(claudeMaxTurnsPolicy(profile('docs', 'low'), env).maxTurns, 6);
  assert.equal(claudeMaxTurnsPolicy(profile('narrow', 'low'), env).maxTurns, 10);
  assert.equal(claudeMaxTurnsPolicy(profile('normal'), env).maxTurns, 18);
  assert.equal(claudeMaxTurnsPolicy(profile('complex', 'high'), env).maxTurns, 30);
  assert.equal(claudeMaxTurnsPolicy(profile('critical', 'high'), env).maxTurns, 42);
});

test('default Claude command remains uncapped and preserves the current compatibility contract', () => {
  const args = buildAgentCommandArgs({
    agent: claude,
    prompt: 'implement bounded task',
    profile: profile('narrow', 'low'),
    env: {},
    allowDisabledPromptCaching: true,
  });
  assert.equal(args.includes('--max-turns'), false);
  assert.equal(args.includes('--max-budget-usd'), false);
});

test('machine-qualified enablement adds exactly one task-specific --max-turns control', () => {
  const args = buildAgentCommandArgs({
    agent: claude,
    prompt: 'implement bounded task',
    profile: profile('narrow', 'low'),
    env: qualifiedEnv(),
    allowDisabledPromptCaching: true,
  });
  const index = args.indexOf('--max-turns');
  assert.notEqual(index, -1);
  assert.equal(args[index + 1], '10');
  assert.equal(args.filter((value) => value === '--max-turns').length, 1);
  assert.equal(args.includes('--max-budget-usd'), false);
});

test('invalid qualification revision never enables the CLI control', () => {
  const env = qualifiedEnv({
    [CLAUDE_MAX_TURNS_QUALIFICATION_ENV]: 'bad revision with spaces',
  });
  const policy = claudeMaxTurnsPolicy(profile('critical', 'high'), env);
  assert.equal(policy.active, false);
  assert.equal(policy.qualificationRevision, null);
  assert.equal(policy.maxTurns, null);
});
