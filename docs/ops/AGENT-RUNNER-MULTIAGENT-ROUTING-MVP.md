# Serial multi-agent selector and queued-only reassignment MVP (issue #50)

> **Current-status note (#376/#378):** this document records the #50 MVP
> state at the time it was implemented. Ollama is no longer foundation-only:
> #378 adds the bounded trusted-repository shell policy and #376 adds a
> dedicated implemented Ollama child. It remains disabled/unqualified in
> committed machine settings and cannot execute unless the explicit
> multi-agent gate plus all lifecycle/readiness/qualification/pre-claim
> admission gates pass. Codex CLI and Grok CLI remain foundation-only.

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

**Selector engagement is one explicit machine-local flag, never inferred
from settings-file presence.** `AGENT_RUNNER_ENABLE_MULTIAGENT_ROUTING`
(default `false`) is the single boundary `claude-runner-cron.mjs#main()`
reads into `args.multiAgentRoutingEnabled`. This directly replaces an
earlier draft of this issue that inferred engagement from
`snapshotAgentSettings().fileFound === true` — flagged by review as unsafe
because deleting or losing the settings file would then silently restore
the permissive legacy path even after multi-agent routing had genuinely
been in use.

- **Gate `false` (default):** `settingsSnapshot` is not threaded into
  `selectIssue()`/the pre-attempt revision check at all, no reconciliation
  scan runs, and Claude's pre-issue-#50 legacy execution path (which has
  never read the settings file) runs completely unaffected — regardless of
  whether a settings document exists, is missing, or is malformed. This is
  what keeps every real production Claude deployment working unchanged
  until an operator explicitly opts in.
- **Gate `true`:** the selector engages unconditionally, including when the
  settings document is missing, unreadable, malformed, or non-object. There
  is no secondary fallback once the gate is on — `snapshotAgentSettings()`'s
  uniform fail-closed defaults (no agent id, Claude included, has a
  permissive absent-entry default) then make every candidate unqualified
  until a valid document is in place, so "engaged with bad/missing
  settings" fails closed all the way through selection, reconciliation,
  attempt creation, claim, GitHub mutation, and worker launch.

This flag is a code/test boundary only in this PR — it does not enable the
execution timer, alter concurrency, or authorise live routing to any
adapter by itself; every adapter other than `claude-code-cli` still stays
`implemented: false` in the committed catalogue regardless of this flag.

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
generic primitives (`findFieldValue`, `labelNames`) — `issue-metadata.mjs`
itself needed no functional change and stays byte-identical to its locked
migration import. Missing metadata classifies as `null` (unclassified)
rather than a guessed permissive class.

**Settings qualification and issue classification share one bounded
safe-token normalizer.** `agent-runner-agent-settings.mjs#normalizeSafeToken()`
(also used to bound `qualification.taskClasses`/`riskClasses`/`models`/`harness`
read from a settings file) is the same function `classifyOneField()` runs
every field/label value through: it trims, lowercase-folds, and accepts
only `^[a-z0-9][a-z0-9._-]{0,63}$`. Three closed, bounded outcomes, never a
raw value:

- a single explicit, in-grammar value (from a field, a label, or both
  agreeing) wins;
- **two or more *distinct* normalized label values for the same field is a
  conflict** (`reason: 'multiple-labels'`) — the previous
  `labelValueForPrefix()` silently took the first matching label; it no
  longer does;
- a field/label value that is present but fails the grammar (too long,
  wrong charset, control characters, secret-shaped) is dropped to `null`
  with `reason: 'invalid-value'`, distinct from a genuine field/label
  disagreement (`reason: 'field-label-mismatch'`).

`classification.conflicts` is therefore always `{ key, reason }` pairs from
this fixed three-value vocabulary — never the raw field value, label value,
or label object. A GitHub label's `description`/`color`/`id` fields are
never read at all; only `.name` is ever inspected, by
`agent-runner-qualification.mjs`, by `claude-runner-cron.mjs`'s ambiguity
check, and by every skip payload's bounded `labels` field.

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

**A reassignment is only ever reported durably `applied: true` after both
the post-mutation label verification and a durable state transition
succeed** — see "Durable evidence" below for the full crash-safe
pending/delivery state machine `attemptQueuedReassignment()` now drives a
durable `routing_events` row through, and for how a state-write fault at
any step reconciles safely on a later pass without ever repeating a
mutation that already landed.

## The dual scan: execution discovery vs. status:ready reconciliation

Two independent, **structurally fixed** candidate scans run inside
`selectIssue()` when the multi-agent selector is engaged — neither is
computed as "the other minus configured labels":

1. **Execution discovery** queries the *intersection* of whatever an
   operator configured in `args.agentLabels`/`acceptedAgentLabels` with the
   catalogue's `implemented: true` adapter labels
   (`IMPLEMENTED_AGENT_LABELS`). A misconfigured `acceptedAgentLabels` that
   happens to include `agent:codex-cli`/`agent:grok-cli`/`agent:ollama` can
   therefore never route those issues into execution discovery's GH
   query — an earlier draft of this issue computed reconciliation as "all
   labels minus configured labels," which meant a misconfigured
   `acceptedAgentLabels` entry moved a foundation label *into* execution
   discovery and *out of* reconciliation, where the legacy
   `!agent.implemented` check silently skipped it with no evidence. It
   still rejects a resolved-but-unimplemented agent early as a defensive
   backstop, but that branch is unreachable in practice now that its input
   is constructed this way.
2. **Reconciliation** queries every catalogue label whose adapter is
   `implemented: false` (`FOUNDATION_ONLY_AGENT_LABELS`), full stop —
   independent of `args.agentLabels` entirely, so an operator cannot
   configure a foundation-only label out of reconciliation by listing it as
   "accepted." `agent:codex` (Codex Web/manual) has no catalogue entry at
   all and is therefore never part of either scan. A reconciliation
   candidate runs through the exact same `selectAgentForIssue()` the
   execution scan uses, but only ever produces a `reassignment-candidate`
   or `no-qualified-agent` skip entry — it is foundation-only by
   construction, so it can never itself become an executable selection.

Both scans share one `evaluateAgentEligibility()`/`selectAgentForIssue()`
pass, so a Claude-labeled issue can never receive two disagreeing verdicts
from the two scans.

**An issue carrying more than one distinct supported local agent label is
ambiguous and fails closed.** `skipIfAmbiguous()` checks every candidate
from both scans (before either resolves an agent for it) against the full
catalogue label set; two or more *distinct agent ids* represented (not
merely two labels — `agent:claude` plus `agent:claude-code-cli` is one
adapter, not ambiguous) produces a `reason: 'ambiguous-agent-labels'` skip
entry with a bounded `supportedAgentLabels` list (catalogue label names
only), and — when the selector is engaged —
`recordAmbiguousAgentLabelsEvidence()` posts one deduplicated,
delivery-tracked routing-attention comment. The issue is flagged exactly
once even if it would otherwise appear in both scans, and never executes.

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
keyed by `(repo, issue, settings revision)`) starting in `'evidence-pending'`
and attempts delivery immediately; a delivery failure leaves the row
`'evidence-pending'` for retry rather than being silently dropped (see
"Durable evidence" below). No worker is launched, no manager packet is
consumed, and no claim is created.

## Durable evidence: `routing_events` and crash-safe pending/delivery reconciliation

`scripts/ops/claude-runner-state.mjs` adds a `routing_events` table
(schema v12) with a `UNIQUE` `dedupe_key` and a `delivery_status` column —
`recordRoutingEvent()` is an `INSERT OR IGNORE`; on a dedupe collision it
now also returns the `existing` row so a caller can distinguish "already
fully resolved" from "still pending, safe to resume." `payload_json` is
caller-bounded and never receives raw settings, credentials, paths,
endpoints, prompts, or provider text.

**`delivery_status` is a small durable state machine** —
`'mutation-pending'` → `'evidence-pending'` → `'resolved'` — that makes
every GitHub mutation and every evidence comment resumable after a crash,
without ever repeating a mutation that already landed:

1. **Before any label mutation**, `attemptQueuedReassignment()` persists a
   bounded intent row (`deliveryStatus: 'mutation-pending'`) keyed by the
   same deterministic `reassignmentDedupeKey()` as before. If this write
   fails, GitHub is never mutated — there is nothing to reconcile because
   nothing happened. A collision against an existing row this exact call
   didn't just insert only proceeds to mutate when that row is *itself*
   still `'mutation-pending'` (a prior crash before the mutation ran); any
   other state means an earlier pass already applied or is delivering
   evidence, and this call returns without touching GitHub again.
2. **After the label mutation is verified**, the same row transitions to
   `'evidence-pending'`. If that transition cannot be durably recorded, the
   function returns `applied: false, reason: 'applied-but-not-durably-recorded'`
   and posts no comment — the mutation already happened, but this pass
   cannot prove it durably, so it reports honestly rather than silently
   "complete."
3. **`reassignment complete` is reported (`applied: true`) as soon as step 2
   succeeds** — comment delivery is tracked and retried separately below,
   and never flips `applied` back to `false` on its own.
4. **`recordNoQualifiedAgentEvidence()`/`recordAmbiguousAgentLabelsEvidence()`**
   never mutate GitHub, so their rows start life directly in
   `'evidence-pending'`; a prior comment-delivery failure leaves the row
   there, and a later call (dedupe-collision) retries delivery instead of
   silently never trying again — the fixed bug this round's review named
   explicitly (the previous design's `INSERT OR IGNORE` gate meant a
   failed first comment could never be retried, because the dedupe row
   already existed).
5. **`reconcilePendingRoutingEvents()`** runs once per execute pass (when
   the selector is engaged), before fresh selection: for every
   non-`'resolved'` row, a `'mutation-pending'` row is self-healed to
   `'evidence-pending'` by re-reading the live issue's labels and verifying
   them against the row's own persisted `labelMutation` plan (via
   `verifyLabelMutation()`) — **never by re-running the mutation**; if live
   labels don't yet match, the row is left untouched (a fresh
   `selectIssue()` reconciliation scan naturally re-flags the issue as a
   candidate on its own, since its live label is unchanged, and
   `attemptQueuedReassignment()` picks up the same dedupe key from there).
   An `'evidence-pending'` row only ever retries the comment.

## Code map

| File | Change |
| --- | --- |
| `scripts/ops/agent-runner-agent-settings.mjs` | `snapshotAgentSettings()`, `settingsRevisionUnchanged()` (now requires `fileFound: true` on both sides), per-agent qualification/paid-use normalization with no Claude-specific fallback, shared `normalizeSafeToken()`/`isSafeQualificationToken()` |
| `scripts/ops/agent-runner-agent-settings.test.mjs` | snapshot/revision/qualification/paid-use coverage |
| `.agent-runner/agent-settings.example.json` | adds `qualification` blocks and `automaticRoutingApproved: false` to codex-cli/grok-cli/ollama-agent |
| `scripts/ops/issue-metadata.mjs` | unchanged — this migration-locked file needed no functional edit; `classifyIssueTaskRisk()` is built entirely from its existing exported primitives (see below) |
| `scripts/ops/issue-metadata.test.mjs` | not added — no functional change to cover |
| `scripts/ops/agent-runner-qualification.mjs` | new — conservative qualification matching, Ollama's structural risk boundary, `classifyIssueTaskRisk()` (task/risk/model/harness classification) |
| `scripts/ops/agent-runner-qualification.test.mjs` | new — includes classification and conflict-handling coverage |
| `scripts/ops/agent-runner-routing.mjs` | new — deterministic serial selector |
| `scripts/ops/agent-runner-routing.test.mjs` | new |
| `scripts/ops/agent-runner-reassignment.mjs` | queued-only precondition proof, label mutation plan/verify, evidence bodies (reassignment, no-qualified-agent, ambiguous-agent-labels), fixed mutation/read failure reason codes (never a raw exception message) |
| `scripts/ops/agent-runner-reassignment.test.mjs` | new |
| `scripts/ops/agent-runner-manager-authority.mjs` | `managerAuthorityApprovesAgent()` |
| `scripts/ops/agent-runner-manager-authority.test.mjs` | coverage for the new comparator |
| `scripts/ops/claude-runner-selection.mjs` | unchanged — already exposes `managerAuthority.approvedAgent`; no functional edit needed |
| `scripts/ops/claude-runner-selection.test.mjs` | new — regression-proofs the `approvedAgent` contract `claude-runner-cron.mjs` now depends on |
| `scripts/ops/claude-runner-cron.mjs` | explicit `AGENT_RUNNER_ENABLE_MULTIAGENT_ROUTING` gate, structurally independent execution/reconciliation label sets, ambiguous-agent-label detection and evidence, readiness wiring (`computeReadinessByAgentId()`/`boundedReadiness()`), pre-attempt (not just pre-claim) settings-revision re-check, evidence-based reassignment guards, crash-safe pending/delivery reassignment and evidence reporting (`reconcilePendingRoutingEvents()`), per-candidate eligibility/qualification/approved-agent checks in `selectIssue()` |
| `scripts/ops/claude-runner-cron.test.mjs` | gate/selector/reconciliation/ambiguous-label/reassignment/no-qualified-agent/settings-revision/crash-safety/redaction coverage, all pre-existing tests still passing |
| `scripts/ops/claude-runner-state.mjs` | `routing_events` table (schema v12), `delivery_status` column + `updateRoutingEventDeliveryStatus()`/`pendingRoutingEvents()`, `recordRoutingEvent()` now returns the colliding `existing` row, `hasRoutingEvent()` |
| `scripts/ops/claude-runner-state.test.mjs` | dedup/idempotency/delivery-status-transition coverage |
| `scripts/ops/agent-runner-control-readiness.mjs` | unchanged — `computeInstanceReadiness()` is now actually called, per pass, from `claude-runner-cron.mjs`; no functional edit to this module was needed |

## Known limitations and deferred gates

- **The "alternative agent selected" and "reassignment applied" code paths are structurally unreachable against the real, committed catalogue** (every non-Claude adapter stays `implemented: false`) in live production dispatch — they are exercised through dependency-injected pure-function tests (`agent-runner-routing.test.mjs`, `agent-runner-reassignment.test.mjs`) and through `attemptQueuedReassignment()`/`selectIssue()`/`reconcilePendingRoutingEvents()` called directly with an injected `routingResult`/settings snapshot/real SQLite store (`claude-runner-cron.test.mjs`), not a live `main()` run against a real second implemented adapter. Making the production catalogue injectable for that purpose remains out of this issue's scope.
- Supervised per-adapter canaries, live routing enablement, concurrency, and the recurring execution timer remain gated on the later `#41` MVP integration milestone, unchanged by this issue. `AGENT_RUNNER_ENABLE_MULTIAGENT_ROUTING` is a code/test boundary only; nothing in this repository sets it in a deployed environment.
- **`scripts/ops/issue-metadata.mjs` was deliberately left byte-identical to its `MIGRATION-MANIFEST.json` `"locked"` import.** An earlier draft added `taskClass`/`riskClass`/`model`/`harness` fields directly to that module, which broke `agent-runner-manifest-provenance.test.mjs`'s hash check. Rather than editing `MIGRATION-MANIFEST.json`/`CANONICAL-OWNERSHIP.json` (both outside this issue's code map), the classification logic was relocated into `agent-runner-qualification.mjs#classifyIssueTaskRisk()`, built entirely from `issue-metadata.mjs`'s pre-existing exports (`findFieldValue`, `labelNames`). No non-code-map file was modified.
