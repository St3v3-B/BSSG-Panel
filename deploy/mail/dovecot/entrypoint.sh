#!/bin/sh
# Entrypoint of panel-dovecot: config from /etc/panel-mail (read-only mount of deploy/mail/dovecot/) to
# /etc/dovecot, with the database password and the certificate filled in.
set -eu
. /usr/local/lib/mail-tls.sh
mail_env_check

SRC=/etc/panel-mail
mkdir -p /etc/dovecot
mail_render "$SRC/dovecot.conf" /etc/dovecot/dovecot.conf
mail_render "$SRC/dovecot-sql.conf.ext" /etc/dovecot/dovecot-sql.conf.ext
chown root:root /etc/dovecot/dovecot-sql.conf.ext
chmod 0600 /etc/dovecot/dovecot-sql.conf.ext

mail_tls_find
printf 'ssl_cert = <%s\nssl_key = <%s\n' "$TLS_CERT" "$TLS_KEY" > /etc/dovecot/tls.conf

chown 5000:5000 /var/vmail
exec "$@"
