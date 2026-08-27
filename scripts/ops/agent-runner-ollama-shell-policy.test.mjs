import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FIXED_OLLAMA_SHELL_COMMANDS,
  buildBoundedOllamaToolPermission,
  buildBoundedOpenCodeBashPermission,
  classifyBoundedOllamaShellCommand,
  isSafeRelativeShellPath,
  isShellTrustedRepository,
  tokenizeBoundedShellCommand,
} from './agent-runner-ollama-shell-policy.mjs';

const TRUST = Object.freeze({
  repository: 'TheTekTeam/agent-runner',
  trustedRepositories: ['TheTekTeam/agent-runner'],
});

test('fixed read-only Git commands are always admitted exactly', () => {
  for (const command of FIXED_OLLAMA_SHELL_COMMANDS) {
    const decision = classifyBoundedOllamaShellCommand(command, TRUST);
    assert.equal(decision.allowed, true, command);
    assert.equal(decision.kind, 'fixed-readonly-git');
  }
});

test('shell metacharacters, substitutions, redirections and quoting fail closed', () => {
  for (const command of [
    'node --test test/a.test.mjs && rm -rf x',
    'git diff | cat',
    'echo $(env)',
    'cat > out.txt',
    'node --test "test/a.test.mjs"',
    "node --test 'test/a.test.mjs'",
    'git status; env',
  ]) {
    assert.equal(tokenizeBoundedShellCommand(command).ok, false, command);
    assert.equal(classifyBoundedOllamaShellCommand(command, TRUST).allowed, false, command);
  }
});

test('focused node test requires exact manager authority and one safe relative path', () => {
  const command = 'node --test test/add.test.mjs';
  assert.equal(classifyBoundedOllamaShellCommand(command, TRUST).reason, 'ollama-shell-command-not-manager-approved');

  const allowed = classifyBoundedOllamaShellCommand(command, {
    ...TRUST,
    managerValidationCommands: [command],
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.kind, 'focused-node-test');
  assert.deepEqual(allowed.argv, ['node', '--test', 'test/add.test.mjs']);

  for (const unsafe of [
    'node --test ../secret.test.mjs',
    'node --test .hidden/test.mjs',
    'node --test /tmp/test.mjs',
  ]) {
    const decision = classifyBoundedOllamaShellCommand(unsafe, {
      ...TRUST,
      managerValidationCommands: [unsafe],
    });
    assert.equal(decision.allowed, false, unsafe);
  }
});

test('broader project validation requires manager AND machine exact allowlist', () => {
  const command = 'pnpm run typecheck';
  assert.equal(classifyBoundedOllamaShellCommand(command, {
    ...TRUST,
    managerValidationCommands: [command],
  }).reason, 'ollama-shell-command-not-machine-allowlisted');

  assert.equal(classifyBoundedOllamaShellCommand(command, {
    ...TRUST,
    machineCommandAllowlist: [command],
  }).reason, 'ollama-shell-command-not-manager-approved');

  const allowed = classifyBoundedOllamaShellCommand(command, {
    ...TRUST,
    managerValidationCommands: [command],
    machineCommandAllowlist: [command],
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.kind, 'machine-qualified-validation');
});

test('permanent command-family boundary cannot be overridden by manager plus machine allowlists', () => {
  for (const command of [
    'curl https://example.com',
    'wget https://example.com',
    'gh pr create',
    'sudo true',
    'systemctl status ssh',
    'docker ps',
    'pnpm add lodash',
    'pnpm exec vitest',
    'pnpm dlx eslint',
    'npm install lodash',
    'npm exec vitest',
    'npm run deploy',
    'npm run release',
    'pnpm run start',
    'pnpm run postinstall',
    'npx vitest',
    'node --eval process.exit',
  ]) {
    const decision = classifyBoundedOllamaShellCommand(command, {
      ...TRUST,
      managerValidationCommands: [command],
      machineCommandAllowlist: [command],
    });
    assert.equal(decision.allowed, false, command);
    assert.equal(decision.reason, 'ollama-shell-command-family-denied', command);
  }
});

test('machine-qualified broader validation stays inside node script or npm/pnpm run/test families', () => {
  for (const command of [
    'node scripts/check-fixture.mjs',
    'npm test',
    'npm run typecheck',
    'pnpm test',
    'pnpm run lint',
    'pnpm run build:types',
    'npm run format:check',
  ]) {
    const decision = classifyBoundedOllamaShellCommand(command, {
      ...TRUST,
      managerValidationCommands: [command],
      machineCommandAllowlist: [command],
    });
    assert.equal(decision.allowed, true, command);
    assert.equal(decision.kind, 'machine-qualified-validation', command);
  }
});

test('no command prefixes or wildcard-like strings broaden authority', () => {
  const manager = ['pnpm run test'];
  const machine = ['pnpm run test'];
  assert.equal(classifyBoundedOllamaShellCommand('pnpm run test extra', {
    ...TRUST,
    managerValidationCommands: manager,
    machineCommandAllowlist: machine,
  }).allowed, false);
  assert.equal(classifyBoundedOllamaShellCommand('pnpm run build', {
    ...TRUST,
    managerValidationCommands: manager,
    machineCommandAllowlist: machine,
  }).allowed, false);
});

test('OpenCode V1 bash permission is deny-by-default with exact allowed commands only', () => {
  const command = 'node --test test/add.test.mjs';
  const permission = buildBoundedOpenCodeBashPermission({
    ...TRUST,
    managerValidationCommands: [command, 'pnpm run typecheck'],
    machineCommandAllowlist: ['pnpm run typecheck'],
  });
  assert.equal(permission['*'], 'deny');
  assert.equal(permission[command], 'allow');
  assert.equal(permission['pnpm run typecheck'], 'allow');
  assert.equal(permission['git diff --no-ext-diff --check'], 'allow');
  assert.equal(permission['git push'], undefined);
  assert.equal(permission['pnpm *'], undefined);
});

test('tool policy denies everything globally, allows one file, bounded bash, and no external directory', () => {
  const command = 'node --test test/add.test.mjs';
  const permission = buildBoundedOllamaToolPermission({
    ...TRUST,
    filePath: 'src/add.mjs',
    managerValidationCommands: [command],
  });
  assert.equal(permission['*'], 'deny');
  assert.deepEqual(permission.read, { '*': 'deny', 'src/add.mjs': 'allow' });
  assert.deepEqual(permission.edit, { '*': 'deny', 'src/add.mjs': 'allow' });
  assert.equal(permission.bash['*'], 'deny');
  assert.equal(permission.bash[command], 'allow');
  assert.deepEqual(permission.external_directory, { '*': 'deny' });
});


test('shell stays denied unless the exact repository is machine-trusted', () => {
  assert.equal(isShellTrustedRepository('TheTekTeam/agent-runner', []), false);
  assert.equal(isShellTrustedRepository('TheTekTeam/agent-runner', ['thetekteam/agent-runner']), true);
  assert.equal(isShellTrustedRepository('../bad', ['../bad']), false);

  const command = 'node --test test/add.test.mjs';
  const denied = classifyBoundedOllamaShellCommand(command, {
    repository: 'TheTekTeam/agent-runner',
    trustedRepositories: ['TheTekTeam/modelspend'],
    managerValidationCommands: [command],
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'ollama-shell-repository-not-trusted');

  const permission = buildBoundedOpenCodeBashPermission({
    repository: 'TheTekTeam/agent-runner',
    trustedRepositories: [],
    managerValidationCommands: [command],
  });
  assert.deepEqual(permission, { '*': 'deny' });
});

test('safe path grammar rejects traversal, hidden roots, absolute paths and spaces', () => {
  for (const path of [
    '../secret',
    '.git/config',
    '/etc/passwd',
    'src/../secret',
    'src/file name.mjs',
    'src\\file.mjs',
  ]) assert.equal(isSafeRelativeShellPath(path), false, path);
  assert.equal(isSafeRelativeShellPath('src/lib/add.test.mjs'), true);
});
