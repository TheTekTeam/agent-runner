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
3. **Occupied global implementation slot** → `execution-required`. Nothing new
   is selected while work is in flight.
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

**Unchanged evidence produces nothing, structurally.** A transition is accepted
only with an `evidenceFingerprint`. If it equals the previous fingerprint, no
event is produced — not because a caller remembered a flag, but because the
semantic fingerprint did not move. Cosmetic GitHub updates, repeated polls,
unchanged queue evidence and repeated status reads therefore cannot generate
events.

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
`management_control_observations`.

Event identity, claims, leases, delays, dedupe and successors remain `#289`'s.

## Wiring the evidence collectors

The control plane is complete and injectable. Cutover wires one `resolvePorts`
factory that returns, per role:

**programme** — `collectEvidence` returns
`{ sourceSha, queueEvidence, quotaAdmission, implementationSlot, authorityLedger, execution, producer, candidateRequests }`,
where `queueEvidence` must be a snapshot produced by the accepted
`validateManagerQueueEvidence()`; plus `applyQueueMutation` (returns a `#266`
client port) and `publishWorkerAuthority`.

**execution** — `collectEvidence` returns
`{ authority, settlementEvidence, previousSettlement, ownership, continuationRequest, producer, projectionContext }`,
where `authority` and `settlementEvidence` must carry provenance from
`issueManagerWorkerAuthority()` and `validateManagerSettlementEvidence()`; plus
`publishContinuationAuthority`.

**assurance** — `collectEvidence` returns the bounded plain-data observation
described in the assurance module. Read-only: no other port may be supplied.

Each contract is validated at the role boundary, so a mis-wired collector fails
closed rather than reconciling on partial evidence.

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
| `agent-runner-management-producers.mjs` | Material transitions → durable events; the recovery seam |
| `agent-runner-management-field-acceptance.mjs` | Twenty bounded read-only probes |
| `agent-runner-management-cutover.mjs` | Cutover gates and the ordered rollback plan |
| `agent-runner-management-control-command.mjs` | Bounded operator CLI |

## Validation

Focused suites: `agent-runner-management-*.test.mjs` — control modes and
capabilities, control store, status projection, all three roles, the event
controller, producers, structural boundaries, and field acceptance / cutover /
CLI.

The boundary suite is the structural guard: it reads the shipped source to prove
the assurance role imports no mutation module, no management module contains a
timer or recurrence, no module branches on a specific project, no admission path
reads credit or a dollar cap, the slot is never widened, and the cutover tooling
cannot execute a command or disable an external task.
