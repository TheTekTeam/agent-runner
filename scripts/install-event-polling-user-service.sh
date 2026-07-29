#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/install-event-polling-user-service.sh \
    --agent-runner-home /absolute/path/to/agent-runner \
    --project-registry /absolute/path/to/projects.json \
    [--controller-db /absolute/path/to/controller.sqlite] \
    [--enable]

Installs the read-only GitHub polling/CI-settlement user service and timer.
No token or webhook secret is written by this script.
USAGE
}

AGENT_RUNNER_HOME=""
PROJECT_REGISTRY=""
CONTROLLER_DB="${HOME}/.local/state/agent-runner/controller/controller.sqlite"
ENABLE=0

while (($#)); do
  case "$1" in
    --agent-runner-home)
      AGENT_RUNNER_HOME="${2:-}"
      shift 2
      ;;
    --project-registry)
      PROJECT_REGISTRY="${2:-}"
      shift 2
      ;;
    --controller-db)
      CONTROLLER_DB="${2:-}"
      shift 2
      ;;
    --enable)
      ENABLE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

[[ -n "$AGENT_RUNNER_HOME" ]] || fail '--agent-runner-home is required'
[[ -n "$PROJECT_REGISTRY" ]] || fail '--project-registry is required'
[[ "$AGENT_RUNNER_HOME" = /* ]] || fail 'agent runner path must be absolute'
[[ "$PROJECT_REGISTRY" = /* ]] || fail 'project registry path must be absolute'
[[ "$CONTROLLER_DB" = /* ]] || fail 'controller DB path must be absolute'
[[ "$(id -u)" -ne 0 ]] || fail 'do not run this installer as root'

AGENT_RUNNER_HOME="$(realpath "$AGENT_RUNNER_HOME")"
PROJECT_REGISTRY="$(realpath "$PROJECT_REGISTRY")"
[[ -d "$AGENT_RUNNER_HOME/.git" ]] || fail 'agent runner home is not a git checkout'
[[ -f "$AGENT_RUNNER_HOME/scripts/ops/agent-runner-polling-controller-cycle.mjs" ]] || fail 'polling controller command is missing'
[[ -f "$PROJECT_REGISTRY" ]] || fail 'project registry file is missing'
command -v node >/dev/null 2>&1 || fail 'node is not installed'
command -v gh >/dev/null 2>&1 || fail 'gh is not installed'
gh auth status >/dev/null 2>&1 || fail 'gh is not authenticated for the current user'

UNIT_SOURCE="$AGENT_RUNNER_HOME/systemd/user"
UNIT_TARGET="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config/agent-runner"
STATE_DIR="$(dirname "$CONTROLLER_DB")"
ENV_FILE="$ENV_DIR/event-polling.env"

mkdir -p "$UNIT_TARGET" "$ENV_DIR" "$STATE_DIR"
chmod 700 "$ENV_DIR" "$STATE_DIR"

install -m 0644 \
  "$UNIT_SOURCE/agent-runner-event-polling.service" \
  "$UNIT_TARGET/agent-runner-event-polling.service"
install -m 0644 \
  "$UNIT_SOURCE/agent-runner-event-polling.timer" \
  "$UNIT_TARGET/agent-runner-event-polling.timer"

umask 077
cat >"$ENV_FILE" <<EOF
AGENT_RUNNER_HOME=$AGENT_RUNNER_HOME
AGENT_RUNNER_PROJECT_REGISTRY=$PROJECT_REGISTRY
AGENT_RUNNER_CONTROLLER_DB=$CONTROLLER_DB
EOF
chmod 600 "$ENV_FILE"

node "$AGENT_RUNNER_HOME/scripts/ops/agent-runner-event-controller-cycle.mjs" --help >/dev/null
node "$AGENT_RUNNER_HOME/scripts/ops/agent-runner-polling-controller-cycle.mjs" --help >/dev/null
systemctl --user daemon-reload

if [[ "$ENABLE" -eq 1 ]]; then
  systemctl --user enable --now agent-runner-event-polling.timer
  systemctl --user start agent-runner-event-polling.service
fi

printf 'agent_runner_home=%s\n' "$AGENT_RUNNER_HOME"
printf 'project_registry=%s\n' "$PROJECT_REGISTRY"
printf 'controller_db=%s\n' "$CONTROLLER_DB"
printf 'timer_enabled=%s\n' "$(systemctl --user is-enabled agent-runner-event-polling.timer 2>/dev/null || true)"
printf 'timer_active=%s\n' "$(systemctl --user is-active agent-runner-event-polling.timer 2>/dev/null || true)"
printf 'service_result=%s\n' "$(systemctl --user show agent-runner-event-polling.service --property=Result --value 2>/dev/null || true)"
