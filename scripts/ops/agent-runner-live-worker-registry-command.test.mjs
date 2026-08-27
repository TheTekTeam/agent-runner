import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { main } from './agent-runner-live-worker-registry-command.mjs';

const COMMAND = new URL('./agent-runner-live-worker-registry-command.mjs', import.meta.url);

const CODEX_REVISION = 'codex-z790-58e9d9edf45669ac';
const CODEX_FINGERPRINT = 'sha256:58e9d9edf45669ac354bc400c4a7bf3ccd3b3e7bce92544f7eaba76895a43dbf';

function rawRegistry() {
  return {
    controllerNodeId: 'dev-cluster-dell',
    nodes: [
      {
        nodeId: 'dev-cluster-dell',
        state: 'enabled',
        readiness: 'ready',
        controller: true,
        workerOnly: false,
        os: 'linux',
        arch: 'x64',
        capabilities: ['git'],
        toolchains: ['node22'],
        jobClasses: ['implementation'],
        capacity: { maxConcurrent: 2, available: 2 },
        healthRevision: 'dell-live-1',
      },
      {
        nodeId: 'dev-cluster-z790',
        state: 'enabled',
        readiness: 'ready',
        controller: false,
        workerOnly: true,
        os: 'linux',
        arch: 'x64',
        capabilities: ['git'],
        toolchains: ['node22'],
        jobClasses: ['implementation'],
        capacity: { maxConcurrent: 2, available: 2 },
        healthRevision: 'z790-live-1',
      },
    ],
    agentInstances: [
      {
        nodeId: 'dev-cluster-z790',
        adapterId: 'codex-cli',
        lifecycle: 'disabled',
        readiness: 'ready',
        authenticated: true,
        qualified: true,
        qualificationRevision: CODEX_REVISION,
        qualificationEvidenceFingerprint: CODEX_FINGERPRINT,
        providerAccountClass: 'chatgpt',
        costPosture: 'included-subscription',
        paid: false,
        models: ['gpt-5.6-terra'],
        profiles: ['codex-canary-v1'],
        jobClasses: ['implementation'],
        maxConcurrent: 1,
        active: 0,
      },
    ],
    providerAccountCaps: { chatgpt: 1 },
  };
}

function run(args, { env, input = '' } = {}) {
  return spawnSync(process.execPath, [COMMAND.pathname, ...args], {
    env,
    input,
    encoding: 'utf8',
  });
}

test('default CLI inspect entrypoint is safe on any host and write path remains Dell-bound', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-fleet-cli-'));
  const path = join(root, 'live-worker-registry.json');
  const env = {
    ...process.env,
    HOME: root,
    AGENT_RUNNER_WORKER_REGISTRY_PATH: path,
  };
  try {
    const inspectMissing = run(['inspect'], { env });
    assert.equal(inspectMissing.status, 0);
    const missingPayload = JSON.parse(inspectMissing.stdout);
    assert.equal(missingPayload.ok, true);
    assert.equal(missingPayload.registry.found, false);

    let output = '';
    const replaceExit = main(['replace', '--expected-revision', '0'], {
      env,
      hostnameFn: () => 'dev-cluster-dell',
      readFn: () => JSON.stringify(rawRegistry()),
      writeFn: (value) => { output += value; },
    });
    assert.equal(replaceExit, 0, output);
    const replaced = JSON.parse(output);
    assert.equal(replaced.ok, true);
    assert.equal(replaced.registry.revision, 1);
    assert.equal(replaced.registry.instances[0].lifecycle, 'disabled');

    output = '';
    const badTransitionExit = main([
      'transition',
      '--expected-revision', '1',
      '--instance', 'codex-cli@dev-cluster-z790',
      '--state', 'enabled',
    ], {
      env,
      hostnameFn: () => 'dev-cluster-dell',
      writeFn: (value) => { output += value; },
    });
    assert.equal(badTransitionExit, 1);
    assert.equal(JSON.parse(output).errorCode, 'live-worker-registry-activation-authority-revision-invalid');

    output = '';
    const transitionExit = main([
      'transition',
      '--expected-revision', '1',
      '--instance', 'codex-cli@dev-cluster-z790',
      '--state', 'enabled',
      '--authority-revision', 'AR402-FLEET-ACTIVATION-CLI-1',
      '--authority-fingerprint', `sha256:${'9'.repeat(64)}`,
    ], {
      env,
      hostnameFn: () => 'dev-cluster-dell',
      writeFn: (value) => { output += value; },
    });
    assert.equal(transitionExit, 0, output);
    const transitioned = JSON.parse(output);
    assert.equal(transitioned.registry.revision, 2);
    assert.equal(transitioned.registry.instances[0].lifecycle, 'enabled');
    assert.equal(transitioned.registry.instances[0].qualificationRevision, CODEX_REVISION);

    output = '';
    const wrongHostExit = main([
      'transition',
      '--expected-revision', '2',
      '--instance', 'codex-cli@dev-cluster-z790',
      '--state', 'disabled',
    ], {
      env,
      hostnameFn: () => 'dev-cluster-z790',
      writeFn: (value) => { output += value; },
    });
    assert.equal(wrongHostExit, 1);
    assert.equal(JSON.parse(output).errorCode, 'live-worker-registry-controller-write-refused');

    const inspect = run(['inspect'], { env });
    assert.equal(inspect.status, 0);
    const finalPayload = JSON.parse(inspect.stdout);
    assert.equal(finalPayload.registry.revision, 2);
    assert.equal(finalPayload.registry.instances[0].lifecycle, 'enabled');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
