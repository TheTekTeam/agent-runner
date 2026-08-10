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
  // #169: the project-scoped-env gate now loads this config for real (rather
  // than only reading localRepoPath), so it must satisfy the full schema even
  // though every downstream subprocess call in this test is stubbed out below.
  writeFileSync(config, JSON.stringify({
    projectId: 'modelspend',
    displayName: 'ModelSpend',
    githubRepo: 'TheTekTeam/modelspend',
    localRepoPath: project,
    outputDir: '.var/claude-runner',
    stateDbPath: '.var/claude-runner/runner-state.sqlite',
    acceptedAgentLabels: ['agent:claude'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
    priorityLabelRanking: ['priority:P0'],
    safeDefaultValidationCommands: [],
    systemd: { serviceName: 'modelspend.service', timerName: 'modelspend.timer' },
  }));
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

// #169: reproduces the observed #44 boundary through the real bin/run-project.sh
// entrypoint -- a machine-local runner.env carrying ModelSpend's canonical
// output/state paths must not be silently inherited by a different,
// explicitly selected project's dry run. The pinned scheduler must fail
// closed before any candidate/claim/model work rather than write into
// ModelSpend's durable state tree.
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
  writeFileSync(configPath, JSON.stringify({
    projectId: 'agent-runner',
    displayName: 'Agent Runner',
    githubRepo: 'TheTekTeam/agent-runner',
    localRepoPath: project,
    outputDir: '.var/agent-runner',
    stateDbPath: '.var/agent-runner/runner-state.sqlite',
    acceptedAgentLabels: ['agent:claude-code-cli'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
    priorityLabelRanking: ['priority:P0'],
    safeDefaultValidationCommands: [],
    systemd: { serviceName: 'agent-runner.service', timerName: 'agent-runner.timer' },
  }));
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
