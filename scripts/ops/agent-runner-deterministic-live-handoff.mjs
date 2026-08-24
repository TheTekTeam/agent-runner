#!/usr/bin/env node

import { createHash } from 'node:crypto';

import { loadAgentRunnerConfig } from './agent-runner-config.mjs';
import {
  buildDeterministicHandoffCapsule,
  executeDeterministicPreflight,
  planDeterministicPreflight,
} from './agent-runner-deterministic-preflight.mjs';

export const DETERMINISTIC_LIVE_HANDOFF_SCHEMA_VERSION = 1;
export const DETERMINISTIC_LIVE_HANDOFF_ENV = 'AGENT_RUNNER_DETERMINISTIC_HANDOFF_JSON';
export const DETERMINISTIC_LIVE_HANDOFF_MAX_BYTES = 12 * 1024;

// Binding #319 owner policy authorises worthwhile safe model-free read-only
// work across every registered Agent Runner project. This list is deliberately
// narrower than the full deterministic vocabulary: no test/build execution,
// repository mutation, GitHub mutation, network operation or arbitrary shell.
export const BASELINE_LIVE_READONLY_CAPABILITIES = Object.freeze([
  'repository-identity',
  'git-status',
  'changed-files',
  'repository-map',
  'toolchain-facts',
]);

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function parseAdmission(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('candidate admission is required');
  if (value.admission?.allowed !== true) throw new Error('candidate was not admitted');
  const snapshot = value.current || value.initial || {};
  const issueNumber = Number(snapshot.issueNumber);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error('candidate issue identity is unavailable');
  const authorityFingerprint = snapshot.preflightFingerprint;
  if (typeof authorityFingerprint !== 'string' || authorityFingerprint.length < 8) throw new Error('candidate authority fingerprint is unavailable');
  return { issueNumber, authorityFingerprint, resolvedAgentId: snapshot.resolvedAgentId || null };
}

function bounded(value, maxBytes = DETERMINISTIC_LIVE_HANDOFF_MAX_BYTES) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`deterministic live handoff exceeds ${maxBytes} bytes`);
  return text;
}

export function buildLiveDeterministicHandoff({ project, candidateAdmission, evidenceRoot, mapCacheRoot, now } = {}) {
  const candidate = parseAdmission(candidateAdmission);
  const requestedCapabilities = [...BASELINE_LIVE_READONLY_CAPABILITIES];
  const plan = planDeterministicPreflight({
    project,
    authority: { deterministicCapabilities: requestedCapabilities },
    configuration: { deterministicCapabilities: requestedCapabilities },
    requestedCapabilities,
  });
  const execution = executeDeterministicPreflight({ plan, configuration: {}, evidenceRoot, mapCacheRoot, now });
  if (!execution.providerEligible) {
    return Object.freeze({
      schemaVersion: DETERMINISTIC_LIVE_HANDOFF_SCHEMA_VERSION,
      available: false,
      optional: true,
      reason: 'baseline-readonly-preflight-unavailable',
      issueNumber: candidate.issueNumber,
      authorityFingerprint: candidate.authorityFingerprint,
    });
  }
  const capsule = buildDeterministicHandoffCapsule(execution);
  const payload = {
    schemaVersion: DETERMINISTIC_LIVE_HANDOFF_SCHEMA_VERSION,
    available: true,
    optional: true,
    issueNumber: candidate.issueNumber,
    authorityFingerprint: candidate.authorityFingerprint,
    agentId: candidate.resolvedAgentId,
    sourceFingerprint: capsule.sourceFingerprint,
    evidenceReused: capsule.evidenceReused,
    results: capsule.results,
  };
  const serialized = bounded(payload);
  return Object.freeze({ ...payload, handoffDigest: digest(payload), serialized });
}

export function validateLiveDeterministicHandoff(value, { issueNumber = null, maxBytes = DETERMINISTIC_LIVE_HANDOFF_MAX_BYTES } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, reason: 'handoff-invalid' };
  if (value.schemaVersion !== DETERMINISTIC_LIVE_HANDOFF_SCHEMA_VERSION || value.available !== true) return { valid: false, reason: 'handoff-unavailable' };
  if (issueNumber !== null && Number(value.issueNumber) !== Number(issueNumber)) return { valid: false, reason: 'handoff-issue-mismatch' };
  if (typeof value.sourceFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.sourceFingerprint)) return { valid: false, reason: 'handoff-source-invalid' };
  if (!Array.isArray(value.results) || value.results.length > 32) return { valid: false, reason: 'handoff-results-invalid' };
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) return { valid: false, reason: 'handoff-too-large' };
  const candidate = { ...value };
  const handoffDigest = candidate.handoffDigest;
  delete candidate.handoffDigest;
  delete candidate.serialized;
  if (typeof handoffDigest !== 'string' || handoffDigest !== digest(candidate)) return { valid: false, reason: 'handoff-digest-mismatch' };
  return { valid: true, reason: null };
}

export function renderLiveDeterministicHandoffForProvider(value) {
  const validation = validateLiveDeterministicHandoff(value);
  if (!validation.valid) return null;
  const facts = value.results.map((entry) => ({
    capability: entry.capability,
    status: entry.status,
    reused: entry.reused === true,
    result: entry.result ?? entry.facts ?? null,
    digest: entry.resultDigest ?? entry.digest ?? null,
  }));
  return bounded({
    schemaVersion: DETERMINISTIC_LIVE_HANDOFF_SCHEMA_VERSION,
    sourceFingerprint: value.sourceFingerprint,
    authorityFingerprint: value.authorityFingerprint,
    exactIdentityEvidence: facts,
    instruction: 'Treat this as exact deterministic evidence. Do not repeat these discovery operations unless source identity changes or additional detail is genuinely required.',
  }, 10 * 1024);
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const rawAdmission = env.AGENT_RUNNER_CANDIDATE_ADMISSION_JSON;
  if (!rawAdmission) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: DETERMINISTIC_LIVE_HANDOFF_SCHEMA_VERSION, available: false, optional: true, reason: 'candidate-admission-unavailable' })}\n`);
    return 0;
  }
  let admission;
  try {
    admission = JSON.parse(rawAdmission);
  } catch {
    process.stdout.write(`${JSON.stringify({ schemaVersion: DETERMINISTIC_LIVE_HANDOFF_SCHEMA_VERSION, available: false, optional: true, reason: 'candidate-admission-invalid' })}\n`);
    return 0;
  }
  try {
    const project = loadAgentRunnerConfig({ argv, env });
    const result = buildLiveDeterministicHandoff({
      project,
      candidateAdmission: admission,
      evidenceRoot: env.AGENT_RUNNER_DETERMINISTIC_EVIDENCE_DIR,
      mapCacheRoot: env.AGENT_RUNNER_REPOSITORY_MAP_CACHE_DIR,
    });
    const output = result.available ? { ...result, serialized: undefined } : result;
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: DETERMINISTIC_LIVE_HANDOFF_SCHEMA_VERSION, available: false, optional: true, reason: 'baseline-readonly-preflight-unavailable', detail: String(error?.message || error).slice(0, 240) })}\n`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
