# OpenCode/Ollama adapter foundation (issue #40)

Status: **foundation only — disabled and non-routable by default.** Nothing
in this document authorises live Ollama execution, queue routing, label
activation, concurrency, or timer enablement. See `TheTekTeam/agent-runner#5`
for the separate reliability/live-activation gate and `#41` for the MVP
sequencing this slice belongs to.

## What this adds

- `scripts/ops/agent-runner-agent-settings.mjs` — a generic, machine-local
  per-agent lifecycle settings loader: `enabled`, `paused`, `draining`,
  `disabled`. Every field fails closed: a missing settings file, a missing
  agent entry, malformed JSON, or a non-boolean field all resolve to the
  fully disabled default (`{ enabled: false, paused: false, draining: false,
  disabled: true }`). Copy `.agent-runner/agent-settings.example.json` to a
  machine-local path (default `~/.config/agent-runner/agent-settings.json`,
  override with `AGENT_RUNNER_AGENT_SETTINGS_PATH`) and keep the real file
  out of Git.
- `scripts/ops/agent-runner-adapter-contract.mjs` — a generic, adapter-agnostic
  normalized result contract (`normalizedAdapterResult`), a zero-cost usage
  envelope (`zeroSpendEnvelope`, always `costUsd: 0`, `paid: false`), and a
  probe/admission folding helper (`foldProbeOutcomes`) shared by any future
  local-runtime adapter, not just Ollama.
- `scripts/ops/agent-runner-ollama-adapter.mjs` — the OpenCode/Ollama-specific
  foundation: explicit executable resolution, localhost-or-allowlisted
  endpoint resolution, five deterministic non-model admission probes,
  bounded OpenCode command construction, and structured-result/error
  classification.

The existing `ollama-agent` entry in `scripts/ops/agent-runner-agents.mjs`
(`agentId: 'ollama-agent'`, label `agent:ollama`) is unchanged:
`implemented: false`. That flag is what the live scheduler
(`claude-runner-cron.mjs`) checks before routing an issue, so this slice is
non-routable purely by not touching that registry — no scheduler code was
modified. `agent:ollama` also remains outside
`DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG.acceptedAgentLabels` in
`agent-runner-config.mjs`, which was likewise not modified.

## Machine-local agent lifecycle settings

```json
{
  "agents": {
    "ollama-agent": {
      "enabled": false,
      "paused": false,
      "draining": false,
      "disabled": true,
      "executablePath": null,
      "endpoint": "http://127.0.0.1:11434",
      "endpointAllowlistHosts": [],
      "installedModelAllowlist": [],
      "minFreeMemoryBytes": 2147483648
    }
  }
}
```

`isAgentRoutable()`/`getAgentSettings().routable` requires **all** of
`enabled: true`, `disabled: false`, `paused: false`, `draining: false`.
Setting `enabled: true` alone is intentionally insufficient — `disabled`
defaults to `true` unless explicitly set to `false` — so enabling an agent
is always two deliberate, explicit edits, never one.

## Admission probes (all non-model, all injectable for tests)

`admitOllamaDispatch()` first checks the settings gate above (calling no
injected I/O function at all when not routable — that call itself is the
zero-model-call/zero-mutation proof for the disabled path), then runs, in
strict sequence (never in parallel):

1. **executable** — `accessSync(path, X_OK)` against the explicit
   `executablePath`. There is no `PATH` search and no default binary name.
2. **version** — runs the configured executable's `--version` banner only.
3. **endpoint** — a metadata-only `GET /api/tags` reachability check.
   Localhost (`127.0.0.1`, `localhost`, `::1`) is always permitted; any other
   host must appear byte-for-byte in `endpointAllowlistHosts`. There is no
   wildcard and no LAN auto-discovery.
4. **installed-model** — the requested model must be **both** in the
   explicit `installedModelAllowlist` **and** reported installed by the
   endpoint's own `/api/tags` listing. Neither condition alone is
   sufficient, and nothing here ever triggers a model pull/download.
5. **host-headroom** — a pure local `os.freemem()` check against
   `minFreeMemoryBytes`. This is deliberately a distinct `machine_profile`
   failure (`ollama-insufficient-host-headroom`), never conflated with a
   paid provider's token/budget quota exhaustion.

A failing probe short-circuits the remaining ones (proven in
`agent-runner-ollama-adapter.test.mjs`, e.g. an unavailable executable never
reaches the endpoint/model/headroom probes), and every failure carries
`failureScope: 'machine_profile'` plus a machine-readable `reason` —
`agent-runner-admission.mjs`'s existing `FAILURE_SCOPES` vocabulary is
reused, not reinvented.

## Command construction and result parsing

Issue #152 revalidated the installed Dell OpenCode `1.18.4` binary
non-generatively with `opencode run --help`. The supported headless run
surface used here is `--model`, `--format json`, and `--dir`;
`--interactive` defaults to false. The previously assumed
`--api-base`, `--non-interactive`, and `--print` flags are not present
in the installed CLI and are no longer emitted.

`buildOpenCodeLocalOllamaConfig()` builds runtime-only
`OPENCODE_CONFIG_CONTENT` JSON for a single local Ollama provider. The
provider endpoint is represented as
`provider.ollama.options.baseURL = <allowlisted-endpoint>/v1`, and
`enabled_providers: ["ollama"]` prevents an already-configured cloud
provider from becoming an implicit fallback. It also pins both the default
and small-model choices to the same local Ollama model, sets
`share: "disabled"`, and sets `autoupdate: false`. The generated config
contains no credential, auth, session, refresh, download, cloud-provider, or
fallback field.

`buildOpenCodeCommandArgs()` builds the bounded argv array
(`<executable> run --model ollama/<model> --format json --dir <worktree>
<prompt>`). It emits no interactive/share/attach/session/continue/fork,
concurrency, pull/download/refresh, or fallback-provider flag.

Supervised #152 field evidence has now verified that OpenCode 1.18.4
`run --format json` emits newline-delimited event objects. The accepted
successful shape contains `step_start`, one or more `text` events, and
`step_finish`; error events are emitted separately.
`parseOpenCodeJsonEventStream()` parses that JSONL contract fail-closed,
extracts only completed text payloads, never copies unbounded provider error
messages into normalized failure output, and reports repository mutation as
false because event parsing alone cannot prove a filesystem change.
`parseOpenCodeResultEnvelope()` auto-detects the verified JSONL stream while
retaining the historical single-envelope parser only for compatibility.
`classifyOpenCodeExecutionError()` separately classifies process-level
timeout vs. cancellation vs. a generic execution error for cases that never
produce parseable output.

### Text-only documentation contract

#152 also field-proved that the local provider/model/session path succeeds
with every OpenCode permission denied, while two otherwise-identical
documentation canaries failed deterministically when read/edit tool access
was introduced. Documentation qualification therefore does not rely on
model-specific file-tool support.

`buildOpenCodeTextOnlyLocalOllamaConfig()` extends the local-only provider
configuration with a global permission deny. A documentation model generates
one bounded full-document proposal as text only.
`parseBoundedDocumentationContent()` treats XML-like markers, a single outer
Markdown code fence, or raw document text as transport syntax rather than a
security boundary. It still rejects NUL and oversized output. When the caller
has a deterministic expected result (for example a qualification fixture), the
parser can require that exact content to occur exactly once and returns only
those accepted bytes, ignoring harmless surrounding prose/fences. The
supervising harness—not the model—owns the single allowlisted documentation
path and applies the validated content deterministically only after its normal
branch/worktree/source/settings gates have passed. This keeps filesystem
authority out of the local model while avoiding brittle dependence on model
wrapper formatting.

## Serial execution and no paid fallback

Every probe and the eventual command run one at a time; nothing here spawns
concurrent Ollama/OpenCode work, matching the runner's existing single
global execution slot. There is no automatic fallback to Claude, Codex, or
any other paid agent anywhere in this module — an admission failure returns
a typed `machine_profile` result and nothing else.

## Known limitations

- The OpenCode **run argument surface and JSONL event schema** are now
  verified against Dell OpenCode `1.18.4` by supervised #152 field
  evidence. The accepted no-tool diagnostic emitted exactly three parseable
  events (`step_start`, `text`, `step_finish`) with zero stderr and zero
  provider spend. Any future OpenCode version change must revalidate both the
  argv and JSONL contracts before qualification is carried forward.
- The documentation profile is intentionally text-only: OpenCode permissions
  remain denied and the deterministic harness applies only a bounded,
  validated full-document proposal to an independently allowlisted
  documentation path. Transport wrappers are not treated as authority or as a
  qualification requirement; deterministic expected-content gates may be used
  where exact bytes are known. Tool-enabled local documentation execution is
  not an accepted qualification path.
- The runtime Ollama provider config uses OpenCode's documented
  `OPENCODE_CONFIG_CONTENT` provider configuration with
  `enabled_providers: ["ollama"]`, local-only default/small-model choices,
  sharing disabled, and `autoupdate: false`. The supervised canary must
  additionally set OpenCode's explicit auto-update disable environment gate
  and still prove that the installed `@ai-sdk/openai-compatible` provider
  path is available locally without an unexpected package download or
  non-Ollama network dependency.
- `probeVersion()` reads the version banner but does not itself enforce a
  minimum-version policy; a future enablement issue can add that check once
  a real minimum is captured.
- `endpointAllowlistHosts`/`installedModelAllowlist` are plain string
  arrays; there is no CIDR-range or wildcard model matching by design (an
  explicit, boring allowlist is the safety property this slice needs).
- No scheduler, dashboard, or cron wiring reads any of these new modules
  yet. Live routing, `agent:ollama` label activation, and timer changes are
  explicitly out of scope for this issue.

## Validation

```bash
node --check scripts/ops/agent-runner-agent-settings.mjs \
  scripts/ops/agent-runner-adapter-contract.mjs \
  scripts/ops/agent-runner-ollama-adapter.mjs

node --test scripts/ops/agent-runner-agent-settings.test.mjs \
  scripts/ops/agent-runner-adapter-contract.test.mjs \
  scripts/ops/agent-runner-ollama-adapter.test.mjs

node --test scripts/ops/agent-runner-agents.test.mjs scripts/ops/agent-runner-config.test.mjs

npm test
npm run validate
git diff --check
```
