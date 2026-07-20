#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:-status}"
[ "$#" -gt 0 ] && shift || true
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${AGENT_RUNNER_CONFIG:-$HOME/.config/agent-runner/modelspend.json}"
ENV_FILE="${AGENT_RUNNER_ENV_FILE:-$HOME/.config/agent-runner/runner.env}"
USER_UNIT_DIR="$HOME/.config/systemd/user"
STATE_ROOT="$HOME/.local/state/agent-runner"
CUTOVER_FILE="$STATE_ROOT/cutover.json"
CUTOVER=false
ASSUME_YES=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config) CONFIG_FILE="${2:?missing --config value}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?missing --env-file value}"; shift 2 ;;
    --cutover) CUTOVER=true; shift ;;
    --yes) ASSUME_YES=true; shift ;;
    --help|-h)
      cat <<'USAGE'
Usage: scripts/install-dell-user-services.sh install|verify|status|enable|disable|rollback|remove [options]

install writes independent Agent Runner user units. It does not disable the
legacy ModelSpend runner unless both --cutover and --yes are supplied.
USAGE
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$COMMAND" in install|verify|status|enable|disable|rollback|remove) ;; *) echo "Unknown command: $COMMAND" >&2; exit 2 ;; esac

RUN_SERVICE="agent-runner-modelspend.service"
RUN_TIMER="agent-runner-modelspend.timer"
DASH_SERVICE="agent-runner-dashboard.service"
DASH_TIMER="agent-runner-dashboard.timer"
OLD_SERVICE="modelspend-claude-runner.service"
OLD_TIMER="modelspend-claude-runner.timer"

require_file() { [ -f "$1" ] || { echo "Required file missing: $1" >&2; exit 1; }; }
json_value() {
  node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const path=process.argv[2].split("."); let x=v; for (const key of path) x=x?.[key]; if (typeof x!=="string" || !x) process.exit(2); process.stdout.write(x);' "$CONFIG_FILE" "$1"
}

render_units() {
  install -d -m 0755 "$USER_UNIT_DIR"
  cat > "$USER_UNIT_DIR/$RUN_SERVICE" <<UNIT
[Unit]
Description=Standalone Agent Runner — ModelSpend
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$ROOT
Environment=AGENT_RUNNER_CONFIG=$CONFIG_FILE
Environment=AGENT_RUNNER_ENV_FILE=$ENV_FILE
ExecStart=$ROOT/bin/run-project.sh
Nice=5
IOSchedulingClass=best-effort
IOSchedulingPriority=6
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/.local/state/agent-runner %h/.config/agent-runner $(json_value localRepoPath) /var/www/agent-runner/dashboard
UMask=0077
TimeoutStartSec=6h
UNIT

  cat > "$USER_UNIT_DIR/$RUN_TIMER" <<UNIT
[Unit]
Description=Schedule standalone Agent Runner — ModelSpend

[Timer]
OnActiveSec=2m
OnUnitInactiveSec=15m
AccuracySec=30s
RandomizedDelaySec=30s
Unit=$RUN_SERVICE

[Install]
WantedBy=timers.target
UNIT

  cat > "$USER_UNIT_DIR/$DASH_SERVICE" <<UNIT
[Unit]
Description=Publish standalone Agent Runner dashboard
After=$RUN_SERVICE

[Service]
Type=oneshot
WorkingDirectory=$ROOT
Environment=AGENT_RUNNER_CONFIG=$CONFIG_FILE
ExecStart=$ROOT/bin/publish-dashboard.sh
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/www/agent-runner/dashboard %h/.local/state/agent-runner
UMask=0027
TimeoutStartSec=5m
UNIT

  cat > "$USER_UNIT_DIR/$DASH_TIMER" <<UNIT
[Unit]
Description=Refresh standalone Agent Runner dashboard

[Timer]
OnActiveSec=1m
OnUnitInactiveSec=5m
AccuracySec=30s
Unit=$DASH_SERVICE

[Install]
WantedBy=timers.target
UNIT
  chmod 0644 "$USER_UNIT_DIR/$RUN_SERVICE" "$USER_UNIT_DIR/$RUN_TIMER" "$USER_UNIT_DIR/$DASH_SERVICE" "$USER_UNIT_DIR/$DASH_TIMER"
}

future_trigger_exists() {
  systemctl --user list-timers "$1" --all --no-pager --no-legend | grep -Fq "$1"
}

verify() {
  require_file "$CONFIG_FILE"
  require_file "$ROOT/MIGRATION-MANIFEST.json"
  require_file "$ROOT/scripts/ops/claude-runner-cron.mjs"
  require_file "$ROOT/scripts/ops/claude-runner-dashboard-local.mjs"
  require_file "$ROOT/bin/run-project.sh"
  require_file "$ROOT/bin/publish-dashboard.sh"
  local project state_db
  project="$(json_value localRepoPath)"
  state_db="$(json_value stateDbPath)"
  [ -d "$project/.git" ] || { echo "Configured project checkout is invalid: $project" >&2; exit 1; }
  [ -f "$state_db" ] || { echo "Migrated state DB is missing: $state_db" >&2; exit 1; }
  node --input-type=module - "$state_db" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const result = db.prepare('PRAGMA integrity_check').get();
  if (result?.integrity_check !== 'ok') process.exit(1);
} finally { db.close(); }
NODE
  systemd-analyze --user verify "$USER_UNIT_DIR/$RUN_SERVICE" "$USER_UNIT_DIR/$RUN_TIMER" "$USER_UNIT_DIR/$DASH_SERVICE" "$USER_UNIT_DIR/$DASH_TIMER"
  echo "PASS: standalone Agent Runner installation prerequisites and units"
}

status() {
  printf 'Repository: %s\nConfig: %s\nEnvironment: %s\n' "$ROOT" "$CONFIG_FILE" "$ENV_FILE"
  for unit in "$RUN_SERVICE" "$RUN_TIMER" "$DASH_SERVICE" "$DASH_TIMER" "$OLD_SERVICE" "$OLD_TIMER"; do
    printf '%-42s enabled=%-12s active=%s\n' "$unit" \
      "$(systemctl --user is-enabled "$unit" 2>/dev/null || true)" \
      "$(systemctl --user is-active "$unit" 2>/dev/null || true)"
  done
  systemctl --user list-timers "$RUN_TIMER" "$DASH_TIMER" --all --no-pager || true
  [ -f "$CUTOVER_FILE" ] && { echo "Cutover record:"; cat "$CUTOVER_FILE"; }
}

case "$COMMAND" in
  install)
    require_file "$CONFIG_FILE"
    require_file "$ROOT/MIGRATION-MANIFEST.json"
    chmod 0755 "$ROOT/bin/run-project.sh" "$ROOT/bin/publish-dashboard.sh" "$ROOT/scripts/migrate-state.sh"
    render_units
    systemctl --user daemon-reload
    verify
    if [ "$CUTOVER" = true ]; then
      [ "$ASSUME_YES" = true ] || { echo "Refusing cutover without --yes" >&2; exit 1; }
      "$ROOT/scripts/migrate-state.sh" verify
      "$ROOT/scripts/migrate-state.sh" link --yes
      install -d -m 0700 "$STATE_ROOT"
      OLD_TIMER_ENABLED="$(systemctl --user is-enabled "$OLD_TIMER" 2>/dev/null || true)"
      systemctl --user disable --now "$OLD_TIMER" 2>/dev/null || true
      systemctl --user stop "$OLD_SERVICE" 2>/dev/null || true
      systemctl --user reset-failed "$OLD_SERVICE" 2>/dev/null || true
      systemctl --user enable "$RUN_TIMER" "$DASH_TIMER"
      systemctl --user restart "$RUN_TIMER" "$DASH_TIMER"
      future_trigger_exists "$RUN_TIMER" || { echo "No future runner timer trigger" >&2; exit 1; }
      future_trigger_exists "$DASH_TIMER" || { echo "No future dashboard timer trigger" >&2; exit 1; }
      cat > "$CUTOVER_FILE" <<JSON
{"schemaVersion":1,"cutoverAt":"$(date -u +%FT%TZ)","oldTimerEnabled":"$OLD_TIMER_ENABLED","runnerRoot":"$ROOT","config":"$CONFIG_FILE"}
JSON
      chmod 0600 "$CUTOVER_FILE"
      echo "PASS: standalone runner cut over; old service disabled and rollback record written"
    else
      echo "Units installed but not enabled. Run install --cutover --yes after dry-run equivalence."
    fi
    ;;
  verify) verify ;;
  status) status ;;
  enable)
    systemctl --user enable "$RUN_TIMER" "$DASH_TIMER"
    systemctl --user restart "$RUN_TIMER" "$DASH_TIMER"
    future_trigger_exists "$RUN_TIMER"
    future_trigger_exists "$DASH_TIMER"
    ;;
  disable)
    systemctl --user disable --now "$RUN_TIMER" "$DASH_TIMER" 2>/dev/null || true
    systemctl --user stop "$RUN_SERVICE" "$DASH_SERVICE" 2>/dev/null || true
    ;;
  rollback)
    [ "$ASSUME_YES" = true ] || { echo "Refusing rollback without --yes" >&2; exit 1; }
    systemctl --user disable --now "$RUN_TIMER" "$DASH_TIMER" 2>/dev/null || true
    systemctl --user stop "$RUN_SERVICE" "$DASH_SERVICE" 2>/dev/null || true
    "$ROOT/scripts/migrate-state.sh" rollback-link --yes
    if [ -f "$CUTOVER_FILE" ] && grep -q '"oldTimerEnabled":"enabled"' "$CUTOVER_FILE"; then
      systemctl --user enable "$OLD_TIMER"
      systemctl --user restart "$OLD_TIMER"
      future_trigger_exists "$OLD_TIMER" || { echo "No future legacy timer trigger after rollback" >&2; exit 1; }
    fi
    mv "$CUTOVER_FILE" "$CUTOVER_FILE.rolled-back-$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
    echo "PASS: legacy runner restored with current state preserved"
    ;;
  remove)
    systemctl --user disable --now "$RUN_TIMER" "$DASH_TIMER" 2>/dev/null || true
    systemctl --user stop "$RUN_SERVICE" "$DASH_SERVICE" 2>/dev/null || true
    rm -f "$USER_UNIT_DIR/$RUN_SERVICE" "$USER_UNIT_DIR/$RUN_TIMER" "$USER_UNIT_DIR/$DASH_SERVICE" "$USER_UNIT_DIR/$DASH_TIMER"
    systemctl --user daemon-reload
    echo "Removed standalone units; source, config and state retained"
    ;;
esac
