import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseQueueTriageExecuteArgs,
  runQueueTriageExecuteCommand,
} from './agent-runner-queue-triage-execute-command.mjs';

const PREFIX = [
  '--controller-db', '/tmp/controller.sqlite',
  '--release', 'batch-1',
  '--project-config', '/tmp/project.json',
  '--manager-revision', 'AR113-TEST.1',
  '--manager-fingerprint', `sha256:${'a'.repeat(64)}`,
];

function result() {
  return {
    schemaVersion: 1,
    status: 'processed',
    release: {
      batchId: 'batch-1',
      projectId: 'alpha',
      repository: 'Owner/Alpha',
      objectKind: 'issue',
      objectNumber: 17,
      state: 'processed',
    },
    runControl: {
      status: 'processed',
      mutationsAttempted: 1,
      mutationsVerified: 1,
    },
  };
}

test('requires explicit execute and manager authority', () => {
  assert.throws(() => parseQueueTriageExecuteArgs(PREFIX), /--execute is required/);
  assert.throws(
    () => parseQueueTriageExecuteArgs([...PREFIX.slice(0, 6), '--execute']),
    /manager-revision/,
  );
  const parsed = parseQueueTriageExecuteArgs([...PREFIX, '--execute', '--format', 'markdown']);
  assert.equal(parsed.execute, true);
  assert.equal(parsed.releaseId, 'batch-1');
  assert.equal(parsed.format, 'markdown');
});

test('structurally rejects sweep, fallback and all-enabled modes', () => {
  for (const forbidden of ['--pending', '--fallback', '--all-enabled', '--dry-run']) {
    assert.throws(() => parseQueueTriageExecuteArgs([...PREFIX, '--execute', forbidden]), /not available/);
  }
});

test('loads validated config and invokes executor with separate read/write clients', () => {
  let invocation = null;
  const output = runQueueTriageExecuteCommand({
    argv: [...PREFIX, '--execute'],
    readFile: () => JSON.stringify({ projectId: 'alpha' }),
    validateProject: (value) => ({ ...value, githubRepo: 'Owner/Alpha', queueTriage: { enabled: true, maxMutations: 3 } }),
    readClientFactory: () => ({ kind: 'read', requestJson() {} }),
    writeClientFactory: () => ({ kind: 'write', mutateIssue() {} }),
    execute: (input) => {
      invocation = input;
      return result();
    },
  });
  assert.equal(JSON.parse(output).status, 'processed');
  assert.equal(invocation.managerAuthority.revision, 'AR113-TEST.1');
  assert.equal(invocation.readClient.kind, 'read');
  assert.equal(invocation.writeClient.kind, 'write');
});

test('renders compact markdown with RUN_CONTROL', () => {
  const output = runQueueTriageExecuteCommand({
    argv: [...PREFIX, '--execute', '--format', 'markdown'],
    readFile: () => '{}',
    validateProject: () => ({ projectId: 'alpha' }),
    readClientFactory: () => ({ requestJson() {} }),
    writeClientFactory: () => ({ mutateIssue() {} }),
    execute: () => result(),
  });
  assert.match(output, /bounded execution/);
  assert.match(output, /RUN_CONTROL/);
  assert.doesNotMatch(output, /claimToken|rawPayload|commentBody/);
});
