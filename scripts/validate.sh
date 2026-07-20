#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$ROOT/package.json"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$ROOT/config/modelspend.example.json"
node --check "$ROOT/scripts/import-modelspend-runner.mjs"
node --check "$ROOT/scripts/verify-imported-tree.mjs"

while IFS= read -r -d '' file; do
  bash -n "$file"
done < <(find "$ROOT/bin" "$ROOT/scripts" -type f -name '*.sh' -print0)

if command -v shellcheck >/dev/null 2>&1; then
  mapfile -d '' shell_files < <(find "$ROOT/bin" "$ROOT/scripts" -type f -name '*.sh' -print0)
  shellcheck --severity=error "${shell_files[@]}"
fi

python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
validator = (root / 'scripts/validate.sh').resolve()
errors = []

def expect(value, message):
    if not value:
        errors.append(message)

importer = (root / 'scripts/import-modelspend-runner.mjs').read_text()
installer = (root / 'scripts/install-dell-user-services.sh').read_text()
state = (root / 'scripts/migrate-state.sh').read_text()
runner = (root / 'bin/run-project.sh').read_text()

expect('dependencyClosure' in importer and 'MIGRATION-MANIFEST.json' in importer, 'deterministic import closure/provenance missing')
expect("status', '--porcelain" in importer, 'dirty source checkout refusal missing')
expect('OnActiveSec=2m' in installer and 'OnUnitInactiveSec=15m' in installer, 'runner timer first/recurring triggers missing')
expect('future_trigger_exists' in installer, 'future timer trigger verification missing')
expect('install --cutover --yes' in installer, 'explicit cutover gate missing')
expect('rollback-link --yes' in installer, 'state-preserving rollback missing')
expect('pre-standalone-' in state and 'rsync -a --delete' in state, 'legacy/XDG state link rollback contract missing')
expect('refusing to run as root' in runner, 'root execution refusal missing')
expect('AGENT_RUNNER_CONFIG' in runner and 'localRepoPath' in runner, 'standalone project config boundary missing')
expect('/home/gp/.local/state/agent-runner/' in (root / 'config/modelspend.example.json').read_text(), 'XDG state path missing')

all_text = '\n'.join(
    p.read_text(errors='replace')
    for p in root.rglob('*')
    if p.is_file() and '.git' not in p.parts and p.resolve() != validator
)
for forbidden in ['sk-ant-', 'ghp_', 'github_pat_', 'ANTHROPIC_API_KEY=']:
    expect(forbidden not in all_text, f'potential secret material committed: {forbidden}')

if errors:
    for error in errors:
        print(f'ERROR: {error}', file=sys.stderr)
    raise SystemExit(1)
print('PASS: standalone migration safety invariants')
PY

node "$ROOT/scripts/verify-imported-tree.mjs"
bash "$ROOT/scripts/test-imported-runner.sh"
echo "PASS: Agent Runner repository validation"
