#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { buildWorkerRegistry } from './agent-runner-worker-pool.mjs';

export const REMOTE_VALIDATION_WORKER_CONFIG_SCHEMA_VERSION = 1;
export const REMOTE_VALIDATION_WORKER_CONFIG_MAX_BYTES = 64 * 1024;
export const REMOTE_VALIDATION_WORKER_CONTROLLER = 'dev-cluster-dell';
export const REMOTE_VALIDATION_WORKER_MEMORY_MAX = '4G';
export const REMOTE_VALIDATION_WORKER_CPU_QUOTA = '300%';
export const REMOTE_VALIDATION_WORKER_TASKS_MAX = '256';
export const REMOTE_VALIDATION_WORKER_RUNTIME_MAX = '2100';
export const REMOTE_VALIDATION_WORKER_FILE_SIZE_MAX = '1G';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '../..');
const validationCommandPath = resolve(here, 'agent-runner-remote-validation-command.mjs');
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class RemoteValidationWorkerError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'RemoteValidationWorkerError';
    this.code = code;
  }
}

function exactFields(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((field, index) => field === wanted[index]);
}

function nodeId(value, name) {
  const normalized = String(value || '').trim();
  if (!NODE_ID.test(normalized)) throw new RemoteValidationWorkerError('worker-config-invalid', `${name} is invalid`);
  return normalized;
}

function expectedPaths(home, root = repositoryRoot) {
  return Object.freeze({
    sourceRepositoryPath: realpathSync(root),
    worktreeRoot: join(home, '.local', 'state', 'agent-runner', 'remote-validation-worktrees'),
    replayRoot: join(home, '.local', 'state', 'agent-runner', 'remote-validation-replay'),
  });
}

export function validateRemoteValidationWorkerConfig(raw, {
  uid = process.getuid?.(),
  home = userInfo().homedir,
  hostname,
  root = repositoryRoot,
} = {}) {
  if (!exactFields(raw, ['schemaVersion', 'controllerNodeId', 'nodeId', 'registry'])) {
    throw new RemoteValidationWorkerError('worker-config-field-set-invalid');
  }
  if (raw.schemaVersion !== REMOTE_VALIDATION_WORKER_CONFIG_SCHEMA_VERSION) {
    throw new RemoteValidationWorkerError('worker-config-schema-invalid');
  }
  if (!Number.isSafeInteger(uid) || uid < 1) throw new RemoteValidationWorkerError('root-not-permitted');
  const controllerNodeId = nodeId(raw.controllerNodeId, 'controllerNodeId');
  if (controllerNodeId !== REMOTE_VALIDATION_WORKER_CONTROLLER) {
    throw new RemoteValidationWorkerError('controller-identity-invalid');
  }
  const configuredNodeId = nodeId(raw.nodeId, 'nodeId');
  if (hostname && configuredNodeId !== hostname) {
    throw new RemoteValidationWorkerError('worker-hostname-mismatch');
  }

  const registry = buildWorkerRegistry({
    controllerNodeId: raw.registry?.controllerNodeId,
    revision: raw.registry?.revision,
    nodes: raw.registry?.nodes,
    agentInstances: raw.registry?.agentInstances || [],
  });
  if (registry.controllerNodeId !== controllerNodeId) {
    throw new RemoteValidationWorkerError('registry-controller-mismatch');
  }
  if (raw.registry?.registryFingerprint && raw.registry.registryFingerprint !== registry.registryFingerprint) {
    throw new RemoteValidationWorkerError('registry-fingerprint-mismatch');
  }
  const worker = registry.nodes.find((node) => node.nodeId === configuredNodeId);
  if (!worker) throw new RemoteValidationWorkerError('worker-node-not-registered');
  if (worker.controller || !worker.workerOnly) throw new RemoteValidationWorkerError('worker-authority-invalid');
  if (worker.state !== 'enabled' || worker.readiness !== 'ready') {
    throw new RemoteValidationWorkerError('worker-readiness-invalid');
  }
  if (!worker.jobClasses.includes('validation') || !worker.capabilities.includes('git')) {
    throw new RemoteValidationWorkerError('worker-capability-invalid');
  }
  if (worker.capacity.available < 1) throw new RemoteValidationWorkerError('worker-capacity-unavailable');

  return Object.freeze({
    schemaVersion: REMOTE_VALIDATION_WORKER_CONFIG_SCHEMA_VERSION,
    controllerNodeId,
    nodeId: configuredNodeId,
    registry,
    ...expectedPaths(home, root),
  });
}

export function loadRemoteValidationWorkerConfig({
  path,
  uid = process.getuid?.(),
  home = userInfo().homedir,
  hostname,
  root = repositoryRoot,
} = {}) {
  const expectedPath = join(home, '.config', 'agent-runner', 'remote-validation-worker.json');
  const configPath = resolve(path || expectedPath);
  if (configPath !== resolve(expectedPath)) throw new RemoteValidationWorkerError('worker-config-path-invalid');

  let stat;
  try {
    stat = lstatSync(configPath);
  } catch {
    throw new RemoteValidationWorkerError('worker-config-missing');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new RemoteValidationWorkerError('worker-config-file-invalid');
  if (stat.uid !== uid) throw new RemoteValidationWorkerError('worker-config-owner-invalid');
  if ((stat.mode & 0o777) !== 0o600) throw new RemoteValidationWorkerError('worker-config-mode-invalid');
  if (stat.size < 2 || stat.size > REMOTE_VALIDATION_WORKER_CONFIG_MAX_BYTES) {
    throw new RemoteValidationWorkerError('worker-config-size-invalid');
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new RemoteValidationWorkerError('worker-config-json-invalid');
  }
  return validateRemoteValidationWorkerConfig(parsed, { uid, home, hostname, root });
}

export function buildRemoteValidationSystemdRun(config, {
  unitSuffix = String(process.pid),
  nodeExecutable = process.execPath,
  systemdRun = 'systemd-run',
} = {}) {
  const suffix = String(unitSuffix || '').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!suffix) throw new RemoteValidationWorkerError('unit-suffix-invalid');
  const registryJson = JSON.stringify(config.registry);
  const unitName = `agent-runner-remote-validation-${suffix}`;
  const childPath = resolve(dirname(validationCommandPath), 'agent-runner-remote-validation-command.mjs');

  return Object.freeze({
    command: systemdRun,
    args: Object.freeze([
      '--user',
      '--quiet',
      '--pipe',
      '--wait',
      '--collect',
      `--unit=${unitName}`,
      `--property=MemoryMax=${REMOTE_VALIDATION_WORKER_MEMORY_MAX}`,
      `--property=CPUQuota=${REMOTE_VALIDATION_WORKER_CPU_QUOTA}`,
      `--property=TasksMax=${REMOTE_VALIDATION_WORKER_TASKS_MAX}`,
      `--property=RuntimeMaxSec=${REMOTE_VALIDATION_WORKER_RUNTIME_MAX}`,
      `--property=LimitFSIZE=${REMOTE_VALIDATION_WORKER_FILE_SIZE_MAX}`,
      '--property=UMask=0077',
      '--property=NoNewPrivileges=yes',
      `--setenv=AGENT_RUNNER_WORKER_REGISTRY_JSON=${registryJson}`,
      `--setenv=AGENT_RUNNER_CONTROLLER_NODE_ID=${config.controllerNodeId}`,
      `--setenv=AGENT_RUNNER_NODE_ID=${config.nodeId}`,
      `--setenv=AGENT_RUNNER_REMOTE_VALIDATION_SOURCE_REPOSITORY=${config.sourceRepositoryPath}`,
      `--setenv=AGENT_RUNNER_REMOTE_VALIDATION_WORKTREE_ROOT=${config.worktreeRoot}`,
      `--setenv=AGENT_RUNNER_REMOTE_VALIDATION_STATE_ROOT=${config.replayRoot}`,
      `--setenv=HOME=${userInfo().homedir}`,
      '--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      '--setenv=LANG=C.UTF-8',
      '--setenv=LC_ALL=C.UTF-8',
      `--working-directory=${config.sourceRepositoryPath}`,
      nodeExecutable,
      childPath,
      'execute',
    ]),
  });
}

function boundedUnitListing(scope, runner = spawnSync) {
  const args = scope === 'user'
    ? ['--user', 'list-unit-files', '--no-legend', '--no-pager']
    : ['list-unit-files', '--no-legend', '--no-pager'];
  const result = runner('systemctl', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new RemoteValidationWorkerError('topology-inspection-failed');
  return String(result.stdout || '');
}

export function assertRemoteValidationWorkerTopology({ runner = spawnSync } = {}) {
  for (const scope of ['user', 'system']) {
    const listing = boundedUnitListing(scope, runner);
    const prohibited = listing.split(/\r?\n/).filter((line) => /^agent-runner.*\.(service|timer)\s/.test(line));
    if (prohibited.length) throw new RemoteValidationWorkerError('worker-controller-unit-present');
  }
  return true;
}

function hostname(runner = spawnSync) {
  const result = runner('hostname', [], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
    maxBuffer: 8 * 1024,
  });
  if (result.error || result.status !== 0) throw new RemoteValidationWorkerError('hostname-probe-failed');
  return String(result.stdout || '').trim();
}

function main() {
  try {
    if (process.getuid?.() === 0) throw new RemoteValidationWorkerError('root-not-permitted');
    if (!process.env.SSH_CONNECTION) throw new RemoteValidationWorkerError('ssh-transport-required');
    if (String(process.env.SSH_ORIGINAL_COMMAND || '').trim()) {
      throw new RemoteValidationWorkerError('arbitrary-ssh-command-refused');
    }
    if (String(process.env.SSH_TTY || '').trim()) throw new RemoteValidationWorkerError('pty-refused');

    const nodeHostname = hostname();
    const config = loadRemoteValidationWorkerConfig({ hostname: nodeHostname });
    assertRemoteValidationWorkerTopology();
    const invocation = buildRemoteValidationSystemdRun(config);
    const result = spawnSync(invocation.command, invocation.args, {
      stdio: 'inherit',
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: userInfo().homedir,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      },
    });
    if (result.error) throw new RemoteValidationWorkerError('resource-wrapper-launch-failed');
    process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  } catch (error) {
    const code = error instanceof RemoteValidationWorkerError ? error.code : 'remote-validation-worker-failed';
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, errorCode: code })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
