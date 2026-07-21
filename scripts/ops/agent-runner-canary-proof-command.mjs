#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadAgentRunnerConfig } from './agent-runner-config.mjs';
import { inspectCanaryProof } from './agent-runner-canary-proof.mjs';
import { defaultRunnerStateDbPath, openRunnerStateStore } from './claude-runner-state.mjs';

export function parseCanaryProofArgs(argv = process.argv.slice(2), env = process.env) {
  const config = loadAgentRunnerConfig({ argv, env });
  const args = {
    issueNumber: null,
    dashboardPath: null,
    stateDbPath: env.CLAUDE_RUNNER_STATE_DB || config.stateDbPath || defaultRunnerStateDbPath(config.outputDir || '.var/claude-runner'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--issue') args.issueNumber = Number(next());
    else if (arg === '--dashboard-snapshot') args.dashboardPath = next();
    else if (arg === '--state-db') args.stateDbPath = next();
    else if (arg === '--config') index += 1;
    else if (arg === '--json') { /* JSON is the only supported output format. */ }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.issueNumber) || args.issueNumber < 1) throw new Error('--issue must be a positive integer');
  if (!args.dashboardPath) throw new Error('--dashboard-snapshot is required');
  return args;
}

export function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const args = parseCanaryProofArgs(argv, env);
  const dashboardSnapshot = JSON.parse((dependencies.readFile || readFileSync)(args.dashboardPath, 'utf8'));
  const store = (dependencies.openStore || openRunnerStateStore)(args.stateDbPath);
  try {
    const report = inspectCanaryProof(store, { issueNumber: args.issueNumber, dashboardSnapshot });
    console.log(JSON.stringify(report, null, 2));
    return report.passed ? 0 : 3;
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: 'agent-runner-canary-proof/v1',
      passed: false,
      systemicFailure: true,
      reason: String(error?.message || error),
      safeNextAction: 'Repair the proof inputs or state store before attempting the canary gate again.',
    }, null, 2));
    process.exitCode = 1;
  }
}
