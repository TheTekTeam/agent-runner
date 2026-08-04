#!/usr/bin/env node
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';

import { loadAgentRunnerConfig, stripConfigArgs } from './agent-runner-config.mjs';
import { defaultRunnerStateDbPath } from './claude-runner-state.mjs';
import { DEFAULT_HISTORY_LIMIT, DEFAULT_PORT, LOOPBACK_HOST, MAX_HISTORY_LIMIT, parseInteger } from './agent-runner-observability-common.mjs';
import { buildTypedEvents, renderTypedEvents } from './agent-runner-observability-events.mjs';
import { createExporterServer, healthDocument } from './agent-runner-observability-http.mjs';
import { renderPrometheusMetrics } from './agent-runner-observability-metrics.mjs';
import { readRunnerProjection } from './agent-runner-observability-projection.mjs';

export { buildTypedEvents, createExporterServer, healthDocument, readRunnerProjection, renderPrometheusMetrics, renderTypedEvents };

function defaultDbPath(env, config) {
  return env.CLAUDE_RUNNER_STATE_DB || config.stateDbPath || defaultRunnerStateDbPath(env.CLAUDE_RUNNER_OUTPUT_DIR || config.outputDir || '.var/claude-runner');
}

export function parseExporterArgs(argv = process.argv.slice(2), env = process.env) {
  const config = loadAgentRunnerConfig({ argv, env });
  argv = stripConfigArgs(argv);
  const args = {
    config, dbPath: defaultDbPath(env, config),
    host: env.AGENT_RUNNER_OBSERVABILITY_HOST || LOOPBACK_HOST,
    port: parseInteger(env.AGENT_RUNNER_OBSERVABILITY_PORT, { fallback: DEFAULT_PORT, min: 1, max: 65535 }),
    historyLimit: parseInteger(env.AGENT_RUNNER_OBSERVABILITY_HISTORY_LIMIT, { fallback: DEFAULT_HISTORY_LIMIT, min: 1, max: MAX_HISTORY_LIMIT }),
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--db' || arg === '--state-db') args.dbPath = argv[++index];
    else if (arg.startsWith('--db=')) args.dbPath = arg.slice(5);
    else if (arg.startsWith('--state-db=')) args.dbPath = arg.slice(11);
    else if (arg === '--host') args.host = argv[++index];
    else if (arg.startsWith('--host=')) args.host = arg.slice(7);
    else if (arg === '--port') args.port = parseInteger(argv[++index], { fallback: -1, min: 1, max: 65535 });
    else if (arg.startsWith('--port=')) args.port = parseInteger(arg.slice(7), { fallback: -1, min: 1, max: 65535 });
    else if (arg === '--history-limit') args.historyLimit = parseInteger(argv[++index], { fallback: -1, min: 1, max: MAX_HISTORY_LIMIT });
    else if (arg.startsWith('--history-limit=')) args.historyLimit = parseInteger(arg.slice(16), { fallback: -1, min: 1, max: MAX_HISTORY_LIMIT });
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (args.host !== LOOPBACK_HOST) throw new Error(`Observability exporter must bind to ${LOOPBACK_HOST}; received ${JSON.stringify(args.host)}`);
  if (!Number.isInteger(args.port) || args.port < 1) throw new Error('Observability exporter port is invalid');
  if (!Number.isInteger(args.historyLimit) || args.historyLimit < 1) throw new Error('Observability history limit is invalid');
  return args;
}

function help() {
  return `Usage: node scripts/ops/agent-runner-observability-exporter.mjs [options]\n\nOptions:\n  --config <path>          Agent Runner project config JSON\n  --state-db, --db <path> State SQLite path\n  --host 127.0.0.1        Loopback listener (fixed)\n  --port <1-65535>        Listener port (default: ${DEFAULT_PORT})\n  --history-limit <1-100> Bounded event/history window\n  --help                   Show help\n`;
}

export async function runExporter(argv = process.argv.slice(2), env = process.env) {
  const args = parseExporterArgs(argv, env);
  if (args.help) { process.stdout.write(help()); return null; }
  const dashboardProvider = () => readRunnerProjection(args.dbPath, { config: args.config, historyLimit: args.historyLimit });
  const server = createExporterServer({ dashboardProvider, node: env.AGENT_RUNNER_NODE || hostname() });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(args.port, args.host, resolve); });
  process.stdout.write(`Agent Runner observability exporter listening on http://${args.host}:${args.port}\n`);
  const close = () => server.close(() => process.exit(0));
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runExporter().catch((error) => { process.stderr.write(`${error?.message || error}\n`); process.exitCode = 1; });
}
