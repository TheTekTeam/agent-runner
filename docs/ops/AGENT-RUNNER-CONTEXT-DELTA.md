# Agent Runner resumed-session context delta

Issue: #320 `EFFICIENCY.CONTEXT.BUDGET.1`

The deterministic pre-provider handoff introduced by #319 remains full and bounded for a **fresh** provider session. When Agent Runner has already bound an exact provider resume session, repeating that entire source-evidence capsule is unnecessary context churn.

## Live rule

`buildAgentCommandArgs()` now requests a delta-only deterministic handoff only when `resumeSession` is explicitly present.

A resumed-session delta contains:

- current exact `headSha`;
- current source fingerprint;
- immutable manager-authority fingerprint;
- changed-file evidence, when available;
- status/reuse/digest identity for every deterministic evidence class.

It intentionally omits full previously supplied repository-map, toolchain and other detailed deterministic results. The provider is instructed to re-read detail only when a digest/scope changed or the current task genuinely requires it.

Fresh sessions still receive the full bounded handoff because they cannot rely on prior provider context.

## Safety boundary

Delta-only handoff is not a generic truncation policy. It is enabled only by an already-bound exact `--resume` session. It does not change manager authority, issue identity, source/worktree checks, tool permissions, model/effort policy, quota admission or validation requirements.

If the deterministic handoff is invalid, oversized, stale for another agent or digest-tampered, it is omitted rather than trusted.

The implementation does **not** reintroduce a Claude `--max-turns` limit. Provider controls remain capability-driven and the previously accepted normal issue-execution turn policy is unchanged.

## Measurement

This source change creates a directly measurable token-reduction opportunity for naturally occurring continuation runs: compare the rendered deterministic evidence bytes for fresh versus resumed prompts and use #194 normalized provider usage/cache telemetry for real accepted workloads. Do not make a paid/provider call solely to manufacture a benchmark.
