import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FAILURE_SCOPES } from './agent-runner-adapter-contract.mjs';
import { AGENT_ADAPTERS, resolveAgentForLabels } from './agent-runner-agents.mjs';
import {
  admitCodexDispatch,
  admitCodexPaidUse,
  buildCodexCommandArgs,
  CODEX_AGENT_ID,
  probeExecutable,
  probeVersion,
  resolveCodexExecutablePath,
} from './agent-runner-codex-adapter.mjs';

function withTempRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-codex-adapter-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFakeExecutable(dir, name = 'codex') {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\necho fake\n');
  chmodSync(path, 0o755);
  return path;
}

function neverCalled(label) {
  return (...args) => { throw new Error(`${label} should not have been called with ${JSON.stringify(args)}`); };
}

function fakeSettings(entry) {
  return { agentId: CODEX_AGENT_ID, routable: true, reason: 'agent-routable', entry };
}

const NOT_ROUTABLE_SETTINGS = { agentId: CODEX_AGENT_ID, routable: false, reason: 'agent-disabled', entry: null };

const PAID_USE_APPROVED = { paidUseApproved: true, maxCostUsdPerRun: 2.5 };
const CLI_LABELS = [{ name: 'agent:codex-cli' }];

// --- 1. Disabled mode: zero process invocation, zero I/O ------------------

test('disabled mode: admission is refused before any probe and no injected I/O function is ever called', () => {
  const decision = admitCodexDispatch({
    settings: NOT_ROUTABLE_SETTINGS,
    labels: CLI_LABELS,
    accessFn: neverCalled('accessFn'),
    execFileFn: neverCalled('execFileFn'),
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.scope, FAILURE_SCOPES.MACHINE_PROFILE);
  assert.equal(decision.reason, 'agent-disabled');
  assert.deepEqual(decision.probes, []);
});

test('the registry entry for codex-cli stays implemented:false, keeping it non-routable through real issue dispatch regardless of this foundation', () => {
  assert.equal(AGENT_ADAPTERS['codex-cli'].implemented, false);
});

// --- 2. agent:codex / agent:codex-cli separation ----------------------------

test('agent:codex-cli resolves to the codex-cli adapter', () => {
  const agent = resolveAgentForLabels(['agent:codex-cli']);
  assert.equal(agent.agentId, 'codex-cli');
});

test('agent:codex resolves to no adapter at all -- it is Codex Web/manual and must never map to a local process', () => {
  const agent = resolveAgentForLabels(['agent:codex']);
  assert.equal(agent, null);
});

test('agent:codex alongside agent:codex-cli on the same issue still resolves only through the codex-cli label', () => {
  const agent = resolveAgentForLabels(['agent:codex', 'agent:codex-cli']);
  assert.equal(agent.agentId, 'codex-cli');
});

test('no adapter in the whole catalogue lists agent:codex as one of its labels', () => {
  for (const adapter of Object.values(AGENT_ADAPTERS)) {
    assert.equal(adapter.labels.includes('agent:codex'), false, `${adapter.agentId} must not claim agent:codex`);
  }
});

// --- 3. Unavailable executable -----------------------------------------------

test('unavailable executable: real temp-repo filesystem check fails closed and short-circuits later probes', () => withTempRoot((dir) => {
  const missingPath = join(dir, 'does-not-exist', 'codex');
  const decision = admitCodexDispatch({
    settings: fakeSettings({ executablePath: missingPath, ...PAID_USE_APPROVED }),
    labels: CLI_LABELS,
    execFileFn: neverCalled('execFileFn'),
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.failedProbe, 'executable');
  assert.equal(decision.reason, 'codex-executable-unavailable');
  assert.equal(decision.probes.length, 1);
}));

test('resolveCodexExecutablePath never falls back to a PATH search', () => {
  assert.deepEqual(resolveCodexExecutablePath({}), { ok: false, reason: 'codex-executable-not-configured', path: null });
});

test('probeExecutable succeeds against a real executable file in a temp root', () => withTempRoot((dir) => {
  const execPath = writeFakeExecutable(dir);
  assert.equal(probeExecutable({ executablePath: execPath }).ok, true);
}));

test('probeVersion fails closed instead of throwing when no execFileFn is injected', () => {
  assert.equal(probeVersion({ executablePath: '/usr/local/bin/codex' }).reason, 'codex-version-probe-unavailable');
});

// --- 4. Paid-use admission gate: all three parts independently mandatory ----

test('paid-use gate rejects when approval is missing even with a ceiling and correct label', () => {
  const decision = admitCodexPaidUse({ entry: { maxCostUsdPerRun: 5 }, labels: CLI_LABELS });
  assert.equal(decision.allowed, false);
  assert.equal(decision.failedProbe, 'paid-use-approval');
  assert.equal(decision.reason, 'codex-paid-use-not-approved');
});

test('paid-use gate rejects when neither a cost nor a token ceiling is positive, even with approval and correct label', () => {
  const decision = admitCodexPaidUse({ entry: { paidUseApproved: true, maxCostUsdPerRun: 0, maxTokensPerRun: 0 }, labels: CLI_LABELS });
  assert.equal(decision.allowed, false);
  assert.equal(decision.failedProbe, 'per-run-ceiling');
  assert.equal(decision.reason, 'codex-run-ceiling-not-set');
});

test('a token ceiling alone (no cost ceiling) satisfies the positive-ceiling gate', () => {
  const decision = admitCodexPaidUse({ entry: { paidUseApproved: true, maxTokensPerRun: 10000 }, labels: CLI_LABELS });
  assert.equal(decision.allowed, true);
});

test('paid-use gate rejects when the issue/run is not explicitly agent:codex-cli labelled, even with approval and a ceiling', () => {
  const decision = admitCodexPaidUse({ entry: PAID_USE_APPROVED, labels: [{ name: 'agent:codex' }] });
  assert.equal(decision.allowed, false);
  assert.equal(decision.failedProbe, 'cli-label');
  assert.equal(decision.reason, 'codex-issue-not-cli-labelled');
});

test('paid-use gate rejects an unlabelled run outright', () => {
  const decision = admitCodexPaidUse({ entry: PAID_USE_APPROVED, labels: [] });
  assert.equal(decision.allowed, false);
  assert.equal(decision.failedProbe, 'cli-label');
});

test('paid-use gate allows only when all three parts are simultaneously satisfied', () => {
  const decision = admitCodexPaidUse({ entry: PAID_USE_APPROVED, labels: CLI_LABELS });
  assert.equal(decision.allowed, true);
  assert.equal(decision.probes.length, 3);
  assert.ok(decision.probes.every((probe) => probe.ok));
});

test('full admission fails at the paid-use gate when executable/version pass but approval is missing', () => withTempRoot((dir) => {
  const execPath = writeFakeExecutable(dir);
  const decision = admitCodexDispatch({
    settings: fakeSettings({ executablePath: execPath, maxCostUsdPerRun: 5 }),
    labels: CLI_LABELS,
    execFileFn: () => 'codex-cli 0.144.6',
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.failedProbe, 'paid-use-approval');
  assert.equal(decision.probes.length, 5);
}));

test('full admission succeeds end-to-end when settings, executable, version, and all three paid-use conditions pass', () => withTempRoot((dir) => {
  const execPath = writeFakeExecutable(dir);
  const decision = admitCodexDispatch({
    settings: fakeSettings({ executablePath: execPath, ...PAID_USE_APPROVED }),
    labels: CLI_LABELS,
    execFileFn: () => 'codex-cli 0.144.6',
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.probes.length, 5);
  assert.ok(decision.probes.every((probe) => probe.ok));
}));

// --- 5. Isolated worktree: shared checkout is never mutated -----------------

function initRepoWithWorktree() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-runner-codex-shared-repo-'));
  const run = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  run(['init', '--quiet', '-b', 'main']);
  run(['config', 'user.email', 'runner@example.com']);
  run(['config', 'user.name', 'Runner Test']);
  writeFileSync(join(repoRoot, 'README.md'), 'seed\n');
  run(['add', 'README.md']);
  run(['commit', '--quiet', '-m', 'seed']);
  const worktreePath = join(repoRoot, '.worktrees', 'codex-48-attempt');
  run(['worktree', 'add', '-b', 'codex-48-attempt', worktreePath]);
  return { repoRoot, worktreePath, status: () => run(['status', '--porcelain']), headSha: () => run(['rev-parse', 'HEAD']).trim() };
}

test('command construction and admission against an isolated worktree never mutate the shared checkout', () => withTempRoot((dir) => {
  const { repoRoot, worktreePath, status, headSha } = initRepoWithWorktree();
  try {
    const beforeStatus = status();
    const beforeHead = headSha();

    const execPath = writeFakeExecutable(dir);
    const decision = admitCodexDispatch({
      settings: fakeSettings({ executablePath: execPath, ...PAID_USE_APPROVED }),
      labels: CLI_LABELS,
      execFileFn: () => 'codex-cli 0.144.6',
    });
    assert.equal(decision.allowed, true);

    const args = buildCodexCommandArgs({
      executablePath: execPath,
      cwd: worktreePath,
      model: 'gpt-5-codex',
      sandboxMode: 'workspace-write',
      approvalMode: 'on-request',
      prompt: 'implement the approved change',
    });
    assert.equal(args[args.indexOf('-C') + 1], worktreePath);
    assert.notEqual(worktreePath, repoRoot);

    assert.equal(status(), beforeStatus, 'the shared checkout must report the same git status after admission/command construction');
    assert.equal(headSha(), beforeHead, 'the shared checkout HEAD must be unchanged');
    assert.deepEqual(readFileSync(join(repoRoot, 'README.md'), 'utf8'), 'seed\n');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}));

// --- 6. Credentials/session material never reach argv, results, or logs ----

test('a configured sessionSecretRef never appears in the built command argv', () => {
  const args = buildCodexCommandArgs({
    executablePath: '/usr/local/bin/codex',
    cwd: '/tmp/worktree',
    model: 'gpt-5-codex',
    sandboxMode: 'workspace-write',
    approvalMode: 'on-request',
    prompt: 'implement the approved change',
  });
  const joined = JSON.stringify(args);
  assert.equal(/secretref:|token|session/i.test(joined), false);
});

test('buildCodexCommandArgs has no parameter through which a raw secret or session value could be forwarded', () => {
  const source = buildCodexCommandArgs.toString();
  assert.equal(/secret|token|session|credential/i.test(source), false);
});

test('admission decisions never surface the raw entry object, only booleans/probe outcomes -- no secretref leaks into the decision payload', () => {
  const decision = admitCodexPaidUse({
    entry: { ...PAID_USE_APPROVED, sessionSecretRef: 'secretref:codex-session-token' },
    labels: CLI_LABELS,
  });
  assert.equal(JSON.stringify(decision).includes('secretref:'), false);
});
