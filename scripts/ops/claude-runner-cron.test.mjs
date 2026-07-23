import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  activeRunBlockForIssue,
  buildIssueListArgs,
  claimIssueForExecution,
  claimRevisionIsCurrent,
  classifyAttemptLivenessState,
  CLAUDE_RUNNER_ENTRYPOINT,
  computeAttemptLivenessEvidence,
  collectRecoveryRevalidation,
  captureProcessIdentity,
  createStateRecorder,
  deriveTerminalOutcome,
  evaluateChildRunResult,
  hasManagerPreflight,
  issueMetadataConflicts,
  latestManagerPreflightComment,
  latestManagerRecoveryAuthorization,
  latestRunnerStartedComment,
  listCandidateIssues,
  localRecoveryConflicts,
  listOpenPullRequests,
  mergeIssuesByNumber,
  parseAgentLabels,
  parseArgs,
  parseChildRunnerOutput,
  main,
  MAX_TRANSITION_MUTATION_ATTEMPTS,
  probeProcessIdentity,
  preflightAlreadyClaimed,
  quotaPreflightArgs,
  reconcileSchedulerAttempts,
  resolveManagerTimelineAuthority,
  restoreIssueAfterSuccessfulRecovery,
  runChildWithWatchdog,
  quarantineIssueAfterFailedRun,
  quarantineIssueBeforeClaim,
  reconcilePendingRecoveryTransitions,
  rootBlocked,
  runQuotaPreflight,
  runnerAttentionCommentBody,
  runnerArgs,
  runnableCommandForIssue,
  selectIssue,
  truthy,
  upsertGitHubAttentionComment,
  waitForExplicitPlanApproval,
} from './claude-runner-cron.mjs';
import { decideRecovery, normalizeTerminalOutcome } from './claude-runner-recovery.mjs';
import { RUNNER_STATE_TABLES, openRunnerStateStore } from './claude-runner-state.mjs';
import { readRestrictedRecoveryHandle, restrictedHandleBindingDigest, restrictedRecoveryDir, writeRestrictedRecoveryHandle } from './claude-runner-recovery-adapter.mjs';

const TEST_MANAGER_FINGERPRINT = `sha256:${'a'.repeat(64)}`;
function canonicalPreflightBody(revision = 'TEST.1', extra = '') {
  return `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: ${revision}\nfingerprint: ${TEST_MANAGER_FINGERPRINT}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: claude-code-cli\nexecution_phase: implementation\nscope:\n  - bounded test scope\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on scope expansion\n\`\`\`\n${extra}`;
}

function canonicalPreflightComment(id, revision = `TEST.${id}`, extra = '', user = 'chatgpt-manager') {
  return { id, databaseId: id, createdAt: '2026-07-23T09:00:00Z', user: { login: user }, body: canonicalPreflightBody(revision, extra) };
}

function withEmptyOpenPrInventory(ghRunner) {
  return (args) => {
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    return ghRunner(args);
  };
}

test('truthy recognises explicit opt-in values only', () => {
  assert.equal(truthy('true'), true);
  assert.equal(truthy('1'), true);
  assert.equal(truthy('yes'), true);
  assert.equal(truthy('false'), false);
  assert.equal(truthy(''), false);
});

test('parseArgs defaults to dry run unless environment or flag enables execution', () => {
  assert.equal(parseArgs([], {}).execute, false);
  assert.equal(parseArgs([], { CLAUDE_RUNNER_CRON_EXECUTE: 'true' }).execute, true);
  assert.equal(parseArgs(['--dry-run'], { CLAUDE_RUNNER_CRON_EXECUTE: 'true' }).execute, false);
  assert.equal(parseArgs(['--execute'], {}).execute, true);
});

test('parseArgs defaults to a wider queue scan and supports explicit limit', () => {
  assert.equal(parseArgs([], {}).limit, 100);
  assert.equal(parseArgs([], {}).watchdogIntervalMs, 10 * 60_000);
  assert.equal(parseArgs([], {}).stalledPassLimit, 2);
  assert.equal(parseArgs(['--limit', '125'], {}).limit, 125);
  assert.throws(() => parseArgs(['--limit', '201'], {}), /--limit must be 1..200/);
});


test('parseArgs can load reusable project defaults from explicit config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cron-config-'));
  const configPath = join(dir, 'config.json');
  try {
    writeFileSync(configPath, JSON.stringify({
      projectId: 'example',
      displayName: 'Example Project',
      githubRepo: 'owner/repo',
      localRepoPath: '/srv/example',
      outputDir: '.var/example-runner',
      stateDbPath: '.var/example-runner/state.sqlite',
      acceptedAgentLabels: ['agent:example'],
      statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
      priorityLabelRanking: ['priority:P0'],
      safeDefaultValidationCommands: ['npm test'],
      systemd: { serviceName: 'example.service', timerName: 'example.timer' },
      runner: { lockPath: '.var/example-runner/cron.lock', candidateLimit: 42 },
    }));
    const args = parseArgs(['--config', configPath], {});
    assert.equal(args.repo, 'owner/repo');
    assert.equal(args.outputDir, '.var/example-runner');
    assert.equal(args.stateDbPath, '.var/example-runner/state.sqlite');
    assert.deepEqual(args.agentLabels, ['agent:example']);
    assert.equal(args.limit, 42);
    assert.equal(args.project.id, 'example');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseArgs keeps explicit state DB independent of output-dir argument order', () => {
  const explicitStateDb = join('state', 'explicit.sqlite');
  const outputDir = join('state', 'derived-output');

  assert.equal(
    parseArgs([
      '--state-db',
      explicitStateDb,
      '--output-dir',
      outputDir,
    ], {}).stateDbPath,
    explicitStateDb,
  );

  assert.equal(
    parseArgs([
      '--output-dir',
      outputDir,
      '--state-db',
      explicitStateDb,
    ], {}).stateDbPath,
    explicitStateDb,
  );
});

test('parseArgs derives state DB only without explicit or environment state', () => {
  const outputDir = join('state', 'derived-output');

  assert.equal(
    parseArgs(['--output-dir', outputDir], {}).stateDbPath,
    join(outputDir, 'runner-state.sqlite'),
  );

  assert.equal(
    parseArgs(
      ['--output-dir', outputDir],
      { CLAUDE_RUNNER_STATE_DB: 'environment-state.sqlite' },
    ).stateDbPath,
    'environment-state.sqlite',
  );
});

test('parseArgs enables quota preflight by default and supports explicit skip', () => {
  assert.equal(parseArgs([], {}).quotaPreflight, true);
  assert.equal(parseArgs([], { CLAUDE_RUNNER_CRON_SKIP_QUOTA_PREFLIGHT: 'true' }).quotaPreflight, false);
  assert.equal(parseArgs(['--skip-quota-preflight'], {}).quotaPreflight, false);
});

test('parseArgs always requires canonical manager authority and rejects retired bypass flags', () => {
  assert.equal(parseArgs([], {}).requireManagerPreflight, true);
  assert.equal(parseArgs([], { CLAUDE_RUNNER_CRON_SKIP_MANAGER_PREFLIGHT: 'true' }).requireManagerPreflight, true);
  assert.throws(() => parseArgs(['--skip-manager-preflight'], {}), /Unknown argument/);
  assert.throws(() => parseArgs(['--no-preflight-direct'], {}), /Unknown argument/);
  assert.throws(() => parseArgs(['--no-auto-proceed'], {}), /Unknown argument/);
  assert.throws(() => parseArgs(['--no-auto-preflight'], {}), /Unknown argument/);
});

test('parseArgs accepts both Claude agent labels by default', () => {
  assert.deepEqual(parseArgs([], {}).agentLabels, ['agent:claude', 'agent:claude-code-cli']);
});

test('parseArgs can override or append Claude agent labels', () => {
  assert.deepEqual(parseArgs([], { CLAUDE_RUNNER_CRON_AGENT_LABELS: 'agent:claude-code-cli, agent:custom' }).agentLabels, ['agent:claude-code-cli', 'agent:custom']);
  assert.deepEqual(parseArgs(['--agent-label', 'agent:custom'], {}).agentLabels, ['agent:claude', 'agent:claude-code-cli', 'agent:custom']);
  assert.deepEqual(parseArgs(['--agent-labels', 'agent:custom'], {}).agentLabels, ['agent:custom']);
});

test('parseAgentLabels trims, splits and deduplicates labels', () => {
  assert.deepEqual(parseAgentLabels(' agent:claude,agent:claude,agent:claude-code-cli '), ['agent:claude', 'agent:claude-code-cli']);
});

test('hasManagerPreflight recognises packets but rejects invalidation notices', () => {
  assert.equal(hasManagerPreflight('## Manager preflight packet\nFiles inspected...'), true);
  assert.equal(hasManagerPreflight('### ChatGPT preflight\nLive GitHub checked...'), true);
  assert.equal(hasManagerPreflight('Preflight prepared by ChatGPT: issue and files checked.'), true);
  assert.equal(hasManagerPreflight('## Manager preflight stale\nRefresh before dispatch.'), false);
  assert.equal(hasManagerPreflight('## Manager preflight packet — revoked\nDo not dispatch.'), false);
  assert.equal(hasManagerPreflight('Claude should inspect the repo and figure it out.'), false);
});

test('root is blocked unless explicitly allowed', () => {
  assert.equal(rootBlocked(0, false), true);
  assert.equal(rootBlocked(0, true), false);
  assert.equal(rootBlocked(1000, false), false);
});

test('parseChildRunnerOutput parses the child claude-runner.mjs JSON payload', () => {
  assert.deepEqual(parseChildRunnerOutput('{"logPath":".var/claude-runner/issue-580.json"}'), { logPath: '.var/claude-runner/issue-580.json' });
});

test('parseChildRunnerOutput returns null for unparseable or empty output (the observed issue #648 "newline only" stdout)', () => {
  assert.equal(parseChildRunnerOutput('\n'), null);
  assert.equal(parseChildRunnerOutput(''), null);
  assert.equal(parseChildRunnerOutput(undefined), null);
});

test('evaluateChildRunResult passes a dry run through untouched', () => {
  assert.deepEqual(evaluateChildRunResult({ execute: false, exitCode: 0, childPayload: null }), { failed: false, reason: null });
});

test('evaluateChildRunResult classifies a non-zero child exit as a terminal runner failure', () => {
  assert.deepEqual(
    evaluateChildRunResult({ execute: true, exitCode: 1, childPayload: null }),
    { failed: true, reason: 'child-exit-1' },
  );
});

test('evaluateChildRunResult preserves a normalized child failure reason when available', () => {
  assert.deepEqual(
    evaluateChildRunResult({ execute: true, exitCode: 1, childPayload: { failureReason: 'provider-execution-limit' } }),
    { failed: true, reason: 'provider-execution-limit' },
  );
});

test('evaluateChildRunResult fails a clean exit with unparseable child output (issue #648 repro: exit 0, stdout is newline only)', () => {
  const result = evaluateChildRunResult({ execute: true, exitCode: 0, childPayload: null });
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'child-output-unparseable');
});

test('evaluateChildRunResult fails a clean exit whose child payload has no logPath', () => {
  const result = evaluateChildRunResult({ execute: true, exitCode: 0, childPayload: { issue: 580 } });
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'child-produced-no-run-log');
});

test('evaluateChildRunResult fails a logged clean exit that was blocked by cost policy', () => {
  const result = evaluateChildRunResult({
    execute: true,
    exitCode: 0,
    childPayload: { logPath: 'x.json', blocked: true, reason: 'cost-policy-blocked' },
  });
  assert.deepEqual(result, { failed: true, reason: 'cost-policy-blocked' });
});

test('evaluateChildRunResult fails closed on a normalized failure reason even if the process exited zero', () => {
  const result = evaluateChildRunResult({
    execute: true,
    exitCode: 0,
    childPayload: { logPath: 'x.json', failureReason: 'provider-execution-limit' },
  });
  assert.deepEqual(result, { failed: true, reason: 'provider-execution-limit' });
});

test('evaluateChildRunResult fails a clean exit when the child flagged its own execution as a no-op', () => {
  const result = evaluateChildRunResult({ execute: true, exitCode: 0, childPayload: { logPath: 'x.json', executionNoop: true, executionNoopReason: 'claude-exited-zero-with-no-output' } });
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'claude-exited-zero-with-no-output');
});

test('evaluateChildRunResult passes a clean exit with a real logged run', () => {
  const result = evaluateChildRunResult({ execute: true, exitCode: 0, childPayload: { logPath: 'x.json', executionNoop: false, executionNoopReason: null } });
  assert.deepEqual(result, { failed: false, reason: null });
});

test('evaluateChildRunResult fails a clean exit when the child flagged a plan-only run (issue #660 defense in depth)', () => {
  const result = evaluateChildRunResult({
    execute: true,
    exitCode: 0,
    childPayload: { logPath: 'x.json', executionNoop: false, executionNoopReason: null, awaitingPlanApproval: true, planPath: '/home/gp/.claude/plans/start-a-fresh-task-drifting-seahorse.md' },
  });
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'awaiting-plan-approval');
});

test('evaluateChildRunResult preserves a non-zero plan-only approval signal', () => {
  const result = evaluateChildRunResult({
    execute: true,
    exitCode: 2,
    childPayload: { logPath: 'x.json', executionNoop: false, executionNoopReason: null, awaitingPlanApproval: true, planPath: '/home/gp/.claude/plans/start-a-fresh-task-drifting-seahorse.md' },
  });
  assert.deepEqual(result, { failed: true, reason: 'awaiting-plan-approval' });
});

test('plan-only aliases normalize to an explicit approval wait instead of unknown quarantine', () => {
  for (const alias of ['awaiting-plan-approval', 'awaiting_plan_approval']) {
    assert.equal(normalizeTerminalOutcome(alias), 'plan_only_awaiting_approval');
  }
  const childPayload = { logPath: 'plan.json', awaitingPlanApproval: true, planPath: '/restricted/plan.md' };
  const childCheck = evaluateChildRunResult({ execute: true, exitCode: 20, childPayload });
  const outcome = deriveTerminalOutcome({ effectiveExitCode: 1, childPayload, childReason: childCheck.reason });
  const decision = decideRecovery({ outcome, evidence: {} });
  assert.equal(outcome, 'plan_only_awaiting_approval');
  assert.equal(decision.action, 'attention_required');
  assert.match(decision.nextAction, /explicitly approve or reject/i);

  const calls = [];
  const result = waitForExplicitPlanApproval(
    { repo: 'TheTekTeam/modelspend' },
    { number: 698 },
    { reason: outcome, finishedAt: '2026-07-17T20:00:00Z', nextAction: decision.nextAction },
    (args) => {
      calls.push(args);
      if (args[1] === 'view') return JSON.stringify({ comments: [] });
      return '';
    },
  );
  assert.equal(result.awaitingExplicitApproval, true);
  assert.equal(result.quarantined, false);
  assert.equal(result.reason, 'plan_only_awaiting_approval');
  assert.equal(calls.some((args) => args.join(' ').includes('unknown_failure')), false);
});

test('runnerArgs adds execute only when requested', () => {
  const base = { outputDir: '.var/out', execute: false };
  assert.equal(runnerArgs(381, base).includes('--execute'), false);
  assert.equal(runnerArgs(381, base).includes('--output-dir'), true);
  const execute = runnerArgs(381, { ...base, execute: true });
  assert.equal(execute.includes('--execute'), true);
  assert.equal(execute.includes('--issue'), true);
});

test('quotaPreflightArgs runs the forced usage preflight through claude-runner', () => {
  const args = quotaPreflightArgs({ outputDir: '.var/out' });
  assert.deepEqual(args, [CLAUDE_RUNNER_ENTRYPOINT, '--check-quota', '--force-quota-check', '--output-dir', '.var/out']);
});

test('runnerArgs and quotaPreflightArgs invoke the canonical claude-runner.mjs by absolute path, not a bare relative path resolved against process cwd', () => {
  assert.ok(CLAUDE_RUNNER_ENTRYPOINT.startsWith('/'));
  assert.ok(CLAUDE_RUNNER_ENTRYPOINT.endsWith('/scripts/ops/claude-runner.mjs'));
  assert.equal(runnerArgs(381, { outputDir: '.var/out', execute: false })[0], CLAUDE_RUNNER_ENTRYPOINT);
});

test('runQuotaPreflight is skipped for dry-runs', () => {
  const result = runQuotaPreflight({ execute: false, quotaPreflight: true, outputDir: '.var/out' }, {}, () => {
    throw new Error('should not spawn');
  });
  assert.equal(result.blocked, false);
  assert.equal(result.skipped, true);
});

test('runQuotaPreflight allows execution when quota check reports available', () => {
  const result = runQuotaPreflight(
    { execute: true, quotaPreflight: true, outputDir: '.var/out' },
    {},
    () => ({ status: 0, signal: null, stdout: JSON.stringify({ status: 'available' }), stderr: '' }),
  );
  assert.equal(result.blocked, false);
  assert.equal(result.status, 'available');
});

test('runQuotaPreflight blocks execution when quota check reports exhausted', () => {
  const result = runQuotaPreflight(
    { execute: true, quotaPreflight: true, outputDir: '.var/out' },
    {},
    () => ({ status: 0, signal: null, stdout: JSON.stringify({ status: 'exhausted', state: { pausedUntil: '2026-07-08T22:19:00.000Z' } }), stderr: '' }),
  );
  assert.equal(result.blocked, true);
  assert.equal(result.status, 'exhausted');
});

test('mergeIssuesByNumber deduplicates issues and sorts by status, priority, then recency', () => {
  const issues = mergeIssuesByNumber([
    [
      { number: 1, statusLabel: 'status:ready', labels: [{ name: 'priority:P1' }], updatedAt: '2026-01-03T00:00:00Z' },
      { number: 2, statusLabel: 'status:ready', labels: [{ name: 'priority:P0' }], updatedAt: '2026-01-01T00:00:00Z' },
    ],
    [
      { number: 1, statusLabel: 'status:ready', labels: [{ name: 'priority:P0' }], updatedAt: '2026-01-02T00:00:00Z' },
      { number: 3, statusLabel: 'status:in-progress', labels: [{ name: 'priority:P2' }], updatedAt: '2026-01-02T00:00:00Z' },
    ],
  ]);
  assert.deepEqual(issues.map((issue) => issue.number), [3, 1, 2]);
  assert.equal(issues.find((issue) => issue.number === 1).updatedAt, '2026-01-02T00:00:00Z');
  assert.deepEqual(issues.find((issue) => issue.number === 1).labels, [{ name: 'priority:P0' }]);
});

test('buildIssueListArgs selects on status/agent labels only and requests labels for priority sorting', () => {
  const args = buildIssueListArgs('TheTekTeam/modelspend', 10, 'status:ready', 'agent:claude-code-cli');
  assert.deepEqual(args, ['issue', 'list', '--repo', 'TheTekTeam/modelspend', '--state', 'open', '--label', 'status:ready', '--label', 'agent:claude-code-cli', '--limit', '10', '--json', 'number,title,body,url,updatedAt,labels']);
  assert.equal(args.includes('devplan'), false);
});

test('runnableCommandForIssue refuses commands without manager preflight by default', () => {
  const comments = [{ id: 1, createdAt: '2026-07-08T09:00:00Z', body: '## Claude proceed command\nTask: do the thing' }];
  const result = runnableCommandForIssue({ statusLabel: 'status:ready' }, comments);
  assert.equal(result.command, null);
  assert.equal(result.reason, 'missing manager preflight packet');
});

test('runnableCommandForIssue accepts commands with manager preflight packets', () => {
  const comments = [{ id: 1, createdAt: '2026-07-08T09:00:00Z', body: '## Claude proceed command\n\n## Manager preflight packet\nFiles checked by ChatGPT.\n\nTask: do the thing' }];
  const result = runnableCommandForIssue({ statusLabel: 'status:ready' }, comments);
  assert.equal(result.command.kind, 'proceed');
  assert.equal(result.reason, null);
});

test('runnableCommandForIssue accepts an allowlisted transition command backed by a separate current manager preflight', () => {
  const comments = [
    { id: 1, createdAt: '2026-07-08T09:00:00Z', body: '## Manager preflight packet\nFiles checked by ChatGPT.', user: { login: 'gpcola' } },
    { id: 2, createdAt: '2026-07-08T09:01:00Z', body: '## Claude proceed command\nPhase: implementation\nTask: execute the approved preflight', user: { login: 'gpcola' } },
  ];
  const result = runnableCommandForIssue({ statusLabel: 'status:ready' }, comments);
  assert.equal(result.command.kind, 'proceed');
  assert.equal(result.command.authorLogin, 'gpcola');
  assert.equal(result.reason, null);
});

test('a newer stale notice invalidates an older command-embedded preflight', () => {
  const comments = [
    { id: 1, createdAt: '2026-07-08T09:00:00Z', body: '## Claude proceed command\n\n## Manager preflight packet\nOld packet.\n\nTask: do the thing' },
    { id: 2, createdAt: '2026-07-08T09:01:00Z', body: '## Manager preflight stale\nDependencies changed.' },
  ];
  const result = runnableCommandForIssue({ statusLabel: 'status:ready' }, comments);
  assert.equal(result.command, null);
  assert.equal(result.reason, 'missing manager preflight packet');
});

test('latestManagerPreflightComment returns the newest manager preflight comment', () => {
  const comments = [
    { id: 1, createdAt: '2026-07-08T08:00:00Z', body: '## Manager preflight packet\nOld' },
    { id: 2, createdAt: '2026-07-08T09:00:00Z', body: 'ordinary comment' },
    { id: 3, createdAt: '2026-07-08T10:00:00Z', body: '### ChatGPT preflight\nNew' },
  ];
  assert.equal(latestManagerPreflightComment(comments).id, 3);
});

test('latestManagerPreflightComment treats a newer stale notice as cancelling older packets', () => {
  const comments = [
    { id: 1, createdAt: '2026-07-08T08:00:00Z', body: '## Manager preflight packet\nOld packet' },
    { id: 2, createdAt: '2026-07-08T09:00:00Z', body: '## Manager preflight stale\nRefresh before dispatch.' },
  ];
  assert.equal(latestManagerPreflightComment(comments), null);
});

test('latestManagerPreflightComment accepts a fresh packet posted after a stale notice', () => {
  const comments = [
    { id: 1, createdAt: '2026-07-08T08:00:00Z', body: '## Manager preflight packet\nOld packet' },
    { id: 2, createdAt: '2026-07-08T09:00:00Z', body: '## Manager preflight stale\nRefresh before dispatch.' },
    { id: 3, createdAt: '2026-07-08T10:00:00Z', body: '## Manager preflight packet — refreshed\nCurrent packet' },
  ];
  assert.equal(latestManagerPreflightComment(comments).id, 3);
});

test('claimIssueForExecution rejects historical proceed-command authority before GitHub mutation', () => {
  const ghCalls = [];
  const selection = { mode: 'proceed-command', command: { kind: 'proceed', sourceCommentId: 'github-comment:database:9' }, preflight: null };
  assert.throws(() => claimIssueForExecution(
    { repo: 'TheTekTeam/modelspend', outputDir: '.var/out' },
    { number: 701, statusLabel: 'status:ready' },
    selection,
    (args) => { ghCalls.push(args); return ''; },
  ), /manager-preflight-required-before-claim/);
  assert.deepEqual(ghCalls, []);
});

test('claimIssueForExecution binds the immutable manager revision and fingerprint', () => {
  const ghCalls = [];
  const fakeGhRunner = (ghArgs) => { ghCalls.push(ghArgs); return ''; };
  const issue = { number: 702, statusLabel: 'status:ready' };
  const preflight = canonicalPreflightComment(77, 'TEST.77');
  const managerAuthority = {
    valid: true, revision: 'TEST.77', fingerprint: TEST_MANAGER_FINGERPRINT,
    authorityKey: `manager-preflight:TEST.77:${TEST_MANAGER_FINGERPRINT}`, comment: preflight,
  };
  const selection = { mode: 'preflight-direct', command: null, preflight, managerAuthority };
  const claim = claimIssueForExecution({ repo: 'TheTekTeam/modelspend', outputDir: '.var/out' }, issue, selection, fakeGhRunner);
  assert.equal(claim.selectionMode, 'preflight-direct');
  assert.equal(claim.sourceCommentId, null);
  assert.equal(claim.sourcePreflightCommentId, 'github-comment:database:77');
  assert.equal(claim.managerPreflightRevision, 'TEST.77');
  assert.equal(claim.managerPreflightFingerprint, TEST_MANAGER_FINGERPRINT);
  const commentBody = ghCalls[1][ghCalls[1].indexOf('--body') + 1];
  assert.match(commentBody, /Manager packet revision: TEST.77/);
  assert.match(commentBody, new RegExp(`Manager packet fingerprint: ${TEST_MANAGER_FINGERPRINT}`));
});

test('quarantineIssueAfterFailedRun releases the task and posts a machine-readable attention marker', () => {
  const calls = [];
  const result = quarantineIssueAfterFailedRun(
    { repo: 'TheTekTeam/modelspend' },
    { number: 658 },
    { reason: 'provider-execution-limit', exitCode: 1, finishedAt: '2026-07-15T20:32:37Z' },
    (ghArgs) => { calls.push(ghArgs); return ''; },
  );

  assert.deepEqual(calls[0], ['issue', 'edit', '658', '--repo', 'TheTekTeam/modelspend', '--remove-label', 'status:in-progress', '--add-label', 'status:blocked']);
  assert.equal(calls[2][0], 'issue');
  assert.equal(calls[2][1], 'comment');
  const body = calls[2][calls[2].indexOf('--body') + 1];
  assert.match(body, /<!-- agent-runner:attention:v1 -->/);
  assert.match(body, /provider_execution_limit/);
  assert.match(body, /continue with other eligible work/);
  assert.equal(result.statusUpdated, true);
  assert.equal(result.attentionPosted, true);
  assert.equal(result.queueReleased, true);
  assert.deepEqual(result.errors, []);
});

test('quarantineIssueAfterFailedRun still posts attention when the label update fails', () => {
  const calls = [];
  const result = quarantineIssueAfterFailedRun(
    { repo: 'TheTekTeam/modelspend' },
    { number: 659 },
    { reason: 'child-exit-1', exitCode: 1, finishedAt: '2026-07-15T20:32:37Z' },
    (ghArgs) => {
      calls.push(ghArgs);
      if (ghArgs[1] === 'edit') throw new Error('label API unavailable');
      return '';
    },
  );

  assert.equal(result.statusUpdated, false);
  assert.equal(result.attentionPosted, true);
  assert.equal(result.queueReleased, true);
  assert.deepEqual(result.errors, [{ stage: 'status-update', message: 'label API unavailable' }]);
  assert.equal(calls.length, 3);
});

test('attention comment is deduplicated and materially updates the existing marker', () => {
  const calls = [];
  const failure = { reason: 'unknown_failure', finishedAt: '2026-07-17T00:00:00Z', recoveryStatus: 'forbidden', nextAction: 'Manager review.' };
  let existingBody = null;
  const runner = (args) => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ comments: existingBody ? [{ id: 42, body: existingBody, createdAt: '2026-07-17T00:00:00Z' }] : [] });
    return '';
  };
  const first = upsertGitHubAttentionComment({ repo: 'TheTekTeam/modelspend' }, { number: 698 }, failure, runner);
  assert.equal(first.posted, true);
  existingBody = calls.at(-1)[calls.at(-1).indexOf('--body') + 1];
  assert.equal(upsertGitHubAttentionComment({ repo: 'TheTekTeam/modelspend' }, { number: 698 }, failure, runner).deduplicated, true);
  const changed = upsertGitHubAttentionComment({ repo: 'TheTekTeam/modelspend' }, { number: 698 }, { ...failure, recoveryStatus: 'exhausted' }, runner);
  assert.equal(changed.updated, true);
  assert.deepEqual(calls.at(-1).slice(0, 4), ['api', '--method', 'PATCH', 'repos/TheTekTeam/modelspend/issues/comments/42']);
});

test('scheduler watchdog persists an orphan in one pass and demotes+releases a stalled live attempt after two live passes (#698 round 5, finding 1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-watchdog-'));
  const args = { repo: 'TheTekTeam/modelspend', stateDbPath: join(dir, 'state.sqlite'), outputDir: dir, project: { id: 'modelspend' } };
  const ghWrites = [];
  // The 'stalled' row's claim (id '1') must resolve as *current* manager
  // authority (#698 round 5, finding 1) for the first pass to stay
  // actively_owned — a live process alone is no longer sufficient. The
  // 'orphan' row's process is confirmed dead regardless of authority, so it
  // demotes independent of this comment.
  const ghRunner = (values) => {
    if (values[1] === 'view') return JSON.stringify({ comments: [{ id: 1, createdAt: '2026-07-16T00:00:00Z', body: '## Claude proceed command\nGo.' }] });
    ghWrites.push(values);
    return '';
  };
  try {
    let state = createStateRecorder(args);
    state.record('recordRecoveryAttempt', { attemptId: 'orphan', repo: args.repo, issueNumber: 698, startedAt: '2026-07-17T00:00:00Z', processId: 123, resolutionState: 'active' });
    const result = await reconcileSchedulerAttempts({ state, args, processProbe: async () => false, ghRunner, now: () => '2026-07-17T00:15:00Z' });
    assert.equal(result.orphaned, 1);
    assert.equal(state.invoke('allRows', 'recovery_attempts')[0].outcome, 'orphaned_active_claim');
    assert.equal(state.invoke('allRows', 'attention_events').length, 1);
    state.close();

    state = createStateRecorder(args);
    state.record('recordRecoveryAttempt', { attemptId: 'stalled', repo: args.repo, issueNumber: 699, startedAt: '2026-07-17T00:00:00Z', processId: 456, claimId: '1', recoveryLeaseId: 'lease-1', resolutionState: 'active' });
    const stableNow = () => '2026-07-17T00:30:00Z';
    assert.equal((await reconcileSchedulerAttempts({ state, args, processProbe: async () => true, ghRunner, now: stableNow })).attention.length, 0, 'first pass: proven live, current lease, current authority, no stall yet -> stays actively_owned');
    assert.equal((await reconcileSchedulerAttempts({ state, args, processProbe: async () => true, ghRunner, now: stableNow })).attention.length, 1, 'second pass: stalled_passes reaches the threshold -> demoted, global slot released');
    // The row was demoted (finished_at set) on the second pass, so a third
    // pass finds no active row left to check at all — it must never keep
    // re-notifying a row that is no longer active (#698 round 5, finding
    // 1: "must not leave a stale active claim blocking the queue").
    const third = await reconcileSchedulerAttempts({ state, args, processProbe: async () => true, ghRunner, now: stableNow });
    assert.equal(third.checked, 0);
    assert.equal(third.attention.length, 0);
    assert.equal(state.invoke('allRows', 'attention_events').length, 2);
    assert.equal(ghWrites.filter((call) => call[0] === 'issue' && call[1] === 'comment').length, 2, 'one orphan write and one stalled-demotion write only');
    const stalledRow = state.invoke('recoveryAttempt', 'stalled');
    assert.notEqual(stalledRow.finished_at, null, 'a demoted attempt must release the global slot (finished_at set), never stay active indefinitely');
    assert.equal(stalledRow.resolution_state, 'unresolved');
    state.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('watchdog demotes a dead-process attempt with no current lease and no current authority to stale_unresolved_claim, not orphaned_active_claim (#686 orphan-classifier granularity)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-stale-claim-'));
  const args = { repo: 'TheTekTeam/modelspend', stateDbPath: join(dir, 'state.sqlite'), outputDir: dir, project: { id: 'modelspend' } };
  const ghRunner = (values) => {
    if (values[1] === 'view') return JSON.stringify({ comments: [{ id: 1, createdAt: '2026-07-16T00:00:00Z', body: '## Claude proceed command\nGo.' }] });
    return '';
  };
  try {
    const state = createStateRecorder(args);
    // Two active rows for the same issue: row 'dead-no-claim' has no claim
    // identity at all (authorityCurrent can never be current) and a second
    // row for the same issue makes its lease non-exclusive (leaseCurrent
    // false). Its process is confirmed dead. All three facts together are
    // deterministic, not ambiguous -- this must not read as an "active
    // claim" description.
    state.record('recordRecoveryAttempt', { attemptId: 'dead-no-claim', repo: args.repo, issueNumber: 700, startedAt: '2026-07-17T00:00:00Z', processId: 111, resolutionState: 'active' });
    // A second active row for the same issue is itself a genuine mutual
    // lease conflict in this model (both rows see each other and neither's
    // lease reads exclusive) — it demotes too, but for a *different* reason:
    // its process is confirmed live, so it is `unknown_failure` (a live
    // process demoted for a non-liveness reason), never `stale_unresolved_claim`.
    // That contrast is exactly the granularity this classifier must draw.
    state.record('recordRecoveryAttempt', { attemptId: 'other-live', repo: args.repo, issueNumber: 700, startedAt: '2026-07-17T00:00:00Z', processId: 222, claimId: '1', recoveryLeaseId: 'lease-x', resolutionState: 'active' });
    const processProbe = async (identity) => identity.processId === 222;
    const result = await reconcileSchedulerAttempts({ state, args, processProbe, ghRunner, now: () => '2026-07-17T00:15:00Z' });
    assert.equal(result.orphaned, 2);
    const rows = state.invoke('allRows', 'recovery_attempts');
    assert.equal(rows.find((row) => row.attempt_id === 'dead-no-claim').outcome, 'stale_unresolved_claim');
    assert.equal(rows.find((row) => row.attempt_id === 'other-live').outcome, 'unknown_failure');
    state.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the watchdog never demotes its own in-flight attempt on a transient GitHub authority-read failure or an unrelated later comment (#698 round 5 watchdog false-positive fix)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-self-supervise-'));
  const args = { repo: 'TheTekTeam/modelspend', stateDbPath: join(dir, 'state.sqlite'), outputDir: dir, project: { id: 'modelspend' } };
  let ghCalls = 0;
  // Every `issue view` (the authority re-read) throws, simulating a
  // transient GitHub outage/rate-limit mid-run. Before the fix, this alone
  // flipped `authorityCurrent` false on every tick and demoted the running
  // job's own attempt row, releasing its slot while the child was still
  // executing.
  const ghRunner = (values) => {
    if (values[0] === 'issue' && values[1] === 'view') { ghCalls += 1; throw new Error('transient GitHub outage'); }
    return '';
  };
  const fakeChild = new EventEmitter();
  fakeChild.pid = 9999;
  fakeChild.stdout = new EventEmitter();
  fakeChild.stdout.setEncoding = () => {};
  fakeChild.stderr = new EventEmitter();
  fakeChild.stderr.setEncoding = () => {};
  fakeChild.kill = () => {};
  // Deterministic wait for real watchdog ticks (#698 finding 8 re-review
  // pattern, reused here rather than a fixed sleep against a fast interval
  // -- a blind setTimeout race against setInterval is exactly the flaky
  // shape this codebase already removed once; poll a tick counter instead).
  const waitUntil = async (predicate, { timeoutMs = 5000, stepMs = 5 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('waitUntil timed out');
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  };
  try {
    const state = createStateRecorder(args);
    const attemptId = 'self-supervised';
    state.record('recordRecoveryAttempt', {
      attemptId, repo: args.repo, issueNumber: 701, startedAt: '2026-07-18T00:00:00Z',
      processId: 9999, claimId: '1', resolutionState: 'active',
    });
    let ticks = 0;
    const watchdogPromise = runChildWithWatchdog({
      command: process.execPath, commandArgs: [], options: {}, state, args, attemptId, ghRunner,
      spawnRunner: () => fakeChild,
      processProbe: async () => { ticks += 1; return true; },
      progressProbe: () => `progress-${++ticks}`,
      watchdogIntervalMs: 10, stalledPassLimit: 2,
    });
    // Wait for several real watchdog ticks to have actually run (polled via
    // the tick counter, not a fixed wall-clock sleep) while the child is
    // still "running".
    await waitUntil(() => ticks >= 6);
    // Snapshot state while the child is still "running", then tear the
    // watchdog down *before* asserting on the snapshot. If an assertion
    // below ever throws (e.g. a future regression reintroduces the
    // demotion bug this test guards against), the watchdog's setInterval
    // would otherwise never see child.emit('close', ...) and would keep
    // firing forever, leaking a real timer that hangs the test process
    // past the whole suite's completion.
    const row = state.invoke('recoveryAttempt', attemptId);
    const attentionCount = state.invoke('allRows', 'attention_events').length;
    const ghCallsSeen = ghCalls;
    fakeChild.stdout.emit('data', JSON.stringify({ logPath: 'child.json', executionPhase: 'implementation', costAdmission: { allowed: true } }));
    fakeChild.emit('close', 0, null);
    await watchdogPromise;
    state.close();
    assert.equal(row.finished_at, null, 'the self-supervised attempt must never be demoted by its own watchdog on a transient authority-read failure');
    assert.equal(row.resolution_state, 'active');
    assert.equal(attentionCount, 0, 'no attention event for a healthy, still-running job');
    assert.equal(ghCallsSeen, 0, 'the watchdog must not re-derive authority via a live GitHub read for the attempt it is directly supervising');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a live process whose manager authority has been superseded is demoted and the global slot released, even though the process itself is confirmed alive (#698 round 5, finding 1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-stale-authority-'));
  const args = { repo: 'TheTekTeam/modelspend', stateDbPath: join(dir, 'state.sqlite'), outputDir: dir, project: { id: 'modelspend' } };
  const ghWrites = [];
  // A later command comment (id 2) supersedes the attempt's original claim
  // (id 1) -- the process claimed under id 1 is still confirmed live, but
  // it is no longer running under *current* manager authority (#698
  // finding 7's ordered timeline resolver). Before this round, a live
  // process alone was enough to stay active forever; this proves it is not.
  const comments = [
    { id: 1, createdAt: '2026-07-16T00:00:00Z', body: '## Claude proceed command\nGo.' },
    { id: 2, createdAt: '2026-07-17T00:00:00Z', body: '## Claude proceed command\nGo again, superseding claim 1.' },
  ];
  const ghRunner = (values) => {
    if (values[1] === 'view') return JSON.stringify({ comments });
    ghWrites.push(values);
    return '';
  };
  try {
    const state = createStateRecorder(args);
    state.record('recordRecoveryAttempt', { attemptId: 'stale-authority', repo: args.repo, issueNumber: 700, startedAt: '2026-07-17T00:00:00Z', processId: 789, claimId: '1', resolutionState: 'active' });
    const result = await reconcileSchedulerAttempts({ state, args, processProbe: async () => true, ghRunner, now: () => '2026-07-17T00:30:00Z' });
    assert.equal(result.orphaned, 1, 'a live process under superseded authority must still be counted as demoted, not left active');
    assert.equal(result.attention.length, 1);
    const row = state.invoke('recoveryAttempt', 'stale-authority');
    assert.notEqual(row.finished_at, null, 'the global slot must be released (finished_at set) despite the process being confirmed alive');
    assert.equal(row.resolution_state, 'unresolved');
    assert.equal(row.outcome, 'unknown_failure', 'a confirmed-live process demoted for a non-liveness reason is unknown_failure, not orphaned_active_claim');
    assert.equal(state.invoke('allRows', 'attention_events').length, 1, 'durable attention must be created for the demotion');
    assert.equal(ghWrites.filter((call) => call[0] === 'issue' && call[1] === 'comment').length, 1, 'the demotion must be surfaced to GitHub, quarantining only this issue');
    state.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('process liveness requires boot identity and process start time, not PID alone', () => {
  const identity = captureProcessIdentity(process.pid, {});
  assert.equal(probeProcessIdentity(identity), true);
  assert.equal(probeProcessIdentity({ ...identity, processStartTicks: `${identity.processStartTicks}9` }), false);
  assert.equal(probeProcessIdentity({ ...identity, processBootId: 'different-boot' }), false);
  assert.equal(probeProcessIdentity({ processId: process.pid }), null);
});

test('fresh recovery collector derives authorization, GitHub status, ownership and conflict booleans from live evidence', async () => {
  const comments = [
    { ...canonicalPreflightComment(41, 'TEST.41', 'Original revision.'), createdAt: '2026-07-17T18:00:00Z' },
    { id: 99, createdAt: '2026-07-17T18:31:00Z', body: '## Manager recovery authorization\n- Attempt: attempt-live\n- Action: fresh_retry\n- Claim revision: 41\n- Preflight revision: 41\n- Agent: claude-code-cli\n- Model: claude-sonnet-4-5\n- Harness: claude\n- Policy approved: yes' },
  ];
  assert.equal(latestManagerRecoveryAuthorization(comments).id, 'github-comment:database:99');
  const ghRunner = (args) => {
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 698, state: 'OPEN', labels: [{ name: 'status:blocked' }, { name: 'agent:claude-code-cli' }], comments });
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
  };
  const result = await collectRecoveryRevalidation({
    stage: 'pre_claim', action: 'fresh_retry',
    attempt: {
      attempt_id: 'attempt-live', issue_number: 698, claim_id: '41', preflight_revision: '41', agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
      finished_at: '2026-07-17T18:30:00Z', process_id: 321, process_boot_id: 'boot-a', process_start_ticks: '10', systemd_invocation_id: 'old',
    },
    args: { repo: 'TheTekTeam/modelspend', project: { localRepoPath: '/not-used' } },
    ghRunner,
    state: { invoke: () => [] },
    processProbe: async () => false,
    currentProcessIdentity: { processId: 500, processBootId: 'boot-a', processStartTicks: '20' },
    repositoryEvidence: { noConflictingBranch: true, noConflictingWorktree: true },
    checkedAt: '2026-07-17T18:32:00Z',
  });
  assert.equal(result.allowed, true);
  assert.equal(result.evidence.issueOpen, true);
  assert.equal(result.evidence.claimRevisionCurrent, true);
  assert.equal(result.evidence.authorizationFresh, true);
});

test('restart recovery revalidation keeps a GraphQL preflight current when GitHub replays it through REST', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-recovery-comment-identity-'));
  const stateDbPath = join(dir, 'state.sqlite');
  const nodeId = 'IC_kwDOSAKVps8AAAABKwq7Lg';
  const databaseId = 5017090862;
  const identity = { version: 1, nodeId, databaseId };
  try {
    let store = openRunnerStateStore(stateDbPath);
    store.recordRecoveryAttempt({
      attemptId: 'attempt-mixed-id', repo: 'TheTekTeam/modelspend', issueNumber: 300,
      claimId: `github-comment:database:${databaseId}`, claimIdentity: identity,
      preflightRevision: `github-comment:database:${databaseId}`, preflightIdentity: identity,
      agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
      startedAt: '2026-07-19T18:00:00Z', finishedAt: '2026-07-19T18:30:00Z',
      outcome: 'provider_execution_limit', recoveryEligible: true, recoveryAction: 'fresh_retry', resolutionState: 'unresolved',
      processId: 321, processBootId: 'boot-a', processStartTicks: '10',
    });
    store.close();

    store = openRunnerStateStore(stateDbPath);
    const attempt = store.recoveryAttempt('attempt-mixed-id');
    const comments = [
      { ...canonicalPreflightComment(databaseId, 'TEST.MIXED', 'Phase: implementation'), node_id: nodeId, created_at: '2026-07-19T18:00:00Z' },
      { id: 5018000000, node_id: 'IC_recoveryAuthorization', created_at: '2026-07-19T18:31:00Z', body: `## Manager recovery authorization\n- Attempt: attempt-mixed-id\n- Action: fresh_retry\n- Claim revision: github-comment:database:${databaseId}\n- Preflight revision: github-comment:database:${databaseId}\n- Agent: claude-code-cli\n- Model: claude-sonnet-4-5\n- Harness: claude\n- Policy approved: yes` },
    ];
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 300, state: 'OPEN', labels: [{ name: 'status:blocked' }, { name: 'agent:claude-code-cli' }], comments });
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
      throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
    };
    const result = await collectRecoveryRevalidation({
      stage: 'pre_claim', action: 'fresh_retry', attempt,
      args: { repo: 'TheTekTeam/modelspend', project: { localRepoPath: '/not-used' } },
      ghRunner,
      state: { invoke: () => [] },
      processProbe: async () => false,
      repositoryEvidence: { noConflictingBranch: true, noConflictingWorktree: true },
      checkedAt: '2026-07-19T18:32:00Z',
    });
    assert.equal(result.allowed, true);
    assert.equal(result.evidence.claimRevisionCurrent, true);
    assert.equal(result.evidence.preflightRevisionCurrent, true);
    assert.deepEqual(JSON.parse(attempt.preflight_identity_json), identity);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function initRepoWithWorktree(issueNumber, worktreeName, branch) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'runner-conflict-repo-'));
  const run = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  run(['init', '--quiet', '-b', 'main']);
  run(['config', 'user.email', 'runner@example.com']);
  run(['config', 'user.name', 'Runner Test']);
  writeFileSync(join(repoRoot, 'README.md'), 'seed\n');
  run(['add', 'README.md']);
  run(['commit', '--quiet', '-m', 'seed']);
  const worktreePath = join(repoRoot, '.claude', 'worktrees', worktreeName);
  run(['worktree', 'add', '-b', branch, worktreePath]);
  return { repoRoot, worktreePath };
}

test('localRecoveryConflicts excludes the attempt\'s own preserved branch/worktree but still flags an unrelated one referencing the same issue', () => {
  const { repoRoot, worktreePath } = initRepoWithWorktree(698, 'own-marker', `issue-698-own`);
  try {
    // Baseline: with no ownArtifact, the attempt's own preserved worktree is
    // (wrongly, pre-fix) indistinguishable from any other conflict.
    const withoutOwnership = localRecoveryConflicts(698, repoRoot);
    assert.equal(withoutOwnership.noConflictingBranch, false);
    assert.equal(withoutOwnership.noConflictingWorktree, false);

    // Fixed: passing the exact own artifact excludes only that one.
    const withOwnership = localRecoveryConflicts(698, repoRoot, { branch: 'issue-698-own', worktreePath });
    assert.equal(withOwnership.noConflictingBranch, true);
    assert.equal(withOwnership.noConflictingWorktree, true);

    // A second, unrelated branch/worktree also referencing issue 698 must
    // still be flagged as a conflict even when the attempt's own artifact is
    // excluded — ownership is exact-match only, never issue-number-wide.
    const strayWorktreePath = join(repoRoot, '.claude', 'worktrees', 'stray-698');
    execFileSync('git', ['worktree', 'add', '-b', 'issue-698-stray', strayWorktreePath], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const withStrayConflict = localRecoveryConflicts(698, repoRoot, { branch: 'issue-698-own', worktreePath });
    assert.equal(withStrayConflict.noConflictingBranch, false, 'a different branch referencing the same issue must still conflict');
    assert.equal(withStrayConflict.noConflictingWorktree, false, 'a different worktree referencing the same issue must still conflict');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('collectRecoveryRevalidation accepts native_resume\'s own preserved worktree as non-conflicting but fresh_retry still forbids the same artifact', async () => {
  const { repoRoot, worktreePath } = initRepoWithWorktree(698, 'resume-marker', 'issue-698-own');
  try {
    const comments = [
      { ...canonicalPreflightComment(41, 'TEST.41', 'Original revision.'), createdAt: '2026-07-17T18:00:00Z' },
      { id: 99, createdAt: '2026-07-17T18:31:00Z', body: '## Manager recovery authorization\n- Attempt: attempt-f1\n- Action: native_resume\n- Claim revision: 41\n- Preflight revision: 41\n- Agent: claude-code-cli\n- Model: claude-sonnet-4-5\n- Harness: claude\n- Policy approved: yes' },
    ];
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 698, state: 'OPEN', labels: [{ name: 'status:blocked' }, { name: 'agent:claude-code-cli' }], comments });
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
      throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
    };
    const baseInput = {
      attempt: {
        attempt_id: 'attempt-f1', issue_number: 698, claim_id: '41', preflight_revision: '41',
        agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude', finished_at: '2026-07-17T18:30:00Z',
      },
      args: { repo: 'TheTekTeam/modelspend', project: { localRepoPath: repoRoot } },
      ghRunner, state: { invoke: () => [] }, processProbe: async () => false,
      currentProcessIdentity: { processId: 1 }, checkedAt: '2026-07-17T18:32:00Z',
      restrictedHandleReader: () => ({
        handle: { attemptId: 'attempt-f1', worktreeName: 'resume-marker', expectedBranch: 'issue-698-own', sessionId: 'sess-1' },
        permissionSafe: true,
      }),
      worktreeVerifier: () => ({ preservedWorktreeCurrent: true, checkpointCurrent: true }),
      cliCapabilityProbe: () => ({ supported: true }),
    };

    const nativeResumeResult = await collectRecoveryRevalidation({ ...baseInput, stage: 'pre_claim', action: 'native_resume' });
    assert.equal(nativeResumeResult.evidence.noConflictingBranch, true, 'native_resume must accept its own exact preserved branch');
    assert.equal(nativeResumeResult.evidence.noConflictingWorktree, true, 'native_resume must accept its own exact preserved worktree');

    const freshRetryResult = await collectRecoveryRevalidation({ ...baseInput, stage: 'pre_claim', action: 'fresh_retry' });
    assert.equal(freshRetryResult.evidence.noConflictingBranch, false, 'fresh_retry must still forbid a preserved mutation artifact');
    assert.equal(freshRetryResult.evidence.noConflictingWorktree, false, 'fresh_retry must still forbid a preserved mutation artifact');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('collectRecoveryRevalidation verifies the restricted handle binding digest and fails closed on mismatch or absence (#698 finding 8)', async () => {
  const comments = [
    { ...canonicalPreflightComment(41, 'TEST.41', 'Original revision.'), createdAt: '2026-07-17T18:00:00Z' },
    { id: 99, createdAt: '2026-07-17T18:31:00Z', body: '## Manager recovery authorization\n- Attempt: attempt-f8\n- Action: native_resume\n- Claim revision: 41\n- Preflight revision: 41\n- Agent: claude-code-cli\n- Model: claude-sonnet-4-5\n- Harness: claude\n- Policy approved: yes' },
  ];
  const ghRunner = (args) => {
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 698, state: 'OPEN', labels: [{ name: 'status:blocked' }, { name: 'agent:claude-code-cli' }], comments });
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
  };
  const handle = { attemptId: 'attempt-f8', worktreeName: 'resume-marker', expectedBranch: 'issue-698-own', sessionId: 'sess-1', checkpointHead: 'abc123', checkpointStatusFingerprint: 'fp-1' };
  const correctDigest = restrictedHandleBindingDigest({
    attemptId: 'attempt-f8', agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    checkpointHead: 'abc123', checkpointStatusFingerprint: 'fp-1',
  });
  const baseInput = {
    args: { repo: 'TheTekTeam/modelspend', project: { localRepoPath: '/not-used' } },
    ghRunner, state: { invoke: () => [] }, processProbe: async () => false,
    currentProcessIdentity: { processId: 1 }, checkedAt: '2026-07-17T18:32:00Z',
    repositoryEvidence: { noConflictingBranch: true, noConflictingWorktree: true },
    restrictedHandleReader: () => ({ handle, permissionSafe: true }),
    worktreeVerifier: () => ({ preservedWorktreeCurrent: true, checkpointCurrent: true }),
    cliCapabilityProbe: () => ({ supported: true }),
    stage: 'pre_claim', action: 'native_resume',
  };

  const matching = await collectRecoveryRevalidation({
    ...baseInput,
    attempt: {
      attempt_id: 'attempt-f8', issue_number: 698, claim_id: '41', preflight_revision: '41',
      agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude', finished_at: '2026-07-17T18:30:00Z',
      process_id: 321, process_boot_id: 'boot-a', process_start_ticks: '10', systemd_invocation_id: 'old',
      restricted_handle_digest: correctDigest,
    },
  });
  assert.equal(matching.evidence.restrictedHandleBindingVerified, true);
  assert.equal(matching.allowed, true);

  // The persisted attempt row's model silently diverged from what the
  // digest was originally bound to (e.g. a data inconsistency, or a handle
  // file swapped from a different attempt) — must fail closed even though
  // every other fact matches.
  const mismatched = await collectRecoveryRevalidation({
    ...baseInput,
    attempt: {
      attempt_id: 'attempt-f8', issue_number: 698, claim_id: '41', preflight_revision: '41',
      agent: 'claude-code-cli', model: 'claude-opus-4', harness: 'claude', finished_at: '2026-07-17T18:30:00Z',
      restricted_handle_digest: correctDigest,
    },
  });
  assert.equal(mismatched.evidence.restrictedHandleBindingVerified, false);
  assert.equal(mismatched.allowed, false);
  assert.equal(mismatched.failedChecks.includes('restrictedHandleBindingVerified'), true);

  // No digest was ever persisted (e.g. an old row from before this column
  // existed, or the child never captured a handle) — fails closed, not
  // "trust the handle file alone".
  const missingDigest = await collectRecoveryRevalidation({
    ...baseInput,
    attempt: {
      attempt_id: 'attempt-f8', issue_number: 698, claim_id: '41', preflight_revision: '41',
      agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude', finished_at: '2026-07-17T18:30:00Z',
      restricted_handle_digest: null,
    },
  });
  assert.equal(missingDigest.evidence.restrictedHandleBindingVerified, false);
  assert.equal(missingDigest.allowed, false);
});

test('successful recovery conservatively moves blocked to in-progress and never closes the issue', () => {
  const calls = [];
  const result = restoreIssueAfterSuccessfulRecovery(
    { repo: 'TheTekTeam/modelspend' },
    { number: 698 },
    (args) => { calls.push(args); return ''; },
  );
  assert.deepEqual(calls, [[
    'issue', 'edit', '698', '--repo', 'TheTekTeam/modelspend',
    '--remove-label', 'status:blocked', '--add-label', 'status:in-progress',
  ]]);
  assert.equal(result.issueClosed, false);
  assert.equal(calls.flat().includes('close'), false);
  const body = runnerAttentionCommentBody({ number: 698 }, {
    reason: 'completed',
    finishedAt: '2026-07-17T23:00:00.000Z',
    recoveryStatus: 'succeeded',
  });
  assert.match(body, /remains open/);
  assert.match(body, /status:blocked.*status:in-progress/);
  assert.match(body, /without auto-closing/);
  assert.doesNotMatch(body, /task-local failure/);
});

const SAFE_RECOVERY_REVALIDATION_EVIDENCE = Object.freeze({
  issueOpen: true, expectedStatusCurrent: true, agentOwnershipCurrent: true,
  claimRevisionCurrent: true, preflightRevisionCurrent: true,
  authorizationFresh: true, authorizationCurrent: true,
  noConflictingPr: true, noConflictingBranch: true, noConflictingWorktree: true,
  noHandoff: true, noConflictingProcess: true, noConflictingLease: true,
  agentCompatible: true, modelCompatible: true, harnessCompatible: true,
  sameRecoveryClaim: true, sameRecoveryAgent: true, noNewerManagerAction: true,
});

test('successful due-recovery path persists and applies blocked to in-progress without issue closure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-successful-recovery-'));
  const stateDbPath = join(dir, 'state.sqlite');
  const lockPath = join(dir, 'cron.lock');
  const attemptId = 'recovery-attempt';
  const attentionEvent = {
    repository: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 698, reason: 'transient_provider_or_network_failure',
    attemptId, agent: 'claude-code-cli', startedAt: '2026-07-17T18:00:00Z', finishedAt: '2026-07-17T18:01:00Z',
    recoveryStatus: 'eligible', nextAction: 'Retry safely.', dashboardReference: 'issue-698', policyRevision: 'runner-recovery-v1',
    dedupeKey: 'a'.repeat(64),
  };
  let store = openRunnerStateStore(stateDbPath);
  store.recordRecoveryAttempt({
    attemptId, repo: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 698, startedAt: attentionEvent.startedAt,
    claimId: '41', preflightRevision: '41', agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    finishedAt: attentionEvent.finishedAt, outcome: attentionEvent.reason, recoveryEligible: true, recoveryAction: 'fresh_retry',
    recoveryAttemptCount: 0, retryAt: '2026-07-17T18:02:00Z', attentionStatus: 'attention_required', resolutionState: 'unresolved',
  });
  store.upsertAttentionEvent(attentionEvent);
  store.close();
  const ghCalls = [];
  const existingBody = '<!-- agent-runner:attention:v1 -->\n\n## Agent runner attention required';
  let statusLabel = 'status:blocked';
  const ghRunner = (args) => {
    ghCalls.push(args);
    if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--add-label')) {
      statusLabel = args[args.indexOf('--add-label') + 1];
      return '';
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      return JSON.stringify({
        state: 'OPEN',
        labels: [{ name: statusLabel }, { name: 'agent:claude-code-cli' }],
        comments: [{ id: 42, body: existingBody, createdAt: '2026-07-17T18:01:00Z' }],
      });
    }
    return '';
  };
  const originalLog = console.log;
  try {
    console.log = () => {};
    const exitCode = await main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir, '--state-db', stateDbPath, '--lock-path', lockPath,
    ], { GH_TOKEN: 'test-token' }, {
      ghRunner,
      recoveryLeaseId: 'lease-1',
      revalidateRecovery: async ({ stage }) => ({
        stage, action: 'fresh_retry', checkedAt: `2026-07-17T18:0${stage === 'pre_claim' ? '2' : stage === 'pre_launch' ? '3' : '4'}:00Z`,
        allowed: true, failedChecks: [], authorizationId: '99', evidence: SAFE_RECOVERY_REVALIDATION_EVIDENCE,
        issue: { number: 698, state: 'OPEN', statusLabel: 'status:blocked', labels: ['status:blocked', 'agent:claude-code-cli'], comments: [{ id: 42, body: existingBody }] },
      }),
      runChild: async () => ({ status: 0, signal: null, stdout: JSON.stringify({ logPath: 'child.json', executionPhase: 'implementation', costAdmission: { allowed: true }, sourcePreflightCommentId: '41' }), stderr: '', error: null }),
    });
    assert.equal(exitCode, 0);
    const transition = ghCalls.find((call) => call[0] === 'issue' && call[1] === 'edit');
    assert.deepEqual(transition, ['issue', 'edit', '698', '--repo', 'TheTekTeam/modelspend', '--remove-label', 'status:blocked', '--add-label', 'status:in-progress']);
    assert.equal(ghCalls.flat().includes('close'), false);
    store = openRunnerStateStore(stateDbPath);
    const recoveryEvent = store.allRows('queue_events').find((row) => row.event_type === 'recovery-succeeded');
    assert.equal(recoveryEvent.status_label, 'status:in-progress');
    assert.equal(store.allRows('attention_events')[0].resolved_at !== null, true);
    store.close();
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

async function runRecoveryRevalidationScenario({ action = 'fresh_retry', decideStage, childResult, extraDependencies = {}, outputDir, cleanup = true, env = {} } = {}) {
  const dir = outputDir || mkdtempSync(join(tmpdir(), 'runner-revalidation-'));
  const stateDbPath = join(dir, 'state.sqlite');
  const lockPath = join(dir, 'cron.lock');
  const attemptId = `attempt-${action}`;
  let store = openRunnerStateStore(stateDbPath);
  store.recordRecoveryAttempt({
    attemptId, repo: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 698, claimId: '41', preflightRevision: '41',
    agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    startedAt: '2026-07-17T18:00:00Z', finishedAt: '2026-07-17T18:01:00Z',
    outcome: action === 'native_resume' ? 'provider_execution_limit' : 'transient_provider_or_network_failure',
    recoveryEligible: true, recoveryAction: action, recoveryAttemptCount: 0, retryAt: '2026-07-17T18:02:00Z',
    attentionStatus: 'attention_required', resolutionState: 'unresolved',
    processId: 321, processBootId: 'old-boot', processStartTicks: '100', systemdInvocationId: 'old-invocation',
  });
  store.close();
  const stages = [];
  const ghCalls = [];
  const childInvocations = [];
  let childCalls = 0;
  let tick = 0;
  const now = () => `2026-07-17T19:00:${String(tick++).padStart(2, '0')}.000Z`;
  const originalLog = console.log;
  try {
    console.log = () => {};
    const exitCode = await main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir, '--state-db', stateDbPath, '--lock-path', lockPath,
    ], { GH_TOKEN: 'test-token', ...env }, {
      now,
      recoveryLeaseId: 'lease-current',
      ghRunner: (args) => {
        ghCalls.push(args);
        if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments: [] });
        return '';
      },
      revalidateRecovery: async ({ stage }) => {
        stages.push(stage);
        const override = decideStage?.(stage, stages.length) || {};
        return {
          stage, action, checkedAt: now(), allowed: true, failedChecks: [], authorizationId: '99',
          issue: { number: 698, state: 'OPEN', statusLabel: 'status:blocked', labels: ['status:blocked', 'agent:claude-code-cli'], comments: [] },
          ...override,
          evidence: { ...SAFE_RECOVERY_REVALIDATION_EVIDENCE, ...(override.evidence || {}) },
        };
      },
      runChild: async (options) => {
        childCalls += 1;
        childInvocations.push({ command: options.command, commandArgs: options.commandArgs });
        return childResult || { status: 0, signal: null, stdout: JSON.stringify({ logPath: 'child.json', executionPhase: 'implementation', costAdmission: { allowed: true }, sourcePreflightCommentId: '41' }), stderr: '', error: null };
      },
      ...extraDependencies,
    });
    store = openRunnerStateStore(stateDbPath);
    const snapshot = {
      attempts: store.allRows('recovery_attempts'),
      revalidations: store.allRows('recovery_revalidations'),
      attention: store.allRows('attention_events'),
      queue: store.allRows('queue_events'),
    };
    store.close();
    return { exitCode, childCalls, childInvocations, stages, ghCalls, snapshot, dir };
  } finally {
    console.log = originalLog;
    if (cleanup) rmSync(dir, { recursive: true, force: true });
  }
}

test('status changed while recovery waits blocks before claim and launches no child', async () => {
  const result = await runRecoveryRevalidationScenario({
    decideStage: (stage) => stage === 'pre_claim' ? { allowed: false, failedChecks: ['expectedStatusCurrent'], evidence: { expectedStatusCurrent: false } } : {},
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.childCalls, 0);
  assert.deepEqual(result.stages, ['pre_claim']);
  assert.equal(result.snapshot.revalidations[0].allowed, 0);
});

test('a new handoff or linked PR before recovery persists attention and does not launch', async (t) => {
  for (const failedCheck of ['noHandoff', 'noConflictingPr']) {
    await t.test(failedCheck, async () => {
      const result = await runRecoveryRevalidationScenario({
        decideStage: (stage) => stage === 'pre_claim' ? { allowed: false, failedChecks: [failedCheck], evidence: { [failedCheck]: false } } : {},
      });
      assert.equal(result.childCalls, 0);
      assert.equal(result.snapshot.attention.length, 1);
    });
  }
});

test('stale manager or preflight revision fails closed before recovery claim', async () => {
  const result = await runRecoveryRevalidationScenario({
    decideStage: (stage) => stage === 'pre_claim' ? { allowed: false, failedChecks: ['claimRevisionCurrent', 'authorizationFresh'], evidence: { claimRevisionCurrent: false, authorizationFresh: false } } : {},
  });
  assert.equal(result.childCalls, 0);
  assert.match(result.snapshot.attention[0].event_json, /claimRevisionCurrent/);
});

test('unsupported recovery action reaches no child invocation', async () => {
  const result = await runRecoveryRevalidationScenario({ action: 'invented_resume' });
  assert.equal(result.childCalls, 0);
  assert.deepEqual(result.stages, ['pre_claim']);
  assert.match(result.snapshot.attention[0].event_json, /actionAllowlisted/);
});

test('native_resume without a restricted resume handle never substitutes a fresh run', async () => {
  const result = await runRecoveryRevalidationScenario({ action: 'native_resume' });
  assert.equal(result.childCalls, 0);
  assert.match(result.snapshot.attention[0].event_json, /restrictedResumeHandleAvailable/);
});

test('native_resume and same_agent_continuation fail closed by default on this release, even with every other evidence proven, launch nothing, release the slot, and surface exact attention (#698 round 5, finding 4)', async () => {
  // Full positive evidence for every OTHER fact — the only thing missing
  // is the machine-local enablement gate (no `env` override here, matching
  // the actual Dell configuration today: no CLAUDE_RUNNER_ENABLE_NATIVE_RESUME).
  const dir = mkdtempSync(join(tmpdir(), 'runner-native-resume-disabled-'));
  try {
    writeRestrictedRecoveryHandle(dir, 'attempt-native_resume', {
      attemptId: 'attempt-native_resume', sessionId: 'session-should-never-be-used', worktreeName: 'agent-runner-698-41',
      expectedBranch: 'worktree-agent-runner-698-41', agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    });
    const result = await runRecoveryRevalidationScenario({
      action: 'native_resume',
      outputDir: dir,
      cleanup: false,
      decideStage: () => ({ evidence: { restrictedResumeHandleAvailable: true, resumeCliSupportVerified: true, checkpointCurrent: true, restrictedHandleBindingVerified: true } }),
    });
    assert.equal(result.childCalls, 0, 'no child process may ever launch while the release-level gate is closed');
    assert.match(result.snapshot.attention[0].event_json, /native-resume-disabled-for-this-release/, 'the exact denial reason must be surfaced to the operator, not a generic failure');
    const attempt = result.snapshot.attempts.find((row) => row.attempt_id === 'attempt-native_resume');
    assert.notEqual(attempt.finished_at, null, 'the global slot must be released (finished_at set), never left claimed while disabled');
    assert.equal(attempt.recovery_eligible, 0, 'a release-disabled action must not remain auto-retry eligible');
    // Preserved branch/worktree/checkpoint material: the restricted handle
    // this attempt's session/worktree identity lives in must still be
    // intact and readable — nothing in the denial path touches it.
    const preserved = readRestrictedRecoveryHandle(dir, 'attempt-native_resume');
    assert.equal(preserved.available, true, 'the restricted worktree/checkpoint/session material must remain preserved, not discarded, when the action is disabled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same_agent_continuation fails closed by default on this release with every other evidence proven', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-continuation-disabled-'));
  try {
    writeRestrictedRecoveryHandle(dir, 'attempt-same_agent_continuation', {
      attemptId: 'attempt-same_agent_continuation', sessionId: null, worktreeName: 'agent-runner-698-41',
      expectedBranch: 'worktree-agent-runner-698-41', agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    });
    const result = await runRecoveryRevalidationScenario({
      action: 'same_agent_continuation',
      outputDir: dir,
      decideStage: () => ({ evidence: { preservedWorktreeCurrent: true, checkpointCurrent: true, explicitContinuationPolicyApproval: true, restrictedHandleBindingVerified: true } }),
    });
    assert.equal(result.childCalls, 0);
    assert.match(result.snapshot.attention[0].event_json, /same-agent-continuation-disabled-for-this-release/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a positive native_resume invocation reads the restricted handle and reaches the adapter-built invocation exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-native-resume-'));
  try {
    writeRestrictedRecoveryHandle(dir, 'attempt-native_resume', {
      attemptId: 'attempt-native_resume', sessionId: 'session-secret-abc', worktreeName: 'agent-runner-698-41',
      expectedBranch: 'worktree-agent-runner-698-41', agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    });
    let statusLabel = 'status:blocked';
    const ghCalls = [];
    const ghRunner = (args) => {
      ghCalls.push(args);
      if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--add-label')) {
        statusLabel = args[args.indexOf('--add-label') + 1];
        return '';
      }
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: statusLabel }], comments: [] });
      return '';
    };
    const result = await runRecoveryRevalidationScenario({
      action: 'native_resume',
      outputDir: dir,
      decideStage: () => ({ evidence: { restrictedResumeHandleAvailable: true, resumeCliSupportVerified: true, checkpointCurrent: true, restrictedHandleBindingVerified: true } }),
      extraDependencies: { ghRunner },
      // #698 round 5, finding 4: native_resume fails closed by default;
      // this positive-path test explicitly opens the machine-local
      // enablement gate to reach the adapter-built invocation.
      env: { CLAUDE_RUNNER_ENABLE_NATIVE_RESUME: '1' },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.childCalls, 1);
    const invocationArgs = result.childInvocations[0].commandArgs;
    assert.equal(invocationArgs[invocationArgs.indexOf('--recovery-mode') + 1], 'native_resume');
    assert.equal(invocationArgs[invocationArgs.indexOf('--resume-session') + 1], 'session-secret-abc');
    assert.equal(invocationArgs[invocationArgs.indexOf('--attempt-id') + 1], 'attempt-native_resume');
    // The restricted session id must never leak into ordinary state, GitHub payloads, or run-result JSON.
    assert.doesNotMatch(JSON.stringify(result.snapshot), /session-secret-abc/);
    assert.doesNotMatch(JSON.stringify(ghCalls), /session-secret-abc/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a positive same_agent_continuation invocation reaches the adapter-built invocation without a resume-session flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-continuation-'));
  try {
    writeRestrictedRecoveryHandle(dir, 'attempt-same_agent_continuation', {
      attemptId: 'attempt-same_agent_continuation', sessionId: null, worktreeName: 'agent-runner-698-41',
      expectedBranch: 'worktree-agent-runner-698-41', agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    });
    let statusLabel = 'status:blocked';
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--add-label')) {
        statusLabel = args[args.indexOf('--add-label') + 1];
        return '';
      }
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: statusLabel }], comments: [] });
      return '';
    };
    const result = await runRecoveryRevalidationScenario({
      action: 'same_agent_continuation',
      outputDir: dir,
      decideStage: () => ({ evidence: { preservedWorktreeCurrent: true, checkpointCurrent: true, explicitContinuationPolicyApproval: true, restrictedHandleBindingVerified: true } }),
      extraDependencies: { ghRunner },
      env: { CLAUDE_RUNNER_ENABLE_NATIVE_RESUME: '1' },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.childCalls, 1);
    const invocationArgs = result.childInvocations[0].commandArgs;
    assert.equal(invocationArgs[invocationArgs.indexOf('--recovery-mode') + 1], 'same_agent_continuation');
    assert.equal(invocationArgs.includes('--resume-session'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same_agent_continuation without explicit policy approval never substitutes a fresh run', async () => {
  const result = await runRecoveryRevalidationScenario({ action: 'same_agent_continuation' });
  assert.equal(result.childCalls, 0);
  assert.match(result.snapshot.attention[0].event_json, /explicitContinuationPolicyApproval/);
});

test('native_resume with an unavailable CLI resume control never substitutes a fresh run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-native-resume-no-cli-'));
  try {
    writeRestrictedRecoveryHandle(dir, 'attempt-native_resume', {
      attemptId: 'attempt-native_resume', sessionId: 'session-secret-xyz', worktreeName: 'agent-runner-698-41',
      expectedBranch: 'worktree-agent-runner-698-41', agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    });
    const result = await runRecoveryRevalidationScenario({
      action: 'native_resume',
      outputDir: dir,
      decideStage: () => ({ evidence: { restrictedResumeHandleAvailable: true, resumeCliSupportVerified: false, checkpointCurrent: true } }),
    });
    assert.equal(result.childCalls, 0);
    assert.match(result.snapshot.attention[0].event_json, /resumeCliSupportVerified/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same_agent_continuation with a stale/missing preserved worktree never substitutes a fresh run', async () => {
  const result = await runRecoveryRevalidationScenario({
    action: 'same_agent_continuation',
    decideStage: () => ({ evidence: { preservedWorktreeCurrent: false, checkpointCurrent: false, explicitContinuationPolicyApproval: true } }),
  });
  assert.equal(result.childCalls, 0);
  assert.match(result.snapshot.attention[0].event_json, /preservedWorktreeCurrent/);
});

test('readRestrictedRecoveryHandle proves a fresh attempt never reuses a restricted handle written under a broader permission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-restricted-perm-'));
  try {
    writeRestrictedRecoveryHandle(dir, 'attempt-x', { attemptId: 'attempt-x', sessionId: 's' });
    chmodSync(join(restrictedRecoveryDir(dir), 'attempt-x.json'), 0o644);
    const read = readRestrictedRecoveryHandle(dir, 'attempt-x');
    assert.equal(read.available, false);
    assert.equal(read.permissionSafe, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Recursively locate every occurrence of `needle` inside a JSON-serializable
 * value, returning dotted/bracketed paths for diagnosability. Used by the
 * redaction regression below to prove a restricted sentinel appears nowhere
 * it shouldn't, not just in the one or two fields a targeted test happens
 * to check (#698 finding 9 re-review).
 */
function findSentinelPaths(value, needle, path = '$', seen = new Set()) {
  if (typeof value === 'string') return value.includes(needle) ? [path] : [];
  if (!value || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...findSentinelPaths(item, needle, `${path}[${index}]`, seen)));
  } else {
    for (const [key, item] of Object.entries(value)) hits.push(...findSentinelPaths(item, needle, `${path}.${key}`, seen));
  }
  return hits;
}

test('recursive redaction regression: the restricted session sentinel never leaks outside the restricted store and the injected spawn invocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-redaction-regression-'));
  const SENTINEL = 'sentinel-restricted-9f3c7a1e4b6d';
  const originalLog = console.log;
  try {
    writeRestrictedRecoveryHandle(dir, 'attempt-native_resume', {
      attemptId: 'attempt-native_resume', sessionId: SENTINEL, worktreeName: 'agent-runner-698-41',
      expectedBranch: 'worktree-agent-runner-698-41', agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    });
    let statusLabel = 'status:blocked';
    const ghCalls = [];
    const ghRunner = (args) => {
      ghCalls.push(args);
      if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--add-label')) {
        statusLabel = args[args.indexOf('--add-label') + 1];
        return '';
      }
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: statusLabel }], comments: [] });
      return '';
    };
    const consoleLines = [];
    console.log = (...values) => { consoleLines.push(values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')); };
    let capturedInvocationArgs = null;
    const result = await runRecoveryRevalidationScenario({
      action: 'native_resume',
      outputDir: dir,
      cleanup: false,
      decideStage: () => ({ evidence: { restrictedResumeHandleAvailable: true, resumeCliSupportVerified: true, checkpointCurrent: true, restrictedHandleBindingVerified: true } }),
      extraDependencies: {
        ghRunner,
        runChild: async (options) => {
          capturedInvocationArgs = options.commandArgs;
          return { status: 0, signal: null, stdout: JSON.stringify({ logPath: 'child.json', executionPhase: 'implementation', costAdmission: { allowed: true } }), stderr: '', error: null };
        },
      },
      env: { CLAUDE_RUNNER_ENABLE_NATIVE_RESUME: '1' },
    });
    console.log = originalLog;

    // Sanity: the sentinel really was used for the actual spawn invocation
    // (the one place it's allowed outside the restricted store) — otherwise
    // the "never leaks" assertions below would pass vacuously.
    assert.ok(capturedInvocationArgs?.includes(SENTINEL), 'sanity: the real invocation must carry the session id');

    // Allowed appearance #1: the restricted store file itself.
    const restrictedFile = join(restrictedRecoveryDir(dir), 'attempt-native_resume.json');
    assert.match(readFileSync(restrictedFile, 'utf8'), new RegExp(SENTINEL));

    // Every other surface: recursively scanned, not spot-checked.
    const state = openRunnerStateStore(join(dir, 'state.sqlite'));
    const fullDbSnapshot = Object.fromEntries(RUNNER_STATE_TABLES.map((table) => [table, state.allRows(table)]));
    state.close();
    const dbHits = findSentinelPaths(fullDbSnapshot, SENTINEL);
    assert.deepEqual(dbHits, [], `sentinel must never appear in ordinary SQLite state (found at: ${dbHits.join(', ')})`);

    const ghHits = findSentinelPaths(ghCalls, SENTINEL);
    assert.deepEqual(ghHits, [], `sentinel must never appear in any GitHub API call (found at: ${ghHits.join(', ')})`);

    const consoleHits = consoleLines.filter((line) => line.includes(SENTINEL));
    assert.deepEqual(consoleHits, [], 'sentinel must never appear in console output');

    const snapshotHits = findSentinelPaths(result.snapshot, SENTINEL);
    assert.deepEqual(snapshotHits, [], `sentinel must never appear in the scenario's own state snapshot (found at: ${snapshotHits.join(', ')})`);

    const logFiles = readdirSync(dir).filter((name) => name.endsWith('.json'));
    for (const file of logFiles) {
      const content = readFileSync(join(dir, file), 'utf8');
      assert.doesNotMatch(content, new RegExp(SENTINEL), `sentinel must never appear in log file ${file}`);
    }
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale blocked status at successful recovery completion leaves GitHub unchanged', async () => {
  const result = await runRecoveryRevalidationScenario({
    decideStage: (stage) => stage === 'pre_transition'
      ? { allowed: false, failedChecks: ['expectedStatusCurrent'], evidence: { expectedStatusCurrent: false }, issue: { number: 698, state: 'OPEN', statusLabel: 'status:ready', labels: ['status:ready', 'agent:claude-code-cli'], comments: [] } }
      : {},
  });
  assert.equal(result.childCalls, 1);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.stages, ['pre_claim', 'post_claim', 'pre_launch', 'pre_transition']);
  assert.equal(result.ghCalls.some((call) => call[0] === 'issue' && call[1] === 'edit'), false);
  assert.equal(result.snapshot.attention.length, 1);
});

test('revalidation-to-launch race is closed by the second fresh check', async () => {
  const result = await runRecoveryRevalidationScenario({
    decideStage: (stage) => stage === 'pre_launch' ? { allowed: false, failedChecks: ['authorizationCurrent', 'noNewerManagerAction'], evidence: { authorizationCurrent: false, noNewerManagerAction: false } } : {},
  });
  assert.equal(result.childCalls, 0);
  assert.deepEqual(result.stages, ['pre_claim', 'post_claim', 'pre_launch']);
  assert.deepEqual(result.snapshot.revalidations.map((row) => row.allowed), [1, 1, 0]);
});

function attentionCommentCalls(ghCalls) {
  return ghCalls.filter((call) => call[0] === 'issue' && call[1] === 'comment' && call.includes('--body')
    && call[call.indexOf('--body') + 1].includes('<!-- agent-runner:attention:v1 -->'));
}

test('every blocked recovery stage publishes the sanitized GitHub attention marker exactly once', async (t) => {
  const scenarios = {
    pre_claim: { decideStage: (stage) => stage === 'pre_claim' ? { allowed: false, failedChecks: ['expectedStatusCurrent'], evidence: { expectedStatusCurrent: false } } : {} },
    post_claim_dispatch: { decideStage: (stage) => stage === 'post_claim' ? { allowed: false, failedChecks: ['authorizationCurrent'], evidence: { authorizationCurrent: false } } : {} },
    immediate_pre_launch: { decideStage: (stage) => stage === 'pre_launch' ? { allowed: false, failedChecks: ['authorizationCurrent', 'noNewerManagerAction'], evidence: { authorizationCurrent: false, noNewerManagerAction: false } } : {} },
  };
  for (const [label, options] of Object.entries(scenarios)) {
    await t.test(label, async () => {
      const result = await runRecoveryRevalidationScenario(options);
      const comments = attentionCommentCalls(result.ghCalls);
      assert.equal(comments.length, 1, `expected exactly one GitHub attention comment for ${label}`);
      assert.equal(result.snapshot.attention.length, 1);
    });
  }
});

test('an identical blocked-recovery pass performs zero additional GitHub attention writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-attention-dedupe-'));
  const stateDbPath = join(dir, 'state.sqlite');
  const lockPath = join(dir, 'cron.lock');
  const attemptId = 'attempt-dedupe';
  let store = openRunnerStateStore(stateDbPath);
  store.recordRecoveryAttempt({
    attemptId, repo: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 698, claimId: '41', preflightRevision: '41',
    agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    startedAt: '2026-07-17T18:00:00Z', finishedAt: '2026-07-17T18:01:00Z', outcome: 'transient_provider_or_network_failure',
    recoveryEligible: true, recoveryAction: 'fresh_retry', recoveryAttemptCount: 0, retryAt: '2026-07-17T18:02:00Z',
    attentionStatus: 'attention_required', resolutionState: 'unresolved',
  });
  store.close();
  const ghCalls = [];
  const runPass = async (tick) => {
    const now = () => `2026-07-17T19:0${tick}:00.000Z`;
    return main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir, '--state-db', stateDbPath, '--lock-path', lockPath,
    ], { GH_TOKEN: 'test-token' }, {
      now,
      recoveryLeaseId: `lease-${tick}`,
      ghRunner: (args) => { ghCalls.push(args); if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments: [] }); return ''; },
      revalidateRecovery: async ({ stage }) => ({
        stage, action: 'fresh_retry', checkedAt: now(), allowed: false, failedChecks: ['expectedStatusCurrent'],
        authorizationId: '99', issue: { number: 698, state: 'OPEN', statusLabel: 'status:ready', labels: ['status:ready'], comments: [] },
        evidence: { ...SAFE_RECOVERY_REVALIDATION_EVIDENCE, expectedStatusCurrent: false },
      }),
      runChild: async () => ({ status: 0, signal: null, stdout: '', stderr: '', error: null }),
    });
  };
  const originalLog = console.log;
  try {
    console.log = () => {};
    await runPass(0);
    const firstComments = attentionCommentCalls(ghCalls).length;
    assert.equal(firstComments, 1);
    await runPass(1);
    const secondComments = attentionCommentCalls(ghCalls).length;
    assert.equal(secondComments, 1, 'an unchanged repeated blocked pass must not write a second GitHub comment');
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

function successfulRecoveryHarness(dir) {
  const stateDbPath = join(dir, 'state.sqlite');
  const lockPath = join(dir, 'cron.lock');
  const attemptId = 'recovery-transition-attempt';
  const store = openRunnerStateStore(stateDbPath);
  store.recordRecoveryAttempt({
    attemptId, repo: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 698, startedAt: '2026-07-17T18:00:00Z',
    claimId: '41', preflightRevision: '41', agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    finishedAt: '2026-07-17T18:01:00Z', outcome: 'transient_provider_or_network_failure', recoveryEligible: true,
    recoveryAction: 'fresh_retry', recoveryAttemptCount: 0, retryAt: '2026-07-17T18:02:00Z',
    attentionStatus: 'attention_required', resolutionState: 'unresolved',
  });
  store.close();
  return { stateDbPath, lockPath, attemptId };
}

async function runSuccessfulRecoveryTransition({ dir, ghRunner }) {
  const { stateDbPath, lockPath } = successfulRecoveryHarness(dir);
  const originalLog = console.log;
  try {
    console.log = () => {};
    const exitCode = await main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir, '--state-db', stateDbPath, '--lock-path', lockPath,
    ], { GH_TOKEN: 'test-token' }, {
      ghRunner,
      recoveryLeaseId: 'lease-1',
      revalidateRecovery: async ({ stage }) => ({
        stage, action: 'fresh_retry', checkedAt: '2026-07-17T18:05:00Z', allowed: true, failedChecks: [], authorizationId: '99',
        evidence: SAFE_RECOVERY_REVALIDATION_EVIDENCE,
        issue: { number: 698, state: 'OPEN', statusLabel: 'status:blocked', labels: ['status:blocked', 'agent:claude-code-cli'], comments: [] },
      }),
      runChild: async () => ({ status: 0, signal: null, stdout: JSON.stringify({ logPath: 'child.json', executionPhase: 'implementation', costAdmission: { allowed: true }, sourcePreflightCommentId: '41' }), stderr: '', error: null }),
    });
    const state = openRunnerStateStore(stateDbPath);
    const snapshot = { attempts: state.allRows('recovery_attempts'), attention: state.allRows('attention_events') };
    state.close();
    return { exitCode, snapshot };
  } finally {
    console.log = originalLog;
  }
}

test('a failed GitHub label mutation on successful recovery leaves the issue unresolved and returns nonzero', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-transition-mutation-failure-'));
  try {
    const ghCalls = [];
    const ghRunner = (args) => {
      ghCalls.push(args);
      if (args[0] === 'issue' && args[1] === 'edit') throw new Error('gh api rate limited');
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: 'status:blocked' }], comments: [] });
      return '';
    };
    const { exitCode, snapshot } = await runSuccessfulRecoveryTransition({ dir, ghRunner });
    assert.equal(exitCode, 1);
    assert.equal(snapshot.attempts[0].resolution_state, 'transition_uncertain');
    assert.equal(snapshot.attention.length, 1);
    assert.equal(snapshot.attention[0].resolved_at, null);
    assert.match(snapshot.attention[0].event_json, /github-mutation-failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a successful gh exit that does not durably change labels is not trusted as a completed transition', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-transition-verify-failure-'));
  try {
    const ghCalls = [];
    const ghRunner = (args) => {
      ghCalls.push(args);
      // gh exits 0 but the label state never actually changed (partial/failed mutation).
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: 'status:blocked' }], comments: [] });
      return '';
    };
    const { exitCode, snapshot } = await runSuccessfulRecoveryTransition({ dir, ghRunner });
    assert.equal(exitCode, 1);
    assert.equal(snapshot.attempts[0].resolution_state, 'transition_uncertain');
    assert.equal(snapshot.attention.length, 1);
    assert.match(snapshot.attention[0].event_json, /post-mutation-verification-failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a resolved-attention comment delivery failure leaves the recovery unresolved and returns nonzero', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-transition-resolved-attention-failure-'));
  try {
    let editCount = 0;
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'edit') { editCount += 1; return ''; }
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: 'status:in-progress' }], comments: [] });
      if (args[0] === 'issue' && args[1] === 'comment') throw new Error('comment post failed');
      return '';
    };
    const { exitCode, snapshot } = await runSuccessfulRecoveryTransition({ dir, ghRunner });
    // The label mutation itself is durable (queue event recorded, and the
    // attempt is proven applied) but a recovery is not "successful" until
    // the resolved GitHub attention marker is also durably delivered (#698
    // finding 4 re-review) — the comment failure must not be swallowed into
    // a reported success, and the attempt must not be marked fully resolved.
    assert.equal(exitCode, 1);
    assert.equal(editCount, 1);
    assert.equal(snapshot.attempts[0].resolution_state, 'attention_resolution_pending');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcilePendingRecoveryTransitions converges a crash-window transition without repeating the mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-transition-converge-'));
  try {
    const stateDbPath = join(dir, 'state.sqlite');
    const attemptId = 'crash-window-attempt';
    let store = openRunnerStateStore(stateDbPath);
    store.recordRecoveryAttempt({
      attemptId, repo: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 698, startedAt: '2026-07-17T18:00:00Z',
      claimId: '41', preflightRevision: '41', agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
      finishedAt: '2026-07-17T18:05:00Z', outcome: 'completed', recoveryEligible: false, recoveryAction: 'attention_required', claimedRecoveryAction: 'fresh_retry',
      recoveryAttemptCount: 1, attentionStatus: 'none', resolutionState: 'transition_pending',
    });
    store.close();
    const editCalls = [];
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'edit') { editCalls.push(args); return ''; }
      // The prior pass's mutation already landed; only local completion crashed.
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: 'status:in-progress' }], comments: [] });
      return '';
    };
    const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
    const result = await reconcilePendingRecoveryTransitions({
      state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner, now: () => '2026-07-17T19:00:00Z',
      dependencies: { revalidateRecovery: async ({ stage }) => ({ stage, allowed: true, failedChecks: [], evidence: SAFE_RECOVERY_REVALIDATION_EVIDENCE, authorizationId: '99', checkedAt: '2026-07-17T19:00:00Z' }) },
    });
    state.close();
    assert.equal(result.checked, 1);
    assert.equal(result.converged, 1);
    assert.equal(editCalls.length, 0, 'a transition already visible on GitHub must not be re-mutated');
    const verify = openRunnerStateStore(stateDbPath);
    assert.equal(verify.allRows('recovery_attempts')[0].resolution_state, 'resolved');
    assert.equal(verify.allRows('queue_events').some((row) => row.event_type === 'recovery-succeeded'), true);
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcilePendingRecoveryTransitions retries a never-applied mutation exactly once on the next pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-transition-retry-'));
  try {
    const stateDbPath = join(dir, 'state.sqlite');
    const attemptId = 'never-applied-attempt';
    let store = openRunnerStateStore(stateDbPath);
    store.recordRecoveryAttempt({
      attemptId, repo: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 698, startedAt: '2026-07-17T18:00:00Z',
      claimId: '41', preflightRevision: '41', agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
      finishedAt: '2026-07-17T18:05:00Z', outcome: 'completed', recoveryEligible: false, recoveryAction: 'attention_required', claimedRecoveryAction: 'fresh_retry',
      recoveryAttemptCount: 1, attentionStatus: 'none', resolutionState: 'transition_pending',
    });
    store.close();
    let labelApplied = false;
    const editCalls = [];
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'edit') { editCalls.push(args); labelApplied = true; return ''; }
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({ state: 'OPEN', labels: [{ name: labelApplied ? 'status:in-progress' : 'status:blocked' }], comments: [] });
      }
      return '';
    };
    const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
    const result = await reconcilePendingRecoveryTransitions({
      state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner, now: () => '2026-07-17T19:00:00Z',
      dependencies: { revalidateRecovery: async ({ stage }) => ({ stage, allowed: true, failedChecks: [], evidence: SAFE_RECOVERY_REVALIDATION_EVIDENCE, authorizationId: '99', checkedAt: '2026-07-17T19:00:00Z' }) },
    });
    state.close();
    assert.equal(editCalls.length, 1, 'a mutation that never happened must be retried exactly once');
    assert.equal(result.converged, 1);
    const verify = openRunnerStateStore(stateDbPath);
    assert.equal(verify.allRows('recovery_attempts')[0].resolution_state, 'resolved');
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Simulates a single store write failing (e.g. disk full, corruption) while
// the underlying SQLite connection otherwise still works, so the reconciler
// loop's own write-verification (not the store's) is what's under test
// (#698 finding 3).
function wrapStateWithFailingWrite(state, failingMethod) {
  return {
    get errors() { return state.errors; },
    get taskErrors() { return state.taskErrors; },
    get available() { return state.available; },
    get healthy() { return state.healthy; },
    recordTaskError: (...a) => state.recordTaskError(...a),
    record: (method, payload) => {
      if (method === failingMethod) {
        state.errors.push({ stage: method, message: 'simulated write failure' });
        return false;
      }
      return state.record(method, payload);
    },
    invoke: (method, ...values) => {
      if (method === failingMethod) {
        state.errors.push({ stage: method, message: 'simulated write failure' });
        return null;
      }
      return state.invoke(method, ...values);
    },
    ensureWritable: (...a) => state.ensureWritable(...a),
    close: (...a) => state.close(...a),
  };
}

test('reconcilePendingRecoveryTransitions stops the pass and mutates nothing when the revalidation-persistence write fails', async () => {
  const { dir, stateDbPath, attemptId } = reconcilerFixture();
  try {
    const editCalls = [];
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'edit') { editCalls.push(args); return ''; }
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 698, state: 'OPEN', labels: [{ name: 'status:blocked' }], comments: [] });
      return '';
    };
    const realState = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
    const state = wrapStateWithFailingWrite(realState, 'recordRecoveryRevalidation');
    const result = await reconcilePendingRecoveryTransitions({
      state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner, now: () => '2026-07-17T19:00:00Z',
      dependencies: { revalidateRecovery: async ({ stage }) => ({ stage, allowed: true, failedChecks: [], evidence: SAFE_RECOVERY_REVALIDATION_EVIDENCE, authorizationId: '99', checkedAt: '2026-07-17T19:00:00Z' }) },
    });
    realState.close();
    assert.equal(result.converged, 0, 'must not converge or mutate GitHub past an unverified revalidation write');
    assert.equal(editCalls.length, 0);
    assert.equal(result.skipped.some((entry) => entry.attemptId === attemptId && entry.reason === 'revalidation-persistence-failed'), true);
    const verify = openRunnerStateStore(stateDbPath);
    assert.equal(verify.allRows('recovery_attempts')[0].resolution_state, 'transition_pending', 'row must be untouched, not silently marked resolved or attention-required');
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcilePendingRecoveryTransitions never mutates GitHub when the bounded mutation-count increment write fails', async () => {
  const { dir, stateDbPath, attemptId } = reconcilerFixture();
  try {
    const editCalls = [];
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'edit') { editCalls.push(args); return ''; }
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 698, state: 'OPEN', labels: [{ name: 'status:blocked' }], comments: [] });
      return '';
    };
    const realState = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
    const state = wrapStateWithFailingWrite(realState, 'incrementTransitionMutationCount');
    const result = await reconcilePendingRecoveryTransitions({
      state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner, now: () => '2026-07-17T19:00:00Z',
      dependencies: { revalidateRecovery: async ({ stage }) => ({ stage, allowed: true, failedChecks: [], evidence: SAFE_RECOVERY_REVALIDATION_EVIDENCE, authorizationId: '99', checkedAt: '2026-07-17T19:00:00Z' }) },
    });
    realState.close();
    assert.equal(editCalls.length, 0, 'GitHub must never be mutated when the bounded-cap write itself could not be verified durable');
    assert.equal(result.converged, 0);
    assert.equal(result.skipped.some((entry) => entry.attemptId === attemptId && entry.reason === 'transition-mutation-count-persistence-failed'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcilePendingRecoveryTransitions converges using the real (non-mocked) revalidation collector', async () => {
  // Every other reconciler test above injects `dependencies.revalidateRecovery`
  // as a full test double. That masked a real bug: reusing `pre_claim`
  // semantics required `authorizationFresh` (authorization created *after*
  // the attempt's own finished_at), which can never be true for a completed
  // attempt reconciling its own authorization (the authorization necessarily
  // predates the attempt it permitted). This test deliberately does not mock
  // `revalidateRecovery`, exercising the real `collectRecoveryRevalidation`
  // end to end through the dedicated `transition_reconcile` stage (#698
  // finding 2) to prove convergence actually happens in production, not
  // only against a stubbed decision.
  const dir = mkdtempSync(join(tmpdir(), 'runner-transition-reconcile-real-'));
  try {
    const stateDbPath = join(dir, 'state.sqlite');
    const attemptId = 'attempt-transition-reconcile-real';
    const store = openRunnerStateStore(stateDbPath);
    store.recordRecoveryAttempt({
      attemptId, repo: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 698,
      startedAt: '2026-07-17T18:35:00Z', claimId: '41', preflightRevision: '41',
      agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
      finishedAt: '2026-07-17T18:40:00Z', outcome: 'completed', recoveryEligible: false,
      recoveryAction: 'attention_required', claimedRecoveryAction: 'fresh_retry',
      recoveryAttemptCount: 1, attentionStatus: 'none', resolutionState: 'transition_pending',
      processId: 321, processBootId: 'boot-a', processStartTicks: '10', systemdInvocationId: 'old',
    });
    store.close();
    const comments = [
      { ...canonicalPreflightComment(41, 'TEST.41', 'Original revision.'), createdAt: '2026-07-17T18:00:00Z' },
      { id: 99, createdAt: '2026-07-17T18:31:00Z', body: '## Manager recovery authorization\n- Attempt: attempt-transition-reconcile-real\n- Action: fresh_retry\n- Claim revision: 41\n- Preflight revision: 41\n- Agent: claude-code-cli\n- Model: claude-sonnet-4-5\n- Harness: claude\n- Policy approved: yes' },
    ];
    const editCalls = [];
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'edit') { editCalls.push(args); return ''; }
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({
          number: 698, state: 'OPEN',
          labels: [{ name: editCalls.length ? 'status:in-progress' : 'status:blocked' }, { name: 'agent:claude-code-cli' }],
          comments,
        });
      }
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
      return '';
    };
    const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
    const result = await reconcilePendingRecoveryTransitions({
      state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner,
      now: () => '2026-07-17T19:00:00Z',
      dependencies: {
        processProbe: async () => false,
        repositoryEvidence: { noConflictingBranch: true, noConflictingWorktree: true },
      },
    });
    state.close();
    assert.equal(result.checked, 1);
    assert.equal(result.converged, 1, `expected real revalidation to converge; skipped=${JSON.stringify(result.skipped)}`);
    assert.equal(editCalls.length, 1, 'still-blocked issue requires exactly one label mutation');
    const verify = openRunnerStateStore(stateDbPath);
    const row = verify.allRows('recovery_attempts')[0];
    assert.equal(row.resolution_state, 'resolved');
    const revalidations = verify.allRows('recovery_revalidations');
    assert.equal(revalidations[0].stage, 'transition_reconcile');
    assert.equal(revalidations[0].allowed, 1);
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function reconcilerFixture({ resolutionState = 'transition_pending', transitionMutationCount = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-transition-reconcile-'));
  const stateDbPath = join(dir, 'state.sqlite');
  const attemptId = `attempt-${resolutionState}-${transitionMutationCount}`;
  const store = openRunnerStateStore(stateDbPath);
  store.recordRecoveryAttempt({
    attemptId, repo: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 698, startedAt: '2026-07-17T18:00:00Z',
    claimId: '41', preflightRevision: '41', agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    finishedAt: '2026-07-17T18:05:00Z', outcome: 'completed', recoveryEligible: false, recoveryAction: 'attention_required', claimedRecoveryAction: 'fresh_retry',
    recoveryAttemptCount: 1, attentionStatus: 'none', resolutionState,
  });
  for (let i = 0; i < transitionMutationCount; i += 1) store.incrementTransitionMutationCount(attemptId);
  store.close();
  return { dir, stateDbPath, attemptId };
}

test('reconcilePendingRecoveryTransitions requires full authority revalidation before converging, even when GitHub already looks correct', async () => {
  const { dir, stateDbPath, attemptId } = reconcilerFixture();
  try {
    const editCalls = [];
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'edit') { editCalls.push(args); return ''; }
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 698, state: 'OPEN', labels: [{ name: 'status:in-progress' }], comments: [] });
      return '';
    };
    const ghCalls = [];
    const trackedGhRunner = (args) => { ghCalls.push(args); return ghRunner(args); };
    const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
    const result = await reconcilePendingRecoveryTransitions({
      state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner: trackedGhRunner, now: () => '2026-07-17T19:00:00Z',
      dependencies: { revalidateRecovery: async ({ stage }) => ({ stage, allowed: false, failedChecks: ['agentOwnershipCurrent'], evidence: { ...SAFE_RECOVERY_REVALIDATION_EVIDENCE, agentOwnershipCurrent: false }, authorizationId: '99', checkedAt: '2026-07-17T19:00:00Z' }) },
    });
    state.close();
    assert.equal(result.converged, 0);
    assert.equal(editCalls.length, 0, 'stale authority must block a mutation even when GitHub already shows in-progress');
    const verify = openRunnerStateStore(stateDbPath);
    const row = verify.allRows('recovery_attempts').find((entry) => entry.attempt_id === attemptId);
    assert.equal(row.resolution_state, 'operator_attention_required');
    assert.equal(verify.allRows('attention_events').some((event) => event.event_json.includes('agentOwnershipCurrent')), true);
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcilePendingRecoveryTransitions stops retrying once the bounded mutation cap is reached', async () => {
  const { dir, stateDbPath, attemptId } = reconcilerFixture({ transitionMutationCount: 2 });
  try {
    const editCalls = [];
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'edit') { editCalls.push(args); return ''; }
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: 'status:blocked' }], comments: [] });
      return '';
    };
    const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
    const result = await reconcilePendingRecoveryTransitions({
      state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner, now: () => '2026-07-17T19:00:00Z',
      dependencies: { revalidateRecovery: async ({ stage }) => ({ stage, allowed: true, failedChecks: [], evidence: SAFE_RECOVERY_REVALIDATION_EVIDENCE, authorizationId: '99', checkedAt: '2026-07-17T19:00:00Z' }) },
    });
    state.close();
    assert.equal(editCalls.length, 0, 'a bounded-exhausted row must never be mutated again automatically');
    assert.equal(result.converged, 0);
    const verify = openRunnerStateStore(stateDbPath);
    const row = verify.allRows('recovery_attempts').find((entry) => entry.attempt_id === attemptId);
    assert.equal(row.resolution_state, 'operator_attention_required');
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Builds a transition_pending row that already went through one failed
// mutation attempt (so `retry_attempt`/`retry_cap` are the real production
// shape), then directly overwrites its persisted retry schedule to exercise
// missing/malformed/expired/valid-future deadlines against the real
// reconciler and the liveness oracle together (#698 final-head fix:
// "production reconciler/restart tests ... assert the durable resulting
// state and slot disposition, not only the classifier return").
function reconcilerFixtureWithSchedule({ nextRetryAt, retryReason }) {
  const fixture = reconcilerFixture({ transitionMutationCount: 1 });
  const store = openRunnerStateStore(fixture.stateDbPath);
  store.db.prepare('UPDATE recovery_attempts SET next_retry_at = ?, retry_reason = ?, retry_attempt = 1, retry_cap = ? WHERE attempt_id = ?')
    .run(nextRetryAt, retryReason, MAX_TRANSITION_MUTATION_ATTEMPTS, fixture.attemptId);
  store.close();
  return fixture;
}

test('reconcilePendingRecoveryTransitions respects a genuinely valid future retry deadline, and the liveness oracle agrees this is delayed_bounded_retry (#698 final-head fix)', async () => {
  const { dir, stateDbPath, attemptId } = reconcilerFixtureWithSchedule({ nextRetryAt: '2099-01-01T00:00:00Z', retryReason: 'transition-mutation-retry' });
  try {
    const editCalls = [];
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'edit') { editCalls.push(args); return ''; }
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: 'status:blocked' }], comments: [] });
      return '';
    };
    const now = () => '2026-07-17T19:00:00Z';
    const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
    const result = await reconcilePendingRecoveryTransitions({
      state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner, now,
      dependencies: { revalidateRecovery: async ({ stage }) => ({ stage, allowed: true, failedChecks: [], evidence: SAFE_RECOVERY_REVALIDATION_EVIDENCE, authorizationId: '99', checkedAt: now() }) },
    });
    state.close();
    assert.equal(editCalls.length, 0, 'a genuinely future deadline must not be mutated early');
    assert.equal(result.converged, 0);
    assert.equal(result.skipped.some((entry) => entry.attemptId === attemptId && entry.reason === 'transition-retry-deadline-not-yet-reached'), true);
    const verify = openRunnerStateStore(stateDbPath);
    const row = verify.allRows('recovery_attempts').find((entry) => entry.attempt_id === attemptId);
    assert.equal(row.resolution_state, 'transition_pending', 'the row must remain in its waiting state, neither resolved nor demoted to attention');
    verify.close();
    const evidence = await computeAttemptLivenessEvidence(row, { now });
    assert.equal(evidence.retryDeadlineValid, true);
    assert.equal(classifyAttemptLivenessState(row, evidence), 'delayed_bounded_retry', 'the oracle must agree this durable row is a genuinely bounded, not attention-worthy, wait');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, schedule] of [
  ['missing', { nextRetryAt: null, retryReason: null }],
  ['malformed', { nextRetryAt: 'not-a-real-timestamp', retryReason: 'transition-mutation-retry' }],
  ['expired', { nextRetryAt: '2020-01-01T00:00:00Z', retryReason: 'transition-mutation-retry' }],
]) {
  test(`reconcilePendingRecoveryTransitions does not treat a ${label} retry deadline as a bounded wait — it retries immediately, and the oracle agrees the pre-retry row was task_local_attention (#698 final-head fix)`, async () => {
    const { dir, stateDbPath, attemptId } = reconcilerFixtureWithSchedule(schedule);
    try {
      const now = () => '2026-07-17T19:00:00Z';
      // Snapshot the durable pre-reconciliation row to prove the oracle
      // never reads it as a safely-delayed bounded retry, before the real
      // reconciler acts on it below.
      const preStore = openRunnerStateStore(stateDbPath);
      const preRow = preStore.allRows('recovery_attempts').find((entry) => entry.attempt_id === attemptId);
      preStore.close();
      const preEvidence = await computeAttemptLivenessEvidence(preRow, { now });
      assert.equal(preEvidence.retryDeadlineValid, false, `a ${label} deadline must not compute as valid`);
      assert.equal(classifyAttemptLivenessState(preRow, preEvidence), 'task_local_attention', `a ${label} deadline must never read as delayed_bounded_retry`);

      let labelApplied = false;
      const editCalls = [];
      const ghRunner = (args) => {
        if (args[0] === 'issue' && args[1] === 'edit') { editCalls.push(args); labelApplied = true; return ''; }
        if (args[0] === 'issue' && args[1] === 'view') {
          return JSON.stringify({ state: 'OPEN', labels: [{ name: labelApplied ? 'status:in-progress' : 'status:blocked' }], comments: [] });
        }
        return '';
      };
      const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
      const result = await reconcilePendingRecoveryTransitions({
        state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner, now,
        dependencies: { revalidateRecovery: async ({ stage }) => ({ stage, allowed: true, failedChecks: [], evidence: SAFE_RECOVERY_REVALIDATION_EVIDENCE, authorizationId: '99', checkedAt: now() }) },
      });
      state.close();
      assert.equal(editCalls.length, 1, `a ${label} deadline must not block the bounded retry the mutation-count cap still permits`);
      assert.equal(result.converged, 1);
      const verify = openRunnerStateStore(stateDbPath);
      const row = verify.allRows('recovery_attempts').find((entry) => entry.attempt_id === attemptId);
      assert.equal(row.resolution_state, 'resolved', 'the durable resulting state must be resolved, releasing the slot, not left in silent limbo');
      verify.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('reconcilePendingRecoveryTransitions never re-mutates an attention_resolution_pending row, even if GitHub now disagrees', async () => {
  const { dir, stateDbPath, attemptId } = reconcilerFixture({ resolutionState: 'attention_resolution_pending', transitionMutationCount: 1 });
  try {
    const editCalls = [];
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'edit') { editCalls.push(args); return ''; }
      // Ambiguous/disagreeing state: the label mutation is already durably
      // proven applied locally, but GitHub currently shows status:blocked.
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: 'status:blocked' }], comments: [] });
      return '';
    };
    const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
    const result = await reconcilePendingRecoveryTransitions({
      state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner, now: () => '2026-07-17T19:00:00Z',
      dependencies: { revalidateRecovery: async ({ stage }) => ({ stage, allowed: true, failedChecks: [], evidence: SAFE_RECOVERY_REVALIDATION_EVIDENCE, authorizationId: '99', checkedAt: '2026-07-17T19:00:00Z' }) },
    });
    state.close();
    assert.equal(editCalls.length, 0, 'a row already proven applied locally must never be mutated again');
    assert.equal(result.converged, 0);
    const verify = openRunnerStateStore(stateDbPath);
    const row = verify.allRows('recovery_attempts').find((entry) => entry.attempt_id === attemptId);
    assert.equal(row.resolution_state, 'operator_attention_required');
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcilePendingRecoveryTransitions retries only the resolved-comment delivery for an attention_resolution_pending row once GitHub confirms the label', async () => {
  const { dir, stateDbPath, attemptId } = reconcilerFixture({ resolutionState: 'attention_resolution_pending', transitionMutationCount: 1 });
  try {
    const editCalls = [];
    const commentCalls = [];
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'edit') { editCalls.push(args); return ''; }
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: 'status:in-progress' }], comments: [] });
      if (args[0] === 'issue' && args[1] === 'comment') { commentCalls.push(args); return ''; }
      return '';
    };
    const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
    const result = await reconcilePendingRecoveryTransitions({
      state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner, now: () => '2026-07-17T19:00:00Z',
      dependencies: { revalidateRecovery: async ({ stage }) => ({ stage, allowed: true, failedChecks: [], evidence: SAFE_RECOVERY_REVALIDATION_EVIDENCE, authorizationId: '99', checkedAt: '2026-07-17T19:00:00Z' }) },
    });
    state.close();
    assert.equal(editCalls.length, 0, 'the already-applied label must never be mutated again');
    assert.equal(result.converged, 1);
    const verify = openRunnerStateStore(stateDbPath);
    const row = verify.allRows('recovery_attempts').find((entry) => entry.attempt_id === attemptId);
    assert.equal(row.resolution_state, 'resolved');
    // The label mutation was already durably applied before this pass
    // (attention_resolution_pending) but the queue event was never
    // recorded, matching the exact crash window finding 4 closes: the
    // recovery-succeeded event is recorded exactly once, atomically with
    // the final `resolved` transition, never before delivery succeeds.
    assert.equal(verify.allRows('queue_events').filter((entry) => entry.event_type === 'recovery-succeeded').length, 1);
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completeSuccessfulRecoveryTransition never records a queue event on delivery failure and records exactly one across repeated reconciliation passes', async () => {
  const { dir, stateDbPath, attemptId } = reconcilerFixture({ resolutionState: 'attention_resolution_pending', transitionMutationCount: 1 });
  try {
    let failDelivery = true;
    const editCalls = [];
    const commentCalls = [];
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'edit') { editCalls.push(args); return ''; }
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: 'status:in-progress' }], comments: [] });
      if (args[0] === 'issue' && args[1] === 'comment') {
        commentCalls.push(args);
        if (failDelivery) throw new Error('simulated GitHub outage');
        return '';
      }
      return '';
    };
    const runPass = () => reconcilePendingRecoveryTransitions({
      state: createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' }),
      args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner, now: () => '2026-07-17T19:00:00Z',
      dependencies: { revalidateRecovery: async ({ stage }) => ({ stage, allowed: true, failedChecks: [], evidence: SAFE_RECOVERY_REVALIDATION_EVIDENCE, authorizationId: '99', checkedAt: '2026-07-17T19:00:00Z' }) },
    });

    let result = await runPass();
    assert.equal(result.converged, 0, 'a delivery failure must not count as convergence');
    let verify = openRunnerStateStore(stateDbPath);
    assert.equal(verify.allRows('recovery_attempts').find((e) => e.attempt_id === attemptId).resolution_state, 'attention_resolution_pending');
    assert.equal(verify.allRows('queue_events').filter((e) => e.event_type === 'recovery-succeeded').length, 0, 'no queue event before delivery succeeds');
    verify.close();

    // A second pass while delivery still fails must not record anything new either.
    result = await runPass();
    assert.equal(result.converged, 0);
    verify = openRunnerStateStore(stateDbPath);
    assert.equal(verify.allRows('queue_events').filter((e) => e.event_type === 'recovery-succeeded').length, 0);
    verify.close();

    failDelivery = false;
    result = await runPass();
    assert.equal(result.converged, 1);
    verify = openRunnerStateStore(stateDbPath);
    assert.equal(verify.allRows('recovery_attempts').find((e) => e.attempt_id === attemptId).resolution_state, 'resolved');
    assert.equal(verify.allRows('queue_events').filter((e) => e.event_type === 'recovery-succeeded').length, 1, 'exactly one queue event once delivery finally succeeds');
    verify.close();

    // A fourth pass over an already-resolved row must be a pure no-op: no
    // further mutation, comment, or duplicate queue event.
    result = await runPass();
    verify = openRunnerStateStore(stateDbPath);
    assert.equal(verify.allRows('queue_events').filter((e) => e.event_type === 'recovery-succeeded').length, 1, 'idempotent: no duplicate event on a later pass over a resolved row');
    verify.close();
    assert.equal(editCalls.length, 0, 'the already-applied label mutation must never be repeated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selected preflight-direct dry-run is persisted as a read-only scheduler inspection (#725)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-dry-run-inspection-'));
  const lockPath = join(dir, 'cron.lock');
  const stateDbPath = join(dir, 'state.sqlite');
  const comments = [{ ...canonicalPreflightComment(72501, 'TEST.725', 'Bounded dry-run regression.'), createdAt: '2026-07-19T16:30:00Z' }];
  const githubCalls = [];
  let childCalls = 0;
  const output = [];
  const ghRunner = (args) => {
    githubCalls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    if (args[0] === 'issue' && args[1] === 'list') {
      const labels = args.flatMap((value, index) => value === '--label' ? [args[index + 1]] : []);
      if (labels.includes('status:ready') && labels.includes('agent:claude-code-cli')) {
        return JSON.stringify([{
          number: 725,
          title: 'Dry-run scheduler inspection',
          body: 'Exercise the selected candidate path without execution.',
          updatedAt: '2026-07-19T16:30:00Z',
          labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }, { name: 'priority:P0' }],
        }]);
      }
      return JSON.stringify([]);
    }
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments });
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
  };
  const originalLog = console.log;
  try {
    console.log = (value) => output.push(String(value));
    const exitCode = await main([
      '--dry-run', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', lockPath, '--agent-labels', 'agent:claude-code-cli',
    ], { GH_TOKEN: 'test-token' }, {
      ghRunner,
      now: () => '2026-07-19T17:00:00.000Z',
      runChild: async ({ commandArgs }) => {
        childCalls += 1;
        assert.equal(commandArgs.includes('--execute'), false);
        return { status: 0, signal: null, stdout: '', stderr: '', error: null };
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(childCalls, 0, 'scheduler inspection must stop before child launch');
    assert.equal(githubCalls.some((args) => ['comment', 'edit'].includes(args[1]) || args.includes('item-edit')), false);
    const printed = JSON.parse(output.at(-1));
    assert.equal(printed.dryRun, true);
    assert.equal(printed.selectedIssue, 725);
    assert.equal(printed.selectionMode, 'preflight-direct');
    assert.equal(printed.sourcePreflightCommentId, 'github-comment:database:72501');
    assert.deepEqual(printed.sourcePreflightCommentIdentity, { version: 1, nodeId: null, databaseId: 72501 });
    assert.equal(printed.claim, null);
    assert.equal(printed.executionStatus, 'not_executed');
    assert.equal('terminalOutcome' in printed, false);
    assert.equal('recoveryDecision' in printed, false);
    assert.equal('attentionDedupeKey' in printed, false);

    const state = openRunnerStateStore(stateDbPath);
    try {
      assert.equal(state.countRows('issue_selections'), 1, 'ordinary selection audit remains');
      assert.equal(state.countRows('run_results'), 1);
      assert.equal(state.allRows('run_results')[0].mode, 'scheduler-dry-run');
      assert.equal(state.countRows('recovery_attempts'), 0);
      assert.equal(state.countRows('attention_events'), 0);
      assert.equal(state.countRows('claims'), 0);
      assert.equal(state.countRows('runner_health_conditions'), 0);
      assert.equal(state.allRows('queue_events').some((row) => ['quarantine', 'approval-wait', 'pause'].includes(row.event_type)), false);
    } finally {
      state.close();
    }
    assert.equal(existsSync(printed.logPath), true, 'ordinary scheduler JSON log remains');
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('captured #300 mixed GraphQL/REST preflight identity completes through the scheduler-child production path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-mixed-comment-identity-'));
  const lockPath = join(dir, 'cron.lock');
  const stateDbPath = join(dir, 'state.sqlite');
  const nodeId = 'IC_kwDOSAKVps8AAAABKwq7Lg';
  const databaseId = 5017090862;
  const comments = [{
    id: nodeId,
    databaseId,
    createdAt: '2026-07-19T19:00:00Z',
    body: canonicalPreflightBody('TEST.300', 'Captured #300 mixed-identity regression.'),
  }];
  const githubCalls = [];
  const ghRunner = (args) => {
    githubCalls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    if (args[0] === 'issue' && args[1] === 'list') {
      const labels = args.flatMap((value, index) => value === '--label' ? [args[index + 1]] : []);
      if (labels.includes('status:ready') && labels.includes('agent:claude-code-cli')) {
        return JSON.stringify([{
          number: 300,
          title: 'Captured mixed comment identity',
          body: 'Exercise the real scheduler/child revision comparison.',
          updatedAt: '2026-07-19T19:00:00Z',
          labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }, { name: 'priority:P0' }],
        }]);
      }
      return JSON.stringify([]);
    }
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments });
    if (args[0] === 'issue' && ['edit', 'comment'].includes(args[1])) return '';
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
  };
  const childPayload = JSON.stringify({
    logPath: 'child.json',
    executionPhase: 'implementation',
    costAdmission: { allowed: true },
    sourcePreflightCommentId: databaseId,
  });
  const originalLog = console.log;
  try {
    console.log = () => {};
    const exitCode = await main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', lockPath, '--agent-labels', 'agent:claude-code-cli',
    ], { GH_TOKEN: 'test-token' }, {
      ghRunner,
      now: () => '2026-07-19T19:02:00.000Z',
      runChild: async () => ({ status: 0, signal: null, stdout: childPayload, stderr: '', error: null }),
    });
    assert.equal(exitCode, 0);
    assert.equal(githubCalls.some((call) => call[0] === 'api' && call[2] === 'PATCH'), false);
    assert.equal(githubCalls.some((call) => call.join(' ').includes('agent-runner:attention:v1')), false);

    const state = openRunnerStateStore(stateDbPath);
    const attempt = state.allRows('recovery_attempts')[0];
    const claim = state.allRows('claims')[0];
    assert.equal(attempt.outcome, 'completed');
    assert.deepEqual(JSON.parse(attempt.preflight_identity_json), { version: 1, nodeId, databaseId });
    assert.deepEqual(JSON.parse(claim.source_preflight_comment_identity_json), { version: 1, nodeId, databaseId });
    assert.equal(state.countRows('attention_events'), 0);
    state.close();
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#686 regression: a conflicting workspace is detected before claim consumption, no marker/child/packet-consumption occurs, and the exact reason is reported (not unknown_failure, not a missing-Phase diagnosis)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-686-workspace-conflict-'));
  const lockPath = join(dir, 'cron.lock');
  const stateDbPath = join(dir, 'state.sqlite');
  const preflightComment = {
    id: 41,
    createdAt: '2026-07-23T09:00:00Z',
    user: { login: 'chatgpt-manager' },
    body: canonicalPreflightBody('TEST.686', 'Fix the workspace ownership bug.'),
  };
  const ghCalls = [];
  const ghRunner = (args) => {
    ghCalls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    if (args[0] === 'issue' && args[1] === 'list') {
      const labels = args.flatMap((value, index) => (value === '--label' ? [args[index + 1]] : []));
      if (labels.includes('status:ready') && labels.includes('agent:claude-code-cli')) {
        return JSON.stringify([{
          number: 686,
          title: 'Repair supervised canary workspace ownership',
          body: 'Fix the workspace ownership bug.',
          updatedAt: '2026-07-23T09:00:00Z',
          labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }],
        }]);
      }
      return JSON.stringify([]);
    }
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments: [preflightComment] });
    if (args[0] === 'issue' && ['edit', 'comment'].includes(args[1])) return '';
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
  };
  let runChildCalled = false;
  const ownershipEvidence = Object.freeze({ expectedBranch: 'worktree-agent-runner-686-abc', matchingAttempt: null });
  const originalLog = console.log;
  try {
    console.log = () => {};
    const exitCode = await main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', lockPath, '--agent-labels', 'agent:claude-code-cli',
    ], {
      GH_TOKEN: 'test-token',
      CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true',
      CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'chatgpt-manager',
    }, {
      ghRunner,
      now: () => '2026-07-23T09:05:00.000Z',
      inspectWorkspaceOwnership: async () => ({
        allowed: false,
        reason: 'implementation-worktree-branch-already-exists',
        safeActions: ['inspect-existing-worktree'],
        evidence: ownershipEvidence,
      }),
      runChild: async () => { runChildCalled = true; return { status: 0, signal: null, stdout: '{}', stderr: '', error: null }; },
    });

    // 1 & 4: no Claude process was started, and the run is reported as a
    // task-local (non-zero) failure rather than a systemic pause.
    assert.equal(runChildCalled, false, 'no worker/Claude process is ever spawned when workspace ownership fails pre-claim');
    assert.equal(exitCode, 1);

    // 2 & 3: no runner-start marker was posted (so the manager preflight was
    // never marked claimed), and the issue never transitioned to
    // status:in-progress -- it went straight from status:ready to
    // status:blocked.
    const commentCalls = ghCalls.filter((call) => call[0] === 'issue' && call[1] === 'comment');
    assert.equal(commentCalls.some((call) => call.join(' ').includes('Claude runner started')), false, 'no runner-start marker posted');
    const labelCall = ghCalls.find((call) => call[0] === 'issue' && call[1] === 'edit');
    assert.deepEqual(labelCall, ['issue', 'edit', '686', '--repo', 'TheTekTeam/modelspend', '--remove-label', 'status:ready', '--add-label', 'status:blocked']);

    // 5: the queue was released -- no active/unresolved recovery_attempts
    // row was ever committed for this attempt.
    const state = openRunnerStateStore(stateDbPath);
    const attempts = state.allRows('recovery_attempts');
    assert.equal(attempts.length, 0, 'no claim row was ever committed for the conflicted attempt');
    const claims = state.allRows('claims');
    assert.equal(claims.length, 0, 'claimIssueForExecution never ran');

    // 6: the exact structured workspace reason was persisted (never
    // collapsed to unknown_failure).
    const runResult = state.allRows('run_results')[0];
    assert.equal(runResult.mode, 'workspace-ownership-blocked');
    const payload = JSON.parse(runResult.payload_json);
    assert.equal(payload.terminalOutcome, 'implementation-worktree-branch-already-exists');
    assert.equal(payload.workspaceOwnership.reason, 'implementation-worktree-branch-already-exists');
    state.close();

    // 7 & 8: recovery reports that exact reason -- never unknown_failure,
    // never an invented "missing Phase: implementation" diagnosis. The
    // typed execution-authorization facts (phase/allowed) are stated
    // explicitly instead.
    const attentionComment = commentCalls.find((call) => call.join(' ').includes('agent-runner:attention'));
    assert.ok(attentionComment, 'an attention comment was posted');
    const body = attentionComment[attentionComment.indexOf('--body') + 1];
    assert.match(body, /implementation_worktree_branch_already_exists/);
    assert.equal(/unknown_failure/.test(body), false);
    assert.equal(/lacked\s+`?Phase:\s*implementation`?/i.test(body), false);
    assert.equal(/missing\s+Phase:\s*implementation/i.test(body), false);
    assert.match(body, /Execution phase: `implementation`/);
    assert.match(body, /Execution authorization allowed: `true`/);
    assert.match(body, /No worker process was started/);
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#686 regression: a fresh implementation dispatch that clears the pre-claim ownership check durably persists its exact worktree identity', async () => {
  // Spec section 5: the whole point of persisting worktreeIdentity on the
  // attempt row is so a *later* dispatch can attribute a conflict to this
  // exact attempt instead of falling back to issue-number-only inference.
  // That only works if the successful (allowed:true) path actually writes
  // the row -- the conflict-path test above only proves nothing is written
  // when ownership fails; it says nothing about the success path.
  const dir = mkdtempSync(join(tmpdir(), 'runner-686-identity-persisted-'));
  const lockPath = join(dir, 'cron.lock');
  const stateDbPath = join(dir, 'state.sqlite');
  const preflightComment = {
    id: 41,
    createdAt: '2026-07-23T09:00:00Z',
    user: { login: 'chatgpt-manager' },
    body: canonicalPreflightBody('TEST.686', 'Fix the workspace ownership bug.'),
  };
  const ghRunner = (args) => {
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    if (args[0] === 'issue' && args[1] === 'list') {
      const labels = args.flatMap((value, index) => (value === '--label' ? [args[index + 1]] : []));
      if (labels.includes('status:ready') && labels.includes('agent:claude-code-cli')) {
        return JSON.stringify([{
          number: 686,
          title: 'Repair supervised canary workspace ownership',
          body: 'Fix the workspace ownership bug.',
          updatedAt: '2026-07-23T09:00:00Z',
          labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }],
        }]);
      }
      return JSON.stringify([]);
    }
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments: [preflightComment] });
    if (args[0] === 'issue' && ['edit', 'comment'].includes(args[1])) return '';
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
  };
  let ownershipCalledWith = null;
  const originalLog = console.log;
  try {
    console.log = () => {};
    const exitCode = await main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', lockPath, '--agent-labels', 'agent:claude-code-cli',
    ], {
      GH_TOKEN: 'test-token',
      CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true',
      CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'chatgpt-manager',
    }, {
      ghRunner,
      now: () => '2026-07-23T09:05:00.000Z',
      inspectWorkspaceOwnership: async ({ worktreeIdentity }) => {
        ownershipCalledWith = worktreeIdentity;
        return { allowed: true, action: 'create', ownership: 'new', worktreePath: '/repo/.claude/worktrees/agent-runner-686-x', branchName: worktreeIdentity.expectedBranch };
      },
      runChild: async () => ({
        status: 0, signal: null, stdout: JSON.stringify({ logPath: 'child.json', executionPhase: 'implementation', costAdmission: { allowed: true }, sourcePreflightCommentId: 41 }), stderr: '', error: null,
      }),
    });
    assert.equal(exitCode, 0);
    assert.ok(ownershipCalledWith, 'the real dispatch identity was passed into the ownership check');

    const state = openRunnerStateStore(stateDbPath);
    const attempt = state.allRows('recovery_attempts')[0];
    assert.ok(attempt, 'a recovery_attempts row was committed for the cleared dispatch');
    assert.ok(attempt.worktree_identity_json, 'the attempt row durably persisted its worktree identity');
    assert.deepEqual(JSON.parse(attempt.worktree_identity_json), ownershipCalledWith);
    state.close();
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#686 concurrency: a second scheduler invocation cannot dispatch while another already holds the singleton lock', async () => {
  // Section 4: the pre-claim workspace-ownership inspection this PR adds
  // creates a time gap between "inspected as available" and the child
  // actually creating the worktree. Two concurrent `main()` invocations
  // could only both walk through that gap if they could both run at all at
  // the same time. They cannot: acquireLock() opens the lock file with the
  // exclusive 'wx' flag and is called before anything else in main() --
  // before selection, before the ownership check, before the state store is
  // even opened -- and is only released in main()'s top-level `finally`,
  // after the child has already completed. A second invocation that finds
  // the lock file already present (simulating a second concurrent scheduler
  // process) must fail closed immediately, touching neither GitHub nor the
  // state store, rather than proceeding to race the first.
  const dir = mkdtempSync(join(tmpdir(), 'runner-686-concurrent-lock-'));
  const lockPath = join(dir, 'cron.lock');
  const stateDbPath = join(dir, 'state.sqlite');
  writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`);
  let ghCalled = false;
  const originalLog = console.log;
  try {
    console.log = () => {};
    await assert.rejects(
      main([
        '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
        '--state-db', stateDbPath, '--lock-path', lockPath,
      ], { GH_TOKEN: 'test-token' }, {
        ghRunner: () => { ghCalled = true; throw new Error('must not be called: lock was already held'); },
      }),
      /EEXIST/,
    );
    assert.equal(ghCalled, false, 'a locked-out invocation must never reach GitHub selection/dispatch');
    assert.equal(existsSync(stateDbPath), false, 'a locked-out invocation must never even open the state store');
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#686 regression: quarantining one issue for a workspace-ownership conflict does not stop the next pass from selecting a different runnable issue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-686-queue-continues-'));
  const lockPath = join(dir, 'cron.lock');
  const stateDbPath = join(dir, 'state.sqlite');
  const preflightBody = canonicalPreflightBody('TEST.SCOPED', 'Scoped work.');
  let issue686Status = 'status:ready';
  const issues = () => [
    { number: 686, title: 'Conflicted issue', body: 'x', updatedAt: '2026-07-23T09:00:00Z', statusName: issue686Status },
    { number: 690, title: 'Unrelated runnable issue', body: 'x', updatedAt: '2026-07-23T09:00:00Z', statusName: 'status:ready' },
  ];
  const ghRunner = (args) => {
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--add-label')) {
      const target = Number(args[2]);
      if (target === 686) issue686Status = args[args.indexOf('--add-label') + 1];
      return '';
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      const labels = args.flatMap((value, index) => (value === '--label' ? [args[index + 1]] : []));
      if (labels.includes('status:ready') && labels.includes('agent:claude-code-cli')) {
        return JSON.stringify(issues()
          .filter((issue) => issue.statusName === 'status:ready')
          .map((issue) => ({ number: issue.number, title: issue.title, body: issue.body, updatedAt: issue.updatedAt, labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }] })));
      }
      return JSON.stringify([]);
    }
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments: [{ id: 41, createdAt: '2026-07-23T09:00:00Z', user: { login: 'chatgpt-manager' }, body: preflightBody }] });
    if (args[0] === 'issue' && args[1] === 'comment') return '';
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
  };
  const env = { GH_TOKEN: 'test-token', CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true', CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'chatgpt-manager' };
  const originalLog = console.log;
  try {
    console.log = () => {};
    const commonArgs = ['--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir, '--state-db', stateDbPath, '--lock-path', lockPath, '--agent-labels', 'agent:claude-code-cli'];

    // First pass: issue 686 sorts first (lower number, same recency) and
    // hits the workspace-ownership conflict; it gets quarantined.
    const firstExit = await main(commonArgs, env, {
      ghRunner, now: () => '2026-07-23T09:05:00.000Z',
      inspectWorkspaceOwnership: async () => ({ allowed: false, reason: 'implementation-worktree-branch-already-exists', safeActions: [], evidence: {} }),
      runChild: async () => { throw new Error('must not spawn a worker for the conflicted issue'); },
    });
    assert.equal(firstExit, 1);
    assert.equal(issue686Status, 'status:blocked');

    // Second pass: 686 is now status:blocked and drops out of candidate
    // scanning; the scheduler reaches issue 690 normally, proving the
    // failure stayed task-local to 686 and never blocked the queue.
    let selectedIssue = null;
    const secondExit = await main(commonArgs, env, {
      ghRunner, now: () => '2026-07-23T09:06:00.000Z',
      // Issue 690 has no workspace conflict -- the same boundary runs for
      // it too (it is not 686-specific), but reports allowed:true.
      inspectWorkspaceOwnership: async () => ({ allowed: true, action: 'create', ownership: 'new', worktreePath: '/tmp/wt-690', branchName: 'worktree-agent-runner-690-x' }),
      runChild: async (input) => {
        selectedIssue = Number(input.commandArgs[input.commandArgs.indexOf('--issue') + 1]);
        return { status: 0, signal: null, stdout: JSON.stringify({ logPath: 'child.json', executionPhase: 'implementation', costAdmission: { allowed: true }, sourcePreflightCommentId: 41 }), stderr: '', error: null };
      },
    });
    assert.equal(selectedIssue, 690, 'the scheduler moved on to the next eligible issue instead of getting stuck retrying 686');
    assert.equal(secondExit, 0);
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#686 regression: the workspace-ownership pre-claim boundary applies identically to legacy proceed-command dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-686-proceed-command-'));
  const lockPath = join(dir, 'cron.lock');
  const stateDbPath = join(dir, 'state.sqlite');
  const comments = [
    { ...canonicalPreflightComment(41, 'TEST.41', 'Original scope.'), createdAt: '2026-07-23T09:00:00Z' },
    { id: 42, createdAt: '2026-07-23T09:01:00Z', user: { login: 'chatgpt-manager' }, body: '## Claude proceed command\nGo.' },
  ];
  const ghRunner = (args) => {
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    if (args[0] === 'issue' && args[1] === 'list') {
      const labels = args.flatMap((value, index) => (value === '--label' ? [args[index + 1]] : []));
      if (labels.includes('status:ready') && labels.includes('agent:claude-code-cli')) {
        return JSON.stringify([{
          number: 687, title: 'Proceed-command dispatch', body: 'x', updatedAt: '2026-07-23T09:01:00Z',
          labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }],
        }]);
      }
      return JSON.stringify([]);
    }
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments });
    if (args[0] === 'issue' && ['edit', 'comment'].includes(args[1])) return '';
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
  };
  let runChildCalled = false;
  let ownershipCallCount = 0;
  const originalLog = console.log;
  try {
    console.log = () => {};
    const exitCode = await main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', lockPath, '--agent-labels', 'agent:claude-code-cli',
    ], {
      GH_TOKEN: 'test-token',
      CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true',
      CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'chatgpt-manager',
    }, {
      ghRunner,
      now: () => '2026-07-23T09:05:00.000Z',
      inspectWorkspaceOwnership: async () => {
        ownershipCallCount += 1;
        return { allowed: false, reason: 'workspace-owned-by-unresolved-attempt', safeActions: [], evidence: {} };
      },
      runChild: async () => { runChildCalled = true; return { status: 0, signal: null, stdout: '{}', stderr: '', error: null }; },
    });
    assert.equal(ownershipCallCount, 1, 'the same workspace-ownership boundary runs for proceed-command dispatch too');
    assert.equal(runChildCalled, false);
    assert.equal(exitCode, 1);
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quarantineIssueBeforeClaim moves a status:ready issue straight to status:blocked without ever claiming it, and preserves errors instead of throwing', () => {
  const ghCalls = [];
  const ghRunner = (args) => { ghCalls.push(args); return ''; };
  const result = quarantineIssueBeforeClaim(
    { repo: 'TheTekTeam/modelspend' },
    { number: 686, statusLabel: 'status:ready' },
    { reason: 'implementation-worktree-branch-already-exists', workerStarted: false, executionPhase: 'implementation', executionAuthorizationAllowed: true },
    ghRunner,
  );
  assert.equal(result.statusUpdated, true);
  assert.equal(result.markerPosted, false);
  assert.equal(result.packetConsumed, false);
  assert.equal(result.claimCommitted, false);
  assert.equal(result.queueReleased, true);
  assert.deepEqual(ghCalls[0], ['issue', 'edit', '686', '--repo', 'TheTekTeam/modelspend', '--remove-label', 'status:ready', '--add-label', 'status:blocked']);
});

test('#686 regression fixture: when the pre-claim gate passes but the child itself hits the exact proven workspacePreparation failure, the terminal outcome and comment stay accurate (backstop path)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-686-backstop-'));
  const lockPath = join(dir, 'cron.lock');
  const stateDbPath = join(dir, 'state.sqlite');
  const preflightComment = { ...canonicalPreflightComment(41, 'TEST.41', 'Fix the workspace ownership bug.'), createdAt: '2026-07-23T09:00:00Z' };
  const ghCalls = [];
  const ghRunner = (args) => {
    ghCalls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    if (args[0] === 'issue' && args[1] === 'list') {
      const labels = args.flatMap((value, index) => (value === '--label' ? [args[index + 1]] : []));
      if (labels.includes('status:ready') && labels.includes('agent:claude-code-cli')) {
        return JSON.stringify([{
          number: 686, title: 'Repair supervised canary workspace ownership', body: 'x', updatedAt: '2026-07-23T09:00:00Z',
          labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }],
        }]);
      }
      return JSON.stringify([]);
    }
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments: [preflightComment] });
    if (args[0] === 'issue' && ['edit', 'comment'].includes(args[1])) return '';
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
  };
  // The exact #686 regression fixture (spec section 9): the child ran,
  // authorized implementation, but workspace preparation failed before
  // Claude started -- and reported the exact structured evidence, matching
  // the real production child.
  const childPayload = {
    logPath: 'child.json',
    blocked: true,
    reason: 'implementation-worktree-branch-already-exists',
    failureReason: 'implementation-worktree-branch-already-exists',
    message: 'The runner could not prove exclusive, current worktree ownership. No Claude process was started.',
    selectionMode: 'preflight-direct',
    executionPhase: 'implementation',
    executionAuthorization: { allowed: true, phase: 'implementation', violations: [] },
    workspacePreparation: { allowed: false, failureReason: 'implementation-worktree-branch-already-exists', baseRef: 'origin/main', baseHead: 'deadbeef' },
    workerStarted: false,
    costAdmission: { allowed: true },
    sourcePreflightCommentId: 41,
  };
  const originalLog = console.log;
  try {
    console.log = () => {};
    const exitCode = await main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', lockPath, '--agent-labels', 'agent:claude-code-cli',
    ], {
      GH_TOKEN: 'test-token', CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true', CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'chatgpt-manager',
    }, {
      ghRunner,
      now: () => '2026-07-23T09:05:00.000Z',
      // The scheduler's own pre-claim check passed (simulating the race the
      // child backstop exists for) -- the claim WAS committed, the marker
      // WAS posted, and the child actually ran.
      inspectWorkspaceOwnership: async () => ({ allowed: true, action: 'create', ownership: 'new', worktreePath: '/tmp/wt-686', branchName: 'worktree-agent-runner-686-abc' }),
      runChild: async () => ({ status: 4, signal: null, stdout: JSON.stringify(childPayload), stderr: '', error: null }),
    });
    assert.notEqual(exitCode, 0);

    const state = openRunnerStateStore(stateDbPath);
    const attempt = state.allRows('recovery_attempts')[0];
    // The literal #686 root cause: this must never read 'unknown_failure'.
    assert.equal(attempt.outcome, 'implementation_worktree_branch_already_exists');
    state.close();

    const commentCalls = ghCalls.filter((call) => call[0] === 'issue' && call[1] === 'comment');
    const attentionComment = commentCalls.find((call) => call.join(' ').includes('agent-runner:attention'));
    assert.ok(attentionComment, 'an attention comment was posted');
    const body = attentionComment[attentionComment.indexOf('--body') + 1];
    assert.match(body, /implementation_worktree_branch_already_exists/);
    assert.equal(/unknown_failure/.test(body), false);
    assert.equal(/lacked\s+`?Phase:\s*implementation`?/i.test(body), false);
    assert.equal(/missing\s+Phase:\s*implementation/i.test(body), false);
    // Threaded from the child's own structured executionPhase/
    // executionAuthorization evidence (section 6/8), not reparsed from the
    // raw preflight comment.
    assert.match(body, /Execution phase: `implementation`/);
    assert.match(body, /Execution authorization allowed: `true`/);
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh (initial) attempt with an authoritative preflight fails closed when the child omits sourcePreflightCommentId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-preflight-evidence-initial-'));
  const lockPath = join(dir, 'cron.lock');
  const stateDbPath = join(dir, 'state.sqlite');
  const comments = [{ ...canonicalPreflightComment(7, 'TEST.7', 'Bounded task.'), createdAt: '2026-07-17T19:00:00Z' }];
  const ghRunner = (args) => {
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    if (args[0] === 'issue' && args[1] === 'list') {
      const labels = args.flatMap((value, index) => value === '--label' ? [args[index + 1]] : []);
      if (labels.includes('status:ready') && labels.includes('agent:claude-code-cli')) {
        return JSON.stringify([{ number: 698, title: 'Missing evidence task', body: 'x', updatedAt: '2026-07-17T19:00:00Z', labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }, { name: 'priority:P0' }] }]);
      }
      return JSON.stringify([]);
    }
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments });
    if (args[0] === 'issue' && args[1] === 'comment') return '';
    if (args[0] === 'issue' && args[1] === 'edit') return '';
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
  };
  // Child completes successfully (exit 0) but its JSON result never
  // includes sourcePreflightCommentId — evidence that it read the current
  // authoritative preflight is entirely absent, not merely disagreeing.
  const childPayload = JSON.stringify({ logPath: 'child.json', executionPhase: 'implementation', costAdmission: { allowed: true } });
  const originalLog = console.log;
  try {
    console.log = () => {};
    const exitCode = await main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', lockPath, '--agent-labels', 'agent:claude-code-cli',
    ], { GH_TOKEN: 'test-token' }, {
      ghRunner,
      runChild: async () => ({ status: 0, signal: null, stdout: childPayload, stderr: '', error: null }),
    });
    assert.equal(exitCode, 1, 'missing preflight revision evidence on a completed run must fail closed');
    const state = openRunnerStateStore(stateDbPath);
    const attempt = state.allRows('recovery_attempts')[0];
    assert.equal(attempt.outcome, 'unknown_failure');
    state.close();
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a recovery attempt with an authoritative preflight fails closed when the child omits sourcePreflightCommentId', async () => {
  const result = await runRecoveryRevalidationScenario({
    childResult: { status: 0, signal: null, stdout: JSON.stringify({ logPath: 'child.json', executionPhase: 'implementation', costAdmission: { allowed: true } }), stderr: '', error: null },
  });
  assert.equal(result.childCalls, 1);
  assert.equal(result.exitCode, 1, 'a recovery result missing preflight revision evidence must not be accepted as a completed transition');
  assert.equal(result.snapshot.attempts[0].outcome, 'unknown_failure');
  assert.notEqual(result.snapshot.attempts[0].resolution_state, 'resolved');
});

test('preflightAlreadyClaimed detects a runner-started marker referencing the preflight comment', () => {
  const preflight = { id: 12, createdAt: '2026-07-08T09:00:00Z' };
  const unclaimed = [{ id: 13, createdAt: '2026-07-08T09:01:00Z', body: 'unrelated comment' }];
  assert.equal(preflightAlreadyClaimed(unclaimed, preflight), false);

  const claimed = [{ id: 14, createdAt: '2026-07-08T09:02:00Z', body: '## Claude runner started\n\n- Selection mode: preflight-direct\n- Source preflight comment: 12' }];
  assert.equal(preflightAlreadyClaimed(claimed, preflight), true);
});

test('latestRunnerStartedComment returns the newest runner-started marker', () => {
  const comments = [
    { id: 10, createdAt: '2026-07-09T09:00:00Z', body: '## Claude runner started\n\n- Old marker' },
    { id: 11, createdAt: '2026-07-09T09:05:00Z', body: 'ordinary comment' },
    { id: 12, createdAt: '2026-07-09T09:10:00Z', body: '## Claude runner started\n\n- New marker' },
  ];

  assert.equal(latestRunnerStartedComment(comments).id, 12);
});

test('activeRunBlockForIssue blocks a runner-started in-progress issue without a continue command (no durable state supplied)', async () => {
  const issue = { number: 777, statusLabel: 'status:in-progress' };
  const comments = [
    { id: 88, createdAt: '2026-07-09T09:00:00Z', body: '## Claude runner started\n\n- Selection mode: preflight-direct' },
  ];

  // Without state/repo, the function fails closed exactly as before: the
  // marker alone still reserves the issue.
  const block = await activeRunBlockForIssue(issue, comments, 'missing continue command');

  assert.equal(block.issue, 777);
  assert.equal(block.reason, 'active-runner-started-issue');
  assert.equal(block.runnerStartedCommentId, 'github-comment:database:88');
});

test('activeRunBlockForIssue does not block a manually in-progress issue without runner marker', async () => {
  const issue = { number: 778, statusLabel: 'status:in-progress' };
  const comments = [{ id: 99, createdAt: '2026-07-09T09:00:00Z', body: 'Manual status update.' }];

  assert.equal(await activeRunBlockForIssue(issue, comments, 'missing continue command'), null);
});

test('activeRunBlockForIssue accepts a marker backed by a live, durably-verified attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-marker-live-'));
  try {
    const stateDbPath = join(dir, 'state.sqlite');
    const store = openRunnerStateStore(stateDbPath);
    store.recordRecoveryAttempt({
      attemptId: 'live-marker-attempt', repo: 'TheTekTeam/modelspend', issueNumber: 779, claimId: '55',
      startedAt: '2026-07-09T09:00:00Z', processId: 4242, processBootId: 'boot-live', processStartTicks: '77', resolutionState: 'active',
    });
    store.close();
    const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
    const issue = { number: 779, statusLabel: 'status:in-progress' };
    const comments = [
      // The actual claim-establishing comment the marker's "Source command
      // comment: 55" field refers to — required for the timeline resolver
      // to recognize claim revision 55 as *current* authority (#698
      // finding 7), not merely a revision referenced by id somewhere.
      { id: 55, createdAt: '2026-07-09T08:55:00Z', body: '## Claude proceed command\n\nProceed.' },
      { id: 88, createdAt: '2026-07-09T09:00:00Z', body: '## Claude runner started\n\n- Source command comment: 55' },
    ];
    const block = await activeRunBlockForIssue(issue, comments, 'missing continue command', {
      state, repo: 'TheTekTeam/modelspend', processProbe: async () => true,
    });
    state.close();
    assert.equal(block.reason, 'active-runner-started-issue');
    assert.equal(block.attemptId, 'live-marker-attempt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('activeRunBlockForIssue treats a live match under a superseded claim revision as orphaned, not current authority (#698 finding 7)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-marker-superseded-'));
  try {
    const stateDbPath = join(dir, 'state.sqlite');
    const store = openRunnerStateStore(stateDbPath);
    store.recordRecoveryAttempt({
      attemptId: 'stale-authority-attempt', repo: 'TheTekTeam/modelspend', issueNumber: 782, claimId: '55',
      startedAt: '2026-07-09T09:00:00Z', processId: 4343, processBootId: 'boot-stale', processStartTicks: '99', resolutionState: 'active',
    });
    store.close();
    const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
    const issue = { number: 782, statusLabel: 'status:in-progress' };
    const comments = [
      { id: 55, createdAt: '2026-07-09T08:55:00Z', body: '## Claude proceed command\n\nProceed.' },
      { id: 88, createdAt: '2026-07-09T09:00:00Z', body: '## Claude runner started\n\n- Source command comment: 55' },
      // A newer command comment posted after the marker supersedes claim
      // revision 55 as current authority, even though a live process still
      // matches it (e.g. the operator re-issued a command without the
      // stale process ever being cleaned up).
      { id: 56, createdAt: '2026-07-09T09:30:00Z', body: '## Claude proceed command\n\nProceed again.' },
    ];
    const block = await activeRunBlockForIssue(issue, comments, 'missing continue command', {
      state, repo: 'TheTekTeam/modelspend', processProbe: async () => true,
    });
    state.close();
    assert.equal(block.reason, 'orphaned-runner-started-marker');
    const verify = openRunnerStateStore(stateDbPath);
    const events = verify.allRows('attention_events');
    assert.equal(events.length, 1);
    assert.match(events[0].next_action, /no longer current manager authority/);
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('activeRunBlockForIssue classifies a marker with no matching live attempt as orphaned, persists attention, and does not reserve the issue as before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-marker-orphan-'));
  try {
    const stateDbPath = join(dir, 'state.sqlite');
    // No attempt row at all: the marker exists purely as a stale GitHub
    // comment (e.g. from a crash before any durable row was even written).
    const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
    const issue = { number: 780, statusLabel: 'status:in-progress' };
    const comments = [{ id: 89, createdAt: '2026-07-09T09:00:00Z', body: '## Claude runner started\n\n- Source command comment: 60' }];
    const block = await activeRunBlockForIssue(issue, comments, 'missing continue command', {
      state, repo: 'TheTekTeam/modelspend', processProbe: async () => true,
    });
    state.close();
    assert.equal(block.reason, 'orphaned-runner-started-marker');
    assert.equal(block.orphaned, true);
    const verify = openRunnerStateStore(stateDbPath);
    const events = verify.allRows('attention_events');
    assert.equal(events.length, 1);
    assert.equal(events[0].recovery_status, 'orphaned');
    assert.equal(events[0].issue_number, 780);
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('activeRunBlockForIssue classifies a marker whose matching row has a dead process as orphaned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-marker-dead-'));
  try {
    const stateDbPath = join(dir, 'state.sqlite');
    const store = openRunnerStateStore(stateDbPath);
    store.recordRecoveryAttempt({
      attemptId: 'dead-marker-attempt', repo: 'TheTekTeam/modelspend', issueNumber: 781, claimId: '61',
      startedAt: '2026-07-09T09:00:00Z', processId: 5252, processBootId: 'boot-dead', processStartTicks: '88', resolutionState: 'active',
    });
    store.close();
    const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
    const issue = { number: 781, statusLabel: 'status:in-progress' };
    const comments = [{ id: 90, createdAt: '2026-07-09T09:00:00Z', body: '## Claude runner started\n\n- Source command comment: 61' }];
    const block = await activeRunBlockForIssue(issue, comments, 'missing continue command', {
      state, repo: 'TheTekTeam/modelspend', processProbe: async () => false,
    });
    state.close();
    assert.equal(block.reason, 'orphaned-runner-started-marker');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveManagerTimelineAuthority orders mixed comment types and resolves current claim/authorization state (#698 finding 7)', () => {
  const comments = [
    { id: 1, createdAt: '2026-07-01T09:00:00Z', body: '## Manager preflight packet\nOriginal.' },
    { id: 2, createdAt: '2026-07-01T09:05:00Z', body: '## Manager recovery authorization\n- Attempt: a\n- Action: fresh_retry\n- Claim revision: 1\n- Preflight revision: 1\n- Agent: claude-code-cli\n- Model: claude-sonnet-4-5\n- Harness: claude\n- Policy approved: yes' },
    { id: 3, createdAt: '2026-07-01T09:10:00Z', body: '## Claude runner started\n\n- Source preflight comment: 1' },
  ];
  const authority = resolveManagerTimelineAuthority(comments);
  assert.deepEqual(authority.timeline.map((event) => event.type), ['preflight', 'authorization', 'runner-start']);
  assert.equal(authority.currentClaimRevision, 'github-comment:database:1');
  assert.equal(authority.currentClaimType, 'preflight');
  assert.equal(authority.currentAuthorizationId, 'github-comment:database:2');
  assert.equal(authority.revoked, false);
  assert.equal(authority.handoffPending, false);
});

test('resolveManagerTimelineAuthority: a later command supersedes an earlier preflight as current claim revision', () => {
  const comments = [
    { id: 1, createdAt: '2026-07-01T09:00:00Z', body: '## Manager preflight packet\nOriginal.' },
    { id: 2, createdAt: '2026-07-01T10:00:00Z', body: '## Claude proceed command\n\nGo.' },
  ];
  const authority = resolveManagerTimelineAuthority(comments);
  assert.equal(authority.currentClaimRevision, 'github-comment:database:2');
  assert.equal(authority.currentClaimType, 'command');
});

test('resolveManagerTimelineAuthority: a revocation invalidates authority until a fresh claim comment appears', () => {
  const comments = [
    { id: 1, createdAt: '2026-07-01T09:00:00Z', body: '## Manager preflight packet\nOriginal.' },
    { id: 2, createdAt: '2026-07-01T09:30:00Z', body: '## Manager preflight packet — revoked\nDo not dispatch.' },
  ];
  assert.equal(resolveManagerTimelineAuthority(comments).revoked, true);
  assert.equal(claimRevisionIsCurrent(comments, '1'), false);

  const refreshed = [...comments, { id: 3, createdAt: '2026-07-01T10:00:00Z', body: '## Manager preflight packet\nRefreshed.' }];
  const authority = resolveManagerTimelineAuthority(refreshed);
  assert.equal(authority.revoked, false);
  assert.equal(authority.currentClaimRevision, 'github-comment:database:3');
});

test('resolveManagerTimelineAuthority: a handoff clears current authorization until a fresh one or a runner-start clears it', () => {
  const comments = [
    { id: 1, createdAt: '2026-07-01T09:00:00Z', body: '## Manager preflight packet\nOriginal.' },
    { id: 2, createdAt: '2026-07-01T09:05:00Z', body: '## Manager recovery authorization\n- Attempt: a\n- Action: fresh_retry\n- Claim revision: 1\n- Preflight revision: 1\n- Agent: claude-code-cli\n- Model: claude-sonnet-4-5\n- Harness: claude\n- Policy approved: yes' },
    { id: 3, createdAt: '2026-07-01T09:30:00Z', body: '## Manager handoff\n\nHanding off to a different operator.' },
  ];
  assert.equal(resolveManagerTimelineAuthority(comments).currentAuthorizationId, null);
  assert.equal(resolveManagerTimelineAuthority(comments).handoffPending, true);

  const withRunnerStart = [...comments, { id: 4, createdAt: '2026-07-01T10:00:00Z', body: '## Claude runner started\n\n- Source preflight comment: 1' }];
  assert.equal(resolveManagerTimelineAuthority(withRunnerStart).handoffPending, false);
});

test('claimRevisionIsCurrent is false for a null/missing revision and for an issue with no timeline events', () => {
  assert.equal(claimRevisionIsCurrent([], '1'), false);
  assert.equal(claimRevisionIsCurrent([{ id: 1, createdAt: '2026-07-01T09:00:00Z', body: '## Manager preflight packet\nOriginal.' }], null), false);
});

// Every fact required for the two permissive buckets, all proven true —
// the only evidence bundle that may legitimately produce `actively_owned`
// or `delayed_bounded_retry` (#698 round 4, finding 1).
const FULL_LIVENESS_EVIDENCE = Object.freeze({
  liveProcess: true, leaseCurrent: true, authorityCurrent: true, progressWithinStallWindow: true,
  retryDeadlineValid: true, boundedRetryPolicyProven: true,
});

test('classifyAttemptLivenessState maps every real resolution_state to exactly one governing-invariant bucket, never ambiguous', () => {
  assert.equal(classifyAttemptLivenessState(null), null);
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'active' }, FULL_LIVENESS_EVIDENCE), 'actively_owned');
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'resolved' }), 'resolved');
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'operator_attention_required' }), 'operator_held');
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'transition_uncertain' }, FULL_LIVENESS_EVIDENCE), 'delayed_bounded_retry');
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'attention_resolution_pending' }, FULL_LIVENESS_EVIDENCE), 'delayed_bounded_retry');
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'transition_pending' }, FULL_LIVENESS_EVIDENCE), 'delayed_bounded_retry');
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'unresolved', recovery_eligible: 1 }, FULL_LIVENESS_EVIDENCE), 'delayed_bounded_retry');
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'unresolved', recovery_eligible: 0 }, FULL_LIVENESS_EVIDENCE), 'task_local_attention');
  // Any value not in the enumerated set is the invariant violation itself —
  // a future resolution_state added without updating this classifier must
  // surface as a loud, explicit failure, not silently pass as some other
  // bucket.
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'some_future_state_nobody_classified' }, FULL_LIVENESS_EVIDENCE), 'ambiguous');
  assert.equal(classifyAttemptLivenessState({ resolution_state: null }), 'ambiguous');
});

test('classifyAttemptLivenessState demotes active/bounded-retry states to task_local_attention on missing, stale, or contradictory evidence (#698 round 4, finding 1)', () => {
  // No evidence supplied at all — the historical round-3 shape — must never
  // silently resolve to a permissive bucket.
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'active' }), 'task_local_attention');
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'transition_pending' }), 'task_local_attention');
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'unresolved', recovery_eligible: 1 }), 'task_local_attention');

  // `active`: each individual fact, disproven alone, must demote — proves
  // there is no OR-shortcut hiding in the implementation.
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'active' }, { ...FULL_LIVENESS_EVIDENCE, liveProcess: false }), 'task_local_attention', 'dead process must not read as actively owned');
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'active' }, { ...FULL_LIVENESS_EVIDENCE, leaseCurrent: false }), 'task_local_attention', 'a superseded/expired lease must not read as actively owned');
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'active' }, { ...FULL_LIVENESS_EVIDENCE, authorityCurrent: false }), 'task_local_attention', 'stale manager authority must not read as actively owned');
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'active' }, { ...FULL_LIVENESS_EVIDENCE, progressWithinStallWindow: false }), 'task_local_attention', 'progress stalled past the window must not read as actively owned');
  // Contradictory evidence — alive process but every other fact stale —
  // must still demote; liveness alone proves nothing about ownership.
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'active' }, { liveProcess: true, leaseCurrent: false, authorityCurrent: false, progressWithinStallWindow: false }), 'task_local_attention');

  // transition_* states: bounded on both the mutation-cap fact and a valid
  // future retry deadline (#698 final-head fix) — a bare mutation-count cap
  // with no proven deadline is not a retry schedule, exactly like the
  // `unresolved` bucket below.
  for (const state of ['transition_pending', 'transition_uncertain', 'attention_resolution_pending']) {
    assert.equal(classifyAttemptLivenessState({ resolution_state: state }, { ...FULL_LIVENESS_EVIDENCE, boundedRetryPolicyProven: false }), 'task_local_attention', `${state}: exhausted mutation cap must not read as bounded retry`);
    assert.equal(classifyAttemptLivenessState({ resolution_state: state }, { ...FULL_LIVENESS_EVIDENCE, retryDeadlineValid: false }), 'task_local_attention', `${state}: missing/malformed/expired retry deadline must not read as bounded retry`);
  }

  // unresolved + recovery_eligible: bounded on both a valid future retry
  // deadline and the outcome's attempt-count cap.
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'unresolved', recovery_eligible: 1 }, { ...FULL_LIVENESS_EVIDENCE, retryDeadlineValid: false }), 'task_local_attention', 'missing/expired retry deadline must not read as bounded retry');
  assert.equal(classifyAttemptLivenessState({ resolution_state: 'unresolved', recovery_eligible: 1 }, { ...FULL_LIVENESS_EVIDENCE, boundedRetryPolicyProven: false }), 'task_local_attention', 'an exhausted attempt-count cap must not read as bounded retry');
});

test('computeAttemptLivenessEvidence derives liveProcess=false for a dead process and for PID reuse/boot mismatch (#698 round 4, finding 1)', async () => {
  const row = { process_id: 4242, process_boot_id: 'boot-a', process_start_ticks: '111', systemd_invocation_id: null, resolution_state: 'active' };
  const deadProcessEvidence = await computeAttemptLivenessEvidence(row, { processProbe: async () => false });
  assert.equal(deadProcessEvidence.liveProcess, false);

  // A live PID whose boot id/start ticks no longer match (PID reuse) must
  // probe as `false`, not `true` — `probeProcessIdentity()`'s own contract
  // already returns `false` for a boot/start-tick mismatch; this proves the
  // evidence assembler trusts that contract rather than PID alone.
  const reusedPidEvidence = await computeAttemptLivenessEvidence(row, { processProbe: async () => false });
  assert.equal(reusedPidEvidence.liveProcess, false);

  const liveEvidence = await computeAttemptLivenessEvidence(row, { processProbe: async () => true });
  assert.equal(liveEvidence.liveProcess, true);

  // A throwing probe fails closed, never leaves `liveProcess` unset/truthy.
  const throwingProbeEvidence = await computeAttemptLivenessEvidence(row, { processProbe: async () => { throw new Error('proc read failed'); } });
  assert.equal(throwingProbeEvidence.liveProcess, false);
});

test('computeAttemptLivenessEvidence derives leaseCurrent from exclusivity across the active set, not from recovery_lease_id alone (#698 round 5, finding 1)', async () => {
  // recovery_lease_id is only ever populated for attempts claimed through
  // the bounded-recovery path (claimRecovery()) -- an ordinary first-run
  // issue attempt never has one, so requiring it unconditionally would
  // wrongly demote every ordinary attempt. Exclusivity (no OTHER active
  // attempt for the same issue, supplied by the caller as `otherLease`) is
  // the universal signal that applies to both attempt shapes.
  const withLease = { recovery_lease_id: 'lease-1', resolution_state: 'active' };
  const withoutLease = { recovery_lease_id: null, resolution_state: 'active' };
  assert.equal((await computeAttemptLivenessEvidence(withLease, { processProbe: async () => true })).leaseCurrent, true);
  assert.equal((await computeAttemptLivenessEvidence(withoutLease, { processProbe: async () => true })).leaseCurrent, true, 'an ordinary attempt with no recovery_lease_id at all must still read as exclusively owned absent a conflict');
  assert.equal((await computeAttemptLivenessEvidence(withLease, { processProbe: async () => true, otherLease: true })).leaseCurrent, false, 'a conflicting other active lease for the same issue must not read as current');
  assert.equal((await computeAttemptLivenessEvidence(withoutLease, { processProbe: async () => true, otherLease: true })).leaseCurrent, false, 'a conflicting other active attempt for the same issue must not read as current even with no recovery_lease_id');
});

test('computeAttemptLivenessEvidence derives authorityCurrent from the real manager timeline, false for stale authority (#698 round 4, finding 1)', async () => {
  const row = { claim_id: '41', resolution_state: 'active' };
  const currentComments = [{ id: 41, createdAt: '2026-07-01T09:00:00Z', body: '## Claude proceed command\nGo.' }];
  const supersededComments = [
    { id: 41, createdAt: '2026-07-01T09:00:00Z', body: '## Claude proceed command\nGo.' },
    { id: 42, createdAt: '2026-07-02T09:00:00Z', body: '## Claude proceed command\nGo again, superseding claim 41.' },
  ];
  assert.equal((await computeAttemptLivenessEvidence(row, { comments: currentComments })).authorityCurrent, true);
  assert.equal((await computeAttemptLivenessEvidence(row, { comments: supersededComments })).authorityCurrent, false, 'a later command superseding this claim revision must not read as current authority');
  assert.equal((await computeAttemptLivenessEvidence({ claim_id: null, resolution_state: 'active' }, { comments: currentComments })).authorityCurrent, false, 'a missing claim revision must not read as current authority');
});

test('computeAttemptLivenessEvidence uses immutable manager authority for new attempts and ignores later historical commands', async () => {
  const preflight = canonicalPreflightComment(41, 'LIVE.1');
  const authorityKey = `manager-preflight:LIVE.1:${TEST_MANAGER_FINGERPRINT}`;
  const marker = {
    id: 42,
    createdAt: '2026-07-23T09:01:00Z',
    body: `## Claude runner started\n\n- Manager packet authority: ${authorityKey}`,
  };
  const laterCommand = { id: 43, createdAt: '2026-07-23T09:02:00Z', body: '## Claude continue command\nHistorical compatibility evidence only.' };
  const row = { manager_authority_key: authorityKey, resolution_state: 'active' };

  assert.equal((await computeAttemptLivenessEvidence(row, { comments: [preflight, marker, laterCommand] })).authorityCurrent, true);
  const revoked = { id: 44, createdAt: '2026-07-23T09:03:00Z', body: '## Manager preflight packet — revoked\nStop.' };
  assert.equal((await computeAttemptLivenessEvidence(row, { comments: [preflight, marker, laterCommand, revoked] })).authorityCurrent, false);
});

test('computeAttemptLivenessEvidence derives progressWithinStallWindow=false once stalled_passes reaches the configured limit (#698 round 4, finding 1)', async () => {
  const fresh = { stalled_passes: 0, resolution_state: 'active' };
  const atLimit = { stalled_passes: 2, resolution_state: 'active' };
  assert.equal((await computeAttemptLivenessEvidence(fresh, { stallPassLimit: 2 })).progressWithinStallWindow, true);
  assert.equal((await computeAttemptLivenessEvidence(atLimit, { stallPassLimit: 2 })).progressWithinStallWindow, false, 'unchanged progress beyond the stall window must not read as within-window');
});

test('computeAttemptLivenessEvidence derives retryDeadlineValid=false for a missing or expired next_retry_at, true only for a genuinely future deadline with a persisted retry_reason (#698 round 5, finding 2)', async () => {
  const missingDeadline = { next_retry_at: null, retry_reason: 'rate_limited', resolution_state: 'unresolved', recovery_eligible: 1 };
  const expiredDeadline = { next_retry_at: '2026-01-01T00:00:00Z', retry_reason: 'rate_limited', resolution_state: 'unresolved', recovery_eligible: 1 };
  const futureDeadline = { next_retry_at: '2099-01-01T00:00:00Z', retry_reason: 'rate_limited', resolution_state: 'unresolved', recovery_eligible: 1 };
  // A future deadline with no persisted retry_reason is not a real,
  // schema-driven retry schedule (round 4's `retry_at` alone was exactly
  // this weaker shape) — must still fail closed.
  const noReasonDeadline = { next_retry_at: '2099-01-01T00:00:00Z', retry_reason: null, resolution_state: 'unresolved', recovery_eligible: 1 };
  const now = () => '2026-07-18T12:00:00Z';
  assert.equal((await computeAttemptLivenessEvidence(missingDeadline, { now })).retryDeadlineValid, false, 'a missing retry deadline must not read as valid');
  assert.equal((await computeAttemptLivenessEvidence(expiredDeadline, { now })).retryDeadlineValid, false, 'an expired retry deadline must not read as valid');
  assert.equal((await computeAttemptLivenessEvidence(futureDeadline, { now })).retryDeadlineValid, true);
  assert.equal((await computeAttemptLivenessEvidence(noReasonDeadline, { now })).retryDeadlineValid, false, 'a future deadline without a persisted retry_reason must not read as a real schedule');
});

test('classifyAttemptLivenessState + computeAttemptLivenessEvidence: a transition row is delayed_bounded_retry only for a genuinely valid future deadline — missing, malformed, and expired all fail closed to task_local_attention (#698 final-head fix)', async () => {
  const now = () => '2026-07-18T12:00:00Z';
  const baseTransitionRow = { resolution_state: 'transition_pending', retry_attempt: 1, retry_cap: MAX_TRANSITION_MUTATION_ATTEMPTS };

  // Missing: never scheduled at all (mutation_count 0, pre-round-5 shape).
  const missingDeadline = { ...baseTransitionRow, next_retry_at: null, retry_reason: null };
  // Malformed: a persisted retry_reason but an unparsable/corrupt timestamp
  // (e.g. store corruption) — Date.parse() yields NaN.
  const malformedDeadline = { ...baseTransitionRow, next_retry_at: 'not-a-real-timestamp', retry_reason: 'transition-mutation-retry' };
  // Expired: a genuinely parseable deadline that has already passed.
  const expiredDeadline = { ...baseTransitionRow, next_retry_at: '2020-01-01T00:00:00Z', retry_reason: 'transition-mutation-retry' };
  // Valid future: the only shape that may read as a real bounded delay.
  const validFutureDeadline = { ...baseTransitionRow, next_retry_at: '2099-01-01T00:00:00Z', retry_reason: 'transition-mutation-retry' };

  for (const [label, row] of [['missing', missingDeadline], ['malformed', malformedDeadline], ['expired', expiredDeadline]]) {
    const evidence = await computeAttemptLivenessEvidence(row, { now });
    assert.equal(evidence.retryDeadlineValid, false, `${label} transition deadline must not compute as valid`);
    assert.equal(classifyAttemptLivenessState(row, evidence), 'task_local_attention', `${label} transition deadline must fail closed to task_local_attention, never delayed_bounded_retry`);
  }

  const futureEvidence = await computeAttemptLivenessEvidence(validFutureDeadline, { now });
  assert.equal(futureEvidence.retryDeadlineValid, true);
  assert.equal(classifyAttemptLivenessState(validFutureDeadline, futureEvidence), 'delayed_bounded_retry', 'a genuinely proven future deadline plus cap headroom must read as delayed_bounded_retry');
});

test('computeAttemptLivenessEvidence derives boundedRetryPolicyProven from the persisted retry_attempt/retry_cap, never from mutation-count headroom alone (#698 round 5, finding 2)', async () => {
  const underCap = { next_retry_at: '2099-01-01T00:00:00Z', retry_reason: 'rate_limited', retry_attempt: 2, retry_cap: 3, resolution_state: 'unresolved', recovery_eligible: 1 };
  const atCap = { next_retry_at: '2099-01-01T00:00:00Z', retry_reason: 'rate_limited', retry_attempt: 3, retry_cap: 3, resolution_state: 'unresolved', recovery_eligible: 1 };
  assert.equal((await computeAttemptLivenessEvidence(underCap, {})).boundedRetryPolicyProven, true);
  assert.equal((await computeAttemptLivenessEvidence(atCap, {})).boundedRetryPolicyProven, false, 'an exhausted attempt-count cap must not read as bounded');

  // quota_paused has no attempt-count cap in decideRecovery (retry_cap is
  // persisted as null) — bounded solely by a genuinely persisted schedule.
  const quotaRow = { next_retry_at: '2099-01-01T00:00:00Z', retry_reason: 'quota_paused', retry_attempt: 999, retry_cap: null, resolution_state: 'unresolved', recovery_eligible: 1 };
  assert.equal((await computeAttemptLivenessEvidence(quotaRow, {})).boundedRetryPolicyProven, true);

  // Transition rows are bounded on retry_attempt vs. retry_cap exactly like
  // any other row once a schedule is persisted (#698 round 5's fix to
  // finding 2's "mutation-count headroom alone is not a retry schedule").
  const transitionUnderCap = { next_retry_at: '2099-01-01T00:00:00Z', retry_reason: 'transition-mutation-retry', retry_attempt: MAX_TRANSITION_MUTATION_ATTEMPTS - 1, retry_cap: MAX_TRANSITION_MUTATION_ATTEMPTS, resolution_state: 'transition_pending', transition_mutation_count: MAX_TRANSITION_MUTATION_ATTEMPTS - 1 };
  const transitionAtCap = { next_retry_at: '2099-01-01T00:00:00Z', retry_reason: 'transition-mutation-retry', retry_attempt: MAX_TRANSITION_MUTATION_ATTEMPTS, retry_cap: MAX_TRANSITION_MUTATION_ATTEMPTS, resolution_state: 'transition_pending', transition_mutation_count: MAX_TRANSITION_MUTATION_ATTEMPTS };
  assert.equal((await computeAttemptLivenessEvidence(transitionUnderCap, {})).boundedRetryPolicyProven, true);
  assert.equal((await computeAttemptLivenessEvidence(transitionAtCap, {})).boundedRetryPolicyProven, false);

  // A transition row with a bare mutation-count cap but no persisted
  // schedule (the pre-round-5 shape) must NOT read as bounded — this is
  // the literal defect the manager named ("mutation-count headroom alone
  // is not a retry schedule").
  const transitionNoSchedule = { resolution_state: 'transition_pending', transition_mutation_count: MAX_TRANSITION_MUTATION_ATTEMPTS - 1 };
  assert.equal((await computeAttemptLivenessEvidence(transitionNoSchedule, {})).boundedRetryPolicyProven, false, 'mutation-count headroom alone must not read as a bounded retry schedule');
});

test('listCandidateIssues selects issues using only status:/agent: labels, without requiring devplan', () => {
  const calls = [];
  const fakeGhRunner = (ghArgs) => {
    calls.push(ghArgs);
    assert.equal(ghArgs.includes('devplan'), false, 'gh issue list must not filter on the retired devplan label');
    const statusLabel = ghArgs[ghArgs.indexOf('--label') + 1];
    if (statusLabel === 'status:ready') {
      return JSON.stringify([{ number: 701, title: 'Ready issue without devplan', url: 'https://example.invalid/701', labels: [{ name: 'priority:P1' }], updatedAt: '2026-07-08T10:00:00Z' }]);
    }
    return JSON.stringify([]);
  };

  const issues = listCandidateIssues('TheTekTeam/modelspend', 10, ['agent:claude-code-cli'], true, fakeGhRunner);
  assert.equal(calls.length, 2); // status:ready and status:in-progress, one agent label each
  assert.deepEqual(issues.map((issue) => issue.number), [701]);
  assert.equal(issues[0].statusLabel, 'status:ready');
});

test('listCandidateIssues sorts older P0 work ahead of newer lower-priority ready work', () => {
  const fakeGhRunner = (ghArgs) => {
    const statusLabel = ghArgs[ghArgs.indexOf('--label') + 1];
    if (statusLabel === 'status:ready') {
      return JSON.stringify([
        { number: 599, title: 'Newer security issue', url: 'https://example.invalid/599', labels: [{ name: 'priority:P1' }], updatedAt: '2026-07-08T22:00:00Z' },
        { number: 550, title: 'Older plugin P0 issue', url: 'https://example.invalid/550', labels: [{ name: 'priority:P0' }], updatedAt: '2026-07-08T20:00:00Z' },
      ]);
    }
    return JSON.stringify([]);
  };

  const issues = listCandidateIssues('TheTekTeam/modelspend', 100, ['agent:claude-code-cli'], true, fakeGhRunner);
  assert.deepEqual(issues.map((issue) => issue.number), [550, 599]);
});

test('listCandidateIssues decorates candidates with adapter metadata and conflict diagnostics', () => {
  const fakeGhRunner = (ghArgs) => {
    const statusLabel = ghArgs[ghArgs.indexOf('--label') + 1];
    if (statusLabel === 'status:ready') {
      return JSON.stringify([
        { number: 710, title: 'Ready with priority conflict', url: 'https://example.invalid/710', fields: { Priority: 'P0' }, labels: [{ name: 'priority:P1' }], updatedAt: '2026-07-08T10:00:00Z' },
      ]);
    }
    return JSON.stringify([]);
  };

  const [issue] = listCandidateIssues('TheTekTeam/modelspend', 10, ['agent:claude-code-cli'], true, fakeGhRunner);
  assert.equal(issue.statusLabel, 'status:ready'); // transport label preserved for claim logic
  assert.equal(issue.metadata.priority.value, 'P0');
  assert.equal(issue.metadata.priority.source, 'field');
  assert.deepEqual(issueMetadataConflicts(issue), [
    { key: 'priority', field: 'Priority', fieldValue: 'P0', label: 'priority:P1', labelValue: 'P1' },
  ]);
});

test('listCandidateIssues ranks by canonical field priority over the stale compatibility label', () => {
  const fakeGhRunner = (ghArgs) => {
    const statusLabel = ghArgs[ghArgs.indexOf('--label') + 1];
    if (statusLabel === 'status:ready') {
      return JSON.stringify([
        { number: 721, title: 'Label P1, no field', url: 'https://example.invalid/721', labels: [{ name: 'priority:P1' }], updatedAt: '2026-07-08T22:00:00Z' },
        { number: 720, title: 'Label P3 but field P0', url: 'https://example.invalid/720', fields: { Priority: 'P0' }, labels: [{ name: 'priority:P3' }], updatedAt: '2026-07-08T20:00:00Z' },
      ]);
    }
    return JSON.stringify([]);
  };

  const issues = listCandidateIssues('TheTekTeam/modelspend', 100, ['agent:claude-code-cli'], true, fakeGhRunner);
  assert.deepEqual(issues.map((issue) => issue.number), [720, 721]);
});

test('selectIssue attaches metadataConflicts to a skip payload when a candidate field conflicts with its label', async () => {
  const fakeGhRunner = (ghArgs) => {
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'list') {
      const statusLabel = ghArgs[ghArgs.indexOf('--label') + 1];
      if (statusLabel === 'status:ready') {
        return JSON.stringify([{ number: 730, title: 'Conflicting ready issue without preflight', url: 'https://example.invalid/730', fields: { Priority: 'P0' }, labels: [{ name: 'priority:P1' }], updatedAt: '2026-07-08T10:00:00Z' }]);
      }
      return JSON.stringify([]);
    }
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'view') {
      return JSON.stringify({ comments: [{ id: 1, createdAt: '2026-07-08T09:00:00Z', body: '## Claude proceed command\nTask: do the thing' }] });
    }
    throw new Error(`unexpected gh invocation: ${ghArgs.join(' ')}`);
  };

  const args = { repo: 'TheTekTeam/modelspend', limit: 10, agentLabels: ['agent:claude-code-cli'], includeInProgress: true, requireManagerPreflight: true, execute: false, autoPreflightMode: false };
  const selected = await selectIssue(args, withEmptyOpenPrInventory(fakeGhRunner));
  assert.equal(selected.issue, null);
  assert.equal(selected.skipped.length, 1);
  assert.equal(selected.skipped[0].reason, 'manager-preflight-required');
  assert.deepEqual(selected.skipped[0].metadataConflicts, [
    { key: 'priority', field: 'Priority', fieldValue: 'P0', label: 'priority:P1', labelValue: 'P1' },
  ]);
});

test('selectIssue skips a ready issue when its command lacks manager preflight', async () => {
  const fakeGhRunner = (ghArgs) => {
    assert.equal(ghArgs.includes('devplan'), false, 'no gh invocation in selection should reference devplan');
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'list') {
      const statusLabel = ghArgs[ghArgs.indexOf('--label') + 1];
      if (statusLabel === 'status:ready') {
        return JSON.stringify([{ number: 701, title: 'Ready issue without manager preflight', url: 'https://example.invalid/701', labels: [{ name: 'priority:P1' }], updatedAt: '2026-07-08T10:00:00Z' }]);
      }
      return JSON.stringify([]);
    }
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'view') {
      return JSON.stringify({ comments: [{ id: 1, createdAt: '2026-07-08T09:00:00Z', body: '## Claude proceed command\nTask: do the thing' }] });
    }
    throw new Error(`unexpected gh invocation: ${ghArgs.join(' ')}`);
  };

  const args = { repo: 'TheTekTeam/modelspend', limit: 10, agentLabels: ['agent:claude-code-cli'], includeInProgress: true, requireManagerPreflight: true, execute: false, autoProceedFromPreflight: true, autoPreflightMode: false };
  const selected = await selectIssue(args, withEmptyOpenPrInventory(fakeGhRunner));
  assert.equal(selected.issue, null);
  assert.deepEqual(selected.skipped, [{ issue: 701, statusLabel: 'status:ready', reason: 'manager-preflight-required' }]);
});

test('selectIssue does not dispatch an older packet after a newer manager-preflight-stale notice (issue #599)', async () => {
  const fakeGhRunner = (ghArgs) => {
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'list') {
      const statusLabel = ghArgs[ghArgs.indexOf('--label') + 1];
      if (statusLabel === 'status:ready') {
        return JSON.stringify([{ number: 599, title: 'Stale dependency remediation', url: 'https://example.invalid/599', labels: [{ name: 'priority:P1' }], updatedAt: '2026-07-15T20:00:00Z' }]);
      }
      return JSON.stringify([]);
    }
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'view') {
      return JSON.stringify({
        comments: [
          { ...canonicalPreflightComment(1, 'TEST.DEP', 'Old dependency baseline.'), createdAt: '2026-07-15T18:00:00Z' },
          { id: 2, createdAt: '2026-07-15T19:00:00Z', body: '## Manager preflight stale\nMerged dependencies require a refresh. Do not dispatch.' },
        ],
      });
    }
    throw new Error(`unexpected gh invocation: ${ghArgs.join(' ')}`);
  };

  const args = { repo: 'TheTekTeam/modelspend', limit: 10, agentLabels: ['agent:claude-code-cli'], includeInProgress: true, requireManagerPreflight: true, execute: true, preflightDirectMode: true, autoPreflightMode: false };
  const selected = await selectIssue(args, withEmptyOpenPrInventory(fakeGhRunner));
  assert.equal(selected.issue, null);
  assert.deepEqual(selected.skipped, [{ issue: 599, statusLabel: 'status:ready', reason: 'manager-preflight-revoked' }]);
});

test('selectIssue ignores a historical proceed command when a canonical manager packet is current', async () => {
  const fakeGhRunner = (ghArgs) => {
    assert.equal(ghArgs.includes('devplan'), false, 'no gh invocation in selection should reference devplan');
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'list') {
      const statusLabel = ghArgs[ghArgs.indexOf('--label') + 1];
      if (statusLabel === 'status:ready') {
        return JSON.stringify([{ number: 701, title: 'Ready issue without devplan', url: 'https://example.invalid/701', labels: [{ name: 'priority:P1' }], updatedAt: '2026-07-08T10:00:00Z' }]);
      }
      return JSON.stringify([]);
    }
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'view') {
      return JSON.stringify({ comments: [
        { id: 1, createdAt: '2026-07-08T08:59:00Z', body: '## Claude proceed command\n\nHistorical command.' },
        { ...canonicalPreflightComment(2, 'TEST.701', 'Task: do the thing'), createdAt: '2026-07-08T09:00:00Z' },
      ] });
    }
    throw new Error(`unexpected gh invocation: ${ghArgs.join(' ')}`);
  };

  const args = { repo: 'TheTekTeam/modelspend', limit: 10, agentLabels: ['agent:claude-code-cli'], includeInProgress: true, requireManagerPreflight: true, execute: false, autoProceedFromPreflight: true, autoPreflightMode: false };
  const selected = await selectIssue(args, withEmptyOpenPrInventory(fakeGhRunner));
  assert.equal(selected.issue.number, 701);
  assert.equal(selected.command, null);
  assert.equal(selected.selection.mode, 'preflight-direct');
  assert.deepEqual(selected.skipped, []);
});

test('selectIssue reserves a runner-started task locally while continuing to eligible ready work', async () => {
  const viewedIssues = [];
  const fakeGhRunner = (ghArgs) => {
    assert.equal(ghArgs.includes('devplan'), false, 'no gh invocation in selection should reference devplan');
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'list') {
      const statusLabel = ghArgs[ghArgs.indexOf('--label') + 1];
      if (statusLabel === 'status:ready') {
        return JSON.stringify([
          { number: 801, title: 'Ready issue that should still run', url: 'https://example.invalid/801', labels: [{ name: 'priority:P0' }], updatedAt: '2026-07-09T10:00:00Z' },
        ]);
      }
      if (statusLabel === 'status:in-progress') {
        return JSON.stringify([
          { number: 800, title: 'Reserved runner issue', url: 'https://example.invalid/800', labels: [{ name: 'priority:P2' }], updatedAt: '2026-07-09T09:00:00Z' },
        ]);
      }
      return JSON.stringify([]);
    }
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'view') {
      const issueNumber = Number(ghArgs[2]);
      viewedIssues.push(issueNumber);
      if (issueNumber === 800) {
        return JSON.stringify({
          comments: [
            { id: 100, createdAt: '2026-07-09T09:01:00Z', body: '## Claude runner started\n\n- Selection mode: preflight-direct' },
          ],
        });
      }
      if (issueNumber === 801) {
        return JSON.stringify({
          comments: [
            { ...canonicalPreflightComment(101, 'TEST.101', 'Files checked by ChatGPT.'), createdAt: '2026-07-09T10:01:00Z' },
          ],
        });
      }
      throw new Error(`unexpected issue view: ${issueNumber}`);
    }
    throw new Error(`unexpected gh invocation: ${ghArgs.join(' ')}`);
  };

  const args = { repo: 'TheTekTeam/modelspend', limit: 100, agentLabels: ['agent:claude-code-cli'], includeInProgress: true, requireManagerPreflight: true, execute: true, preflightDirectMode: true, autoPreflightMode: false };
  const selected = await selectIssue(args, withEmptyOpenPrInventory(fakeGhRunner));

  assert.equal(selected.issue.number, 801);
  assert.equal(selected.selection.mode, 'preflight-direct');
  assert.equal(selected.blocked, null);
  assert.deepEqual(viewedIssues, [800, 801]);
  assert.equal(selected.skipped.length, 1);
  assert.equal(selected.skipped[0].issue, 800);
  assert.equal(selected.skipped[0].reason, 'active-runner-started-issue');
});

test('selectIssue selects a status:ready issue directly from its manager preflight packet when no proceed command exists (Agent Runner v2)', async () => {
  const fakeGhRunner = (ghArgs) => {
    assert.equal(ghArgs.includes('devplan'), false, 'no gh invocation in selection should reference devplan');
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'list') {
      const statusLabel = ghArgs[ghArgs.indexOf('--label') + 1];
      if (statusLabel === 'status:ready') {
        return JSON.stringify([{ number: 550, title: 'Guardrail contract', url: 'https://example.invalid/550', labels: [{ name: 'priority:P0' }], updatedAt: '2026-07-08T20:00:00Z' }]);
      }
      return JSON.stringify([]);
    }
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'view') {
      return JSON.stringify({ comments: [{ ...canonicalPreflightComment(12, 'TEST.12', 'Files checked by ChatGPT.'), createdAt: '2026-07-08T09:00:00Z' }] });
    }
    throw new Error(`unexpected gh invocation: ${ghArgs.join(' ')}`);
  };

  const args = { repo: 'TheTekTeam/modelspend', limit: 100, agentLabels: ['agent:claude-code-cli'], includeInProgress: true, requireManagerPreflight: true, execute: true, preflightDirectMode: true, autoPreflightMode: false };
  const selected = await selectIssue(args, withEmptyOpenPrInventory(fakeGhRunner));
  assert.equal(selected.issue.number, 550);
  assert.equal(selected.command, null);
  assert.equal(selected.selection.mode, 'preflight-direct');
  assert.equal(selected.selection.preflight.id, 12);
  assert.deepEqual(selected.skipped, []);
});

test('selectIssue also uses preflight-direct selection in dry-run mode, fixing the stale "missing proceed command" skip', async () => {
  const fakeGhRunner = (ghArgs) => {
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'list') {
      const statusLabel = ghArgs[ghArgs.indexOf('--label') + 1];
      if (statusLabel === 'status:ready') {
        return JSON.stringify([{ number: 551, title: 'Dry-run preflight-direct issue', url: 'https://example.invalid/551', labels: [{ name: 'priority:P1' }], updatedAt: '2026-07-08T20:00:00Z' }]);
      }
      return JSON.stringify([]);
    }
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'view') {
      return JSON.stringify({ comments: [{ ...canonicalPreflightComment(21, 'TEST.21', 'Files checked.'), createdAt: '2026-07-08T09:00:00Z' }] });
    }
    throw new Error(`unexpected gh invocation: ${ghArgs.join(' ')}`);
  };

  const args = { repo: 'TheTekTeam/modelspend', limit: 100, agentLabels: ['agent:claude-code-cli'], includeInProgress: true, requireManagerPreflight: true, execute: false, preflightDirectMode: true, autoPreflightMode: false };
  const selected = await selectIssue(args, withEmptyOpenPrInventory(fakeGhRunner));
  assert.equal(selected.issue.number, 551);
  assert.equal(selected.selection.mode, 'preflight-direct');
});

test('selectIssue skips a status:ready issue with neither a proceed command nor a manager preflight packet', async () => {
  const fakeGhRunner = (ghArgs) => {
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'list') {
      const statusLabel = ghArgs[ghArgs.indexOf('--label') + 1];
      if (statusLabel === 'status:ready') {
        return JSON.stringify([{ number: 552, title: 'No command, no preflight', url: 'https://example.invalid/552', labels: [], updatedAt: '2026-07-08T20:00:00Z' }]);
      }
      return JSON.stringify([]);
    }
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'view') {
      return JSON.stringify({ comments: [{ id: 30, createdAt: '2026-07-08T09:00:00Z', body: 'Just a regular comment.' }] });
    }
    throw new Error(`unexpected gh invocation: ${ghArgs.join(' ')}`);
  };

  const args = { repo: 'TheTekTeam/modelspend', limit: 100, agentLabels: ['agent:claude-code-cli'], includeInProgress: true, requireManagerPreflight: true, execute: true, preflightDirectMode: true, autoPreflightMode: false };
  const selected = await selectIssue(args, withEmptyOpenPrInventory(fakeGhRunner));
  assert.equal(selected.issue, null);
  assert.deepEqual(selected.skipped, [{ issue: 552, statusLabel: 'status:ready', reason: 'manager-preflight-required' }]);
});

test('selectIssue skips a preflight-direct candidate whose preflight was already claimed by a prior runner-started marker', async () => {
  const fakeGhRunner = (ghArgs) => {
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'list') {
      const statusLabel = ghArgs[ghArgs.indexOf('--label') + 1];
      if (statusLabel === 'status:ready') {
        return JSON.stringify([{ number: 553, title: 'Already claimed via preflight-direct', url: 'https://example.invalid/553', labels: [], updatedAt: '2026-07-08T20:00:00Z' }]);
      }
      return JSON.stringify([]);
    }
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'view') {
      return JSON.stringify({
        comments: [
          { ...canonicalPreflightComment(40, 'TEST.40', 'Files checked.'), createdAt: '2026-07-08T09:00:00Z' },
          { id: 41, createdAt: '2026-07-08T09:05:00Z', body: `## Claude runner started\n\n- Selection mode: preflight-direct\n- Source preflight comment: 40\n- Manager packet revision: TEST.40\n- Manager packet fingerprint: ${TEST_MANAGER_FINGERPRINT}\n- Manager packet authority: manager-preflight:TEST.40:${TEST_MANAGER_FINGERPRINT}` },
        ],
      });
    }
    throw new Error(`unexpected gh invocation: ${ghArgs.join(' ')}`);
  };

  const args = { repo: 'TheTekTeam/modelspend', limit: 100, agentLabels: ['agent:claude-code-cli'], includeInProgress: true, requireManagerPreflight: true, execute: true, preflightDirectMode: true, autoPreflightMode: false };
  const selected = await selectIssue(args, withEmptyOpenPrInventory(fakeGhRunner));
  assert.equal(selected.issue, null);
  assert.deepEqual(selected.skipped, [{ issue: 553, statusLabel: 'status:ready', reason: 'manager-preflight-already-claimed' }]);
});

test('selectIssue ignores retired preflight-direct toggle fields and still uses canonical manager authority', async () => {
  const fakeGhRunner = (ghArgs) => {
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'list') {
      const statusLabel = ghArgs[ghArgs.indexOf('--label') + 1];
      if (statusLabel === 'status:ready') {
        return JSON.stringify([{ number: 554, title: 'Preflight-direct disabled', url: 'https://example.invalid/554', labels: [], updatedAt: '2026-07-08T20:00:00Z' }]);
      }
      return JSON.stringify([]);
    }
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'view') {
      return JSON.stringify({ comments: [{ ...canonicalPreflightComment(50, 'TEST.50', 'Files checked.'), createdAt: '2026-07-08T09:00:00Z' }] });
    }
    throw new Error(`unexpected gh invocation: ${ghArgs.join(' ')}`);
  };

  const args = { repo: 'TheTekTeam/modelspend', limit: 100, agentLabels: ['agent:claude-code-cli'], includeInProgress: true, requireManagerPreflight: true, execute: true, preflightDirectMode: false, autoPreflightMode: false };
  const selected = await selectIssue(args, withEmptyOpenPrInventory(fakeGhRunner));
  assert.equal(selected.issue.number, 554);
  assert.equal(selected.selection.mode, 'preflight-direct');
  assert.deepEqual(selected.skipped, []);
});

const SAFE_GENERATION_BODY = `## Goal\n\nDo a well-scoped, safely preflightable thing with enough detail that the runner does not have to guess anything, touching \`scripts/ops/example.mjs\`.\n\n## Acceptance criteria\n\n- Thing one happens.\n- Tests pass.\n`;

test('listOpenPullRequests requests open PRs with the fields findLinkedOpenPullRequests needs', () => {
  const calls = [];
  const fakeGhRunner = (ghArgs) => { calls.push(ghArgs); return JSON.stringify([{ number: 9, title: 'WIP', body: '', headRefName: 'feature/9' }]); };
  const prs = listOpenPullRequests('TheTekTeam/modelspend', fakeGhRunner);
  assert.deepEqual(calls[0], ['pr', 'list', '--repo', 'TheTekTeam/modelspend', '--state', 'open', '--limit', '100', '--json', 'number,title,body,url,headRefName']);
  assert.equal(prs[0].state, 'open');
});

test('selectIssue skips a future configured agent label with structured unsupported-agent diagnostic', async () => {
  const calls = [];
  const args = { repo: 'TheTekTeam/modelspend', limit: 10, agentLabels: ['agent:codex-cli'], includeInProgress: false, requireManagerPreflight: true, execute: false, autoPreflightMode: false };
  const result = await selectIssue(args, (ghArgs) => {
    calls.push(ghArgs);
    if (ghArgs[0] === 'pr' && ghArgs[1] === 'list') return JSON.stringify([]);
    if (ghArgs[0] === 'issue' && ghArgs[1] === 'list') {
      return JSON.stringify([{ number: 655, title: 'Future agent', body: 'Body', updatedAt: '2026-01-01T00:00:00Z', labels: [{ name: 'status:ready' }, { name: 'agent:codex-cli' }] }]);
    }
    throw new Error(`unexpected gh call: ${ghArgs.join(' ')}`);
  });
  assert.equal(result.issue, null);
  assert.deepEqual(result.skipped, [{
    issue: 655,
    reason: 'unsupported-agent',
    agentId: 'codex-cli',
    label: null,
    detail: "Agent 'codex-cli' is registered for future use but is not implemented by this runner.",
    statusLabel: 'status:ready',
  }]);
  assert.equal(calls.length, 2);
});

for (const failure of [
  { name: 'open', openStore: () => { throw new Error('open failed'); } },
  { name: 'migration', openStore: () => { throw new Error('migration failed'); } },
  { name: 'write', openStore: () => ({ assertWritable() { return true; }, recordQuotaHistory() { throw new Error('write failed'); }, close() {} }) },
]) {
  test(`scheduler fails closed before GitHub mutation or child launch on state ${failure.name} failure`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `runner-state-${failure.name}-`));
    let githubCalls = 0;
    let childCalls = 0;
    const diagnostics = [];
    try {
      const exitCode = await main([
        '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
        '--state-db', join(dir, 'state.sqlite'), '--lock-path', join(dir, 'cron.lock'),
      ], { GH_TOKEN: 'test-token' }, {
        openStore: failure.openStore,
        ghRunner: () => { githubCalls += 1; throw new Error('must not mutate GitHub'); },
        runChild: async () => { childCalls += 1; throw new Error('must not launch child'); },
        logger: { error: (message) => diagnostics.push(message) },
      });
      assert.equal(exitCode, 1);
      assert.equal(githubCalls, 0);
      assert.equal(childCalls, 0);
      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0], /runner_state_unavailable/);
      assert.equal(readdirSync(dir).some((name) => name.startsWith('cron-') && name.endsWith('.json')), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('live-stall watchdog runs twice while the real singleton lock is held and writes attention once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-in-lock-watchdog-'));
  const lockPath = join(dir, 'cron.lock');
  const stateDbPath = join(dir, 'state.sqlite');
  const comments = [{ ...canonicalPreflightComment(1, 'TEST.1', 'Bounded task.'), createdAt: '2026-07-17T19:00:00Z' }];
  const ghCalls = [];
  let nextCommentId = 2;
  let attentionWhileLocked = 0;
  const ghRunner = (args) => {
    ghCalls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    if (args[0] === 'issue' && args[1] === 'list') {
      const labels = args.flatMap((value, index) => value === '--label' ? [args[index + 1]] : []);
      if (labels.includes('status:ready') && labels.includes('agent:claude-code-cli')) {
        return JSON.stringify([{ number: 698, title: 'Recovery task', body: 'Bounded runner recovery.', updatedAt: '2026-07-17T19:00:00Z', labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }, { name: 'priority:P0' }] }]);
      }
      return JSON.stringify([]);
    }
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments });
    if (args[0] === 'issue' && args[1] === 'comment') {
      const body = args[args.indexOf('--body') + 1];
      comments.push({ id: nextCommentId++, createdAt: '2026-07-17T19:00:00Z', body });
      if (body.includes('<!-- agent-runner:attention:v1 -->')) {
        assert.equal(existsSync(lockPath), true, 'watchdog must execute while the singleton lock remains held');
        attentionWhileLocked += 1;
      }
      return '';
    }
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'PATCH') {
      const body = args[args.indexOf('-f') + 1].slice('body='.length);
      const target = comments.find((comment) => comment.id === 3);
      if (target) target.body = body;
      return '';
    }
    if (args[0] === 'issue' && args[1] === 'edit') return '';
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
  };
  const childPayload = JSON.stringify({ logPath: 'child.json', executionPhase: 'implementation', costAdmission: { allowed: true }, sourcePreflightCommentId: '1' });
  try {
    const exitCode = await main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', lockPath, '--agent-labels', 'agent:claude-code-cli',
    ], { GH_TOKEN: 'test-token' }, {
      ghRunner,
      watchdogIntervalMs: 10,
      stalledPassLimit: 2,
      processProbe: async () => true,
      runChild: (options) => runChildWithWatchdog({
        ...options,
        command: process.execPath,
        commandArgs: ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(childPayload)}), 85)`],
        watchdogIntervalMs: 10,
        stalledPassLimit: 2,
      }),
    });
    assert.equal(exitCode, 0);
    assert.equal(attentionWhileLocked, 1);
    assert.equal(existsSync(lockPath), false);
    const state = openRunnerStateStore(stateDbPath);
    const attention = state.allRows('attention_events');
    assert.equal(attention.length, 1);
    assert.notEqual(attention[0].resolved_at, null);
    state.close();
    const attentionCreates = ghCalls.filter((call) => call[0] === 'issue' && call[1] === 'comment' && call.includes('--body') && call[call.indexOf('--body') + 1].includes('<!-- agent-runner:attention:v1 -->'));
    assert.equal(attentionCreates.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a long-running child with changing durable progress is not reported stalled under the singleton lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-progressing-watchdog-'));
  const lockPath = join(dir, 'cron.lock');
  const stateDbPath = join(dir, 'state.sqlite');
  const comments = [{ ...canonicalPreflightComment(1, 'TEST.1', 'Bounded task.'), createdAt: '2026-07-17T19:00:00Z' }];
  let attentionWrites = 0;
  const ghRunner = (args) => {
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    if (args[0] === 'issue' && args[1] === 'list') {
      const labels = args.flatMap((value, index) => value === '--label' ? [args[index + 1]] : []);
      if (labels.includes('status:ready') && labels.includes('agent:claude-code-cli')) {
        return JSON.stringify([{ number: 698, title: 'Progressing task', body: 'Bounded runner recovery.', updatedAt: '2026-07-17T19:00:00Z', labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }, { name: 'priority:P0' }] }]);
      }
      return JSON.stringify([]);
    }
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments });
    if (args[0] === 'issue' && args[1] === 'comment') {
      const body = args[args.indexOf('--body') + 1];
      comments.push({ id: comments.length + 1, createdAt: '2026-07-17T19:00:00Z', body });
      if (body.includes('<!-- agent-runner:attention:v1 -->')) attentionWrites += 1;
      return '';
    }
    if (args[0] === 'issue' && args[1] === 'edit') return '';
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
  };
  const childPayload = JSON.stringify({ logPath: 'child.json', executionPhase: 'implementation', costAdmission: { allowed: true }, sourcePreflightCommentId: '1' });
  const originalLog = console.log;
  // Deterministic replacement for a real-child/real-watchdog-timer race
  // (#698 finding 8 re-review). The original test raced two independent
  // real timers (the spawned child's own setInterval/setTimeout against the
  // watchdog's setInterval) inside a 95ms window — inherently flaky under
  // system load. This version removes the *competing* timer entirely: a
  // fake child (EventEmitter, no real subprocess, no internal timers) never
  // ends on its own, so there is nothing to race against. It still
  // exercises the real production watchdog code
  // (runChildWithWatchdog -> reconcileSchedulerAttempts -> markStalledPass)
  // through the real singleton-lock main() path; the only real timer left
  // is the watchdog's own, and the test just waits for it to tick twice via
  // polling (a real but race-free wait, not a coordination race).
  const fakeChild = new EventEmitter();
  fakeChild.pid = 4242;
  fakeChild.stdout = new EventEmitter();
  fakeChild.stdout.setEncoding = () => {};
  fakeChild.stderr = new EventEmitter();
  fakeChild.stderr.setEncoding = () => {};
  fakeChild.kill = () => {};
  const waitUntil = async (predicate, { timeoutMs = 5000, stepMs = 5 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('waitUntil timed out');
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  };
  try {
    console.log = () => {};
    let progressCounter = 0;
    const mainPromise = main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', lockPath, '--agent-labels', 'agent:claude-code-cli',
    ], { GH_TOKEN: 'test-token' }, {
      ghRunner,
      watchdogIntervalMs: 10,
      stalledPassLimit: 2,
      processProbe: async () => true,
      // A fresh value every call means every watchdog tick observes
      // changed progress, matching the scenario's intent (progress that
      // keeps advancing must never be reported stalled).
      progressProbe: () => `progress-${++progressCounter}`,
      spawnRunner: () => fakeChild,
    });
    // Initial capture (before the interval loop starts) plus two ticks.
    await waitUntil(() => progressCounter >= 3);
    fakeChild.stdout.emit('data', childPayload);
    fakeChild.emit('close', 0, null);
    const exitCode = await mainPromise;
    assert.equal(exitCode, 0);
    assert.equal(attentionWrites, 0);
    const state = openRunnerStateStore(stateDbPath);
    const attempt = state.allRows('recovery_attempts')[0];
    assert.equal(attempt.progress_revision > 2, true);
    assert.equal(attempt.stalled_passes < 2, true);
    assert.equal(state.allRows('attention_events').length, 0);
    state.close();
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});
