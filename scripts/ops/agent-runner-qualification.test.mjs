import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessQualification,
  classifyIssueTaskRisk,
  LOW_RISK_CLASS,
  matchesClassification,
  matchesSupplementary,
  OLLAMA_AGENT_ID,
  ollamaRiskBoundaryPasses,
  WILDCARD,
} from './agent-runner-qualification.mjs';

function issueWithLabels(labels = []) {
  return { labels: labels.map((name) => ({ name })) };
}

test('matchesClassification: an empty list never matches anything, including an unclassified issue (missing qualification means unqualified)', () => {
  assert.equal(matchesClassification([], null), false);
  assert.equal(matchesClassification([], 'code'), false);
});

test('matchesClassification: a wildcard entry matches any explicit, known value, but never an unclassified issue', () => {
  assert.equal(matchesClassification([WILDCARD], 'anything'), true);
  assert.equal(matchesClassification([WILDCARD], null), false, 'a wildcard must not turn missing classification into an eligible class');
  assert.equal(matchesClassification([WILDCARD], undefined), false);
});

test('matchesClassification: an unclassified (null) issue never matches a specific, non-wildcard list -- it is never guessed permissive', () => {
  assert.equal(matchesClassification(['code', 'docs'], null), false);
});

test('matchesClassification: a classified issue matches only when it appears verbatim in the list', () => {
  assert.equal(matchesClassification(['code', 'docs'], 'docs'), true);
  assert.equal(matchesClassification(['code', 'docs'], 'ops'), false);
});

test('matchesSupplementary: an issue that does not request a specific model/harness is never blocked', () => {
  assert.equal(matchesSupplementary([], null), true);
  assert.equal(matchesSupplementary('any-configured-harness', null), true);
});

test('matchesSupplementary: a requested model must appear in the list or be covered by a wildcard', () => {
  assert.equal(matchesSupplementary(['claude-sonnet-5'], 'claude-sonnet-5'), true);
  assert.equal(matchesSupplementary([WILDCARD], 'claude-opus-4-8'), true);
  assert.equal(matchesSupplementary(['claude-sonnet-5'], 'claude-opus-4-8'), false);
  assert.equal(matchesSupplementary([], 'claude-sonnet-5'), false);
});

test('matchesSupplementary: a requested harness (scalar, not a list) must match exactly or be covered by a wildcard', () => {
  assert.equal(matchesSupplementary('cli-v1', 'cli-v1'), true);
  assert.equal(matchesSupplementary(WILDCARD, 'cli-v2'), true);
  assert.equal(matchesSupplementary('cli-v1', 'cli-v2'), false);
  assert.equal(matchesSupplementary(null, 'cli-v2'), false);
});

test('ollamaRiskBoundaryPasses: non-ollama agents are never gated by this boundary', () => {
  assert.equal(ollamaRiskBoundaryPasses('claude-code-cli', 'high'), true);
  assert.equal(ollamaRiskBoundaryPasses('claude-code-cli', null), true);
});

test(`ollamaRiskBoundaryPasses: ollama-agent passes only for an explicit "${LOW_RISK_CLASS}" risk class`, () => {
  assert.equal(ollamaRiskBoundaryPasses(OLLAMA_AGENT_ID, LOW_RISK_CLASS), true);
  assert.equal(ollamaRiskBoundaryPasses(OLLAMA_AGENT_ID, 'medium'), false);
  assert.equal(ollamaRiskBoundaryPasses(OLLAMA_AGENT_ID, 'high'), false);
});

test('ollamaRiskBoundaryPasses: an unclassified (null) risk never satisfies the ollama boundary -- low risk must be proven, not assumed', () => {
  assert.equal(ollamaRiskBoundaryPasses(OLLAMA_AGENT_ID, null), false);
});

test('assessQualification: wildcard task/risk qualification is NOT qualified for an unclassified issue -- explicit classification is required', () => {
  const decision = assessQualification({
    agentId: 'claude-code-cli',
    qualification: { taskClasses: [WILDCARD], riskClasses: [WILDCARD], models: [WILDCARD], harness: WILDCARD },
    classification: { taskClass: null, riskClass: null, model: null, harness: null },
  });
  assert.equal(decision.qualified, false);
  assert.deepEqual(decision.reasons.sort(), ['risk-class-not-qualified', 'task-class-not-qualified']);
});

test('assessQualification: wildcard task/risk qualification is qualified for an explicitly classified issue', () => {
  const decision = assessQualification({
    agentId: 'claude-code-cli',
    qualification: { taskClasses: [WILDCARD], riskClasses: [WILDCARD], models: [WILDCARD], harness: WILDCARD },
    classification: { taskClass: 'code', riskClass: 'low', model: null, harness: null },
  });
  assert.equal(decision.qualified, true);
  assert.deepEqual(decision.reasons, []);
});

test('assessQualification: an unqualified agent (empty lists) is rejected with a bounded task-class reason for a classified issue', () => {
  const decision = assessQualification({
    agentId: 'codex-cli',
    qualification: { taskClasses: [], riskClasses: [], models: [], harness: null },
    classification: { taskClass: 'code', riskClass: 'low', model: null, harness: null },
  });
  assert.equal(decision.qualified, false);
  assert.ok(decision.reasons.includes('task-class-not-qualified'));
  assert.ok(decision.reasons.includes('risk-class-not-qualified'));
});

test('assessQualification: task/risk mismatch is reported independently of model/harness mismatch', () => {
  const decision = assessQualification({
    agentId: 'codex-cli',
    qualification: { taskClasses: ['ops'], riskClasses: ['high'], models: ['gpt-5'], harness: 'codex-cli-v1' },
    classification: { taskClass: 'code', riskClass: 'low', model: 'gpt-5', harness: 'codex-cli-v1' },
  });
  assert.equal(decision.qualified, false);
  assert.deepEqual(decision.reasons.sort(), ['risk-class-not-qualified', 'task-class-not-qualified']);
});

test('assessQualification: a model mismatch alone is reported without a task/risk reason', () => {
  const decision = assessQualification({
    agentId: 'codex-cli',
    qualification: { taskClasses: [WILDCARD], riskClasses: [WILDCARD], models: ['gpt-5'], harness: WILDCARD },
    classification: { taskClass: 'code', riskClass: 'low', model: 'gpt-6-unreleased', harness: null },
  });
  assert.deepEqual(decision.reasons, ['model-not-qualified']);
});

test('assessQualification: a harness mismatch alone is reported without a task/risk reason', () => {
  const decision = assessQualification({
    agentId: 'codex-cli',
    qualification: { taskClasses: [WILDCARD], riskClasses: [WILDCARD], models: [WILDCARD], harness: 'codex-cli-v1' },
    classification: { taskClass: 'code', riskClass: 'low', model: null, harness: 'codex-cli-v2' },
  });
  assert.deepEqual(decision.reasons, ['harness-not-qualified']);
});

test('assessQualification: ollama-agent qualified for docs/low is accepted for a matching low-risk docs issue', () => {
  const decision = assessQualification({
    agentId: OLLAMA_AGENT_ID,
    qualification: { taskClasses: ['docs'], riskClasses: ['low'], models: [], harness: null },
    classification: { taskClass: 'docs', riskClass: 'low', model: null, harness: null },
  });
  assert.equal(decision.qualified, true);
});

test('assessQualification: ollama-agent is rejected for a non-low-risk class even if its own settings claim that risk class', () => {
  const decision = assessQualification({
    agentId: OLLAMA_AGENT_ID,
    qualification: { taskClasses: ['docs'], riskClasses: ['low', 'medium'], models: [], harness: null },
    classification: { taskClass: 'docs', riskClass: 'medium', model: null, harness: null },
  });
  assert.equal(decision.qualified, false);
  assert.ok(decision.reasons.includes('ollama-low-risk-boundary'));
});

test('assessQualification: conflicting structured metadata (already nulled by classifyIssueTaskRisk) is treated as unclassified, not permissive', () => {
  const decision = assessQualification({
    agentId: 'codex-cli',
    qualification: { taskClasses: ['code'], riskClasses: ['low'], models: [], harness: null },
    classification: { taskClass: null, riskClass: null, model: null, harness: null },
  });
  assert.equal(decision.qualified, false);
});

// -- classifyIssueTaskRisk: explicit structured task/risk/model/harness classification --

test('classifyIssueTaskRisk leaves every field null when no structured metadata is present at all', () => {
  const classification = classifyIssueTaskRisk(issueWithLabels(['status:ready', 'priority:P0']));
  assert.equal(classification.taskClass, null);
  assert.equal(classification.riskClass, null);
  assert.equal(classification.model, null);
  assert.equal(classification.harness, null);
  assert.deepEqual(classification.conflicts, []);
});

test('classifyIssueTaskRisk reads explicit task:/risk:/model:/harness: labels', () => {
  const classification = classifyIssueTaskRisk(issueWithLabels(['task:code', 'risk:low', 'model:claude-sonnet-5', 'harness:cli-v1']));
  assert.equal(classification.taskClass, 'code');
  assert.equal(classification.riskClass, 'low');
  assert.equal(classification.model, 'claude-sonnet-5');
  assert.equal(classification.harness, 'cli-v1');
});

test('classifyIssueTaskRisk stays null (unclassified) rather than guessing when task/risk metadata is entirely absent', () => {
  const classification = classifyIssueTaskRisk(issueWithLabels(['status:ready', 'priority:P1', 'agent:claude-code-cli']));
  assert.equal(classification.taskClass, null);
  assert.equal(classification.riskClass, null);
});

test('classifyIssueTaskRisk forces taskClass to null (not a guessed value) when the project field and the label disagree', () => {
  const issue = { labels: [{ name: 'task:docs' }], fields: { Task: 'code' } };
  const classification = classifyIssueTaskRisk(issue);
  assert.equal(classification.taskClass, null, 'a field/label conflict must not resolve to either conflicting value');
  assert.equal(classification.conflicts.length, 1);
  assert.equal(classification.conflicts[0].key, 'taskClass');
});

test('classifyIssueTaskRisk forces riskClass to null when the project field and the label disagree', () => {
  const issue = { labels: [{ name: 'risk:low' }], fields: { Risk: 'high' } };
  const classification = classifyIssueTaskRisk(issue);
  assert.equal(classification.riskClass, null);
  assert.equal(classification.conflicts[0].key, 'riskClass');
});

test('classifyIssueTaskRisk conflict evidence carries only a bounded key, never the raw field/label values that disagreed', () => {
  const issue = {
    labels: [{ name: 'task:SECRET-token-abc123-should-never-leak' }],
    fields: { Task: 'sk-live-fake-credential-should-never-leak' },
  };
  const classification = classifyIssueTaskRisk(issue);
  assert.equal(classification.taskClass, null);
  assert.deepEqual(classification.conflicts, [{ key: 'taskClass' }]);
  const serialized = JSON.stringify(classification);
  assert.ok(!serialized.includes('SECRET'), 'raw label value must never appear in serialized classification');
  assert.ok(!serialized.includes('sk-live'), 'raw field value must never appear in serialized classification');
});

test('classifyIssueTaskRisk agrees on a value (no conflict) when the project field and label match', () => {
  const issue = { labels: [{ name: 'task:code' }], fields: { Task: 'code' } };
  const classification = classifyIssueTaskRisk(issue);
  assert.equal(classification.taskClass, 'code');
  assert.equal(classification.conflicts.length, 0);
});

test('classifyIssueTaskRisk never inspects issue title/body prose', () => {
  const issue = { title: 'low risk documentation task', body: 'risk: low, task: docs', labels: [] };
  const classification = classifyIssueTaskRisk(issue);
  assert.equal(classification.taskClass, null);
  assert.equal(classification.riskClass, null);
});
