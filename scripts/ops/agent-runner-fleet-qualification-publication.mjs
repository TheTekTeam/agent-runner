import { createHash } from 'node:crypto';

import { evaluateFleetAdapterEvidence } from './agent-runner-fleet-provisioning.mjs';
import {
  CLAUDE_WORKER_QUALIFICATION_CONTRACT_FINGERPRINT,
} from './agent-runner-claude-worker-qualification.mjs';
import {
  CODEX_WORKER_QUALIFICATION_CONTRACT_FINGERPRINT,
} from './agent-runner-codex-worker-qualification.mjs';

// #401 FLEET.QUALIFICATION.PUBLICATION.1
//
// This module publishes only truthful, independently accepted `agent@node`
// qualification evidence into a canonical, deterministic fleet qualification
// registry projection for the #327/#328 readiness contract. It never enables
// normal multi-node routing: every published instance is emitted explicitly
// non-routable. Qualification state is recorded independently from lifecycle.
//
// Reconciliation fails closed. An instance is published only when a GitHub-owned
// accepted qualification result is supplied whose bounded revision matches the
// pinned per-instance revision below. Dell Claude/Codex have no repository- or
// GitHub-owned exact per-instance qualification revision available to this
// implementation, so they are published as explicit bounded evidence gaps
// rather than an invented revision.

export const FLEET_QUALIFICATION_PUBLICATION_SCHEMA_VERSION = 1;
export const FLEET_QUALIFICATION_PUBLICATION_REVISION = 'fleet-qualification-publication-v1';

const REVISION_TOKEN = /^[a-z][a-z0-9-]{2,64}-[a-f0-9]{16}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

// Key/value denylist for defence-in-depth serialization safety. Published
// records are built from an explicit identity whitelist, so this guard should
// never fire on our own output; it exists to reject tainted inputs.
const FORBIDDEN_KEY_SUBSTRINGS = Object.freeze([
  'password', 'passphrase', 'secret', 'credential', 'apikey', 'api_key',
  'accesskey', 'token', 'cookie', 'bearer', 'prompt', 'sessionid', 'session_id',
  'balance', 'accountcredit', 'credit', 'remainingpercent', 'usedpercent',
  'environment', 'environ', 'homedir',
]);
const FORBIDDEN_VALUE = /sk-ant-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}/;

export const FLEET_QUALIFICATION_TARGET_INSTANCES = Object.freeze([
  Object.freeze({
    instanceId: 'claude-code-cli@dev-cluster-dell',
    nodeId: 'dev-cluster-dell',
    adapterId: 'claude-code-cli',
    pinnedRevision: null,
    contractFingerprint: null,
    evidenceGapReason: 'dell-claude-per-instance-qualification-revision-stale-or-ambiguous',
  }),
  Object.freeze({
    instanceId: 'claude-code-cli@dev-cluster-z790',
    nodeId: 'dev-cluster-z790',
    adapterId: 'claude-code-cli',
    pinnedRevision: 'claude-z790-7e13ce3be223baf8',
    contractFingerprint: CLAUDE_WORKER_QUALIFICATION_CONTRACT_FINGERPRINT,
    evidenceGapReason: null,
  }),
  Object.freeze({
    instanceId: 'codex-cli@dev-cluster-dell',
    nodeId: 'dev-cluster-dell',
    adapterId: 'codex-cli',
    pinnedRevision: null,
    contractFingerprint: null,
    evidenceGapReason: 'dell-codex-per-instance-qualification-revision-not-github-owned',
  }),
  Object.freeze({
    instanceId: 'codex-cli@dev-cluster-z790',
    nodeId: 'dev-cluster-z790',
    adapterId: 'codex-cli',
    pinnedRevision: 'codex-z790-58e9d9edf45669ac',
    contractFingerprint: CODEX_WORKER_QUALIFICATION_CONTRACT_FINGERPRINT,
    evidenceGapReason: null,
  }),
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}

export function assertNoSecretFields(value, path = 'publication') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretFields(entry, `${path}[${index}]`));
    return value;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const lower = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
      for (const needle of FORBIDDEN_KEY_SUBSTRINGS) {
        if (lower.includes(needle)) {
          throw new Error(`forbidden field in fleet qualification publication: ${path}.${key}`);
        }
      }
      assertNoSecretFields(child, `${path}.${key}`);
    }
    return value;
  }
  if (typeof value === 'string' && FORBIDDEN_VALUE.test(value)) {
    throw new Error(`forbidden value in fleet qualification publication: ${path}`);
  }
  return value;
}

function publishedIdentity(adapterId, evidence) {
  if (!evidence || typeof evidence !== 'object') throw new Error('qualification evidence is required');
  if (adapterId === 'claude-code-cli') {
    return {
      installedVersion: String(evidence.claudeVersion || ''),
      authPostureClass: 'first-party-claude-subscription',
      providerAccountClass: String(evidence.providerClass || ''),
      model: String(evidence.model || ''),
      profile: String(evidence.profile || ''),
      effort: String(evidence.effort || ''),
      permissionMode: String(evidence.permissionMode || ''),
      capabilityFingerprint: String(evidence.toolPolicyFingerprint || ''),
    };
  }
  if (adapterId === 'codex-cli') {
    return {
      installedVersion: String(evidence.codexVersion || '').replace(/^codex-cli /, ''),
      authPostureClass: 'first-party-chatgpt-oauth',
      providerAccountClass: 'chatgpt',
      model: String(evidence.model || ''),
      profile: String(evidence.profile || ''),
      effort: String(evidence.effort || ''),
      permissionMode: `sandbox:${evidence.sandboxMode || ''};approval:${evidence.approvalMode || ''}`,
      capabilityFingerprint: digest({
        sandboxMode: String(evidence.sandboxMode || ''),
        approvalMode: String(evidence.approvalMode || ''),
        networkAccess: evidence.networkAccess === true,
      }),
    };
  }
  throw new Error(`unsupported fleet qualification adapter: ${adapterId}`);
}

// Reconcile one supplied accepted qualification result against a pinned target.
// Returns a discriminated result rather than throwing so the projection stays
// deterministic even when evidence is stale, mismatched or absent.
export function reconcileAcceptedQualification(target, acceptedResult) {
  if (!target || target.pinnedRevision === null) {
    return { ok: false, reason: 'target-has-no-github-owned-pinned-revision' };
  }
  if (!REVISION_TOKEN.test(target.pinnedRevision)) return { ok: false, reason: 'pinned-revision-malformed' };
  if (!acceptedResult || typeof acceptedResult !== 'object') {
    return { ok: false, reason: 'accepted-qualification-result-not-supplied' };
  }
  if (acceptedResult.accepted !== true) return { ok: false, reason: 'result-not-accepted' };
  if (acceptedResult.qualified !== true) return { ok: false, reason: 'result-not-qualified' };
  if (acceptedResult.agentInstanceId !== target.instanceId) return { ok: false, reason: 'instance-identity-mismatch' };
  if (acceptedResult.nodeId !== target.nodeId) return { ok: false, reason: 'node-identity-mismatch' };
  if (target.instanceId !== `${target.adapterId}@${target.nodeId}`) return { ok: false, reason: 'target-instance-shape-invalid' };
  if (!target.instanceId.endsWith(`@${acceptedResult.nodeId}`)) return { ok: false, reason: 'per-node-isolation-violation' };
  if (acceptedResult.qualificationRevision !== target.pinnedRevision) {
    return { ok: false, reason: 'qualification-revision-stale-or-mismatched' };
  }
  if (!DIGEST.test(String(acceptedResult.resultFingerprint || ''))) {
    return { ok: false, reason: 'result-fingerprint-invalid' };
  }
  return { ok: true, reason: 'accepted-qualification-reconciled', acceptedResult };
}

function nonRoutablePublishedInstance(target, acceptedResult) {
  const identity = publishedIdentity(target.adapterId, acceptedResult.evidence);
  // Route the whitelisted identity through the canonical fleet evidence
  // evaluator: this both token-validates every field and records the
  // provisioning state truthfully (e.g. codex remains `authenticated`, not
  // `qualified`, because its live adapter is not qualification-eligible).
  const evaluated = evaluateFleetAdapterEvidence({
    nodeId: target.nodeId,
    adapterId: target.adapterId,
    evidence: {
      // `enabled` here is the evidence-level qualification input, not a routing
      // decision. Non-routability is enforced unconditionally by this module's
      // published record and assertPublishedQualificationNonRoutable().
      enabled: true,
      runtimeInstalled: true,
      authAvailable: true,
      qualified: true,
      version: identity.installedVersion,
      qualificationRevision: target.pinnedRevision,
      providerAccountClass: identity.providerAccountClass,
      models: [identity.model],
      profiles: [identity.profile],
      jobClasses: ['implementation'],
      toolchainFingerprints: [identity.capabilityFingerprint],
    },
  });

  const record = {
    instanceId: target.instanceId,
    nodeId: target.nodeId,
    adapterId: target.adapterId,
    published: true,
    qualified: true,
    state: 'qualified-not-routable',
    qualificationRevision: target.pinnedRevision,
    qualificationContractFingerprint: target.contractFingerprint,
    acceptedResultFingerprint: acceptedResult.resultFingerprint,
    acceptedJobFingerprint: acceptedResult.jobFingerprint || null,
    acceptedBaseSha: acceptedResult.baseSha || null,
    installedVersion: identity.installedVersion,
    authPostureClass: identity.authPostureClass,
    providerAccountClass: identity.providerAccountClass,
    model: identity.model,
    profile: identity.profile,
    effort: identity.effort,
    executionPostureClass: identity.permissionMode,
    capabilityFingerprint: identity.capabilityFingerprint,
    jobClasses: ['implementation'],
    fleetProvisioningState: evaluated.state,
    fleetProvisioningEvidenceFingerprint: evaluated.evidenceFingerprint,
    lifecycle: 'disabled',
    routable: false,
    routingEligible: false,
    normalRoutingEnabled: false,
  };
  return { ...record, publishedEvidenceFingerprint: digest(record) };
}

function evidenceGapInstance(target, reason) {
  return {
    instanceId: target.instanceId,
    nodeId: target.nodeId,
    adapterId: target.adapterId,
    published: false,
    qualified: false,
    state: 'evidence-gap',
    evidenceGapReason: reason,
    qualificationRevision: null,
    lifecycle: 'disabled',
    routable: false,
    routingEligible: false,
    normalRoutingEnabled: false,
  };
}

export function publishFleetQualification({ acceptedResults = [] } = {}) {
  if (!Array.isArray(acceptedResults)) throw new Error('acceptedResults must be an array');
  const byInstance = new Map();
  for (const result of acceptedResults) {
    const id = result && typeof result === 'object' ? result.agentInstanceId : null;
    if (typeof id !== 'string' || !id) throw new Error('accepted qualification result is missing agentInstanceId');
    if (byInstance.has(id)) throw new Error(`duplicate accepted qualification result for ${id}`);
    byInstance.set(id, result);
  }

  const instances = FLEET_QUALIFICATION_TARGET_INSTANCES.map((target) => {
    if (target.pinnedRevision === null) {
      return evidenceGapInstance(target, target.evidenceGapReason);
    }
    const reconciled = reconcileAcceptedQualification(target, byInstance.get(target.instanceId));
    if (!reconciled.ok) return evidenceGapInstance(target, reconciled.reason);
    return nonRoutablePublishedInstance(target, reconciled.acceptedResult);
  }).sort((a, b) => (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0));

  const evidenceGaps = instances
    .filter((entry) => entry.published !== true)
    .map((entry) => ({ instanceId: entry.instanceId, reason: entry.evidenceGapReason }));

  const projection = {
    schemaVersion: FLEET_QUALIFICATION_PUBLICATION_SCHEMA_VERSION,
    revision: FLEET_QUALIFICATION_PUBLICATION_REVISION,
    generatedFrom: 'independently-accepted-github-owned-qualification-evidence',
    normalRoutingEnabled: false,
    routingActivation: 'deferred-to-separate-field-lifecycle-acceptance',
    controllerNodeId: 'dev-cluster-dell',
    instances,
    evidenceGaps,
  };
  assertNoSecretFields(projection);
  assertPublishedQualificationNonRoutable(projection);
  return Object.freeze({ ...projection, publicationFingerprint: digest(projection) });
}

export function assertPublishedQualificationNonRoutable(projection) {
  if (!projection || projection.normalRoutingEnabled !== false) {
    throw new Error('fleet qualification publication must keep normal routing disabled');
  }
  for (const entry of projection.instances || []) {
    if (entry.routable !== false || entry.routingEligible !== false
      || entry.normalRoutingEnabled !== false || entry.lifecycle !== 'disabled') {
      throw new Error(`published instance is routable: ${entry.instanceId}`);
    }
  }
  return projection;
}

export function fleetQualificationPublicationControlSurface() {
  return Object.freeze({
    schemaVersion: FLEET_QUALIFICATION_PUBLICATION_SCHEMA_VERSION,
    controllerNodeId: 'dev-cluster-dell',
    workerNodeId: 'dev-cluster-z790',
    workerScheduler: false,
    workerQueueSelection: false,
    workerManagerAuthority: false,
    workerSourceActivation: false,
    workerGithubManagementMutation: false,
    workerMergeCloseDeploy: false,
    normalRoutingEnabled: false,
    paidApiFallbackEnabled: false,
    acceptedInput: 'independently-accepted-per-instance-qualification-result',
    acceptedOutput: 'deterministic-non-routable-fleet-qualification-registry-projection',
  });
}
