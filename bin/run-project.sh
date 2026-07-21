#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "[agent-runner] ERROR: refusing to run as root" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${AGENT_RUNNER_CONFIG:-$HOME/.config/agent-runner/modelspend.json}"
ENV_FILE="${AGENT_RUNNER_ENV_FILE:-$HOME/.config/agent-runner/runner.env}"

[ -f "$CONFIG_FILE" ] || { echo "[agent-runner] ERROR: config missing: $CONFIG_FILE" >&2; exit 1; }
[ -f "$ROOT/scripts/ops/agent-runner-atomic-cron.mjs" ] || {
  echo "[agent-runner] ERROR: atomic runner entrypoint is missing" >&2
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

json_value() {
  node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const path=process.argv[2].split("."); let x=v; for (const key of path) x=x?.[key]; if (typeof x!=="string" || !x) process.exit(2); process.stdout.write(x);' "$CONFIG_FILE" "$1"
}

load_env_file "$ENV_FILE"
export PATH="/usr/local/bin:/opt/homebrew/bin:/opt/cpanel/ea-nodejs22/bin:$HOME/.local/bin:$HOME/bin:$PATH"
export AGENT_RUNNER_CONFIG="$CONFIG_FILE"
export CLAUDE_RUNNER_CONFIG="$CONFIG_FILE"

PROJECT_DIR="$(json_value localRepoPath)"
[ -d "$PROJECT_DIR/.git" ] || { echo "[agent-runner] ERROR: project checkout is not a git worktree: $PROJECT_DIR" >&2; exit 1; }
cd "$PROJECT_DIR"

ARGS=()
EXECUTE_REQUESTED=0
if [ "${AGENT_RUNNER_EXECUTE:-${CLAUDE_RUNNER_CRON_EXECUTE:-false}}" = "true" ]; then
  ARGS+=(--execute)
  EXECUTE_REQUESTED=1
fi
if [ -n "${AGENT_RUNNER_ARGS:-${CLAUDE_RUNNER_ARGS:-}}" ]; then
  # Compatibility input is operator-controlled and follows the previous runner contract.
  # shellcheck disable=SC2206
  EXTRA_ARGS=(${AGENT_RUNNER_ARGS:-${CLAUDE_RUNNER_ARGS:-}})
  ARGS+=("${EXTRA_ARGS[@]}")
fi

if [ "$EXECUTE_REQUESTED" -eq 1 ]; then
  # Machine/profile policy is admitted before candidate discovery. A handled
  # refusal must not query, claim, relabel, comment on, or consume any issue.
  # Automatic/generated preflight implementation remains prohibited by owner
  # decision; only an existing normal-ChatGPT manager packet may be consumed.
  export CLAUDE_RUNNER_CRON_DISABLE_AUTO_PREFLIGHT=true
  export CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION=false
  set +e
  node "$ROOT/scripts/ops/agent-runner-admission.mjs" "${ARGS[@]}"
  ADMISSION_STATUS=$?
  set -e
  case "$ADMISSION_STATUS" in
    0) ;;
    3) echo "[agent-runner] machine profile paused; no candidate selected or mutated"; exit 0 ;;
    *) echo "[agent-runner] ERROR: admission check failed with exit $ADMISSION_STATUS" >&2; exit "$ADMISSION_STATUS" ;;
  esac

  set +e
  node "$ROOT/scripts/ops/claude-runner-candidate-probe.mjs" "${ARGS[@]}"
  PROBE_STATUS=$?
  set -e
  case "$PROBE_STATUS" in
    0) ;;
    3) echo "[agent-runner] no runnable candidate; no-selection recorded"; exit 0 ;;
    *) echo "[agent-runner] ERROR: candidate probe failed with exit $PROBE_STATUS" >&2; exit "$PROBE_STATUS" ;;
  esac

  # Re-read the selected candidate twice and require stable issue, status,
  # agent, dispatch mode, command revision, manager-preflight revision and an
  # approved manager author. A handled refusal occurs before the canonical
  # scheduler can create an attempt row or mutate GitHub.
  set +e
  node "$ROOT/scripts/ops/agent-runner-candidate-admission.mjs" "${ARGS[@]}"
  CANDIDATE_STATUS=$?
  set -e
  case "$CANDIDATE_STATUS" in
    0) exec node "$ROOT/scripts/ops/agent-runner-atomic-cron.mjs" "${ARGS[@]}" ;;
    3) echo "[agent-runner] candidate authority changed or is not approved; no attempt created or issue mutated"; exit 0 ;;
    *) echo "[agent-runner] ERROR: candidate admission failed with exit $CANDIDATE_STATUS" >&2; exit "$CANDIDATE_STATUS" ;;
  esac
fi

exec node "$ROOT/scripts/ops/agent-runner-atomic-cron.mjs" "${ARGS[@]}"
