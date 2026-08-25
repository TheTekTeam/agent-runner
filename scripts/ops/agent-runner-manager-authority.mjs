#!/usr/bin/env node

import { createHash } from 'node:crypto';

import {
  commentRevision,
  normalizeCommentIdentity,
} from './claude-runner-comment-identity.mjs';
import { normalizeRequiredCapabilities } from './claude-runner-capability-model.mjs';

export const MANAGER_PREFLIGHT_MARKER = '<!-- agent-runner:manager-preflight -->';
export const MANAGER_PREFLIGHT_SCHEMA_VERSION = 'agent-runner-manager-preflight/v1';
export const MANAGER_PREFLIGHT_REQUIRED = 'manager-preflight-required';
export const MANAGER_PREFLIGHT_INVALID = 'manager-preflight-invalid';
export const MANAGER_PREFLIGHT_REVOKED = 'manager-preflight-revoked';
export const MANAGER_PREFLIGHT_ALREADY_CLAIMED = 'manager-preflight-already-claimed';

/**
 * #267: the deterministic Build Manager authority transition
 * (`agent-runner-manager-worker-authority.mjs`) is an additional authorised
 * producer domain alongside the existing manager sessions. It is *not* a
 * relaxation of the runner boundary: the manager domain produces authority and
 * the worker domain consumes it, the two identities can never be the same, and
 * the runner-generated refusal below still applies to every packet regardless
 * of the producer type it declares.
 */
export const MANAGER_PREFLIGHT_BUILD_MANAGER_PRODUCER = 'build_manager_authority_transition';

const ALLOWED_PRODUCER_TYPES = new Set([
  'normal_chatgpt_manager_session',
  'chatgpt_scheduled_task',
  MANAGER_PREFLIGHT_BUILD_MANAGER_PRODUCER,
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

function rawScalarFromYamlBlock(body, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const block of yamlBlocks(body)) {
    const value = block.match(new RegExp(`^\\s*${escaped}\\s*:\\s*(.*?)\\s*$`, 'mi'))?.[1];
    if (value !== undefined) return String(value).trim();
  }
  return null;
}

function scalarFromYamlBlock(body, key) {
  const raw = rawScalarFromYamlBlock(body, key);
  return raw === null ? null : raw.replace(/^["']|["']$/g, '');
}

function yamlListValues(body, keys = []) {
  const accepted = new Set(keys);
  const values = [];
  for (const block of yamlBlocks(body)) {
    const lines = block.split(/\r?\n/);
    let active = false;
    for (const line of lines) {
      const topLevel = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:/);
      if (topLevel) {
        active = accepted.has(topLevel[1]);
        continue;
      }
      const item = active && line.match(/^\s+-\s+(\S.*?)\s*$/);
      if (item) values.push(item[1].replace(/^["']|["']$/g, ''));
    }
  }
  return values;
}

function yamlListHasValues(body, keys = []) {
  return yamlListValues(body, keys).length > 0;
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
 * Resolve only execution scalars that remain authoritative for
 * subscription-backed Claude execution.
 *
 * Historical immutable packets may contain `max_budget_usd`. It is
 * deliberately ignored here: the field is compatibility data only and
 * cannot influence admission, profile resolution or child CLI arguments.
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
  });
}

/**
 * Resolve the structured `required_capabilities` list from a manager
 * preflight packet (#228). Capabilities are only ever taken from this exact
 * structured YAML field -- never inferred from free-form issue or packet
 * prose -- and unknown/ambiguous identifiers fail the whole packet closed
 * rather than being silently dropped.
 */
export function resolveManagerPreflightRequiredCapabilities(commentOrBody) {
  const comment = typeof commentOrBody === 'string'
    ? { body: commentOrBody }
    : (commentOrBody || {});
  const body = String(comment.body || '');
  const raw = yamlListValues(body, ['required_capabilities']);
  return normalizeRequiredCapabilities(raw);
}
