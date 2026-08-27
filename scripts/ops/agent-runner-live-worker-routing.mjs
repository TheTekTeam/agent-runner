import { buildWorkerRegistry, selectWorkerRoute } from './agent-runner-worker-pool.mjs';
import {
  loadLiveWorkerRegistryDocument,
  resolveLiveWorkerRegistryPath,
} from './agent-runner-live-worker-registry-store.mjs';

export const LIVE_WORKER_REGISTRY_ENV = 'AGENT_RUNNER_WORKER_REGISTRY_JSON';
export const REMOTE_WORKER_DISPATCH_ENV = 'AGENT_RUNNER_REMOTE_WORKER_DISPATCH_ENABLED';
export const WORKER_NODE_PREFERENCE_ENV = 'AGENT_RUNNER_WORKER_NODE_PREFERENCE';
export const LIVE_WORKER_REGISTRY_MAX_BYTES = 64 * 1024;

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function nodeId(value, name = 'nodeId') {
  const normalized = String(value || '').trim();
  if (!NODE_ID.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function nodePreference(env = process.env) {
  const raw = String(env[WORKER_NODE_PREFERENCE_ENV] || '').trim();
  if (!raw) return [];
  const values = raw.split(',').map((value) => nodeId(value.trim(), WORKER_NODE_PREFERENCE_ENV));
  return [...new Set(values)];
}

export function parseLiveWorkerRegistry(env = process.env, { expectedControllerNodeId = null } = {}) {
  const raw = String(env[LIVE_WORKER_REGISTRY_ENV] || '').trim();
  let registry;

  if (raw) {
    if (Buffer.byteLength(raw, 'utf8') > LIVE_WORKER_REGISTRY_MAX_BYTES) {
      throw new Error(`${LIVE_WORKER_REGISTRY_ENV} exceeds ${LIVE_WORKER_REGISTRY_MAX_BYTES} bytes`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${LIVE_WORKER_REGISTRY_ENV} must contain valid JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${LIVE_WORKER_REGISTRY_ENV} must contain a JSON object`);
    }
    registry = buildWorkerRegistry({
      controllerNodeId: parsed.controllerNodeId,
      nodes: parsed.nodes,
      agentInstances: parsed.agentInstances || [],
      providerAccountCaps: parsed.providerAccountCaps || {},
      revision: parsed.revision || '1',
    });
    if (parsed.registryFingerprint && parsed.registryFingerprint !== registry.registryFingerprint) {
      throw new Error('worker registry fingerprint mismatch');
    }
    registry = Object.freeze({ ...registry, registrySource: 'environment-compatibility' });
  } else {
    const loaded = loadLiveWorkerRegistryDocument({
      path: resolveLiveWorkerRegistryPath(env),
      allowMissing: true,
    });
    registry = loaded.registry
      ? Object.freeze({ ...loaded.registry, registrySource: 'canonical-store', documentRevision: loaded.revision })
      : null;
  }

  if (expectedControllerNodeId && registry
    && registry.controllerNodeId !== nodeId(expectedControllerNodeId, 'expectedControllerNodeId')) {
    throw new Error('worker registry controller does not match the Dell controller identity');
  }
  return registry;
}

export function remoteWorkerDispatchEnabled(env = process.env) {
  return truthy(env[REMOTE_WORKER_DISPATCH_ENV]);
}

export function resolveLiveWorkerRoute({
  adapterId,
  localNodeId,
  registry = null,
  env = process.env,
  jobClass = 'implementation',
  model = null,
  profile = null,
  requiredCapabilities = [],
  remoteDispatchAvailable = null,
  requireHardAdmission = null,
} = {}) {
  const local = nodeId(localNodeId, 'localNodeId');
  const adapter = String(adapterId || '').trim();
  if (!adapter) throw new Error('adapterId is required');

  if (!registry) {
    return Object.freeze({
      allowed: true,
      reason: 'local-compatibility-route',
      nodeId: local,
      agentInstanceId: `${adapter}@${local}`,
      adapterId: adapter,
      remote: false,
      registryFingerprint: null,
      routeEvidence: null,
    });
  }

  const remoteEnabled = remoteDispatchAvailable === null
    ? remoteWorkerDispatchEnabled(env)
    : remoteDispatchAvailable === true;
  const configuredPreference = nodePreference(env);
  const preferredNodeIds = remoteEnabled
    ? configuredPreference
    : [local, ...configuredPreference.filter((value) => value !== local)];
  const hardAdmission = requireHardAdmission === null
    ? registry.registrySource === 'canonical-store'
    : requireHardAdmission === true;
  const route = selectWorkerRoute(registry, {
    adapterId: adapter,
    jobClass,
    model,
    profile,
    requiredCapabilities,
    preferredNodeIds,
    requireZeroPaidPosture: hardAdmission,
    enforceProviderAccountCapacity: hardAdmission,
  });
  if (!route.selected) {
    return Object.freeze({
      allowed: false,
      reason: 'no-qualified-worker-route',
      nodeId: null,
      agentInstanceId: null,
      adapterId: adapter,
      remote: false,
      registryFingerprint: registry.registryFingerprint,
      routeEvidence: route,
      hardAdmission,
    });
  }
  const selectedRemote = route.selected.nodeId !== local;
  if (selectedRemote && !remoteEnabled) {
    return Object.freeze({
      allowed: false,
      reason: 'remote-worker-dispatch-not-activated',
      nodeId: route.selected.nodeId,
      agentInstanceId: route.selected.instanceId,
      adapterId: adapter,
      remote: true,
      registryFingerprint: registry.registryFingerprint,
      routeEvidence: route,
      hardAdmission,
    });
  }
  return Object.freeze({
    allowed: true,
    reason: selectedRemote ? 'qualified-remote-worker-route' : 'qualified-local-worker-route',
    nodeId: route.selected.nodeId,
    agentInstanceId: route.selected.instanceId,
    adapterId: adapter,
    remote: selectedRemote,
    registryFingerprint: registry.registryFingerprint,
    routeEvidence: route,
    hardAdmission,
  });
}

export function safeWorkerRouteEvidence(route) {
  if (!route) return null;
  return Object.freeze({
    allowed: route.allowed === true,
    reason: route.reason || null,
    nodeId: route.nodeId || null,
    agentInstanceId: route.agentInstanceId || null,
    adapterId: route.adapterId || null,
    remote: route.remote === true,
    registryFingerprint: route.registryFingerprint || null,
    eligible: Array.isArray(route.routeEvidence?.eligible) ? route.routeEvidence.eligible : [],
    excluded: Array.isArray(route.routeEvidence?.excluded) ? route.routeEvidence.excluded : [],
    hardAdmission: route.hardAdmission === true,
  });
}
