import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { redactSensitiveText } from './lib/redact.mjs';
import {
  explainQueue,
  normalizeReason,
  parseExplainArgs,
  run,
} from './agent-runner-queue-explain.mjs';

const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

function preflightComment({ id = 1, revision = 'AR-TEST.1' } = {}) {
  return {
    id,
    createdAt: '2026-07-24T18:00:00Z',
    user: { login: 'gpcola' },
    body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: ${revision}\nfingerprint: ${FINGERPRINT}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: claude-code-cli\nexecution_phase: implementation\nscope:\n  - bounded test scope\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on scope expansion\n\`\`\`\n`,
  };
}

function issue({ number, statusLabel = 'status:ready', agentLabels = ['agent:claude-code-cli'] }) {
  return {
    number,
    title: `issue ${number}`,
    body: '',
    url: `https://github.com/TheTekTeam/modelspend/issues/${number}`,
    updatedAt: '2026-07-24T18:00:00Z',
    labels: [{ name: statusLabel }, ...agentLabels.map((name) => ({ name }))],
  };
}

function issueWithFieldConflict({ number, statusLabel = 'status:ready', fieldStatus = 'Blocked' }) {
  return { ...issue({ number, statusLabel }), fields: { Status: fieldStatus } };
}

function writeConfig(dir) {
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    projectId: 'modelspend',
    displayName: 'ModelSpend',
    githubRepo: 'TheTekTeam/modelspend',
    localRepoPath: join(dir, 'repo'),
    outputDir: join(dir, 'out'),
    stateDbPath: join(dir, 'out', 'runner-state.sqlite'),
    acceptedAgentLabels: ['agent:claude', 'agent:claude-code-cli'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
    priorityLabelRanking: ['priority:P0'],
    safeDefaultValidationCommands: [],
    systemd: { serviceName: 'x.service', timerName: 'x.timer' },
  }, null, 2));
  return configPath;
}

function memoryIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: (text) => { stderr += text; } },
    },
    read: () => ({ stdout, stderr }),
  };
}

/**
 * Fake `gh` CLI: no network, no filesystem. Every call is recorded so tests
 * can assert zero mutating GitHub subcommands were ever invoked.
 */
function fakeGh({ issues, commentsByIssue = {}, openPullRequests = [] }) {
  const calls = [];
  const runner = (jsonArgs) => {
    calls.push(jsonArgs);
    if (jsonArgs[0] === 'issue' && jsonArgs[1] === 'list') {
      const statusLabel = jsonArgs[jsonArgs.indexOf('--label')];
      const labelArgs = jsonArgs.filter((_, index) => jsonArgs[index - 1] === '--label');
      const [wantedStatus, wantedAgent] = labelArgs;
      const matches = issues.filter((candidate) => candidate.labels.some((label) => label.name === wantedStatus)
        && candidate.labels.some((label) => label.name === wantedAgent));
      return JSON.stringify(matches);
    }
    if (jsonArgs[0] === 'issue' && jsonArgs[1] === 'view') {
      const issueNumber = Number(jsonArgs[2]);
      return JSON.stringify({ comments: commentsByIssue[issueNumber] || [] });
    }
    if (jsonArgs[0] === 'pr' && jsonArgs[1] === 'list') {
      return JSON.stringify(openPullRequests);
    }
    throw new Error(`unexpected gh invocation in test: ${jsonArgs.join(' ')}`);
  };
  return { runner, calls };
}

function assertNoMutatingCalls(calls) {
  for (const call of calls) {
    assert.notEqual(call[1], 'edit');
    assert.notEqual(call[1], 'comment');
    assert.notEqual(call[1], 'close');
    assert.notEqual(call[1], 'create');
    assert.equal(call.includes('-X'), false);
  }
}

test('parseExplainArgs requires --project and rejects a project identity mismatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'explain-args-'));
  try {
    const configPath = writeConfig(dir);
    assert.deepEqual(parseExplainArgs(['--config', configPath], {}), { error: '--project is required' });
    assert.deepEqual(
      parseExplainArgs(['--config', configPath, '--project', 'other'], {}),
      { error: 'project-identity-mismatch' },
    );
    assert.deepEqual(
      parseExplainArgs(['--config', configPath, '--bogus'], {}),
      { error: 'Unknown argument: --bogus' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explainQueue reports every candidate exactly once, continuing past skips to a later runnable issue, read-only', async () => {
  const issues = [
    issue({ number: 101, agentLabels: ['agent:claude-code-cli'] }), // no preflight -> manager-preflight-required
    issue({ number: 103, agentLabels: ['agent:claude-code-cli', 'agent:codex-cli'] }), // two distinct agents -> ambiguous-agent-labels
    issue({ number: 104, agentLabels: ['agent:claude-code-cli'] }), // valid preflight -> runnable
  ];
  const commentsByIssue = {
    101: [],
    104: [preflightComment({ id: 1 })],
  };
  const { runner, calls } = fakeGh({ issues, commentsByIssue });

  const args = { project: 'modelspend' };
  const report = await explainQueue(args, {}, { baseGhRunner: runner, now: () => '2026-07-24T19:00:00.000Z' });

  assert.equal(report.queueInspectionDegraded, false);
  assert.equal(report.inspectedCount, 3);
  assert.equal(report.runnableCount, 1);
  assert.equal(report.skippedCount, 2);
  assert.equal(report.issueMutation, false);
  assert.equal(report.stateMutation, false);

  const byNumber = Object.fromEntries(report.candidates.map((entry) => [entry.issueNumber, entry]));
  assert.equal(byNumber[101].reason, 'manager-preflight-required');
  assert.equal(byNumber[101].runnable, false);
  assert.equal(byNumber[103].reason, 'ambiguous-agent-labels');
  assert.equal(byNumber[104].reason, 'runnable');
  assert.equal(byNumber[104].runnable, true);

  // Every candidate has exactly one bounded field set -- no raw error text,
  // routing internals, or label objects leaked.
  for (const entry of report.candidates) {
    assert.deepEqual(Object.keys(entry).sort(), [
      'agentId', 'assignmentDisplayName', 'assignmentLabel', 'issueNumber', 'reason', 'runnable', 'statusLabel',
    ]);
  }

  assertNoMutatingCalls(calls);
  const serialized = JSON.stringify(report);
  assert.equal(redactSensitiveText(serialized), serialized);
});

test('explainQueue reports metadata-conflict when a project Status field disagrees with the status label, continuing past it to a later runnable issue', async () => {
  const issues = [
    issueWithFieldConflict({ number: 301, statusLabel: 'status:ready', fieldStatus: 'Blocked' }),
    issue({ number: 302, agentLabels: ['agent:claude-code-cli'] }),
  ];
  const commentsByIssue = { 302: [preflightComment({ id: 2 })] };
  const { runner } = fakeGh({ issues, commentsByIssue });
  const report = await explainQueue({ project: 'modelspend' }, {}, { baseGhRunner: runner });
  const byNumber = Object.fromEntries(report.candidates.map((entry) => [entry.issueNumber, entry]));
  assert.equal(byNumber[301].reason, 'metadata-conflict');
  assert.equal(byNumber[301].runnable, false);
  assert.equal(byNumber[302].reason, 'runnable');
});

test('explainQueue displays the shared assignment as Codex / Claude while keeping the actual selected worker separate (#97)', async () => {
  const issues = [
    issue({ number: 401, agentLabels: ['agent:codex-claude'] }), // shared assignment, runnable
    issue({ number: 402, agentLabels: ['agent:codex-claude'] }), // shared assignment, skipped
    issue({ number: 403, agentLabels: ['agent:claude-code-cli'] }), // unchanged non-shared assignment
  ];
  const commentsByIssue = { 401: [preflightComment({ id: 1 })], 402: [], 403: [] };
  const { runner, calls } = fakeGh({ issues, commentsByIssue });
  const env = { CLAUDE_RUNNER_CRON_AGENT_LABELS: 'agent:claude-code-cli,agent:codex-claude' };

  const report = await explainQueue({ project: 'modelspend' }, env, { baseGhRunner: runner });
  const byNumber = Object.fromEntries(report.candidates.map((entry) => [entry.issueNumber, entry]));

  // The shared label is eligibility metadata and displays as `Codex / Claude`
  // -- it never replaces the agent that would actually do the work.
  assert.equal(byNumber[401].reason, 'runnable');
  assert.equal(byNumber[401].assignmentLabel, 'agent:codex-claude');
  assert.equal(byNumber[401].assignmentDisplayName, 'Codex / Claude');
  assert.equal(byNumber[401].agentId, 'claude-code-cli');

  // A skipped shared-assignment candidate still shows the assignment; with no
  // agent resolved by the selector it reports null rather than guessing.
  assert.equal(byNumber[402].runnable, false);
  assert.equal(byNumber[402].assignmentDisplayName, 'Codex / Claude');
  assert.equal(byNumber[402].agentId, null);

  // Non-shared assignments are unchanged: no display alias exists for them,
  // so the canonical helper returns the label itself.
  assert.equal(byNumber[403].assignmentLabel, 'agent:claude-code-cli');
  assert.equal(byNumber[403].assignmentDisplayName, 'agent:claude-code-cli');

  assertNoMutatingCalls(calls);
  const serialized = JSON.stringify(report);
  assert.equal(redactSensitiveText(serialized), serialized);
});

test('explainQueue never forwards an issue label the adapter catalogue does not know (#97)', async () => {
  const issues = [issue({ number: 501, agentLabels: ['agent:codex-claude', 'agent:not-a-real-catalogue-label'] })];
  const { runner } = fakeGh({ issues, commentsByIssue: { 501: [] } });
  const env = { CLAUDE_RUNNER_CRON_AGENT_LABELS: 'agent:codex-claude' };
  const report = await explainQueue({ project: 'modelspend' }, env, { baseGhRunner: runner });
  const entry = report.candidates.find((candidate) => candidate.issueNumber === 501);
  assert.equal(entry.assignmentLabel, 'agent:codex-claude');
  assert.equal(JSON.stringify(report).includes('not-a-real-catalogue-label'), false);
});

test('normalizeReason maps every canonical selectIssue() reason to itself and anything else to the closed unclassified-skip fallback', () => {
  const recognized = [
    'runnable', 'metadata-conflict', 'ambiguous-agent-labels', 'unsupported-agent',
    'reassignment-candidate', 'no-qualified-agent', 'agent-not-eligible',
    'manager-authority-approved-agent-mismatch', 'candidate-read-failed',
    'manager-preflight-required', 'manager-preflight-invalid', 'manager-preflight-revoked',
    'manager-preflight-already-claimed', 'active-runner-started-issue', 'orphaned-runner-started-marker',
  ];
  for (const reason of recognized) assert.equal(normalizeReason(reason), reason);
  assert.equal(normalizeReason('unsupported status label status:blocked'), 'candidate-status-label-unsupported');
  assert.equal(normalizeReason('some-future-reason-this-module-does-not-know-about'), 'unclassified-skip');
  assert.equal(normalizeReason(undefined), 'unclassified-skip');
});

test('explainQueue reports queueInspectionDegraded and stops, without claiming "no candidates"', async () => {
  const runner = () => { throw new Error('simulated GitHub outage with a raw message that must never leak'); };
  const args = { project: 'modelspend' };
  const report = await explainQueue(args, {}, { baseGhRunner: runner });
  assert.equal(report.queueInspectionDegraded, true);
  assert.equal(report.inspectedCount, 0);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('simulated GitHub outage'), false);
});

test('run() fails closed on an unreadable --config file instead of an unhandled rejection with a raw stack trace and path', async () => {
  const output = memoryIo();
  const code = await run(['--config', '/nonexistent-agent-runner-explain-config.json', '--project', 'modelspend'], {}, output.io);
  assert.equal(code, 2);
  assert.deepEqual(JSON.parse(output.read().stderr), { ok: false, reason: 'config-load-failed' });
});

test('run() CLI wrapper prints the bounded report and exits 0 for a healthy pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'explain-cli-'));
  try {
    const configPath = writeConfig(dir);
    const output = memoryIo();
    const { runner } = fakeGh({ issues: [], commentsByIssue: {} });
    const code = await run(['--config', configPath, '--project', 'modelspend'], {}, output.io, { baseGhRunner: runner });
    assert.equal(code, 0);
    const report = JSON.parse(output.read().stdout);
    assert.equal(report.inspectedCount, 0);
    assert.equal(report.issueMutation, false);
    assert.equal(report.project.projectId, 'modelspend');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run() CLI wrapper exits 2 with a closed reason on missing --project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'explain-cli-usage-'));
  try {
    const configPath = writeConfig(dir);
    const output = memoryIo();
    const code = await run(['--config', configPath], {}, output.io);
    assert.equal(code, 2);
    assert.deepEqual(JSON.parse(output.read().stderr), { ok: false, reason: '--project is required' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
