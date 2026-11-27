#!/usr/bin/env bash
# Chromium mist op kale servers een paar systeembibliotheken. Zonder root-installatie: haal de
# .deb's op, pak ze uit in tests/e2e/.libs en gebruik LD_LIBRARY_PATH (zie run.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$here/.libs"
(cd "$tmp" && apt-get download libatk1.0-0t64 libatk-bridge2.0-0t64 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libatspi2.0-0t64 libxrender1 libxi6 >/dev/null 2>&1)
for d in "$tmp"/*.deb; do dpkg-deb -x "$d" "$here/.libs"; done
