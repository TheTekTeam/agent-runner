import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  executeLocalExecutorJob,
  LocalExecutorStore,
} from './agent-runner-local-executor.mjs';
import { localExecutorProjectPolicy } from './agent-runner-local-executor-policy.mjs';
import { projectFromRegistryById } from './agent-runner-project-registry.mjs';

export const VALIDATION_EVIDENCE_SCHEMA_VERSION = 1;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const REQUEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const FINAL_STATES = new Set(['succeeded', 'failed']);
const MAX_EVIDENCE_BYTES = 256 * 1024;

export class ValidationEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ValidationEvidenceError';
    this.code = code;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function iso(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ValidationEvidenceError('invalid-request', `${name} is invalid`);
  return date.toISOString();
}

function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function targetPath(project, projectPolicy, targetKind, worktreeName) {
  if (targetKind === 'canonical') return resolve(project.localRepoPath);
  if (targetKind !== 'worktree' || typeof worktreeName !== 'string' || !worktreeName) {
    throw new ValidationEvidenceError('invalid-request', 'validation target is invalid');
  }
  const target = resolve(projectPolicy.worktreeRoot, worktreeName);
  if (!inside(projectPolicy.worktreeRoot, target) || target === resolve(projectPolicy.worktreeRoot)) {
    throw new ValidationEvidenceError('path-not-allowed', 'validation worktree is outside project ownership');
  }
  return target;
}

function boundedEvidence(value) {
  const encoded = stableJson(value);
  if (Buffer.byteLength(encoded) > MAX_EVIDENCE_BYTES) {
    throw new ValidationEvidenceError('evidence-too-large', 'validation evidence exceeds the bounded limit');
  }
  return encoded;
}

function commandContract(profile) {
  return profile.commands.map((command, ordinal) => ({
    ordinal,
    executable: basename(command.argv[0]),
    argvSha256: digest(stableJson(command.argv)),
    workingDirectory: command.workingDirectory,
    environmentNames: [...command.environment],
    timeoutSeconds: command.timeoutSeconds,
  }));
}

function gitState(target, env, spawn = spawnSync) {
  const options = {
    cwd: target,
    env: {
      PATH: env.PATH,
      HOME: env.HOME,
      LANG: env.LANG,
      LC_ALL: env.LC_ALL,
      NO_COLOR: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
  };
  const head = spawn('git', ['-C', target, 'rev-parse', 'HEAD'], options);
  if (head.status !== 0) throw new ValidationEvidenceError('target-state-unavailable', 'validation target SHA is unavailable');
  const status = spawn('git', ['-C', target, 'status', '--porcelain=v1', '--untracked-files=all'], options);
  if (status.status !== 0) throw new ValidationEvidenceError('target-state-unavailable', 'validation target status is unavailable');
  const porcelain = String(status.stdout || '').trim();
  return Object.freeze({
    headSha: String(head.stdout || '').trim().toLowerCase(),
    clean: porcelain.length === 0,
    changedEntries: porcelain ? porcelain.split('\n').filter(Boolean).length : 0,
  });
}

function measuredSpawnFactory({ spawn, target, profile }) {
  const trace = [];
  let validationOrdinal = 0;
  const measuredSpawn = (command, args, options) => {
    const argv = [command, ...args];
    let resolvedOptions = options;
    let matchedOrdinal = null;
    const expected = profile.commands[validationOrdinal];
    if (expected && stableJson(argv) === stableJson(expected.argv)) {
      const cwd = resolve(target, expected.workingDirectory);
      if (!inside(target, cwd)) {
        throw new ValidationEvidenceError('path-not-allowed', 'validation command working directory escaped the target');
      }
      resolvedOptions = { ...options, cwd };
      matchedOrdinal = validationOrdinal;
      validationOrdinal += 1;
    }
    const started = process.hrtime.bigint();
    const result = spawn(command, args, resolvedOptions);
    const finished = process.hrtime.bigint();
    trace.push(Object.freeze({
      argvSha256: digest(stableJson(argv)),
      validationOrdinal: matchedOrdinal,
      durationMs: Number((finished - started) / 1_000_000n),
    }));
    return result;
  };
  return Object.freeze({ measuredSpawn, trace });
}

function commandEvidence(rawCommands, trace, profile) {
  const byOrdinal = new Map(
    trace
      .filter((entry) => entry.validationOrdinal != null)
      .map((entry) => [entry.validationOrdinal, entry]),
  );
  const rawByDigest = new Map();
  for (const raw of rawCommands ?? []) {
    const key = digest(stableJson(raw?.argv ?? []));
    const queue = rawByDigest.get(key) ?? [];
    queue.push(raw);
    rawByDigest.set(key, queue);
  }
  return profile.commands.map((command, ordinal) => {
    const key = digest(stableJson(command.argv));
    const queue = rawByDigest.get(key) ?? [];
    const raw = queue.shift() ?? null;
    rawByDigest.set(key, queue);
    const measured = byOrdinal.get(ordinal);
    return Object.freeze({
      ordinal,
      executable: basename(command.argv[0]),
      argvSha256: digest(stableJson(command.argv)),
      workingDirectory: command.workingDirectory,
      environmentNames: Object.freeze([...command.environment]),
      timeoutSeconds: command.timeoutSeconds,
      status: Number.isInteger(raw?.status) ? raw.status : null,
      signal: typeof raw?.signal === 'string' ? raw.signal : null,
      durationMs: measured?.durationMs ?? null,
      stdout: Object.freeze({
        bytes: Number.isInteger(raw?.stdout?.bytes) ? raw.stdout.bytes : 0,
        sha256: typeof raw?.stdout?.sha256 === 'string' ? raw.stdout.sha256 : digest(''),
      }),
      stderr: Object.freeze({
        bytes: Number.isInteger(raw?.stderr?.bytes) ? raw.stderr.bytes : 0,
        sha256: typeof raw?.stderr?.sha256 === 'string' ? raw.stderr.sha256 : digest(''),
      }),
    });
  });
}

function collectArtifacts(target, profile, projectPolicy) {
  if (profile.artifacts.length > projectPolicy.maxValidationArtifactCount) {
    throw new ValidationEvidenceError('artifact-count-exceeded', 'validation artifact count exceeds project policy');
  }
  const artifacts = [];
  let totalBytes = 0;
  const root = realpathSync(target);
  for (const relativePath of profile.artifacts) {
    const candidate = resolve(target, relativePath);
    if (!inside(target, candidate)) {
      throw new ValidationEvidenceError('artifact-path-invalid', 'validation artifact path escaped the target');
    }
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ValidationEvidenceError('artifact-type-invalid', 'validation artifact must be a regular file');
    }
    const real = realpathSync(candidate);
    if (!inside(root, real)) {
      throw new ValidationEvidenceError('artifact-path-invalid', 'validation artifact resolved outside the target');
    }
    totalBytes += stat.size;
    if (totalBytes > projectPolicy.maxValidationArtifactBytes) {
      throw new ValidationEvidenceError('artifact-bytes-exceeded', 'validation artifacts exceed project policy');
    }
    const bytes = readFileSync(real);
    artifacts.push(Object.freeze({
      relativePath,
      bytes: bytes.length,
      sha256: digest(bytes),
    }));
  }
  return Object.freeze(artifacts);
}

function compactJobResult(evidence) {
  return Object.freeze({
    validationEvidence: Object.freeze({
      validationId: evidence.validationId,
      state: evidence.state,
      profile: evidence.profile,
      expectedSha: evidence.expectedSha,
      observedSha: evidence.observedSha,
      expiresAt: evidence.expiresAt,
      commandCount: evidence.commands.length,
      artifactCount: evidence.artifacts.length,
      errorCode: evidence.errorCode,
    }),
  });
}

function evidenceFromExecution({
  job,
  project,
  profileName,
  profile,
  targetKind,
  target,
  trace,
  artifacts,
  expectedSha,
  env,
  now,
  errorCodeOverride = null,
}) {
  const raw = job.result ?? {};
  const rawCommands = Array.isArray(raw.commands)
    ? raw.commands
    : (raw.command ? [raw.command] : []);
  const fallback = gitState(target, env);
  const before = raw.before && SHA_PATTERN.test(raw.before.headSha || '')
    ? raw.before
    : fallback;
  const after = raw.after && SHA_PATTERN.test(raw.after.headSha || '')
    ? raw.after
    : fallback;
  const finishedAt = iso(job.finishedAt ?? now, 'validation finishedAt');
  const expiresAt = new Date(
    Date.parse(finishedAt) + profile.evidenceTtlSeconds * 1_000,
  ).toISOString();
  const state = errorCodeOverride || job.state !== 'succeeded' ? 'failed' : 'succeeded';
  const errorCode = errorCodeOverride ?? job.errorCode ?? null;
  const validationId = `validation-${digest(stableJson({
    jobId: job.jobId,
    projectId: project.projectId,
    profile: profileName,
    expectedSha,
  })).slice(0, 48)}`;
  return Object.freeze({
    schemaVersion: VALIDATION_EVIDENCE_SCHEMA_VERSION,
    validationId,
    jobId: job.jobId,
    projectId: project.projectId,
    repository: project.githubRepo,
    profile: profileName,
    target: targetKind,
    expectedSha,
    observedSha: after.headSha,
    state,
    startedAt: iso(job.startedAt, 'validation startedAt'),
    finishedAt,
    expiresAt,
    cleanBefore: Boolean(before.clean),
    cleanAfter: Boolean(after.clean),
    changedEntriesBefore: Number(before.changedEntries ?? 0),
    changedEntriesAfter: Number(after.changedEntries ?? 0),
    commands: Object.freeze(commandEvidence(rawCommands, trace, profile)),
    artifacts: Object.freeze(artifacts),
    errorCode,
  });
}

export class ValidationEvidenceStore {
  constructor(localExecutorStore) {
    if (!localExecutorStore?.db) throw new Error('local executor store is required');
    this.localExecutorStore = localExecutorStore;
    this.db = localExecutorStore.db;
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS validation_evidence_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS validation_runs (
        validation_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        profile TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('canonical', 'worktree')),
        expected_sha TEXT NOT NULL,
        observed_sha TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('succeeded', 'failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        error_code TEXT,
        FOREIGN KEY (job_id) REFERENCES local_executor_jobs(job_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS validation_command_results (
        validation_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        executable TEXT NOT NULL,
        argv_sha256 TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        environment_names_json TEXT NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        status INTEGER,
        signal TEXT,
        duration_ms INTEGER,
        stdout_bytes INTEGER NOT NULL,
        stdout_sha256 TEXT NOT NULL,
        stderr_bytes INTEGER NOT NULL,
        stderr_sha256 TEXT NOT NULL,
        PRIMARY KEY (validation_id, ordinal),
        FOREIGN KEY (validation_id) REFERENCES validation_runs(validation_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS validation_artifacts (
        validation_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY (validation_id, relative_path),
        FOREIGN KEY (validation_id) REFERENCES validation_runs(validation_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS validation_runs_lookup_idx
        ON validation_runs(project_id, profile, observed_sha, state, finished_at);
    `);
    this.db.prepare(`
      INSERT OR IGNORE INTO validation_evidence_schema(version, applied_at)
      VALUES (?, ?)
    `).run(VALIDATION_EVIDENCE_SCHEMA_VERSION, new Date().toISOString());
  }

  getByJobId(jobId) {
    const row = this.db.prepare(`
      SELECT evidence_json FROM validation_runs WHERE job_id = ?
    `).get(jobId);
    return row ? Object.freeze(JSON.parse(row.evidence_json)) : null;
  }

  get(validationId) {
    const row = this.db.prepare(`
      SELECT evidence_json FROM validation_runs WHERE validation_id = ?
    `).get(validationId);
    return row ? Object.freeze(JSON.parse(row.evidence_json)) : null;
  }

  recordAndSanitizeJob(job, evidence) {
    if (!FINAL_STATES.has(evidence.state)) throw new Error('validation evidence final state is invalid');
    const requestSha256 = digest(stableJson({
      jobId: evidence.jobId,
      projectId: evidence.projectId,
      repository: evidence.repository,
      profile: evidence.profile,
      target: evidence.target,
      expectedSha: evidence.expectedSha,
    }));
    const encoded = boundedEvidence(evidence);
    const compact = stableJson(compactJobResult(evidence));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(`
        SELECT request_sha256, evidence_json
        FROM validation_runs
        WHERE validation_id = ? OR job_id = ?
      `).get(evidence.validationId, evidence.jobId);
      if (existing) {
        if (existing.request_sha256 !== requestSha256 || existing.evidence_json !== encoded) {
          throw new ValidationEvidenceError('validation-id-collision', 'validation identity was reused with different evidence');
        }
        this.db.exec('COMMIT');
        return Object.freeze(JSON.parse(existing.evidence_json));
      }
      this.db.prepare(`
        INSERT INTO validation_runs(
          validation_id, job_id, project_id, repository, profile, target_kind,
          expected_sha, observed_sha, state, started_at, finished_at, expires_at,
          request_sha256, evidence_json, error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evidence.validationId,
        evidence.jobId,
        evidence.projectId,
        evidence.repository,
        evidence.profile,
        evidence.target,
        evidence.expectedSha,
        evidence.observedSha,
        evidence.state,
        evidence.startedAt,
        evidence.finishedAt,
        evidence.expiresAt,
        requestSha256,
        encoded,
        evidence.errorCode,
      );
      const commandStatement = this.db.prepare(`
        INSERT INTO validation_command_results(
          validation_id, ordinal, executable, argv_sha256, working_directory,
          environment_names_json, timeout_seconds, status, signal, duration_ms,
          stdout_bytes, stdout_sha256, stderr_bytes, stderr_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const command of evidence.commands) {
        commandStatement.run(
          evidence.validationId,
          command.ordinal,
          command.executable,
          command.argvSha256,
          command.workingDirectory,
          stableJson(command.environmentNames),
          command.timeoutSeconds,
          command.status,
          command.signal,
          command.durationMs,
          command.stdout.bytes,
          command.stdout.sha256,
          command.stderr.bytes,
          command.stderr.sha256,
        );
      }
      const artifactStatement = this.db.prepare(`
        INSERT INTO validation_artifacts(validation_id, relative_path, bytes, sha256)
        VALUES (?, ?, ?, ?)
      `);
      for (const artifact of evidence.artifacts) {
        artifactStatement.run(
          evidence.validationId,
          artifact.relativePath,
          artifact.bytes,
          artifact.sha256,
        );
      }
      this.db.prepare(`
        UPDATE local_executor_jobs
        SET state = ?, result_json = ?, error_code = ?
        WHERE job_id = ?
      `).run(evidence.state, compact, evidence.errorCode, job.jobId);
      this.db.exec('COMMIT');
      return evidence;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function requiredProfilesForRisk(policy, projectId, riskClass) {
  const projectPolicy = localExecutorProjectPolicy(policy, projectId);
  if (!projectPolicy) throw new ValidationEvidenceError('project-not-enabled', 'validation project is not enabled');
  const profiles = projectPolicy.requiredValidationProfiles?.[riskClass];
  if (!profiles || profiles.length === 0) {
    throw new ValidationEvidenceError('risk-profile-not-configured', 'validation risk class has no configured profile mapping');
  }
  return Object.freeze([...profiles]);
}

export function evaluateValidationFreshness(evidence, {
  projectId = evidence?.projectId,
  profile = evidence?.profile,
  expectedSha = evidence?.expectedSha,
  now = new Date().toISOString(),
} = {}) {
  if (!evidence || evidence.state !== 'succeeded') {
    return Object.freeze({ fresh: false, reason: 'validation-not-successful' });
  }
  if (evidence.projectId !== projectId || evidence.profile !== profile) {
    return Object.freeze({ fresh: false, reason: 'validation-contract-mismatch' });
  }
  if (evidence.expectedSha !== expectedSha || evidence.observedSha !== expectedSha) {
    return Object.freeze({ fresh: false, reason: 'validation-sha-mismatch' });
  }
  if (Date.parse(evidence.expiresAt) <= Date.parse(iso(now, 'freshness timestamp'))) {
    return Object.freeze({ fresh: false, reason: 'validation-expired' });
  }
  return Object.freeze({ fresh: true, reason: 'validation-fresh' });
}

export function comparePostMergeValidation(preMerge, postMerge) {
  if (!preMerge || !postMerge || preMerge.state !== 'succeeded' || postMerge.state !== 'succeeded') {
    return Object.freeze({ comparable: false, reason: 'validation-not-successful' });
  }
  if (preMerge.projectId !== postMerge.projectId || preMerge.profile !== postMerge.profile) {
    return Object.freeze({ comparable: false, reason: 'validation-contract-mismatch' });
  }
  if (Date.parse(postMerge.finishedAt) < Date.parse(preMerge.finishedAt)) {
    return Object.freeze({ comparable: false, reason: 'post-merge-validation-older' });
  }
  const commandContractSame = stableJson(
    preMerge.commands.map((command) => ({
      ordinal: command.ordinal,
      argvSha256: command.argvSha256,
      workingDirectory: command.workingDirectory,
      environmentNames: command.environmentNames,
      timeoutSeconds: command.timeoutSeconds,
    })),
  ) === stableJson(
    postMerge.commands.map((command) => ({
      ordinal: command.ordinal,
      argvSha256: command.argvSha256,
      workingDirectory: command.workingDirectory,
      environmentNames: command.environmentNames,
      timeoutSeconds: command.timeoutSeconds,
    })),
  );
  const preArtifacts = Object.fromEntries(preMerge.artifacts.map((artifact) => [artifact.relativePath, artifact.sha256]));
  const postArtifacts = Object.fromEntries(postMerge.artifacts.map((artifact) => [artifact.relativePath, artifact.sha256]));
  return Object.freeze({
    comparable: commandContractSame,
    reason: commandContractSame ? 'validation-comparable' : 'command-contract-changed',
    preMergeSha: preMerge.observedSha,
    postMergeSha: postMerge.observedSha,
    artifactDigestsEqual: stableJson(preArtifacts) === stableJson(postArtifacts),
  });
}

export function runValidationProfile({
  requestId,
  projectId,
  profileName,
  expectedSha,
  target = 'canonical',
  worktreeName = null,
  riskClass = null,
  registry,
  policy,
  store,
  env = process.env,
  spawn = spawnSync,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  now = new Date().toISOString(),
} = {}) {
  if (uid === 0) throw new ValidationEvidenceError('root-execution-forbidden', 'validation profiles must not run as root');
  if (!REQUEST_PATTERN.test(requestId || '')) throw new ValidationEvidenceError('invalid-request', 'validation requestId is invalid');
  if (!SHA_PATTERN.test(expectedSha || '')) throw new ValidationEvidenceError('invalid-request', 'validation expectedSha is invalid');
  if (!registry?.projectsById || !policy?.projectsById || !store?.db) {
    throw new Error('validation registry, policy and local executor store are required');
  }
  const project = projectFromRegistryById(registry, projectId);
  const projectPolicy = localExecutorProjectPolicy(policy, projectId);
  if (!project || !projectPolicy) throw new ValidationEvidenceError('project-not-enabled', 'validation project is not enabled');
  if (!projectPolicy.allowedOperations.includes('validation.run')) {
    throw new ValidationEvidenceError('operation-not-allowed', 'validation.run is not enabled for this project');
  }
  const profile = projectPolicy.validationProfiles?.[profileName];
  if (!profile) throw new ValidationEvidenceError('validation-profile-not-allowed', 'validation profile is not configured');
  if (riskClass != null && !requiredProfilesForRisk(policy, projectId, riskClass).includes(profileName)) {
    throw new ValidationEvidenceError('risk-profile-mismatch', 'validation profile does not satisfy the requested risk class');
  }
  const resolvedTarget = targetPath(project, projectPolicy, target, worktreeName);
  const { measuredSpawn, trace } = measuredSpawnFactory({
    spawn,
    target: resolvedTarget,
    profile,
  });
  const identity = digest(stableJson({
    requestId,
    projectId,
    profileName,
    expectedSha: expectedSha.toLowerCase(),
    target,
    worktreeName,
    riskClass,
  }));
  const input = Object.freeze({
    schemaVersion: 1,
    jobId: `validation-job-${identity.slice(0, 48)}`,
    nonce: `validation-nonce-${identity}`,
    projectId,
    operation: 'validation.run',
    expectedSha: expectedSha.toLowerCase(),
    expiresAt: new Date(Date.parse(iso(now, 'validation timestamp')) + 60 * 60_000).toISOString(),
    arguments: Object.freeze({
      profile: profileName,
      target,
      ...(target === 'worktree' ? { worktreeName } : {}),
    }),
  });
  const evidenceStore = new ValidationEvidenceStore(store);
  const existing = store.getJob(input.jobId);
  if (existing) {
    let evidence = evidenceStore.getByJobId(input.jobId);
    let recovered = false;
    if (!evidence) {
      let artifacts = [];
      let artifactError = null;
      if (existing.state === 'succeeded') {
        try {
          artifacts = collectArtifacts(resolvedTarget, profile, projectPolicy);
        } catch (error) {
          artifactError = error instanceof ValidationEvidenceError
            ? error.code
            : 'artifact-collection-failed';
        }
      }
      evidence = evidenceFromExecution({
        job: existing,
        project,
        profileName,
        profile,
        targetKind: target,
        target: resolvedTarget,
        trace: [],
        artifacts,
        expectedSha: expectedSha.toLowerCase(),
        env,
        now,
        errorCodeOverride: artifactError,
      });
      evidence = evidenceStore.recordAndSanitizeJob(existing, evidence);
      recovered = true;
    }
    return Object.freeze({ replay: true, recovered, evidence });
  }
  const result = executeLocalExecutorJob({
    input,
    registry,
    policy,
    store,
    spawn: measuredSpawn,
    env,
    uid,
    now,
  });
  let job = result.job;
  let artifacts = [];
  let artifactError = null;
  if (job.state === 'succeeded') {
    try {
      artifacts = collectArtifacts(resolvedTarget, profile, projectPolicy);
    } catch (error) {
      artifactError = error instanceof ValidationEvidenceError
        ? error.code
        : 'artifact-collection-failed';
    }
  }
  const evidence = evidenceFromExecution({
    job,
    project,
    profileName,
    profile,
    targetKind: target,
    target: resolvedTarget,
    trace,
    artifacts,
    expectedSha: expectedSha.toLowerCase(),
    env,
    now,
    errorCodeOverride: artifactError,
  });
  const persisted = evidenceStore.recordAndSanitizeJob(job, evidence);
  job = store.getJob(job.jobId);
  return Object.freeze({
    replay: false,
    evidence: persisted,
    job: Object.freeze({
      jobId: job.jobId,
      state: job.state,
      errorCode: job.errorCode,
    }),
  });
}

export function validationCommandContract(policy, projectId, profileName) {
  const projectPolicy = localExecutorProjectPolicy(policy, projectId);
  const profile = projectPolicy?.validationProfiles?.[profileName];
  if (!profile) throw new ValidationEvidenceError('validation-profile-not-allowed', 'validation profile is not configured');
  return Object.freeze(commandContract(profile));
}

export { LocalExecutorStore };
