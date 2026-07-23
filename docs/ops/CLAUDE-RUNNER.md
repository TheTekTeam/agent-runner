# Claude Runner

Purpose: run Claude Code CLI from a GitHub issue with explicit, immutable ChatGPT manager authority, or perform a bounded PR review follow-up, while preserving operator control, quota admission, isolated execution, and validation evidence.

## Safety model

- Real execution requires `--execute`; dry-run remains the default.
- New issue claims require one current canonical manager packet. Proceed/continue comments are read-only historical evidence.
- Missing, malformed, stale, revoked, unauthorised, or already-claimed authority launches no worker, creates no attempt, and mutates no GitHub state.
- The runner cannot generate or refresh manager packets.
- Quota, implementation opt-in, approver allowlist, workspace ownership, linked-PR review, and state-store gates remain fail-closed.
- The runner never merges, approves, closes issues, or bypasses permissions.

## Requirements

- `GITHUB_TOKEN` or `GH_TOKEN` with the required repository access.
- Claude Code CLI installed and authenticated on the runner machine.
- `CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=true` and a normalized `CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS` allowlist for implementation.
- A canonical manager packet as specified in [`AGENT-RUNNER-DISPATCH-AUTHORITY-MIGRATION.md`](./AGENT-RUNNER-DISPATCH-AUTHORITY-MIGRATION.md).

## Targeted issue flow

```bash
node scripts/ops/claude-runner.mjs --issue 629            # dry-run
node scripts/ops/claude-runner.mjs --issue 629 --execute  # execute after gates pass
```

The runner fetches the issue and comments, validates the canonical packet, resolves the approved profile and execution phase, constructs a bounded prompt, and performs linked-PR/quota/workspace checks. The scheduled wrapper revalidates the same immutable revision and fingerprint before claim; the pinned child re-reads and verifies that exact authority after the runner-start marker is posted.

## Scheduled queue flow

```bash
node scripts/ops/claude-runner-cron.mjs
node scripts/ops/claude-runner-cron.mjs --execute
```

The queue scanner continues past issue-local `manager-preflight-required` results. It does not synthesize commands or packets. Historical command comments are ignored for new-claim authority. Use `--skip-quota-preflight` only for supervised diagnosis; there is no manager-authority bypass.

## Quota-aware pausing

The runner never bypasses, evades, rotates, or works around Claude usage
limits. It only detects exhaustion signals and pauses conservatively.

- After an `--execute` run, `scripts/ops/claude-runner-quota.mjs` inspects
  the combined stdout/stderr for quota-exhausted / rate-limit phrasing. If
  found, the runner records a pause window in
  `<output-dir>/quota-state.json` instead of treating it as an ordinary
  failure.
- The pause window is at least 10 minutes (`MIN_QUOTA_BACKOFF_MS`), unless a
  precise, plausible reset timestamp was present in the output, in which
  case the pause runs until that reset time.
- While paused, `--issue`/`--pr` runs (dry-run or `--execute`) refuse to
  proceed and instead report `{ blocked: true, reason: 'quota-paused',
  pausedUntil }` without contacting GitHub or Claude again.
- `--check-quota` runs a dedicated, conservative `/usage` check (`claude -p
  --output-format text --permission-mode plan /usage`) and updates the pause
  state:
  - a clear current-session usage signal below the start threshold clears the
    pause;
  - a clear exhausted or above-threshold signal starts a pause using the
    parsed reset timestamp where available;
  - **anything ambiguous fails closed** — the pause is kept/extended rather
    than assuming quota is free.
- `--check-quota` itself enforces at least 10 minutes between checks (using
  the state file's `lastCheckedAt`) unless `--force-quota-check` is passed.
  This is an operator override of the check's own cadence, not a bypass of
  the underlying Claude limit.

```bash
node scripts/ops/claude-runner.mjs --check-quota
node scripts/ops/claude-runner.mjs --check-quota --force-quota-check
```

## Plan-only detection (issue #660)

Every runner profile currently invokes Claude with `--permission-mode plan`,
so an `--execute` run can exit 0 with real response text while never editing
any code — Claude only wrote a plan file and is waiting for approval. That is
not implementation success, so `claude-runner.mjs` distinguishes it from a
completed run:

- `detectPlanOnlyResult()` inspects the combined stdout/stderr for the
  observed signature (a plan file path under `.claude/plans/*.md` and/or an
  explicit "no code edits" statement) and sets `planProduced`, `planPath`,
  and `awaitingPlanApproval` on the run-log payload.
- A plan-only run returns exit code `2` (`PLAN_ONLY_EXIT_CODE`), distinct
  from `0` (real output) and `1` (execution no-op, see below).
- `claude-runner-cron.mjs`'s `evaluateChildRunResult()` also treats a child
  payload with `awaitingPlanApproval: true` as a failure defensively, and the
  cron log surfaces `awaitingPlanApproval`/`planPath` at the top level for
  visibility regardless of exit code.
- Because the issue stays `status:in-progress` with a runner-started marker
  and no new `## Claude continue command`, the existing active-run guard
  (issue #647) already refuses to claim other ready work until an
  operator/manager reviews the plan and either approves/continues it or
  changes the profile's permission mode. This PR does not change
  `permissionMode` for any profile — see issue #580 for that follow-up.

## PR review follow-up prompt generation

When ChatGPT (or another reviewer) leaves review feedback on an open PR, the
runner can detect it and generate a follow-up prompt instead of starting new
issue work on top of unresolved feedback.

```bash
# Dry-run: reports whether PR #630 has unresolved review follow-up and, if so,
# writes the generated follow-up prompt to the local run log.
node scripts/ops/claude-runner.mjs --pr 630

# Optional: actually run Claude with the follow-up prompt.
node scripts/ops/claude-runner.mjs --pr 630 --execute
```

Detection (`scripts/ops/claude-runner-review-followup.mjs`) is driven by
GitHub's own review state, not ad-hoc comment parsing: a PR has unresolved
follow-up when the most recent review from any reviewer is
`CHANGES_REQUESTED`, or when any review thread is explicitly unresolved.
Comment text is collected as supporting context for the prompt, not as the
trigger, to avoid false positives on ordinary conversation.

The generated prompt always includes: the PR number and URL, the linked
issue number (parsed from `Closes #N` / `Fixes #N` / `Resolves #N` in the PR
body/title, when present), the branch name, the unresolved
review/manager comments, and explicit instructions to stay on the same
branch, address only the follow-up, avoid unrelated refactors, rerun the
relevant validation, and leave merging/approving/closing to a human.

**Before starting `--issue` work**, the runner checks whether any open PR
plausibly linked to that issue (by `Closes #N`-style reference or by a
branch name ending in the issue number) has unresolved review follow-up. If
so, it refuses to start the issue and reports
`{ blocked: true, reason: 'unresolved-pr-review-followup', pr, ... }`
pointing the operator at `--pr <number>` instead. Pass
`--skip-pr-followup-check` to override this gate for a specific run.

In v1 this is reporting/prompt-generation only: it never resolves review
threads, dismisses reviews, or comments on GitHub itself.

## Redaction

`scripts/ops/lib/redact.mjs` is the single shared redaction helper (used by
both the Claude runner and `scripts/ops/github-automation/lib.mjs`). It is
applied to:

- Claude CLI stdout/stderr before it is written to a local run log or
  printed;
- the `/usage` check output before it is written to the state file/log;
- the generated prompt before it is included in a dry-run plan.

It redacts, among other things: GitHub tokens (`ghp_`/`gho_`/`github_pat_`),
Anthropic keys (`sk-ant-...`), generic `sk-...`/`sk_live_...`/`sk_test_...`
keys, Google API keys, AWS access key IDs, Slack and GitLab tokens, `Bearer
...` / `Authorization:` headers, `key=value`-shaped secrets (`api_key`,
`token`, `secret`, `password`, `client_secret`, `private_key`,
`access_key(_id)`, `secret_access_key`, `auth_token`, `bearer_token`),
`.env`-style lines whose key name looks sensitive (`*KEY*`, `*TOKEN*`,
`*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`), database/broker connection URLs
(`postgres(ql)`, `mysql`, `mongodb(+srv)`, `redis`, `amqp`), `Cookie:` /
`Set-Cookie:` headers, and Playwright-style storage-state `"name"/"value"`
pairs. Over-redaction is acceptable; under-redaction is not.

## Validation

Focused validation should cover:

```bash
node --test scripts/ops/claude-runner.test.mjs scripts/ops/claude-runner-cron.test.mjs
node --test scripts/ops/claude-runner-quota.test.mjs
node --test scripts/ops/claude-runner-review-followup.test.mjs
node --test scripts/ops/lib/redact.test.mjs
```

For issues that touch this runner, also run the repo's standard gates
(`npm run test:gates`, `npm run validate:quick -- --files <changed paths>`)
per `docs/claude/VALIDATION-GATES.md`.

## Logs and state

Everything the runner writes lives under `<output-dir>` (default
`.var/claude-runner`, already git-ignored):

- `issue-<N>-<timestamp>.json` / `pr-<N>-<timestamp>.json` — one run log per
  invocation (redacted stdout/stderr, resolved profile, prompt, exit code).
- `quota-state.json` — the current quota pause state (`pausedUntil`,
  `reason`, `lastCheckedAt`, etc.).
- `cron-<timestamp>.json` — one log per `claude-runner-cron.mjs` invocation.

None of this is committed; do not add exceptions to `.gitignore` for it.

## Known limitations (v1)

- PR review-thread resolution (`reviewThreads[].isResolved`) requires
  GitHub's GraphQL API; the REST-only `findBlockingPrFollowUp` path relies
  primarily on review state (`CHANGES_REQUESTED`) and only uses thread data
  when the caller supplies it directly. A future iteration could add a
  GraphQL fetch for full thread-resolution fidelity.
- The exact `/usage` output format from the Claude CLI is not a stable,
  documented contract; `claude-runner-quota.mjs` pattern matching is based on
  the observed `Current session: N% used · resets ...` line and remains
  conservative/fail-closed for ambiguous output.
- Autonomous issue selection (`claude-runner-cron.mjs`) performs quota
  preflight before selecting or claiming work, and separately requires a
  ChatGPT/manager preflight packet before an issue can be selected.
- `linkedIssueNumberFromPr` and the issue→PR linking heuristic are
  conservative (explicit `Closes/Fixes/Resolves #N` or a branch name ending
  in the issue number); a PR that references an issue in prose without one
  of those keywords will not be detected as linked.
