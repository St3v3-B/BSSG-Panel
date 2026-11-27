#!/usr/bin/env bash
# Gedeelde infra voor tests/integration/run.sh en tests/e2e/run.sh (source, niet uitvoeren).
# Verwacht: $root (repo-root) en $IT_KIND ("integration" of "e2e"). Zet daarna `trap cleanup EXIT`.
work="$root/tests/$IT_KIND/.work/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$work/data"
instance="$IT_KIND-$$"
pg="panel-$IT_KIND-pg-$$"
redis="panel-$IT_KIND-redis-$$"
mariadb="panel-$IT_KIND-mariadb-$$"
panel_pid=""

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }

cleanup() {
  set +e
  [ -n "$panel_pid" ] && kill "$panel_pid" 2>/dev/null
  pkill -f "next dev -p ${PANEL_PORT:-x}" 2>/dev/null
  docker rm -f "$pg" "$redis" "$mariadb" >/dev/null 2>&1
  # Alles wat de daemon voor deze run aanmaakte
  ids=$(docker ps -aq --filter label=panel.test=true --filter "label=panel.instance=$instance")
  [ -n "$ids" ] && docker rm -f $ids >/dev/null
  nets=$(docker network ls -q --filter label=panel.test=true --filter "label=panel.instance=$instance")
  [ -n "$nets" ] && docker network rm $nets >/dev/null
  echo "logs: $work"
}

echo "== infra"
docker run -d --name "$pg" --label panel.test=true -e POSTGRES_PASSWORD=test -e POSTGRES_DB=panel -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
docker run -d --name "$redis" --label panel.test=true -p 127.0.0.1::6379 redis:7-alpine >/dev/null
mariadb_pw=$(openssl rand -hex 16)
docker run -d --name "$mariadb" --label panel.test=true --label "panel.instance=$instance" -e MARIADB_ROOT_PASSWORD="$mariadb_pw" -p 127.0.0.1::3306 mariadb:11 >/dev/null
pg_port=$(docker port "$pg" 5432/tcp | head -1 | cut -d: -f2)
redis_port=$(docker port "$redis" 6379/tcp | head -1 | cut -d: -f2)
for _ in $(seq 1 60); do docker exec "$pg" psql -U postgres -d panel -c 'select 1' >/dev/null 2>&1 && break; sleep 0.5; done

mariadb_port=$(docker port "$mariadb" 3306/tcp | head -1 | cut -d: -f2)
for _ in $(seq 1 90); do docker exec "$mariadb" healthcheck.sh --connect >/dev/null 2>&1 && break; sleep 1; done
export MARIADB_ROOT_PASSWORD="$mariadb_pw"
export MARIADB_CONTAINER="$mariadb"
export MARIADB_ADMIN_ADDR="127.0.0.1:${mariadb_port}"
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
mkdir -p "$work/templates"
cp -r "$root/templates/game" "$root/templates/web" "$work/templates/"
cp "$root/tests/integration/templates/game/"*.yaml "$work/templates/game/"
[ -d "$root/tests/$IT_KIND/templates/game" ] && cp "$root/tests/$IT_KIND/templates/game/"*.yaml "$work/templates/game/"
export TEMPLATES_DIR="$work/templates"
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
export IT_WORK="$work"
