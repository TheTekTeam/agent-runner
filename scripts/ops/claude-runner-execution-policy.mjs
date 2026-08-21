import { createHash } from 'node:crypto';

import {
  commentRevision,
  normalizeCommentIdentity,
} from './claude-runner-comment-identity.mjs';
import { extendImplementationToolPolicyForCapabilities } from './claude-runner-capability-model.mjs';

export const EXECUTION_PHASE_PLAN = 'plan';
export const EXECUTION_PHASE_IMPLEMENTATION = 'implementation';
export const IMPLEMENTATION_PERMISSION_MODE = 'dontAsk';
export const MINIMUM_IMPLEMENTATION_CLAUDE_VERSION = '2.1.208';
export const MINIMUM_DYNAMIC_SYSTEM_PROMPT_EXCLUSION_VERSION = '2.1.98';

const GENERATED_PREFLIGHT_MARKERS = [
  '_Generated locally by the Dell runner',
  'agent-runner:generated-preflight',
  'claude-runner-generated-preflight',
];

const REQUIRED_IMPLEMENTATION_FLAGS = Object.freeze([
  ['permissionMode', /--permission-mode\b/],
  ['allowedTools', /--allowedTools\b|--allowed-tools\b/],
  ['disallowedTools', /--disallowedTools\b|--disallowed-tools\b/],
  ['tools', /--tools\b/],
  ['worktree', /--worktree\b|(?:^|\s)-w(?:\s|,)/m],
  ['outputFormat', /--output-format\b/],
  ['settingSources', /--setting-sources\b/],
  ['excludeDynamicSystemPromptSections', /--exclude-dynamic-system-prompt-sections\b/],
]);

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function loginForComment(comment) {
  return String(comment?.user?.login || comment?.author?.login || comment?.authorLogin || '').trim();
}

function parseLoginAllowlist(value) {
  return new Set(String(value || '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean));
}

function normalizedPhase(value) {
  const phase = String(value || '').trim().toLowerCase();
  if (['implement', 'implementation', 'execute', 'execution'].includes(phase)) return EXECUTION_PHASE_IMPLEMENTATION;
  if (['plan', 'planning', 'preflight'].includes(phase)) return EXECUTION_PHASE_PLAN;
  return phase || null;
}

export function resolveRequestedExecutionPhase({ metadata = {}, profileName } = {}) {
  const explicitValue = metadata.execution_phase || metadata.runner_phase || metadata.phase;
  const explicitPhase = normalizedPhase(explicitValue);
  if (explicitPhase && ![EXECUTION_PHASE_PLAN, EXECUTION_PHASE_IMPLEMENTATION].includes(explicitPhase)) {
    return {
      phase: null,
      explicit: true,
      reason: 'unsupported-execution-phase',
      requestedValue: explicitValue,
    };
  }
  if (explicitPhase) {
    return { phase: explicitPhase, explicit: true, reason: 'explicit-phase', requestedValue: explicitValue };
  }

  // A current manager preflight is the durable plan for ordinary work. Only
  // critical work defaults to another plan-only review; an authorized comment
  // can still move it to implementation explicitly.
  if (profileName === 'critical') {
    return { phase: EXECUTION_PHASE_PLAN, explicit: false, reason: 'critical-profile-default', requestedValue: null };
  }
  return { phase: EXECUTION_PHASE_IMPLEMENTATION, explicit: false, reason: 'approved-preflight-default', requestedValue: null };
}

export function isGeneratedManagerPreflight(preflight) {
  const body = String(preflight?.body || '');
  return GENERATED_PREFLIGHT_MARKERS.some((marker) => body.includes(marker));
}

/**
 * Two independent gates authorize unattended writes:
 * 1. machine-local implementation opt-in; and
 * 2. a current manager preflight/command authored by a machine-local
 *    allowlisted GitHub login.
 *
 * Issue text may select plan vs implementation, but it cannot change the
 * permission mode, tool policy, approver list, or worktree requirement.
 */
export function evaluateExecutionAuthorization({
  command = null,
  currentPreflight = null,
  metadata = {},
  profileName,
  env = process.env,
} = {}) {
  const sourcePreflightCommentIdentity = normalizeCommentIdentity(currentPreflight);
  const phaseDecision = resolveRequestedExecutionPhase({ metadata, profileName });
  const violations = [];
  if (!phaseDecision.phase) violations.push(phaseDecision.reason || 'unsupported-execution-phase');

  const expectedPermissionMode = phaseDecision.phase === EXECUTION_PHASE_IMPLEMENTATION
    ? IMPLEMENTATION_PERMISSION_MODE
    : EXECUTION_PHASE_PLAN;
  const requestedPermissionMode = String(metadata.permission_mode || '').trim();
  if (requestedPermissionMode && requestedPermissionMode !== expectedPermissionMode) {
    violations.push('comment-cannot-override-permission-mode');
  }

  const approvers = parseLoginAllowlist(env.CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS);
  const preflightAuthor = loginForComment(currentPreflight);
  const commandAuthor = loginForComment(command);
  if (approvers.size === 0) {
    violations.push('manager-approver-allowlist-empty');
  }
  if (!currentPreflight) {
    violations.push('current-manager-preflight-required');
  } else if (!preflightAuthor || !approvers.has(preflightAuthor.toLowerCase())) {
    violations.push('manager-preflight-author-not-allowlisted');
  }
  if (command && (!commandAuthor || !approvers.has(commandAuthor.toLowerCase()))) {
    violations.push('command-author-not-allowlisted');
  }

  if (phaseDecision.phase === EXECUTION_PHASE_IMPLEMENTATION) {
    if (!truthy(env.CLAUDE_RUNNER_ALLOW_IMPLEMENTATION)) {
      violations.push('implementation-requires-machine-opt-in');
    }
    if (isGeneratedManagerPreflight(currentPreflight)) {
      violations.push('runner-generated-manager-preflight-prohibited');
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
    phase: phaseDecision.phase,
    phaseReason: phaseDecision.reason,
    phaseExplicit: phaseDecision.explicit,
    permissionMode: expectedPermissionMode,
    sourcePreflightCommentIdentity,
    sourcePreflightRevision: commentRevision(sourcePreflightCommentIdentity),
    sourcePreflightCommentId: commentRevision(sourcePreflightCommentIdentity),
    preflightApprover: loginForComment(currentPreflight) || null,
    commandApprover: loginForComment(command) || null,
    machinePolicy: {
      implementationEnabled: truthy(env.CLAUDE_RUNNER_ALLOW_IMPLEMENTATION),
      approverAllowlistConfigured: parseLoginAllowlist(env.CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS).size > 0,
    },
  };
}

function sanitizeWorktreePart(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'unknown';
}

/**
 * `approvedBranch` (#56) is the exact, byte-for-byte manager-authorised Git
 * branch resolved by `resolveDispatchAuthority`. When present it replaces
 * the generated `worktree-<name>` scheme as the branch this dispatch
 * checks out, commits, pushes, and publishes a PR from -- the deterministic
 * `name` below still seeds the *worktree directory* only, so a filesystem
 * naming choice can never substitute for or alter the authorised Git
 * branch.
 */
export function buildWorktreeIdentity({ issueNumber, sourceCommentId, approvedBranch = null } = {}) {
  const issue = Number.parseInt(issueNumber, 10);
  if (!Number.isInteger(issue) || issue <= 0) throw new Error('A positive issue number is required for an implementation worktree');
  const source = sanitizeWorktreePart(sourceCommentId);
  const name = `agent-runner-${issue}-${source}`.slice(0, 80).replace(/-+$/g, '');
  return {
    name,
    expectedBranch: approvedBranch || `worktree-${name}`,
  };
}

export function buildImplementationToolPolicy({ expectedBranch, approvedBranch = null, requiredCapabilities = [] } = {}) {
  const branch = String(expectedBranch || '').trim();
  const isApprovedBranch = Boolean(approvedBranch) && branch === approvedBranch;
  if (!isApprovedBranch && !/^worktree-agent-runner-[a-z0-9-]+$/.test(branch)) {
    throw new Error('A valid runner-owned worktree branch is required for implementation tooling');
  }

  const allowedTools = [
    'Read',
    'Glob',
    'Grep',
    'Edit',
    'Write',
    'Bash(git status)',
    'Bash(git status *)',
    'Bash(git diff)',
    'Bash(git diff *)',
    'Bash(git log)',
    'Bash(git log *)',
    'Bash(git show *)',
    'Bash(git rev-parse *)',
    'Bash(git add *)',
    'Bash(git commit --no-verify *)',
    'Bash(git mv *)',
    'Bash(git rm *)',
    'Bash(git diff --check)',
    'Bash(git diff --check *)',
    'Bash(node --check *)',
    'Bash(node --test *)',
    'Bash(npm test)',
    'Bash(npm test *)',
    'Bash(npm run build)',
    'Bash(npm run build *)',
    'Bash(npm run lint)',
    'Bash(npm run lint *)',
    'Bash(npm run validate:quick:plan)',
    'Bash(npm run validate:quick:plan *)',
    'Bash(npm run validate:quick)',
    'Bash(npm run validate:quick *)',
    'Bash(npm run validate:thorough)',
    'Bash(npm run validate:thorough *)',
    'Bash(pnpm --filter * build *)',
    'Bash(pnpm --filter * test *)',
    'Bash(pnpm --filter * lint *)',
  ];
  const disallowedTools = [
    'Agent',
    'WebFetch',
    'WebSearch',
    'mcp__*',
    'Bash(git push *)',
    'Bash(gh *)',
    'Bash(git reset --hard *)',
    'Bash(git clean *)',
    'Bash(rm *)',
    'Bash(sudo *)',
    'Bash(curl *)',
    'Bash(wget *)',
  ];

  const basePolicy = {
    tools: 'Read,Glob,Grep,Edit,Write,Bash',
    allowedTools,
    disallowedTools,
    strictMcpConfig: true,
    disableSlashCommands: true,
    settings: JSON.stringify({
      permissions: {
        disableBypassPermissionsMode: 'disable',
        disableAutoMode: 'disable',
      },
    }),
    settingSources: '',
    allowedToolRuleCount: allowedTools.length,
    disallowedToolRuleCount: disallowedTools.length,
  };

  return extendImplementationToolPolicyForCapabilities(basePolicy, requiredCapabilities);
}

export function inspectClaudeCliHelp(helpText = '', { exitCode = 0 } = {}) {
  const text = String(helpText || '');
  const missing = REQUIRED_IMPLEMENTATION_FLAGS
    .filter(([, pattern]) => !pattern.test(text))
    .map(([name]) => name);
  if (!/dontAsk\b/.test(text)) missing.push('permissionMode:dontAsk');
  return {
    compatible: exitCode === 0 && missing.length === 0,
    missing,
    helpExitCode: exitCode,
  };
}

function parseSemanticVersion(value = '') {
  const match = String(value).match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+])/i);
  return match ? match.slice(1, 4).map((part) => Number.parseInt(part, 10)) : null;
}

function compareSemanticVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/**
 * `claude --help` is intentionally not exhaustive, so implementation
 * admission is based on a known-safe minimum CLI version. The cache-stability
 * flag was introduced in 2.1.98; the implementation minimum (2.1.208) is
 * newer, so every version admitted for implementation supports that syntax.
 * The help inspection remains a second positive diagnostic when the current
 * CLI lists the flag explicitly.
 */
export function inspectClaudeCliVersion(versionText = '', { exitCode = 0, minimumVersion = MINIMUM_IMPLEMENTATION_CLAUDE_VERSION } = {}) {
  const installedParts = parseSemanticVersion(versionText);
  const minimumParts = parseSemanticVersion(minimumVersion);
  const dynamicExclusionMinimumParts = parseSemanticVersion(MINIMUM_DYNAMIC_SYSTEM_PROMPT_EXCLUSION_VERSION);
  const installedVersion = installedParts ? installedParts.join('.') : null;
  const compatible = exitCode === 0
    && Boolean(installedParts)
    && Boolean(minimumParts)
    && compareSemanticVersions(installedParts, minimumParts) >= 0;
  const dynamicSystemPromptExclusionSupported = exitCode === 0
    && Boolean(installedParts)
    && Boolean(dynamicExclusionMinimumParts)
    && compareSemanticVersions(installedParts, dynamicExclusionMinimumParts) >= 0;
  return {
    compatible,
    installedVersion,
    minimumVersion,
    dynamicSystemPromptExclusionSupported,
    versionExitCode: exitCode,
    failureReason: compatible
      ? null
      : (installedParts ? 'claude-version-too-old' : 'claude-version-unavailable'),
  };
}

export function fingerprintGitStatus(statusText = '') {
  const value = String(statusText || '');
  return {
    dirtyEntryCount: value.split(/\r?\n/).filter(Boolean).length,
    statusFingerprint: createHash('sha256').update(value).digest('hex'),
  };
}

export function evaluateImplementationEvidence({
  baseHead,
  rootBefore,
  rootAfter,
  worktree = null,
  expectedBranch,
} = {}) {
  if (!rootBefore || !rootAfter) {
    return { valid: false, changed: false, failureReason: 'runner-checkout-evidence-unavailable' };
  }
  if (rootBefore.head !== rootAfter.head
    || rootBefore.branch !== rootAfter.branch
    || rootBefore.statusFingerprint !== rootAfter.statusFingerprint) {
    return { valid: false, changed: false, failureReason: 'runner-checkout-mutated' };
  }
  if (!worktree) {
    return { valid: false, changed: false, failureReason: 'implementation-worktree-missing' };
  }
  if (worktree.branch !== expectedBranch) {
    return { valid: false, changed: false, failureReason: 'implementation-worktree-ownership-mismatch' };
  }
  const committed = Boolean(worktree.head && baseHead && worktree.head !== baseHead);
  const dirty = Number(worktree.dirtyEntryCount || 0) > 0;
  let failureReason = null;
  if (!committed && !dirty) failureReason = 'implementation-no-repository-change';
  else if (!committed) failureReason = 'implementation-uncommitted-changes';
  else if (dirty) failureReason = 'implementation-worktree-dirty';
  return {
    valid: failureReason === null,
    changed: committed || dirty,
    committed,
    clean: !dirty,
    failureReason,
  };
}