# Dispatch authority migration

Issue: `TheTekTeam/agent-runner#43`

## New authority contract

Every new claim is authorised by the latest current issue comment containing:

```html
<!-- agent-runner:manager-preflight -->
```

and a fenced YAML packet with:

```yaml
schema_version: agent-runner-manager-preflight/v1
revision: <immutable manager-owned revision>
fingerprint: sha256:<64 lowercase hex characters>
producer_type: normal_chatgpt_manager_session # or chatgpt_scheduled_task
approved_agent: claude-code-cli
execution_phase: implementation
scope:
  - <bounded work>
required_validation:
  - <commands/gates>
stop_conditions:
  - <conditions requiring manager intervention>
```

The durable authority key is `manager-preflight:<revision>:<fingerprint>`. The scheduler also records a SHA-256 digest of the complete packet comment body. The attempt row, recovery path, liveness classifier, and pinned child require both the authority key and the unchanged body digest. The GitHub comment identity is retained only as source evidence.

## Retired behaviour

- `## Claude proceed command` and `## Claude continue command` remain readable historical evidence but cannot authorise new claims.
- Automatic/local/generated preflight production is removed from live contracts. The old preflight module is a fail-closed compatibility tombstone.
- Manager-authority bypass/disable flags are rejected as unknown arguments.
- `CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION`, `CLAUDE_RUNNER_CRON_DISABLE_AUTO_PREFLIGHT`, and related auto-proceed/preflight-direct compatibility settings no longer enable behaviour. The systemd installer removes the retired implementation key from its managed env file.

## Claim and revision rules

- Editing any packet text without a new manager-owned revision and fingerprint invalidates candidate revalidation and any pinned attempt whose persisted body digest no longer matches.
- A runner-start marker records the exact revision, fingerprint, and authority key.
- Duplicate scheduler passes cannot reclaim the same authority key.
- A later valid packet supersedes earlier command/comment history.
- A stale/revoked/invalid packet launches no worker, creates no attempt, and causes no GitHub mutation.
- The packet `approved_agent` must match the issue's sole executable agent label, and the comment author must be in the machine-local approver allowlist.

## Persistence migration

SQLite migration is additive. `recovery_attempts` gains:

- `manager_preflight_revision`;
- `manager_preflight_fingerprint`;
- `manager_preflight_body_digest`;
- `manager_authority_key`.

Historical rows without these fields retain comment-ID fallback only for recovery/evidence compatibility. New rows must carry the immutable fields.

## Operator migration

1. Keep the execution timer disabled during rollout.
2. Remove retired auto-preflight/manager-bypass settings from machine-local config and service drop-ins.
3. Reinstall the user service/timer with `install-claude-runner-systemd.sh`; it removes the retired generated-preflight implementation key.
4. Run focused tests and `npm test`.
5. Back up and migrate the SQLite state through the normal runner startup/doctor path.
6. Confirm missing/stale packet tests show zero model calls and zero GitHub mutation.
7. Perform the supervised negative test and one bounded positive canary governed by `#41`/`#5` before enabling recurrence.

## Rollback

Reverting the application code is safe because the SQLite changes are additive and historical comments are not deleted. Retain the database backup and do not re-enable legacy automatic preflight generation. A rollback does not authorise timer enablement; the programme acceptance gates remain authoritative.
