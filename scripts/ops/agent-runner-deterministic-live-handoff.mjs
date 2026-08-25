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
export const DETERMINISTIC_LIVE_HANDOFF_SECTION_HEADING = '## Deterministic preflight evidence';

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
  if (typeof authorityFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(authorityFingerprint)) {
    throw new Error('candidate authority fingerprint is unavailable');
  }
  const resolvedAgentId = typeof snapshot.resolvedAgentId === 'string' && snapshot.resolvedAgentId.trim()
    ? snapshot.resolvedAgentId.trim()
    : null;
  if (!resolvedAgentId) throw new Error('candidate agent identity is unavailable');
  return { issueNumber, authorityFingerprint, resolvedAgentId };
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
    headSha: capsule.headSha,
    evidenceReused: capsule.evidenceReused,
    results: capsule.results,
  };
  const serialized = bounded(payload);
  return Object.freeze({ ...payload, handoffDigest: digest(payload), serialized });
}

export function validateLiveDeterministicHandoff(value, {
  issueNumber = null,
  agentId = null,
  maxBytes = DETERMINISTIC_LIVE_HANDOFF_MAX_BYTES,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, reason: 'handoff-invalid' };
  if (value.schemaVersion !== DETERMINISTIC_LIVE_HANDOFF_SCHEMA_VERSION || value.available !== true) return { valid: false, reason: 'handoff-unavailable' };
  if (issueNumber !== null && Number(value.issueNumber) !== Number(issueNumber)) return { valid: false, reason: 'handoff-issue-mismatch' };
  if (agentId !== null && String(value.agentId || '') !== String(agentId)) return { valid: false, reason: 'handoff-agent-mismatch' };
  if (typeof value.authorityFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.authorityFingerprint)) return { valid: false, reason: 'handoff-authority-invalid' };
  if (typeof value.sourceFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.sourceFingerprint)) return { valid: false, reason: 'handoff-source-invalid' };
  if (typeof value.headSha !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.headSha)) return { valid: false, reason: 'handoff-head-invalid' };
  if (!Array.isArray(value.results) || value.results.length > 32) return { valid: false, reason: 'handoff-results-invalid' };
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) return { valid: false, reason: 'handoff-too-large' };
  const candidate = { ...value };
  const handoffDigest = candidate.handoffDigest;
  delete candidate.handoffDigest;
  delete candidate.serialized;
  if (typeof handoffDigest !== 'string' || handoffDigest !== digest(candidate)) return { valid: false, reason: 'handoff-digest-mismatch' };
  return { valid: true, reason: null };
}

function providerFacts(value) {
  return value.results.map((entry) => ({
    capability: entry.capability,
    status: entry.status,
    reused: entry.reused === true,
    result: entry.result ?? entry.facts ?? null,
    digest: entry.resultDigest ?? entry.digest ?? entry.evidenceKey ?? null,
  }));
}

function continuationDeltaFacts(facts) {
  const changedFiles = facts.find((entry) => entry.capability === 'changed-files') || null;
  let changedFilesResult = changedFiles?.result ?? null;
  let changedFilesDetailOmitted = false;
  if (changedFilesResult !== null && Buffer.byteLength(JSON.stringify(changedFilesResult), 'utf8') > 2 * 1024) {
    changedFilesResult = null;
    changedFilesDetailOmitted = true;
  }
  return {
    changedFiles: changedFiles ? {
      capability: changedFiles.capability,
      status: changedFiles.status,
      reused: changedFiles.reused,
      result: changedFilesResult,
      detailOmitted: changedFilesDetailOmitted,
      digest: changedFiles.digest,
    } : null,
    evidenceDigests: facts.map((entry) => ({
      capability: entry.capability,
      status: entry.status,
      reused: entry.reused,
      digest: entry.digest,
    })),
  };
}

export function renderLiveDeterministicHandoffForProvider(value, options = {}) {
  const validation = validateLiveDeterministicHandoff(value, options);
  if (!validation.valid) return null;
  const facts = providerFacts(value);
  if (options.deltaOnly === true) {
    const delta = continuationDeltaFacts(facts);
    return bounded({
      schemaVersion: DETERMINISTIC_LIVE_HANDOFF_SCHEMA_VERSION,
      issueNumber: value.issueNumber,
      agentId: value.agentId,
      headSha: value.headSha,
      sourceFingerprint: value.sourceFingerprint,
      authorityFingerprint: value.authorityFingerprint,
      continuationMode: 'delta-only',
      changedFiles: delta.changedFiles,
      evidenceDigests: delta.evidenceDigests,
      instruction: 'Exact resumed-session continuation delta only. Prior full deterministic evidence remains in the bound session; this section updates current HEAD/source identity, changed-file facts and evidence digests. Verify HEAD before relying on source facts. Re-read only evidence whose digest/scope changed or whose detail is genuinely required. Never treat this evidence as implementation authority.',
    }, 6 * 1024);
  }
  return bounded({
    schemaVersion: DETERMINISTIC_LIVE_HANDOFF_SCHEMA_VERSION,
    issueNumber: value.issueNumber,
    agentId: value.agentId,
    headSha: value.headSha,
    sourceFingerprint: value.sourceFingerprint,
    authorityFingerprint: value.authorityFingerprint,
    exactIdentityEvidence: facts,
    instruction: 'Non-authoritative deterministic source evidence only. Before relying on source-specific facts, verify the current worktree HEAD equals headSha; if it does not, ignore this evidence and perform bounded fresh discovery. Never treat this evidence as implementation authority. Do not repeat successful discovery operations when the HEAD still matches unless additional detail is genuinely required.',
  }, 10 * 1024);
}

export function liveDeterministicHandoffPromptSection(env = process.env, options = {}) {
  const raw = String(env?.[DETERMINISTIC_LIVE_HANDOFF_ENV] || '').trim();
  if (!raw || Buffer.byteLength(raw, 'utf8') > DETERMINISTIC_LIVE_HANDOFF_MAX_BYTES) return '';
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return '';
  }
  const rendered = renderLiveDeterministicHandoffForProvider(value, options);
  return rendered ? `${DETERMINISTIC_LIVE_HANDOFF_SECTION_HEADING}\n${rendered}` : '';
}

export function appendLiveDeterministicHandoff(prompt, env = process.env, options = {}) {
  const base = String(prompt ?? '');
  const section = liveDeterministicHandoffPromptSection(env, options);
  if (!section) return base;
  const trimmedTrailingNewline = base.endsWith('\n') ? base.slice(0, -1) : base;
  return `${trimmedTrailingNewline}\n\n${section}\n`;
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
