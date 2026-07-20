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
node "$ROOT/.agent-runner/scripts/runner.mjs" --help >/dev/null
node "$ROOT/.agent-runner/scripts/runner-cron.mjs" --help >/dev/null
node "$ROOT/scripts/ops/claude-runner-dashboard-api.mjs" \
  --db "$ROOT/.tmp-missing-runner-state.sqlite" >/tmp/agent-runner-dashboard-missing.json
node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(v.ok!==false || !v.diagnostics?.some(x=>x.code==="state-db-missing")) process.exit(1)' \
  /tmp/agent-runner-dashboard-missing.json
rm -f /tmp/agent-runner-dashboard-missing.json

echo "PASS: imported runner syntax, focused tests and safe missing-state smoke checks"
