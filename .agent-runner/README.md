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

## Immutable manager dispatch authority

New issue claims are authorised only by one current canonical manager packet. Historical `## Claude proceed command` and `## Claude continue command` comments remain readable as migration evidence, but they cannot select, claim, or reauthorise work.

A canonical packet must contain `<!-- agent-runner:manager-preflight -->` and a fenced YAML block with:

- `schema_version: agent-runner-manager-preflight/v1`;
- an immutable `revision`;
- a full `sha256:` fingerprint;
- `producer_type` set to `normal_chatgpt_manager_session` or `chatgpt_scheduled_task`;
- the `approved_agent` and `execution_phase`;
- non-empty `scope`, `required_validation` (or `validation`), and `stop_conditions` lists.

The claim is bound to `manager-preflight:<revision>:<fingerprint>` plus a persisted SHA-256 digest of the complete packet body. Editing packet text without a new manager-owned revision and fingerprint invalidates revalidation and pinned execution. A revoked, stale, malformed, worker-produced, runner-generated, or already-claimed packet fails closed with no worker launch, attempt creation, or GitHub mutation.

The runner cannot create or refresh manager authority. `scripts/ops/claude-runner-preflight.mjs` remains only as a fail-closed compatibility tombstone for historical imports. See [`docs/ops/AGENT-RUNNER-DISPATCH-AUTHORITY-MIGRATION.md`](../docs/ops/AGENT-RUNNER-DISPATCH-AUTHORITY-MIGRATION.md).

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

The v3 state store records queue events, quota history, manager packet authority evidence, issue selections, claims and run results. Persistence errors are captured in the runner output but do not change the existing GitHub selection/claim flow or prevent the JSON log from being written.

Check the local state store with:

```bash
npm run ops:claude-runner:state -- --pretty
```

Render dashboard-ready local JSON from the same read-only state DB with:

```bash
node scripts/ops/claude-runner-dashboard-api.mjs --db .var/claude-runner/runner-state.sqlite
```

The dashboard command groups recent runs, selections, queue skips, quota history, manager packet authority revisions/fingerprints, claims, run results, table counts, metrics and diagnostics into a single JSON payload for local operator tooling. The `metrics` section is derived only from the persisted SQLite rows already included in the dashboard history: recent run totals, recorded exit-code success/failure counts, average completed duration when timestamps are present, quota block/latest usage values, skipped-queue reason counts, oldest selected/skipped issue timestamp, and a rough ETA range only when at least three completed run durations plus selected/skipped issue history exist. Sparse or empty history reports `eta.status: "insufficient-data"` instead of inventing a precise ETA. Missing databases return a structured `state-db-missing` diagnostic with empty metrics; corrupt databases return a structured error payload and only exit non-zero when `--strict` is supplied.


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

`scripts/ops/agent-runner-agents.mjs` defines the small agent/runtime adapter map used by the current ModelSpend runner. Claude Code CLI remains the only implemented runtime. The adapter records the implemented Claude labels (`agent:claude`, `agent:claude-code-cli`), command name, supported controls (`model`, `effort`, `permissionMode`, `resumeSession`, and text output format), and command-argument builder used by `scripts/ops/claude-runner.mjs`.

Future labels for Codex, GPT/OpenAI, Gemini, and Ollama are registered only as unsupported placeholders. The cron selector can report `unsupported-agent` when an operator explicitly includes one of those labels, but it does not execute those tools and does not assume their CLI flags. Default cron selection remains Claude-only.

Run plans and local state payloads now include resolved agent metadata (`agentId`, `agentType`, implementation status, and profile model/effort where available) so later runner/dashboard work can add runtimes without changing the existing Claude execution contract.

## OpenCode/Ollama adapter foundation (issue #40, foundation only)

`scripts/ops/agent-runner-agent-settings.mjs`, `scripts/ops/agent-runner-adapter-contract.mjs`, and `scripts/ops/agent-runner-ollama-adapter.mjs` add a disabled-by-default, non-routable OpenCode/Ollama adapter foundation: machine-local `enabled`/`paused`/`draining`/`disabled` lifecycle settings, deterministic non-model admission probes (executable, version, endpoint, installed model, host headroom), and bounded OpenCode command/result handling. The `ollama-agent` entry in `agent-runner-agents.mjs` stays `implemented: false` and `agent:ollama` stays out of `acceptedAgentLabels`, so nothing here is reachable from live issue dispatch. Copy `agent-settings.example.json` to a machine-local path (never commit the real file) to configure it later. See [`docs/ops/AGENT-RUNNER-OLLAMA-ADAPTER-FOUNDATION.md`](../docs/ops/AGENT-RUNNER-OLLAMA-ADAPTER-FOUNDATION.md) for the full contract and known limitations.

## Protected machine-local secret store (issue #45, foundation only)

`scripts/ops/agent-runner-secret-store.mjs`, `scripts/ops/agent-runner-secret-reference.mjs`, and `scripts/ops/agent-runner-secret-environment.mjs` add a protected machine-local secret broker for agent credentials and authenticated sessions: a restrictive `0700` directory of `0600` files under `~/.local/state/agent-runner/secrets` (override with `AGENT_RUNNER_SECRET_STORE_DIR`), atomic create/replace/rotate/remove with structural rollback, permission-drift and symlink defenses, a per-id write lock, an active-use lease that blocks removal, opaque `secretref:<id>` references for non-secret settings, and adapter-specific allowlisted environment materialization that never defaults to inheriting `process.env`. Only safe statuses (`configured`/`missing`/`invalid`/`rotation-required`) are ever returned by any status surface; no value is ever returned by a status/control-style function, and there is no export/print CLI in this foundation. An adapter that needs no secrets (for example Codex CLI's own existing authenticated session) passes an empty allowlist and is left untouched. Nothing here is wired into the dashboard, control API, scheduler, or live adapter dispatch. See [`docs/ops/AGENT-RUNNER-SECRET-STORE.md`](../docs/ops/AGENT-RUNNER-SECRET-STORE.md) for the full contract, threat coverage, and backup/recovery guidance.
