#!/usr/bin/env node

// #210: the one generic serial implementation recurrence. It removes GP from
// the manual per-issue Agent Runner start loop by probing every *enabled*
// managed-registry project (#100/#177) each tick, selecting at most one
// runnable project/candidate, and invoking the existing project-bound
// bin/run-project.sh wrapper for that project's exact config -- the same
// production execution seam the accepted ModelSpend-only timer already uses.
// This module never reimplements candidate selection, claim or execution: it
// only orders existing project-bound probes and delegates to the existing
// wrapper.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireRecoverableCronLock } from './agent-runner-cron-lock.mjs';
import {
  readProjectRegistryEntries,
  resolveProjectRegistrySelection,
} from './agent-runner-project-registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATE_PROBE_SCRIPT = resolve(HERE, 'claude-runner-candidate-probe.mjs');
const RUN_PROJECT_WRAPPER = resolve(HERE, '../../bin/run-project.sh');

export const NO_RUNNABLE_CANDIDATE_EXIT_CODE = 3;
export const GLOBAL_LOCK_ENV = 'AGENT_RUNNER_IMPLEMENTATION_LOCK';
export const EVIDENCE_DIR_ENV = 'AGENT_RUNNER_IMPLEMENTATION_EVIDENCE_DIR';

export function resolveGlobalLockPath(env = process.env) {
  return env[GLOBAL_LOCK_ENV]
    || resolve(String(env.HOME || homedir()), '.local/state/agent-runner/implementation-recurrence.lock');
}

export function resolveEvidenceDir(env = process.env) {
  return env[EVIDENCE_DIR_ENV]
    || resolve(String(env.HOME || homedir()), '.local/state/agent-runner/implementation-recurrence');
}

/**
 * Load enabled registry entries with each project's *exact* config and the
 * config file path it was loaded from, so probing/invocation can bind
 * AGENT_RUNNER_CONFIG to that project's config -- the same identity contract
 * bin/run-project.sh itself binds to -- rather than reimplementing registry
 * admission rules.
 */
export function loadEnabledProjectsWithConfigPaths({ argv = [], env = process.env, registryPath } = {}) {
  const { registryPath: resolvedPath, manifest, entries } = readProjectRegistryEntries({ argv, env, registryPath });
  const selection = resolveProjectRegistrySelection({ manifest, entries });
  const configPathByProjectId = new Map(
    entries.filter((entry) => entry.enabled).map((entry) => [entry.config.projectId, entry.configPath]),
  );
  const projects = selection.projects.map((config) => ({
    config,
    configPath: configPathByProjectId.get(config.projectId),
  }));
  return { registryPath: resolvedPath, projects };
}

function defaultProbeProject({ config, configPath }, { argv = [], env = process.env, nodeBin = process.execPath } = {}) {
  const result = spawnSync(nodeBin, [CANDIDATE_PROBE_SCRIPT, ...argv], {
    cwd: config.localRepoPath,
    env: { ...env, AGENT_RUNNER_CONFIG: configPath, CLAUDE_RUNNER_CONFIG: configPath },
    encoding: 'utf8',
  });
  let payload = null;
  try {
    const lastLine = String(result.stdout || '').trim().split('\n').pop();
    payload = lastLine ? JSON.parse(lastLine) : null;
  } catch { /* best-effort evidence only; classification relies on exit status */ }
  return { status: result.status, payload, stderr: result.stderr };
}

function defaultInvokeProject({ configPath }, { argv = [], env = process.env } = {}) {
  const result = spawnSync(RUN_PROJECT_WRAPPER, argv, {
    env: { ...env, AGENT_RUNNER_CONFIG: configPath },
    stdio: 'inherit',
  });
  return { status: result.status };
}

/**
 * Classify one project-bound probe result into runnable / no-candidate /
 * blocked. Exit code 0 and 3 are the existing claude-runner-candidate-probe
 * contract (candidate found / no runnable candidate). Any other status is a
 * project-local blocker, not "no work" -- it is recorded and skipped so it
 * cannot permanently stop inspection of another enabled project.
 */
export function classifyProbeOutcome({ status, payload }) {
  if (status === 0) {
    return { runnable: true, blocked: false, reason: 'runnable-candidate', selectedIssue: payload?.selectedIssue ?? null };
  }
  if (status === NO_RUNNABLE_CANDIDATE_EXIT_CODE) {
    return { runnable: false, blocked: false, reason: 'no-runnable-candidate', selectedIssue: null };
  }
  return { runnable: false, blocked: true, reason: `probe-failed-exit-${status}`, selectedIssue: null };
}

/**
 * Serial fall-through selection (#210 requirement 8): probe every enabled
 * project in registry order and select the first with a runnable candidate.
 * Never probes more than one project's worth of claim/model/worktree work --
 * probing is read-only discovery; only the single selected project is later
 * invoked through the production wrapper.
 */
export function selectRunnableProject(projects, { probeProject, ...probeOptions }) {
  const probed = [];
  for (const entry of projects) {
    const outcome = classifyProbeOutcome(probeProject(entry, probeOptions));
    probed.push({ projectId: entry.config.projectId, githubRepo: entry.config.githubRepo, ...outcome });
    if (outcome.runnable) return { selected: entry, probed };
  }
  return { selected: null, probed };
}

function writeEvidence(evidenceDir, payload) {
  mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = resolve(evidenceDir, `recurrence-${stamp}-${process.pid}.json`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/**
 * The one generic serial implementation recurrence (#210). Registry
 * load/validation happens before the global lock is even requested, so an
 * invalid/partial registry fails before any lock, claim, GitHub or model
 * activity. The global lock is then held for the full probe+invoke pass, so
 * timer/manual/re-entry collisions cannot launch a second worker while this
 * one is selecting or running. A healthy empty queue (no enabled project has
 * a runnable candidate) performs no invocation and is zero-model/no-mutation.
 */
export async function runImplementationRecurrence({
  argv = [],
  env = process.env,
  registryPath,
  probeProject = defaultProbeProject,
  invokeProject = defaultInvokeProject,
  acquireLock = acquireRecoverableCronLock,
  now = () => new Date().toISOString(),
  writeEvidenceFile = writeEvidence,
} = {}) {
  const { registryPath: resolvedRegistryPath, projects } = loadEnabledProjectsWithConfigPaths({ argv, env, registryPath });

  const lockPath = resolveGlobalLockPath(env);
  const release = acquireLock(lockPath);
  try {
    const { selected, probed } = selectRunnableProject(projects, { probeProject, argv, env });

    const base = {
      schemaVersion: 1,
      recordedAt: now(),
      registryPath: resolvedRegistryPath,
      lockPath,
      probed,
    };

    if (!selected) {
      const payload = {
        ...base,
        selectedProjectId: null,
        selectedRepository: null,
        selectedIssue: null,
        invoked: false,
        reason: 'no-runnable-project',
      };
      payload.evidencePath = writeEvidenceFile(resolveEvidenceDir(env), payload);
      return payload;
    }

    const selectedProbe = probed.find((entry) => entry.projectId === selected.config.projectId);
    const invokeResult = await invokeProject(selected, { argv, env });
    const payload = {
      ...base,
      selectedProjectId: selected.config.projectId,
      selectedRepository: selected.config.githubRepo,
      selectedIssue: selectedProbe?.selectedIssue ?? null,
      invoked: true,
      invokeExitCode: invokeResult.status ?? null,
      reason: 'candidate-selected',
    };
    payload.evidencePath = writeEvidenceFile(resolveEvidenceDir(env), payload);
    return payload;
  } finally {
    release();
  }
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], `file://${process.cwd()}/`).href
  : false;

if (invokedAsScript) {
  try {
    const result = await runImplementationRecurrence({ argv: process.argv.slice(2) });
    console.log(JSON.stringify(result));
    process.exitCode = result.invoked ? (result.invokeExitCode || 0) : 0;
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
