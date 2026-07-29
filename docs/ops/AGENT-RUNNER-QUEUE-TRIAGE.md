# Agent Runner queue triage

Issue: `TheTekTeam/agent-runner#113`

Agent Runner owns deterministic queue inspection and action planning for every configured project. GitHub Actions validates source only; it is not the queue scheduler or mutation engine.

## Current implementation boundary

The pure planner accepts a normalized evidence file and produces a deterministic dry-run report. Release-mode input requires a durable `releaseId`; fallback-mode input requires a durable `fallbackId` so replay identity never depends on wall-clock observation time:

```bash
npm run queue:triage -- --input /path/to/normalized-evidence.json
npm run queue:triage -- --input /path/to/normalized-evidence.json --format markdown
npm run queue:triage:prompt
```

The shadow command can observe one explicit pending release or at most 20 pending releases from an existing controller database:

```bash
npm run queue:triage:shadow -- \
  --controller-db /path/to/controller.sqlite \
  --shadow-db /path/to/queue-triage-shadow.sqlite \
  --release batch-id

npm run queue:triage:shadow -- \
  --controller-db /path/to/controller.sqlite \
  --shadow-db /path/to/queue-triage-shadow.sqlite \
  --pending --limit 20
```

The controller database is opened with SQLite read-only mode. The command never migrates it, claims or finishes a release, or changes a release state. All durable shadow observations and optional planner reports are written only to the separately supplied shadow database.

`--execute` remains unsupported. No live GitHub issue, PR, comment, branch or check evidence is fetched by queue triage yet. No systemd unit or unattended queue-triage schedule is installed or enabled. The preserved live release ledger remains authoritative and unchanged.

## Project policy

Each project may opt in through `queueTriage`. The default is disabled. Project configuration may make limits stricter but cannot widen the core ceilings:

| Setting | Core ceiling/default | Tightening rule |
|---|---:|---|
| `fallbackIntervalMinutes` | 60 | may increase only |
| `rotatingBacklogSlice` | 2 | may reduce to 0–2 |
| `maxChangedItems` | 20 | may reduce to 1–20 |
| `maxDebuggerAnomalies` | 4 | may reduce to 0–4 |
| `maxMutations` | 3 | may reduce to 0–3 |

Accepted status and priority labels must be subsets of the project’s configured label vocabulary. The implementation contains no repository name, workflow name or ModelSpend-specific decision branch.

## Normalized evidence contract

The planner accepts already-collected, bounded metadata only. Each item contains identity, exact labels, exact `updatedAt`, compact evidence references, intended canonical status, priority or authoritative agent label, dependencies, and explicit safety flags. Optional manager authority is represented only by revision and fingerprint.

Raw issue/comment bodies, raw GitHub payloads, provider output, prompts and secrets are rejected. Evidence references are bounded identifiers, not copied content.

Safety flags such as active claim, reservation, recovery, newer authority or unresolved human decision suppress a mutation proposal and create a typed debugger exception. An incomplete dependency cannot produce a blocked-to-ready proposal. Conflicting label families without a canonical normalized decision become typed incomplete-evidence exceptions rather than guesses.

## Durable shadow observations

The read-only release reader validates the existing controller release schema and exposes only bounded deterministic snapshots. Pending releases are ordered by release time and batch identity. Multi-release observation is capped at 20.

The separate shadow store records only normalized identity and fingerprints:

- batch, project, repository and object identity;
- release/controller timestamps;
- authoritative payload, delivery, SHA and settlement fingerprints;
- first observation time;
- normalized evidence fingerprint and bounded dry-run report when explicitly supplied.

It does not store the controller payload JSON, delivery identifiers, raw provider evidence or live issue/comment content. Re-observing an unchanged release is an idempotent replay. Reusing a batch identity with a changed payload fingerprint fails closed as a collision. An evidence file must match the observed release, project, repository and object identity before the planner runs.

## Typed immutable action plans

Every proposed action records:

- project, repository, object kind and number;
- exact before labels and update timestamp;
- decisive evidence references;
- manager authority revision/fingerprint when supplied;
- intended complete label set or close action;
- risk classification and expected post-write state;
- deterministic idempotency key and evidence fingerprint. Manager authority is part of that fingerprint when supplied.

Status, priority and agent-label changes are reconciled against the full configured label vocabulary into one complete final label set, even when project policy narrows which target labels are allowed. They never describe a transient dual-status or partial-family write.

## Count semantics

Reports keep these values separate:

1. **Inspected-scope GitHub-ready** — proved only among the bounded items supplied to this run.
2. **Repository-wide ready-labelled** — `not_calculated` until a later live provider proves every matching open issue was queried.
3. **Runtime-runnable confirmed** — `not_proven` unless normalized trusted machine evidence is supplied.

A rotating slice is never presented as a repository-wide count.

## Output and `RUN_CONTROL`

JSON and Markdown reports include inspected counts, proposed actions, typed exceptions, count provenance, overflow and a compact `RUN_CONTROL` footer.

Planner output records that mutation is disabled. Shadow output separately records:

- `controllerDatabaseReadOnly: true`;
- zero controller releases claimed or finished;
- zero GitHub reads or writes;
- shadow rows inserted and replayed.

The OpenAI oversight prompt is generated from the same exported core policy constants used by the planner. During later parity acceptance, OpenAI remains oversight-only and must fail closed on material disagreement. It must not duplicate Agent Runner mutations.

## Staged delivery

1. **Foundation — complete:** validated policy, pure planner, dry-run command, bounded reports, fixtures and deterministic oversight prompt.
2. **Read-only release shadow — current:** bounded controller snapshots and restart-safe separate shadow observations, without release claims or live GitHub reads.
3. **Read-only live evidence and parity:** collect bounded GitHub evidence, persist comparable shadow reports, and compare with the existing scheduled task. Any disagreement blocks progression.
4. **Durable consumption:** separately authorise release claim/finish semantics after shadow parity. GitHub mutation remains disabled.
5. **Bounded execution:** separately authorise the low-risk mutation allowlist, final live rechecks, atomic writes and read-back verification.
6. **Local authority:** enable the Dell fallback schedule and change the OpenAI task to oversight-only after proven parity.

No later phase is authorised by the current implementation itself.
