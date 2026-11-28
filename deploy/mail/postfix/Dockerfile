# Postfix for the mail module (compose profile `mail`). Build context: deploy/mail.
# The configuration is not baked in: deploy/mail/postfix/ is mounted read-only on /etc/panel-mail and the
# entrypoint fills in the host name, the database password and the certificate. See docs/mail.md.
FROM debian:bookworm-slim
RUN set -eux; \
    echo "postfix postfix/main_mailer_type select No configuration" | debconf-set-selections; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      postfix postfix-pgsql ca-certificates openssl netbase; \
    rm -rf /var/lib/apt/lists/* /etc/postfix/main.cf /etc/postfix/master.cf
COPY tls.sh /usr/local/lib/mail-tls.sh
COPY postfix/entrypoint.sh /usr/local/bin/mail-entrypoint
COPY postfix/mail-reload.sh /usr/local/bin/mail-reload
RUN chmod 755 /usr/local/bin/mail-entrypoint /usr/local/bin/mail-reload
EXPOSE 25 465 587
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD postfix status >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/usr/local/bin/mail-entrypoint"]
CMD ["postfix", "start-fg"]
