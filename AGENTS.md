# Agent Runner repository rules

This private repository is the canonical home of the reusable Agent Runner implementation.

## Source of truth

- GitHub issues and pull requests are authoritative for task status and acceptance criteria.
- `TheTekTeam/modelspend#686` governs the initial extraction and Dell cutover.
- Project repositories provide configuration and optional policy hooks; they must not fork the runner implementation.

## Fast task routing

- For manager preflight packets, packet revision/fingerprint, body digest, authority keys, or repository/branch dispatch, read [`docs/ops/AGENT-RUNNER-MANAGER-AUTHORITY-CODE-MAP.md`](docs/ops/AGENT-RUNNER-MANAGER-AUTHORITY-CODE-MAP.md) before searching source.
- There is intentionally no live manager-packet generator in this repository. The runner validates manager-authored packets and computes the full comment-body digest; it must not create or refresh manager authority.
- For a known issue, fetch that issue and its comments directly. Do not scan the full queue or preload unrelated runner history.

## Assignment policy

- `agent:codex-claude` is the one canonical shared-assignment label for work that may be completed by Codex Web or Claude Code CLI.
- An issue labelled `agent:codex-claude` may be implemented by either Codex Web or Claude Code CLI. The selected implementation attempt still uses one named agent and one current manager packet. The label does not authorise Codex CLI, automatic fallback or parallel duplicate execution.
- For local Agent Runner execution, the shared label resolves only to the approved `claude-code-cli` adapter and records Claude as the actual selected agent.
- Keep `agent:codex` for manual Codex Web-only exceptions with a specific current technical reason. Keep `agent:codex-cli` separate and disabled unless it is explicitly qualified and authorised under its paid-use controls.

## Safety

- Preserve human merge/approval gates, manager preflight, quota controls, claim guards, state durability, redaction and fail-closed unsupported-agent behaviour.
- Never commit tokens, credentials, machine-local config, SQLite state, raw prompts, provider responses or unrestricted logs.
- Runtime state belongs under XDG config/state paths, outside source checkouts.
- Do not expose writable unauthenticated LAN endpoints.
- A migration or installer must retain a tested rollback path and must never delete the old ModelSpend-contained state during cutover.

## Changes

- Use one issue-sized branch and PR.
- Validate changed entrypoints with `node --check`, focused tests and `npm test`.
- Installation/systemd/state-migration changes require the thorough repository validation script.
- Keep the legacy static dashboard until Grafana semantic parity is field-proven.

## Completion report

Include issue, branch, commit/PR, files changed, validation commands/results, known limitations and whether the change is safe to merge.
