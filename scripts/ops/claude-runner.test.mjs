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
  assertConfiguredRepositoryIdentity,
  findBlockingPrFollowUp,
  findLatestClaudeCommand,
  findLatestClaudeContinueCommand,
  findLatestClaudeProceedCommand,
  hasManagerPreflight,
  inferProfile,
  implementationProcessCwd,
  latestManagerPreflightComment,
  nativeClaudeWorktreeName,
  parseArgs,
  parseClaudeResultEnvelope,
  parseKeyValueBlock,
  PLAN_ONLY_EXIT_CODE,
  PR_REVIEW_FOLLOWUP_MODE,
  prepareContinuationWorkspace,
  prepareImplementationWorkspace,
  publishImplementationDraft,
  publishPrContinuation,
  readQuotaPauseState,
  removedClaudeProviderAuthKeys,
  resolveImplementationDispatchIdentity,
  resolvePrExecutionBinding,
  resolveProfile,
  runOrPlanClaude,
  runPrFollowUp,
  shouldUseClear,
  writeQuotaPauseState,
} from './claude-runner.mjs';
import {
  DEFAULT_MAX_SESSION_USAGE_BEFORE_START_PERCENT,
  parseQuotaCheckOutput,
} from './claude-runner-quota.mjs';
import {
  RUNNER_OWN_REPOSITORY,
  resolveRepositoryContext,
} from './agent-runner-repository-context.mjs';

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
  const profile = { profile: 'complex', model: 'sonnet', effort: 'high' };

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
  const profile = { profile: 'narrow', model: 'sonnet', effort: 'medium' };
  const prompt = buildClaudePrompt({ issue, commandText: '## Claude proceed command\nDo the thing', profile, clearContext: false });
  assert.equal(prompt.startsWith('/clear'), false);
  assert.match(prompt, /Latest Claude command:/);
  assert.match(prompt, /Do the thing/);
});

test('buildClaudePrompt with clearContext uses a plain fresh-context instruction, not a slash command', () => {
  const issue = { number: 99, title: 'Legacy command issue' };
  const profile = { profile: 'narrow', model: 'sonnet', effort: 'medium' };
  const prompt = buildClaudePrompt({ issue, commandText: '## Claude proceed command\nDo the thing', profile, clearContext: true });
  assert.equal(prompt.startsWith('/clear'), false);
  assert.match(prompt, /^Start a fresh task context\./);
});

test('implementation prompt consumes the manager preflight as the plan and requires repository work', () => {
  const issue = { number: 658, title: 'Portable runner entrypoints' };
  const profile = { profile: 'complex', model: 'sonnet', effort: 'medium', permissionMode: 'dontAsk' };
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

// #686 regression: the standalone-runner acceptance canary for
// TheTekTeam/modelspend#686 generated an implementation prompt that told
// Claude "You are Claude Code CLI working on ModelSpend", injected
// ModelSpend's own repository instructions, and rooted the worktree/draft-PR
// in the ModelSpend checkout -- even though the preflight's own prose named
// the standalone runner checkout (/home/gp/projects/agent-runner) as the
// place the acceptance change belonged. Claude concluded it was working
// inside modelspend-runner-live and stopped with
// implementation-no-repository-change; no commit, PR or evidence was ever
// produced. This is the exact preflight-packet body the failing run
// consumed (comment github-comment:database:5029607103, cited by the
// runner-started marker posted immediately afterward).
const ISSUE_686_MANAGER_PREFLIGHT_BODY = [
  '## Manager preflight packet',
  '',
  '**Manager:** ChatGPT',
  '**Acceptance slice:** `RELIABILITY.RESET.1`',
  '**Phase:** implementation',
  '**Scope:** one bounded supervised acceptance run only.',
  '',
  '### Current state verified',
  '',
  '- The standalone runner checkout is `/home/gp/projects/agent-runner`.',
  '- Project config is `/home/gp/.config/agent-runner/modelspend.json`.',
  '- Runtime state is `/home/gp/.local/state/agent-runner/modelspend/runner-state.sqlite`.',
  '- The standalone dashboard publishes to `/var/www/agent-runner/dashboard`.',
  '- The previous attempted canary did not claim or execute this issue because it was `status:in-progress` without a current manager preflight.',
  '- Issue #686 has now been reset to `status:ready` specifically for this acceptance run.',
  '',
  '### Required work',
  '',
  'Run the smallest complete implementation/acceptance slice needed to prove the standalone runner’s normal execution path end to end for #686:',
  '',
  '1. work only in the runner-owned isolated worktree and branch;',
  '2. make one minimal, legitimate repository change that records or strengthens the standalone acceptance evidence for `RELIABILITY.RESET.1` without widening the architecture;',
  '3. run the directly mapped focused validation;',
  '4. commit the change on the exact runner-owned branch;',
  '5. allow the runner to push that branch and create exactly one draft PR;',
  '6. persist claim, implementation, publication, terminal-result and notification evidence;',
  '7. leave issue closure and merge to a human.',
  '',
  '### Boundaries',
  '',
  '- Do not redesign the runner or reopen completed migration work.',
  '- Do not change systemd units, timers, deployment, secrets, firewall, DNS, Grafana or Netdata configuration.',
  '- Do not enable either execution timer.',
  '- Do not modify the legacy runner checkout.',
  '- Do not merge, approve, close #686, or create more than one PR.',
  '- Stop and report a blocker if a minimal legitimate repository change cannot be identified within the existing acceptance/runner documentation or tests.',
].join('\n');

const ISSUE_686_PROJECT = {
  issueRepository: 'TheTekTeam/modelspend',
  projectRepository: 'TheTekTeam/modelspend',
  projectCheckout: '/home/gp/projects/modelspend-runner-live',
  runnerCheckout: '/home/gp/projects/agent-runner',
};

test('#686 regression: the actual fetched preflight text (no structured field) still defaults implementation to the configured project, not a guess', () => {
  const meta = parseKeyValueBlock(ISSUE_686_MANAGER_PREFLIGHT_BODY);
  // The real preflight only ever named the runner checkout in prose/bullets;
  // parseKeyValueBlock (the same parser used for Profile/Model/Effort today)
  // finds no machine-readable field there, so resolution must fall back to
  // the configured project rather than guessing from prose.
  assert.equal(meta.implementation_repository, undefined);

  const result = resolveRepositoryContext({ ...ISSUE_686_PROJECT, requestedImplementationRepository: meta.implementation_repository });
  assert.equal(result.allowed, true);
  assert.equal(result.context.implementationRepository, 'TheTekTeam/modelspend');

  const prompt = buildPreflightDirectPrompt({
    issue: { number: 686, title: 'OPS.AGENT.RUNNER.STANDALONE.REPO.1', body: 'Extract Agent Runner.' },
    preflight: { id: 5029607103, sourceCommentId: 5029607103, body: ISSUE_686_MANAGER_PREFLIGHT_BODY },
    profile: { profile: 'complex', model: 'sonnet', effort: 'medium' },
    clearContext: true,
    executionPhase: EXECUTION_PHASE_IMPLEMENTATION,
    worktreeIdentity: { name: 'agent-runner-686-5029607103', expectedBranch: 'worktree-agent-runner-686-5029607103' },
    repositoryContext: result.context,
  });
  assert.match(prompt, /You are Claude Code CLI working on TheTekTeam\/modelspend\./);
});

test('#686 regression: once the preflight names the runner repository explicitly, the prompt/worktree/instructions all resolve to Agent Runner and never claim ModelSpend', () => {
  const updatedBody = `${ISSUE_686_MANAGER_PREFLIGHT_BODY}\n\nImplementation repository: ${RUNNER_OWN_REPOSITORY}\n`;
  const meta = parseKeyValueBlock(updatedBody);
  assert.equal(meta.implementation_repository, RUNNER_OWN_REPOSITORY);

  const result = resolveRepositoryContext({ ...ISSUE_686_PROJECT, requestedImplementationRepository: meta.implementation_repository });
  assert.equal(result.allowed, true);
  assert.equal(result.context.implementationRepository, RUNNER_OWN_REPOSITORY);
  assert.equal(result.context.implementationCheckout, '/home/gp/projects/agent-runner');
  assert.deepEqual(result.context.implementationInstructionPaths, ['AGENTS.md']);
  // ModelSpend remains visible as the issue/project source, never overwritten
  assert.equal(result.context.issueRepository, 'TheTekTeam/modelspend');
  assert.equal(result.context.projectRepository, 'TheTekTeam/modelspend');

  const prompt = buildPreflightDirectPrompt({
    issue: { number: 686, title: 'OPS.AGENT.RUNNER.STANDALONE.REPO.1', body: 'Extract Agent Runner.' },
    preflight: { id: 5029607103, sourceCommentId: 5029607103, body: updatedBody },
    profile: { profile: 'complex', model: 'sonnet', effort: 'medium' },
    clearContext: true,
    executionPhase: EXECUTION_PHASE_IMPLEMENTATION,
    worktreeIdentity: { name: 'agent-runner-686-5029607103', expectedBranch: 'worktree-agent-runner-686-5029607103' },
    repositoryContext: result.context,
  });
  assert.match(prompt, /You are Claude Code CLI working on TheTekTeam\/agent-runner\./);
  assert.match(prompt, /Follow AGENTS\.md\./);
  assert.doesNotMatch(prompt, /working on ModelSpend/);
  assert.doesNotMatch(prompt, /docs\/claude\/README\.md/);
  // The issue itself is still ModelSpend's #686 -- only the implementation
  // repository identity changes, not the issue source.
  assert.match(prompt, /Issue: #686/);
});

test('buildClaudePrompt and buildPreflightDirectPrompt never say "working on ModelSpend" when the resolved implementation repository is Agent Runner', () => {
  const repositoryContext = {
    implementationRepository: RUNNER_OWN_REPOSITORY,
    implementationInstructionPaths: ['AGENTS.md'],
  };
  const issue = { number: 5, title: 'Simplify queue admission' };
  const profile = { profile: 'complex', model: 'sonnet', effort: 'medium' };

  const claudePrompt = buildClaudePrompt({ issue, commandText: '## Claude proceed command\nDo the thing', profile, clearContext: false, repositoryContext });
  const preflightPrompt = buildPreflightDirectPrompt({ issue, preflight: { id: 1, body: 'x' }, profile, clearContext: false, repositoryContext });
  for (const prompt of [claudePrompt, preflightPrompt]) {
    assert.doesNotMatch(prompt, /ModelSpend/);
    assert.match(prompt, /working on TheTekTeam\/agent-runner\./);
    assert.match(prompt, /Follow AGENTS\.md\./);
  }
});

test('prompts default to the historical ModelSpend instruction set when no repository context is supplied, preserving ordinary same-repository behaviour', () => {
  const issue = { number: 99, title: 'Legacy command issue' };
  const profile = { profile: 'narrow', model: 'sonnet', effort: 'medium' };
  const prompt = buildClaudePrompt({ issue, commandText: '## Claude proceed command\nDo the thing', profile, clearContext: false });
  assert.match(prompt, /Follow CLAUDE\.md\./);
  assert.match(prompt, /Follow docs\/claude\/README\.md\./);
  assert.match(prompt, /Follow docs\/ai\/AGENT-ORCHESTRATION-WORKFLOW\.md\./);
  assert.match(prompt, /Follow docs\/claude\/VALIDATION-GATES\.md\./);
});

test('generated issue-mode prompts never start with a literal /clear slash command, with or without clearContext', () => {
  const issue = { number: 641, title: 'Agent Runner v2', body: 'Implement preflight-direct dispatch.' };
  const preflight = { id: 12, sourceCommentId: 12, body: '## Manager preflight packet\nFiles checked by ChatGPT.' };
  const profile = { profile: 'complex', model: 'sonnet', effort: 'high' };

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
  assert.equal(Object.keys(profile).includes(['max', 'Turns'].join('')), false);
});

test('clear policy defaults to fresh context', () => {
  assert.equal(shouldUseClear({}), true);
  assert.equal(shouldUseClear({ resumeSession: 'issue-123' }), false);
  assert.equal(shouldUseClear({ noClear: true }), false);
});

test('Claude args include model and effort without interaction or dollar-budget caps', () => {
  const args = buildClaudeArgs({
    prompt: 'hello',
    profile: { model: 'sonnet', effort: 'medium', permissionMode: 'plan' },
  });
  assert.deepEqual(args.slice(0, -1), ['-p', '--model', 'sonnet', '--effort', 'medium', '--permission-mode', 'plan', '--output-format', 'json']);
  assert.equal(args.includes('--max-budget-usd'), false);
});

test('#86: approved branches use the runner-prepared worktree and never Claude native branch generation', () => {
  const approved = { name: 'agent-runner-743-github-comment-database-5079980543', expectedBranch: 'claude/supervised-canary-743' };
  assert.equal(nativeClaudeWorktreeName(approved), undefined);
  const args = buildClaudeArgs({
    prompt: 'implement',
    profile: { model: 'sonnet', effort: 'low', permissionMode: 'dontAsk', worktreeName: nativeClaudeWorktreeName(approved) },
  });
  assert.equal(args.includes('--worktree'), false);
  assert.equal(args.includes('--max-budget-usd'), false);

  const legacy = { name: 'agent-runner-658-source', expectedBranch: 'worktree-agent-runner-658-source' };
  assert.equal(nativeClaudeWorktreeName(legacy), legacy.name);
});

test('#86: worker cwd uses the approved runner-owned worktree and preserves legacy native worktree launch', () => {
  const approved = {
    rootPath: '/repo',
    worktreePath: '/repo/.claude/worktrees/agent-runner-743-github-comment-database-5079980543',
    workspacePreparedByRunner: true,
  };
  assert.equal(implementationProcessCwd(approved, '/fallback'), approved.worktreePath);

  const legacy = {
    rootPath: '/repo',
    worktreePath: '/repo/.claude/worktrees/agent-runner-658-source',
    workspacePreparedByRunner: false,
  };
  assert.equal(implementationProcessCwd(legacy, '/fallback'), legacy.rootPath);
  assert.equal(implementationProcessCwd(null, '/fallback'), '/fallback');
});

test('critical defaults select Sonnet/high without a monetary execution limit', () => {
  const profile = resolveProfile('critical');
  assert.equal(profile.model, 'sonnet');
  assert.equal(profile.effort, 'high');
  assert.equal(Object.keys(profile).includes(['max', 'Turns'].join('')), false);
  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'maxBudgetUsd'), false);
});

test('unattended admission rejects Opus/xhigh only for their explicit machine opt-ins', () => {
  const result = evaluateClaudeCostAdmission({ model: 'opus', effort: 'xhigh' }, {});
  assert.equal(result.allowed, false);
  assert.deepEqual(result.violations, [
    'opus-requires-explicit-machine-opt-in',
    'high-effort-requires-explicit-machine-opt-in',
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(result.requested, 'maxBudgetUsd'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.policy, 'maxBudgetUsd'), false);
});

test('unattended admission permits the critical default', () => {
  const result = evaluateClaudeCostAdmission(resolveProfile('critical'), {});
  assert.equal(result.allowed, true);
  assert.deepEqual(result.violations, []);
});

test('Opus/xhigh can be admitted only with their explicit machine-local opt-ins', () => {
  const result = evaluateClaudeCostAdmission(
    { model: 'opus', effort: 'xhigh' },
    {
      CLAUDE_RUNNER_ALLOW_OPUS: 'true',
      CLAUDE_RUNNER_ALLOW_XHIGH: 'true',
    },
  );
  assert.equal(result.allowed, true);
});

test('legacy manager max_budget_usd values cannot affect dispatch, profile resolution or admission', () => {
  const variants = [
    'max_budget_usd: 1.00',
    'max_budget_usd: 8.00',
    'max_budget_usd: "8.00"',
    'max_budget_usd: not-a-number',
    'max_budget_usd: 0',
    'max_budget_usd: -1.00',
    '',
  ];

  const fp = `sha256:${'b'.repeat(64)}`;
  const base = 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e';

  for (const legacyBudgetLine of variants) {
    const preflight = {
      id: 5310303832,
      databaseId: 5310303832,
      user: { login: 'gpcola' },
      body: `<!-- agent-runner:manager-preflight -->

\`\`\`yaml
schema_version: agent-runner-manager-preflight/v1
revision: AR264-DISPATCH-TEST-2026-08-19.1
fingerprint: ${fp}
producer_type: normal_chatgpt_manager_session
approved_agent: claude-code-cli
execution_phase: implementation
approved_repository_scope:
  - TheTekTeam/agent-runner
approved_branch: codex/remove-subscription-budget-caps-264
base_commit: ${base}
profile: complex
model: sonnet
effort: medium
${legacyBudgetLine}
scope:
  - bounded scope
required_validation:
  - node --test focused
stop_conditions:
  - stop on scope expansion
\`\`\`
`,
    };

    const dispatchIdentity = resolveImplementationDispatchIdentity({
      issue: { number: 264, title: 'Remove subscription budget caps', labels: [] },
      currentPreflight: preflight,
      config: { githubRepo: 'TheTekTeam/agent-runner', localRepoPath: '/workspace/agent-runner' },
      env: {
        CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true',
        CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola',
      },
      argsRepo: 'TheTekTeam/agent-runner',
    });

    assert.equal(dispatchIdentity.ok, true, dispatchIdentity.failureReason || legacyBudgetLine);
    assert.equal(Object.prototype.hasOwnProperty.call(dispatchIdentity.managerExecutionMeta, 'maxBudgetUsd'), false);

    const profile = resolveProfile(dispatchIdentity.profileName, {
      model: dispatchIdentity.managerExecutionMeta.model,
      effort: dispatchIdentity.managerExecutionMeta.effort,
    });

    assert.equal(Object.prototype.hasOwnProperty.call(profile, 'maxBudgetUsd'), false);

    const admission = evaluateClaudeCostAdmission(
      profile,
      { CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '0.01' },
    );
    assert.equal(admission.allowed, true);
    assert.equal(Object.prototype.hasOwnProperty.call(admission.policy, 'maxBudgetUsd'), false);
  }
});

test('the removed --max-budget-usd runner option is rejected instead of silently restoring a cap', () => {
  assert.throws(
    () => parseArgs(['--max-budget-usd', '1.00']),
    /Unknown argument: --max-budget-usd/,
  );
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
    if (url.includes('/graphql')) {
      return {
        ok: true,
        json: async () => ({
          data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const blocking = await findBlockingPrFollowUp({ repo: 'TheTekTeam/modelspend', issue: 629, token: 'placeholder-token' });
  assert.ok(blocking);
  assert.equal(blocking.pr.number, 42);
  assert.equal(blocking.unresolved.hasUnresolvedFollowUp, true);
});

test('findBlockingPrFollowUp treats an unresolved review thread as a trigger even with zero CHANGES_REQUESTED reviews', async (t) => {
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
      return { ok: true, json: async () => [{ user: { login: 'reviewer' }, state: 'COMMENTED', body: 'fyi', submitted_at: '2026-07-02T10:00:00Z' }] };
    }
    if (url.includes('/issues/42/comments')) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/pulls/42')) {
      return { ok: true, json: async () => ({ number: 42 }) };
    }
    if (url.includes('/graphql')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'thread-1',
                      isResolved: false,
                      comments: { nodes: [{ author: { login: 'reviewer' }, body: 'this needs a fix', createdAt: '2026-07-02T10:05:00Z' }] },
                    },
                  ],
                },
              },
            },
          },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const blocking = await findBlockingPrFollowUp({ repo: 'TheTekTeam/modelspend', issue: 629, token: 'placeholder-token' });
  assert.ok(blocking);
  assert.equal(blocking.unresolved.hasUnresolvedFollowUp, true);
  assert.ok(blocking.unresolved.reasons.some((r) => r.startsWith('unresolved-review-threads')));
  assert.equal(blocking.unresolved.unresolvedComments[0].body, 'this needs a fix');
});

test('findBlockingPrFollowUp fails closed when the review-thread GraphQL query fails, without returning null', async (t) => {
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
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/issues/42/comments')) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/pulls/42')) {
      return { ok: true, json: async () => ({ number: 42 }) };
    }
    if (url.includes('/graphql')) {
      return { ok: false, status: 502, statusText: 'Bad Gateway', text: async () => 'upstream error' };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  await assert.rejects(
    () => findBlockingPrFollowUp({ repo: 'TheTekTeam/modelspend', issue: 629, token: 'placeholder-token' }),
    /GitHub GraphQL request failed/,
  );
});

test('findBlockingPrFollowUp fails closed when GitHub reports more review-thread pages than the hard bounded-fetch limit', async (t) => {
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
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/issues/42/comments')) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/pulls/42')) {
      return { ok: true, json: async () => ({ number: 42 }) };
    }
    if (url.includes('/graphql')) {
      return {
        ok: true,
        json: async () => ({
          data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [] } } } },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  await assert.rejects(
    () => findBlockingPrFollowUp({ repo: 'TheTekTeam/modelspend', issue: 629, token: 'placeholder-token' }),
    /exceeding the hard bounded-fetch limit/,
  );
});

test('findBlockingPrFollowUp does not trigger on resolved-only threads with no CHANGES_REQUESTED review', async (t) => {
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
      return { ok: true, json: async () => [{ user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-07-02T10:00:00Z' }] };
    }
    if (url.includes('/issues/42/comments')) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/pulls/42')) {
      return { ok: true, json: async () => ({ number: 42 }) };
    }
    if (url.includes('/graphql')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    { id: 'thread-1', isResolved: true, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'was fine', createdAt: '2026-07-01T10:00:00Z' }] } },
                  ],
                },
              },
            },
          },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const blocking = await findBlockingPrFollowUp({ repo: 'TheTekTeam/modelspend', issue: 629, token: 'placeholder-token' });
  assert.equal(blocking, null);
});

test('findBlockingPrFollowUp does not trigger on a COMMENTED review alone with no unresolved threads', async (t) => {
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
      return { ok: true, json: async () => [{ user: { login: 'reviewer' }, state: 'COMMENTED', body: 'fyi', submitted_at: '2026-07-02T10:00:00Z' }] };
    }
    if (url.includes('/issues/42/comments')) {
      return { ok: true, json: async () => [{ user: { login: 'someone' }, body: 'just chatting', created_at: '2026-07-02T10:01:00Z' }] };
    }
    if (url.includes('/pulls/42')) {
      return { ok: true, json: async () => ({ number: 42 }) };
    }
    if (url.includes('/graphql')) {
      return {
        ok: true,
        json: async () => ({
          data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const blocking = await findBlockingPrFollowUp({ repo: 'TheTekTeam/modelspend', issue: 629, token: 'placeholder-token' });
  assert.equal(blocking, null);
});

test('findBlockingPrFollowUp bounds every review-thread comment body to a fixed character limit across multiple threads', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const oversizedBody = 'x'.repeat(5000);

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
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/issues/42/comments')) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/pulls/42')) {
      return { ok: true, json: async () => ({ number: 42 }) };
    }
    if (url.includes('/graphql')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    { id: 'thread-1', isResolved: false, comments: { nodes: [{ author: { login: 'reviewer-a' }, body: oversizedBody, createdAt: '2026-07-01T10:00:00Z' }] } },
                    { id: 'thread-2', isResolved: false, comments: { nodes: [{ author: { login: 'reviewer-b' }, body: 'short and unresolved', createdAt: '2026-07-01T11:00:00Z' }] } },
                  ],
                },
              },
            },
          },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const blocking = await findBlockingPrFollowUp({ repo: 'TheTekTeam/modelspend', issue: 629, token: 'placeholder-token' });
  assert.ok(blocking);
  assert.equal(blocking.unresolved.reasons.some((r) => r.startsWith('unresolved-review-threads:2')), true);
  const bodies = blocking.unresolved.unresolvedComments.map((c) => c.body);
  assert.ok(bodies.every((body) => body.length <= 2000));
  assert.ok(bodies.some((body) => body.includes('[truncated]')));
  assert.ok(bodies.some((body) => body === 'short and unresolved'));
});

test('runPrFollowUp triggers a direct --pr follow-up plan from an unresolved review thread', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const dir = mkdtempSync(join(tmpdir(), 'claude-runner-pr-followup-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });

  global.fetch = async (url) => {
    if (url.includes('/pulls/42/reviews')) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/issues/42/comments')) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/pulls/42')) {
      return {
        ok: true,
        json: async () => ({
          number: 42,
          title: 'Adapt runner',
          body: 'Fixes #629',
          html_url: 'https://github.com/TheTekTeam/modelspend/pull/42',
          head: { ref: 'claude/ops-claude-runner-dell-queue-629' },
        }),
      };
    }
    if (url.includes('/graphql')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    { id: 'thread-1', isResolved: false, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'this needs a fix', createdAt: '2026-07-02T10:05:00Z' }] } },
                  ],
                },
              },
            },
          },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const originalLog = console.log;
  let loggedOutput = '';
  console.log = (text) => { loggedOutput = text; };
  t.after(() => { console.log = originalLog; });

  const args = parseArgs(['--pr', '42', '--output-dir', dir]);
  const exitCode = await runPrFollowUp(args, {}, 'placeholder-token');
  assert.equal(exitCode, 0);

  const logged = JSON.parse(loggedOutput);
  assert.equal(logged.mode, 'pr-review-followup');
  assert.equal(logged.dryRun, true);
  assert.equal(logged.branch, 'claude/ops-claude-runner-dell-queue-629');
  assert.ok(logged.reasons.some((r) => r.startsWith('unresolved-review-threads')));
  assert.ok(existsSync(logged.logPath));
});

// #242: wire the accepted #241 PR-continuation binding into write-capable
// direct `--pr --execute` follow-up runs.
function mockPrFollowUpFetch({
  prNumber = 42,
  linkedIssue = 629,
  branch = 'claude/pr-continuation-fixture-629',
  reviewState = 'CHANGES_REQUESTED',
  unresolvedThread = true,
  // #242: author association is the trust signal that decides whether review
  // feedback may become executable continuation input. The default fixture
  // models a repository owner/collaborator, which is what a real manager
  // review is; tests that need the untrusted case override these.
  reviewAuthorAssociation = 'OWNER',
  threadAuthorAssociation = 'COLLABORATOR',
} = {}) {
  return async (url) => {
    if (url.includes(`/pulls/${prNumber}/reviews`)) {
      return {
        ok: true,
        json: async () => (reviewState ? [{ user: { login: 'owner' }, state: reviewState, submitted_at: '2026-08-20T10:00:00Z', body: 'please address this', author_association: reviewAuthorAssociation }] : []),
      };
    }
    if (url.includes(`/issues/${prNumber}/comments`)) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes(`/pulls/${prNumber}`)) {
      return {
        ok: true,
        json: async () => ({
          number: prNumber,
          state: 'open',
          title: 'PR continuation fixture',
          body: `Fixes #${linkedIssue}`,
          html_url: `https://github.com/TheTekTeam/modelspend/pull/${prNumber}`,
          head: { ref: branch, repo: { full_name: 'TheTekTeam/modelspend' }, sha: 'a'.repeat(40) },
        }),
      };
    }
    if (url.includes('/graphql')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false },
                  nodes: unresolvedThread
                    ? [{ id: 'thread-1', isResolved: false, comments: { nodes: [{ author: { login: 'reviewer' }, authorAssociation: threadAuthorAssociation, body: 'unresolved inline note', createdAt: '2026-08-20T10:05:00Z' }] } }]
                    : [],
                },
              },
            },
          },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

test('runPrFollowUp does not attempt continuation binding in dry-run preview', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = mockPrFollowUpFetch();
  const originalLog = console.log;
  console.log = () => {};
  t.after(() => { console.log = originalLog; });

  let bindingCalls = 0;
  const args = parseArgs(['--pr', '42']);
  const exitCode = await runPrFollowUp(args, {}, 'placeholder-token', {}, {
    resolveBinding: async () => { bindingCalls += 1; return { allowed: true }; },
  });
  assert.equal(exitCode, 0);
  assert.equal(bindingCalls, 0);
});

test('runPrFollowUp casual-comment no-op never attempts continuation binding even with --execute', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = mockPrFollowUpFetch({ reviewState: null, unresolvedThread: false });
  const originalLog = console.log;
  console.log = () => {};
  t.after(() => { console.log = originalLog; });

  let bindingCalls = 0;
  const args = parseArgs(['--pr', '42', '--execute']);
  const exitCode = await runPrFollowUp(args, {}, 'placeholder-token', {}, {
    resolveBinding: async () => { bindingCalls += 1; return { allowed: true }; },
  });
  assert.equal(exitCode, 0);
  assert.equal(bindingCalls, 0);
});

test('runPrFollowUp --execute blocks pre-provider when the #241 continuation binding refuses', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = mockPrFollowUpFetch();
  const originalLog = console.log;
  let loggedOutput = '';
  console.log = (text) => { loggedOutput = text; };
  t.after(() => { console.log = originalLog; });

  let bindingCalls = 0;
  let runCalls = 0;
  const args = parseArgs(['--pr', '42', '--execute']);
  const exitCode = await runPrFollowUp(args, {}, 'placeholder-token', {}, {
    resolveBinding: async (input) => {
      bindingCalls += 1;
      assert.equal(input.pullRequest.number, 42);
      assert.equal(input.repo, args.repo);
      return { allowed: false, failureReason: 'pr-continuation-worktree-dirty' };
    },
    run: () => { runCalls += 1; return 0; },
  });
  assert.equal(exitCode, EXECUTION_POLICY_EXIT_CODE);
  assert.equal(bindingCalls, 1);
  assert.equal(runCalls, 0);
  const logged = JSON.parse(loggedOutput);
  assert.equal(logged.blocked, true);
  assert.equal(logged.failureReason, 'pr-continuation-worktree-dirty');
});

test('runPrFollowUp --execute binds implementation phase to the exact authorised worktree and rejects caller widening', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = mockPrFollowUpFetch();
  const originalLog = console.log;
  console.log = () => {};
  t.after(() => { console.log = originalLog; });

  const worktreeIdentity = { name: 'pr-continuation-fixture-629', expectedBranch: 'claude/pr-continuation-fixture-629' };
  const binding = {
    allowed: true,
    prNumber: 42,
    issueNumber: 629,
    preRunHeadSha: 'a'.repeat(40),
    profileName: 'complex',
    managerExecutionMeta: { profile: 'complex', model: 'sonnet', effort: 'medium' },
    executionAuthorization: { allowed: true, phase: EXECUTION_PHASE_IMPLEMENTATION, permissionMode: 'dontAsk' },
    repositoryContext: { implementationRepository: 'TheTekTeam/modelspend', implementationCheckout: '/repo' },
    dispatchAuthority: { repository: 'TheTekTeam/modelspend', branch: worktreeIdentity.expectedBranch },
    worktreeIdentity,
  };

  let bindingCalls = 0;
  let capturedRunPlan = null;
  // A caller override attempting to widen model/effort must never reach the
  // bound-and-authorised runPlan.
  const args = parseArgs(['--pr', '42', '--execute', '--model', 'opus', '--effort', 'xhigh']);
  const exitCode = await runPrFollowUp(args, {}, 'placeholder-token', {}, {
    resolveBinding: async () => { bindingCalls += 1; return binding; },
    run: ({ runPlan }) => { capturedRunPlan = runPlan; return 0; },
  });
  assert.equal(exitCode, 0);
  assert.equal(bindingCalls, 1);
  assert.equal(capturedRunPlan.mode, PR_REVIEW_FOLLOWUP_MODE);
  assert.equal(capturedRunPlan.dryRun, false);
  assert.equal(capturedRunPlan.executionPhase, EXECUTION_PHASE_IMPLEMENTATION);
  assert.equal(capturedRunPlan.worktreeIdentity, worktreeIdentity);
  assert.equal(capturedRunPlan.prNumber, 42);
  assert.equal(capturedRunPlan.preRunHeadSha, binding.preRunHeadSha);
  // Same PR retained: the bound PR number is used, never a caller value that
  // could drift from the authorised continuation.
  assert.equal(capturedRunPlan.pr, 42);
  assert.equal(capturedRunPlan.profile.model, 'sonnet');
  assert.equal(capturedRunPlan.profile.effort, 'medium');
  assert.notEqual(capturedRunPlan.profile.model, 'opus');
  assert.notEqual(capturedRunPlan.profile.effort, 'xhigh');
});

test('#242: a bound --execute follow-up compiles the canonical implementation prompt and real cache metadata', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = mockPrFollowUpFetch();
  const originalLog = console.log;
  console.log = () => {};
  t.after(() => { console.log = originalLog; });

  const worktreeIdentity = { name: 'pr-continuation-fixture-629', expectedBranch: 'claude/pr-continuation-fixture-629' };
  const binding = {
    allowed: true,
    prNumber: 42,
    issueNumber: 629,
    repository: 'TheTekTeam/modelspend',
    branch: worktreeIdentity.expectedBranch,
    preRunHeadSha: 'a'.repeat(40),
    profileName: 'complex',
    managerExecutionMeta: { profile: 'complex', model: 'sonnet', effort: 'medium' },
    executionAuthorization: { allowed: true, phase: EXECUTION_PHASE_IMPLEMENTATION, permissionMode: 'dontAsk' },
    repositoryContext: { implementationRepository: 'TheTekTeam/modelspend', implementationCheckout: '/repo' },
    dispatchAuthority: { repository: 'TheTekTeam/modelspend', branch: worktreeIdentity.expectedBranch },
    worktreeIdentity,
    linkedIssue: { number: 629, title: 'linked issue', body: 'issue body' },
    authority: { revision: 'AR629.1' },
  };

  let captured = null;
  const args = parseArgs(['--pr', '42', '--execute']);
  const exitCode = await runPrFollowUp(args, {}, 'placeholder-token', {}, {
    resolveBinding: async () => binding,
    run: (input) => { captured = input; return 0; },
  });
  assert.equal(exitCode, 0);

  // The exact invariant whose absence caused the failed field acceptance.
  assert.match(captured.prompt, /Finish with a clean commit on that exact branch using `git commit --no-verify \.\.\.`/);
  assert.match(captured.prompt, /Execution phase: implementation/);
  assert.match(captured.prompt, /bounded correction input, not a new instruction set/);
  // The bounded, trusted review feedback is present as mutable evidence.
  assert.match(captured.prompt, /unresolved inline note/);
  assert.equal(captured.runPlan.promptContract, 'canonical-implementation');
  // The live failed run reported stablePrefixFingerprint: null.
  assert.match(captured.runPlan.promptCacheMetadata.stablePrefixFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(captured.runPlan.promptCacheMetadata.adapterId, 'claude-code-cli');
  assert.equal(captured.runPlan.executableReviewFeedback.instructionCount > 0, true);
  assert.equal(typeof captured.prePublicationCheck, 'function');
});

test('#242: an unresolved thread from an untrusted author never reaches binding or the provider', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = mockPrFollowUpFetch({ reviewState: null, threadAuthorAssociation: 'NONE' });
  const originalLog = console.log;
  console.log = () => {};
  t.after(() => { console.log = originalLog; });

  let bindingCalls = 0;
  let runCalls = 0;
  const args = parseArgs(['--pr', '42', '--execute']);
  const exitCode = await runPrFollowUp(args, {}, 'placeholder-token', {}, {
    resolveBinding: async () => { bindingCalls += 1; return { allowed: true }; },
    run: () => { runCalls += 1; return 0; },
  });
  assert.equal(exitCode, EXECUTION_POLICY_EXIT_CODE);
  assert.equal(bindingCalls, 0, 'an untrusted trigger must not cause a linked-issue read or worktree inspection');
  assert.equal(runCalls, 0);
});

const PR_CONTINUATION_FIXTURE_HEAD = 'c'.repeat(40);
const PR_CONTINUATION_STALE_HEAD = 'd'.repeat(40);

function pullRequestViewResult({ number = 42, state = 'OPEN', branch, headRefOid = PR_CONTINUATION_FIXTURE_HEAD, url }) {
  return {
    status: 0,
    stdout: JSON.stringify({
      number, state, headRefName: branch, headRefOid, url: url || `https://github.com/TheTekTeam/modelspend/pull/${number}`,
    }),
  };
}

function remoteRefResult(branch, sha) {
  return { status: 0, stdout: `${sha}\trefs/heads/${branch}\n` };
}

test('publishPrContinuation pushes only the existing branch and preserves the exact same open PR', () => {
  const branch = 'claude/pr-continuation-fixture-629';
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git' && args.join(' ') === 'branch --show-current') return { status: 0, stdout: `${branch}\n` };
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return { status: 0, stdout: `${PR_CONTINUATION_FIXTURE_HEAD}\n` };
    if (command === 'git' && args[0] === 'ls-remote') return remoteRefResult(branch, PR_CONTINUATION_FIXTURE_HEAD);
    if (command === 'git') return { status: 0, stdout: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return pullRequestViewResult({ branch, headRefOid: PR_CONTINUATION_FIXTURE_HEAD });
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = publishPrContinuation({
    workspace: { worktreePath: '/tmp/worktree' },
    worktreeIdentity: { expectedBranch: branch },
    repo: 'TheTekTeam/modelspend',
    prNumber: 42,
    runner,
    env: {},
  });
  assert.equal(result.published, true);
  assert.equal(result.prNumber, 42);
  assert.equal(result.headSha, PR_CONTINUATION_FIXTURE_HEAD);
  assert.ok(calls.some((call) => call.join(' ') === `git push origin ${branch}`));
  assert.equal(calls.some((call) => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create'), false);
  assert.equal(calls.filter((call) => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'view').length, 1, 'an immediate exact head must not perform unnecessary retries');
});

test('publishPrContinuation reconciles a stale headRefOid on the same PR within the bounded retry window', () => {
  const branch = 'claude/pr-continuation-fixture-629';
  let viewCalls = 0;
  const waits = [];
  const runner = (command, args) => {
    if (command === 'git' && args.join(' ') === 'branch --show-current') return { status: 0, stdout: `${branch}\n` };
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return { status: 0, stdout: `${PR_CONTINUATION_FIXTURE_HEAD}\n` };
    if (command === 'git' && args[0] === 'ls-remote') return remoteRefResult(branch, PR_CONTINUATION_FIXTURE_HEAD);
    if (command === 'git') return { status: 0, stdout: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      viewCalls += 1;
      const headRefOid = viewCalls === 1 ? PR_CONTINUATION_STALE_HEAD : PR_CONTINUATION_FIXTURE_HEAD;
      return pullRequestViewResult({ branch, headRefOid });
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = publishPrContinuation({
    workspace: { worktreePath: '/tmp/worktree', baseHead: PR_CONTINUATION_STALE_HEAD },
    worktreeIdentity: { expectedBranch: branch },
    repo: 'TheTekTeam/modelspend',
    prNumber: 42,
    runner,
    wait: (ms) => { waits.push(ms); },
    env: {},
  });
  assert.equal(result.published, true);
  assert.equal(result.headSha, PR_CONTINUATION_FIXTURE_HEAD);
  assert.equal(viewCalls, 2, 'must retry the same PR number after a stale head');
  assert.equal(waits.length, 1);
});

test('publishPrContinuation fails closed with one read and zero wait when the observed head is an unexpected third SHA', () => {
  const branch = 'claude/pr-continuation-fixture-629';
  const thirdHead = 'e'.repeat(40);
  let viewCalls = 0;
  const waits = [];
  const runner = (command, args) => {
    if (command === 'git' && args.join(' ') === 'branch --show-current') return { status: 0, stdout: `${branch}\n` };
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return { status: 0, stdout: `${PR_CONTINUATION_FIXTURE_HEAD}\n` };
    if (command === 'git' && args[0] === 'ls-remote') return remoteRefResult(branch, PR_CONTINUATION_FIXTURE_HEAD);
    if (command === 'git') return { status: 0, stdout: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      viewCalls += 1;
      return pullRequestViewResult({ branch, headRefOid: thirdHead });
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = publishPrContinuation({
    workspace: { worktreePath: '/tmp/worktree', baseHead: PR_CONTINUATION_STALE_HEAD },
    worktreeIdentity: { expectedBranch: branch },
    repo: 'TheTekTeam/modelspend',
    prNumber: 42,
    runner,
    wait: (ms) => { waits.push(ms); },
    env: {},
  });
  assert.equal(result.published, false);
  assert.equal(result.failureReason, 'pr-continuation-publication-head-mismatch');
  assert.equal(result.expectedHeadSha, PR_CONTINUATION_FIXTURE_HEAD);
  assert.equal(result.observedHeadSha, thirdHead);
  assert.equal(viewCalls, 1, 'an unexpected third SHA is a real mismatch, not propagation lag, and must not be retried');
  assert.equal(waits.length, 0);
});

test('publishPrContinuation fails closed immediately when the remote branch ref advances away from committed HEAD during the retry window', () => {
  const branch = 'claude/pr-continuation-fixture-629';
  let viewCalls = 0;
  let lsRemoteCalls = 0;
  const waits = [];
  const advancedHead = 'f'.repeat(40);
  const runner = (command, args) => {
    if (command === 'git' && args.join(' ') === 'branch --show-current') return { status: 0, stdout: `${branch}\n` };
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return { status: 0, stdout: `${PR_CONTINUATION_FIXTURE_HEAD}\n` };
    if (command === 'git' && args[0] === 'ls-remote') {
      lsRemoteCalls += 1;
      const sha = lsRemoteCalls === 1 ? PR_CONTINUATION_FIXTURE_HEAD : advancedHead;
      return remoteRefResult(branch, sha);
    }
    if (command === 'git') return { status: 0, stdout: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      viewCalls += 1;
      return pullRequestViewResult({ branch, headRefOid: PR_CONTINUATION_STALE_HEAD });
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = publishPrContinuation({
    workspace: { worktreePath: '/tmp/worktree', baseHead: PR_CONTINUATION_STALE_HEAD },
    worktreeIdentity: { expectedBranch: branch },
    repo: 'TheTekTeam/modelspend',
    prNumber: 42,
    runner,
    wait: (ms) => { waits.push(ms); },
    env: {},
  });
  assert.equal(result.published, false);
  assert.equal(result.failureReason, 'pr-continuation-publication-remote-ref-mismatch');
  assert.equal(result.stage, 'remote-ref-retry');
  assert.equal(result.expectedHeadSha, PR_CONTINUATION_FIXTURE_HEAD);
  assert.equal(result.observedHeadSha, advancedHead);
  assert.equal(viewCalls, 1, 'must fail immediately once the remote ref advances away, not continue retrying');
  assert.equal(waits.length, 0);
});

test('publishPrContinuation fails closed when the pushed branch ref is not yet reflected remotely', () => {
  const branch = 'claude/pr-continuation-fixture-629';
  const runner = (command, args) => {
    if (command === 'git' && args.join(' ') === 'branch --show-current') return { status: 0, stdout: `${branch}\n` };
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return { status: 0, stdout: `${PR_CONTINUATION_FIXTURE_HEAD}\n` };
    if (command === 'git' && args[0] === 'ls-remote') return remoteRefResult(branch, PR_CONTINUATION_STALE_HEAD);
    if (command === 'git') return { status: 0, stdout: '' };
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = publishPrContinuation({
    workspace: { worktreePath: '/tmp/worktree' },
    worktreeIdentity: { expectedBranch: branch },
    repo: 'TheTekTeam/modelspend',
    prNumber: 42,
    runner,
    env: {},
  });
  assert.equal(result.published, false);
  assert.equal(result.failureReason, 'pr-continuation-publication-remote-ref-mismatch');
});

test('publishPrContinuation fails closed with a truthful head-mismatch after the retry bound is exhausted', () => {
  const branch = 'claude/pr-continuation-fixture-629';
  let viewCalls = 0;
  const waits = [];
  const runner = (command, args) => {
    if (command === 'git' && args.join(' ') === 'branch --show-current') return { status: 0, stdout: `${branch}\n` };
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return { status: 0, stdout: `${PR_CONTINUATION_FIXTURE_HEAD}\n` };
    if (command === 'git' && args[0] === 'ls-remote') return remoteRefResult(branch, PR_CONTINUATION_FIXTURE_HEAD);
    if (command === 'git') return { status: 0, stdout: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      viewCalls += 1;
      return pullRequestViewResult({ branch, headRefOid: PR_CONTINUATION_STALE_HEAD });
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = publishPrContinuation({
    workspace: { worktreePath: '/tmp/worktree', baseHead: PR_CONTINUATION_STALE_HEAD },
    worktreeIdentity: { expectedBranch: branch },
    repo: 'TheTekTeam/modelspend',
    prNumber: 42,
    runner,
    wait: (ms) => { waits.push(ms); },
    env: {},
  });
  assert.equal(result.published, false);
  assert.equal(result.failureReason, 'pr-continuation-publication-head-mismatch');
  assert.equal(result.expectedHeadSha, PR_CONTINUATION_FIXTURE_HEAD);
  assert.equal(result.observedHeadSha, PR_CONTINUATION_STALE_HEAD);
  assert.ok(viewCalls >= 2 && viewCalls <= 5, 'retries must be bounded, not indefinite');
  assert.equal(waits.length, viewCalls - 1);
});

test('publishPrContinuation fails closed instead of creating a replacement PR when the PR number changed', () => {
  const branch = 'claude/pr-continuation-fixture-629';
  let viewCalls = 0;
  const runner = (command, args) => {
    if (command === 'git' && args.join(' ') === 'branch --show-current') return { status: 0, stdout: `${branch}\n` };
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return { status: 0, stdout: `${PR_CONTINUATION_FIXTURE_HEAD}\n` };
    if (command === 'git' && args[0] === 'ls-remote') return remoteRefResult(branch, PR_CONTINUATION_FIXTURE_HEAD);
    if (command === 'git') return { status: 0, stdout: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      viewCalls += 1;
      return pullRequestViewResult({ number: 99, branch, headRefOid: PR_CONTINUATION_FIXTURE_HEAD });
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = publishPrContinuation({
    workspace: { worktreePath: '/tmp/worktree' },
    worktreeIdentity: { expectedBranch: branch },
    repo: 'TheTekTeam/modelspend',
    prNumber: 42,
    runner,
    env: {},
  });
  assert.equal(result.published, false);
  assert.equal(result.failureReason, 'pr-continuation-publication-pr-number-changed');
  assert.equal(viewCalls, 1, 'an identity change must fail immediately, not be retried as propagation lag');
});

test('publishPrContinuation fails closed when the published head does not equal the committed worktree HEAD', () => {
  const branch = 'claude/pr-continuation-fixture-629';
  const runner = (command, args) => {
    if (command === 'git' && args.join(' ') === 'branch --show-current') return { status: 0, stdout: `${branch}\n` };
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return { status: 0, stdout: `${PR_CONTINUATION_FIXTURE_HEAD}\n` };
    if (command === 'git' && args[0] === 'ls-remote') return remoteRefResult(branch, PR_CONTINUATION_FIXTURE_HEAD);
    if (command === 'git') return { status: 0, stdout: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return pullRequestViewResult({ branch, headRefOid: PR_CONTINUATION_STALE_HEAD });
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = publishPrContinuation({
    workspace: { worktreePath: '/tmp/worktree' },
    worktreeIdentity: { expectedBranch: branch },
    repo: 'TheTekTeam/modelspend',
    prNumber: 42,
    runner,
    maxAttempts: 1,
    env: {},
  });
  assert.equal(result.published, false);
  assert.equal(result.failureReason, 'pr-continuation-publication-head-mismatch');
});

test('publishPrContinuation fails closed when the PR is no longer open, without creating a replacement', () => {
  const branch = 'claude/pr-continuation-fixture-629';
  let viewCalls = 0;
  const runner = (command, args) => {
    if (command === 'git' && args.join(' ') === 'branch --show-current') return { status: 0, stdout: `${branch}\n` };
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return { status: 0, stdout: `${PR_CONTINUATION_FIXTURE_HEAD}\n` };
    if (command === 'git' && args[0] === 'ls-remote') return remoteRefResult(branch, PR_CONTINUATION_FIXTURE_HEAD);
    if (command === 'git') return { status: 0, stdout: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      viewCalls += 1;
      return pullRequestViewResult({ state: 'CLOSED', branch, headRefOid: PR_CONTINUATION_FIXTURE_HEAD });
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = publishPrContinuation({
    workspace: { worktreePath: '/tmp/worktree' },
    worktreeIdentity: { expectedBranch: branch },
    repo: 'TheTekTeam/modelspend',
    prNumber: 42,
    runner,
    env: {},
  });
  assert.equal(result.published, false);
  assert.equal(result.failureReason, 'pr-continuation-publication-pr-not-open');
  assert.equal(viewCalls, 1, 'a closed PR must fail immediately, not be retried as propagation lag');
});

test('publishPrContinuation fails closed when a final remote-ref check differs after a transient matching PR view', () => {
  const branch = 'claude/pr-continuation-fixture-629';
  let lsRemoteCalls = 0;
  const runner = (command, args) => {
    if (command === 'git' && args.join(' ') === 'branch --show-current') return { status: 0, stdout: `${branch}\n` };
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return { status: 0, stdout: `${PR_CONTINUATION_FIXTURE_HEAD}\n` };
    if (command === 'git' && args[0] === 'ls-remote') {
      lsRemoteCalls += 1;
      const sha = lsRemoteCalls === 1 ? PR_CONTINUATION_FIXTURE_HEAD : PR_CONTINUATION_STALE_HEAD;
      return remoteRefResult(branch, sha);
    }
    if (command === 'git') return { status: 0, stdout: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return pullRequestViewResult({ branch, headRefOid: PR_CONTINUATION_FIXTURE_HEAD });
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = publishPrContinuation({
    workspace: { worktreePath: '/tmp/worktree' },
    worktreeIdentity: { expectedBranch: branch },
    repo: 'TheTekTeam/modelspend',
    prNumber: 42,
    runner,
    env: {},
  });
  assert.equal(result.published, false);
  assert.equal(result.failureReason, 'pr-continuation-publication-head-mismatch');
  assert.equal(result.stage, 'remote-ref-final');
  assert.equal(lsRemoteCalls, 2, 'must re-check the remote ref both before reconciliation and immediately before success');
});

test('publishPrContinuation push failure remains a push failure without any PR reconciliation', () => {
  const branch = 'claude/pr-continuation-fixture-629';
  let viewCalls = 0;
  let lsRemoteCalls = 0;
  const runner = (command, args) => {
    if (command === 'git' && args.join(' ') === 'branch --show-current') return { status: 0, stdout: `${branch}\n` };
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return { status: 0, stdout: `${PR_CONTINUATION_FIXTURE_HEAD}\n` };
    if (command === 'git' && args[0] === 'push') return { status: 1, stdout: '', stderr: 'push rejected' };
    if (command === 'git' && args[0] === 'ls-remote') { lsRemoteCalls += 1; return remoteRefResult(branch, PR_CONTINUATION_FIXTURE_HEAD); }
    if (command === 'git') return { status: 0, stdout: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') { viewCalls += 1; return pullRequestViewResult({ branch, headRefOid: PR_CONTINUATION_FIXTURE_HEAD }); }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = publishPrContinuation({
    workspace: { worktreePath: '/tmp/worktree' },
    worktreeIdentity: { expectedBranch: branch },
    repo: 'TheTekTeam/modelspend',
    prNumber: 42,
    runner,
    env: {},
  });
  assert.equal(result.published, false);
  assert.equal(result.failureReason, 'pr-continuation-branch-push-failed');
  assert.equal(lsRemoteCalls, 0, 'a push failure must never trigger PR reconciliation reads');
  assert.equal(viewCalls, 0, 'a push failure must never trigger PR reconciliation reads');
});


test('findBlockingPrFollowUp fails closed when bounded review-thread state is structurally incomplete', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async (url, options = {}) => {
    if (url.includes('/pulls?state=open')) {
      return {
        ok: true,
        json: async () => [
          { number: 42, title: 'Adapt runner', body: 'no keyword', head: { ref: 'claude/ops-claude-runner-dell-queue-629' } },
        ],
      };
    }
    if (url.includes('/pulls/42/reviews')) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/issues/42/comments')) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/pulls/42')) {
      return { ok: true, json: async () => ({ number: 42 }) };
    }
    if (url.includes('/graphql')) {
      const request = JSON.parse(options.body);
      assert.match(request.query, /reviewThreads\(first: 50\)/);
      assert.match(request.query, /comments\(last: 20\)/);
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false },
                  // nodes intentionally absent: this is not reliable
                  // evidence that the PR has zero review threads.
                },
              },
            },
          },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  await assert.rejects(
    () => findBlockingPrFollowUp({
      repo: 'TheTekTeam/modelspend',
      issue: 629,
      token: 'placeholder-token',
    }),
    /missing bounded reviewThreads state/,
  );
});

test('findBlockingPrFollowUp fails closed when a review thread lacks explicit resolution state', async (t) => {
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
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/issues/42/comments')) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/pulls/42')) {
      return { ok: true, json: async () => ({ number: 42 }) };
    }
    if (url.includes('/graphql')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    {
                      id: 'thread-1',
                      // isResolved intentionally absent.
                      comments: {
                        nodes: [
                          {
                            author: { login: 'reviewer' },
                            body: 'action required',
                            createdAt: '2026-07-02T10:05:00Z',
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  await assert.rejects(
    () => findBlockingPrFollowUp({
      repo: 'TheTekTeam/modelspend',
      issue: 629,
      token: 'placeholder-token',
    }),
    /malformed review thread/,
  );
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
    'provider-execution-limit',
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
  assert.equal(classifyClaudeRunFailure({ status: 1, resultEnvelope: envelope }), 'provider-execution-limit');
});

function capturedClaudeArray(issue) {
  return readFileSync(new URL(`./fixtures/claude-event-array-${issue}.json`, import.meta.url), 'utf8');
}

for (const issue of [299, 550]) {
  test(`#${issue} captured array regression: repository quota strings and allowed rate-limit events are not provider exhaustion`, async () => {
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
      const exitCode = await runOrPlanClaude({
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
  assert.equal(classifyClaudeRunFailure({ status: 1, resultEnvelope: envelope }), 'provider-execution-limit');
});

test('#206: error_max_budget_usd result envelope classifies as the exact structured budget reason, distinct from quota/max-turns', () => {
  const envelope = { subtype: 'error_max_budget_usd', isError: true };
  assert.equal(classifyClaudeRunFailure({ status: 1, resultEnvelope: envelope }), 'budget-limit-exhausted');
  assert.notEqual(classifyClaudeRunFailure({ status: 1, resultEnvelope: envelope }), 'unknown_failure');
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

test('#86: runner publishes the exact manager-approved branch as a draft PR', () => {
  const calls = [];
  let listCount = 0;
  const branch = 'claude/supervised-canary-743';
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git' && args.join(' ') === 'branch --show-current') return { status: 0, stdout: `${branch}\n` };
    if (command === 'git') return { status: 0, stdout: '' };
    if (args[0] === 'pr' && args[1] === 'list') {
      listCount += 1;
      return { status: 0, stdout: listCount === 1 ? '[]' : JSON.stringify([{ number: 708, url: 'https://github.com/TheTekTeam/modelspend/pull/708', isDraft: true }]) };
    }
    if (args[0] === 'pr' && args[1] === 'create') return { status: 0, stdout: 'https://github.com/TheTekTeam/modelspend/pull/708\n' };
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = publishImplementationDraft({
    workspace: { worktreePath: '/tmp/worktree', baseRef: 'origin/main' },
    worktreeIdentity: { expectedBranch: branch },
    repo: 'TheTekTeam/modelspend',
    issueNumber: 743,
    issueTitle: 'Supervised canary',
    runner,
    env: {},
  });
  assert.equal(result.published, true);
  assert.equal(result.prNumber, 708);
  assert.ok(calls.some((call) => call.join(' ') === `git push --set-upstream origin ${branch}`));
  const create = calls.find((call) => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create');
  assert.ok(create.includes('--draft'));
  assert.ok(create.includes(branch));
});

test('#86: publication rejects an actual worktree branch that differs from manager authority', () => {
  const result = publishImplementationDraft({
    workspace: { worktreePath: '/tmp/worktree', baseRef: 'origin/main' },
    worktreeIdentity: { expectedBranch: 'claude/supervised-canary-743' },
    repo: 'TheTekTeam/modelspend',
    issueNumber: 743,
    runner: (command, args) => {
      if (command === 'git' && args[0] === 'check-ref-format') return { status: 0, stdout: '' };
      if (command === 'git' && args.join(' ') === 'branch --show-current') return { status: 0, stdout: 'worktree-agent-runner-743-generated\n' };
      return { status: 1, stdout: '' };
    },
  });
  assert.equal(result.published, false);
  assert.equal(result.failureReason, 'implementation-publication-branch-mismatch');
});

test('draft publication targets the resolved implementation repository, not just whatever "repo" happens to be passed', () => {
  const calls = [];
  let listCount = 0;
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git' && args.join(' ') === 'branch --show-current') return { status: 0, stdout: 'worktree-agent-runner-686-x\n' };
    if (command === 'git') return { status: 0, stdout: '' };
    if (args[0] === 'pr' && args[1] === 'list') {
      listCount += 1;
      return {
        status: 0,
        stdout: listCount === 1 ? '[]' : JSON.stringify([{ number: 42, url: 'https://github.com/TheTekTeam/agent-runner/pull/42', isDraft: true }]),
      };
    }
    if (args[0] === 'pr' && args[1] === 'create') return { status: 0, stdout: 'https://github.com/TheTekTeam/agent-runner/pull/42\n' };
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = publishImplementationDraft({
    workspace: { worktreePath: '/home/gp/projects/agent-runner/.claude/worktrees/agent-runner-686-x', baseRef: 'origin/main' },
    worktreeIdentity: { expectedBranch: 'worktree-agent-runner-686-x' },
    repo: RUNNER_OWN_REPOSITORY,
    issueNumber: 686,
    issueTitle: 'OPS.AGENT.RUNNER.STANDALONE.REPO.1',
    runner,
    env: {},
  });
  assert.equal(result.published, true);
  const create = calls.find((call) => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create');
  assert.ok(create.includes(RUNNER_OWN_REPOSITORY));
  assert.ok(!create.includes('TheTekTeam/modelspend'));
});

test('implementation workspace preparation roots the worktree at an explicit implementationCheckout, not the runner process\'s ambient cwd', () => {
  const seenCwds = [];
  const runner = (_command, args, options = {}) => {
    const joined = args.join(' ');
    seenCwds.push({ joined, cwd: options.cwd });
    if (joined === 'rev-parse --show-toplevel') return { status: 0, stdout: '/home/gp/projects/agent-runner\n' };
    if (joined === 'fetch --quiet origin main') return { status: 0, stdout: '' };
    if (joined === 'rev-parse origin/main') return { status: 0, stdout: 'base-sha\n' };
    if (joined === 'symbolic-ref refs/remotes/origin/HEAD') return { status: 0, stdout: 'refs/remotes/origin/main\n' };
    if (joined.startsWith('show-ref --verify --quiet')) return { status: 1, stdout: '' };
    if (joined === 'worktree list --porcelain') return { status: 0, stdout: 'worktree /home/gp/projects/agent-runner\nHEAD base-sha\nbranch refs/heads/main\n' };
    if (joined === 'rev-parse HEAD') return { status: 0, stdout: 'base-sha\n' };
    if (joined === 'branch --show-current') return { status: 0, stdout: 'main\n' };
    if (joined === 'status --porcelain=v1 --untracked-files=no') return { status: 0, stdout: '' };
    return { status: 1, stdout: '', stderr: `unexpected: ${joined}` };
  };
  const result = prepareImplementationWorkspace({
    worktreeIdentity: { name: 'agent-runner-686-x', expectedBranch: 'worktree-agent-runner-686-x' },
    implementationCheckout: '/home/gp/projects/agent-runner',
    env: {},
    runner,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.rootPath, '/home/gp/projects/agent-runner');
  assert.equal(result.worktreePath, '/home/gp/projects/agent-runner/.claude/worktrees/agent-runner-686-x');
  // The very first git call (the one that discovers the repository root)
  // must search from the explicit implementationCheckout, not resolve('.').
  assert.equal(seenCwds[0].joined, 'rev-parse --show-toplevel');
  assert.equal(seenCwds[0].cwd, '/home/gp/projects/agent-runner');
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

test('#86: exact #743 approved branch is created in the deterministic worktree before worker launch', (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-runner-86-approved-branch-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const calls = [];
  const branch = 'claude/supervised-canary-743';
  const name = 'agent-runner-743-github-comment-database-5079980543';
  const worktreePath = `${repoRoot}/.claude/worktrees/${name}`;
  const base = 'fb83e1c8ec6a918c100f0278a4aacc67f89560a9';
  const runner = (_command, args, options = {}) => {
    const joined = args.join(' ');
    calls.push({ joined, cwd: options.cwd });
    if (joined === 'rev-parse --show-toplevel') return { status: 0, stdout: `${repoRoot}\n` };
    if (joined === 'fetch --quiet origin main') return { status: 0, stdout: '' };
    if (joined === 'rev-parse origin/main') return { status: 0, stdout: `${base}\n` };
    if (joined === 'symbolic-ref refs/remotes/origin/HEAD') return { status: 0, stdout: 'refs/remotes/origin/main\n' };
    if (joined.startsWith('show-ref --verify --quiet')) return { status: 1, stdout: '' };
    if (joined === 'worktree list --porcelain') return { status: 0, stdout: `worktree ${repoRoot}\nHEAD ${base}\nbranch refs/heads/main\n` };
    if (options.cwd === `${repoRoot}` && joined === 'rev-parse HEAD') return { status: 0, stdout: `${base}\n` };
    if (options.cwd === `${repoRoot}` && joined === 'branch --show-current') return { status: 0, stdout: 'main\n' };
    if (options.cwd === `${repoRoot}` && joined === 'status --porcelain=v1 --untracked-files=no') return { status: 0, stdout: '' };
    if (joined === `check-ref-format --branch ${branch}`) return { status: 0, stdout: '' };
    if (joined === `worktree add --quiet -b ${branch} ${worktreePath} ${base}`) return { status: 0, stdout: '' };
    if (options.cwd === worktreePath && joined === 'rev-parse HEAD') return { status: 0, stdout: `${base}\n` };
    if (options.cwd === worktreePath && joined === 'branch --show-current') return { status: 0, stdout: `${branch}\n` };
    if (options.cwd === worktreePath && joined === 'status --porcelain=v1 --untracked-files=all') return { status: 0, stdout: '' };
    return { status: 1, stdout: '', stderr: `unexpected: ${joined} cwd=${options.cwd}` };
  };
  const result = prepareImplementationWorkspace({ worktreeIdentity: { name, expectedBranch: branch }, env: {}, runner });
  assert.equal(result.allowed, true);
  assert.equal(result.workspacePreparedByRunner, true);
  assert.equal(result.worktreePath, worktreePath);
  assert.ok(calls.some((call) => call.joined === `worktree add --quiet -b ${branch} ${worktreePath} ${base}`));
  assert.equal(calls.some((call) => call.joined.includes('worktree-agent-runner-743')), false);
});

function continuationWorktreeRunner({ worktreeHead = 'resume-sha' } = {}) {
  const worktreeList = `worktree /repo\nHEAD base-sha\nbranch refs/heads/main\n\n`
    + `worktree /repo/.claude/worktrees/agent-runner-698-41\nHEAD resume-sha\nbranch refs/heads/worktree-agent-runner-698-41\n`;
  return (_command, args, options = {}) => {
    const joined = args.join(' ');
    const cwd = options.cwd;
    if (joined === 'rev-parse --show-toplevel') return { status: 0, stdout: `/repo\n` };
    if (joined.startsWith('show-ref --verify --quiet')) return { status: 0, stdout: '' };
    if (joined === 'worktree list --porcelain') return { status: 0, stdout: worktreeList };
    if (cwd === `/repo/.claude/worktrees/agent-runner-698-41`) {
      if (joined === 'rev-parse HEAD') return { status: 0, stdout: `${worktreeHead}\n` };
      if (joined === 'branch --show-current') return { status: 0, stdout: 'worktree-agent-runner-698-41\n' };
      if (joined === 'status --porcelain=v1 --untracked-files=all') return { status: 0, stdout: '' };
    }
    if (cwd === `/repo`) {
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
  assert.equal(result.workspacePreparedByRunner, false);
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


test('#180: configured repository identity is authoritative over explicit --repo', () => {
  const config = { githubRepo: 'TheTekTeam/agent-runner' };

  assert.doesNotThrow(() => assertConfiguredRepositoryIdentity({
    configPath: '/tmp/agent-runner.json',
    config,
    repo: 'TheTekTeam/agent-runner',
  }));

  assert.throws(
    () => assertConfiguredRepositoryIdentity({
      configPath: '/tmp/agent-runner.json',
      config,
      repo: 'TheTekTeam/modelspend',
    }),
    /does not match configured repository/,
  );

  // Direct CLI compatibility without --config remains unchanged.
  assert.doesNotThrow(() => assertConfiguredRepositoryIdentity({
    configPath: null,
    config,
    repo: 'TheTekTeam/modelspend',
  }));
});

test('#180: parseArgs uses configured repository as its default without disabling direct CLI --repo parsing', () => {
  assert.equal(
    parseArgs([], { defaultRepo: 'TheTekTeam/agent-runner' }).repo,
    'TheTekTeam/agent-runner',
  );
  assert.equal(
    parseArgs(
      ['--repo', 'TheTekTeam/modelspend'],
      { defaultRepo: 'TheTekTeam/agent-runner' },
    ).repo,
    'TheTekTeam/modelspend',
  );
});
