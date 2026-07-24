import assert from 'node:assert/strict';
import test from 'node:test';

import {
  managerAuthorityApprovesAgent,
} from './agent-runner-manager-authority.mjs';
import {
  MANAGER_PREFLIGHT_REQUIRED,
  resolveIssueSelection,
  STATUS_IN_PROGRESS,
  STATUS_READY,
} from './claude-runner-selection.mjs';

const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

function preflightComment({ id = 1, approvedAgent = 'claude-code-cli', revision = 'AR50.1' } = {}) {
  return {
    id,
    createdAt: '2026-07-24T05:00:00Z',
    body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: ${revision}\nfingerprint: ${FINGERPRINT}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: ${approvedAgent}\nexecution_phase: implementation\nscope:\n  - bounded test scope\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on scope expansion\n\`\`\`\n`,
  };
}

test('resolveIssueSelection returns null mode with MANAGER_PREFLIGHT_REQUIRED for an issue with no manager packet at all', () => {
  const result = resolveIssueSelection({ statusLabel: STATUS_READY }, []);
  assert.equal(result.mode, null);
  assert.equal(result.reason, MANAGER_PREFLIGHT_REQUIRED);
  assert.equal(result.managerAuthority, null);
});

test('resolveIssueSelection resolves preflight-direct mode and exposes managerAuthority.approvedAgent -- the exact contract claude-runner-cron.mjs relies on for its issue #50 approved_agent cross-check', () => {
  const comment = preflightComment({ approvedAgent: 'claude-code-cli' });
  const result = resolveIssueSelection({ statusLabel: STATUS_READY }, [comment]);
  assert.equal(result.mode, 'preflight-direct');
  assert.equal(result.managerAuthority.approvedAgent, 'claude-code-cli');
  assert.equal(managerAuthorityApprovesAgent(result.managerAuthority, 'claude-code-cli'), true);
  assert.equal(managerAuthorityApprovesAgent(result.managerAuthority, 'codex-cli'), false);
});

test('resolveIssueSelection works identically for a status:in-progress issue with a valid packet', () => {
  const comment = preflightComment({ approvedAgent: 'claude-code-cli' });
  const result = resolveIssueSelection({ statusLabel: STATUS_IN_PROGRESS }, [comment]);
  assert.equal(result.mode, 'preflight-direct');
  assert.equal(result.managerAuthority.approvedAgent, 'claude-code-cli');
});

test('resolveIssueSelection reports an unsupported status label rather than guessing a mode', () => {
  const result = resolveIssueSelection({ statusLabel: 'status:blocked' }, []);
  assert.equal(result.mode, null);
  assert.match(result.reason, /unsupported status label/);
});

test('a manager packet naming a different approved_agent than the issue label still resolves (selection is agent-agnostic); the cross-check against the resolved agent happens in claude-runner-cron.mjs, not here', () => {
  const comment = preflightComment({ approvedAgent: 'ollama-agent' });
  const result = resolveIssueSelection({ statusLabel: STATUS_READY }, [comment]);
  assert.equal(result.mode, 'preflight-direct');
  assert.equal(result.managerAuthority.approvedAgent, 'ollama-agent');
  assert.equal(managerAuthorityApprovesAgent(result.managerAuthority, 'claude-code-cli'), false);
});
