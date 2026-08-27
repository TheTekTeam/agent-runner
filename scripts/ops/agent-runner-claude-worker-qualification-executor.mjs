import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

import { buildAgentCommandArgs, resolveAgentById } from './agent-runner-agents.mjs';
import { inspectClaudePromptCachePolicy } from './claude-runner-cache-policy.mjs';
import {
  buildClaudeProcessEnv,
  parseClaudeResultEnvelope,
  removedClaudeProviderAuthKeys,
} from './claude-runner.mjs';
import {
  buildImplementationToolPolicy,
  inspectClaudeCliHelp,
  inspectClaudeCliVersion,
  MINIMUM_IMPLEMENTATION_CLAUDE_VERSION,
} from './claude-runner-execution-policy.mjs';
import {
  evaluateProfileQuotaAdmission,
  parseQuotaCheckOutput,
} from './claude-runner-quota.mjs';
import {
  acquireImplementationSlot,
  IMPLEMENTATION_LANE_ENV,
} from './agent-runner-implementation-slot.mjs';
import {
  buildClaudeWorkerQualificationResult,
  CLAUDE_WORKER_QUALIFICATION_COMPLETION_SENTINEL,
  CLAUDE_WORKER_QUALIFICATION_EFFORT,
  CLAUDE_WORKER_QUALIFICATION_EXPECTED_CONTENT,
  CLAUDE_WORKER_QUALIFICATION_EXPECTED_FILE,
  CLAUDE_WORKER_QUALIFICATION_MODEL,
  CLAUDE_WORKER_QUALIFICATION_PERMISSION_MODE,
  CLAUDE_WORKER_QUALIFICATION_PROFILE,
  CLAUDE_WORKER_QUALIFICATION_REPOSITORY,
  CLAUDE_WORKER_QUALIFICATION_SCHEMA_VERSION,
  CLAUDE_WORKER_QUALIFICATION_SESSION_USAGE_THRESHOLD,
  CLAUDE_WORKER_QUALIFICATION_TARGET_NODE,
  validateClaudeWorkerQualificationRequest,
} from './agent-runner-claude-worker-qualification.mjs';

const STATE_SCHEMA = 'agent-runner-claude-worker-qualification-state/v1';
const MAX_BUFFER = 2 * 1024 * 1024;
const QUALIFICATION_PROFILE_NAME = 'narrow';

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

export function claudeWorkerQualificationStatePath({ stateRoot, jobFingerprint } = {}) {
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

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function claudeWorkerQualificationToolPolicy(branch) {
  const policy = buildImplementationToolPolicy({
    expectedBranch: branch,
    approvedBranch: branch,
    requiredCapabilities: [],
  });
  const fingerprint = `sha256:${createHash('sha256').update(stableStringify({
    tools: policy.tools,
    allowedTools: policy.allowedTools,
    disallowedTools: policy.disallowedTools,
    strictMcpConfig: policy.strictMcpConfig,
    disableSlashCommands: policy.disableSlashCommands,
    settings: policy.settings,
    settingSources: policy.settingSources,
  })).digest('hex')}`;
  return Object.freeze({ ...policy, fingerprint });
}

export function claudeWorkerCanaryProfile(branch) {
  const policy = claudeWorkerQualificationToolPolicy(branch);
  return Object.freeze({
    profile: QUALIFICATION_PROFILE_NAME,
    model: CLAUDE_WORKER_QUALIFICATION_MODEL,
    effort: CLAUDE_WORKER_QUALIFICATION_EFFORT,
    permissionMode: CLAUDE_WORKER_QUALIFICATION_PERMISSION_MODE,
    tools: policy.tools,
    allowedTools: policy.allowedTools,
    disallowedTools: policy.disallowedTools,
    strictMcpConfig: policy.strictMcpConfig,
    disableSlashCommands: policy.disableSlashCommands,
    settings: policy.settings,
    settingSources: policy.settingSources,
    toolPolicy: policy,
  });
}

export function claudeWorkerCanaryPrompt() {
  return [
    `Create exactly one new file named ${CLAUDE_WORKER_QUALIFICATION_EXPECTED_FILE} in the repository root.`,
    `Its complete contents must be exactly (including the trailing newline): ${JSON.stringify(CLAUDE_WORKER_QUALIFICATION_EXPECTED_CONTENT)}`,
    'Do not modify, rename, or delete any other file. Do not stage or commit anything.',
    'Do not run git push, gh, network, MCP, sudo, curl, wget, or any destructive command.',
    `When the file exists with the exact contents, print the single line ${CLAUDE_WORKER_QUALIFICATION_COMPLETION_SENTINEL} and stop.`,
  ].join(' ');
}

export function buildClaudeWorkerCanaryArgs({ branch, prompt, env } = {}) {
  return buildAgentCommandArgs({
    agent: resolveAgentById('claude-code-cli'),
    prompt: prompt || claudeWorkerCanaryPrompt(),
    profile: claudeWorkerCanaryProfile(branch),
    env,
    outputFormat: 'json',
  });
}

export function validateClaudeWorkerCanaryWorkspace({
  cwd,
  baseSha,
  execFileSyncFn = execFileSync,
} = {}) {
  const expectedPath = join(cwd, CLAUDE_WORKER_QUALIFICATION_EXPECTED_FILE);
  const head = runGit(['rev-parse', 'HEAD'], { cwd, execFileSyncFn });
  const status = String(execFileSyncFn('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: MAX_BUFFER,
  }) || '');
  const content = existsSync(expectedPath) ? readFileSync(expectedPath, 'utf8') : null;
  const expectedStatus = `?? ${CLAUDE_WORKER_QUALIFICATION_EXPECTED_FILE}\n`;
  return Object.freeze({
    ok: head === baseSha && status === expectedStatus && content === CLAUDE_WORKER_QUALIFICATION_EXPECTED_CONTENT,
    headUnchanged: head === baseSha,
    exactExpectedDiff: status === expectedStatus,
    exactExpectedContent: content === CLAUDE_WORKER_QUALIFICATION_EXPECTED_CONTENT,
  });
}

export function probeClaudeWorkerCli({
  claudePath,
  childEnv,
  execFileSyncFn = execFileSync,
} = {}) {
  const runOne = (args) => {
    try {
      const result = execFileSyncFn(claudePath, args, {
        env: childEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
        maxBuffer: 256 * 1024,
      });
      return { text: String(result || ''), exitCode: 0 };
    } catch (error) {
      return { text: `${error?.stdout || ''}${error?.stderr || ''}`, exitCode: Number.isInteger(error?.status) ? error.status : 1 };
    }
  };
  const versionOut = runOne(['--version']);
  const helpOut = runOne(['--help']);
  const version = inspectClaudeCliVersion(versionOut.text, { exitCode: versionOut.exitCode });
  const help = inspectClaudeCliHelp(helpOut.text, { exitCode: helpOut.exitCode });
  if (!version.compatible) {
    return Object.freeze({ ok: false, reason: version.failureReason || 'claude-version-incompatible' });
  }
  if (!help.compatible) {
    return Object.freeze({ ok: false, reason: 'claude-cli-help-incompatible' });
  }
  return Object.freeze({ ok: true, version: version.installedVersion, minimumVersion: MINIMUM_IMPLEMENTATION_CLAUDE_VERSION });
}

// Inherited first-party OAuth tokens are rejected too: qualification auth must be
// the machine-local worker login, never a token injected into the environment.
export const CLAUDE_WORKER_FORBIDDEN_AUTH_ENV_KEYS = Object.freeze(['CLAUDE_CODE_OAUTH_TOKEN']);

export function claudeWorkerForbiddenAuthEnvKeys(env = process.env) {
  const provider = removedClaudeProviderAuthKeys(env);
  const oauth = CLAUDE_WORKER_FORBIDDEN_AUTH_ENV_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(env, key));
  return [...provider, ...oauth];
}

export function sanitizeClaudeWorkerAuthEnv(env) {
  const next = { ...env };
  for (const key of CLAUDE_WORKER_FORBIDDEN_AUTH_ENV_KEYS) delete next[key];
  return next;
}

export function inspectClaudeWorkerFirstPartyAuth({
  claudePath = '/usr/bin/claude',
  env = process.env,
  home,
  childEnv,
  execFileSyncFn = execFileSync,
} = {}) {
  if (claudeWorkerForbiddenAuthEnvKeys(env).length > 0) {
    return Object.freeze({ ok: false, reason: 'claude-provider-auth-inheritance-forbidden' });
  }
  const root = String(home || env.HOME || '').trim();
  if (!root) return Object.freeze({ ok: false, reason: 'claude-worker-home-not-configured' });

  const statusEnv = sanitizeClaudeWorkerAuthEnv({
    ...(childEnv || buildClaudeProcessEnv(env)),
    HOME: root,
  });
  let text;
  try {
    text = String(execFileSyncFn(claudePath, ['auth', 'status', '--json'], {
      env: statusEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
      maxBuffer: 256 * 1024,
    }) || '');
  } catch (error) {
    text = `${error?.stdout || ''}${error?.stderr || ''}`;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return Object.freeze({ ok: false, reason: 'claude-auth-status-unparsed' });
  }
  if (!payload || typeof payload !== 'object' || payload.loggedIn !== true) {
    return Object.freeze({ ok: false, reason: 'claude-worker-logged-out' });
  }
  if (String(payload.authMethod || '') !== 'claude.ai') {
    return Object.freeze({ ok: false, reason: 'claude-worker-auth-method-unexpected' });
  }
  if (String(payload.apiProvider || '') !== 'firstParty') {
    return Object.freeze({ ok: false, reason: 'claude-worker-auth-provider-unexpected' });
  }
  return Object.freeze({
    ok: true,
    authMethod: 'claude.ai',
    providerClass: 'first-party',
  });
}

export function runClaudeWorkerQuotaPreflight({
  claudePath,
  childEnv,
  env = process.env,
  execFileSyncFn = execFileSync,
  now = new Date(),
} = {}) {
  let text;
  try {
    text = String(execFileSyncFn(claudePath, ['-p', '/usage', '--permission-mode', 'plan'], {
      env: childEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      maxBuffer: MAX_BUFFER,
    }) || '');
  } catch (error) {
    text = `${error?.stdout || ''}${error?.stderr || ''}`;
  }
  const parsed = parseQuotaCheckOutput(text, { now });
  const admission = evaluateProfileQuotaAdmission({
    quotaUsage: parsed.quotaUsage || null,
    status: parsed.status,
    profileName: QUALIFICATION_PROFILE_NAME,
    env,
  });
  return Object.freeze({
    allowed: admission.allowed === true,
    reason: admission.reason || (admission.allowed ? null : 'claude-quota-evidence-unavailable'),
    sessionUsedPercent: Number.isInteger(parsed.sessionPercentUsed) ? parsed.sessionPercentUsed : null,
    weeklyUsedPercent: Number.isInteger(parsed.weeklyPercentUsed) ? parsed.weeklyPercentUsed : null,
    threshold: CLAUDE_WORKER_QUALIFICATION_SESSION_USAGE_THRESHOLD,
  });
}

export function invokeClaudeWorkerCanary({
  claudePath,
  cwd,
  branch,
  childEnv,
  spawnSyncFn = spawnSync,
} = {}) {
  const args = buildClaudeWorkerCanaryArgs({ branch, env: childEnv });
  const child = spawnSyncFn(claudePath, args, {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
    maxBuffer: MAX_BUFFER,
  });
  if (child.error || child.signal || child.status !== 0) {
    return Object.freeze({
      ok: false,
      reason: child.error?.code === 'ETIMEDOUT' ? 'claude-canary-timed-out' : 'claude-canary-process-failed',
      sentinelObserved: false,
      hasSessionId: false,
    });
  }
  const envelope = parseClaudeResultEnvelope(child.stdout);
  const sentinelObserved = String(envelope.resultText || '').includes(CLAUDE_WORKER_QUALIFICATION_COMPLETION_SENTINEL);
  const ok = envelope.parsed === true && envelope.isError === false && sentinelObserved;
  return Object.freeze({
    ok,
    reason: ok ? null : (envelope.parsed !== true ? 'claude-canary-envelope-unparsed' : (!sentinelObserved ? 'claude-canary-sentinel-absent' : 'claude-canary-provider-error')),
    sentinelObserved,
    hasSessionId: envelope.hasSessionId === true,
  });
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

export async function executeClaudeWorkerQualificationRequest({
  request,
  registry,
  executingNodeId,
  sourceRepositoryPath,
  worktreeRoot,
  stateRoot,
  claudePath = '/usr/bin/claude',
  env = process.env,
  clock = () => new Date(),
  execFileSyncFn = execFileSync,
  cliProbeFn = probeClaudeWorkerCli,
  authProbeFn = inspectClaudeWorkerFirstPartyAuth,
  quotaPreflightFn = runClaudeWorkerQuotaPreflight,
  cachePolicyFn = inspectClaudePromptCachePolicy,
  invokeCanaryFn = invokeClaudeWorkerCanary,
  acquireSlotFn = acquireImplementationSlot,
} = {}) {
  const started = clock();
  const validation = validateClaudeWorkerQualificationRequest({
    request,
    registry,
    executingNodeId,
    now: started,
  });
  if (!validation.valid) throw new Error(validation.reason);
  if (executingNodeId !== CLAUDE_WORKER_QUALIFICATION_TARGET_NODE) throw new Error('wrong-worker-node');

  const sourceRaw = String(sourceRepositoryPath || '').trim();
  const workRaw = String(worktreeRoot || '').trim();
  if (!sourceRaw) throw new Error('worker-source-repository-not-configured');
  if (!workRaw) throw new Error('qualification-worktree-root-not-configured');
  const sourceRoot = resolve(sourceRaw);
  const workRoot = resolve(workRaw);
  const stateFile = claudeWorkerQualificationStatePath({
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
  if (repositoryFromOrigin(origin) !== CLAUDE_WORKER_QUALIFICATION_REPOSITORY) {
    throw new Error('worker-source-repository-mismatch');
  }
  const resolvedBase = runGit(['rev-parse', `${request.lease.baseSha}^{commit}`], { cwd: sourceRoot, execFileSyncFn });
  if (resolvedBase !== request.lease.baseSha) throw new Error('worker-source-commit-unavailable');

  const childEnv = sanitizeClaudeWorkerAuthEnv(buildClaudeProcessEnv(env));

  const cliProbe = cliProbeFn({ claudePath, childEnv, execFileSyncFn });
  if (!cliProbe?.ok) throw new Error(cliProbe?.reason || 'claude-version-probe-failed');

  const auth = authProbeFn({ claudePath, env, home: env.HOME, childEnv, execFileSyncFn });
  if (!auth?.ok) throw new Error(auth?.reason || 'claude-first-party-auth-failed');

  const quota = await quotaPreflightFn({ claudePath, childEnv, env, execFileSyncFn, now: started });
  if (!quota?.allowed) throw new Error(quota?.reason || 'claude-quota-evidence-unavailable');
  if (!Number.isInteger(quota.sessionUsedPercent) || quota.sessionUsedPercent >= CLAUDE_WORKER_QUALIFICATION_SESSION_USAGE_THRESHOLD) {
    throw new Error('claude-quota-threshold-exceeded');
  }

  const cachePolicy = cachePolicyFn({ model: CLAUDE_WORKER_QUALIFICATION_MODEL, env: childEnv });
  if (!cachePolicy?.enabled) throw new Error('claude-prompt-cache-disabled');

  const toolPolicy = claudeWorkerQualificationToolPolicy(request.lease.branch);

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
    worktreeParent = mkdtempSync(join(workRoot, 'claude-qualification-'));
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

    // One-shot consumption is durable immediately before the provider call.
    writeState(stateFile, {
      schemaVersion: STATE_SCHEMA,
      jobFingerprint: request.job.jobFingerprint,
      leaseFingerprint: request.lease.leaseFingerprint,
      status: 'pending',
      providerInvoked: true,
    });

    const normalized = invokeCanaryFn({
      claudePath,
      cwd: worktree,
      branch: request.lease.branch,
      childEnv,
    });

    const workspace = validateClaudeWorkerCanaryWorkspace({
      cwd: worktree,
      baseSha: request.lease.baseSha,
      execFileSyncFn,
    });
    const parserOk = normalized?.ok === true;
    const parserFilesystemAgree = parserOk === workspace.ok;
    if (!parserOk || !workspace.ok || !parserFilesystemAgree) {
      preserveForensics = true;
      const reason = !parserFilesystemAgree
        ? 'claude-parser-filesystem-disagreement'
        : !parserOk
          ? safeReason(normalized?.reason, 'claude-canary-parser-failed')
          : 'claude-canary-workspace-validation-failed';
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
        result: buildClaudeWorkerQualificationResult({
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

    rmSync(join(worktree, CLAUDE_WORKER_QUALIFICATION_EXPECTED_FILE));
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
    const result = buildClaudeWorkerQualificationResult({
      request,
      status: 'succeeded',
      sourceSha: request.lease.baseSha,
      exitCode: 0,
      durationMs: Math.max(0, completedAt.getTime() - started.getTime()),
      completedAt: completedAt.toISOString(),
      evidence: {
        schemaVersion: CLAUDE_WORKER_QUALIFICATION_SCHEMA_VERSION,
        claudeVersion: cliProbe.version,
        authMethod: auth.authMethod,
        providerClass: auth.providerClass,
        sessionUsedPercent: quota.sessionUsedPercent,
        weeklyUsedPercent: Number.isInteger(quota.weeklyUsedPercent) ? quota.weeklyUsedPercent : quota.sessionUsedPercent,
        model: CLAUDE_WORKER_QUALIFICATION_MODEL,
        profile: CLAUDE_WORKER_QUALIFICATION_PROFILE,
        effort: CLAUDE_WORKER_QUALIFICATION_EFFORT,
        permissionMode: CLAUDE_WORKER_QUALIFICATION_PERMISSION_MODE,
        promptCacheEnabled: cachePolicy.enabled === true,
        toolPolicyAllowedRuleCount: toolPolicy.allowedTools.length,
        toolPolicyDisallowedRuleCount: toolPolicy.disallowedTools.length,
        toolPolicyFingerprint: toolPolicy.fingerprint,
        settingSourcesEmpty: toolPolicy.settingSources === '',
        headUnchanged: workspace.headUnchanged,
        exactExpectedDiff: workspace.exactExpectedDiff,
        exactExpectedContent: workspace.exactExpectedContent,
        parserCompletionSentinelObserved: normalized.sentinelObserved === true,
        parserFilesystemAgree,
        branchCleaned: true,
        worktreeCleaned: true,
        rawPromptPersisted: false,
        providerOutputPersisted: false,
        sessionIdPersisted: false,
        credentialMaterialPersisted: false,
        creditFieldsUsedForAdmission: false,
        normalRoutingEnabled: false,
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
        result: buildClaudeWorkerQualificationResult({
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
        // Pre-provider cleanup failure leaves no one-shot state and is
        // surfaced by the original prelaunch exception.
      }
    }
    slot.release();
  }
}
