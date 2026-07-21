#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    else if (arg === '--execute') args.execute = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.issueNumber) throw new Error('--issue must be a positive integer');
  if (!args.execute) throw new Error('--execute is required for the supervised canary');
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
    return {
      text: sanitized,
      truncated: false,
      originalChars: sanitized.length,
    };
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

export function runSupervisedCanary(args, env = process.env, dependencies = {}) {
  const spawn = dependencies.spawn || spawnSync;
  if (timerIsActive(args.timerUnit, spawn)) {
    return {
      exitCode: 3,
      payload: {
        schemaVersion: 'agent-runner-supervised-canary/v1',
        launched: false,
        issueNumber: args.issueNumber,
        reason: 'execution-timer-active',
        safeNextAction: `Disable ${args.timerUnit} before running a supervised one-shot canary.`,
      },
    };
  }

  const probeScript = resolve(ROOT, 'scripts/ops/claude-runner-candidate-probe.mjs');
  const probe = spawn(process.execPath, [probeScript, '--execute'], {
    encoding: 'utf8',
    env: {
      ...env,
      AGENT_RUNNER_EXECUTE: 'true',
      CLAUDE_RUNNER_CRON_EXECUTE: 'true',
      CLAUDE_RUNNER_CRON_DISABLE_AUTO_PREFLIGHT: 'true',
      CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION: 'false',
    },
  });
  if (probe.error) throw probe.error;
  const probePayload = parseLastJsonLine(probe.stdout);
  if (probe.status !== 0 || Number(probePayload?.selectedIssue) !== args.issueNumber) {
    return {
      exitCode: 3,
      payload: {
        schemaVersion: 'agent-runner-supervised-canary/v1',
        launched: false,
        issueNumber: args.issueNumber,
        selectedIssue: probePayload?.selectedIssue ?? null,
        reason: probe.status === 0 ? 'requested-canary-not-selected' : 'no-runnable-canary',
        safeNextAction: `Keep the timer disabled and make issue #${args.issueNumber} the exact runnable candidate before retrying.`,
      },
    };
  }

  const launcher = resolve(ROOT, 'bin/run-project.sh');
  const run = spawn(launcher, [], {
    encoding: 'utf8',
    env: {
      ...env,
      AGENT_RUNNER_EXECUTE: 'true',
      CLAUDE_RUNNER_CRON_EXECUTE: 'true',
      AGENT_RUNNER_CANARY_ISSUE: String(args.issueNumber),
      CLAUDE_RUNNER_CRON_DISABLE_AUTO_PREFLIGHT: 'true',
      CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION: 'false',
    },
  });
  if (run.error) throw run.error;
  const runnerExitCode = run.status ?? 1;
  const payload = {
    schemaVersion: 'agent-runner-supervised-canary/v1',
    launched: true,
    issueNumber: args.issueNumber,
    timerUnit: args.timerUnit,
    timerRemainedDisabled: true,
    runnerExitCode,
    safeNextAction: runnerExitCode === 0
      ? 'Capture the dashboard snapshot and run the strict canary proof command before any reboot or timer enablement.'
      : 'Keep the timer disabled and inspect runnerDiagnostics before retrying.',
  };
  if (runnerExitCode !== 0) {
    payload.runnerDiagnostics = {
      stdout: boundedDiagnostic(run.stdout),
      stderr: boundedDiagnostic(run.stderr),
      maxCharsPerStream: MAX_DIAGNOSTIC_CHARS,
      restricted: true,
    };
  }
  return {
    exitCode: runnerExitCode,
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
      schemaVersion: 'agent-runner-supervised-canary/v1',
      launched: false,
      systemicFailure: true,
      reason: String(error?.message || error),
      safeNextAction: 'Keep the timer disabled and repair the supervised canary prerequisites.',
    }, null, 2));
    process.exitCode = 1;
  }
}
