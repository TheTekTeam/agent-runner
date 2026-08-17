import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const CANDIDATE_PROFILE_CIRCUIT_DOMAIN = 'candidate_profile';
export const CANDIDATE_PROFILE_EXTERNAL_FAILURE_SCOPE = 'machine_profile';
export const CANDIDATE_PROFILE_CIRCUIT_POLICY_REVISION = 'candidate-profile-cost-circuit/v1';

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function finitePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function canonicalNumber(value) {
  const parsed = finitePositiveNumber(value);
  return parsed == null ? null : String(parsed);
}

function requireText(value, field) {
  const normalized = text(value);
  if (!normalized) throw new Error(`${field} is required for candidate cost fingerprinting`);
  return normalized;
}

function requireSha256(value, field) {
  const normalized = requireText(value, field);
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${field} must be sha256:<64 lowercase hex>`);
  }
  return normalized;
}

export function candidateBudgetIdentity({ managerMaxBudgetUsd = null, profileMaxBudgetUsd = null } = {}) {
  if (managerMaxBudgetUsd?.present === true) {
    const validValue = managerMaxBudgetUsd.valid === true
      ? canonicalNumber(managerMaxBudgetUsd.value)
      : null;
    if (validValue != null) return `manager-valid:${validValue}`;
    return `manager-invalid:sha256:${sha256(managerMaxBudgetUsd.raw ?? '')}`;
  }

  const resolved = canonicalNumber(profileMaxBudgetUsd);
  if (resolved != null) return `profile-resolved:${resolved}`;
  if (profileMaxBudgetUsd !== undefined && profileMaxBudgetUsd !== null && String(profileMaxBudgetUsd) !== '') {
    return `profile-invalid:sha256:${sha256(profileMaxBudgetUsd)}`;
  }
  return 'absent';
}

export function candidateEffectiveCostFingerprintMaterial({
  machineConfigurationFingerprint,
  managerAuthority = {},
  profile = {},
  costAdmission = {},
  managerMaxBudgetUsd = null,
} = {}) {
  const machineFingerprint = requireSha256(machineConfigurationFingerprint, 'machineConfigurationFingerprint');
  const revision = requireText(managerAuthority.revision, 'managerAuthority.revision');
  const authorityFingerprint = requireSha256(managerAuthority.fingerprint, 'managerAuthority.fingerprint');
  const packetDigest = requireSha256(managerAuthority.packetDigest, 'managerAuthority.packetDigest');
  const authorityKey = requireText(managerAuthority.authorityKey, 'managerAuthority.authorityKey');
  const expectedAuthorityKey = `manager-preflight:${revision}:${authorityFingerprint}`;
  if (authorityKey !== expectedAuthorityKey) {
    throw new Error('managerAuthority.authorityKey does not match revision/fingerprint');
  }

  const resolvedProfile = requireText(profile.profile, 'profile.profile');
  const resolvedModel = requireText(profile.model, 'profile.model');
  const resolvedEffort = requireText(profile.effort, 'profile.effort');
  const budgetIdentity = candidateBudgetIdentity({
    managerMaxBudgetUsd,
    profileMaxBudgetUsd: profile.maxBudgetUsd,
  });
  if (budgetIdentity === 'absent') {
    throw new Error('resolved candidate budget identity is required');
  }

  const machineMaxBudgetUsd = canonicalNumber(costAdmission?.policy?.maxBudgetUsd);
  if (machineMaxBudgetUsd == null) {
    throw new Error('costAdmission.policy.maxBudgetUsd must be a positive finite number');
  }
  if (typeof costAdmission?.policy?.opusAllowed !== 'boolean') {
    throw new Error('costAdmission.policy.opusAllowed must be boolean');
  }
  if (typeof costAdmission?.policy?.highEffortAllowed !== 'boolean') {
    throw new Error('costAdmission.policy.highEffortAllowed must be boolean');
  }

  return {
    schemaVersion: CANDIDATE_PROFILE_CIRCUIT_POLICY_REVISION,
    machineConfigurationFingerprint: machineFingerprint,
    managerAuthority: {
      authorityKey,
      revision,
      fingerprint: authorityFingerprint,
      packetDigest,
    },
    resolvedProfile: {
      profile: resolvedProfile,
      model: resolvedModel,
      effort: resolvedEffort,
      budgetIdentity,
    },
    machineCostPolicy: {
      maxBudgetUsd: machineMaxBudgetUsd,
      opusAllowed: costAdmission.policy.opusAllowed,
      highEffortAllowed: costAdmission.policy.highEffortAllowed,
    },
  };
}

export function candidateEffectiveCostFingerprint(input = {}) {
  const material = candidateEffectiveCostFingerprintMaterial(input);
  return `sha256:${sha256(JSON.stringify(material))}`;
}

function requireFingerprint(value) {
  const normalized = text(value);
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized || '')) {
    throw new Error('candidate effective fingerprint must be sha256:<64 lowercase hex>');
  }
  return normalized;
}

function requireReason(value) {
  const normalized = text(value);
  if (!normalized || normalized.length > 160 || !/^[a-z0-9][a-z0-9._:-]*$/.test(normalized)) {
    throw new Error('candidate circuit reason must be a bounded reason code');
  }
  return normalized;
}

export class CandidateProfileCircuitBreaker {
  constructor(dbPath, { now = () => new Date().toISOString() } = {}) {
    this.dbPath = dbPath;
    this.now = now;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS candidate_profile_circuit (
        domain TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        effective_fingerprint TEXT NOT NULL,
        tripped_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL,
        notification_emitted INTEGER NOT NULL DEFAULT 0,
        CHECK(domain = 'candidate_profile')
      );
    `);
  }

  close() {
    this.db.close();
  }

  check({ effectiveFingerprint, reason } = {}) {
    const fingerprint = requireFingerprint(effectiveFingerprint);
    const reasonCode = requireReason(reason);
    const row = this.db.prepare('SELECT * FROM candidate_profile_circuit WHERE domain = ?')
      .get(CANDIDATE_PROFILE_CIRCUIT_DOMAIN);
    if (!row) return { blocked: false, stale: false };

    if (row.effective_fingerprint !== fingerprint || row.reason !== reasonCode) {
      return {
        blocked: false,
        stale: true,
        externalFailureScope: CANDIDATE_PROFILE_EXTERNAL_FAILURE_SCOPE,
        currentFingerprint: row.effective_fingerprint,
        currentReason: row.reason,
      };
    }

    return {
      blocked: true,
      stale: false,
      domain: CANDIDATE_PROFILE_CIRCUIT_DOMAIN,
      externalFailureScope: CANDIDATE_PROFILE_EXTERNAL_FAILURE_SCOPE,
      reason: row.reason,
      effectiveFingerprint: row.effective_fingerprint,
      occurrenceCount: row.occurrence_count,
      trippedAt: row.tripped_at,
      notificationEmitted: Boolean(row.notification_emitted),
      safeNextAction: 'If manager intent/profile/budget changes, issue a fresh superseding immutable manager authority; do not edit the existing packet. If machine policy must change, require a separately authorised machine-local policy action. Never raise budget, enable Opus/xhigh, or enable paid fallback automatically.',
    };
  }

  record({ effectiveFingerprint, reason, occurredAt = this.now() } = {}) {
    const fingerprint = requireFingerprint(effectiveFingerprint);
    const reasonCode = requireReason(reason);
    const existing = this.db.prepare('SELECT * FROM candidate_profile_circuit WHERE domain = ?')
      .get(CANDIDATE_PROFILE_CIRCUIT_DOMAIN);
    const sameIncident = existing
      && existing.effective_fingerprint === fingerprint
      && existing.reason === reasonCode;
    const occurrenceCount = sameIncident ? existing.occurrence_count + 1 : 1;
    const trippedAt = sameIncident ? existing.tripped_at : occurredAt;

    this.db.prepare(`INSERT INTO candidate_profile_circuit
      (domain, reason, effective_fingerprint, tripped_at, updated_at, occurrence_count, notification_emitted)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        reason = excluded.reason,
        effective_fingerprint = excluded.effective_fingerprint,
        tripped_at = excluded.tripped_at,
        updated_at = excluded.updated_at,
        occurrence_count = excluded.occurrence_count,
        notification_emitted = excluded.notification_emitted`)
      .run(
        CANDIDATE_PROFILE_CIRCUIT_DOMAIN,
        reasonCode,
        fingerprint,
        trippedAt,
        occurredAt,
        occurrenceCount,
        sameIncident ? existing.notification_emitted : 0,
      );

    return {
      tripped: true,
      newlyTripped: !sameIncident,
      domain: CANDIDATE_PROFILE_CIRCUIT_DOMAIN,
      externalFailureScope: CANDIDATE_PROFILE_EXTERNAL_FAILURE_SCOPE,
      reason: reasonCode,
      effectiveFingerprint: fingerprint,
      occurrenceCount,
    };
  }

  markNotificationEmitted() {
    return this.db.prepare(`UPDATE candidate_profile_circuit
      SET notification_emitted = 1
      WHERE domain = ? AND notification_emitted = 0`)
      .run(CANDIDATE_PROFILE_CIRCUIT_DOMAIN).changes === 1;
  }
}

export function candidateProfileCircuitPausePayload(result = {}) {
  return {
    circuitPaused: true,
    circuitDomain: CANDIDATE_PROFILE_CIRCUIT_DOMAIN,
    failureScope: CANDIDATE_PROFILE_EXTERNAL_FAILURE_SCOPE,
    reason: result.reason || null,
    safeNextAction: result.safeNextAction || 'Issue fresh immutable manager authority or separately authorise a machine-local policy change; never edit an existing packet or raise cost controls automatically.',
    candidateEffectiveFingerprint: result.effectiveFingerprint || null,
    occurrenceCount: result.occurrenceCount || 0,
    selectedIssue: null,
    attemptCreated: false,
    childLaunched: false,
    issueMutation: false,
    systemdOutcome: 'handled',
  };
}
