import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  changedPathsFromWorktree,
  modelEnv,
  parseOllamaRunnerArgs,
} from './agent-runner-ollama-runner.mjs';
import { QUALIFIED_OLLAMA_CODING_MODEL } from './agent-runner-ollama-adapter.mjs';

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ollama-runner-test-'));
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    assert.equal(git(['init', '-q']).status, 0);
    assert.equal(git(['config', 'user.email', 'test@example.invalid']).status, 0);
    assert.equal(git(['config', 'user.name', 'Test']).status, 0);
    writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
    assert.equal(git(['add', 'a.mjs']).status, 0);
    assert.equal(git(['commit', '-qm', 'initial']).status, 0);
    return fn(dir, git);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('#376 live child requires the exact qualified model', () => {
  assert.equal(
    parseOllamaRunnerArgs([
      '--issue', '376',
      '--repo', 'TheTekTeam/agent-runner',
      '--model', QUALIFIED_OLLAMA_CODING_MODEL,
    ]).model,
    QUALIFIED_OLLAMA_CODING_MODEL,
  );
  assert.throws(
    () => parseOllamaRunnerArgs([
      '--issue', '376',
      '--repo', 'TheTekTeam/agent-runner',
      '--model', 'other-model',
    ]),
    /ollama-model-not-qualified-for-live-runner/,
  );
});

test('#376 live child rejects recovery surfaces', () => {
  assert.throws(
    () => parseOllamaRunnerArgs([
      '--issue', '376',
      '--repo', 'TheTekTeam/agent-runner',
      '--model', QUALIFIED_OLLAMA_CODING_MODEL,
      '--recovery-mode', 'native_resume',
    ]),
    /ollama-live-recovery-not-qualified/,
  );
});

test('#376 changed path evidence returns tracked and untracked edits and rejects staging', () => withRepo((dir, git) => {
  writeFileSync(join(dir, 'a.mjs'), 'export const a = 2;\n');
  writeFileSync(join(dir, 'b.test.mjs'), 'export {};\n');
  assert.deepEqual(changedPathsFromWorktree(dir), ['a.mjs', 'b.test.mjs']);
  assert.equal(git(['add', 'a.mjs']).status, 0);
  assert.throws(() => changedPathsFromWorktree(dir), /ollama-model-staged-changes-refused/);
}));


test('#376 model environment is positive-allowlisted with disposable HOME and no unrelated secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ollama-model-env-test-'));
  try {
    const result = modelEnv({
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      HOME: '/home/gp',
      GITHUB_TOKEN: 'ghp_must_not_survive',
      OPENAI_API_KEY: 'sk-must-not-survive',
      DATABASE_URL: 'postgres://must-not-survive',
      NODE_OPTIONS: '--require=/tmp/must-not-survive.cjs',
      RANDOM_SECRET: 'must-not-survive',
    }, '127.0.0.1', dir, '{"permission":{"*":"deny"}}');

    assert.equal(result.PATH, '/usr/bin');
    assert.equal(result.LANG, 'C.UTF-8');
    assert.notEqual(result.HOME, '/home/gp');
    assert.ok(result.HOME.startsWith(dir));
    assert.ok(result.TMPDIR.startsWith(dir));
    assert.equal(result.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(result.GITHUB_TOKEN, undefined);
    assert.equal(result.OPENAI_API_KEY, undefined);
    assert.equal(result.DATABASE_URL, undefined);
    assert.equal(result.NODE_OPTIONS, undefined);
    assert.equal(result.RANDOM_SECRET, undefined);
    assert.equal(result.OPENCODE_DISABLE_AUTOUPDATE, '1');
    assert.equal(result.NO_PROXY.includes('127.0.0.1'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
