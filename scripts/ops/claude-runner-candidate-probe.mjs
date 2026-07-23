#!/usr/bin/env node

// Cheap scheduled-run probe. It performs the same GitHub eligibility scan as
// the cron runner but never runs Claude /usage, claims an issue or launches an
// agent. The systemd wrapper uses its exit status to avoid quota subprocesses
// when the queue has no runnable or safely auto-preflightable work.

import { mkdirSync, writeFileSync } from 'node:fs';

import { commentRevision, normalizeCommentIdentity } from './claude-runner-comment-identity.mjs';

export const NO_RUNNABLE_CANDIDATE_EXIT_CODE = 3;

export function candidateFromSelection(selected = {}) {
  const pendingAutoPreflight = (selected.skipped || []).some((item) => item?.reason === 'preflight-generation-pending-dry-run');
  const preflightIdentity = normalizeCommentIdentity(
    selected.currentPreflight || selected.selection?.preflight || null,
    { context: 'candidate-probe-preflight' },
  );
  return {
    candidate: Boolean(selected.issue) || pendingAutoPreflight,
    selectedIssue: selected.issue?.number || null,
    selectionMode: selected.selection?.mode || null,
    sourcePreflightCommentId: commentRevision(preflightIdentity),
    pendingAutoPreflight,
    skipCount: (selected.skipped || []).length,
  };
}

export function buildNoSelectionPayload(args, selected = {}) {
  return {
    dryRun: true,
    candidateProbe: true,
    quotaPreflight: { blocked: false, skipped: true, reason: 'no-runnable-issue' },
    selectedIssue: null,
    selectionMode: null,
    generatedPreflights: selected.generatedPreflights || [],
    skipped: selected.skipped || [],
    stateDbPath: args.stateDbPath,
  };
}

function writeProbeLog(outputDir, payload) {
  mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `${outputDir}/cron-${stamp}.json`;
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

async function recordNoSelection(args, selected) {
  const { openRunnerStateStore } = await import('./claude-runner-state.mjs');
  const payload = buildNoSelectionPayload(args, selected);
  const logPath = writeProbeLog(args.outputDir, payload);
  const store = openRunnerStateStore(args.stateDbPath);
  try {
    store.recordIssueSelection({
      repo: args.repo,
      issueNumber: null,
      statusLabel: null,
      selectionMode: null,
      commandKind: null,
      dryRun: true,
      payload,
    });
    for (const skip of selected.skipped || []) {
      store.recordQueueEvent({
        repo: args.repo,
        eventType: 'skip',
        issueNumber: skip.issue,
        statusLabel: skip.statusLabel,
        reason: skip.reason,
        payload: skip,
      });
    }
    store.recordRunResult({ repo: args.repo, mode: 'no-selection', exitCode: 0, logPath, payload });
  } finally {
    store.close();
  }
  return { ...payload, logPath };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { parseArgs, selectIssue } = await import('./claude-runner-cron.mjs');
  // Appending these flags guarantees the probe cannot execute, claim or run a
  // quota subprocess even when the scheduled wrapper received --execute.
  const args = parseArgs([...argv, '--dry-run', '--skip-quota-preflight'], env);
  const selected = await selectIssue(args);
  const result = candidateFromSelection(selected);
  if (!result.candidate) {
    const recorded = await recordNoSelection(args, selected);
    console.log(JSON.stringify({ ...result, recorded: true, logPath: recorded.logPath }));
    return NO_RUNNABLE_CANDIDATE_EXIT_CODE;
  }
  console.log(JSON.stringify(result));
  return 0;
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], `file://${process.cwd()}/`).href
  : false;

if (invokedAsScript) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
