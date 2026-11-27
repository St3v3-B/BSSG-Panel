#!/usr/bin/env bash
# Removes a panel or node installation from this machine.
#
#   sudo deploy/uninstall.sh                 # asks you to type the domain to confirm
#   sudo deploy/uninstall.sh --backup        # first dump PostgreSQL + MariaDB (and copy panel.env)
#   sudo deploy/uninstall.sh --purge --yes   # also delete volumes, /etc/panel and the data directory
#   deploy/uninstall.sh --dry-run            # only print what would happen
#
# What it removes:
#   - the systemd unit panel-daemon (stopped, disabled, unit file and /usr/local/bin/panel-daemon deleted)
#   - every Docker container, network and locally built image with BOTH labels panel.managed=true and
#     panel.instance=$PANEL_INSTANCE (the compose stack, game servers, websites, install containers)
#   - with --purge only: the Docker volumes with those labels (Postgres, MariaDB, Caddy certificates),
#     /etc/panel, DATA_DIR (default /var/lib/panel, all server files) and /opt/panel-node (join installs)
# Never touched: Docker objects without both labels, other instances, the git checkout, Docker itself,
# firewall rules.
#
# Testing: PANEL_ROOT=DIR prefixes every file path (default: /), ENV_FILE overrides the env file
# (default $PANEL_ROOT/etc/panel/panel.env). See deploy/test-uninstall.sh.
set -euo pipefail

ROOT="${PANEL_ROOT:-}"
ROOT="${ROOT%/}"
ENV_FILE="${ENV_FILE:-$ROOT/etc/panel/panel.env}"
DRY_RUN=0; YES=0; PURGE=0; BACKUP=0; BACKUP_DIR=""; INSTANCE_OVERRIDE=""

usage() {
  cat <<'EOF'
Usage: uninstall.sh [options]
  --dry-run          print what would be removed and change nothing
  --yes, -y          do not ask for confirmation
  --purge            also delete data: Docker volumes (databases, certificates), /etc/panel and DATA_DIR
  --backup[=DIR]     before removing, dump PostgreSQL and MariaDB and copy panel.env to DIR
                     (default /root/panel-backup-<date>); aborts if a dump fails
  --instance NAME    PANEL_INSTANCE to remove (default: from panel.env, else main)
  -h, --help         this help
Without --purge the volumes, /etc/panel and the data directory are kept, so a later
install.sh run picks everything up again.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) YES=1 ;;
    --purge) PURGE=1 ;;
    --backup) BACKUP=1 ;;
    --backup=*) BACKUP=1; BACKUP_DIR="${1#--backup=}" ;;
    --instance) INSTANCE_OVERRIDE="${2:?--instance needs a name}"; shift ;;
    --instance=*) INSTANCE_OVERRIDE="${1#--instance=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" = 1 ]; then printf '[dry-run]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

# ---------------------------------------------------------------- read panel.env (never sourced)
env_get() {
  [ -r "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

[ "$DRY_RUN" = 1 ] || [ "$(id -u)" = 0 ] || die "run as root (sudo)"
command -v docker >/dev/null || die "docker is missing"
docker info >/dev/null 2>&1 || die "docker is not running or not reachable (needed to find the panel's containers)"

if [ -f "$ENV_FILE" ]; then
  log "using $ENV_FILE"
else
  warn "$ENV_FILE not found; using defaults"
fi
INSTANCE="${INSTANCE_OVERRIDE:-$(env_get PANEL_INSTANCE)}"
INSTANCE="${INSTANCE:-main}"
[[ "$INSTANCE" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid PANEL_INSTANCE: $INSTANCE"
PANEL_DOMAIN="$(env_get PANEL_DOMAIN)"
NODE_DOMAIN="$(env_get NODE_DOMAIN)"
DATA_DIR="$(env_get DATA_DIR)"; DATA_DIR="${DATA_DIR:-/var/lib/panel}"
MARIADB_CONTAINER="$(env_get MARIADB_CONTAINER)"; MARIADB_CONTAINER="${MARIADB_CONTAINER:-panel-mariadb}"
case "$DATA_DIR" in /|/etc|/etc/*|/usr|/usr/*|/home|/root|/var|/var/lib|/bin|/sbin|/boot|/opt) die "refusing to delete DATA_DIR=$DATA_DIR" ;; esac
[[ "$DATA_DIR" == /* ]] || die "DATA_DIR must be an absolute path (got $DATA_DIR)"

UNIT="$ROOT/etc/systemd/system/panel-daemon.service"
BIN="$ROOT/usr/local/bin/panel-daemon"
ETC_DIR="$(dirname "$ENV_FILE")"
NODE_DIR="$ROOT/opt/panel-node"
LABEL_FILTER=(--filter label=panel.managed=true --filter "label=panel.instance=$INSTANCE")

# The domain the user has to type: the panel domain on a panel host, else the node domain, else the instance.
CONFIRM="${PANEL_DOMAIN:-${NODE_DOMAIN:-$INSTANCE}}"
case "$CONFIRM" in *example.nl|*example.com) CONFIRM="$INSTANCE" ;; esac

# ---------------------------------------------------------------- inventory
mapfile -t CONTAINERS < <(docker ps -a --format '{{.Names}}' "${LABEL_FILTER[@]}")
mapfile -t NETWORKS < <(docker network ls --format '{{.Name}}' "${LABEL_FILTER[@]}")
mapfile -t VOLUMES < <(docker volume ls --format '{{.Name}}' "${LABEL_FILTER[@]}")
mapfile -t IMAGES < <(docker image ls -q "${LABEL_FILTER[@]}" | sort -u)

has_container() { local c; for c in "${CONTAINERS[@]}"; do [ "$c" = "$1" ] && return 0; done; return 1; }
list() { if [ $# -eq 0 ]; then echo "    (none)"; else printf '    %s\n' "$@"; fi; }

echo
echo "Uninstalling panel instance '$INSTANCE'${PANEL_DOMAIN:+ (panel $PANEL_DOMAIN)}${NODE_DOMAIN:+ (node $NODE_DOMAIN)}"
echo "  systemd unit: panel-daemon.service$([ -f "$UNIT" ] || echo ' (not installed)')"
echo "  daemon binary: $BIN$([ -f "$BIN" ] || echo ' (missing)')"
echo "  containers (${#CONTAINERS[@]}):"; list "${CONTAINERS[@]}"
echo "  networks (${#NETWORKS[@]}):"; list "${NETWORKS[@]}"
echo "  images built by the panel: ${#IMAGES[@]}"
if [ "$PURGE" = 1 ]; then
  echo "  volumes (${#VOLUMES[@]}), DELETED:"; list "${VOLUMES[@]}"
  echo "  DELETED: $ETC_DIR, $ROOT$DATA_DIR$([ -d "$NODE_DIR" ] && echo ", $NODE_DIR")"
else
  echo "  kept: ${#VOLUMES[@]} volume(s), $ETC_DIR, $ROOT$DATA_DIR (use --purge to delete them)"
fi
[ "$BACKUP" = 1 ] && echo "  backup first: PostgreSQL + MariaDB dumps and panel.env"
echo

# ---------------------------------------------------------------- confirm
if [ "$DRY_RUN" = 0 ] && [ "$YES" = 0 ]; then
  [ -t 0 ] || die "not a terminal: pass --yes to confirm"
  read -r -p "Type '$CONFIRM' to confirm: " answer
  [ "$answer" = "$CONFIRM" ] || die "confirmation did not match; nothing removed"
fi

# ---------------------------------------------------------------- backup
if [ "$BACKUP" = 1 ]; then
  BACKUP_DIR="${BACKUP_DIR:-$ROOT/root/panel-backup-$(date +%Y%m%d-%H%M%S)}"
  log "backup to $BACKUP_DIR"
  dump() { # file, container, command (runs inside the container; secrets come from its own env)
    local out="$BACKUP_DIR/$1"
    if [ "$DRY_RUN" = 1 ]; then printf '[dry-run] docker exec %q sh -c %q > %q\n' "$2" "$3" "$out"; return 0; fi
    docker exec "$2" sh -c "$3" > "$out.part" || { rm -f "$out.part"; die "dump of $2 failed; nothing removed (run again without --backup to skip it)"; }
    mv "$out.part" "$out"
    log "  $1 ($(wc -c < "$out") bytes)"
  }
  if [ "$DRY_RUN" = 0 ]; then
    mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
    [ ! -f "$ENV_FILE" ] || install -m 600 "$ENV_FILE" "$BACKUP_DIR/panel.env"
  fi
  if has_container panel-postgres; then
    # shellcheck disable=SC2016 # $POSTGRES_* is expanded inside the container
    dump postgres.sql panel-postgres 'exec pg_dump -U "${POSTGRES_USER:-panel}" "${POSTGRES_DB:-panel}"'
  fi
  if has_container "$MARIADB_CONTAINER"; then
    # shellcheck disable=SC2016
    dump mariadb.sql "$MARIADB_CONTAINER" 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump -uroot --all-databases --single-transaction --routines --events'
  fi
  [ "$DRY_RUN" = 1 ] || log "backup done; it contains secrets (panel.env), keep it safe"
fi

# ---------------------------------------------------------------- daemon
log "stopping the daemon"
if command -v systemctl >/dev/null; then
  run systemctl disable --now panel-daemon.service || true
fi
[ ! -f "$UNIT" ] || run rm -f "$UNIT"
[ ! -f "$BIN" ] || run rm -f "$BIN"
if command -v systemctl >/dev/null; then run systemctl daemon-reload || true; fi

# ---------------------------------------------------------------- docker
# Again by label (not by the names listed above), so nothing without both labels is ever passed to rm.
remove_by_label() { # kind (container|network|volume|image)
  local ids=()
  case "$1" in
    container) mapfile -t ids < <(docker ps -aq "${LABEL_FILTER[@]}") ;;
    network)   mapfile -t ids < <(docker network ls -q "${LABEL_FILTER[@]}") ;;
    volume)    mapfile -t ids < <(docker volume ls -q "${LABEL_FILTER[@]}") ;;
    image)     mapfile -t ids < <(docker image ls -q "${LABEL_FILTER[@]}" | sort -u) ;;
  esac
  [ "${#ids[@]}" -gt 0 ] || return 0
  case "$1" in
    container) run docker rm -f -v "${ids[@]}" >/dev/null ;;
    network)   run docker network rm "${ids[@]}" >/dev/null ;;
    volume)    run docker volume rm "${ids[@]}" >/dev/null ;;
    image)     run docker image rm -f "${ids[@]}" >/dev/null || warn "some images are still in use" ;;
  esac
}
log "removing containers"; remove_by_label container
log "removing networks";   remove_by_label network
log "removing images";     remove_by_label image
if [ "$PURGE" = 1 ]; then
  log "removing volumes"; remove_by_label volume
fi

# ---------------------------------------------------------------- files
if [ "$PURGE" = 1 ]; then
  log "removing $ETC_DIR and $ROOT$DATA_DIR"
  run rm -rf "$ETC_DIR" "$ROOT$DATA_DIR"
  [ ! -d "$NODE_DIR" ] || run rm -rf "$NODE_DIR"
fi

echo
if [ "$DRY_RUN" = 1 ]; then
  log "dry-run: nothing was changed"
else
  log "panel instance '$INSTANCE' removed"
  [ "$PURGE" = 1 ] || echo "Kept: volumes, $ETC_DIR and $ROOT$DATA_DIR. Run again with --purge to delete them."
  [ -z "${BACKUP_DIR:-}" ] || echo "Backup: $BACKUP_DIR"
  echo "Not touched: this git checkout, Docker itself, firewall rules, DNS records."
  [ -n "$PANEL_DOMAIN" ] || echo "If this was a remote node: delete it in the panel (Admin > Nodes)."
fi
