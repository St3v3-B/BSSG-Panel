#!/usr/bin/env bash
# Node join script of the panel. Served by the panel at /join; it contains no secrets.
#
#   curl -fsSL __PANEL_URL__/join | sudo bash -s -- <join-code>
#
# The join code is single use and valid for one hour (Admin > Nodes > Add node). The script exchanges it over HTTPS
# for the node token and configuration, installs Docker if needed, downloads the daemon binary (sha256-verified)
# from the panel, installs the systemd unit, starts MariaDB (and Caddy when the node supports domains), and
# reports progress to the panel.
#
# Options: --yes (no questions), --no-ufw, --dry-run (writes only under --root, prints system commands),
#   --root DIR, --ip IPV4 (skip detection), --panel-url URL, --uninstall [--purge]
set -euo pipefail

PANEL_URL="${PANEL_URL:-__PANEL_URL__}"
YES=0; DRY_RUN=0; ROOT=""; UFW="ask"; FORCE_IP=""; UNINSTALL=0; PURGE=0; CODE=""
SKIP_WAIT="${JOIN_SKIP_WAIT:-0}"   # tests: no DNS/certificate waiting

usage() {
  cat <<'USAGE'
Usage: join.sh [options] <join-code>
       join.sh --uninstall [--purge]
  --yes            no questions (install Docker, open ufw ports)
  --no-ufw         do not touch the firewall
  --dry-run        change nothing on the system: write under --root (default: temporary directory), print commands
  --root DIR       (with --dry-run) target directory instead of /
  --ip IPV4        public IPv4 address (default: detected)
  --panel-url URL  panel URL (default: where this script came from)
  --uninstall      remove the daemon, the node containers and the unit (keeps /etc/panel and the data volumes unless --purge)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --no-ufw) UFW="no" ;;
    --dry-run) DRY_RUN=1 ;;
    --root) ROOT="${2:?--root needs a directory}"; shift ;;
    --ip) FORCE_IP="${2:?--ip needs an address}"; shift ;;
    --panel-url) PANEL_URL="${2:?--panel-url needs a URL}"; shift ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) CODE="$1" ;;
  esac
  shift
done

log()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
TOKEN=""
progress() { # progress <state> [message]; never fatal
  [ -n "$TOKEN" ] || return 0
  curl -fsS -m 10 -X POST "$PANEL_URL/api/join/progress" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"state\":\"$1\",\"message\":\"$(printf '%s' "${2:-}" | tr -d '"\\\n' | cut -c1-300)\"}" >/dev/null 2>&1 || true
}
die() { printf 'error: %s\n' "$*" >&2; progress failed "$*"; exit 1; }

case "$PANEL_URL" in __PANEL_URL__*) die "unknown panel URL: pass --panel-url" ;; esac
[[ "$PANEL_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "invalid panel URL: $PANEL_URL"

if [ "$DRY_RUN" = 1 ]; then
  [ -n "$ROOT" ] || ROOT="$(mktemp -d -t panel-join-XXXXXX)"
  mkdir -p "$ROOT"; ROOT="$(cd "$ROOT" && pwd)"
elif [ -n "$ROOT" ]; then
  die "--root can only be used with --dry-run"
fi

run() { if [ "$DRY_RUN" = 1 ]; then printf '[dry-run]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }

# Questions: from the terminal (stdin is the script when piped from curl). --yes answers yes.
confirm() {
  [ "$YES" = 1 ] && return 0
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    local a; read -r -p "$1 [y/N] " a </dev/tty >/dev/tty 2>&1 || return 1
    [[ "$a" =~ ^[Yy] ]]
  else
    return 1
  fi
}

INSTALL_DIR="$ROOT/opt/panel-node"
ENV_FILE="$ROOT/etc/panel/panel.env"
UNIT_DST="$ROOT/etc/systemd/system/panel-daemon.service"
BIN_DST="$ROOT/usr/local/bin/panel-daemon"
MARKER="# managed by the panel join script"

# ------------------------------------------------------------------ uninstall
if [ "$UNINSTALL" = 1 ]; then
  [ "$DRY_RUN" = 1 ] || [ "$(id -u)" = 0 ] || die "run as root (sudo)"
  if [ "$DRY_RUN" = 0 ] && command -v docker >/dev/null && docker ps -a --format '{{.Names}}' | grep -qx panel-web; then
    die "this machine runs the panel itself (container panel-web): refusing to uninstall"
  fi
  [ -f "$ENV_FILE" ] && grep -q "^$MARKER" "$ENV_FILE" || die "$ENV_FILE is missing or was not written by the join script: refusing to uninstall"
  log "removing the node (daemon, Caddy, MariaDB containers)"
  [ ! -f "$INSTALL_DIR/docker-compose.node.yml" ] || run env PANEL_ENV_FILE="$ENV_FILE" COMPOSE_PROFILES=caddy docker compose --env-file "$ENV_FILE" -f "$INSTALL_DIR/docker-compose.node.yml" down $([ "$PURGE" = 1 ] && echo -v)
  run systemctl disable --now panel-daemon.service || true
  run rm -f "$UNIT_DST" "$BIN_DST"
  run systemctl daemon-reload
  if [ "$PURGE" = 1 ]; then run rm -rf "$ROOT/etc/panel" "$INSTALL_DIR" "$ROOT/var/lib/panel"; else log "kept $ROOT/etc/panel, $INSTALL_DIR and the data in /var/lib/panel (use --purge to remove them)"; fi
  log "node removed. Delete the node in the panel (Admin > Nodes) if you have not done so."
  exit 0
fi

[ -n "$CODE" ] || { usage >&2; exit 2; }

# ------------------------------------------------------------------ preflight
log "checking this machine"
[ "$DRY_RUN" = 1 ] || [ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ "$(uname -s)" = Linux ] || die "Linux is required"
case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "unsupported architecture $(uname -m) (amd64 and arm64 only)" ;; esac
command -v curl >/dev/null || die "curl is missing"
command -v sha256sum >/dev/null || die "sha256sum is missing"
if [ "$DRY_RUN" = 0 ]; then command -v systemctl >/dev/null || die "systemd (systemctl) is required"; fi
[ -r /etc/os-release ] && . /etc/os-release && log "OS: ${PRETTY_NAME:-unknown}, $ARCH"

detect_ip() {
  local u ip
  for u in https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.me/ip; do
    ip="$(curl -4 -fsS -m 8 "$u" 2>/dev/null | tr -d '[:space:]')" || continue
    [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] && { echo "$ip"; return 0; }
  done
  return 1
}
IP="$FORCE_IP"
[ -n "$IP" ] || IP="$(detect_ip)" || die "could not detect the public IPv4 address (pass --ip)"
[[ "$IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "invalid IPv4 address: $IP"
log "public IPv4: $IP"

# ------------------------------------------------------------------ exchange the code
jget() { grep -o "\"$1\":\(\"[^\"]*\"\|[0-9a-z]*\)" <<<"$2" | head -1 | sed 's/^[^:]*://; s/^"//; s/"$//' || true; }
log "exchanging the join code with $PANEL_URL"
RESP="$(curl -fsS -m 30 -X POST "$PANEL_URL/api/join/exchange" -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\",\"ip\":\"$IP\"}")" \
  || die "the panel did not accept the join code (invalid, expired or already used: create a new one in Admin > Nodes)"
TOKEN="$(jget node_token "$RESP")"
NODE_DOMAIN="$(jget node_domain "$RESP")"
P_URL="$(jget panel_url "$RESP")"
ACME_EMAIL="$(jget acme_email "$RESP")"
DAEMON_PORT="$(jget daemon_port "$RESP")"
SFTP_PORT="$(jget sftp_port "$RESP")"
SUPPORTS="$(jget supports_domains "$RESP")"
PUBLIC_PORT="$(jget public_port "$RESP")"
DNS_MODE="$(jget dns_mode "$RESP")"
[[ "$TOKEN" =~ ^[A-Za-z0-9_-]{32,}$ ]] || { TOKEN=""; die "unexpected answer from the panel (token)"; }
[[ "$NODE_DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "unexpected answer from the panel (domain)"
[[ "$P_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "unexpected answer from the panel (panel_url)"
[[ "$ACME_EMAIL" =~ ^[^@[:space:]\"\'\\\$\`]+@[^@[:space:]\"\'\\\$\`]+$ ]] || die "unexpected answer from the panel (email)"
[[ "$DAEMON_PORT" =~ ^[0-9]{1,5}$ && "$SFTP_PORT" =~ ^[0-9]{1,5}$ && "$PUBLIC_PORT" =~ ^[0-9]{1,5}$ ]] || die "unexpected answer from the panel (ports)"
[ "$SUPPORTS" = true ] || [ "$SUPPORTS" = false ] || die "unexpected answer from the panel (supports_domains)"
log "node domain: $NODE_DOMAIN (domains: $SUPPORTS, public port $PUBLIC_PORT, DNS: $DNS_MODE)"

# ------------------------------------------------------------------ Docker
progress docker "checking Docker"
docker_ok() { command -v docker >/dev/null && docker compose version >/dev/null 2>&1 && { [ "$DRY_RUN" = 1 ] || docker info >/dev/null 2>&1; }; }
if ! docker_ok; then
  if confirm "Docker (with the compose plugin) is missing or not running. Install it with the official script (get.docker.com)?"; then
    progress docker "installing Docker"
    if [ "$DRY_RUN" = 1 ]; then echo "[dry-run] curl -fsSL https://get.docker.com | sh"; else curl -fsSL https://get.docker.com | sh; systemctl enable --now docker; fi
  else
    die "Docker is required (install it, or run again with --yes)"
  fi
fi
[ "$DRY_RUN" = 1 ] || docker_ok || die "Docker is not usable after the installation"

# ------------------------------------------------------------------ DNS
progress dns "waiting until $NODE_DOMAIN resolves to $IP"
resolves() { getent ahostsv4 "$NODE_DOMAIN" 2>/dev/null | awk '{print $1}' | grep -qx "$IP"; }
if [ "$SKIP_WAIT" = 1 ] || [ "$DRY_RUN" = 1 ]; then
  log "(not waiting for DNS: $NODE_DOMAIN must point to $IP)"
elif ! resolves; then
  [ "$DNS_MODE" = cloudflare ] && log "the panel created the DNS record; waiting for it to propagate" || log "create this DNS record, I wait until it resolves:  $NODE_DOMAIN  A  $IP  (not proxied)"
  for _ in $(seq 1 360); do resolves && break; sleep 5; done
  resolves || die "$NODE_DOMAIN does not resolve to $IP after 30 minutes"
fi

# ------------------------------------------------------------------ files from the panel
fetch_verified() { # fetch_verified <url> <dest> <sha256-url>
  local want got
  want="$(curl -fsS -m 30 "$3" | awk '{print $1}')" || die "could not fetch $3"
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] || die "the panel served an invalid checksum ($3)"
  curl -fsS -m 600 -o "$2" "$1" || die "download of $1 failed"
  got="$(sha256sum "$2" | awk '{print $1}')"
  [ "$got" = "$want" ] || { rm -f "$2"; die "sha256 mismatch for $1"; }
}

progress download "downloading the daemon"
mkdir -p "$(dirname "$BIN_DST")" "$INSTALL_DIR" "$(dirname "$ENV_FILE")" "$(dirname "$UNIT_DST")"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fetch_verified "$PANEL_URL/join/daemon/$ARCH" "$TMP/panel-daemon" "$PANEL_URL/join/daemon/$ARCH.sha256"
chmod 755 "$TMP/panel-daemon"
mv -f "$TMP/panel-daemon" "$BIN_DST"
log "daemon installed: $BIN_DST"
fetch_verified "$PANEL_URL/join/files.tar.gz" "$TMP/files.tar.gz" "$PANEL_URL/join/files.tar.gz.sha256"
tar -xzf "$TMP/files.tar.gz" -C "$INSTALL_DIR"
install -m 0644 "$INSTALL_DIR/systemd/panel-daemon.service" "$UNIT_DST"

# ------------------------------------------------------------------ env file (kept: MariaDB password)
chmod 700 "$(dirname "$ENV_FILE")"
MARIADB_PW=""
if [ -f "$ENV_FILE" ]; then MARIADB_PW="$(sed -n 's/^MARIADB_ROOT_PASSWORD=//p' "$ENV_FILE" | head -1)"; fi
if [ -z "$MARIADB_PW" ]; then
  if command -v openssl >/dev/null; then MARIADB_PW="$(openssl rand -hex 24)"; else MARIADB_PW="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"; fi
fi
ENV_TMP="$(mktemp "$(dirname "$ENV_FILE")/.panel.env.XXXXXX")"; chmod 600 "$ENV_TMP"
{
  echo "$MARKER ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "PANEL_URL=$P_URL"
  echo "NODE_DOMAIN=$NODE_DOMAIN"
  echo "NODE_TOKEN=$TOKEN"
  echo "ACME_EMAIL=$ACME_EMAIL"
  echo "DAEMON_PORT=$DAEMON_PORT"
  echo "SFTP_PORT=$SFTP_PORT"
  echo "DAEMON_SOCKET=/run/panel/daemon.sock"
  echo "DATA_DIR=/var/lib/panel"
  echo "PANEL_INSTANCE=main"
  echo "DOCKER_EXTRA_LABELS="
  echo "MARIADB_CONTAINER=panel-mariadb"
  echo "MARIADB_ROOT_PASSWORD=$MARIADB_PW"
  echo "NODE_PUBLIC_IP=$IP"
  if [ "$SUPPORTS" = true ]; then
    echo "CADDY_ADMIN_URL=unix:///run/panel/caddy-admin.sock"
    echo "CADDY_TLS_ADDR=127.0.0.1:443"
    echo "CADDY_CONTAINER=panel-caddy"
  else
    # No Caddy on 80/443: the daemon itself serves https for the node domain on this port (DNS-01 certificate via the panel).
    echo "DAEMON_TLS_PORT=$PUBLIC_PORT"
  fi
} > "$ENV_TMP"
mv -f "$ENV_TMP" "$ENV_FILE"
log "written: $ENV_FILE"

# ------------------------------------------------------------------ services
progress daemon "starting the services"
[ "$DRY_RUN" = 1 ] || mkdir -p /var/lib/panel
[ "$DRY_RUN" = 1 ] && mkdir -p "$ROOT/var/lib/panel"
compose() { PANEL_ENV_FILE="$ENV_FILE" COMPOSE_PROFILES="$([ "$SUPPORTS" = true ] && echo caddy || true)" docker compose --env-file "$ENV_FILE" -f "$INSTALL_DIR/docker-compose.node.yml" "$@"; }
if [ "$DRY_RUN" = 1 ]; then
  printf '[dry-run] COMPOSE_PROFILES=%s docker compose --env-file %q -f %q up -d --build\n' "$([ "$SUPPORTS" = true ] && echo caddy)" "$ENV_FILE" "$INSTALL_DIR/docker-compose.node.yml"
else
  compose up -d --build
fi
run systemctl daemon-reload
run systemctl enable panel-daemon.service
run systemctl restart panel-daemon.service

# Firewall: only when ufw is active, and only after asking (or with --yes).
if [ "$UFW" != no ] && [ "$DRY_RUN" = 0 ] && command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
  if [ "$SUPPORTS" = true ]; then PORTS=(80/tcp 443/tcp 443/udp "$SFTP_PORT/tcp"); else PORTS=("$PUBLIC_PORT/tcp" "$SFTP_PORT/tcp"); fi
  if confirm "ufw is active. Open ${PORTS[*]}?"; then for p in "${PORTS[@]}"; do ufw allow "$p" >/dev/null; done; else warn "ports not opened: ${PORTS[*]}"; fi
fi

# ------------------------------------------------------------------ certificate and ready
URL_HOST="$NODE_DOMAIN"; [ "$PUBLIC_PORT" = 443 ] || URL_HOST="$NODE_DOMAIN:$PUBLIC_PORT"
progress certificate "waiting for the certificate of $URL_HOST"
if [ "$SKIP_WAIT" = 1 ] || [ "$DRY_RUN" = 1 ]; then
  log "(not waiting for the certificate)"
else
  for _ in $(seq 1 120); do
    code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "https://$URL_HOST/api/system" || true)"
    [ "$code" = 401 ] && break   # the daemon answers (401 without token) over valid https
    sleep 5
  done
  [ "$code" = 401 ] || warn "https://$URL_HOST did not answer yet; the panel keeps waiting (certificate or firewall?)"
fi
progress ready "installed"

cat <<EOT

Node installed.
  domain:   https://$URL_HOST
  env:      $ENV_FILE
  unit:     $UNIT_DST
  daemon:   $BIN_DST
  compose:  $INSTALL_DIR/docker-compose.node.yml
Open the game ports of this node (the allocation range from the panel) in your firewall.
Follow the progress in the panel: Admin > Nodes.
EOT
[ "$DRY_RUN" = 1 ] && echo "(dry-run: everything is under $ROOT)"
exit 0
