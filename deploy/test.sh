#!/usr/bin/env bash
# pass() geeft altijd 0, dus "A && pass || fail" is hier wel als if-then-else bedoeld.
# S_<naam>_* worden dynamisch gezet (srv_prepare, printf -v).
# shellcheck disable=SC2015,SC2154
# Tests voor deploy/ en templates/game/. Raakt de echte installatie niet:
# alles in een tijdelijke map, Docker-objecten met panel.test=true + eigen panel.instance.
#
#   deploy/test.sh              # alles; Minecraft één tegelijk, Velocity + 2x Paper als laatste
#   SKIP_MC=1 deploy/test.sh    # zonder Minecraft-servers (snel; SKIP_PAPER=1 werkt ook)
#   TESTS="node java velocity paper folia fabric proxy"  # selectie van de game-tests
#   PAPER_MEMORY=1280           # RAM-limiet per Minecraft-rooktest in MB (heap = RAM min 384 MB)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$REPO/deploy"
INSTANCE="templates-ops-$$"
WORK="$(mktemp -d -t panel-deploy-test-XXXXXX)"
LABELS=(--label panel.test=true --label "panel.instance=$INSTANCE")

pass() { printf '  ok   %s\n' "$*"; }
fail() { printf '  ERROR %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

cleanup() {
  set +e
  local ids
  mapfile -t ids < <(docker ps -aq --filter label=panel.test=true --filter "label=panel.instance=$INSTANCE")
  [ "${#ids[@]}" -gt 0 ] && docker rm -f "${ids[@]}" >/dev/null
  mapfile -t ids < <(docker network ls -q --filter label=panel.test=true --filter "label=panel.instance=$INSTANCE")
  [ "${#ids[@]}" -gt 0 ] && docker network rm "${ids[@]}" >/dev/null
  mapfile -t ids < <(docker volume ls -q --filter label=panel.test=true --filter "label=panel.instance=$INSTANCE")
  [ "${#ids[@]}" -gt 0 ] && docker volume rm "${ids[@]}" >/dev/null
  [ "${KEEP_WORK:-0}" = 1 ] && echo "work dir kept: $WORK" || rm -rf "$WORK"
}
trap cleanup EXIT

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }

# ------------------------------------------------------------------ shellcheck
step "shellcheck"
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
  || fail "shellcheck install scripts of templates"
pass "install-scripts in templates/game (POSIX sh)"

# ------------------------------------------------------------------ compose
step "docker compose config"
TEST_ENV="$WORK/test.env"
sed -e 's/^PANEL_DOMAIN=.*/PANEL_DOMAIN=panel.test/' \
    -e 's/^NODE_DOMAIN=.*/NODE_DOMAIN=node1.test/' \
    -e 's/^ACME_EMAIL=.*/ACME_EMAIL=it@panel.test/' \
    "$DEPLOY/panel.env.example" > "$TEST_ENV"
# MARIADB_ROOT_PASSWORD staat leeg in het voorbeeld; voor de test een vaste waarde.
sed -i '/^MARIADB_ROOT_PASSWORD=/d' "$TEST_ENV"
echo "MARIADB_ROOT_PASSWORD=testtesttesttest" >> "$TEST_ENV"
compose() { PANEL_ENV_FILE="$TEST_ENV" docker compose --env-file "$TEST_ENV" -f "$DEPLOY/docker-compose.yml" "$@"; }
compose config -q || fail "compose config"
CFG="$(compose config --format json)"
check_cfg() { # beschrijving, node-expressie op c (de config)
  node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8')); if(!($2)) process.exit(1)" <<<"$CFG" \
    && pass "$1" || fail "$1"
}
check_cfg "services panel, postgres, redis, mariadb, caddy" \
  "['panel','postgres','redis','mariadb','caddy'].every(s=>c.services[s])"
check_cfg "labels panel.managed/instance op alle services, netwerken en volumes" \
  "[...Object.values(c.services),...Object.values(c.networks),...Object.values(c.volumes)].every(o=>o.labels&&o.labels['panel.managed']==='true'&&o.labels['panel.instance']==='main')"
check_cfg "panel only publishes 127.0.0.1:3000" \
  "c.services.panel.ports.length===1&&c.services.panel.ports[0].host_ip==='127.0.0.1'&&c.services.panel.ports[0].published==='3000'"
check_cfg "postgres, redis en mariadb publiceren niets" "!c.services.postgres.ports&&!c.services.redis.ports&&!c.services.mariadb.ports&&!c.services.mariadb.expose"
check_cfg "mariadb: panel-mariadb, mariadb:11, root password from env, volume panel-mariadb-data" \
  "(m=>m.container_name==='panel-mariadb'&&m.image==='mariadb:11'&&m.environment.MARIADB_ROOT_PASSWORD==='testtesttesttest'&&m.volumes.some(v=>v.target==='/var/lib/mysql'&&v.source==='mariadb_data')&&c.volumes.mariadb_data.name==='panel-mariadb-data')(c.services.mariadb)"
check_cfg "mariadb: non-root, read-only, caps dropped, no-new-privileges, healthcheck" \
  "(m=>m.user==='999:999'&&m.read_only&&m.cap_drop.includes('ALL')&&m.security_opt.some(o=>o.startsWith('no-new-privileges'))&&m.healthcheck.test.includes('healthcheck.sh'))(c.services.mariadb)"
check_cfg "network panel-db: internal, only mariadb (alias mariadb), not panel and caddy" \
  "c.networks.db.name==='panel-db'&&c.networks.db.internal===true&&Object.entries(c.services).filter(([,v])=>v.networks&&'db' in v.networks).map(([k])=>k).join()==='mariadb'&&c.services.mariadb.networks.db.aliases.includes('mariadb')"
check_cfg "mariadb on panel-backend (panel reaches it as mariadb:3306)" "'backend' in c.services.mariadb.networks&&'backend' in c.services.panel.networks"
if PANEL_ENV_FILE="$TEST_ENV" docker compose --env-file <(grep -v '^MARIADB_ROOT_PASSWORD=' "$TEST_ENV") -f "$DEPLOY/docker-compose.yml" config -q >/dev/null 2>&1; then
  fail "compose without MARIADB_ROOT_PASSWORD should fail"
fi
pass "compose without MARIADB_ROOT_PASSWORD fails (no empty root password)"
check_cfg "caddy publishes 80 and 443, not the admin API (2019)" \
  "(p=>p.some(x=>x.published==='80'&&!x.host_ip)&&p.some(x=>x.published==='443'&&!x.host_ip)&&!p.some(x=>x.target===2019||x.published==='2019'))(c.services.caddy.ports)"
check_cfg "caddy mount /run/panel, Caddyfile, global.d, /data en /config" \
  "(v=>v.some(x=>x.target==='/run/panel'&&x.source==='/run/panel')&&v.some(x=>x.target==='/etc/caddy/Caddyfile'&&x.source.endsWith('/deploy/caddy/Caddyfile')&&x.read_only)&&v.some(x=>x.target==='/etc/caddy/global.d'&&x.source.endsWith('/deploy/caddy/global.d')&&x.read_only)&&v.some(x=>x.target==='/data'&&x.type==='volume')&&v.some(x=>x.target==='/config'&&x.type==='volume'))(c.services.caddy.volumes)"
check_cfg "caddy gets PANEL_DOMAIN, NODE_DOMAIN, ACME_EMAIL and no other secrets" \
  "(e=>e.PANEL_DOMAIN==='panel.test'&&e.NODE_DOMAIN==='node1.test'&&e.ACME_EMAIL==='it@panel.test'&&!('NODE_TOKEN' in e)&&!('PANEL_ENCRYPTION_KEY' in e))(c.services.caddy.environment)"
check_cfg "caddy without --resume (default command)" "!c.services.caddy.command||!JSON.stringify(c.services.caddy.command).includes('resume')"
# Caddyfile van web-hosting valideren met precies deze env en mounts.
mkdir -p "$WORK/run"
docker run --rm "${LABELS[@]}" -e PANEL_DOMAIN=panel.test -e NODE_DOMAIN=node1.test -e ACME_EMAIL=it@panel.test \
  -v "$DEPLOY/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$DEPLOY/caddy/global.d:/etc/caddy/global.d:ro" \
  -v "$WORK/run:/run/panel" caddy:2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$WORK/caddy-validate.log" 2>&1 \
  && pass "caddy validate (Caddyfile + global.d)" || { cat "$WORK/caddy-validate.log"; fail "caddy validate"; }
check_cfg "caddy-containernaam = CADDY_CONTAINER (panel-caddy)" "c.services.caddy.container_name==='panel-caddy'"
check_cfg "panel: env_file read + NODE_DOMAIN to host-gateway" \
  "c.services.panel.extra_hosts.some(h=>/^node1\\.test[:=]host-gateway$/.test(h))&&c.services.panel.environment.NODE_DOMAIN==='node1.test'"
check_cfg "backend-netwerk is intern" "c.networks.backend.internal===true"
# shellcheck disable=SC2016
grep -q '^      - \${PANEL_ENV_FILE:-/etc/panel/panel.env}$' "$DEPLOY/docker-compose.yml" \
  && pass "env_file defaults to /etc/panel/panel.env" || fail "env_file defaults to /etc/panel/panel.env"

# ------------------------------------------------------------------ systemd-unit
step "systemd-unit"
UNIT="$DEPLOY/systemd/panel-daemon.service"
for want in 'EnvironmentFile=/etc/panel/panel.env' 'RuntimeDirectory=panel' 'RuntimeDirectoryPreserve=yes' \
            'Restart=always' 'KillMode=process' 'ExecStart=/usr/local/bin/panel-daemon'; do
  grep -qx "$want" "$UNIT" && pass "$want" || fail "$want missing"
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
[ -f "$E" ] && [ "$(stat -c %a "$E")" = 600 ] && pass "panel.env written, chmod 600" || fail "panel.env/chmod"
getv() { sed -n "s/^$1=//p" "$E"; }
[ "$(getv PANEL_DOMAIN)" = panel.test ] && [ "$(getv NODE_DOMAIN)" = node1.test ] && pass "domains" || fail "domains"
[ "$(printf '%s' "$(getv PANEL_ENCRYPTION_KEY)" | base64 -d | wc -c)" = 32 ] && pass "PANEL_ENCRYPTION_KEY 32 bytes" || fail "PANEL_ENCRYPTION_KEY"
[[ "$(getv NODE_TOKEN)" =~ ^[0-9a-f]{64}$ ]] && pass "NODE_TOKEN generated" || fail "NODE_TOKEN"
pw="$(getv POSTGRES_PASSWORD)"
[ "$pw" != panel ] && [ "$(getv DATABASE_URL)" = "postgres://panel:$pw@postgres:5432/panel" ] \
  && pass "POSTGRES_PASSWORD generated and DATABASE_URL matches" || fail "postgres password"
diff <(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' "$DEPLOY/panel.env.example") <(sed -n '/^# --- other/q; s/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' "$E") >/dev/null \
  && pass "same variables in the same order as panel.env.example" || fail "variables differ from panel.env.example"
[[ "$(getv MARIADB_ROOT_PASSWORD)" =~ ^[0-9a-f]{48}$ ]] && pass "MARIADB_ROOT_PASSWORD generated" || fail "MARIADB_ROOT_PASSWORD"
[ -x "$ROOT/usr/local/bin/panel-daemon" ] && pass "daemon installed (stub)" || fail "daemon"
cmp -s "$UNIT" "$ROOT/etc/systemd/system/panel-daemon.service" && pass "unit installed" || fail "unit"
grep -q '^\[dry-run\] systemctl restart panel-daemon.service$' "$WORK/install1.log" && pass "systemctl only printed" || fail "systemctl"
[ "$(getv PANEL_URL)" = "http://127.0.0.1:3000" ] && pass "PANEL_URL standaard http://127.0.0.1:3000" || fail "PANEL_URL"
[ "$(getv CADDY_ADMIN_URL)" = "$(sed -n 's/^CADDY_ADMIN_URL=//p' "$DEPLOY/panel.env.example")" ] \
  && [ "$(getv CADDY_TLS_ADDR)" = "$(sed -n 's/^CADDY_TLS_ADDR=//p' "$DEPLOY/panel.env.example")" ] \
  && pass "CADDY_ADMIN_URL/CADDY_TLS_ADDR from the example" || fail "CADDY_ADMIN_URL/CADDY_TLS_ADDR"
grep -q 'docker compose config: OK' "$WORK/install1.log" && pass "compose config with written env" || fail "compose with written env"

# Idempotent: second run keeps everything; an extra key is kept.
mariadb_pw="$(getv MARIADB_ROOT_PASSWORD)"
before="$(grep -v '^# /etc/panel' "$E" | sed '/^# --- other/,$d')"
echo "MY_OWN=value" >> "$E"
sed -i 's#^PANEL_URL=.*#PANEL_URL=https://panel.test#; s#^CADDY_TLS_ADDR=.*#CADDY_TLS_ADDR=127.0.0.1:8443#; s#^CADDY_ADMIN_URL=.*#CADDY_ADMIN_URL=#' "$E"
before="$(printf '%s\n' "$before" | sed 's#^PANEL_URL=.*#PANEL_URL=https://panel.test#; s#^CADDY_TLS_ADDR=.*#CADDY_TLS_ADDR=127.0.0.1:8443#')"
env "${inst_env[@]}" bash "$DEPLOY/install.sh" --dry-run --non-interactive --root "$ROOT" --daemon-bin "$BIN_STUB" \
  > "$WORK/install2.log" 2>&1 || { cat "$WORK/install2.log"; fail "install.sh second run"; }
after="$(grep -v '^# /etc/panel' "$E" | grep -v '^MY_OWN=' | sed '/^# --- other/,$d')"
[ "$(printf '%s\n' "$before" | sed '/^$/d')" = "$(printf '%s\n' "$after" | sed '/^$/d')" ] && pass "second run: keys and values kept" || fail "second run changes panel.env"
grep -qx 'MY_OWN=value' "$E" && pass "unknown key kept" || fail "unknown key lost"
[ "$(getv MARIADB_ROOT_PASSWORD)" = "$mariadb_pw" ] && [ "$(grep -c '^MARIADB_ROOT_PASSWORD=' "$E")" = 1 ] \
  && pass "MARIADB_ROOT_PASSWORD kept (only once)" || fail "MARIADB_ROOT_PASSWORD changed or duplicated"
! grep -q generated "$WORK/install2.log" && pass "no new secrets on second run" || fail "secrets regenerated"
# Zonder verplichte waarde faalt --non-interactive.
if env -u PANEL_DOMAIN bash "$DEPLOY/install.sh" --dry-run --non-interactive --root "$WORK/root2" --daemon-bin "$BIN_STUB" >/dev/null 2>&1; then
  fail "--non-interactive without PANEL_DOMAIN should fail"
fi
pass "--non-interactive without required values fails"
env "${inst_env[@]}" PANEL_DOMAIN='bad domain' bash "$DEPLOY/install.sh" --dry-run --non-interactive --root "$WORK/root3" --daemon-bin "$BIN_STUB" >/dev/null 2>&1 \
  && fail "invalid domain accepted" || pass "invalid domain rejected"

# ------------------------------------------------------------------ install.sh --node-only
step "install.sh --node-only --dry-run"
NROOT="$WORK/noderoot"
node_env=(PANEL_URL=https://panel.test NODE_DOMAIN=node2.test NODE_TOKEN="$(printf 'a%.0s' {1..40})" ACME_EMAIL=it@panel.test)
env "${node_env[@]}" bash "$DEPLOY/install.sh" --node-only --dry-run --non-interactive --root "$NROOT" --daemon-bin "$BIN_STUB" \
  > "$WORK/node1.log" 2>&1 || { cat "$WORK/node1.log"; fail "install.sh --node-only dry-run"; }
NE="$NROOT/etc/panel/panel.env"
ngetv() { sed -n "s/^$1=//p" "$NE"; }
[ "$(stat -c %a "$NE")" = 600 ] && [ "$(ngetv PANEL_URL)" = https://panel.test ] && [ "$(ngetv NODE_DOMAIN)" = node2.test ] \
  && pass "node: panel.env written (chmod 600)" || fail "node panel.env"
! grep -qE '^(PANEL_ENCRYPTION_KEY|DATABASE_URL|POSTGRES_PASSWORD|MARIADB_ROOT_PASSWORD|DISCORD_CLIENT_SECRET)=' "$NE" \
  && pass "node: no panel secrets in panel.env" || fail "node env contains panel secrets"
[ -x "$NROOT/usr/local/bin/panel-daemon" ] && cmp -s "$UNIT" "$NROOT/etc/systemd/system/panel-daemon.service" && pass "node: daemon + unit" || fail "node daemon/unit"
grep -q 'docker-compose.node.yml' "$WORK/node1.log" && grep -q 'docker compose config: OK' "$WORK/node1.log" && pass "node: only docker-compose.node.yml" || fail "node compose"
cp "$NE" "$WORK/node.env.1"
env "${node_env[@]}" bash "$DEPLOY/install.sh" --node-only --dry-run --non-interactive --root "$NROOT" --daemon-bin "$BIN_STUB" > "$WORK/node2.log" 2>&1 || fail "node second run"
cmp -s "$NE" "$WORK/node.env.1" && pass "node: idempotent" || fail "node env changed on second run"
bash "$DEPLOY/install.sh" --node-only --dry-run --non-interactive --root "$WORK/noderoot2" --daemon-bin "$BIN_STUB" --panel-url https://panel.test --node-domain node3.test \
  --node-token "$(printf 'b%.0s' {1..40})" --acme-email it@panel.test --sftp-port 2023 >/dev/null 2>&1 \
  && [ "$(sed -n 's/^SFTP_PORT=//p' "$WORK/noderoot2/etc/panel/panel.env")" = 2023 ] && pass "node: flags" || fail "node flags"
env "${node_env[@]}" NODE_TOKEN=short bash "$DEPLOY/install.sh" --node-only --dry-run --non-interactive --root "$WORK/noderoot3" --daemon-bin "$BIN_STUB" >/dev/null 2>&1 \
  && fail "short node token accepted" || pass "node: invalid token rejected"
env -u PANEL_URL "${node_env[@]:1}" bash "$DEPLOY/install.sh" --node-only --dry-run --non-interactive --root "$WORK/noderoot4" --daemon-bin "$BIN_STUB" >/dev/null 2>&1 \
  && fail "node without PANEL_URL accepted" || pass "node: PANEL_URL required"

# ------------------------------------------------------------------ template
step "templates/game"
(cd "$REPO" && pnpm --filter @panel/api exec vitest run contract.test.ts >/dev/null) && pass "contract-test (zod-schema)" || fail "contract-test"

# ------------------------------------------------------------------ MariaDB
# Zoals in compose (zelfde image, user, read-only, tmpfs, caps, command, healthcheck), maar met
# eigen netwerk/volume/labels. Daarna: een site-achtige container op het interne netwerk maakt
# als root een database + gebruiker aan en verbindt als die gebruiker.
step "MariaDB (compose settings in a test container)"
mcfg() { node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8')).services.mariadb; process.stdout.write(String($1))" <<<"$CFG"; }
M_IMAGE="$(mcfg c.image)"; M_USER="$(mcfg c.user)"
mapfile -t M_CMD < <(mcfg "c.command.join('\\n')")
mapfile -t M_TMPFS < <(mcfg "c.tmpfs.join('\\n')")
tmpfs_args=(); for t in "${M_TMPFS[@]}"; do tmpfs_args+=(--tmpfs "$t"); done
M_NET="panel-test-$INSTANCE-db"; M_VOL="panel-test-$INSTANCE-mariadb"; M_NAME="panel-test-$INSTANCE-mariadb"
M_PW="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker network create --internal "${LABELS[@]}" "$M_NET" >/dev/null
docker volume create "${LABELS[@]}" "$M_VOL" >/dev/null
docker run -d "${LABELS[@]}" --name "$M_NAME" --network "$M_NET" --network-alias mariadb \
  --user "$M_USER" --read-only "${tmpfs_args[@]}" --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m -e MARIADB_ROOT_PASSWORD="$M_PW" -e MARIADB_AUTO_UPGRADE=1 -e TZ=Europe/Amsterdam \
  -v "$M_VOL:/var/lib/mysql" "$M_IMAGE" "${M_CMD[@]}" >/dev/null
t0=$(date +%s); healthy=0
while [ $(( $(date +%s) - t0 )) -lt 120 ]; do
  [ "$(docker inspect -f '{{.State.Running}}' "$M_NAME" 2>/dev/null)" = true ] || break
  if docker exec "$M_NAME" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
[ "$healthy" = 1 ] || { docker logs --tail 40 "$M_NAME"; fail "MariaDB not healthy"; }
pass "MariaDB healthy after $(( $(date +%s) - t0 )) s ($M_IMAGE as $M_USER, read-only rootfs, caps dropped)"
[ -z "$(docker port "$M_NAME")" ] && pass "no published ports" || fail "MariaDB publishes ports"
client() { docker run --rm "${LABELS[@]}" --network "$M_NET" --user 999:999 --read-only --cap-drop ALL \
  --security-opt no-new-privileges "$M_IMAGE" mariadb --skip-ssl -h mariadb -P 3306 "$@"; }
client -uroot -p"$M_PW" -e "CREATE DATABASE s1_test; CREATE USER 'u1_test'@'%' IDENTIFIED BY 'sitepw-12345'; GRANT ALL ON s1_test.* TO 'u1_test'@'%';" \
  && pass "root via network (host mariadb:3306): database + user created" || fail "root via network"
[ "$(client -uu1_test -psitepw-12345 -N -e "CREATE TABLE s1_test.t (x INT); INSERT INTO s1_test.t VALUES (42); SELECT x FROM s1_test.t;")" = 42 ] \
  && pass "site user writes/reads own database" || fail "site user"
client -uu1_test -psitepw-12345 -e "CREATE DATABASE andere" >/dev/null 2>&1 && fail "site user may create another database" \
  || pass "site user cannot create another database"
[ "$(client -uroot -p"$M_PW" -N -e "SELECT @@character_set_server")" = utf8mb4 ] && pass "utf8mb4" || fail "character set"
docker rm -f "$M_NAME" >/dev/null

# ------------------------------------------------------------------ game-templates
# Per template zoals de daemon: install-script als root (met netwerk) in de install-image,
# eigenaar naar 1000, config_files bijwerken, startup met {{VAR}} vervangen, starten als uid
# 1000 met read-only rootfs + tmpfs /tmp, caps eruit, RAM-limiet; wachten op ready_pattern;
# stoppen zoals stop aangeeft. Minecraft-servers één tegelijk, de Velocity-test als laatste.
want() { [[ " $TESTS " == *" $1 "* ]]; }
if [ "${SKIP_PAPER:-0}" = 1 ] || [ "${SKIP_MC:-0}" = 1 ]; then
  TESTS="${TESTS:-node java velocity}"
else
  TESTS="${TESTS:-node java velocity paper folia fabric proxy}"
fi

GW="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')"
free_port_on() { python3 -c 'import socket,sys;s=socket.socket();s.bind((sys.argv[1],0));print(s.getsockname()[1])' "$1"; }
n_srv=0

# srv_prepare <naam> <template> <ram-MB> [publiceer-IP] [VAR=waarde ...]
# Zet S_<naam>_* (map, poort, ...) en draait het install-script.
srv_prepare() {
  local name="$1" yaml="$REPO/templates/game/$2.yaml" mem="$3" ip="$4"; shift 4
  local dir="$WORK/srv-$name" port uuid kv
  n_srv=$((n_srv + 1))
  mkdir -p "$dir"
  port="$(free_port_on "$ip")"
  uuid="00000000-0000-4000-8$(printf '%03d' "$n_srv")-$(printf '%012d' $$)"
  printf -v "S_${name}_yaml" %s "$yaml"; printf -v "S_${name}_dir" %s "$dir"
  printf -v "S_${name}_port" %s "$port"; printf -v "S_${name}_mem" %s "$mem"; printf -v "S_${name}_ip" %s "$ip"
  local -a tplenv=(TPL_SERVER_MEMORY="$mem" TPL_SERVER_PORT="$port" TPL_SERVER_IP="$ip" TPL_SERVER_UUID="$uuid" TPL_TZ=Europe/Amsterdam)
  for kv in "$@"; do tplenv+=("TPL_$kv"); done
  printf '%s\n' "${tplenv[@]}" > "$dir.tplenv"
  { env "${tplenv[@]}" node "$DEPLOY/test/template.mjs" "$yaml" env
    printf '%s\n' "SERVER_UUID=$uuid" "SERVER_MEMORY=$mem" "SERVER_IP=$ip" "SERVER_PORT=$port" TZ=Europe/Amsterdam; } > "$dir.env"
  [ "${SKIP_INSTALL:-0}" = 1 ] && return 0
  srv_tpl "$name" get install.script > "$dir.install.sh"
  local t0; t0=$(date +%s)
  docker run --rm "${LABELS[@]}" --label panel.role=install --name "panel-test-$INSTANCE-$name-install" \
    --env-file "$dir.env" -v "$dir:/home/container" -v "$dir.install.sh:/install.sh:ro" -w /home/container \
    "$(srv_tpl "$name" get install.image)" /bin/sh /install.sh > "$dir.install.log" 2>&1 \
    || { tail -30 "$dir.install.log"; fail "$name: install script"; }
  chown -R 1000:1000 "$dir"
  pass "$name: install ($(( $(date +%s) - t0 )) s): $(tail -1 "$dir.install.log")"
}
sv() { local v="S_$1_$2"; printf '%s' "${!v}"; }
srv_tpl() { local name="$1"; shift; mapfile -t _e < "$(sv "$name" dir).tplenv"; env "${_e[@]}" node "$DEPLOY/test/template.mjs" "$(sv "$name" yaml)" "$@"; }

# srv_start <naam>: config_files, start op de achtergrond, wacht op ready_pattern.
srv_start() {
  local name="$1" dir mem port ip startup ready t0
  dir="$(sv "$name" dir)"; mem="$(sv "$name" mem)"; port="$(sv "$name" port)"; ip="$(sv "$name" ip)"
  srv_tpl "$name" config "$dir"
  chown -R 1000:1000 "$dir"
  startup="$(srv_tpl "$name" startup)"; ready="$(srv_tpl "$name" get ready_pattern)"
  rm -f "$dir.stdin"; mkfifo "$dir.stdin"
  docker run -i "${LABELS[@]}" --label panel.role=server --name "panel-test-$INSTANCE-$name" \
    --user 1000:1000 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 512 --memory "${mem}m" --memory-swap "${mem}m" --cpus 2 \
    -p "$ip:$port:$port/tcp" -p "$ip:$port:$port/udp" \
    --env-file "$dir.env" -v "$dir:/home/container" -w /home/container \
    "$(srv_tpl "$name" get image)" /bin/sh -c "$startup" < "$dir.stdin" > "$dir.log" 2>&1 &
  printf -v "S_${name}_pid" %s "$!"
  exec {fd}> "$dir.stdin"; printf -v "S_${name}_fd" %s "$fd"
  t0=$(date +%s)
  while :; do
    if node -e "process.exit(new RegExp(process.argv[1],'m').test(require('fs').readFileSync(process.argv[2],'utf8'))?0:1)" "$ready" "$dir.log"; then
      pass "$name: ready_pattern after $(( $(date +%s) - t0 )) s: $(grep -m1 -E "$ready" "$dir.log" | cut -c1-90)"
      ! grep -qiE 'read-only file system|AccessDeniedException' "$dir.log" \
        || { grep -iE 'read-only file system|AccessDeniedException' "$dir.log" | head -5; fail "$name: write errors (read-only rootfs)"; }
      return 0
    fi
    kill -0 "$(sv "$name" pid)" 2>/dev/null && [ $(( $(date +%s) - t0 )) -lt 600 ] || break
    sleep 2
  done
  tail -40 "$dir.log"
  fail "$name: ready_pattern not seen ($(docker inspect -f 'exit {{.State.ExitCode}}, OOMKilled {{.State.OOMKilled}}' "panel-test-$INSTANCE-$name" 2>&1))"
}

srv_cmd() { local fd; fd="$(sv "$1" fd)"; printf '%s\n' "$2" >&"$fd"; }

# srv_stop <naam>: stop zoals de template zegt (commando op stdin of signaal), binnen 30 s.
srv_stop() {
  local name="$1" pid t0 fd
  pid="$(sv "$name" pid)"; fd="$(sv "$name" fd)"
  if [ "$(srv_tpl "$name" get stop.type)" = command ]; then srv_cmd "$name" "$(srv_tpl "$name" get stop.value)"
  else docker kill -s "$(srv_tpl "$name" get stop.value)" "panel-test-$INSTANCE-$name" >/dev/null 2>&1 || true; fi
  t0=$(date +%s)
  while kill -0 "$pid" 2>/dev/null && [ $(( $(date +%s) - t0 )) -lt 30 ]; do sleep 1; done
  kill -0 "$pid" 2>/dev/null && { tail -20 "$(sv "$name" dir).log"; fail "$name: not stopped within 30 s"; }
  exec {fd}>&-
  wait "$pid" || true
  pass "$name: stopped after $(( $(date +%s) - t0 )) s ($(srv_tpl "$name" get stop.type) $(srv_tpl "$name" get stop.value))"
}

tcp_open() { (exec 4<>"/dev/tcp/$1/$2") 2>/dev/null; }
mc_checks() { # naam: poort open + server.properties door config_files
  local name="$1" dir port; dir="$(sv "$name" dir)"; port="$(sv "$name" port)"
  tcp_open "$(sv "$name" ip)" "$port" && pass "$name: port $port reachable" || fail "$name: port $port closed"
  grep -qx "server-port=$port" "$dir/server.properties" && grep -qx 'server-ip=0.0.0.0' "$dir/server.properties" \
    && pass "$name: server.properties (server-port/server-ip)" || fail "$name: server.properties"
}

if want node; then
  step "node-generic"
  srv_prepare node node-generic 256 127.0.0.1 MAIN_FILE=start.js
  [ -f "$S_node_dir/index.js" ] && pass "node: example index.js" || fail "node: index.js"
  # package.json met een dependency: npm install bij de start (read-only rootfs, cache in de map).
  printf '{"name":"t","version":"1.0.0","dependencies":{"ms":"2.1.3"}}\n' > "$S_node_dir/package.json"
  printf 'const ms=require("ms");require("./app.js");console.log("ms ok", ms(60000));\n' > "$S_node_dir/start.js"
  mv "$S_node_dir/index.js" "$S_node_dir/app.js"; chown -R 1000:1000 "$S_node_dir"
  srv_start node
  for _ in $(seq 1 15); do grep -q 'luistert op poort' "$S_node_dir.log" && break; sleep 1; done
  grep -q 'ms ok 1m' "$S_node_dir.log" && pass "node: npm install + require of a dependency" || { cat "$S_node_dir.log"; fail "node: npm install"; }
  [ "$(curl -fsS "http://127.0.0.1:$S_node_port/")" = "Hello from Node.js" ] && pass "node: app reachable on SERVER_PORT" || fail "node: http"
  srv_stop node
fi

if want java; then
  step "java-generic (Java 17 via Adoptium, own jar)"
  srv_prepare java java-generic 256 127.0.0.1 JAVA_VERSION=17 JAR_FILE=fabric-installer.jar JAR_ARGS=help
  [ -x "$S_java_dir/.java/bin/java" ] && pass "java: JRE in .java/" || fail "java: no .java/bin/java"
  # Een JAR "van de gebruiker": de Fabric-installer (Java 8-bytecode, print help en stopt).
  curl -fsSL -o "$S_java_dir/fabric-installer.jar" "$(curl -fsSL https://meta.fabricmc.net/v2/versions/installer | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8"))[0].url)')"
  srv_start java
  grep -qE '^\[panel\] starting .*"17\.' "$S_java_dir.log" && pass "java: runs on Java 17" || { cat "$S_java_dir.log"; fail "java: wrong Java version"; }
  wait "$S_java_pid" || true
  grep -qi 'fabric' "$S_java_dir.log" && pass "java: jar started (installer help)" || { cat "$S_java_dir.log"; fail "java: jar"; }
  exec {S_java_fd}>&-
fi

if want velocity; then
  step "Velocity"
  srv_prepare velo velocity 512 127.0.0.1
  grep -q '^\[servers\]' "$S_velo_dir/velocity.toml" && [ -s "$S_velo_dir/forwarding.secret" ] \
    && pass "velo: velocity.toml + forwarding.secret" || fail "velo: velocity.toml/forwarding.secret"
  srv_start velo
  grep -qx "bind = \"0.0.0.0:$S_velo_port\"" "$S_velo_dir/velocity.toml" && grep -qx 'player-info-forwarding-mode = "modern"' "$S_velo_dir/velocity.toml" \
    && pass "velo: velocity.toml (bind, modern forwarding)" || fail "velo: velocity.toml"
  tcp_open 127.0.0.1 "$S_velo_port" && pass "velo: port reachable" || fail "velo: port"
  srv_stop velo
fi

MC_MEMORY="${PAPER_MEMORY:-1280}"
if want paper; then
  step "Paper (${MC_MEMORY} MB)"
  srv_prepare paper paper "$MC_MEMORY" 127.0.0.1
  [ -s "$S_paper_dir/server.jar" ] && grep -qx 'eula=true' "$S_paper_dir/eula.txt" && pass "paper: server.jar + eula.txt" || fail "paper: server.jar/eula"
  srv_start paper
  mc_checks paper
  srv_stop paper
  grep -qx 'online-mode=true' "$S_paper_dir/server.properties" && pass "paper: online-mode=true (default)" || fail "paper: online-mode"
  # Paper heeft paper-global.yml aangevuld; de waarden van config_files staan er nog.
  node -e 'const y=require(process.argv[2]).parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(y.proxies.velocity.enabled===false&&y._version?0:1)' \
    "$S_paper_dir/config/paper-global.yml" "$(cd "$REPO/packages/api" && node -p 'require.resolve("yaml")')" \
    && pass "paper: config/paper-global.yml completed, velocity off" || fail "paper: paper-global.yml"
fi

if want folia; then
  step "Folia (${MC_MEMORY} MB)"
  srv_prepare folia folia "$MC_MEMORY" 127.0.0.1
  srv_start folia
  mc_checks folia
  srv_stop folia
fi

if want fabric; then
  step "Fabric (${MC_MEMORY} MB)"
  srv_prepare fabric fabric "$MC_MEMORY" 127.0.0.1
  srv_start fabric
  mc_checks fabric
  grep -q 'Loading Minecraft .* with Fabric Loader' "$S_fabric_dir.log" && pass "fabric: Fabric Loader active" || fail "fabric: no Fabric Loader in the log"
  srv_stop fabric
fi

# ------------------------------------------------------------------ Velocity + 2x Paper (mijlpaal 2)
# Zoals in het panel: drie servers, elk met een eigen allocation op het host-IP (hier het
# gateway-IP van de Docker-bridge, zodat containers elkaar via de gepubliceerde poorten
# bereiken, zoals op een echte node via het publieke IP). Velocity met een secret als
# variabele; beide Paper-servers VELOCITY_FORWARDING=true + dezelfde VELOCITY_SECRET; de
# serverlijst in velocity.toml zoals een gebruiker hem via de filemanager zet. Een bot
# (mineflayer, offline-mode) logt in via de proxy en wisselt met /server naar de tweede server.
if want proxy; then
  PROXY_MC="${PROXY_MC_VERSION:-1.21.11}"   # versie die mineflayer ondersteunt
  PMEM="${PROXY_PAPER_MEMORY:-1280}"   # heap 896 MB (template: RAM min 384 MB)
  step "Velocity with two Paper servers (Paper $PROXY_MC, 2x ${PMEM} MB, Velocity 512 MB)"
  SECRET="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  srv_prepare pa paper "$PMEM" "$GW" MINECRAFT_VERSION="$PROXY_MC" VELOCITY_FORWARDING=true VELOCITY_SECRET="$SECRET"
  # Tweede Paper-server: zelfde installatie (jar niet nog eens downloaden), eigen allocation.
  SKIP_INSTALL=1 srv_prepare pb paper "$PMEM" "$GW" MINECRAFT_VERSION="$PROXY_MC" VELOCITY_FORWARDING=true VELOCITY_SECRET="$SECRET"
  cp -a "$S_pa_dir/." "$S_pb_dir/"
  srv_prepare pv velocity 512 "$GW" VELOCITY_FORWARDING_SECRET="$SECRET" ONLINE_MODE=false
  # [servers] zoals de gebruiker hem zet (allocation-IP:poort van de Paper-servers).
  awk -v a="$GW:$S_pa_port" -v b="$GW:$S_pb_port" '
    /^\[servers\]/ { print; print "a = \"" a "\""; print "b = \"" b "\""; print "try = [\"a\"]"; skip=1; next }
    /^\[/ { skip=0 } !skip { print }' "$S_pv_dir/velocity.toml" > "$S_pv_dir/velocity.toml.new"
  mv "$S_pv_dir/velocity.toml.new" "$S_pv_dir/velocity.toml"
  srv_start pa
  grep -qx 'online-mode=false' "$S_pa_dir/server.properties" && pass "pa: online-mode off due to VELOCITY_FORWARDING" || fail "pa: online-mode"
  srv_start pb
  srv_start pv
  grep -q 'secret' "$S_pv_dir.log" && grep -i 'secret' "$S_pv_dir.log" | head -3 | sed 's/^/  info /'
  mkdir -p "$WORK/bot"
  cat > "$WORK/bot/bot.js" <<'JS'
const mineflayer = require("mineflayer");
const [host, port, version] = process.argv.slice(2);
const bot = mineflayer.createBot({ host, port: Number(port), username: "PanelTest", auth: "offline", version });
let spawns = 0;
bot.on("spawn", () => {
  spawns++;
  console.log(`BOT spawn ${spawns}`);
  if (spawns === 1) setTimeout(() => bot.chat("/server b"), 3000);
});
bot.on("message", (m) => console.log(`BOT msg ${m.toString()}`));
bot.on("kicked", (r) => { console.log(`BOT kicked ${JSON.stringify(r)}`); process.exit(2); });
bot.on("error", (e) => { console.log(`BOT error ${e.message}`); process.exit(3); });
setTimeout(() => { console.log("BOT klaar"); bot.quit(); setTimeout(() => process.exit(0), 1000); }, 25000);
JS
  docker run --rm "${LABELS[@]}" --name "panel-test-$INSTANCE-bot" --memory 512m --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
    -v "$WORK/bot/bot.js:/bot/bot.js:ro" node:24-alpine sh -c \
    "cd /tmp && npm i --silent --no-audit --no-fund mineflayer >/dev/null 2>&1 && cp /bot/bot.js . && node bot.js $GW $S_pv_port $PROXY_MC" \
    > "$WORK/bot.log" 2>&1 || true
  sed 's/^/  bot  /' "$WORK/bot.log" | head -12
  grep -q 'PanelTest joined the game' "$S_pa_dir.log" && pass "player via Velocity on Paper server a" \
    || { tail -15 "$S_pa_dir.log"; tail -15 "$S_pv_dir.log"; fail "player not on server a"; }
  grep -q 'PanelTest joined the game' "$S_pb_dir.log" && pass "with /server to Paper server b" \
    || { tail -15 "$S_pb_dir.log"; tail -15 "$S_pv_dir.log"; fail "player not on server b"; }
  # Modern forwarding: Paper ziet het echte adres van de speler (via Velocity doorgegeven).
  grep -E 'PanelTest\[/[0-9.]+:[0-9]+\] logged in' "$S_pb_dir.log" | head -1 | sed 's/^/  info /'
  ! grep -qi 'Unable to verify player details' "$S_pa_dir.log" "$S_pb_dir.log" && pass "no forwarding errors on Paper" \
    || fail "forwarding error (Unable to verify player details)"
  srv_stop pv
  srv_stop pb
  srv_stop pa
fi

echo; echo "deploy/test.sh: groen (game-tests: $TESTS)"
