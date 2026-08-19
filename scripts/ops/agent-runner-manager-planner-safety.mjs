#!/usr/bin/env node

/**
 * #261: shared pure helpers for the provider-neutral, read-only Build
 * Manager planner (evidence snapshot, project brief, plan proposal). No
 * module in the planner family performs a GitHub call, a clone, a provider
 * invocation or any mutation -- see docs/ops/AGENT-RUNNER-MANAGER-PLANNER.md.
 */

import { createHash } from 'node:crypto';

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function stringArray(value) {
  return Array.isArray(value) && value.every(nonEmptyString);
}

export function freezeArray(array) {
  return Object.freeze([...array]);
}

export function assertNoUnknownFields(object, allowed, label, errors) {
  if (!isPlainObject(object)) return;
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) errors.push(`${label}.${key} is not a recognised field`);
  }
}

// Absolute or home-relative local-machine path forms. Planner input fails
// closed on these rather than silently redacting them, unlike the
// operator-status free-text redaction in agent-runner-control-overview.mjs.
const LOCAL_PATH_PATTERN = /(^|[\s"'([{])(?:~\/|\/(?:home|Users|root|etc|var|tmp|opt)\/|[A-Za-z]:\\)/;

// Control characters other than plain whitespace: a bounded free-text field
// must never smuggle these.
const CONTROL_CHARACTER_PATTERN = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);

// A representative, bounded set of secret/credential token shapes. Not
// exhaustive -- defense in depth alongside "planner input is never raw
// provider output" at the call sites that populate it.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i,
  /\bpassword\s*[:=]\s*\S+/i,
];

// Shell/executable-payload markers. Planner text is descriptive prose, never
// a command to execute.
const SHELL_PAYLOAD_PATTERNS = [
  /\$\(/,
  /`[^`]*`/,
  /&&|\|\|/,
  /;\s*(rm|curl|wget|bash|sh|eval|exec)\b/i,
  /<script/i,
  /\beval\s*\(/i,
];

// Explicit write-action verbs a read-only planner proposal must never carry,
// even as descriptive text -- see #261 "Reject ... merge, deploy, close,
// label, dispatch, provider-run, source-activation, or other write actions".
const WRITE_ACTION_PATTERNS = [
  /\bmerge\b/i,
  /\bdeploy\b/i,
  /\bforce[- ]push\b/i,
  /\bclose\s+(this\s+)?issue\b/i,
  /\bdispatch\b/i,
  /\bactivate\s+source\b/i,
  /\bsource[- ]activation\b/i,
  /\bprovider[- ]run\b/i,
  /\bdelete\s+branch\b/i,
  /\badd\s+label\b/i,
  /\bapply\s+label\b/i,
];

/**
 * Fail-closed check for one bounded free-text field: required, bounded
 * length, no control characters, no local-machine path, no secret-shaped
 * token, no shell/executable payload and (unless explicitly disabled) no
 * write-action phrasing. Pushes onto `errors` rather than throwing so
 * callers can accumulate every violation before failing the whole input.
 */
export function assertBoundedSafeText(value, label, errors, { max, allowWriteActionScan = true } = {}) {
  if (!nonEmptyString(value)) {
    errors.push(`${label} is required and must be a non-empty string`);
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) errors.push(`${label} must be at most ${max} characters`);
  if (CONTROL_CHARACTER_PATTERN.test(trimmed)) errors.push(`${label} must not contain control characters`);
  if (LOCAL_PATH_PATTERN.test(trimmed)) errors.push(`${label} must not contain a local-machine path`);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(trimmed))) errors.push(`${label} must not contain a secret or credential-shaped token`);
  if (SHELL_PAYLOAD_PATTERNS.some((pattern) => pattern.test(trimmed))) errors.push(`${label} must not contain a shell command or executable payload`);
  if (allowWriteActionScan && WRITE_ACTION_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    errors.push(`${label} must not describe a write action (merge/deploy/close/dispatch/source-activation/label mutation)`);
  }
}

export function assertBoundedSafeTextArray(values, label, errors, { max, itemMax, minLength = 0, allowWriteActionScan = true } = {}) {
  if (!Array.isArray(values)) {
    errors.push(`${label} must be an array of strings`);
    return null;
  }
  if (values.length < minLength) errors.push(`${label} must contain at least ${minLength} entr${minLength === 1 ? 'y' : 'ies'}`);
  if (values.length > max) errors.push(`${label} must contain at most ${max} entries`);
  values.forEach((value, index) => assertBoundedSafeText(value, `${label}[${index}]`, errors, { max: itemMax, allowWriteActionScan }));
  if (errors.length) return null;
  return freezeArray(values.map((value) => value.trim()));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

/** Deterministic, key-sorted JSON serialization used for both stable output and fingerprinting. */
export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

/** Deterministic content fingerprint: identical logical content always yields an identical fingerprint. */
export function contentFingerprint(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}
