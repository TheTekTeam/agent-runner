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
import {
  assertValidatedFleetActivationAuthority,
  fleetActivationAuthorityKey,
} from './agent-runner-fleet-activation-authority.mjs';

export const LIVE_WORKER_REGISTRY_DOCUMENT_SCHEMA_VERSION = 'agent-runner-live-worker-registry/v1';
export const LIVE_WORKER_REGISTRY_PATH_ENV = 'AGENT_RUNNER_WORKER_REGISTRY_PATH';
export const LIVE_WORKER_REGISTRY_DEFAULT_RELATIVE = '.local/state/agent-runner/live-worker-registry.json';
export const LIVE_WORKER_REGISTRY_CONTROLLER_NODE_ID = 'dev-cluster-dell';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const FULL_SHA = /^[a-f0-9]{40}$/;
const AUTHORITY_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,160}$/;
const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}@[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const LIFECYCLE_STATES = Object.freeze(['enabled', 'paused', 'draining', 'disabled']);

export class LiveWorkerRegistryError extends Error {
  constructor(code, message = code) {
    super(message === code ? code : `${code}: ${message}`);
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

function assertSafePathChain(path, fs, { requireLeaf = false } = {}) {
  const leaf = resolve(path);
  if (requireLeaf && !fs.existsFn(leaf)) {
    throw new LiveWorkerRegistryError('live-worker-registry-missing');
  }
  let cursor = leaf;
  while (true) {
    if (fs.existsFn(cursor)) {
      let stat;
      try {
        stat = fs.lstatFn(cursor);
      } catch (error) {
        throw new LiveWorkerRegistryError('live-worker-registry-stat-failed', error?.message || 'stat failed');
      }
      if (stat.isSymbolicLink()) throw new LiveWorkerRegistryError('live-worker-registry-symlink-refused');
    }
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
}

function canonicalPublication() {
  return publishFleetQualification({ acceptedResults: canonicalAcceptedQualificationResults() });
}

function publishedByInstance() {
  return new Map(canonicalPublication().instances.map((entry) => [entry.instanceId, entry]));
}

function exactKeys(value, allowed, code) {
  if (!isPlainObject(value)) throw new LiveWorkerRegistryError(code);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) throw new LiveWorkerRegistryError(code);
  return value;
}

function normalizedAuthority(raw) {
  exactKeys(raw, [
    'revision', 'fingerprint', 'authorityKey', 'bodyDigest', 'commentId', 'targetSourceCommit',
  ], 'live-worker-registry-activation-authority-invalid');
  const revision = String(raw.revision || '');
  const fingerprint = String(raw.fingerprint || '');
  const authorityKey = String(raw.authorityKey || '');
  const bodyDigest = String(raw.bodyDigest || '');
  const targetSourceCommit = String(raw.targetSourceCommit || '').toLowerCase();
  const commentId = Number(raw.commentId);
  if (!AUTHORITY_REVISION.test(revision) || !DIGEST.test(fingerprint) || !DIGEST.test(bodyDigest)
    || !FULL_SHA.test(targetSourceCommit) || !Number.isSafeInteger(commentId) || commentId < 1) {
    throw new LiveWorkerRegistryError('live-worker-registry-activation-authority-invalid');
  }
  if (authorityKey !== fleetActivationAuthorityKey(revision, fingerprint)) {
    throw new LiveWorkerRegistryError('live-worker-registry-activation-authority-key-mismatch');
  }
  return Object.freeze({ revision, fingerprint, authorityKey, bodyDigest, commentId, targetSourceCommit });
}

function normalizeActivationAuthorities(raw, registry) {
  const source = raw == null ? {} : raw;
  if (!isPlainObject(source)) throw new LiveWorkerRegistryError('live-worker-registry-activation-authorities-invalid');
  const entries = Object.entries(source);
  if (entries.length > 256) throw new LiveWorkerRegistryError('live-worker-registry-activation-authorities-invalid');
  const normalized = {};
  for (const [instanceId, authority] of entries) {
    if (!INSTANCE_ID.test(instanceId)) throw new LiveWorkerRegistryError('live-worker-registry-activation-authorities-invalid');
    const instance = registry.agentInstances.find((entry) => entry.instanceId === instanceId);
    if (!instance || instance.lifecycle !== 'enabled') {
      throw new LiveWorkerRegistryError('live-worker-registry-activation-authority-without-enabled-instance');
    }
    normalized[instanceId] = normalizedAuthority(authority);
  }
  for (const instance of registry.agentInstances) {
    if (instance.lifecycle === 'enabled' && !normalized[instance.instanceId]) {
      throw new LiveWorkerRegistryError('live-worker-registry-enabled-instance-missing-authority');
    }
  }
  return Object.freeze(Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b))));
}

function normalizeLastTransition(raw) {
  if (raw == null) return null;
  exactKeys(raw, [
    'instanceId', 'targetState', 'authorityRevision', 'authorityFingerprint',
    'authorityKey', 'authorityBodyDigest', 'authorityCommentId', 'targetSourceCommit',
  ], 'live-worker-registry-last-transition-invalid');
  if (!INSTANCE_ID.test(String(raw.instanceId || '')) || !LIFECYCLE_STATES.includes(raw.targetState)) {
    throw new LiveWorkerRegistryError('live-worker-registry-last-transition-invalid');
  }
  const authority = normalizedAuthority({
    revision: raw.authorityRevision,
    fingerprint: raw.authorityFingerprint,
    authorityKey: raw.authorityKey,
    bodyDigest: raw.authorityBodyDigest,
    commentId: raw.authorityCommentId,
    targetSourceCommit: raw.targetSourceCommit,
  });
  return Object.freeze({
    instanceId: raw.instanceId,
    targetState: raw.targetState,
    authorityRevision: authority.revision,
    authorityFingerprint: authority.fingerprint,
    authorityKey: authority.authorityKey,
    authorityBodyDigest: authority.bodyDigest,
    authorityCommentId: authority.commentId,
    targetSourceCommit: authority.targetSourceCommit,
  });
}

export function planLiveWorkerRegistryPromotion({
  expectedRevision,
  controllerNodeId = LIVE_WORKER_REGISTRY_CONTROLLER_NODE_ID,
  nodes = [],
  runtimeInstances = [],
  providerAccountCaps = {},
} = {}) {
  const revision = Number(expectedRevision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new LiveWorkerRegistryError('live-worker-registry-expected-revision-invalid');
  }
  if (controllerNodeId !== LIVE_WORKER_REGISTRY_CONTROLLER_NODE_ID) {
    throw new LiveWorkerRegistryError('live-worker-registry-controller-write-refused');
  }
  if (!Array.isArray(runtimeInstances) || runtimeInstances.length > 256) {
    throw new LiveWorkerRegistryError('live-worker-registry-runtime-instances-invalid');
  }

  const publication = canonicalPublication();
  const accepted = new Map(
    publication.instances
      .filter((entry) => entry.published === true && entry.qualified === true)
      .map((entry) => [entry.instanceId, entry]),
  );
  const seen = new Set();
  const agentInstances = runtimeInstances.map((runtime) => {
    exactKeys(runtime, [
      'nodeId', 'adapterId', 'installedVersion', 'readiness', 'authenticated',
      'costPosture', 'paid', 'maxConcurrent', 'active',
    ], 'live-worker-registry-runtime-instance-invalid');
    const nodeId = String(runtime.nodeId || '');
    const adapterId = String(runtime.adapterId || '');
    const instanceId = `${adapterId}@${nodeId}`;
    if (!INSTANCE_ID.test(instanceId) || seen.has(instanceId)) {
      throw new LiveWorkerRegistryError('live-worker-registry-runtime-instance-invalid');
    }
    seen.add(instanceId);
    const qualified = accepted.get(instanceId);
    if (!qualified) {
      throw new LiveWorkerRegistryError(
        'live-worker-registry-qualification-evidence-gap',
        `no accepted qualification for ${instanceId}`,
      );
    }
    if (String(runtime.installedVersion || '') !== qualified.installedVersion) {
      throw new LiveWorkerRegistryError('live-worker-registry-qualified-version-mismatch');
    }
    return {
      nodeId,
      adapterId,
      lifecycle: 'disabled',
      readiness: runtime.readiness,
      authenticated: runtime.authenticated === true,
      qualified: true,
      qualificationRevision: qualified.qualificationRevision,
      qualificationEvidenceFingerprint: qualified.acceptedResultFingerprint,
      installedVersion: qualified.installedVersion,
      qualificationContractFingerprint: qualified.qualificationContractFingerprint,
      qualificationCapabilityFingerprint: qualified.capabilityFingerprint,
      providerAccountClass: qualified.providerAccountClass || null,
      costPosture: runtime.costPosture,
      paid: runtime.paid === false ? false : true,
      models: qualified.model ? [qualified.model] : [],
      profiles: qualified.profile ? [qualified.profile] : [],
      jobClasses: qualified.jobClasses || [],
      maxConcurrent: runtime.maxConcurrent ?? 1,
      active: runtime.active ?? 0,
    };
  });

  const registry = rebuildRegistry({
    controllerNodeId,
    nodes,
    agentInstances,
    providerAccountCaps,
  }, revision + 1);
  if (registry.agentInstances.some((instance) => instance.lifecycle !== 'disabled')) {
    throw new LiveWorkerRegistryError('live-worker-registry-promotion-must-start-disabled');
  }
  return Object.freeze({
    schemaVersion: LIVE_WORKER_REGISTRY_DOCUMENT_SCHEMA_VERSION,
    expectedRevision: revision,
    targetRevision: revision + 1,
    publicationRevision: publication.revision,
    publicationFingerprint: publication.publicationFingerprint,
    registry,
  });
}

export function promoteLiveWorkerRegistry({
  path = resolveLiveWorkerRegistryPath(),
  expectedRevision,
  controllerNodeId = LIVE_WORKER_REGISTRY_CONTROLLER_NODE_ID,
  nodes = [],
  runtimeInstances = [],
  providerAccountCaps = {},
  deps = {},
} = {}) {
  const plan = planLiveWorkerRegistryPromotion({
    expectedRevision,
    controllerNodeId,
    nodes,
    runtimeInstances,
    providerAccountCaps,
  });
  return replaceLiveWorkerRegistry({
    path,
    expectedRevision,
    controllerNodeId,
    registry: {
      controllerNodeId: plan.registry.controllerNodeId,
      nodes: plan.registry.nodes,
      agentInstances: plan.registry.agentInstances,
      providerAccountCaps: plan.registry.providerAccountCaps,
    },
    deps,
  });
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
  if (instance.installedVersion !== accepted.installedVersion) {
    throw new LiveWorkerRegistryError('live-worker-registry-qualified-version-mismatch');
  }
  if (instance.qualificationContractFingerprint !== accepted.qualificationContractFingerprint) {
    throw new LiveWorkerRegistryError('live-worker-registry-qualified-contract-mismatch');
  }
  if (instance.qualificationCapabilityFingerprint !== accepted.capabilityFingerprint) {
    throw new LiveWorkerRegistryError('live-worker-registry-qualified-capability-mismatch');
  }
  if (instance.providerAccountClass !== accepted.providerAccountClass) {
    throw new LiveWorkerRegistryError('live-worker-registry-provider-account-class-mismatch');
  }
  if (JSON.stringify(instance.models) !== JSON.stringify(accepted.model ? [accepted.model] : [])) {
    throw new LiveWorkerRegistryError('live-worker-registry-qualified-model-mismatch');
  }
  if (JSON.stringify(instance.profiles) !== JSON.stringify(accepted.profile ? [accepted.profile] : [])) {
    throw new LiveWorkerRegistryError('live-worker-registry-qualified-profile-mismatch');
  }
  if (JSON.stringify(instance.jobClasses) !== JSON.stringify(accepted.jobClasses || [])) {
    throw new LiveWorkerRegistryError('live-worker-registry-qualified-job-class-mismatch');
  }
}

export function assertLiveInstanceActivationEligible(instance, registry = null) {
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
  if (instance.costPosture === 'included-subscription' && registry) {
    const cap = Number(registry.providerAccountCaps?.[instance.providerAccountClass]);
    if (!Number.isSafeInteger(cap) || cap < 1) {
      throw new LiveWorkerRegistryError('live-worker-registry-provider-account-cap-missing');
    }
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
  const activationAuthorities = normalizeActivationAuthorities(doc.activationAuthorities || {}, registry);
  const lastTransition = normalizeLastTransition(doc.lastTransition || null);
  return Object.freeze({
    schemaVersion: LIVE_WORKER_REGISTRY_DOCUMENT_SCHEMA_VERSION,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
    activationAuthorities,
    lastTransition,
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
  assertSafePathChain(path, fs, { requireLeaf: true });
  const mode = fs.lstatFn(resolve(path)).mode & 0o777;
  if (mode !== FILE_MODE) {
    throw new LiveWorkerRegistryError('live-worker-registry-file-mode-invalid');
  }
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
  // Refuse any existing symlink in the destination chain before mkdir/chmod
  // or lock/file creation can touch a symlink target.
  assertSafePathChain(path, fs, { requireLeaf: false });
  fs.mkdirFn(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodFn(dir, DIR_MODE);
  assertSafePathChain(path, fs, { requireLeaf: false });
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
  // The lock itself is a mutation, so path safety must be proven before it is
  // created. Prepare the parent only after proving the current path chain is
  // symlink-free, then re-check before lock creation.
  assertSafePathChain(path, fs, { requireLeaf: false });
  const dir = resolve(path, '..');
  fs.mkdirFn(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodFn(dir, DIR_MODE);
  assertSafePathChain(path, fs, { requireLeaf: false });
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
    mutate: ({ current, nextRevision, now }) => {
      if (current.registry?.agentInstances.some((instance) => instance.lifecycle !== 'disabled')) {
        throw new LiveWorkerRegistryError('live-worker-registry-replace-live-lifecycle-refused');
      }
      const registry = rebuildRegistry(rawRegistry, nextRevision);
      if (registry.agentInstances.some((instance) => instance.lifecycle !== 'disabled')) {
        throw new LiveWorkerRegistryError('live-worker-registry-replace-requires-disabled-instances');
      }
      return {
        schemaVersion: LIVE_WORKER_REGISTRY_DOCUMENT_SCHEMA_VERSION,
        revision: nextRevision,
        updatedAt: now,
        activationAuthorities: {},
        lastTransition: null,
        registry,
      };
    },
  });
}

export function transitionLiveWorkerInstance({
  path = resolveLiveWorkerRegistryPath(),
  expectedRevision,
  controllerNodeId,
  instanceId,
  targetState,
  activationAuthority,
  deps = {},
} = {}) {
  if (!INSTANCE_ID.test(String(instanceId || ''))) throw new LiveWorkerRegistryError('live-worker-registry-instance-id-invalid');
  if (!LIFECYCLE_STATES.includes(targetState)) throw new LiveWorkerRegistryError('live-worker-registry-lifecycle-invalid');
  const authority = assertValidatedFleetActivationAuthority(activationAuthority);
  if (authority.targetInstanceId !== instanceId || authority.targetState !== targetState) {
    throw new LiveWorkerRegistryError('live-worker-registry-activation-authority-target-mismatch');
  }
  return writeNext({
    path,
    expectedRevision,
    controllerNodeId,
    deps,
    mutate: ({ current, nextRevision, now }) => {
      if (!current.registry) throw new LiveWorkerRegistryError('live-worker-registry-missing');
      if (authority.targetRegistryRevision !== current.revision
        || authority.targetRegistryFingerprint !== current.registry.registryFingerprint) {
        throw new LiveWorkerRegistryError('live-worker-registry-activation-authority-registry-mismatch');
      }
      const currentInstance = current.registry.agentInstances.find((entry) => entry.instanceId === instanceId);
      if (!currentInstance) throw new LiveWorkerRegistryError('live-worker-registry-instance-not-found');
      if (currentInstance.active > 0 && targetState !== currentInstance.lifecycle) {
        throw new LiveWorkerRegistryError('live-worker-registry-active-work-conflict');
      }
      if (targetState === 'enabled') assertLiveInstanceActivationEligible(currentInstance, current.registry);

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
      if (targetState === 'enabled') assertLiveInstanceActivationEligible(nextInstance, registry);

      const activationAuthorities = { ...(current.document?.activationAuthorities || {}) };
      if (targetState === 'enabled') {
        activationAuthorities[instanceId] = {
          revision: authority.revision,
          fingerprint: authority.fingerprint,
          authorityKey: authority.authorityKey,
          bodyDigest: authority.bodyDigest,
          commentId: authority.commentId,
          targetSourceCommit: authority.targetSourceCommit,
        };
      } else {
        delete activationAuthorities[instanceId];
      }

      return {
        schemaVersion: LIVE_WORKER_REGISTRY_DOCUMENT_SCHEMA_VERSION,
        revision: nextRevision,
        updatedAt: now,
        activationAuthorities,
        lastTransition: {
          instanceId,
          targetState,
          authorityRevision: authority.revision,
          authorityFingerprint: authority.fingerprint,
          authorityKey: authority.authorityKey,
          authorityBodyDigest: authority.bodyDigest,
          authorityCommentId: authority.commentId,
          targetSourceCommit: authority.targetSourceCommit,
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
    activationAuthorities: loaded.document?.activationAuthorities || {},
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
