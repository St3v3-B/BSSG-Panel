# Dovecot 2.3 for the mail module (compose profile `mail`). Build context: deploy/mail.
# Configuration: deploy/mail/dovecot/ read-only on /etc/panel-mail; the entrypoint fills in the database
# password and the certificate. Mail lives in the vmail volume (/var/vmail, uid/gid 5000).
FROM debian:bookworm-slim
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      dovecot-core dovecot-imapd dovecot-lmtpd dovecot-pgsql dovecot-sieve dovecot-managesieved \
      ca-certificates openssl; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd -g 5000 vmail; useradd -u 5000 -g 5000 -d /var/vmail -s /usr/sbin/nologin -M vmail; \
    mkdir -p /var/vmail; chown 5000:5000 /var/vmail; chmod 0750 /var/vmail; \
    rm -rf /etc/dovecot/conf.d /etc/dovecot/dovecot.conf /etc/dovecot/*.ext
COPY tls.sh /usr/local/lib/mail-tls.sh
COPY dovecot/entrypoint.sh /usr/local/bin/mail-entrypoint
COPY dovecot/mail-reload.sh /usr/local/bin/mail-reload
RUN chmod 755 /usr/local/bin/mail-entrypoint /usr/local/bin/mail-reload
EXPOSE 24 993 4190 12345
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD doveadm service status imap-login >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/usr/local/bin/mail-entrypoint"]
CMD ["dovecot", "-F"]
