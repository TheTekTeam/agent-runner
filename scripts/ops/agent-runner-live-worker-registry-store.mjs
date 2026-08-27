import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { canonicalAcceptedQualificationResults } from './agent-runner-fleet-accepted-qualification-evidence.mjs';
import { publishFleetQualification } from './agent-runner-fleet-qualification-publication.mjs';
import {
  ZERO_PAID_ROUTE_COST_POSTURES,
  buildWorkerRegistry,
} from './agent-runner-worker-pool.mjs';

export const LIVE_WORKER_REGISTRY_DOCUMENT_SCHEMA_VERSION = 'agent-runner-live-worker-registry/v1';
export const LIVE_WORKER_REGISTRY_PATH_ENV = 'AGENT_RUNNER_WORKER_REGISTRY_PATH';
export const LIVE_WORKER_REGISTRY_DEFAULT_RELATIVE = '.local/state/agent-runner/live-worker-registry.json';
export const LIVE_WORKER_REGISTRY_CONTROLLER_NODE_ID = 'dev-cluster-dell';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const AUTHORITY_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}@[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const LIFECYCLE_STATES = Object.freeze(['enabled', 'paused', 'draining', 'disabled']);

export class LiveWorkerRegistryError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'LiveWorkerRegistryError';
    this.code = code;
  }
}

export class LiveWorkerRegistryStaleRevisionError extends LiveWorkerRegistryError {
  constructor(expected, actual) {
    super('live-worker-registry-stale-revision', `stale live worker registry write: expected ${expected}, current ${actual}`);
    this.expectedRevision = expected;
    this.actualRevision = actual;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function resolveLiveWorkerRegistryPath(env = process.env) {
  const home = String(env.HOME || homedir());
  const raw = String(env[LIVE_WORKER_REGISTRY_PATH_ENV] || '').trim();
  if (!raw) return resolve(home, LIVE_WORKER_REGISTRY_DEFAULT_RELATIVE);
  return isAbsolute(raw) ? raw : resolve(home, raw);
}

function defaultDeps(overrides = {}) {
  return {
    mkdirFn: mkdirSync,
    chmodFn: chmodSync,
    existsFn: existsSync,
    lstatFn: lstatSync,
    readFn: readFileSync,
    writeFn: writeFileSync,
    renameFn: renameSync,
    unlinkFn: unlinkSync,
    openFn: openSync,
    closeFn: closeSync,
    now: () => new Date().toISOString(),
    pid: process.pid,
    ...overrides,
  };
}

function assertNotSymlink(path, fs, { allowMissing = true } = {}) {
  if (!fs.existsFn(path)) {
    if (allowMissing) return;
    throw new LiveWorkerRegistryError('live-worker-registry-missing');
  }
  let stat;
  try {
    stat = fs.lstatFn(path);
  } catch (error) {
    throw new LiveWorkerRegistryError('live-worker-registry-stat-failed', error?.message || 'stat failed');
  }
  if (stat.isSymbolicLink()) throw new LiveWorkerRegistryError('live-worker-registry-symlink-refused');
}

function canonicalPublication() {
  return publishFleetQualification({ acceptedResults: canonicalAcceptedQualificationResults() });
}

function publishedByInstance() {
  return new Map(canonicalPublication().instances.map((entry) => [entry.instanceId, entry]));
}

function assertCanonicalQualification(instance, publication = publishedByInstance()) {
  if (instance.qualified !== true) return;
  const accepted = publication.get(instance.instanceId);
  if (!accepted || accepted.published !== true || accepted.qualified !== true) {
    throw new LiveWorkerRegistryError('live-worker-registry-qualification-evidence-gap', `no accepted qualification for ${instance.instanceId}`);
  }
  if (instance.qualificationRevision !== accepted.qualificationRevision) {
    throw new LiveWorkerRegistryError('live-worker-registry-qualification-revision-mismatch');
  }
  if (instance.qualificationEvidenceFingerprint !== accepted.acceptedResultFingerprint) {
    throw new LiveWorkerRegistryError('live-worker-registry-qualification-fingerprint-mismatch');
  }
  if (accepted.model && !instance.models.includes(accepted.model)) {
    throw new LiveWorkerRegistryError('live-worker-registry-qualified-model-mismatch');
  }
  if (accepted.profile && !instance.profiles.includes(accepted.profile)) {
    throw new LiveWorkerRegistryError('live-worker-registry-qualified-profile-mismatch');
  }
}

export function assertLiveInstanceActivationEligible(instance) {
  if (!instance || typeof instance !== 'object') throw new LiveWorkerRegistryError('live-worker-registry-instance-missing');
  assertCanonicalQualification(instance);
  if (instance.qualified !== true) throw new LiveWorkerRegistryError('live-worker-registry-instance-unqualified');
  if (instance.authenticated !== true) throw new LiveWorkerRegistryError('live-worker-registry-auth-unavailable');
  if (instance.readiness !== 'ready') throw new LiveWorkerRegistryError('live-worker-registry-instance-not-ready');
  if (instance.paid !== false) throw new LiveWorkerRegistryError('live-worker-registry-paid-route-refused');
  if (!ZERO_PAID_ROUTE_COST_POSTURES.includes(instance.costPosture)) {
    throw new LiveWorkerRegistryError(instance.costPosture === 'unknown'
      ? 'live-worker-registry-cost-posture-unknown'
      : 'live-worker-registry-cost-posture-refused');
  }
  if (instance.costPosture === 'included-subscription' && !instance.providerAccountClass) {
    throw new LiveWorkerRegistryError('live-worker-registry-provider-account-class-missing');
  }
  return instance;
}

function rebuildRegistry(raw, revisionNumber) {
  if (!isPlainObject(raw)) throw new LiveWorkerRegistryError('live-worker-registry-invalid');
  const registry = buildWorkerRegistry({
    controllerNodeId: raw.controllerNodeId,
    nodes: raw.nodes,
    agentInstances: raw.agentInstances || [],
    providerAccountCaps: raw.providerAccountCaps || {},
    revision: `live-${revisionNumber}`,
  });
  if (registry.controllerNodeId !== LIVE_WORKER_REGISTRY_CONTROLLER_NODE_ID) {
    throw new LiveWorkerRegistryError('live-worker-registry-controller-mismatch');
  }
  if (raw.registryFingerprint && raw.registryFingerprint !== registry.registryFingerprint) {
    throw new LiveWorkerRegistryError('live-worker-registry-fingerprint-mismatch');
  }
  const publication = publishedByInstance();
  for (const instance of registry.agentInstances) assertCanonicalQualification(instance, publication);
  return registry;
}

function validateDocument(doc) {
  if (!isPlainObject(doc)) throw new LiveWorkerRegistryError('live-worker-registry-document-invalid');
  if (doc.schemaVersion !== LIVE_WORKER_REGISTRY_DOCUMENT_SCHEMA_VERSION) {
    throw new LiveWorkerRegistryError('live-worker-registry-schema-mismatch');
  }
  if (!Number.isSafeInteger(doc.revision) || doc.revision < 1) {
    throw new LiveWorkerRegistryError('live-worker-registry-revision-invalid');
  }
  if (typeof doc.updatedAt !== 'string' || !Number.isFinite(Date.parse(doc.updatedAt))) {
    throw new LiveWorkerRegistryError('live-worker-registry-updated-at-invalid');
  }
  const registry = rebuildRegistry(doc.registry, doc.revision);
  if (doc.registry?.revision !== registry.revision) throw new LiveWorkerRegistryError('live-worker-registry-revision-mismatch');
  return Object.freeze({
    schemaVersion: LIVE_WORKER_REGISTRY_DOCUMENT_SCHEMA_VERSION,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
    activationAuthority: doc.activationAuthority || null,
    lastTransition: doc.lastTransition || null,
    registry,
  });
}

export function loadLiveWorkerRegistryDocument({
  path = resolveLiveWorkerRegistryPath(),
  deps = {},
  allowMissing = true,
} = {}) {
  const fs = defaultDeps(deps);
  if (!fs.existsFn(path)) {
    if (!allowMissing) throw new LiveWorkerRegistryError('live-worker-registry-missing');
    return Object.freeze({ path, found: false, revision: 0, document: null, registry: null });
  }
  assertNotSymlink(path, fs, { allowMissing: false });
  let parsed;
  try {
    parsed = JSON.parse(fs.readFn(path, 'utf8'));
  } catch {
    throw new LiveWorkerRegistryError('live-worker-registry-json-invalid');
  }
  const document = validateDocument(parsed);
  return Object.freeze({ path, found: true, revision: document.revision, document, registry: document.registry });
}

function acquireLock(path, fs) {
  const lockPath = `${path}.lock`;
  let fd;
  try {
    fd = fs.openFn(lockPath, 'wx', FILE_MODE);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new LiveWorkerRegistryError('live-worker-registry-locked');
    throw error;
  }
  fs.writeFn(fd, `${fs.pid}\n${fs.now()}\n`);
  fs.closeFn(fd);
  return () => {
    try { fs.unlinkFn(lockPath); } catch { /* best effort */ }
  };
}

function atomicWrite(path, document, fs) {
  const dir = resolve(path, '..');
  fs.mkdirFn(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodFn(dir, DIR_MODE);
  assertNotSymlink(path, fs, { allowMissing: true });
  const tmpPath = join(dir, `.${randomBytes(8).toString('hex')}.live-worker-registry.tmp`);
  let fd;
  try {
    fd = fs.openFn(tmpPath, 'wx', FILE_MODE);
    fs.writeFn(fd, `${JSON.stringify(document, null, 2)}\n`);
    fs.closeFn(fd);
    fs.chmodFn(tmpPath, FILE_MODE);
    fs.renameFn(tmpPath, path);
    fs.chmodFn(path, FILE_MODE);
  } catch (error) {
    try { fs.unlinkFn(tmpPath); } catch { /* destination remains authoritative */ }
    throw error;
  }
}

function writeNext({
  path,
  expectedRevision,
  controllerNodeId,
  mutate,
  deps = {},
} = {}) {
  if (controllerNodeId !== LIVE_WORKER_REGISTRY_CONTROLLER_NODE_ID) {
    throw new LiveWorkerRegistryError('live-worker-registry-controller-write-refused');
  }
  if (!Number.isSafeInteger(Number(expectedRevision)) || Number(expectedRevision) < 0) {
    throw new LiveWorkerRegistryError('live-worker-registry-expected-revision-invalid');
  }
  const fs = defaultDeps(deps);
  const release = acquireLock(path, fs);
  try {
    const current = loadLiveWorkerRegistryDocument({ path, deps: fs, allowMissing: true });
    if (current.revision !== Number(expectedRevision)) {
      throw new LiveWorkerRegistryStaleRevisionError(Number(expectedRevision), current.revision);
    }
    const nextRevision = current.revision + 1;
    const next = mutate({ current, nextRevision, now: fs.now() });
    const validated = validateDocument(next);
    atomicWrite(path, validated, fs);
    return loadLiveWorkerRegistryDocument({ path, deps: fs, allowMissing: false });
  } finally {
    release();
  }
}

export function replaceLiveWorkerRegistry({
  path = resolveLiveWorkerRegistryPath(),
  expectedRevision,
  controllerNodeId,
  registry: rawRegistry,
  deps = {},
} = {}) {
  return writeNext({
    path,
    expectedRevision,
    controllerNodeId,
    deps,
    mutate: ({ nextRevision, now }) => {
      const registry = rebuildRegistry(rawRegistry, nextRevision);
      if (registry.agentInstances.some((instance) => instance.lifecycle !== 'disabled')) {
        throw new LiveWorkerRegistryError('live-worker-registry-replace-requires-disabled-instances');
      }
      return {
        schemaVersion: LIVE_WORKER_REGISTRY_DOCUMENT_SCHEMA_VERSION,
        revision: nextRevision,
        updatedAt: now,
        activationAuthority: null,
        lastTransition: null,
        registry,
      };
    },
  });
}

function normalizeAuthority({ authorityRevision, authorityFingerprint }) {
  if (!AUTHORITY_REVISION.test(String(authorityRevision || ''))) {
    throw new LiveWorkerRegistryError('live-worker-registry-activation-authority-revision-invalid');
  }
  if (!DIGEST.test(String(authorityFingerprint || ''))) {
    throw new LiveWorkerRegistryError('live-worker-registry-activation-authority-fingerprint-invalid');
  }
  return Object.freeze({
    revision: String(authorityRevision),
    fingerprint: String(authorityFingerprint),
  });
}

export function transitionLiveWorkerInstance({
  path = resolveLiveWorkerRegistryPath(),
  expectedRevision,
  controllerNodeId,
  instanceId,
  targetState,
  authorityRevision = null,
  authorityFingerprint = null,
  deps = {},
} = {}) {
  if (!INSTANCE_ID.test(String(instanceId || ''))) throw new LiveWorkerRegistryError('live-worker-registry-instance-id-invalid');
  if (!LIFECYCLE_STATES.includes(targetState)) throw new LiveWorkerRegistryError('live-worker-registry-lifecycle-invalid');
  return writeNext({
    path,
    expectedRevision,
    controllerNodeId,
    deps,
    mutate: ({ current, nextRevision, now }) => {
      if (!current.registry) throw new LiveWorkerRegistryError('live-worker-registry-missing');
      const currentInstance = current.registry.agentInstances.find((entry) => entry.instanceId === instanceId);
      if (!currentInstance) throw new LiveWorkerRegistryError('live-worker-registry-instance-not-found');
      const authority = targetState === 'enabled'
        ? normalizeAuthority({ authorityRevision, authorityFingerprint })
        : null;
      if (targetState === 'enabled') assertLiveInstanceActivationEligible(currentInstance);

      const agentInstances = current.registry.agentInstances.map((entry) => ({
        ...entry,
        lifecycle: entry.instanceId === instanceId ? targetState : entry.lifecycle,
      }));
      const registry = rebuildRegistry({
        controllerNodeId: current.registry.controllerNodeId,
        nodes: current.registry.nodes,
        agentInstances,
        providerAccountCaps: current.registry.providerAccountCaps,
      }, nextRevision);
      const nextInstance = registry.agentInstances.find((entry) => entry.instanceId === instanceId);
      if (targetState === 'enabled') assertLiveInstanceActivationEligible(nextInstance);

      return {
        schemaVersion: LIVE_WORKER_REGISTRY_DOCUMENT_SCHEMA_VERSION,
        revision: nextRevision,
        updatedAt: now,
        activationAuthority: authority || current.document?.activationAuthority || null,
        lastTransition: {
          instanceId,
          targetState,
          authorityRevision: authority?.revision || null,
          authorityFingerprint: authority?.fingerprint || null,
        },
        registry,
      };
    },
  });
}

export function safeLiveWorkerRegistrySummary(loaded) {
  if (!loaded?.found || !loaded.registry) {
    return Object.freeze({
      schemaVersion: LIVE_WORKER_REGISTRY_DOCUMENT_SCHEMA_VERSION,
      found: false,
      revision: 0,
      controllerNodeId: LIVE_WORKER_REGISTRY_CONTROLLER_NODE_ID,
      registryFingerprint: null,
      instances: [],
    });
  }
  return Object.freeze({
    schemaVersion: LIVE_WORKER_REGISTRY_DOCUMENT_SCHEMA_VERSION,
    found: true,
    revision: loaded.revision,
    controllerNodeId: loaded.registry.controllerNodeId,
    registryFingerprint: loaded.registry.registryFingerprint,
    providerAccountCaps: loaded.registry.providerAccountCaps,
    activationAuthority: loaded.document?.activationAuthority || null,
    lastTransition: loaded.document?.lastTransition || null,
    instances: loaded.registry.agentInstances.map((entry) => Object.freeze({
      instanceId: entry.instanceId,
      lifecycle: entry.lifecycle,
      readiness: entry.readiness,
      authenticated: entry.authenticated,
      qualified: entry.qualified,
      qualificationRevision: entry.qualificationRevision,
      qualificationEvidenceFingerprint: entry.qualificationEvidenceFingerprint,
      providerAccountClass: entry.providerAccountClass,
      costPosture: entry.costPosture,
      paid: entry.paid,
      active: entry.active,
      maxConcurrent: entry.maxConcurrent,
    })),
  });
}
