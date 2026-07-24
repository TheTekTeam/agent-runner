#!/usr/bin/env node

// Queued-only reassignment planning and mutation (issue #50).
//
// Every precondition/plan/verify function here is pure: it takes the
// caller's already-gathered signals (an issue's live labels, a settings
// revision pair, and a set of boolean guards proving the absence of active
// or preserved work) and returns a decision. `claude-runner-cron.mjs` is
// the only place that gathers real GitHub/SQLite state and calls in --
// tests inject the same shape directly. `applyPlannedReassignment()` is the
// single function that performs IO, and it does so only through injected
// `mutateLabels`/`readLiveIssue` functions, mirroring the
// `evaluateClaimEligibility({ onEligible, onIneligible })` injection
// pattern already used by agent-runner-control-instances.mjs.

import { allAgentLabels, resolveAgentById } from './agent-runner-agents.mjs';

export const ROUTING_ATTENTION_MARKER = '<!-- agent-runner:routing-attention:v1 -->';

const REQUIRED_ABSENT_GUARDS = Object.freeze([
  ['hasActiveLease', 'active-lease'],
  ['hasUnfinishedAttempt', 'unfinished-attempt'],
  ['hasInProgressOwnership', 'in-progress-ownership'],
  ['hasLinkedOpenPullRequest', 'linked-open-pull-request'],
  ['hasReviewOrRecoveryState', 'review-or-recovery-state'],
  ['hasHandoffInProgress', 'handoff-in-progress'],
  ['hasConflictingBranchOrWorktree', 'conflicting-branch-or-worktree'],
  ['hasUnresolvedWorkspaceOwnership', 'unresolved-workspace-ownership'],
]);

function labelName(label) {
  return typeof label === 'string' ? label : String(label?.name || '').trim();
}

function labelNameSet(labels = []) {
  return new Set(labels.map(labelName).filter(Boolean));
}

function sortedLabelNames(labels = []) {
  return [...labelNameSet(labels)].sort();
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Every negative guard must be proven `=== false` explicitly; `undefined`,
 * `null`, or `true` all fail closed as "not proven absent" -- issue #50
 * requires that any ambiguity block the reassignment rather than proceed.
 * The queued-status check and the settings-revision/live-label stability
 * checks follow the same fail-closed rule.
 */
export function evaluateReassignmentPreconditions({
  issue,
  settingsRevisionAtPlanning = null,
  settingsRevisionNow = null,
  liveLabelsAtPlanning = [],
  liveLabelsNow = [],
  ...guards
} = {}) {
  const blockers = [];

  if (issue?.statusLabel !== 'status:ready') blockers.push('not-queued-ready');

  for (const [guardName, blockerReason] of REQUIRED_ABSENT_GUARDS) {
    if (guards[guardName] !== false) blockers.push(blockerReason);
  }

  if (!settingsRevisionAtPlanning || !settingsRevisionNow || settingsRevisionAtPlanning !== settingsRevisionNow) {
    blockers.push('settings-revision-changed');
  }

  if (!arraysEqual(sortedLabelNames(liveLabelsAtPlanning), sortedLabelNames(liveLabelsNow))) {
    blockers.push('live-labels-changed');
  }

  return { allowed: blockers.length === 0, blockers };
}

/**
 * Compute the exact label mutation: remove every currently-present
 * supported `agent:*` label, add exactly the one replacement label, and
 * leave every unrelated label untouched. `includeFuture: true` so a
 * not-yet-implemented adapter's label is still recognized and removed
 * (never left behind as a stale second "supported" label).
 */
export function planLabelMutation({ currentLabels = [], replacementAgentLabel } = {}) {
  const supported = new Set(allAgentLabels({ includeFuture: true }));
  const names = [...labelNameSet(currentLabels)];
  const removeLabels = names.filter((name) => supported.has(name));
  const unrelated = names.filter((name) => !supported.has(name));
  const expectedFinalLabels = [...new Set([...unrelated, replacementAgentLabel])].sort();
  return { removeLabels, addLabels: [replacementAgentLabel], expectedFinalLabels, replacementAgentLabel };
}

/**
 * Re-read the live issue after mutation and prove exactly one supported
 * agent label remains and it is the selected replacement, and that every
 * unrelated label from the plan is still present. A clean `gh` exit code is
 * not accepted as proof on its own -- this is the actual proof.
 */
export function verifyLabelMutation({ liveLabelsAfter = [], expectedFinalLabels = [], replacementAgentLabel } = {}) {
  const supported = new Set(allAgentLabels({ includeFuture: true }));
  const names = sortedLabelNames(liveLabelsAfter);
  const supportedPresent = names.filter((name) => supported.has(name));
  const labelsMatch = arraysEqual(names, [...expectedFinalLabels].sort());
  const exactlyOneReplacement = supportedPresent.length === 1 && supportedPresent[0] === replacementAgentLabel;
  const ok = labelsMatch && exactlyOneReplacement;
  return { ok, reason: ok ? null : 'post-mutation-label-mismatch', liveLabels: names, supportedPresent };
}

/** The status label is never part of a reassignment mutation; this proves the caller kept it that way. */
export function statusLabelUnchanged({ statusLabelBefore, statusLabelAfter }) {
  return statusLabelBefore === statusLabelAfter;
}

/**
 * The catalogue-canonical `agent:*` label for a given agent id: the exact
 * `agent:<agentId>` form when the adapter carries it (claude-code-cli,
 * codex-cli, grok-cli all do), otherwise the adapter's first registered
 * label (ollama-agent's sole label is `agent:ollama`, not
 * `agent:ollama-agent`).
 */
export function resolveReplacementAgentLabel(agentId) {
  const adapter = resolveAgentById(agentId);
  if (!adapter?.labels?.length) return null;
  return adapter.labels.find((label) => label === `agent:${agentId}`) || adapter.labels[0];
}

export function reassignmentDedupeKey({ repo, issueNumber, fromAgentId, toAgentId, settingsRevision }) {
  return `${repo}:${issueNumber}:reassignment:${fromAgentId || 'none'}:${toAgentId}:${settingsRevision}`;
}

export function noQualifiedAgentDedupeKey({ repo, issueNumber, settingsRevision }) {
  return `${repo}:${issueNumber}:no-qualified-agent:${settingsRevision}`;
}

/**
 * The reassignment evidence comment is a sanitized, non-authority marker --
 * distinct from `MANAGER_PREFLIGHT_MARKER` and never matching the manager
 * preflight revocation heading pattern (`## Manager/ChatGPT preflight ...
 * stale/invalid/revoked/superseded`). It records the previous/replacement
 * agent and the settings revision only; it never carries settings, prompts,
 * provider text, paths, or secrets.
 */
export function buildReassignmentEvidenceCommentBody({ issueNumber, fromAgentId, toAgentId, reason, settingsRevision }) {
  return [
    ROUTING_ATTENTION_MARKER,
    '',
    '## Routing attention — queued reassignment',
    '',
    `Issue: #${issueNumber}`,
    `Previous agent: ${fromAgentId || 'none'}`,
    `Replacement agent: ${toAgentId}`,
    `Reason: ${reason}`,
    `Settings revision at reassignment: ${settingsRevision}`,
    '',
    'This issue is not executable until a fresh ChatGPT manager packet whose `approved_agent` matches the replacement agent is posted. The runner does not create, edit, refresh, or revoke manager preflight authority.',
  ].join('\n');
}

export function buildNoQualifiedAgentEvidenceCommentBody({ issueNumber, reason = 'no-qualified-agent', settingsRevision }) {
  return [
    ROUTING_ATTENTION_MARKER,
    '',
    '## Routing attention — no qualified agent',
    '',
    `Issue: #${issueNumber}`,
    `Reason: ${reason}`,
    `Settings revision: ${settingsRevision}`,
    '',
    'No enabled, implemented, and qualified agent is currently eligible for this queued issue. No worker was launched, no manager packet was consumed, and no claim was created.',
  ].join('\n');
}

/**
 * Pure orchestrator: given the precondition guards and an already-computed
 * routing selection (`agent-runner-routing.mjs#selectAgentForIssue()`),
 * decide whether a reassignment is permitted and, if so, produce its full
 * label-mutation plan and evidence. Performs no IO.
 */
export function planReassignment({
  issue,
  currentLabels = [],
  explicitAgentId = null,
  routingSelection,
  settingsRevisionAtPlanning = null,
  settingsRevisionNow = null,
  liveLabelsAtPlanning = currentLabels,
  liveLabelsNow = currentLabels,
  repo,
  ...guards
} = {}) {
  const preconditions = evaluateReassignmentPreconditions({
    issue,
    settingsRevisionAtPlanning,
    settingsRevisionNow,
    liveLabelsAtPlanning,
    liveLabelsNow,
    ...guards,
  });

  if (!preconditions.allowed) {
    return { allowed: false, blockers: preconditions.blockers, replacementAgentId: null, labelMutation: null, evidenceCommentBody: null, dedupeKey: null };
  }

  if (!routingSelection || !routingSelection.selectedAgentId || routingSelection.selectedAgentId === explicitAgentId) {
    return { allowed: false, blockers: ['no-reassignment-candidate'], replacementAgentId: null, labelMutation: null, evidenceCommentBody: null, dedupeKey: null };
  }

  const replacementAgentId = routingSelection.selectedAgentId;
  const replacementLabel = resolveReplacementAgentLabel(replacementAgentId);
  if (!replacementLabel) {
    return { allowed: false, blockers: ['replacement-agent-label-unresolved'], replacementAgentId: null, labelMutation: null, evidenceCommentBody: null, dedupeKey: null };
  }

  const labelMutation = planLabelMutation({ currentLabels, replacementAgentLabel: replacementLabel });
  const evidenceCommentBody = buildReassignmentEvidenceCommentBody({
    issueNumber: issue?.number,
    fromAgentId: explicitAgentId,
    toAgentId: replacementAgentId,
    reason: 'explicit-agent-ineligible',
    settingsRevision: settingsRevisionNow,
  });
  const dedupeKey = reassignmentDedupeKey({ repo, issueNumber: issue?.number, fromAgentId: explicitAgentId, toAgentId: replacementAgentId, settingsRevision: settingsRevisionNow });

  return { allowed: true, blockers: [], replacementAgentId, labelMutation, evidenceCommentBody, dedupeKey };
}

/**
 * Apply an already-permitted plan. `mutateLabels({ removeLabels, addLabels
 * })` and `readLiveIssue()` are injected IO -- this function performs no
 * GitHub call itself. A mutation failure, or a post-mutation verification
 * that does not prove the exact expected label set, is reported and never
 * silently treated as success.
 */
export function applyPlannedReassignment({ plan, mutateLabels, readLiveIssue } = {}) {
  if (!plan?.allowed) return { applied: false, reason: 'plan-not-allowed', blockers: plan?.blockers || ['plan-not-allowed'] };

  try {
    mutateLabels({ removeLabels: plan.labelMutation.removeLabels, addLabels: plan.labelMutation.addLabels });
  } catch {
    // Issue #50 review, sink hardening: a fixed reason code only -- never
    // the raw exception message, which could carry a token, path, or
    // provider response fragment from the gh CLI transport.
    return { applied: false, reason: 'github-mutation-failed' };
  }

  let liveIssueAfter;
  try {
    liveIssueAfter = readLiveIssue();
  } catch {
    return { applied: false, reason: 'post-mutation-read-failed' };
  }
  if (!liveIssueAfter) return { applied: false, reason: 'post-mutation-verification-unavailable' };

  const verification = verifyLabelMutation({
    liveLabelsAfter: liveIssueAfter.labels || [],
    expectedFinalLabels: plan.labelMutation.expectedFinalLabels,
    replacementAgentLabel: plan.labelMutation.replacementAgentLabel,
  });
  if (!verification.ok) return { applied: false, reason: verification.reason, verification };

  return { applied: true, reason: null, verification };
}
