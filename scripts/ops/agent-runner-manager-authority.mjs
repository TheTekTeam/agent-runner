#!/usr/bin/env node

import { createHash } from 'node:crypto';

import {
  commentRevision,
  normalizeCommentIdentity,
} from './claude-runner-comment-identity.mjs';

export const MANAGER_PREFLIGHT_MARKER = '<!-- agent-runner:manager-preflight -->';
export const MANAGER_PREFLIGHT_SCHEMA_VERSION = 'agent-runner-manager-preflight/v1';
export const MANAGER_PREFLIGHT_REQUIRED = 'manager-preflight-required';
export const MANAGER_PREFLIGHT_INVALID = 'manager-preflight-invalid';
export const MANAGER_PREFLIGHT_REVOKED = 'manager-preflight-revoked';
export const MANAGER_PREFLIGHT_ALREADY_CLAIMED = 'manager-preflight-already-claimed';

const ALLOWED_PRODUCER_TYPES = new Set([
  'normal_chatgpt_manager_session',
  'chatgpt_scheduled_task',
]);
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,160}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REVOCATION_PATTERN = /^#{2,4}\s*(?:Manager|ChatGPT)\s+preflight(?:\s+packet)?\s*(?:[-—:]\s*)?(?:stale|invalid(?:ated)?|revoked|superseded)\b/im;
const RUNNER_STARTED_PATTERN = /^## Claude runner started\s*$/im;

function commentTime(comment) {
  return comment?.created_at || comment?.createdAt || '1970-01-01T00:00:00Z';
}

function yamlBlocks(body = '') {
  return [...String(body || '').matchAll(/```ya?ml\s*\n([\s\S]*?)```/gi)].map((match) => match[1]);
}

function scalarFromYamlBlock(body, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const block of yamlBlocks(body)) {
    const value = block.match(new RegExp(`^\\s*${escaped}\\s*:\\s*(.*?)\\s*$`, 'mi'))?.[1];
    if (value !== undefined) return String(value).trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

function yamlListHasValues(body, keys = []) {
  const accepted = new Set(keys);
  for (const block of yamlBlocks(body)) {
    const lines = block.split(/\r?\n/);
    let active = false;
    for (const line of lines) {
      const topLevel = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:/);
      if (topLevel) {
        active = accepted.has(topLevel[1]);
        continue;
      }
      if (active && /^\s+-\s+\S/.test(line)) return true;
    }
  }
  return false;
}

export function managerAuthorityKey(revision, fingerprint) {
  if (!revision || !fingerprint) return null;
  return `manager-preflight:${revision}:${fingerprint}`;
}

export function packetBodyDigest(body = '') {
  return `sha256:${createHash('sha256').update(String(body)).digest('hex')}`;
}

export function isManagerPreflightRevocation(body = '') {
  return REVOCATION_PATTERN.test(String(body || ''));
}

export function parseManagerPreflightPacket(commentOrBody) {
  const comment = typeof commentOrBody === 'string'
    ? { body: commentOrBody }
    : (commentOrBody || {});
  const body = String(comment.body || '');
  const markerPresent = body.includes(MANAGER_PREFLIGHT_MARKER);
  if (!markerPresent) {
    return { valid: false, canonical: false, reason: MANAGER_PREFLIGHT_REQUIRED, comment };
  }
  if (isManagerPreflightRevocation(body)) {
    return { valid: false, canonical: true, reason: MANAGER_PREFLIGHT_REVOKED, comment };
  }
  if (/claude-runner-generated-preflight|generated locally by the .*runner/i.test(body)) {
    return { valid: false, canonical: true, reason: MANAGER_PREFLIGHT_INVALID, detail: 'runner-generated manager authority is prohibited', comment };
  }

  const schemaVersion = scalarFromYamlBlock(body, 'schema_version');
  const revision = scalarFromYamlBlock(body, 'revision');
  const fingerprint = String(scalarFromYamlBlock(body, 'fingerprint') || '').toLowerCase();
  const producerType = scalarFromYamlBlock(body, 'producer_type');
  const approvedAgent = scalarFromYamlBlock(body, 'approved_agent');
  const executionPhase = scalarFromYamlBlock(body, 'execution_phase');
  const errors = [];

  if (schemaVersion !== MANAGER_PREFLIGHT_SCHEMA_VERSION) errors.push('schema_version');
  if (!REVISION_PATTERN.test(String(revision || ''))) errors.push('revision');
  if (!FINGERPRINT_PATTERN.test(fingerprint)) errors.push('fingerprint');
  if (!ALLOWED_PRODUCER_TYPES.has(String(producerType || ''))) errors.push('producer_type');
  if (!approvedAgent) errors.push('approved_agent');
  if (!['implementation', 'plan', 'review', 'recovery'].includes(String(executionPhase || ''))) errors.push('execution_phase');
  if (!yamlListHasValues(body, ['scope'])) errors.push('scope');
  if (!yamlListHasValues(body, ['required_validation', 'validation'])) errors.push('required_validation');
  if (!yamlListHasValues(body, ['stop_conditions'])) errors.push('stop_conditions');

  if (errors.length) {
    return {
      valid: false,
      canonical: true,
      reason: MANAGER_PREFLIGHT_INVALID,
      detail: `invalid or missing fields: ${errors.join(', ')}`,
      errors,
      comment,
    };
  }

  const commentIdentity = normalizeCommentIdentity(comment);
  return Object.freeze({
    valid: true,
    canonical: true,
    reason: null,
    schemaVersion,
    revision,
    fingerprint,
    producerType,
    approvedAgent,
    executionPhase,
    authorityKey: managerAuthorityKey(revision, fingerprint),
    packetDigest: packetBodyDigest(body),
    comment,
    commentIdentity,
    commentRevision: commentRevision(commentIdentity),
    createdAt: commentTime(comment),
  });
}

function claimedAuthorityKeys(comments = []) {
  const keys = new Set();
  for (const comment of comments) {
    const body = String(comment?.body || '');
    if (!RUNNER_STARTED_PATTERN.test(body)) continue;
    const key = body.match(/Manager packet authority:\s*`?([^\s`]+)`?/i)?.[1]
      || managerAuthorityKey(
        body.match(/Manager packet revision:\s*`?([^\s`]+)`?/i)?.[1],
        String(body.match(/Manager packet fingerprint:\s*`?(sha256:[a-f0-9]{64})`?/i)?.[1] || '').toLowerCase(),
      );
    if (key) keys.add(key);
  }
  return keys;
}

export function resolveCurrentManagerAuthority(comments = []) {
  const ordered = [...comments].sort((a, b) => String(commentTime(a)).localeCompare(String(commentTime(b))));
  let current = null;
  let terminalReason = MANAGER_PREFLIGHT_REQUIRED;
  let terminalDetail = null;

  for (const comment of ordered) {
    const body = String(comment?.body || '');
    if (body.includes(MANAGER_PREFLIGHT_MARKER)) {
      const parsed = parseManagerPreflightPacket(comment);
      current = parsed.valid ? parsed : null;
      terminalReason = parsed.reason;
      terminalDetail = parsed.detail || null;
      continue;
    }
    if (isManagerPreflightRevocation(body) && current) {
      current = null;
      terminalReason = MANAGER_PREFLIGHT_REVOKED;
      terminalDetail = 'the current manager packet was revoked or superseded';
    }
  }

  if (!current) {
    return { allowed: false, reason: terminalReason, detail: terminalDetail, authority: null };
  }
  if (claimedAuthorityKeys(comments).has(current.authorityKey)) {
    return {
      allowed: false,
      reason: MANAGER_PREFLIGHT_ALREADY_CLAIMED,
      detail: 'this immutable manager packet revision and fingerprint were already claimed',
      authority: current,
    };
  }
  return { allowed: true, reason: null, detail: null, authority: current };
}

export function managerAuthorityKeyIsCurrent(comments = [], authorityKey, packetDigest = null) {
  if (!authorityKey) return false;
  const resolved = resolveCurrentManagerAuthority(comments);
  const currentPacketUsable = resolved.allowed === true
    || resolved.reason === MANAGER_PREFLIGHT_ALREADY_CLAIMED;
  return currentPacketUsable
    && resolved.authority?.authorityKey === authorityKey
    && (!packetDigest || resolved.authority?.packetDigest === packetDigest);
}

export function managerAuthorityMatches(left, right) {
  const leftKey = typeof left === 'string' ? left : left?.authorityKey;
  const rightKey = typeof right === 'string' ? right : right?.authorityKey;
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

/**
 * Issue #50, requirement 9: after a reassignment, the runner must never
 * create/edit/refresh/revoke manager authority itself -- selection can only
 * become executable again once a normal ChatGPT manager session or approved
 * scheduled task posts a fresh packet whose `approved_agent` names the
 * replacement agent. This is the single comparison point: any mismatch (or
 * a missing authority/agentId) fails closed.
 */
export function managerAuthorityApprovesAgent(authority, agentId) {
  const approvedAgent = String(authority?.approvedAgent || '').trim();
  const candidate = String(agentId || '').trim();
  return Boolean(approvedAgent && candidate && approvedAgent === candidate);
}

/**
 * Issue #221: a canonical, quote-safe budget normalizer built on the
 * existing `scalarFromYamlBlock` quote-stripping path (so `"1.00"` and
 * `1.00` resolve identically). An explicit empty/malformed/nonnumeric/
 * zero/negative value must fail closed rather than silently becoming an
 * absent value that a caller could default.
 */
function normalizeManagerPreflightBudget(raw) {
  if (raw === null || raw === undefined) {
    return Object.freeze({ present: false, valid: false, value: null, raw: null });
  }
  const trimmed = String(raw).trim();
  if (trimmed === '') {
    return Object.freeze({ present: true, valid: false, value: null, raw: trimmed });
  }
  const numeric = Number(trimmed);
  const valid = Number.isFinite(numeric) && numeric > 0;
  return Object.freeze({ present: true, valid, value: valid ? numeric : null, raw: trimmed });
}

/**
 * Issue #221: single canonical resolver for the manager-preflight
 * `profile`/`model`/`effort`/`max_budget_usd` execution scalars. Reuses the
 * existing quote-safe `scalarFromYamlBlock` path rather than adding a
 * second free-form YAML parser, so it stays a bounded/non-secret seam that
 * #208 candidate admission and child-defense can reuse without re-solving
 * scalar normalization.
 */
export function resolveManagerPreflightExecutionMetadata(commentOrBody) {
  const comment = typeof commentOrBody === 'string'
    ? { body: commentOrBody }
    : (commentOrBody || {});
  const body = String(comment.body || '');
  return Object.freeze({
    profile: scalarFromYamlBlock(body, 'profile') || null,
    model: scalarFromYamlBlock(body, 'model') || null,
    effort: scalarFromYamlBlock(body, 'effort') || null,
    maxBudgetUsd: normalizeManagerPreflightBudget(scalarFromYamlBlock(body, 'max_budget_usd')),
  });
}
