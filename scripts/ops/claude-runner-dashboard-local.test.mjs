import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openRunnerStateStore } from './claude-runner-state.mjs';
import { run, writeLocalDashboard } from './claude-runner-dashboard-local.mjs';

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('writeLocalDashboard emits static assets and embedded missing-state data', () => withTempDir('modelspend-runner-local-dashboard-', (dir) => {
  const outDir = join(dir, 'dashboard');
  const dbPath = join(dir, 'missing.sqlite');
  const result = writeLocalDashboard({ dbPath, outDir });

  assert.equal(result.dashboard.status, 'missing');
  assert.equal(result.dashboard.diagnostics[0].code, 'state-db-missing');
  assert.equal(existsSync(join(outDir, 'index.html')), true);
  assert.equal(existsSync(join(outDir, 'dashboard.js')), true);
  assert.equal(existsSync(join(outDir, 'styles.css')), true);
  assert.equal(existsSync(join(outDir, 'favicon.ico')), true);

  const html = readFileSync(join(outDir, 'index.html'), 'utf8');
  assert.match(html, /href="\.\/favicon\.ico"/);

  const data = readFileSync(join(outDir, 'dashboard-data.js'), 'utf8');
  assert.match(data, /^window\.RUNNER_DASHBOARD_DATA = /);
  assert.match(data, /state-db-missing/);
}));

test('writeLocalDashboard renders populated runner API data without changing API fields', () => withTempDir('modelspend-runner-local-dashboard-populated-', (dir) => {
  const dbPath = join(dir, 'state.sqlite');
  const outDir = join(dir, 'dashboard');
  const store = openRunnerStateStore(dbPath, { now: () => '2026-07-09T14:00:00.000Z' });
  try {
    store.recordIssueSelection({
      repo: 'TheTekTeam/modelspend',
      issueNumber: 657,
      selectionMode: 'preflight-direct',
      dryRun: false,
      payload: { selectedIssue: 657 },
      createdAt: '2026-07-09T14:01:00.000Z',
    });
    store.recordRunResult({
      repo: 'TheTekTeam/modelspend',
      issueNumber: 657,
      mode: 'issue-run',
      exitCode: 0,
      payload: { selectedIssue: 657 },
      startedAt: '2026-07-09T14:01:00.000Z',
      finishedAt: '2026-07-09T14:11:00.000Z',
      createdAt: '2026-07-09T14:11:00.000Z',
    });
  } finally {
    store.close();
  }

  const result = writeLocalDashboard({ dbPath, outDir, historyLimit: 5 });
  assert.equal(result.dashboard.status, 'ok');
  assert.equal(result.dashboard.latest.selections[0].issue_number, 657);
  assert.equal(result.dashboard.latest.runResults[0].exit_code, 0);

  const data = readFileSync(join(outDir, 'dashboard-data.js'), 'utf8');
  assert.match(data, /"latest"/);
  assert.match(data, /"metrics"/);
  assert.match(data, /"issue_number": 657/);
}));

test('local dashboard CLI writes files and reports diagnostics', () => withTempDir('modelspend-runner-local-dashboard-cli-', (dir) => {
  const outDir = join(dir, 'dashboard');
  const dbPath = join(dir, 'missing.sqlite');
  const io = memoryIo();
  assert.equal(run(['--db', dbPath, '--out-dir', outDir], {}, io.io), 0);
  assert.match(io.read().stdout, /Wrote Agent Runner dashboard/);
  assert.match(io.read().stdout, /state-db-missing/);
  assert.equal(existsSync(join(outDir, 'index.html')), true);
  assert.equal(existsSync(join(outDir, 'favicon.ico')), true);
}));