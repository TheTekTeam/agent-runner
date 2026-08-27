import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBoundedOllamaCodingPrompt,
  changedPathsFromPorcelainZ,
  isSafeOllamaWorkerPath,
  resolveBoundedOllamaManagerContract,
} from './agent-runner-ollama-worker-contract.mjs';

function packet({ scope, validation = ['node --test test/add.test.mjs'] } = {}) {
  const scopeItems = scope || [
    'file: src/add.mjs',
    'task: Correct the arithmetic operator used by add.',
  ];
  return `<!-- agent-runner:manager-preflight -->

\`\`\`yaml
schema_version: agent-runner-manager-preflight/v1
revision: AR376.TEST.1
fingerprint: sha256:${'a'.repeat(64)}
producer_type: normal_chatgpt_manager_session
approved_agent: ollama-agent
execution_phase: implementation
scope:
${scopeItems.map((item) => `  - ${item}`).join('\n')}
required_validation:
${validation.map((item) => `  - ${item}`).join('\n')}
stop_conditions:
  - stop on scope expansion
\`\`\``;
}

test('accepts only one explicit file, one bounded task and one node test', () => {
  const result = resolveBoundedOllamaManagerContract(packet());
  assert.equal(result.ok, true);
  assert.equal(result.filePath, 'src/add.mjs');
  assert.equal(result.task, 'Correct the arithmetic operator used by add.');
  assert.equal(result.validationPath, 'test/add.test.mjs');
  assert.deepEqual([...result.validationArgs], ['--test', 'test/add.test.mjs']);
});

test('rejects arbitrary prose, multiple files and broader shell validation', () => {
  assert.equal(resolveBoundedOllamaManagerContract(packet({
    scope: ['bounded implementation work', 'task: Fix it'],
  })).reason, 'ollama-manager-scope-shape-unsupported');

  assert.equal(resolveBoundedOllamaManagerContract(packet({
    scope: ['file: src/a.mjs', 'file: src/b.mjs', 'task: Fix both'],
  })).reason, 'ollama-manager-scope-shape-unsupported');

  assert.equal(resolveBoundedOllamaManagerContract(packet({
    validation: ['npm test'],
  })).reason, 'ollama-manager-validation-unsupported');

  assert.equal(resolveBoundedOllamaManagerContract(packet({
    validation: ['node --test test/a.test.mjs && rm -rf x'],
  })).reason, 'ollama-manager-validation-unsupported');
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

test('prompt contains only the bounded target/task plus fixed safety rules', () => {
  const prompt = buildBoundedOllamaCodingPrompt({
    filePath: 'src/add.mjs',
    task: 'Correct the arithmetic operator.',
  });
  assert.match(prompt, /Target file: src\/add\.mjs/);
  assert.match(prompt, /Task: Correct the arithmetic operator\./);
  assert.match(prompt, /Do not use shell commands/);
});

test('porcelain-z parsing returns exact changed paths', () => {
  assert.deepEqual(
    changedPathsFromPorcelainZ(' M src/add.mjs\0?? test/new.test.mjs\0'),
    ['src/add.mjs', 'test/new.test.mjs'],
  );
});
