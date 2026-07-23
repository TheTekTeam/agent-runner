import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '../..');

test('run-project records handled no-op reason while preserving shell exit zero', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('run-project intentionally refuses root');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'agent-runner-project-result-'));
  const project = join(root, 'project');
  const config = join(root, 'modelspend.json');
  const fakeNode = join(root, 'node');
  const resultFile = join(root, 'run-result.json');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(config, JSON.stringify({ localRepoPath: project }));
  writeFileSync(fakeNode, `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 0 ] || [ "\${1:-}" = "-e" ]; then exec "$REAL_NODE" "$@"; fi
case "\${1:-}" in
  *agent-runner-circuit-breaker.mjs) [ "\${2:-}" = "check" ] && exit 3 ;;
esac
exit 99
`);
  chmodSync(fakeNode, 0o755);

  const run = spawnSync('bash', [join(ROOT, 'bin/run-project.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      REAL_NODE: process.execPath,
      AGENT_RUNNER_NODE_BIN: fakeNode,
      AGENT_RUNNER_CONFIG: config,
      AGENT_RUNNER_ENV_FILE: join(root, 'missing.env'),
      AGENT_RUNNER_EXECUTE: 'true',
      AGENT_RUNNER_RUN_RESULT_FILE: resultFile,
    },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /admission circuit paused/);
  const recorded = JSON.parse(readFileSync(resultFile, 'utf8'));
  assert.equal(recorded.schemaVersion, 'agent-runner-project-run-result/v1');
  assert.equal(recorded.state, 'handled_noop');
  assert.equal(recorded.reason, 'circuit-paused');
  assert.equal(recorded.exitCode, 0);
  assert.match(recorded.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
});
