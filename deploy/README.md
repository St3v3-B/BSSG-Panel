# deploy/

Installatie van het panel op één machine (panel + node). Eigenaar: templates-ops,
behalve `caddy/` (web-hosting).

| Bestand | Wat |
|---|---|
| `install.sh` | installeert alles vanuit deze checkout (zie hieronder) |
| `docker-compose.yml` | `panel` (Next.js), `postgres:16`, `redis:7`, `mariadb:11` (klantdatabases), `caddy:2` |
| `panel.Dockerfile` | image van het panel: monorepo bouwen, Next standalone, draait als uid 1000 |
| `systemd/panel-daemon.service` | de Go-daemon op de host |
| `panel.env.example` | alle variabelen (contract; namen wijzigt alleen de orchestrator) |
| `caddy/` | Caddyfile en uitleg (web-hosting) |
| `test.sh` | tests, raken de echte installatie niet |

## Installeren

```
git clone <repo> /opt/panel && cd /opt/panel
sudo deploy/install.sh
```

Vereist: Docker met de compose-plugin, systemd, en Go 1.23+ (of `--daemon-bin PATH` met een
kant-en-klare `panel-daemon`). Het script

1. vraagt de verplichte waarden (domeinen, ACME-e-mail, Discord-ID van de eigenaar, Discord
   OAuth2-app) en schrijft `/etc/panel/panel.env` (chmod 600). Bestaande waarden blijven
   staan; `PANEL_ENCRYPTION_KEY`, `NODE_TOKEN`, `POSTGRES_PASSWORD` (+ `DATABASE_URL`) en
   `MARIADB_ROOT_PASSWORD` worden alleen gegenereerd als ze er nog niet zijn. Onbekende sleutels blijven behouden.
2. bouwt de daemon naar `/usr/local/bin/panel-daemon`,
3. installeert de unit, `systemctl enable` + `restart panel-daemon`,
4. `docker compose up -d --build`.

Opnieuw draaien is veilig (zelfde waarden, herstart van de daemon laat game-servers draaien).

Zonder vragen:

```
sudo PANEL_DOMAIN=panel.example.nl NODE_DOMAIN=node1.example.nl ACME_EMAIL=... \
     OWNER_DISCORD_ID=... DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... \
     deploy/install.sh --non-interactive
```

Een gezette omgevingsvariabele wint van de waarde in een bestaand `panel.env`; dat geldt voor
alle namen uit `panel.env.example` (let op variabelen als `DATABASE_URL` in je shell).

Proefdraaien zonder iets te wijzigen: `deploy/install.sh --dry-run [--root DIR]` schrijft
env, unit en binary onder `DIR` (standaard een tijdelijke map), valideert compose met dat
env-bestand en print de `systemctl`/`docker compose up`-commando's alleen.

## Beheer

```
cd /opt/panel
docker compose --env-file /etc/panel/panel.env -f deploy/docker-compose.yml ps|logs|up -d
systemctl status panel-daemon; journalctl -u panel-daemon -f
```

`--env-file` is nodig voor de `${...}` in de compose-file (domeinen voor Caddy en
`extra_hosts`, Postgres-wachtwoord). Het panel zelf leest het bestand via `env_file`
(`PANEL_ENV_FILE`, standaard `/etc/panel/panel.env`; alleen tests zetten hem anders).

Ander domein: env aanpassen, `systemctl restart panel-daemon`, compose `up -d`, en de
redirect-URI in het Discord-portaal bijwerken.

## Hoe de stukken elkaar bereiken

```
internet ─► caddy :80/:443 ─► panel:3000              (netwerk panel-frontend)
                          └─► unix//run/panel/daemon.sock (bind mount van de host)
panel ─► DAEMON_URL = https://$NODE_DOMAIN ─► extra_hosts → host-gateway ─► caddy :443 ─► daemon
panel ─► postgres:5432, redis:6379, mariadb:3306       (netwerk panel-backend, internal)
site-container ─► mariadb:3306                         (netwerk panel-db, internal; de daemon koppelt sites met een database)
daemon (host) ─► Caddy admin unix:///run/panel/caddy-admin.sock, Docker, PANEL_URL (install.sh: http://127.0.0.1:3000)
```

- Gepubliceerd: Caddy `80`, `443` (tcp+udp); panel `127.0.0.1:3000`. Niet: de Caddy-admin
  (unix-socket in `/run/panel`), Postgres, Redis en MariaDB.
- Alle containers, netwerken en volumes hebben `panel.managed=true`, `panel.instance=main` en
  `panel.role=infra`. Namen staan vast (`panel-web`, `panel-postgres`, `panel-redis`,
  `panel-mariadb`, `panel-caddy`, `panel-frontend`, `panel-backend`, `panel-db`, `panel-*-data`), zodat `CADDY_CONTAINER`
  klopt en `uninstall.sh` (fase 4) ze vindt.
- `/run/panel` komt van systemd (`RuntimeDirectory=panel`) met `RuntimeDirectoryPreserve=yes`:
  anders wist systemd de map bij een herstart van de daemon en wijst de bind mount in Caddy
  naar een verwijderde map (socket onvindbaar tot Caddy herstart). Start Caddy eerder dan de
  daemon, dan maakt Docker de map aan; systemd neemt hem daarna over.
- Herstart van de unit: `KillMode=process` stopt alleen de daemon; containers zijn van
  dockerd, en de daemon stopt ze nooit zelf bij afsluiten.
- `install.sh` zet `PANEL_URL=http://127.0.0.1:3000` (als hij nog niet gezet is), zodat de
  daemon het panel zonder externe DNS of hairpin-NAT bereikt. `CADDY_ADMIN_URL` en
  `CADDY_TLS_ADDR` krijgen de waarden uit het voorbeeld als ze ontbreken of leeg zijn.

## MariaDB

- `panel-mariadb` (`mariadb:11`), als uid 999 met read-only rootfs, geen capabilities,
  `utf8mb4`, `--skip-name-resolve`, data in volume `panel-mariadb-data`.
- Beheer als `root` met `MARIADB_ROOT_PASSWORD` uit `panel.env` (door `install.sh`
  gegenereerd; geldt alleen bij een lege volume). Het panel bereikt hem als `mariadb:3306`
  via `panel-backend`; de daemon (host) heeft geen gepubliceerde poort en gebruikt een
  container op `panel-db` (bv. `mariadb-dump` voor backups).
- `panel-db` is `internal`: sites met een database worden er door de daemon aan gekoppeld en
  zien daar alleen MariaDB (host `mariadb` of `panel-mariadb`, poort 3306). Let op: sites op
  dit netwerk kunnen elkaar ook bereiken; isolatie tussen sites zit in de MariaDB-rechten
  (eigen gebruiker per database).

## Aannames over `caddy/` (web-hosting)

`caddy/Caddyfile` op `/etc/caddy/Caddyfile` en `caddy/global.d/` op `/etc/caddy/global.d`
(beide read-only; `global.d` is in productie leeg), standaardcommando van `caddy:2` zonder
`--resume`, volumes op `/data` en `/config`, `/run/panel` als map (daemon-socket én
admin-socket `caddy-admin.sock`). Caddy krijgt alleen `PANEL_DOMAIN`, `NODE_DOMAIN` en
`ACME_EMAIL` als env (niet het hele panel.env, dus geen geheimen). Upstreams: `panel:3000` en
`unix//run/panel/daemon.sock`. `deploy/test.sh` draait `caddy validate` met precies deze env en
mounts.

## Testen

```
deploy/test.sh              # shellcheck, compose config, unit, install.sh --dry-run, Paper-rooktest
SKIP_PAPER=1 deploy/test.sh # zonder Paper
```

De Paper-rooktest draait het install-script van `templates/game/paper.yaml` in een container
en start de server zoals de daemon dat doet (uid 1000, read-only rootfs, tmpfs `/tmp`, caps
eruit, 1280 MB → 1 GB heap) tot `ready_pattern`, controleert de poort, stuurt `stop` en ruimt
op. Alles met `panel.test=true` + `panel.instance=templates-ops-<pid>`.

## Velocity met twee Paper-servers

Een Velocity-proxy waarop spelers binnenkomen, met twee Paper-servers erachter (bv. `lobby`
en `survival`). Modern forwarding: Velocity geeft naam, UUID en IP van de speler door,
ondertekend met een gedeelde secret; zonder die secret kan niemand rechtstreeks inloggen op de
Paper-servers.

1. **Secret kiezen**: 12-128 tekens `A-Z a-z 0-9 _ -`, bv. `openssl rand -hex 24`.
2. **Velocity-server** maken (template *Velocity*, 512 MB is genoeg). Variabele
   `VELOCITY_FORWARDING_SECRET` = de secret. (Laat je hem leeg, dan maakt de installatie
   `forwarding.secret` aan; neem die waarde over.) Deze allocation is het adres dat
   spelers gebruiken.
3. **Twee Paper-servers** maken (template *Paper* of *Folia*), elk met een eigen allocation.
   Per server: `VELOCITY_FORWARDING` = `true` en `VELOCITY_SECRET` = dezelfde secret.
   Het panel zet dan `config/paper-global.yml` (`proxies.velocity.enabled/secret/online-mode`)
   en `online-mode=false` in `server.properties` (de proxy controleert de accounts). Gebruik
   op beide een Minecraft-versie die Velocity ondersteunt (de nieuwste is altijd goed).
4. **Serverlijst**: open in de filemanager van de Velocity-server `velocity.toml` en zet
   onder `[servers]` de allocations van de Paper-servers (IP:poort zoals het panel ze toont):

   ```toml
   [servers]
   lobby = "203.0.113.10:25566"
   survival = "203.0.113.10:25567"
   try = ["lobby"]
   ```

   `bind`, `player-info-forwarding-mode = "modern"`, `forwarding-secret-file` en
   `online-mode` zet het panel bij elke start; de rest van het bestand is van jou.
5. Start de twee Paper-servers en daarna Velocity. Spelers verbinden met het adres van de
   Velocity-server, komen op `lobby` en wisselen met `/server survival`.

Tips: zet de Paper-servers alleen open voor de proxy door ze geen publiek bekende poort te
geven, of vertrouw op de secret (Paper weigert iedereen zonder die secret). Problemen staan
in de console: *"Backend server is online-mode"* in Velocity = `VELOCITY_FORWARDING` staat
niet aan op die Paper-server; *"Unable to verify player details"* in Paper = de secret
verschilt.

`deploy/test.sh` doet precies dit (stap *Velocity met twee Paper-servers*), met een
mineflayer-bot die via de proxy op server a inlogt en met `/server b` wisselt.
