#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/install-event-ingress-transport.sh install \
    --agent-runner-home /absolute/path/to/agent-runner \
    --project-registry /absolute/path/to/projects.json \
    --controller-db /absolute/path/to/controller.sqlite \
    --secret-file /absolute/path/to/webhook-secret \
    [--enable]

  scripts/install-event-ingress-transport.sh rollback \
    --backup-dir /absolute/path/to/backup

The installer never creates a webhook secret, changes Nginx/TLS/DNS/firewall,
or configures a GitHub webhook.
USAGE
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

[[ "$(id -u)" -ne 0 ]] || fail 'do not run this installer as root'
ACTION="${1:-}"
[[ "$ACTION" == "install" || "$ACTION" == "rollback" ]] || { usage >&2; exit 2; }
shift

AGENT_RUNNER_HOME=""
PROJECT_REGISTRY=""
CONTROLLER_DB=""
SECRET_FILE=""
BACKUP_DIR=""
ENABLE=0

while (($#)); do
  case "$1" in
    --agent-runner-home) AGENT_RUNNER_HOME="${2:-}"; shift 2 ;;
    --project-registry) PROJECT_REGISTRY="${2:-}"; shift 2 ;;
    --controller-db) CONTROLLER_DB="${2:-}"; shift 2 ;;
    --secret-file) SECRET_FILE="${2:-}"; shift 2 ;;
    --backup-dir) BACKUP_DIR="${2:-}"; shift 2 ;;
    --enable) ENABLE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

UNIT_DIR="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config/agent-runner"
STATE_ROOT="$HOME/.local/state/agent-runner/event-transport"
SERVICE_TARGET="$UNIT_DIR/agent-runner-event-ingress.service"
SOCKET_TARGET="$UNIT_DIR/agent-runner-event-ingress.socket"
ENV_TARGET="$ENV_DIR/event-ingress-transport.env"
MANIFEST_NAME="restore.tsv"
STATE_NAME="unit-state.env"

restore_backup() {
  local directory="$1"
  local manifest="$directory/$MANIFEST_NAME"
  local state_file="$directory/$STATE_NAME"
  [[ -d "$directory" ]] || fail 'backup directory does not exist'
  [[ -f "$manifest" && -f "$state_file" ]] || fail 'backup manifest is incomplete'

  systemctl --user stop agent-runner-event-ingress.socket 2>/dev/null || true
  systemctl --user stop agent-runner-event-ingress.service 2>/dev/null || true

  while IFS=$'\t' read -r state path copy; do
    [[ -n "$path" ]] || continue
    if [[ "$state" == "present" ]]; then
      mkdir -p "$(dirname "$path")"
      cp -a "$copy" "$path"
    elif [[ "$state" == "absent" ]]; then
      rm -f "$path"
    else
      fail 'backup manifest contains an invalid state'
    fi
  done <"$manifest"

  # shellcheck disable=SC1090
  source "$state_file"
  systemctl --user daemon-reload
  if [[ "${PREVIOUS_SOCKET_ENABLED:-disabled}" == "enabled" ]]; then
    systemctl --user enable agent-runner-event-ingress.socket
  else
    systemctl --user disable agent-runner-event-ingress.socket 2>/dev/null || true
  fi
  if [[ "${PREVIOUS_SOCKET_ACTIVE:-inactive}" == "active" ]]; then
    systemctl --user start agent-runner-event-ingress.socket
  fi
  if [[ "${PREVIOUS_SERVICE_ACTIVE:-inactive}" == "active" ]]; then
    systemctl --user start agent-runner-event-ingress.service
  fi
  printf 'rollback_backup=%s\n' "$directory"
  printf 'rollback_complete=true\n'
}

if [[ "$ACTION" == "rollback" ]]; then
  [[ -n "$BACKUP_DIR" && "$BACKUP_DIR" = /* ]] || fail '--backup-dir must be absolute'
  restore_backup "$(realpath "$BACKUP_DIR")"
  exit 0
fi

[[ -n "$AGENT_RUNNER_HOME" ]] || fail '--agent-runner-home is required'
[[ -n "$PROJECT_REGISTRY" ]] || fail '--project-registry is required'
[[ -n "$CONTROLLER_DB" ]] || fail '--controller-db is required'
[[ -n "$SECRET_FILE" ]] || fail '--secret-file is required'
for value in "$AGENT_RUNNER_HOME" "$PROJECT_REGISTRY" "$CONTROLLER_DB" "$SECRET_FILE"; do
  [[ "$value" = /* ]] || fail 'all supplied paths must be absolute'
done

AGENT_RUNNER_HOME="$(realpath "$AGENT_RUNNER_HOME")"
PROJECT_REGISTRY="$(realpath "$PROJECT_REGISTRY")"
SECRET_FILE="$(realpath "$SECRET_FILE")"
CONTROLLER_DB="$(realpath -m "$CONTROLLER_DB")"

[[ -d "$AGENT_RUNNER_HOME/.git" ]] || fail 'agent runner home is not a git checkout'
[[ -f "$AGENT_RUNNER_HOME/scripts/ops/agent-runner-event-transport.mjs" ]] || fail 'event transport source is missing'
[[ -f "$AGENT_RUNNER_HOME/systemd/user/agent-runner-event-ingress.service" ]] || fail 'event ingress service unit is missing'
[[ -f "$AGENT_RUNNER_HOME/systemd/user/agent-runner-event-ingress.socket" ]] || fail 'event ingress socket unit is missing'
[[ -f "$PROJECT_REGISTRY" ]] || fail 'project registry is missing'
[[ -f "$SECRET_FILE" ]] || fail 'webhook secret file is missing'
command -v node >/dev/null 2>&1 || fail 'node is not installed'
command -v systemctl >/dev/null 2>&1 || fail 'systemctl is not installed'

mkdir -p "$(dirname "$CONTROLLER_DB")" "$UNIT_DIR" "$ENV_DIR" "$STATE_ROOT/backups"
chmod 700 "$ENV_DIR" "$STATE_ROOT" "$STATE_ROOT/backups" "$(dirname "$CONTROLLER_DB")"

node --input-type=module - "$AGENT_RUNNER_HOME" "$PROJECT_REGISTRY" "$SECRET_FILE" <<'NODE'
import { pathToFileURL } from 'node:url';
const [home, registryPath, secretPath] = process.argv.slice(2);
const registryModule = await import(pathToFileURL(`${home}/scripts/ops/agent-runner-project-registry.mjs`));
const transportModule = await import(pathToFileURL(`${home}/scripts/ops/agent-runner-event-transport.mjs`));
const registry = registryModule.loadProjectRegistry({ registryPath });
if (!registry.projects.length) throw new Error('registry has no enabled projects');
transportModule.loadWebhookSecret(secretPath);
NODE

node "$AGENT_RUNNER_HOME/scripts/ops/agent-runner-event-transport.mjs" --help >/dev/null

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$STATE_ROOT/backups/$STAMP"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
MANIFEST="$BACKUP_DIR/$MANIFEST_NAME"
: >"$MANIFEST"
chmod 600 "$MANIFEST"

backup_path() {
  local path="$1"
  local key copy
  key="$(printf '%s' "$path" | sha256sum | awk '{print $1}')"
  copy="$BACKUP_DIR/$key"
  if [[ -e "$path" ]]; then
    cp -a "$path" "$copy"
    printf 'present\t%s\t%s\n' "$path" "$copy" >>"$MANIFEST"
  else
    printf 'absent\t%s\t-\n' "$path" >>"$MANIFEST"
  fi
}

backup_path "$SERVICE_TARGET"
backup_path "$SOCKET_TARGET"
backup_path "$ENV_TARGET"

PREVIOUS_SOCKET_ENABLED="$(systemctl --user is-enabled agent-runner-event-ingress.socket 2>/dev/null || true)"
PREVIOUS_SOCKET_ACTIVE="$(systemctl --user is-active agent-runner-event-ingress.socket 2>/dev/null || true)"
PREVIOUS_SERVICE_ACTIVE="$(systemctl --user is-active agent-runner-event-ingress.service 2>/dev/null || true)"
cat >"$BACKUP_DIR/$STATE_NAME" <<EOF_STATE
PREVIOUS_SOCKET_ENABLED=$(printf '%q' "$PREVIOUS_SOCKET_ENABLED")
PREVIOUS_SOCKET_ACTIVE=$(printf '%q' "$PREVIOUS_SOCKET_ACTIVE")
PREVIOUS_SERVICE_ACTIVE=$(printf '%q' "$PREVIOUS_SERVICE_ACTIVE")
EOF_STATE
chmod 600 "$BACKUP_DIR/$STATE_NAME"

install -m 0644 "$AGENT_RUNNER_HOME/systemd/user/agent-runner-event-ingress.service" "$SERVICE_TARGET"
install -m 0644 "$AGENT_RUNNER_HOME/systemd/user/agent-runner-event-ingress.socket" "$SOCKET_TARGET"

umask 077
cat >"$ENV_TARGET" <<EOF_ENV
AGENT_RUNNER_HOME=$AGENT_RUNNER_HOME
AGENT_RUNNER_PROJECT_REGISTRY=$PROJECT_REGISTRY
AGENT_RUNNER_CONTROLLER_DB=$CONTROLLER_DB
AGENT_RUNNER_GITHUB_WEBHOOK_SECRET_FILE=$SECRET_FILE
AGENT_RUNNER_WEBHOOK_MAX_BODY_BYTES=1048576
EOF_ENV
chmod 600 "$ENV_TARGET"

systemctl --user daemon-reload
if [[ "$ENABLE" -eq 1 ]]; then
  systemctl --user enable --now agent-runner-event-ingress.socket
  for _ in $(seq 1 30); do
    if node - <<'NODE'
import http from 'node:http';
const request = http.get('http://127.0.0.1:8787/healthz', { timeout: 1000 }, (response) => {
  response.resume();
  process.exit(response.statusCode === 200 ? 0 : 1);
});
request.on('timeout', () => request.destroy(new Error('timeout')));
request.on('error', () => process.exit(1));
NODE
    then
      break
    fi
    sleep 1
  done
  node - <<'NODE'
import http from 'node:http';
const request = http.get('http://127.0.0.1:8787/healthz', { timeout: 2000 }, (response) => {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { process.exit(1); }
    process.exit(response.statusCode === 200 && body?.status === 'ok' ? 0 : 1);
  });
});
request.on('timeout', () => request.destroy(new Error('timeout')));
request.on('error', () => process.exit(1));
NODE
fi

printf 'agent_runner_home=%s\n' "$AGENT_RUNNER_HOME"
printf 'project_registry=%s\n' "$PROJECT_REGISTRY"
printf 'controller_db=%s\n' "$CONTROLLER_DB"
printf 'secret_file_mode=%s\n' "$(stat -c '%a' "$SECRET_FILE")"
printf 'backup_dir=%s\n' "$BACKUP_DIR"
printf 'socket_enabled=%s\n' "$(systemctl --user is-enabled agent-runner-event-ingress.socket 2>/dev/null || true)"
printf 'socket_active=%s\n' "$(systemctl --user is-active agent-runner-event-ingress.socket 2>/dev/null || true)"
printf 'service_active=%s\n' "$(systemctl --user is-active agent-runner-event-ingress.service 2>/dev/null || true)"
printf 'rollback_command=%q rollback --backup-dir %q\n' "$0" "$BACKUP_DIR"
