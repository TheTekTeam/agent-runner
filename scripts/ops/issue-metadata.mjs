#!/usr/bin/env node

/**
 * Issue workflow metadata adapter.
 *
 * GitHub labels are still used as a compatibility transport because `gh issue
 * list` and the current ChatGPT connector can query them cheaply. Structured
 * metadata belongs in GitHub issue/project fields. This adapter treats field
 * values as canonical whenever a caller supplies them, falls back to legacy
 * labels only when fields are absent, and reports conflicts instead of silently
 * picking whichever value a script happened to read first.
 */

export const FIELD_NAMES = Object.freeze({
  status: ['Status'],
  priority: ['Priority'],
  type: ['Type'],
  agent: ['Agent', 'Worker', 'Worker fit'],
  area: ['Area', 'Component'],
  effort: ['Effort', 'Size'],
  target: ['Target', 'Release'],
});

export const STATUS_LABELS = Object.freeze({
  'status:ready': 'Ready',
  'status:in-progress': 'In Progress',
  'status:blocked': 'Blocked',
  'status:done': 'Done',
});

export const STATUS_VALUES = Object.freeze({
  ready: 'Ready',
  inProgress: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
});

export const STATUS_VALUE_TO_LABEL = Object.freeze(Object.fromEntries(
  Object.entries(STATUS_LABELS).map(([label, value]) => [normaliseToken(value), label]),
));

export const PRIORITY_VALUES = Object.freeze(['P0', 'P1', 'P2', 'P3', 'P4']);
export const PRIORITY_LABELS = Object.freeze(Object.fromEntries(PRIORITY_VALUES.map((value) => [`priority:${value}`, value])));
export const PRIORITY_VALUE_TO_LABEL = Object.freeze(Object.fromEntries(PRIORITY_VALUES.map((value) => [normaliseToken(value), `priority:${value}`])));

const STRUCTURED_LABEL_PREFIXES = ['status:', 'priority:', 'type:', 'agent:', 'area:'];

export function normaliseToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function labelNames(issue) {
  return (issue?.labels || [])
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter(Boolean);
}

export function structuredLabels(issue) {
  return labelNames(issue).filter((label) => STRUCTURED_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix)));
}

function valueFromFieldNode(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.value === 'string' || typeof node.value === 'number') return String(node.value);
  if (typeof node.name === 'string') return node.name;
  if (typeof node.text === 'string') return node.text;
  if (typeof node.title === 'string') return node.title;
  if (typeof node.number === 'number') return String(node.number);
  if (typeof node.date === 'string') return node.date;
  if (node.option && typeof node.option.name === 'string') return node.option.name;
  if (node.iteration && typeof node.iteration.title === 'string') return node.iteration.title;
  return null;
}

function fieldNameFromNode(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.fieldName === 'string') return node.fieldName;
  if (typeof node.name === 'string' && Object.hasOwn(node, 'value')) return node.name;
  if (typeof node.field?.name === 'string') return node.field.name;
  if (typeof node.projectField?.name === 'string') return node.projectField.name;
  return null;
}

function addField(entries, name, value, source = 'field') {
  const cleanName = String(name || '').trim();
  const cleanValue = String(value || '').trim();
  if (!cleanName || !cleanValue) return;
  entries.push({ name: cleanName, value: cleanValue, source });
}

export function extractIssueFields(issue) {
  const entries = [];

  if (issue?.fields && !Array.isArray(issue.fields) && typeof issue.fields === 'object') {
    for (const [name, value] of Object.entries(issue.fields)) {
      if (value && typeof value === 'object') addField(entries, name, valueFromFieldNode(value), 'fields-object');
      else addField(entries, name, value, 'fields-object');
    }
  }

  const directArrays = [issue?.fields, issue?.fieldValues, issue?.field_values].filter(Array.isArray);
  for (const values of directArrays) {
    for (const node of values) addField(entries, fieldNameFromNode(node), valueFromFieldNode(node), 'field-array');
  }

  const projectItems = Array.isArray(issue?.projectItems) ? issue.projectItems : [];
  for (const item of projectItems) {
    const fieldValues = item?.fieldValues?.nodes || item?.fieldValues || item?.fields || [];
    if (!Array.isArray(fieldValues)) continue;
    for (const node of fieldValues) addField(entries, fieldNameFromNode(node), valueFromFieldNode(node), 'project-item');
  }

  return entries;
}

export function findFieldValue(issue, names = []) {
  const wanted = new Set(names.map(normaliseToken));
  return extractIssueFields(issue).find((entry) => wanted.has(normaliseToken(entry.name))) || null;
}

function firstMappedLabel(labels, map) {
  for (const label of labels) {
    if (Object.hasOwn(map, label)) return { label, value: map[label] };
  }
  return null;
}

function firstPrefixedLabel(labels, prefix) {
  const label = labels.find((candidate) => candidate.startsWith(prefix));
  return label ? { label, value: label.slice(prefix.length) } : null;
}

function canonicalStatus(value) {
  const token = normaliseToken(value);
  if (token === 'ready') return STATUS_VALUES.ready;
  if (token === 'in progress' || token === 'in-progress' || token === 'inprogress') return STATUS_VALUES.inProgress;
  if (token === 'blocked') return STATUS_VALUES.blocked;
  if (token === 'done' || token === 'complete' || token === 'completed' || token === 'closed') return STATUS_VALUES.done;
  return String(value || '').trim() || null;
}

function canonicalPriority(value) {
  const token = String(value || '').trim().toUpperCase();
  return PRIORITY_VALUES.includes(token) ? token : token || null;
}

function resolveMetadataValue({ issue, key, names, labelMap, labelPrefix, canonicalise = (value) => String(value || '').trim() || null, fallbackLabel = null }) {
  const labels = labelNames(issue);
  const field = findFieldValue(issue, names);
  const mappedLabel = labelMap ? firstMappedLabel(labels, labelMap) : firstPrefixedLabel(labels, labelPrefix);
  const fallback = fallbackLabel ? { label: fallbackLabel, value: labelMap?.[fallbackLabel] || fallbackLabel.slice(String(labelPrefix || '').length) || fallbackLabel, synthetic: true } : null;
  const label = mappedLabel || fallback;
  const fieldValue = field ? canonicalise(field.value) : null;
  const labelValue = label ? canonicalise(label.value) : null;
  const value = fieldValue || labelValue || null;
  const source = fieldValue ? 'field' : labelValue ? 'label' : 'missing';
  const conflict = fieldValue && labelValue && !label?.synthetic && normaliseToken(fieldValue) !== normaliseToken(labelValue)
    ? { key, field: names[0], fieldValue, label: label.label, labelValue }
    : null;
  return {
    key,
    value,
    source,
    fieldName: field?.name || names[0],
    fieldValue,
    fieldSource: field?.source || null,
    label: label?.label || null,
    labelValue,
    conflict,
  };
}

export function issueMetadata(issue, { statusFallbackLabel = null } = {}) {
  const status = resolveMetadataValue({
    issue,
    key: 'status',
    names: FIELD_NAMES.status,
    labelMap: STATUS_LABELS,
    canonicalise: canonicalStatus,
    fallbackLabel: statusFallbackLabel,
  });
  const priority = resolveMetadataValue({
    issue,
    key: 'priority',
    names: FIELD_NAMES.priority,
    labelMap: PRIORITY_LABELS,
    canonicalise: canonicalPriority,
  });
  const type = resolveMetadataValue({ issue, key: 'type', names: FIELD_NAMES.type, labelPrefix: 'type:' });
  const agent = resolveMetadataValue({ issue, key: 'agent', names: FIELD_NAMES.agent, labelPrefix: 'agent:' });
  const area = resolveMetadataValue({ issue, key: 'area', names: FIELD_NAMES.area, labelPrefix: 'area:' });

  const conflicts = [status.conflict, priority.conflict, type.conflict, agent.conflict, area.conflict].filter(Boolean);
  return {
    status,
    priority,
    type,
    agent,
    area,
    fields: extractIssueFields(issue),
    structuredLabels: structuredLabels(issue),
    conflicts,
    statusLabel: STATUS_VALUE_TO_LABEL[normaliseToken(status.value)] || statusFallbackLabel || status.label || null,
    priorityLabel: PRIORITY_VALUE_TO_LABEL[normaliseToken(priority.value)] || priority.label || null,
  };
}

export function priorityRank(issueOrMetadata) {
  const metadata = issueOrMetadata?.priority ? issueOrMetadata : issueMetadata(issueOrMetadata);
  const index = PRIORITY_VALUES.indexOf(metadata.priority.value);
  return index === -1 ? 99 : index;
}

export function statusRank(issueOrMetadata) {
  const metadata = issueOrMetadata?.status ? issueOrMetadata : issueMetadata(issueOrMetadata, { statusFallbackLabel: issueOrMetadata?.statusLabel });
  const token = normaliseToken(metadata.status.value);
  if (token === normaliseToken(STATUS_VALUES.inProgress)) return 0;
  if (token === normaliseToken(STATUS_VALUES.ready)) return 1;
  if (token === normaliseToken(STATUS_VALUES.blocked)) return 2;
  if (token === normaliseToken(STATUS_VALUES.done)) return 9;
  return 99;
}

export function decorateIssueWithMetadata(issue, options = {}) {
  const metadata = issueMetadata(issue, options);
  return {
    ...issue,
    metadata,
    metadataConflicts: metadata.conflicts,
    statusLabel: metadata.statusLabel || issue.statusLabel || options.statusFallbackLabel || null,
  };
}
