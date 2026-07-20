# Agent Runner

This directory is intended to become a portable GitHub Issue to Claude runner kit.

The current ModelSpend implementation still lives under `scripts/ops`. During migration, these files document and wrap that implementation rather than replacing it in one risky step.

## Drop-in goal

A project should be able to copy this directory into a repository, adjust its config, and install a user-level systemd timer.

## Configuration

Create a project config from `config.example.json` and keep machine-specific values outside git.

The config should define repository name, issue labels, priority labels, quota headroom policy, output paths, and systemd names.

ModelSpend's current defaults are captured in `config.modelspend.example.json`.

## Current scaffold

This scaffold now includes wrapper or placeholder entries for the future portable layout:

- `scripts/runner-cron.mjs` wraps the current ModelSpend cron selector.
- `scripts/github-manager.mjs` wraps the current ModelSpend GitHub manager.
- `scripts/quota.mjs` re-exports the current quota parser/helpers.
- `scripts/runner.mjs` is intentionally disabled until the implementation migration lands.

## Agent Runner v2: preflight-direct dispatch

`scripts/ops/claude-runner-cron.mjs`/`scripts/ops/claude-runner.mjs` support two dispatch modes for a `status:ready` issue:

- `proceed-command` — compatibility mode. A `## Claude proceed command` comment drives selection and prompt construction, unchanged from the pre-v2 runner.
- `preflight-direct` — default for Agent Runner v2. Used only when no proceed command exists. If the issue has an unclaimed `## Manager preflight packet` (or `### ChatGPT preflight`) comment, the runner selects it directly and `claude-runner.mjs` builds the Claude prompt from the issue title/body and the preflight packet — no proceed command is synthesized or posted to GitHub.

This removes the runner's dependency on a scheduled ChatGPT task adding a proceed command before Claude can start on an issue that already has a valid manager preflight. Proceed commands remain fully supported and take priority when present.

Disable direct dispatch with `--no-preflight-direct` or `CLAUDE_RUNNER_CRON_DISABLE_PREFLIGHT_DIRECT=true` (the pre-v2 `--no-auto-proceed` / `CLAUDE_RUNNER_CRON_DISABLE_AUTO_PROCEED` names still work as aliases). With direct dispatch disabled, a ready issue without a proceed command is skipped with `missing proceed command`, matching pre-v2 behaviour.

Duplicate-claim protection applies to both modes: the `## Claude runner started` marker records `Selection mode` plus either `Source command comment` or `Source preflight comment`, so a claimed preflight is not redispatched.

## Agent Runner v2.2: local manager preflight generation

`scripts/ops/claude-runner-preflight.mjs` lets the runner generate its own `## Manager preflight packet` for a `status:ready` issue that has neither a proceed command nor an existing preflight, instead of skipping it forever with `missing manager preflight packet`. This is the final piece that lets the Dell runner maintain its own queue without a ChatGPT scheduled task posting preflight comments.

Generation is deterministic and local — it never calls an external AI/LLM API. A packet is built only from GitHub-visible data (issue title/body/labels/comments, linked open PRs) and a fixed default docs list, and only when the issue looks safe to preflight without a human:

- the issue body is at least `MIN_BODY_LENGTH_FOR_AUTO_PREFLIGHT` (200) characters;
- the issue body has an explicit `## Acceptance criteria` section with at least one bullet;
- the issue carries no blocking label (`blocked`, `needs-discussion`, `needs-manager`, `status:blocked`);
- no open PR is plausibly already linked to the issue (via `findLinkedOpenPullRequests`).

If any of those checks fail, the runner skips the issue with the structured reason `preflight-generation-needs-manager` and keeps scanning — it never dispatches on a guess. Generated packets are still recognised by the existing `## Manager preflight packet` heading, so they flow straight into `preflight-direct` selection and prompt building unchanged.

Duplicate posts are prevented with a deterministic fingerprint (sha256 of title/body/labels/linked-PR-state, truncated to 16 hex chars) embedded as an HTML comment in the generated packet. On each cron run:

- a packet with a matching fingerprint already present is reused as-is (no new comment);
- a packet with a stale fingerprint (label change, body edit, or a previously-blocking PR going away) is regenerated;
- a human-authored `## Manager preflight packet` comment (no generator marker) is never touched or replaced.

`scripts/ops/claude-runner-cron.mjs` calls this during selection: for each `status:ready` candidate with no working proceed command, it resolves a generate/blocked/noop action, posts a generated packet only when `--execute` is set (dry-runs never mutate GitHub), appends the new comment to the in-memory comment list, and immediately re-runs selection so the same run can proceed straight to `preflight-direct` dispatch. Disable this behaviour with `--no-auto-preflight` or `CLAUDE_RUNNER_CRON_DISABLE_AUTO_PREFLIGHT=true`.


## Agent Runner v3.1: multi-project config

The runner now has a small project config contract so the same v3 scripts can be reused by another GitHub-issue-managed project without hardcoding ModelSpend paths and labels in the flow. With no config supplied, compatibility defaults still load ModelSpend (`TheTekTeam/modelspend`, `.var/claude-runner`, `status:ready`, `status:in-progress`, and the existing Claude agent labels).

To configure another project:

1. Copy `.agent-runner/config.example.json` to a machine-local path such as `.agent-runner/config.json` and keep machine-specific paths out of git.
2. Set `projectId`, `displayName`, `githubRepo`, `localRepoPath`, `outputDir`, `stateDbPath`, `acceptedAgentLabels`, `statusLabels`, `priorityLabelRanking`, `safeDefaultValidationCommands`, and future `systemd` names.
3. Run with either `AGENT_RUNNER_CONFIG=/path/to/config.json` or `--config /path/to/config.json`. The older `CLAUDE_RUNNER_CONFIG` env name is also accepted as a compatibility alias.

Examples:

```bash
# Default ModelSpend compatibility config
node scripts/ops/claude-runner-cron.mjs --dry-run
node scripts/ops/claude-runner-dashboard-api.mjs

# Explicit project config
AGENT_RUNNER_CONFIG=.agent-runner/config.json node scripts/ops/claude-runner-cron.mjs --dry-run
node scripts/ops/claude-runner-dashboard-api.mjs --config .agent-runner/config.json
```

The dashboard/API payload includes read-only project identity (`projectId`, `displayName`, `githubRepo`, `localRepoPath`) for operator tooling. This does not change GitHub mutation behaviour, systemd units, or the compatibility entrypoints under `scripts/ops`. Agent abstraction, portable entrypoint migration, and systemd install changes remain intentionally unsupported in this phase.

## Agent Runner v3: local SQLite state

`scripts/ops/claude-runner-cron.mjs` now also writes a local SQLite state database for durable runner history. This is the first v3 data source for the future local dashboard/API; it does not replace the existing JSON logs and does not change the systemd or cron install scripts.

Default path:

```bash
.var/claude-runner/runner-state.sqlite
```

Override with either:

```bash
CLAUDE_RUNNER_STATE_DB=/path/to/runner-state.sqlite
node scripts/ops/claude-runner-cron.mjs --state-db /path/to/runner-state.sqlite
```

The v3 state store records queue events, quota history, generated preflight packets, issue selections, claims and run results. Persistence errors are captured in the runner output but do not change the existing GitHub selection/claim flow or prevent the JSON log from being written.

Check the local state store with:

```bash
npm run ops:claude-runner:state -- --pretty
```

Render dashboard-ready local JSON from the same read-only state DB with:

```bash
node scripts/ops/claude-runner-dashboard-api.mjs --db .var/claude-runner/runner-state.sqlite
```

The dashboard command groups recent runs, selections, queue skips, quota history, generated preflight packets/fingerprints, claims, run results, table counts, metrics and diagnostics into a single JSON payload for local operator tooling. The `metrics` section is derived only from the persisted SQLite rows already included in the dashboard history: recent run totals, recorded exit-code success/failure counts, average completed duration when timestamps are present, quota block/latest usage values, skipped-queue reason counts, oldest selected/skipped issue timestamp, and a rough ETA range only when at least three completed run durations plus selected/skipped issue history exist. Sparse or empty history reports `eta.status: "insufficient-data"` instead of inventing a precise ETA. Missing databases return a structured `state-db-missing` diagnostic with empty metrics; corrupt databases return a structured error payload and only exit non-zero when `--strict` is supplied.


Render the same payload as a local static dashboard with:

```bash
node scripts/ops/claude-runner-dashboard-local.mjs --db .var/claude-runner/runner-state.sqlite
```

Open `.agent-runner/dashboard/index.html` in a browser on the runner host. The command copies the static dashboard assets and writes `dashboard-data.js` from `buildRunnerDashboard()`, so the UI remains read-only and uses the same JSON/data layer as the CLI API. On a fresh checkout or missing DB, the page still renders with a clear empty state and a `state-db-missing` diagnostic instead of requiring a production server.

Use strict mode in validation when the DB must already exist:

```bash
npm run ops:claude-runner:state -- --strict --db .var/claude-runner/runner-state.sqlite
```

A missing DB returns a structured diagnostic instead of crashing, so a fresh checkout can distinguish "runner has not written state yet" from a corrupt or incompatible SQLite database.

## Migration phases

1. Add portable layout and config contract.
2. Move ModelSpend defaults into config.
3. Thread normalized quota usage into emitted JSON and persisted state.
4. Add profile/session-headroom selection before issue claiming.
5. Move runner code into `.agent-runner/scripts`.
6. Leave compatibility wrappers under `scripts/ops`.
7. Reuse the kit in another repository as a validation exercise.

## Agent Runner v3.1: agent adapter boundary

`scripts/ops/agent-runner-agents.mjs` defines the small agent/runtime adapter map used by the current ModelSpend runner. Claude Code CLI remains the only implemented runtime. The adapter records the implemented Claude labels (`agent:claude`, `agent:claude-code-cli`), command name, supported controls (`model`, `effort`, `maxTurns`, `maxBudgetUsd`, `permissionMode`, `resumeSession`, and text output format), and command-argument builder used by `scripts/ops/claude-runner.mjs`.

Future labels for Codex, GPT/OpenAI, Gemini, and Ollama are registered only as unsupported placeholders. The cron selector can report `unsupported-agent` when an operator explicitly includes one of those labels, but it does not execute those tools and does not assume their CLI flags. Default cron selection remains Claude-only.

Run plans and local state payloads now include resolved agent metadata (`agentId`, `agentType`, implementation status, and profile model/effort where available) so later runner/dashboard work can add runtimes without changing the existing Claude execution contract.
