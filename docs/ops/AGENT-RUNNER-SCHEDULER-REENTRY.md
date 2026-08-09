# Agent Runner scheduler re-entry

`npm run scheduler:reentry -- --reconciliation-db RECONCILE.sqlite --reentry-db REENTRY.sqlite --transaction-id TX [selection args...]` closes the one remaining gap between post-merge issue reconciliation (#156) and automated next-issue selection (#50/#113): a durable, restart-safe marker that control has returned to queue inspection, plus one bounded next-candidate selection pass.

## Input

The sole evidence source is an `IssueReconciliationStore` row whose `state` has already reached `completed` (#156). A missing row or any non-terminal state (`pending`, `issue_closed`, `attention`) refuses with a closed reason code (`reconciliation-transaction-not-found` / `reconciliation-not-completed`) and durably records nothing.

## What it does

1. Emits one durable `scheduler_reentry_events` row keyed by the reconciliation transaction id (idempotent -- replaying an already-emitted transaction id never re-reads the reconciliation store).
2. Strictly after that emission, runs exactly one bounded next-candidate selection pass through the existing, already-tested selection contract: `selectIssue()`/`claude-runner-cron.mjs`, invoked dry-run and with quota preflight skipped -- the identical zero-mutation, zero-model-call shape `claude-runner-candidate-probe.mjs` already uses. Because this read always follows the reconciliation's own settled GitHub write, stale labels or just-merged work are never re-selected.
3. Records the classified outcome: `idle` (no eligible candidate -- zero provider/model invocation, zero GitHub mutation), `candidate_selected` (one eligible candidate, no skips), or `skip_and_continue` (a blocked first candidate was skipped and a second eligible candidate was found), reusing `selectIssue()`'s own skip/continue and qualification/admission/lease/PR/recovery gates unchanged.

This module never claims an issue, creates a worktree/branch, launches a worker, calls a model, or writes to GitHub. Claiming and driving the selected candidate through implementation -> validation -> PR controller -> merge transaction -> reconciliation remains the existing pipeline's job, invoked exactly as it already is today.

## Restart safety

`SchedulerReentryStore` is a durable, one-row-per-reconciliation-transaction state machine: `pending` -> `idle`/`candidate_selected`/`skip_and_continue`. A crash between emission and selection leaves the row `pending`; retrying resumes by running the selection pass, never by re-emitting. A crash after the outcome is recorded is fully idempotent: replay returns the exact recorded outcome without re-reading the reconciliation store or GitHub.

## Out of scope

This surface does not construct a merge-decision request's risk class, human gates or automatic-merge authority -- those remain explicit, machine-local inputs the caller/operator supplies to `merge:execute` exactly as documented today. It does not select on a schedule by itself; the existing systemd timer cadence remains the sole recurring trigger, and this command is one composable step an operator or that timer's cycle invokes once a reconciliation transaction is known to be `completed`.
