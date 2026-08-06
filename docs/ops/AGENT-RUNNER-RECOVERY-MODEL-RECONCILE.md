# Recovery attempt model reconciliation

Issue: `TheTekTeam/agent-runner#148`

`recovery_attempts` now persists the exact resolved model for every fresh implementation attempt at claim time, and a write-once identity guard refuses any later write that disagrees with an already-persisted agent/model/harness. Attempt rows created before that fix can still have a `NULL` model even though their restricted-handle binding authenticates the attempt. This command repairs exactly one such row.

This is deliberately not a general historical-reconciliation tool. It only ever recognizes and repairs one exact, fixed preserved-checkpoint shape -- the one `TheTekTeam/agent-runner#136`'s blocked packet `.12` attempt left behind: `repo` `TheTekTeam/agent-runner`, `issue` `136`, `phase` `starting`, `outcome` `unknown_failure`, `exit_code` `1`, `recovery_eligible` `0`, `recovery_action` `attention_required`, `recovery_attempt_count` `0`, checkpoint/session/worktree available, branch/PR unavailable, `attention_status` `attention_required`, `resolution_state` `unresolved`. A persisted row that does not match every one of those fields exactly fails closed with `attempt-shape-unsupported` before any other check runs.

## Non-root execution

The command refuses to run as root, before any config read, SQLite open, or GitHub contact:

```bash
npm run recovery:model:reconcile -- --attempt-id ... --repo ... [...]
```

Running it as `root` (`uid 0`) exits with `root-execution-forbidden` and touches nothing.

## Required arguments

Every argument is explicit operator-supplied evidence for one exact attempt. None is inferred from a live scheduler selection, and the database/restricted-recovery-root paths are never defaulted from process environment variables.

| Flag | Description |
| --- | --- |
| `--attempt-id` | Exact `recovery_attempts.attempt_id` to repair. |
| `--repo` | `owner/name` GitHub repository. Cross-checked against both the persisted row and the fixed supported-shape repository. |
| `--agent` | Expected persisted/handle agent id (e.g. `claude-code-cli`). |
| `--harness` | Expected persisted/handle harness (e.g. `claude`). |
| `--model` | Expected captured model. Must be an exact, case-sensitive member of this runner's bounded supported model vocabulary (`haiku`, `sonnet`, `opus`). |
| `--branch` | Expected approved branch. |
| `--worktree` | Expected preserved worktree name. |
| `--manager-revision` | Expected persisted manager preflight revision. |
| `--manager-fingerprint` | Expected persisted manager preflight fingerprint (`sha256:...`). |
| `--manager-body-digest` | Expected persisted manager preflight body digest (`sha256:...`). |
| `--repo-root` | Filesystem path to the repository checkout containing the preserved worktree. |
| `--output-dir` | Filesystem path to the runner output directory containing the restricted recovery handle. |
| `--state-db` | Filesystem path to the exact SQLite state database to repair. |

Unknown options, duplicate options, and an option immediately followed by another option (an ambiguous or missing value) are all rejected before any I/O with `usage-error`.

## What it proves before writing

Inside one `BEGIN IMMEDIATE` transaction, re-read fresh under that transaction's own write lock:

- the attempt row exists, and matches the exact supported #136 preserved-checkpoint shape described above -- otherwise `attempt-shape-unsupported`;
- the persisted `model` is `NULL` (a non-null differing model is always refused, never replaced);
- the restricted handle is available and its enclosing directory/file pass exact owner/mode/type/symlink checks;
- the persisted `restricted_handle_digest` exactly authenticates the freshly re-read handle;
- persisted agent/harness exactly match both the handle and the operator's `--agent`/`--harness`;
- the handle's captured model is an exact, case-sensitive supported model identifier and matches `--model`;
- persisted manager revision/fingerprint/body digest are present and match the operator's `--manager-*` values exactly;
- the handle's branch/worktree identity matches `--branch`/`--worktree` exactly;
- the preserved worktree's HEAD and status fingerprint are still exactly current;
- no remote branch or PR (any state) has appeared for the expected branch -- checked once before the transaction opens, and again immediately before COMMIT. Only an authenticated GitHub 404 proves a branch is absent; any empty, mismatched, malformed, partial, rejected or rate-limited response fails closed instead of being read as "ruled out".

A single compare-and-set `UPDATE` binds every one of the fields above -- `attempt_id`, `model IS NULL`, `agent`, `harness`, `repo`, `issue_number`, the manager identity triple, `restricted_handle_digest`, and the complete recovery-resolution shape (`phase`, `outcome`, `exit_code`, `recovery_eligible`, `recovery_action`, `recovery_attempt_count`, `checkpoint_available`, `session_available`, `worktree_available`, `branch_available`, `pr_available`, `attention_status`, `resolution_state`) -- and must change exactly one row. The row is re-read afterward, its exact shape and recomputed binding re-verified, before COMMIT. Any failure at any step rolls back and mutates nothing.

## Output and exit codes

Output is one line of bounded JSON: `{ ok, code, attemptId, model?, bindingDigest? }`. It never includes a session id, restricted-handle path, raw handle JSON, prompts, provider output, credentials, environment values, or unrestricted logs.

| Exit code | Meaning |
| --- | --- |
| `0` | `reconciliation-complete` or `reconciliation-replay`. |
| `1` | A fixed reconciliation failure code (see below). |
| `2` | `usage-error` -- malformed/missing/unknown/duplicate arguments. |
| `3` | `root-execution-forbidden`. |
| `4` | `internal-error` -- an unexpected internal failure; `error.message` is never included. |

Failure codes: `attempt-not-found`, `attempt-shape-unsupported`, `restricted-handle-unavailable`, `restricted-handle-permissions-unsafe`, `stored-binding-invalid`, `persisted-agent-mismatch`, `persisted-harness-mismatch`, `persisted-model-conflict`, `captured-model-invalid`, `manager-identity-missing`, `manager-identity-mismatch`, `worktree-identity-mismatch`, `checkpoint-not-current`, `remote-publication-conflict`, `compare-and-set-conflict`, `readback-verification-failed`.

## Replay

Running the command again with the same arguments after a successful repair reruns every check above (including exact shape and both remote-publication checks) and returns `reconciliation-replay` with exit `0` and no further mutation. It never short-circuits on "model is already non-null" alone -- if evidence has since diverged (a moved branch, a rewritten checkpoint, an unexpected remote publication), replay fails closed with the matching code instead of reporting success.

## Publication and checkpoint stop conditions

- Any ambiguous, malformed, rate-limited, or otherwise inconclusive GitHub read is a failure (`remote-publication-conflict`), never evidence of absence.
- A worktree whose HEAD or status fingerprint no longer matches the preserved checkpoint fails with `checkpoint-not-current`.
- A branch that has moved (different expected branch/worktree in the handle than supplied) fails with `worktree-identity-mismatch`.

## Boundary

This command does not:

- select an attempt implicitly from the scheduler or service state;
- resume or start Claude;
- consume or generate a manager packet;
- mutate GitHub labels, comments, branches, or pull requests;
- repair any field other than the single missing `model` column;
- repair any row that does not match the exact fixed supported historical shape;
- run against the live database or restricted directory unless the operator explicitly points `--state-db`/`--output-dir` at them.

Repairing a *live* production attempt still requires the operator to explicitly point `--state-db`/`--output-dir`/`--repo-root` at the live paths, and requires its own separate post-merge manager authority/decision before doing so -- this command's bounded evidence checks are necessary but not themselves that authority.

## Validation

```bash
node --check scripts/ops/agent-runner-recovery-model-reconciliation.mjs
node --check scripts/ops/agent-runner-recovery-model-reconcile-command.mjs
node --check scripts/ops/agent-runner-recovery-identity-guard.mjs
node --test scripts/ops/agent-runner-recovery-model-reconciliation.test.mjs
node --test scripts/ops/agent-runner-recovery-model-reconcile-command.test.mjs
node --test scripts/ops/agent-runner-recovery-identity-guard.test.mjs
npm test
npm run validate
```
