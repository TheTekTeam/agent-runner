# Agent Runner fleet readiness evidence

Issue: #328 `AGENT.FLEET.PROVISIONING.1`

Agent Runner treats runtime installation, machine-local authentication and qualification as separate facts for every exact `agent@node` instance. A successful canary on one node never qualifies another node, and installing an adapter never grants scheduler or controller authority.

## Readiness probe

Run the repository probe on the machine being inspected:

```text
npm run fleet:readiness -- --node <node-id> [--worker-only]
```

Use `--worker-only` on Z790 and every non-controller worker. The command is intentionally read-only. It executes only the version-probe command already accepted by the canonical live adapter catalogue, with a minimal environment containing `PATH`. It does not inspect or serialize credential files, auth tokens, sessions, home-directory paths or environment dumps.

The output distinguishes:

- source-supported adapter runtime present/missing;
- installed version where the reviewed version probe returns one;
- authentication as `unknown` unless separately proven by the adapter's accepted machine-local authentication workflow;
- qualification as false unless separately supplied by the owning canary/qualification process;
- unsupported/foundation-only adapters without guessing their executable or installation mechanism.

The projection can be converted to #327 `agent@node` records, but the readiness command itself performs no worker-registry mutation and grants no route authority.

## Provisioning boundary

The repository must not invent installation package sources from issue prose. `fleetAdapterRuntimeContract()` exposes an installation/version mechanism only after that adapter's canonical implementation foundation and current upstream package source have been reviewed.

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

### Foundation-only adapters

Codex, Grok and Ollama/OpenCode remain explicit `adapter-foundation-not-live` in the current fleet installation contract. The installer refuses them rather than guessing a package/executable/source from issue prose or from what may happen to be installed manually on a machine. This is deliberate fail-closed behaviour, not evidence that those runtimes are absent from a node.

## Authentication and qualification

Authentication is established independently per machine through the provider/runtime's accepted local flow. Never copy Claude/Codex/Grok session or credential material between Dell and Z790. Ollama model inventory is node-local and no readiness/provisioning command may auto-download a model.

Only the owning canary/qualification issue may advance an instance from runtime-present/authenticated to qualified. #327 routing consumes only positively qualified `agent@node` instances.

## Topology

Dell remains the sole Agent Runner scheduler/controller. `--worker-only` evidence is appropriate for Z790 and future workers, but it is not a proof of machine service state by itself; field acceptance must separately verify that no scheduler/timer/manager/source-activation service is installed or enabled on a worker node.

A worker outage removes capacity only. It must not alter queue ownership, manager authority, claims, source activation, merge authority or another node's credentials.
