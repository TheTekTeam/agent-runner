# Agent Runner repository rules

This private repository is the canonical home of the reusable Agent Runner implementation.

## Source of truth

- GitHub issues and pull requests are authoritative for task status and acceptance criteria.
- `TheTekTeam/modelspend#686` governs the initial extraction and Dell cutover.
- Project repositories provide configuration and optional policy hooks; they must not fork the runner implementation.

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
