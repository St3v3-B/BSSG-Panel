#!/usr/bin/env bash
# Tests for deploy/uninstall.sh with fake docker/systemctl/id on PATH and a temporary PANEL_ROOT.
# Touches nothing on the system (no real docker calls, no /etc/panel, no systemd).   deploy/test-uninstall.sh
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UN="$SRC/deploy/uninstall.sh"
W="$(mktemp -d -t panel-uninstall-test-XXXXXX)"
trap 'rm -rf "$W"' EXIT
FAILS=0
ok()   { printf '  ok   %s\n' "$*"; }
bad()  { printf '  FAIL %s\n' "$*" >&2; FAILS=$((FAILS + 1)); }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }

# ---------------------------------------------------------------- shims
mkdir -p "$W/bin"
cat > "$W/bin/docker" <<'SHIM'
#!/usr/bin/env bash
# Fake docker: logs every call; list commands only return objects when filtered on BOTH labels of the
# expected instance (so an unfiltered or half-filtered call would show up as "foreign" objects).
echo "docker $*" >> "$SHIM_LOG"
[ "$1" = info ] && [ -n "${SHIM_DOCKER_DOWN:-}" ] && exit 1
args=" $* "
mine=0
[[ "$args" == *" label=panel.managed=true "* && "$args" == *" label=panel.instance=$SHIM_INSTANCE "* ]] && mine=1
case "$1 ${2:-}" in
  "ps -a")
    if [ "$mine" = 1 ]; then
      if [[ "$args" == *" -aq "* || "$args" == *" -q "* ]]; then printf 'c1\nc2\nc3\nc4\n'
      else printf 'panel-web\npanel-postgres\npanel-mariadb\npanel-0123abcd-site\n'; fi
    else printf 'ntp-pool-1\n'; fi ;;
  "ps -aq")
    if [ "$mine" = 1 ]; then printf 'c1\nc2\nc3\nc4\n'; else printf 'foreign1\n'; fi ;;
  "network ls")
    if [ "$mine" = 1 ]; then
      if [[ "$args" == *" -q "* ]]; then printf 'n1\nn2\n'; else printf 'panel-backend\npanel-site-0123abcd\n'; fi
    else printf 'bridge\n'; fi ;;
  "volume ls")
    if [ "$mine" = 1 ]; then
      if [[ "$args" == *" -q "* ]]; then printf 'panel-postgres-data\npanel-mariadb-data\n'; else printf 'panel-postgres-data\npanel-mariadb-data\n'; fi
    else printf 'foreignvol\n'; fi ;;
  "image ls")
    if [ "$mine" = 1 ]; then printf 'img1\nimg1\n'; else printf 'foreignimg\n'; fi ;;
  "exec "*)
    [ -z "${SHIM_FAIL_DUMP:-}" ] || exit 1
    echo "-- dump from $2" ;;
esac
exit 0
SHIM
cat > "$W/bin/systemctl" <<'SHIM'
#!/usr/bin/env bash
echo "systemctl $*" >> "$SHIM_LOG"
SHIM
cat > "$W/bin/id" <<'SHIM'
#!/usr/bin/env bash
[ "${1:-}" = -u ] && { echo 0; exit 0; }
exec /usr/bin/id "$@"
SHIM
chmod +x "$W/bin/"*
export PATH="$W/bin:$PATH" SHIM_LOG="$W/calls.log"

setup() { # [instance]
  local inst="${1:-main}"
  rm -rf "$W/root" "$W/calls.log" "$W/out"; : > "$W/calls.log"
  export PANEL_ROOT="$W/root" SHIM_INSTANCE="$inst"
  unset ENV_FILE
  mkdir -p "$PANEL_ROOT/etc/panel" "$PANEL_ROOT/etc/systemd/system" "$PANEL_ROOT/usr/local/bin" \
    "$PANEL_ROOT/var/lib/panel/servers/0123abcd" "$PANEL_ROOT/root"
  printf 'PANEL_DOMAIN=panel.test\nNODE_DOMAIN=node1.test\nPANEL_INSTANCE=%s\nDATA_DIR=/var/lib/panel\nMARIADB_ROOT_PASSWORD=secretsecret1234\n' "$inst" \
    > "$PANEL_ROOT/etc/panel/panel.env"
  echo unit > "$PANEL_ROOT/etc/systemd/system/panel-daemon.service"
  echo bin > "$PANEL_ROOT/usr/local/bin/panel-daemon"
  echo world > "$PANEL_ROOT/var/lib/panel/servers/0123abcd/level.dat"
}
calls() { grep -c -- "$1" "$W/calls.log"; }
no_call() { ! grep -q -- "$1" "$W/calls.log"; }
exists() { [ -e "$PANEL_ROOT/$1" ]; }
# Every docker list call must be filtered on both labels of the expected instance.
lists_filtered() {
  ! grep -E '^docker (ps|network ls|volume ls|image ls)' "$W/calls.log" \
    | grep -v -- "--filter label=panel.managed=true --filter label=panel.instance=$SHIM_INSTANCE" | grep -q .
}
# Every docker rm only got ids returned by a filtered list (never the "foreign" ones).
# Calls that change something.
changes() { grep -cE '^docker ((network|volume|image) )?rm |^docker exec |^systemctl' "$W/calls.log"; }
no_foreign() { ! grep -E '^docker ((network|volume|image) )?rm |^docker exec ' "$W/calls.log" | grep -qE 'foreign|ntp-pool|bridge'; }

echo "== dry-run changes nothing"
setup
"$UN" --dry-run --purge --backup >"$W/out" 2>&1; rc=$?
check "exit 0" test "$rc" = 0
check "lists the containers" grep -q "panel-0123abcd-site" "$W/out"
check "says nothing changed" grep -q "nothing was changed" "$W/out"
check "no docker rm/exec, no systemctl" test "$(changes)" = 0
check "files kept" exists etc/panel/panel.env -a -e "$PANEL_ROOT/usr/local/bin/panel-daemon" -a -e "$PANEL_ROOT/var/lib/panel/servers/0123abcd/level.dat"
check "no backup dir created" test -z "$(ls "$PANEL_ROOT/root")"
check "list calls filtered on both labels" lists_filtered

echo "== no terminal and no --yes: refused"
setup
"$UN" </dev/null >"$W/out" 2>&1; rc=$?
check "exit non-zero" test "$rc" != 0
check "mentions --yes" grep -q -- "--yes" "$W/out"
check "nothing removed" test "$(changes)" = 0 -a -e "$PANEL_ROOT/usr/local/bin/panel-daemon"

if command -v script >/dev/null; then
  echo "== interactive confirmation (pty)"
  setup
  printf 'panel.wrong\n' | script -qec "$UN" /dev/null >"$W/out" 2>&1; rc=$?
  check "wrong domain: exit non-zero" test "$rc" != 0
  check "wrong domain: nothing removed" test "$(changes)" = 0 -a -e "$PANEL_ROOT/usr/local/bin/panel-daemon"
  setup
  printf 'panel.test\n' | script -qec "$UN" /dev/null >"$W/out" 2>&1; rc=$?
  check "right domain: exit 0" test "$rc" = 0
  check "right domain: daemon removed" test ! -e "$PANEL_ROOT/usr/local/bin/panel-daemon"
fi

echo "== --yes: removes daemon, containers, networks, images; keeps data"
setup
"$UN" --yes >"$W/out" 2>&1; rc=$?
check "exit 0" test "$rc" = 0
check "systemctl disable --now panel-daemon" test "$(calls 'systemctl disable --now panel-daemon.service')" = 1
check "systemctl daemon-reload" test "$(calls 'systemctl daemon-reload')" = 1
check "unit and binary removed" test ! -e "$PANEL_ROOT/etc/systemd/system/panel-daemon.service" -a ! -e "$PANEL_ROOT/usr/local/bin/panel-daemon"
check "docker rm -f -v of the labelled containers" grep -qx 'docker rm -f -v c1 c2 c3 c4' "$W/calls.log"
check "docker network rm n1 n2" grep -qx 'docker network rm n1 n2' "$W/calls.log"
check "docker image rm -f img1 (deduplicated)" grep -qx 'docker image rm -f img1' "$W/calls.log"
check "no volume rm" no_call 'volume rm'
check "no dump without --backup" no_call 'docker exec'
check "/etc/panel and data kept" exists etc/panel/panel.env -a -e "$PANEL_ROOT/var/lib/panel/servers/0123abcd/level.dat"
check "list calls filtered on both labels" lists_filtered
check "never a foreign object" no_foreign
check "daemon stopped before containers removed" test "$(grep -n 'systemctl disable' "$W/calls.log" | cut -d: -f1)" -lt "$(grep -n '^docker rm ' "$W/calls.log" | cut -d: -f1)"

echo "== --yes --purge --backup=DIR"
setup
"$UN" --yes --purge --backup="$W/root/bk" >"$W/out" 2>&1; rc=$?
check "exit 0" test "$rc" = 0
check "postgres dump written" grep -q "dump from panel-postgres" "$W/root/bk/postgres.sql"
check "mariadb dump written" grep -q "dump from panel-mariadb" "$W/root/bk/mariadb.sql"
check "panel.env copied, mode 600" test "$(stat -c %a "$W/root/bk/panel.env")" = 600
check "backup dir mode 700" test "$(stat -c %a "$W/root/bk")" = 700
check "password not on a docker command line" no_call 'secretsecret1234'
check "dumps before any rm" test "$(grep -n '^docker exec' "$W/calls.log" | tail -1 | cut -d: -f1)" -lt "$(grep -n '^docker rm ' "$W/calls.log" | cut -d: -f1)"
check "docker volume rm of the labelled volumes" grep -qx 'docker volume rm panel-postgres-data panel-mariadb-data' "$W/calls.log"
check "/etc/panel removed" test ! -e "$PANEL_ROOT/etc/panel"
check "data dir removed" test ! -e "$PANEL_ROOT/var/lib/panel"
check "backup itself kept" test -f "$W/root/bk/postgres.sql"
check "never a foreign object" no_foreign

echo "== failed dump aborts before removing anything"
setup
SHIM_FAIL_DUMP=1 "$UN" --yes --purge --backup="$W/root/bk2" >"$W/out" 2>&1; rc=$?
check "exit non-zero" test "$rc" != 0
check "nothing removed" test "$(grep -vc '^docker exec ' <(grep -E '^docker ((network|volume|image) )?rm |^docker exec |^systemctl' "$W/calls.log"))" = 0 -a -e "$PANEL_ROOT/var/lib/panel/servers/0123abcd/level.dat"
check "no partial dump left" test ! -e "$W/root/bk2/postgres.sql" -a ! -e "$W/root/bk2/postgres.sql.part"

echo "== instance from panel.env (and --instance)"
setup ops-test-1
"$UN" --yes >"$W/out" 2>&1; rc=$?
check "exit 0" test "$rc" = 0
check "filters on panel.instance=ops-test-1" lists_filtered
check "containers removed" grep -qx 'docker rm -f -v c1 c2 c3 c4' "$W/calls.log"
setup ops-test-1
"$UN" --yes --instance 'x;rm -rf /' >"$W/out" 2>&1; rc=$?
check "invalid --instance refused" test "$rc" != 0 -a "$(changes)" = 0

echo "== dangerous DATA_DIR refused"
setup
sed -i 's|^DATA_DIR=.*|DATA_DIR=/|' "$PANEL_ROOT/etc/panel/panel.env"
"$UN" --yes --purge >"$W/out" 2>&1; rc=$?
check "exit non-zero" test "$rc" != 0
check "nothing removed" test "$(changes)" = 0

echo "== docker not running: refused"
setup
SHIM_DOCKER_DOWN=1 "$UN" --yes --purge >"$W/out" 2>&1; rc=$?
check "exit non-zero, nothing removed" test "$rc" != 0 -a "$(changes)" = 0 -a -e "$PANEL_ROOT/usr/local/bin/panel-daemon"

echo "== ENV_FILE override"
setup
mv "$PANEL_ROOT/etc/panel/panel.env" "$W/other.env"
ENV_FILE="$W/other.env" "$UN" --dry-run >"$W/out" 2>&1; rc=$?
check "reads ENV_FILE (domain shown)" test "$rc" = 0 && grep -q "panel panel.test" "$W/out"

echo
if [ "$FAILS" = 0 ]; then echo "all ok"; else echo "$FAILS failed"; exit 1; fi
