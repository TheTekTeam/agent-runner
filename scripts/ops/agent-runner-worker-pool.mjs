import { createHash } from 'node:crypto';

export const WORKER_POOL_SCHEMA_VERSION = 1;
export const WORKER_POOL_REVISION = 'worker-pool-v1';
export const WORKER_NODE_STATES = Object.freeze(['enabled', 'paused', 'draining', 'disabled']);
export const WORKER_READINESS_STATES = Object.freeze(['ready', 'degraded', 'unavailable', 'unknown']);
export const WORKER_JOB_CLASSES = Object.freeze(['implementation', 'validation', 'build', 'test', 'local-model']);
export const WORKER_COST_POSTURES = Object.freeze(['included-subscription', 'free', 'local-zero-cost', 'metered', 'unknown']);
export const ZERO_PAID_ROUTE_COST_POSTURES = Object.freeze(['included-subscription', 'free', 'local-zero-cost']);

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{40,64}$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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

function validGitBranchName(value) {
  const name = String(value || '');
  if (!name || name.length > 255) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return false;
  if (name.includes('..') || name.includes('@{') || name === '@') return false;
  if (/[\s~^:?*[\]\\\x00-\x1f\x7f]/.test(name)) return false;
  if (name.endsWith('.')) return false;
  const segments = name.split('/');
  if (segments.some((segment) => !segment || segment.startsWith('.') || segment.endsWith('.lock'))) return false;
  return true;
}

function gitBranch(value, name = 'branch') {
  if (!validGitBranchName(value)) throw new Error(`${name} is invalid`);
  return value;
}

function enumValue(value, allowed, name) {
  if (!allowed.includes(value)) throw new Error(`${name} is invalid`);
  return value;
}

function boundedTokens(values, name, max = 64) {
  if (!Array.isArray(values) || values.length > max) throw new Error(`${name} is invalid`);
  return [...new Set(values.map((value) => token(value, name)))].sort();
}

function boundedOrderedTokens(values, name, max = 64) {
  if (!Array.isArray(values) || values.length > max) throw new Error(`${name} is invalid`);
  return [...new Set(values.map((value) => token(value, name)))];
}

function positiveInteger(value, name, max = 128) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) throw new Error(`${name} is invalid`);
  return number;
}

function normalizeProviderAccountCaps(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('providerAccountCaps is invalid');
  const entries = Object.entries(raw);
  if (entries.length > 64) throw new Error('providerAccountCaps is invalid');
  return Object.freeze(Object.fromEntries(entries.map(([account, value]) => {
    const id = token(account, 'providerAccountCaps account');
    const cap = positiveInteger(value, `providerAccountCaps.${id}`);
    if (cap < 1) throw new Error(`providerAccountCaps.${id} is invalid`);
    return [id, cap];
  }).sort(([a], [b]) => a.localeCompare(b))));
}

export function normalizeWorkerNode(raw = {}) {
  const nodeId = token(raw.nodeId, 'nodeId');
  const state = enumValue(raw.state, WORKER_NODE_STATES, 'node state');
  const readiness = enumValue(raw.readiness, WORKER_READINESS_STATES, 'node readiness');
  const jobClasses = boundedTokens(raw.jobClasses || [], 'jobClasses').map((value) => enumValue(value, WORKER_JOB_CLASSES, 'job class'));
  const capabilities = boundedTokens(raw.capabilities || [], 'capabilities');
  const toolchains = boundedTokens(raw.toolchains || [], 'toolchains');
  const os = token(raw.os, 'os');
  const arch = token(raw.arch, 'arch');
  const capacity = Object.freeze({
    maxConcurrent: positiveInteger(raw.capacity?.maxConcurrent ?? 0, 'capacity.maxConcurrent'),
    available: positiveInteger(raw.capacity?.available ?? 0, 'capacity.available'),
  });
  if (capacity.available > capacity.maxConcurrent) throw new Error('available capacity exceeds maximum');
  const normalized = {
    schemaVersion: WORKER_POOL_SCHEMA_VERSION,
    nodeId,
    state,
    readiness,
    controller: raw.controller === true,
    workerOnly: raw.workerOnly === true,
    os,
    arch,
    capabilities,
    toolchains,
    jobClasses,
    capacity,
    healthRevision: token(raw.healthRevision || 'unknown', 'healthRevision'),
  };
  if (normalized.workerOnly && normalized.controller) throw new Error('worker-only node cannot be controller');
  return Object.freeze({ ...normalized, capabilityFingerprint: digest(normalized) });
}

export function normalizeAgentInstance(raw = {}) {
  const nodeId = token(raw.nodeId, 'nodeId');
  const adapterId = token(raw.adapterId, 'adapterId');
  const instanceId = `${adapterId}@${nodeId}`;
  const lifecycle = enumValue(raw.lifecycle || 'disabled', ['enabled', 'paused', 'draining', 'disabled'], 'agent lifecycle');
  const readiness = enumValue(raw.readiness || 'unknown', WORKER_READINESS_STATES, 'agent readiness');
  const models = boundedTokens(raw.models || [], 'models');
  const profiles = boundedTokens(raw.profiles || [], 'profiles');
  const jobClasses = boundedTokens(raw.jobClasses || [], 'agent jobClasses').map((value) => enumValue(value, WORKER_JOB_CLASSES, 'job class'));
  const normalized = {
    schemaVersion: WORKER_POOL_SCHEMA_VERSION,
    instanceId,
    nodeId,
    adapterId,
    lifecycle,
    readiness,
    authenticated: raw.authenticated === true,
    qualified: raw.qualified === true,
    qualificationRevision: token(raw.qualificationRevision || 'unqualified', 'qualificationRevision'),
    qualificationEvidenceFingerprint: raw.qualificationEvidenceFingerprint == null
      ? null
      : (/^sha256:[a-f0-9]{64}$/.test(String(raw.qualificationEvidenceFingerprint))
        ? String(raw.qualificationEvidenceFingerprint)
        : (() => { throw new Error('qualificationEvidenceFingerprint is invalid'); })()),
    providerAccountClass: raw.providerAccountClass ? token(raw.providerAccountClass, 'providerAccountClass') : null,
    costPosture: enumValue(raw.costPosture || 'unknown', WORKER_COST_POSTURES, 'costPosture'),
    paid: raw.paid === false ? false : true,
    models,
    profiles,
    jobClasses,
    maxConcurrent: positiveInteger(raw.maxConcurrent ?? 1, 'agent maxConcurrent'),
    active: positiveInteger(raw.active ?? 0, 'agent active'),
  };
  if (normalized.active > normalized.maxConcurrent) throw new Error('agent active count exceeds maximum');
  return Object.freeze({ ...normalized, instanceFingerprint: digest(normalized) });
}

export function buildWorkerRegistry({ controllerNodeId, nodes = [], agentInstances = [], providerAccountCaps = {}, revision = '1' } = {}) {
  const controller = token(controllerNodeId, 'controllerNodeId');
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > 64) throw new Error('nodes must contain 1..64 entries');
  if (!Array.isArray(agentInstances) || agentInstances.length > 256) throw new Error('agentInstances is invalid');
  const normalizedNodes = nodes.map(normalizeWorkerNode);
  const nodeIds = new Set();
  for (const node of normalizedNodes) {
    if (nodeIds.has(node.nodeId)) throw new Error(`duplicate worker node: ${node.nodeId}`);
    nodeIds.add(node.nodeId);
  }
  if (!nodeIds.has(controller)) throw new Error('controller node is not registered');
  const controllerRecord = normalizedNodes.find((node) => node.nodeId === controller);
  if (controllerRecord.controller !== true || controllerRecord.workerOnly === true) throw new Error('controller node lacks controller authority');
  if (normalizedNodes.filter((node) => node.controller).length !== 1) throw new Error('exactly one controller is required');

  const normalizedInstances = agentInstances.map(normalizeAgentInstance);
  const instanceIds = new Set();
  for (const instance of normalizedInstances) {
    if (!nodeIds.has(instance.nodeId)) throw new Error(`agent instance references unknown node: ${instance.nodeId}`);
    if (instanceIds.has(instance.instanceId)) throw new Error(`duplicate agent instance: ${instance.instanceId}`);
    instanceIds.add(instance.instanceId);
  }
  const payload = {
    schemaVersion: WORKER_POOL_SCHEMA_VERSION,
    revision: token(String(revision), 'registry revision'),
    controllerNodeId: controller,
    nodes: normalizedNodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    agentInstances: normalizedInstances.sort((a, b) => a.instanceId.localeCompare(b.instanceId)),
    providerAccountCaps: normalizeProviderAccountCaps(providerAccountCaps),
  };
  return Object.freeze({ ...payload, registryFingerprint: digest(payload) });
}

function routeReasons({ node, instance, request, registry }) {
  const reasons = [];
  if (!node) return ['node-not-registered'];
  if (!instance) return ['agent-instance-not-registered'];
  if (node.state !== 'enabled') reasons.push(`node-${node.state}`);
  if (node.readiness !== 'ready') reasons.push(`node-${node.readiness}`);
  if (node.capacity.available < 1) reasons.push('node-capacity-full');
  if (instance.lifecycle !== 'enabled') reasons.push(`agent-${instance.lifecycle}`);
  if (instance.readiness !== 'ready') reasons.push(`agent-${instance.readiness}`);
  if (!instance.authenticated) reasons.push('agent-auth-unavailable');
  if (!instance.qualified) reasons.push('agent-unqualified');
  if (instance.active >= instance.maxConcurrent) reasons.push('agent-capacity-full');
  if (request.requireZeroPaidPosture) {
    if (instance.costPosture === 'unknown') reasons.push('cost-posture-unknown');
    else if (!ZERO_PAID_ROUTE_COST_POSTURES.includes(instance.costPosture) || instance.paid !== false) reasons.push('paid-route-ineligible');
  }
  if (request.enforceProviderAccountCapacity && instance.providerAccountClass) {
    const cap = Number(registry?.providerAccountCaps?.[instance.providerAccountClass] ?? 1);
    const active = (registry?.agentInstances || [])
      .filter((entry) => entry.providerAccountClass === instance.providerAccountClass)
      .reduce((sum, entry) => sum + Number(entry.active || 0), 0);
    if (active >= cap) reasons.push('provider-account-cap-full');
  }
  if (!node.jobClasses.includes(request.jobClass)) reasons.push('node-job-class-unsupported');
  if (!instance.jobClasses.includes(request.jobClass)) reasons.push('agent-job-class-unsupported');
  if (request.model && !instance.models.includes(request.model)) reasons.push('model-unsupported-on-instance');
  if (request.profile && !instance.profiles.includes(request.profile)) reasons.push('profile-unsupported-on-instance');
  for (const capability of request.requiredCapabilities || []) {
    if (!node.capabilities.includes(capability)) reasons.push(`capability-missing:${capability}`);
  }
  return [...new Set(reasons)].sort();
}

function qualificationRouteReasons({ node, instance, request }) {
  const reasons = [];
  if (!node) return ['node-not-registered'];
  if (!instance) return ['agent-instance-not-registered'];
  if (node.controller || !node.workerOnly) reasons.push('qualification-target-not-worker-only');
  if (node.state !== 'enabled') reasons.push(`node-${node.state}`);
  if (node.readiness !== 'ready') reasons.push(`node-${node.readiness}`);
  if (node.capacity.available < 1) reasons.push('node-capacity-full');
  if (instance.lifecycle !== 'enabled') reasons.push(`agent-${instance.lifecycle}`);
  if (instance.readiness !== 'ready') reasons.push(`agent-${instance.readiness}`);
  if (!instance.authenticated) reasons.push('agent-auth-unavailable');
  if (instance.active >= instance.maxConcurrent) reasons.push('agent-capacity-full');
  if (!node.jobClasses.includes(request.jobClass)) reasons.push('node-job-class-unsupported');
  if (!instance.jobClasses.includes(request.jobClass)) reasons.push('agent-job-class-unsupported');
  if (request.model && !instance.models.includes(request.model)) reasons.push('model-unsupported-on-instance');
  if (request.profile && !instance.profiles.includes(request.profile)) reasons.push('profile-unsupported-on-instance');
  for (const capability of request.requiredCapabilities || []) {
    if (!node.capabilities.includes(capability)) reasons.push(`capability-missing:${capability}`);
  }
  return [...new Set(reasons)].sort();
}

/**
 * Qualification routing is deliberately separate from normal worker routing.
 * It may target an installed/authenticated but not-yet-qualified instance only
 * for one exact worker-only node selected by Dell. It does not change the
 * instance's registry qualification bit and cannot make the instance eligible
 * for selectWorkerRoute().
 */
export function selectWorkerQualificationRoute(registry, request = {}) {
  if (!registry || registry.schemaVersion !== WORKER_POOL_SCHEMA_VERSION) throw new Error('valid worker registry is required');
  const nodeId = token(request.nodeId, 'nodeId');
  const adapterId = token(request.adapterId, 'adapterId');
  const jobClass = enumValue(request.jobClass, WORKER_JOB_CLASSES, 'jobClass');
  const requiredCapabilities = boundedTokens(request.requiredCapabilities || [], 'requiredCapabilities');
  const normalizedRequest = {
    nodeId,
    adapterId,
    jobClass,
    model: request.model ? token(request.model, 'model') : null,
    profile: request.profile ? token(request.profile, 'profile') : null,
    requiredCapabilities,
    qualificationOnly: true,
  };
  const node = registry.nodes.find((item) => item.nodeId === nodeId);
  const instance = registry.agentInstances.find((item) => item.nodeId === nodeId && item.adapterId === adapterId);
  const reasons = qualificationRouteReasons({ node, instance, request: normalizedRequest });
  return Object.freeze({
    qualificationOnly: true,
    selected: reasons.length === 0 && node && instance
      ? Object.freeze({ nodeId: node.nodeId, instanceId: instance.instanceId })
      : null,
    eligible: reasons.length === 0 && instance ? [instance.instanceId] : [],
    excluded: reasons.length === 0 || !instance ? [] : [{ instanceId: instance.instanceId, reasons }],
    reasons: Object.freeze(reasons),
    requestFingerprint: digest(normalizedRequest),
    registryFingerprint: registry.registryFingerprint,
  });
}

export function selectWorkerRoute(registry, request = {}) {
  if (!registry || registry.schemaVersion !== WORKER_POOL_SCHEMA_VERSION) throw new Error('valid worker registry is required');
  const adapterId = token(request.adapterId, 'adapterId');
  const jobClass = enumValue(request.jobClass, WORKER_JOB_CLASSES, 'jobClass');
  const requiredCapabilities = boundedTokens(request.requiredCapabilities || [], 'requiredCapabilities');
  const normalizedRequest = {
    adapterId,
    jobClass,
    model: request.model ? token(request.model, 'model') : null,
    profile: request.profile ? token(request.profile, 'profile') : null,
    requiredCapabilities,
    requireZeroPaidPosture: request.requireZeroPaidPosture === true,
    enforceProviderAccountCapacity: request.enforceProviderAccountCapacity === true,
    // Preference order is semantic: the controller's first qualified node
    // must remain first rather than being alphabetically canonicalised.
    preferredNodeIds: boundedOrderedTokens(request.preferredNodeIds || [], 'preferredNodeIds'),
  };
  const order = new Map(normalizedRequest.preferredNodeIds.map((nodeId, index) => [nodeId, index]));
  const candidates = registry.agentInstances
    .filter((instance) => instance.adapterId === adapterId)
    .map((instance) => {
      const node = registry.nodes.find((item) => item.nodeId === instance.nodeId);
      const reasons = routeReasons({ node, instance, request: normalizedRequest, registry });
      return { node, instance, reasons };
    })
    .sort((a, b) => {
      const ap = order.has(a.instance.nodeId) ? order.get(a.instance.nodeId) : Number.MAX_SAFE_INTEGER;
      const bp = order.has(b.instance.nodeId) ? order.get(b.instance.nodeId) : Number.MAX_SAFE_INTEGER;
      return ap - bp || b.node.capacity.available - a.node.capacity.available || a.instance.instanceId.localeCompare(b.instance.instanceId);
    });
  const eligible = candidates.filter((candidate) => candidate.reasons.length === 0);
  return Object.freeze({
    selected: eligible[0] ? Object.freeze({ nodeId: eligible[0].node.nodeId, instanceId: eligible[0].instance.instanceId }) : null,
    eligible: eligible.map((candidate) => candidate.instance.instanceId),
    excluded: candidates.filter((candidate) => candidate.reasons.length).map((candidate) => ({ instanceId: candidate.instance.instanceId, reasons: candidate.reasons })),
    requestFingerprint: digest(normalizedRequest),
    registryFingerprint: registry.registryFingerprint,
  });
}

export function issueWorkerLease({
  registry,
  route,
  projectId,
  repository,
  issueNumber,
  authorityFingerprint,
  baseSha,
  branch,
  worktree,
  adapterId,
  model,
  profile,
  jobClass,
  laneId,
  resourcePartition = null,
  validationProfile,
  expiresAt,
  providerAccountClass = null,
} = {}) {
  if (!registry || route?.selected == null) throw new Error('selected worker route is required');
  const node = registry.nodes.find((item) => item.nodeId === route.selected.nodeId);
  const instance = registry.agentInstances.find((item) => item.instanceId === route.selected.instanceId);
  if (!node || !instance) throw new Error('selected route is absent from registry');
  if (instance.adapterId !== adapterId) throw new Error('selected agent adapter mismatch');
  if (node.controller && node.nodeId !== registry.controllerNodeId) throw new Error('non-canonical controller selected');
  if (!REPO.test(repository || '')) throw new Error('repository is invalid');
  if (!SHA.test(baseSha || '')) throw new Error('baseSha is invalid');
  if (!/^sha256:[a-f0-9]{64}$/.test(authorityFingerprint || '')) throw new Error('authorityFingerprint is invalid');
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error('issueNumber is invalid');
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime())) throw new Error('expiresAt is invalid');
  const payload = {
    schemaVersion: WORKER_POOL_SCHEMA_VERSION,
    revision: WORKER_POOL_REVISION,
    controllerNodeId: registry.controllerNodeId,
    registryFingerprint: registry.registryFingerprint,
    projectId: token(projectId, 'projectId'),
    repository,
    issueNumber,
    authorityFingerprint,
    baseSha: baseSha.toLowerCase(),
    branch: gitBranch(branch),
    worktree: token(worktree, 'worktree'),
    nodeId: node.nodeId,
    agentInstanceId: instance.instanceId,
    adapterId: token(adapterId, 'adapterId'),
    model: model ? token(model, 'model') : null,
    profile: profile ? token(profile, 'profile') : null,
    jobClass: enumValue(jobClass, WORKER_JOB_CLASSES, 'jobClass'),
    laneId: token(laneId, 'laneId'),
    resourcePartition: resourcePartition ? token(resourcePartition, 'resourcePartition') : null,
    validationProfile: token(validationProfile, 'validationProfile'),
    providerAccountClass: providerAccountClass ? token(providerAccountClass, 'providerAccountClass') : instance.providerAccountClass,
    nodeCapabilityFingerprint: node.capabilityFingerprint,
    agentInstanceFingerprint: instance.instanceFingerprint,
    expiresAt: expiry.toISOString(),
  };
  return Object.freeze({ ...payload, leaseFingerprint: digest(payload) });
}

export function issueWorkerQualificationLease({
  registry,
  route,
  projectId,
  repository,
  issueNumber,
  authorityFingerprint,
  baseSha,
  branch,
  worktree,
  adapterId,
  model,
  profile,
  jobClass,
  laneId,
  resourcePartition = null,
  validationProfile,
  qualificationProfile,
  expiresAt,
  providerAccountClass = null,
} = {}) {
  if (!registry || route?.qualificationOnly !== true || route?.selected == null) {
    throw new Error('selected qualification worker route is required');
  }
  const node = registry.nodes.find((item) => item.nodeId === route.selected.nodeId);
  const instance = registry.agentInstances.find((item) => item.instanceId === route.selected.instanceId);
  if (!node || !instance) throw new Error('selected qualification route is absent from registry');
  if (node.controller || !node.workerOnly) throw new Error('qualification target must be worker-only');
  if (instance.adapterId !== adapterId) throw new Error('selected agent adapter mismatch');
  if (node.state !== 'enabled' || node.readiness !== 'ready' || node.capacity.available < 1) {
    throw new Error('qualification target node is not ready');
  }
  if (instance.lifecycle !== 'enabled' || instance.readiness !== 'ready' || !instance.authenticated || instance.active >= instance.maxConcurrent) {
    throw new Error('qualification target agent is not ready');
  }
  if (!REPO.test(repository || '')) throw new Error('repository is invalid');
  if (!SHA.test(baseSha || '')) throw new Error('baseSha is invalid');
  if (!/^sha256:[a-f0-9]{64}$/.test(authorityFingerprint || '')) throw new Error('authorityFingerprint is invalid');
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error('issueNumber is invalid');
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime())) throw new Error('expiresAt is invalid');
  const payload = {
    schemaVersion: WORKER_POOL_SCHEMA_VERSION,
    revision: WORKER_POOL_REVISION,
    controllerNodeId: registry.controllerNodeId,
    registryFingerprint: registry.registryFingerprint,
    projectId: token(projectId, 'projectId'),
    repository,
    issueNumber,
    authorityFingerprint,
    baseSha: baseSha.toLowerCase(),
    branch: gitBranch(branch),
    worktree: token(worktree, 'worktree'),
    nodeId: node.nodeId,
    agentInstanceId: instance.instanceId,
    adapterId: token(adapterId, 'adapterId'),
    model: model ? token(model, 'model') : null,
    profile: profile ? token(profile, 'profile') : null,
    jobClass: enumValue(jobClass, WORKER_JOB_CLASSES, 'jobClass'),
    laneId: token(laneId, 'laneId'),
    resourcePartition: resourcePartition ? token(resourcePartition, 'resourcePartition') : null,
    validationProfile: token(validationProfile, 'validationProfile'),
    qualificationProfile: token(qualificationProfile, 'qualificationProfile'),
    qualificationOnly: true,
    providerAccountClass: providerAccountClass ? token(providerAccountClass, 'providerAccountClass') : instance.providerAccountClass,
    nodeCapabilityFingerprint: node.capabilityFingerprint,
    agentInstanceFingerprint: instance.instanceFingerprint,
    expiresAt: expiry.toISOString(),
  };
  return Object.freeze({ ...payload, leaseFingerprint: digest(payload) });
}

export function validateWorkerLease({ lease, registry, executingNodeId, now = new Date() } = {}) {
  const refuse = (reason) => Object.freeze({ valid: false, reason });
  if (!lease || lease.schemaVersion !== WORKER_POOL_SCHEMA_VERSION) return refuse('lease-schema-invalid');
  if (!registry || registry.schemaVersion !== WORKER_POOL_SCHEMA_VERSION) return refuse('registry-invalid');
  if (lease.controllerNodeId !== registry.controllerNodeId) return refuse('controller-mismatch');
  if (lease.registryFingerprint !== registry.registryFingerprint) return refuse('registry-revision-mismatch');
  if (lease.nodeId !== executingNodeId) return refuse('wrong-node');
  const node = registry.nodes.find((item) => item.nodeId === lease.nodeId);
  const instance = registry.agentInstances.find((item) => item.instanceId === lease.agentInstanceId);
  if (!node || !instance) return refuse('route-no-longer-registered');
  if (node.capabilityFingerprint !== lease.nodeCapabilityFingerprint) return refuse('node-capability-changed');
  if (instance.instanceFingerprint !== lease.agentInstanceFingerprint) return refuse('agent-instance-changed');
  if (instance.adapterId !== lease.adapterId) return refuse('wrong-agent');
  if (node.state !== 'enabled' || node.readiness !== 'ready') return refuse('node-no-longer-ready');
  if (lease.qualificationOnly === true) {
    if (node.controller || !node.workerOnly) return refuse('qualification-target-not-worker-only');
    if (!TOKEN.test(String(lease.qualificationProfile || ''))) return refuse('qualification-profile-invalid');
    if (instance.lifecycle !== 'enabled' || instance.readiness !== 'ready' || !instance.authenticated) return refuse('agent-no-longer-ready');
  } else if (instance.lifecycle !== 'enabled' || instance.readiness !== 'ready' || !instance.authenticated || !instance.qualified) {
    return refuse('agent-no-longer-ready');
  }
  if (!SHA.test(lease.baseSha || '') || !REPO.test(lease.repository || '') || !validGitBranchName(lease.branch)) {
    return refuse('source-identity-invalid');
  }
  const expires = new Date(lease.expiresAt);
  if (!Number.isFinite(expires.getTime()) || expires.getTime() <= new Date(now).getTime()) return refuse('lease-expired');
  const candidate = { ...lease };
  delete candidate.leaseFingerprint;
  if (digest(candidate) !== lease.leaseFingerprint) return refuse('lease-fingerprint-mismatch');
  return Object.freeze({ valid: true, reason: null, laneId: lease.laneId, nodeId: lease.nodeId, agentInstanceId: lease.agentInstanceId });
}

export function buildWorkerStatusProjection(registry) {
  if (!registry || registry.schemaVersion !== WORKER_POOL_SCHEMA_VERSION) throw new Error('valid worker registry is required');
  return Object.freeze({
    schemaVersion: WORKER_POOL_SCHEMA_VERSION,
    controllerNodeId: registry.controllerNodeId,
    registryFingerprint: registry.registryFingerprint,
    nodes: registry.nodes.map((node) => ({
      nodeId: node.nodeId,
      state: node.state,
      readiness: node.readiness,
      controller: node.controller,
      workerOnly: node.workerOnly,
      jobClasses: node.jobClasses,
      maxConcurrent: node.capacity.maxConcurrent,
      available: node.capacity.available,
    })),
    agentInstances: registry.agentInstances.map((instance) => ({
      instanceId: instance.instanceId,
      nodeId: instance.nodeId,
      adapterId: instance.adapterId,
      lifecycle: instance.lifecycle,
      readiness: instance.readiness,
      authenticated: instance.authenticated,
      qualified: instance.qualified,
      jobClasses: instance.jobClasses,
      maxConcurrent: instance.maxConcurrent,
      active: instance.active,
    })),
  });
}
