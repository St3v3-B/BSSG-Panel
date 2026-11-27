#!/usr/bin/env bash
# Mijlpaal 0: de migraties draaien op een lege Postgres 16.
# Start een wegwerp-container met label panel.test=true en ruimt hem altijd op.
set -euo pipefail
cd "$(dirname "$0")/.."

name="panel-test-pg-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$name" --label panel.test=true \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=panel \
  -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
port=$(docker port "$name" 5432/tcp | head -1 | cut -d: -f2)

for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -U postgres -d panel >/dev/null 2>&1 && break
  sleep 0.5
done
# pg_isready kan net te vroeg ja zeggen tijdens de init-herstart
sleep 1
for _ in $(seq 1 20); do
  docker exec "$name" psql -U postgres -d panel -c 'select 1' >/dev/null 2>&1 && break
  sleep 0.5
done

export DATABASE_URL="postgres://postgres:test@127.0.0.1:${port}/panel"
pnpm exec drizzle-kit check >/dev/null
pnpm exec tsx migrate.ts
# Tweede keer moet niets doen
pnpm exec tsx migrate.ts
tables=$(docker exec "$name" psql -U postgres -d panel -Atc "select count(*) from information_schema.tables where table_schema='public'")
echo "tables after migration: $tables"
test "$tables" -ge 20
