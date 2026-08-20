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

# The generic implementation service is itself the operator-approved execution
# authority. Accept only its explicit --execute opt-in at this wrapper boundary;
# do not silently turn arbitrary systemd/CLI arguments into runner arguments.
REQUESTED_EXECUTE=0
for arg in "$@"; do
  case "$arg" in
    --execute) REQUESTED_EXECUTE=1 ;;
    *)
      echo "[agent-runner] ERROR: unsupported implementation recurrence argument: $arg" >&2
      exit 2
      ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${AGENT_RUNNER_ENV_FILE:-$HOME/.config/agent-runner/runner.env}"
NODE_BIN="${AGENT_RUNNER_NODE_BIN:-node}"
RECURRENCE_SCRIPT="$ROOT/scripts/ops/agent-runner-implementation-recurrence.mjs"
SOURCE_ACTIVATION_CONTROLLER="$ROOT/scripts/ops/agent-runner-source-activation-authority.mjs"
CONTROL_EVIDENCE_PUBLISHER="$ROOT/scripts/ops/agent-runner-control-evidence.mjs"

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

# Load shared machine policy exactly once at the generic scheduler boundary.
# The accepted historical runner.env may still contain ModelSpend-scoped
# compatibility values. Those must not survive into another selected project,
# and selected bin/run-project.sh must not reload runner.env and reintroduce
# them after agent-runner-implementation-recurrence.mjs has rebound the exact
# project config. Global policy/provider/quota values remain inherited.
load_env_file "$ENV_FILE"

# #252 bounded control-plane evidence is emitted from this outer deterministic
# Dell controller path before source activation and before the Node recurrence
# can acquire the machine-global implementation lock. This is read-only with
# respect to checkout/timers/claims. If evidence cannot be collected/published,
# fail closed by skipping all source activation and implementation work for this
# recurrence rather than creating a claim that the manager cannot safely see.
[ -f "$CONTROL_EVIDENCE_PUBLISHER" ] || {
  echo "[agent-runner] ERROR: control-evidence publisher is missing; implementation recurrence skipped" >&2
  exit 0
}
set +e
CONTROL_EVIDENCE_OUTPUT="$($NODE_BIN "$CONTROL_EVIDENCE_PUBLISHER" 2>&1)"
CONTROL_EVIDENCE_STATUS=$?
set -e
if [ "$CONTROL_EVIDENCE_STATUS" -ne 0 ]; then
  [ -z "$CONTROL_EVIDENCE_OUTPUT" ] || printf '%s\n' "$CONTROL_EVIDENCE_OUTPUT" >&2
  echo "[agent-runner] control-evidence publication failed; implementation recurrence skipped" >&2
  exit 0
fi

unset GITHUB_REPOSITORY
unset CLAUDE_RUNNER_OUTPUT_DIR
unset CLAUDE_RUNNER_STATE_DB
unset CLAUDE_RUNNER_CRON_LOCK
export AGENT_RUNNER_ENV_FILE=/dev/null

export PATH="/usr/local/bin:/opt/homebrew/bin:/opt/cpanel/ea-nodejs22/bin:$HOME/.local/bin:$HOME/bin:$PATH"

# #234 accepted-source authority runs only at this outer boundary, before the
# Node recurrence acquires the machine-global implementation lock or inspects a
# candidate. Disabled is the default and performs no controller/GitHub lookup.
source_activation_enabled() {
  case "${AGENT_RUNNER_SOURCE_ACTIVATION_ENABLED:-false}" in
    1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) return 0 ;;
    *) return 1 ;;
  esac
}

if source_activation_enabled; then
  [ -f "$SOURCE_ACTIVATION_CONTROLLER" ] || {
    echo "[agent-runner] ERROR: source-activation authority controller is missing" >&2
    exit 1
  }

  SOURCE_ACTIVATION_REEXEC_DEPTH="${AGENT_RUNNER_SOURCE_ACTIVATION_REEXEC_DEPTH:-0}"
  case "$SOURCE_ACTIVATION_REEXEC_DEPTH" in
    0|1) ;;
    *)
      echo "[agent-runner] ERROR: invalid source-activation re-exec depth guard" >&2
      exit 1
      ;;
  esac

  set +e
  SOURCE_ACTIVATION_OUTPUT="$($NODE_BIN "$SOURCE_ACTIVATION_CONTROLLER" 2>&1)"
  SOURCE_ACTIVATION_STATUS=$?
  set -e
  [ -z "$SOURCE_ACTIVATION_OUTPUT" ] || printf '%s\n' "$SOURCE_ACTIVATION_OUTPUT"

  case "$SOURCE_ACTIVATION_STATUS" in
    0)
      # Disabled/no-new/already-applied authority: continue current recurrence.
      ;;
    10)
      if [ "$SOURCE_ACTIVATION_REEXEC_DEPTH" -ne 0 ]; then
        echo "[agent-runner] ERROR: source-activation re-exec depth guard prevented recursion" >&2
        exit 1
      fi
      export AGENT_RUNNER_SOURCE_ACTIVATION_REEXEC_DEPTH=1
      # Re-enter the canonical Bash wrapper through Bash rather than relying on
      # the repository file's execute bit. GitHub/checkouts may preserve this
      # entrypoint as mode 0644 even though the service invokes it via Bash.
      exec bash "$ROOT/bin/run-implementation-recurrence.sh" "$@"
      ;;
    3)
      # Handled authority/activation refusal: intentionally do not inspect,
      # claim or launch an implementation candidate in this recurrence.
      echo "[agent-runner] source activation requires manager attention; implementation recurrence skipped"
      exit 0
      ;;
    *)
      echo "[agent-runner] ERROR: source-activation authority evaluation failed" >&2
      exit "$SOURCE_ACTIVATION_STATUS"
      ;;
  esac
fi

# Source-activation configuration is machine control-plane authority only. Once
# its outer-boundary decision is complete, do not inherit it into candidate
# selection, project wrappers or implementation workers. A later timer tick
# reloads the machine policy afresh from runner.env.
unset AGENT_RUNNER_SOURCE_ACTIVATION_ENABLED
unset AGENT_RUNNER_SOURCE_ACTIVATION_CONTROL_ISSUE
unset AGENT_RUNNER_SOURCE_ACTIVATION_STATE
unset AGENT_RUNNER_SOURCE_ACTIVATION_REEXEC_DEPTH

[ -n "${AGENT_RUNNER_PROJECT_REGISTRY:-}" ] || {
  echo "[agent-runner] ERROR: AGENT_RUNNER_PROJECT_REGISTRY is not configured" >&2
  exit 1
}

ARGS=()
if [ "$REQUESTED_EXECUTE" -eq 1 ] || [ "${AGENT_RUNNER_EXECUTE:-false}" = "true" ]; then
  # Preserve the recurrence argv contract for its read-only probe semantics,
  # and also export the existing project-wrapper execution contract so the
  # single selected bin/run-project.sh actually executes rather than dry-runs.
  export AGENT_RUNNER_EXECUTE=true
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