import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { main } from './agent-runner-live-worker-registry-command.mjs';
import {
  FLEET_ACTIVATION_AUTHORITY_MARKER,
  FLEET_ACTIVATION_AUTHORITY_SCHEMA_VERSION,
  fleetActivationAuthorityFingerprint,
} from './agent-runner-fleet-activation-authority.mjs';

const COMMAND = new URL('./agent-runner-live-worker-registry-command.mjs', import.meta.url);
const SOURCE_SHA = '1'.repeat(40);
const CONTROL_ISSUE = 402;

function promotionInput() {
  return {
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
    runtimeInstances: [
      {
        nodeId: 'dev-cluster-z790',
        adapterId: 'codex-cli',
        installedVersion: '0.146.0',
        readiness: 'ready',
        authenticated: true,
        costPosture: 'included-subscription',
        paid: false,
        maxConcurrent: 1,
        active: 0,
      },
    ],
    providerAccountCaps: { chatgpt: 1 },
  };
}

function authorityComment({ registry, id = 100, state = 'enabled', revision = 'AR402-FLEET-CLI-1' }) {
  const material = {
    schema_version: FLEET_ACTIVATION_AUTHORITY_SCHEMA_VERSION,
    revision,
    target_repository: 'TheTekTeam/agent-runner',
    target_issue: CONTROL_ISSUE,
    target_source_commit: SOURCE_SHA,
    target_registry_revision: registry.revision,
    target_registry_fingerprint: registry.registryFingerprint,
    target_instance: 'codex-cli@dev-cluster-z790',
    target_state: state,
    producer_type: 'normal_chatgpt_manager_session',
    reason: 'supervised-fleet-cli-test',
  };
  const fingerprint = fleetActivationAuthorityFingerprint(material);
  return {
    id,
    user: { login: 'gpcola' },
    body: `${FLEET_ACTIVATION_AUTHORITY_MARKER}
\`\`\`yaml
schema_version: ${material.schema_version}
revision: ${material.revision}
target_repository: ${material.target_repository}
target_issue: ${material.target_issue}
target_source_commit: ${material.target_source_commit}
target_registry_revision: ${material.target_registry_revision}
target_registry_fingerprint: ${material.target_registry_fingerprint}
target_instance: ${material.target_instance}
target_state: ${material.target_state}
producer_type: ${material.producer_type}
reason: ${material.reason}
fingerprint: ${fingerprint}
\`\`\`
`,
  };
}

function run(args, { env, input = '' } = {}) {
  return spawnSync(process.execPath, [COMMAND.pathname, ...args], {
    env,
    input,
    encoding: 'utf8',
  });
}

test('default CLI inspect is host-neutral while promotion/transition remain Dell-bound and GitHub-authorised', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-fleet-cli-'));
  const path = join(root, 'live-worker-registry.json');
  const env = {
    ...process.env,
    HOME: root,
    AGENT_RUNNER_WORKER_REGISTRY_PATH: path,
    AGENT_RUNNER_FLEET_ACTIVATION_CONTROL_ISSUE: String(CONTROL_ISSUE),
    CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola',
  };
  try {
    const inspectMissing = run(['inspect'], { env });
    assert.equal(inspectMissing.status, 0);
    const missingPayload = JSON.parse(inspectMissing.stdout);
    assert.equal(missingPayload.ok, true);
    assert.equal(missingPayload.registry.found, false);

    const planRun = run(['plan', '--expected-revision', '0'], {
      env,
      input: JSON.stringify(promotionInput()),
    });
    assert.equal(planRun.status, 0, planRun.stderr || planRun.stdout);
    const planned = JSON.parse(planRun.stdout);
    assert.equal(planned.mode, 'plan');
    assert.equal(planned.expectedRevision, 0);
    assert.equal(planned.targetRevision, 1);
    assert.equal(planned.registry.instances[0].lifecycle, 'disabled');

    const inspectAfterPlan = run(['inspect'], { env });
    assert.equal(inspectAfterPlan.status, 0);
    assert.equal(JSON.parse(inspectAfterPlan.stdout).registry.found, false);

    let output = '';
    const promoteExit = main(['promote', '--expected-revision', '0'], {
      env,
      hostnameFn: () => 'dev-cluster-dell',
      readFn: () => JSON.stringify(promotionInput()),
      writeFn: (value) => { output += value; },
    });
    assert.equal(promoteExit, 0, output);
    const promoted = JSON.parse(output);
    assert.equal(promoted.registry.revision, 1);
    assert.equal(promoted.registry.instances[0].lifecycle, 'disabled');
    assert.equal(promoted.registry.instances[0].qualificationRevision, 'codex-z790-58e9d9edf45669ac');

    const stalePlanRun = run(['plan', '--expected-revision', '0'], {
      env,
      input: JSON.stringify(promotionInput()),
    });
    assert.equal(stalePlanRun.status, 1);
    assert.equal(JSON.parse(stalePlanRun.stdout).errorCode, 'live-worker-registry-stale-revision');

    output = '';
    const missingAuthorityExit = main([
      'transition',
      '--expected-revision', '1',
      '--instance', 'codex-cli@dev-cluster-z790',
      '--state', 'enabled',
    ], {
      env,
      hostnameFn: () => 'dev-cluster-dell',
      writeFn: (value) => { output += value; },
    });
    assert.equal(missingAuthorityExit, 1);
    assert.equal(JSON.parse(output).errorCode, 'live-worker-registry-command-transition-arguments-required');

    const comment = authorityComment({ registry: promoted.registry });
    output = '';
    const transitionExit = main([
      'transition',
      '--expected-revision', '1',
      '--instance', 'codex-cli@dev-cluster-z790',
      '--state', 'enabled',
      '--authority-comment-id', String(comment.id),
    ], {
      env,
      hostnameFn: () => 'dev-cluster-dell',
      fetchCommentsFn: () => [comment],
      readHeadFn: () => SOURCE_SHA,
      writeFn: (value) => { output += value; },
    });
    assert.equal(transitionExit, 0, output);
    const transitioned = JSON.parse(output);
    assert.equal(transitioned.registry.revision, 2);
    assert.equal(transitioned.registry.instances[0].lifecycle, 'enabled');
    assert.equal(transitioned.registry.activationAuthorities['codex-cli@dev-cluster-z790'].commentId, comment.id);

    output = '';
    const wrongHostExit = main([
      'transition',
      '--expected-revision', '2',
      '--instance', 'codex-cli@dev-cluster-z790',
      '--state', 'disabled',
      '--authority-comment-id', '101',
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
