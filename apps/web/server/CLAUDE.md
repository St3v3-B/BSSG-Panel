# panel-api — tRPC-backend, auth, daemon-client

Eigen mappen: `apps/web/server/` en `apps/web/app/api/` (behalve `app/api/trpc/`, skelet).
Lees de root-`CLAUDE.md` en `apps/web/AGENTS.md` (Next 16 wijkt af van wat je kent).

Contract: `packages/api/trpc-contract.ts` (+ `schemas.ts`) implementeer je volledig via
`export const implementation: Implementation` in `server/index.ts`; de builder
(`packages/api/trpc-builder.ts`) doet input/output-validatie en het toegangsniveau. Jij vult de
context (`createContext`) en controleert **rechten per server** in elke procedure.
Datamodel: `@panel/db`. Daemon-API: types uit `@panel/api` (`DaemonPaths`, `DaemonServerSpec`, …).
Remote-API (daemon → panel): `packages/api/panel-remote.yaml`.
Procedures die nog niet aan de beurt zijn laat je op NOT_IMPLEMENTED staan (bv. door
`notImplemented()` als basis te nemen en te overschrijven).

Dependencies die je mag toevoegen aan `apps/web/package.json`, o.a.: `jose`, `otplib` (of eigen
RFC 6238), `@node-rs/argon2`, `bullmq`, `ioredis`, `openapi-fetch`. Tests met vitest.

## Fase 1 — taak

1. **`server/boot.ts`** (idempotent, via `instrumentation.ts`): migraties (`@panel/db/migrate`),
   env valideren (en weigeren te starten bij `PANEL_INSECURE_TEST_LOGIN=1` zonder
   `.test`-domein), `OWNER_DISCORD_ID` in `admin_discord_ids`, lokale node upserten
   (`is_local`, `fqdn = NODE_DOMAIN`, `token_hash = sha256(NODE_TOKEN)`, poorten uit env),
   settings-standaardwaarden, Ed25519-sleutelpaar voor JWT's (versleuteld in `settings`),
   templates uit `TEMPLATES_DIR/{game,web}/*.yaml` inlezen met `parseTemplate` (bijwerken als
   `version` hoger is).
2. **Auth**: route handlers `app/api/auth/discord/login` (302 naar Discord, state-cookie) en
   `app/api/auth/discord/callback` (code → token → `/users/@me`; account aanmaken of vullen;
   geblokkeerd → weigeren), sessies in `sessions` met cookie `panel_session`, `auth.*`,
   `account.totpSetup/totpEnable/totpDisable` (secret versleuteld met `PANEL_ENCRYPTION_KEY`).
   Test-login `app/api/auth/test/login` precies zoals in de root-`CLAUDE.md`.
   `createContext`: sessie opzoeken, `isAdmin` **bij elk verzoek** uit `admin_discord_ids`.
3. **Daemon-client** (`server/daemon/`): per node, URL = `DAEMON_URL` voor de lokale node
   (anders `https://<fqdn>`), Bearer node-token. Het panel bewaart alleen de hash van tokens; voor
   de lokale node komt het token uit `NODE_TOKEN`. (Remote nodes: token versleuteld bewaren is een
   open punt voor later; meld het als contractvraag als je het nodig hebt.) Timeouts, en
   `DAEMON_UNREACHABLE` als de node niet antwoordt.
4. **Template → ServerSpec**: template + servervariabelen + limieten + allocations naar de
   `ServerSpec` uit `openapi.yaml`.
5. **Procedures fase 1**: `servers.*` (list, get, stats, power, sendCommand, consoleToken,
   rename, updateVariables, reinstall, activity), `admin.servers.*` (list, create, updateLimits,
   updateOwner, updateAllocations, delete), `admin.nodes.list/get`, `admin.allocations.*`,
   `admin.users.list/get/create/setBlocked/resetTotp`, `admin.admins.*`,
   `admin.templates.list/get/validate`, `admin.activity.search`, `admin.dashboard` (eenvoudig),
   `admin.settings.get`. `servers.get` vraagt de status live aan de daemon (korte timeout) en valt
   terug op de DB.
6. **JWT-uitgifte** (`servers.consoleToken`): EdDSA, 10 min, claims zoals in `openapi.yaml`, met
   de rechten van die gebruiker op die server. `socketUrl = wss://<node fqdn>/api/servers/<uuid>/ws`.
7. **Remote-endpoints** (`app/api/remote/...`): `jwt-key`, `node/hello`,
   `servers/{uuid}/install` (status + `installed_at`, en starten als dat gevraagd was — of laat
   de daemon dat doen via `start_on_install`), `servers/{uuid}/status`.
8. **Activiteitenlog** voor elke muterende actie en elke login (`auth.login`,
   `server.power.<action>`, `admin.server.create`, …).

**Tests**: elke procedure een test (vitest), tegen een echte Postgres in Docker (label
`panel.test=true` + eigen instance-label, vrije poort; zie `packages/db/scripts/test-migrate.sh`)
en een nep-daemon (`node:http`). Rechten testen: een subuser/vreemde gebruiker krijgt FORBIDDEN,
ook via een directe aanroep. Lees `tests/integration/phase1.test.ts`: daar moet je aan voldoen.

**Klaar als**: `make check` groen, elke fase-1-route getest, rechten afgedwongen.

## Fase 2
`files.*` (via daemon; upload/download-URL met eenmalige JWT), subusers + rechtencontrole overal,
allocations volledig, API-sleutels (ook als login voor SFTP), `/api/remote/sftp/auth` met rate
limiting, `account.setSftpPassword`.

## Fase 3
`domains.*` met DNS-check via 1.1.1.1 en 8.8.8.8, providerherkenning, Cloudflare (records zetten,
zones), `databases.*`, `admin.databaseHosts.*`, `admin.dnsProviders.*`.

## Fase 4
`backups.*` en `schedules.*` met BullMQ, `admin.s3Targets.*`, `admin.settings.update`, rate
limiting (Redis) op login/API, noodaccount (`auth.emergencyLogin`, Argon2id + TOTP, melding op
dashboard).
