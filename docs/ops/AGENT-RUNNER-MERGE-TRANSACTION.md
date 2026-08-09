# Agent Runner durable merge policy and transaction

`npm run merge:execute -- --project-registry REGISTRY --executor-policy POLICY --db STATE.sqlite --request-file REQUEST.json` is a non-root, one-shot durable merge surface for a settled pull request. It accepts only the versioned merge-decision request (`agent-runner-merge-policy.mjs`) and produces bounded JSON.

## Default-deny policy

A request is eligible for automatic merge only if all of the following hold, evaluated locally before any GitHub read:

- `riskClass` is `R0`, `R1` or `R2`. `R3`/`R4` are never eligible, regardless of any other field.
- Every explicit human gate (`securityAuth`, `destructiveMigration`, `productionDeployment`, `secretCredential`, `billingPolicy`, `humanGated`) is `false`.
- `automaticMergeAuthority` is explicitly `true`.

These fields are machine-local input constructed by the runner from durable evidence -- never scraped from repository content -- so a permissive repository (labels, workflow files, CODEOWNERS) cannot widen eligibility. Machine-local policy is the only source of permission.

## Transaction execution

Immediately before mutation, `executeMergeTransaction` re-reads the pull request, its reviews and the live target-branch head, and re-runs manager authority. Any drift (head/base changed, checks not settled successfully, review requirement unmet, merge conflict, ambiguous mergeability, stale authority) refuses without merging. The GitHub merge call itself is passed the expected head SHA for exact-head protection.

A durable SQLite transaction (`MergeTransactionStore`) makes restart deterministic:

- Replaying an already-`completed` transaction performs no GitHub calls.
- Resuming a transaction that reached `github_merged` (a crash between GitHub confirming the merge and this store recording it) never re-attempts the merge call -- it only reads back and completes.
- A fresh `pending` row is checked against live PR state before ever calling the merge endpoint, so a merge that already landed is adopted, never repeated.

## Post-merge settlement

`observePostMergeSettlement` observes checks on the merge commit and persists `pending`/`succeeded`/`failed` plus a fingerprint for the reconciliation stage. It is read-only against GitHub and safe to re-invoke on every cycle until terminal.

## Out of scope

This surface cannot enable auto-merge, force-push, delete branches, close issues, mutate labels, deploy or reconcile. It never re-classifies risk on its own -- risk class, gates and automatic-merge authority are inputs the caller must assert explicitly.
