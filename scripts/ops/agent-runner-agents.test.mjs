import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SHARED_CODEX_CLAUDE_LABEL,
  agentAssignmentDisplayName,
  allAgentLabels,
  buildAgentCommandArgs,
  resolveAgentById,
  resolveAgentForLabels,
  unsupportedAgentSkip,
  validateAgentControls,
  agentRunMetadata,
} from './agent-runner-agents.mjs';

test('Claude implementation adapter builds a cache-stable uncapped CLI invocation', () => {
  const args = buildAgentCommandArgs({
    agent: resolveAgentById('claude-code-cli'),
    prompt: 'hello',
    profile: { model: 'sonnet', effort: 'medium', maxBudgetUsd: '1.50', permissionMode: 'dontAsk' },
    env: {},
  });
  assert.deepEqual(args.slice(0, -1), ['-p', '--exclude-dynamic-system-prompt-sections', '--model', 'sonnet', '--effort', 'medium', '--max-budget-usd', '1.50', '--permission-mode', 'dontAsk', '--output-format', 'json']);
  assert.equal(args.includes(['--max', 'turns'].join('-')), false);
  assert.equal(args.at(-1), 'hello');
});

test('agent command construction uses only supported execution controls', () => {
  const agent = resolveAgentById('claude-code-cli');
  assert.equal(Object.keys(agent.controls).includes(['max', 'Turns'].join('')), false);
  assert.equal(agent.controls.excludeDynamicSystemPromptSections.supported, true);
  assert.equal(agent.controls.excludeDynamicSystemPromptSections.flag, '--exclude-dynamic-system-prompt-sections');

  const args = buildAgentCommandArgs({
    agent,
    prompt: 'complete the issue',
    profile: { model: 'sonnet', effort: 'medium', maxBudgetUsd: '1.00', permissionMode: 'dontAsk' },
    env: {},
  });
  assert.equal(args.includes(['--max', 'turns'].join('-')), false);
  assert.equal(args.includes('1'), false);
  assert.equal(args.includes('--exclude-dynamic-system-prompt-sections'), true);
});

test('Claude adapter builds a constrained native-worktree implementation invocation without a turn cap', () => {
  const args = buildAgentCommandArgs({
    agent: resolveAgentById('claude-code-cli'),
    prompt: 'implement the approved preflight',
    profile: {
      model: 'sonnet',
      effort: 'medium',
      maxBudgetUsd: '1.00',
      permissionMode: 'dontAsk',
      worktreeName: 'agent-runner-658-123',
      tools: 'Read,Edit,Bash',
      allowedTools: ['Read', 'Edit', 'Bash(git status *)'],
      disallowedTools: ['Agent', 'mcp__*'],
      strictMcpConfig: true,
      disableSlashCommands: true,
      settings: '{"permissions":{"disableBypassPermissionsMode":"disable"}}',
      settingSources: '',
    },
    env: {},
  });
  assert.deepEqual(args.slice(0, -1), [
    '--worktree', 'agent-runner-658-123',
    '-p',
    '--exclude-dynamic-system-prompt-sections',
    '--model', 'sonnet',
    '--effort', 'medium',
    '--max-budget-usd', '1.00',
    '--permission-mode', 'dontAsk',
    '--tools', 'Read,Edit,Bash',
    '--allowedTools', 'Read', 'Edit', 'Bash(git status *)',
    '--disallowedTools', 'Agent', 'mcp__*',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--settings', '{"permissions":{"disableBypassPermissionsMode":"disable"}}',
    '--setting-sources', '',
    '--output-format', 'json',
  ]);
  assert.equal(args.includes(['--max', 'turns'].join('-')), false);
  assert.equal(args.at(-1), 'implement the approved preflight');
});

test('read-only plan mode keeps current syntax and does not force dynamic-system-prompt exclusion', () => {
  const args = buildAgentCommandArgs({
    agent: resolveAgentById('claude-code-cli'),
    prompt: 'plan only',
    profile: { model: 'sonnet', effort: 'medium', maxBudgetUsd: '1.00', permissionMode: 'plan' },
    env: {},
  });
  assert.deepEqual(args.slice(0, -1), ['-p', '--model', 'sonnet', '--effort', 'medium', '--max-budget-usd', '1.00', '--permission-mode', 'plan', '--output-format', 'json']);
});

test('Claude command construction refuses cache-disabled execution before provider launch', () => {
  const agent = resolveAgentById('claude-code-cli');
  const profile = { model: 'sonnet', effort: 'medium', maxBudgetUsd: '1.00', permissionMode: 'dontAsk' };
  assert.throws(
    () => buildAgentCommandArgs({ agent, prompt: 'blocked', profile, env: { DISABLE_PROMPT_CACHING: 'true' } }),
    (error) => error?.code === 'claude-prompt-cache-disabled' && error?.cachePolicy?.disableVariable === 'DISABLE_PROMPT_CACHING',
  );
  assert.throws(
    () => buildAgentCommandArgs({ agent, prompt: 'blocked', profile, env: { DISABLE_PROMPT_CACHING_SONNET: '1' } }),
    (error) => error?.code === 'claude-prompt-cache-disabled' && error?.cachePolicy?.reason === 'model-disable',
  );
});

test('future agent labels resolve to unsupported skip diagnostics', () => {
  const agent = resolveAgentForLabels(['agent:codex-cli']);
  assert.equal(agent.agentId, 'codex-cli');
  assert.equal(agent.implemented, false);
  assert.deepEqual(unsupportedAgentSkip(agent, { issueNumber: 655 }), {
    issue: 655,
    reason: 'unsupported-agent',
    agentId: 'codex-cli',
    label: null,
    detail: "Agent 'codex-cli' is registered for future use but is not implemented by this runner.",
  });
});

test('unsupported requested controls fail closed unless ignored', () => {
  const agent = resolveAgentById('codex-cli');
  assert.throws(() => validateAgentControls(agent, { model: 'gpt-5.5' }), /Unsupported agent control/);
  assert.deepEqual(validateAgentControls(agent, { model: 'gpt-5.5' }, { ignoreUnsupported: true }), [
    { control: 'model', reason: 'unsupported-control', agentId: 'codex-cli' },
  ]);
});

test('agent run metadata includes agent id model and effort', () => {
  assert.deepEqual(agentRunMetadata(resolveAgentById('claude-code-cli'), { model: 'sonnet', effort: 'high' }), {
    agentId: 'claude-code-cli',
    agentType: 'claude',
    implemented: true,
    model: 'sonnet',
    effort: 'high',
  });
});

test('shared Codex / Claude assignment resolves to Claude and records the actual selected agent', () => {
  const agent = resolveAgentForLabels([SHARED_CODEX_CLAUDE_LABEL]);
  assert.equal(agent.agentId, 'claude-code-cli');
  assert.equal(agent.command, 'claude');
  assert.equal(agent.implemented, true);
  assert.equal(agentAssignmentDisplayName(SHARED_CODEX_CLAUDE_LABEL), 'Codex / Claude');
  assert.deepEqual(agentRunMetadata(agent, {
    model: 'sonnet',
    effort: 'medium',
    assignmentLabel: SHARED_CODEX_CLAUDE_LABEL,
  }), {
    agentId: 'claude-code-cli',
    agentType: 'claude',
    implemented: true,
    model: 'sonnet',
    effort: 'medium',
    assignmentLabel: 'agent:codex-claude',
    assignmentDisplayName: 'Codex / Claude',
  });
});

test('shared assignment remains one supported label and cannot resolve to Codex CLI or paid fallback', () => {
  const labels = allAgentLabels();
  assert.equal(labels.filter((label) => label === SHARED_CODEX_CLAUDE_LABEL).length, 1);
  assert.equal(resolveAgentById('codex-cli').labels.includes(SHARED_CODEX_CLAUDE_LABEL), false);
  assert.equal(resolveAgentForLabels([SHARED_CODEX_CLAUDE_LABEL]).agentId, 'claude-code-cli');
  assert.equal(resolveAgentById('codex-cli').implemented, false);
  assert.equal(resolveAgentById('codex-cli').command, null);
});

test('unknown composite-like labels still fail closed', () => {
  assert.equal(resolveAgentForLabels(['agent:claude-codex']), null);
  assert.equal(resolveAgentForLabels(['agent:either']), null);
});

test('default label registry includes Claude and future agents without implementing them', () => {
  assert.ok(allAgentLabels().includes('agent:claude-code-cli'));
  assert.ok(allAgentLabels().includes(SHARED_CODEX_CLAUDE_LABEL));
  assert.ok(allAgentLabels().includes('agent:codex-cli'));
  assert.deepEqual(allAgentLabels({ includeFuture: false }), ['agent:claude', 'agent:claude-code-cli', SHARED_CODEX_CLAUDE_LABEL]);
});

test('agent:codex is Codex Web/manual and is not one of codex-cli\'s labels, nor any other adapter\'s', () => {
  assert.equal(resolveAgentById('codex-cli').labels.includes('agent:codex'), false);
  assert.equal(allAgentLabels().includes('agent:codex'), false);
  assert.equal(resolveAgentForLabels(['agent:codex']), null);
});

test('only agent:codex-cli identifies the codex-cli adapter', () => {
  assert.equal(resolveAgentForLabels(['agent:codex-cli']).agentId, 'codex-cli');
  assert.deepEqual(resolveAgentById('codex-cli').labels, ['agent:codex-cli']);
});

test('agent:grok-cli resolves to the grok-cli adapter, foundation-only and non-routable', () => {
  const agent = resolveAgentForLabels(['agent:grok-cli']);
  assert.equal(agent.agentId, 'grok-cli');
  assert.equal(agent.command, null);
  assert.equal(agent.implemented, false);
  assert.deepEqual(unsupportedAgentSkip(agent, { issueNumber: 700 }), {
    issue: 700,
    reason: 'unsupported-agent',
    agentId: 'grok-cli',
    label: null,
    detail: "Agent 'grok-cli' is registered for future use but is not implemented by this runner.",
  });
});

test('only agent:grok-cli identifies the grok-cli adapter, and no other adapter claims that label', () => {
  assert.equal(resolveAgentForLabels(['agent:grok-cli']).agentId, 'grok-cli');
  assert.deepEqual(resolveAgentById('grok-cli').labels, ['agent:grok-cli']);
});

test('default label registry includes grok-cli without implementing it', () => {
  assert.ok(allAgentLabels().includes('agent:grok-cli'));
  assert.equal(resolveAgentById('grok-cli').implemented, false);
  assert.equal(allAgentLabels({ includeFuture: false }).includes('agent:grok-cli'), false);
});
