#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:-plan}"
[ "$#" -gt 0 ] && shift || true
SOURCE="${MODELSPEND_RUNNER_STATE_SOURCE:-$HOME/projects/modelspend/.var/claude-runner}"
DESTINATION="${AGENT_RUNNER_STATE_DESTINATION:-$HOME/.local/state/agent-runner/modelspend}"
ASSUME_YES=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) SOURCE="${2:?missing --source value}"; shift 2 ;;
    --destination) DESTINATION="${2:?missing --destination value}"; shift 2 ;;
    --yes) ASSUME_YES=true; shift ;;
    --help|-h)
      cat <<'USAGE'
Usage: scripts/migrate-state.sh plan|copy|verify [options]

The migration copies the existing runner state into the XDG state location.
It never deletes or moves the ModelSpend-contained source, which remains the
rollback source until the migration issue is closed.
USAGE
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$COMMAND" in plan|copy|verify) ;; *) echo "Unknown command: $COMMAND" >&2; exit 2 ;; esac

SOURCE="$(readlink -f "$SOURCE")"
DESTINATION="$(readlink -m "$DESTINATION")"
case "$DESTINATION" in "$HOME/.local/state/agent-runner"/*) ;; *) echo "Destination must remain under $HOME/.local/state/agent-runner" >&2; exit 1 ;; esac
[ -d "$SOURCE" ] || { echo "Source state directory missing: $SOURCE" >&2; exit 1; }
[ -f "$SOURCE/runner-state.sqlite" ] || { echo "Source SQLite DB missing: $SOURCE/runner-state.sqlite" >&2; exit 1; }

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
} finally {
  db.close();
}
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

if [ "$COMMAND" = plan ]; then
  echo "Source:      $SOURCE"
  echo "Destination: $DESTINATION"
  du -sh "$SOURCE"
  verify_sqlite "$SOURCE/runner-state.sqlite"
  echo "No files changed. Run 'copy --yes' after stopping the old runner service."
  exit 0
fi

if [ "$COMMAND" = copy ]; then
  [ "$ASSUME_YES" = true ] || { echo "Refusing copy without --yes" >&2; exit 1; }
  if systemctl --user is-active --quiet modelspend-claude-runner.service 2>/dev/null; then
    echo "Old ModelSpend runner service is active; stop it before copying state" >&2
    exit 1
  fi
  if systemctl --user is-active --quiet agent-runner-modelspend.service 2>/dev/null; then
    echo "Standalone runner service is active; stop it before copying state" >&2
    exit 1
  fi
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
{
  "schemaVersion": 1,
  "source": "${SOURCE}",
  "destination": "${DESTINATION}",
  "copiedAt": "$(date -u +%FT%TZ)",
  "sourceRetainedForRollback": true
}
JSON
  chmod 0600 "$DESTINATION/.source-manifest.sha256" "$DESTINATION/.migration.json"
  echo "PASS: runner state copied; source remains untouched for rollback"
  exit 0
fi

verify_sqlite "$SOURCE/runner-state.sqlite"
verify_sqlite "$DESTINATION/runner-state.sqlite"
TMP_SOURCE="$(mktemp)"
TMP_DEST="$(mktemp)"
trap 'rm -f "$TMP_SOURCE" "$TMP_DEST"' EXIT
manifest "$SOURCE" | grep -Ev '(^|  )[^ ]*\.lock$' > "$TMP_SOURCE"
manifest "$DESTINATION" | grep -Ev '  \.migration\.json$|  \.source-manifest\.sha256$|(^|  )[^ ]*\.lock$' > "$TMP_DEST"
if ! diff -u "$TMP_SOURCE" "$TMP_DEST"; then
  echo "State copy differs from source" >&2
  exit 1
fi
echo "PASS: source and standalone state copies match"
