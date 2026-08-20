#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME='agent-runner-control.service'
DEFAULT_PORT='8789'
RESERVED_EVENT_INGRESS_PORT='8787'
FIXED_HOST='127.0.0.1'
CANONICAL_ORIGIN_SSH='git@github.com:TheTekTeam/agent-runner.git'
CANONICAL_ORIGIN_HTTPS='https://github.com/TheTekTeam/agent-runner.git'
MINIMUM_NODE_MAJOR=22
MINIMUM_NODE_MINOR=23

usage() {
  cat <<'USAGE'
Usage: scripts/install-control-dashboard.sh <install|verify|status|enable|disable|remove> [--port PORT]

Installs and manages only the Agent Runner authenticated control dashboard user service.
The bind address is fixed at 127.0.0.1 and PORT defaults to 8789.
Port 8787 is reserved for Agent Runner event ingress and is always rejected.
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
  (( 10#$value != 10#$RESERVED_EVENT_INGRESS_PORT )) || fail "port $RESERVED_EVENT_INGRESS_PORT is reserved for event ingress"
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
CONTROL_CONFIG_DIR="$HOME/.config/agent-runner"
CONTROL_STATE_ROOT="$HOME/.local/state/agent-runner"
CONTROL_SECRET_DIR="$CONTROL_STATE_ROOT/secrets"
CONTROL_AUDIT_FILE="$CONTROL_STATE_ROOT/control-audit.jsonl"
NODE_BIN=$(command -v node || true)
NODE_BIN=${NODE_BIN:+$(readlink -f -- "$NODE_BIN")}
CHECKOUT_TOP=$(git -C "$CHECKOUT" rev-parse --show-toplevel 2>/dev/null || true)
CHECKOUT_ORIGIN=$(git -C "$CHECKOUT" remote get-url origin 2>/dev/null || true)
NODE_VERSION=$($NODE_BIN --eval 'process.stdout.write(process.versions.node)' 2>/dev/null || true)

[[ -f "$SOURCE_UNIT" ]] || fail "repository service source is missing: $SOURCE_UNIT"
[[ -f "$SERVER" ]] || fail "control server is missing: $SERVER"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail 'node executable is unavailable'
[[ "$CHECKOUT_TOP" == "$CHECKOUT" ]] || fail 'installer must run from the canonical Agent Runner Git checkout root'
[[ "$CHECKOUT_ORIGIN" == "$CANONICAL_ORIGIN_SSH" || "$CHECKOUT_ORIGIN" == "$CANONICAL_ORIGIN_HTTPS" ]] \
  || fail 'checkout origin is not the canonical Agent Runner repository'
if [[ ! "$NODE_VERSION" =~ ^([0-9]+)\.([0-9]+)\.[0-9]+$ ]] \
  || (( 10#${BASH_REMATCH[1]} < MINIMUM_NODE_MAJOR )) \
  || (( 10#${BASH_REMATCH[1]} == MINIMUM_NODE_MAJOR && 10#${BASH_REMATCH[2]} < MINIMUM_NODE_MINOR )); then
  fail 'Node.js 22.23.0 or newer is required'
fi
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
  local -a expected_environment=(
    'Environment=NODE_OPTIONS=--jitless'
    'Environment=AGENT_RUNNER_CONFIG=%h/.config/agent-runner/modelspend.json'
    'Environment=CLAUDE_RUNNER_OUTPUT_DIR=%h/.local/state/agent-runner/modelspend'
    'Environment=CLAUDE_RUNNER_STATE_DB=%h/.local/state/agent-runner/modelspend/runner-state.sqlite'
    'Environment=AGENT_RUNNER_AGENT_SETTINGS_PATH=%h/.config/agent-runner/agent-settings.json'
    'Environment=AGENT_RUNNER_SECRET_STORE_DIR=%h/.local/state/agent-runner/secrets'
    'Environment=AGENT_RUNNER_CONTROL_OPERATOR_PATH=%h/.local/state/agent-runner/control-operator.json'
    'Environment=AGENT_RUNNER_CONTROL_AUDIT_PATH=%h/.local/state/agent-runner/control-audit.jsonl'
    'Environment=AGENT_RUNNER_CONTROL_SCHEDULER_SERVICE=agent-runner-implementation.service'
    'Environment=AGENT_RUNNER_CONTROL_SCHEDULER_TIMER=agent-runner-implementation.timer'
  )
  local assignment
  for assignment in "${expected_environment[@]}"; do
    grep -Fqx "$assignment" "$unit" || { printf 'ERROR: required service environment assignment is missing\n' >&2; return 1; }
  done
  if grep -Eq '^EnvironmentFile=' "$unit"; then
    printf 'ERROR: environment files are forbidden in the control service\n' >&2
    return 1
  fi
  if [[ $(grep -Ec '^Environment=' "$unit") -ne ${#expected_environment[@]} ]]; then
    printf 'ERROR: unexpected service environment assignment\n' >&2
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

probe_unit_enabled_state() {
  local output rc
  if output=$(systemctl --user is-enabled "$SERVICE_NAME" 2>/dev/null); then rc=0; else rc=$?; fi
  case "$output" in
    enabled|enabled-runtime|linked|linked-runtime|alias) printf 'enabled\n' ;;
    disabled|disabled-runtime|masked|masked-runtime|static|indirect|generated|transient) printf 'disabled\n' ;;
    *) printf 'ERROR: could not determine whether %s is enabled (status %s)\n' "$SERVICE_NAME" "$rc" >&2; return 1 ;;
  esac
}

probe_unit_active_state() {
  local output rc
  if output=$(systemctl --user is-active "$SERVICE_NAME" 2>/dev/null); then rc=0; else rc=$?; fi
  case "$output" in
    active) printf 'active\n' ;;
    inactive|failed) printf 'inactive\n' ;;
    *) printf 'ERROR: could not determine whether %s is active (status %s)\n' "$SERVICE_NAME" "$rc" >&2; return 1 ;;
  esac
}

listener_lines() {
  ss -H -ltn "sport = :$PORT" 2>/dev/null
}

preflight_port_available() {
  local listeners
  if ! listeners=$(listener_lines); then
    printf 'ERROR: could not inspect TCP listeners; refusing activation\n' >&2
    return 1
  fi
  if [[ -n "$listeners" ]]; then
    printf 'ERROR: port %s is already in use; refusing activation\n' "$PORT" >&2
    return 1
  fi
}

verify_exact_listener() {
  local listeners
  local -a locals=()
  if ! listeners=$(listener_lines); then
    printf 'ERROR: could not inspect the control-service listener\n' >&2
    return 1
  fi
  mapfile -t locals < <(awk '{print $4}' <<<"$listeners")
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
  local response
  if ! response=$(curl --fail --silent --show-error --include --noproxy '*' \
    --connect-timeout 2 --max-time 5 --max-filesize 262144 \
    --request GET "http://$FIXED_HOST:$PORT/"); then
    return 1
  fi
  grep -Eiq '^Content-Security-Policy:' <<<"$response" \
    && grep -Fq '<title>Agent Runner — Operations</title>' <<<"$response"
}

verify_installed_service() {
  local active_state
  if [[ ! -f "$TARGET_UNIT" ]]; then
    printf 'ERROR: service is not installed: %s\n' "$TARGET_UNIT" >&2
    return 1
  fi
  validate_rendered_unit "$TARGET_UNIT" || return 1
  active_state=$(probe_unit_active_state) || return 1
  if [[ "$active_state" != active ]]; then
    printf 'ERROR: %s is not active\n' "$SERVICE_NAME" >&2
    return 1
  fi
  verify_exact_listener || return 1
  verify_shell_health || return 1
}

ensure_private_directory() {
  local directory=$1
  if [[ -L "$directory" ]]; then
    printf 'ERROR: refusing symlink for writable control directory: %s\n' "$directory" >&2
    return 1
  fi
  if [[ -e "$directory" ]]; then
    [[ -d "$directory" ]] || { printf 'ERROR: writable control path is not a directory: %s\n' "$directory" >&2; return 1; }
    return 0
  fi
  mkdir -m 0700 -- "$directory"
}

validate_unit_target_path() {
  local component
  for component in "$HOME/.config" "$HOME/.config/systemd" "$TARGET_DIR"; do
    if [[ -L "$component" ]]; then
      printf 'ERROR: refusing symlink in control-service unit path: %s\n' "$component" >&2
      return 1
    fi
    if [[ -e "$component" && ! -d "$component" ]]; then
      printf 'ERROR: control-service unit path component is not a directory: %s\n' "$component" >&2
      return 1
    fi
  done
  if [[ -L "$TARGET_UNIT" ]]; then
    printf 'ERROR: refusing symlink for control-service unit: %s\n' "$TARGET_UNIT" >&2
    return 1
  fi
  if [[ -e "$TARGET_UNIT" && ! -f "$TARGET_UNIT" ]]; then
    printf 'ERROR: control-service unit target is not a regular file: %s\n' "$TARGET_UNIT" >&2
    return 1
  fi
}

provision_unit_target_path() {
  validate_unit_target_path || return 1
  ensure_private_directory "$HOME/.config" || return 1
  ensure_private_directory "$HOME/.config/systemd" || return 1
  ensure_private_directory "$TARGET_DIR" || return 1
}

provision_writable_paths() {
  # The hardened mount namespace requires these exact paths to exist before
  # service start. Bootstrap their standard parent directories one component
  # at a time so a fresh home works without following a symlinked component.
  # Never create/rotate the operator credential or touch execution state.
  ensure_private_directory "$HOME/.config" || return 1
  ensure_private_directory "$HOME/.local" || return 1
  ensure_private_directory "$HOME/.local/state" || return 1
  ensure_private_directory "$CONTROL_CONFIG_DIR" || return 1
  ensure_private_directory "$CONTROL_STATE_ROOT" || return 1
  ensure_private_directory "$CONTROL_SECRET_DIR" || return 1
  if [[ -L "$CONTROL_AUDIT_FILE" ]]; then
    printf 'ERROR: refusing symlink for control audit file: %s\n' "$CONTROL_AUDIT_FILE" >&2
    return 1
  fi
  if [[ -e "$CONTROL_AUDIT_FILE" ]]; then
    [[ -f "$CONTROL_AUDIT_FILE" ]] || { printf 'ERROR: control audit path is not a regular file: %s\n' "$CONTROL_AUDIT_FILE" >&2; return 1; }
  else
    install -m 0600 /dev/null "$CONTROL_AUDIT_FILE"
  fi
}

restore_previous_state() {
  local backup=$1 had_unit=$2 was_enabled=$3 was_active=$4 rc=0 enabled_state active_state
  set +e
  if ! systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1; then
    set -e
    return 1
  fi
  active_state=$(probe_unit_active_state) || rc=1
  if [[ "$active_state" != inactive ]]; then
    set -e
    return 1
  fi
  if (( had_unit )); then
    install -m 0600 "$backup" "$TARGET_UNIT" || rc=1
  else
    rm -f -- "$TARGET_UNIT" || rc=1
  fi
  systemctl --user daemon-reload >/dev/null 2>&1 || rc=1
  if (( was_enabled )); then
    systemctl --user enable "$SERVICE_NAME" >/dev/null 2>&1 || rc=1
  else
    systemctl --user disable "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
  if (( was_active )); then
    systemctl --user start "$SERVICE_NAME" >/dev/null 2>&1 || rc=1
  else
    systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
  enabled_state=$(probe_unit_enabled_state) || rc=1
  active_state=$(probe_unit_active_state) || rc=1
  if (( was_enabled )); then [[ "$enabled_state" == enabled ]] || rc=1; else [[ "$enabled_state" == disabled ]] || rc=1; fi
  if (( was_active )); then [[ "$active_state" == active ]] || rc=1; else [[ "$active_state" == inactive ]] || rc=1; fi
  set -e
  return "$rc"
}

stop_and_disable_target() {
  local active_state enabled_state
  active_state=$(probe_unit_active_state) || return 1
  if [[ "$active_state" == active ]]; then
    systemctl --user stop "$SERVICE_NAME" >/dev/null || return 1
    active_state=$(probe_unit_active_state) || return 1
    if [[ "$active_state" != inactive ]]; then
      printf 'ERROR: %s remained active after stop\n' "$SERVICE_NAME" >&2
      return 1
    fi
  fi
  enabled_state=$(probe_unit_enabled_state) || return 1
  if [[ "$enabled_state" == enabled ]]; then
    systemctl --user disable "$SERVICE_NAME" >/dev/null || return 1
    enabled_state=$(probe_unit_enabled_state) || return 1
    if [[ "$enabled_state" != disabled ]]; then
      printf 'ERROR: %s remained enabled after disable\n' "$SERVICE_NAME" >&2
      return 1
    fi
  fi
}

install_service() {
  local rendered backup had_unit=0 was_enabled=0 was_active=0 changed=1 enabled_state active_state
  rendered=$(mktemp "${TMPDIR:-/tmp}/agent-runner-control.XXXXXX.service")
  backup=$(mktemp)
  trap 'rm -f -- "$rendered" "$backup"' RETURN
  render_unit "$rendered"
  validate_rendered_unit "$rendered"
  provision_unit_target_path

  if [[ -f "$TARGET_UNIT" ]]; then
    had_unit=1
    cp -- "$TARGET_UNIT" "$backup"
    cmp -s -- "$rendered" "$TARGET_UNIT" && changed=0
    enabled_state=$(probe_unit_enabled_state) || return 1
    active_state=$(probe_unit_active_state) || return 1
    if [[ "$enabled_state" == enabled ]]; then was_enabled=1; fi
    if [[ "$active_state" == active ]]; then was_active=1; fi
  fi

  # Static validation has completed. Provision only the exact writable paths
  # required for namespace setup before any activation or replacement.
  provision_writable_paths

  if (( changed == 0 )); then
    # Idempotent reinstall: never restart an already-running process. This
    # preserves the process-local authenticated session store.
    if { (( was_enabled == 0 )) && ! systemctl --user enable "$SERVICE_NAME" >/dev/null; } \
      || { (( was_active == 0 )) && { ! preflight_port_available || ! systemctl --user start "$SERVICE_NAME"; }; } \
      || ! verify_installed_service; then
      printf 'ERROR: unchanged service activation or health verification failed; restoring previous state\n' >&2
      restore_previous_state "$backup" "$had_unit" "$was_enabled" "$was_active" \
        || printf 'ERROR: rollback could not fully restore previous service state\n' >&2
      return 1
    fi
    printf 'UNCHANGED: %s is installed and healthy on %s:%s\n' "$SERVICE_NAME" "$FIXED_HOST" "$PORT"
    return 0
  fi

  # A changed active service is stopped only after the replacement unit has
  # passed static verification and writable-path provisioning has succeeded.
  if (( was_active )); then
    if ! systemctl --user stop "$SERVICE_NAME"; then
      systemctl --user start "$SERVICE_NAME" >/dev/null 2>&1 || true
      return 1
    fi
    if ! active_state=$(probe_unit_active_state) || [[ "$active_state" != inactive ]]; then
      printf 'ERROR: could not verify %s stopped before upgrade; restoring prior active state\n' "$SERVICE_NAME" >&2
      systemctl --user start "$SERVICE_NAME" >/dev/null 2>&1 || true
      active_state=$(probe_unit_active_state 2>/dev/null || true)
      [[ "$active_state" == active ]] || printf 'ERROR: prior active state could not be verified after failed upgrade preparation\n' >&2
      return 1
    fi
  fi
  if ! preflight_port_available; then
    restore_previous_state "$backup" "$had_unit" "$was_enabled" "$was_active" || printf 'ERROR: rollback could not fully restore previous service state\n' >&2
    return 1
  fi

  if ! install -m 0600 "$rendered" "$TARGET_UNIT" \
    || ! systemctl --user daemon-reload \
    || ! systemctl --user enable "$SERVICE_NAME" >/dev/null \
    || ! systemctl --user restart "$SERVICE_NAME" \
    || ! verify_installed_service; then
    printf 'ERROR: activation or health verification failed; restoring previous service state\n' >&2
    restore_previous_state "$backup" "$had_unit" "$was_enabled" "$was_active" || printf 'ERROR: rollback could not fully restore previous service state\n' >&2
    return 1
  fi
  printf 'INSTALLED: %s is enabled and healthy on %s:%s\n' "$SERVICE_NAME" "$FIXED_HOST" "$PORT"
}

enable_service() {
  local backup was_enabled=0 was_active=0 activation_failed=0 enabled_state active_state
  provision_unit_target_path
  [[ -f "$TARGET_UNIT" ]] || fail 'service is not installed; run install first'
  backup=$(mktemp)
  trap 'rm -f -- "$backup"' RETURN
  cp -- "$TARGET_UNIT" "$backup"
  validate_rendered_unit "$TARGET_UNIT"
  provision_writable_paths
  enabled_state=$(probe_unit_enabled_state) || return 1
  active_state=$(probe_unit_active_state) || return 1
  if [[ "$enabled_state" == enabled ]]; then was_enabled=1; fi
  if [[ "$active_state" == active ]]; then was_active=1; fi
  if (( was_active == 0 )); then
    preflight_port_available || return 1
  fi
  systemctl --user enable "$SERVICE_NAME" >/dev/null || activation_failed=1
  if (( activation_failed == 0 && was_active == 0 )); then
    systemctl --user start "$SERVICE_NAME" || activation_failed=1
  fi
  if (( activation_failed == 0 )); then
    verify_installed_service || activation_failed=1
  fi
  if (( activation_failed )); then
    printf 'ERROR: enable or health verification failed; restoring previous enabled/active state\n' >&2
    restore_previous_state "$backup" 1 "$was_enabled" "$was_active" \
      || printf 'ERROR: rollback could not fully restore previous service state\n' >&2
    return 1
  fi
  printf 'ENABLED: %s is healthy on %s:%s\n' "$SERVICE_NAME" "$FIXED_HOST" "$PORT"
}

disable_service() {
  stop_and_disable_target || fail "could not safely disable $SERVICE_NAME"
  printf 'DISABLED: %s\n' "$SERVICE_NAME"
}

remove_service() {
  local backup
  validate_unit_target_path
  stop_and_disable_target || fail "could not safely stop and disable $SERVICE_NAME; unit preserved"
  if [[ -e "$TARGET_UNIT" ]]; then
    backup=$(mktemp)
    cp -- "$TARGET_UNIT" "$backup"
    if ! rm -f -- "$TARGET_UNIT" || ! systemctl --user daemon-reload; then
      printf 'ERROR: unit removal/reload failed; restoring unit file\n' >&2
      install -m 0600 "$backup" "$TARGET_UNIT" >/dev/null 2>&1 || true
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      rm -f -- "$backup"
      return 1
    fi
    rm -f -- "$backup"
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
