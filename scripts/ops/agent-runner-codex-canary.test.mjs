import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AGENT_ADAPTERS } from './agent-runner-agents.mjs';
import {
  buildCanaryCommandArgs,
  buildCanarySelection,
  CODEX_CANARY_DEFAULT_MODEL,
  CODEX_CANARY_EXPECTED_CONTENT,
  CODEX_CANARY_EXPECTED_FILE,
  validateCanaryWorkspace,
} from './agent-runner-codex-canary.mjs';

test('normal Codex catalogue remains disabled/non-routable while canary selector uses an in-memory projection', () => {
  assert.equal(AGENT_ADAPTERS['codex-cli'].implemented, false);
  assert.equal(AGENT_ADAPTERS['codex-cli'].command, null);

  const selection = buildCanarySelection({
    resourceState: { blocked: false },
    model: CODEX_CANARY_DEFAULT_MODEL,
  });

  assert.equal(selection.selectedAgentId, 'codex-cli');
  assert.equal(selection.reason, 'explicit-assignment-retained');
});


test('canary command is ephemeral, ignores ambient user config, denies network and requires the bounded profile', () => {
  const args = buildCanaryCommandArgs({
    executablePath: '/usr/local/bin/codex',
    cwd: '/tmp/codex-canary-worktree',
    model: CODEX_CANARY_DEFAULT_MODEL,
    effort: 'low',
    prompt: 'create the bounded fixture',
  });

  assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('workspace-write'));
  assert.ok(args.includes('approval_policy=never'));
  assert.ok(args.includes('model_reasoning_effort=low'));
  assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
});

test('canary selector fails closed when current quota resource state is blocked', () => {
  const selection = buildCanarySelection({
    resourceState: { blocked: true, reason: 'codex-quota-blocked' },
    model: CODEX_CANARY_DEFAULT_MODEL,
  });

  assert.equal(selection.selectedAgentId, null);
  assert.equal(selection.reason, 'no-qualified-agent');
  assert.ok(selection.decisions[0].reasons.includes('codex-quota-blocked'));
});

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-codex-canary-test-'));
  const git = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

  git(['init', '--quiet', '-b', 'main']);
  git(['config', 'user.email', 'runner@example.com']);
  git(['config', 'user.name', 'Runner Test']);
  writeFileSync(join(root, 'README.md'), 'seed\n');
  git(['add', 'README.md']);
  git(['commit', '--quiet', '-m', 'seed']);
  return { root, baseCommit: git(['rev-parse', 'HEAD']) };
}

test('workspace validation accepts only the exact one-file canary mutation with unchanged HEAD', () => {
  const { root, baseCommit } = createRepo();
  try {
    writeFileSync(join(root, CODEX_CANARY_EXPECTED_FILE), CODEX_CANARY_EXPECTED_CONTENT);
    const validation = validateCanaryWorkspace({ cwd: root, baseCommit });
    assert.equal(validation.ok, true);

    writeFileSync(join(root, 'README.md'), 'unexpected\n');
    const widened = validateCanaryWorkspace({ cwd: root, baseCommit });
    assert.equal(widened.ok, false);
    assert.equal(widened.exactExpectedDiff, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
