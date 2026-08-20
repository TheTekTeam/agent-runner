import { constants as fsConstants, accessSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { probeOutcome } from './agent-runner-adapter-contract.mjs';
import { loadAgentRunnerConfig } from './agent-runner-config.mjs';
import { readOnlyRunnerStateSnapshot } from './agent-runner-operator-doctor.mjs';
import { buildRunnerActivity, buildRunnerMetrics } from './claude-runner-dashboard-api.mjs';
import { defaultRunnerStateDbPath } from './claude-runner-state.mjs';

/**
 * Deterministic readiness/health/load reads (issue #46, hardened for the
 * permanent read-only control service in issue #174).
 *
 * `probeCommandOnPath()` is a pure, synchronous filesystem walk of `PATH`
 * (`accessSync(candidate, X_OK)` per directory) — it never spawns a
 * process, never opens a socket, and never asks a model for anything.
 *
 * Control-service load/quota reads must remain compatible with a systemd
 * sandbox that keeps the live runner state tree read-only. They therefore
 * use `readOnlyRunnerStateSnapshot()`, which snapshots the live database to
 * a private temporary copy before opening SQLite, then apply the same pure
 * dashboard activity/metrics derivations to that bounded snapshot. They do
 * not instantiate `RunnerStateStore` or call `buildRunnerDashboard()` on
 * the live execution database.
 */

export function probeCommandOnPath({ command, pathEnv = process.env.PATH || '', accessFn = accessSync } = {}) {
  if (!command) return probeOutcome({ probe: 'executable', ok: false, reason: 'command-not-configured' });
  const dirs = String(pathEnv).split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, command);
    try {
      accessFn(candidate, fsConstants.X_OK);
      return probeOutcome({ probe: 'executable', ok: true, detail: candidate });
    } catch {
      // try the next PATH entry
    }
  }
  return probeOutcome({ probe: 'executable', ok: false, reason: 'command-not-on-path' });
}

/**
 * One instance's readiness. Unimplemented catalogue adapters report
 * `not-probed` rather than running any check — their effective state is
 * already forced to `unsupported` by `deriveInstanceState()` regardless of
 * this result, so probing them would only add noise, not information.
 */
export function computeInstanceReadiness({ adapter, accessFn, pathEnv } = {}) {
  if (!adapter?.implemented) {
    return { ok: false, reason: 'adapter-not-implemented', probes: [] };
  }
  const probe = probeCommandOnPath({ command: adapter.command, accessFn, pathEnv });
  return { ok: probe.ok, reason: probe.ok ? null : probe.reason, probes: [probe] };
}

function resolveDbPath({ env = process.env, dbPath } = {}) {
  if (dbPath) return dbPath;
  const config = loadAgentRunnerConfig({ env });
  return env.CLAUDE_RUNNER_STATE_DB || config.stateDbPath || defaultRunnerStateDbPath(env.CLAUDE_RUNNER_OUTPUT_DIR || config.outputDir);
}

/**
 * Small compatibility adapter for the existing `buildDashboard` injection
 * seam used by the control-readiness tests. The default implementation is
 * genuinely read-only: it reads a private snapshot and returns only the two
 * bounded projections these callers need.
 */
export function buildReadOnlyControlSummary(dbPath, {
  historyLimit = 5,
  snapshotReader = readOnlyRunnerStateSnapshot,
} = {}) {
  const snapshot = snapshotReader(dbPath, { historyLimit, includeLatest: true });
  const latest = snapshot?.ok ? (snapshot.latest || {}) : {};
  const activity = buildRunnerActivity(latest);
  const quota = snapshot?.ok ? buildRunnerMetrics({ latest }).quota : null;
  return { activity, quota };
}

/**
 * `capacity` is always `1` here — this is a read of the existing serial
 * global execution slot, not a concurrency control; nothing in this module
 * (or anywhere else in this issue's scope) can increase it.
 */
export function computeInstanceLoad({ agentId, env = process.env, dbPath, historyLimit = 5, buildDashboard = buildReadOnlyControlSummary } = {}) {
  if (agentId !== 'claude-code-cli') {
    return { capacity: 1, active: 0, note: 'load-tracking-not-available-for-this-adapter' };
  }
  const resolvedDbPath = resolveDbPath({ env, dbPath });
  const dashboard = buildDashboard(resolvedDbPath, { historyLimit });
  const active = dashboard?.activity?.status === 'active-or-unresolved' ? 1 : 0;
  return { capacity: 1, active, note: null };
}

/**
 * Cost-class/quota-resource read (issue #47 required view; #184 owner
 * decision 2026-08-18).
 *
 * Admission availability is quota-only. This projection never reads an
 * account balance, flexible-credit state, billing settings, paid-use
 * approval, auto-top-up state, or provider billing metadata. For the
 * accepted Claude subscription path it reuses the bounded quota metrics
 * derived from the private read-only runner-state snapshot and reports the
 * execution source as `included-subscription` with the compatibility
 * `paid` flag false.
 *
 * Actual scheduler admission remains governed by the canonical quota
 * preflight/profile thresholds. Missing or exhausted quota must fail closed
 * there; the presence or absence of credits is deliberately irrelevant.
 * Model/effort authorization and provider/token execution limits remain
 * separate safety controls. No dollar-denominated per-attempt ceiling is
 * applied to subscription-backed Claude execution.
 *
 * Every other adapter is either a zero-spend local runtime or not yet
 * qualified here. No provider call, billing lookup or settings mutation is
 * performed for any adapter.
 */
export function computeInstanceQuota({ agentId, env = process.env, dbPath, buildDashboard = buildReadOnlyControlSummary } = {}) {
  if (agentId === 'ollama-agent') {
    return { costClass: 'free-local-zero-spend', paid: false, quota: null };
  }
  if (agentId !== 'claude-code-cli') {
    return { costClass: 'not-yet-qualified', paid: false, quota: null };
  }

  const resolvedDbPath = resolveDbPath({ env, dbPath });
  const dashboard = buildDashboard(resolvedDbPath, { historyLimit: 1 });
  const rawQuota = dashboard?.quota || null;
  const quota = rawQuota
    ? {
        blockedCount: typeof rawQuota.blockedCount === 'number' ? rawQuota.blockedCount : null,
        latestSessionUsagePercent: typeof rawQuota.latestSessionUsagePercent === 'number' ? rawQuota.latestSessionUsagePercent : null,
        latestWeeklyUsagePercent: typeof rawQuota.latestWeeklyUsagePercent === 'number' ? rawQuota.latestWeeklyUsagePercent : null,
      }
    : null;

  return {
    costClass: 'included-subscription',
    paid: false,
    quota,
  };
}
