#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { defaultRunnerStateDbPath, repairFalseDryRunAttention, summarizeRunnerState } from './claude-runner-state.mjs';

function defaultDbPathFromEnv(env = process.env) {
  return env.CLAUDE_RUNNER_STATE_DB || defaultRunnerStateDbPath(env.CLAUDE_RUNNER_OUTPUT_DIR || '.var/claude-runner');
}

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = {
    dbPath: defaultDbPathFromEnv(env),
    historyLimit: 5,
    strict: false,
    pretty: false,
    repairDryRunFalseAttention: false,
    apply: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--db' || arg === '--state-db') {
      args.dbPath = argv[++i];
    } else if (arg.startsWith('--db=')) {
      args.dbPath = arg.slice('--db='.length);
    } else if (arg.startsWith('--state-db=')) {
      args.dbPath = arg.slice('--state-db='.length);
    } else if (arg === '--history-limit') {
      args.historyLimit = Number.parseInt(argv[++i], 10);
    } else if (arg.startsWith('--history-limit=')) {
      args.historyLimit = Number.parseInt(arg.slice('--history-limit='.length), 10);
    } else if (arg === '--strict') {
      args.strict = true;
    } else if (arg === '--pretty') {
      args.pretty = true;
    } else if (arg === '--repair-dry-run-false-attention') {
      args.repairDryRunFalseAttention = true;
    } else if (arg === '--apply') {
      args.apply = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (args.apply && !args.repairDryRunFalseAttention) {
    throw new Error('--apply requires --repair-dry-run-false-attention');
  }

  return args;
}

function helpText() {
  return `Usage: node scripts/ops/claude-runner-state-doctor.mjs [options]\n\nOptions:\n  --db, --state-db <path>       SQLite runner state DB path\n  --history-limit <number>      Number of latest rows per table to include, default 5\n  --strict                      Exit non-zero when the DB is missing or unhealthy\n  --pretty                      Print a compact human-readable summary\n  --repair-dry-run-false-attention\n                                Report exact #725 false dry-run rows (no mutation by default)\n  --apply                       Apply the requested repair transaction\n  -h, --help                    Show this help\n`;
}

function prettyPrint(summary) {
  const lines = [
    `runner state: ${summary.status}`,
    `ok: ${summary.ok ? 'yes' : 'no'}`,
    `db: ${summary.dbPath}`,
    `schema: ${summary.schemaVersion ?? 'n/a'}`,
  ];

  if (summary.message) lines.push(`message: ${summary.message}`);
  if (summary.error) lines.push(`error: ${summary.error.name}: ${summary.error.message}`);

  lines.push('counts:');
  for (const [table, count] of Object.entries(summary.counts || {})) {
    lines.push(`  ${table}: ${count}`);
  }

  if (summary.repair) {
    lines.push('repair:');
    lines.push(`  mode: ${summary.repair.mode}`);
    lines.push(`  candidates found: ${summary.repair.candidatesFound}`);
    lines.push(`  candidates repaired: ${summary.repair.candidatesRepaired}`);
    lines.push(`  skipped ambiguous: ${summary.repair.candidatesSkippedAmbiguous}`);
    const ids = summary.repair.mode === 'apply' ? summary.repair.affected : summary.repair.wouldRepair;
    lines.push(`  run result ids: ${(ids?.runResultIds || []).join(', ') || 'none'}`);
    lines.push(`  attempt ids: ${(ids?.attemptIds || []).join(', ') || 'none'}`);
    lines.push(`  attention event ids: ${(ids?.attentionEventIds || []).join(', ') || 'none'}`);
  }

  return `${lines.join('\n')}\n`;
}

function repairOutputSummary(summary, repair) {
  // Ordinary state-doctor JSON includes latest persisted rows for local
  // diagnosis. A repair report has a stricter contract: exact affected IDs
  // and counts only, never raw run/attempt/health payloads or restricted
  // recovery handles. Keep the normal diagnostic shape unchanged unless the
  // operator explicitly requested this repair command.
  const { latest: _latest, currentHealthConditions: healthConditions, ...safe } = summary;
  return {
    ...safe,
    currentHealthConditionCount: Array.isArray(healthConditions) ? healthConditions.length : 0,
    repair,
  };
}

export function run(argv = process.argv.slice(2), env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  let args;
  try {
    args = parseArgs(argv, env);
  } catch (error) {
    io.stderr.write(`${error.message}\n\n${helpText()}`);
    return 2;
  }

  if (args.help) {
    io.stdout.write(helpText());
    return 0;
  }

  let repair = null;
  if (args.repairDryRunFalseAttention && existsSync(args.dbPath)) {
    try {
      repair = repairFalseDryRunAttention(args.dbPath, { execute: args.apply });
    } catch (error) {
      const failure = { ok: false, status: 'repair-error', dbPath: args.dbPath, error: { name: error?.name || 'Error', message: error?.message || String(error) } };
      io.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
      return 1;
    }
  }

  const summary = summarizeRunnerState(args.dbPath, {
    historyLimit: args.historyLimit,
    requireExisting: args.strict,
  });
  if (args.repairDryRunFalseAttention && !repair) {
    repair = {
      mode: args.apply ? 'apply' : 'report-only',
      candidatesFound: 0,
      candidatesEligible: 0,
      candidatesRepaired: 0,
      candidatesSkippedAmbiguous: 0,
      wouldRepair: { runResultIds: [], attemptIds: [], attentionEventIds: [] },
      affected: { runResultIds: [], attemptIds: [], attentionEventIds: [] },
      skipped: [],
      reason: 'state-db-missing',
    };
  }
  const output = repair ? repairOutputSummary(summary, repair) : summary;

  io.stdout.write(args.pretty ? prettyPrint(output) : `${JSON.stringify(output, null, 2)}\n`);
  if (args.apply && repair?.reason === 'state-db-missing') return 1;
  return args.strict && !summary.ok ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run();
}
