#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertProjectScopedEnv, loadAgentRunnerConfig, resolveConfigPath, stripConfigArgs } from './agent-runner-config.mjs';
import {
  AGENT_ADAPTERS,
  agentRunMetadata,
  allAgentLabels,
  resolveAgentForLabels,
  unsupportedAgentSkip,
} from './agent-runner-agents.mjs';
import {
  CLAUDE_AGENT_ID,
  getAgentSettings,
  settingsRevisionUnchanged,
  snapshotAgentSettings,
} from './agent-runner-agent-settings.mjs';
import { executionLabelAuthority } from './agent-runner-label-authority.mjs';
import { classifyIssueTaskRisk } from './agent-runner-qualification.mjs';
import {
  OLLAMA_AGENT_ID,
  QUALIFIED_OLLAMA_CODING_MODEL,
  QUALIFIED_OPENCODE_VERSION,
  QUALIFIED_OLLAMA_VERSION,
  admitOllamaDispatch,
} from './agent-runner-ollama-adapter.mjs';
import {
  classifyBoundedOllamaShellCommand,
  isShellTrustedRepository,
} from './agent-runner-ollama-shell-policy.mjs';
import { resolveBoundedOllamaManagerContract } from './agent-runner-ollama-worker-contract.mjs';
import { selectAgentForIssue } from './agent-runner-routing.mjs';
import { computeInstanceReadiness } from './agent-runner-control-readiness.mjs';
import {
  ambiguousAgentLabelsDedupeKey,
  applyPlannedReassignment,
  buildAmbiguousAgentLabelsEvidenceCommentBody,
  buildNoQualifiedAgentEvidenceCommentBody,
  buildReassignmentEvidenceCommentBody,
  noQualifiedAgentDedupeKey,
  planReassignment,
  reassignmentDedupeKey,
  verifyLabelMutation,
} from './agent-runner-reassignment.mjs';

import {
  RUNNER_STARTED_HEADING,
  STATUS_IN_PROGRESS,
  STATUS_READY,
  commandAlreadyClaimed,
  commentTime,
  hasManagerPreflight,
  invalidatesManagerPreflight,
  latestManagerPreflightComment,
  preflightAlreadyClaimed,
  resolveIssueSelection,
  runnableCommandForIssue,
} from './claude-runner-selection.mjs';
import {
  commentRevision,
  deserializeCommentIdentity,
  normalizeCommentIdentity,
  requireRestCommentDatabaseId,
  sameCommentIdentity,
} from './claude-runner-comment-identity.mjs';
import { findLinkedOpenPullRequests } from './claude-runner-review-followup.mjs';
import { managerAuthorityApprovesAgent, managerAuthorityKeyIsCurrent } from './agent-runner-manager-authority.mjs';
import { defaultRunnerStateDbPath, openRunnerStateStore } from './claude-runner-state.mjs';
import {
  RECOVERY_POLICY_REVISION,
  WORKSPACE_OWNERSHIP_OUTCOMES,
  WORKSPACE_OWNERSHIP_POLICY,
  backoffDeadline,
  buildAttentionEvent,
  decideRecovery,
  dispatchRecoveryAction,
  evaluateRecoveryRevalidation,
  normalizeTerminalOutcome,
  recoveryAttemptCapForOutcome,
} from './claude-runner-recovery.mjs';
import { inspectWorkspaceOwnership } from './agent-runner-workspace-ownership.mjs';
import { withWorkspaceIdentitySupport } from './agent-runner-workspace-identity-store.mjs';
import { withRecoveryIdentityGuard } from './agent-runner-recovery-identity-guard.mjs';
import { EXECUTION_PHASE_IMPLEMENTATION, inferProfile, isSupportedModelId, parseKeyValueBlock, resolveImplementationDispatchIdentity, resolveProfile } from './claude-runner.mjs';
import { anyProfileQuotaAdmissible, evaluateProfileQuotaAdmission, quotaAdmissionEvidenceFromPreflight } from './claude-runner-quota.mjs';
import {
  decorateIssueWithMetadata,
  priorityRank as metadataPriorityRank,
  statusRank as metadataStatusRank,
} from './issue-metadata.mjs';
import {
  detectClaudeResumeCliCapability,
  readRestrictedRecoveryHandle,
  restrictedHandleBindingDigest,
  restrictedHandleDigest,
  verifyPreservedWorktree,
} from './claude-runner-recovery-adapter.mjs';
import { redactExecutableArgs } from './lib/redact.mjs';
import { reconcileNotifications } from './agent-runner-notifications.mjs';
import { runAttentionReconciliation } from './agent-runner-attention-reconcile-command.mjs';
import { GhCliAttentionReadClient } from './agent-runner-attention-github-client.mjs';
import { attentionProjectionAttemptId, renderFailureProjectionSection, safeDeriveFailureProjection } from './agent-runner-failure-attention-projection.mjs';

const DEFAULT_REPO = 'TheTekTeam/modelspend';
const DEFAULT_LOCK = '.var/claude-runner/cron.lock';
const DEFAULT_OUTPUT = '.var/claude-runner';
// Resolved from this module's own location rather than passed as a bare
// relative path to spawn(): a bare 'scripts/ops/claude-runner.mjs' resolves
// against the spawning process's cwd, which run-project.sh has already
// changed to the configured project's checkout -- silently running that
// checkout's own vendored copy instead of this canonical implementation.
export const CLAUDE_RUNNER_ENTRYPOINT = fileURLToPath(new URL('./claude-runner.mjs', import.meta.url));
export const OLLAMA_RUNNER_ENTRYPOINT = fileURLToPath(new URL('./agent-runner-ollama-runner.mjs', import.meta.url));
const DEFAULT_AGENT_LABELS = allAgentLabels({ includeFuture: false });
// Issue #50 review round 3: the fixed, catalogue-derived label partition
// execution discovery and reconciliation discovery each read from --
// neither one is computed from the other or from `args.agentLabels`.
const IMPLEMENTED_AGENT_LABELS = allAgentLabels({ includeFuture: false });
const FOUNDATION_ONLY_AGENT_LABELS = allAgentLabels({ includeFuture: true })
  .filter((label) => !IMPLEMENTED_AGENT_LABELS.includes(label));
const DEFAULT_LIMIT = 100;
const DEFAULT_WATCHDOG_INTERVAL_MS = 10 * 60_000;
const DEFAULT_STALLED_PASS_LIMIT = 2;
const STATUS_BLOCKED = 'status:blocked';
export const RUNNER_ATTENTION_MARKER = '<!-- agent-runner:attention:v1 -->';

export {
  RUNNER_STARTED_HEADING,
  commandAlreadyClaimed,
  hasManagerPreflight,
  latestManagerPreflightComment,
  preflightAlreadyClaimed,
  runnableCommandForIssue,
};

export function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function githubTokenFromGh() {
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export function resolveGithubAuthEnv(env = process.env, tokenResolver = githubTokenFromGh) {
  if (env.GITHUB_TOKEN || env.GH_TOKEN) return { ...env };

  let token = '';
  try {
    token = String(tokenResolver?.() || '').trim();
  } catch {
    token = '';
  }

  if (!token) return null;
  return { ...env, GH_TOKEN: token };
}

/**
 * Ranking now flows through the issue-metadata adapter so a supplied Status /
 * Priority field wins over the compatibility label. Decorated candidates carry
 * a `metadata` object; undecorated issues (e.g. direct callers) fall back to
 * the raw issue, from which the adapter still derives values via labels and the
 * transport `statusLabel`.
 */
function priorityRank(issue) {
  return metadataPriorityRank(issue?.metadata || issue);
}

function statusRank(issue) {
  return metadataStatusRank(issue?.metadata || issue);
}

/**
 * Metadata field/label disagreements for one issue, safe to spread into skip or
 * selection payloads only when non-empty so existing exact-shape assertions on
 * conflict-free issues stay green.
 */
export function issueMetadataConflicts(issue) {
  return issue?.metadata?.conflicts || issue?.metadataConflicts || [];
}

export function metadataConflictSkip(issue) {
  const conflicts = issueMetadataConflicts(issue);
  const blockingConflicts = conflicts.filter((conflict) => conflict.key === 'status');
  if (blockingConflicts.length === 0) return null;
  return {
    issue: issue.number,
    statusLabel: issue.statusLabel,
    reason: 'metadata-conflict',
    metadataConflicts: blockingConflicts,
  };
}

function compareIssues(left, right) {
  const statusDelta = statusRank(left) - statusRank(right);
  if (statusDelta !== 0) return statusDelta;

  const priorityDelta = priorityRank(left) - priorityRank(right);
  if (priorityDelta !== 0) return priorityDelta;

  return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
}

export function parseAgentLabels(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const labels = raw.map((label) => String(label).trim()).filter(Boolean);
  return [...new Set(labels)];
}

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  // Preserve the exact project-config authority before stripping CLI-only
  // transport arguments. Every child must resolve the same repository and
  // checkout as the scheduler instead of falling back to compiled defaults.
  const configPath = resolveConfigPath(argv, env);
  const config = loadAgentRunnerConfig({ argv, env, configPath });
  argv = stripConfigArgs(argv);
  // Shared machine environment must never silently redirect this run's
  // identity into a different configured project's state tree (#169).
  assertProjectScopedEnv({ config, configPath, env });
  const outputDir = env.CLAUDE_RUNNER_OUTPUT_DIR || config.outputDir || DEFAULT_OUTPUT;
  const args = {
    configPath,
    repo: env.GITHUB_REPOSITORY || config.githubRepo || DEFAULT_REPO,
    lockPath: env.CLAUDE_RUNNER_CRON_LOCK || config.runner?.lockPath || DEFAULT_LOCK,
    outputDir,
    stateDbPath: env.CLAUDE_RUNNER_STATE_DB || config.stateDbPath || defaultRunnerStateDbPath(outputDir),
    agentLabels: parseAgentLabels(env.CLAUDE_RUNNER_CRON_AGENT_LABELS || config.acceptedAgentLabels || DEFAULT_AGENT_LABELS),
    execute: truthy(env.CLAUDE_RUNNER_CRON_EXECUTE),
    allowRoot: truthy(env.CLAUDE_RUNNER_CRON_ALLOW_ROOT),
    includeInProgress: !truthy(env.CLAUDE_RUNNER_CRON_DISABLE_CONTINUE),
    claimOnExecute: !truthy(env.CLAUDE_RUNNER_CRON_DISABLE_CLAIM),
    quotaPreflight: !truthy(env.CLAUDE_RUNNER_CRON_SKIP_QUOTA_PREFLIGHT),
    // New claims always require one canonical immutable ChatGPT manager packet.
    // There is intentionally no emergency skip, proceed-command mode, or local
    // packet-generation toggle in the live scheduler contract.
    requireManagerPreflight: true,
    // #698 round 5, finding 4: native_resume/same_agent_continuation fail
    // closed for this release regardless of installed CLI capability. This
    // is deliberately an env-only, machine-local opt-in (never a repo-
    // tracked config value) — a supervised positive test on a specific
    // machine, after the CLI is upgraded, is what would justify setting it
    // there; it must not spread by being committed or copied between
    // machines.
    nativeResumeEnabled: truthy(env.CLAUDE_RUNNER_ENABLE_NATIVE_RESUME),
    // Issue #50 review round 3: the multi-agent selector's engagement is a
    // single explicit, env-only, machine-local enable gate -- never inferred
    // from whether a settings file happens to exist. Default false
    // preserves the legacy Claude execution path (and performs zero
    // multi-agent reconciliation) on every deployment that has not
    // explicitly opted in, regardless of whether a settings document is
    // present, missing, unreadable, or malformed. This flag is only a
    // code/test boundary in this PR -- the execution timer stays disabled
    // and this does not enable live routing to any adapter by itself.
    multiAgentRoutingEnabled: truthy(env.AGENT_RUNNER_ENABLE_MULTIAGENT_ROUTING),
    limit: Number.parseInt(env.CLAUDE_RUNNER_CRON_LIMIT || String(config.runner?.candidateLimit || DEFAULT_LIMIT), 10),
    watchdogIntervalMs: Number.parseInt(env.CLAUDE_RUNNER_WATCHDOG_INTERVAL_MS || String(config.runner?.watchdogIntervalMs || DEFAULT_WATCHDOG_INTERVAL_MS), 10),
    stalledPassLimit: Number.parseInt(env.CLAUDE_RUNNER_STALLED_PASS_LIMIT || String(config.runner?.stalledPassLimit || DEFAULT_STALLED_PASS_LIMIT), 10),
    project: {
      id: config.projectId,
      displayName: config.displayName,
      repo: config.githubRepo,
      localRepoPath: config.localRepoPath,
    },
  };
  let explicitStateDbPath = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === '--execute') args.execute = true;
    else if (arg === '--dry-run') args.execute = false;
    else if (arg === '--allow-root') args.allowRoot = true;
    else if (arg === '--no-continue') args.includeInProgress = false;
    else if (arg === '--no-claim') args.claimOnExecute = false;
    else if (arg === '--skip-quota-preflight') args.quotaPreflight = false;
    else if (arg === '--repo') args.repo = next();
    else if (arg === '--lock-path') args.lockPath = next();
    else if (arg === '--output-dir') {
      args.outputDir = next();
      if (!env.CLAUDE_RUNNER_STATE_DB && !explicitStateDbPath) {
        args.stateDbPath = defaultRunnerStateDbPath(args.outputDir);
      }
    }
    else if (arg === '--state-db') {
      args.stateDbPath = next();
      explicitStateDbPath = true;
    }
    else if (arg === '--limit') args.limit = Number.parseInt(next(), 10);
    else if (arg === '--agent-label') args.agentLabels = parseAgentLabels([...args.agentLabels, next()]);
    else if (arg === '--agent-labels') args.agentLabels = parseAgentLabels(next());
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200) throw new Error('--limit must be 1..200');
  if (!Number.isInteger(args.watchdogIntervalMs) || args.watchdogIntervalMs < 1_000) throw new Error('watchdog interval must be at least 1000ms');
  if (!Number.isInteger(args.stalledPassLimit) || args.stalledPassLimit < 2 || args.stalledPassLimit > 20) throw new Error('stalled pass limit must be 2..20');
  if (args.agentLabels.length === 0) throw new Error('at least one agent label is required');
  return args;
}

export function printHelp() {
  console.log(`Agent Runner scheduled wrapper

Usage:
  node scripts/ops/claude-runner-cron.mjs [--execute]

Default: dry-run. New claims require exactly one current canonical ChatGPT manager packet with marker ${'<!-- agent-runner:manager-preflight -->'}, schema version, immutable revision, sha256 fingerprint, permitted producer type, approved agent and execution phase. Historical proceed/continue comments remain read-only evidence and never authorise a new claim. Missing, malformed, revoked or already-claimed manager authority is skipped without a child launch, attempt creation or GitHub mutation.

Eligible labels:
  status:ready or status:in-progress
  agent:claude or agent:claude-code-cli

Options:
  --config <path>          Agent Runner project config JSON (or AGENT_RUNNER_CONFIG).
  --agent-label <label>    Add one accepted agent label.
  --agent-labels <labels>  Replace accepted agent labels with a comma-separated list.
  --limit <n>              Candidate scan limit, default ${DEFAULT_LIMIT}, max 200.
  --state-db <path>        SQLite state DB path.
  --no-continue            Do not scan in-progress issues.
  --no-claim               Do not mutate labels or post a runner-start marker.
  --skip-quota-preflight   Skip the Claude quota check. Not recommended.
`);
}

export function rootBlocked(uid = process.getuid?.(), allowRoot = false) {
  return uid === 0 && !allowRoot;
}

/**
 * Parse the child claude-runner.mjs stdout (its final console.log JSON
 * payload) so the cron wrapper can confirm a real per-run log was written,
 * not just trust a clean exit code.
 */
export function parseChildRunnerOutput(stdout) {
  try {
    const parsed = JSON.parse(stdout || '');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The child-runner contract: in --execute mode, a clean exit code is only
 * trustworthy if the child also reported the per-run log it wrote and did
 * not flag its own execution as a no-op or a plan-only run (see #660 —
 * `claude-runner.mjs` normally signals plan-only via a non-zero exit code
 * already, but this stays defensive in case a clean exit ever carries the
 * flag). Anything else — unparseable output, a missing logPath, an explicit
 * executionNoop flag, or an awaitingPlanApproval flag — means the child
 * never completed real implementation work, so treat it as a failure even
 * though the process exit code was 0.
 */
export function evaluateChildRunResult({ execute, exitCode, childPayload }) {
  if (!execute) return { failed: false, reason: null };
  if (exitCode !== 0) {
    const reason = childPayload?.awaitingPlanApproval
      ? 'awaiting-plan-approval'
      : childPayload?.failureReason || childPayload?.outcomeReason || `child-exit-${exitCode ?? 'unknown'}`;
    return { failed: true, reason };
  }
  if (!childPayload) return { failed: true, reason: 'child-output-unparseable' };
  if (!childPayload.logPath) return { failed: true, reason: 'child-produced-no-run-log' };
  if (childPayload.blocked) return { failed: true, reason: childPayload.reason || 'child-policy-blocked' };
  if (childPayload.failureReason) return { failed: true, reason: childPayload.failureReason };
  if (childPayload.executionNoop) return { failed: true, reason: childPayload.executionNoopReason || 'child-execution-noop' };
  if (childPayload.awaitingPlanApproval) return { failed: true, reason: 'awaiting-plan-approval' };
  return { failed: false, reason: null };
}

export function runnerArgs(issueNumber, args, { attemptId, recoveryMode, resumeSessionId, model, agentId = CLAUDE_AGENT_ID } = {}) {
  const out = [agentId === OLLAMA_AGENT_ID ? OLLAMA_RUNNER_ENTRYPOINT : CLAUDE_RUNNER_ENTRYPOINT];
  if (args.configPath) out.push('--config', args.configPath);
  out.push('--issue', String(issueNumber), '--output-dir', args.outputDir);
  if (args.execute) out.push('--execute');
  // attemptId lets the child write its restricted recovery handle (session
  // id, worktree/branch identity) under the same attempt row the scheduler
  // already owns, so a later native_resume/same_agent_continuation for this
  // exact attempt can read it back. recoveryMode/resumeSessionId are only
  // ever set by the adapter-built invocations in dispatchRecoveryAction's
  // callers below, never derived from issue/comment text.
  if (attemptId) out.push('--attempt-id', String(attemptId));
  if (recoveryMode) out.push('--recovery-mode', recoveryMode);
  if (resumeSessionId) out.push('--resume-session', String(resumeSessionId));
  // `model` (#148) is the scheduler's own once-resolved canonical model for
  // a fresh implementation dispatch, passed explicitly so the child's own
  // independent `resolveProfile()` call uses this exact value (it takes
  // priority over the child's own `executionMeta.model`) instead of
  // possibly re-deriving a different one from a mutable local environment.
  // Never set for a recovery re-invocation or a non-implementation dispatch.
  if (model) out.push('--model', String(model));
  return out;
}

const OLLAMA_FORBIDDEN_TASK_CLASSES = new Set([
  'security', 'auth', 'authentication', 'authorization', 'billing',
  'database-migration', 'migration', 'deployment', 'deploy',
  'architecture', 'broad-architecture',
]);

export async function preclaimOllamaAdmission({
  agentId,
  issue,
  managerComment,
  managerModel,
  repo,
  env = process.env,
  execFileFn = execFileSync,
  fetchFn = fetch,
} = {}) {
  if (agentId !== OLLAMA_AGENT_ID) return { allowed: true, reason: null, model: null };
  if (managerModel !== QUALIFIED_OLLAMA_CODING_MODEL) {
    return { allowed: false, reason: 'ollama-manager-model-mismatch', model: null };
  }

  const contract = resolveBoundedOllamaManagerContract(managerComment);
  if (!contract.ok) return { allowed: false, reason: contract.reason, model: null };

  const settings = getAgentSettings({ env, agentId: OLLAMA_AGENT_ID });
  if (!settings.routable) return { allowed: false, reason: settings.reason || 'ollama-agent-not-routable', model: null };
  if (!isShellTrustedRepository(repo, settings.entry?.shellTrustedRepositories)) {
    return { allowed: false, reason: 'ollama-shell-repository-not-trusted', model: null };
  }

  const classification = classifyIssueTaskRisk(issue);
  if (classification.conflicts?.length) return { allowed: false, reason: 'ollama-issue-classification-conflict', model: null };
  if (OLLAMA_FORBIDDEN_TASK_CLASSES.has(classification.taskClass)) {
    return { allowed: false, reason: 'ollama-task-class-forbidden', model: null };
  }

  for (const command of contract.validationCommands) {
    const decision = classifyBoundedOllamaShellCommand(command, {
      repository: repo,
      trustedRepositories: settings.entry?.shellTrustedRepositories,
      managerValidationCommands: contract.validationCommands,
      machineCommandAllowlist: settings.entry?.commandAllowlist,
    });
    if (!decision.allowed) return { allowed: false, reason: decision.reason || 'ollama-shell-command-denied', model: null };
  }

  const admission = await admitOllamaDispatch({
    env,
    model: QUALIFIED_OLLAMA_CODING_MODEL,
    settings,
    execFileFn: (file, commandArgs) => execFileFn(file, commandArgs, {
      encoding: 'utf8',
      timeout: 5000,
      env,
    }),
    fetchFn,
    requiredExecutableVersion: QUALIFIED_OPENCODE_VERSION,
    requiredOllamaVersion: QUALIFIED_OLLAMA_VERSION,
  });
  if (!admission.allowed) {
    return { allowed: false, reason: admission.reason || 'ollama-admission-refused', model: null };
  }

  return {
    allowed: true,
    reason: null,
    model: QUALIFIED_OLLAMA_CODING_MODEL,
    targetFile: contract.filePath,
    shellCommandCount: contract.validationCommands.length,
  };
}

export function quotaPreflightArgs(args) {
  const out = [CLAUDE_RUNNER_ENTRYPOINT];
  if (args.configPath) out.push('--config', args.configPath);
  out.push('--check-quota', '--force-quota-check', '--output-dir', args.outputDir);
  return out;
}

function gh(jsonArgs) {
  return execFileSync('gh', jsonArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function preferIssue(left, right) {
  if (!left) return right;
  return compareIssues(left, right) <= 0 ? left : right;
}

export function mergeIssuesByNumber(groups) {
  const byNumber = new Map();
  for (const group of groups) {
    for (const issue of group) {
      byNumber.set(issue.number, preferIssue(byNumber.get(issue.number), issue));
    }
  }
  return [...byNumber.values()].sort(compareIssues);
}

/**
 * Build the `gh issue list` args used to find candidate issues for one
 * status/agent label pair. Selection is driven entirely by the current
 * `status:` and `agent:` labels — it does not require (or filter on) the
 * retired `devplan` label.
 */
export function buildIssueListArgs(repo, limit, statusLabel, agentLabel) {
  return ['issue', 'list', '--repo', repo, '--state', 'open', '--label', statusLabel, '--label', agentLabel, '--limit', String(limit), '--json', 'number,title,body,url,updatedAt,labels'];
}

function listIssuesForStatusAndAgentLabel(repo, limit, statusLabel, agentLabel, ghRunner = gh) {
  const raw = ghRunner(buildIssueListArgs(repo, limit, statusLabel, agentLabel));
  // The queried `status:` label stays the authoritative transport for claim
  // logic (`claimIssueForExecution` still flips labels), but the adapter
  // attaches canonical metadata + conflict diagnostics for ranking/reporting.
  return JSON.parse(raw || '[]').map((issue) => ({
    ...decorateIssueWithMetadata(issue, { statusFallbackLabel: statusLabel }),
    statusLabel,
    agentLabel,
  }));
}

export function listCandidateIssues(repo, limit, agentLabels, includeInProgress = true, ghRunner = gh) {
  const statusLabels = includeInProgress ? [STATUS_READY, STATUS_IN_PROGRESS] : [STATUS_READY];
  const groups = [];
  for (const statusLabel of statusLabels) {
    for (const agentLabel of agentLabels) groups.push(listIssuesForStatusAndAgentLabel(repo, limit, statusLabel, agentLabel, ghRunner));
  }
  return mergeIssuesByNumber(groups).slice(0, limit);
}

function readIssueComments(repo, issueNumber, ghRunner = gh) {
  const raw = ghRunner(['issue', 'view', String(issueNumber), '--repo', repo, '--comments', '--json', 'comments']);
  return JSON.parse(raw || '{}').comments || [];
}

export function listOpenPullRequests(repo, ghRunner = gh) {
  const raw = ghRunner(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,title,body,url,headRefName']);
  return JSON.parse(raw || '[]').map((pr) => ({ ...pr, state: 'open' }));
}

// `gh pr list --limit N` paginates internally up to N results, so a fixed
// `--limit 200` silently truncates a repository with more than 200 total
// pull requests: a historical branch beyond the first page would read as
// "no matching PR", which a remote-publication guard could then misread as
// "unpublished" (#148). This starts at `PR_LIST_INITIAL_LIMIT` and, whenever
// a response returns *exactly* that many results (ambiguous: could be the
// true total, could be truncated), doubles the limit and re-fetches from
// scratch, until a response returns fewer results than requested -- proof
// `gh` itself has exhausted every page. `PR_LIST_MAX_LIMIT` bounds the loop
// so a pathological/unbounded repository can never spin forever; hitting it
// without ever seeing a non-full page fails closed (throws) rather than
// silently returning a partial list.
const PR_LIST_INITIAL_LIMIT = 200;
const PR_LIST_MAX_LIMIT = 51200;

function validatedPullRequestRecord(entry) {
  return entry
    && typeof entry === 'object'
    && typeof entry.number === 'number'
    && typeof entry.headRefName === 'string' && entry.headRefName.length > 0
    && typeof entry.state === 'string' && entry.state.length > 0;
}

/**
 * Every pull request for `repo` regardless of state (open, closed or
 * merged) -- unlike `listOpenPullRequests()` above, which is only safe to
 * use where "still open" is genuinely the only state that matters.
 * Historical recovery-model reconciliation (#148) must detect any prior
 * publication of an approved branch, not only a still-open one: a merged or
 * closed PR is just as conclusive evidence that a checkpoint was already
 * published as an open one is. Callers that treat "unpublished" as a repair
 * precondition must fail closed on a thrown/malformed/empty read here, and
 * on any individual malformed record, never silently treat it as "no PR
 * exists".
 */
export function listAllPullRequests(repo, ghRunner = gh) {
  for (let limit = PR_LIST_INITIAL_LIMIT; limit <= PR_LIST_MAX_LIMIT; limit *= 2) {
    const raw = ghRunner(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', String(limit), '--json', 'number,title,body,url,headRefName,state']);
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error('gh pr list --state all returned empty output');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('gh pr list --state all returned malformed JSON');
    }
    if (!Array.isArray(parsed)) throw new Error('gh pr list --state all returned a non-array result');
    for (const entry of parsed) {
      if (!validatedPullRequestRecord(entry)) throw new Error('gh pr list --state all returned a malformed PR record');
    }
    if (parsed.length < limit) return parsed;
  }
  throw new Error('gh pr list --state all did not converge within the bounded pagination ceiling');
}

function recoveryCommentTime(comment) {
  return comment?.createdAt || comment?.created_at || null;
}

export function parseManagerRecoveryAuthorization(comment) {
  const body = String(comment?.body || '');
  if (!/^## Manager recovery authorization\s*$/im.test(body)) return null;
  const fields = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*([^:]+):\s*(.*?)\s*$/);
    if (match) fields[match[1].trim().toLowerCase().replaceAll(' ', '_')] = match[2].trim().replace(/^`|`$/g, '');
  }
  if (!fields.attempt || !fields.action || !fields.claim_revision || !fields.preflight_revision) return null;
  const claimIdentity = normalizeCommentIdentity(fields.claim_revision);
  const preflightIdentity = normalizeCommentIdentity(fields.preflight_revision);
  if (!claimIdentity || !preflightIdentity) return null;
  return {
    identity: normalizeCommentIdentity(comment),
    id: commentRevision(comment),
    createdAt: recoveryCommentTime(comment),
    attemptId: fields.attempt,
    action: fields.action,
    claimRevision: fields.claim_revision,
    preflightRevision: fields.preflight_revision,
    claimIdentity,
    preflightIdentity,
    agent: fields.agent || null,
    model: fields.model || null,
    harness: fields.harness || null,
    policyApproved: /^(?:yes|true|approved)$/i.test(fields.policy_approved || ''),
    comment,
  };
}

export function latestManagerRecoveryAuthorization(comments = []) {
  return comments.map(parseManagerRecoveryAuthorization).filter(Boolean)
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0] || null;
}

function issueLabels(issue) {
  return (issue?.labels || []).map((label) => String(label?.name || label || '').trim()).filter(Boolean);
}

export function readRecoveryIssue(repo, issueNumber, ghRunner = gh) {
  const issue = JSON.parse(ghRunner(['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'number,state,title,body,url,updatedAt,labels,comments']) || '{}');
  const labels = issueLabels(issue);
  return {
    ...issue,
    labels,
    comments: issue.comments || [],
    statusLabel: labels.filter((label) => label.startsWith('status:'))[0] || null,
    agentLabel: labels.filter((label) => label.startsWith('agent:'))[0] || null,
  };
}

/**
 * `ownArtifact` (only ever supplied for `native_resume`/
 * `same_agent_continuation`, and only from the attempt's own verified
 * restricted handle — never from GitHub or issue-number text) is the exact
 * branch/worktree this attempt itself preserved for resumption. It is
 * excluded from the conflict scan; every *other* branch or worktree
 * referencing this issue number — including a stray leftover from a
 * different or previous attempt — still counts as a conflict. `fresh_retry`
 * and `retry_after_quota_preflight` never pass an `ownArtifact`, so any
 * matching branch/worktree, including this attempt's own preserved one,
 * remains a conflict for those actions unless a future policy field
 * explicitly permits reuse (#698 finding 1).
 */
export function localRecoveryConflicts(issueNumber, cwd, ownArtifact = null) {
  if (!cwd) return { noConflictingBranch: false, noConflictingWorktree: false };
  try {
    const token = new RegExp(`(?:^|[^0-9])${Number(issueNumber)}(?:[^0-9]|$)`);
    const branches = String(execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
      .split(/\r?\n/).filter(Boolean);
    const worktrees = String(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
      .split(/\n\s*\n/).filter(Boolean);
    const isOwnBranch = (branch) => Boolean(ownArtifact?.branch) && branch.trim() === ownArtifact.branch;
    const isOwnWorktree = (entry) => Boolean(ownArtifact?.worktreePath)
      && entry.split(/\r?\n/).some((line) => line.trim() === `worktree ${ownArtifact.worktreePath}`);
    return {
      noConflictingBranch: !branches.some((branch) => token.test(branch) && !isOwnBranch(branch)),
      noConflictingWorktree: !worktrees.some((entry) => token.test(entry) && !isOwnWorktree(entry)),
    };
  } catch {
    return { noConflictingBranch: false, noConflictingWorktree: false };
  }
}

function sameAgent(left, right) {
  const normalize = (value) => ['claude', 'claude-code-cli'].includes(String(value || '')) ? 'claude-code-cli' : String(value || '');
  return Boolean(left && right) && normalize(left) === normalize(right);
}

export async function collectRecoveryRevalidation({
  stage,
  action,
  attempt,
  args,
  ghRunner = gh,
  state,
  processProbe = probeProcessIdentity,
  currentProcessIdentity,
  repositoryEvidence,
  checkedAt = new Date().toISOString(),
  restrictedHandleReader = readRestrictedRecoveryHandle,
  cliCapabilityProbe = detectClaudeResumeCliCapability,
  worktreeVerifier = verifyPreservedWorktree,
} = {}) {
  const issue = readRecoveryIssue(args.repo, attempt.issue_number, ghRunner);
  const comments = issue.comments || [];
  const authorization = latestManagerRecoveryAuthorization(comments);
  const originalAction = action || attempt.claimed_recovery_action || attempt.recovery_action;
  const claimIdentity = deserializeCommentIdentity(attempt.claim_identity_json || attempt.claim_id, 'recovery-claim');
  const preflightIdentity = deserializeCommentIdentity(attempt.preflight_identity_json || attempt.preflight_revision, 'recovery-preflight');
  const claimRevision = commentRevision(claimIdentity);
  const preflightRevision = commentRevision(preflightIdentity);
  const expectedAuthorizationIdentity = deserializeCommentIdentity(
    attempt.recovery_authorization_identity_json || attempt.recovery_authorization_id,
    'recovery-authorization',
  );
  const expectedAuthorizationId = commentRevision(expectedAuthorizationIdentity);
  const authMatches = Boolean(authorization?.id
    && authorization.attemptId === String(attempt.attempt_id)
    && authorization.action === originalAction
    && sameCommentIdentity(authorization.claimIdentity, claimIdentity)
    && sameCommentIdentity(authorization.preflightIdentity, preflightIdentity)
    && sameAgent(authorization.agent, attempt.agent)
    && authorization.model === attempt.model
    && authorization.harness === attempt.harness);
  const terminalAt = Date.parse(attempt.finished_at || '');
  const authorizationAt = Date.parse(authorization?.createdAt || '');
  const authorizationFresh = stage === 'pre_claim'
    ? authMatches && Number.isFinite(terminalAt) && Number.isFinite(authorizationAt) && authorizationAt > terminalAt
    : authMatches && expectedAuthorizationId !== null && sameCommentIdentity(authorization.identity, expectedAuthorizationIdentity);
  const statusLabels = issueLabels(issue).filter((label) => label.startsWith('status:'));
  const agentLabels = issueLabels(issue).filter((label) => label.startsWith('agent:'));
  const issueAgent = resolveAgentForLabels(agentLabels);
  const linkedPrs = findLinkedOpenPullRequests({ issueNumber: issue.number, pullRequests: listOpenPullRequests(args.repo, ghRunner) });
  const handoffPresent = comments.some((comment) => /^## (?:Manager|Agent) handoff\s*$/im.test(String(comment?.body || '')));
  // Read the restricted handle before scanning for local conflicts (not
  // after, as before) so its exact preserved worktree/branch identity can be
  // excluded from the conflict scan for native_resume/same_agent_continuation
  // only — never for fresh_retry/retry_after_quota_preflight, which must
  // still forbid any preserved mutation artifact (#698 finding 1).
  let restrictedHandle = null;
  let restrictedHandlePermissionSafe = true;
  if (originalAction === 'native_resume' || originalAction === 'same_agent_continuation') {
    const read = restrictedHandleReader(args.outputDir, attempt.attempt_id);
    restrictedHandle = read.handle;
    restrictedHandlePermissionSafe = read.permissionSafe;
  }
  const ownHandleVerified = restrictedHandle && restrictedHandlePermissionSafe
    && restrictedHandle.attemptId === String(attempt.attempt_id)
    && Boolean(restrictedHandle.worktreeName) && Boolean(restrictedHandle.expectedBranch);
  const ownArtifact = ownHandleVerified && args.project?.localRepoPath
    ? { branch: restrictedHandle.expectedBranch, worktreePath: joinPath(args.project.localRepoPath, '.claude', 'worktrees', restrictedHandle.worktreeName) }
    : null;
  const local = repositoryEvidence || localRecoveryConflicts(issue.number, args.project?.localRepoPath, ownArtifact);
  const activeRows = state.invoke('activeRecoveryAttempts', args.repo) || [];
  const otherLease = activeRows.some((row) => row.attempt_id !== attempt.attempt_id && row.issue_number === attempt.issue_number);
  let processCurrent = false;
  try {
    const identity = {
      processId: attempt.process_id,
      processBootId: attempt.process_boot_id,
      processStartTicks: attempt.process_start_ticks,
      systemdInvocationId: attempt.systemd_invocation_id,
    };
    const live = await processProbe(identity);
    const stableIdentityPresent = Boolean(identity.processId && identity.processBootId && identity.processStartTicks);
    // pre_claim and transition_reconcile both check a *prior* attempt's
    // recorded process identity for absence of a still-live conflicting
    // process; only pre_launch/pre_transition check identity against the
    // *current* live process (this one).
    processCurrent = (stage === 'pre_claim' || stage === 'transition_reconcile')
      ? stableIdentityPresent && live === false
      : stableIdentityPresent && live === true && currentProcessIdentity?.processId === identity.processId
        && currentProcessIdentity?.processBootId === identity.processBootId
        && String(currentProcessIdentity?.processStartTicks || '') === String(identity.processStartTicks || '');
  } catch {
    processCurrent = false;
  }
  // Restricted resume/continuation evidence (#698 finding 2) — the handle
  // was already read above (before the conflict scan) so its own identity
  // could be excluded there; only the derived booleans below leave this
  // function, so a restricted reference can never reach the persisted
  // revalidation row.
  const preservedWorktree = restrictedHandle && restrictedHandlePermissionSafe
    ? worktreeVerifier({ handle: restrictedHandle, repoRoot: args.project?.localRepoPath })
    : { preservedWorktreeCurrent: false, checkpointCurrent: false };
  const resumeCliCapability = originalAction === 'native_resume'
    ? cliCapabilityProbe({ claudeBin: args.claudeBin || process.env.CLAUDE_BIN || 'claude' })
    : null;

  const immutableManagerAuthorityCurrent = attempt.manager_authority_key
    ? managerAuthorityKeyIsCurrent(comments, attempt.manager_authority_key, attempt.manager_preflight_body_digest)
    : null;
  const evidence = {
    issueOpen: String(issue.state || '').toUpperCase() === 'OPEN',
    expectedStatusCurrent: statusLabels.length === 1 && statusLabels[0] === STATUS_BLOCKED,
    agentOwnershipCurrent: agentLabels.length === 1 && sameAgent(issueAgent?.agentId, attempt.agent),
    claimRevisionCurrent: immutableManagerAuthorityCurrent ?? (Boolean(claimIdentity)
      && comments.some((comment) => sameCommentIdentity(comment, claimIdentity))),
    preflightRevisionCurrent: immutableManagerAuthorityCurrent ?? (Boolean(preflightIdentity)
      && sameCommentIdentity(latestManagerPreflightComment(comments), preflightIdentity)),
    authorizationFresh,
    authorizationCurrent: authMatches && (expectedAuthorizationIdentity === null
      || sameCommentIdentity(authorization.identity, expectedAuthorizationIdentity)),
    noConflictingPr: linkedPrs.length === 0,
    noConflictingBranch: local.noConflictingBranch === true,
    noConflictingWorktree: local.noConflictingWorktree === true,
    noHandoff: !handoffPresent,
    noConflictingProcess: processCurrent,
    noConflictingLease: !otherLease && ((stage === 'pre_claim' || stage === 'transition_reconcile')
      || (Boolean(attempt.recovery_lease_id) && attempt.recovery_lease_id === currentProcessIdentity?.recoveryLeaseId)),
    agentCompatible: issueAgent?.implemented === true && sameAgent(issueAgent.agentId, attempt.agent),
    modelCompatible: Boolean(attempt.model) && authorization?.model === attempt.model && issueAgent?.controls?.model?.supported === true,
    harnessCompatible: Boolean(attempt.harness) && authorization?.harness === attempt.harness && issueAgent?.type === attempt.harness,
    sameRecoveryClaim: stage !== 'pre_transition' || (Boolean(attempt.recovery_lease_id) && attempt.recovery_lease_id === currentProcessIdentity?.recoveryLeaseId),
    sameRecoveryAgent: stage !== 'pre_transition' || sameAgent(issueAgent?.agentId, attempt.agent),
    noNewerManagerAction: stage !== 'pre_transition'
      || sameCommentIdentity(authorization?.identity, expectedAuthorizationIdentity),
    knownQuotaResetReached: originalAction !== 'retry_after_quota_preflight'
      || (Boolean(attempt.retry_at) && Date.parse(checkedAt) >= Date.parse(attempt.retry_at)),
    freshQuotaPreflightPassed: originalAction !== 'retry_after_quota_preflight'
      || (args.currentQuotaPreflight?.blocked === false && args.currentQuotaPreflight?.skipped === false),
    restrictedResumeHandleAvailable: originalAction === 'native_resume' && restrictedHandlePermissionSafe
      && Boolean(restrictedHandle?.sessionId) && restrictedHandle?.attemptId === String(attempt.attempt_id),
    resumeCliSupportVerified: originalAction === 'native_resume' && resumeCliCapability?.supported === true,
    preservedWorktreeCurrent: (originalAction === 'native_resume' || originalAction === 'same_agent_continuation')
      && restrictedHandlePermissionSafe && preservedWorktree.preservedWorktreeCurrent === true,
    checkpointCurrent: (originalAction === 'native_resume' || originalAction === 'same_agent_continuation')
      && restrictedHandlePermissionSafe && preservedWorktree.checkpointCurrent === true,
    // Independently recomputes the write-once binding digest from the
    // *persisted attempt row's* identity (agent/model/harness) plus the
    // freshly re-read handle's checkpoint fields, and compares it to the
    // digest persisted at capture time. A missing persisted digest, a
    // missing handle, or any mismatch fails closed — this is what actually
    // proves the restricted handle still belongs to this exact attempt,
    // not merely that a same-attemptId handle file exists on disk (#698
    // finding 8).
    restrictedHandleBindingVerified: (originalAction === 'native_resume' || originalAction === 'same_agent_continuation')
      && restrictedHandlePermissionSafe && Boolean(restrictedHandle) && Boolean(attempt.restricted_handle_digest)
      && restrictedHandleBindingDigest({
        attemptId: attempt.attempt_id, agent: attempt.agent, model: attempt.model, harness: attempt.harness,
        checkpointHead: restrictedHandle?.checkpointHead, checkpointStatusFingerprint: restrictedHandle?.checkpointStatusFingerprint,
      }) === attempt.restricted_handle_digest,
    explicitContinuationPolicyApproval: authorization?.policyApproved === true,
  };
  const decision = evaluateRecoveryRevalidation({ stage, action: originalAction, evidence, checkedAt });
  return {
    ...decision,
    evidence,
    issue,
    authorizationId: authorization?.id || null,
    authorizationIdentity: authorization?.identity || null,
    authorization,
    linkedPrs,
  };
}

function acquireLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx');
  writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
  return () => {
    try { closeSync(fd); } catch { /* ignore */ }
    try { rmSync(path); } catch { /* ignore */ }
  };
}

function writeLog(outputDir, payload) {
  mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `${outputDir}/cron-${stamp}.json`;
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

export function createStateRecorder(args, openStore = openRunnerStateStore) {
  const errors = [];
  // Task-local faults (a single issue's GitHub comment/label delivery
  // failing, one attempt's watchdog reconcile pass hitting an unexpected
  // exception) must never flip `healthy` false and trigger a systemic pause
  // of the whole queue — only genuine store-integrity failures (open,
  // migrate, read/write, atomic claim) belong in `errors` (#698 finding 5).
  // `taskErrors` is a parallel, unbounded-cause diagnostic channel that
  // never gates `healthy` or `emitSystemicStatePause`.
  const taskErrors = [];
  let store = null;
  try {
    // withRecoveryIdentityGuard (#148) must wrap the innermost store -- the
    // instance that owns the SQLite connection -- so its guarded BEGIN
    // IMMEDIATE transaction around recordRecoveryAttempt() is the actual
    // write that lands, and withWorkspaceIdentitySupport wraps that
    // already-guarded store, not the other way around. When `openStore`
    // itself composes delegating layers over the real store (the production
    // `agent-runner-atomic-cron.mjs` liveness/admission proxies), that
    // module attaches the guard to the concrete store before wrapping it,
    // and the guard call here reads its marker through those layers and
    // returns the store unchanged -- exactly one layer ever owns the
    // recovery-attempt transaction (#158).
    store = withWorkspaceIdentitySupport(withRecoveryIdentityGuard(openStore(args.stateDbPath || defaultRunnerStateDbPath(args.outputDir))));
  } catch (error) {
    errors.push({ stage: 'open', message: String(error?.message || error) });
  }

  return {
    errors,
    taskErrors,
    recordTaskError(stage, error) {
      taskErrors.push({ stage: String(stage || 'unknown'), message: String(error?.message || error) });
    },
    get available() { return Boolean(store); },
    get healthy() { return Boolean(store) && errors.length === 0; },
    record(method, payload) {
      if (!store) return false;
      try {
        store[method](payload);
        return true;
      } catch (error) {
        errors.push({ stage: method, message: String(error?.message || error) });
        return false;
      }
    },
    invoke(method, ...values) {
      if (!store) return null;
      try { return store[method](...values); } catch (error) {
        errors.push({ stage: method, message: String(error?.message || error) });
        return null;
      }
    },
    ensureWritable(stage = 'write-probe') {
      if (!store) return false;
      try {
        store.assertWritable();
        return true;
      } catch (error) {
        errors.push({ stage, message: String(error?.message || error) });
        return false;
      }
    },
    close() {
      if (!store) return;
      try {
        store.close();
      } catch (error) {
        errors.push({ stage: 'close', message: String(error?.message || error) });
      }
    },
  };
}

function boundedStateErrors(errors = []) {
  return errors.slice(0, 5).map((error) => ({
    stage: String(error?.stage || 'unknown').slice(0, 80),
    message: String(error?.message || 'runner state failure').slice(0, 300),
  }));
}

export function emitSystemicStatePause(args, state, stage, { now = () => new Date().toISOString(), logger = console } = {}) {
  const detectedAt = now();
  const payload = {
    dryRun: !args.execute,
    systemicPause: true,
    reason: 'runner_state_unavailable',
    stage,
    detectedAt,
    selectedIssue: null,
    safeNextAction: 'Repair and verify the SQLite runner state store before dispatching or mutating any issue.',
    restrictedStateErrors: boundedStateErrors(state.errors),
  };
  if (state.available) {
    state.record('recordQueueEvent', {
      repo: args.repo,
      eventType: 'systemic-pause',
      reason: payload.reason,
      payload: { reason: payload.reason, stage, detectedAt, safeNextAction: payload.safeNextAction },
    });
    // #698 round 5, finding 3: the current, resolvable health condition —
    // `queue_events` above remains the historical audit record, but the
    // operator-facing "are we paused right now" truth comes from this
    // table, resolved explicitly once a pass proves the store healthy
    // again (see `main()`), not inferred from a latest-N event window that
    // could keep showing a cleared pause indefinitely.
    state.record('openHealthCondition', {
      repo: args.repo, conditionType: 'systemic_pause', reason: payload.reason,
      safeNextAction: payload.safeNextAction, payload: { stage, detectedAt }, at: detectedAt,
    });
  }
  let logPath = null;
  try { logPath = writeLog(args.outputDir, payload); } catch { /* stderr remains the last safe diagnostic channel */ }
  logger.error(JSON.stringify({ ...payload, restrictedStateErrors: '<restricted local log>', logPath }, null, 2));
  return { exitCode: 1, payload, logPath };
}

function recordSelectionState(state, args, plan) {
  let persisted = state.record('recordIssueSelection', {
    repo: args.repo,
    issueNumber: plan.selectedIssue,
    statusLabel: plan.selectedStatusLabel,
    selectionMode: plan.selectionMode,
    commandKind: plan.selectedCommandKind,
    sourceCommentId: plan.sourceCommentId,
    sourcePreflightCommentId: plan.sourcePreflightCommentId,
    sourceCommentIdentity: plan.sourceCommentIdentity,
    sourcePreflightCommentIdentity: plan.sourcePreflightCommentIdentity,
    dryRun: plan.dryRun,
    payload: plan,
  });

  for (const skip of plan.skipped || []) {
    persisted = state.record('recordQueueEvent', {
      repo: args.repo,
      eventType: 'skip',
      issueNumber: skip.issue,
      statusLabel: skip.statusLabel,
      reason: skip.reason,
      payload: skip,
    }) && persisted;
  }

  return persisted;
}

function persistRecoveryRevalidation(state, attempt, result, recoveryLeaseId = null) {
  return state.record('recordRecoveryRevalidation', {
    attemptId: attempt.attempt_id,
    stage: result.stage,
    checkedAt: result.checkedAt,
    action: result.action,
    allowed: result.allowed,
    authorizationId: result.authorizationId,
    authorizationIdentity: result.authorizationIdentity,
    recoveryLeaseId,
    evidence: { ...result.evidence, failedChecks: result.failedChecks },
  });
}

async function revalidateRecoverySafely(revalidator, input) {
  let raw;
  try {
    raw = await revalidator(input);
  } catch (error) {
    raw = { evidence: {}, authorizationId: null, issue: null, collectionError: String(error?.message || error) };
  }
  const checkedAt = raw?.checkedAt || input.checkedAt;
  const evaluated = evaluateRecoveryRevalidation({
    stage: input.stage,
    action: input.action,
    evidence: raw?.evidence || {},
    checkedAt,
  });
  return {
    ...raw,
    ...evaluated,
    evidence: evaluated.evidence,
    authorizationId: raw?.authorizationId || null,
    issue: raw?.issue || null,
  };
}

function blockRecoveryBeforeLaunch(state, args, attempt, result, now, ghRunner = gh) {
  const finishedAt = attempt.finished_at || now();
  const event = buildAttentionEvent({
    repository: args.repo,
    project: args.project?.id,
    issueNumber: attempt.issue_number,
    attemptId: attempt.attempt_id,
    reason: attempt.outcome || 'unknown_failure',
    agent: attempt.agent,
    startedAt: attempt.started_at,
    finishedAt,
    recoveryStatus: 'forbidden',
    nextAction: `Recovery ${result.stage || 'dispatch'} failed closed: ${(result.failedChecks || [result.reason || 'incomplete evidence']).join(', ')}. Obtain a fresh manager authorization after resolving the evidence.`,
  });
  const attemptPersisted = state.record('recordRecoveryAttempt', {
    attemptId: attempt.attempt_id,
    repo: attempt.repo,
    project: attempt.project,
    issueNumber: attempt.issue_number,
    claimId: attempt.claim_id,
    preflightRevision: attempt.preflight_revision,
    phase: 'recovery-revalidation-blocked',
    agent: attempt.agent,
    model: attempt.model,
    harness: attempt.harness,
    startedAt: attempt.started_at,
    finishedAt,
    outcome: attempt.outcome || 'unknown_failure',
    recoveryEligible: false,
    recoveryAction: 'attention_required',
    recoveryAttemptCount: attempt.recovery_attempt_count,
    retryAt: attempt.retry_at,
    attentionStatus: 'attention_required',
    attentionDedupeKey: event.dedupeKey,
    resolutionState: 'unresolved',
    processId: attempt.process_id,
    processBootId: attempt.process_boot_id,
    processStartTicks: attempt.process_start_ticks,
    systemdInvocationId: attempt.systemd_invocation_id,
    restrictedEvidence: { stage: result.stage || 'dispatch', failedChecks: result.failedChecks || [result.reason] },
  });
  const attention = state.invoke('upsertAttentionEvent', event);
  // Every blocked recovery stage (pre-claim, post-claim, dispatch, immediate
  // pre-launch) must publish/update the single sanitized GitHub attention
  // marker when the persisted state materially changed, not only local
  // SQLite state (#698 finding 3). A delivery failure here stays task-local:
  // it is recorded, but this function's blocking callers already return a
  // nonzero exit code regardless of whether the GitHub write succeeded.
  let attentionPublish = null;
  if (attention?.materiallyChanged) {
    try {
      attentionPublish = upsertGitHubAttentionComment(args, { number: attempt.issue_number }, event, ghRunner);
    } catch (error) {
      state.recordTaskError('recovery-block-attention-comment', error);
      attentionPublish = { error: String(error?.message || error) };
    }
  }
  return { persisted: attemptPersisted && Boolean(attention), event, attention, attentionPublish };
}

/**
 * Build the restricted `nativeResume`/`continuation` dispatch options for
 * `dispatchRecoveryAction()` from the verified adapter boundary (#698
 * finding 2). The restricted handle (session id, worktree/branch identity)
 * is read here and used only to build the invocation args array — it is
 * never assigned to anything returned from `main()`, logged, or persisted.
 * Exact evidence booleans come from the same revalidation the scheduler
 * already fail-closed-gates the recovery on, so a dispatch here can never
 * be more permissive than the revalidation stage that authorized it.
 */
function buildRestrictedRecoveryDispatch({ recoveryPreLaunch, issueNumber, attemptId, args, authEnv, dependencies = {} }) {
  const restrictedRead = (dependencies.readRestrictedRecoveryHandle || readRestrictedRecoveryHandle)(args.outputDir, attemptId);
  const handle = restrictedRead.permissionSafe ? restrictedRead.handle : null;
  const nativeResumeInvocation = handle?.sessionId
    ? { command: process.execPath, args: runnerArgs(issueNumber, args, { attemptId, recoveryMode: 'native_resume', resumeSessionId: handle.sessionId }), env: authEnv }
    : null;
  const continuationInvocation = handle
    ? { command: process.execPath, args: runnerArgs(issueNumber, args, { attemptId, recoveryMode: 'same_agent_continuation' }), env: authEnv }
    : null;
  // #698 round 5, finding 4: an explicit machine-local enablement gate,
  // independent of CLI capability — see `dispatchRecoveryAction()` in
  // claude-runner-recovery.mjs, the sole boundary that actually enforces it.
  const enablementGateOpen = args.nativeResumeEnabled === true;
  return {
    nativeResume: {
      restrictedHandle: restrictedRead.permissionSafe && Boolean(handle),
      checkpointCurrent: recoveryPreLaunch.evidence?.checkpointCurrent === true,
      cliSupportVerified: recoveryPreLaunch.evidence?.resumeCliSupportVerified === true,
      enablementGateOpen,
      invocation: nativeResumeInvocation,
    },
    continuation: {
      preservedWorktreeCurrent: recoveryPreLaunch.evidence?.preservedWorktreeCurrent === true,
      checkpointCurrent: recoveryPreLaunch.evidence?.checkpointCurrent === true,
      policyApproved: recoveryPreLaunch.evidence?.explicitContinuationPolicyApproval === true,
      enablementGateOpen,
      invocation: continuationInvocation,
    },
  };
}

/**
 * Runner-start claim marker. Records which dual-dispatch mode selected this
 * issue and the source comment it came from — a proceed/continue command
 * comment id in compatibility mode, or a manager preflight packet comment id
 * in Agent Runner v2 preflight-direct mode.
 */
export function runnerStartedCommentBody(selection, action, args) {
  const authority = selection.managerAuthority || null;
  return `${RUNNER_STARTED_HEADING}

- Runner action: ${action}
- Selection mode: preflight-direct
- Source preflight comment: ${commentRevision(selection.preflight) || 'unknown'}
- Manager packet revision: ${authority?.revision || 'unknown'}
- Manager packet fingerprint: ${authority?.fingerprint || 'unknown'}
- Manager packet authority: ${authority?.authorityKey || 'unknown'}
- Manager packet body digest: ${authority?.packetDigest || 'unknown'}
- Started at: ${new Date().toISOString()}
- Output directory: ${args.outputDir}

This marker records consumption of exactly this immutable manager packet revision and fingerprint. Editing comment prose without a new revision does not reauthorise work.`;
}

function postRunnerStartedComment(args, issue, selection, action, ghRunner = gh) {
  const body = runnerStartedCommentBody(selection, action, args);
  const output = ghRunner(['issue', 'comment', String(issue.number), '--repo', args.repo, '--body', body]);
  return normalizeCommentIdentity({ url: String(output || '').trim() });
}

export function claimIssueForExecution(args, issue, selection, ghRunner = gh) {
  if (selection?.mode !== 'preflight-direct' || !selection?.managerAuthority?.authorityKey) {
    throw new Error('manager-preflight-required-before-claim');
  }
  const action = issue.statusLabel === STATUS_READY ? 'claim-ready-issue' : 'continue-in-progress-issue';
  if (issue.statusLabel === STATUS_READY) {
    ghRunner(['issue', 'edit', String(issue.number), '--repo', args.repo, '--remove-label', STATUS_READY, '--add-label', STATUS_IN_PROGRESS]);
  }
  const runnerStartedCommentIdentity = postRunnerStartedComment(args, issue, selection, action, ghRunner);
  const sourceCommentIdentity = null;
  const sourcePreflightCommentIdentity = selection.preflight ? normalizeCommentIdentity(selection.preflight) : null;
  return {
    action,
    statusLabel: issue.statusLabel,
    selectionMode: selection.mode,
    sourceCommentId: selection.command?.sourceCommentId || null,
    sourceCommentIdentity,
    sourcePreflightCommentIdentity,
    sourcePreflightCommentId: commentRevision(sourcePreflightCommentIdentity),
    managerPreflightRevision: selection.managerAuthority?.revision || null,
    managerPreflightFingerprint: selection.managerAuthority?.fingerprint || null,
    managerPreflightBodyDigest: selection.managerAuthority?.packetDigest || null,
    managerAuthorityKey: selection.managerAuthority?.authorityKey || null,
    runnerStartedCommentIdentity,
  };
}

/**
 * A dedicated, structured-evidence-only detail block for a workspace-
 * ownership outcome (#686). Deliberately built from typed fields the caller
 * supplies (`executionPhase`, `executionAuthorizationAllowed`,
 * `workerStarted`, `reconciliationSteps`) rather than re-deriving or
 * re-parsing anything from the raw manager-preflight comment body — recovery
 * reporting must never independently reinterpret the preflight text, and
 * must never claim a phase/authorization fact the persisted execution
 * authorization result already contradicts.
 */
function workspaceOwnershipDetailBlock(issue, failure, outcome) {
  if (!WORKSPACE_OWNERSHIP_OUTCOMES.includes(outcome)) return '';
  const policy = WORKSPACE_OWNERSHIP_POLICY[outcome];
  const steps = (failure.reconciliationSteps || policy?.reconciliationSteps || []);
  const authorisedLine = failure.workerStarted === false
    ? `The runner authorised issue #${issue.number} but did not start Claude.\n\n`
    : '';
  const workerLine = failure.workerStarted === false ? '\nNo worker process was started.\n' : '';
  const phaseLine = failure.executionPhase ? `- Execution phase: \`${failure.executionPhase}\`\n` : '';
  const authorizationLine = typeof failure.executionAuthorizationAllowed === 'boolean'
    ? `- Execution authorization allowed: \`${failure.executionAuthorizationAllowed}\`\n`
    : '';
  const stepsBlock = steps.length ? `\nRequired reconciliation:\n${steps.map((step) => `- ${step};`).join('\n').replace(/;$/, '.')}\n` : '';
  return `\n### Workspace ownership conflict

${authorisedLine}Workspace preparation failed because the expected implementation branch or worktree already exists and exclusive ownership could not be proven.

Failure:
\`${outcome}\`
${workerLine}${phaseLine}${authorizationLine}${stepsBlock}
Do not add another manager preflight until workspace ownership is resolved.
`;
}

const PRE_ATTEMPT_ATTENTION_SCOPES = Object.freeze(['machine_profile', 'issue_not_runnable']);

export function runnerAttentionCommentBody(issue, failure = {}) {
  // #231: a pre-attempt candidate/capability/cost admission refusal is not a
  // `TERMINAL_OUTCOMES` member -- `normalizeTerminalOutcome()` would
  // silently collapse its exact typed reason into `unknown_failure`
  // (forbidden by #231 scope item 4). `failure.failureScope` only ever
  // carries one of the bounded #230 `FAILURE_PROJECTION_SCOPES` values, so
  // this is a positive, narrow bypass -- every existing post-attempt caller
  // (which never sets `failureScope`) is completely unaffected.
  const preAttempt = PRE_ATTEMPT_ATTENTION_SCOPES.includes(failure.failureScope);
  const outcome = preAttempt ? String(failure.reason || 'unknown_failure') : normalizeTerminalOutcome(failure.reason);
  const finishedAt = failure.detectedAt || failure.finishedAt || failure.startedAt || 'unknown';
  const recoveryStatus = String(failure.recoveryStatus || 'forbidden');
  const nextAction = String(failure.nextAction || 'Inspect the sanitized failure evidence and provide an explicit manager decision.');
  const completed = outcome === 'completed';
  const heading = completed ? '## Agent runner attention resolved' : '## Agent runner attention required';
  const queueAction = completed
    ? 'this issue remains open and returns from `status:blocked` to `status:in-progress`; merge and closure remain explicit human actions.'
    : 'this task remains task-local; the runner will continue with other eligible work where policy permits.';
  const footer = completed
    ? 'Recovery completed without auto-closing the issue.'
    : 'This is a task-local failure, not a reason to idle the runner.';
  return `${RUNNER_ATTENTION_MARKER}

${heading}

- Issue: #${issue.number}
- Outcome: \`${outcome}\`
- Detected at: ${finishedAt}
- Recovery status: \`${recoveryStatus}\`
- Policy revision: \`${failure.policyRevision || 'runner-recovery-v1'}\`
- Safe next action: ${nextAction}
- Queue action: ${queueAction}
- Recovery rule: retry or hand off only from a safe checkpoint. Do not blind-retry a fresh session.
${workspaceOwnershipDetailBlock(issue, failure, outcome)}${renderFailureProjectionSection(failure.projection)}
${footer}`;
}

export function waitForExplicitPlanApproval(args, issue, failure, ghRunner = gh) {
  const errors = [];
  let statusUpdated = false;
  let attentionPosted = false;
  let attentionResult = null;
  try {
    ghRunner(['issue', 'edit', String(issue.number), '--repo', args.repo, '--remove-label', STATUS_IN_PROGRESS, '--add-label', STATUS_BLOCKED]);
    statusUpdated = true;
  } catch (error) {
    errors.push({ stage: 'status-update', message: String(error?.message || error) });
  }
  try {
    attentionResult = upsertGitHubAttentionComment(args, issue, failure, ghRunner);
    attentionPosted = Boolean(attentionResult?.posted || attentionResult?.updated || attentionResult?.deduplicated);
  } catch (error) {
    errors.push({ stage: 'attention-comment', message: String(error?.message || error) });
  }
  return {
    issue: issue.number,
    reason: 'plan_only_awaiting_approval',
    awaitingExplicitApproval: true,
    quarantined: false,
    statusUpdated,
    attentionPosted,
    attentionResult,
    queueReleased: true,
    errors,
  };
}

export function restoreIssueAfterSuccessfulRecovery(args, issue, ghRunner = gh) {
  ghRunner(['issue', 'edit', String(issue.number), '--repo', args.repo, '--remove-label', STATUS_BLOCKED, '--add-label', STATUS_IN_PROGRESS]);
  return {
    issue: issue.number,
    fromStatus: STATUS_BLOCKED,
    toStatus: STATUS_IN_PROGRESS,
    issueClosed: false,
  };
}

export function upsertGitHubAttentionComment(args, issue, failure, ghRunner = gh) {
  const body = runnerAttentionCommentBody(issue, failure);
  const existing = readIssueComments(args.repo, issue.number, ghRunner)
    .filter((comment) => String(comment?.body || '').includes(RUNNER_ATTENTION_MARKER))
    .sort((a, b) => String(commentTime(b)).localeCompare(String(commentTime(a))))[0];
  if (existing?.body === body) return { posted: false, updated: false, deduplicated: true };
  if (existing) {
    const databaseId = requireRestCommentDatabaseId(existing, 'attention-comment-update');
    ghRunner(['api', '--method', 'PATCH', `repos/${args.repo}/issues/comments/${databaseId}`, '-f', `body=${body}`]);
    return {
      posted: false,
      updated: true,
      deduplicated: false,
      commentIdentity: normalizeCommentIdentity(existing),
    };
  }
  const output = ghRunner(['issue', 'comment', String(issue.number), '--repo', args.repo, '--body', body]);
  const commentIdentity = normalizeCommentIdentity({ url: String(output || '').trim() });
  return { posted: true, updated: false, deduplicated: false, commentIdentity };
}

export function quarantineIssueAfterFailedRun(args, issue, failure, ghRunner = gh) {
  const errors = [];
  let statusUpdated = false;
  let attentionPosted = false;
  let attentionResult = null;

  try {
    ghRunner(['issue', 'edit', String(issue.number), '--repo', args.repo, '--remove-label', STATUS_IN_PROGRESS, '--add-label', STATUS_BLOCKED]);
    statusUpdated = true;
  } catch (error) {
    errors.push({ stage: 'status-update', message: String(error?.message || error) });
  }

  try {
    attentionResult = upsertGitHubAttentionComment(args, issue, failure, ghRunner);
    attentionPosted = Boolean(attentionResult?.posted || attentionResult?.updated || attentionResult?.deduplicated);
  } catch (error) {
    errors.push({ stage: 'attention-comment', message: String(error?.message || error) });
  }

  return {
    issue: issue.number,
    reason: failure.reason,
    statusUpdated,
    attentionPosted,
    attentionResult,
    queueReleased: true,
    errors,
  };
}

/**
 * The pre-claim counterpart to `quarantineIssueAfterFailedRun()` (#686): a
 * workspace-ownership conflict is detected *before* `claimIssueForExecution`
 * ever runs, so the issue is still carrying whatever status label selection
 * found it under (`status:ready` for a fresh candidate, or `status:in-progress`
 * for an unclaimed continue command) — never `status:in-progress` from this
 * attempt, because this attempt never claimed it. No runner-start marker was
 * posted and no manager packet was consumed; only the label moves, to
 * `status:blocked`, so the scheduler does not reselect the same conflicted
 * issue on the very next pass while every other eligible issue keeps
 * scanning normally.
 */
export function quarantineIssueBeforeClaim(args, issue, failure, ghRunner = gh) {
  const errors = [];
  let statusUpdated = false;
  let attentionPosted = false;
  let attentionResult = null;
  const fromLabel = issue.statusLabel || STATUS_READY;

  try {
    ghRunner(['issue', 'edit', String(issue.number), '--repo', args.repo, '--remove-label', fromLabel, '--add-label', STATUS_BLOCKED]);
    statusUpdated = true;
  } catch (error) {
    errors.push({ stage: 'status-update', message: String(error?.message || error) });
  }

  try {
    attentionResult = upsertGitHubAttentionComment(args, issue, failure, ghRunner);
    attentionPosted = Boolean(attentionResult?.posted || attentionResult?.updated || attentionResult?.deduplicated);
  } catch (error) {
    errors.push({ stage: 'attention-comment', message: String(error?.message || error) });
  }

  return {
    issue: issue.number,
    reason: failure.reason,
    fromStatus: fromLabel,
    statusUpdated,
    attentionPosted,
    attentionResult,
    markerPosted: false,
    packetConsumed: false,
    claimCommitted: false,
    queueReleased: true,
    errors,
  };
}

export function latestRunnerStartedComment(comments = []) {
  return [...comments]
    .filter((comment) => String(comment?.body || '').includes(RUNNER_STARTED_HEADING))
    .sort((left, right) => String(commentTime(right)).localeCompare(String(commentTime(left))))[0] || null;
}

function runnerStartedMarkerClaimRevision(marker) {
  const body = String(marker?.body || '');
  return body.match(/Source command comment:\s*(\S+)/)?.[1]
    || body.match(/Source preflight comment:\s*(\S+)/)?.[1]
    || null;
}

function runnerStartedMarkerManagerAuthority(marker) {
  return String(marker?.body || '').match(/Manager packet authority:\s*`?([^\s`]+)`?/i)?.[1] || null;
}

function classifyManagerTimelineComment(comment) {
  const body = String(comment?.body || '');
  if (invalidatesManagerPreflight(body)) return 'revocation';
  if (hasManagerPreflight(body)) return 'preflight';
  if (/^## Claude (?:proceed|continue) command\b/im.test(body)) return 'command';
  if (/^## Manager recovery authorization\b/im.test(body)) return 'authorization';
  if (/^## (?:Manager|Agent) handoff\s*$/im.test(body)) return 'handoff';
  if (body.includes(RUNNER_STARTED_HEADING)) return 'runner-start';
  return null;
}

/**
 * One deterministic, tested resolver over the ordered manager-issue
 * timeline — preflights, commands, recovery authorizations, handoffs,
 * revocations, and runner-start claims — so the mere *existence* of an old
 * claim/preflight/authorization comment is never mistaken for *current*
 * authority (#698 finding 7). Every prior call site parsed this timeline
 * piecemeal and ad hoc (`latestManagerPreflightComment`,
 * `latestManagerRecoveryAuthorization`, `latestRunnerStartedComment`,
 * inline handoff regexes); this walks the full comment list once, in
 * chronological order, and folds each event into the running "what is
 * current right now" state:
 *
 *  - `preflight`/`command` establish a new claimable revision and clear any
 *    prior revocation.
 *  - `revocation` (a `## Manager preflight packet — stale/invalid/revoked/
 *    superseded` marker) invalidates the current claim revision's
 *    authorization state without erasing the claim revision itself — the
 *    revision id is still useful for cross-referencing, but `revoked` must
 *    gate any caller that would otherwise treat it as live authority.
 *  - `handoff` marks the current authorization as no longer sufficient
 *    (a manager/agent handoff supersedes it) until a fresh authorization
 *    or runner-start event appears after it.
 *  - `authorization` becomes the current recovery authorization and clears
 *    a pending handoff.
 *  - `runner-start` clears a pending handoff (the runner has since acted).
 *
 * Deliberately narrow in scope: this resolves *authority currency* over an
 * already-fetched comment list, not issue selection eligibility, quota,
 * agent compatibility, or dispatch. It is compatible with — but does not
 * implement — #719's broader selection redesign; it is a shared, tested
 * primitive #719 (or any other consumer) can build on rather than
 * re-deriving the same ad hoc comment scanning again.
 */
export function resolveManagerTimelineAuthority(comments = []) {
  const timeline = [...(comments || [])]
    .map((comment) => {
      const identity = normalizeCommentIdentity(comment);
      return {
        comment,
        type: classifyManagerTimelineComment(comment),
        identity,
        revision: commentRevision(identity),
        createdAt: commentTime(comment),
      };
    })
    .filter((event) => event.type !== null)
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));

  let currentClaimRevision = null;
  let currentClaimIdentity = null;
  let currentClaimType = null;
  let currentAuthorizationId = null;
  let currentAuthorizationIdentity = null;
  let revoked = false;
  let handoffPending = false;

  for (const event of timeline) {
    if (event.type === 'preflight' || event.type === 'command') {
      currentClaimRevision = event.revision;
      currentClaimIdentity = event.identity;
      currentClaimType = event.type;
      revoked = false;
    } else if (event.type === 'revocation') {
      revoked = true;
    } else if (event.type === 'handoff') {
      handoffPending = true;
      currentAuthorizationId = null;
      currentAuthorizationIdentity = null;
    } else if (event.type === 'authorization') {
      currentAuthorizationId = event.revision;
      currentAuthorizationIdentity = event.identity;
      handoffPending = false;
    } else if (event.type === 'runner-start') {
      handoffPending = false;
    }
  }

  return Object.freeze({
    timeline: Object.freeze(timeline.map((event) => Object.freeze({
      type: event.type,
      identity: event.identity,
      revision: event.revision,
      createdAt: event.createdAt,
    }))),
    currentClaimRevision,
    currentClaimIdentity,
    currentClaimType,
    currentAuthorizationId,
    currentAuthorizationIdentity,
    revoked,
    handoffPending,
  });
}

/**
 * Whether `claimRevision` (a comment id extracted from durable state or a
 * marker body) is still the *current* claim revision per the ordered
 * timeline — not merely a revision that was once claimable. A newer
 * preflight/command comment since posted, or an intervening revocation,
 * means it is no longer current (#698 finding 7).
 */
export function claimRevisionIsCurrent(comments, claimRevision) {
  if (!claimRevision) return false;
  const authority = resolveManagerTimelineAuthority(comments);
  return !authority.revoked
    && sameCommentIdentity(authority.currentClaimIdentity, claimRevision);
}

/**
 * A `## Claude runner started` marker alone used to reserve an issue
 * forever: the mere presence of the comment blocked selection with no
 * cross-check against whether anything is actually still running. A crash
 * between posting the marker and any later state write left the issue
 * silently stuck with no attention signal (#698 finding 6).
 *
 * When `state`/`repo` are supplied, the marker is cross-checked against
 * durable evidence — an active (unfinished) attempt row for this issue,
 * matching claim revision, and a live process identity. Only a full match
 * still reserves the issue. Anything else (no matching row, stale claim
 * revision, or a dead process) is classified `orphaned-runner-started-marker`
 * — a durable attention event is persisted and the caller still skips this
 * one issue for the current pass (it does not reclaim it outright, since a
 * fresh claim requires the normal claim path), but never blocks scanning of
 * unrelated ready work, which the caller already guarantees by `continue`-ing
 * its loop either way.
 *
 * Without `state`/`repo` (e.g. call sites that have not been updated to
 * supply durable state), this fails closed exactly as before: the marker
 * alone still reserves the issue.
 */
export async function activeRunBlockForIssue(issue, comments = [], selectionReason = null, { state = null, repo = null, processProbe = probeProcessIdentity } = {}) {
  if (issue?.statusLabel !== STATUS_IN_PROGRESS) return null;
  if (!['manager-preflight-already-claimed', 'manager-preflight-required', 'missing continue command'].includes(selectionReason)) return null;

  const marker = latestRunnerStartedComment(comments);
  if (!marker) return null;

  const base = {
    issue: issue.number,
    statusLabel: issue.statusLabel,
    runnerStartedCommentId: commentRevision(marker),
    runnerStartedAt: commentTime(marker),
  };

  if (!state || !repo) {
    return {
      ...base,
      reason: 'active-runner-started-issue',
      detail: 'A prior Claude runner-started issue is still status:in-progress and has no unclaimed Claude continue command. Reserving only this task while the scheduler continues scanning ready work.',
    };
  }

  const claimRevision = runnerStartedMarkerClaimRevision(marker);
  const markerManagerAuthority = runnerStartedMarkerManagerAuthority(marker);
  const activeRows = (state.invoke('activeRecoveryAttempts', repo) || []).filter((row) => row.issue_number === issue.number);
  let liveMatch = null;
  for (const row of activeRows) {
    if (row.manager_authority_key) {
      if (!markerManagerAuthority || row.manager_authority_key !== markerManagerAuthority) continue;
    } else {
      const persistedClaimIdentity = deserializeCommentIdentity(row.claim_identity_json || row.claim_id, 'active-attempt-claim');
      if (claimRevision && !sameCommentIdentity(persistedClaimIdentity, claimRevision)) continue;
    }
    let live = false;
    try {
      live = await processProbe({
        processId: row.process_id, processBootId: row.process_boot_id,
        processStartTicks: row.process_start_ticks, systemdInvocationId: row.systemd_invocation_id,
      });
    } catch { live = false; }
    if (live === true) { liveMatch = row; break; }
  }

  // A live, durably-matching attempt is not enough on its own: the claim
  // revision it matched against must still be *current* authority per the
  // ordered manager timeline, not merely a revision that existed at some
  // point (#698 finding 7) — a newer preflight/command since posted, or an
  // intervening revocation, means this live process is running under
  // superseded authority and belongs in front of an operator, not silently
  // trusted to keep reserving the issue.
  const liveAuthorityCurrent = liveMatch?.manager_authority_key
    ? managerAuthorityKeyIsCurrent(comments, liveMatch.manager_authority_key, liveMatch.manager_preflight_body_digest)
    : (!claimRevision || claimRevisionIsCurrent(comments, claimRevision));
  if (liveMatch && liveAuthorityCurrent) {
    return {
      ...base,
      reason: 'active-runner-started-issue',
      detail: 'A prior Claude runner-started issue is still status:in-progress with a live, durably-verified attempt (matching claim revision and process identity). Reserving only this task while the scheduler continues scanning ready work.',
      attemptId: liveMatch.attempt_id,
    };
  }

  const nextAction = liveMatch
    ? 'A `## Claude runner started` marker matches a live, durably-verified attempt, but its claim revision is no longer current manager authority (superseded by a later preflight/command, or revoked). Verify manually; the scheduler no longer treats this marker alone as reserving the issue.'
    : 'A `## Claude runner started` marker exists with no durable evidence (active attempt row, matching claim revision, live process) confirming it is still running. Verify manually; the scheduler no longer treats this marker alone as reserving the issue.';
  const event = buildAttentionEvent({
    repository: repo, issueNumber: issue.number, attemptId: liveMatch ? String(liveMatch.attempt_id) : `marker-${commentRevision(marker)}`,
    reason: 'unknown_failure', recoveryStatus: 'orphaned', finishedAt: new Date().toISOString(),
    nextAction, dashboardReference: `issue-${issue.number}`,
  });
  state.invoke('upsertAttentionEvent', event);

  return {
    ...base,
    reason: 'orphaned-runner-started-marker',
    orphaned: true,
    detail: 'A `## Claude runner started` marker exists but no durable evidence (matching active attempt row, current claim revision, live process) confirms it is still running under current authority. Treated as orphaned; unrelated ready work continues to be scanned.',
  };
}

// The governing correctness invariant (#698 round 3): after every scheduler
// pass, crash, or restart, every attempt must be durably and unambiguously
// in exactly one of these five row-level states (a sixth, "runnable", is a
// property of an *issue with no in-flight attempt row* and so is not a
// `recovery_attempts.resolution_state` this classifier can observe) — never
// silent limbo. `classifyAttemptLivenessState()` makes that invariant
// executable: any row whose classification comes back `'ambiguous'` is a
// bug, not a valid resting state, and every fault-injection scenario in
// claude-runner-fault-injection.test.mjs asserts this never happens.
//
// #698 round 4, finding 1: a bare `resolution_state` enum is not sufficient
// evidence of `actively_owned`/`delayed_bounded_retry` — a row can say
// `active` while its process is dead, its lease superseded, its manager
// authority stale, or its progress stalled past the configured window,
// and a row can say `unresolved`/`recovery_eligible` while its retry
// deadline is missing, expired, or its bounded-attempt cap already spent.
// `classifyAttemptLivenessState()` therefore takes an independently
// assembled `evidence` bundle (computed by `computeAttemptLivenessEvidence()`
// below, or supplied directly by a test) and only returns the permissive
// buckets when every required fact is proven true. Missing, stale,
// contradictory, or simply unsupplied evidence is treated identically to
// disproven evidence — it demotes to `task_local_attention`/`operator_held`,
// never silently to `actively_owned`/`delayed_bounded_retry`.
//
// This pair is an executable invariant *oracle*, exercised by
// claude-runner-fault-injection.test.mjs against the real production
// scheduler/state-store paths — it is not itself wired into any live
// dispatch decision or the dashboard. No scheduler code path currently
// calls `classifyAttemptLivenessState()`/`computeAttemptLivenessEvidence()`
// to decide whether to claim, retry, or block an attempt; they exist so a
// test (or a future operator tool) can prove any given persisted row is in
// exactly one governing-invariant bucket.
export const ATTEMPT_LIVENESS_STATES = Object.freeze([
  'actively_owned', 'delayed_bounded_retry', 'task_local_attention', 'operator_held', 'resolved',
]);

const TRANSITION_RESOLUTION_STATES = Object.freeze([
  'transition_pending', 'transition_uncertain', 'attention_resolution_pending',
]);

export function classifyAttemptLivenessState(row, evidence = {}) {
  if (!row) return null;
  switch (row.resolution_state) {
    case 'resolved':
      return 'resolved';
    case 'operator_attention_required':
      return 'operator_held';
    case 'active': {
      const activelyOwnedProven = evidence.liveProcess === true
        && evidence.leaseCurrent === true
        && evidence.authorityCurrent === true
        && evidence.progressWithinStallWindow === true;
      return activelyOwnedProven ? 'actively_owned' : 'task_local_attention';
    }
    default:
      if (TRANSITION_RESOLUTION_STATES.includes(row.resolution_state)) {
        // #698 round 5 final-head fix: transition rows now get the same
        // authoritative persisted schedule as any other bounded retry
        // (`incrementTransitionMutationCount()` sets `next_retry_at`/
        // `retry_attempt`/`retry_cap`/`retry_reason` before each retried
        // mutation) — bounded mutation-cap headroom alone is not a retry
        // schedule, so a transition row must prove both a valid future
        // deadline and cap headroom before reading as `delayed_bounded_retry`.
        return evidence.retryDeadlineValid === true
          && evidence.boundedRetryPolicyProven === true
            ? 'delayed_bounded_retry'
            : 'task_local_attention';
      }
      if (row.resolution_state === 'unresolved') {
        if (!row.recovery_eligible) return 'task_local_attention';
        const boundedRetryProven = evidence.retryDeadlineValid === true && evidence.boundedRetryPolicyProven === true;
        return boundedRetryProven ? 'delayed_bounded_retry' : 'task_local_attention';
      }
      return 'ambiguous';
  }
}

/**
 * Assembles the evidence bundle `classifyAttemptLivenessState()` requires,
 * from a persisted `recovery_attempts` row plus live inputs (process probe,
 * the issue's current comment timeline, and the clock). Kept as a distinct
 * async boundary so the classifier itself stays a pure, synchronous,
 * trivially-testable function — fault-injection tests can drive the
 * classifier directly with hand-built evidence, or drive this assembler with
 * a broken probe/empty timeline/malformed row to prove the whole pipeline
 * fails closed end-to-end (#698 round 4, finding 1).
 */
export async function computeAttemptLivenessEvidence(row, {
  processProbe = probeProcessIdentity,
  comments = [],
  otherLease = false,
  now = () => new Date().toISOString(),
  stallPassLimit = DEFAULT_STALLED_PASS_LIMIT,
  policy,
} = {}) {
  if (!row) return {};
  // `liveProcessRaw` preserves the probe's tri-state result (true/false/
  // null) for callers that must distinguish confirmed-dead from ambiguous
  // (e.g. to label an outcome `orphaned_active_claim` vs. `unknown_failure`
  // — both are equally "not proven live" for classification, which is what
  // the strict boolean `liveProcess` below is for, but they are diagnostically
  // distinct facts worth preserving).
  let liveProcessRaw = null;
  try {
    const identity = {
      processId: row.process_id, processBootId: row.process_boot_id,
      processStartTicks: row.process_start_ticks, systemdInvocationId: row.systemd_invocation_id,
    };
    const probed = await processProbe(identity);
    liveProcessRaw = probed === true ? true : probed === false ? false : null;
  } catch {
    liveProcessRaw = null;
  }
  const liveProcess = liveProcessRaw === true;
  // "Current exclusive lease" means no other active attempt row conflicts
  // for the same issue — checked here via `otherLease`, computed by the
  // caller across the full active set. `recovery_lease_id` alone is not a
  // universal signal: only attempts claimed through the bounded-recovery
  // path (`claimRecovery()`) ever get one populated — an ordinary first-run
  // issue attempt never does, so requiring it unconditionally would demote
  // every ordinary attempt regardless of exclusivity.
  const leaseCurrent = otherLease !== true;
  const claimIdentity = deserializeCommentIdentity(row.claim_identity_json || row.claim_id, 'liveness-claim');
  const authorityCurrent = row.manager_authority_key
    ? managerAuthorityKeyIsCurrent(comments, row.manager_authority_key, row.manager_preflight_body_digest)
    : Boolean(claimIdentity) && claimRevisionIsCurrent(comments, claimIdentity);
  const progressWithinStallWindow = (row.stalled_passes || 0) < stallPassLimit;
  // #698 round 5, finding 2: a bounded retry now requires the authoritative
  // persisted schedule (`next_retry_at`/`retry_attempt`/`retry_cap`/
  // `retry_reason`), not `retry_at`/`recovery_attempt_count`/a recomputed
  // cap, and not mutation-count headroom alone. `retry_reason` must be set
  // (populated at every write site that also sets the deadline/attempt/cap)
  // as the marker that this row genuinely went through retry-schedule
  // persistence — a legacy or never-scheduled row (both read as
  // `next_retry_at IS NULL`) must never be treated as having a real
  // schedule just because a count-cap happens to be null.
  const hasRetrySchedule = Boolean(row.retry_reason) && Boolean(row.next_retry_at);
  const nextRetryAtMs = Date.parse(row.next_retry_at || '');
  const nowMs = Date.parse(now());
  const retryDeadlineValid = hasRetrySchedule && Number.isFinite(nextRetryAtMs) && Number.isFinite(nowMs) && nextRetryAtMs > nowMs;
  const boundedRetryPolicyProven = row.retry_cap == null
    ? hasRetrySchedule
    : hasRetrySchedule && (row.retry_attempt || 0) < row.retry_cap;
  return {
    liveProcess, liveProcessRaw, leaseCurrent, authorityCurrent, progressWithinStallWindow,
    retryDeadlineValid, boundedRetryPolicyProven,
  };
}

function readBootId(reader = readFileSync) {
  return String(reader('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
}

function readProcessStartTicks(processId, reader = readFileSync) {
  const path = processId === process.pid ? '/proc/self/stat' : `/proc/${processId}/stat`;
  const stat = String(reader(path, 'utf8'));
  const close = stat.lastIndexOf(')');
  if (close < 0) throw new Error('invalid proc stat');
  const fieldsAfterCommand = stat.slice(close + 2).trim().split(/\s+/);
  const startTicks = fieldsAfterCommand[19];
  if (!startTicks) throw new Error('missing proc start time');
  return startTicks;
}

export function captureProcessIdentity(processId = process.pid, env = process.env, reader = readFileSync) {
  return {
    processId,
    processBootId: readBootId(reader),
    processStartTicks: readProcessStartTicks(processId, reader),
    systemdInvocationId: String(env.INVOCATION_ID || '').trim() || null,
  };
}

export function probeProcessIdentity(identity, { reader = readFileSync, signalProbe = (pid) => process.kill(pid, 0) } = {}) {
  const processId = Number(identity?.processId);
  if (!Number.isInteger(processId) || processId < 1) return false;
  if (!identity?.processBootId || !identity?.processStartTicks) return null;
  try { signalProbe(processId); } catch { return false; }
  try {
    if (readBootId(reader) !== identity.processBootId) return false;
    if (readProcessStartTicks(processId, reader) !== String(identity.processStartTicks)) return false;
    return true;
  } catch {
    return null;
  }
}

function processProgressRecord(processId, reader = readFileSync) {
  const stat = String(reader(`/proc/${processId}/stat`, 'utf8'));
  const close = stat.lastIndexOf(')');
  if (close < 0) throw new Error('invalid proc stat');
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const io = String(reader(`/proc/${processId}/io`, 'utf8'));
  const ioValue = (name) => io.match(new RegExp(`^${name}:\\s*(\\d+)$`, 'm'))?.[1] || '0';
  return [String(processId), fields[11] || '0', fields[12] || '0', ioValue('read_bytes'), ioValue('write_bytes')].join(':');
}

/**
 * A content-free progress token for the wrapper child and its live descendants.
 * CPU and kernel I/O counters change while the real CLI child works, even
 * though the singleton cron process is waiting and stdout is quiet.
 */
export function probeProcessProgress(processId, reader = readFileSync) {
  const pending = [Number(processId)];
  const seen = new Set();
  const records = [];
  while (pending.length) {
    const pid = pending.shift();
    if (!Number.isInteger(pid) || pid < 1 || seen.has(pid)) continue;
    seen.add(pid);
    records.push(processProgressRecord(pid, reader));
    try {
      const children = String(reader(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim();
      if (children) pending.push(...children.split(/\s+/).map(Number));
    } catch { /* a child may exit between proc reads */ }
  }
  if (records.length === 0) return null;
  return records.sort().join('|');
}

export function deriveTerminalOutcome({ effectiveExitCode, childPayload, childReason }) {
  if (childPayload?.awaitingPlanApproval) return 'plan_only_awaiting_approval';
  if (effectiveExitCode === 0) return 'completed';
  return normalizeTerminalOutcome(childReason);
}

/**
 * The single production-authoritative ownership check for every currently
 * `active` recovery attempt (#698 round 5, finding 1). Supersedes treating
 * "process confirmed live" alone as proof of ownership — a live process
 * with a superseded manager authority, a conflicting lease, or stalled
 * progress no longer counted as orphaned before this round, so it kept the
 * global execution slot reserved indefinitely. Every active row now goes
 * through the same evidence-based classifier
 * (`computeAttemptLivenessEvidence()`/`classifyAttemptLivenessState()`)
 * fault-injection already exercises as an oracle; here its result directly
 * controls persisted state and slot disposition, not merely a test
 * assertion. Only `actively_owned` leaves the row untouched; every other
 * classification demotes it identically to the historical dead-process
 * path — durable attention, the global slot released (`finished_at`/
 * `resolution_state: 'unresolved'` persisted), and the scheduler continues
 * scanning unrelated work. A GitHub read failure while checking current
 * authority fails closed (`authorityCurrent = false`) rather than trusting
 * a stale claim revision or crashing the whole reconciliation pass.
 */
export async function reconcileSchedulerAttempts({ state, args, processProbe = probeProcessIdentity, ghRunner = gh, now = () => new Date().toISOString(), stalledPassLimit = args.stalledPassLimit || DEFAULT_STALLED_PASS_LIMIT, excludeAttemptId = null }) {
  const active = state.invoke('activeRecoveryAttempts', args.repo) || [];
  const attention = [];
  let demoted = 0;
  for (const row of active) {
    // The attempt the calling watchdog is directly supervising (its own
    // in-flight child) skips the *authority* re-derivation below: authority
    // was already proven once at dispatch/claim time, and re-deriving it
    // from a live GitHub comment read on every watchdog tick would fail
    // closed -- demoting and releasing the slot of a healthy, still-running
    // job -- on any transient GitHub read error, or on an operator posting
    // an unrelated later comment while the run is still legitimately in
    // flight (#698 round 5 watchdog false-positive). Liveness,
    // lease-exclusivity, and progress-stall evidence still apply in full,
    // so a genuinely stalled or dead self-supervised attempt is still
    // demoted exactly as before.
    const isSelfSupervised = excludeAttemptId != null && String(row.attempt_id) === String(excludeAttemptId);
    const detectedAt = now();
    const progressRow = state.invoke('markStalledPass', row.attempt_id, stalledPassLimit, detectedAt) || row;
    const otherLease = active.some((other) => other.attempt_id !== row.attempt_id && other.issue_number === row.issue_number);
    let comments = [];
    let authorityReadOk = true;
    if (!isSelfSupervised) {
      try {
        comments = readIssueComments(args.repo, row.issue_number, ghRunner);
      } catch (error) {
        authorityReadOk = false;
        state.recordTaskError('reconcile-authority-read', error);
      }
    }
    const evidence = await computeAttemptLivenessEvidence(progressRow, {
      processProbe, comments, otherLease, now, stallPassLimit: stalledPassLimit,
    });
    if (isSelfSupervised) evidence.authorityCurrent = true;
    else if (!authorityReadOk) evidence.authorityCurrent = false;
    const bucket = classifyAttemptLivenessState({ resolution_state: 'active', recovery_eligible: row.recovery_eligible }, evidence);
    if (bucket === 'actively_owned') continue;

    // Not actively owned for any reason (dead process, superseded
    // authority, conflicting lease, or stalled progress) — release the
    // global slot the same way a confirmed-dead process always has.
    // `liveProcessRaw` preserves confirmed-dead (`false`) vs. ambiguous
    // (`null`, e.g. a probe error) — both fail closed identically for
    // classification, but only a confirmed-dead process is labeled an
    // orphaned claim; ambiguous evidence (including any OTHER demotion
    // reason — stale authority, conflicting lease, stalled progress — with
    // a still-live process) is `unknown_failure`. This split is a
    // deliberately preserved, separately fault-injection-tested invariant
    // (see claude-runner-fault-injection.test.mjs) — it is not touched here.
    //
    // #686 finding (spec section 7) refines only the confirmed-dead
    // (`liveProcessRaw === false`) case further: a bare confirmed-dead
    // process is not enough on its own to justify the still-active-sounding
    // `orphaned_active_claim` label. When the process is confirmed dead
    // *and* no other attempt currently holds this issue's lease *and* this
    // row's manager authority is no longer current, every fact needed to
    // treat the claim as cleanly, deterministically resolved is already
    // proven — that is `stale_unresolved_claim`, not an "active claim"
    // description. A confirmed-dead process whose lease/authority evidence
    // is still mixed (e.g. another attempt's lease, or this row's own
    // authority, still reads current) keeps the original `orphaned_active_claim`
    // label — a real "was this active?" question a human still has to
    // resolve.
    const staleAndUnresolved = evidence.leaseCurrent === false && evidence.authorityCurrent === false;
    const outcome = evidence.liveProcessRaw === false
      ? (staleAndUnresolved ? 'stale_unresolved_claim' : 'orphaned_active_claim')
      : 'unknown_failure';
    const decision = decideRecovery({ outcome, evidence: { processOwner: false, conflictingLease: false, ownershipAmbiguous: false } });
    const event = buildAttentionEvent({
      repository: args.repo, project: args.project?.id, issueNumber: row.issue_number, attemptId: row.attempt_id,
      reason: outcome, recoveryStatus: decision.status, nextAction: decision.nextAction, startedAt: row.started_at, finishedAt: detectedAt,
    });
    const attemptPersisted = state.record('recordRecoveryAttempt', {
      attemptId: row.attempt_id, repo: args.repo, project: args.project?.id, issueNumber: row.issue_number,
      claimId: row.claim_id, preflightRevision: row.preflight_revision, agent: row.agent, model: row.model, harness: row.harness,
      startedAt: row.started_at, finishedAt: detectedAt, outcome,
      recoveryEligible: decision.eligible, recoveryAction: decision.action, recoveryAttemptCount: row.recovery_attempt_count,
      retryAt: decision.retryAt || null,
      nextRetryAt: decision.eligible ? (decision.retryAt || null) : null,
      retryAttempt: decision.recoveryAttemptCount || row.recovery_attempt_count || 0,
      retryCap: recoveryAttemptCapForOutcome(outcome),
      retryReason: decision.eligible ? outcome : null,
      attentionStatus: 'attention_required', attentionDedupeKey: event.dedupeKey, resolutionState: 'unresolved',
      processId: row.process_id, processBootId: row.process_boot_id, processStartTicks: row.process_start_ticks, systemdInvocationId: row.systemd_invocation_id,
      restrictedEvidence: { processId: row.process_id, livenessEvidence: evidence },
    });
    if (attemptPersisted) {
      const persisted = state.invoke('upsertAttentionEvent', event);
      if (persisted?.materiallyChanged) {
        try { upsertGitHubAttentionComment(args, { number: row.issue_number }, event, ghRunner); } catch (error) { state.recordTaskError('watchdog-attention-comment', error); }
      }
    }
    attention.push(event);
    demoted += 1;
  }
  return { checked: active.length, orphaned: demoted, attention };
}

export async function runChildWithWatchdog({ command, commandArgs, options, state, args, attemptId = null, ghRunner = gh, spawnRunner = spawn, processProbe = probeProcessIdentity, progressProbe = probeProcessProgress, now = () => new Date().toISOString(), watchdogIntervalMs = args.watchdogIntervalMs, stalledPassLimit = args.stalledPassLimit }) {
  const child = spawnRunner(command, commandArgs, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let spawnError = null;
  const maxBuffer = Number.isFinite(options?.maxBuffer) ? options.maxBuffer : 20 * 1024 * 1024;
  const appendOutput = (current, chunk) => {
    const next = current + chunk;
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > maxBuffer) {
      const error = new Error(`runner child output exceeded maxBuffer (${maxBuffer} bytes)`);
      error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      spawnError ||= error;
      child.kill('SIGKILL');
      return current;
    }
    return next;
  };
  let reconciling = null;
  let outputRevision = 0;
  const persistProgress = (token) => {
    if (!attemptId || !token) return;
    state.invoke('recordRecoveryProgress', attemptId, token, now());
  };
  try {
    const initialProgress = progressProbe(child.pid);
    persistProgress(initialProgress ? `process:${initialProgress}` : null);
  } catch { /* missing proc evidence is fail-closed by unchanged revisions */ }
  const reconcile = async () => {
    if (reconciling) return reconciling;
    reconciling = Promise.resolve().then(() => {
      let token = null;
      try { token = progressProbe(child.pid); } catch { token = null; }
      persistProgress(token ? `process:${token}` : null);
      return reconcileSchedulerAttempts({ state, args, processProbe, ghRunner, now, stalledPassLimit, excludeAttemptId: attemptId });
    })
      .catch((error) => {
        // Not on the enumerated systemic-fault list (corrupt/unavailable
        // shared state, broken locking, ambiguous checkout ownership, unsafe
        // config, repo corruption, credential compromise, operator pause) —
        // an unexpected exception in one watchdog pass must not idle
        // unrelated dispatch; it is retried on the next tick (#698 finding 5).
        state.recordTaskError('in-lock-watchdog', error);
        return { checked: 0, orphaned: 0, attention: [] };
      })
      .finally(() => { reconciling = null; });
    return reconciling;
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout = appendOutput(stdout, chunk); persistProgress(`output:${++outputRevision}`); });
  child.stderr?.on('data', (chunk) => { stderr = appendOutput(stderr, chunk); persistProgress(`output:${++outputRevision}`); });
  const timer = setInterval(() => { void reconcile(); }, watchdogIntervalMs);
  const result = await new Promise((resolveResult) => {
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (status, signal) => resolveResult({ status, signal }));
  });
  clearInterval(timer);
  if (reconciling) await reconciling;
  return { ...result, stdout, stderr, error: spawnError };
}

export function runQuotaPreflight(args, env = process.env, runner = spawnSync) {
  if (!args.execute || !args.quotaPreflight) return { blocked: false, skipped: true, reason: 'not-required' };

  const nodeArgs = quotaPreflightArgs(args);
  const result = runner(process.execPath, nodeArgs, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, env });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout || '{}');
  } catch {
    payload = null;
  }

  const status = payload?.status || null;
  const blocked = result.status !== 0 || !payload || status !== 'available';
  return {
    blocked,
    skipped: false,
    nodeArgs,
    exitCode: result.status,
    signal: result.signal,
    status,
    stdout: result.stdout,
    stderr: result.stderr,
    payload,
    reason: blocked ? 'quota-preflight-blocked' : null,
  };
}

/**
 * Cheap, catalogue-level pre-check (issue #50, "Claude quota is agent-local"):
 * is there *any* implemented, routable agent other than Claude at all? Real
 * Codex CLI and Grok CLI remain unimplemented. #376 makes Ollama a real
 * alternative only when its machine-local lifecycle is explicitly routable;
 * the selector, readiness/qualification gates and the independent pre-claim
 * Ollama admission still decide whether any issue may actually use it.
 */
export function hasImplementedRoutableAlternative(settingsSnapshot) {
  return Object.values(AGENT_ADAPTERS).some((adapter) => (
    adapter.agentId !== CLAUDE_AGENT_ID
    && adapter.implemented
    && settingsSnapshot?.agents?.[adapter.agentId]?.routable
  ));
}

/**
 * Deterministic, catalogue-ordered candidate list for the serial selector --
 * no weighting or randomness. `readinessByAgentId` carries only the bounded
 * `{ healthy, ready }` view `boundedReadiness()` produces below -- never the
 * raw `computeInstanceReadiness()` result, whose `probes[].detail` can carry
 * a resolved executable path.
 */
export function buildRoutingCandidates(settingsSnapshot, claudeResourceState = null, readinessByAgentId = {}) {
  return Object.values(AGENT_ADAPTERS).map((adapter) => ({
    agentId: adapter.agentId,
    adapter,
    settingsEntry: settingsSnapshot?.agents?.[adapter.agentId] || null,
    resourceState: adapter.agentId === CLAUDE_AGENT_ID ? claudeResourceState : null,
    readiness: readinessByAgentId?.[adapter.agentId] || null,
  }));
}

/**
 * Bound a raw `computeInstanceReadiness()` result down to exactly the two
 * booleans + fixed reason code `evaluateAgentEligibility()` is allowed to
 * see (issue #50 review, requirement 5). `probes`/`detail` -- which can
 * carry a resolved executable path -- are intentionally dropped here and
 * never threaded any further.
 */
export function boundedReadiness(rawReadiness) {
  if (!rawReadiness || typeof rawReadiness !== 'object') return null;
  return Object.freeze({ healthy: rawReadiness.ok === true, ready: rawReadiness.ok === true });
}

/** Deterministic, catalogue-ordered `{ agentId: boundedReadiness }` map -- one no-cost, zero-process-spawn probe per adapter. */
export function computeReadinessByAgentId({ computeReadiness = computeInstanceReadiness, env = process.env } = {}) {
  const entries = Object.values(AGENT_ADAPTERS).map((adapter) => [
    adapter.agentId,
    boundedReadiness(computeReadiness({ adapter, pathEnv: env.PATH })),
  ]);
  return Object.freeze(Object.fromEntries(entries));
}

export async function selectIssue(args, ghRunner = gh, {
  state = null,
  processProbe = probeProcessIdentity,
  settingsSnapshot = null,
  claudeResourceState = null,
  classifyIssue = classifyIssueTaskRisk,
  readinessByAgentId = {},
  quotaAdmissionEvidence = null,
  env = process.env,
} = {}) {
  const skipped = [];
  let candidates;
  let reconciliationCandidates = [];
  try {
    // Retain the repo-wide open-PR inventory as part of queue inspection.
    // Selection no longer uses PR state to generate manager packets, but a
    // failed PR inventory still means the queue was not fully inspected and
    // must surface as queue_inspection_degraded rather than idle.
    listOpenPullRequests(args.repo, ghRunner);
    // Issue #50 review round 3: execution discovery and reconciliation
    // discovery are now structurally independent label sets, not one
    // configured list minus the other. Execution discovery is the
    // intersection of whatever an operator configured in `args.agentLabels`
    // with the catalogue's *implemented* adapter labels -- so a
    // misconfigured `acceptedAgentLabels` that happens to include
    // `agent:codex-cli`/`agent:grok-cli`/`agent:ollama` can never route
    // those issues into execution discovery (they would previously have
    // been silently skipped there as "unsupported agent" instead of
    // reaching reconciliation at all). Reconciliation discovery is every
    // catalogue label whose adapter is `implemented: false`, full stop --
    // it does not subtract or otherwise depend on `args.agentLabels`, so an
    // operator cannot accidentally configure a foundation-only label out of
    // reconciliation by listing it as "accepted".
    const executionAgentLabels = args.agentLabels.filter((label) => IMPLEMENTED_AGENT_LABELS.includes(label));
    candidates = executionAgentLabels.length
      ? listCandidateIssues(args.repo, args.limit, executionAgentLabels, args.includeInProgress, ghRunner)
      : [];
    // A distinct status:ready-only reconciliation scan over every
    // foundation-only (not-yet-implemented) catalogue label, so a queued
    // issue explicitly assigned to e.g. codex-cli/grok-cli/ollama-agent is
    // visible to reassignment/no-qualified-agent evidence below even though
    // it can never be executed. Only runs when the multi-agent selector is
    // engaged for this pass (settingsSnapshot supplied).
    if (settingsSnapshot && FOUNDATION_ONLY_AGENT_LABELS.length) {
      reconciliationCandidates = listCandidateIssues(args.repo, args.limit, FOUNDATION_ONLY_AGENT_LABELS, false, ghRunner);
    }
    // #698 round 5, finding 3: a successful repo-wide scan is exactly the
    // condition that clears `queue_inspection_degraded` — resolve it here,
    // not merely by letting newer queue events push a stale event out of a
    // latest-N window.
    state?.record?.('resolveHealthCondition', { repo: args.repo, conditionType: 'queue_inspection_degraded' });
  } catch (error) {
    // A transient GitHub failure fetching the repo-wide open-PR or
    // candidate-issue lists must not crash the whole scheduler pass. No
    // attempt is claimed and no global slot is held, so this is safe to
    // treat as "no eligible candidate this pass" rather than an uncaught
    // throw — the next cron tick retries with a fresh call (#698 finding 10).
    //
    // That local safety must not be conflated with an *operational* "no
    // eligible work" report, though (#698 finding 3): the queue was never
    // actually inspected this pass, so a dedicated, resolvable
    // `queue_inspection_degraded` health condition is opened — distinct
    // from an ordinary per-issue `skip` event — so `buildRunnerOperatorStatus()`
    // can surface a visibly degraded operator status instead of `idle`,
    // and stop showing it the moment a later pass genuinely recovers.
    // This is deliberately *not* routed through `emitSystemicStatePause`:
    // persisted recovery reconciliation for already-known attempts is
    // healthy and must keep running; only *new*-candidate discovery is
    // blind this pass.
    state?.recordTaskError?.('candidate-scan-failed', error);
    state?.record?.('recordQueueEvent', {
      repo: args.repo,
      eventType: 'queue-inspection-degraded',
      reason: 'candidate-scan-failed',
      payload: { error: String(error?.message || error) },
    });
    state?.record?.('openHealthCondition', {
      repo: args.repo, conditionType: 'queue_inspection_degraded', reason: 'candidate-scan-failed',
      safeNextAction: 'Verify GitHub API connectivity/auth for the runner; new-candidate discovery is blind until this clears. Already-known recovery attempts continue reconciling normally.',
      payload: { error: String(error?.message || error) },
    });
    skipped.push({ issue: null, statusLabel: null, reason: 'candidate-scan-failed', error: String(error?.message || error) });
    return { issue: null, selection: null, command: null, currentPreflight: null, managerAuthority: null, skipped, blocked: null, queueInspectionDegraded: true };
  }

  // Issue #50 review round 3: multiple supported local agent labels on one
  // issue are ambiguous -- resolving to "whichever label matched first"
  // (the pre-existing `resolveAgentForLabels()` behaviour) is exactly the
  // silent-pick this review forbids. Checked once, ahead of both scans
  // below, against a shared set so an issue that happens to appear in both
  // `candidates` and `reconciliationCandidates` (one implemented label plus
  // one foundation label) is flagged exactly once and never processed by
  // either loop as a normal candidate.
  const flaggedAmbiguousIssueNumbers = new Set();
  const ALL_SUPPORTED_AGENT_LABELS = allAgentLabels({ includeFuture: true });
  function supportedAgentLabelsOnIssue(issue) {
    const present = new Set(issueLabels(issue));
    return ALL_SUPPORTED_AGENT_LABELS.filter((label) => present.has(label));
  }
  function skipIfAmbiguous(issue) {
    const supportedAgentLabels = supportedAgentLabelsOnIssue(issue);
    // Two labels for the *same* adapter (e.g. both `agent:claude` and
    // `agent:claude-code-cli`) are not ambiguous -- only two or more
    // *distinct* agent ids present on one issue are.
    const distinctAgentIds = new Set(supportedAgentLabels.map((label) => resolveAgentForLabels([label])?.agentId).filter(Boolean));
    if (distinctAgentIds.size <= 1) return false;
    if (!flaggedAmbiguousIssueNumbers.has(issue.number)) {
      flaggedAmbiguousIssueNumbers.add(issue.number);
      skipped.push({
        issue: issue.number,
        statusLabel: issue.statusLabel,
        reason: 'ambiguous-agent-labels',
        ambiguousAgentLabels: true,
        // Bounded, catalogue-derived label *names* only (never a raw label
        // object or description) -- see supportedAgentLabelsOnIssue().
        supportedAgentLabels,
      });
    }
    return true;
  }

  // Issue #50 review, requirement 1/2: reconciliation candidates are
  // foundation-only by construction (their labels were deliberately
  // excluded from execution discovery's query because their catalogue
  // adapter is not implemented). The generic selector runs on them here,
  // before any implemented-agent check, since they must never reach
  // execution regardless of the outcome -- only a reassignment-candidate or
  // no-qualified-agent skip entry is ever produced for them. Only
  // status:ready issues are reconciled; an in-progress foundation-labeled
  // issue is already anomalous and is left for operator attention rather
  // than acted on here.
  const reconciledIssueNumbers = new Set();
  for (const issue of reconciliationCandidates) {
    if (issue.statusLabel !== STATUS_READY || reconciledIssueNumbers.has(issue.number)) continue;
    reconciledIssueNumbers.add(issue.number);
    const conflictSkip = metadataConflictSkip(issue);
    if (conflictSkip) {
      skipped.push(conflictSkip);
      continue;
    }
    if (skipIfAmbiguous(issue)) continue;
    const agent = resolveAgentForLabels([...(issue.labels || []), issue.agentLabel]);
    const classification = classifyIssue(issue);
    const routingResult = selectAgentForIssue({
      explicitAgentId: agent?.agentId || null,
      candidates: buildRoutingCandidates(settingsSnapshot, claudeResourceState, readinessByAgentId),
      classification,
      globalSlotAvailable: true,
    });
    if (routingResult.selectedAgentId && routingResult.selectedAgentId !== agent?.agentId) {
      skipped.push({
        issue: issue.number,
        statusLabel: issue.statusLabel,
        reason: 'reassignment-candidate',
        agentId: agent?.agentId || null,
        reassignmentCandidate: true,
        routingResult,
        labels: issueLabels(issue),
      });
    } else if (!routingResult.selectedAgentId) {
      skipped.push({
        issue: issue.number,
        statusLabel: issue.statusLabel,
        reason: 'no-qualified-agent',
        agentId: agent?.agentId || null,
        noQualifiedAgent: true,
      });
    }
    // A foundation-only (not-yet-implemented) agent can never itself be
    // `routingResult.selectedAgentId === agent.agentId` here -- it is never
    // eligible -- so no third branch is reachable.
  }

  for (const issue of candidates) {
    const conflictSkip = metadataConflictSkip(issue);
    if (conflictSkip) {
      skipped.push(conflictSkip);
      continue;
    }
    // An issue also visible to reconciliation (it carries a foundation
    // label too) must not execute in this same pass -- see
    // skipIfAmbiguous() above, shared across both scans.
    if (skipIfAmbiguous(issue)) continue;

    const agent = resolveAgentForLabels([...(issue.labels || []), issue.agentLabel]);
    if (agent?.agentId === OLLAMA_AGENT_ID && !settingsSnapshot) {
      skipped.push({
        issue: issue.number,
        statusLabel: issue.statusLabel,
        reason: 'multi-agent-routing-disabled',
        agentId: OLLAMA_AGENT_ID,
      });
      continue;
    }
    if (!agent?.implemented) {
      skipped.push({
        ...unsupportedAgentSkip(agent, { issueNumber: issue.number }),
        statusLabel: issue.statusLabel,
      });
      continue;
    }

    // Issue #50 serial selector: only evaluated when a caller opts in by
    // supplying `settingsSnapshot` (real dispatch always does; the many
    // pre-existing unit tests that call selectIssue() directly do not, and
    // are therefore completely unaffected by this block). Retains an
    // eligible explicit assignment; otherwise routes to a qualified
    // alternative or records why none exists, without guessing, weighting,
    // or randomness -- see agent-runner-routing.mjs for the eligibility
    // rules themselves.
    if (settingsSnapshot) {
      const classification = classifyIssue(issue);
      const routingResult = selectAgentForIssue({
        explicitAgentId: agent.agentId,
        candidates: buildRoutingCandidates(settingsSnapshot, claudeResourceState, readinessByAgentId),
        classification,
        globalSlotAvailable: true,
      });
      if (routingResult.selectedAgentId !== agent.agentId) {
        const explicitDecision = routingResult.decisions.find((decision) => decision.agentId === agent.agentId);
        const isQueuedReady = issue.statusLabel === STATUS_READY;
        if (routingResult.selectedAgentId && isQueuedReady) {
          // A qualified alternative exists for this queued, unclaimed issue
          // -- a reassignment *candidate*, not yet a mutation. main() proves
          // the full queued-only precondition set (lease/PR/recovery/
          // workspace/branch/settings-revision/live-label stability) before
          // any label mutation is attempted.
          skipped.push({
            issue: issue.number,
            statusLabel: issue.statusLabel,
            reason: 'reassignment-candidate',
            agentId: agent.agentId,
            eligibilityReasons: explicitDecision?.reasons || [],
            reassignmentCandidate: true,
            routingResult,
            labels: issueLabels(issue),
          });
        } else {
          skipped.push({
            issue: issue.number,
            statusLabel: issue.statusLabel,
            reason: routingResult.selectedAgentId ? 'agent-not-eligible' : 'no-qualified-agent',
            agentId: agent.agentId,
            eligibilityReasons: explicitDecision?.reasons || [],
            ...(isQueuedReady && !routingResult.selectedAgentId ? { noQualifiedAgent: true } : {}),
          });
        }
        continue;
      }
    }

    // A transient GitHub read failure for one candidate must not crash the
    // whole selection scan — it is task-local to this one issue, and every
    // other ready candidate must still be reachable (#698's governing
    // invariant: a single-issue failure never blocks unrelated eligible
    // work, discovered via the fault-injection harness, finding 10).
    let comments;
    let selection;
    try {
      comments = readIssueComments(args.repo, issue.number, ghRunner);

      selection = resolveIssueSelection(issue, comments, {
        requireManagerPreflight: true,
      });
    } catch (error) {
      skipped.push({ issue: issue.number, statusLabel: issue.statusLabel, reason: 'candidate-read-failed', error: String(error?.message || error) });
      continue;
    }

    if (!selection.mode) {
      const activeBlock = await activeRunBlockForIssue(issue, comments, selection.reason, { state, repo: args.repo, processProbe });
      if (activeBlock) {
        // A claimed or paused task reserves only itself. The scheduler lock
        // prevents concurrent cron workers; a historical GitHub marker must
        // never idle unrelated ready work.
        skipped.push(activeBlock);
        continue;
      }

      const conflicts = issueMetadataConflicts(issue);
      skipped.push({
        issue: issue.number,
        statusLabel: issue.statusLabel,
        reason: selection.reason,
        ...(conflicts.length ? { metadataConflicts: conflicts } : {}),
      });
      continue;
    }

    // Issue #50, requirement 9: an existing packet whose approved_agent
    // does not name the agent this pass actually resolved for the issue
    // fails closed here, before any claim, status mutation, runner-start
    // comment, or worker launch. This only ever fires when settingsSnapshot
    // opted this pass into the new selector; existing callers are
    // unaffected. In real dispatch every packet's approved_agent already
    // matches the sole implemented adapter it names, so this is inert
    // unless a reassignment (or a hand-authored packet) names a different
    // agent than the one this pass would actually select.
    if (settingsSnapshot && !managerAuthorityApprovesAgent(selection.managerAuthority, agent.agentId)) {
      skipped.push({
        issue: issue.number,
        statusLabel: issue.statusLabel,
        reason: 'manager-authority-approved-agent-mismatch',
        agentId: agent.agentId,
        approvedAgent: selection.managerAuthority?.approvedAgent || null,
      });
      continue;
    }

    // #44: profile-aware quota admission against this pass's fresh evidence, opt-in
    // via `quotaAdmissionEvidence` so existing selectIssue() callers are unaffected.
    if (quotaAdmissionEvidence) {
      const executionMeta = parseKeyValueBlock(selection.preflight?.body || '');
      const candidateProfile = inferProfile({
        explicitProfile: executionMeta.profile,
        commandText: selection.preflight?.body || '',
        issue,
      });
      const admission = evaluateProfileQuotaAdmission({
        quotaUsage: quotaAdmissionEvidence.quotaUsage,
        status: quotaAdmissionEvidence.status,
        profileName: candidateProfile,
        env,
      });
      if (!admission.allowed) {
        skipped.push({
          issue: issue.number,
          statusLabel: issue.statusLabel,
          reason: 'profile-quota-headroom-insufficient',
          profile: candidateProfile,
          quotaAdmission: admission,
        });
        continue;
      }
    }
    return {
      issue,
      selection,
      command: selection.command,
      // The exact canonical manager packet selected for this claim.
      // Historical proceed/continue comments are never substituted for this
      // packet or its immutable revision/fingerprint.
      currentPreflight: selection.preflight,
      managerAuthority: selection.managerAuthority,
      skipped,
      blocked: null,
      metadataConflicts: issueMetadataConflicts(issue),
    };
  }
  return { issue: null, selection: null, command: null, currentPreflight: null, managerAuthority: null, skipped, blocked: null };
}

/**
 * The only path allowed to durably apply a successful recovery's
 * `status:blocked` -> `status:in-progress` transition. Mutates GitHub, then
 * re-fetches and proves the exact expected label state before any local
 * completion is recorded — a clean `gh` exit code alone is not proof the
 * mutation applied (#698 finding 4). Returns `{ applied, failureReason }`;
 * callers decide what to persist locally based on that result.
 */
function applySuccessfulRecoveryTransition(args, issue, ghRunner = gh) {
  try {
    restoreIssueAfterSuccessfulRecovery(args, issue, ghRunner);
  } catch (error) {
    return { applied: false, failureReason: 'github-mutation-failed', error };
  }
  let verifyIssue;
  try {
    verifyIssue = readRecoveryIssue(args.repo, issue.number, ghRunner);
  } catch (error) {
    return { applied: false, failureReason: 'post-mutation-verification-unavailable', error };
  }
  const verifyLabels = issueLabels(verifyIssue).filter((label) => label.startsWith('status:'));
  const applied = String(verifyIssue.state || '').toUpperCase() === 'OPEN'
    && verifyLabels.length === 1 && verifyLabels[0] === STATUS_IN_PROGRESS;
  return applied ? { applied: true, failureReason: null } : { applied: false, failureReason: 'post-mutation-verification-failed' };
}

// Bounded transition-mutation cap (#698 finding 6): the live within-pass
// attempt counts as mutation 1; reconciliation permits at most one further
// retry (mutation 2). Beyond that, a row moves to
// operator_attention_required instead of being mutated on every timer tick.
export const MAX_TRANSITION_MUTATION_ATTEMPTS = 2;

/**
 * Reconstruct a `recordRecoveryAttempt()` payload from a persisted SQLite
 * row, with overrides. Used by every follow-up write to an attempt already
 * in flight so pass-through columns (claim id, agent, started_at, ...) stay
 * consistent without re-deriving them at each call site.
 */
function attemptRecordPayload(attempt, overrides = {}) {
  let restrictedEvidence = null;
  try { restrictedEvidence = attempt.payload_json ? JSON.parse(attempt.payload_json) : null; } catch { restrictedEvidence = null; }
  return {
    attemptId: attempt.attempt_id, repo: attempt.repo, project: attempt.project,
    issueNumber: attempt.issue_number, claimId: attempt.claim_id, preflightRevision: attempt.preflight_revision,
    managerPreflightRevision: attempt.manager_preflight_revision, managerPreflightFingerprint: attempt.manager_preflight_fingerprint,
    managerPreflightBodyDigest: attempt.manager_preflight_body_digest, managerAuthorityKey: attempt.manager_authority_key,
    phase: attempt.phase, agent: attempt.agent, model: attempt.model, harness: attempt.harness,
    startedAt: attempt.started_at, finishedAt: attempt.finished_at, outcome: attempt.outcome,
    exitCode: attempt.exit_code, signal: attempt.signal, recoveryEligible: Boolean(attempt.recovery_eligible),
    recoveryAction: attempt.recovery_action, recoveryAttemptCount: attempt.recovery_attempt_count, retryAt: attempt.retry_at,
    checkpointAvailable: Boolean(attempt.checkpoint_available), sessionAvailable: Boolean(attempt.session_available),
    worktreeAvailable: Boolean(attempt.worktree_available), branchAvailable: Boolean(attempt.branch_available), prAvailable: Boolean(attempt.pr_available),
    attentionStatus: attempt.attention_status, attentionDedupeKey: attempt.attention_dedupe_key, lastNotificationAt: attempt.last_notification_at,
    resolutionState: attempt.resolution_state, processId: attempt.process_id, processBootId: attempt.process_boot_id,
    processStartTicks: attempt.process_start_ticks, systemdInvocationId: attempt.systemd_invocation_id,
    stalledPasses: attempt.stalled_passes, attentionDetectedAt: attempt.attention_detected_at,
    claimedRecoveryAction: attempt.claimed_recovery_action,
    restrictedEvidence,
    ...overrides,
  };
}

/**
 * The only path allowed to durably complete a successful recovery. A
 * recovery is successful only once: (1) the attempt row durably records the
 * label mutation as applied (`attention_resolution_pending`), (2) the
 * sanitized resolved GitHub attention marker is durably delivered (created,
 * updated, or proven already-equivalent via dedupe), and only then (3) one
 * atomic transaction verifies the expected state, resolves local attention,
 * marks the attempt `resolved`, and records exactly one `recovery-succeeded`
 * queue event (`completeRecoveryTransitionAtomic`, #698 finding 4). The
 * queue event is deliberately never recorded before delivery succeeds —
 * unlike the prior design, which recorded it unconditionally up front and
 * could duplicate it on every reconciliation retry. A delivery failure at
 * step 2 leaves the attempt at `attention_resolution_pending` — never
 * `resolved` — so a later pass retries only the comment, never the
 * already-applied label mutation.
 */
function completeSuccessfulRecoveryTransition({ state, args, issue, attempt, finishedAt, ghRunner = gh, policyRevision = RECOVERY_POLICY_REVISION, convergedFromPending = false }) {
  const attemptId = attempt.attempt_id;
  if (attempt.resolution_state === 'resolved') return { completed: true };

  if (!state.record('recordRecoveryAttempt', attemptRecordPayload(attempt, {
    finishedAt, outcome: 'completed', resolutionState: 'attention_resolution_pending',
  }))) return { completed: false };

  // A GitHub delivery failure here is task-local, not a scheduler-health
  // problem — it must not be pushed into `state.errors` (which gates
  // systemic-pause checks and would otherwise idle the whole queue over one
  // issue's comment failure). Durability comes from the
  // `attention_resolution_pending` row just persisted above, not from
  // `state.errors`.
  let delivered = false;
  let deliveryError = null;
  try {
    upsertGitHubAttentionComment(args, issue, {
      reason: 'completed', finishedAt, recoveryStatus: 'not_needed',
      nextAction: 'Human review may continue; the issue remains open and in progress.',
      policyRevision,
    }, ghRunner);
    delivered = true;
  } catch (error) {
    deliveryError = String(error?.message || error);
  }
  if (!delivered) return { completed: false, deliveryError };

  const completion = state.invoke('completeRecoveryTransitionAtomic', {
    attemptId, repo: args.repo, issueNumber: issue.number, statusLabel: STATUS_IN_PROGRESS, reason: 'completed',
    payload: { fromStatus: STATUS_BLOCKED, toStatus: STATUS_IN_PROGRESS, issueClosed: false, convergedFromPending, attemptId },
  });
  if (!state.healthy || !completion?.completed) return { completed: false };
  return { completed: true };
}

/**
 * Persist an unresolved attention event for a recovery whose successful
 * child result could not be durably applied to GitHub, and publish/update
 * the sanitized GitHub marker when materially changed. `resolutionState`
 * defaults to the bounded-retry-eligible `transition_uncertain`; callers
 * pass `operator_attention_required` once the bounded mutation cap is
 * reached or the disagreement is ambiguous — that state is deliberately
 * excluded from automatic reconciliation (#698 finding 6).
 */
function recordUnappliedRecoveryTransition({ state, args, issue, attempt, finishedAt, ghRunner = gh, failureReason, policyRevision = RECOVERY_POLICY_REVISION, resolutionState = 'transition_uncertain' }) {
  const bounded = resolutionState === 'operator_attention_required';
  const event = buildAttentionEvent({
    repository: args.repo, project: args.project?.id, issueNumber: issue.number, attemptId: attempt.attempt_id,
    reason: 'unknown_failure', agent: attempt.agent, startedAt: attempt.started_at, finishedAt,
    recoveryStatus: bounded ? 'operator_attention_required' : 'transition_uncertain',
    nextAction: bounded
      ? `A successful recovery result could not be durably applied to GitHub after reaching the bounded mutation-attempt limit (${failureReason}). Automatic retry is exhausted; an operator must confirm current GitHub state and, if still needed, provide a fresh manager recovery authorization.`
      : `A successful recovery result could not be durably applied to GitHub (${failureReason}). The next scheduler pass safely re-checks current GitHub state before retrying; provide a new manager recovery authorization if this persists.`,
    dashboardReference: `issue-${issue.number}`, policyRevision,
  });
  // The resolution-state write must durably succeed before a GitHub
  // attention comment describing that state is ever published — otherwise
  // an operator could see a comment for a state (e.g.
  // operator_attention_required) that was never actually persisted (#698
  // finding 3).
  if (!state.record('recordRecoveryAttempt', attemptRecordPayload(attempt, {
    finishedAt, outcome: 'completed', recoveryEligible: false, recoveryAction: 'attention_required',
    attentionStatus: 'attention_required', attentionDedupeKey: event.dedupeKey, resolutionState,
    restrictedEvidence: { stage: 'transition', failureReason },
  }))) return event;
  const attentionPersisted = state.invoke('upsertAttentionEvent', event);
  if (attentionPersisted?.materiallyChanged) {
    try { upsertGitHubAttentionComment(args, issue, event, ghRunner); }
    catch (error) { state.recordTaskError('transition-failure-attention-comment', error); }
  }
  return event;
}

/**
 * Crash-safe, fully-revalidated convergence for recovery attempts whose
 * successful child result was persisted but whose GitHub status transition
 * never durably completed. For each pending row (`transition_pending`,
 * `transition_uncertain`, or `attention_resolution_pending`):
 *
 *  1. Runs the same full authority revalidation the live recovery path
 *     proves before ever mutating GitHub — current agent ownership, claim
 *     and manager-preflight revision, authorization, handoff, linked PR,
 *     and branch/worktree/process conflicts (#698 finding 5). Stale or
 *     ambiguous authority stops here — even when GitHub already looks
 *     correct — and persists `operator_attention_required` attention
 *     instead of guessing.
 *  2. Re-fetches the live issue. Already `status:in-progress` -> the prior
 *     mutation landed; converge locally without repeating it.
 *  3. `attention_resolution_pending` rows only retry the resolved-comment
 *     delivery; the label mutation is already proven applied and must
 *     never be repeated. GitHub disagreeing here is ambiguous, not a
 *     license to re-mutate.
 *  4. Still `status:blocked` -> retry the mutation, bounded by
 *     `MAX_TRANSITION_MUTATION_ATTEMPTS`; beyond the bound, hand off to an
 *     operator instead of mutating on every timer tick.
 *  5. Anything else (closed, reassigned) -> ambiguous; attention, no
 *     mutation.
 */
export async function reconcilePendingRecoveryTransitions({ state, args, ghRunner = gh, now = () => new Date().toISOString(), dependencies = {} }) {
  const pending = state.invoke('pendingRecoveryTransitions', args.repo) || [];
  if (!state.healthy) return { checked: 0, converged: 0 };
  let converged = 0;
  const skipped = [];
  const revalidateRecovery = dependencies.revalidateRecovery || collectRecoveryRevalidation;
  const processProbe = dependencies.processProbe || probeProcessIdentity;
  for (const attempt of pending) {
    // A transient GitHub read failure for one stuck row must not pause the
    // whole scheduler pass (queue continuity for unrelated issues) — it is
    // simply retried on the next pass, so it is not pushed into
    // `state.errors`, which gates the systemic-pause checks that follow
    // this reconciliation step.
    let issue;
    try {
      issue = readRecoveryIssue(args.repo, attempt.issue_number, ghRunner);
    } catch (error) {
      skipped.push({ attemptId: attempt.attempt_id, issueNumber: attempt.issue_number, reason: String(error?.message || error) });
      continue;
    }
    const finishedAt = attempt.finished_at || now();

    // Uses the dedicated `transition_reconcile` stage (#698 finding 2), not
    // `pre_claim`: `pre_claim`'s `authorizationFresh` key requires the
    // manager authorization to have been created *after* `attempt.finished_at`
    // — correct when claiming a *new* attempt to recover a *prior* failure,
    // but backwards here, since the authorization that permitted *this*
    // (now-completed) attempt necessarily predates its own finish time. That
    // made `evaluateRecoveryRevalidation` fail closed on every real
    // reconciliation pass, forcing every pending row to
    // `operator_attention_required` regardless of actual authority state.
    // `transition_reconcile` drops that key and relies on the already-correct
    // `authorizationCurrent` (exact authorization-ID match) instead. It also
    // does not reuse `pre_transition`'s TRANSITION_REVALIDATION_KEYS, whose
    // lease-matching keys assume a live in-process handoff that cannot hold
    // across a crash/restart. Every other authority fact (ownership,
    // claim/preflight revision, handoff, PR, branch/worktree/process
    // conflicts) is proven identically either way. `claimed_recovery_action`
    // is set once at claim time and never overwritten by later terminal
    // writes (unlike `recovery_action`, which becomes 'none'/
    // 'attention_required' once the attempt finishes) — it is the durable
    // record of which action the current manager authorization actually
    // approved, so authorization-action matching stays correct.
    const revalidation = await revalidateRecoverySafely(revalidateRecovery, {
      stage: 'transition_reconcile', action: attempt.claimed_recovery_action || attempt.recovery_action, attempt,
      args: { ...args, currentQuotaPreflight: dependencies.currentQuotaPreflight }, ghRunner, state,
      processProbe, currentProcessIdentity: dependencies.processIdentity,
      repositoryEvidence: dependencies.repositoryEvidence, checkedAt: now(),
    });
    // The append-only revalidation write must durably succeed before this
    // pass is allowed to mutate GitHub or complete a transition for *any*
    // row — a failed write means the store itself is now unhealthy, and
    // continuing to process further rows against a broken store risks
    // mutating GitHub without a durable evidentiary record (#698 finding 3).
    // `state.healthy` (not just this call's own return value) gates the
    // whole remaining pass, since a store failure is systemic, not specific
    // to this one row.
    if (!persistRecoveryRevalidation(state, attempt, revalidation) || !state.healthy) {
      skipped.push({ attemptId: attempt.attempt_id, issueNumber: attempt.issue_number, reason: 'revalidation-persistence-failed' });
      break;
    }
    if (revalidation.allowed !== true) {
      recordUnappliedRecoveryTransition({
        state, args, issue, attempt, finishedAt, ghRunner,
        failureReason: `stale-recovery-authority: ${(revalidation.failedChecks || []).join(', ') || 'unknown'}`,
        resolutionState: 'operator_attention_required',
      });
      continue;
    }

    const statusLabels = issueLabels(issue).filter((label) => label.startsWith('status:'));
    const issueOpen = String(issue.state || '').toUpperCase() === 'OPEN';
    const alreadyInProgress = issueOpen && statusLabels.length === 1 && statusLabels[0] === STATUS_IN_PROGRESS;
    const stillBlocked = issueOpen && statusLabels.length === 1 && statusLabels[0] === STATUS_BLOCKED;

    if (alreadyInProgress) {
      const result = completeSuccessfulRecoveryTransition({ state, args, issue, attempt, finishedAt, ghRunner, convergedFromPending: true });
      if (result.completed) converged += 1;
      continue;
    }

    if (attempt.resolution_state === 'attention_resolution_pending') {
      // The label mutation is already durably proven applied; GitHub not
      // showing status:in-progress here is a disagreement that must not be
      // resolved by mutating again — an operator must reconcile it.
      recordUnappliedRecoveryTransition({
        state, args, issue, attempt, finishedAt, ghRunner,
        failureReason: 'github-label-state-disagrees-with-durable-local-record',
        resolutionState: 'operator_attention_required',
      });
      continue;
    }

    if (stillBlocked) {
      if ((attempt.transition_mutation_count || 0) >= MAX_TRANSITION_MUTATION_ATTEMPTS) {
        recordUnappliedRecoveryTransition({
          state, args, issue, attempt, finishedAt, ghRunner,
          failureReason: 'bounded-mutation-attempts-exhausted', resolutionState: 'operator_attention_required',
        });
        continue;
      }
      // #698 round 5, finding 2: a real bounded retry schedule, not
      // mutation-count headroom alone — once a prior mutation attempt has
      // persisted a backoff deadline (`retry_reason` set), respect it
      // before attempting another mutation instead of retrying on every
      // single reconciliation pass with no cooldown.
      const scheduledDeadlineMs = Date.parse(attempt.next_retry_at || '');
      if (attempt.retry_reason && Number.isFinite(scheduledDeadlineMs) && Date.parse(now()) < scheduledDeadlineMs) {
        skipped.push({ attemptId: attempt.attempt_id, issueNumber: attempt.issue_number, reason: 'transition-retry-deadline-not-yet-reached' });
        continue;
      }
      // The mutation-count increment must durably succeed before GitHub is
      // ever mutated — otherwise a crash immediately after this GitHub call
      // could repeat the mutation on the next pass without the bounded cap
      // ever advancing (#698 finding 3).
      const nextMutationAttempt = (attempt.transition_mutation_count || 0) + 1;
      const mutationCount = state.invoke('incrementTransitionMutationCount', attempt.attempt_id, {
        nextRetryAt: backoffDeadline(nextMutationAttempt, Date.parse(now())),
        retryAttempt: nextMutationAttempt,
        retryCap: MAX_TRANSITION_MUTATION_ATTEMPTS,
        retryReason: 'transition-mutation-retry',
      });
      if (mutationCount === null || !state.healthy) {
        skipped.push({ attemptId: attempt.attempt_id, issueNumber: attempt.issue_number, reason: 'transition-mutation-count-persistence-failed' });
        break;
      }
      const retry = applySuccessfulRecoveryTransition(args, issue, ghRunner);
      if (retry.applied) {
        const result = completeSuccessfulRecoveryTransition({ state, args, issue, attempt, finishedAt, ghRunner, convergedFromPending: true });
        if (result.completed) converged += 1;
      } else {
        recordUnappliedRecoveryTransition({ state, args, issue, attempt, finishedAt, ghRunner, failureReason: retry.failureReason });
      }
      continue;
    }

    // Ambiguous local/remote disagreement (closed, reassigned) — an
    // operator must resolve; no mutation.
    recordUnappliedRecoveryTransition({
      state, args, issue, attempt, finishedAt, ghRunner,
      failureReason: 'ambiguous-issue-state-during-reconciliation', resolutionState: 'operator_attention_required',
    });
  }
  return { checked: pending.length, converged, skipped };
}

/**
 * Queued-only reassignment (issue #50, requirement 7-9). Every precondition
 * is proven fresh, right now, against real GitHub/SQLite state -- never
 * against the stale signals gathered during selectIssue()'s scan. Any
 * blocker (including a settings-revision or live-label change since
 * planning) fails closed with no mutation and no durable write at all --
 * silence, not a comment, is the correct behaviour for legitimately
 * ambiguous/active work, and it also means repeated reconciliation passes
 * over a currently-blocked candidate never spam duplicate evidence.
 */
export async function attemptQueuedReassignment({ args, state, ghRunner, candidateSkip, settingsSnapshot, snapshotSettings, env }) {
  const issueNumber = candidateSkip.issue;
  let liveIssue;
  let openPullRequests;
  try {
    liveIssue = readRecoveryIssue(args.repo, issueNumber, ghRunner);
    openPullRequests = listOpenPullRequests(args.repo, ghRunner);
  } catch (error) {
    state.recordTaskError('reassignment-precondition-read-failed', error);
    return { applied: false, reason: 'precondition-read-failed' };
  }
  if (!state.healthy) return { applied: false, reason: 'state-unhealthy' };

  const freshSettingsSnapshot = snapshotSettings({ env, agentIds: Object.keys(AGENT_ADAPTERS) });
  const hasHandoff = /^## (?:Manager|Agent) handoff\s*$/im.test((liveIssue.comments || []).map((comment) => comment?.body || '').join('\n'));
  const linkedOpenPrs = findLinkedOpenPullRequests({ issueNumber, pullRequests: openPullRequests });
  const branchConflicts = localRecoveryConflicts(issueNumber, args.project?.localRepoPath, null);
  // Every recovery_attempts row ever written for this exact issue -- not
  // only the currently-active ones (issue #50 review, requirement 6): a
  // terminal attempt just as often leaves preserved recovery artefacts
  // (branch/worktree/checkpoint/session) behind as a still-active one does.
  // `resolution_state = 'resolved'` is the one durable marker that an
  // attempt's recovery/workspace state was actually verified clean
  // (`markResolved()` in claude-runner-state.mjs); any other value --
  // including a missing/unrecognized one -- fails closed as unresolved.
  const attemptsForIssue = (state.invoke('allRows', 'recovery_attempts') || [])
    .filter((row) => row.repo === args.repo && row.issue_number === issueNumber);
  if (!state.healthy) return { applied: false, reason: 'state-unhealthy' };
  const activeRows = attemptsForIssue.filter((row) => !row.finished_at && !row.outcome);
  const unresolvedRows = attemptsForIssue.filter((row) => row.resolution_state !== 'resolved');

  const plan = planReassignment({
    issue: { number: issueNumber, statusLabel: liveIssue.statusLabel },
    currentLabels: liveIssue.labels,
    explicitAgentId: candidateSkip.agentId,
    routingSelection: candidateSkip.routingResult,
    settingsRevisionAtPlanning: settingsSnapshot.revision,
    settingsRevisionNow: freshSettingsSnapshot.revision,
    liveLabelsAtPlanning: candidateSkip.labels || [],
    liveLabelsNow: liveIssue.labels,
    repo: args.repo,
    hasActiveLease: activeRows.length === 0 ? false : true,
    hasUnfinishedAttempt: activeRows.length === 0 ? false : true,
    hasInProgressOwnership: liveIssue.statusLabel === STATUS_IN_PROGRESS,
    hasLinkedOpenPullRequest: linkedOpenPrs.length === 0 ? false : true,
    hasReviewOrRecoveryState: unresolvedRows.length === 0 ? false : true,
    hasHandoffInProgress: hasHandoff,
    hasConflictingBranchOrWorktree: (branchConflicts.noConflictingBranch && branchConflicts.noConflictingWorktree) ? false : true,
    // Preserved recovery artefacts (branch/worktree availability) on an
    // unresolved attempt row -- real durable evidence, not an assumption.
    hasUnresolvedWorkspaceOwnership: unresolvedRows.some((row) => row.worktree_available !== 0 || row.branch_available !== 0),
  });

  if (!plan.allowed) return { applied: false, reason: 'blocked', blockers: plan.blockers };

  // Issue #50 review round 3: a bounded reassignment *intent* is persisted
  // durably BEFORE any GitHub mutation. If this write fails, GitHub is
  // never mutated -- there is nothing to reconcile because nothing
  // happened. `plan.dedupeKey` is deterministic over
  // (repo, issue, fromAgentId, toAgentId, settingsRevision), so a dedupe
  // collision here means either (a) a prior pass already durably completed
  // this exact reassignment (delivery_status 'resolved'), or (b) a prior
  // pass's intent row is still 'mutation-pending' (a crash before the
  // mutation ran, or before this pass's own write) -- case (b) is exactly
  // when it is safe, and necessary, to proceed and (re)attempt the
  // mutation; case (a) must never mutate again.
  const pendingRecord = state.invoke('recordRoutingEvent', {
    repo: args.repo,
    issueNumber,
    eventType: 'reassignment',
    fromAgentId: candidateSkip.agentId,
    toAgentId: plan.replacementAgentId,
    reason: 'explicit-agent-ineligible',
    settingsRevision: freshSettingsSnapshot.revision,
    dedupeKey: plan.dedupeKey,
    payload: { labelMutation: plan.labelMutation },
    deliveryStatus: 'mutation-pending',
  });
  if (!pendingRecord) {
    state.recordTaskError('reassignment-pending-write-failed', new Error('routing-event pending write returned no result'));
    return { applied: false, reason: 'pending-state-write-failed' };
  }
  if (!pendingRecord.inserted && pendingRecord.existing?.delivery_status !== 'mutation-pending') {
    // Already applied/resolved (or evidence-pending) by an earlier pass or
    // the crash-reconciliation sweep -- never mutate again for the same
    // dedupe key.
    return { applied: pendingRecord.existing?.delivery_status !== undefined, reason: 'already-recorded', replacementAgentId: plan.replacementAgentId };
  }

  const result = applyPlannedReassignment({
    plan,
    mutateLabels: ({ removeLabels, addLabels }) => {
      const editArgs = ['issue', 'edit', String(issueNumber), '--repo', args.repo];
      for (const label of removeLabels) editArgs.push('--remove-label', label);
      for (const label of addLabels) editArgs.push('--add-label', label);
      ghRunner(editArgs);
    },
    readLiveIssue: () => readRecoveryIssue(args.repo, issueNumber, ghRunner),
  });

  if (!result.applied) {
    // The row stays 'mutation-pending' -- a transient mutation/verification
    // failure is safe to retry on a later pass (a fresh precondition check
    // will run again from the top); this is not a crash-consistency
    // problem, just an ordinary failure.
    state.recordTaskError('reassignment-mutation-failed', new Error(result.reason || 'unknown'));
    return { applied: false, reason: result.reason || 'unknown', replacementAgentId: plan.replacementAgentId };
  }

  // Issue #50 review, requirement 9: report reassignment complete only
  // after verified labels AND a durable applied state -- comment delivery
  // is tracked and retried separately below, and its outcome never flips
  // `applied` back to false.
  const transitioned = state.invoke('updateRoutingEventDeliveryStatus', { dedupeKey: plan.dedupeKey, deliveryStatus: 'evidence-pending' });
  if (!transitioned?.updated) {
    state.recordTaskError('reassignment-state-transition-failed', new Error('could not durably transition to evidence-pending after a verified label mutation'));
    return { applied: false, reason: 'applied-but-not-durably-recorded', replacementAgentId: plan.replacementAgentId };
  }

  let evidenceDelivered = false;
  try {
    ghRunner(['issue', 'comment', String(issueNumber), '--repo', args.repo, '--body', plan.evidenceCommentBody]);
    state.invoke('updateRoutingEventDeliveryStatus', { dedupeKey: plan.dedupeKey, deliveryStatus: 'resolved' });
    evidenceDelivered = true;
  } catch (error) {
    // Left 'evidence-pending' -- reconcilePendingRoutingEvents() retries
    // delivery only, on a later pass, never re-mutating.
    state.recordTaskError('reassignment-evidence-comment-failed', error);
  }

  return { applied: true, reason: null, replacementAgentId: plan.replacementAgentId, evidenceDelivered };
}

/**
 * No-qualified-agent evidence (issue #50, requirement 10): visible,
 * deduplicated, sanitized, and worker-free. Launches nothing, consumes no
 * manager packet, creates no claim, and never touches active work. This
 * event type never mutates GitHub, so its durable row starts life directly
 * in `evidence-pending` -- dedup on `(repo, issue, settings revision)`
 * means a genuinely new condition inserts exactly one row, but a prior
 * *comment delivery failure* leaves that same row `evidence-pending` so a
 * later reconciliation pass retries delivery instead of silently never
 * trying again (issue #50 review round 3).
 */
export function recordNoQualifiedAgentEvidence({ args, state, ghRunner, candidateSkip, settingsSnapshot }) {
  const dedupeKey = noQualifiedAgentDedupeKey({ repo: args.repo, issueNumber: candidateSkip.issue, settingsRevision: settingsSnapshot.revision });
  const recorded = state.invoke('recordRoutingEvent', {
    repo: args.repo,
    issueNumber: candidateSkip.issue,
    eventType: 'no-qualified-agent',
    reason: 'no-qualified-agent',
    settingsRevision: settingsSnapshot.revision,
    dedupeKey,
    payload: { eligibilityReasons: candidateSkip.eligibilityReasons || [] },
    deliveryStatus: 'evidence-pending',
  });
  if (!recorded) return recorded;
  if (!recorded.inserted && recorded.existing?.delivery_status === 'resolved') return recorded;
  const body = buildNoQualifiedAgentEvidenceCommentBody({ issueNumber: candidateSkip.issue, settingsRevision: settingsSnapshot.revision });
  try {
    ghRunner(['issue', 'comment', String(candidateSkip.issue), '--repo', args.repo, '--body', body]);
    state.invoke('updateRoutingEventDeliveryStatus', { dedupeKey, deliveryStatus: 'resolved' });
  } catch (error) {
    state.recordTaskError('no-qualified-agent-comment-failed', error);
  }
  return recorded;
}

/**
 * Ambiguous-agent-labels evidence (issue #50 review round 3): an issue
 * carrying more than one distinct supported local agent label is never
 * routed to any of them -- this records why, with the same
 * dedupe/evidence-pending-retry semantics as no-qualified-agent evidence.
 */
export function recordAmbiguousAgentLabelsEvidence({ args, state, ghRunner, candidateSkip, settingsSnapshot }) {
  const dedupeKey = ambiguousAgentLabelsDedupeKey({ repo: args.repo, issueNumber: candidateSkip.issue, settingsRevision: settingsSnapshot.revision });
  const recorded = state.invoke('recordRoutingEvent', {
    repo: args.repo,
    issueNumber: candidateSkip.issue,
    eventType: 'ambiguous-agent-labels',
    reason: 'ambiguous-agent-labels',
    settingsRevision: settingsSnapshot.revision,
    dedupeKey,
    payload: { supportedAgentLabels: candidateSkip.supportedAgentLabels || [] },
    deliveryStatus: 'evidence-pending',
  });
  if (!recorded) return recorded;
  if (!recorded.inserted && recorded.existing?.delivery_status === 'resolved') return recorded;
  const body = buildAmbiguousAgentLabelsEvidenceCommentBody({
    issueNumber: candidateSkip.issue, supportedAgentLabels: candidateSkip.supportedAgentLabels || [], settingsRevision: settingsSnapshot.revision,
  });
  try {
    ghRunner(['issue', 'comment', String(candidateSkip.issue), '--repo', args.repo, '--body', body]);
    state.invoke('updateRoutingEventDeliveryStatus', { dedupeKey, deliveryStatus: 'resolved' });
  } catch (error) {
    state.recordTaskError('ambiguous-agent-labels-comment-failed', error);
  }
  return recorded;
}

/**
 * Crash-safe reconciliation for the `routing_events` pending/delivery state
 * machine (issue #50 review round 3). Runs once per execute pass, before
 * fresh selection: a `'mutation-pending'` row is self-healed to
 * `'evidence-pending'` by re-reading the live issue's labels and verifying
 * they already match the persisted plan -- never by re-running the
 * mutation. A `'evidence-pending'` row (mutation done, or never applicable)
 * only ever retries the evidence comment. Any row this pass cannot safely
 * resolve is simply left as-is for the next pass.
 */
export async function reconcilePendingRoutingEvents({ state, args, ghRunner }) {
  if (!state.healthy) return { checked: 0, resolved: 0 };
  const pending = state.invoke('pendingRoutingEvents', args.repo) || [];
  let resolved = 0;
  for (const row of pending) {
    if (!row.issue_number) continue;
    if (row.delivery_status === 'mutation-pending') {
      let payload;
      try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = {}; }
      const labelMutation = payload?.labelMutation;
      if (!labelMutation?.expectedFinalLabels || !labelMutation?.replacementAgentLabel) continue;
      let liveIssue;
      try {
        liveIssue = readRecoveryIssue(args.repo, row.issue_number, ghRunner);
      } catch (error) {
        state.recordTaskError('routing-event-reconcile-read-failed', error);
        continue;
      }
      const verification = verifyLabelMutation({
        liveLabelsAfter: liveIssue.labels || [],
        expectedFinalLabels: labelMutation.expectedFinalLabels,
        replacementAgentLabel: labelMutation.replacementAgentLabel,
      });
      if (verification.ok) {
        // The mutation already landed on GitHub (a crash happened between
        // the gh CLI call succeeding and this row's own transition) --
        // self-heal the durable record without mutating again.
        state.invoke('updateRoutingEventDeliveryStatus', { dedupeKey: row.dedupe_key, deliveryStatus: 'evidence-pending' });
      }
      // Not yet applied: leave 'mutation-pending'. A fresh selectIssue()
      // reconciliation scan will re-flag this issue as a candidate (its
      // live label is unchanged) and attemptQueuedReassignment() will pick
      // up this exact dedupe key and retry the mutation from a fresh
      // precondition check.
      continue;
    }
    if (row.delivery_status === 'evidence-pending') {
      const body = row.event_type === 'no-qualified-agent'
        ? buildNoQualifiedAgentEvidenceCommentBody({ issueNumber: row.issue_number, settingsRevision: row.settings_revision })
        : row.event_type === 'ambiguous-agent-labels'
          ? buildAmbiguousAgentLabelsEvidenceCommentBody({
            issueNumber: row.issue_number,
            supportedAgentLabels: (() => { try { return JSON.parse(row.payload_json || '{}')?.supportedAgentLabels || []; } catch { return []; } })(),
            settingsRevision: row.settings_revision,
          })
          : buildReassignmentEvidenceCommentBody({
            issueNumber: row.issue_number, fromAgentId: row.from_agent_id, toAgentId: row.to_agent_id, reason: row.reason, settingsRevision: row.settings_revision,
          });
      try {
        ghRunner(['issue', 'comment', String(row.issue_number), '--repo', args.repo, '--body', body]);
        state.invoke('updateRoutingEventDeliveryStatus', { dedupeKey: row.dedupe_key, deliveryStatus: 'resolved' });
        resolved += 1;
      } catch (error) {
        state.recordTaskError('routing-event-evidence-delivery-retry-failed', error);
      }
    }
  }
  return { checked: pending.length, resolved };
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const now = dependencies.now || (() => new Date().toISOString());
  const ghRunner = dependencies.ghRunner || gh;
  const args = parseArgs(argv, env);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (rootBlocked(process.getuid?.(), args.allowRoot)) throw new Error('Refusing to run as root. Use the modelspend user crontab.');
  const authEnv = resolveGithubAuthEnv(env, dependencies.tokenResolver || githubTokenFromGh);
  if (!authEnv) throw new Error('Missing GITHUB_TOKEN or GH_TOKEN environment variable, and gh auth token was unavailable');
  if (env === process.env && !process.env.GITHUB_TOKEN && !process.env.GH_TOKEN && authEnv.GH_TOKEN) {
    process.env.GH_TOKEN = authEnv.GH_TOKEN;
  }

  const schedulerStartedAt = args.execute ? null : now();
  const unlock = (dependencies.acquireLock || acquireLock)(args.lockPath);
  const state = createStateRecorder(args, dependencies.openStore || openRunnerStateStore);
  try {
    if (!state.ensureWritable('startup-write-probe')) return emitSystemicStatePause(args, state, 'startup', { now, logger: dependencies.logger }).exitCode;
    const quotaPreflight = runQuotaPreflight(args, authEnv, dependencies.quotaRunner || spawnSync);
    if (!state.record('recordQuotaHistory', { repo: args.repo, quotaPreflight })) {
      return emitSystemicStatePause(args, state, 'quota-history', { now, logger: dependencies.logger }).exitCode;
    }
    // #44: this pass's fresh quota telemetry, shared unchanged by the full-queue
    // gate below and by per-candidate admission inside selectIssue().
    const quotaAdmissionEvidence = quotaAdmissionEvidenceFromPreflight(quotaPreflight);
    // #53 review round 5: exactly one bounded notification-reconciliation
    // budget per execute pass, placed here -- after the current
    // quota_history row is durably recorded, but before the quota-blocked
    // early return below, before the previous pass's still-open
    // `systemic_pause` health condition is resolved, and before
    // process-identity capture (whose failure itself returns early via
    // emitSystemicStatePause). A still-open prior pause and a freshly
    // recorded quota-blocked episode must both be visible to reconciliation
    // before either can be cleared or an early admission failure returns --
    // otherwise a repeatable early fault (e.g. process-identity) resolves
    // and reopens `systemic_pause` every pass without the outbox ever
    // observing it, and every genuinely blocked quota pass returns before a
    // `quota_blocked` intent can be created. This whole block is
    // execute-gated, so a dry-run pass never discovers or delivers here,
    // matching the existing dry-run non-delivery contract. A
    // notification-local fault stays task-local (recorded via
    // state.recordTaskError inside reconcileNotifications) and cannot flip
    // state.healthy; only a genuine durable-state failure does, and that is
    // checked immediately below before admission continues.
    if (args.execute) {
      const reconcileNotificationEvents = dependencies.reconcileNotifications || reconcileNotifications;
      await reconcileNotificationEvents({ state, args, transport: dependencies.notificationTransport, now });
      if (!state.healthy) return emitSystemicStatePause(args, state, 'notification-reconcile', { now, logger: dependencies.logger }).exitCode;

      // #183: refresh the event-scoped attention projection once while the
      // existing scheduler lock is held. This is task-local read/reconcile
      // work: it never changes selection, quota, claims, GitHub state or the
      // scheduler return code, and it remains reachable before the quota-
      // blocked early return. Dashboard/status reads never run it.
      const reconcileAttention = dependencies.reconcileAttention || runAttentionReconciliation;
      const attentionClient = dependencies.attentionClient || new GhCliAttentionReadClient({ env });
      try {
        await reconcileAttention({
          argv: ['--state-db', args.stateDbPath], env,
          config: { githubRepo: args.repo, outputDir: args.outputDir, stateDbPath: args.stateDbPath },
          client: attentionClient, now,
        });
      } catch (error) {
        const safeCode = ['attention-source-changed', 'attention-event-bound-exceeded', 'attention-issue-bound-exceeded']
          .includes(error?.code) ? error.code : 'attention-reconciliation-failed';
        state.recordTaskError('attention-reconciliation-failed', Object.assign(new Error(safeCode), { code: safeCode }));
      }
    }
    // #698 round 5, finding 3: a pass that proves the store writable again
    // is exactly the condition that cleared `systemic_pause` — resolve it
    // here rather than leaving an operator to infer resolution from a
    // latest-N queue-event window. A resolve on an already-resolved (or
    // never-opened) condition is a documented no-op.
    state.record('resolveHealthCondition', { repo: args.repo, conditionType: 'systemic_pause' });
    let processIdentity;
    try {
      // dependencies.captureProcessIdentity lets tests inject a repeatable
      // capture failure (e.g. simulated /proc unavailability) without
      // touching the real filesystem-backed default (#53 review round 5).
      processIdentity = dependencies.processIdentity || (dependencies.captureProcessIdentity || captureProcessIdentity)(process.pid, env);
    } catch (error) {
      state.errors.push({ stage: 'process-identity', message: String(error?.message || error) });
      return emitSystemicStatePause(args, state, 'process-identity', { now, logger: dependencies.logger }).exitCode;
    }

    // Issue #50: one atomic machine-local settings snapshot for this whole
    // pass. Retained through selection and re-read (with an exact-revision
    // match required) immediately before any reassignment mutation or
    // execution claim below. Read unconditionally (cheap, local, no
    // process spawn) so `hasImplementedRoutableAlternative()` below and any
    // later reconciliation pass always have a fresh value to hand -- but see
    // `multiAgentSelectorEngaged` immediately below for what actually gates
    // whether it is *used*.
    const snapshotSettings = dependencies.snapshotAgentSettings || snapshotAgentSettings;
    const settingsSnapshot = snapshotSettings({ env, agentIds: Object.keys(AGENT_ADAPTERS) });
    // Issue #50 review round 3: engagement is decided by exactly one
    // explicit, machine-local flag -- never inferred from whether a
    // settings file happens to exist. `args.multiAgentRoutingEnabled` is
    // `false` by default: the pre-issue-#50 legacy Claude execution path
    // (which never reads this file) runs exactly as it always has, and zero
    // multi-agent reconciliation happens, regardless of `settingsSnapshot`.
    // When the flag is `true`, the selector is engaged unconditionally --
    // including when the settings document is missing, unreadable,
    // malformed, or non-object. `snapshotAgentSettings()`'s uniform
    // fail-closed defaults (no agent id, Claude included, has an implicit
    // permissive fallback) then make every candidate unqualified until a
    // valid document is in place, so "engaged with bad/missing settings"
    // fails closed all the way through selection, reconciliation, attempt
    // creation, claim, GitHub mutation, and worker launch -- never a
    // silent fall-back to the legacy path.
    const multiAgentSelectorEngaged = args.multiAgentRoutingEnabled === true;
    const computeReadiness = dependencies.computeInstanceReadiness || computeInstanceReadiness;
    const readinessByAgentId = multiAgentSelectorEngaged
      ? computeReadinessByAgentId({ computeReadiness, env })
      : {};

    if (
      quotaPreflight.blocked
      && !hasImplementedRoutableAlternative(settingsSnapshot)
      // #44: a flat critical-ceiling block no longer idles the whole queue by itself --
      // only when NO profile is admissible (fails closed on untrustworthy telemetry).
      && !anyProfileQuotaAdmissible({ ...(quotaAdmissionEvidence || {}), env })
    ) {
      // Claude is the only implemented agent in every real deployment
      // today, so a block leaving no profile admissible is structurally a
      // full-queue block, unchanged from before issue #50. A smaller
      // admissible profile instead falls through to per-candidate
      // admission inside selectIssue() rather than idling here (#44).
      const payload = {
        dryRun: !args.execute,
        quotaBlocked: true,
        quotaPreflight,
        selectedIssue: null,
        skipped: [],
        stateDbPath: args.stateDbPath,
        statePersistenceErrors: state.errors,
        taskLocalErrors: state.taskErrors,
      };
      const logPath = writeLog(args.outputDir, payload);
      if (!state.record('recordRunResult', { repo: args.repo, mode: 'quota-blocked', exitCode: 0, logPath, payload })) {
        return emitSystemicStatePause(args, state, 'quota-blocked-result', { now, logger: dependencies.logger }).exitCode;
      }
      console.log(JSON.stringify({ ...payload, quotaPreflight: { ...quotaPreflight, stdout: '<see log>', stderr: '<see log>' }, logPath }, null, 2));
      return 0;
    }
    const claudeResourceState = quotaPreflight.blocked ? { blocked: true, reason: 'claude-quota-blocked' } : null;

    if (args.execute) {
      // Crash-safe convergence for a prior pass's incomplete GitHub status
      // transition. A GitHub read/write hiccup for one stuck row is
      // task-local (recorded, not fatal to this pass); only genuine SQLite
      // unavailability inside the reconciler itself short-circuits it.
      const reconcileTransitions = dependencies.reconcilePendingRecoveryTransitions || reconcilePendingRecoveryTransitions;
      await reconcileTransitions({
        state, args, ghRunner, now,
        dependencies: {
          revalidateRecovery: dependencies.revalidateRecovery,
          processProbe: dependencies.processProbe,
          repositoryEvidence: dependencies.repositoryEvidence,
          processIdentity,
          currentQuotaPreflight: quotaPreflight,
        },
      });
      // Issue #50 review round 3: crash-safe pending/delivery reconciliation
      // for routing evidence -- re-reads live labels for any
      // 'mutation-pending' row and retries delivery for any
      // 'evidence-pending' row, never repeating an already-applied
      // mutation. Only meaningful once the multi-agent selector has ever
      // been engaged (no pending rows exist otherwise), but running it
      // unconditionally when engaged is cheap and self-limiting (an empty
      // `pendingRoutingEvents()` result is a no-op).
      if (multiAgentSelectorEngaged) {
        const reconcileRoutingEvents = dependencies.reconcilePendingRoutingEvents || reconcilePendingRoutingEvents;
        await reconcileRoutingEvents({ state, args, ghRunner });
      }
      // #53 review round 5: notification outbox reconciliation now runs
      // exactly once per execute pass, earlier in this function (before the
      // quota-blocked early return and before `systemic_pause` is resolved
      // for this pass) -- see the single call site above. Do not add a
      // second call here; a duplicate reconciliation is unbounded work
      // relative to the one-budget-per-pass contract those tests assert.
    }

    let recoveryClaim = null;
    let recoveryInvocation = null;
    let recoveryLeaseId = null;
    let recoveryPreLaunch = null;
    const dueRecovery = args.execute ? (state.invoke('dueRecoveryAttempts', args.repo, now()) || [])[0] : null;
    if (!state.healthy) return emitSystemicStatePause(args, state, 'recovery-read', { now, logger: dependencies.logger }).exitCode;
    if (dueRecovery) {
      if (dueRecovery.agent === OLLAMA_AGENT_ID) {
        const denied = {
          allowed: false,
          stage: 'pre_claim',
          failedChecks: ['ollama-recovery-not-qualified'],
          reason: 'ollama-recovery-not-qualified',
        };
        const blocked = blockRecoveryBeforeLaunch(state, args, dueRecovery, denied, now, ghRunner);
        if (!blocked.persisted) return emitSystemicStatePause(args, state, 'ollama-recovery-attention', { now, logger: dependencies.logger }).exitCode;
        const payload = {
          recoveryBlocked: true,
          stage: 'pre_claim',
          issue: dueRecovery.issue_number,
          failedChecks: denied.failedChecks,
          childLaunched: false,
          agentId: OLLAMA_AGENT_ID,
        };
        const logPath = writeLog(args.outputDir, payload);
        if (!state.record('recordRunResult', {
          repo: args.repo,
          issueNumber: dueRecovery.issue_number,
          mode: 'ollama-recovery-not-qualified',
          exitCode: 1,
          logPath,
          payload,
        })) return emitSystemicStatePause(args, state, 'ollama-recovery-result', { now, logger: dependencies.logger }).exitCode;
        console.log(JSON.stringify({ ...payload, logPath }, null, 2));
        return 1;
      }
      const revalidateRecovery = dependencies.revalidateRecovery || collectRecoveryRevalidation;
      const revalidationArgs = { ...args, currentQuotaPreflight: quotaPreflight };
      const preClaimInput = {
        stage: 'pre_claim', action: dueRecovery.recovery_action, attempt: dueRecovery, args: revalidationArgs,
        ghRunner, state, processProbe: dependencies.processProbe || probeProcessIdentity,
        currentProcessIdentity: processIdentity, repositoryEvidence: dependencies.repositoryEvidence, checkedAt: now(),
      };
      const preClaim = await revalidateRecoverySafely(revalidateRecovery, preClaimInput);
      if (!persistRecoveryRevalidation(state, dueRecovery, preClaim)) {
        return emitSystemicStatePause(args, state, 'pre-claim-revalidation-persistence', { now, logger: dependencies.logger }).exitCode;
      }
      if (preClaim.allowed !== true) {
        const blocked = blockRecoveryBeforeLaunch(state, args, dueRecovery, preClaim, now, ghRunner);
        if (!blocked.persisted) return emitSystemicStatePause(args, state, 'pre-claim-recovery-attention', { now, logger: dependencies.logger }).exitCode;
        const payload = { recoveryBlocked: true, stage: 'pre_claim', issue: dueRecovery.issue_number, failedChecks: preClaim.failedChecks, childLaunched: false };
        const logPath = writeLog(args.outputDir, payload);
        if (!state.record('recordRunResult', { repo: args.repo, issueNumber: dueRecovery.issue_number, mode: 'recovery-blocked', exitCode: 1, logPath, payload })) {
          return emitSystemicStatePause(args, state, 'pre-claim-recovery-result', { now, logger: dependencies.logger }).exitCode;
        }
        console.log(JSON.stringify({ ...payload, logPath }, null, 2));
        return 1;
      }
      recoveryLeaseId = dependencies.recoveryLeaseId || randomUUID();
      const recoveryClaimed = state.invoke('claimRecovery', dueRecovery.attempt_id, dueRecovery.recovery_attempt_count, now(), processIdentity, {
        expectedAction: dueRecovery.recovery_action,
        expectedClaimId: dueRecovery.claim_id,
        expectedClaimIdentity: deserializeCommentIdentity(dueRecovery.claim_identity_json || dueRecovery.claim_id, 'due-recovery-claim'),
        expectedPreflightRevision: dueRecovery.preflight_revision,
        expectedPreflightIdentity: deserializeCommentIdentity(dueRecovery.preflight_identity_json || dueRecovery.preflight_revision, 'due-recovery-preflight'),
        authorizationId: preClaim.authorizationId,
        authorizationIdentity: preClaim.authorizationIdentity,
        recoveryLeaseId,
      });
      if (!state.healthy || recoveryClaimed !== true) {
        state.errors.push({ stage: 'recovery-claim', message: 'due recovery could not be claimed atomically' });
        return emitSystemicStatePause(args, state, 'recovery-claim', { now, logger: dependencies.logger }).exitCode;
      }
      recoveryClaim = state.invoke('recoveryAttempt', dueRecovery.attempt_id);
      if (!state.healthy || !recoveryClaim) return emitSystemicStatePause(args, state, 'recovery-claim-readback', { now, logger: dependencies.logger }).exitCode;
      const currentRecoveryIdentity = { ...processIdentity, recoveryLeaseId };
      const preLaunchInput = {
        stage: 'post_claim', action: dueRecovery.recovery_action, attempt: recoveryClaim, args: revalidationArgs,
        ghRunner, state, processProbe: dependencies.processProbe || probeProcessIdentity,
        currentProcessIdentity: currentRecoveryIdentity, repositoryEvidence: dependencies.repositoryEvidence, checkedAt: now(),
      };
      recoveryPreLaunch = await revalidateRecoverySafely(revalidateRecovery, preLaunchInput);
      if (!persistRecoveryRevalidation(state, recoveryClaim, recoveryPreLaunch, recoveryLeaseId)) {
        return emitSystemicStatePause(args, state, 'pre-launch-revalidation-persistence', { now, logger: dependencies.logger }).exitCode;
      }
      const ordinaryInvocation = { command: process.execPath, args: runnerArgs(recoveryClaim.issue_number, args, { attemptId: recoveryClaim.attempt_id, agentId: recoveryClaim.agent }), env: authEnv };
      const restrictedDispatch = buildRestrictedRecoveryDispatch({
        recoveryPreLaunch, issueNumber: recoveryClaim.issue_number, attemptId: recoveryClaim.attempt_id, args, authEnv, dependencies,
      });
      const dispatchRecovery = dependencies.dispatchRecovery || dispatchRecoveryAction;
      const dispatch = dispatchRecovery({
        action: dueRecovery.recovery_action,
        revalidation: recoveryPreLaunch,
        ordinaryInvocation,
        quota: {
          knownResetReached: Boolean(recoveryClaim.retry_at) && Date.parse(now()) >= Date.parse(recoveryClaim.retry_at),
          freshPreflightPassed: quotaPreflight.blocked === false && quotaPreflight.skipped === false,
          managerAuthorizationCurrent: recoveryPreLaunch.evidence?.authorizationCurrent === true,
        },
        nativeResume: restrictedDispatch.nativeResume,
        continuation: restrictedDispatch.continuation,
      });
      if (recoveryPreLaunch.allowed !== true || dispatch.allowed !== true) {
        const denied = recoveryPreLaunch.allowed === true
          ? { stage: 'dispatch', failedChecks: [dispatch.reason], reason: dispatch.reason }
          : recoveryPreLaunch;
        const blocked = blockRecoveryBeforeLaunch(state, args, recoveryClaim, denied, now, ghRunner);
        if (!blocked.persisted) return emitSystemicStatePause(args, state, 'pre-launch-recovery-attention', { now, logger: dependencies.logger }).exitCode;
        const payload = { recoveryBlocked: true, stage: denied.stage, issue: recoveryClaim.issue_number, failedChecks: denied.failedChecks, childLaunched: false };
        const logPath = writeLog(args.outputDir, payload);
        if (!state.record('recordRunResult', { repo: args.repo, issueNumber: recoveryClaim.issue_number, mode: 'recovery-blocked', exitCode: 1, logPath, payload })) {
          return emitSystemicStatePause(args, state, 'pre-launch-recovery-result', { now, logger: dependencies.logger }).exitCode;
        }
        console.log(JSON.stringify({ ...payload, logPath }, null, 2));
        return 1;
      }
      recoveryInvocation = dispatch.invocation;
    }
    const selected = recoveryClaim ? {
      issue: recoveryPreLaunch.issue,
      selection: { mode: 'recovery', command: null, preflight: null }, command: null, currentPreflight: null,
      skipped: [], blocked: null, managerAuthority: null,
    } : await selectIssue(args, ghRunner, {
      state,
      processProbe: dependencies.processProbe || probeProcessIdentity,
      settingsSnapshot: multiAgentSelectorEngaged ? settingsSnapshot : null,
      claudeResourceState,
      readinessByAgentId,
      quotaAdmissionEvidence,
      env,
    });
    const selectedSourceCommentIdentity = selected.command?.sourceCommentIdentity || null;
    const selectedPreflightCommentIdentity = selected.currentPreflight
      ? normalizeCommentIdentity(selected.currentPreflight, { context: 'scheduler-manager-preflight', required: true })
      : null;
    const plan = {
      dryRun: !args.execute,
      agentLabels: args.agentLabels,
      includeInProgress: args.includeInProgress,
      claimOnExecute: args.claimOnExecute,
      quotaPreflight,
      requireManagerPreflight: args.requireManagerPreflight,
      selectedIssue: selected.issue?.number || null,
      selectedStatusLabel: selected.issue?.statusLabel || null,
      // Literal authoritative GitHub execution label (e.g. the raw
      // `agent:codex-claude` alias), distinct from `agent.agentId` below,
      // which is the resolved concrete adapter. Atomic revalidation needs
      // both to compare like-for-like across the selection-time snapshot
      // and the freshly re-read candidate (issue #189).
      selectedAgentLabel: recoveryClaim ? null : executionLabelAuthority(selected.issue || {}).agentLabel,
      selectedMetadataConflicts: selected.metadataConflicts || issueMetadataConflicts(selected.issue),
      agent: recoveryClaim
        ? { agentId: recoveryClaim.agent, agentType: recoveryClaim.harness, implemented: true, model: recoveryClaim.model, effort: null }
        : agentRunMetadata(resolveAgentForLabels([...(selected.issue?.labels || []), selected.issue?.agentLabel]), {}),
      selectionMode: selected.selection?.mode || null,
      selectedCommandKind: selected.command?.kind || null,
      sourceCommentId: selected.command?.sourceCommentId || null,
      sourceCommentIdentity: selectedSourceCommentIdentity,
      sourcePreflightCommentIdentity: selectedPreflightCommentIdentity,
      sourcePreflightRevision: selected.managerAuthority?.revision || null,
      sourcePreflightFingerprint: selected.managerAuthority?.fingerprint || null,
      sourcePreflightBodyDigest: selected.managerAuthority?.packetDigest || null,
      sourcePreflightAuthorityKey: selected.managerAuthority?.authorityKey || null,
      sourcePreflightCommentId: commentRevision(selectedPreflightCommentIdentity),
      activeRunBlock: selected.blocked || null,
      skipped: selected.skipped,
      stateDbPath: args.stateDbPath,
      statePersistenceErrors: state.errors,
    };
    if (!recordSelectionState(state, args, plan)) {
      return emitSystemicStatePause(args, state, 'selection-persistence', { now, logger: dependencies.logger }).exitCode;
    }
    if (!selected.issue) {
      // Issue #50, requirements 7 and 10: at most one queued-only
      // reassignment or no-qualified-agent evidence write per pass, mirroring
      // the single global execution slot -- this is bookkeeping around an
      // empty pass, never itself a claim or a worker launch. Both branches
      // are execute-only: a dry-run pass proves and reports selection state
      // without mutating GitHub, exactly like every other mutation below.
      if (args.execute && state.healthy) {
        const reassignmentCandidate = selected.skipped.find((entry) => entry.reassignmentCandidate);
        const noQualifiedCandidate = !reassignmentCandidate && selected.skipped.find((entry) => entry.noQualifiedAgent);
        const ambiguousCandidate = !reassignmentCandidate && !noQualifiedCandidate && selected.skipped.find((entry) => entry.ambiguousAgentLabels);
        if (reassignmentCandidate) {
          await attemptQueuedReassignment({
            args, state, ghRunner, candidateSkip: reassignmentCandidate, settingsSnapshot,
            snapshotSettings: dependencies.snapshotAgentSettings || snapshotAgentSettings, env,
          });
        } else if (noQualifiedCandidate) {
          recordNoQualifiedAgentEvidence({ args, state, ghRunner, candidateSkip: noQualifiedCandidate, settingsSnapshot });
        } else if (ambiguousCandidate && multiAgentSelectorEngaged) {
          recordAmbiguousAgentLabelsEvidence({ args, state, ghRunner, candidateSkip: ambiguousCandidate, settingsSnapshot });
        }
      }
      const logPath = writeLog(args.outputDir, plan);
      if (!state.record('recordRunResult', { repo: args.repo, mode: 'no-selection', exitCode: 0, logPath, payload: plan })) {
        return emitSystemicStatePause(args, state, 'no-selection-result', { now, logger: dependencies.logger }).exitCode;
      }
      console.log(JSON.stringify({ ...plan, logPath }, null, 2));
      return 0;
    }

    // A selected dry-run is a scheduler inspection, not an implementation
    // attempt. Complete it before constructing an attempt identity, invoking
    // the child, claiming the issue, or entering terminal/recovery policy.
    // Selection and its durable audit record intentionally remain, while all
    // execution-only state machines stay unreachable (#725).
    if (!args.execute) {
      const finishedAt = now();
      const payload = {
        ...plan,
        claim: null,
        executionStatus: 'not_executed',
        startedAt: schedulerStartedAt,
        finishedAt,
        exitCode: 0,
      };
      const logPath = writeLog(args.outputDir, payload);
      if (!state.record('recordRunResult', {
        repo: args.repo,
        issueNumber: selected.issue.number,
        mode: 'scheduler-dry-run',
        exitCode: 0,
        logPath,
        payload,
        startedAt: schedulerStartedAt,
        finishedAt,
      })) return emitSystemicStatePause(args, state, 'dry-run-result-persistence', { now, logger: dependencies.logger }).exitCode;
      console.log(JSON.stringify({ ...payload, logPath }, null, 2));
      return 0;
    }

    const startedAt = now();
    const attemptId = recoveryClaim?.attempt_id || `${args.repo}#${selected.issue.number}:${startedAt}`;
    // New attempts bind to the immutable manager authority key. The source
    // comment identity remains evidence only; it cannot substitute for the
    // manager-owned revision and fingerprint. Historical rows may still carry
    // comment-derived claim ids for recovery compatibility.
    const schedulerClaimIdentity = normalizeCommentIdentity(selected.selection?.preflight);
    const schedulerPreflightIdentity = selectedPreflightCommentIdentity;
    const claimId = recoveryClaim?.claim_id || selected.managerAuthority?.authorityKey || commentRevision(schedulerClaimIdentity);
    const schedulerPreflightRevision = recoveryClaim?.preflight_revision || selected.managerAuthority?.revision || null;
    const schedulerPreflightFingerprint = selected.managerAuthority?.fingerprint || null;
    const schedulerPreflightBodyDigest = selected.managerAuthority?.packetDigest || null;
    const schedulerAuthorityKey = selected.managerAuthority?.authorityKey || null;

    // Workspace ownership must be resolved *before* any irreversible claim
    // consumption (#686): the runner-start marker, the active
    // `recovery_attempts` row, and the status:ready -> status:in-progress
    // label flip all still lie ahead of this point for a fresh (non-
    // recovery) attempt. Every canonical manager-packet dispatch shares this
    // exact boundary. A
    // recovery re-invocation (`recoveryClaim` truthy) already owns its
    // preserved workspace via `prepareContinuationWorkspace()`/
    // `verifyPreservedWorktree()` and is intentionally not re-gated here.
    //
    // Computed once here (rather than inside the claimOnExecute-gated block
    // below) so the same identity also seeds the `recovery_attempts` row's
    // durable `worktreeIdentity` (spec section 5) regardless of the
    // claimOnExecute flag — a future dispatch attributing a conflict to this
    // row must be able to find its exact branch/worktree identity, not just
    // whether this scheduler pass happened to gate on it. It must also be
    // resolved before `resolvedProfile` below (#148): `resolvedProfile` reads
    // `dispatchIdentity`, and both are declared with `const` in this same
    // function scope.
    const dispatchIdentity = !recoveryClaim
      ? resolveImplementationDispatchIdentity({
        issue: selected.issue, command: selected.command, currentPreflight: selected.currentPreflight,
        config: { githubRepo: args.project?.repo, localRepoPath: args.project?.localRepoPath },
        env: authEnv, argsRepo: args.repo,
      })
      : null;
    const freshImplementationDispatch = Boolean(dispatchIdentity?.ok)
      && dispatchIdentity.executionAuthorization.phase === EXECUTION_PHASE_IMPLEMENTATION
      && dispatchIdentity.executionAuthorization.allowed === true;

    // One canonical resolved model for this fresh (non-recovery)
    // implementation attempt (#148): derived exactly once, here, from the
    // same dispatch-authority-verified `profileName`/`executionMeta` the
    // child's own independent `resolveProfile()` call (in
    // `claude-runner.mjs`'s `main()`) derives from -- never inferred from
    // the possibly-modelless `agentRunMetadata(agent, {})` profile
    // `plan.agent` carries for a fresh dispatch (see below). Carried through
    // the dispatch boundary explicitly via `--model` (see `runnerArgs()`) so
    // the child, the restricted-handle capture, and the initial
    // `recovery_attempts` row below can never resolve or persist a
    // different model for the same attempt. Left `null` for every
    // non-implementation dispatch (recovery, plan phase, unauthorized): this
    // issue's forward-fix scope is limited to fresh implementation attempts,
    // and those keep their prior `plan.agent?.model` behavior below.
    const freshAgentId = freshImplementationDispatch ? plan.agent?.agentId : null;
    const freshOllamaDispatch = freshAgentId === OLLAMA_AGENT_ID;
    const resolvedProfile = freshImplementationDispatch && !freshOllamaDispatch
      ? resolveProfile(dispatchIdentity.profileName, {
        model: dispatchIdentity.managerExecutionMeta?.model,
        effort: dispatchIdentity.managerExecutionMeta?.effort,
      }, authEnv)
      : null;
    const resolvedModel = !freshImplementationDispatch
      ? null
      : freshOllamaDispatch
        ? QUALIFIED_OLLAMA_CODING_MODEL
        : (resolvedProfile?.model ?? null);
    const modelResolutionValid = !freshImplementationDispatch
      || (freshOllamaDispatch
        ? dispatchIdentity.managerExecutionMeta?.model === QUALIFIED_OLLAMA_CODING_MODEL
        : isSupportedModelId(resolvedModel));

    // Every invocation — the first attempt and every recovery re-invocation
    // of the same attempt row — passes the same attemptId so the child can
    // write its restricted recovery handle (session id, worktree/branch
    // identity) keyed consistently for a later native_resume/
    // same_agent_continuation to read back (#698 finding 2).
    let nodeArgs = recoveryInvocation?.args
      || runnerArgs(selected.issue.number, args, { attemptId, model: resolvedModel, agentId: plan.agent?.agentId });

    // Issue #50 review, requirement 7: this settings-revision check must run
    // before any new attempt/ownership row, claim, GitHub mutation,
    // runner-start marker, or worker launch -- not merely before the
    // execution claim itself. It is deliberately positioned here, ahead of
    // the dispatch-authority-rejection check and `recordRecoveryAttempt`
    // below, mirroring the same "zero attempts, zero claims, zero
    // mutations on rejection" pattern the dispatch-authority check already
    // demonstrates. A settings change between selection and this point now
    // creates zero attempt rows, not just zero claims. Only enforced when
    // the multi-agent selector was actually engaged this pass (a
    // machine-local settings document was present at selection); when it
    // was not, Claude's eligibility never depended on this file and the
    // pre-issue-#50 legacy execution path is unaffected.
    if (!recoveryClaim && args.claimOnExecute && multiAgentSelectorEngaged) {
      if (!state.healthy) return emitSystemicStatePause(args, state, 'pre-attempt-settings-revision-read', { now, logger: dependencies.logger }).exitCode;
      const preAttemptSettingsSnapshot = (dependencies.snapshotAgentSettings || snapshotAgentSettings)({ env, agentIds: Object.keys(AGENT_ADAPTERS) });
      if (!settingsRevisionUnchanged(settingsSnapshot, preAttemptSettingsSnapshot)) {
        const finishedAt = now();
        const payload = {
          dryRun: false,
          settingsRevisionChanged: true,
          selectedIssue: selected.issue.number,
          stateDbPath: args.stateDbPath,
          statePersistenceErrors: state.errors,
        };
        const logPath = writeLog(args.outputDir, payload);
        state.record('recordQueueEvent', {
          repo: args.repo, eventType: 'settings-revision-changed-before-claim', issueNumber: selected.issue.number, reason: 'settings-revision-changed',
        });
        if (!state.record('recordRunResult', { repo: args.repo, issueNumber: selected.issue.number, mode: 'settings-revision-changed', exitCode: 1, logPath, payload, startedAt, finishedAt })) {
          return emitSystemicStatePause(args, state, 'settings-revision-changed-result', { now, logger: dependencies.logger }).exitCode;
        }
        console.log(JSON.stringify({ ...payload, logPath }, null, 2));
        return 1;
      }
    }

    // Dispatch authority -- the resolved repository, checkout, branch, base
    // commit, manager revision and fingerprint (#56) -- is verified before
    // any claim, attempt, GitHub mutation, workspace mutation, or worker/
    // model launch. Falling through here (as the pre-#56 code did) let a
    // packet whose canonical repository/branch authority failed to resolve
    // still reach `recordRecoveryAttempt`/`claimIssueForExecution` below,
    // exactly the #5-F1 "claim before admission" defect. A rejection here
    // makes zero model calls, creates zero attempts and claims, and mutates
    // neither GitHub nor the workspace -- it only records a local queue
    // event for operator visibility.
    if (!recoveryClaim && dispatchIdentity && dispatchIdentity.ok !== true) {
      const finishedAt = now();
      if (!state.record('recordQueueEvent', {
        repo: args.repo, eventType: 'dispatch-authority-rejected', issueNumber: selected.issue.number,
        statusLabel: selected.issue.statusLabel, reason: dispatchIdentity.failureReason,
        payload: { failureScope: dispatchIdentity.failureScope, failureReason: dispatchIdentity.failureReason },
      })) return emitSystemicStatePause(args, state, 'dispatch-authority-queue-event', { now, logger: dependencies.logger }).exitCode;
      const payload = {
        ...plan,
        claim: null,
        startedAt,
        finishedAt,
        exitCode: 1,
        childLaunched: false,
        markerPosted: false,
        packetConsumed: false,
        attemptCreated: false,
        issueMutation: false,
        workspaceMutation: false,
        failureScope: dispatchIdentity.failureScope,
        terminalOutcome: dispatchIdentity.failureReason,
      };
      const logPath = writeLog(args.outputDir, payload);
      if (!state.record('recordRunResult', {
        repo: args.repo, issueNumber: selected.issue.number, mode: 'dispatch-authority-rejected',
        exitCode: 1, logPath, payload, startedAt, finishedAt,
      })) return emitSystemicStatePause(args, state, 'dispatch-authority-result-persistence', { now, logger: dependencies.logger }).exitCode;
      console.log(JSON.stringify({ ...payload, logPath }, null, 2));
      return 1;
    }

    // #148: a fresh implementation attempt's canonical model must be
    // successfully resolved to one of this runner's bounded supported model
    // identifiers before any attempt row, runner-start marker, claim
    // mutation or child launch. `resolvedProfile`/`resolvedModel` above are
    // only computed for `freshImplementationDispatch`, so this can only
    // trip for that exact case -- a recovery re-invocation, a plan-phase
    // dispatch, or an already-rejected dispatch authority never reach here
    // with `modelResolutionValid === false`. Zero attempts, zero claims,
    // zero GitHub/workspace mutations on rejection, mirroring the
    // dispatch-authority-rejection pattern immediately above.
    if (!recoveryClaim && freshImplementationDispatch && !modelResolutionValid) {
      const finishedAt = now();
      if (!state.record('recordQueueEvent', {
        repo: args.repo, eventType: 'model-resolution-invalid', issueNumber: selected.issue.number,
        statusLabel: selected.issue.statusLabel, reason: 'captured-model-invalid',
        payload: { profileName: dispatchIdentity.profileName },
      })) return emitSystemicStatePause(args, state, 'model-resolution-queue-event', { now, logger: dependencies.logger }).exitCode;
      const payload = {
        ...plan,
        claim: null,
        startedAt,
        finishedAt,
        exitCode: 1,
        childLaunched: false,
        markerPosted: false,
        packetConsumed: false,
        attemptCreated: false,
        issueMutation: false,
        workspaceMutation: false,
        failureScope: 'issue_not_runnable',
        terminalOutcome: 'captured-model-invalid',
      };
      const logPath = writeLog(args.outputDir, payload);
      if (!state.record('recordRunResult', {
        repo: args.repo, issueNumber: selected.issue.number, mode: 'model-resolution-invalid',
        exitCode: 1, logPath, payload, startedAt, finishedAt,
      })) return emitSystemicStatePause(args, state, 'model-resolution-result-persistence', { now, logger: dependencies.logger }).exitCode;
      console.log(JSON.stringify({ ...payload, logPath }, null, 2));
      return 1;
    }

    if (!recoveryClaim && freshImplementationDispatch && freshOllamaDispatch) {
      const ollamaAdmission = await preclaimOllamaAdmission({
        agentId: freshAgentId,
        issue: selected.issue,
        managerComment: selected.currentPreflight,
        managerModel: dispatchIdentity.managerExecutionMeta?.model,
        repo: args.repo,
        env: authEnv,
        execFileFn: dependencies.execFileFn || execFileSync,
        fetchFn: dependencies.fetchFn || fetch,
      });
      if (!ollamaAdmission.allowed) {
        const finishedAt = now();
        const payload = {
          ...plan,
          claim: null,
          startedAt,
          finishedAt,
          exitCode: 1,
          childLaunched: false,
          markerPosted: false,
          packetConsumed: false,
          attemptCreated: false,
          issueMutation: false,
          workspaceMutation: false,
          failureScope: 'machine_profile',
          terminalOutcome: ollamaAdmission.reason,
          ollamaAdmission: {
            allowed: false,
            reason: ollamaAdmission.reason,
          },
        };
        const logPath = writeLog(args.outputDir, payload);
        if (!state.record('recordRunResult', {
          repo: args.repo,
          issueNumber: selected.issue.number,
          mode: 'ollama-preclaim-admission-refused',
          exitCode: 1,
          logPath,
          payload,
          startedAt,
          finishedAt,
        })) return emitSystemicStatePause(args, state, 'ollama-preclaim-admission-result', { now, logger: dependencies.logger }).exitCode;
        console.log(JSON.stringify({ ...payload, logPath }, null, 2));
        return 1;
      }
    }

    if (!recoveryClaim && args.execute && args.claimOnExecute) {
      if (freshImplementationDispatch) {
        if (!state.healthy) return emitSystemicStatePause(args, state, 'pre-claim-workspace-read', { now, logger: dependencies.logger }).exitCode;
        // Every recovery_attempts row for this exact issue -- not only the
        // currently-active ones. A conflicting workspace is just as often
        // left behind by a prior *terminal* (completed/failed) attempt as by
        // a still-active one (the #686 recurrence itself: the failing
        // attempt reaches a terminal outcome, but its branch/worktree is
        // still on disk for the next dispatch to collide with).
        const attemptsForIssue = (state.invoke('allRows', 'recovery_attempts') || [])
          .filter((row) => row.repo === args.repo && row.issue_number === selected.issue.number);
        if (!state.healthy) return emitSystemicStatePause(args, state, 'pre-claim-workspace-attempts-read', { now, logger: dependencies.logger }).exitCode;
        let openPrsForOwnership = [];
        try {
          openPrsForOwnership = listOpenPullRequests(args.repo, ghRunner);
        } catch (error) {
          state.recordTaskError('pre-claim-workspace-pr-read', error);
        }
        const inspectOwnership = dependencies.inspectWorkspaceOwnership || inspectWorkspaceOwnership;
        const ownership = await inspectOwnership({
          worktreeIdentity: dispatchIdentity.worktreeIdentity,
          implementationCheckout: dispatchIdentity.repositoryContext?.implementationCheckout,
          attemptId,
          issueNumber: selected.issue.number,
          activeAttempts: attemptsForIssue,
          pullRequests: openPrsForOwnership,
          processProbe: dependencies.processProbe || probeProcessIdentity,
          env: authEnv,
        });
        if (ownership.allowed !== true) {
          const finishedAt = now();
          const attentionEvent = buildAttentionEvent({
            repository: args.repo, project: args.project?.id, issueNumber: selected.issue.number, attemptId,
            reason: ownership.reason, agent: plan.agent?.agentId, startedAt, finishedAt,
            recoveryStatus: 'forbidden',
            nextAction: WORKSPACE_OWNERSHIP_POLICY[ownership.reason]?.nextAction
              || 'Inspect the sanitized workspace-ownership evidence and provide an explicit manager decision.',
            dashboardReference: `issue-${selected.issue.number}`,
          });
          const failure = {
            ...attentionEvent,
            workerStarted: false,
            executionPhase: dispatchIdentity.executionAuthorization.phase,
            executionAuthorizationAllowed: dispatchIdentity.executionAuthorization.allowed,
            reconciliationSteps: WORKSPACE_OWNERSHIP_POLICY[ownership.reason]?.reconciliationSteps || [],
          };
          if (!state.ensureWritable('pre-claim-workspace-write-probe')) {
            return emitSystemicStatePause(args, state, 'pre-claim-workspace-write', { now, logger: dependencies.logger }).exitCode;
          }
          const failureRecovery = quarantineIssueBeforeClaim(args, selected.issue, failure, ghRunner);
          if (!state.record('recordQueueEvent', {
            repo: args.repo, eventType: 'workspace-ownership-conflict', issueNumber: selected.issue.number,
            statusLabel: STATUS_BLOCKED, reason: ownership.reason, payload: { ownership, failureRecovery },
          })) return emitSystemicStatePause(args, state, 'pre-claim-workspace-queue-event', { now, logger: dependencies.logger }).exitCode;
          const payload = {
            ...plan,
            claim: null,
            startedAt,
            finishedAt,
            exitCode: 1,
            childLaunched: false,
            markerPosted: false,
            packetConsumed: false,
            workspaceOwnership: ownership,
            failureRecovery,
            terminalOutcome: ownership.reason,
          };
          const logPath = writeLog(args.outputDir, payload);
          if (!state.record('recordRunResult', {
            repo: args.repo, issueNumber: selected.issue.number, mode: 'workspace-ownership-blocked',
            exitCode: 1, logPath, payload, startedAt, finishedAt,
          })) return emitSystemicStatePause(args, state, 'pre-claim-workspace-result-persistence', { now, logger: dependencies.logger }).exitCode;
          console.log(JSON.stringify({ ...payload, logPath }, null, 2));
          return 1;
        }
      }
    }

    if (!recoveryClaim) {
      if (!state.record('recordRecoveryAttempt', {
        attemptId, repo: args.repo, project: args.project?.id, issueNumber: selected.issue.number, claimId,
        claimIdentity: schedulerClaimIdentity,
        preflightRevision: schedulerPreflightRevision,
        preflightIdentity: schedulerPreflightIdentity,
        managerPreflightRevision: schedulerPreflightRevision,
        managerPreflightFingerprint: schedulerPreflightFingerprint,
        managerPreflightBodyDigest: schedulerPreflightBodyDigest,
        managerAuthorityKey: schedulerAuthorityKey,
        // `resolvedModel` (resolved exactly once above, from the same
        // dispatch-authority-verified profile/execution metadata the
        // child's own independent profile resolution derives from) is
        // authoritative over `plan.agent?.model` for a fresh implementation
        // dispatch (#148): that `agentRunMetadata(agent, {})` profile
        // carries no model at all for a fresh dispatch, so persisting it
        // here would durably write a `NULL` model even though the
        // attempt's actual dispatched/child model is already known and
        // validated at this exact point. `modelResolutionValid` was already
        // required true (or this dispatch is not a fresh implementation
        // attempt) before this line can be reached, so there is
        // deliberately no `|| plan.agent?.model` fallback on the fresh
        // implementation path -- only a non-implementation dispatch
        // (recovery already returns above; plan-phase/unauthorized) keeps
        // the prior `plan.agent?.model` behavior, which is out of this
        // issue's forward-fix scope.
        phase: 'starting', agent: plan.agent?.agentId,
        model: freshImplementationDispatch ? resolvedModel : (plan.agent?.model || null),
        harness: plan.agent?.agentType,
        startedAt, ...processIdentity, resolutionState: 'active',
      })) return emitSystemicStatePause(args, state, 'attempt-start', { now, logger: dependencies.logger }).exitCode;
      // Durably bind this attempt to the exact deterministic worktree/branch
      // identity it was dispatched against (#686 spec section 5), via the
      // `agent-runner-workspace-identity-store.mjs` wrapper rather than
      // `recordRecoveryAttempt` itself (byte-locked to the ModelSpend
      // import). A future dispatch attributing a workspace conflict to a
      // prior attempt must match this exact identity, never merely the
      // issue number.
      if (freshImplementationDispatch && !state.record('recordWorktreeIdentity', { attemptId, worktreeIdentity: dispatchIdentity.worktreeIdentity })) {
        return emitSystemicStatePause(args, state, 'attempt-worktree-identity', { now, logger: dependencies.logger }).exitCode;
      }
    }
    let claim = null;
    if (args.execute && args.claimOnExecute && !recoveryClaim) {
      if (!state.ensureWritable('pre-issue-mutation-write-probe')) return emitSystemicStatePause(args, state, 'pre-issue-mutation', { now, logger: dependencies.logger }).exitCode;

      // The settings-revision recheck (issue #50, requirement 7) now runs
      // earlier, before any attempt/ownership row was created -- see above.
      claim = claimIssueForExecution(args, selected.issue, selected.selection, ghRunner);
      if (!state.record('recordClaim', { repo: args.repo, issueNumber: selected.issue.number, claim })) {
        return emitSystemicStatePause(args, state, 'claim-persistence', { now, logger: dependencies.logger }).exitCode;
      }
    }
    if (recoveryClaim) {
      const currentAttempt = state.invoke('recoveryAttempt', recoveryClaim.attempt_id);
      if (!state.healthy || !currentAttempt) return emitSystemicStatePause(args, state, 'immediate-pre-launch-attempt-read', { now, logger: dependencies.logger }).exitCode;
      const revalidateRecovery = dependencies.revalidateRecovery || collectRecoveryRevalidation;
      const immediateInput = {
        stage: 'pre_launch', action: recoveryClaim.claimed_recovery_action, attempt: currentAttempt,
        args: { ...args, currentQuotaPreflight: quotaPreflight }, ghRunner, state,
        processProbe: dependencies.processProbe || probeProcessIdentity,
        currentProcessIdentity: { ...processIdentity, recoveryLeaseId },
        repositoryEvidence: dependencies.repositoryEvidence,
        checkedAt: now(),
      };
      const immediate = await revalidateRecoverySafely(revalidateRecovery, immediateInput);
      if (!persistRecoveryRevalidation(state, currentAttempt, immediate, recoveryLeaseId)) {
        return emitSystemicStatePause(args, state, 'immediate-pre-launch-revalidation-persistence', { now, logger: dependencies.logger }).exitCode;
      }
      const immediateRestrictedDispatch = buildRestrictedRecoveryDispatch({
        recoveryPreLaunch: immediate, issueNumber: selected.issue.number, attemptId: recoveryClaim.attempt_id, args, authEnv, dependencies,
      });
      const redispatch = (dependencies.dispatchRecovery || dispatchRecoveryAction)({
        action: recoveryClaim.claimed_recovery_action,
        revalidation: immediate,
        ordinaryInvocation: { command: process.execPath, args: runnerArgs(selected.issue.number, args, { attemptId: recoveryClaim.attempt_id, agentId: recoveryClaim.agent }), env: authEnv },
        quota: {
          knownResetReached: Boolean(currentAttempt.retry_at) && Date.parse(now()) >= Date.parse(currentAttempt.retry_at),
          freshPreflightPassed: quotaPreflight.blocked === false && quotaPreflight.skipped === false,
          managerAuthorizationCurrent: immediate.evidence?.authorizationCurrent === true,
        },
        nativeResume: immediateRestrictedDispatch.nativeResume,
        continuation: immediateRestrictedDispatch.continuation,
      });
      if (immediate.allowed !== true || redispatch.allowed !== true) {
        const denied = immediate.allowed === true
          ? { stage: 'dispatch', failedChecks: [redispatch.reason], reason: redispatch.reason }
          : immediate;
        const blocked = blockRecoveryBeforeLaunch(state, args, currentAttempt, denied, now, ghRunner);
        if (!blocked.persisted) return emitSystemicStatePause(args, state, 'immediate-pre-launch-recovery-attention', { now, logger: dependencies.logger }).exitCode;
        return 1;
      }
      recoveryInvocation = redispatch.invocation;
      nodeArgs = recoveryInvocation.args;
    }
    if (!state.ensureWritable('pre-child-launch-write-probe')) return emitSystemicStatePause(args, state, 'pre-child-launch', { now, logger: dependencies.logger }).exitCode;
    const runChild = dependencies.runChild || runChildWithWatchdog;
    const result = await runChild({
      command: recoveryInvocation?.command || process.execPath,
      commandArgs: nodeArgs,
      options: { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, env: recoveryInvocation?.env || authEnv },
      state,
      args,
      attemptId,
      ghRunner,
      spawnRunner: dependencies.spawnRunner || spawn,
      processProbe: dependencies.processProbe || probeProcessIdentity,
      progressProbe: dependencies.progressProbe || probeProcessProgress,
      now,
      watchdogIntervalMs: dependencies.watchdogIntervalMs || args.watchdogIntervalMs,
      stalledPassLimit: dependencies.stalledPassLimit || args.stalledPassLimit,
    });
    const finishedAt = now();
    const childPayload = parseChildRunnerOutput(result.stdout);
    const childCheck = evaluateChildRunResult({ execute: args.execute, exitCode: result.status, childPayload });
    let effectiveExitCode = childCheck.failed ? 1 : result.status;
    let outcome = deriveTerminalOutcome({ effectiveExitCode, childPayload, childReason: childCheck.reason });
    // The child independently re-derives its own manager-preflight comment
    // id from live GitHub state. Cross-check it against the scheduler's own
    // authoritative revision (captured before the child started) so a
    // preflight edited/replaced mid-run cannot be silently trusted from
    // either side alone (#698 finding 1).
    const expectedPreflightIdentity = recoveryClaim
      ? deserializeCommentIdentity(recoveryClaim.preflight_identity_json || recoveryClaim.preflight_revision, 'expected-manager-preflight')
      : schedulerPreflightIdentity;
    const expectedPreflightRevision = commentRevision(expectedPreflightIdentity);
    const childPreflightIdentity = normalizeCommentIdentity(
      childPayload?.sourcePreflightCommentIdentity || childPayload?.sourcePreflightCommentId,
      { context: 'child-manager-preflight' },
    );
    // When an authoritative expected preflight revision exists, a
    // successful child result must supply a matching, well-formed
    // sourcePreflightCommentId — missing, empty, or unparseable evidence
    // fails closed exactly like a value that disagrees. A completed
    // implementation must never be accepted on absent revision evidence
    // (#698 finding 7 re-review).
    const preflightRevisionDisagreement = Boolean(expectedPreflightIdentity)
      && !sameCommentIdentity(childPreflightIdentity, expectedPreflightIdentity);
    if (preflightRevisionDisagreement && outcome === 'completed') {
      outcome = 'unknown_failure';
      if (effectiveExitCode === 0) effectiveExitCode = 1;
    }
    let recoveryTransition = null;
    if (recoveryClaim && outcome === 'completed') {
      const currentAttempt = state.invoke('recoveryAttempt', recoveryClaim.attempt_id);
      if (!state.healthy || !currentAttempt) return emitSystemicStatePause(args, state, 'pre-transition-attempt-read', { now, logger: dependencies.logger }).exitCode;
      const revalidateRecovery = dependencies.revalidateRecovery || collectRecoveryRevalidation;
      const transitionInput = {
        stage: 'pre_transition', action: recoveryClaim.claimed_recovery_action, attempt: currentAttempt,
        args: { ...args, currentQuotaPreflight: quotaPreflight }, ghRunner, state,
        processProbe: dependencies.processProbe || probeProcessIdentity,
        currentProcessIdentity: { ...processIdentity, recoveryLeaseId },
        repositoryEvidence: dependencies.repositoryEvidence,
        checkedAt: now(),
      };
      recoveryTransition = await revalidateRecoverySafely(revalidateRecovery, transitionInput);
      if (!persistRecoveryRevalidation(state, currentAttempt, recoveryTransition, recoveryLeaseId)) {
        return emitSystemicStatePause(args, state, 'pre-transition-revalidation-persistence', { now, logger: dependencies.logger }).exitCode;
      }
    }
    const activeLeaseRows = state.invoke('activeRecoveryAttempts', args.repo) || [];
    if (!state.healthy) return emitSystemicStatePause(args, state, 'terminal-lease-read', { now, logger: dependencies.logger }).exitCode;
    const childEnded = result.status !== null || Boolean(result.signal) || Boolean(result.error);
    const conflictingLease = activeLeaseRows.some((row) => row.attempt_id !== attemptId && row.issue_number === selected.issue.number);
    const actualAgent = childPayload?.agent?.agentId || childPayload?.agentId || plan.agent?.agentId || null;
    // `expectedModel` (#148) is the same canonical resolved model this exact
    // attempt was claimed/dispatched with -- `resolvedModel` for a fresh
    // implementation attempt (`plan.agent?.model` is always `null` there,
    // since `agentRunMetadata(agent, {})` carries no model), or the
    // recovery-claimed row's already-persisted `model` for a recovery
    // re-invocation. Both the terminal fallback and the profile-compatible
    // recovery-evidence check below must reference this exact same value,
    // never the modelless `plan.agent?.model`.
    const expectedModel = freshImplementationDispatch ? resolvedModel : (recoveryClaim?.model ?? plan.agent?.model ?? null);
    const actualModel = childPayload?.agent?.model || childPayload?.model || expectedModel || null;
    // A fresh implementation dispatch's actualModel must never silently
    // disagree with resolvedModel -- the exact model this attempt was
    // claimed/dispatched with (#148). A child that reports a conflicting
    // model is a conflicting child identity, not a value to trust and
    // persist: it must fail closed to unknown_failure instead.
    const modelIdentityDisagreement = freshImplementationDispatch && resolvedModel != null && actualModel !== resolvedModel;
    if (modelIdentityDisagreement && outcome === 'completed') {
      outcome = 'unknown_failure';
      if (effectiveExitCode === 0) effectiveExitCode = 1;
    }
    const actualHarness = childPayload?.agent?.agentType || childPayload?.agentType || plan.agent?.agentType || null;
    const decision = decideRecovery({
      outcome,
      recoveryAttemptCount: recoveryClaim ? recoveryClaim.recovery_attempt_count + 1 : 0,
      retryAt: childPayload?.quotaPauseState?.pausedUntil || childPayload?.quotaPauseState?.resetAt || null,
      evidence: {
        processOwner: childEnded ? false : null,
        conflictingLease,
        ownershipAmbiguous: !childEnded,
        repositoryMutated: childPayload?.implementationEvidence?.repositoryMutated === false,
        implementationEvidenceValid: childPayload?.implementationEvidence?.valid === true,
        checkpointAvailable: Boolean(childPayload?.checkpointAvailable), sessionAvailable: Boolean(childPayload?.sessionAvailable),
        profileCompatible: Boolean(actualAgent && actualModel && actualHarness && sameAgent(actualAgent, plan.agent?.agentId)
          && actualModel === (freshImplementationDispatch ? resolvedModel : expectedModel) && actualHarness === plan.agent?.agentType),
        sameProfileAvailable: childPayload?.recoveryEvidence?.sameProfileAvailable === true,
        quotaHeadroom: quotaPreflight.blocked === false && quotaPreflight.skipped === false,
        executionPolicyAdmitted: childPayload?.costAdmission?.allowed === true,
        conflictingWorktree: Boolean(childPayload?.worktreeIdentity?.rootPath), conflictingBranch: Boolean(childPayload?.implementationPublication?.branch), conflictingPr: Boolean(childPayload?.implementationPublication?.pullRequest),
        worktreeAvailable: Boolean(childPayload?.worktreeIdentity),
        explicitDeterministicValidationFailure: childPayload?.recoveryEvidence?.deterministicValidationFailure === true,
        policyApproved: childPayload?.recoveryEvidence?.policyApproved === true,
      },
    });
    const transitionBlocked = recoveryClaim && outcome === 'completed' && recoveryTransition?.allowed !== true;
    const terminalReason = transitionBlocked ? 'unknown_failure' : outcome;
    const terminalNextAction = preflightRevisionDisagreement
      ? (!childPreflightIdentity
        ? 'The child result did not provide a matching manager preflight comment id even though one is required. Confirm the current preflight and provide a new manager decision before retrying.'
        : 'The child-observed manager preflight comment disagreed with the scheduler\'s authoritative revision. Confirm the current preflight and provide a new manager decision before retrying.')
      : transitionBlocked
        ? `Successful child result was not applied because recovery authority changed: ${(recoveryTransition.failedChecks || []).join(', ')}.`
        : decision.nextAction;
    // #231: production-lifecycle population of the accepted #230 bounded
    // failure projection for the single site every task-attempt terminal
    // outcome (budget exhaustion, no-change, worker failure, checkpoint
    // preserved, workspace-ownership, unknown) already flows through.
    // Never thrown on: an incomplete/inconsistent mapping degrades to no
    // projection section rather than blocking this attempt's durable write.
    const terminalProjection = outcome === 'completed' && !transitionBlocked ? null : safeDeriveFailureProjection({
      repository: args.repo, project: args.project?.id, issueNumber: selected.issue.number,
      attemptId: attentionProjectionAttemptId(attemptId), agent: actualAgent, model: actualModel,
      policyRevision: decision.policyRevision, managerAuthorityFingerprint: schedulerPreflightFingerprint,
      executionPhase: 'completed',
      candidateAdmissionCompleted: true, attemptCreated: true, managerPacketConsumed: true,
      // At the 'completed' execution phase, workspace preparation is
      // already required to have happened -- `deriveFailureProjection()`
      // refuses an asserted `false` this late. A child that never reported
      // a worktree identity (e.g. it crashed before reporting) is absent
      // *evidence*, not proof preparation never ran, so this stays `null`
      // (unknown) rather than a false assertion.
      workspaceCreated: childPayload?.worktreeIdentity ? true : null, childLaunched: true,
      providerInvocationObserved: childEnded ? 'yes' : 'unknown',
      failureScope: 'task_attempt', reasonDomain: 'terminal_outcome', reason: terminalReason, terminalOutcome: terminalReason,
      checkpointPresent: Boolean(childPayload?.checkpointAvailable),
      worktreePresent: Boolean(childPayload?.worktreeIdentity),
      branchPresent: Boolean(childPayload?.implementationPublication?.branch),
      commitPresent: childPayload?.implementationEvidence?.repositoryMutated ?? null,
      prPresent: Boolean(childPayload?.implementationPublication?.pullRequest),
      hasChanges: childPayload?.implementationEvidence?.repositoryMutated ?? null,
      recoveryStatus: transitionBlocked ? 'forbidden' : decision.status,
      recoveryAction: transitionBlocked ? 'attention_required' : decision.action,
      recoveryEligible: transitionBlocked ? false : Boolean(decision.eligible),
      safeNextAction: terminalNextAction,
      deeperDiagnosticsRequired: terminalReason === 'unknown_failure',
      diagnosticDomain: terminalReason === 'unknown_failure' ? 'terminal_outcome' : null,
    });
    const attentionEvent = outcome === 'completed' && !transitionBlocked ? null : buildAttentionEvent({
      repository: args.repo, project: args.project?.id, issueNumber: selected.issue.number, attemptId,
      reason: terminalReason, agent: actualAgent, startedAt, finishedAt,
      recoveryStatus: transitionBlocked ? 'forbidden' : decision.status,
      nextAction: terminalNextAction,
      projection: terminalProjection,
      dashboardReference: `issue-${selected.issue.number}`, policyRevision: decision.policyRevision,
    });
    if (!state.record('recordRecoveryAttempt', {
      attemptId, repo: args.repo, project: args.project?.id, issueNumber: selected.issue.number, claimId,
      claimIdentity: recoveryClaim
        ? deserializeCommentIdentity(recoveryClaim.claim_identity_json || recoveryClaim.claim_id, 'terminal-recovery-claim')
        : schedulerClaimIdentity,
      preflightRevision: expectedPreflightRevision,
      preflightIdentity: expectedPreflightIdentity,
      phase: childPayload?.executionPhase || null, agent: actualAgent, model: actualModel, harness: actualHarness,
      startedAt, finishedAt, outcome, exitCode: result.status, signal: result.signal,
      recoveryEligible: transitionBlocked ? false : decision.eligible,
      recoveryAction: transitionBlocked ? 'attention_required' : decision.action,
      recoveryAttemptCount: recoveryClaim ? recoveryClaim.recovery_attempt_count : Math.max(0, (decision.recoveryAttemptCount || 0) - (decision.eligible ? 1 : 0)),
      retryAt: decision.retryAt || null,
      // #698 round 5, finding 2: the authoritative retry schedule, gated
      // identically to recoveryEligible/recoveryAction above -- a
      // transition-blocked or ineligible outcome must never carry a
      // schedule that would let the evidence-based classifier treat it as
      // bounded-retry.
      nextRetryAt: (!transitionBlocked && decision.eligible) ? (decision.retryAt || null) : null,
      retryAttempt: decision.recoveryAttemptCount || 0,
      retryCap: recoveryAttemptCapForOutcome(outcome),
      retryReason: (!transitionBlocked && decision.eligible) ? outcome : null,
      checkpointAvailable: Boolean(childPayload?.checkpointAvailable), sessionAvailable: Boolean(childPayload?.sessionAvailable),
      worktreeAvailable: Boolean(childPayload?.worktreeIdentity), branchAvailable: Boolean(childPayload?.implementationPublication?.branch), prAvailable: Boolean(childPayload?.implementationPublication?.pullRequest),
      attentionStatus: attentionEvent ? 'attention_required' : 'none', attentionDedupeKey: attentionEvent?.dedupeKey,
      resolutionState: attentionEvent ? 'unresolved' : recoveryClaim ? 'transition_pending' : 'resolved', ...processIdentity,
      // Persisted to the dedicated write-once restricted_handle_digest
      // column (#698 finding 8) — never overwritten once set, unlike the
      // generic restrictedEvidence/payload_json blob below, which is
      // wholesale replaced on every write.
      restrictedHandleDigest: childPayload?.restrictedHandleBindingDigest || null,
      restrictedEvidence: { exitCode: result.status, signal: result.signal, logPath: childPayload?.logPath || null, restrictedRecoveryHandleDigest: childPayload?.restrictedRecoveryHandleDigest || null },
    })) return emitSystemicStatePause(args, state, 'terminal-outcome-persistence', { now, logger: dependencies.logger }).exitCode;
    let attentionPersistence = null;
    let transitionMutationFailed = false;
    if (attentionEvent) {
      attentionPersistence = state.invoke('upsertAttentionEvent', attentionEvent);
      if (!state.healthy || !attentionPersistence) return emitSystemicStatePause(args, state, 'attention-persistence', { now, logger: dependencies.logger }).exitCode;
    }
    else {
      if (recoveryClaim) {
        if (!state.ensureWritable('pre-successful-recovery-status-write-probe')) {
          return emitSystemicStatePause(args, state, 'pre-successful-recovery-status', { now, logger: dependencies.logger }).exitCode;
        }
        // The attempt row above already persisted resolution_state =
        // 'transition_pending' before this mutation is attempted. A failed
        // mutation, a failed post-mutation verification, or a failed local
        // completion write must never fall through to a successful exit
        // code — the attempt stays transition_pending/transition_uncertain/
        // attention_resolution_pending and this pass returns nonzero (#698
        // finding 4). Re-fetch the row so downstream writes see the exact
        // persisted state, and count this as mutation attempt 1 of the
        // bounded cap (#698 finding 6). Also persists the authoritative
        // backoff deadline for a possible mutation 2 (#698 round 5, finding
        // 2) — this live, within-pass first mutation is never itself
        // deadline-gated, but a future reconciliation-driven retry must be.
        const mutationCount = state.invoke('incrementTransitionMutationCount', attemptId, {
          nextRetryAt: backoffDeadline(1, Date.parse(now())),
          retryAttempt: 1,
          retryCap: MAX_TRANSITION_MUTATION_ATTEMPTS,
          retryReason: 'transition-mutation-retry',
        });
        if (mutationCount === null || !state.healthy) {
          return emitSystemicStatePause(args, state, 'transition-mutation-count-persistence', { now, logger: dependencies.logger }).exitCode;
        }
        const currentAttempt = state.invoke('recoveryAttempt', attemptId) || { ...recoveryClaim, attempt_id: attemptId, finished_at: finishedAt, outcome: 'completed' };
        const transition = applySuccessfulRecoveryTransition(args, selected.issue, ghRunner);
        if (transition.applied) {
          const completion = completeSuccessfulRecoveryTransition({ state, args, issue: selected.issue, attempt: currentAttempt, finishedAt, ghRunner, policyRevision: decision.policyRevision });
          if (!completion.completed) {
            if (!state.healthy) return emitSystemicStatePause(args, state, 'successful-recovery-resolution', { now, logger: dependencies.logger }).exitCode;
            transitionMutationFailed = true;
          }
        } else {
          if (transition.error) state.recordTaskError('successful-recovery-status', transition.error);
          recordUnappliedRecoveryTransition({ state, args, issue: selected.issue, attempt: currentAttempt, finishedAt, ghRunner, failureReason: transition.failureReason, policyRevision: decision.policyRevision });
          transitionMutationFailed = true;
        }
      } else {
        const resolvedAttention = state.invoke('resolveAttentionForAttempt', attemptId, finishedAt);
        if (!state.healthy) return emitSystemicStatePause(args, state, 'attention-resolution-persistence', { now, logger: dependencies.logger }).exitCode;
        if (resolvedAttention > 0) {
          try { upsertGitHubAttentionComment(args, selected.issue, { reason: 'completed', finishedAt, recoveryStatus: 'not_needed', nextAction: 'Human review may continue; the issue remains open.', policyRevision: decision.policyRevision }, ghRunner); }
          catch (error) { state.recordTaskError('attention-resolution-comment', error); }
        }
      }
    }
    // Section 6/8: recovery reporting for a workspace-ownership outcome
    // discovered *inside the child* (the backstop path -- workspace
    // preparation failed after this scheduler's own pre-claim check already
    // passed, e.g. a race between the two) must be built from the same
    // structured, persisted child evidence the pre-claim path uses, never
    // reparsed from the raw preflight comment. Threaded onto the
    // already-built attentionEvent rather than recomputed independently.
    const workspaceFailureDetails = attentionEvent && WORKSPACE_OWNERSHIP_OUTCOMES.includes(outcome) ? {
      ...attentionEvent,
      workerStarted: false,
      executionPhase: childPayload?.executionPhase ?? null,
      executionAuthorizationAllowed: childPayload?.executionAuthorization?.allowed ?? null,
      reconciliationSteps: WORKSPACE_OWNERSHIP_POLICY[outcome]?.reconciliationSteps || [],
    } : attentionEvent;
    let failureRecovery = null;
    if (args.execute && args.claimOnExecute && (claim || recoveryClaim) && effectiveExitCode !== 0) {
      if (outcome === 'quota_paused') {
        let attentionResult = null;
        try { attentionResult = attentionPersistence?.materiallyChanged ? upsertGitHubAttentionComment(args, selected.issue, attentionEvent, ghRunner) : { deduplicated: true }; } catch (error) { attentionResult = { error: String(error?.message || error) }; }
        failureRecovery = { issue: selected.issue.number, reason: outcome, taskPaused: true, statusUpdated: false, attentionResult, queueReleased: true, errors: [] };
      } else if (outcome === 'plan_only_awaiting_approval') {
        failureRecovery = waitForExplicitPlanApproval(args, selected.issue, attentionEvent || { reason: outcome, finishedAt }, ghRunner);
      } else {
        failureRecovery = quarantineIssueAfterFailedRun(args, selected.issue, workspaceFailureDetails || { reason: outcome, finishedAt }, ghRunner);
      }
      const eventType = outcome === 'quota_paused' ? 'pause' : outcome === 'plan_only_awaiting_approval' ? 'approval-wait' : 'quarantine';
      if (!state.record('recordQueueEvent', {
        repo: args.repo,
        eventType,
        issueNumber: selected.issue.number,
        statusLabel: outcome === 'quota_paused' ? STATUS_IN_PROGRESS : STATUS_BLOCKED,
        reason: failureRecovery.reason,
        payload: failureRecovery,
      })) return emitSystemicStatePause(args, state, 'terminal-queue-state', { now, logger: dependencies.logger }).exitCode;
    }
    const payload = {
      ...plan,
      claim,
      // Never the raw exec argv: nodeArgs can carry --resume-session
      // <realSessionId> for a native_resume invocation. Only a positionally
      // redacted preview is safe for this ordinary JSON payload (#698
      // finding 1 re-review).
      runnerArgs: redactExecutableArgs(nodeArgs),
      startedAt,
      finishedAt,
      exitCode: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      childRunFailure: childCheck.failed ? childCheck.reason : null,
      terminalOutcome: outcome,
      recoveryDecision: decision,
      recoveryTransition: recoveryTransition ? { allowed: recoveryTransition.allowed, failedChecks: recoveryTransition.failedChecks, checkedAt: recoveryTransition.checkedAt } : null,
      attentionDedupeKey: attentionEvent?.dedupeKey || null,
      failureRecovery,
      executionPhase: childPayload?.executionPhase || null,
      worktreeIdentity: childPayload?.worktreeIdentity || null,
      implementationEvidence: childPayload?.implementationEvidence || null,
      implementationPublication: childPayload?.implementationPublication || null,
      usageAccounting: childPayload?.usageAccounting || null,
      awaitingPlanApproval: Boolean(childPayload?.awaitingPlanApproval),
      planPath: childPayload?.planPath || null,
    };
    const logPath = writeLog(args.outputDir, payload);
    if (!state.record('recordRunResult', {
      repo: args.repo,
      issueNumber: selected.issue.number,
      mode: 'issue-run',
      exitCode: transitionBlocked || transitionMutationFailed ? 1 : effectiveExitCode,
      signal: result.signal,
      logPath,
      payload,
      startedAt,
      finishedAt,
    })) return emitSystemicStatePause(args, state, 'run-result-persistence', { now, logger: dependencies.logger }).exitCode;
    console.log(JSON.stringify({ ...payload, stdout: '<see log>', stderr: '<see log>', logPath }, null, 2));
    if (transitionBlocked || transitionMutationFailed) return 1;
    return effectiveExitCode === null ? 1 : effectiveExitCode;
  } finally {
    if (args.execute && state.healthy) await reconcileSchedulerAttempts({ state, args, ghRunner, now, processProbe: dependencies.processProbe || probeProcessIdentity });
    state.close();
    unlock();
  }
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], `file://${process.cwd()}/`).href
  : false;

if (invokedAsScript) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
