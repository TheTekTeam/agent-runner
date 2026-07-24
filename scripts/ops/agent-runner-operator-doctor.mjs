#!/usr/bin/env node

// Read-only operator doctor report (issue #67, required by #5 finding F10).
// Reuses existing canonical modules only: agent-runner-config.mjs for
// project identity, agent-runner-admission.mjs for machine admission,
// agent-runner-agent-settings.mjs/agent-runner-agents.mjs for adapter
// state, claude-runner-dashboard-api.mjs for SQLite/schema health, and
// agent-runner-supervised-canary-core.mjs's timerIsActive() for
// service/timer state. It never mutates GitHub, SQLite or systemd; it only
// performs bounded local reads (config, `git status`, `systemctl --user
// is-active/is-enabled`, and a state DB read whose canonical open path
// applies only idempotent `CREATE TABLE IF NOT EXISTS`/`PRAGMA`
// statements, identical to the existing state-doctor command).

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { admitMachineProfile } from './agent-runner-admission.mjs';
import { resolveAgentForLabels } from './agent-runner-agents.mjs';
import { getAgentSettings } from './agent-runner-agent-settings.mjs';
import { CANDIDATE_PAUSED_EXIT_CODE } from './agent-runner-candidate-admission.mjs';
import { loadAgentRunnerConfig, projectIdentity } from './agent-runner-config.mjs';
import { timerIsActive } from './agent-runner-supervised-canary-core.mjs';
import { buildRunnerDashboard } from './claude-runner-dashboard-api.mjs';

export const DOCTOR_SCHEMA_VERSION = 'agent-runner-operator-doctor/v1';
export const USAGE_ERROR_EXIT_CODE = 2;
export const SYSTEMIC_ERROR_EXIT_CODE = 1;

function isoNow() {
  return new Date().toISOString();
}

export function parseDoctorArgs(argv = [], env = process.env) {
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

function unitIsEnabled(unit, spawn = spawnSync) {
  const result = spawn('systemctl', ['--user', 'is-enabled', '--quiet', unit], { encoding: 'utf8' });
  if (result.error) return 'unknown';
  if (result.status === 0) return true;
  if ([1, 3, 4].includes(result.status)) return false;
  return 'unknown';
}

export function unitState(unit) {
  let active;
  try {
    active = timerIsActive(unit);
  } catch {
    active = 'unknown';
  }
  return { name: unit, active, enabled: unitIsEnabled(unit) };
}

function runGitReadOnly(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) return { ok: false };
  return { ok: true, stdout: String(result.stdout || '') };
}

export function inspectCheckout(localRepoPath) {
  if (!localRepoPath || !existsSync(localRepoPath)) {
    return { present: false, clean: null, changedFileCount: null, headShortSha: null, reason: 'checkout-missing' };
  }
  const isWorkTree = runGitReadOnly(['rev-parse', '--is-inside-work-tree'], localRepoPath);
  if (!isWorkTree.ok || isWorkTree.stdout.trim() !== 'true') {
    return { present: true, clean: null, changedFileCount: null, headShortSha: null, reason: 'checkout-not-a-git-worktree' };
  }
  const status = runGitReadOnly(['status', '--porcelain=v1', '--untracked-files=no'], localRepoPath);
  const head = runGitReadOnly(['rev-parse', '--short=12', 'HEAD'], localRepoPath);
  if (!status.ok || !head.ok) {
    return { present: true, clean: null, changedFileCount: null, headShortSha: null, reason: 'checkout-inspection-failed' };
  }
  const changedLines = status.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return {
    present: true,
    clean: changedLines.length === 0,
    changedFileCount: changedLines.length,
    headShortSha: head.stdout.trim() || null,
    reason: null,
  };
}

function adapterState(config, env) {
  const agentIds = new Set();
  for (const label of config.acceptedAgentLabels) {
    const agent = resolveAgentForLabels([label]);
    if (agent?.agentId) agentIds.add(agent.agentId);
  }
  return [...agentIds].sort().map((agentId) => {
    const settings = getAgentSettings({ agentId, env });
    return {
      agentId,
      fileFound: settings.fileFound,
      routable: settings.routable,
      reason: settings.reason,
    };
  });
}

function computeSafeNextAction({ checkout, state, admission, adapters }) {
  if (!checkout.present || checkout.reason) {
    return 'Provision or repair the configured local repository checkout before continuing.';
  }
  if (!state.ok) {
    return 'Investigate the runner state database before continuing; see the state section for status.';
  }
  if (!admission.allowed) {
    return admission.safeNextAction;
  }
  if (adapters.length > 0 && !adapters.some((adapter) => adapter.routable)) {
    return 'Configure and enable at least one accepted agent in the machine-local agent-settings.json.';
  }
  return 'No action required; all inspected systems are healthy.';
}

export function buildDoctorReport(args, env = process.env, { now = isoNow } = {}) {
  const config = args.config;
  const checkout = inspectCheckout(config.localRepoPath);
  const dashboard = buildRunnerDashboard(config.stateDbPath, { now, historyLimit: 1, strict: false, config });
  const state = {
    ok: dashboard.ok,
    status: dashboard.status,
    schemaVersion: dashboard.schemaVersion,
    counts: dashboard.counts,
  };
  // Doctor always evaluates the real machine admission profile (opt-in,
  // approver allowlist), not merely "would this specific invocation have
  // requested execution" -- admitMachineProfile() is a pure computation
  // over env/argv with no side effects regardless of this flag, so forcing
  // it does not execute or claim anything.
  const admission = admitMachineProfile({ argv: ['--execute'], env });
  const adapters = adapterState(config, env);
  const service = unitState(config.systemd.serviceName);
  const timer = unitState(config.systemd.timerName);

  const report = {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    generatedAt: now(),
    project: projectIdentity(config),
    checkout,
    service,
    timer,
    state,
    adapters,
    admission: {
      allowed: admission.allowed,
      scope: admission.scope,
      reason: admission.reason,
      configurationFingerprint: admission.configurationFingerprint,
    },
    issueMutation: false,
    stateMutation: false,
  };
  report.safeNextAction = computeSafeNextAction({ checkout, state, admission, adapters });
  return report;
}

export function exitCodeForDoctorReport(report) {
  if (report.state.status === 'error' || report.state.status === 'invalid-path') return SYSTEMIC_ERROR_EXIT_CODE;
  if (!report.admission.allowed && report.admission.scope === 'machine_profile') return CANDIDATE_PAUSED_EXIT_CODE;
  return 0;
}

export function run(argv = [], env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  let args;
  try {
    args = parseDoctorArgs(argv, env);
  } catch {
    // loadAgentRunnerConfig() throws (rather than returning a parse
    // result) on an unreadable/malformed --config file, embedding the
    // resolved local path and a raw fs error message. Fail closed with a
    // typed reason instead of letting that escape.
    io.stderr.write(`${JSON.stringify({ ok: false, reason: 'config-load-failed' })}\n`);
    return USAGE_ERROR_EXIT_CODE;
  }
  if (args.error) {
    io.stderr.write(`${JSON.stringify({ ok: false, reason: args.error })}\n`);
    return USAGE_ERROR_EXIT_CODE;
  }
  let report;
  try {
    report = buildDoctorReport(args, env);
  } catch {
    io.stdout.write(`${JSON.stringify({ ok: false, reason: 'doctor-internal-error' }, null, 2)}\n`);
    return SYSTEMIC_ERROR_EXIT_CODE;
  }
  io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return exitCodeForDoctorReport(report);
}

export async function main(argv = process.argv.slice(2), env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  return run(argv, env, io);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write(`${JSON.stringify({ ok: false, reason: 'doctor-internal-error' })}\n`);
    process.exitCode = SYSTEMIC_ERROR_EXIT_CODE;
  });
}
