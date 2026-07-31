import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseQueueTriageConsumeArgs,
  runQueueTriageConsumeCommand,
} from './agent-runner-queue-triage-consume-command.mjs';

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
      payloadFingerprint: 'sha256:' + 'a'.repeat(64),
      state: 'processed',
    },
    runControl: {
      schemaVersion: 1,
      status: 'processed',
      releasesClaimed: 1,
      releasesFinished: 1,
      githubReadOnly: true,
      githubWritesPerformed: false,
      mutationAllowed: false,
    },
  };
}

test('requires one explicit controller database, release and project config', () => {
  assert.throws(() => parseQueueTriageConsumeArgs([]), /controller-db/);
  assert.throws(() => parseQueueTriageConsumeArgs(['--controller-db', '/tmp/db']), /--release/);
  assert.throws(() => parseQueueTriageConsumeArgs([
    '--controller-db', '/tmp/db', '--release', 'batch-1',
  ]), /project-config/);
  const parsed = parseQueueTriageConsumeArgs([
    '--controller-db', '/tmp/db',
    '--release', 'batch-1',
    '--project-config', '/tmp/project.json',
    '--lease-ms', '120000',
    '--format', 'markdown',
  ]);
  assert.equal(parsed.releaseId, 'batch-1');
  assert.equal(parsed.leaseMs, 120000);
  assert.equal(parsed.format, 'markdown');
});

test('structurally rejects execute, pending, fallback and all-enabled modes', () => {
  const prefix = ['--controller-db', '/tmp/db', '--release', 'batch-1', '--project-config', '/tmp/project.json'];
  for (const forbidden of ['--execute', '--pending', '--fallback', '--all-enabled']) {
    assert.throws(() => parseQueueTriageConsumeArgs([...prefix, forbidden]), /not available/);
  }
});

test('loads and validates project config before invoking the consumer', () => {
  let consumed = null;
  const output = runQueueTriageConsumeCommand({
    argv: [
      '--controller-db', '/tmp/controller.sqlite',
      '--release', 'batch-1',
      '--project-config', '/tmp/project.json',
    ],
    readFile: () => JSON.stringify({ projectId: 'alpha' }),
    validateProject: (input) => ({ ...input, githubRepo: 'Owner/Alpha' }),
    clientFactory: () => ({ requestJson() {} }),
    consume: (input) => {
      consumed = input;
      return result();
    },
  });
  assert.equal(JSON.parse(output).status, 'processed');
  assert.equal(consumed.releaseId, 'batch-1');
  assert.equal(consumed.project.githubRepo, 'Owner/Alpha');
  assert.equal(typeof consumed.client.requestJson, 'function');
});

test('renders compact markdown with a RUN_CONTROL section', () => {
  const output = runQueueTriageConsumeCommand({
    argv: [
      '--controller-db=/tmp/controller.sqlite',
      '--release=batch-1',
      '--project-config=/tmp/project.json',
      '--format=markdown',
    ],
    readFile: () => '{}',
    validateProject: () => ({ projectId: 'alpha', githubRepo: 'Owner/Alpha' }),
    clientFactory: () => ({ requestJson() {} }),
    consume: () => result(),
  });
  assert.match(output, /queue-triage release consumption/);
  assert.match(output, /RUN_CONTROL/);
  assert.doesNotMatch(output, /rawPayload|commentBody|claimToken/);
});
