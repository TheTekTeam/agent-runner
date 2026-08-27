# Agent Runner fleet readiness evidence

Issue: #328 `AGENT.FLEET.PROVISIONING.1`

Agent Runner treats runtime installation, machine-local authentication and qualification as separate facts for every exact `agent@node` instance. A successful canary on one node never qualifies another node, and installing an adapter never grants scheduler or controller authority.

## Readiness probe

Run the repository probe on the machine being inspected:

```text
npm run fleet:readiness -- --node <node-id> [--worker-only]
```

Use `--worker-only` on Z790 and every non-controller worker. The command is intentionally read-only. It executes only version-probe commands explicitly accepted by the fleet runtime contract, with a minimal environment containing `PATH`; the Ollama component additionally receives the current `HOME` because Ollama 0.32.x panics before version handling when `HOME` is absent. No other parent environment keys are inherited for that probe. The command does not inspect or serialize credential files, auth tokens, sessions, home-directory paths or environment dumps.

The output distinguishes:

- source-supported adapter runtime present/missing;
- installed version where the reviewed version probe returns one;
- authentication as `unknown` for credential-backed adapters unless separately proven; local Ollama has no provider-auth requirement but still remains unqualified/non-routable until #152;
- qualification as false unless separately supplied by the owning canary/qualification process and permitted by the live adapter gate;
- unsupported/foundation-only adapters without guessing their executable or installation mechanism;
- for Ollama/OpenCode, separate Ollama-runtime and OpenCode-harness presence while leaving model inventory explicitly unprobed.

The projection can be converted to #327 `agent@node` records, but the readiness command itself performs no worker-registry mutation and grants no route authority.

## Provisioning boundary

The repository must not invent installation package sources from issue prose. `fleetAdapterRuntimeContract()` exposes an installation/version mechanism only after that runtime foundation and current upstream package source have been reviewed. Runtime provisioning is deliberately separate from live Agent Runner dispatch: installing a CLI does not make its execution adapter qualification-eligible or routable.

### Claude Code

For Ubuntu/Debian fleet nodes, the reviewed Claude Code runtime installation contract uses Anthropic's signed **stable** apt repository:

- package: `claude-code`;
- repository: `https://downloads.claude.ai/claude-code/apt/stable`;
- suite/component: `stable main`;
- signing key: `https://downloads.claude.ai/keys/claude-code.asc`;
- required signing-key fingerprint: `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`;
- installer: `scripts/install-agent-runner-fleet-runtime.sh`.

The installer is deliberately bounded. It verifies host/platform and signing-key identity, installs only the reviewed runtime package, and verifies `claude --version`. It does **not** perform provider login, inspect/copy credentials or sessions, qualify the resulting `agent@node`, mutate the worker registry, enable routing, install/enable a scheduler/controller, register a GitHub Actions runner, or download a model.

Example dry run on a worker node:

```text
bash scripts/install-agent-runner-fleet-runtime.sh \
  --adapter claude-code-cli \
  --node dev-cluster-z790 \
  --worker-only \
  --dry-run
```

After an authorised installation, rerun the readiness probe. `runtime-installed` remains distinct from `authenticated` and `qualified`.

### Codex CLI

OpenAI's current Codex CLI documentation publishes the official npm package `@openai/codex` and the command `npm install -g @openai/codex`. For the current Ubuntu/Debian Agent Runner fleet, the reviewed runtime contract therefore uses:

- executable/version probe: `codex --version`;
- npm package: `@openai/codex`;
- reviewed package spec: `@openai/codex@latest`;
- registry: `https://registry.npmjs.org/`;
- reviewed machine-wide npm prefix: `/usr/local`;
- installer: `scripts/install-agent-runner-fleet-runtime.sh`.

Example dry run:

```text
bash scripts/install-agent-runner-fleet-runtime.sh \
  --adapter codex-cli \
  --node dev-cluster-z790 \
  --worker-only \
  --dry-run
```

This step installs/version-probes the runtime only. An explicit Codex provisioning run reconciles the reviewed `@openai/codex@latest` package into the reviewed machine-wide prefix `/usr/local` even when a `codex` executable is already present; binary presence alone is not treated as proof of runtime currency. The prefix is explicit rather than inferred from root npm configuration, because root npm defaults can differ across hosts. After reconciliation, the installer requires the active `codex` command to resolve inside `/usr/local/lib/node_modules/@openai/codex` and requires `codex --version` to match that package version. This prevents a stale `/usr/local` command, a `/usr` root-global install, or a second user npm-global prefix from silently defeating an authorised runtime refresh. It does not run `codex login`, inspect or copy `~/.codex` state, read `OPENAI_API_KEY`/`CODEX_API_KEY`, infer ChatGPT authentication, inspect account balance, infer quota, perform a model call, qualify the instance or activate routing.

The canonical `codex-cli` Agent Runner execution adapter remains default-disabled/non-routable until the owning #186 canary proves the intended ChatGPT-account authentication path, current quota/headroom admission and bounded task/profile qualification. Fleet evidence cannot bypass that gate: even fabricated `authAvailable:true` / `qualified:true` evidence remains non-routable while the live adapter is not qualification-eligible.

### Ollama / OpenCode

The fleet contract now consumes the accepted #40 `ollama-agent` foundation without enabling live routing.

Readiness is deliberately component-aware:

- Ollama runtime probe: `ollama -v`, executed with only `PATH` plus the reviewed `HOME` process-context key; Dell #364 field evidence proved PATH-only exits with `panic: $HOME is not defined`, while PATH + HOME returns the installed version; `HOME` is required for Ollama CLI initialisation but is never serialized into readiness evidence;
- because Ollama's version command can consult the daemon, a non-zero exit still proves **binary/runtime presence** only when that exact reviewed command emits a bounded version after the reviewed phrases `client version is` or `ollama version is`; client version is preferred when both are present, the extracted Ollama version must contain a dotted numeric version (`x.y…`), and unrelated numeric warning text is never treated as a version; this Ollama-specific parser does not alter Claude/Codex/OpenCode parsing and does not prove daemon, model or route readiness;
- OpenCode harness probe: `opencode --version`;
- both must be present before the fleet runtime is considered installed;
- model inventory is reported as `not-probed` by the fleet readiness command;
- no readiness probe calls `/api/tags`, a generation endpoint, or any model-management command;
- runtime presence cannot make `ollama-agent` qualification-eligible while the canonical live adapter remains disabled pending #152.

For compatible Ubuntu/Debian nodes, the reviewed installer uses the current official upstream mechanisms:

- Ollama: official Linux `amd64` / `arm64` tarball from `https://ollama.com/download`, extracted to `/usr` without creating, starting or enabling a service;
- OpenCode: official npm package `opencode-ai@latest` from `https://registry.npmjs.org/`.

Example dry run:

```text
bash scripts/install-agent-runner-fleet-runtime.sh \
  --adapter ollama-agent \
  --node dev-cluster-z790 \
  --worker-only \
  --dry-run
```

The installer never runs `ollama pull`, `ollama run`, OpenCode task execution, provider authentication, model discovery/download, route activation, or qualification. Model inventory remains node-specific and is separately owned by #152.

### Foundation-only adapters

Grok remains explicit `adapter-foundation-not-live` / owner-deferred in the current fleet installation contract. The installer refuses Grok rather than guessing a package/executable/source. Grok remains a supported future fleet adapter but is not required for the urgent Ollama addition.

## Qualification-only worker leases

Normal #327 worker routing remains strict: an `agent@node` instance must already be positively qualified before `selectWorkerRoute()` can choose it. That invariant is unchanged.

For per-node qualification itself, #389 adds a separate controller-only seam:

- Dell selects one exact worker-only node and adapter through `selectWorkerQualificationRoute()`;
- the target must be enabled, ready, have free capacity, and expose an enabled/ready/authenticated machine-local adapter instance;
- the instance may still have `qualified:false`;
- the route is tagged `qualificationOnly:true` and does not alter registry qualification state;
- Dell issues an immutable `issueWorkerQualificationLease()` bound to exact controller, worker node, agent instance, repository, base SHA, branch/worktree identity, model, profile, lane, qualification profile, capability fingerprints and expiry;
- `validateWorkerLease()` permits the missing qualification bit only for such a qualification-only lease and only on a non-controller `workerOnly:true` node;
- ordinary leases keep their historical fingerprint shape and continue to require `qualified:true`;
- creating or validating a qualification lease grants no queue selection, scheduler, manager, GitHub mutation, source activation, merge/close/deploy or general routing authority.

This seam exists only to avoid the circular requirement that an instance must already be qualified in order to receive the one bounded job that qualifies it. The later worker canary still has to provide its own exact task, auth/quota, sandbox, validation and evidence controls before any model invocation.

## Accepted qualification publication (#401)

`agent-runner-fleet-qualification-publication.mjs` publishes only independently
accepted `agent@node` qualification evidence into a deterministic fleet
qualification registry projection for the #327/#328 readiness contract. It never
enables normal multi-node routing.

- `publishFleetQualification({ acceptedResults })` consumes the bounded accepted
  results returned by the Claude/Codex worker qualification acceptors and emits
  one entry per target instance (`claude-code-cli` and `codex-cli` on
  `dev-cluster-dell` and `dev-cluster-z790`).
- Reconciliation fails closed: an instance is published only when a supplied
  accepted result matches the pinned per-instance revision
  (`claude-z790-7e13ce3be223baf8`, `codex-z790-58e9d9edf45669ac`). Stale,
  mismatched, cross-node or absent evidence becomes an explicit `evidence-gap`.
- Dell Claude and Dell Codex have no repository- or GitHub-owned exact
  per-instance qualification revision available here, so they are published as
  bounded evidence gaps rather than an invented revision.
- Every published entry is emitted `lifecycle: disabled`, `routable: false`,
  `routingEligible: false`; `assertPublishedQualificationNonRoutable()` enforces
  this. Qualification state is recorded independently from routability, so a
  qualified instance stays non-routable until separate #402 field
  lifecycle/activation acceptance.
- `assertNoSecretFields()` rejects credential, prompt, session-id, raw provider
  output, unrestricted environment and account credit/balance fields; usage and
  quota percentages are never carried into the projection.
- Publication grants Z790 no scheduler, queue-selection, manager,
  source-activation or GitHub-management authority and enables no paid/API
  fallback.

## Authentication and qualification

Authentication is established independently per machine through the provider/runtime's accepted local flow. Never copy Claude/Codex/Grok session or credential material between Dell and Z790. Ollama is a local zero-provider-cost runtime and requires no provider credential for the fleet presence check; its model inventory remains node-local and no readiness/provisioning command may auto-download a model.

Only the owning canary/qualification issue may advance an instance from runtime-present/authenticated to qualified, and only after the canonical adapter itself permits qualification. #327 routing consumes only positively qualified `agent@node` instances.

## Topology

Dell remains the sole Agent Runner scheduler/controller. `--worker-only` evidence is appropriate for Z790 and future workers, but it is not a proof of machine service state by itself; field acceptance must separately verify that no scheduler/timer/manager/source-activation service is installed or enabled on a worker node.

A worker outage removes capacity only. It must not alter queue ownership, manager authority, claims, source activation, merge authority or another node's credentials.
