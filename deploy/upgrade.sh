#!/usr/bin/env bash
# Upgrades the installed panel to a newer commit of the repo and rolls back when it fails.
#
#   sudo deploy/upgrade.sh                  # to origin/main
#   sudo deploy/upgrade.sh --ref <sha>      # to a specific commit (hex sha) or origin/main
#   deploy/upgrade.sh --check               # only report available updates
#   deploy/upgrade.sh --dry-run             # show what would happen, change nothing
#
# Steps: lock -> refuse local changes -> git fetch -> record previous commit -> move to target ->
# `install.sh --non-interactive` -> health check (panel, daemon, compose services) -> on any failure:
# back to the previous commit + install.sh again, exit 1.
#
# The checkout is the directory install.sh was run from (PANEL_REPO_DIR in /etc/panel/panel.env;
# default: the repo this script lives in). The panel starts this script detached through the daemon
# (POST /api/panel-upgrade, systemd-run), so a restart of the daemon or panel does not kill it.
#
# Files in $PANEL_UPGRADE_DIR (default $DATA_DIR/upgrade = /var/lib/panel/upgrade):
#   status.json   state (idle|running|success|failed|rolled_back), from, to, step, started, finished, error
#   upgrade-<timestamp>.log   (the last UPGRADE_KEEP_LOGS, default 10, are kept)
#   lock          flock; only one upgrade at a time
#
# Environment (mainly for tests): PANEL_ENV_FILE, PANEL_UPGRADE_DIR, UPGRADE_HEALTH_TIMEOUT (seconds,
# default 180), UPGRADE_HEALTH_CMD (replaces the built-in health check), UPGRADE_KEEP_LOGS.
set -euo pipefail

SELF_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${PANEL_ENV_FILE:-/etc/panel/panel.env}"

REF="origin/main"
DRY_RUN=0
CHECK=0
ALLOW_DIVERGE=0

usage() {
  cat <<'EOF'
Usage: upgrade.sh [--ref origin/main|<hex sha>] [--check] [--dry-run] [--allow-diverge]
  --ref REF          target: origin/main (default) or a hex commit sha (7-40 characters)
  --check            fetch and report available updates; change nothing
  --dry-run          run the checks and print the steps; change nothing
  --allow-diverge    also upgrade when the current commit is not an ancestor of the target
  -h, --help         this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a value}"; shift ;;
    --ref=*) REF="${1#--ref=}" ;;
    --check) CHECK=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --allow-diverge) ALLOW_DIVERGE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "$REF" != "origin/main" ]] && ! [[ "$REF" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "error: --ref must be origin/main or a hex commit sha" >&2; exit 2
fi

# Value of KEY from the env file (without sourcing it).
envval() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

REPO="${PANEL_REPO_DIR:-$(envval PANEL_REPO_DIR)}"
[ -n "$REPO" ] || REPO="$SELF_REPO"
DATA_DIR="${DATA_DIR:-$(envval DATA_DIR)}"; DATA_DIR="${DATA_DIR:-/var/lib/panel}"
UPGRADE_DIR="${PANEL_UPGRADE_DIR:-$DATA_DIR/upgrade}"
STATUS="$UPGRADE_DIR/status.json"
KEEP="${UPGRADE_KEEP_LOGS:-10}"

say()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
git_() { git -C "$REPO" -c safe.directory="$REPO" "$@"; }

[ -d "$REPO/.git" ] || die "$REPO is not a git checkout (PANEL_REPO_DIR in $ENV_FILE)"
[ -x "$REPO/deploy/install.sh" ] || die "$REPO/deploy/install.sh is missing"
git_ remote get-url origin >/dev/null 2>&1 || die "the checkout has no remote 'origin'"

json_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | tr '\n' ' ' | tr -d '\r' | sed 's/^/"/; s/$/"/'; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---------------------------------------------------------------- status
S_STATE=idle S_FROM="" S_TO="" S_STEP="" S_STARTED="" S_FINISHED="" S_ERROR="" S_LOG="" S_REF=""
write_status() {
  [ "$DRY_RUN" = 1 ] && return 0
  local tmp="$STATUS.tmp.$$"
  {
    printf '{"state":%s,"from":%s,"to":%s,"ref":%s,"step":%s,"started":%s,"finished":%s,"error":%s,"log":%s,"pid":%s}\n' \
      "$(json_str "$S_STATE")" "$(json_str "$S_FROM")" "$(json_str "$S_TO")" "$(json_str "$S_REF")" "$(json_str "$S_STEP")" \
      "$(json_str "$S_STARTED")" "$(json_str "$S_FINISHED")" "$(json_str "$S_ERROR")" "$(json_str "$S_LOG")" "$$"
  } > "$tmp"
  mv -f "$tmp" "$STATUS"
}
step() { S_STEP="$1"; say "== $1"; write_status; }

# ---------------------------------------------------------------- git
current_sha() { git_ rev-parse HEAD; }
fetch() { say "git fetch origin"; git_ fetch --quiet --tags origin; }

resolve_target() {
  local t
  t="$(git_ rev-parse --verify --quiet "$REF^{commit}")" || die "unknown commit: $REF (not found after fetch)"
  if [ "$REF" != "origin/main" ]; then
    # A sha must be on origin/main (not an arbitrary object).
    git_ merge-base --is-ancestor "$t" origin/main 2>/dev/null || die "commit $REF is not part of origin/main"
  fi
  echo "$t"
}

on_branch() { git_ symbolic-ref -q HEAD >/dev/null 2>&1; }

move_to() { # sha
  if on_branch; then git_ reset --hard --quiet "$1"; else git_ checkout --quiet --detach "$1"; fi
}

short() { printf '%.8s' "$1"; }

# ---------------------------------------------------------------- health
health_builtin() {
  local deadline=$((SECONDS + ${UPGRADE_HEALTH_TIMEOUT:-180})) err=""
  local token port instance
  token="${NODE_TOKEN:-$(envval NODE_TOKEN)}"
  port="${DAEMON_PORT:-$(envval DAEMON_PORT)}"; port="${port:-8080}"
  instance="$(envval PANEL_INSTANCE)"; instance="${instance:-main}"
  while :; do
    err=""
    curl -fsS -m 10 -o /dev/null "http://127.0.0.1:3000/api/trpc/auth.branding" 2>/dev/null || err="panel: /api/trpc/auth.branding does not answer 200"
    if [ -z "$err" ]; then
      curl -fsS -m 10 -o /dev/null -H "Authorization: Bearer $token" "http://127.0.0.1:$port/api/system" 2>/dev/null \
        || err="daemon: /api/system does not answer 200"
    fi
    if [ -z "$err" ]; then
      local bad
      bad="$(docker ps -a --filter "label=panel.managed=true" --filter "label=panel.instance=$instance" --filter "label=panel.role=infra" \
        --format '{{.Names}} {{.State}} {{.Status}}' | awk '$2 != "running" || /unhealthy|starting\)/ {print $1}' | tr '\n' ' ')"
      [ -z "$bad" ] || err="compose services not healthy: $bad"
    fi
    [ -z "$err" ] && return 0
    if [ "$SECONDS" -ge "$deadline" ]; then echo "$err"; return 1; fi
    sleep 5
  done
}

health() {
  if [ -n "${UPGRADE_HEALTH_CMD:-}" ]; then bash -c "$UPGRADE_HEALTH_CMD"; else health_builtin; fi
}

run_install() { (cd "$REPO" && ./deploy/install.sh --non-interactive); }

# ---------------------------------------------------------------- main
CUR="$(current_sha)"

if [ "$CHECK" = 1 ]; then
  fetch
  T="$(git_ rev-parse --verify --quiet "origin/main^{commit}")" || die "origin/main not found"
  n="$(git_ rev-list --count "HEAD..$T")"
  echo "current: $(short "$CUR") $(git_ log -1 --format=%s HEAD)"
  if [ "$n" = 0 ]; then echo "up to date"; else
    echo "$n update(s) available on origin/main:"
    git_ log --format='  %h %s' "HEAD..$T"
  fi
  exit 0
fi

if [ -n "$(git_ status --porcelain --untracked-files=no)" ]; then
  git_ status --short --untracked-files=no >&2
  die "the checkout $REPO has local changes; commit or discard them first (nothing was changed)"
fi

fetch
TARGET="$(resolve_target)"
if on_branch && [ "$ALLOW_DIVERGE" = 0 ] && ! git_ merge-base --is-ancestor "$CUR" "$TARGET"; then
  die "the current commit $(short "$CUR") is not an ancestor of $(short "$TARGET") (local commits?); use --allow-diverge to override"
fi

if [ "$DRY_RUN" = 1 ]; then
  say "dry-run: $(short "$CUR") -> $(short "$TARGET") ($REF)"
  [ "$CUR" = "$TARGET" ] && say "already at the target; nothing to do"
  say "would: lock $UPGRADE_DIR/lock; move checkout to $(short "$TARGET"); run deploy/install.sh --non-interactive; health check; roll back to $(short "$CUR") on failure"
  git_ log --format='  %h %s' "$CUR..$TARGET" | head -30
  exit 0
fi

mkdir -p "$UPGRADE_DIR"
exec 9>"$UPGRADE_DIR/lock"
flock -n 9 || die "another upgrade is already running (lock: $UPGRADE_DIR/lock)"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$UPGRADE_DIR/upgrade-$TS.log"
exec > >(tee -a "$LOG") 2>&1

S_REF="$REF" S_FROM="$CUR" S_TO="$TARGET" S_STARTED="$(now)" S_LOG="$LOG" S_STATE=running
trap 'rc=$?; if [ "$S_STATE" = running ]; then S_STATE=failed; S_ERROR="${S_ERROR:-script aborted (exit $rc) in step: $S_STEP}"; S_FINISHED="$(now)"; write_status; fi' EXIT

# Keep the newest $KEEP logs.
prune() { ls -1t "$UPGRADE_DIR"/upgrade-*.log 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --; }

if [ "$CUR" = "$TARGET" ]; then
  step "already up to date"
  S_STATE=success S_FINISHED="$(now)"; write_status
  prune; exit 0
fi

say "upgrading $(short "$CUR") -> $(short "$TARGET")"
git_ log --format='  %h %s' "$CUR..$TARGET" | head -30 || true

fail=""
step "checkout $(short "$TARGET")"
move_to "$TARGET" || fail="could not move the checkout to $(short "$TARGET")"
if [ -z "$fail" ]; then
  step "install.sh"
  run_install || fail="install.sh failed"
fi
if [ -z "$fail" ]; then
  step "health check"
  if out="$(health 2>&1)"; then say "health check ok"; else fail="health check failed: $out"; fi
fi

if [ -z "$fail" ]; then
  step "done"
  S_STATE=success S_FINISHED="$(now)" S_ERROR=""; write_status
  say "upgrade finished: now at $(short "$TARGET")"
  prune; exit 0
fi

say "FAILED: $fail"
S_ERROR="$fail"
step "rollback to $(short "$CUR")"
rb=""
move_to "$CUR" || rb="could not move back to $(short "$CUR")"
if [ -z "$rb" ]; then run_install || rb="install.sh failed during rollback"; fi
if [ -z "$rb" ]; then
  if out="$(health 2>&1)"; then say "rollback ok"; else rb="health check failed after rollback: $out"; fi
fi
if [ -z "$rb" ]; then
  S_STATE=rolled_back
else
  S_STATE=failed; S_ERROR="$fail; rollback failed: $rb"
fi
S_FINISHED="$(now)"; write_status
prune
say "result: $S_STATE ($S_ERROR)"
exit 1
