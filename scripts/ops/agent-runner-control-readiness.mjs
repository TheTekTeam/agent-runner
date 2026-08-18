import { constants as fsConstants, accessSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { probeOutcome } from './agent-runner-adapter-contract.mjs';
import { getAgentSettings, normalizeAgentPaidUsePolicy } from './agent-runner-agent-settings.mjs';
import { loadAgentRunnerConfig } from './agent-runner-config.mjs';
import { buildRunnerDashboard } from './claude-runner-dashboard-api.mjs';
import { defaultRunnerStateDbPath } from './claude-runner-state.mjs';

/**
 * Deterministic readiness/health/load reads (issue #46, required
 * implementation #16: "Deterministic readiness checks only; no paid or
 * live provider calls").
 *
 * `probeCommandOnPath()` is a pure, synchronous filesystem walk of `PATH`
 * (`accessSync(candidate, X_OK)` per directory) — it never spawns a
 * process, never opens a socket, and never asks a model for anything. This
 * is deliberately narrower than the #40 Ollama foundation's probe set
 * (which also runs a local `--version` banner and a loopback metadata
 * fetch): this control-service foundation only needs "is the adapter
 * command resolvable", and a zero-process-spawn check removes any question
 * about whether a readiness probe could be mistaken for a live call.
 *
 * `computeInstanceLoad()` is read-only: it reuses the existing
 * `buildRunnerDashboard()` (already exported by
 * `claude-runner-dashboard-api.mjs` for the static dashboard) to report
 * whether a live claim is currently outstanding for `claude-code-cli`. It
 * adds no new coupling into `claude-runner-cron.mjs` — it reads the same
 * SQLite state that module already writes, through the same read-only API
 * the dashboard already uses.
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
 * `capacity` is always `1` here — this is a read of the existing serial
 * global execution slot, not a concurrency control; nothing in this module
 * (or anywhere else in this issue's scope) can increase it.
 */
export function computeInstanceLoad({ agentId, env = process.env, dbPath, historyLimit = 5, buildDashboard = buildRunnerDashboard } = {}) {
  if (agentId !== 'claude-code-cli') {
    return { capacity: 1, active: 0, note: 'load-tracking-not-available-for-this-adapter' };
  }
  const resolvedDbPath = resolveDbPath({ env, dbPath });
  const dashboard = buildDashboard(resolvedDbPath, { historyLimit, strict: false });
  const active = dashboard?.activity?.status === 'active-or-unresolved' ? 1 : 0;
  return { capacity: 1, active, note: null };
}

/**
 * Cost-class/budget-cap/quota-resource read (issue #47 required view:
 * "cost class, budget/cap and quota/resource state"; issue #184: canonical
 * cost/admission posture semantics). This adds no new sink: for
 * `claude-code-cli` it reuses the exact same read-only
 * `buildRunnerDashboard()` summary `computeInstanceLoad()` already reads —
 * the same bounded, already-safe `quota` block the static dashboard has
 * displayed since before this issue (`blockedCount`,
 * `latestSessionUsagePercent`, `latestWeeklyUsagePercent` — no raw
 * prompts, tokens, or provider payload). Every other adapter is either a
 * zero-spend local runtime or not yet implemented, so its cost class is a
 * static, honest label; there is no live billing or provider call in this
 * function for any adapter.
 *
 * `claude-code-cli` has no entry in `agent-runner-routing.mjs`'s
 * `PAID_AGENT_IDS`, so it is never automatically routed onto a paid path;
 * its current-path posture is `included-subscription` (`paid: false`)
 * only when the machine-local paid-use policy is positively readable.
 * A missing/unreadable/malformed settings document is not equivalent to a
 * known disabled paid path: it projects bounded `unknown` posture and
 * never exposes the underlying parse/read error. When policy is known, the
 * same paid-use seam already used by routing (`paidUseApproved`,
 * `automaticRoutingApproved`, a positive cost/token cap — see
 * `normalizeAgentPaidUsePolicy()`) determines whether paid fallback is
 * explicitly authorised. Reading this settings file never writes to it, so
 * this remains a pure, read-only projection.
 */
export function computeInstanceQuota({ agentId, env = process.env, dbPath, buildDashboard = buildRunnerDashboard, settingsPath, getSettings = getAgentSettings } = {}) {
  if (agentId === 'ollama-agent') {
    return { costClass: 'free-local-zero-spend', paid: false, paidFallback: 'disabled', quota: null };
  }
  if (agentId !== 'claude-code-cli') {
    return { costClass: 'not-yet-qualified', paid: false, paidFallback: 'disabled', quota: null };
  }
  const resolvedDbPath = resolveDbPath({ env, dbPath });
  const dashboard = buildDashboard(resolvedDbPath, { historyLimit: 1, strict: false });
  const rawQuota = dashboard?.quota || null;
  const quota = rawQuota
    ? {
        blockedCount: typeof rawQuota.blockedCount === 'number' ? rawQuota.blockedCount : null,
        latestSessionUsagePercent: typeof rawQuota.latestSessionUsagePercent === 'number' ? rawQuota.latestSessionUsagePercent : null,
        latestWeeklyUsagePercent: typeof rawQuota.latestWeeklyUsagePercent === 'number' ? rawQuota.latestWeeklyUsagePercent : null,
      }
    : null;

  const settings = getSettings({ env, agentId, ...(settingsPath ? { settingsPath } : {}) });
  if (!settings || settings.fileFound === false || settings.parseError) {
    return {
      costClass: 'unknown',
      paid: false,
      paidFallback: 'unknown',
      quota,
    };
  }

  const paidUse = normalizeAgentPaidUsePolicy(settings.entry);
  const paidFallbackAuthorised = paidUse.paidUseApproved === true && paidUse.automaticRoutingApproved === true && paidUse.hasPositiveCap === true;
  return {
    costClass: paidFallbackAuthorised ? 'paid-metered' : 'included-subscription',
    paid: paidFallbackAuthorised,
    paidFallback: paidFallbackAuthorised ? 'explicitly-authorised' : 'disabled',
    quota,
  };
}
