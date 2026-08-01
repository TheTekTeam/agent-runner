# Local executor interrupted-job recovery

Issue: `TheTekTeam/agent-runner#104`

The one-shot local executor classifies expired durable `running` jobs before it accepts a new typed job. Recovery is deliberately classification-only: it never replays an operation automatically and never assumes that an interrupted mutation either completed or failed cleanly.

## Eligibility

A running job is eligible only when its matching project lock is expired or missing. A job with a current lease remains untouched. Recovery is transactional and bounded to 100 jobs by default, with a hard maximum of 500 per pass.

## Classification

- `project.inspect` and `worktree.inspect` are recorded as `retry-safe-read-only` with error code `interrupted-read-only`.
- Every other operation is recorded as `manual-reconciliation-required` with error code `interrupted-operation-ambiguous`.

Both classifications persist:

```json
{
  "recovery": {
    "classification": "manual-reconciliation-required",
    "reason": "executor-process-interrupted",
    "lockState": "expired",
    "automaticReplay": false
  }
}
```

The job moves from `running` to `failed`, receives a bounded finish timestamp and error code, and cannot be re-executed under the same job ID or nonce. A later retry requires a new explicit typed job after current repository/worktree state has been inspected.

## Lock safety

Recovery deletes only the matching expired lock. If an orphaned historical job has no matching lock while a newer job owns the project lock, the newer lock is preserved.

## Boundary

This recovery step does not:

- infer whether an interrupted mutation completed;
- reset, clean or delete a repository or worktree;
- generate a replacement job;
- claim a triage release;
- invoke a coding agent;
- publish or merge a pull request.

Those actions require their own typed evidence and programme authority.

## Validation

```bash
node --check scripts/ops/agent-runner-local-executor-recovery.mjs
node --check scripts/ops/agent-runner-local-executor-recovery.test.mjs
node --check scripts/ops/agent-runner-local-executor-job.mjs
node --test scripts/ops/agent-runner-local-executor-recovery.test.mjs
npm test
npm run validate
```
