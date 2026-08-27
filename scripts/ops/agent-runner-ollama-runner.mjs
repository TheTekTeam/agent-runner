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
  normalizeAgentRuntimeModel,
  resolveAgentSettingsPath,
} from './agent-runner-agent-settings.mjs';
import {
  MANAGER_PREFLIGHT_ALREADY_CLAIMED,
  managerAuthorityApprovesAgent,
  managerAuthorityKeyIsCurrent,
  resolveCurrentManagerAuthority,
  resolveManagerPreflightAllowedPaths,
  resolveManagerPreflightRequiredCapabilities,
  resolveManagerPreflightRequiredValidation,
} from './agent-runner-manager-authority.mjs';
import {
  assessQualification,
  classifyIssueTaskRisk,
} from './agent-runner-qualification.mjs';
import {
  DEFAULT_OLLAMA_CODING_SHELL_ALLOWLIST,
  OLLAMA_AGENT_ID,
  admitOllamaDispatch,
  buildOpenCodeCodingLocalOllamaConfig,
  buildOpenCodeCommandArgs,
  isSafeOllamaShellPattern,
  parseOpenCodeResultEnvelope,
  resolveOllamaEndpoint,
} from './agent-runner-ollama-adapter.mjs';
import { acquireImplementationSlot } from './agent-runner-implementation-slot.mjs';
import { executionLabelAuthority } from './agent-runner-label-authority.mjs';
import { resolveAgentForLabels } from './agent-runner-agents.mjs';
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

export const OLLAMA_RUNNER_EXPECTED_OPENCODE_VERSION = '1.18.4';
export const OLLAMA_RUNNER_EXPECTED_OLLAMA_VERSION = '0.32.1';
export const OLLAMA_RUNNER_TIMEOUT_MS = 180_000;

const MAX_PROMPT_CHARS = 120_000;
const MAX_ALLOWED_PATHS = 64;
const MAX_VALIDATION_COMMANDS = 32;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const PATH_PATTERN = /^[A-Za-z0-9._*?/-]{1,512}$/;
const VALIDATION_METACHARACTERS = /[;&|><\`$(){}\n\r]/;
const CLOUD_OR_REMOTE_AUTH_KEYS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'SSH_AUTH_SOCK',
]);
const VALIDATION_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'NODE_ENV', 'PNPM_HOME',
]);

function issueLabels(issue = {}) {
  return (issue.labels || []).map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean);
}

export function parseOllamaRunnerArgs(argv = process.argv.slice(2), {
  defaultRepo = process.env.GITHUB_REPOSITORY || null,
} = {}) {
  const args = {
    repo: defaultRepo,
    outputDir: '.var/ollama-runner',
    execute: false,
    issue: null,
    model: null,
    attemptId: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--execute') args.execute = true;
    else if (arg === '--dry-run') args.execute = false;
    else if (arg === '--issue') args.issue = Number.parseInt(next(), 10);
    else if (arg === '--repo') args.repo = next();
    else if (arg === '--output-dir') args.outputDir = next();
    else if (arg === '--model') args.model = next();
    else if (arg === '--attempt-id') args.attemptId = next();
    else if (arg === '--recovery-mode' || arg === '--resume-session') {
      throw new Error('ollama-live-recovery-not-qualified');
    } else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!Number.isInteger(args.issue) || args.issue <= 0) throw new Error('--issue must be a positive integer');
  if (!args.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo)) throw new Error('--repo must be owner/repo');
  if (!MODEL_PATTERN.test(String(args.model || ''))) throw new Error('--model must be an explicit bounded model id');
  return args;
}

export function printOllamaRunnerHelp() {
  console.log(`Local Ollama implementation runner

Usage:
  node scripts/ops/agent-runner-ollama-runner.mjs --issue <number> --model <model> [--execute]

The live coding route is implementation-only, low-risk, worktree-scoped and
machine-local. Ollama/OpenCode receives no cloud credentials, external-directory
authority, destructive Git, package-install/download, push/merge, or unrestricted
shell. Recovery is not qualified in v1 and fails closed.
`);
}

function readExactSettings(env = process.env) {
  const settingsPath = resolveAgentSettingsPath(env);
  if (!existsSync(settingsPath)) throw new Error('ollama-settings-missing');
  const exactBytes = readFileSync(settingsPath, 'utf8');
  const revision = computeSettingsRevision(exactBytes);
  let parsed;
  try {
    parsed = JSON.parse(exactBytes);
  } catch {
    throw new Error('ollama-settings-malformed-json');
  }
  const entry = parsed?.agents?.[OLLAMA_AGENT_ID];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('ollama-settings-entry-missing');
  const lifecycle = normalizeAgentLifecycle(entry);
  return {
    settingsPath,
    revision,
    entry,
    lifecycle,
    routable: isAgentRoutable(lifecycle),
    qualification: normalizeAgentQualification(OLLAMA_AGENT_ID, entry),
    runtimeModel: normalizeAgentRuntimeModel(OLLAMA_AGENT_ID, entry),
  };
}

function settingsUnchanged(settings) {
  try {
    return computeSettingsRevision(readFileSync(settings.settingsPath, 'utf8')) === settings.revision;
  } catch {
    return false;
  }
}

function safePathPattern(value) {
  const path = String(value || '').trim();
  if (!path || !PATH_PATTERN.test(path) || isAbsolute(path)) return null;
  if (path === '..' || path.startsWith('../') || path.includes('/../')) return null;
  if (path === '.git' || path.startsWith('.git/') || path.includes('/.git/')) return null;
  return path;
}

export function normalizeAllowedPaths(values = []) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ALLOWED_PATHS) {
    return { valid: false, paths: [], reason: 'ollama-allowed-paths-invalid' };
  }
  const paths = values.map(safePathPattern);
  if (paths.some((path) => !path) || new Set(paths).size !== paths.length) {
    return { valid: false, paths: [], reason: 'ollama-allowed-paths-invalid' };
  }
  return { valid: true, paths, reason: null };
}

function escapeRegexChar(ch) {
  return /[.*+?^$()|\[\]{}\\]/.test(ch) ? `\\${ch}` : ch;
}

function globRegex(pattern) {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += escapeRegexChar(ch);
    }
  }
  return new RegExp(`${source}$`);
}

export function pathAllowed(path, patterns = []) {
  const normalized = safePathPattern(path);
  if (!normalized || normalized.includes('*') || normalized.includes('?')) return false;
  return patterns.some((pattern) => globRegex(pattern).test(normalized));
}

function readVersion(binary, env, expected, reason) {
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    env,
  });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const escaped = expected.replaceAll('.', '\\.');
  if (result.status !== 0 || !new RegExp(`(?:^|\\D)${escaped}(?:\\D|$)`).test(text)) {
    throw new Error(reason);
  }
  return expected;
}

function modelProcessEnv(env, endpointHostname, runtimeRoot, configContent) {
  const next = { ...env };
  for (const key of CLOUD_OR_REMOTE_AUTH_KEYS) delete next[key];
  next.OPENCODE_CONFIG_CONTENT = configContent;
  next.OPENCODE_DISABLE_AUTOUPDATE = '1';
  next.XDG_CONFIG_HOME = join(runtimeRoot, 'config');
  next.XDG_CACHE_HOME = join(runtimeRoot, 'cache');
  next.XDG_DATA_HOME = join(runtimeRoot, 'data');
  next.XDG_STATE_HOME = join(runtimeRoot, 'state');
  next.HTTP_PROXY = 'http://127.0.0.1:9';
  next.HTTPS_PROXY = 'http://127.0.0.1:9';
  next.ALL_PROXY = 'http://127.0.0.1:9';
  next.NO_PROXY = [...new Set(['127.0.0.1', 'localhost', '::1', endpointHostname].filter(Boolean))].join(',');
  return next;
}

function validationEnv(env) {
  const out = {};
  for (const key of VALIDATION_ENV_KEYS) {
    if (typeof env[key] === 'string') out[key] = env[key];
  }
  out.CI = 'true';
  return out;
}

function parseReviewedValidationCommand(command, changedPaths = []) {
  const original = String(command || '').trim();
  const placeholder = '<changed files>';
  const count = original.split(placeholder).length - 1;
  if (!original || count > 1) throw new Error('ollama-validation-command-invalid');
  const prepared = original.replace(placeholder, '__AGENT_RUNNER_CHANGED_FILES__');
  if (VALIDATION_METACHARACTERS.test(prepared) || /["']/.test(prepared)) {
    throw new Error('ollama-validation-command-unsupported-syntax');
  }
  const tokens = prepared.split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new Error('ollama-validation-command-invalid');
  const first = tokens[0];
  if (!['bash', 'node', 'npm', 'pnpm', 'yarn'].includes(first)) {
    throw new Error('ollama-validation-command-executable-not-allowed');
  }
  if ((first === 'bash' || first === 'node') && ['-c', '-e', '--eval', '--command'].some((flag) => tokens.includes(flag))) {
    throw new Error('ollama-validation-interpreter-escape-refused');
  }
  const result = [];
  for (const token of tokens) {
    if (token === '__AGENT_RUNNER_CHANGED_FILES__') result.push(...changedPaths);
    else result.push(token);
  }
  return result;
}

function reviewedModelShellAllowlist(config = {}) {
  const safeProjectCommands = (config.safeDefaultValidationCommands || [])
    .filter((command) => !String(command).includes('<changed files>'))
    .filter((command) => isSafeOllamaShellPattern(command));
  return [...new Set([...DEFAULT_OLLAMA_CODING_SHELL_ALLOWLIST, ...safeProjectCommands])];
}

function requiredValidations(preflight, config) {
  const required = resolveManagerPreflightRequiredValidation(preflight);
  if (!required.length || required.length > MAX_VALIDATION_COMMANDS) {
    throw new Error('ollama-required-validation-invalid');
  }
  const reviewed = new Set(config.safeDefaultValidationCommands || []);
  for (const command of required) {
    if (!reviewed.has(command)) throw new Error('ollama-required-validation-not-reviewed');
  }
  return required;
}

function gitResult(cwd, args, env = process.env) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    env,
  });
}

function gitText(cwd, args, env = process.env) {
  const result = gitResult(cwd, args, env);
  if (result.status !== 0) throw new Error('ollama-git-command-failed');
  return String(result.stdout || '');
}

function nulList(text) {
  return String(text || '').split('\0').filter(Boolean);
}

export function changedWorktreePaths(cwd, env = process.env) {
  const staged = nulList(gitText(cwd, ['diff', '--cached', '--name-only', '-z'], env));
  if (staged.length) throw new Error('ollama-model-staged-changes-refused');
  const tracked = nulList(gitText(cwd, ['diff', '--name-only', '-z'], env));
  const untracked = nulList(gitText(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], env));
  return [...new Set([...tracked, ...untracked])].sort();
}

function statusDigest(cwd, env) {
  const status = gitText(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], env);
  return createHash('sha256').update(status).digest('hex');
}

function assertChangedPathSafety(worktreePath, paths, allowedPatterns) {
  if (!paths.length) throw new Error('implementation-no-repository-change');
  for (const path of paths) {
    if (!pathAllowed(path, allowedPatterns)) throw new Error('ollama-out-of-scope-repository-mutation');
    const absolute = resolve(worktreePath, path);
    const rel = relative(resolve(worktreePath), absolute);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('ollama-path-escape');
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) throw new Error('ollama-symlink-mutation-refused');
  }
}

function runRequiredValidations(commands, changedPaths, cwd, env) {
  const before = statusDigest(cwd, env);
  const results = [];
  for (const command of commands) {
    const argv = parseReviewedValidationCommand(command, changedPaths);
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15 * 60_000,
      env: validationEnv(env),
      shell: false,
    });
    results.push({ command, exitCode: result.status, signal: result.signal || null });
    if (result.status !== 0 || result.error) throw new Error('ollama-required-validation-failed');
  }
  const diffCheck = gitResult(cwd, ['diff', '--check'], env);
  if (diffCheck.status !== 0) throw new Error('ollama-git-diff-check-failed');
  const after = statusDigest(cwd, env);
  if (before !== after) throw new Error('ollama-validation-mutated-worktree');
  return results;
}

function harnessCommit(cwd, issueNumber, changedPaths, env) {
  const add = gitResult(cwd, ['add', '--', ...changedPaths], env);
  if (add.status !== 0) throw new Error('ollama-harness-git-add-failed');
  const commit = gitResult(cwd, ['commit', '--no-verify', '-m', `#${issueNumber} Ollama implementation`], env);
  if (commit.status !== 0) throw new Error('ollama-harness-git-commit-failed');
}

function boundedText(value, max = 48_000) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated by Ollama runner]`;
}

function buildOllamaPrompt({ issue, preflight, allowedPaths, shellAllowlist, validations, repositoryContext }) {
  const instructionPaths = repositoryContext?.implementationInstructionPaths || [];
  const prompt = `You are the machine-local Ollama coding worker for one authorised low-risk implementation task.

Hard boundaries:
- Work only in the current assigned Git worktree.
- Edit only these manager-authorised paths/patterns:
${allowedPaths.map((path) => `  - ${path}`).join('\n')}
- Do not commit, push, merge, create PRs/issues, change branches, install packages, download anything, access external directories, or administer the host.
- Shell is available only for the allowlisted commands below. Do not attempt other commands:
${shellAllowlist.map((command) => `  - ${command}`).join('\n')}
- Use built-in read/glob/grep/edit tools for repository work. Never read .env files.
- Read and obey these repository instruction files when present: ${instructionPaths.join(', ') || 'repository defaults'}.
- The supervising harness reruns the required validations and owns commit/publication.
- If the task cannot be completed inside these bounds, stop without broadening scope.

Required validation:
${validations.map((command) => `  - ${command}`).join('\n')}

Issue #${issue.number}: ${boundedText(issue.title, 500)}
Issue body:
${boundedText(issue.body, 45_000)}

Authoritative manager packet:
${boundedText(preflight.body, 55_000)}

Implement the bounded task. Do not merely describe a solution; make the authorised worktree edits and use allowed validation commands as useful. Finish with a concise summary.`;
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error('ollama-prompt-too-large');
  return prompt;
}

function writeRunLog(outputDir, issueNumber, payload) {
  mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(outputDir, `ollama-issue-${issueNumber}-${stamp}.json`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function emit(outputDir, issueNumber, payload) {
  const logPath = writeRunLog(outputDir, issueNumber, payload);
  console.log(JSON.stringify({ ...payload, providerOutput: payload.providerOutput ? '<see log>' : undefined, logPath }, null, 2));
  return logPath;
}

function safeFailurePayload(base, error, extra = {}) {
  return {
    ...base,
    ...extra,
    dryRun: false,
    blocked: true,
    failureReason: String(error?.message || error || 'ollama-runner-failed').slice(0, 160),
    executionNoop: false,
    awaitingPlanApproval: false,
    sessionAvailable: false,
    recoveryEvidence: { sameProfileAvailable: false, policyApproved: false },
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const configPath = resolveConfigPath(argv, env);
  const config = loadAgentRunnerConfig({ argv, env, configPath });
  assertProjectScopedEnv({ config, configPath, env });
  const args = parseOllamaRunnerArgs(stripConfigArgs(argv), {
    defaultRepo: configPath ? config.githubRepo : (env.GITHUB_REPOSITORY || config.githubRepo),
  });
  assertConfiguredRepositoryIdentity({ configPath, config, repo: args.repo });
  if (args.help) {
    printOllamaRunnerHelp();
    return 0;
  }

  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) throw new Error('Missing GITHUB_TOKEN or GH_TOKEN environment variable');

  const basePayload = {
    issue: args.issue,
    repo: args.repo,
    executionPhase: EXECUTION_PHASE_IMPLEMENTATION,
    agent: {
      agentId: OLLAMA_AGENT_ID,
      agentType: 'ollama',
      implemented: true,
      model: args.model,
      effort: null,
    },
    model: args.model,
    agentId: OLLAMA_AGENT_ID,
    agentType: 'ollama',
    costAdmission: { allowed: true, policy: 'free-local-qualified' },
    usageAccounting: {
      provider: 'ollama-local',
      paid: false,
      costUsd: 0,
    },
  };

  let runtimeRoot = null;
  let slot = { release: () => {} };
  let workspace = null;
  let dispatchIdentity = null;
  let providerResult = null;

  try {
    const { issue, comments } = await fetchIssueAndComments({ repo: args.repo, issue: args.issue, token });
    const managerState = resolveCurrentManagerAuthority(comments);
    const usableClaimed = managerState.reason === MANAGER_PREFLIGHT_ALREADY_CLAIMED && managerState.authority;
    if (!managerState.allowed && !usableClaimed) throw new Error(managerState.reason || 'manager-preflight-required');
    const managerAuthority = managerState.authority;
    if (!managerAuthorityApprovesAgent(managerAuthority, OLLAMA_AGENT_ID)) throw new Error('manager-agent-mismatch');

    const currentLabel = executionLabelAuthority(issue).agentLabel;
    const labelledAgent = resolveAgentForLabels([...issueLabels(issue), currentLabel]);
    if (labelledAgent?.agentId !== OLLAMA_AGENT_ID) throw new Error('ollama-execution-label-mismatch');

    const settings = readExactSettings(env);
    if (!settings.routable) throw new Error('ollama-agent-not-routable');
    if (!settings.runtimeModel || settings.runtimeModel !== args.model) throw new Error('ollama-runtime-model-mismatch');

    const classification = classifyIssueTaskRisk(issue);
    if (classification.conflicts?.length) throw new Error('ollama-issue-classification-conflict');
    const qualification = assessQualification({
      agentId: OLLAMA_AGENT_ID,
      qualification: settings.qualification,
      classification,
    });
    if (!qualification.qualified) throw new Error(qualification.reasons[0] || 'ollama-not-qualified');

    const capabilities = resolveManagerPreflightRequiredCapabilities(managerAuthority.comment);
    if (!capabilities.valid) throw new Error('unknown-required-capability');
    if (capabilities.capabilities.length) throw new Error('ollama-required-capabilities-unsupported');

    dispatchIdentity = resolveImplementationDispatchIdentity({
      issue,
      command: null,
      currentPreflight: managerAuthority.comment,
      config: { githubRepo: config.githubRepo, localRepoPath: config.localRepoPath },
      env,
      argsRepo: args.repo,
    });
    if (!dispatchIdentity.ok) throw new Error(dispatchIdentity.failureReason);
    if (dispatchIdentity.executionAuthorization.phase !== EXECUTION_PHASE_IMPLEMENTATION
      || dispatchIdentity.executionAuthorization.allowed !== true) {
      throw new Error('ollama-implementation-not-authorized');
    }
    const packetModel = dispatchIdentity.managerExecutionMeta?.model;
    if (!packetModel || packetModel !== args.model) throw new Error('ollama-manager-model-mismatch');

    const allowed = normalizeAllowedPaths(resolveManagerPreflightAllowedPaths(managerAuthority.comment));
    if (!allowed.valid) throw new Error(allowed.reason);
    const validations = requiredValidations(managerAuthority.comment, config);
    const shellAllowlist = reviewedModelShellAllowlist(config);

    const endpoint = resolveOllamaEndpoint(settings.entry);
    if (!endpoint.ok) throw new Error(endpoint.reason);
    const ollamaBin = String(settings.entry.executablePath || '').trim();
    const openCodeBin = String(settings.entry.openCodeExecutablePath || '').trim();
    if (!isAbsolute(ollamaBin) || !isAbsolute(openCodeBin)) throw new Error('ollama-executable-path-not-absolute');
    accessSync(ollamaBin, fsConstants.X_OK);
    accessSync(openCodeBin, fsConstants.X_OK);
    readVersion(ollamaBin, validationEnv(env), OLLAMA_RUNNER_EXPECTED_OLLAMA_VERSION, 'ollama-version-not-qualified');
    readVersion(openCodeBin, validationEnv(env), OLLAMA_RUNNER_EXPECTED_OPENCODE_VERSION, 'opencode-version-not-qualified');

    const admission = await admitOllamaDispatch({
      env,
      model: args.model,
      settings: {
        agentId: OLLAMA_AGENT_ID,
        routable: settings.routable,
        reason: 'agent-routable',
        entry: settings.entry,
      },
      accessFn: accessSync,
      execFileFn: (file, commandArgs) => execFileSync(file, commandArgs, {
        encoding: 'utf8',
        timeout: 5_000,
        env: validationEnv(env),
      }),
      fetchFn: fetch,
    });
    if (!admission.allowed) throw new Error(admission.reason || 'ollama-admission-refused');

    const configContent = buildOpenCodeCodingLocalOllamaConfig({
      model: args.model,
      endpointUrl: endpoint.url,
      endpointAllowlistHosts: settings.entry.endpointAllowlistHosts,
      disableReasoning: true,
      allowedEditPaths: allowed.paths,
      shellAllowlist,
    });

    const prompt = buildOllamaPrompt({
      issue,
      preflight: managerAuthority.comment,
      allowedPaths: allowed.paths,
      shellAllowlist,
      validations,
      repositoryContext: dispatchIdentity.repositoryContext,
    });

    if (!args.execute) {
      const payload = {
        ...basePayload,
        dryRun: true,
        blocked: false,
        sourcePreflightCommentIdentity: dispatchIdentity.sourcePreflightCommentIdentity,
        sourcePreflightCommentId: dispatchIdentity.sourcePreflightCommentIdentity?.databaseId || null,
        worktreeIdentity: dispatchIdentity.worktreeIdentity,
        allowedEditPaths: allowed.paths,
        shellAllowlist,
        requiredValidation: validations,
        settingsRevision: settings.revision,
      };
      emit(args.outputDir, args.issue, payload);
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

    runtimeRoot = mkdtempSync(join(tmpdir(), 'agent-runner-ollama-live-'));
    const childEnv = modelProcessEnv(env, endpoint.hostname, runtimeRoot, configContent);
    const promptArgs = buildOpenCodeCommandArgs({
      executablePath: openCodeBin,
      model: args.model,
      workingDirectory: implementationProcessCwd(workspace),
      prompt,
    });
    const startedAt = new Date().toISOString();
    const processResult = spawnSync(promptArgs[0], promptArgs.slice(1), {
      cwd: implementationProcessCwd(workspace),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: OLLAMA_RUNNER_TIMEOUT_MS,
      env: childEnv,
      shell: false,
    });
    const finishedAt = new Date().toISOString();
    providerResult = parseOpenCodeResultEnvelope(processResult.stdout || '', {
      agentId: OLLAMA_AGENT_ID,
      model: args.model,
    });
    if (processResult.error?.code === 'ETIMEDOUT') throw new Error('ollama-timeout');
    if (processResult.status !== 0) throw new Error(`ollama-opencode-exit-${processResult.status ?? 'unknown'}`);
    if (!providerResult.ok) throw new Error(providerResult.reason || 'ollama-invalid-output');

    const worktreePath = implementationProcessCwd(workspace);
    const changedPaths = changedWorktreePaths(worktreePath, env);
    assertChangedPathSafety(worktreePath, changedPaths, allowed.paths);

    const validationResults = runRequiredValidations(validations, changedPaths, worktreePath, env);
    assertChangedPathSafety(worktreePath, changedWorktreePaths(worktreePath, env), allowed.paths);

    if (!settingsUnchanged(settings)) throw new Error('settings-revision-changed-before-commit');
    harnessCommit(worktreePath, args.issue, changedPaths, env);

    let implementationEvidence = collectImplementationEvidence({
      workspace,
      worktreeIdentity: dispatchIdentity.worktreeIdentity,
    });
    if (!implementationEvidence.valid) throw new Error(implementationEvidence.failureReason || 'implementation-evidence-invalid');

    const latest = await fetchIssueAndComments({ repo: args.repo, issue: args.issue, token });
    if (!managerAuthorityKeyIsCurrent(latest.comments, managerAuthority.authorityKey, managerAuthority.packetDigest)) {
      throw new Error('manager-authority-changed-before-publication');
    }
    if (!settingsUnchanged(settings)) throw new Error('settings-revision-changed-before-publication');

    const implementationPublication = publishImplementationDraft({
      workspace,
      worktreeIdentity: dispatchIdentity.worktreeIdentity,
      repo: dispatchIdentity.repositoryContext?.implementationRepository || args.repo,
      issueNumber: args.issue,
      issueTitle: issue.title,
      env,
    });
    if (!implementationPublication.published) {
      implementationEvidence = {
        ...implementationEvidence,
        valid: false,
        failureReason: implementationPublication.failureReason || 'implementation-draft-publication-failed',
      };
      throw new Error(implementationEvidence.failureReason);
    }

    const payload = {
      ...basePayload,
      dryRun: false,
      blocked: false,
      failureReason: null,
      executionNoop: false,
      awaitingPlanApproval: false,
      startedAt,
      finishedAt,
      sourcePreflightCommentIdentity: dispatchIdentity.sourcePreflightCommentIdentity,
      sourcePreflightCommentId: dispatchIdentity.sourcePreflightCommentIdentity?.databaseId || null,
      executionAuthorization: dispatchIdentity.executionAuthorization,
      worktreeIdentity: dispatchIdentity.worktreeIdentity,
      implementationEvidence,
      implementationPublication,
      allowedEditPaths: allowed.paths,
      shellAllowlist,
      requiredValidation: validationResults,
      settingsRevision: settings.revision,
      providerOutput: redactSensitiveText(providerResult.resultText || ''),
      usageAccounting: {
        provider: 'ollama-local',
        paid: false,
        costUsd: 0,
        usageEfficiency: providerResult.usageEfficiency,
      },
      checkpointAvailable: Boolean(implementationEvidence.worktree?.head),
      sessionAvailable: false,
      recoveryEvidence: {
        sameProfileAvailable: false,
        policyApproved: false,
        deterministicValidationFailure: false,
      },
      restrictedRecoveryHandleDigest: null,
      restrictedHandleBindingDigest: null,
    };
    emit(args.outputDir, args.issue, payload);
    return 0;
  } catch (error) {
    const payload = safeFailurePayload(basePayload, error, {
      sourcePreflightCommentIdentity: dispatchIdentity?.sourcePreflightCommentIdentity || null,
      sourcePreflightCommentId: dispatchIdentity?.sourcePreflightCommentIdentity?.databaseId || null,
      executionAuthorization: dispatchIdentity?.executionAuthorization || null,
      worktreeIdentity: dispatchIdentity?.worktreeIdentity || null,
      implementationEvidence: workspace?.allowed && dispatchIdentity?.worktreeIdentity
        ? collectImplementationEvidence({ workspace, worktreeIdentity: dispatchIdentity.worktreeIdentity })
        : null,
      providerOutput: providerResult?.resultText ? redactSensitiveText(providerResult.resultText) : '',
      usageAccounting: {
        provider: 'ollama-local',
        paid: false,
        costUsd: 0,
        usageEfficiency: providerResult?.usageEfficiency || null,
      },
      checkpointAvailable: false,
    });
    emit(args.outputDir, args.issue || 0, payload);
    return 1;
  } finally {
    if (runtimeRoot) {
      try { rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
    }
    slot.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
