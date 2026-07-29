import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  parseQueueTriageShadowArgs,
  runQueueTriageShadowCommand,
} from './agent-runner-queue-triage-shadow-command.mjs';

function release({
  batchId = 'batch-alpha-1',
  projectId = 'alpha',
  repository = 'Owner/Alpha',
  objectNumber = 7,
  releasedAt = '2026-07-29T18:00:00Z',
} = {}) {
  return {
    batchId,
    state: 'pending',
    releasedAt,
    updatedAt: releasedAt,
    payload: {
      schemaVersion: 1,
      batchId,
      projectId,
      repository,
      objectKind: 'issue',
      objectNumber,
      settledAt: releasedAt,
      deliveryIds: [`delivery-${batchId}`],
      shas: [{ sha: 'a'.repeat(40), role: 'head' }],
      settlement: {
        reason: 'ci-settled',
        requiredShas: ['a'.repeat(40)],
        terminalFailures: [],
      },
    },
    result: {},
  };
}

function createControllerDatabase(dbPath, releases) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE event_controller_schema(
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO event_controller_schema(version, applied_at)
    VALUES (1, '2026-07-29T18:00:00Z');

    CREATE TABLE event_triage_releases(
      batch_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      released_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claim_token TEXT,
      claim_expires_at TEXT,
      payload_json TEXT NOT NULL,
      result_json TEXT NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO event_triage_releases(
      batch_id,
      state,
      released_at,
      updated_at,
      claim_token,
      claim_expires_at,
      payload_json,
      result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const inputRelease of releases) {
    insert.run(
      inputRelease.batchId,
      inputRelease.state,
      inputRelease.releasedAt,
      inputRelease.updatedAt,
      null,
      null,
      JSON.stringify(inputRelease.payload),
      JSON.stringify(inputRelease.result),
    );
  }
  db.close();
}

function controllerHashes(directory) {
  return Object.fromEntries(
    readdirSync(directory)
      .filter((name) => name.startsWith('controller.sqlite'))
      .sort()
      .map((name) => [
        name,
        createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'),
      ]),
  );
}

function evidence(inputRelease) {
  return {
    project: {
      projectId: inputRelease.payload.projectId,
      repository: inputRelease.payload.repository,
      acceptedAgentLabels: ['agent:claude'],
      statusLabels: {
        ready: 'status:ready',
        inProgress: 'status:in-progress',
        blocked: 'status:blocked',
        done: 'status:done',
      },
      priorityLabels: ['priority:P0'],
      policy: { enabled: false },
    },
    observedAt: '2026-07-29T18:05:00Z',
    mode: 'release',
    releaseId: inputRelease.batchId,
    changedItems: [{
      repository: inputRelease.payload.repository,
      kind: 'issue',
      number: inputRelease.payload.objectNumber,
      updatedAt: '2026-07-29T18:01:00Z',
      labels: ['priority:P0', 'status:blocked', 'agent:claude'],
      evidenceRefs: [`issue:${inputRelease.payload.objectNumber}`],
      flags: {},
    }],
    rotatingItems: [],
  };
}

test('argument parser requires one bounded observation mode', () => {
  assert.throws(
    () => parseQueueTriageShadowArgs(['--controller-db', 'a', '--shadow-db', 'b']),
    /exactly one/,
  );
  assert.throws(
    () => parseQueueTriageShadowArgs([
      '--controller-db', 'a', '--shadow-db', 'b', '--pending', '--limit', '21',
    ]),
    /1 to 20/,
  );
  assert.throws(
    () => parseQueueTriageShadowArgs([
      '--controller-db', 'a', '--shadow-db', 'b', '--pending', '--evidence', 'e.json',
    ]),
    /explicit --release/,
  );
});

test('refuses a shadow database path that aliases the controller or a sidecar', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-runner-triage-shadow-alias-'));
  const controllerDb = join(directory, 'controller.sqlite');
  try {
    createControllerDatabase(controllerDb, [release()]);
    assert.throws(
      () => runQueueTriageShadowCommand({
        argv: [
          '--controller-db', controllerDb,
          '--shadow-db', controllerDb,
          '--pending',
        ],
      }),
      /must be separate/,
    );
    assert.throws(
      () => runQueueTriageShadowCommand({
        argv: [
          '--controller-db', controllerDb,
          '--shadow-db', `${controllerDb}-wal`,
          '--pending',
        ],
      }),
      /must be separate/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('missing explicit release is rejected before shadow storage is created', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-runner-triage-shadow-missing-'));
  const controllerDb = join(directory, 'controller.sqlite');
  const shadowDb = join(directory, 'shadow.sqlite');
  try {
    createControllerDatabase(controllerDb, [release()]);
    assert.throws(
      () => runQueueTriageShadowCommand({
        argv: [
          '--controller-db', controllerDb,
          '--shadow-db', shadowDb,
          '--release', 'batch-does-not-exist',
        ],
      }),
      /pending release not found/,
    );
    assert.equal(existsSync(shadowDb), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pending mode observes at most 20 releases and preserves controller files byte-for-byte', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-runner-triage-shadow-command-'));
  const controllerDb = join(directory, 'controller.sqlite');
  const shadowDb = join(directory, 'shadow.sqlite');
  try {
    createControllerDatabase(
      controllerDb,
      Array.from({ length: 21 }, (_, index) => release({
        batchId: `batch-${String(index).padStart(2, '0')}`,
        projectId: index % 2 === 0 ? 'alpha' : 'beta',
        repository: index % 2 === 0 ? 'Owner/Alpha' : 'Elsewhere/Beta',
        objectNumber: index + 1,
        releasedAt: new Date(Date.parse('2026-07-29T18:00:00Z') + index * 1_000).toISOString(),
      })),
    );
    const before = controllerHashes(directory);
    const result = JSON.parse(runQueueTriageShadowCommand({
      argv: [
        '--controller-db', controllerDb,
        '--shadow-db', shadowDb,
        '--pending',
        '--limit', '20',
      ],
      observedAt: '2026-07-29T18:30:00Z',
    }));
    assert.equal(result.releasesInspected, 20);
    assert.equal(result.observationsInserted, 20);
    assert.equal(result.runControl.controllerDatabaseReadOnly, true);
    assert.equal(result.runControl.controllerReleasesClaimed, 0);
    assert.equal(result.runControl.controllerReleasesFinished, 0);
    assert.equal(result.runControl.githubReadsPerformed, false);
    assert.deepEqual(controllerHashes(directory), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('explicit release mode persists one matching planner report and replays after restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-runner-triage-shadow-evidence-'));
  const controllerDb = join(directory, 'controller.sqlite');
  const shadowDb = join(directory, 'shadow.sqlite');
  const evidencePath = join(directory, 'evidence.json');
  const inputRelease = release();
  try {
    createControllerDatabase(controllerDb, [inputRelease]);
    writeFileSync(evidencePath, JSON.stringify(evidence(inputRelease)));
    const argv = [
      '--controller-db', controllerDb,
      '--shadow-db', shadowDb,
      '--release', inputRelease.batchId,
      '--evidence', evidencePath,
    ];
    const first = JSON.parse(runQueueTriageShadowCommand({
      argv,
      observedAt: '2026-07-29T18:30:00Z',
    }));
    const replay = JSON.parse(runQueueTriageShadowCommand({
      argv,
      observedAt: '2026-07-29T18:40:00Z',
    }));
    assert.equal(first.reportsInserted, 1);
    assert.equal(replay.reportsReplayed, 1);
    assert.equal(replay.outcomes[0].report, 'replayed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('explicit release mode rejects mismatched evidence before shadow storage is created', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-runner-triage-shadow-mismatch-'));
  const controllerDb = join(directory, 'controller.sqlite');
  const shadowDb = join(directory, 'shadow.sqlite');
  const evidencePath = join(directory, 'evidence.json');
  const inputRelease = release();
  try {
    createControllerDatabase(controllerDb, [inputRelease]);
    const wrongEvidence = evidence(inputRelease);
    wrongEvidence.changedItems[0].number = 999;
    writeFileSync(evidencePath, JSON.stringify(wrongEvidence));
    assert.throws(
      () => runQueueTriageShadowCommand({
        argv: [
          '--controller-db', controllerDb,
          '--shadow-db', shadowDb,
          '--release', inputRelease.batchId,
          '--evidence', evidencePath,
        ],
      }),
      /object identity does not match/,
    );
    assert.equal(existsSync(shadowDb), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Markdown output contains compact RUN_CONTROL evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-runner-triage-shadow-markdown-'));
  const controllerDb = join(directory, 'controller.sqlite');
  const shadowDb = join(directory, 'shadow.sqlite');
  try {
    createControllerDatabase(controllerDb, [release()]);
    const output = runQueueTriageShadowCommand({
      argv: [
        '--controller-db', controllerDb,
        '--shadow-db', shadowDb,
        '--pending',
        '--format', 'markdown',
      ],
    });
    assert.match(output, /shadow observation/);
    assert.match(output, /RUN_CONTROL/);
    assert.doesNotMatch(output, new RegExp(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
