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

import { normalizeSafeToken, QUALIFICATION_WILDCARD as WILDCARD } from './agent-runner-agent-settings.mjs';
import { findFieldValue, labelNames } from './issue-metadata.mjs';

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

/** Every raw label suffix for a given `prefix:` -- not just the first one, so a caller can detect multiple distinct values instead of silently picking one. */
function labelValuesForPrefix(issue, prefix) {
  return labelNames(issue)
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length).trim())
    .filter(Boolean);
}

/**
 * One field's classification against the shared bounded safe-token grammar
 * (`agent-runner-agent-settings.mjs#normalizeSafeToken()` -- the exact same
 * normalizer settings qualification values go through, issue #50 review:
 * "reuse one bounded safe-token normalizer for both"). Three closed
 * outcomes, never a raw value:
 *  - a single explicit, in-grammar value (from a field, a label, or both
 *    agreeing) wins;
 *  - two or more *distinct* normalized label values for the same field is a
 *    conflict (`'multiple-labels'`) -- never "first label wins";
 *  - a field/label value that is present but fails the safe-token grammar
 *    (too long, wrong charset, control characters) is dropped to `null`
 *    with `'invalid-value'`, distinct from a genuine field/label
 *    disagreement (`'field-label-mismatch'`).
 * The raw field/label text itself never appears in the return value --
 * only a bounded value and a fixed-vocabulary conflict key.
 */
function classifyOneField(issue, { names, labelPrefix }) {
  const field = findFieldValue(issue, names);
  const rawFieldValue = field ? String(field.value || '').trim() : '';
  const fieldValue = rawFieldValue ? normalizeSafeToken(rawFieldValue) : null;
  if (rawFieldValue && !fieldValue) return { value: null, conflict: 'invalid-value' };

  const rawLabelSuffixes = labelValuesForPrefix(issue, labelPrefix);
  const normalizedLabelValues = [...new Set(rawLabelSuffixes.map((raw) => normalizeSafeToken(raw)).filter(Boolean))];
  if (rawLabelSuffixes.length > 0 && normalizedLabelValues.length === 0) return { value: null, conflict: 'invalid-value' };
  if (normalizedLabelValues.length > 1) return { value: null, conflict: 'multiple-labels' };
  const labelValue = normalizedLabelValues[0] || null;

  if (fieldValue && labelValue && fieldValue !== labelValue) return { value: null, conflict: 'field-label-mismatch' };
  return { value: fieldValue || labelValue || null, conflict: null };
}

/**
 * Conservative task/risk/model/harness classification for the issue #50
 * selector. Missing metadata classifies as `null` (unclassified); a
 * project-field/label disagreement, multiple distinct labels for one field,
 * or an out-of-grammar value all classify as `null` rather than silently
 * picking a side or a guessed permissive default. `conflicts` carries only
 * a bounded `{ key, reason }` pair per affected field -- `reason` is always
 * one of `'field-label-mismatch'`, `'multiple-labels'`, `'invalid-value'`.
 */
export function classifyIssueTaskRisk(issue) {
  const taskClass = classifyOneField(issue, CLASSIFICATION_FIELDS.taskClass);
  const riskClass = classifyOneField(issue, CLASSIFICATION_FIELDS.riskClass);
  const model = classifyOneField(issue, CLASSIFICATION_FIELDS.model);
  const harness = classifyOneField(issue, CLASSIFICATION_FIELDS.harness);
  const conflicts = [];
  if (taskClass.conflict) conflicts.push({ key: 'taskClass', reason: taskClass.conflict });
  if (riskClass.conflict) conflicts.push({ key: 'riskClass', reason: riskClass.conflict });
  if (model.conflict) conflicts.push({ key: 'model', reason: model.conflict });
  if (harness.conflict) conflicts.push({ key: 'harness', reason: harness.conflict });
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
