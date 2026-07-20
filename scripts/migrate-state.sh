#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:-plan}"
[ "$#" -gt 0 ] && shift || true
SOURCE_INPUT="${MODELSPEND_RUNNER_STATE_SOURCE:-$HOME/projects/modelspend/.var/claude-runner}"
DESTINATION_INPUT="${AGENT_RUNNER_STATE_DESTINATION:-$HOME/.local/state/agent-runner/modelspend}"
ASSUME_YES=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) SOURCE_INPUT="${2:?missing --source value}"; shift 2 ;;
    --destination) DESTINATION_INPUT="${2:?missing --destination value}"; shift 2 ;;
    --yes) ASSUME_YES=true; shift ;;
    --help|-h)
      cat <<'USAGE'
Usage: scripts/migrate-state.sh plan|copy|verify|link|rollback-link [options]

copy          copies legacy state into the XDG location without deleting source
link          replaces the stopped legacy path with a symlink to XDG state
rollback-link syncs current XDG state into the retained legacy backup and restores it

Both old and new services use the same state after link, so rollback does not
lose events written during the proving window.
USAGE
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$COMMAND" in plan|copy|verify|link|rollback-link) ;; *) echo "Unknown command: $COMMAND" >&2; exit 2 ;; esac

SOURCE="$(readlink -m "$SOURCE_INPUT")"
DESTINATION="$(readlink -m "$DESTINATION_INPUT")"
case "$DESTINATION" in "$HOME/.local/state/agent-runner"/*) ;; *) echo "Destination must remain under $HOME/.local/state/agent-runner" >&2; exit 1 ;; esac

require_stopped() {
  for unit in modelspend-claude-runner.service agent-runner-modelspend.service; do
    if systemctl --user is-active --quiet "$unit" 2>/dev/null; then
      echo "Service must be stopped before state migration: $unit" >&2
      exit 1
    fi
  done
}

verify_sqlite() {
  local db="$1"
  node --input-type=module - "$db" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const path = process.argv[2];
const db = new DatabaseSync(path, { readOnly: true });
try {
  const result = db.prepare('PRAGMA integrity_check').get();
  if (!result || result.integrity_check !== 'ok') {
    console.error(`SQLite integrity check failed for ${path}: ${JSON.stringify(result)}`);
    process.exit(1);
  }
  const version = db.prepare('PRAGMA user_version').get();
  console.log(`PASS: ${path} integrity=ok user_version=${version.user_version}`);
} finally { db.close(); }
NODE
}

manifest() {
  local root="$1"
  find "$root" -maxdepth 3 -type f -printf '%P\0' \
    | sort -z \
    | while IFS= read -r -d '' file; do
        sha256sum "$root/$file" | awk -v file="$file" '{print $1 "  " file}'
      done
}

source_directory() {
  if [ -L "$SOURCE" ]; then readlink -f "$SOURCE"; else printf '%s\n' "$SOURCE"; fi
}

require_source_db() {
  local root
  root="$(source_directory)"
  [ -d "$root" ] || { echo "Source state directory missing: $root" >&2; exit 1; }
  [ -f "$root/runner-state.sqlite" ] || { echo "Source SQLite DB missing: $root/runner-state.sqlite" >&2; exit 1; }
}

verify_equal() {
  local source_root tmp_source tmp_dest
  source_root="$(source_directory)"
  verify_sqlite "$source_root/runner-state.sqlite"
  verify_sqlite "$DESTINATION/runner-state.sqlite"
  if [ "$(readlink -f "$source_root")" = "$(readlink -f "$DESTINATION")" ]; then
    echo "PASS: legacy path and standalone path resolve to the same state"
    return 0
  fi
  tmp_source="$(mktemp)"
  tmp_dest="$(mktemp)"
  trap 'rm -f "$tmp_source" "$tmp_dest"' RETURN
  manifest "$source_root" | grep -Ev '(^|  )[^ ]*\.lock$' > "$tmp_source"
  manifest "$DESTINATION" | grep -Ev '  \.migration\.json$|  \.source-manifest\.sha256$|(^|  )[^ ]*\.lock$' > "$tmp_dest"
  diff -u "$tmp_source" "$tmp_dest" || { echo "State copy differs from source" >&2; return 1; }
  echo "PASS: source and standalone state copies match"
}

if [ "$COMMAND" = plan ]; then
  require_source_db
  echo "Legacy path: $SOURCE"
  echo "Legacy resolves to: $(source_directory)"
  echo "XDG state: $DESTINATION"
  du -sh "$(source_directory)"
  verify_sqlite "$(source_directory)/runner-state.sqlite"
  echo "No files changed. Normal sequence: copy --yes, verify, then link --yes during cutover."
  exit 0
fi

if [ "$COMMAND" = copy ]; then
  [ "$ASSUME_YES" = true ] || { echo "Refusing copy without --yes" >&2; exit 1; }
  require_stopped
  [ ! -L "$SOURCE" ] || { echo "Legacy path is already linked to XDG state" >&2; exit 1; }
  require_source_db
  verify_sqlite "$SOURCE/runner-state.sqlite"
  install -d -m 0700 "$DESTINATION"
  if find "$DESTINATION" -mindepth 1 -print -quit | grep -q .; then
    BACKUP="$DESTINATION.before-$(date -u +%Y%m%dT%H%M%SZ)"
    cp -a "$DESTINATION" "$BACKUP"
    chmod -R go-rwx "$BACKUP"
    echo "Existing destination backed up to $BACKUP"
  fi
  rsync -a --delete --exclude='*.lock' "$SOURCE/" "$DESTINATION/"
  chmod -R go-rwx "$DESTINATION"
  verify_sqlite "$DESTINATION/runner-state.sqlite"
  manifest "$SOURCE" > "$DESTINATION/.source-manifest.sha256"
  cat > "$DESTINATION/.migration.json" <<JSON
{"schemaVersion":1,"source":"$SOURCE","destination":"$DESTINATION","copiedAt":"$(date -u +%FT%TZ)","sourceRetainedForRollback":true,"legacyBackup":null}
JSON
  chmod 0600 "$DESTINATION/.source-manifest.sha256" "$DESTINATION/.migration.json"
  echo "PASS: runner state copied; legacy source remains untouched"
  exit 0
fi

if [ "$COMMAND" = verify ]; then
  require_source_db
  [ -f "$DESTINATION/runner-state.sqlite" ] || { echo "Destination SQLite DB missing" >&2; exit 1; }
  verify_equal
  exit 0
fi

if [ "$COMMAND" = link ]; then
  [ "$ASSUME_YES" = true ] || { echo "Refusing link without --yes" >&2; exit 1; }
  require_stopped
  [ ! -L "$SOURCE" ] || { echo "Legacy path is already a symlink" >&2; exit 1; }
  verify_equal
  BACKUP="${SOURCE}.pre-standalone-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$SOURCE" "$BACKUP"
  ln -s "$DESTINATION" "$SOURCE"
  node --input-type=module - "$DESTINATION/.migration.json" "$BACKUP" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const [path, backup] = process.argv.slice(2);
const value = JSON.parse(readFileSync(path, 'utf8'));
value.linkedAt = new Date().toISOString();
value.legacyBackup = backup;
writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE
  [ "$(readlink -f "$SOURCE")" = "$(readlink -f "$DESTINATION")" ] || { echo "Symlink verification failed" >&2; exit 1; }
  echo "PASS: legacy state path now resolves to XDG state; backup retained at $BACKUP"
  exit 0
fi

[ "$ASSUME_YES" = true ] || { echo "Refusing rollback-link without --yes" >&2; exit 1; }
require_stopped
[ -L "$SOURCE" ] || { echo "Legacy path is not a symlink; nothing to roll back" >&2; exit 1; }
[ "$(readlink -f "$SOURCE")" = "$(readlink -f "$DESTINATION")" ] || { echo "Legacy symlink points somewhere unexpected" >&2; exit 1; }
MIGRATION_FILE="$DESTINATION/.migration.json"
[ -f "$MIGRATION_FILE" ] || { echo "Migration record missing" >&2; exit 1; }
BACKUP="$(node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!v.legacyBackup) process.exit(2); process.stdout.write(v.legacyBackup)' "$MIGRATION_FILE")"
case "$BACKUP" in "${SOURCE}.pre-standalone-"*) ;; *) echo "Recorded backup path is outside the allowed legacy prefix" >&2; exit 1 ;; esac
[ -d "$BACKUP" ] || { echo "Legacy backup missing: $BACKUP" >&2; exit 1; }
verify_sqlite "$DESTINATION/runner-state.sqlite"
rsync -a --delete --exclude='.migration.json' --exclude='.source-manifest.sha256' "$DESTINATION/" "$BACKUP/"
verify_sqlite "$BACKUP/runner-state.sqlite"
rm "$SOURCE"
mv "$BACKUP" "$SOURCE"
node --input-type=module - "$MIGRATION_FILE" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.argv[2];
const value = JSON.parse(readFileSync(path, 'utf8'));
value.rolledBackAt = new Date().toISOString();
writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE
echo "PASS: legacy directory restored with all state written during standalone operation"
