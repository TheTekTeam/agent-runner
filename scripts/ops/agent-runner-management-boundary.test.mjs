import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  FORBIDDEN_MANAGEMENT_CAPABILITIES,
  MANAGEMENT_CAPABILITIES,
  ROLE_BY_EVENT_TYPE,
} from './agent-runner-management-control-mode.mjs';
import { MANAGEMENT_EVENT_PRODUCERS } from './agent-runner-management-producers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

/**
 * #268: the event-driven management control plane must stay one durable,
 * project-neutral, event-driven graph. These assertions are structural: they
 * read the shipped source so a future change cannot quietly reintroduce a
 * clock, a second mutation authority, a project-specific branch or a mutating
 * auditor.
 */
const RUNTIME_MODULES = [
  'agent-runner-management-control-mode.mjs',
  'agent-runner-management-control-store.mjs',
  'agent-runner-management-status-projection.mjs',
  'agent-runner-management-role-result.mjs',
  'agent-runner-management-programme-role.mjs',
  'agent-runner-management-execution-role.mjs',
  'agent-runner-management-assurance-role.mjs',
  'agent-runner-management-controller.mjs',
  'agent-runner-management-producers.mjs',
  'agent-runner-management-field-acceptance.mjs',
  'agent-runner-management-cutover.mjs',
  'agent-runner-management-control-command.mjs',
  'agent-runner-management-plan-registry.mjs',
  'agent-runner-management-collectors.mjs',
  'agent-runner-management-observer.mjs',
  'agent-runner-management-cycle-command.mjs',
  'agent-runner-management-publication.mjs',
];

/**
 * The production wiring modules that legitimately reach the outside world.
 * They are exempt from the no-I/O rule but from nothing else.
 */
const PRODUCTION_IO_MODULES = new Set([
  'agent-runner-management-dell-adapters.mjs',
  'agent-runner-management-write-adapters.mjs',
  'agent-runner-management-wake.mjs',
]);

const ROLE_MODULES = [
  'agent-runner-management-programme-role.mjs',
  'agent-runner-management-execution-role.mjs',
  'agent-runner-management-assurance-role.mjs',
];

function source(name) {
  return readFileSync(join(__dirname, name), 'utf8');
}

/** Import specifiers only, so prose in a comment never trips an import assertion. */
function importsOf(name) {
  return [...source(name).matchAll(/^import[\s\S]*?from '([^']+)';$/gm)].map((match) => match[1]);
}

/** Source with comments stripped, so a design note can describe what the code must not do. */
function code(name) {
  return source(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('the read-only assurance role imports no mutation-capable module', () => {
  const forbidden = [
    'agent-runner-manager-queue-mutation.mjs',
    'agent-runner-manager-worker-authority.mjs',
    'agent-runner-manager-lifecycle-settlement.mjs',
    'agent-runner-manager-queue-curator.mjs',
    'agent-runner-source-activation.mjs',
    'agent-runner-merge-transaction.mjs',
    'agent-runner-merge-policy.mjs',
  ];
  const imported = importsOf('agent-runner-management-assurance-role.mjs');
  for (const module of forbidden) {
    assert.ok(
      !imported.some((specifier) => specifier.endsWith(module)),
      `assurance must not import ${module}: there must be no mutation function in its scope to call`,
    );
  }
});

test('no management role imports merge, close, deployment or source-activation surfaces', () => {
  for (const name of [...ROLE_MODULES, 'agent-runner-management-controller.mjs']) {
    const imported = importsOf(name);
    for (const module of ['agent-runner-source-activation', 'agent-runner-merge-transaction', 'agent-runner-merge-policy', 'agent-runner-issue-reconciliation']) {
      assert.ok(!imported.some((specifier) => specifier.includes(module)), `${name} must not import ${module}`);
    }
  }
});

test('the execution role cannot reach queue curation or worker-authority issuance', () => {
  const imported = importsOf('agent-runner-management-execution-role.mjs');
  assert.ok(!imported.some((specifier) => specifier.endsWith('agent-runner-manager-queue-mutation.mjs')));
  assert.ok(!imported.some((specifier) => specifier.endsWith('agent-runner-manager-queue-curator.mjs')));
  // It may reference the authority *shape* validator, but never the issuer.
  assert.ok(!/issueManagerWorkerAuthority/.test(code('agent-runner-management-execution-role.mjs')));
});

test('the programme role never consumes the authority it issues', () => {
  const programme = code('agent-runner-management-programme-role.mjs');
  assert.ok(!/authorizeWorkerAuthorityConsumption/.test(programme));
  assert.ok(!/AUTHORITY_CONSUMER_DOMAIN/.test(programme));
});

test('no management module contains a timer, interval, cron or recurrence', () => {
  const patterns = [
    /\bsetInterval\(/,
    /\bsetTimeout\(/,
    /\bsetImmediate\(/,
    /\bOnCalendar\b/,
    /\bOnUnitActiveSec\b/,
    /\bOnUnitInactiveSec\b/,
    /\brecurrenceInterval\b/,
    /\bcronExpression\b/,
    /\bhourly\b/i,
    /\bdaily\b/i,
  ];
  for (const name of RUNTIME_MODULES) {
    const body = code(name);
    for (const pattern of patterns) {
      assert.ok(!pattern.test(body), `${name} must not contain ${pattern}: events advance work, clocks do not`);
    }
  }
});

test('no new systemd unit or timer is introduced for a management role', () => {
  const units = readdirSync(join(REPO_ROOT, 'systemd'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  for (const unit of units) {
    assert.ok(
      !/programme|execution-manager|assurance|queue-oversight|build-manager/i.test(unit),
      `a role-specific management unit must not exist: ${unit}`,
    );
  }
});

test('no management module branches on a specific project or repository', () => {
  const patterns = [
    /['"`]agent-runner['"`]\s*===/,
    /===\s*['"`]agent-runner['"`]/,
    /['"`]modelspend['"`]\s*===/,
    /===\s*['"`]modelspend['"`]/,
    /projectId\s*===\s*['"`][a-z]/,
  ];
  for (const name of RUNTIME_MODULES) {
    const body = code(name);
    for (const pattern of patterns) {
      assert.ok(!pattern.test(body), `${name} must stay project-neutral (matched ${pattern})`);
    }
  }
});

test('no management module admits on credit, balance, a dollar cap or a paid fallback', () => {
  // Property accesses and identifiers, not the bounded finding-class *names*
  // the auditor uses to report such a violation.
  const patterns = [
    /\.\s*balance\b/,
    /\.\s*credits?\b/,
    /\.\s*accountCredit\b/,
    /\bmaxBudgetUsd\b/,
    /\bbudgetUsd\b/,
    /\bautoTopUp\b/,
    /\bpaidFallback\b/,
    /\bapiFallback\b/,
    /\bmeteredFallback\b/,
  ];
  for (const name of RUNTIME_MODULES) {
    const body = code(name);
    for (const pattern of patterns) {
      assert.ok(!pattern.test(body), `${name} must admit on quota headroom only (matched ${pattern})`);
    }
  }
});

test('no management module widens the one global implementation slot', () => {
  for (const name of RUNTIME_MODULES) {
    const body = code(name);
    assert.ok(!/\bmaxConcurrentImplementations\b/.test(body), name);
    assert.ok(!/\bconcurrencyLimit\b/.test(body), name);
    assert.ok(!/\bparallelWorkers\b/.test(body), name);
  }
});

test('no management module carries a TODO, FIXME, HACK or debug logging', () => {
  for (const name of RUNTIME_MODULES) {
    const body = source(name);
    assert.ok(!/\b(?:TODO|FIXME|HACK|XXX)\b/.test(body), `${name} must not carry an unfinished marker`);
    assert.ok(!/\bconsole\.(?:log|debug|info|warn|error)\(/.test(code(name)), `${name} must not write unrestricted logs`);
  }
});

test('the capability allowlist and the forbidden list stay disjoint and complete', () => {
  for (const capability of MANAGEMENT_CAPABILITIES) {
    assert.ok(!FORBIDDEN_MANAGEMENT_CAPABILITIES.includes(capability), capability);
  }
  for (const forbidden of ['merge', 'closeIssue', 'deploy', 'activateSource', 'dispatchWorker', 'consumeWorkerAuthority', 'enableTimer', 'disableTimer', 'restartService']) {
    assert.ok(FORBIDDEN_MANAGEMENT_CAPABILITIES.includes(forbidden), `${forbidden} must be refused by name`);
  }
});

test('exactly three roles are dispatchable and only programme owns mutation', () => {
  assert.deepEqual(Object.values(ROLE_BY_EVENT_TYPE).sort(), ['assurance', 'execution', 'programme']);
  const controlMode = code('agent-runner-management-control-mode.mjs');
  // The matrix literal is the single place a mutating capability is granted.
  assert.match(controlMode, /programme:\s*freezeArray\(\['collectEvidence', 'applyQueueMutation', 'publishWorkerAuthority'\]\)/);
  assert.match(controlMode, /assurance:\s*freezeArray\(\['collectEvidence'\]\)/);
});

test('a producer may wake the manager but can never author a decision', () => {
  const producers = code('agent-runner-management-producers.mjs');
  // Producers only ever hand the ledger an event; they never run a role.
  assert.ok(!/runProgrammeReconciliation|runExecutionReconciliation|runQueueAssurance/.test(producers));
  assert.ok(!/issueManagerWorkerAuthority|applyQueueMutationTransaction|authorizeManagerContinuation/.test(producers));
  // And every event they can raise is one of the three reconciliation types.
  for (const eventType of Object.values(MANAGEMENT_EVENT_PRODUCERS)) {
    assert.ok(Object.keys(ROLE_BY_EVENT_TYPE).includes(eventType), eventType);
  }
});

test('the cutover tooling can never disable an external scheduled management task', () => {
  const cutover = code('agent-runner-management-cutover.mjs');
  const command = code('agent-runner-management-control-command.mjs');
  for (const body of [cutover, command]) {
    assert.ok(!/\bsystemctl\b/.test(body));
    assert.ok(!/\bspawn(?:Sync)?\(/.test(body));
    assert.ok(!/\bexecFile(?:Sync)?\(/.test(body));
    assert.ok(!/\bdisableTask\b/.test(body));
  }
  assert.match(cutover, /externalScheduledTasksRetiredByThisRepository: false/);
});

test('the field-acceptance probes are read-only', () => {
  const body = code('agent-runner-management-field-acceptance.mjs');
  assert.ok(!/\bsetControlMode\(/.test(body), 'a probe must never change the control mode');
  assert.ok(!/\bacquireManagerLock\(/.test(body));
  assert.ok(!/\brecordDecision\(|\brecordProjection\(|\brecordFinding\(|\brecordObservation\(/.test(body));
  assert.ok(!/\benqueue\(/.test(body));
  assert.ok(!/\bsettle\(/.test(body));
});

test('the role modules never read a clock or a random source', () => {
  // Every role transition is a deterministic function of its inputs, so replay
  // and comparison against the current management behaviour stay meaningful.
  for (const name of ROLE_MODULES) {
    const body = code(name);
    assert.ok(!/Date\.now\(/.test(body), name);
    assert.ok(!/new Date\(\)/.test(body), name);
    assert.ok(!/Math\.random\(/.test(body), name);
    assert.ok(!/process\.hrtime/.test(body), name);
  }
});

test('the role modules perform no I/O of their own', () => {
  for (const name of ROLE_MODULES) {
    const imported = importsOf(name);
    for (const forbidden of ['node:fs', 'node:https', 'node:http', 'node:net', 'node:child_process', 'node:sqlite', '@octokit']) {
      assert.ok(!imported.includes(forbidden), `${name} must not import ${forbidden}`);
    }
    assert.ok(!/\bfetch\(/.test(code(name)), name);
    assert.ok(!/process\.env\b/.test(code(name)), name);
  }
});

test('the production wiring introduces no new unit, timer or scheduler', () => {
  const units = readdirSync(join(REPO_ROOT, 'systemd'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  // The management cycle runs from the one pre-existing generic polling unit.
  assert.ok(units.includes('agent-runner-event-polling.service'));
  assert.equal(units.filter((unit) => unit.endsWith('.timer')).length, 2, 'no management timer may be added');
  const polling = readFileSync(join(REPO_ROOT, 'systemd/user/agent-runner-event-polling.service'), 'utf8');
  assert.match(polling, /agent-runner-management-cycle-command\.mjs/, 'the management cycle must run from the generic polling unit');
  // A management refusal must never fail the generic cycle it shares.
  assert.match(polling, /ExecStart=-\/usr\/bin\/env node .*agent-runner-management-cycle-command\.mjs/);
});

test('the production entrypoint and observer contain no loop, sleep or schedule of their own', () => {
  for (const name of ['agent-runner-management-cycle-command.mjs', 'agent-runner-management-observer.mjs']) {
    const body = code(name);
    assert.ok(!/\bwhile\s*\(true\)/.test(body), name);
    assert.ok(!/\bsleep\b/i.test(body), name);
    assert.ok(!/\bsetInterval\(/.test(body), name);
  }
});

test('only the two declared production wiring modules perform I/O', () => {
  for (const name of RUNTIME_MODULES) {
    if (PRODUCTION_IO_MODULES.has(name)) continue;
    const imported = importsOf(name);
    for (const forbidden of ['node:child_process', 'node:https', 'node:http', 'node:net']) {
      assert.ok(!imported.includes(forbidden), `${name} must not import ${forbidden}`);
    }
  }
});

test('the wake can only ever start an allowlisted generic unit', () => {
  const body = code('agent-runner-management-wake.mjs');
  // One spawn, one verb, and the unit is checked against the allowlist first.
  assert.match(body, /ALLOWED_WAKE_UNITS\.includes\(unit\)/);
  assert.match(body, /'--user', 'start', '--no-block', unit/);
  assert.ok(!/\benable\b/.test(body), 'a wake must never enable a unit');
  assert.ok(!/\bdisable\b/.test(body), 'a wake must never disable a unit');
  assert.ok(!/\bstop\b/.test(body), 'a wake must never stop a unit');
});

test('the production collectors never publish an authority the ledger did not record', () => {
  const body = code('agent-runner-management-collectors.mjs');
  // Reconstruction is gated on a persisted ledger entry, and publication
  // records the grant before announcing it.
  assert.match(body, /recordIssuedAuthority\(/);
  assert.match(body, /listIssuedAuthorities\(/);
  assert.ok(!/\bmerge\(|\bcloseIssue\(|\bactivateSource\(/.test(body));
});

test('the Dell adapters read only and never mutate a repository or a service', () => {
  const body = code('agent-runner-management-dell-adapters.mjs');
  assert.ok(!/\bsystemctl\b/.test(body), 'an adapter must never touch a unit');
  assert.ok(!/--method',\s*'(?:POST|PATCH|PUT|DELETE)/.test(body), 'GitHub REST adapters are read-only');
  assert.ok(!/\bgit',\s*\['(?:push|commit|merge|checkout|reset|clean)/.test(body), 'git adapters are read-only');
  // The one GraphQL call is transported over POST, as every GraphQL request is.
  // What matters is that the document itself is a read: a `mutation` operation
  // must never appear.
  const graphql = /const query = '([^']*)'/.exec(body);
  assert.ok(graphql, 'the GraphQL document must be a single inspectable literal');
  assert.match(graphql[1], /^query\(/, 'the GraphQL document must be a query');
  assert.ok(!/\bmutation\s*[({]/.test(body), 'no GraphQL mutation may be issued');
});

test('the exact-head review contract cannot be satisfied by a stale or absent review', () => {
  const body = code('agent-runner-management-dell-adapters.mjs');
  // Reviews are filtered to the exact head before any state is derived, and the
  // unreliable pull-request review-decision field is not consulted at all.
  assert.match(body, /commit_id[\s\S]{0,80}toLowerCase\(\) === headSha/);
  assert.ok(!/review_decision/.test(body), 'the unreliable review-decision field must not be used');
  assert.ok(!/reviewDecision/.test(body), 'the unreliable review-decision field must not be used');
});

test('the implementation slot is a tri-state that never fails open', () => {
  const adapters = code('agent-runner-management-dell-adapters.mjs');
  // Only a genuinely absent lock is free; every other read failure is ambiguous.
  assert.match(adapters, /error\.code === 'ENOENT'/);
  assert.match(adapters, /state: 'ambiguous'[\s\S]{0,120}lock-unreadable/);
  assert.match(adapters, /state: 'ambiguous'[\s\S]{0,120}lock-malformed/);
  // And ambiguity blocks a new authority rather than admitting one.
  const programme = code('agent-runner-management-programme-role.mjs');
  assert.match(programme, /slotState === 'ambiguous'/);
  assert.match(programme, /implementation-slot-ambiguous/);
});

test('an execution wake can never be resolved to an arbitrary ledger authority', () => {
  const body = code('agent-runner-management-collectors.mjs');
  // Exact issue identity is required, a duplicate live grant is refused, and
  // the authority is rebuilt from its pinned issuance inputs rather than guessed.
  assert.match(body, /ambiguous-attempt-identity/);
  assert.match(body, /live\.length > 1/);
  assert.match(body, /rebuildAuthorityFromSnapshot/);
  assert.match(body, /attempt-identity-mismatch/);
});

test('the production write transport is a positive allowlist with no forbidden capability', () => {
  const body = code('agent-runner-management-write-adapters.mjs');
  // Exactly three exported surfaces, and none of them can close, merge, deploy,
  // activate source, dispatch a worker or touch a unit.
  assert.match(body, /createQueueMutationClient\(/);
  assert.match(body, /listIssueComments\(/);
  assert.match(body, /createIssueComment\(/);
  for (const forbidden of ['closeIssue', 'mergePullRequest', 'activateSource', 'dispatchWorker', 'enableTimer', 'restartService']) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(body), `the write transport must not expose ${forbidden}`);
  }
  assert.ok(!/\bsystemctl\b/.test(body), 'the write transport must never touch a unit');
  // An issue is never closed: no state/state_reason payload is ever built.
  assert.ok(!/state_reason/.test(body));
  assert.ok(!/state:\s*'closed'/.test(body));
  // Every endpoint is checked against the exact declared repository.
  assert.match(body, /does not target the declared repository/);
});

test('the write transport is only reachable in active mode and never by assurance', () => {
  const collectors = code('agent-runner-management-collectors.mjs');
  // The read adapter surface carries no write entry at all.
  assert.match(collectors, /export const OPTIONAL_ADAPTERS = Object\.freeze\(\[\]\)/);
  // Write ports are constructed only under the mutating branch.
  assert.match(collectors, /if \(mutating\) \{\s*\n\s*assertWriteAdapters\(writeAdapters\);/);
  // Assurance returns before any write port could be constructed.
  const assuranceBranch = collectors.indexOf("if (role === 'assurance')");
  const firstWritePort = collectors.indexOf('ports.applyQueueMutation');
  assert.ok(assuranceBranch > 0 && firstWritePort > assuranceBranch, 'assurance must return before any write port exists');

  const cycle = code('agent-runner-management-cycle-command.mjs');
  // The cycle hands the transport on only when the persisted mode is mutating.
  assert.match(cycle, /const activeWriteAdapters = resolvedMode\.mutating \? writeAdapters : null;/);
  assert.match(cycle, /refusal: 'write-transport-unavailable'/);
});

test('publication is reconciled rather than fire-and-forget', () => {
  const body = code('agent-runner-management-publication.mjs');
  // Intent first, re-read before posting, verify after posting, confirm last.
  // Scoped to the reconciliation itself so the type guard's mention of the same
  // method name earlier in the file cannot satisfy the ordering.
  const start = body.indexOf('function ensurePublished(');
  assert.ok(start > 0, 'the reconciliation must be one inspectable function');
  const reconciliation = body.slice(start);
  const intent = reconciliation.indexOf('recordPublicationIntent(');
  const firstRead = reconciliation.indexOf('transport.listIssueComments');
  const post = reconciliation.indexOf('transport.createIssueComment');
  assert.ok(intent > 0 && intent < firstRead, 'the intent must be persisted before any read');
  assert.ok(firstRead < post, 'comments must be re-read before posting');
  assert.ok(reconciliation.indexOf('transport.listIssueComments', post) > post, 'the post must be verified by re-reading');
  // A conflicting immutable body is never overwritten.
  assert.match(body, /state: 'conflict'/);
  assert.ok(!/updateComment|editComment|deleteComment/.test(body));
});

test('the manager never consumes or dispatches the authority it publishes', () => {
  for (const name of ['agent-runner-management-publication.mjs', 'agent-runner-management-collectors.mjs']) {
    const body = code(name);
    assert.ok(!/authorizeWorkerAuthorityConsumption/.test(body), name);
    assert.ok(!/resolveDispatchAuthority/.test(body), name);
    assert.ok(!/runner-started|claimAuthority/.test(body), name);
  }
});

test('no management module persists a machine-local path or a claim token', () => {
  for (const name of RUNTIME_MODULES) {
    const body = code(name);
    assert.ok(!/\bworktreePath\b/.test(body), name);
    assert.ok(!/\blocalRepoPath\b/.test(body), name);
    // The two CLI entrypoints resolve the default XDG state path at runtime;
    // that is a location, never persisted management state.
    const isEntrypoint = name === 'agent-runner-management-control-command.mjs'
      || name === 'agent-runner-management-cycle-command.mjs';
    assert.ok(!/\bhomedir\(\)\s*,\s*['"]\.\w/.test(body) || isEntrypoint, name);
  }
  // The one place a claim token is handled hashes it rather than storing it.
  const store = code('agent-runner-management-control-store.mjs');
  assert.match(store, /holder_hash/);
  assert.ok(!/holder\s*TEXT/.test(store), 'a raw holder identity must never be a column');
});
