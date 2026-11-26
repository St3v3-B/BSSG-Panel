# Hostingpanel — regels voor iedereen die hier code schrijft

Lees eerst `docs/ontwerp.md`. Dit bestand legt vast wie wat mag wijzigen, welke keuzes in
fase 0 gemaakt zijn, en hoe je test. Per map staat in een eigen `CLAUDE.md` de taak per fase.

## Regels

1. **Een agent wijzigt alleen bestanden in zijn eigen map** (zie Eigendom). Lezen mag overal.
2. **Contracten wijzigt alleen de orchestrator**: alles in `packages/`, `daemon/proxy/router.go`,
   `daemon/proxy/fake.go`, de skeletbestanden van `apps/web/`, `deploy/panel.env.example`
   (namen van variabelen), `tests/integration/` en alle `CLAUDE.md`-bestanden.
   Heb je een wijziging nodig, zet hem dan onder **Contractvragen** in je eindrapport, met
   het precieze voorstel (diff of schema). Werk ondertussen door aan wat wel kan; blokkeert
   het echt, eindig dan met alleen die vraag.
3. **Tests schrijven en draaien** voordat je zegt dat je klaar bent. `make check` moet in
   jouw worktree groen zijn.
4. **Kleine commits** op je eigen branch `agent/<naam>`; de orchestrator merget na review.
   Niet zelf naar `main` mergen of pushen. Commitberichten in het Nederlands of Engels,
   kort, met het onderdeel vooraan (`daemon: console-backlog van 500 regels`).
5. **Geen domeinen hardcoden.** Tests gebruiken `panel.test` en `node1.test`.
6. **De echte machine niet raken** (zie Testen op deze machine).

## Eigendom

| Map / bestand | Eigenaar |
|---|---|
| `daemon/` behalve `daemon/proxy/` | daemon |
| `daemon/proxy/` behalve `router.go`, `fake.go`, `fake_test.go` | web-hosting |
| `templates/web/`, `deploy/caddy/` | web-hosting |
| `apps/web/server/`, `apps/web/app/api/` behalve `app/api/trpc/` | panel-api |
| `apps/web/app/` behalve `app/api/`, plus `apps/web/public/` | panel-ui |
| `templates/game/`, `deploy/` behalve `deploy/caddy/` en de variabelenamen in `panel.env.example` | templates-ops |
| `packages/`, `tests/`, `scripts/`, root-bestanden, `apps/web/{lib,test}/`, `apps/web/*.{ts,json,mjs}`, `apps/web/app/api/trpc/` | orchestrator |

Gedeelde bestanden met een uitzondering:
- `apps/web/package.json`: panel-api en panel-ui mogen **dependencies toevoegen** (niet
  verwijderen of scripts wijzigen). Noem het in je commitbericht.
- `daemon/go.mod` / `go.sum`: daemon en web-hosting mogen requires toevoegen.
- `pnpm-lock.yaml`: mag meeveranderen door een toegevoegde dependency; bij een conflict
  lost de orchestrator het op met `pnpm install`.

## Commando's

```
make check          # alles: pnpm install, OpenAPI-lint, typecheck + tests (TS), gofmt/vet/build/test (Go), migratie op lege Postgres
make dev            # panel op :3000 tegen de mock (PANEL_MOCK=1)
make integration    # alleen de orchestrator: echte panel + daemon + Docker (tests/integration)
pnpm --filter @panel/api gen        # TS-types opnieuw genereren na een wijziging in openapi.yaml
pnpm --filter @panel/db generate    # nieuwe migratie na een wijziging in schema.ts
```

Toolchain: Go 1.27 (module vereist 1.23+), Node 22, pnpm 12, TypeScript 5.9
(niet 7: openapi-typescript en Next hebben de TS-JS-API nodig). Next.js 16: lees
`apps/web/AGENTS.md` en de docs in `node_modules/next/dist/docs/` voordat je Next-code schrijft
(bijvoorbeeld: `middleware.ts` heet nu `proxy.ts`).

## Contracten (fase 0)

| Contract | Bestand | Gebruikt door |
|---|---|---|
| tRPC-procedures, zod in/out, toegangsniveau | `packages/api/trpc-contract.ts`, `schemas.ts` | panel-api implementeert, panel-ui roept aan |
| Router bouwen + toegangscontrole | `packages/api/trpc-builder.ts` | skelet |
| Mock met voorbeelddata | `packages/api/mock/` | panel-ui |
| Daemon-API + websocket-protocol | `packages/api/openapi.yaml` | daemon implementeert, panel-api roept aan |
| Daemon → panel | `packages/api/panel-remote.yaml` | panel-api implementeert, daemon roept aan |
| Gegenereerde TS-types van beide | `packages/api/daemon-types.ts` (+ `.gen.ts`) | panel-api |
| Template-formaat | `templates/SCHEMA.md`, `packages/api/template-schema.ts` | templates-ops, web-hosting, panel-api, daemon |
| Datamodel | `packages/db/schema.ts`, `packages/db/migrations/` | panel-api |
| Caddy-koppeling | `daemon/proxy/router.go` | daemon gebruikt, web-hosting implementeert |
| Omgeving | `deploy/panel.env.example` | iedereen |

## Keuzes uit fase 0 (bindend)

- **Toegangsniveaus** `public` / `pending` / `user` / `admin` staan per procedure in het
  contract en worden centraal afgedwongen in de builder. `admin` = in `admin_discord_ids`
  én TOTP aan én in deze sessie geverifieerd. Foutmeldingen: `UNAUTHORIZED`,
  `FORBIDDEN` met message `TOTP_PENDING`, `TOTP_REQUIRED`, `NOT_ADMIN` of `BLOCKED`.
  Rechten per server controleert de implementatie zelf.
- **Servers** heten in tRPC en de daemon-API altijd bij `uuid`; andere objecten bij numeriek `id`.
  `shortId` = eerste 8 tekens van de uuid (SFTP-gebruikersnaam `<naam>.<shortId>`).
- **Daemon-bereikbaarheid**: de daemon luistert op de unix-socket `DAEMON_SOCKET`
  (`/run/panel/daemon.sock`, voor Caddy) en op `127.0.0.1:$DAEMON_PORT`. Caddy draait als
  container en proxyt `$NODE_DOMAIN` naar de socket (gemount). Het panel bereikt de daemon
  via `DAEMON_URL` (standaard `https://$NODE_DOMAIN`), de daemon het panel via `PANEL_URL`
  (standaard `https://$PANEL_DOMAIN`).
- **Node-token**: de lokale node gebruikt `NODE_TOKEN` uit `panel.env`; het panel zet bij elke
  start `sha256(NODE_TOKEN)` en `fqdn = NODE_DOMAIN` op de node met `is_local = true`.
- **Browser-JWT**: EdDSA (Ed25519), getekend door het panel; de daemon haalt de publieke sleutel
  via `GET /api/remote/jwt-key`. Claims staan in `openapi.yaml` (Authenticatie).
- **Websocket-berichten** zijn plat (`{"event":"console_output","line":"..."}`), zie de tabel
  in `openapi.yaml`.
- **Docker-labels**: alles wat de daemon maakt krijgt `panel.managed=true`,
  `panel.instance=$PANEL_INSTANCE` (standaard `main`) en de labels uit `DOCKER_EXTRA_LABELS`.
  De daemon raakt alleen objecten met **beide** eerste labels aan. Daarnaast `panel.role`:
  `infra` (de compose-stack: panel, postgres, redis, caddy, hun netwerken en volumes — **nooit
  aanraken**), `server` (servercontainer, met `panel.server_uuid`), `install` (tijdelijke
  install-container) en `site` (site-netwerk `panel-site-<uuid>`). Servers herkent de daemon
  uitsluitend aan `panel.role=server` + `panel.server_uuid`.
- **Caddy-admin** luistert op de unix-socket `/run/panel/caddy-admin.sock` (gedeelde map met de
  daemon), niet op TCP. `CADDY_ADMIN_URL` mag `unix://…` of (tests) `http://127.0.0.1:<poort>` zijn;
  de SSL-controle gebruikt `CADDY_TLS_ADDR` (standaard `127.0.0.1:443`).
- **Templates** worden door het panel bij elke start ingelezen uit `TEMPLATES_DIR`; het panel
  zet template + variabelen om naar een volledige `ServerSpec` voor de daemon. `{{VAR}}`
  vervangt de daemon (in `startup` en `config_files`); in install-scripts staan variabelen
  alleen in de env.
- **Test-login**: met `PANEL_INSECURE_TEST_LOGIN=1` én `PANEL_DOMAIN` eindigend op `.test`
  biedt het panel `POST /api/auth/test/login {discordId, name}` dat een sessie aanmaakt zoals
  een Discord-login (account aanmaken/bijwerken). Anders bestaat de route niet (404), en met
  de vlag op een echt domein weigert het panel te starten.
- **Sessiecookie** heet `panel_session` (HttpOnly, SameSite=Lax, Secure behalve bij `.test`
  over http). In de DB staat alleen de SHA-256.
- **Kolomnamen** in de database zijn Engels; versleutelde kolommen eindigen op `_enc`.
- **Fase 2-afspraken**:
  - SFTP-gebruikersnaam `<discord-naam van de inloggende gebruiker>.<shortId>`; wachtwoord = het
    SFTP-wachtwoord (`account.setSftpPassword`) of een API-sleutel. De daemon vraagt
    `/api/remote/sftp/auth` en dwingt `files.read`/`files.write` uit het antwoord zelf af.
  - Upload/download-URL's: `https://<node fqdn>/api/servers/<uuid>/files/{upload,download}?token=…`
    met een eenmalige JWT (`files.write` of `files.read` in `permissions`, max 10 min). De daemon
    zet CORS voor `https://$PANEL_DOMAIN`.
  - Disk vol: de daemon antwoordt 507 `disk_exceeded`; panel-api vertaalt dat naar
    `PRECONDITION_FAILED` met message `DISK_EXCEEDED`. Waarschuwing bij 90% als `daemon_message`
    met `level: warning`; servers.status wordt `disk_exceeded`.
  - Daemon onbereikbaar: `servers.get`/`list` geven status `unknown` (niet de DB-status).
  - Remote nodes: het panel bewaart het token versleuteld in `nodes.token_enc` (migratie 0001).
- **Tijdzone** voor schema's en containers: `Europe/Amsterdam`.

## Testen op deze machine

Er draait al productie-achtig spul op deze machine (o.a. containers `ntp-pool*`).

- Alles wat je in tests aan Docker-objecten maakt krijgt label `panel.test=true` **en** een
  eigen run-label (bv. `panel.instance=<agent>-<pid>`). Ruim op met een filter op **beide**,
  nooit alleen op `panel.test=true` (andere agents draaien tegelijk), en nooit zonder filter.
- Gebruik willekeurige vrije poorten op `127.0.0.1`; nooit 80, 443, 2019, 2022, 3000, 8080.
- Geen schrijfacties in `/etc/panel`, `/var/lib/panel`, `/run/panel` of systemd. Gebruik een
  tijdelijke map.
- Caddy-tests op een eigen admin-poort; ACME alleen tegen Let's Encrypt **staging** of
  `tls internal`.
- Het geheugen is beperkt (8 GB, gedeeld door vijf agents): Minecraft-tests met max 1 GB heap,
  één tegelijk, en alleen als laatste stap.
- Alleen de orchestrator draait de mijlpaaltest op de echte installatie.
