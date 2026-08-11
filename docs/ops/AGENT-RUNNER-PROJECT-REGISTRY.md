# Agent Runner project registry

Issue: `TheTekTeam/agent-runner#100`

The project registry is the first reusable multi-project boundary for Agent Runner. It lets one Dell installation describe multiple GitHub repositories without adding repository-specific branches to Agent Runner source code.

## Configuration layers

Agent Runner uses three conceptual layers:

1. **Runner defaults** — safe generic defaults owned by `TheTekTeam/agent-runner`.
2. **Project configuration** — one validated JSON config per repository.
3. **Dell-local registry and machine policy** — the enabled project set, checkout locations, state paths and machine controls stored outside source repositories.

Repository policy may make validation or risk handling stricter. It must never weaken Dell-local safety controls, enable an unqualified agent, expose credentials, permit arbitrary shell execution or bypass manager authority.

## Registry format

```json
{
  "schemaVersion": 1,
  "defaultProjectId": "modelspend",
  "projects": [
    {
      "configPath": "modelspend.json",
      "enabled": true
    },
    {
      "configPath": "agent-runner.json",
      "enabled": true
    }
  ]
}
```

A project entry may also be a string containing only the config path. Relative paths are resolved from the registry file directory.

The registry is selected with either:

```bash
--project-registry /path/to/projects.json
```

or:

```bash
AGENT_RUNNER_PROJECT_REGISTRY=/path/to/projects.json
```

## Validation rules

Every referenced project config is loaded through the existing `validateAgentRunnerConfig` contract. The registry fails closed when it finds:

- malformed registry JSON;
- an unsupported registry schema version;
- a missing or invalid project config;
- no enabled project;
- a default project that is not enabled;
- duplicate project IDs;
- duplicate GitHub repositories, compared case-insensitively;
- duplicate normalized local repository paths;
- duplicate normalized state database paths;
- duplicate normalized runner lock paths.

These checks prevent two project identities from owning the same repository, state or execution lock.

## Operator management (issue #177)

The registry above is read-only foundation. Issue #177 adds one machine-local
management contract on top of it, so repositories can be onboarded, admitted,
withdrawn and removed without editing Agent Runner source and without
hand-editing JSON as the normal operating path.

```bash
agent-runner projects list [--json] [--verbose]
agent-runner projects show <project-id> [--json] [--verbose]
agent-runner projects add --project-id <id> --repo <owner/name> \
  --local-path <absolute checkout path> [--display-name <name>] \
  [--enable] [--allow-missing-checkout] [--config-path <path>]
agent-runner projects enable <project-id>
agent-runner projects disable <project-id>
agent-runner projects remove <project-id>
agent-runner projects set-default <project-id>
agent-runner projects validate
```

All subcommands accept `--registry <path>`; the default is
`AGENT_RUNNER_PROJECT_REGISTRY`, else `~/.config/agent-runner/projects.json`.
Management refuses to run as root.

The implementation lives in `scripts/ops/agent-runner-project-registry-store.mjs`
and is the **typed library contract** a later authenticated control service
must call. There is deliberately no second registry format and no second
JSON-writing path: the manifest keeps schema v1 above, every generated project
config is checked by the canonical `validateAgentRunnerConfig`, and every
uniqueness/admission rule is applied by reusing
`resolveProjectRegistrySelection()`.

### `add`

`add` requires explicit operator-supplied identity — project ID, GitHub
`owner/name` and an absolute canonical local checkout path. It derives the
remaining config from runner-generic defaults and a per-project XDG state
root (`~/.local/state/agent-runner/<project-id>/`), so two projects can never
share a state database or an execution lock. `safeDefaultValidationCommands`
starts empty rather than guessing a command to execute.

The local checkout is inspected **read-only** (`git rev-parse
--is-inside-work-tree`, `git config --get remote.origin.url`) to verify the
declared facts. `add` never clones a repository, never writes to the checkout
and performs no GitHub call at all. A checkout whose `origin` disagrees with
`--repo` is refused; a not-yet-present checkout requires the explicit
`--allow-missing-checkout` flag.

**Additions are disabled by default.** A project is admitted only when the
operator passes `--enable`, or later runs `projects enable`.

### Atomic mutation and rollback

Every mutation runs the same sequence:

1. acquire the machine-local registry mutation lock
   (`<registry dir>/.projects.registry.lock`, reusing the existing recoverable
   lock implementation);
2. sweep inert staging files left by any interrupted earlier mutation;
3. load and validate current state through the canonical loader;
4. build the complete proposed config and registry state in memory;
5. validate the proposal, including every duplicate-ownership constraint;
6. stage each file to a restricted temporary file, fsync and atomically
   rename — project configs first, then the manifest, then any archive move;
7. re-load and validate the entire resulting registry through
   `loadProjectRegistry()`;
8. on any failure, restore the exact prior bytes of every touched file (and
   remove files that did not previously exist);
9. append bounded audit evidence and release the lock.

A crash at any point leaves the previous valid registry intact: temporary
files are never referenced by the manifest, and the manifest is only replaced
after the config it references is already committed. A scheduler or poller
therefore never observes a half-added project.

### Enable / disable / remove

`enable` and `disable` change registry admission only, after full
revalidation. Disabling deletes no config, state, branch, worktree, claim, PR
or evidence, and affects new selection only — work already leased stays owned
by its existing transaction. Because consumers re-read the registry on each
complete load, an enabled-state change is visible to the very next load with
no restart-only cache.

`remove` is non-destructive. It withdraws registry admission and moves the
project config into `<registry dir>/archived-projects/`, never overwriting an
existing archive entry. It never deletes a repository checkout, worktree,
branch, SQLite state, credential, GitHub object or audit evidence, and there
is no purge operation in this contract. Removal is refused when it would make
the registry invalid — removing the default project, or the last remaining
project, requires `set-default` first.

### Bounded output

`list`/`show` return only operator-safe fields: project ID, display name,
GitHub repository, enabled/default flags, config validity, checkout readiness,
state-initialised flag, registry admission and a bounded reason code.
`schedulerEligible` is deliberately `null` with reason
`scheduler-registry-adoption-pending` until #178 makes the implementation
scheduler consume this registry. No machine paths, credentials, environment
values, manager packet bodies, prompts or provider output appear in the
default JSON contract; canonical local paths are added only under an explicit
local `--verbose`.

### Audit

Successful and refused mutations append one bounded JSON line to
`~/.local/state/agent-runner/project-registry-audit.jsonl`
(`AGENT_RUNNER_PROJECT_REGISTRY_AUDIT_PATH` overrides it): timestamp, operator
identity, source, action, project ID, repository, before/after registry
content digest, outcome and reason code. Config contents and secrets are
structurally unrepresentable in that record.

### Not in this issue

No scheduler or timer topology change, no second poller, no concurrency, no
paid fallback, no repository cloning, no GitHub write authority, no
destructive purge and no dashboard implementation. #178 owns implementation-
scheduler adoption of the managed registry.

## Compatibility

Existing single-project entrypoints continue to use `AGENT_RUNNER_CONFIG` and `loadAgentRunnerConfig`. The registry module is additive in this issue. Scheduler and systemd adoption are later bounded issues under `AUTOMATION.CLOSED.LOOP.1`.

## Example files

- `.agent-runner/project-registry.example.json`
- `.agent-runner/config.modelspend.example.json`
- `.agent-runner/config.agent-runner.example.json`

Machine-local production copies belong under the XDG configuration directory, for example:

```text
~/.config/agent-runner/projects.json
~/.config/agent-runner/projects/modelspend.json
~/.config/agent-runner/projects/agent-runner.json
```

Do not commit tokens, installation keys, environment contents, SQLite state or machine-local secret references into an example registry.

## Focused validation

```bash
node --check scripts/ops/agent-runner-project-registry.mjs
node --check scripts/ops/agent-runner-project-registry-store.mjs
node --check scripts/ops/agent-runner-projects-command.mjs
node --test scripts/ops/agent-runner-project-registry.test.mjs \
  scripts/ops/agent-runner-project-registry-store.test.mjs \
  scripts/ops/agent-runner-projects-command.test.mjs
bash scripts/validate.sh
```
