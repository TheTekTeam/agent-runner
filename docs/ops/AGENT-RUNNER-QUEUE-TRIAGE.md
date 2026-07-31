# Agent Runner queue triage

Issue: `TheTekTeam/agent-runner#113`

Agent Runner owns deterministic queue inspection, bounded GitHub evidence collection, durable release consumption and low-risk queue-hygiene execution for configured projects. GitHub Actions validates source only; the Dell user service is the local scheduler and mutation authority.

## Safety model

Queue triage has three independent opt-in gates:

1. the project must be enabled in the project registry;
2. the validated project config must set `queueTriage.enabled: true` with `maxMutations` from 1 to 3;
3. a machine-local authority file must be enabled, fingerprint-valid, bound to the exact installed source SHA and explicitly allow the project ID.

If any gate is absent or mismatched, the combined service still performs its existing read-only GitHub polling and CI settlement cycle but performs no queue-triage release claim, fallback pass or GitHub write.

Source examples remain disabled. Machine-local authority, installed project configuration, tokens and credentials are never committed.

## Project policy

Each project may tighten but cannot widen the core limits:

| Setting | Core limit/default | Rule |
|---|---:|---|
| `fallbackIntervalMinutes` | 60 | may increase only |
| `rotatingBacklogSlice` | 2 | may reduce to 0–2 |
| `maxChangedItems` | 20 | may reduce to 1–20 |
| `maxDebuggerAnomalies` | 4 | may reduce to 0–4 |
| `maxMutations` | 3 | may reduce to 0–3 |

Accepted status and priority targets must be subsets of the project’s configured label vocabulary. Every configured status, priority and accepted-agent label must exist in the target repository before a write is attempted.

## Dry-run planner

The pure planner accepts normalized evidence and produces deterministic immutable action plans:

```bash
npm run queue:triage -- --input /path/to/normalized-evidence.json
npm run queue:triage -- --input /path/to/normalized-evidence.json --format markdown
npm run queue:triage:prompt
```

Release-mode input requires a durable `releaseId`; fallback-mode input requires a durable `fallbackId`. Replay identity never depends on observation time.

Raw issue/comment/review bodies, provider responses, prompts, tokens, secrets and arbitrary commands are forbidden from durable reports. Action plans contain exact object identity, before labels and timestamp, decisive evidence references, intended complete label set or completed-close action, manager authority fingerprint, risk classification and deterministic idempotency key.

## Read-only shadow and parity

One explicit pending release may be observed through a private byte-stable snapshot of the controller database:

```bash
npm run queue:triage:shadow -- \
  --controller-db /path/to/controller.sqlite \
  --shadow-db /path/to/queue-triage-shadow.sqlite \
  --release batch-id
```

Bounded live GitHub evidence may be added for that explicit release:

```bash
npm run queue:triage:shadow -- \
  --controller-db /path/to/controller.sqlite \
  --shadow-db /path/to/queue-triage-shadow.sqlite \
  --release batch-id \
  --live-github \
  --project-config /path/to/project.json
```

A separately normalized oversight candidate may be supplied with `--oversight`. Parity is one of `match`, `material_disagreement` or `incomplete`. Shadow mode never claims or finishes controller releases and never writes to GitHub.

## Durable single-release consumption

One explicitly named release can be claimed and finished without executing its action plans:

```bash
npm run queue:triage:consume -- \
  --controller-db /path/to/controller.sqlite \
  --release batch-id \
  --project-config /path/to/project.json \
  [--lease-ms 300000] \
  [--format json|markdown]
```

The transition is atomic `pending -> claimed -> processed|failed`. Only the exact claim token may finish the release. Interrupted claims are preserved for existing lease-expiry recovery. Replaying a terminal release is a no-op without another GitHub read.

## Bounded single-release execution

One explicit release may execute allowlisted low-risk plans after complete initial and final live re-planning:

```bash
npm run queue:triage:execute -- \
  --controller-db /path/to/controller.sqlite \
  --release batch-id \
  --project-config /path/to/project.json \
  --manager-revision REVISION \
  --manager-fingerprint sha256:... \
  --execute
```

The command supports only issue-endpoint PATCH operations for:

- atomic replacement of the complete label set; or
- closing an issue as `completed` after merged-completion evidence settles.

Before each write it requires exact labels, timestamp, kind and open state from the immutable plan. After each write it immediately re-fetches the object and requires exact read-back. Any provider failure, stale snapshot, label-definition gap or verification mismatch stops later actions and finishes the release with a bounded failure result.

The explicit command intentionally has no pending sweep, all-enabled mode, fallback or scheduling. Those capabilities exist only behind the local-authority combined cycle.

## Machine-local authority

The local authority file is a versioned JSON object containing:

- `schemaVersion: 1`;
- `enabled`;
- manager `revision`;
- exact installed `sourceSha`;
- explicit `projectIds` allowlist;
- `maxReleasesPerCycle` from 1 to 20;
- SHA-256 fingerprint over the canonical preceding fields.

Use `.agent-runner/queue-triage-authority.example.json` only as a shape reference. The real file must be created outside the repository, mode-restricted and regenerated whenever the installed source SHA or authorised project set changes.

The combined command is:

```bash
npm run queue:triage:closed-loop -- --help
```

Production execution requires both `--all-enabled` and `--execute`. A supervised fallback pass may additionally use `--fallback`. `--pending` is not accepted.

## Combined polling, settlement and triage cycle

The existing `agent-runner-event-polling.timer` remains the only schedule. Its oneshot service:

1. polls every registry-enabled repository through GET-only GitHub APIs;
2. performs CI settlement and creates durable releases;
3. validates local authority and project opt-in;
4. selects at most 20 authorised pending releases;
5. executes them serially through the accepted single-release executor;
6. runs due hourly fallback passes;
7. exits, allowing `OnUnitInactiveSec=1min` to schedule the next cycle.

There is no second controller writer or queue-triage timer.

Pending release selection filters to authority projects before applying the bound. It ranks releases within each project and then interleaves those ranks, preventing unrelated or high-volume projects from permanently starving later authorised work.

The entire combined cycle permits at most three verified mutations per project. Processing stops after the first failed terminal release or fallback result.

## Rotating backlog and hourly fallback

Release-driven planning includes up to two unchanged open issues per project where available. The rotating items are selected in issue-number order, exclude objects already processed as changed in the same cycle, use a persisted cursor and wrap deterministically using the configured project timezone and local hour.

A project fallback is due only when `fallbackIntervalMinutes` has elapsed since its last successful local pass. Its durable identity is:

```text
fallback:<project-id>:<local-hour>
```

Fallback executes the selected issues through temporary synthetic single-release controller ledgers and the same accepted executor. It does not introduce another GitHub write client or planner. Current GitHub state, deterministic action plans and durable fallback identity make replay idempotent.

`fallbackPerformed` is true only when at least one project fallback actually starts. A normal one-minute polling cycle is not reported as an hourly fallback pass.

## Local state database

Queue-triage scheduling state is stored separately from the authoritative controller database, normally beside it as:

```text
queue-triage-local.sqlite
```

Schema version 1 stores:

- per-project last successful pass;
- last fallback identity;
- rotating cursor;
- running, processed and failed fallback outcomes;
- persistent exception fingerprints and appearance counts.

An incompatible existing schema fails closed before migration. A running fallback may be recovered only after the bounded stale interval. Terminal fallback identities are not re-executed.

The authoritative controller schema is unchanged.

## Installation

The non-root installer validates the checkout, registry, authority file, exact source SHA, project opt-in, Node, authenticated `gh` access and command availability before changing user-systemd files:

```bash
scripts/install-queue-triage-local-authority.sh \
  --agent-runner-home /absolute/path/to/agent-runner \
  --project-registry /absolute/path/to/projects.json \
  --authority-file /absolute/path/to/queue-triage-authority.json \
  --controller-db /absolute/path/to/controller.sqlite
```

Add `--enable` only after supervised acceptance. The installer:

- copies the reviewed combined service unit;
- writes a mode-0600 environment file containing only authority, source-SHA and local-state paths;
- does not create or edit project configs or the authority JSON;
- does not write a token or secret;
- uses the existing polling timer.

## Rollback

To return to read-only polling without deleting evidence:

1. stop the polling timer and service;
2. remove or disable the machine-local authority file/environment reference;
3. reinstall the prior read-only polling service unit or run the combined unit without valid authority;
4. reload user systemd and restart the timer;
5. preserve the controller and local queue-triage databases for audit.

Absence of valid authority is itself a fail-closed read-only rollback state.

## Output and oversight

Every command emits bounded JSON or Markdown with `RUN_CONTROL` fields separating controller mutations, GitHub reads, GitHub writes, verified mutations, release sweep and actual fallback execution.

The OpenAI oversight prompt is generated from the same core planner constants. After live local-authority acceptance, the OpenAI scheduled task must be oversight-only: review exceptions, material disagreement and aggregate management signals without duplicating deterministic Agent Runner mutations.

## Delivery status

1. Deterministic planner and project policy — complete.
2. Read-only shadow persistence — complete.
3. Live evidence and parity — complete.
4. Two-project live parity acceptance — complete.
5. Durable single-release consumption — complete and live accepted.
6. Bounded GitHub execution — complete and live accepted.
7. Local authority, fair pending orchestration and hourly fallback — implemented; requires exact-head validation, merge and supervised Dell activation.
8. OpenAI oversight-only transition and final #113 closure — after live activation, restart and rollback acceptance.

Source implementation does not itself authorise Dell installation, project opt-in, service activation or scheduled-task changes. Those remain explicit post-merge operator gates.
