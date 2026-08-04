import { createServer } from 'node:http';
import { RUNNER_STATE_SCHEMA_VERSION } from './claude-runner-state.mjs';
import { OPERATOR_CODES, STATE_STATUSES, isoNow } from './agent-runner-observability-common.mjs';
import { renderTypedEvents } from './agent-runner-observability-events.mjs';
import { renderPrometheusMetrics } from './agent-runner-observability-metrics.mjs';

function stateStatus(dashboard) { return STATE_STATUSES.has(dashboard?.status) ? dashboard.status : 'error'; }
function operatorCode(dashboard) { return OPERATOR_CODES.has(dashboard?.operatorStatus?.code) ? dashboard.operatorStatus.code : 'idle'; }

export function healthDocument(dashboard) {
  const status = stateStatus(dashboard);
  const schemaCompatible = dashboard?.schemaVersion == null ? status === 'missing' : dashboard.schemaVersion === RUNNER_STATE_SCHEMA_VERSION;
  return {
    ok: !['error','invalid-path'].includes(status) && schemaCompatible,
    exporter: 'agent-runner-observability', state_status: status,
    schema_compatible: schemaCompatible,
    schema_version: Number.isInteger(dashboard?.schemaVersion) ? dashboard.schemaVersion : null,
    expected_schema_version: RUNNER_STATE_SCHEMA_VERSION,
    operator_status: operatorCode(dashboard), generated_at: dashboard?.generatedAt || isoNow(),
  };
}

function write(response, status, type, body, method) {
  const payload = method === 'HEAD' ? '' : body;
  response.writeHead(status, {
    'Content-Type': type, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function createExporterServer({ dashboardProvider, node } = {}) {
  if (typeof dashboardProvider !== 'function') throw new Error('dashboardProvider is required');
  return createServer((request, response) => {
    if (!['GET','HEAD'].includes(request.method)) {
      write(response, 405, 'application/json; charset=utf-8', '{"error":"method-not-allowed"}\n', request.method);
      return;
    }
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    try {
      const dashboard = dashboardProvider();
      if (path === '/metrics') write(response, 200, 'text/plain; version=0.0.4; charset=utf-8', renderPrometheusMetrics(dashboard), request.method);
      else if (path === '/healthz') {
        const health = healthDocument(dashboard);
        write(response, health.ok ? 200 : 503, 'application/json; charset=utf-8', `${JSON.stringify(health)}\n`, request.method);
      } else if (path === '/events.ndjson') write(response, 200, 'application/x-ndjson; charset=utf-8', renderTypedEvents(dashboard, { node }), request.method);
      else write(response, 404, 'application/json; charset=utf-8', '{"error":"not-found"}\n', request.method);
    } catch {
      if (path === '/metrics') write(response, 500, 'text/plain; version=0.0.4; charset=utf-8', '# HELP agent_runner_exporter_up Whether the exporter generated this response.\n# TYPE agent_runner_exporter_up gauge\nagent_runner_exporter_up 0\n', request.method);
      else write(response, 503, 'application/json; charset=utf-8', '{"ok":false,"error":"snapshot-unavailable"}\n', request.method);
    }
  });
}
