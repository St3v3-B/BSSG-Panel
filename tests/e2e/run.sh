#!/usr/bin/env bash
# Browser-e2e: echt panel (next dev) + echte daemon + Docker, bediend met Playwright/Chromium.
# Hergebruikt de infra van tests/lib/env.sh. Chromium komt in tests/e2e/.browsers (niet systeembreed).
# E2E_HOLD=1: start alleen de omgeving, schrijf de variabelen naar $work/exports.sh en wacht (ontwikkelen).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
IT_KIND=e2e
# phpMyAdmin-koppeling aan (de spec start zelf een phpMyAdmin-container uit deploy/phpmyadmin, zie fakes.ts).
export PMA_SHARED_SECRET=$(openssl rand -hex 32)
export PMA_BLOWFISH_SECRET=$(openssl rand -hex 32)
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

echo "== phpMyAdmin-image (deploy/phpmyadmin) bouwen"
if docker build -q --label panel.test=true -t panel-phpmyadmin:e2e deploy/phpmyadmin >"$work/pma-build.log" 2>&1; then
  export IT_PMA_IMAGE=panel-phpmyadmin:e2e
else
  echo "phpMyAdmin-image niet gebouwd (zie $work/pma-build.log): de phpMyAdmin-spec wordt overgeslagen"
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
