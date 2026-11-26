#!/usr/bin/env bash
# Installeert het panel op deze machine vanuit een checkout van de repo.
#
#   sudo deploy/install.sh                      # interactief
#   sudo PANEL_DOMAIN=... deploy/install.sh --non-interactive
#   deploy/install.sh --dry-run [--root DIR]    # schrijft alleen naar DIR (standaard mktemp)
#
# Stappen: vereisten controleren, /etc/panel/panel.env schrijven (bestaande waarden blijven,
# sleutels worden één keer gegenereerd, chmod 600), daemon bouwen en installeren
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

usage() {
  cat <<'EOF'
Gebruik: install.sh [opties]
  --non-interactive   geen vragen; waarden uit de omgeving (PANEL_DOMAIN, NODE_DOMAIN, ...)
  --dry-run           niets op het systeem wijzigen: schrijf naar --root (standaard een
                      tijdelijke map), print docker/systemctl-commando's in plaats van ze uit te voeren
  --root DIR          (alleen met --dry-run) doelmap in plaats van /
  --daemon-bin PATH   kant-en-klare panel-daemon gebruiken in plaats van te bouwen met Go
  --no-start          unit en compose niet (her)starten
  -h, --help          deze hulp
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --root) ROOT="${2:?--root heeft een map nodig}"; shift ;;
    --root=*) ROOT="${1#--root=}" ;;
    --daemon-bin) DAEMON_BIN_SRC="${2:?--daemon-bin heeft een pad nodig}"; shift ;;
    --daemon-bin=*) DAEMON_BIN_SRC="${1#--daemon-bin=}" ;;
    --no-start) SKIP_START=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "onbekende optie: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf 'let op: %s\n' "$*" >&2; }
die()  { printf 'fout: %s\n' "$*" >&2; exit 1; }

if [ "$DRY_RUN" = 1 ]; then
  [ -n "$ROOT" ] || ROOT="$(mktemp -d -t panel-install-XXXXXX)"
  mkdir -p "$ROOT"
  ROOT="$(cd "$ROOT" && pwd)"
elif [ -n "$ROOT" ]; then
  die "--root kan alleen samen met --dry-run"
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
  log "vereisten controleren"
  if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then die "draai als root (sudo)"; fi
  command -v docker >/dev/null || die "docker ontbreekt (https://docs.docker.com/engine/install/)"
  docker compose version >/dev/null 2>&1 || die "docker compose (v2-plugin) ontbreekt"
  if [ "$DRY_RUN" = 0 ]; then
    docker info >/dev/null 2>&1 || die "docker draait niet of is niet bereikbaar"
    command -v systemctl >/dev/null || die "systemd (systemctl) ontbreekt"
  fi
  if [ -n "$DAEMON_BIN_SRC" ]; then
    [ -x "$DAEMON_BIN_SRC" ] || die "--daemon-bin $DAEMON_BIN_SRC is geen uitvoerbaar bestand"
  elif ! command -v go >/dev/null; then
    if [ "$DRY_RUN" = 1 ]; then
      warn "go ontbreekt; daemon bouwen wordt overgeslagen (dry-run)"
    else
      die "go ontbreekt: installeer Go 1.23+ of geef --daemon-bin PATH"
    fi
  fi
  [ -f "$REPO/deploy/caddy/Caddyfile" ] || warn "deploy/caddy/Caddyfile ontbreekt nog (komt van web-hosting)"
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
  log "bestaand $ENV_FILE gevonden; waarden blijven behouden"
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
      [[ "$v" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || { echo "geen geldig domein (kleine letters)"; return 1; } ;;
    ACME_EMAIL)
      [[ "$v" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { echo "geen geldig e-mailadres"; return 1; } ;;
    OWNER_DISCORD_ID)
      [[ "$v" =~ ^[0-9]{15,21}$ ]] || { echo "Discord-ID is 15-21 cijfers"; return 1; } ;;
    DISCORD_CLIENT_ID)
      [[ "$v" =~ ^[0-9]{15,21}$|^[A-Za-z0-9_-]+$ ]] || { echo "ongeldige client-id"; return 1; } ;;
    DISCORD_CLIENT_SECRET)
      [ -n "$v" ] || { echo "mag niet leeg zijn"; return 1; } ;;
    PANEL_ENCRYPTION_KEY)
      [ "$(printf '%s' "$v" | base64 -d 2>/dev/null | wc -c)" = 32 ] || { echo "moet 32 bytes base64 zijn"; return 1; } ;;
    NODE_TOKEN)
      [[ "$v" =~ ^[A-Za-z0-9]{32,}$ ]] || { echo "minstens 32 tekens [A-Za-z0-9]"; return 1; } ;;
    NODE_PUBLIC_IP)
      [ -z "$v" ] || [[ "$v" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "geen IPv4-adres"; return 1; } ;;
    SFTP_PORT|DAEMON_PORT)
      [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -ge 1 ] && [ "$v" -le 65535 ] || { echo "geen poortnummer"; return 1; } ;;
  esac
  safe_value "$v" || { echo "geen spaties, quotes, \\, \$ of backticks"; return 1; }
}

# ask KEY "vraag" [geheim]
ask() {
  local key="$1" question="$2" secret="${3:-}" current="" input err
  if [ -n "${!key+x}" ] && [ -n "${!key}" ]; then current="${!key}"
  elif [ -n "${OLD[$key]+x}" ]; then current="${OLD[$key]}"; fi
  case "$current" in *example.nl) current="" ;; esac

  if [ "$NON_INTERACTIVE" = 1 ]; then
    [ -n "$current" ] || die "$key ontbreekt (zet hem in de omgeving)"
    err=$(validate "$key" "$current") || die "$key: $err"
    VAL[$key]="$current"; return
  fi
  while :; do
    if [ -n "$secret" ] && [ -n "$current" ]; then
      read -r -s -p "$question [bestaande waarde behouden]: " input; echo
    elif [ -n "$secret" ]; then
      read -r -s -p "$question: " input; echo
    else
      read -r -p "$question${current:+ [$current]}: " input
    fi
    input="${input:-$current}"
    if err=$(validate "$key" "$input") && [ -n "$input" ]; then VAL[$key]="$input"; return; fi
    echo "  ${err:-mag niet leeg zijn}"
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
  else v="$($gen)"; log "$key gegenereerd"; fi
  err=$(validate "$key" "$v") || die "$key: $err"
  VAL[$key]="$v"
}

gen_encryption_key() { random_b64; }
gen_node_token() { random_hex 32; }
gen_pg_password() { random_hex 24; }

collect_values() {
  log "waarden voor panel.env"
  ask PANEL_DOMAIN "Domein van het panel (bv. panel.example.nl)"
  ask NODE_DOMAIN "Domein van deze node/daemon (bv. node1.example.nl)"
  [ "${VAL[PANEL_DOMAIN]}" != "${VAL[NODE_DOMAIN]}" ] || die "PANEL_DOMAIN en NODE_DOMAIN moeten verschillen"
  ask ACME_EMAIL "E-mailadres voor Let's Encrypt"
  ask OWNER_DISCORD_ID "Jouw Discord-ID (eigenaar)"
  ask DISCORD_CLIENT_ID "Discord OAuth2 client-ID"
  ask DISCORD_CLIENT_SECRET "Discord OAuth2 client-secret" secret

  keep_or_generate PANEL_ENCRYPTION_KEY gen_encryption_key
  keep_or_generate NODE_TOKEN gen_node_token

  # Postgres-wachtwoord: bij een nieuwe installatie willekeurig, met een passende DATABASE_URL.
  # Bij een bestaande installatie blijft het zoals het was (Postgres gebruikt het alleen bij init).
  if [ -z "${POSTGRES_PASSWORD:-}" ] && [ -z "${OLD[POSTGRES_PASSWORD]+x}" ]; then
    POSTGRES_PASSWORD="$(gen_pg_password)"; log "POSTGRES_PASSWORD gegenereerd"
    if docker volume inspect panel-postgres-data >/dev/null 2>&1; then
      warn "volume panel-postgres-data bestaat al: het nieuwe wachtwoord geldt pas na een lege database"
    fi
  fi
  keep_or_default POSTGRES_PASSWORD
  if [ -z "${DATABASE_URL:-}" ] && [ -z "${OLD[DATABASE_URL]+x}" ]; then
    DATABASE_URL="postgres://panel:${VAL[POSTGRES_PASSWORD]}@postgres:5432/panel"
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
    warn "CADDY_ADMIN_URL=${OLD[CADDY_ADMIN_URL]} is verouderd; Caddy luistert nu op $(example_default CADDY_ADMIN_URL)"
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
  log "schrijven: $ENV_FILE"
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
        printf '# /etc/panel/panel.env — geschreven door deploy/install.sh (%s).\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      else
        printf '%s\n' "$line"
      fi
    done < "$EXAMPLE"
    local extra=0
    for key in "${OLD_ORDER[@]}"; do
      [[ "$known" == *" $key "* ]] && continue
      [ "$extra" = 1 ] || { printf '\n# --- overig (behouden uit het vorige bestand) ---\n'; extra=1; }
      printf '%s=%s\n' "$key" "${VAL[$key]}"
    done
  } > "$tmp"
  if [ -f "$ENV_FILE" ] && cmp -s <(grep -v '^# /etc/panel' "$tmp") <(grep -v '^# /etc/panel' "$ENV_FILE"); then
    rm -f "$tmp"; chmod 600 "$ENV_FILE"; log "panel.env ongewijzigd"
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
    log "daemon kopiëren van $DAEMON_BIN_SRC"
    cp "$DAEMON_BIN_SRC" "$tmp"
  elif command -v go >/dev/null; then
    log "daemon bouwen (go build)"
    (cd "$REPO/daemon" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$tmp" ./cmd/panel-daemon)
  else
    rm -f "$tmp"; warn "daemon niet gebouwd"; return 0
  fi
  chmod 755 "$tmp"
  # mv (rename) werkt ook als de oude binary nog draait.
  mv -f "$tmp" "$BIN_DST"
  log "daemon geïnstalleerd: $BIN_DST"
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
  if [ "$SKIP_START" = 1 ]; then log "--no-start: niets gestart"; return; fi
  log "daemon (her)starten"
  run systemctl enable panel-daemon.service
  # Herstart laat game-containers draaien (zie de unit).
  run systemctl restart panel-daemon.service
  log "panel-stack starten (docker compose up -d --build)"
  if [ "$DRY_RUN" = 1 ]; then
    compose config -q && log "docker compose config: in orde"
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
  for p in 80 443 3000; do
    if ss -Hltn "sport = :$p" | grep -q .; then warn "poort $p is al in gebruik; Caddy/panel kunnen dan niet starten"; fi
  done
}

summary() {
  cat <<EOF

Klaar.
  env:     $ENV_FILE
  unit:    $UNIT_DST
  daemon:  $BIN_DST
  compose: PANEL_ENV_FILE=$ENV_FILE docker compose --env-file $ENV_FILE -f $COMPOSE_FILE ps

DNS: A-records voor ${VAL[PANEL_DOMAIN]} en ${VAL[NODE_DOMAIN]} naar ${VAL[NODE_PUBLIC_IP]:-het publieke IP van deze machine}.
Discord redirect-URI: https://${VAL[PANEL_DOMAIN]}/api/auth/discord/callback
EOF
  [ "$DRY_RUN" = 1 ] && echo "(dry-run: alles staat onder $ROOT)"
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

main
