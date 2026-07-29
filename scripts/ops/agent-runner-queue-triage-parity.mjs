import { evidenceFingerprint, stableJson } from './agent-runner-queue-triage.mjs';

export const QUEUE_TRIAGE_PARITY_SCHEMA_VERSION = 1;
export const QUEUE_TRIAGE_PARITY_STATUSES = Object.freeze(['match', 'material_disagreement', 'incomplete']);
const FORBIDDEN_KEYS = new Set(['body', 'commentBody', 'rawPayload', 'providerOutput', 'prompt', 'secret', 'token']);

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }
function iso(value, name) { if (!nonEmpty(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${name} is invalid`); return new Date(value).toISOString(); }
function positiveInteger(value, name) { if (!Number.isInteger(value) || value < 1) throw new Error(`${name} is invalid`); return value; }
function assertNoForbidden(value, path = 'candidate') {
  if (Array.isArray(value)) { value.forEach((entry, index) => assertNoForbidden(entry, `${path}[${index}]`)); return; }
  if (!isObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${path}.${key} is forbidden`);
    assertNoForbidden(entry, `${path}.${key}`);
  }
}
function boundedArray(value, name, max) { if (!Array.isArray(value) || value.length > max) throw new Error(`${name} is invalid`); return value; }
function labelsFingerprint(item) {
  if (nonEmpty(item.labelsFingerprint) && item.labelsFingerprint.startsWith('sha256:')) return item.labelsFingerprint;
  if (Array.isArray(item.labels)) return evidenceFingerprint([...new Set(item.labels)].sort());
  throw new Error('inspected labels fingerprint is required');
}
function normalizeInspected(value) {
  return Object.freeze(boundedArray(value, 'candidate.inspected', 22).map((item, index) => {
    if (!isObject(item) || !['issue', 'pull_request'].includes(item.kind)) throw new Error(`candidate.inspected[${index}] is invalid`);
    return Object.freeze({
      kind: item.kind,
      number: positiveInteger(item.number, `candidate.inspected[${index}].number`),
      updatedAt: iso(item.updatedAt, `candidate.inspected[${index}].updatedAt`),
      labelsFingerprint: labelsFingerprint(item),
    });
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.number - b.number));
}
function normalizeActions(value) {
  return Object.freeze(boundedArray(value, 'candidate.actionPlans', 3).map((plan, index) => {
    if (!isObject(plan) || !['issue', 'pull_request'].includes(plan.kind) || !nonEmpty(plan.action)) {
      throw new Error(`candidate.actionPlans[${index}] is invalid`);
    }
    let labels = null;
    if (plan.intendedFullLabelSet != null) {
      const rawLabels = boundedArray(plan.intendedFullLabelSet, 'intendedFullLabelSet', 100);
      if (rawLabels.some((label) => !nonEmpty(label) || label.length > 255)) throw new Error('intendedFullLabelSet is invalid');
      labels = Object.freeze([...new Set(rawLabels)].sort());
    }
    return Object.freeze({
      kind: plan.kind,
      number: positiveInteger(plan.number, `candidate.actionPlans[${index}].number`),
      action: plan.action,
      intendedFullLabelSet: labels,
      evidenceFingerprint: nonEmpty(plan.evidenceFingerprint) ? plan.evidenceFingerprint : evidenceFingerprint(plan),
    });
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.number - b.number || a.action.localeCompare(b.action)));
}
function normalizeExceptions(value) {
  return Object.freeze(boundedArray(value, 'candidate.exceptions', 4).map((entry, index) => {
    if (!isObject(entry) || !['issue', 'pull_request'].includes(entry.kind) || !nonEmpty(entry.category) || !nonEmpty(entry.code)) {
      throw new Error(`candidate.exceptions[${index}] is invalid`);
    }
    return Object.freeze({
      kind: entry.kind,
      number: positiveInteger(entry.number, `candidate.exceptions[${index}].number`),
      category: entry.category,
      code: entry.code,
      fingerprint: nonEmpty(entry.fingerprint) ? entry.fingerprint : evidenceFingerprint(entry),
    });
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.number - b.number || a.category.localeCompare(b.category) || a.code.localeCompare(b.code)));
}

export function normalizeQueueTriageParityCandidate(input) {
  if (!isObject(input)) throw new Error('parity candidate must be an object');
  assertNoForbidden(input);
  if (input.schemaVersion !== QUEUE_TRIAGE_PARITY_SCHEMA_VERSION) throw new Error('parity candidate schemaVersion is unsupported');
  if (!nonEmpty(input.releaseId) || !nonEmpty(input.projectId) || !nonEmpty(input.repository) || !input.repository.includes('/')) {
    throw new Error('parity candidate identity is invalid');
  }
  if (!isObject(input.settlement) || !nonEmpty(input.settlement.releasePayloadFingerprint)
    || !nonEmpty(input.settlement.shaEvidenceFingerprint)) throw new Error('parity settlement identity is invalid');
  const candidate = {
    schemaVersion: QUEUE_TRIAGE_PARITY_SCHEMA_VERSION,
    complete: input.complete === true,
    releaseId: input.releaseId,
    projectId: input.projectId,
    repository: input.repository,
    settlement: Object.freeze({
      releasePayloadFingerprint: input.settlement.releasePayloadFingerprint,
      shaEvidenceFingerprint: input.settlement.shaEvidenceFingerprint,
      queryComplete: input.settlement.queryComplete === true,
    }),
    inspected: normalizeInspected(input.inspected ?? []),
    actionPlans: normalizeActions(input.actionPlans ?? []),
    exceptions: normalizeExceptions(input.exceptions ?? []),
  };
  const fingerprint = evidenceFingerprint(candidate);
  return Object.freeze({ ...candidate, fingerprint });
}

export function buildQueueTriageParityCandidate({ evidence, report } = {}) {
  if (!isObject(evidence) || !isObject(evidence.liveEvidence) || !isObject(evidence.liveEvidence.identity)) {
    throw new Error('live normalized evidence is required');
  }
  if (!isObject(report) || report.releaseId !== evidence.releaseId || report.project?.projectId !== evidence.project?.projectId
    || String(report.project?.repository ?? '').toLowerCase() !== String(evidence.project?.repository ?? '').toLowerCase()) {
    throw new Error('dry-run report identity does not match live evidence');
  }
  const identity = evidence.liveEvidence.identity;
  const inspected = [...(evidence.changedItems ?? []), ...(evidence.rotatingItems ?? [])].map((item) => ({
    kind: item.kind,
    number: item.number,
    updatedAt: item.updatedAt,
    labelsFingerprint: evidenceFingerprint([...(item.labels ?? [])].sort()),
  }));
  return normalizeQueueTriageParityCandidate({
    schemaVersion: QUEUE_TRIAGE_PARITY_SCHEMA_VERSION,
    complete: evidence.liveEvidence.queryComplete === true,
    releaseId: evidence.releaseId,
    projectId: evidence.project.projectId,
    repository: evidence.project.repository,
    settlement: {
      releasePayloadFingerprint: identity.releasePayloadFingerprint,
      shaEvidenceFingerprint: identity.shaEvidenceFingerprint,
      queryComplete: evidence.liveEvidence.queryComplete === true,
    },
    inspected,
    actionPlans: report.actionPlans ?? [],
    exceptions: report.exceptions ?? [],
  });
}

export function compareQueueTriageParity(agentInput, oversightInput, { comparedAt = new Date().toISOString() } = {}) {
  const agent = normalizeQueueTriageParityCandidate(agentInput);
  const oversight = normalizeQueueTriageParityCandidate(oversightInput);
  const mismatchFields = [];
  if (agent.releaseId !== oversight.releaseId) mismatchFields.push('release_identity');
  if (agent.projectId !== oversight.projectId || agent.repository.toLowerCase() !== oversight.repository.toLowerCase()) mismatchFields.push('project_identity');
  if (stableJson(agent.settlement) !== stableJson(oversight.settlement)) mismatchFields.push('settlement');
  if (stableJson(agent.inspected) !== stableJson(oversight.inspected)) mismatchFields.push('inspected');
  if (stableJson(agent.actionPlans) !== stableJson(oversight.actionPlans)) mismatchFields.push('action_plans');
  if (stableJson(agent.exceptions) !== stableJson(oversight.exceptions)) mismatchFields.push('exceptions');
  let status = 'match';
  if (!agent.complete || !oversight.complete || !agent.settlement.queryComplete || !oversight.settlement.queryComplete) status = 'incomplete';
  else if (mismatchFields.length > 0) status = 'material_disagreement';
  const stableResult = {
    schemaVersion: QUEUE_TRIAGE_PARITY_SCHEMA_VERSION,
    status,
    releaseId: agent.releaseId,
    projectId: agent.projectId,
    repository: agent.repository,
    agentFingerprint: agent.fingerprint,
    oversightFingerprint: oversight.fingerprint,
    mismatchFields: Object.freeze([...new Set(mismatchFields)].sort()),
  };
  return Object.freeze({
    ...stableResult,
    comparedAt: iso(comparedAt, 'comparedAt'),
    parityFingerprint: evidenceFingerprint(stableResult),
  });
}

export const QUEUE_TRIAGE_PARITY_STORE_SCHEMA_VERSION = 1;
const MAX_RESULT_JSON_BYTES = 512 * 1024;

function boundedResultJson(value) {
  const json = stableJson(value);
  if (Buffer.byteLength(json) > MAX_RESULT_JSON_BYTES) throw new Error('parity result exceeds the bounded size');
  return json;
}

export function ensureQueueTriageParitySchema(db, { appliedAt = new Date().toISOString() } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') throw new Error('shadow database handle is required');
  const shadowSchema = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'queue_triage_shadow_schema'").get();
  const observations = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'queue_triage_shadow_observations'").get();
  if (!shadowSchema || !observations) throw new Error('queue triage shadow schema is required before parity');
  const paritySchema = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'queue_triage_parity_schema'").get();
  if (paritySchema) {
    const current = db.prepare('SELECT MAX(version) AS version FROM queue_triage_parity_schema').get();
    if (Number(current?.version) !== QUEUE_TRIAGE_PARITY_STORE_SCHEMA_VERSION) {
      throw new Error(`unsupported queue triage parity schema version: ${String(current?.version ?? 'missing')}`);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_triage_parity_schema (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS queue_triage_shadow_parity (
      parity_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      agent_fingerprint TEXT NOT NULL,
      oversight_fingerprint TEXT NOT NULL,
      parity_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('match', 'material_disagreement', 'incomplete')),
      compared_at TEXT NOT NULL,
      result_json TEXT NOT NULL,
      UNIQUE (batch_id, agent_fingerprint, oversight_fingerprint),
      FOREIGN KEY (batch_id) REFERENCES queue_triage_shadow_observations(batch_id) ON DELETE RESTRICT
    );
  `);
  db.prepare('INSERT OR IGNORE INTO queue_triage_parity_schema(version, applied_at) VALUES (?, ?)')
    .run(QUEUE_TRIAGE_PARITY_STORE_SCHEMA_VERSION, iso(appliedAt, 'appliedAt'));
}

export function persistQueueTriageParity({ db, releaseId, agentCandidate, oversightCandidate, comparedAt = new Date().toISOString() } = {}) {
  if (!nonEmpty(releaseId)) throw new Error('releaseId is required for parity persistence');
  const agent = normalizeQueueTriageParityCandidate(agentCandidate);
  const oversight = normalizeQueueTriageParityCandidate(oversightCandidate);
  if (agent.releaseId !== releaseId) throw new Error('agent parity candidate release identity mismatch');
  ensureQueueTriageParitySchema(db, { appliedAt: comparedAt });
  const observation = db.prepare('SELECT batch_id FROM queue_triage_shadow_observations WHERE batch_id = ?').get(releaseId);
  if (!observation) throw new Error('shadow observation is required before parity persistence');
  const result = compareQueueTriageParity(agent, oversight, { comparedAt });
  const resultJson = boundedResultJson(result);
  const parityId = `shadow-parity-${evidenceFingerprint({
    releaseId,
    agentFingerprint: result.agentFingerprint,
    oversightFingerprint: result.oversightFingerprint,
  }).slice(7, 31)}`;
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO queue_triage_shadow_parity(
      parity_id, batch_id, agent_fingerprint, oversight_fingerprint,
      parity_fingerprint, status, compared_at, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parityId,
    releaseId,
    result.agentFingerprint,
    result.oversightFingerprint,
    result.parityFingerprint,
    result.status,
    result.comparedAt,
    resultJson,
  );
  const row = db.prepare(`
    SELECT * FROM queue_triage_shadow_parity
    WHERE batch_id = ? AND agent_fingerprint = ? AND oversight_fingerprint = ?
  `).get(releaseId, result.agentFingerprint, result.oversightFingerprint);
  if (!row || row.parity_fingerprint !== result.parityFingerprint) {
    const error = new Error(`release ${releaseId} produced changed parity for identical inputs`);
    error.code = 'shadow-parity-collision';
    throw error;
  }
  const didInsert = Number(inserted.changes) === 1;
  return Object.freeze({
    inserted: didInsert,
    replayed: !didInsert,
    parityId: row.parity_id,
    result: Object.freeze(JSON.parse(row.result_json)),
  });
}
