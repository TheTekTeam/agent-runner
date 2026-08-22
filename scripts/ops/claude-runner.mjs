#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { assertProjectScopedEnv, loadAgentRunnerConfig, resolveConfigPath, stripConfigArgs } from './agent-runner-config.mjs';
import {
  DEFAULT_PROJECT_REPOSITORY_INSTRUCTIONS,
  resolveRepositoryContext,
  runnerOwnCheckoutRoot,
} from './agent-runner-repository-context.mjs';
import { redactExecutableArgs, redactSensitiveText } from './lib/redact.mjs';
import {
  buildQuotaCheckArgs,
  evaluateQuotaPauseState,
  parseQuotaCheckOutput,
  recordQuotaPause,
} from './claude-runner-quota.mjs';
import {
  buildReviewFollowUpPrompt,
  detectUnresolvedReviewFollowUp,
  findLinkedOpenPullRequests,
  linkedIssueNumberFromPr,
  linkedIssueNumbersFromPr,
} from './claude-runner-review-followup.mjs';
import { resolvePrContinuationBinding } from './agent-runner-pr-continuation-binding.mjs';
import {
  agentRunMetadata,
  buildAgentCommandArgs,
  resolveAgentById,
} from './agent-runner-agents.mjs';
import {
  resolveCurrentManagerAuthority,
  resolveManagerPreflightExecutionMetadata,
} from './agent-runner-manager-authority.mjs';
import { resolveDispatchAuthority } from './agent-runner-dispatch-authority.mjs';
import {
  CLAUDE_COMMAND_HEADINGS,
  findLastMarkdownHeadingIndex,
  findLatestClaudeCommand,
  findLatestClaudeContinueCommand,
  findLatestClaudeProceedCommand,
  hasManagerPreflight,
  latestManagerPreflightComment,
} from './claude-runner-selection.mjs';
import {
  EXECUTION_PHASE_IMPLEMENTATION,
  EXECUTION_PHASE_PLAN,
  buildImplementationToolPolicy,
  buildWorktreeIdentity,
  evaluateExecutionAuthorization,
  evaluateImplementationEvidence,
  fingerprintGitStatus,
  inspectClaudeCliHelp,
  inspectClaudeCliVersion,
} from './claude-runner-execution-policy.mjs';
import { restrictedHandleBindingDigest, writeRestrictedRecoveryHandle } from './claude-runner-recovery-adapter.mjs';
import {
  commentRevision,
  normalizeCommentIdentity,
} from './claude-runner-comment-identity.mjs';
import {
  buildClaudeAdapterIdentitySection,
  buildDynamicTaskIdentitySection,
  buildEvidenceSchemaSection,
  buildExecutionPhaseInvariantsSection,
  buildFinalRequestSection,
  buildPromptCacheMetadata,
  buildRepositoryInstructionContractSection,
  buildSafetyAuthorityInvariantsSection,
  buildWorktreeAssignmentSection,
  compilePrompt,
  joinSections,
  PROMPT_SCHEMA_VERSION,
} from './claude-runner-prompt-compiler.mjs';
import {
  buildClaudeUsageAccounting,
  sanitizeClaudeStructuredUsage,
} from './agent-runner-usage-telemetry.mjs';

export {
  buildPromptCacheMetadata,
  PROMPT_SCHEMA_VERSION,
};

const DEFAULT_REPO = 'TheTekTeam/modelspend';
const DEFAULT_OUTPUT_DIR = '.var/claude-runner';
const PROFILE_NAMES = ['docs', 'narrow', 'complex', 'critical'];
// This script's own checkout root -- the runner's implementation checkout
// when a repository context explicitly names the runner's own repository
// (see resolveRepositoryContext), independent of process.cwd().
const RUNNER_OWN_CHECKOUT = runnerOwnCheckoutRoot(import.meta.url);
export {
  CLAUDE_COMMAND_HEADINGS,
  findLastMarkdownHeadingIndex,
  findLatestClaudeCommand,
  findLatestClaudeContinueCommand,
  findLatestClaudeProceedCommand,
  hasManagerPreflight,
  latestManagerPreflightComment,
  EXECUTION_PHASE_IMPLEMENTATION,
  EXECUTION_PHASE_PLAN,
  buildImplementationToolPolicy,
  buildWorktreeIdentity,
  evaluateExecutionAuthorization,
  evaluateImplementationEvidence,
  fingerprintGitStatus,
  inspectClaudeCliHelp,
  inspectClaudeCliVersion,
};
const CLAUDE_PROVIDER_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_REGION',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUD_ML_REGION',
];

export const DEFAULT_PROFILES = {
  docs: {
    modelEnv: 'CLAUDE_RUNNER_MODEL_DOCS',
    defaultModel: 'haiku',
    effort: 'low',
    permissionMode: 'plan',
  },
  narrow: {
    modelEnv: 'CLAUDE_RUNNER_MODEL_NARROW',
    defaultModel: 'sonnet',
    effort: 'low',
    permissionMode: 'plan',
  },
  complex: {
    modelEnv: 'CLAUDE_RUNNER_MODEL_COMPLEX',
    defaultModel: 'sonnet',
    effort: 'medium',
    permissionMode: 'plan',
  },
  critical: {
    modelEnv: 'CLAUDE_RUNNER_MODEL_CRITICAL',
    defaultModel: 'sonnet',
    effort: 'high',
    permissionMode: 'plan',
  }
};

export const SUPPORTED_MODEL_IDS = Object.freeze(['haiku', 'sonnet', 'opus']);

export function isSupportedModelId(model) {
  return typeof model === 'string' && SUPPORTED_MODEL_IDS.includes(model);
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function evaluateClaudeCostAdmission(profile = {}, env = process.env) {
  const model = String(profile.model || '').trim().toLowerCase();
  const effort = String(profile.effort || '').trim().toLowerCase();
  const violations = [];

  if (model.includes('opus') && !truthy(env.CLAUDE_RUNNER_ALLOW_OPUS)) {
    violations.push('opus-requires-explicit-machine-opt-in');
  }
  if (['xhigh', 'max'].includes(effort) && !truthy(env.CLAUDE_RUNNER_ALLOW_XHIGH)) {
    violations.push('high-effort-requires-explicit-machine-opt-in');
  }

  return {
    allowed: violations.length === 0,
    violations,
    requested: {
      model: profile.model || null,
      effort: profile.effort || null,
    },
    policy: {
      opusAllowed: truthy(env.CLAUDE_RUNNER_ALLOW_OPUS),
      highEffortAllowed: truthy(env.CLAUDE_RUNNER_ALLOW_XHIGH),
    },
  };
}

export function parseArgs(argv = process.argv.slice(2), { defaultRepo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO } = {}) {
  const args = {
    repo: defaultRepo,
    outputDir: DEFAULT_OUTPUT_DIR,
    execute: false,
    noClear: false,
    inheritProviderAuth: truthy(process.env.CLAUDE_RUNNER_INHERIT_PROVIDER_AUTH),
    claudeBin: process.env.CLAUDE_BIN || 'claude',
    profile: undefined,
    issue: undefined,
    pr: undefined,
    model: undefined,
    effort: undefined,
    resumeSession: undefined,
    attemptId: undefined,
    recoveryMode: undefined,
    checkQuota: false,
    forceQuotaCheck: false,
    quotaStatePath: undefined,
    skipPrFollowUpCheck: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return value;
    };

    if (arg === '--execute') args.execute = true;
    else if (arg === '--dry-run') args.execute = false;
    else if (arg === '--no-clear') args.noClear = true;
    else if (arg === '--inherit-provider-auth') args.inheritProviderAuth = true;
    else if (arg === '--issue') args.issue = Number.parseInt(next(), 10);
    else if (arg === '--pr') args.pr = Number.parseInt(next(), 10);
    else if (arg === '--repo') args.repo = next();
    else if (arg === '--output-dir') args.outputDir = next();
    else if (arg === '--profile') args.profile = next();
    else if (arg === '--model') args.model = next();
    else if (arg === '--effort') args.effort = next();
    else if (arg === '--resume-session') args.resumeSession = next();
    else if (arg === '--attempt-id') args.attemptId = next();
    else if (arg === '--recovery-mode') args.recoveryMode = next();
    else if (arg === '--claude-bin') args.claudeBin = next();
    else if (arg === '--check-quota') args.checkQuota = true;
    else if (arg === '--force-quota-check') args.forceQuotaCheck = true;
    else if (arg === '--quota-state-path') args.quotaStatePath = next();
    else if (arg === '--skip-pr-followup-check') args.skipPrFollowUpCheck = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.issue !== undefined && (!Number.isInteger(args.issue) || args.issue <= 0)) {
    throw new Error('--issue must be a positive integer');
  }
  if (args.pr !== undefined && (!Number.isInteger(args.pr) || args.pr <= 0)) {
    throw new Error('--pr must be a positive integer');
  }
  if (args.recoveryMode !== undefined && !['native_resume', 'same_agent_continuation'].includes(args.recoveryMode)) {
    throw new Error('--recovery-mode must be native_resume or same_agent_continuation');
  }

  return args;
}

export function printHelp() {
  console.log(`Claude runner\n\nUsage:\n  node scripts/ops/claude-runner.mjs --issue <number> [--execute]\n  node scripts/ops/claude-runner.mjs --pr <number> [--execute]\n  node scripts/ops/claude-runner.mjs --check-quota\n\nIssue execution phases:\n  implementation  Default for docs/narrow/complex issues with a current manager preflight. Requires machine-local opt-in and an allowlisted preflight author. Uses dontAsk, an explicit tool allowlist, and an isolated Git worktree bound to manager branch authority.\n  plan            Default only for critical profiles, or when the current command/preflight says Phase: plan. Never counts as implementation.\n\nRequired implementation policy:\n  CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=true\n  CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS=<comma-separated GitHub logins>\n\nIssue text cannot override permission mode or tool policy. The runner never enables bypassPermissions.\n\nOptions:\n  --issue <number>          GitHub issue with a current canonical immutable manager preflight packet\n  --pr <number>             Generate (and optionally run) a PR review follow-up prompt instead of issue work\n  --repo <owner/name>       GitHub repository, defaults to ${DEFAULT_REPO}\n  --execute                 Actually run Claude. Default is dry-run.\n  --profile <name>          docs | narrow | complex | critical\n  --model <model>           Override profile model. Prefer env vars for durable config.\n  --effort <level>          low | medium | high | xhigh | max\n  --resume-session <name>   Resume a matching Claude session; skips clear by default\n  --no-clear                Skip clear-context instruction for new task. Not recommended.\n  --inherit-provider-auth   Pass Anthropic/Bedrock/Vertex provider auth env vars through to Claude. Default is to strip them.\n  --output-dir <path>       Local log output directory\n  --check-quota             Run a conservative /quota check and update the local pause state. Does not touch GitHub issues/PRs.\n  --force-quota-check       Bypass the 10-minute minimum spacing between --check-quota invocations (operator override; still a check, never a limit bypass)\n  --quota-state-path <path> Override the local quota pause-state file (default: <output-dir>/quota-state.json)\n  --skip-pr-followup-check  Operator override to skip the linked-PR unresolved-review-followup gate before starting --issue work\n\nExit codes (--execute mode):\n  0    Claude produced verified repository-change evidence.\n  1    Execution failed, produced no implementation artifact, or returned another plan during implementation.\n  ${PLAN_ONLY_EXIT_CODE}    Explicit plan-only run completed; awaiting approval/continuation.\n  ${COST_POLICY_EXIT_CODE}    Machine-local model/effort policy blocked the run before Claude started.\n  ${EXECUTION_POLICY_EXIT_CODE}    Authorization, CLI capability, or isolated-worktree policy blocked the run before Claude started.\n`);
}

export function parseKeyValueBlock(markdown = '') {
  const result = {};
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z /_-]*):\s*(.+?)\s*$/);
    if (!match) continue;
    const key = match[1].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    result[key] = match[2].trim().replace(/^`|`$/g, '');
  }
  return result;
}

export function inferProfile({ explicitProfile, commandText = '', issue = {} } = {}) {
  if (explicitProfile) {
    const profile = explicitProfile.toLowerCase();
    if (!PROFILE_NAMES.includes(profile)) {
      throw new Error(`Unsupported profile '${explicitProfile}'. Use one of: ${PROFILE_NAMES.join(', ')}`);
    }
    return profile;
  }

  void commandText;
  const title = String(issue.title || '').toLowerCase();
  const labels = (issue.labels || [])
    .map((label) => String(label?.name || label || '').trim().toLowerCase())
    .filter(Boolean)
    .join('\n');
  const stableSignals = `${title}\n${labels}`;

  if (/\bdocs?(?:-only)?\b|documentation|readme|markdown|process-only/.test(stableSignals)) {
    return 'docs';
  }
  if (/\bcritical\b|production|security|\bauth\b|rbac|tenant isolation|billing|routing|provider|migration/.test(stableSignals)) {
    return 'critical';
  }
  if (/refactor|cross-package|multi-file|architecture|persistence|database|\bapi\b|runner|entrypoint|orchestrat/.test(stableSignals)) {
    return 'complex';
  }
  return 'narrow';
}

export function resolveProfile(profileName, overrides = {}, env = process.env) {
  const base = DEFAULT_PROFILES[profileName];
  if (!base) throw new Error(`Unknown profile: ${profileName}`);
  return {
    profile: profileName,
    model: overrides.model || env[base.modelEnv] || base.defaultModel,
    effort: overrides.effort || base.effort,
    permissionMode: overrides.permissionMode || base.permissionMode,
    tools: overrides.tools,
    allowedTools: overrides.allowedTools,
    disallowedTools: overrides.disallowedTools,
    worktreeName: overrides.worktreeName,
    strictMcpConfig: Boolean(overrides.strictMcpConfig),
    disableSlashCommands: Boolean(overrides.disableSlashCommands),
    settings: overrides.settings,
    settingSources: overrides.settingSources,
  };
}

export function shouldUseClear({ noClear = false, resumeSession } = {}) {
  return !noClear && !resumeSession;
}

function repositoryIdentityLine(repositoryContext) {
  const repo = repositoryContext?.implementationRepository;
  return repo ? `You are Claude Code CLI working on ${repo}.` : 'You are Claude Code CLI working on this repository.';
}

function repositoryInstructionPaths(repositoryContext) {
  return repositoryContext?.implementationInstructionPaths?.length
    ? repositoryContext.implementationInstructionPaths
    : DEFAULT_PROJECT_REPOSITORY_INSTRUCTIONS;
}

function buildClaudePromptSections({
  issue, commandText, currentPreflight = null, preflight = null, selectionMode = 'compat',
  profile, clearContext, executionPhase, worktreeIdentity = null, repositoryContext = null,
}) {
  const clearPrefix = clearContext
    ? 'Start a fresh task context. Do not carry assumptions or files from any previous Claude task.\n\n'
    : '';
  const modeLine = selectionMode === 'preflight-direct'
    ? 'Selection mode: preflight-direct — the current canonical manager packet is the sole new-claim authority. Historical proceed/continue comments are ignored.'
    : '';
  const preflightDirectScopeNote = selectionMode === 'preflight-direct'
    ? 'Use the manager preflight packet as the durable implementation scope. Do not redo broad repo discovery/preflight. Implement only the issue as scoped by its body and the preflight packet.'
    : '';

  const stableSections = [
    joinSections([buildSafetyAuthorityInvariantsSection(), preflightDirectScopeNote]),
    buildRepositoryInstructionContractSection(repositoryInstructionPaths(repositoryContext)),
    buildExecutionPhaseInvariantsSection(executionPhase),
    buildEvidenceSchemaSection(),
    buildClaudeAdapterIdentitySection({ repositoryIdentityLine: repositoryIdentityLine(repositoryContext), modeLine }),
  ];

  const mutableEvidence = selectionMode === 'preflight-direct'
    ? joinSections([
      `Issue body:\n\n${issue.body || '(no issue body)'}`,
      `Latest manager preflight packet (source comment ${commentRevision(preflight) || 'unknown'}):\n\n${preflight.body}`,
    ])
    : joinSections([
      `Latest Claude command:\n\n${commandText}`,
      currentPreflight
        ? `Current manager preflight packet (source comment ${commentRevision(currentPreflight) || 'unknown'}):\n\n${currentPreflight.body || ''}`
        : '',
    ]);

  const dynamicSections = [
    buildDynamicTaskIdentitySection({ issue, profile }),
    buildWorktreeAssignmentSection(executionPhase, worktreeIdentity),
    mutableEvidence,
    buildFinalRequestSection(executionPhase),
  ];

  return compilePrompt({ clearPrefix, stableSections, dynamicSections });
}

export function buildClaudePrompt({ issue, commandText, currentPreflight = null, profile, clearContext, executionPhase = profile?.permissionMode === 'plan' ? EXECUTION_PHASE_PLAN : EXECUTION_PHASE_IMPLEMENTATION, worktreeIdentity = null, repositoryContext = null }) {
  return buildClaudePromptSections({
    issue, commandText, currentPreflight, profile, clearContext, executionPhase, worktreeIdentity, repositoryContext,
  }).prompt;
}

export function buildPreflightDirectPrompt({ issue, preflight, profile, clearContext, executionPhase = profile?.permissionMode === 'plan' ? EXECUTION_PHASE_PLAN : EXECUTION_PHASE_IMPLEMENTATION, worktreeIdentity = null, repositoryContext = null }) {
  return buildClaudePromptSections({
    issue, preflight, selectionMode: 'preflight-direct', profile, clearContext, executionPhase, worktreeIdentity, repositoryContext,
  }).prompt;
}

export function claudePromptCacheMetadata({
  issue, commandText, currentPreflight = null, preflight = null, selectionMode = 'compat',
  profile, clearContext, executionPhase, worktreeIdentity = null, repositoryContext = null,
}) {
  const { stableText, dynamicText } = buildClaudePromptSections({
    issue, commandText, currentPreflight, preflight, selectionMode, profile, clearContext, executionPhase, worktreeIdentity, repositoryContext,
  });
  return buildPromptCacheMetadata({
    stableText,
    dynamicText,
    adapterId: 'claude-code-cli',
    model: profile?.model,
    profile: profile?.profile,
    cacheStrategy: 'provider-managed',
  });
}

export function resolveImplementationDispatchIdentity({
  issue,
  command = null,
  currentPreflight = null,
  config = {},
  env = process.env,
  argsRepo,
  argsProfile,
  argsModel,
  argsEffort,
} = {}) {
  if (!currentPreflight) {
    return { ok: false, failureReason: 'manager-preflight-missing', failureScope: 'issue_not_runnable' };
  }
  if (command) {
    return { ok: false, failureReason: 'proceed-command-not-authoritative', failureScope: 'issue_not_runnable' };
  }
  const preflight = currentPreflight;
  const selectionMode = 'preflight-direct';
  const referenceText = preflight.body;
  const executionMeta = parseKeyValueBlock(currentPreflight.body || '');
  const managerExecutionMeta = resolveManagerPreflightExecutionMetadata(currentPreflight);

  const dispatchAuthority = resolveDispatchAuthority({
    preflight: currentPreflight,
    legacyMetadata: executionMeta,
    argsRepo,
    config: { githubRepo: config.githubRepo, localRepoPath: config.localRepoPath },
    runnerCheckout: RUNNER_OWN_CHECKOUT,
  });
  if (!dispatchAuthority.ok) {
    return { ok: false, failureReason: dispatchAuthority.failureReason, failureScope: dispatchAuthority.failureScope };
  }

  const repositoryContextResult = resolveRepositoryContext({
    issueRepository: argsRepo,
    projectRepository: config.githubRepo,
    projectCheckout: config.localRepoPath,
    runnerCheckout: RUNNER_OWN_CHECKOUT,
    requestedImplementationRepository: dispatchAuthority.repository,
  });
  if (!repositoryContextResult.allowed) {
    return { ok: false, failureReason: repositoryContextResult.failureReason, failureScope: 'systemic' };
  }

  const profileName = inferProfile({
    explicitProfile: argsProfile || managerExecutionMeta.profile,
    commandText: referenceText,
    issue,
  });
  const executionAuthorization = evaluateExecutionAuthorization({
    command: null, currentPreflight, metadata: executionMeta, profileName, env,
  });
  const sourceCommentIdentity = null;
  const sourcePreflightCommentIdentity = normalizeCommentIdentity(currentPreflight, {
    context: 'child-manager-preflight',
    required: true,
  });
  const sourceAttemptCommentId = commentRevision(sourceCommentIdentity || sourcePreflightCommentIdentity);
  const worktreeIdentity = executionAuthorization.phase === EXECUTION_PHASE_IMPLEMENTATION
    ? buildWorktreeIdentity({ issueNumber: issue.number, sourceCommentId: sourceAttemptCommentId, approvedBranch: dispatchAuthority.branch })
    : null;

  return {
    ok: true,
    preflight,
    selectionMode,
    executionMeta,
    managerExecutionMeta,
    dispatchAuthority,
    repositoryContext: repositoryContextResult.context,
    profileName,
    executionAuthorization,
    sourceCommentIdentity,
    sourcePreflightCommentIdentity,
    sourceAttemptCommentId,
    worktreeIdentity,
  };
}

export function buildClaudeArgs({ prompt, profile, resumeSession }) {
  return buildAgentCommandArgs({ agent: resolveAgentById('claude-code-cli'), prompt, profile, resumeSession });
}

export function buildClaudeProcessEnv(env = process.env, { inheritProviderAuth = false } = {}) {
  const next = { ...env };
  if (inheritProviderAuth) return next;
  for (const key of CLAUDE_PROVIDER_AUTH_ENV_KEYS) {
    delete next[key];
  }
  return next;
}

export function removedClaudeProviderAuthKeys(env = process.env, { inheritProviderAuth = false } = {}) {
  if (inheritProviderAuth) return [];
  return CLAUDE_PROVIDER_AUTH_ENV_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(env, key));
}

function commandText(result) {
  return `${result?.stdout || ''}${result?.stderr || ''}`;
}

function runGit(args, { cwd = resolve('.'), runner = spawnSync } = {}) {
  return runner('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    env: process.env,
  });
}

function successfulGitText(args, options = {}) {
  const result = runGit(args, options);
  if (result?.status !== 0) return null;
  return String(result.stdout || '').trim();
}

export function verifyClaudeImplementationCli({ claudeBin = 'claude', runner = spawnSync } = {}) {
  const processOptions = {
    cwd: resolve('.'),
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    env: process.env,
  };
  const versionResult = runner(claudeBin, ['--version'], processOptions);
  const helpResult = runner(claudeBin, ['--help'], processOptions);
  const version = inspectClaudeCliVersion(commandText(versionResult), { exitCode: versionResult?.status });
  const help = inspectClaudeCliHelp(commandText(helpResult), { exitCode: helpResult?.status });
  return {
    ...version,
    helpDiagnostic: {
      helpExitCode: help.helpExitCode,
      missingFromHelp: help.missing,
      helpListsAllRequiredFlags: help.compatible,
    },
  };
}

export function captureGitRepositoryEvidence({ cwd = resolve('.'), includeUntracked = true, runner = spawnSync } = {}) {
  const head = successfulGitText(['rev-parse', 'HEAD'], { cwd, runner });
  const branch = successfulGitText(['branch', '--show-current'], { cwd, runner });
  const statusResult = runGit([
    'status',
    '--porcelain=v1',
    includeUntracked ? '--untracked-files=all' : '--untracked-files=no',
  ], { cwd, runner });
  if (!head || statusResult?.status !== 0) return null;
  return {
    head,
    branch: branch || '(detached)',
    ...fingerprintGitStatus(statusResult.stdout || ''),
  };
}

export function nativeClaudeWorktreeName(worktreeIdentity) {
  const name = String(worktreeIdentity?.name || '').trim();
  const expectedBranch = String(worktreeIdentity?.expectedBranch || '').trim();
  return name && expectedBranch === `worktree-${name}` ? name : undefined;
}

export function implementationProcessCwd(workspace, fallbackCwd = resolve('.')) {
  if (workspace?.workspacePreparedByRunner && workspace?.worktreePath) {
    return workspace.worktreePath;
  }
  return workspace?.rootPath || fallbackCwd;
}

export function inspectImplementationWorkspaceAvailability({ worktreeIdentity, implementationCheckout, env = process.env, runner = spawnSync } = {}) {
  const baseRef = String(env.CLAUDE_RUNNER_BASE_REF || 'origin/main').trim();
  if (!/^origin\/[A-Za-z0-9._/-]+$/.test(baseRef)) {
    return { allowed: false, failureReason: 'implementation-base-ref-invalid', baseRef };
  }

  const searchCwd = implementationCheckout ? resolve(implementationCheckout) : resolve('.');
  const rootResult = runGit(['rev-parse', '--show-toplevel'], { cwd: searchCwd, runner });
  const rootPath = rootResult?.status === 0 ? String(rootResult.stdout || '').trim() : '';
  if (!rootPath) return { allowed: false, failureReason: 'implementation-repository-root-unavailable', baseRef };

  const remoteBranch = baseRef.slice('origin/'.length);
  const fetchResult = runGit(['fetch', '--quiet', 'origin', remoteBranch], { cwd: rootPath, runner });
  if (fetchResult?.status !== 0) {
    return { allowed: false, failureReason: 'implementation-base-fetch-failed', baseRef, rootPath };
  }

  const baseHead = successfulGitText(['rev-parse', baseRef], { cwd: rootPath, runner });
  const originHead = successfulGitText(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: rootPath, runner });
  if (!baseHead) return { allowed: false, failureReason: 'implementation-base-ref-unavailable', baseRef, rootPath };
  if (originHead !== `refs/remotes/${baseRef}`) {
    return { allowed: false, failureReason: 'implementation-origin-head-mismatch', baseRef, rootPath };
  }

  const expectedBranch = String(worktreeIdentity?.expectedBranch || '').trim();
  const worktreePath = join(rootPath, '.claude', 'worktrees', worktreeIdentity?.name || '');
  const branchResult = runGit(['show-ref', '--verify', '--quiet', `refs/heads/${expectedBranch}`], { cwd: rootPath, runner });
  if (branchResult?.status === 0) {
    return { allowed: false, failureReason: 'implementation-worktree-branch-already-exists', baseRef, baseHead, rootPath };
  }
  const worktreeList = successfulGitText(['worktree', 'list', '--porcelain'], { cwd: rootPath, runner }) || '';
  if (worktreeList.includes(`/.claude/worktrees/${worktreeIdentity?.name}\n`)
    || worktreeList.includes(`branch refs/heads/${expectedBranch}`)) {
    return { allowed: false, failureReason: 'implementation-worktree-already-exists', baseRef, baseHead, rootPath };
  }

  const rootBefore = captureGitRepositoryEvidence({ cwd: rootPath, includeUntracked: false, runner });
  if (!rootBefore) {
    return { allowed: false, failureReason: 'runner-checkout-evidence-unavailable', baseRef, baseHead, rootPath };
  }

  return {
    allowed: true,
    failureReason: null,
    baseRef,
    baseHead,
    rootPath,
    rootBefore,
    worktreePath,
  };
}

export function prepareImplementationWorkspace(input = {}) {
  const { worktreeIdentity, runner = spawnSync } = input;
  const availability = inspectImplementationWorkspaceAvailability(input);
  if (availability.allowed !== true) return availability;
  const { baseRef, baseHead, rootPath, rootBefore, worktreePath } = availability;
  const expectedBranch = String(worktreeIdentity?.expectedBranch || '').trim();
  const nativeWorktreeName = nativeClaudeWorktreeName(worktreeIdentity);
  if (!nativeWorktreeName) {
    const branchFormat = runGit(['check-ref-format', '--branch', expectedBranch], { cwd: rootPath, runner });
    if (branchFormat?.status !== 0) return { allowed: false, failureReason: 'implementation-approved-branch-invalid', baseRef, baseHead, rootPath };
    mkdirSync(dirname(worktreePath), { recursive: true });
    const createResult = runGit(['worktree', 'add', '--quiet', '-b', expectedBranch, worktreePath, baseHead], { cwd: rootPath, runner });
    if (createResult?.status !== 0) return { allowed: false, failureReason: 'implementation-worktree-create-failed', baseRef, baseHead, rootPath, worktreePath };
    const worktreeBefore = captureGitRepositoryEvidence({ cwd: worktreePath, includeUntracked: true, runner });
    if (!worktreeBefore) return { allowed: false, failureReason: 'implementation-worktree-evidence-unavailable', baseRef, baseHead, rootPath, worktreePath };
    if (worktreeBefore.branch !== expectedBranch) return { allowed: false, failureReason: 'implementation-worktree-branch-mismatch', baseRef, baseHead, rootPath, worktreePath };
    if (worktreeBefore.head !== baseHead) return { allowed: false, failureReason: 'implementation-worktree-base-mismatch', baseRef, baseHead, rootPath, worktreePath };
    if (worktreeBefore.dirtyEntryCount !== 0) return { allowed: false, failureReason: 'implementation-worktree-dirty-before-launch', baseRef, baseHead, rootPath, worktreePath };
  }
  return { ...availability, workspacePreparedByRunner: !nativeWorktreeName };
}

export function prepareContinuationWorkspace({ worktreeIdentity, implementationCheckout, env = process.env, runner = spawnSync } = {}) {
  const baseRef = String(env.CLAUDE_RUNNER_BASE_REF || 'origin/main').trim();
  if (!/^origin\/[A-Za-z0-9._/-]+$/.test(baseRef)) return { allowed: false, failureReason: 'continuation-base-ref-invalid', baseRef };
  const searchCwd = implementationCheckout ? resolve(implementationCheckout) : resolve('.');
  const rootResult = runGit(['rev-parse', '--show-toplevel'], { cwd: searchCwd, runner });
  const rootPath = rootResult?.status === 0 ? String(rootResult.stdout || '').trim() : '';
  if (!rootPath) return { allowed: false, failureReason: 'continuation-repository-root-unavailable', baseRef };
  const expectedBranch = worktreeIdentity?.expectedBranch;
  const branchResult = runGit(['show-ref', '--verify', '--quiet', `refs/heads/${expectedBranch}`], { cwd: rootPath, runner });
  if (branchResult?.status !== 0) return { allowed: false, failureReason: 'continuation-branch-missing', baseRef, rootPath };
  const worktreeList = successfulGitText(['worktree', 'list', '--porcelain'], { cwd: rootPath, runner }) || '';
  const worktreeEntryPresent = worktreeList.split(/\n\s*\n/).some((entry) => entry.includes(`/.claude/worktrees/${worktreeIdentity?.name}`) && entry.includes(`branch refs/heads/${expectedBranch}`));
  if (!worktreeEntryPresent) return { allowed: false, failureReason: 'continuation-worktree-missing', baseRef, rootPath };
  const worktreePath = join(rootPath, '.claude', 'worktrees', worktreeIdentity.name);
  const worktreeBefore = captureGitRepositoryEvidence({ cwd: worktreePath, includeUntracked: true, runner });
  if (!worktreeBefore) return { allowed: false, failureReason: 'continuation-worktree-evidence-unavailable', baseRef, rootPath, worktreePath };
  if (worktreeBefore.branch !== expectedBranch) return { allowed: false, failureReason: 'continuation-worktree-branch-mismatch', baseRef, rootPath, worktreePath };
  const rootBefore = captureGitRepositoryEvidence({ cwd: rootPath, includeUntracked: false, runner });
  if (!rootBefore) return { allowed: false, failureReason: 'runner-checkout-evidence-unavailable', baseRef, rootPath, worktreePath };
  return { allowed: true, failureReason: null, baseRef, baseHead: worktreeBefore.head, rootPath, rootBefore, worktreePath, workspacePreparedByRunner: !nativeClaudeWorktreeName(worktreeIdentity) };
}

export function collectImplementationEvidence({ workspace, worktreeIdentity, runner = spawnSync } = {}) {
  const rootAfter = captureGitRepositoryEvidence({ cwd: workspace?.rootPath, includeUntracked: false, runner });
  const worktree = captureGitRepositoryEvidence({ cwd: workspace?.worktreePath, includeUntracked: true, runner });
  const evaluation = evaluateImplementationEvidence({ baseHead: workspace?.baseHead, rootBefore: workspace?.rootBefore, rootAfter, worktree, expectedBranch: worktreeIdentity?.expectedBranch });
  return { ...evaluation, baseRef: workspace?.baseRef || null, baseHead: workspace?.baseHead || null, rootBefore: workspace?.rootBefore || null, rootAfter, worktree };
}

function parsePullRequestList(stdout = '') {
  try { const payload = JSON.parse(String(stdout || '').trim()); return Array.isArray(payload) ? payload[0] || null : null; } catch { return null; }
}

export function publishImplementationDraft({ workspace, worktreeIdentity, repo, issueNumber, issueTitle, env = process.env, runner = spawnSync } = {}) {
  const branch = String(worktreeIdentity?.expectedBranch || '');
  const base = String(workspace?.baseRef || '').replace(/^origin\//, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || '')) || !/^[A-Za-z0-9._/-]+$/.test(base) || !workspace?.worktreePath) return { published: false, failureReason: 'implementation-publication-input-invalid' };
  const processOptions = { cwd: workspace.worktreePath, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, env };
  const branchFormat = runner('git', ['check-ref-format', '--branch', branch], processOptions);
  if (branchFormat?.status !== 0) return { published: false, failureReason: 'implementation-publication-branch-invalid' };
  const actualBranch = runner('git', ['branch', '--show-current'], processOptions);
  if (actualBranch?.status !== 0 || String(actualBranch.stdout || '').trim() !== branch) return { published: false, failureReason: 'implementation-publication-branch-mismatch' };
  const push = runner('git', ['push', '--set-upstream', 'origin', branch], processOptions);
  if (push?.status !== 0) return { published: false, failureReason: 'implementation-branch-push-failed', stage: 'push', exitCode: push?.status ?? null };
  const listArgs = ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number,url,isDraft', '--limit', '1'];
  let listed = runner('gh', listArgs, processOptions);
  if (listed?.status !== 0) return { published: false, failureReason: 'implementation-pr-query-failed', stage: 'pr-query', exitCode: listed?.status ?? null };
  let pullRequest = parsePullRequestList(listed.stdout);
  if (!pullRequest) {
    const title = `${String(issueTitle || `Issue #${issueNumber}`).slice(0, 210)} (#${issueNumber})`;
    const body = `Implements #${issueNumber} from an allowlisted manager preflight.\n\nCreated as a draft by the ModelSpend agent runner after isolated-worktree, clean-commit, model/effort and permission-policy checks. Human review, merge and issue closure are required.`;
    const created = runner('gh', ['pr', 'create', '--repo', repo, '--base', base, '--head', branch, '--draft', '--title', title, '--body', body], processOptions);
    if (created?.status !== 0) return { published: false, failureReason: 'implementation-draft-pr-create-failed', stage: 'pr-create', exitCode: created?.status ?? null };
    listed = runner('gh', listArgs, processOptions);
    pullRequest = listed?.status === 0 ? parsePullRequestList(listed.stdout) : null;
  }
  if (!pullRequest?.number || !pullRequest?.url) return { published: false, failureReason: 'implementation-draft-pr-evidence-missing', stage: 'pr-evidence' };
  if (pullRequest.isDraft !== true) return { published: false, failureReason: 'implementation-pr-not-draft', stage: 'pr-evidence', prNumber: pullRequest.number, prUrl: pullRequest.url };
  return { published: true, failureReason: null, branch, prNumber: pullRequest.number, prUrl: pullRequest.url, draft: true };
}

function parseSinglePullRequest(stdout = '') {
  try { const payload = JSON.parse(String(stdout || '').trim()); return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null; } catch { return null; }
}

export function publishPrContinuation({ workspace, worktreeIdentity, repo, prNumber, env = process.env, runner = spawnSync } = {}) {
  const branch = String(worktreeIdentity?.expectedBranch || '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || '')) || !Number.isInteger(prNumber) || prNumber <= 0 || !workspace?.worktreePath) return { published: false, failureReason: 'pr-continuation-publication-input-invalid' };
  const processOptions = { cwd: workspace.worktreePath, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, env };
  const branchFormat = runner('git', ['check-ref-format', '--branch', branch], processOptions);
  if (branchFormat?.status !== 0) return { published: false, failureReason: 'pr-continuation-publication-branch-invalid' };
  const actualBranch = runner('git', ['branch', '--show-current'], processOptions);
  if (actualBranch?.status !== 0 || String(actualBranch.stdout || '').trim() !== branch) return { published: false, failureReason: 'pr-continuation-publication-branch-mismatch' };
  const committedHeadResult = runner('git', ['rev-parse', 'HEAD'], processOptions);
  const committedHead = committedHeadResult?.status === 0 ? String(committedHeadResult.stdout || '').trim() : null;
  if (!committedHead) return { published: false, failureReason: 'pr-continuation-publication-head-unavailable' };
  const push = runner('git', ['push', 'origin', branch], processOptions);
  if (push?.status !== 0) return { published: false, failureReason: 'pr-continuation-branch-push-failed', stage: 'push', exitCode: push?.status ?? null };
  const view = runner('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'number,state,headRefName,headRefOid,url'], processOptions);
  if (view?.status !== 0) return { published: false, failureReason: 'pr-continuation-publication-pr-query-failed', stage: 'pr-query', exitCode: view?.status ?? null };
  const pullRequest = parseSinglePullRequest(view.stdout);
  if (!pullRequest?.number || !pullRequest?.url) return { published: false, failureReason: 'pr-continuation-publication-pr-evidence-missing', stage: 'pr-evidence' };
  if (pullRequest.number !== prNumber) return { published: false, failureReason: 'pr-continuation-publication-pr-number-changed', stage: 'pr-evidence', prNumber: pullRequest.number };
  if (pullRequest.state !== 'OPEN') return { published: false, failureReason: 'pr-continuation-publication-pr-not-open', stage: 'pr-evidence', prNumber: pullRequest.number };
  if (pullRequest.headRefName !== branch) return { published: false, failureReason: 'pr-continuation-publication-branch-changed', stage: 'pr-evidence', prNumber: pullRequest.number };
  if (pullRequest.headRefOid !== committedHead) return { published: false, failureReason: 'pr-continuation-publication-head-mismatch', stage: 'pr-evidence', prNumber: pullRequest.number, expectedHeadSha: committedHead, observedHeadSha: pullRequest.headRefOid || null };
  return { published: true, failureReason: null, branch, prNumber: pullRequest.number, prUrl: pullRequest.url, headSha: committedHead };
}

async function githubJson(path, token, repo) {
  const url = `https://api.github.com/repos/${repo}${path}`;
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'modelspend-claude-runner' } });
  if (!response.ok) { const body = await response.text(); throw new Error(`GitHub request failed ${response.status} ${response.statusText}: ${body.slice(0, 500)}`); }
  return response.json();
}

export async function fetchIssueAndComments({ repo, issue, token }) {
  const issuePayload = await githubJson(`/issues/${issue}`, token, repo);
  const comments = await githubJson(`/issues/${issue}/comments?per_page=100`, token, repo);
  return { issue: issuePayload, comments };
}

async function fetchOpenPullRequests({ repo, token }) { return githubJson('/pulls?state=open&per_page=50', token, repo); }

async function githubGraphQL(query, variables, token) {
  const response = await fetch('https://api.github.com/graphql', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'modelspend-claude-runner' }, body: JSON.stringify({ query, variables }) });
  if (!response.ok) { const body = await response.text(); throw new Error(`GitHub GraphQL request failed ${response.status} ${response.statusText}: ${body.slice(0, 500)}`); }
  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length > 0) throw new Error(`GitHub GraphQL request returned errors: ${JSON.stringify(payload.errors).slice(0, 500)}`);
  return payload.data;
}

const REVIEW_THREADS_PAGE_LIMIT = 50;
const REVIEW_THREAD_COMMENTS_LIMIT = 20;
const REVIEW_THREAD_COMMENT_BODY_MAX_CHARS = 2000;
const REVIEW_THREADS_QUERY = `\nquery($owner: String!, $name: String!, $pr: Int!) {\n  repository(owner: $owner, name: $name) {\n    pullRequest(number: $pr) {\n      reviewThreads(first: ${REVIEW_THREADS_PAGE_LIMIT}) {\n        pageInfo { hasNextPage }\n        nodes {\n          id\n          isResolved\n          comments(last: ${REVIEW_THREAD_COMMENTS_LIMIT}) {\n            nodes { author { login } body createdAt }\n          }\n        }\n      }\n    }\n  }\n}`;

function boundCommentBody(body) {
  const text = String(body || '');
  if (text.length <= REVIEW_THREAD_COMMENT_BODY_MAX_CHARS) return text;
  const marker = '… [truncated]';
  const retainedChars = Math.max(0, REVIEW_THREAD_COMMENT_BODY_MAX_CHARS - marker.length);
  return `${text.slice(0, retainedChars)}${marker}`;
}

async function fetchPullRequestReviewThreads({ repo, pr, token }) {
  const [owner, name] = String(repo).split('/');
  if (!owner || !name) throw new Error(`Invalid repo "${repo}" for review-thread query`);
  const data = await githubGraphQL(REVIEW_THREADS_QUERY, { owner, name, pr }, token);
  const reviewThreads = data?.repository?.pullRequest?.reviewThreads;
  if (!reviewThreads || !Array.isArray(reviewThreads.nodes) || typeof reviewThreads.pageInfo?.hasNextPage !== 'boolean') throw new Error(`GitHub GraphQL response missing bounded reviewThreads state for ${repo}#${pr}`);
  if (reviewThreads.pageInfo.hasNextPage) throw new Error(`GitHub reports more than ${REVIEW_THREADS_PAGE_LIMIT} review threads for ${repo}#${pr}, exceeding the hard bounded-fetch limit; refusing to paginate`);
  return reviewThreads.nodes.map((node, threadIndex) => {
    if (!node || typeof node.id !== 'string' || node.id.length === 0 || typeof node.isResolved !== 'boolean' || !Array.isArray(node.comments?.nodes)) throw new Error(`GitHub GraphQL response contains malformed review thread at index ${threadIndex} for ${repo}#${pr}`);
    const comments = node.comments.nodes.map((comment, commentIndex) => {
      if (!comment || typeof comment.body !== 'string' || typeof comment.createdAt !== 'string' || (comment.author !== null && typeof comment.author !== 'object')) throw new Error(`GitHub GraphQL response contains malformed review-thread comment at thread ${threadIndex}, comment ${commentIndex} for ${repo}#${pr}`);
      return { author: { login: comment.author?.login || 'unknown' }, body: boundCommentBody(comment.body), createdAt: comment.createdAt };
    });
    return { id: node.id, isResolved: node.isResolved, comments };
  });
}

async function fetchPullRequestReviewContext({ repo, pr, token }) {
  const [pullRequest, reviews, comments, reviewThreads] = await Promise.all([
    githubJson(`/pulls/${pr}`, token, repo), githubJson(`/pulls/${pr}/reviews?per_page=100`, token, repo), githubJson(`/issues/${pr}/comments?per_page=100`, token, repo), fetchPullRequestReviewThreads({ repo, pr, token }),
  ]);
  return { pullRequest, reviews, comments, reviewThreads };
}

export async function findBlockingPrFollowUp({ repo, issue, token }) {
  const openPrs = await fetchOpenPullRequests({ repo, token });
  const candidates = findLinkedOpenPullRequests({ issueNumber: issue, pullRequests: openPrs.map((pr) => ({ number: pr.number, title: pr.title, body: pr.body, headRefName: pr.head?.ref, url: pr.html_url })) });
  for (const candidate of candidates) {
    const { reviews, comments, reviewThreads } = await fetchPullRequestReviewContext({ repo, pr: candidate.number, token });
    const unresolved = detectUnresolvedReviewFollowUp({ reviews, reviewThreads, comments });
    if (unresolved.hasUnresolvedFollowUp) return { pr: candidate, unresolved };
  }
  return null;
}

function writeRunLog({ outputDir, label, issueNumber, payload }) {
  mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(outputDir, `${label || `issue-${issueNumber}`}-${stamp}.json`);
  writeFileSync(logPath, `${JSON.stringify(payload, null, 2)}\n`);
  return logPath;
}

export function defaultQuotaStatePath(outputDir) { return join(outputDir, 'quota-state.json'); }
export function readQuotaPauseState(statePath) { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return null; } }
export function writeQuotaPauseState(statePath, state) { mkdirSync(dirname(statePath), { recursive: true }); writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`); }

export async function runQuotaCheck(args, env = process.env) {
  const quotaStatePath = args.quotaStatePath || defaultQuotaStatePath(args.outputDir);
  const now = new Date();
  const previousState = readQuotaPauseState(quotaStatePath);
  if (!args.forceQuotaCheck && previousState?.lastCheckedAt) {
    const elapsedMs = now.getTime() - new Date(previousState.lastCheckedAt).getTime();
    if (Number.isFinite(elapsedMs) && elapsedMs < 10 * 60 * 1000) {
      const payload = { checked: false, reason: 'too-soon', lastCheckedAt: previousState.lastCheckedAt, minIntervalMs: 10 * 60 * 1000, quotaStatePath };
      console.log(JSON.stringify(payload, null, 2)); return 0;
    }
  }
  const claudeEnv = buildClaudeProcessEnv(env, { inheritProviderAuth: args.inheritProviderAuth });
  const quotaArgs = buildQuotaCheckArgs({});
  const result = spawnSync(args.claudeBin, quotaArgs, { cwd: resolve('.'), encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, env: claudeEnv });
  const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
  const parsed = parseQuotaCheckOutput(combinedOutput, { now, maxSessionUsageBeforeStartPercent: env.CLAUDE_RUNNER_MAX_SESSION_USAGE_BEFORE_START_PERCENT });
  const usageState = { quotaUsage: parsed.quotaUsage || null, sessionPercentUsed: parsed.sessionPercentUsed ?? null, weeklyPercentUsed: parsed.weeklyPercentUsed ?? null, modelWeekPercentUsed: parsed.modelWeekPercentUsed || {}, maxSessionUsageBeforeStartPercent: parsed.maxSessionUsageBeforeStartPercent ?? null };
  let nextState;
  if (parsed.status === 'available') nextState = { status: 'available', lastCheckedAt: now.toISOString(), pausedUntil: null, reason: null, ...usageState };
  else {
    const pause = recordQuotaPause({ reason: parsed.status === 'exhausted' ? 'quota-exhausted' : 'ambiguous-quota-check', matchedPattern: parsed.matchedPattern, resetAt: parsed.resetAt, now });
    nextState = { ...pause, status: parsed.status, lastCheckedAt: now.toISOString(), ...usageState };
  }
  writeQuotaPauseState(quotaStatePath, nextState);
  const payload = { checked: true, status: parsed.status, exitCode: result.status, signal: result.signal, spawnError: result.error ? String(result.error.message || result.error) : null, output: redactSensitiveText(combinedOutput).trim(), quotaStatePath, state: nextState };
  console.log(JSON.stringify(payload, null, 2)); return 0;
}

export function detectExecutionNoop({ execute, status, signal, stdout = '', stderr = '', spawnError = null }) {
  if (!execute) return { noop: false, reason: null };
  if (spawnError) return { noop: true, reason: 'claude-spawn-error' };
  if (signal) return { noop: true, reason: 'claude-killed-by-signal' };
  if (status === 0 && !String(stdout).trim() && !String(stderr).trim()) return { noop: true, reason: 'claude-exited-zero-with-no-output' };
  return { noop: false, reason: null };
}

export const PLAN_ONLY_EXIT_CODE = 2;
export const COST_POLICY_EXIT_CODE = 3;
export const EXECUTION_POLICY_EXIT_CODE = 4;
export const PR_REVIEW_FOLLOWUP_MODE = 'pr-review-followup';
const PLAN_FILE_PATH_PATTERN = /(\/\S*\.claude\/plans\/\S+\.md)/;
const PLAN_ONLY_STDOUT_PATTERNS = [/have not made any code edits/i, /no code edits (?:were|have been) made/i, /only the plan file was written/i, /awaiting plan approval/i];

export function detectPlanOnlyResult({ stdout = '', stderr = '' } = {}) {
  const combined = `${stdout}\n${stderr}`;
  const planPathMatch = combined.match(PLAN_FILE_PATH_PATTERN);
  const signatureMatch = PLAN_ONLY_STDOUT_PATTERNS.some((pattern) => pattern.test(combined));
  if (!planPathMatch && !signatureMatch) return { planProduced: false, planPath: null };
  return { planProduced: true, planPath: planPathMatch ? planPathMatch[1] : null };
}

function finiteNumberOrNull(value) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeUsageRecord(value = {}) {
  return sanitizeClaudeStructuredUsage(value);
}

function sanitizeModelUsage(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([model, usage]) => {
    const tokens = sanitizeUsageRecord(usage);
    const normalized = { ...(tokens || {}), costUsd: finiteNumberOrNull(usage?.costUSD ?? usage?.cost_usd), contextWindow: finiteNumberOrNull(usage?.contextWindow ?? usage?.context_window), maxOutputTokens: finiteNumberOrNull(usage?.maxOutputTokens ?? usage?.max_output_tokens) };
    if (!Object.values(normalized).some((entry) => entry !== null)) return [];
    return [[String(model).slice(0, 160), normalized]];
  }));
}

export function parseClaudeResultEnvelope(stdout = '') {
  const fallback = { parsed: false, subtype: null, isError: false, resultText: String(stdout || ''), errors: [], numTurns: null, totalCostUsd: null, usage: null, modelUsage: {}, hasSessionId: false, accountingAvailable: false };
  const terminalResult = (records) => [...records].reverse().find((record) => record && typeof record === 'object' && !Array.isArray(record) && record.type === 'result') || null;
  let payload;
  const records = String(stdout || '').split(/\r?\n/).filter((line) => line.trim()).flatMap((line) => { try { const parsed = JSON.parse(line); return Array.isArray(parsed) ? parsed : [parsed]; } catch { return []; } });
  try { payload = JSON.parse(String(stdout || '').trim()); if (Array.isArray(payload)) payload = terminalResult(payload); } catch { payload = terminalResult(records); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fallback;
  if (payload.type && payload.type !== 'result') return fallback;
  const usage = sanitizeUsageRecord(payload.usage);
  const modelUsage = sanitizeModelUsage(payload.modelUsage ?? payload.model_usage);
  const numTurns = finiteNumberOrNull(payload.num_turns ?? payload.numTurns);
  const totalCostUsd = finiteNumberOrNull(payload.total_cost_usd ?? payload.totalCostUsd);
  const errors = Array.isArray(payload.errors) ? payload.errors.filter((entry) => typeof entry === 'string').slice(0, 10).map((entry) => entry.slice(0, 500)) : [];
  const providerError = payload.provider_error && typeof payload.provider_error === 'object' ? payload.provider_error : payload.error && typeof payload.error === 'object' ? payload.error : null;
  const providerErrorCode = typeof providerError?.code === 'string' ? providerError.code : null;
  const terminalProviderFailure = payload.is_error === true || payload.isError === true;
  const structuredFailure = terminalProviderFailure && ['quota_exhausted', 'billing_quota_exceeded', 'rate_limited'].includes(providerErrorCode) ? providerErrorCode : null;
  return { parsed: true, subtype: typeof payload.subtype === 'string' ? payload.subtype.slice(0, 120) : null, isError: payload.is_error === true || payload.isError === true, resultText: typeof payload.result === 'string' ? payload.result : '', errors, numTurns, totalCostUsd, usage, modelUsage, hasSessionId: Boolean(payload.session_id || payload.sessionId), accountingAvailable: numTurns !== null || totalCostUsd !== null || usage !== null || Object.keys(modelUsage).length > 0, structuredFailure, retryAt: typeof providerError?.retry_at === 'string' ? providerError.retry_at : null };
}

function extractRestrictedSessionId(stdout = '') {
  const terminalResult = (records) => [...records].reverse().find((record) => record && typeof record === 'object' && !Array.isArray(record) && record.type === 'result') || null;
  const records = String(stdout || '').split(/\r?\n/).filter((line) => line.trim()).flatMap((line) => { try { const parsed = JSON.parse(line); return Array.isArray(parsed) ? parsed : [parsed]; } catch { return []; } });
  let payload;
  try { payload = JSON.parse(String(stdout || '').trim()); if (Array.isArray(payload)) payload = terminalResult(payload); } catch { payload = terminalResult(records); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.type && payload.type !== 'result') return null;
  const sessionId = payload.session_id || payload.sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : null;
}

export function classifyClaudeRunFailure({ status, signal, stdout = '', stderr = '', spawnError = null, executionNoopReason = null, planProduced = false, resultEnvelope = null, executionPhase = EXECUTION_PHASE_PLAN, implementationEvidence = null } = {}) {
  if (spawnError) return 'claude-spawn-error';
  if (signal) return 'claude-killed-by-signal';
  if (planProduced) return executionPhase === EXECUTION_PHASE_IMPLEMENTATION ? 'implementation-returned-plan-only' : 'awaiting-plan-approval';
  if (resultEnvelope?.subtype === 'error_max_turns') return 'provider-execution-limit';
  if (resultEnvelope?.subtype === 'error_max_budget_usd') return 'budget-limit-exhausted';
  if (['quota_exhausted', 'billing_quota_exceeded'].includes(resultEnvelope?.structuredFailure)) return 'quota_paused';
  if (resultEnvelope?.structuredFailure === 'rate_limited') return 'rate_limited';
  if (resultEnvelope?.isError && resultEnvelope?.subtype) return 'unknown_failure';
  const combined = `${stdout}\n${stderr}`;
  if (/reached max turns\s*\(\s*\d+\s*\)/i.test(combined)) return 'provider-execution-limit';
  if (/(?:reached|exceeded|exhausted)\s+(?:the\s+)?max(?:imum)? budget|max(?:imum)? budget(?: usd)?\s+(?:reached|exceeded|exhausted)/i.test(combined)) return 'budget-limit-exhausted';
  if (executionNoopReason) return executionNoopReason;
  if (status !== 0) return `claude-exit-${status ?? 'unknown'}`;
  if (executionPhase === EXECUTION_PHASE_IMPLEMENTATION && implementationEvidence?.failureReason) return implementationEvidence.failureReason;
  return null;
}

export function runOrPlanClaude({ args, env, label, runPlan, prompt, claudeArgs, processRunner = spawnSync }) {
  let planWithPrompt = { ...runPlan, prompt: redactSensitiveText(prompt) };
  if (!args.execute) { const logPath = writeRunLog({ outputDir: args.outputDir, label, payload: planWithPrompt }); console.log(JSON.stringify({ ...planWithPrompt, logPath }, null, 2)); return 0; }
  const policyBlock = (reason, message, details = {}) => {
    const payload = { ...planWithPrompt, ...details, dryRun: false, blocked: true, reason, failureReason: reason, message };
    const logPath = writeRunLog({ outputDir: args.outputDir, label, payload }); console.log(JSON.stringify({ ...payload, logPath }, null, 2)); return EXECUTION_POLICY_EXIT_CODE;
  };
  if (runPlan.executionAuthorization && !runPlan.executionAuthorization.allowed) return policyBlock('execution-authorization-blocked', 'The issue did not satisfy the machine-local manager-preflight authorization policy (and, for implementation, the write opt-in). No Claude process was started.');
  if (!runPlan.costAdmission?.allowed) {
    const payload = { ...planWithPrompt, dryRun: false, blocked: true, reason: 'cost-policy-blocked', failureReason: 'cost-policy-blocked', message: 'The requested model/effort controls exceed this machine\'s unattended policy. No Claude process was started.' };
    const logPath = writeRunLog({ outputDir: args.outputDir, label, payload }); console.log(JSON.stringify({ ...payload, logPath }, null, 2)); return COST_POLICY_EXIT_CODE;
  }
  let implementationWorkspace = null;
  const isPrContinuation = runPlan.mode === PR_REVIEW_FOLLOWUP_MODE;
  if (runPlan.executionPhase === EXECUTION_PHASE_IMPLEMENTATION) {
    const cliCapability = verifyClaudeImplementationCli({ claudeBin: args.claudeBin });
    planWithPrompt = { ...planWithPrompt, cliCapability };
    if (!cliCapability.compatible) return policyBlock('implementation-cli-capability-mismatch', 'The installed Claude CLI does not meet the required minimum implementation-runner version. Upgrade/repair Claude before retrying; no paid process was started.');
    if (args.recoveryMode === 'native_resume' && !args.resumeSession) return policyBlock('native-resume-session-missing', 'native_resume was requested without a --resume-session value. No paid process was started.');
    const implementationCheckout = runPlan.repositoryContext?.implementationCheckout;
    implementationWorkspace = (args.recoveryMode || isPrContinuation) ? prepareContinuationWorkspace({ worktreeIdentity: runPlan.worktreeIdentity, implementationCheckout, env }) : prepareImplementationWorkspace({ worktreeIdentity: runPlan.worktreeIdentity, implementationCheckout, env });
    planWithPrompt = { ...planWithPrompt, workspacePreparation: { allowed: implementationWorkspace.allowed, failureReason: implementationWorkspace.failureReason, baseRef: implementationWorkspace.baseRef || null, baseHead: implementationWorkspace.baseHead || null } };
    if (!implementationWorkspace.allowed) return policyBlock(implementationWorkspace.failureReason || 'implementation-workspace-policy-blocked', 'The runner could not prove exclusive, current worktree ownership. No Claude process was started.');
  }
  const claudeEnv = buildClaudeProcessEnv(env, { inheritProviderAuth: args.inheritProviderAuth });
  const startedAt = new Date().toISOString();
  const result = processRunner(args.claudeBin, claudeArgs, { cwd: implementationProcessCwd(implementationWorkspace), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, env: claudeEnv });
  const resultEnvelope = parseClaudeResultEnvelope(result.stdout || '');
  const resultText = resultEnvelope.parsed ? [resultEnvelope.resultText, ...resultEnvelope.errors].filter(Boolean).join('\n') : String(result.stdout || '');
  const usageAccounting = buildClaudeUsageAccounting({ resultEnvelope, model: runPlan.profile?.model || null, promptCacheMetadata: runPlan.promptCacheMetadata || null, startedAt, finishedAt: new Date().toISOString() });
  if (['quota_exhausted', 'billing_quota_exceeded'].includes(resultEnvelope.structuredFailure)) {
    const implementationEvidence = runPlan.executionPhase === EXECUTION_PHASE_IMPLEMENTATION ? collectImplementationEvidence({ workspace: implementationWorkspace, worktreeIdentity: runPlan.worktreeIdentity }) : null;
    const quotaStatePath = args.quotaStatePath || defaultQuotaStatePath(args.outputDir);
    const resetAt = resultEnvelope.retryAt;
    const pause = recordQuotaPause({ reason: 'quota_paused', matchedPattern: resultEnvelope.structuredFailure, resetAt, now: new Date() });
    writeQuotaPauseState(quotaStatePath, { ...pause, status: 'exhausted', lastCheckedAt: new Date().toISOString() });
    const payload = { ...planWithPrompt, dryRun: false, startedAt, finishedAt: new Date().toISOString(), blocked: true, reason: 'quota_paused', failureReason: 'quota_paused', quotaPaused: true, quotaPauseState: pause, quotaStatePath, exitCode: result.status, signal: result.signal, stdout: redactSensitiveText(resultText), stderr: redactSensitiveText(result.stderr || ''), usageAccounting, implementationEvidence, spawnError: result.error ? String(result.error.message || result.error) : null };
    const logPath = writeRunLog({ outputDir: args.outputDir, label, payload }); console.log(JSON.stringify({ ...payload, stdout: '<see log>', stderr: '<see log>', logPath }, null, 2)); return 1;
  }
  const executionCheck = detectExecutionNoop({ execute: true, status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '', spawnError: result.error });
  const planCheck = detectPlanOnlyResult({ stdout: resultText, stderr: result.stderr || '' });
  let implementationEvidence = runPlan.executionPhase === EXECUTION_PHASE_IMPLEMENTATION ? collectImplementationEvidence({ workspace: implementationWorkspace, worktreeIdentity: runPlan.worktreeIdentity }) : null;
  let implementationPublication = null;
  if (runPlan.executionPhase === EXECUTION_PHASE_IMPLEMENTATION && result.status === 0 && !resultEnvelope.isError && !executionCheck.noop && !planCheck.planProduced && implementationEvidence?.valid) {
    implementationPublication = isPrContinuation
      ? publishPrContinuation({ workspace: implementationWorkspace, worktreeIdentity: runPlan.worktreeIdentity, repo: runPlan.repositoryContext?.implementationRepository || runPlan.repo, prNumber: runPlan.prNumber, env })
      : publishImplementationDraft({ workspace: implementationWorkspace, worktreeIdentity: runPlan.worktreeIdentity, repo: runPlan.repositoryContext?.implementationRepository || runPlan.repo, issueNumber: runPlan.issue, issueTitle: runPlan.issueTitle, env });
    if (!implementationPublication.published) implementationEvidence = { ...implementationEvidence, valid: false, failureReason: implementationPublication.failureReason || 'implementation-draft-publication-failed' };
  }
  const failureReason = classifyClaudeRunFailure({ status: result.status, signal: result.signal, stdout: resultText, stderr: result.stderr || '', spawnError: result.error, executionNoopReason: executionCheck.reason, planProduced: planCheck.planProduced, resultEnvelope, executionPhase: runPlan.executionPhase, implementationEvidence });
  let restrictedRecoveryHandleDigest = null;
  let restrictedHandleBindingDigestValue = null;
  if (args.attemptId && runPlan.executionPhase === EXECUTION_PHASE_IMPLEMENTATION && runPlan.worktreeIdentity && implementationWorkspace?.allowed) {
    try {
      const handleAgent = runPlan.agent?.agentId || 'claude-code-cli';
      const handleModel = runPlan.agent?.model || runPlan.profile?.model || null;
      const handleHarness = runPlan.agent?.agentType || 'claude';
      const checkpointHead = implementationEvidence?.worktree?.head || null;
      const checkpointStatusFingerprint = implementationEvidence?.worktree?.statusFingerprint || null;
      const written = writeRestrictedRecoveryHandle(args.outputDir, args.attemptId, { attemptId: args.attemptId, sessionId: extractRestrictedSessionId(result.stdout || ''), worktreeName: runPlan.worktreeIdentity.name, expectedBranch: runPlan.worktreeIdentity.expectedBranch, checkpointHead, checkpointStatusFingerprint, agent: handleAgent, model: handleModel, harness: handleHarness, capturedAt: new Date().toISOString() });
      restrictedRecoveryHandleDigest = written.digest;
      restrictedHandleBindingDigestValue = restrictedHandleBindingDigest({ attemptId: args.attemptId, agent: handleAgent, model: handleModel, harness: handleHarness, checkpointHead, checkpointStatusFingerprint });
    } catch {}
  }
  const checkpointAvailable = Boolean(implementationEvidence?.worktree?.head);
  const sessionAvailable = resultEnvelope.hasSessionId;
  const recoveryEvidence = { sameProfileAvailable: Boolean(runPlan.profile?.model && runPlan.profile?.effort) };
  const payload = { ...planWithPrompt, dryRun: false, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal, stdout: redactSensitiveText(resultText), stderr: redactSensitiveText(result.stderr || ''), usageAccounting, spawnError: result.error ? String(result.error.message || result.error) : null, executionNoop: executionCheck.noop, executionNoopReason: executionCheck.reason, failureReason, planProduced: planCheck.planProduced, planPath: planCheck.planPath, awaitingPlanApproval: runPlan.executionPhase === EXECUTION_PHASE_PLAN && planCheck.planProduced, implementationEvidence, implementationPublication, checkpointAvailable, sessionAvailable, recoveryEvidence, restrictedRecoveryHandleDigest, restrictedHandleBindingDigest: restrictedHandleBindingDigestValue };
  const logPath = writeRunLog({ outputDir: args.outputDir, label, payload });
  console.log(JSON.stringify({ ...payload, stdout: '<see log>', stderr: '<see log>', logPath }, null, 2));
  if (executionCheck.noop) return 1;
  if (planCheck.planProduced) return runPlan.executionPhase === EXECUTION_PHASE_IMPLEMENTATION ? 1 : PLAN_ONLY_EXIT_CODE;
  if (failureReason) return result.status && result.status !== 0 ? result.status : 1;
  return result.status === null ? 1 : result.status;
}

export async function resolvePrExecutionBinding({ pullRequest, repo, config, env, token }) {
  const linkedIssueNumbers = linkedIssueNumbersFromPr({ title: pullRequest.title || '', body: pullRequest.body || '' });
  const { issue: linkedIssueRecord, comments: linkedIssueComments } = linkedIssueNumbers.length === 1 ? await fetchIssueAndComments({ repo, issue: linkedIssueNumbers[0], token }) : { issue: {}, comments: [] };
  return resolvePrContinuationBinding({ pullRequest, issue: linkedIssueRecord, issueComments: linkedIssueComments, repo, config, env, resolveDispatchIdentity: resolveImplementationDispatchIdentity, prepareWorkspace: prepareContinuationWorkspace, captureEvidence: captureGitRepositoryEvidence });
}

export async function runPrFollowUp(args, env, token, config = {}, { resolveBinding = resolvePrExecutionBinding, run = runOrPlanClaude } = {}) {
  const { pullRequest, reviews, comments, reviewThreads } = await fetchPullRequestReviewContext({ repo: args.repo, pr: args.pr, token });
  const unresolved = detectUnresolvedReviewFollowUp({ reviews, reviewThreads, comments });
  const branch = pullRequest.head?.ref || '(unknown branch)';
  const linkedIssue = linkedIssueNumberFromPr({ body: pullRequest.body, title: pullRequest.title });
  if (!unresolved.hasUnresolvedFollowUp) {
    const payload = { mode: PR_REVIEW_FOLLOWUP_MODE, pr: args.pr, repo: args.repo, hasUnresolvedFollowUp: false, message: `No unresolved review/manager feedback detected on PR #${args.pr}. Nothing to follow up on.` };
    const logPath = writeRunLog({ outputDir: args.outputDir, label: `pr-${args.pr}`, payload }); console.log(JSON.stringify({ ...payload, logPath }, null, 2)); return 0;
  }
  const prompt = buildReviewFollowUpPrompt({ pr: { number: args.pr, title: pullRequest.title, url: pullRequest.html_url }, issueNumber: linkedIssue, branch, unresolved, repo: args.repo });
  const clearContext = shouldUseClear({ noClear: args.noClear, resumeSession: args.resumeSession });
  let continuationBinding = null;
  if (args.execute) {
    continuationBinding = await resolveBinding({ pullRequest, repo: args.repo, config, env, token });
    if (!continuationBinding.allowed) {
      const payload = { mode: PR_REVIEW_FOLLOWUP_MODE, pr: args.pr, repo: args.repo, dryRun: false, blocked: true, reason: continuationBinding.failureReason, failureReason: continuationBinding.failureReason, message: `Safe PR continuation binding refused this follow-up (${continuationBinding.failureReason}). No Claude process was started.` };
      const logPath = writeRunLog({ outputDir: args.outputDir, label: `pr-${args.pr}`, payload }); console.log(JSON.stringify({ ...payload, logPath }, null, 2)); return EXECUTION_POLICY_EXIT_CODE;
    }
  }
  const implementationToolPolicy = continuationBinding ? buildImplementationToolPolicy({ expectedBranch: continuationBinding.worktreeIdentity.expectedBranch, approvedBranch: continuationBinding.dispatchAuthority?.branch }) : null;
  const profile = continuationBinding
    ? resolveProfile(continuationBinding.profileName, { model: continuationBinding.managerExecutionMeta?.model, effort: continuationBinding.managerExecutionMeta?.effort, permissionMode: continuationBinding.executionAuthorization.permissionMode, tools: implementationToolPolicy?.tools, allowedTools: implementationToolPolicy?.allowedTools, disallowedTools: implementationToolPolicy?.disallowedTools, worktreeName: nativeClaudeWorktreeName(continuationBinding.worktreeIdentity), strictMcpConfig: implementationToolPolicy?.strictMcpConfig, disableSlashCommands: implementationToolPolicy?.disableSlashCommands, settings: implementationToolPolicy?.settings, settingSources: implementationToolPolicy?.settingSources }, env)
    : resolveProfile(inferProfile({ explicitProfile: args.profile, issue: { title: pullRequest.title, body: pullRequest.body } }), { model: args.model, effort: args.effort }, env);
  const claudeArgs = buildClaudeArgs({ prompt, profile, resumeSession: args.resumeSession });
  const runPlan = { mode: PR_REVIEW_FOLLOWUP_MODE, dryRun: !args.execute, pr: args.pr, prNumber: continuationBinding?.prNumber ?? args.pr, repo: args.repo, linkedIssue, branch, reasons: unresolved.reasons, repositoryContext: continuationBinding?.repositoryContext || null, executionPhase: continuationBinding ? EXECUTION_PHASE_IMPLEMENTATION : undefined, executionAuthorization: continuationBinding?.executionAuthorization || null, worktreeIdentity: continuationBinding?.worktreeIdentity || null, implementationToolPolicy: implementationToolPolicy ? { tools: implementationToolPolicy.tools, allowedToolRuleCount: implementationToolPolicy.allowedToolRuleCount, disallowedToolRuleCount: implementationToolPolicy.disallowedToolRuleCount, strictMcpConfig: implementationToolPolicy.strictMcpConfig, disableSlashCommands: implementationToolPolicy.disableSlashCommands } : null, preRunHeadSha: continuationBinding?.preRunHeadSha || null, profile, costAdmission: evaluateClaudeCostAdmission(profile, env), agent: agentRunMetadata(resolveAgentById('claude-code-cli'), profile), clearContext, claudeCommand: args.claudeBin, inheritProviderAuth: args.inheritProviderAuth, removedClaudeProviderAuthKeys: removedClaudeProviderAuthKeys(env, { inheritProviderAuth: args.inheritProviderAuth }), claudeArgsPreview: redactExecutableArgs(claudeArgs, { redactFinalAsPrompt: true }) };
  return run({ args, env, label: `pr-${args.pr}`, runPlan, prompt, claudeArgs });
}

export function assertConfiguredRepositoryIdentity({ configPath, config, repo }) {
  if (!configPath) return;
  if (repo !== config.githubRepo) throw new Error(`Repository override ${repo} does not match configured repository ${config.githubRepo}`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const configPath = resolveConfigPath(argv, env);
  const config = loadAgentRunnerConfig({ argv, env, configPath });
  assertProjectScopedEnv({ config, configPath, env });
  const args = parseArgs(stripConfigArgs(argv), { defaultRepo: configPath ? config.githubRepo : (env.GITHUB_REPOSITORY || DEFAULT_REPO) });
  assertConfiguredRepositoryIdentity({ configPath, config, repo: args.repo });
  if (args.help) { printHelp(); return 0; }
  if (args.checkQuota) return runQuotaCheck(args, env);
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) throw new Error('Missing GITHUB_TOKEN or GH_TOKEN environment variable');
  const quotaStatePath = args.quotaStatePath || defaultQuotaStatePath(args.outputDir);
  const pauseEval = evaluateQuotaPauseState(readQuotaPauseState(quotaStatePath), {});
  if (pauseEval.paused) {
    const payload = { blocked: true, reason: 'quota-paused', pausedUntil: pauseEval.pausedUntil.toISOString(), quotaStatePath, message: 'Claude quota is paused after a detected exhaustion/rate-limit signal. Resume is automatic once pausedUntil passes, or run --check-quota (at least 10 minutes after the last check) to re-check now. This never bypasses the underlying limit.' };
    console.log(JSON.stringify(payload, null, 2)); return 0;
  }
  if (args.pr) return runPrFollowUp(args, env, token, config);
  if (!args.issue) throw new Error('Missing required --issue <number> (or --pr <number> for review follow-up mode)');
  if (!args.skipPrFollowUpCheck) {
    const blockingPr = await findBlockingPrFollowUp({ repo: args.repo, issue: args.issue, token });
    if (blockingPr) {
      const payload = { blocked: true, reason: 'unresolved-pr-review-followup', issue: args.issue, pr: blockingPr.pr.number, prUrl: blockingPr.pr.url || null, reasons: blockingPr.unresolved.reasons, message: `PR #${blockingPr.pr.number} linked to issue #${args.issue} has unresolved review/manager feedback. Run --pr ${blockingPr.pr.number} to generate a follow-up prompt before starting new issue work. Pass --skip-pr-followup-check to override.` };
      console.log(JSON.stringify(payload, null, 2)); return 0;
    }
  }
  const { issue, comments } = await fetchIssueAndComments({ repo: args.repo, issue: args.issue, token });
  const managerAuthority = resolveCurrentManagerAuthority(comments);
  if (!managerAuthority.allowed) throw new Error(`No current canonical manager preflight authority found on issue #${args.issue}: ${managerAuthority.reason}`);
  const command = null;
  const currentPreflight = managerAuthority.authority.comment;
  const dispatchIdentity = resolveImplementationDispatchIdentity({ issue, command, currentPreflight, config, env, argsRepo: args.repo, argsProfile: args.profile, argsModel: args.model, argsEffort: args.effort });
  if (!dispatchIdentity.ok) {
    const payload = { blocked: true, reason: dispatchIdentity.failureReason, issue: args.issue, message: `The dispatch authority (repository/branch) for issue #${args.issue} could not be resolved unambiguously (${dispatchIdentity.failureReason}). No Claude process was started.` };
    console.log(JSON.stringify(payload, null, 2)); return EXECUTION_POLICY_EXIT_CODE;
  }
  const { preflight, selectionMode, managerExecutionMeta, dispatchAuthority, repositoryContext, profileName, executionAuthorization, sourceCommentIdentity, sourcePreflightCommentIdentity, worktreeIdentity } = dispatchIdentity;
  const implementationToolPolicy = worktreeIdentity ? buildImplementationToolPolicy({ expectedBranch: worktreeIdentity.expectedBranch, approvedBranch: dispatchAuthority?.branch }) : null;
  const profile = resolveProfile(profileName, { model: args.model || managerExecutionMeta.model, effort: args.effort || managerExecutionMeta.effort, permissionMode: executionAuthorization.permissionMode, tools: implementationToolPolicy?.tools, allowedTools: implementationToolPolicy?.allowedTools, disallowedTools: implementationToolPolicy?.disallowedTools, worktreeName: nativeClaudeWorktreeName(worktreeIdentity), strictMcpConfig: implementationToolPolicy?.strictMcpConfig, disableSlashCommands: implementationToolPolicy?.disableSlashCommands, settings: implementationToolPolicy?.settings, settingSources: implementationToolPolicy?.settingSources }, env);
  const clearContext = shouldUseClear({ noClear: args.noClear, resumeSession: args.resumeSession });
  const prompt = command
    ? buildClaudePrompt({ issue: { number: args.issue, title: issue.title }, commandText: command.body, currentPreflight, profile, clearContext, executionPhase: executionAuthorization.phase, worktreeIdentity, repositoryContext })
    : buildPreflightDirectPrompt({ issue: { number: args.issue, title: issue.title, body: issue.body }, preflight, profile, clearContext, executionPhase: executionAuthorization.phase, worktreeIdentity, repositoryContext });
  const claudeArgs = buildClaudeArgs({ prompt, profile, resumeSession: args.resumeSession });
  const promptCacheMetadata = command
    ? claudePromptCacheMetadata({ issue: { number: args.issue, title: issue.title }, commandText: command.body, currentPreflight, profile, clearContext, executionPhase: executionAuthorization.phase, worktreeIdentity, repositoryContext })
    : claudePromptCacheMetadata({ issue: { number: args.issue, title: issue.title, body: issue.body }, preflight, selectionMode: 'preflight-direct', profile, clearContext, executionPhase: executionAuthorization.phase, worktreeIdentity, repositoryContext });
  const runPlan = { dryRun: !args.execute, issue: args.issue, issueTitle: issue.title, repo: args.repo, repositoryContext, selectionMode, promptCacheMetadata, commandKind: command?.kind || null, commandHeading: command?.heading || null, sourceCommentId: command?.sourceCommentId || null, sourceCommentIdentity, sourcePreflightCommentIdentity, sourcePreflightRevision: managerAuthority.authority.revision, sourcePreflightFingerprint: managerAuthority.authority.fingerprint, sourcePreflightAuthorityKey: managerAuthority.authority.authorityKey, sourcePreflightCommentId: commentRevision(sourcePreflightCommentIdentity), executionPhase: executionAuthorization.phase, executionAuthorization, worktreeIdentity, implementationToolPolicy: implementationToolPolicy ? { tools: implementationToolPolicy.tools, allowedToolRuleCount: implementationToolPolicy.allowedToolRuleCount, disallowedToolRuleCount: implementationToolPolicy.disallowedToolRuleCount, strictMcpConfig: implementationToolPolicy.strictMcpConfig, disableSlashCommands: implementationToolPolicy.disableSlashCommands } : null, profile, costAdmission: evaluateClaudeCostAdmission(profile, env), agent: agentRunMetadata(resolveAgentById('claude-code-cli'), profile), clearContext, claudeCommand: args.claudeBin, inheritProviderAuth: args.inheritProviderAuth, removedClaudeProviderAuthKeys: removedClaudeProviderAuthKeys(env, { inheritProviderAuth: args.inheritProviderAuth }), claudeArgsPreview: redactExecutableArgs(claudeArgs, { redactFinalAsPrompt: true }) };
  return runOrPlanClaude({ args, env, label: `issue-${args.issue}`, runPlan, prompt, claudeArgs });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message || error); process.exitCode = 1; });
}
