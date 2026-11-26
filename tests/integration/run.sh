#!/usr/bin/env bash
# Integratietest. Alleen de orchestrator draait dit, na elke merge op main.
# Start Postgres en Redis (label panel.test=true), het panel (next dev, echte backend),
# bouwt de daemon; de test zelf start en herstart de daemon.
# Raakt de echte installatie niet: eigen poorten, eigen DATA_DIR, PANEL_INSTANCE=it-<pid>.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

work="$root/tests/integration/.work/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$work/data"
instance="it-$$"
pg="panel-it-pg-$$"
redis="panel-it-redis-$$"
panel_pid=""

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }

cleanup() {
  set +e
  [ -n "$panel_pid" ] && kill "$panel_pid" 2>/dev/null
  pkill -f "next dev -p ${PANEL_PORT:-x}" 2>/dev/null
  docker rm -f "$pg" "$redis" >/dev/null 2>&1
  # Alles wat de daemon voor deze run aanmaakte
  ids=$(docker ps -aq --filter label=panel.test=true --filter "label=panel.instance=$instance")
  [ -n "$ids" ] && docker rm -f $ids >/dev/null
  nets=$(docker network ls -q --filter label=panel.test=true --filter "label=panel.instance=$instance")
  [ -n "$nets" ] && docker network rm $nets >/dev/null
  echo "logs: $work"
}
trap cleanup EXIT

echo "== infra"
docker run -d --name "$pg" --label panel.test=true -e POSTGRES_PASSWORD=test -e POSTGRES_DB=panel -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
docker run -d --name "$redis" --label panel.test=true -p 127.0.0.1::6379 redis:7-alpine >/dev/null
pg_port=$(docker port "$pg" 5432/tcp | head -1 | cut -d: -f2)
redis_port=$(docker port "$redis" 6379/tcp | head -1 | cut -d: -f2)
for _ in $(seq 1 60); do docker exec "$pg" psql -U postgres -d panel -c 'select 1' >/dev/null 2>&1 && break; sleep 0.5; done

export PANEL_PORT=$(free_port)
export DAEMON_PORT=$(free_port)
export SFTP_PORT=$(free_port)
export IT_GAME_PORT=$(free_port)

export PANEL_DOMAIN=panel.test
export NODE_DOMAIN=node1.test
export ACME_EMAIL=it@panel.test
export OWNER_DISCORD_ID=200000000000000001
export DISCORD_CLIENT_ID=it-client
export DISCORD_CLIENT_SECRET=it-secret
export PANEL_ENCRYPTION_KEY=$(openssl rand -base64 32)
export NODE_TOKEN=$(openssl rand -hex 32)
export NODE_PUBLIC_IP=127.0.0.1
export DATABASE_URL="postgres://postgres:test@127.0.0.1:${pg_port}/panel"
export REDIS_URL="redis://127.0.0.1:${redis_port}"
export PANEL_URL="http://127.0.0.1:${PANEL_PORT}"
export DAEMON_URL="http://127.0.0.1:${DAEMON_PORT}"
export DAEMON_SOCKET="$work/daemon.sock"
export DATA_DIR="$work/data"
export CADDY_ADMIN_URL=""
export TEMPLATES_DIR="$root/templates"
export PANEL_INSTANCE="$instance"
export DOCKER_EXTRA_LABELS="panel.test=true"
export PANEL_INSECURE_TEST_LOGIN=1

echo "== migraties"
pnpm --filter @panel/db exec tsx migrate.ts

echo "== daemon bouwen"
(cd daemon && go build -o "$work/panel-daemon" ./cmd/panel-daemon)

echo "== panel starten op :$PANEL_PORT"
(cd apps/web && exec pnpm exec next dev -p "$PANEL_PORT" > "$work/panel.log" 2>&1) &
panel_pid=$!
for _ in $(seq 1 120); do
  curl -sf "http://127.0.0.1:${PANEL_PORT}/api/trpc/auth.branding" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:${PANEL_PORT}/api/trpc/auth.branding" >/dev/null || { echo "panel start niet"; tail -50 "$work/panel.log"; exit 1; }

export IT_PANEL_URL="$PANEL_URL"
export IT_DAEMON_URL="$DAEMON_URL"
export IT_DAEMON_BIN="$work/panel-daemon"
export IT_DAEMON_LOG="$work/daemon.log"

echo "== tests"
pnpm --filter @panel/integration run integration "$@"
