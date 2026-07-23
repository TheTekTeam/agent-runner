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
approved_repository_scope:
  - <owner>/<repo>
approved_branch: <exact Git branch>
base_commit: <40-character commit SHA>
scope:
  - <bounded work>
required_validation:
  - <commands/gates>
stop_conditions:
  - <conditions requiring manager intervention>
```

The durable authority key is `manager-preflight:<revision>:<fingerprint>`. The scheduler also records a SHA-256 digest of the complete packet comment body. The attempt row, recovery path, liveness classifier, and pinned child require both the authority key and the unchanged body digest. The GitHub comment identity is retained only as source evidence.

## Repository and branch dispatch authority (#56)

`approved_repository_scope` and `approved_branch` are required for every implementation dispatch and are resolved and verified by `scripts/ops/agent-runner-dispatch-authority.mjs::resolveDispatchAuthority()` -- the single pre-claim boundary `resolveImplementationDispatchIdentity()` (`claude-runner.mjs`) and the scheduler (`claude-runner-cron.mjs`) both call before any claim, attempt, GitHub mutation, workspace mutation, or worker/model launch:

- `approved_repository_scope` must contain exactly one `owner/repo` entry. It is resolved through the same repository registry as the legacy `implementation_repository` field (`agent-runner-repository-context.mjs::resolveRepositoryContext()`), so the implementation repository can only ever be the configured project repository or the runner's own repository -- never the ModelSpend project by default, the queue repository, or the current checkout, and never an unrecognised repository.
- `approved_branch` is preserved byte-for-byte as the Git branch used for checkout, implementation, commit, push, and PR publication. It replaces the previously generated `worktree-agent-runner-<issue>-<comment>` branch scheme; the deterministic worktree *directory* name is still generated, so a filesystem naming choice can never substitute for or alter the authorised branch.
- `base_commit` must be a well-formed 40-character commit SHA; it is carried through as part of the resolved dispatch authority.
- A legacy free-form `key: value` line (parsed the same way as `implementation_repository`) that disagrees with a canonical YAML field fails closed rather than silently preferring either source.
- Missing, multiple, or malformed `approved_repository_scope`/`approved_branch`/`base_commit` fails closed with `failureScope: issue_not_runnable`. A canonical repository this machine has no checkout registered for fails closed with `failureScope: systemic`.
- A rejection here produces zero model calls, zero attempts, zero claims, and zero GitHub/workspace mutations -- the scheduler only records a local (non-GitHub) queue event for operator visibility.

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
