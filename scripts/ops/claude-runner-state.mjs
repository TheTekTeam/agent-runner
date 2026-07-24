import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  commentRevision,
  deserializeCommentIdentity,
  normalizeCommentIdentity,
  sameCommentIdentity,
  serializeCommentIdentity,
} from './claude-runner-comment-identity.mjs';

export const RUNNER_STATE_SCHEMA_VERSION = 11;
export const DEFAULT_RUNNER_STATE_DB_NAME = 'runner-state.sqlite';

const TABLES = new Set([
  'runner_state_schema',
  'queue_events',
  'quota_history',
  'preflight_packets',
  'issue_selections',
  'claims',
  'run_results',
  'recovery_attempts',
  'recovery_revalidations',
  'attention_events',
  'runner_health_conditions',
  'routing_events',
]);

export const RUNNER_STATE_TABLES = Object.freeze([...TABLES]);

const HISTORY_TABLES = RUNNER_STATE_TABLES.filter((table) => table !== 'runner_state_schema');

export function defaultRunnerStateDbPath(outputDir = '.var/claude-runner') {
  return join(outputDir, DEFAULT_RUNNER_STATE_DB_NAME);
}

function isoNow() {
  return new Date().toISOString();
}

function json(payload) {
  return JSON.stringify(payload ?? null);
}

function asInteger(value) {
  return Number.isInteger(value) ? value : null;
}

function asBooleanInteger(value) {
  if (value === undefined || value === null) return null;
  return value ? 1 : 0;
}

function quotaPayload(quotaPreflight = {}) {
  return quotaPreflight.payload || quotaPreflight;
}

function quotaState(payload = {}) {
  return payload?.state && typeof payload.state === 'object' ? payload.state : payload;
}

function percentValue(payload, primary, fallback, quotaUsagePath) {
  const candidates = [payload, quotaState(payload)];
  for (const candidate of candidates) {
    const direct = candidate?.[primary];
    if (Number.isFinite(direct)) return direct;
    const fallbackValue = candidate?.[fallback];
    if (Number.isFinite(fallbackValue)) return fallbackValue;
    const normalized = candidate?.quotaUsage?.[quotaUsagePath]?.usedPercent;
    if (Number.isFinite(normalized)) return normalized;
  }
  return null;
}

function resetValue(payload) {
  const state = quotaState(payload);
  const reset = payload?.resetAt
    || state?.resetAt
    || state?.pausedUntil
    || payload?.quotaUsage?.session?.resetAt
    || payload?.quotaUsage?.week?.resetAt
    || state?.quotaUsage?.session?.resetAt
    || state?.quotaUsage?.week?.resetAt;
  if (reset instanceof Date) return reset.toISOString();
  return typeof reset === 'string' && reset ? reset : null;
}

function emptyTableCounts() {
  return Object.fromEntries(HISTORY_TABLES.map((table) => [table, 0]));
}

function emptyLatestRows() {
  return Object.fromEntries(HISTORY_TABLES.map((table) => [table, []]));
}

function serialiseError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
  };
}

function boundedLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) return 5;
  return Math.min(limit, 50);
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistedCommentIdentity(explicitIdentity, compatibilityRevision, context) {
  return normalizeCommentIdentity(explicitIdentity ?? compatibilityRevision, { context });
}

function falseDryRunRepairPayload(payload, { repairedAt, attemptId, attentionEventId }) {
  const repaired = { ...payload };
  for (const key of [
    'runnerArgs', 'stdout', 'stderr', 'childRunFailure', 'terminalOutcome', 'recoveryDecision',
    'recoveryTransition', 'attentionDedupeKey', 'failureRecovery', 'executionPhase',
    'worktreeIdentity', 'implementationEvidence', 'implementationPublication',
    'usageAccounting', 'awaitingPlanApproval', 'planPath',
  ]) delete repaired[key];
  repaired.claim = null;
  repaired.executionStatus = 'not_executed';
  repaired.exitCode = 0;
  repaired.historicalRepair = {
    code: 'OPS.AGENT.RUNNER.DRYRUN.FALSE.ATTENTION.1',
    issue: 725,
    repairedAt,
    removedAttemptId: attemptId,
    removedAttentionEventId: attentionEventId,
  };
  return repaired;
}

export class RunnerStateStore {
  constructor(dbPath, { now = isoNow } = {}) {
    if (!dbPath || typeof dbPath !== 'string') throw new Error('runner state db path is required');
    this.dbPath = dbPath;
    this.now = now;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS runner_state_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS queue_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        repo TEXT NOT NULL,
        event_type TEXT NOT NULL,
        issue_number INTEGER,
        status_label TEXT,
        reason TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS quota_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        repo TEXT NOT NULL,
        status TEXT,
        blocked INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        session_usage_percent INTEGER,
        weekly_usage_percent INTEGER,
        reset_at TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS preflight_packets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        source_comment_id TEXT,
        source_comment_identity_json TEXT,
        fingerprint TEXT,
        stale INTEGER,
        action TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issue_selections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        repo TEXT NOT NULL,
        issue_number INTEGER,
        status_label TEXT,
        selection_mode TEXT,
        command_kind TEXT,
        source_comment_id TEXT,
        source_preflight_comment_id TEXT,
        source_comment_identity_json TEXT,
        source_preflight_comment_identity_json TEXT,
        dry_run INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        action TEXT NOT NULL,
        status_label TEXT,
        selection_mode TEXT,
        source_comment_id TEXT,
        source_preflight_comment_id TEXT,
        source_comment_identity_json TEXT,
        source_preflight_comment_identity_json TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        repo TEXT NOT NULL,
        issue_number INTEGER,
        mode TEXT NOT NULL,
        exit_code INTEGER,
        signal TEXT,
        log_path TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recovery_attempts (
        attempt_id TEXT PRIMARY KEY, repo TEXT NOT NULL, project TEXT, issue_number INTEGER NOT NULL,
        claim_id TEXT, claim_identity_json TEXT, preflight_revision TEXT, preflight_identity_json TEXT,
        manager_preflight_revision TEXT, manager_preflight_fingerprint TEXT, manager_preflight_body_digest TEXT, manager_authority_key TEXT,
        phase TEXT, agent TEXT, model TEXT, harness TEXT, started_at TEXT NOT NULL, finished_at TEXT,
        outcome TEXT, exit_code INTEGER, signal TEXT, recovery_eligible INTEGER NOT NULL DEFAULT 0,
        recovery_action TEXT, recovery_attempt_count INTEGER NOT NULL DEFAULT 0, retry_at TEXT,
        checkpoint_available INTEGER NOT NULL DEFAULT 0, session_available INTEGER NOT NULL DEFAULT 0,
        worktree_available INTEGER NOT NULL DEFAULT 0, branch_available INTEGER NOT NULL DEFAULT 0, pr_available INTEGER NOT NULL DEFAULT 0,
        attention_status TEXT, attention_dedupe_key TEXT, last_notification_at TEXT, resolution_state TEXT,
        process_id INTEGER, process_boot_id TEXT, process_start_ticks TEXT, systemd_invocation_id TEXT,
        stalled_passes INTEGER NOT NULL DEFAULT 0, attention_detected_at TEXT,
        progress_revision INTEGER NOT NULL DEFAULT 0, observed_progress_revision INTEGER NOT NULL DEFAULT 0,
        progress_token TEXT, last_progress_at TEXT, claimed_recovery_action TEXT,
        recovery_authorization_id TEXT, recovery_authorization_identity_json TEXT, recovery_lease_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS recovery_revalidations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL, stage TEXT NOT NULL,
        checked_at TEXT NOT NULL, action TEXT, allowed INTEGER NOT NULL, authorization_id TEXT,
        authorization_identity_json TEXT, recovery_lease_id TEXT, evidence_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attention_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        repo TEXT NOT NULL, project TEXT, issue_number INTEGER NOT NULL, attempt_id TEXT NOT NULL, reason TEXT NOT NULL,
        agent TEXT, started_at TEXT, finished_at TEXT, recovery_status TEXT NOT NULL, next_action TEXT NOT NULL,
        dashboard_reference TEXT, policy_revision TEXT NOT NULL, notification_count INTEGER NOT NULL DEFAULT 0,
        last_notification_at TEXT, resolved_at TEXT, event_json TEXT NOT NULL
      );

      -- Schema v8 (#698 round 5, finding 3): the current, resolvable
      -- runner-health state -- replaces inferring health from a latest-N
      -- queue_events window, which could keep showing a systemic-pause or
      -- degraded-inspection condition long after it genuinely cleared.
      -- Exactly one row per (repo, condition_type); resolved_at IS NULL
      -- means the condition is currently open. queue_events remains the
      -- historical audit trail; this table is the operator-facing truth.
      CREATE TABLE IF NOT EXISTS runner_health_conditions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        condition_type TEXT NOT NULL,
        reason TEXT,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        safe_next_action TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(repo, condition_type)
      );

      -- Schema v11 (#50): durable, deduplicated evidence for the serial
      -- multi-agent selector -- queued reassignment planning/application and
      -- the no-qualified-agent outcome. dedupe_key is UNIQUE so repeated
      -- reconciliation passes over the same unresolved condition insert
      -- exactly one row (and the caller can gate a duplicate GitHub comment
      -- on whether this insert actually happened). payload_json is bounded
      -- server-side by the caller -- this table never receives raw settings,
      -- credentials, paths, endpoints, prompts, or provider responses.
      CREATE TABLE IF NOT EXISTS routing_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        repo TEXT NOT NULL,
        issue_number INTEGER,
        event_type TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT,
        reason TEXT,
        settings_revision TEXT,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS routing_events_issue_idx ON routing_events(repo, issue_number, event_type, created_at);
      CREATE INDEX IF NOT EXISTS queue_events_issue_idx ON queue_events(issue_number, created_at);
      CREATE INDEX IF NOT EXISTS quota_history_created_idx ON quota_history(created_at);
      CREATE INDEX IF NOT EXISTS preflight_packets_issue_idx ON preflight_packets(issue_number, created_at);
      CREATE INDEX IF NOT EXISTS issue_selections_issue_idx ON issue_selections(issue_number, created_at);
      CREATE INDEX IF NOT EXISTS claims_issue_idx ON claims(issue_number, created_at);
      CREATE INDEX IF NOT EXISTS run_results_issue_idx ON run_results(issue_number, created_at);
      CREATE INDEX IF NOT EXISTS recovery_attempts_issue_idx ON recovery_attempts(repo, issue_number, started_at);
      CREATE INDEX IF NOT EXISTS recovery_revalidations_attempt_idx ON recovery_revalidations(attempt_id, checked_at);
      CREATE INDEX IF NOT EXISTS attention_events_issue_idx ON attention_events(repo, issue_number, updated_at);
      CREATE INDEX IF NOT EXISTS runner_health_conditions_repo_idx ON runner_health_conditions(repo, condition_type);
    `);
    const attemptColumns = new Set(this.db.prepare('PRAGMA table_info(recovery_attempts)').all().map((column) => column.name));
    const preflightColumns = new Set(this.db.prepare('PRAGMA table_info(preflight_packets)').all().map((column) => column.name));
    const selectionColumns = new Set(this.db.prepare('PRAGMA table_info(issue_selections)').all().map((column) => column.name));
    const claimColumns = new Set(this.db.prepare('PRAGMA table_info(claims)').all().map((column) => column.name));
    const revalidationColumns = new Set(this.db.prepare('PRAGMA table_info(recovery_revalidations)').all().map((column) => column.name));
    if (!preflightColumns.has('source_comment_identity_json')) this.db.exec('ALTER TABLE preflight_packets ADD COLUMN source_comment_identity_json TEXT');
    if (!selectionColumns.has('source_comment_identity_json')) this.db.exec('ALTER TABLE issue_selections ADD COLUMN source_comment_identity_json TEXT');
    if (!selectionColumns.has('source_preflight_comment_identity_json')) this.db.exec('ALTER TABLE issue_selections ADD COLUMN source_preflight_comment_identity_json TEXT');
    if (!claimColumns.has('source_comment_identity_json')) this.db.exec('ALTER TABLE claims ADD COLUMN source_comment_identity_json TEXT');
    if (!claimColumns.has('source_preflight_comment_identity_json')) this.db.exec('ALTER TABLE claims ADD COLUMN source_preflight_comment_identity_json TEXT');
    if (!attemptColumns.has('claim_identity_json')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN claim_identity_json TEXT');
    if (!attemptColumns.has('preflight_identity_json')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN preflight_identity_json TEXT');
    if (!attemptColumns.has('recovery_authorization_identity_json')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN recovery_authorization_identity_json TEXT');
    if (!revalidationColumns.has('authorization_identity_json')) this.db.exec('ALTER TABLE recovery_revalidations ADD COLUMN authorization_identity_json TEXT');
    if (!attemptColumns.has('process_id')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN process_id INTEGER');
    if (!attemptColumns.has('process_boot_id')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN process_boot_id TEXT');
    if (!attemptColumns.has('process_start_ticks')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN process_start_ticks TEXT');
    if (!attemptColumns.has('systemd_invocation_id')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN systemd_invocation_id TEXT');
    if (!attemptColumns.has('stalled_passes')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN stalled_passes INTEGER NOT NULL DEFAULT 0');
    if (!attemptColumns.has('attention_detected_at')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN attention_detected_at TEXT');
    if (!attemptColumns.has('progress_revision')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN progress_revision INTEGER NOT NULL DEFAULT 0');
    if (!attemptColumns.has('observed_progress_revision')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN observed_progress_revision INTEGER NOT NULL DEFAULT 0');
    if (!attemptColumns.has('progress_token')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN progress_token TEXT');
    if (!attemptColumns.has('last_progress_at')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN last_progress_at TEXT');
    if (!attemptColumns.has('claimed_recovery_action')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN claimed_recovery_action TEXT');
    if (!attemptColumns.has('recovery_authorization_id')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN recovery_authorization_id TEXT');
    if (!attemptColumns.has('recovery_lease_id')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN recovery_lease_id TEXT');
    if (!attemptColumns.has('preflight_revision')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN preflight_revision TEXT');
    // Schema v10 (#43): immutable manager packet authority is persisted independently of GitHub comment identity.
    if (!attemptColumns.has('manager_preflight_revision')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN manager_preflight_revision TEXT');
    if (!attemptColumns.has('manager_preflight_fingerprint')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN manager_preflight_fingerprint TEXT');
    if (!attemptColumns.has('manager_preflight_body_digest')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN manager_preflight_body_digest TEXT');
    if (!attemptColumns.has('manager_authority_key')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN manager_authority_key TEXT');
    // Schema v6: bounded, audited transition-mutation state machine (#698
    // finding 6 re-review). transition_mutation_count is the durable count
    // of GitHub label-mutation attempts for this attempt's successful-
    // recovery transition, so reconciliation can permit at most a bounded
    // retry instead of mutating on every timer tick.
    if (!attemptColumns.has('transition_mutation_count')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN transition_mutation_count INTEGER NOT NULL DEFAULT 0');
    // Schema v7: a dedicated, write-once column binding the restricted
    // recovery handle to this attempt's identity (#698 finding 8) — kept
    // out of `payload_json` deliberately, since that column is wholesale
    // replaced on every `recordRecoveryAttempt()` write and would silently
    // lose or drop the binding on any later write that doesn't recompute it.
    if (!attemptColumns.has('restricted_handle_digest')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN restricted_handle_digest TEXT');
    // Schema v8 (#698 round 5, finding 2): an authoritative bounded retry
    // schedule, distinct from `retry_at`/`recovery_attempt_count` (kept for
    // backward-compatible display) — a persisted deadline, consumed
    // attempt count, the exact cap that applied when the deadline was set,
    // and the outcome/reason driving the retry. Mutation-count headroom
    // alone (`transition_mutation_count` vs. `MAX_TRANSITION_MUTATION_ATTEMPTS`)
    // is not a retry schedule — transition rows now get a real backoff
    // deadline here too, not just a bare count cap.
    if (!attemptColumns.has('next_retry_at')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN next_retry_at TEXT');
    if (!attemptColumns.has('retry_attempt')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN retry_attempt INTEGER NOT NULL DEFAULT 0');
    if (!attemptColumns.has('retry_cap')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN retry_cap INTEGER');
    if (!attemptColumns.has('retry_reason')) this.db.exec('ALTER TABLE recovery_attempts ADD COLUMN retry_reason TEXT');
    this.db.prepare('INSERT OR IGNORE INTO runner_state_schema (version, applied_at) VALUES (?, ?)').run(RUNNER_STATE_SCHEMA_VERSION, this.now());
  }

  /**
   * Idempotent (issue #50): a `dedupe_key` collision is silently ignored,
   * and the return value's `inserted` flag tells the caller whether this
   * was a genuinely new event -- the intended gate for "post a GitHub
   * comment only the first time", so repeated reconciliation passes over an
   * unresolved condition never produce duplicate comments or duplicate
   * durable events.
   */
  recordRoutingEvent({ repo, issueNumber = null, eventType, fromAgentId = null, toAgentId = null, reason = null, settingsRevision = null, dedupeKey, payload = null, createdAt = this.now() }) {
    if (!dedupeKey) throw new Error('recordRoutingEvent requires a dedupeKey');
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO routing_events (created_at, repo, issue_number, event_type, from_agent_id, to_agent_id, reason, settings_revision, dedupe_key, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(createdAt, repo, asInteger(issueNumber), eventType, fromAgentId, toAgentId, reason, settingsRevision, dedupeKey, json(payload));
    return { inserted: result.changes > 0 };
  }

  hasRoutingEvent({ dedupeKey }) {
    return Boolean(this.db.prepare('SELECT 1 FROM routing_events WHERE dedupe_key = ?').get(dedupeKey));
  }

  recordQueueEvent({ repo, eventType, issueNumber = null, statusLabel = null, reason = null, payload = null, createdAt = this.now() }) {
    this.db.prepare(`
      INSERT INTO queue_events (created_at, repo, event_type, issue_number, status_label, reason, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(createdAt, repo, eventType, asInteger(issueNumber), statusLabel, reason, json(payload));
  }

  recordQuotaHistory({ repo, quotaPreflight, createdAt = this.now() }) {
    const payload = quotaPayload(quotaPreflight);
    const state = quotaState(payload);
    this.db.prepare(`
      INSERT INTO quota_history (created_at, repo, status, blocked, skipped, reason, session_usage_percent, weekly_usage_percent, reset_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      createdAt,
      repo,
      quotaPreflight?.status || payload?.status || state?.status || null,
      quotaPreflight?.blocked ? 1 : 0,
      quotaPreflight?.skipped ? 1 : 0,
      quotaPreflight?.reason || payload?.reason || state?.reason || null,
      percentValue(payload, 'sessionPercentUsed', 'percentUsed', 'session'),
      percentValue(payload, 'weeklyPercentUsed', 'weekPercentUsed', 'week'),
      resetValue(payload),
      json(quotaPreflight),
    );
  }

  recordPreflightPacket({ repo, issueNumber, sourceCommentId = null, sourceCommentIdentity = null, fingerprint = null, stale = null, action = 'generated', payload = null, createdAt = this.now() }) {
    const identity = persistedCommentIdentity(sourceCommentIdentity, sourceCommentId, 'preflight-packet-source');
    this.db.prepare(`
      INSERT INTO preflight_packets (created_at, repo, issue_number, source_comment_id, source_comment_identity_json, fingerprint, stale, action, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(createdAt, repo, issueNumber, commentRevision(identity), serializeCommentIdentity(identity), fingerprint, asBooleanInteger(stale), action, json(payload));
  }

  recordIssueSelection({ repo, issueNumber = null, statusLabel = null, selectionMode = null, commandKind = null, sourceCommentId = null, sourcePreflightCommentId = null, sourceCommentIdentity = null, sourcePreflightCommentIdentity = null, dryRun = true, payload = null, createdAt = this.now() }) {
    const commandIdentity = persistedCommentIdentity(sourceCommentIdentity, sourceCommentId, 'selection-command');
    const preflightIdentity = persistedCommentIdentity(sourcePreflightCommentIdentity, sourcePreflightCommentId, 'selection-preflight');
    this.db.prepare(`
      INSERT INTO issue_selections (created_at, repo, issue_number, status_label, selection_mode, command_kind, source_comment_id, source_preflight_comment_id, source_comment_identity_json, source_preflight_comment_identity_json, dry_run, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(createdAt, repo, asInteger(issueNumber), statusLabel, selectionMode, commandKind, commentRevision(commandIdentity), commentRevision(preflightIdentity), serializeCommentIdentity(commandIdentity), serializeCommentIdentity(preflightIdentity), dryRun ? 1 : 0, json(payload));
  }

  recordClaim({ repo, issueNumber, claim, createdAt = this.now() }) {
    const commandIdentity = persistedCommentIdentity(claim.sourceCommentIdentity, claim.sourceCommentId, 'claim-command');
    const preflightIdentity = persistedCommentIdentity(claim.sourcePreflightCommentIdentity, claim.sourcePreflightCommentId, 'claim-preflight');
    this.db.prepare(`
      INSERT INTO claims (created_at, repo, issue_number, action, status_label, selection_mode, source_comment_id, source_preflight_comment_id, source_comment_identity_json, source_preflight_comment_identity_json, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      createdAt,
      repo,
      issueNumber,
      claim.action,
      claim.statusLabel || null,
      claim.selectionMode || null,
      commentRevision(commandIdentity),
      commentRevision(preflightIdentity),
      serializeCommentIdentity(commandIdentity),
      serializeCommentIdentity(preflightIdentity),
      json(claim),
    );
  }

  recordRunResult({ repo, issueNumber = null, mode = 'cron', exitCode = null, signal = null, logPath = null, payload = null, startedAt = null, finishedAt = null, createdAt = this.now() }) {
    this.db.prepare(`
      INSERT INTO run_results (created_at, started_at, finished_at, repo, issue_number, mode, exit_code, signal, log_path, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(createdAt, startedAt, finishedAt, repo, asInteger(issueNumber), mode, exitCode, signal, logPath, json(payload));
  }

  recordRecoveryAttempt(attempt) {
    // claimed_recovery_action is intentionally absent from the ON CONFLICT
    // UPDATE SET below: it is the durable record of which action the
    // manager authorization actually approved at claim time and must never
    // be overwritten by a later terminal write (which sets recovery_action
    // to a closing value like 'none'/'attention_required'). Passing it here
    // only takes effect on the initial INSERT (normally via claimRecovery(),
    // or directly for tests/backfills that need a realistic claimed row).
    // restricted_handle_digest uses write-once COALESCE semantics instead:
    // it is unknown at claim/insert time (only known once the child captures
    // the handle) but must be settable on a later UPDATE while still never
    // being replaced or cleared by any subsequent write once set (#698
    // finding 8).
    const claimIdentity = persistedCommentIdentity(attempt.claimIdentity, attempt.claimId, 'recovery-attempt-claim');
    const preflightIdentity = persistedCommentIdentity(attempt.preflightIdentity, attempt.preflightRevision, 'recovery-attempt-preflight');
    this.db.prepare(`INSERT INTO recovery_attempts (attempt_id, repo, project, issue_number, claim_id, claim_identity_json, preflight_revision, preflight_identity_json, manager_preflight_revision, manager_preflight_fingerprint, manager_preflight_body_digest, manager_authority_key, phase, agent, model, harness, started_at, finished_at, outcome, exit_code, signal, recovery_eligible, recovery_action, recovery_attempt_count, retry_at, checkpoint_available, session_available, worktree_available, branch_available, pr_available, attention_status, attention_dedupe_key, last_notification_at, resolution_state, process_id, process_boot_id, process_start_ticks, systemd_invocation_id, stalled_passes, attention_detected_at, claimed_recovery_action, restricted_handle_digest, next_retry_at, retry_attempt, retry_cap, retry_reason, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO UPDATE SET claim_identity_json=COALESCE(recovery_attempts.claim_identity_json, excluded.claim_identity_json), preflight_revision=COALESCE(excluded.preflight_revision, recovery_attempts.preflight_revision), preflight_identity_json=COALESCE(recovery_attempts.preflight_identity_json, excluded.preflight_identity_json), manager_preflight_revision=COALESCE(recovery_attempts.manager_preflight_revision, excluded.manager_preflight_revision), manager_preflight_fingerprint=COALESCE(recovery_attempts.manager_preflight_fingerprint, excluded.manager_preflight_fingerprint), manager_preflight_body_digest=COALESCE(recovery_attempts.manager_preflight_body_digest, excluded.manager_preflight_body_digest), manager_authority_key=COALESCE(recovery_attempts.manager_authority_key, excluded.manager_authority_key), finished_at=excluded.finished_at, outcome=excluded.outcome, exit_code=excluded.exit_code, signal=excluded.signal, recovery_eligible=excluded.recovery_eligible, recovery_action=excluded.recovery_action, recovery_attempt_count=excluded.recovery_attempt_count, retry_at=excluded.retry_at, checkpoint_available=excluded.checkpoint_available, session_available=excluded.session_available, worktree_available=excluded.worktree_available, branch_available=excluded.branch_available, pr_available=excluded.pr_available, attention_status=excluded.attention_status, attention_dedupe_key=excluded.attention_dedupe_key, last_notification_at=excluded.last_notification_at, resolution_state=excluded.resolution_state, process_id=COALESCE(excluded.process_id, recovery_attempts.process_id), process_boot_id=COALESCE(excluded.process_boot_id, recovery_attempts.process_boot_id), process_start_ticks=COALESCE(excluded.process_start_ticks, recovery_attempts.process_start_ticks), systemd_invocation_id=COALESCE(excluded.systemd_invocation_id, recovery_attempts.systemd_invocation_id), attention_detected_at=COALESCE(excluded.attention_detected_at, recovery_attempts.attention_detected_at), restricted_handle_digest=COALESCE(recovery_attempts.restricted_handle_digest, excluded.restricted_handle_digest), next_retry_at=excluded.next_retry_at, retry_attempt=excluded.retry_attempt, retry_cap=excluded.retry_cap, retry_reason=excluded.retry_reason, payload_json=excluded.payload_json`).run(
      attempt.attemptId, attempt.repo, attempt.project || null, attempt.issueNumber, commentRevision(claimIdentity), serializeCommentIdentity(claimIdentity), commentRevision(preflightIdentity), serializeCommentIdentity(preflightIdentity), attempt.managerPreflightRevision || null, attempt.managerPreflightFingerprint || null, attempt.managerPreflightBodyDigest || null, attempt.managerAuthorityKey || null, attempt.phase || null, attempt.agent || null, attempt.model || null, attempt.harness || null, attempt.startedAt, attempt.finishedAt || null, attempt.outcome || null, attempt.exitCode ?? null, attempt.signal || null, attempt.recoveryEligible ? 1 : 0, attempt.recoveryAction || null, attempt.recoveryAttemptCount || 0, attempt.retryAt || null, asBooleanInteger(attempt.checkpointAvailable) || 0, asBooleanInteger(attempt.sessionAvailable) || 0, asBooleanInteger(attempt.worktreeAvailable) || 0, asBooleanInteger(attempt.branchAvailable) || 0, asBooleanInteger(attempt.prAvailable) || 0, attempt.attentionStatus || null, attempt.attentionDedupeKey || null, attempt.lastNotificationAt || null, attempt.resolutionState || null, asInteger(attempt.processId), attempt.processBootId || null, attempt.processStartTicks == null ? null : String(attempt.processStartTicks), attempt.systemdInvocationId || null, attempt.stalledPasses || 0, attempt.attentionDetectedAt || null, attempt.claimedRecoveryAction || null, attempt.restrictedHandleDigest || null, attempt.nextRetryAt || null, attempt.retryAttempt || 0, attempt.retryCap == null ? null : asInteger(attempt.retryCap), attempt.retryReason || null, json(attempt.restrictedEvidence || null));
  }

  /**
   * Atomically increment and return the durable count of GitHub label-
   * mutation attempts for this attempt's successful-recovery transition.
   * The bounded transition state machine (#698 finding 6) uses this to
   * permit at most a defined number of mutation attempts instead of
   * retrying on every reconciliation pass. Also persists the authoritative
   * retry schedule (#698 round 5, finding 2) alongside the count — a bare
   * mutation-count cap with no real deadline is not a retry schedule, so
   * callers pass the policy-derived backoff deadline/cap/reason computed
   * from this same count.
   */
  incrementTransitionMutationCount(attemptId, { nextRetryAt = null, retryAttempt = null, retryCap = null, retryReason = null } = {}) {
    this.db.prepare(`UPDATE recovery_attempts SET transition_mutation_count = transition_mutation_count + 1,
      next_retry_at = COALESCE(?, next_retry_at), retry_attempt = COALESCE(?, retry_attempt),
      retry_cap = COALESCE(?, retry_cap), retry_reason = COALESCE(?, retry_reason)
      WHERE attempt_id = ?`).run(nextRetryAt, retryAttempt, retryCap, retryReason, attemptId);
    return this.db.prepare('SELECT transition_mutation_count FROM recovery_attempts WHERE attempt_id = ?').get(attemptId)?.transition_mutation_count ?? 0;
  }

  upsertAttentionEvent(event, { notifiedAt = null } = {}) {
    const existing = this.db.prepare('SELECT event_json, notification_count FROM attention_events WHERE dedupe_key = ?').get(event.dedupeKey);
    const materiallyChanged = existing ? existing.event_json !== json(event) : true;
    if (existing && !materiallyChanged && !notifiedAt) return { created: false, materiallyChanged: false };
    this.db.prepare(`INSERT INTO attention_events (dedupe_key, created_at, updated_at, repo, project, issue_number, attempt_id, reason, agent, started_at, finished_at, recovery_status, next_action, dashboard_reference, policy_revision, notification_count, last_notification_at, event_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET updated_at=excluded.updated_at, recovery_status=excluded.recovery_status, next_action=excluded.next_action, finished_at=excluded.finished_at, notification_count=attention_events.notification_count + excluded.notification_count, last_notification_at=COALESCE(excluded.last_notification_at, attention_events.last_notification_at), event_json=excluded.event_json`).run(
      event.dedupeKey, this.now(), this.now(), event.repository, event.project || null, event.issueNumber, event.attemptId, event.reason, event.agent || null, event.startedAt, event.finishedAt, event.recoveryStatus, event.nextAction, event.dashboardReference || null, event.policyRevision, notifiedAt ? 1 : 0, notifiedAt, json(event));
    return { created: !existing, materiallyChanged };
  }

  resolveAttentionForAttempt(attemptId, resolvedAt = this.now()) {
    return this.db.prepare('UPDATE attention_events SET resolved_at = ?, updated_at = ? WHERE attempt_id = ? AND resolved_at IS NULL').run(resolvedAt, resolvedAt, attemptId).changes;
  }

  completeRecoveryTransition(attemptId) {
    return this.db.prepare(`UPDATE recovery_attempts SET resolution_state = 'resolved', attention_status = 'none'
      WHERE attempt_id = ? AND outcome = 'completed'`).run(attemptId).changes === 1;
  }

  /**
   * The only path allowed to durably finish a successful recovery
   * transition once GitHub delivery of the resolved marker has already
   * succeeded. Verifies the attempt is still `attention_resolution_pending`,
   * marks it `resolved`, resolves its attention event, and records exactly
   * one `recovery-succeeded` queue event — all inside a single transaction,
   * so a crash between steps can never leave a duplicate queue event or a
   * `resolved` attempt with unresolved attention (#698 finding 4).
   * Idempotent: an attempt already `resolved` is a durable no-op, so a
   * repeated reconciliation pass over the same row never re-emits the
   * queue event.
   */
  completeRecoveryTransitionAtomic({ attemptId, repo, issueNumber = null, statusLabel = null, reason = 'completed', payload = null, resolvedAt = this.now() }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT resolution_state, outcome FROM recovery_attempts WHERE attempt_id = ?').get(attemptId);
      if (!row || row.outcome !== 'completed') {
        this.db.exec('ROLLBACK');
        return { completed: false, reason: 'attempt-not-completed' };
      }
      if (row.resolution_state === 'resolved') {
        this.db.exec('ROLLBACK');
        return { completed: true, alreadyResolved: true };
      }
      if (row.resolution_state !== 'attention_resolution_pending') {
        this.db.exec('ROLLBACK');
        return { completed: false, reason: 'unexpected-resolution-state' };
      }
      const update = this.db.prepare(`UPDATE recovery_attempts SET resolution_state = 'resolved', attention_status = 'none'
        WHERE attempt_id = ? AND outcome = 'completed' AND resolution_state = 'attention_resolution_pending'`).run(attemptId);
      if (update.changes !== 1) throw new Error('recovery attempt resolution write did not affect exactly one row');
      this.db.prepare('UPDATE attention_events SET resolved_at = ?, updated_at = ? WHERE attempt_id = ? AND resolved_at IS NULL').run(resolvedAt, resolvedAt, attemptId);
      this.db.prepare(`
        INSERT INTO queue_events (created_at, repo, event_type, issue_number, status_label, reason, payload_json)
        VALUES (?, ?, 'recovery-succeeded', ?, ?, ?, ?)
      `).run(resolvedAt, repo, asInteger(issueNumber), statusLabel, reason, json(payload));
      this.db.exec('COMMIT');
      return { completed: true, alreadyResolved: false };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the original write failure */ }
      throw error;
    }
  }

  recordRecoveryRevalidation({ attemptId, stage, checkedAt = this.now(), action = null, allowed = false, authorizationId = null, authorizationIdentity = null, recoveryLeaseId = null, evidence = null }) {
    const identity = persistedCommentIdentity(authorizationIdentity, authorizationId, 'recovery-revalidation-authorization');
    this.db.prepare(`INSERT INTO recovery_revalidations
      (attempt_id, stage, checked_at, action, allowed, authorization_id, authorization_identity_json, recovery_lease_id, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`) 
      .run(attemptId, stage, checkedAt, action, allowed ? 1 : 0, commentRevision(identity), serializeCommentIdentity(identity), recoveryLeaseId, json(evidence));
  }

  recoveryAttempt(attemptId) {
    return this.db.prepare('SELECT * FROM recovery_attempts WHERE attempt_id = ?').get(attemptId) || null;
  }

  claimRecovery(attemptId, expectedCount, retryAt = this.now(), processIdentity = {}, authority = {}) {
    const expectedClaimIdentity = persistedCommentIdentity(authority.expectedClaimIdentity, authority.expectedClaimId, 'recovery-claim-authority');
    const expectedPreflightIdentity = persistedCommentIdentity(authority.expectedPreflightIdentity, authority.expectedPreflightRevision, 'recovery-preflight-authority');
    const authorizationIdentity = persistedCommentIdentity(authority.authorizationIdentity, authority.authorizationId, 'recovery-authorization');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare(`SELECT claim_id, claim_identity_json, preflight_revision, preflight_identity_json
        FROM recovery_attempts WHERE attempt_id = ?`).get(attemptId);
      const currentClaimIdentity = deserializeCommentIdentity(current?.claim_identity_json || current?.claim_id, 'persisted-recovery-claim');
      const currentPreflightIdentity = deserializeCommentIdentity(current?.preflight_identity_json || current?.preflight_revision, 'persisted-recovery-preflight');
      if ((expectedClaimIdentity && !sameCommentIdentity(currentClaimIdentity, expectedClaimIdentity))
        || (expectedPreflightIdentity && !sameCommentIdentity(currentPreflightIdentity, expectedPreflightIdentity))) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const result = this.db.prepare(`UPDATE recovery_attempts SET recovery_action = 'recovery_running', recovery_attempt_count = recovery_attempt_count + 1,
        finished_at = NULL, outcome = NULL, process_id = ?, process_boot_id = ?, process_start_ticks = ?, systemd_invocation_id = ?,
        stalled_passes = 0, attention_detected_at = NULL, progress_revision = 0, observed_progress_revision = 0,
        progress_token = NULL, last_progress_at = NULL, attention_status = 'recovery_running',
        claimed_recovery_action = recovery_action, recovery_authorization_id = ?, recovery_authorization_identity_json = ?, recovery_lease_id = ?
        WHERE attempt_id = ? AND recovery_attempt_count = ? AND recovery_eligible = 1 AND resolution_state IS NOT 'resolved'
        AND (next_retry_at IS NULL OR next_retry_at <= ?) AND (? IS NULL OR recovery_action = ?)`)
        .run(
          asInteger(processIdentity.processId), processIdentity.processBootId || null,
          processIdentity.processStartTicks == null ? null : String(processIdentity.processStartTicks), processIdentity.systemdInvocationId || null,
          commentRevision(authorizationIdentity), serializeCommentIdentity(authorizationIdentity), authority.recoveryLeaseId || null,
          attemptId, expectedCount, retryAt,
          authority.expectedAction || null, authority.expectedAction || null,
        );
      this.db.exec('COMMIT');
      return result.changes === 1;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the original claim failure */ }
      throw error;
    }
  }

  activeRecoveryAttempts(repo = null) {
    return this.db.prepare(`SELECT * FROM recovery_attempts WHERE finished_at IS NULL AND outcome IS NULL AND (? IS NULL OR repo = ?) ORDER BY started_at`).all(repo, repo);
  }

  /**
   * Attempts whose successful child result was persisted (finished_at +
   * outcome = 'completed') but whose GitHub status transition never durably
   * completed — either the mutation itself failed, or the process crashed
   * between a successful GitHub mutation and local completion. The next
   * scheduler pass re-fetches GitHub for each row and converges safely
   * instead of blindly repeating the mutation.
   */
  pendingRecoveryTransitions(repo) {
    // operator_attention_required is deliberately excluded: bounded mutation
    // attempts are exhausted for that row, and it must not be auto-retried
    // — only a fresh manager decision (a new attempt row) re-arms it.
    return this.db.prepare(`SELECT * FROM recovery_attempts WHERE repo = ? AND outcome = 'completed'
      AND resolution_state IN ('transition_pending', 'transition_uncertain', 'attention_resolution_pending') ORDER BY finished_at`).all(repo);
  }

  // Keyed on `next_retry_at` — the authoritative retry-schedule field (#698
  // round 5, finding 2) — rather than the legacy `retry_at` display column.
  // Every write site sets both identically, so this is a safe swap: nothing
  // reads `retry_at` for scheduling decisions after this change.
  dueRecoveryAttempts(repo, at = this.now()) {
    return this.db.prepare(`SELECT * FROM recovery_attempts WHERE repo = ? AND recovery_eligible = 1
      AND recovery_action NOT IN ('recovery_running', 'none') AND resolution_state IS NOT 'resolved'
      AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY next_retry_at, started_at`).all(repo, at);
  }

  /**
   * Open (or refresh) a current runner-health condition (#698 round 5,
   * finding 3) -- e.g. 'systemic_pause', 'queue_inspection_degraded'. One
   * row per (repo, condition_type): a repeat occurrence while already open
   * refreshes reason/updated_at/safe_next_action/payload without resetting
   * opened_at (so an operator sees how long the condition has actually been
   * open, not just the latest tick); reopening a previously resolved
   * condition clears resolved_at and starts a fresh opened_at.
   */
  openHealthCondition({ repo, conditionType, reason = null, safeNextAction = null, payload = null, at = this.now() }) {
    this.db.prepare(`
      INSERT INTO runner_health_conditions (repo, condition_type, reason, opened_at, updated_at, resolved_at, safe_next_action, payload_json)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(repo, condition_type) DO UPDATE SET
        reason = excluded.reason,
        updated_at = excluded.updated_at,
        safe_next_action = excluded.safe_next_action,
        payload_json = excluded.payload_json,
        opened_at = CASE WHEN runner_health_conditions.resolved_at IS NOT NULL THEN excluded.opened_at ELSE runner_health_conditions.opened_at END,
        resolved_at = NULL
    `).run(repo, conditionType, reason, at, at, safeNextAction, json(payload));
  }

  /** Resolve a currently-open health condition; a no-op if already resolved or never opened. */
  resolveHealthCondition({ repo, conditionType, at = this.now() }) {
    const result = this.db.prepare(`UPDATE runner_health_conditions SET resolved_at = ?, updated_at = ?
      WHERE repo = ? AND condition_type = ? AND resolved_at IS NULL`).run(at, at, repo, conditionType);
    return result.changes === 1;
  }

  /** Current (unresolved) health conditions -- the operator-facing truth, not a latest-N inference. `repo = null` returns all repos, matching activeRecoveryAttempts()'s convention. */
  currentHealthConditions(repo = null) {
    return this.db.prepare('SELECT * FROM runner_health_conditions WHERE (? IS NULL OR repo = ?) AND resolved_at IS NULL ORDER BY opened_at').all(repo, repo);
  }

  /**
   * Find rows created by the exact #725 selected-dry-run defect. A broad
   * `unknown_failure` match is deliberately insufficient: every candidate
   * must be bound to one dry-run result, one attempt, one unnotified
   * attention event, and the same issue/timestamps/dedupe identity. Anything
   * malformed or only partially matching is reported as ambiguous.
   */
  inspectFalseDryRunAttentionRepair() {
    const runRows = this.db.prepare(`SELECT * FROM run_results
      WHERE mode = 'issue-run' AND exit_code IN (0, 1) ORDER BY id`).all();
    const eligible = [];
    const ambiguous = [];

    for (const run of runRows) {
      const payload = parseJsonObject(run.payload_json);
      const rawLooksRelevant = /"dryRun"\s*:\s*true/.test(run.payload_json)
        && (/"terminalOutcome"\s*:\s*"unknown_failure"/.test(run.payload_json)
          || /"attentionDedupeKey"\s*:\s*"[^"]+"/.test(run.payload_json));
      const looksRelevant = rawLooksRelevant || (payload?.dryRun === true
        && (payload?.terminalOutcome === 'unknown_failure' || payload?.attentionDedupeKey != null));
      if (!looksRelevant) continue;

      const skip = (reason) => ambiguous.push({ runResultId: run.id, reason });
      if (!payload) { skip('malformed-run-result-payload'); continue; }
      if (!Number.isInteger(run.issue_number) || !run.started_at || !run.finished_at) { skip('missing-run-identity'); continue; }
      // The preserved #725 incident has two distinct exit layers: the
      // inspected child/process exited 0 in the payload, while the enclosing
      // scheduler persisted exit 1 after its own false recovery
      // classification. Some earlier reproductions persisted outer exit 0.
      // Accept only those two scheduler encodings while still requiring the
      // durable child/process evidence to prove a clean, non-executing run.
      if (![0, 1].includes(run.exit_code) || run.signal !== null
        || payload.dryRun !== true || payload.exitCode !== 0 || payload.signal !== null || payload.claim !== null
        || payload.childRunFailure !== null || payload.failureRecovery !== null) {
        skip('run-result-does-not-prove-read-only-dry-run'); continue;
      }
      if (payload.selectedIssue !== run.issue_number || payload.startedAt !== run.started_at || payload.finishedAt !== run.finished_at) {
        skip('issue-or-attempt-time-mismatch'); continue;
      }
      if (payload.terminalOutcome !== 'unknown_failure'
        || payload.recoveryDecision?.action !== 'attention_required'
        || payload.recoveryDecision?.status !== 'forbidden'
        || payload.recoveryDecision?.reason !== 'unknown_failure'
        || payload.recoveryDecision?.eligible !== false
        || typeof payload.attentionDedupeKey !== 'string' || !payload.attentionDedupeKey) {
        skip('failure-evidence-mismatch'); continue;
      }
      if (!Array.isArray(payload.runnerArgs) || payload.runnerArgs.includes('--execute')) {
        skip('child-execute-flag-present'); continue;
      }
      if (payload.worktreeIdentity != null || payload.implementationEvidence != null || payload.implementationPublication != null) {
        skip('implementation-evidence-present'); continue;
      }

      const attemptId = `${run.repo}#${run.issue_number}:${run.started_at}`;
      const attempts = this.db.prepare('SELECT * FROM recovery_attempts WHERE attempt_id = ?').all(attemptId);
      if (attempts.length !== 1) { skip('attempt-identity-not-unique'); continue; }
      const attempt = attempts[0];
      if (attempt.repo !== run.repo || attempt.issue_number !== run.issue_number
        || attempt.started_at !== run.started_at || attempt.finished_at !== run.finished_at
        || attempt.outcome !== 'unknown_failure' || attempt.exit_code !== 0 || attempt.signal !== null
        || attempt.recovery_eligible !== 0 || attempt.recovery_action !== 'attention_required'
        || attempt.recovery_attempt_count !== 0 || attempt.retry_at !== null || attempt.next_retry_at !== null
        || attempt.retry_attempt !== 0 || attempt.attention_status !== 'attention_required'
        || attempt.attention_dedupe_key !== payload.attentionDedupeKey || attempt.resolution_state !== 'unresolved'
        || attempt.checkpoint_available !== 0 || attempt.session_available !== 0
        || attempt.worktree_available !== 0 || attempt.branch_available !== 0 || attempt.pr_available !== 0
        || attempt.last_notification_at !== null || attempt.claimed_recovery_action !== null
        || attempt.recovery_authorization_id !== null || attempt.recovery_lease_id !== null
        || attempt.transition_mutation_count !== 0) {
        skip('recovery-attempt-evidence-mismatch'); continue;
      }

      const attentionRows = this.db.prepare('SELECT * FROM attention_events WHERE dedupe_key = ?').all(payload.attentionDedupeKey);
      if (attentionRows.length !== 1) { skip('attention-identity-not-unique'); continue; }
      const attention = attentionRows[0];
      if (attention.repo !== run.repo || attention.issue_number !== run.issue_number || attention.attempt_id !== attemptId
        || attention.reason !== 'unknown_failure' || attention.started_at !== run.started_at || attention.finished_at !== run.finished_at
        || attention.recovery_status !== 'forbidden' || attention.notification_count !== 0
        || attention.last_notification_at !== null || attention.resolved_at !== null) {
        skip('attention-evidence-mismatch'); continue;
      }

      const duplicateResults = this.db.prepare(`SELECT COUNT(*) AS count FROM run_results
        WHERE repo = ? AND issue_number = ? AND started_at = ?`).get(run.repo, run.issue_number, run.started_at).count;
      const claimCount = this.db.prepare(`SELECT COUNT(*) AS count FROM claims
        WHERE repo = ? AND issue_number = ? AND created_at >= ? AND created_at <= ?`)
        .get(run.repo, run.issue_number, run.started_at, run.created_at).count;
      const failureQueueCount = this.db.prepare(`SELECT COUNT(*) AS count FROM queue_events
        WHERE repo = ? AND issue_number = ? AND created_at >= ? AND created_at <= ?
          AND event_type IN ('quarantine', 'approval-wait', 'pause')`)
        .get(run.repo, run.issue_number, run.started_at, run.created_at).count;
      const revalidationCount = this.db.prepare('SELECT COUNT(*) AS count FROM recovery_revalidations WHERE attempt_id = ?').get(attemptId).count;
      // Health conditions are repository-wide rather than attempt-keyed. An
      // open condition therefore cannot be proven to belong to this exact
      // false dry-run, and deleting or resolving it here could hide a real
      // systemic/inspection failure. Fail closed until an operator resolves
      // that condition independently; a repair must never leave current
      // health ambiguous or guess at ownership from timestamps/payload text.
      const unresolvedHealthConditionCount = this.db.prepare(`SELECT COUNT(*) AS count FROM runner_health_conditions
        WHERE repo = ? AND resolved_at IS NULL`).get(run.repo).count;
      const matchingSelections = this.db.prepare(`SELECT * FROM issue_selections
        WHERE repo = ? AND issue_number = ? AND dry_run = 1 AND created_at <= ? ORDER BY id DESC`)
        .all(run.repo, run.issue_number, run.created_at)
        .filter((selection) => Math.abs(Date.parse(run.started_at) - Date.parse(selection.created_at)) <= 5 * 60_000);
      const selection = matchingSelections[0];
      const selectionPreflightIdentity = deserializeCommentIdentity(
        selection?.source_preflight_comment_identity_json || selection?.source_preflight_comment_id,
        'dry-run-repair-selection-preflight',
      );
      const payloadPreflightIdentity = normalizeCommentIdentity(
        payload.sourcePreflightCommentIdentity || payload.sourcePreflightCommentId,
        { context: 'dry-run-repair-result-preflight' },
      );
      const preflightIdentityMatches = selectionPreflightIdentity && payloadPreflightIdentity
        ? sameCommentIdentity(selectionPreflightIdentity, payloadPreflightIdentity)
        : selectionPreflightIdentity === null && payloadPreflightIdentity === null;
      const selectionIdentityMatches = matchingSelections.length === 1
        && selection?.selection_mode === payload.selectionMode
        && preflightIdentityMatches;
      if (unresolvedHealthConditionCount !== 0) {
        skip('unresolved-runner-health-condition'); continue;
      }
      if (duplicateResults !== 1 || claimCount !== 0 || failureQueueCount !== 0 || revalidationCount !== 0 || !selectionIdentityMatches) {
        skip('conflicting-durable-history'); continue;
      }

      eligible.push({ run, payload, attempt, attention });
    }

    return { eligible, ambiguous };
  }

  /**
   * Report by default; delete the proven-false attempt/attention rows and
   * reclassify their source run result only under an explicit execute flag.
   * All writes share one SQLite transaction and are idempotent.
   */
  repairFalseDryRunAttention({ execute = false, repairedAt = this.now() } = {}) {
    const initial = this.inspectFalseDryRunAttentionRepair();
    const report = {
      mode: execute ? 'apply' : 'report-only',
      candidatesFound: initial.eligible.length + initial.ambiguous.length,
      candidatesEligible: initial.eligible.length,
      candidatesRepaired: 0,
      candidatesSkippedAmbiguous: initial.ambiguous.length,
      wouldRepair: {
        runResultIds: initial.eligible.map(({ run }) => run.id),
        attemptIds: initial.eligible.map(({ attempt }) => attempt.attempt_id),
        attentionEventIds: initial.eligible.map(({ attention }) => attention.id),
      },
      affected: { runResultIds: [], attemptIds: [], attentionEventIds: [] },
      skipped: initial.ambiguous,
    };
    if (!execute || initial.eligible.length === 0) return report;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.inspectFalseDryRunAttentionRepair();
      const expectedIds = initial.eligible.map(({ run }) => run.id);
      const currentIds = current.eligible.map(({ run }) => run.id);
      if (JSON.stringify(currentIds) !== JSON.stringify(expectedIds)) throw new Error('repair candidates changed before transaction');
      for (const { run, payload, attempt, attention } of current.eligible) {
        const attentionDelete = this.db.prepare('DELETE FROM attention_events WHERE id = ? AND dedupe_key = ? AND attempt_id = ?')
          .run(attention.id, attention.dedupe_key, attempt.attempt_id);
        if (attentionDelete.changes !== 1) throw new Error(`attention repair write failed for id ${attention.id}`);
        const attemptDelete = this.db.prepare('DELETE FROM recovery_attempts WHERE attempt_id = ? AND outcome = ? AND attention_dedupe_key = ?')
          .run(attempt.attempt_id, 'unknown_failure', attention.dedupe_key);
        if (attemptDelete.changes !== 1) throw new Error(`attempt repair write failed for ${attempt.attempt_id}`);
        const repairedPayload = falseDryRunRepairPayload(payload, { repairedAt, attemptId: attempt.attempt_id, attentionEventId: attention.id });
        const resultUpdate = this.db.prepare(`UPDATE run_results
          SET mode = 'scheduler-dry-run', exit_code = 0, payload_json = ?
          WHERE id = ? AND mode = 'issue-run' AND exit_code = ? AND signal IS NULL`)
          .run(json(repairedPayload), run.id, run.exit_code);
        if (resultUpdate.changes !== 1) throw new Error(`run-result repair write failed for id ${run.id}`);
        report.affected.runResultIds.push(run.id);
        report.affected.attemptIds.push(attempt.attempt_id);
        report.affected.attentionEventIds.push(attention.id);
      }
      this.db.exec('COMMIT');
      report.candidatesRepaired = current.eligible.length;
      return report;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the original repair failure */ }
      throw error;
    }
  }

  recordRecoveryProgress(attemptId, token, progressedAt = this.now()) {
    if (token == null || token === '') return false;
    const result = this.db.prepare(`UPDATE recovery_attempts SET progress_token = ?, progress_revision = progress_revision + 1,
      last_progress_at = ? WHERE attempt_id = ? AND finished_at IS NULL AND (progress_token IS NULL OR progress_token <> ?)`)
      .run(String(token), progressedAt, attemptId, String(token));
    return result.changes === 1;
  }

  markStalledPass(attemptId, threshold = 2, detectedAt = this.now()) {
    this.db.prepare(`UPDATE recovery_attempts SET
      stalled_passes = CASE WHEN progress_revision <> observed_progress_revision THEN 0 ELSE stalled_passes + 1 END,
      attention_detected_at = CASE
        WHEN progress_revision <> observed_progress_revision THEN NULL
        WHEN stalled_passes + 1 >= ? THEN COALESCE(attention_detected_at, ?)
        ELSE attention_detected_at END,
      observed_progress_revision = progress_revision
      WHERE attempt_id = ? AND finished_at IS NULL`).run(threshold, detectedAt, attemptId);
    return this.db.prepare('SELECT * FROM recovery_attempts WHERE attempt_id = ?').get(attemptId);
  }

  assertWritable() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const latest = this.db.prepare('SELECT MAX(version) AS version FROM runner_state_schema').get()?.version;
      const result = this.db.prepare('UPDATE runner_state_schema SET applied_at = applied_at WHERE version = ?').run(latest);
      if (result.changes !== 1) throw new Error('runner state schema write probe did not update one row');
      this.db.exec('ROLLBACK');
      return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the original write failure */ }
      throw error;
    }
  }

  countRows(table) {
    if (!TABLES.has(table)) throw new Error(`Unsupported runner state table: ${table}`);
    return this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  }

  allRows(table) {
    if (!TABLES.has(table)) throw new Error(`Unsupported runner state table: ${table}`);
    const orderColumn = table === 'runner_state_schema' ? 'version' : table === 'recovery_attempts' ? 'started_at' : 'id';
    return this.db.prepare(`SELECT * FROM ${table} ORDER BY ${orderColumn}`).all();
  }

  latestRows(table, limit = 5) {
    if (!TABLES.has(table)) throw new Error(`Unsupported runner state table: ${table}`);
    const orderColumn = table === 'runner_state_schema' ? 'version' : table === 'recovery_attempts' ? 'started_at' : 'id';
    return this.db.prepare(`SELECT * FROM ${table} ORDER BY ${orderColumn} DESC LIMIT ?`).all(boundedLimit(limit));
  }

  close() {
    this.db.close();
  }
}

export function openRunnerStateStore(dbPath, options = {}) {
  return new RunnerStateStore(dbPath, options);
}

export function repairFalseDryRunAttention(dbPath, options = {}) {
  const store = openRunnerStateStore(dbPath, options);
  try {
    return store.repairFalseDryRunAttention(options);
  } finally {
    store.close();
  }
}

export function summarizeRunnerState(dbPath, { now = isoNow, historyLimit = 5, requireExisting = false } = {}) {
  if (!dbPath || typeof dbPath !== 'string') {
    return {
      ok: false,
      status: 'invalid-path',
      dbPath: dbPath ?? null,
      schemaVersion: null,
      generatedAt: now(),
      counts: emptyTableCounts(),
      latest: emptyLatestRows(),
      currentHealthConditions: [],
      error: { name: 'Error', message: 'runner state db path is required' },
    };
  }

  if (!existsSync(dbPath)) {
    return {
      ok: !requireExisting,
      status: 'missing',
      dbPath,
      schemaVersion: null,
      generatedAt: now(),
      counts: emptyTableCounts(),
      latest: emptyLatestRows(),
      currentHealthConditions: [],
      message: 'Runner state DB does not exist yet. Run the cron runner once, or pass --strict in validation to fail on this condition.',
    };
  }

  let store;
  try {
    store = openRunnerStateStore(dbPath, { now });
    const counts = Object.fromEntries(HISTORY_TABLES.map((table) => [table, store.countRows(table)]));
    const latest = Object.fromEntries(HISTORY_TABLES.map((table) => [table, store.latestRows(table, historyLimit)]));
    const schemaRows = store.allRows('runner_state_schema');
    const schemaVersion = Math.max(...schemaRows.map((row) => row.version));
    // #698 round 5, finding 3: current health is NOT part of `latest` --
    // `latest.runner_health_conditions` (via the generic latest-N path
    // above) shows recent conditions including resolved ones, useful as a
    // history view; `currentHealthConditions` is the operator-facing truth
    // (unresolved only, resolved conditions excluded regardless of recency).
    const currentHealthConditions = store.currentHealthConditions(null);

    return {
      ok: true,
      status: 'ok',
      dbPath,
      schemaVersion,
      generatedAt: now(),
      counts,
      latest,
      currentHealthConditions,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'error',
      dbPath,
      schemaVersion: null,
      generatedAt: now(),
      counts: emptyTableCounts(),
      latest: emptyLatestRows(),
      currentHealthConditions: [],
      error: serialiseError(error),
    };
  } finally {
    store?.close();
  }
}
