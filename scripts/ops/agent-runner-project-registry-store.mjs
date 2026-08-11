import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { acquireRecoverableCronLock } from './agent-runner-cron-lock.mjs';
import {
  DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG,
  loadAgentRunnerConfig,
  validateAgentRunnerConfig,
} from './agent-runner-config.mjs';
import {
  loadProjectRegistry,
  readProjectRegistryEntries,
  resolveProjectRegistrySelection,
  validateProjectRegistryManifest,
} from './agent-runner-project-registry.mjs';

/**
 * Machine-local project registry management contract (issue #177).
 *
 * This module is the *only* writer for the #100 registry (`projects.json`)
 * and the project configs it references. It deliberately owns no schema of
 * its own: the manifest shape stays `agent-runner-project-registry.mjs`'s
 * schema v1, every project config is produced and re-checked through the
 * canonical `validateAgentRunnerConfig`, and every duplicate-ownership /
 * enabled-project / default-project rule is applied by reusing
 * `resolveProjectRegistrySelection()` — first against the *proposed*
 * in-memory state, then again against the state actually on disk.
 *
 * The exported functions are the typed contract a later authenticated
 * control service (#46/#47/#175) must call instead of writing this JSON
 * itself; the operator CLI in `agent-runner-projects-command.mjs` is one
 * thin caller of exactly these functions.
 *
 * Not in scope here (and deliberately absent): scheduler/timer topology,
 * repository cloning, GitHub writes, concurrency, and any destructive
 * purge of checkouts, worktrees, branches, SQLite state or evidence.
 */

export const PROJECT_REGISTRY_VIEW_SCHEMA_VERSION = 'agent-runner-project-registry-view/v1';
export const PROJECT_REGISTRY_AUDIT_SCHEMA_VERSION = 'agent-runner-project-registry-audit/v1';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const TEMP_PREFIX = '.agent-runner-registry-';
const TEMP_SUFFIX = '.tmp';
const DEFAULT_REGISTRY_RELATIVE = '.config/agent-runner/projects.json';
const DEFAULT_AUDIT_RELATIVE = '.local/state/agent-runner/project-registry-audit.jsonl';
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_REASON_LENGTH = 256;
const SCHEDULER_PENDING_REASON = 'scheduler-registry-adoption-pending';

export class ProjectRegistryManagementError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectRegistryManagementError';
    this.code = code;
    this.details = details;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function defaultRunGit(args) {
  // Read-only git inspection only: fixed argument vector, no shell, no
  // network prompt, bounded timeout. Never used for clone/fetch/write.
  return String(
    execFileSync('git', args, {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }),
  ).trim();
}

export function defaultRegistryStoreDeps(overrides = {}) {
  return {
    mkdirFn: mkdirSync,
    chmodFn: chmodSync,
    existsFn: existsSync,
    readFn: readFileSync,
    writeFn: writeFileSync,
    renameFn: renameSync,
    unlinkFn: unlinkSync,
    openFn: openSync,
    closeFn: closeSync,
    fsyncFn: fsyncSync,
    readdirFn: readdirSync,
    appendFn: appendFileSync,
    now: () => new Date().toISOString(),
    randomId: () => randomUUID(),
    tempToken: () => randomBytes(8).toString('hex'),
    acquireLock: acquireRecoverableCronLock,
    runGit: defaultRunGit,
    readEntries: readProjectRegistryEntries,
    loadConfig: loadAgentRunnerConfig,
    loadRegistry: loadProjectRegistry,
    ...overrides,
  };
}

export function resolveProjectRegistryAuditPath(env = process.env) {
  const home = String(env.HOME || homedir());
  const raw = String(env.AGENT_RUNNER_PROJECT_REGISTRY_AUDIT_PATH || '').trim();
  if (!raw) return resolve(home, DEFAULT_AUDIT_RELATIVE);
  return isAbsolute(raw) ? raw : resolve(home, raw);
}

/**
 * Canonical machine-local layout. `projects.json` beside a `projects/`
 * directory for generated configs and an `archived-projects/` directory
 * that non-destructive `remove` moves configs into.
 */
export function resolveManagedRegistryPaths({ env = process.env, registryPath = null } = {}) {
  const home = String(env.HOME || homedir());
  const selected = registryPath || env.AGENT_RUNNER_PROJECT_REGISTRY || resolve(home, DEFAULT_REGISTRY_RELATIVE);
  const absolute = resolve(selected);
  const registryDir = dirname(absolute);
  return Object.freeze({
    registryPath: absolute,
    registryDir,
    projectsDir: join(registryDir, 'projects'),
    archiveDir: join(registryDir, 'archived-projects'),
    lockPath: join(registryDir, '.projects.registry.lock'),
    auditPath: resolveProjectRegistryAuditPath(env),
  });
}

// ---------------------------------------------------------------------------
// Bounded reason codes. Raw validator messages embed absolute machine paths,
// so they are mapped to fixed codes for any output a dashboard may surface.
// ---------------------------------------------------------------------------

export function boundedRegistryReasonCode(message) {
  const text = String(message || '');
  const duplicate = /duplicate (projectId|githubRepo|localRepoPath|stateDbPath|lockPath)/.exec(text);
  if (duplicate) return `duplicate-${duplicate[1]}`;
  if (/at least one project must be enabled/.test(text)) return 'no-enabled-project';
  if (/defaultProjectId '.*' is not an enabled project/.test(text)) return 'default-project-not-enabled';
  if (/defaultProjectId must be a non-empty string/.test(text)) return 'default-project-invalid';
  if (/Invalid agent runner project registry JSON/.test(text)) return 'registry-malformed-json';
  if (/Unable to read agent runner project registry/.test(text)) return 'registry-unreadable';
  if (/schemaVersion must equal 1/.test(text)) return 'registry-schema-unsupported';
  if (/projects must contain at least one entry/.test(text)) return 'registry-has-no-projects';
  if (/Invalid agent runner project registry/.test(text)) return 'registry-invalid';
  return boundedConfigReasonCode(text);
}

export function boundedConfigReasonCode(message) {
  const text = String(message || '');
  if (/Invalid agent runner config JSON/.test(text)) return 'config-malformed-json';
  if (/Unable to read agent runner config/.test(text)) return 'config-unreadable';
  if (/Invalid agent runner config:/.test(text)) return 'config-invalid-fields';
  return 'unknown-error';
}

// ---------------------------------------------------------------------------
// Bounded audit trail. Every key is fixed and every value is a short
// identifier, digest or reason code — project config bodies, environment
// values, tokens, prompts and provider output are structurally
// unrepresentable here because there is no parameter that accepts them.
// ---------------------------------------------------------------------------

export function appendProjectRegistryAuditEntry({
  action,
  projectId = null,
  githubRepo = null,
  actor = null,
  source = 'operator-cli',
  beforeDigest = null,
  afterDigest = null,
  outcome = 'ok',
  reason = null,
  path = resolveProjectRegistryAuditPath(),
  deps = {},
} = {}) {
  const fs = defaultRegistryStoreDeps(deps);
  if (!isNonEmptyString(action)) throw new Error('appendProjectRegistryAuditEntry requires action');

  const dir = dirname(path);
  fs.mkdirFn(dir, { recursive: true, mode: DIR_MODE });
  try { fs.chmodFn(dir, DIR_MODE); } catch { /* pre-existing shared dir */ }
  if (!fs.existsFn(path)) fs.closeFn(fs.openFn(path, 'a', FILE_MODE));
  try { fs.chmodFn(path, FILE_MODE); } catch { /* best effort */ }

  const entry = Object.freeze({
    schemaVersion: PROJECT_REGISTRY_AUDIT_SCHEMA_VERSION,
    id: fs.randomId(),
    at: fs.now(),
    actor: actor ? String(actor).slice(0, 128) : null,
    source: String(source).slice(0, 64),
    action: String(action).slice(0, 64),
    projectId: projectId ? String(projectId).slice(0, 128) : null,
    githubRepo: githubRepo ? String(githubRepo).slice(0, 256) : null,
    beforeDigest: beforeDigest ? String(beforeDigest).slice(0, 80) : null,
    afterDigest: afterDigest ? String(afterDigest).slice(0, 80) : null,
    outcome: String(outcome).slice(0, 32),
    reason: reason ? String(reason).slice(0, MAX_REASON_LENGTH) : null,
  });
  fs.appendFn(path, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE });
  return entry;
}

export function resolveOperatorActor(env = process.env) {
  const candidate = env.AGENT_RUNNER_OPERATOR || env.SUDO_USER || env.USER || env.LOGNAME;
  return isNonEmptyString(candidate) ? String(candidate).slice(0, 128) : 'unknown';
}

// ---------------------------------------------------------------------------
// Atomic file primitives
// ---------------------------------------------------------------------------

function digestOfText(text) {
  return `sha256:${createHash('sha256').update(String(text)).digest('hex')}`;
}

function digestOfFile(path, fs) {
  if (!fs.existsFn(path)) return null;
  try {
    return digestOfText(fs.readFn(path, 'utf8'));
  } catch {
    return null;
  }
}

function atomicWriteText(path, body, fs) {
  const dir = dirname(path);
  fs.mkdirFn(dir, { recursive: true, mode: DIR_MODE });
  const tmpPath = join(dir, `${TEMP_PREFIX}${fs.tempToken()}${TEMP_SUFFIX}`);
  let fd = null;
  try {
    fd = fs.openFn(tmpPath, 'wx', FILE_MODE);
    fs.writeFn(fd, body);
    try { fs.fsyncFn(fd); } catch { /* fsync unsupported on this fs; rename ordering still applies */ }
    fs.closeFn(fd);
    fd = null;
    try { fs.chmodFn(tmpPath, FILE_MODE); } catch { /* best effort */ }
    fs.renameFn(tmpPath, path);
  } catch (error) {
    if (fd !== null) { try { fs.closeFn(fd); } catch { /* ignore */ } }
    try { fs.unlinkFn(tmpPath); } catch { /* destination untouched either way */ }
    throw error;
  }
}

function atomicWriteJson(path, value, fs) {
  atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`, fs);
}

/**
 * Remove leftover staging files from an interrupted mutation. Temporary
 * files are never referenced by the manifest, so a crash between staging
 * and rename leaves the previous valid registry fully intact; this sweep
 * only reclaims the inert remains on the next mutation.
 */
export function sweepStaleRegistryTempFiles(paths, deps = {}) {
  const fs = defaultRegistryStoreDeps(deps);
  const swept = [];
  for (const dir of [paths.registryDir, paths.projectsDir, paths.archiveDir]) {
    let names;
    try { names = fs.readdirFn(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX)) continue;
      try {
        fs.unlinkFn(join(dir, name));
        swept.push(join(dir, name));
      } catch { /* best effort */ }
    }
  }
  return swept;
}

// ---------------------------------------------------------------------------
// Reading and describing registry state
// ---------------------------------------------------------------------------

function manifestEntriesToWritable(manifest) {
  const projects = manifest.projects.map((entry) => ({ configPath: entry.configPath, enabled: entry.enabled }));
  // `validateProjectRegistryManifest` rejects an explicit null
  // defaultProjectId, so an absent default is written as an absent key.
  if (isNonEmptyString(manifest.defaultProjectId)) {
    return { schemaVersion: 1, defaultProjectId: manifest.defaultProjectId, projects };
  }
  return { schemaVersion: 1, projects };
}

/**
 * Current on-disk state for a mutation. Structural manifest validity and
 * per-config validity are required (a mutation never guesses past a broken
 * file), but registry *admission* rules are intentionally not required here:
 * that is what lets `enable` repair a registry that currently has zero
 * enabled projects, while the proposed state must still pass every rule.
 */
function readCurrentRegistryState(paths, fs) {
  if (!fs.existsFn(paths.registryPath)) {
    return {
      exists: false,
      manifest: { schemaVersion: 1, defaultProjectId: null, projects: [] },
      entries: [],
      digest: null,
    };
  }
  let loaded;
  try {
    loaded = fs.readEntries({ registryPath: paths.registryPath });
  } catch (error) {
    throw new ProjectRegistryManagementError(
      boundedRegistryReasonCode(error.message),
      `current project registry is not in a valid state to mutate: ${error.message}`,
    );
  }
  return {
    exists: true,
    manifest: loaded.manifest,
    entries: loaded.entries,
    digest: digestOfFile(paths.registryPath, fs),
  };
}

/**
 * Fault-tolerant read used by list/show/validate: one broken project config
 * must be reportable per project instead of blanking the whole view.
 */
export function readRegistryOverview({ env = process.env, registryPath = null, deps = {} } = {}) {
  const fs = defaultRegistryStoreDeps(deps);
  const paths = resolveManagedRegistryPaths({ env, registryPath });

  if (!fs.existsFn(paths.registryPath)) {
    return { paths, exists: false, manifest: null, entries: [], registryValid: false, registryReason: 'registry-missing', registryError: null };
  }

  let manifest;
  try {
    manifest = validateProjectRegistryManifest(JSON.parse(fs.readFn(paths.registryPath, 'utf8')));
  } catch (error) {
    const message = error instanceof SyntaxError
      ? `Invalid agent runner project registry JSON at ${paths.registryPath}`
      : error.message;
    return {
      paths,
      exists: true,
      manifest: null,
      entries: [],
      registryValid: false,
      registryReason: boundedRegistryReasonCode(message),
      registryError: message,
    };
  }

  const entries = manifest.projects.map((entry) => {
    const configPath = resolve(paths.registryDir, entry.configPath);
    try {
      return { configPath, enabled: entry.enabled, config: fs.loadConfig({ argv: [], env: {}, configPath }), error: null };
    } catch (error) {
      return { configPath, enabled: entry.enabled, config: null, error: error.message };
    }
  });

  let registryValid = true;
  let registryReason = 'ok';
  let registryError = null;
  const broken = entries.find((entry) => entry.error);
  if (broken) {
    registryValid = false;
    registryReason = boundedConfigReasonCode(broken.error);
    registryError = broken.error;
  } else {
    try {
      resolveProjectRegistrySelection({ manifest, entries });
    } catch (error) {
      registryValid = false;
      registryReason = boundedRegistryReasonCode(error.message);
      registryError = error.message;
    }
  }

  return { paths, exists: true, manifest, entries, registryValid, registryReason, registryError };
}

function effectiveDefaultProjectId(overview) {
  if (!overview.manifest) return null;
  if (isNonEmptyString(overview.manifest.defaultProjectId)) return overview.manifest.defaultProjectId;
  const firstEnabled = overview.entries.find((entry) => entry.enabled && entry.config);
  return firstEnabled ? firstEnabled.config.projectId : null;
}

function admissionReasonFor(entry, registryValid) {
  if (entry.error) return boundedConfigReasonCode(entry.error);
  if (!entry.enabled) return 'disabled';
  if (!registryValid) return 'registry-invalid';
  return 'ok';
}

/**
 * Bounded per-project view. The default (non-verbose) shape carries no
 * machine paths, no environment values, no credentials and no config body —
 * it is the shape a later authenticated dashboard may serve. `verbose` adds
 * canonical local paths for a local operator who explicitly asked for them.
 */
export function buildProjectView(entry, { defaultProjectId, registryValid, verbose = false }) {
  const config = entry.config;
  const projectId = config?.projectId ?? null;
  const view = {
    projectId,
    displayName: config?.displayName ?? null,
    githubRepo: config?.githubRepo ?? null,
    enabled: entry.enabled === true,
    isDefault: projectId !== null && projectId === defaultProjectId,
    configValid: entry.error === null || entry.error === undefined,
    configReason: entry.error ? boundedConfigReasonCode(entry.error) : 'ok',
    checkoutReady: false,
    stateInitialized: false,
    registryAdmitted: entry.enabled === true && !entry.error && registryValid,
    admissionReason: admissionReasonFor(entry, registryValid),
    // #178 owns scheduler adoption of the managed registry; until then no
    // scheduler eligibility can be asserted here without inventing it.
    schedulerEligible: null,
    schedulerEligibilityReason: SCHEDULER_PENDING_REASON,
  };

  if (config) {
    const localRepoPath = resolve(config.localRepoPath);
    view.checkoutReady = existsSync(join(localRepoPath, '.git'));
    view.stateInitialized = existsSync(resolve(localRepoPath, config.stateDbPath));
    if (verbose) {
      view.configPath = entry.configPath;
      view.localRepoPath = localRepoPath;
      view.stateDbPath = resolve(localRepoPath, config.stateDbPath);
      view.lockPath = resolve(localRepoPath, config.runner.lockPath);
    }
  } else if (verbose) {
    view.configPath = entry.configPath;
    view.configError = entry.error ?? null;
  }

  return view;
}

export function listProjects({ env = process.env, registryPath = null, verbose = false, deps = {} } = {}) {
  const overview = readRegistryOverview({ env, registryPath, deps });
  const defaultProjectId = effectiveDefaultProjectId(overview);
  return {
    schemaVersion: PROJECT_REGISTRY_VIEW_SCHEMA_VERSION,
    registryExists: overview.exists,
    registryValid: overview.registryValid,
    registryReason: overview.registryReason,
    defaultProjectId,
    projects: overview.entries.map((entry) => buildProjectView(entry, {
      defaultProjectId,
      registryValid: overview.registryValid,
      verbose,
    })),
    ...(verbose ? { registryPath: overview.paths.registryPath, registryError: overview.registryError } : {}),
  };
}

export function showProject({ env = process.env, registryPath = null, projectId, verbose = false, deps = {} } = {}) {
  if (!isNonEmptyString(projectId)) {
    throw new ProjectRegistryManagementError('missing-required-fields', 'projectId is required', { missing: ['projectId'] });
  }
  const overview = readRegistryOverview({ env, registryPath, deps });
  const defaultProjectId = effectiveDefaultProjectId(overview);
  const entry = overview.entries.find((candidate) => candidate.config?.projectId === projectId);
  if (!entry) {
    throw new ProjectRegistryManagementError('project-not-found', `project '${projectId}' is not registered`, { projectId });
  }
  return {
    schemaVersion: PROJECT_REGISTRY_VIEW_SCHEMA_VERSION,
    registryValid: overview.registryValid,
    registryReason: overview.registryReason,
    defaultProjectId,
    project: buildProjectView(entry, { defaultProjectId, registryValid: overview.registryValid, verbose }),
  };
}

export function validateRegistry({ env = process.env, registryPath = null, verbose = false, deps = {} } = {}) {
  const fs = defaultRegistryStoreDeps(deps);
  const overview = readRegistryOverview({ env, registryPath, deps });
  let ok = overview.registryValid;
  let reason = overview.registryReason;
  let error = overview.registryError;

  // Second, independent pass through the canonical loader: the view above is
  // deliberately fault tolerant, this one is the exact admission path the
  // runtime uses.
  if (ok) {
    try {
      fs.loadRegistry({ registryPath: overview.paths.registryPath });
    } catch (loaderError) {
      ok = false;
      reason = boundedRegistryReasonCode(loaderError.message);
      error = loaderError.message;
    }
  }

  return {
    schemaVersion: PROJECT_REGISTRY_VIEW_SCHEMA_VERSION,
    ok,
    reason,
    registryExists: overview.exists,
    projectCount: overview.entries.length,
    enabledCount: overview.entries.filter((entry) => entry.enabled && entry.config).length,
    defaultProjectId: effectiveDefaultProjectId(overview),
    ...(verbose ? { registryPath: overview.paths.registryPath, error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Mutation core: lock -> load -> propose -> pre-validate -> stage -> replace
// -> re-validate -> (rollback on any failure) -> audit -> release
// ---------------------------------------------------------------------------

function snapshotTargets(plan, paths, fs) {
  const targets = new Set([paths.registryPath]);
  for (const write of plan.configWrites) targets.add(write.path);
  for (const move of plan.archiveMoves) { targets.add(move.from); targets.add(move.to); }
  return [...targets].map((path) => {
    const existed = fs.existsFn(path);
    return { path, existed, contents: existed ? fs.readFn(path, 'utf8') : null };
  });
}

function applyPlan(plan, paths, fs) {
  // Project configs land before the manifest so the manifest — the admission
  // record schedulers and pollers read — is never visible pointing at a file
  // that does not exist yet.
  for (const write of plan.configWrites) atomicWriteJson(write.path, write.value, fs);
  atomicWriteJson(paths.registryPath, plan.manifest, fs);
  // Archive moves run after the manifest no longer references the config, so
  // no reader can observe a registry entry whose config has been moved away.
  for (const move of plan.archiveMoves) {
    fs.mkdirFn(dirname(move.to), { recursive: true, mode: DIR_MODE });
    fs.renameFn(move.from, move.to);
  }
}

function restoreSnapshot(journal, fs) {
  const failures = [];
  for (const entry of [...journal].reverse()) {
    try {
      if (entry.existed) {
        // A file the failed step never reached still holds its prior bytes;
        // rewriting it would be pure risk, so restoration touches only what
        // actually changed.
        if (!fs.existsFn(entry.path) || fs.readFn(entry.path, 'utf8') !== entry.contents) {
          atomicWriteText(entry.path, entry.contents, fs);
        }
      } else if (fs.existsFn(entry.path)) fs.unlinkFn(entry.path);
    } catch (error) {
      failures.push(`${entry.path}: ${error.message}`);
    }
  }
  return failures;
}

/**
 * Staging/replacement failures map to a distinct code so an interrupted
 * write is never reported as a registry validation verdict, while a failed
 * post-write revalidation keeps its precise canonical reason.
 */
function resolveApplyFailureReason(error) {
  if (error instanceof ProjectRegistryManagementError) return error.code;
  const mapped = boundedRegistryReasonCode(error?.message);
  return mapped === 'unknown-error' ? 'mutation-apply-failed' : mapped;
}

function proposedSelectionCheck({ manifest, entries }) {
  try {
    resolveProjectRegistrySelection({ manifest, entries });
  } catch (error) {
    throw new ProjectRegistryManagementError(
      boundedRegistryReasonCode(error.message),
      `proposed project registry state is invalid: ${error.message}`,
    );
  }
}

function withRegistryMutation({ paths, action, actor, source, subjectProjectId = null, deps }, buildPlan) {
  const fs = defaultRegistryStoreDeps(deps);
  fs.mkdirFn(paths.registryDir, { recursive: true, mode: DIR_MODE });

  let release;
  try {
    release = fs.acquireLock(paths.lockPath, deps.lockDeps || {});
  } catch (error) {
    throw new ProjectRegistryManagementError(
      'registry-locked',
      `project registry mutation lock is unavailable: ${error.message}`,
    );
  }

  const auditPath = paths.auditPath;
  let projectId = subjectProjectId ?? null;
  let githubRepo = null;
  let beforeDigest = null;

  try {
    sweepStaleRegistryTempFiles(paths, deps);
    const current = readCurrentRegistryState(paths, fs);
    beforeDigest = current.digest;

    const plan = buildPlan(current, fs);
    projectId = plan.projectId ?? null;
    githubRepo = plan.githubRepo ?? null;

    if (plan.noChange) {
      return {
        ok: true,
        changed: false,
        action,
        projectId,
        githubRepo,
        beforeDigest,
        afterDigest: beforeDigest,
        details: plan.details ?? {},
      };
    }

    proposedSelectionCheck({ manifest: plan.proposedManifest, entries: plan.proposedEntries });

    const journal = snapshotTargets(plan, paths, fs);
    try {
      applyPlan(plan, paths, fs);
      // Full canonical re-load of the resulting registry, exactly as the
      // runtime would load it. Anything short of a clean load is a failure.
      fs.loadRegistry({ registryPath: paths.registryPath });
    } catch (error) {
      const failures = restoreSnapshot(journal, fs);
      const reason = resolveApplyFailureReason(error);
      appendProjectRegistryAuditEntry({
        action, projectId, githubRepo, actor, source, beforeDigest,
        afterDigest: digestOfFile(paths.registryPath, fs),
        outcome: failures.length === 0 ? 'rolled-back' : 'rollback-failed',
        reason,
        path: auditPath,
        deps,
      });
      if (failures.length > 0) {
        throw new ProjectRegistryManagementError(
          'rollback-failed',
          `project registry mutation failed and the prior state could not be fully restored: ${failures.join('; ')}`,
          { rolledBack: false },
        );
      }
      throw new ProjectRegistryManagementError(
        reason,
        `project registry mutation failed and was rolled back: ${error.message}`,
        { rolledBack: true },
      );
    }

    const afterDigest = digestOfFile(paths.registryPath, fs);
    appendProjectRegistryAuditEntry({
      action, projectId, githubRepo, actor, source, beforeDigest, afterDigest,
      outcome: 'ok', reason: null, path: auditPath, deps,
    });

    return { ok: true, changed: true, action, projectId, githubRepo, beforeDigest, afterDigest, details: plan.details ?? {} };
  } catch (error) {
    if (error instanceof ProjectRegistryManagementError && error.code !== 'rollback-failed' && !error.details?.rolledBack) {
      // Refusals that never reached the staging phase: nothing was written,
      // so the audit records the refusal without a state change.
      appendProjectRegistryAuditEntry({
        action, projectId, githubRepo, actor, source, beforeDigest,
        afterDigest: beforeDigest, outcome: 'refused', reason: error.code,
        path: auditPath, deps,
      });
    }
    throw error;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Project config generation
// ---------------------------------------------------------------------------

/**
 * Build a complete project config from explicit operator-supplied identity
 * plus runner-generic defaults. Nothing repository-specific is inferred: the
 * label/priority defaults are the runner's own generic ones, the validation
 * command list starts empty rather than guessing a command to execute, and
 * state/lock paths follow the canonical per-project XDG state root so two
 * projects can never share state or an execution lock.
 *
 * The systemd names are configuration text only. This function creates,
 * installs, enables or alters no unit or timer; scheduler adoption is #178.
 */
export function buildManagedProjectConfig({
  projectId,
  displayName = null,
  githubRepo,
  localRepoPath,
  env = process.env,
}) {
  const home = String(env.HOME || homedir());
  const stateRoot = resolve(home, '.local', 'state', 'agent-runner', projectId);
  return {
    projectId,
    displayName: isNonEmptyString(displayName) ? displayName : projectId,
    githubRepo,
    localRepoPath: resolve(localRepoPath),
    outputDir: stateRoot,
    stateDbPath: join(stateRoot, 'runner-state.sqlite'),
    acceptedAgentLabels: [...DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG.acceptedAgentLabels],
    statusLabels: { ...DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG.statusLabels },
    priorityLabelRanking: [...DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG.priorityLabelRanking],
    safeDefaultValidationCommands: [],
    systemd: {
      serviceName: `agent-runner-${projectId}.service`,
      timerName: `agent-runner-${projectId}.timer`,
    },
    runner: {
      lockPath: join(stateRoot, 'cron.lock'),
      candidateLimit: DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG.runner.candidateLimit,
    },
  };
}

export function parseGitRemoteRepository(remoteUrl) {
  const text = String(remoteUrl || '').trim();
  if (!text) return null;
  const match = /(?:[:/])([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/.exec(text);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

/**
 * Read-only local checkout inspection. Never clones, fetches, writes to the
 * checkout or contacts GitHub.
 */
export function inspectLocalCheckout({ localRepoPath, githubRepo, allowMissingCheckout = false, deps = {} }) {
  const fs = defaultRegistryStoreDeps(deps);
  const absolute = resolve(localRepoPath);
  const present = fs.existsFn(absolute) && fs.existsFn(join(absolute, '.git'));

  if (!present) {
    if (!allowMissingCheckout) {
      throw new ProjectRegistryManagementError(
        'checkout-not-ready',
        `local checkout for ${githubRepo} is not a present git checkout; pass allowMissingCheckout to register it anyway (no repository is ever cloned)`,
        { localRepoPath: absolute },
      );
    }
    return { present: false, checkoutReady: false, repositoryVerified: false, remoteRepository: null };
  }

  let insideWorkTree;
  try {
    insideWorkTree = fs.runGit(['-C', absolute, 'rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    throw new ProjectRegistryManagementError(
      'checkout-not-a-git-worktree',
      `local checkout could not be verified read-only as a git work tree: ${error.message}`,
      { localRepoPath: absolute },
    );
  }
  if (insideWorkTree !== 'true') {
    throw new ProjectRegistryManagementError(
      'checkout-not-a-git-worktree',
      'local checkout is not inside a git work tree',
      { localRepoPath: absolute },
    );
  }

  let remoteRepository = null;
  try {
    remoteRepository = parseGitRemoteRepository(fs.runGit(['-C', absolute, 'config', '--get', 'remote.origin.url']));
  } catch {
    remoteRepository = null; // no origin configured is not an error
  }

  if (remoteRepository && remoteRepository.toLowerCase() !== String(githubRepo).toLowerCase()) {
    throw new ProjectRegistryManagementError(
      'checkout-repository-mismatch',
      `local checkout origin '${remoteRepository}' does not match requested repository '${githubRepo}'`,
      { requested: githubRepo, observed: remoteRepository },
    );
  }

  return { present: true, checkoutReady: true, repositoryVerified: Boolean(remoteRepository), remoteRepository };
}

function requireAddInputs({ projectId, githubRepo, localRepoPath }) {
  const missing = [];
  if (!isNonEmptyString(projectId)) missing.push('projectId');
  if (!isNonEmptyString(githubRepo)) missing.push('githubRepo');
  if (!isNonEmptyString(localRepoPath)) missing.push('localRepoPath');
  if (missing.length > 0) {
    throw new ProjectRegistryManagementError(
      'missing-required-fields',
      `cannot add a project without: ${missing.join(', ')}`,
      { missing },
    );
  }
  const invalid = [];
  if (!PROJECT_ID_PATTERN.test(projectId)) invalid.push('projectId');
  if (!GITHUB_REPO_PATTERN.test(githubRepo)) invalid.push('githubRepo');
  if (!isAbsolute(localRepoPath)) invalid.push('localRepoPath');
  if (invalid.length > 0) {
    throw new ProjectRegistryManagementError(
      'invalid-field-format',
      `invalid project field format: ${invalid.join(', ')}`,
      { invalid },
    );
  }
}

function relativeOrAbsoluteConfigPath(configPath, registryDir) {
  const rel = relative(registryDir, configPath);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split('\\').join('/');
  return configPath;
}

// ---------------------------------------------------------------------------
// Public mutation contract
// ---------------------------------------------------------------------------

export function addProject({
  env = process.env,
  registryPath = null,
  projectId,
  githubRepo,
  localRepoPath,
  displayName = null,
  enable = false,
  allowMissingCheckout = false,
  configPath = null,
  actor = null,
  source = 'operator-cli',
  deps = {},
} = {}) {
  requireAddInputs({ projectId, githubRepo, localRepoPath });
  const paths = resolveManagedRegistryPaths({ env, registryPath });
  const fs = defaultRegistryStoreDeps(deps);
  const resolvedActor = actor ?? resolveOperatorActor(env);

  const checkout = inspectLocalCheckout({ localRepoPath, githubRepo, allowMissingCheckout, deps });

  const proposedConfigRaw = buildManagedProjectConfig({ projectId, displayName, githubRepo, localRepoPath, env });
  let proposedConfig;
  try {
    proposedConfig = validateAgentRunnerConfig(proposedConfigRaw);
  } catch (error) {
    throw new ProjectRegistryManagementError(
      'generated-config-invalid',
      `generated project config is incomplete: ${error.message}`,
    );
  }

  const targetConfigPath = configPath ? resolve(configPath) : join(paths.projectsDir, `${projectId}.json`);

  return withRegistryMutation({ paths, action: 'add', actor: resolvedActor, source, subjectProjectId: projectId, deps }, (current) => {
    if (current.entries.some((entry) => entry.config.projectId === projectId)) {
      throw new ProjectRegistryManagementError('project-exists', `project '${projectId}' is already registered`, { projectId });
    }
    if (fs.existsFn(targetConfigPath)) {
      throw new ProjectRegistryManagementError(
        'config-path-exists',
        `refusing to overwrite an existing project config file for '${projectId}'`,
        { projectId },
      );
    }

    const entryConfigPath = relativeOrAbsoluteConfigPath(targetConfigPath, paths.registryDir);
    const proposedManifest = {
      schemaVersion: 1,
      defaultProjectId: isNonEmptyString(current.manifest.defaultProjectId)
        ? current.manifest.defaultProjectId
        : (enable ? projectId : null),
      projects: [
        ...current.manifest.projects.map((entry) => ({ configPath: entry.configPath, enabled: entry.enabled })),
        { configPath: entryConfigPath, enabled: enable === true },
      ],
    };

    return {
      projectId,
      githubRepo,
      proposedManifest,
      proposedEntries: [
        ...current.entries,
        { configPath: targetConfigPath, enabled: enable === true, config: proposedConfig },
      ],
      manifest: manifestEntriesToWritable(proposedManifest),
      configWrites: [{ path: targetConfigPath, value: proposedConfigRaw }],
      archiveMoves: [],
      details: {
        enabled: enable === true,
        checkoutReady: checkout.checkoutReady,
        repositoryVerified: checkout.repositoryVerified,
      },
    };
  });
}

function findEntryByProjectId(current, projectId) {
  const index = current.entries.findIndex((entry) => entry.config.projectId === projectId);
  if (index === -1) {
    throw new ProjectRegistryManagementError('project-not-found', `project '${projectId}' is not registered`, { projectId });
  }
  return index;
}

export function setProjectEnabled({
  env = process.env,
  registryPath = null,
  projectId,
  enabled,
  actor = null,
  source = 'operator-cli',
  deps = {},
} = {}) {
  if (!isNonEmptyString(projectId)) {
    throw new ProjectRegistryManagementError('missing-required-fields', 'projectId is required', { missing: ['projectId'] });
  }
  if (typeof enabled !== 'boolean') {
    throw new ProjectRegistryManagementError('missing-required-fields', 'enabled must be a boolean', { missing: ['enabled'] });
  }
  const paths = resolveManagedRegistryPaths({ env, registryPath });
  const resolvedActor = actor ?? resolveOperatorActor(env);
  const action = enabled ? 'enable' : 'disable';

  return withRegistryMutation({ paths, action, actor: resolvedActor, source, subjectProjectId: projectId, deps }, (current) => {
    const index = findEntryByProjectId(current, projectId);
    const entry = current.entries[index];
    if (entry.enabled === enabled) {
      return { projectId, githubRepo: entry.config.githubRepo, noChange: true, details: { enabled } };
    }

    const proposedManifest = {
      schemaVersion: 1,
      defaultProjectId: current.manifest.defaultProjectId,
      projects: current.manifest.projects.map((manifestEntry, position) => ({
        configPath: manifestEntry.configPath,
        enabled: position === index ? enabled : manifestEntry.enabled,
      })),
    };
    const proposedEntries = current.entries.map((candidate, position) => (
      position === index ? { ...candidate, enabled } : candidate
    ));

    return {
      projectId,
      githubRepo: entry.config.githubRepo,
      proposedManifest,
      proposedEntries,
      manifest: manifestEntriesToWritable(proposedManifest),
      // Disabling changes admission only: the project config, SQLite state,
      // worktrees, branches, claims and evidence are all left untouched.
      configWrites: [],
      archiveMoves: [],
      details: { enabled },
    };
  });
}

export function setDefaultProject({
  env = process.env,
  registryPath = null,
  projectId,
  actor = null,
  source = 'operator-cli',
  deps = {},
} = {}) {
  if (!isNonEmptyString(projectId)) {
    throw new ProjectRegistryManagementError('missing-required-fields', 'projectId is required', { missing: ['projectId'] });
  }
  const paths = resolveManagedRegistryPaths({ env, registryPath });
  const resolvedActor = actor ?? resolveOperatorActor(env);

  return withRegistryMutation({ paths, action: 'set-default', actor: resolvedActor, source, subjectProjectId: projectId, deps }, (current) => {
    const index = findEntryByProjectId(current, projectId);
    const entry = current.entries[index];
    if (current.manifest.defaultProjectId === projectId) {
      return { projectId, githubRepo: entry.config.githubRepo, noChange: true, details: { defaultProjectId: projectId } };
    }
    const proposedManifest = {
      schemaVersion: 1,
      defaultProjectId: projectId,
      projects: current.manifest.projects.map((manifestEntry) => ({
        configPath: manifestEntry.configPath,
        enabled: manifestEntry.enabled,
      })),
    };
    return {
      projectId,
      githubRepo: entry.config.githubRepo,
      proposedManifest,
      proposedEntries: current.entries,
      manifest: manifestEntriesToWritable(proposedManifest),
      configWrites: [],
      archiveMoves: [],
      details: { defaultProjectId: projectId },
    };
  });
}

function nextArchivePath(paths, projectId, fs) {
  const base = join(paths.archiveDir, `${projectId}.json`);
  if (!fs.existsFn(base)) return base;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = join(paths.archiveDir, `${projectId}.${index}.json`);
    if (!fs.existsFn(candidate)) return candidate;
  }
  throw new ProjectRegistryManagementError(
    'archive-slot-unavailable',
    `no free archive slot for '${projectId}'`,
    { projectId },
  );
}

/**
 * Non-destructive removal: the project loses registry admission and its
 * config is archived beside the registry (when it lives there). Nothing
 * outside the registry directory is touched — no repository checkout,
 * worktree, branch, SQLite state, credential, GitHub object or evidence is
 * deleted by this operation, and there is no purge path in this contract.
 */
export function removeProject({
  env = process.env,
  registryPath = null,
  projectId,
  actor = null,
  source = 'operator-cli',
  deps = {},
} = {}) {
  if (!isNonEmptyString(projectId)) {
    throw new ProjectRegistryManagementError('missing-required-fields', 'projectId is required', { missing: ['projectId'] });
  }
  const paths = resolveManagedRegistryPaths({ env, registryPath });
  const fs = defaultRegistryStoreDeps(deps);
  const resolvedActor = actor ?? resolveOperatorActor(env);

  return withRegistryMutation({ paths, action: 'remove', actor: resolvedActor, source, subjectProjectId: projectId, deps }, (current) => {
    const index = findEntryByProjectId(current, projectId);
    const entry = current.entries[index];

    if (current.entries.length === 1) {
      throw new ProjectRegistryManagementError(
        'registry-would-be-empty',
        'refusing to remove the only registered project; the registry must keep at least one project',
        { projectId },
      );
    }
    if (current.manifest.defaultProjectId === projectId) {
      throw new ProjectRegistryManagementError(
        'default-project-required',
        `refusing to remove '${projectId}' while it is the default project; select another default first`,
        { projectId },
      );
    }

    const proposedManifest = {
      schemaVersion: 1,
      defaultProjectId: current.manifest.defaultProjectId,
      projects: current.manifest.projects
        .filter((_, position) => position !== index)
        .map((manifestEntry) => ({ configPath: manifestEntry.configPath, enabled: manifestEntry.enabled })),
    };
    const proposedEntries = current.entries.filter((_, position) => position !== index);

    const configInsideRegistryDir = !relative(paths.registryDir, entry.configPath).startsWith('..');
    const archiveMoves = [];
    let archivedConfigPath = null;
    if (configInsideRegistryDir && fs.existsFn(entry.configPath)) {
      archivedConfigPath = nextArchivePath(paths, projectId, fs);
      archiveMoves.push({ from: entry.configPath, to: archivedConfigPath });
    }

    return {
      projectId,
      githubRepo: entry.config.githubRepo,
      proposedManifest,
      proposedEntries,
      manifest: manifestEntriesToWritable(proposedManifest),
      configWrites: [],
      archiveMoves,
      details: {
        archivedConfig: archivedConfigPath !== null,
        configRetainedInPlace: archivedConfigPath === null,
        checkoutPreserved: true,
        statePreserved: true,
      },
    };
  });
}
