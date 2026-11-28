# Development

## Monorepo layout

```text
apps/web/          Next.js 16 panel (App Router, Tailwind 4, shadcn/ui)
  app/             pages and components (user side and /admin)
  server/          tRPC routers, auth, daemon client, background jobs, Discord bot
daemon/            Go node daemon (Docker engine, console, files, SFTP, backups, Caddy proxy)
packages/api/      contracts: tRPC contract (zod), daemon OpenAPI, mock, template schema
packages/db/       Drizzle schema and migrations (PostgreSQL 16)
templates/         game and web templates (YAML), format in templates/SCHEMA.md
deploy/            docker-compose, Caddy build, systemd unit, install script
tests/             integration, multi-node and browser (Playwright) tests
```

## Toolchain

Node 22, pnpm, Go 1.26 or newer, TypeScript 5.9 and Docker (for the database tests and the Docker-backed daemon tests).
Next.js 16 differs from older versions (for example `middleware.ts` is now `proxy.ts`); see `apps/web/AGENTS.md`.

For step-by-step setup of the toolchain on Ubuntu or Windows, see [building.md](building.md).

## Running it locally

```bash
pnpm install
make dev            # panel on :3000 against the in-memory mock, no daemon or database needed
```

The mock implements the complete tRPC contract with sample data. Pick a role with
`MOCK_ROLE=admin|user|pending|anonymous`.

## Checks

```bash
make check          # what CI runs
```

`make check` runs `pnpm install`, the OpenAPI lint, typecheck and tests for all TypeScript packages, `gofmt`, `go vet`, `go build`, `go test`
for the daemon, and a migration run on an empty PostgreSQL. Other useful commands:

```bash
pnpm --filter @panel/api gen         # regenerate TS types after editing openapi.yaml
pnpm --filter @panel/db generate     # new migration after editing schema.ts
deploy/test.sh                       # shellcheck, compose validation, template smoke tests
make e2e                             # browser tests: real panel + daemon + Docker
make integration                     # real panel + daemon + Docker, API level
```

## Contracts first

The interfaces between components were written before the implementations:

| Contract | File |
|---|---|
| tRPC procedures, zod in/out, access level | `packages/api/trpc-contract.ts`, `schemas.ts` |
| Daemon API and websocket protocol | `packages/api/openapi.yaml` |
| Daemon to panel API | `packages/api/panel-remote.yaml` |
| Template format | `templates/SCHEMA.md`, `packages/api/template-schema.ts` |
| Data model | `packages/db/schema.ts` |
| Caddy integration | `daemon/proxy/router.go` |
| Environment | `deploy/panel.env.example` |

Access levels (`public`, `pending`, `user`, `admin`) are declared per procedure and enforced centrally in the router builder.
Change a contract deliberately and in its own commit.

## Testing safely

Tests never touch a real installation. Every Docker object they create carries `panel.test=true` and a unique run label, they use random free ports and
temporary directories, and they clean up only their own objects. Use `panel.test` and `node1.test` as domains; never hardcode a real one.

## How it was built

Most of the code was written by Claude Code agents working in parallel, each in its own git worktree and branch (daemon, panel API, panel UI, web hosting, templates and
ops, and later feature agents). An orchestrating session wrote the contracts first, reviewed and merged green branches and ran the integration tests after
each merge. The rules those agents followed are in [`CLAUDE.md`](../CLAUDE.md) (in Dutch), the original design is in [`ontwerp.md`](ontwerp.md) (internal, Dutch)
and a security review is in [`security-review.md`](security-review.md). Humans review and decide; contributions from humans are just as welcome.
