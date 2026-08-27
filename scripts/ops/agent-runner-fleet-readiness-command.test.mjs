import assert from 'node:assert/strict';
import test from 'node:test';

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  collectFleetReadiness,
  probeFleetRuntime,
} from './agent-runner-fleet-readiness-command.mjs';

const COMMAND_PATH = fileURLToPath(new URL('./agent-runner-fleet-readiness-command.mjs', import.meta.url));

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
  const claudeCall = calls.find((call) => call.command === 'claude');
  const codexCall = calls.find((call) => call.command === 'codex');
  const ollamaCall = calls.find((call) => call.command === 'ollama');
  const opencodeCall = calls.find((call) => call.command === 'opencode');

  assert.deepEqual(Object.keys(claudeCall.options.env), ['PATH']);
  assert.deepEqual(Object.keys(codexCall.options.env), ['PATH']);
  assert.deepEqual(Object.keys(opencodeCall.options.env), ['PATH']);
  assert.deepEqual(Object.keys(ollamaCall.options.env), ['PATH', 'HOME']);
  assert.equal(ollamaCall.options.env.HOME, process.env.HOME || '');
  assert.equal('OLLAMA_HOST' in ollamaCall.options.env, false);
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
  assert.equal(ollama.reason, 'per-node-qualification-required');
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

function installedRunner(command) {
  if (command === 'claude') return { status: 0, stdout: '2.1.233\n', stderr: '' };
  if (command === 'codex') return { status: 0, stdout: 'codex-cli 0.128.0\n', stderr: '' };
  if (command === 'ollama') return { status: 0, stdout: 'ollama version is 0.32.1\n', stderr: '' };
  if (command === 'opencode') return { status: 0, stdout: 'opencode 1.18.4\n', stderr: '' };
  return { status: 1, stdout: '', stderr: '' };
}

test('live readiness projection consumes accepted qualification evidence without enabling routing', () => {
  const accepted = [{
    accepted: true,
    qualified: true,
    nodeId: 'dev-cluster-z790',
    agentInstanceId: 'claude-code-cli@dev-cluster-z790',
    baseSha: 'a'.repeat(40),
    jobFingerprint: `sha256:${'1'.repeat(64)}`,
    resultFingerprint: `sha256:${'2'.repeat(64)}`,
    qualificationRevision: 'claude-z790-7e13ce3be223baf8',
    evidence: {
      claudeVersion: '2.0.14',
      providerClass: 'anthropic',
      model: 'sonnet',
      profile: 'narrow',
      effort: 'low',
      permissionMode: 'dontAsk',
      toolPolicyFingerprint: `sha256:${'3'.repeat(64)}`,
    },
  }];

  const result = collectFleetReadiness({
    nodeId: 'dev-cluster-z790',
    workerOnly: true,
    runner: installedRunner,
    acceptedQualificationResults: accepted,
  });

  const pub = result.qualificationPublication;
  assert.equal(pub.normalRoutingEnabled, false);
  assert.equal(pub.controllerNodeId, 'dev-cluster-dell');

  const z790Claude = pub.instances.find((entry) => entry.instanceId === 'claude-code-cli@dev-cluster-z790');
  assert.equal(z790Claude.published, true);
  assert.equal(z790Claude.qualified, true);
  assert.equal(z790Claude.routable, false);
  assert.equal(z790Claude.normalRoutingEnabled, false);
  assert.equal(z790Claude.qualificationRevision, 'claude-z790-7e13ce3be223baf8');

  const dellClaude = pub.instances.find((entry) => entry.instanceId === 'claude-code-cli@dev-cluster-dell');
  assert.equal(dellClaude.published, false);
  assert.equal(dellClaude.state, 'evidence-gap');

  // Runtime probes remain unqualified regardless of published evidence.
  assert.equal(result.provisioningProjection.adapters.every((entry) => entry.qualified === false), true);
  assert.equal(result.controllerAuthorityGranted, false);
});

test('explicit empty accepted evidence publishes all four instances as non-routable evidence gaps', () => {
  const result = collectFleetReadiness({
    nodeId: 'dev-cluster-z790', workerOnly: true, runner: installedRunner, acceptedQualificationResults: [],
  });
  const pub = result.qualificationPublication;
  assert.equal(pub.normalRoutingEnabled, false);
  assert.equal(pub.instances.length, 4);
  assert.equal(pub.instances.every((entry) => entry.published === false && entry.routable === false), true);
});

test('default readiness path consumes the canonical accepted Z790 evidence without enabling routing', () => {
  const result = collectFleetReadiness({ nodeId: 'dev-cluster-z790', workerOnly: true, runner: installedRunner });
  const pub = result.qualificationPublication;
  assert.equal(pub.normalRoutingEnabled, false);

  const published = pub.instances.filter((entry) => entry.published === true);
  assert.deepEqual(published.map((entry) => entry.instanceId).sort(), [
    'claude-code-cli@dev-cluster-z790',
    'codex-cli@dev-cluster-z790',
  ]);
  for (const entry of published) {
    assert.equal(entry.qualified, true);
    assert.equal(entry.routable, false);
    assert.equal(entry.routingEligible, false);
    assert.equal(entry.normalRoutingEnabled, false);
    assert.equal(entry.lifecycle, 'disabled');
  }
  const z790Claude = published.find((entry) => entry.instanceId === 'claude-code-cli@dev-cluster-z790');
  assert.equal(z790Claude.qualificationRevision, 'claude-z790-7e13ce3be223baf8');
  assert.equal(z790Claude.installedVersion, '2.1.231');
  const z790Codex = published.find((entry) => entry.instanceId === 'codex-cli@dev-cluster-z790');
  assert.equal(z790Codex.qualificationRevision, 'codex-z790-58e9d9edf45669ac');
  assert.equal(z790Codex.installedVersion, '0.146.0');

  for (const instanceId of ['claude-code-cli@dev-cluster-dell', 'codex-cli@dev-cluster-dell']) {
    const dell = pub.instances.find((entry) => entry.instanceId === instanceId);
    assert.equal(dell.published, false);
    assert.equal(dell.state, 'evidence-gap');
  }
});

test('default CLI entrypoint publishes accepted Z790 evidence and keeps Dell fail-closed', () => {
  const stdout = execFileSync(process.execPath, [COMMAND_PATH, '--node', 'dev-cluster-z790', '--worker-only'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '' },
  });
  const parsed = JSON.parse(stdout);
  const pub = parsed.qualificationPublication;
  assert.equal(pub.normalRoutingEnabled, false);
  assert.equal(parsed.controllerAuthorityGranted, false);

  const z790Claude = pub.instances.find((entry) => entry.instanceId === 'claude-code-cli@dev-cluster-z790');
  const z790Codex = pub.instances.find((entry) => entry.instanceId === 'codex-cli@dev-cluster-z790');
  assert.equal(z790Claude.published, true);
  assert.equal(z790Codex.published, true);
  assert.equal(z790Claude.qualificationRevision, 'claude-z790-7e13ce3be223baf8');
  assert.equal(z790Codex.qualificationRevision, 'codex-z790-58e9d9edf45669ac');
  for (const entry of [z790Claude, z790Codex]) {
    assert.equal(entry.routable, false);
    assert.equal(entry.routingEligible, false);
    assert.equal(entry.lifecycle, 'disabled');
  }
  for (const instanceId of ['claude-code-cli@dev-cluster-dell', 'codex-cli@dev-cluster-dell']) {
    const dell = pub.instances.find((entry) => entry.instanceId === instanceId);
    assert.equal(dell.published, false);
    assert.equal(dell.state, 'evidence-gap');
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
  if (process.env.HOME) {
    assert.equal(JSON.stringify(result).includes(process.env.HOME), false, 'HOME path leaked into readiness evidence');
  }
});
