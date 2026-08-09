#!/usr/bin/env node
import process from 'node:process';
import { IssueReconciliationStore } from './agent-runner-issue-reconciliation-store.mjs';
import { SchedulerReentryStore, runSchedulerReentryCycle } from './agent-runner-scheduler-reentry.mjs';

function args(argv) {
  const parsed = {};
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--reconciliation-db' || key === '--reentry-db' || key === '--transaction-id') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
      parsed[key.slice(2)] = value;
      index += 1;
      continue;
    }
    rest.push(key);
  }
  for (const key of ['reconciliation-db', 'reentry-db', 'transaction-id']) {
    if (!parsed[key]) throw new Error('missing argument');
  }
  return { parsed, rest };
}

function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function main() {
  if (process.getuid?.() === 0) throw Object.assign(new Error('root is not permitted'), { code: 'root-not-permitted' });
  const { parsed, rest } = args(process.argv.slice(2));
  const reconciliationStore = new IssueReconciliationStore(parsed['reconciliation-db']);
  const reentryStore = new SchedulerReentryStore(parsed['reentry-db']);
  try {
    const result = await runSchedulerReentryCycle({
      reconciliationStore,
      reentryStore,
      transactionId: parsed['transaction-id'],
      // Reuses the existing, already-tested selection contract exactly as
      // `claude-runner-candidate-probe.mjs` invokes it: a dry-run, no-quota
      // scan that never claims an issue, launches a worker or calls a model.
      selectNextCandidate: async () => {
        const { parseArgs, selectIssue } = await import('./claude-runner-cron.mjs');
        const selectArgs = parseArgs([...rest, '--dry-run', '--skip-quota-preflight'], process.env);
        return selectIssue(selectArgs);
      },
    });
    output({ schemaVersion: 1, ok: true, ...result });
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
}

main().catch((error) => {
  output({ schemaVersion: 1, ok: false, errorCode: typeof error?.code === 'string' ? error.code : 'scheduler-reentry-failed' });
  process.exitCode = 1;
});
