import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { MANAGEMENT_EVENT_TYPES } from './agent-runner-management-events.mjs';
import {
  CONTINUATION_KINDS,
  LIFECYCLE_CLASSES,
  SETTLEMENT_SUCCESSOR_HINTS,
} from './agent-runner-manager-lifecycle-settlement.mjs';
import {
  AUTHORITY_ISSUE_OUTCOMES,
  AUTHORITY_LEDGER_STATES,
  QUOTA_ADMISSION_STATES,
} from './agent-runner-manager-worker-authority.mjs';

// #267: the authority/settlement family must stay a pure, provider-neutral,
// project-neutral pair of transitions. It owns no transport, no provider, no
// dispatch, no scheduler and no clock: everything it needs arrives as
// already-validated input, and it returns bounded data rather than performing
// an action.
const AUTHORITY_REVIEW_MODULES = [
  'agent-runner-manager-worker-authority.mjs',
  'agent-runner-manager-settlement-evidence.mjs',
  'agent-runner-manager-lifecycle-settlement.mjs',
];

const FORBIDDEN_SURFACE_PATTERNS = [
  /node:fs/,
  /node:https?/,
  /node:net/,
  /node:child_process/,
  /node:sqlite/,
  /@octokit/,
  /\bfetch\(/,
  /\bspawn(?:Sync)?\(/,
  /\bexecFile(?:Sync)?\(/,
  /\bprocess\.env\b/,
];

// No timer, recurrence, sleep or poll assumption may live in an authority or a
// settlement: when a successor is warranted the event controller decides its
// timing, not this.
const FORBIDDEN_SCHEDULING_PATTERNS = [
  /\bsetTimeout\(/,
  /\bsetInterval\(/,
  /\bsetImmediate\(/,
  /\bhourly\b/i,
  /\brecurrenceInterval\b/,
  /\bsleep\(/i,
  /\bpollFor\b/i,
  /\bcron\b/i,
  /\bsystemd\b/i,
  /\.timer\b/,
];

// Both transitions are pure functions of their inputs. Reading a clock or a
// random source would make replay non-deterministic and could manufacture a
// state transition where nothing actually changed.
const FORBIDDEN_NONDETERMINISM_PATTERNS = [
  /Date\.now\(/,
  /new Date\(/,
  /Math\.random\(/,
  /process\.hrtime/,
  /randomUUID/,
];

const FORBIDDEN_PROJECT_BRANCHING = [
  /['"`]agent-runner['"`]\s*===/,
  /['"`]modelspend['"`]\s*===/,
  /===\s*['"`]agent-runner['"`]/,
  /===\s*['"`]modelspend['"`]/,
  /\bclaude\b/i,
  /\bopenai\b/i,
  /\banthropic\b/i,
  /\bModelSpend\b/,
];

// #289 owns the durable ledger, dedupe, leases, delayed events and wake
// primitives. #267 must not import, re-implement or shadow any of them.
const FORBIDDEN_EVENT_KERNEL_DUPLICATION = [
  // Referring to the kernel in a comment is how the boundary is documented;
  // importing it is what would couple #267 to it.
  /from\s+['"][^'"]*agent-runner-management-events\.mjs['"]/,
  /import\s*\(\s*['"][^'"]*agent-runner-management-events\.mjs['"]/,
  /ManagementEventStore/,
  /enqueueManagementEventAndWake/,
  /recoverDueManagementEvents/,
  /coalesceKey/,
  /claimExpiresAt/,
];

// A monetary token may appear only where it is being *refused* or explained:
// in a comment, in the forbidden-field pattern, or in the refusal message. It
// may never participate in a condition, an assignment or a computation.
const MONETARY_TOKEN_PATTERN = /balance|credit|budget|usd|top[-_]?up|paid|metered/i;

function readModuleSource(fileName) {
  return readFileSync(fileURLToPath(new URL(`./${fileName}`, import.meta.url)), 'utf8');
}

function isRefusalOrExplanationLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('*')
    || trimmed.startsWith('//')
    || trimmed.startsWith('/*')
    || trimmed.startsWith('const FORBIDDEN_FIELD_NAME_PATTERN')
    || trimmed.startsWith('errors.push(');
}

for (const fileName of AUTHORITY_REVIEW_MODULES) {
  test(`${fileName} imports no GitHub, network, filesystem, database or child-process surface`, () => {
    const source = readModuleSource(fileName);
    for (const pattern of FORBIDDEN_SURFACE_PATTERNS) {
      assert.doesNotMatch(source, pattern, `${fileName} must not reference ${pattern}`);
    }
  });

  test(`${fileName} embeds no timer, recurrence, sleep, poll or service assumption`, () => {
    const source = readModuleSource(fileName);
    for (const pattern of FORBIDDEN_SCHEDULING_PATTERNS) {
      assert.doesNotMatch(source, pattern, `${fileName} must not reference ${pattern}`);
    }
  });

  test(`${fileName} reads no clock or random source`, () => {
    const source = readModuleSource(fileName);
    for (const pattern of FORBIDDEN_NONDETERMINISM_PATTERNS) {
      assert.doesNotMatch(source, pattern, `${fileName} must not reference ${pattern}`);
    }
  });

  test(`${fileName} contains no per-project or per-provider branching`, () => {
    const source = readModuleSource(fileName);
    for (const pattern of FORBIDDEN_PROJECT_BRANCHING) {
      assert.doesNotMatch(source, pattern, `${fileName} must not branch on a specific project id or provider name`);
    }
  });

  test(`${fileName} neither imports nor duplicates the #289 management event kernel`, () => {
    const source = readModuleSource(fileName);
    for (const pattern of FORBIDDEN_EVENT_KERNEL_DUPLICATION) {
      assert.doesNotMatch(source, pattern, `${fileName} must leave ${pattern} to agent-runner-management-events.mjs`);
    }
  });

  test(`${fileName} never integrates, closes, deploys, activates source or dispatches a worker`, () => {
    const source = readModuleSource(fileName);
    for (const pattern of [
      /\bmergePullRequest\b/i,
      /\bcloseIssue\b/i,
      /\bdeploy\(/i,
      /\bactivateSource\b/i,
      /\bdispatch\(/i,
      /\brunWorker\b/i,
      /\bstartWorker\b/i,
      /\binvokeProvider\b/i,
      /\bsystemctl\b/i,
    ]) {
      assert.doesNotMatch(source, pattern, `${fileName} must not perform ${pattern}`);
    }
  });

  test(`${fileName} carries no credit, balance, dollar-cap or paid-fallback logic`, () => {
    const source = readModuleSource(fileName);
    const offending = source
      .split('\n')
      .filter((line) => MONETARY_TOKEN_PATTERN.test(line) && !isRefusalOrExplanationLine(line));
    assert.deepEqual(
      offending,
      [],
      `${fileName} may only mention a monetary concept in order to refuse or explain it`,
    );
  });

  test(`${fileName} carries no placeholder or debug leftovers`, () => {
    const source = readModuleSource(fileName);
    assert.doesNotMatch(source, /\b(?:TODO|FIXME|XXX|HACK)\b/);
    assert.doesNotMatch(source, /console\.(?:log|debug|info|warn|error)\(/);
  });
}

test('every successor a settlement can recommend is a real #289 management event type', () => {
  for (const hint of SETTLEMENT_SUCCESSOR_HINTS) {
    if (hint === 'none' || hint === 'delayed-retry') continue;
    assert.ok(
      MANAGEMENT_EVENT_TYPES.includes(hint),
      `successor hint '${hint}' must match a #289 management event type so a later controller can bind it without translation`,
    );
  }
  // A delayed retry is expressed through the kernel's own delayed-event
  // primitive rather than as a distinct settlement-owned event type.
  assert.ok(MANAGEMENT_EVENT_TYPES.includes('delayed-event-ready'));
});

test('no bounded contract value can express an unauthorised mutation', () => {
  const values = [
    ...LIFECYCLE_CLASSES,
    ...SETTLEMENT_SUCCESSOR_HINTS,
    ...CONTINUATION_KINDS,
    ...AUTHORITY_ISSUE_OUTCOMES,
    ...AUTHORITY_LEDGER_STATES,
    ...QUOTA_ADMISSION_STATES,
  ];
  for (const value of values) {
    assert.doesNotMatch(value, /merge|close|deploy|activate|dispatch|label|assign|comment|push/i);
  }
});

test('the settlement lifecycle contract stays exactly the accepted #267 class set', () => {
  assert.deepEqual([...LIFECYCLE_CLASSES], [
    'continue-execution',
    'programme-reconcile',
    'assurance-required',
    'delayed-retry',
    'blocked',
    'owner-attention',
    'no-op',
  ]);
  // A correction is always continued on the already-authorised pull request:
  // there is deliberately no replacement-pull-request continuation kind.
  assert.deepEqual([...CONTINUATION_KINDS], ['same-pull-request']);
});

test('quota headroom is the only admission vocabulary the contract exposes', () => {
  assert.deepEqual([...QUOTA_ADMISSION_STATES], ['available', 'unavailable', 'ambiguous']);
  for (const state of QUOTA_ADMISSION_STATES) {
    assert.doesNotMatch(state, /balance|credit|budget|usd|paid/i);
  }
});
