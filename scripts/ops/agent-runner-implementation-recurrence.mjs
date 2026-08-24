#!/usr/bin/env node

// #51: Dell remains the one scheduler/controller, but scheduling and worker
// execution are no longer the same global critical section. One short
// scheduler mutex protects registry probing/selection; selected independent
// issue lanes then execute concurrently and acquire their own recoverable lane
// locks inside the project runner.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireRecoverableCronLock } from './agent-runner-cron-lock.mjs';
import { PROJECT_SCOPED_ENV_FIELDS } from './agent-runner-config.mjs';
import {
  GLOBAL_LOCK_ENV,
  IMPLEMENTATION_LANE_ENV,
  SLOT_INHERITED_ENV,
  resolveGlobalLockPath,
} from './agent-runner-implementation-slot.mjs';
import { computeManagerProfileShadow } from './agent-runner-manager-profile-shadow.mjs';
import {
  readProjectRegistryEntries,
  resolveProjectRegistrySelection,
} from './agent-runner-project-registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATE_PROBE_SCRIPT = resolve(HERE, 'claude-runner-candidate-probe.mjs');
const RUN_PROJECT_WRAPPER = resolve(HERE, '../../bin/run-project.sh');

export const NO_RUNNABLE_CANDIDATE_EXIT_CODE = 3;
export const EVIDENCE_DIR_ENV = 'AGENT_RUNNER_IMPLEMENTATION_EVIDENCE_DIR';
export const MAX_PARALLEL_ENV = 'AGENT_RUNNER_MAX_PARALLEL';

export { GLOBAL_LOCK_ENV, resolveGlobalLockPath };

export function resolveEvidenceDir(env = process.env) {
  return env[EVIDENCE_DIR_ENV]
    || resolve(String(env.HOME || homedir()), '.local/state/agent-runner/implementation-recurrence');
}

export function resolveMaxParallel(env = process.env, runnableCount = 0) {
  const raw = String(env[MAX_PARALLEL_ENV] || '').trim();
  if (!raw) return Math.max(1, runnableCount || 1);
  if (!/^\d+$/.test(raw)) throw new Error(`${MAX_PARALLEL_ENV} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new Error(`${MAX_PARALLEL_ENV} must be between 1 and 64`);
  }
  return value;
}

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

/**
 * Scrub any previous project identity. Scheduler probes are read-only and need
 * no implementation lane. Worker invocations receive one exact issue lane;
 * inherited-slot markers are always removed at the scheduler boundary so a
 * worker must independently acquire its own lane.
 */
export function buildProjectScopedInvocationEnv(env, configPath, { laneId = null } = {}) {
  const scrubbed = { ...env };
  for (const { envVarName } of PROJECT_SCOPED_ENV_FIELDS) delete scrubbed[envVarName];
  delete scrubbed[SLOT_INHERITED_ENV];
  delete scrubbed[IMPLEMENTATION_LANE_ENV];
  scrubbed.AGENT_RUNNER_CONFIG = configPath;
  scrubbed.CLAUDE_RUNNER_CONFIG = configPath;
  if (laneId) scrubbed[IMPLEMENTATION_LANE_ENV] = laneId;
  return scrubbed;
}

function defaultProbeProject({ config, configPath }, { argv = [], env = process.env, nodeBin = process.execPath } = {}) {
  const result = spawnSync(nodeBin, [CANDIDATE_PROBE_SCRIPT, ...argv], {
    cwd: config.localRepoPath,
    env: buildProjectScopedInvocationEnv(env, configPath),
    encoding: 'utf8',
  });
  let payload = null;
  try {
    const lastLine = String(result.stdout || '').trim().split('\n').pop();
    payload = lastLine ? JSON.parse(lastLine) : null;
  } catch { /* bounded evidence only */ }
  return { status: result.status, payload, stderr: result.stderr };
}

function defaultInvokeProject({ config, configPath }, { argv = [], env = process.env, laneId } = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(RUN_PROJECT_WRAPPER, argv, {
      cwd: config.localRepoPath,
      env: buildProjectScopedInvocationEnv(env, configPath, { laneId }),
      stdio: 'inherit',
    });
    child.once('error', (error) => resolveResult({ status: 1, error: String(error?.message || error) }));
    child.once('close', (code, signal) => resolveResult({ status: code, signal: signal || null }));
  });
}

export function classifyProbeOutcome({ status, payload }) {
  if (status === 0) {
    return { runnable: true, blocked: false, reason: 'runnable-candidate', selectedIssue: payload?.selectedIssue ?? null };
  }
  if (status === NO_RUNNABLE_CANDIDATE_EXIT_CODE) {
    return { runnable: false, blocked: false, reason: 'no-runnable-candidate', selectedIssue: null };
  }
  return { runnable: false, blocked: true, reason: `probe-failed-exit-${status}`, selectedIssue: null };
}

/** Historical single-result helper retained for callers/tests. */
export function selectRunnableProject(projects, { probeProject, ...probeOptions }) {
  const { selected, probed } = selectRunnableProjects(projects, { probeProject, ...probeOptions, maxParallel: 1 });
  return { selected: selected[0]?.entry || null, probed };
}

/**
 * Probe all enabled projects under the Dell scheduler mutex and return up to
 * maxParallel independent runnable project candidates. One candidate per
 * project is deliberate: same-repository/same-issue partition concurrency
 * requires a separately explicit disjoint-scope authority contract.
 */
export function selectRunnableProjects(projects, {
  probeProject,
  maxParallel = Math.max(1, projects.length),
  ...probeOptions
}) {
  const selected = [];
  const probed = [];
  for (const entry of projects) {
    const outcome = classifyProbeOutcome(probeProject(entry, probeOptions));
    const evidence = { projectId: entry.config.projectId, githubRepo: entry.config.githubRepo, ...outcome };
    probed.push(evidence);
    if (outcome.runnable && selected.length < maxParallel) {
      selected.push({ entry, outcome });
    }
  }
  return { selected, probed };
}

export function implementationLaneForSelection(entry, outcome) {
  const issue = outcome?.selectedIssue;
  if (!Number.isSafeInteger(Number(issue)) || Number(issue) <= 0) {
    throw new Error(`Runnable project ${entry.config.projectId} did not provide a valid selected issue`);
  }
  return `${entry.config.projectId}:issue:${Number(issue)}`;
}

function writeEvidence(evidenceDir, payload) {
  mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = resolve(evidenceDir, `recurrence-${stamp}-${process.pid}.json`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/**
 * One Dell scheduler recurrence with concurrent independent execution lanes.
 * The scheduler lock is held only while probing/selecting; provider and repo
 * mutation happen after release, inside exact issue-scoped lane locks.
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
  computeProfileShadow = computeManagerProfileShadow,
} = {}) {
  const { registryPath: resolvedRegistryPath, projects } = loadEnabledProjectsWithConfigPaths({ argv, env, registryPath });
  const maxParallel = resolveMaxParallel(env, projects.length);
  const lockPath = resolveGlobalLockPath(env);

  let selected;
  let probed;
  let profileShadow;
  const release = acquireLock(lockPath);
  try {
    ({ selected, probed } = selectRunnableProjects(projects, { probeProject, argv, env, maxParallel }));
    profileShadow = computeProfileShadow(projects);
  } finally {
    release();
  }

  const base = {
    schemaVersion: 2,
    recordedAt: now(),
    registryPath: resolvedRegistryPath,
    schedulerLockPath: lockPath,
    maxParallel,
    probed,
    profileShadow,
  };

  if (selected.length === 0) {
    const payload = {
      ...base,
      selectedProjectId: null,
      selectedRepository: null,
      selectedIssue: null,
      selectedProjects: [],
      invoked: false,
      reason: 'no-runnable-project',
    };
    payload.evidencePath = writeEvidenceFile(resolveEvidenceDir(env), payload);
    return payload;
  }

  const jobs = selected.map(({ entry, outcome }) => {
    const laneId = implementationLaneForSelection(entry, outcome);
    return { entry, outcome, laneId };
  });

  const results = await Promise.all(jobs.map(async ({ entry, outcome, laneId }) => {
    const invokeResult = await Promise.resolve(invokeProject(entry, { argv, env, laneId }));
    return {
      projectId: entry.config.projectId,
      repository: entry.config.githubRepo,
      selectedIssue: outcome.selectedIssue,
      laneId,
      invokeExitCode: invokeResult?.status ?? null,
      signal: invokeResult?.signal ?? null,
      error: invokeResult?.error ?? null,
    };
  }));

  const first = results[0];
  const payload = {
    ...base,
    // Compatibility summary fields identify the first selected lane only.
    selectedProjectId: first.projectId,
    selectedRepository: first.repository,
    selectedIssue: first.selectedIssue,
    selectedProjects: results,
    invoked: true,
    invokeExitCode: results.length === 1 ? first.invokeExitCode : null,
    reason: results.length === 1 ? 'candidate-selected' : 'candidates-selected-concurrently',
  };
  payload.evidencePath = writeEvidenceFile(resolveEvidenceDir(env), payload);
  return payload;
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], `file://${process.cwd()}/`).href
  : false;

if (invokedAsScript) {
  try {
    const result = await runImplementationRecurrence({ argv: process.argv.slice(2) });
    console.log(JSON.stringify(result));
    const failures = result.selectedProjects?.filter((entry) => Number(entry.invokeExitCode) !== 0) || [];
    process.exitCode = failures.length ? 1 : 0;
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
