import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { localExecutorProjectPolicy } from './agent-runner-local-executor-policy.mjs';
import { projectFromRegistryById } from './agent-runner-project-registry.mjs';

export const LOCAL_EXECUTOR_SCHEMA_VERSION = 1;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/;
const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const PROFILE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const BASE_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_STATE_HOME', 'LANG', 'LC_ALL', 'TZ', 'CI', 'NO_COLOR',
]);
const FINAL_JOB_STATES = new Set(['succeeded', 'failed']);

export class LocalExecutorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalExecutorError';
    this.code = code;
  }
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new LocalExecutorError('invalid-request', 'job timestamp is invalid');
  return date.toISOString();
}

function sha(value) {
  return typeof value === 'string' && SHA_PATTERN.test(value) ? value.toLowerCase() : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function jobDigest(job) {
  return createHash('sha256').update(canonicalJson(job)).digest('hex');
}

function boundedResult(result) {
  const encoded = JSON.stringify(result ?? {});
  if (Buffer.byteLength(encoded) > 256 * 1024) {
    throw new LocalExecutorError('result-too-large', 'local executor result exceeds the bounded limit');
  }
  return encoded;
}

function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function worktreePath(policy, worktreeName) {
  if (!WORKTREE_NAME_PATTERN.test(worktreeName || '')) {
    throw new LocalExecutorError('invalid-request', 'worktreeName is invalid');
  }
  const target = resolve(policy.worktreeRoot, worktreeName);
  if (!inside(policy.worktreeRoot, target) || target === policy.worktreeRoot) {
    throw new LocalExecutorError('path-not-allowed', 'worktree path is outside the configured root');
  }
  return target;
}

function canonicalGithubRepository(remote) {
  const value = String(remote || '').trim();
  let match = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(value);
  if (match) return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;
    const segments = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
    return segments.length === 2 && segments.every(Boolean) ? `${segments[0]}/${segments[1]}` : null;
  } catch {
    return null;
  }
}

function childEnvironment(env, additional = []) {
  const result = {};
  for (const name of [...BASE_ENV_ALLOWLIST, ...additional]) {
    if (env[name] != null) result[name] = String(env[name]);
  }
  result.NO_COLOR = '1';
  result.GIT_TERMINAL_PROMPT = '0';
  return result;
}

function outputSummary(value) {
  const buffer = Buffer.from(value || '', 'utf8');
  return Object.freeze({
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  });
}

function runCommand(spawn, argv, {
  cwd,
  env,
  timeoutMs,
  maxOutputBytes,
  allowFailure = false,
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string')) {
    throw new LocalExecutorError('invalid-command', 'executor command argv is invalid');
  }
  const result = spawn(argv[0], argv.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    shell: false,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    throw new LocalExecutorError('command-timeout', 'executor command timed out');
  }
  const summary = Object.freeze({
    argv: Object.freeze([...argv]),
    status: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    stdout: outputSummary(result.stdout),
    stderr: outputSummary(result.stderr),
  });
  if (!allowFailure && result.status !== 0) {
    const error = new LocalExecutorError('command-failed', 'executor command failed');
    error.command = summary;
    throw error;
  }
  return summary;
}

function runGit(spawn, repoPath, args, options) {
  return runCommand(spawn, ['git', '-C', repoPath, ...args], options);
}

function runGitText(spawn, repoPath, args, options) {
  const result = spawn('git', ['-C', repoPath, ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes,
    shell: false,
  });
  if (result.error?.code === 'ETIMEDOUT') throw new LocalExecutorError('command-timeout', 'git command timed out');
  if (result.status !== 0) throw new LocalExecutorError('command-failed', 'git command failed');
  return String(result.stdout || '').trim();
}

function repositoryState(spawn, project, policy, env) {
  const options = {
    cwd: project.localRepoPath,
    env: childEnvironment(env),
    timeoutMs: 30_000,
    maxOutputBytes: policy.maxOutputBytes,
  };
  const topLevel = resolve(runGitText(spawn, project.localRepoPath, ['rev-parse', '--show-toplevel'], options));
  if (topLevel !== resolve(project.localRepoPath)) {
    throw new LocalExecutorError('repository-identity-mismatch', 'configured repository path is not the git top level');
  }
  const remote = canonicalGithubRepository(runGitText(spawn, project.localRepoPath, ['remote', 'get-url', 'origin'], options));
  if (!remote || remote.toLowerCase() !== project.githubRepo.toLowerCase()) {
    throw new LocalExecutorError('repository-identity-mismatch', 'origin does not match the configured GitHub repository');
  }
  const headSha = runGitText(spawn, project.localRepoPath, ['rev-parse', 'HEAD'], options).toLowerCase();
  const branch = runGitText(spawn, project.localRepoPath, ['branch', '--show-current'], options) || null;
  const porcelain = runGitText(spawn, project.localRepoPath, ['status', '--porcelain=v1', '--untracked-files=all'], options);
  const changedEntries = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
  return Object.freeze({
    projectId: project.projectId,
    repository: project.githubRepo,
    path: resolve(project.localRepoPath),
    headSha,
    branch,
    clean: changedEntries === 0,
    changedEntries,
  });
}

function targetState(spawn, target, policy, env) {
  const options = {
    cwd: target,
    env: childEnvironment(env),
    timeoutMs: 30_000,
    maxOutputBytes: policy.maxOutputBytes,
  };
  const topLevel = resolve(runGitText(spawn, target, ['rev-parse', '--show-toplevel'], options));
  if (topLevel !== resolve(target)) throw new LocalExecutorError('worktree-identity-mismatch', 'target is not a worktree root');
  const headSha = runGitText(spawn, target, ['rev-parse', 'HEAD'], options).toLowerCase();
  const porcelain = runGitText(spawn, target, ['status', '--porcelain=v1', '--untracked-files=all'], options);
  const changedEntries = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
  return Object.freeze({ path: resolve(target), headSha, clean: changedEntries === 0, changedEntries });
}

export function validateLocalExecutorJob(input, {
  now = new Date().toISOString(),
  maxFutureMs = 24 * 60 * 60_000,
} = {}) {
  if (!isPlainObject(input)) throw new LocalExecutorError('invalid-request', 'executor job must be an object');
  if (input.schemaVersion !== 1) throw new LocalExecutorError('invalid-request', 'executor job schemaVersion must equal 1');
  if (!JOB_ID_PATTERN.test(input.jobId || '')) throw new LocalExecutorError('invalid-request', 'executor jobId is invalid');
  if (!NONCE_PATTERN.test(input.nonce || '')) throw new LocalExecutorError('invalid-request', 'executor nonce is invalid');
  if (typeof input.projectId !== 'string' || !input.projectId) throw new LocalExecutorError('invalid-request', 'executor projectId is required');
  if (typeof input.operation !== 'string' || !input.operation) throw new LocalExecutorError('invalid-request', 'executor operation is required');
  const expiresAt = iso(input.expiresAt);
  const nowMs = Date.parse(iso(now));
  const expiresMs = Date.parse(expiresAt);
  if (expiresMs <= nowMs) throw new LocalExecutorError('job-expired', 'executor job has expired');
  if (expiresMs > nowMs + maxFutureMs) throw new LocalExecutorError('invalid-request', 'executor job expiry is too far in the future');
  const expectedSha = input.expectedSha == null ? null : sha(input.expectedSha);
  if (input.expectedSha != null && !expectedSha) throw new LocalExecutorError('invalid-request', 'expectedSha is invalid');
  if (input.arguments != null && !isPlainObject(input.arguments)) throw new LocalExecutorError('invalid-request', 'executor arguments must be an object');
  return Object.freeze({
    schemaVersion: 1,
    jobId: input.jobId,
    nonce: input.nonce,
    projectId: input.projectId,
    operation: input.operation,
    expectedSha,
    expiresAt,
    arguments: Object.freeze({ ...(input.arguments ?? {}) }),
  });
}

export class LocalExecutorStore {
  constructor(dbPath, { now = () => new Date().toISOString() } = {}) {
    if (typeof dbPath !== 'string' || !dbPath) throw new Error('local executor db path is required');
    this.dbPath = dbPath;
    this.now = now;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS local_executor_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_executor_jobs (
        job_id TEXT PRIMARY KEY,
        nonce TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        result_json TEXT NOT NULL DEFAULT '{}',
        error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS local_executor_project_locks (
        project_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES local_executor_jobs(job_id) ON DELETE CASCADE
      );
    `);
    this.db.prepare(`INSERT OR IGNORE INTO local_executor_schema(version, applied_at) VALUES (?, ?)`)
      .run(LOCAL_EXECUTOR_SCHEMA_VERSION, this.now());
  }

  getJob(jobId) {
    const row = this.db.prepare(`SELECT * FROM local_executor_jobs WHERE job_id = ?`).get(jobId);
    if (!row) return null;
    return {
      jobId: row.job_id,
      nonce: row.nonce,
      projectId: row.project_id,
      operation: row.operation,
      requestSha256: row.request_sha256,
      state: row.state,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      result: JSON.parse(row.result_json),
      errorCode: row.error_code,
    };
  }

  begin(job, { now = this.now(), leaseMs = 2 * 60 * 60_000 } = {}) {
    const timestamp = iso(now);
    const digest = jobDigest(job);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getJob(job.jobId);
      if (existing) {
        if (existing.requestSha256 !== digest) throw new LocalExecutorError('job-id-collision', 'executor jobId was reused with different content');
        this.db.exec('COMMIT');
        return { inserted: false, existing };
      }
      const nonceOwner = this.db.prepare(`SELECT job_id FROM local_executor_jobs WHERE nonce = ?`).get(job.nonce);
      if (nonceOwner) throw new LocalExecutorError('nonce-reused', 'executor nonce was already used');
      this.db.prepare(`DELETE FROM local_executor_project_locks WHERE expires_at <= ?`).run(timestamp);
      const activeLock = this.db.prepare(`SELECT job_id FROM local_executor_project_locks WHERE project_id = ?`).get(job.projectId);
      if (activeLock) throw new LocalExecutorError('project-locked', 'executor project already has an active job');
      this.db.prepare(`
        INSERT INTO local_executor_jobs(job_id, nonce, project_id, operation, request_sha256, state, started_at)
        VALUES (?, ?, ?, ?, ?, 'running', ?)
      `).run(job.jobId, job.nonce, job.projectId, job.operation, digest, timestamp);
      this.db.prepare(`
        INSERT INTO local_executor_project_locks(project_id, job_id, acquired_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(job.projectId, job.jobId, timestamp, new Date(Date.parse(timestamp) + leaseMs).toISOString());
      this.db.exec('COMMIT');
      return { inserted: true, existing: null };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finish(jobId, { state, result = {}, errorCode = null, now = this.now() } = {}) {
    if (!FINAL_JOB_STATES.has(state)) throw new Error('local executor final state is invalid');
    const timestamp = iso(now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.getJob(jobId);
      if (!job || job.state !== 'running') throw new LocalExecutorError('job-not-running', 'executor job is not running');
      this.db.prepare(`
        UPDATE local_executor_jobs
        SET state = ?, finished_at = ?, result_json = ?, error_code = ?
        WHERE job_id = ? AND state = 'running'
      `).run(state, timestamp, boundedResult(result), errorCode, jobId);
      this.db.prepare(`DELETE FROM local_executor_project_locks WHERE project_id = ? AND job_id = ?`)
        .run(job.projectId, jobId);
      this.db.exec('COMMIT');
      return this.getJob(jobId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

function requireOperation(policy, operation) {
  if (!policy.allowedOperations.includes(operation)) {
    throw new LocalExecutorError('operation-not-allowed', 'executor operation is not enabled for this project');
  }
}

function requireExpectedSha(job) {
  if (!job.expectedSha) throw new LocalExecutorError('invalid-request', 'expectedSha is required for this operation');
  return job.expectedSha;
}

function performOperation({ job, project, policy, spawn, env }) {
  requireOperation(policy, job.operation);
  const baseOptions = {
    cwd: project.localRepoPath,
    env: childEnvironment(env),
    timeoutMs: 30_000,
    maxOutputBytes: policy.maxOutputBytes,
  };
  const canonical = repositoryState(spawn, project, policy, env);

  if (job.operation === 'project.inspect') return canonical;

  if (job.operation === 'repository.fetch') {
    const command = runGit(spawn, project.localRepoPath, ['fetch', '--prune', 'origin'], baseOptions);
    return { before: canonical, command, after: repositoryState(spawn, project, policy, env) };
  }

  if (job.operation === 'repository.sync-default') {
    const expected = requireExpectedSha(job);
    if (!canonical.clean || canonical.branch !== policy.defaultBranch) {
      throw new LocalExecutorError('repository-not-syncable', 'canonical repository must be clean on the configured default branch');
    }
    const fetchCommand = runGit(spawn, project.localRepoPath, ['fetch', '--prune', 'origin', policy.defaultBranch], baseOptions);
    const remoteSha = runGitText(spawn, project.localRepoPath, ['rev-parse', `origin/${policy.defaultBranch}`], baseOptions).toLowerCase();
    if (remoteSha !== expected) throw new LocalExecutorError('expected-sha-mismatch', 'remote default branch does not match expectedSha');
    const mergeCommand = runGit(spawn, project.localRepoPath, ['merge', '--ff-only', expected], baseOptions);
    const after = repositoryState(spawn, project, policy, env);
    if (after.headSha !== expected || !after.clean) throw new LocalExecutorError('postcondition-failed', 'default branch sync postcondition failed');
    return { before: canonical, fetchCommand, mergeCommand, after };
  }

  if (job.operation === 'worktree.create') {
    const expected = requireExpectedSha(job);
    const target = worktreePath(policy, job.arguments.worktreeName);
    runGit(spawn, project.localRepoPath, ['cat-file', '-e', `${expected}^{commit}`], baseOptions);
    mkdirSync(policy.worktreeRoot, { recursive: true });
    const command = runGit(spawn, project.localRepoPath, ['worktree', 'add', '--detach', target, expected], baseOptions);
    const state = targetState(spawn, target, policy, env);
    if (state.headSha !== expected || !state.clean) throw new LocalExecutorError('postcondition-failed', 'worktree creation postcondition failed');
    return { command, worktree: state };
  }

  if (job.operation === 'worktree.inspect') {
    return targetState(spawn, worktreePath(policy, job.arguments.worktreeName), policy, env);
  }

  if (job.operation === 'validation.run') {
    const expected = requireExpectedSha(job);
    const profileName = job.arguments.profile;
    if (!PROFILE_PATTERN.test(profileName || '') || !policy.validationProfiles[profileName]) {
      throw new LocalExecutorError('validation-profile-not-allowed', 'validation profile is not configured');
    }
    const profile = policy.validationProfiles[profileName];
    const target = job.arguments.target === 'canonical'
      ? resolve(project.localRepoPath)
      : worktreePath(policy, job.arguments.worktreeName);
    if (target !== resolve(project.localRepoPath) && !inside(policy.worktreeRoot, target)) {
      throw new LocalExecutorError('path-not-allowed', 'validation target is outside project ownership');
    }
    const before = target === resolve(project.localRepoPath)
      ? canonical
      : targetState(spawn, target, policy, env);
    if (before.headSha !== expected) throw new LocalExecutorError('expected-sha-mismatch', 'validation target does not match expectedSha');
    if (profile.requireCleanBefore && !before.clean) throw new LocalExecutorError('worktree-dirty', 'validation target is not clean');
    const commands = [];
    for (const command of profile.commands) {
      commands.push(runCommand(spawn, command.argv, {
        cwd: target,
        env: childEnvironment(env, command.environment),
        timeoutMs: command.timeoutSeconds * 1_000,
        maxOutputBytes: policy.maxOutputBytes,
      }));
    }
    const after = target === resolve(project.localRepoPath)
      ? repositoryState(spawn, project, policy, env)
      : targetState(spawn, target, policy, env);
    if (after.headSha !== expected) throw new LocalExecutorError('postcondition-failed', 'validation changed the target commit');
    if (profile.requireCleanAfter && !after.clean) throw new LocalExecutorError('worktree-dirty-after-validation', 'validation left the target dirty');
    return { profile: profileName, target, expectedSha: expected, before, commands, after };
  }

  if (job.operation === 'worktree.remove') {
    const expected = requireExpectedSha(job);
    const target = worktreePath(policy, job.arguments.worktreeName);
    const before = targetState(spawn, target, policy, env);
    if (before.headSha !== expected) throw new LocalExecutorError('expected-sha-mismatch', 'worktree does not match expectedSha');
    if (!before.clean) throw new LocalExecutorError('worktree-dirty', 'dirty worktree cannot be removed automatically');
    const removeCommand = runGit(spawn, project.localRepoPath, ['worktree', 'remove', target], baseOptions);
    const pruneCommand = runGit(spawn, project.localRepoPath, ['worktree', 'prune'], baseOptions);
    return { before, removeCommand, pruneCommand, removed: true };
  }

  throw new LocalExecutorError('operation-not-supported', 'executor operation is not implemented');
}

export function executeLocalExecutorJob({
  input,
  registry,
  policy,
  store,
  spawn = spawnSync,
  env = process.env,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  now = new Date().toISOString(),
} = {}) {
  if (uid === 0) throw new LocalExecutorError('root-execution-forbidden', 'local executor must not run as root');
  if (!registry?.projectsById) throw new Error('project registry is required');
  if (!policy?.projectsById) throw new Error('local executor policy is required');
  if (!store?.begin) throw new Error('local executor store is required');
  if (typeof spawn !== 'function') throw new Error('spawn function is required');
  const job = validateLocalExecutorJob(input, { now });
  const project = projectFromRegistryById(registry, job.projectId);
  const projectPolicy = localExecutorProjectPolicy(policy, job.projectId);
  if (!project || !projectPolicy) throw new LocalExecutorError('project-not-enabled', 'executor project is not enabled');
  if (inside(project.localRepoPath, projectPolicy.worktreeRoot) || inside(projectPolicy.worktreeRoot, project.localRepoPath)) {
    throw new LocalExecutorError('path-policy-conflict', 'canonical repository and worktree root must not contain each other');
  }
  const begun = store.begin(job, { now });
  if (!begun.inserted) return Object.freeze({ replay: true, job: begun.existing });
  try {
    const result = performOperation({ job, project, policy: projectPolicy, spawn, env });
    return Object.freeze({ replay: false, job: store.finish(job.jobId, { state: 'succeeded', result, now }) });
  } catch (error) {
    const code = error instanceof LocalExecutorError ? error.code : 'executor-operation-failed';
    const result = error?.command ? { command: error.command } : {};
    const failed = store.finish(job.jobId, { state: 'failed', result, errorCode: code, now });
    return Object.freeze({ replay: false, job: failed });
  }
}
