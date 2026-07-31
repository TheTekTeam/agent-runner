#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/install-queue-triage-local-authority.sh \
    --agent-runner-home /absolute/path/to/agent-runner \
    --project-registry /absolute/path/to/projects.json \
    --authority-file /absolute/path/to/queue-triage-authority.json \
    [--controller-db /absolute/path/to/controller.sqlite] \
    [--enable]

Installs the combined polling/settlement/queue-triage user service configuration.
The installer does not create or edit the authority file or project configs.
USAGE
}

AGENT_RUNNER_HOME=""
PROJECT_REGISTRY=""
AUTHORITY_FILE=""
CONTROLLER_DB="${HOME}/.local/state/agent-runner/controller/controller.sqlite"
ENABLE=0

while (($#)); do
  case "$1" in
    --agent-runner-home) AGENT_RUNNER_HOME="${2:-}"; shift 2 ;;
    --project-registry) PROJECT_REGISTRY="${2:-}"; shift 2 ;;
    --authority-file) AUTHORITY_FILE="${2:-}"; shift 2 ;;
    --controller-db) CONTROLLER_DB="${2:-}"; shift 2 ;;
    --enable) ENABLE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

[[ "$(id -u)" -ne 0 ]] || fail 'do not run this installer as root'
[[ -n "$AGENT_RUNNER_HOME" ]] || fail '--agent-runner-home is required'
[[ -n "$PROJECT_REGISTRY" ]] || fail '--project-registry is required'
[[ -n "$AUTHORITY_FILE" ]] || fail '--authority-file is required'
[[ "$AGENT_RUNNER_HOME" = /* ]] || fail 'agent runner path must be absolute'
[[ "$PROJECT_REGISTRY" = /* ]] || fail 'project registry path must be absolute'
[[ "$AUTHORITY_FILE" = /* ]] || fail 'authority file path must be absolute'
[[ "$CONTROLLER_DB" = /* ]] || fail 'controller DB path must be absolute'

AGENT_RUNNER_HOME="$(realpath "$AGENT_RUNNER_HOME")"
PROJECT_REGISTRY="$(realpath "$PROJECT_REGISTRY")"
AUTHORITY_FILE="$(realpath "$AUTHORITY_FILE")"
SOURCE_SHA="$(git -C "$AGENT_RUNNER_HOME" rev-parse HEAD)"

[[ -d "$AGENT_RUNNER_HOME/.git" ]] || fail 'agent runner home is not a git checkout'
[[ -f "$AGENT_RUNNER_HOME/scripts/ops/agent-runner-queue-triage-local-authority.mjs" ]] || fail 'closed-loop command is missing'
[[ -f "$PROJECT_REGISTRY" ]] || fail 'project registry file is missing'
[[ -f "$AUTHORITY_FILE" ]] || fail 'authority file is missing'
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'checkout source SHA is invalid'
command -v node >/dev/null 2>&1 || fail 'node is not installed'
command -v gh >/dev/null 2>&1 || fail 'gh is not installed'
gh auth status >/dev/null 2>&1 || fail 'gh is not authenticated for the current user'

node --input-type=module - "$AGENT_RUNNER_HOME" "$PROJECT_REGISTRY" "$AUTHORITY_FILE" "$SOURCE_SHA" <<'NODE'
import { pathToFileURL } from 'node:url';

const [home, registryPath, authorityPath, sourceSha] = process.argv.slice(2);
const registryModule = await import(pathToFileURL(`${home}/scripts/ops/agent-runner-project-registry.mjs`));
const authorityModule = await import(pathToFileURL(`${home}/scripts/ops/agent-runner-queue-triage-local-authority.mjs`));
const registry = registryModule.loadProjectRegistry({ registryPath });
const authority = authorityModule.loadQueueTriageLocalAuthority(authorityPath);
if (!authority || authority.enabled !== true) throw new Error('authority file must be enabled');
if (authority.sourceSha !== sourceSha) throw new Error('authority sourceSha does not match checkout HEAD');
for (const projectId of authority.projectIds) {
  const project = registry.projectsById[projectId];
  if (!project) throw new Error(`authority project is not enabled in registry: ${projectId}`);
  if (project.queueTriage?.enabled !== true) throw new Error(`queueTriage is not enabled for project: ${projectId}`);
  if (!Number.isInteger(project.queueTriage.maxMutations) || project.queueTriage.maxMutations < 1) {
    throw new Error(`queueTriage mutations are disabled for project: ${projectId}`);
  }
}
NODE

node "$AGENT_RUNNER_HOME/scripts/ops/agent-runner-queue-triage-local-authority.mjs" --help >/dev/null

UNIT_SOURCE="$AGENT_RUNNER_HOME/systemd/user/agent-runner-event-polling.service"
UNIT_TARGET="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config/agent-runner"
STATE_DIR="$(dirname "$CONTROLLER_DB")"
AUTHORITY_ENV="$ENV_DIR/queue-triage-authority.env"
TRIAGE_STATE_DB="$STATE_DIR/queue-triage-local.sqlite"

mkdir -p "$UNIT_TARGET" "$ENV_DIR" "$STATE_DIR"
chmod 700 "$ENV_DIR" "$STATE_DIR"
install -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET/agent-runner-event-polling.service"

umask 077
cat >"$AUTHORITY_ENV" <<EOF_ENV
AGENT_RUNNER_QUEUE_TRIAGE_AUTHORITY=$AUTHORITY_FILE
AGENT_RUNNER_QUEUE_TRIAGE_SOURCE_SHA=$SOURCE_SHA
AGENT_RUNNER_QUEUE_TRIAGE_STATE_DB=$TRIAGE_STATE_DB
EOF_ENV
chmod 600 "$AUTHORITY_ENV"

systemctl --user daemon-reload
if [[ "$ENABLE" -eq 1 ]]; then
  systemctl --user enable agent-runner-event-polling.timer
  systemctl --user restart agent-runner-event-polling.timer
  systemctl --user start agent-runner-event-polling.service
fi

printf 'agent_runner_home=%s\n' "$AGENT_RUNNER_HOME"
printf 'project_registry=%s\n' "$PROJECT_REGISTRY"
printf 'authority_file=%s\n' "$AUTHORITY_FILE"
printf 'authority_sha256=%s\n' "$(sha256sum "$AUTHORITY_FILE" | awk '{print $1}')"
printf 'source_sha=%s\n' "$SOURCE_SHA"
printf 'controller_db=%s\n' "$CONTROLLER_DB"
printf 'queue_triage_state_db=%s\n' "$TRIAGE_STATE_DB"
printf 'timer_enabled=%s\n' "$(systemctl --user is-enabled agent-runner-event-polling.timer 2>/dev/null || true)"
printf 'timer_active=%s\n' "$(systemctl --user is-active agent-runner-event-polling.timer 2>/dev/null || true)"
printf 'service_result=%s\n' "$(systemctl --user show agent-runner-event-polling.service --property=Result --value 2>/dev/null || true)"
