import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  buildRepositoryNavigationCapsule,
  captureRepositorySourceIdentity,
  loadOrBuildRepositoryMap,
} from './agent-runner-repository-map.mjs';

export const DETERMINISTIC_PREFLIGHT_SCHEMA_VERSION = 1;
export const DETERMINISTIC_PREFLIGHT_ENGINE_REVISION = 'deterministic-preflight-v1';

export const DETERMINISTIC_CAPABILITY_CLASSES = Object.freeze({
  DISCOVERY: 'read-only-discovery',
  VALIDATION: 'read-only-validation',
  MUTATION: 'deterministic-repository-mutation',
  OPERATOR: 'operator-only',
});

export const BUILTIN_DETERMINISTIC_CAPABILITIES = Object.freeze({
  'repository-identity': Object.freeze({
    revision: '1',
    class: DETERMINISTIC_CAPABILITY_CLASSES.DISCOVERY,
    defaultOptional: false,
  }),
  'git-status': Object.freeze({
    revision: '1',
    class: DETERMINISTIC_CAPABILITY_CLASSES.DISCOVERY,
    defaultOptional: true,
  }),
  'changed-files': Object.freeze({
    revision: '1',
    class: DETERMINISTIC_CAPABILITY_CLASSES.DISCOVERY,
    defaultOptional: true,
  }),
  'diff-check': Object.freeze({
    revision: '1',
    class: DETERMINISTIC_CAPABILITY_CLASSES.VALIDATION,
    defaultOptional: true,
  }),
  'repository-map': Object.freeze({
    revision: '1',
    class: DETERMINISTIC_CAPABILITY_CLASSES.DISCOVERY,
    defaultOptional: true,
  }),
  'toolchain-facts': Object.freeze({
    revision: '1',
    class: DETERMINISTIC_CAPABILITY_CLASSES.DISCOVERY,
    defaultOptional: true,
  }),
});

const FORBIDDEN_COMMAND_TOKENS = new Set([
  'reset', 'rebase', 'stash', 'clean', 'push', 'commit', 'checkout', 'switch', 'merge',
  'cherry-pick', 'revert', 'tag', 'branch', 'worktree', 'update-ref', 'symbolic-ref',
]);

const DEFAULT_LIMITS = Object.freeze({
  maxOperations: 24,
  maxFactItems: 48,
  maxFactBytes: 16 * 1024,
  maxCapsuleBytes: 24 * 1024,
  maxDiagnosticChars: 800,
});

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
  return createHash('sha256').update(input).digest('hex');
}

function asToken(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function normalizeProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('project is required');
  const projectId = asToken(project.projectId, 'projectId');
  const githubRepo = typeof project.githubRepo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project.githubRepo)
    ? project.githubRepo
    : null;
  if (!githubRepo) throw new Error('githubRepo is invalid');
  if (typeof project.localRepoPath !== 'string' || project.localRepoPath.trim() === '') throw new Error('localRepoPath is required');
  return Object.freeze({ projectId, githubRepo, localRepoPath: resolve(project.localRepoPath) });
}

function safeRelative(value, name = 'path') {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (isAbsolute(value) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../') || normalized.includes('\0')) {
    throw new Error(`${name} must be repository-relative`);
  }
  return normalized;
}

function readOnlyGit(repositoryRoot, args, { allowNonZero = false, maxBuffer = 1024 * 1024 } = {}) {
  if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== 'string')) throw new Error('invalid git argv');
  const first = args[0];
  if (FORBIDDEN_COMMAND_TOKENS.has(first)) throw new Error(`forbidden git operation: ${first}`);
  try {
    return Object.freeze({
      ok: true,
      exitCode: 0,
      stdout: execFileSync('git', ['-C', repositoryRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer,
      }),
      stderr: '',
    });
  } catch (error) {
    if (!allowNonZero) throw error;
    return Object.freeze({
      ok: false,
      exitCode: Number.isInteger(error?.status) ? error.status : 1,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
    });
  }
}

function assertExactRepositoryRoot(root) {
  const top = readOnlyGit(root, ['rev-parse', '--show-toplevel']).stdout.trim();
  if (resolve(top) !== root) throw new Error('localRepoPath must be the exact git worktree root');
}

function normalizeLines(value, maxItems) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function boundedDiagnostic(value, limit) {
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, limit);
}

function ensureDir(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe deterministic cache directory: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

export function defaultDeterministicEvidenceRoot(env = process.env) {
  const cacheHome = env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache');
  return resolve(cacheHome, 'agent-runner', 'deterministic-evidence');
}

function evidenceIdentity({ project, sourceIdentity, capability, revision, inputs }) {
  const identity = {
    schemaVersion: DETERMINISTIC_PREFLIGHT_SCHEMA_VERSION,
    engineRevision: DETERMINISTIC_PREFLIGHT_ENGINE_REVISION,
    projectId: project.projectId,
    githubRepo: project.githubRepo.toLowerCase(),
    sourceFingerprint: sourceIdentity.sourceFingerprint,
    headSha: sourceIdentity.headSha,
    treeSha: sourceIdentity.treeSha,
    dirtyFingerprint: sourceIdentity.dirtyFingerprint,
    capability,
    capabilityRevision: revision,
    inputFingerprint: `sha256:${digest(inputs || {})}`,
  };
  return Object.freeze({ ...identity, evidenceKey: `sha256:${digest(identity)}` });
}

function evidencePath(root, identity) {
  const namespace = `${identity.projectId}-${digest(identity.githubRepo).slice(0, 12)}`;
  return join(root, namespace, `${identity.evidenceKey.replace('sha256:', '')}.json`);
}

function loadEvidence(path, expected) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe evidence cache entry');
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.identity?.evidenceKey !== expected.evidenceKey) return null;
    if (`sha256:${digest(parsed?.payload)}` !== parsed?.payloadDigest) return null;
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (String(error?.message || '').includes('unsafe evidence cache')) throw error;
    return null;
  }
}

function saveEvidence(root, identity, payload) {
  ensureDir(root);
  const namespace = join(root, `${identity.projectId}-${digest(identity.githubRepo).slice(0, 12)}`);
  ensureDir(namespace);
  const path = evidencePath(root, identity);
  const record = {
    schemaVersion: DETERMINISTIC_PREFLIGHT_SCHEMA_VERSION,
    identity,
    payload,
    payloadDigest: `sha256:${digest(payload)}`,
  };
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return path;
}

function normalizeCapabilityDeclaration(raw) {
  if (typeof raw === 'string') return { capability: raw };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('capability declaration must be a token or object');
  return raw;
}

function normalizeRequestedCapability(raw) {
  const declaration = normalizeCapabilityDeclaration(raw);
  const capability = asToken(declaration.capability, 'capability');
  return Object.freeze({
    capability,
    required: declaration.required === true,
    inputs: declaration.inputs && typeof declaration.inputs === 'object' && !Array.isArray(declaration.inputs)
      ? stable(declaration.inputs)
      : {},
  });
}

function positiveAllowlist(authority, configuration) {
  const fromAuthority = Array.isArray(authority?.deterministicCapabilities)
    ? authority.deterministicCapabilities.filter((value) => typeof value === 'string')
    : [];
  const fromConfig = Array.isArray(configuration?.deterministicCapabilities)
    ? configuration.deterministicCapabilities.filter((value) => typeof value === 'string')
    : [];
  return new Set(fromAuthority.filter((value) => fromConfig.includes(value)));
}

export function planDeterministicPreflight({
  project,
  authority = {},
  configuration = {},
  requestedCapabilities = [],
  limits = {},
} = {}) {
  const normalizedProject = normalizeProject(project);
  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
  if (!Array.isArray(requestedCapabilities)) throw new Error('requestedCapabilities must be an array');
  if (requestedCapabilities.length > effectiveLimits.maxOperations) throw new Error('too many deterministic operations requested');
  const allowed = positiveAllowlist(authority, configuration);
  const operations = requestedCapabilities.map((raw) => {
    const requested = normalizeRequestedCapability(raw);
    const metadata = BUILTIN_DETERMINISTIC_CAPABILITIES[requested.capability] || configuration?.reviewedCapabilities?.[requested.capability] || null;
    if (!metadata) {
      return Object.freeze({ ...requested, state: 'unavailable', reason: 'unknown-capability' });
    }
    const capabilityClass = metadata.class;
    if (!Object.values(DETERMINISTIC_CAPABILITY_CLASSES).includes(capabilityClass)) {
      return Object.freeze({ ...requested, state: 'unsafe-or-unapproved', reason: 'invalid-capability-class' });
    }
    if (capabilityClass === DETERMINISTIC_CAPABILITY_CLASSES.OPERATOR) {
      return Object.freeze({ ...requested, class: capabilityClass, state: 'operator-only', reason: 'operator-capability' });
    }
    if (!allowed.has(requested.capability)) {
      return Object.freeze({ ...requested, class: capabilityClass, state: 'unsafe-or-unapproved', reason: 'not-positive-allowlisted' });
    }
    if (capabilityClass === DETERMINISTIC_CAPABILITY_CLASSES.MUTATION) {
      const mutationAllowed = authority?.deterministicMutation === true
        && authority?.implementationSlotOwned === true
        && authority?.worktreeWriteOwned === true;
      if (!mutationAllowed) {
        return Object.freeze({ ...requested, class: capabilityClass, state: 'unsafe-or-unapproved', reason: 'mutation-authority-or-ownership-missing' });
      }
    }
    return Object.freeze({
      ...requested,
      class: capabilityClass,
      revision: String(metadata.revision || '1'),
      state: 'eligible',
      reason: null,
    });
  });
  return Object.freeze({
    schemaVersion: DETERMINISTIC_PREFLIGHT_SCHEMA_VERSION,
    project: normalizedProject,
    operations,
    hasRequiredBlocker: operations.some((operation) => operation.required && operation.state !== 'eligible'),
  });
}

function executeBuiltin({ capability, project, sourceIdentity, inputs, limits, mapCacheRoot }) {
  const root = project.localRepoPath;
  if (capability === 'repository-identity') {
    return { status: 'success', facts: { sourceIdentity } };
  }
  if (capability === 'git-status') {
    const result = readOnlyGit(root, ['status', '--porcelain=v1', '--branch', '--untracked-files=normal']);
    const lines = normalizeLines(result.stdout, limits.maxFactItems);
    return {
      status: 'success',
      facts: {
        clean: lines.filter((line) => !line.startsWith('## ')).length === 0,
        statusLines: lines,
        truncated: String(result.stdout || '').split(/\r?\n/).filter(Boolean).length > lines.length,
      },
    };
  }
  if (capability === 'changed-files') {
    const tracked = readOnlyGit(root, ['diff', '--name-only', '--relative', 'HEAD']).stdout;
    const untracked = readOnlyGit(root, ['ls-files', '--others', '--exclude-standard']).stdout;
    const all = [...new Set([...normalizeLines(tracked, limits.maxFactItems * 2), ...normalizeLines(untracked, limits.maxFactItems * 2)])].sort();
    return {
      status: 'success',
      facts: { files: all.slice(0, limits.maxFactItems), truncated: all.length > limits.maxFactItems },
    };
  }
  if (capability === 'diff-check') {
    const result = readOnlyGit(root, ['diff', '--check', 'HEAD'], { allowNonZero: true });
    const diagnostic = boundedDiagnostic(result.stdout || result.stderr, limits.maxDiagnosticChars);
    return {
      status: result.ok ? 'success' : 'failed',
      exitCode: result.exitCode,
      facts: { passed: result.ok, diagnostic: diagnostic || null },
    };
  }
  if (capability === 'repository-map') {
    const loaded = loadOrBuildRepositoryMap({ project, repositoryRoot: root, cacheRoot: mapCacheRoot });
    const paths = Array.isArray(inputs.paths) ? inputs.paths.map((path) => safeRelative(path)).slice(0, 16) : [];
    const terms = Array.isArray(inputs.terms) ? inputs.terms.map((term) => String(term).slice(0, 120)).slice(0, 16) : [];
    const capsule = buildRepositoryNavigationCapsule(loaded.map, { paths, terms }, { maxItems: 12, maxBytes: 8 * 1024 });
    return { status: 'success', facts: { reusedMap: loaded.reused, navigation: capsule } };
  }
  if (capability === 'toolchain-facts') {
    const gitVersion = readOnlyGit(root, ['--version']).stdout.trim().slice(0, 160);
    let nodeVersion = null;
    try {
      nodeVersion = execFileSync(process.execPath, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().slice(0, 80);
    } catch {
      // Node facts are optional within this capability; Git remains authoritative for repository identity.
    }
    return { status: 'success', facts: { gitVersion, nodeVersion } };
  }
  return null;
}

function validateReviewedCommand(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error('reviewed capability definition is invalid');
  if (![DETERMINISTIC_CAPABILITY_CLASSES.DISCOVERY, DETERMINISTIC_CAPABILITY_CLASSES.VALIDATION].includes(definition.class)) {
    throw new Error('reviewed command execution currently supports read-only discovery/validation only');
  }
  if (definition.executable !== 'git' && definition.executable !== 'node') throw new Error('reviewed command executable is not allowed');
  if (!Array.isArray(definition.argv) || definition.argv.length === 0 || definition.argv.some((value) => typeof value !== 'string')) {
    throw new Error('reviewed command argv is invalid');
  }
  if (definition.executable === 'git' && FORBIDDEN_COMMAND_TOKENS.has(definition.argv[0])) {
    throw new Error(`reviewed command contains forbidden git operation: ${definition.argv[0]}`);
  }
}

function executeReviewed({ definition, project, limits }) {
  validateReviewedCommand(definition);
  const executable = definition.executable === 'node' ? process.execPath : 'git';
  const prefix = definition.executable === 'git' ? ['-C', project.localRepoPath] : [];
  try {
    const stdout = execFileSync(executable, [...prefix, ...definition.argv], {
      cwd: project.localRepoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Math.min(Math.max(Number(definition.timeoutMs || 60_000), 1_000), 10 * 60_000),
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
      },
    });
    return {
      status: 'success',
      exitCode: 0,
      facts: { diagnostic: boundedDiagnostic(stdout, limits.maxDiagnosticChars) || null },
    };
  } catch (error) {
    return {
      status: 'failed',
      exitCode: Number.isInteger(error?.status) ? error.status : 1,
      facts: { diagnostic: boundedDiagnostic(error?.stdout || error?.stderr, limits.maxDiagnosticChars) || null },
    };
  }
}

function boundFacts(facts, limits) {
  const value = stable(facts || {});
  let serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) <= limits.maxFactBytes) return value;
  const bounded = { truncated: true, digest: `sha256:${digest(value)}` };
  serialized = JSON.stringify(bounded);
  if (Buffer.byteLength(serialized) > limits.maxFactBytes) throw new Error('deterministic fact bound is too small');
  return bounded;
}

export function executeDeterministicPreflight({
  plan,
  configuration = {},
  evidenceRoot = defaultDeterministicEvidenceRoot(),
  mapCacheRoot,
  limits = {},
  now = () => new Date().toISOString(),
} = {}) {
  if (!plan || plan.schemaVersion !== DETERMINISTIC_PREFLIGHT_SCHEMA_VERSION) throw new Error('valid deterministic plan is required');
  const project = normalizeProject(plan.project);
  assertExactRepositoryRoot(project.localRepoPath);
  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
  const initialSource = captureRepositorySourceIdentity({ repositoryRoot: project.localRepoPath });
  const results = [];

  for (const operation of plan.operations) {
    if (operation.state !== 'eligible') {
      results.push(Object.freeze({
        capability: operation.capability,
        required: operation.required,
        status: operation.state,
        reason: operation.reason,
        reused: false,
      }));
      continue;
    }

    const identity = evidenceIdentity({
      project,
      sourceIdentity: initialSource,
      capability: operation.capability,
      revision: operation.revision,
      inputs: operation.inputs,
    });
    const cached = loadEvidence(evidencePath(resolve(evidenceRoot), identity), identity);
    if (cached) {
      results.push(Object.freeze({
        capability: operation.capability,
        required: operation.required,
        status: cached.payload.status,
        exitCode: cached.payload.exitCode ?? null,
        facts: cached.payload.facts,
        evidenceKey: identity.evidenceKey,
        reused: true,
      }));
      continue;
    }

    let executed;
    try {
      executed = executeBuiltin({
        capability: operation.capability,
        project,
        sourceIdentity: initialSource,
        inputs: operation.inputs,
        limits: effectiveLimits,
        mapCacheRoot,
      });
      if (!executed) {
        const reviewed = configuration?.reviewedCapabilities?.[operation.capability];
        if (!reviewed) throw new Error('capability implementation unavailable');
        executed = executeReviewed({ definition: reviewed, project, limits: effectiveLimits });
      }
    } catch (error) {
      executed = {
        status: 'unavailable',
        exitCode: null,
        facts: { diagnostic: boundedDiagnostic(error?.message || error, effectiveLimits.maxDiagnosticChars) },
      };
    }

    const finalSource = captureRepositorySourceIdentity({ repositoryRoot: project.localRepoPath });
    if (operation.class !== DETERMINISTIC_CAPABILITY_CLASSES.MUTATION && finalSource.sourceFingerprint !== initialSource.sourceFingerprint) {
      throw new Error(`read-only deterministic capability mutated repository state: ${operation.capability}`);
    }

    const payload = {
      status: executed.status,
      exitCode: executed.exitCode ?? null,
      facts: boundFacts(executed.facts, effectiveLimits),
      observedAt: now(),
    };
    saveEvidence(resolve(evidenceRoot), identity, payload);
    results.push(Object.freeze({
      capability: operation.capability,
      required: operation.required,
      status: payload.status,
      exitCode: payload.exitCode,
      facts: payload.facts,
      evidenceKey: identity.evidenceKey,
      reused: false,
    }));
  }

  const blocking = results.filter((result) => result.required && result.status !== 'success');
  return Object.freeze({
    schemaVersion: DETERMINISTIC_PREFLIGHT_SCHEMA_VERSION,
    project: { projectId: project.projectId, githubRepo: project.githubRepo },
    sourceIdentity: initialSource,
    results,
    providerEligible: blocking.length === 0,
    blocking: blocking.map((result) => ({ capability: result.capability, status: result.status, reason: result.reason || null })),
    evidenceReused: results.filter((result) => result.reused).length,
    operationsExecuted: results.filter((result) => result.evidenceKey && !result.reused).length,
  });
}

export function buildDeterministicHandoffCapsule(execution, { limits = {} } = {}) {
  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
  const capsule = {
    schemaVersion: DETERMINISTIC_PREFLIGHT_SCHEMA_VERSION,
    sourceFingerprint: execution?.sourceIdentity?.sourceFingerprint || null,
    headSha: execution?.sourceIdentity?.headSha || null,
    providerEligible: execution?.providerEligible === true,
    evidenceReused: Number(execution?.evidenceReused || 0),
    operationsExecuted: Number(execution?.operationsExecuted || 0),
    results: (execution?.results || []).slice(0, effectiveLimits.maxOperations).map((result) => ({
      capability: result.capability,
      status: result.status,
      reused: result.reused === true,
      evidenceKey: result.evidenceKey || null,
      facts: boundFacts(result.facts, { ...effectiveLimits, maxFactBytes: Math.min(effectiveLimits.maxFactBytes, 4096) }),
    })),
  };
  const bytes = Buffer.byteLength(JSON.stringify(capsule));
  if (bytes > effectiveLimits.maxCapsuleBytes) {
    return Object.freeze({
      schemaVersion: DETERMINISTIC_PREFLIGHT_SCHEMA_VERSION,
      sourceFingerprint: capsule.sourceFingerprint,
      headSha: capsule.headSha,
      providerEligible: capsule.providerEligible,
      evidenceReused: capsule.evidenceReused,
      operationsExecuted: capsule.operationsExecuted,
      truncated: true,
      resultsDigest: `sha256:${digest(capsule.results)}`,
    });
  }
  return Object.freeze(capsule);
}

export function evaluateDeterministicCompletion({ execution, machineVerifiableCompletion = false } = {}) {
  const results = execution?.results || [];
  const allSuccessful = results.length > 0 && results.every((result) => result.status === 'success');
  return Object.freeze({
    providerInvocationRequired: !(machineVerifiableCompletion === true && allSuccessful),
    completedWithoutProvider: machineVerifiableCompletion === true && allSuccessful,
    reason: machineVerifiableCompletion !== true
      ? 'semantic-or-implementation-reasoning-required'
      : allSuccessful ? 'machine-verifiable-completion-proven' : 'deterministic-evidence-incomplete',
  });
}

export function normalizePostProviderValidation({ result, correctionRequiresReasoning = true } = {}) {
  const passed = result?.status === 'success' || result?.passed === true || result?.exitCode === 0;
  return Object.freeze({
    passed,
    providerReentryRequired: !passed && correctionRequiresReasoning === true,
    deterministicCompletion: passed,
    diagnostic: boundedDiagnostic(result?.diagnostic || result?.facts?.diagnostic || '', DEFAULT_LIMITS.maxDiagnosticChars) || null,
  });
}
