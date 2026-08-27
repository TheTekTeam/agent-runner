import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBoundedOllamaCodingPrompt,
  changedPathsFromPorcelainZ,
  isSafeOllamaWorkerPath,
  resolveBoundedOllamaManagerContract,
} from './agent-runner-ollama-worker-contract.mjs';

function packet({
  scope = ['file: src/add.mjs', 'task: Correct the arithmetic operator used by add.'],
  validation = ['node --test test/add.test.mjs'],
} = {}) {
  return [
    '<!-- agent-runner:manager-preflight -->',
    '',
    '```yaml',
    'schema_version: agent-runner-manager-preflight/v1',
    'revision: AR376.TEST.1',
    'fingerprint: sha256:' + 'a'.repeat(64),
    'producer_type: normal_chatgpt_manager_session',
    'approved_agent: ollama-agent',
    'execution_phase: implementation',
    'profile: local-low-risk',
    'model: modelspend-code-local:latest',
    'scope:',
    ...scope.map((item) => '  - ' + item),
    'required_validation:',
    ...validation.map((item) => '  - ' + item),
    'stop_conditions:',
    '  - stop on scope expansion',
    '```',
  ].join('\n');
}

test('accepts one explicit file, one bounded task and bounded validation list', () => {
  const result = resolveBoundedOllamaManagerContract(packet({
    validation: ['node --test test/add.test.mjs', 'git diff --no-ext-diff --check'],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.filePath, 'src/add.mjs');
  assert.equal(result.task, 'Correct the arithmetic operator used by add.');
  assert.deepEqual([...result.validationCommands], [
    'node --test test/add.test.mjs',
    'git diff --no-ext-diff --check',
  ]);
});

test('rejects arbitrary scope, multiple files and missing validation', () => {
  assert.equal(resolveBoundedOllamaManagerContract(packet({
    scope: ['bounded implementation work', 'task: Fix it'],
  })).reason, 'ollama-manager-scope-shape-unsupported');

  assert.equal(resolveBoundedOllamaManagerContract(packet({
    scope: ['file: src/a.mjs', 'file: src/b.mjs', 'task: Fix both'],
  })).reason, 'ollama-manager-scope-shape-unsupported');

  assert.equal(resolveBoundedOllamaManagerContract(packet({ validation: [] })).reason, 'ollama-manager-validation-shape-unsupported');
});

test('safe path grammar rejects traversal, hidden roots, absolute paths and spaces', () => {
  for (const value of [
    '../secret',
    '.git/config',
    '/etc/passwd',
    'src/../secret',
    'src/file name.mjs',
    'src\\file.mjs',
  ]) assert.equal(isSafeOllamaWorkerPath(value), false, value);

  assert.equal(isSafeOllamaWorkerPath('src/lib/add.test.mjs'), true);
});

test('prompt exposes only bounded target/task and exact admitted commands', () => {
  const prompt = buildBoundedOllamaCodingPrompt({
    filePath: 'src/add.mjs',
    task: 'Correct the arithmetic operator.',
    allowedCommands: ['git status --porcelain=v1', 'node --test test/add.test.mjs'],
  });
  assert.match(prompt, /Target file: src\/add\.mjs/);
  assert.match(prompt, /Task: Correct the arithmetic operator\./);
  assert.match(prompt, /git status --porcelain=v1/);
  assert.match(prompt, /node --test test\/add\.test\.mjs/);
  assert.match(prompt, /Do not commit, push, merge/);
});

test('porcelain-z parsing returns exact changed paths', () => {
  assert.deepEqual(
    changedPathsFromPorcelainZ(' M src/add.mjs\0?? test/new.test.mjs\0'),
    ['src/add.mjs', 'test/new.test.mjs'],
  );
});
