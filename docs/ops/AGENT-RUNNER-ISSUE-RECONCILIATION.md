# Agent Runner post-merge issue reconciliation and cleanup

`npm run reconcile:issue -- --project-registry REGISTRY --merge-db MERGE.sqlite --reconciliation-db RECONCILE.sqlite --transaction-id TX [--delete-remote-branch] [--cleanup-local --attempt-id ID --branch NAME --worktree PATH --state-db STATE.sqlite --local-repo-path PATH]` reconciles GitHub issue metadata after a settled merge (#155) and, only when explicitly requested, retires the exact merged branch/worktree owned by the completed attempt (#156).

## Input

The sole evidence source is a `completed` `MergeTransactionStore` row whose post-merge settlement already recorded `succeeded` (`settlementStatus`). No other claim of "this merged" is accepted.

## Default-deny issue reconciliation

Before any GitHub write, `evaluateIssueReconciliationEligibility` re-reads the live issue, PR, source-branch ref and open pull requests and refuses (leaving the issue untouched) on:

- the PR is not merged, or its head/merge-commit/base no longer match the merge transaction exactly;
- the PR is not clearly linked to the issue (no closing keyword and no matching branch suffix);
- another open pull request also references the issue (`conflicting-open-pull-request`);
- the issue is already closed for a reason other than this reconciliation (`issue-closed-unexpected-reason`);
- the issue body still has an unchecked markdown task item (`acceptance-checklist-incomplete`).

Only when eligible does it replace `status:ready`/`status:in-progress`/`status:blocked` with `status:done` and close the issue as `completed`, then re-reads the issue to confirm both writes landed before recording `completed`.

## Restart safety

`IssueReconciliationStore` is a durable, one-row-per-merge-transaction state machine: `pending` -> `issue_closed` (GitHub confirmed; point of no return) -> `completed`. Replaying a `completed` identity performs no GitHub calls. An `attention` refusal is not a point of no return -- a retry re-reads live evidence and re-evaluates fresh rather than trusting a stale reason code.

## Remote branch deletion

`deleteMergedRemoteBranch` only runs after this exact transaction's issue reconciliation reached `completed`. It re-reads the live branch ref and open-PR list immediately before deleting: a branch that has moved past the merged commit, or still backs an open pull request, is refused (`branch-has-later-work` / `branch-has-open-pull-request`), never force-deleted. An already-absent branch is adopted idempotently.

## Local worktree/branch cleanup

`--cleanup-local` delegates to the existing guarded cleanup contract in `agent-runner-reconcile-workspace.mjs` (#686) for the exact `--attempt-id`/`--branch`/`--worktree` the caller names, after confirming `--branch` matches the merge transaction's source branch. That contract independently re-proves no live process, lease, unresolved claim, dirty file, unpushed commit or linked open PR remains before removing anything, and never runs `git reset --hard`, blind `git clean`, or a forced branch delete.

## Out of scope

This surface never selects or implements the next issue, deploys, force-deletes, or mutates any issue/PR/branch/worktree other than the exact one tied to the supplied merge-transaction identity.
