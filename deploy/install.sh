#!/usr/bin/env bash
# Installeert het panel op deze machine vanuit een checkout van de repo.
#
#   sudo deploy/install.sh                      # interactief
#   sudo PANEL_DOMAIN=... deploy/install.sh --non-interactive
#   deploy/install.sh --dry-run [--root DIR]    # schrijft alleen naar DIR (standaard mktemp)
#
# Remote node (alleen daemon + Caddy, geen panel/Postgres/Redis/MariaDB):
#   sudo PANEL_URL=https://panel.example.com NODE_DOMAIN=node2.example.com NODE_TOKEN=... \
#     ACME_EMAIL=admin@example.com deploy/install.sh --node-only --non-interactive
#   (of met flags: --panel-url --node-domain --node-token --acme-email --daemon-port --sftp-port)
#
# Stappen: checking requirements, /etc/panel/panel.env schrijven (bestaande waarden blijven,
# sleutels worden één keer generated, chmod 600), daemon bouwen en installeren
# (/usr/local/bin/panel-daemon), systemd-unit installeren en (her)starten, en
# `docker compose up -d --build`. Opnieuw draaien is veilig.
#
# Waarden: bij --non-interactive uit omgevingsvariabelen met dezelfde naam als in
# panel.env (een gezette variabele wint van de bestaande waarde); anders vraagt het script,
# met de bestaande waarde als standaard.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$REPO/deploy"
EXAMPLE="$DEPLOY/panel.env.example"
UNIT_SRC="$DEPLOY/systemd/panel-daemon.service"
COMPOSE_FILE="$DEPLOY/docker-compose.yml"

DRY_RUN=0
NON_INTERACTIVE=0
ROOT=""
DAEMON_BIN_SRC="${PANEL_DAEMON_BIN:-}"
SKIP_START=0
NODE_ONLY=0

usage() {
  cat <<'EOF'
Usage: install.sh [options]
  --non-interactive   no prompts; values from the environment (PANEL_DOMAIN, NODE_DOMAIN, ...)
  --dry-run           change nothing on the system: write to --root (default a
                      temporary directory), print docker/systemctl commands instead of running them
  --root DIR          (only with --dry-run) target directory instead of /
  --daemon-bin PATH   use a prebuilt panel-daemon instead of building with Go
  --no-start          do not (re)start the unit and compose
  --node-only         install a remote node only: daemon + systemd unit + Caddy (docker-compose.node.yml).
                      Needs PANEL_URL, NODE_DOMAIN, NODE_TOKEN, ACME_EMAIL (environment or the flags below)
  --panel-url URL, --node-domain HOST, --node-token TOKEN, --acme-email MAIL, --daemon-port N,
  --sftp-port N       same as the environment variables of the same name
  -h, --help          this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --root) ROOT="${2:?--root needs a directory}"; shift ;;
    --root=*) ROOT="${1#--root=}" ;;
    --daemon-bin) DAEMON_BIN_SRC="${2:?--daemon-bin needs a path}"; shift ;;
    --daemon-bin=*) DAEMON_BIN_SRC="${1#--daemon-bin=}" ;;
    --no-start) SKIP_START=1 ;;
    --node-only) NODE_ONLY=1 ;;
    --panel-url) export PANEL_URL="${2:?--panel-url needs a value}"; shift ;;
    --node-domain) export NODE_DOMAIN="${2:?--node-domain needs a value}"; shift ;;
    --node-token) export NODE_TOKEN="${2:?--node-token needs a value}"; shift ;;
    --acme-email) export ACME_EMAIL="${2:?--acme-email needs a value}"; shift ;;
    --daemon-port) export DAEMON_PORT="${2:?--daemon-port needs a value}"; shift ;;
    --sftp-port) export SFTP_PORT="${2:?--sftp-port needs a value}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[ "$NODE_ONLY" = 1 ] && COMPOSE_FILE="$DEPLOY/docker-compose.node.yml"

log()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

if [ "$DRY_RUN" = 1 ]; then
  [ -n "$ROOT" ] || ROOT="$(mktemp -d -t panel-install-XXXXXX)"
  mkdir -p "$ROOT"
  ROOT="$(cd "$ROOT" && pwd)"
elif [ -n "$ROOT" ]; then
  die "--root can only be used together with --dry-run"
fi

ENV_FILE="$ROOT/etc/panel/panel.env"
UNIT_DST="$ROOT/etc/systemd/system/panel-daemon.service"
BIN_DST="$ROOT/usr/local/bin/panel-daemon"

# Voert een systeemcommando uit, of print het in dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run]'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

compose() {
  PANEL_ENV_FILE="$ENV_FILE" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# ---------------------------------------------------------------- vereisten
check_requirements() {
  log "checking requirements"
  if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then die "run as root (sudo)"; fi
  command -v docker >/dev/null || die "docker is missing (https://docs.docker.com/engine/install/)"
  docker compose version >/dev/null 2>&1 || die "docker compose (v2 plugin) is missing"
  if [ "$DRY_RUN" = 0 ]; then
    docker info >/dev/null 2>&1 || die "docker is not running or not reachable"
    command -v systemctl >/dev/null || die "systemd (systemctl) is missing"
  fi
  if [ -n "$DAEMON_BIN_SRC" ]; then
    [ -x "$DAEMON_BIN_SRC" ] || die "--daemon-bin $DAEMON_BIN_SRC is not an executable file"
  elif ! command -v go >/dev/null; then
    if [ "$NODE_ONLY" = 1 ] && [ "$DRY_RUN" = 0 ]; then
      log "go is missing: the daemon is built in a golang container"
    elif [ "$DRY_RUN" = 1 ]; then
      warn "go is missing; skipping the daemon build (dry-run)"
    else
      die "go is missing: install Go 1.23+ or pass --daemon-bin PATH"
    fi
  fi
  [ -f "$REPO/deploy/caddy/Caddyfile" ] || warn "deploy/caddy/Caddyfile is still missing (comes from web-hosting)"
}

# ---------------------------------------------------------------- env-bestand
declare -A VAL=()   # gekozen waarden
declare -A OLD=()   # waarden uit het bestaande bestand
OLD_ORDER=()

random_b64() {
  if command -v openssl >/dev/null; then openssl rand -base64 32
  else head -c 32 /dev/urandom | base64 | tr -d '\n'; fi
}
random_hex() {
  if command -v openssl >/dev/null; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

read_existing() {
  [ -f "$ENV_FILE" ] || return 0
  log "found existing $ENV_FILE; keeping its values"
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
    # Eventuele omringende quotes weghalen.
    if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
    [ -n "${OLD[$key]+x}" ] || OLD_ORDER+=("$key")
    OLD[$key]="$val"
  done < "$ENV_FILE"
}

# Standaard uit panel.env.example.
example_default() {
  sed -n "s/^$1=//p" "$EXAMPLE" | head -1
}

# Waarden mogen geen tekens bevatten die compose (interpolatie) of systemd anders lezen.
safe_value() { [[ "$1" != *[[:space:]\"\'\\\$\`]* ]]; }

validate() {
  local key="$1" v="$2"
  case "$key" in
    PANEL_DOMAIN|NODE_DOMAIN)
      [[ "$v" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || { echo "not a valid domain (lowercase)"; return 1; } ;;
    ACME_EMAIL)
      [[ "$v" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { echo "not a valid email address"; return 1; } ;;
    OWNER_DISCORD_ID)
      [[ "$v" =~ ^[0-9]{15,21}$ ]] || { echo "Discord ID is 15-21 digits"; return 1; } ;;
    DISCORD_CLIENT_ID)
      [[ "$v" =~ ^[0-9]{15,21}$|^[A-Za-z0-9_-]+$ ]] || { echo "invalid client ID"; return 1; } ;;
    DISCORD_CLIENT_SECRET)
      [ -n "$v" ] || { echo "must not be empty"; return 1; } ;;
    PANEL_ENCRYPTION_KEY)
      [ "$(printf '%s' "$v" | base64 -d 2>/dev/null | wc -c)" = 32 ] || { echo "must be 32 bytes of base64"; return 1; } ;;
    NODE_TOKEN)
      [[ "$v" =~ ^[A-Za-z0-9]{32,}$ ]] || { echo "at least 32 characters [A-Za-z0-9]"; return 1; } ;;
    NODE_PUBLIC_IP)
      [ -z "$v" ] || [[ "$v" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "not an IPv4 address"; return 1; } ;;
    MARIADB_ROOT_PASSWORD)
      [[ "$v" =~ ^[A-Za-z0-9]{16,}$ ]] || { echo "at least 16 characters [A-Za-z0-9]"; return 1; } ;;
    PANEL_URL)
      [[ "$v" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || { echo "not a URL like https://panel.example.com (no path)"; return 1; } ;;
    SFTP_PORT|DAEMON_PORT)
      [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -ge 1 ] && [ "$v" -le 65535 ] || { echo "not a port number"; return 1; } ;;
  esac
  safe_value "$v" || { echo "no spaces, quotes, \\, \$ of backticks"; return 1; }
}

# ask KEY "vraag" [geheim]
ask() {
  local key="$1" question="$2" secret="${3:-}" current="" input err
  if [ -n "${!key+x}" ] && [ -n "${!key}" ]; then current="${!key}"
  elif [ -n "${OLD[$key]+x}" ]; then current="${OLD[$key]}"; fi
  case "$current" in *example.nl) current="" ;; esac

  if [ "$NON_INTERACTIVE" = 1 ]; then
    [ -n "$current" ] || die "$key is missing (set it in the environment)"
    err=$(validate "$key" "$current") || die "$key: $err"
    VAL[$key]="$current"; return
  fi
  while :; do
    if [ -n "$secret" ] && [ -n "$current" ]; then
      read -r -s -p "$question [keep existing value]: " input; echo
    elif [ -n "$secret" ]; then
      read -r -s -p "$question: " input; echo
    else
      read -r -p "$question${current:+ [$current]}: " input
    fi
    input="${input:-$current}"
    if err=$(validate "$key" "$input") && [ -n "$input" ]; then VAL[$key]="$input"; return; fi
    echo "  ${err:-must not be empty}"
  done
}

# Optionele waarde: omgeving > bestaand > standaard uit het voorbeeld.
keep_or_default() {
  local key="$1" v err
  if [ -n "${!key+x}" ] && [ -n "${!key}" ]; then v="${!key}"
  elif [ -n "${OLD[$key]+x}" ]; then v="${OLD[$key]}"
  else v="$(example_default "$key")"; fi
  err=$(validate "$key" "$v") || die "$key: $err"
  VAL[$key]="$v"
}

# Gegenereerde geheimen: omgeving > bestaand > nieuw.
keep_or_generate() {
  local key="$1" gen="$2" v err
  if [ -n "${!key+x}" ] && [ -n "${!key}" ]; then v="${!key}"
  elif [ -n "${OLD[$key]:-}" ]; then v="${OLD[$key]}"
  else v="$($gen)"; log "$key generated"; fi
  err=$(validate "$key" "$v") || die "$key: $err"
  VAL[$key]="$v"
}

gen_encryption_key() { random_b64; }
gen_node_token() { random_hex 32; }
gen_pg_password() { random_hex 24; }

collect_values() {
  log "values for panel.env"
  ask PANEL_DOMAIN "Domain of the panel (e.g. panel.example.com)"
  ask NODE_DOMAIN "Domain of this node/daemon (e.g. node1.example.com)"
  [ "${VAL[PANEL_DOMAIN]}" != "${VAL[NODE_DOMAIN]}" ] || die "PANEL_DOMAIN en NODE_DOMAIN must differ"
  ask ACME_EMAIL "Email address for Let's Encrypt"
  ask OWNER_DISCORD_ID "Your Discord ID (owner)"
  ask DISCORD_CLIENT_ID "Discord OAuth2 client ID"
  ask DISCORD_CLIENT_SECRET "Discord OAuth2 client secret" secret

  keep_or_generate PANEL_ENCRYPTION_KEY gen_encryption_key
  keep_or_generate NODE_TOKEN gen_node_token

  # Postgres-wachtwoord: bij een nieuwe installatie willekeurig, met een passende DATABASE_URL.
  # Bij een bestaande installatie blijft het zoals het was (Postgres gebruikt het alleen bij init).
  if [ -z "${POSTGRES_PASSWORD:-}" ] && [ -z "${OLD[POSTGRES_PASSWORD]+x}" ]; then
    POSTGRES_PASSWORD="$(gen_pg_password)"; log "POSTGRES_PASSWORD generated"
    if docker volume inspect panel-postgres-data >/dev/null 2>&1; then
      warn "volume panel-postgres-data already exists: the new password only applies to an empty database"
    fi
  fi
  keep_or_default POSTGRES_PASSWORD
  if [ -z "${DATABASE_URL:-}" ] && [ -z "${OLD[DATABASE_URL]+x}" ]; then
    DATABASE_URL="postgres://panel:${VAL[POSTGRES_PASSWORD]}@postgres:5432/panel"
  fi

  # MariaDB-rootwachtwoord (klantdatabases): zelfde regels als Postgres. MARIADB_ROOT_PASSWORD
  # staat (nog) niet in panel.env.example; dan komt hij onder "overig" in panel.env.
  if [ -z "${MARIADB_ROOT_PASSWORD:-}" ] && [ -z "${OLD[MARIADB_ROOT_PASSWORD]:-}" ] \
     && docker volume inspect panel-mariadb-data >/dev/null 2>&1; then
    warn "volume panel-mariadb-data already exists: the new MariaDB password only applies to an empty database"
  fi
  keep_or_generate MARIADB_ROOT_PASSWORD gen_pg_password
  if ! grep -q '^MARIADB_ROOT_PASSWORD=' "$EXAMPLE" && [ -z "${OLD[MARIADB_ROOT_PASSWORD]+x}" ]; then
    OLD_ORDER+=(MARIADB_ROOT_PASSWORD)
  fi

  # De daemon bereikt het lokale panel rechtstreeks (127.0.0.1:3000 wordt door compose
  # gepubliceerd): geen afhankelijkheid van externe DNS of hairpin-NAT. Een gezette waarde blijft.
  if [ -z "${PANEL_URL:-}" ] && [ -z "${OLD[PANEL_URL]:-}" ]; then
    PANEL_URL="http://127.0.0.1:3000"
  fi
  # Caddy-koppeling: alleen standaardwaarden invullen als ze ontbreken (leeg = ontbreekt;
  # een lege CADDY_ADMIN_URL zou de daemon een fake router geven).
  local k
  for k in CADDY_ADMIN_URL CADDY_TLS_ADDR; do
    [ -n "${OLD[$k]:-}" ] || unset "OLD[$k]"
  done
  if [ -n "${OLD[CADDY_ADMIN_URL]:-}" ] && [[ "${OLD[CADDY_ADMIN_URL]}" == http://127.0.0.1:2019* ]]; then
    warn "CADDY_ADMIN_URL=${OLD[CADDY_ADMIN_URL]} is outdated; Caddy now listens on $(example_default CADDY_ADMIN_URL)"
  fi

  local key
  while IFS= read -r key; do
    [ -n "${VAL[$key]+x}" ] || keep_or_default "$key"
  done < <(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' "$EXAMPLE")
  # Onbekende sleutels uit het bestaande bestand ook behouden.
  for key in "${OLD_ORDER[@]}"; do
    [ -n "${VAL[$key]+x}" ] || VAL[$key]="${OLD[$key]}"
  done
}

write_env() {
  log "writing: $ENV_FILE"
  local dir tmp line key known=" "
  dir="$(dirname "$ENV_FILE")"
  mkdir -p "$dir"
  chmod 700 "$dir"
  tmp="$(mktemp "$dir/.panel.env.XXXXXX")"
  chmod 600 "$tmp"
  {
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)= ]]; then
        key="${BASH_REMATCH[1]}"; known+="$key "
        printf '%s=%s\n' "$key" "${VAL[$key]}"
      elif [[ "$line" =~ ^#\ /etc/panel/panel.env ]]; then
        printf '# /etc/panel/panel.env — written by deploy/install.sh (%s).\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      else
        printf '%s\n' "$line"
      fi
    done < "$EXAMPLE"
    local extra=0
    for key in "${OLD_ORDER[@]}"; do
      [[ "$known" == *" $key "* ]] && continue
      [ "$extra" = 1 ] || { printf '\n# --- other (not in panel.env.example) ---\n'; extra=1; }
      printf '%s=%s\n' "$key" "${VAL[$key]}"
    done
  } > "$tmp"
  if [ -f "$ENV_FILE" ] && cmp -s <(grep -v '^# /etc/panel' "$tmp") <(grep -v '^# /etc/panel' "$ENV_FILE"); then
    rm -f "$tmp"; chmod 600 "$ENV_FILE"; log "panel.env unchanged"
  else
    mv -f "$tmp" "$ENV_FILE"
  fi
  [ "$DRY_RUN" = 1 ] || chown root:root "$ENV_FILE" "$dir"
}

# ---------------------------------------------------------------- daemon
install_daemon() {
  local tmp
  mkdir -p "$(dirname "$BIN_DST")"
  tmp="$(mktemp "$(dirname "$BIN_DST")/.panel-daemon.XXXXXX")"
  if [ -n "$DAEMON_BIN_SRC" ]; then
    log "copying daemon from $DAEMON_BIN_SRC"
    cp "$DAEMON_BIN_SRC" "$tmp"
  elif command -v go >/dev/null; then
    log "building daemon (go build)"
    (cd "$REPO/daemon" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$tmp" ./cmd/panel-daemon)
  elif [ "$NODE_ONLY" = 1 ] && [ "$DRY_RUN" = 0 ]; then
    log "building daemon in a golang container (go is not installed)"
    docker run --rm -v "$REPO/daemon":/src:ro -v "$(dirname "$tmp")":/out -w /src -e CGO_ENABLED=0 -e GOFLAGS=-buildvcs=false \
      golang:1.23 go build -trimpath -ldflags "-s -w" -o "/out/$(basename "$tmp")" ./cmd/panel-daemon
  else
    rm -f "$tmp"; warn "daemon not built"; return 0
  fi
  chmod 755 "$tmp"
  # mv (rename) werkt ook als de oude binary nog draait.
  mv -f "$tmp" "$BIN_DST"
  log "daemon installed: $BIN_DST"
}

install_unit() {
  log "systemd-unit: $UNIT_DST"
  mkdir -p "$(dirname "$UNIT_DST")"
  if ! cmp -s "$UNIT_SRC" "$UNIT_DST" 2>/dev/null; then
    install -m 0644 "$UNIT_SRC" "$UNIT_DST"
    run systemctl daemon-reload
  fi
  # Map voor de daemon-data (DATA_DIR); de daemon maakt de submappen zelf.
  local data="${VAL[DATA_DIR]:-/var/lib/panel}"
  if [ "$DRY_RUN" = 1 ]; then mkdir -p "$ROOT$data"; elif [ ! -d "$data" ]; then mkdir -p "$data" && chmod 0711 "$data"; fi
}

start_all() {
  if [ "$SKIP_START" = 1 ]; then log "--no-start: nothing started"; return; fi
  log "(re)starting daemon"
  run systemctl enable panel-daemon.service
  # Herstart laat game-containers draaien (zie de unit).
  run systemctl restart panel-daemon.service
  log "starting panel stack (docker compose up -d --build)"
  if [ "$DRY_RUN" = 1 ]; then
    compose config -q && log "docker compose config: OK"
    printf '[dry-run] PANEL_ENV_FILE=%q docker compose --env-file %q -f %q up -d --build\n' "$ENV_FILE" "$ENV_FILE" "$COMPOSE_FILE"
  else
    compose up -d --build
  fi
}

# Alleen een waarschuwing: 80/443 bezet terwijl Caddy van het panel niet draait.
check_ports() {
  [ "$DRY_RUN" = 1 ] && return 0
  command -v ss >/dev/null || return 0
  docker ps -q --filter name=^panel-caddy$ | grep -q . && return 0
  local p
  for p in 80 443 $([ "$NODE_ONLY" = 1 ] || echo 3000); do
    if ss -Hltn "sport = :$p" | grep -q .; then warn "port $p is already in use; Caddy/panel may fail to start"; fi
  done
}

summary() {
  cat <<EOF

Done.
  env:     $ENV_FILE
  unit:    $UNIT_DST
  daemon:  $BIN_DST
  compose: PANEL_ENV_FILE=$ENV_FILE docker compose --env-file $ENV_FILE -f $COMPOSE_FILE ps

DNS: A records for ${VAL[PANEL_DOMAIN]} and ${VAL[NODE_DOMAIN]} pointing to ${VAL[NODE_PUBLIC_IP]:-the public IP of this machine}.
Discord redirect URI: https://${VAL[PANEL_DOMAIN]}/api/auth/discord/callback
EOF
  [ "$DRY_RUN" = 1 ] && echo "(dry-run: everything is under $ROOT)"
  return 0
}

main() {
  check_requirements
  read_existing
  collect_values
  check_ports
  write_env
  install_daemon
  install_unit
  start_all
  summary
}


# ---------------------------------------------------------------- node-only
NODE_KEYS=(PANEL_URL NODE_DOMAIN NODE_TOKEN ACME_EMAIL DAEMON_PORT SFTP_PORT DAEMON_SOCKET DATA_DIR
  CADDY_ADMIN_URL CADDY_TLS_ADDR CADDY_CONTAINER PANEL_INSTANCE)

collect_node_values() {
  log "values for the node (panel.env without panel secrets)"
  ask PANEL_URL "URL of the panel (e.g. https://panel.example.com)"
  ask NODE_DOMAIN "Domain of this node (e.g. node2.example.com)"
  ask NODE_TOKEN "Node token (from the panel: Admin > Nodes)" secret
  ask ACME_EMAIL "Email address for Let's Encrypt"
  local key
  for key in DAEMON_PORT SFTP_PORT DAEMON_SOCKET DATA_DIR CADDY_ADMIN_URL CADDY_TLS_ADDR CADDY_CONTAINER PANEL_INSTANCE; do
    keep_or_default "$key"
  done
  [ "${VAL[PANEL_INSTANCE]}" = main ] || warn "PANEL_INSTANCE=${VAL[PANEL_INSTANCE]} (normally main)"
}

write_node_env() {
  log "writing: $ENV_FILE"
  local dir tmp key
  dir="$(dirname "$ENV_FILE")"
  mkdir -p "$dir"; chmod 700 "$dir"
  tmp="$(mktemp "$dir/.panel.env.XXXXXX")"; chmod 600 "$tmp"
  {
    printf '# /etc/panel/panel.env (remote node) - written by deploy/install.sh --node-only.\n'
    for key in "${NODE_KEYS[@]}"; do printf '%s=%s\n' "$key" "${VAL[$key]}"; done
    local extra=0
    for key in "${OLD_ORDER[@]}"; do
      [[ " ${NODE_KEYS[*]} " == *" $key "* ]] && continue
      [ "$extra" = 1 ] || { printf '\n# --- other ---\n'; extra=1; }
      printf '%s=%s\n' "$key" "${OLD[$key]}"
    done
  } > "$tmp"
  if [ -f "$ENV_FILE" ] && cmp -s <(grep -v '^# /etc/panel' "$tmp") <(grep -v '^# /etc/panel' "$ENV_FILE"); then
    rm -f "$tmp"; chmod 600 "$ENV_FILE"; log "panel.env unchanged"
  else
    mv -f "$tmp" "$ENV_FILE"
  fi
  [ "$DRY_RUN" = 1 ] || chown root:root "$ENV_FILE" "$dir"
}

start_node() {
  if [ "$SKIP_START" = 1 ]; then log "--no-start: nothing started"; return; fi
  log "(re)starting daemon"
  run systemctl enable panel-daemon.service
  run systemctl restart panel-daemon.service
  log "starting Caddy (docker compose up -d --build)"
  if [ "$DRY_RUN" = 1 ]; then
    compose config -q && log "docker compose config: OK"
    printf '[dry-run] PANEL_ENV_FILE=%q docker compose --env-file %q -f %q up -d --build\n' "$ENV_FILE" "$ENV_FILE" "$COMPOSE_FILE"
  else
    compose up -d --build
  fi
  # Firewall: alleen als ufw actief is.
  if [ "$DRY_RUN" = 0 ] && command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    local p; for p in 80/tcp 443/tcp 443/udp "${VAL[SFTP_PORT]}/tcp"; do run ufw allow "$p" >/dev/null; done
  fi
}

node_summary() {
  cat <<EOT

Node installed.
  env:     $ENV_FILE
  unit:    $UNIT_DST
  daemon:  $BIN_DST
  compose: PANEL_ENV_FILE=$ENV_FILE docker compose --env-file $ENV_FILE -f $COMPOSE_FILE ps

DNS: an A record for ${VAL[NODE_DOMAIN]} pointing to this machine. Open ports 80, 443 and ${VAL[SFTP_PORT]} (SFTP).
Then check Admin > Nodes in the panel: the node should be online.
EOT
  [ "$DRY_RUN" = 1 ] && echo "(dry-run: everything is under $ROOT)"
  return 0
}

node_main() {
  check_requirements
  read_existing
  collect_node_values
  check_ports
  write_node_env
  install_daemon
  install_unit
  start_node
  node_summary
}

if [ "$NODE_ONLY" = 1 ]; then node_main; else main; fi
