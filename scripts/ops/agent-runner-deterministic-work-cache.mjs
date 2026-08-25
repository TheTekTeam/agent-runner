import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';

export const DETERMINISTIC_WORK_CACHE_SCHEMA_VERSION = 1;
export const DETERMINISTIC_WORK_CACHE_CLASSES = Object.freeze([
  'template', 'analysis', 'compile', 'test-substep', 'validation-evidence',
]);
export const DETERMINISTIC_WORK_FRESHNESS = Object.freeze({ REUSABLE: 'reusable', FRESH_REQUIRED: 'fresh-required' });

const CACHE_CLASS_SET = new Set(DETERMINISTIC_WORK_CACHE_CLASSES);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function digest(value) {
  const input = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value));
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function token(value, name) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function sha(value, name) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${name} must be a sha256 fingerprint`);
  return value;
}

function boundedString(value, name, max = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function normalizedDigestMap(value, name) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > 128) throw new Error(`${name} has too many entries`);
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, fingerprint]) => [
    boundedString(key, `${name} key`, 240), sha(fingerprint, `${name}.${key}`),
  ]));
}

function normalizeArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64) throw new Error('argv is invalid');
  return argv.map((value, index) => boundedString(value, `argv[${index}]`, 1024));
}

function normalizeDescriptor(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('cache descriptor is required');
  const cacheClass = token(raw.cacheClass, 'cacheClass');
  if (!CACHE_CLASS_SET.has(cacheClass)) throw new Error('cacheClass is not reusable');
  const freshness = raw.freshness || DETERMINISTIC_WORK_FRESHNESS.REUSABLE;
  if (!Object.values(DETERMINISTIC_WORK_FRESHNESS).includes(freshness)) throw new Error('freshness is invalid');
  const githubRepo = boundedString(raw.githubRepo, 'githubRepo', 240).toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(githubRepo)) throw new Error('githubRepo is invalid');
  const hostIndependent = raw.hostIndependent === true;
  return Object.freeze({
    schemaVersion: DETERMINISTIC_WORK_CACHE_SCHEMA_VERSION,
    cacheClass,
    freshness,
    projectId: token(raw.projectId, 'projectId'),
    githubRepo,
    sourceFingerprint: sha(raw.sourceFingerprint, 'sourceFingerprint'),
    dirtyFingerprint: sha(raw.dirtyFingerprint, 'dirtyFingerprint'),
    command: boundedString(raw.command, 'command', 240),
    argv: normalizeArgv(raw.argv),
    workingDirectoryIdentity: sha(raw.workingDirectoryIdentity, 'workingDirectoryIdentity'),
    inputDigests: normalizedDigestMap(raw.inputDigests, 'inputDigests'),
    lockfileDigest: raw.lockfileDigest == null ? null : sha(raw.lockfileDigest, 'lockfileDigest'),
    toolchainFingerprint: sha(raw.toolchainFingerprint, 'toolchainFingerprint'),
    validationProfileFingerprint: raw.validationProfileFingerprint == null ? null : sha(raw.validationProfileFingerprint, 'validationProfileFingerprint'),
    policyFingerprint: sha(raw.policyFingerprint, 'policyFingerprint'),
    platformFingerprint: hostIndependent ? 'host-independent' : sha(raw.platformFingerprint, 'platformFingerprint'),
    hostIndependent,
    implementationRevision: token(raw.implementationRevision || 'v1', 'implementationRevision'),
  });
}

function normalizeCounters(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('counters must be an object');
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error('counters has too many entries');
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, raw]) => {
    const name = token(key, 'counter key');
    if (typeof raw === 'boolean' || raw === null) return [name, raw];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= Number.MAX_SAFE_INTEGER) return [name, raw];
    throw new Error(`counter ${name} is invalid`);
  }));
}

function normalizeResult(result = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('result is required');
  if (result.status !== 'success') throw new Error('only successful deterministic work may be cached');
  return Object.freeze({
    status: 'success',
    outputDigest: sha(result.outputDigest, 'outputDigest'),
    resultClass: result.resultClass == null ? null : token(result.resultClass, 'resultClass'),
    counters: normalizeCounters(result.counters),
  });
}

export function currentPlatformFingerprint(extra = {}) {
  return digest({ platform: platform(), arch: arch(), ...stable(extra) });
}

export function defaultDeterministicWorkCacheRoot(env = process.env) {
  return resolve(env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache'), 'agent-runner', 'deterministic-work');
}

export function createDeterministicWorkCacheKey(descriptor) {
  const normalized = normalizeDescriptor(descriptor);
  return Object.freeze({ descriptor: normalized, cacheKey: digest(normalized) });
}

function ensureDirectory(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe deterministic work cache directory: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

function namespacePath(root, descriptor) {
  return join(root, `${descriptor.projectId}-${digest(descriptor.githubRepo).slice(7, 19)}`);
}

function entryPath(root, descriptor, cacheKey) {
  return join(namespacePath(root, descriptor), `${cacheKey.slice(7)}.json`);
}

function safeRead(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe deterministic work cache entry');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (String(error?.message || '').includes('unsafe deterministic work cache')) throw error;
    return null;
  }
}

function recordDigest(record) {
  const copy = { ...record };
  delete copy.integrityDigest;
  return digest(copy);
}

export function writeDeterministicWorkCacheEntry({ root = defaultDeterministicWorkCacheRoot(), descriptor, result, producer = {}, now = () => new Date().toISOString() } = {}) {
  const normalizedRoot = resolve(root);
  const { descriptor: normalized, cacheKey } = createDeterministicWorkCacheKey(descriptor);
  if (normalized.freshness === DETERMINISTIC_WORK_FRESHNESS.FRESH_REQUIRED) return Object.freeze({ stored: false, reason: 'fresh-required', cacheKey });
  const normalizedResult = normalizeResult(result);
  const record = {
    schemaVersion: DETERMINISTIC_WORK_CACHE_SCHEMA_VERSION,
    cacheKey,
    descriptor: normalized,
    result: normalizedResult,
    provenance: {
      createdAt: boundedString(now(), 'createdAt', 64),
      producerNode: producer.nodeId == null ? null : token(producer.nodeId, 'producer.nodeId'),
      producerToolchainFingerprint: producer.toolchainFingerprint == null ? normalized.toolchainFingerprint : sha(producer.toolchainFingerprint, 'producer.toolchainFingerprint'),
      producerPlatformFingerprint: normalized.platformFingerprint,
    },
  };
  record.integrityDigest = recordDigest(record);
  ensureDirectory(normalizedRoot);
  const namespace = namespacePath(normalizedRoot, normalized);
  ensureDirectory(namespace);
  const path = entryPath(normalizedRoot, normalized, cacheKey);
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return Object.freeze({ stored: true, reason: null, cacheKey, path });
}

function compatibleConsumer(record, consumer = {}) {
  if (record.descriptor.hostIndependent) return true;
  const toolchain = consumer.toolchainFingerprint == null ? record.descriptor.toolchainFingerprint : sha(consumer.toolchainFingerprint, 'consumer.toolchainFingerprint');
  const platformValue = consumer.platformFingerprint == null ? record.descriptor.platformFingerprint : sha(consumer.platformFingerprint, 'consumer.platformFingerprint');
  return toolchain === record.descriptor.toolchainFingerprint && platformValue === record.descriptor.platformFingerprint;
}

export function readDeterministicWorkCacheEntry({ root = defaultDeterministicWorkCacheRoot(), descriptor, consumer = {}, maxAgeMs = null, nowMs = () => Date.now() } = {}) {
  const normalizedRoot = resolve(root);
  const { descriptor: normalized, cacheKey } = createDeterministicWorkCacheKey(descriptor);
  if (normalized.freshness === DETERMINISTIC_WORK_FRESHNESS.FRESH_REQUIRED) return Object.freeze({ hit: false, reason: 'fresh-required', cacheKey });
  const path = entryPath(normalizedRoot, normalized, cacheKey);
  const record = safeRead(path);
  if (!record) return Object.freeze({ hit: false, reason: 'miss-or-corrupt', cacheKey });
  if (record.schemaVersion !== DETERMINISTIC_WORK_CACHE_SCHEMA_VERSION) return Object.freeze({ hit: false, reason: 'schema-mismatch', cacheKey });
  if (record.cacheKey !== cacheKey || digest(record.descriptor) !== cacheKey) return Object.freeze({ hit: false, reason: 'identity-mismatch', cacheKey });
  if (record.integrityDigest !== recordDigest(record)) return Object.freeze({ hit: false, reason: 'integrity-mismatch', cacheKey });
  if (record.result?.status !== 'success' || !SHA256.test(record.result?.outputDigest || '')) return Object.freeze({ hit: false, reason: 'invalid-result', cacheKey });
  if (!compatibleConsumer(record, consumer)) return Object.freeze({ hit: false, reason: 'host-or-toolchain-mismatch', cacheKey });
  if (maxAgeMs != null) {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error('maxAgeMs is invalid');
    const created = Date.parse(record.provenance?.createdAt || '');
    if (!Number.isFinite(created) || nowMs() - created > maxAgeMs) return Object.freeze({ hit: false, reason: 'expired', cacheKey });
  }
  return Object.freeze({ hit: true, reason: null, cacheKey, result: record.result, provenance: record.provenance, path });
}

export function pruneDeterministicWorkCache({ root = defaultDeterministicWorkCacheRoot(), maxEntries = 1000, maxBytes = 1024 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 0) throw new Error('maxEntries is invalid');
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error('maxBytes is invalid');
  const normalizedRoot = resolve(root);
  let namespaces;
  try {
    namespaces = readdirSync(normalizedRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ removed: 0, remaining: 0, bytes: 0 });
    throw error;
  }
  const entries = [];
  for (const namespace of namespaces) {
    if (!namespace.isDirectory() || namespace.isSymbolicLink()) continue;
    const dir = join(normalizedRoot, namespace.name);
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (!item.isFile() || item.isSymbolicLink() || !item.name.endsWith('.json')) continue;
      const path = join(dir, item.name);
      const stat = statSync(path);
      entries.push({ path, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let kept = 0;
  let bytes = 0;
  let removed = 0;
  for (const entry of entries) {
    if (kept < maxEntries && bytes + entry.bytes <= maxBytes) {
      kept += 1;
      bytes += entry.bytes;
    } else {
      rmSync(entry.path, { force: true });
      removed += 1;
    }
  }
  return Object.freeze({ removed, remaining: kept, bytes });
}
