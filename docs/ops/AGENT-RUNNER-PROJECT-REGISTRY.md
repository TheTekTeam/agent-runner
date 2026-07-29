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
node --check scripts/ops/agent-runner-project-registry.test.mjs
node --test scripts/ops/agent-runner-project-registry.test.mjs
bash scripts/validate.sh
```
