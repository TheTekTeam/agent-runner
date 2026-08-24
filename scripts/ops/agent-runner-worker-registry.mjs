#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

import { resolveAgentById } from './agent-runner-agents.mjs';

export const WORKER_REGISTRY_SCHEMA_VERSION = 1;
export const WORKER_CAPABILITY_SCHEMA_VERSION = 1;
export const WORKER_REGISTRY_ENV = 'AGENT_RUNNER_WORKER_REGISTRY';
export const WORKER_STATE_ROOT_ENV = 'AGENT_RUNNER_WORKER_STATE_ROOT';
export const WORKER_CONTROLLER_NODE_ENV = 'AGENT_RUNNER_CONTROLLER_NODE_ID';

const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const HOSTNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const QUALIFICATION_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,160}$/;
const TRANSPORT_TYPES = new Set(['local', 'restricted-ssh']);
const NODE_STATES = new Set(['enabled', 'paused', 'draining', 'disabled']);
const QUALIFICATION_STATES = new Set(['qualified', 'unqualified', 'disabled']);
const AUTH_READY_POSTURES = new Set(['authenticated', 'local-runtime', 'provider-specific']);

export class WorkerRegistryError extends Error {
  constructor(reason, message = reason) {
    super(message);
    this.name = 'WorkerRegistryError';
    this.code = 'AGENT_RUNNER_WORKER_REGISTRY_ERROR';
    this.reason = reason;
  }
}

function fail(reason, message) {
  throw new WorkerRegistryError(reason, message);
}

function asObject(value, reason, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(reason, message);
  return value;
}

function exactKeys(value, allowed, reason) {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) fail(reason, `Unsupported field(s): ${extras.join(', ')}`);
}

function positiveInteger(value, field, { min = 1, max = 64 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail('worker-registry-value-invalid', `${field} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function finiteWeight(value, field) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < -100 || parsed > 100) {
    fail('worker-registry-value-invalid', `${field} must be a finite number from -100 to 100.`);
  }
  return parsed;
}

export function resolveWorkerRegistryPath(env = process.env) {
  const configured = String(env[WORKER_REGISTRY_ENV] || '').trim();
  if (configured) return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  return resolve(String(env.HOME || homedir()), '.config/agent-runner/workers.json');
}

export function resolveWorkerStateRoot(env = process.env) {
  return env[WORKER_STATE_ROOT_ENV]
    || resolve(String(env.HOME || homedir()), '.local/state/agent-runner/workers');
}

export function workerCapabilitySnapshotPath(nodeId, env = process.env) {
  const normalized = String(nodeId || '').trim().toLowerCase();
  if (!NODE_ID_PATTERN.test(normalized)) fail('worker-node-id-invalid', 'Worker node id is invalid.');
  return resolve(resolveWorkerStateRoot(env), normalized, 'agent-capabilities.json');
}

function parseTransport(value, nodeId) {
  const transport = asObject(value, 'worker-transport-invalid', `Worker ${nodeId} transport must be an object.`);
  exactKeys(transport, new Set(['type', 'host', 'entrypoint']), 'worker-transport-invalid');
  const type = String(transport.type || '').trim();
  if (!TRANSPORT_TYPES.has(type)) fail('worker-transport-invalid', `Worker ${nodeId} transport type is unsupported.`);
  if (type === 'local') {
    if (transport.host || transport.entrypoint) fail('worker-transport-invalid', `Local worker ${nodeId} cannot declare remote transport fields.`);
    return Object.freeze({ type: 'local' });
  }
  const host = String(transport.host || '').trim();
  if (!HOSTNAME_PATTERN.test(host)) fail('worker-transport-invalid', `Worker ${nodeId} restricted-ssh host is invalid.`);
  const entrypoint = String(transport.entrypoint || '').trim();
  if (!entrypoint.startsWith('/') || !/^\/[A-Za-z0-9._/-]{2,240}$/.test(entrypoint) || entrypoint.includes('..')) {
    fail('worker-transport-invalid', `Worker ${nodeId} entrypoint must be one bounded absolute path.`);
  }
  return Object.freeze({ type, host, entrypoint });
}

function parseQualifications(value, nodeId) {
  const source = value ?? {};
  const object = asObject(source, 'worker-qualification-invalid', `Worker ${nodeId} qualifications must be an object.`);
  const result = {};
  for (const [agentIdRaw, raw] of Object.entries(object)) {
    const agentId = String(agentIdRaw || '').trim();
    if (!resolveAgentById(agentId)) fail('worker-qualification-invalid', `Worker ${nodeId} references unknown agent ${agentId}.`);
    const qualification = asObject(raw, 'worker-qualification-invalid', `Worker ${nodeId}/${agentId} qualification must be an object.`);
    exactKeys(qualification, new Set(['state', 'revision']), 'worker-qualification-invalid');
    const state = String(qualification.state || '').trim();
    if (!QUALIFICATION_STATES.has(state)) fail('worker-qualification-invalid', `Worker ${nodeId}/${agentId} qualification state is invalid.`);
    const revision = String(qualification.revision || '').trim();
    if (state === 'qualified' && !QUALIFICATION_REVISION_PATTERN.test(revision)) {
      fail('worker-qualification-invalid', `Worker ${nodeId}/${agentId} requires a bounded qualification revision.`);
    }
    if (state !== 'qualified' && revision && !QUALIFICATION_REVISION_PATTERN.test(revision)) {
      fail('worker-qualification-invalid', `Worker ${nodeId}/${agentId} qualification revision is invalid.`);
    }
    result[agentId] = Object.freeze({ state, revision: revision || null });
  }
  return Object.freeze(result);
}

function parseWorker(raw) {
  const worker = asObject(raw, 'worker-registry-worker-invalid', 'Worker entry must be an object.');
  exactKeys(worker, new Set([
    'nodeId', 'hostname', 'state', 'transport', 'concurrencyCap', 'placementWeight', 'qualifications',
  ]), 'worker-registry-worker-invalid');
  const nodeId = String(worker.nodeId || '').trim().toLowerCase();
  if (!NODE_ID_PATTERN.test(nodeId)) fail('worker-node-id-invalid', 'Worker nodeId is invalid.');
  const hostname = String(worker.hostname || '').trim();
  if (!HOSTNAME_PATTERN.test(hostname)) fail('worker-hostname-invalid', `Worker ${nodeId} hostname is invalid.`);
  const state = String(worker.state || '').trim();
  if (!NODE_STATES.has(state)) fail('worker-state-invalid', `Worker ${nodeId} state is invalid.`);
  const concurrencyCap = positiveInteger(worker.concurrencyCap ?? 1, `${nodeId}.concurrencyCap`);
  const placementWeight = finiteWeight(worker.placementWeight ?? 0, `${nodeId}.placementWeight`);
  return Object.freeze({
    nodeId,
    hostname,
    state,
    transport: parseTransport(worker.transport, nodeId),
    concurrencyCap,
    placementWeight,
    qualifications: parseQualifications(worker.qualifications, nodeId),
  });
}

export function parseWorkerRegistry(value, { env = process.env } = {}) {
  const registry = asObject(value, 'worker-registry-invalid', 'Worker registry must be an object.');
  exactKeys(registry, new Set(['schemaVersion', 'controllerNodeId', 'workers']), 'worker-registry-invalid');
  if (registry.schemaVersion !== WORKER_REGISTRY_SCHEMA_VERSION) fail('worker-registry-schema-invalid', 'Worker registry schemaVersion is invalid.');
  const controllerNodeId = String(registry.controllerNodeId || '').trim().toLowerCase();
  if (!NODE_ID_PATTERN.test(controllerNodeId)) fail('worker-controller-invalid', 'controllerNodeId is invalid.');
  const configuredController = String(env[WORKER_CONTROLLER_NODE_ENV] || controllerNodeId).trim().toLowerCase();
  if (configuredController !== controllerNodeId) fail('worker-controller-mismatch', 'Configured controller node does not match the registry controller.');
  if (!Array.isArray(registry.workers) || registry.workers.length < 1 || registry.workers.length > 32) {
    fail('worker-registry-invalid', 'workers must contain between 1 and 32 entries.');
  }
  const workers = registry.workers.map(parseWorker);
  const ids = workers.map((worker) => worker.nodeId);
  if (new Set(ids).size !== ids.length) fail('worker-registry-duplicate-node', 'Worker node ids must be unique.');
  const localTransports = workers.filter((worker) => worker.transport.type === 'local');
  if (localTransports.length !== 1 || localTransports[0].nodeId !== controllerNodeId) {
    fail('worker-controller-topology-invalid', 'Exactly the controller node must use local transport.');
  }
  return Object.freeze({ schemaVersion: WORKER_REGISTRY_SCHEMA_VERSION, controllerNodeId, workers: Object.freeze(workers) });
}

export function loadWorkerRegistry({ env = process.env, path = resolveWorkerRegistryPath(env), readFile = readFileSync } = {}) {
  let decoded;
  try {
    decoded = JSON.parse(String(readFile(path, 'utf8')));
  } catch (error) {
    fail('worker-registry-read-failed', `Unable to read worker registry ${path}: ${String(error?.message || error)}`);
  }
  return Object.freeze({ path, directory: dirname(path), ...parseWorkerRegistry(decoded, { env }) });
}

export function parseWorkerCapabilitySnapshot(value, expectedWorker) {
  const snapshot = asObject(value, 'worker-capability-invalid', 'Worker capability snapshot must be an object.');
  exactKeys(snapshot, new Set([
    'schema_version', 'recorded_at', 'node', 'preset', 'scheduler_capable',
    'scheduler_enabled_by_agent_fleet', 'agents', 'ollama_models',
  ]), 'worker-capability-invalid');
  if (snapshot.schema_version !== WORKER_CAPABILITY_SCHEMA_VERSION) fail('worker-capability-schema-invalid', 'Worker capability schema is invalid.');
  if (String(snapshot.node || '').trim() !== expectedWorker.hostname) fail('worker-capability-node-mismatch', `Capability node does not match ${expectedWorker.nodeId}.`);
  if (snapshot.scheduler_enabled_by_agent_fleet !== false) fail('worker-capability-scheduler-invalid', `Worker ${expectedWorker.nodeId} capability snapshot claims fleet scheduler enablement.`);
  if (!Array.isArray(snapshot.agents) || snapshot.agents.length > 32) fail('worker-capability-invalid', 'Capability agents must be a bounded array.');
  const agents = new Map();
  for (const raw of snapshot.agents) {
    const agent = asObject(raw, 'worker-capability-agent-invalid', 'Capability agent entry must be an object.');
    exactKeys(agent, new Set(['adapter', 'installed', 'path', 'version', 'auth_posture', 'qualified']), 'worker-capability-agent-invalid');
    const agentId = String(agent.adapter || '').trim();
    if (!resolveAgentById(agentId) && agentId !== 'opencode') fail('worker-capability-agent-invalid', `Capability references unknown adapter ${agentId}.`);
    if (typeof agent.installed !== 'boolean' || typeof agent.qualified !== 'boolean') fail('worker-capability-agent-invalid', `Capability ${agentId} booleans are invalid.`);
    const path = agent.path === null ? null : String(agent.path || '').trim();
    const version = agent.version === null ? null : String(agent.version || '').trim();
    const authPosture = String(agent.auth_posture || '').trim();
    if (agents.has(agentId)) fail('worker-capability-agent-duplicate', `Capability duplicates ${agentId}.`);
    agents.set(agentId, Object.freeze({
      agentId,
      installed: agent.installed,
      path,
      version,
      authPosture,
      // A node-local report never grants Agent Runner qualification authority.
      reportedQualified: agent.qualified,
    }));
  }
  return Object.freeze({
    nodeId: expectedWorker.nodeId,
    hostname: expectedWorker.hostname,
    recordedAt: String(snapshot.recorded_at || '').trim() || null,
    agents,
  });
}

export function loadWorkerCapabilitySnapshot(worker, { env = process.env, readFile = readFileSync } = {}) {
  const path = workerCapabilitySnapshotPath(worker.nodeId, env);
  let decoded;
  try {
    decoded = JSON.parse(String(readFile(path, 'utf8')));
  } catch (error) {
    return Object.freeze({ available: false, path, reason: 'worker-capability-read-failed', detail: String(error?.message || error) });
  }
  try {
    return Object.freeze({ available: true, path, capability: parseWorkerCapabilitySnapshot(decoded, worker) });
  } catch (error) {
    return Object.freeze({ available: false, path, reason: error?.reason || 'worker-capability-invalid', detail: String(error?.message || error) });
  }
}

export function resolveWorkerRoutes({
  registry,
  agentId,
  env = process.env,
  activeLeasesByNode = {},
  capabilityLoader = (worker) => loadWorkerCapabilitySnapshot(worker, { env }),
} = {}) {
  const adapter = resolveAgentById(agentId);
  if (!adapter) fail('worker-route-agent-invalid', `Unknown agent ${agentId}.`);
  const routes = [];
  const rejected = [];
  for (const worker of registry.workers) {
    const reject = (reason, detail = null) => rejected.push(Object.freeze({ nodeId: worker.nodeId, agentId, reason, detail }));
    if (worker.state !== 'enabled') { reject('worker-state-not-enabled', worker.state); continue; }
    const active = Number(activeLeasesByNode[worker.nodeId] || 0);
    if (!Number.isSafeInteger(active) || active < 0) { reject('worker-active-lease-count-invalid'); continue; }
    if (active >= worker.concurrencyCap) { reject('worker-capacity-full', `${active}/${worker.concurrencyCap}`); continue; }
    const qualification = worker.qualifications[agentId];
    if (!qualification || qualification.state !== 'qualified') { reject('worker-agent-unqualified'); continue; }
    const loaded = capabilityLoader(worker);
    if (!loaded?.available) { reject(loaded?.reason || 'worker-capability-unavailable', loaded?.detail || null); continue; }
    const capability = loaded.capability.agents.get(agentId);
    if (!capability?.installed) { reject('worker-agent-runtime-missing'); continue; }
    if (!AUTH_READY_POSTURES.has(capability.authPosture)) { reject('worker-agent-auth-unavailable', capability.authPosture); continue; }
    routes.push(Object.freeze({
      routeId: `${agentId}@${worker.nodeId}`,
      agentId,
      adapterImplemented: Boolean(adapter.implemented),
      nodeId: worker.nodeId,
      hostname: worker.hostname,
      transport: worker.transport,
      placementWeight: worker.placementWeight,
      activeLeases: active,
      concurrencyCap: worker.concurrencyCap,
      qualificationRevision: qualification.revision,
      runtimeVersion: capability.version,
      runtimePath: capability.path,
      capabilityPath: loaded.path || null,
    }));
  }
  routes.sort((a, b) => (
    b.placementWeight - a.placementWeight
    || a.activeLeases - b.activeLeases
    || a.nodeId.localeCompare(b.nodeId)
  ));
  return Object.freeze({ routes: Object.freeze(routes), rejected: Object.freeze(rejected) });
}

export function selectWorkerRoute(options = {}) {
  const resolved = resolveWorkerRoutes(options);
  return Object.freeze({ route: resolved.routes[0] || null, ...resolved });
}
