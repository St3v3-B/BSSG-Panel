# syntax=docker/dockerfile:1
# Panel-image: bouwt de monorepo en draait de Next.js-standalone-server als uid 1000.
# Build-context = root van de repo:  docker build -f deploy/panel.Dockerfile .
# (docker compose doet dat via deploy/docker-compose.yml.) Wat niet in de context hoort
# staat in deploy/panel.Dockerfile.dockerignore.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG GO_IMAGE=golang:1.26-bookworm

# Daemon voor remote nodes (amd64 en arm64), uit dezelfde commit als het panel. Het panel serveert ze op
# /join/daemon/<arch> (met .sha256) voor `curl .../join | sudo bash` en voor "Update daemon".
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS daemon
ARG PANEL_COMMIT=dev
WORKDIR /src
COPY daemon/go.mod daemon/go.sum ./
RUN go mod download
COPY daemon/ ./
RUN set -e; mkdir -p /out; for arch in amd64 arm64; do \
      CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.version=0.1.0-${PANEL_COMMIT}" -o /out/panel-daemon-linux-$arch ./cmd/panel-daemon; \
      (cd /out && sha256sum panel-daemon-linux-$arch | cut -d' ' -f1 > panel-daemon-linux-$arch.sha256); \
    done

FROM ${NODE_IMAGE} AS build
ENV NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
# pnpm-versie volgt "packageManager" in package.json.
COPY package.json /tmp/root-package.json
RUN PNPM_VERSION=$(node -p 'require("/tmp/root-package.json").packageManager.split("@")[1]') \
 && npm install -g --no-fund --no-audit "pnpm@${PNPM_VERSION}" \
 && pnpm --version
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=panel-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --filter "@panel/web..."
# Bestanden die join.sh op een node zet (compose, Caddy-build, systemd-unit) + checksum.
RUN mkdir -p /out && tar -czf /out/node-files.tar.gz -C deploy docker-compose.node.yml caddy systemd \
 && sha256sum /out/node-files.tar.gz | cut -d' ' -f1 > /out/node-files.tar.gz.sha256
RUN mkdir -p apps/web/public \
 && pnpm --filter @panel/web build \
 && pnpm --filter @panel/web build:cli

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    TEMPLATES_DIR=/app/templates
WORKDIR /app
# Code en templates zijn van root (alleen-lezen voor de app); alleen de Next-cache is schrijfbaar.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
# CLI voor het noodaccount: deploy/install.sh --set-emergency-password
COPY --from=build /repo/apps/web/emergency-cli.mjs ./apps/web/emergency-cli.mjs
COPY --from=build /repo/packages/db/migrations ./packages/db/migrations
COPY --from=build /repo/templates ./templates
COPY --from=daemon /out/ /app/join/
COPY --from=build /out/node-files* /app/join/
COPY --from=build /repo/deploy/join/join.sh /app/join/join.sh
RUN mkdir -p apps/web/.next/cache && chown -R 1000:1000 apps/web/.next/cache
# De node-image heeft gebruiker "node" met uid/gid 1000.
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
