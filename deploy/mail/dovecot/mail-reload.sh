#!/bin/sh
# `docker exec panel-dovecot mail-reload`: pick up a renewed certificate and reload Dovecot.
# Called by the daemon (POST /api/mail/reload).
set -eu
. /usr/local/lib/mail-tls.sh
mail_tls_find
printf 'ssl_cert = <%s\nssl_key = <%s\n' "$TLS_CERT" "$TLS_KEY" > /etc/dovecot/tls.conf
doveadm reload
