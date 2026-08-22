# Agent Runner event-driven management control plane

Issue: `TheTekTeam/agent-runner#268` (`BUILD.MANAGER.EVENT.LOOP.1`, parent
`#258`). Slice D — the replacement slice — built on the accepted management
event ledger from `#289`, the read-only planner from `#261`
(`docs/ops/AGENT-RUNNER-MANAGER-PLANNER.md`), the queue curator from `#266`
(`docs/ops/AGENT-RUNNER-MANAGER-QUEUE-CURATOR.md`), the worker authority and
settlement loop from `#267`
(`docs/ops/AGENT-RUNNER-MANAGER-AUTHORITY-REVIEW.md`) and the per-project
management profiles from `#259` (`docs/ops/AGENT-RUNNER-MANAGER-PROFILES.md`).

This slice turns three clock-driven management responsibilities into one
durable, causal, project-neutral management graph.

> **The external scheduled management tasks are still authoritative.** This
> repository does not disable, edit or duplicate `ModelSpend Programme Manager`,
> `Agent Runner Execution Manager` or `ModelSpend Queue Oversight`. Retiring them
> is a separate accepted programme action after independent review, accepted
> source activation and positive supervised field acceptance. Nothing here can
> perform it.

## The invariant

Events advance work; clocks do not.

```
material state transition
    -> durable bounded management event        (#289 ledger)
    -> single controller wake
    -> role handler re-reads authoritative evidence
    -> deterministic bounded transition
    -> result persisted
    -> successor event(s) durably enqueued in the same transaction
    -> next handler runs promptly
    -> repeat
```

There is no hourly recurrence, no manager cron and no per-role or per-project
timer. The only time-driven mechanism is a generic recovery scan whose entire
job is to recover events that already exist.

## The authoritative re-read rule

A management event is a **wake signal**, never authority and never proof.

| The event says | It never says |
| --- | --- |
| "pull-request evidence changed" | "merge this SHA" |
| "dependency evidence changed" | "issue #123 is now runnable" |
| "reconciliation is required" | "change these labels" |

Every handler is given a `collectEvidence` port and must call it before
deciding anything. This is why stale, replayed and out-of-order events are
harmless: they reconcile against current truth and degrade into a no-op rather
than executing a stale instruction.

The rule is also structural. The `#289` event schema has a fixed input
allowlist — event type, project, repository, issue, pull request, exact SHA,
correlation, predecessor, `not_before`, `deadline_at`. There is no field in
which an instruction could be carried, so a producer or a role cannot author
one even by mistake.

## The three roles

| Role | Event type | Mutating? | Inherits |
| --- | --- | --- | --- |
| Programme reconciliation | `programme-reconcile-required` | **yes** | Programme Manager / queue keeper |
| Execution reconciliation | `execution-reconcile-required` | continuation only | Execution Manager |
| Queue assurance | `queue-assurance-required` | **never** | Queue Oversight |

### 1. Programme reconciliation — the one mutating role

`scripts/ops/agent-runner-management-programme-role.mjs`

Re-reads authoritative evidence, runs the deterministic `#266` curation, applies
bounded mutation through the accepted `#266` boundary when authorised, chooses
the dependency-correct next work, and prepares exactly one `#267` worker
authority when every gate permits.

Bounded outcomes: `execution-required`, `assurance-required`, `delayed-retry`,
`blocked`, `owner-attention`, `quiescent`, `no-op`.

Gate order, highest first:

1. **Plan escalation** → `owner-attention`, and deliberately **no successor**.
   The curator's own hint names another programme reconciliation, which in an
   event loop is a self-loop no amount of re-reading can resolve. Owner
   attention is projected instead, and a later material transition re-wakes the
   graph.
2. **Incomplete mutation** → bounded `delayed-retry`.
3. **Occupied global implementation slot** → the owner is attributed from
   bounded evidence before anything is emitted. Exactly one live authority for
   this project gives `execution-required` with the **exact issue identity** (and
   the pull request and head when positively known). No live authority means the
   slot is held elsewhere → bounded `delayed-retry`; more than one candidate
   owner → `assurance-required`. An unattributed execution wake is never emitted,
   because the execution collector would correctly refuse it and nothing would
   progress. Nothing new is selected while work is in flight either way.
4. **Active ownership collision** → bounded `delayed-retry`.
5. **No runnable work** → `assurance-required` if the queue moved, else
   `quiescent` with no successor.
6. **Quota** → `available` is the only pass. `unavailable` and `ambiguous` both
   fail closed into a bounded delayed retry.
7. **Authority issuance** → exactly one `#267` authority, published but never
   consumed.

It never consumes the authority it issues: consumption belongs to the worker
domain and is not a capability any management role can hold.

### 2. Execution reconciliation — lifecycle follow-through

`scripts/ops/agent-runner-management-execution-role.mjs`

Operates only on work already selected and authorised. It binds evidence to the
exact authority, delegates the whole lifecycle decision to `#267`'s
`settleManagerLifecycle()`, and authorises a bounded same-pull-request
continuation through `authorizeManagerContinuation()` when one is warranted.

Outcomes mirror the accepted `#267` lifecycle classes: `continue-execution`,
`programme-reconcile`, `assurance-required`, `delayed-retry`, `blocked`,
`owner-attention`, `no-op`.

**Slot-freed wake.** When the lifecycle stops progressing an attempt —
the pull request is no longer open, the attempt is blocked, or an owner is
needed — `programme-reconcile-required` is enqueued immediately, with no delay.
This is the defect the issue was raised for: the slot no longer sits idle until
the next hourly pass.

It cannot select new work, curate a queue, mint a worker authority, merge,
close, deploy, activate source or approve its own review evidence.

### 3. Queue assurance — the read-only auditor

`scripts/ops/agent-runner-management-assurance-role.mjs`

Read-only is enforced three independent ways:

1. **No mutation import.** The module imports no queue-mutation, authority or
   continuation module, so there is no mutation function in its scope.
2. **No mutation capability.** `createAssuranceCapabilities()` refuses at
   construction time if a mutating port is even offered to it.
3. **No mutation channel in its output.** Its only outward effect is a bounded
   finding plus, for a correctable discrepancy only, one identity-only
   `programme-reconcile-required` successor.

Detections and their fixed severities:

| Severity | Findings |
| --- | --- |
| `blocking` | `security-boundary-breach`, `quota-policy-violation`, `credit-admission-observed`, `source-drift`, `project-identity-mismatch`, `scheduler-authority-drift`, `implementation-slot-contradiction` |
| `owner-attention` | `completion-without-evidence`, `same-pull-request-violation`, `unexpected-replacement-pull-request`, `duplicate-authority` |
| `correctable` | `stale-authority`, `wrong-sha-validation`, `false-ready-state`, `false-busy-state`, `idle-safe-capacity` |

Bounded outcomes: `clean`, `correctable-discrepancy`, `owner-attention`,
`blocked`. Only `correctable-discrepancy` wakes programme reconciliation, and it
never mutates the discrepancy itself.

## The generic event controller

`scripts/ops/agent-runner-management-controller.mjs`

```
resolve control mode  (fail closed)
  -> acquire the single mutating-manager lock  (active mode only)
  -> claim one due #289 event
  -> bind exactly one registered project       (fail closed)
  -> dispatch by allowlisted event type        (fail closed)
  -> resolve the role capability boundary
  -> await evidence collection, then run the deterministic transition
  -> persist the bounded decision, findings and projection
  -> settle + enqueue successors atomically    (#289 single transaction)
  -> wake again if an immediate successor exists
```

It contains no business logic: it knows event types and roles, not queues,
issues or pull requests. It contains no scheduler: one call drains what is due
now and returns.

**Persist, then settle, then wake.** Durability always completes before the
best-effort wake, so a lost wake costs latency, never work.

**Bounded causal depth.** `MAX_SUCCESSOR_CAUSAL_DEPTH` (48) sits below the
ledger's own hard bound of 64, so a long retry chain settles as an auditable
`causal-depth-exhausted` block rather than throwing inside the ledger
transaction.

**Handler failure.** The event stays claimed. Its lease expires, generic
recovery requeues it, and the ledger's attempt bound eventually dead-letters it.
That is a bounded retry with no hot loop and no crash.

## Control modes and fencing

`scripts/ops/agent-runner-management-control-mode.mjs`

| Mode | Claims events | Mutates | Meaning |
| --- | --- | --- | --- |
| `disabled` | no | no | Never configured. The default, so a fresh checkout manages nothing. |
| `shadow` | yes | no | Computes what it *would* do; every mutating port is suppressed. |
| `active` | yes | yes | The mutating manager authority. |
| `fenced` | no | no | Deliberate, audited emergency stop used by rollback. |

An absent, unrecognised or ambiguous mode resolves to a refusal: `processing`
and `mutating` are both false for everything not positively recognised. A mode
row this build does not understand reads as unknown rather than as something
permissive, so a downgrade can never reinterpret a newer mode.

`fenced` and `disabled` are kept distinct deliberately: rollback evidence needs
to tell "never turned on" apart from "deliberately stopped".

### One mutating manager

Only an `active` cycle takes the `manager-authority` lock. A second mutating
controller is refused with `manager-authority-held`. Shadow never takes the lock,
so it can neither contend with nor fence out the authority that can mutate. The
holder is stored only as a hash — a claim token never reaches persisted state.

### Capability matrix

| Capability | programme | execution | assurance |
| --- | --- | --- | --- |
| `collectEvidence` | ✓ | ✓ | ✓ |
| `applyQueueMutation` | active only | — | — |
| `publishWorkerAuthority` | active only | — | — |
| `publishContinuationAuthority` | — | active only | — |

A capability a role does not own is **absent** from its port object, not
present-and-refusing. `merge`, `closeIssue`, `deploy`, `activateSource`,
`dispatchWorker`, `consumeWorkerAuthority`, `enableTimer`, `disableTimer` and
`restartService` are refused by name for every role in every mode.

## Event producers

`scripts/ops/agent-runner-management-producers.mjs`

| Transition | Wakes |
| --- | --- |
| `github-evidence-settled` | programme |
| `dependency-readiness-changed` | programme |
| `merge-evidence-accepted` | programme |
| `source-activation-settled` | programme |
| `implementation-slot-freed` | programme |
| `assurance-discrepancy` | programme |
| `worker-ownership-changed` | execution |
| `worker-terminal-result` | execution |
| `implementation-published` | execution |
| `pull-request-published` | execution |
| `pull-request-head-changed` | execution |
| `required-checks-terminal` | execution |
| `review-actionable` | execution |
| `implementation-slot-occupied` | execution |

**Unchanged evidence produces nothing, and the suppression is durable and
producer-owned.** Every transition carries an `evidenceFingerprint`. The last
fingerprint that was successfully turned into a durable event is persisted in
`management_producer_state`, keyed by a scope derived from the producer kind and
the object identity — never from the caller's correlation id. So:

- suppression does not depend on a caller remembering what it last observed;
- it does not lapse once the previous event settles;
- it cannot be defeated by correlating the same observation differently;
- it survives a restart, because it is persisted rather than in memory.

The comparison, the enqueue and the fingerprint advance all happen **inside one
`BEGIN IMMEDIATE` transaction** (which is why the event ledger and the control
store are opened on one connection by `openManagementStores()`). Reading the
fingerprint before the transaction would leave a time-of-check window in which
two overlapping production processes both saw the old value and both enqueued;
taking the write lock first serialises them, so the second re-reads, sees the
first's committed fingerprint and suppresses. A fingerprint is therefore never
marked accepted before its event is durably stored, and a failed enqueue rolls
the fingerprint back — so a transient failure can never permanently suppress
required work. Genuinely new evidence still produces a wake; the ledger's own
coalescing then decides whether that wake merges into one already pending.

A producer may wake the manager. It may never author a decision.

### The recovery seam

`recoverDueManagementWork()` is the only time-driven mechanism. It recovers
events due after a restart or a lost wake, expires stale leases, and makes
delayed `not_before` events eligible. It decides nothing about which issue runs,
which project has priority, what authority to issue, whether a pull request is
acceptable, or whether a queue should change.

A delayed event becoming due is deliberately *not* a producer: nothing new
happened in the world, an event that already exists merely became eligible.

## Delayed work

All time-dependent manager work uses `#289` delayed events with a bounded
`not_before`: quota-reset retry, bounded external retry, transient GitHub
unavailability, check/review deadlines and lease-expiry follow-up. Retries are
bounded by attempt count, deadlines block, and exhausted events dead-letter.
Nothing busy-loops.

## Status projection

`scripts/ops/agent-runner-management-status-projection.mjs`

A bounded, positively-allowlisted per-project projection: project, repository,
objective, plan revision, milestone progress, ready/in-progress/blocked/review
/completed counts, critical path, current management event, lifecycle state,
recent bounded decisions, risks, blockers, next required event, owner attention,
control mode, revision and fingerprint.

**Semantic dedupe.** `updatedAt` is excluded from the fingerprint, so
re-projecting an unchanged project yields an identical fingerprint and the store
leaves the record alone — neither the revision nor the timestamp moves. Only a
real semantic change advances the revision, which is what stops a polling
dashboard from churning.

Prompts, provider output, transcripts, raw comments, logs, credentials, claim
tokens, environment values, command lines, machine-local paths and monetary
fields are refused by field name and by free-text scan. The programme role owns
the plan and queue facts; the execution and assurance roles revise only
lifecycle fields through `reviseManagementStatusProjection()` and can never
rewrite programme-owned facts.

## Observability

`ManagementControlStore` records bounded, token-only operational evidence:
`control-mode-resolved`, `manager-lock-acquired|refused|released`,
`event-claimed`, `event-coalesced`, `event-duplicate`, `handler-started`,
`handler-outcome`, `handler-refused`, `handler-failed`, `successors-created`,
`retry-scheduled`, `event-dead-lettered`, `assurance-finding`,
`projection-revised`, `projection-unchanged`. Retention is bounded; there are no
unrestricted logs.

`agent-runner-management-control-command.mjs status` answers, directly: is
management running, what event is pending, what is being reconciled, why is work
blocked, is a worker active, what is next, does owner attention exist, and is the
control plane shadow/active/fenced.

## Persistence

Additive tables in the **existing** controller SQLite database — no second state
store, no second authority format, no second queue curator, no second scheduler:

`management_control_mode_state`, `management_control_mode_audit`,
`management_control_locks`, `management_control_decisions`,
`management_control_findings`, `management_control_projections`,
`management_control_observations`, `management_producer_state` (durable semantic
dedupe), `management_authority_ledger` (the persisted `#267` ledger, which is
what makes duplicate-authority reconciliation survive a restart),
`management_authority_issuance` (the pinned issuance inputs) and
`management_publication_outbox` (the publication intent/confirmation record).

Event identity, claims, leases, delays, dedupe and successors remain `#289`'s.

`openManagementStores()` opens both stores on one shared connection, which is
what lets a producer commit an event and its semantic fingerprint atomically.

## Running it: the production path

The control plane is wired end to end and shipped. One command runs it:

```
npm run management:run -- --project-registry <path>
# or, with AGENT_RUNNER_PROJECT_REGISTRY already exported:
node scripts/ops/agent-runner-management-cycle-command.mjs
```

`agent-runner-management-cycle-command.mjs` performs, in order:

1. load the canonical project registry and the registered manager profiles;
2. open the controller SQLite database on one shared connection;
3. resolve the persisted control mode, failing closed on anything unknown;
4. **observe** material transitions from live evidence and durably enqueue those
   whose semantic fingerprint moved;
5. run **generic recovery** — expired leases, lost wakes, delayed eligibility;
6. **drain** due events through `runManagementControlCycle()` with the real
   production collectors;
7. print a bounded summary and exit.

It has no timer, no loop and no sleep. It processes what is due now and returns,
exiting cleanly when there is nothing to do.

### Where it runs

From the **existing generic** `agent-runner-event-polling.service`, which gained
one additional `ExecStart=-` line. That adds no unit, no timer and no
project- or role-specific manager schedule: the management cycle simply drains
due events from the one generic polling cycle Dell already runs, and the `-`
prefix keeps a management refusal from failing that cycle.

### The wake

`agent-runner-management-wake.mjs` best-effort nudges that same generic unit
(`systemctl --user start --no-block`) once an event is durable, so the controller
starts draining within seconds instead of at the next polling pass. It is off
unless `AGENT_RUNNER_MANAGEMENT_WAKE_UNIT` names an allowlisted generic unit, it
can only ever *start* one, and every failure path returns quietly — the event is
already durable, so a failed wake costs latency, never work.

### The evidence collectors

`agent-runner-management-collectors.mjs` builds every role's input from live
evidence and passes all of it through the accepted validators:

**programme** — the exact source SHA, the #261 evidence → brief → proposal chain
(from the registered plan document plus live instruction-document digests and
open issue/pull-request state), validated #266 queue evidence parsed back out of
the curated issue bodies, quota headroom, the global implementation slot, the
persisted authority ledger, the approved execution selection, the manager
producer identity, and one candidate request per bound plan item.

**execution** — the exact authority, rebuilt from its **pinned issuance
snapshot** and then proven against the persisted ledger; plus publication,
pull-request identity and exact head, exact-head checks, real review state, the
previous lifecycle settlement and the projection context.

Two identity rules govern this collector:

- *Exact attempt or nothing.* An execution wake must name its issue. An event
  with no issue identity, or an issue carrying more than one live grant, is
  refused as `ambiguous-attempt-identity` and settles **blocked** — it is never
  resolved by taking the first authority from the ledger.
- *Exact pull request and head.* `event.pullRequestNumber` is passed into the
  attempt read, and whatever comes back must reproduce the pull request, issue
  and head the event named. A substituted pull request or a read taken at
  another head is `attempt-identity-mismatch` and settles blocked, never a
  silent substitution.

No live authority for an identity remains a legitimate `no-op`.

### Why issuance is pinned

An authority's key depends on the curation fingerprint, which moves whenever
anything in the queue changes. Re-deriving an authority from *current* evidence
would therefore stop working the moment the queue moved — including when the
attempt's own grant took a lease on its issue. So at publication the exact
inputs the #267 transition consumed are persisted in
`management_authority_issuance`, and execution replays them through the same
validators. Issuance is a pure function, so the replay reproduces the identical
authority however far the live queue has since moved, and the rebuilt key is
checked against the ledger before it is used.

**assurance** — its own independent read-only observation, gathered separately
so the auditor never reads the derived state it is auditing.

`agent-runner-management-dell-adapters.mjs` supplies the real Dell reads (git,
`gh`, the accepted quota-only admission gate, the implementation lock, host
identity). Every adapter is injected, so the focused tests drive this same
production code with bounded fakes rather than a parallel path.

### The write path

The read adapter surface carries **no** write entry. Writes live in a separate
`agent-runner-management-write-adapters.mjs` transport, and `main()` hands the
cycle a **factory**, not an instance. The factory is invoked only after the
persisted mode resolves as `active`, so in shadow, fenced or disabled mode no
write object is ever constructed — there is nothing to suppress and nothing a
wiring mistake could reach. A regression spies on the factory to prove it is
never called outside active mode. Assurance never receives it under any mode.

The transport is bounded to three surfaces: the `#266` client port
(`createIssue`, `updateIssueLabels`, `updateIssueDependencies`), plus
`listIssueComments` and `createIssueComment` for authority publication.
Comment discovery is **paginated** to a bounded ceiling, because idempotency
depends on proving a packet is *absent* before posting — a single unpaginated
page would miss a packet beyond it and duplicate. If the ceiling is reached with
absence still unproven, the read fails closed rather than licensing a post. Every
endpoint is checked against the exact declared repository. There is no method
that closes an issue, merges, deploys, activates source, dispatches a worker or
touches a unit. A dependency update replaces **only** the delimited managed
block and fails closed if the markers are ambiguous, so human-authored body text
is never rewritten.

An `active` cycle with no write transport refuses to run
(`write-transport-unavailable`) rather than half-managing.

### Publication is reconciled, not fire-and-forget

Recording a grant locally and announcing it on GitHub cannot be one atomic act,
and both failure windows strand real work: a grant with no consumable packet
leaves the worker nothing to claim while the issue reads as owned, and a blind
retry after an ambiguous POST duplicates the packet.

`agent-runner-management-publication.mjs` makes publication a reconciled
transition backed by the `management_publication_outbox` table:

```
pin the issuance snapshot
  -> persist the publication intent            (pending)
  -> re-read the issue's comments
  -> exact packet already present? heal to confirmed, post nothing
  -> otherwise post exactly one canonical packet
  -> re-read and verify the exact authority key and packet digest
  -> only then mark confirmed
```

Every step is safe to repeat. An ambiguous result is never guessed at: the
record stays `pending` and the next pass re-reads first. A packet carrying this
authority's identity but a different immutable body is a terminal `conflict` —
never overwritten, never silently accepted. A pending publication is itself
ownership evidence, so no second authority can be issued for that issue while it
is unresolved, and `resumePendingPublications()` resumes it automatically on the
next cycle.

**The publication result decides the programme outcome.** An authority the
worker cannot actually read is not an issued authority, so programme
reconciliation reports what publication achieved rather than what it attempted:

| Publication | Programme outcome |
| --- | --- |
| `published` / `already-published` | `execution-required`, reason `authority-published` — normal execution successor |
| `pending-retry` | `delayed-retry`, reason `authority-publication-pending` — ownership and intent retained, **no** execution successor, recovery retries |
| `conflict` | `owner-attention`, reason `authority-publication-conflict` — **no** successor, only an owner can resolve it |

A port that reports nothing is treated as unconfirmed, never as success.

**Continuations recover the same way.** A continuation is pinned exactly as an
authority is — its own bounded snapshot plus its parent authority's — so an owed
continuation publication is rebuilt from persisted state alone after a total
process loss. No new execution event or GitHub evidence is required to retry it,
and the rebuilt continuation stays bound to the same repository, issue, pull
request, branch, base, exact head and parent authority.

The published body is the accepted `#267`
`renderManagerWorkerAuthorityPacket()` rendering, so the existing Agent Runner
consumer resolves it unchanged. The manager produces authority; it never
consumes, claims or dispatches it.

Continuation publication uses the same reconciliation. Its notice is
deliberately **not** a second worker-authority format: it mints no authority and
starts nothing, carrying only identity and bounded defect classification, while
`#267` keeps the continuation bound to the same repository, issue, pull request,
branch, base, exact head and parent authority.

**The implementation slot is a tri-state.** "I could not read the lock" must
never look like "the slot is free", so only a genuinely absent lock — or a
well-formed lock whose holder is gone, which the accepted lock contract treats
as recoverable — reports `free`. An unreadable or malformed lock reports
`ambiguous`, and programme reconciliation refuses to issue any authority while
the slot is ambiguous, taking a bounded delayed retry instead.

**Ownership includes pre-publication work.** An authority holds its issue from
the moment it is granted, before any pull request exists. GitHub cannot see
that, so the implementation lease is derived from the durable authority ledger
and merged with the ownership GitHub can prove — otherwise an active worker
would be invisible and the curator could hand its issue to a second attempt.

**Review evidence is real.** The pull-request review-decision field is not
consulted. Submitted reviews and unresolved review threads are read and reduced
with the accepted review-follow-up semantics, and reviews are filtered to the
**exact current head** first — so an approval of an earlier commit can never
approve current code; it simply leaves the head `pending`. Only bounded finding
identity is produced; no review prose ever reaches management state.

**Merge and activation are read from durable evidence.** A merged pull request
leaves the open list, so recently-closed pull requests are read too and a merge
is recognised only from explicit merged evidence — a pull request that merely
disappeared is never inferred to have merged. Source activation is read from the
bounded record the activation controller already writes, so a recurring
production cycle needs no operator-supplied expected SHA and can distinguish
applied from refused.

### The management plan document

`#261` validates a plan but deliberately produces none, so the authored parts —
objective, milestones, proposed work, approved execution parameters — come from
a checked-in, explicitly registered document per project:
`config/manager-plans/<projectId>.json`, loaded by
`agent-runner-management-plan-registry.mjs` exactly as `#259` loads profiles. No
directory scan, no provider call, no network. Everything revision-dependent (the
source SHA, evidence timestamps, live queue state) is injected at read time, so a
checked-in document can never pin a stale base. A project with no registered plan
is simply not planned yet, and nothing is reconciled for it.

Two projects are registered: `agent-runner` and `modelspend`. That is what lets
the second-project shadow acceptance gate run without a further repository
change, and a focused test validates every registered plan against its
registered profile.

## Supervised shadow acceptance, after merge

No further code is required. In order:

```bash
# 1. Activate the accepted source (existing separately accepted contract).

# 2. Put the control plane into shadow. Explicit and audited.
npm run management:mode -- --set shadow \
  --actor <operator> --reason "begin shadow acceptance" \
  --project-registry <path>

# 3. Run the production cycle. Observes live evidence, enqueues what moved,
#    recovers due work and drains it. Safe to run repeatedly.
npm run management:run -- --project-registry <path> \
  --expected-source-sha <accepted-sha>

# 4. Read the bounded decisions, projections, findings and observations.
npm run management:status -- --project-registry <path>

# 5. Evaluate the twenty acceptance probes.
npm run management:field-acceptance -- --project-registry <path>
```

Optionally export `AGENT_RUNNER_MANAGEMENT_WAKE_UNIT=agent-runner-event-polling.service`
to enable the immediate wake, and re-run the event-polling installer so the
generic unit also drains the graph on its existing cycle.

Throughout shadow, the three external scheduled managers remain authoritative
and enabled, and nothing the control plane computes is applied.

## Field acceptance

`scripts/ops/agent-runner-management-field-acceptance.mjs` provides twenty
bounded, read-only probes for supervised operator use **after merge**. A probe
with no evidence reports `not-evidenced` rather than passing: absence of proof is
never proof, and `accepted` is true only when every probe is positively
evidenced.

```
node scripts/ops/agent-runner-management-control-command.mjs field-acceptance \
  --project-registry <path> --db <controller.sqlite>
```

Probes: `exact-active-source`, `control-mode`, `one-manager-authority`,
`dell-only-controller`, `z790-not-scheduler`, `one-implementation-slot`,
`registered-project-projections`, `queue-idempotency`, `exact-worker-authority`,
`authority-consumption`, `pull-request-ci-wake`,
`execution-to-programme-successor`, `assurance-read-only`,
`duplicate-event-dedupe`, `stale-replay-safe`, `restart-recovery`,
`lost-wake-recovery`, `delayed-not-before`, `quota-ambiguity-fails-closed`,
`rollback-fencing`.

## Cutover and rollback

`scripts/ops/agent-runner-management-cutover.mjs` makes cutover mechanically
auditable. It does not perform it.

`buildCutoverReadiness()` reports every gate as outstanding unless it is
explicitly evidenced; readiness is never inferred. The external retirement gate
is modelled separately and can never be computed as satisfied from repository
state.

`planManagementRollback()` always orders fencing first:

1. `fence-event-manager` — set the mode to `fenced`. *(this repository)*
2. `verify-fenced` — confirm the persisted mode and the audit entry. *(this repository)*
3. `verify-no-mutating-authority` — confirm no manager lock is held. *(this repository)*
4. `reenable-external-scheduled-tasks` — **external operator action only.**

Two mutating authorities at once is the one outcome rollback must never produce,
so nothing can re-enable legacy management before fencing is verified — and this
tooling cannot perform step 4 at all.

## Subscription quota policy

Preserved exactly. Available quota headroom is the sole admission gate. There is
no account balance, credit, flexible credit, dollar cap, per-attempt budget,
auto-top-up or automatic paid/metered API fallback anywhere in this control
plane, and a boundary test asserts that no admission path reads one. Ambiguous
or unavailable quota fails closed into a bounded delayed retry.

## One global implementation slot

Unchanged. Programme reconciliation never authorises a second implementation
while a lease exists, recovery owns the target, pull-request ownership
represents ongoing work, or the collected global slot evidence reports the slot
occupied. `#267` re-enforces the invariant when the authority is issued, and
assurance independently reports a contradiction.

## Modules

| Module | Responsibility |
| --- | --- |
| `agent-runner-management-control-mode.mjs` | Control modes and the role capability boundary |
| `agent-runner-management-control-store.mjs` | Bounded decisions, findings, projections, mode audit, manager lock, observations |
| `agent-runner-management-status-projection.mjs` | Deterministic, deduplicated status projection |
| `agent-runner-management-role-result.mjs` | The one bounded role-result contract |
| `agent-runner-management-programme-role.mjs` | Role 1 — the mutating manager |
| `agent-runner-management-execution-role.mjs` | Role 2 — lifecycle follow-through |
| `agent-runner-management-assurance-role.mjs` | Role 3 — read-only auditor |
| `agent-runner-management-controller.mjs` | The generic event controller |
| `agent-runner-management-producers.mjs` | Material transitions → durable events, with durable semantic dedupe; the recovery seam |
| `agent-runner-management-observer.mjs` | The closed-allowlist observer that computes those transitions from live evidence |
| `agent-runner-management-collectors.mjs` | The production `resolvePorts` factory and the three role collectors |
| `agent-runner-management-dell-adapters.mjs` | Real Dell reads: git, `gh`, quota, implementation lock, host identity |
| `agent-runner-management-write-adapters.mjs` | Bounded production writes, constructed only in `active` mode |
| `agent-runner-management-publication.mjs` | Idempotent, recoverable authority and continuation publication |
| `agent-runner-management-plan-registry.mjs` | The registered per-project management plan document |
| `agent-runner-management-wake.mjs` | Best-effort wake of the existing generic Dell unit |
| `agent-runner-management-cycle-command.mjs` | **The production entrypoint** (`npm run management:run`) |
| `agent-runner-management-field-acceptance.mjs` | Twenty bounded read-only probes |
| `agent-runner-management-cutover.mjs` | Cutover gates and the ordered rollback plan |
| `agent-runner-management-control-command.mjs` | Bounded operator CLI |

## Validation

Focused suites: `agent-runner-management-*.test.mjs` — control modes and
capabilities, control store, status projection, all three roles, the event
controller, producers and durable semantic dedupe, structural boundaries, field
acceptance / cutover / CLI, and production wiring.

`agent-runner-management-production-wiring.test.mjs` drives the **shipped**
entrypoint and collector factory with bounded fake adapters — not a parallel
test-only path — and proves the whole chain: live evidence → observation →
durable event → wake → controller → real collectors → deterministic role →
atomic settlement → successor. It also proves shadow mutates nothing, active
grants exactly one authority and never a second, an unchanged second cycle
enqueues nothing, a suppressed wake still recovers through the generic scan, and
a collector failure isolates to its own project.

The boundary suite is the structural guard: it reads the shipped source to prove
the assurance role imports no mutation module, no management module contains a
timer or recurrence, no module branches on a specific project, no admission path
reads credit or a dollar cap, the slot is never widened, and the cutover tooling
cannot execute a command or disable an external task.
