#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$ROOT/package.json"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$ROOT/config/modelspend.example.json"
node --check "$ROOT/scripts/import-modelspend-runner.mjs"
node --check "$ROOT/scripts/verify-imported-tree.mjs"
node --check "$ROOT/scripts/ops/agent-runner-observability-exporter.mjs"
node --check "$ROOT/scripts/ops/agent-runner-observability-common.mjs"
node --check "$ROOT/scripts/ops/agent-runner-observability-projection.mjs"
node --check "$ROOT/scripts/ops/agent-runner-observability-metrics.mjs"
node --check "$ROOT/scripts/ops/agent-runner-observability-events.mjs"
node --check "$ROOT/scripts/ops/agent-runner-observability-http.mjs"

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
exporter = (root / 'scripts/ops/agent-runner-observability-exporter.mjs').read_text()
exporter_common = (root / 'scripts/ops/agent-runner-observability-common.mjs').read_text()
exporter_projection = (root / 'scripts/ops/agent-runner-observability-projection.mjs').read_text()
exporter_http = (root / 'scripts/ops/agent-runner-observability-http.mjs').read_text()
exporter_installer = (root / 'scripts/install-observability-exporter.sh').read_text()

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

runner_unit = installer.split('cat > "$USER_UNIT_DIR/$RUN_SERVICE" <<UNIT', 1)[1].split('\nUNIT', 1)[0]
dashboard_unit = installer.split('cat > "$USER_UNIT_DIR/$DASH_SERVICE" <<UNIT', 1)[1].split('\nUNIT', 1)[0]
expect('ProtectSystem=full' in runner_unit, 'runner execution service must protect system paths while preserving normal user-home writes')
expect('ProtectHome=read-only' not in runner_unit, 'runner execution service must not block Claude/Codex user-state writes')
expect('NoNewPrivileges=true' in runner_unit and 'PrivateTmp=true' in runner_unit, 'runner execution service hardening regressed')
expect('ProtectSystem=strict' in dashboard_unit and 'ProtectHome=read-only' in dashboard_unit, 'read-only dashboard service sandbox regressed')

expect("const LOOPBACK_HOST = '127.0.0.1'" in exporter_common, 'observability exporter loopback constant missing')
expect('args.host !== LOOPBACK_HOST' in exporter, 'observability exporter does not reject non-loopback binding')
expect("path === '/metrics'" in exporter_http and "path === '/healthz'" in exporter_http and "path === '/events.ndjson'" in exporter_http,
       'observability exporter endpoint contract missing')
expect("!['GET','HEAD'].includes(request.method)" in exporter_http, 'observability exporter does not reject write methods')
expect('MAX_EVENTS = 100' in exporter_common and 'MAX_EVENT_BYTES = 256 * 1024' in exporter_common,
       'observability event feed is not bounded')
expect("new DatabaseSync(dbPath, { readOnly: true })" in exporter_projection,
       'observability projection does not open SQLite read-only')
expect('PRAGMA query_only = ON' in exporter_projection and 'PRAGMA trusted_schema = OFF' in exporter_projection,
       'observability projection SQLite safety pragmas missing')
expect('payload_json' not in exporter_projection and 'log_path' not in exporter_projection,
       'observability projection contains prohibited raw columns')
expect('buildRunnerDashboard' not in exporter and 'openRunnerStateStore' not in exporter_projection,
       'observability exporter must not invoke the mutable runner state store')
expect('ProtectSystem=strict' in exporter_installer and 'ProtectHome=read-only' in exporter_installer,
       'observability exporter systemd sandbox missing')
expect('NoNewPrivileges=true' in exporter_installer and 'MemoryMax=128M' in exporter_installer,
       'observability exporter resource/security hardening missing')
expect('ExecStart=/usr/bin/node' in exporter_installer and '--host $HOST' in exporter_installer,
       'observability exporter service entrypoint missing')

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
print('PASS: standalone migration and observability safety invariants')
PY

node "$ROOT/scripts/verify-imported-tree.mjs"
bash "$ROOT/scripts/test-imported-runner.sh"
echo "PASS: Agent Runner repository validation"
