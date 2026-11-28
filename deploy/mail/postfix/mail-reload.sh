#!/bin/sh
# `docker exec panel-postfix mail-reload`: pick up a renewed certificate (or the first real one from
# Caddy) and reload Postfix. Called by the daemon (POST /api/mail/reload).
set -eu
. /usr/local/lib/mail-tls.sh
mail_tls_find
postconf -e "smtpd_tls_chain_files = $TLS_KEY, $TLS_CERT"
postfix reload
