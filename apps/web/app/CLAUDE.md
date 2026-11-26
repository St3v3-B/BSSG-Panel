# panel-ui — schermen

Eigen mappen: `apps/web/app/` (behalve `app/api/`) en `apps/web/public/`. Componenten in
`app/_components/` (shadcn/ui in `app/_components/ui/`, zie `components.json`), hooks in
`app/_hooks/`, hulpcode in `app/_lib/`. Lees de root-`CLAUDE.md` en `apps/web/AGENTS.md`.

Je bouwt tegen de mock: `make dev` (PANEL_MOCK=1, `MOCK_ROLE=admin|user|pending|anonymous`).
Data alleen via `import { trpc } from "@/lib/trpc"`; types komen uit het contract
(`@panel/api`), nooit eigen kopieën van schema's. De `TRPCProvider` in `app/layout.tsx` moet
blijven. Dark mode is standaard. Teksten in het Nederlands. Panelnaam uit `auth.branding`
in titel, header en loginpagina.

Dependencies die je mag toevoegen: `@xterm/xterm` + addons, `@monaco-editor/react`, `qrcode`,
shadcn-componenten (Radix), `@testing-library/react`, `jsdom`.

## Fase 1 — taak

1. **Login** (`/login`): Discord-knop (`auth.discordLoginUrl`); als `auth.me` een sessie met
   `totpVerified: false` geeft, de TOTP-stap (`auth.verifyTotp`). Niet ingelogd → overal
   naar `/login`; `FORBIDDEN BLOCKED` netjes tonen.
2. **Layout**: header met branding, gebruikersmenu (account, uitloggen), en voor admins een
   knop om te wisselen tussen `/` en `/admin`.
3. **Overzicht** (`/`): eigen servers met status, adres en verbruik (`servers.list`, en
   `servers.stats` voor draaiende servers).
4. **Serverpagina** (`/servers/[uuid]`): xterm.js-console via de websocket uit
   `servers.consoleToken` (protocol: tabel in `packages/api/openapi.yaml`), inclusief
   token-refresh (`token_expiring` → nieuw token → opnieuw `auth`), reconnect met backoff,
   invoerregel met geschiedenis, powerknoppen (op basis van `permissions`), live stats
   (CPU, RAM, disk, netwerk) uit `stats`-berichten, status-badge. In mock-modus bestaat de
   daemon niet: bouw de websocket achter een kleine transport-laag met een mock-transport die
   nep-logregels en stats stuurt als `process.env.NEXT_PUBLIC_PANEL_MOCK === "1"` of de
   socket-host op `.test` eindigt.
5. **Account** (`/account`): 2FA aanzetten (QR-code uit `otpauthUrl` + code), uitzetten.
6. **Admin** (`/admin`): alleen voor admins met TOTP; zonder TOTP → uitleg + link naar
   `/account`. Serverlijst (`admin.servers.list`) en **server aanmaken voor een gebruiker**:
   eigenaar kiezen of vooraf aanmaken op Discord-ID (`admin.users.list/create`), node,
   template met zijn variabelen, vrije allocations van die node, limieten (standaard uit
   settings). Na aanmaken naar de serverpagina.

**Tests**: vitest + Testing Library (jsdom) voor de console-transport (refresh-flow), het
aanmaakformulier en de routebeveiliging; `pnpm --filter @panel/web build` moet slagen.

**Klaar als**: `make check` groen en alle bovenstaande schermen werken tegen de mock, in alle
`MOCK_ROLE`s.

## Fase 2
Filemanager met Monaco (lijst, bewerken, upload via `files.uploadUrl`, download, hernoemen,
zippen), SFTP-gegevens, subusers-scherm met rechten, account (API-sleutels, SFTP-wachtwoord),
admin: nodes (token + installcommando), allocations, gebruikers, templates (YAML-editor met
`validate`), activiteitenlog.

## Fase 3
Domeinscherm (records met kopieerknoppen, live status elke 30 s, uitleg per provider,
waarschuwingen: oranje wolk, AAAA, CNAME op apex), databasescherm, PHP-versie kiezen.

## Fase 4
Backups- en schema-schermen, admin: S3-doelen, instellingen (naam, logo, kleur, limieten),
dashboard met nodes, fouten en noodaccount-meldingen.
