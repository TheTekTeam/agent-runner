import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISPATCH_FAILURE_SCOPE,
  isValidGitBranchName,
  resolveDispatchAuthority,
} from './agent-runner-dispatch-authority.mjs';

const FP = `sha256:${'a'.repeat(64)}`;
const BASE_COMMIT = 'dc534f1000f9cd4e1d9b4fb8ecb9427a7be2628d';
const RUNNER_CONFIG = { githubRepo: 'TheTekTeam/modelspend', localRepoPath: '/workspace/modelspend' };
const RUNNER_CHECKOUT = '/srv/agent-runner';

function packetBody({
  revision = 'AR56-IMPLEMENT-2026-07-23.1',
  fingerprint = FP,
  repositoryScopeLines = '  - TheTekTeam/agent-runner',
  branchLine = 'approved_branch: chatgpt/dispatch-workspace-authority',
  baseCommitLine = `base_commit: ${BASE_COMMIT}`,
  extraYaml = '',
  extraProse = '',
} = {}) {
  return `<!-- agent-runner:manager-preflight -->

\`\`\`yaml
schema_version: agent-runner-manager-preflight/v1
revision: ${revision}
fingerprint: ${fingerprint}
producer_type: normal_chatgpt_manager_session
approved_agent: claude-code-cli
execution_phase: implementation
approved_repository_scope:
${repositoryScopeLines}
${branchLine}
${baseCommitLine}
${extraYaml}scope:
  - bounded scope
required_validation:
  - node --test focused
stop_conditions:
  - stop on scope expansion
\`\`\`
${extraProse}`;
}

function preflight(overrides = {}) {
  return { id: 1, databaseId: 1, user: { login: 'gpcola' }, body: packetBody(overrides) };
}

test('exactly one canonical repository resolves that repository and its configured checkout', () => {
  const result = resolveDispatchAuthority({
    preflight: preflight(),
    argsRepo: 'TheTekTeam/agent-runner',
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.repository, 'TheTekTeam/agent-runner');
  assert.equal(result.checkout, RUNNER_CHECKOUT);
  assert.equal(result.branch, 'chatgpt/dispatch-workspace-authority');
  assert.equal(result.baseCommit, BASE_COMMIT);
  assert.equal(result.revision, 'AR56-IMPLEMENT-2026-07-23.1');
  assert.equal(result.fingerprint, FP);
});

test('missing repository scope fails closed', () => {
  const body = packetBody().replace(/approved_repository_scope:\n {2}- TheTekTeam\/agent-runner\n/, '');
  const result = resolveDispatchAuthority({ preflight: { body }, config: RUNNER_CONFIG, runnerCheckout: RUNNER_CHECKOUT });
  assert.equal(result.ok, false);
  assert.equal(result.failureScope, DISPATCH_FAILURE_SCOPE.ISSUE_NOT_RUNNABLE);
  assert.equal(result.failureReason, 'repository-scope-missing');
});

test('an empty repository-scope list fails closed as missing, not as a crash', () => {
  const result = resolveDispatchAuthority({
    preflight: preflight({ repositoryScopeLines: '' }),
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'repository-scope-missing');
});

test('multiple repository entries fail closed for a single-repository task', () => {
  const result = resolveDispatchAuthority({
    preflight: preflight({ repositoryScopeLines: '  - TheTekTeam/agent-runner\n  - TheTekTeam/modelspend' }),
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureScope, DISPATCH_FAILURE_SCOPE.ISSUE_NOT_RUNNABLE);
  assert.equal(result.failureReason, 'repository-scope-multiple');
});

test('a malformed repository entry fails closed', () => {
  const result = resolveDispatchAuthority({
    preflight: preflight({ repositoryScopeLines: '  - not-a-repo' }),
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'repository-scope-malformed');
});

test('canonical and legacy repository disagreement fails closed, never silently preferring one', () => {
  const result = resolveDispatchAuthority({
    preflight: preflight(),
    legacyMetadata: { implementation_repository: 'TheTekTeam/modelspend' },
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureScope, DISPATCH_FAILURE_SCOPE.ISSUE_NOT_RUNNABLE);
  assert.equal(result.failureReason, 'repository-scope-legacy-conflict');
});

test('a legacy repository field that agrees with the canonical entry is accepted', () => {
  const result = resolveDispatchAuthority({
    preflight: preflight(),
    legacyMetadata: { implementation_repository: 'TheTekTeam/agent-runner' },
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  });
  assert.equal(result.ok, true);
});

test('a canonical repository unknown to this machine fails closed as systemic, not issue content', () => {
  const result = resolveDispatchAuthority({
    preflight: preflight({ repositoryScopeLines: '  - TheTekTeam/some-other-repo' }),
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureScope, DISPATCH_FAILURE_SCOPE.SYSTEMIC);
});

test('approved_branch is preserved byte-for-byte, including slashes', () => {
  const result = resolveDispatchAuthority({
    preflight: preflight({ branchLine: 'approved_branch: chatgpt/dispatch-workspace-authority' }),
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.branch, 'chatgpt/dispatch-workspace-authority');
});

test('missing approved_branch fails closed for implementation', () => {
  const result = resolveDispatchAuthority({
    preflight: preflight({ branchLine: '' }),
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureScope, DISPATCH_FAILURE_SCOPE.ISSUE_NOT_RUNNABLE);
  assert.equal(result.failureReason, 'branch-authority-missing');
});

test('a malformed branch (invalid git ref) fails closed', () => {
  for (const branch of ['//leading-slash-collapsed', 'has a space', 'trailing-dot.', 'double//slash', '..escape', 'a.lock']) {
    const result = resolveDispatchAuthority({
      preflight: preflight({ branchLine: `approved_branch: ${branch}` }),
      config: RUNNER_CONFIG,
      runnerCheckout: RUNNER_CHECKOUT,
    });
    assert.equal(result.ok, false, `expected ${branch} to be rejected`);
    assert.equal(result.failureReason, 'branch-authority-malformed');
  }
});

test('canonical and legacy/generated branch disagreement fails closed', () => {
  const result = resolveDispatchAuthority({
    preflight: preflight(),
    legacyMetadata: { approved_branch: 'worktree-agent-runner-56-legacy' },
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureScope, DISPATCH_FAILURE_SCOPE.ISSUE_NOT_RUNNABLE);
  assert.equal(result.failureReason, 'branch-authority-legacy-conflict');
});

test('missing or malformed base_commit fails closed', () => {
  assert.equal(resolveDispatchAuthority({
    preflight: preflight({ baseCommitLine: '' }),
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  }).failureReason, 'base-commit-missing-or-malformed');
  assert.equal(resolveDispatchAuthority({
    preflight: preflight({ baseCommitLine: 'base_commit: not-a-sha' }),
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  }).failureReason, 'base-commit-missing-or-malformed');
});

test('missing or malformed revision/fingerprint fail closed', () => {
  assert.equal(resolveDispatchAuthority({
    preflight: preflight({ revision: '' }),
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  }).failureReason, 'revision-missing');
  assert.equal(resolveDispatchAuthority({
    preflight: preflight({ fingerprint: 'sha256:not-hex' }),
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  }).failureReason, 'fingerprint-missing-or-malformed');
});

test('isValidGitBranchName rejects the classic git-check-ref-format violations', () => {
  assert.equal(isValidGitBranchName('chatgpt/dispatch-workspace-authority'), true);
  assert.equal(isValidGitBranchName('claude/ollama-adapter-foundation-40'), true);
  assert.equal(isValidGitBranchName(''), false);
  assert.equal(isValidGitBranchName('/leading'), false);
  assert.equal(isValidGitBranchName('trailing/'), false);
  assert.equal(isValidGitBranchName('a//b'), false);
  assert.equal(isValidGitBranchName('a..b'), false);
  assert.equal(isValidGitBranchName('has space'), false);
  assert.equal(isValidGitBranchName('a.lock'), false);
  assert.equal(isValidGitBranchName('.hidden'), false);
  assert.equal(isValidGitBranchName('a~b'), false);
  assert.equal(isValidGitBranchName('a^b'), false);
  assert.equal(isValidGitBranchName('a:b'), false);
  assert.equal(isValidGitBranchName('a?b'), false);
  assert.equal(isValidGitBranchName('a*b'), false);
  assert.equal(isValidGitBranchName('a[b'), false);
});

test('a text-fence prose line outside the YAML packet never substitutes for the canonical fields', () => {
  const result = resolveDispatchAuthority({
    preflight: preflight({ extraProse: '\nUnrelated note: approved_branch: some-other-branch\n' }),
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.branch, 'chatgpt/dispatch-workspace-authority');
});

test('this function performs no I/O -- it is a pure computation over its inputs', () => {
  const first = resolveDispatchAuthority({ preflight: preflight(), config: RUNNER_CONFIG, runnerCheckout: RUNNER_CHECKOUT });
  const second = resolveDispatchAuthority({ preflight: preflight(), config: RUNNER_CONFIG, runnerCheckout: RUNNER_CHECKOUT });
  assert.deepEqual(first, second);
});

// #40 regression fixture: the exact packet that #40 was blocked on, and the
// exact fixture the #56 manager packet specifies. This is the failed-closed
// #40 dispatch #56 exists to correct: it proves the resolver now succeeds
// (repository/branch/checkout resolve correctly), not that it rejects, and
// -- because `resolveDispatchAuthority` performs no git/GitHub/model I/O --
// the mere act of calling it here is itself the proof of zero model calls,
// zero claims, zero attempts, and zero GitHub/workspace mutations during
// admission.
test('#40 regression fixture: resolves TheTekTeam/agent-runner and the exact approved branch with no generated branch, no ModelSpend fallback, and zero mutation during admission', () => {
  const issue40Packet = {
    id: 100040,
    databaseId: 100040,
    user: { login: 'gpcola' },
    body: `<!-- agent-runner:manager-preflight -->

\`\`\`yaml
schema_version: agent-runner-manager-preflight/v1
revision: AR40-FOUNDATION-2026-07-23.3
fingerprint: sha256:17622b3294f6cdd6055801b4ed38787a9f588aea211fc684148de3cad10e74e5
producer_type: chatgpt_scheduled_task
producer: ChatGPT
governing_issue: TheTekTeam/agent-runner#40
parent_issue: TheTekTeam/agent-runner#41
reliability_gate: TheTekTeam/agent-runner#5
approved_repository_scope:
  - TheTekTeam/agent-runner
approved_branch: claude/ollama-adapter-foundation-40
base_commit: dc534f1000f9cd4e1d9b4fb8ecb9427a7be2628d
approved_agent: claude-code-cli
execution_phase: implementation
profile: complex
scope:
  - Add generic adapter and normalized result contracts without changing existing Claude behaviour.
required_validation:
  - Run node --check for every changed executable JavaScript module.
stop_conditions:
  - Implementation requires enabling, routing or live-claiming through the Ollama adapter.
\`\`\`
`,
  };

  // This machine's default project config is ModelSpend (githubRepo:
  // 'TheTekTeam/modelspend'); the scheduler's own repository/branch
  // scope is 'TheTekTeam/modelspend' too (`argsRepo`). Only the runner's
  // own checkout registry entry (keyed by `runnerCheckout`) can supply
  // 'TheTekTeam/agent-runner' -- so a correct resolution here is proof
  // that fallback to the ModelSpend project/queue repository is
  // impossible, exactly as #56 requires.
  const result = resolveDispatchAuthority({
    preflight: issue40Packet,
    argsRepo: 'TheTekTeam/modelspend',
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  });

  assert.equal(result.ok, true, `expected #40's own packet to resolve; got ${result.failureReason}`);
  assert.equal(result.repository, 'TheTekTeam/agent-runner', 'resolved repository = TheTekTeam/agent-runner');
  assert.equal(result.checkout, RUNNER_CHECKOUT, 'resolved checkout = configured Agent Runner checkout');
  assert.equal(result.branch, 'claude/ollama-adapter-foundation-40', 'resolved branch = claude/ollama-adapter-foundation-40');
  assert.doesNotMatch(result.branch, /^worktree-/, 'generated branch = none');
  assert.notEqual(result.repository, 'TheTekTeam/modelspend', 'ModelSpend fallback = impossible');
  assert.equal(result.baseCommit, 'dc534f1000f9cd4e1d9b4fb8ecb9427a7be2628d');
  assert.equal(result.revision, 'AR40-FOUNDATION-2026-07-23.3');

  // Purity: `resolveDispatchAuthority` never imports node:child_process,
  // node:fs, or any GitHub client -- it cannot spawn a model, create a
  // claim/attempt, or mutate GitHub/the workspace. Calling it twice with
  // identical inputs and getting an identical result is itself evidence
  // of that: model call = 0, claim = 0, attempt = 0, GitHub mutation = 0,
  // workspace mutation = 0 during admission.
  const repeat = resolveDispatchAuthority({
    preflight: issue40Packet,
    argsRepo: 'TheTekTeam/modelspend',
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  });
  assert.deepEqual(result, repeat);
});

test('#56 regression: the actual authorising packet for this issue resolves to its own branch/repo/base-commit', () => {
  const issue56Packet = {
    id: 100056,
    databaseId: 100056,
    user: { login: 'gpcola' },
    body: `<!-- agent-runner:manager-preflight -->

\`\`\`yaml
schema_version: agent-runner-manager-preflight/v1
revision: AR56-IMPLEMENT-2026-07-23.1
fingerprint: sha256:2312b42eae25c5efac47cfcf1e454cdef7a2ec5684c42ca2e8dd6e4f6810b98e
producer_type: normal_chatgpt_manager_session
producer: ChatGPT
governing_issue: TheTekTeam/agent-runner#56
approved_repository_scope:
  - TheTekTeam/agent-runner
approved_branch: chatgpt/dispatch-workspace-authority
base_commit: dc534f1000f9cd4e1d9b4fb8ecb9427a7be2628d
approved_agent: claude-code-cli
execution_phase: implementation
scope:
  - Add one authoritative dispatch-resolution boundary.
required_validation:
  - Run npm test.
stop_conditions:
  - The implementation would rerun, claim or implement issue #40.
\`\`\`
`,
  };
  const result = resolveDispatchAuthority({
    preflight: issue56Packet,
    argsRepo: 'TheTekTeam/modelspend',
    config: RUNNER_CONFIG,
    runnerCheckout: RUNNER_CHECKOUT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.repository, 'TheTekTeam/agent-runner');
  assert.equal(result.branch, 'chatgpt/dispatch-workspace-authority');
  assert.equal(result.baseCommit, 'dc534f1000f9cd4e1d9b4fb8ecb9427a7be2628d');
  assert.equal(result.revision, 'AR56-IMPLEMENT-2026-07-23.1');
  assert.equal(result.fingerprint, 'sha256:2312b42eae25c5efac47cfcf1e454cdef7a2ec5684c42ca2e8dd6e4f6810b98e');
});
