# Agent Runner — direct PR review continuation (#242)

How `node scripts/ops/claude-runner.mjs --repo <owner/name> --pr <n> --execute`
continues an already-authorised pull request, and every boundary it must clear
before a provider process is started or anything is pushed.

This is a *continuation*, never a new task. It creates no new issue claim, it
consumes no new manager packet, it writes no fresh runner-start marker, and it
never opens a replacement branch, worktree or PR.

## Order of admission

Each step fails closed. Nothing below it runs if it refuses.

| # | Gate | Refusal reason (examples) |
|---|------|---------------------------|
| 1 | Quota pause state (`main()`, shared with issue execution) | `quota-paused` |
| 2 | Unresolved review feedback exists at all | (no-op, exit 0) |
| 3 | Feedback is **executable**: unresolved thread or `CHANGES_REQUESTED`, from an author with write standing | `pr-continuation-review-authors-untrusted`, `pr-continuation-no-unresolved-review-instruction` |
| 4 | #241 continuation binding: single linked issue, live manager authority, exact repository/branch/head/worktree | `pr-continuation-linked-issue-ambiguous`, `pr-continuation-manager-authority-refused`, `pr-continuation-pr-branch-mismatch`, `pr-continuation-pr-head-worktree-mismatch` |
| 5 | Worktree is clean, **or** is the exact preserved checkpoint of this PR's previous failed continuation | `pr-continuation-worktree-dirty` (+ `recoveryFailureReason`) |
| 6 | Machine-local cost admission (#226) | `cost-policy-blocked` |
| 7 | Claude CLI capability | `implementation-cli-capability-mismatch` |
| 8 | The one machine-global implementation slot | `implementation-slot-unavailable`, `implementation-slot-inheritance-stale` |
| 9 | Worker runs; evidence must show a commit and a clean tree | `implementation-uncommitted-changes`, `implementation-worktree-dirty`, `runner-checkout-mutated` |
| 10 | Live authority re-verified immediately before publication | `pr-continuation-revalidation-pr-not-open`, `pr-continuation-revalidation-remote-head-advanced`, `pr-continuation-revalidation-authority-revoked`, `pr-continuation-revalidation-feedback-withdrawn` |
| 11 | Deterministic same-PR publication | `pr-continuation-publication-pr-number-changed`, `pr-continuation-publication-branch-changed`, `pr-continuation-publication-head-mismatch` |

## The prompt contract

A bound continuation compiles through the **canonical** stable-prefix prompt
compiler (`claude-runner-prompt-compiler.mjs`), exactly as normal issue
implementation does. It is not a separate prompt dialect.

Stable prefix (cacheable, identical across continuations):

1. safety/authority invariants
2. repository instruction contract
3. implementation-phase invariants — **including** `Finish with a clean commit
   on that exact branch using 'git commit --no-verify ...'`
4. continuation scope bound (review feedback is correction input, not authority)
5. evidence schema
6. adapter identity

Dynamic suffix: task identity/profile, worktree assignment, the issue body and
the bounded review feedback, final request.

Because the compiler is shared, a continuation reports real `#193`
`promptCacheMetadata` (`stablePrefixFingerprint`, byte/token estimates) and the
same normalized `#194` usage telemetry as any other Claude implementation run.
`promptContract` in the run log says which artifact was compiled:
`canonical-implementation` for a bound run, `review-followup-preview` for the
unauthenticated dry-run preview.

> The dry-run preview (`--pr <n>` without `--execute`) deliberately does *not*
> bind, so it cannot compile the canonical prompt. Its prompt is a human
> preview only and carries no write capability.

## Reviewer trust

Review feedback is executable task input, so it is trust-gated
(`TRUSTED_REVIEW_AUTHOR_ASSOCIATIONS`: `OWNER`, `MEMBER`, `COLLABORATOR`).
A missing or unknown author association is never trusted.

Detection stays deliberately wider than execution: any unresolved thread still
*blocks* new issue work (the accepted #188 semantics), because blocking is
always the safe direction. Only execution is gated.

Feedback is bounded to 20 instructions of at most 2000 characters each, on top
of the existing per-comment truncation in the GraphQL reader. Issue-comment
chatter is never executable input.

## The one global implementation slot

Every write-capable implementation launch — direct or scheduled — now takes the
same machine-global lock the systemd recurrence takes
(`AGENT_RUNNER_IMPLEMENTATION_LOCK`, default
`~/.local/state/agent-runner/implementation-recurrence.lock`).

There is no second scheduler and no second lock. The chain

```
implementation recurrence  ->  bin/run-project.sh  ->  pinned cron  ->  claude-runner.mjs
```

already holds the slot in its ancestor, so the recurrence stamps
`AGENT_RUNNER_IMPLEMENTATION_SLOT_PID` into the child environment and the
descendant *inherits* the slot instead of re-taking it. Inheritance is verified
(the declared pid must be alive); a stale declaration fails closed rather than
granting a slot. Releasing an inherited slot never releases the owner's lock.

## Recovering a failed continuation

A failed continuation (for example a worker that edited but never committed)
leaves real work in the worktree. That work is **never** reset, cleaned,
stashed or auto-committed.

Instead the failed run records a restricted recovery checkpoint under a
deterministic per-PR attempt id
(`pr-continuation:<owner>_<repo>:<pr>`), capturing the branch, the exact
`checkpointHead` and the working-tree `checkpointStatusFingerprint`.

The next continuation may reuse the dirty worktree **only** when every one of
those matches the live state exactly. Any unrelated modification changes the
fingerprint and refuses with
`pr-continuation-recovery-worktree-modified`. A refusal always reports
`recoveryFailureReason`, so the situation is diagnosable without touching the
worktree.

If a preserved worktree cannot safely be reused, preserve it as evidence and
create a new explicitly disposable canary — do not delete it.

## What a continuation never does

- never force-pushes
- never opens a replacement PR, branch or worktree
- never resolves, dismisses, approves or merges review feedback
- never closes the linked issue
- never publishes onto stale authority
- never lets `--model` / `--effort` / `--profile` widen the authorised
  continuation (the binding's manager-approved values always win)
- never grants the worker `git push` or `gh` (see `buildImplementationToolPolicy`)
- never falls back to paid/API credit

## Tests

- `scripts/ops/agent-runner-pr-continuation-stability.test.mjs` — system-level
  proof against real temporary git repositories, real worktrees, a real bare
  origin and a deterministic fake worker whose *behaviour* (edit-and-commit,
  edit-without-commit, commit-then-dirty) is the variable under test.
- `scripts/ops/claude-runner.test.mjs` — end-to-end proof that `runPrFollowUp`
  actually compiles the canonical prompt and emits real cache metadata.
