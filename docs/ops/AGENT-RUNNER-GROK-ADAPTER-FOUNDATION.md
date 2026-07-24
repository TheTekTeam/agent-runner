# Grok CLI adapter foundation (issue #49)

Status: **foundation only — disabled and non-routable by default.** Nothing
in this document authorises live Grok execution, queue routing, label
activation, concurrency, or timer enablement. See `#41` for the MVP
sequencing this slice belongs to; a capped supervised Grok CLI canary and
full repository validation are explicitly deferred to that later gate.

## Binding identity and cost policy

- Only `agent:grok-cli` identifies this adapter
  (`AGENT_ADAPTERS['grok-cli']`, `command: null`, `implemented: false`).
- Every committed/default/example setting is disabled
  (`enabled: false, disabled: true`).
- A real invocation additionally requires all three parts of the paid-use
  gate below — disabled-by-default and the paid-use gate are independent
  layers, not one substituting for the other.
- Grok must not implement or validate itself through a model call: no part
  of this foundation runs a Grok prompt, `--verify` flow, `models` listing,
  login, or any other authenticated/network-backed command. Every admission
  probe is limited to a local filesystem check or the installed binary's own
  `--version`/`--help` banner.

## What this adds

- **`scripts/ops/agent-runner-agents.mjs`** (edited) — a new `grok-cli`
  catalogue entry: `command: null`, `implemented: false`,
  `labels: ['agent:grok-cli']`. No other adapter's labels changed.
- **`scripts/ops/agent-runner-agent-settings.mjs`** (edited) — adds a
  `grok-cli` entry (including a bounded `timeout`, `1_000`..`3_600_000` ms)
  to the shared `AGENT_SETTINGS_EXAMPLE` payload (mirrored byte-for-byte in
  `.agent-runner/agent-settings.example.json`, proven by the existing parity
  test). The generic fail-closed lifecycle loader itself is unchanged.
- **`scripts/ops/agent-runner-grok-command.mjs`** (new) — bounded,
  Grok-native argv construction: explicit working directory, model only when
  configured, structured `--format json` output, a fixed always-on
  `--sandbox`, and a bounded `--max-tool-rounds`. No shell-string
  construction; this function only returns an array. No `timeout` argument —
  the CLI has no such flag (see below).
- **`scripts/ops/agent-runner-grok-parser.mjs`** (new) — a bounded parser
  for a single-JSON-object `grok -p ... --format json` stdout capture,
  classifying success, no-op, task failure, authentication failure, and
  quota/rate-limit failure, plus a process-level
  `classifyGrokExecutionError()` for timeout/cancellation/generic execution
  errors that never produced parseable output — `structuredFailure` is
  always one of three fixed tokens, never a caller-supplied `signal`/`code`.
- **`scripts/ops/agent-runner-grok-adapter.mjs`** (new) — orchestration: the
  shared enabled/paused/draining/disabled settings gate, a pre-I/O
  execution-options admission gate (`admitGrokExecutionOptions`, validating
  `timeout`/`maxToolRounds`/`model`), three deterministic no-cost probes
  (`executable`, `version`, `help-surface`), and the three-part paid-use
  admission gate (`admitGrokPaidUse`).
- Focused test files for all three new modules, plus label-resolution
  assertions added to `agent-runner-agents.test.mjs`, an example-payload
  routability assertion (including the bounded `timeout`) added to
  `agent-runner-agent-settings.test.mjs`, a `not-yet-qualified` cost-class
  assertion added to `agent-runner-control-readiness.test.mjs`, and
  catalogue/sink-safety assertions added to
  `agent-runner-control-instances.test.mjs`.

## Captured qualification evidence (local, no-cost, non-authenticated)

Run at implementation time against the installed binary — no network call,
no login, no model invocation:

```
$ /home/gp/.grok/bin/grok --version
1.1.7

$ /home/gp/.grok/bin/grok --help
Usage: grok [options] [command] [message...]

AI coding agent powered by Grok — built with Bun and OpenTUI

Options:
  -k, --api-key <key>            Grok API key
  -u, --base-url <url>           API base URL
  -m, --model <model>            Model to use
  -d, --directory <dir>          Working directory
  -p, --prompt <prompt>          Run a single prompt headlessly
  --verify                       Run the built-in verify flow headlessly
  --format <format>              Headless output format: text or json
  --sandbox                      Run agent shell commands inside a Shuru sandbox
  --no-sandbox                   Run agent shell commands directly on the host
  --allow-net                    Enable network access inside the Shuru sandbox
  --allow-host <pattern>         Restrict sandbox network to specific hosts
  --port <mapping>                Forward a host port to sandbox guest
  -s, --session <id>             Continue a saved session by id, or use 'latest'
  --background-task-file <path>  Run a persisted background delegation
  --max-tool-rounds <n>          Max tool execution rounds (default: "400")
  --batch-api                    Use xAI Batch API for model calls
  --update                       Update grok to the latest version and exit
  -h, --help                     display help for command

Commands:
  telegram-bridge [options]      Start the Telegram remote-control bridge
  models                         List available Grok models
  update                         Update Grok to the latest release
  uninstall [options]            Remove a script-installed Grok binary
  wallet                         Manage the local x402 wallet and payment settings
  daemon [options]               Start the schedule daemon to run scheduled tasks
```

`~/.grok/install.json` (also local, no-cost — install-script metadata, not a
network probe) corroborates the same version and origin: installed from
`superagent-ai/grok-cli` release `1.1.7`, asset `grok-linux-x64`, via
`installMethod: "script"`.

Neither `--version` nor `--help` is documented to make a network call or
require authentication, and neither was observed to. No other command
(`models`, `--verify`, `telegram-bridge`, `wallet`, `daemon`, `update`) was
run — `models` and `--verify` are understood to require a live, authenticated
API call, and the others are remote-control/self-update/payment/scheduling
surfaces explicitly out of scope for this foundation.

## Why this flag subset, and what was deliberately excluded

`grok --help` is the ground truth for this module's flag surface. This
adapter narrows it to six flags:

| Flag | Use |
| --- | --- |
| `-d, --directory <dir>` | explicit isolated working directory (always required) |
| `-m, --model <model>` | explicit model, only when configured |
| `--format json` | structured output (always on) |
| `--sandbox` | the CLI's own shell-command confinement (always on; there is no code path to `--no-sandbox`) |
| `--max-tool-rounds <n>` | bounded, always required, capped at the CLI's own documented default of 400 |
| `-p, --prompt <prompt>` | the task prompt, run headlessly |

Excluded, with no parameter and therefore no code path in
`buildGrokCommandArgs()`:

- `-k/--api-key`, `-u/--base-url` — credential/endpoint material; provider
  credentials stay entirely outside this foundation (see below).
- `-s/--session` — session material; same reasoning.
- `--allow-net`, `--allow-host`, `--port` — sandbox network-escape flags;
  this adapter's fixed `--sandbox` default must not be quietly loosened.
- `--background-task-file` — persisted background delegation (a form of
  sub-agent/background expansion).
- `--batch-api` — the xAI Batch API.
- `--verify` — the CLI's own built-in model-backed self-verification flow;
  running it would violate the hard boundary that Grok must not validate
  itself through a model call.
- `--update` — self-updates the installed binary; unrelated to task
  dispatch and mutates machine-local state this foundation must not touch.
- The `telegram-bridge`, `models`, `update`, `uninstall`, `wallet`, `daemon`
  subcommands — remote control, a (likely network-backed) model listing,
  self-update, local payment-wallet management, and scheduled-task
  automation, respectively. None has any executable path anywhere in this
  foundation.

## Machine-local agent lifecycle settings

```json
{
  "agents": {
    "grok-cli": {
      "enabled": false,
      "paused": false,
      "draining": false,
      "disabled": true,
      "executablePath": null,
      "model": null,
      "timeout": 300000,
      "maxToolRounds": 50,
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
exactly as issues #40 and #48 established.

`timeout` is a **caller-enforced process deadline for a future live
executor, not a CLI argument** — `grok --help` (captured above) has no
`--timeout`/`-t` flag of any kind, so nothing in `buildGrokCommandArgs()`
ever emits one. This foundation establishes and validates the *bound* a
future executor must honour, using the repository's existing generic
timeout contract exactly:
`agent-runner-control-instances.mjs`'s `validateTimeoutValue()` already
requires an **integer number of milliseconds from `1_000` through
`3_600_000`** for every other adapter's `timeout` field (reachable through
the control API's shared `ALLOWED_UPDATE_FIELDS.timeout`); `GROK_TIMEOUT_MIN_MS`/
`GROK_TIMEOUT_MAX_MS` in `agent-runner-grok-adapter.mjs` mirror that same
range so the two can never disagree. The committed example value,
`300000` (5 minutes), is a **conservative, disabled-by-default choice**: it
comfortably covers a bounded `maxToolRounds: 50` run without approaching
the CLI's own unrelated `--max-tool-rounds` default of `400`, and — like
`maxToolRounds` — is not itself load-bearing for safety, since the adapter
stays disabled regardless of this value.

`maxToolRounds` defaults to `50` in the example payload — a conservative,
bounded choice well under the installed CLI's own documented
`--max-tool-rounds` default of `400` (`GROK_MAX_TOOL_ROUNDS_CEILING` in
`agent-runner-grok-command.mjs`).

`sessionSecretRef` is reserved for a future opaque `secretref:<id>` (issue
#45) pointing at a Grok CLI credential; this foundation never reads or
resolves it.

## The pre-I/O execution-options admission gate

`admitGrokExecutionOptions({ entry })` is a **pure, synchronous function —
no `accessFn`, no `execFileFn`, no network, no command construction** — that
validates the settings `entry` already in memory before any process-touching
probe runs. It requires **all** of:

1. **A bounded `timeout`** — an integer from `GROK_TIMEOUT_MIN_MS` (`1_000`)
   through `GROK_TIMEOUT_MAX_MS` (`3_600_000`), inclusive. Missing/`null`/
   non-integer/out-of-range all fail closed with the same fixed reason
   (`grok-timeout-out-of-range`) — an unset timeout is not treated as "no
   limit."
2. **A bounded `maxToolRounds`** — an integer from `1` through
   `GROK_MAX_TOOL_ROUNDS_CEILING` (`400`), inclusive
   (`grok-max-tool-rounds-invalid` otherwise).
3. **A safe `model`** — absent/`null`/whitespace-only is valid (mirrors
   `buildGrokCommandArgs()`'s own "omit unless configured" handling); a
   configured value must match `GROK_MODEL_PATTERN`
   (`^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$`) — the exact same positive
   allowlist shape, and the same `128`-character bound, as
   `agent-runner-control-instances.mjs`'s own `MODEL_PATTERN` — otherwise
   `grok-model-invalid`. A positive allowlist rather than a denylist: no
   match can ever start with `-` (option injection), contain whitespace or a
   control character, or exceed the length bound, without those needing to
   be enumerated individually.

Any one missing/invalid part fails the whole gate closed with a fixed,
machine-readable reason, and — because this probe touches nothing but the
in-memory `entry` — calling it (or reaching it through `admitGrokDispatch()`)
invokes neither `accessFn` nor `execFileFn` and constructs no command:
`admitGrokDispatch()` never calls `buildGrokCommandArgs()` at all, so there
is no code path through which an invalid configuration could reach command
construction.

## Admission probes (all non-model, all injectable for tests)

`admitGrokDispatch()` runs, in strict sequence:

1. The shared settings lifecycle gate (calling no injected I/O function at
   all when not routable — itself the zero-model-call/zero-mutation proof
   for the disabled path).
2. **The execution-options gate above** (`admitGrokExecutionOptions()`) —
   runs immediately after the lifecycle gate and strictly before any of the
   three probes below. An invalid `timeout`/`maxToolRounds`/`model` fails
   closed here, before `executable`/`version`/`help-surface` ever run and
   before `accessFn`/`execFileFn` are called even once.
3. **executable** — `accessSync(path, X_OK)` against the explicit
   `executablePath`. No `PATH` search, no default binary name.
4. **version** — the configured executable's `--version` banner, checked
   against the fixed `GROK_SUPPORTED_VERSIONS` allowlist (currently just
   `['1.1.7']`, the version this foundation's contract was captured
   against). A version outside the allowlist fails closed as
   `grok-unsupported-version` rather than being accepted on the strength of
   merely being non-empty.
5. **help-surface** — the configured executable's `--help` banner, checked
   for every flag `buildGrokCommandArgs()` depends on
   (`-d, --directory`, `-m, --model`, `--format`, `--sandbox`,
   `--max-tool-rounds`, `-p, --prompt`). A future CLI upgrade that removes
   or renames any of these fails closed as `grok-help-drift` instead of
   silently constructing an argv the installed binary no longer understands.
6. The three-part paid-use gate below (`admitGrokPaidUse()`).

A failing probe short-circuits later ones (proven in
`agent-runner-grok-adapter.test.mjs`) — on a full success, `probes` carries
all `3 + 3 + 3 = 9` sub-probe outcomes (execution-options, then
executable/version/help-surface, then the paid-use gate's own three).

## The three-part paid-use admission gate

`admitGrokPaidUse({ entry, labels })` requires **all** of:

1. **Machine-local approval** — `entry.paidUseApproved === true`.
2. **A positive per-run ceiling** — `entry.maxCostUsdPerRun > 0` **or**
   `entry.maxTokensPerRun > 0` (either alone is sufficient; `0`/absent
   values on both fail closed).
3. **Explicit CLI labelling** — the dispatching issue/run's labels include
   `agent:grok-cli`.

Any one missing part fails the whole gate closed, and the failing probe
name (`paid-use-approval` / `per-run-ceiling` / `cli-label`) is always
reported, never silently combined. This is a foundation-level policy check
only — it makes no network, filesystem-write, or process call.

## Isolated worktrees and no shared-checkout mutation

`buildGrokCommandArgs()` requires an explicit `cwd` — there is no default to
`process.cwd()` or any notion of "the current repository." The test suite
proves this concretely: it creates a real temporary git repository with a
real `git worktree add`, runs admission and command construction against
the worktree path with injected fakes, and asserts the *original*
repository's `git status --porcelain` and `HEAD` are byte-for-byte unchanged
afterward.

## Credentials and session material

- `buildGrokCommandArgs()` has no parameter for a secret, token, session id,
  API key, or credential of any kind — proven by a test asserting the
  function's own source contains none of those words.
- A `sessionSecretRef` configured in settings never appears in any argv,
  probe outcome, admission-decision payload, or control-service snapshot —
  proven by tests that serialize the full decision/snapshot object and
  assert the configured `secretref:...` value is absent.
- Nothing in this foundation logs, persists, or forwards `entry` verbatim;
  admission functions return only booleans, machine-readable reasons, and
  probe names.
- `probeExecutable()` returns no `detail` at all on success (not the
  configured executable path) and a fixed `grok-executable-unavailable`
  reason on failure — never the raw `accessFn` error message, which for a
  real filesystem error routinely embeds the path itself. `probeVersion()`'s
  and `probeHelpSurface()`'s failure paths match: a fixed reason, never the
  raw `execFileFn` error message or raw banner text.
- `admitGrokExecutionOptions()` never returns the raw `entry` it validated —
  not even the configured `model`, `timeout`, or `maxToolRounds` value —
  only booleans, fixed reasons (`grok-timeout-out-of-range`,
  `grok-max-tool-rounds-invalid`, `grok-model-invalid`), and probe names.
- `parseGrokResultEnvelope()` reads raw stdout and terminal error messages
  only to pick a bounded, machine-readable `reason`; none of that raw text
  is ever placed into the returned `resultText` (always `''` on a
  non-success/malformed path) or `structuredFailure` (always `null` or one
  of the fixed tokens `'grok-invalid-output'`/`'grok-run-failed'`). Only a
  `status: 'success'` payload's own `message` field — the assumed model
  output field, exercised only by mocked test fixtures in this issue —
  populates `resultText`.
- `classifyGrokExecutionError()` **discards `message`, `signal`, and `code`
  entirely** — branch selection is driven only by the boolean
  `cancelled`/`timedOut` flags, and `structuredFailure` is always exactly
  one of three fixed, finite tokens: `'grok-cancelled'`, `'grok-timeout'`,
  or `'grok-execution-error'` (matching `reason`). An earlier revision of
  this function forwarded `signal || code` into `structuredFailure`
  verbatim, which a caller could have used to smuggle a credential, session
  handle, path, or prompt into a normalized result through either field —
  this was corrected per PR #63 manager review before merge; no such code
  path exists in this module.
- All of the above is proven adversarially:
  `agent-runner-grok-parser.test.mjs` and `agent-runner-grok-adapter.test.mjs`
  seed malformed stdout, terminal error messages, and executable/version/
  help-surface probe errors with synthetic credentials, session handles,
  prompts, and local paths, then serialize the full returned result/decision
  and assert every synthetic value is absent.
  `agent-runner-grok-parser.test.mjs` additionally places every synthetic
  secret into **all three** of `classifyGrokExecutionError()`'s `message`,
  `signal`, and `code` simultaneously, across all three branches
  (cancelled/timeout/generic), and asserts both that no synthetic value
  survives and that `structuredFailure` is exactly the fixed token.
  `agent-runner-grok-adapter.test.mjs` proves the execution-options gate
  itself: invalid `timeout`/`maxToolRounds`/`model` (including a
  secret-bearing invalid `model`) each short-circuit `admitGrokDispatch()`
  before `executable`/`version`/`help-surface` run, calling neither
  `accessFn` nor `execFileFn`.

## Allowed and forbidden task classes

No qualification evidence exists yet for what Grok CLI is actually good at —
this foundation adds no live routing, so there is no task class it can
currently be dispatched against. For the future live-enablement gate in
`#41`:

- **Allowed (once qualified and enabled):** bounded, sandboxed, single-turn
  coding/editing tasks against an explicit isolated working directory,
  identical in shape to what the Codex CLI foundation (#48) targets.
- **Forbidden, permanently, regardless of future qualification:** any task
  requiring `--verify` (self-validation via a model call), `--batch-api`,
  `telegram-bridge` (remote control), `models`/web/X research, `wallet`
  (payments), `daemon` (scheduling/the execution timer), or
  `--background-task-file` (sub-agent/background delegation) — none of
  these has, or will gain through this foundation, any executable path.

## Known limitations

- The `grok -p ... --format json` payload shape
  (`{ status, message, mutated, error, usage }`) is a **documented-but-not-
  yet-live-verified assumption**, exactly like the #40 Ollama/OpenCode
  foundation's assumed `{status, output, error, mutated}` contract and the
  #48 Codex foundation's assumed JSONL event stream. `grok --help` documents
  the existence of `--format json` but not its payload schema, and no live,
  authenticated headless run has been performed to capture one — doing so
  is out of scope for this foundation (see the hard boundary against
  running any Grok prompt or model call). This has not been checked against
  a live captured Grok payload; deferred to the live-enablement/canary gate
  in `#41`.
- `--sandbox` is treated as the one "safe verification control" this
  foundation trusts, on the basis that it is the only help-documented flag
  that constrains rather than expands what a dispatched run can do (unlike
  `--allow-net`/`--allow-host`/`--port`, which loosen the sandbox, or
  `--verify`, which triggers a model-backed self-check). This interpretation
  has not been confirmed against Grok CLI's own documentation beyond the
  `--help` banner captured above.
- `GROK_SUPPORTED_VERSIONS` currently allows only the single version this
  contract was captured against (`1.1.7`). Any CLI upgrade requires this
  foundation to be re-verified and the allowlist updated — by design, not an
  oversight.
- `admitGrokExecutionOptions()` establishes and validates the bound a
  `timeout` must fall within; it does not itself start, watch, or kill any
  process, since this foundation adds no live executor. Enforcing that bound
  against a real `grok` invocation (a process-level deadline/kill) is
  deferred to the live-enablement gate in `#41`, alongside the rest of live
  dispatch.
- No scheduler, dashboard, or cron wiring reads any of these new modules
  yet. Live routing, `agent:grok-cli` label activation, and timer changes
  are explicitly out of scope for this issue.

## Validation

```bash
node --check scripts/ops/agent-runner-agents.mjs \
  scripts/ops/agent-runner-agent-settings.mjs \
  scripts/ops/agent-runner-grok-command.mjs \
  scripts/ops/agent-runner-grok-parser.mjs \
  scripts/ops/agent-runner-grok-adapter.mjs

node --test scripts/ops/agent-runner-grok-command.test.mjs \
  scripts/ops/agent-runner-grok-parser.test.mjs \
  scripts/ops/agent-runner-grok-adapter.test.mjs \
  scripts/ops/agent-runner-agents.test.mjs \
  scripts/ops/agent-runner-agent-settings.test.mjs \
  scripts/ops/agent-runner-control-readiness.test.mjs \
  scripts/ops/agent-runner-control-instances.test.mjs

npm test
npm run validate
git diff --check
```
