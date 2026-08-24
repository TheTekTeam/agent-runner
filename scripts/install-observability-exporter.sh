#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
umask 077

COMMAND="${1:-status}"
[ "$#" -gt 0 ] && shift || true
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${AGENT_RUNNER_CONFIG:-$HOME/.config/agent-runner/modelspend.json}"
USER_UNIT_DIR="$HOME/.config/systemd/user"
SERVICE="agent-runner-observability-exporter.service"
HOST="127.0.0.1"
PORT="${AGENT_RUNNER_OBSERVABILITY_PORT:-9914}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config) CONFIG_FILE="${2:?missing --config value}"; shift 2 ;;
    --port) PORT="${2:?missing --port value}"; shift 2 ;;
    --help|-h)
      cat <<'USAGE'
Usage: scripts/install-observability-exporter.sh install|verify|status|enable|disable|remove [options]

Options:
  --config <path>  Agent Runner project config JSON
  --port <number>  Loopback exporter port (default: 9914)
USAGE
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$COMMAND" in
  install|verify|status|enable|disable|remove) ;;
  *) echo "Unknown command: $COMMAND" >&2; exit 2 ;;
esac

[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || {
  echo "Invalid exporter port: $PORT" >&2
  exit 1
}

require_file() {
  [ -f "$1" ] || { echo "Required file missing: $1" >&2; exit 1; }
}

json_value() {
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const result = value[process.argv[2]];
    if (typeof result !== "string" || !result) process.exit(2);
    process.stdout.write(result);
  ' "$CONFIG_FILE" "$1"
}

render_unit() {
  local state_root
  state_root="$(dirname "$(json_value stateDbPath)")"
  install -d -m 0755 "$USER_UNIT_DIR"
  cat > "$USER_UNIT_DIR/$SERVICE" <<UNIT
[Unit]
Description=Agent Runner read-only observability exporter
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=AGENT_RUNNER_CONFIG=$CONFIG_FILE
Environment=AGENT_RUNNER_NODE=%H
ExecStart=/usr/bin/node $ROOT/scripts/ops/agent-runner-observability-exporter.mjs --config $CONFIG_FILE --host $HOST --port $PORT
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadOnlyPaths=$ROOT $CONFIG_FILE $state_root
RestrictAddressFamilies=AF_UNIX AF_INET
LockPersonality=true
MemoryDenyWriteExecute=true
UMask=0077
TasksMax=64
MemoryMax=128M
TimeoutStopSec=15s

[Install]
WantedBy=default.target
UNIT
  chmod 0644 "$USER_UNIT_DIR/$SERVICE"
}

verify() {
  require_file "$CONFIG_FILE"
  require_file "$ROOT/scripts/ops/agent-runner-observability-exporter.mjs"
  local state_db
  state_db="$(json_value stateDbPath)"
  case "$state_db" in /*) ;; *) echo "stateDbPath must be absolute: $state_db" >&2; exit 1 ;; esac
  node --check "$ROOT/scripts/ops/agent-runner-observability-exporter.mjs"
  systemd-analyze --user verify "$USER_UNIT_DIR/$SERVICE"
  if systemctl --user is-active --quiet "$SERVICE"; then
    curl -fsS --max-time 5 "http://$HOST:$PORT/healthz" >/tmp/agent-runner-observability-health.json
    node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (value.exporter !== "agent-runner-observability" || value.schema_compatible !== true) process.exit(1);
    ' /tmp/agent-runner-observability-health.json
    curl -fsS --max-time 5 "http://$HOST:$PORT/metrics" | grep -Fq 'agent_runner_exporter_up 1'
    rm -f /tmp/agent-runner-observability-health.json
  fi
  echo "PASS: Agent Runner observability exporter installation"
}

status() {
  printf 'Repository: %s\nConfig: %s\nEndpoint: http://%s:%s\n' "$ROOT" "$CONFIG_FILE" "$HOST" "$PORT"
  printf '%-46s enabled=%-12s active=%s\n' "$SERVICE" \
    "$(systemctl --user is-enabled "$SERVICE" 2>/dev/null || true)" \
    "$(systemctl --user is-active "$SERVICE" 2>/dev/null || true)"
  systemctl --user --no-pager --full status "$SERVICE" 2>/dev/null || true
}

case "$COMMAND" in
  install)
    require_file "$CONFIG_FILE"
    render_unit
    systemctl --user daemon-reload
    systemctl --user enable --now "$SERVICE"
    verify
    ;;
  verify) verify ;;
  status) status ;;
  enable)
    systemctl --user enable --now "$SERVICE"
    verify
    ;;
  disable)
    systemctl --user disable --now "$SERVICE" 2>/dev/null || true
    ;;
  remove)
    systemctl --user disable --now "$SERVICE" 2>/dev/null || true
    rm -f "$USER_UNIT_DIR/$SERVICE"
    systemctl --user daemon-reload
    ;;
esac
