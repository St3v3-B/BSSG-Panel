# syntax=docker/dockerfile:1
# Panel-image: bouwt de monorepo en draait de Next.js-standalone-server als uid 1000.
# Build-context = root van de repo:  docker build -f deploy/panel.Dockerfile .
# (docker compose doet dat via deploy/docker-compose.yml.) Wat niet in de context hoort
# staat in deploy/panel.Dockerfile.dockerignore.

ARG NODE_IMAGE=node:22-bookworm-slim

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
RUN mkdir -p apps/web/public \
 && pnpm --filter @panel/web build

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
COPY --from=build /repo/packages/db/migrations ./packages/db/migrations
COPY --from=build /repo/templates ./templates
RUN mkdir -p apps/web/.next/cache && chown -R 1000:1000 apps/web/.next/cache
# De node-image heeft gebruiker "node" met uid/gid 1000.
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
