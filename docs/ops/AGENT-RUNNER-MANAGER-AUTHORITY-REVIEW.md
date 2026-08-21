# Agent Runner manager authority and evidence settlement

Issue: `TheTekTeam/agent-runner#267` (`BUILD.MANAGER.AUTHORITY.REVIEW.1`, parent
`#258`). Slice C of the Build Manager replacement, built on the per-project
management profiles from `#259`
(`docs/ops/AGENT-RUNNER-MANAGER-PROFILES.md`), the read-only planner from `#261`
(`docs/ops/AGENT-RUNNER-MANAGER-PLANNER.md`), the durable management event
kernel from `#289` and the queue curator from `#266`
(`docs/ops/AGENT-RUNNER-MANAGER-QUEUE-CURATOR.md`).

This slice adds two things and nothing else:

1. **Authority issuance.** One accepted queue-curation record plus validated
   manager state becomes exactly one immutable worker authority.
2. **Lifecycle settlement.** Bounded worker-publication, pull-request,
   exact-head check and review evidence becomes exactly one bounded lifecycle
   class, plus — where a correction is warranted — one separately validated
   continuation of the already-authorised pull request.

It creates no scheduler, acquires no merge/close/deploy/source-activation
right, and never runs a worker.

## The two transitions

```
accepted curation record + profile + quota headroom + producer identity
    -> deterministic authority transition        (issueManagerWorkerAuthority)
    -> one immutable worker authority
    -> a separate worker domain consumes it      (authorizeWorkerAuthorityConsumption)

bounded publication / pull request / exact-head checks / review
    -> validated bounded evidence                (validateManagerSettlementEvidence)
    -> deterministic settlement transition       (settleManagerLifecycle)
    -> one bounded lifecycle class
    -> a later event controller decides the successor   (#268, not here)
    -> the durable ledger stores it                     (#289, not here)
```

Everything on the left of an arrow arrives already validated. Everything on the
right is a pure function of it: the same inputs always produce the same
identity, the same fingerprint and the same class.

The event a later controller may raise is a **wake signal, not authority**. A
`#268` handler must still re-read authoritative GitHub and controller evidence
before acting.

## Modules

- `scripts/ops/agent-runner-manager-worker-authority.mjs` —
  `issueManagerWorkerAuthority(input)` converts one ready, unowned curated
  record into one immutable authority.
  `authorizeWorkerAuthorityConsumption({ authority, consumer, ledger })` is the
  consumption-side half of the domain boundary.
  `renderManagerWorkerAuthorityPacket(authority)` serializes the authority as a
  canonical manager-preflight packet body and
  `workerAuthorityPacketDigest(authority)` is its immutability evidence.
- `scripts/ops/agent-runner-manager-settlement-evidence.mjs` —
  `validateManagerSettlementEvidence(raw, { authority })` normalizes the
  positive-allowlisted evidence snapshot and binds every identity in it to
  exactly one issued authority.
- `scripts/ops/agent-runner-manager-lifecycle-settlement.mjs` —
  `settleManagerLifecycle({ evidence, previousSettlement })` produces the
  bounded lifecycle result, and
  `authorizeManagerContinuation({ authority, settlement, producer, request,
  ownership })` authorises one bounded same-pull-request continuation.
- `scripts/ops/agent-runner-manager-authority-review-test-fixtures.mjs` —
  test-support only: builds the validated curation → authority → evidence chain
  from the same public transitions production callers use.

The authority module imports exactly one thing from the worker-dispatch side,
`isValidGitBranchName()` — a pure refname predicate, not dispatch behaviour — so
the producer cannot mint a branch the accepted consumer would reject.

## Authority identity reuses the accepted contract

No parallel authority format is introduced. An issued authority is expressed
through the already accepted machinery in
`scripts/ops/agent-runner-manager-authority.mjs`
(`docs/ops/AGENT-RUNNER-MANAGER-AUTHORITY-CODE-MAP.md`):

| Concept | Source |
| --- | --- |
| `authorityRevision` | `mwa:<32 hex>`, derived deterministically from the identity payload; matches the accepted revision pattern. |
| `authorityFingerprint` | `sha256:<64 hex>` content fingerprint of the full authority payload. |
| `authorityKey` | `managerAuthorityKey(revision, fingerprint)` — the same `manager-preflight:<revision>:<fingerprint>` claim identity. |
| Packet body | The same `<!-- agent-runner:manager-preflight -->` marker, `schema_version`, `producer_type`, `approved_agent`, `execution_phase`, `scope`, `required_validation` and `stop_conditions`, so `parseManagerPreflightPacket()` validates it unchanged. |
| Dispatch fields | `approved_repository_scope` (canonical single-item **list**), `approved_branch`, `base_commit`, `revision` and `fingerprint`, so `resolveDispatchAuthority()` resolves it unchanged. |
| Branch validity | `isValidGitBranchName()` from the accepted dispatch-authority contract, applied in addition to a narrower bounded length/charset pattern. |
| Post-publication edit detection | `packetBodyDigest(body)`. |

### Producing for the accepted consumer, never weakening it

A rendered packet must satisfy **both** accepted consumers, and the producer is
the side that adapts:

```
issueManagerWorkerAuthority()
    -> renderManagerWorkerAuthorityPacket()
    -> parseManagerPreflightPacket()      (admission shape)
    -> resolveDispatchAuthority()         (repository / branch / base resolution)
```

Two rules follow from that, both regression-locked in
`agent-runner-manager-authority-review-interop.test.mjs`:

- `approved_repository_scope` is emitted as a canonical **list with exactly one
  entry**. `resolveDispatchAuthority()` reads that key through `canonicalList()`
  and requires exactly one item, so the scalar `key: owner/repo` form would
  parse as a perfectly valid manager-preflight shape and then fail dispatch as
  `repository-scope-missing`. The producer emits the list; the resolver is not
  relaxed to accept a scalar.
- An authority can only bind a branch the accepted resolver would also accept.
  `validateBranch()` applies `isValidGitBranchName()` in addition to its own
  bounded pattern, so no authority can be minted for a ref that dispatch would
  later refuse as `branch-authority-malformed`.

`producer_type` gains exactly one new value,
`build_manager_authority_transition`, for this manager-domain producer. It is
not a relaxation of the runner boundary: the runner-generated refusal still
applies to every packet regardless of the producer type it declares.

One authority binds exactly one registered project, one canonical repository,
one issue, one exact accepted base commit, one implementation branch, one
approved adapter, one capability profile, one model, one effort, one validation
contract, one narrowly bounded scope, the stop conditions, the quota-headroom
admission state and the curation identity (`curationKey`, `curationRevision`,
`curationFingerprint`) it came from.

## Authority invariants

1. **One issue, one repository, one base.** All three come from the validated
   curation, never from the request.
2. **Exact branch.** The branch is a bounded, exact ref that satisfies the
   accepted `isValidGitBranchName()` rules, and can never be the project's
   default or any other approved integration branch.
3. **No widening.** A request may restate the approved adapter, capability
   profile, model and effort but never change one; any mismatch fails closed.
4. **No weakening.** The validation contract may gain checks; every check the
   registered profile requires always survives into the authority.
5. **No payload.** Scope and stop conditions are bounded authored text: control
   characters, local paths, secret-shaped tokens, shell payloads, raw
   prompt/log content and write-action phrasing are all refused.
6. **Immutable.** The returned authority is deeply frozen, and any edit to a
   published packet changes its body digest.
7. **Idempotent.** Re-issuing the identical authority while it is still
   unconsumed returns `outcome: 'duplicate-no-op'` with the same key rather
   than a second grant of ownership.
8. **Single consumption.** A ledger record in `consumed`, `settled` or
   `revoked` state fails closed for both issuance and consumption.
9. **No second owner.** A different authority for the same issue in `issued` or
   `consumed` state is a conflict, never a concurrent owner.
10. **Stale base fails closed.** `currentSourceSha` must still equal the base
    the curation was computed from.
11. **Ownership is never stolen.** An active implementation lease, recovery
    ownership, an open pull request or an in-progress/done label on the target
    record refuses the authority outright.
12. **One global implementation slot.** Any active implementation lease, and
    any in-progress label anywhere in the bounded queue evidence, refuses a new
    authority.
13. **Quota headroom only.** Only a positively `available` admission state
    issues an authority; `unavailable` and `ambiguous` both fail closed.
14. **Data, not action.** Issuance returns a frozen object. It starts nothing.

## Self-execution prohibition

The producer domain and the consumer domain are disjoint by construction:

```
manager domain produces authority   (AUTHORITY_PRODUCER_DOMAIN)
        |
        v
durably identifiable, publishable authority packet
        |
        v
worker domain consumes authority    (AUTHORITY_CONSUMER_DOMAIN)
        |
        v
the worker runs (elsewhere, never here)
```

- `issueManagerWorkerAuthority()` refuses any caller whose `producer.domain` is
  not the manager producer domain, so a worker-domain process can never mint
  authority — for itself or for anyone else.
- `authorizeWorkerAuthorityConsumption()` refuses any consumer whose `domain`
  is not the worker consumption domain, and refuses outright when the consumer
  identity equals the producer identity that minted the authority.
- `authorizeManagerContinuation()` applies the same producer-domain rule, so a
  worker can never mint its own successor or approve its own continuation.
- Neither transition selects a task: the curated record is named by the caller
  and validated against the curation, never discovered.

## Subscription quota policy

Admission is **current quota headroom and nothing else**. This slice preserves
the accepted `#256`/`#259` policy without change:

- the only admission input is `quotaAdmission.state`
  (`available` / `unavailable` / `ambiguous`) with the profile name it was
  measured for;
- no account credit balance is queried, inferred or required;
- no flexible-credit, auto-top-up or dollar-denominated per-attempt cap exists
  anywhere in the contract;
- there is no automatic fallback to a separately metered route.

Any field named after an account credit, a balance, a budget, a dollar cap, an
auto-top-up or a paid/metered fallback is refused **at any nesting depth** of
every input this slice accepts.

Historical immutable packets may still carry `max_budget_usd`. They remain
parseable for compatibility — `parseManagerPreflightPacket()` accepts them and
`resolveManagerPreflightExecutionMetadata()` deliberately ignores the field —
but the value can never become an admission or execution decision, and a
rendered `#267` authority packet never contains one.

## Bounded settlement evidence

Only the facts needed to decide lifecycle state are admissible:

| Part | Admitted |
| --- | --- |
| Worker publication | authority key/fingerprint, attempt id, published head SHA, bounded completion state, bounded changed-file count/paths, insertions/deletions, bounded validation results, pull-request number, one bounded summary. |
| Pull request | number, branch, base SHA, exact head SHA, open/closed/merged state, draft flag, bounded mergeable-state token, bounded changed-file metadata, bounded review decision. |
| Checks | exact tested head SHA, check identity, terminal/pending state, required flag, bounded failure classification. |
| Review | reviewed pull request and exact head, bounded findings with severity, category, actionability and one bounded summary. |

Everything else is **refused, not redacted**: prompts, provider responses, raw
output, transcripts, stdout/stderr, unrestricted logs, environment dumps,
tokens, credentials, secrets, command lines, local machine paths, worktree
paths and monetary fields all fail closed, as do unknown fields, oversized
strings, malformed SHAs, malformed repository identity, cross-project identity,
arbitrary URLs and shell payloads.

Identity binding is exact. Evidence is refused when the attempt is not the
authorised one, the branch or base is not the authorised one, the publication
head no longer matches the pull-request head, checks were produced against any
commit other than the exact current head, or a review describes another pull
request or an earlier head. Completion is never inferred from worker prose,
from a branch existing, from a commit existing, from a pull request existing
alone, or from a stale check run.

## Lifecycle classes and precedence

| Class | Meaning | Successor hint |
| --- | --- | --- |
| `continue-execution` | A bounded defect on the existing authorised pull request can be corrected safely. | `execution-reconcile-required` |
| `programme-reconcile` | Queue/dependency/plan state must be re-read. | `programme-reconcile-required` |
| `assurance-required` | The implementation looks terminal, or the check state is ambiguous; independent assurance must resolve it. | `queue-assurance-required` |
| `delayed-retry` | An external condition is temporarily unresolved. | `delayed-retry` |
| `blocked` | A deterministic prerequisite cannot currently be satisfied. | `programme-reconcile-required` |
| `owner-attention` | A material product or policy decision is required. | `programme-reconcile-required` |
| `no-op` | Nothing to settle, or identical already-settled evidence replayed. | `none` |

Precedence is a fixed, ordered rule list, so two simultaneously true conditions
always resolve the same way:

1. no worker publication → `no-op`;
2. the authorised pull request is no longer open → `programme-reconcile`;
3. the attempt was abandoned → `owner-attention`;
4. a blocking finding is not actionable → `owner-attention`;
5. the publication failed → `blocked`;
6. completion claimed with no pull-request evidence → `blocked`;
7. incomplete with no pull request → `delayed-retry`;
8. incomplete on the authorised pull request → `continue-execution`;
9. no exact-head check evidence → `delayed-retry`;
10. a required check failed at the exact head → `continue-execution`;
11. a required check is ambiguous (`cancelled`/`neutral`) → `assurance-required`;
12. a required check is pending → `delayed-retry`;
13. no required check was reported → `delayed-retry`;
14. the review requests actionable changes → `continue-execution`;
15. the review is missing or pending → `assurance-required`;
16. the review reports no blockers → `assurance-required`.

A settlement never schedules a worker, enqueues a `#289` event, invokes a
provider, integrates, closes, deploys or activates a source. It returns a
bounded result for `#268` to consume later.

The settlement preserves the exact project, repository, issue, authority,
attempt, base, branch, pull-request number, current head, evidence revision and
evidence fingerprint, plus its own `settlementFingerprint`.

## Continuation

A review or check defect is corrected on the **same** authorised pull request.
There is deliberately only one continuation kind, `same-pull-request`: no
replacement pull request is ever created because a correction is needed.

`authorizeManagerContinuation()` is a separately validated manager transition.
It requires a `continue-execution` settlement carrying at least one bounded
defect, and fails closed when the pull request, branch, repository, issue or
base identity would change, when the requested head is not the exact settled
head, when the target issue is recovery-owned, when an implementation lease is
held on another issue, when the issue owns more than one open pull request,
when the open pull request has moved to another head, or when the owning
workspace belongs to another branch or another attempt.

The continuation carries the same adapter, capability profile, model, effort,
validation contract and stop conditions as its parent authority, plus the
bounded defect list, the parent authority identity and its own deterministic
`continuationRevision`/`continuationFingerprint`/`continuationAuthorityKey`.

## Replay and idempotency

- Authority issuance and settlement are deterministic and clock-free: identical
  input always yields identical revisions, fingerprints and classes.
- Re-issuing an identical unconsumed authority is a `duplicate-no-op`.
- Settling identical evidence against its own prior settlement yields
  `no-op` / `replayed-settled-evidence` rather than repeated follow-up work.
- Evidence whose sequence precedes the already-settled sequence fails closed.
- Evidence reusing an already-settled sequence with different content fails
  closed.
- A previous settlement belonging to another authority or another attempt fails
  closed.

Ordering uses a caller-supplied monotonic `evidenceSequence`, never a clock
read, so replay detection stays deterministic.

## Event-kernel compatibility (`#289` → `#268`)

`SETTLEMENT_SUCCESSOR_HINTS` mirrors the `#289` management-event type names (and
`#266`'s hint set) so a later controller can bind a successor without
translation. This slice never enqueues, coalesces, leases, delays or wakes
anything: `agent-runner-management-events.mjs` remains the single owner of the
durable ledger, dedupe, leases, delayed events and wake primitives, and the
authority/settlement modules neither import nor shadow any of them.

No timer, recurrence, hourly assumption, sleep loop, poll loop, cron entry or
systemd unit is introduced or implied.

## What this slice must never do

- run, dispatch or schedule a worker, or invoke a provider;
- mint authority for itself, select its own next task, broaden its own
  authority, mint its own successor or approve its own continuation;
- integrate a pull request, close an issue, deploy, activate a source, change
  labels as general programme management, or alter a timer, service or
  scheduler topology;
- expand implementation concurrency or change the project registry;
- consult an account credit balance, impose a dollar cap, or fall back to a
  separately metered route;
- persist a prompt, a provider response, a credential, an environment dump, a
  raw log, a command line or a local path in manager-visible state;
- accept a curation, authority, evidence or settlement object that was not
  produced by the corresponding validated transition.
