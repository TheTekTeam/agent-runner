import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { redactSensitiveText } from './lib/redact.mjs';
import { openRunnerStateStore, RUNNER_STATE_TABLES } from './claude-runner-state.mjs';
import {
  buildDoctorReport,
  exitCodeForDoctorReport,
  inspectCheckout,
  inspectUnit,
  openReadOnly,
  parseDoctorArgs,
  readOnlyRunnerStateSnapshot,
  run,
  STATE_UNAVAILABLE_SAFE_NEXT_ACTION,
  unitState,
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

/**
 * Deterministic fake `systemctl --user show <unit> --property=... --value`
 * responder, keyed by unit name, so systemd inspection tests never depend
 * on the host's actual installed units. `responses[unit]` is either
 * 'unavailable' (simulated spawn/exit failure), 'not-found', or a
 * {loadState, activeState, unitFileState} object.
 */
function fakeSystemctl(responses) {
  return (_cmd, args) => {
    const unit = args[2];
    const response = responses[unit];
    if (!response || response === 'unavailable') {
      return { error: new Error('simulated systemctl unavailable'), status: null, stdout: '' };
    }
    if (response === 'not-found') {
      return { status: 0, stdout: 'not-found\ninactive\n\n' };
    }
    const { loadState = 'loaded', activeState = 'inactive', unitFileState = 'disabled' } = response;
    return { status: 0, stdout: `${loadState}\n${activeState}\n${unitFileState}\n` };
  };
}

function healthyAgentSettingsEnv(dir) {
  const settingsPath = join(dir, 'agent-settings.json');
  writeFileSync(settingsPath, JSON.stringify({ agents: { 'claude-code-cli': { enabled: true, paused: false, draining: false, disabled: false } } }));
  return { AGENT_RUNNER_AGENT_SETTINGS_PATH: settingsPath };
}

function installedSpawn(config) {
  return fakeSystemctl({
    [config.systemd.serviceName]: { loadState: 'loaded', activeState: 'inactive', unitFileState: 'static' },
    [config.systemd.timerName]: { loadState: 'loaded', activeState: 'inactive', unitFileState: 'disabled' },
  });
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function snapshotDbDirectory(dbPath) {
  return {
    digest: sha256File(dbPath),
    dirEntries: readdirSync(dirname(dbPath)).sort(),
  };
}

function querySchemaState(dbPath) {
  const db = openReadOnly(dbPath);
  try {
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    const schemaRows = db.prepare('SELECT * FROM runner_state_schema ORDER BY version').all();
    return { tables, schemaRows };
  } finally {
    db.close();
  }
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

test('inspectCheckout reports missing, clean, tracked-dirty and untracked-dirty states without leaking file paths', () => {
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
    const trackedDirty = inspectCheckout(repoPath);
    assert.equal(trackedDirty.present, true);
    assert.equal(trackedDirty.clean, false);
    assert.equal(trackedDirty.changedFileCount, 1);
    assert.equal('files' in trackedDirty, false);
    execFileSync('git', ['-C', repoPath, 'checkout', '--', 'README.md']);

    // Untracked-only: git status --untracked-files=no would previously
    // report this as clean:true. A single untracked file must flip
    // clean=false, and its name must never appear in output.
    writeFileSync(join(repoPath, 'untracked-secret-named-file.txt'), 'x');
    const untrackedDirty = inspectCheckout(repoPath);
    assert.equal(untrackedDirty.clean, false);
    assert.equal(untrackedDirty.changedFileCount, 1);
    const serialized = JSON.stringify(untrackedDirty);
    assert.equal(serialized.includes('untracked-secret-named-file'), false);
    assert.equal('files' in untrackedDirty, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectUnit / unitState distinguish installed, not-found and unavailable', () => {
  const spawn = fakeSystemctl({
    'present.service': { loadState: 'loaded', activeState: 'inactive', unitFileState: 'disabled' },
    'missing.service': 'not-found',
    'broken.service': 'unavailable',
  });

  const installed = inspectUnit('present.service', spawn);
  assert.equal(installed.status, 'installed');
  assert.equal(installed.loadState, 'loaded');
  assert.equal(installed.activeState, 'inactive');
  assert.equal(installed.unitFileState, 'disabled');

  const notFound = inspectUnit('missing.service', spawn);
  assert.equal(notFound.status, 'not-found');
  assert.equal(notFound.loadState, 'not-found');

  const unavailable = inspectUnit('broken.service', spawn);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.loadState, null);

  // The three statuses are mutually exclusive and distinct.
  assert.notEqual(installed.status, notFound.status);
  assert.notEqual(notFound.status, unavailable.status);
  assert.notEqual(installed.status, unavailable.status);

  assert.deepEqual(unitState('present.service', spawn), installed);
});

test('readOnlyRunnerStateSnapshot: missing DB fails closed and creates nothing, not even the parent directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-snapshot-missing-'));
  try {
    const dbPath = join(dir, 'never-created-subdir', 'runner-state.sqlite');
    const snapshot = readOnlyRunnerStateSnapshot(dbPath);
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.status, 'missing');
    assert.equal(snapshot.reason, 'state-db-missing');
    assert.equal(snapshot.safeNextAction, STATE_UNAVAILABLE_SAFE_NEXT_ACTION);
    assert.notEqual(snapshot.safeNextAction, 'No action required; all inspected systems are healthy.');
    assert.equal(existsSync(dirname(dbPath)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readOnlyRunnerStateSnapshot: a structurally incomplete DB (missing a required table) fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-snapshot-incomplete-'));
  try {
    const dbPath = join(dir, 'incomplete.sqlite');
    const db = new DatabaseSync(dbPath);
    // Only create the schema table -- every other RUNNER_STATE_TABLES
    // member is deliberately absent.
    db.exec('CREATE TABLE runner_state_schema (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.prepare('INSERT INTO runner_state_schema (version, applied_at) VALUES (1, ?)').run('2026-07-24T00:00:00Z');
    db.close();

    const snapshot = readOnlyRunnerStateSnapshot(dbPath);
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.status, 'incomplete');
    assert.equal(snapshot.reason, 'state-db-schema-incomplete');
    assert.equal(snapshot.safeNextAction, STATE_UNAVAILABLE_SAFE_NEXT_ACTION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readOnlyRunnerStateSnapshot: an unreadable/corrupt file fails closed with a typed reason, never a raw SQLite error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-snapshot-corrupt-'));
  try {
    const dbPath = join(dir, 'corrupt.sqlite');
    writeFileSync(dbPath, 'this is not a valid sqlite database file');
    const snapshot = readOnlyRunnerStateSnapshot(dbPath);
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.status, 'error');
    assert.equal(snapshot.reason, 'state-db-unreadable');
    assert.equal(JSON.stringify(snapshot).includes('malformed'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readOnlyRunnerStateSnapshot is genuinely read-only: DB byte digest, schema objects, schema rows and directory contents are unchanged, and no WAL/SHM file is created', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-snapshot-readonly-'));
  try {
    const dbPath = join(dir, 'state.sqlite');
    const store = openRunnerStateStore(dbPath);
    try {
      store.recordRunResult({ repo: 'TheTekTeam/modelspend', issueNumber: 1, mode: 'issue-run', exitCode: 0, payload: { selectedIssue: 1 } });
    } finally {
      store.close();
    }
    // Force a WAL checkpoint so the on-disk main file is fully
    // representative before taking the "before" snapshot, and confirm no
    // -wal/-shm file is left over from the writable store itself.
    const checkpoint = new DatabaseSync(dbPath);
    checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    checkpoint.close();

    const before = snapshotDbDirectory(dbPath);
    const beforeSchema = querySchemaState(dbPath);

    const snapshot = readOnlyRunnerStateSnapshot(dbPath, { includeLatest: true, historyLimit: 5 });
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.counts.run_results, 1);

    const after = snapshotDbDirectory(dbPath);
    const afterSchema = querySchemaState(dbPath);
    assert.deepEqual(after, before);
    assert.deepEqual(afterSchema, beforeSchema);
    assert.equal(after.dirEntries.some((name) => name.endsWith('-wal') || name.endsWith('-shm')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readOnlyRunnerStateSnapshot projects only bounded assignment evidence out of the selection plan (#97)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-snapshot-assignment-'));
  try {
    const dbPath = join(dir, 'state.sqlite');
    const store = openRunnerStateStore(dbPath);
    try {
      store.recordIssueSelection({
        repo: 'TheTekTeam/modelspend',
        issueNumber: 97,
        statusLabel: 'status:ready',
        selectionMode: 'preflight-direct',
        payload: {
          agent: { agentId: 'claude-code-cli', assignmentLabel: 'agent:codex-claude' },
          stateDbPath: '/home/doctor-user/secret-state-path',
          skipped: [{ issue: 96, reason: 'restricted-doctor-sentinel-value' }],
        },
      });
      store.recordIssueSelection({
        repo: 'TheTekTeam/modelspend',
        issueNumber: 95,
        statusLabel: 'status:ready',
        selectionMode: 'preflight-direct',
        payload: { agent: { agentId: 'claude-code-cli', assignmentLabel: 'agent:not-a-catalogue-label' } },
      });
    } finally {
      store.close();
    }

    const snapshot = readOnlyRunnerStateSnapshot(dbPath, { includeLatest: true, historyLimit: 5 });
    assert.equal(snapshot.ok, true);
    const byIssue = Object.fromEntries(snapshot.latest.selections.map((row) => [row.issue_number, row]));
    assert.deepEqual(byIssue[97].payload, { agent: { agentId: 'claude-code-cli', assignmentLabel: 'agent:codex-claude' } });
    // A label the adapter catalogue does not know fails closed rather than
    // being forwarded verbatim.
    assert.deepEqual(byIssue[95].payload, { agent: { agentId: 'claude-code-cli', assignmentLabel: null } });

    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes('restricted-doctor-sentinel-value'), false);
    assert.equal(serialized.includes('/home/doctor-user/secret-state-path'), false);
    assert.equal(serialized.includes('not-a-catalogue-label'), false);
    assert.equal(redactSensitiveText(serialized), serialized);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor report is genuinely read-only end to end: DB digest/schema/directory unchanged, no WAL/SHM created', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-readonly-e2e-'));
  try {
    const { configPath, config } = writeConfig(dir);
    initGitRepo(config.localRepoPath);
    const store = openRunnerStateStore(config.stateDbPath);
    try {
      store.recordRunResult({ repo: 'TheTekTeam/modelspend', issueNumber: 1, mode: 'issue-run', exitCode: 0, payload: { selectedIssue: 1 } });
      store.openHealthCondition({
        repo: 'TheTekTeam/modelspend',
        conditionType: 'queue_inspection_degraded',
        reason: 'candidate-scan-failed',
        safeNextAction: 'n/a',
        payload: { error: 'restricted-doctor-sentinel-value', home: '/home/doctor-user/secret-path' },
      });
    } finally {
      store.close();
    }
    const checkpoint = new DatabaseSync(config.stateDbPath);
    checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    checkpoint.close();

    const before = snapshotDbDirectory(config.stateDbPath);

    const output = memoryIo();
    const env = { ...HEALTHY_ADMISSION_ENV, ...healthyAgentSettingsEnv(dir) };
    const code = run(['--config', configPath, '--project', 'modelspend'], env, output.io, { spawn: installedSpawn(config) });
    const { stdout, stderr } = output.read();
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    assert.equal(report.issueMutation, false);
    assert.equal(report.stateMutation, false);
    assert.equal(report.state.counts.run_results, 1);
    assert.equal(report.safeNextAction, 'No action required; all inspected systems are healthy.');

    const combined = stdout + stderr;
    assert.equal(combined.includes('restricted-doctor-sentinel'), false);
    assert.equal(combined.includes('/home/doctor-user/secret-path'), false);
    assert.equal(redactSensitiveText(combined), combined);

    const after = snapshotDbDirectory(config.stateDbPath);
    assert.deepEqual(after, before);
    assert.equal(after.dirEntries.some((name) => name.endsWith('-wal') || name.endsWith('-shm')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor fails closed on a missing state DB: nonzero systemic exit, fixed safe next action, never "No action required"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-missing-state-'));
  try {
    const { configPath, config } = writeConfig(dir);
    initGitRepo(config.localRepoPath);
    const output = memoryIo();
    const code = run(['--config', configPath, '--project', 'modelspend'], HEALTHY_ADMISSION_ENV, output.io, { spawn: installedSpawn(config) });
    const { stdout, stderr } = output.read();
    const report = JSON.parse(stdout);
    assert.equal(code, 1);
    assert.equal(report.state.ok, false);
    assert.equal(report.state.status, 'missing');
    assert.equal(report.safeNextAction, STATE_UNAVAILABLE_SAFE_NEXT_ACTION);
    assert.notEqual(report.safeNextAction, 'No action required; all inspected systems are healthy.');
    const combined = stdout + stderr;
    assert.equal(redactSensitiveText(combined), combined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor fails closed when a required unit is not-found, distinct from unavailable and from an installed disabled/inactive unit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-unit-not-found-'));
  try {
    const { configPath, config } = writeConfig(dir);
    initGitRepo(config.localRepoPath);
    const output = memoryIo();
    const spawn = fakeSystemctl({
      [config.systemd.serviceName]: 'not-found',
      [config.systemd.timerName]: { loadState: 'loaded', activeState: 'inactive', unitFileState: 'disabled' },
    });
    const code = run(['--config', configPath, '--project', 'modelspend'], HEALTHY_ADMISSION_ENV, output.io, { spawn });
    const { stdout, stderr } = output.read();
    const report = JSON.parse(stdout);
    assert.equal(code, 1);
    assert.equal(report.service.status, 'not-found');
    assert.equal(report.timer.status, 'installed');
    assert.notEqual(report.safeNextAction, 'No action required; all inspected systems are healthy.');
    assert.equal(redactSensitiveText(stdout + stderr), stdout + stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor fails closed when systemctl inspection is unavailable, distinct from not-found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-unit-unavailable-'));
  try {
    const { configPath, config } = writeConfig(dir);
    initGitRepo(config.localRepoPath);
    const output = memoryIo();
    const spawn = fakeSystemctl({
      [config.systemd.serviceName]: 'unavailable',
      [config.systemd.timerName]: { loadState: 'loaded', activeState: 'inactive', unitFileState: 'disabled' },
    });
    const code = run(['--config', configPath, '--project', 'modelspend'], HEALTHY_ADMISSION_ENV, output.io, { spawn });
    const report = JSON.parse(output.read().stdout);
    assert.equal(code, 1);
    assert.equal(report.service.status, 'unavailable');
    assert.notEqual(report.service.status, 'not-found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor accepts an installed, disabled/inactive timer and service as a healthy pre-acceptance-gate state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-unit-installed-ok-'));
  try {
    const { configPath, config } = writeConfig(dir);
    initGitRepo(config.localRepoPath);
    openRunnerStateStore(config.stateDbPath).close();
    const output = memoryIo();
    const env = { ...HEALTHY_ADMISSION_ENV, ...healthyAgentSettingsEnv(dir) };
    const code = run(['--config', configPath, '--project', 'modelspend'], env, output.io, { spawn: installedSpawn(config) });
    const report = JSON.parse(output.read().stdout);
    assert.equal(code, 0);
    assert.equal(report.service.status, 'installed');
    assert.equal(report.service.activeState, 'inactive');
    assert.equal(report.timer.status, 'installed');
    assert.equal(report.timer.activeState, 'inactive');
    assert.equal(report.timer.unitFileState, 'disabled');
    assert.equal(report.safeNextAction, 'No action required; all inspected systems are healthy.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor fails closed (exit 3) when machine admission is a machine_profile pause', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-admission-blocked-'));
  try {
    const { configPath, config } = writeConfig(dir);
    initGitRepo(config.localRepoPath);
    openRunnerStateStore(config.stateDbPath).close();
    const output = memoryIo();
    const code = run(['--config', configPath, '--project', 'modelspend'], {
      CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'false',
    }, output.io, { spawn: installedSpawn(config) });
    const { stdout, stderr } = output.read();
    const report = JSON.parse(stdout);
    assert.equal(code, 3);
    assert.equal(report.admission.allowed, false);
    assert.equal(report.admission.scope, 'machine_profile');
    assert.equal(report.admission.reason, 'implementation-machine-opt-in-disabled');
    assert.match(report.safeNextAction, /approved installer/);
    assert.equal(redactSensitiveText(stdout + stderr), stdout + stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor reports a routable adapter as healthy when machine-local settings enable it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-adapter-'));
  try {
    const { configPath, config } = writeConfig(dir);
    initGitRepo(config.localRepoPath);
    openRunnerStateStore(config.stateDbPath).close();
    const env = {
      ...healthyAgentSettingsEnv(dir),
      CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true',
      CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'octocat',
    };
    const output = memoryIo();
    const code = run(['--config', configPath, '--project', 'modelspend'], env, output.io, { spawn: installedSpawn(config) });
    const report = JSON.parse(output.read().stdout);
    assert.equal(code, 0);
    assert.equal(report.admission.allowed, true);
    assert.deepEqual(report.adapters, [{ agentId: 'claude-code-cli', fileFound: true, routable: true, reason: 'agent-routable' }]);
    assert.equal(report.safeNextAction, 'No action required; all inspected systems are healthy.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exitCodeForDoctorReport is a closed function of state/service/timer/admission status', () => {
  const installed = { status: 'installed' };
  const notFound = { status: 'not-found' };
  assert.equal(exitCodeForDoctorReport({ state: { ok: true }, service: installed, timer: installed, admission: { allowed: true } }), 0);
  assert.equal(exitCodeForDoctorReport({ state: { ok: false, status: 'missing' }, service: installed, timer: installed, admission: { allowed: true } }), 1);
  assert.equal(exitCodeForDoctorReport({ state: { ok: true }, service: notFound, timer: installed, admission: { allowed: true } }), 1);
  assert.equal(exitCodeForDoctorReport({ state: { ok: true }, service: installed, timer: installed, admission: { allowed: false, scope: 'machine_profile' } }), 3);
  assert.equal(exitCodeForDoctorReport({ state: { ok: true }, service: installed, timer: installed, admission: { allowed: false, scope: 'systemic' } }), 0);
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
