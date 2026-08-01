const READ_ONLY_OPERATIONS = new Set([
  'project.inspect',
  'worktree.inspect',
]);

const RECOVERY_LIMIT_DEFAULT = 100;
const RECOVERY_LIMIT_MAX = 500;

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('recovery timestamp is invalid');
  return date.toISOString();
}

function boundedLimit(value) {
  if (value == null) return RECOVERY_LIMIT_DEFAULT;
  if (!Number.isInteger(value) || value < 1 || value > RECOVERY_LIMIT_MAX) {
    throw new Error(`recovery limit must be an integer from 1 to ${RECOVERY_LIMIT_MAX}`);
  }
  return value;
}

function classificationFor(operation) {
  if (READ_ONLY_OPERATIONS.has(operation)) {
    return Object.freeze({
      classification: 'retry-safe-read-only',
      errorCode: 'interrupted-read-only',
    });
  }
  return Object.freeze({
    classification: 'manual-reconciliation-required',
    errorCode: 'interrupted-operation-ambiguous',
  });
}

function boundedRecoveryResult({ classification, lockState }) {
  return JSON.stringify({
    recovery: {
      classification,
      reason: 'executor-process-interrupted',
      lockState,
      automaticReplay: false,
    },
  });
}

export function classifyInterruptedLocalExecutorJobs(store, {
  now = new Date().toISOString(),
  limit = RECOVERY_LIMIT_DEFAULT,
} = {}) {
  if (!store?.db?.exec || !store?.db?.prepare) {
    throw new Error('local executor store with an open database is required');
  }

  const timestamp = iso(now);
  const bounded = boundedLimit(limit);
  const classified = [];

  store.db.exec('BEGIN IMMEDIATE');
  try {
    const rows = store.db.prepare(`
      SELECT
        jobs.job_id,
        jobs.project_id,
        jobs.operation,
        jobs.started_at,
        locks.job_id AS lock_job_id,
        locks.expires_at AS lock_expires_at
      FROM local_executor_jobs AS jobs
      LEFT JOIN local_executor_project_locks AS locks
        ON locks.project_id = jobs.project_id
       AND locks.job_id = jobs.job_id
      WHERE jobs.state = 'running'
        AND (locks.job_id IS NULL OR locks.expires_at <= ?)
      ORDER BY jobs.started_at ASC, jobs.job_id ASC
      LIMIT ?
    `).all(timestamp, bounded);

    const finish = store.db.prepare(`
      UPDATE local_executor_jobs
      SET state = 'failed',
          finished_at = ?,
          result_json = ?,
          error_code = ?
      WHERE job_id = ? AND state = 'running'
    `);
    const releaseExpiredLock = store.db.prepare(`
      DELETE FROM local_executor_project_locks
      WHERE project_id = ?
        AND job_id = ?
        AND expires_at <= ?
    `);

    for (const row of rows) {
      const recovery = classificationFor(row.operation);
      const lockState = row.lock_job_id ? 'expired' : 'missing';
      const updated = finish.run(
        timestamp,
        boundedRecoveryResult({
          classification: recovery.classification,
          lockState,
        }),
        recovery.errorCode,
        row.job_id,
      );
      if (Number(updated.changes) !== 1) continue;

      if (lockState === 'expired') {
        releaseExpiredLock.run(row.project_id, row.job_id, timestamp);
      }

      classified.push(Object.freeze({
        jobId: row.job_id,
        projectId: row.project_id,
        operation: row.operation,
        classification: recovery.classification,
        errorCode: recovery.errorCode,
        lockState,
      }));
    }

    store.db.exec('COMMIT');
    return Object.freeze(classified);
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
