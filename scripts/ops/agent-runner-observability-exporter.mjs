#!/usr/bin/env node
import { createServer } from 'node:http';
import { hostname as systemHostname } from 'node:os';
import { pathToFileURL } from 'node:url';

import { loadAgentRunnerConfig, stripConfigArgs } from './agent-runner-config.mjs';
import { buildRunnerDashboard } from './claude-runner-dashboard-api.mjs';
import { defaultRunnerStateDbPath, RUNNER_STATE_SCHEMA_VERSION } from './claude-runner-state.mjs';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 9914;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;
const MAX_EVENTS = 100;
const MAX_EVENT_BYTES = 256 * 1024;

const STATE_STATUSES = new Set(['ok', 'missing', 'invalid-path', 'error']);
const OPERATOR_CODES = new Set([
  'global_systemic_pause',
  'attention_required',
  'task_local_quarantines',
  'queue_moving',
  'queue_inspection_degraded',
  'idle',
]);
const HEALTH_CONDITION_CODES = new Set(['systemic_pause', 'queue_inspection_degraded']);
const TABLES = Object.freeze([
  'queue_events',
  'quota_history',
  'preflight_packets',
  'issue_selections',
  'claims',
  'run_results',
  'recovery_attempts',
  'recovery_revalidations',
  'attention_events',
  'runner_health_conditions',
  'routing_events',
  'notification_events',
]);

function isoNow() {
  return new Date().toISOString();
}

function parseInteger(value, { fallback, min, max }) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function boundedToken(value, max = 64) {
  const token = String(value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(token) && token.length <= max ? token : null;
}

function boundedRepository(value) {
  const repository = boundedToken(value, 128);
  return repository && repository.includes('/') ? repository : null;
}

function boundedReason(value) {
  const reason = String(value ?? '').trim();
  return /^[a-z0-9][a-z0-9._:-]*$/.test(reason) && reason.length <= 64 ? reason : null;
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function timestampSeconds(value) {
  const timestamp = Date.parse(String(value ?? ''));
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}

function prometheusLabel(value) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"');
}

function labels(values = {}) {
  const entries = Object.entries(values).filter(([, value]) => value !== null && value !== undefined);
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${prometheusLabel(value)}"`).join(',')}}`;
}

function metricLine(name, value, metricLabels = {}) {
  return `${name}${labels(metricLabels)} ${finiteNumber(value)}`;
}

function metricBlock(name, type, help, lines) {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines];
}

function projectName(project) {
  if (typeof project === 'string') return boundedToken(project, 64);
  for (const candidate of [project?.project, project?.name, project?.id, project?.slug]) {
    const bounded = boundedToken(candidate, 64);
    if (bounded) return bounded;
  }
  return null;
}

function defaultDbPathFromEnv(env, config) {
  return env.CLAUDE_RUNNER_STATE_DB
    || config.stateDbPath
    || defaultRunnerStateDbPath(env.CLAUDE_RUNNER_OUTPUT_DIR || config.outputDir || '.var/claude-runner');
}

export function parseExporterArgs(argv = process.argv.slice(2), env = process.env) {
  const config = loadAgentRunnerConfig({ argv, env });
  argv = stripConfigArgs(argv);
  const args = {
    config,
    dbPath: defaultDbPathFromEnv(env, config),
    host: env.AGENT_RUNNER_OBSERVABILITY_HOST || LOOPBACK_HOST,
    port: parseInteger(env.AGENT_RUNNER_OBSERVABILITY_PORT, { fallback: DEFAULT_PORT, min: 1, max: 65535 }),
    historyLimit: parseInteger(env.AGENT_RUNNER_OBSERVABILITY_HISTORY_LIMIT, {
      fallback: DEFAULT_HISTORY_LIMIT,
      min: 1,
      max: MAX_HISTORY_LIMIT,
    }),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--db' || arg === '--state-db') args.dbPath = argv[++index];
    else if (arg.startsWith('--db=')) args.dbPath = arg.slice('--db='.length);
    else if (arg.startsWith('--state-db=')) args.dbPath = arg.slice('--state-db='.length);
    else if (arg === '--host') args.host = argv[++index];
    else if (arg.startsWith('--host=')) args.host = arg.slice('--host='.length);
    else if (arg === '--port') args.port = parseInteger(argv[++index], { fallback: -1, min: 1, max: 65535 });
    else if (arg.startsWith('--port=')) args.port = parseInteger(arg.slice('--port='.length), { fallback: -1, min: 1, max: 65535 });
    else if (arg === '--history-limit') args.historyLimit = parseInteger(argv[++index], { fallback: -1, min: 1, max: MAX_HISTORY_LIMIT });
    else if (arg.startsWith('--history-limit=')) args.historyLimit = parseInteger(arg.slice('--history-limit='.length), { fallback: -1, min: 1, max: MAX_HISTORY_LIMIT });
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (args.host !== LOOPBACK_HOST) {
    throw new Error(`Observability exporter must bind to ${LOOPBACK_HOST}; received ${JSON.stringify(args.host)}`);
  }
  if (!Number.isInteger(args.port) || args.port < 1) throw new Error('Observability exporter port is invalid');
  if (!Number.isInteger(args.historyLimit) || args.historyLimit < 1) throw new Error('Observability history limit is invalid');
  return args;
}

function operatorCode(dashboard) {
  const code = dashboard?.operatorStatus?.code;
  return OPERATOR_CODES.has(code) ? code : 'idle';
}

function stateStatus(dashboard) {
  const status = dashboard?.status;
  return STATE_STATUSES.has(status) ? status : 'error';
}

function latestTimestamp(rows, fields) {
  for (const row of rows || []) {
    for (const field of fields) {
      const value = timestampSeconds(row?.[field]);
      if (value > 0) return value;
    }
  }
  return 0;
}

function currentIssue(dashboard) {
  const active = dashboard?.activity?.activeIssue;
  if (!Number.isInteger(active?.issue_number)) return null;
  const recovery = (dashboard?.latest?.recoveryAttempts || [])
    .find((row) => row?.issue_number === active.issue_number);
  return {
    repository: boundedRepository(active.repo),
    project: projectName(dashboard?.project),
    issueNumber: active.issue_number,
    phase: boundedToken(recovery?.phase, 64),
    agent: boundedToken(active.agent, 64),
    assignment: boundedToken(active.assignment_label, 64),
  };
}

export function renderPrometheusMetrics(dashboard, { now = Date.now() } = {}) {
  const latest = dashboard?.latest || {};
  const counts = dashboard?.counts || {};
  const status = stateStatus(dashboard);
  const code = operatorCode(dashboard);
  const schemaCompatible = dashboard?.schemaVersion == null
    ? status === 'missing'
    : dashboard.schemaVersion === RUNNER_STATE_SCHEMA_VERSION;
  const activeIssue = currentIssue(dashboard);
  const issueRuns = latest.runResults?.filter((row) => row?.mode === 'issue-run') || [];
  const schedulerPolls = latest.runResults || [];
  const unresolvedAttention = (latest.attentionEvents || []).filter((row) => !row?.resolved_at).length;
  const pendingNotifications = (latest.notifications || []).filter((row) => !row?.resolved_at && row?.delivery_status !== 'delivered').length;
  const blocks = [];

  blocks.push(...metricBlock('agent_runner_exporter_up', 'gauge', 'Whether the read-only Agent Runner exporter generated this response.', [
    metricLine('agent_runner_exporter_up', 1),
  ]));
  blocks.push(...metricBlock('agent_runner_exporter_scrape_timestamp_seconds', 'gauge', 'Unix timestamp when this metrics response was generated.', [
    metricLine('agent_runner_exporter_scrape_timestamp_seconds', Math.floor(now / 1000)),
  ]));
  blocks.push(...metricBlock('agent_runner_state_status', 'gauge', 'Current bounded state database status.', [
    ...[...STATE_STATUSES].map((candidate) => metricLine('agent_runner_state_status', candidate === status ? 1 : 0, { status: candidate })),
  ]));
  blocks.push(...metricBlock('agent_runner_state_schema_compatible', 'gauge', 'Whether the state schema is supported by this exporter.', [
    metricLine('agent_runner_state_schema_compatible', schemaCompatible ? 1 : 0),
  ]));
  blocks.push(...metricBlock('agent_runner_state_schema_version', 'gauge', 'Observed Agent Runner state schema version.', [
    metricLine('agent_runner_state_schema_version', Number.isInteger(dashboard?.schemaVersion) ? dashboard.schemaVersion : 0),
  ]));
  blocks.push(...metricBlock('agent_runner_operator_status', 'gauge', 'Current bounded operator status.', [
    ...[...OPERATOR_CODES].map((candidate) => metricLine('agent_runner_operator_status', candidate === code ? 1 : 0, { code: candidate })),
  ]));
  blocks.push(...metricBlock('agent_runner_active', 'gauge', 'Whether an unresolved active claim is present.', [
    metricLine('agent_runner_active', activeIssue ? 1 : 0),
  ]));
  blocks.push(...metricBlock('agent_runner_attention_open', 'gauge', 'Number of unresolved attention events in the bounded projection.', [
    metricLine('agent_runner_attention_open', unresolvedAttention),
  ]));
  blocks.push(...metricBlock('agent_runner_notifications_pending', 'gauge', 'Number of unresolved non-delivered notifications in the bounded projection.', [
    metricLine('agent_runner_notifications_pending', pendingNotifications),
  ]));

  if (activeIssue) {
    blocks.push(...metricBlock('agent_runner_current_issue_info', 'gauge', 'Current bounded issue identity; present only while active.', [
      metricLine('agent_runner_current_issue_info', 1, {
        repository: activeIssue.repository,
        project: activeIssue.project,
        issue_number: activeIssue.issueNumber,
        phase: activeIssue.phase,
        agent: activeIssue.agent,
        assignment: activeIssue.assignment,
      }),
    ]));
  }

  blocks.push(...metricBlock('agent_runner_state_rows', 'gauge', 'Persisted row counts for an allowlisted state table.', [
    ...TABLES.map((table) => metricLine('agent_runner_state_rows', Number.isInteger(counts?.[table]) ? counts[table] : 0, { table })),
  ]));
  blocks.push(...metricBlock('agent_runner_scheduler_polls_window_total', 'gauge', 'Scheduler poll outcomes in the bounded retained window.', [
    metricLine('agent_runner_scheduler_polls_window_total', schedulerPolls.filter((row) => row?.mode === 'no-selection').length, { outcome: 'no_selection' }),
    metricLine('agent_runner_scheduler_polls_window_total', schedulerPolls.filter((row) => row?.mode === 'quota-blocked').length, { outcome: 'quota_blocked' }),
    metricLine('agent_runner_scheduler_polls_window_total', schedulerPolls.filter((row) => row?.mode === 'issue-run').length, { outcome: 'issue_run' }),
  ]));
  blocks.push(...metricBlock('agent_runner_issue_runs_window_total', 'gauge', 'Issue run outcomes in the bounded retained window.', [
    metricLine('agent_runner_issue_runs_window_total', issueRuns.filter((row) => row?.exit_code === 0).length, { outcome: 'success' }),
    metricLine('agent_runner_issue_runs_window_total', issueRuns.filter((row) => Number.isInteger(row?.exit_code) && row.exit_code !== 0).length, { outcome: 'failure' }),
  ]));
  blocks.push(...metricBlock('agent_runner_issue_run_duration_seconds', 'gauge', 'Average issue-run duration in the bounded retained window.', [
    metricLine('agent_runner_issue_run_duration_seconds', finiteNumber(dashboard?.metrics?.runs?.averageDurationSeconds)),
  ]));
  blocks.push(...metricBlock('agent_runner_queue_skips_window_total', 'gauge', 'Skip events in the bounded retained window.', [
    metricLine('agent_runner_queue_skips_window_total', finiteNumber(dashboard?.metrics?.queue?.skipEventCount)),
  ]));
  blocks.push(...metricBlock('agent_runner_quota_usage_percent', 'gauge', 'Latest safely projected included-quota usage percent.', [
    metricLine('agent_runner_quota_usage_percent', finiteNumber(dashboard?.metrics?.quota?.latestSessionUsagePercent), { period: 'session' }),
    metricLine('agent_runner_quota_usage_percent', finiteNumber(dashboard?.metrics?.quota?.latestWeeklyUsagePercent), { period: 'week' }),
  ]));

  for (const condition of HEALTH_CONDITION_CODES) {
    const count = (dashboard?.currentHealthConditions || []).filter((row) => row?.condition_type === condition).length;
    blocks.push(...metricBlock(`agent_runner_health_condition_${condition}`, 'gauge', `Whether ${condition} is currently unresolved.`, [
      metricLine(`agent_runner_health_condition_${condition}`, count > 0 ? 1 : 0),
    ]));
  }

  blocks.push(...metricBlock('agent_runner_last_scheduler_poll_timestamp_seconds', 'gauge', 'Timestamp of the latest bounded scheduler poll.', [
    metricLine('agent_runner_last_scheduler_poll_timestamp_seconds', latestTimestamp(latest.runResults, ['created_at', 'started_at'])),
  ]));
  blocks.push(...metricBlock('agent_runner_last_selection_timestamp_seconds', 'gauge', 'Timestamp of the latest bounded issue selection.', [
    metricLine('agent_runner_last_selection_timestamp_seconds', latestTimestamp(latest.selections, ['created_at'])),
  ]));
  blocks.push(...metricBlock('agent_runner_last_claim_timestamp_seconds', 'gauge', 'Timestamp of the latest bounded claim.', [
    metricLine('agent_runner_last_claim_timestamp_seconds', latestTimestamp(latest.claims, ['created_at', 'started_at'])),
  ]));
  blocks.push(...metricBlock('agent_runner_last_terminal_result_timestamp_seconds', 'gauge', 'Timestamp of the latest bounded terminal run result.', [
    metricLine('agent_runner_last_terminal_result_timestamp_seconds', latestTimestamp(latest.runResults, ['finished_at', 'created_at'])),
  ]));
  blocks.push(...metricBlock('agent_runner_dashboard_projection_timestamp_seconds', 'gauge', 'Timestamp of the underlying bounded dashboard projection.', [
    metricLine('agent_runner_dashboard_projection_timestamp_seconds', timestampSeconds(dashboard?.generatedAt)),
  ]));

  return `${blocks.join('\n')}\n`;
}

function baseEvent(dashboard, row, eventType, extras = {}) {
  const repository = boundedRepository(row?.repo);
  const project = boundedToken(row?.project, 64) || projectName(dashboard?.project);
  const issueNumber = Number.isInteger(row?.issue_number) ? row.issue_number : null;
  return {
    timestamp: row?.finished_at || row?.updated_at || row?.created_at || row?.started_at || dashboard?.generatedAt || isoNow(),
    event_type: eventType,
    repository,
    project,
    issue_number: issueNumber,
    phase: boundedToken(row?.phase, 64),
    outcome: boundedReason(extras.outcome),
    reason_code: boundedReason(extras.reasonCode),
    duration_seconds: Number.isFinite(extras.durationSeconds) ? Math.max(0, Math.round(extras.durationSeconds)) : null,
    node: boundedToken(extras.node, 64),
    correlation_id: null,
  };
}

function durationSeconds(row) {
  const started = Date.parse(String(row?.started_at ?? ''));
  const finished = Date.parse(String(row?.finished_at ?? ''));
  return Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? (finished - started) / 1000
    : null;
}

export function buildTypedEvents(dashboard, { node = systemHostname(), limit = MAX_EVENTS } = {}) {
  const latest = dashboard?.latest || {};
  const events = [];
  for (const row of latest.selections || []) {
    events.push(baseEvent(dashboard, row, 'issue_selected', {
      node,
      outcome: row?.selection_mode,
      reasonCode: row?.status_label,
    }));
  }
  for (const row of latest.claims || []) {
    events.push(baseEvent(dashboard, row, 'issue_claimed', { node, outcome: 'claimed' }));
  }
  for (const row of latest.runResults || []) {
    if (row?.mode === 'issue-run') {
      events.push(baseEvent(dashboard, row, row?.exit_code === 0 ? 'run_completed' : 'run_failed', {
        node,
        outcome: row?.exit_code === 0 ? 'success' : 'failure',
        durationSeconds: durationSeconds(row),
      }));
    } else {
      events.push(baseEvent(dashboard, row, 'scheduler_outcome', {
        node,
        outcome: row?.mode,
      }));
    }
  }
  for (const row of latest.quota || []) {
    if (row?.blocked === 1 || row?.blocked === true) {
      events.push(baseEvent(dashboard, row, 'quota_blocked', {
        node,
        outcome: 'blocked',
        reasonCode: row?.reason,
      }));
    }
  }
  for (const row of latest.recoveryAttempts || []) {
    const eventType = !row?.finished_at
      ? 'recovery_started'
      : row?.outcome === 'recovered' || row?.exit_code === 0
        ? 'recovery_completed'
        : 'recovery_failed';
    events.push(baseEvent(dashboard, row, eventType, {
      node,
      outcome: row?.outcome,
      reasonCode: row?.retry_reason,
      durationSeconds: durationSeconds(row),
    }));
  }
  for (const row of latest.attentionEvents || []) {
    events.push(baseEvent(dashboard, row, row?.resolved_at ? 'attention_resolved' : 'attention_opened', {
      node,
      outcome: row?.resolved_at ? 'resolved' : 'open',
      reasonCode: row?.reason,
      durationSeconds: durationSeconds(row),
    }));
  }
  for (const row of latest.healthConditions || []) {
    if (!HEALTH_CONDITION_CODES.has(row?.condition_type)) continue;
    events.push(baseEvent(dashboard, row, row?.resolved_at ? 'health_condition_resolved' : 'health_condition_opened', {
      node,
      outcome: row?.condition_type,
      reasonCode: row?.reason,
    }));
  }

  const seen = new Set();
  return events
    .filter((event) => {
      const key = JSON.stringify(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => timestampSeconds(right.timestamp) - timestampSeconds(left.timestamp))
    .slice(0, Math.min(parseInteger(limit, { fallback: MAX_EVENTS, min: 1, max: MAX_EVENTS }), MAX_EVENTS));
}

export function renderTypedEvents(dashboard, options = {}) {
  const lines = [];
  let bytes = 0;
  for (const event of buildTypedEvents(dashboard, options)) {
    const line = `${JSON.stringify(event)}\n`;
    const nextBytes = Buffer.byteLength(line);
    if (bytes + nextBytes > MAX_EVENT_BYTES) break;
    lines.push(line);
    bytes += nextBytes;
  }
  return lines.join('');
}

export function healthDocument(dashboard) {
  const status = stateStatus(dashboard);
  const schemaCompatible = dashboard?.schemaVersion == null
    ? status === 'missing'
    : dashboard.schemaVersion === RUNNER_STATE_SCHEMA_VERSION;
  const healthy = !['error', 'invalid-path'].includes(status) && schemaCompatible;
  return {
    ok: healthy,
    exporter: 'agent-runner-observability',
    state_status: status,
    schema_compatible: schemaCompatible,
    schema_version: Number.isInteger(dashboard?.schemaVersion) ? dashboard.schemaVersion : null,
    expected_schema_version: RUNNER_STATE_SCHEMA_VERSION,
    operator_status: operatorCode(dashboard),
    generated_at: dashboard?.generatedAt || isoNow(),
  };
}

function writeResponse(response, statusCode, contentType, body, method = 'GET') {
  const payload = method === 'HEAD' ? '' : body;
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function createExporterServer({ dashboardProvider, node = systemHostname() } = {}) {
  if (typeof dashboardProvider !== 'function') throw new Error('dashboardProvider is required');
  return createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      writeResponse(response, 405, 'application/json; charset=utf-8', '{"error":"method-not-allowed"}\n', request.method);
      return;
    }
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    try {
      const dashboard = dashboardProvider();
      if (path === '/metrics') {
        writeResponse(response, 200, 'text/plain; version=0.0.4; charset=utf-8', renderPrometheusMetrics(dashboard), request.method);
        return;
      }
      if (path === '/healthz') {
        const health = healthDocument(dashboard);
        writeResponse(response, health.ok ? 200 : 503, 'application/json; charset=utf-8', `${JSON.stringify(health)}\n`, request.method);
        return;
      }
      if (path === '/events.ndjson') {
        writeResponse(response, 200, 'application/x-ndjson; charset=utf-8', renderTypedEvents(dashboard, { node }), request.method);
        return;
      }
      writeResponse(response, 404, 'application/json; charset=utf-8', '{"error":"not-found"}\n', request.method);
    } catch {
      if (path === '/metrics') {
        writeResponse(response, 500, 'text/plain; version=0.0.4; charset=utf-8', '# HELP agent_runner_exporter_up Whether the exporter generated this response.\n# TYPE agent_runner_exporter_up gauge\nagent_runner_exporter_up 0\n', request.method);
        return;
      }
      writeResponse(response, 503, 'application/json; charset=utf-8', '{"ok":false,"error":"snapshot-unavailable"}\n', request.method);
    }
  });
}

function helpText() {
  return `Usage: node scripts/ops/agent-runner-observability-exporter.mjs [options]\n\nOptions:\n  --config <path>          Agent Runner project config JSON\n  --state-db, --db <path> State SQLite path\n  --host 127.0.0.1        Loopback listener (fixed)\n  --port <1-65535>        Listener port (default: ${DEFAULT_PORT})\n  --history-limit <1-100> Bounded event/history window\n  --help                   Show help\n`;
}

export async function runExporter(argv = process.argv.slice(2), env = process.env) {
  const args = parseExporterArgs(argv, env);
  if (args.help) {
    process.stdout.write(helpText());
    return null;
  }
  const dashboardProvider = () => buildRunnerDashboard(args.dbPath, {
    config: args.config,
    historyLimit: args.historyLimit,
    strict: false,
  });
  const server = createExporterServer({ dashboardProvider, node: env.AGENT_RUNNER_NODE || systemHostname() });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port, args.host, resolve);
  });
  process.stdout.write(`Agent Runner observability exporter listening on http://${args.host}:${args.port}\n`);
  const close = () => server.close(() => process.exit(0));
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runExporter().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
