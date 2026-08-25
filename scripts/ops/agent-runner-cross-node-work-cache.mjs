import { createHash } from 'node:crypto';

import {
  DETERMINISTIC_WORK_FRESHNESS,
  createDeterministicWorkCacheKey,
  readDeterministicWorkCacheEntry,
} from './agent-runner-deterministic-work-cache.mjs';

export const CROSS_NODE_WORK_CACHE_SCHEMA_VERSION = 1;
export const CROSS_NODE_WORK_CACHE_REVISION = 'cross-node-work-cache-v1';
export const CROSS_NODE_WORK_CACHE_MAX_BYTES = 128 * 1024;

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const FORBIDDEN_VALUE = /(authorization|bearer\s+|password|passwd|secret|token|api[_-]?key|oauth|session[_-]?key|github_pat_|ghp_|sk-[A-Za-z0-9])/i;

const DESCRIPTOR_FIELDS = Object.freeze([
  'schemaVersion',
  'cacheClass',
  'freshness',
  'projectId',
  'githubRepo',
  'sourceFingerprint',
  'dirtyFingerprint',
  'command',
  'argv',
  'workingDirectoryIdentity',
  'inputDigests',
  'lockfileDigest',
  'toolchainFingerprint',
  'validationProfileFingerprint',
  'policyFingerprint',
  'platformFingerprint',
  'hostIndependent',
  'implementationRevision',
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  const input = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : JSON.stringify(stable(value));
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function exactFields(value, expected, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is invalid`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((item, index) => item !== wanted[index])) {
    throw new Error(`${name} field set is invalid`);
  }
}

function token(value, name) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function sha(value, name) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function isoTimestamp(value, name) {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function safeRelativePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) throw new Error(`${name} is invalid`);
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:[\\/]/.test(value)) throw new Error(`${name} must be repository-relative`);
  const segments = value.replaceAll('\\', '/').split('/');
  if (segments.includes('..')) throw new Error(`${name} contains parent traversal`);
  if (FORBIDDEN_VALUE.test(value)) throw new Error(`${name} contains restricted material`);
  return value;
}

function assertPortableDescriptor(descriptor) {
  exactFields(descriptor, DESCRIPTOR_FIELDS, 'descriptor');
  if (!SAFE_COMMAND.test(descriptor.command)) throw new Error('descriptor command is not portable');
  for (let index = 0; index < descriptor.argv.length; index += 1) {
    const value = descriptor.argv[index];
    if (typeof value !== 'string' || value.length > 1024) throw new Error(`descriptor argv[${index}] is invalid`);
    if (FORBIDDEN_VALUE.test(value)) throw new Error(`descriptor argv[${index}] contains restricted material`);
    if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:[\\/]/.test(value)) {
      throw new Error(`descriptor argv[${index}] contains an absolute path`);
    }
  }
  for (const key of Object.keys(descriptor.inputDigests)) safeRelativePath(key, 'descriptor inputDigests key');
  return descriptor;
}

function normalizeNodeIdentity(value = {}, name = 'node') {
  exactFields(value, ['nodeId', 'capabilityFingerprint', 'toolchainFingerprint', 'platformFingerprint'], name);
  return Object.freeze({
    nodeId: token(value.nodeId, `${name}.nodeId`),
    capabilityFingerprint: sha(value.capabilityFingerprint, `${name}.capabilityFingerprint`),
    toolchainFingerprint: sha(value.toolchainFingerprint, `${name}.toolchainFingerprint`),
    platformFingerprint: sha(value.platformFingerprint, `${name}.platformFingerprint`),
  });
}

function normalizeResult(value = {}) {
  exactFields(value, ['status', 'outputDigest', 'resultClass', 'counters'], 'result');
  if (value.status !== 'success') throw new Error('cross-node cache result must be successful');
  sha(value.outputDigest, 'result.outputDigest');
  if (value.resultClass !== null) token(value.resultClass, 'result.resultClass');
  if (!value.counters || typeof value.counters !== 'object' || Array.isArray(value.counters)) throw new Error('result.counters is invalid');
  if (Object.keys(value.counters).length > 32) throw new Error('result.counters has too many entries');
  const counters = {};
  for (const [key, raw] of Object.entries(value.counters).sort(([a], [b]) => a.localeCompare(b))) {
    token(key, 'result counter key');
    if (typeof raw === 'boolean' || raw === null) counters[key] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= Number.MAX_SAFE_INTEGER) counters[key] = raw;
    else throw new Error(`result counter ${key} is invalid`);
  }
  return Object.freeze({
    status: 'success',
    outputDigest: value.outputDigest,
    resultClass: value.resultClass,
    counters: Object.freeze(counters),
  });
}

function compatibilityFor(descriptor) {
  return Object.freeze({
    class: descriptor.hostIndependent ? 'host-independent' : 'exact-platform',
    toolchainFingerprint: descriptor.toolchainFingerprint,
    platformFingerprint: descriptor.hostIndependent ? 'host-independent' : descriptor.platformFingerprint,
  });
}

function validateCompatibility(value, descriptor) {
  exactFields(value, ['class', 'toolchainFingerprint', 'platformFingerprint'], 'compatibility');
  const expected = compatibilityFor(descriptor);
  if (JSON.stringify(stable(value)) !== JSON.stringify(stable(expected))) {
    throw new Error('compatibility binding mismatch');
  }
  return expected;
}

function envelopeDigest(value) {
  const copy = { ...value };
  delete copy.envelopeDigest;
  return digest(copy);
}

export function validateCrossNodeCacheEnvelope(input) {
  const value = typeof input === 'string' || Buffer.isBuffer(input)
    ? parseCrossNodeCacheEnvelope(input)
    : input;
  exactFields(value, [
    'schemaVersion',
    'revision',
    'cacheKey',
    'descriptor',
    'result',
    'producer',
    'compatibility',
    'createdAt',
    'envelopeDigest',
  ], 'cross-node cache envelope');
  if (value.schemaVersion !== CROSS_NODE_WORK_CACHE_SCHEMA_VERSION) throw new Error('cross-node cache schema mismatch');
  if (value.revision !== CROSS_NODE_WORK_CACHE_REVISION) throw new Error('cross-node cache revision mismatch');
  sha(value.cacheKey, 'cacheKey');
  sha(value.envelopeDigest, 'envelopeDigest');

  const { descriptor, cacheKey } = createDeterministicWorkCacheKey(value.descriptor);
  assertPortableDescriptor(descriptor);
  if (descriptor.freshness !== DETERMINISTIC_WORK_FRESHNESS.REUSABLE) throw new Error('fresh-required work cannot cross nodes');
  if (cacheKey !== value.cacheKey) throw new Error('cross-node cache key mismatch');
  if (JSON.stringify(stable(descriptor)) !== JSON.stringify(stable(value.descriptor))) {
    throw new Error('descriptor normalization mismatch');
  }

  const result = normalizeResult(value.result);
  const producer = normalizeNodeIdentity(value.producer, 'producer');
  const compatibility = validateCompatibility(value.compatibility, descriptor);
  const createdAt = isoTimestamp(value.createdAt, 'createdAt');

  if (producer.toolchainFingerprint !== descriptor.toolchainFingerprint) {
    throw new Error('producer toolchain does not match descriptor');
  }
  if (!descriptor.hostIndependent && producer.platformFingerprint !== descriptor.platformFingerprint) {
    throw new Error('producer platform does not match descriptor');
  }
  if (envelopeDigest(value) !== value.envelopeDigest) throw new Error('cross-node cache envelope integrity mismatch');

  return Object.freeze({
    schemaVersion: CROSS_NODE_WORK_CACHE_SCHEMA_VERSION,
    revision: CROSS_NODE_WORK_CACHE_REVISION,
    cacheKey,
    descriptor,
    result,
    producer,
    compatibility,
    createdAt,
    envelopeDigest: value.envelopeDigest,
  });
}

export function serializeCrossNodeCacheEnvelope(envelope) {
  const validated = validateCrossNodeCacheEnvelope(envelope);
  const serialized = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > CROSS_NODE_WORK_CACHE_MAX_BYTES) {
    throw new Error('cross-node cache envelope exceeds maximum size');
  }
  return serialized;
}

export function parseCrossNodeCacheEnvelope(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
  if (Buffer.byteLength(text, 'utf8') === 0 || Buffer.byteLength(text, 'utf8') > CROSS_NODE_WORK_CACHE_MAX_BYTES) {
    throw new Error('cross-node cache envelope size is invalid');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('cross-node cache envelope is invalid JSON');
  }
  return parsed;
}

export function exportCrossNodeCacheEnvelope({ root, descriptor, producer } = {}) {
  const { descriptor: normalized, cacheKey } = createDeterministicWorkCacheKey(descriptor);
  assertPortableDescriptor(normalized);
  if (normalized.freshness !== DETERMINISTIC_WORK_FRESHNESS.REUSABLE) {
    return Object.freeze({ exported: false, reason: 'fresh-required', cacheKey, envelope: null });
  }
  const producerIdentity = normalizeNodeIdentity(producer, 'producer');
  if (producerIdentity.toolchainFingerprint !== normalized.toolchainFingerprint) {
    return Object.freeze({ exported: false, reason: 'producer-toolchain-mismatch', cacheKey, envelope: null });
  }
  if (!normalized.hostIndependent && producerIdentity.platformFingerprint !== normalized.platformFingerprint) {
    return Object.freeze({ exported: false, reason: 'producer-platform-mismatch', cacheKey, envelope: null });
  }

  const local = readDeterministicWorkCacheEntry({
    root,
    descriptor: normalized,
    consumer: normalized.hostIndependent
      ? {}
      : {
          toolchainFingerprint: producerIdentity.toolchainFingerprint,
          platformFingerprint: producerIdentity.platformFingerprint,
        },
  });
  if (!local.hit) return Object.freeze({ exported: false, reason: local.reason, cacheKey, envelope: null });

  const envelope = {
    schemaVersion: CROSS_NODE_WORK_CACHE_SCHEMA_VERSION,
    revision: CROSS_NODE_WORK_CACHE_REVISION,
    cacheKey,
    descriptor: normalized,
    result: local.result,
    producer: producerIdentity,
    compatibility: compatibilityFor(normalized),
    createdAt: local.provenance.createdAt,
  };
  envelope.envelopeDigest = envelopeDigest(envelope);
  const validated = validateCrossNodeCacheEnvelope(envelope);
  serializeCrossNodeCacheEnvelope(validated);
  return Object.freeze({ exported: true, reason: null, cacheKey, envelope: validated });
}

export function consumeCrossNodeCacheEnvelope({ envelope, descriptor, consumer } = {}) {
  let validated;
  try {
    validated = validateCrossNodeCacheEnvelope(envelope);
  } catch (error) {
    return Object.freeze({ hit: false, reason: 'invalid-or-tampered-envelope', detail: String(error?.message || error) });
  }

  const { descriptor: expected, cacheKey } = createDeterministicWorkCacheKey(descriptor);
  try {
    assertPortableDescriptor(expected);
  } catch (error) {
    return Object.freeze({ hit: false, reason: 'consumer-descriptor-invalid', detail: String(error?.message || error) });
  }
  if (cacheKey !== validated.cacheKey || JSON.stringify(stable(expected)) !== JSON.stringify(stable(validated.descriptor))) {
    return Object.freeze({ hit: false, reason: 'cache-key-or-descriptor-mismatch', cacheKey });
  }

  let consumerIdentity;
  try {
    consumerIdentity = normalizeNodeIdentity(consumer, 'consumer');
  } catch (error) {
    return Object.freeze({ hit: false, reason: 'consumer-identity-invalid', detail: String(error?.message || error), cacheKey });
  }
  if (consumerIdentity.toolchainFingerprint !== validated.compatibility.toolchainFingerprint) {
    return Object.freeze({ hit: false, reason: 'consumer-toolchain-mismatch', cacheKey });
  }
  if (validated.compatibility.class === 'exact-platform'
    && consumerIdentity.platformFingerprint !== validated.compatibility.platformFingerprint) {
    return Object.freeze({ hit: false, reason: 'consumer-platform-mismatch', cacheKey });
  }

  const reuseFingerprint = digest({
    revision: CROSS_NODE_WORK_CACHE_REVISION,
    envelopeDigest: validated.envelopeDigest,
    cacheKey: validated.cacheKey,
    producerNode: validated.producer.nodeId,
    producerCapabilityFingerprint: validated.producer.capabilityFingerprint,
    consumerNode: consumerIdentity.nodeId,
    consumerCapabilityFingerprint: consumerIdentity.capabilityFingerprint,
    consumerToolchainFingerprint: consumerIdentity.toolchainFingerprint,
    consumerPlatformFingerprint: validated.compatibility.class === 'host-independent'
      ? 'host-independent'
      : consumerIdentity.platformFingerprint,
  });

  return Object.freeze({
    hit: true,
    reason: null,
    cacheKey: validated.cacheKey,
    result: validated.result,
    reuseEvidence: Object.freeze({
      schemaVersion: CROSS_NODE_WORK_CACHE_SCHEMA_VERSION,
      revision: CROSS_NODE_WORK_CACHE_REVISION,
      reuseStatus: 'cross-node-hit',
      cacheKey: validated.cacheKey,
      envelopeDigest: validated.envelopeDigest,
      reuseFingerprint,
      producerNode: validated.producer.nodeId,
      producerCapabilityFingerprint: validated.producer.capabilityFingerprint,
      producerToolchainFingerprint: validated.producer.toolchainFingerprint,
      compatibilityClass: validated.compatibility.class,
      consumerNode: consumerIdentity.nodeId,
      consumerCapabilityFingerprint: consumerIdentity.capabilityFingerprint,
      consumerToolchainFingerprint: consumerIdentity.toolchainFingerprint,
    }),
  });
}
