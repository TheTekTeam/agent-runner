import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROL_EVIDENCE_DEFAULT_ISSUE,
  CONTROL_EVIDENCE_MARKER,
  CONTROL_EVIDENCE_SCHEMA_VERSION,
  ControlEvidenceError,
  buildControlEvidence,
  buildControlEvidenceCommentBody,
  collectControlEvidenceFacts,
  evaluateControlEvidenceReadiness,
  publishControlEvidence,
  resolveControlEvidenceIssue,
  runControlEvidence,
} from './agent-runner-control-evidence.mjs';

const HEAD = 'a'.repeat(40);

function gitResponses(overrides = {}) {
  const defaults = {
    'rev-parse --show-toplevel': { status: 0, stdout: '/canonical/agent-runner\n' },
    'remote get-url origin': { status: 0, stdout: 'https://github.com/TheTekTeam/agent-runner.git\n' },
    'symbolic-ref --quiet --short HEAD': { status: 0, stdout: 'main\n' },
    'rev-parse --verify HEAD^{commit}': { status: 0, stdout: `${HEAD}\n` },
    'status --porcelain=v1 --untracked-files=all': { status: 0, stdout: '' },
  };
  return { ...defaults, ...overrides };
}

function fakeRunGit(responses) {
  return (args) => {
    const key = args.join(' ');
    return responses[key] ?? { status: 1, stdout: '' };
  };
}

function fakeRealpath(map) {
  return (value) => {
    if (Object.prototype.hasOwnProperty.call(map, value)) return map[value];
    throw new Error(`unexpected realpath(${value})`);
  };
}

function fakeSpawn({ genericEnabled = 0, genericActive = 0, legacyEnabled = 1, legacyActive = 3 } = {}) {
  return (_bin, args) => {
    const unit = args[args.length - 1];
    const verb = args[1];
    if (unit === 'agent-runner-implementation.timer') {
      return { status: verb === 'is-enabled' ? genericEnabled : genericActive };
    }
    if (unit === 'agent-runner-modelspend.timer') {
      return { status: verb === 'is-enabled' ? legacyEnabled : legacyActive };
    }
    return { status: 4 };
  };
}

function baseCollectOptions(overrides = {}) {
  return {
    env: { AGENT_RUNNER_SOURCE_ACTIVATION_ENABLED: 'true', AGENT_RUNNER_SOURCE_ACTIVATION_CONTROL_ISSUE: '41' },
    repositoryRoot: '/canonical/agent-runner',
    runGit: fakeRunGit(gitResponses()),
    realpath: fakeRealpath({ '/canonical/agent-runner': '/canonical/agent-runner' }),
    exists: () => false,
    readFile: () => { throw new Error('no lock file'); },
    isAlive: () => false,
    spawn: fakeSpawn(),
    now: () => '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

test('clean main + idle lock + canonical origin + correct timer topology projects ready', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions());
  const evidence = buildControlEvidence(facts);
  assert.equal(evidence.readinessCode, 'ready');
  assert.equal(evidence.ready, true);
  assert.equal(evidence.repositoryVerified, true);
  assert.equal(evidence.branch, 'main');
  assert.equal(evidence.headSha, HEAD);
  assert.equal(evidence.clean, true);
  assert.equal(evidence.implementationQuiescent, true);
  assert.equal(evidence.genericTimerState, 'enabled-active');
  assert.equal(evidence.legacyTimerDisabled, true);
  assert.equal(evidence.sourceActivationControlIssue, 41);
});

test('supported canonical SSH origin is accepted without publishing raw origin text', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions({
    runGit: fakeRunGit(gitResponses({
      'remote get-url origin': { status: 0, stdout: 'git@github.com:TheTekTeam/agent-runner.git\n' },
    })),
  }));
  const evidence = buildControlEvidence(facts);
  assert.equal(evidence.repositoryVerified, true);
  assert.equal(buildControlEvidenceCommentBody(evidence).includes('git@github.com'), false);
});

test('dirty checkout projects not-ready and is never mistaken for ready', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions({
    runGit: fakeRunGit(gitResponses({
      'status --porcelain=v1 --untracked-files=all': { status: 0, stdout: ' M scripts/ops/x.mjs\n' },
    })),
  }));
  const evidence = buildControlEvidence(facts);
  assert.equal(evidence.ready, false);
  assert.equal(evidence.readinessCode, 'not-ready-dirty');
  assert.equal(evidence.clean, false);
});

test('wrong branch projects not-ready-branch-mismatch', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions({
    runGit: fakeRunGit(gitResponses({
      'symbolic-ref --quiet --short HEAD': { status: 0, stdout: 'feature/other\n' },
    })),
  }));
  assert.equal(evaluateControlEvidenceReadiness(facts), 'not-ready-branch-mismatch');
  assert.equal(buildControlEvidence(facts).branch, null);
});

test('wrong checkout path projects not-ready-repository-mismatch', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions({
    realpath: fakeRealpath({ '/canonical/agent-runner': '/canonical/agent-runner', '/somewhere/else': '/somewhere/else' }),
    runGit: fakeRunGit(gitResponses({
      'rev-parse --show-toplevel': { status: 0, stdout: '/somewhere/else\n' },
    })),
  }));
  assert.equal(evaluateControlEvidenceReadiness(facts), 'not-ready-repository-mismatch');
});

test('wrong repository origin at the canonical path projects not-ready-repository-mismatch', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions({
    runGit: fakeRunGit(gitResponses({
      'remote get-url origin': { status: 0, stdout: 'https://github.com/TheTekTeam/modelspend.git\n' },
    })),
  }));
  const evidence = buildControlEvidence(facts);
  assert.equal(evidence.repositoryVerified, false);
  assert.equal(evidence.readinessCode, 'not-ready-repository-mismatch');
  assert.equal(buildControlEvidenceCommentBody(evidence).includes('modelspend.git'), false);
});

test('missing or ambiguous origin fails closed as repository mismatch', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions({
    runGit: fakeRunGit(gitResponses({
      'remote get-url origin': { status: 2, stdout: 'token-bearing diagnostic must not leak\n' },
    })),
  }));
  const body = buildControlEvidenceCommentBody(buildControlEvidence(facts));
  assert.equal(evaluateControlEvidenceReadiness(facts), 'not-ready-repository-mismatch');
  assert.equal(body.includes('token-bearing'), false);
});

test('active implementation lock projects not-ready-lock-active', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions({
    exists: () => true,
    readFile: () => `4242\n2026-08-18T00:00:00.000Z\n`,
    isAlive: () => true,
  }));
  assert.equal(evaluateControlEvidenceReadiness(facts), 'not-ready-lock-active');
  assert.equal(buildControlEvidence(facts).implementationQuiescent, false);
});

test('malformed lock file projects not-ready-lock-ambiguous, never idle', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions({
    exists: () => true,
    readFile: () => 'not-a-lock-file',
  }));
  assert.equal(evaluateControlEvidenceReadiness(facts), 'not-ready-lock-ambiguous');
});

test('unknown systemd policy projects not-ready-timer-topology-unknown', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions({
    spawn: () => ({ status: 42 }),
  }));
  assert.equal(evaluateControlEvidenceReadiness(facts), 'not-ready-timer-topology-unknown');
  assert.equal(buildControlEvidence(facts).genericTimerState, 'unknown');
});

test('legacy timer still enabled alongside generic timer projects not-ready-timer-topology', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions({
    spawn: fakeSpawn({ legacyEnabled: 0, legacyActive: 0 }),
  }));
  assert.equal(evaluateControlEvidenceReadiness(facts), 'not-ready-timer-topology');
  assert.equal(buildControlEvidence(facts).legacyTimerDisabled, false);
});

test('source-activation enabled with an invalid control issue projects not-ready-policy-unknown', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions({
    env: { AGENT_RUNNER_SOURCE_ACTIVATION_ENABLED: 'true', AGENT_RUNNER_SOURCE_ACTIVATION_CONTROL_ISSUE: 'not-a-number' },
  }));
  assert.equal(evaluateControlEvidenceReadiness(facts), 'not-ready-policy-unknown');
  assert.equal(buildControlEvidence(facts).sourceActivationControlIssue, null);
});

test('source-activation disabled with no control issue configured is still policy-known and can be ready', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions({ env: {} }));
  const evidence = buildControlEvidence(facts);
  assert.equal(evidence.readinessCode, 'ready');
  assert.equal(evidence.sourceActivationEnabled, false);
  assert.equal(evidence.sourceActivationControlIssue, null);
});

test('published evidence exposes only the fixed bounded field list', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions());
  const evidence = buildControlEvidence(facts);
  assert.deepEqual(Object.keys(evidence).sort(), [
    'branch',
    'clean',
    'genericTimerState',
    'headSha',
    'implementationQuiescent',
    'ready',
    'readinessCode',
    'recordedAt',
    'repository',
    'repositoryVerified',
    'schemaVersion',
    'sourceActivationControlIssue',
    'sourceActivationEnabled',
    'legacyTimerDisabled',
  ].sort());
  assert.equal(evidence.schemaVersion, CONTROL_EVIDENCE_SCHEMA_VERSION);
});

test('adversarial env/config/systemd/git strings never enter the published comment body', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions({
    env: {
      AGENT_RUNNER_SOURCE_ACTIVATION_ENABLED: 'true',
      AGENT_RUNNER_SOURCE_ACTIVATION_CONTROL_ISSUE: '41',
      GH_TOKEN: 'ghp_should_never_leak_00000000000000',
      ANTHROPIC_API_KEY: 'sk-ant-should-never-leak',
      HOME: '/home/adversarial-secret-path',
    },
    runGit: fakeRunGit(gitResponses({
      'symbolic-ref --quiet --short HEAD': {
        status: 0,
        stdout: 'main; rm -rf / #<script>alert(1)</script> $(cat /etc/shadow)\n',
      },
      'remote get-url origin': {
        status: 0,
        stdout: 'https://user:secret@github.com/TheTekTeam/agent-runner.git\n',
      },
    })),
  }));
  const evidence = buildControlEvidence(facts);
  const body = buildControlEvidenceCommentBody(evidence);
  assert.equal(body.includes('ghp_should_never_leak'), false);
  assert.equal(body.includes('sk-ant-should-never-leak'), false);
  assert.equal(body.includes('adversarial-secret-path'), false);
  assert.equal(body.includes('rm -rf'), false);
  assert.equal(body.includes('<script>'), false);
  assert.equal(body.includes('user:secret'), false);
  assert.equal(evidence.branch, null); // rejected by the branch allowlist pattern, never passed through
  assert.equal(evidence.repositoryVerified, false); // credential-bearing origin is not canonical
  assert.equal(body.startsWith(CONTROL_EVIDENCE_MARKER), true);
});

test('identical evidence dedupes rather than posting or patching again', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions());
  const evidence = buildControlEvidence(facts);
  const body = buildControlEvidenceCommentBody(evidence);
  let execCalls = 0;
  const result = publishControlEvidence({
    issueNumber: 99,
    evidence,
    env: { GH_TOKEN: 'test-token' },
    fetchComments: () => [{ id: 5, body }],
    exec: () => { execCalls += 1; return ''; },
  });
  assert.equal(result.action, 'deduped');
  assert.equal(result.commentId, 5);
  assert.equal(execCalls, 0);
});

test('changed evidence patches the same existing comment, never appends a new one', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions());
  const evidence = buildControlEvidence(facts);
  const staleBody = `${CONTROL_EVIDENCE_MARKER}\n\nstale`;
  const execCalls = [];
  const result = publishControlEvidence({
    issueNumber: 99,
    evidence,
    env: { GH_TOKEN: 'test-token' },
    fetchComments: () => [{ id: 7, body: staleBody }],
    exec: (bin, args) => { execCalls.push(args); return ''; },
  });
  assert.equal(result.action, 'updated');
  assert.equal(result.commentId, 7);
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0][2], 'PATCH');
  assert.equal(execCalls[0][3], '/repos/TheTekTeam/agent-runner/issues/comments/7');
});

test('no existing comment creates exactly one new comment', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions());
  const evidence = buildControlEvidence(facts);
  const execCalls = [];
  const result = publishControlEvidence({
    issueNumber: 99,
    evidence,
    env: { GH_TOKEN: 'test-token' },
    fetchComments: () => [],
    exec: (bin, args) => { execCalls.push(args); return JSON.stringify({ id: 555 }); },
  });
  assert.equal(result.action, 'created');
  assert.equal(result.commentId, 555);
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0][2], 'POST');
});

test('more than one existing marked comment refuses ambiguously rather than guessing', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions());
  const evidence = buildControlEvidence(facts);
  const body = buildControlEvidenceCommentBody(evidence);
  assert.throws(
    () => publishControlEvidence({
      issueNumber: 99,
      evidence,
      env: { GH_TOKEN: 'test-token' },
      fetchComments: () => [{ id: 1, body }, { id: 2, body: `${body}x` }],
      exec: () => '',
    }),
    (error) => error instanceof ControlEvidenceError && error.reason === 'control-evidence-comment-ambiguous',
  );
});

test('publisher failure never mutates local facts or evidence -- only the attempted write is rejected', () => {
  const facts = collectControlEvidenceFacts(baseCollectOptions());
  const evidence = buildControlEvidence(facts);
  assert.throws(
    () => publishControlEvidence({
      issueNumber: 99,
      evidence,
      env: { GH_TOKEN: 'test-token' },
      fetchComments: () => [],
      exec: () => { throw new Error('transport failure carrying a secret response body'); },
    }),
    (error) => error instanceof ControlEvidenceError && error.reason === 'control-evidence-github-write-failed',
  );
  // The already-built evidence object is frozen and unaffected by the failed publish attempt.
  assert.equal(evidence.ready, true);
});

test('resolveControlEvidenceIssue prefers explicit issue, then source-activation issue, then dedicated default', () => {
  assert.equal(resolveControlEvidenceIssue({ AGENT_RUNNER_CONTROL_EVIDENCE_ISSUE: '99', AGENT_RUNNER_SOURCE_ACTIVATION_CONTROL_ISSUE: '41' }), 99);
  assert.equal(resolveControlEvidenceIssue({ AGENT_RUNNER_SOURCE_ACTIVATION_CONTROL_ISSUE: '41' }), 41);
  assert.equal(resolveControlEvidenceIssue({ AGENT_RUNNER_CONTROL_EVIDENCE_ISSUE: '0' }), CONTROL_EVIDENCE_DEFAULT_ISSUE);
  assert.equal(resolveControlEvidenceIssue({ AGENT_RUNNER_CONTROL_EVIDENCE_ISSUE: 'not-a-number' }), CONTROL_EVIDENCE_DEFAULT_ISSUE);
  assert.equal(resolveControlEvidenceIssue({}), CONTROL_EVIDENCE_DEFAULT_ISSUE);
});

test('runControlEvidence without a separate evidence destination publishes to dedicated default issue', async () => {
  let publishedWith = null;
  const result = await runControlEvidence({
    env: {},
    collectFacts: () => collectControlEvidenceFacts(baseCollectOptions({ env: {} })),
    publish: (args) => { publishedWith = args; return { action: 'created', commentId: 8 }; },
  });
  assert.equal(result.published, true);
  assert.equal(result.publishAction, 'created');
  assert.equal(publishedWith.issueNumber, CONTROL_EVIDENCE_DEFAULT_ISSUE);
});

test('runControlEvidence reuses configured source-activation control issue when present', async () => {
  let publishedWith = null;
  const result = await runControlEvidence({
    env: { AGENT_RUNNER_SOURCE_ACTIVATION_CONTROL_ISSUE: '41' },
    collectFacts: () => collectControlEvidenceFacts(baseCollectOptions()),
    publish: (args) => { publishedWith = args; return { action: 'created', commentId: 9 }; },
  });
  assert.equal(result.published, true);
  assert.equal(result.publishAction, 'created');
  assert.equal(result.publishedCommentId, 9);
  assert.equal(publishedWith.issueNumber, 41);
});
