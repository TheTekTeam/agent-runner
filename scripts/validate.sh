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
import re
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
publisher = (root / 'bin/publish-dashboard.sh').read_text()
config = (root / 'config/modelspend.example.json').read_text()

expect('dependencyClosure' in importer and 'MIGRATION-MANIFEST.json' in importer, 'deterministic import closure/provenance missing')
expect("status', '--porcelain" in importer, 'dirty source checkout refusal missing')
expect('claude-event-array-(?:299|550|658)' in importer, 'path-loaded runner regression fixtures are not in the import contract')
expect('OnActiveSec=2m' in installer and 'OnUnitInactiveSec=15m' in installer, 'runner timer first/recurring triggers missing')
expect('future_trigger_exists' in installer, 'future timer trigger verification missing')
expect('install --cutover --yes' in installer, 'explicit cutover gate missing')
expect('rollback-link --yes' in installer, 'state-preserving rollback missing')
expect('json_value legacyStateRoot' in installer, 'explicit legacy state root is not used')
expect('Cutover aborted: state verification failed; legacy schedule restored' in installer, 'failed cutover does not restore legacy schedule')
expect('git -C "$project" rev-parse --is-inside-work-tree' in installer, 'git worktree-compatible project validation missing')
expect('pre-standalone-' in state and 'rsync -a --delete' in state, 'legacy/XDG state link rollback contract missing')
expect('refusing to run as root' in runner, 'root execution refusal missing')
expect('AGENT_RUNNER_CONFIG' in runner and 'localRepoPath' in runner, 'standalone project config boundary missing')
expect('"legacyStateRoot"' in config, 'legacy state root missing from project config')
expect('/home/gp/.local/state/agent-runner/' in config, 'XDG state path missing')
expect('--config "$CONFIG_FILE"' not in publisher, 'dashboard publisher passes unsupported --config argument')
expect('--db "$STATE_DB"' in publisher and '--strict' in publisher, 'dashboard publisher does not use the bounded supported CLI')

all_text = '\n'.join(
    p.read_text(errors='replace')
    for p in root.rglob('*')
    if p.is_file() and '.git' not in p.parts and p.resolve() != validator
)
secret_patterns = {
    'Anthropic API key': re.compile(r'(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}'),
    'GitHub classic token': re.compile(r'(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{20,}'),
    'GitHub fine-grained token': re.compile(r'(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}'),
    'assigned Anthropic secret': re.compile(r'ANTHROPIC_API_KEY\s*=\s*["\']?(?!\$|<|\.\.\.|REDACTED)[A-Za-z0-9_-]{20,}'),
}
for label, pattern in secret_patterns.items():
    expect(pattern.search(all_text) is None, f'potential {label} committed')

if errors:
    for error in errors:
        print(f'ERROR: {error}', file=sys.stderr)
    raise SystemExit(1)
print('PASS: standalone migration safety invariants')
PY

node "$ROOT/scripts/verify-imported-tree.mjs"
bash "$ROOT/scripts/test-imported-runner.sh"
echo "PASS: Agent Runner repository validation"
