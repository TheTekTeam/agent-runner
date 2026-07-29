import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildQueueTriageParityCandidate,
  compareQueueTriageParity,
  normalizeQueueTriageParityCandidate,
} from './agent-runner-queue-triage-parity.mjs';

function candidate(overrides = {}) {
  return {
    schemaVersion: 1,
    complete: true,
    releaseId: 'batch-1',
    projectId: 'alpha',
    repository: 'Owner/Alpha',
    settlement: { releasePayloadFingerprint: `sha256:${'a'.repeat(64)}`, shaEvidenceFingerprint: `sha256:${'b'.repeat(64)}`, queryComplete: true },
    inspected: [{ kind: 'issue', number: 7, updatedAt: '2026-07-29T18:00:00Z', labelsFingerprint: `sha256:${'c'.repeat(64)}` }],
    actionPlans: [],
    exceptions: [],
    ...overrides,
  };
}

test('matches normalized candidates independent of input ordering', () => {
  const first = candidate({
    actionPlans: [
      { kind: 'issue', number: 9, action: 'replace_labels', intendedFullLabelSet: ['status:blocked', 'priority:P0'], evidenceFingerprint: `sha256:${'2'.repeat(64)}` },
      { kind: 'issue', number: 7, action: 'replace_labels', intendedFullLabelSet: ['priority:P0', 'status:blocked'], evidenceFingerprint: `sha256:${'1'.repeat(64)}` },
    ],
  });
  const second = candidate({ actionPlans: [...first.actionPlans].reverse() });
  const result = compareQueueTriageParity(first, second, { comparedAt: '2026-07-29T18:10:00Z' });
  assert.equal(result.status, 'match');
  assert.deepEqual(result.mismatchFields, []);
});

test('classifies intended-action disagreement as material', () => {
  const result = compareQueueTriageParity(
    candidate(),
    candidate({ actionPlans: [{ kind: 'issue', number: 7, action: 'close_issue', intendedFullLabelSet: null, evidenceFingerprint: `sha256:${'d'.repeat(64)}` }] }),
  );
  assert.equal(result.status, 'material_disagreement');
  assert.deepEqual(result.mismatchFields, ['action_plans']);
});

test('incomplete evidence remains incomplete even when normalized outputs otherwise match', () => {
  const result = compareQueueTriageParity(candidate({ complete: false }), candidate());
  assert.equal(result.status, 'incomplete');
});

test('rejects raw body or token fields', () => {
  assert.throws(() => normalizeQueueTriageParityCandidate({ ...candidate(), body: 'raw' }), /forbidden/);
  assert.throws(() => normalizeQueueTriageParityCandidate({ ...candidate(), nested: { token: 'secret' } }), /forbidden/);
});

test('builds the agent candidate from live evidence and dry-run report', () => {
  const evidence = {
    releaseId: 'batch-1',
    project: { projectId: 'alpha', repository: 'Owner/Alpha' },
    changedItems: [{ kind: 'issue', number: 7, updatedAt: '2026-07-29T18:00:00Z', labels: ['status:ready'] }],
    rotatingItems: [],
    liveEvidence: {
      queryComplete: true,
      identity: { releasePayloadFingerprint: `sha256:${'a'.repeat(64)}`, shaEvidenceFingerprint: `sha256:${'b'.repeat(64)}` },
    },
  };
  const report = { releaseId: 'batch-1', project: { projectId: 'alpha', repository: 'Owner/Alpha' }, actionPlans: [], exceptions: [] };
  const built = buildQueueTriageParityCandidate({ evidence, report });
  assert.equal(built.complete, true);
  assert.equal(built.inspected[0].number, 7);
  assert.match(built.fingerprint, /^sha256:/);
});

import { DatabaseSync } from 'node:sqlite';
import { ensureQueueTriageParitySchema, persistQueueTriageParity } from './agent-runner-queue-triage-parity.mjs';

function shadowDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE queue_triage_shadow_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO queue_triage_shadow_schema VALUES (1, '2026-07-29T18:00:00Z');
    CREATE TABLE queue_triage_shadow_observations(batch_id TEXT PRIMARY KEY);
    INSERT INTO queue_triage_shadow_observations VALUES ('batch-1');
  `);
  return db;
}

test('persists parity in the shadow database idempotently', () => {
  const db = shadowDb();
  try {
    const first = persistQueueTriageParity({ db, releaseId: 'batch-1', agentCandidate: candidate(), oversightCandidate: candidate(), comparedAt: '2026-07-29T18:10:00Z' });
    const replay = persistQueueTriageParity({ db, releaseId: 'batch-1', agentCandidate: candidate(), oversightCandidate: candidate(), comparedAt: '2026-07-29T18:20:00Z' });
    assert.equal(first.inserted, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.parityId, first.parityId);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM queue_triage_shadow_parity').get().count, 1);
  } finally { db.close(); }
});

test('parity extension rejects incompatible schema versions', () => {
  const db = shadowDb();
  try {
    ensureQueueTriageParitySchema(db);
    db.prepare('INSERT INTO queue_triage_parity_schema VALUES (?, ?)').run(2, '2026-07-29T18:01:00Z');
    assert.throws(() => ensureQueueTriageParitySchema(db), /unsupported/);
  } finally { db.close(); }
});

test('parity persistence requires the matching shadow observation', () => {
  const db = shadowDb();
  try {
    assert.throws(() => persistQueueTriageParity({ db, releaseId: 'batch-other', agentCandidate: candidate({ releaseId: 'batch-other' }), oversightCandidate: candidate({ releaseId: 'batch-other' }) }), /observation is required/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'queue_triage_parity_schema'").get().count, 0);
  } finally { db.close(); }
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseQueueTriageShadowArgs, runQueueTriageShadowCommand } from './agent-runner-queue-triage-shadow-command.mjs';

test('shadow command parser gates live GitHub and oversight to one explicit release', () => {
  assert.throws(() => parseQueueTriageShadowArgs(['--controller-db', 'a', '--shadow-db', 'b', '--pending', '--live-github', '--project-config', 'p']), /explicit --release/);
  assert.throws(() => parseQueueTriageShadowArgs(['--controller-db', 'a', '--shadow-db', 'b', '--release', 'r', '--live-github']), /project-config/);
  assert.throws(() => parseQueueTriageShadowArgs(['--controller-db', 'a', '--shadow-db', 'b', '--release', 'r', '--oversight', 'o']), /requires normalized or live evidence/);
  assert.throws(() => parseQueueTriageShadowArgs(['--controller-db', 'a', '--shadow-db', 'b', '--release', 'r', '--execute']), /not available/);
});

test('shadow command orchestrates live read-only evidence and parity without controller or GitHub writes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ar113-live-command-'));
  const controllerDb = join(directory, 'controller.sqlite');
  const shadowDbPath = join(directory, 'shadow.sqlite');
  const projectPath = join(directory, 'project.json');
  const oversightPath = join(directory, 'oversight.json');
  writeFileSync(controllerDb, 'fixture');
  writeFileSync(projectPath, JSON.stringify({ projectId: 'alpha', repository: 'Owner/Alpha' }));
  writeFileSync(oversightPath, JSON.stringify(candidate()));
  const inputRelease = { batchId: 'batch-1', state: 'pending', payload: { projectId: 'alpha', repository: 'Owner/Alpha', objectKind: 'issue', objectNumber: 7 } };
  const evidence = {
    releaseId: 'batch-1', project: { projectId: 'alpha', repository: 'Owner/Alpha' },
    changedItems: [{ kind: 'issue', number: 7, updatedAt: '2026-07-29T18:00:00Z', labels: [] }], rotatingItems: [],
    liveEvidence: { queryComplete: true, identity: { releasePayloadFingerprint: `sha256:${'a'.repeat(64)}`, shaEvidenceFingerprint: `sha256:${'b'.repeat(64)}` } },
  };
  const report = { releaseId: 'batch-1', project: { projectId: 'alpha', repository: 'Owner/Alpha' }, actionPlans: [], exceptions: [] };
  const store = {
    db: {},
    observeRelease: () => ({ inserted: true, replayed: false, observation: { payloadFingerprint: 'payload' } }),
    attachEvidenceAndPlan: () => ({ inserted: true, replayed: false, report }),
    close() {},
  };
  let readerClosed = false;
  try {
    const result = JSON.parse(runQueueTriageShadowCommand({
      argv: ['--controller-db', controllerDb, '--shadow-db', shadowDbPath, '--release', 'batch-1', '--live-github', '--project-config', projectPath, '--oversight', oversightPath],
      readerFactory: () => ({ getRelease: () => inputRelease, close: () => { readerClosed = true; } }),
      storeFactory: () => store,
      projectValidator: (value) => value,
      githubClientFactory: () => ({ requestJson() {} }),
      collectLiveEvidence: () => evidence,
      plan: () => report,
      buildParityCandidate: () => candidate(),
      normalizeParityCandidate: (value) => value,
      compareParity: () => ({ status: 'match' }),
      persistParity: () => ({ inserted: true, replayed: false, result: { status: 'match' } }),
      observedAt: '2026-07-29T18:10:00Z',
    }));
    assert.equal(result.parityStatus, 'match');
    assert.equal(result.runControl.githubReadsPerformed, true);
    assert.equal(result.runControl.githubReadOnly, true);
    assert.equal(result.runControl.githubWritesPerformed, false);
    assert.equal(result.runControl.controllerReleasesClaimed, 0);
    assert.equal(result.runControl.controllerReleasesFinished, 0);
    assert.equal(result.runControl.mutationAllowed, false);
    assert.equal(readerClosed, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
