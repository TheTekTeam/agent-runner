#!/usr/bin/env node

/**
 * #231: production-lifecycle glue between the accepted #230 bounded failure
 * projection (`agent-runner-failure-projection.mjs`) and the existing
 * canonical runner-status/attention GitHub channel
 * (`upsertGitHubAttentionComment()` / `runnerAttentionCommentBody()` in
 * `claude-runner-cron.mjs`).
 *
 * Deliberately narrow: this module never talks to GitHub or SQLite. It only
 * (a) safely builds a #230 projection from lifecycle facts a caller already
 * has, never throwing on invalid/incomplete input (a projection failure
 * must not corrupt durable runner/attempt/queue truth -- #231 scope item 5),
 * and (b) renders that projection into the same bounded, positively
 * allowlisted markdown shape the rest of this codebase uses for GitHub
 * evidence, so a manager reading the issue never sees anything the #230
 * schema itself would refuse to accept.
 */

import { FAILURE_PROJECTION_SCHEMA_VERSION, deriveFailureProjection } from './agent-runner-failure-projection.mjs';

/**
 * Never throws. A caller with insufficient or inconsistent lifecycle
 * evidence gets `null` back -- the GitHub comment simply omits the
 * projection section rather than publishing a corrupt or misleading one,
 * and the caller's own durable state write is never blocked on this.
 */
export function safeDeriveFailureProjection(fields) {
  try {
    return deriveFailureProjection(fields);
  } catch {
    return null;
  }
}

// The rest of this codebase's real attempt identifiers are shaped like
// `owner/repo#issue:timestamp` (see `claude-runner-cron.mjs`), which the
// #230 schema's bounded machine-safe-token pattern refuses (no `/`). This is
// a deterministic, lossless, single-character substitution -- not a hash --
// so the projected `attemptId` stays directly correlatable with the exact
// durable attempt row a human or manager session already has.
export function attentionProjectionAttemptId(attemptId) {
  if (typeof attemptId !== 'string' || !attemptId) return null;
  return attemptId.replace(/\//g, '-').slice(0, 128);
}

const BOOLEAN_FIELDS = Object.freeze([
  ['candidateAdmissionCompleted', 'Candidate admission completed'],
  ['attemptCreated', 'Attempt created'],
  ['managerPacketConsumed', 'Manager packet consumed'],
  ['issueMutation', 'Issue mutation'],
  ['workspaceCreated', 'Workspace created'],
  ['childLaunched', 'Child launched'],
  ['checkpointPresent', 'Checkpoint present'],
  ['worktreePresent', 'Worktree present'],
  ['branchPresent', 'Branch present'],
  ['commitPresent', 'Commit present'],
  ['prPresent', 'PR present'],
  ['dirty', 'Worktree dirty'],
  ['hasChanges', 'Has changes'],
  ['recoveryEligible', 'Recovery eligible'],
]);

const TOKEN_FIELDS = Object.freeze([
  ['executionPhase', 'Execution phase'],
  ['providerInvocationObserved', 'Provider invocation observed'],
  ['failureScope', 'Failure scope'],
  ['reasonDomain', 'Reason domain'],
  ['reason', 'Reason'],
  ['terminalOutcome', 'Terminal outcome'],
  ['recoveryStatus', 'Recovery status'],
  ['recoveryAction', 'Recovery action'],
  ['circuitState', 'Circuit state'],
  ['circuitDomain', 'Circuit domain'],
  ['diagnosticDomain', 'Diagnostic domain'],
]);

function renderValue(value) {
  if (value === null || value === undefined) return '`unknown`';
  return `\`${value}\``;
}

/**
 * Bounded, positively allowlisted markdown rendering of a #230 projection.
 * Only fields the #230 schema itself already defined (`TOP_LEVEL_FIELDS` in
 * `agent-runner-failure-projection.mjs`) are ever read here -- there is no
 * pass-through of arbitrary projection properties, so a field the schema
 * would reject can never reach this renderer in the first place.
 */
export function renderFailureProjectionSection(projection) {
  if (!projection || projection.schemaVersion !== FAILURE_PROJECTION_SCHEMA_VERSION) return '';
  const lines = ['\n### Failure projection\n'];
  lines.push(`- Incident fingerprint: \`${projection.incidentFingerprint}\``);
  for (const [key, label] of TOKEN_FIELDS) {
    lines.push(`- ${label}: ${renderValue(projection[key])}`);
  }
  if (projection.missingCapabilities.length > 0) {
    lines.push(`- Missing capabilities: ${projection.missingCapabilities.map((id) => `\`${id}\``).join(', ')}`);
  }
  for (const [key, label] of BOOLEAN_FIELDS) {
    lines.push(`- ${label}: ${renderValue(projection[key])}`);
  }
  lines.push(`- Deeper diagnostics required: ${renderValue(projection.deeperDiagnosticsRequired)}`);
  return lines.join('\n');
}
