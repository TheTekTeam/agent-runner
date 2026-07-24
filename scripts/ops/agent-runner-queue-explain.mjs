#!/usr/bin/env node

// Read-only queue explain (issue #67, required by #5 finding F10). Reuses
// the canonical scheduler's own candidate selection (claude-runner-cron.mjs
// `selectIssue()`) so runnable/skip reasons here are provably identical to
// what the live scheduler would compute -- this module never reimplements
// admission, routing or manager-authority policy. `selectIssue()` is called
// in dry-run mode with `state: null`, which makes every internal
// `state?.record?.()`/`state?.invoke?.()` call a no-op (see
// `activeRunBlockForIssue()` in claude-runner-cron.mjs, whose only branch
// reachable with `state: null` never mutates GitHub). It is called
// repeatedly with a candidate-excluding `ghRunner` wrapper -- itself a thin,
// bounded read-only projection over the already-fetched `gh issue list`
// JSON, not a reimplementation of any selection/skip logic -- so every
// candidate is explained exactly once instead of stopping at the first
// runnable issue.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { AGENT_ADAPTERS } from './agent-runner-agents.mjs';
import { snapshotAgentSettings } from './agent-runner-agent-settings.mjs';
import { loadAgentRunnerConfig, projectIdentity } from './agent-runner-config.mjs';
import * as cron from './claude-runner-cron.mjs';

export const EXPLAIN_SCHEMA_VERSION = 'agent-runner-queue-explain/v1';
export const USAGE_ERROR_EXIT_CODE = 2;
export const QUEUE_INSPECTION_DEGRADED_EXIT_CODE = 1;

// Every skip/runnable reason this module can truthfully observe when
// `selectIssue()` is called with `state: null` (see module header). Kept as
// an explicit closed allowlist rather than passing arbitrary canonical
// strings through unchecked -- a reason produced by selectIssue() that is
// not on this list is reported as 'unclassified-skip' rather than leaked
// verbatim, so this module fails closed even if selectIssue() ever grows a
// new reason this file has not been updated to recognise.
const RECOGNIZED_REASON_CODES = new Set([
  'runnable',
  'metadata-conflict',
  'ambiguous-agent-labels',
  'unsupported-agent',
  'reassignment-candidate',
  'no-qualified-agent',
  'agent-not-eligible',
  'manager-authority-approved-agent-mismatch',
  'candidate-read-failed',
  'candidate-status-label-unsupported',
  'manager-preflight-required',
  'manager-preflight-invalid',
  'manager-preflight-revoked',
  'manager-preflight-already-claimed',
  'active-runner-started-issue',
  'orphaned-runner-started-marker',
]);

function isoNow() {
  return new Date().toISOString();
}

function gh(jsonArgs) {
  return execFileSync('gh', jsonArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function excludingGhRunner(baseGhRunner, excluded) {
  return (jsonArgs) => {
    const raw = baseGhRunner(jsonArgs);
    if (jsonArgs[0] !== 'issue' || jsonArgs[1] !== 'list') return raw;
    let parsed;
    try {
      parsed = JSON.parse(raw || '[]');
    } catch {
      return raw;
    }
    if (!Array.isArray(parsed)) return raw;
    return JSON.stringify(parsed.filter((issue) => !excluded.has(issue?.number)));
  };
}

export function normalizeReason(rawReason) {
  if (typeof rawReason === 'string' && /^unsupported status label /.test(rawReason)) {
    return 'candidate-status-label-unsupported';
  }
  return RECOGNIZED_REASON_CODES.has(rawReason) ? rawReason : 'unclassified-skip';
}

function boundedSkipEntry(entry) {
  return {
    issueNumber: Number.isInteger(entry.issue) ? entry.issue : null,
    statusLabel: entry.statusLabel || null,
    runnable: false,
    reason: normalizeReason(entry.reason),
  };
}

function boundedRunnableEntry(result) {
  return {
    issueNumber: result.issue.number,
    statusLabel: result.issue.statusLabel || null,
    runnable: true,
    reason: 'runnable',
  };
}

export function parseExplainArgs(argv = [], env = process.env) {
  const config = loadAgentRunnerConfig({ argv, env });
  const args = { project: null, config };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') { index += 1; continue; }
    if (arg.startsWith('--config=')) continue;
    if (arg === '--project') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return { error: '--project requires a value' };
      args.project = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--project=')) { args.project = arg.slice('--project='.length); continue; }
    return { error: `Unknown argument: ${arg}` };
  }
  if (!args.project) return { error: '--project is required' };
  if (args.project !== config.projectId) return { error: 'project-identity-mismatch' };
  return args;
}

export async function explainQueue(args, env = process.env, {
  now = isoNow,
  baseGhRunner = gh,
  maxPasses = 250,
} = {}) {
  const cronArgs = cron.parseArgs(['--dry-run', '--skip-quota-preflight'], env);
  const settingsSnapshot = snapshotAgentSettings({ env, agentIds: Object.keys(AGENT_ADAPTERS) });
  const multiAgentSelectorEngaged = cronArgs.multiAgentRoutingEnabled === true;
  const readinessByAgentId = multiAgentSelectorEngaged
    ? cron.computeReadinessByAgentId({ env })
    : {};

  const excluded = new Set();
  const ghRunner = excludingGhRunner(baseGhRunner, excluded);
  const candidates = [];
  let queueInspectionDegraded = false;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const sizeBeforePass = excluded.size;
    // eslint-disable-next-line no-await-in-loop
    const result = await cron.selectIssue(cronArgs, ghRunner, {
      state: null,
      settingsSnapshot: multiAgentSelectorEngaged ? settingsSnapshot : null,
      claudeResourceState: null,
      readinessByAgentId,
    });

    if (result.queueInspectionDegraded) {
      queueInspectionDegraded = true;
      break;
    }

    for (const entry of result.skipped) {
      if (Number.isInteger(entry.issue)) excluded.add(entry.issue);
      candidates.push(boundedSkipEntry(entry));
    }

    if (result.issue) {
      excluded.add(result.issue.number);
      candidates.push(boundedRunnableEntry(result));
    }

    if (excluded.size === sizeBeforePass) break;
  }

  return {
    schemaVersion: EXPLAIN_SCHEMA_VERSION,
    generatedAt: now(),
    repository: cronArgs.repo,
    queueInspectionDegraded,
    inspectedCount: candidates.length,
    runnableCount: candidates.filter((entry) => entry.runnable).length,
    skippedCount: candidates.filter((entry) => !entry.runnable).length,
    candidates,
    issueMutation: false,
    stateMutation: false,
    safeNextAction: queueInspectionDegraded
      ? 'Verify GitHub API connectivity/auth for the runner; new-candidate discovery could not complete this pass.'
      : 'Review each candidate reason; no action is required unless a candidate reports an unexpected skip.',
  };
}

export function run(argv = [], env = process.env, io = { stdout: process.stdout, stderr: process.stderr }, explainDependencies = {}) {
  let args;
  try {
    args = parseExplainArgs(argv, env);
  } catch {
    // loadAgentRunnerConfig() throws (rather than returning a parse
    // result) on an unreadable/malformed --config file, embedding the
    // resolved local path and a raw fs error message. Fail closed with a
    // typed reason instead of letting that escape.
    io.stderr.write(`${JSON.stringify({ ok: false, reason: 'config-load-failed' })}\n`);
    return Promise.resolve(USAGE_ERROR_EXIT_CODE);
  }
  if (args.error) {
    io.stderr.write(`${JSON.stringify({ ok: false, reason: args.error })}\n`);
    return Promise.resolve(USAGE_ERROR_EXIT_CODE);
  }
  return explainQueue(args, env, explainDependencies)
    .then((report) => {
      io.stdout.write(`${JSON.stringify({ project: projectIdentity(args.config), ...report }, null, 2)}\n`);
      return report.queueInspectionDegraded ? QUEUE_INSPECTION_DEGRADED_EXIT_CODE : 0;
    })
    .catch(() => {
      io.stdout.write(`${JSON.stringify({ ok: false, reason: 'queue-explain-internal-error' }, null, 2)}\n`);
      return QUEUE_INSPECTION_DEGRADED_EXIT_CODE;
    });
}

export async function main(argv = process.argv.slice(2), env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  return run(argv, env, io);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write(`${JSON.stringify({ ok: false, reason: 'queue-explain-internal-error' })}\n`);
    process.exitCode = QUEUE_INSPECTION_DEGRADED_EXIT_CODE;
  });
}
