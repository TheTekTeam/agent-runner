import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  changedWorktreePaths,
  normalizeAllowedPaths,
  parseOllamaRunnerArgs,
  pathAllowed,
} from './agent-runner-ollama-runner.mjs';

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-ollama-live-test-'));
  const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    assert.equal(run(['init', '-q']).status, 0);
    assert.equal(run(['config', 'user.email', 'test@example.invalid']).status, 0);
    assert.equal(run(['config', 'user.name', 'Test']).status, 0);
    writeFileSync(join(dir, 'tracked.mjs'), 'export const value = 1;\n');
    assert.equal(run(['add', 'tracked.mjs']).status, 0);
    assert.equal(run(['commit', '-qm', 'initial']).status, 0);
    return fn(dir, run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('#377 Ollama child requires explicit issue/repo/model and rejects recovery flags', () => {
  assert.deepEqual(
    parseOllamaRunnerArgs(['--issue', '377', '--repo', 'TheTekTeam/agent-runner', '--model', 'modelspend-code-local:latest']),
    {
      repo: 'TheTekTeam/agent-runner',
      outputDir: '.var/ollama-runner',
      execute: false,
      issue: 377,
      model: 'modelspend-code-local:latest',
      attemptId: null,
    },
  );
  assert.throws(
    () => parseOllamaRunnerArgs(['--issue', '377', '--repo', 'TheTekTeam/agent-runner', '--model', 'm', '--recovery-mode', 'native_resume']),
    /ollama-live-recovery-not-qualified/,
  );
});

test('#377 manager allowed paths are relative, bounded and cannot include .git or traversal', () => {
  assert.deepEqual(
    normalizeAllowedPaths(['scripts/ops/*.mjs', 'docs/ops/**']),
    { valid: true, paths: ['scripts/ops/*.mjs', 'docs/ops/**'], reason: null },
  );
  for (const value of [['../outside'], ['/etc/passwd'], ['.git/config'], ['src/a', 'src/a']]) {
    assert.equal(normalizeAllowedPaths(value).valid, false);
  }
  assert.equal(pathAllowed('scripts/ops/a.mjs', ['scripts/ops/*.mjs']), true);
  assert.equal(pathAllowed('scripts/ops/nested/a.mjs', ['scripts/ops/*.mjs']), false);
  assert.equal(pathAllowed('docs/ops/nested/a.md', ['docs/ops/**']), true);
  assert.equal(pathAllowed('../outside', ['**']), false);
});

test('#377 changed-path collection refuses model staging and returns tracked plus untracked edits', () => withRepo((dir, run) => {
  writeFileSync(join(dir, 'tracked.mjs'), 'export const value = 2;\n');
  writeFileSync(join(dir, 'new.test.mjs'), 'export {};\n');
  assert.deepEqual(changedWorktreePaths(dir), ['new.test.mjs', 'tracked.mjs']);

  assert.equal(run(['add', 'tracked.mjs']).status, 0);
  assert.throws(() => changedWorktreePaths(dir), /ollama-model-staged-changes-refused/);
}));
