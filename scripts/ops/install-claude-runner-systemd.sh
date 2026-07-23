#!/usr/bin/env bash
set -euo pipefail

# Install/sync the Claude runner as a systemd user timer.
# This is preferred over cron for Dell/local operation because it gives journalctl logs,
# persistent missed-run handling, and explicit user ownership.

if [ "$(id -u)" -eq 0 ]; then
  echo "[install-claude-runner-systemd] ERROR: do not run as root; run as the repo/operator user" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${MODELSPEND_REPO_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/modelspend"
ENV_FILE="${MODELSPEND_ENV_FILE:-$ENV_DIR/claude-runner.env}"
SERVICE_NAME="modelspend-claude-runner.service"
TIMER_NAME="modelspend-claude-runner.timer"
FIRST_DELAY="2min"
INTERVAL="10min"
RANDOM_DELAY="60s"
EXECUTE="false"
EXECUTE_EXPLICIT=0
ALLOW_IMPLEMENTATION="false"
ALLOW_IMPLEMENTATION_EXPLICIT=0
IMPLEMENTATION_APPROVERS_RAW=""
IMPLEMENTATION_APPROVERS=""
IMPLEMENTATION_APPROVERS_EXPLICIT=0
IMPLEMENTATION_PROVISIONING_REQUESTED=0
DRY_RUN=0
REMOVE=0
ENABLE_LINGER=0

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/ops/install-claude-runner-systemd.sh [options]

Options:
  --execute                        Set CLAUDE_RUNNER_CRON_EXECUTE=true.
  --allow-implementation           Explicitly enable implementation writes. Requires valid approvers.
  --implementation-approvers <csv> Set a normalized GitHub-login allowlist for implementation approval.
  --dry-run                        Describe intended files/commands without changing files or systemd state.
  --remove                         Disable/remove the user service and timer files.
  --interval <duration>            systemd OnUnitInactiveSec value, default 10min.
  --random-delay <duration>        systemd RandomizedDelaySec value, default 60s.
  --enable-linger                  Run loginctl enable-linger for this user when available.
  --help                           Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE="true"; EXECUTE_EXPLICIT=1; shift ;;
    --allow-implementation)
      ALLOW_IMPLEMENTATION="true"
      ALLOW_IMPLEMENTATION_EXPLICIT=1
      IMPLEMENTATION_PROVISIONING_REQUESTED=1
      shift
      ;;
    --implementation-approvers)
      if [ "$#" -lt 2 ] || [[ "${2:-}" == --* ]]; then
        echo "[install-claude-runner-systemd] ERROR: missing --implementation-approvers value" >&2
        exit 2
      fi
      IMPLEMENTATION_APPROVERS_RAW="$2"
      IMPLEMENTATION_APPROVERS_EXPLICIT=1
      IMPLEMENTATION_PROVISIONING_REQUESTED=1
      shift 2
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    --remove) REMOVE=1; shift ;;
    --interval) INTERVAL="${2:?missing --interval value}"; shift 2 ;;
    --random-delay) RANDOM_DELAY="${2:?missing --random-delay value}"; shift 2 ;;
    --enable-linger) ENABLE_LINGER=1; shift ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

info() { echo "[install-claude-runner-systemd] $*"; }
fail() { echo "[install-claude-runner-systemd] ERROR: $*" >&2; exit 1; }

git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "MODELSPEND_REPO_DIR is not a git repo: $REPO_DIR"
[ -x "$REPO_DIR/scripts/ops/jobs/run-claude-runner.sh" ] || fail "Runner wrapper is not executable: $REPO_DIR/scripts/ops/jobs/run-claude-runner.sh"
command -v systemctl >/dev/null 2>&1 || fail "systemctl not found"

service_content() {
  cat <<EOF
[Unit]
Description=ModelSpend Claude runner selector
Documentation=file://$REPO_DIR/docs/ops/CLAUDE-RUNNER.md

[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR
Environment=MODELSPEND_REPO_DIR=$REPO_DIR
Environment=MODELSPEND_ENV_FILE=$ENV_FILE
EnvironmentFile=-$ENV_FILE
ExecStart=/bin/bash $REPO_DIR/scripts/ops/jobs/run-claude-runner.sh
Nice=5
EOF
}

timer_content() {
  cat <<EOF
[Unit]
Description=Run ModelSpend Claude runner selector periodically

[Timer]
OnActiveSec=$FIRST_DELAY
OnUnitInactiveSec=$INTERVAL
RandomizedDelaySec=$RANDOM_DELAY
Persistent=false
Unit=$SERVICE_NAME

[Install]
WantedBy=timers.target
EOF
}

env_content() {
  cat <<EOF
# ModelSpend Claude runner environment.
# Keep secrets out of git. This file is loaded by the systemd user service wrapper.
MODELSPEND_REPO_DIR=$REPO_DIR
CLAUDE_RUNNER_CRON_EXECUTE=$EXECUTE
CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=$ALLOW_IMPLEMENTATION
${IMPLEMENTATION_APPROVERS:+CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS=$IMPLEMENTATION_APPROVERS
}# Optional extra args, for example:
# CLAUDE_RUNNER_ARGS=--agent-labels agent:claude,agent:claude-code-cli
# GITHUB_TOKEN=github_pat_...
# GH_TOKEN=github_pat_...
# CLAUDE_BIN=/home/$(id -un)/.local/bin/claude
# Optional proxy settings, if the runner host needs them:
# HTTP_PROXY=http://proxy.example:8080
# HTTPS_PROXY=http://proxy.example:8080
# NO_PROXY=localhost,127.0.0.1
# For npm-specific proxy configuration, use npm_config_proxy/npm_config_https_proxy.
# Do not set npm_config_http_proxy; npm treats it as unknown config "http-proxy".
EOF
}

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

normalize_approvers() {
  local remaining="$1"
  local entry login normalized="" done=0
  local -A seen=()

  [ -n "$(trim_whitespace "$remaining")" ] || return 1

  while [ "$done" -eq 0 ]; do
    if [[ "$remaining" == *,* ]]; then
      entry="${remaining%%,*}"
      remaining="${remaining#*,}"
    else
      entry="$remaining"
      done=1
    fi

    entry="$(trim_whitespace "$entry")"
    [ -n "$entry" ] || return 1
    login="${entry,,}"

    [[ "$login" =~ ^[a-z0-9][a-z0-9-]{0,38}$ ]] || return 1
    [[ "$login" != *--* && "$login" != *- ]] || return 1

    if [ -z "${seen[$login]+set}" ]; then
      seen[$login]=1
      if [ -n "$normalized" ]; then
        normalized+=","
      fi
      normalized+="$login"
    fi
  done

  [ -n "$normalized" ] || return 1
  printf '%s' "$normalized"
}

env_value() {
  local key="$1"
  local file="$2"

  [ -f "$file" ] || return 0
  awk -v target_key="$key" '
    {
      probe = $0
      sub(/^[[:space:]]*/, "", probe)
      sub(/^export[[:space:]]+/, "", probe)
      if (probe ~ ("^" target_key "[[:space:]]*=")) {
        sub(("^" target_key "[[:space:]]*=[[:space:]]*"), "", probe)
        value = probe
        found = 1
      }
    }
    END { if (found) print value }
  ' "$file"
}

env_key_count() {
  local key="$1"
  local file="$2"

  [ -f "$file" ] || { printf '0'; return 0; }
  awk -v target_key="$key" '
    {
      probe = $0
      sub(/^[[:space:]]*/, "", probe)
      sub(/^export[[:space:]]+/, "", probe)
      if (probe ~ ("^" target_key "[[:space:]]*=")) count += 1
    }
    END { print count + 0 }
  ' "$file"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local file="$3"
  local mode tmp file_dir

  mode="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file")"
  file_dir="$(dirname "$file")"
  tmp="$(mktemp "$file_dir/.claude-runner.env.XXXXXX")"

  awk -v target_key="$key" -v target_value="$value" '
    BEGIN { seen = 0 }
    {
      original = $0
      probe = $0
      sub(/^[[:space:]]*/, "", probe)
      sub(/^export[[:space:]]+/, "", probe)
      if (probe ~ ("^" target_key "[[:space:]]*=")) {
        if (!seen) print target_key "=" target_value
        seen = 1
        next
      }
      print original
    }
    END {
      if (!seen) print target_key "=" target_value
    }
  ' "$file" > "$tmp"

  chmod "$mode" "$tmp"
  mv "$tmp" "$file"
}


remove_env_key() {
  local key="$1"
  local file="$2"
  local mode tmp file_dir

  [ -f "$file" ] || return 0
  mode="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file")"
  file_dir="$(dirname "$file")"
  tmp="$(mktemp "$file_dir/.claude-runner.env.XXXXXX")"

  awk -v target_key="$key" '''
    {
      original = $0
      probe = $0
      sub(/^[[:space:]]*/, "", probe)
      sub(/^export[[:space:]]+/, "", probe)
      if (probe ~ ("^" target_key "[[:space:]]*=")) next
      print original
    }
  ''' "$file" > "$tmp"

  chmod "$mode" "$tmp"
  mv "$tmp" "$file"
}

verify_env_value() {
  local key="$1"
  local expected="$2"
  local file="$3"
  local count actual

  count="$(env_key_count "$key" "$file")"
  [ "$count" -eq 1 ] || fail "could not verify one effective $key entry in $file"
  actual="$(env_value "$key" "$file")"
  [ "$actual" = "$expected" ] || fail "could not verify requested $key in $file"
}

conflicting_dropins() {
  local dropin_dir="$UNIT_DIR/$SERVICE_NAME.d"

  [ -d "$dropin_dir" ] || return 0
  grep -RIlE '^[[:space:]]*(EnvironmentFile=|Environment=.*(MODELSPEND_ENV_FILE|CLAUDE_RUNNER_CRON_EXECUTE|CLAUDE_RUNNER_ALLOW_IMPLEMENTATION|CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS)=)' \
    "$dropin_dir" 2>/dev/null || true
}

scheduled_value_present() {
  case "${1:-}" in
    ''|-|0|n/a|infinity) return 1 ;;
    *) return 0 ;;
  esac
}

verify_timer_scheduled() {
  local next_realtime next_monotonic

  systemctl --user is-active --quiet "$TIMER_NAME" || fail "$TIMER_NAME is not active after restart"

  next_realtime="$(systemctl --user show "$TIMER_NAME" --property=NextElapseUSecRealtime --value 2>/dev/null || true)"
  next_monotonic="$(systemctl --user show "$TIMER_NAME" --property=NextElapseUSecMonotonic --value 2>/dev/null || true)"

  if ! scheduled_value_present "$next_realtime" && ! scheduled_value_present "$next_monotonic"; then
    fail "$TIMER_NAME is active but has no next trigger"
  fi
}

if [ "$REMOVE" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    info "--dry-run: would disable/remove $TIMER_NAME and $SERVICE_NAME from $UNIT_DIR"
    exit 0
  fi
  systemctl --user disable --now "$TIMER_NAME" 2>/dev/null || true
  rm -f "$UNIT_DIR/$SERVICE_NAME" "$UNIT_DIR/$TIMER_NAME"
  systemctl --user daemon-reload
  info "Removed $SERVICE_NAME and $TIMER_NAME"
  exit 0
fi

if [ "$IMPLEMENTATION_APPROVERS_EXPLICIT" -eq 1 ]; then
  if ! IMPLEMENTATION_APPROVERS="$(normalize_approvers "$IMPLEMENTATION_APPROVERS_RAW")"; then
    fail "--implementation-approvers must be a non-empty comma-separated list of valid GitHub logins"
  fi
elif [ "$ALLOW_IMPLEMENTATION_EXPLICIT" -eq 1 ]; then
  [ -f "$ENV_FILE" ] || fail "--allow-implementation requires --implementation-approvers when no env file exists"
  EXISTING_APPROVERS="$(env_value "CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS" "$ENV_FILE")"
  if ! IMPLEMENTATION_APPROVERS="$(normalize_approvers "$EXISTING_APPROVERS")"; then
    fail "--allow-implementation requires a valid existing or explicitly supplied implementation approver list"
  fi
fi

CONFLICTS="$(conflicting_dropins)"
if [ -n "$CONFLICTS" ]; then
  printf '%s\n' "$CONFLICTS" >&2
  fail "service drop-ins override the runner env/execute contract; remove or quarantine the files listed above"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  info "--dry-run: would write $UNIT_DIR/$SERVICE_NAME"
  service_content
  info "--dry-run: would write $UNIT_DIR/$TIMER_NAME"
  timer_content
  if [ -f "$ENV_FILE" ]; then
    if [ "$EXECUTE_EXPLICIT" -eq 1 ]; then
      info "--dry-run: would set CLAUDE_RUNNER_CRON_EXECUTE=true without changing unrelated env entries"
    else
      info "--dry-run: would keep the scheduler execution setting in existing $ENV_FILE"
    fi
    if [ "$IMPLEMENTATION_PROVISIONING_REQUESTED" -eq 1 ]; then
      info "--dry-run: would configure the explicit implementation gate and normalized approvers"
    fi
  else
    info "--dry-run: would create $ENV_FILE without printing its contents"
  fi
  info "--dry-run: would run daemon-reload, enable, restart, and verify a next trigger for $TIMER_NAME"
  exit 0
fi

install -d -m 0755 "$UNIT_DIR" "$ENV_DIR" "$(dirname "$ENV_FILE")"
printf '%s\n' "$(service_content)" > "$UNIT_DIR/$SERVICE_NAME"
printf '%s\n' "$(timer_content)" > "$UNIT_DIR/$TIMER_NAME"

if [ ! -f "$ENV_FILE" ]; then
  umask 077
  env_content > "$ENV_FILE"
  info "Created $ENV_FILE"
else
  if [ "$EXECUTE_EXPLICIT" -eq 1 ]; then
    set_env_value "CLAUDE_RUNNER_CRON_EXECUTE" "true" "$ENV_FILE"
    info "Enabled scheduler execution in existing $ENV_FILE"
  fi
  if [ "$IMPLEMENTATION_PROVISIONING_REQUESTED" -eq 1 ]; then
    set_env_value "CLAUDE_RUNNER_ALLOW_IMPLEMENTATION" "$ALLOW_IMPLEMENTATION" "$ENV_FILE"
    set_env_value "CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS" "$IMPLEMENTATION_APPROVERS" "$ENV_FILE"
    info "Configured explicit implementation authorisation in existing $ENV_FILE"
  fi
  if [ "$EXECUTE_EXPLICIT" -eq 0 ] && [ "$IMPLEMENTATION_PROVISIONING_REQUESTED" -eq 0 ]; then
    info "Kept existing $ENV_FILE"
  fi
fi

remove_env_key "CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION" "$ENV_FILE"

if [ "$EXECUTE_EXPLICIT" -eq 1 ]; then
  verify_env_value "CLAUDE_RUNNER_CRON_EXECUTE" "true" "$ENV_FILE"
fi
if [ "$IMPLEMENTATION_PROVISIONING_REQUESTED" -eq 1 ]; then
  verify_env_value "CLAUDE_RUNNER_ALLOW_IMPLEMENTATION" "$ALLOW_IMPLEMENTATION" "$ENV_FILE"
  verify_env_value "CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS" "$IMPLEMENTATION_APPROVERS" "$ENV_FILE"
fi

systemctl --user daemon-reload
systemctl --user enable "$TIMER_NAME"
systemctl --user restart "$TIMER_NAME"
verify_timer_scheduled

if [ "$ENABLE_LINGER" -eq 1 ]; then
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$(id -un)" || info "Could not enable linger automatically; run: sudo loginctl enable-linger $(id -un)"
  else
    info "loginctl not found; skipping linger"
  fi
fi

info "Installed and scheduled systemd user timer: $TIMER_NAME"
info "Status: systemctl --user status $TIMER_NAME $SERVICE_NAME --no-pager"
info "Logs:   journalctl --user -u $SERVICE_NAME -n 100 --no-pager"
