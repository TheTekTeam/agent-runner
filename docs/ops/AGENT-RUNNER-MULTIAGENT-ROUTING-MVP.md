# Serial multi-agent selector and queued-only reassignment MVP (issue #50)

Status: **implementation and testable shadow/reconciliation MVP only.**
Nothing in this document authorises live Codex, Grok, or Ollama execution,
automatic paid routing, concurrency, or timer enablement. Codex CLI and
Grok CLI remain `command: null`, `implemented: false`, disabled, and
non-routable in every committed/default/example setting after this issue,
exactly as before it. See `#41` for the MVP sequencing this slice belongs
to; supervised per-adapter canaries and the final full-repository
integration validation are explicitly deferred to that later gate.

## Goal

Make the runner able to use multiple installed agents serially and safely.
One global execution slot runs at a time; each queued issue may be routed
to an enabled, implemented, and qualified agent, with an eligible explicit
assignment always preserved. This issue adds the selector, qualification,
settings-revision, and queued-reconciliation boundaries around the
scheduler's existing candidate-discovery, manager-preflight-authority, and
claim contracts — it does not replace them.

## Atomic machine-local settings snapshot

`scripts/ops/agent-runner-agent-settings.mjs` adds `snapshotAgentSettings()`:
a whole-file settings read, taken exactly once. The immutable
`sha256:`-prefixed revision is computed over those exact bytes, and the
per-agent view returned (`lifecycle`, `qualification`, `paidUse`) is a
bounded, sanitized projection — the raw document, `executablePath`,
`endpoint`, `sessionSecretRef`, and every other adapter-specific field never
enter the returned snapshot, any decision, SQLite row, GitHub comment, or
test output.

`claude-code-cli` is the sole exception to the fail-closed
`SAFE_DEFAULT_AGENT_LIFECYCLE`/unqualified defaults: because the existing
scheduler claim path has never consulted this settings file for Claude, an
absent `claude-code-cli` entry defaults to enabled with wildcard
qualification, preserving today's "Claude just works" behaviour on every
deployment that has never configured this file. An explicit entry can still
disable, pause, or drain Claude. Every other agent id keeps the original
fail-closed default: no entry means fully non-routable and unqualified.

`settingsRevisionUnchanged(atSelection, fresh)` requires an exact revision
match with no parse error on either side; `claude-runner-cron.mjs` calls it
immediately before an execution claim (see below) and fails closed —
before any GitHub mutation, claim persistence, runner-start comment, or
worker launch — on any mismatch, missing revision, or malformed snapshot.

## Conservative qualification model

`scripts/ops/agent-runner-qualification.mjs` matches an agent's
`{ taskClasses, riskClasses, models, harness }` qualification profile
against an issue's classification. A wildcard (`*`) entry matches
anything, including an unclassified issue; a specific, non-wildcard list
never matches an unclassified issue, and an empty list never matches
anything — "missing qualification means unqualified" is the same formula
in both directions. `models`/`harness` are supplementary: an issue that
does not explicitly request one is never blocked by an agent's list for
it.

`ollama-agent` additionally carries a structural, code-enforced boundary
(`ollamaRiskBoundaryPasses`): it is eligible only when the issue's risk
class is the exact string `"low"`, regardless of what a settings file or
test fixture claims — a settings-only `riskClasses: ['low', 'medium']`
entry still cannot route a `medium`-risk issue to Ollama.

`scripts/ops/agent-runner-qualification.mjs#classifyIssueTaskRisk()` reads
explicit `task:`/`risk:`/`model:`/`harness:` labels and matching
project-field names, built only from `issue-metadata.mjs`'s already-exported
generic primitives (`findFieldValue`, `labelNames`, `normaliseToken`) —
`issue-metadata.mjs` itself needed no functional change and stays
byte-identical to its locked migration import. Missing metadata classifies
as `null` (unclassified) rather than a guessed permissive class, and a
project-field value that disagrees with the label value also classifies as
`null` — a conflict is never silently resolved to either side.

## Deterministic serial selector

`scripts/ops/agent-runner-routing.mjs#selectAgentForIssue()` is a pure,
first-eligible-match scan over a caller-ordered candidate list — no
weighting, randomness, or model-generated ranking. `evaluateAgentEligibility()`
checks, per candidate: catalogue membership, `implemented`, lifecycle
(`enabled`/`disabled`/`paused`/`draining`), an optional readiness signal,
task/risk/model/harness qualification, an optional agent-local resource
block, and — for the two paid adapters (`codex-cli`, `grok-cli`) — the
automatic-routing-approval bundle below. An eligible explicit assignment is
always retained over any alternative. `GLOBAL_EXECUTION_SLOT_CAPACITY` is
`1`; `hasGlobalSlotAvailable()` is the only capacity check anywhere in this
issue's code, and nothing here adds a second one.

**Claude's quota block is agent-local** (requirement 6): a quota-blocked
`resourceState` excludes only `claude-code-cli` from the candidate list; a
different candidate's own eligibility is assessed independently. In
`claude-runner-cron.mjs`, `hasImplementedRoutableAlternative()` is a cheap,
catalogue-level pre-check run once per pass: because the real, committed
catalogue has zero implemented non-Claude adapters, this is always `false`
today, so a Claude quota block still idles the whole pass exactly as
before this issue. Only once a real alternative adapter is implemented,
enabled, and qualified does the per-issue path — Claude excluded by its
own block, an independently eligible alternative still assessed — become
reachable. Claude's own quota protection is unchanged when Claude is
selected.

## Paid-agent automatic routing

Codex CLI and Grok CLI are never automatic paid fallbacks merely because
they are installed, enabled, or qualified. `evaluateAgentEligibility()`
additionally requires, for either adapter: `implemented: true`,
`automaticRoutingApproved === true`, `paidUseApproved === true`, and a
strictly positive `maxCostUsdPerRun` or `maxTokensPerRun`. Every committed
example (`AGENT_SETTINGS_EXAMPLE` / `.agent-runner/agent-settings.example.json`)
sets `automaticRoutingApproved: false`. This gate applies uniformly to both
an automatically-selected candidate and an issue's explicit
`agent:codex-cli`/`agent:grok-cli` assignment — an explicit label never
bypasses it, and today it is moot in either case because both adapters stay
`implemented: false`.

## Queued-only reassignment

`scripts/ops/agent-runner-reassignment.mjs` is reachable only for a
`status:ready` (queued, unclaimed) issue. `evaluateReassignmentPreconditions()`
requires eight guards each proven `=== false` explicitly — active lease,
unfinished attempt, in-progress ownership, linked open PR, review/recovery
state, handoff in progress, conflicting branch/worktree, unresolved
workspace ownership — plus an exact settings-revision match and identical
live labels between the planning read and right now. `undefined`/`null`/
`true` on any guard fails closed exactly like `true` does; there is no
default-permissive path.

`planLabelMutation()`/`verifyLabelMutation()` compute and then prove the
exact label delta: every existing supported `agent:*` label removed, the
one replacement label added, every unrelated label untouched, and the
issue re-read afterward to prove exactly one supported agent label remains
and it is the replacement. A clean `gh` exit code alone is never accepted
as proof. `applyPlannedReassignment()` performs the mutation only through
injected `mutateLabels`/`readLiveIssue` functions and reports a GitHub
mutation failure or an unavailable/mismatched post-mutation read as
non-success — never as a silent success.

In `claude-runner-cron.mjs`, `attemptQueuedReassignment()` gathers the real
precondition signals (`activeRecoveryAttempts`, `listOpenPullRequests` +
`findLinkedOpenPullRequests`, a handoff-heading scan of live comments,
`localRecoveryConflicts`) fresh, at reassignment time — never reusing the
stale signals `selectIssue()` gathered during its scan — and applies at
most one reassignment per pass, mirroring the single global execution
slot. A blocked precondition writes nothing at all: silence, not a
comment, is correct for legitimately ambiguous or active work, and it also
means a repeatedly-blocked candidate never accumulates duplicate evidence.

## Manager authority after reassignment

The runner never posts `MANAGER_PREFLIGHT_MARKER` or an authority-revoking
heading. `ROUTING_ATTENTION_MARKER`
(`<!-- agent-runner:routing-attention:v1 -->`) is a distinct, sanitized,
non-authority evidence marker — proven, by test, to never match
`isManagerPreflightRevocation()` and to never contain the manager preflight
marker. A reassigned issue is not selectable again until a fresh
`normal_chatgpt_manager_session`/`chatgpt_scheduled_task` packet whose
`approved_agent` names the replacement agent is posted.

`agent-runner-manager-authority.mjs#managerAuthorityApprovesAgent()` is the
single new comparison point: `claude-runner-cron.mjs`'s `selectIssue()`
calls it right after a candidate's manager authority resolves, and fails
closed — before claim, status mutation, runner-start comment, or worker
launch — on any mismatch between `approved_agent` and the agent this pass
actually resolved.

## No-qualified-agent outcome

When a queued issue's explicit agent is ineligible and no alternative is
eligible either, `recordNoQualifiedAgentEvidence()` records one
deduplicated `routing_events` row (`event_type: 'no-qualified-agent'`,
keyed by `(repo, issue, settings revision)`) and posts the evidence comment
only the first time that row is actually inserted — proven by test across
two full reconciliation passes. No worker is launched, no manager packet is
consumed, and no claim is created.

## Durable evidence: `routing_events`

`scripts/ops/claude-runner-state.mjs` adds a `routing_events` table
(schema v11) with a `UNIQUE` `dedupe_key` — `recordRoutingEvent()` is an
`INSERT OR IGNORE` and reports whether the row was actually new, which is
the gate every GitHub comment above is posted behind. `payload_json` is
caller-bounded and never receives raw settings, credentials, paths,
endpoints, prompts, or provider text.

## Code map

| File | Change |
| --- | --- |
| `scripts/ops/agent-runner-agent-settings.mjs` | `snapshotAgentSettings()`, `settingsRevisionUnchanged()`, per-agent qualification/paid-use normalization, Claude's permissive absent-entry default |
| `scripts/ops/agent-runner-agent-settings.test.mjs` | snapshot/revision/qualification/paid-use coverage |
| `.agent-runner/agent-settings.example.json` | adds `qualification` blocks and `automaticRoutingApproved: false` to codex-cli/grok-cli/ollama-agent |
| `scripts/ops/issue-metadata.mjs` | unchanged — this migration-locked file needed no functional edit; `classifyIssueTaskRisk()` is built entirely from its existing exported primitives (see below) |
| `scripts/ops/issue-metadata.test.mjs` | not added — no functional change to cover |
| `scripts/ops/agent-runner-qualification.mjs` | new — conservative qualification matching, Ollama's structural risk boundary, `classifyIssueTaskRisk()` (task/risk/model/harness classification) |
| `scripts/ops/agent-runner-qualification.test.mjs` | new — includes classification and conflict-handling coverage |
| `scripts/ops/agent-runner-routing.mjs` | new — deterministic serial selector |
| `scripts/ops/agent-runner-routing.test.mjs` | new |
| `scripts/ops/agent-runner-reassignment.mjs` | new — queued-only precondition proof, label mutation plan/verify, evidence bodies |
| `scripts/ops/agent-runner-reassignment.test.mjs` | new |
| `scripts/ops/agent-runner-manager-authority.mjs` | `managerAuthorityApprovesAgent()` |
| `scripts/ops/agent-runner-manager-authority.test.mjs` | coverage for the new comparator |
| `scripts/ops/claude-runner-selection.mjs` | unchanged — already exposes `managerAuthority.approvedAgent`; no functional edit needed |
| `scripts/ops/claude-runner-selection.test.mjs` | new — regression-proofs the `approvedAgent` contract `claude-runner-cron.mjs` now depends on |
| `scripts/ops/claude-runner-cron.mjs` | settings snapshot per pass, agent-local Claude quota gate, per-candidate eligibility/qualification/approved-agent checks in `selectIssue()`, pre-claim revision re-check, reassignment/no-qualified-agent wiring in `main()` |
| `scripts/ops/claude-runner-cron.test.mjs` | new selector/reassignment/no-qualified-agent/settings-revision coverage, all 155 pre-existing tests still passing unmodified |
| `scripts/ops/claude-runner-state.mjs` | `routing_events` table (schema v11), `recordRoutingEvent()`, `hasRoutingEvent()` |
| `scripts/ops/claude-runner-state.test.mjs` | dedup/idempotency coverage |
| `scripts/ops/claude-runner-cron.mjs` (control-readiness/control-instances) | no functional change was required — `agent-runner-control-readiness.mjs`/`agent-runner-control-instances.mjs` already expose the readiness/qualification-adjacent primitives this issue reused; their existing tests remain green |

## Known limitations and deferred gates

- **Live readiness probing is not wired into the selector.** `evaluateAgentEligibility()` accepts an optional `readiness` signal and is tested against it directly (`agent-runner-routing.test.mjs`), but `claude-runner-cron.mjs` does not yet call `agent-runner-control-readiness.mjs#computeInstanceReadiness()` per pass. This is a reasonable, disclosed gap: the sole implemented adapter (`claude-code-cli`) has no existing readiness dependency in cron.mjs today, so wiring it is left to a follow-up.
- **The "alternative agent selected" and "reassignment applied" code paths are structurally unreachable against the real, committed catalogue** (every non-Claude adapter stays `implemented: false`) and are therefore exercised only through dependency-injected pure-function tests (`agent-runner-routing.test.mjs`, `agent-runner-reassignment.test.mjs`) and a synthetic-adapter cron-level check (`hasImplementedRoutableAlternative`), not a live `claude-runner-cron.mjs` run against a real second implemented adapter. Making the production catalogue injectable for that purpose was out of this issue's scope.
- **The eight reassignment precondition guards reuse existing recovery/lease/PR/branch signals** (`activeRecoveryAttempts`, `listOpenPullRequests`, a handoff-heading comment scan, `localRecoveryConflicts`); a dedicated, broader "review state" probe beyond those signals is deferred.
- Supervised per-adapter canaries, live routing enablement, concurrency, and the recurring execution timer remain gated on the later `#41` MVP integration milestone, unchanged by this issue.
- **`scripts/ops/issue-metadata.mjs` was deliberately left byte-identical to its `MIGRATION-MANIFEST.json` `"locked"` import.** An earlier draft added `taskClass`/`riskClass`/`model`/`harness` fields directly to that module, which broke `agent-runner-manifest-provenance.test.mjs`'s hash check. Rather than editing `MIGRATION-MANIFEST.json`/`CANONICAL-OWNERSHIP.json` (both outside this issue's code map), the classification logic was relocated into `agent-runner-qualification.mjs#classifyIssueTaskRisk()`, built entirely from `issue-metadata.mjs`'s pre-existing exports (`findFieldValue`, `labelNames`, `normaliseToken`). No non-code-map file was modified.
