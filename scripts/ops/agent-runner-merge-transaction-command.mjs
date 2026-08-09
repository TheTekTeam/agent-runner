#!/usr/bin/env node
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { loadProjectRegistry, projectFromRegistryById } from './agent-runner-project-registry.mjs';
import { loadLocalExecutorPolicy } from './agent-runner-local-executor-policy.mjs';
import { LocalExecutorStore } from './agent-runner-local-executor.mjs';
import { ValidationEvidenceStore } from './agent-runner-validation-evidence-store.mjs';
import { validationProfileContractSha256 } from './agent-runner-validation-profile-contract.mjs';
import { resolveCurrentManagerAuthority } from './agent-runner-manager-authority.mjs';
import { normalizeMergeDecisionRequest } from './agent-runner-merge-policy.mjs';
import { MergeTransactionStore } from './agent-runner-merge-transaction-store.mjs';
import { GhCliMergeClient, executeMergeTransaction, observePostMergeSettlement } from './agent-runner-merge-transaction.mjs';
import { GhCliGitHubReadClient } from './agent-runner-github-checks-provider.mjs';

function args(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('invalid arguments');
    parsed[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ['project-registry', 'executor-policy', 'db', 'request-file']) if (!parsed[key]) throw new Error('missing argument');
  return parsed;
}

function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

/** Re-reads live manager authority per request so a superseded packet fails closed at merge time. */
function createManagerAuthorityCheck(client) {
  return async (request) => {
    const comments = client.request('GET', `/repos/${request.repository}/issues/${request.issueNumber}/comments?per_page=100`);
    if (!Array.isArray(comments)) return false;
    const current = resolveCurrentManagerAuthority(comments).authority;
    return current?.revision === request.managerRevision && current?.fingerprint === request.managerFingerprint;
  };
}

async function main() {
  if (process.getuid?.() === 0) throw Object.assign(new Error('root is not permitted'), { code: 'root-not-permitted' });
  const a = args(process.argv.slice(2));
  // The request file is machine-local input (constructed by the runner from durable evidence),
  // never derived from repository content, so a permissive repository cannot widen eligibility.
  const request = normalizeMergeDecisionRequest(JSON.parse(readFileSync(a['request-file'], 'utf8')));
  const registry = loadProjectRegistry({ registryPath: a['project-registry'] });
  const project = projectFromRegistryById(registry, request.projectId);
  if (!project || project.githubRepo.toLowerCase() !== request.repository.toLowerCase()) {
    throw Object.assign(new Error('project mismatch'), { code: 'repository-mismatch' });
  }
  const policy = loadLocalExecutorPolicy({ policyPath: a['executor-policy'] });
  const executor = new LocalExecutorStore(a.db);
  const evidenceStore = new ValidationEvidenceStore(executor);
  const store = new MergeTransactionStore(a.db);
  const client = new GhCliMergeClient();
  const checksClient = new GhCliGitHubReadClient();
  try {
    const profileContracts = Object.fromEntries(
      request.requiredValidationProfiles.map((x) => [x.profile, validationProfileContractSha256(policy, request.projectId, x.profile)]),
    );
    const authorityCheck = createManagerAuthorityCheck(client);
    const result = await executeMergeTransaction({
      request, store, client, checksClient, evidenceStore, profileContracts, authorityCheck,
    });
    const settlement = await observePostMergeSettlement({ transactionId: result.transactionId, store, checksClient });
    output({
      schemaVersion: 1, ok: true, prNumber: result.prNumber, mergeCommitSha: result.mergeCommitSha,
      headSha: result.headSha, replayed: result.replayed === true,
      settlementStatus: settlement?.settlementStatus ?? null, settlementReasonCode: settlement?.settlementReasonCode ?? null,
    });
  } finally {
    store.close();
    executor.close();
  }
}

main().catch((error) => {
  output({ schemaVersion: 1, ok: false, errorCode: typeof error?.code === 'string' ? error.code : 'merge-transaction-failed' });
  process.exitCode = 1;
});
