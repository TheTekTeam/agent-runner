import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { redactSensitiveText } from './lib/redact.mjs';
import { openReadOnly } from './agent-runner-operator-doctor.mjs';
import { openRunnerStateStore, RUNNER_STATE_SCHEMA_VERSION } from './claude-runner-state.mjs';
import { buildAttentionEvent } from './claude-runner-recovery.mjs';
import {
  buildOperatorStatus,
  exitCodeForStatus,
  parseStatusArgs,
  readCircuitState,
  requiredUnitsInstalled,
  run,
} from './agent-runner-operator-status.mjs';

function writeConfig(dir) {
  const config = {
    projectId: 'modelspend',
    displayName: 'ModelSpend',
    githubRepo: 'TheTekTeam/modelspend',
    localRepoPath: join(dir, 'repo'),
    outputDir: join(dir, 'out'),
    stateDbPath: join(dir, 'out', 'runner-state.sqlite'),
    acceptedAgentLabels: ['agent:claude', 'agent:claude-code-cli'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
    priorityLabelRanking: ['priority:P0'],
    safeDefaultValidationCommands: [],
    systemd: {
      serviceName: 'agent-runner-status-test-does-not-exist.service',
      timerName: 'agent-runner-status-test-does-not-exist.timer',
    },
  };
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { configPath, config };
}

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
  return { digest: sha256File(dbPath), dirEntries: readdirSync(dirname(dbPath)).sort() };
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

test('parseStatusArgs accepts --json/--config and rejects unknown flags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-args-'));
  try {
    const { configPath } = writeConfig(dir);
    const ok = parseStatusArgs(['--config', configPath, '--json'], {});
    assert.equal(ok.error, undefined);
    assert.equal(ok.config.projectId, 'modelspend');
    assert.deepEqual(
      parseStatusArgs(['--config', configPath, '--bogus'], {}),
      { error: 'Unknown argument: --bogus' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCircuitState never creates the circuit db when it does not already exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-circuit-missing-'));
  try {
    const circuitDb = join(dir, 'never-created.sqlite');
    const result = readCircuitState({ AGENT_RUNNER_CIRCUIT_DB: circuitDb });
    assert.deepEqual(result, { blocked: false, exists: false });
    assert.equal(existsSync(circuitDb), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCircuitState reports an unavailable closed reason (never raw SQLite error text) when the file exists but has no admission_circuit table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-circuit-no-table-'));
  try {
    const circuitDb = join(dir, 'empty.sqlite');
    const db = new DatabaseSync(circuitDb);
    db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
    db.close();
    const result = readCircuitState({ AGENT_RUNNER_CIRCUIT_DB: circuitDb });
    assert.equal(result.blocked, false);
    assert.equal(result.exists, true);
    assert.equal(result.reason, 'circuit-state-unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCircuitState reports a tripped row read-only, without deleting a stale-fingerprint machine_profile row, and creates no WAL/SHM file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-circuit-tripped-'));
  try {
    const circuitDb = join(dir, 'circuit.sqlite');
    const db = new DatabaseSync(circuitDb);
    db.exec(`CREATE TABLE admission_circuit (
      scope TEXT PRIMARY KEY, reason TEXT NOT NULL, configuration_fingerprint TEXT NOT NULL,
      tripped_at TEXT NOT NULL, updated_at TEXT NOT NULL, occurrence_count INTEGER NOT NULL,
      notification_emitted INTEGER NOT NULL DEFAULT 0)`);
    db.prepare(`INSERT INTO admission_circuit
      (scope, reason, configuration_fingerprint, tripped_at, updated_at, occurrence_count, notification_emitted)
      VALUES ('machine_profile', 'implementation-machine-opt-in-disabled', 'sha256:stale-fingerprint-does-not-match', '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z', 1, 0)`).run();
    db.close();
    const before = snapshotDbDirectory(circuitDb);

    const result = readCircuitState({ AGENT_RUNNER_CIRCUIT_DB: circuitDb });
    assert.equal(result.blocked, true);
    assert.equal(result.scope, 'machine_profile');
    assert.equal(result.reason, 'implementation-machine-opt-in-disabled');
    assert.equal(result.configurationCurrent, false);

    // Read-only proof: the stale-fingerprint row is exactly what
    // AdmissionCircuitBreaker.check() would DELETE; this module must never
    // do so, and must never create a -wal/-shm file either.
    const after = snapshotDbDirectory(circuitDb);
    assert.deepEqual(after, before);
    assert.equal(after.dirEntries.some((name) => name.endsWith('-wal') || name.endsWith('-shm')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requiredUnitsInstalled distinguishes installed from not-found/unavailable', () => {
  assert.equal(requiredUnitsInstalled({ status: 'installed' }, { status: 'installed' }), true);
  assert.equal(requiredUnitsInstalled({ status: 'not-found' }, { status: 'installed' }), false);
  assert.equal(requiredUnitsInstalled({ status: 'installed' }, { status: 'unavailable' }), false);
});

test('buildOperatorStatus is genuinely read-only end to end: DB digest/schema/directory unchanged, no WAL/SHM created, redacted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-readonly-'));
  try {
    const { configPath, config } = writeConfig(dir);
    mkdirSync(config.outputDir, { recursive: true });
    const store = openRunnerStateStore(config.stateDbPath);
    try {
      store.recordRunResult({ repo: 'TheTekTeam/modelspend', issueNumber: 9, mode: 'issue-run', exitCode: 0, payload: { selectedIssue: 9 } });
      store.openHealthCondition({
        repo: 'TheTekTeam/modelspend',
        conditionType: 'queue_inspection_degraded',
        reason: 'candidate-scan-failed',
        safeNextAction: 'n/a',
        payload: { error: 'restricted-status-sentinel-value', home: '/home/status-user/secret-path' },
      });
    } finally {
      store.close();
    }
    const checkpoint = new DatabaseSync(config.stateDbPath);
    checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    checkpoint.close();

    const before = snapshotDbDirectory(config.stateDbPath);
    const beforeSchema = querySchemaState(config.stateDbPath);

    const report = buildOperatorStatus(config, {}, { now: () => '2026-07-24T21:00:00.000Z', spawn: installedSpawn(config) });
    assert.equal(report.ok, true);
    assert.equal(report.issueMutation, false);
    assert.equal(report.stateMutation, false);
    // Schema migration visibility: the seeded DB's schema version is
    // surfaced, not silently dropped.
    assert.equal(report.schemaVersionState, RUNNER_STATE_SCHEMA_VERSION);

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('restricted-status-sentinel'), false);
    assert.equal(serialized.includes('/home/status-user/secret-path'), false);
    assert.equal(redactSensitiveText(serialized), serialized);
    // The unsafe dashboard fields listed in the module header must never
    // appear at all.
    for (const forbidden of ['"queueEvents"', '"quota"', '"preflights"', '"selections"', '"claims"', '"dbPath"', '"diagnostics"']) {
      assert.equal(serialized.includes(forbidden), false, `unexpected field ${forbidden} in status output`);
    }

    // Adversarial redaction across the actual CLI's full serialized
    // stdout+stderr, not just the in-memory report object.
    const output = memoryIo();
    const code = run(['--config', configPath], {}, output.io, { spawn: installedSpawn(config) });
    const { stdout, stderr } = output.read();
    assert.equal(code, 0);
    assert.equal(stdout.includes('restricted-status-sentinel'), false);
    assert.equal(stderr.includes('restricted-status-sentinel'), false);
    assert.equal(redactSensitiveText(stdout + stderr), stdout + stderr);

    const after = snapshotDbDirectory(config.stateDbPath);
    const afterSchema = querySchemaState(config.stateDbPath);
    assert.deepEqual(after, before);
    assert.deepEqual(afterSchema, beforeSchema);
    assert.equal(after.dirEntries.some((name) => name.endsWith('-wal') || name.endsWith('-shm')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status fails closed on a missing state DB: nonzero systemic exit, fixed safe next action, no directory created', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-missing-'));
  try {
    const { config } = writeConfig(dir);
    const report = buildOperatorStatus(config, {}, { spawn: installedSpawn(config) });
    assert.equal(report.ok, false);
    assert.equal(report.status, 'missing');
    assert.equal(report.reason, 'state-db-missing');
    assert.notEqual(report.safeNextAction, undefined);
    assert.equal(exitCodeForStatus(report), 1);
    assert.equal(existsSync(dirname(config.stateDbPath)), false);
    assert.equal(redactSensitiveText(JSON.stringify(report)), JSON.stringify(report));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status fails closed when a required unit is not-found, distinct from unavailable and from installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-unit-not-found-'));
  try {
    const { config } = writeConfig(dir);
    mkdirSync(config.outputDir, { recursive: true });
    openRunnerStateStore(config.stateDbPath).close();
    const spawn = fakeSystemctl({
      [config.systemd.serviceName]: 'not-found',
      [config.systemd.timerName]: { loadState: 'loaded', activeState: 'inactive', unitFileState: 'disabled' },
    });
    const report = buildOperatorStatus(config, {}, { spawn });
    assert.equal(report.service.status, 'not-found');
    assert.equal(exitCodeForStatus(report), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status fails closed when systemctl inspection is unavailable, distinct from not-found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-unit-unavailable-'));
  try {
    const { config } = writeConfig(dir);
    mkdirSync(config.outputDir, { recursive: true });
    openRunnerStateStore(config.stateDbPath).close();
    const spawn = fakeSystemctl({
      [config.systemd.serviceName]: 'unavailable',
      [config.systemd.timerName]: { loadState: 'loaded', activeState: 'inactive', unitFileState: 'disabled' },
    });
    const report = buildOperatorStatus(config, {}, { spawn });
    assert.equal(report.service.status, 'unavailable');
    assert.notEqual(report.service.status, 'not-found');
    assert.equal(exitCodeForStatus(report), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status accepts an installed, disabled/inactive timer and service as a healthy pre-acceptance-gate state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-unit-installed-ok-'));
  try {
    const { config } = writeConfig(dir);
    mkdirSync(config.outputDir, { recursive: true });
    openRunnerStateStore(config.stateDbPath).close();
    const report = buildOperatorStatus(config, {}, { spawn: installedSpawn(config) });
    assert.equal(report.service.status, 'installed');
    assert.equal(report.service.activeState, 'inactive');
    assert.equal(report.timer.status, 'installed');
    assert.equal(report.timer.activeState, 'inactive');
    assert.equal(report.timer.unitFileState, 'disabled');
    assert.equal(exitCodeForStatus(report), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('operator status shows the shared assignment as Codex / Claude and the actual selected worker separately, without leaking the rest of the selection plan (#97)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-shared-assignment-'));
  try {
    const { config } = writeConfig(dir);
    mkdirSync(config.outputDir, { recursive: true });
    const store = openRunnerStateStore(config.stateDbPath);
    try {
      store.recordIssueSelection({
        repo: 'TheTekTeam/modelspend',
        issueNumber: 97,
        statusLabel: 'status:ready',
        selectionMode: 'preflight-direct',
        payload: {
          agent: { agentId: 'claude-code-cli', assignmentLabel: 'agent:codex-claude', assignmentDisplayName: 'Codex / Claude' },
          // The rest of the persisted plan must stay inside the state DB:
          // only the two assignment-evidence fields are projected out.
          stateDbPath: '/home/status-user/secret-state-path',
          statePersistenceErrors: ['restricted-selection-sentinel-value'],
        },
      });
      store.recordClaim({
        repo: 'TheTekTeam/modelspend',
        issueNumber: 97,
        claim: { action: 'claim-ready-issue', statusLabel: 'status:in-progress', selectionMode: 'preflight-direct' },
      });
    } finally {
      store.close();
    }

    const report = buildOperatorStatus(config, {}, { spawn: installedSpawn(config) });
    assert.equal(report.ok, true);
    assert.equal(report.currentTask.activeIssue.issue_number, 97);
    assert.equal(report.currentTask.activeIssue.assignment_label, 'agent:codex-claude');
    assert.equal(report.currentTask.activeIssue.assignment_display_name, 'Codex / Claude');
    // The shared label is eligibility metadata; the attempt still names the
    // one worker that actually holds it.
    assert.equal(report.currentTask.activeIssue.agent, 'claude-code-cli');
    assert.deepEqual(report.queue.assignments, [
      { assignmentLabel: 'agent:codex-claude', assignmentDisplayName: 'Codex / Claude', issueCount: 1 },
    ]);

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('restricted-selection-sentinel-value'), false);
    assert.equal(serialized.includes('/home/status-user/secret-state-path'), false);
    assert.equal(redactSensitiveText(serialized), serialized);
    assert.equal(report.issueMutation, false);
    assert.equal(report.stateMutation, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#172: a claim with a later terminal run result outside the presentation history window is never reported active-or-unresolved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-window-truncation-'));
  try {
    const { config } = writeConfig(dir);
    mkdirSync(config.outputDir, { recursive: true });
    const store = openRunnerStateStore(config.stateDbPath);
    try {
      store.recordClaim({
        repo: 'TheTekTeam/modelspend',
        issueNumber: 757,
        claim: { action: 'claim-ready-issue', statusLabel: 'status:in-progress', selectionMode: 'preflight-direct' },
        createdAt: '2026-07-28T21:23:13.615Z',
      });
      // The genuine terminal result for #757, recorded right after the
      // claim...
      store.recordRunResult({
        repo: 'TheTekTeam/modelspend', issueNumber: 757, mode: 'issue-run', exitCode: 1,
        startedAt: '2026-07-28T21:23:05.572Z', finishedAt: '2026-07-28T21:26:31.556Z',
        createdAt: '2026-07-28T21:26:31.556Z',
      });
      // ...then pushed outside the default historyLimit=10 presentation
      // window by 10 unrelated later run results for other issues.
      for (let index = 0; index < 10; index += 1) {
        store.recordRunResult({
          repo: 'TheTekTeam/modelspend', issueNumber: 900 + index, mode: 'issue-run', exitCode: 0,
          startedAt: '2026-07-29T00:00:00.000Z', finishedAt: '2026-07-29T00:01:00.000Z',
          createdAt: '2026-07-29T00:01:00.000Z',
        });
      }
    } finally {
      store.close();
    }

    const report = buildOperatorStatus(config, {}, { spawn: installedSpawn(config) });
    assert.equal(report.ok, true);
    assert.equal(report.currentTask.status, 'idle');
    assert.equal(report.currentTask.activeIssue, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#172: a genuinely unmatched claim (no run result at all) still fails closed as active-or-unresolved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-unmatched-claim-'));
  try {
    const { config } = writeConfig(dir);
    mkdirSync(config.outputDir, { recursive: true });
    const store = openRunnerStateStore(config.stateDbPath);
    try {
      store.recordClaim({
        repo: 'TheTekTeam/modelspend',
        issueNumber: 42,
        claim: { action: 'claim-ready-issue', statusLabel: 'status:in-progress', selectionMode: 'preflight-direct' },
        createdAt: '2026-08-01T00:00:00.000Z',
      });
    } finally {
      store.close();
    }

    const report = buildOperatorStatus(config, {}, { spawn: installedSpawn(config) });
    assert.equal(report.ok, true);
    assert.equal(report.currentTask.status, 'active-or-unresolved');
    assert.equal(report.currentTask.activeIssue.issue_number, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#172: a terminal result for the same issue number under a different repo never resolves this repo\'s claim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-overlapping-issue-numbers-'));
  try {
    const { config } = writeConfig(dir);
    mkdirSync(config.outputDir, { recursive: true });
    const store = openRunnerStateStore(config.stateDbPath);
    try {
      store.recordClaim({
        repo: 'TheTekTeam/modelspend',
        issueNumber: 757,
        claim: { action: 'claim-ready-issue', statusLabel: 'status:in-progress', selectionMode: 'preflight-direct' },
        createdAt: '2026-08-01T00:00:00.000Z',
      });
      store.recordRunResult({
        repo: 'TheTekTeam/other-project', issueNumber: 757, mode: 'issue-run', exitCode: 0,
        startedAt: '2026-08-01T00:01:00.000Z', finishedAt: '2026-08-01T00:02:00.000Z',
        createdAt: '2026-08-01T00:02:00.000Z',
      });
    } finally {
      store.close();
    }

    const report = buildOperatorStatus(config, {}, { spawn: installedSpawn(config) });
    assert.equal(report.ok, true);
    assert.equal(report.currentTask.status, 'active-or-unresolved');
    assert.equal(report.currentTask.activeIssue.repo, 'TheTekTeam/modelspend');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#172: task-local unresolved attention with no current claim stays attention_required/idle, not a global stop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-task-local-attention-'));
  try {
    const { config } = writeConfig(dir);
    mkdirSync(config.outputDir, { recursive: true });
    const store = openRunnerStateStore(config.stateDbPath);
    try {
      const event = buildAttentionEvent({
        repository: 'TheTekTeam/modelspend',
        project: 'modelspend',
        issueNumber: 757,
        attemptId: 'TheTekTeam/modelspend#757:historical-attention',
        reason: 'unknown_failure',
        agent: 'claude-code-cli',
        startedAt: '2026-07-28T21:23:13.615Z',
        finishedAt: '2026-07-28T21:26:31.556Z',
        recoveryStatus: 'forbidden',
        nextAction: 'Manager review.',
      });
      store.upsertAttentionEvent(event);
      // Historical terminal issue activity is essential to this fixture:
      // buildRunnerActivity() deliberately reports `empty` when there has
      // never been any selection/claim/run activity at all. The preserved
      // #757 condition has a terminal run result, so with no current claim
      // its correct current-task state is `idle` while unresolved task-local
      // attention remains `attention_required`.
      store.recordRunResult({
        repo: 'TheTekTeam/modelspend',
        issueNumber: 757,
        mode: 'issue-run',
        exitCode: 1,
        startedAt: '2026-07-28T21:23:05.572Z',
        finishedAt: '2026-07-28T21:26:31.556Z',
        createdAt: '2026-07-28T21:26:31.556Z',
      });
    } finally {
      store.close();
    }

    const report = buildOperatorStatus(config, {}, { spawn: installedSpawn(config) });
    assert.equal(report.ok, true);
    assert.equal(report.currentTask.status, 'idle');
    assert.equal(report.operatorStatus.code, 'attention_required');
    assert.notEqual(report.operatorStatus.code, 'global_systemic_pause');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exitCodeForStatus is a closed function of ok/service/timer/operatorStatus/circuit', () => {
  const installed = { status: 'installed' };
  const notFound = { status: 'not-found' };
  assert.equal(exitCodeForStatus({ ok: true, status: 'ok', service: installed, timer: installed, operatorStatus: { code: 'idle' }, circuit: { blocked: false } }), 0);
  assert.equal(exitCodeForStatus({ ok: false, status: 'missing', service: installed, timer: installed, operatorStatus: { code: 'idle' }, circuit: { blocked: false } }), 1);
  assert.equal(exitCodeForStatus({ ok: true, status: 'ok', service: notFound, timer: installed, operatorStatus: { code: 'idle' }, circuit: { blocked: false } }), 1);
  assert.equal(exitCodeForStatus({ ok: true, status: 'ok', service: installed, timer: installed, operatorStatus: { code: 'global_systemic_pause' }, circuit: { blocked: false } }), 1);
  assert.equal(exitCodeForStatus({ ok: true, status: 'ok', service: installed, timer: installed, operatorStatus: { code: 'idle' }, circuit: { blocked: true, scope: 'machine_profile' } }), 3);
});

test('run() fails closed on an unreadable --config file instead of an unhandled rejection with a raw stack trace and path', () => {
  const output = memoryIo();
  const code = run(['--config', '/nonexistent-agent-runner-status-config.json', '--json'], {}, output.io);
  assert.equal(code, 2);
  assert.deepEqual(JSON.parse(output.read().stderr), { ok: false, reason: 'config-load-failed' });
});

test('run() CLI wrapper exits 2 with a closed reason on an unknown flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-cli-usage-'));
  try {
    const { configPath } = writeConfig(dir);
    const output = memoryIo();
    const code = run(['--config', configPath, '--bogus'], {}, output.io);
    assert.equal(code, 2);
    assert.deepEqual(JSON.parse(output.read().stderr), { ok: false, reason: 'Unknown argument: --bogus' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run() CLI wrapper prints the bounded report and exits 0 for a healthy pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-cli-ok-'));
  try {
    const { configPath, config } = writeConfig(dir);
    mkdirSync(config.outputDir, { recursive: true });
    openRunnerStateStore(config.stateDbPath).close();
    const output = memoryIo();
    const code = run(['--config', configPath, '--json'], {}, output.io, { spawn: installedSpawn(config) });
    assert.equal(code, 0);
    const report = JSON.parse(output.read().stdout);
    assert.equal(report.project.projectId, 'modelspend');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run() CLI wrapper fails closed and stays redacted when the state DB is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-cli-missing-'));
  try {
    const { configPath, config } = writeConfig(dir);
    const output = memoryIo();
    const code = run(['--config', configPath, '--json'], {}, output.io, { spawn: installedSpawn(config) });
    const { stdout, stderr } = output.read();
    assert.equal(code, 1);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, false);
    assert.equal(report.status, 'missing');
    assert.notEqual(report.safeNextAction, 'No action required; all inspected systems are healthy.');
    assert.equal(redactSensitiveText(stdout + stderr), stdout + stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
