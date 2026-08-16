#!/usr/bin/env node
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildRunnerDashboard } from './claude-runner-dashboard-api.mjs';
import { defaultRunnerStateDbPath } from './claude-runner-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const DEFAULT_SOURCE_DIR = join(REPO_ROOT, '.agent-runner/dashboard');
const DEFAULT_OUTPUT_DIR = DEFAULT_SOURCE_DIR;

function defaultDbPathFromEnv(env = process.env) {
  return env.CLAUDE_RUNNER_STATE_DB || defaultRunnerStateDbPath(env.CLAUDE_RUNNER_OUTPUT_DIR || '.var/claude-runner');
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = {
    dbPath: defaultDbPathFromEnv(env),
    outDir: env.CLAUDE_RUNNER_DASHBOARD_DIR || DEFAULT_OUTPUT_DIR,
    historyLimit: 20,
    strict: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--db' || arg === '--state-db') args.dbPath = argv[++i];
    else if (arg.startsWith('--db=')) args.dbPath = arg.slice('--db='.length);
    else if (arg.startsWith('--state-db=')) args.dbPath = arg.slice('--state-db='.length);
    else if (arg === '--out-dir') args.outDir = argv[++i];
    else if (arg.startsWith('--out-dir=')) args.outDir = arg.slice('--out-dir='.length);
    else if (arg === '--history-limit' || arg === '--limit') args.historyLimit = Number.parseInt(argv[++i], 10) || args.historyLimit;
    else if (arg.startsWith('--history-limit=')) args.historyLimit = Number.parseInt(arg.slice('--history-limit='.length), 10) || args.historyLimit;
    else if (arg.startsWith('--limit=')) args.historyLimit = Number.parseInt(arg.slice('--limit='.length), 10) || args.historyLimit;
    else if (arg === '--strict') args.strict = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

function helpText() {
  return `Usage: node scripts/ops/claude-runner-dashboard-local.mjs [options]\n\nOptions:\n  --db, --state-db <path>       SQLite runner state DB path\n  --out-dir <path>              Directory for local dashboard files\n  --history-limit, --limit <n>  Number of latest rows per dashboard section, default 20\n  --strict                      Exit non-zero when the DB is missing or unhealthy\n  -h, --help                    Show this help\n`;
}

export function writeLocalDashboard({ dbPath, outDir = DEFAULT_OUTPUT_DIR, historyLimit = 20, strict = false } = {}) {
  const dashboard = buildRunnerDashboard(dbPath, { historyLimit, strict });
  mkdirSync(outDir, { recursive: true });
  for (const file of ['index.html', 'dashboard.js', 'styles.css', 'favicon.ico']) {
    const source = join(DEFAULT_SOURCE_DIR, file);
    const target = join(outDir, file);
    if (resolve(source) !== resolve(target)) copyFileSync(source, target);
  }
  const dataPath = join(outDir, 'dashboard-data.js');
  writeFileSync(dataPath, `window.RUNNER_DASHBOARD_DATA = ${JSON.stringify(dashboard, null, 2)};\n`);
  return { dashboard, outDir, indexPath: join(outDir, 'index.html'), dataPath };
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
  const result = writeLocalDashboard(args);
  io.stdout.write(`Wrote Agent Runner dashboard to ${result.indexPath}\n`);
  if (result.dashboard.diagnostics?.length) {
    io.stdout.write(`Diagnostics: ${result.dashboard.diagnostics.map((item) => item.code).join(', ')}\n`);
  }
  return args.strict && !result.dashboard.ok ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run();
}