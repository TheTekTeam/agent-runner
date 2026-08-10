import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '../..');

// The project-scoped-env gate loads this for real, so it must satisfy the
// full config schema even when subprocess calls are stubbed out below.
function projectConfig(id, overrides = {}) {
  return {
    projectId: id,
    displayName: id,
    githubRepo: `TheTekTeam/${id}`,
    outputDir: `.var/${id}`,
    stateDbPath: `.var/${id}/runner-state.sqlite`,
    acceptedAgentLabels: ['agent:claude'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
    priorityLabelRanking: ['priority:P0'],
    safeDefaultValidationCommands: [],
    systemd: { serviceName: `${id}.service`, timerName: `${id}.timer` },
    ...overrides,
  };
}

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
  writeFileSync(config, JSON.stringify(projectConfig('modelspend', { localRepoPath: project })));
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

// #169 (#44 reproduction) through the real entrypoint: a runner.env carrying
// ModelSpend's canonical paths must not be inherited by a different,
// explicitly selected project's dry run.
test('run-project dry run fails closed instead of inheriting a different configured project\'s output/state paths from shared machine environment', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('run-project intentionally refuses root');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'agent-runner-project-isolation-'));
  const project = join(root, 'project');
  const configPath = join(root, 'agent-runner.json');
  const envFile = join(root, 'runner.env');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(configPath, JSON.stringify(projectConfig('agent-runner', {
    localRepoPath: project,
    acceptedAgentLabels: ['agent:claude-code-cli'],
  })));
  // A shared machine-local runner.env carrying a materially different
  // project's (ModelSpend's) canonical output/state identity.
  writeFileSync(envFile, [
    'CLAUDE_RUNNER_OUTPUT_DIR=/home/gp/.local/state/agent-runner/modelspend',
    'CLAUDE_RUNNER_STATE_DB=/home/gp/.local/state/agent-runner/modelspend/runner-state.sqlite',
    '',
  ].join('\n'));

  const run = spawnSync('bash', [join(ROOT, 'bin/run-project.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_RUNNER_CONFIG: configPath,
      AGENT_RUNNER_ENV_FILE: envFile,
      AGENT_RUNNER_EXECUTE: 'false',
    },
  });

  assert.notEqual(run.status, 0, `wrapper unexpectedly inherited a mismatched project identity\nstdout:\n${run.stdout || ''}\nstderr:\n${run.stderr || ''}`);
  assert.match(run.stderr, /CLAUDE_RUNNER_OUTPUT_DIR.*disagrees with project "agent-runner"/);
});

// #169: a nested re-entry must not inherit AGENT_RUNNER_RUN_RESULT_FILE and
// overwrite this outer genuine execute run's recorded result with a false
// dry-run one.
test('run-project scrubs AGENT_RUNNER_RUN_RESULT_FILE from every child so a nested re-entry cannot overwrite the outer execute result with a false dry-run result', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('run-project intentionally refuses root');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'agent-runner-result-ownership-'));
  const project = join(root, 'project');
  const config = join(root, 'modelspend.json');
  const fakeNode = join(root, 'node');
  const resultFile = join(root, 'run-result.json');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(config, JSON.stringify(projectConfig('modelspend', { localRepoPath: project })));
  writeFileSync(fakeNode, `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 0 ] || [ "\${1:-}" = "-e" ]; then exec "$REAL_NODE" "$@"; fi
case "\${1:-}" in
  *agent-runner-pinned-atomic-cron.mjs)
    [ -z "\${AGENT_RUNNER_RUN_RESULT_FILE:-}" ] || { echo "child inherited AGENT_RUNNER_RUN_RESULT_FILE" >&2; exit 1; }
    [ -n "\${NESTED_REENTRY:-}" ] || NESTED_REENTRY=1 AGENT_RUNNER_EXECUTE=false bash "$NESTED_ROOT/bin/run-project.sh"
    ;;
esac
exit 0
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
      NESTED_ROOT: ROOT,
    },
  });

  assert.equal(run.status, 0, `stdout:\n${run.stdout || ''}\nstderr:\n${run.stderr || ''}`);
  const recorded = JSON.parse(readFileSync(resultFile, 'utf8'));
  assert.equal(recorded.state, 'canonical_runner_invoked');
  assert.equal(recorded.reason, 'canonical-runner-executed');
  assert.equal(recorded.exitCode, 0);
});
