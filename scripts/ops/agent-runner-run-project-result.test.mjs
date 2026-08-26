import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '../..');

// The project-scoped-env gate loads this for real, so it must satisfy the full config schema.
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

// Pins GITHUB_REPOSITORY so ambient CI env can't contaminate tests unrelated to identity rejection.
function envWithRepo(repo, overrides = {}) {
  return { ...process.env, GITHUB_REPOSITORY: repo, ...overrides };
}

test('run-project records handled no-op reason while preserving shell exit zero', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('run-project intentionally refuses root');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'agent-runner-project-result-'));
  const project = join(root, 'project'), config = join(root, 'modelspend.json'), fakeNode = join(root, 'node'), resultFile = join(root, 'run-result.json');
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
    env: envWithRepo('TheTekTeam/modelspend', {
      REAL_NODE: process.execPath,
      AGENT_RUNNER_NODE_BIN: fakeNode,
      AGENT_RUNNER_CONFIG: config,
      AGENT_RUNNER_ENV_FILE: join(root, 'missing.env'),
      AGENT_RUNNER_EXECUTE: 'true',
      AGENT_RUNNER_RUN_RESULT_FILE: resultFile,
    }),
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /admission circuit paused/);
  const recorded = JSON.parse(readFileSync(resultFile, 'utf8'));
  assert.deepEqual({ schemaVersion: recorded.schemaVersion, state: recorded.state, reason: recorded.reason, exitCode: recorded.exitCode }, { schemaVersion: 'agent-runner-project-run-result/v1', state: 'handled_noop', reason: 'circuit-paused', exitCode: 0 });
  assert.match(recorded.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
});

// A shared runner.env carrying ModelSpend's canonical paths must not leak into a different selected project's dry run.
test('run-project dry run fails closed instead of inheriting a different project\'s output/state paths from shared machine environment', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('run-project intentionally refuses root');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'agent-runner-project-isolation-'));
  const project = join(root, 'project'), configPath = join(root, 'agent-runner.json'), envFile = join(root, 'runner.env');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(configPath, JSON.stringify(projectConfig('agent-runner', { localRepoPath: project, acceptedAgentLabels: ['agent:claude-code-cli'] })));
  writeFileSync(envFile, 'CLAUDE_RUNNER_OUTPUT_DIR=/home/gp/.local/state/agent-runner/modelspend\nCLAUDE_RUNNER_STATE_DB=/home/gp/.local/state/agent-runner/modelspend/runner-state.sqlite\n');

  const run = spawnSync('bash', [join(ROOT, 'bin/run-project.sh')], {
    encoding: 'utf8',
    env: envWithRepo('TheTekTeam/agent-runner', {
      AGENT_RUNNER_CONFIG: configPath,
      AGENT_RUNNER_ENV_FILE: envFile,
      AGENT_RUNNER_EXECUTE: 'false',
    }),
  });

  assert.notEqual(run.status, 0, `wrapper unexpectedly inherited a mismatched project identity\nstdout:\n${run.stdout || ''}\nstderr:\n${run.stderr || ''}`);
  assert.match(run.stderr, /CLAUDE_RUNNER_OUTPUT_DIR.*disagrees with project "agent-runner"/);
});

// #227: a candidate-specific machine_profile cost/circuit refusal must be
// distinguished from a generic issue_not_runnable candidate-authority
// refusal in the wrapper's recorded run result, without writing any attempt/
// claim/child side effect.
test('run-project distinguishes a candidate-specific machine_profile cost refusal from a generic candidate-authority refusal', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('run-project intentionally refuses root');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'agent-runner-project-cost-refusal-'));
  const project = join(root, 'project'), config = join(root, 'modelspend.json'), fakeNode = join(root, 'node'), resultFile = join(root, 'run-result.json');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(config, JSON.stringify(projectConfig('modelspend', { localRepoPath: project })));
  writeFileSync(fakeNode, `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 0 ] || [ "\${1:-}" = "-e" ]; then exec "$REAL_NODE" "$@"; fi
case "\${1:-}" in
  *agent-runner-circuit-breaker.mjs) [ "\${2:-}" = "check" ] && exit 0 ;;
  *agent-runner-admission.mjs) exit 0 ;;
  *claude-runner-candidate-probe.mjs) exit 0 ;;
  *agent-runner-candidate-admission.mjs)
    echo '{"admission":{"allowed":false,"scope":"machine_profile","reason":"candidate-machine-profile-cost-denied","effectiveFingerprint":"sha256:${'a'.repeat(64)}","occurrenceCount":1}}'
    exit 3
    ;;
esac
exit 99
`);
  chmodSync(fakeNode, 0o755);

  const run = spawnSync('bash', [join(ROOT, 'bin/run-project.sh')], {
    encoding: 'utf8',
    env: envWithRepo('TheTekTeam/modelspend', {
      REAL_NODE: process.execPath,
      AGENT_RUNNER_NODE_BIN: fakeNode,
      AGENT_RUNNER_CONFIG: config,
      AGENT_RUNNER_ENV_FILE: join(root, 'missing.env'),
      AGENT_RUNNER_EXECUTE: 'true',
      AGENT_RUNNER_RUN_RESULT_FILE: resultFile,
    }),
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /candidate-specific cost\/profile policy refused/);
  const recorded = JSON.parse(readFileSync(resultFile, 'utf8'));
  assert.deepEqual({ state: recorded.state, reason: recorded.reason, exitCode: recorded.exitCode }, { state: 'handled_noop', reason: 'candidate-machine-profile-refused', exitCode: 0 });
});

// #231: the wrapper's own pre-claim candidate-admission call never enters
// the pinned atomic runner's revalidation transaction, so it must publish
// the handled machine_profile refusal through the same canonical GitHub
// attention channel itself, via the shared publisher, before the wrapper
// exits handled/zero.
test('run-project publishes a pre-claim machine_profile refusal through the canonical GitHub attention channel via the shared publisher', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('run-project intentionally refuses root');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'agent-runner-project-cost-publish-'));
  const project = join(root, 'project'), config = join(root, 'modelspend.json'), fakeNode = join(root, 'node'), resultFile = join(root, 'run-result.json');
  // `bin/run-project.sh` always exports a fixed PATH prefix including
  // `$HOME/.local/bin` ahead of any inherited PATH, so a real `gh` binary
  // there would shadow a PATH-prepended fake one. Pin HOME to an isolated
  // directory and place the fake `gh` exactly where the wrapper will find
  // it first.
  const fakeHome = join(root, 'home');
  const binDir = join(fakeHome, '.local', 'bin'), ghLog = join(root, 'gh-calls.jsonl');
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(config, JSON.stringify(projectConfig('modelspend', { localRepoPath: project })));
  writeFileSync(fakeNode, `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 0 ] || [ "\${1:-}" = "-e" ]; then exec "$REAL_NODE" "$@"; fi
case "\${1:-}" in
  *agent-runner-circuit-breaker.mjs) [ "\${2:-}" = "check" ] && exit 0 ;;
  *agent-runner-admission.mjs) exit 0 ;;
  *claude-runner-candidate-probe.mjs) exit 0 ;;
  *agent-runner-candidate-pause-publish.mjs) exec "$REAL_NODE" "$@" ;;
  *agent-runner-candidate-admission.mjs)
    echo '{"admission":{"allowed":false,"scope":"machine_profile","reason":"candidate-machine-profile-cost-denied","safeNextAction":"A changed manager intent requires a fresh superseding immutable manager-preflight authority.","effectiveFingerprint":"sha256:${'a'.repeat(64)}","occurrenceCount":1},"current":{"issueNumber":692}}'
    exit 3
    ;;
esac
exit 99
`);
  chmodSync(fakeNode, 0o755);

  const fakeGh = join(binDir, 'gh');
  writeFileSync(fakeGh, `#!/usr/bin/env ${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'issue' && args[1] === 'view') process.stdout.write('{"comments":[]}');
else if (args[0] === 'issue' && args[1] === 'comment') process.stdout.write('https://github.com/TheTekTeam/modelspend/issues/692#issuecomment-1');
else process.stdout.write('{}');
`);
  chmodSync(fakeGh, 0o755);

  const run = spawnSync('bash', [join(ROOT, 'bin/run-project.sh')], {
    encoding: 'utf8',
    env: envWithRepo('TheTekTeam/modelspend', {
      REAL_NODE: process.execPath,
      AGENT_RUNNER_NODE_BIN: fakeNode,
      AGENT_RUNNER_CONFIG: config,
      AGENT_RUNNER_ENV_FILE: join(root, 'missing.env'),
      AGENT_RUNNER_EXECUTE: 'true',
      AGENT_RUNNER_RUN_RESULT_FILE: resultFile,
      GH_CALL_LOG: ghLog,
      GH_TOKEN: 'test-token',
      HOME: fakeHome,
      PATH: `${binDir}:${process.env.PATH}`,
    }),
  });

  assert.equal(run.status, 0, `stdout:\n${run.stdout || ''}\nstderr:\n${run.stderr || ''}`);
  const recorded = JSON.parse(readFileSync(resultFile, 'utf8'));
  assert.deepEqual({ state: recorded.state, reason: recorded.reason, exitCode: recorded.exitCode }, { state: 'handled_noop', reason: 'candidate-machine-profile-refused', exitCode: 0 });

  assert.ok(existsSync(ghLog), `expected gh to be invoked; stdout:\n${run.stdout || ''}\nstderr:\n${run.stderr || ''}`);
  const calls = readFileSync(ghLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const commentCall = calls.find((args) => args[0] === 'issue' && args[1] === 'comment');
  assert.ok(commentCall, `expected a GitHub attention comment call, got calls:\n${JSON.stringify(calls)}`);
  const body = commentCall[commentCall.indexOf('--body') + 1];
  assert.match(body, /candidate-machine-profile-cost-denied/);
  assert.match(body, /### Failure projection/);
  assert.match(body, /Attempt created: `false`/);
  assert.match(body, /Child launched: `false`/);
  assert.doesNotMatch(body, /unknown_failure/);
});

test('run-project keeps a generic candidate-authority refusal as its existing issue_not_runnable reason', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('run-project intentionally refuses root');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'agent-runner-project-authority-refusal-'));
  const project = join(root, 'project'), config = join(root, 'modelspend.json'), fakeNode = join(root, 'node'), resultFile = join(root, 'run-result.json');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(config, JSON.stringify(projectConfig('modelspend', { localRepoPath: project })));
  writeFileSync(fakeNode, `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 0 ] || [ "\${1:-}" = "-e" ]; then exec "$REAL_NODE" "$@"; fi
case "\${1:-}" in
  *agent-runner-circuit-breaker.mjs) [ "\${2:-}" = "check" ] && exit 0 ;;
  *agent-runner-admission.mjs) exit 0 ;;
  *claude-runner-candidate-probe.mjs) exit 0 ;;
  *agent-runner-candidate-admission.mjs)
    echo '{"admission":{"allowed":false,"reason":"candidate-status-changed"}}'
    exit 3
    ;;
esac
exit 99
`);
  chmodSync(fakeNode, 0o755);

  const run = spawnSync('bash', [join(ROOT, 'bin/run-project.sh')], {
    encoding: 'utf8',
    env: envWithRepo('TheTekTeam/modelspend', {
      REAL_NODE: process.execPath,
      AGENT_RUNNER_NODE_BIN: fakeNode,
      AGENT_RUNNER_CONFIG: config,
      AGENT_RUNNER_ENV_FILE: join(root, 'missing.env'),
      AGENT_RUNNER_EXECUTE: 'true',
      AGENT_RUNNER_RUN_RESULT_FILE: resultFile,
    }),
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /candidate authority changed or is not approved/);
  const recorded = JSON.parse(readFileSync(resultFile, 'utf8'));
  assert.deepEqual({ state: recorded.state, reason: recorded.reason, exitCode: recorded.exitCode }, { state: 'handled_noop', reason: 'candidate-authority-refused', exitCode: 0 });
});

// A nested re-entry must not inherit AGENT_RUNNER_RUN_RESULT_FILE and overwrite the outer execute result with a false dry-run one.
test('run-project scrubs AGENT_RUNNER_RUN_RESULT_FILE from every child so a nested re-entry cannot overwrite the outer execute result', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('run-project intentionally refuses root');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'agent-runner-result-ownership-'));
  const project = join(root, 'project'), config = join(root, 'modelspend.json'), fakeNode = join(root, 'node'), resultFile = join(root, 'run-result.json');
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
    env: envWithRepo('TheTekTeam/modelspend', {
      REAL_NODE: process.execPath,
      AGENT_RUNNER_NODE_BIN: fakeNode,
      AGENT_RUNNER_CONFIG: config,
      AGENT_RUNNER_ENV_FILE: join(root, 'missing.env'),
      AGENT_RUNNER_EXECUTE: 'true',
      AGENT_RUNNER_RUN_RESULT_FILE: resultFile,
      NESTED_ROOT: ROOT,
    }),
  });

  assert.equal(run.status, 0, `stdout:\n${run.stdout || ''}\nstderr:\n${run.stderr || ''}`);
  const recorded = JSON.parse(readFileSync(resultFile, 'utf8'));
  assert.deepEqual({ state: recorded.state, reason: recorded.reason, exitCode: recorded.exitCode }, { state: 'canonical_runner_invoked', reason: 'canonical-runner-executed', exitCode: 0 });
});
