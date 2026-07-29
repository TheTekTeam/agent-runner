import assert from 'node:assert/strict';
import test from 'node:test';

import { parseQueueTriageArgs, runQueueTriageCommand } from './agent-runner-queue-triage-command.mjs';

const input = {
  project: {
    projectId: 'alpha',
    repository: 'Owner/Alpha',
    acceptedAgentLabels: ['agent:claude'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress', blocked: 'status:blocked', done: 'status:done' },
    priorityLabels: ['priority:P0'],
    policy: { enabled: false },
  },
  observedAt: '2026-07-29T18:05:00Z',
  mode: 'fallback',
  changedItems: [],
  rotatingItems: [],
};

test('command defaults to compact JSON dry-run output', () => {
  const output = runQueueTriageCommand({
    argv: ['--input', '/tmp/input.json'],
    readFile: () => JSON.stringify(input),
  });
  const report = JSON.parse(output);
  assert.equal(report.dryRun, true);
  assert.equal(report.runControl.status, 'disabled-dry-run');
  assert.equal(report.runControl.externalReadsPerformed, false);
});

test('command renders bounded Markdown and RUN_CONTROL', () => {
  const output = runQueueTriageCommand({
    argv: ['--input=/tmp/input.json', '--format=markdown'],
    readFile: () => JSON.stringify(input),
  });
  assert.match(output, /queue-triage dry run/);
  assert.match(output, /RUN_CONTROL/);
});

test('command renders deterministic OpenAI oversight prompt without input', () => {
  const output = runQueueTriageCommand({ argv: ['--format', 'openai'] });
  assert.match(output, /oversight and exception-review agent/);
});

test('command refuses execute mode', () => {
  assert.throws(() => parseQueueTriageArgs(['--execute']), /not available/);
});
