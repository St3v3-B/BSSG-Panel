# Eén ingang voor alle checks. Zie CLAUDE.md.
SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
GO ?= go

.PHONY: check install openapi ts go db-migrate-test dev integration fmt

check: install openapi ts go db-migrate-test
	@echo "make check: alles groen"

install:
	pnpm install --reporter=silent

openapi:
	pnpm --filter @panel/api run lint:openapi

ts:
	pnpm -r --if-present typecheck
	pnpm -r --if-present test

go:
	cd daemon && bash ../scripts/gofmt-check.sh
	cd daemon && $(GO) vet ./...
	cd daemon && $(GO) build -o bin/panel-daemon ./cmd/panel-daemon
	cd daemon && $(GO) test ./...

db-migrate-test:
	bash packages/db/scripts/test-migrate.sh

dev:
	pnpm --filter @panel/web dev

# Alleen de orchestrator draait dit (zie CLAUDE.md).
integration:
	bash tests/integration/run.sh

fmt:
	cd daemon && gofmt -w .
