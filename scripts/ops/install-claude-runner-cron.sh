#!/usr/bin/env bash
set -euo pipefail

# Install/sync the Claude runner scheduled wrapper.
# This is separate from the general maintenance installer because Claude implementation runs must remain operator-controlled.
# It installs the wrapper into the modelspend user crontab only. Never install this in root crontab.

MS_USER="${MODELSPEND_USER:-modelspend}"
MS_HOME="${MODELSPEND_HOME:-/home/modelspend}"
DEST_DIR="${MODELSPEND_JOBS_DIR:-$MS_HOME/bin/jobs}"
LOG_DIR="${MODELSPEND_LOG_DIR:-$MS_HOME/logs}"
JSON_LOG_DIR="${CLAUDE_RUNNER_OUTPUT_DIR:-$LOG_DIR/claude-runner-json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER_SRC="$SCRIPT_DIR/jobs/run-claude-runner.sh"
WRAPPER_DEST="$DEST_DIR/run-claude-runner.sh"

DRY_RUN=0
REMOVE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --remove) REMOVE=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

info() { echo "[install-claude-runner-cron] $*"; }
fail() { echo "[install-claude-runner-cron] ERROR: $*" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  fail "Must run as root with sudo. Crontab edits target the $MS_USER user via crontab -u $MS_USER."
fi

[ -f "$WRAPPER_SRC" ] || fail "Missing wrapper source: $WRAPPER_SRC"

BEGIN_MARK="# >>> modelspend Claude runner job (managed by install-claude-runner-cron.sh) >>>"
END_MARK="# <<< modelspend Claude runner job <<<"
JOB_PATTERN='run-claude-runner[.]sh|claude-runner[.]log|claude-runner[.]lock'

managed_block() {
  cat <<EOF
$BEGIN_MARK
*/30 * * * * /usr/bin/flock -n $LOG_DIR/claude-runner.lock /bin/bash -lc '$WRAPPER_DEST >> $LOG_DIR/claude-runner.log 2>&1'
$END_MARK
EOF
}

strip_claude_runner_job() {
  awk -v begin="$BEGIN_MARK" -v end="$END_MARK" -v pat="$JOB_PATTERN" '
    $0 == begin { inblock=1; next }
    $0 == end   { inblock=0; next }
    inblock     { next }
    $0 ~ pat    { next }
    { print }
  '
}

install_wrapper() {
  if [ "$DRY_RUN" -eq 1 ]; then
    info "--dry-run: would install $WRAPPER_DEST"
    info "--dry-run: would ensure writable log files under $LOG_DIR"
    info "--dry-run: would ensure writable JSON log directory $JSON_LOG_DIR"
    return 0
  fi
  install -d -o "$MS_USER" -g "$MS_USER" -m 0755 "$DEST_DIR"
  install -d -o "$MS_USER" -g "$MS_USER" -m 0755 "$LOG_DIR"
  install -d -o "$MS_USER" -g "$MS_USER" -m 0755 "$JSON_LOG_DIR"
  touch "$LOG_DIR/claude-runner.log" "$LOG_DIR/claude-runner.lock"
  chown "$MS_USER:$MS_USER" "$LOG_DIR/claude-runner.log" "$LOG_DIR/claude-runner.lock"
  chmod 0644 "$LOG_DIR/claude-runner.log"
  chmod 0644 "$LOG_DIR/claude-runner.lock"
  install -o "$MS_USER" -g "$MS_USER" -m 0755 "$WRAPPER_SRC" "$WRAPPER_DEST"
  info "Installed $WRAPPER_DEST"
  info "Prepared writable logs under $LOG_DIR"
}

sync_crontab() {
  local current cleaned desired tmp
  current="$(crontab -u "$MS_USER" -l 2>/dev/null || true)"
  cleaned="$(printf '%s\n' "$current" | strip_claude_runner_job | sed '/^$/N;/^\n$/D')"
  if [ "$REMOVE" -eq 1 ]; then
    desired="$(printf '%s\n' "$cleaned")"
  else
    desired="$(printf '%s' "$cleaned")"$'\n'"$(managed_block)"$'\n'
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    info "--dry-run: intended $MS_USER crontab would be:"
    printf '%s\n' "----------------------------------------"
    printf '%s' "$desired"
    printf '%s\n' "----------------------------------------"
    return 0
  fi

  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' RETURN
  printf '%s' "$desired" > "$tmp"
  crontab -u "$MS_USER" "$tmp"
  if [ "$REMOVE" -eq 1 ]; then
    info "Removed Claude runner job from $MS_USER crontab."
  else
    info "Installed Claude runner job into $MS_USER crontab."
  fi
}

install_wrapper
sync_crontab
info "Done."
