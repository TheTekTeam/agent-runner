import assert from 'node:assert/strict'; import { test } from 'node:test';
import { normalizePrPublicationRequest } from './agent-runner-pr-contract.mjs'; import { PrTransactionStore } from './agent-runner-pr-transaction-store.mjs';
import { validateLocalExecutorPolicy } from './agent-runner-local-executor-policy.mjs';
import { validationProfileContractSha256 } from './agent-runner-validation-profile-contract.mjs';
import { PrControllerAttemptStore, PrControllerStateStore, runPrControllerCycle, runPrControllerSchedulerCycle, classifyPrSettlement } from './agent-runner-pr-controller.mjs';

const request = (overrides) => normalizePrPublicationRequest({ projectId: 'alpha-prj', repository: 'Owner/alpha', issueNumber: 154, sourceBranch: 'codex/pr-154', targetBranch: 'main', expectedHeadSha: 'a'.repeat(40), managerRevision: 'AR154-CONTROLLER-2026-08-09.1', managerFingerprint: `sha256:${'b'.repeat(64)}`, executorJobId: 'executor-job-00000001', requestId: 'request-0000000001', riskClass: 'R1', requiredValidationProfiles: [{ profile: 'focused', validationId: 'validation-00000001' }], approvedScope: 'Integrate PR.CONTRACT.1 into the closed-loop scheduler.', filesChanged: ['scripts/ops/x.mjs'], knownLimitations: ['No merge authority.'], ...overrides });

function fakeClient({ head = 'a'.repeat(40), base = 'b'.repeat(40), pulls = [] } = {}) {
  const calls = [];
  return { calls, request(method, url, fields) { calls.push({ method, url, fields }); if (url.includes('/issues/154')) return { number: 154, state: 'open' }; if (url.includes('/git/ref/heads/codex')) return { object: { sha: head } }; if (url.includes('/git/ref/heads/main')) return { object: { sha: base } }; if (url.includes('/pulls?')) return pulls; if (method === 'POST') { const created = { number: 9, draft: true, state: 'open', head: { sha: head, ref: 'codex/pr-154' }, base: { ref: 'main' }, body: fields.body, html_url: 'https://github.com/Owner/alpha/pull/9' }; pulls.push(created); return created; } throw new Error('unexpected call'); } };
}
// Validation evidence is issued per validation run and stays bound to the project it validated,
// so a second project must present its own evidence rather than reusing another project's record.
const VALIDATION_PROJECTS = new Map([['validation-00000001', 'alpha-prj'], ['validation-00000002', 'bravo-prj']]);
const evidence = { get: (validationId) => { const projectId = VALIDATION_PROJECTS.get(validationId); return projectId ? { schemaVersion: 1, state: 'succeeded', projectId, profile: 'focused', expectedSha: 'a'.repeat(40), observedSha: 'a'.repeat(40), profileContractSha256: 'c'.repeat(64), expiresAt: '2030-01-01T00:00:00.000Z' } : null; } };
const profileContracts = { focused: 'c'.repeat(64) };
const noChecks = async () => ({ queryComplete: true, checks: [] });
const succeededChecks = async () => ({ queryComplete: true, checks: [{ provider: 'check_run', externalId: '1', name: 'ci', status: 'completed', conclusion: 'success' }] });
const pendingChecks = async () => ({ queryComplete: true, checks: [{ provider: 'check_run', externalId: '1', name: 'ci', status: 'in_progress', conclusion: null }] });
const failedChecks = async () => ({ queryComplete: true, checks: [{ provider: 'check_run', externalId: '1', name: 'ci', status: 'completed', conclusion: 'failure' }] });

test('fixture success path publishes exactly one draft PR and persists stage evidence', async () => {
  const r = request(), client = fakeClient(), tx = new PrTransactionStore(':memory:'), controller = new PrControllerStateStore(':memory:');
  try {
    const result = await runPrControllerCycle({ request: r, controllerStore: controller, transactionStore: tx, client, evidenceStore: evidence, profileContracts, authorityCheck: async () => true, collectSettlement: succeededChecks, now: '2029-01-01T00:00:00.000Z' });
    assert.equal(result.prNumber, 9);
    assert.equal(result.stage, 'settled');
    assert.equal(result.settlementStatus, 'succeeded');
    assert.equal(client.calls.filter((c) => c.method === 'POST').length, 1);
    const state = controller.get(r.transactionId);
    assert.equal(state.stage, 'settled');
    assert.equal(state.prNumber, 9);
  } finally { tx.close(); controller.close(); }
});

test('restart before and after publication adopts/replays without duplicate PRs', async () => {
  const r = request(), client = fakeClient(), tx = new PrTransactionStore(':memory:'), controller = new PrControllerStateStore(':memory:');
  try {
    await runPrControllerCycle({ request: r, controllerStore: controller, transactionStore: tx, client, evidenceStore: evidence, profileContracts, authorityCheck: async () => true, collectSettlement: noChecks, now: '2029-01-01T00:00:00.000Z' });
    const replay = await runPrControllerCycle({ request: r, controllerStore: controller, transactionStore: tx, client, evidenceStore: evidence, profileContracts, authorityCheck: async () => true, collectSettlement: noChecks, now: '2029-01-01T00:05:00.000Z' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.prNumber, 9);
    assert.equal(client.calls.filter((c) => c.method === 'POST').length, 1);
  } finally { tx.close(); controller.close(); }
});

test('exact-head drift fails closed and records attention evidence', async () => {
  const r = request(), client = fakeClient({ head: 'd'.repeat(40) }), tx = new PrTransactionStore(':memory:'), controller = new PrControllerStateStore(':memory:');
  try {
    await assert.rejects(() => runPrControllerCycle({ request: r, controllerStore: controller, transactionStore: tx, client, evidenceStore: evidence, profileContracts, authorityCheck: async () => true, collectSettlement: noChecks }), (e) => e.code === 'source-head-changed');
    const state = controller.get(r.transactionId);
    assert.equal(state.stage, 'attention');
    assert.equal(state.reasonCode, 'source-head-changed');
    assert.equal(client.calls.filter((c) => c.method === 'POST').length, 0);
  } finally { tx.close(); controller.close(); }
});

test('missing manager authority fails closed without publishing', async () => {
  const r = request(), client = fakeClient(), tx = new PrTransactionStore(':memory:'), controller = new PrControllerStateStore(':memory:');
  try {
    await assert.rejects(() => runPrControllerCycle({ request: r, controllerStore: controller, transactionStore: tx, client, evidenceStore: evidence, profileContracts, authorityCheck: async () => false, collectSettlement: noChecks }), (e) => e.code === 'manager-authority-stale');
    assert.equal(controller.get(r.transactionId).stage, 'attention');
  } finally { tx.close(); controller.close(); }
});

test('settlement classification distinguishes pending, succeeded and failed', () => {
  assert.equal(classifyPrSettlement({ checks: [], queryComplete: true }).status, 'pending');
  assert.equal(classifyPrSettlement({ checks: [{ terminal: false, conclusion: null }] }).status, 'pending');
  assert.equal(classifyPrSettlement({ checks: [{ terminal: true, conclusion: 'success' }] }).status, 'succeeded');
  assert.equal(classifyPrSettlement({ checks: [{ terminal: true, conclusion: 'failure' }] }).status, 'failed');
});

test('non-terminal PR settlement releases the worker while preserving evidence', async () => {
  const r = request(), client = fakeClient(), tx = new PrTransactionStore(':memory:'), controller = new PrControllerStateStore(':memory:');
  try {
    const result = await runPrControllerCycle({ request: r, controllerStore: controller, transactionStore: tx, client, evidenceStore: evidence, profileContracts, authorityCheck: async () => true, collectSettlement: pendingChecks, now: '2029-01-01T00:00:00.000Z' });
    assert.equal(result.stage, 'settling');
    assert.equal(result.settlementStatus, 'pending');
    assert.equal(controller.get(r.transactionId).stage, 'settling');
  } finally { tx.close(); controller.close(); }
});

test('two materially different fixture repositories use the same controller path', async () => {
  const a = request(), b = request({ projectId: 'bravo-prj', repository: 'Other/bravo', requestId: 'request-0000000002', executorJobId: 'executor-job-00000002', requiredValidationProfiles: [{ profile: 'focused', validationId: 'validation-00000002' }] });
  const clientA = fakeClient(), clientB = fakeClient(), tx = new PrTransactionStore(':memory:'), controller = new PrControllerStateStore(':memory:');
  try {
    const resultA = await runPrControllerCycle({ request: a, controllerStore: controller, transactionStore: tx, client: clientA, evidenceStore: evidence, profileContracts, authorityCheck: async () => true, collectSettlement: failedChecks, now: '2029-01-01T00:00:00.000Z' });
    const resultB = await runPrControllerCycle({ request: b, controllerStore: controller, transactionStore: tx, client: clientB, evidenceStore: evidence, profileContracts, authorityCheck: async () => true, collectSettlement: succeededChecks, now: '2029-01-01T00:00:00.000Z' });
    assert.equal(resultA.settlementStatus, 'failed');
    assert.equal(resultB.settlementStatus, 'succeeded');
    assert.notEqual(a.transactionId, b.transactionId);
  } finally { tx.close(); controller.close(); }
});

// --- Production scheduler path (issue #154 controller integration) ---------

const projectConfig = (projectId, githubRepo) => Object.freeze({
  projectId, githubRepo, localRepoPath: `/tmp/${projectId}`, stateDbPath: `/tmp/${projectId}/state.sqlite`, lockPath: `/tmp/${projectId}/lock`,
});
const ALPHA = projectConfig('alpha-prj', 'Owner/alpha');
const BRAVO = projectConfig('bravo-prj', 'Other/bravo');
const registry = Object.freeze({ projects: [ALPHA, BRAVO], projectsById: Object.freeze({ 'alpha-prj': ALPHA, 'bravo-prj': BRAVO }) });

const policyProject = (projectId) => ({
  projectId,
  defaultBranch: 'main',
  worktreeRoot: `/tmp/${projectId}-worktrees`,
  allowedOperations: ['validation.run'],
  validationProfiles: { focused: { commands: [{ argv: ['node', '--test'], timeoutSeconds: 30 }], evidenceTtlSeconds: 3600, riskClasses: ['R1'] } },
  requiredValidationProfiles: { R1: ['focused'] },
});
const policy = validateLocalExecutorPolicy({ schemaVersion: 1, projects: [policyProject('alpha-prj'), policyProject('bravo-prj')] });

/** Evidence is keyed by validation identity and stays bound to the project, repository and exact head it validated. */
function schedulerEvidenceStore(entries) {
  const byId = new Map(entries.map((entry) => [entry.validationId, Object.freeze({
    schemaVersion: 1, validationId: entry.validationId, state: 'succeeded', projectId: entry.projectId, repository: entry.repository,
    profile: entry.profile, profileContractSha256: validationProfileContractSha256(policy, entry.projectId, entry.profile),
    expectedSha: entry.expectedSha, observedSha: entry.expectedSha, expiresAt: '2030-01-01T00:00:00.000Z',
  })]));
  return {
    get: (validationId) => byId.get(validationId) ?? null,
    findFreshSucceeded: ({ projectId, repository, profile, profileContractSha256, expectedSha }) => [...byId.values()].find((e) => (
      e.projectId === projectId && e.repository === repository && e.profile === profile
      && e.profileContractSha256 === profileContractSha256 && e.expectedSha === String(expectedSha).toLowerCase()
    )) ?? null,
  };
}

const attempt = (overrides) => ({
  attemptId: 'pr-attempt-alpha-0001', projectId: 'alpha-prj', repository: 'Owner/alpha', issueNumber: 154,
  sourceBranch: 'codex/pr-154', targetBranch: 'main', expectedHeadSha: 'a'.repeat(40),
  managerRevision: 'AR154-CONTROLLER-2026-08-09.1', managerFingerprint: `sha256:${'b'.repeat(64)}`,
  executorJobId: 'executor-job-00000001', riskClass: 'R1',
  approvedScope: 'Integrate PR.CONTRACT.1 into the closed-loop scheduler.',
  filesChanged: ['scripts/ops/x.mjs'], knownLimitations: ['No merge authority.'], ...overrides,
});

const ALPHA_EVIDENCE = { validationId: 'validation-00000001', projectId: 'alpha-prj', repository: 'Owner/alpha', profile: 'focused', expectedSha: 'a'.repeat(40) };
const BRAVO_EVIDENCE = { validationId: 'validation-00000002', projectId: 'bravo-prj', repository: 'Other/bravo', profile: 'focused', expectedSha: 'a'.repeat(40) };

function schedulerHarness() {
  const tx = new PrTransactionStore(':memory:');
  const controller = new PrControllerStateStore(':memory:');
  const attempts = new PrControllerAttemptStore(':memory:');
  return { tx, controller, attempts, close() { attempts.close(); controller.close(); tx.close(); } };
}

test('scheduler transitions a durable validated attempt to exactly one draft PR and releases the worker', async () => {
  const h = schedulerHarness(), client = fakeClient();
  try {
    h.attempts.recordValidatedAttempt(attempt(), { now: '2029-01-01T00:00:00.000Z' });
    const result = await runPrControllerSchedulerCycle({
      attemptStore: h.attempts, controllerStore: h.controller, transactionStore: h.tx,
      evidenceStore: schedulerEvidenceStore([ALPHA_EVIDENCE]), registry, policy, client,
      authorityCheck: async () => true, collectSettlement: succeededChecks, now: '2029-01-01T00:00:00.000Z',
    });
    assert.equal(result.outcomes.length, 1);
    assert.equal(result.outcomes[0].status, 'settled');
    assert.equal(result.outcomes[0].prNumber, 9);
    assert.equal(client.calls.filter((c) => c.method === 'POST').length, 1);
    const stored = h.attempts.get('pr-attempt-alpha-0001');
    assert.equal(stored.state, 'settled');
    assert.equal(stored.workerState, 'released');
    assert.equal(h.controller.get(stored.transactionId).stage, 'settled');
  } finally { h.close(); }
});

test('scheduler keeps monitoring a non-terminal PR and replays across restarts without duplicate PRs', async () => {
  const h = schedulerHarness(), client = fakeClient(), evidenceStore = schedulerEvidenceStore([ALPHA_EVIDENCE]);
  try {
    h.attempts.recordValidatedAttempt(attempt(), { now: '2029-01-01T00:00:00.000Z' });
    const args = {
      attemptStore: h.attempts, controllerStore: h.controller, transactionStore: h.tx,
      evidenceStore, registry, policy, client, authorityCheck: async () => true, collectSettlement: pendingChecks,
    };
    const first = await runPrControllerSchedulerCycle({ ...args, now: '2029-01-01T00:00:00.000Z' });
    assert.equal(first.outcomes[0].status, 'monitoring');
    // Still schedulable: settlement has not reached a terminal state.
    assert.equal(h.attempts.get('pr-attempt-alpha-0001').state, 'published');
    assert.equal(h.attempts.get('pr-attempt-alpha-0001').workerState, 'released');
    const second = await runPrControllerSchedulerCycle({ ...args, now: '2029-01-01T00:05:00.000Z' });
    assert.equal(second.outcomes[0].replayed, true);
    assert.equal(second.outcomes[0].prNumber, 9);
    assert.equal(client.calls.filter((c) => c.method === 'POST').length, 1);
  } finally { h.close(); }
});

test('scheduler drives two materially different configured repositories through the same path', async () => {
  const h = schedulerHarness(), clientA = fakeClient(), clientB = fakeClient();
  const evidenceStore = schedulerEvidenceStore([ALPHA_EVIDENCE, BRAVO_EVIDENCE]);
  const shared = { controllerStore: h.controller, transactionStore: h.tx, evidenceStore, registry, policy, authorityCheck: async () => true, now: '2029-01-01T00:00:00.000Z' };
  try {
    h.attempts.recordValidatedAttempt(attempt(), { now: '2029-01-01T00:00:00.000Z' });
    const alpha = await runPrControllerSchedulerCycle({ ...shared, attemptStore: h.attempts, client: clientA, collectSettlement: failedChecks });
    h.attempts.recordValidatedAttempt(attempt({
      attemptId: 'pr-attempt-bravo-0001', projectId: 'bravo-prj', repository: 'Other/bravo', executorJobId: 'executor-job-00000002',
    }), { now: '2029-01-01T00:00:00.000Z' });
    const bravo = await runPrControllerSchedulerCycle({ ...shared, attemptStore: h.attempts, client: clientB, collectSettlement: succeededChecks });
    assert.equal(alpha.outcomes[0].settlementStatus, 'failed');
    assert.equal(bravo.outcomes.length, 1);
    assert.equal(bravo.outcomes[0].attemptId, 'pr-attempt-bravo-0001');
    assert.equal(bravo.outcomes[0].settlementStatus, 'succeeded');
    assert.notEqual(alpha.outcomes[0].transactionId, bravo.outcomes[0].transactionId);
    assert.equal(clientA.calls.filter((c) => c.method === 'POST').length, 1);
    assert.equal(clientB.calls.filter((c) => c.method === 'POST').length, 1);
  } finally { h.close(); }
});

test('scheduler fails closed when the attempt repository does not match the configured project', async () => {
  const h = schedulerHarness(), client = fakeClient();
  try {
    h.attempts.recordValidatedAttempt(attempt({ repository: 'Other/bravo' }), { now: '2029-01-01T00:00:00.000Z' });
    const result = await runPrControllerSchedulerCycle({
      attemptStore: h.attempts, controllerStore: h.controller, transactionStore: h.tx,
      evidenceStore: schedulerEvidenceStore([ALPHA_EVIDENCE]), registry, policy, client,
      authorityCheck: async () => true, collectSettlement: succeededChecks, now: '2029-01-01T00:00:00.000Z',
    });
    assert.equal(result.outcomes[0].reasonCode, 'repository-mismatch');
    assert.equal(h.attempts.get('pr-attempt-alpha-0001').state, 'attention');
    assert.equal(client.calls.filter((c) => c.method === 'POST').length, 0);
  } finally { h.close(); }
});

test('scheduler fails closed when durable validation evidence is absent or bound to another project', async () => {
  const h = schedulerHarness(), client = fakeClient();
  try {
    h.attempts.recordValidatedAttempt(attempt(), { now: '2029-01-01T00:00:00.000Z' });
    const result = await runPrControllerSchedulerCycle({
      attemptStore: h.attempts, controllerStore: h.controller, transactionStore: h.tx,
      evidenceStore: schedulerEvidenceStore([BRAVO_EVIDENCE]), registry, policy, client,
      authorityCheck: async () => true, collectSettlement: succeededChecks, now: '2029-01-01T00:00:00.000Z',
    });
    assert.equal(result.outcomes[0].reasonCode, 'validation-evidence-missing');
    assert.equal(result.attention, 1);
    assert.equal(client.calls.filter((c) => c.method === 'POST').length, 0);
  } finally { h.close(); }
});

test('scheduler records bounded attention evidence on exact-head drift and stale manager authority', async () => {
  for (const [label, client, authorityCheck, expected] of [
    ['head drift', fakeClient({ head: 'd'.repeat(40) }), async () => true, 'source-head-changed'],
    ['stale authority', fakeClient(), async () => false, 'manager-authority-stale'],
  ]) {
    const h = schedulerHarness();
    try {
      h.attempts.recordValidatedAttempt(attempt(), { now: '2029-01-01T00:00:00.000Z' });
      const result = await runPrControllerSchedulerCycle({
        attemptStore: h.attempts, controllerStore: h.controller, transactionStore: h.tx,
        evidenceStore: schedulerEvidenceStore([ALPHA_EVIDENCE]), registry, policy, client,
        authorityCheck, collectSettlement: succeededChecks, now: '2029-01-01T00:00:00.000Z',
      });
      assert.equal(result.outcomes[0].reasonCode, expected, label);
      assert.equal(h.attempts.get('pr-attempt-alpha-0001').state, 'attention', label);
      assert.equal(client.calls.filter((c) => c.method === 'POST').length, 0, label);
    } finally { h.close(); }
  }
});

test('attempt store is idempotent and refuses a reused identity carrying different evidence', () => {
  const attempts = new PrControllerAttemptStore(':memory:');
  try {
    const first = attempts.recordValidatedAttempt(attempt(), { now: '2029-01-01T00:00:00.000Z' });
    const again = attempts.recordValidatedAttempt(attempt(), { now: '2029-01-01T00:01:00.000Z' });
    assert.equal(again.createdAt, first.createdAt);
    assert.throws(
      () => attempts.recordValidatedAttempt(attempt({ expectedHeadSha: 'e'.repeat(40) }), { now: '2029-01-01T00:02:00.000Z' }),
      (error) => error.code === 'idempotency-key-collision',
    );
  } finally { attempts.close(); }
});
