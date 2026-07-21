import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allAgentLabels,
  buildAgentCommandArgs,
  resolveAgentById,
  resolveAgentForLabels,
  unsupportedAgentSkip,
  validateAgentControls,
  agentRunMetadata,
} from './agent-runner-agents.mjs';

test('Claude implementation adapter builds an uncapped CLI invocation', () => {
  const args = buildAgentCommandArgs({
    agent: resolveAgentById('claude-code-cli'),
    prompt: 'hello',
    profile: { model: 'sonnet', effort: 'medium', maxBudgetUsd: '1.50', permissionMode: 'dontAsk' },
  });
  assert.deepEqual(args.slice(0, -1), ['-p', '--model', 'sonnet', '--effort', 'medium', '--max-budget-usd', '1.50', '--permission-mode', 'dontAsk', '--output-format', 'json']);
  assert.equal(args.includes('--max-turns'), false);
  assert.equal(args.at(-1), 'hello');
});

test('agent command construction has no turn-control concept for implementation', () => {
  const agent = resolveAgentById('claude-code-cli');
  assert.equal(agent.controls.maxTurns.deprecated, true);

  const args = buildAgentCommandArgs({
    agent,
    prompt: 'complete the issue',
    profile: { model: 'sonnet', effort: 'medium', maxBudgetUsd: '1.00', permissionMode: 'dontAsk' },
  });
  assert.equal(args.includes('--max-turns'), false);
  assert.equal(args.includes('1'), false);
});

test('Claude adapter builds a constrained native-worktree implementation invocation without a turn cap', () => {
  const args = buildAgentCommandArgs({
    agent: resolveAgentById('claude-code-cli'),
    prompt: 'implement the approved preflight',
    profile: {
      model: 'sonnet',
      effort: 'medium',      maxBudgetUsd: '1.00',
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
  });
  assert.deepEqual(args.slice(0, -1), [
    '--worktree', 'agent-runner-658-123',
    '-p',
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
  assert.equal(args.includes('--max-turns'), false);
  assert.equal(args.at(-1), 'implement the approved preflight');
});

test('read-only plan mode retains its bounded compatibility invocation', () => {
  const args = buildAgentCommandArgs({
    agent: resolveAgentById('claude-code-cli'),
    prompt: 'plan only',
    profile: { model: 'sonnet', effort: 'medium', maxBudgetUsd: '1.00', permissionMode: 'plan' },
  });
  assert.deepEqual(args.slice(0, -1), ['-p', '--model', 'sonnet', '--effort', 'medium', '--max-budget-usd', '1.00', '--permission-mode', 'plan', '--output-format', 'json']);
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

test('default label registry includes Claude and future agents without implementing them', () => {
  assert.ok(allAgentLabels().includes('agent:claude-code-cli'));
  assert.ok(allAgentLabels().includes('agent:codex-cli'));
  assert.deepEqual(allAgentLabels({ includeFuture: false }), ['agent:claude', 'agent:claude-code-cli']);
});
