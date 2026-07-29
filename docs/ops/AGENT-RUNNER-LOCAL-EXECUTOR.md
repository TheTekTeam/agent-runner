# Agent Runner local project executor

Issue: `TheTekTeam/agent-runner#104`

The local executor is the Dell-side boundary for applying GitHub state to arbitrary configured repositories and validating exact commits. It accepts only versioned typed jobs and machine-local policy. It does not accept shell strings, SSH commands, webhook commands, or repository-supplied executable policy.

## Configuration separation

Two machine-local files are required:

1. the Agent Runner project registry, which owns repository identity and canonical checkout paths;
2. the local executor policy, which owns default branches, worktree roots, enabled operations, and argv-only validation profiles.

Example policy:

- `.agent-runner/local-executor-policy.example.json`

Production copies belong outside repositories, for example:

```text
~/.config/agent-runner/projects.json
~/.config/agent-runner/local-executor-policy.json
```

A repository cannot lower or replace this machine policy. The policy must use absolute worktree roots, unique project IDs and unique worktree roots.

## Typed operations

Initial operation vocabulary:

```text
project.inspect
repository.fetch
repository.sync-default
worktree.create
worktree.inspect
worktree.remove
validation.run
```

No `shell`, `command`, `script`, `sudo`, `deploy`, `reset`, or arbitrary path operation exists.

### Repository inspection

Verifies:

- configured path is the Git top level;
- `origin` resolves to the configured `owner/repo` identity;
- current head and branch;
- clean/dirty state and changed-entry count.

Raw remotes and changed file names are not returned.

### Default-branch synchronisation

Requires:

- exact expected remote SHA;
- clean canonical checkout;
- configured default branch currently checked out;
- successful fetch;
- `origin/<defaultBranch>` equals the expected SHA;
- fast-forward-only merge;
- exact-SHA and clean postconditions.

No force reset or divergent merge is permitted.

### Worktrees

Worktree names use a narrow filename grammar and resolve only below the machine-configured worktree root.

Creation requires an exact existing commit SHA and produces a detached clean worktree. Removal requires the same expected SHA and a clean worktree. Dirty or unknown worktrees are never removed automatically.

### Validation

Validation profiles contain command argv arrays, not shell text:

```json
{
  "argv": ["bash", "scripts/validate.sh"],
  "timeoutSeconds": 3600
}
```

Each command runs:

- without a shell;
- in the exact canonical checkout or named owned worktree;
- with a bounded timeout and output buffer;
- using a base environment allowlist plus explicitly named policy variables;
- only after exact-SHA and optional clean-before checks.

The stored result contains exit status, signal, byte counts and SHA-256 digests of stdout/stderr. Raw command output and environment values are not persisted. The target must still be on the exact SHA after validation and can be required to remain clean.

## Job contract

Example:

```json
{
  "schemaVersion": 1,
  "jobId": "job-modelspend-12345678",
  "nonce": "nonce-modelspend-1234567890",
  "projectId": "modelspend",
  "operation": "validation.run",
  "expectedSha": "0123456789abcdef0123456789abcdef01234567",
  "expiresAt": "2026-07-29T06:00:00Z",
  "arguments": {
    "profile": "thorough",
    "worktreeName": "pr-123"
  }
}
```

Jobs have bounded IDs, one-use nonces, expiry, project identity, typed operation, optional exact SHA, and operation-specific arguments.

The SQLite ledger stores request digests and final bounded results. An identical completed job is idempotently returned. Reusing a job ID with different content or reusing a nonce is rejected.

A project lock is acquired transactionally before execution. This prevents two executor processes using the same controller database from mutating the same project simultaneously. Expired locks are removed before a new job begins.

The executor refuses to run as root.

## One-shot command

```bash
node scripts/ops/agent-runner-local-executor-job.mjs \
  --project-registry ~/.config/agent-runner/projects.json \
  --executor-policy ~/.config/agent-runner/local-executor-policy.json \
  --db ~/.local/state/agent-runner/controller/controller.sqlite \
  --job /path/to/typed-job.json
```

The command reads one local typed job file, prints one compact JSON result, and exits. It is suitable for a supervised systemd job consumer. It does not create a listener or accept network input.

## Current boundary

This foundation does not yet:

- generate executor jobs from triage releases;
- publish branches or PRs;
- invoke coding-agent adapters;
- deploy applications;
- recover and retry an interrupted `running` job automatically;
- delete remote GitHub branches.

Those are separate programme slices. An interrupted job remains durable evidence and requires a new explicitly generated job after recovery classification; it is never silently replayed.

## Validation

```bash
node --check scripts/ops/agent-runner-local-executor-policy.mjs
node --check scripts/ops/agent-runner-local-executor.mjs
node --check scripts/ops/agent-runner-local-executor-job.mjs
node --check scripts/ops/agent-runner-local-executor.test.mjs
node --test \
  scripts/ops/agent-runner-project-registry.test.mjs \
  scripts/ops/agent-runner-local-executor.test.mjs
bash scripts/validate.sh
```
