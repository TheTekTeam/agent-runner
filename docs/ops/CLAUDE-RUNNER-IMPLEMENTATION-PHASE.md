# Claude runner implementation phase

This runbook covers the non-interactive transition from a manager preflight to a real Claude Code implementation attempt.

## Why ordinary work does not run a second Claude plan

A current `## Manager preflight packet` is durable plan evidence. For `docs`, `narrow`, and `complex` profiles, the runner therefore requests implementation directly after all machine-local gates pass. This avoids paying Claude to repeat a plan that the manager already supplied.

`critical` work remains plan-first unless the current manager command/preflight explicitly contains:

```text
Phase: implementation
```

Any task can be forced to read-only planning with:

```text
Phase: plan
```

Plan-only output never counts as implementation.

## Authorization and permission model

Every paid plan or implementation attempt requires an allowlisted manager-preflight author, which prevents arbitrary issue comments from consuming quota. Implementation additionally requires the write opt-in. Configure both for the normal Dell workflow:

```bash
CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=true
CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS=gpcola
```

The latest current manager preflight author must appear in the comma-separated approver list. A proceed/continue command author must also appear there. GitHub issue text cannot change the permission mode, approver list, tool rules, branch, or worktree policy.

Locally generated preflights have a separate opt-in and remain blocked from implementation by default:

```bash
CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION=true
```

Leave that setting unset during the initial rollout. Human/manager-authored packets such as the current #658 packet do not need it.

The implementation permission mode is fixed to `dontAsk`. Claude receives only an explicit set of read/edit tools and scoped build, test, validation, and local Git commands. Anything else is automatically denied. User/project/local setting sources are disabled for the scripted invocation so hidden permission rules or hooks cannot widen that list; the prompt requires Claude to read the tracked repository instructions directly. `Agent`, web tools, MCP tools, `gh`, `git push`, destructive Git commands, `rm`, `sudo`, `curl`, and `wget` are denied to the model. `bypassPermissions` and auto mode are disabled in invocation settings and can never be selected by issue metadata.

## Isolation and publication

Each attempt gets a deterministic native Claude worktree:

```text
.claude/worktrees/agent-runner-<issue>-<source-comment>/
```

and the owned branch:

```text
worktree-agent-runner-<issue>-<source-comment>
```

Before any paid call, the runner:

1. requires Claude Code `2.1.208` or newer and records a non-blocking `claude --help` diagnostic;
2. fetches the configured base (default `origin/main`);
3. confirms `origin/HEAD` matches that base;
4. refuses an existing branch/worktree identity;
5. fingerprints the runner checkout so mutations outside the worktree are detectable.

Claude must finish with a clean commit on the exact owned branch. The allowlist requires `git commit --no-verify ...`; unattended repository hooks do not run, and validation remains an explicit evidence-producing step. A clean exit with no commit, uncommitted files, a dirty post-commit tree, another plan, a missing worktree, or a mutated runner checkout is a failed implementation attempt.

Only after those checks pass does deterministic runner code push the exact owned branch and create/reuse a draft PR. Claude itself cannot push or call GitHub. The runner never approves, merges, marks a PR ready, or closes an issue.

## Dell rollout

First verify the installed CLI without making a model request:

```bash
claude --version
```

The installed version must be `2.1.208` or newer. Anthropic documents that `claude --help` is not exhaustive, so omitted help entries are diagnostic only. Unsupported flags are rejected by Claude's argument parser before a model request.

Add the machine-local policy to the existing user service with a systemd drop-in. Do not commit these values:

```bash
systemctl --user edit modelspend-claude-runner.service
```

Add:

```ini
[Service]
Environment=CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=true
Environment=CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS=gpcola
```

Then reload and inspect before starting the timer:

```bash
systemctl --user daemon-reload
systemctl --user cat modelspend-claude-runner.service
env CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=true \
  CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS=gpcola \
  node scripts/ops/claude-runner.mjs --issue 658
```

The dry-run JSON must show:

- `executionPhase: "implementation"`;
- `executionAuthorization.allowed: true`;
- `permissionMode: "dontAsk"`;
- the issue-specific worktree/branch identity;
- no `bypassPermissions` argument.

After reviewing that output:

```bash
systemctl --user restart modelspend-claude-runner.timer
systemctl --user start modelspend-claude-runner.service
journalctl --user -u modelspend-claude-runner.service -n 100 --no-pager
```

Do not enable generated-preflight implementation during the initial #658 run.

## Failure behavior

Authorization, unsupported CLI controls, stale base state, or worktree ownership conflicts stop before Claude starts and therefore spend no model tokens. A failure after Claude starts preserves the isolated worktree evidence, records the normalized reason and usage/cost envelope, quarantines only that issue, posts the existing sanitized attention marker, and releases the global queue for other eligible tasks.

Safe recovery uses a new manager decision or a future proven checkpoint/resume path. Never reuse an implementation branch/worktree silently and never blind-retry a fresh paid context.

The recovery policy permits at most one same-profile native resume for a turn-limit failure, and only when a stable native session/checkpoint, exclusive process/lease and repository ownership, compatible branch/worktree/PR state, and quota/cost/turn headroom are all positively proven. Validation continuation has the same fail-closed posture and additionally requires an explicit deterministic policy-approved validation failure. Missing or ambiguous evidence produces one durable attention state instead of a paid retry.

Before a recovery claim, immediately before its action-specific child invocation, and before applying a successful status transition, the scheduler re-fetches the issue and open PRs and compares them with the persisted claim/preflight revisions, fresh manager recovery authorization, stable process/lease identity, repository evidence, and configured agent/model/harness. Each actual boolean and revision is stored with the stage decision. A newer status, handoff, PR, manager action, or ambiguous local fact stops the recovery and leaves GitHub unchanged.

Plan output normalizes both `awaiting-plan-approval` and `awaiting_plan_approval` to `plan_only_awaiting_approval`. It moves the task into an explicit approval wait, never approves itself, and never treats the wait as an unknown failure. After a successful authorized recovery the runner may conservatively restore `status:in-progress`; it must not close the issue.
