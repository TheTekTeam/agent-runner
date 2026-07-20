#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "[agent-runner-dashboard] ERROR: refusing to run as root" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${AGENT_RUNNER_CONFIG:-$HOME/.config/agent-runner/modelspend.json}"
OUT_DIR="${AGENT_RUNNER_DASHBOARD_DIR:-/var/www/agent-runner/dashboard}"

[ -f "$CONFIG_FILE" ] || { echo "[agent-runner-dashboard] ERROR: config missing: $CONFIG_FILE" >&2; exit 1; }
[ -f "$ROOT/scripts/ops/claude-runner-dashboard-local.mjs" ] || {
  echo "[agent-runner-dashboard] ERROR: dashboard implementation has not been imported" >&2
  exit 1
}

json_value() {
  node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const path=process.argv[2].split("."); let x=v; for (const key of path) x=x?.[key]; if (typeof x!=="string" || !x) process.exit(2); process.stdout.write(x);' "$CONFIG_FILE" "$1"
}

STATE_DB="$(json_value stateDbPath)"
mkdir -p "$OUT_DIR"
exec node "$ROOT/scripts/ops/claude-runner-dashboard-local.mjs" \
  --db "$STATE_DB" \
  --out-dir "$OUT_DIR" \
  --history-limit 100 \
  --strict
