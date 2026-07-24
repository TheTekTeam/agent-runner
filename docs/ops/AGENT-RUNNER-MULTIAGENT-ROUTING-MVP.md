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

**There is no implicit Claude fallback anywhere in the multi-agent selector
path.** `claude-code-cli` uses the exact same fail-closed
`SAFE_DEFAULT_AGENT_LIFECYCLE`/unqualified defaults as every other agent id
inside `snapshotAgentSettings()`/`normalizeAgentQualification()`: an absent
or malformed `claude-code-cli` entry is fully non-routable and unqualified,
identically to `codex-cli`/`grok-cli`/`ollama-agent`.

Instead, "today's Claude just works" behaviour is preserved by a distinct
**selector-engagement** boundary in `claude-runner-cron.mjs#main()`, not by
a permissive default inside the settings module: the multi-agent selector
(and every strict check it brings — explicit settings, explicit task/risk
classification, proven readiness) is engaged for a pass **only when
`snapshotAgentSettings()` reports `fileFound: true`** — i.e. a real
machine-local settings document actually exists on disk. When no document
exists at all, `settingsSnapshot` is not passed into `selectIssue()`/the
pre-attempt revision check, and Claude's pre-issue-#50 legacy execution path
(which has never read this file) runs completely unaffected — this is what
keeps every real, currently-unlabeled-for-classification production Claude
deployment working unchanged today. A document that is *present but
malformed* (`fileFound: true`, `parseError` set) is a different case: the
selector *is* engaged, and its uniform fail-closed defaults make every
agent — including Claude — unqualified until the document is fixed. This
engagement boundary is this correction round's own interpretation of an
inherent tension in the review comment (see "Known limitations" below for
the reviewer to confirm or correct).

`settingsRevisionUnchanged(atSelection, fresh)` requires `fileFound: true`
on **both** snapshots (two "file not found" reads never count as
"unchanged," even though they share the same synthetic revision over empty
bytes), an exact revision match, and no parse error on either side.
`claude-runner-cron.mjs#main()` calls it immediately before any new
`recovery_attempts`/worktree-identity row is created — not merely before the
execution claim itself — so a settings-revision change between selection and
this point now creates zero attempt rows, not just zero claims, before any
GitHub mutation, claim persistence, runner-start comment, or worker launch.

## Conservative qualification model

`scripts/ops/agent-runner-qualification.mjs` matches an agent's
`{ taskClasses, riskClasses, models, harness }` qualification profile
against an issue's classification. **An unclassified (`null`) task/risk
value never matches — not even a wildcard-qualified agent.** A wildcard
(`*`) entry matches any *known, explicit* class; a specific, non-wildcard
list never matches an unclassified issue either; and an empty list never
matches anything. Missing or conflicting task/risk metadata is therefore
never turned into an eligible class by a wildcard — a real, queued issue
needs an explicit `task:`/`risk:` label (or matching project field) before
any agent, Claude included, can be found eligible once the multi-agent
selector is engaged (see the settings-snapshot section above).
`models`/`harness` are supplementary: an issue that does not explicitly
request one is never blocked by an agent's list for it.

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
(`enabled`/`disabled`/`paused`/`draining`), **a mandatory readiness signal**,
task/risk/model/harness qualification, an optional agent-local resource
block, and — for the two paid adapters (`codex-cli`, `grok-cli`) — the
automatic-routing-approval bundle below. An eligible explicit assignment is
always retained over any alternative. `GLOBAL_EXECUTION_SLOT_CAPACITY` is
`1`; `hasGlobalSlotAvailable()` is the only capacity check anywhere in this
issue's code, and nothing here adds a second one.

**Readiness is mandatory, not optional.** A missing readiness result
excludes the candidate with the fixed reason code `readiness-not-proven`,
identically to a proven-unhealthy one (`agent-unhealthy-or-not-ready`) —
absence of a probe result is never read as passing. `claude-runner-cron.mjs`
wires this to the existing deterministic, zero-process-spawn
`agent-runner-control-readiness.mjs#computeInstanceReadiness()` boundary via
`computeReadinessByAgentId()`/`boundedReadiness()`: only the two booleans
`{ healthy, ready }` ever reach `evaluateAgentEligibility()` — the raw
`probes`/`detail` fields (which can carry a resolved executable path) are
dropped before the value leaves `claude-runner-cron.mjs`. Readiness is only
computed (and the selector only strict-gates on it) when the multi-agent
selector is engaged for the pass; Claude's quota-preflight-derived
`resourceState` remains a separate, narrower signal and is never conflated
with full readiness.

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
precondition signals fresh, at reassignment time — never reusing the stale
signals `selectIssue()` gathered during its scan — and applies at most one
reassignment per pass, mirroring the single global execution slot. A
blocked precondition writes nothing at all: silence, not a comment, is
correct for legitimately ambiguous or active work, and it also means a
repeatedly-blocked candidate never accumulates duplicate evidence.

**The review/recovery and workspace-ownership guards are real evidence, not
hardcoded assumptions.** Every `recovery_attempts` row ever written for the
exact issue — active or terminal, not only the currently-active ones — is
read via `allRows`/filter (the same pattern the pre-claim workspace check
already used). `resolution_state = 'resolved'` is the one durable marker
that an attempt's recovery/workspace state was actually verified clean
(`markResolved()` in `claude-runner-state.mjs`); any other value, including
a missing one, fails closed as unresolved and blocks on
`hasReviewOrRecoveryState`. `hasUnresolvedWorkspaceOwnership` is derived
from the same rows' persisted `worktree_available`/`branch_available`
columns — a preserved artefact on an unresolved attempt blocks; it is never
a bare `false` literal. `hasConflictingBranchOrWorktree` continues to reuse
`localRecoveryConflicts()`'s real git-level branch/worktree scan, and
`hasLinkedOpenPullRequest`/`hasHandoffInProgress` continue to reuse
`findLinkedOpenPullRequests()`/a handoff-heading comment scan respectively.

**A reassignment is only ever reported durably `applied: true` when both
the post-mutation label verification and the durable `recordRoutingEvent()`
write succeed.** If the GitHub label mutation lands but the routing-event
insert cannot be proven (`recorded?.inserted !== true` — a state-write
fault), `attemptQueuedReassignment()` returns `applied: false` with the
distinct reason `applied-but-not-durably-recorded` and never posts the
evidence comment. It also never re-attempts the label mutation on a later
pass: the issue's live label already reflects the replacement agent, so a
later reconciliation pass no longer classifies it as a reassignment
candidate for the agent it was just moved away from — the label itself is
the reconciliation checkpoint, not a second durable flag.

## The dual scan: execution discovery vs. status:ready reconciliation

Two independent candidate scans run inside `selectIssue()` when the
multi-agent selector is engaged:

1. **Execution discovery** (unchanged in scope) queries only
   `args.agentLabels` — implemented-agent labels by default
   (`agent:claude-code-cli`) — and is the only scan that can ever produce an
   executable selection. It still rejects a resolved-but-unimplemented
   agent early, but the generic selector now runs on every remaining
   candidate before that legacy checkpoint is reached for anything the
   agent-label query itself returned.
2. **Reconciliation** is a second, `status:ready`-only query over every
   remaining catalogue-supported label, including foundation-only,
   not-yet-implemented adapters (`agent:codex-cli`, `agent:grok-cli`,
   `agent:ollama`, …) — built as `allAgentLabels({ includeFuture: true })`
   minus whatever execution discovery already queried. `agent:codex`
   (Codex Web/manual) has no catalogue entry at all and is therefore never
   part of either scan. A reconciliation candidate runs through the exact
   same `selectAgentForIssue()` the execution scan uses, but only ever
   produces a `reassignment-candidate` or `no-qualified-agent` skip entry —
   it is foundation-only by construction (that is precisely why its label
   was excluded from execution discovery's query), so it can never itself
   become an executable selection. This is how a queued issue explicitly
   assigned to `codex-cli`/`grok-cli`/`ollama-agent` becomes visible to
   reassignment/no-qualified-agent evidence without ever becoming
   executable while its catalogue entry stays `implemented: false`.

Both scans share one `evaluateAgentEligibility()`/`selectAgentForIssue()`
pass, so a Claude-labeled issue can never receive two disagreeing verdicts
from the two scans.

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
| `scripts/ops/claude-runner-cron.mjs` | selector-engagement boundary, status:ready reconciliation scan, readiness wiring (`computeReadinessByAgentId()`/`boundedReadiness()`), pre-attempt (not just pre-claim) settings-revision re-check, evidence-based reassignment guards, durability-gated reassignment reporting, per-candidate eligibility/qualification/approved-agent checks in `selectIssue()` |
| `scripts/ops/claude-runner-cron.test.mjs` | selector/reconciliation/reassignment/no-qualified-agent/settings-revision/redaction coverage, all pre-existing tests still passing |
| `scripts/ops/claude-runner-state.mjs` | `routing_events` table (schema v11), `recordRoutingEvent()`, `hasRoutingEvent()` |
| `scripts/ops/claude-runner-state.test.mjs` | dedup/idempotency coverage |
| `scripts/ops/agent-runner-control-readiness.mjs` | unchanged — `computeInstanceReadiness()` is now actually called, per pass, from `claude-runner-cron.mjs`; no functional edit to this module was needed |

## Known limitations and deferred gates

- **The multi-agent selector's engagement boundary (settings-file presence) is this correction round's interpretation of the review comment, not an explicitly re-confirmed instruction — please confirm or correct it.** The review's own wording contains a tension: "a missing … settings document must be unusable for selection, reassignment and claim" reads as fully fail-closed even on absence, while "preserve old behaviour only when the multi-agent selector is not engaged" implies an absent file is exactly the *not engaged* case. This round adopted the latter reading — `snapshotAgentSettings().fileFound === true` gates engagement — because the alternative (treating a missing file as fail-closed too) would make every real production Claude issue newly non-executable the moment this branch deploys, since no production deployment has ever needed a `claude-code-cli` settings entry, explicit `task:`/`risk:` labels, or a settings file at all. If the intended reading is stricter, the fix is narrow: change the `multiAgentSelectorEngaged` computation in `main()`.
- **The "alternative agent selected" and "reassignment applied" code paths are structurally unreachable against the real, committed catalogue** (every non-Claude adapter stays `implemented: false`) in live production dispatch — they are exercised through dependency-injected pure-function tests (`agent-runner-routing.test.mjs`, `agent-runner-reassignment.test.mjs`) and through `attemptQueuedReassignment()`/`selectIssue()` called directly with an injected `routingResult`/settings snapshot (`claude-runner-cron.test.mjs`), not a live `main()` run against a real second implemented adapter. Making the production catalogue injectable for that purpose remains out of this issue's scope.
- Supervised per-adapter canaries, live routing enablement, concurrency, and the recurring execution timer remain gated on the later `#41` MVP integration milestone, unchanged by this issue.
- **`scripts/ops/issue-metadata.mjs` was deliberately left byte-identical to its `MIGRATION-MANIFEST.json` `"locked"` import.** An earlier draft added `taskClass`/`riskClass`/`model`/`harness` fields directly to that module, which broke `agent-runner-manifest-provenance.test.mjs`'s hash check. Rather than editing `MIGRATION-MANIFEST.json`/`CANONICAL-OWNERSHIP.json` (both outside this issue's code map), the classification logic was relocated into `agent-runner-qualification.mjs#classifyIssueTaskRisk()`, built entirely from `issue-metadata.mjs`'s pre-existing exports (`findFieldValue`, `labelNames`, `normaliseToken`). No non-code-map file was modified.
