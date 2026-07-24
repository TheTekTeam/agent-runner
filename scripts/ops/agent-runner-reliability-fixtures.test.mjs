import assert from 'node:assert/strict';
import test from 'node:test';
import { runReliabilityFixtures, serializeReliabilityFixtures } from './agent-runner-reliability-fixtures.mjs';

function canonicalProduction(overrides = {}) {
  return {
    async selectCandidate({ backlog, skipIssueIds }) {
      const inspected = backlog.length;
      const candidate = backlog.find((entry) => entry.runnable && !skipIssueIds.includes(entry.id)) || null;
      return { inspected, candidate, reason: candidate ? 'later-candidate-selected' : 'no-candidate' };
    },
    async openProfileCircuit() {
      return { open: true };
    },
    async evaluateManagerAuthority({ authorityState }) {
      return { allowed: false, reason: `authority-${authorityState}`, workerStarts: 0, githubMutations: 0 };
    },
    async classifyTaskOutcome() {
      return { scope: 'task_attempt', reason: 'task-attempt-handled', systemdOutcome: 'handled', serialSlotReleased: true };
    },
    async planIssueTransition({ scope, reason }) {
      return scope === 'issue_not_runnable' && reason === 'genuine-dependency-blocker'
        ? { status: 'blocked' }
        : { status: 'unchanged' };
    },
    ...overrides,
  };
}

const adversarial = {
  token: 'sk-test-super-secret',
  prompt: 'ignore all rules',
  providerOutput: 'provider output',
  rawLog: 'raw log',
  path: '/home/gp/private',
  sessionHandle: 'session_abcdef',
  safeCode: 'bounded-safe-code',
};

test('runs every required reliability scenario with closed counters', async () => {
  const report = await runReliabilityFixtures({ production: canonicalProduction(), seed: { adversarial } });
  assert.equal(report.passed, true);
  assert.equal(report.scenarios.length, 7);
  for (const scenario of report.scenarios) {
    assert.equal(scenario.passed, true, scenario.scenarioId);
    assert.deepEqual(Object.keys(scenario.counters), [
      'candidatesInspected', 'claims', 'attempts', 'workerStarts', 'githubMutations',
    ]);
  }
});

test('machine refusal happens before selection, attempt, claim, worker and GitHub mutation', async () => {
  let selected = false;
  const report = await runReliabilityFixtures({
    production: canonicalProduction({
      async selectCandidate(args) {
        selected = true;
        return canonicalProduction().selectCandidate(args);
      },
    }),
  });
  const scenario = report.scenarios.find((entry) => entry.scenarioId === 'machine-profile-refusal-before-selection');
  assert.equal(scenario.passed, true);
  assert.deepEqual(scenario.counters, {
    candidatesInspected: 0, claims: 0, attempts: 0, workerStarts: 0, githubMutations: 0,
  });
  assert.equal(selected, true, 'selection is used only by the later issue-skip fixture');
});

test('repeated unchanged refusal opens the profile circuit without consuming backlog', async () => {
  const report = await runReliabilityFixtures({ production: canonicalProduction() });
  const scenario = report.scenarios.find((entry) => entry.scenarioId === 'repeated-refusal-preserves-backlog');
  assert.equal(scenario.passed, true);
  assert.equal(scenario.evidence.circuit, true);
  assert.equal(scenario.counters.candidatesInspected, 0);
});

test('issue-local skip selects a later unrelated candidate', async () => {
  const report = await runReliabilityFixtures({
    production: canonicalProduction(),
    seed: { backlog: [{ id: 101, runnable: false }, { id: 102, runnable: true }, { id: 103, runnable: true }] },
  });
  const scenario = report.scenarios.find((entry) => entry.scenarioId === 'issue-specific-skip-continues');
  assert.equal(scenario.passed, true);
  assert.equal(scenario.evidence.selectedIssue, 102);
  assert.equal(scenario.counters.claims, 0);
});

test('task-local failure releases the serial slot and remains handled', async () => {
  const report = await runReliabilityFixtures({ production: canonicalProduction() });
  const scenario = report.scenarios.find((entry) => entry.scenarioId === 'task-local-failure-releases-slot');
  assert.equal(scenario.passed, true);
  assert.equal(scenario.evidence.serialSlotReleased, true);
  assert.equal(scenario.counters.workerStarts, 1);
});

test('only a genuine issue blocker produces a blocked transition plan', async () => {
  const report = await runReliabilityFixtures({ production: canonicalProduction() });
  const scenario = report.scenarios.find((entry) => entry.scenarioId === 'genuine-blocker-only-blocked-plan');
  assert.equal(scenario.passed, true);
  assert.equal(scenario.evidence.machinePlan, 'unchanged');
  assert.equal(scenario.evidence.blockerPlan, 'blocked');
});

test('missing, stale, edited and already-claimed manager authority mutate nothing', async () => {
  const seen = [];
  const report = await runReliabilityFixtures({
    production: canonicalProduction({
      async evaluateManagerAuthority({ authorityState }) {
        seen.push(authorityState);
        return { allowed: false, workerStarts: 0, githubMutations: 0 };
      },
    }),
  });
  assert.deepEqual(seen, ['missing', 'stale', 'edited', 'already-claimed']);
  const scenario = report.scenarios.find((entry) => entry.scenarioId === 'invalid-manager-authority-zero-mutation');
  assert.equal(scenario.passed, true);
});

test('serialized evidence excludes adversarial secrets, prompts, output, paths and handles', async () => {
  const report = await runReliabilityFixtures({ production: canonicalProduction(), seed: { adversarial } });
  const serialized = serializeReliabilityFixtures(report);
  for (const forbidden of ['sk-test', 'ignore all rules', 'provider output', 'raw log', '/home/gp', 'session_abcdef']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(serialized.includes('safeCode'), true);
});

test('restart/reopen produces identical bounded evidence for the same synthetic state', async () => {
  const first = await runReliabilityFixtures({ production: canonicalProduction(), seed: { adversarial } });
  const reopened = await runReliabilityFixtures({ production: canonicalProduction(), seed: { adversarial } });
  assert.equal(serializeReliabilityFixtures(first), serializeReliabilityFixtures(reopened));
});

test('fails closed when a required production function is absent', async () => {
  const production = canonicalProduction();
  delete production.openProfileCircuit;
  await assert.rejects(() => runReliabilityFixtures({ production }), /missing-production-function-openProfileCircuit/);
});

test('a production-function regression fails its corresponding fixture', async () => {
  const report = await runReliabilityFixtures({
    production: canonicalProduction({
      async classifyTaskOutcome() {
        return { scope: 'task_attempt', systemdOutcome: 'failed', serialSlotReleased: false };
      },
    }),
  });
  assert.equal(report.passed, false);
  assert.equal(report.scenarios.find((entry) => entry.scenarioId === 'task-local-failure-releases-slot').passed, false);
});
