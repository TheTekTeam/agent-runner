import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizePrPublicationRequest, PrContractError } from './agent-runner-pr-contract.mjs';
import { publishDraftPullRequest } from './agent-runner-pr-publication.mjs';
import { collectGitHubCheckSnapshot } from './agent-runner-github-checks-provider.mjs';
import { normalizeCheckSnapshot } from './agent-runner-event-settlement.mjs';
import { projectFromRegistryById } from './agent-runner-project-registry.mjs';
import { requiredProfilesForRisk, validationProfileContractSha256 } from './agent-runner-validation-profile-contract.mjs';

export const PR_CONTROLLER_SCHEMA_VERSION = 1;
export const PR_CONTROLLER_STAGES = Object.freeze(['validated', 'publishing', 'published', 'settling', 'settled', 'attention']);
const json = (v) => JSON.stringify(v ?? {});
const parse = (r) => r && Object.freeze({
  transactionId: r.transaction_id, stage: r.stage, reasonCode: r.reason_code, prNumber: r.pr_number, prUrl: r.pr_url,
  settlementStatus: r.settlement_status, settlementFingerprint: r.settlement_fingerprint,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Durable, restart-safe pipeline-stage evidence: implementation (caller-owned) -> validated -> publishing -> published -> settling/settled/attention. Distinct from PrTransactionStore, which only tracks the publication transaction itself. */
export class PrControllerStateStore {
  constructor(dbPath, { now = () => new Date().toISOString() } = {}) {
    if (!dbPath) throw new Error('pr controller db path is required');
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS pr_controller_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_controller_state(
        transaction_id TEXT PRIMARY KEY,
        stage TEXT NOT NULL CHECK(stage IN ('validated','publishing','published','settling','settled','attention')),
        reason_code TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        settlement_status TEXT,
        settlement_fingerprint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.prepare('INSERT OR IGNORE INTO pr_controller_schema VALUES(?,?)').run(PR_CONTROLLER_SCHEMA_VERSION, this.now());
  }

  get(transactionId) { return parse(this.db.prepare('SELECT * FROM pr_controller_state WHERE transaction_id=?').get(transactionId)); }

  setStage(transactionId, stage, { reasonCode = null, prNumber = null, prUrl = null, settlementStatus = null, settlementFingerprint = null, now = this.now() } = {}) {
    if (!PR_CONTROLLER_STAGES.includes(stage)) throw new Error('pr controller stage is invalid');
    const existing = this.get(transactionId);
    if (!existing) {
      this.db.prepare(`
        INSERT INTO pr_controller_state(transaction_id, stage, reason_code, pr_number, pr_url, settlement_status, settlement_fingerprint, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(transactionId, stage, reasonCode, prNumber, prUrl, settlementStatus, settlementFingerprint, now, now);
    } else {
      this.db.prepare(`
        UPDATE pr_controller_state SET stage=?, reason_code=COALESCE(?,reason_code), pr_number=COALESCE(?,pr_number),
          pr_url=COALESCE(?,pr_url), settlement_status=COALESCE(?,settlement_status), settlement_fingerprint=COALESCE(?,settlement_fingerprint), updated_at=?
        WHERE transaction_id=?
      `).run(stage, reasonCode, prNumber, prUrl, settlementStatus, settlementFingerprint, now, transactionId);
    }
    return this.get(transactionId);
  }

  close() { this.db.close(); }
}

const NON_TERMINAL_STATUSES = new Set(['pending', 'in_progress', 'waiting', 'queued', 'requested']);

/** Bounded, generic classification of an already-normalized check snapshot: no per-check-name policy, no ModelSpend-specific logic. */
export function classifyPrSettlement(snapshot) {
  if (!snapshot?.checks) return Object.freeze({ status: 'pending', reasonCode: 'no-check-snapshot' });
  if (snapshot.checks.length === 0) return Object.freeze({ status: 'pending', reasonCode: 'no-checks-reported' });
  if (!snapshot.checks.every((c) => c.terminal)) return Object.freeze({ status: 'pending', reasonCode: 'checks-in-progress' });
  const failed = snapshot.checks.filter((c) => c.conclusion && c.conclusion !== 'success' && c.conclusion !== 'neutral' && c.conclusion !== 'skipped');
  if (failed.length > 0) return Object.freeze({ status: 'failed', reasonCode: 'checks-failed' });
  return Object.freeze({ status: 'succeeded', reasonCode: 'checks-succeeded' });
}

/**
 * One controller cycle for one already-validated implementation attempt.
 * Publishes via the merged PR.CONTRACT.1 surface exactly once per transaction
 * identity (idempotent replay/adoption is owned by PrTransactionStore), then
 * observes PR-check settlement and persists the pipeline stage. Never merges,
 * approves, closes the issue, deletes branches, or performs any GitHub write
 * beyond the bounded draft-PR publication `publishDraftPullRequest` already
 * performs.
 */
export async function runPrControllerCycle({
  request, controllerStore, transactionStore, client, evidenceStore, profileContracts, authorityCheck,
  collectSettlement = collectGitHubCheckSnapshot, now = new Date().toISOString(),
} = {}) {
  if (!controllerStore || typeof controllerStore.setStage !== 'function') throw new Error('pr controller state store is required');
  const normalized = normalizePrPublicationRequest(request);
  const { transactionId } = normalized;
  controllerStore.setStage(transactionId, 'validated', { now });
  controllerStore.setStage(transactionId, 'publishing', { now });
  let published;
  try {
    published = await publishDraftPullRequest({ request: normalized, store: transactionStore, client, evidenceStore, profileContracts, authorityCheck, now });
  } catch (error) {
    const reasonCode = error instanceof PrContractError ? error.code : 'pr-controller-publication-failed';
    controllerStore.setStage(transactionId, 'attention', { reasonCode, now });
    throw error;
  }
  controllerStore.setStage(transactionId, 'published', { reasonCode: null, prNumber: published.prNumber, prUrl: published.url, now });
  controllerStore.setStage(transactionId, 'settling', { now });
  let snapshot;
  try {
    const raw = await collectSettlement({ repository: normalized.repository, sha: published.headSha, requestJson: client?.requestJson, observedAt: now });
    snapshot = normalizeCheckSnapshot({ sha: published.headSha, observedAt: now, queryComplete: raw.queryComplete !== false, checks: raw.checks || [] });
  } catch {
    const state = controllerStore.setStage(transactionId, 'settling', { settlementStatus: 'pending', settlementFingerprint: null, reasonCode: 'settlement-read-incomplete', now });
    return Object.freeze({ schemaVersion: 1, transactionId, prNumber: published.prNumber, url: published.url, stage: state.stage, settlementStatus: 'pending', reasonCode: 'settlement-read-incomplete' });
  }
  const settlement = classifyPrSettlement(snapshot.queryComplete ? snapshot : { checks: null });
  const stage = settlement.status === 'pending' ? 'settling' : 'settled';
  const state = controllerStore.setStage(transactionId, stage, {
    settlementStatus: settlement.status, settlementFingerprint: snapshot.fingerprint, reasonCode: settlement.reasonCode, now,
  });
  return Object.freeze({
    schemaVersion: 1, transactionId, prNumber: published.prNumber, url: published.url, adopted: published.adopted,
    replayed: published.replayed === true, stage: state.stage, settlementStatus: settlement.status, reasonCode: settlement.reasonCode,
  });
}

export const PR_CONTROLLER_ATTEMPT_STATES = Object.freeze(['validated', 'published', 'settled', 'attention']);
export const PR_CONTROLLER_WORKER_STATES = Object.freeze(['held', 'released']);
const SCHEDULABLE_ATTEMPT_STATES = Object.freeze(['validated', 'published']);
const attemptRow = (r) => r && Object.freeze({
  attemptId: r.attempt_id, projectId: r.project_id, repository: r.repository, issueNumber: r.issue_number,
  sourceBranch: r.source_branch, targetBranch: r.target_branch, expectedHeadSha: r.expected_head_sha,
  managerRevision: r.manager_revision, managerFingerprint: r.manager_fingerprint, executorJobId: r.executor_job_id,
  riskClass: r.risk_class, approvedScope: r.approved_scope,
  filesChanged: Object.freeze(JSON.parse(r.files_changed_json)), knownLimitations: Object.freeze(JSON.parse(r.known_limitations_json)),
  state: r.state, workerState: r.worker_state, transactionId: r.transaction_id, reasonCode: r.reason_code,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * Durable record of an implementation attempt that already reached successful
 * exact-head validation. The scheduler builds publication requests from these
 * rows rather than from free-form agent output, so a restart replays from the
 * same evidence. This store grants no mutation authority of its own.
 */
export class PrControllerAttemptStore {
  constructor(dbPath, { now = () => new Date().toISOString() } = {}) {
    if (!dbPath) throw new Error('pr controller attempt db path is required');
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS pr_controller_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_controller_attempts(
        attempt_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        source_branch TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        expected_head_sha TEXT NOT NULL,
        manager_revision TEXT NOT NULL,
        manager_fingerprint TEXT NOT NULL,
        executor_job_id TEXT NOT NULL,
        risk_class TEXT NOT NULL,
        approved_scope TEXT NOT NULL,
        files_changed_json TEXT NOT NULL,
        known_limitations_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('validated','published','settled','attention')),
        worker_state TEXT NOT NULL CHECK(worker_state IN ('held','released')),
        transaction_id TEXT,
        reason_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pr_controller_attempts_ready
        ON pr_controller_attempts(state, created_at, attempt_id);
    `);
    this.db.prepare('INSERT OR IGNORE INTO pr_controller_schema VALUES(?,?)')
      .run(PR_CONTROLLER_SCHEMA_VERSION, this.now());
  }

  get(attemptId) {
    return attemptRow(this.db.prepare('SELECT * FROM pr_controller_attempts WHERE attempt_id=?').get(attemptId));
  }

  /** Idempotent: re-recording the same attempt identity is a no-op; a changed identity is refused. */
  recordValidatedAttempt(input, { now = this.now() } = {}) {
    const attemptId = input?.attemptId;
    if (typeof attemptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(attemptId)) {
      throw new PrContractError('invalid-request', 'attemptId is invalid');
    }
    // Normalizing here rejects malformed attempts at record time rather than at dispatch time.
    normalizePrPublicationRequest({
      ...input,
      requestId: attemptId,
      requiredValidationProfiles: [{ profile: 'placeholder', validationId: 'validation-placeholder' }],
    });
    const existing = this.get(attemptId);
    if (existing) {
      const same = existing.projectId === input.projectId && existing.repository === input.repository
        && existing.issueNumber === input.issueNumber && existing.sourceBranch === input.sourceBranch
        && existing.targetBranch === input.targetBranch
        && existing.expectedHeadSha === String(input.expectedHeadSha).toLowerCase()
        && existing.managerRevision === input.managerRevision && existing.managerFingerprint === input.managerFingerprint
        && existing.executorJobId === input.executorJobId && existing.riskClass === input.riskClass;
      if (!same) throw new PrContractError('idempotency-key-collision', 'attempt identity was reused with different evidence');
      return existing;
    }
    this.db.prepare(`
      INSERT INTO pr_controller_attempts(
        attempt_id, project_id, repository, issue_number, source_branch, target_branch, expected_head_sha,
        manager_revision, manager_fingerprint, executor_job_id, risk_class, approved_scope,
        files_changed_json, known_limitations_json, state, worker_state, transaction_id, reason_code, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'validated','held',NULL,NULL,?,?)
    `).run(
      attemptId, input.projectId, input.repository, input.issueNumber, input.sourceBranch, input.targetBranch,
      String(input.expectedHeadSha).toLowerCase(), input.managerRevision, input.managerFingerprint,
      input.executorJobId, input.riskClass, input.approvedScope,
      JSON.stringify(input.filesChanged ?? []), JSON.stringify(input.knownLimitations ?? []), now, now,
    );
    return this.get(attemptId);
  }

  listSchedulableAttempts({ limit = 10 } = {}) {
    const bounded = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 10;
    return Object.freeze(this.db.prepare(`
      SELECT * FROM pr_controller_attempts
      WHERE state IN ('validated','published')
      ORDER BY created_at ASC, attempt_id ASC
      LIMIT ?
    `).all(bounded).map(attemptRow));
  }

  finishAttempt(attemptId, { state, workerState, transactionId = null, reasonCode = null, now = this.now() } = {}) {
    if (!PR_CONTROLLER_ATTEMPT_STATES.includes(state)) throw new Error('pr controller attempt state is invalid');
    if (!PR_CONTROLLER_WORKER_STATES.includes(workerState)) throw new Error('pr controller worker state is invalid');
    this.db.prepare(`
      UPDATE pr_controller_attempts
      SET state=?, worker_state=?, transaction_id=COALESCE(?,transaction_id), reason_code=?, updated_at=?
      WHERE attempt_id=?
    `).run(state, workerState, transactionId, reasonCode, now, attemptId);
    return this.get(attemptId);
  }

  close() { this.db.close(); }
}

/**
 * Resolves the validation evidence a durable attempt must present, from the
 * configured risk-class profile mapping and the evidence store. Returns a
 * bounded reason code instead of throwing when evidence is absent, so the
 * scheduler can open attention evidence and keep draining other projects.
 */
export function resolveAttemptValidation({ attempt, policy, evidenceStore, now = new Date().toISOString() } = {}) {
  let profiles;
  try {
    profiles = requiredProfilesForRisk(policy, attempt.projectId, attempt.riskClass);
  } catch (error) {
    return Object.freeze({ ok: false, reasonCode: typeof error?.code === 'string' ? error.code : 'unsupported-risk-class' });
  }
  const requiredValidationProfiles = [];
  const profileContracts = {};
  for (const profile of profiles) {
    let contractSha;
    try {
      contractSha = validationProfileContractSha256(policy, attempt.projectId, profile);
    } catch {
      return Object.freeze({ ok: false, reasonCode: 'validation-evidence-missing' });
    }
    const evidence = evidenceStore?.findFreshSucceeded?.({
      projectId: attempt.projectId,
      repository: attempt.repository,
      profile,
      profileContractSha256: contractSha,
      expectedSha: attempt.expectedHeadSha,
      now,
    });
    if (!evidence?.validationId) return Object.freeze({ ok: false, reasonCode: 'validation-evidence-missing' });
    requiredValidationProfiles.push(Object.freeze({ profile, validationId: evidence.validationId }));
    profileContracts[profile] = contractSha;
  }
  if (requiredValidationProfiles.length === 0) return Object.freeze({ ok: false, reasonCode: 'validation-evidence-missing' });
  return Object.freeze({
    ok: true,
    requiredValidationProfiles: Object.freeze(requiredValidationProfiles),
    profileContracts: Object.freeze(profileContracts),
  });
}

/**
 * Serial production control-loop step: drains durable validated implementation
 * attempts, publishes each through the merged PR.CONTRACT.1 surface exactly
 * once per transaction identity, observes PR settlement and releases the
 * implementation worker while retaining transaction/ownership evidence.
 *
 * Attempts are processed one at a time and generically across configured
 * repositories. This function introduces no merge, approval, issue-closure,
 * label, branch-cleanup or deployment authority.
 */
export async function runPrControllerSchedulerCycle({
  attemptStore, controllerStore, transactionStore, evidenceStore, registry, policy,
  client, authorityCheck, collectSettlement = collectGitHubCheckSnapshot,
  limit = 10, now = new Date().toISOString(),
} = {}) {
  if (!attemptStore || typeof attemptStore.listSchedulableAttempts !== 'function') throw new Error('pr controller attempt store is required');
  if (!registry?.projectsById) throw new Error('validated project registry is required');
  if (!policy?.projectsById) throw new Error('local executor policy is required');
  const outcomes = [];
  for (const attempt of attemptStore.listSchedulableAttempts({ limit })) {
    const project = projectFromRegistryById(registry, attempt.projectId);
    if (!project || String(project.githubRepo).toLowerCase() !== String(attempt.repository).toLowerCase()) {
      const finished = attemptStore.finishAttempt(attempt.attemptId, {
        state: 'attention', workerState: 'released', reasonCode: 'repository-mismatch', now,
      });
      outcomes.push(Object.freeze({ attemptId: attempt.attemptId, status: 'attention', reasonCode: finished.reasonCode }));
      continue;
    }
    const validation = resolveAttemptValidation({ attempt, policy, evidenceStore, now });
    if (!validation.ok) {
      attemptStore.finishAttempt(attempt.attemptId, {
        state: 'attention', workerState: 'released', reasonCode: validation.reasonCode, now,
      });
      outcomes.push(Object.freeze({ attemptId: attempt.attemptId, status: 'attention', reasonCode: validation.reasonCode }));
      continue;
    }
    let request;
    try {
      request = normalizePrPublicationRequest({
        projectId: attempt.projectId, repository: attempt.repository, issueNumber: attempt.issueNumber,
        sourceBranch: attempt.sourceBranch, targetBranch: attempt.targetBranch, expectedHeadSha: attempt.expectedHeadSha,
        managerRevision: attempt.managerRevision, managerFingerprint: attempt.managerFingerprint,
        executorJobId: attempt.executorJobId, implementationAttemptId: attempt.attemptId, requestId: attempt.attemptId,
        riskClass: attempt.riskClass, requiredValidationProfiles: validation.requiredValidationProfiles,
        approvedScope: attempt.approvedScope, filesChanged: attempt.filesChanged, knownLimitations: attempt.knownLimitations,
      });
    } catch (error) {
      const reasonCode = error instanceof PrContractError ? error.code : 'invalid-request';
      attemptStore.finishAttempt(attempt.attemptId, { state: 'attention', workerState: 'released', reasonCode, now });
      outcomes.push(Object.freeze({ attemptId: attempt.attemptId, status: 'attention', reasonCode }));
      continue;
    }
    try {
      const result = await runPrControllerCycle({
        request, controllerStore, transactionStore, client, evidenceStore,
        profileContracts: validation.profileContracts, authorityCheck, collectSettlement, now,
      });
      const terminal = result.settlementStatus !== 'pending';
      attemptStore.finishAttempt(attempt.attemptId, {
        state: terminal ? 'settled' : 'published',
        workerState: 'released',
        transactionId: result.transactionId,
        reasonCode: result.reasonCode,
        now,
      });
      outcomes.push(Object.freeze({
        attemptId: attempt.attemptId, status: terminal ? 'settled' : 'monitoring',
        transactionId: result.transactionId, prNumber: result.prNumber, url: result.url,
        settlementStatus: result.settlementStatus, reasonCode: result.reasonCode, replayed: result.replayed === true,
      }));
    } catch (error) {
      const reasonCode = error instanceof PrContractError ? error.code : 'pr-controller-publication-failed';
      attemptStore.finishAttempt(attempt.attemptId, {
        state: 'attention', workerState: 'released', transactionId: request.transactionId, reasonCode, now,
      });
      outcomes.push(Object.freeze({ attemptId: attempt.attemptId, status: 'attention', transactionId: request.transactionId, reasonCode }));
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    observedAt: now,
    inspected: outcomes.length,
    published: outcomes.filter((x) => x.status === 'settled' || x.status === 'monitoring').length,
    attention: outcomes.filter((x) => x.status === 'attention').length,
    outcomes: Object.freeze(outcomes),
  });
}
