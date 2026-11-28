# Unbound: small recursive resolver for Rspamd (compose profile `mail`). Build context: deploy/mail.
FROM debian:bookworm-slim
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends unbound dns-root-data ca-certificates; \
    rm -rf /var/lib/apt/lists/* /etc/unbound/unbound.conf.d/*
EXPOSE 53/udp 53/tcp
CMD ["unbound", "-d", "-p", "-c", "/etc/unbound/unbound.conf"]
