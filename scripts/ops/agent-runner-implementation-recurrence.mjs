#!/usr/bin/env node

// #51/#327: Dell remains the one scheduler/controller, but scheduling and
// worker execution are no longer the same global critical section. One short
// scheduler mutex protects registry probing/selection/admission; selected
// independent issue lanes then execute concurrently under exact agent@node
// routing and acquire their own recoverable lane locks inside the worker path.

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
import { admitLaneBatch, normalizeLaneCaps } from './agent-runner-lane-admission.mjs';
import {
  parseLiveWorkerRegistry,
  remoteWorkerDispatchEnabled,
  resolveLiveWorkerRoute,
  safeWorkerRouteEvidence,
} from './agent-runner-live-worker-routing.mjs';
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
export const LANE_CAPS_ENV = 'AGENT_RUNNER_LANE_CAPS_JSON';
export const LOCAL_WORKER_NODE_ID_ENV = 'AGENT_RUNNER_LOCAL_WORKER_NODE_ID';
export const DEFAULT_LOCAL_WORKER_NODE_ID = 'dev-cluster-dell';

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

export function resolveRecurrenceLaneCaps(env = process.env, maxParallel = 1) {
  const raw = String(env[LANE_CAPS_ENV] || '').trim();
  if (Buffer.byteLength(raw, 'utf8') > 8192) throw new Error(`${LANE_CAPS_ENV} exceeds 8192 bytes`);
  let configured = {};
  if (raw) {
    try {
      configured = JSON.parse(raw);
    } catch {
      throw new Error(`${LANE_CAPS_ENV} must contain valid JSON`);
    }
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
      throw new Error(`${LANE_CAPS_ENV} must contain a JSON object`);
    }
  }
  // Safety defaults: global capacity follows the established recurrence cap,
  // one unknown-scope lane per repository, while agent/node capacity may use
  // the full recurrence capacity unless explicitly narrowed. Same-repository
  // parallelism requires explicit partition-aware scheduling rather than an
  // unsafe assumption that candidate file ownership is disjoint.
  return normalizeLaneCaps({
    global: maxParallel,
    defaultPerRepository: 1,
    defaultPerAgent: maxParallel,
    defaultPerNode: maxParallel,
    ...configured,
  });
}

export function resolveLocalWorkerNodeId(env = process.env) {
  const value = String(env[LOCAL_WORKER_NODE_ID_ENV] || DEFAULT_LOCAL_WORKER_NODE_ID).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${LOCAL_WORKER_NODE_ID_ENV} is invalid`);
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
    const outcome = {
      runnable: true,
      blocked: false,
      reason: 'runnable-candidate',
      selectedIssue: payload?.selectedIssue ?? null,
    };
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'selectedAgentId')) {
      outcome.selectedAgentId = payload.selectedAgentId ?? null;
    }
    return outcome;
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

export function laneAdmissionCandidateForSelection(entry, outcome, {
  nodeId = DEFAULT_LOCAL_WORKER_NODE_ID,
  workerRoute = null,
} = {}) {
  const issueNumber = Number(outcome?.selectedIssue);
  const laneId = implementationLaneForSelection(entry, outcome);
  // Old/custom probes that do not yet expose selectedAgentId preserve the
  // already-qualified Claude compatibility identity. A positive worker route
  // may replace only the host/instance dimension, never the selected adapter.
  const adapterId = String(outcome?.selectedAgentId || 'claude-code-cli');
  const selectedNodeId = String(workerRoute?.nodeId || nodeId);
  const agentInstanceId = String(workerRoute?.agentInstanceId || `${adapterId}@${selectedNodeId}`);
  return {
    laneId,
    projectId: entry.config.projectId,
    repository: entry.config.githubRepo,
    issueNumber,
    agentInstanceId,
    adapterId,
    nodeId: selectedNodeId,
    branch: `${entry.config.projectId}/issue/${issueNumber}`,
    worktree: `${entry.config.projectId}/issue/${issueNumber}`,
    files: [],
    resources: [],
  };
}

export function admitRecurrenceSelections(selected, {
  env = process.env,
  maxParallel,
  remoteTransportAvailable = false,
} = {}) {
  const caps = resolveRecurrenceLaneCaps(env, maxParallel);
  const nodeId = resolveLocalWorkerNodeId(env);
  const workerRegistry = parseLiveWorkerRegistry(env, { expectedControllerNodeId: nodeId });
  const remoteRouteEnabled = remoteTransportAvailable === true && remoteWorkerDispatchEnabled(env);

  const routed = selected.map(({ entry, outcome }) => {
    const adapterId = String(outcome?.selectedAgentId || 'claude-code-cli');
    const workerRoute = resolveLiveWorkerRoute({
      adapterId,
      localNodeId: nodeId,
      registry: workerRegistry,
      env,
      jobClass: 'implementation',
      remoteDispatchAvailable: remoteRouteEnabled,
    });
    return { entry, outcome, workerRoute };
  });

  const routeRejected = routed
    .filter(({ workerRoute }) => workerRoute.allowed !== true)
    .map(({ entry, outcome, workerRoute }) => ({
      laneId: implementationLaneForSelection(entry, outcome),
      reasons: [workerRoute.reason],
      workerRoute: safeWorkerRouteEvidence(workerRoute),
    }));
  const routable = routed.filter(({ workerRoute }) => workerRoute.allowed === true);
  const candidates = routable.map(({ entry, outcome, workerRoute }) => laneAdmissionCandidateForSelection(entry, outcome, {
    nodeId,
    workerRoute,
  }));
  const admission = admitLaneBatch(candidates, { active: [], caps });
  const admittedIds = new Set(admission.admitted.map((candidate) => candidate.laneId));
  const admittedSelections = routable.filter(({ entry, outcome }) => admittedIds.has(implementationLaneForSelection(entry, outcome)));
  return {
    caps,
    nodeId,
    registryFingerprint: workerRegistry?.registryFingerprint || null,
    remoteRouteEnabled,
    routes: routed.map(({ entry, outcome, workerRoute }) => ({
      laneId: implementationLaneForSelection(entry, outcome),
      workerRoute: safeWorkerRouteEvidence(workerRoute),
    })),
    admission,
    routeRejected,
    admittedSelections,
  };
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
 * The scheduler lock is held only while probing/selecting/routing/admitting;
 * provider and repo mutation happen after release. Remote execution can be
 * selected only when both the reviewed route flag and an injected bounded
 * transport are present; the default production path remains local-only.
 */
export async function runImplementationRecurrence({
  argv = [],
  env = process.env,
  registryPath,
  probeProject = defaultProbeProject,
  invokeProject = defaultInvokeProject,
  invokeRemoteProject = null,
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
  let laneAdmission;
  const release = acquireLock(lockPath);
  try {
    ({ selected, probed } = selectRunnableProjects(projects, { probeProject, argv, env, maxParallel }));
    profileShadow = computeProfileShadow(projects);
    const admitted = admitRecurrenceSelections(selected, {
      env,
      maxParallel,
      remoteTransportAvailable: typeof invokeRemoteProject === 'function',
    });
    selected = admitted.admittedSelections;
    laneAdmission = {
      nodeId: admitted.nodeId,
      registryFingerprint: admitted.registryFingerprint,
      remoteRouteEnabled: admitted.remoteRouteEnabled,
      caps: admitted.caps,
      routes: admitted.routes,
      admitted: admitted.admission.admitted.map((candidate) => candidate.laneId),
      rejected: [...admitted.routeRejected, ...admitted.admission.rejected],
    };
  } finally {
    release();
  }

  const base = {
    schemaVersion: 3,
    recordedAt: now(),
    registryPath: resolvedRegistryPath,
    schedulerLockPath: lockPath,
    maxParallel,
    probed,
    profileShadow,
    laneAdmission,
  };

  if (selected.length === 0) {
    const payload = {
      ...base,
      selectedProjectId: null,
      selectedRepository: null,
      selectedIssue: null,
      selectedProjects: [],
      invoked: false,
      reason: laneAdmission?.rejected?.length ? 'candidates-rejected-by-lane-admission' : 'no-runnable-project',
    };
    payload.evidencePath = writeEvidenceFile(resolveEvidenceDir(env), payload);
    return payload;
  }

  const jobs = selected.map(({ entry, outcome, workerRoute }) => {
    const laneId = implementationLaneForSelection(entry, outcome);
    return { entry, outcome, workerRoute, laneId };
  });

  const results = await Promise.all(jobs.map(async ({ entry, outcome, workerRoute, laneId }) => {
    let invokeResult;
    if (workerRoute.remote) {
      if (typeof invokeRemoteProject !== 'function') {
        invokeResult = { status: 1, error: 'remote-worker-transport-unavailable' };
      } else {
        invokeResult = await Promise.resolve(invokeRemoteProject(entry, { argv, env, laneId, workerRoute }));
      }
    } else {
      invokeResult = await Promise.resolve(invokeProject(entry, { argv, env, laneId, workerRoute }));
    }
    return {
      projectId: entry.config.projectId,
      repository: entry.config.githubRepo,
      selectedIssue: outcome.selectedIssue,
      laneId,
      nodeId: workerRoute.nodeId,
      agentInstanceId: workerRoute.agentInstanceId,
      remote: workerRoute.remote === true,
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
