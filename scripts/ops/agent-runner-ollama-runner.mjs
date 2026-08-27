#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  assertProjectScopedEnv,
  loadAgentRunnerConfig,
  resolveConfigPath,
  stripConfigArgs,
} from './agent-runner-config.mjs';
import {
  computeSettingsRevision,
  isAgentRoutable,
  normalizeAgentLifecycle,
  normalizeAgentQualification,
  resolveAgentSettingsPath,
} from './agent-runner-agent-settings.mjs';
import {
  MANAGER_PREFLIGHT_ALREADY_CLAIMED,
  managerAuthorityApprovesAgent,
  managerAuthorityKeyIsCurrent,
  resolveCurrentManagerAuthority,
  resolveManagerPreflightExecutionMetadata,
  resolveManagerPreflightRequiredCapabilities,
} from './agent-runner-manager-authority.mjs';
import { assessQualification, classifyIssueTaskRisk } from './agent-runner-qualification.mjs';
import {
  OLLAMA_AGENT_ID,
  QUALIFIED_OLLAMA_CODING_MODEL,
  QUALIFIED_OPENCODE_VERSION,
  QUALIFIED_OLLAMA_VERSION,
  admitOllamaDispatch,
  buildOpenCodeCommandArgs,
  buildOpenCodeLocalOllamaConfig,
  parseOpenCodeResultEnvelope,
  resolveOllamaEndpoint,
} from './agent-runner-ollama-adapter.mjs';
import {
  buildBoundedOllamaToolPermission,
  classifyBoundedOllamaShellCommand,
  isShellTrustedRepository,
} from './agent-runner-ollama-shell-policy.mjs';
import {
  buildBoundedOllamaCodingPrompt,
  changedPathsFromPorcelainZ,
  resolveBoundedOllamaManagerContract,
} from './agent-runner-ollama-worker-contract.mjs';
import { acquireImplementationSlot } from './agent-runner-implementation-slot.mjs';
import {
  EXECUTION_PHASE_IMPLEMENTATION,
  assertConfiguredRepositoryIdentity,
  collectImplementationEvidence,
  fetchIssueAndComments,
  implementationProcessCwd,
  prepareImplementationWorkspace,
  publishImplementationDraft,
  resolveImplementationDispatchIdentity,
} from './claude-runner.mjs';
import { redactSensitiveText } from './lib/redact.mjs';

const DEFAULT_OUTPUT_DIR = '.var/ollama-runner';
const PROVIDER_TIMEOUT_MS = 180000;
const MAX_PROVIDER_BYTES = 8 * 1024 * 1024;
const FORBIDDEN_TASK_CLASSES = new Set([
  'security', 'auth', 'authentication', 'authorization', 'billing',
  'database-migration', 'migration', 'deployment', 'deploy',
  'architecture', 'broad-architecture',
]);

function boundedText(value, max = 48000) {
  const text = String(value || '');
  return text.length <= max ? text : text.slice(0, max) + '\n[truncated]';
}

export function parseOllamaRunnerArgs(argv = process.argv.slice(2), { defaultRepo = null } = {}) {
  const args = { repo: defaultRepo, outputDir: DEFAULT_OUTPUT_DIR, execute: false, issue: null, model: null, attemptId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(arg + ' requires a value');
      i += 1;
      return value;
    };
    if (arg === '--execute') args.execute = true;
    else if (arg === '--dry-run') args.execute = false;
    else if (arg === '--issue') args.issue = Number.parseInt(next(), 10);
    else if (arg === '--repo') args.repo = next();
    else if (arg === '--output-dir') args.outputDir = next();
    else if (arg === '--model') args.model = next();
    else if (arg === '--attempt-id') args.attemptId = next();
    else if (arg === '--recovery-mode' || arg === '--resume-session') throw new Error('ollama-live-recovery-not-qualified');
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error('Unknown argument: ' + arg);
  }
  if (args.help) return args;
  if (!Number.isInteger(args.issue) || args.issue <= 0) throw new Error('--issue must be a positive integer');
  if (!args.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo)) throw new Error('--repo must be owner/repo');
  if (args.model !== QUALIFIED_OLLAMA_CODING_MODEL) throw new Error('ollama-model-not-qualified-for-live-runner');
  return args;
}

function readExactSettings(env) {
  const settingsPath = resolveAgentSettingsPath(env);
  if (!existsSync(settingsPath)) throw new Error('ollama-settings-missing');
  const bytes = readFileSync(settingsPath, 'utf8');
  const revision = computeSettingsRevision(bytes);
  let document;
  try { document = JSON.parse(bytes); } catch { throw new Error('ollama-settings-malformed-json'); }
  const entry = document?.agents?.[OLLAMA_AGENT_ID];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('ollama-settings-entry-missing');
  const lifecycle = normalizeAgentLifecycle(entry);
  return {
    settingsPath, revision, entry, lifecycle,
    routable: isAgentRoutable(lifecycle),
    qualification: normalizeAgentQualification(OLLAMA_AGENT_ID, entry),
  };
}

function settingsCurrent(settings) {
  try {
    return computeSettingsRevision(readFileSync(settings.settingsPath, 'utf8')) === settings.revision;
  } catch { return false; }
}

export function modelEnv(env, endpointHost, root, configContent) {
  const next = {};
  for (const key of ['PATH','LANG','LC_ALL','NODE_ENV','PNPM_HOME']) {
    if (typeof env[key] === 'string') next[key] = env[key];
  }

  const home = join(root, 'model-home');
  const temp = join(root, 'tmp');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(temp, { recursive: true, mode: 0o700 });

  next.HOME = home;
  next.TMPDIR = temp;
  next.TMP = temp;
  next.TEMP = temp;
  next.GIT_CONFIG_GLOBAL = '/dev/null';
  next.OPENCODE_CONFIG_CONTENT = configContent;
  next.OPENCODE_DISABLE_AUTOUPDATE = '1';
  next.XDG_CONFIG_HOME = join(root, 'config');
  next.XDG_CACHE_HOME = join(root, 'cache');
  next.XDG_DATA_HOME = join(root, 'data');
  next.XDG_STATE_HOME = join(root, 'state');
  next.HTTP_PROXY = 'http://127.0.0.1:9';
  next.HTTPS_PROXY = 'http://127.0.0.1:9';
  next.ALL_PROXY = 'http://127.0.0.1:9';
  next.NO_PROXY = ['127.0.0.1','localhost','::1',endpointHost].filter(Boolean).join(',');
  return next;
}

function validationEnv(env, root) {
  const out = { CI: 'true' };
  for (const key of ['PATH','LANG','LC_ALL','NODE_ENV','PNPM_HOME']) {
    if (typeof env[key] === 'string') out[key] = env[key];
  }
  const home = join(root, 'validation-home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  out.HOME = home;
  return out;
}

async function inventoryDigest(endpointUrl) {
  const response = await fetch(new URL('/api/tags', endpointUrl).toString(), { method: 'GET' });
  if (!response?.ok) throw new Error('ollama-inventory-unavailable');
  const payload = await response.json();
  const names = Array.isArray(payload?.models)
    ? payload.models.map((x) => String(x?.name || x?.model || '')).filter(Boolean).sort()
    : [];
  return createHash('sha256').update(JSON.stringify(names)).digest('hex');
}

function runGit(cwd, args, env) {
  return spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, shell: false });
}

function gitText(cwd, args, env) {
  const result = runGit(cwd, args, env);
  if (result.status !== 0 || result.error) throw new Error('ollama-git-evidence-failed');
  return String(result.stdout || '');
}

export function changedPathsFromWorktree(cwd, env = process.env) {
  if (gitText(cwd, ['diff','--cached','--name-only','-z'], env)) throw new Error('ollama-model-staged-changes-refused');
  return changedPathsFromPorcelainZ(gitText(cwd, ['status','--porcelain=v1','-z','--untracked-files=all'], env));
}

function safeTarget(cwd, filePath) {
  const root = resolve(cwd);
  const target = resolve(root, filePath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('ollama-target-path-escape');
  if (!existsSync(target)) throw new Error('ollama-target-file-missing');
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ollama-target-file-not-regular');
}

function requireOnlyTarget(cwd, filePath, env) {
  const paths = changedPathsFromWorktree(cwd, env);
  if (paths.length !== 1 || paths[0] !== filePath) {
    throw new Error(paths.length ? 'ollama-out-of-scope-repository-mutation' : 'implementation-no-repository-change');
  }
  safeTarget(cwd, filePath);
}

function validationDecisions(commands, repository, entry) {
  return commands.map((command) => {
    const decision = classifyBoundedOllamaShellCommand(command, {
      repository,
      trustedRepositories: entry.shellTrustedRepositories,
      managerValidationCommands: commands,
      machineCommandAllowlist: entry.commandAllowlist,
    });
    if (!decision.allowed) throw new Error(decision.reason || 'ollama-shell-command-denied');
    return decision;
  });
}

function runValidations(decisions, cwd, root, env) {
  const before = gitText(cwd, ['status','--porcelain=v1','-z','--untracked-files=all'], env);
  const results = [];
  for (const decision of decisions) {
    const result = spawnSync(decision.argv[0], decision.argv.slice(1), {
      cwd, env: validationEnv(env, root), encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024, timeout: 15 * 60000, shell: false,
    });
    results.push({ command: decision.command, exitCode: result.status, signal: result.signal || null });
    if (result.status !== 0 || result.error) throw new Error('ollama-required-validation-failed');
  }
  const check = runGit(cwd, ['diff','--no-ext-diff','--check'], env);
  if (check.status !== 0 || check.error) throw new Error('ollama-git-diff-check-failed');
  const after = gitText(cwd, ['status','--porcelain=v1','-z','--untracked-files=all'], env);
  if (before !== after) throw new Error('ollama-validation-mutated-worktree');
  return results;
}

function harnessCommit(cwd, issue, filePath, env) {
  let result = runGit(cwd, ['add','--',filePath], env);
  if (result.status !== 0 || result.error) throw new Error('ollama-harness-git-add-failed');
  result = runGit(cwd, ['commit','--no-verify','-m','#' + issue + ' Ollama implementation'], env);
  if (result.status !== 0 || result.error) throw new Error('ollama-harness-git-commit-failed');
}

function emit(outputDir, issue, payload) {
  mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(outputDir, 'ollama-issue-' + issue + '-' + stamp + '.json');
  writeFileSync(logPath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...payload, providerOutput: payload.providerOutput ? '<see log>' : undefined, logPath }, null, 2));
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const configPath = resolveConfigPath(argv, env);
  const config = loadAgentRunnerConfig({ argv, env, configPath });
  assertProjectScopedEnv({ config, configPath, env });
  const args = parseOllamaRunnerArgs(stripConfigArgs(argv), {
    defaultRepo: configPath ? config.githubRepo : (env.GITHUB_REPOSITORY || config.githubRepo),
  });
  assertConfiguredRepositoryIdentity({ configPath, config, repo: args.repo });
  if (args.help) return 0;

  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) throw new Error('Missing GITHUB_TOKEN or GH_TOKEN environment variable');

  const base = {
    issue: args.issue, repo: args.repo, executionPhase: EXECUTION_PHASE_IMPLEMENTATION,
    agent: { agentId: OLLAMA_AGENT_ID, agentType: 'ollama', implemented: true, model: QUALIFIED_OLLAMA_CODING_MODEL, effort: null },
    agentId: OLLAMA_AGENT_ID, agentType: 'ollama', model: QUALIFIED_OLLAMA_CODING_MODEL,
    costAdmission: { allowed: true, policy: 'free-local-qualified' },
    usageAccounting: { provider: 'ollama-local', paid: false, costUsd: 0 },
  };

  let slot = { release: () => {} };
  let workspace = null;
  let dispatchIdentity = null;
  let providerResult = null;
  let runtimeRoot = null;

  try {
    const { issue, comments } = await fetchIssueAndComments({ repo: args.repo, issue: args.issue, token });
    const manager = resolveCurrentManagerAuthority(comments);
    if (!manager.allowed && !(manager.reason === MANAGER_PREFLIGHT_ALREADY_CLAIMED && manager.authority)) {
      throw new Error(manager.reason || 'manager-preflight-required');
    }
    const authority = manager.authority;
    if (!managerAuthorityApprovesAgent(authority, OLLAMA_AGENT_ID)) throw new Error('manager-agent-mismatch');
    if (authority.executionPhase !== EXECUTION_PHASE_IMPLEMENTATION) throw new Error('ollama-implementation-not-authorized');

    const metadata = resolveManagerPreflightExecutionMetadata(authority.comment);
    if (metadata.model !== QUALIFIED_OLLAMA_CODING_MODEL) throw new Error('ollama-manager-model-mismatch');
    const capabilities = resolveManagerPreflightRequiredCapabilities(authority.comment);
    if (!capabilities.valid || capabilities.capabilities.length) throw new Error('ollama-required-capabilities-unsupported');

    const contract = resolveBoundedOllamaManagerContract(authority.comment);
    if (!contract.ok) throw new Error(contract.reason);

    const settings = readExactSettings(env);
    if (!settings.routable) throw new Error('ollama-agent-not-routable');
    if (!settings.entry.installedModelAllowlist?.includes(QUALIFIED_OLLAMA_CODING_MODEL)) throw new Error('ollama-model-not-allowlisted');
    if (!isShellTrustedRepository(args.repo, settings.entry.shellTrustedRepositories)) throw new Error('ollama-shell-repository-not-trusted');

    const classification = classifyIssueTaskRisk(issue);
    if (classification.conflicts?.length) throw new Error('ollama-issue-classification-conflict');
    if (FORBIDDEN_TASK_CLASSES.has(classification.taskClass)) throw new Error('ollama-task-class-forbidden');
    const qualification = assessQualification({ agentId: OLLAMA_AGENT_ID, qualification: settings.qualification, classification });
    if (!qualification.qualified) throw new Error(qualification.reasons[0] || 'ollama-not-qualified');

    const decisions = validationDecisions(contract.validationCommands, args.repo, settings.entry);

    dispatchIdentity = resolveImplementationDispatchIdentity({
      issue, command: null, currentPreflight: authority.comment,
      config: { githubRepo: config.githubRepo, localRepoPath: config.localRepoPath },
      env, argsRepo: args.repo,
    });
    if (!dispatchIdentity.ok) throw new Error(dispatchIdentity.failureReason);
    if (dispatchIdentity.executionAuthorization?.phase !== EXECUTION_PHASE_IMPLEMENTATION
      || dispatchIdentity.executionAuthorization?.allowed !== true) throw new Error('ollama-implementation-not-authorized');

    const endpoint = resolveOllamaEndpoint(settings.entry);
    if (!endpoint.ok) throw new Error(endpoint.reason);
    const openCodeBin = String(settings.entry.executablePath || '').trim();
    if (!isAbsolute(openCodeBin)) throw new Error('ollama-executable-path-not-absolute');
    accessSync(openCodeBin, fsConstants.X_OK);

    const admission = await admitOllamaDispatch({
      env, model: QUALIFIED_OLLAMA_CODING_MODEL,
      settings: { agentId: OLLAMA_AGENT_ID, routable: true, reason: 'agent-routable', entry: settings.entry },
      accessFn: accessSync,
      execFileFn: (file, commandArgs) => execFileSync(file, commandArgs, { encoding: 'utf8', timeout: 5000, env }),
      fetchFn: fetch,
      requiredExecutableVersion: QUALIFIED_OPENCODE_VERSION,
      requiredOllamaVersion: QUALIFIED_OLLAMA_VERSION,
    });
    if (!admission.allowed) throw new Error(admission.reason || 'ollama-admission-refused');

    const openCode = JSON.parse(buildOpenCodeLocalOllamaConfig({
      model: QUALIFIED_OLLAMA_CODING_MODEL,
      endpointUrl: endpoint.url,
      endpointAllowlistHosts: settings.entry.endpointAllowlistHosts,
      disableReasoning: true,
    }));
    openCode.permission = buildBoundedOllamaToolPermission({
      filePath: contract.filePath, repository: args.repo,
      trustedRepositories: settings.entry.shellTrustedRepositories,
      managerValidationCommands: contract.validationCommands,
      machineCommandAllowlist: settings.entry.commandAllowlist,
    });
    const allowedCommands = Object.entries(openCode.permission.bash).filter(([,v]) => v === 'allow').map(([k]) => k);
    const prompt = buildBoundedOllamaCodingPrompt({ filePath: contract.filePath, task: contract.task, allowedCommands });

    if (!args.execute) {
      emit(args.outputDir, args.issue, {
        ...base, dryRun: true, blocked: false,
        sourcePreflightCommentIdentity: authority.commentIdentity,
        sourcePreflightCommentId: authority.commentRevision,
        worktreeIdentity: dispatchIdentity.worktreeIdentity,
        settingsRevision: settings.revision,
        targetFile: contract.filePath,
        requiredValidation: contract.validationCommands,
        shellCommands: allowedCommands,
      });
      return 0;
    }

    slot = acquireImplementationSlot({ env });
    if (!slot.held) throw new Error(slot.failureReason || 'implementation-slot-unavailable');
    workspace = prepareImplementationWorkspace({
      worktreeIdentity: dispatchIdentity.worktreeIdentity,
      implementationCheckout: dispatchIdentity.repositoryContext?.implementationCheckout,
      env,
    });
    if (!workspace.allowed) throw new Error(workspace.failureReason || 'implementation-workspace-policy-blocked');

    const cwd = implementationProcessCwd(workspace);
    safeTarget(cwd, contract.filePath);
    if (changedPathsFromWorktree(cwd, env).length) throw new Error('ollama-worktree-not-clean-before-model');

    runtimeRoot = mkdtempSync(join(tmpdir(), 'agent-runner-ollama-live-'));
    const inventoryBefore = await inventoryDigest(endpoint.url);
    const commandArgs = buildOpenCodeCommandArgs({
      executablePath: openCodeBin, model: QUALIFIED_OLLAMA_CODING_MODEL,
      workingDirectory: cwd, prompt,
    });
    const startedAt = new Date().toISOString();
    const result = spawnSync(commandArgs[0], commandArgs.slice(1), {
      cwd, env: modelEnv(env, endpoint.hostname, runtimeRoot, JSON.stringify(openCode)),
      encoding: 'utf8', maxBuffer: MAX_PROVIDER_BYTES, timeout: PROVIDER_TIMEOUT_MS, shell: false,
    });
    const finishedAt = new Date().toISOString();
    if (result.error?.code === 'ETIMEDOUT') throw new Error('ollama-timeout');
    if (result.status !== 0 || result.error) throw new Error('ollama-opencode-exit-' + (result.status ?? 'unknown'));

    providerResult = parseOpenCodeResultEnvelope(result.stdout || '', {
      agentId: OLLAMA_AGENT_ID, model: QUALIFIED_OLLAMA_CODING_MODEL,
    });
    if (!providerResult.ok) throw new Error(providerResult.reason || 'ollama-invalid-output');

    requireOnlyTarget(cwd, contract.filePath, env);
    const validationResults = runValidations(decisions, cwd, runtimeRoot, env);
    requireOnlyTarget(cwd, contract.filePath, env);

    if (await inventoryDigest(endpoint.url) !== inventoryBefore) throw new Error('ollama-model-inventory-changed');
    if (!settingsCurrent(settings)) throw new Error('settings-revision-changed-before-commit');
    harnessCommit(cwd, args.issue, contract.filePath, env);

    let evidence = collectImplementationEvidence({ workspace, worktreeIdentity: dispatchIdentity.worktreeIdentity });
    if (!evidence.valid) throw new Error(evidence.failureReason || 'implementation-evidence-invalid');

    const latest = await fetchIssueAndComments({ repo: args.repo, issue: args.issue, token });
    if (!managerAuthorityKeyIsCurrent(latest.comments, authority.authorityKey, authority.packetDigest)) {
      throw new Error('manager-authority-changed-before-publication');
    }
    if (!settingsCurrent(settings)) throw new Error('settings-revision-changed-before-publication');
    if (await inventoryDigest(endpoint.url) !== inventoryBefore) throw new Error('ollama-model-inventory-changed');

    const publication = publishImplementationDraft({
      workspace, worktreeIdentity: dispatchIdentity.worktreeIdentity,
      repo: dispatchIdentity.repositoryContext?.implementationRepository || args.repo,
      issueNumber: args.issue, issueTitle: issue.title, env,
    });
    if (!publication.published) {
      evidence = { ...evidence, valid: false, failureReason: publication.failureReason || 'implementation-draft-publication-failed' };
      throw new Error(evidence.failureReason);
    }

    emit(args.outputDir, args.issue, {
      ...base, dryRun: false, blocked: false, failureReason: null,
      executionNoop: false, awaitingPlanApproval: false, startedAt, finishedAt,
      sourcePreflightCommentIdentity: authority.commentIdentity,
      sourcePreflightCommentId: authority.commentRevision,
      executionAuthorization: dispatchIdentity.executionAuthorization,
      worktreeIdentity: dispatchIdentity.worktreeIdentity,
      implementationEvidence: evidence, implementationPublication: publication,
      settingsRevision: settings.revision, targetFile: contract.filePath,
      requiredValidation: validationResults, shellCommands: allowedCommands,
      providerOutput: redactSensitiveText(boundedText(providerResult.resultText || '')),
      usageAccounting: { provider: 'ollama-local', paid: false, costUsd: 0, usageEfficiency: providerResult.usageEfficiency },
      checkpointAvailable: Boolean(evidence.worktree?.head), sessionAvailable: false,
      recoveryEvidence: { sameProfileAvailable: false, policyApproved: false, deterministicValidationFailure: false },
      restrictedRecoveryHandleDigest: null, restrictedHandleBindingDigest: null,
    });
    return 0;
  } catch (error) {
    const evidence = workspace?.allowed && dispatchIdentity?.worktreeIdentity
      ? collectImplementationEvidence({ workspace, worktreeIdentity: dispatchIdentity.worktreeIdentity })
      : null;
    const reason = String(error?.message || error || 'ollama-runner-failed').slice(0, 160);
    emit(args.outputDir, args.issue || 0, {
      ...base, dryRun: false, blocked: true, reason, failureReason: reason,
      executionNoop: false, awaitingPlanApproval: false,
      sourcePreflightCommentIdentity: dispatchIdentity?.sourcePreflightCommentIdentity || null,
      sourcePreflightCommentId: dispatchIdentity?.sourcePreflightCommentIdentity?.databaseId || null,
      executionAuthorization: dispatchIdentity?.executionAuthorization || null,
      worktreeIdentity: dispatchIdentity?.worktreeIdentity || null,
      implementationEvidence: evidence,
      checkpointAvailable: Boolean(evidence?.worktree?.head),
      providerOutput: providerResult?.resultText ? redactSensitiveText(boundedText(providerResult.resultText)) : '',
      usageAccounting: { provider: 'ollama-local', paid: false, costUsd: 0, usageEfficiency: providerResult?.usageEfficiency || null },
      sessionAvailable: false,
      recoveryEvidence: { sameProfileAvailable: false, policyApproved: false, deterministicValidationFailure: false },
    });
    return 1;
  } finally {
    if (runtimeRoot) {
      try { rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
    }
    slot.release();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://' + process.cwd() + '/').href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
