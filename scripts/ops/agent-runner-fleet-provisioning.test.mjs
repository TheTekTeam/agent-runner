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

test('Claude and Codex expose reviewed runtime contracts while only Claude is qualification-eligible', () => {
  const claude = fleetAdapterRuntimeContract('claude-code-cli');
  assert.equal(claude.sourceSupported, true);
  assert.equal(claude.executable, 'claude');
  assert.equal(claude.liveDispatchImplemented, true);
  assert.equal(claude.qualificationEligible, true);
  assert.deepEqual(claude.versionProbe, { command: 'claude', args: ['--version'] });
  assert.deepEqual(claude.installationMechanism, {
    kind: 'apt-repository',
    operatingSystems: ['ubuntu', 'debian'],
    channel: 'stable',
    packageName: 'claude-code',
    repositoryUrl: 'https://downloads.claude.ai/claude-code/apt/stable',
    suite: 'stable',
    component: 'main',
    signingKeyUrl: 'https://downloads.claude.ai/keys/claude-code.asc',
    signingKeyFingerprint: '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE',
    installer: 'scripts/install-agent-runner-fleet-runtime.sh',
    automaticProviderAuth: false,
    automaticQualification: false,
    automaticRoutingActivation: false,
  });

  const codex = fleetAdapterRuntimeContract('codex-cli');
  assert.equal(codex.sourceSupported, true);
  assert.equal(codex.executable, 'codex');
  assert.equal(codex.liveDispatchImplemented, false);
  assert.equal(codex.qualificationEligible, false);
  assert.deepEqual(codex.versionProbe, { command: 'codex', args: ['--version'] });
  assert.deepEqual(codex.installationMechanism, {
    kind: 'npm-global-package',
    operatingSystems: ['ubuntu', 'debian'],
    channel: 'latest',
    packageName: '@openai/codex',
    packageSpec: '@openai/codex@latest',
    registryUrl: 'https://registry.npmjs.org/',
    installer: 'scripts/install-agent-runner-fleet-runtime.sh',
    automaticProviderAuth: false,
    automaticQualification: false,
    automaticRoutingActivation: false,
  });

  for (const adapterId of ['grok-cli', 'ollama-agent']) {
    const contract = fleetAdapterRuntimeContract(adapterId);
    assert.equal(contract.sourceSupported, false);
    assert.equal(contract.executable, null);
    assert.equal(contract.installationMechanism, null);
    assert.equal(contract.liveDispatchImplemented, false);
    assert.equal(contract.qualificationEligible, false);
    assert.equal(contract.reason, 'adapter-foundation-not-live');
  }
});

test('missing runtime, unknown auth, unavailable auth and qualification remain distinct', () => {
  const missing = evaluateFleetAdapterEvidence({ nodeId: 'dev-cluster-z790', adapterId: 'claude-code-cli' });
  assert.equal(missing.state, 'runtime-missing');
  assert.equal(missing.qualified, false);

  const installed = evaluateFleetAdapterEvidence({
    nodeId: 'dev-cluster-z790',
    adapterId: 'claude-code-cli',
    evidence: { runtimeInstalled: true, version: '2.1.233' },
  });
  assert.equal(installed.state, 'runtime-installed');
  assert.equal(installed.reason, 'machine-local-auth-unknown');
  assert.equal(installed.authAvailable, null);

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

test('Codex runtime evidence cannot bypass the default-disabled execution/qualification gate', () => {
  const installed = evaluateFleetAdapterEvidence({
    nodeId: 'dev-cluster-z790',
    adapterId: 'codex-cli',
    evidence: {
      runtimeInstalled: true,
      version: '0.128.0',
    },
  });
  assert.equal(installed.state, 'runtime-installed');
  assert.equal(installed.runtimeInstalled, true);
  assert.equal(installed.reason, 'machine-local-auth-unknown');
  assert.equal(installed.qualified, false);

  const fabricated = evaluateFleetAdapterEvidence({
    nodeId: 'dev-cluster-z790',
    adapterId: 'codex-cli',
    evidence: {
      runtimeInstalled: true,
      version: '0.128.0',
      authAvailable: true,
      qualified: true,
      qualificationRevision: 'fabricated',
      providerAccountClass: 'codex-chatgpt-primary',
      models: ['gpt-5.6-sol'],
      profiles: ['critical'],
      jobClasses: ['implementation'],
    },
  });
  assert.equal(fabricated.state, 'authenticated');
  assert.equal(fabricated.reason, 'adapter-qualification-not-live');
  assert.equal(fabricated.runtimeInstalled, true);
  assert.equal(fabricated.authAvailable, true);
  assert.equal(fabricated.qualified, false);
  assert.equal(fabricated.qualificationRevision, null);

  const instance = buildFleetAgentInstance(fabricated);
  assert.equal(instance.lifecycle, 'disabled');
  assert.equal(instance.readiness, 'degraded');
  assert.equal(instance.authenticated, true);
  assert.equal(instance.qualified, false);
});

test('unsupported Grok/Ollama foundations cannot be promoted by fabricated host evidence', () => {
  for (const adapterId of ['grok-cli', 'ollama-agent']) {
    const evaluated = evaluateFleetAdapterEvidence({
      nodeId: 'dev-cluster-z790',
      adapterId,
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
  }
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
      'codex-cli': {
        runtimeInstalled: true,
        version: '0.128.0',
        authAvailable: false,
        OPENAI_API_KEY: 'secret',
        CODEX_HOME: '/home/gp/.codex',
      },
    },
  });
  const serialized = JSON.stringify(projection);
  for (const forbidden of ['secret', '/home/gp', 'provider output', 'restricted', 'credential', 'password', 'sessionId', 'OPENAI_API_KEY', 'CODEX_HOME']) {
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
