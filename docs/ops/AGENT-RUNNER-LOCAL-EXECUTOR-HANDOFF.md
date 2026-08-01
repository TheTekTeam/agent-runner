# Durable triage-release to local-executor handoff

Issue: `TheTekTeam/agent-runner#104`

This handoff connects completed queue triage to the typed Dell executor without creating a second triage consumer and without turning GitHub events into commands.

## Authority boundary

The handoff reads only `event_triage_releases` rows already finalized as `processed` by the existing queue-triage authority. It ignores pending, claimed and failed releases, so it cannot race the triage consumer or bypass its manager-authority and exact-evidence checks.

A processed release is eligible only when:

- its terminal result is the allowlisted `queue-triage-execution` kind;
- its terminal state is `processed`;
- the terminal release identity matches the durable batch ID;
- its project and repository match an enabled project-registry entry.

Conflicting identity fails closed before a handoff row is created.

## Activation baseline

The first discovery cycle records the newest already-processed release as its durable cursor and creates no jobs. This prevents deployment from replaying historical queue-triage history. Only processed releases strictly after that baseline can create handoffs.

The cursor advances in `(updated_at, batch_id)` order. Non-eligible processed rows are skipped but still advance the cursor, while malformed or conflicting eligible evidence fails the transaction and leaves the cursor unchanged for inspection.

## Initial operation

Every eligible release creates one deterministic typed job:

```json
{
  "schemaVersion": 1,
  "jobId": "triage-inspect-<release digest>",
  "nonce": "triage-inspect-nonce-<release digest>",
  "projectId": "configured-project",
  "operation": "project.inspect",
  "expectedSha": null,
  "expiresAt": "<bounded persisted expiry>",
  "arguments": {}
}
```

The first handoff operation is intentionally read-only. Release payload text, issue bodies, comments, provider output and arbitrary arguments are never copied into the executor job. Later implementation, validation or PR operations require separate typed jobs and their own positive authority.

## Durability and replay

The controller SQLite database stores:

- one handoff per durable batch ID;
- the exact deterministic job envelope;
- pending/running/succeeded/failed state;
- a bounded claim lease;
- only the final job state, fixed error code and a SHA-256 fingerprint of the executor result.

The executor's raw result is not duplicated into the handoff table. In particular, repository paths and command output are not copied.

Discovery is idempotent. The persisted expiry, job ID and nonce are not regenerated after restart.

## Restart recovery

At the start of every cycle:

1. expired local-executor jobs are classified by the interrupted-job recovery contract;
2. expired handoff claims inspect the durable local job;
3. a final local job finalizes the handoff without re-execution;
4. an active local project lease extends the handoff claim rather than creating duplicate work;
5. a claim with no local job is returned to pending;
6. no interrupted operation is silently replayed.

## One-shot command

```bash
node scripts/ops/agent-runner-local-executor-handoff-command.mjs \
  --project-registry ~/.config/agent-runner/projects.json \
  --executor-policy ~/.config/agent-runner/local-executor-policy.json \
  --db ~/.local/state/agent-runner/controller/controller.sqlite
```

Optional bounds:

```text
--discovery-limit 1..500
--execution-limit 1..20
```

The command opens no listener and accepts no job body from GitHub. It refuses root execution and is suitable for a later supervised serial scheduler.

## Current non-goals

This slice does not:

- claim or mutate a pending triage release;
- infer that an issue is authorised for implementation;
- create a worktree or branch;
- invoke a coding agent;
- publish or merge a pull request;
- delete a branch or worktree;
- accept arbitrary shell text, paths or environment values.

## Validation

```bash
node --check scripts/ops/agent-runner-local-executor-handoff.mjs
node --check scripts/ops/agent-runner-local-executor-handoff-command.mjs
node --check scripts/ops/agent-runner-local-executor-handoff.test.mjs
node --test scripts/ops/agent-runner-local-executor-handoff.test.mjs
npm test
npm run validate
```
