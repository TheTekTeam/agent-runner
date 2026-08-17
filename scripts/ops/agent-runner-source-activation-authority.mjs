#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeImplementationApprovers } from './agent-runner-admission.mjs';
import { packetBodyDigest } from './agent-runner-manager-authority.mjs';
import {
  REPOSITORY_ROOT,
  SourceActivationRefusal,
  activateAgentRunnerSource,
} from './agent-runner-source-activation.mjs';

export const SOURCE_ACTIVATION_AUTHORITY_MARKER = '<!-- agent-runner:source-activation-authority -->';
export const SOURCE_ACTIVATION_AUTHORITY_SCHEMA_VERSION = 'agent-runner-source-activation/v1';
export const SOURCE_ACTIVATION_STATE_SCHEMA_VERSION = 'agent-runner-source-activation-state/v1';
export const SOURCE_ACTIVATION_REPOSITORY = 'TheTekTeam/agent-runner';
export const SOURCE_ACTIVATION_BRANCH = 'main';
export const SOURCE_ACTIVATION_ENABLED_ENV = 'AGENT_RUNNER_SOURCE_ACTIVATION_ENABLED';
export const SOURCE_ACTIVATION_CONTROL_ISSUE_ENV = 'AGENT_RUNNER_SOURCE_ACTIVATION_CONTROL_ISSUE';
export const SOURCE_ACTIVATION_STATE_PATH_ENV = 'AGENT_RUNNER_SOURCE_ACTIVATION_STATE';

const ALLOWED_PRODUCER_TYPES = new Set([
  'normal_chatgpt_manager_session',
  'chatgpt_scheduled_task',
]);
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,160}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FULL_SHA_PATTERN = /^[a-f0-9]{40}$/;
const REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{2,160}$/;
const REFUSAL_REASON_PATTERN = /^[a-z0-9][a-z0-9-]{1,95}$/;
const AUTHORITY_KEY_PATTERN = /^source-activation:[A-Za-z0-9][A-Za-z0-9._:/-]{2,160}:sha256:[a-f0-9]{64}$/;
const MAX_AUTHORITY_BODY_BYTES = 32 * 1024;
const REQUIRED_AUTHORITY_FIELDS = Object.freeze([
  'schema_version',
  'revision',
  'target_repository',
  'target_branch',
  'target_commit',
  'producer_type',
  'reason',
  'fingerprint',
]);
const STATE_FIELDS = new Set([
  'schemaVersion',
  'sourceIssueNumber',
  'sourceCommentId',
  'authorityKey',
  'revision',
  'fingerprint',
  'bodyDigest',
  'targetCommit',
  'status',
  'refusalReason',
  'appliedAt',
  'finalHead',
]);

export class SourceActivationAuthorityError extends Error {
  constructor(reason, message = reason, { systemic = true } = {}) {
    super(message);
    this.name = 'SourceActivationAuthorityError';
    this.code = 'AGENT_RUNNER_SOURCE_ACTIVATION_AUTHORITY_ERROR';
    this.reason = reason;
    this.systemic = systemic;
  }
}

function authorityError(reason, message, options) {
  throw new SourceActivationAuthorityError(reason, message, options);
}

export function sourceActivationEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env[SOURCE_ACTIVATION_ENABLED_ENV] || '').trim().toLowerCase());
}

export function resolveSourceActivationControlIssue(env = process.env) {
  const raw = String(env[SOURCE_ACTIVATION_CONTROL_ISSUE_ENV] || '').trim();
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) {
    authorityError(
      'source-activation-control-issue-invalid',
      `${SOURCE_ACTIVATION_CONTROL_ISSUE_ENV} must be one positive integer when source activation is enabled.`,
    );
  }
  return Number(raw);
}

export function resolveSourceActivationStatePath(env = process.env) {
  return env[SOURCE_ACTIVATION_STATE_PATH_ENV]
    || resolve(String(env.HOME || homedir()), '.local/state/agent-runner/source-activation/state.json');
}

function markerCount(body) {
  return String(body || '').split(SOURCE_ACTIVATION_AUTHORITY_MARKER).length - 1;
}

function yamlBlocks(body = '') {
  return [...String(body || '').matchAll(/```ya?ml\s*\n([\s\S]*?)```/gi)].map((match) => match[1]);
}

function parseStrictYamlScalars(block) {
  const values = {};
  for (const rawLine of String(block || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = rawLine.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (!match) return { ok: false, reason: 'source-activation-authority-yaml-invalid', values };
    const [, key, rawValue] = match;
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return { ok: false, reason: 'source-activation-authority-field-duplicate', values };
    }
    const value = String(rawValue || '').trim().replace(/^["']|["']$/g, '');
    if (!value || value.length > 256 || /[\r\n]/.test(value)) {
      return { ok: false, reason: 'source-activation-authority-value-invalid', values };
    }
    values[key] = value;
  }
  return { ok: true, values };
}

export function sourceActivationFingerprint(material = {}) {
  const canonical = JSON.stringify({
    schema_version: material.schema_version,
    revision: material.revision,
    target_repository: material.target_repository,
    target_branch: material.target_branch,
    target_commit: String(material.target_commit || '').toLowerCase(),
    producer_type: material.producer_type,
    reason: material.reason,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function sourceActivationAuthorityKey(revision, fingerprint) {
  if (!revision || !fingerprint) return null;
  return `source-activation:${revision}:${fingerprint}`;
}

function commentId(comment) {
  const value = Number(comment?.id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function commentAuthor(comment) {
  return String(comment?.user?.login || comment?.author?.login || '').trim().toLowerCase();
}

function invalidAuthorityResult(reason, comment, body, values = undefined, errors = undefined) {
  return {
    valid: false,
    canonical: true,
    reason,
    ...(errors ? { errors } : {}),
    ...(values ? { values } : {}),
    comment,
    commentId: commentId(comment),
    bodyDigest: packetBodyDigest(body),
  };
}

export function parseSourceActivationAuthority(commentOrBody) {
  const comment = typeof commentOrBody === 'string' ? { body: commentOrBody } : (commentOrBody || {});
  const body = String(comment.body || '');
  const markers = markerCount(body);
  if (markers === 0) {
    return { valid: false, canonical: false, reason: 'source-activation-authority-required', comment };
  }
  if (body.length > MAX_AUTHORITY_BODY_BYTES) {
    return invalidAuthorityResult('source-activation-authority-body-too-large', comment, body);
  }
  if (markers !== 1) {
    return invalidAuthorityResult('source-activation-authority-marker-ambiguous', comment, body);
  }
  const blocks = yamlBlocks(body);
  if (blocks.length !== 1) {
    return invalidAuthorityResult('source-activation-authority-yaml-ambiguous', comment, body);
  }
  const parsed = parseStrictYamlScalars(blocks[0]);
  if (!parsed.ok) {
    return invalidAuthorityResult(parsed.reason, comment, body, parsed.values);
  }
  const values = parsed.values;
  const keys = Object.keys(values).sort();
  const expectedKeys = [...REQUIRED_AUTHORITY_FIELDS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    return invalidAuthorityResult('source-activation-authority-fields-invalid', comment, body, values);
  }

  const fingerprint = String(values.fingerprint || '').toLowerCase();
  const targetCommit = String(values.target_commit || '').toLowerCase();
  const errors = [];
  if (values.schema_version !== SOURCE_ACTIVATION_AUTHORITY_SCHEMA_VERSION) errors.push('schema_version');
  if (!REVISION_PATTERN.test(String(values.revision || ''))) errors.push('revision');
  if (values.target_repository !== SOURCE_ACTIVATION_REPOSITORY) errors.push('target_repository');
  if (values.target_branch !== SOURCE_ACTIVATION_BRANCH) errors.push('target_branch');
  if (!FULL_SHA_PATTERN.test(targetCommit)) errors.push('target_commit');
  if (!ALLOWED_PRODUCER_TYPES.has(String(values.producer_type || ''))) errors.push('producer_type');
  if (!REASON_PATTERN.test(String(values.reason || ''))) errors.push('reason');
  if (!FINGERPRINT_PATTERN.test(fingerprint)) errors.push('fingerprint');
  const expectedFingerprint = sourceActivationFingerprint(values);
  if (FINGERPRINT_PATTERN.test(fingerprint) && fingerprint !== expectedFingerprint) errors.push('fingerprint_mismatch');
  const id = commentId(comment);
  if (typeof commentOrBody !== 'string' && !id) errors.push('comment_id');

  if (errors.length > 0) {
    return invalidAuthorityResult('source-activation-authority-invalid', comment, body, values, errors);
  }

  return Object.freeze({
    valid: true,
    canonical: true,
    reason: null,
    schemaVersion: values.schema_version,
    revision: values.revision,
    fingerprint,
    authorityKey: sourceActivationAuthorityKey(values.revision, fingerprint),
    targetRepository: values.target_repository,
    targetBranch: values.target_branch,
    targetCommit,
    producerType: values.producer_type,
    activationReason: values.reason,
    commentId: id,
    author: commentAuthor(comment),
    bodyDigest: packetBodyDigest(body),
    comment,
  });
}

function githubTokenFromGh() {
  return execFileSync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function resolveSourceActivationGithubAuthEnv(env = process.env, tokenResolver = githubTokenFromGh) {
  if (env.GITHUB_TOKEN || env.GH_TOKEN) return { ...env };
  let token = '';
  try {
    token = String(tokenResolver?.() || '').trim();
  } catch {
    token = '';
  }
  if (!token) return null;
  return { ...env, GH_TOKEN: token };
}

export function fetchSourceActivationComments(
  issueNumber,
  { env = process.env, exec = execFileSync } = {},
) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    authorityError('source-activation-control-issue-invalid', 'Control issue identity is invalid.');
  }
  const authEnv = resolveSourceActivationGithubAuthEnv(env);
  if (!authEnv) {
    authorityError('source-activation-github-auth-unavailable', 'GitHub control-plane authentication is unavailable.');
  }
  let raw = '';
  try {
    raw = String(exec(
      'gh',
      [
        'api',
        '--paginate',
        '--slurp',
        `/repos/${SOURCE_ACTIVATION_REPOSITORY}/issues/${issueNumber}/comments?per_page=100`,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: authEnv,
        maxBuffer: 2 * 1024 * 1024,
      },
    ) || '');
  } catch {
    authorityError('source-activation-github-read-failed', 'Reading the configured source-activation control issue failed.');
  }
  let decoded;
  try {
    decoded = JSON.parse(raw || '[]');
  } catch {
    authorityError('source-activation-github-response-invalid', 'GitHub returned invalid control-issue comment data.');
  }
  const pages = Array.isArray(decoded) ? decoded : [];
  const comments = pages.flatMap((entry) => Array.isArray(entry) ? entry : [entry]);
  if (comments.length > 1000) {
    authorityError('source-activation-comment-bound-exceeded', 'Control issue contains too many comments for bounded evaluation.');
  }
  return comments;
}

function allowedStateShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => STATE_FIELDS.has(key));
}

export function normalizeSourceActivationState(value) {
  if (value === null || value === undefined) return null;
  if (!allowedStateShape(value)) {
    authorityError('source-activation-state-invalid', 'Source-activation state contains unsupported fields or shape.');
  }
  if (value.schemaVersion !== SOURCE_ACTIVATION_STATE_SCHEMA_VERSION) {
    authorityError('source-activation-state-invalid', 'Source-activation state schema is invalid.');
  }
  if (!Number.isSafeInteger(value.sourceIssueNumber) || value.sourceIssueNumber <= 0) {
    authorityError('source-activation-state-invalid', 'Source-activation state issue identity is invalid.');
  }
  if (!Number.isSafeInteger(value.sourceCommentId) || value.sourceCommentId <= 0) {
    authorityError('source-activation-state-invalid', 'Source-activation state comment identity is invalid.');
  }
  if (!['pending', 'applied', 'refused'].includes(value.status)) {
    authorityError('source-activation-state-invalid', 'Source-activation state status is invalid.');
  }
  if (!FINGERPRINT_PATTERN.test(String(value.bodyDigest || ''))) {
    authorityError('source-activation-state-invalid', 'Source-activation state body digest is invalid.');
  }
  if (value.revision !== null && value.revision !== undefined && !REVISION_PATTERN.test(String(value.revision))) {
    authorityError('source-activation-state-invalid', 'Source-activation state revision is invalid.');
  }
  if (value.fingerprint !== null && value.fingerprint !== undefined && !FINGERPRINT_PATTERN.test(String(value.fingerprint))) {
    authorityError('source-activation-state-invalid', 'Source-activation state fingerprint is invalid.');
  }
  if (value.authorityKey !== null && value.authorityKey !== undefined && !AUTHORITY_KEY_PATTERN.test(String(value.authorityKey))) {
    authorityError('source-activation-state-invalid', 'Source-activation state authority key is invalid.');
  }
  if (value.targetCommit !== null && value.targetCommit !== undefined && !FULL_SHA_PATTERN.test(String(value.targetCommit))) {
    authorityError('source-activation-state-invalid', 'Source-activation state target is invalid.');
  }
  if (value.finalHead !== null && value.finalHead !== undefined && !FULL_SHA_PATTERN.test(String(value.finalHead))) {
    authorityError('source-activation-state-invalid', 'Source-activation state final head is invalid.');
  }
  if (value.refusalReason !== null && value.refusalReason !== undefined && !REFUSAL_REASON_PATTERN.test(String(value.refusalReason))) {
    authorityError('source-activation-state-invalid', 'Source-activation state refusal reason is invalid.');
  }
  if (value.appliedAt !== null && value.appliedAt !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(String(value.appliedAt))) {
    authorityError('source-activation-state-invalid', 'Source-activation state applied timestamp is invalid.');
  }
  if (value.status === 'applied' && (!value.authorityKey || !value.targetCommit || !value.finalHead || !value.appliedAt)) {
    authorityError('source-activation-state-invalid', 'Applied source-activation state is incomplete.');
  }
  if (value.status === 'pending' && (!value.authorityKey || !value.targetCommit)) {
    authorityError('source-activation-state-invalid', 'Pending source-activation state is incomplete.');
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    sourceIssueNumber: value.sourceIssueNumber,
    sourceCommentId: value.sourceCommentId,
    authorityKey: value.authorityKey || null,
    revision: value.revision || null,
    fingerprint: value.fingerprint || null,
    bodyDigest: value.bodyDigest,
    targetCommit: value.targetCommit || null,
    status: value.status,
    refusalReason: value.refusalReason || null,
    appliedAt: value.appliedAt || null,
    finalHead: value.finalHead || null,
  });
}

export function readSourceActivationState(
  { env = process.env, exists = existsSync, readFile = readFileSync } = {},
) {
  const path = resolveSourceActivationStatePath(env);
  if (!exists(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFile(path, 'utf8'));
  } catch {
    authorityError('source-activation-state-invalid', 'Source-activation state could not be read or parsed.');
  }
  return normalizeSourceActivationState(parsed);
}

export function writeSourceActivationState(
  state,
  {
    env = process.env,
    mkdir = mkdirSync,
    writeFile = writeFileSync,
    chmod = chmodSync,
    rename = renameSync,
    remove = rmSync,
    pid = process.pid,
  } = {},
) {
  const normalized = normalizeSourceActivationState(state);
  const path = resolveSourceActivationStatePath(env);
  const parent = dirname(path);
  mkdir(parent, { recursive: true });
  const temp = `${path}.tmp-${pid}`;
  try {
    writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    chmod(temp, 0o600);
    rename(temp, path);
    chmod(path, 0o600);
  } catch {
    try { remove(temp, { force: true }); } catch { /* preserve write error */ }
    authorityError('source-activation-state-write-failed', 'Source-activation state could not be persisted.');
  }
  return normalized;
}

function defaultReadHead({ cwd = REPOSITORY_ROOT } = {}) {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const head = String(result.stdout || '').trim().toLowerCase();
  if (result.status !== 0 || !FULL_SHA_PATTERN.test(head)) {
    authorityError('source-activation-head-unavailable', 'Canonical Agent Runner HEAD could not be read.');
  }
  return head;
}

function boundedMalformedRevision(parsed) {
  const candidate = String(parsed.values?.revision || '');
  return REVISION_PATTERN.test(candidate) ? candidate : null;
}

function boundedMalformedFingerprint(parsed) {
  const candidate = String(parsed.values?.fingerprint || '').toLowerCase();
  return FINGERPRINT_PATTERN.test(candidate) ? candidate : null;
}

function boundedMalformedTarget(parsed) {
  const candidate = String(parsed.values?.target_commit || '').toLowerCase();
  return FULL_SHA_PATTERN.test(candidate) ? candidate : null;
}

function stateFromAuthority({ issueNumber, parsed, status, refusalReason = null, appliedAt = null, finalHead = null }) {
  return {
    schemaVersion: SOURCE_ACTIVATION_STATE_SCHEMA_VERSION,
    sourceIssueNumber: issueNumber,
    sourceCommentId: parsed.commentId,
    authorityKey: parsed.valid ? parsed.authorityKey : null,
    revision: parsed.valid ? parsed.revision : boundedMalformedRevision(parsed),
    fingerprint: parsed.valid ? parsed.fingerprint : boundedMalformedFingerprint(parsed),
    bodyDigest: parsed.bodyDigest || packetBodyDigest(String(parsed.comment?.body || '')),
    targetCommit: parsed.valid ? parsed.targetCommit : boundedMalformedTarget(parsed),
    status,
    refusalReason,
    appliedAt,
    finalHead,
  };
}

function sourceMarkerComments(comments) {
  const marked = comments.filter((comment) => String(comment?.body || '').includes(SOURCE_ACTIVATION_AUTHORITY_MARKER));
  if (marked.some((comment) => !commentId(comment))) {
    authorityError('source-activation-comment-identity-invalid', 'A source-activation authority comment lacks a stable REST comment identity.');
  }
  return marked.sort((a, b) => commentId(a) - commentId(b));
}

function halt(reason, extra = {}) {
  return { action: 'halt', reason, ...extra };
}

export async function evaluateSourceActivationAuthority({
  env = process.env,
  fetchComments = fetchSourceActivationComments,
  readState = () => readSourceActivationState({ env }),
  writeState = (state) => writeSourceActivationState(state, { env }),
  readHead = defaultReadHead,
  activateSource = ({ target }) => activateAgentRunnerSource({ target, env }),
  now = () => new Date().toISOString(),
} = {}) {
  if (!sourceActivationEnabled(env)) {
    return { action: 'continue', reason: 'source-activation-disabled' };
  }

  const issueNumber = resolveSourceActivationControlIssue(env);
  const { approvers, invalid } = normalizeImplementationApprovers(env.CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS);
  if (invalid.length > 0 || approvers.length === 0) {
    authorityError('source-activation-approver-policy-invalid', 'Approved manager author policy is empty or invalid.');
  }

  const state = readState();
  if (state && state.sourceIssueNumber !== issueNumber) {
    authorityError('source-activation-state-control-issue-mismatch', 'Durable state is bound to a different control issue.');
  }
  if (state?.status === 'applied') {
    const currentHead = readHead();
    if (currentHead !== state.targetCommit || state.finalHead !== state.targetCommit) {
      return halt('source-activation-applied-head-mismatch', { sourceCommentId: state.sourceCommentId });
    }
  }

  const comments = fetchComments(issueNumber, { env });
  const markerComments = sourceMarkerComments(comments);
  let boundComment = null;
  if (state) {
    boundComment = markerComments.find((comment) => commentId(comment) === state.sourceCommentId) || null;
    if (!boundComment) {
      return halt('source-activation-authority-comment-missing', { sourceCommentId: state.sourceCommentId });
    }
    if (packetBodyDigest(String(boundComment.body || '')) !== state.bodyDigest) {
      return halt('source-activation-authority-edited-after-consumption', { sourceCommentId: state.sourceCommentId });
    }
  }

  let eligible;
  if (state?.status === 'pending') {
    const newer = markerComments.filter((comment) => commentId(comment) > state.sourceCommentId);
    if (newer.length > 0) {
      return halt('source-activation-authority-ambiguous', { sourceCommentId: state.sourceCommentId });
    }
    eligible = boundComment ? [boundComment] : [];
  } else if (state) {
    eligible = markerComments.filter((comment) => commentId(comment) > state.sourceCommentId);
  } else {
    eligible = markerComments;
  }

  if (eligible.length === 0) {
    if (state?.status === 'refused') {
      return halt(state.refusalReason || 'source-activation-authority-refused', { sourceCommentId: state.sourceCommentId });
    }
    return {
      action: 'continue',
      reason: state?.status === 'applied'
        ? 'source-activation-authority-already-applied'
        : 'source-activation-authority-none',
    };
  }
  if (eligible.length !== 1) {
    return halt('source-activation-authority-ambiguous');
  }

  const comment = eligible[0];
  const parsed = parseSourceActivationAuthority(comment);
  if (!parsed.valid) {
    const refused = stateFromAuthority({
      issueNumber,
      parsed,
      status: 'refused',
      refusalReason: parsed.reason,
    });
    writeState(refused);
    return halt(parsed.reason, { sourceCommentId: parsed.commentId });
  }
  if (!approvers.includes(parsed.author)) {
    const refused = stateFromAuthority({
      issueNumber,
      parsed,
      status: 'refused',
      refusalReason: 'source-activation-author-unapproved',
    });
    writeState(refused);
    return halt('source-activation-author-unapproved', { sourceCommentId: parsed.commentId });
  }

  if (state?.status === 'pending') {
    if (parsed.authorityKey !== state.authorityKey || parsed.targetCommit !== state.targetCommit) {
      return halt('source-activation-pending-authority-mismatch', { sourceCommentId: state.sourceCommentId });
    }
  }

  const pending = stateFromAuthority({
    issueNumber,
    parsed,
    status: 'pending',
    refusalReason: null,
  });
  writeState(pending);

  let activation;
  try {
    activation = await activateSource({ target: parsed.targetCommit, env });
  } catch (error) {
    if (error?.code === 'AGENT_RUNNER_LOCKED' || error?.reason === 'implementation-lock-unavailable') {
      writeState({ ...pending, refusalReason: 'implementation-lock-unavailable' });
      return halt('implementation-lock-unavailable', { sourceCommentId: parsed.commentId });
    }
    if (error instanceof SourceActivationRefusal) {
      const refused = { ...pending, status: 'refused', refusalReason: error.reason };
      writeState(refused);
      return halt(error.reason, { sourceCommentId: parsed.commentId });
    }
    try { writeState({ ...pending, refusalReason: 'source-activation-systemic-failure' }); } catch { /* preserve systemic error */ }
    throw error;
  }

  if (!activation?.ok || activation.finalHead !== parsed.targetCommit) {
    authorityError('source-activation-result-invalid', 'Source activator returned an invalid success result.');
  }

  const applied = {
    ...pending,
    status: 'applied',
    refusalReason: null,
    appliedAt: now(),
    finalHead: activation.finalHead,
  };
  writeState(applied);
  return {
    action: 'reexec',
    reason: activation.result === 'already-active'
      ? 'source-activation-authority-applied-already-active'
      : 'source-activation-authority-applied',
    sourceCommentId: parsed.commentId,
    targetCommit: parsed.targetCommit,
  };
}

export function exitCodeForSourceActivationResult(result) {
  if (result?.action === 'continue') return 0;
  if (result?.action === 'reexec') return 10;
  if (result?.action === 'halt') return 3;
  return 1;
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  try {
    const result = await evaluateSourceActivationAuthority();
    console.log(JSON.stringify(result));
    process.exitCode = exitCodeForSourceActivationResult(result);
  } catch (error) {
    const reason = error instanceof SourceActivationAuthorityError
      ? error.reason
      : 'source-activation-authority-systemic-failure';
    console.error(JSON.stringify({ action: 'halt', reason, systemic: true }));
    process.exitCode = 1;
  }
}
