import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGrokCommandArgs,
  GROK_MAX_TOOL_ROUNDS_CEILING,
} from './agent-runner-grok-command.mjs';

const BASE = {
  executablePath: '/usr/local/bin/grok',
  cwd: '/tmp/agent-runner-worktree-123',
  maxToolRounds: 50,
  prompt: 'fix the failing test',
};

test('buildGrokCommandArgs constructs the exact bounded argv without a model', () => {
  const args = buildGrokCommandArgs(BASE);
  assert.deepEqual(args, [
    '/usr/local/bin/grok',
    '-d', '/tmp/agent-runner-worktree-123',
    '--format', 'json',
    '--sandbox',
    '--max-tool-rounds', '50',
    '-p', 'fix the failing test',
  ]);
});

test('buildGrokCommandArgs includes -m only when a model is explicitly configured', () => {
  const withoutModel = buildGrokCommandArgs(BASE);
  assert.equal(withoutModel.includes('-m'), false);

  const withModel = buildGrokCommandArgs({ ...BASE, model: 'grok-4' });
  const modelIndex = withModel.indexOf('-m');
  assert.ok(modelIndex > -1);
  assert.equal(withModel[modelIndex + 1], 'grok-4');
});

test('an empty or whitespace-only model is treated as not configured', () => {
  assert.equal(buildGrokCommandArgs({ ...BASE, model: '' }).includes('-m'), false);
  assert.equal(buildGrokCommandArgs({ ...BASE, model: '   ' }).includes('-m'), false);
});

test('buildGrokCommandArgs requires every core argument explicitly', () => {
  assert.throws(() => buildGrokCommandArgs({}), /executable path/);
  assert.throws(() => buildGrokCommandArgs({ executablePath: 'x' }), /isolated working directory/);
  assert.throws(() => buildGrokCommandArgs({ executablePath: 'x', cwd: '/tmp/x' }), /prompt/);
  assert.throws(() => buildGrokCommandArgs({ executablePath: 'x', cwd: '/tmp/x', prompt: 'p' }), /bounded maximum tool-round count/);
});

test('cwd must be an explicit working directory, never defaulted', () => {
  assert.throws(() => buildGrokCommandArgs({ ...BASE, cwd: '' }), /isolated working directory/);
  assert.throws(() => buildGrokCommandArgs({ ...BASE, cwd: undefined }), /isolated working directory/);
});

test('maxToolRounds must be a bounded positive integer, never zero, negative, fractional, or unbounded', () => {
  assert.throws(() => buildGrokCommandArgs({ ...BASE, maxToolRounds: 0 }), /bounded maximum tool-round count/);
  assert.throws(() => buildGrokCommandArgs({ ...BASE, maxToolRounds: -5 }), /bounded maximum tool-round count/);
  assert.throws(() => buildGrokCommandArgs({ ...BASE, maxToolRounds: 12.5 }), /bounded maximum tool-round count/);
  assert.throws(() => buildGrokCommandArgs({ ...BASE, maxToolRounds: GROK_MAX_TOOL_ROUNDS_CEILING + 1 }), /bounded maximum tool-round count/);
  assert.doesNotThrow(() => buildGrokCommandArgs({ ...BASE, maxToolRounds: GROK_MAX_TOOL_ROUNDS_CEILING }));
});

test('--sandbox is always present and there is no way to request --no-sandbox', () => {
  const args = buildGrokCommandArgs(BASE);
  assert.ok(args.includes('--sandbox'));
  assert.equal(args.includes('--no-sandbox'), false);
});

test('the command has no credential, session, network-escape, Batch API, remote-control, or self-verification flag under any input', () => {
  const args = buildGrokCommandArgs({ ...BASE, model: 'grok-4' });
  const joined = args.join(' ');
  assert.equal(/-k\b|--api-key|-u\b|--base-url|-s\b|--session|--allow-net|--allow-host|--port|--background-task-file|--batch-api|--verify|--update/i.test(joined), false);
});

test('the built argv never contains a telegram-bridge, models, update, uninstall, wallet, or daemon subcommand', () => {
  const args = buildGrokCommandArgs({ ...BASE, model: 'grok-4' });
  for (const forbidden of ['telegram-bridge', 'models', 'update', 'uninstall', 'wallet', 'daemon']) {
    assert.equal(args.includes(forbidden), false);
  }
});

test('buildGrokCommandArgs has no parameter through which a raw secret, session, or credential value could be forwarded', () => {
  const source = buildGrokCommandArgs.toString();
  assert.equal(/api.?key|secret|token|session|credential/i.test(source), false);
});

test('always emits structured JSON output', () => {
  const args = buildGrokCommandArgs(BASE);
  const formatIndex = args.indexOf('--format');
  assert.ok(formatIndex > -1);
  assert.equal(args[formatIndex + 1], 'json');
});
