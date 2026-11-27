#!/usr/bin/env bash
# Tests for deploy/upgrade.sh in temporary git repos with a fake install.sh. Touches nothing on the
# system (no docker, no /etc/panel, no systemd).   deploy/test-upgrade.sh
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W="$(mktemp -d -t panel-upgrade-test-XXXXXX)"
trap 'rm -rf "$W"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@panel.test GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@panel.test
export PANEL_ENV_FILE="$W/none.env" PANEL_UPGRADE_DIR="$W/upg" UPGRADE_KEEP_LOGS=3
FAILS=0
ok()   { printf '  ok   %s\n' "$*"; }
bad()  { printf '  FAIL %s\n' "$*" >&2; FAILS=$((FAILS + 1)); }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
status() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$PANEL_UPGRADE_DIR/status.json"; }

setup() { # creates $W/origin.git and $W/repo (a clone with upgrade.sh and a fake install.sh)
  rm -rf "$W/origin.git" "$W/repo" "$W/work" "$PANEL_UPGRADE_DIR" "$W/installs"
  git init -q --bare -b main "$W/origin.git"
  git clone -q "$W/origin.git" "$W/work" 2>/dev/null
  (cd "$W/work" && mkdir deploy && cp "$SRC/deploy/upgrade.sh" deploy/ && cat > deploy/install.sh <<'INST'
#!/usr/bin/env bash
cd "$(dirname "$0")/.."
echo "$(git rev-parse HEAD) $*" >> "$FAKE_INSTALLS"
[ -z "${ALWAYS_FAIL:-}" ] || { echo "fake install fails (always)"; exit 1; }
[ ! -f deploy/BREAK_INSTALL ] || { echo "fake install fails"; exit 1; }
INST
   chmod +x deploy/*.sh && echo v1 > app.txt && git add -A && git commit -q -m "v1" && git push -q origin HEAD:main)
  git clone -q "$W/origin.git" "$W/repo" 2>/dev/null
  export FAKE_INSTALLS="$W/installs" PANEL_REPO_DIR="$W/repo" UPGRADE_HEALTH_CMD="[ ! -f '$W/repo/deploy/UNHEALTHY' ]"
}
push() { # push FILE-ACTION message  (runs in the work clone)
  (cd "$W/work" && eval "$1" && git add -A && git commit -q -m "$2" && git push -q origin HEAD:main)
}
head_of() { git -C "$W/repo" rev-parse HEAD; }
UP="$W/repo/deploy/upgrade.sh"

echo "== success"
setup; V1="$(head_of)"
push 'echo v2 > app.txt' "v2"; V2="$(git -C "$W/work" rev-parse HEAD)"
"$UP" >"$W/out" 2>&1; rc=$?
check "exit 0" test "$rc" = 0
check "checkout at v2" test "$(head_of)" = "$V2"
check "status success, from/to" test "$(status state) $(status from) $(status to)" = "success $V1 $V2"
check "install.sh ran once with --non-interactive" test "$(wc -l < "$W/installs")" = 1 -a "$(grep -c -- '--non-interactive' "$W/installs")" = 1
check "still on branch main" test "$(git -C "$W/repo" symbolic-ref --short HEAD)" = main
check "log written" test -n "$(ls "$PANEL_UPGRADE_DIR"/upgrade-*.log 2>/dev/null)"
"$UP" >"$W/out" 2>&1; check "second run: already up to date" grep -q "already up to date" "$W/out"

echo "== install fails -> rollback"
setup; V1="$(head_of)"
push 'touch deploy/BREAK_INSTALL' "break install"
# The fake install fails at the new commit and works again after the rollback (marker is gone there).
"$UP" >"$W/out" 2>&1; rc=$?
check "exit 1" test "$rc" = 1
check "back at v1" test "$(head_of)" = "$V1"
check "state rolled_back with error" test "$(status state)" = rolled_back -a -n "$(status error)"
check "install.sh ran again for the rollback" test "$(wc -l < "$W/installs")" = 2

echo "== unhealthy -> rollback"
setup; V1="$(head_of)"
push 'touch deploy/UNHEALTHY' "unhealthy"
"$UP" >"$W/out" 2>&1; rc=$?
check "exit 1" test "$rc" = 1
check "back at v1" test "$(head_of)" = "$V1"
check "state rolled_back, health in error" test "$(status state)" = rolled_back && status error | grep -q "health check failed"

echo "== rollback itself fails"
setup
push 'echo x > app.txt' "x"
ALWAYS_FAIL=1 "$UP" >"$W/out" 2>&1; rc=$?
check "exit 1 and state failed" test "$rc" = 1 -a "$(status state)" = failed
check "error mentions the rollback" status error | grep -q "rollback failed"

echo "== dirty checkout is refused"
setup; V1="$(head_of)"
push 'echo v2 > app.txt' "v2"
echo local > "$W/repo/app.txt"
"$UP" >"$W/out" 2>&1; rc=$?
check "exit 1" test "$rc" = 1
check "clear message" grep -q "local changes" "$W/out"
check "nothing changed" test "$(head_of)" = "$V1" -a ! -e "$W/installs"
git -C "$W/repo" checkout -q app.txt

echo "== lock"
setup
push 'echo v2 > app.txt' "v2"
mkdir -p "$PANEL_UPGRADE_DIR"
( exec 8>"$PANEL_UPGRADE_DIR/lock"; flock -n 8; sleep 5 ) & HOLD=$!
sleep 0.5
"$UP" >"$W/out" 2>&1; rc=$?
check "refused while locked" test "$rc" = 1 && grep -q "already running" "$W/out"
kill "$HOLD" 2>/dev/null; wait "$HOLD" 2>/dev/null

echo "== dry-run and check"
setup; V1="$(head_of)"
push 'echo v2 > app.txt' "second commit"
"$UP" --dry-run >"$W/out" 2>&1; rc=$?
check "dry-run: exit 0, shows the commit" test "$rc" = 0 && grep -q "second commit" "$W/out"
check "dry-run: nothing changed" test "$(head_of)" = "$V1" -a ! -e "$W/installs" -a ! -e "$PANEL_UPGRADE_DIR/status.json"
"$UP" --check >"$W/out" 2>&1; rc=$?
check "check: reports 1 update" test "$rc" = 0 && grep -q "1 update(s) available" "$W/out" && grep -q "second commit" "$W/out"
check "check: nothing changed" test "$(head_of)" = "$V1" -a ! -e "$W/installs"

echo "== ref validation and specific commit"
"$UP" --ref 'main; rm -rf /' >"$W/out" 2>&1; rc=$?
check "invalid ref refused (exit 2)" test "$rc" = 2
V2="$(git -C "$W/work" rev-parse HEAD)"
push 'echo v3 > app.txt' "third"
"$UP" --ref "$V2" >"$W/out" 2>&1; rc=$?
check "upgrade to a given sha" test "$rc" = 0 -a "$(head_of)" = "$V2"

echo "== local commits not on the target are refused"
setup
(cd "$W/repo" && echo l > local.txt && git add -A && git commit -q -m local)
push 'echo v2 > app.txt' "v2"
"$UP" >"$W/out" 2>&1; rc=$?
check "diverged refused" test "$rc" = 1 && grep -q "not an ancestor" "$W/out"

echo "== log pruning (keep 3)"
setup
for i in 1 2 3 4 5; do push "echo w$i > app.txt" "c$i"; "$UP" >/dev/null 2>&1; sleep 1; done
check "3 logs kept" test "$(ls "$PANEL_UPGRADE_DIR"/upgrade-*.log | wc -l)" = 3

echo
[ "$FAILS" = 0 ] && echo "all ok" || { echo "$FAILS failed"; exit 1; }
