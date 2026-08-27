import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexCommandArgs,
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
} from './agent-runner-codex-command.mjs';

const BASE = {
  executablePath: '/usr/local/bin/codex',
  cwd: '/tmp/agent-runner-worktree-123',
  model: 'gpt-5-codex',
  sandboxMode: 'workspace-write',
  approvalMode: 'on-request',
  prompt: 'fix the failing test',
};

test('buildCodexCommandArgs constructs the exact bounded exec argv', () => {
  const args = buildCodexCommandArgs(BASE);
  assert.deepEqual(args, [
    '/usr/local/bin/codex',
    'exec',
    '--json',
    '-C', '/tmp/agent-runner-worktree-123',
    '-s', 'workspace-write',
    '-c', 'approval_policy=on-request',
    '-m', 'gpt-5-codex',
    'fix the failing test',
  ]);
});

test('buildCodexCommandArgs requires every core argument explicitly', () => {
  assert.throws(() => buildCodexCommandArgs({}), /executable path/);
  assert.throws(() => buildCodexCommandArgs({ executablePath: 'x' }), /worktree cwd/);
  assert.throws(() => buildCodexCommandArgs({ executablePath: 'x', cwd: '/tmp/x' }), /model/);
  assert.throws(() => buildCodexCommandArgs({ executablePath: 'x', cwd: '/tmp/x', model: 'm' }), /sandbox mode/);
  assert.throws(() => buildCodexCommandArgs({ executablePath: 'x', cwd: '/tmp/x', model: 'm', sandboxMode: 'workspace-write' }), /approval mode/);
  assert.throws(() => buildCodexCommandArgs({ ...BASE, prompt: undefined }), /prompt/);
});

test('an unrecognized sandbox or approval value fails closed instead of being forwarded verbatim', () => {
  assert.throws(() => buildCodexCommandArgs({ ...BASE, sandboxMode: 'yolo' }), /unsupported.*sandbox mode/);
  assert.throws(() => buildCodexCommandArgs({ ...BASE, approvalMode: 'always' }), /unsupported.*approval mode/);
  assert.deepEqual(CODEX_SANDBOX_MODES, ['read-only', 'workspace-write', 'danger-full-access']);
  assert.deepEqual(CODEX_APPROVAL_POLICIES, ['untrusted', 'on-request', 'never']);
});

test('reasoningEffort is omitted unless explicitly provided, then reaches -c model_reasoning_effort=', () => {
  const withoutEffort = buildCodexCommandArgs(BASE);
  assert.equal(withoutEffort.join(' ').includes('model_reasoning_effort'), false);

  const withEffort = buildCodexCommandArgs({ ...BASE, reasoningEffort: 'high' });
  assert.deepEqual(withEffort.slice(-3, -1), ['-c', 'model_reasoning_effort=high']);
});

test('an unrecognized reasoning effort fails closed', () => {
  assert.throws(() => buildCodexCommandArgs({ ...BASE, reasoningEffort: 'ultra' }), /unsupported.*reasoning effort/);
});

test('outputSchemaPath is a plain file path passed through only when provided', () => {
  const withoutSchema = buildCodexCommandArgs(BASE);
  assert.equal(withoutSchema.includes('--output-schema'), false);

  const withSchema = buildCodexCommandArgs({ ...BASE, outputSchemaPath: '/tmp/schema.json' });
  const schemaIndex = withSchema.indexOf('--output-schema');
  assert.ok(schemaIndex > -1);
  assert.equal(withSchema[schemaIndex + 1], '/tmp/schema.json');
});


test('ephemeral and ignoreUserConfig flags are explicit booleans and emitted only when enabled', () => {
  const isolated = buildCodexCommandArgs({
    ...BASE,
    ephemeral: true,
    ignoreUserConfig: true,
  });

  assert.ok(isolated.includes('--ephemeral'));
  assert.ok(isolated.includes('--ignore-user-config'));

  const defaulted = buildCodexCommandArgs(BASE);
  assert.equal(defaulted.includes('--ephemeral'), false);
  assert.equal(defaulted.includes('--ignore-user-config'), false);

  assert.throws(() => buildCodexCommandArgs({ ...BASE, ephemeral: 'true' }), /ephemeral to be boolean/);
  assert.throws(() => buildCodexCommandArgs({ ...BASE, ignoreUserConfig: 'true' }), /ignoreUserConfig to be boolean/);
});

test('the command never emits a bypass-approvals/sandbox or bypass-hook-trust flag under any input', () => {
  const args = buildCodexCommandArgs({ ...BASE, sandboxMode: 'danger-full-access', approvalMode: 'never' });
  const joined = args.join(' ');
  assert.equal(/--dangerously-bypass/i.test(joined), false);
});

test('the command has no concurrency, pull/download, or fallback-provider flag', () => {
  const args = buildCodexCommandArgs(BASE);
  const joined = args.join(' ');
  assert.equal(/--concurrency|--pull|--download|--fallback/i.test(joined), false);
});

test('cwd must be an explicit worktree path, never defaulted', () => {
  assert.throws(() => buildCodexCommandArgs({ ...BASE, cwd: '' }), /worktree cwd/);
  assert.throws(() => buildCodexCommandArgs({ ...BASE, cwd: undefined }), /worktree cwd/);
});


test('workspace-write network access can be explicitly denied through the supported config override', () => {
  const args = buildCodexCommandArgs({
    executablePath: '/usr/local/bin/codex',
    cwd: '/tmp/worktree',
    model: 'gpt-5.6-terra',
    sandboxMode: 'workspace-write',
    approvalMode: 'never',
    reasoningEffort: 'low',
    networkAccess: false,
    prompt: 'create the bounded fixture',
  });

  const pairs = args.flatMap((value, index) => value === '-c' ? [args[index + 1]] : []);
  assert.ok(pairs.includes('sandbox_workspace_write.network_access=false'));
  assert.ok(pairs.includes('approval_policy=never'));
  assert.ok(pairs.includes('model_reasoning_effort=low'));
});

test('networkAccess must be boolean when supplied', () => {
  assert.throws(() => buildCodexCommandArgs({
    executablePath: '/usr/local/bin/codex',
    cwd: '/tmp/worktree',
    model: 'gpt-5.6-terra',
    sandboxMode: 'workspace-write',
    approvalMode: 'never',
    networkAccess: 'false',
    prompt: 'create the bounded fixture',
  }), /networkAccess to be boolean/);
});


test('networkAccess override is refused outside workspace-write sandbox', () => {
  assert.throws(() => buildCodexCommandArgs({
    executablePath: '/usr/local/bin/codex',
    cwd: '/tmp/worktree',
    model: 'gpt-5.6-terra',
    sandboxMode: 'read-only',
    approvalMode: 'never',
    networkAccess: false,
    prompt: 'inspect only',
  }), /only with workspace-write sandbox/);
});
