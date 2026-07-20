# Standalone Agent Runner migration

Authority: `TheTekTeam/modelspend#686`.

This migration deliberately separates **source extraction**, **state migration**, **dry-run comparison**, and **execution cutover**. No step deletes the legacy implementation or its state.

## Target layout

```text
/home/gp/projects/agent-runner
/home/gp/.config/agent-runner/modelspend.json
/home/gp/.config/agent-runner/runner.env
/home/gp/.local/state/agent-runner/modelspend
/var/www/agent-runner/dashboard
```

The ModelSpend execution checkout remains separate, normally:

```text
/home/gp/projects/modelspend-runner-live
```

## Service sandbox boundary

The execution and dashboard services intentionally use different systemd sandboxes:

- the **runner execution service** uses `ProtectSystem=full`, `NoNewPrivileges=true` and `PrivateTmp=true`, while retaining normal operator-home writes required by Claude, Codex and future agent CLIs for their authenticated user-state, caches and session metadata;
- the **dashboard publisher** remains more restrictive with `ProtectSystem=strict` and `ProtectHome=read-only`, because it needs only the runner state and the bounded dashboard output directory.

Do not add `ProtectHome=read-only` to the runner execution service without first proving every configured agent works with explicit writable state directories. A unit that starts successfully but prevents an agent CLI from maintaining its normal user state is not a valid hardening improvement.

## 1. Import the proven source boundary

Run from a clean Agent Runner checkout after the portable-entrypoint change in ModelSpend has been reviewed:

```bash
cd /home/gp/projects/agent-runner
node scripts/import-modelspend-runner.mjs \
  --source /home/gp/projects/modelspend \
  --expected-commit <reviewed-modelspend-commit>

node scripts/import-modelspend-runner.mjs \
  --source /home/gp/projects/modelspend \
  --expected-commit <reviewed-modelspend-commit> \
  --write

bash scripts/validate.sh
```

The importer:

- requires a clean `TheTekTeam/modelspend` checkout;
- starts from canonical runner/dashboard entrypoints;
- recursively resolves relative imports;
- rejects undeclared external packages;
- copies runner tests, installers, dashboard assets and operator docs;
- writes `MIGRATION-MANIFEST.json` with source commit and per-file SHA-256;
- validates JavaScript syntax and imported-file integrity.

Commit the generated source and manifest to the extraction branch. The manifest is the provenance record for the documented initial import.

## 2. Prepare machine-local configuration

```bash
install -d -m 0700 ~/.config/agent-runner ~/.local/state/agent-runner
cp config/modelspend.example.json ~/.config/agent-runner/modelspend.json
chmod 0600 ~/.config/agent-runner/modelspend.json
```

Review `localRepoPath`; the live execution checkout and runner source checkout are intentionally different directories.

Create `~/.config/agent-runner/runner.env` by migrating the existing runner environment without printing secrets. Retain mode `0600`.

## 3. Copy and verify state

Stop both services before copying:

```bash
systemctl --user stop modelspend-claude-runner.service || true
systemctl --user stop agent-runner-modelspend.service || true

bash scripts/migrate-state.sh plan
bash scripts/migrate-state.sh copy --yes
bash scripts/migrate-state.sh verify
```

The legacy directory remains intact at this stage.

## 4. Dry-run equivalence

Run the legacy and standalone entrypoints against separate temporary output/SQLite paths with execution disabled. Compare:

- selected issue and selection mode;
- manager-preflight revision;
- agent/profile resolution;
- quota admission result;
- skip/no-selection reason;
- exit status and structured outcome.

Never run both in execute mode. Stop if they disagree.

## 5. Install units without cutover

```bash
bash scripts/install-dell-user-services.sh install
bash scripts/install-dell-user-services.sh verify
bash scripts/install-dell-user-services.sh status
```

This writes the new user units but does not enable them or disable the legacy timer.

## 6. Cut over

```bash
bash scripts/install-dell-user-services.sh install --cutover --yes
bash scripts/install-dell-user-services.sh status
```

Cutover:

1. verifies the imported source, config and SQLite integrity;
2. replaces the stopped legacy state directory with a symlink to XDG state while retaining a timestamped backup;
3. disables the legacy timer/service;
4. enables and explicitly restarts the standalone runner/dashboard timers;
5. proves both timers have future triggers;
6. writes a protected cutover record.

The old and new entrypoints therefore see the same current state during the rollback window.

## 7. Roll back

```bash
bash scripts/install-dell-user-services.sh rollback --yes
```

Rollback stops the standalone units, synchronises current XDG state into the retained legacy backup, restores the legacy directory, and re-enables the legacy timer only when it was enabled before cutover.

## Completion gate

Do not remove ModelSpend compatibility wrappers or the legacy static dashboard until:

- imported Agent Runner CI is green;
- ModelSpend compatibility CI is green;
- supervised dry-run equivalence passes;
- at least one no-selection cycle and one bounded issue cycle are observed after cutover;
- dashboard/state freshness is verified;
- rollback has been field-tested without losing state.
