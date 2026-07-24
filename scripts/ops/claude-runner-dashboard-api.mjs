#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadAgentRunnerConfig, projectIdentity, stripConfigArgs } from './agent-runner-config.mjs';
import { defaultRunnerStateDbPath, RUNNER_STATE_SCHEMA_VERSION, summarizeRunnerState } from './claude-runner-state.mjs';

const TABLE_TO_DASHBOARD_KEY = Object.freeze({
  queue_events: 'queueEvents',
  quota_history: 'quota',
  preflight_packets: 'preflights',
  issue_selections: 'selections',
  claims: 'claims',
  run_results: 'runResults',
  recovery_attempts: 'recoveryAttempts',
  attention_events: 'attentionEvents',
  // History view only (recent, resolved-or-not) — the operator-facing
  // *current* truth is `operatorStatus`, derived from
  // `summary.currentHealthConditions` (#698 round 5, finding 3), not this key.
  runner_health_conditions: 'healthConditions',
  // #53: the notification/outbox layer's bounded operator-facing status.
  notification_events: 'notifications',
});

function isoNow() {
  return new Date().toISOString();
}

function defaultDbPathFromEnv(env = process.env, config = loadAgentRunnerConfig({ env })) {
  return env.CLAUDE_RUNNER_STATE_DB || config.stateDbPath || defaultRunnerStateDbPath(env.CLAUDE_RUNNER_OUTPUT_DIR || config.outputDir || '.var/claude-runner');
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 100);
}

function diagnostic(level, code, message, details = {}) {
  return { level, code, message, ...details };
}

function safeJson(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function baseLatest() {
  return {
    runs: [],
    selections: [],
    queueEvents: [],
    quota: [],
    preflights: [],
    claims: [],
    runResults: [],
    recoveryAttempts: [],
    attentionEvents: [],
    healthConditions: [],
    notifications: [],
  };
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return row;
  const { payload_json: payloadJson, ...rest } = row;
  return {
    ...rest,
    payload: safeJson(payloadJson),
  };
}

/**
 * `recovery_attempts`, `run_results`, and `attention_events` carry columns
 * that must never reach dashboard/API output: `payload_json`/`event_json`
 * (raw diagnostics — may embed log paths, restricted-recovery-handle
 * digests, or provider responses), `log_path` (a local filesystem path),
 * process/boot identity (`process_id`, `process_boot_id`,
 * `process_start_ticks`, `systemd_invocation_id`), and internal correlation
 * identifiers (`recovery_authorization_id`, `recovery_lease_id`,
 * `attention_dedupe_key`) that have no dashboard display purpose.
 * `normalizeRow()`'s generic `{ ...rest, payload }` shape exposed the full
 * row plus the parsed payload for every table, so any of the above landed
 * in dashboard/API output unfiltered (#698 finding 9). These three
 * serializers are positive allowlists — a new column added to the schema
 * is safe-by-default (excluded) until explicitly added here, the opposite
 * of the previous behavior.
 */
const TABLE_SERIALIZERS = Object.freeze({
  recovery_attempts: (row) => pickFields(row, [
    'attempt_id', 'repo', 'project', 'issue_number', 'claim_id', 'preflight_revision', 'phase',
    'agent', 'model', 'harness', 'started_at', 'finished_at', 'outcome', 'exit_code', 'signal',
    'recovery_eligible', 'recovery_action', 'recovery_attempt_count', 'retry_at',
    'checkpoint_available', 'session_available', 'worktree_available', 'branch_available', 'pr_available',
    'attention_status', 'resolution_state', 'last_notification_at',
    'stalled_passes', 'attention_detected_at', 'progress_revision', 'observed_progress_revision',
    'progress_token', 'last_progress_at', 'claimed_recovery_action', 'transition_mutation_count',
    // Authoritative retry schedule (#698 round 5, finding 2) — operator-
    // relevant (when/whether a bounded retry will happen), non-sensitive.
    'next_retry_at', 'retry_attempt', 'retry_cap', 'retry_reason',
  ]),
  run_results: (row) => pickFields(row, [
    'id', 'created_at', 'started_at', 'finished_at', 'repo', 'issue_number', 'mode', 'exit_code', 'signal',
  ]),
  attention_events: (row) => pickFields(row, [
    'id', 'created_at', 'updated_at', 'repo', 'project', 'issue_number', 'attempt_id', 'reason', 'agent',
    'started_at', 'finished_at', 'recovery_status', 'next_action', 'dashboard_reference', 'policy_revision',
    'notification_count', 'last_notification_at', 'resolved_at',
  ]),
  // #698 round 5, finding 3 — payload_json deliberately excluded, matching
  // the other tables' allowlist convention.
  runner_health_conditions: (row) => pickFields(row, [
    'id', 'repo', 'condition_type', 'reason', 'opened_at', 'updated_at', 'resolved_at', 'safe_next_action',
  ]),
  // #53 — dedupe_key, source_table, source_ref, content_json and last_error
  // deliberately excluded: internal correlation/audit detail with no
  // dashboard display purpose, matching the same allowlist convention.
  // `stale_recovery_count` is included deliberately (#53 review round 3,
  // item 5): stale-claim recoveries no longer consume attempt_count, so this
  // is the only operator-visible signal that a row keeps being abandoned
  // mid-delivery. It is a bounded non-negative integer, like attempt_count.
  // `project` is a bounded identifier enforced by the state store itself.
  notification_events: (row) => pickFields(row, [
    'id', 'created_at', 'updated_at', 'repo', 'project', 'issue_number', 'event_type', 'reason_code', 'agent',
    'delivery_status', 'attempt_count', 'max_attempts', 'stale_recovery_count',
    'next_attempt_at', 'last_attempt_at', 'delivered_at', 'resolved_at',
  ]),
});

function pickFields(row, fields) {
  if (!row || typeof row !== 'object') return row;
  const picked = {};
  for (const field of fields) picked[field] = row[field] ?? null;
  return picked;
}

function quotaPayloadCandidates(payload) {
  return [
    payload,
    payload?.payload,
    payload?.state,
    payload?.payload?.state,
  ].filter((candidate) => candidate && typeof candidate === 'object');
}

function quotaPercentFromPayload(payload, { directKeys, normalizedPath }) {
  for (const candidate of quotaPayloadCandidates(payload)) {
    for (const key of directKeys) {
      if (Number.isFinite(candidate?.[key])) return candidate[key];
    }
    const normalized = candidate?.quotaUsage?.[normalizedPath]?.usedPercent;
    if (Number.isFinite(normalized)) return normalized;
  }
  return null;
}

function quotaResetFromPayload(payload) {
  for (const candidate of quotaPayloadCandidates(payload)) {
    const value = candidate?.resetAt
      || candidate?.pausedUntil
      || candidate?.quotaUsage?.session?.resetAt
      || candidate?.quotaUsage?.week?.resetAt;
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function normalizeQuotaRow(row) {
  const normalized = normalizeRow(row);
  if (!normalized || typeof normalized !== 'object') return normalized;
  return {
    ...normalized,
    session_usage_percent: Number.isFinite(normalized.session_usage_percent)
      ? normalized.session_usage_percent
      : quotaPercentFromPayload(normalized.payload, {
        directKeys: ['sessionPercentUsed', 'percentUsed'],
        normalizedPath: 'session',
      }),
    weekly_usage_percent: Number.isFinite(normalized.weekly_usage_percent)
      ? normalized.weekly_usage_percent
      : quotaPercentFromPayload(normalized.payload, {
        directKeys: ['weeklyPercentUsed', 'weekPercentUsed'],
        normalizedPath: 'week',
      }),
    reset_at: normalized.reset_at || quotaResetFromPayload(normalized.payload),
  };
}

function dashboardLatest(summary) {
  const latest = baseLatest();
  for (const [table, rows] of Object.entries(summary.latest || {})) {
    const key = TABLE_TO_DASHBOARD_KEY[table];
    if (!key) continue;
    const serialize = TABLE_SERIALIZERS[table]
      || (table === 'quota_history' ? normalizeQuotaRow : normalizeRow);
    latest[key] = rows.map(serialize);
  }
  latest.runs = latest.runResults;
  return latest;
}

function skippedQueueReasons(queueEvents = []) {
  const counts = new Map();
  for (const event of queueEvents) {
    if (event?.event_type && event.event_type !== 'skip') continue;
    const reason = event.reason || event.payload?.reason || null;
    if (!reason) continue;
    const previous = counts.get(reason) || { reason, count: 0, latestAt: null };
    previous.count += 1;
    previous.latestAt = previous.latestAt && previous.latestAt > event.created_at ? previous.latestAt : event.created_at;
    counts.set(reason, previous);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || String(b.latestAt).localeCompare(String(a.latestAt)));
}

function toTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function rowTimestamp(row) {
  return toTimestamp(row?.finished_at || row?.started_at || row?.created_at);
}

function roundSeconds(milliseconds) {
  return Math.round(milliseconds / 1000);
}

function completedRunDurationSeconds(run) {
  const started = toTimestamp(run?.started_at);
  const finished = toTimestamp(run?.finished_at);
  if (started === null || finished === null || finished < started) return null;
  return roundSeconds(finished - started);
}

function latestQuotaUsage(quotaRows = [], field) {
  for (const row of quotaRows) {
    const value = row?.[field];
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function oldestTimestamp(rows = []) {
  let oldest = null;
  for (const row of rows) {
    const value = row?.created_at || row?.started_at || row?.finished_at;
    const timestamp = toTimestamp(value);
    if (timestamp === null) continue;
    if (oldest === null || timestamp < oldest.timestamp) oldest = { timestamp, value };
  }
  return oldest?.value || null;
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))];
}

function buildEtaMetrics({ durationsSeconds, outstandingCount }) {
  if (durationsSeconds.length < 3) {
    return {
      status: 'insufficient-data',
      confidence: 'low',
      message: 'Not enough completed issue-run history to estimate ETA.',
    };
  }

  if (!Number.isInteger(outstandingCount) || outstandingCount < 1) {
    return {
      status: 'not-needed',
      confidence: 'low',
      message: 'No distinct selected or skipped issues are present in the dashboard history.',
    };
  }

  const sorted = [...durationsSeconds].sort((a, b) => a - b);
  const low = percentile(sorted, 25) * outstandingCount;
  const high = percentile(sorted, 75) * outstandingCount;

  return {
    status: 'estimated-range',
    confidence: durationsSeconds.length >= 10 ? 'medium' : 'low',
    estimatedSecondsLow: low,
    estimatedSecondsHigh: Math.max(low, high),
    basis: {
      completedRuns: durationsSeconds.length,
      outstandingIssues: outstandingCount,
    },
    message: 'Rough ETA range based on persisted issue-run durations and distinct selected/skipped issues.',
  };
}

function issueActivityRow(row, kind) {
  if (!Number.isInteger(row?.issue_number)) return null;
  return {
    repo: row.repo,
    issue_number: row.issue_number,
    kind,
    mode: row.selection_mode || row.mode || row.action || null,
    status_label: row.status_label || null,
    timestamp: row.finished_at || row.started_at || row.created_at || null,
    exit_code: Number.isInteger(row.exit_code) ? row.exit_code : null,
  };
}

export function buildRunnerActivity(latest = baseLatest()) {
  const runs = latest.runResults || latest.runs || [];
  const claims = latest.claims || [];
  const allActivity = [
    ...(latest.selections || []).map((row) => issueActivityRow(row, 'selection')),
    ...claims.map((row) => issueActivityRow(row, 'claim')),
    ...runs.map((row) => issueActivityRow(row, 'run-result')),
  ].filter(Boolean).sort((left, right) => (toTimestamp(right.timestamp) || 0) - (toTimestamp(left.timestamp) || 0));

  const sortedClaims = [...claims].sort((left, right) => (rowTimestamp(right) || 0) - (rowTimestamp(left) || 0));
  let activeClaim = null;
  for (const claim of sortedClaims) {
    const claimAt = rowTimestamp(claim);
    const terminal = runs.some((run) => run.issue_number === claim.issue_number
      && rowTimestamp(run) !== null
      && claimAt !== null
      && rowTimestamp(run) >= claimAt);
    if (!terminal) {
      activeClaim = issueActivityRow(claim, 'claim');
      break;
    }
  }

  if (activeClaim) {
    return {
      status: 'active-or-unresolved',
      activeIssue: activeClaim,
      latestIssue: allActivity[0] || activeClaim,
      message: 'A claim has no later terminal run result in the retained history.',
    };
  }

  if (allActivity.length > 0) {
    return {
      status: 'idle',
      activeIssue: null,
      latestIssue: allActivity[0],
      message: 'No active claim is evidenced; showing the latest issue activity only.',
    };
  }

  return {
    status: 'empty',
    activeIssue: null,
    latestIssue: null,
    message: 'No selected, claimed or executed issue is recorded.',
  };
}

export function buildRunnerMetrics(dashboard) {
  const latest = dashboard?.latest || baseLatest();
  const runRows = latest.runResults || latest.runs || [];
  const issueRunRows = runRows.filter((run) => run?.mode === 'issue-run');
  const completedDurations = issueRunRows.map(completedRunDurationSeconds).filter((value) => Number.isFinite(value));
  const averageDurationSeconds = completedDurations.length > 0
    ? Math.round(completedDurations.reduce((sum, value) => sum + value, 0) / completedDurations.length)
    : null;
  const recordedIssueRuns = issueRunRows.filter((run) => Number.isInteger(run?.exit_code));
  const succeeded = recordedIssueRuns.filter((run) => run.exit_code === 0).length;
  const failed = recordedIssueRuns.filter((run) => run.exit_code !== 0).length;
  const skipEvents = (latest.queueEvents || []).filter((row) => !row?.event_type || row.event_type === 'skip');
  const skipReasons = skippedQueueReasons(skipEvents);
  const selectedOrSkipped = [
    ...(latest.selections || []).filter((row) => row?.issue_number != null),
    ...skipEvents.filter((row) => row?.issue_number != null && (row?.reason || row?.payload?.reason)),
  ];
  const outstandingIssueNumbers = new Set(selectedOrSkipped.map((row) => row.issue_number).filter(Number.isInteger));
  const skippedIssueNumbers = new Set(skipEvents.map((row) => row.issue_number).filter(Number.isInteger));

  return {
    runs: {
      total: issueRunRows.length,
      schedulerPolls: runRows.length,
      noSelectionPolls: runRows.filter((run) => run?.mode === 'no-selection').length,
      quotaBlockedPolls: runRows.filter((run) => run?.mode === 'quota-blocked').length,
      issueRuns: issueRunRows.length,
      succeeded,
      failed,
      averageDurationSeconds,
    },
    quota: {
      blockedCount: (latest.quota || []).filter((row) => row?.blocked === 1 || row?.blocked === true).length,
      latestSessionUsagePercent: latestQuotaUsage(latest.quota || [], 'session_usage_percent'),
      latestWeeklyUsagePercent: latestQuotaUsage(latest.quota || [], 'weekly_usage_percent'),
    },
    queue: {
      skipReasons,
      skipEventCount: skipEvents.length,
      skippedIssueCount: skippedIssueNumbers.size,
      skipReasonCount: skipReasons.length,
      oldestQueuedOrSkippedAt: oldestTimestamp(selectedOrSkipped),
    },
    eta: buildEtaMetrics({
      durationsSeconds: completedDurations,
      outstandingCount: outstandingIssueNumbers.size,
    }),
  };
}

function preflightFingerprints(preflights = []) {
  return preflights
    .filter((row) => row.fingerprint)
    .map((row) => ({
      repo: row.repo,
      issue_number: row.issue_number,
      fingerprint: row.fingerprint,
      action: row.action,
      stale: row.stale,
      created_at: row.created_at,
    }));
}


/**
 * `systemic_pause`/`queue_inspection_degraded` are derived from
 * `currentHealthConditions` — the resolvable `runner_health_conditions`
 * table (#698 round 5, finding 3), not a bounded latest-N `queue_events`
 * window. A prior version of this function inferred these from the latest
 * window, which could keep showing a cleared condition indefinitely until
 * enough newer events pushed it out; `currentHealthConditions` only ever
 * contains genuinely unresolved rows, explicitly resolved by the scheduler
 * the moment the condition clears (see `emitSystemicStatePause()`/
 * `selectIssue()` in claude-runner-cron.mjs).
 */
export function buildRunnerOperatorStatus(latest, activity, currentHealthConditions = []) {
  const systemicPause = currentHealthConditions.find((row) => row.condition_type === 'systemic_pause');
  if (systemicPause) {
    return { code: 'global_systemic_pause', label: 'Globally paused due to a systemic safety fault', reason: systemicPause.reason || null };
  }
  const unresolved = (latest.attentionEvents || []).filter((row) => !row.resolved_at);
  if (unresolved.length) return { code: 'attention_required', label: 'Attention required', count: unresolved.length };
  const quarantines = (latest.queueEvents || []).filter((row) => row.event_type === 'quarantine');
  if (quarantines.length) return { code: 'task_local_quarantines', label: 'Timer healthy with task-local quarantines', count: quarantines.length };
  if (activity?.activeIssue || (latest.runResults || []).some((row) => row.mode === 'issue-run')) {
    return { code: 'queue_moving', label: 'Timer healthy and queue moving' };
  }
  // Only reached once nothing more urgent (a systemic pause, unresolved
  // attention, a task-local quarantine, or active queue movement) already
  // explains current status. A degraded queue scan does not globally pause
  // persisted recovery reconciliation — that keeps running independently —
  // it only means *new*-candidate discovery could not happen this pass, so
  // "no eligible work" would be an unproven, and possibly false, claim.
  const degraded = currentHealthConditions.find((row) => row.condition_type === 'queue_inspection_degraded');
  if (degraded) {
    return {
      code: 'queue_inspection_degraded',
      label: 'Queue inspection degraded — GitHub could not be reached to check for eligible work',
      reason: degraded.reason || null,
    };
  }
  return { code: 'idle', label: 'Idle with no eligible work' };
}

export function buildRunnerDashboard(dbPath, { now = isoNow, historyLimit = 20, strict = false, config = loadAgentRunnerConfig() } = {}) {
  const summary = summarizeRunnerState(dbPath, {
    now,
    historyLimit,
    requireExisting: strict,
  });

  const diagnostics = [];
  if (summary.status === 'missing') {
    diagnostics.push(diagnostic(
      strict ? 'error' : 'warn',
      'state-db-missing',
      'Runner state DB does not exist yet.',
      { dbPath },
    ));
  } else if (summary.status === 'invalid-path') {
    diagnostics.push(diagnostic('error', 'state-db-invalid-path', 'Runner state DB path is invalid.', { dbPath }));
  } else if (summary.status === 'error') {
    diagnostics.push(diagnostic('error', 'state-db-error', summary.error?.message || 'Runner state DB could not be read.', { error: summary.error }));
  }

  const latest = dashboardLatest(summary);
  const aggregates = {
    skippedQueueReasons: skippedQueueReasons(latest.queueEvents),
    preflightFingerprints: preflightFingerprints(latest.preflights),
  };
  // The operator-facing current-health truth (#698 round 5, finding 3) —
  // unresolved-only, independent of `latest.healthConditions`' bounded
  // history window.
  const currentHealthConditions = (summary.currentHealthConditions || []).map(TABLE_SERIALIZERS.runner_health_conditions);

  const activity = buildRunnerActivity(latest);
  return {
    ok: summary.ok,
    status: summary.status,
    dbPath: summary.dbPath,
    generatedAt: summary.generatedAt,
    schemaVersion: summary.schemaVersion ?? (summary.ok && typeof dbPath === 'string' && existsSync(dbPath) ? RUNNER_STATE_SCHEMA_VERSION : null),
    project: projectIdentity(config),
    currentHealthConditions,
    counts: summary.counts,
    latest,
    aggregates,
    metrics: buildRunnerMetrics({ latest }),
    activity,
    operatorStatus: buildRunnerOperatorStatus(latest, activity, currentHealthConditions),
    diagnostics,
    ...(summary.error ? { error: summary.error } : {}),
  };
}

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const config = loadAgentRunnerConfig({ argv, env });
  argv = stripConfigArgs(argv);
  const args = {
    dbPath: defaultDbPathFromEnv(env, config),
    config,
    historyLimit: 20,
    strict: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--db' || arg === '--state-db') args.dbPath = argv[++i];
    else if (arg.startsWith('--db=')) args.dbPath = arg.slice('--db='.length);
    else if (arg.startsWith('--state-db=')) args.dbPath = arg.slice('--state-db='.length);
    else if (arg === '--history-limit' || arg === '--limit') args.historyLimit = parsePositiveInteger(argv[++i], args.historyLimit);
    else if (arg.startsWith('--history-limit=')) args.historyLimit = parsePositiveInteger(arg.slice('--history-limit='.length), args.historyLimit);
    else if (arg.startsWith('--limit=')) args.historyLimit = parsePositiveInteger(arg.slice('--limit='.length), args.historyLimit);
    else if (arg === '--strict') args.strict = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  return args;
}

function helpText() {
  return `Usage: node scripts/ops/claude-runner-dashboard-api.mjs [options]\n\nOptions:\n  --config <path>               Agent Runner project config JSON (or AGENT_RUNNER_CONFIG)
  --db, --state-db <path>       SQLite runner state DB path\n  --history-limit, --limit <n>  Number of latest rows per dashboard section, default 20\n  --strict                      Exit non-zero when the DB is missing or unhealthy\n  -h, --help                    Show this help\n`;
}

export function run(argv = process.argv.slice(2), env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  let args;
  try {
    args = parseArgs(argv, env);
  } catch (error) {
    io.stderr.write(`${error.message}\n\n${helpText()}`);
    return 2;
  }

  if (args.help) {
    io.stdout.write(helpText());
    return 0;
  }

  const dashboard = buildRunnerDashboard(args.dbPath, {
    historyLimit: args.historyLimit,
    strict: args.strict,
    config: args.config,
  });
  io.stdout.write(`${JSON.stringify(dashboard, null, 2)}\n`);
  return args.strict && !dashboard.ok ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run();
}
