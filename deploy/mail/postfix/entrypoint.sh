#!/bin/sh
# Entrypoint of panel-postfix: config from /etc/panel-mail (read-only mount of deploy/mail/postfix/) to
# /etc/postfix, with MAIL_HOSTNAME, MAIL_DB_PASSWORD and the certificate filled in. No secrets in the repo.
set -eu
. /usr/local/lib/mail-tls.sh
mail_env_check

SRC=/etc/panel-mail
cp "$SRC/main.cf" "$SRC/master.cf" /etc/postfix/
mkdir -p /etc/postfix/pgsql
for f in "$SRC"/pgsql/*.cf; do
  mail_render "$f" "/etc/postfix/pgsql/$(basename "$f")"
done
# Readable for root (proxymap opens the maps before dropping privileges) and the postfix group.
chown -R root:postfix /etc/postfix/pgsql
chmod 0750 /etc/postfix/pgsql
chmod 0640 /etc/postfix/pgsql/*.cf

postconf -e "myhostname = $MAIL_HOSTNAME"
mail_tls_find
postconf -e "smtpd_tls_chain_files = $TLS_KEY, $TLS_CERT"

# Services that look up host names (lmtp to dovecot, the milter) run without chroot (master.cf), so the
# container's resolv.conf/hosts are used directly. Copy them anyway for tools that expect them.
mkdir -p /var/spool/postfix/etc
cp /etc/resolv.conf /etc/hosts /etc/services /var/spool/postfix/etc/ 2>/dev/null || true

postfix set-permissions >/dev/null 2>&1 || true
postfix check
exec "$@"
