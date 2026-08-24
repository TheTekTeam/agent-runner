import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openRunnerStateStore } from './claude-runner-state.mjs';
import {
  buildTypedEvents,
  createExporterServer,
  healthDocument,
  parseExporterArgs,
  readRunnerProjection,
  renderPrometheusMetrics,
  renderTypedEvents,
} from './agent-runner-observability-exporter.mjs';

function fakeDashboard(overrides = {}) {
  return {
    ok: true,
    status: 'ok',
    generatedAt: '2026-08-04T15:00:00.000Z',
    schemaVersion: 16,
    project: { project: 'modelspend' },
    counts: {
      queue_events: 12,
      quota_history: 3,
      preflight_packets: 2,
      issue_selections: 4,
      claims: 4,
      run_results: 5,
      recovery_attempts: 1,
      recovery_revalidations: 0,
      attention_events: 1,
      runner_health_conditions: 1,
      routing_events: 2,
      notification_events: 1,
    },
    latest: {
      selections: [{
        repo: 'TheTekTeam/modelspend',
        project: 'modelspend',
        issue_number: 759,
        selection_mode: 'manager-authority',
        status_label: 'status:ready',
        created_at: '2026-08-04T14:50:00.000Z',
        payload: { rawPrompt: 'DO-NOT-EXPORT' },
      }],
      claims: [{
        repo: 'TheTekTeam/modelspend',
        issue_number: 759,
        created_at: '2026-08-04T14:51:00.000Z',
        log_path: '/secret/local/path',
      }],
      runResults: [{
        repo: 'TheTekTeam/modelspend',
        issue_number: 759,
        mode: 'issue-run',
        exit_code: 0,
        started_at: '2026-08-04T14:52:00.000Z',
        finished_at: '2026-08-04T14:57:00.000Z',
      }],
      recoveryAttempts: [{
        repo: 'TheTekTeam/modelspend',
        project: 'modelspend',
        issue_number: 759,
        phase: 'validation',
        agent: 'claude-code-cli',
        started_at: '2026-08-04T14:52:00.000Z',
        finished_at: '2026-08-04T14:57:00.000Z',
        outcome: 'recovered',
        exit_code: 0,
        payload_json: 'DO-NOT-EXPORT',
      }],
      quota: [{
        blocked: 0,
        session_usage_percent: 23,
        weekly_usage_percent: 47,
        created_at: '2026-08-04T14:49:00.000Z',
      }],
      attentionEvents: [{
        repo: 'TheTekTeam/modelspend',
        project: 'modelspend',
        issue_number: 758,
        reason: 'validation_failed',
        created_at: '2026-08-04T13:00:00.000Z',
        resolved_at: null,
        event_json: 'DO-NOT-EXPORT',
      }],
      healthConditions: [{
        repo: 'TheTekTeam/modelspend',
        condition_type: 'queue_inspection_degraded',
        reason: 'github_unavailable',
        opened_at: '2026-08-04T12:00:00.000Z',
        updated_at: '2026-08-04T12:01:00.000Z',
        resolved_at: null,
      }],
      notifications: [{ delivery_status: 'pending', resolved_at: null }],
      queueEvents: [],
      preflights: [],
    },
    currentHealthConditions: [{ condition_type: 'queue_inspection_degraded' }],
    metrics: {
      runs: { averageDurationSeconds: 300 },
      queue: { skipEventCount: 2 },
      quota: { latestSessionUsagePercent: 23, latestWeeklyUsagePercent: 47 },
    },
    activity: {
      activeIssue: {
        repo: 'TheTekTeam/modelspend',
        issue_number: 759,
        agent: 'claude-code-cli',
        assignment_label: 'agent:codex-claude',
      },
    },
    operatorStatus: { code: 'queue_moving' },
    ...overrides,
  };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('read-only projection does not mutate the SQLite database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-runner-observability-'));
  const dbPath = join(directory, 'runner-state.sqlite');
  try {
    const store = openRunnerStateStore(dbPath, { now: () => '2026-08-04T15:00:00.000Z' });
    store.close();
    const before = sha256(dbPath);
    const projection = readRunnerProjection(dbPath, {
      config: {
        projectId: 'modelspend',
        displayName: 'ModelSpend',
        githubRepo: 'TheTekTeam/modelspend',
      },
      historyLimit: 5,
      now: () => '2026-08-04T15:01:00.000Z',
    });
    const after = sha256(dbPath);

    assert.equal(projection.status, 'ok');
    assert.equal(projection.schemaVersion, 16);
    assert.equal(projection.project.project, 'modelspend');
    assert.equal(after, before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Prometheus projection uses bounded labels and excludes raw fields', () => {
  const metrics = renderPrometheusMetrics(fakeDashboard(), { now: Date.parse('2026-08-04T15:01:00.000Z') });
  assert.match(metrics, /agent_runner_exporter_up 1/);
  assert.match(metrics, /agent_runner_current_issue_info\{[^\n]*issue_number="759"/);
  assert.match(metrics, /agent_runner_quota_usage_percent\{period="session"\} 23/);
  assert.doesNotMatch(metrics, /DO-NOT-EXPORT|secret\/local\/path|payload_json|event_json/);
});

test('typed event feed is positive-allowlisted and bounded', () => {
  const events = buildTypedEvents(fakeDashboard(), { node: 'dev-cluster-dell' });
  assert.ok(events.length > 0);
  const allowed = new Set([
    'timestamp', 'event_type', 'repository', 'project', 'issue_number', 'phase',
    'outcome', 'reason_code', 'duration_seconds', 'node', 'correlation_id',
  ]);
  for (const event of events) {
    assert.deepEqual(new Set(Object.keys(event)), allowed);
  }
  const rendered = renderTypedEvents(fakeDashboard(), { node: 'dev-cluster-dell' });
  assert.doesNotMatch(rendered, /DO-NOT-EXPORT|secret\/local\/path|payload_json|event_json/);
  assert.ok(Buffer.byteLength(rendered) <= 256 * 1024);
});

test('health distinguishes missing state from incompatible or failed state', () => {
  assert.equal(healthDocument(fakeDashboard({ status: 'missing', schemaVersion: null })).ok, true);
  assert.equal(healthDocument(fakeDashboard({ status: 'error' })).ok, false);
  assert.equal(healthDocument(fakeDashboard({ schemaVersion: 999 })).ok, false);
});

test('argument parser rejects non-loopback bind requests', () => {
  const config = join(process.cwd(), 'config/modelspend.example.json');
  assert.throws(
    () => parseExporterArgs(['--config', config, '--host', '0.0.0.0']),
    /must bind to 127\.0\.0\.1/,
  );
});

test('HTTP server exposes only the documented read-only endpoints', async (context) => {
  const server = createExporterServer({ dashboardProvider: () => fakeDashboard(), node: 'dev-cluster-dell' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).exporter, 'agent-runner-observability');

  const metrics = await fetch(`${base}/metrics`);
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /agent_runner_operator_status/);

  const events = await fetch(`${base}/events.ndjson`);
  assert.equal(events.status, 200);
  assert.match(events.headers.get('content-type'), /application\/x-ndjson/);

  const missing = await fetch(`${base}/sql`);
  assert.equal(missing.status, 404);

  const writeAttempt = await fetch(`${base}/metrics`, { method: 'POST' });
  assert.equal(writeAttempt.status, 405);
});
