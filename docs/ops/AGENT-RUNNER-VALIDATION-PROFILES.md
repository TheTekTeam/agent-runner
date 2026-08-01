# Project-declared validation profiles

Issue: #134 under programme #99.

## Purpose

Validation profiles turn a typed local-executor `validation.run` operation into durable evidence that later PR and merge controllers can trust. The controller does not guess a package manager, script, working directory, environment or artifact. Every command is declared in the machine-local executor policy.

This layer adds no GitHub mutation, PR publication, merge, model invocation, network listener or production-deployment authority.

## Policy contract

Each project keeps its existing `validationProfiles` object. A profile supports:

```json
{
  "commands": [
    {
      "argv": ["npm", "run", "validate"],
      "workingDirectory": ".",
      "timeoutSeconds": 3600,
      "environment": ["CI"]
    }
  ],
  "requireCleanBefore": true,
  "requireCleanAfter": true,
  "artifacts": ["reports/validation.json"],
  "evidenceTtlSeconds": 21600,
  "riskClasses": ["R1", "R2"]
}
```

Project-level fields:

```json
{
  "requiredValidationProfiles": {
    "R1": ["focused"],
    "R2": ["focused", "thorough"]
  },
  "maxValidationArtifactCount": 16,
  "maxValidationArtifactBytes": 5242880
}
```

Core limits are positive ceilings. Project policy can omit or tighten them; it cannot exceed the core maximums.

### Commands

- `argv` is required and passed without a shell.
- `workingDirectory` is a relative POSIX path contained by the validation target.
- only named environment variables are copied from the parent process; values are never persisted.
- timeouts are bounded.
- dirty-before and dirty-after requirements are explicit.

### Artifacts

Artifact declarations are exact relative file paths, not globs. Artifacts must be regular non-symlink files contained by the validation target. Evidence stores only relative path, byte count and SHA-256 digest. Files are never uploaded by this component.

## Durable evidence

The controller shares the local-executor SQLite database and adds:

- `validation_runs`
- `validation_command_results`
- `validation_artifacts`

A final run is bound to:

- request/job identity
- project and repository
- profile and target kind
- expected and observed SHA
- start, finish and expiry times
- clean-before/after state
- command-contract digests and bounded output digests
- artifact digests
- a fixed failure code when unsuccessful

The local-executor job result is atomically replaced with a compact validation reference. Absolute paths, raw stdout/stderr, environment values, remotes and credentials are not retained in validation evidence.

A repeated request reuses the same durable evidence. If the process completed the executor job but stopped before recording evidence, the next identical request adopts that final job and reconstructs the bounded evidence without running commands again.

## Freshness and post-merge comparison

`evaluateValidationFreshness` fails closed unless:

- evidence succeeded;
- project/profile match;
- expected and observed SHA both equal the requested SHA;
- evidence has not expired.

`comparePostMergeValidation` compares two successful runs only when project, profile and command contract are identical and the post-merge run is not older. It reports the two observed SHAs and whether declared artifact digests changed. It does not decide whether a PR may merge.

## One-shot command

```text
node scripts/ops/agent-runner-validation-profile-command.mjs \
  --project-registry /path/to/projects.json \
  --executor-policy /path/to/local-executor-policy.json \
  --db /path/to/controller.sqlite \
  --project agent-runner \
  --profile thorough \
  --expected-sha <sha> \
  --request-id <stable-id> \
  --target canonical \
  --risk-class R1
```

For a worktree target, add:

```text
--target worktree --worktree-name <executor-owned-name>
```

The command must run as a non-root user. Output is one bounded JSON object. A failed profile exits nonzero and can never be represented as successful evidence.

## Authority boundary

This component may execute only an already-declared validation profile through the existing typed local executor. It cannot create branches, publish PRs, approve reviews, merge, close issues, delete branches, deploy, change secrets or generate manager authority.
