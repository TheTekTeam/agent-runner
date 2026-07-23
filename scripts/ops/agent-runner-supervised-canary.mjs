#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadAgentRunnerConfig } from './agent-runner-config.mjs';
import {
  deserializeCommentIdentity,
  normalizeCommentIdentity,
  sameCommentIdentity,
} from './claude-runner-comment-identity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_DIAGNOSTIC_CHARS = 4096;

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseSupervisedCanaryArgs(argv = process.argv.slice(2)) {
  const args = {
    issueNumber: null,
    execute: false,
    timerUnit: 'agent-runner-modelspend.timer',
    sourcePreflightComment: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--issue') args.issueNumber = positiveInteger(next());
    else if (arg === '--timer-unit') args.timerUnit = next();
    else if (arg === '--source-preflight-comment') args.sourcePreflightComment = next();
    else if (arg === '--execute') args.execute = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.issueNumber) throw new Error('--issue must be a positive integer');
  if (!args.execute) throw new Error('--execute is required for the supervised canary');
  if (args.sourcePreflightComment
    && !normalizeCommentIdentity(args.sourcePreflightComment, { context: 'supervised-canary-source' })) {
    throw new Error('--source-preflight-comment must be a typed GitHub comment identity');
  }
  return args;
}

function parseLastJsonLine(output) {
  const lines = String(output || '').trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* keep scanning */ }
  }
  return null;
}

function sanitizeDiagnosticText(value) {
  return String(value || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\b(GH_TOKEN|GITHUB_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)\s*=\s*[^\s]+/gi, '$1=<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer <redacted>')
    .replace(/\b(?:sk|gh[opsu])-[-A-Za-z0-9_]{12,}\b/g, '<redacted-token>');
}

export function boundedDiagnostic(value, maxChars = MAX_DIAGNOSTIC_CHARS) {
  const sanitized = sanitizeDiagnosticText(value);
  if (sanitized.length <= maxChars) {
    return { text: sanitized, truncated: false, originalChars: sanitized.length };
  }
  return {
    text: sanitized.slice(-maxChars),
    truncated: true,
    originalChars: sanitized.length,
  };
}

export function timerIsActive(timerUnit, spawn = spawnSync) {
  const result = spawn('systemctl', ['--user', 'is-active', '--quiet', timerUnit], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if ([1, 3, 4].includes(result.status)) return false;
  throw new Error(`unable to determine timer state for ${timerUnit}: exit ${result.status}`);
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function atOrAfter(value, since) {
  const left = Date.parse(value || '');
  const right = Date.parse(since || '');
  return Number.isFinite(left) && Number.isFinite(right) && left >= right;
}

function samePreflightRow(row, sourceIdentity, jsonField, fallbackField, context) {
  return sameCommentIdentity(
    deserializeCommentIdentity(row?.[jsonField] || row?.[fallbackField], context),
    sourceIdentity,
  );
}

export function inspectCanaryExecutionEvidence(db, { issueNumber, sourcePreflightComment, since } = {}) {
  const sourceIdentity = normalizeCommentIdentity(sourcePreflightComment, {
    context: 'supervised-canary-inspection',
    required: true,
  });
  if (!db) throw new Error('state database is required');

  const claim = db.prepare('SELECT * FROM claims WHERE issue_number = ? ORDER BY created_at, id').all(issueNumber)
    .filter((row) => atOrAfter(row.created_at, since))
    .find((row) => samePreflightRow(
      row,
      sourceIdentity,
      'source_preflight_comment_identity_json',
      'source_preflight_comment_id',
      'supervised-canary-claim',
    )) || null;

  const attempt = db.prepare('SELECT * FROM recovery_attempts WHERE issue_number = ? ORDER BY started_at, attempt_id').all(issueNumber)
    .filter((row) => atOrAfter(row.started_at, since))
    .find((row) => samePreflightRow(
      row,
      sourceIdentity,
      'preflight_identity_json',
      'preflight_revision',
      'supervised-canary-attempt',
    )) || null;

  const terminal = db.prepare('SELECT * FROM run_results WHERE issue_number = ? ORDER BY created_at, id').all(issueNumber)
    .filter((row) => atOrAfter(row.started_at || row.created_at, since))
    .map((row) => ({ row, payload: parseObject(row.payload_json) || {} }))
    .find(({ row, payload }) => attempt
      && Boolean(row.finished_at)
      && String(payload.startedAt || row.started_at || '') === String(attempt.started_at || '')
      && sameCommentIdentity(
        normalizeCommentIdentity(
          payload.sourcePreflightCommentIdentity
            || payload.sourcePreflightCommentId
            || payload.sourcePreflightRevision
            || null,
          { context: 'supervised-canary-run' },
        ),
        sourceIdentity,
      )) || null;

  const workerStarted = Boolean(terminal
    || (attempt?.phase && attempt.phase !== 'starting')
    || attempt?.finished_at);
  const terminalSucceeded = Boolean(terminal?.row?.finished_at
    && Number(terminal.row.exit_code) === 0
    && terminal.payload.terminalOutcome === 'completed');
  const terminalFailed = Boolean(terminal?.row?.finished_at && !terminalSucceeded);

  return {
    state: terminalSucceeded ? 'terminal_success'
      : terminalFailed ? 'terminal_failure'
        : workerStarted ? 'worker_started'
          : (attempt || claim) ? 'claim_persisted'
            : 'handled_noop',
    claimPersisted: Boolean(claim),
    attemptPersisted: Boolean(attempt),
    workerStarted,
    terminalSucceeded,
    terminalFailed,
    claimId: claim?.id || null,
    attemptId: attempt?.attempt_id || null,
    runResultId: terminal?.row?.id || null,
    terminalOutcome: terminal?.payload?.terminalOutcome || attempt?.outcome || null,
    finishedAt: terminal?.row?.finished_at || null,
  };
}

function readWrapperResult(path) {
  try { return parseObject(readFileSync(path, 'utf8')); } catch { return null; }
}

function diagnostics(run) {
  return {
    stdout: boundedDiagnostic(run.stdout),
    stderr: boundedDiagnostic(run.stderr),
    maxCharsPerStream: MAX_DIAGNOSTIC_CHARS,
    restricted: true,
  };
}

function executionEnv(env) {
  return {
    ...env,
    AGENT_RUNNER_EXECUTE: 'true',
    CLAUDE_RUNNER_CRON_EXECUTE: 'true',
    CLAUDE_RUNNER_CRON_DISABLE_AUTO_PREFLIGHT: 'true',
    CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION: 'false',
  };
}

export function runSupervisedCanary(args, env = process.env, dependencies = {}) {
  const spawn = dependencies.spawn || spawnSync;
  if (timerIsActive(args.timerUnit, spawn)) {
    return {
      exitCode: 3,
      payload: {
        schemaVersion: 'agent-runner-supervised-canary/v2',
        launched: false,
        state: 'handled_noop',
        issueNumber: args.issueNumber,
        reason: 'execution-timer-active',
        safeNextAction: `Disable ${args.timerUnit} before running a supervised one-shot canary.`,
      },
    };
  }

  const probe = spawn(
    process.execPath,
    [resolve(ROOT, 'scripts/ops/claude-runner-candidate-probe.mjs'), '--execute'],
    { encoding: 'utf8', env: executionEnv(env) },
  );
  if (probe.error) throw probe.error;
  const probePayload = parseLastJsonLine(probe.stdout);
  if (probe.status !== 0 || Number(probePayload?.selectedIssue) !== args.issueNumber) {
    return {
      exitCode: 3,
      payload: {
        schemaVersion: 'agent-runner-supervised-canary/v2',
        launched: false,
        state: 'handled_noop',
        issueNumber: args.issueNumber,
        selectedIssue: probePayload?.selectedIssue ?? null,
        reason: probe.status === 0 ? 'requested-canary-not-selected' : 'no-runnable-canary',
        safeNextAction: `Keep the timer disabled and make issue #${args.issueNumber} the exact runnable candidate before retrying.`,
      },
    };
  }

  // The imported probe is byte-locked and intentionally exposes only cheap
  // selection metadata. The standalone-owned candidate-admission boundary
  // performs the second non-mutating read and supplies the exact authoritative
  // preflight identity without changing the imported module.
  const admission = spawn(
    process.execPath,
    [resolve(ROOT, 'scripts/ops/agent-runner-candidate-admission.mjs'), '--execute'],
    { encoding: 'utf8', env: executionEnv(env) },
  );
  if (admission.error) throw admission.error;
  const admissionPayload = parseLastJsonLine(admission.stdout);
  if (admission.status !== 0
    || admissionPayload?.admission?.allowed !== true
    || Number(admissionPayload?.current?.issueNumber) !== args.issueNumber) {
    return {
      exitCode: 3,
      payload: {
        schemaVersion: 'agent-runner-supervised-canary/v2',
        launched: false,
        state: 'probe_selected',
        issueNumber: args.issueNumber,
        reason: admissionPayload?.admission?.reason || 'candidate-admission-refused',
        safeNextAction: 'Keep the timer disabled and repair the candidate authority mismatch before retrying.',
      },
    };
  }

  const admittedPreflight = admissionPayload.current.preflightRevision || null;
  const requestedPreflight = args.sourcePreflightComment || admittedPreflight;
  if (!normalizeCommentIdentity(requestedPreflight, { context: 'supervised-canary-admitted-preflight' })) {
    return {
      exitCode: 3,
      payload: {
        schemaVersion: 'agent-runner-supervised-canary/v2',
        launched: false,
        state: 'probe_selected',
        issueNumber: args.issueNumber,
        reason: 'selected-preflight-identity-unavailable',
        safeNextAction: 'Keep the timer disabled and repair candidate-admission preflight identity reporting.',
      },
    };
  }
  if (args.sourcePreflightComment
    && !sameCommentIdentity(args.sourcePreflightComment, admittedPreflight)) {
    return {
      exitCode: 3,
      payload: {
        schemaVersion: 'agent-runner-supervised-canary/v2',
        launched: false,
        state: 'probe_selected',
        issueNumber: args.issueNumber,
        sourcePreflightComment: requestedPreflight,
        reason: 'selected-preflight-does-not-match-request',
        safeNextAction: 'Keep the timer disabled and reconcile the exact manager-preflight identity before retrying.',
      },
    };
  }

  const startedAt = new Date().toISOString();
  const temporaryDir = dependencies.temporaryDir || mkdtempSync(join(tmpdir(), 'agent-runner-canary-'));
  const wrapperResultPath = join(temporaryDir, 'run-project-result.json');
  const run = spawn(resolve(ROOT, 'bin/run-project.sh'), [], {
    encoding: 'utf8',
    env: {
      ...executionEnv(env),
      AGENT_RUNNER_CANARY_ISSUE: String(args.issueNumber),
      AGENT_RUNNER_RUN_RESULT_FILE: wrapperResultPath,
    },
  });
  if (run.error) throw run.error;

  const wrapperResult = dependencies.readWrapperResult
    ? dependencies.readWrapperResult(wrapperResultPath)
    : readWrapperResult(wrapperResultPath);
  const config = dependencies.config || loadAgentRunnerConfig({ env });
  const inspect = dependencies.inspectEvidence || ((options) => {
    const db = new DatabaseSync(config.stateDbPath, { readOnly: true });
    try { return inspectCanaryExecutionEvidence(db, options); } finally { db.close(); }
  });
  const evidence = inspect({
    issueNumber: args.issueNumber,
    sourcePreflightComment: requestedPreflight,
    since: startedAt,
  });
  if (!dependencies.temporaryDir) rmSync(temporaryDir, { recursive: true, force: true });

  const timerRemainedDisabled = !timerIsActive(args.timerUnit, spawn);
  const handledNoop = wrapperResult?.state === 'handled_noop' || evidence.state === 'handled_noop';
  const state = handledNoop ? 'handled_noop' : evidence.state;
  const launched = evidence.workerStarted === true;
  const runnerExitCode = run.status ?? 1;
  let exitCode = 4;
  let reason = null;

  if (!timerRemainedDisabled) {
    exitCode = 1;
    reason = 'execution-timer-became-active';
  } else if (state === 'terminal_success') {
    exitCode = 0;
  } else if (state === 'terminal_failure') {
    exitCode = runnerExitCode === 0 ? 1 : runnerExitCode;
    reason = 'terminal-failure';
  } else if (handledNoop) {
    exitCode = 3;
    reason = wrapperResult?.reason || 'handled-noop-without-attempt';
  } else if (state === 'worker_started') {
    reason = 'worker-started-without-terminal-result';
  } else if (state === 'claim_persisted') {
    reason = 'claim-persisted-without-worker-start';
  } else {
    reason = 'handled-noop-without-attempt';
  }

  const payload = {
    schemaVersion: 'agent-runner-supervised-canary/v2',
    launched,
    state,
    issueNumber: args.issueNumber,
    sourcePreflightComment: requestedPreflight,
    timerUnit: args.timerUnit,
    timerRemainedDisabled,
    runnerInvoked: wrapperResult?.state === 'canonical_runner_invoked',
    runnerExitCode,
    reason,
    evidence,
    safeNextAction: exitCode === 0
      ? 'Capture the dashboard snapshot and run the strict correlated canary proof command before any reboot or timer enablement.'
      : 'Keep the timer disabled and inspect runnerDiagnostics and correlated evidence before retrying.',
  };
  if (exitCode !== 0) payload.runnerDiagnostics = diagnostics(run);
  return {
    exitCode,
    payload,
    stdout: String(run.stdout || ''),
    stderr: String(run.stderr || ''),
  };
}

export function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const args = parseSupervisedCanaryArgs(argv);
  const result = runSupervisedCanary(args, env, dependencies);
  console.log(JSON.stringify(result.payload, null, 2));
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: 'agent-runner-supervised-canary/v2',
      launched: false,
      systemicFailure: true,
      reason: String(error?.message || error),
      safeNextAction: 'Keep the timer disabled and repair the supervised canary prerequisites.',
    }, null, 2));
    process.exitCode = 1;
  }
}
