# shellcheck shell=sh
# Shared by the entrypoint and mail-reload of postfix and dovecot: find the certificate Caddy obtained for
# $MAIL_HOSTNAME in caddy_data (mounted read-only on /data), otherwise a self-signed emergency certificate
# (so the service starts before Caddy has one; `mail-reload` picks up the real one later).
# Sets TLS_CERT and TLS_KEY.
mail_tls_find() {
  TLS_CERT="" TLS_KEY=""
  for crt in /data/caddy/certificates/*/"$MAIL_HOSTNAME"/"$MAIL_HOSTNAME".crt; do
    [ -f "$crt" ] || continue
    key="${crt%.crt}.key"
    [ -f "$key" ] || continue
    # Several issuers (Let's Encrypt, ZeroSSL fallback): take the newest.
    if [ -z "$TLS_CERT" ] || [ "$crt" -nt "$TLS_CERT" ]; then TLS_CERT="$crt"; TLS_KEY="$key"; fi
  done
  if [ -z "$TLS_CERT" ]; then
    TLS_CERT=/run/mail-tls/selfsigned.crt TLS_KEY=/run/mail-tls/selfsigned.key
    if [ ! -f "$TLS_CERT" ]; then
      mkdir -p /run/mail-tls && chmod 700 /run/mail-tls
      openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=$MAIL_HOSTNAME" \
        -addext "subjectAltName=DNS:$MAIL_HOSTNAME" -keyout "$TLS_KEY" -out "$TLS_CERT" 2>/dev/null
    fi
    echo "mail: no certificate from Caddy for $MAIL_HOSTNAME yet (caddy_data); using a self-signed one" >&2
  fi
}

# Checks shared by both entrypoints.
mail_env_check() {
  case "${MAIL_HOSTNAME:-}" in
    ""|*[!a-z0-9.-]*) echo "mail: MAIL_HOSTNAME is empty or invalid (set it in /etc/panel/panel.env)" >&2; exit 1 ;;
  esac
  case "${MAIL_DB_PASSWORD:-}" in
    ""|*[!A-Za-z0-9]*) echo "mail: MAIL_DB_PASSWORD is empty or contains other characters than [A-Za-z0-9]" >&2; exit 1 ;;
  esac
}

# Replace __NAME__ placeholders (values are checked above: no characters that sed would interpret).
mail_render() { # src dst
  sed -e "s|__MAIL_HOSTNAME__|$MAIL_HOSTNAME|g" \
      -e "s|__MAIL_DB_PASSWORD__|$MAIL_DB_PASSWORD|g" \
      -e "s|__MAIL_DB_HOST__|${MAIL_DB_HOST:-postgres}|g" \
      -e "s|__MAIL_DB_NAME__|${MAIL_DB_NAME:-panel}|g" "$1" > "$2"
}
