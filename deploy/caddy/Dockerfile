# Caddy met de Cloudflare-DNS-module (wildcard-certificaten via de DNS-challenge).
# Versies gepind; bij een update beide CADDY_VERSION-regels en de module samen verhogen.
ARG CADDY_VERSION=2.11.9

FROM caddy:${CADDY_VERSION}-builder AS builder
ARG CADDY_VERSION
RUN xcaddy build v${CADDY_VERSION} \
    --with github.com/caddy-dns/cloudflare@v0.2.4

FROM caddy:${CADDY_VERSION}
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
