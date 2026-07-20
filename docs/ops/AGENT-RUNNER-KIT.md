# Reusable agent runner kit

This document defines the portable GitHub Issue to Claude runner kit. The goal is to move project-specific values into configuration so the runner can be copied into another repository and installed as a user-level systemd timer.

Initial rollout for ModelSpend should keep the current working runner in place and introduce the reusable layout in phases.

## Target layout

- `.agent-runner/config.example.json`
- `.agent-runner/config.json` kept local or project-specific
- `.agent-runner/config.modelspend.example.json`
- `.agent-runner/scripts/runner-cron.mjs`
- `.agent-runner/scripts/runner.mjs`
- `.agent-runner/scripts/quota.mjs`
- `.agent-runner/scripts/github-manager.mjs`
- `.agent-runner/scripts/install-systemd.sh`
- `.agent-runner/scripts/jobs/run-agent-runner.sh`

## Required config fields

- repository full name
- ready and in-progress status labels
- accepted agent labels
- priority label order
- manager preflight requirement
- preflight-direct dispatch setting (`autoProceedFromPreflight` in the config schema; pre-v2 name kept for compatibility)
- quota/session headroom thresholds by task profile
- output directory and lock path
- systemd service and timer names

## Agent Runner v2: dual dispatch modes

`scripts/ops/claude-runner-cron.mjs` selects a `status:ready` issue in one of two modes:

- `proceed-command` — a `## Claude proceed command` comment exists; behaviour is unchanged from the pre-v2 runner.
- `preflight-direct` — no proceed command exists, but the issue has an unclaimed manager preflight packet (`## Manager preflight packet` / `### ChatGPT preflight`). The runner selects the issue directly from the packet; `scripts/ops/claude-runner.mjs` builds the Claude prompt from the issue title/body and the packet instead of relaying operator-authored comment text. No proceed command is posted to GitHub during selection.

If neither a command nor a preflight packet exists, the issue is skipped with `missing manager preflight packet` — the runner never dispatches blindly. Duplicate claims are prevented for both modes: the `## Claude runner started` marker records the selection mode and either the source command comment id or the source preflight comment id, so a preflight already claimed by a prior run is not reselected.

This is the mechanism that lets the Dell runner keep operating without a ChatGPT scheduled task adding a proceed command to every ready issue; see `.agent-runner/README.md` for operator-facing flag/env details.

## Agent Runner v2.2: local preflight generation

`preflight-direct` mode still requires a manager preflight packet to exist. Before v2.2, nothing on the Dell runner created one, so every ready issue without a proceed command was skipped with `missing manager preflight packet` — the last dependency on a ChatGPT scheduled task.

`scripts/ops/claude-runner-preflight.mjs` closes that gap with local, deterministic generation (no external AI calls): for a `status:ready` issue with no working proceed command and no existing manager preflight, it builds a `## Manager preflight packet` from GitHub-visible issue/comment/linked-PR data plus a fixed default docs list, gated by a conservative safety check (minimum body length, an explicit `## Acceptance criteria` section, no blocking label, no linked open PR). Unsafe issues are skipped with `preflight-generation-needs-manager` instead of a guess.

`scripts/ops/claude-runner-cron.mjs` wires this into selection: on `--execute` runs it posts a generated packet, appends it to the in-memory comment list, and re-runs selection immediately so `preflight-direct` dispatch can proceed in the same pass — "queue re-evaluation" happens without an extra cron tick. Dry-runs never post. A sha256 fingerprint over title/body/labels/linked-PR-state (embedded as an HTML comment in the packet) prevents duplicate posts and detects staleness — a fingerprint mismatch (label change, body edit, a blocking PR closing) triggers regeneration; a human-authored packet (no generator marker) is never touched. Disable with `--no-auto-preflight` / `CLAUDE_RUNNER_CRON_DISABLE_AUTO_PREFLIGHT=true`.

With this in place, the Dell runner can maintain its own ready-issue queue end to end — discovery, eligibility, preflight, quota/headroom, dispatch — without a ChatGPT scheduled task in the critical path.

## Quota and task-size policy

Exact token prediction is deliberately not required. The reusable runner should infer a task profile and require enough current-session headroom before claiming the issue.

Recommended starting thresholds:

- docs: start only at or below 70 percent current-session usage
- narrow: start only at or below 60 percent current-session usage
- complex: start only at or below 40 percent current-session usage
- critical: start only at or below 25 percent current-session usage

If a candidate issue is too large for the current session headroom, the selector should skip it with a structured reason and continue scanning for a smaller eligible task. If no task fits, it should leave the queue unclaimed and wait for the next timer run or reset.

Existing ModelSpend scripts under `scripts/ops` should remain as compatibility wrappers until the reusable runner is proven.

## Agent Runner v3.1: agent adapter boundary

`scripts/ops/agent-runner-agents.mjs` defines the small agent/runtime adapter map used by the current ModelSpend runner. Claude Code CLI remains the only implemented runtime. The adapter records the implemented Claude labels (`agent:claude`, `agent:claude-code-cli`), command name, supported controls (`model`, `effort`, `maxTurns`, `maxBudgetUsd`, `permissionMode`, `resumeSession`, and text output format), and command-argument builder used by `scripts/ops/claude-runner.mjs`.

Future labels for Codex, GPT/OpenAI, Gemini, and Ollama are registered only as unsupported placeholders. The cron selector can report `unsupported-agent` when an operator explicitly includes one of those labels, but it does not execute those tools and does not assume their CLI flags. Default cron selection remains Claude-only.

Run plans and local state payloads now include resolved agent metadata (`agentId`, `agentType`, implementation status, and profile model/effort where available) so later runner/dashboard work can add runtimes without changing the existing Claude execution contract.

## Failure recovery and attention contract

`scripts/ops/claude-runner-recovery.mjs` is the versioned, deterministic recovery-policy boundary. New terminal outcomes use canonical snake-case codes. Legacy persisted spellings such as `turn-limit-exhausted` remain readable, but new attempt and attention rows use `turn_limit_exhausted`. Automatic recovery always fails closed unless exclusive ownership, compatible agent/model/harness, quota/budget/turn headroom, and the outcome-specific mutation/checkpoint evidence are proven. Retry caps and exponential backoff defaults are explicit policy constants; a native resume is never represented as a fresh retry.

Runner state schema v2 additively stores durable recovery attempts and sanitized, deduplicated attention events in the existing SQLite database. Restricted exit/signal/evidence remains in the attempt table and is not copied into the attention event. Notification consumers may read `attention_events`, but remote delivery remains outside this runner contract. The dashboard labels stored issue metadata as event-time state rather than current GitHub state.

Schema v5 wires those records into every scheduled execution and watchdog pass. Claude single-object JSON, JSONL, and JSON-array output are reduced to the terminal `type=result` record. Quota/rate outcomes are accepted only from an allowlisted structured terminal error; intermediate `rate_limit_event` records, assistant text, prompts, and tool results are never searched for quota-looking strings. Due bounded retries are atomically claimed from SQLite after a fresh scheduler quota preflight. Every other issue remains independently selectable, and only an explicit systemic pause is presented as a global stop.

The scheduler now proves the SQLite store is migrated and writable before selection, issue mutation, or child launch. Open, migration, or write ambiguity emits a restricted local `runner_state_unavailable` diagnostic and stops dispatch. Active attempts persist PID plus Linux boot ID and process start ticks (and the systemd invocation ID when available), so PID reuse or reboot cannot impersonate the original owner.

Claude runs are asynchronous to the scheduler process while the existing singleton lock remains held. This keeps the scheduler event loop available for watchdog intervals. A content-free progress revision advances from streamed child output or changing CPU/I/O counters for the wrapper and its descendants. Live-stall passes increment only while that revision is unchanged and reset on material progress; the configured unchanged-pass threshold creates one material attention update. Repeated passes retain the first detection timestamp and do not rewrite the GitHub marker until the persisted event materially changes.

Every due recovery is re-fetched and revalidated before its atomic SQLite claim, immediately before child dispatch, and again before a successful `status:blocked` to `status:in-progress` transition. Schema v5 retains the claimed action, manager-authorization ID, recovery lease, claim/preflight revisions, actual safe booleans, and append-only stage decisions. Missing or ambiguous issue status, agent ownership, revision authority, manager authorization, process/lease ownership, repository conflicts, or adapter compatibility is false and blocks the child. A changed completion-time fact leaves GitHub untouched and persists attention; the runner never closes or reopens the issue.

Schema v6 adds a bounded, audited transition-mutation state machine for the successful-recovery `status:blocked` -> `status:in-progress` step: `transition_pending` (label mutation not yet durably confirmed) -> `attention_resolution_pending` (the label mutation is proven applied and durable, but the resolved GitHub attention marker has not yet been durably delivered) -> `resolved` (both durable). A failed mutation attempt moves to `transition_uncertain`, retried at most `MAX_TRANSITION_MUTATION_ATTEMPTS` (2, counting the initial attempt) times before moving to `operator_attention_required`, which is deliberately excluded from automatic reconciliation and requires a fresh manager decision. `reconcilePendingRecoveryTransitions()` re-runs the same full pre-claim-equivalent authority revalidation (ownership, claim/preflight revision, authorization, handoff, linked PR, process/lease conflicts) before ever retrying a mutation or completing local convergence, and never repeats a mutation GitHub already shows as applied.

`native_resume` and `same_agent_continuation` resume/continuation evidence (session id, worktree/branch identity, and an exact captured checkpoint — HEAD plus a working-tree status fingerprint) lives in a dedicated, mode-0700/0600, owner-verified restricted local store (`scripts/ops/claude-runner-recovery-adapter.mjs`), separate from the ordinary SQLite state. `verifyPreservedWorktree()` requires the current worktree HEAD and status fingerprint to exactly match the captured checkpoint, not merely that some commit exists. Restricted values are never assigned to anything logged, persisted in ordinary state, or posted to GitHub; a dedicated positional argument redactor (`redactExecutableArgs()`) strips the value following `--resume`/`--resume-session` from every safe-preview surface (`runnerArgs`, `claudeArgsPreview`).

**Disabled for this release.** `native_resume`/`same_agent_continuation` fail closed unconditionally — `dispatchRecoveryAction()` denies with `native-resume-disabled-for-this-release` / `same-agent-continuation-disabled-for-this-release` — unless both (a) `detectClaudeResumeCliCapability()` proves the installed CLI meets the documented resume-capability minimum, and (b) the machine-local, env-only `CLAUDE_RUNNER_ENABLE_NATIVE_RESUME=1` gate is set (never a repo-tracked config value). The installed CLI is currently below that minimum, so both actions launch nothing today regardless of the gate; the denial still preserves the restricted branch/worktree/checkpoint material, releases the global execution slot, and surfaces the exact reason as durable attention. Enabling the gate is a separate, deliberate operator action on a specific machine after the CLI is upgraded and a supervised positive run has passed — not something this PR does or recommends.

The scheduler recognizes only this exact fresh authorization packet, posted after the failed attempt:

```markdown
## Manager recovery authorization
- Attempt: <persisted attempt id>
- Action: fresh_retry | retry_after_quota_preflight | native_resume | same_agent_continuation
- Claim revision: <persisted source comment id>
- Preflight revision: <persisted manager preflight comment id>
- Agent: claude-code-cli
- Model: <persisted model>
- Harness: claude
- Policy approved: yes | no
```

`fresh_retry` maps only to the ordinary bounded invocation. `retry_after_quota_preflight` additionally requires the known reset to have passed and a successful fresh quota check. `native_resume` and `same_agent_continuation` require restricted local resume/continuation invocations supplied by verified adapters; if a handle, checkpoint, preserved worktree, policy approval, or installed CLI capability is unavailable, dispatch stops rather than substituting a fresh run. Unknown actions are never launched.
