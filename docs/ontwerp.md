# Hostingpanel — ontwerpdocument

26 nov 2026 · Steve · versie 2

## Doel en scope

Eén zelfgebouwd panel waarin je zowel game-servers (Minecraft en andere) als websites beheert, voor eigen gebruik en Blokgenoten. Het vervangt op termijn Pelican en aaPanel. Omdat alle gebruikers vertrouwd zijn, komt er geen facturatie of klantregistratie in v1.

### In v1

- Eén machine waarop panel en node samen draaien; de daemon-opzet laat later extra nodes toe zonder herbouw
- Game-servers vanuit templates (Paper, Velocity, Folia, Fabric, generiek Java/Node)
- Websites: statisch, PHP (keuze uit versies) en Node.js
- Domeinen koppelen met DNS-hulp en automatische SSL via Let's Encrypt
- MySQL/MariaDB-databases per server of site
- Live console, bestandsbeheer in de browser en SFTP
- Backups naar S3 (de Unraid-server via `rclone serve s3`), met herstel
- Gebruikers, rollen en per-server rechten; subusers
- Limieten per server: CPU, RAM, disk, poorten

### Niet in v1

- E-mailhosting (spam, reputatie en DKIM; later of extern)
- Facturatie, registratie en klantportaal
- Eigen DNS-server (nameservers); het panel helpt wel met DNS, zie DNS-hulp
- Migratie vanuit Pelican of aaPanel (niet nodig)
- IPv6

## Architectuur

Het panel is het brein en bewaart alles in PostgreSQL; op elke node voert een Go-daemon de opdrachten uit in Docker. Caddy op de node is de enige ingang voor HTTP(S)-verkeer.

```
Browser ──HTTPS──► Caddy :443 ──► panel (Next.js)        $PANEL_DOMAIN
   │                    ├───────► daemon :8080 (websocket) $NODE_DOMAIN
   │                    └───────► site-containers        <klantdomeinen>
   └──SFTP :2022──────────────► daemon (ingebouwde SFTP)
panel ──HTTPS + node-token──► daemon ──► Docker, Caddy admin-API (localhost:2019)
```

- De browser praat via HTTPS met het panel en, voor console en stats, via een websocket met de daemon.
- **De daemon wordt niet zelf aan internet blootgesteld.** Caddy zet de daemon op een eigen (sub)domein (`$NODE_DOMAIN`) en regelt TLS. De daemon luistert alleen op localhost of het interne netwerk. Bij een tweede node draait daar ook Caddy, dus dat werkt hetzelfde.
- SFTP gaat rechtstreeks naar de daemon op poort 2022 (geen HTTP, dus niet via Caddy).
- In v1 draait alles op één machine: panel, daemon, Caddy, PostgreSQL, Redis, MariaDB en de containers. De scheiding panel ↔ daemon blijft wel bestaan, zodat een tweede node later alleen een installatie is.

### Configuratie via omgeving

Domeinen en andere installatiekeuzes staan niet in de code of de database, maar in één env-bestand: `/etc/panel/panel.env`. docker-compose (panel) en de systemd-unit van de daemon (`EnvironmentFile=`) lezen hetzelfde bestand. Het installscript vraagt de waarden en schrijft het bestand; `deploy/panel.env.example` documenteert alles.

| Variabele | Verplicht | Betekenis |
|---|---|---|
| `PANEL_DOMAIN` | ja | domein waarop het panel draait, bijvoorbeeld `panel.example.nl` |
| `NODE_DOMAIN` | ja | domein van de daemon op deze node, bijvoorbeeld `node1.example.nl` |
| `NODE_PUBLIC_IP` | nee | IPv4 dat in de DNS-instructies staat; standaard automatisch gedetecteerd |
| `ACME_EMAIL` | ja | e-mailadres voor Let's Encrypt |
| `OWNER_DISCORD_ID` | ja | Discord-ID van de eigenaar, wordt bij de eerste start in `admin_discord_ids` gezet |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | ja | Discord OAuth2-app; de redirect-URI is `https://$PANEL_DOMAIN/api/auth/discord/callback` |
| `PANEL_ENCRYPTION_KEY` | ja | 32 bytes (base64) voor AES-GCM; het installscript genereert hem |
| `DATABASE_URL`, `REDIS_URL` | nee | standaard de containers uit docker-compose |
| `SFTP_PORT`, `DAEMON_PORT` | nee | standaard 2022 en 8080 |

- De Caddy-basisconfig gebruikt `{$PANEL_DOMAIN}` en `{$NODE_DOMAIN}` als placeholders en wordt niet per installatie aangepast.
- Bij elke start zet het panel de `fqdn` van de lokale node gelijk aan `NODE_DOMAIN`. Een ander domein kiezen is dus: env aanpassen, `systemctl restart panel-daemon` en `docker compose up -d`. Daarna alleen nog de redirect-URI in het Discord-developerportaal bijwerken.
- Niets in de code mag een domein hardcoden; tests gebruiken `panel.test` en `node1.test`.

### Gebruikerskant en admin-kant

Het panel heeft twee aparte omgevingen: de gebruikerskant op `/` voor iedereen, en de admin-kant op `/admin`, alleen zichtbaar voor admins met 2FA. Een admin kan met één klik tussen beide wisselen.

| Gebruikerskant (`/`) | Admin-kant (`/admin`) |
|---|---|
| Overzicht van eigen servers en sites, met status en verbruik | Dashboard: alle nodes, belasting, vrije RAM/disk, fouten |
| Server: console, start/stop/herstart, live stats | Nodes toevoegen, daemon-token genereren, installcommando kopiëren |
| Bestanden: filemanager, editor, upload, SFTP-gegevens | Allocations: IP's en poortbereiken per node |
| Website: domeinen koppelen, DNS-instructie, SSL-status, PHP-versie kiezen | Servers en sites aanmaken voor een gebruiker, limieten zetten, verplaatsen naar andere node |
| Databases: aanmaken, wachtwoord resetten, link naar Adminer | Templates beheren: maken, bewerken, importeren |
| Backups: maken, downloaden, herstellen | Gebruikers: overzicht, 2FA resetten, blokkeren, vooraf aanmaken op Discord-ID |
| Schema's: herstarts en commando's inplannen | Admins: Discord-ID's toevoegen of weghalen |
| Subusers uitnodigen met rechten | Database-hosts, S3-doelen en DNS-providers instellen |
| Account: 2FA, API-sleutels, Discord-gegevens | Activiteitenlog van alles, zoeken op gebruiker of server |
| | Instellingen: panelnaam, logo, kleur, standaardlimieten (tabel `settings`; de naam verschijnt in titel, header en loginpagina) |

- Gebruikers kunnen zelf geen nieuwe servers aanmaken; dat doet een admin.
- In de API zit de scheiding ook: alle admin-procedures (`admin.*` in tRPC) controleren op de server of de gebruiker admin is, niet alleen in de UI.
- **Accounts ontstaan bij de eerste Discord-login.** Een admin kan een gebruiker ook vooraf aanmaken op Discord-ID, zodat er al een server aan gekoppeld kan worden voordat diegene inlogt. Bij de eerste login wordt het account dan gevuld met naam en avatar.
- **Subusers uitnodigen gaat op Discord-ID** (of op gebruikersnaam van iemand die al bekend is in het panel). Een onbekend ID maakt een leeg account aan, net als hierboven.

## Componenten

### Node-daemon (Go)

Eén binary per node die als systemd-service draait. Het panel stuurt opdrachten via een HTTPS-API met het node-token; browsers verbinden via websockets voor console en stats, met een kortlevend token dat het panel uitgeeft.

- Containers aanmaken, starten, stoppen en verwijderen via de Docker SDK.
- Limieten: CPU-quota, geheugen, swap, PIDs en disk.
  - **Disk: standaard de softe limiet.** `/var/lib/panel` krijgt geen eigen partitie, dus de daemon meet elke minuut de mapgrootte per server. Bij 90% krijgt de console een waarschuwing; bij overschrijding weigert de bestands-API en SFTP nieuwe schrijfacties en wordt de server gestopt. Starten kan pas weer als er ruimte is vrijgemaakt of de limiet omhoog is gegaan. Meten gebeurt met een efficiënte walk (geen `du`-proces per server) en verspreid over de minuut, zodat het geen piek geeft.
  - Een server kan binnen een minuut iets over de limiet gaan. Daarom bewaakt de daemon ook de vrije ruimte op de hele schijf en stopt hij bij minder dan 5% vrij de server die het snelst groeit.
  - **XFS project quota als optie:** detecteert de daemon dat `/var/lib/panel/volumes` op XFS met `prjquota` staat, dan gebruikt hij automatisch harde quota. Dat vereist bij de root-partitie de kernelparameter `rootflags=prjquota`. Het is niet nodig voor v1.
  - De daemon meldt bij het opstarten welke modus actief is (`soft` of `xfs`); het admin-dashboard toont dat.
- Console: stdout streamen, commando's naar stdin. De laatste 500 regels blijven in het geheugen, zodat een nieuwe verbinding direct context heeft.
- Stats elke 2 seconden: CPU, RAM, netwerk, disk.
- Bestands-API (lijst, lezen, schrijven, uploaden, zippen/uitpakken) en een ingebouwde SFTP-server die op het panel authenticeert. Gebruikersnaam is `<discord-naam>.<server-shortid>`, het wachtwoord een SFTP-wachtwoord of een API-sleutel uit het panel.
- Backups: `tar.zst` van de serverdata, streamen naar S3 (zie Backups).
- Herstart-veilig: bij het opstarten leest de daemon de staat van alle containers terug en synchroniseert hij de Caddy-routes opnieuw (zie Domeinen en SSL).

#### Websocket-protocol (onderdeel van het daemon-contract)

- De browser verbindt met `wss://$NODE_DOMAIN/api/servers/{uuid}/ws` en stuurt als eerste bericht `{"event":"auth","token":"<jwt>"}`.
- De JWT verloopt na 10 minuten en is gebonden aan één server en één gebruiker, met de rechten van die gebruiker erin (`console.read`, `console.write`, `power`).
- Een minuut voor het verlopen stuurt de daemon `token_expiring`. De browser haalt via het panel een nieuw token op en stuurt opnieuw `auth`. Gebeurt dat niet, dan sluit de daemon de verbinding.
- Overige berichten: `console_output`, `send_command`, `set_state` (power), `stats`, `status`, `install_output`, `backup_progress`.

### Game-servers: templates

Een template is een YAML-bestand met de Docker-image, het startcommando, variabelen (versie, geheugen, poort), een install-script, een stop-commando en een "klaar"-patroon (bijvoorbeeld `Done (` in de log) voor de status *online*. Eerste templates: Paper, Folia, Velocity, Fabric, generiek Java en generiek Node.js. Het formaat staat in `templates/SCHEMA.md`.

### Websites

Een website is hetzelfde servertype met een webtemplate: nginx + PHP-FPM (8.2, 8.3, 8.4), statisch nginx, of Node.js. Bestanden staan in `/home/container/public`, te bewerken via de filemanager en SFTP.

- Elke site krijgt een **eigen intern Docker-netwerk**, zonder uitgang naar andere containers. Caddy wordt door de daemon aan dat netwerk gekoppeld bij het aanmaken van de site en weer losgekoppeld bij verwijderen.
- Een site heeft geen allocation (publieke poort) nodig; verkeer komt alleen binnen via Caddy.
- Sites die een database gebruiken, worden ook gekoppeld aan het netwerk van de MariaDB-host (alleen poort 3306).

### Domeinen en SSL

Op elke node draait Caddy als reverse proxy op poort 80 en 443. De daemon stuurt routes naar Caddy via diens admin-API (alleen op localhost): domein → container:poort. Caddy haalt automatisch Let's Encrypt-certificaten op zodra de DNS goed staat. Ook redirects (www → kaal domein, HTTP → HTTPS).

- **De daemon is de bron van waarheid voor routes, niet Caddy.** Routes via de admin-API overleven een herstart van Caddy niet betrouwbaar. Daarom zet de daemon bij zijn eigen start, na elke Caddy-herstart (gedetecteerd via health-check) en elke 5 minuten de volledige routeset opnieuw (`Sync`).
- De vaste routes (panel en daemon-subdomein) zitten in de basisconfig van Caddy, zodat het panel bereikbaar blijft als de daemon plat ligt.
- SSL-status per domein (`pending`, `dns_wrong`, `issuing`, `active`, `failed`) haalt de daemon uit Caddy en geeft hij door aan het panel.

### DNS-hulp

Het panel helpt de gebruiker het domein goed in te stellen, zodat niemand zelf hoeft uit te zoeken welk record waar moet.

1. **Domein toevoegen**: het panel toont precies welke records nodig zijn, bijvoorbeeld `A @ → IP van de node` en `CNAME www → domein`, met kopieerknoppen.
2. **Providerherkenning**: het panel zoekt de nameservers op en herkent de provider (Cloudflare, TransIP, Hostinger, Strato, Versio, enzovoort), en toont stap-voor-stap uitleg voor precies die provider.
3. **Live controle**: elke 30 seconden (zolang het scherm open is; daarna elke 10 minuten tot het klopt) checkt het panel via 1.1.1.1 en 8.8.8.8 of de records kloppen. Per record een status: *ontbreekt*, *verkeerd IP*, *achter Cloudflare-proxy*, *ok*.
4. **Veelgemaakte fouten**:
   - Cloudflare-proxy (oranje wolk): het record wijst dan naar Cloudflare-IP's in plaats van de node. Het panel herkent de IP-reeksen van Cloudflare en legt uit dat je de wolk op grijs zet, of dat je SSL-modus *Full (strict)* nodig hebt als je de proxy wilt houden.
   - Een oud AAAA-record (er is geen IPv6, dus bezoekers en Let's Encrypt kunnen daarop vastlopen).
   - Een CNAME op het kale domein.
5. **SSL starten**: zodra alles klopt, vraagt Caddy het certificaat aan en springt de status op groen.

**Automatisch instellen (optioneel)**: koppel Cloudflare met een API-token. Dan zet het panel de records zelf met één klik, en zijn ook wildcard-certificaten via de DNS-challenge mogelijk. Dit vereist een Caddy-build met de module `caddy-dns/cloudflare`. Tokens worden versleuteld opgeslagen in de tabel `dns_providers`.

Hulpmiddelen in het domeinscherm: een DNS-lookup voor elk record, een propagatiecheck en een knop "opnieuw controleren".

### Databases

Eén of meer MariaDB-hosts, centraal geregistreerd. Het panel maakt per database een eigen gebruiker met rechten op alleen die database, en toont de gegevens in de server. Optioneel phpMyAdmin of Adminer als eigen site.

### Backups

- S3-doelen staan in een eigen tabel; elke node heeft een standaarddoel. Standaard de Unraid-server via `rclone serve s3`.
- Handmatig en via schema (bijvoorbeeld dagelijks om 04:00), met een maximum aantal per server; de oudste gaat eruit.
- **Database-dumps**: het panel geeft de daemon bij het backup-verzoek de credentials van de databases van die server mee (alleen voor de duur van het verzoek). De daemon draait `mariadb-dump` in een tijdelijke container en voegt de dumps toe aan het archief onder `_databases/`.
- **Checksum**: de daemon berekent SHA-256 tijdens het streamen; het panel bewaart die.
- **Herstel**, veilig in stappen:
  1. Server stoppen.
  2. Backup downloaden en de checksum controleren.
  3. Uitpakken naar een tijdelijke map naast de data.
  4. Pas als dat gelukt is: oude data wegzetten, tijdelijke map op zijn plek zetten, databases terugzetten.
  5. Oude data verwijderen.

  Faalt een stap vóór stap 4, dan blijft de oude data onaangeroerd.

### Schema's

Taken per server via cron-expressies: herstarten, commando sturen, backup maken. Handig voor dagelijkse herstarts van de SMP. BullMQ voert ze uit; het panel houdt `last_run`, `next_run` en het resultaat bij.

## Datamodel

PostgreSQL 16 als panel-database. Kerntabellen (Drizzle-schema in `packages/db/schema.ts`):

| Tabel | Belangrijkste velden | Relaties |
|---|---|---|
| users | id, discord_id (uniek), naam, avatar, totp_secret (versleuteld), totp_enabled, blocked, is_emergency, password_hash (alleen noodaccount), created_at, last_login_at | heeft servers, is subuser van servers |
| admin_discord_ids | discord_id, toegevoegd_door, toegevoegd_op | **enige bron voor admin-schap**; er is geen `is_admin`-kolom |
| sessions | id, user_id, token_hash, ip, user_agent, expires_at | hoort bij user |
| nodes | id, naam, fqdn, daemon_port, sftp_port, token_hash, max_ram_mb, max_disk_mb, s3_target_id, disk_quota_mode (xfs/soft) | heeft allocations, servers |
| allocations | id, node_id, ip, poort, server_id (leeg = vrij) | hoort bij node, optioneel bij server |
| templates | id, slug, naam, type (game/web), image, startcommando, stopcommando, ready_pattern, variabelen (JSON), install_script, versie | gebruikt door servers |
| servers | id, uuid, naam, owner_id, node_id, template_id, type, cpu_pct, ram_mb, swap_mb, disk_mb, status, installed_at | heeft allocations, domains, databases, backups |
| server_variables | server_id, sleutel, waarde | hoort bij server |
| subusers | server_id, user_id, rechten (text[]) | koppelt users aan servers |
| domains | id, server_id, hostnaam (uniek), doelpoort, redirect_naar, dns_provider_id (optioneel), wildcard, ssl_status, dns_status, laatst_gecontroleerd | hoort bij server |
| dns_providers | id, type (cloudflare), naam, api_token (versleuteld), zones (JSON) | gebruikt door domains |
| database_hosts | id, naam, host, poort, admin_user, admin_password (versleuteld), node_id | heeft databases |
| databases | id, server_id, host_id, naam, gebruiker, wachtwoord (versleuteld) | hoort bij server en host |
| s3_targets | id, naam, endpoint, bucket, region, access_key, secret_key (beide versleuteld), path_style | gebruikt door nodes en backups |
| backups | id, server_id, s3_target_id, naam, grootte, s3_key, sha256, status, gemaakt_op, voltooid_op | hoort bij server |
| schedules | id, server_id, naam, cron, actie, payload, actief, last_run, next_run, last_result | hoort bij server |
| api_keys | id, user_id, prefix, hash, rechten, laatst_gebruikt, expires_at | hoort bij user |
| sftp_credentials | user_id, server_id, password_hash | optioneel, naast API-sleutels |
| settings | sleutel, waarde (JSON) | panelnaam, logo, kleur, standaardlimieten |
| activity_log | id, user_id, server_id, actie, metadata (JSON), ip, tijd | audittrail |

## Beveiliging en rechten

Ook met vertrouwde gebruikers moet een gehackte WordPress-plugin of Minecraft-plugin niet bij de rest kunnen komen.

- **Containers**: niet-root user, geen privileged mode, alle Linux-capabilities eruit behalve wat nodig is, `no-new-privileges`, read-only root waar het kan (met tmpfs voor `/tmp` en runtime-mappen). Websites in een eigen intern netwerk (zie Websites).
- **Panel ↔ daemon**: alleen HTTPS, per node een eigen token (in het panel gehasht opgeslagen). De daemon accepteert alleen verzoeken met dat token. Browsertokens voor console en bestanden zijn JWT's die na 10 minuten verlopen, aan één server en één gebruiker gebonden zijn en de rechten bevatten. De daemon controleert die rechten zelf.
- **Inloggen**:
  - Discord-login (OAuth2) is verplicht voor iedereen; een account hangt aan het Discord-ID.
  - Admin is wie in `admin_discord_ids` staat. Bij de eerste installatie zet de installer `OWNER_DISCORD_ID` erin; daarna beheer je de lijst in /admin → Admins. De eigenaar kan zichzelf niet verwijderen. De API controleert de lijst bij elk admin-verzoek.
  - Admins moeten 2FA (TOTP) aanzetten voordat /admin opengaat.
  - Er is één noodaccount met wachtwoord (Argon2id) **én verplichte TOTP**, voor als Discord plat ligt. Inloggen daarmee komt altijd in het activiteitenlog en geeft een melding op het dashboard.
- **Rechten**: rollen admin en gebruiker. Per server een lijst van rechten voor subusers: `console.read`, `console.write`, `files.read`, `files.write`, `backup.create`, `backup.restore`, `database.manage`, `domain.manage`, `schedule.manage`, `power`. De eigenaar van een server heeft alle rechten.
- **Geheimen**: databasewachtwoorden, S3-sleutels, DNS-tokens en TOTP-secrets versleuteld opgeslagen (AES-256-GCM met een sleutel uit de omgeving, `PANEL_ENCRYPTION_KEY`).
- **Audit**: elke actie in `activity_log`, zichtbaar per server.
- **Rate limiting** op login, API en SFTP-authenticatie (via Redis).

## Tech stack en repo-structuur

| Onderdeel | Keuze | Waarom |
|---|---|---|
| Panel-frontend | Next.js (App Router), TypeScript, Tailwind, shadcn/ui | snelle UI, dark mode standaard |
| Panel-backend | Next.js + tRPC, Drizzle ORM | één codebase, type-veilig tot in de frontend |
| Auth | Discord OAuth2, eigen sessies in Postgres, otplib voor TOTP | geen externe auth-dienst nodig |
| Panel-database | PostgreSQL 16 | betrouwbaar, JSON-velden voor variabelen |
| Achtergrondtaken | Redis + BullMQ | schema's, installaties, backups in de wachtrij |
| Daemon | Go 1.23+, Docker SDK, gorilla/websocket, pkg/sftp | één binary, laag geheugen |
| Reverse proxy | Caddy 2 (met `caddy-dns/cloudflare`) via admin-API | automatische SSL, routes zonder herstart |
| Console in browser | xterm.js | volwaardige terminal met kleuren |
| Code-editor | Monaco | syntax highlighting voor configs |
| Databases | MariaDB 11 | compatibel met Minecraft-plugins en WordPress |
| Backups | S3 (`rclone serve s3` op Unraid) | sluit aan op je bestaande opzet |

Eén monorepo (pnpm workspaces + Go module):

```
panel/
  apps/web/              Next.js panel (skelet en config: orchestrator)
    server/              tRPC-routers, auth, daemon-client, BullMQ  (panel-api)
    app/                 pagina's en componenten                    (panel-ui)
  daemon/                Go daemon                                  (daemon)
    proxy/               Caddy-koppeling                            (web-hosting)
  packages/
    api/                 contracten: openapi.yaml, trpc-contract, mocks
    db/                  Drizzle-schema en migraties
  templates/
    SCHEMA.md
    game/                                                           (templates-ops)
    web/                                                            (web-hosting)
  deploy/                docker-compose, systemd, installscript, Caddy-basisconfig (templates-ops)
  docs/
```

## Bouwvolgorde

Vijf fases (0 t/m 4), elk afgesloten met een mijlpaal die je zelf kunt testen. Pas als die slaagt, start de volgende fase. Alleen fase 0 doet de orchestrator alleen; vanaf fase 1 werken de vijf agents tegelijk, elk aan zijn eigen deel van de fase.

### Fase 0 — Contracten en skelet (orchestrator alleen)

1. Monorepo-skelet met de mappen hierboven, pnpm-workspace, Go-module, lint- en testcommando's (`make check`).
2. `apps/web/`: lege Next.js-app met Tailwind, shadcn/ui, tRPC-koppeling en een lege auth-middleware, zodat panel-api en panel-ui elk alleen hun eigen submap hoeven te vullen.
3. `packages/api/openapi.yaml`: de volledige daemon-API (servers, power, install, files, backups, stats, routes) plus het websocket-protocol.
4. `packages/api/trpc-contract.ts`: alle tRPC-procedures met zod-schema's voor input en output, gegroepeerd per router (`auth`, `servers`, `files`, `domains`, `databases`, `backups`, `schedules`, `subusers`, `account`, `admin.*`). Plus `packages/api/mock/`: een mock-implementatie met voorbeelddata, waar panel-ui tegen bouwt.
5. `packages/db/schema.ts`: het datamodel hierboven in Drizzle, met een eerste migratie.
6. `daemon/proxy/router.go`: alleen de Go-interface `Router` (`SetRoute`, `RemoveRoute`, `Sync`, `Status`) en een fake-implementatie; de daemon programmeert hiertegen, web-hosting vult hem in.
7. `templates/SCHEMA.md`: het formaat van een template, met één voorbeeld.
8. `CLAUDE.md` in de root met de regels hieronder, en per map een eigen `CLAUDE.md` met de taak van die agent per fase.

**Mijlpaal 0**: `make check` slaagt: OpenAPI valideert, het tRPC-contract en de mock typechecken, de migratie draait op een lege Postgres, de Go-module bouwt, en `pnpm dev` toont een lege pagina die data uit de mock laat zien.

### Fase 1 — Eén Minecraft-server van begin tot eind

| Agent | Doet in deze fase |
|---|---|
| daemon | Container aanmaken/installeren/starten/stoppen/verwijderen, console-websocket met token-refresh, stats, statusdetectie via ready-patroon, herstel van staat na herstart |
| panel-api | Discord-login, sessies, admin-lijst met `OWNER_DISCORD_ID`, TOTP voor admins, `servers`- en `admin.servers`-routes, daemon-client, JWT-uitgifte voor de websocket, activiteitenlog |
| panel-ui | Login, serveroverzicht, serverpagina met xterm-console, powerknoppen en live stats; admin: server aanmaken voor een gebruiker |
| web-hosting | Caddy-`Router` echt implementeren, basisconfig met panel- en daemon-subdomein en HTTPS |
| templates-ops | Paper-template, docker-compose voor panel + Postgres + Redis + Caddy, systemd-unit voor de daemon, eerste versie van het installscript |

**Mijlpaal 1**: Op de machine log je in via Discord op `https://$PANEL_DOMAIN` met geldig certificaat. Je zet 2FA aan, opent /admin en maakt een Paper-server aan voor een tweede Discord-account. Na installatie start de server; de console toont de log, `say hallo` komt in de game aan, de status springt op *online* en de stats lopen. Na `systemctl restart panel-daemon` pakt de console het weer op.

### Fase 2 — Bestanden, rechten en limieten

| Agent | Doet in deze fase |
|---|---|
| daemon | Bestands-API, SFTP-server, softe disk-limiet (met XFS-detectie als optie), CPU/RAM/PID-limieten, allocations als poorten |
| panel-api | `files`-routes (tokens naar de daemon), subusers en rechtencontrole in elke route, allocations, API-sleutels, SFTP-authenticatie-endpoint |
| panel-ui | Filemanager met Monaco, upload, subusers-scherm, account-scherm, admin: nodes, allocations, gebruikers, templates, activiteitenlog |
| web-hosting | Statische nginx-template, alvast eigen netwerk per site in de daemon-proxykoppeling |
| templates-ops | Folia-, Velocity-, Fabric-, generiek Java- en Node-templates |

**Mijlpaal 2**: Een subuser met alleen `files.read` kan bestanden bekijken maar niet opslaan; de API weigert het, ook bij een direct verzoek met curl. Je uploadt een plugin via SFTP en die laadt na een herstart. Een server met 1 GB disk-limiet die je volschrijft, krijgt binnen een minuut een waarschuwing en wordt gestopt; uploaden via SFTP wordt daarna geweigerd. Na het verhogen van de limiet start hij weer. Een Velocity-proxy verbindt met twee Paper-servers.

### Fase 3 — Websites, domeinen en databases

| Agent | Doet in deze fase |
|---|---|
| daemon | Netwerkkoppeling per site, MariaDB-netwerk, statusrapportage SSL |
| panel-api | `domains`-routes met DNS-check en providerherkenning, Cloudflare-koppeling, `databases`- en `admin.databaseHosts`-routes |
| panel-ui | Domeinscherm met records, kopieerknoppen, live status en uitleg per provider; databasescherm; PHP-versie kiezen |
| web-hosting | nginx + PHP-FPM 8.2/8.3/8.4 en Node.js-templates, redirects, wildcard via DNS-challenge, SSL-status naar de daemon |
| templates-ops | MariaDB in de deploy, Adminer als site-template, Caddy-build met Cloudflare-module |

**Mijlpaal 3**: WordPress op PHP 8.3 met een eigen MariaDB-database draait op een testdomein met geldig certificaat. Het domeinscherm laat eerst *ontbreekt* zien, dan *ok* nadat je het record zet, en waarschuwt bij een oranje wolk. Via de Cloudflare-koppeling zet één klik de records voor een tweede domein. Vanuit de WordPress-container is de Minecraft-container niet bereikbaar.

### Fase 4 — Backups, schema's en afronding

| Agent | Doet in deze fase |
|---|---|
| daemon | Backups naar S3 met checksum en database-dumps, veilig herstel |
| panel-api | `backups`- en `schedules`-routes, BullMQ-taken, S3-doelen, settings, rate limiting, noodaccount |
| panel-ui | Backups- en schema-schermen, admin: S3-doelen, instellingen (naam, logo, kleur), dashboard met nodes en fouten |
| web-hosting | Backup van sites inclusief database controleren, afronding van foutmeldingen in het domeinscherm |
| templates-ops | Installscript af: één commando, idempotent, met `deploy/uninstall.sh` dat alles van het panel weghaalt; documentatie in `docs/` |

**Mijlpaal 4**: `uninstall.sh` haalt alles weg (containers, `/var/lib/panel`, `/etc/panel`, systemd-unit), waarna één commando panel + node opnieuw installeert. Een tweede keer het installscript draaien verandert niets. Een dagelijkse backup om 04:00 komt op de Unraid-server terecht. Herstel van de WordPress-site zet zowel bestanden als database terug; een afgebroken herstel (netwerk eruit) laat de oude data heel. De dagelijkse SMP-herstart draait via een schema. Het noodaccount werkt met wachtwoord en TOTP terwijl Discord-login uitstaat.

## Bouwen met Claude: meerdere agents tegelijk

Je start één Claude Code-sessie als orchestrator; die laat vijf subagents tegelijk werken, elk in een eigen git worktree en een eigen map van de monorepo. Dat kan alleen omdat de onderdelen via vaste contracten praten: eerst worden die contracten vastgelegd (fase 0), daarna bouwt iedereen parallel.

| Agent | Map | Bouwt | Klaar als |
|---|---|---|---|
| daemon | `daemon/` (behalve `daemon/proxy/`) | Docker, console-websocket, stats, files, SFTP, backups | alle OpenAPI-endpoints van de fase groen in de integratietest |
| panel-api | `apps/web/server/` | tRPC-routes, auth + 2FA, rechten, daemon-client, BullMQ-taken | elke route heeft een test, rechten afgedwongen |
| panel-ui | `apps/web/app/` | alle schermen, xterm-console, Monaco-filemanager, dark mode | werkt tegen de mock uit `packages/api/mock/` |
| web-hosting | `daemon/proxy/` + `templates/web/` | Caddy-koppeling, domeinen + SSL-status, nginx/PHP/Node-templates | site bereikbaar op testdomein met geldig certificaat |
| templates-ops | `templates/game/` + `deploy/` | game-templates, docker-compose, systemd, installscript | mijlpaal van de fase haalbaar met hun deploy |

### Regels in de root-CLAUDE.md

- Een agent wijzigt alleen bestanden in zijn eigen map.
- De contracten in `packages/`, de interface in `daemon/proxy/router.go` en het skelet van `apps/web/` wijzigt alleen de orchestrator. Heeft een agent een wijziging nodig, dan meldt hij dat en wacht.
- Elke agent schrijft tests en draait ze voordat hij zegt dat hij klaar is.
- Kleine commits op de eigen branch `agent/<naam>`; de orchestrator merget na review.

### Startprompt voor de orchestrator

Fase 0:

```
Lees docs/ontwerp.md. Voer fase 0 uit (contracten en skelet) en stop
als mijlpaal 0 gehaald is. Start nog geen subagents. Meld wat er staat
en welke keuzes je in de contracten hebt gemaakt.
```

Fase 1 t/m 4 (vervang N):

```
Lees docs/ontwerp.md en CLAUDE.md. Start vijf subagents tegelijk
(daemon, panel-api, panel-ui, web-hosting, templates-ops), elk in een
eigen git worktree op branch agent/<naam>, met hun taak voor fase N
uit hun CLAUDE.md.
Werk zelf als reviewer: beantwoord contractvragen, merge branches die
groen zijn, en draai na elke merge de integratietest.
Stop pas als mijlpaal N gehaald is en meld wat er staat.
```

Na elke fase start je de orchestrator opnieuw met de volgende fase; zo blijft elke sessie overzichtelijk.

## Werken op één machine

Er is geen aparte test-VM, dus bouwen, testen en productie gebeuren op dezelfde machine. Om dat veilig te houden:

- **Alles van het panel staat op vaste plekken:** `/etc/panel`, `/var/lib/panel`, de systemd-unit `panel-daemon` en Docker-objecten met het label `panel.managed=true`. De daemon raakt nooit containers, netwerken of volumes zonder dat label aan; `uninstall.sh` ruimt alleen die op.
- **Agents draaien hun tests zonder de echte machine te raken:** unit-tests met fakes, integratietests tegen een eigen Docker-netwerk met containers die het label `panel.test=true` krijgen en na afloop worden opgeruimd, en Caddy-tests op een aparte admin-poort met de staging-omgeving van Let's Encrypt.
- **Alleen de orchestrator draait de mijlpaaltest op de echte installatie,** na het mergen.
- De poorten zijn via env instelbaar (`SFTP_PORT`, `DAEMON_PORT`), zodat ze niet botsen met wat er al draait.

## Besluiten

- Panelnaam is instelbaar in de admin-instellingen.
- Claude Code bouwt het, met de agent-opzet hierboven.
- Eén machine voor panel en node.
- Discord-login is verplicht. Admin-toegang bepaalt de eigenaar via de tabel `admin_discord_ids`; er is geen aparte `is_admin`-vlag.
- Geen migratie vanuit Pelican of aaPanel; geen IPv6.
- DNS-provider: Cloudflare.
- Domeinen en installatiekeuzes komen uit `/etc/panel/panel.env`, niet uit code of database.
- Disk-limieten: softe limiet als standaard; XFS project quota alleen als de daemon het detecteert. `/var/lib/panel` krijgt geen eigen partitie.
- Er is geen aparte test-VM: alles wordt gebouwd en getest op de doelmachine zelf (zie Werken op één machine).
- De daemon staat achter Caddy op een eigen subdomein; alleen SFTP is direct bereikbaar.
- De daemon is de bron van waarheid voor Caddy-routes en synchroniseert ze periodiek.
- Herstel pakt eerst uit naar een tijdelijke map; oude data gaat pas weg als dat gelukt is.
- Het noodaccount heeft naast een wachtwoord ook verplichte TOTP.

## Open vragen

- Draaien Pelican (Wings) en/of aaPanel nog op deze machine? Die gebruiken dezelfde poorten (80, 443, 2022, 8080) en dezelfde Docker. Zo ja, dan moeten we kiezen: eerst uitzetten, of het panel tijdens de bouw op andere poorten laten draaien.
