#!/usr/bin/env node

/**
 * #267 Part A: the bounded, deterministic transition that converts one
 * accepted queue-curation record plus validated manager state into exactly one
 * immutable worker authority -- see
 * docs/ops/AGENT-RUNNER-MANAGER-AUTHORITY-REVIEW.md.
 *
 * This module produces authority; it never consumes it, never selects its own
 * next task and never invokes a worker or a provider. It performs no GitHub
 * call, no filesystem access, no network access, no dispatch and no mutation of
 * any kind. It owns no scheduling: it embeds no timer, recurrence, sleep or
 * poll assumption, reads no clock and never emits a management event, so
 * `agent-runner-management-events.mjs` (#289) remains the single owner of the
 * durable ledger, dedupe, leases, delayed events and wake primitives.
 *
 * The authority identity itself is deliberately expressed through the already
 * accepted manager-preflight machinery in
 * `agent-runner-manager-authority.mjs`: the same revision/fingerprint shapes,
 * the same `managerAuthorityKey()` and the same packet marker, digest and
 * parser. No parallel authority format is introduced.
 */

import { isValidGitBranchName } from './agent-runner-dispatch-authority.mjs';
import {
  MANAGER_PREFLIGHT_BUILD_MANAGER_PRODUCER,
  MANAGER_PREFLIGHT_MARKER,
  MANAGER_PREFLIGHT_SCHEMA_VERSION,
  managerAuthorityKey,
  packetBodyDigest,
} from './agent-runner-manager-authority.mjs';
import { assertNormalizedManagerQueueCurationShape } from './agent-runner-manager-queue-curator.mjs';
import {
  assertBoundedSafeText,
  assertBoundedSafeTextArray,
  assertNoUnknownFields,
  contentFingerprint,
  freezeArray,
  isPlainObject,
  nonEmptyString,
} from './agent-runner-manager-planner-safety.mjs';

export const MANAGER_WORKER_AUTHORITY_SCHEMA_VERSION = 'agent-runner-manager-worker-authority/v1';

/**
 * The two authority domains are disjoint by construction. A producer mints
 * authority and can never consume it; a consumer consumes authority and can
 * never mint it. Every self-execution refusal in this module is a check that
 * one identity did not appear on both sides of that boundary.
 */
export const AUTHORITY_PRODUCER_DOMAIN = 'manager-authority-producer';
export const AUTHORITY_CONSUMER_DOMAIN = 'worker-authority-consumer';

/** The bounded outcomes an issuance attempt can report without throwing. */
export const AUTHORITY_ISSUE_OUTCOMES = Object.freeze(['issued', 'duplicate-no-op']);

/** Ledger states a previously issued authority may currently hold. */
export const AUTHORITY_LEDGER_STATES = Object.freeze(['issued', 'consumed', 'settled', 'revoked']);

/**
 * The only admission signal this transition accepts. Admission is quota
 * headroom and nothing else: there is deliberately no account-credit, balance,
 * dollar-cap or metered-fallback input anywhere in this contract, and a field
 * named after one is refused outright below.
 */
export const QUOTA_ADMISSION_STATES = Object.freeze(['available', 'unavailable', 'ambiguous']);

const AUTHORITY_EXECUTION_PHASE = 'implementation';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TOKEN_PATTERN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CURATION_KEY_PATTERN = /^qc:[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A *narrowing* of the accepted refname rules, not a replacement for them:
 * this bounds the length and restricts the character set, while
 * `isValidGitBranchName()` from the accepted dispatch-authority contract
 * remains the authority on refname validity. Both must pass, so an authority
 * can never bind a branch the accepted worker-dispatch path would later refuse
 * as `branch-authority-malformed`.
 */
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,119}$/;

const MAX_SCOPE_ENTRIES = 12;
const MAX_SCOPE_ENTRY = 300;
const MAX_STOP_CONDITIONS = 12;
const MAX_STOP_CONDITION = 200;
const MAX_VALIDATION_CHECKS = 20;
const MAX_VALIDATION_CHECK = 120;
const MAX_LEDGER_ENTRIES = 200;

const TOP_LEVEL_FIELDS = new Set(['curation', 'execution', 'request', 'currentSourceSha', 'producer', 'quotaAdmission', 'ledger']);
const EXECUTION_FIELDS = new Set(['adapter', 'capabilityProfile', 'model', 'effort']);
const REQUEST_FIELDS = new Set(['curationKey', 'branch', 'scope', 'stopConditions', 'requestedExecution', 'requestedValidationChecks']);
const PRODUCER_FIELDS = new Set(['type', 'domain', 'id']);
const QUOTA_FIELDS = new Set(['state', 'profileName']);
const LEDGER_FIELDS = new Set(['issued']);
const LEDGER_ENTRY_FIELDS = new Set(['authorityKey', 'authorityFingerprint', 'issueNumber', 'branch', 'baseSha', 'state']);
const CONSUMER_FIELDS = new Set(['domain', 'id']);

/**
 * Refused at any nesting depth in every input this module accepts. #256/#259
 * already require quota-only, credit-free admission; #267 additionally refuses
 * any per-attempt dollar cap. A historical packet may still *carry*
 * `max_budget_usd` for compatibility -- the accepted parser deliberately
 * ignores it -- but it can never enter an authority-issuance decision.
 */
const FORBIDDEN_FIELD_NAME_PATTERN = /^(?:account[-_]?credit|credit[-_]?balance|account[-_]?balance|balance|credits?|max[-_]?budget(?:[-_]?usd)?|budget[-_]?usd|budget|usd[-_]?cap|cost[-_]?cap|spend[-_]?cap|auto[-_]?top[-_]?up|flexible[-_]?credits?|paid[-_]?fallback|metered[-_]?fallback)$/i;

const VALIDATED_AUTHORITIES = new WeakSet();

function sortedStrings(values) {
  return [...values].sort();
}

function assertNoForbiddenFieldNamesRecursive(value, path, errors, depth = 0) {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFieldNamesRecursive(item, `${path}[${index}]`, errors, depth + 1));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_FIELD_NAME_PATTERN.test(key)) {
      errors.push(`${path}.${key} must not carry an account-credit, balance or dollar-cap field: subscription admission is quota headroom only`);
    }
    assertNoForbiddenFieldNamesRecursive(nested, `${path}.${key}`, errors, depth + 1);
  }
}

function validateProducer(producer, errors) {
  if (!isPlainObject(producer)) {
    errors.push('producer must be an object identifying the authority-issuing manager transition');
    return null;
  }
  assertNoUnknownFields(producer, PRODUCER_FIELDS, 'producer', errors);
  const { type, domain, id } = producer;
  if (type !== MANAGER_PREFLIGHT_BUILD_MANAGER_PRODUCER) {
    errors.push(`producer.type must be '${MANAGER_PREFLIGHT_BUILD_MANAGER_PRODUCER}'`);
  }
  // The single hard self-execution gate at issuance time: a caller running in
  // the worker consumption domain can never mint authority, for itself or for
  // anyone else.
  if (domain !== AUTHORITY_PRODUCER_DOMAIN) {
    errors.push(`producer.domain must be '${AUTHORITY_PRODUCER_DOMAIN}': a worker-domain caller may never mint worker authority`);
  }
  if (!nonEmptyString(id) || !IDENTITY_PATTERN.test(id)) {
    errors.push('producer.id must be a bounded machine-safe producer identity');
  }
  if (errors.length) return null;
  return Object.freeze({ type, domain, id });
}

function validateQuotaAdmission(quotaAdmission, profile, errors) {
  if (!isPlainObject(quotaAdmission)) {
    errors.push('quotaAdmission must be an object carrying the current quota-headroom admission state');
    return null;
  }
  assertNoUnknownFields(quotaAdmission, QUOTA_FIELDS, 'quotaAdmission', errors);
  const { state, profileName } = quotaAdmission;
  if (!QUOTA_ADMISSION_STATES.includes(state)) {
    errors.push(`quotaAdmission.state must be one of ${QUOTA_ADMISSION_STATES.join(', ')}`);
  } else if (state !== 'available') {
    // Unavailable *and* ambiguous headroom both fail closed: an authority is
    // only ever issued against positively proven headroom.
    errors.push(`quotaAdmission.state '${state}' does not admit a new worker authority: only positively available quota headroom does`);
  }
  if (!nonEmptyString(profileName) || !TOKEN_PATTERN.test(profileName)) {
    errors.push('quotaAdmission.profileName must be a bounded machine-safe quota profile name');
  } else if (profileName !== profile.validation.profile) {
    errors.push(`quotaAdmission.profileName '${profileName}' must equal the registered profile's approved validation profile '${profile.validation.profile}'`);
  }
  if (errors.length) return null;
  return Object.freeze({ state, profileName });
}

function validateExecution(execution, profile, errors) {
  if (!isPlainObject(execution)) {
    errors.push('execution must be an object naming the approved adapter, capability profile, model and effort');
    return null;
  }
  assertNoUnknownFields(execution, EXECUTION_FIELDS, 'execution', errors);
  const { adapter, capabilityProfile, model, effort } = execution;
  if (!nonEmptyString(adapter) || !TOKEN_PATTERN.test(adapter)) {
    errors.push('execution.adapter must be a bounded machine-safe adapter identifier');
  } else if (!profile.capabilities.allowlist.includes(adapter)) {
    errors.push(`execution.adapter '${adapter}' is not in the registered profile capability allowlist`);
  }
  if (capabilityProfile !== profile.validation.profile) {
    errors.push(`execution.capabilityProfile must equal the registered profile's approved validation profile '${profile.validation.profile}'`);
  }
  if (!nonEmptyString(model) || !TOKEN_PATTERN.test(model)) {
    errors.push('execution.model must be a bounded machine-safe model identifier');
  }
  if (!nonEmptyString(effort) || !TOKEN_PATTERN.test(effort)) {
    errors.push('execution.effort must be a bounded machine-safe effort identifier');
  }
  if (errors.length) return null;
  return Object.freeze({ adapter, capabilityProfile, model, effort });
}

/**
 * The worker-facing request may narrow the manager's approved execution
 * decision but can never widen it: an explicitly requested adapter, capability
 * profile, model or effort must match the approved one exactly.
 */
function validateRequestedExecution(requestedExecution, execution, errors) {
  if (requestedExecution === undefined || requestedExecution === null) return;
  if (!isPlainObject(requestedExecution)) {
    errors.push('request.requestedExecution must be an object when present');
    return;
  }
  assertNoUnknownFields(requestedExecution, EXECUTION_FIELDS, 'request.requestedExecution', errors);
  for (const field of EXECUTION_FIELDS) {
    const requested = requestedExecution[field];
    if (requested === undefined) continue;
    if (requested !== execution[field]) {
      errors.push(`request.requestedExecution.${field} '${requested}' may not widen or replace the approved '${execution[field]}'`);
    }
  }
}

/**
 * The validation contract may only be strengthened. Every check the registered
 * profile requires must survive into the authority; a request may add checks
 * but can never drop one.
 */
function validateValidationContract(requestedValidationChecks, profile, errors) {
  const required = profile.validation.requiredChecks;
  if (requestedValidationChecks === undefined || requestedValidationChecks === null) {
    return freezeArray(sortedStrings(required));
  }
  const additional = assertBoundedSafeTextArray(requestedValidationChecks, 'request.requestedValidationChecks', errors, {
    max: MAX_VALIDATION_CHECKS,
    itemMax: MAX_VALIDATION_CHECK,
    allowWriteActionScan: false,
  });
  if (!additional) return null;
  const missing = required.filter((check) => !additional.includes(check));
  if (missing.length) {
    errors.push(`request.requestedValidationChecks must not weaken the registered validation contract: ${missing.join(', ')} would be dropped`);
    return null;
  }
  return freezeArray(sortedStrings([...new Set([...required, ...additional])]));
}

function validateBranch(branch, profile, errors) {
  if (!nonEmptyString(branch) || !BRANCH_PATTERN.test(branch) || !isValidGitBranchName(branch)) {
    errors.push('request.branch must be one bounded, exact implementation branch name');
    return null;
  }
  // An implementation branch is never an integration branch: authority may not
  // target the project's default or otherwise approved shared branches.
  if (profile.branches.allowed.includes(branch) || branch === profile.branches.default) {
    errors.push(`request.branch '${branch}' is a shared integration branch of the registered project and can never be an implementation branch`);
    return null;
  }
  return branch;
}

/**
 * The already-issued authority ledger is required, not optional. An omitted
 * ledger would silently look identical to "nothing has ever been issued", so
 * a caller must state the ledger explicitly -- an empty `issued` array is the
 * way to assert that it checked and found nothing.
 */
function validateLedger(ledger, errors) {
  if (ledger === undefined || ledger === null) {
    errors.push('ledger is required: pass the already-issued authority records, or an explicit empty issued array');
    return null;
  }
  if (!isPlainObject(ledger)) {
    errors.push('ledger must be an object with an issued array');
    return null;
  }
  assertNoUnknownFields(ledger, LEDGER_FIELDS, 'ledger', errors);
  const { issued } = ledger;
  if (issued === undefined) {
    errors.push('ledger.issued is required and must be an array of previously issued authority records');
    return null;
  }
  if (!Array.isArray(issued) || issued.length > MAX_LEDGER_ENTRIES) {
    errors.push(`ledger.issued must be an array of at most ${MAX_LEDGER_ENTRIES} previously issued authority records`);
    return null;
  }
  const normalized = [];
  const seenKeys = new Set();
  issued.forEach((entry, index) => {
    const label = `ledger.issued[${index}]`;
    const before = errors.length;
    if (!isPlainObject(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    assertNoUnknownFields(entry, LEDGER_ENTRY_FIELDS, label, errors);
    const {
      authorityKey, authorityFingerprint, issueNumber, branch, baseSha, state,
    } = entry;
    if (!nonEmptyString(authorityKey) || !authorityKey.startsWith('manager-preflight:')) {
      errors.push(`${label}.authorityKey must be a canonical manager authority key`);
    } else if (seenKeys.has(authorityKey)) {
      errors.push(`${label}.authorityKey duplicates an already-listed ledger record`);
    }
    if (!nonEmptyString(authorityFingerprint) || !FINGERPRINT_PATTERN.test(authorityFingerprint)) {
      errors.push(`${label}.authorityFingerprint must be a sha256:<64 hex> fingerprint`);
    }
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) errors.push(`${label}.issueNumber must be a positive integer`);
    if (!nonEmptyString(branch) || !BRANCH_PATTERN.test(branch)) errors.push(`${label}.branch must be a bounded branch name`);
    if (!nonEmptyString(baseSha) || !SHA_PATTERN.test(baseSha)) errors.push(`${label}.baseSha must be an exact 40-character lowercase commit SHA`);
    if (!AUTHORITY_LEDGER_STATES.includes(state)) errors.push(`${label}.state must be one of ${AUTHORITY_LEDGER_STATES.join(', ')}`);
    if (errors.length === before) {
      seenKeys.add(authorityKey);
      normalized.push(Object.freeze({ authorityKey, authorityFingerprint, issueNumber, branch, baseSha, state }));
    }
  });
  if (errors.length) return null;
  return freezeArray(normalized);
}

/**
 * Locate the one curated record the request names and prove it is a real,
 * ready, unprotected issue in this exact curation. Every ownership collision
 * the curator already detected (active implementation lease, recovery
 * ownership, an open pull request, an in-progress or done label) surfaces here
 * as a fail-closed refusal rather than a silently replaced owner.
 */
function resolveCuratedRecord(curation, curationKey, errors) {
  const record = curation.records.find((candidate) => candidate.curationKey === curationKey) ?? null;
  if (!record) {
    errors.push(`request.curationKey '${curationKey}' does not name a record in this curation`);
    return null;
  }
  if (record.classification !== 'present' || record.issueNumber === null) {
    errors.push(`curated record '${curationKey}' is '${record.classification}' and carries no open issue to authorise`);
    return null;
  }
  if (record.readiness !== 'ready') {
    errors.push(`curated record '${curationKey}' is '${record.readiness}': only a ready record may be authorised for implementation`);
    return null;
  }
  if (record.protection !== null) {
    errors.push(`curated record '${curationKey}' is already owned ('${record.protection}'): existing implementation, recovery or pull-request ownership can never be silently replaced`);
    return null;
  }
  return record;
}

/**
 * The one-global-implementation-slot invariant, evaluated against the same
 * bounded ownership evidence the curation was built from. Any active
 * implementation lease anywhere -- on this issue or another -- blocks a fresh
 * authority, and a recovery lease on the target issue blocks it outright.
 */
function assertImplementationSlotAvailable(curation, issueNumber, errors) {
  const ownership = curation.queueEvidence.ownership;
  for (const lease of ownership.activeLeases) {
    if (lease.kind === 'implementation') {
      errors.push(`the one-global-implementation-slot invariant refuses a new authority: issue #${lease.issueNumber} already holds the active implementation lease`);
    }
    if (lease.kind === 'recovery' && lease.issueNumber === issueNumber) {
      errors.push(`issue #${issueNumber} is recovery-owned: recovery-owned work can never be taken by a fresh worker authority`);
    }
  }
  const inProgressLabel = curation.queueEvidence.proposal.brief.evidence.profile.labels.inProgress ?? null;
  if (inProgressLabel) {
    for (const issue of curation.queueEvidence.issues) {
      if (issue.state === 'open' && issue.labels.includes(inProgressLabel)) {
        errors.push(`the one-global-implementation-slot invariant refuses a new authority: issue #${issue.number} already carries the in-progress label`);
      }
    }
  }
  for (const pull of ownership.openPullRequests) {
    if (pull.issueNumber === issueNumber) {
      errors.push(`issue #${issueNumber} already owns open pull request #${pull.number}: a fresh authority can never silently replace an existing pull request`);
    }
  }
}

/**
 * Reconcile the computed authority against everything already issued. An exact
 * duplicate is an idempotent no-op rather than a second grant of ownership; a
 * consumed, settled or revoked record fails closed; and a different authority
 * for the same issue is a conflict, never a second concurrent owner.
 */
function reconcileLedger(ledgerEntries, candidate, errors) {
  let duplicate = null;
  for (const entry of ledgerEntries) {
    if (entry.authorityFingerprint === candidate.authorityFingerprint) {
      if (entry.state === 'issued') {
        duplicate = entry;
        continue;
      }
      errors.push(`authority ${candidate.authorityKey} is already '${entry.state}' and can never be re-issued: an immutable authority is consumed exactly once`);
      continue;
    }
    if (entry.issueNumber === candidate.issueNumber && (entry.state === 'issued' || entry.state === 'consumed')) {
      errors.push(`issue #${candidate.issueNumber} already has an active authority (${entry.authorityKey}) with a different fingerprint: one issue can never have two concurrent implementation owners`);
    }
  }
  return duplicate;
}

/**
 * Convert one accepted queue-curation record and validated manager state into
 * exactly one immutable worker authority.
 *
 * Returns `{ outcome, authority, duplicateOf }`. `outcome` is `'issued'` for a
 * fresh grant and `'duplicate-no-op'` when the identical authority was already
 * issued and is still unconsumed -- replaying identical input never creates a
 * second grant of implementation ownership. Every other ambiguity throws:
 * this transition fails closed rather than issuing a weaker authority.
 *
 * It returns data. It does not run, schedule, dispatch or consume anything.
 */
export function issueManagerWorkerAuthority(input) {
  if (!isPlainObject(input)) {
    throw new Error('Invalid agent runner manager worker authority: input must be an object');
  }
  const errors = [];
  assertNoUnknownFields(input, TOP_LEVEL_FIELDS, 'input', errors);
  // Run before every other check so a forbidden admission field cannot hide in
  // a nested object that would otherwise be accepted.
  assertNoForbiddenFieldNamesRecursive(input.execution, 'execution', errors);
  assertNoForbiddenFieldNamesRecursive(input.request, 'request', errors);
  assertNoForbiddenFieldNamesRecursive(input.quotaAdmission, 'quotaAdmission', errors);
  assertNoForbiddenFieldNamesRecursive(input.producer, 'producer', errors);
  if (errors.length) throw new Error(`Invalid agent runner manager worker authority: ${errors.join('; ')}`);

  const { curation, execution, request, currentSourceSha, producer, quotaAdmission, ledger } = input;
  assertNormalizedManagerQueueCurationShape(curation);
  const profile = curation.queueEvidence.proposal.brief.evidence.profile;

  if (!isPlainObject(request)) {
    throw new Error('Invalid agent runner manager worker authority: request must be an object');
  }
  assertNoUnknownFields(request, REQUEST_FIELDS, 'request', errors);

  const normalizedProducer = validateProducer(producer, errors);
  const normalizedQuota = validateQuotaAdmission(quotaAdmission, profile, errors);
  const normalizedExecution = validateExecution(execution, profile, errors);
  if (normalizedExecution) validateRequestedExecution(request.requestedExecution, normalizedExecution, errors);
  const validationChecks = validateValidationContract(request.requestedValidationChecks, profile, errors);
  const branch = validateBranch(request.branch, profile, errors);
  const ledgerEntries = validateLedger(ledger, errors);

  if (!nonEmptyString(request.curationKey) || !CURATION_KEY_PATTERN.test(request.curationKey)) {
    errors.push('request.curationKey must be a bounded "qc:<projectId>:<proposedIssueId>" key');
  }
  const scope = assertBoundedSafeTextArray(request.scope, 'request.scope', errors, {
    max: MAX_SCOPE_ENTRIES,
    itemMax: MAX_SCOPE_ENTRY,
    minLength: 1,
  });
  const stopConditions = assertBoundedSafeTextArray(request.stopConditions, 'request.stopConditions', errors, {
    max: MAX_STOP_CONDITIONS,
    itemMax: MAX_STOP_CONDITION,
    allowWriteActionScan: false,
    minLength: 1,
  });

  // The authority binds the exact accepted base the curation was computed
  // from. A base that has moved underneath the curation is stale by
  // definition, and a stale authority is never issued.
  if (!nonEmptyString(currentSourceSha) || !SHA_PATTERN.test(currentSourceSha)) {
    errors.push('currentSourceSha must be an exact 40-character lowercase commit SHA');
  } else if (currentSourceSha !== curation.sourceSha) {
    errors.push(`currentSourceSha '${currentSourceSha}' no longer matches the accepted base '${curation.sourceSha}' this curation was computed from`);
  }

  if (errors.length) throw new Error(`Invalid agent runner manager worker authority: ${errors.join('; ')}`);

  const record = resolveCuratedRecord(curation, request.curationKey, errors);
  if (errors.length) throw new Error(`Invalid agent runner manager worker authority: ${errors.join('; ')}`);

  assertImplementationSlotAvailable(curation, record.issueNumber, errors);
  if (errors.length) throw new Error(`Invalid agent runner manager worker authority: ${errors.join('; ')}`);

  const identityPayload = Object.freeze({
    schemaVersion: MANAGER_WORKER_AUTHORITY_SCHEMA_VERSION,
    projectId: curation.projectId,
    repository: curation.repository,
    issueNumber: record.issueNumber,
    baseSha: curation.sourceSha,
    branch,
    adapter: normalizedExecution.adapter,
    capabilityProfile: normalizedExecution.capabilityProfile,
    model: normalizedExecution.model,
    effort: normalizedExecution.effort,
    curationKey: record.curationKey,
    curationRevision: curation.curationRevision,
    curationFingerprint: curation.curationFingerprint,
    producer: normalizedProducer,
    consumptionDomain: AUTHORITY_CONSUMER_DOMAIN,
  });
  // Deterministic and clock-free: identical inputs always produce an identical
  // revision, so a replay can never masquerade as a fresh authorisation.
  const authorityRevision = `mwa:${contentFingerprint(identityPayload).slice('sha256:'.length, 'sha256:'.length + 32)}`;

  const fingerprintPayload = Object.freeze({
    ...identityPayload,
    authorityRevision,
    executionPhase: AUTHORITY_EXECUTION_PHASE,
    quotaAdmission: normalizedQuota,
    validation: Object.freeze({ profile: profile.validation.profile, requiredChecks: validationChecks }),
    scope,
    stopConditions,
  });
  const authorityFingerprint = contentFingerprint(fingerprintPayload);
  const authorityKey = managerAuthorityKey(authorityRevision, authorityFingerprint);

  const duplicate = reconcileLedger(ledgerEntries, { authorityFingerprint, authorityKey, issueNumber: record.issueNumber }, errors);
  if (errors.length) throw new Error(`Invalid agent runner manager worker authority: ${errors.join('; ')}`);

  const authority = Object.freeze({ ...fingerprintPayload, authorityFingerprint, authorityKey });
  VALIDATED_AUTHORITIES.add(authority);
  return Object.freeze({
    outcome: duplicate ? 'duplicate-no-op' : 'issued',
    authority,
    duplicateOf: duplicate ? duplicate.authorityKey : null,
  });
}

/**
 * Refuse anything that merely *looks* like an issued authority: provenance is
 * checked against a `WeakSet` populated only by
 * `issueManagerWorkerAuthority()` itself, which a hand-built look-alike object
 * cannot forge.
 */
export function assertNormalizedWorkerAuthorityShape(authority) {
  if (!isPlainObject(authority) || !Object.isFrozen(authority) || !VALIDATED_AUTHORITIES.has(authority)) {
    throw new Error('requires an already-issued worker authority: object was not produced by issueManagerWorkerAuthority');
  }
}

/**
 * The consumption-side half of the authority-domain boundary. A worker proves
 * it is a consumer, distinct from the producer that minted the authority, and
 * that the authority has not already been consumed. This returns a bounded
 * decision only: it starts nothing.
 *
 * A provider process can therefore never mint authority for itself, and the
 * producer that minted an authority can never consume it.
 */
export function authorizeWorkerAuthorityConsumption({ authority, consumer, ledger } = {}) {
  assertNormalizedWorkerAuthorityShape(authority);
  const errors = [];
  if (!isPlainObject(consumer)) {
    throw new Error('Invalid agent runner worker authority consumption: consumer must be an object');
  }
  assertNoUnknownFields(consumer, CONSUMER_FIELDS, 'consumer', errors);
  const { domain, id } = consumer;
  if (domain !== AUTHORITY_CONSUMER_DOMAIN) {
    errors.push(`consumer.domain must be '${AUTHORITY_CONSUMER_DOMAIN}': authority is consumed only in the worker domain`);
  }
  if (!nonEmptyString(id) || !IDENTITY_PATTERN.test(id)) {
    errors.push('consumer.id must be a bounded machine-safe consumer identity');
  }
  if (nonEmptyString(id) && id === authority.producer.id) {
    errors.push('self-execution refused: the identity that produced this authority can never consume it');
  }
  const ledgerEntries = validateLedger(ledger, errors);
  if (errors.length) throw new Error(`Invalid agent runner worker authority consumption: ${errors.join('; ')}`);

  const entry = ledgerEntries.find((candidate) => candidate.authorityFingerprint === authority.authorityFingerprint) ?? null;
  if (entry && entry.state !== 'issued') {
    throw new Error(`Invalid agent runner worker authority consumption: authority ${authority.authorityKey} is already '${entry.state}' and can never be consumed again`);
  }
  return Object.freeze({
    allowed: true,
    authorityKey: authority.authorityKey,
    authorityFingerprint: authority.authorityFingerprint,
    consumer: Object.freeze({ domain, id }),
  });
}

function yamlList(values, indent = '  ') {
  return values.map((value) => `${indent}- ${JSON.stringify(value)}`).join('\n');
}

/**
 * Serialize one issued authority as a canonical manager-preflight packet body.
 * The output is deliberately parseable by the already accepted
 * `parseManagerPreflightPacket()`: the same marker, the same
 * `schema_version`/`revision`/`fingerprint`/`producer_type` identity and the
 * same `scope`/`required_validation`/`stop_conditions` lists, with the exact
 * repository, issue, base commit, branch and capability binding added
 * alongside rather than in a parallel format.
 *
 * The body carries only bounded, already-validated identity material: no
 * prompt, no provider output, no credential, no local path, no command line
 * and no monetary field.
 */
export function renderManagerWorkerAuthorityPacket(authority) {
  assertNormalizedWorkerAuthorityShape(authority);
  return [
    MANAGER_PREFLIGHT_MARKER,
    '',
    '## Manager preflight packet',
    '',
    '```yaml',
    `schema_version: ${MANAGER_PREFLIGHT_SCHEMA_VERSION}`,
    `revision: ${authority.authorityRevision}`,
    `fingerprint: ${authority.authorityFingerprint}`,
    `producer_type: ${authority.producer.type}`,
    `producer_id: ${authority.producer.id}`,
    `consumption_domain: ${authority.consumptionDomain}`,
    `approved_agent: ${authority.adapter}`,
    `execution_phase: ${authority.executionPhase}`,
    `project_id: ${authority.projectId}`,
    // A canonical *list* with exactly one entry, not a scalar: the accepted
    // `resolveDispatchAuthority()` reads this key through `canonicalList()` and
    // requires exactly one item, so a scalar would parse as a valid
    // manager-preflight shape and then fail dispatch as
    // `repository-scope-missing`.
    'approved_repository_scope:',
    yamlList([authority.repository.full]),
    `issue: ${authority.issueNumber}`,
    `base_commit: ${authority.baseSha}`,
    `approved_branch: ${authority.branch}`,
    `profile: ${authority.capabilityProfile}`,
    `model: ${authority.model}`,
    `effort: ${authority.effort}`,
    `curation_key: ${authority.curationKey}`,
    `curation_fingerprint: ${authority.curationFingerprint}`,
    'scope:',
    yamlList(authority.scope),
    'required_validation:',
    yamlList(authority.validation.requiredChecks),
    'stop_conditions:',
    yamlList(authority.stopConditions),
    '```',
    '',
  ].join('\n');
}

/**
 * The immutability evidence for one published authority: the packet body
 * digest computed by the already accepted `packetBodyDigest()`. Any edit to a
 * published packet changes this digest, so a mutated authority can never be
 * mistaken for the one that was issued.
 */
export function workerAuthorityPacketDigest(authority) {
  return packetBodyDigest(renderManagerWorkerAuthorityPacket(authority));
}
