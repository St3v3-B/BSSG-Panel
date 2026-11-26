# deploy/

Installatie van het panel op één machine (panel + node). Eigenaar: templates-ops,
behalve `caddy/` (web-hosting).

| Bestand | Wat |
|---|---|
| `install.sh` | installeert alles vanuit deze checkout (zie hieronder) |
| `docker-compose.yml` | `panel` (Next.js), `postgres:16`, `redis:7`, `caddy:2` |
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
   staan; `PANEL_ENCRYPTION_KEY`, `NODE_TOKEN` en `POSTGRES_PASSWORD` (+ `DATABASE_URL`)
   worden alleen gegenereerd als ze er nog niet zijn. Onbekende sleutels blijven behouden.
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
panel ─► postgres:5432, redis:6379                     (netwerk panel-backend, internal)
daemon (host) ─► Caddy admin 127.0.0.1:2019, Docker, PANEL_URL (standaard https://$PANEL_DOMAIN)
```

- Gepubliceerd: Caddy `80`, `443` (tcp+udp), `127.0.0.1:2019`; panel `127.0.0.1:3000`.
  Postgres en Redis niet.
- Alle containers, netwerken en volumes hebben `panel.managed=true`, `panel.instance=main` en
  `panel.role=infra`. Namen staan vast (`panel-web`, `panel-postgres`, `panel-redis`,
  `panel-caddy`, `panel-frontend`, `panel-backend`, `panel-*-data`), zodat `CADDY_CONTAINER`
  klopt en `uninstall.sh` (fase 4) ze vindt.
- `/run/panel` komt van systemd (`RuntimeDirectory=panel`) met `RuntimeDirectoryPreserve=yes`:
  anders wist systemd de map bij een herstart van de daemon en wijst de bind mount in Caddy
  naar een verwijderde map (socket onvindbaar tot Caddy herstart). Start Caddy eerder dan de
  daemon, dan maakt Docker de map aan; systemd neemt hem daarna over.
- Herstart van de unit: `KillMode=process` stopt alleen de daemon; containers zijn van
  dockerd, en de daemon stopt ze nooit zelf bij afsluiten.
- Lukt `https://$PANEL_DOMAIN` vanaf de host niet (DNS nog niet gezet, geen hairpin-NAT),
  zet dan `PANEL_URL=http://127.0.0.1:3000` in `panel.env`.

## Aannames over `caddy/` (web-hosting)

`caddy/Caddyfile` wordt gemount op `/etc/caddy/Caddyfile` en met het standaardcommando van de
`caddy:2`-image gestart. De compose-file geeft hem `PANEL_DOMAIN`, `NODE_DOMAIN` en
`ACME_EMAIL` als env (niet het hele panel.env), volumes op `/data` en `/config`, de admin-API
op `0.0.0.0:2019` in de container, en verwacht `panel:3000` en
`unix//run/panel/daemon.sock` als upstreams. Heeft de Caddyfile meer nodig (bv. een
ACME-CA-override voor staging), dan voegt de orchestrator dat bij het mergen toe aan
`services.caddy.environment`.

## Testen

```
deploy/test.sh              # shellcheck, compose config, unit, install.sh --dry-run, Paper-rooktest
SKIP_PAPER=1 deploy/test.sh # zonder Paper
```

De Paper-rooktest draait het install-script van `templates/game/paper.yaml` in een container
en start de server zoals de daemon dat doet (uid 1000, read-only rootfs, tmpfs `/tmp`, caps
eruit, 1280 MB → 1 GB heap) tot `ready_pattern`, controleert de poort, stuurt `stop` en ruimt
op. Alles met `panel.test=true` + `panel.instance=templates-ops-<pid>`.
