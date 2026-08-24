import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  assertRepositoryMapIdentity,
  buildRepositoryMap,
  buildRepositoryNavigationCapsule,
  captureRepositorySourceIdentity,
  loadOrBuildRepositoryMap,
  queryRepositoryMap,
  tryRepositoryNavigationCapsule,
} from './agent-runner-repository-map.mjs';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-repository-map-'));
  const cacheRoot = mkdtempSync(join(tmpdir(), 'agent-runner-repository-map-cache-'));
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Agent Runner Test');
  git(root, 'config', 'user.email', 'agent-runner-test@example.invalid');
  write(root, '.gitignore', 'node_modules/\ndist/\n');
  write(root, 'AGENTS.md', '# Rules\nRead source before editing.\n');
  write(root, 'package.json', JSON.stringify({ name: 'fixture-app', type: 'module', main: './src/math.mjs', workspaces: ['packages/*'] }, null, 2));
  write(root, 'src/math.mjs', 'export const add = (a, b) => a + b;\n');
  write(root, 'src/math.test.mjs', "import { add } from './math.mjs';\nexport const result = add(1, 2);\n");
  write(root, 'src/unrelated.mjs', 'export const unrelated = true;\n');
  write(root, 'packages/tool/package.json', JSON.stringify({ name: '@fixture/tool', type: 'module', main: './index.mjs' }, null, 2));
  write(root, 'packages/tool/index.mjs', "import { add } from '../../src/math.mjs';\nexport const three = add(1, 2);\n");
  write(root, '.env', 'SECRET_VALUE=must-never-be-serialized\n');
  write(root, 'node_modules/secret-package/index.js', 'const credential = "must-never-be-mapped";\n');
  write(root, 'dist/generated.js', 'const generated = true;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'fixture');
  return {
    root,
    cacheRoot,
    project: { projectId: 'fixture', githubRepo: 'TheTekTeam/fixture' },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(cacheRoot, { recursive: true, force: true });
    },
  };
}

test('exact unchanged source reuses a content-addressed map and dirty source invalidates it', () => {
  const value = fixture();
  try {
    const first = loadOrBuildRepositoryMap({ project: value.project, repositoryRoot: value.root, cacheRoot: value.cacheRoot });
    assert.equal(first.reused, false);
    const second = loadOrBuildRepositoryMap({ project: value.project, repositoryRoot: value.root, cacheRoot: value.cacheRoot });
    assert.equal(second.reused, true);
    assert.equal(second.map.source.sourceFingerprint, first.map.source.sourceFingerprint);
    assert.equal(second.cachePath, first.cachePath);

    write(value.root, 'src/math.mjs', 'export const add = (a, b) => Number(a) + Number(b);\n');
    const dirty = loadOrBuildRepositoryMap({ project: value.project, repositoryRoot: value.root, cacheRoot: value.cacheRoot });
    assert.equal(dirty.reused, false);
    assert.equal(dirty.map.source.dirty, true);
    assert.notEqual(dirty.map.source.sourceFingerprint, first.map.source.sourceFingerprint);
    assert.notEqual(dirty.cachePath, first.cachePath);

    const dirtyAgain = loadOrBuildRepositoryMap({ project: value.project, repositoryRoot: value.root, cacheRoot: value.cacheRoot });
    assert.equal(dirtyAgain.reused, true);
    assert.equal(dirtyAgain.map.source.sourceFingerprint, dirty.map.source.sourceFingerprint);
  } finally {
    value.cleanup();
  }
});

test('wrong project, repository or exact source identity is refused', () => {
  const value = fixture();
  try {
    const map = buildRepositoryMap({ project: value.project, repositoryRoot: value.root });
    assert.equal(assertRepositoryMapIdentity(map, {
      projectId: value.project.projectId,
      githubRepo: value.project.githubRepo,
      sourceFingerprint: map.source.sourceFingerprint,
    }), true);
    assert.throws(() => assertRepositoryMapIdentity(map, {
      projectId: 'other-project',
      githubRepo: value.project.githubRepo,
      sourceFingerprint: map.source.sourceFingerprint,
    }), /project identity mismatch/);
    assert.throws(() => assertRepositoryMapIdentity(map, {
      projectId: value.project.projectId,
      githubRepo: 'TheTekTeam/other',
      sourceFingerprint: map.source.sourceFingerprint,
    }), /repository identity mismatch/);
    assert.throws(() => assertRepositoryMapIdentity(map, {
      projectId: value.project.projectId,
      githubRepo: value.project.githubRepo,
      sourceFingerprint: `sha256:${'0'.repeat(64)}`,
    }), /source fingerprint mismatch/);
  } finally {
    value.cleanup();
  }
});

test('map contains bounded structural metadata but no source bodies, secrets or generated dependency trees', () => {
  const value = fixture();
  try {
    const map = buildRepositoryMap({ project: value.project, repositoryRoot: value.root });
    const serialized = JSON.stringify(map);
    assert.match(serialized, /src\/math\.mjs/);
    assert.match(serialized, /packages\/tool\/package\.json/);
    assert.doesNotMatch(serialized, /must-never-be-serialized/);
    assert.doesNotMatch(serialized, /must-never-be-mapped/);
    assert.doesNotMatch(serialized, /node_modules\/secret-package\/index\.js/);
    assert.doesNotMatch(serialized, /dist\/generated\.js/);
    assert.ok(map.excludedAreas.some((entry) => entry.path === 'node_modules' && entry.reason === 'dependencies'));
    assert.ok(map.excludedAreas.some((entry) => entry.path === 'dist' && entry.reason === 'generated'));
    assert.ok(map.languages.some((entry) => entry.language === 'javascript'));
    assert.ok(map.tooling.includes('node'));
    assert.ok(map.packages.some((entry) => entry.name === 'fixture-app' && entry.root === '.'));
    assert.ok(map.instructions.some((entry) => entry.path === 'AGENTS.md'));
  } finally {
    value.cleanup();
  }
});

test('bounded queries expose files, tests, package, dependency and applicable instruction navigation only', () => {
  const value = fixture();
  try {
    const map = buildRepositoryMap({ project: value.project, repositoryRoot: value.root });
    const fileQuery = queryRepositoryMap(map, { kind: 'files', term: 'src/' }, { maxItems: 2, maxBytes: 4096 });
    assert.equal(fileQuery.files.length, 2);
    assert.equal(fileQuery.truncated, true);

    const tests = queryRepositoryMap(map, { kind: 'tests', path: 'src/math.mjs' });
    assert.ok(tests.files.includes('src/math.test.mjs'));

    const pkg = queryRepositoryMap(map, { kind: 'package', path: 'packages/tool/index.mjs' });
    assert.equal(pkg.packages[0].name, '@fixture/tool');

    const deps = queryRepositoryMap(map, { kind: 'dependencies', path: 'packages/tool/index.mjs' });
    assert.deepEqual(deps.outgoing, [{ source: 'packages/tool/index.mjs', target: 'src/math.mjs' }]);

    const instructions = queryRepositoryMap(map, { kind: 'instructions', path: 'src/math.mjs' });
    assert.ok(instructions.instructions.some((entry) => entry.path === 'AGENTS.md'));

    assert.throws(() => queryRepositoryMap(map, { kind: 'subtree', path: '../escape' }), /repository-relative/);
    assert.throws(() => queryRepositoryMap(map, { kind: 'shell', term: 'anything' }), /unsupported repository map query/);
  } finally {
    value.cleanup();
  }
});

test('task navigation capsule is small, relevant and explicitly non-authoritative', () => {
  const value = fixture();
  try {
    const map = buildRepositoryMap({ project: value.project, repositoryRoot: value.root });
    const capsule = buildRepositoryNavigationCapsule(map, { paths: ['src/math.mjs'], terms: ['math'] }, { maxItems: 5, maxBytes: 4096 });
    assert.equal(capsule.sourceFingerprint, map.source.sourceFingerprint);
    assert.equal(capsule.mapDigest, map.mapDigest);
    assert.equal(capsule.navigationOnly, true);
    assert.ok(capsule.files.includes('src/math.mjs'));
    assert.ok(capsule.tests.includes('src/math.test.mjs'));
    assert.ok(capsule.instructions.includes('AGENTS.md'));
    assert.ok(!capsule.files.includes('src/unrelated.mjs'));
    assert.ok(Buffer.byteLength(JSON.stringify(capsule)) <= 4096);
  } finally {
    value.cleanup();
  }
});

test('corrupt cache is rejected and rebuilt without changing correctness', () => {
  const value = fixture();
  try {
    const first = loadOrBuildRepositoryMap({ project: value.project, repositoryRoot: value.root, cacheRoot: value.cacheRoot });
    writeFileSync(first.cachePath, '{corrupt', 'utf8');
    const rebuilt = loadOrBuildRepositoryMap({ project: value.project, repositoryRoot: value.root, cacheRoot: value.cacheRoot });
    assert.equal(rebuilt.reused, false);
    assert.equal(rebuilt.map.source.sourceFingerprint, first.map.source.sourceFingerprint);
    assert.doesNotThrow(() => JSON.parse(readFileSync(rebuilt.cachePath, 'utf8')));
  } finally {
    value.cleanup();
  }
});

test('cache namespace isolates projects even against the same exact worktree', () => {
  const value = fixture();
  try {
    const first = loadOrBuildRepositoryMap({ project: value.project, repositoryRoot: value.root, cacheRoot: value.cacheRoot });
    const other = loadOrBuildRepositoryMap({
      project: { projectId: 'fixture-two', githubRepo: 'TheTekTeam/fixture-two' },
      repositoryRoot: value.root,
      cacheRoot: value.cacheRoot,
    });
    assert.equal(other.reused, false);
    assert.notEqual(dirname(other.cachePath), dirname(first.cachePath));
    assert.notEqual(other.map.mapDigest, first.map.mapDigest);
  } finally {
    value.cleanup();
  }
});

test('optional map failure returns a bounded unavailable result instead of blocking provider autonomy', () => {
  const missing = join(tmpdir(), `agent-runner-repository-map-missing-${process.pid}-${Date.now()}`);
  const result = tryRepositoryNavigationCapsule({
    project: { projectId: 'fixture', githubRepo: 'TheTekTeam/fixture' },
    repositoryRoot: missing,
    cacheRoot: join(missing, 'cache'),
  }, { terms: ['src'] });
  assert.equal(result.available, false);
  assert.equal(result.reused, false);
  assert.equal(result.capsule, null);
  assert.equal(result.reason, 'repository-map-unavailable');
  assert.ok(result.detail.length <= 300);
});

test('source identity is clean at commit and changes for one uncommitted source byte', () => {
  const value = fixture();
  try {
    const clean = captureRepositorySourceIdentity({ repositoryRoot: value.root });
    assert.equal(clean.dirty, false);
    assert.equal(clean.dirtyFingerprint, 'clean');
    write(value.root, 'src/math.mjs', 'export const add = (a, b) => a - -b;\n');
    const dirty = captureRepositorySourceIdentity({ repositoryRoot: value.root });
    assert.equal(dirty.dirty, true);
    assert.notEqual(dirty.sourceFingerprint, clean.sourceFingerprint);
    assert.match(dirty.dirtyFingerprint, /^sha256:[a-f0-9]{64}$/);
  } finally {
    value.cleanup();
  }
});
