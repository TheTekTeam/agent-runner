import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXECUTION_PHASE_IMPLEMENTATION,
  EXECUTION_PHASE_PLAN,
  IMPLEMENTATION_PERMISSION_MODE,
  buildImplementationToolPolicy,
  buildWorktreeIdentity,
  evaluateExecutionAuthorization,
  evaluateImplementationEvidence,
  fingerprintGitStatus,
  inspectClaudeCliHelp,
  inspectClaudeCliVersion,
  resolveRequestedExecutionPhase,
} from './claude-runner-execution-policy.mjs';
import { CAPABILITY_DEPENDENCY_AUDIT_READ } from './claude-runner-capability-model.mjs';

const PREFLIGHT = {
  id: 4985264598,
  body: '## Manager preflight packet\nImplement the bounded task.',
  user: { login: 'gpcola' },
};

test('ordinary approved work defaults to implementation while critical work defaults to plan', () => {
  assert.deepEqual(resolveRequestedExecutionPhase({ profileName: 'complex' }), {
    phase: EXECUTION_PHASE_IMPLEMENTATION,
    explicit: false,
    reason: 'approved-preflight-default',
    requestedValue: null,
  });
  assert.equal(resolveRequestedExecutionPhase({ profileName: 'critical' }).phase, EXECUTION_PHASE_PLAN);
  assert.equal(resolveRequestedExecutionPhase({ profileName: 'critical', metadata: { phase: 'implementation' } }).phase, EXECUTION_PHASE_IMPLEMENTATION);
  assert.equal(resolveRequestedExecutionPhase({ profileName: 'narrow', metadata: { execution_phase: 'plan' } }).phase, EXECUTION_PHASE_PLAN);
});

test('unsupported execution phases fail closed', () => {
  const result = resolveRequestedExecutionPhase({ profileName: 'narrow', metadata: { phase: 'bypassPermissions' } });
  assert.equal(result.phase, null);
  assert.equal(result.reason, 'unsupported-execution-phase');
});

test('implementation requires both machine opt-in and an allowlisted current preflight author', () => {
  const blocked = evaluateExecutionAuthorization({ currentPreflight: PREFLIGHT, profileName: 'complex', env: {} });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.violations.includes('implementation-requires-machine-opt-in'));
  assert.ok(blocked.violations.includes('manager-approver-allowlist-empty'));

  const allowed = evaluateExecutionAuthorization({
    currentPreflight: PREFLIGHT,
    profileName: 'complex',
    env: {
      CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true',
      CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola',
    },
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.permissionMode, IMPLEMENTATION_PERMISSION_MODE);
  assert.equal(allowed.preflightApprover, 'gpcola');
});

test('an issue comment cannot broaden permission mode or impersonate an approver', () => {
  const env = {
    CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true',
    CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola',
  };
  const result = evaluateExecutionAuthorization({
    command: { authorLogin: 'untrusted-user' },
    currentPreflight: PREFLIGHT,
    metadata: { phase: 'implementation', permission_mode: 'bypassPermissions' },
    profileName: 'complex',
    env,
  });
  assert.equal(result.allowed, false);
  assert.ok(result.violations.includes('comment-cannot-override-permission-mode'));
  assert.ok(result.violations.includes('command-author-not-allowlisted'));
});

test('runner-generated preflights are permanently prohibited for implementation', () => {
  const generated = { ...PREFLIGHT, body: `${PREFLIGHT.body}\n\n_Generated locally by the Dell runner_` };
  const env = {
    CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true',
    CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola',
  };
  const blocked = evaluateExecutionAuthorization({ currentPreflight: generated, profileName: 'narrow', env });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.violations.includes('runner-generated-manager-preflight-prohibited'));
  assert.equal(evaluateExecutionAuthorization({
    currentPreflight: generated,
    profileName: 'narrow',
    env: { ...env, CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION: 'true' },
  }).allowed, false, 'the retired compatibility variable cannot re-enable generated authority');
});

test('explicit plan skips write opt-in but still requires an allowlisted manager to prevent quota abuse', () => {
  const result = evaluateExecutionAuthorization({
    currentPreflight: PREFLIGHT,
    metadata: { phase: 'plan' },
    profileName: 'complex',
    env: { CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola' },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.phase, EXECUTION_PHASE_PLAN);
  assert.equal(result.permissionMode, 'plan');
});

test('worktree identity is deterministic and strips unsafe comment-id characters', () => {
  assert.deepEqual(buildWorktreeIdentity({ issueNumber: 658, sourceCommentId: 'IC_kwDO/unsafe value' }), {
    name: 'agent-runner-658-ic-kwdo-unsafe-value',
    expectedBranch: 'worktree-agent-runner-658-ic-kwdo-unsafe-value',
  });
});

test('#56: an authorised approved_branch is preserved byte-for-byte instead of the generated worktree-<name> scheme', () => {
  const identity = buildWorktreeIdentity({
    issueNumber: 56,
    sourceCommentId: 'IC_kwDO/unsafe value',
    approvedBranch: 'chatgpt/dispatch-workspace-authority',
  });
  assert.equal(identity.expectedBranch, 'chatgpt/dispatch-workspace-authority');
  // The worktree directory name is still deterministically derived and
  // generated -- only the Git branch is replaced by manager authority, so a
  // filesystem naming choice can never substitute for the authorised branch.
  assert.equal(identity.name, 'agent-runner-56-ic-kwdo-unsafe-value');
});

test('#56: without an approved_branch, buildWorktreeIdentity is unchanged (byte-for-byte backward compatible)', () => {
  assert.deepEqual(buildWorktreeIdentity({ issueNumber: 658, sourceCommentId: 'IC_kwDO/unsafe value' }), {
    name: 'agent-runner-658-ic-kwdo-unsafe-value',
    expectedBranch: 'worktree-agent-runner-658-ic-kwdo-unsafe-value',
  });
});

test('#56: implementation tool policy accepts an authorised approved branch containing slashes', () => {
  const policy = buildImplementationToolPolicy({
    expectedBranch: 'chatgpt/dispatch-workspace-authority',
    approvedBranch: 'chatgpt/dispatch-workspace-authority',
  });
  assert.ok(policy.allowedTools.includes('Read'));
  assert.equal(JSON.parse(policy.settings).permissions.disableBypassPermissionsMode, 'disable');
});

test('#56: an unauthorised branch is still rejected even when it merely resembles an approved form', () => {
  assert.throws(() => buildImplementationToolPolicy({ expectedBranch: 'main' }));
  assert.throws(() => buildImplementationToolPolicy({
    expectedBranch: 'some-other-branch',
    approvedBranch: 'chatgpt/dispatch-workspace-authority',
  }), /runner-owned worktree branch/);
});

test('implementation tool policy is explicit, branch-scoped, and never enables bypass', () => {
  const policy = buildImplementationToolPolicy({ expectedBranch: 'worktree-agent-runner-658-4985264598' });
  assert.deepEqual(policy.allowedTools.slice(0, 5), ['Read', 'Glob', 'Grep', 'Edit', 'Write']);
  assert.ok(policy.allowedTools.some((rule) => /git mv/.test(rule)));
  assert.ok(policy.allowedTools.every((rule) => !/git push|gh pr/.test(rule)));
  assert.ok(policy.disallowedTools.includes('Agent'));
  assert.ok(policy.disallowedTools.includes('mcp__*'));
  assert.ok(policy.disallowedTools.some((rule) => /git push/.test(rule)));
  assert.ok(policy.disallowedTools.includes('Bash(gh *)'));
  assert.doesNotMatch(`${policy.allowedTools.join(',')}${policy.settings}`, /bypassPermissions[^M]/);
  assert.equal(JSON.parse(policy.settings).permissions.disableBypassPermissionsMode, 'disable');
});

test('#228: buildImplementationToolPolicy stays baseline-compatible with no declared capabilities and grants only reviewed rules when declared', () => {
  const baseline = buildImplementationToolPolicy({ expectedBranch: 'worktree-agent-runner-658-4985264598' });
  assert.deepEqual([...baseline.grantedCapabilities], []);

  const withCapability = buildImplementationToolPolicy({
    expectedBranch: 'worktree-agent-runner-658-4985264598',
    requiredCapabilities: [CAPABILITY_DEPENDENCY_AUDIT_READ],
  });
  const added = withCapability.allowedTools.filter((rule) => !baseline.allowedTools.includes(rule));
  assert.deepEqual(added.sort(), ['Bash(npm audit *)', 'Bash(npm audit)', 'Bash(npm outdated *)', 'Bash(npm outdated)'].sort());
  assert.deepEqual([...withCapability.grantedCapabilities], [CAPABILITY_DEPENDENCY_AUDIT_READ]);
});

test('#228: buildImplementationToolPolicy fails closed on an unknown capability identifier', () => {
  assert.throws(
    () => buildImplementationToolPolicy({
      expectedBranch: 'worktree-agent-runner-658-4985264598',
      requiredCapabilities: ['not-a-real-capability'],
    }),
    /Unknown implementation capability/,
  );
});

test('installed CLI capability check requires every implementation safety flag, cache-stability flag, and dontAsk', () => {
  const help = '--permission-mode <mode> dontAsk --allowedTools <tools> --disallowedTools <tools> --tools <tools> --worktree <name> --output-format <format> --setting-sources <sources> --exclude-dynamic-system-prompt-sections';
  assert.deepEqual(inspectClaudeCliHelp(help, { exitCode: 0 }), { compatible: true, missing: [], helpExitCode: 0 });
  const missing = inspectClaudeCliHelp('--permission-mode plan', { exitCode: 0 });
  assert.equal(missing.compatible, false);
  assert.ok(missing.missing.includes('worktree'));
  assert.ok(missing.missing.includes('excludeDynamicSystemPromptSections'));
  assert.ok(missing.missing.includes('permissionMode:dontAsk'));
});

test('implementation admission version positively covers the cache-stability flag', () => {
  assert.deepEqual(inspectClaudeCliVersion('2.1.208 (Claude Code)', { exitCode: 0 }), {
    compatible: true,
    installedVersion: '2.1.208',
    minimumVersion: '2.1.208',
    dynamicSystemPromptExclusionSupported: true,
    versionExitCode: 0,
    failureReason: null,
  });
  const olderImplementation = inspectClaudeCliVersion('2.1.207', { exitCode: 0 });
  assert.equal(olderImplementation.failureReason, 'claude-version-too-old');
  assert.equal(olderImplementation.dynamicSystemPromptExclusionSupported, true);
  const beforeCacheFlag = inspectClaudeCliVersion('2.1.97', { exitCode: 0 });
  assert.equal(beforeCacheFlag.dynamicSystemPromptExclusionSupported, false);
  assert.equal(inspectClaudeCliVersion('not installed', { exitCode: 1 }).failureReason, 'claude-version-unavailable');
});

test('implementation evidence requires isolated worktree changes and an unchanged runner checkout', () => {
  const clean = fingerprintGitStatus('');
  const dirty = fingerprintGitStatus(' M scripts/ops/example.mjs\n');
  const root = { head: 'base', branch: 'main', ...clean };
  const base = {
    baseHead: 'base',
    rootBefore: root,
    rootAfter: { ...root },
    expectedBranch: 'worktree-agent-runner-658-source',
  };

  assert.equal(evaluateImplementationEvidence({
    ...base,
    worktree: { head: 'base', branch: base.expectedBranch, ...dirty },
  }).failureReason, 'implementation-uncommitted-changes');
  assert.deepEqual(evaluateImplementationEvidence({
    ...base,
    worktree: { head: 'commit', branch: base.expectedBranch, ...clean },
  }), { valid: true, changed: true, committed: true, clean: true, failureReason: null });
  assert.equal(evaluateImplementationEvidence({
    ...base,
    worktree: { head: 'commit', branch: base.expectedBranch, ...dirty },
  }).failureReason, 'implementation-worktree-dirty');
  assert.equal(evaluateImplementationEvidence({
    ...base,
    worktree: { head: 'base', branch: base.expectedBranch, ...clean },
  }).failureReason, 'implementation-no-repository-change');
  assert.equal(evaluateImplementationEvidence({
    ...base,
    rootAfter: { ...root, head: 'mutated-main' },
    worktree: { head: 'commit', branch: base.expectedBranch, ...clean },
  }).failureReason, 'runner-checkout-mutated');
  assert.equal(evaluateImplementationEvidence({
    ...base,
    worktree: { head: 'commit', branch: 'main', ...clean },
  }).failureReason, 'implementation-worktree-ownership-mismatch');
});
