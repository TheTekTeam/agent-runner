import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizePollingControllerResult } from './agent-runner-polling-controller-summary.mjs';

test('summary output counts states and reasons without serializing per-batch identities', () => {
  const summary = summarizePollingControllerResult({
    observedAt: '2026-07-29T06:00:00.000Z',
    polling: {
      projectsInspected: 2,
      deliveriesInserted: 4,
      duplicateDeliveries: 1,
      outcomes: [
        { projectId: 'alpha', bootstrap: true, issuesObserved: 2, pullRequestsObserved: 1, deliveriesInserted: 4, duplicateDeliveries: 0 },
        { projectId: 'beta', errorCode: 'provider-read-failed', deliveriesInserted: 0, duplicateDeliveries: 1 },
      ],
    },
    controller: {
      deliveriesAttached: 4,
      deliveriesIgnored: 0,
      batchesInspected: 3,
      releasesCreated: 1,
      pendingReleases: 1,
      outcomes: [
        { batchId: 'secret-batch-a', state: 'waiting_for_checks', reason: 'ci-not-terminal', providerDiagnostics: [] },
        { batchId: 'secret-batch-b', state: 'quiet_period', reason: 'checks-terminal-awaiting-final-recheck', providerDiagnostics: [{ code: 'partial' }] },
        { batchId: 'secret-batch-c', state: 'settled', reason: 'settled', providerDiagnostics: [] },
      ],
    },
  });

  assert.deepEqual(summary.controller.states, {
    quiet_period: 1,
    settled: 1,
    waiting_for_checks: 1,
  });
  assert.equal(summary.controller.providerDiagnosticCount, 1);
  assert.equal(summary.polling.projectErrors, 1);
  assert.equal(JSON.stringify(summary).includes('secret-batch'), false);
});
