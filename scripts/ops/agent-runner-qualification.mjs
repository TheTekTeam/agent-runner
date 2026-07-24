#!/usr/bin/env node

// Conservative agent/model/harness qualification (issue #50).
//
// Qualification is decided *only* from a caller-supplied, already-normalized
// qualification profile -- the sanitized shape `normalizeAgentQualification()`
// (agent-runner-agent-settings.mjs) produces from validated machine-local
// settings, or an equivalent strictly-bounded object a test injects directly.
// This module never reads a settings file, an agent name, an installed
// executable, an issue title/body, or provider reputation to infer
// qualification -- every function here is a pure match over already-resolved
// inputs. Missing qualification (an empty list, no wildcard) always means
// unqualified; it is never coerced into a permissive default.

import { QUALIFICATION_WILDCARD as WILDCARD } from './agent-runner-agent-settings.mjs';
import { findFieldValue, labelNames, normaliseToken } from './issue-metadata.mjs';

export const OLLAMA_AGENT_ID = 'ollama-agent';
export const LOW_RISK_CLASS = 'low';

export { WILDCARD };

// Issue #50: explicit structured task/risk/model/harness classification,
// built only from issue-metadata.mjs's already-exported, generic field/label
// primitives (findFieldValue/labelNames/normaliseToken) -- never a change to
// that module itself. Title/body prose is never inspected.
const CLASSIFICATION_FIELDS = Object.freeze({
  taskClass: Object.freeze({ names: Object.freeze(['Task', 'Task Class']), labelPrefix: 'task:' }),
  riskClass: Object.freeze({ names: Object.freeze(['Risk', 'Risk Class']), labelPrefix: 'risk:' }),
  model: Object.freeze({ names: Object.freeze(['Model']), labelPrefix: 'model:' }),
  harness: Object.freeze({ names: Object.freeze(['Harness']), labelPrefix: 'harness:' }),
});

function labelValueForPrefix(issue, prefix) {
  const label = labelNames(issue).find((name) => name.startsWith(prefix));
  return label ? (label.slice(prefix.length).trim() || null) : null;
}

/**
 * One field's classification: a project-field value and a label value that
 * actively disagree resolve to `null` (never guessed toward either side);
 * otherwise whichever of the two is present wins, and absence of both is
 * `null` (unclassified) -- never a guessed permissive default. The raw
 * field/label values that disagreed are intentionally not returned here --
 * only a boolean conflict flag -- so no issue-authored text can reach a
 * decision, log, SQLite row, or comment (issue #50 review, sink hardening).
 */
function classifyOneField(issue, { names, labelPrefix }) {
  const field = findFieldValue(issue, names);
  const fieldValue = field ? (String(field.value || '').trim() || null) : null;
  const labelValue = labelValueForPrefix(issue, labelPrefix);
  if (fieldValue && labelValue && normaliseToken(fieldValue) !== normaliseToken(labelValue)) {
    return { value: null, conflict: true };
  }
  return { value: fieldValue || labelValue || null, conflict: false };
}

/**
 * Conservative task/risk/model/harness classification for the issue #50
 * selector. Missing metadata classifies as `null` (unclassified); a
 * project-field/label disagreement also classifies as `null` rather than
 * silently picking a side.
 */
export function classifyIssueTaskRisk(issue) {
  const taskClass = classifyOneField(issue, CLASSIFICATION_FIELDS.taskClass);
  const riskClass = classifyOneField(issue, CLASSIFICATION_FIELDS.riskClass);
  const model = classifyOneField(issue, CLASSIFICATION_FIELDS.model);
  const harness = classifyOneField(issue, CLASSIFICATION_FIELDS.harness);
  const conflicts = [];
  if (taskClass.conflict) conflicts.push({ key: 'taskClass' });
  if (riskClass.conflict) conflicts.push({ key: 'riskClass' });
  if (model.conflict) conflicts.push({ key: 'model' });
  if (harness.conflict) conflicts.push({ key: 'harness' });
  return { taskClass: taskClass.value, riskClass: riskClass.value, model: model.value, harness: harness.value, conflicts };
}

/**
 * Core classification match (task class / risk class). An unclassified
 * (`null`/`undefined`) value never matches -- not even a wildcard-qualified
 * agent -- because missing or conflicting task/risk metadata must never be
 * turned into an eligible class. A wildcard entry matches any *known,
 * explicit* class; otherwise a classified value must appear verbatim in the
 * agent's explicit list.
 */
export function matchesClassification(qualifiedList = [], value = null) {
  if (value === null || value === undefined) return false;
  const list = Array.isArray(qualifiedList) ? qualifiedList : [];
  if (list.includes(WILDCARD)) return true;
  return list.includes(value);
}

/**
 * Supplementary match (model / harness). These only constrain selection
 * when the issue explicitly requests a specific value; an issue that does
 * not request one is never blocked by an agent's model/harness list.
 */
export function matchesSupplementary(qualifiedListOrValue, requestedValue = null) {
  if (requestedValue === null || requestedValue === undefined) return true;
  if (Array.isArray(qualifiedListOrValue)) {
    return qualifiedListOrValue.includes(WILDCARD) || qualifiedListOrValue.includes(requestedValue);
  }
  if (qualifiedListOrValue === WILDCARD) return true;
  return qualifiedListOrValue === requestedValue;
}

/**
 * Ollama's structural low-risk boundary (issue #50, "Ollama task
 * boundary"). This is enforced here in code, independent of whatever a
 * settings file or injected fixture claims: `ollama-agent` can never be
 * treated as qualified for a classified risk other than exactly `"low"`,
 * and an unclassified (`null`) risk never satisfies this boundary either --
 * low risk must be explicitly proven by structured metadata, never assumed
 * from an issue's prose or from the absence of a risk label.
 */
export function ollamaRiskBoundaryPasses(agentId, riskClass) {
  if (agentId !== OLLAMA_AGENT_ID) return true;
  return riskClass === LOW_RISK_CLASS;
}

/**
 * Full qualification assessment for one agent against one issue's
 * classification. Returns a bounded, sanitized decision: a boolean plus a
 * short closed-vocabulary reason list -- never the raw qualification object,
 * settings, or issue text.
 */
export function assessQualification({
  agentId,
  qualification = { taskClasses: [], riskClasses: [], models: [], harness: null },
  classification = { taskClass: null, riskClass: null, model: null, harness: null },
} = {}) {
  const reasons = [];
  if (!matchesClassification(qualification.taskClasses, classification.taskClass)) reasons.push('task-class-not-qualified');
  if (!matchesClassification(qualification.riskClasses, classification.riskClass)) reasons.push('risk-class-not-qualified');
  if (!ollamaRiskBoundaryPasses(agentId, classification.riskClass)) reasons.push('ollama-low-risk-boundary');
  if (!matchesSupplementary(qualification.models, classification.model)) reasons.push('model-not-qualified');
  if (!matchesSupplementary(qualification.harness, classification.harness)) reasons.push('harness-not-qualified');
  return { qualified: reasons.length === 0, reasons };
}
