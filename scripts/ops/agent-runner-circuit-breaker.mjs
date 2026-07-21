#!/usr/bin/env node

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { configurationFingerprint, normalizeImplementationApprovers } from './agent-runner-admission.mjs';

export const CIRCUIT_WINDOW_MS = 15 * 60_000;

function isoNow() {
  return new Date().toISOString();
}

export function defaultCircuitDbPath(env = process.env) {
  if (env.AGENT_RUNNER_CIRCUIT_DB) return env.AGENT_RUNNER_CIRCUIT_DB;
  const stateDb = env.CLAUDE_RUNNER_STATE_DB || '.var/claude-runner/runner-state.sqlite';
  return `${stateDb}.circuit-breaker.sqlite`;
}

export function effectiveConfigurationFingerprint(env = process.env) {
  const { approvers } = normalizeImplementationApprovers(env.CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS);
  return configurationFingerprint({ env, approvers });
}

export class AdmissionCircuitBreaker {
  constructor(dbPath, { now = isoNow, windowMs = CIRCUIT_WINDOW_MS } = {}) {
    this.dbPath = dbPath;
    this.now = now;
    this.windowMs = windowMs;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS admission_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        scope TEXT NOT NULL,
        reason TEXT NOT NULL,
        configuration_fingerprint TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admission_circuit (
        scope TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        configuration_fingerprint TEXT NOT NULL,
        tripped_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL,
        notification_emitted INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  close() {
    this.db.close();
  }

  check({ configurationFingerprint }) {
    const rows = this.db.prepare('SELECT * FROM admission_circuit ORDER BY tripped_at').all();
    for (const row of rows) {
      if (row.scope === 'machine_profile' && row.configuration_fingerprint !== configurationFingerprint) {
        this.db.prepare('DELETE FROM admission_circuit WHERE scope = ?').run(row.scope);
        continue;
      }
      return {
        blocked: true,
        scope: row.scope,
        reason: row.reason,
        configurationFingerprint: row.configuration_fingerprint,
        occurrenceCount: row.occurrence_count,
        trippedAt: row.tripped_at,
        notificationEmitted: Boolean(row.notification_emitted),
        safeNextAction: row.scope === 'machine_profile'
          ? 'Change and verify the effective machine configuration before retrying candidate selection.'
          : 'Repair the systemic runner condition and clear it through a verified healthy pass.',
      };
    }
    return { blocked: false };
  }

  record({ scope, reason, configurationFingerprint, occurredAt = this.now() }) {
    if (!['machine_profile', 'systemic'].includes(scope)) {
      return { tripped: false, reason: 'scope-not-circuit-breaking' };
    }
    this.db.prepare(`INSERT INTO admission_failures
      (occurred_at, scope, reason, configuration_fingerprint) VALUES (?, ?, ?, ?)`)
      .run(occurredAt, scope, reason, configurationFingerprint);

    const cutoff = new Date(Date.parse(occurredAt) - this.windowMs).toISOString();
    const count = this.db.prepare(`SELECT COUNT(*) AS count FROM admission_failures
      WHERE scope = ? AND reason = ? AND configuration_fingerprint = ? AND occurred_at >= ?`)
      .get(scope, reason, configurationFingerprint, cutoff).count;
    const shouldTrip = scope === 'machine_profile' ? count >= 1 : count >= 2;
    if (!shouldTrip) return { tripped: false, occurrenceCount: count };

    const existing = this.db.prepare('SELECT * FROM admission_circuit WHERE scope = ?').get(scope);
    this.db.prepare(`INSERT INTO admission_circuit
      (scope, reason, configuration_fingerprint, tripped_at, updated_at, occurrence_count, notification_emitted)
      VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(scope) DO UPDATE SET
        reason = excluded.reason,
        configuration_fingerprint = excluded.configuration_fingerprint,
        updated_at = excluded.updated_at,
        occurrence_count = excluded.occurrence_count,
        notification_emitted = CASE
          WHEN admission_circuit.reason = excluded.reason
           AND admission_circuit.configuration_fingerprint = excluded.configuration_fingerprint
          THEN admission_circuit.notification_emitted ELSE 0 END`)
      .run(scope, reason, configurationFingerprint, existing?.tripped_at || occurredAt, occurredAt, count);
    return {
      tripped: true,
      occurrenceCount: count,
      newlyTripped: !existing || existing.reason !== reason || existing.configuration_fingerprint !== configurationFingerprint,
    };
  }

  markNotificationEmitted(scope) {
    return this.db.prepare('UPDATE admission_circuit SET notification_emitted = 1 WHERE scope = ? AND notification_emitted = 0')
      .run(scope).changes === 1;
  }
}

export function circuitPausePayload(result) {
  return {
    circuitPaused: true,
    failureScope: result.scope,
    reason: result.reason,
    safeNextAction: result.safeNextAction,
    configurationFingerprint: result.configurationFingerprint,
    occurrenceCount: result.occurrenceCount,
    selectedIssue: null,
    attemptCreated: false,
    childLaunched: false,
    issueMutation: false,
    systemdOutcome: 'handled',
  };
}

export function parseAdmissionPayload(text) {
  try {
    const value = JSON.parse(String(text || ''));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export function main(argv = process.argv.slice(2), env = process.env, logger = console) {
  const command = argv[0] || 'check';
  const breaker = new AdmissionCircuitBreaker(defaultCircuitDbPath(env));
  try {
    const fingerprint = effectiveConfigurationFingerprint(env);
    if (command === 'check') {
      const result = breaker.check({ configurationFingerprint: fingerprint });
      if (!result.blocked) return 0;
      logger.log(JSON.stringify(circuitPausePayload(result), null, 2));
      return 3;
    }
    if (command === 'record') {
      const payload = parseAdmissionPayload(env.AGENT_RUNNER_ADMISSION_RESULT);
      if (!payload?.failureScope || !payload?.reason) throw new Error('AGENT_RUNNER_ADMISSION_RESULT must contain failureScope and reason');
      const result = breaker.record({
        scope: payload.failureScope,
        reason: payload.reason,
        configurationFingerprint: payload.configurationFingerprint || fingerprint,
      });
      logger.log(JSON.stringify(result));
      return 0;
    }
    throw new Error(`unknown circuit-breaker command: ${command}`);
  } finally {
    breaker.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
