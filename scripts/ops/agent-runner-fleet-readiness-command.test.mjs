import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectFleetReadiness,
  probeFleetRuntime,
} from './agent-runner-fleet-readiness-command.mjs';

test('runtime probes execute only reviewed Claude/Codex version commands and infer no authentication', () => {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'claude') return { status: 0, stdout: '2.1.233 (Claude Code)\n', stderr: '' };
    if (command === 'codex') return { status: 0, stdout: 'codex-cli 0.128.0\n', stderr: '' };
    throw new Error(`unexpected command: ${command}`);
  };

  const claude = probeFleetRuntime('claude-code-cli', { runner });
  const codex = probeFleetRuntime('codex-cli', { runner });

  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: 'claude', args: ['--version'] },
    { command: 'codex', args: ['--version'] },
  ]);
  assert.deepEqual(claude, {
    adapterId: 'claude-code-cli',
    sourceSupported: true,
    runtimeInstalled: true,
    version: '2.1.233',
    authAvailable: null,
    qualified: false,
    probeState: 'runtime-installed-auth-unchecked',
  });
  assert.deepEqual(codex, {
    adapterId: 'codex-cli',
    sourceSupported: true,
    runtimeInstalled: true,
    version: '0.128.0',
    authAvailable: null,
    qualified: false,
    probeState: 'runtime-installed-auth-unchecked',
  });
  assert.deepEqual(Object.keys(calls[0].options.env), ['PATH']);
  assert.deepEqual(Object.keys(calls[1].options.env), ['PATH']);
});

test('Grok/Ollama foundations do not execute guessed install/version commands', () => {
  let calls = 0;
  const runner = () => { calls += 1; return { status: 0, stdout: 'unexpected' }; };
  for (const adapterId of ['grok-cli', 'ollama-agent']) {
    const probe = probeFleetRuntime(adapterId, { runner });
    assert.equal(probe.sourceSupported, false);
    assert.equal(probe.runtimeInstalled, false);
    assert.equal(probe.authAvailable, null);
    assert.equal(probe.qualified, false);
  }
  assert.equal(calls, 0);
});

test('worker-only readiness projection grants no scheduler/controller authority and no false qualification', () => {
  const result = collectFleetReadiness({
    nodeId: 'dev-cluster-z790',
    workerOnly: true,
    platform: 'linux',
    arch: 'x64',
    runner(command, args) {
      assert.deepEqual(args, ['--version']);
      if (command === 'claude') return { status: 0, stdout: '2.1.233\n', stderr: '' };
      if (command === 'codex') return { status: 0, stdout: 'codex-cli 0.128.0\n', stderr: '' };
      throw new Error(`unexpected command: ${command}`);
    },
  });
  assert.equal(result.workerOnly, true);
  assert.equal(result.controllerAuthorityGranted, false);
  assert.equal(result.mutationPerformed, false);
  assert.equal(result.os, 'linux');
  assert.equal(result.arch, 'x64');
  assert.equal(result.provisioningProjection.nodeId, 'dev-cluster-z790');

  const claude = result.provisioningProjection.adapters.find((entry) => entry.adapterId === 'claude-code-cli');
  assert.equal(claude.state, 'runtime-installed');
  assert.equal(claude.authAvailable, null);
  assert.equal(claude.qualified, false);

  const codex = result.provisioningProjection.adapters.find((entry) => entry.adapterId === 'codex-cli');
  assert.equal(codex.state, 'runtime-installed');
  assert.equal(codex.reason, 'machine-local-auth-unknown');
  assert.equal(codex.authAvailable, null);
  assert.equal(codex.qualified, false);

  assert.equal(result.agentInstances.every((instance) => instance.lifecycle === 'disabled'), true);
});

test('missing runtime is explicit and remains non-routable', () => {
  for (const adapterId of ['claude-code-cli', 'codex-cli']) {
    const probe = probeFleetRuntime(adapterId, {
      runner() {
        const error = new Error('spawn ENOENT');
        error.code = 'ENOENT';
        return { status: null, stdout: '', stderr: '', error };
      },
    });
    assert.equal(probe.runtimeInstalled, false);
    assert.equal(probe.probeState, 'runtime-not-installed');
    assert.equal(probe.authAvailable, null);
    assert.equal(probe.qualified, false);
  }
});

test('bounded readiness output contains no environment, credential, session or filesystem path fields', () => {
  const result = collectFleetReadiness({
    nodeId: 'dev-cluster-z790',
    workerOnly: true,
    runner(command) {
      if (command === 'claude') return { status: 0, stdout: '2.1.233\n', stderr: '' };
      if (command === 'codex') return { status: 0, stdout: 'codex-cli 0.128.0\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    },
  });
  const serialized = JSON.stringify(result).toLowerCase();
  for (const forbidden of ['credential', 'password', 'sessionid', 'api_key', 'api-key', 'homedir', 'cwd', 'executablepath']) {
    assert.equal(serialized.includes(forbidden), false, `restricted readiness field leaked: ${forbidden}`);
  }
});
