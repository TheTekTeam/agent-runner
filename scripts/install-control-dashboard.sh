#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME='agent-runner-control.service'
DEFAULT_PORT='8789'
FIXED_HOST='127.0.0.1'

usage() {
  cat <<'USAGE'
Usage: scripts/install-control-dashboard.sh <install|verify|status|enable|disable|remove> [--port PORT]

Installs and manages only the Agent Runner authenticated control dashboard user service.
The bind address is fixed at 127.0.0.1 and PORT defaults to 8789.
USAGE
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

validate_port() {
  local value=${1-}
  [[ -n "$value" ]] || fail 'missing value for --port'
  [[ "$value" =~ ^[1-9][0-9]{0,4}$ ]] || fail "invalid port: $value"
  (( 10#$value <= 65535 )) || fail "port out of range: $value"
  printf '%s\n' "$value"
}

COMMAND=${1-}
[[ -n "$COMMAND" ]] || { usage >&2; exit 2; }
case "$COMMAND" in
  install|verify|status|enable|disable|remove) ;;
  -h|--help) usage; exit 0 ;;
  *) fail "unsupported command: $COMMAND" ;;
esac
shift

PORT=$DEFAULT_PORT
seen_port=0
while (($#)); do
  case "$1" in
    --port)
      (( seen_port == 0 )) || fail 'duplicate --port'
      (($# >= 2)) || fail 'missing value for --port'
      PORT=$(validate_port "$2")
      seen_port=1
      shift 2
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

# Refuse root before mkdir/install/rm/systemctl or any other mutation.
(( EUID != 0 )) || fail 'refusing to manage a systemd user service as root'

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
CHECKOUT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
SOURCE_UNIT="$CHECKOUT/systemd/user/agent-runner-control.service.in"
SERVER="$CHECKOUT/scripts/ops/agent-runner-control-server.mjs"
TARGET_DIR="$HOME/.config/systemd/user"
TARGET_UNIT="$TARGET_DIR/$SERVICE_NAME"
NODE_BIN=$(command -v node || true)
NODE_BIN=${NODE_BIN:+$(readlink -f -- "$NODE_BIN")}

[[ -f "$SOURCE_UNIT" ]] || fail "repository service source is missing: $SOURCE_UNIT"
[[ -f "$SERVER" ]] || fail "control server is missing: $SERVER"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail 'node executable is unavailable'
for path_value in "$CHECKOUT" "$SERVER" "$NODE_BIN"; do
  [[ "$path_value" =~ ^[-A-Za-z0-9_./]+$ ]] || fail 'checkout or executable path contains unsupported characters'
done

render_unit() {
  local output=$1 text
  text=$(<"$SOURCE_UNIT")
  text=${text//@@CHECKOUT@@/$CHECKOUT}
  text=${text//@@SERVER@@/$SERVER}
  text=${text//@@NODE@@/$NODE_BIN}
  text=${text//@@PORT@@/$PORT}
  printf '%s\n' "$text" >"$output"
  chmod 0600 "$output"
}

validate_rendered_unit() {
  local unit=$1
  if ! grep -Fqx "ExecStart=$NODE_BIN --jitless $SERVER --port $PORT" "$unit"; then
    printf 'ERROR: rendered ExecStart is not exact\n' >&2
    return 1
  fi
  if ! grep -Fqx 'MemoryDenyWriteExecute=true' "$unit"; then
    printf 'ERROR: MemoryDenyWriteExecute requires the repository --jitless service source\n' >&2
    return 1
  fi
  if grep -Eq '(^|[[:space:]])(AmbientCapabilities|CapabilityBoundingSet|SecureBits)=' "$unit"; then
    printf 'ERROR: capability-transition directives are forbidden in the user service\n' >&2
    return 1
  fi
  if grep -Eiq '(password|token|secret[=:][^[:space:]]|api[_-]?key[=:])' "$unit"; then
    printf 'ERROR: rendered unit appears to contain a secret value\n' >&2
    return 1
  fi
  systemd-analyze --user verify "$unit" >/dev/null
}

unit_enabled() {
  systemctl --user is-enabled --quiet "$SERVICE_NAME" 2>/dev/null
}

unit_active() {
  systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null
}

listener_lines() {
  ss -H -ltn "sport = :$PORT" 2>/dev/null || true
}

preflight_port_available() {
  local listeners
  listeners=$(listener_lines)
  if [[ -n "$listeners" ]]; then
    printf 'ERROR: port %s is already in use; refusing activation\n' "$PORT" >&2
    return 1
  fi
}

verify_exact_listener() {
  local -a locals=()
  mapfile -t locals < <(listener_lines | awk '{print $4}')
  if (( ${#locals[@]} != 1 )); then
    printf 'ERROR: expected exactly one TCP listener on %s, found %s\n' "$PORT" "${#locals[@]}" >&2
    return 1
  fi
  if [[ "${locals[0]}" != "$FIXED_HOST:$PORT" ]]; then
    printf 'ERROR: listener is not exactly %s:%s\n' "$FIXED_HOST" "$PORT" >&2
    return 1
  fi
}

verify_shell_health() {
  curl --fail --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    --request GET --output /dev/null \
    "http://$FIXED_HOST:$PORT/"
}

verify_installed_service() {
  if [[ ! -f "$TARGET_UNIT" ]]; then
    printf 'ERROR: service is not installed: %s\n' "$TARGET_UNIT" >&2
    return 1
  fi
  validate_rendered_unit "$TARGET_UNIT" || return 1
  if ! unit_active; then
    printf 'ERROR: %s is not active\n' "$SERVICE_NAME" >&2
    return 1
  fi
  verify_exact_listener || return 1
  verify_shell_health || return 1
}

restore_previous_state() {
  local backup=$1 had_unit=$2 was_enabled=$3 was_active=$4
  set +e
  systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1
  if (( had_unit )); then
    install -m 0600 "$backup" "$TARGET_UNIT"
  else
    rm -f -- "$TARGET_UNIT"
  fi
  systemctl --user daemon-reload >/dev/null 2>&1
  if (( was_enabled )); then
    systemctl --user enable "$SERVICE_NAME" >/dev/null 2>&1
  else
    systemctl --user disable "$SERVICE_NAME" >/dev/null 2>&1
  fi
  if (( was_active )); then
    systemctl --user start "$SERVICE_NAME" >/dev/null 2>&1
  else
    systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1
  fi
  set -e
}

install_service() {
  local rendered backup had_unit=0 was_enabled=0 was_active=0 changed=1
  rendered=$(mktemp "${TMPDIR:-/tmp}/agent-runner-control.XXXXXX.service")
  backup=$(mktemp)
  trap 'rm -f -- "$rendered" "$backup"' RETURN
  render_unit "$rendered"
  validate_rendered_unit "$rendered"

  if [[ -f "$TARGET_UNIT" ]]; then
    had_unit=1
    cp -- "$TARGET_UNIT" "$backup"
    cmp -s -- "$rendered" "$TARGET_UNIT" && changed=0
  fi
  unit_enabled && was_enabled=1 || true
  unit_active && was_active=1 || true

  if (( changed == 0 )); then
    # Idempotent reinstall: never restart an already-running process. This
    # preserves the process-local authenticated session store.
    if (( was_enabled == 0 )); then
      systemctl --user enable "$SERVICE_NAME" >/dev/null
    fi
    if (( was_active == 0 )); then
      preflight_port_available || return 1
      systemctl --user start "$SERVICE_NAME"
    fi
    verify_installed_service || return 1
    printf 'UNCHANGED: %s is installed and healthy on %s:%s\n' "$SERVICE_NAME" "$FIXED_HOST" "$PORT"
    return 0
  fi

  # Validate before touching the installed unit. A changed active service is
  # stopped only after the replacement unit has passed static verification.
  if (( was_active )); then
    systemctl --user stop "$SERVICE_NAME"
  fi
  if ! preflight_port_available; then
    restore_previous_state "$backup" "$had_unit" "$was_enabled" "$was_active"
    return 1
  fi

  if ! mkdir -p -m 0700 -- "$TARGET_DIR" \
    || ! install -m 0600 "$rendered" "$TARGET_UNIT" \
    || ! systemctl --user daemon-reload \
    || ! systemctl --user enable "$SERVICE_NAME" >/dev/null \
    || ! systemctl --user restart "$SERVICE_NAME" \
    || ! verify_installed_service; then
    printf 'ERROR: activation or health verification failed; restoring previous service state\n' >&2
    restore_previous_state "$backup" "$had_unit" "$was_enabled" "$was_active"
    return 1
  fi
  printf 'INSTALLED: %s is enabled and healthy on %s:%s\n' "$SERVICE_NAME" "$FIXED_HOST" "$PORT"
}

enable_service() {
  [[ -f "$TARGET_UNIT" ]] || fail 'service is not installed; run install first'
  validate_rendered_unit "$TARGET_UNIT"
  if ! unit_active; then
    preflight_port_available || return 1
  fi
  systemctl --user enable "$SERVICE_NAME" >/dev/null
  if ! unit_active; then
    systemctl --user start "$SERVICE_NAME"
  fi
  verify_installed_service
  printf 'ENABLED: %s is healthy on %s:%s\n' "$SERVICE_NAME" "$FIXED_HOST" "$PORT"
}

disable_service() {
  systemctl --user disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  printf 'DISABLED: %s\n' "$SERVICE_NAME"
}

remove_service() {
  systemctl --user disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  if [[ -e "$TARGET_UNIT" ]]; then
    rm -f -- "$TARGET_UNIT"
    systemctl --user daemon-reload
  fi
  printf 'REMOVED: %s unit only; Agent Runner configuration and state were preserved\n' "$SERVICE_NAME"
}

case "$COMMAND" in
  install) install_service ;;
  verify) verify_installed_service; printf 'VERIFIED: %s is healthy on %s:%s\n' "$SERVICE_NAME" "$FIXED_HOST" "$PORT" ;;
  status) systemctl --user status "$SERVICE_NAME" --no-pager ;;
  enable) enable_service ;;
  disable) disable_service ;;
  remove) remove_service ;;
esac
