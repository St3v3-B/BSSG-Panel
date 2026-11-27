#!/usr/bin/env bash
# Echte twee-machine test (multi-node). Draait het integratie-achtige test-panel lokaal en installeert
# op een tweede machine een remote node met `deploy/install.sh --node-only` (met het installcommando
# dat het panel zelf genereert), en draait daarna tests/multinode/b-remote.test.ts.
#
#   MN_NODE_HOST=203.0.113.7 MN_SSH_KEY=~/.ssh/panel_node2 tests/multinode/run.sh
#
# Vereist: root op de tweede machine via SSH-sleutel, Ubuntu/Debian met systemd (Docker wordt zo nodig
# geïnstalleerd). De tweede machine heeft geen DNS-naam nodig: MN_NODE_DOMAIN (standaard node2.mn.test)
# komt alleen via een tijdelijke regel in /etc/hosts op DEZE machine (verwijderd bij het afsluiten) naar
# het IP; de node serveert met Caddy `local_certs` (eigen CA) en het test-panel draait met
# NODE_TLS_REJECT_UNAUTHORIZED=0 (alleen test). Het daemon op de node bereikt het test-panel via een SSH
# reverse tunnel (PANEL_URL=http://127.0.0.1:<poort>), die bij het afsluiten dicht gaat.
# De echte installatie (panel.instance=main, /etc/panel, de compose-stack) wordt niet geraakt.
#
#   Elke node heeft zijn eigen MariaDB (lokaal: container $mdb, remote: via install.sh --node-only met dezelfde naam).
#   MN_KEEP_REMOTE=1   laat de node na afloop staan (anders: unit, bestanden en containers weg; Docker blijft)
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

: "${MN_NODE_HOST:?MN_NODE_HOST (IP van de tweede machine) ontbreekt}"
: "${MN_SSH_KEY:=$HOME/.ssh/panel_node2}"
export MN_NODE_DOMAIN="${MN_NODE_DOMAIN:-node2.mn.test}"
export MN_SFTP_PORT="${MN_SFTP_PORT:-2022}"
case "$MN_NODE_DOMAIN" in *.test) ;; *) echo "MN_NODE_DOMAIN moet op .test eindigen (test-opzet)"; exit 2 ;; esac

work="$root/tests/multinode/.work/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$work/data"
export MN_WORK="$work"
uniq="$$"
instance="multinode-$uniq"
pg="panel-mn-pg-$uniq"
redis="panel-mn-redis-$uniq"
hosts_tag="# panel-multinode-test-$uniq"
mdb="panel-mariadb-mn-$uniq"   # MariaDB van de lokale testnode; dezelfde containernaam op de remote node (zie hieronder)
export MN_SITE_DOMAIN=dbsite.mn.test
panel_pid=""; tunnel_pid=""
ssh_opts=(-i "$MN_SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15)
rssh() { ssh "${ssh_opts[@]}" "root@$MN_NODE_HOST" "$@"; }

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }

cleanup() {
  set +e
  [ -n "$tunnel_pid" ] && kill "$tunnel_pid" 2>/dev/null
  [ -n "$panel_pid" ] && kill "$panel_pid" 2>/dev/null
  pkill -f "next dev -p ${PANEL_PORT:-x}" 2>/dev/null
  docker rm -f "$pg" "$redis" "$mdb" >/dev/null 2>&1
  ids=$(docker ps -aq --filter label=panel.test=true --filter "label=panel.instance=$instance")
  [ -n "$ids" ] && docker rm -f $ids >/dev/null
  nets=$(docker network ls -q --filter label=panel.test=true --filter "label=panel.instance=$instance")
  [ -n "$nets" ] && docker network rm $nets >/dev/null
  sed -i "\|$hosts_tag|d" /etc/hosts
  if [ "${MN_KEEP_REMOTE:-0}" != 1 ] && [ "${remote_touched:-0}" = 1 ]; then
    echo "== remote opruimen ($MN_NODE_HOST)"
    rssh 'set -x
      systemctl disable --now panel-daemon.service 2>/dev/null
      ids=$(docker ps -aq --filter "label=panel.managed=true"); [ -n "$ids" ] && docker rm -f $ids >/dev/null
      (cd /opt/panel-node 2>/dev/null && PANEL_ENV_FILE=/etc/panel/panel.env docker compose --env-file /etc/panel/panel.env -f deploy/docker-compose.node.yml down -v --rmi local 2>/dev/null)
      nets=$(docker network ls -q --filter "label=panel.managed=true"); [ -n "$nets" ] && docker network rm $nets >/dev/null
      rm -rf /etc/systemd/system/panel-daemon.service /usr/local/bin/panel-daemon /etc/panel /var/lib/panel /run/panel /opt/panel-node
      systemctl daemon-reload
      docker system prune -af --volumes >/dev/null 2>&1
      docker ps -a; docker images; docker volume ls' 2>&1 | tail -15
  fi
  echo "logs: $work"
}
trap cleanup EXIT

echo "== SSH naar $MN_NODE_HOST"
rssh 'echo ok; uname -sr' >/dev/null || { echo "geen SSH-toegang"; exit 1; }
remote_touched=1
rssh 'command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sh >/dev/null 2>&1; }; docker --version; command -v git rsync >/dev/null'

echo "== infra (Postgres, Redis; label panel.test=true + $instance)"
docker run -d --name "$pg" --label panel.test=true --label "panel.instance=$instance" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=panel -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
docker run -d --name "$redis" --label panel.test=true --label "panel.instance=$instance" -p 127.0.0.1::6379 redis:7-alpine >/dev/null
pg_port=$(docker port "$pg" 5432/tcp | head -1 | cut -d: -f2)
redis_port=$(docker port "$redis" 6379/tcp | head -1 | cut -d: -f2)
for _ in $(seq 1 60); do docker exec "$pg" psql -U postgres -d panel -c 'select 1' >/dev/null 2>&1 && break; sleep 0.5; done

docker run -d --name "$mdb" --label panel.test=true --label "panel.instance=$instance" -e MARIADB_ROOT_PASSWORD="mn-root-$uniq" mariadb:11 --skip-name-resolve >/dev/null
export MARIADB_CONTAINER="$mdb"   # overal dezelfde naam (panel registreert hem als host van elke node)
export PANEL_PORT=$(free_port) DAEMON_PORT=$(free_port) SFTP_PORT=$(free_port) IT_GAME_PORT=$(free_port)
export PANEL_DOMAIN=panel.test NODE_DOMAIN=node1.test ACME_EMAIL=it@panel.test
export OWNER_DISCORD_ID=200000000000000001 DISCORD_CLIENT_ID=it-client DISCORD_CLIENT_SECRET=it-secret
export PANEL_ENCRYPTION_KEY=$(openssl rand -base64 32) NODE_TOKEN=$(openssl rand -hex 32) NODE_PUBLIC_IP=127.0.0.1
export DATABASE_URL="postgres://postgres:test@127.0.0.1:${pg_port}/panel" REDIS_URL="redis://127.0.0.1:${redis_port}"
export PANEL_URL="http://127.0.0.1:${PANEL_PORT}" DAEMON_URL="http://127.0.0.1:${DAEMON_PORT}"
export DAEMON_SOCKET="$work/daemon.sock" DATA_DIR="$work/data" CADDY_ADMIN_URL=""
mkdir -p "$work/templates"
cp -r "$root/templates/game" "$root/templates/web" "$work/templates/"
cp "$root/tests/integration/templates/game/"*.yaml "$work/templates/game/"
export TEMPLATES_DIR="$work/templates" PANEL_INSTANCE="$instance" DOCKER_EXTRA_LABELS="panel.test=true" PANEL_INSECURE_TEST_LOGIN=1
export NODE_TLS_REJECT_UNAUTHORIZED=0   # alleen test: Caddy van de node gebruikt zijn eigen CA (local_certs)

echo "== /etc/hosts: $MN_NODE_DOMAIN -> $MN_NODE_HOST (tijdelijk)"
echo "$MN_NODE_HOST $MN_NODE_DOMAIN $MN_SITE_DOMAIN $hosts_tag" >> /etc/hosts

echo "== migraties + daemon bouwen + panel starten op :$PANEL_PORT"
pnpm --filter @panel/db exec tsx migrate.ts >/dev/null
(cd daemon && go build -o "$work/panel-daemon" ./cmd/panel-daemon)
(cd apps/web && exec pnpm exec next dev -p "$PANEL_PORT" > "$work/panel.log" 2>&1) &
panel_pid=$!
for _ in $(seq 1 120); do curl -sf "$PANEL_URL/api/trpc/auth.branding" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$PANEL_URL/api/trpc/auth.branding" >/dev/null || { tail -50 "$work/panel.log"; exit 1; }

echo "== SSH reverse tunnel: $MN_NODE_HOST:127.0.0.1:$PANEL_PORT -> panel"
ssh "${ssh_opts[@]}" -o ExitOnForwardFailure=yes -N -R "127.0.0.1:${PANEL_PORT}:127.0.0.1:${PANEL_PORT}" "root@$MN_NODE_HOST" &
tunnel_pid=$!
sleep 2
rssh "curl -sf http://127.0.0.1:${PANEL_PORT}/api/trpc/auth.branding >/dev/null" || { echo "tunnel werkt niet"; exit 1; }

export IT_PANEL_URL="$PANEL_URL" IT_DAEMON_URL="$DAEMON_URL" IT_DAEMON_BIN="$work/panel-daemon" IT_DAEMON_LOG="$work/daemon.log" IT_WORK="$work"

echo "== fase A: node aanmaken in het panel"
pnpm --filter @panel/multinode run multinode a-create-node

echo "== node installeren op $MN_NODE_HOST met het gegenereerde installcommando"
# De repo wordt hier gekopieerd in plaats van gekloond (deze branch staat niet op GitHub): stap 1 van het
# commando (git clone) slaan we over; de rest is letterlijk het gegenereerde commando.
git ls-files -z | tar --null -T - -cf - | rssh 'rm -rf /opt/panel-node && mkdir -p /opt/panel-node && tar -xf - -C /opt/panel-node'
rssh 'cp /opt/panel-node/deploy/caddy/examples/local-certs.caddy /opt/panel-node/deploy/caddy/global.d/local-certs.caddy'
{ printf 'PANEL_INSTANCE=%q DOCKER_EXTRA_LABELS=panel.test=true MARIADB_CONTAINER=%q ' "$instance" "$mdb"; tail -n +3 "$work/install-command.txt"; } > "$work/remote-install.sh"
echo "--- commando (zonder token):"; sed "s/NODE_TOKEN='[^']*'/NODE_TOKEN='***'/" "$work/remote-install.sh"
rssh 'bash -s' < "$work/remote-install.sh" 2>&1 | tee "$work/remote-install.log" | tail -25
rssh 'systemctl is-active panel-daemon; docker ps --format "{{.Names}} {{.Status}}"'

# De lokale testnode heeft zijn eigen MariaDB ($mdb); alleen de lokale daemon (en fase C) krijgt het rootwachtwoord, het
# panel zelf niet (het beheert alles via de daemon). De remote node genereert zijn eigen wachtwoord.
export MN_NODE_HOST MN_SSH_KEY
echo "== fase B: remote node, console, bestanden, SFTP, verplaatsen"
MARIADB_ROOT_PASSWORD="mn-root-$uniq" pnpm --filter @panel/multinode run multinode b-remote
echo "== fase C: website met database verhuist naar de remote node en terug"
MARIADB_ROOT_PASSWORD="mn-root-$uniq" pnpm --filter @panel/multinode run multinode c-database
echo "== multinode-test geslaagd"
