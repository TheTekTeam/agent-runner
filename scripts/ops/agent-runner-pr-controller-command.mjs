#!/usr/bin/env node
import process from 'node:process';
import { loadProjectRegistry } from './agent-runner-project-registry.mjs';
import { loadLocalExecutorPolicy } from './agent-runner-local-executor-policy.mjs';
import { LocalExecutorStore } from './agent-runner-local-executor.mjs';
import { ValidationEvidenceStore } from './agent-runner-validation-evidence-store.mjs';
import { resolveCurrentManagerAuthority } from './agent-runner-manager-authority.mjs';
import { PrTransactionStore } from './agent-runner-pr-transaction-store.mjs';
import { GhCliPullRequestClient } from './agent-runner-pr-publication.mjs';
import { PrControllerAttemptStore, PrControllerStateStore, runPrControllerSchedulerCycle } from './agent-runner-pr-controller.mjs';

function args(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('invalid arguments');
    parsed[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ['project-registry', 'executor-policy', 'db']) if (!parsed[key]) throw new Error('missing argument');
  return parsed;
}

function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

/** Re-reads live manager authority per request so a superseded packet fails closed at publication time. */
export function createManagerAuthorityCheck(client) {
  return async (request) => {
    const comments = client.request('GET', `/repos/${request.repository}/issues/${request.issueNumber}/comments?per_page=100`);
    if (!Array.isArray(comments)) return false;
    const current = resolveCurrentManagerAuthority(comments).authority;
    return current?.revision === request.managerRevision && current?.fingerprint === request.managerFingerprint;
  };
}

async function main() {
  if (process.getuid?.() === 0) throw Object.assign(new Error('root is not permitted'), { code: 'root-not-permitted' });
  const parsed = args(process.argv.slice(2));
  const limit = parsed.limit ? Number(parsed.limit) : 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('invalid limit'), { code: 'invalid-request' });
  const registry = loadProjectRegistry({ registryPath: parsed['project-registry'] });
  const policy = loadLocalExecutorPolicy({ policyPath: parsed['executor-policy'] });
  const executor = new LocalExecutorStore(parsed.db);
  const evidenceStore = new ValidationEvidenceStore(executor);
  const transactionStore = new PrTransactionStore(parsed.db);
  const controllerStore = new PrControllerStateStore(parsed.db);
  const attemptStore = new PrControllerAttemptStore(parsed.db);
  const client = new GhCliPullRequestClient();
  try {
    const result = await runPrControllerSchedulerCycle({
      attemptStore,
      controllerStore,
      transactionStore,
      evidenceStore,
      registry,
      policy,
      client,
      authorityCheck: createManagerAuthorityCheck(client),
      limit,
    });
    output({ schemaVersion: 1, ok: true, ...result });
  } finally {
    attemptStore.close();
    controllerStore.close();
    transactionStore.close();
    executor.close();
  }
}

main().catch((error) => {
  output({ schemaVersion: 1, ok: false, errorCode: typeof error?.code === 'string' ? error.code : 'pr-controller-cycle-failed' });
  process.exitCode = 1;
});
