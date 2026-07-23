import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FAILURE_SCOPES } from './agent-runner-adapter-contract.mjs';
import {
  admitOllamaDispatch,
  buildOpenCodeCommandArgs,
  classifyOpenCodeExecutionError,
  isAllowlistedOllamaHost,
  OLLAMA_AGENT_ID,
  parseOpenCodeResultEnvelope,
  probeEndpoint,
  probeExecutable,
  probeHostHeadroom,
  probeInstalledModel,
  probeVersion,
  resolveOllamaEndpoint,
  resolveOllamaExecutablePath,
} from './agent-runner-ollama-adapter.mjs';

function withTempRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-ollama-adapter-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFakeExecutable(dir, name = 'opencode') {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\necho fake\n');
  chmodSync(path, 0o755);
  return path;
}

function neverCalled(label) {
  return (...args) => { throw new Error(`${label} should not have been called with ${JSON.stringify(args)}`); };
}

function fakeSettings(entry) {
  return {
    agentId: OLLAMA_AGENT_ID,
    routable: true,
    reason: 'agent-routable',
    entry,
  };
}

const NOT_ROUTABLE_SETTINGS = { agentId: OLLAMA_AGENT_ID, routable: false, reason: 'agent-disabled', entry: null };

// --- 1. Disabled mode: zero model calls, zero I/O, zero mutation --------

test('disabled mode: admission is refused before any probe and no injected I/O function is ever called', async () => withTempRoot(async () => {
  const decision = await admitOllamaDispatch({
    settings: NOT_ROUTABLE_SETTINGS,
    model: 'qwen2.5-coder:7b',
    accessFn: neverCalled('accessFn'),
    execFileFn: neverCalled('execFileFn'),
    fetchFn: neverCalled('fetchFn'),
    freeMemoryFn: neverCalled('freeMemoryFn'),
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.scope, FAILURE_SCOPES.MACHINE_PROFILE);
  assert.equal(decision.reason, 'agent-disabled');
  assert.deepEqual(decision.probes, []);
}));

// --- 2. Unavailable executable -------------------------------------------

test('unavailable executable: real temp-repo filesystem check fails closed and short-circuits later probes', async () => withTempRoot(async (dir) => {
  const missingPath = join(dir, 'does-not-exist', 'opencode');
  const decision = await admitOllamaDispatch({
    settings: fakeSettings({ executablePath: missingPath, endpoint: 'http://127.0.0.1:11434' }),
    model: 'qwen2.5-coder:7b',
    execFileFn: neverCalled('execFileFn'),
    fetchFn: neverCalled('fetchFn'),
    freeMemoryFn: neverCalled('freeMemoryFn'),
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.failedProbe, 'executable');
  assert.equal(decision.reason, 'ollama-executable-unavailable');
  assert.equal(decision.probes.length, 1);
}));

test('resolveOllamaExecutablePath never falls back to a PATH search', () => {
  assert.deepEqual(resolveOllamaExecutablePath({}), { ok: false, reason: 'ollama-executable-not-configured', path: null });
  assert.deepEqual(resolveOllamaExecutablePath({ executablePath: '  ' }), { ok: false, reason: 'ollama-executable-not-configured', path: null });
});

test('probeExecutable succeeds against a real executable file in a temp root', () => withTempRoot((dir) => {
  const execPath = writeFakeExecutable(dir);
  const outcome = probeExecutable({ executablePath: execPath });
  assert.equal(outcome.ok, true);
}));

// --- 3. Unavailable endpoint ----------------------------------------------

test('unavailable endpoint: executable and version probes pass, endpoint probe fails, model/headroom never probed', async () => withTempRoot(async (dir) => {
  const execPath = writeFakeExecutable(dir);
  const decision = await admitOllamaDispatch({
    settings: fakeSettings({ executablePath: execPath, endpoint: 'http://127.0.0.1:11434' }),
    model: 'qwen2.5-coder:7b',
    execFileFn: () => 'opencode 0.1.0',
    fetchFn: async () => { throw new Error('connect ECONNREFUSED'); },
    freeMemoryFn: neverCalled('freeMemoryFn'),
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.failedProbe, 'endpoint');
  assert.equal(decision.reason, 'ollama-endpoint-unreachable');
  assert.equal(decision.probes.length, 3);
}));

test('resolveOllamaEndpoint allows localhost, rejects a non-allowlisted LAN host, allows an explicitly allowlisted one', () => {
  assert.equal(resolveOllamaEndpoint({ endpoint: 'http://127.0.0.1:11434' }).ok, true);
  assert.equal(resolveOllamaEndpoint({ endpoint: 'http://localhost:11434' }).ok, true);
  const rejected = resolveOllamaEndpoint({ endpoint: 'http://10.0.0.5:11434' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'ollama-endpoint-not-allowlisted');
  assert.equal(resolveOllamaEndpoint({ endpoint: 'http://10.0.0.5:11434', endpointAllowlistHosts: ['10.0.0.5'] }).ok, true);
  assert.equal(resolveOllamaEndpoint({ endpoint: 'not a url' }).reason, 'ollama-endpoint-malformed');
  assert.equal(resolveOllamaEndpoint({ endpoint: 'ftp://127.0.0.1' }).reason, 'ollama-endpoint-malformed');
  assert.equal(resolveOllamaEndpoint({}).reason, 'ollama-endpoint-not-configured');
});

test('isAllowlistedOllamaHost is case-insensitive and has no wildcard', () => {
  assert.equal(isAllowlistedOllamaHost('LOCALHOST'), true);
  assert.equal(isAllowlistedOllamaHost('example.lan', ['Example.LAN']), true);
  assert.equal(isAllowlistedOllamaHost('example.lan', ['*']), false);
});

// --- 4. Unavailable model ---------------------------------------------------

test('unavailable model: requested model absent from the explicit allowlist fails closed without a network call', async () => {
  const outcome = await probeInstalledModel({
    model: 'llama3:70b',
    installedModelAllowlist: ['qwen2.5-coder:7b'],
    endpointUrl: 'http://127.0.0.1:11434',
    fetchFn: neverCalled('fetchFn'),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'ollama-model-not-allowlisted');
});

test('unavailable model: allowlisted but not reported installed by the endpoint fails closed', async () => {
  const outcome = await probeInstalledModel({
    model: 'qwen2.5-coder:7b',
    installedModelAllowlist: ['qwen2.5-coder:7b'],
    endpointUrl: 'http://127.0.0.1:11434',
    fetchFn: async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3:8b' }] }) }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'ollama-model-not-installed');
});

test('installed model probe succeeds only when allowlisted AND reported installed', async () => {
  const outcome = await probeInstalledModel({
    model: 'qwen2.5-coder:7b',
    installedModelAllowlist: ['qwen2.5-coder:7b'],
    endpointUrl: 'http://127.0.0.1:11434',
    fetchFn: async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen2.5-coder:7b' }] }) }),
  });
  assert.equal(outcome.ok, true);
});

test('full admission fails at the model probe when endpoint is reachable but the model is not allowlisted, and headroom is never probed', async () => withTempRoot(async (dir) => {
  const execPath = writeFakeExecutable(dir);
  const decision = await admitOllamaDispatch({
    settings: fakeSettings({
      executablePath: execPath,
      endpoint: 'http://127.0.0.1:11434',
      installedModelAllowlist: ['qwen2.5-coder:7b'],
    }),
    model: 'llama3:70b',
    execFileFn: () => 'opencode 0.1.0',
    fetchFn: async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen2.5-coder:7b' }] }) }),
    freeMemoryFn: neverCalled('freeMemoryFn'),
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.failedProbe, 'installed-model');
  assert.equal(decision.reason, 'ollama-model-not-allowlisted');
}));

// --- 5. Insufficient resources ----------------------------------------------

test('insufficient resources: host headroom below the configured minimum fails closed as machine_profile, distinct from paid quota', () => {
  const outcome = probeHostHeadroom({ minFreeMemoryBytes: 4_000_000_000, freeMemoryFn: () => 1_000_000_000 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'ollama-insufficient-host-headroom');
  assert.equal(outcome.failureScope, FAILURE_SCOPES.MACHINE_PROFILE);
});

test('full admission succeeds end-to-end when every probe passes (temp-root executable, mocked network)', async () => withTempRoot(async (dir) => {
  const execPath = writeFakeExecutable(dir);
  const decision = await admitOllamaDispatch({
    settings: fakeSettings({
      executablePath: execPath,
      endpoint: 'http://127.0.0.1:11434',
      installedModelAllowlist: ['qwen2.5-coder:7b'],
      minFreeMemoryBytes: 1_000_000,
    }),
    model: 'qwen2.5-coder:7b',
    execFileFn: () => 'opencode 0.1.0',
    fetchFn: async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen2.5-coder:7b' }] }) }),
    freeMemoryFn: () => 8_000_000_000,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.probes.length, 5);
  assert.ok(decision.probes.every((probe) => probe.ok));
}));

// --- 6. Timeout --------------------------------------------------------------

test('timeout is classified distinctly from an ordinary execution error', () => {
  const result = classifyOpenCodeExecutionError({ timedOut: true, signal: 'SIGTERM' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ollama-timeout');
  assert.equal(result.failureScope, FAILURE_SCOPES.TASK_ATTEMPT);
});

// --- 7. Cancellation ---------------------------------------------------------

test('cancellation is classified distinctly from timeout and ordinary error', () => {
  const result = classifyOpenCodeExecutionError({ cancelled: true, signal: 'SIGINT' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ollama-cancelled');
});

test('an execution error that is neither timed out nor cancelled is classified generically', () => {
  const result = classifyOpenCodeExecutionError({ code: 'ENOENT', message: 'spawn opencode ENOENT' });
  assert.equal(result.reason, 'ollama-execution-error');
  assert.equal(result.structuredFailure, 'ENOENT');
});

// --- 8. Invalid output ---------------------------------------------------------

test('invalid output: empty stdout fails closed', () => {
  const result = parseOpenCodeResultEnvelope('');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ollama-invalid-output');
});

test('invalid output: non-JSON stdout fails closed', () => {
  const result = parseOpenCodeResultEnvelope('not json at all');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ollama-invalid-output');
});

test('invalid output: JSON missing the required status field fails closed', () => {
  const result = parseOpenCodeResultEnvelope(JSON.stringify({ output: 'hi' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ollama-invalid-output');
});

// --- 9. No-op ------------------------------------------------------------------

test('no-op: a structured no-op result is a success with no repository mutation', () => {
  const result = parseOpenCodeResultEnvelope(JSON.stringify({ status: 'no-op', output: 'nothing to change' }));
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'no-op');
  assert.equal(result.mutatedRepository, false);
  assert.equal(result.usage.costUsd, 0);
});

test('an ok result records mutatedRepository from the structured payload', () => {
  const result = parseOpenCodeResultEnvelope(JSON.stringify({ status: 'ok', output: 'changed a file', mutated: true }));
  assert.equal(result.ok, true);
  assert.equal(result.mutatedRepository, true);
});

test('an error-status structured result is a typed task_attempt failure', () => {
  const result = parseOpenCodeResultEnvelope(JSON.stringify({ status: 'error', error: 'model returned malformed patch' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'model returned malformed patch');
  assert.equal(result.failureScope, FAILURE_SCOPES.TASK_ATTEMPT);
});

// --- 10. No mutation (command construction is pure, no paid fallback / concurrency / auto-pull flags) ----

test('buildOpenCodeCommandArgs constructs a bounded, serial, no-fallback, no-download command', () => {
  const args = buildOpenCodeCommandArgs({
    executablePath: '/usr/local/bin/opencode',
    model: 'qwen2.5-coder:7b',
    endpointUrl: 'http://127.0.0.1:11434',
    prompt: 'fix the failing test',
  });
  assert.deepEqual(args, [
    '/usr/local/bin/opencode',
    'run',
    '--model', 'ollama/qwen2.5-coder:7b',
    '--api-base', 'http://127.0.0.1:11434',
    '--non-interactive',
    '--print',
    'fix the failing test',
  ]);
  const joined = args.join(' ');
  assert.equal(/--pull|--download/i.test(joined), false);
  assert.equal(/--fallback|--concurrency/i.test(joined), false);
});

test('buildOpenCodeCommandArgs requires every argument explicitly', () => {
  assert.throws(() => buildOpenCodeCommandArgs({}), /executable path/);
  assert.throws(() => buildOpenCodeCommandArgs({ executablePath: 'x' }), /model/);
  assert.throws(() => buildOpenCodeCommandArgs({ executablePath: 'x', model: 'm' }), /endpoint url/);
  assert.throws(() => buildOpenCodeCommandArgs({ executablePath: 'x', model: 'm', endpointUrl: 'http://127.0.0.1:11434' }), /prompt/);
});

test('probeEndpoint and probeVersion fail closed instead of throwing when no I/O function is injected', async () => {
  assert.equal((await probeEndpoint({ endpointUrl: 'http://127.0.0.1:11434' })).reason, 'ollama-endpoint-probe-unavailable');
  assert.equal(probeVersion({ executablePath: '/bin/true' }).reason, 'ollama-version-probe-unavailable');
});
