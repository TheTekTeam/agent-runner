import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const workflowPath = resolve(root, '.github/workflows/validate-z790.yml');
const canonicalPath = resolve(root, '.github/workflows/validate.yml');

function workflow(path) {
  return readFileSync(path, 'utf8');
}

test('Z790 field workflow is manual, read-only and positively capability-bound', () => {
  const source = workflow(workflowPath);
  assert.match(source, /workflow_dispatch:/);
  assert.doesNotMatch(source, /pull_request:/);
  assert.doesNotMatch(source, /\n\s+push:/);
  assert.match(source, /permissions:\n\s+contents: read/);
  assert.match(source, /- self-hosted\n\s+- dev-cluster-z790\n\s+- build-worker/);
  assert.match(source, /npm run validate/);
});

test('Z790 workflow has no control-plane, deployment or mutation authority', () => {
  const source = workflow(workflowPath);
  for (const forbidden of [
    'issues: write',
    'pull-requests: write',
    'actions: write',
    'deployments: write',
    'packages: write',
    'contents: write',
    'gh issue',
    'gh pr merge',
    'systemctl',
    'agent-runner-event',
    'claude-runner-cron',
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden Z790 authority: ${forbidden}`);
  }
});

test('canonical validation remains on Dell until Z790 field acceptance', () => {
  const source = workflow(canonicalPath);
  assert.match(source, /- self-hosted\n\s+- dev-cluster-dell/);
  assert.doesNotMatch(source, /dev-cluster-z790/);
});
