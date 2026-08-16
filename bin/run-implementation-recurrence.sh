#!/usr/bin/env bash
set -euo pipefail

# Generic serial implementation recurrence entrypoint (#210). Unlike
# bin/run-project.sh (which is bound to exactly one project's config), this
# wrapper loads the managed project registry, probes every *enabled* project
# and invokes bin/run-project.sh for at most one selected project per
# recurrence. It is the ExecStart target for the generic
# agent-runner-implementation.service/.timer unit definitions; it does not
# install, enable or disable any systemd unit itself.

if [ "$(id -u)" -eq 0 ]; then
  echo "[agent-runner] ERROR: refusing to run as root" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${AGENT_RUNNER_ENV_FILE:-$HOME/.config/agent-runner/runner.env}"
NODE_BIN="${AGENT_RUNNER_NODE_BIN:-node}"
RECURRENCE_SCRIPT="$ROOT/scripts/ops/agent-runner-implementation-recurrence.mjs"

[ -f "$RECURRENCE_SCRIPT" ] || {
  echo "[agent-runner] ERROR: generic implementation recurrence entrypoint is missing" >&2
  exit 1
}

load_env_file() {
  local file="$1" line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; export\ *) line="${line#export }" ;; esac
    case "$line" in
      [A-Za-z_]*=*)
        key="${line%%=*}"
        value="${line#*=}"
        case "$key" in *[!A-Za-z0-9_]*|'') echo "[agent-runner] ignoring invalid env key: $key" >&2; continue ;; esac
        if [[ "$value" == \"*\" && "$value" == *\" ]]; then value="${value:1:${#value}-2}"; fi
        if [[ "$value" == \'*\' && "$value" == *\' ]]; then value="${value:1:${#value}-2}"; fi
        export "$key=$value"
        ;;
      *) echo "[agent-runner] ignoring non-env line in $file" >&2 ;;
    esac
  done < "$file"
}

load_env_file "$ENV_FILE"
export PATH="/usr/local/bin:/opt/homebrew/bin:/opt/cpanel/ea-nodejs22/bin:$HOME/.local/bin:$HOME/bin:$PATH"

[ -n "${AGENT_RUNNER_PROJECT_REGISTRY:-}" ] || {
  echo "[agent-runner] ERROR: AGENT_RUNNER_PROJECT_REGISTRY is not configured" >&2
  exit 1
}

ARGS=()
if [ "${AGENT_RUNNER_EXECUTE:-false}" = "true" ]; then
  ARGS+=(--execute)
fi
if [ -n "${AGENT_RUNNER_ARGS:-}" ]; then
  # Compatibility input is operator-controlled and follows the existing runner arg contract.
  # shellcheck disable=SC2206
  EXTRA_ARGS=(${AGENT_RUNNER_ARGS:-})
  ARGS+=("${EXTRA_ARGS[@]}")
fi

cd "$ROOT"
exec "$NODE_BIN" "$RECURRENCE_SCRIPT" "${ARGS[@]}"
