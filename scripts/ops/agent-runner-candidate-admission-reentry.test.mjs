import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  candidateSelectionTimeoutMs,
  DEFAULT_CANDIDATE_SELECTION_TIMEOUT_MS,
} from './agent-runner-candidate-admission.mjs';

const candidateAdmissionPath = fileURLToPath(new URL('./agent-runner-candidate-admission.mjs', import.meta.url));
const controlReadinessUrl = new URL('./agent-runner-control-readiness.mjs', import.meta.url).href;

function fixtureSelection(issueNumber = 702) {
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  const packetDigest = `sha256:${'b'.repeat(64)}`;
  const authorityKey = `manager-preflight:AR283-FIXTURE:${fingerprint}`;
  const preflight = {
    id: 9001,
    databaseId: 9001,
    createdAt: '2026-08-20T22:30:00Z',
    user: { login: 'gpcola' },
    body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: AR283-FIXTURE\nfingerprint: ${fingerprint}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: claude-code-cli\nexecution_phase: implementation\nscope:\n  - bounded fixture\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on scope expansion\n\`\`\``,
  };
  return {
    issue: {
      number: issueNumber,
      title: 'bounded candidate admission fixture',
      labels: ['status:ready', 'agent:claude-code-cli'],
      statusLabel: 'status:ready',
      agentLabel: 'agent:claude-code-cli',
    },
    selection: {
      mode: 'preflight-direct',
      command: null,
      preflight,
      managerAuthority: {
        valid: true,
        revision: 'AR283-FIXTURE',
        fingerprint,
        authorityKey,
        packetDigest,
        approvedAgent: 'claude-code-cli',
      },
    },
    command: null,
    currentPreflight: preflight,
  };
}

function writeSelectorModule(source) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-candidate-reentry-'));
  const path = join(dir, 'selector.mjs');
  writeFileSync(path, source);
  return pathToFileURL(path).href;
}

function runStandalone(moduleUrl, extraEnv = {}) {
  return spawnSync(process.execPath, [candidateAdmissionPath], {
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      ...process.env,
      CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola',
      AGENT_RUNNER_CANDIDATE_CRON_MODULE: moduleUrl,
      AGENT_RUNNER_CANDIDATE_SELECTION_TIMEOUT_MS: '100',
      ...extraEnv,
    },
  });
}

test('blank or missing selector timeout keeps the safe default', () => {
  assert.equal(candidateSelectionTimeoutMs({}), DEFAULT_CANDIDATE_SELECTION_TIMEOUT_MS);
  assert.equal(
    candidateSelectionTimeoutMs({ AGENT_RUNNER_CANDIDATE_SELECTION_TIMEOUT_MS: '' }),
    DEFAULT_CANDIDATE_SELECTION_TIMEOUT_MS,
  );
  assert.equal(
    candidateSelectionTimeoutMs({ AGENT_RUNNER_CANDIDATE_SELECTION_TIMEOUT_MS: '   ' }),
    DEFAULT_CANDIDATE_SELECTION_TIMEOUT_MS,
  );
});

test('malformed expected-candidate handoff fails closed as bounded infrastructure evidence', () => {
  const result = spawnSync(process.execPath, [candidateAdmissionPath], {
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      ...process.env,
      CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola',
      AGENT_RUNNER_ATOMIC_EXPECTED_JSON: '{not-json',
      AGENT_RUNNER_ATOMIC_ARGV_JSON: '[]',
    },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/i);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.admission.allowed, false);
  assert.equal(payload.admission.scope, 'candidate_revalidation');
  assert.equal(payload.admission.reason, 'candidate-revalidation-unavailable');
  assert.equal(payload.current && Object.keys(payload.current).length, 0);
});

test('standalone candidate admission uses independent parent/child observations and admits a stable candidate', () => {
  const stable = JSON.stringify(fixtureSelection());
  const moduleUrl = writeSelectorModule(`
export function parseArgs() { return {}; }
export async function selectIssue() { return ${stable}; }
`);

  const result = runStandalone(moduleUrl);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/i);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.admission.allowed, true);
  assert.equal(payload.admission.reason, 'candidate-admitted');
  assert.equal(payload.initial.issueNumber, 702);
  assert.equal(payload.current.issueNumber, 702);
});

test('direct candidate admission can load the control-readiness graph without an ESM evaluation cycle', () => {
  const stable = JSON.stringify(fixtureSelection());
  const moduleUrl = writeSelectorModule(`
import ${JSON.stringify(controlReadinessUrl)};
export function parseArgs() { return {}; }
export async function selectIssue() { return ${stable}; }
`);

  const result = runStandalone(moduleUrl, {
    AGENT_RUNNER_CANDIDATE_SELECTION_TIMEOUT_MS: '1000',
  });

  assert.equal(result.signal, null, `process timed out or was signalled\nstderr:\n${result.stderr || ''}`);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/i);

  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.admission.allowed, true);
  assert.equal(payload.admission.reason, 'candidate-admitted');
  assert.equal(payload.initial.issueNumber, 702);
  assert.equal(payload.current.issueNumber, 702);
});

test('second observation drift fails closed before admission', () => {
  const initial = JSON.stringify(fixtureSelection(702));
  const changed = JSON.stringify(fixtureSelection(703));
  const moduleUrl = writeSelectorModule(`
export function parseArgs() { return {}; }
export async function selectIssue() {
  return process.env.AGENT_RUNNER_ATOMIC_EXPECTED_JSON ? ${changed} : ${initial};
}
`);

  const result = runStandalone(moduleUrl);
  assert.equal(result.status, 3, result.stderr);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/i);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.admission.allowed, false);
  assert.equal(payload.admission.reason, 'candidate-selection-changed');
  assert.equal(payload.initial.issueNumber, 702);
  assert.equal(payload.current.issueNumber, 703);
});

test('non-settling fresh child observation becomes bounded infrastructure failure instead of exit 13', () => {
  const stable = JSON.stringify(fixtureSelection());
  const moduleUrl = writeSelectorModule(`
export function parseArgs() { return {}; }
export async function selectIssue() {
  if (process.env.AGENT_RUNNER_ATOMIC_EXPECTED_JSON) return new Promise(() => {});
  return ${stable};
}
`);

  const result = runStandalone(moduleUrl);
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/i);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.admission.allowed, false);
  assert.equal(payload.admission.scope, 'candidate_revalidation');
  assert.equal(payload.admission.reason, 'candidate-revalidation-timeout');
  assert.equal(payload.current && Object.keys(payload.current).length, 0);
});

test('non-settling first observation is bounded before any child revalidation can start', () => {
  const moduleUrl = writeSelectorModule(`
export function parseArgs() { return {}; }
export async function selectIssue() { return new Promise(() => {}); }
`);

  const result = runStandalone(moduleUrl);
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/i);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.admission.allowed, false);
  assert.equal(payload.admission.scope, 'candidate_revalidation');
  assert.equal(payload.admission.reason, 'candidate-revalidation-timeout');
});
