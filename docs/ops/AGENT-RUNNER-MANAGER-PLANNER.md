# Agent Runner manager planner (read-only)

Issue: `TheTekTeam/agent-runner#261` (`BUILD.MANAGER.PLANNER.1`, parent `#258`).

This slice adds the read-only planner foundation that turns an explicitly
registered, validated manager project/profile (see
`docs/ops/AGENT-RUNNER-MANAGER-PROFILES.md`) into a deterministic, versioned
project brief and implementation-plan proposal. It is pure data
validation/normalization: no module here performs a GitHub call, a clone, a
provider invocation or any mutation.

## Read-only trust boundary

- **Input trust.** Every builder in this family only accepts input alongside
  an already-validated parent object from the same chain
  (`profile` -> `evidence` -> `brief` -> `proposal`), checked by provenance
  (an unforgeable `WeakSet`, the same strategy used by
  `agent-runner-manager-profile-schema.mjs`), not merely by shape. A
  hand-built object that merely *looks* like validated evidence, a brief or
  a proposal is refused even if it is deeply frozen and field-for-field
  identical to a real one.
- **Output trust.** Every builder fails closed: unknown/missing fields,
  over-bound lists, malformed identifiers/hashes/timestamps, secret- or
  path-shaped text, shell/executable payloads, and any free text describing
  a write action (merge/deploy/close/dispatch/source-activation/label
  mutation) are all rejected, not silently dropped or truncated.
- **No mutation surface.** None of these modules import `node:fs`,
  `node:http(s)`, `node:child_process`, an Octokit client or `fetch`; see
  `agent-runner-manager-planner-boundary.test.mjs`, which asserts this
  directly against the module source and also asserts there is no
  per-project or per-provider branching anywhere in the planner family.
- **Not the manager authority.** `<!-- agent-runner:manager-preflight -->`
  packet parsing, claim identity and dispatch authority are unchanged and
  live in `agent-runner-manager-authority.mjs` (see
  `docs/ops/AGENT-RUNNER-MANAGER-AUTHORITY-CODE-MAP.md`). This planner never
  posts a comment, issues a packet, opens/edits/closes an issue or a pull
  request, dispatches work or activates a source. It produces a normalized,
  fingerprinted proposal for a human or a later, separately accepted
  authority to consume.

## Modules

- `scripts/ops/agent-runner-manager-planner-safety.mjs` — shared pure
  helpers used by every module below: bounded/safe free-text validation
  (control characters, local-machine paths, secret-shaped tokens, shell
  payloads, write-action phrasing), deterministic key-sorted JSON
  serialization (`stableJson`) and content fingerprinting
  (`contentFingerprint`).
- `scripts/ops/agent-runner-manager-project-evidence.mjs` —
  `validateManagerProjectEvidence(raw, { profile })` normalizes a bounded
  evidence snapshot: exact repository identity, branch, source SHA,
  evidence revision/timestamp, instruction-document metadata (path/hash/
  freshness, restricted to the profile's own `instructionPaths`), detected
  tooling, acceptance commands (restricted to the profile's own
  `validation.requiredChecks`, so this field can never smuggle an arbitrary
  command), and bounded open issue/PR summaries. Refuses to build evidence
  for a disabled profile at all -- a disabled project is never
  live-evidenced, matching its zero mutation authority.
- `scripts/ops/agent-runner-manager-project-brief.mjs` —
  `validateManagerProjectBrief(raw, { evidence })` normalizes objective,
  outcome, constraints, non-goals, risks, assumptions, blockers, escalation
  questions and definition of done. The architecture/tooling summary is
  *derived directly from the evidence snapshot's own `tooling` block*
  rather than accepted from the caller, so "grounded in supplied evidence"
  is structural rather than a claim to trust.
- `scripts/ops/agent-runner-manager-plan-proposal.mjs` —
  `validateManagerPlanProposal(raw, { brief })` normalizes bounded
  milestones with an acyclic dependency graph (rejecting cycles with the
  exact cycle path), proposed issues with narrowly bounded scope/title/
  acceptance criteria and an explicit `decisionType` of `product` or
  `implementation`, blockers and escalations. `grounding` must exactly
  match the underlying evidence's repository/branch/source SHA, so a
  proposal can never silently drift onto a different repository, branch or
  revision than the evidence it claims to be built from.
  `serializeManagerPlanProposal()` produces the stable, deterministic
  serialization; `proposalFingerprint` is a SHA-256 content fingerprint, so
  identical evidence/brief/input always yields identical output.

## Required fixtures and tests

`agent-runner-manager-project-evidence.test.mjs`,
`agent-runner-manager-project-brief.test.mjs` and
`agent-runner-manager-plan-proposal.test.mjs` each exercise the real
registered `agent-runner` and `modelspend` manager profiles (see
`config/manager-profiles/`) through the identical, unbranched validation
code path, proving provider/project neutrality. The disabled
`fixture-third-project` profile proves evidence construction is refused
outright for a disabled project.
`agent-runner-manager-planner-boundary.test.mjs` proves, directly against
module source, that the planner family carries no GitHub/network/
filesystem/child-process import and no per-project or per-provider
branching.

## What this is not

- Not queue curation, packet issuance, dispatch or merge/deploy/close/label
  behaviour.
- Not a provider invocation. No module here calls Claude, ModelSpend or any
  other provider; deterministic tests never invoke one.
- Not a change to scheduler/timer activation, source authority or the
  existing manager recurrence, which remains the sole mutation authority.

## Next bounded slice

The next bounded slice is **queue curation**: turning an accepted plan
proposal's `proposedIssues` into a bounded, human-reviewable queue-curation
action (still not itself issuing GitHub writes, packets or dispatch) under
its own separately accepted contract, per the #258 parent programme.
