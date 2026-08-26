import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectFleetReadiness,
  probeFleetRuntime,
} from './agent-runner-fleet-readiness-command.mjs';

test('runtime probes execute only reviewed Claude/Codex/Ollama/OpenCode version commands', () => {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'claude') return { status: 0, stdout: '2.1.233 (Claude Code)\n', stderr: '' };
    if (command === 'codex') return { status: 0, stdout: 'codex-cli 0.128.0\n', stderr: '' };
    if (command === 'ollama') return { status: 0, stdout: 'ollama version is 0.32.1\n', stderr: '' };
    if (command === 'opencode') return { status: 0, stdout: 'opencode 1.18.4\n', stderr: '' };
    throw new Error(`unexpected command: ${command}`);
  };

  const claude = probeFleetRuntime('claude-code-cli', { runner });
  const codex = probeFleetRuntime('codex-cli', { runner });
  const ollama = probeFleetRuntime('ollama-agent', { runner });

  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: 'claude', args: ['--version'] },
    { command: 'codex', args: ['--version'] },
    { command: 'ollama', args: ['-v'] },
    { command: 'opencode', args: ['--version'] },
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
  assert.deepEqual(ollama, {
    adapterId: 'ollama-agent',
    sourceSupported: true,
    runtimeInstalled: true,
    version: '1.18.4',
    authAvailable: true,
    qualified: false,
    probeState: 'runtime-installed-auth-unchecked',
    components: [
      {
        componentId: 'ollama-runtime',
        runtimeInstalled: true,
        version: '0.32.1',
        probeState: 'runtime-installed',
      },
      {
        componentId: 'opencode-harness',
        runtimeInstalled: true,
        version: '1.18.4',
        probeState: 'runtime-installed',
      },
    ],
    modelInventoryState: 'not-probed',
  });
  for (const call of calls) assert.deepEqual(Object.keys(call.options.env), ['PATH']);
});

test('Grok foundation remains fail-closed and executes no guessed version command', () => {
  let calls = 0;
  const runner = () => { calls += 1; return { status: 0, stdout: 'unexpected' }; };
  const probe = probeFleetRuntime('grok-cli', { runner });
  assert.equal(probe.sourceSupported, false);
  assert.equal(probe.runtimeInstalled, false);
  assert.equal(probe.authAvailable, null);
  assert.equal(probe.qualified, false);
  assert.equal(calls, 0);
});

test('Ollama bounded version output proves runtime presence even when daemon-aware version probe exits non-zero', () => {
  const probe = probeFleetRuntime('ollama-agent', {
    runner(command) {
      if (command === 'ollama') {
        return {
          status: 1,
          stdout: 'Warning: could not connect to 127.0.0.1:11434\nWarning: client version is 0.32.1\n',
          stderr: '',
        };
      }
      if (command === 'opencode') return { status: 0, stdout: 'opencode 1.18.4\n', stderr: '' };
      throw new Error(`unexpected command: ${command}`);
    },
  });

  assert.equal(probe.runtimeInstalled, true);
  assert.equal(probe.version, '1.18.4');
  assert.equal(probe.authAvailable, true);
  assert.equal(probe.qualified, false);
  assert.equal(probe.probeState, 'runtime-installed-auth-unchecked');
  assert.equal(probe.modelInventoryState, 'not-probed');

  const ollama = probe.components.find((entry) => entry.componentId === 'ollama-runtime');
  assert.deepEqual(ollama, {
    componentId: 'ollama-runtime',
    runtimeInstalled: true,
    version: '0.32.1',
    probeState: 'runtime-installed-version-exit-nonzero',
  });
});

test('Ollama version parsing prefers client version over daemon/server version', () => {
  const probe = probeFleetRuntime('ollama-agent', {
    runner(command) {
      if (command === 'ollama') {
        return {
          status: 0,
          stdout: 'ollama version is 0.31.9\nWarning: client version is 0.32.1\n',
          stderr: '',
        };
      }
      if (command === 'opencode') return { status: 0, stdout: 'opencode 1.18.4\n', stderr: '' };
      throw new Error(`unexpected command: ${command}`);
    },
  });

  const ollama = probe.components.find((entry) => entry.componentId === 'ollama-runtime');
  assert.equal(ollama.runtimeInstalled, true);
  assert.equal(ollama.version, '0.32.1');
});

test('non-zero OpenCode or unversioned Ollama probe remains a hard runtime failure', () => {
  const missingHarness = probeFleetRuntime('ollama-agent', {
    runner(command) {
      if (command === 'ollama') return { status: 0, stdout: 'ollama version is 0.32.1\n', stderr: '' };
      if (command === 'opencode') return { status: 1, stdout: 'opencode 1.18.4\n', stderr: '' };
      throw new Error(`unexpected command: ${command}`);
    },
  });
  assert.equal(missingHarness.runtimeInstalled, false);
  assert.equal(missingHarness.probeState, 'opencode-harness-version-probe-failed');

  const unversionedOllama = probeFleetRuntime('ollama-agent', {
    runner(command) {
      if (command === 'ollama') {
        return {
          status: 1,
          stdout: 'Warning: could not connect to 127.0.0.1:11434 after 1 attempt\n',
          stderr: '',
        };
      }
      if (command === 'opencode') return { status: 0, stdout: 'opencode 1.18.4\n', stderr: '' };
      throw new Error(`unexpected command: ${command}`);
    },
  });
  assert.equal(unversionedOllama.runtimeInstalled, false);
  assert.equal(unversionedOllama.probeState, 'ollama-runtime-version-probe-failed');

  const malformedPhrase = probeFleetRuntime('ollama-agent', {
    runner(command) {
      if (command === 'ollama') {
        return {
          status: 1,
          stdout: 'Warning: client version is 1\n',
          stderr: '',
        };
      }
      if (command === 'opencode') return { status: 0, stdout: 'opencode 1.18.4\n', stderr: '' };
      throw new Error(`unexpected command: ${command}`);
    },
  });
  assert.equal(malformedPhrase.runtimeInstalled, false);
  assert.equal(malformedPhrase.probeState, 'ollama-runtime-version-probe-failed');
});

test('Ollama readiness distinguishes missing runtime from missing OpenCode harness without probing models', () => {
  const missingRuntime = probeFleetRuntime('ollama-agent', {
    runner(command) {
      if (command === 'ollama') {
        const error = new Error('spawn ENOENT');
        error.code = 'ENOENT';
        return { status: null, stdout: '', stderr: '', error };
      }
      if (command === 'opencode') return { status: 0, stdout: 'opencode 1.18.4\n', stderr: '' };
      throw new Error(`unexpected command: ${command}`);
    },
  });
  assert.equal(missingRuntime.runtimeInstalled, false);
  assert.equal(missingRuntime.probeState, 'ollama-runtime-not-installed');
  assert.equal(missingRuntime.modelInventoryState, 'not-probed');

  const missingHarness = probeFleetRuntime('ollama-agent', {
    runner(command) {
      if (command === 'ollama') return { status: 0, stdout: 'ollama version is 0.32.1\n', stderr: '' };
      if (command === 'opencode') {
        const error = new Error('spawn ENOENT');
        error.code = 'ENOENT';
        return { status: null, stdout: '', stderr: '', error };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });
  assert.equal(missingHarness.runtimeInstalled, false);
  assert.equal(missingHarness.probeState, 'opencode-harness-not-installed');
  assert.equal(missingHarness.modelInventoryState, 'not-probed');
});

test('worker-only readiness projection grants no scheduler/controller authority and no false qualification', () => {
  const result = collectFleetReadiness({
    nodeId: 'dev-cluster-z790',
    workerOnly: true,
    platform: 'linux',
    arch: 'x64',
    runner(command, args) {
      if (command === 'ollama') {
        assert.deepEqual(args, ['-v']);
        return { status: 0, stdout: 'ollama version is 0.32.1\n', stderr: '' };
      }
      assert.deepEqual(args, ['--version']);
      if (command === 'claude') return { status: 0, stdout: '2.1.233\n', stderr: '' };
      if (command === 'codex') return { status: 0, stdout: 'codex-cli 0.128.0\n', stderr: '' };
      if (command === 'opencode') return { status: 0, stdout: 'opencode 1.18.4\n', stderr: '' };
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

  const ollama = result.provisioningProjection.adapters.find((entry) => entry.adapterId === 'ollama-agent');
  assert.equal(ollama.state, 'authenticated');
  assert.equal(ollama.reason, 'adapter-qualification-not-live');
  assert.equal(ollama.authAvailable, true);
  assert.equal(ollama.qualified, false);

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
      if (command === 'ollama') return { status: 0, stdout: 'ollama version is 0.32.1\n', stderr: '' };
      if (command === 'opencode') return { status: 0, stdout: 'opencode 1.18.4\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    },
  });
  const serialized = JSON.stringify(result).toLowerCase();
  for (const forbidden of ['credential', 'password', 'sessionid', 'api_key', 'api-key', 'homedir', 'cwd', 'executablepath']) {
    assert.equal(serialized.includes(forbidden), false, `restricted readiness field leaked: ${forbidden}`);
  }
});
