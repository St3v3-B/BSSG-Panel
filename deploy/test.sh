#!/usr/bin/env bash
# pass() geeft altijd 0, dus "A && pass || fail" is hier wel als if-then-else bedoeld.
# shellcheck disable=SC2015
# Tests voor deploy/ en templates/game/. Raakt de echte installatie niet:
# alles in een tijdelijke map, Docker-objecten met panel.test=true + eigen panel.instance.
#
#   deploy/test.sh              # alles, Paper-rooktest als laatste
#   SKIP_PAPER=1 deploy/test.sh # zonder Paper (snel)
#   PAPER_MEMORY=1280           # RAM-limiet van de rooktest in MB (heap = 80%, max 1 GB)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$REPO/deploy"
INSTANCE="templates-ops-$$"
WORK="$(mktemp -d -t panel-deploy-test-XXXXXX)"
LABELS=(--label panel.test=true --label "panel.instance=$INSTANCE")
PAPER_MEMORY="${PAPER_MEMORY:-1280}"

pass() { printf '  ok   %s\n' "$*"; }
fail() { printf '  FOUT %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

cleanup() {
  set +e
  local ids
  mapfile -t ids < <(docker ps -aq --filter label=panel.test=true --filter "label=panel.instance=$INSTANCE")
  [ "${#ids[@]}" -gt 0 ] && docker rm -f "${ids[@]}" >/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }

# ------------------------------------------------------------------ shellcheck
step "shellcheck"
PAPER="$REPO/templates/game/paper.yaml"
mkdir -p "$WORK/sc"
for f in "$REPO"/templates/game/*.yaml; do
  node "$DEPLOY/test/template.mjs" "$f" get install.script > "$WORK/sc/$(basename "$f" .yaml).install.sh"
done
docker run --rm "${LABELS[@]}" \
  -v "$DEPLOY:/deploy:ro" -v "$WORK/sc:/templates:ro" \
  koalaman/shellcheck:stable -x /deploy/install.sh /deploy/test.sh \
  || fail "shellcheck deploy/*.sh"
pass "deploy/install.sh, deploy/test.sh"
sc_files=()
for f in "$WORK"/sc/*.sh; do sc_files+=("/templates/$(basename "$f")"); done
docker run --rm "${LABELS[@]}" -v "$WORK/sc:/templates:ro" koalaman/shellcheck:stable -s sh "${sc_files[@]}" \
  || fail "shellcheck install-scripts van templates"
pass "install-scripts in templates/game (POSIX sh)"

# ------------------------------------------------------------------ compose
step "docker compose config"
TEST_ENV="$WORK/test.env"
sed -e 's/^PANEL_DOMAIN=.*/PANEL_DOMAIN=panel.test/' \
    -e 's/^NODE_DOMAIN=.*/NODE_DOMAIN=node1.test/' \
    -e 's/^ACME_EMAIL=.*/ACME_EMAIL=it@panel.test/' \
    "$DEPLOY/panel.env.example" > "$TEST_ENV"
compose() { PANEL_ENV_FILE="$TEST_ENV" docker compose --env-file "$TEST_ENV" -f "$DEPLOY/docker-compose.yml" "$@"; }
compose config -q || fail "compose config"
CFG="$(compose config --format json)"
check_cfg() { # beschrijving, node-expressie op c (de config)
  node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8')); if(!($2)) process.exit(1)" <<<"$CFG" \
    && pass "$1" || fail "$1"
}
check_cfg "services panel, postgres, redis, caddy" \
  "['panel','postgres','redis','caddy'].every(s=>c.services[s])"
check_cfg "labels panel.managed/instance op alle services, netwerken en volumes" \
  "[...Object.values(c.services),...Object.values(c.networks),...Object.values(c.volumes)].every(o=>o.labels&&o.labels['panel.managed']==='true'&&o.labels['panel.instance']==='main')"
check_cfg "panel publiceert alleen 127.0.0.1:3000" \
  "c.services.panel.ports.length===1&&c.services.panel.ports[0].host_ip==='127.0.0.1'&&c.services.panel.ports[0].published==='3000'"
check_cfg "postgres en redis publiceren niets" "!c.services.postgres.ports&&!c.services.redis.ports"
check_cfg "caddy publiceert 80, 443 en 127.0.0.1:2019" \
  "(p=>p.some(x=>x.published==='80'&&!x.host_ip)&&p.some(x=>x.published==='443'&&!x.host_ip)&&p.some(x=>x.published==='2019'&&x.host_ip==='127.0.0.1')&&!p.some(x=>x.published==='2019'&&!x.host_ip))(c.services.caddy.ports)"
check_cfg "caddy mount /run/panel en de Caddyfile" \
  "c.services.caddy.volumes.some(v=>v.target==='/run/panel'&&v.source==='/run/panel')&&c.services.caddy.volumes.some(v=>v.target==='/etc/caddy/Caddyfile'&&v.source.endsWith('/deploy/caddy/Caddyfile'))"
check_cfg "caddy-containernaam = CADDY_CONTAINER (panel-caddy)" "c.services.caddy.container_name==='panel-caddy'"
check_cfg "panel: env_file ingelezen + NODE_DOMAIN naar host-gateway" \
  "c.services.panel.extra_hosts.some(h=>/^node1\\.test[:=]host-gateway$/.test(h))&&c.services.panel.environment.NODE_DOMAIN==='node1.test'"
check_cfg "backend-netwerk is intern" "c.networks.backend.internal===true"
# shellcheck disable=SC2016
grep -q '^      - \${PANEL_ENV_FILE:-/etc/panel/panel.env}$' "$DEPLOY/docker-compose.yml" \
  && pass "env_file standaard /etc/panel/panel.env" || fail "env_file standaard /etc/panel/panel.env"

# ------------------------------------------------------------------ systemd-unit
step "systemd-unit"
UNIT="$DEPLOY/systemd/panel-daemon.service"
for want in 'EnvironmentFile=/etc/panel/panel.env' 'RuntimeDirectory=panel' 'RuntimeDirectoryPreserve=yes' \
            'Restart=always' 'KillMode=process' 'ExecStart=/usr/local/bin/panel-daemon'; do
  grep -qx "$want" "$UNIT" && pass "$want" || fail "$want ontbreekt"
done
if command -v systemd-analyze >/dev/null; then
  mkdir -p "$WORK/unit"
  sed "s#^ExecStart=.*#ExecStart=/bin/true#; s#^EnvironmentFile=.*#EnvironmentFile=-$TEST_ENV#" "$UNIT" > "$WORK/unit/panel-daemon.service"
  out=$(systemd-analyze verify "$WORK/unit/panel-daemon.service" 2>&1 || true)
  [ -z "$out" ] && pass "systemd-analyze verify" || fail "systemd-analyze verify: $out"
fi

# ------------------------------------------------------------------ install.sh dry-run
step "install.sh --dry-run"
ROOT="$WORK/root"
inst_env=(PANEL_DOMAIN=panel.test NODE_DOMAIN=node1.test ACME_EMAIL=it@panel.test
  OWNER_DISCORD_ID=200000000000000001 DISCORD_CLIENT_ID=it-client DISCORD_CLIENT_SECRET=it-secret)
BIN_STUB="$WORK/panel-daemon-stub"; printf '#!/bin/sh\nexit 0\n' > "$BIN_STUB"; chmod +x "$BIN_STUB"
env "${inst_env[@]}" bash "$DEPLOY/install.sh" --dry-run --non-interactive --root "$ROOT" --daemon-bin "$BIN_STUB" \
  > "$WORK/install1.log" 2>&1 || { cat "$WORK/install1.log"; fail "install.sh dry-run"; }
E="$ROOT/etc/panel/panel.env"
[ -f "$E" ] && [ "$(stat -c %a "$E")" = 600 ] && pass "panel.env geschreven, chmod 600" || fail "panel.env/chmod"
getv() { sed -n "s/^$1=//p" "$E"; }
[ "$(getv PANEL_DOMAIN)" = panel.test ] && [ "$(getv NODE_DOMAIN)" = node1.test ] && pass "domeinen" || fail "domeinen"
[ "$(printf '%s' "$(getv PANEL_ENCRYPTION_KEY)" | base64 -d | wc -c)" = 32 ] && pass "PANEL_ENCRYPTION_KEY 32 bytes" || fail "PANEL_ENCRYPTION_KEY"
[[ "$(getv NODE_TOKEN)" =~ ^[0-9a-f]{64}$ ]] && pass "NODE_TOKEN gegenereerd" || fail "NODE_TOKEN"
pw="$(getv POSTGRES_PASSWORD)"
[ "$pw" != panel ] && [ "$(getv DATABASE_URL)" = "postgres://panel:$pw@postgres:5432/panel" ] \
  && pass "POSTGRES_PASSWORD gegenereerd en DATABASE_URL past erbij" || fail "postgres-wachtwoord"
diff <(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' "$DEPLOY/panel.env.example") <(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' "$E") >/dev/null \
  && pass "zelfde variabelen in dezelfde volgorde als panel.env.example" || fail "variabelen wijken af van panel.env.example"
[ -x "$ROOT/usr/local/bin/panel-daemon" ] && pass "daemon geïnstalleerd (stub)" || fail "daemon"
cmp -s "$UNIT" "$ROOT/etc/systemd/system/panel-daemon.service" && pass "unit geïnstalleerd" || fail "unit"
grep -q '^\[dry-run\] systemctl restart panel-daemon.service$' "$WORK/install1.log" && pass "systemctl alleen geprint" || fail "systemctl"
grep -q 'docker compose config: in orde' "$WORK/install1.log" && pass "compose config met geschreven env" || fail "compose met geschreven env"

# Idempotent: tweede run behoudt alles; een extra sleutel blijft staan.
before="$(grep -v '^# /etc/panel' "$E")"
echo "MIJN_EIGEN=waarde" >> "$E"
env "${inst_env[@]}" bash "$DEPLOY/install.sh" --dry-run --non-interactive --root "$ROOT" --daemon-bin "$BIN_STUB" \
  > "$WORK/install2.log" 2>&1 || { cat "$WORK/install2.log"; fail "install.sh tweede run"; }
after="$(grep -v '^# /etc/panel' "$E" | grep -v '^MIJN_EIGEN=' | sed '/^# --- overig/,$d')"
[ "$(printf '%s\n' "$before" | sed '/^$/d')" = "$(printf '%s\n' "$after" | sed '/^$/d')" ] && pass "tweede run: sleutels en waarden behouden" || fail "tweede run wijzigt panel.env"
grep -qx 'MIJN_EIGEN=waarde' "$E" && pass "onbekende sleutel behouden" || fail "onbekende sleutel weg"
! grep -q gegenereerd "$WORK/install2.log" && pass "geen nieuwe geheimen bij tweede run" || fail "geheimen opnieuw gegenereerd"
# Zonder verplichte waarde faalt --non-interactive.
if env -u PANEL_DOMAIN bash "$DEPLOY/install.sh" --dry-run --non-interactive --root "$WORK/root2" --daemon-bin "$BIN_STUB" >/dev/null 2>&1; then
  fail "--non-interactive zonder PANEL_DOMAIN zou moeten falen"
fi
pass "--non-interactive zonder verplichte waarden faalt"
env "${inst_env[@]}" PANEL_DOMAIN='bad domain' bash "$DEPLOY/install.sh" --dry-run --non-interactive --root "$WORK/root3" --daemon-bin "$BIN_STUB" >/dev/null 2>&1 \
  && fail "ongeldig domein geaccepteerd" || pass "ongeldig domein geweigerd"

# ------------------------------------------------------------------ template
step "templates/game"
(cd "$REPO" && pnpm --filter @panel/api exec vitest run contract.test.ts >/dev/null) && pass "contract-test (zod-schema)" || fail "contract-test"

if [ "${SKIP_PAPER:-0}" = 1 ]; then
  echo; echo "SKIP_PAPER=1: Paper-rooktest overgeslagen"; echo; echo "deploy/test.sh: groen"; exit 0
fi

# ------------------------------------------------------------------ Paper-rooktest
step "Paper-rooktest (install + start tot ready_pattern, ${PAPER_MEMORY} MB)"
DATA="$WORK/paper"; mkdir -p "$DATA"
PORT="$(free_port)"
UUID="00000000-0000-4000-8000-$(printf '%012d' $$)"
tpl() { node "$DEPLOY/test/template.mjs" "$PAPER" "$@"; }
export TPL_SERVER_MEMORY="$PAPER_MEMORY" TPL_SERVER_PORT="$PORT" TPL_SERVER_IP=127.0.0.1 TPL_SERVER_UUID="$UUID" TPL_TZ=Europe/Amsterdam
envargs=()
while IFS= read -r kv; do envargs+=(-e "$kv"); done < <(tpl env)
envargs+=(-e "SERVER_UUID=$UUID" -e "SERVER_MEMORY=$PAPER_MEMORY" -e SERVER_IP=127.0.0.1 -e "SERVER_PORT=$PORT" -e TZ=Europe/Amsterdam)

# Install zoals de daemon: root, met netwerk, script via /bin/sh, zelfde mount.
tpl get install.script > "$WORK/install-script.sh"
t0=$(date +%s)
docker run --rm "${LABELS[@]}" --label panel.role=install --name "panel-test-$INSTANCE-install" \
  "${envargs[@]}" -v "$DATA:/home/container" -v "$WORK/install-script.sh:/install.sh:ro" -w /home/container \
  "$(tpl get install.image)" /bin/sh /install.sh > "$WORK/install-output.log" 2>&1 \
  || { cat "$WORK/install-output.log"; fail "install-script"; }
tail -1 "$WORK/install-output.log"
pass "install-script ($(( $(date +%s) - t0 )) s)"
[ -s "$DATA/server.jar" ] && grep -qx 'eula=true' "$DATA/eula.txt" && pass "server.jar + eula.txt" || fail "server.jar/eula.txt"
chown -R 1000:1000 "$DATA"

# config_files zoals de daemon vóór elke start, en startup met {{VAR}} vervangen.
tpl config "$DATA"
grep -qx "server-port=$PORT" "$DATA/server.properties" && grep -qx 'server-ip=0.0.0.0' "$DATA/server.properties" \
  && pass "server.properties: server-port/server-ip" || fail "server.properties"
STARTUP="$(tpl startup)"
READY="$(tpl get ready_pattern)"

# Start zoals de daemon: uid 1000, read-only rootfs + tmpfs /tmp, caps eruit, limieten, stdin open.
mkfifo "$WORK/stdin"
docker run --rm -i "${LABELS[@]}" --name "panel-test-$INSTANCE-paper" \
  --user 1000:1000 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 512 --memory "${PAPER_MEMORY}m" --memory-swap "${PAPER_MEMORY}m" --cpus 2 \
  -p "127.0.0.1:$PORT:$PORT/tcp" -p "127.0.0.1:$PORT:$PORT/udp" \
  "${envargs[@]}" -v "$DATA:/home/container" -w /home/container \
  "$(tpl get image)" /bin/sh -c "$STARTUP" < "$WORK/stdin" > "$WORK/paper.log" 2>&1 &
RUN_PID=$!
exec 3> "$WORK/stdin"   # stdin openhouden
t0=$(date +%s)
ready=0
while kill -0 "$RUN_PID" 2>/dev/null && [ $(( $(date +%s) - t0 )) -lt 600 ]; do
  if node -e "process.exit(new RegExp(process.argv[1]).test(require('fs').readFileSync(process.argv[2],'utf8'))?0:1)" "$READY" "$WORK/paper.log"; then
    ready=1; break
  fi
  sleep 2
done
if [ "$ready" != 1 ]; then tail -40 "$WORK/paper.log"; fail "ready_pattern niet gezien"; fi
grep -E "$READY" "$WORK/paper.log" | head -1
pass "ready_pattern na $(( $(date +%s) - t0 )) s"
if (exec 4<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then pass "poort $PORT bereikbaar"; else fail "poort $PORT niet bereikbaar"; fi
! grep -qiE 'read-only file system|AccessDeniedException' "$WORK/paper.log" && pass "geen schrijffouten (read-only rootfs)" \
  || { grep -iE 'read-only file system|AccessDeniedException' "$WORK/paper.log" | head -5; fail "schrijffouten"; }

# Stop zoals de daemon: stop-commando op stdin, binnen 30 s weg.
tpl get stop.value >&3; echo >&3
t0=$(date +%s)
while kill -0 "$RUN_PID" 2>/dev/null && [ $(( $(date +%s) - t0 )) -lt 30 ]; do sleep 1; done
if kill -0 "$RUN_PID" 2>/dev/null; then fail "server stopt niet binnen 30 s na '$(tpl get stop.value)'"; fi
exec 3>&-
wait "$RUN_PID" || true
pass "stop-commando: gestopt na $(( $(date +%s) - t0 )) s"

echo; echo "deploy/test.sh: groen"
