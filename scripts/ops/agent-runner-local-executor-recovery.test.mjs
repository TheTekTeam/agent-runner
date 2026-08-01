import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { classifyInterruptedLocalExecutorJobs } from './agent-runner-local-executor-recovery.mjs';

const T0 = '2026-08-01T00:00:00.000Z';
const EXPIRED = '2026-07-31T23:59:00.000Z';
const ACTIVE = '2026-08-01T00:10:00.000Z';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE local_executor_jobs (
      job_id TEXT PRIMARY KEY,
      nonce TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      result_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT
    );
    CREATE TABLE local_executor_project_locks (
      project_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES local_executor_jobs(job_id) ON DELETE CASCADE
    );
  `);
  return {
    db,
    close() {
      db.close();
    },
  };
}

function insertJob(store, {
  jobId,
  projectId,
  operation,
  state = 'running',
  startedAt = '2026-07-31T23:00:00.000Z',
} = {}) {
  store.db.prepare(`
    INSERT INTO local_executor_jobs(
      job_id, nonce, project_id, operation, request_sha256, state, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(jobId, `nonce-${jobId}-00000000`, projectId, operation, '0'.repeat(64), state, startedAt);
}

function insertLock(store, { projectId, jobId, expiresAt }) {
  store.db.prepare(`
    INSERT INTO local_executor_project_locks(project_id, job_id, acquired_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(projectId, jobId, '2026-07-31T23:00:00.000Z', expiresAt);
}

function job(store, jobId) {
  const row = store.db.prepare('SELECT * FROM local_executor_jobs WHERE job_id = ?').get(jobId);
  return {
    ...row,
    result: JSON.parse(row.result_json),
  };
}

test('active leased jobs are preserved and never classified as interrupted', () => {
  const store = fixture();
  try {
    insertJob(store, { jobId: 'job-active-0001', projectId: 'project-a', operation: 'repository.sync-default' });
    insertLock(store, { projectId: 'project-a', jobId: 'job-active-0001', expiresAt: ACTIVE });

    const result = classifyInterruptedLocalExecutorJobs(store, { now: T0 });

    assert.deepEqual(result, []);
    assert.equal(job(store, 'job-active-0001').state, 'running');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM local_executor_project_locks').get().count, 1);
  } finally {
    store.close();
  }
});

test('expired read-only work is durably failed as retry-safe without automatic replay', () => {
  const store = fixture();
  try {
    insertJob(store, { jobId: 'job-readonly-01', projectId: 'project-a', operation: 'project.inspect' });
    insertLock(store, { projectId: 'project-a', jobId: 'job-readonly-01', expiresAt: EXPIRED });

    const result = classifyInterruptedLocalExecutorJobs(store, { now: T0 });
    const recovered = job(store, 'job-readonly-01');

    assert.deepEqual(result, [{
      jobId: 'job-readonly-01',
      projectId: 'project-a',
      operation: 'project.inspect',
      classification: 'retry-safe-read-only',
      errorCode: 'interrupted-read-only',
      lockState: 'expired',
    }]);
    assert.equal(recovered.state, 'failed');
    assert.equal(recovered.finished_at, T0);
    assert.equal(recovered.error_code, 'interrupted-read-only');
    assert.deepEqual(recovered.result, {
      recovery: {
        classification: 'retry-safe-read-only',
        reason: 'executor-process-interrupted',
        lockState: 'expired',
        automaticReplay: false,
      },
    });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM local_executor_project_locks').get().count, 0);
  } finally {
    store.close();
  }
});

test('expired potentially mutating work remains ambiguous and requires reconciliation', () => {
  const store = fixture();
  try {
    insertJob(store, { jobId: 'job-mutation-001', projectId: 'project-a', operation: 'worktree.remove' });
    insertLock(store, { projectId: 'project-a', jobId: 'job-mutation-001', expiresAt: EXPIRED });

    const result = classifyInterruptedLocalExecutorJobs(store, { now: T0 });
    const recovered = job(store, 'job-mutation-001');

    assert.equal(result[0].classification, 'manual-reconciliation-required');
    assert.equal(recovered.error_code, 'interrupted-operation-ambiguous');
    assert.equal(recovered.result.recovery.automaticReplay, false);
  } finally {
    store.close();
  }
});

test('an orphaned old job is classified without deleting a newer project lock', () => {
  const store = fixture();
  try {
    insertJob(store, { jobId: 'job-orphan-0001', projectId: 'project-a', operation: 'validation.run' });
    insertJob(store, { jobId: 'job-current-0001', projectId: 'project-a', operation: 'project.inspect', startedAt: T0 });
    insertLock(store, { projectId: 'project-a', jobId: 'job-current-0001', expiresAt: ACTIVE });

    const result = classifyInterruptedLocalExecutorJobs(store, { now: T0 });

    assert.equal(result.length, 1);
    assert.equal(result[0].jobId, 'job-orphan-0001');
    assert.equal(result[0].lockState, 'missing');
    assert.equal(job(store, 'job-current-0001').state, 'running');
    const lock = store.db.prepare('SELECT * FROM local_executor_project_locks').get();
    assert.equal(lock.job_id, 'job-current-0001');
  } finally {
    store.close();
  }
});

test('classification is durable and idempotent after the first pass', () => {
  const store = fixture();
  try {
    insertJob(store, { jobId: 'job-reopen-00001', projectId: 'project-a', operation: 'repository.fetch' });
    insertLock(store, { projectId: 'project-a', jobId: 'job-reopen-00001', expiresAt: EXPIRED });

    assert.equal(classifyInterruptedLocalExecutorJobs(store, { now: T0 }).length, 1);
    assert.equal(classifyInterruptedLocalExecutorJobs(store, { now: T0 }).length, 0);
    assert.equal(job(store, 'job-reopen-00001').state, 'failed');
  } finally {
    store.close();
  }
});

test('one-shot executor invokes recovery before accepting a new job', () => {
  const source = readFileSync(new URL('./agent-runner-local-executor-job.mjs', import.meta.url), 'utf8');
  const importPosition = source.indexOf("from './agent-runner-local-executor-recovery.mjs'");
  const recoveryPosition = source.indexOf('classifyInterruptedLocalExecutorJobs(store, { now });');
  const executePosition = source.indexOf('return executeLocalExecutorJob({ input, registry, policy, store, env, now });');

  assert.notEqual(importPosition, -1);
  assert.notEqual(recoveryPosition, -1);
  assert.notEqual(executePosition, -1);
  assert.ok(recoveryPosition < executePosition);
});
