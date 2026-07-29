# Agent Runner event controller and triage releases

Issue: `TheTekTeam/agent-runner#110`

The event controller is the durable bridge between signed GitHub event intake, complete CI settlement, and queue triage. It processes only repositories enabled in the generic project registry and releases a settled batch exactly once for a later triage consumer.

## Controller cycle

A bounded cycle:

1. requeues expired triage-release claims;
2. attaches pending webhook deliveries to deterministic batches;
3. skips GitHub reads while the event debounce remains active;
4. refreshes every required SHA through the read-only GitHub checks provider;
5. evaluates the settlement state machine;
6. performs a fresh provider read at the quiet-period deadline;
7. creates one durable triage release only after the batch reaches `settled`;
8. reports bounded state and provider reason codes.

A provider outage, partial read, non-terminal check, timeout, disabled project, or contradictory evidence produces no triage release.

## Triage release ledger

The controller adds `event_triage_releases` to the controller SQLite database.

Release states:

```text
pending → claimed → processed
                  → failed
```

Each release is keyed by the settled batch ID, so repeated cycles and process restarts cannot create duplicate releases.

Claims use a bounded token and an expiry lease. An expired claimed release is returned to `pending`. Completing a release requires the matching claim token. This lets a later triage consumer recover safely after a crash or Dell reboot without losing or duplicating work.

The release payload contains only bounded evidence:

- project and repository;
- issue, PR, or repository object identity;
- settled timestamp;
- delivery IDs;
- tracked SHA roles;
- required SHAs;
- terminal check failures.

It contains no raw webhook body, issue/comment text, credentials, prompts, environment content, or provider output.

## One-shot command

```bash
node scripts/ops/agent-runner-event-controller-cycle.mjs \
  --project-registry ~/.config/agent-runner/projects.json \
  --db ~/.local/state/agent-runner/controller/controller.sqlite
```

Optional controls:

```text
--debounce-ms
--quiet-ms
--settlement-timeout-ms
--batch-limit
```

The command uses the existing authenticated `gh` session or protected machine-local `GH_TOKEN`/`GITHUB_TOKEN`. It prints one compact JSON result and exits. It is suitable for a supervised systemd service/timer and for a later webhook wake-up mechanism.

## Safety boundary

This controller is still read-only with respect to GitHub and repositories. It does not:

- run queue-triage mutations;
- create manager packets;
- claim implementation issues;
- run coding agents;
- execute repository commands;
- create or merge PRs;
- close issues or delete branches.

Those capabilities consume a claimed release through later, separately authorised programme slices.

## Validation

```bash
node --check scripts/ops/agent-runner-event-controller.mjs
node --check scripts/ops/agent-runner-event-controller-cycle.mjs
node --check scripts/ops/agent-runner-event-controller.test.mjs
node --test \
  scripts/ops/agent-runner-project-registry.test.mjs \
  scripts/ops/agent-runner-event-ingress.test.mjs \
  scripts/ops/agent-runner-event-settlement.test.mjs \
  scripts/ops/agent-runner-github-checks-provider.test.mjs \
  scripts/ops/agent-runner-event-controller.test.mjs
bash scripts/validate.sh
```
