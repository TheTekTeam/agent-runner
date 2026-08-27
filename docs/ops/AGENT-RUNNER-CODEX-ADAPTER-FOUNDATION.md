# Codex CLI adapter foundation (issue #48)

Status: **foundation only — disabled and non-routable by default.** Nothing
in this document authorises live Codex execution, queue routing, label
activation, concurrency, or timer enablement. See `#41` for the MVP
sequencing this slice belongs to; a capped supervised Codex CLI canary and
full repository validation are explicitly deferred to that later gate.

## Binding identity and cost policy

- `agent:codex` means **Codex Web/manual work only** and never resolves to a
  local process. It has no entry anywhere in
  `scripts/ops/agent-runner-agents.mjs`'s `AGENT_ADAPTERS` catalogue.
- Only `agent:codex-cli` identifies this adapter
  (`AGENT_ADAPTERS['codex-cli']`, still `implemented: false`).
- Every committed/default/example setting is disabled
  (`enabled: false, disabled: true`).
- A real invocation additionally requires all three parts of the paid-use
  gate below — disabled-by-default and the paid-use gate are independent
  layers, not one substituting for the other.

## What this adds

- **`scripts/ops/agent-runner-agents.mjs`** (edited) — the `codex-cli`
  catalogue entry's `labels` now reads `['agent:codex-cli']` only (it
  previously, incorrectly, also listed `agent:codex`). `command: null` and
  `implemented: false` are both unchanged by this issue — the catalogue
  entry stays exactly as fail-closed/non-routable as every other
  not-yet-implemented adapter (`ollama-agent`, `gemini-cli`, `gpt-agent`),
  and this document does not authorise setting either field to an
  executable value.
- **`scripts/ops/agent-runner-agent-settings.mjs`** (edited) — adds a
  `codex-cli` entry to the shared `AGENT_SETTINGS_EXAMPLE` payload (mirrored
  byte-for-byte in `.agent-runner/agent-settings.example.json`, proven by the
  existing parity test). The generic fail-closed lifecycle loader itself is
  unchanged.
- **`scripts/ops/agent-runner-codex-command.mjs`** (new) — bounded,
  Codex-native `codex exec` argv construction: sandbox, approval (via the
  documented `-c approval_policy=` override), model, reasoning effort,
  structured `--json` output, `--output-schema`, and an explicit,
  always-required worktree `-C <cwd>`. No shell-string construction; this
  function only returns an array.
- **`scripts/ops/agent-runner-codex-parser.mjs`** (new) — a bounded JSONL
  event-stream parser for `codex exec --json` output, classifying success,
  no-op, task failure, authentication failure, and quota/rate-limit failure,
  plus a process-level `classifyCodexExecutionError()` for timeout/
  cancellation/generic execution errors that never produced parseable
  output.
- **`scripts/ops/agent-runner-codex-adapter.mjs`** (new) — orchestration:
  the shared enabled/paused/draining/disabled settings gate, two
  deterministic no-cost probes (`executable`, `version`), and the three-part
  paid-use admission gate (`admitCodexPaidUse`).
- Focused test files for all three new modules, plus label-separation
  assertions added to `agent-runner-agents.test.mjs` and an example-payload
  routability assertion added to `agent-runner-agent-settings.test.mjs`.

## Captured qualification evidence (local, no-cost, non-authenticated)

Run at implementation time against the installed binary — no network call,
no login, no model invocation:

```
$ codex --version
codex-cli 0.144.6

$ codex --help        # top-level; -a/--ask-for-approval only exists here
$ codex exec --help   # the non-interactive subcommand this adapter targets
```

`codex exec --help` is the ground truth for this module's flag surface:
`-s/--sandbox <read-only|workspace-write|danger-full-access>`,
`-m/--model <MODEL>`, `-C/--cd <DIR>`, `--json`, `--output-schema <FILE>`,
`-c/--config <key=value>`. It has **no** dedicated approval flag (that only
appears on the top-level interactive `codex --help`, with values
`untrusted`, `on-request`, `never`), **no** `--timeout`, **no**
`--worktree`, and **no** concurrency or fallback-provider flag. This
adapter reaches `approval_policy` through the documented generic
`-c key=value` override instead of inventing a flag, and treats
timeout/cancellation/worktree isolation as caller responsibilities (an
explicit, required `cwd`; process-level outcome classification), not CLI
switches — see "Known limitations" for what that leaves unverified.

## Machine-local agent lifecycle settings

```json
{
  "agents": {
    "codex-cli": {
      "enabled": false,
      "paused": false,
      "draining": false,
      "disabled": true,
      "executablePath": null,
      "sandboxMode": "workspace-write",
      "approvalMode": "on-request",
      "model": null,
      "reasoningEffort": null,
      "paidUseApproved": false,
      "maxCostUsdPerRun": 0,
      "maxTokensPerRun": 0,
      "sessionSecretRef": null
    }
  }
}
```

`isAgentRoutable()`/`getAgentSettings().routable` requires **all** of
`enabled: true`, `disabled: false`, `paused: false`, `draining: false`,
exactly as issue #40 established. `sessionSecretRef` is reserved for a
future opaque `secretref:<id>` (issue #45) pointing at a Codex CLI session
credential; this foundation never reads or resolves it — Codex CLI's own
authenticated session (`codex login`) is left untouched, matching the
existing note in `agent-runner-secret-environment.mjs` that an adapter
requesting zero secret-environment entries gets its base environment back
unmodified.

## The three-part paid-use admission gate

`admitCodexPaidUse({ entry, labels })` requires **all** of:

1. **Machine-local approval** — `entry.paidUseApproved === true`.
2. **A positive per-run ceiling** — `entry.maxCostUsdPerRun > 0` **or**
   `entry.maxTokensPerRun > 0` (either alone is sufficient; `0`/absent
   values on both fail closed).
3. **Explicit CLI labelling** — the dispatching issue/run's labels include
   `agent:codex-cli`. Presence of `agent:codex` alone never satisfies this.

Any one missing part fails the whole gate closed, and the failing probe
name (`paid-use-approval` / `per-run-ceiling` / `cli-label`) is always
reported, never silently combined. This is a foundation-level policy check
only — it makes no network, filesystem-write, or process call.

## Admission probes (all non-model, all injectable for tests)

`admitCodexDispatch()` runs, in strict sequence:

1. The shared settings lifecycle gate (calling no injected I/O function at
   all when not routable — itself the zero-model-call/zero-mutation proof
   for the disabled path).
2. **executable** — `accessSync(path, X_OK)` against the explicit
   `executablePath`. No `PATH` search, no default binary name.
3. **version** — the configured executable's `--version` banner only.
4. The three-part paid-use gate above.

A failing probe short-circuits later ones (proven in
`agent-runner-codex-adapter.test.mjs`).

## Isolated worktrees and no shared-checkout mutation

`buildCodexCommandArgs()` requires an explicit `cwd` — there is no default
to `process.cwd()` or any notion of "the current repository." The test
suite proves this concretely: it creates a real temporary git repository
with a real `git worktree add`, runs admission and command construction
against the worktree path with injected fakes, and asserts the *original*
repository's `git status --porcelain` and `HEAD` are byte-for-byte
unchanged afterward.

## Credentials and session material

- `buildCodexCommandArgs()` has no parameter for a secret, token, session
  id, or credential of any kind — proven by a test asserting the function's
  own source contains none of those words.
- A `sessionSecretRef` configured in settings never appears in any argv,
  probe outcome, or admission-decision payload — proven by tests that
  serialize the full decision object and assert the configured
  `secretref:...` value is absent.
- Nothing in this foundation logs, persists, or forwards `entry` verbatim;
  admission functions return only booleans, machine-readable reasons, and
  probe names.
- `probeExecutable()` returns no `detail` at all on success (not the
  configured executable path) and a fixed `codex-executable-unavailable`
  reason on failure — never the raw `accessFn` error message, which for a
  real filesystem error routinely embeds the path itself. `probeVersion()`'s
  failure path matches: a fixed `codex-version-probe-failed` reason, never
  the raw `execFileFn` error message (a real child-process spawn error
  routinely embeds the executable path too).
- `parseCodexResultEnvelope()` and `classifyCodexExecutionError()` read raw
  stdout, terminal error messages, and caller-supplied process-wrapper
  messages only to pick a bounded, machine-readable `reason`; none of that
  raw text is ever placed into the returned `resultText` (always `''` on a
  non-success/malformed path) or `structuredFailure` (always `null` or a
  closed-vocabulary token — an event `type`, an OS signal name, an error
  `code`). Only a successful `turn.completed`'s own `agent_message` item
  text — the model's actual output, not diagnostic material — populates
  `resultText`.
- All of the above is proven adversarially: `agent-runner-codex-parser.test.mjs`
  and `agent-runner-codex-adapter.test.mjs` seed malformed stdout, terminal
  error messages, timeout/cancellation/execution-error messages, and
  executable-probe errors with synthetic credentials, session handles,
  prompts, and local paths, then serialize the full returned
  result/decision and assert every synthetic value is absent.

## Known limitations

- The `codex exec --json` event schema (`thread.started`, `turn.started`,
  `item.completed` with `agent_message`/`file_change` items,
  `turn.completed`, `turn.failed`, `error`) is a documented-but-not-yet-
  live-verified assumption, exactly like the #40 Ollama/OpenCode
  foundation's assumed `{status, output, error, mutated}` contract. It has
  not been checked against a live captured Codex payload, since doing so
  requires an authenticated run — deferred to the live-enablement/canary
  gate in `#41`.
- `model_reasoning_effort` is reached through the same generic
  `-c key=value` override as `approval_policy`, but (unlike
  `approval_policy`) has no dedicated `--help`-documented flag backing it in
  the version captured above; it is included because the governing issue's
  scope requires a reasoning control, clearly flagged here as unverified.
- `parseCodexResultEnvelope()`'s no-op/mutation classification is derived
  structurally (presence of a `file_change` item) rather than from an
  explicit status field, because `codex exec --json` has no such field in
  the assumed contract; a future issue can tighten this once a live payload
  is captured.
- No scheduler, dashboard, or cron wiring reads any of these new modules
  yet. Live routing, `agent:codex-cli` label activation, and timer changes
  are explicitly out of scope for this issue.

## Validation

```bash
node --check scripts/ops/agent-runner-agents.mjs \
  scripts/ops/agent-runner-agent-settings.mjs \
  scripts/ops/agent-runner-codex-command.mjs \
  scripts/ops/agent-runner-codex-parser.mjs \
  scripts/ops/agent-runner-codex-adapter.mjs

node --test scripts/ops/agent-runner-codex-command.test.mjs \
  scripts/ops/agent-runner-codex-parser.test.mjs \
  scripts/ops/agent-runner-codex-adapter.test.mjs \
  scripts/ops/agent-runner-agents.test.mjs \
  scripts/ops/agent-runner-agent-settings.test.mjs

npm test
npm run validate
git diff --check
```


## #186 supervised quota-only qualification path

Issue #186 adds a **canary-only** execution path without making Codex generally
routable.

- The committed `AGENT_ADAPTERS['codex-cli']` entry remains
  `implemented:false`, `command:null`; normal scheduler selection therefore
  still cannot launch Codex.
- `agent-runner-codex-quota-preflight.mjs` strips API/token/base-URL
  overrides, requires `codex login status` to prove ChatGPT authentication,
  queries the supported app-server `account/rateLimits/read` RPC, and converts
  only current primary/secondary rate-limit windows into routing
  `resourceState`. Credit/reset-credit fields are not admission inputs.
- `admitCodexDispatch()` now requires positively resolved current quota
  evidence for the ChatGPT route. The historical paid-use helper remains
  exported only for compatibility tests; it is no longer the dispatch
  authority.
- `agent-runner-codex-canary.mjs` consumes the existing immutable
  manager-preflight + dispatch-authority contract, acquires the existing
  implementation slot, creates one temporary manager-authorised worktree and
  branch, and uses the existing serial selector plus Codex command/parser
  modules.
- The canary task is structurally fixed: create only `codex-canary.txt` with
  exact content `AGENT_RUNNER_CODEX_CANARY=PASS`. Any other diff, changed
  HEAD, auth/quota ambiguity, selector disagreement or parser failure stops the
  run. Workspace-write network access is explicitly forced off, GitHub/GitLab/
  SSH mutation credential environment variables are removed, and interactive
  Git credential prompting is disabled. Unexpected workspaces are preserved
  for forensic inspection.
- A mode-0600 local one-shot state record is written before provider launch so
  the same manager authority cannot be used for a second canary invocation.
- Provider output, the fixed prompt, credentials and raw account responses are
  never written into ordinary evidence.

The qualification target is an explicit manager-authorised model/profile, not
the CLI default. The initial #186 target is `gpt-5.6-terra` with low reasoning
and workspace-write sandboxing. One successful canary qualifies only that
bounded capability; it does not enable automatic routing, fallback, Z790
scheduler authority, deployment, merge or issue-close authority.


### File-change apply status is authoritative

The first #186 supervised field canary exposed an important Codex JSONL detail:
an `item.completed` / `file_change` item is emitted after patch application
**succeeds or fails** and carries its own `status`.

Agent Runner must therefore never infer repository mutation from the mere
presence of a `file_change` item.

For a terminal `turn.completed`:

- `file_change.status=completed` with at least one structured `changes`
  entry is positive parser-level mutation evidence;
- `file_change.status=failed` is a bounded task-attempt failure
  (`codex-file-change-failed`);
- missing/unknown status or a completed item with no structured changes is
  ambiguous evidence and fails closed
  (`codex-file-change-evidence-ambiguous`);
- authoritative filesystem/worktree validation remains mandatory after parser
  success and can still override parser-level mutation evidence.

The failed first canary produced a parser-level file-change event while the
preserved worktree remained completely clean. This correction prevents a failed
patch event from being misclassified as a successful mutation.
