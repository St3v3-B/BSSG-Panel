#!/usr/bin/env bash
# Browser-e2e: echt panel (next dev) + echte daemon + Docker, bediend met Playwright/Chromium.
# Hergebruikt de infra van tests/lib/env.sh. Chromium komt in tests/e2e/.browsers (niet systeembreed).
# E2E_HOLD=1: start alleen de omgeving, schrijf de variabelen naar $work/exports.sh en wacht (ontwikkelen).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
IT_KIND=e2e
source "$root/tests/lib/env.sh"
daemon_pid=""
cleanup_all() {
  [ -n "$daemon_pid" ] && kill "$daemon_pid" 2>/dev/null && wait "$daemon_pid" 2>/dev/null
  pkill -x -f "$work/panel-daemon" 2>/dev/null
  cleanup
}
trap cleanup_all EXIT

export PLAYWRIGHT_BROWSERS_PATH="$root/tests/e2e/.browsers"
[ -d "$PLAYWRIGHT_BROWSERS_PATH" ] || (cd tests/e2e && pnpm exec playwright install chromium)

export LD_LIBRARY_PATH="$root/tests/e2e/.libs/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
if ldd "$PLAYWRIGHT_BROWSERS_PATH"/chromium_headless_shell-*/*/chrome-headless-shell | grep -q 'not found'; then
  bash tests/e2e/setup-libs.sh
fi

echo "== daemon starten"
"$work/panel-daemon" > "$work/daemon.log" 2>&1 &
daemon_pid=$!
for _ in $(seq 1 60); do
  curl -sf -H "authorization: Bearer $NODE_TOKEN" "$DAEMON_URL/api/system" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf -H "authorization: Bearer $NODE_TOKEN" "$DAEMON_URL/api/system" >/dev/null || { echo "daemon start niet"; tail -30 "$work/daemon.log"; exit 1; }

if [ "${E2E_HOLD:-}" = 1 ]; then
  export -p > "$work/exports.sh"
  echo "hold: source $work/exports.sh ; Ctrl-C om op te ruimen"
  while true; do sleep 3600; done
fi

echo "== e2e"
cd tests/e2e
pnpm exec playwright test "$@"
