import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  MANIFEST_STATUS_LOCKED,
  MANIFEST_STATUS_TRANSFERRED,
  evaluateManifestFiles,
  transferRecordProblems,
} from './agent-runner-manifest-provenance.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function fakeFs({ existing = {}, hashes = {} } = {}) {
  return {
    fileExists: (path) => Object.prototype.hasOwnProperty.call(existing, path) ? existing[path] : true,
    sha256OfFile: (path) => hashes[path],
  };
}

function validOwnership(overrides = {}) {
  return {
    canonicalRepository: 'TheTekTeam/agent-runner',
    transferredAt: '2026-07-21T12:00:00.000Z',
    reason: 'Repository-context boundary fix for #686.',
    reference: 'https://github.com/TheTekTeam/agent-runner/pull/19',
    ...overrides,
  };
}

function validProvenance(overrides = {}) {
  return {
    sourceRepository: 'TheTekTeam/modelspend',
    sourceCommit: 'c6e18c00f17b92f5ac27ba2dbe37c6ba768c4dc0',
    importedSha256: HASH_A,
    ...overrides,
  };
}

function applyOwnershipTransfers(manifest, ownership) {
  const transfers = new Map((ownership.transfers || []).map((entry) => [entry.path, entry]));
  return (manifest.files || []).map((entry) => {
    const transfer = transfers.get(entry.path);
    if (!transfer) return entry;
    return {
      path: entry.path,
      mode: entry.mode,
      status: MANIFEST_STATUS_TRANSFERRED,
      provenance: {
        sourceRepository: manifest.sourceRepository,
        sourceCommit: manifest.sourceCommit,
        importedSha256: entry.sha256 || entry.provenance?.importedSha256,
      },
      ownership: transfer.ownership,
    };
  });
}

test('an unchanged locked import with a matching hash passes', () => {
  const files = [{ path: 'a.mjs', status: MANIFEST_STATUS_LOCKED, sha256: HASH_A }];
  const result = evaluateManifestFiles(files, fakeFs({ hashes: { 'a.mjs': HASH_A } }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.locked, ['a.mjs']);
  assert.deepEqual(result.transferred, []);
});

test('an entry with no status field defaults to locked (original single-status manifest shape)', () => {
  const files = [{ path: 'a.mjs', sha256: HASH_A }];
  const result = evaluateManifestFiles(files, fakeFs({ hashes: { 'a.mjs': HASH_A } }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.locked, ['a.mjs']);
});

test('a changed locked import fails with a hash mismatch, not a silent pass', () => {
  const files = [{ path: 'a.mjs', status: MANIFEST_STATUS_LOCKED, sha256: HASH_A }];
  const result = evaluateManifestFiles(files, fakeFs({ hashes: { 'a.mjs': HASH_B } }));
  assert.deepEqual(result.errors, ['hash mismatch: a.mjs']);
  assert.deepEqual(result.locked, []);
  assert.deepEqual(result.invalid, ['a.mjs']);
});

test('a correctly declared ownership-transferred file may diverge from its imported hash freely', () => {
  const files = [{
    path: 'b.mjs',
    status: MANIFEST_STATUS_TRANSFERRED,
    provenance: validProvenance(),
    ownership: validOwnership(),
  }];
  const result = evaluateManifestFiles(files, fakeFs({ hashes: { 'b.mjs': HASH_B } }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.transferred, ['b.mjs']);
  assert.deepEqual(result.locked, []);
});

test('a transferred file must still exist -- ownership does not excuse deletion', () => {
  const files = [{
    path: 'b.mjs',
    status: MANIFEST_STATUS_TRANSFERRED,
    provenance: validProvenance(),
    ownership: validOwnership(),
  }];
  const result = evaluateManifestFiles(files, fakeFs({ existing: { 'b.mjs': false } }));
  assert.deepEqual(result.errors, ['missing: b.mjs']);
  assert.deepEqual(result.transferred, []);
  assert.deepEqual(result.invalid, ['b.mjs']);
});

test('a locked entry missing from disk fails closed, not treated as vacuously transferred', () => {
  const files = [{ path: 'a.mjs', status: MANIFEST_STATUS_LOCKED, sha256: HASH_A }];
  const result = evaluateManifestFiles(files, fakeFs({ existing: { 'a.mjs': false } }));
  assert.deepEqual(result.errors, ['missing: a.mjs']);
});

test('an unrecognized status value is rejected, not silently treated as mutable', () => {
  const files = [{ path: 'c.mjs', status: 'deprecated', sha256: HASH_A }];
  const result = evaluateManifestFiles(files, fakeFs({ hashes: { 'c.mjs': HASH_A } }));
  assert.deepEqual(result.errors, ['unknown status "deprecated" for c.mjs']);
  assert.deepEqual(result.locked, []);
  assert.deepEqual(result.transferred, []);
});

test('a transferred entry with missing provenance/ownership fields is rejected as malformed', () => {
  const files = [{ path: 'd.mjs', status: MANIFEST_STATUS_TRANSFERRED }];
  const result = evaluateManifestFiles(files, fakeFs());
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /malformed transfer record for d\.mjs/);
  assert.match(result.errors[0], /missing provenance/);
  assert.match(result.errors[0], /missing ownership/);
});

test('transferRecordProblems flags each missing/invalid field individually', () => {
  assert.deepEqual(
    transferRecordProblems({ provenance: validProvenance({ sourceCommit: '' }), ownership: validOwnership({ reference: '' }) }),
    ['provenance.sourceCommit', 'ownership.reference'],
  );
  assert.deepEqual(
    transferRecordProblems({ provenance: validProvenance({ importedSha256: 'not-a-hash' }), ownership: validOwnership() }),
    ['provenance.importedSha256'],
  );
  assert.deepEqual(
    transferRecordProblems({ provenance: validProvenance(), ownership: validOwnership({ transferredAt: 'not-a-date' }) }),
    ['ownership.transferredAt'],
  );
  assert.deepEqual(transferRecordProblems({ provenance: validProvenance(), ownership: validOwnership() }), []);
});

test('a manifest entry with no path is rejected rather than silently skipped', () => {
  const files = [{ status: MANIFEST_STATUS_LOCKED, sha256: HASH_A }];
  const result = evaluateManifestFiles(files, fakeFs());
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /manifest entry missing a path/);
});

test('mixed locked and transferred entries are each evaluated independently and both surface in the summary', () => {
  const files = [
    { path: 'locked.mjs', status: MANIFEST_STATUS_LOCKED, sha256: HASH_A },
    { path: 'moved.mjs', status: MANIFEST_STATUS_TRANSFERRED, provenance: validProvenance(), ownership: validOwnership() },
  ];
  const result = evaluateManifestFiles(files, fakeFs({ hashes: { 'locked.mjs': HASH_A, 'moved.mjs': HASH_B } }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.locked, ['locked.mjs']);
  assert.deepEqual(result.transferred, ['moved.mjs']);
});

test('migration manifest plus canonical ownership registry validates every imported file', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const manifest = JSON.parse(readFileSync(join(root, 'MIGRATION-MANIFEST.json'), 'utf8'));
  const ownership = JSON.parse(readFileSync(join(root, 'CANONICAL-OWNERSHIP.json'), 'utf8'));
  const manifestTransferredPaths = manifest.files
    .filter((entry) => entry.status === MANIFEST_STATUS_TRANSFERRED)
    .map((entry) => entry.path)
    .sort();
  assert.deepEqual(manifestTransferredPaths, [
    'scripts/ops/claude-runner-cron.mjs',
    'scripts/ops/claude-runner-cron.test.mjs',
    'scripts/ops/claude-runner-review-followup.mjs',
    'scripts/ops/claude-runner.mjs',
    'scripts/ops/claude-runner.test.mjs',
  ]);

  const effectiveFiles = applyOwnershipTransfers(manifest, ownership);
  const result = evaluateManifestFiles(effectiveFiles, {
    fileExists: (path) => existsAt(join(root, path)),
    sha256OfFile: (path) => sha256At(join(root, path)),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.transferred.length, manifestTransferredPaths.length + ownership.transfers.length);
  assert.equal(result.locked.length, manifest.files.length - result.transferred.length);
});

function existsAt(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function sha256At(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
