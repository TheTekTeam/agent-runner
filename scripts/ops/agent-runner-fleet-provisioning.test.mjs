import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertWorkerOnlyFleetNode,
  buildFleetAgentInstance,
  buildFleetProvisioningProjection,
  evaluateFleetAdapterEvidence,
  fleetAdapterRuntimeContract,
  supportedFleetAdapterIds,
} from './agent-runner-fleet-provisioning.mjs';

test('fleet adapter set covers the initial owner-requested runtime set', () => {
  assert.deepEqual(supportedFleetAdapterIds(), [
    'claude-code-cli',
    'codex-cli',
    'grok-cli',
    'ollama-agent',
  ]);
});

test('only the currently implemented canonical adapter exposes a runtime command', () => {
  const claude = fleetAdapterRuntimeContract('claude-code-cli');
  assert.equal(claude.sourceSupported, true);
  assert.equal(claude.executable, 'claude');
  assert.deepEqual(claude.versionProbe, { command: 'claude', args: ['--version'] });
  assert.equal(claude.installationMechanism, null);

  for (const adapterId of ['codex-cli', 'grok-cli', 'ollama-agent']) {
    const contract = fleetAdapterRuntimeContract(adapterId);
    assert.equal(contract.sourceSupported, false);
    assert.equal(contract.executable, null);
    assert.equal(contract.installationMechanism, null);
    assert.equal(contract.reason, 'adapter-foundation-not-live');
  }
});

test('missing runtime, machine-local auth and per-node qualification remain distinct', () => {
  const missing = evaluateFleetAdapterEvidence({ nodeId: 'dev-cluster-z790', adapterId: 'claude-code-cli' });
  assert.equal(missing.state, 'runtime-missing');
  assert.equal(missing.qualified, false);

  const auth = evaluateFleetAdapterEvidence({
    nodeId: 'dev-cluster-z790',
    adapterId: 'claude-code-cli',
    evidence: { runtimeInstalled: true, version: '2.1.233', authAvailable: false },
  });
  assert.equal(auth.state, 'auth-required');
  assert.equal(auth.reason, 'machine-local-auth-unavailable');

  const authenticated = evaluateFleetAdapterEvidence({
    nodeId: 'dev-cluster-z790',
    adapterId: 'claude-code-cli',
    evidence: { runtimeInstalled: true, version: '2.1.233', authAvailable: true },
  });
  assert.equal(authenticated.state, 'authenticated');
  assert.equal(authenticated.reason, 'per-node-qualification-required');
});

test('qualification is exact agent@node evidence and produces a routable worker instance only when complete', () => {
  const evaluated = evaluateFleetAdapterEvidence({
    nodeId: 'dev-cluster-z790',
    adapterId: 'claude-code-cli',
    evidence: {
      runtimeInstalled: true,
      version: '2.1.233',
      authAvailable: true,
      qualified: true,
      qualificationRevision: 'claude-z790-1',
      providerAccountClass: 'claude-subscription-primary',
      models: ['claude-sonnet-5'],
      profiles: ['narrow'],
      jobClasses: ['implementation'],
      toolchainFingerprints: ['sha256:abc'],
    },
  });
  assert.equal(evaluated.instanceId, 'claude-code-cli@dev-cluster-z790');
  assert.equal(evaluated.state, 'qualified');
  assert.equal(evaluated.qualified, true);

  const instance = buildFleetAgentInstance(evaluated, { maxConcurrent: 2, active: 1 });
  assert.deepEqual(instance, {
    nodeId: 'dev-cluster-z790',
    adapterId: 'claude-code-cli',
    lifecycle: 'enabled',
    readiness: 'ready',
    authenticated: true,
    qualified: true,
    qualificationRevision: 'claude-z790-1',
    providerAccountClass: 'claude-subscription-primary',
    models: ['claude-sonnet-5'],
    profiles: ['narrow'],
    jobClasses: ['implementation'],
    maxConcurrent: 2,
    active: 1,
  });
});

test('foundation-only adapters cannot be promoted by fabricated host evidence', () => {
  const evaluated = evaluateFleetAdapterEvidence({
    nodeId: 'dev-cluster-z790',
    adapterId: 'codex-cli',
    evidence: {
      runtimeInstalled: true,
      version: '9.9.9',
      authAvailable: true,
      qualified: true,
      qualificationRevision: 'fabricated',
      models: ['future-model'],
      profiles: ['critical'],
      jobClasses: ['implementation'],
    },
  });
  assert.equal(evaluated.state, 'unsupported');
  assert.equal(evaluated.runtimeInstalled, false);
  assert.equal(evaluated.authAvailable, null);
  assert.equal(evaluated.qualified, false);
  assert.equal(evaluated.qualificationRevision, null);
  assert.deepEqual(evaluated.models, []);
  assert.deepEqual(evaluated.jobClasses, []);

  const instance = buildFleetAgentInstance(evaluated);
  assert.equal(instance.lifecycle, 'disabled');
  assert.equal(instance.readiness, 'unavailable');
  assert.equal(instance.qualified, false);
});

test('qualified evidence requires a bounded installed version and qualification revision', () => {
  assert.throws(() => evaluateFleetAdapterEvidence({
    nodeId: 'dev-cluster-dell',
    adapterId: 'claude-code-cli',
    evidence: {
      runtimeInstalled: true,
      authAvailable: true,
      qualified: true,
      qualificationRevision: 'dell-claude-1',
    },
  }), /qualified adapter requires a bounded version/);

  const missingRevision = evaluateFleetAdapterEvidence({
    nodeId: 'dev-cluster-dell',
    adapterId: 'claude-code-cli',
    evidence: { runtimeInstalled: true, version: '2.1.233', authAvailable: true, qualified: true },
  });
  assert.equal(missingRevision.state, 'authenticated');
  assert.equal(missingRevision.reason, 'qualification-revision-missing');
});

test('disabled instance never becomes routable even with valid auth and qualification evidence', () => {
  const evaluated = evaluateFleetAdapterEvidence({
    nodeId: 'dev-cluster-dell',
    adapterId: 'claude-code-cli',
    evidence: {
      enabled: false,
      runtimeInstalled: true,
      version: '2.1.233',
      authAvailable: true,
      qualified: true,
      qualificationRevision: 'dell-claude-1',
    },
  });
  assert.equal(evaluated.state, 'disabled');
  assert.equal(buildFleetAgentInstance(evaluated).lifecycle, 'disabled');
});

test('projection is bounded and does not serialize credentials, paths, raw environment or output', () => {
  const projection = buildFleetProvisioningProjection({
    nodeId: 'dev-cluster-z790',
    adapterEvidence: {
      'claude-code-cli': {
        runtimeInstalled: true,
        version: '2.1.233',
        authAvailable: false,
        credential: 'secret',
        token: 'secret',
        password: 'secret',
        path: '/home/gp/.config',
        env: { HOME: '/home/gp' },
        stdout: 'provider output',
        sessionId: 'restricted',
      },
    },
  });
  const serialized = JSON.stringify(projection);
  for (const forbidden of ['secret', '/home/gp', 'provider output', 'restricted', 'credential', 'password', 'sessionId']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(projection.adapters.length, 4);
});

test('worker-only topology rejects scheduler, manager, source activation or controller authority', () => {
  assert.deepEqual(assertWorkerOnlyFleetNode({ nodeId: 'dev-cluster-z790', workerOnly: true }), {
    nodeId: 'dev-cluster-z790',
    workerOnly: true,
    controller: false,
  });
  assert.throws(() => assertWorkerOnlyFleetNode({ nodeId: 'dev-cluster-z790', workerOnly: true, controller: true }), /cannot be controller/);
  assert.throws(() => assertWorkerOnlyFleetNode({ nodeId: 'dev-cluster-z790', workerOnly: true, scheduler: true }), /forbidden control authority/);
  assert.throws(() => assertWorkerOnlyFleetNode({ nodeId: 'dev-cluster-z790', workerOnly: true, manager: true }), /forbidden control authority/);
  assert.throws(() => assertWorkerOnlyFleetNode({ nodeId: 'dev-cluster-z790', workerOnly: true, sourceActivation: true }), /forbidden control authority/);
});

test('fleet fingerprints change on node-local auth or qualification state without leaking contents', () => {
  const a = evaluateFleetAdapterEvidence({
    nodeId: 'dev-cluster-dell',
    adapterId: 'claude-code-cli',
    evidence: { runtimeInstalled: true, version: '2.1.233', authAvailable: false },
  });
  const b = evaluateFleetAdapterEvidence({
    nodeId: 'dev-cluster-dell',
    adapterId: 'claude-code-cli',
    evidence: { runtimeInstalled: true, version: '2.1.233', authAvailable: true },
  });
  const c = evaluateFleetAdapterEvidence({
    nodeId: 'dev-cluster-z790',
    adapterId: 'claude-code-cli',
    evidence: { runtimeInstalled: true, version: '2.1.233', authAvailable: true },
  });
  assert.notEqual(a.evidenceFingerprint, b.evidenceFingerprint);
  assert.notEqual(b.evidenceFingerprint, c.evidenceFingerprint);
  assert.match(a.evidenceFingerprint, /^sha256:[a-f0-9]{64}$/);
});
