#!/usr/bin/env node

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
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
  CONTEXT_BUDGET_POLICY_REVISION,
  chooseContextBudget,
  decideSessionLifecycle,
} from './agent-runner-context-budget.mjs';
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
  renderExecutableReviewInstructions,
  selectExecutableReviewFeedback,
} from './claude-runner-review-followup.mjs';
import { resolvePrContinuationBinding } from './agent-runner-pr-continuation-binding.mjs';
import { resolveManagerContinuationAuthority } from './agent-runner-manager-continuation-authority.mjs';
import { acquireImplementationSlot } from './agent-runner-implementation-slot.mjs';
import {
  agentRunMetadata,
  buildAgentCommandArgs,
  resolveAgentById,
} from './agent-runner-agents.mjs';
import {
  resolveCurrentManagerAuthority,
  resolveManagerPreflightExecutionMetadata,
  resolveManagerPreflightRequiredCapabilities,
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
import {
  readRestrictedRecoveryHandle,
  restrictedHandleBindingDigest,
  writeRestrictedRecoveryHandle,
} from './claude-runner-recovery-adapter.mjs';
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
  buildPrContinuationScopeSection,
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
  sanitizeClaudeModelUsage,
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
    // Unattended planning must not opt into Opus/xhigh implicitly. Operators
    // can still approve those controls explicitly through the cost policy.
    defaultModel: 'sonnet',
    effort: 'high',
    permissionMode: 'plan',
  }
};

// The bounded canonical model-identifier vocabulary this runner ever passes
// to the `claude` CLI's `--model` flag: every `DEFAULT_PROFILES` entry's
// `defaultModel`, plus `opus` (only reachable via an explicit machine-local
// `CLAUDE_RUNNER_ALLOW_OPUS` opt-in, see `evaluateClaudeCostAdmission`
// below). Membership is exact and case-sensitive -- a merely syntactically
// safe token, or a differently-cased/trimmed alias, is not evidence a
// captured or operator-supplied model is one this runner actually supports
// (#148); historical-reconciliation and identity-guard callers must never
// normalize a value before checking it against this list.
export const SUPPORTED_MODEL_IDS = Object.freeze(['haiku', 'sonnet', 'opus']);

export function isSupportedModelId(model) {
  return typeof model === 'string' && SUPPORTED_MODEL_IDS.includes(model);
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}


/**
 * Fail-closed admission for unattended subscription-backed Claude controls.
 *
 * Provider availability is governed by the mandatory live quota/headroom
 * path. This admission gate deliberately contains no dollar-denominated
 * attempt limit. It only protects model/effort escalation.
 */
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
  console.log(`Claude runner

Usage:
  node scripts/ops/claude-runner.mjs --issue <number> [--execute]
  node scripts/ops/claude-runner.mjs --pr <number> [--execute]
  node scripts/ops/claude-runner.mjs --check-quota

Issue execution phases:
  implementation  Default for docs/narrow/complex issues with a current manager preflight. Requires machine-local opt-in and an allowlisted preflight author. Uses dontAsk, an explicit tool allowlist, and an isolated Git worktree bound to manager branch authority.
  plan            Default only for critical profiles, or when the current command/preflight says Phase: plan. Never counts as implementation.

Required implementation policy:
  CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=true
  CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS=<comma-separated GitHub logins>

Issue text cannot override permission mode or tool policy. The runner never enables bypassPermissions.

Options:
  --issue <number>          GitHub issue with a current canonical immutable manager preflight packet
  --pr <number>             Generate (and optionally run) a PR review follow-up prompt instead of issue work
  --repo <owner/name>       GitHub repository, defaults to ${DEFAULT_REPO}
  --execute                 Actually run Claude. Default is dry-run.
  --profile <name>          docs | narrow | complex | critical
  --model <model>           Override profile model. Prefer env vars for durable config.
  --effort <level>          low | medium | high | xhigh | max
  --resume-session <name>   Resume a matching Claude session; skips clear by default
  --no-clear                Skip clear-context instruction for new task. Not recommended.
  --inherit-provider-auth   Pass Anthropic/Bedrock/Vertex provider auth env vars through to Claude. Default is to strip them.
  --output-dir <path>       Local log output directory
  --check-quota             Run a conservative /quota check and update the local pause state. Does not touch GitHub issues/PRs.
  --force-quota-check       Bypass the 10-minute minimum spacing between --check-quota invocations (operator override; still a check, never a limit bypass)
  --quota-state-path <path> Override the local quota pause-state file (default: <output-dir>/quota-state.json)
  --skip-pr-followup-check  Operator override to skip the linked-PR unresolved-review-followup gate before starting --issue work

Exit codes (--execute mode):
  0    Claude produced verified repository-change evidence.
  1    Execution failed, produced no implementation artifact, or returned another plan during implementation.
  ${PLAN_ONLY_EXIT_CODE}    Explicit plan-only run completed; awaiting approval/continuation.
  ${COST_POLICY_EXIT_CODE}    Machine-local model/effort policy blocked the run before Claude started.
  ${EXECUTION_POLICY_EXIT_CODE}    Authorization, CLI capability, or isolated-worktree policy blocked the run before Claude started.
`);
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

  // Infer only from the durable title/labels. Bodies and preflight packets
  // routinely contain negative guardrail prose such as "do not touch
  // production/security"; treating those words as positive risk signals
  // promoted #658 to the most expensive profile. Proceed commands can still
  // choose a profile through explicit `Profile:` metadata before this
  // fallback runs.
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

function contextTaskClassForClaudeProfile(profile = {}) {
  const name = String(profile?.profile || '').trim().toLowerCase();
  if (name === 'docs') return 'routine';
  if (name === 'narrow') return 'narrow';
  if (name === 'complex') return 'complex';
  if (name === 'critical') return 'critical';
  return 'normal';
}

export function buildClaudeContextPolicyShadow({
  taskIdentity = {},
  profile = {},
  resumeSession = null,
  recoveryMode = null,
  clearContext = true,
} = {}) {
  const actualResumeRequested = Boolean(resumeSession);
  const identityComplete = Boolean(
    taskIdentity?.projectId
    && taskIdentity?.githubRepo
    && Number.isInteger(taskIdentity?.issueNumber)
    && taskIdentity.issueNumber > 0
  );

  let lifecycle;
  if (!actualResumeRequested) {
    lifecycle = decideSessionLifecycle({
      taskIdentity,
      session: null,
    });
  } else if (!recoveryMode) {
    lifecycle = Object.freeze({
      decision: 'provider-context-incompatible',
      resume: false,
      compact: false,
      reason: 'session-binding-unproven',
    });
  } else if (!identityComplete) {
    lifecycle = Object.freeze({
      decision: 'provider-context-incompatible',
      resume: false,
      compact: false,
      reason: 'task-identity-incomplete',
    });
  } else {
    lifecycle = decideSessionLifecycle({
      taskIdentity,
      session: {
        sessionId: resumeSession,
        identity: taskIdentity,
        relevance: 'high',
      },
      recovery: {
        requiresExactSession: true,
        sessionId: resumeSession,
      },
    });
  }

  const taskClass = contextTaskClassForClaudeProfile(profile);
  const budget = chooseContextBudget({
    taskClass,
    risk: taskClass === 'critical' ? 'critical' : 'normal',
  });

  const actualClearContext = clearContext === true;
  const behaviourMatchesPolicy = lifecycle.resume === true
    ? actualResumeRequested && !actualClearContext
    : !actualResumeRequested && actualClearContext;

  return Object.freeze({
    policyRevision: CONTEXT_BUDGET_POLICY_REVISION,
    taskClass: budget.taskClass,
    lifecycleDecision: lifecycle.decision,
    lifecycleReason: lifecycle.reason,
    policyResume: lifecycle.resume === true,
    policyCompact: lifecycle.compact === true,
    actualResumeRequested,
    actualClearContext,
    behaviourMatchesPolicy,
    maxOutputBytes: budget.maxOutputBytes,
    measurementOnly: true,
  });
}

export function buildClaudeOutputBudgetShadow({ profile = {}, output = '' } = {}) {
  const taskClass = contextTaskClassForClaudeProfile(profile);
  const budget = chooseContextBudget({
    taskClass,
    risk: taskClass === 'critical' ? 'critical' : 'normal',
  });
  const measuredOutputBytes = Buffer.byteLength(String(output ?? ''), 'utf8');

  return Object.freeze({
    policyRevision: CONTEXT_BUDGET_POLICY_REVISION,
    taskClass: budget.taskClass,
    maxOutputBytes: budget.maxOutputBytes,
    measuredOutputBytes,
    outputWithinTaskBudget: measuredOutputBytes <= budget.maxOutputBytes,
    overBudgetBytes: Math.max(0, measuredOutputBytes - budget.maxOutputBytes),
    measurementBasis: 'terminal-result-text-plus-errors',
    measurementOnly: true,
  });
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

/**
 * #193 stable-prefix compiler: builds each of the compiled prompt's logical
 * sections in the required order (safety/authority invariants; repository
 * instruction contract; execution-phase invariants; evidence schema;
 * adapter-specific stable instructions; dynamic task identity/profile; issue
 * body/manager-packet mutable evidence; final task-specific request) and
 * returns both the assembled prompt and its stable/dynamic halves so callers
 * can derive bounded cache metadata without re-parsing the prompt text.
 */
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

/**
 * Canonical manager-packet prompt. The runner constructs the execution
 * envelope from the issue plus the exact immutable packet; historical
 * proceed/continue comments are not relayed as authority.
 */
export function buildPreflightDirectPrompt({ issue, preflight, profile, clearContext, executionPhase = profile?.permissionMode === 'plan' ? EXECUTION_PHASE_PLAN : EXECUTION_PHASE_IMPLEMENTATION, worktreeIdentity = null, repositoryContext = null }) {
  return buildClaudePromptSections({
    issue, preflight, selectionMode: 'preflight-direct', profile, clearContext, executionPhase, worktreeIdentity, repositoryContext,
  }).prompt;
}

/**
 * #193 bounded cache-aware metadata for the exact prompt a run compiled.
 * Never persists prompt text -- only content-addressed fingerprints and
 * locally measurable size estimates (see claude-runner-prompt-compiler.mjs).
 */
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

/**
 * #242 defect 1: compile an authorised PR review continuation through the
 * *same* canonical stable-prefix compiler every other implementation run
 * uses, instead of the separate review-only prompt builder.
 *
 * The failed field acceptance is exactly what that divergence costs: the
 * review-only prompt never carried the implementation-phase invariant that
 * tells the worker to "finish with a clean commit on that exact branch using
 * `git commit --no-verify ...`", so the worker made the requested edit and
 * stopped, and the run terminated as `implementation-uncommitted-changes`.
 *
 * Nothing is re-worded here. The safety/authority invariants, repository
 * instruction contract, implementation-phase invariants, evidence schema,
 * adapter identity, task identity and worktree assignment are the identical
 * shared sections in the identical order, so a continuation and a normal
 * implementation of the same issue share the stable prefix and the same
 * #193/#194/#248 cache/telemetry contract. Only the mutable evidence differs:
 * the bounded, trusted review feedback replaces the manager-packet body,
 * preceded by one additional *stable* continuation-scope bound.
 */
export function buildPrContinuationPromptSections({
  issue, pullRequest, prNumber, branch, instructions = [], profile, clearContext,
  worktreeIdentity = null, repositoryContext = null, authorityRevision = null,
}) {
  const clearPrefix = clearContext
    ? 'Start a fresh task context. Do not carry assumptions or files from any previous Claude task.\n\n'
    : '';
  const modeLine = 'Selection mode: pr-continuation — the already-consumed manager packet for the linked issue is read-only continuation identity. This run creates no new claim and consumes no new manager authority.';

  const stableSections = [
    buildSafetyAuthorityInvariantsSection(),
    buildRepositoryInstructionContractSection(repositoryInstructionPaths(repositoryContext)),
    buildExecutionPhaseInvariantsSection(EXECUTION_PHASE_IMPLEMENTATION),
    buildPrContinuationScopeSection(),
    buildEvidenceSchemaSection(),
    buildClaudeAdapterIdentitySection({ repositoryIdentityLine: repositoryIdentityLine(repositoryContext), modeLine }),
  ];

  const dynamicSections = [
    buildDynamicTaskIdentitySection({ issue, profile }),
    buildWorktreeAssignmentSection(EXECUTION_PHASE_IMPLEMENTATION, worktreeIdentity),
    joinSections([
      `Continuing pull request #${prNumber} on branch \`${branch}\` (linked issue #${issue.number}${authorityRevision ? `, manager authority ${authorityRevision}` : ''}).`,
      `Issue body:\n\n${issue.body || '(no issue body)'}`,
      `Unresolved review feedback to address (bounded correction input, not new authority):\n\n${renderExecutableReviewInstructions(instructions)}`,
    ]),
    buildFinalRequestSection(EXECUTION_PHASE_IMPLEMENTATION),
  ];

  return compilePrompt({ clearPrefix, stableSections, dynamicSections });
}

/**
 * Bounded #193 cache metadata for a compiled continuation prompt, produced by
 * the same `buildPromptCacheMetadata` contract as normal issue execution so
 * direct PR continuation stops reporting `stablePrefixFingerprint: null`.
 */
export function prContinuationPromptCacheMetadata(input) {
  const { stableText, dynamicText } = buildPrContinuationPromptSections(input);
  return buildPromptCacheMetadata({
    stableText,
    dynamicText,
    adapterId: 'claude-code-cli',
    model: input?.profile?.model,
    profile: input?.profile?.profile,
    cacheStrategy: 'provider-managed',
  });
}

/**
 * Single derivation boundary for the implementation dispatch identity a
 * fresh (non-recovery) attempt is built from: repository context, execution
 * phase/authorization and the deterministic worktree/branch identity. Both
 * this module's own `main()` (which actually runs Claude) and
 * `claude-runner-cron.mjs`'s scheduler pre-claim workspace-ownership check
 * (#686) call this exact function so they can never derive two different
 * `worktreeIdentity` values for the same command/preflight pair — a
 * scheduler check that inspected the wrong worktree would guard nothing.
 */
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
  // Legacy generic-parser metadata: kept only for `resolveDispatchAuthority()`'s
  // repository/branch conflict detection and `evaluateExecutionAuthorization()`'s
  // `execution_phase`/`permission_mode` checks below, neither of which #221's
  // canonical resolver covers. Profile/model/effort must come from
  // the canonical resolver (#223) instead of this free-form parser.
  const executionMeta = parseKeyValueBlock(currentPreflight.body || '');
  const managerExecutionMeta = resolveManagerPreflightExecutionMetadata(currentPreflight);

  // Repository and branch authority (#56) are resolved and verified before
  // anything else in this function -- profile inference, execution
  // authorization, and worktree identity all depend on (or are superseded
  // by) this result, and every caller of this function gates claim/attempt/
  // mutation/worker-launch on `ok` before using any of them.
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

  const {
    baseRef, baseHead, rootPath, rootBefore, worktreePath,
  } = availability;
  const expectedBranch = String(worktreeIdentity?.expectedBranch || '').trim();
  const nativeWorktreeName = nativeClaudeWorktreeName(worktreeIdentity);
  if (!nativeWorktreeName) {
    const branchFormat = runGit(['check-ref-format', '--branch', expectedBranch], { cwd: rootPath, runner });
    if (branchFormat?.status !== 0) {
      return { allowed: false, failureReason: 'implementation-approved-branch-invalid', baseRef, baseHead, rootPath };
    }
    mkdirSync(dirname(worktreePath), { recursive: true });
    const createResult = runGit(['worktree', 'add', '--quiet', '-b', expectedBranch, worktreePath, baseHead], { cwd: rootPath, runner });
    if (createResult?.status !== 0) {
      return { allowed: false, failureReason: 'implementation-worktree-create-failed', baseRef, baseHead, rootPath, worktreePath };
    }
    const worktreeBefore = captureGitRepositoryEvidence({ cwd: worktreePath, includeUntracked: true, runner });
    if (!worktreeBefore) {
      return { allowed: false, failureReason: 'implementation-worktree-evidence-unavailable', baseRef, baseHead, rootPath, worktreePath };
    }
    if (worktreeBefore.branch !== expectedBranch) {
      return { allowed: false, failureReason: 'implementation-worktree-branch-mismatch', baseRef, baseHead, rootPath, worktreePath };
    }
    if (worktreeBefore.head !== baseHead) {
      return { allowed: false, failureReason: 'implementation-worktree-base-mismatch', baseRef, baseHead, rootPath, worktreePath };
    }
    if (worktreeBefore.dirtyEntryCount !== 0) {
      return { allowed: false, failureReason: 'implementation-worktree-dirty-before-launch', baseRef, baseHead, rootPath, worktreePath };
    }
  }

  return {
    ...availability,
    workspacePreparedByRunner: !nativeWorktreeName,
  };
}

const CONTINUATION_HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function pathHasUnownedContent(path) {
  if (!existsSync(path)) return false;
  try {
    return readdirSync(path).length > 0;
  } catch {
    // Exists but is not a readable directory (e.g. a stray file) — treat as
    // a conflicting target rather than silently overwriting it.
    return true;
  }
}

function parseWorktreeListEntries(worktreeListText) {
  return String(worktreeListText || '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const pathLine = lines.find((line) => line.startsWith('worktree '));
      const branchLine = lines.find((line) => line.startsWith('branch refs/heads/'));
      return {
        path: pathLine ? pathLine.slice('worktree '.length).trim() : null,
        branch: branchLine ? branchLine.slice('branch refs/heads/'.length).trim() : null,
      };
    });
}

/**
 * #314: reconstruct only the deterministic local runner worktree for an
 * already-authorised, already-published PR branch when it is genuinely
 * absent — never a new remote branch, never a different SHA. Every check is
 * read-only proof until the single `git worktree add` at the very end, and
 * any failed proof returns a bounded pre-provider refusal without touching
 * an existing path, branch, or worktree it does not own.
 */
function rehydrateContinuationWorktree({
  rootPath, worktreePath, expectedBranch, expectedHeadSha, worktreeList, remote = 'origin', baseRef, runner,
}) {
  const fail = (failureReason) => ({ allowed: false, failureReason, baseRef, rootPath, worktreePath });

  const entries = parseWorktreeListEntries(worktreeList);
  if (entries.some((entry) => entry.path === worktreePath)) {
    return fail('continuation-worktree-rehydrate-path-registration-conflict');
  }
  if (entries.some((entry) => entry.branch === expectedBranch)) {
    return fail('continuation-worktree-rehydrate-branch-owned-elsewhere');
  }
  if (pathHasUnownedContent(worktreePath)) {
    return fail('continuation-worktree-rehydrate-target-path-conflict');
  }

  const localBranchResult = runGit(['show-ref', '--verify', '--quiet', `refs/heads/${expectedBranch}`], { cwd: rootPath, runner });
  const localBranchExists = localBranchResult?.status === 0;
  if (localBranchExists) {
    const localBranchHead = successfulGitText(['rev-parse', `refs/heads/${expectedBranch}`], { cwd: rootPath, runner });
    if (localBranchHead !== expectedHeadSha) {
      return fail('continuation-worktree-rehydrate-local-branch-mismatch');
    }
  }

  const fetchResult = runGit(['fetch', '--quiet', remote, expectedBranch], { cwd: rootPath, runner });
  if (fetchResult?.status !== 0) {
    return fail('continuation-worktree-rehydrate-remote-fetch-failed');
  }
  const remoteHead = successfulGitText(['rev-parse', `refs/remotes/${remote}/${expectedBranch}`], { cwd: rootPath, runner });
  if (!remoteHead || remoteHead !== expectedHeadSha) {
    return fail('continuation-worktree-rehydrate-remote-head-mismatch');
  }

  mkdirSync(dirname(worktreePath), { recursive: true });
  const createArgs = localBranchExists
    ? ['worktree', 'add', '--quiet', worktreePath, expectedBranch]
    : ['worktree', 'add', '--quiet', '-b', expectedBranch, worktreePath, `refs/remotes/${remote}/${expectedBranch}`];
  const createResult = runGit(createArgs, { cwd: rootPath, runner });
  if (createResult?.status !== 0) {
    return fail('continuation-worktree-rehydrate-create-failed');
  }

  const worktreeAfter = captureGitRepositoryEvidence({ cwd: worktreePath, includeUntracked: true, runner });
  if (!worktreeAfter) {
    return fail('continuation-worktree-rehydrate-evidence-unavailable');
  }
  if (worktreeAfter.branch !== expectedBranch || worktreeAfter.head !== expectedHeadSha || worktreeAfter.dirtyEntryCount !== 0) {
    return fail('continuation-worktree-rehydrate-post-create-mismatch');
  }

  return {
    allowed: true, failureReason: null, baseRef, rootPath, worktreePath, baseHead: worktreeAfter.head,
  };
}

/**
 * The `native_resume`/`same_agent_continuation` counterpart to
 * `prepareImplementationWorkspace`. A fresh attempt must refuse an existing
 * branch/worktree (see above); a recovery re-invocation must require the
 * opposite — the exact preserved worktree/branch from the original attempt,
 * matching the deterministic identity derived from the same issue/comment
 * (#698 finding 2). Never creates a new worktree or branch.
 *
 * #314: when the deterministic worktree is genuinely absent and the caller
 * positively supplies `rehydrate.expectedHeadSha` (the exact, freshly
 * re-read PR head this continuation is bound to), the runner-owned local
 * worktree for the already-existing remote branch may be reconstructed at
 * that exact SHA. Without `rehydrate`, or when the proof fails, this
 * function is unchanged: a missing worktree/branch is a bounded refusal and
 * nothing is created.
 */
export function prepareContinuationWorkspace({
  worktreeIdentity, implementationCheckout, env = process.env, runner = spawnSync, rehydrate = null,
} = {}) {
  const baseRef = String(env.CLAUDE_RUNNER_BASE_REF || 'origin/main').trim();
  if (!/^origin\/[A-Za-z0-9._/-]+$/.test(baseRef)) {
    return { allowed: false, failureReason: 'continuation-base-ref-invalid', baseRef };
  }

  const searchCwd = implementationCheckout ? resolve(implementationCheckout) : resolve('.');
  const rootResult = runGit(['rev-parse', '--show-toplevel'], { cwd: searchCwd, runner });
  const rootPath = rootResult?.status === 0 ? String(rootResult.stdout || '').trim() : '';
  if (!rootPath) return { allowed: false, failureReason: 'continuation-repository-root-unavailable', baseRef };

  const expectedBranch = worktreeIdentity?.expectedBranch;
  const branchResult = runGit(['show-ref', '--verify', '--quiet', `refs/heads/${expectedBranch}`], { cwd: rootPath, runner });
  const localBranchExists = branchResult?.status === 0;
  const worktreeList = successfulGitText(['worktree', 'list', '--porcelain'], { cwd: rootPath, runner }) || '';
  const worktreeEntryPresent = localBranchExists && worktreeList.split(/\n\s*\n/)
    .some((entry) => entry.includes(`/.claude/worktrees/${worktreeIdentity?.name}`) && entry.includes(`branch refs/heads/${expectedBranch}`));

  if (!worktreeEntryPresent) {
    const expectedHeadSha = rehydrate?.expectedHeadSha;
    const rehydrationRequested = typeof expectedHeadSha === 'string' && CONTINUATION_HEAD_SHA_PATTERN.test(expectedHeadSha);
    if (!rehydrationRequested) {
      return { allowed: false, failureReason: localBranchExists ? 'continuation-worktree-missing' : 'continuation-branch-missing', baseRef, rootPath };
    }

    const worktreePath = join(rootPath, '.claude', 'worktrees', worktreeIdentity?.name || '');
    const rehydration = rehydrateContinuationWorktree({
      rootPath,
      worktreePath,
      expectedBranch,
      expectedHeadSha,
      worktreeList,
      remote: rehydrate?.remote || 'origin',
      baseRef,
      runner,
    });
    if (rehydration.allowed !== true) return rehydration;

    const rootBefore = captureGitRepositoryEvidence({ cwd: rootPath, includeUntracked: false, runner });
    if (!rootBefore) {
      return { allowed: false, failureReason: 'runner-checkout-evidence-unavailable', baseRef, rootPath, worktreePath };
    }

    return {
      allowed: true,
      failureReason: null,
      baseRef,
      baseHead: rehydration.baseHead,
      rootPath,
      rootBefore,
      worktreePath,
      workspacePreparedByRunner: !nativeClaudeWorktreeName(worktreeIdentity),
      rehydrated: true,
    };
  }

  const worktreePath = join(rootPath, '.claude', 'worktrees', worktreeIdentity.name);
  const worktreeBefore = captureGitRepositoryEvidence({ cwd: worktreePath, includeUntracked: true, runner });
  if (!worktreeBefore) {
    return { allowed: false, failureReason: 'continuation-worktree-evidence-unavailable', baseRef, rootPath, worktreePath };
  }
  if (worktreeBefore.branch !== expectedBranch) {
    return { allowed: false, failureReason: 'continuation-worktree-branch-mismatch', baseRef, rootPath, worktreePath };
  }

  // rootBefore/rootAfter must be a matching outer-checkout pair (see
  // evaluateImplementationEvidence) — captured at rootPath exactly like the
  // fresh-attempt flow, so a mutation outside the owned worktree is
  // detected the same way. baseHead is the worktree's own HEAD at
  // continuation start, proving a *new* commit happens during this resume
  // rather than merely inheriting the prior attempt's work.
  const rootBefore = captureGitRepositoryEvidence({ cwd: rootPath, includeUntracked: false, runner });
  if (!rootBefore) {
    return { allowed: false, failureReason: 'runner-checkout-evidence-unavailable', baseRef, rootPath, worktreePath };
  }

  return {
    allowed: true,
    failureReason: null,
    baseRef,
    baseHead: worktreeBefore.head,
    rootPath,
    rootBefore,
    worktreePath,
    workspacePreparedByRunner: !nativeClaudeWorktreeName(worktreeIdentity),
  };
}

export function collectImplementationEvidence({ workspace, worktreeIdentity, runner = spawnSync } = {}) {
  const rootAfter = captureGitRepositoryEvidence({ cwd: workspace?.rootPath, includeUntracked: false, runner });
  const worktree = captureGitRepositoryEvidence({ cwd: workspace?.worktreePath, includeUntracked: true, runner });
  const evaluation = evaluateImplementationEvidence({
    baseHead: workspace?.baseHead,
    rootBefore: workspace?.rootBefore,
    rootAfter,
    worktree,
    expectedBranch: worktreeIdentity?.expectedBranch,
  });
  return {
    ...evaluation,
    baseRef: workspace?.baseRef || null,
    baseHead: workspace?.baseHead || null,
    rootBefore: workspace?.rootBefore || null,
    rootAfter,
    worktree,
  };
}

function parsePullRequestList(stdout = '') {
  try {
    const payload = JSON.parse(String(stdout || '').trim());
    return Array.isArray(payload) ? payload[0] || null : null;
  } catch {
    return null;
  }
}

export function publishImplementationDraft({
  workspace,
  worktreeIdentity,
  repo,
  issueNumber,
  issueTitle,
  env = process.env,
  runner = spawnSync,
} = {}) {
  const branch = String(worktreeIdentity?.expectedBranch || '');
  const base = String(workspace?.baseRef || '').replace(/^origin\//, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || ''))
    || !/^[A-Za-z0-9._/-]+$/.test(base)
    || !workspace?.worktreePath) {
    return { published: false, failureReason: 'implementation-publication-input-invalid' };
  }

  const processOptions = {
    cwd: workspace.worktreePath,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    env,
  };
  const branchFormat = runner('git', ['check-ref-format', '--branch', branch], processOptions);
  if (branchFormat?.status !== 0) {
    return { published: false, failureReason: 'implementation-publication-branch-invalid' };
  }
  const actualBranch = runner('git', ['branch', '--show-current'], processOptions);
  if (actualBranch?.status !== 0 || String(actualBranch.stdout || '').trim() !== branch) {
    return { published: false, failureReason: 'implementation-publication-branch-mismatch' };
  }
  const push = runner('git', ['push', '--set-upstream', 'origin', branch], processOptions);
  if (push?.status !== 0) {
    return { published: false, failureReason: 'implementation-branch-push-failed', stage: 'push', exitCode: push?.status ?? null };
  }

  const listArgs = ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number,url,isDraft', '--limit', '1'];
  let listed = runner('gh', listArgs, processOptions);
  if (listed?.status !== 0) {
    return { published: false, failureReason: 'implementation-pr-query-failed', stage: 'pr-query', exitCode: listed?.status ?? null };
  }
  let pullRequest = parsePullRequestList(listed.stdout);
  if (!pullRequest) {
    const title = `${String(issueTitle || `Issue #${issueNumber}`).slice(0, 210)} (#${issueNumber})`;
    const body = `Implements #${issueNumber} from an allowlisted manager preflight.\n\nCreated as a draft by the ModelSpend agent runner after isolated-worktree, clean-commit, model/effort and permission-policy checks. Human review, merge and issue closure are required.`;
    const created = runner('gh', [
      'pr', 'create',
      '--repo', repo,
      '--base', base,
      '--head', branch,
      '--draft',
      '--title', title,
      '--body', body,
    ], processOptions);
    if (created?.status !== 0) {
      return { published: false, failureReason: 'implementation-draft-pr-create-failed', stage: 'pr-create', exitCode: created?.status ?? null };
    }
    listed = runner('gh', listArgs, processOptions);
    pullRequest = listed?.status === 0 ? parsePullRequestList(listed.stdout) : null;
  }

  if (!pullRequest?.number || !pullRequest?.url) {
    return { published: false, failureReason: 'implementation-draft-pr-evidence-missing', stage: 'pr-evidence' };
  }
  if (pullRequest.isDraft !== true) {
    return { published: false, failureReason: 'implementation-pr-not-draft', stage: 'pr-evidence', prNumber: pullRequest.number, prUrl: pullRequest.url };
  }
  return {
    published: true,
    failureReason: null,
    branch,
    prNumber: pullRequest.number,
    prUrl: pullRequest.url,
    draft: true,
  };
}

function parseSinglePullRequest(stdout = '') {
  try {
    const payload = JSON.parse(String(stdout || '').trim());
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function parseRemoteBranchHead(stdout = '') {
  const line = String(stdout || '').trim().split('\n')[0] || '';
  const sha = line.split(/\s+/)[0] || '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

const PR_CONTINUATION_RECONCILE_MAX_ATTEMPTS = 3;
const PR_CONTINUATION_RECONCILE_DELAY_MS = 500;

// A synchronous, bounded sleep -- `publishPrContinuation` stays a plain
// (non-async) function so its existing call sites and fixtures are
// untouched; `Atomics.wait` blocks the thread without a scheduler/timer API
// change.
function defaultReconcileWait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Strict same-PR publication for a bounded PR review-followup continuation
 * (#242). Unlike `publishImplementationDraft`, this never creates a
 * replacement PR: it pushes only the already-authorised existing branch,
 * then re-reads the exact same open PR number/branch and requires the
 * published head to equal the committed worktree HEAD before declaring
 * success. Any identity drift (PR closed, reopened as a different number,
 * head branch changed) fails closed immediately. Retry is limited to the
 * one shape that is actual GitHub PR-head propagation lag: the observed
 * `headRefOid` still equals the exact known pre-run head
 * (`workspace.baseHead`) and the remote branch ref still positively equals
 * `committedHead`. Any other observed head (a third/unexpected SHA), or a
 * remote ref that has advanced away from `committedHead` during the retry
 * window, fails closed immediately instead of waiting (#310).
 */
export function publishPrContinuation({
  workspace,
  worktreeIdentity,
  repo,
  prNumber,
  env = process.env,
  runner = spawnSync,
  wait = defaultReconcileWait,
  maxAttempts = PR_CONTINUATION_RECONCILE_MAX_ATTEMPTS,
  retryDelayMs = PR_CONTINUATION_RECONCILE_DELAY_MS,
} = {}) {
  const branch = String(worktreeIdentity?.expectedBranch || '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || ''))
    || !Number.isInteger(prNumber) || prNumber <= 0
    || !workspace?.worktreePath) {
    return { published: false, failureReason: 'pr-continuation-publication-input-invalid' };
  }

  const processOptions = {
    cwd: workspace.worktreePath,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    env,
  };
  const branchFormat = runner('git', ['check-ref-format', '--branch', branch], processOptions);
  if (branchFormat?.status !== 0) {
    return { published: false, failureReason: 'pr-continuation-publication-branch-invalid' };
  }
  const actualBranch = runner('git', ['branch', '--show-current'], processOptions);
  if (actualBranch?.status !== 0 || String(actualBranch.stdout || '').trim() !== branch) {
    return { published: false, failureReason: 'pr-continuation-publication-branch-mismatch' };
  }
  const committedHeadResult = runner('git', ['rev-parse', 'HEAD'], processOptions);
  const committedHead = committedHeadResult?.status === 0 ? String(committedHeadResult.stdout || '').trim() : null;
  if (!committedHead) {
    return { published: false, failureReason: 'pr-continuation-publication-head-unavailable' };
  }

  const push = runner('git', ['push', 'origin', branch], processOptions);
  if (push?.status !== 0) {
    return { published: false, failureReason: 'pr-continuation-branch-push-failed', stage: 'push', exitCode: push?.status ?? null };
  }

  const readRemoteBranchHead = () => {
    const remoteRef = runner('git', ['ls-remote', 'origin', `refs/heads/${branch}`], processOptions);
    return remoteRef?.status === 0 ? parseRemoteBranchHead(remoteRef.stdout) : null;
  };

  // A non-force push already succeeded above; the remote ref must positively
  // reflect the committed HEAD before any PR reconciliation is attempted.
  const postPushRemoteHead = readRemoteBranchHead();
  if (postPushRemoteHead !== committedHead) {
    return {
      published: false,
      failureReason: 'pr-continuation-publication-remote-ref-mismatch',
      stage: 'remote-ref',
      expectedHeadSha: committedHead,
      observedHeadSha: postPushRemoteHead,
    };
  }

  let pullRequest = null;
  let observedHead = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const view = runner('gh', [
      'pr', 'view', String(prNumber),
      '--repo', repo,
      '--json', 'number,state,headRefName,headRefOid,url',
    ], processOptions);
    if (view?.status !== 0) {
      return { published: false, failureReason: 'pr-continuation-publication-pr-query-failed', stage: 'pr-query', exitCode: view?.status ?? null };
    }
    pullRequest = parseSinglePullRequest(view.stdout);
    if (!pullRequest?.number || !pullRequest?.url) {
      return { published: false, failureReason: 'pr-continuation-publication-pr-evidence-missing', stage: 'pr-evidence' };
    }
    // Identity must be exactly preserved -- a closed/reopened/renumbered PR
    // is never rebound to a freshly created replacement, and is never
    // retried since it is a real identity change, not propagation lag.
    if (pullRequest.number !== prNumber) {
      return { published: false, failureReason: 'pr-continuation-publication-pr-number-changed', stage: 'pr-evidence', prNumber: pullRequest.number };
    }
    if (pullRequest.state !== 'OPEN') {
      return { published: false, failureReason: 'pr-continuation-publication-pr-not-open', stage: 'pr-evidence', prNumber: pullRequest.number };
    }
    if (pullRequest.headRefName !== branch) {
      return { published: false, failureReason: 'pr-continuation-publication-branch-changed', stage: 'pr-evidence', prNumber: pullRequest.number };
    }
    observedHead = pullRequest.headRefOid || null;
    if (observedHead === committedHead) {
      break;
    }
    // Retry is limited to the exact known pre-run head -- that is the only
    // shape bounded GitHub PR-head propagation lag can take. Any other
    // observed head is a real mismatch, not lag, so it fails closed below
    // with a single PR read and zero wait.
    if (observedHead !== workspace.baseHead) {
      break;
    }
    if (attempt < maxAttempts) {
      // A remote ref that has advanced away from the committed HEAD during
      // the retry window is a concurrent later branch advance, not
      // propagation lag -- fail closed immediately instead of continuing to
      // wait/retry.
      const midRemoteHead = readRemoteBranchHead();
      if (midRemoteHead !== committedHead) {
        return {
          published: false,
          failureReason: 'pr-continuation-publication-remote-ref-mismatch',
          stage: 'remote-ref-retry',
          prNumber: pullRequest.number,
          expectedHeadSha: committedHead,
          observedHeadSha: midRemoteHead,
        };
      }
      wait(retryDelayMs);
    }
  }

  if (observedHead !== committedHead) {
    return {
      published: false,
      failureReason: 'pr-continuation-publication-head-mismatch',
      stage: 'pr-evidence',
      prNumber: pullRequest.number,
      expectedHeadSha: committedHead,
      observedHeadSha: observedHead,
    };
  }

  // Guard against a concurrent later branch advance being hidden by a
  // transiently matching PR view: the remote ref must still equal the
  // committed HEAD right before success is declared.
  const finalRemoteHead = readRemoteBranchHead();
  if (finalRemoteHead !== committedHead) {
    return {
      published: false,
      failureReason: 'pr-continuation-publication-head-mismatch',
      stage: 'remote-ref-final',
      prNumber: pullRequest.number,
      expectedHeadSha: committedHead,
      observedHeadSha: finalRemoteHead,
    };
  }

  return {
    published: true,
    failureReason: null,
    branch,
    prNumber: pullRequest.number,
    prUrl: pullRequest.url,
    headSha: committedHead,
  };
}

async function githubJson(path, token, repo) {
  const url = `https://api.github.com/repos/${repo}${path}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'modelspend-claude-runner',
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub request failed ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

export async function fetchIssueAndComments({ repo, issue, token }) {
  const issuePayload = await githubJson(`/issues/${issue}`, token, repo);
  const comments = await githubJson(`/issues/${issue}/comments?per_page=100`, token, repo);
  return { issue: issuePayload, comments };
}

async function fetchOpenPullRequests({ repo, token }) {
  return githubJson('/pulls?state=open&per_page=50', token, repo);
}

async function githubGraphQL(query, variables, token) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'modelspend-claude-runner',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub GraphQL request failed ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
  }
  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`GitHub GraphQL request returned errors: ${JSON.stringify(payload.errors).slice(0, 500)}`);
  }
  return payload.data;
}

// Hard bounds on review-thread fetching, enforced fail-closed: a single
// fixed page of threads and comments per thread, with every comment body
// truncated before it enters detector/prompt context. There is no
// cursor-progress loop — if GitHub reports more pages than this bound
// allows, fetchPullRequestReviewThreads() throws rather than truncating
// silently or paginating indefinitely.
const REVIEW_THREADS_PAGE_LIMIT = 50;
const REVIEW_THREAD_COMMENTS_LIMIT = 20;
const REVIEW_THREAD_COMMENT_BODY_MAX_CHARS = 2000;

// Fixed, bounded GraphQL query: positively selects only the review-thread
// resolution state and bounded comment context the follow-up detector/prompt
// needs. No arbitrary/parameterized query surface is exposed to callers.
const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: ${REVIEW_THREADS_PAGE_LIMIT}) {
        pageInfo { hasNextPage }
        nodes {
          id
          isResolved
          comments(last: ${REVIEW_THREAD_COMMENTS_LIMIT}) {
            nodes {
              author { login }
              authorAssociation
              body
              createdAt
            }
          }
        }
      }
    }
  }
}`;

function boundCommentBody(body) {
  const text = String(body || '');
  if (text.length <= REVIEW_THREAD_COMMENT_BODY_MAX_CHARS) return text;
  const marker = '… [truncated]';
  const retainedChars = Math.max(0, REVIEW_THREAD_COMMENT_BODY_MAX_CHARS - marker.length);
  return `${text.slice(0, retainedChars)}${marker}`;
}

/**
 * Fetch review-thread resolution state via a single fixed, bounded GraphQL
 * page. Throws on any failure (network, HTTP, GraphQL errors, a missing
 * reviewThreads field, or a PR reporting more threads than the single
 * allowed page can hold) so callers fail closed rather than silently
 * treating an unavailable or truncated thread query as "no unresolved
 * threads".
 */
async function fetchPullRequestReviewThreads({ repo, pr, token }) {
  const [owner, name] = String(repo).split('/');
  if (!owner || !name) throw new Error(`Invalid repo "${repo}" for review-thread query`);
  const data = await githubGraphQL(REVIEW_THREADS_QUERY, { owner, name, pr }, token);
  const reviewThreads = data?.repository?.pullRequest?.reviewThreads;
  if (
    !reviewThreads
    || !Array.isArray(reviewThreads.nodes)
    || typeof reviewThreads.pageInfo?.hasNextPage !== 'boolean'
  ) {
    throw new Error(`GitHub GraphQL response missing bounded reviewThreads state for ${repo}#${pr}`);
  }
  if (reviewThreads.pageInfo.hasNextPage) {
    throw new Error(
      `GitHub reports more than ${REVIEW_THREADS_PAGE_LIMIT} review threads for ${repo}#${pr}, exceeding the hard bounded-fetch limit; refusing to paginate`,
    );
  }

  return reviewThreads.nodes.map((node, threadIndex) => {
    if (
      !node
      || typeof node.id !== 'string'
      || node.id.length === 0
      || typeof node.isResolved !== 'boolean'
      || !Array.isArray(node.comments?.nodes)
    ) {
      throw new Error(
        `GitHub GraphQL response contains malformed review thread at index ${threadIndex} for ${repo}#${pr}`,
      );
    }

    const comments = node.comments.nodes.map((comment, commentIndex) => {
      if (
        !comment
        || typeof comment.body !== 'string'
        || typeof comment.createdAt !== 'string'
        || (comment.author !== null && typeof comment.author !== 'object')
      ) {
        throw new Error(
          `GitHub GraphQL response contains malformed review-thread comment at thread ${threadIndex}, comment ${commentIndex} for ${repo}#${pr}`,
        );
      }

      return {
        author: { login: comment.author?.login || 'unknown' },
        // #242: GitHub's own author association is the trust signal that
        // decides whether this comment may become *executable* continuation
        // input. A missing/unknown association stays null and is therefore
        // never trusted (see selectExecutableReviewFeedback).
        authorAssociation: typeof comment.authorAssociation === 'string' ? comment.authorAssociation : null,
        body: boundCommentBody(comment.body),
        createdAt: comment.createdAt,
      };
    });

    return {
      id: node.id,
      isResolved: node.isResolved,
      comments,
    };
  });
}

async function fetchPullRequestReviewContext({ repo, pr, token }) {
  const [pullRequest, reviews, comments, reviewThreads] = await Promise.all([
    githubJson(`/pulls/${pr}`, token, repo),
    githubJson(`/pulls/${pr}/reviews?per_page=100`, token, repo),
    githubJson(`/issues/${pr}/comments?per_page=100`, token, repo),
    fetchPullRequestReviewThreads({ repo, pr, token }),
  ]);
  return { pullRequest, reviews, comments, reviewThreads };
}

/**
 * Check whether an open PR plausibly linked to `issue` has unresolved review
 * follow-up. Returns null when no linked PR is blocking, otherwise details
 * for the blocking PR so the caller can refuse to start new issue work.
 */
export async function findBlockingPrFollowUp({ repo, issue, token }) {
  const openPrs = await fetchOpenPullRequests({ repo, token });
  const candidates = findLinkedOpenPullRequests({
    issueNumber: issue,
    pullRequests: openPrs.map((pr) => ({ number: pr.number, title: pr.title, body: pr.body, headRefName: pr.head?.ref, url: pr.html_url })),
  });

  for (const candidate of candidates) {
    const { reviews, comments, reviewThreads } = await fetchPullRequestReviewContext({ repo, pr: candidate.number, token });
    const unresolved = detectUnresolvedReviewFollowUp({ reviews, reviewThreads, comments });
    if (unresolved.hasUnresolvedFollowUp) {
      return { pr: candidate, unresolved };
    }
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

export function defaultQuotaStatePath(outputDir) {
  return join(outputDir, 'quota-state.json');
}

export function readQuotaPauseState(statePath) {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

export function writeQuotaPauseState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Run a conservative /quota check and update the local pause state file.
 * Fails closed: ambiguous output keeps (or starts) a pause rather than
 * assuming quota is available.
 */
export async function runQuotaCheck(args, env = process.env) {
  const quotaStatePath = args.quotaStatePath || defaultQuotaStatePath(args.outputDir);
  const now = new Date();
  const previousState = readQuotaPauseState(quotaStatePath);

  if (!args.forceQuotaCheck && previousState?.lastCheckedAt) {
    const elapsedMs = now.getTime() - new Date(previousState.lastCheckedAt).getTime();
    if (Number.isFinite(elapsedMs) && elapsedMs < 10 * 60 * 1000) {
      const payload = {
        checked: false,
        reason: 'too-soon',
        lastCheckedAt: previousState.lastCheckedAt,
        minIntervalMs: 10 * 60 * 1000,
        quotaStatePath,
      };
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
  }

  const claudeEnv = buildClaudeProcessEnv(env, { inheritProviderAuth: args.inheritProviderAuth });
  const quotaArgs = buildQuotaCheckArgs({});
  const result = spawnSync(args.claudeBin, quotaArgs, {
    cwd: resolve('.'),
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    env: claudeEnv,
  });

  const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
  const parsed = parseQuotaCheckOutput(combinedOutput, {
    now,
    maxSessionUsageBeforeStartPercent: env.CLAUDE_RUNNER_MAX_SESSION_USAGE_BEFORE_START_PERCENT,
  });
  const usageState = {
    quotaUsage: parsed.quotaUsage || null,
    sessionPercentUsed: parsed.sessionPercentUsed ?? null,
    weeklyPercentUsed: parsed.weeklyPercentUsed ?? null,
    modelWeekPercentUsed: parsed.modelWeekPercentUsed || {},
    maxSessionUsageBeforeStartPercent: parsed.maxSessionUsageBeforeStartPercent ?? null,
  };

  let nextState;
  if (parsed.status === 'available') {
    nextState = { status: 'available', lastCheckedAt: now.toISOString(), pausedUntil: null, reason: null, ...usageState };
  } else {
    // 'exhausted' or 'ambiguous' both fail closed to a conservative pause.
    const pause = recordQuotaPause({
      reason: parsed.status === 'exhausted' ? 'quota-exhausted' : 'ambiguous-quota-check',
      matchedPattern: parsed.matchedPattern,
      resetAt: parsed.resetAt,
      now,
    });
    nextState = { ...pause, status: parsed.status, lastCheckedAt: now.toISOString(), ...usageState };
  }

  writeQuotaPauseState(quotaStatePath, nextState);

  const payload = {
    checked: true,
    status: parsed.status,
    exitCode: result.status,
    signal: result.signal,
    spawnError: result.error ? String(result.error.message || result.error) : null,
    output: redactSensitiveText(combinedOutput).trim(),
    quotaStatePath,
    state: nextState,
  };
  console.log(JSON.stringify(payload, null, 2));
  return 0;
}

/**
 * Detect the "silent no-op" contract violation: --execute was passed, the
 * spawned Claude process exited 0, but produced no stdout/stderr at all.
 * A real Claude print-mode run always emits response text; empty output
 * with a clean exit code means Claude was never actually launched/did
 * nothing, not that the task trivially succeeded.
 */
export function detectExecutionNoop({ execute, status, signal, stdout = '', stderr = '', spawnError = null }) {
  if (!execute) return { noop: false, reason: null };
  if (spawnError) return { noop: true, reason: 'claude-spawn-error' };
  if (signal) return { noop: true, reason: 'claude-killed-by-signal' };
  if (status === 0 && !String(stdout).trim() && !String(stderr).trim()) {
    return { noop: true, reason: 'claude-exited-zero-with-no-output' };
  }
  return { noop: false, reason: null };
}

/**
 * A plan-only Claude print-mode run (all runner profiles currently use
 * `--permission-mode plan`, see #660) exits 0 and emits real response text,
 * so it passes `detectExecutionNoop`. But it never edited any code — Claude
 * only wrote a plan file and is waiting for approval/continuation. Detect
 * that signature from the observed #580 stdout (a plan file path under
 * `.claude/plans/` and/or an explicit "no code edits" statement) so the
 * runner can refuse to treat it as completed implementation work.
 */
export const PLAN_ONLY_EXIT_CODE = 2;
export const COST_POLICY_EXIT_CODE = 3;
export const EXECUTION_POLICY_EXIT_CODE = 4;
export const PR_REVIEW_FOLLOWUP_MODE = 'pr-review-followup';

const PLAN_FILE_PATH_PATTERN = /(\/\S*\.claude\/plans\/\S+\.md)/;
const PLAN_ONLY_STDOUT_PATTERNS = [
  /have not made any code edits/i,
  /no code edits (?:were|have been) made/i,
  /only the plan file was written/i,
  /awaiting plan approval/i,
];

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
  return sanitizeClaudeModelUsage(value);
}

/**
 * Parse Claude's print-mode JSON result into an allowlisted accounting
 * envelope. Never return the resumable session id or raw provider payload;
 * the local log needs bounded result text plus numeric usage/cost evidence.
 */
export function parseClaudeResultEnvelope(stdout = '') {
  const fallback = {
    parsed: false,
    subtype: null,
    isError: false,
    resultText: String(stdout || ''),
    errors: [],
    numTurns: null,
    totalCostUsd: null,
    usage: null,
    modelUsage: {},
    hasSessionId: false,
    accountingAvailable: false,
  };

  const terminalResult = (records) => [...records].reverse().find((record) => record && typeof record === 'object' && !Array.isArray(record) && record.type === 'result') || null;
  let payload;
  const records = String(stdout || '').split(/\r?\n/).filter((line) => line.trim()).flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch { return []; }
  });
  try {
    payload = JSON.parse(String(stdout || '').trim());
    if (Array.isArray(payload)) payload = terminalResult(payload);
  } catch {
    payload = terminalResult(records);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fallback;

  // Only a terminal CLI result may classify provider state. Intermediate
  // assistant/tool/rate_limit_event records are deliberately ignored: their
  // content routinely contains repository strings such as 429 and
  // billing_quota_exceeded (#299/#550).
  if (payload.type && payload.type !== 'result') return fallback;

  const usage = sanitizeUsageRecord(payload.usage);
  const modelUsage = sanitizeModelUsage(payload.modelUsage ?? payload.model_usage);
  const numTurns = finiteNumberOrNull(payload.num_turns ?? payload.numTurns);
  const totalCostUsd = finiteNumberOrNull(payload.total_cost_usd ?? payload.totalCostUsd);
  const errors = Array.isArray(payload.errors)
    ? payload.errors.filter((entry) => typeof entry === 'string').slice(0, 10).map((entry) => entry.slice(0, 500))
    : [];
  const providerError = payload.provider_error && typeof payload.provider_error === 'object'
    ? payload.provider_error
    : payload.error && typeof payload.error === 'object' ? payload.error : null;
  const providerErrorCode = typeof providerError?.code === 'string' ? providerError.code : null;
  const terminalProviderFailure = payload.is_error === true || payload.isError === true;
  const structuredFailure = terminalProviderFailure && ['quota_exhausted', 'billing_quota_exceeded', 'rate_limited'].includes(providerErrorCode)
    ? providerErrorCode
    : null;

  return {
    parsed: true,
    subtype: typeof payload.subtype === 'string' ? payload.subtype.slice(0, 120) : null,
    isError: payload.is_error === true || payload.isError === true,
    resultText: typeof payload.result === 'string' ? payload.result : '',
    errors,
    numTurns,
    totalCostUsd,
    usage,
    modelUsage,
    hasSessionId: Boolean(payload.session_id || payload.sessionId),
    accountingAvailable: numTurns !== null || totalCostUsd !== null || usage !== null || Object.keys(modelUsage).length > 0,
    structuredFailure,
    retryAt: typeof providerError?.retry_at === 'string' ? providerError.retry_at : null,
  };
}

/**
 * Extract the raw resumable session id from the same terminal `type:
 * "result"` record `parseClaudeResultEnvelope` reduces JSON/JSONL/array
 * output to — but, unlike that function, actually return the id instead of
 * just a boolean. This is the ONLY place the real session id is read out of
 * Claude's stdout; the caller must write it straight to the restricted
 * recovery store and never assign it to anything that reaches ordinary
 * state, logs, or GitHub (#698 finding 2).
 */
function extractRestrictedSessionId(stdout = '') {
  const terminalResult = (records) => [...records].reverse().find((record) => record && typeof record === 'object' && !Array.isArray(record) && record.type === 'result') || null;
  const records = String(stdout || '').split(/\r?\n/).filter((line) => line.trim()).flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch { return []; }
  });
  let payload;
  try {
    payload = JSON.parse(String(stdout || '').trim());
    if (Array.isArray(payload)) payload = terminalResult(payload);
  } catch {
    payload = terminalResult(records);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.type && payload.type !== 'result') return null;
  const sessionId = payload.session_id || payload.sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : null;
}

/**
 * Convert provider/process output into a stable failure code for the cron
 * scheduler. Raw provider text stays in the redacted local run log; GitHub
 * receives only this bounded reason.
 */
export function classifyClaudeRunFailure({
  status,
  signal,
  stdout = '',
  stderr = '',
  spawnError = null,
  executionNoopReason = null,
  planProduced = false,
  resultEnvelope = null,
  executionPhase = EXECUTION_PHASE_PLAN,
  implementationEvidence = null,
} = {}) {
  if (spawnError) return 'claude-spawn-error';
  if (signal) return 'claude-killed-by-signal';
  if (planProduced) {
    return executionPhase === EXECUTION_PHASE_IMPLEMENTATION
      ? 'implementation-returned-plan-only'
      : 'awaiting-plan-approval';
  }

  if (resultEnvelope?.subtype === 'error_max_turns') return 'provider-execution-limit';
  if (resultEnvelope?.subtype === 'error_max_budget_usd') return 'budget-limit-exhausted';
  if (['quota_exhausted', 'billing_quota_exceeded'].includes(resultEnvelope?.structuredFailure)) return 'quota_paused';
  if (resultEnvelope?.structuredFailure === 'rate_limited') return 'rate_limited';
  if (resultEnvelope?.isError && resultEnvelope?.subtype) {
    return 'unknown_failure';
  }

  const combined = `${stdout}\n${stderr}`;
  if (/reached max turns\s*\(\s*\d+\s*\)/i.test(combined)) return 'provider-execution-limit';
  if (/(?:reached|exceeded|exhausted)\s+(?:the\s+)?max(?:imum)? budget|max(?:imum)? budget(?: usd)?\s+(?:reached|exceeded|exhausted)/i.test(combined)) return 'budget-limit-exhausted';
  if (executionNoopReason) return executionNoopReason;
  if (status !== 0) return `claude-exit-${status ?? 'unknown'}`;
  if (executionPhase === EXECUTION_PHASE_IMPLEMENTATION && implementationEvidence?.failureReason) {
    return implementationEvidence.failureReason;
  }
  return null;
}

/**
 * Run Claude (dry-run or --execute) with a prebuilt prompt/profile and
 * persist a redacted run log. Shared by issue mode and PR follow-up mode.
 *
 * This outer function owns the one machine-global implementation slot for the
 * whole write-capable run (#242), so the slot is always released -- including
 * on an early policy refusal or a thrown error.
 */
export async function runOrPlanClaude(input) {
  const slot = { release: () => {} };
  try {
    return await executeOrPlanClaudeRun(input, slot);
  } finally {
    slot.release();
  }
}

async function executeOrPlanClaudeRun({
  args, env, label, runPlan, prompt, claudeArgs, processRunner = spawnSync,
  prePublicationCheck = null, acquireSlot = acquireImplementationSlot,
}, slot = { release: () => {} }) {
  let planWithPrompt = { ...runPlan, prompt: redactSensitiveText(prompt) };

  if (!args.execute) {
    const logPath = writeRunLog({ outputDir: args.outputDir, label, payload: planWithPrompt });
    console.log(JSON.stringify({ ...planWithPrompt, logPath }, null, 2));
    return 0;
  }

  const policyBlock = (reason, message, details = {}) => {
    const payload = {
      ...planWithPrompt,
      ...details,
      dryRun: false,
      blocked: true,
      reason,
      failureReason: reason,
      message,
    };
    const logPath = writeRunLog({ outputDir: args.outputDir, label, payload });
    console.log(JSON.stringify({ ...payload, logPath }, null, 2));
    return EXECUTION_POLICY_EXIT_CODE;
  };

  if (runPlan.executionAuthorization && !runPlan.executionAuthorization.allowed) {
    return policyBlock(
      'execution-authorization-blocked',
      'The issue did not satisfy the machine-local manager-preflight authorization policy (and, for implementation, the write opt-in). No Claude process was started.',
    );
  }

  if (!runPlan.costAdmission?.allowed) {
    const payload = {
      ...planWithPrompt,
      dryRun: false,
      blocked: true,
      reason: 'cost-policy-blocked',
      failureReason: 'cost-policy-blocked',
      message: 'The requested model/effort controls exceed this machine\'s unattended policy. No Claude process was started.',
    };
    const logPath = writeRunLog({ outputDir: args.outputDir, label, payload });
    console.log(JSON.stringify({ ...payload, logPath }, null, 2));
    return COST_POLICY_EXIT_CODE;
  }

  let implementationWorkspace = null;
  const isPrContinuation = runPlan.mode === PR_REVIEW_FOLLOWUP_MODE;
  if (runPlan.executionPhase === EXECUTION_PHASE_IMPLEMENTATION) {
    const cliCapability = verifyClaudeImplementationCli({ claudeBin: args.claudeBin });
    planWithPrompt = { ...planWithPrompt, cliCapability };
    if (!cliCapability.compatible) {
      return policyBlock(
        'implementation-cli-capability-mismatch',
        'The installed Claude CLI does not meet the required minimum implementation-runner version. Upgrade/repair Claude before retrying; no paid process was started.',
      );
    }
    if (args.recoveryMode === 'native_resume' && !args.resumeSession) {
      return policyBlock(
        'native-resume-session-missing',
        'native_resume was requested without a --resume-session value. No paid process was started.',
      );
    }

    // #242 defect 6: every write-capable implementation launch takes the one
    // machine-global implementation slot, not just the systemd recurrence
    // tick. Direct `--pr <n> --execute` continuation previously took no lock
    // at all, so it could run a second worker alongside a running recurrence.
    // When this process is already a descendant of the slot owner (the
    // recurrence -> run-project.sh -> pinned cron -> runner chain) the slot is
    // inherited rather than re-taken, so the normal recurrence path cannot
    // deadlock against itself.
    const implementationSlot = acquireSlot({ env });
    if (!implementationSlot.held) {
      return policyBlock(
        implementationSlot.failureReason,
        'Another implementation already holds the one global implementation slot on this machine (or slot ownership could not be proven). No Claude process was started.',
        { implementationSlot: { lockPath: implementationSlot.lockPath, inherited: false, detail: implementationSlot.detail || null } },
      );
    }
    slot.release = implementationSlot.release;
    planWithPrompt = {
      ...planWithPrompt,
      implementationSlot: {
        lockPath: implementationSlot.lockPath,
        inherited: implementationSlot.inherited,
        held: true,
      },
    };

    // native_resume, same_agent_continuation, and PR review-followup
    // continuation (#242) all reconnect to the exact worktree/branch an
    // existing authorised attempt already owns — the opposite of the
    // fresh-attempt requirement above, which refuses to reuse one (#698
    // finding 2). PR follow-up continuation must never create a fresh
    // branch/worktree, so it always uses the same reconnect path regardless
    // of --recovery-mode.
    const implementationCheckout = runPlan.repositoryContext?.implementationCheckout;
    // #314: the binding-time prepareWorkspace call (resolvePrContinuationBinding)
    // already rehydrated a missing worktree, if any, at the exact verified PR
    // head; runPlan.preRunHeadSha is that same bound SHA, so a second missing
    // worktree here (unexpected — recovery is idempotent once created) can
    // only ever be rehydrated at that identical proven identity, never a
    // different one.
    implementationWorkspace = (args.recoveryMode || isPrContinuation)
      ? prepareContinuationWorkspace({
        worktreeIdentity: runPlan.worktreeIdentity,
        implementationCheckout,
        env,
        rehydrate: isPrContinuation && runPlan.preRunHeadSha ? { expectedHeadSha: runPlan.preRunHeadSha } : null,
      })
      : prepareImplementationWorkspace({ worktreeIdentity: runPlan.worktreeIdentity, implementationCheckout, env });
    // #316 committed-ahead recovery: the binding already proved the exact
    // preserved one-commit-ahead checkpoint against the published PR head
    // before this launch was ever authorised. The clean-commit invariant
    // below must still measure "changed" against that unchanged PR head,
    // not against the checkpoint commit itself -- otherwise a resume that
    // only removes the preserved checkpoint's untracked residue (making no
    // further commit) would be wrongly reported as "no repository change".
    // A worktree that has moved off the exact checkpoint since the binding
    // check ran is never silently accepted here.
    if (implementationWorkspace.allowed && isPrContinuation && runPlan.recoveredCheckpoint?.committedAhead) {
      if (implementationWorkspace.baseHead !== runPlan.recoveredCheckpoint.checkpointHead) {
        implementationWorkspace = {
          allowed: false,
          failureReason: 'pr-continuation-committed-ahead-checkpoint-changed',
          baseRef: implementationWorkspace.baseRef || null,
          rootPath: implementationWorkspace.rootPath || null,
          worktreePath: implementationWorkspace.worktreePath || null,
        };
      } else {
        implementationWorkspace = {
          ...implementationWorkspace,
          baseHead: runPlan.recoveredCheckpoint.preRunHeadSha,
        };
      }
    }
    planWithPrompt = {
      ...planWithPrompt,
      workspacePreparation: {
        allowed: implementationWorkspace.allowed,
        failureReason: implementationWorkspace.failureReason,
        baseRef: implementationWorkspace.baseRef || null,
        baseHead: implementationWorkspace.baseHead || null,
        rehydrated: implementationWorkspace.rehydrated === true,
      },
    };
    if (!implementationWorkspace.allowed) {
      return policyBlock(
        implementationWorkspace.failureReason || 'implementation-workspace-policy-blocked',
        'The runner could not prove exclusive, current worktree ownership. No Claude process was started.',
      );
    }
  }

  const claudeEnv = buildClaudeProcessEnv(env, { inheritProviderAuth: args.inheritProviderAuth });
  const startedAt = new Date().toISOString();
  const result = processRunner(args.claudeBin, claudeArgs, {
    cwd: implementationProcessCwd(implementationWorkspace),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: claudeEnv,
  });

  const resultEnvelope = parseClaudeResultEnvelope(result.stdout || '');
  const resultText = resultEnvelope.parsed
    ? [resultEnvelope.resultText, ...resultEnvelope.errors].filter(Boolean).join('\n')
    : String(result.stdout || '');
  const outputBudgetShadow = buildClaudeOutputBudgetShadow({
    profile: runPlan.profile,
    output: resultText,
  });
  const telemetryFinishedAt = new Date().toISOString();
  const usageAccounting = buildClaudeUsageAccounting({
    resultEnvelope,
    model: runPlan.profile?.model || runPlan.agent?.model || null,
    promptCacheMetadata: runPlan.promptCacheMetadata || null,
    startedAt,
    finishedAt: telemetryFinishedAt,
  });
  if (['quota_exhausted', 'billing_quota_exceeded'].includes(resultEnvelope.structuredFailure)) {
    const implementationEvidence = runPlan.executionPhase === EXECUTION_PHASE_IMPLEMENTATION
      ? collectImplementationEvidence({ workspace: implementationWorkspace, worktreeIdentity: runPlan.worktreeIdentity })
      : null;
    const quotaStatePath = args.quotaStatePath || defaultQuotaStatePath(args.outputDir);
    const resetAt = resultEnvelope.retryAt;
    const pause = recordQuotaPause({ reason: 'quota_paused', matchedPattern: resultEnvelope.structuredFailure, resetAt, now: new Date() });
    writeQuotaPauseState(quotaStatePath, { ...pause, status: 'exhausted', lastCheckedAt: new Date().toISOString() });
    const payload = {
      ...planWithPrompt,
      dryRun: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      blocked: true,
      reason: 'quota_paused',
      failureReason: 'quota_paused',
      quotaPaused: true,
      quotaPauseState: pause,
      quotaStatePath,
      exitCode: result.status,
      signal: result.signal,
      stdout: redactSensitiveText(resultText),
      stderr: redactSensitiveText(result.stderr || ''),
      usageAccounting,
      outputBudgetShadow,
      implementationEvidence,
      spawnError: result.error ? String(result.error.message || result.error) : null,
    };
    const logPath = writeRunLog({ outputDir: args.outputDir, label, payload });
    console.log(JSON.stringify({ ...payload, stdout: '<see log>', stderr: '<see log>', logPath }, null, 2));
    return 1;
  }

  const executionCheck = detectExecutionNoop({
    execute: true,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    spawnError: result.error,
  });
  const planCheck = detectPlanOnlyResult({ stdout: resultText, stderr: result.stderr || '' });
  let implementationEvidence = runPlan.executionPhase === EXECUTION_PHASE_IMPLEMENTATION
    ? collectImplementationEvidence({ workspace: implementationWorkspace, worktreeIdentity: runPlan.worktreeIdentity })
    : null;
  let implementationPublication = null;
  let prePublicationRevalidation = null;
  if (runPlan.executionPhase === EXECUTION_PHASE_IMPLEMENTATION
    && result.status === 0
    && !resultEnvelope.isError
    && !executionCheck.noop
    && !planCheck.planProduced
    && implementationEvidence?.valid) {
    // Re-verify live authority once more before any push. A refusal here is
    // a truthful publication failure that preserves the committed local work
    // — never a force-push, a replacement PR, or a silent success.
    if (typeof prePublicationCheck === 'function') {
      try {
        prePublicationRevalidation = await prePublicationCheck();
      } catch {
        prePublicationRevalidation = { allowed: false, failureReason: 'pr-continuation-revalidation-unavailable' };
      }
    }
  }
  if (prePublicationRevalidation && prePublicationRevalidation.allowed !== true) {
    implementationEvidence = {
      ...implementationEvidence,
      valid: false,
      failureReason: prePublicationRevalidation.failureReason || 'pr-continuation-revalidation-refused',
    };
  } else if (runPlan.executionPhase === EXECUTION_PHASE_IMPLEMENTATION
    && result.status === 0
    && !resultEnvelope.isError
    && !executionCheck.noop
    && !planCheck.planProduced
    && implementationEvidence?.valid) {
    implementationPublication = isPrContinuation
      ? publishPrContinuation({
        workspace: implementationWorkspace,
        worktreeIdentity: runPlan.worktreeIdentity,
        repo: runPlan.repositoryContext?.implementationRepository || runPlan.repo,
        prNumber: runPlan.prNumber,
        env,
      })
      : publishImplementationDraft({
        workspace: implementationWorkspace,
        worktreeIdentity: runPlan.worktreeIdentity,
        repo: runPlan.repositoryContext?.implementationRepository || runPlan.repo,
        issueNumber: runPlan.issue,
        issueTitle: runPlan.issueTitle,
        env,
      });
    if (!implementationPublication.published) {
      implementationEvidence = {
        ...implementationEvidence,
        valid: false,
        failureReason: implementationPublication.failureReason || 'implementation-draft-publication-failed',
      };
    }
  }
  const failureReason = classifyClaudeRunFailure({
    status: result.status,
    signal: result.signal,
    stdout: resultText,
    stderr: result.stderr || '',
    spawnError: result.error,
    executionNoopReason: executionCheck.reason,
    planProduced: planCheck.planProduced,
    resultEnvelope,
    executionPhase: runPlan.executionPhase,
    implementationEvidence,
  });

  // Restricted recovery evidence (#698 finding 2). The raw session id is
  // written straight to the restricted store and never assigned to a
  // variable that reaches `payload`; only an opaque digest and ordinary
  // booleans do.
  let restrictedRecoveryHandleDigest = null;
  let restrictedHandleBindingDigestValue = null;
  // #242 defect 4: a direct PR continuation has no operator-supplied
  // --attempt-id, so a failed run used to leave the worktree dirty with no
  // recorded checkpoint at all — permanently dead-ending the PR. Derive a
  // deterministic per-PR attempt id instead, so the run that fails and the
  // next run that must recover address the same restricted handle.
  const continuationRepository = isPrContinuation
    ? (runPlan.repositoryContext?.implementationRepository || runPlan.repo || null)
    : null;
  const restrictedAttemptId = args.attemptId
    || (isPrContinuation && continuationRepository && Number.isInteger(runPlan.prNumber)
      ? prContinuationAttemptId({ repo: continuationRepository, prNumber: runPlan.prNumber })
      : null);
  if (restrictedAttemptId && runPlan.executionPhase === EXECUTION_PHASE_IMPLEMENTATION && runPlan.worktreeIdentity && implementationWorkspace?.allowed) {
    try {
      const handleAgent = runPlan.agent?.agentId || 'claude-code-cli';
      const handleModel = runPlan.agent?.model || runPlan.profile?.model || null;
      const handleHarness = runPlan.agent?.agentType || 'claude';
      const checkpointHead = implementationEvidence?.worktree?.head || null;
      const checkpointStatusFingerprint = implementationEvidence?.worktree?.statusFingerprint || null;
      const written = writeRestrictedRecoveryHandle(args.outputDir, restrictedAttemptId, {
        attemptId: restrictedAttemptId,
        sessionId: extractRestrictedSessionId(result.stdout || ''),
        worktreeName: runPlan.worktreeIdentity.name,
        expectedBranch: runPlan.worktreeIdentity.expectedBranch,
        // Continuation lineage identity. Present only for PR continuation, and
        // required to match exactly before a dirty worktree may be reused
        // (verifyPrContinuationRecoveryCheckpoint).
        continuationKind: isPrContinuation ? PR_CONTINUATION_RECOVERY_HANDLE_KIND : null,
        continuationRepository: isPrContinuation ? continuationRepository : null,
        continuationPrNumber: isPrContinuation ? runPlan.prNumber : null,
        // The exact checkpoint this attempt can resume from — not merely
        // "some commit exists". verifyPreservedWorktree() requires HEAD to
        // still equal checkpointHead exactly, and (when captured) the
        // working-tree status fingerprint to still match, before treating
        // the checkpoint as current (#698 finding 2 re-review).
        checkpointHead,
        checkpointStatusFingerprint,
        // The PR head this attempt started from, before any commit it made.
        // Ordinary dirty-checkpoint recovery never needs this (its
        // checkpointHead already equals the published PR head), but
        // committed-ahead recovery (#316) does: it must positively prove the
        // preserved local commit's sole parent is the exact PR head this
        // handle was captured against, not merely "some earlier head".
        preRunHeadSha: implementationWorkspace?.baseHead || null,
        agent: handleAgent,
        model: handleModel,
        harness: handleHarness,
        capturedAt: new Date().toISOString(),
      });
      restrictedRecoveryHandleDigest = written.digest;
      // A dedicated digest binding this handle to the attempt's identity
      // (agent/model/harness/checkpoint) at capture time — persisted to a
      // write-once column, distinct from the generic handle-tamper digest
      // above, and independently recomputed/verified at revalidation time
      // (#698 finding 8).
      restrictedHandleBindingDigestValue = restrictedHandleBindingDigest({
        attemptId: restrictedAttemptId, agent: handleAgent, model: handleModel, harness: handleHarness,
        checkpointHead, checkpointStatusFingerprint,
      });
    } catch { /* restricted capture is best-effort; recovery simply stays unavailable */ }
  }
  const checkpointAvailable = Boolean(implementationEvidence?.worktree?.head);
  const sessionAvailable = resultEnvelope.hasSessionId;
  const recoveryEvidence = {
    sameProfileAvailable: Boolean(runPlan.profile?.model && runPlan.profile?.effort),
  };

  const payload = {
    ...planWithPrompt,
    dryRun: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal,
    stdout: redactSensitiveText(resultText),
    stderr: redactSensitiveText(result.stderr || ''),
    usageAccounting,
    outputBudgetShadow,
    spawnError: result.error ? String(result.error.message || result.error) : null,
    executionNoop: executionCheck.noop,
    executionNoopReason: executionCheck.reason,
    failureReason,
    planProduced: planCheck.planProduced,
    planPath: planCheck.planPath,
    awaitingPlanApproval: runPlan.executionPhase === EXECUTION_PHASE_PLAN && planCheck.planProduced,
    implementationEvidence,
    implementationPublication,
    prePublicationRevalidation,
    checkpointAvailable,
    sessionAvailable,
    recoveryEvidence,
    restrictedRecoveryHandleDigest,
    restrictedHandleBindingDigest: restrictedHandleBindingDigestValue,
  };
  const logPath = writeRunLog({ outputDir: args.outputDir, label, payload });
  console.log(JSON.stringify({ ...payload, stdout: '<see log>', stderr: '<see log>', logPath }, null, 2));
  if (executionCheck.noop) return 1;
  if (planCheck.planProduced) {
    return runPlan.executionPhase === EXECUTION_PHASE_IMPLEMENTATION ? 1 : PLAN_ONLY_EXIT_CODE;
  }
  if (failureReason) return result.status && result.status !== 0 ? result.status : 1;
  return result.status === null ? 1 : result.status;
}

/**
 * The deterministic restricted-recovery attempt id for one PR's continuation
 * lineage. Deliberately independent of head SHA and of any per-process value,
 * so the run that *fails* and the next run that must recover address the same
 * handle. The head/status identity that actually authorises recovery lives
 * inside the handle, not in its name.
 */
export function prContinuationAttemptId({ repo, prNumber }) {
  return `pr-continuation:${String(repo || '').replace(/\//g, '_')}:${prNumber}`;
}

export const PR_CONTINUATION_RECOVERY_HANDLE_KIND = 'pr-continuation';

/**
 * #242 defect 4: decide whether a dirty continuation worktree is the exact
 * preserved checkpoint of this PR's previous failed continuation.
 *
 * Reuses the existing restricted recovery handle store rather than adding a
 * second checkpoint mechanism. Every field must match: the handle must be
 * permission-safe and available, addressed to this repository/PR/branch, and
 * record a checkpoint head equal to the published PR head *and* a status
 * fingerprint byte-identical to what the worktree contains right now. Any
 * unrelated edit changes the fingerprint and fails closed, and nothing here
 * ever resets, cleans, stashes or commits the preserved work.
 */
export function verifyPrContinuationRecoveryCheckpoint({
  outputDir,
  repository,
  prNumber,
  branch,
  headSha,
  worktreeIdentity,
  statusFingerprint,
  readHandle = readRestrictedRecoveryHandle,
} = {}) {
  const refuse = (failureReason) => Object.freeze({ recoverable: false, failureReason, handleDigest: null });
  if (!outputDir || !repository || !branch || !headSha || !statusFingerprint) {
    return refuse('pr-continuation-recovery-input-missing');
  }

  let read;
  try {
    read = readHandle(outputDir, prContinuationAttemptId({ repo: repository, prNumber }));
  } catch {
    return refuse('pr-continuation-recovery-handle-unreadable');
  }
  if (read?.permissionSafe !== true) return refuse('pr-continuation-recovery-handle-permission-unsafe');
  if (read?.available !== true || !read.handle) return refuse('pr-continuation-no-preserved-checkpoint');

  const handle = read.handle;
  if (handle.continuationKind !== PR_CONTINUATION_RECOVERY_HANDLE_KIND) return refuse('pr-continuation-recovery-handle-kind-mismatch');
  if (handle.continuationRepository !== repository) return refuse('pr-continuation-recovery-repository-mismatch');
  if (handle.continuationPrNumber !== prNumber) return refuse('pr-continuation-recovery-pr-mismatch');
  if (handle.expectedBranch !== branch) return refuse('pr-continuation-recovery-branch-mismatch');
  if (worktreeIdentity?.name && handle.worktreeName !== worktreeIdentity.name) {
    return refuse('pr-continuation-recovery-worktree-mismatch');
  }
  // The preserved work must sit on exactly the published PR head: a
  // checkpoint taken against a different commit is not this PR's state.
  if (handle.checkpointHead !== headSha) return refuse('pr-continuation-recovery-head-mismatch');
  if (!handle.checkpointStatusFingerprint) return refuse('pr-continuation-recovery-status-unrecorded');
  if (handle.checkpointStatusFingerprint !== statusFingerprint) {
    return refuse('pr-continuation-recovery-worktree-modified');
  }

  return Object.freeze({ recoverable: true, failureReason: null, handleDigest: read.digest || null });
}

/**
 * #316: decide whether an unpublished, already-*committed* continuation
 * checkpoint (as opposed to the merely-dirty checkpoint above) is the exact
 * preserved one-commit-ahead state of this PR's previous authorised
 * continuation attempt.
 *
 * This is a distinct, narrower recovery shape from
 * `verifyPrContinuationRecoveryCheckpoint` -- it is only ever consulted when
 * the worktree's committed HEAD is *not* the published PR head at all, which
 * that function already refuses unconditionally. Every proposition in #316's
 * admissible shape must be positively proven: the restricted handle must be
 * permission-safe and addressed to this exact repository/PR/branch/worktree,
 * must record this exact local commit as its checkpoint, must record this
 * exact (unchanged) PR head as the head it was captured against, and the
 * checkpoint commit's git history must show exactly one unpublished commit
 * -- a sole parent equal to that same PR head. Nothing here ever resets,
 * cleans, stashes, amends, or pushes; it only proves a fact about existing
 * git history and a previously captured restricted handle.
 */
export function verifyPrContinuationCommittedAheadCheckpoint({
  outputDir,
  repository,
  prNumber,
  branch,
  prHeadSha,
  checkpointHeadSha,
  worktreeIdentity,
  rootPath,
  runner = spawnSync,
  readHandle = readRestrictedRecoveryHandle,
} = {}) {
  const refuse = (failureReason) => Object.freeze({
    recoverable: false, failureReason, handleDigest: null, expectedStatusFingerprint: null,
  });
  if (!outputDir || !repository || !branch || !prHeadSha || !checkpointHeadSha || !rootPath) {
    return refuse('pr-continuation-committed-ahead-input-missing');
  }
  if (checkpointHeadSha === prHeadSha) return refuse('pr-continuation-committed-ahead-not-ahead');

  let read;
  try {
    read = readHandle(outputDir, prContinuationAttemptId({ repo: repository, prNumber }));
  } catch {
    return refuse('pr-continuation-committed-ahead-handle-unreadable');
  }
  if (read?.permissionSafe !== true) return refuse('pr-continuation-committed-ahead-handle-permission-unsafe');
  if (read?.available !== true || !read.handle) return refuse('pr-continuation-no-preserved-committed-ahead-checkpoint');

  const handle = read.handle;
  if (handle.continuationKind !== PR_CONTINUATION_RECOVERY_HANDLE_KIND) return refuse('pr-continuation-committed-ahead-handle-kind-mismatch');
  if (handle.continuationRepository !== repository) return refuse('pr-continuation-committed-ahead-repository-mismatch');
  if (handle.continuationPrNumber !== prNumber) return refuse('pr-continuation-committed-ahead-pr-mismatch');
  if (handle.expectedBranch !== branch) return refuse('pr-continuation-committed-ahead-branch-mismatch');
  if (worktreeIdentity?.name && handle.worktreeName !== worktreeIdentity.name) {
    return refuse('pr-continuation-committed-ahead-worktree-mismatch');
  }
  // The handle must record both the exact preserved local commit and the
  // exact PR head it was captured against -- a checkpoint recorded against a
  // different local commit, or against a different (older/newer) PR head,
  // is not this exact preserved state.
  if (handle.checkpointHead !== checkpointHeadSha) return refuse('pr-continuation-committed-ahead-head-mismatch');
  if (!handle.preRunHeadSha || handle.preRunHeadSha !== prHeadSha) {
    return refuse('pr-continuation-committed-ahead-pre-run-head-mismatch');
  }
  if (!handle.checkpointStatusFingerprint) return refuse('pr-continuation-committed-ahead-status-unrecorded');

  // Exactly one unpublished commit ahead for this v1 seam: the checkpoint's
  // sole parent must equal the unchanged PR head. Zero parents (root
  // commit), two or more parents (a merge commit), or a sole parent that is
  // not the PR head (more than one commit ahead, or a different lineage)
  // all fail closed rather than being generalised to an arbitrary range.
  const parentsResult = runGit(['rev-list', '--parents', '-n', '1', checkpointHeadSha], { cwd: rootPath, runner });
  if (parentsResult?.status !== 0) return refuse('pr-continuation-committed-ahead-history-unavailable');
  const parents = String(parentsResult.stdout || '').trim().split(/\s+/).slice(1);
  if (parents.length !== 1 || parents[0] !== prHeadSha) {
    return refuse('pr-continuation-committed-ahead-not-single-parent');
  }

  return Object.freeze({
    recoverable: true,
    failureReason: null,
    handleDigest: read.digest || null,
    expectedStatusFingerprint: handle.checkpointStatusFingerprint,
  });
}

/**
 * Resolve the #241 continuation binding for a direct `--pr --execute`
 * follow-up (#242): the linked issue must be unique and explicit before any
 * GitHub read of it is attempted, and every other refusal path is delegated
 * to `resolvePrContinuationBinding` itself so this wiring never duplicates
 * its identity/authority/workspace logic.
 */
export async function resolvePrExecutionBinding({
  pullRequest, repo, config, env, token, outputDir = null,
}) {
  const linkedIssueNumbers = linkedIssueNumbersFromPr({ title: pullRequest.title || '', body: pullRequest.body || '' });
  const { issue: linkedIssueRecord, comments: linkedIssueComments } = linkedIssueNumbers.length === 1
    ? await fetchIssueAndComments({ repo, issue: linkedIssueNumbers[0], token })
    : { issue: {}, comments: [] };

  const binding = resolvePrContinuationBinding({
    pullRequest,
    issue: linkedIssueRecord,
    issueComments: linkedIssueComments,
    repo,
    config,
    env,
    resolveDispatchIdentity: resolveImplementationDispatchIdentity,
    prepareWorkspace: prepareContinuationWorkspace,
    captureEvidence: captureGitRepositoryEvidence,
    verifyRecoveryCheckpoint: outputDir
      ? (input) => verifyPrContinuationRecoveryCheckpoint({ ...input, outputDir })
      : null,
    verifyCommittedAheadCheckpoint: outputDir
      ? (input) => verifyPrContinuationCommittedAheadCheckpoint({ ...input, outputDir })
      : null,
  });

  // The already-fetched linked issue travels with the binding so the
  // canonical continuation prompt can carry the real issue identity/body
  // without a second GitHub read. Refusals carry no issue evidence.
  return binding.allowed === true
    ? Object.freeze({ ...binding, linkedIssue: linkedIssueRecord })
    : binding;
}

export async function runPrFollowUp(args, env, token, config = {}, {
  resolveBinding = resolvePrExecutionBinding,
  run = runOrPlanClaude,
} = {}) {
  const { pullRequest, reviews, comments, reviewThreads } = await fetchPullRequestReviewContext({ repo: args.repo, pr: args.pr, token });
  const unresolved = detectUnresolvedReviewFollowUp({ reviews, reviewThreads, comments });
  const branch = pullRequest.head?.ref || '(unknown branch)';
  const linkedIssue = linkedIssueNumberFromPr({ body: pullRequest.body, title: pullRequest.title });

  if (!unresolved.hasUnresolvedFollowUp) {
    const payload = {
      mode: PR_REVIEW_FOLLOWUP_MODE,
      pr: args.pr,
      repo: args.repo,
      hasUnresolvedFollowUp: false,
      message: `No unresolved review/manager feedback detected on PR #${args.pr}. Nothing to follow up on.`,
    };
    const logPath = writeRunLog({ outputDir: args.outputDir, label: `pr-${args.pr}`, payload });
    console.log(JSON.stringify({ ...payload, logPath }, null, 2));
    return 0;
  }

  const clearContext = shouldUseClear({ noClear: args.noClear, resumeSession: args.resumeSession });

  // #242 defect 3: only GitHub-authoritative feedback from an author with
  // write standing may become executable input. This is evaluated before the
  // continuation binding so an untrusted trigger never causes a linked-issue
  // read, a worktree inspection, or a provider launch.
  const executableFeedback = args.execute
    ? selectExecutableReviewFeedback({ reviews, reviewThreads })
    : null;
  if (args.execute && executableFeedback.executable !== true) {
    const payload = {
      mode: PR_REVIEW_FOLLOWUP_MODE,
      pr: args.pr,
      repo: args.repo,
      dryRun: false,
      blocked: true,
      reason: executableFeedback.failureReason,
      failureReason: executableFeedback.failureReason,
      rejectedAuthorCount: executableFeedback.rejectedAuthorCount,
      message: `No executable review instruction from an author with write standing on ${args.repo} was found for PR #${args.pr} (${executableFeedback.failureReason}). No Claude process was started.`,
    };
    const logPath = writeRunLog({ outputDir: args.outputDir, label: `pr-${args.pr}`, payload });
    console.log(JSON.stringify({ ...payload, logPath }, null, 2));
    return EXECUTION_POLICY_EXIT_CODE;
  }

  // A write-capable direct --pr --execute run must bind to the exact
  // existing authorised PR continuation (#241) before it can ever be
  // treated as implementation. This is only attempted with --execute: a
  // dry-run preview never touches GitHub for the linked issue or inspects a
  // local worktree, matching the existing preview-only contract.
  let continuationBinding = null;
  if (args.execute) {
    continuationBinding = await resolveBinding({
      pullRequest, repo: args.repo, config, env, token, outputDir: args.outputDir,
    });
    if (!continuationBinding.allowed) {
      const payload = {
        mode: PR_REVIEW_FOLLOWUP_MODE,
        pr: args.pr,
        repo: args.repo,
        dryRun: false,
        blocked: true,
        reason: continuationBinding.failureReason,
        failureReason: continuationBinding.failureReason,
        // A dirty-worktree refusal now also reports *why* recovery was not
        // possible, so a preserved failed continuation is diagnosable
        // without anyone inspecting (or clearing) the worktree by hand.
        recoveryFailureReason: continuationBinding.recoveryFailureReason || null,
        message: `Safe PR continuation binding refused this follow-up (${continuationBinding.failureReason}). No Claude process was started.`,
      };
      const logPath = writeRunLog({ outputDir: args.outputDir, label: `pr-${args.pr}`, payload });
      console.log(JSON.stringify({ ...payload, logPath }, null, 2));
      return EXECUTION_POLICY_EXIT_CODE;
    }
  }

  // Caller-supplied --profile/--model/--effort must never widen an
  // authorised continuation: once bound, only the manager-approved
  // profile/model/effort from the binding are used. They remain available
  // for the unauthenticated dry-run preview, which carries no write
  // capability.
  const implementationToolPolicy = continuationBinding
    ? buildImplementationToolPolicy({
      expectedBranch: continuationBinding.worktreeIdentity.expectedBranch,
      approvedBranch: continuationBinding.dispatchAuthority?.branch,
    })
    : null;
  const profile = continuationBinding
    ? resolveProfile(continuationBinding.profileName, {
      model: continuationBinding.managerExecutionMeta?.model,
      effort: continuationBinding.managerExecutionMeta?.effort,
      permissionMode: continuationBinding.executionAuthorization.permissionMode,
      tools: implementationToolPolicy?.tools,
      allowedTools: implementationToolPolicy?.allowedTools,
      disallowedTools: implementationToolPolicy?.disallowedTools,
      worktreeName: nativeClaudeWorktreeName(continuationBinding.worktreeIdentity),
      strictMcpConfig: implementationToolPolicy?.strictMcpConfig,
      disableSlashCommands: implementationToolPolicy?.disableSlashCommands,
      settings: implementationToolPolicy?.settings,
      settingSources: implementationToolPolicy?.settingSources,
    }, env)
    : resolveProfile(
      inferProfile({ explicitProfile: args.profile, issue: { title: pullRequest.title, body: pullRequest.body } }),
      { model: args.model, effort: args.effort },
      env,
    );
  const contextPolicyShadow = buildClaudeContextPolicyShadow({
    taskIdentity: {
      projectId: config.projectId || null,
      githubRepo: args.repo,
      issueNumber: continuationBinding?.issueNumber ?? linkedIssue ?? null,
      prNumber: continuationBinding?.prNumber ?? args.pr,
      branch: continuationBinding?.dispatchAuthority?.branch || branch,
      sourceFingerprint: continuationBinding?.authority?.fingerprint || null,
      authorityRevision: continuationBinding?.authority?.revision || null,
    },
    profile,
    resumeSession: args.resumeSession,
    recoveryMode: args.recoveryMode,
    clearContext,
  });
  // #242 defects 1 and 2. A bound, write-capable continuation compiles
  // through the canonical implementation compiler -- so it inherits the
  // clean-commit invariant whose absence caused the field failure, and
  // produces real #193 stable-prefix cache metadata instead of null. The
  // unauthenticated dry-run preview has no binding, profile, worktree or
  // repository context to compile against and stays on the preview-only
  // builder; `promptContract` records which artifact a log is showing so the
  // two can never be mistaken for one another.
  const continuationPromptInput = continuationBinding
    ? {
      issue: continuationBinding.linkedIssue?.number
        ? continuationBinding.linkedIssue
        : { number: continuationBinding.issueNumber, title: pullRequest.title || '', body: '' },
      pullRequest,
      prNumber: continuationBinding.prNumber,
      branch: continuationBinding.dispatchAuthority?.branch || branch,
      instructions: executableFeedback?.instructions || [],
      profile,
      clearContext,
      worktreeIdentity: continuationBinding.worktreeIdentity,
      repositoryContext: continuationBinding.repositoryContext,
      authorityRevision: continuationBinding.authority?.revision || null,
    }
    : null;
  const prompt = continuationPromptInput
    ? buildPrContinuationPromptSections(continuationPromptInput).prompt
    : buildReviewFollowUpPrompt({
      pr: { number: args.pr, title: pullRequest.title, url: pullRequest.html_url },
      issueNumber: linkedIssue,
      branch,
      unresolved,
      repo: args.repo,
    });
  const claudeArgs = buildClaudeArgs({ prompt, profile, resumeSession: args.resumeSession });

  const runPlan = {
    mode: PR_REVIEW_FOLLOWUP_MODE,
    dryRun: !args.execute,
    pr: args.pr,
    prNumber: continuationBinding?.prNumber ?? args.pr,
    repo: args.repo,
    linkedIssue,
    branch,
    reasons: unresolved.reasons,
    repositoryContext: continuationBinding?.repositoryContext || null,
    executionPhase: continuationBinding ? EXECUTION_PHASE_IMPLEMENTATION : undefined,
    executionAuthorization: continuationBinding?.executionAuthorization || null,
    worktreeIdentity: continuationBinding?.worktreeIdentity || null,
    implementationToolPolicy: implementationToolPolicy ? {
      tools: implementationToolPolicy.tools,
      allowedToolRuleCount: implementationToolPolicy.allowedToolRuleCount,
      disallowedToolRuleCount: implementationToolPolicy.disallowedToolRuleCount,
      strictMcpConfig: implementationToolPolicy.strictMcpConfig,
      disableSlashCommands: implementationToolPolicy.disableSlashCommands,
    } : null,
    preRunHeadSha: continuationBinding?.preRunHeadSha || null,
    recoveredCheckpoint: continuationBinding?.recoveredCheckpoint || null,
    promptContract: continuationPromptInput ? 'canonical-implementation' : 'review-followup-preview',
    promptCacheMetadata: continuationPromptInput
      ? prContinuationPromptCacheMetadata(continuationPromptInput)
      : null,
    contextPolicyShadow,
    executableReviewFeedback: executableFeedback
      ? {
        instructionCount: executableFeedback.instructions.length,
        rejectedAuthorCount: executableFeedback.rejectedAuthorCount,
        truncatedInstructionCount: executableFeedback.truncatedInstructionCount || 0,
        unresolvedThreadIds: executableFeedback.unresolvedThreadIds,
      }
      : null,
    profile,
    costAdmission: evaluateClaudeCostAdmission(profile, env),
    agent: agentRunMetadata(resolveAgentById('claude-code-cli'), profile),
    clearContext,
    claudeCommand: args.claudeBin,
    inheritProviderAuth: args.inheritProviderAuth,
    removedClaudeProviderAuthKeys: removedClaudeProviderAuthKeys(env, { inheritProviderAuth: args.inheritProviderAuth }),
    claudeArgsPreview: redactExecutableArgs(claudeArgs, { redactFinalAsPrompt: true }),
  };

  return run({
    args,
    env,
    label: `pr-${args.pr}`,
    runPlan,
    prompt,
    claudeArgs,
    // #242 defect 5: authority is bound *before* the model starts, but the
    // model then runs for minutes. Re-read the authoritative state once more
    // immediately before publication, so a PR that was closed, a branch that
    // was repointed, a remote head that advanced under us, revoked manager
    // authority, or feedback that stopped being executable can never be
    // published onto. This never force-pushes and never opens a replacement
    // PR: it only decides whether the deterministic same-PR publication is
    // still legitimate.
    prePublicationCheck: continuationBinding
      ? () => revalidatePrContinuationAuthority({
        repo: args.repo, binding: continuationBinding, token,
      })
      : null,
  });
}

/**
 * Re-verify, immediately before publication, that the exact authority this
 * continuation was bound to is still the live authority. Read-only: it makes
 * no GitHub mutation and no local repository change.
 */
export async function revalidatePrContinuationAuthority({
  repo, binding, token, fetchReviewContext = fetchPullRequestReviewContext, fetchIssue = fetchIssueAndComments,
}) {
  const refuse = (failureReason) => ({ allowed: false, failureReason });
  let context;
  try {
    context = await fetchReviewContext({ repo, pr: binding.prNumber, token });
  } catch {
    return refuse('pr-continuation-revalidation-unavailable');
  }
  const pullRequest = context?.pullRequest;
  if (!pullRequest || pullRequest.number !== binding.prNumber) return refuse('pr-continuation-revalidation-pr-number-changed');
  if (pullRequest.state !== 'open') return refuse('pr-continuation-revalidation-pr-not-open');
  if (pullRequest.head?.ref !== binding.branch) return refuse('pr-continuation-revalidation-branch-changed');
  if (pullRequest.head?.repo?.full_name !== binding.repository) return refuse('pr-continuation-revalidation-repository-changed');
  // The published head must still be exactly the head this continuation was
  // bound to. If the remote advanced while the model was running, the local
  // commit is no longer a continuation of the reviewed state.
  if (pullRequest.head?.sha !== binding.preRunHeadSha) return refuse('pr-continuation-revalidation-remote-head-advanced');

  const feedback = selectExecutableReviewFeedback({
    reviews: context.reviews, reviewThreads: context.reviewThreads,
  });
  if (feedback.executable !== true) return refuse('pr-continuation-revalidation-feedback-withdrawn');

  let issueComments;
  try {
    ({ comments: issueComments } = await fetchIssue({ repo, issue: binding.issueNumber, token }));
  } catch {
    return refuse('pr-continuation-revalidation-unavailable');
  }
  const authority = resolveManagerContinuationAuthority(issueComments);
  if (!authority.allowed || !authority.authority) return refuse('pr-continuation-revalidation-authority-revoked');
  if (binding.authority?.authorityKey && authority.authority.authorityKey !== binding.authority.authorityKey) {
    return refuse('pr-continuation-revalidation-authority-changed');
  }

  return { allowed: true, failureReason: null };
}

export function assertConfiguredRepositoryIdentity({ configPath, config, repo }) {
  if (!configPath) return;
  if (repo !== config.githubRepo) {
    throw new Error(
      `Repository override ${repo} does not match configured repository ${config.githubRepo}`,
    );
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const configPath = resolveConfigPath(argv, env);
  const config = loadAgentRunnerConfig({ argv, env, configPath });
  // Fails closed before any GitHub/model/repository mutation when ambient
  // GITHUB_REPOSITORY disagrees with the selected project config (#169).
  assertProjectScopedEnv({ config, configPath, env });
  // A selected project config owns repository identity; an explicit --repo
  // still wins, but the default must never fall back to the ModelSpend
  // DEFAULT_REPO when a non-ModelSpend config was supplied (#180).
  const args = parseArgs(stripConfigArgs(argv), {
    defaultRepo: configPath ? config.githubRepo : (env.GITHUB_REPOSITORY || DEFAULT_REPO),
  });
  // A selected project config is authoritative. An explicit --repo may
  // restate that exact identity but must never redirect configured execution.
  assertConfiguredRepositoryIdentity({ configPath, config, repo: args.repo });
  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.checkQuota) {
    return runQuotaCheck(args, env);
  }

  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) throw new Error('Missing GITHUB_TOKEN or GH_TOKEN environment variable');

  const quotaStatePath = args.quotaStatePath || defaultQuotaStatePath(args.outputDir);
  const pauseEval = evaluateQuotaPauseState(readQuotaPauseState(quotaStatePath), {});
  if (pauseEval.paused) {
    const payload = {
      blocked: true,
      reason: 'quota-paused',
      pausedUntil: pauseEval.pausedUntil.toISOString(),
      quotaStatePath,
      message: 'Claude quota is paused after a detected exhaustion/rate-limit signal. Resume is automatic once pausedUntil passes, or run --check-quota (at least 10 minutes after the last check) to re-check now. This never bypasses the underlying limit.',
    };
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  if (args.pr) {
    return runPrFollowUp(args, env, token, config);
  }

  if (!args.issue) throw new Error('Missing required --issue <number> (or --pr <number> for review follow-up mode)');

  if (!args.skipPrFollowUpCheck) {
    const blockingPr = await findBlockingPrFollowUp({ repo: args.repo, issue: args.issue, token });
    if (blockingPr) {
      const payload = {
        blocked: true,
        reason: 'unresolved-pr-review-followup',
        issue: args.issue,
        pr: blockingPr.pr.number,
        prUrl: blockingPr.pr.url || null,
        reasons: blockingPr.unresolved.reasons,
        message: `PR #${blockingPr.pr.number} linked to issue #${args.issue} has unresolved review/manager feedback. Run --pr ${blockingPr.pr.number} to generate a follow-up prompt before starting new issue work. Pass --skip-pr-followup-check to override.`,
      };
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
  }

  const { issue, comments } = await fetchIssueAndComments({ repo: args.repo, issue: args.issue, token });
  const managerAuthority = resolveCurrentManagerAuthority(comments);
  if (!managerAuthority.allowed) {
    throw new Error(`No current canonical manager preflight authority found on issue #${args.issue}: ${managerAuthority.reason}`);
  }
  const command = null;
  const currentPreflight = managerAuthority.authority.comment;

  // Single derivation boundary (#686): the scheduler's pre-claim
  // workspace-ownership check in claude-runner-cron.mjs calls this exact
  // function too, so it can never guard a different worktreeIdentity than
  // the one this run actually dispatches against.
  const dispatchIdentity = resolveImplementationDispatchIdentity({
    issue, command, currentPreflight, config, env,
    argsRepo: args.repo, argsProfile: args.profile, argsModel: args.model,
    argsEffort: args.effort,
  });
  if (!dispatchIdentity.ok) {
    const payload = {
      blocked: true,
      reason: dispatchIdentity.failureReason,
      issue: args.issue,
      message: `The dispatch authority (repository/branch) for issue #${args.issue} could not be resolved unambiguously (${dispatchIdentity.failureReason}). No Claude process was started.`,
    };
    console.log(JSON.stringify(payload, null, 2));
    return EXECUTION_POLICY_EXIT_CODE;
  }
  const {
    preflight, selectionMode, managerExecutionMeta, dispatchAuthority, repositoryContext, profileName,
    executionAuthorization, sourceCommentIdentity, sourcePreflightCommentIdentity, worktreeIdentity,
  } = dispatchIdentity;

  const requiredCapabilities = resolveManagerPreflightRequiredCapabilities(currentPreflight);
  if (!requiredCapabilities.valid) {
    const payload = {
      blocked: true,
      reason: 'unknown-required-capability',
      issue: args.issue,
      unknownCapabilities: requiredCapabilities.unknown,
      message: `The current manager preflight for issue #${args.issue} declares unknown required_capabilities (${requiredCapabilities.unknown.join(', ')}). No Claude process was started.`,
    };
    console.log(JSON.stringify(payload, null, 2));
    return EXECUTION_POLICY_EXIT_CODE;
  }

  const implementationToolPolicy = worktreeIdentity
    ? buildImplementationToolPolicy({
      expectedBranch: worktreeIdentity.expectedBranch,
      approvedBranch: dispatchAuthority?.branch,
      requiredCapabilities: requiredCapabilities.capabilities,
    })
    : null;
  const profile = resolveProfile(profileName, {
    model: args.model || managerExecutionMeta.model,
    effort: args.effort || managerExecutionMeta.effort,
    permissionMode: executionAuthorization.permissionMode,
    tools: implementationToolPolicy?.tools,
    allowedTools: implementationToolPolicy?.allowedTools,
    disallowedTools: implementationToolPolicy?.disallowedTools,
    worktreeName: nativeClaudeWorktreeName(worktreeIdentity),
    strictMcpConfig: implementationToolPolicy?.strictMcpConfig,
    disableSlashCommands: implementationToolPolicy?.disableSlashCommands,
    settings: implementationToolPolicy?.settings,
    settingSources: implementationToolPolicy?.settingSources,
  }, env);

  const clearContext = shouldUseClear({ noClear: args.noClear, resumeSession: args.resumeSession });
  const contextPolicyShadow = buildClaudeContextPolicyShadow({
    taskIdentity: {
      projectId: config.projectId || null,
      githubRepo: args.repo,
      issueNumber: args.issue,
      branch: dispatchAuthority?.branch || null,
      sourceFingerprint: managerAuthority.authority.fingerprint || null,
      authorityRevision: managerAuthority.authority.revision || null,
    },
    profile,
    resumeSession: args.resumeSession,
    recoveryMode: args.recoveryMode,
    clearContext,
  });
  const prompt = command
    ? buildClaudePrompt({
      issue: { number: args.issue, title: issue.title },
      commandText: command.body,
      currentPreflight,
      profile,
      clearContext,
      executionPhase: executionAuthorization.phase,
      worktreeIdentity,
      repositoryContext,
    })
    : buildPreflightDirectPrompt({
      issue: { number: args.issue, title: issue.title, body: issue.body },
      preflight,
      profile,
      clearContext,
      executionPhase: executionAuthorization.phase,
      worktreeIdentity,
      repositoryContext,
    });
  const claudeArgs = buildClaudeArgs({ prompt, profile, resumeSession: args.resumeSession });
  const promptCacheMetadata = command
    ? claudePromptCacheMetadata({
      issue: { number: args.issue, title: issue.title },
      commandText: command.body,
      currentPreflight,
      profile,
      clearContext,
      executionPhase: executionAuthorization.phase,
      worktreeIdentity,
      repositoryContext,
    })
    : claudePromptCacheMetadata({
      issue: { number: args.issue, title: issue.title, body: issue.body },
      preflight,
      selectionMode: 'preflight-direct',
      profile,
      clearContext,
      executionPhase: executionAuthorization.phase,
      worktreeIdentity,
      repositoryContext,
    });

  const runPlan = {
    dryRun: !args.execute,
    issue: args.issue,
    issueTitle: issue.title,
    repo: args.repo,
    repositoryContext,
    selectionMode,
    promptCacheMetadata,
    contextPolicyShadow,
    commandKind: command?.kind || null,
    commandHeading: command?.heading || null,
    sourceCommentId: command?.sourceCommentId || null,
    sourceCommentIdentity,
    sourcePreflightCommentIdentity,
    sourcePreflightRevision: managerAuthority.authority.revision,
    sourcePreflightFingerprint: managerAuthority.authority.fingerprint,
    sourcePreflightAuthorityKey: managerAuthority.authority.authorityKey,
    sourcePreflightCommentId: commentRevision(sourcePreflightCommentIdentity),
    executionPhase: executionAuthorization.phase,
    executionAuthorization,
    worktreeIdentity,
    implementationToolPolicy: implementationToolPolicy ? {
      tools: implementationToolPolicy.tools,
      allowedToolRuleCount: implementationToolPolicy.allowedToolRuleCount,
      disallowedToolRuleCount: implementationToolPolicy.disallowedToolRuleCount,
      strictMcpConfig: implementationToolPolicy.strictMcpConfig,
      disableSlashCommands: implementationToolPolicy.disableSlashCommands,
    } : null,
    profile,
    costAdmission: evaluateClaudeCostAdmission(profile, env),
    agent: agentRunMetadata(resolveAgentById('claude-code-cli'), profile),
    clearContext,
    claudeCommand: args.claudeBin,
    inheritProviderAuth: args.inheritProviderAuth,
    removedClaudeProviderAuthKeys: removedClaudeProviderAuthKeys(env, { inheritProviderAuth: args.inheritProviderAuth }),
    claudeArgsPreview: redactExecutableArgs(claudeArgs, { redactFinalAsPrompt: true }),
  };

  return runOrPlanClaude({ args, env, label: `issue-${args.issue}`, runPlan, prompt, claudeArgs });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
