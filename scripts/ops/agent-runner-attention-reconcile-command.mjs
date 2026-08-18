#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadAgentRunnerConfig } from './agent-runner-config.mjs';
import { readOnlyRunnerStateSnapshot } from './agent-runner-operator-doctor.mjs';
import { defaultRunnerStateDbPath } from './claude-runner-state.mjs';
import { AttentionReconciliationStore } from './agent-runner-attention-reconciliation-store.mjs';
import { GhCliReconciliationClient } from './agent-runner-issue-reconciliation.mjs';
import { reconcileAttentionEvents } from './agent-runner-attention-reconciliation.mjs';

function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('invalid arguments');
    parsed[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return parsed;
}

/**
 * Read-only against the runner state DB (reuses the same private-snapshot
 * path as the operator CLI/dashboard), read-only against GitHub, and only
 * ever writes to the dedicated attention-reconciliation store -- never to
 * `attention_events` and never to GitHub issue state (#183).
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const config = loadAgentRunnerConfig({ env });
  if (!config.githubRepo) throw new Error('config.githubRepo is required for repository-qualified reconciliation');

  const stateDbPath = args['state-db'] || env.CLAUDE_RUNNER_STATE_DB || config.stateDbPath || defaultRunnerStateDbPath(config.outputDir || '.var/claude-runner');
  const reconciliationDbPath = args['reconciliation-db'] || env.CLAUDE_RUNNER_ATTENTION_RECONCILIATION_DB
    || `${config.outputDir || '.var/claude-runner'}/attention-reconciliation.sqlite`;

  const snapshot = readOnlyRunnerStateSnapshot(stateDbPath, { historyLimit: 200, includeLatest: true });
  if (!snapshot.ok) throw Object.assign(new Error('runner state is unavailable'), { code: 'state-unavailable' });

  const repositoryScopedEvents = (snapshot.latest.attentionEvents || []).filter((row) => row.repo === config.githubRepo);

  const store = new AttentionReconciliationStore(reconciliationDbPath);
  try {
    const results = reconcileAttentionEvents({
      attentionEvents: repositoryScopedEvents,
      store,
      client: new GhCliReconciliationClient(),
    });
    output({
      schemaVersion: 1,
      ok: true,
      repository: config.githubRepo,
      reconciledCount: results.length,
      historicalCount: results.filter((row) => row.status === 'historical').length,
      actionableCount: results.filter((row) => row.status === 'actionable').length,
      unknownCount: results.filter((row) => row.status === 'unknown').length,
    });
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    output({ schemaVersion: 1, ok: false, errorCode: typeof error?.code === 'string' ? error.code : 'attention-reconciliation-failed' });
    process.exitCode = 1;
  });
}
