#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "[agent-runner] ERROR: refusing to run as root" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${AGENT_RUNNER_CONFIG:-$HOME/.config/agent-runner/modelspend.json}"
ENV_FILE="${AGENT_RUNNER_ENV_FILE:-$HOME/.config/agent-runner/runner.env}"
RESULT_FILE="${AGENT_RUNNER_RUN_RESULT_FILE:-}"
# This invocation is the sole owner of RESULT_FILE; scrub the env var so no
# child (nested run, worker, test harness) can overwrite it (#169).
unset AGENT_RUNNER_RUN_RESULT_FILE
NODE_BIN="${AGENT_RUNNER_NODE_BIN:-node}"
PINNED_CRON="$ROOT/scripts/ops/agent-runner-pinned-atomic-cron.mjs"

[ -f "$CONFIG_FILE" ] || { echo "[agent-runner] ERROR: config missing: $CONFIG_FILE" >&2; exit 1; }
[ -f "$PINNED_CRON" ] || {
  echo "[agent-runner] ERROR: pinned atomic runner entrypoint is missing" >&2
  exit 1
}

write_run_result() {
  local state="$1" reason="$2" exit_code="$3"
  [ -n "$RESULT_FILE" ] || return 0
  AGENT_RUNNER_RESULT_FILE="$RESULT_FILE" \
  AGENT_RUNNER_RESULT_STATE="$state" \
  AGENT_RUNNER_RESULT_REASON="$reason" \
  AGENT_RUNNER_RESULT_EXIT_CODE="$exit_code" \
  "$NODE_BIN" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const target = process.env.AGENT_RUNNER_RESULT_FILE;
if (!target) process.exit(0);
const payload = {
  schemaVersion: 'agent-runner-project-run-result/v1',
  state: process.env.AGENT_RUNNER_RESULT_STATE || 'unknown',
  reason: process.env.AGENT_RUNNER_RESULT_REASON || null,
  exitCode: Number(process.env.AGENT_RUNNER_RESULT_EXIT_CODE || 0),
  recordedAt: new Date().toISOString(),
};
fs.mkdirSync(path.dirname(target), { recursive: true });
const temporary = `${target}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
fs.renameSync(temporary, target);
NODE
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
  "$NODE_BIN" -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const path=process.argv[2].split("."); let x=v; for (const key of path) x=x?.[key]; if (typeof x!=="string" || !x) process.exit(2); process.stdout.write(x);' "$CONFIG_FILE" "$1"
}

load_env_file "$ENV_FILE"
# runner.env is config, not a result channel; re-scrub in case it declared it.
unset AGENT_RUNNER_RUN_RESULT_FILE
export PATH="/usr/local/bin:/opt/homebrew/bin:/opt/cpanel/ea-nodejs22/bin:$HOME/.local/bin:$HOME/bin:$PATH"
export AGENT_RUNNER_CONFIG="$CONFIG_FILE"
export CLAUDE_RUNNER_CONFIG="$CONFIG_FILE"

PROJECT_DIR="$(json_value localRepoPath)"
[ -d "$PROJECT_DIR/.git" ] || { echo "[agent-runner] ERROR: project checkout is not a git worktree: $PROJECT_DIR" >&2; exit 1; }
cd "$PROJECT_DIR"

# Pre-scheduler gates (e.g. the circuit breaker) read state paths straight
# from the environment before parseArgs runs; validate identity here first (#169).
set +e
PROJECT_SCOPED_ENV_ERROR="$("$NODE_BIN" -e '
import("file://'"$ROOT"'/scripts/ops/agent-runner-config.mjs").then(({ assertProjectScopedEnv, loadAgentRunnerConfig, resolveConfigPath }) => {
  const configPath = resolveConfigPath([], process.env);
  const config = loadAgentRunnerConfig({ argv: [], env: process.env, configPath });
  assertProjectScopedEnv({ config, configPath, env: process.env });
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
' 2>&1 >/dev/null)"
PROJECT_SCOPED_ENV_STATUS=$?
set -e
if [ "$PROJECT_SCOPED_ENV_STATUS" -ne 0 ]; then
  printf '%s\n' "$PROJECT_SCOPED_ENV_ERROR" >&2
  write_run_result wrapper_failure project-scoped-env-mismatch 1
  echo "[agent-runner] ERROR: shared machine environment disagrees with the selected project config; refusing before any candidate/claim/model work" >&2
  exit 1
fi

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
  # A tripped profile/systemic circuit is checked before candidate discovery,
  # attempt creation or any GitHub mutation. Handled pauses remain systemd 0.
  set +e
  "$NODE_BIN" "$ROOT/scripts/ops/agent-runner-circuit-breaker.mjs" check
  CIRCUIT_STATUS=$?
  set -e
  case "$CIRCUIT_STATUS" in
    0) ;;
    3) write_run_result handled_noop circuit-paused 0; echo "[agent-runner] admission circuit paused; no candidate selected or mutated"; exit 0 ;;
    *)
      write_run_result wrapper_failure circuit-check-failed "$CIRCUIT_STATUS"
      echo "[agent-runner] ERROR: circuit breaker check failed with exit $CIRCUIT_STATUS" >&2
      exit "$CIRCUIT_STATUS"
      ;;
  esac

  # Machine/profile policy is admitted before candidate discovery. A handled
  # refusal is durably recorded into the circuit before returning success.
  set +e
  ADMISSION_OUTPUT="$("$NODE_BIN" "$ROOT/scripts/ops/agent-runner-admission.mjs" "${ARGS[@]}" 2>&1)"
  ADMISSION_STATUS=$?
  set -e
  case "$ADMISSION_STATUS" in
    0) ;;
    3)
      AGENT_RUNNER_ADMISSION_RESULT="$ADMISSION_OUTPUT" \
        "$NODE_BIN" "$ROOT/scripts/ops/agent-runner-circuit-breaker.mjs" record >/dev/null
      printf '%s\n' "$ADMISSION_OUTPUT"
      write_run_result handled_noop machine-admission-paused 0
      echo "[agent-runner] machine profile paused and circuit recorded; no candidate selected or mutated"
      exit 0
      ;;
    *)
      printf '%s\n' "$ADMISSION_OUTPUT" >&2
      write_run_result wrapper_failure admission-check-failed "$ADMISSION_STATUS"
      echo "[agent-runner] ERROR: admission check failed with exit $ADMISSION_STATUS" >&2
      exit "$ADMISSION_STATUS"
      ;;
  esac

  # Observation #1: the read-only canonical candidate probe now returns the
  # exact sanitized authority snapshot that candidate admission must compare
  # against one fresh observation. Capture stdout so the successful probe is
  # not discarded and then independently validate the handoff shape.
  set +e
  PROBE_OUTPUT="$("$NODE_BIN" "$ROOT/scripts/ops/claude-runner-candidate-probe.mjs" "${ARGS[@]}")"
  PROBE_STATUS=$?
  set -e
  [ -z "$PROBE_OUTPUT" ] || printf '%s\n' "$PROBE_OUTPUT"
  case "$PROBE_STATUS" in
    0) ;;
    3)
      write_run_result handled_noop no-runnable-candidate 0
      echo "[agent-runner] no runnable candidate; no-selection recorded"
      exit 0
      ;;
    *)
      write_run_result wrapper_failure candidate-probe-failed "$PROBE_STATUS"
      echo "[agent-runner] ERROR: candidate probe failed with exit $PROBE_STATUS" >&2
      exit "$PROBE_STATUS"
      ;;
  esac

  set +e
  PROBE_EXPECTED_JSON="$("$NODE_BIN" -e '
    let parsed = null;
    try { parsed = JSON.parse(process.argv[1]); } catch { parsed = null; }
    const snapshot = parsed?.candidateSnapshot;
    if (parsed?.candidate !== true || !snapshot || typeof snapshot !== "object" || !Number.isInteger(snapshot.issueNumber)) process.exit(2);
    process.stdout.write(JSON.stringify(snapshot));
  ' "$PROBE_OUTPUT")"
  PROBE_HANDOFF_STATUS=$?
  set -e
  if [ "$PROBE_HANDOFF_STATUS" -ne 0 ]; then
    write_run_result wrapper_failure candidate-probe-handoff-invalid 1
    echo "[agent-runner] ERROR: candidate probe did not provide a valid sanitized candidate handoff; refusing before admission/claim" >&2
    exit 1
  fi

  # Observation #2: candidate admission receives the successful probe snapshot
  # through the already-established expected-candidate contract and performs
  # exactly one fresh canonical selection. All existing issue/status/agent/
  # manager-authority/body-digest/author/profile checks remain unchanged. A
  # handled refusal still occurs before the canonical scheduler can create an
  # attempt row or mutate GitHub; the later atomic revalidation remains intact.
  set +e
  CANDIDATE_OUTPUT="$(AGENT_RUNNER_ATOMIC_EXPECTED_JSON="$PROBE_EXPECTED_JSON" \
    "$NODE_BIN" "$ROOT/scripts/ops/agent-runner-candidate-admission.mjs" "${ARGS[@]}")"
  CANDIDATE_STATUS=$?
  set -e
  case "$CANDIDATE_STATUS" in
    0)
      printf '%s\n' "$CANDIDATE_OUTPUT"
      write_run_result canonical_runner_invoked canonical-runner-executed 0
      exec "$NODE_BIN" "$PINNED_CRON" "${ARGS[@]}"
      ;;
    3)
      printf '%s\n' "$CANDIDATE_OUTPUT"
      CANDIDATE_FAILURE_SCOPE="$("$NODE_BIN" -e '
        let parsed = null;
        try { parsed = JSON.parse(process.argv[1]); } catch { parsed = null; }
        process.stdout.write(String(parsed?.admission?.scope || "issue_not_runnable"));
      ' "$CANDIDATE_OUTPUT")"
      if [ "$CANDIDATE_FAILURE_SCOPE" = "machine_profile" ]; then
        write_run_result handled_noop candidate-machine-profile-refused 0
        echo "[agent-runner] candidate-specific cost/profile policy refused and circuit recorded; no attempt created or issue mutated"
      else
        write_run_result handled_noop candidate-authority-refused 0
        echo "[agent-runner] candidate authority changed or is not approved; no attempt created or issue mutated"
      fi
      exit 0
      ;;
    *)
      printf '%s\n' "$CANDIDATE_OUTPUT" >&2
      write_run_result wrapper_failure candidate-admission-failed "$CANDIDATE_STATUS"
      echo "[agent-runner] ERROR: candidate admission failed with exit $CANDIDATE_STATUS" >&2
      exit "$CANDIDATE_STATUS"
      ;;
  esac
fi

write_run_result canonical_runner_invoked dry-run-runner-invoked 0
exec "$NODE_BIN" "$PINNED_CRON" "${ARGS[@]}"
