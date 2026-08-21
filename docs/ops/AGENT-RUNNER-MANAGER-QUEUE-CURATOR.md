# Agent Runner manager queue curator (bounded dependency-aware mutation)

Issue: `TheTekTeam/agent-runner#266` (`BUILD.MANAGER.QUEUE.CURATOR.1`, parent
`#258`). Slice B of the Build Manager replacement, built on the accepted
read-only planner foundation from `#261`
(`docs/ops/AGENT-RUNNER-MANAGER-PLANNER.md`) and the per-project management
profiles from `#259` (`docs/ops/AGENT-RUNNER-MANAGER-PROFILES.md`).

This slice converts a validated, read-only plan proposal into a bounded,
deterministic, dependency-aware **queue-curation proposal** and, under explicit
manager mutation authority, a **bounded mutation transaction** for exactly one
explicitly registered project.

It creates no worker authority, consumes no worker authority and dispatches no
implementation.

## The transition

Queue curation is expressible as one pure transition:

```
validated project/plan/current-queue evidence
    -> deterministic bounded queue-curation transition   (curateManagerQueue)
    -> normalized outcome                                (curation.outcome)
    -> a later event controller decides the successor    (#268, not here)
```

Everything on the left of the arrow arrives already validated. Everything on
the right is a pure function of it: the same inputs always produce the same
records, the same operations, the same fingerprint and the same outcome.

## Modules

- `scripts/ops/agent-runner-manager-queue-evidence.mjs` —
  `validateManagerQueueEvidence(raw, { proposal })` normalizes the bounded
  current-queue snapshot (issues, labels, curation keys, dependency edges,
  supersession, active leases, open pull requests) and binds it to the exact
  repository, branch and source revision the proposal was grounded on.
  `queueCurationKey(projectId, proposedIssueId)` derives the stable
  `qc:<projectId>:<proposedIssueId>` key that links one plan item to one issue.
- `scripts/ops/agent-runner-manager-queue-curator.mjs` —
  `curateManagerQueue(queueEvidence)` produces the normalized curation: queue
  records, resolved dependencies, readiness, ownership protections, the dry-run
  `operations` array, `deferred` work, `escalations`, a deterministic
  `curationRevision`/`curationFingerprint` and the bounded `outcome`.
- `scripts/ops/agent-runner-manager-queue-mutation.mjs` —
  `planQueueMutationTransaction(curation, { currentSourceSha })` is the last
  fail-closed gate before any write; `applyQueueMutationTransaction(transaction,
  { client })` applies the already-validated operations through an injected
  mutation port.
- `scripts/ops/agent-runner-manager-queue-test-fixtures.mjs` — test-support
  only: builds the validated profile → evidence → brief → proposal →
  queue-evidence chain from the same public validators production callers use.

## Identity, dedupe and supersession

1. **Curation key.** A proposed plan item is matched to the issue carrying its
   `qc:<projectId>:<proposedIssueId>` key. Evidence validation guarantees at
   most one issue claims any given key; a key belonging to a different
   registered project is refused.
2. **Supersession.** If the matched issue is superseded, the chain is followed
   to its terminal successor, which becomes the queue record. Dangling or
   cyclic supersession, and supersession of work that still holds an active
   lease, are refused.
3. **Title adoption.** A plan item with no curated match adopts an existing
   *open, uncurated, non-superseded* issue whose whitespace-collapsed,
   case-folded title matches exactly. Two such candidates, or two plan items
   resolving to the same issue, are ambiguous identity and are refused.
4. **Duplicate proposed work.** Two plan items with the same normalized title
   cannot be mapped onto distinct queue records deterministically and are
   refused rather than silently collapsed.

## Dependencies and readiness

Issue-level dependencies are derived from the accepted `#261` plan shape: a
proposed issue depends on every proposed issue belonging to a milestone its own
milestone directly depends on. No new planner input is introduced.

- A dependency is **satisfied** when its queue record resolves to a closed
  issue. A record with no unsatisfied dependencies is `ready`; otherwise it is
  `blocked`; a record whose own issue is closed is `completed`.
- Cycles are detected over the **intended post-mutation** graph: curated
  records contribute the plan's edges, unclaimed existing issues keep the edges
  the evidence shows, and superseded issues contribute none. Because `#261`
  already proves the milestone graph is acyclic, a surviving cycle can only
  arise among existing queue edges — which is exactly what this check catches.
- Dependency edges are bounded to one registered project. A bare issue number
  must exist in this project's evidence; an explicitly qualified
  `owner/repo#number` reference to any other repository is refused.

## Collision protection

A record is **protected** — never mutated, never stolen, never duplicated — when
it holds an active implementation lease, is recovery-owned, already has an open
pull request, or carries the profile's `inProgress`/`done` label. A protected
record whose desired state differs is reported in `deferred` with the exact
reason and intent, and no operation is emitted for it.

The one-global-implementation-slot invariant is enforced twice: evidence
validation refuses more than one active implementation lease, and curation
refuses more than one `inProgress` record or an implementation lease held on a
different record than the `inProgress` label.

## Dry-run before mutation

Every mutation exists first as a dry-run operation in `curation.operations`.
Exactly three kinds are possible:

| Kind | Effect | Idempotent because |
| --- | --- | --- |
| `create-issue` | one new issue with a rendered body and queue label | only emitted when no record matches the curation key or title |
| `update-labels` | the issue's full resulting label set | only emitted when the current labels already differ |
| `update-dependencies` | the managed dependency block | only emitted when the current dependency set already differs |

There is no state, close, merge, deploy, assign, comment, dispatch or
source-activation operation, and no way to add one without changing
`QUEUE_MUTATION_KINDS`.

A dry-run operation describes the intended semantic mutation only. Issue bodies
are rendered from bounded, already-validated planner prose between stable
`<!-- agent-runner:queue-curation -->` markers, and the dependency block is
delimited by `<!-- agent-runner:queue-dependencies:start -->` /
`:end` so a client replaces exactly that block and never touches
human-authored body text.

## Mutation validation and bounds

`planQueueMutationTransaction` refuses, before any write:

- a disabled profile, or one without `mutationAuthority.issueMutation`;
- a repository, project id or branch that does not match the registered profile;
- a missing or malformed `currentSourceSha`, or one that has drifted since the
  evidence was taken — the mandatory time-of-check/time-of-use guard;
- an operation kind outside `QUEUE_MUTATION_KINDS`, or an endpoint outside the
  allowlisted `/repos/<owner>/<name>/issues[/<number>]` shapes;
- a label outside the profile's declared `ready`/`blocked` queue labels;
- an operation targeting leased, recovery-owned, open-PR or downstream-owned work;
- unbounded or unsafe issue text — oversized titles/scopes/criteria, shell or
  executable payloads, secrets, raw prompts/logs, machine-local paths;
- an operation count exceeding `mutationBounds.maxIssueMutationsPerRecurrence`.

Every operation carries the same attribution: project id, repository, branch,
exact source revision, `curationRevision` and `curationFingerprint`.

## The mutation port

This slice introduces **no new GitHub transport**. `applyQueueMutationTransaction`
takes an injected client implementing only what the transaction needs:

```
createIssue({ endpoint, title, body, labels, curationKey, attribution })  -> { number }
updateIssueLabels({ endpoint, labels, curationKey, issueNumber, attribution })
updateIssueDependencies({ endpoint, dependsOn, dependencyBlock,
                          blockStartMarker, blockEndMarker,
                          curationKey, issueNumber, attribution })
```

The label operation's request body (`{ labels: [...] }`) is exactly what the
existing accepted `GhCliGitHubWriteClient.mutateIssue()` in
`agent-runner-queue-triage-github-write.mjs` already accepts, so no second
label-mutation path is created. Wiring a live client is deliberately **not**
part of this slice: doing so requires the separately accepted authority that
`#266`'s stop conditions reserve.

GitHub offers no multi-issue atomicity. A mid-transaction failure is therefore
reported honestly as `partially-applied` with the exact remaining operations and
a `delayed-retry` outcome, rather than retried here or swallowed. Every
operation is individually idempotent and the curation is a pure function of its
evidence, so recomputing from fresh evidence converges on the same queue state.
A transaction may be applied at most once; a replay must recompute.

## Replay and idempotency

`curationRevision` and `curationFingerprint` are derived only from the project
identity, source revision, proposal fingerprint and queue-evidence fingerprint —
never from a clock or a random source. Consequences:

- identical inputs produce byte-identical `serializeManagerQueueCuration()`
  output and an identical fingerprint;
- a queue that already reflects a previous curation produces **zero**
  operations, `semanticChange: false` and `successorHint: 'none'`;
- incidental GitHub ordering of issues, labels or dependencies cannot change
  any result, because every list is normalized and sorted.

Curation converges rather than churning. A newly created issue can only record
dependencies on issues that already exist, so a plan curated onto an empty queue
settles over at most three passes: create the issues, fill in the now-known
dependency numbers, then report no semantic change. Each pass is idempotent and
the third pass is stable forever after.

## Event-kernel compatibility (`#289` → `#268`)

The curation outcome carries enough bounded semantics for a later controller to
choose a successor, and nothing more. Precedence is fixed and documented so the
same input always yields the same recommendation:

| Condition | `successorHint` | `successorReason` |
| --- | --- | --- |
| any escalation | `programme-reconcile-required` | `owner-decision-outstanding` |
| work created, or a record became ready | `execution-reconcile-required` | `ready-work-changed` |
| a mutation was deferred by active ownership | `delayed-retry` | `active-ownership-collision` |
| some other operation was emitted | `queue-assurance-required` | `queue-annotation-changed` |
| nothing changed | `none` | `no-semantic-change` |

An incomplete apply overrides the hint with `delayed-retry` /
`mutation-incomplete`.

This slice **recommends**; it never enqueues. `#289`'s
`agent-runner-management-events.mjs` remains the single owner of the durable
event ledger, dedupe/coalescing, claim leases, delayed events, causal successors
and the wake/recovery kernel, and `#266` neither imports nor re-implements any
of it — asserted directly against module source in
`agent-runner-manager-queue-curator-boundary.test.mjs`. Because a hint is a pure
function of the input, a repeated identical curation yields a repeated identical
hint, which the kernel's own fingerprint/coalesce dedupe collapses; the curator
never manufactures a state transition merely to wake something.

The curator also embeds no timer, hourly assumption, recurrence, sleep loop,
poll loop or project/role-specific scheduling, and no clock or random source at
all.

## Product boundary

Two things are escalated rather than decided:

- a proposed item whose `decisionType` is `product` is **never** materialized
  into the queue — `product-decision-required`;
- a curated open issue that the current plan no longer contains is **never**
  retired — `orphaned-curated-issue`.

Plan-level escalations from `#261` are carried through as `plan-escalation`.

## What this slice must never do

Issue or consume worker authority; invoke a provider; dispatch or wake a worker;
execute implementation work; merge, deploy, close an issue or activate source;
modify timers, services or scheduler authority; expand concurrency; or grant
Z790 scheduler authority. The boundary tests assert the absence of the
filesystem, network, database, child-process, clock, random and scheduling
surfaces that any of those would require.
