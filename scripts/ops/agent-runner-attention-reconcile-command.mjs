#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadAgentRunnerConfig } from './agent-runner-config.mjs';
import { readOnlyRunnerStateSnapshot } from './agent-runner-operator-doctor.mjs';
import { defaultRunnerStateDbPath } from './claude-runner-state.mjs';
import { GhCliAttentionReadClient } from './agent-runner-attention-github-client.mjs';
import { resolveAttentionReconciliationDbPath, resolveRunnerOutputDir } from './agent-runner-attention-reconciliation-path.mjs';
import { AttentionReconciliationStore } from './agent-runner-attention-reconciliation-store.mjs';
import { attentionSourceSnapshotDigest, buildAttentionReconciliationProjection, reconcileAttentionEvents } from './agent-runner-attention-reconciliation.mjs';

const output = (value, io = process.stdout) => io.write(`${JSON.stringify(value)}\n`);

export function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--')) throw Object.assign(new Error('invalid arguments'), { code: 'invalid-arguments' });
    parsed[key.slice(2)] = argv[index + 1]; index += 1;
  }
  return parsed;
}

function scoped(snapshot, repository) {
  const source = snapshot.attentionSource || snapshot.latest || {};
  const attentionEvents = (source.attentionEvents || []).filter((row) => row.repo === repository && !row.resolved_at);
  const attempts = source.recoveryAttempts || [];
  return { attentionEvents, attempts, total: Number.isInteger(source.total) ? source.total : attentionEvents.length, overflow: source.overflow === true };
}

export function runAttentionReconciliation({
  argv = [], env = process.env, config = loadAgentRunnerConfig({ env }),
  snapshotReader = readOnlyRunnerStateSnapshot, client = new GhCliAttentionReadClient(),
  storeFactory = (path) => new AttentionReconciliationStore(path), now = () => new Date().toISOString(),
} = {}) {
  const args = parseArgs(argv);
  if (!config.githubRepo) throw Object.assign(new Error('repository is required'), { code: 'repository-required' });
  const outputDir = resolveRunnerOutputDir(env, config);
  const stateDbPath = args['state-db'] || env.CLAUDE_RUNNER_STATE_DB || config.stateDbPath || defaultRunnerStateDbPath(outputDir);
  const reconciliationDbPath = resolveAttentionReconciliationDbPath({ explicitPath: args['reconciliation-db'], env, config });
  const read = () => snapshotReader(stateDbPath, { historyLimit: 50, includeLatest: true, attentionRepository: config.githubRepo });
  const initial = read();
  if (!initial.ok) throw Object.assign(new Error('runner state is unavailable'), { code: 'state-unavailable' });
  const source = scoped(initial, config.githubRepo);
  const sourceDigest = attentionSourceSnapshotDigest(source.attentionEvents, source.attempts);
  const store = storeFactory(reconciliationDbPath);
  const generationId = randomUUID();
  const startedAt = now();
  try {
    let state;
    try {
      state = reconcileAttentionEvents({
        repository: config.githubRepo, ...source, store, client, now, generationId,
        verifySource: () => {
          const current = read();
          if (!current.ok) return false;
          const latest = scoped(current, config.githubRepo);
          return latest.total === source.total && latest.overflow === source.overflow
            && attentionSourceSnapshotDigest(latest.attentionEvents, latest.attempts) === sourceDigest;
        },
      });
    } catch (error) {
      const failureCode = ['attention-source-changed', 'attention-event-bound-exceeded', 'attention-issue-bound-exceeded']
        .includes(error?.code) ? error.code : 'attention-reconciliation-failed';
      store.recordGenerationOutcome({ generationId, repository: config.githubRepo,
        state: failureCode === 'attention-source-changed' ? 'superseded' : 'failed',
        sourceSnapshotDigest: sourceDigest, sourceEventCount: source.total, startedAt,
        completedAt: now(), failureCode, unknownCount: source.total });
      throw Object.assign(new Error(failureCode), { code: failureCode });
    }
    const projection = buildAttentionReconciliationProjection(source.attentionEvents, source.attempts, state, {
      repository: config.githubRepo, now: now(), sourceTotal: source.total, sourceOverflow: source.overflow,
    });
    return {
      schemaVersion: 2, ok: true, repository: config.githubRepo,
      reconciledCount: source.attentionEvents.length,
      actionableCount: projection.counts.actionable, historicalCount: projection.counts.historical,
      unknownCount: projection.counts.unknown, staleCount: projection.counts.stale,
    };
  } finally { store.close(); }
}

export async function main(argv = process.argv.slice(2), env = process.env, io = process.stdout) {
  output(runAttentionReconciliation({ argv, env }), io);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    output({ schemaVersion: 2, ok: false, errorCode: typeof error?.code === 'string' ? error.code : 'attention-reconciliation-failed' });
    process.exitCode = 1;
  });
}
