import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { SHARED_CODEX_CLAUDE_LABEL, agentAssignmentDisplayName } from './agent-runner-agents.mjs';
import { boundedAgentId, boundedAssignmentLabel, issueAssignmentEvidence } from './claude-runner-dashboard-api.mjs';

// Issue #97: the legacy static dashboard's queue/current-attempt surfaces are
// plain source (no DOM in this test runner), so the client-side contract is
// asserted against the script text -- the same convention the other dashboard
// client tests already use.
const script = readFileSync('.agent-runner/dashboard/dashboard.js', 'utf8');
// Comments legitimately name the display string when explaining the rule;
// only executable code is checked for a hard-coded copy of it.
const executableScript = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

test('every projection resolves the shared assignment display through the canonical #96 helper, never its own copy', () => {
  assert.equal(agentAssignmentDisplayName(SHARED_CODEX_CLAUDE_LABEL), 'Codex / Claude');
  assert.equal(
    issueAssignmentEvidence({ payload: { agent: { agentId: 'claude-code-cli', assignmentLabel: SHARED_CODEX_CLAUDE_LABEL } } }).assignment_display_name,
    agentAssignmentDisplayName(SHARED_CODEX_CLAUDE_LABEL),
  );
  // No module outside the catalogue may hard-code the display string: the
  // dashboard client renders whatever the API projected for it.
  assert.doesNotMatch(executableScript, /Codex \/ Claude/);
  assert.match(executableScript, /row\.assignment_display_name/);
});

test('the dashboard current-attempt panel renders assignment and actual agent as two separate facts', () => {
  const activityPanel = script.slice(script.indexOf('function renderActivity'), script.indexOf('function runOutcome'));
  assert.match(activityPanel, /<dt>Assignment<\/dt><dd>\$\{escapeHtml\(row\.assignment_display_name \|\| '—'\)\}<\/dd>/);
  assert.match(activityPanel, /<dt>Agent<\/dt><dd>\$\{escapeHtml\(row\.agent \|\| '—'\)\}<\/dd>/);
  // Neither field may fall back to the other: an absent assignment must not
  // print the worker, and an absent worker must not print the shared label.
  assert.doesNotMatch(activityPanel, /row\.assignment_display_name \|\| row\.agent/);
  assert.doesNotMatch(activityPanel, /row\.agent \|\| row\.assignment/);
});

test('the dashboard queue summary reports assignments through the projected display name and stays bounded', () => {
  assert.match(script, /metrics\.queue\?\.assignments \|\| \[\]/);
  assert.match(script, /\.slice\(0, 3\)/);
  assert.match(script, /entry\.assignmentDisplayName \|\| entry\.assignmentLabel/);
});

test('assignment evidence is bounded: unknown labels and unbounded agent text fail closed', () => {
  assert.equal(boundedAssignmentLabel(SHARED_CODEX_CLAUDE_LABEL), SHARED_CODEX_CLAUDE_LABEL);
  assert.equal(boundedAssignmentLabel({ name: SHARED_CODEX_CLAUDE_LABEL }), SHARED_CODEX_CLAUDE_LABEL);
  assert.equal(boundedAssignmentLabel('agent:codex-claude-but-not-really'), null);
  assert.equal(boundedAssignmentLabel('status:ready'), null);
  assert.equal(boundedAssignmentLabel(''), null);
  assert.equal(boundedAssignmentLabel(undefined), null);

  assert.equal(boundedAgentId('claude-code-cli'), 'claude-code-cli');
  assert.equal(boundedAgentId('/home/user/secret'), null);
  assert.equal(boundedAgentId('a'.repeat(200)), null);
  assert.equal(boundedAgentId(null), null);
});

test('the shared label is never substituted for the actual selected worker in attempt evidence', () => {
  const evidence = issueAssignmentEvidence({
    issue_number: 97,
    payload: { agent: { agentId: 'claude-code-cli', assignmentLabel: SHARED_CODEX_CLAUDE_LABEL } },
  });
  assert.equal(evidence.assignment_display_name, 'Codex / Claude');
  assert.equal(evidence.agent, 'claude-code-cli');

  // A row carrying only the eligibility label proves nothing about who ran:
  // the agent stays null rather than being derived from the label.
  const labelOnly = issueAssignmentEvidence({ payload: { assignmentLabel: SHARED_CODEX_CLAUDE_LABEL } });
  assert.equal(labelOnly.assignment_display_name, 'Codex / Claude');
  assert.equal(labelOnly.agent, null);

  // An attempt row that names its worker but no assignment keeps the worker.
  const agentOnly = issueAssignmentEvidence({ agent: 'claude-code-cli' });
  assert.equal(agentOnly.assignment_label, null);
  assert.equal(agentOnly.assignment_display_name, null);
  assert.equal(agentOnly.agent, 'claude-code-cli');
});

test('non-shared assignment labels keep their existing unaliased display', () => {
  for (const label of ['agent:claude', 'agent:claude-code-cli', 'agent:codex-cli', 'agent:gemini-cli']) {
    assert.equal(agentAssignmentDisplayName(label), label);
    assert.equal(issueAssignmentEvidence({ payload: { assignmentLabel: label } }).assignment_display_name, label);
  }
});
