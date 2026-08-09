#!/usr/bin/env node
import process from 'node:process';
import { loadProjectRegistry, projectFromRegistryById } from './agent-runner-project-registry.mjs';
import { MergeTransactionStore } from './agent-runner-merge-transaction-store.mjs';
import { IssueReconciliationStore } from './agent-runner-issue-reconciliation-store.mjs';
import {
  GhCliReconciliationClient, normalizeReconciliationRequest, reconcileMergedIssue, deleteMergedRemoteBranch,
} from './agent-runner-issue-reconciliation.mjs';
import { executeGuardedWorkspaceCleanup } from './agent-runner-reconcile-workspace.mjs';

function args(argv) {
  const parsed = { deleteRemoteBranch: false, cleanupLocal: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--delete-remote-branch') { parsed.deleteRemoteBranch = true; continue; }
    if (key === '--cleanup-local') { parsed.cleanupLocal = true; continue; }
    if (!key?.startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('invalid arguments');
    parsed[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  for (const key of ['project-registry', 'merge-db', 'reconciliation-db', 'transaction-id']) {
    if (!parsed[key]) throw new Error('missing argument');
  }
  if (parsed.cleanupLocal) {
    for (const key of ['attempt-id', 'branch', 'worktree', 'state-db', 'local-repo-path']) {
      if (!parsed[key]) throw new Error('--cleanup-local requires --attempt-id, --branch, --worktree, --state-db and --local-repo-path');
    }
  }
  return parsed;
}

function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function main() {
  if (process.getuid?.() === 0) throw Object.assign(new Error('root is not permitted'), { code: 'root-not-permitted' });
  const a = args(process.argv.slice(2));
  const registry = loadProjectRegistry({ registryPath: a['project-registry'] });
  const mergeStore = new MergeTransactionStore(a['merge-db']);
  const reconciliationStore = new IssueReconciliationStore(a['reconciliation-db']);
  const client = new GhCliReconciliationClient();
  try {
    const mergeTransaction = mergeStore.getTransaction(a['transaction-id']);
    if (!mergeTransaction) throw Object.assign(new Error('merge transaction not found'), { code: 'merge-not-settled' });
    const project = projectFromRegistryById(registry, mergeTransaction.projectId);
    if (!project || project.githubRepo.toLowerCase() !== mergeTransaction.repository.toLowerCase()) {
      throw Object.assign(new Error('project mismatch'), { code: 'repository-mismatch' });
    }
    const request = normalizeReconciliationRequest(mergeTransaction);
    const reconciliation = await reconcileMergedIssue({ request, store: reconciliationStore, client });

    let remoteBranch = null;
    if (a.deleteRemoteBranch) {
      remoteBranch = await deleteMergedRemoteBranch({ request, store: reconciliationStore, client });
    }

    let localCleanup = null;
    if (a.cleanupLocal) {
      if (a.branch !== request.sourceBranch) {
        throw Object.assign(new Error('local cleanup branch does not match the completed attempt'), { code: 'workspace-identity-mismatch' });
      }
      localCleanup = await executeGuardedWorkspaceCleanup({
        repo: request.repository, issueNumber: request.issueNumber, attemptId: a['attempt-id'],
        branch: a.branch, worktree: a.worktree, dbPath: a['state-db'], localRepoPath: a['local-repo-path'],
      });
    }

    output({
      schemaVersion: 1, ok: true, transactionId: reconciliation.transactionId, issueNumber: reconciliation.issueNumber,
      closed: reconciliation.closed, replayed: reconciliation.replayed === true,
      remoteBranchDeleted: remoteBranch ? remoteBranch.deleted === true : null,
      localCleanupExecuted: localCleanup ? localCleanup.executed === true : null,
    });
  } finally {
    reconciliationStore.close();
    mergeStore.close();
  }
}

main().catch((error) => {
  output({ schemaVersion: 1, ok: false, errorCode: typeof error?.code === 'string' ? error.code : 'reconciliation-failed' });
  process.exitCode = 1;
});
