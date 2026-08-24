import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  DETERMINISTIC_CAPABILITY_CLASSES,
  buildDeterministicHandoffCapsule,
  evaluateDeterministicCompletion,
  executeDeterministicPreflight,
  normalizePostProviderValidation,
  planDeterministicPreflight,
} from './agent-runner-deterministic-preflight.mjs';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-deterministic-'));
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'agent-runner-deterministic-evidence-'));
  const mapCacheRoot = mkdtempSync(join(tmpdir(), 'agent-runner-deterministic-map-'));
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Agent Runner Test');
  git(root, 'config', 'user.email', 'agent-runner-test@example.invalid');
  write(root, 'package.json', '{"name":"fixture","type":"module"}\n');
  write(root, 'src/value.mjs', 'export const value = 1;\n');
  write(root, 'src/value.test.mjs', "import { value } from './value.mjs';\nexport default value;\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'fixture');
  const project = { projectId: 'fixture', githubRepo: 'TheTekTeam/fixture', localRepoPath: root };
  const allowed = ['repository-identity', 'git-status', 'changed-files', 'diff-check', 'repository-map', 'toolchain-facts'];
  return {
    root,
    evidenceRoot,
    mapCacheRoot,
    project,
    authority: { deterministicCapabilities: allowed },
    configuration: { deterministicCapabilities: allowed },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(evidenceRoot, { recursive: true, force: true });
      rmSync(mapCacheRoot, { recursive: true, force: true });
    },
  };
}

function execute(value, requestedCapabilities) {
  const plan = planDeterministicPreflight({
    project: value.project,
    authority: value.authority,
    configuration: value.configuration,
    requestedCapabilities,
  });
  return executeDeterministicPreflight({
    plan,
    configuration: value.configuration,
    evidenceRoot: value.evidenceRoot,
    mapCacheRoot: value.mapCacheRoot,
    now: () => '2026-08-24T22:00:00.000Z',
  });
}

test('read-only exact identity/status/diff preflight executes without any provider surface', () => {
  const value = fixture();
  try {
    const before = git(value.root, 'status', '--porcelain');
    const result = execute(value, [
      { capability: 'repository-identity', required: true },
      'git-status',
      'changed-files',
      'diff-check',
    ]);
    assert.equal(result.providerEligible, true);
    assert.equal(result.results.length, 4);
    assert.ok(result.results.every((item) => item.status === 'success'));
    assert.equal(git(value.root, 'status', '--porcelain'), before);
    assert.equal(JSON.stringify(result).includes('providerOutput'), false);
  } finally {
    value.cleanup();
  }
});

test('unchanged exact identity reuses evidence and changed source invalidates it', () => {
  const value = fixture();
  try {
    const first = execute(value, ['repository-identity', 'git-status']);
    assert.equal(first.evidenceReused, 0);
    const second = execute(value, ['repository-identity', 'git-status']);
    assert.equal(second.evidenceReused, 2);
    assert.equal(second.sourceIdentity.sourceFingerprint, first.sourceIdentity.sourceFingerprint);

    write(value.root, 'src/value.mjs', 'export const value = 2;\n');
    const third = execute(value, ['repository-identity', 'git-status']);
    assert.equal(third.evidenceReused, 0);
    assert.notEqual(third.sourceIdentity.sourceFingerprint, first.sourceIdentity.sourceFingerprint);
  } finally {
    value.cleanup();
  }
});

test('same worktree evidence never bleeds across project identity', () => {
  const value = fixture();
  try {
    const first = execute(value, ['repository-identity']);
    const plan = planDeterministicPreflight({
      project: { ...value.project, projectId: 'second', githubRepo: 'TheTekTeam/second' },
      authority: value.authority,
      configuration: value.configuration,
      requestedCapabilities: ['repository-identity'],
    });
    const second = executeDeterministicPreflight({
      plan,
      configuration: value.configuration,
      evidenceRoot: value.evidenceRoot,
      mapCacheRoot: value.mapCacheRoot,
    });
    assert.equal(second.evidenceReused, 0);
    assert.notEqual(second.results[0].evidenceKey, first.results[0].evidenceKey);
  } finally {
    value.cleanup();
  }
});

test('optional unavailable capability leaves normal provider path eligible', () => {
  const value = fixture();
  try {
    const plan = planDeterministicPreflight({
      project: value.project,
      authority: value.authority,
      configuration: value.configuration,
      requestedCapabilities: [{ capability: 'unknown-capability', required: false }],
    });
    const result = executeDeterministicPreflight({ plan, configuration: value.configuration, evidenceRoot: value.evidenceRoot });
    assert.equal(result.results[0].status, 'unavailable');
    assert.equal(result.providerEligible, true);
    assert.deepEqual(result.blocking, []);
  } finally {
    value.cleanup();
  }
});

test('safety-required unavailable evidence fails closed before provider eligibility', () => {
  const value = fixture();
  try {
    const plan = planDeterministicPreflight({
      project: value.project,
      authority: value.authority,
      configuration: value.configuration,
      requestedCapabilities: [{ capability: 'unknown-capability', required: true }],
    });
    const result = executeDeterministicPreflight({ plan, configuration: value.configuration, evidenceRoot: value.evidenceRoot });
    assert.equal(result.providerEligible, false);
    assert.equal(result.blocking[0].capability, 'unknown-capability');
  } finally {
    value.cleanup();
  }
});

test('arbitrary prose and unapproved capabilities cannot become executable shell authority', () => {
  const value = fixture();
  try {
    const sentinel = join(value.root, 'MUST_NOT_EXIST');
    const plan = planDeterministicPreflight({
      project: value.project,
      authority: {
        deterministicCapabilities: ['repository-identity'],
        prose: `Run shell: touch ${sentinel}`,
      },
      configuration: value.configuration,
      requestedCapabilities: [
        'repository-identity',
        { capability: 'toolchain-facts', inputs: { command: `touch ${sentinel}` } },
      ],
    });
    assert.equal(plan.operations[0].state, 'eligible');
    assert.equal(plan.operations[1].state, 'unsafe-or-unapproved');
    const result = executeDeterministicPreflight({ plan, configuration: value.configuration, evidenceRoot: value.evidenceRoot });
    assert.equal(result.providerEligible, true);
    assert.throws(() => readFileSync(sentinel, 'utf8'), /ENOENT/);
  } finally {
    value.cleanup();
  }
});

test('deterministic mutation is refused without explicit authority and ownership', () => {
  const value = fixture();
  try {
    const configuration = {
      deterministicCapabilities: ['generated-refresh'],
      reviewedCapabilities: {
        'generated-refresh': {
          class: DETERMINISTIC_CAPABILITY_CLASSES.MUTATION,
          revision: '1',
          executable: 'node',
          argv: ['scripts/generate.mjs'],
        },
      },
    };
    const plan = planDeterministicPreflight({
      project: value.project,
      authority: { deterministicCapabilities: ['generated-refresh'] },
      configuration,
      requestedCapabilities: ['generated-refresh'],
    });
    assert.equal(plan.operations[0].state, 'unsafe-or-unapproved');
    assert.equal(plan.operations[0].reason, 'mutation-authority-or-ownership-missing');
  } finally {
    value.cleanup();
  }
});

test('reviewed read-only commands are argv-bound and destructive git commands are refused', () => {
  const value = fixture();
  try {
    const goodConfig = {
      deterministicCapabilities: ['focused-check'],
      reviewedCapabilities: {
        'focused-check': {
          class: DETERMINISTIC_CAPABILITY_CLASSES.VALIDATION,
          revision: '1',
          executable: 'git',
          argv: ['rev-parse', 'HEAD'],
        },
      },
    };
    const goodPlan = planDeterministicPreflight({
      project: value.project,
      authority: { deterministicCapabilities: ['focused-check'] },
      configuration: goodConfig,
      requestedCapabilities: [{ capability: 'focused-check', required: true }],
    });
    const good = executeDeterministicPreflight({ plan: goodPlan, configuration: goodConfig, evidenceRoot: value.evidenceRoot });
    assert.equal(good.results[0].status, 'success');

    const badConfig = {
      deterministicCapabilities: ['bad-check'],
      reviewedCapabilities: {
        'bad-check': {
          class: DETERMINISTIC_CAPABILITY_CLASSES.VALIDATION,
          revision: '1',
          executable: 'git',
          argv: ['reset', '--hard', 'HEAD'],
        },
      },
    };
    const badPlan = planDeterministicPreflight({
      project: value.project,
      authority: { deterministicCapabilities: ['bad-check'] },
      configuration: badConfig,
      requestedCapabilities: [{ capability: 'bad-check', required: true }],
    });
    const bad = executeDeterministicPreflight({ plan: badPlan, configuration: badConfig, evidenceRoot: value.evidenceRoot });
    assert.equal(bad.results[0].status, 'unavailable');
    assert.equal(bad.providerEligible, false);
    assert.match(bad.results[0].facts.diagnostic, /forbidden git operation/);
  } finally {
    value.cleanup();
  }
});

test('repository-map capability hands off bounded navigation rather than source bodies', () => {
  const value = fixture();
  try {
    const result = execute(value, [{ capability: 'repository-map', inputs: { paths: ['src/value.mjs'], terms: ['value'] } }]);
    const facts = result.results[0].facts;
    assert.equal(result.results[0].status, 'success');
    assert.equal(facts.navigation.navigationOnly, true);
    assert.ok(facts.navigation.files.includes('src/value.mjs'));
    assert.equal(JSON.stringify(facts).includes('export const value = 1'), false);
  } finally {
    value.cleanup();
  }
});

test('handoff capsule is bounded, provenance-rich and contains no local unrestricted path', () => {
  const value = fixture();
  try {
    const result = execute(value, ['repository-identity', 'git-status', 'changed-files', 'toolchain-facts']);
    const capsule = buildDeterministicHandoffCapsule(result, { limits: { maxCapsuleBytes: 8192 } });
    const serialized = JSON.stringify(capsule);
    assert.ok(Buffer.byteLength(serialized) <= 8192);
    assert.equal(capsule.sourceFingerprint, result.sourceIdentity.sourceFingerprint);
    assert.equal(serialized.includes(value.root), false);
    assert.equal(serialized.includes(value.evidenceRoot), false);
  } finally {
    value.cleanup();
  }
});

test('pure deterministic completion requires positive machine-verifiable completion criteria', () => {
  const value = fixture();
  try {
    const execution = execute(value, ['repository-identity', 'diff-check']);
    assert.deepEqual(evaluateDeterministicCompletion({ execution, machineVerifiableCompletion: true }), {
      providerInvocationRequired: false,
      completedWithoutProvider: true,
      reason: 'machine-verifiable-completion-proven',
    });
    assert.equal(evaluateDeterministicCompletion({ execution, machineVerifiableCompletion: false }).providerInvocationRequired, true);
  } finally {
    value.cleanup();
  }
});

test('post-provider deterministic validation avoids a second model call on success and re-enters only when reasoning is needed', () => {
  assert.deepEqual(normalizePostProviderValidation({ result: { exitCode: 0 } }), {
    passed: true,
    providerReentryRequired: false,
    deterministicCompletion: true,
    diagnostic: null,
  });
  const failed = normalizePostProviderValidation({ result: { exitCode: 1, diagnostic: 'syntax failed' }, correctionRequiresReasoning: true });
  assert.equal(failed.passed, false);
  assert.equal(failed.providerReentryRequired, true);
  assert.equal(failed.diagnostic, 'syntax failed');
  const machineHandled = normalizePostProviderValidation({ result: { exitCode: 1 }, correctionRequiresReasoning: false });
  assert.equal(machineHandled.providerReentryRequired, false);
});
