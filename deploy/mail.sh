#!/usr/bin/env bash
# Turns the mail stack (compose profile "mail") on or off on the panel machine. Used by the daemon
# (POST /api/mail/enable|disable|reload) and by hand:
#
#   sudo deploy/mail.sh enable    # COMPOSE_PROFILES += mail in panel.env, build + start the mail containers,
#                                 # recreate Caddy when its mail site changed (certificate for MAIL_HOSTNAME)
#   sudo deploy/mail.sh disable   # COMPOSE_PROFILES -= mail, stop the mail containers (data stays in the volumes)
#   sudo deploy/mail.sh reload    # new certificate/DKIM key: mail-reload in postfix, dovecot and rspamd
#   sudo deploy/mail.sh status    # docker compose ps of the mail services
#
# COMPOSE_PROFILES in panel.env is the switch that survives upgrades: install.sh/upgrade.sh start "mail" again
# only when it is listed there (and MAIL_HOSTNAME is set). Infra containers are never recreated here (--no-deps).
#
# Exit codes: 0 ok, 2 usage, 3 not configured (MAIL_HOSTNAME or MAIL_DB_PASSWORD empty), 1 other errors.
# Environment: PANEL_ENV_FILE (default /etc/panel/panel.env), MAIL_DRY_RUN=1 (print the commands only).
set -euo pipefail

DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${PANEL_ENV_FILE:-/etc/panel/panel.env}"
MAIL_SERVICES=(mail-redis unbound clamav rspamd dovecot postfix)
RELOAD_CONTAINERS=(panel-postfix panel-dovecot panel-rspamd)

die() { echo "mail.sh: $*" >&2; exit 1; }
[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE"

envval() { # last value of KEY in the env file, without surrounding quotes
  local v
  v="$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -1)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

run() {
  if [ "${MAIL_DRY_RUN:-0}" = 1 ]; then printf '[dry-run]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

PROFILES="$(envval COMPOSE_PROFILES)"

compose() {
  local files=(-f "$DEPLOY/docker-compose.yml")
  [ "$(envval HTTP_MODE)" = npm ] && files+=(-f "$DEPLOY/docker-compose.npm.yml")
  run env PANEL_ENV_FILE="$ENV_FILE" COMPOSE_PROFILES="$PROFILES" docker compose --env-file "$ENV_FILE" "${files[@]}" "$@"
}

# Writes COMPOSE_PROFILES=<list> into the env file (atomically, mode 600; adds the line when missing).
write_profiles() {
  local tmp
  if [ "${MAIL_DRY_RUN:-0}" = 1 ]; then echo "[dry-run] COMPOSE_PROFILES=$1 in $ENV_FILE"; return; fi
  tmp="$(mktemp "$(dirname "$ENV_FILE")/.panel.env.XXXXXX")"
  chmod 600 "$tmp"
  if grep -q '^COMPOSE_PROFILES=' "$ENV_FILE"; then
    sed "s/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=$1/" "$ENV_FILE" > "$tmp"
  else
    { cat "$ENV_FILE"; printf 'COMPOSE_PROFILES=%s\n' "$1"; } > "$tmp"
  fi
  chown --reference="$ENV_FILE" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$ENV_FILE"
}

profiles_without_mail() {
  local p out=()
  for p in ${PROFILES//,/ }; do [ "$p" = mail ] || out+=("$p"); done
  local IFS=,; printf '%s' "${out[*]}"
}

case "${1:-}" in
  enable)
    host="$(envval MAIL_HOSTNAME)"
    if [ -z "$host" ] || [ -z "$(envval MAIL_DB_PASSWORD)" ]; then
      echo "mail.sh: mail_not_configured: MAIL_HOSTNAME and MAIL_DB_PASSWORD must be set in $ENV_FILE" >&2
      exit 3
    fi
    PROFILES="$(profiles_without_mail)"; PROFILES="${PROFILES:+$PROFILES,}mail"
    write_profiles "$PROFILES"
    compose up -d --build --no-deps "${MAIL_SERVICES[@]}"
    # Caddy gets MAIL_HOSTNAME/MAIL_CADDY from compose; only recreated when that changed.
    compose up -d --no-deps --no-build caddy
    ;;
  disable)
    PROFILES="$(profiles_without_mail)"
    write_profiles "$PROFILES"
    compose --profile mail stop "${MAIL_SERVICES[@]}"
    ;;
  reload)
    for c in "${RELOAD_CONTAINERS[@]}"; do run docker exec "$c" mail-reload; done
    ;;
  status)
    PROFILES="${PROFILES:+$PROFILES,}mail"
    compose ps -a "${MAIL_SERVICES[@]}"
    ;;
  *)
    echo "usage: mail.sh enable|disable|reload|status" >&2; exit 2 ;;
esac
