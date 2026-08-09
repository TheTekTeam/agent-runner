# Agent Runner scheduler re-entry

`npm run scheduler:reentry -- --reconciliation-db RECONCILE.sqlite --reentry-db REENTRY.sqlite --transaction-id TX [cron args...]` closes the loop between post-merge issue reconciliation (#156) and automated next-issue selection/claim/launch (#50/#113): a durable, restart-safe marker that control has returned to queue inspection, plus one bounded next-candidate pass handed directly into the existing production scheduler entrypoint.

## Input

The sole evidence source is an `IssueReconciliationStore` row whose `state` has already reached `completed` (#156). A missing row or any non-terminal state (`pending`, `issue_closed`, `attention`) refuses with a closed reason code (`reconciliation-transaction-not-found` / `reconciliation-not-completed`) and durably records nothing.

## What it does

1. Emits one durable `scheduler_reentry_events` row keyed by the reconciliation transaction id (idempotent -- replaying an already-emitted transaction id never re-reads the reconciliation store).
2. Strictly after that emission, runs exactly one bounded pass of the existing production scheduler entrypoint, `main()` from `claude-runner-cron.mjs` -- the same function an operator or the systemd timer already invokes, called with the same trailing `[cron args...]`/environment (`CLAUDE_RUNNER_CRON_EXECUTE`, `--dry-run`, `--repo`, etc.), unmodified. This is the identical atomic admission/selection/claim/workspace/worker-launch code path; `scheduler:reentry` introduces no second claim, worker-launch or GitHub-mutation implementation. Because this pass always follows the reconciliation's own settled GitHub write, stale labels or just-merged work are never re-selected. An explicit `--dry-run`, or an unset `CLAUDE_RUNNER_CRON_EXECUTE`, still yields the same safe, zero-claim, zero-worker-launch pass `main()` already guarantees for that case -- useful for a supervised rehearsal/canary.
3. Records the classified outcome from that pass's own durable result (`payload.claim`, set only when `claimIssueForExecution` actually ran this pass): `idle` (no candidate was actually claimed -- covers an empty queue, a quota block, a dry-run pass, and a candidate that was inspected but blocked before claim, e.g. dispatch-authority-rejected, model-resolution-invalid, workspace-ownership-conflict, or settings-revision-changed), `candidate_selected` (one candidate genuinely claimed, no skips), or `skip_and_continue` (a blocked first candidate was skipped and a second eligible candidate was genuinely claimed).

A due-recovery re-invocation that this same pass happens to launch instead of a fresh claim (a rare case: an unrelated issue's recovery attempt became due at the same moment) is a known, documented under-count -- it never sets `payload.claim`, so it classifies as `idle` even though a worker did launch. This is safe (never a duplicate claim, never spins) though it does not credit that launch in the reentry record; see `classifyProductionHandoffResult` in `agent-runner-scheduler-reentry.mjs`.

## Restart safety

`SchedulerReentryStore` is a durable, one-row-per-reconciliation-transaction state machine: `pending` -> `idle`/`candidate_selected`/`skip_and_continue`. A crash between emission and the production pass leaves the row `pending`; retrying resumes by re-running the pass, never by re-emitting. A crash after the outcome is recorded is fully idempotent: replay returns the exact recorded outcome without re-invoking the production entrypoint or reading the reconciliation store again. Because the production pass reuses `main()`'s own file lock (`--lock-path`, matching whatever the operator/timer already uses), a reentry-driven pass and the periodic systemd timer can never run concurrently against the same lock.

## Out of scope

This surface does not construct a merge-decision request's risk class, human gates or automatic-merge authority -- those remain explicit, machine-local inputs the caller/operator supplies to `merge:execute` exactly as documented today. It does not select on a schedule by itself; the existing systemd timer cadence remains the sole recurring, unattended trigger. `scheduler:reentry` is one composable step an operator, or a post-reconciliation caller, invokes once a reconciliation transaction is known to be `completed` -- it does not itself run merge, post-merge validation or reconciliation for the candidate it claims; that candidate proceeds through the same implementation -> validation -> draft-PR -> review/merge -> reconciliation path every other claimed issue already does today.
