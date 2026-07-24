import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { redactSensitiveText } from './lib/redact.mjs';
import { openRunnerStateStore } from './claude-runner-state.mjs';
import {
  buildDoctorReport,
  exitCodeForDoctorReport,
  inspectCheckout,
  parseDoctorArgs,
  run,
} from './agent-runner-operator-doctor.mjs';

const BASE_CONFIG_FIELDS = {
  displayName: 'ModelSpend',
  githubRepo: 'TheTekTeam/modelspend',
  acceptedAgentLabels: ['agent:claude', 'agent:claude-code-cli'],
  statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
  priorityLabelRanking: ['priority:P0'],
  safeDefaultValidationCommands: [],
  systemd: {
    serviceName: 'agent-runner-doctor-test-does-not-exist.service',
    timerName: 'agent-runner-doctor-test-does-not-exist.timer',
  },
};

function writeConfig(dir, overrides = {}) {
  const configPath = join(dir, 'config.json');
  const config = {
    projectId: 'modelspend',
    localRepoPath: join(dir, 'repo'),
    outputDir: join(dir, 'out'),
    stateDbPath: join(dir, 'out', 'runner-state.sqlite'),
    ...BASE_CONFIG_FIELDS,
    ...overrides,
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { configPath, config };
}

function initGitRepo(path) {
  execFileSync('git', ['init', '-q', path]);
  execFileSync('git', ['-C', path, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Test']);
  writeFileSync(join(path, 'README.md'), 'hello\n');
  execFileSync('git', ['-C', path, 'add', 'README.md']);
  execFileSync('git', ['-C', path, 'commit', '-q', '-m', 'init']);
}

const HEALTHY_ADMISSION_ENV = {
  CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true',
  CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'octocat',
};

function memoryIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: (text) => { stderr += text; } },
    },
    read: () => ({ stdout, stderr }),
  };
}

test('parseDoctorArgs requires --project and rejects a project identity mismatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-args-'));
  try {
    const { configPath } = writeConfig(dir);
    assert.deepEqual(parseDoctorArgs(['--config', configPath], {}), { error: '--project is required' });
    assert.deepEqual(
      parseDoctorArgs(['--config', configPath, '--project', 'not-modelspend'], {}),
      { error: 'project-identity-mismatch' },
    );
    const ok = parseDoctorArgs(['--config', configPath, '--project', 'modelspend'], {});
    assert.equal(ok.error, undefined);
    assert.equal(ok.project, 'modelspend');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseDoctorArgs rejects unknown arguments with a closed reason, never raw parser text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-args-unknown-'));
  try {
    const { configPath } = writeConfig(dir);
    const result = parseDoctorArgs(['--config', configPath, '--project', 'modelspend', '--bogus'], {});
    assert.equal(result.error, 'Unknown argument: --bogus');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectCheckout reports missing, clean and dirty states without leaking file paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-checkout-'));
  try {
    const missing = inspectCheckout(join(dir, 'does-not-exist'));
    assert.equal(missing.present, false);
    assert.equal(missing.reason, 'checkout-missing');

    const repoPath = join(dir, 'repo');
    initGitRepo(repoPath);
    const clean = inspectCheckout(repoPath);
    assert.equal(clean.present, true);
    assert.equal(clean.clean, true);
    assert.equal(clean.changedFileCount, 0);
    assert.match(clean.headShortSha, /^[0-9a-f]{12}$/);

    writeFileSync(join(repoPath, 'README.md'), 'changed\n');
    const dirty = inspectCheckout(repoPath);
    assert.equal(dirty.present, true);
    assert.equal(dirty.clean, false);
    assert.equal(dirty.changedFileCount, 1);
    assert.equal('files' in dirty, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor report is read-only: seeded state row counts and max ids are unchanged after running', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-readonly-'));
  try {
    const { configPath, config } = writeConfig(dir);
    initGitRepo(config.localRepoPath);
    const store = openRunnerStateStore(config.stateDbPath);
    let health;
    try {
      store.recordRunResult({ repo: 'TheTekTeam/modelspend', issueNumber: 1, mode: 'issue-run', exitCode: 0, payload: { selectedIssue: 1 } });
      store.openHealthCondition({
        repo: 'TheTekTeam/modelspend',
        conditionType: 'queue_inspection_degraded',
        reason: 'candidate-scan-failed',
        safeNextAction: 'n/a',
        payload: { error: 'restricted-doctor-sentinel-value', home: '/home/doctor-user/secret-path' },
      });
      health = store.currentHealthConditions();
    } finally {
      store.close();
    }
    const before = openRunnerStateStore(config.stateDbPath);
    const beforeCounts = { run_results: before.countRows('run_results'), runner_health_conditions: before.countRows('runner_health_conditions') };
    const beforeMaxRunId = before.latestRows('run_results', 1)[0]?.id;
    before.close();

    const output = memoryIo();
    const code = run(['--config', configPath, '--project', 'modelspend'], HEALTHY_ADMISSION_ENV, output.io);
    const { stdout, stderr } = output.read();
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    assert.equal(report.issueMutation, false);
    assert.equal(report.stateMutation, false);
    assert.equal(report.state.counts.run_results, 1);

    // Redaction proof: the bounded doctor state summary never forwards raw
    // health-condition payloads (which may embed secrets or local paths),
    // across the full serialized stdout+stderr.
    const combined = stdout + stderr;
    assert.equal(combined.includes('restricted-doctor-sentinel'), false);
    assert.equal(combined.includes('/home/doctor-user/secret-path'), false);
    assert.equal(redactSensitiveText(combined), combined);
    assert.ok(health.length === 1);

    const after = openRunnerStateStore(config.stateDbPath);
    const afterCounts = { run_results: after.countRows('run_results'), runner_health_conditions: after.countRows('runner_health_conditions') };
    const afterMaxRunId = after.latestRows('run_results', 1)[0]?.id;
    after.close();
    assert.deepEqual(afterCounts, beforeCounts);
    assert.equal(afterMaxRunId, beforeMaxRunId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor reports missing state DB as healthy-but-unavailable, exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-missing-state-'));
  try {
    const { configPath, config } = writeConfig(dir);
    initGitRepo(config.localRepoPath);
    const output = memoryIo();
    const code = run(['--config', configPath, '--project', 'modelspend'], HEALTHY_ADMISSION_ENV, output.io);
    const report = JSON.parse(output.read().stdout);
    assert.equal(code, 0);
    assert.equal(report.state.status, 'missing');
    assert.equal(report.state.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor fails closed (exit 3) when machine admission is a machine_profile pause', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-admission-blocked-'));
  try {
    const { configPath, config } = writeConfig(dir);
    initGitRepo(config.localRepoPath);
    const output = memoryIo();
    const code = run(['--config', configPath, '--project', 'modelspend'], {
      CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'false',
    }, output.io);
    const report = JSON.parse(output.read().stdout);
    assert.equal(code, 3);
    assert.equal(report.admission.allowed, false);
    assert.equal(report.admission.scope, 'machine_profile');
    assert.equal(report.admission.reason, 'implementation-machine-opt-in-disabled');
    assert.match(report.safeNextAction, /approved installer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor reports a routable adapter as healthy when machine-local settings enable it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-adapter-'));
  try {
    const { configPath, config } = writeConfig(dir);
    initGitRepo(config.localRepoPath);
    const settingsPath = join(dir, 'agent-settings.json');
    writeFileSync(settingsPath, JSON.stringify({ agents: { 'claude-code-cli': { enabled: true, paused: false, draining: false, disabled: false } } }));
    const env = {
      AGENT_RUNNER_AGENT_SETTINGS_PATH: settingsPath,
      CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true',
      CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'octocat',
    };
    const output = memoryIo();
    const code = run(['--config', configPath, '--project', 'modelspend'], env, output.io);
    const report = JSON.parse(output.read().stdout);
    assert.equal(code, 0);
    assert.equal(report.admission.allowed, true);
    assert.deepEqual(report.adapters, [{ agentId: 'claude-code-cli', fileFound: true, routable: true, reason: 'agent-routable' }]);
    assert.equal(report.safeNextAction, 'No action required; all inspected systems are healthy.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exitCodeForDoctorReport is a closed function of state/admission status', () => {
  assert.equal(exitCodeForDoctorReport({ state: { status: 'ok' }, admission: { allowed: true } }), 0);
  assert.equal(exitCodeForDoctorReport({ state: { status: 'error' }, admission: { allowed: true } }), 1);
  assert.equal(exitCodeForDoctorReport({ state: { status: 'ok' }, admission: { allowed: false, scope: 'machine_profile' } }), 3);
  assert.equal(exitCodeForDoctorReport({ state: { status: 'ok' }, admission: { allowed: false, scope: 'systemic' } }), 0);
});

test('run() fails closed on an unreadable --config file instead of an unhandled rejection with a raw stack trace and path', async () => {
  const output = memoryIo();
  const code = await run(['--config', '/nonexistent-agent-runner-doctor-config.json', '--project', 'modelspend'], {}, output.io);
  assert.equal(code, 2);
  assert.deepEqual(JSON.parse(output.read().stderr), { ok: false, reason: 'config-load-failed' });
});

test('doctor CLI process (subprocess) exits 2 on missing --project and prints no stack trace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-subprocess-'));
  try {
    const { configPath } = writeConfig(dir);
    let threw = false;
    try {
      execFileSync(
        process.execPath,
        [new URL('./agent-runner-operator-doctor.mjs', import.meta.url).pathname, '--config', configPath],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      threw = true;
      assert.equal(error.status, 2);
      assert.equal(/\n\s+at /.test(String(error.stderr)), false);
    }
    assert.equal(threw, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
