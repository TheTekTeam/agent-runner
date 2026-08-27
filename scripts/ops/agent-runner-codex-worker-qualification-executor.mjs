import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { AGENT_ADAPTERS } from './agent-runner-agents.mjs';
import {
  acquireImplementationSlot,
  IMPLEMENTATION_LANE_ENV,
} from './agent-runner-implementation-slot.mjs';
import { admitCodexDispatch } from './agent-runner-codex-adapter.mjs';
import { buildCodexCommandArgs } from './agent-runner-codex-command.mjs';
import { classifyCodexExecutionError, parseCodexResultEnvelope } from './agent-runner-codex-parser.mjs';
import { runCodexQuotaPreflight, sanitizeCodexEnvironment } from './agent-runner-codex-quota-preflight.mjs';
import {
  buildCodexWorkerQualificationResult,
  CODEX_WORKER_QUALIFICATION_EFFORT,
  CODEX_WORKER_QUALIFICATION_EXPECTED_CONTENT,
  CODEX_WORKER_QUALIFICATION_EXPECTED_FILE,
  CODEX_WORKER_QUALIFICATION_MODEL,
  CODEX_WORKER_QUALIFICATION_PROFILE,
  CODEX_WORKER_QUALIFICATION_REPOSITORY,
  CODEX_WORKER_QUALIFICATION_SCHEMA_VERSION,
  CODEX_WORKER_QUALIFICATION_TARGET_NODE,
  validateCodexWorkerQualificationRequest,
} from './agent-runner-codex-worker-qualification.mjs';

const STATE_SCHEMA = 'agent-runner-codex-worker-qualification-state/v1';
const MAX_BUFFER = 2 * 1024 * 1024;

function safeReason(value, fallback = 'qualification-executor-failed') {
  const reason = String(value || '');
  return /^[A-Za-z0-9._:-]{1,160}$/.test(reason) ? reason : fallback;
}

function runGit(args, {
  cwd,
  execFileSyncFn = execFileSync,
  allowFailure = false,
} = {}) {
  try {
    return String(execFileSyncFn('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_BUFFER,
    }) || '').trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function repositoryFromOrigin(value) {
  const raw = String(value || '').trim().replace(/\.git$/, '');
  const match = raw.match(/github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/i);
  return match?.[1] || null;
}

export function codexWorkerQualificationStatePath({ stateRoot, jobFingerprint } = {}) {
  const rawRoot = String(stateRoot || '').trim();
  const match = String(jobFingerprint || '').match(/^sha256:([a-f0-9]{64})$/);
  if (!rawRoot || !match) throw new Error('state identity is invalid');
  const root = resolve(rawRoot);
  return resolve(root, `${match[1]}.json`);
}

function readState(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function buildCodexWorkerCanaryArgs({
  codexPath,
  cwd,
  prompt,
} = {}) {
  return buildCodexCommandArgs({
    executablePath: codexPath,
    cwd,
    model: CODEX_WORKER_QUALIFICATION_MODEL,
    sandboxMode: 'workspace-write',
    approvalMode: 'never',
    reasoningEffort: CODEX_WORKER_QUALIFICATION_EFFORT,
    networkAccess: false,
    ephemeral: true,
    ignoreUserConfig: true,
    prompt,
  });
}

export function validateCodexWorkerCanaryWorkspace({
  cwd,
  baseSha,
  execFileSyncFn = execFileSync,
} = {}) {
  const expectedPath = join(cwd, CODEX_WORKER_QUALIFICATION_EXPECTED_FILE);
  const head = runGit(['rev-parse', 'HEAD'], { cwd, execFileSyncFn });
  const status = String(execFileSyncFn('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: MAX_BUFFER,
  }) || '');
  const content = existsSync(expectedPath) ? readFileSync(expectedPath, 'utf8') : null;
  const expectedStatus = `?? ${CODEX_WORKER_QUALIFICATION_EXPECTED_FILE}\n`;
  return Object.freeze({
    ok: head === baseSha && status === expectedStatus && content === CODEX_WORKER_QUALIFICATION_EXPECTED_CONTENT,
    headUnchanged: head === baseSha,
    exactExpectedDiff: status === expectedStatus,
    exactExpectedContent: content === CODEX_WORKER_QUALIFICATION_EXPECTED_CONTENT,
  });
}

export function probeCodexWorkerVersion({
  codexPath,
  childEnv,
  execFileSyncFn = execFileSync,
} = {}) {
  try {
    const version = String(execFileSyncFn(codexPath, ['--version'], {
      env: childEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
      maxBuffer: 64 * 1024,
    }) || '').trim();
    return /^codex-cli [0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?$/.test(version)
      ? Object.freeze({ ok: true, version })
      : Object.freeze({ ok: false, reason: 'codex-version-unreadable' });
  } catch {
    return Object.freeze({ ok: false, reason: 'codex-version-probe-failed' });
  }
}

export function runCodexWorkerSandboxProbe({
  codexPath,
  cwd,
  childEnv,
  spawnSyncFn = spawnSync,
} = {}) {
  const probeName = '.agent-runner-codex-sandbox-probe';
  const probePath = join(cwd, probeName);
  rmSync(probePath, { force: true });

  const command = spawnSyncFn(codexPath, [
    'sandbox',
    '-c', 'sandbox_mode="workspace-write"',
    '-c', 'sandbox_workspace_write.network_access=false',
    '--',
    '/bin/true',
  ], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
    maxBuffer: 256 * 1024,
  });
  if (command.error || command.signal || command.status !== 0) {
    return Object.freeze({ ok: false, reason: 'codex-sandbox-command-failed' });
  }

  const write = spawnSyncFn(codexPath, [
    'sandbox',
    '-c', 'sandbox_mode="workspace-write"',
    '-c', 'sandbox_workspace_write.network_access=false',
    '--',
    '/bin/sh',
    '-c',
    `umask 077; printf '%s\\n' 'CODEX_SANDBOX_PROBE=PASS' > ${probeName}`,
  ], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
    maxBuffer: 256 * 1024,
  });
  if (write.error || write.signal || write.status !== 0) {
    rmSync(probePath, { force: true });
    return Object.freeze({ ok: false, reason: 'codex-sandbox-write-failed' });
  }
  const content = existsSync(probePath) ? readFileSync(probePath, 'utf8') : '';
  rmSync(probePath, { force: true });
  if (content !== 'CODEX_SANDBOX_PROBE=PASS\n') {
    return Object.freeze({ ok: false, reason: 'codex-sandbox-write-mismatch' });
  }
  const status = String(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }) || '');
  return status === ''
    ? Object.freeze({ ok: true })
    : Object.freeze({ ok: false, reason: 'codex-sandbox-probe-left-diff' });
}

export function invokeCodexWorkerCanary({
  codexPath,
  cwd,
  childEnv,
  spawnSyncFn = spawnSync,
} = {}) {
  const prompt = [
    `Create exactly one new file named ${CODEX_WORKER_QUALIFICATION_EXPECTED_FILE} in the repository root.`,
    `Its complete contents must be exactly: ${CODEX_WORKER_QUALIFICATION_EXPECTED_CONTENT.trim()}`,
    'Do not modify any other file. Do not commit, push, deploy, install packages, change settings, or alter Git configuration.',
    'When the file is correct, stop.',
  ].join(' ');
  const command = buildCodexWorkerCanaryArgs({ codexPath, cwd, prompt });
  const child = spawnSyncFn(command[0], command.slice(1), {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: MAX_BUFFER,
  });
  if (child.error || child.signal || child.status !== 0) {
    return classifyCodexExecutionError({
      timedOut: child.error?.code === 'ETIMEDOUT',
      cancelled: Boolean(child.signal),
      signal: child.signal,
      code: child.status,
    });
  }
  return parseCodexResultEnvelope(child.stdout);
}

function cleanupWorktree({
  sourceRepositoryPath,
  worktree,
  worktreeParent,
  branch,
  execFileSyncFn,
} = {}) {
  if (worktree && existsSync(worktree)) {
    execFileSyncFn('git', ['worktree', 'remove', worktree], {
      cwd: sourceRepositoryPath,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  }
  if (branch && runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: sourceRepositoryPath,
    execFileSyncFn,
    allowFailure: true,
  }) !== null) {
    execFileSyncFn('git', ['branch', '-d', branch], {
      cwd: sourceRepositoryPath,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  }
  if (worktreeParent) rmSync(worktreeParent, { recursive: true, force: true });
}

export async function executeCodexWorkerQualificationRequest({
  request,
  registry,
  executingNodeId,
  sourceRepositoryPath,
  worktreeRoot,
  stateRoot,
  codexPath = '/usr/local/bin/codex',
  env = process.env,
  clock = () => new Date(),
  execFileSyncFn = execFileSync,
  versionProbeFn = probeCodexWorkerVersion,
  quotaPreflightFn = runCodexQuotaPreflight,
  admissionFn = admitCodexDispatch,
  sandboxProbeFn = runCodexWorkerSandboxProbe,
  invokeCanaryFn = invokeCodexWorkerCanary,
  acquireSlotFn = acquireImplementationSlot,
} = {}) {
  const started = clock();
  const validation = validateCodexWorkerQualificationRequest({
    request,
    registry,
    executingNodeId,
    now: started,
  });
  if (!validation.valid) throw new Error(validation.reason);
  if (executingNodeId !== CODEX_WORKER_QUALIFICATION_TARGET_NODE) throw new Error('wrong-worker-node');

  const sourceRaw = String(sourceRepositoryPath || '').trim();
  const workRaw = String(worktreeRoot || '').trim();
  if (!sourceRaw) throw new Error('worker-source-repository-not-configured');
  if (!workRaw) throw new Error('qualification-worktree-root-not-configured');
  const sourceRoot = resolve(sourceRaw);
  const workRoot = resolve(workRaw);
  const stateFile = codexWorkerQualificationStatePath({
    stateRoot,
    jobFingerprint: request.job.jobFingerprint,
  });

  const existing = readState(stateFile);
  if (existing) {
    if (existing.jobFingerprint !== request.job.jobFingerprint) throw new Error('qualification-state-identity-mismatch');
    if (existing.status === 'completed' && existing.result) {
      return Object.freeze({ replay: true, result: Object.freeze(existing.result), providerInvoked: false });
    }
    throw new Error('qualification-authority-already-consumed');
  }

  if (runGit(['branch', '--show-current'], { cwd: sourceRoot, execFileSyncFn }) !== 'main') {
    throw new Error('worker-source-not-main');
  }
  if (runGit(['rev-parse', 'HEAD'], { cwd: sourceRoot, execFileSyncFn }) !== request.lease.baseSha) {
    throw new Error('worker-source-head-mismatch');
  }
  const sourceStatus = String(execFileSyncFn('git', ['status', '--porcelain'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }) || '');
  if (sourceStatus !== '') throw new Error('worker-source-dirty');
  const origin = runGit(['remote', 'get-url', 'origin'], { cwd: sourceRoot, execFileSyncFn });
  if (repositoryFromOrigin(origin) !== CODEX_WORKER_QUALIFICATION_REPOSITORY) {
    throw new Error('worker-source-repository-mismatch');
  }
  const resolvedBase = runGit(['rev-parse', `${request.lease.baseSha}^{commit}`], { cwd: sourceRoot, execFileSyncFn });
  if (resolvedBase !== request.lease.baseSha) throw new Error('worker-source-commit-unavailable');

  const childEnv = sanitizeCodexEnvironment(env);
  const versionProbe = versionProbeFn({ codexPath, childEnv, execFileSyncFn });
  if (!versionProbe?.ok) throw new Error(versionProbe?.reason || 'codex-version-probe-failed');

  const preflight = await quotaPreflightFn({
    executablePath: codexPath,
    env: childEnv,
    maxUsedPercent: 90,
  });
  if (!preflight?.allowed || preflight.resourceState?.blocked === true) {
    throw new Error(preflight?.reason || preflight?.resourceState?.reason || 'codex-quota-evidence-unavailable');
  }

  const admission = admissionFn({
    settings: {
      agentId: 'codex-cli',
      routable: true,
      reason: 'qualification-only',
      entry: { executablePath: codexPath },
    },
    resourceState: preflight.resourceState,
    accessFn: undefined,
    execFileFn: (file, fileArgs) => execFileSyncFn(file, fileArgs, {
      env: childEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  });
  if (!admission?.allowed) throw new Error(admission?.reason || 'codex-adapter-admission-failed');

  if (runGit(['show-ref', '--verify', '--quiet', `refs/heads/${request.lease.branch}`], {
    cwd: sourceRoot,
    execFileSyncFn,
    allowFailure: true,
  }) !== null) {
    throw new Error('qualification-branch-already-exists');
  }

  mkdirSync(workRoot, { recursive: true });
  const laneEnv = { ...env, [IMPLEMENTATION_LANE_ENV]: request.lease.laneId };
  const slot = acquireSlotFn({ env: laneEnv });
  if (!slot?.held) throw new Error(slot?.failureReason || 'implementation-slot-unavailable');

  let worktreeParent = null;
  let worktree = null;
  let preserveForensics = false;

  try {
    worktreeParent = mkdtempSync(join(workRoot, 'codex-qualification-'));
    worktree = join(worktreeParent, 'worktree');
    execFileSyncFn('git', ['worktree', 'add', '-b', request.lease.branch, worktree, request.lease.baseSha], {
      cwd: sourceRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    if (runGit(['rev-parse', 'HEAD'], { cwd: worktree, execFileSyncFn }) !== request.lease.baseSha) {
      throw new Error('qualification-worktree-head-mismatch');
    }
    const initialStatus = String(execFileSyncFn('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: worktree,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }) || '');
    if (initialStatus !== '') throw new Error('qualification-worktree-not-clean');

    const sandbox = sandboxProbeFn({
      codexPath,
      cwd: worktree,
      childEnv,
    });
    if (!sandbox?.ok) throw new Error(sandbox?.reason || 'codex-sandbox-preflight-failed');

    // One-shot consumption is durable immediately before the provider call.
    // Conservatively marking providerInvoked=true here means an unexpected
    // process-wrapper exception can never make the same authority retryable.
    writeState(stateFile, {
      schemaVersion: STATE_SCHEMA,
      jobFingerprint: request.job.jobFingerprint,
      leaseFingerprint: request.lease.leaseFingerprint,
      status: 'pending',
      providerInvoked: true,
    });

    const normalized = invokeCanaryFn({
      codexPath,
      cwd: worktree,
      childEnv,
    });

    const workspace = validateCodexWorkerCanaryWorkspace({
      cwd: worktree,
      baseSha: request.lease.baseSha,
      execFileSyncFn,
    });
    const parserMutationAgrees = normalized?.ok === true && normalized?.mutatedRepository === true;
    if (!parserMutationAgrees || !workspace.ok) {
      preserveForensics = true;
      const reason = normalized?.ok !== true
        ? safeReason(normalized?.reason, 'codex-canary-parser-failed')
        : !parserMutationAgrees
          ? 'codex-parser-mutation-disagreement'
          : 'codex-canary-workspace-validation-failed';
      writeState(stateFile, {
        schemaVersion: STATE_SCHEMA,
        jobFingerprint: request.job.jobFingerprint,
        leaseFingerprint: request.lease.leaseFingerprint,
        status: 'failed',
        providerInvoked: true,
        reason,
      });
      const completedAt = clock();
      return Object.freeze({
        replay: false,
        providerInvoked: true,
        result: buildCodexWorkerQualificationResult({
          request,
          status: 'failed',
          sourceSha: request.lease.baseSha,
          exitCode: 1,
          durationMs: Math.max(0, completedAt.getTime() - started.getTime()),
          failureReason: reason,
          completedAt: completedAt.toISOString(),
        }),
      });
    }

    rmSync(join(worktree, CODEX_WORKER_QUALIFICATION_EXPECTED_FILE));
    const cleanedStatus = String(execFileSyncFn('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: worktree,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }) || '');
    if (cleanedStatus !== '') {
      preserveForensics = true;
      throw new Error('qualification-cleanup-refused-dirty-worktree');
    }

    cleanupWorktree({
      sourceRepositoryPath: sourceRoot,
      worktree,
      worktreeParent,
      branch: request.lease.branch,
      execFileSyncFn,
    });
    worktree = null;
    worktreeParent = null;

    const completedAt = clock();
    const result = buildCodexWorkerQualificationResult({
      request,
      status: 'succeeded',
      sourceSha: request.lease.baseSha,
      exitCode: 0,
      durationMs: Math.max(0, completedAt.getTime() - started.getTime()),
      completedAt: completedAt.toISOString(),
      evidence: {
        schemaVersion: CODEX_WORKER_QUALIFICATION_SCHEMA_VERSION,
        codexVersion: versionProbe.version,
        authMode: preflight.authMode,
        primaryRemainingPercent: preflight.resourceState.primary?.remainingPercent,
        secondaryRemainingPercent: preflight.resourceState.secondary?.remainingPercent,
        model: CODEX_WORKER_QUALIFICATION_MODEL,
        profile: CODEX_WORKER_QUALIFICATION_PROFILE,
        effort: CODEX_WORKER_QUALIFICATION_EFFORT,
        sandboxMode: 'workspace-write',
        approvalMode: 'never',
        networkAccess: false,
        ephemeral: true,
        ignoreUserConfig: true,
        headUnchanged: workspace.headUnchanged,
        exactExpectedDiff: workspace.exactExpectedDiff,
        exactExpectedContent: workspace.exactExpectedContent,
        parserMutationAgrees,
        branchCleaned: true,
        worktreeCleaned: true,
        rawPromptPersisted: false,
        providerOutputPersisted: false,
        credentialMaterialPersisted: false,
        creditFieldsUsedForAdmission: false,
        normalCatalogueImplemented: AGENT_ADAPTERS['codex-cli'].implemented,
      },
    });

    writeState(stateFile, {
      schemaVersion: STATE_SCHEMA,
      jobFingerprint: request.job.jobFingerprint,
      leaseFingerprint: request.lease.leaseFingerprint,
      status: 'completed',
      providerInvoked: true,
      result,
    });

    return Object.freeze({ replay: false, providerInvoked: true, result });
  } catch (error) {
    const state = readState(stateFile);
    const providerInvoked = state?.providerInvoked === true;
    if (providerInvoked) {
      preserveForensics = true;
      writeState(stateFile, {
        schemaVersion: STATE_SCHEMA,
        jobFingerprint: request.job.jobFingerprint,
        leaseFingerprint: request.lease.leaseFingerprint,
        status: 'failed',
        providerInvoked: true,
        reason: safeReason(error?.message),
      });
      const completedAt = clock();
      return Object.freeze({
        replay: false,
        providerInvoked: true,
        result: buildCodexWorkerQualificationResult({
          request,
          status: 'failed',
          sourceSha: request.lease.baseSha,
          exitCode: 1,
          durationMs: Math.max(0, completedAt.getTime() - started.getTime()),
          failureReason: safeReason(error?.message),
          completedAt: completedAt.toISOString(),
        }),
      });
    }
    throw error;
  } finally {
    if (!preserveForensics && worktree && existsSync(worktree)) {
      try {
        cleanupWorktree({
          sourceRepositoryPath: sourceRoot,
          worktree,
          worktreeParent,
          branch: request.lease.branch,
          execFileSyncFn,
        });
      } catch {
        // Cleanup failure before provider launch leaves no one-shot state and
        // is surfaced by the original prelaunch exception. No reset/clean/
        // stash/rebase/force path exists here.
      }
    }
    slot.release();
  }
}
