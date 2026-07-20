#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/MIGRATION-MANIFEST.json"

if [ ! -f "$MANIFEST" ]; then
  echo "INFO: imported runner source is not present yet; importer/tooling gates only"
  exit 0
fi

while IFS= read -r -d '' file; do
  node --check "$file"
done < <(find "$ROOT/.agent-runner" "$ROOT/scripts/ops" -type f \( -name '*.mjs' -o -name '*.js' \) -print0)

mapfile -t tests < <(find "$ROOT/scripts/ops" -maxdepth 2 -type f \
  \( -name 'agent-runner*.test.mjs' -o -name 'claude-runner*.test.mjs' -o -name 'install-claude-runner*.test.mjs' \) \
  | sort)
if [ "${#tests[@]}" -eq 0 ]; then
  echo "ERROR: migration manifest exists but no runner tests were imported" >&2
  exit 1
fi

node --test "${tests[@]}"

echo "Checking portable runner help..."
node "$ROOT/.agent-runner/scripts/runner.mjs" --help >/tmp/agent-runner-help.out 2>/tmp/agent-runner-help.err || {
  status=$?
  cat /tmp/agent-runner-help.err >&2
  echo "ERROR: portable runner --help exited $status" >&2
  exit "$status"
}

echo "Checking portable cron help..."
node "$ROOT/.agent-runner/scripts/runner-cron.mjs" --help >/tmp/agent-runner-cron-help.out 2>/tmp/agent-runner-cron-help.err || {
  status=$?
  cat /tmp/agent-runner-cron-help.err >&2
  echo "ERROR: portable runner-cron --help exited $status" >&2
  exit "$status"
}

echo "Checking safe missing-state dashboard response..."
node "$ROOT/scripts/ops/claude-runner-dashboard-api.mjs" \
  --db "$ROOT/.tmp-missing-runner-state.sqlite" >/tmp/agent-runner-dashboard-missing.json
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const hasDiagnostic = value.diagnostics?.some((item) => item.code === "state-db-missing" && item.level === "warn");
  if (value.ok !== true || value.status !== "missing" || !hasDiagnostic) process.exit(1);
' /tmp/agent-runner-dashboard-missing.json
rm -f /tmp/agent-runner-help.out /tmp/agent-runner-help.err \
  /tmp/agent-runner-cron-help.out /tmp/agent-runner-cron-help.err \
  /tmp/agent-runner-dashboard-missing.json

echo "PASS: imported runner syntax, focused tests and safe missing-state smoke checks"
