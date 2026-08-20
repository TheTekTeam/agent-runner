import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// #261: the planner family (evidence, brief, proposal) must never itself
// gain a GitHub, network, provider or filesystem-mutation surface, and must
// never branch per-project by name -- it is provider- and project-neutral,
// parameterized only by the already-validated profile/evidence/brief chain.
const PLANNER_MODULES = [
  'agent-runner-manager-planner-safety.mjs',
  'agent-runner-manager-project-evidence.mjs',
  'agent-runner-manager-project-brief.mjs',
  'agent-runner-manager-plan-proposal.mjs',
];

const FORBIDDEN_IMPORT_PATTERNS = [
  /node:fs/,
  /node:https?/,
  /node:child_process/,
  /@octokit/,
  /\bfetch\(/,
];

const FORBIDDEN_PROJECT_BRANCHING = [
  /['"`]agent-runner['"`]\s*===/,
  /['"`]modelspend['"`]\s*===/,
  /===\s*['"`]agent-runner['"`]/,
  /===\s*['"`]modelspend['"`]/,
  /\bclaude\b/i,
];

function readPlannerSource(fileName) {
  const url = new URL(`./${fileName}`, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}

for (const fileName of PLANNER_MODULES) {
  test(`${fileName} imports no GitHub/network/filesystem/child-process surface`, () => {
    const source = readPlannerSource(fileName);
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
      assert.doesNotMatch(source, pattern, `${fileName} must not reference ${pattern}`);
    }
  });

  test(`${fileName} contains no per-project or per-provider branching`, () => {
    const source = readPlannerSource(fileName);
    for (const pattern of FORBIDDEN_PROJECT_BRANCHING) {
      assert.doesNotMatch(source, pattern, `${fileName} must not branch on a specific project id or provider name`);
    }
  });
}
