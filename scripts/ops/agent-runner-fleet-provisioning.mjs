import { createHash } from 'node:crypto';

import { AGENT_ADAPTERS } from './agent-runner-agents.mjs';

export const FLEET_PROVISIONING_SCHEMA_VERSION = 1;
export const FLEET_PROVISIONING_REVISION = 'fleet-provisioning-v1';
export const FLEET_ADAPTER_STATES = Object.freeze([
  'runtime-missing',
  'runtime-installed',
  'auth-required',
  'authenticated',
  'qualified',
  'disabled',
  'unsupported',
]);

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const INITIAL_FLEET_ADAPTERS = Object.freeze([
  'claude-code-cli',
  'codex-cli',
  'grok-cli',
  'ollama-agent',
]);

const CLAUDE_CODE_APT_INSTALLATION = Object.freeze({
  kind: 'apt-repository',
  operatingSystems: Object.freeze(['ubuntu', 'debian']),
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

// OpenAI's current Codex CLI documentation publishes the npm package below as
// a supported installation mechanism. This fleet contract only installs and
// version-probes the runtime. It does not make the existing default-disabled
// #48 adapter routable, authenticate ChatGPT/OpenAI, inspect API keys or infer
// quota/qualification. Those remain separate #186 machine-local gates.
const CODEX_CLI_NPM_INSTALLATION = Object.freeze({
  kind: 'npm-global-package',
  operatingSystems: Object.freeze(['ubuntu', 'debian']),
  channel: 'latest',
  packageName: '@openai/codex',
  packageSpec: '@openai/codex@latest',
  registryUrl: 'https://registry.npmjs.org/',
  installer: 'scripts/install-agent-runner-fleet-runtime.sh',
  automaticProviderAuth: false,
  automaticQualification: false,
  automaticRoutingActivation: false,
});

const FLEET_RUNTIME_FOUNDATIONS = Object.freeze({
  'claude-code-cli': Object.freeze({
    executable: 'claude',
    versionProbe: Object.freeze({ command: 'claude', args: Object.freeze(['--version']) }),
    installationMechanism: CLAUDE_CODE_APT_INSTALLATION,
  }),
  'codex-cli': Object.freeze({
    executable: 'codex',
    versionProbe: Object.freeze({ command: 'codex', args: Object.freeze(['--version']) }),
    installationMechanism: CODEX_CLI_NPM_INSTALLATION,
  }),
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}

function token(value, name) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function optionalToken(value, name) {
  if (value === undefined || value === null || value === '') return null;
  return token(value, name);
}

function boundedTokens(values, name, max = 64) {
  if (!Array.isArray(values) || values.length > max) throw new Error(`${name} is invalid`);
  return [...new Set(values.map((value) => token(value, name)))].sort();
}

function normalizeVersion(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !VERSION.test(value)) throw new Error('version is invalid');
  return value;
}

function booleanOrNull(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new Error(`${name} is invalid`);
  return value;
}

export function supportedFleetAdapterIds() {
  return [...INITIAL_FLEET_ADAPTERS];
}

export function fleetAdapterRuntimeContract(adapterId) {
  const id = token(adapterId, 'adapterId');
  const adapter = AGENT_ADAPTERS[id];
  const foundation = FLEET_RUNTIME_FOUNDATIONS[id];
  if (!adapter || !INITIAL_FLEET_ADAPTERS.includes(id) || !foundation) {
    return Object.freeze({
      adapterId: id,
      sourceSupported: false,
      executable: null,
      versionProbe: null,
      installationMechanism: null,
      liveDispatchImplemented: false,
      qualificationEligible: false,
      reason: 'adapter-foundation-not-live',
    });
  }

  // Fleet runtime provisioning is intentionally separate from live adapter
  // dispatch. A runtime may be installed/version-probed before its execution
  // adapter is qualified. Only an already-implemented canonical adapter whose
  // executable matches this reviewed runtime may accept qualified fleet
  // evidence. This prevents fabricated host evidence from promoting Codex
  // merely because its binary was installed.
  const liveDispatchImplemented = adapter.implemented === true
    && typeof adapter.command === 'string'
    && adapter.command === foundation.executable;
  return Object.freeze({
    adapterId: id,
    sourceSupported: true,
    executable: foundation.executable,
    versionProbe: foundation.versionProbe,
    installationMechanism: foundation.installationMechanism,
    liveDispatchImplemented,
    qualificationEligible: liveDispatchImplemented,
    reason: null,
  });
}

export function evaluateFleetAdapterEvidence({ nodeId, adapterId, evidence = {} } = {}) {
  const node = token(nodeId, 'nodeId');
  const id = token(adapterId, 'adapterId');
  const contract = fleetAdapterRuntimeContract(id);

  const enabled = evidence.enabled !== false;
  const runtimeInstalled = evidence.runtimeInstalled === true;
  const authAvailable = booleanOrNull(evidence.authAvailable, 'authAvailable');
  const qualified = evidence.qualified === true;
  const version = normalizeVersion(evidence.version);
  const qualificationRevision = optionalToken(evidence.qualificationRevision, 'qualificationRevision');
  const providerAccountClass = optionalToken(evidence.providerAccountClass, 'providerAccountClass');
  const models = boundedTokens(evidence.models || [], 'models');
  const profiles = boundedTokens(evidence.profiles || [], 'profiles');
  const jobClasses = boundedTokens(evidence.jobClasses || [], 'jobClasses');
  const toolchainFingerprints = boundedTokens(evidence.toolchainFingerprints || [], 'toolchainFingerprints');

  let state;
  let reason = null;
  if (!contract.sourceSupported) {
    state = 'unsupported';
    reason = contract.reason;
  } else if (!enabled) {
    state = 'disabled';
    reason = 'instance-disabled-by-policy';
  } else if (!runtimeInstalled) {
    state = 'runtime-missing';
    reason = 'runtime-not-installed';
  } else if (authAvailable === null) {
    state = 'runtime-installed';
    reason = 'machine-local-auth-unknown';
  } else if (authAvailable === false) {
    state = 'auth-required';
    reason = 'machine-local-auth-unavailable';
  } else if (!contract.qualificationEligible) {
    state = 'authenticated';
    reason = 'adapter-qualification-not-live';
  } else if (!qualified) {
    state = 'authenticated';
    reason = 'per-node-qualification-required';
  } else if (!qualificationRevision) {
    state = 'authenticated';
    reason = 'qualification-revision-missing';
  } else {
    state = 'qualified';
  }

  if (!FLEET_ADAPTER_STATES.includes(state)) throw new Error('fleet adapter state is invalid');
  if (state === 'qualified' && !version) throw new Error('qualified adapter requires a bounded version');

  const payload = {
    schemaVersion: FLEET_PROVISIONING_SCHEMA_VERSION,
    revision: FLEET_PROVISIONING_REVISION,
    nodeId: node,
    adapterId: id,
    instanceId: `${id}@${node}`,
    state,
    reason,
    runtimeInstalled: contract.sourceSupported && runtimeInstalled,
    version: contract.sourceSupported ? version : null,
    authAvailable: contract.sourceSupported ? authAvailable : null,
    qualified: state === 'qualified',
    qualificationRevision: state === 'qualified' ? qualificationRevision : null,
    providerAccountClass: contract.sourceSupported ? providerAccountClass : null,
    models: contract.sourceSupported ? models : [],
    profiles: contract.sourceSupported ? profiles : [],
    jobClasses: contract.sourceSupported ? jobClasses : [],
    toolchainFingerprints: contract.sourceSupported ? toolchainFingerprints : [],
  };
  return Object.freeze({ ...payload, evidenceFingerprint: digest(payload) });
}

export function buildFleetAgentInstance(evaluated, { maxConcurrent = 1, active = 0 } = {}) {
  if (!evaluated || evaluated.schemaVersion !== FLEET_PROVISIONING_SCHEMA_VERSION) {
    throw new Error('evaluated fleet evidence is required');
  }
  const maximum = Number(maxConcurrent);
  const current = Number(active);
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 128) throw new Error('maxConcurrent is invalid');
  if (!Number.isSafeInteger(current) || current < 0 || current > maximum) throw new Error('active is invalid');

  const ready = evaluated.state === 'qualified';
  return Object.freeze({
    nodeId: evaluated.nodeId,
    adapterId: evaluated.adapterId,
    lifecycle: ready ? 'enabled' : 'disabled',
    readiness: ready ? 'ready' : (evaluated.state === 'unsupported' || evaluated.state === 'runtime-missing' ? 'unavailable' : 'degraded'),
    authenticated: evaluated.authAvailable === true,
    qualified: ready,
    qualificationRevision: ready ? evaluated.qualificationRevision : 'unqualified',
    providerAccountClass: evaluated.providerAccountClass,
    models: evaluated.models,
    profiles: evaluated.profiles,
    jobClasses: evaluated.jobClasses,
    maxConcurrent: maximum,
    active: current,
  });
}

export function buildFleetProvisioningProjection({ nodeId, adapterEvidence = {} } = {}) {
  const node = token(nodeId, 'nodeId');
  if (!adapterEvidence || typeof adapterEvidence !== 'object' || Array.isArray(adapterEvidence)) {
    throw new Error('adapterEvidence is invalid');
  }
  const adapters = INITIAL_FLEET_ADAPTERS.map((adapterId) => evaluateFleetAdapterEvidence({
    nodeId: node,
    adapterId,
    evidence: adapterEvidence[adapterId] || {},
  }));
  const payload = {
    schemaVersion: FLEET_PROVISIONING_SCHEMA_VERSION,
    revision: FLEET_PROVISIONING_REVISION,
    nodeId: node,
    adapters,
  };
  return Object.freeze({ ...payload, projectionFingerprint: digest(payload) });
}

export function assertWorkerOnlyFleetNode(node = {}) {
  const nodeId = token(node.nodeId, 'nodeId');
  if (node.controller === true) throw new Error('worker-only fleet node cannot be controller');
  if (node.workerOnly !== true) throw new Error('worker-only fleet node must be explicitly marked workerOnly');
  if (node.scheduler === true || node.manager === true || node.sourceActivation === true) {
    throw new Error('worker-only fleet node contains forbidden control authority');
  }
  return Object.freeze({ nodeId, workerOnly: true, controller: false });
}
