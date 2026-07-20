import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createStateRecorder, parseArgs } from './claude-runner-cron.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '../..');
const RUNNER_WRAPPER = join(REPO_ROOT, 'scripts/ops/jobs/run-claude-runner.sh');

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`,
  );
  return result;
}

test('parseArgs defaults runner state DB under the selected output directory', () => {
  const defaults = parseArgs([], {});
  assert.equal(defaults.outputDir, '.var/claude-runner');
  assert.equal(defaults.stateDbPath, '.var/claude-runner/runner-state.sqlite');

  const outputOverride = parseArgs(['--output-dir', '.var/custom-runner'], {});
  assert.equal(outputOverride.outputDir, '.var/custom-runner');
  assert.equal(outputOverride.stateDbPath, '.var/custom-runner/runner-state.sqlite');
});

test('parseArgs supports explicit runner state DB overrides from env and CLI', () => {
  assert.equal(parseArgs([], { CLAUDE_RUNNER_STATE_DB: '/tmp/runner.sqlite' }).stateDbPath, '/tmp/runner.sqlite');
  assert.equal(parseArgs(['--state-db', '/tmp/cli.sqlite'], {}).stateDbPath, '/tmp/cli.sqlite');
});

test('createStateRecorder records through an injected store without exposing persistence errors to runner control flow', () => {
  const calls = [];
  const recorder = createStateRecorder({ outputDir: '.var/out', stateDbPath: '/tmp/state.sqlite' }, (dbPath) => ({
    recordQueueEvent(payload) { calls.push(['queue', dbPath, payload]); },
    recordRunResult() { throw new Error('disk temporarily unavailable'); },
    close() { calls.push(['close']); },
  }));

  assert.equal(recorder.available, true);
  recorder.record('recordQueueEvent', { repo: 'TheTekTeam/modelspend', eventType: 'skip' });
  recorder.record('recordRunResult', { repo: 'TheTekTeam/modelspend' });
  recorder.close();

  assert.deepEqual(calls[0], ['queue', '/tmp/state.sqlite', { repo: 'TheTekTeam/modelspend', eventType: 'skip' }]);
  assert.deepEqual(calls[1], ['close']);
  assert.equal(recorder.errors.length, 1);
  assert.equal(recorder.errors[0].stage, 'recordRunResult');
  assert.match(recorder.errors[0].message, /disk temporarily unavailable/);
});

test('createStateRecorder degrades gracefully when the SQLite store cannot be opened', () => {
  const recorder = createStateRecorder({ outputDir: '.var/out', stateDbPath: '/tmp/state.sqlite' }, () => {
    throw new Error('cannot open state DB');
  });

  assert.equal(recorder.available, false);
  recorder.record('recordQueueEvent', { repo: 'TheTekTeam/modelspend', eventType: 'skip' });
  recorder.close();
  assert.deepEqual(recorder.errors, [{ stage: 'open', message: 'cannot open state DB' }]);
});

test('scheduled wrapper accepts a linked Git worktree as MODELSPEND_REPO_DIR', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'modelspend-runner-worktree-'));
  const repoDir = join(root, 'repo');
  const worktreeDir = join(root, 'validation-worktree');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(repoDir, 'scripts/ops'), { recursive: true });
  runChecked('git', ['init', repoDir]);
  runChecked('git', ['-C', repoDir, 'config', 'user.name', 'ModelSpend Test']);
  runChecked('git', ['-C', repoDir, 'config', 'user.email', 'test@modelspend.local']);
  writeFileSync(
    join(repoDir, 'scripts/ops/claude-runner-cron.mjs'),
    "console.log('worktree-wrapper-ok');\n",
  );
  runChecked('git', ['-C', repoDir, 'add', '.']);
  runChecked('git', ['-C', repoDir, 'commit', '-m', 'fixture']);
  runChecked('git', ['-C', repoDir, 'worktree', 'add', '--detach', worktreeDir, 'HEAD']);

  assert.equal(statSync(join(worktreeDir, '.git')).isFile(), true);

  const result = spawnSync('bash', [RUNNER_WRAPPER], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MODELSPEND_ENV_FILE: join(root, 'missing.env'),
      MODELSPEND_REPO_DIR: worktreeDir,
      CLAUDE_RUNNER_CRON_EXECUTE: 'false',
      CLAUDE_RUNNER_ARGS: '',
    },
  });

  assert.equal(
    result.status,
    0,
    `wrapper rejected linked worktree\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`,
  );
  assert.match(result.stdout, /starting Claude runner selector/);
  assert.match(result.stdout, /worktree-wrapper-ok/);
});
