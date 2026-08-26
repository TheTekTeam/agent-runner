#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

import {
  assertWorkerOnlyFleetNode,
  buildFleetAgentInstance,
  buildFleetProvisioningProjection,
  fleetAdapterRuntimeContract,
  supportedFleetAdapterIds,
} from './agent-runner-fleet-provisioning.mjs';

export const FLEET_READINESS_COMMAND_SCHEMA_VERSION = 1;
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const VERSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;

function parseArgs(argv = []) {
  const args = { nodeId: null, workerOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--node') args.nodeId = argv[++index] || null;
    else if (value === '--worker-only') args.workerOnly = true;
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

function boundedVersion(stdout = '', stderr = '') {
  const source = `${stdout}\n${stderr}`.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 512);
  if (!source) return null;
  for (const raw of source.split(/\s+/)) {
    const candidate = raw.replace(/^[vV](?=\d)/, '').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9._:+-]+$/g, '');
    if (candidate && VERSION_TOKEN.test(candidate) && /\d/.test(candidate)) return candidate;
  }
  return null;
}

function runVersionProbe(probe, runner) {
  const result = runner(probe.command, [...probe.args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: { PATH: process.env.PATH || '' },
  });
  if (result?.error?.code === 'ENOENT') {
    return Object.freeze({ runtimeInstalled: false, version: null, probeState: 'runtime-not-installed' });
  }

  const version = boundedVersion(result.stdout, result.stderr);
  if (result?.status !== 0) {
    if (probe.acceptVersionOnNonZero === true && version) {
      return Object.freeze({
        runtimeInstalled: true,
        version,
        probeState: 'runtime-installed-version-exit-nonzero',
      });
    }
    return Object.freeze({ runtimeInstalled: false, version: null, probeState: 'runtime-version-probe-failed' });
  }
  return Object.freeze({
    runtimeInstalled: true,
    version,
    probeState: 'runtime-installed',
  });
}

export function probeFleetRuntime(adapterId, { runner = spawnSync } = {}) {
  const contract = fleetAdapterRuntimeContract(adapterId);
  if (!contract.sourceSupported || !contract.versionProbe) {
    return Object.freeze({
      adapterId,
      sourceSupported: contract.sourceSupported,
      runtimeInstalled: false,
      version: null,
      authAvailable: null,
      qualified: false,
      probeState: contract.reason || 'version-probe-unavailable',
    });
  }

  // Ollama execution requires two independently installed runtime components:
  // the local Ollama runtime plus the OpenCode repository-tool harness. Probe
  // only their reviewed version commands. Never query /api/tags here: model
  // inventory remains node-local and is deliberately left to #152.
  if (Array.isArray(contract.componentProbes) && contract.componentProbes.length > 0) {
    const components = contract.componentProbes.map((probe) => {
      const outcome = runVersionProbe(probe, runner);
      return Object.freeze({
        componentId: probe.componentId,
        runtimeInstalled: outcome.runtimeInstalled,
        version: outcome.version,
        probeState: outcome.probeState,
      });
    });
    const ollama = components.find((entry) => entry.componentId === 'ollama-runtime');
    const harness = components.find((entry) => entry.componentId === 'opencode-harness');
    let probeState = 'runtime-installed-auth-unchecked';
    if (!ollama?.runtimeInstalled) {
      probeState = ollama?.probeState === 'runtime-version-probe-failed'
        ? 'ollama-runtime-version-probe-failed'
        : 'ollama-runtime-not-installed';
    } else if (!harness?.runtimeInstalled) {
      probeState = harness?.probeState === 'runtime-version-probe-failed'
        ? 'opencode-harness-version-probe-failed'
        : 'opencode-harness-not-installed';
    }
    return Object.freeze({
      adapterId,
      sourceSupported: true,
      runtimeInstalled: Boolean(ollama?.runtimeInstalled && harness?.runtimeInstalled),
      version: harness?.version || null,
      authAvailable: contract.authenticationRequired === false ? true : null,
      qualified: false,
      probeState,
      components: Object.freeze(components),
      modelInventoryState: 'not-probed',
    });
  }

  // The command/argv come exclusively from the reviewed canonical adapter
  // contract. No issue text, environment value or operator-provided shell
  // fragment can become executable input here.
  const outcome = runVersionProbe(contract.versionProbe, runner);
  if (!outcome.runtimeInstalled) {
    return Object.freeze({
      adapterId,
      sourceSupported: true,
      runtimeInstalled: false,
      version: null,
      authAvailable: null,
      qualified: false,
      probeState: outcome.probeState,
    });
  }
  return Object.freeze({
    adapterId,
    sourceSupported: true,
    runtimeInstalled: true,
    version: outcome.version,
    // Version discovery never attempts authentication and never infers it
    // from credential files, environment variables or another machine.
    authAvailable: null,
    qualified: false,
    probeState: 'runtime-installed-auth-unchecked',
  });
}

export function collectFleetReadiness({ nodeId, workerOnly = false, runner = spawnSync, platform = process.platform, arch = process.arch } = {}) {
  if (typeof nodeId !== 'string' || !NODE_ID.test(nodeId)) throw new Error('nodeId is invalid');
  if (workerOnly) {
    assertWorkerOnlyFleetNode({
      nodeId,
      workerOnly: true,
      controller: false,
      scheduler: false,
      manager: false,
      sourceActivation: false,
    });
  }

  const probes = Object.fromEntries(supportedFleetAdapterIds().map((adapterId) => {
    const probe = probeFleetRuntime(adapterId, { runner });
    return [adapterId, probe];
  }));
  const projection = buildFleetProvisioningProjection({
    nodeId,
    adapterEvidence: Object.fromEntries(Object.entries(probes).map(([adapterId, probe]) => [adapterId, {
      runtimeInstalled: probe.runtimeInstalled,
      version: probe.version,
      authAvailable: null,
      qualified: false,
    }])),
  });
  const agentInstances = projection.adapters.map((adapter) => buildFleetAgentInstance(adapter, { maxConcurrent: 1, active: 0 }));

  return Object.freeze({
    schemaVersion: FLEET_READINESS_COMMAND_SCHEMA_VERSION,
    nodeId,
    workerOnly: workerOnly === true,
    controllerAuthorityGranted: false,
    os: String(platform),
    arch: String(arch),
    probes: Object.values(probes),
    provisioningProjection: projection,
    agentInstances,
    // This command is an evidence probe only. It deliberately cannot install,
    // authenticate, qualify, download models, mutate the worker registry or
    // start scheduler/controller services.
    mutationPerformed: false,
  });
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: agent-runner-fleet-readiness-command.mjs --node <node-id> [--worker-only]\n');
    return 0;
  }
  const result = collectFleetReadiness(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
