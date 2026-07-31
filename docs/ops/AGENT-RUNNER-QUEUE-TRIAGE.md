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

For one explicit pending release, the command may collect bounded live GitHub evidence through the existing authenticated read-only client:

```bash
npm run queue:triage:shadow -- \
  --controller-db /path/to/controller.sqlite \
  --shadow-db /path/to/queue-triage-shadow.sqlite \
  --release batch-id \
  --live-github \
  --project-config /path/to/project.json
```

A separately generated normalized oversight candidate can be compared with the Agent Runner dry-run result:

```bash
npm run queue:triage:shadow -- \
  --controller-db /path/to/controller.sqlite \
  --shadow-db /path/to/queue-triage-shadow.sqlite \
  --release batch-id \
  --live-github \
  --project-config /path/to/project.json \
  --oversight /path/to/normalized-oversight.json
```

Live GitHub collection is deliberately unavailable with `--pending`; it requires one explicit `--release`. The command supports GET requests only. `--execute` remains unsupported.

The authoritative controller database and optional WAL are read only as bounded byte files. Two consecutive snapshots must match exactly; otherwise observation fails closed. SQLite opens only a private temporary copy, which is removed on close or construction failure. The command never opens, migrates or writes the authoritative controller path, claims or finishes a release, or changes a release state. All durable observations, dry-run reports and parity results are written only to the separately supplied shadow database.

No systemd unit or unattended queue-triage schedule is installed or enabled. The preserved live release ledger remains authoritative and unchanged.

## Durable single-release consumption

After separately accepted live parity, one explicitly named pending release may be claimed and finished through the durable controller ledger:

```bash
npm run queue:triage:consume -- \
  --controller-db /path/to/controller.sqlite \
  --release batch-id \
  --project-config /path/to/project.json \
  [--lease-ms 300000] \
  [--format json|markdown]
```

This command accepts exactly one `--release`. It does not provide `--pending`, `--all-enabled`, fallback or scheduled operation. The release transition is atomic `pending -> claimed`; only the exact bounded claim token may complete `claimed -> processed` or `claimed -> failed`.

After claiming, the consumer reuses the existing GET-only live GitHub collector and deterministic planner. It finishes `processed` only when live evidence is complete, the report identity matches the claimed release, and the release payload and exact claim ownership remain unchanged at the final recheck. Action plans are persisted only as bounded counts and fingerprints; none are executed.

The terminal controller result is bounded to 64 KiB and contains only normalized release identity, payload/evidence/report fingerprints, inspected/action/exception counts, completion state and zero-mutation `RUN_CONTROL`. Raw issue/comment/review bodies, raw GitHub payloads, provider output, prompts, claim tokens, secrets and credentials are forbidden.

A repeated invocation after `processed` or `failed` returns a deterministic no-op without another claim or GitHub read. An interruption that occurs after claim but before a safe terminal result leaves the claim intact until the existing lease-expiry recovery path requeues it. Incomplete live evidence records a bounded `failed` result and can never be reported as processed.

The implementation and tests use fixture databases only. The preserved live pending releases remain untouched until a separate live consumption acceptance is authorised. GitHub writes, action-plan execution, `--execute`, systemd changes and scheduled-task changes remain structurally unavailable.

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

The planner accepts bounded metadata only. Each item contains identity, exact labels, exact `updatedAt`, compact evidence references, intended canonical status, priority or authoritative agent label, dependencies, and explicit safety flags. Optional manager authority is represented only by revision and fingerprint.

Raw issue/comment bodies, review bodies, raw GitHub payloads, provider output, prompts, tokens and secrets are rejected from persisted reports and parity candidates. Evidence references are bounded identifiers, not copied content.

Safety flags such as active claim, reservation, recovery, newer authority or unresolved human decision suppress a mutation proposal and create a typed debugger exception. An incomplete dependency cannot produce a blocked-to-ready proposal. Conflicting label families without a canonical normalized decision become typed incomplete-evidence exceptions rather than guesses.

## Read-only live GitHub evidence

The live collector operates on one explicit pending issue or pull-request release. It constructs only repository-scoped GET endpoints and collects:

- current repository identity and default-branch SHA;
- the exact released issue or pull request;
- at most 100 issue/PR comments and 100 PR reviews;
- at most 20 explicitly named dependencies from the issue’s `Dependencies` section;
- at most ten release SHAs, with bounded check-run, check-suite, workflow-run, workflow-job and commit-status summaries;
- current manager, hold, recovery, claim and reservation markers reduced to typed metadata and fingerprints.

Issue and pull-request objects remain distinct even though GitHub exposes PRs through the issues API. Exact current labels, state and `updatedAt` are preserved. Release SHA roles (`head`, `base`, `merge`, `before`, `after`) are compared with live PR/default-branch identity where possible. A replacement or required-but-unverifiable SHA makes evidence incomplete.

The newest applicable manager/control marker supersedes older holds. A manager packet explicitly marked consumed, superseded or revoked is not treated as current authority. Raw marker bodies are not persisted.

Pagination limits, provider failures, malformed responses, replacement SHAs or unverifiable required roles create bounded diagnostics and set `queryComplete: false`. GitHub-only evidence never proves runtime-runnable state.

## Durable shadow observations

The release reader validates the existing controller release schema against a private stable snapshot and exposes only bounded deterministic snapshots. Pending releases are ordered by release time and batch identity. Multi-release observation is capped at 20. Read-only snapshots are frozen and omit controller claim tokens.

The separate shadow store records normalized identity and fingerprints:

- batch, project, repository and object identity;
- release/controller timestamps;
- authoritative payload, delivery, SHA and settlement fingerprints;
- first observation time;
- normalized evidence fingerprint and bounded dry-run report when explicitly supplied;
- normalized parity inputs, status and deterministic result fingerprint.

It does not store controller payload JSON, delivery identifiers, raw provider evidence or live issue/comment content. Re-observing unchanged evidence is an idempotent replay. Reusing a release identity with changed payload, report or parity content fails closed as a collision. Identity and planner validation occur before any shadow write.

## Parity comparison

Parity input is a bounded, versioned normalized candidate. It compares:

- release and project identity;
- settlement/release and SHA-evidence fingerprints;
- inspected object identity, exact update timestamp and label fingerprint;
- intended action plans;
- typed exceptions.

The only parity statuses are:

- `match` — both complete candidates agree materially;
- `material_disagreement` — complete candidates disagree on a material field;
- `incomplete` — either candidate or its settlement evidence is incomplete.

Only `match` is potential acceptance evidence. No parity result authorises release consumption, GitHub mutation or unattended operation. Repository code does not assume that an OpenAI scheduled task exists; the oversight candidate is a separately supplied normalized file.

## Typed immutable action plans

Every proposed action records:

- project, repository, object kind and number;
- exact before labels and update timestamp;
- decisive evidence references;
- manager authority revision/fingerprint when supplied;
- intended complete label set or close action;
- risk classification and expected post-write state;
- deterministic idempotency key and evidence fingerprint.

Status, priority and agent-label changes are reconciled against the full configured label vocabulary into one complete final label set, even when project policy narrows which target labels are allowed. They never describe a transient dual-status or partial-family write.

## Count semantics

Reports keep these values separate:

1. **Inspected-scope GitHub-ready** — proved only among the bounded items supplied to this run.
2. **Repository-wide ready-labelled** — `not_calculated` until every matching open issue is separately queried and final labels are verified.
3. **Runtime-runnable confirmed** — `not_proven` unless normalized trusted machine evidence is supplied.

A rotating slice is never presented as a repository-wide count.

## Output and `RUN_CONTROL`

JSON and Markdown reports include inspected counts, proposed actions, typed exceptions, count provenance, overflow and a compact `RUN_CONTROL` footer.

Live shadow output records:

- `controllerDatabaseReadOnly: true`;
- zero controller releases claimed or finished;
- whether read-only GitHub reads occurred;
- `githubWritesPerformed: false`;
- live-evidence completeness;
- parity comparison and match state;
- `mutationAllowed: false`;
- shadow rows inserted and replayed.

Durable-consumption output separately records:

- whether exactly one release was claimed and finished;
- whether the controller database changed only for those release transitions;
- whether GET-only GitHub reads occurred;
- `githubWritesPerformed: false`;
- `actionPlansExecuted: 0`;
- `mutationAllowed: false`;
- no systemd or scheduled-task change.

The OpenAI oversight prompt is generated from the same exported core policy constants used by the planner. During parity acceptance, OpenAI remains oversight-only and must fail closed on material disagreement. It must not duplicate Agent Runner mutations.

## Staged delivery

1. **Foundation — complete:** validated policy, pure planner, dry-run command, bounded reports, fixtures and deterministic oversight prompt.
2. **Read-only release shadow — complete:** bounded private controller snapshots and restart-safe separate shadow observations, without release claims or live GitHub reads.
3. **Read-only live evidence and parity — complete:** bounded explicit-release GitHub reads, normalized reports and durable parity comparison.
4. **Live shadow acceptance — complete:** reviewed comparisons for ModelSpend and Agent Runner produced complete exact matches while preserving controller and release state.
5. **Durable consumption — current:** implement explicit-release claim, GET-only planning and bounded terminal finish semantics without action execution.
6. **Bounded execution:** separately authorise the low-risk mutation allowlist, final live rechecks, atomic writes and read-back verification.
7. **Local authority:** enable the Dell fallback schedule and change the OpenAI task to oversight-only after proven parity and consumption acceptance.

This implementation slice does not run against or consume the preserved live pending releases. Live Dell release-consumption acceptance is a separate manager-authorised operator step. No GitHub mutation, queue action execution, systemd activation or later phase is authorised by this source implementation itself.
