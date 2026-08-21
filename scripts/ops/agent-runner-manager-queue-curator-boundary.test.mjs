import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { MANAGEMENT_EVENT_TYPES } from './agent-runner-management-events.mjs';
import { QUEUE_CURATION_SUCCESSOR_HINTS } from './agent-runner-manager-queue-curator.mjs';
import { QUEUE_MUTATION_KINDS } from './agent-runner-manager-queue-mutation.mjs';

// #266: the queue-curation family must stay a pure, provider-neutral,
// project-neutral transition. It owns no transport, no provider, no dispatch,
// no scheduler and no clock: everything it needs arrives as already-validated
// input, and every write leaves through the injected mutation port.
const QUEUE_CURATION_MODULES = [
  'agent-runner-manager-queue-evidence.mjs',
  'agent-runner-manager-queue-curator.mjs',
  'agent-runner-manager-queue-mutation.mjs',
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

// No timer, recurrence, sleep or poll assumption may live in a curation: when
// a successor is warranted the event controller decides its timing, not this.
const FORBIDDEN_SCHEDULING_PATTERNS = [
  /\bsetTimeout\(/,
  /\bsetInterval\(/,
  /\bsetImmediate\(/,
  /\bhourly\b/i,
  /\brecurrenceInterval\b/,
  /\bsleep\(/i,
  /\bpollFor\b/i,
];

// A curation is a pure function of its inputs. Reading a clock or a random
// source would make replay non-deterministic and could manufacture a state
// transition where nothing actually changed.
const FORBIDDEN_NONDETERMINISM_PATTERNS = [
  /Date\.now\(/,
  /new Date\(/,
  /Math\.random\(/,
  /process\.hrtime/,
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
// primitives. #266 must not import, re-implement or shadow any of them.
const FORBIDDEN_EVENT_KERNEL_DUPLICATION = [
  // Referring to the kernel in a comment is how the boundary is documented;
  // importing it is what would couple #266 to it.
  /from\s+['"][^'"]*agent-runner-management-events\.mjs['"]/,
  /import\s*\(\s*['"][^'"]*agent-runner-management-events\.mjs['"]/,
  /ManagementEventStore/,
  /enqueueManagementEventAndWake/,
  /recoverDueManagementEvents/,
  /coalesceKey/,
  /claimExpiresAt/,
];

function readModuleSource(fileName) {
  return readFileSync(fileURLToPath(new URL(`./${fileName}`, import.meta.url)), 'utf8');
}

for (const fileName of QUEUE_CURATION_MODULES) {
  test(`${fileName} imports no GitHub, network, filesystem, database or child-process surface`, () => {
    const source = readModuleSource(fileName);
    for (const pattern of FORBIDDEN_SURFACE_PATTERNS) {
      assert.doesNotMatch(source, pattern, `${fileName} must not reference ${pattern}`);
    }
  });

  test(`${fileName} embeds no timer, recurrence, sleep or poll assumption`, () => {
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

  test(`${fileName} carries no placeholder or debug leftovers`, () => {
    const source = readModuleSource(fileName);
    assert.doesNotMatch(source, /\b(?:TODO|FIXME|XXX|HACK)\b/);
    assert.doesNotMatch(source, /console\.(?:log|debug|info|warn|error)\(/);
  });
}

test('every successor a curation can recommend is a real #289 management event type', () => {
  for (const hint of QUEUE_CURATION_SUCCESSOR_HINTS) {
    if (hint === 'none' || hint === 'delayed-retry') continue;
    assert.ok(
      MANAGEMENT_EVENT_TYPES.includes(hint),
      `successor hint '${hint}' must match a #289 management event type so a later controller can bind it without translation`,
    );
  }
  // A delayed retry is expressed through the kernel's own delayed-event
  // primitive rather than as a distinct curation-owned event type.
  assert.ok(MANAGEMENT_EVENT_TYPES.includes('delayed-event-ready'));
});

test('the mutation allowlist can never reach merge, close, deploy or source activation', () => {
  assert.deepEqual([...QUEUE_MUTATION_KINDS], ['create-issue', 'update-labels', 'update-dependencies']);
  for (const kind of QUEUE_MUTATION_KINDS) {
    assert.doesNotMatch(kind, /merge|close|deploy|activate|dispatch|assign|comment/);
  }
});
