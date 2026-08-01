import {
  VALIDATION_EVIDENCE_SCHEMA_VERSION,
  VALIDATION_FINAL_STATES,
  ValidationEvidenceError,
  validationDigest,
  validationStableJson,
} from './agent-runner-validation-profile-contract.mjs';

const MAX_EVIDENCE_BYTES = 256 * 1024;

function boundedEvidence(value) {
  const encoded = validationStableJson(value);
  if (Buffer.byteLength(encoded) > MAX_EVIDENCE_BYTES) {
    throw new ValidationEvidenceError(
      'evidence-too-large',
      'validation evidence exceeds the bounded limit',
    );
  }
  return encoded;
}

function compactJobResult(evidence) {
  return Object.freeze({
    validationEvidence: Object.freeze({
      validationId: evidence.validationId,
      state: evidence.state,
      profile: evidence.profile,
      profileContractSha256: evidence.profileContractSha256,
      expectedSha: evidence.expectedSha,
      observedSha: evidence.observedSha,
      expiresAt: evidence.expiresAt,
      commandCount: evidence.commands.length,
      artifactCount: evidence.artifacts.length,
      errorCode: evidence.errorCode,
    }),
  });
}

export class ValidationEvidenceStore {
  constructor(localExecutorStore) {
    if (!localExecutorStore?.db) {
      throw new Error('local executor store is required');
    }
    this.localExecutorStore = localExecutorStore;
    this.db = localExecutorStore.db;
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS validation_evidence_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS validation_runs (
        validation_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        profile TEXT NOT NULL,
        profile_contract_sha256 TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('canonical', 'worktree')),
        expected_sha TEXT NOT NULL,
        observed_sha TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('succeeded', 'failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        error_code TEXT,
        FOREIGN KEY (job_id)
          REFERENCES local_executor_jobs(job_id)
          ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS validation_command_results (
        validation_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        executable TEXT NOT NULL,
        argv_sha256 TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        environment_names_json TEXT NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        status INTEGER,
        signal TEXT,
        duration_ms INTEGER,
        stdout_bytes INTEGER NOT NULL,
        stdout_sha256 TEXT NOT NULL,
        stderr_bytes INTEGER NOT NULL,
        stderr_sha256 TEXT NOT NULL,
        PRIMARY KEY (validation_id, ordinal),
        FOREIGN KEY (validation_id)
          REFERENCES validation_runs(validation_id)
          ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS validation_artifacts (
        validation_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY (validation_id, relative_path),
        FOREIGN KEY (validation_id)
          REFERENCES validation_runs(validation_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS validation_runs_lookup_idx
        ON validation_runs(
          project_id,
          profile,
          profile_contract_sha256,
          observed_sha,
          state,
          finished_at
        );
    `);
    this.db.prepare(`
      INSERT OR IGNORE INTO validation_evidence_schema(version, applied_at)
      VALUES (?, ?)
    `).run(VALIDATION_EVIDENCE_SCHEMA_VERSION, new Date().toISOString());
    const schema = this.db.prepare(`
      SELECT MAX(version) AS version FROM validation_evidence_schema
    `).get();
    if (Number(schema?.version) !== VALIDATION_EVIDENCE_SCHEMA_VERSION) {
      throw new ValidationEvidenceError(
        'validation-schema-unsupported',
        'validation evidence schema version is unsupported',
      );
    }
  }

  getByJobId(jobId) {
    const row = this.db.prepare(`
      SELECT evidence_json FROM validation_runs WHERE job_id = ?
    `).get(jobId);
    return row ? Object.freeze(JSON.parse(row.evidence_json)) : null;
  }

  get(validationId) {
    const row = this.db.prepare(`
      SELECT evidence_json FROM validation_runs WHERE validation_id = ?
    `).get(validationId);
    return row ? Object.freeze(JSON.parse(row.evidence_json)) : null;
  }

  recordAndSanitizeJob(job, evidence) {
    if (!VALIDATION_FINAL_STATES.has(evidence.state)) {
      throw new Error('validation evidence final state is invalid');
    }
    const requestSha256 = validationDigest(validationStableJson({
      jobId: evidence.jobId,
      projectId: evidence.projectId,
      repository: evidence.repository,
      profile: evidence.profile,
      profileContractSha256: evidence.profileContractSha256,
      target: evidence.target,
      expectedSha: evidence.expectedSha,
    }));
    const encoded = boundedEvidence(evidence);
    const compact = validationStableJson(compactJobResult(evidence));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(`
        SELECT request_sha256, evidence_json
        FROM validation_runs
        WHERE validation_id = ? OR job_id = ?
      `).get(evidence.validationId, evidence.jobId);
      if (existing) {
        if (
          existing.request_sha256 !== requestSha256
          || existing.evidence_json !== encoded
        ) {
          throw new ValidationEvidenceError(
            'validation-id-collision',
            'validation identity was reused with different evidence',
          );
        }
        this.db.exec('COMMIT');
        return Object.freeze(JSON.parse(existing.evidence_json));
      }
      this.db.prepare(`
        INSERT INTO validation_runs(
          validation_id,
          job_id,
          project_id,
          repository,
          profile,
          profile_contract_sha256,
          target_kind,
          expected_sha,
          observed_sha,
          state,
          started_at,
          finished_at,
          expires_at,
          request_sha256,
          evidence_json,
          error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evidence.validationId,
        evidence.jobId,
        evidence.projectId,
        evidence.repository,
        evidence.profile,
        evidence.profileContractSha256,
        evidence.target,
        evidence.expectedSha,
        evidence.observedSha,
        evidence.state,
        evidence.startedAt,
        evidence.finishedAt,
        evidence.expiresAt,
        requestSha256,
        encoded,
        evidence.errorCode,
      );
      const commandStatement = this.db.prepare(`
        INSERT INTO validation_command_results(
          validation_id,
          ordinal,
          executable,
          argv_sha256,
          working_directory,
          environment_names_json,
          timeout_seconds,
          status,
          signal,
          duration_ms,
          stdout_bytes,
          stdout_sha256,
          stderr_bytes,
          stderr_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const command of evidence.commands) {
        commandStatement.run(
          evidence.validationId,
          command.ordinal,
          command.executable,
          command.argvSha256,
          command.workingDirectory,
          validationStableJson(command.environmentNames),
          command.timeoutSeconds,
          command.status,
          command.signal,
          command.durationMs,
          command.stdout.bytes,
          command.stdout.sha256,
          command.stderr.bytes,
          command.stderr.sha256,
        );
      }
      const artifactStatement = this.db.prepare(`
        INSERT INTO validation_artifacts(
          validation_id,
          relative_path,
          bytes,
          sha256
        ) VALUES (?, ?, ?, ?)
      `);
      for (const artifact of evidence.artifacts) {
        artifactStatement.run(
          evidence.validationId,
          artifact.relativePath,
          artifact.bytes,
          artifact.sha256,
        );
      }
      const updated = this.db.prepare(`
        UPDATE local_executor_jobs
        SET state = ?, result_json = ?, error_code = ?
        WHERE job_id = ?
      `).run(
        evidence.state,
        compact,
        evidence.errorCode,
        job.jobId,
      );
      if (Number(updated.changes) !== 1) {
        throw new ValidationEvidenceError(
          'validation-job-missing',
          'validation job disappeared before evidence persistence',
        );
      }
      this.db.exec('COMMIT');
      return evidence;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
