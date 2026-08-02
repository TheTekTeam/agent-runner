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
  LocalExecutorError,
  LocalExecutorStore,
} from './agent-runner-local-executor.mjs';
import { localExecutorProjectPolicy } from './agent-runner-local-executor-policy.mjs';
import { projectFromRegistryById } from './agent-runner-project-registry.mjs';
import {
  VALIDATION_EVIDENCE_SCHEMA_VERSION,
  VALIDATION_FINAL_STATES,
  VALIDATION_INTERNAL_MARKER_PREFIX,
  VALIDATION_REQUEST_PATTERN,
  VALIDATION_SHA_PATTERN,
  ValidationEvidenceError,
  requiredProfilesForRisk,
  validationDigest,
  validationIso,
  validationProfileContractSha256,
  validationStableJson,
} from './agent-runner-validation-profile-contract.mjs';
import { ValidationEvidenceStore } from './agent-runner-validation-evidence-store.mjs';

function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === ''
    || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function targetPath(project, projectPolicy, targetKind, worktreeName) {
  if (targetKind === 'canonical') return resolve(project.localRepoPath);
  if (
    targetKind !== 'worktree'
    || typeof worktreeName !== 'string'
    || !worktreeName
  ) {
    throw new ValidationEvidenceError(
      'invalid-request',
      'validation target is invalid',
    );
  }
  const target = resolve(projectPolicy.worktreeRoot, worktreeName);
  if (
    !inside(projectPolicy.worktreeRoot, target)
    || target === resolve(projectPolicy.worktreeRoot)
  ) {
    throw new ValidationEvidenceError(
      'path-not-allowed',
      'validation worktree is outside project ownership',
    );
  }
  return target;
}

function gitState(target, env, spawn = spawnSync) {
  const childEnv = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL']) {
    if (env[name] != null) childEnv[name] = String(env[name]);
  }
  childEnv.NO_COLOR = '1';
  childEnv.GIT_TERMINAL_PROMPT = '0';
  const options = {
    cwd: target,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
  };
  const head = spawn('git', ['-C', target, 'rev-parse', 'HEAD'], options);
  if (head.status !== 0) {
    throw new ValidationEvidenceError(
      'target-state-unavailable',
      'validation target SHA is unavailable',
    );
  }
  const status = spawn(
    'git',
    ['-C', target, 'status', '--porcelain=v1', '--untracked-files=all'],
    options,
  );
  if (status.status !== 0) {
    throw new ValidationEvidenceError(
      'target-state-unavailable',
      'validation target status is unavailable',
    );
  }
  const porcelain = String(status.stdout || '').trim();
  return Object.freeze({
    headSha: String(head.stdout || '').trim().toLowerCase(),
    clean: porcelain.length === 0,
    changedEntries: porcelain
      ? porcelain.split('\n').filter(Boolean).length
      : 0,
  });
}

function markerName(ordinal) {
  return `${VALIDATION_INTERNAL_MARKER_PREFIX}${String(ordinal).padStart(3, '0')}`;
}

function executionPolicyWithMarkers(policy, projectId, profileName) {
  const projectPolicy = localExecutorProjectPolicy(policy, projectId);
  const profile = projectPolicy.validationProfiles[profileName];
  const markedProfile = Object.freeze({
    ...profile,
    commands: Object.freeze(
      profile.commands.map((command, ordinal) => Object.freeze({
        ...command,
        environment: Object.freeze([
          ...command.environment,
          markerName(ordinal),
        ]),
      })),
    ),
  });
  const markedProject = Object.freeze({
    ...projectPolicy,
    validationProfiles: Object.freeze({
      ...projectPolicy.validationProfiles,
      [profileName]: markedProfile,
    }),
  });
  return Object.freeze({
    ...policy,
    projects: Object.freeze(
      policy.projects.map((project) => (
        project.projectId === projectId ? markedProject : project
      )),
    ),
    projectsById: Object.freeze({
      ...policy.projectsById,
      [projectId]: markedProject,
    }),
  });
}

function measuredSpawnFactory({ spawn, target, profile }) {
  const trace = [];
  const markerToOrdinal = new Map(
    profile.commands.map((_, ordinal) => [markerName(ordinal), ordinal]),
  );
  const realTarget = realpathSync(target);
  const measuredSpawn = (command, args, options) => {
    const presentMarkers = [...markerToOrdinal.keys()]
      .filter((name) => options?.env?.[name] != null);
    if (presentMarkers.length === 0) return spawn(command, args, options);
    if (presentMarkers.length !== 1) {
      throw new LocalExecutorError(
        'validation-command-marker-invalid',
        'validation command marker is ambiguous',
      );
    }
    const ordinal = markerToOrdinal.get(presentMarkers[0]);
    const expected = profile.commands[ordinal];
    const argv = [command, ...args];
    if (validationStableJson(argv) !== validationStableJson(expected.argv)) {
      throw new LocalExecutorError(
        'validation-command-contract-mismatch',
        'validation command differs from the declared contract',
      );
    }
    const candidate = resolve(target, expected.workingDirectory);
    let realCandidate;
    try {
      realCandidate = realpathSync(candidate);
    } catch {
      throw new LocalExecutorError(
        'validation-working-directory-unavailable',
        'validation working directory is unavailable',
      );
    }
    if (!inside(realTarget, realCandidate)) {
      throw new LocalExecutorError(
        'path-not-allowed',
        'validation working directory resolved outside the target',
      );
    }
    const cleanEnv = { ...(options.env ?? {}) };
    for (const name of markerToOrdinal.keys()) delete cleanEnv[name];
    const started = process.hrtime.bigint();
    const result = spawn(command, args, {
      ...options,
      cwd: realCandidate,
      env: cleanEnv,
    });
    const finished = process.hrtime.bigint();
    trace.push(Object.freeze({
      validationOrdinal: ordinal,
      durationMs: Number((finished - started) / 1_000_000n),
    }));
    return result;
  };
  return Object.freeze({ measuredSpawn, trace });
}

function commandEvidence(rawCommands, trace, profile) {
  const measuredByOrdinal = new Map(
    trace.map((entry) => [entry.validationOrdinal, entry]),
  );
  const rawByDigest = new Map();
  for (const raw of rawCommands ?? []) {
    const key = validationDigest(validationStableJson(raw?.argv ?? []));
    const queue = rawByDigest.get(key) ?? [];
    queue.push(raw);
    rawByDigest.set(key, queue);
  }
  return Object.freeze(
    profile.commands.map((command, ordinal) => {
      const key = validationDigest(validationStableJson(command.argv));
      const queue = rawByDigest.get(key) ?? [];
      const raw = queue.shift() ?? null;
      rawByDigest.set(key, queue);
      return Object.freeze({
        ordinal,
        executable: basename(command.argv[0]),
        argvSha256: key,
        workingDirectory: command.workingDirectory,
        environmentNames: Object.freeze([...command.environment]),
        timeoutSeconds: command.timeoutSeconds,
        status: Number.isInteger(raw?.status) ? raw.status : null,
        signal: typeof raw?.signal === 'string' ? raw.signal : null,
        durationMs: measuredByOrdinal.get(ordinal)?.durationMs ?? null,
        stdout: Object.freeze({
          bytes: Number.isInteger(raw?.stdout?.bytes) ? raw.stdout.bytes : 0,
          sha256: typeof raw?.stdout?.sha256 === 'string'
            ? raw.stdout.sha256
            : validationDigest(''),
        }),
        stderr: Object.freeze({
          bytes: Number.isInteger(raw?.stderr?.bytes) ? raw.stderr.bytes : 0,
          sha256: typeof raw?.stderr?.sha256 === 'string'
            ? raw.stderr.sha256
            : validationDigest(''),
        }),
      });
    }),
  );
}

function collectArtifacts(target, profile, projectPolicy) {
  if (profile.artifacts.length > projectPolicy.maxValidationArtifactCount) {
    throw new ValidationEvidenceError(
      'artifact-count-exceeded',
      'validation artifact count exceeds project policy',
    );
  }
  const artifacts = [];
  let totalBytes = 0;
  const root = realpathSync(target);
  for (const relativePath of profile.artifacts) {
    const candidate = resolve(target, relativePath);
    if (!inside(target, candidate)) {
      throw new ValidationEvidenceError(
        'artifact-path-invalid',
        'validation artifact path escaped the target',
      );
    }
    let stat;
    let real;
    try {
      stat = lstatSync(candidate);
      real = realpathSync(candidate);
    } catch {
      throw new ValidationEvidenceError(
        'artifact-unavailable',
        'validation artifact is unavailable',
      );
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ValidationEvidenceError(
        'artifact-type-invalid',
        'validation artifact must be a regular file',
      );
    }
    if (!inside(root, real)) {
      throw new ValidationEvidenceError(
        'artifact-path-invalid',
        'validation artifact resolved outside the target',
      );
    }
    totalBytes += stat.size;
    if (totalBytes > projectPolicy.maxValidationArtifactBytes) {
      throw new ValidationEvidenceError(
        'artifact-bytes-exceeded',
        'validation artifacts exceed project policy',
      );
    }
    const bytes = readFileSync(real);
    artifacts.push(Object.freeze({
      relativePath,
      bytes: bytes.length,
      sha256: validationDigest(bytes),
    }));
  }
  return Object.freeze(artifacts);
}

function rawState(value) {
  if (!value || !VALIDATION_SHA_PATTERN.test(value.headSha || '')) return null;
  return Object.freeze({
    headSha: String(value.headSha).toLowerCase(),
    clean: Boolean(value.clean),
    changedEntries: Number(value.changedEntries ?? 0),
  });
}

function statesEqual(left, right) {
  return left?.headSha === right?.headSha
    && left?.clean === right?.clean
    && left?.changedEntries === right?.changedEntries;
}

function evidenceFromExecution({
  job,
  project,
  profileName,
  profile,
  profileContractSha256,
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
  const before = rawState(raw.before) ?? fallback;
  const after = rawState(raw.after) ?? fallback;
  const finishedAt = validationIso(
    job.finishedAt ?? now,
    'validation finishedAt',
  );
  const expiresAt = new Date(
    Date.parse(finishedAt) + profile.evidenceTtlSeconds * 1_000,
  ).toISOString();
  const state = errorCodeOverride || job.state !== 'succeeded'
    ? 'failed'
    : 'succeeded';
  const errorCode = errorCodeOverride ?? job.errorCode ?? null;
  const validationId = `validation-${validationDigest(validationStableJson({
    jobId: job.jobId,
    projectId: project.projectId,
    profile: profileName,
    profileContractSha256,
    expectedSha,
  })).slice(0, 48)}`;
  return Object.freeze({
    schemaVersion: VALIDATION_EVIDENCE_SCHEMA_VERSION,
    validationId,
    jobId: job.jobId,
    projectId: project.projectId,
    repository: project.githubRepo,
    profile: profileName,
    profileContractSha256,
    target: targetKind,
    expectedSha,
    observedSha: after.headSha,
    state,
    startedAt: validationIso(job.startedAt, 'validation startedAt'),
    finishedAt,
    expiresAt,
    cleanBefore: before.clean,
    cleanAfter: after.clean,
    changedEntriesBefore: before.changedEntries,
    changedEntriesAfter: after.changedEntries,
    commands: commandEvidence(rawCommands, trace, profile),
    artifacts: Object.freeze(artifacts),
    errorCode,
  });
}

function assertEvidenceIdentity(evidence, expected) {
  if (
    evidence?.schemaVersion !== VALIDATION_EVIDENCE_SCHEMA_VERSION
    || !VALIDATION_FINAL_STATES.has(evidence?.state)
    || evidence.state !== expected.state
    || !VALIDATION_SHA_PATTERN.test(evidence?.observedSha || '')
    || !Array.isArray(evidence?.commands)
    || !Array.isArray(evidence?.artifacts)
  ) {
    throw new ValidationEvidenceError(
      'validation-evidence-corrupt',
      'validation evidence has an invalid durable shape',
    );
  }
  const checks = [
    ['jobId', expected.jobId],
    ['projectId', expected.projectId],
    ['repository', expected.repository],
    ['profile', expected.profile],
    ['profileContractSha256', expected.profileContractSha256],
    ['target', expected.target],
    ['expectedSha', expected.expectedSha],
  ];
  for (const [field, value] of checks) {
    if (evidence[field] !== value) {
      throw new ValidationEvidenceError(
        'validation-id-collision',
        'validation evidence identity differs from the request',
      );
    }
  }
}

function recoveryErrorForSuccessfulJob({ job, target, profile, env }) {
  if (profile.artifacts.length > 0) {
    return 'artifact-evidence-unavailable-after-recovery';
  }
  const recordedAfter = rawState(job.result?.after);
  if (!recordedAfter) return 'validation-evidence-recovery-incomplete';
  if (!statesEqual(recordedAfter, gitState(target, env))) {
    return 'validation-evidence-recovery-target-drift';
  }
  return null;
}

function assertExistingJobIdentity(existing, input) {
  if (
    existing.nonce !== input.nonce
    || existing.projectId !== input.projectId
    || existing.operation !== input.operation
  ) {
    throw new ValidationEvidenceError(
      'validation-id-collision',
      'validation job identity differs from the request',
    );
  }
  if (existing.state === 'running') {
    throw new ValidationEvidenceError(
      'validation-job-incomplete',
      'validation job is still running and cannot be replayed',
    );
  }
  if (!VALIDATION_FINAL_STATES.has(existing.state)) {
    throw new ValidationEvidenceError(
      'validation-job-state-invalid',
      'validation job has an invalid terminal state',
    );
  }
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
  if (uid === 0) {
    throw new ValidationEvidenceError(
      'root-execution-forbidden',
      'validation profiles must not run as root',
    );
  }
  if (!VALIDATION_REQUEST_PATTERN.test(requestId || '')) {
    throw new ValidationEvidenceError(
      'invalid-request',
      'validation requestId is invalid',
    );
  }
  if (!VALIDATION_SHA_PATTERN.test(expectedSha || '')) {
    throw new ValidationEvidenceError(
      'invalid-request',
      'validation expectedSha is invalid',
    );
  }
  if (!registry?.projectsById || !policy?.projectsById || !store?.db) {
    throw new Error(
      'validation registry, policy and local executor store are required',
    );
  }
  const project = projectFromRegistryById(registry, projectId);
  const projectPolicy = localExecutorProjectPolicy(policy, projectId);
  if (!project || !projectPolicy) {
    throw new ValidationEvidenceError(
      'project-not-enabled',
      'validation project is not enabled',
    );
  }
  if (!projectPolicy.allowedOperations.includes('validation.run')) {
    throw new ValidationEvidenceError(
      'operation-not-allowed',
      'validation.run is not enabled for this project',
    );
  }
  const profile = projectPolicy.validationProfiles?.[profileName];
  if (!profile) {
    throw new ValidationEvidenceError(
      'validation-profile-not-allowed',
      'validation profile is not configured',
    );
  }
  if (
    riskClass != null
    && !requiredProfilesForRisk(
      policy,
      projectId,
      riskClass,
    ).includes(profileName)
  ) {
    throw new ValidationEvidenceError(
      'risk-profile-mismatch',
      'validation profile does not satisfy the requested risk class',
    );
  }
  const resolvedTarget = targetPath(
    project,
    projectPolicy,
    target,
    worktreeName,
  );
  const contractSha256 = validationProfileContractSha256(
    policy,
    projectId,
    profileName,
  );
  const identity = validationDigest(validationStableJson({
    requestId,
    projectId,
    profileName,
    profileContractSha256: contractSha256,
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
    expiresAt: new Date(
      Date.parse(validationIso(now, 'validation timestamp')) + 60 * 60_000,
    ).toISOString(),
    arguments: Object.freeze({
      profile: profileName,
      profileContractSha256: contractSha256,
      target,
      ...(target === 'worktree' ? { worktreeName } : {}),
    }),
  });
  const evidenceStore = new ValidationEvidenceStore(store);
  const expectedIdentity = Object.freeze({
    jobId: input.jobId,
    projectId,
    repository: project.githubRepo,
    profile: profileName,
    profileContractSha256: contractSha256,
    target,
    expectedSha: expectedSha.toLowerCase(),
  });
  const existing = store.getJob(input.jobId);
  if (existing) {
    assertExistingJobIdentity(existing, input);
    let evidence = evidenceStore.getByJobId(input.jobId);
    let recovered = false;
    if (evidence) {
      assertEvidenceIdentity(evidence, {
        ...expectedIdentity,
        state: existing.state,
      });
      return Object.freeze({ replay: true, recovered, evidence });
    }
    if (existing.result?.validationEvidence) {
      throw new ValidationEvidenceError(
        'validation-evidence-store-inconsistent',
        'validation job references missing durable evidence',
      );
    }
    let recoveryError = null;
    if (existing.state === 'succeeded') {
      recoveryError = recoveryErrorForSuccessfulJob({
        job: existing,
        target: resolvedTarget,
        profile,
        env,
      });
    }
    evidence = evidenceFromExecution({
      job: existing,
      project,
      profileName,
      profile,
      profileContractSha256: contractSha256,
      targetKind: target,
      target: resolvedTarget,
      trace: [],
      artifacts: [],
      expectedSha: expectedSha.toLowerCase(),
      env,
      now,
      errorCodeOverride: recoveryError,
    });
    evidence = evidenceStore.recordAndSanitizeJob(existing, evidence);
    recovered = true;
    return Object.freeze({ replay: true, recovered, evidence });
  }

  const executionPolicy = executionPolicyWithMarkers(
    policy,
    projectId,
    profileName,
  );
  const executionEnv = { ...env };
  for (let ordinal = 0; ordinal < profile.commands.length; ordinal += 1) {
    executionEnv[markerName(ordinal)] = '1';
  }
  const { measuredSpawn, trace } = measuredSpawnFactory({
    spawn,
    target: resolvedTarget,
    profile,
  });
  const result = executeLocalExecutorJob({
    input,
    registry,
    policy: executionPolicy,
    store,
    spawn: measuredSpawn,
    env: executionEnv,
    uid,
    now,
  });
  let job = result.job;
  let artifacts = [];
  let artifactError = null;
  if (job.state === 'succeeded') {
    try {
      artifacts = collectArtifacts(
        resolvedTarget,
        profile,
        projectPolicy,
      );
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
    profileContractSha256: contractSha256,
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

export { LocalExecutorStore };
