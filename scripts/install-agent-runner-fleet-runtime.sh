#!/usr/bin/env bash
set -euo pipefail

# #328 bounded fleet runtime installer.
#
# This script installs only runtime software whose package source and integrity
# mechanism are explicitly reviewed in the canonical fleet contract. It never
# authenticates a provider, copies credentials/sessions, qualifies an agent
# instance, mutates the worker registry, downloads local models, or installs /
# enables Agent Runner scheduler/controller services.

usage() {
  cat <<'USAGE'
Usage:
  scripts/install-agent-runner-fleet-runtime.sh \
    --adapter <adapter-id> \
    [--node <node-id>] \
    [--worker-only] \
    [--dry-run]

Currently supported installer contracts:
  claude-code-cli  Ubuntu/Debian via Anthropic's signed stable apt repository.
  codex-cli        Ubuntu/Debian via OpenAI's official @openai/codex npm package.
  ollama-agent     Ubuntu/Debian via Ollama's official Linux tarball plus
                   OpenCode's official opencode-ai npm package.

Grok remains fail-closed/deferred. Installation does not perform provider
login/authentication, download or pull Ollama models, qualify an agent, start
Ollama as a service, or activate routing.
USAGE
}

ADAPTER=""
NODE_ID=""
WORKER_ONLY=0
DRY_RUN=0
EXPECTED_CLAUDE_KEY_FINGERPRINT="31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE"
CLAUDE_KEY_URL="https://downloads.claude.ai/keys/claude-code.asc"
CLAUDE_APT_REPOSITORY="https://downloads.claude.ai/claude-code/apt/stable"
CLAUDE_APT_SOURCE="deb [signed-by=/etc/apt/keyrings/claude-code.asc] ${CLAUDE_APT_REPOSITORY} stable main"
CODEX_NPM_PACKAGE="@openai/codex"
CODEX_NPM_PACKAGE_SPEC="@openai/codex@latest"
CODEX_NPM_REGISTRY="https://registry.npmjs.org/"
OLLAMA_DOWNLOAD_BASE="https://ollama.com/download"
OPENCODE_NPM_PACKAGE="opencode-ai"
OPENCODE_NPM_PACKAGE_SPEC="opencode-ai@latest"
OPENCODE_NPM_REGISTRY="https://registry.npmjs.org/"

fail() {
  printf '[install-agent-runner-fleet-runtime] ERROR: %s\n' "$1" >&2
  exit 1
}

info() {
  printf '[install-agent-runner-fleet-runtime] %s\n' "$1"
}

while (($#)); do
  case "$1" in
    --adapter) ADAPTER="${2:-}"; shift 2 ;;
    --node) NODE_ID="${2:-}"; shift 2 ;;
    --worker-only) WORKER_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$ADAPTER" ]] || fail '--adapter is required'
[[ "$(id -u)" -ne 0 ]] || fail 'do not run this installer as root; it uses sudo only for reviewed package-manager operations'

if [[ -n "$NODE_ID" ]]; then
  [[ "$NODE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$ ]] || fail '--node is invalid'
  [[ "$(hostname)" == "$NODE_ID" ]] || fail "host identity mismatch: expected $NODE_ID, found $(hostname)"
fi

case "$ADAPTER" in
  claude-code-cli|codex-cli|ollama-agent) ;;
  grok-cli)
    fail "$ADAPTER is owner-deferred and has no active fleet installation authority"
    ;;
  *)
    fail "unsupported fleet adapter: $ADAPTER"
    ;;
esac

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
else
  fail '/etc/os-release is unavailable'
fi

OS_ID="${ID:-}"
OS_LIKE="${ID_LIKE:-}"
if [[ "$OS_ID" != "ubuntu" && "$OS_ID" != "debian" && " $OS_LIKE " != *" debian "* ]]; then
  fail "$ADAPTER fleet installer currently supports Ubuntu/Debian only; found ${PRETTY_NAME:-unknown}"
fi

if [[ "$WORKER_ONLY" -eq 1 ]]; then
  info 'worker-only mode: runtime installation grants no scheduler/controller authority'
fi

if [[ "$ADAPTER" == "claude-code-cli" ]] && command -v claude >/dev/null 2>&1; then
  info "claude-code-cli runtime already installed: $(claude --version 2>/dev/null || printf 'version-probe-failed')"
  exit 0
fi

if [[ "$ADAPTER" == "codex-cli" ]] && command -v codex >/dev/null 2>&1; then
  info "codex-cli runtime already installed: $(codex --version 2>/dev/null || printf 'version-probe-failed')"
  exit 0
fi

if [[ "$ADAPTER" == "ollama-agent" ]]   && command -v ollama >/dev/null 2>&1   && command -v opencode >/dev/null 2>&1; then
  info "ollama-agent runtime already installed: ollama=$(ollama -v 2>/dev/null || printf 'version-probe-failed') opencode=$(opencode --version 2>/dev/null || printf 'version-probe-failed')"
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  if [[ "$ADAPTER" == "claude-code-cli" ]]; then
    info '--dry-run: would ensure curl, ca-certificates and gnupg are installed through apt'
    info "--dry-run: would download Anthropic signing key from $CLAUDE_KEY_URL"
    info "--dry-run: would require signing-key fingerprint $EXPECTED_CLAUDE_KEY_FINGERPRINT"
    info "--dry-run: would configure stable repository $CLAUDE_APT_REPOSITORY"
    info '--dry-run: would install package claude-code through apt'
  elif [[ "$ADAPTER" == "codex-cli" ]]; then
    info '--dry-run: would require the existing reviewed Node/npm toolchain'
    info "--dry-run: would install $CODEX_NPM_PACKAGE_SPEC globally from $CODEX_NPM_REGISTRY"
    info '--dry-run: would verify codex --version'
    info '--dry-run: would not run codex login or inspect/copy ~/.codex authentication state'
  else
    info '--dry-run: would detect amd64/arm64 and install the official Ollama Linux tarball only if the ollama runtime is absent'
    info "--dry-run: Ollama download base is $OLLAMA_DOWNLOAD_BASE"
    info '--dry-run: would not create/start/enable an Ollama service and would not pull or run any model'
    info '--dry-run: would require the existing reviewed Node/npm toolchain for OpenCode'
    info "--dry-run: would install $OPENCODE_NPM_PACKAGE_SPEC globally from $OPENCODE_NPM_REGISTRY only if the harness is absent"
    info '--dry-run: would verify ollama -v and opencode --version'
  fi
  exit 0
fi

command -v sudo >/dev/null 2>&1 || fail 'sudo is required for reviewed machine-wide runtime installation'

if [[ "$ADAPTER" == "codex-cli" ]]; then
  command -v npm >/dev/null 2>&1 || fail 'npm is required for the reviewed Codex CLI installation mechanism'
  NPM_BIN="$(command -v npm)"

  # OpenAI publishes `npm install -g @openai/codex` as a supported Codex CLI
  # installation path. Pin the registry host in this reviewed machine-wide
  # operation, but deliberately do not authenticate or inspect provider state.
  sudo "$NPM_BIN" install --global \
    --registry="$CODEX_NPM_REGISTRY" \
    --no-audit \
    --no-fund \
    "$CODEX_NPM_PACKAGE_SPEC"

  command -v codex >/dev/null 2>&1 || fail 'Codex package installed but executable is not on PATH'
  VERSION="$(codex --version 2>/dev/null || true)"
  [[ -n "$VERSION" ]] || fail 'codex --version did not return a bounded version string'

  info "codex-cli runtime installed from $CODEX_NPM_PACKAGE: $VERSION"
  info 'authentication remains machine-local and unproven; no route was qualified or enabled'
  exit 0
fi

if [[ "$ADAPTER" == "ollama-agent" ]]; then
  if ! command -v ollama >/dev/null 2>&1; then
    command -v apt-get >/dev/null 2>&1 || fail 'apt-get is required to install reviewed Ollama download prerequisites'
    command -v curl >/dev/null 2>&1 || {
      sudo apt-get update
      sudo apt-get install -y curl ca-certificates zstd
    }
    command -v zstd >/dev/null 2>&1 || {
      sudo apt-get update
      sudo apt-get install -y zstd
    }

    case "$(uname -m)" in
      x86_64|amd64) OLLAMA_ARCH="amd64" ;;
      aarch64|arm64) OLLAMA_ARCH="arm64" ;;
      *) fail "unsupported Ollama Linux architecture: $(uname -m)" ;;
    esac

    TMP_DIR="$(mktemp -d)"
    cleanup_ollama() {
      rm -rf "$TMP_DIR"
    }
    trap cleanup_ollama EXIT

    OLLAMA_ARCHIVE="$TMP_DIR/ollama-linux-$OLLAMA_ARCH.tar.zst"
    OLLAMA_URL="$OLLAMA_DOWNLOAD_BASE/ollama-linux-$OLLAMA_ARCH.tar.zst"
    curl -fsSL "$OLLAMA_URL" -o "$OLLAMA_ARCHIVE"
    sudo tar --zstd -xf "$OLLAMA_ARCHIVE" -C /usr

    command -v ollama >/dev/null 2>&1 || fail 'Ollama archive installed but executable is not on PATH'
  fi

  if ! command -v opencode >/dev/null 2>&1; then
    command -v npm >/dev/null 2>&1 || fail 'npm is required for the reviewed OpenCode installation mechanism'
    NPM_BIN="$(command -v npm)"
    sudo "$NPM_BIN" install --global \
      --registry="$OPENCODE_NPM_REGISTRY" \
      --no-audit \
      --no-fund \
      "$OPENCODE_NPM_PACKAGE_SPEC"
    command -v opencode >/dev/null 2>&1 || fail 'OpenCode package installed but executable is not on PATH'
  fi

  OLLAMA_VERSION="$(ollama -v 2>/dev/null || true)"
  OPENCODE_VERSION="$(opencode --version 2>/dev/null || true)"
  [[ -n "$OLLAMA_VERSION" ]] || fail 'ollama -v did not return a bounded version string'
  [[ -n "$OPENCODE_VERSION" ]] || fail 'opencode --version did not return a bounded version string'

  info "ollama-agent runtime installed: ollama=$OLLAMA_VERSION opencode=$OPENCODE_VERSION"
  info 'no Ollama service was started/enabled, no model was pulled/run, and no route was qualified or enabled'
  exit 0
fi

command -v apt-get >/dev/null 2>&1 || fail 'apt-get is required for the reviewed Ubuntu/Debian Claude installation mechanism'

# Install only the tooling needed to obtain and verify the signed repository key.
sudo apt-get update
sudo apt-get install -y curl ca-certificates gnupg

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

KEY_FILE="$TMP_DIR/claude-code.asc"
curl -fsSL "$CLAUDE_KEY_URL" -o "$KEY_FILE"

FINGERPRINTS="$(gpg --show-keys --with-colons "$KEY_FILE" 2>/dev/null | awk -F: '$1 == "fpr" { print $10 }')"
case "${FINGERPRINTS//$'\n'/ }" in
  *"$EXPECTED_CLAUDE_KEY_FINGERPRINT"*) ;;
  *) fail 'Anthropic signing-key fingerprint mismatch; refusing repository installation' ;;
esac

sudo install -d -m 0755 /etc/apt/keyrings
sudo install -m 0644 "$KEY_FILE" /etc/apt/keyrings/claude-code.asc

SOURCE_FILE="$TMP_DIR/claude-code.list"
printf '%s\n' "$CLAUDE_APT_SOURCE" >"$SOURCE_FILE"
sudo install -m 0644 "$SOURCE_FILE" /etc/apt/sources.list.d/claude-code.list

sudo apt-get update
sudo apt-get install -y claude-code

command -v claude >/dev/null 2>&1 || fail 'claude package installed but executable is not on PATH'
VERSION="$(claude --version 2>/dev/null || true)"
[[ -n "$VERSION" ]] || fail 'claude --version did not return a bounded version string'

info "claude-code-cli runtime installed: $VERSION"
info 'authentication remains machine-local and unproven; no route was qualified or enabled'
