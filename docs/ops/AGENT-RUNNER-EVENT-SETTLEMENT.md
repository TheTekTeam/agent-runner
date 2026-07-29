# Agent Runner event batching and CI settlement

Issue: `TheTekTeam/agent-runner#103`

This module converts normalized GitHub deliveries into durable, project-scoped batches and prevents triage from running against an intermediate issue, pull-request, or post-merge CI state.

It is transport- and project-independent. GitHub polling/provider code records bounded check snapshots; the settlement state machine decides only whether the represented evidence is complete and stable enough to release the batch to triage.

## State machine

```text
collecting
  → waiting_for_checks
  → quiet_period
  → settled

Any unresolved path reaching its bounded deadline
  → settlement_blocked

A new relevant delivery reopens an active blocked batch
  → collecting
```

- `collecting` enforces the event debounce interval.
- `waiting_for_checks` means one or more required SHAs have no complete provider snapshot or still contain non-terminal checks.
- `quiet_period` means every required snapshot is complete and terminal, but a final post-quiet recheck has not yet proved no late workflow or replacement SHA appeared.
- `settled` means the event quiet period, check settlement, and final recheck all passed. Terminal failures remain in the result for triage; completion is not treated as success.
- `settlement_blocked` is a fail-closed timeout. It never bypasses pending CI.

## Batch identity and correlation

The primary key is project + canonical repository + object:

- pull request number when present;
- otherwise issue number;
- otherwise repository scope.

Related issue/PR fan-out coalesces into one active batch. Repository-level push/check events are correlated into an active PR batch when their SHA matches a tracked PR-head, merge, or post-merge SHA. This keeps a merge event, resulting default-branch push, and SHA-only checks under the same settlement gate.

GitHub App `ping` deliveries contain no project work and are marked processed without creating a triage batch.

## SHA rules

The ledger retains SHA history by role:

- `head`;
- `base`;
- `merge`;
- `before`;
- `after`.

Settlement requires only the current SHA for each actionable role: PR head, merge commit, and post-push `after` SHA. A later synchronize event replaces the required head rather than permanently waiting on an obsolete revision. Base and before SHAs are retained for evidence but do not independently gate triage.

## Check snapshot contract

A source-control provider records one complete bounded snapshot per required SHA:

```js
{
  sha,
  observedAt,
  queryComplete,
  checks: [
    { provider, externalId, name, status, conclusion }
  ]
}
```

Non-terminal states:

```text
queued requested waiting pending in_progress
```

Terminal outcomes include:

```text
success failure cancelled timed_out action_required neutral skipped stale startup_failure error
```

A failed terminal check is still terminal. It releases the CI wait only after the quiet-period recheck and remains visible to triage as failure evidence.

Snapshots are bounded to 1,000 unique provider/check identities. Older out-of-order snapshots cannot overwrite newer evidence. Snapshots for SHAs not currently required by the batch are rejected.

## Final quiet-period recheck

The first all-terminal observation starts the quiet period and records a fingerprint of every required SHA snapshot. Settlement requires:

1. the quiet duration to elapse;
2. a fresh provider query for every required SHA at or after the quiet deadline;
3. the check-set fingerprint to remain unchanged;
4. no newer event to have reset the batch to collecting.

A late-starting run, rerun, replacement head, merge push, or related check delivery resets the relevant state instead of being ignored.

## Durability and concurrency

The controller SQLite database adds:

- `event_settlement_schema`;
- `event_batches`;
- `event_batch_deliveries`;
- `event_batch_shas`;
- `event_check_snapshots`.

Delivery attachment uses an immediate transaction and a partial unique index so one batch key cannot acquire two active owners. Final delivery processing and batch settlement commit atomically. Restarted processes recover batches, check snapshots, deadlines, and delivery membership from SQLite.

## Boundaries

This issue does not:

- query GitHub by itself;
- run triage;
- mutate issues or PRs;
- create manager authority;
- execute a coding agent;
- merge or delete branches;
- expose a network endpoint.

Provider polling, transport, triage consumption, and systemd activation are separate programme slices.

## Validation

```bash
node --check scripts/ops/agent-runner-event-ingress.mjs
node --check scripts/ops/agent-runner-event-settlement.mjs
node --check scripts/ops/agent-runner-event-settlement.test.mjs
node --test \
  scripts/ops/agent-runner-project-registry.test.mjs \
  scripts/ops/agent-runner-event-ingress.test.mjs \
  scripts/ops/agent-runner-event-settlement.test.mjs
bash scripts/validate.sh
```
