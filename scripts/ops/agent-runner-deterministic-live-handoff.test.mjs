import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  BASELINE_LIVE_READONLY_CAPABILITIES,
  buildLiveDeterministicHandoff,
  renderLiveDeterministicHandoffForProvider,
  validateLiveDeterministicHandoff,
} from './agent-runner-deterministic-live-handoff.mjs';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-live-handoff-'));
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'agent-runner-live-evidence-'));
  const mapCacheRoot = mkdtempSync(join(tmpdir(), 'agent-runner-live-map-'));
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Agent Runner Test');
  git(root, 'config', 'user.email', 'agent-runner-test@example.invalid');
  write(root, 'package.json', JSON.stringify({ name: 'fixture', type: 'module' }));
  write(root, 'src/index.mjs', 'export const answer = 42;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'fixture');
  return {
    project: { projectId: 'fixture', githubRepo: 'TheTekTeam/fixture', localRepoPath: root },
    admission: {
      admission: { allowed: true },
      current: {
        issueNumber: 319,
        preflightFingerprint: `sha256:${'a'.repeat(64)}`,
        resolvedAgentId: 'claude-code-cli',
      },
    },
    root, evidenceRoot, mapCacheRoot,
    cleanup() { rmSync(root, { recursive: true, force: true }); rmSync(evidenceRoot, { recursive: true, force: true }); rmSync(mapCacheRoot, { recursive: true, force: true }); },
  };
}

test('baseline live capability set is read-only discovery only', () => {
  assert.deepEqual(BASELINE_LIVE_READONLY_CAPABILITIES, [
    'repository-identity', 'git-status', 'changed-files', 'repository-map', 'toolchain-facts',
  ]);
  assert.ok(BASELINE_LIVE_READONLY_CAPABILITIES.every((name) => !/test|build|mutat|shell|publish|github/i.test(name)));
});

test('admitted candidate receives exact-source bounded deterministic evidence for provider consumption', () => {
  const value = fixture();
  try {
    const result = buildLiveDeterministicHandoff({
      project: value.project,
      candidateAdmission: value.admission,
      evidenceRoot: value.evidenceRoot,
      mapCacheRoot: value.mapCacheRoot,
      now: () => '2026-08-25T00:00:00.000Z',
    });
    assert.equal(result.available, true);
    assert.equal(result.issueNumber, 319);
    assert.match(result.sourceFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.ok(result.results.length >= 4);
    assert.equal(validateLiveDeterministicHandoff(result, { issueNumber: 319 }).valid, true);
    const rendered = renderLiveDeterministicHandoffForProvider(result);
    assert.ok(rendered.includes('exact deterministic evidence'));
    assert.ok(Buffer.byteLength(rendered) <= 10 * 1024);
  } finally { value.cleanup(); }
});

test('unchanged source reuses evidence and changed source invalidates it', () => {
  const value = fixture();
  try {
    const first = buildLiveDeterministicHandoff({ project: value.project, candidateAdmission: value.admission, evidenceRoot: value.evidenceRoot, mapCacheRoot: value.mapCacheRoot });
    const second = buildLiveDeterministicHandoff({ project: value.project, candidateAdmission: value.admission, evidenceRoot: value.evidenceRoot, mapCacheRoot: value.mapCacheRoot });
    assert.ok(second.evidenceReused > first.evidenceReused);
    assert.equal(second.sourceFingerprint, first.sourceFingerprint);
    write(value.root, 'src/index.mjs', 'export const answer = 43;\n');
    const changed = buildLiveDeterministicHandoff({ project: value.project, candidateAdmission: value.admission, evidenceRoot: value.evidenceRoot, mapCacheRoot: value.mapCacheRoot });
    assert.notEqual(changed.sourceFingerprint, first.sourceFingerprint);
  } finally { value.cleanup(); }
});

test('wrong issue binding and tampered handoff are refused', () => {
  const value = fixture();
  try {
    const result = buildLiveDeterministicHandoff({ project: value.project, candidateAdmission: value.admission, evidenceRoot: value.evidenceRoot, mapCacheRoot: value.mapCacheRoot });
    assert.equal(validateLiveDeterministicHandoff(result, { issueNumber: 999 }).reason, 'handoff-issue-mismatch');
    assert.equal(validateLiveDeterministicHandoff({ ...result, sourceFingerprint: `sha256:${'b'.repeat(64)}` }).reason, 'handoff-digest-mismatch');
  } finally { value.cleanup(); }
});

test('unadmitted candidate cannot produce provider handoff', () => {
  const value = fixture();
  try {
    assert.throws(() => buildLiveDeterministicHandoff({
      project: value.project,
      candidateAdmission: { admission: { allowed: false }, current: value.admission.current },
      evidenceRoot: value.evidenceRoot,
      mapCacheRoot: value.mapCacheRoot,
    }), /candidate was not admitted/);
  } finally { value.cleanup(); }
});
