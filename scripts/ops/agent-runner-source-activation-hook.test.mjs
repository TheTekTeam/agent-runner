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
  writeFileSync(fakeNode, `#!/usr/bin/env bash\nset -euo pipefail\nscript="${1:-}"\ndepth="${AGENT_RUNNER_SOURCE_ACTIVATION_REEXEC_DEPTH:-0}"\ncase "$script" in\n  *agent-runner-source-activation-authority.mjs)\n    echo "controller:$depth" >> "${LOG_FILE}"\n    case "${CONTROLLER_MODE}" in\n      reexec-once) if [ "$depth" = "0" ]; then exit 10; else exit 0; fi ;;\n      always-reexec) exit 10 ;;\n      handled) exit 3 ;;\n      systemic) exit 1 ;;\n      *) exit 0 ;;\n    esac\n    ;;\n  *agent-runner-implementation-recurrence.mjs)\n    echo "recurrence:$depth" >> "${LOG_FILE}"\n    exit 0\n    ;;\n  *) echo "unexpected:$script" >> "${LOG_FILE}"; exit 99 ;;\nesac\n`);
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

test('disabled source activation preserves current recurrence path and never invokes controller', () => {
  const result = runWrapper({ enabled: false, controllerMode: 'systemic' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ['recurrence:0']);
});

test('valid activation result re-execs wrapper exactly once then continues recurrence from re-exec depth one', () => {
  const result = runWrapper({ enabled: true, controllerMode: 'reexec-once' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ['controller:0', 'controller:1', 'recurrence:1']);
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
