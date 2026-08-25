import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export const REMOTE_VALIDATION_SCHEMA_VERSION = 1;
export const REMOTE_VALIDATION_REVISION = 'remote-validation-v1';
export const REMOTE_VALIDATION_MAX_TTL_MS = 30 * 60 * 1_000;
export const REMOTE_VALIDATION_MAX_PROFILE_COMMANDS = 16;
export const REMOTE_VALIDATION_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40,64}$/i;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_EXECUTABLES = new Set(['node', 'npm', 'pnpm']);
const SAFE_ENVIRONMENT_NAMES = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'CI', 'NO_COLOR']);
const RESULT_STATES = new Set(['succeeded', 'failed', 'blocked']);

const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'revision', 'controllerNodeId', 'registryFingerprint', 'nodeId',
  'nodeCapabilityFingerprint', 'toolchainFingerprint', 'projectId', 'repository',
  'sourceSha', 'sourceTreeSha', 'profileId', 'profileRevision', 'profileContractFingerprint',
  'resourceClass', 'maxDurationSeconds', 'authorityFingerprint', 'authorityRevision',
  'requestedAt', 'expiresAt', 'jobFingerprint',
]);

const RESULT_FIELDS = Object.freeze([
  'schemaVersion', 'revision', 'jobFingerprint', 'controllerNodeId', 'registryFingerprint',
  'nodeId', 'nodeCapabilityFingerprint', 'toolchainFingerprint', 'projectId', 'repository',
  'observedSha', 'observedTreeSha', 'profileId', 'profileRevision', 'profileContractFingerprint',
  'resourceClass', 'status', 'exitCode', 'errorCode', 'durationMs', 'stdoutBytes',
  'stdoutDigest', 'stderrBytes', 'stderrDigest', 'startedAt', 'completedAt',
  'idempotencyKey', 'replayable', 'resultFingerprint',
]);

export const AGENT_RUNNER_REMOTE_VALIDATION_PROFILES = Object.freeze({
  'agent-runner-canonical': Object.freeze({
    revision: '1',
    resourceClass: 'standard',
    replayable: true,
    commands: Object.freeze([
      Object.freeze({
        argv: Object.freeze(['npm', 'run', 'validate']),
        workingDirectory: '.',
        environment: Object.freeze(['PATH', 'HOME', 'LANG', 'LC_ALL', 'CI', 'NO_COLOR']),
        timeoutSeconds: 1_800,
        maxOutputBytes: REMOTE_VALIDATION_MAX_OUTPUT_BYTES,
      }),
    ]),
  }),
});

export class RemoteValidationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'RemoteValidationError';
    this.code = code;
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digestValue(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}

function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function token(value, name) {
  const normalized = String(value ?? '').trim();
  if (!TOKEN.test(normalized)) throw new RemoteValidationError('invalid-contract', `${name} is invalid`);
  return normalized;
}

function sha(value, name) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!SHA.test(normalized)) throw new RemoteValidationError('invalid-contract', `${name} is invalid`);
  return normalized;
}

function repository(value) {
  const normalized = String(value ?? '').trim();
  if (!REPOSITORY.test(normalized)) throw new RemoteValidationError('invalid-contract', 'repository is invalid');
  return normalized;
}

function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw new RemoteValidationError('invalid-contract', `${name} is invalid`);
  }
  return normalized;
}

function iso(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RemoteValidationError('invalid-contract', `${name} is invalid`);
  return date.toISOString();
}

function exactFields(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((field, index) => field === wanted[index]);
}

function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function relativeDirectory(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || isAbsolute(normalized) || normalized.includes('\0')) {
    throw new RemoteValidationError('invalid-profile', 'workingDirectory is invalid');
  }
  const parts = normalized.split(/[\\/]+/);
  if (parts.some((part) => part === '..')) {
    throw new RemoteValidationError('invalid-profile', 'workingDirectory escapes the validation root');
  }
  return normalized;
}

function commandContract(raw, ordinal) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RemoteValidationError('invalid-profile', `command ${ordinal} is invalid`);
  }
  if (!Array.isArray(raw.argv) || raw.argv.length < 1 || raw.argv.length > 64) {
    throw new RemoteValidationError('invalid-profile', `command ${ordinal} argv is invalid`);
  }
  const argv = raw.argv.map((value, index) => {
    if (typeof value !== 'string' || value.length < 1 || value.length > 4_096 || value.includes('\0')) {
      throw new RemoteValidationError('invalid-profile', `command ${ordinal} argv ${index} is invalid`);
    }
    return value;
  });
  if (!EXECUTABLE.test(argv[0]) || !SAFE_EXECUTABLES.has(argv[0])) {
    throw new RemoteValidationError('invalid-profile', `command ${ordinal} executable is invalid`);
  }
  if (!Array.isArray(raw.environment) || raw.environment.length > SAFE_ENVIRONMENT_NAMES.size) {
    throw new RemoteValidationError('invalid-profile', `command ${ordinal} environment is invalid`);
  }
  const environment = [...new Set(raw.environment.map((name) => {
    const normalized = String(name ?? '').trim();
    if (!ENVIRONMENT_NAME.test(normalized) || !SAFE_ENVIRONMENT_NAMES.has(normalized)) {
      throw new RemoteValidationError('invalid-profile', `command ${ordinal} environment name is not allowed`);
    }
    return normalized;
  }))].sort();
  return Object.freeze({
    ordinal,
    argv: Object.freeze(argv),
    workingDirectory: relativeDirectory(raw.workingDirectory ?? '.'),
    environment: Object.freeze(environment),
    timeoutSeconds: integer(raw.timeoutSeconds, 'timeoutSeconds', { min: 1, max: 1_800 }),
    maxOutputBytes: integer(raw.maxOutputBytes ?? REMOTE_VALIDATION_MAX_OUTPUT_BYTES, 'maxOutputBytes', {
      min: 1,
      max: REMOTE_VALIDATION_MAX_OUTPUT_BYTES,
    }),
  });
}

export function normalizeRemoteValidationProfiles(rawProfiles = AGENT_RUNNER_REMOTE_VALIDATION_PROFILES) {
  if (!rawProfiles || typeof rawProfiles !== 'object' || Array.isArray(rawProfiles)) {
    throw new RemoteValidationError('invalid-profile', 'validation profiles must be an object');
  }
  const entries = Object.entries(rawProfiles);
  if (entries.length < 1 || entries.length > 32) {
    throw new RemoteValidationError('invalid-profile', 'validation profile count is invalid');
  }
  const normalized = {};
  for (const [profileIdRaw, raw] of entries) {
    const profileId = token(profileIdRaw, 'profileId');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RemoteValidationError('invalid-profile', `profile ${profileId} is invalid`);
    }
    if (!Array.isArray(raw.commands) || raw.commands.length < 1 || raw.commands.length > REMOTE_VALIDATION_MAX_PROFILE_COMMANDS) {
      throw new RemoteValidationError('invalid-profile', `profile ${profileId} command count is invalid`);
    }
    const commands = raw.commands.map(commandContract);
    const payload = {
      schemaVersion: REMOTE_VALIDATION_SCHEMA_VERSION,
      profileId,
      revision: token(raw.revision, 'profile revision'),
      resourceClass: token(raw.resourceClass ?? 'standard', 'resourceClass'),
      replayable: raw.replayable === true,
      commands,
      maxDurationSeconds: commands.reduce((sum, command) => sum + command.timeoutSeconds, 0),
    };
    normalized[profileId] = Object.freeze({ ...payload, profileContractFingerprint: digestValue(payload) });
  }
  return Object.freeze(normalized);
}

export function remoteValidationToolchainFingerprint(node) {
  if (!node || typeof node !== 'object') throw new RemoteValidationError('node-not-qualified', 'worker node is unavailable');
  return digestValue({
    nodeId: node.nodeId,
    os: node.os,
    arch: node.arch,
    toolchains: Array.isArray(node.toolchains) ? [...node.toolchains].sort() : [],
  });
}

function qualifiedValidationNode(registry, nodeId) {
  if (!registry || typeof registry !== 'object' || !Array.isArray(registry.nodes)) {
    throw new RemoteValidationError('registry-invalid', 'worker registry is invalid');
  }
  const requested = token(nodeId, 'nodeId');
  const node = registry.nodes.find((entry) => entry.nodeId === requested);
  if (!node) throw new RemoteValidationError('node-not-qualified', 'worker node is not registered');
  if (node.controller === true || node.workerOnly !== true) {
    throw new RemoteValidationError('node-not-qualified', 'remote validation requires a worker-only node');
  }
  if (node.state !== 'enabled' || node.readiness !== 'ready') {
    throw new RemoteValidationError('node-not-qualified', 'worker node is not enabled and ready');
  }
  if (!Array.isArray(node.jobClasses) || !node.jobClasses.includes('validation')) {
    throw new RemoteValidationError('node-not-qualified', 'worker node does not support validation');
  }
  if (!Array.isArray(node.capabilities) || !node.capabilities.includes('git')) {
    throw new RemoteValidationError('node-not-qualified', 'worker node lacks git capability');
  }
  if (!node.capacity || Number(node.capacity.available) < 1) {
    throw new RemoteValidationError('node-not-qualified', 'worker node has no available capacity');
  }
  if (!DIGEST.test(node.capabilityFingerprint || '')) {
    throw new RemoteValidationError('node-not-qualified', 'worker node capability fingerprint is invalid');
  }
  return node;
}

export function buildRemoteValidationRequest({
  registry,
  nodeId,
  projectId,
  repository: repositoryName,
  sourceSha,
  sourceTreeSha,
  profileId,
  profiles = AGENT_RUNNER_REMOTE_VALIDATION_PROFILES,
  authorityFingerprint,
  authorityRevision,
  requestedAt,
  expiresAt,
} = {}) {
  const node = qualifiedValidationNode(registry, nodeId);
  const normalizedProfiles = normalizeRemoteValidationProfiles(profiles);
  const profile = normalizedProfiles[token(profileId, 'profileId')];
  if (!profile) throw new RemoteValidationError('profile-not-allowlisted', 'validation profile is not allowlisted');
  if (!DIGEST.test(String(authorityFingerprint ?? ''))) {
    throw new RemoteValidationError('invalid-contract', 'authorityFingerprint is invalid');
  }
  const requested = iso(requestedAt, 'requestedAt');
  const expires = iso(expiresAt, 'expiresAt');
  const ttl = Date.parse(expires) - Date.parse(requested);
  if (ttl <= 0 || ttl > REMOTE_VALIDATION_MAX_TTL_MS) {
    throw new RemoteValidationError('invalid-contract', 'validation request TTL is invalid');
  }
  const payload = {
    schemaVersion: REMOTE_VALIDATION_SCHEMA_VERSION,
    revision: REMOTE_VALIDATION_REVISION,
    controllerNodeId: token(registry.controllerNodeId, 'controllerNodeId'),
    registryFingerprint: String(registry.registryFingerprint ?? ''),
    nodeId: node.nodeId,
    nodeCapabilityFingerprint: node.capabilityFingerprint,
    toolchainFingerprint: remoteValidationToolchainFingerprint(node),
    projectId: token(projectId, 'projectId'),
    repository: repository(repositoryName),
    sourceSha: sha(sourceSha, 'sourceSha'),
    sourceTreeSha: sha(sourceTreeSha, 'sourceTreeSha'),
    profileId: profile.profileId,
    profileRevision: profile.revision,
    profileContractFingerprint: profile.profileContractFingerprint,
    resourceClass: profile.resourceClass,
    maxDurationSeconds: profile.maxDurationSeconds,
    authorityFingerprint: String(authorityFingerprint),
    authorityRevision: token(authorityRevision, 'authorityRevision'),
    requestedAt: requested,
    expiresAt: expires,
  };
  if (!DIGEST.test(payload.registryFingerprint)) {
    throw new RemoteValidationError('registry-invalid', 'worker registry fingerprint is invalid');
  }
  return Object.freeze({ ...payload, jobFingerprint: digestValue(payload) });
}

export function validateRemoteValidationRequest({
  request,
  registry,
  executingNodeId,
  profiles = AGENT_RUNNER_REMOTE_VALIDATION_PROFILES,
  now = new Date(),
} = {}) {
  const refuse = (reason) => Object.freeze({ valid: false, reason });
  try {
    if (!exactFields(request, REQUEST_FIELDS)) return refuse('request-field-set-invalid');
    if (request.schemaVersion !== REMOTE_VALIDATION_SCHEMA_VERSION || request.revision !== REMOTE_VALIDATION_REVISION) {
      return refuse('request-schema-invalid');
    }
    if (request.controllerNodeId !== registry?.controllerNodeId) return refuse('controller-mismatch');
    if (request.registryFingerprint !== registry?.registryFingerprint) return refuse('registry-revision-mismatch');
    if (request.nodeId !== executingNodeId) return refuse('wrong-node');
    const node = qualifiedValidationNode(registry, executingNodeId);
    if (request.nodeCapabilityFingerprint !== node.capabilityFingerprint) return refuse('node-capability-changed');
    if (request.toolchainFingerprint !== remoteValidationToolchainFingerprint(node)) return refuse('toolchain-changed');
    repository(request.repository);
    sha(request.sourceSha, 'sourceSha');
    sha(request.sourceTreeSha, 'sourceTreeSha');
    token(request.projectId, 'projectId');
    token(request.authorityRevision, 'authorityRevision');
    if (!DIGEST.test(request.authorityFingerprint || '')) return refuse('authority-invalid');
    const normalizedProfiles = normalizeRemoteValidationProfiles(profiles);
    const profile = normalizedProfiles[request.profileId];
    if (!profile) return refuse('profile-not-allowlisted');
    if (
      request.profileRevision !== profile.revision
      || request.profileContractFingerprint !== profile.profileContractFingerprint
      || request.resourceClass !== profile.resourceClass
      || request.maxDurationSeconds !== profile.maxDurationSeconds
    ) return refuse('profile-contract-changed');
    const requestedAt = Date.parse(iso(request.requestedAt, 'requestedAt'));
    const expiresAt = Date.parse(iso(request.expiresAt, 'expiresAt'));
    const current = new Date(now).getTime();
    if (expiresAt <= requestedAt || expiresAt - requestedAt > REMOTE_VALIDATION_MAX_TTL_MS) return refuse('request-ttl-invalid');
    if (!Number.isFinite(current) || current >= expiresAt) return refuse('request-expired');
    const candidate = { ...request };
    delete candidate.jobFingerprint;
    if (!DIGEST.test(request.jobFingerprint || '') || digestValue(candidate) !== request.jobFingerprint) {
      return refuse('job-fingerprint-mismatch');
    }
    return Object.freeze({
      valid: true,
      reason: null,
      profile,
      nodeCapabilityFingerprint: node.capabilityFingerprint,
      toolchainFingerprint: request.toolchainFingerprint,
    });
  } catch (error) {
    return refuse(error instanceof RemoteValidationError ? error.code : 'request-invalid');
  }
}

export function buildRemoteValidationResult({
  request,
  status,
  observedSha,
  observedTreeSha,
  exitCode = null,
  errorCode = null,
  durationMs,
  stdoutBytes = 0,
  stdoutDigest = digestBytes(''),
  stderrBytes = 0,
  stderrDigest = digestBytes(''),
  startedAt,
  completedAt,
  replayable = false,
} = {}) {
  if (!request?.jobFingerprint || !DIGEST.test(request.jobFingerprint)) {
    throw new RemoteValidationError('invalid-result', 'valid request is required');
  }
  if (!RESULT_STATES.has(status)) throw new RemoteValidationError('invalid-result', 'status is invalid');
  const payload = {
    schemaVersion: REMOTE_VALIDATION_SCHEMA_VERSION,
    revision: REMOTE_VALIDATION_REVISION,
    jobFingerprint: request.jobFingerprint,
    controllerNodeId: request.controllerNodeId,
    registryFingerprint: request.registryFingerprint,
    nodeId: request.nodeId,
    nodeCapabilityFingerprint: request.nodeCapabilityFingerprint,
    toolchainFingerprint: request.toolchainFingerprint,
    projectId: request.projectId,
    repository: request.repository,
    observedSha: sha(observedSha, 'observedSha'),
    observedTreeSha: sha(observedTreeSha, 'observedTreeSha'),
    profileId: request.profileId,
    profileRevision: request.profileRevision,
    profileContractFingerprint: request.profileContractFingerprint,
    resourceClass: request.resourceClass,
    status,
    exitCode: exitCode === null ? null : integer(exitCode, 'exitCode', { min: 0, max: 255 }),
    errorCode: errorCode === null ? null : token(errorCode, 'errorCode'),
    durationMs: integer(durationMs, 'durationMs', { min: 0, max: request.maxDurationSeconds * 1_000 + 60_000 }),
    stdoutBytes: integer(stdoutBytes, 'stdoutBytes', { min: 0, max: REMOTE_VALIDATION_MAX_PROFILE_COMMANDS * REMOTE_VALIDATION_MAX_OUTPUT_BYTES }),
    stdoutDigest: String(stdoutDigest),
    stderrBytes: integer(stderrBytes, 'stderrBytes', { min: 0, max: REMOTE_VALIDATION_MAX_PROFILE_COMMANDS * REMOTE_VALIDATION_MAX_OUTPUT_BYTES }),
    stderrDigest: String(stderrDigest),
    startedAt: iso(startedAt, 'startedAt'),
    completedAt: iso(completedAt, 'completedAt'),
    idempotencyKey: request.jobFingerprint,
    replayable: replayable === true,
  };
  if (!DIGEST.test(payload.stdoutDigest) || !DIGEST.test(payload.stderrDigest)) {
    throw new RemoteValidationError('invalid-result', 'output digest is invalid');
  }
  return Object.freeze({ ...payload, resultFingerprint: digestValue(payload) });
}

export function acceptRemoteValidationResult({
  request,
  result,
  registry,
  profiles = AGENT_RUNNER_REMOTE_VALIDATION_PROFILES,
  now = new Date(),
} = {}) {
  const refuse = (reason) => Object.freeze({ accepted: false, reason });
  const requestValidation = validateRemoteValidationRequest({
    request,
    registry,
    executingNodeId: request?.nodeId,
    profiles,
    now,
  });
  if (!requestValidation.valid) return refuse(`request:${requestValidation.reason}`);
  if (!exactFields(result, RESULT_FIELDS)) return refuse('result-field-set-invalid');
  if (result.schemaVersion !== REMOTE_VALIDATION_SCHEMA_VERSION || result.revision !== REMOTE_VALIDATION_REVISION) {
    return refuse('result-schema-invalid');
  }
  for (const field of [
    'jobFingerprint', 'controllerNodeId', 'registryFingerprint', 'nodeId', 'nodeCapabilityFingerprint',
    'toolchainFingerprint', 'projectId', 'repository', 'profileId', 'profileRevision',
    'profileContractFingerprint', 'resourceClass',
  ]) {
    if (result[field] !== request[field]) return refuse(`result-identity-mismatch:${field}`);
  }
  if (result.idempotencyKey !== request.jobFingerprint) return refuse('idempotency-key-mismatch');
  if (result.observedSha !== request.sourceSha) return refuse('source-sha-mismatch');
  if (result.observedTreeSha !== request.sourceTreeSha) return refuse('source-tree-mismatch');
  if (!DIGEST.test(result.stdoutDigest || '') || !DIGEST.test(result.stderrDigest || '')) return refuse('output-digest-invalid');
  if (!RESULT_STATES.has(result.status)) return refuse('result-status-invalid');
  const startedAt = Date.parse(result.startedAt);
  const completedAt = Date.parse(result.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) return refuse('result-time-invalid');
  if (startedAt < Date.parse(request.requestedAt) || completedAt > Date.parse(request.expiresAt)) return refuse('result-outside-authority-window');
  if (!Number.isSafeInteger(result.durationMs) || result.durationMs < 0 || result.durationMs > request.maxDurationSeconds * 1_000 + 60_000) {
    return refuse('duration-invalid');
  }
  const candidate = { ...result };
  delete candidate.resultFingerprint;
  if (!DIGEST.test(result.resultFingerprint || '') || digestValue(candidate) !== result.resultFingerprint) {
    return refuse('result-fingerprint-mismatch');
  }
  if (result.status !== 'succeeded' || result.exitCode !== 0 || result.errorCode !== null) {
    return refuse(`validation-${result.status}`);
  }
  return Object.freeze({
    accepted: true,
    reason: 'remote-validation-accepted',
    jobFingerprint: request.jobFingerprint,
    resultFingerprint: result.resultFingerprint,
    nodeId: result.nodeId,
    sourceSha: result.observedSha,
    sourceTreeSha: result.observedTreeSha,
    profileId: result.profileId,
  });
}

function safeChildEnv(environmentNames, env, { homeOverride = null } = {}) {
  const child = {};
  for (const name of environmentNames) {
    if (name === 'HOME' && homeOverride) child.HOME = homeOverride;
    else if (env[name] != null) child[name] = String(env[name]);
  }
  child.NO_COLOR = '1';
  child.CI = '1';
  child.GIT_TERMINAL_PROMPT = '0';
  return child;
}

function run(spawn, command, args, options, errorCode) {
  const child = spawn(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    ...options,
  });
  if (child.error || child.status !== 0) {
    throw new RemoteValidationError(errorCode, `${command} failed`);
  }
  return child;
}

function gitValue(spawn, repositoryPath, args, env, timeout = 30_000) {
  const child = run(spawn, 'git', ['-C', repositoryPath, ...args], {
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    env: safeChildEnv(['PATH', 'HOME', 'LANG', 'LC_ALL'], env),
  }, 'git-operation-failed');
  return String(child.stdout || '').trim();
}

function githubRepositoryFromRemote(value) {
  const remote = String(value || '').trim();
  let candidate = null;
  if (remote.startsWith('https://github.com/')) {
    try {
      const url = new URL(remote);
      if (url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) return null;
      candidate = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    } catch {
      return null;
    }
  } else {
    const scp = remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
    const ssh = remote.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
    candidate = scp?.[1] || ssh?.[1] || null;
  }
  return candidate && REPOSITORY.test(candidate) ? candidate : null;
}

function verifyWorktree(spawn, path, request, env) {
  const observedSha = gitValue(spawn, path, ['rev-parse', 'HEAD'], env).toLowerCase();
  const observedTreeSha = gitValue(spawn, path, ['rev-parse', 'HEAD^{tree}'], env).toLowerCase();
  const status = gitValue(spawn, path, ['status', '--porcelain=v1', '--untracked-files=all'], env);
  return Object.freeze({
    observedSha,
    observedTreeSha,
    clean: status.length === 0,
    exact: observedSha === request.sourceSha && observedTreeSha === request.sourceTreeSha,
  });
}

export class RemoteValidationReplayStore {
  constructor(rootPath) {
    this.rootPath = resolve(rootPath);
    if (existsSync(this.rootPath)) {
      const stat = lstatSync(this.rootPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new RemoteValidationError('replay-store-invalid', 'replay store must be a real directory');
      }
    } else {
      mkdirSync(this.rootPath, { recursive: true, mode: 0o700 });
    }
    this.rootPath = realpathSync(this.rootPath);
  }

  pathFor(jobFingerprint) {
    if (!DIGEST.test(jobFingerprint || '')) throw new RemoteValidationError('replay-store-invalid', 'job fingerprint is invalid');
    return resolve(this.rootPath, `${jobFingerprint.slice('sha256:'.length)}.json`);
  }

  read(jobFingerprint) {
    const path = this.pathFor(jobFingerprint);
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
      throw new RemoteValidationError('replay-store-invalid', 'replay record is invalid');
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new RemoteValidationError('replay-store-invalid', 'replay record is not valid JSON');
    }
    return parsed;
  }

  write(result) {
    const path = this.pathFor(result?.jobFingerprint);
    const body = `${JSON.stringify(result)}\n`;
    try {
      writeFileSync(path, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return result;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = this.read(result.jobFingerprint);
      if (existing?.resultFingerprint !== result.resultFingerprint) {
        throw new RemoteValidationError('replay-store-collision', 'existing replay result differs');
      }
      return existing;
    }
  }
}

export function executeRemoteValidationRequest({
  request,
  registry,
  executingNodeId,
  sourceRepositoryPath,
  worktreeRoot,
  replayStore = null,
  profiles = AGENT_RUNNER_REMOTE_VALIDATION_PROFILES,
  env = process.env,
  spawn = spawnSync,
  clock = () => new Date(),
} = {}) {
  const validation = validateRemoteValidationRequest({ request, registry, executingNodeId, profiles, now: clock() });
  if (!validation.valid) throw new RemoteValidationError(validation.reason, 'remote validation request refused');
  const profile = validation.profile;

  if (profile.replayable && replayStore) {
    const existing = replayStore.read(request.jobFingerprint);
    if (existing) {
      const accepted = acceptRemoteValidationResult({ request, result: existing, registry, profiles, now: clock() });
      if (!accepted.accepted) throw new RemoteValidationError('replay-record-invalid', accepted.reason);
      return Object.freeze({ replay: true, result: Object.freeze(existing) });
    }
  }

  const sourceRoot = realpathSync(resolve(sourceRepositoryPath));
  const sourceOrigin = gitValue(spawn, sourceRoot, ['remote', 'get-url', 'origin'], env);
  if (githubRepositoryFromRemote(sourceOrigin) !== request.repository) {
    throw new RemoteValidationError('repository-identity-mismatch', 'trusted source repository does not match request');
  }

  const rootCandidate = resolve(worktreeRoot);
  if (!existsSync(rootCandidate)) mkdirSync(rootCandidate, { recursive: true, mode: 0o700 });
  const worktreeBase = realpathSync(rootCandidate);
  const suffix = request.jobFingerprint.slice('sha256:'.length, 'sha256:'.length + 24);
  const target = resolve(worktreeBase, `remote-validation-${suffix}`);
  const isolatedHome = resolve(worktreeBase, `remote-validation-home-${suffix}`);
  if (!inside(worktreeBase, target) || target === worktreeBase || !inside(worktreeBase, isolatedHome) || isolatedHome === worktreeBase) {
    throw new RemoteValidationError('worktree-path-invalid', 'derived validation path is invalid');
  }
  if (existsSync(target)) throw new RemoteValidationError('worktree-collision', 'derived validation worktree already exists');
  if (existsSync(isolatedHome)) throw new RemoteValidationError('isolated-home-collision', 'derived validation home already exists');

  const sourceCommit = gitValue(spawn, sourceRoot, ['rev-parse', `${request.sourceSha}^{commit}`], env).toLowerCase();
  const sourceTree = gitValue(spawn, sourceRoot, ['rev-parse', `${request.sourceSha}^{tree}`], env).toLowerCase();
  if (sourceCommit !== request.sourceSha) throw new RemoteValidationError('source-sha-unavailable', 'exact source commit is unavailable');
  if (sourceTree !== request.sourceTreeSha) throw new RemoteValidationError('source-tree-mismatch', 'exact source tree differs from request');

  run(spawn, 'git', ['-C', sourceRoot, 'worktree', 'add', '--detach', target, request.sourceSha], {
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    env: safeChildEnv(['PATH', 'HOME', 'LANG', 'LC_ALL'], env),
  }, 'worktree-create-failed');
  mkdirSync(isolatedHome, { mode: 0o700 });

  const startedAt = clock();
  const startedNs = process.hrtime.bigint();
  let state = 'succeeded';
  let exitCode = 0;
  let errorCode = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutHash = createHash('sha256');
  const stderrHash = createHash('sha256');
  let post = null;

  try {
    const before = verifyWorktree(spawn, target, request, env);
    if (!before.exact || !before.clean) {
      state = 'blocked';
      exitCode = null;
      errorCode = before.exact ? 'worktree-not-clean-before' : 'worktree-identity-mismatch-before';
    }

    for (const command of state === 'succeeded' ? profile.commands : []) {
      const cwdCandidate = resolve(target, command.workingDirectory);
      if (!inside(target, cwdCandidate)) {
        state = 'blocked';
        exitCode = null;
        errorCode = 'working-directory-escaped';
        break;
      }
      let cwd;
      try {
        cwd = realpathSync(cwdCandidate);
      } catch {
        state = 'blocked';
        exitCode = null;
        errorCode = 'working-directory-unavailable';
        break;
      }
      if (!inside(realpathSync(target), cwd)) {
        state = 'blocked';
        exitCode = null;
        errorCode = 'working-directory-escaped';
        break;
      }
      const child = spawn(command.argv[0], command.argv.slice(1), {
        cwd,
        env: safeChildEnv(command.environment, env, { homeOverride: isolatedHome }),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: command.timeoutSeconds * 1_000,
        maxBuffer: command.maxOutputBytes,
        shell: false,
      });
      const stdout = String(child.stdout || '');
      const stderr = String(child.stderr || '');
      stdoutBytes += Buffer.byteLength(stdout);
      stderrBytes += Buffer.byteLength(stderr);
      stdoutHash.update(stdout);
      stderrHash.update(stderr);
      if (child.error) {
        state = 'failed';
        exitCode = null;
        errorCode = child.error.code === 'ETIMEDOUT' ? 'validation-command-timeout' : 'validation-command-execution-error';
        break;
      }
      if (child.status !== 0) {
        state = 'failed';
        exitCode = Number.isInteger(child.status) ? child.status : null;
        errorCode = 'validation-command-failed';
        break;
      }
    }

    post = verifyWorktree(spawn, target, request, env);
    if (!post.exact) {
      state = 'blocked';
      exitCode = null;
      errorCode = 'worktree-identity-mismatch-after';
    } else if (!post.clean) {
      state = 'blocked';
      exitCode = null;
      errorCode = 'worktree-not-clean-after';
    }
  } catch (error) {
    state = 'blocked';
    exitCode = null;
    errorCode = error instanceof RemoteValidationError ? error.code : 'validation-executor-failed';
  } finally {
    if (post?.clean && post?.exact) {
      try {
        run(spawn, 'git', ['-C', sourceRoot, 'worktree', 'remove', target], {
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
          env: safeChildEnv(['PATH', 'HOME', 'LANG', 'LC_ALL'], env),
        }, 'worktree-cleanup-failed');
      } catch {
        state = 'blocked';
        exitCode = null;
        errorCode = 'worktree-cleanup-failed';
      }
    }
    try {
      rmSync(isolatedHome, { recursive: true, force: true });
    } catch {
      state = 'blocked';
      exitCode = null;
      errorCode = 'isolated-home-cleanup-failed';
    }
  }

  const completedAt = clock();
  const durationMs = Number((process.hrtime.bigint() - startedNs) / 1_000_000n);
  const observedSha = post?.observedSha ?? request.sourceSha;
  const observedTreeSha = post?.observedTreeSha ?? request.sourceTreeSha;
  const result = buildRemoteValidationResult({
    request,
    status: state,
    observedSha,
    observedTreeSha,
    exitCode,
    errorCode,
    durationMs,
    stdoutBytes,
    stdoutDigest: `sha256:${stdoutHash.digest('hex')}`,
    stderrBytes,
    stderrDigest: `sha256:${stderrHash.digest('hex')}`,
    startedAt,
    completedAt,
    replayable: profile.replayable,
  });

  if (state === 'succeeded' && profile.replayable && replayStore) replayStore.write(result);
  return Object.freeze({ replay: false, result });
}

export function remoteValidationControlSurface() {
  return Object.freeze({
    schemaVersion: REMOTE_VALIDATION_SCHEMA_VERSION,
    scheduler: false,
    queueSelection: false,
    issueClaim: false,
    managerAuthority: false,
    githubMutation: false,
    mergeCloseDeploy: false,
    sourceActivation: false,
    providerInvocation: false,
    arbitraryShell: false,
    requestPaths: false,
    acceptedInput: 'validated-remote-validation-request',
    acceptedOutput: 'bounded-provenance-result',
  });
}
