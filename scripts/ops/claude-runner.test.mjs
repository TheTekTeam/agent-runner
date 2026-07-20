import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildClaudeArgs,
  buildClaudePrompt,
  buildClaudeProcessEnv,
  buildPreflightDirectPrompt,
  classifyClaudeRunFailure,
  COST_POLICY_EXIT_CODE,
  EXECUTION_PHASE_IMPLEMENTATION,
  EXECUTION_POLICY_EXIT_CODE,
  defaultQuotaStatePath,
  detectExecutionNoop,
  detectPlanOnlyResult,
  evaluateClaudeCostAdmission,
  findBlockingPrFollowUp,
  findLatestClaudeCommand,
  findLatestClaudeContinueCommand,
  findLatestClaudeProceedCommand,
  hasManagerPreflight,
  inferProfile,
  latestManagerPreflightComment,
  parseArgs,
  parseClaudeResultEnvelope,
  parseKeyValueBlock,
  PLAN_ONLY_EXIT_CODE,
  prepareContinuationWorkspace,
  prepareImplementationWorkspace,
  publishImplementationDraft,
  readQuotaPauseState,
  removedClaudeProviderAuthKeys,
  resolveProfile,
  runOrPlanClaude,
  shouldUseClear,
  writeQuotaPauseState,
} from './claude-runner.mjs';
import {
  DEFAULT_MAX_SESSION_USAGE_BEFORE_START_PERCENT,
  parseQuotaCheckOutput,
} from './claude-runner-quota.mjs';

test('finds latest proceed command', () => {
  const comments = [
    { id: 1, created_at: '2026-06-26T10:00:00Z', body: '## Claude proceed command\nTask: old' },
    { id: 2, created_at: '2026-06-26T12:00:00Z', body: '## Claude proceed command\nTask: new', user: { login: 'gpcola' } },
  ];
  const result = findLatestClaudeProceedCommand(comments);
  assert.equal(result.sourceCommentId, 'github-comment:database:2');
  assert.equal(result.kind, 'proceed');
  assert.match(result.body, /Task: new/);
  assert.equal(result.authorLogin, 'gpcola');
});

test('finds latest runnable Claude command across proceed and continue comments', () => {
  const comments = [
    { id: 1, createdAt: '2026-06-26T10:00:00Z', body: '## Claude proceed command\nTask: start' },
    { id: 2, createdAt: '2026-06-26T12:00:00Z', body: '## Claude continue command\nTask: continue from branch' },
  ];
  const result = findLatestClaudeCommand(comments);
  assert.equal(result.sourceCommentId, 'github-comment:database:2');
  assert.equal(result.kind, 'continue');
  assert.match(result.body, /continue from branch/);
  assert.equal(findLatestClaudeContinueCommand(comments).sourceCommentId, 'github-comment:database:2');
});

test('ignores inline command marker text in runner-started comments', () => {
  const comments = [
    { id: 1, createdAt: '2026-06-26T10:00:00Z', body: '## Claude continue command\nTask: real continue' },
    { id: 2, createdAt: '2026-06-26T10:01:00Z', body: '## Claude runner started\n\nThis marker prevents repeat execution. Add a new `## Claude continue command` comment if continuation is needed.' },
  ];
  const result = findLatestClaudeContinueCommand(comments);
  assert.equal(result.sourceCommentId, 'github-comment:database:1');
  assert.match(result.body, /Task: real continue/);
});

test('claude-runner.mjs re-exports manager preflight helpers from the shared selection module', () => {
  assert.equal(hasManagerPreflight('## Manager preflight packet\nFiles checked.'), true);
  assert.equal(hasManagerPreflight('No preflight here.'), false);
  const comments = [
    { id: 1, createdAt: '2026-07-08T08:00:00Z', body: '## Manager preflight packet\nOld' },
    { id: 2, createdAt: '2026-07-08T10:00:00Z', body: '### ChatGPT preflight\nNew' },
  ];
  assert.equal(latestManagerPreflightComment(comments).id, 2);
});

test('buildPreflightDirectPrompt builds the prompt from issue title/body and the manager preflight packet, not a proceed command', () => {
  const issue = { number: 641, title: 'Agent Runner v2', body: 'Implement preflight-direct dispatch.' };
  const preflight = { id: 12, sourceCommentId: 12, body: '## Manager preflight packet\nFiles checked by ChatGPT.' };
  const profile = { profile: 'complex', model: 'sonnet', effort: 'high', maxTurns: 8, maxBudgetUsd: '4.00' };

  const prompt = buildPreflightDirectPrompt({ issue, preflight, profile, clearContext: true });

  assert.equal(prompt.startsWith('/clear'), false);
  assert.match(prompt, /^Start a fresh task context\./);
  assert.match(prompt, /Selection mode: preflight-direct/);
  assert.match(prompt, /Issue: #641 — Agent Runner v2/);
  assert.match(prompt, /Implement preflight-direct dispatch\./);
  assert.match(prompt, /Manager preflight packet\nFiles checked by ChatGPT\./);
  assert.match(prompt, /source comment github-comment:database:12/);
  assert.doesNotMatch(prompt, /## Claude proceed command/);
});

test('buildClaudePrompt (compatibility mode) still relays the literal command text', () => {
  const issue = { number: 99, title: 'Legacy command issue' };
  const profile = { profile: 'narrow', model: 'sonnet', effort: 'medium', maxTurns: 4, maxBudgetUsd: '1.50' };
  const prompt = buildClaudePrompt({ issue, commandText: '## Claude proceed command\nDo the thing', profile, clearContext: false });
  assert.equal(prompt.startsWith('/clear'), false);
  assert.match(prompt, /Latest Claude command:/);
  assert.match(prompt, /Do the thing/);
});

test('buildClaudePrompt with clearContext uses a plain fresh-context instruction, not a slash command', () => {
  const issue = { number: 99, title: 'Legacy command issue' };
  const profile = { profile: 'narrow', model: 'sonnet', effort: 'medium', maxTurns: 4, maxBudgetUsd: '1.50' };
  const prompt = buildClaudePrompt({ issue, commandText: '## Claude proceed command\nDo the thing', profile, clearContext: true });
  assert.equal(prompt.startsWith('/clear'), false);
  assert.match(prompt, /^Start a fresh task context\./);
});

test('implementation prompt consumes the manager preflight as the plan and requires repository work', () => {
  const issue = { number: 658, title: 'Portable runner entrypoints' };
  const profile = { profile: 'complex', model: 'sonnet', effort: 'medium', maxTurns: 3, maxBudgetUsd: '1.00', permissionMode: 'dontAsk' };
  const prompt = buildClaudePrompt({
    issue,
    commandText: '## Claude proceed command\nPhase: implementation',
    currentPreflight: { id: 77, body: '## Manager preflight packet\nBounded implementation scope.' },
    profile,
    clearContext: true,
    executionPhase: EXECUTION_PHASE_IMPLEMENTATION,
    worktreeIdentity: { name: 'agent-runner-658-77', expectedBranch: 'worktree-agent-runner-658-77' },
  });
  assert.match(prompt, /Execution phase: implementation/);
  assert.match(prompt, /do not spend this attempt writing another plan/i);
  assert.match(prompt, /worktree-agent-runner-658-77/);
  assert.match(prompt, /Current manager preflight packet \(source comment github-comment:database:77\)/);
});

test('generated issue-mode prompts never start with a literal /clear slash command, with or without clearContext', () => {
  const issue = { number: 641, title: 'Agent Runner v2', body: 'Implement preflight-direct dispatch.' };
  const preflight = { id: 12, sourceCommentId: 12, body: '## Manager preflight packet\nFiles checked by ChatGPT.' };
  const profile = { profile: 'complex', model: 'sonnet', effort: 'high', maxTurns: 8, maxBudgetUsd: '4.00' };

  for (const clearContext of [true, false]) {
    const claudePrompt = buildClaudePrompt({ issue, commandText: '## Claude proceed command\nDo the thing', profile, clearContext });
    const preflightPrompt = buildPreflightDirectPrompt({ issue, preflight, profile, clearContext });
    assert.equal(claudePrompt.startsWith('/clear'), false);
    assert.equal(preflightPrompt.startsWith('/clear'), false);
  }
});

test('parses command metadata', () => {
  const meta = parseKeyValueBlock('Profile: complex\nBranch: feature/example');
  assert.equal(meta.profile, 'complex');
  assert.equal(meta.branch, 'feature/example');
});

test('selects profile by risk', () => {
  assert.equal(inferProfile({ explicitProfile: 'docs' }), 'docs');
  assert.equal(inferProfile({ issue: { title: 'Fix RBAC tenant isolation bug' } }), 'critical');
  assert.equal(inferProfile({ issue: { title: 'API route registration refactor' } }), 'complex');
  assert.equal(inferProfile({ issue: { title: 'Documentation update' } }), 'docs');
  assert.equal(inferProfile({ issue: { title: 'Add table column test' } }), 'narrow');
});

test('issue #658 guardrail prose cannot promote a runner task to the critical profile', () => {
  const issue = {
    title: 'OPS.AGENT.RUNNER.ENTRYPOINT — complete the Dell runner',
    body: 'Do not touch production, security, provider routing, billing, or migrations.',
    labels: [{ name: 'priority:P0' }, { name: 'agent:claude-code-cli' }],
  };
  assert.equal(inferProfile({ issue, commandText: 'Keep production and security out of scope.' }), 'complex');
});

test('supports configured model aliases', () => {
  const profile = resolveProfile('docs', {}, { CLAUDE_RUNNER_MODEL_DOCS: 'custom-haiku' });
  assert.equal(profile.model, 'custom-haiku');
  assert.equal(profile.effort, 'low');
  assert.equal(profile.maxTurns, 2);
});

test('clear policy defaults to fresh context', () => {
  assert.equal(shouldUseClear({}), true);
  assert.equal(shouldUseClear({ resumeSession: 'issue-123' }), false);
  assert.equal(shouldUseClear({ noClear: true }), false);
});

test('Claude args include model effort budget and turn caps', () => {
  const args = buildClaudeArgs({
    prompt: 'hello',
    profile: { model: 'sonnet', effort: 'medium', maxTurns: 4, maxBudgetUsd: '1.50', permissionMode: 'plan' },
  });
  assert.deepEqual(args.slice(0, -1), ['-p', '--model', 'sonnet', '--effort', 'medium', '--max-turns', '4', '--max-budget-usd', '1.50', '--permission-mode', 'plan', '--output-format', 'json']);
});

test('critical defaults remain bounded and do not silently select Opus/xhigh', () => {
  const profile = resolveProfile('critical');
  assert.equal(profile.model, 'sonnet');
  assert.equal(profile.effort, 'high');
  assert.equal(profile.maxTurns, 3);
  assert.equal(profile.maxBudgetUsd, '1.50');
});

test('unattended cost admission rejects the observed #658 Opus/xhigh/10-turn/$8 controls', () => {
  const result = evaluateClaudeCostAdmission({ model: 'opus', effort: 'xhigh', maxTurns: 10, maxBudgetUsd: '8.00' }, {});
  assert.equal(result.allowed, false);
  assert.deepEqual(result.violations, [
    'opus-requires-explicit-machine-opt-in',
    'high-effort-requires-explicit-machine-opt-in',
    'turn-cap-exceeds-machine-policy',
    'budget-cap-exceeds-machine-policy',
  ]);
});

test('unattended cost admission permits the bounded critical default', () => {
  const result = evaluateClaudeCostAdmission(resolveProfile('critical'), {});
  assert.equal(result.allowed, true);
  assert.deepEqual(result.violations, []);
});

test('Opus/xhigh can only be admitted with explicit machine opt-ins and raised caps', () => {
  const result = evaluateClaudeCostAdmission(
    { model: 'opus', effort: 'xhigh', maxTurns: 10, maxBudgetUsd: '8.00' },
    {
      CLAUDE_RUNNER_ALLOW_OPUS: 'true',
      CLAUDE_RUNNER_ALLOW_XHIGH: 'true',
      CLAUDE_RUNNER_MAX_TURNS_PER_ATTEMPT: '10',
      CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '8',
    },
  );
  assert.equal(result.allowed, true);
});

test('Claude process env strips provider auth by default without mutating input', () => {
  const env = {
    PATH: '/usr/local/bin:/usr/bin',
    GH_TOKEN: 'github-token-placeholder',
    ANTHROPIC_API_KEY: 'provider-placeholder',
    ANTHROPIC_BASE_URL: 'https://example.invalid',
    AWS_ACCESS_KEY_ID: 'aws-key-placeholder',
    CLAUDE_RUNNER_MODEL_DOCS: 'custom-haiku',
  };
  const cleaned = buildClaudeProcessEnv(env);
  assert.equal(cleaned.PATH, env.PATH);
  assert.equal(cleaned.GH_TOKEN, env.GH_TOKEN);
  assert.equal(cleaned.CLAUDE_RUNNER_MODEL_DOCS, env.CLAUDE_RUNNER_MODEL_DOCS);
  assert.equal(cleaned.ANTHROPIC_API_KEY, undefined);
  assert.equal(cleaned.ANTHROPIC_BASE_URL, undefined);
  assert.equal(cleaned.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, 'provider-placeholder');
});

test('Claude process env can deliberately inherit provider auth', () => {
  const env = { ANTHROPIC_API_KEY: 'provider-placeholder' };
  assert.equal(buildClaudeProcessEnv(env, { inheritProviderAuth: true }).ANTHROPIC_API_KEY, 'provider-placeholder');
  assert.deepEqual(removedClaudeProviderAuthKeys(env, { inheritProviderAuth: true }), []);
  assert.deepEqual(removedClaudeProviderAuthKeys(env), ['ANTHROPIC_API_KEY']);
});

test('parseArgs defaults --pr, quota, and PR-followup-check flags safely', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.pr, undefined);
  assert.equal(defaults.checkQuota, false);
  assert.equal(defaults.forceQuotaCheck, false);
  assert.equal(defaults.skipPrFollowUpCheck, false);
  assert.equal(defaults.execute, false);
});

test('parseArgs accepts --pr, --check-quota, --force-quota-check, and --skip-pr-followup-check', () => {
  const args = parseArgs(['--pr', '42', '--check-quota', '--force-quota-check', '--skip-pr-followup-check']);
  assert.equal(args.pr, 42);
  assert.equal(args.checkQuota, true);
  assert.equal(args.forceQuotaCheck, true);
  assert.equal(args.skipPrFollowUpCheck, true);
});

test('parseArgs rejects a non-positive --pr', () => {
  assert.throws(() => parseArgs(['--pr', '0']), /--pr must be a positive integer/);
});

test('quota pause state round-trips through the local state file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-runner-quota-'));
  try {
    const statePath = defaultQuotaStatePath(dir);
    assert.equal(readQuotaPauseState(statePath), null);
    writeQuotaPauseState(statePath, { status: 'exhausted', pausedUntil: '2026-07-08T13:00:00.000Z', reason: 'quota-exhausted' });
    const state = readQuotaPauseState(statePath);
    assert.equal(state.status, 'exhausted');
    assert.equal(state.reason, 'quota-exhausted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findBlockingPrFollowUp finds an open PR linked by branch suffix with unresolved changes-requested review', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async (url) => {
    if (url.includes('/pulls?state=open')) {
      return {
        ok: true,
        json: async () => [
          { number: 42, title: 'Adapt runner', body: 'no keyword', head: { ref: 'claude/ops-claude-runner-dell-queue-629' } },
        ],
      };
    }
    if (url.includes('/pulls/42/reviews')) {
      return {
        ok: true,
        json: async () => [
          { user: { login: 'manager-bot' }, state: 'CHANGES_REQUESTED', body: 'address the redaction gap', submitted_at: '2026-07-02T10:00:00Z' },
        ],
      };
    }
    if (url.includes('/issues/42/comments')) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/pulls/42')) {
      return { ok: true, json: async () => ({ number: 42 }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const blocking = await findBlockingPrFollowUp({ repo: 'TheTekTeam/modelspend', issue: 629, token: 'placeholder-token' });
  assert.ok(blocking);
  assert.equal(blocking.pr.number, 42);
  assert.equal(blocking.unresolved.hasUnresolvedFollowUp, true);
});

test('detectExecutionNoop is a no-op only in --execute mode', () => {
  assert.deepEqual(detectExecutionNoop({ execute: false, status: 0, signal: null, stdout: '', stderr: '' }), { noop: false, reason: null });
});

test('detectExecutionNoop flags a clean exit with no stdout/stderr as the observed issue #648 no-op', () => {
  const result = detectExecutionNoop({ execute: true, status: 0, signal: null, stdout: '\n', stderr: '' });
  assert.equal(result.noop, true);
  assert.equal(result.reason, 'claude-exited-zero-with-no-output');
});

test('detectExecutionNoop flags a spawn error even when status looks clean', () => {
  const result = detectExecutionNoop({ execute: true, status: 0, signal: null, stdout: '', stderr: '', spawnError: new Error('ENOENT') });
  assert.equal(result.noop, true);
  assert.equal(result.reason, 'claude-spawn-error');
});

test('detectExecutionNoop flags a killed process', () => {
  const result = detectExecutionNoop({ execute: true, status: null, signal: 'SIGKILL', stdout: '', stderr: '' });
  assert.equal(result.noop, true);
  assert.equal(result.reason, 'claude-killed-by-signal');
});

test('detectExecutionNoop does not flag a real run that produced output', () => {
  const result = detectExecutionNoop({ execute: true, status: 0, signal: null, stdout: 'Implemented the change.\n', stderr: '' });
  assert.deepEqual(result, { noop: false, reason: null });
});

test('detectExecutionNoop does not flag a genuine non-zero Claude failure exit (handled separately via exit code)', () => {
  const result = detectExecutionNoop({ execute: true, status: 1, signal: null, stdout: '', stderr: 'boom' });
  assert.deepEqual(result, { noop: false, reason: null });
});

test('classifyClaudeRunFailure normalizes the observed max-turns failure from issue #658', () => {
  assert.equal(
    classifyClaudeRunFailure({ status: 1, stdout: 'Error: Reached max turns (10)' }),
    'turn-limit-exhausted',
  );
});

test('structured Claude result accounting is allowlisted and never retains the session id', () => {
  const result = parseClaudeResultEnvelope(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Implemented the bounded change.',
    session_id: 'must-not-be-retained',
    num_turns: 3,
    total_cost_usd: 0.42,
    usage: {
      input_tokens: 120,
      output_tokens: 45,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
      raw_provider_payload: 'must-not-be-retained',
    },
    modelUsage: {
      'claude-sonnet-test': {
        inputTokens: 120,
        outputTokens: 45,
        costUSD: 0.42,
        contextWindow: 200000,
        secret: 'must-not-be-retained',
      },
    },
  }));

  assert.equal(result.parsed, true);
  assert.equal(result.hasSessionId, true);
  assert.equal(result.numTurns, 3);
  assert.equal(result.totalCostUsd, 0.42);
  assert.deepEqual(result.usage, {
    inputTokens: 120,
    outputTokens: 45,
    cacheReadInputTokens: 80,
    cacheCreationInputTokens: 10,
  });
  assert.equal(JSON.stringify(result).includes('must-not-be-retained'), false);
});

test('structured Claude max-turn subtype has priority over a generic process exit', () => {
  const envelope = parseClaudeResultEnvelope(JSON.stringify({
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    num_turns: 3,
    total_cost_usd: 0.75,
  }));
  assert.equal(classifyClaudeRunFailure({ status: 1, resultEnvelope: envelope }), 'turn-limit-exhausted');
});

function capturedClaudeArray(issue) {
  return readFileSync(new URL(`./fixtures/claude-event-array-${issue}.json`, import.meta.url), 'utf8');
}

for (const issue of [299, 550]) {
  test(`#${issue} captured array regression: repository quota strings and allowed rate-limit events are not provider exhaustion`, () => {
    const dir = mkdtempSync(join(tmpdir(), `runner-false-quota-${issue}-`));
    const quotaStatePath = join(dir, 'quota-state.json');
    const stream = capturedClaudeArray(issue);
    const envelope = parseClaudeResultEnvelope(stream);
    assert.equal(envelope.parsed, true);
    assert.equal(envelope.structuredFailure, null);
    assert.equal(classifyClaudeRunFailure({ status: 0, stdout: stream, resultEnvelope: envelope }), null);
    const originalLog = console.log;
    try {
      console.log = () => {};
      const exitCode = runOrPlanClaude({
        args: { execute: true, outputDir: dir, quotaStatePath, claudeBin: 'claude', inheritProviderAuth: false },
        env: {}, label: `issue-${issue}`, prompt: 'bounded regression fixture', claudeArgs: [],
        runPlan: { executionPhase: 'plan', executionAuthorization: { allowed: true }, costAdmission: { allowed: true } },
        processRunner: () => ({ status: 0, signal: null, stdout: stream, stderr: '', error: null }),
      });
      assert.equal(exitCode, 0);
      assert.equal(existsSync(quotaStatePath), false);
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('#658 captured array selects the terminal result and classifies max turns', () => {
  const envelope = parseClaudeResultEnvelope(capturedClaudeArray(658));
  assert.equal(envelope.parsed, true);
  assert.equal(envelope.subtype, 'error_max_turns');
  assert.equal(envelope.numTurns, 10);
  assert.equal(classifyClaudeRunFailure({ status: 1, resultEnvelope: envelope }), 'turn-limit-exhausted');
});

test('single-object JSON, JSONL and JSON-array envelopes select the terminal result', () => {
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 2 };
  const intermediate = { type: 'assistant', message: { content: [{ type: 'text', text: 'not terminal' }] } };
  for (const raw of [JSON.stringify(result), `${JSON.stringify(intermediate)}\n${JSON.stringify(result)}\n`, JSON.stringify([intermediate, result])]) {
    const parsed = parseClaudeResultEnvelope(raw);
    assert.equal(parsed.parsed, true);
    assert.equal(parsed.resultText, 'done');
    assert.equal(parsed.numTurns, 2);
  }
});

test('only allowlisted structured terminal provider errors classify quota and rate limiting', () => {
  const quota = parseClaudeResultEnvelope(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, provider_error: { code: 'quota_exhausted', retry_at: '2026-07-18T00:00:00Z', body: 'secret' } }));
  assert.equal(quota.structuredFailure, 'quota_exhausted');
  assert.equal(quota.retryAt, '2026-07-18T00:00:00Z');
  assert.equal(classifyClaudeRunFailure({ status: 1, resultEnvelope: quota }), 'quota_paused');
  assert.doesNotMatch(JSON.stringify(quota), /secret/);

  const rate = parseClaudeResultEnvelope(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, error: { code: 'rate_limited' } }));
  assert.equal(classifyClaudeRunFailure({ status: 1, resultEnvelope: rate }), 'rate_limited');
});

test('malformed textual terminal provider failure is not guessed as quota', () => {
  const envelope = parseClaudeResultEnvelope(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '429 quota_exceeded' }));
  assert.equal(envelope.structuredFailure, null);
  assert.equal(classifyClaudeRunFailure({ status: 1, resultEnvelope: envelope }), 'unknown_failure');
});

test('unparseable legacy text remains available for compatibility but has no accounting evidence', () => {
  const result = parseClaudeResultEnvelope('legacy text output');
  assert.equal(result.parsed, false);
  assert.equal(result.resultText, 'legacy text output');
  assert.equal(result.accountingAvailable, false);
});

test('classifyClaudeRunFailure prioritizes resumable plan state over a generic exit code', () => {
  assert.equal(
    classifyClaudeRunFailure({ status: 2, stdout: 'Plan written.', planProduced: true }),
    'awaiting-plan-approval',
  );
});

test('implementation cannot report another plan or no repository change as success', () => {
  assert.equal(classifyClaudeRunFailure({
    status: 0,
    planProduced: true,
    executionPhase: EXECUTION_PHASE_IMPLEMENTATION,
  }), 'implementation-returned-plan-only');
  assert.equal(classifyClaudeRunFailure({
    status: 0,
    executionPhase: EXECUTION_PHASE_IMPLEMENTATION,
    implementationEvidence: { failureReason: 'implementation-no-repository-change' },
  }), 'implementation-no-repository-change');
});

test('runner publishes only its exact committed worktree branch as a draft PR', () => {
  const calls = [];
  let listCount = 0;
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git') return { status: 0, stdout: '' };
    if (args[0] === 'pr' && args[1] === 'list') {
      listCount += 1;
      return {
        status: 0,
        stdout: listCount === 1 ? '[]' : JSON.stringify([{ number: 708, url: 'https://github.com/TheTekTeam/modelspend/pull/708', isDraft: true }]),
      };
    }
    if (args[0] === 'pr' && args[1] === 'create') return { status: 0, stdout: 'https://github.com/TheTekTeam/modelspend/pull/708\n' };
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = publishImplementationDraft({
    workspace: { worktreePath: '/tmp/worktree', baseRef: 'origin/main' },
    worktreeIdentity: { expectedBranch: 'worktree-agent-runner-658-77' },
    repo: 'TheTekTeam/modelspend',
    issueNumber: 658,
    issueTitle: 'Portable runner entrypoints',
    runner,
    env: {},
  });
  assert.equal(result.published, true);
  assert.equal(result.prNumber, 708);
  assert.deepEqual(calls[0], ['git', 'push', '--set-upstream', 'origin', 'worktree-agent-runner-658-77']);
  const create = calls.find((call) => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create');
  assert.ok(create.includes('--draft'));
  assert.ok(create.includes('TheTekTeam/modelspend'));
  assert.ok(create.includes('worktree-agent-runner-658-77'));
});

test('implementation workspace preparation proves fresh origin/main and exclusive branch ownership', () => {
  const runner = (_command, args) => {
    const joined = args.join(' ');
    if (joined === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
    if (joined === 'fetch --quiet origin main') return { status: 0, stdout: '' };
    if (joined === 'rev-parse origin/main') return { status: 0, stdout: 'base-sha\n' };
    if (joined === 'symbolic-ref refs/remotes/origin/HEAD') return { status: 0, stdout: 'refs/remotes/origin/main\n' };
    if (joined.startsWith('show-ref --verify --quiet')) return { status: 1, stdout: '' };
    if (joined === 'worktree list --porcelain') return { status: 0, stdout: 'worktree /repo\nHEAD base-sha\nbranch refs/heads/main\n' };
    if (joined === 'rev-parse HEAD') return { status: 0, stdout: 'base-sha\n' };
    if (joined === 'branch --show-current') return { status: 0, stdout: 'main\n' };
    if (joined === 'status --porcelain=v1 --untracked-files=no') return { status: 0, stdout: '' };
    return { status: 1, stdout: '', stderr: `unexpected: ${joined}` };
  };
  const result = prepareImplementationWorkspace({
    worktreeIdentity: { name: 'agent-runner-658-77', expectedBranch: 'worktree-agent-runner-658-77' },
    env: {},
    runner,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.baseHead, 'base-sha');
  assert.equal(result.rootBefore.branch, 'main');
  assert.equal(result.worktreePath, '/repo/.claude/worktrees/agent-runner-658-77');
});

function continuationWorktreeRunner({ worktreeHead = 'resume-sha' } = {}) {
  const worktreeList = 'worktree /repo\nHEAD base-sha\nbranch refs/heads/main\n\n'
    + 'worktree /repo/.claude/worktrees/agent-runner-698-41\nHEAD resume-sha\nbranch refs/heads/worktree-agent-runner-698-41\n';
  return (_command, args, options = {}) => {
    const joined = args.join(' ');
    const cwd = options.cwd;
    if (joined === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
    if (joined.startsWith('show-ref --verify --quiet')) return { status: 0, stdout: '' };
    if (joined === 'worktree list --porcelain') return { status: 0, stdout: worktreeList };
    if (cwd === '/repo/.claude/worktrees/agent-runner-698-41') {
      if (joined === 'rev-parse HEAD') return { status: 0, stdout: `${worktreeHead}\n` };
      if (joined === 'branch --show-current') return { status: 0, stdout: 'worktree-agent-runner-698-41\n' };
      if (joined === 'status --porcelain=v1 --untracked-files=all') return { status: 0, stdout: '' };
    }
    if (cwd === '/repo') {
      if (joined === 'rev-parse HEAD') return { status: 0, stdout: 'base-sha\n' };
      if (joined === 'branch --show-current') return { status: 0, stdout: 'main\n' };
      if (joined === 'status --porcelain=v1 --untracked-files=no') return { status: 0, stdout: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected: ${joined} (cwd=${cwd})` };
  };
}

test('continuation workspace preparation requires the exact preserved worktree/branch and never creates a new one', () => {
  const result = prepareContinuationWorkspace({
    worktreeIdentity: { name: 'agent-runner-698-41', expectedBranch: 'worktree-agent-runner-698-41' },
    env: {},
    runner: continuationWorktreeRunner(),
  });
  assert.equal(result.allowed, true);
  assert.equal(result.baseHead, 'resume-sha');
  assert.equal(result.rootBefore.branch, 'main');
  assert.equal(result.worktreePath, '/repo/.claude/worktrees/agent-runner-698-41');
});

test('continuation workspace preparation fails closed when the expected branch is missing', () => {
  const runner = (_command, args) => {
    const joined = args.join(' ');
    if (joined === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
    if (joined.startsWith('show-ref --verify --quiet')) return { status: 1, stdout: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  const result = prepareContinuationWorkspace({
    worktreeIdentity: { name: 'agent-runner-698-41', expectedBranch: 'worktree-agent-runner-698-41' },
    env: {},
    runner,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.failureReason, 'continuation-branch-missing');
});

test('continuation workspace preparation fails closed when the worktree entry is missing', () => {
  const runner = (_command, args) => {
    const joined = args.join(' ');
    if (joined === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
    if (joined.startsWith('show-ref --verify --quiet')) return { status: 0, stdout: '' };
    if (joined === 'worktree list --porcelain') return { status: 0, stdout: 'worktree /repo\nHEAD base-sha\nbranch refs/heads/main\n' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  const result = prepareContinuationWorkspace({
    worktreeIdentity: { name: 'agent-runner-698-41', expectedBranch: 'worktree-agent-runner-698-41' },
    env: {},
    runner,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.failureReason, 'continuation-worktree-missing');
});

test('continuation workspace preparation fails closed when the preserved worktree checked out a different branch', () => {
  const runner = continuationWorktreeRunner();
  const wrapped = (command, args, options = {}) => {
    if (args.join(' ') === 'branch --show-current' && options.cwd === '/repo/.claude/worktrees/agent-runner-698-41') {
      return { status: 0, stdout: 'some-other-branch\n' };
    }
    return runner(command, args, options);
  };
  const result = prepareContinuationWorkspace({
    worktreeIdentity: { name: 'agent-runner-698-41', expectedBranch: 'worktree-agent-runner-698-41' },
    env: {},
    runner: wrapped,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.failureReason, 'continuation-worktree-branch-mismatch');
});

test('classifyClaudeRunFailure emits stable process and fallback failure codes', () => {
  assert.equal(classifyClaudeRunFailure({ status: null, signal: 'SIGKILL' }), 'claude-killed-by-signal');
  assert.equal(classifyClaudeRunFailure({ status: 1, stderr: 'Unrecognized provider failure' }), 'claude-exit-1');
  assert.equal(classifyClaudeRunFailure({ status: 0, stdout: 'Implemented successfully with max budget USD 8.00.' }), null);
});

test('detectPlanOnlyResult flags the observed #580 plan-only stdout signature (permission-mode plan, exit 0, no code edits)', () => {
  const stdout = [
    'I have not made any code edits — only the plan file was written.',
    '',
    'Plan file: /home/gp/.claude/plans/start-a-fresh-task-drifting-seahorse.md',
  ].join('\n');
  const result = detectPlanOnlyResult({ stdout, stderr: '' });
  assert.equal(result.planProduced, true);
  assert.equal(result.planPath, '/home/gp/.claude/plans/start-a-fresh-task-drifting-seahorse.md');
});

test('detectPlanOnlyResult flags a plan file path even without the exact "no code edits" phrasing', () => {
  const result = detectPlanOnlyResult({ stdout: 'Plan written to /home/gp/.claude/plans/my-task-plan.md for review.', stderr: '' });
  assert.equal(result.planProduced, true);
  assert.equal(result.planPath, '/home/gp/.claude/plans/my-task-plan.md');
});

test('detectPlanOnlyResult flags the "no code edits" phrasing even without a discoverable plan path', () => {
  const result = detectPlanOnlyResult({ stdout: 'No code edits were made; awaiting plan approval.', stderr: '' });
  assert.equal(result.planProduced, true);
  assert.equal(result.planPath, null);
});

test('detectPlanOnlyResult does not flag a real implementation run', () => {
  const result = detectPlanOnlyResult({ stdout: 'Implemented the change and opened PR #123.\nFiles changed: src/index.ts', stderr: '' });
  assert.deepEqual(result, { planProduced: false, planPath: null });
});

test('detectPlanOnlyResult does not flag empty output (handled separately by detectExecutionNoop)', () => {
  assert.deepEqual(detectPlanOnlyResult({ stdout: '', stderr: '' }), { planProduced: false, planPath: null });
});

test('PLAN_ONLY_EXIT_CODE is a distinct non-zero exit code from the noop exit code', () => {
  assert.equal(PLAN_ONLY_EXIT_CODE, 2);
  assert.notEqual(PLAN_ONLY_EXIT_CODE, 0);
  assert.notEqual(PLAN_ONLY_EXIT_CODE, 1);
});

test('COST_POLICY_EXIT_CODE is a distinct terminal code', () => {
  assert.equal(COST_POLICY_EXIT_CODE, 3);
  assert.notEqual(COST_POLICY_EXIT_CODE, PLAN_ONLY_EXIT_CODE);
});

test('EXECUTION_POLICY_EXIT_CODE is distinct and fail-closed', () => {
  assert.equal(EXECUTION_POLICY_EXIT_CODE, 4);
  assert.notEqual(EXECUTION_POLICY_EXIT_CODE, COST_POLICY_EXIT_CODE);
});

test('quota admission blocks the observed 56% session by default and permits 49%', () => {
  assert.equal(DEFAULT_MAX_SESSION_USAGE_BEFORE_START_PERCENT, 50);
  const now = new Date('2026-07-15T20:36:00Z');
  const at56 = parseQuotaCheckOutput('Current session: 56% used\nCurrent week (all models): 5% used', { now });
  const at49 = parseQuotaCheckOutput('Current session: 49% used\nCurrent week (all models): 5% used', { now });
  assert.equal(at56.status, 'exhausted');
  assert.equal(at56.matchedPattern, 'claude-usage-current-session-above-start-threshold');
  assert.equal(at49.status, 'available');
});

test('quota admission threshold can be deliberately changed by machine policy', () => {
  const result = parseQuotaCheckOutput('Current session: 56% used', { maxSessionUsageBeforeStartPercent: '60' });
  assert.equal(result.status, 'available');
  assert.equal(result.maxSessionUsageBeforeStartPercent, 60);
});

test('findBlockingPrFollowUp returns null when no open PR is linked to the issue', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async (url) => {
    if (url.includes('/pulls?state=open')) {
      return { ok: true, json: async () => [{ number: 7, title: 'unrelated', body: 'no link', head: { ref: 'feature/other' } }] };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const blocking = await findBlockingPrFollowUp({ repo: 'TheTekTeam/modelspend', issue: 629, token: 'placeholder-token' });
  assert.equal(blocking, null);
});
