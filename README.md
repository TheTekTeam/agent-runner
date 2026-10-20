# Agent Runner

Private standalone GitHub-issue-driven agent runner for monorepo projects.

## Intended layout

```text
/projects/agent-runner/             # this checkout
.config/agent-runner/               # project configs and secret references
.local/state/agent-runner/          # SQLite state, logs, locks and delivery state
/var/www/agent-runner/dashboard/    # generated read-only dashboard
```

## Dispatch authority

New claims use one immutable ChatGPT manager packet revision and fingerprint. Legacy proceed/continue and local generated-preflight paths are retired. See [`docs/ops/AGENT-RUNNER-DISPATCH-AUTHORITY-MIGRATION.md`](docs/ops/AGENT-RUNNER-DISPATCH-AUTHORITY-MIGRATION.md).

### Finding manager-packet code quickly

Start with [`docs/ops/AGENT-RUNNER-MANAGER-AUTHORITY-CODE-MAP.md`](docs/ops/AGENT-RUNNER-MANAGER-AUTHORITY-CODE-MAP.md). It identifies the canonical parser, current-authority resolver, body-digest function, authority-key function and repository/branch dispatch boundary.

The repository intentionally has no live manager-packet generator. The packet fingerprint is manager-supplied and format-validated; `packetBodyDigest(body)` is the separate SHA-256 value the runner computes over the complete comment body to detect edits.

## Validation

```bash
bash scripts/validate.sh
```

With the migration manifest present, validation checks each imported file's declared status — an exact hash match for files still `locked` to the ModelSpend import, or a well-formed provenance/ownership record for files explicitly `transferred` to canonical ownership here (see "Manifest provenance and ownership transfer" in `docs/MIGRATION.md`) — plus JavaScript syntax, the focused runner test suite, safe missing-state behaviour, installer/state-migration contracts and repository secret boundaries.
