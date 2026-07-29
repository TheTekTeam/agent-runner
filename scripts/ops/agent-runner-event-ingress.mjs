import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { projectFromRegistryByRepository } from './agent-runner-project-registry.mjs';

export const EVENT_INGRESS_SCHEMA_VERSION = 1;
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

export const DEFAULT_GITHUB_EVENT_ACTIONS = Object.freeze({
  issues: Object.freeze([
    'opened', 'edited', 'labeled', 'unlabeled', 'assigned', 'unassigned',
    'milestoned', 'demilestoned', 'closed', 'reopened', 'transferred',
  ]),
  issue_comment: Object.freeze(['created', 'edited', 'deleted']),
  pull_request: Object.freeze([
    'opened', 'edited', 'synchronize', 'ready_for_review', 'converted_to_draft',
    'closed', 'reopened', 'labeled', 'unlabeled', 'assigned', 'unassigned',
    'review_requested', 'review_request_removed',
  ]),
  pull_request_review: Object.freeze(['submitted', 'edited', 'dismissed']),
  pull_request_review_comment: Object.freeze(['created', 'edited', 'deleted']),
  pull_request_review_thread: Object.freeze(['resolved', 'unresolved']),
  check_run: Object.freeze(['created', 'rerequested', 'completed', 'requested_action']),
  check_suite: Object.freeze(['requested', 'rerequested', 'completed']),
  workflow_run: Object.freeze(['requested', 'in_progress', 'completed']),
  workflow_job: Object.freeze(['queued', 'in_progress', 'completed']),
  merge_group: Object.freeze(['checks_requested', 'destroyed']),
  ping: Object.freeze([null]),
  push: Object.freeze([null]),
  status: Object.freeze([null]),
  create: Object.freeze([null]),
  delete: Object.freeze([null]),
});

const DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const DELIVERY_STATES = Object.freeze(['pending', 'batched', 'processed', 'failed']);

export class GitHubWebhookIngressError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'GitHubWebhookIngressError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function rawBodyBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  throw new GitHubWebhookIngressError('invalid-body', 'GitHub webhook body must be a Buffer or string', 400);
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    return value == null ? null : String(value);
  }
  return null;
}

function boundedString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

function boundedInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizedSha(value) {
  return typeof value === 'string' && SHA_PATTERN.test(value) ? value.toLowerCase() : null;
}

function eventActionAllowed(eventName, action) {
  const allowedActions = DEFAULT_GITHUB_EVENT_ACTIONS[eventName];
  return Boolean(allowedActions && allowedActions.includes(action));
}

function pullRequestNumber(payload) {
  return boundedInteger(
    payload?.pull_request?.number
      ?? (payload?.issue?.pull_request ? payload.issue.number : null)
      ?? payload?.check_run?.pull_requests?.[0]?.number
      ?? payload?.check_suite?.pull_requests?.[0]?.number
      ?? payload?.workflow_run?.pull_requests?.[0]?.number
      ?? payload?.workflow_job?.pull_requests?.[0]?.number,
  );
}

function issueNumber(payload) {
  return boundedInteger(payload?.issue?.number);
}

function headSha(payload) {
  return normalizedSha(
    payload?.pull_request?.head?.sha
      ?? payload?.check_run?.head_sha
      ?? payload?.check_suite?.head_sha
      ?? payload?.workflow_run?.head_sha
      ?? payload?.workflow_job?.head_sha
      ?? payload?.merge_group?.head_sha
      ?? payload?.sha
      ?? payload?.after,
  );
}

function baseSha(payload) {
  return normalizedSha(payload?.pull_request?.base?.sha ?? payload?.merge_group?.base_sha ?? payload?.before);
}

function mergeSha(payload) {
  if (payload?.pull_request?.merged !== true) return null;
  return normalizedSha(payload.pull_request.merge_commit_sha);
}

export function verifyGitHubWebhookSignature({ rawBody, signature, secret }) {
  const body = rawBodyBuffer(rawBody);
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new GitHubWebhookIngressError('invalid-secret', 'GitHub webhook secret is missing or too short', 500);
  }
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature || '');
  if (!match) return false;
  const supplied = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function normalizeGitHubWebhookDelivery({
  deliveryId,
  eventName,
  payload,
  rawBody,
  registry,
  receivedAt = new Date().toISOString(),
}) {
  if (!DELIVERY_ID_PATTERN.test(deliveryId || '')) {
    throw new GitHubWebhookIngressError('invalid-delivery-id', 'GitHub delivery ID is missing or invalid', 400);
  }
  if (!EVENT_NAME_PATTERN.test(eventName || '')) {
    throw new GitHubWebhookIngressError('invalid-event-name', 'GitHub event name is missing or invalid', 400);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new GitHubWebhookIngressError('invalid-payload', 'GitHub webhook payload must be an object', 400);
  }

  const repository = boundedString(payload?.repository?.full_name, 255);
  const project = repository ? projectFromRegistryByRepository(registry, repository) : null;
  if (!repository && eventName !== 'ping') {
    throw new GitHubWebhookIngressError('missing-repository', 'GitHub webhook repository is missing', 400);
  }
  if (repository && !project) {
    throw new GitHubWebhookIngressError('unknown-repository', 'GitHub webhook repository is not enabled', 404);
  }

  const action = boundedString(payload.action, 64);
  if (!eventActionAllowed(eventName, action)) {
    throw new GitHubWebhookIngressError('unsupported-event', 'GitHub event/action is not allowlisted', 422);
  }

  const body = rawBodyBuffer(rawBody);
  return Object.freeze({
    schemaVersion: 1,
    deliveryId,
    receivedAt,
    projectId: project?.projectId ?? null,
    repository: project?.githubRepo ?? null,
    eventName,
    action,
    issueNumber: issueNumber(payload),
    pullRequestNumber: pullRequestNumber(payload),
    headSha: eventName === 'push' ? null : headSha(payload),
    baseSha: baseSha(payload),
    mergeSha: mergeSha(payload),
    beforeSha: normalizedSha(payload?.before),
    afterSha: normalizedSha(payload?.after),
    defaultBranch: boundedString(payload?.repository?.default_branch, 255),
    ref: boundedString(payload?.ref, 512),
    refType: boundedString(payload?.ref_type, 64),
    merged: payload?.pull_request?.merged === true,
    payloadSha256: createHash('sha256').update(body).digest('hex'),
  });
}

export class EventIngressStore {
  constructor(dbPath, { now = () => new Date().toISOString() } = {}) {
    if (typeof dbPath !== 'string' || dbPath.length === 0) throw new Error('event ingress db path is required');
    this.dbPath = dbPath;
    this.now = now;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS event_ingress_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL,
        project_id TEXT,
        repo TEXT,
        event_name TEXT NOT NULL,
        action TEXT,
        issue_number INTEGER,
        pull_request_number INTEGER,
        head_sha TEXT,
        base_sha TEXT,
        merge_sha TEXT,
        payload_sha256 TEXT NOT NULL,
        processing_state TEXT NOT NULL CHECK (processing_state IN ('pending', 'batched', 'processed', 'failed')),
        updated_at TEXT NOT NULL,
        event_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_idx
        ON webhook_deliveries(processing_state, received_at, delivery_id);
    `);
    this.db.prepare(`
      INSERT OR IGNORE INTO event_ingress_schema(version, applied_at)
      VALUES (?, ?)
    `).run(EVENT_INGRESS_SCHEMA_VERSION, this.now());
  }

  recordDelivery(envelope) {
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO webhook_deliveries(
        delivery_id, received_at, project_id, repo, event_name, action,
        issue_number, pull_request_number, head_sha, base_sha, merge_sha,
        payload_sha256, processing_state, updated_at, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    const result = statement.run(
      envelope.deliveryId,
      envelope.receivedAt,
      envelope.projectId,
      envelope.repository,
      envelope.eventName,
      envelope.action,
      envelope.issueNumber,
      envelope.pullRequestNumber,
      envelope.headSha,
      envelope.baseSha,
      envelope.mergeSha,
      envelope.payloadSha256,
      this.now(),
      JSON.stringify(envelope),
    );
    const inserted = Number(result.changes) === 1;
    const delivery = this.getDelivery(envelope.deliveryId);
    if (!inserted && (
      delivery.payloadSha256 !== envelope.payloadSha256
      || (delivery.repository ?? '').toLowerCase() !== (envelope.repository ?? '').toLowerCase()
      || delivery.eventName !== envelope.eventName
    )) {
      throw new GitHubWebhookIngressError(
        'delivery-id-collision',
        'GitHub delivery ID was already recorded with different bounded evidence',
        409,
      );
    }
    return { inserted, delivery };
  }

  getDelivery(deliveryId) {
    const row = this.db.prepare(`
      SELECT delivery_id, received_at, project_id, repo, event_name, action,
             issue_number, pull_request_number, head_sha, base_sha, merge_sha,
             payload_sha256, processing_state, updated_at, event_json
      FROM webhook_deliveries
      WHERE delivery_id = ?
    `).get(deliveryId);
    if (!row) return null;
    return {
      deliveryId: row.delivery_id,
      receivedAt: row.received_at,
      projectId: row.project_id,
      repository: row.repo,
      eventName: row.event_name,
      action: row.action,
      issueNumber: row.issue_number,
      pullRequestNumber: row.pull_request_number,
      headSha: row.head_sha,
      baseSha: row.base_sha,
      mergeSha: row.merge_sha,
      payloadSha256: row.payload_sha256,
      processingState: row.processing_state,
      updatedAt: row.updated_at,
      event: JSON.parse(row.event_json),
    };
  }

  listPending({ limit = 50 } = {}) {
    const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
    return this.db.prepare(`
      SELECT delivery_id
      FROM webhook_deliveries
      WHERE processing_state = 'pending'
      ORDER BY received_at ASC, delivery_id ASC
      LIMIT ?
    `).all(boundedLimit).map((row) => this.getDelivery(row.delivery_id));
  }

  setDeliveryState(deliveryId, processingState) {
    if (!DELIVERY_STATES.includes(processingState)) throw new Error(`invalid delivery state: ${processingState}`);
    const result = this.db.prepare(`
      UPDATE webhook_deliveries
      SET processing_state = ?, updated_at = ?
      WHERE delivery_id = ?
    `).run(processingState, this.now(), deliveryId);
    return Number(result.changes) === 1;
  }

  close() {
    this.db.close();
  }
}

export function acceptGitHubWebhook({
  rawBody,
  headers,
  secret,
  registry,
  store,
  maxBodyBytes = DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  receivedAt = new Date().toISOString(),
}) {
  const body = rawBodyBuffer(rawBody);
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) {
    throw new GitHubWebhookIngressError('invalid-size-limit', 'GitHub webhook size limit is invalid', 500);
  }
  if (body.length > maxBodyBytes) {
    throw new GitHubWebhookIngressError('payload-too-large', 'GitHub webhook payload exceeds the configured limit', 413);
  }

  const signature = headerValue(headers, 'x-hub-signature-256');
  if (!verifyGitHubWebhookSignature({ rawBody: body, signature, secret })) {
    throw new GitHubWebhookIngressError('invalid-signature', 'GitHub webhook signature is invalid', 401);
  }

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw new GitHubWebhookIngressError('invalid-json', 'GitHub webhook payload is not valid JSON', 400);
  }

  const envelope = normalizeGitHubWebhookDelivery({
    deliveryId: headerValue(headers, 'x-github-delivery'),
    eventName: headerValue(headers, 'x-github-event'),
    payload,
    rawBody: body,
    registry,
    receivedAt,
  });
  const result = store.recordDelivery(envelope);
  return Object.freeze({
    status: result.inserted ? 'accepted' : 'duplicate',
    envelope,
  });
}
