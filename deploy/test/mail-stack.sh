#!/usr/bin/env bash
# End-to-end test of the mail stack (deploy/mail/): builds the images, starts a minimal stack with its own
# Postgres (views from deploy/test/mail-views.sql), Redis, Unbound, Rspamd (ClamAV off), Dovecot and Postfix,
# and checks delivery, IMAPS with an ARGON2ID password, no open relay, submission with auth, sender checks,
# catch-all and DKIM signing.
#
#   deploy/test/mail-stack.sh          (needs Docker; uses `sg docker` itself when the socket is not accessible)
#   KEEP=1 deploy/test/mail-stack.sh   keep containers and work dir for debugging (clean up yourself:
#                                      docker rm -f $(docker ps -aq --filter label=panel.test=true --filter label=panel.instance=<id>))
#
# Never touches the real installation: every Docker object has panel.test=true + panel.instance=mailstack-<pid>,
# ports are random on 127.0.0.1 (never 25/465/587/993/4190), everything else lives in a temp dir.
set -euo pipefail

if ! docker info >/dev/null 2>&1 && [ -z "${MAILSTACK_SG:-}" ] && command -v sg >/dev/null; then
  exec sg docker -c "MAILSTACK_SG=1 KEEP=${KEEP:-0} $(printf '%q' "$0")"
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MAIL="$REPO/deploy/mail"
INSTANCE="mailstack-$$"
WORK="$(mktemp -d -t panel-mailstack-XXXXXX)"
LABELS=(--label panel.test=true --label "panel.instance=$INSTANCE")
FILTER=(--filter label=panel.test=true --filter "label=panel.instance=$INSTANCE")
export MAIL_HOSTNAME=mail.panel.test

pass() { printf '  ok   %s\n' "$*"; }
fail() {
  printf '  ERROR %s\n' "$*" >&2
  for c in postfix dovecot rspamd; do
    printf -- '--- logs %s (last 40 lines)\n' "$c" >&2
    docker logs --tail 40 "$INSTANCE-$c" 2>&1 | sed 's/^/    /' >&2 || true
  done
  exit 1
}
step() { printf '\n== %s\n' "$*"; }

cleanup() {
  set +e
  if [ "${KEEP:-0}" = 1 ]; then echo "kept: instance $INSTANCE, work dir $WORK"; return; fi
  local ids
  mapfile -t ids < <(docker ps -aq "${FILTER[@]}")
  [ "${#ids[@]}" -gt 0 ] && docker rm -f -v "${ids[@]}" >/dev/null
  mapfile -t ids < <(docker network ls -q "${FILTER[@]}")
  [ "${#ids[@]}" -gt 0 ] && docker network rm "${ids[@]}" >/dev/null
  mapfile -t ids < <(docker volume ls -q "${FILTER[@]}")
  [ "${#ids[@]}" -gt 0 ] && docker volume rm "${ids[@]}" >/dev/null
  mapfile -t ids < <(docker images -q "${FILTER[@]}" | sort -u)
  [ "${#ids[@]}" -gt 0 ] && docker rmi -f "${ids[@]}" >/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

port_of() { docker port "$1" "$2/tcp" | sed -n 's/^127\.0\.0\.1:\([0-9]*\)$/\1/p' | head -1; }

wait_banner() { # name port prefix [tls]
  local out
  for _ in $(seq 1 60); do
    if [ "${4:-}" = tls ]; then
      out="$(timeout 5 openssl s_client -quiet -connect "127.0.0.1:$2" </dev/null 2>/dev/null | head -1 || true)"
    else
      out="$(timeout 5 bash -c "exec 3<>/dev/tcp/127.0.0.1/$2; head -1 <&3" 2>/dev/null || true)"
    fi
    case "$out" in "$3"*) return 0 ;; esac
    sleep 1
  done
  fail "$1 on port $2 does not answer (last: ${out:-nothing})"
}

# ------------------------------------------------------------------ images
step "build images"
for img in postfix dovecot rspamd unbound; do
  docker build -q "${LABELS[@]}" -t "$INSTANCE-$img:test" -f "$MAIL/$img/Dockerfile" "$MAIL" >/dev/null \
    || fail "docker build $img"
  pass "$img"
done

# ------------------------------------------------------------------ certificate in a caddy_data layout
step "test certificate and DKIM key"
CERTDIR="$WORK/caddy-data/caddy/certificates/local/$MAIL_HOSTNAME"
mkdir -p "$CERTDIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=$MAIL_HOSTNAME" \
  -addext "subjectAltName=DNS:$MAIL_HOSTNAME" -addext "basicConstraints=critical,CA:TRUE" \
  -keyout "$CERTDIR/$MAIL_HOSTNAME.key" -out "$CERTDIR/$MAIL_HOSTNAME.crt" 2>/dev/null
chmod -R a+rX "$WORK/caddy-data"
openssl genrsa -out "$WORK/dkim.key" 2048 2>/dev/null
pass "self-signed $MAIL_HOSTNAME in .../certificates/local/$MAIL_HOSTNAME/, RSA-2048 DKIM key"

# ------------------------------------------------------------------ networks + postgres
step "postgres with the mail views"
DB_PASS="$(openssl rand -hex 16)"
ALICE_PW="alice-$(openssl rand -hex 6)"
BOB_PW="bob-$(openssl rand -hex 6)"
docker network create "${LABELS[@]}" --internal "$INSTANCE-db" >/dev/null
docker network create "${LABELS[@]}" "$INSTANCE-mail" >/dev/null
docker run -d "${LABELS[@]}" --name "$INSTANCE-postgres" --network "$INSTANCE-db" --network-alias postgres \
  -e POSTGRES_USER=panel -e POSTGRES_DB=panel -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" \
  -v "$REPO/deploy/test/mail-views.sql:/docker-entrypoint-initdb.d/01-mail.sql:ro" \
  --health-cmd "pg_isready -U panel -d panel" --health-interval 1s postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$INSTANCE-postgres")" = healthy ] && break; sleep 1
done
# The init script runs before the final start; wait until the views exist.
for _ in $(seq 1 30); do
  docker exec "$INSTANCE-postgres" psql -U panel -d panel -tAc "SELECT 1 FROM pg_views WHERE viewname='v_senders'" 2>/dev/null | grep -q 1 && break
  sleep 1
done

hash() { # password -> {ARGON2ID}$argon2id$...
  docker run --rm "${LABELS[@]}" --entrypoint sh "$INSTANCE-dovecot:test" \
    -c 'touch /etc/dovecot/dovecot.conf && doveadm pw -s ARGON2ID -p "$1"' sh "$1"
}
ALICE_HASH="$(hash "$ALICE_PW")"
BOB_HASH="$(hash "$BOB_PW")"
# shellcheck disable=SC2016 # literal $ in the expected prefix
case "$ALICE_HASH" in '{ARGON2ID}$argon2id$v=19$m=65536,t=3,p=1$'*) pass "doveadm pw -s ARGON2ID: ${ALICE_HASH:0:40}..." ;;
  *) fail "unexpected hash format: $ALICE_HASH" ;; esac

docker exec -i "$INSTANCE-postgres" psql -v ON_ERROR_STOP=1 -q -U panel -d panel \
  -v dbpass="$DB_PASS" -v alice="$ALICE_HASH" -v bob="$BOB_HASH" >/dev/null <<'SQL' || fail "test data"
ALTER ROLE mail_reader PASSWORD :'dbpass';
INSERT INTO mail.domains (domain) VALUES ('panel.test'), ('node1.test'), ('inactive.test');
UPDATE mail.domains SET active = false WHERE domain = 'inactive.test';
INSERT INTO mail.mailboxes (domain_id, local_part, address, name, password_hash, quota_mb)
  SELECT id, 'alice', 'alice@panel.test', 'Alice', :'alice', 50 FROM mail.domains WHERE domain = 'panel.test';
INSERT INTO mail.mailboxes (domain_id, local_part, address, name, password_hash, quota_mb)
  SELECT id, 'bob', 'bob@panel.test', 'Bob', :'bob', 0 FROM mail.domains WHERE domain = 'panel.test';
INSERT INTO mail.aliases (domain_id, address, goto)
  SELECT id, 'info@panel.test', 'alice@panel.test' FROM mail.domains WHERE domain = 'panel.test';
INSERT INTO mail.aliases (domain_id, address, goto)
  SELECT id, '@node1.test', 'bob@panel.test' FROM mail.domains WHERE domain = 'node1.test';
SQL
docker exec -e PGPASSWORD="$DB_PASS" "$INSTANCE-postgres" psql -h 127.0.0.1 -U mail_reader -d panel -tAc \
  "SELECT count(*) FROM mail.v_senders" | grep -qx 4 || fail "mail_reader cannot read mail.v_senders (expected 4 rows)"
if docker exec -e PGPASSWORD="$DB_PASS" "$INSTANCE-postgres" psql -h 127.0.0.1 -U mail_reader -d panel -tAc \
  "SELECT count(*) FROM mail.mailboxes" >/dev/null 2>&1; then fail "mail_reader can read the table mail.mailboxes"; fi
pass "domains panel.test + node1.test, mailboxes alice (50 MB) + bob, alias info@, catch-all @node1.test; mail_reader only sees the views"

# ------------------------------------------------------------------ mail stack
step "start redis, unbound, rspamd, dovecot, postfix"
MAIL_ENV=(-e "MAIL_HOSTNAME=$MAIL_HOSTNAME" -e "MAIL_DB_PASSWORD=$DB_PASS" -e TZ=Europe/Amsterdam)
docker volume create "${LABELS[@]}" "$INSTANCE-vmail" >/dev/null
docker volume create "${LABELS[@]}" "$INSTANCE-dkim" >/dev/null
docker volume create "${LABELS[@]}" "$INSTANCE-spool" >/dev/null

docker run -d "${LABELS[@]}" --name "$INSTANCE-mail-redis" --network "$INSTANCE-mail" --network-alias mail-redis \
  --memory 128m redis:7-alpine redis-server --save "" --appendonly no >/dev/null
docker run -d "${LABELS[@]}" --name "$INSTANCE-unbound" --network "$INSTANCE-mail" --network-alias unbound \
  --memory 128m -v "$MAIL/unbound/unbound.conf:/etc/unbound/unbound.conf:ro" "$INSTANCE-unbound:test" >/dev/null

# ClamAV off in the test (memory): override.d replaces the antivirus section.
mkdir -p "$WORK/rspamd-override"
echo 'enabled = false;' > "$WORK/rspamd-override/antivirus.conf"
docker run -d "${LABELS[@]}" --name "$INSTANCE-rspamd" --network "$INSTANCE-mail" --network-alias rspamd \
  --memory 512m -e TZ=Europe/Amsterdam \
  -v "$MAIL/rspamd/local.d:/etc/rspamd/local.d:ro" -v "$WORK/rspamd-override:/etc/rspamd/override.d:ro" \
  -v "$INSTANCE-dkim:/var/lib/rspamd/dkim" "$INSTANCE-rspamd:test" >/dev/null

docker create "${LABELS[@]}" --name "$INSTANCE-dovecot" --network "$INSTANCE-db" "${MAIL_ENV[@]}" \
  --memory 512m -p 127.0.0.1::993 -p 127.0.0.1::4190 \
  -v "$MAIL/dovecot:/etc/panel-mail:ro" -v "$WORK/caddy-data:/data:ro" -v "$INSTANCE-vmail:/var/vmail" \
  "$INSTANCE-dovecot:test" >/dev/null
docker network connect --alias dovecot "$INSTANCE-mail" "$INSTANCE-dovecot"
docker start "$INSTANCE-dovecot" >/dev/null

docker create "${LABELS[@]}" --name "$INSTANCE-postfix" --hostname "$MAIL_HOSTNAME" --network "$INSTANCE-db" "${MAIL_ENV[@]}" \
  --memory 256m -p 127.0.0.1::25 -p 127.0.0.1::465 -p 127.0.0.1::587 \
  -v "$MAIL/postfix:/etc/panel-mail:ro" -v "$WORK/caddy-data:/data:ro" -v "$INSTANCE-spool:/var/spool/postfix" \
  "$INSTANCE-postfix:test" >/dev/null
docker network connect --alias postfix "$INSTANCE-mail" "$INSTANCE-postfix"
docker start "$INSTANCE-postfix" >/dev/null

P25="$(port_of "$INSTANCE-postfix" 25)"; P465="$(port_of "$INSTANCE-postfix" 465)"; P587="$(port_of "$INSTANCE-postfix" 587)"
P993="$(port_of "$INSTANCE-dovecot" 993)"; P4190="$(port_of "$INSTANCE-dovecot" 4190)"
wait_banner postfix "$P25" "220 $MAIL_HOSTNAME ESMTP"
wait_banner postfix "$P587" "220 $MAIL_HOSTNAME ESMTP"
wait_banner postfix "$P465" "220 $MAIL_HOSTNAME ESMTP" tls
wait_banner dovecot "$P993" "* OK" tls
wait_banner dovecot "$P4190" '"IMPLEMENTATION"'
pass "postfix 25/465/587 and dovecot 993/4190 answer (127.0.0.1:$P25/$P465/$P587/$P993/$P4190)"
for _ in $(seq 1 60); do
  docker exec "$INSTANCE-rspamd" rspamc stat >/dev/null 2>&1 && break; sleep 1
done
docker exec "$INSTANCE-rspamd" rspamc stat >/dev/null 2>&1 || fail "rspamd does not answer"
rlog="$(docker logs "$INSTANCE-rspamd" 2>&1)"
grep -q '^rspamd: DNS resolver unbound (' <<<"$rlog" || fail "rspamd does not use unbound as resolver"
pass "rspamd up, resolver = unbound"

# What the daemon does for PUT /api/mail/dkim/{domain}: `docker exec -u 0 panel-rspamd tee`, owner/mode like the
# directory, selectors.map, then `rspamadm control reload`.
D=/var/lib/rspamd/dkim
docker exec -u 0 -i "$INSTANCE-rspamd" tee "$D/panel.test.dkim.key.tmp" < "$WORK/dkim.key" >/dev/null || fail "tee DKIM key"
docker exec -u 0 "$INSTANCE-rspamd" sh -c "chown --reference=$D $D/panel.test.dkim.key.tmp && chmod 0640 $D/panel.test.dkim.key.tmp && mv $D/panel.test.dkim.key.tmp $D/panel.test.dkim.key" \
  || fail "chown/chmod/mv DKIM key"
printf 'panel.test dkim\n' | docker exec -u 0 -i "$INSTANCE-rspamd" tee "$D/selectors.map.tmp" >/dev/null
docker exec -u 0 "$INSTANCE-rspamd" sh -c "chown --reference=$D $D/selectors.map.tmp && chmod 0640 $D/selectors.map.tmp && mv $D/selectors.map.tmp $D/selectors.map && ls -1A $D" \
  | grep -qx 'panel.test.dkim.key' || fail "DKIM files not in $D"
[ "$(docker exec "$INSTANCE-rspamd" stat -c %U "$D/panel.test.dkim.key")" = _rspamd ] || fail "DKIM key not owned by rspamd"
docker exec "$INSTANCE-rspamd" rspamadm control reload >/dev/null || fail "rspamadm control reload"
docker exec "$INSTANCE-rspamd" mail-reload || fail "rspamd mail-reload"
sleep 3
docker exec "$INSTANCE-rspamd" rspamc stat >/dev/null 2>&1 || fail "rspamd not back after reload"
pass "DKIM key for panel.test (selector dkim) written like the daemon (exec -u 0 tee, chown --reference), rspamadm control reload + mail-reload"

# ------------------------------------------------------------------ checks
step "SMTP / IMAP"
SMTP_PORT="$P25" SUBMISSION_PORT="$P587" SUBMISSIONS_PORT="$P465" IMAPS_PORT="$P993" \
  CA_FILE="$CERTDIR/$MAIL_HOSTNAME.crt" ALICE_PW="$ALICE_PW" BOB_PW="$BOB_PW" \
  python3 -I "$REPO/deploy/test/mail-client.py" || fail "mail checks"

rlog="$(docker logs "$INSTANCE-rspamd" 2>&1)"
grep -q 'rspamd_task_write_log: .*from: <someone@outside.test>.*rcpts: <alice@panel.test>' <<<"$rlog" \
  || fail "the inbound mail was not scanned by rspamd (milter)"
grep -q 'rspamd_task_write_log: .*DKIM_SIGNED.*rcpts: <bob@panel.test>' <<<"$rlog" \
  || fail "rspamd did not log DKIM_SIGNED for the submitted mail"
pass "rspamd scanned inbound and submitted mail via the milter (DKIM_SIGNED on submission)"

step "dovecot, quota and reload"
docker exec "$INSTANCE-dovecot" test -d /var/vmail/panel.test/alice/Maildir/cur || fail "no Maildir in /var/vmail/panel.test/alice/"
[ "$(docker exec "$INSTANCE-dovecot" stat -c %u:%g /var/vmail/panel.test/alice/Maildir)" = 5000:5000 ] || fail "Maildir not owned by 5000:5000"
pass "Maildir in /var/vmail/panel.test/alice/Maildir, owner 5000:5000"
q="$(docker exec "$INSTANCE-dovecot" doveadm -f tab quota get -u alice@panel.test)"
echo "$q" | awk -F'\t' '$2=="STORAGE" && $4==51200 {f=1} END {exit !f}' || fail "quota limit of alice is not 50 MB: $q"
q="$(docker exec "$INSTANCE-dovecot" doveadm -f tab quota get -u bob@panel.test)"
echo "$q" | awk -F'\t' '$2=="STORAGE" && $4=="-" {f=1} END {exit !f}' || fail "quota of bob (0 = unlimited) is not unlimited: $q"
pass "quota from SQL: alice 51200 KiB, bob unlimited (doveadm quota get)"
users="$(docker exec "$INSTANCE-dovecot" doveadm user '*')"; grep -qx 'alice@panel.test' <<<"$users" || fail "doveadm user iterate: $users"
pass "doveadm user iterates the mailboxes (iterate_query)"
docker exec "$INSTANCE-postfix" mail-reload >/dev/null 2>&1 || fail "postfix mail-reload"
docker exec "$INSTANCE-dovecot" mail-reload >/dev/null 2>&1 || fail "dovecot mail-reload"
docker exec "$INSTANCE-postfix" postconf -h smtpd_tls_chain_files | grep -q "/data/caddy/certificates/local/$MAIL_HOSTNAME/$MAIL_HOSTNAME.crt" \
  || fail "postfix does not use the certificate from caddy_data"
wait_banner postfix "$P25" "220 $MAIL_HOSTNAME ESMTP"
wait_banner dovecot "$P993" "* OK" tls
pass "mail-reload in postfix and dovecot (certificate from caddy_data), both still answer"
docker exec "$INSTANCE-postfix" postqueue -j >/dev/null || fail "postqueue -j"
[ "$(docker exec "$INSTANCE-postfix" postconf -h myhostname)" = "$MAIL_HOSTNAME" ] || fail "postconf -h myhostname"
docker exec "$INSTANCE-postfix" postsuper -d ALL >/dev/null 2>&1 || fail "postsuper -d"
docker exec "$INSTANCE-postfix" postfix reload >/dev/null 2>&1 || fail "postfix reload"
pass "postfix: postqueue -j, postconf -h myhostname = $MAIL_HOSTNAME, postsuper -d, postfix reload"
qj="$(docker exec "$INSTANCE-dovecot" doveadm -f json quota get -u alice@panel.test || true)"
grep -q '"limit" *: *"51200"' <<<"$qj" || fail "doveadm -f json quota get: $qj"
docker exec "$INSTANCE-dovecot" doveadm reload || fail "doveadm reload"
# Note: in Dovecot 2.3 -f is a global option (`doveadm -f json quota get`), not `doveadm quota get -f json`.
pass "dovecot as root: doveadm -f json quota get -u, doveadm reload"
# The daemon queries blacklists from the host via the container IP of unbound (source = network gateway).
UB_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$INSTANCE-mail\").IPAddress}}" "$INSTANCE-unbound")"
ans="$(python3 -I -c '
import socket,sys,struct
q=struct.pack(">HHHHHH",0x1234,0x0100,1,0,0,0)+b"".join(bytes([len(p)])+p.encode() for p in "localhost.".rstrip(".").split("."))+b"\0"+struct.pack(">HH",1,1)
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(5);s.sendto(q,(sys.argv[1],53))
r=s.recv(512);print(r[3]&15)' "$UB_IP" 2>&1)" || true
[ "$ans" != 5 ] && [[ "$ans" =~ ^[0-9]+$ ]] || fail "unbound refuses queries from the host (gateway): rcode $ans"
pass "unbound answers the host via its container IP $UB_IP (rcode $ans, not REFUSED)"

printf '\nmail stack: all checks passed\n'
