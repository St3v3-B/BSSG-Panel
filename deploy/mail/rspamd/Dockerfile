# Rspamd for the mail module (compose profile `mail`). Build context: deploy/mail.
# Official image plus: a DKIM key directory owned by rspamd (volume mail-dkim takes over the owner) and an
# entrypoint that points the resolver at the Unbound container (blacklists refuse public resolvers).
# Configuration: deploy/mail/rspamd/local.d read-only on /etc/rspamd/local.d.
FROM rspamd/rspamd:4.3.1
USER root
RUN mkdir -p /var/lib/rspamd/dkim && chown 11333:11333 /var/lib/rspamd/dkim && chmod 0750 /var/lib/rspamd/dkim \
    && touch /var/lib/rspamd/dkim/selectors.map && chown 11333:11333 /var/lib/rspamd/dkim/selectors.map
COPY rspamd/entrypoint.sh /usr/local/bin/mail-entrypoint
COPY rspamd/mail-reload.sh /usr/local/bin/mail-reload
RUN chmod 755 /usr/local/bin/mail-entrypoint /usr/local/bin/mail-reload
USER 11333:11333
ENTRYPOINT ["/usr/local/bin/mail-entrypoint"]
CMD ["/usr/bin/rspamd", "-f"]
