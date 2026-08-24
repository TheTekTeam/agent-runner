import { RUNNER_STATE_SCHEMA_VERSION } from './claude-runner-state.mjs';
import {
  HEALTH_CONDITION_CODES, OPERATOR_CODES, STATE_STATUSES, TABLES,
  boundedRepository, boundedToken, finiteNumber, projectName, timestampSeconds,
} from './agent-runner-observability-common.mjs';

function escapeLabel(value) {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}
function labels(values = {}) {
  const entries = Object.entries(values).filter(([, value]) => value !== null && value !== undefined);
  return entries.length ? `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}` : '';
}
function line(name, value, metricLabels = {}) { return `${name}${labels(metricLabels)} ${finiteNumber(value)}`; }
function block(name, type, help, lines) { return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines]; }
function status(dashboard) { return STATE_STATUSES.has(dashboard?.status) ? dashboard.status : 'error'; }
function code(dashboard) { return OPERATOR_CODES.has(dashboard?.operatorStatus?.code) ? dashboard.operatorStatus.code : 'idle'; }
function latestTimestamp(rows, fields) {
  for (const row of rows || []) for (const field of fields) {
    const value = timestampSeconds(row?.[field]);
    if (value > 0) return value;
  }
  return 0;
}
function currentIssue(dashboard) {
  const active = dashboard?.activity?.activeIssue;
  if (!Number.isInteger(active?.issue_number)) return null;
  const recovery = (dashboard?.latest?.recoveryAttempts || []).find((row) => row?.issue_number === active.issue_number);
  return {
    repository: boundedRepository(active.repo), project: projectName(dashboard?.project), issueNumber: active.issue_number,
    phase: boundedToken(recovery?.phase, 64), agent: boundedToken(active.agent, 64), assignment: boundedToken(active.assignment_label, 64),
  };
}

export function renderPrometheusMetrics(dashboard, { now = Date.now() } = {}) {
  const latest = dashboard?.latest || {};
  const counts = dashboard?.counts || {};
  const state = status(dashboard);
  const operator = code(dashboard);
  const schemaCompatible = dashboard?.schemaVersion == null ? state === 'missing' : dashboard.schemaVersion === RUNNER_STATE_SCHEMA_VERSION;
  const activeIssue = currentIssue(dashboard);
  const issueRuns = (latest.runResults || []).filter((row) => row?.mode === 'issue-run');
  const unresolvedAttention = (latest.attentionEvents || []).filter((row) => !row?.resolved_at).length;
  const pendingNotifications = (latest.notifications || []).filter((row) => !row?.resolved_at && row?.delivery_status !== 'delivered').length;
  const out = [];

  out.push(...block('agent_runner_exporter_up', 'gauge', 'Whether the read-only Agent Runner exporter generated this response.', [line('agent_runner_exporter_up', 1)]));
  out.push(...block('agent_runner_exporter_scrape_timestamp_seconds', 'gauge', 'Unix timestamp when this metrics response was generated.', [line('agent_runner_exporter_scrape_timestamp_seconds', Math.floor(now / 1000))]));
  out.push(...block('agent_runner_state_status', 'gauge', 'Current bounded state database status.', [...STATE_STATUSES].map((candidate) => line('agent_runner_state_status', candidate === state ? 1 : 0, { status: candidate }))));
  out.push(...block('agent_runner_state_schema_compatible', 'gauge', 'Whether the state schema is supported by this exporter.', [line('agent_runner_state_schema_compatible', schemaCompatible ? 1 : 0)]));
  out.push(...block('agent_runner_state_schema_version', 'gauge', 'Observed Agent Runner state schema version.', [line('agent_runner_state_schema_version', Number.isInteger(dashboard?.schemaVersion) ? dashboard.schemaVersion : 0)]));
  out.push(...block('agent_runner_operator_status', 'gauge', 'Current bounded operator status.', [...OPERATOR_CODES].map((candidate) => line('agent_runner_operator_status', candidate === operator ? 1 : 0, { code: candidate }))));
  out.push(...block('agent_runner_active', 'gauge', 'Whether an unresolved active claim is present.', [line('agent_runner_active', activeIssue ? 1 : 0)]));
  out.push(...block('agent_runner_attention_open', 'gauge', 'Number of unresolved attention events in the bounded projection.', [line('agent_runner_attention_open', unresolvedAttention)]));
  out.push(...block('agent_runner_notifications_pending', 'gauge', 'Number of unresolved non-delivered notifications in the bounded projection.', [line('agent_runner_notifications_pending', pendingNotifications)]));
  if (activeIssue) out.push(...block('agent_runner_current_issue_info', 'gauge', 'Current bounded issue identity; present only while active.', [line('agent_runner_current_issue_info', 1, {
    repository: activeIssue.repository, project: activeIssue.project, issue_number: activeIssue.issueNumber,
    phase: activeIssue.phase, agent: activeIssue.agent, assignment: activeIssue.assignment,
  })]));
  out.push(...block('agent_runner_state_rows', 'gauge', 'Persisted row counts for an allowlisted state table.', TABLES.map((table) => line('agent_runner_state_rows', Number.isInteger(counts?.[table]) ? counts[table] : 0, { table }))));
  out.push(...block('agent_runner_scheduler_polls_window_total', 'gauge', 'Scheduler poll outcomes in the bounded retained window.', [
    line('agent_runner_scheduler_polls_window_total', (latest.runResults || []).filter((row) => row?.mode === 'no-selection').length, { outcome: 'no_selection' }),
    line('agent_runner_scheduler_polls_window_total', (latest.runResults || []).filter((row) => row?.mode === 'quota-blocked').length, { outcome: 'quota_blocked' }),
    line('agent_runner_scheduler_polls_window_total', issueRuns.length, { outcome: 'issue_run' }),
  ]));
  out.push(...block('agent_runner_issue_runs_window_total', 'gauge', 'Issue run outcomes in the bounded retained window.', [
    line('agent_runner_issue_runs_window_total', issueRuns.filter((row) => row?.exit_code === 0).length, { outcome: 'success' }),
    line('agent_runner_issue_runs_window_total', issueRuns.filter((row) => Number.isInteger(row?.exit_code) && row.exit_code !== 0).length, { outcome: 'failure' }),
  ]));
  out.push(...block('agent_runner_issue_run_duration_seconds', 'gauge', 'Average issue-run duration in the bounded retained window.', [line('agent_runner_issue_run_duration_seconds', finiteNumber(dashboard?.metrics?.runs?.averageDurationSeconds))]));
  out.push(...block('agent_runner_queue_skips_window_total', 'gauge', 'Skip events in the bounded retained window.', [line('agent_runner_queue_skips_window_total', finiteNumber(dashboard?.metrics?.queue?.skipEventCount))]));
  out.push(...block('agent_runner_quota_usage_percent', 'gauge', 'Latest safely projected included-quota usage percent.', [
    line('agent_runner_quota_usage_percent', finiteNumber(dashboard?.metrics?.quota?.latestSessionUsagePercent), { period: 'session' }),
    line('agent_runner_quota_usage_percent', finiteNumber(dashboard?.metrics?.quota?.latestWeeklyUsagePercent), { period: 'week' }),
  ]));
  for (const condition of HEALTH_CONDITION_CODES) {
    const count = (dashboard?.currentHealthConditions || []).filter((row) => row?.condition_type === condition).length;
    out.push(...block(`agent_runner_health_condition_${condition}`, 'gauge', `Whether ${condition} is currently unresolved.`, [line(`agent_runner_health_condition_${condition}`, count > 0 ? 1 : 0)]));
  }
  out.push(...block('agent_runner_last_scheduler_poll_timestamp_seconds', 'gauge', 'Timestamp of the latest bounded scheduler poll.', [line('agent_runner_last_scheduler_poll_timestamp_seconds', latestTimestamp(latest.runResults, ['created_at','started_at']))]));
  out.push(...block('agent_runner_last_selection_timestamp_seconds', 'gauge', 'Timestamp of the latest bounded issue selection.', [line('agent_runner_last_selection_timestamp_seconds', latestTimestamp(latest.selections, ['created_at']))]));
  out.push(...block('agent_runner_last_claim_timestamp_seconds', 'gauge', 'Timestamp of the latest bounded claim.', [line('agent_runner_last_claim_timestamp_seconds', latestTimestamp(latest.claims, ['created_at','started_at']))]));
  out.push(...block('agent_runner_last_terminal_result_timestamp_seconds', 'gauge', 'Timestamp of the latest bounded terminal run result.', [line('agent_runner_last_terminal_result_timestamp_seconds', latestTimestamp(latest.runResults, ['finished_at','created_at']))]));
  out.push(...block('agent_runner_dashboard_projection_timestamp_seconds', 'gauge', 'Timestamp of the underlying bounded dashboard projection.', [line('agent_runner_dashboard_projection_timestamp_seconds', timestampSeconds(dashboard?.generatedAt))]));
  return `${out.join('\n')}\n`;
}
