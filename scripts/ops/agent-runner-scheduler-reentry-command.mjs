#!/usr/bin/env node
import process from 'node:process';
import { IssueReconciliationStore } from './agent-runner-issue-reconciliation-store.mjs';
import {
  classifyProductionHandoffResult,
  runSchedulerReentryCycle,
  SchedulerReentryStore,
} from './agent-runner-scheduler-reentry.mjs';

/**
 * Hands one bounded pass off to the existing production scheduler entrypoint
 * (`claude-runner-cron.mjs`'s `main()`) exactly as an operator or the
 * systemd timer already invokes it -- same argv/env, same file lock, same
 * atomic admission/claim/workspace/worker-launch code. This introduces no
 * second claim, worker-launch or GitHub-mutation implementation: it only
 * captures that one call's own terminal JSON result (`main()` prints exactly
 * one `console.log(JSON.stringify(...))` line per pass, on every terminal
 * branch) so the reentry cycle can classify what actually happened. Capture
 * is local to this one call and always restored, even if `main()` throws.
 */
export async function runProductionCronPass(argv, env, { cronMain } = {}) {
  const mainFn = cronMain || (await import('./claude-runner-cron.mjs')).main;
  const captured = [];
  const originalLog = console.log;
  console.log = (...logArgs) => { captured.push(logArgs); };
  try {
    await mainFn(argv, env);
  } finally {
    console.log = originalLog;
  }
  for (let index = captured.length - 1; index >= 0; index -= 1) {
    const [first] = captured[index];
    if (typeof first !== 'string') continue;
    try {
      return JSON.parse(first);
    } catch {
      // Not the terminal JSON line -- keep scanning earlier captured calls.
    }
  }
  return {};
}

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
      // Hands the bounded next-candidate pass to the existing production
      // entrypoint (`claude-runner-cron.mjs`'s `main()`), driven by the
      // exact same argv/env an operator or the systemd timer would supply
      // (`rest`/`process.env`, unmodified -- no forced --dry-run). This is
      // what actually closes the #157 loop: a completed reconciliation can
      // now reach a real claim/workspace/worker-launch, not merely a probe.
      // An explicit --dry-run in `rest`, or an unset CLAUDE_RUNNER_CRON_EXECUTE,
      // still yields the same safe, zero-mutation pass `main()` already
      // guarantees for that case.
      selectNextCandidate: async () => {
        const payload = await runProductionCronPass(rest, process.env);
        return classifyProductionHandoffResult(payload);
      },
    });
    output({ schemaVersion: 1, ok: true, ...result });
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], `file://${process.cwd()}/`).href
  : false;

if (invokedAsScript) {
  main().catch((error) => {
    output({ schemaVersion: 1, ok: false, errorCode: typeof error?.code === 'string' ? error.code : 'scheduler-reentry-failed' });
    process.exitCode = 1;
  });
}
