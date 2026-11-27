#!/usr/bin/env bash
# Integratietest. Alleen de orchestrator draait dit, na elke merge op main.
# Start Postgres en Redis (label panel.test=true), het panel (next dev, echte backend),
# bouwt de daemon; de test zelf start en herstart de daemon.
# Raakt de echte installatie niet: eigen poorten, eigen DATA_DIR, PANEL_INSTANCE=it-<pid>.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
IT_KIND=integration
source "$root/tests/lib/env.sh"
trap cleanup EXIT

echo "== tests"
pnpm --filter @panel/integration run integration "$@"
