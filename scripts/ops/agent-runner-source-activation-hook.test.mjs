import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const WRAPPER = join(ROOT, 'bin/run-implementation-recurrence.sh');

function runWrapper({ enabled, controllerMode }) {
  const temp = mkdtempSync(join(tmpdir(), 'ar234-hook-'));
  const log = join(temp, 'calls.log');
  const fakeNode = join(temp, 'node');
  const fakeNodeSource = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'script="${1:-}"',
    'depth="${AGENT_RUNNER_SOURCE_ACTIVATION_REEXEC_DEPTH:-0}"',
    'case "$script" in',
    '  *agent-runner-source-activation-authority.mjs)',
    '    echo "controller:$depth" >> "$LOG_FILE"',
    '    case "$CONTROLLER_MODE" in',
    '      reexec-once) if [ "$depth" = "0" ]; then exit 10; else exit 0; fi ;;',
    '      always-reexec) exit 10 ;;',
    '      handled) exit 3 ;;',
    '      systemic) exit 1 ;;',
    '      *) exit 0 ;;',
    '    esac',
    '    ;;',
    '  *agent-runner-implementation-recurrence.mjs)',
    '    echo "recurrence:${AGENT_RUNNER_SOURCE_ACTIVATION_ENABLED:-unset}:${AGENT_RUNNER_SOURCE_ACTIVATION_CONTROL_ISSUE:-unset}:${AGENT_RUNNER_SOURCE_ACTIVATION_STATE:-unset}:${AGENT_RUNNER_SOURCE_ACTIVATION_REEXEC_DEPTH:-unset}" >> "$LOG_FILE"',
    '    exit 0',
    '    ;;',
    '  *) echo "unexpected:$script" >> "$LOG_FILE"; exit 99 ;;',
    'esac',
    '',
  ].join('\n');
  writeFileSync(fakeNode, fakeNodeSource);
  chmodSync(fakeNode, 0o755);
  const env = {
    ...process.env,
    HOME: temp,
    LOG_FILE: log,
    CONTROLLER_MODE: controllerMode,
    AGENT_RUNNER_NODE_BIN: fakeNode,
    AGENT_RUNNER_ENV_FILE: join(temp, 'missing.env'),
    AGENT_RUNNER_PROJECT_REGISTRY: join(temp, 'projects.json'),
    AGENT_RUNNER_SOURCE_ACTIVATION_ENABLED: enabled ? 'true' : 'false',
    AGENT_RUNNER_SOURCE_ACTIVATION_CONTROL_ISSUE: '225',
    AGENT_RUNNER_SOURCE_ACTIVATION_STATE: join(temp, 'source-state.json'),
    AGENT_RUNNER_EXECUTE: 'false',
  };
  delete env.AGENT_RUNNER_ARGS;
  delete env.AGENT_RUNNER_SOURCE_ACTIVATION_REEXEC_DEPTH;
  const result = spawnSync('bash', [WRAPPER], { cwd: ROOT, env, encoding: 'utf8' });
  const calls = (() => {
    try { return readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean); }
    catch { return []; }
  })();
  rmSync(temp, { recursive: true, force: true });
  return { ...result, calls };
}

const CLEAN_RECURRENCE = 'recurrence:unset:unset:unset:unset';

test('disabled source activation preserves current recurrence path, performs no controller call and strips control env', () => {
  const result = runWrapper({ enabled: false, controllerMode: 'systemic' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [CLEAN_RECURRENCE]);
});

test('valid activation result re-execs wrapper exactly once then starts recurrence without source-control env', () => {
  const result = runWrapper({ enabled: true, controllerMode: 'reexec-once' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ['controller:0', 'controller:1', CLEAN_RECURRENCE]);
});

test('re-exec depth guard prevents recursion even if controller erroneously requests activation twice', () => {
  const result = runWrapper({ enabled: true, controllerMode: 'always-reexec' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, ['controller:0', 'controller:1']);
  assert.match(result.stderr, /re-exec depth guard/i);
});

test('handled source-authority refusal exits without candidate recurrence', () => {
  const result = runWrapper({ enabled: true, controllerMode: 'handled' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ['controller:0']);
});

test('systemic source-authority failure exits nonzero without candidate recurrence', () => {
  const result = runWrapper({ enabled: true, controllerMode: 'systemic' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, ['controller:0']);
});
