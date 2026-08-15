#!/usr/bin/env bash
set -euo pipefail

# Installs/migrates the generic serial implementation recurrence (#210) as a
# systemd --user service/timer. Mirrors the accepted
# install-event-polling-user-service.sh / install-claude-runner-systemd.sh
# pattern: source/install work (copying unit files, writing the env file,
# daemon-reload) never itself activates or disables a live timer -- only the
# explicit --enable, --migrate-from-modelspend-only or --rollback-to-modelspend-only
# flags touch systemd's active/enabled state, and each of those does so
# atomically so the generic and legacy ModelSpend-only timer can never both be
# live authorities at once.

usage() {
  cat <<'USAGE'
Usage:
  scripts/install-agent-runner-implementation-systemd.sh \
    --agent-runner-home /absolute/path/to/agent-runner \
    --project-registry /absolute/path/to/projects.json \
    [--enable]
    [--migrate-from-modelspend-only]
    [--rollback-to-modelspend-only]
    [--dry-run]

Installs the generic agent-runner-implementation.service/.timer unit files
and env file for the #210 serial implementation recurrence. By itself this
only copies files and runs `systemctl --user daemon-reload`; it never
enables, starts, disables or stops any unit.

  --enable
      Additionally enable+start agent-runner-implementation.timer. Refuses
      if the legacy modelspend-claude-runner.timer is still enabled or
      active, since the generic recurrence already probes the ModelSpend
      project through the managed registry and running both timers would
      let two schedulers select and invoke work concurrently.

  --migrate-from-modelspend-only
      Atomically disable the legacy modelspend-claude-runner.timer and
      enable+start the generic agent-runner-implementation.timer, so at no
      point are both timers simultaneously enabled. Fails closed (making no
      change) if either the disable or the enable step fails.

  --rollback-to-modelspend-only
      The inverse migration: atomically disable
      agent-runner-implementation.timer and re-enable+start
      modelspend-claude-runner.timer. Requires the legacy unit files to
      still be present (this script never removes them).

  --dry-run
      Print the actions that would be taken (files that would be written,
      systemctl calls that would run) without changing any file or systemd
      state. Combine with any of the flags above to preview that action.

Exactly one of --enable / --migrate-from-modelspend-only /
--rollback-to-modelspend-only may be given. None of them may be combined.
USAGE
}

AGENT_RUNNER_HOME=""
PROJECT_REGISTRY=""
ACTION="install-only"
DRY_RUN=0
ACTION_EXPLICIT=0

fail() {
  printf '[install-agent-runner-implementation-systemd] ERROR: %s\n' "$1" >&2
  exit 1
}

info() {
  printf '[install-agent-runner-implementation-systemd] %s\n' "$1"
}

set_action() {
  [[ "$ACTION_EXPLICIT" -eq 0 ]] || fail 'only one of --enable / --migrate-from-modelspend-only / --rollback-to-modelspend-only may be given'
  ACTION="$1"
  ACTION_EXPLICIT=1
}

while (($#)); do
  case "$1" in
    --agent-runner-home) AGENT_RUNNER_HOME="${2:-}"; shift 2 ;;
    --project-registry) PROJECT_REGISTRY="${2:-}"; shift 2 ;;
    --enable) set_action "enable"; shift ;;
    --migrate-from-modelspend-only) set_action "migrate"; shift ;;
    --rollback-to-modelspend-only) set_action "rollback"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$AGENT_RUNNER_HOME" ]] || fail '--agent-runner-home is required'
[[ "$AGENT_RUNNER_HOME" = /* ]] || fail 'agent runner path must be absolute'
[[ "$(id -u)" -ne 0 ]] || fail 'do not run this installer as root'

AGENT_RUNNER_HOME="$(realpath "$AGENT_RUNNER_HOME")"
git -C "$AGENT_RUNNER_HOME" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail 'agent runner home is not a git checkout'
[[ -f "$AGENT_RUNNER_HOME/bin/run-implementation-recurrence.sh" ]] || fail 'generic implementation recurrence wrapper is missing'
[[ -f "$AGENT_RUNNER_HOME/systemd/user/agent-runner-implementation.service" ]] || fail 'generic implementation service unit is missing'
[[ -f "$AGENT_RUNNER_HOME/systemd/user/agent-runner-implementation.timer" ]] || fail 'generic implementation timer unit is missing'
command -v systemctl >/dev/null 2>&1 || fail 'systemctl not found'

if [[ "$ACTION" != "rollback" ]]; then
  [[ -n "$PROJECT_REGISTRY" ]] || fail '--project-registry is required unless --rollback-to-modelspend-only is the only action'
  [[ "$PROJECT_REGISTRY" = /* ]] || fail 'project registry path must be absolute'
  PROJECT_REGISTRY="$(realpath "$PROJECT_REGISTRY")"
  [[ -f "$PROJECT_REGISTRY" ]] || fail 'project registry file is missing'
fi

UNIT_SOURCE="$AGENT_RUNNER_HOME/systemd/user"
UNIT_TARGET="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config/agent-runner"
ENV_FILE="$ENV_DIR/implementation-recurrence.env"
GENERIC_TIMER="agent-runner-implementation.timer"
LEGACY_TIMER="modelspend-claude-runner.timer"

install_unit_files() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "--dry-run: would install $UNIT_TARGET/agent-runner-implementation.service"
    info "--dry-run: would install $UNIT_TARGET/agent-runner-implementation.timer"
    info "--dry-run: would write $ENV_FILE"
    info "--dry-run: would run systemctl --user daemon-reload"
    return 0
  fi

  mkdir -p "$UNIT_TARGET" "$ENV_DIR"
  chmod 700 "$ENV_DIR"

  install -m 0644 \
    "$UNIT_SOURCE/agent-runner-implementation.service" \
    "$UNIT_TARGET/agent-runner-implementation.service"
  install -m 0644 \
    "$UNIT_SOURCE/agent-runner-implementation.timer" \
    "$UNIT_TARGET/agent-runner-implementation.timer"

  umask 077
  cat >"$ENV_FILE" <<EOF
AGENT_RUNNER_HOME=$AGENT_RUNNER_HOME
AGENT_RUNNER_PROJECT_REGISTRY=$PROJECT_REGISTRY
EOF
  chmod 600 "$ENV_FILE"

  systemctl --user daemon-reload
}

legacy_timer_live() {
  systemctl --user is-enabled --quiet "$LEGACY_TIMER" 2>/dev/null \
    || systemctl --user is-active --quiet "$LEGACY_TIMER" 2>/dev/null
}

generic_timer_live() {
  systemctl --user is-enabled --quiet "$GENERIC_TIMER" 2>/dev/null \
    || systemctl --user is-active --quiet "$GENERIC_TIMER" 2>/dev/null
}

assert_at_most_one_live() {
  if legacy_timer_live && generic_timer_live; then
    fail "both $LEGACY_TIMER and $GENERIC_TIMER are live authorities; refusing -- only one implementation timer may schedule work at a time"
  fi
}

case "$ACTION" in
  install-only)
    install_unit_files
    info "Installed unit files and env file; no timer was enabled, started, disabled or stopped"
    ;;

  enable)
    install_unit_files
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "--dry-run: would refuse if $LEGACY_TIMER is still enabled or active"
      info "--dry-run: would enable+start $GENERIC_TIMER"
      exit 0
    fi
    if legacy_timer_live; then
      fail "$LEGACY_TIMER is still enabled or active; use --migrate-from-modelspend-only to switch over atomically, or disable it manually first"
    fi
    systemctl --user enable --now "$GENERIC_TIMER"
    assert_at_most_one_live
    info "Enabled $GENERIC_TIMER"
    ;;

  migrate)
    install_unit_files
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "--dry-run: would disable --now $LEGACY_TIMER, then enable --now $GENERIC_TIMER"
      exit 0
    fi
    systemctl --user disable --now "$LEGACY_TIMER" 2>/dev/null || true
    if ! systemctl --user enable --now "$GENERIC_TIMER"; then
      fail "failed to enable $GENERIC_TIMER after disabling $LEGACY_TIMER; machine now has no live implementation timer -- rerun --migrate-from-modelspend-only or restore manually"
    fi
    assert_at_most_one_live
    info "Migrated: $LEGACY_TIMER disabled, $GENERIC_TIMER enabled"
    ;;

  rollback)
    [[ -f "$UNIT_TARGET/$LEGACY_TIMER" ]] || fail "rollback target $UNIT_TARGET/$LEGACY_TIMER is not installed; nothing to roll back to"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "--dry-run: would disable --now $GENERIC_TIMER, then enable --now $LEGACY_TIMER"
      exit 0
    fi
    systemctl --user disable --now "$GENERIC_TIMER" 2>/dev/null || true
    if ! systemctl --user enable --now "$LEGACY_TIMER"; then
      fail "failed to enable $LEGACY_TIMER after disabling $GENERIC_TIMER; machine now has no live implementation timer -- rerun --rollback-to-modelspend-only or restore manually"
    fi
    assert_at_most_one_live
    info "Rolled back: $GENERIC_TIMER disabled, $LEGACY_TIMER enabled"
    ;;
esac

printf 'agent_runner_home=%s\n' "$AGENT_RUNNER_HOME"
[[ -n "$PROJECT_REGISTRY" ]] && printf 'project_registry=%s\n' "$PROJECT_REGISTRY"
if [[ "$DRY_RUN" -eq 0 ]]; then
  printf 'generic_timer_enabled=%s\n' "$(systemctl --user is-enabled "$GENERIC_TIMER" 2>/dev/null || true)"
  printf 'legacy_timer_enabled=%s\n' "$(systemctl --user is-enabled "$LEGACY_TIMER" 2>/dev/null || true)"
fi
