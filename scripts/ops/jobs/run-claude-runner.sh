#!/usr/bin/env bash
set -euo pipefail

# Scheduled job wrapper: guarded Claude runner selector.
# Runs as an ordinary repo/operator user via systemd user timer or cron. Do not run as root.
# Do not echo secrets.

if [ "$(id -u)" -eq 0 ]; then
  echo "[run-claude-runner] ERROR: refusing to run as root; run as the repo/operator user" >&2
  exit 1
fi

export PATH="/usr/local/bin:/opt/homebrew/bin:/opt/cpanel/ea-nodejs22/bin:$HOME/.local/bin:$HOME/bin:$PATH"

ENV_FILE="${MODELSPEND_ENV_FILE:-$HOME/.config/modelspend/claude-runner.env}"
REPO_DIR="${MODELSPEND_REPO_DIR:-$HOME/projects/modelspend}"

load_env_file() {
  local env_file="$1"
  local line key value

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"

    [ -z "$line" ] && continue
    case "$line" in
      \#*) continue ;;
      export\ *) line="${line#export }" ;;
    esac

    case "$line" in
      [A-Za-z_]*=*)
        key="${line%%=*}"
        value="${line#*=}"
        case "$key" in
          *[!A-Za-z0-9_]*|'') echo "[run-claude-runner] ignoring invalid env key in $env_file: $key" >&2; continue ;;
        esac

        if [[ "$value" == \"*\" && "$value" == *\" ]]; then
          value="${value:1:${#value}-2}"
        elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
          value="${value:1:${#value}-2}"
        fi

        export "$key=$value"
        ;;
      *)
        echo "[run-claude-runner] ignoring non-env line in $env_file" >&2
        ;;
    esac
  done < "$env_file"
}

normalize_npm_proxy_env() {
  # npm accepts proxy/https-proxy config plus standard HTTP_PROXY/HTTPS_PROXY env vars.
  # npm_config_http_proxy maps to the unsupported config key "http-proxy" and emits:
  # npm warn Unknown env config "http-proxy".
  # Preserve the proxy value when no valid npm proxy config is set, then remove the invalid env key.
  if [ -n "${npm_config_http_proxy:-}" ] && [ -z "${npm_config_proxy:-}" ]; then
    export npm_config_proxy="$npm_config_http_proxy"
  fi

  if [ -n "${NPM_CONFIG_HTTP_PROXY:-}" ] && [ -z "${NPM_CONFIG_PROXY:-}" ]; then
    export NPM_CONFIG_PROXY="$NPM_CONFIG_HTTP_PROXY"
  fi

  unset npm_config_http_proxy NPM_CONFIG_HTTP_PROXY
}

if [ -f "$ENV_FILE" ]; then
  load_env_file "$ENV_FILE"
fi

normalize_npm_proxy_env

if [ ! -d "$REPO_DIR" ] || ! git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[run-claude-runner] ERROR: MODELSPEND_REPO_DIR is not a git work tree: $REPO_DIR" >&2
  exit 1
fi

cd "$REPO_DIR"

ARGS=()
EXECUTE_REQUESTED=0
if [ "${CLAUDE_RUNNER_CRON_EXECUTE:-false}" = "true" ]; then
  ARGS+=(--execute)
  EXECUTE_REQUESTED=1
fi

if [ -n "${CLAUDE_RUNNER_ARGS:-}" ]; then
  # shellcheck disable=SC2206
  EXTRA_ARGS=(${CLAUDE_RUNNER_ARGS})
  ARGS+=("${EXTRA_ARGS[@]}")
fi

echo "[run-claude-runner] $(date -u +%FT%TZ) starting Claude runner selector in $REPO_DIR"

if [ "$EXECUTE_REQUESTED" -eq 1 ]; then
  # Probe the GitHub queue before the paid/interactive Claude /usage check. The
  # probe is forced dry-run and recognises safely auto-preflightable work, so an
  # empty timer tick never starts Claude merely to discover that nothing can run.
  set +e
  node scripts/ops/claude-runner-candidate-probe.mjs "${ARGS[@]}"
  PROBE_STATUS=$?
  set -e

  case "$PROBE_STATUS" in
    0)
      exec node scripts/ops/claude-runner-cron.mjs "${ARGS[@]}"
      ;;
    3)
      echo "[run-claude-runner] no runnable candidate; probe recorded the no-selection poll without Claude quota preflight"
      exit 0
      ;;
    *)
      echo "[run-claude-runner] ERROR: candidate probe failed with exit $PROBE_STATUS" >&2
      exit "$PROBE_STATUS"
      ;;
  esac
fi

exec node scripts/ops/claude-runner-cron.mjs "${ARGS[@]}"
