import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { normalizeImplementationApprovers } from './agent-runner-admission.mjs';
import { packetBodyDigest } from './agent-runner-manager-authority.mjs';
import { resolveSourceActivationGithubAuthEnv } from './agent-runner-source-activation-authority.mjs';

export const FLEET_ACTIVATION_AUTHORITY_MARKER = '<!-- agent-runner:fleet-activation-authority -->';
export const FLEET_ACTIVATION_AUTHORITY_SCHEMA_VERSION = 'agent-runner-fleet-activation/v1';
export const FLEET_ACTIVATION_REPOSITORY = 'TheTekTeam/agent-runner';
export const FLEET_ACTIVATION_CONTROL_ISSUE_ENV = 'AGENT_RUNNER_FLEET_ACTIVATION_CONTROL_ISSUE';

const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,160}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}@[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const REASON = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{2,160}$/;
const STATES = new Set(['enabled', 'paused', 'draining', 'disabled']);
const PRODUCERS = new Set(['normal_chatgpt_manager_session', 'chatgpt_scheduled_task']);
const REQUIRED_FIELDS = Object.freeze([
  'schema_version',
  'revision',
  'target_repository',
  'target_issue',
  'target_source_commit',
  'target_registry_revision',
  'target_registry_fingerprint',
  'target_instance',
  'target_state',
  'producer_type',
  'reason',
  'fingerprint',
]);
const MAX_BODY_BYTES = 32 * 1024;
const VALIDATED = new WeakSet();

export class FleetActivationAuthorityError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'FleetActivationAuthorityError';
    this.code = code;
  }
}

function yamlBlocks(body = '') {
  return [...String(body || '').matchAll(/```ya?ml\s*\n([\s\S]*?)```/gi)].map((match) => match[1]);
}

function parseStrictScalars(block) {
  const values = {};
  for (const rawLine of String(block || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = rawLine.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (!match) throw new FleetActivationAuthorityError('fleet-activation-authority-yaml-invalid');
    const [, key, rawValue] = match;
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      throw new FleetActivationAuthorityError('fleet-activation-authority-field-duplicate');
    }
    const value = String(rawValue || '').trim().replace(/^["']|["']$/g, '');
    if (!value || value.length > 256 || /[\r\n]/.test(value)) {
      throw new FleetActivationAuthorityError('fleet-activation-authority-value-invalid');
    }
    values[key] = value;
  }
  return values;
}

function markerCount(body) {
  return String(body || '').split(FLEET_ACTIVATION_AUTHORITY_MARKER).length - 1;
}

function commentId(comment) {
  const value = Number(comment?.id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function commentAuthor(comment) {
  return String(comment?.user?.login || comment?.author?.login || '').trim().toLowerCase();
}

export function fleetActivationAuthorityFingerprint(material = {}) {
  const canonical = JSON.stringify({
    schema_version: material.schema_version,
    revision: material.revision,
    target_repository: material.target_repository,
    target_issue: Number(material.target_issue),
    target_source_commit: String(material.target_source_commit || '').toLowerCase(),
    target_registry_revision: Number(material.target_registry_revision),
    target_registry_fingerprint: String(material.target_registry_fingerprint || '').toLowerCase(),
    target_instance: material.target_instance,
    target_state: material.target_state,
    producer_type: material.producer_type,
    reason: material.reason,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function fleetActivationAuthorityKey(revision, fingerprint) {
  if (!revision || !fingerprint) return null;
  return `fleet-activation:${revision}:${fingerprint}`;
}

export function parseFleetActivationAuthority(commentOrBody) {
  const comment = typeof commentOrBody === 'string' ? { body: commentOrBody } : (commentOrBody || {});
  const body = String(comment.body || '');
  if (markerCount(body) !== 1) {
    throw new FleetActivationAuthorityError(
      body.includes(FLEET_ACTIVATION_AUTHORITY_MARKER)
        ? 'fleet-activation-authority-marker-ambiguous'
        : 'fleet-activation-authority-required',
    );
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    throw new FleetActivationAuthorityError('fleet-activation-authority-body-too-large');
  }
  const blocks = yamlBlocks(body);
  if (blocks.length !== 1) throw new FleetActivationAuthorityError('fleet-activation-authority-yaml-ambiguous');
  const values = parseStrictScalars(blocks[0]);
  if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify([...REQUIRED_FIELDS].sort())) {
    throw new FleetActivationAuthorityError('fleet-activation-authority-fields-invalid');
  }

  const issueNumber = Number(values.target_issue);
  const registryRevision = Number(values.target_registry_revision);
  const fingerprint = String(values.fingerprint || '').toLowerCase();
  const sourceCommit = String(values.target_source_commit || '').toLowerCase();
  const registryFingerprint = String(values.target_registry_fingerprint || '').toLowerCase();
  const errors = [];
  if (values.schema_version !== FLEET_ACTIVATION_AUTHORITY_SCHEMA_VERSION) errors.push('schema_version');
  if (!REVISION.test(values.revision)) errors.push('revision');
  if (values.target_repository !== FLEET_ACTIVATION_REPOSITORY) errors.push('target_repository');
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) errors.push('target_issue');
  if (!SHA.test(sourceCommit)) errors.push('target_source_commit');
  if (!Number.isSafeInteger(registryRevision) || registryRevision < 1) errors.push('target_registry_revision');
  if (!DIGEST.test(registryFingerprint)) errors.push('target_registry_fingerprint');
  if (!INSTANCE_ID.test(values.target_instance)) errors.push('target_instance');
  if (!STATES.has(values.target_state)) errors.push('target_state');
  if (!PRODUCERS.has(values.producer_type)) errors.push('producer_type');
  if (!REASON.test(values.reason)) errors.push('reason');
  if (!DIGEST.test(fingerprint)) errors.push('fingerprint');
  const expectedFingerprint = fleetActivationAuthorityFingerprint(values);
  if (DIGEST.test(fingerprint) && fingerprint !== expectedFingerprint) errors.push('fingerprint_mismatch');
  const id = typeof commentOrBody === 'string' ? null : commentId(comment);
  if (typeof commentOrBody !== 'string' && !id) errors.push('comment_id');
  if (errors.length) {
    throw new FleetActivationAuthorityError('fleet-activation-authority-invalid', `invalid fields: ${errors.join(',')}`);
  }

  return Object.freeze({
    schemaVersion: values.schema_version,
    revision: values.revision,
    fingerprint,
    authorityKey: fleetActivationAuthorityKey(values.revision, fingerprint),
    targetRepository: values.target_repository,
    targetIssue: issueNumber,
    targetSourceCommit: sourceCommit,
    targetRegistryRevision: registryRevision,
    targetRegistryFingerprint: registryFingerprint,
    targetInstanceId: values.target_instance,
    targetState: values.target_state,
    producerType: values.producer_type,
    activationReason: values.reason,
    commentId: id,
    author: commentAuthor(comment),
    bodyDigest: packetBodyDigest(body),
  });
}

export function resolveFleetActivationControlIssue(env = process.env) {
  const raw = String(env[FLEET_ACTIVATION_CONTROL_ISSUE_ENV] || '').trim();
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) {
    throw new FleetActivationAuthorityError('fleet-activation-control-issue-invalid');
  }
  return Number(raw);
}

export function fetchFleetActivationComments(issueNumber, {
  env = process.env,
  exec = execFileSync,
} = {}) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new FleetActivationAuthorityError('fleet-activation-control-issue-invalid');
  }
  const authEnv = resolveSourceActivationGithubAuthEnv(env);
  if (!authEnv) throw new FleetActivationAuthorityError('fleet-activation-github-auth-unavailable');
  let raw;
  try {
    raw = String(exec('gh', [
      'api',
      '--paginate',
      '--slurp',
      `/repos/${FLEET_ACTIVATION_REPOSITORY}/issues/${issueNumber}/comments?per_page=100`,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: authEnv,
      maxBuffer: 2 * 1024 * 1024,
    }) || '');
  } catch {
    throw new FleetActivationAuthorityError('fleet-activation-github-read-failed');
  }
  let decoded;
  try {
    decoded = JSON.parse(raw || '[]');
  } catch {
    throw new FleetActivationAuthorityError('fleet-activation-github-response-invalid');
  }
  const pages = Array.isArray(decoded) ? decoded : [];
  const comments = pages.flatMap((entry) => Array.isArray(entry) ? entry : [entry]);
  if (comments.length > 1000) throw new FleetActivationAuthorityError('fleet-activation-comment-bound-exceeded');
  return comments;
}

function markerComments(comments) {
  return comments
    .filter((comment) => String(comment?.body || '').includes(FLEET_ACTIVATION_AUTHORITY_MARKER))
    .sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
}

export function resolveFleetActivationAuthority({
  comments = [],
  env = process.env,
  controlIssue,
  requestedCommentId,
  currentSourceCommit,
  registry,
  instanceId,
  targetState,
  previousTransition = null,
} = {}) {
  const issueNumber = Number(controlIssue);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new FleetActivationAuthorityError('fleet-activation-control-issue-invalid');
  }
  const { approvers, invalid } = normalizeImplementationApprovers(env.CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS);
  if (invalid.length || approvers.length === 0) {
    throw new FleetActivationAuthorityError('fleet-activation-approver-policy-invalid');
  }
  if (!SHA.test(String(currentSourceCommit || '').toLowerCase())) {
    throw new FleetActivationAuthorityError('fleet-activation-source-head-invalid');
  }
  if (!registry || typeof registry !== 'object' || !DIGEST.test(String(registry.registryFingerprint || ''))) {
    throw new FleetActivationAuthorityError('fleet-activation-registry-invalid');
  }
  if (!Number.isSafeInteger(Number(registry.documentRevision)) || Number(registry.documentRevision) < 1) {
    throw new FleetActivationAuthorityError('fleet-activation-registry-revision-invalid');
  }

  const marked = markerComments(comments);
  if (previousTransition?.authorityCommentId) {
    const previous = marked.find((comment) => Number(comment.id) === Number(previousTransition.authorityCommentId));
    if (!previous) throw new FleetActivationAuthorityError('fleet-activation-previous-authority-missing');
    if (packetBodyDigest(String(previous.body || '')) !== previousTransition.authorityBodyDigest) {
      throw new FleetActivationAuthorityError('fleet-activation-previous-authority-edited');
    }
  }

  const requestedId = Number(requestedCommentId);
  if (!Number.isSafeInteger(requestedId) || requestedId < 1) {
    throw new FleetActivationAuthorityError('fleet-activation-authority-comment-id-invalid');
  }
  const comment = marked.find((entry) => Number(entry.id) === requestedId);
  if (!comment) throw new FleetActivationAuthorityError('fleet-activation-authority-comment-missing');
  const latest = marked.at(-1);
  if (!latest || Number(latest.id) !== requestedId) {
    throw new FleetActivationAuthorityError('fleet-activation-authority-not-latest');
  }

  const parsed = parseFleetActivationAuthority(comment);
  if (!approvers.includes(parsed.author)) {
    throw new FleetActivationAuthorityError('fleet-activation-author-unapproved');
  }
  if (parsed.targetIssue !== issueNumber) throw new FleetActivationAuthorityError('fleet-activation-authority-issue-mismatch');
  if (parsed.targetSourceCommit !== String(currentSourceCommit).toLowerCase()) {
    throw new FleetActivationAuthorityError('fleet-activation-authority-source-mismatch');
  }
  if (parsed.targetRegistryRevision !== Number(registry.documentRevision)) {
    throw new FleetActivationAuthorityError('fleet-activation-authority-registry-revision-mismatch');
  }
  if (parsed.targetRegistryFingerprint !== registry.registryFingerprint) {
    throw new FleetActivationAuthorityError('fleet-activation-authority-registry-fingerprint-mismatch');
  }
  if (parsed.targetInstanceId !== instanceId) throw new FleetActivationAuthorityError('fleet-activation-authority-instance-mismatch');
  if (parsed.targetState !== targetState) throw new FleetActivationAuthorityError('fleet-activation-authority-state-mismatch');

  const validated = Object.freeze({ ...parsed });
  VALIDATED.add(validated);
  return validated;
}

export function assertValidatedFleetActivationAuthority(authority) {
  if (!authority || !VALIDATED.has(authority)) {
    throw new FleetActivationAuthorityError('fleet-activation-authority-not-validated');
  }
  return authority;
}
