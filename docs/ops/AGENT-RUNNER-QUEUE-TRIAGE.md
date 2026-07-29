# Agent Runner queue triage

Issue: `TheTekTeam/agent-runner#113`

This document defines the reusable queue-triage policy and the first, dry-run-only implementation slice. Agent Runner owns deterministic queue inspection and action planning for every configured project. GitHub Actions validates source only; it is not the queue scheduler or mutation engine.

## Current implementation boundary

The current command accepts a normalized evidence file and produces a deterministic dry-run report:

```bash
npm run queue:triage -- --input /path/to/normalized-evidence.json
npm run queue:triage -- --input /path/to/normalized-evidence.json --format markdown
npm run queue:triage:prompt
```

`--execute` is deliberately unsupported. This slice performs no GitHub reads or writes, claims no controller releases, changes no controller database, and installs or enables no systemd unit. The 21 preserved live releases remain untouched until a later manager-authorised slice adds durable consumption and shadow acceptance.

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

The planner accepts already-collected, bounded metadata only. Each item contains identity, exact labels, exact `updatedAt`, compact evidence references, intended canonical status or authoritative agent label, dependencies, and explicit safety flags. Optional manager authority is represented only by revision and fingerprint.

Raw issue/comment bodies, raw GitHub payloads, provider output, prompts and secrets are rejected. Evidence references are bounded identifiers, not copied content.

Safety flags such as active claim, reservation, recovery, newer authority or unresolved human decision suppress a mutation proposal and create a typed debugger exception. An incomplete dependency cannot produce a blocked-to-ready proposal.

## Typed immutable action plans

Every proposed action records:

- project, repository, object kind and number;
- exact before labels and update timestamp;
- decisive evidence references;
- manager authority revision/fingerprint when supplied;
- intended complete label set or close action;
- risk classification and expected post-write state;
- deterministic idempotency key and evidence fingerprint.

Status changes model one complete final label set. They never describe a transient dual-status write.

## Count semantics

Reports keep these values separate:

1. **Inspected-scope GitHub-ready** — proved only among the bounded items supplied to this run.
2. **Repository-wide ready-labelled** — `not_calculated` until a later live provider proves every matching open issue was queried.
3. **Runtime-runnable confirmed** — `not_proven` unless normalized trusted machine evidence is supplied.

A rotating slice is never presented as a repository-wide count.

## Output and `RUN_CONTROL`

JSON and Markdown reports include inspected counts, proposed actions, typed exceptions, count provenance, overflow and a compact `RUN_CONTROL` footer. The footer explicitly records that mutation is disabled, no external read occurred, no controller database changed, and no release was claimed or finished.

The OpenAI oversight prompt is generated from the same exported core policy constants used by the planner. During later shadow acceptance, OpenAI remains oversight-only and must fail closed on material disagreement. It must not duplicate Agent Runner mutations.

## Staged delivery

1. **Foundation — current:** validated policy, pure planner, dry-run command, bounded reports, fixtures and deterministic oversight prompt.
2. **Durable consumption:** claim one settled release, gather read-only evidence, persist dry-run results, and finish/requeue safely. Still no GitHub mutation.
3. **Shadow acceptance:** compare Agent Runner output with the existing scheduled task for ModelSpend and Agent Runner. Any disagreement blocks progression.
4. **Bounded execution:** separately authorise the low-risk mutation allowlist, final live rechecks, atomic writes and read-back verification.
5. **Local authority:** enable the Dell fallback schedule and change the OpenAI task to oversight-only after proven parity.

No later phase is authorised by the foundation implementation itself.
