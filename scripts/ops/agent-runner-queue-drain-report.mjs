#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { loadAgentRunnerConfig } from './agent-runner-config.mjs';
import { inspectQueueDrainIncident } from './agent-runner-queue-drain-classifier.mjs';
import { defaultRunnerStateDbPath, openRunnerStateStore } from './claude-runner-state.mjs';

export function parseReportArgs(argv = process.argv.slice(2), env = process.env) {
  const config = loadAgentRunnerConfig({ argv, env });
  const args = {
    incident: '2026-07-20-queue-drain',
    repo: env.GITHUB_REPOSITORY || config.githubRepo,
    stateDbPath: env.CLAUDE_RUNNER_STATE_DB || config.stateDbPath || defaultRunnerStateDbPath(config.outputDir || '.var/claude-runner'),
    startAt: '2026-07-20T00:00:00.000Z',
    endAt: '2026-07-21T00:00:00.000Z',
    json: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--incident') args.incident = next();
    else if (arg === '--repo') args.repo = next();
    else if (arg === '--state-db') args.stateDbPath = next();
    else if (arg === '--start-at') args.startAt = next();
    else if (arg === '--end-at') args.endAt = next();
    else if (arg === '--json') args.json = true;
    else if (arg === '--dry-run') { /* report-only command; accepted for the future repair interface */ }
    else if (arg === '--config') index += 1;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.incident !== '2026-07-20-queue-drain') throw new Error(`unsupported incident: ${args.incident}`);
  if (!args.repo) throw new Error('repository is required');
  return args;
}

export function buildQueueDrainReport(store, args) {
  const inspected = inspectQueueDrainIncident(store, args);
  return {
    schemaVersion: 'agent-runner-queue-drain-report/v1',
    mode: 'report-only',
    incident: args.incident,
    repository: args.repo,
    startAt: args.startAt,
    endAt: args.endAt,
    issueMutation: false,
    stateMutation: false,
    safeNextAction: inspected.ambiguous > 0
      ? 'Resolve every ambiguous row before preparing a restoration proposal.'
      : 'Use the proven machine-profile false-block set as input to a separate dry-run restoration proposal.',
    ...inspected,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const args = parseReportArgs(argv, env);
  const store = (dependencies.openStore || openRunnerStateStore)(args.stateDbPath);
  try {
    const report = buildQueueDrainReport(store, args);
    (dependencies.logger || console).log(JSON.stringify(report, null, 2));
    return report.ambiguous > 0 ? 2 : 0;
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
}
