# deploy/

Installation of the panel on a single machine (panel + node). Owner: templates-ops,
except `caddy/` (web-hosting).

| File | What |
|---|---|
| `install.sh` | installs everything from this checkout (see below) |
| `docker-compose.yml` | `panel` (Next.js), `postgres:16`, `redis:7`, `mariadb:11` (customer databases), `caddy:2` |
| `panel.Dockerfile` | panel image: builds the monorepo, Next standalone, runs as uid 1000 |
| `systemd/panel-daemon.service` | the Go daemon on the host |
| `panel.env.example` | all variables (contract; only the orchestrator changes names) |
| `caddy/` | Caddyfile and documentation (web-hosting) |
| `uninstall.sh` | removes a panel or node installation (labelled Docker objects, unit, optionally data) |
| `test.sh` | tests, do not touch the real installation |
| `test-upgrade.sh`, `test-uninstall.sh` | sandbox tests for `upgrade.sh` and `uninstall.sh` (part of `make check`) |

## Installing

```
git clone <repo> /opt/panel && cd /opt/panel
sudo deploy/install.sh
```

Requires: Docker with the compose plugin, systemd, and Go 1.26+ (or `--daemon-bin PATH` with a
prebuilt `panel-daemon`). The script

1. asks for the required values (domains, ACME email, Discord ID of the owner, Discord
   OAuth2 app) and writes `/etc/panel/panel.env` (chmod 600). Existing values are
   kept; `PANEL_ENCRYPTION_KEY`, `NODE_TOKEN`, `POSTGRES_PASSWORD` (+ `DATABASE_URL`) and
   `MARIADB_ROOT_PASSWORD` are only generated if they do not exist yet. Unknown keys are preserved.
2. builds the daemon to `/usr/local/bin/panel-daemon`,
3. installs the unit, `systemctl enable` + `restart panel-daemon`,
4. `docker compose up -d --build`.

Running it again is safe (same values; restarting the daemon leaves game servers running).

Without prompts:

```
sudo PANEL_DOMAIN=panel.example.com NODE_DOMAIN=node1.example.com ACME_EMAIL=... \
     OWNER_DISCORD_ID=... DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... \
     deploy/install.sh --non-interactive
```

A set environment variable wins over the value in an existing `panel.env`; this applies to
all names in `panel.env.example` (beware of variables such as `DATABASE_URL` in your shell).

Dry run without changing anything: `deploy/install.sh --dry-run [--root DIR]` writes
env, unit and binary under `DIR` (default a temporary directory), validates compose with that
env file and only prints the `systemctl`/`docker compose up` commands.

## Management

```
cd /opt/panel
docker compose --env-file /etc/panel/panel.env -f deploy/docker-compose.yml ps|logs|up -d
systemctl status panel-daemon; journalctl -u panel-daemon -f
```

`--env-file` is needed for the `${...}` in the compose file (domains for Caddy and
`extra_hosts`, Postgres password). The panel itself reads the file via `env_file`
(`PANEL_ENV_FILE`, default `/etc/panel/panel.env`; only tests set it differently).

Different domain: edit the env, `systemctl restart panel-daemon`, compose `up -d`, and update the
redirect URI in the Discord portal.

Uninstall:

```
sudo deploy/uninstall.sh --dry-run          # show what would be removed
sudo deploy/uninstall.sh --backup           # dump Postgres + MariaDB first, then remove (asks for the domain)
sudo deploy/uninstall.sh --purge --yes      # also delete volumes, /etc/panel and DATA_DIR
```

It only removes Docker objects with both `panel.managed=true` and `panel.instance=$PANEL_INSTANCE`.
Without `--purge` the volumes, `/etc/panel` and the data directory stay, so `install.sh` can pick them up again.
`PANEL_ROOT` and `ENV_FILE` redirect all file paths (used by `deploy/test-uninstall.sh`).

## How the pieces reach each other

```
internet ─► caddy :80/:443 ─► panel:3000              (network panel-frontend)
                          └─► unix//run/panel/daemon.sock (bind mount from the host)
panel ─► DAEMON_URL = https://$NODE_DOMAIN ─► extra_hosts → host-gateway ─► caddy :443 ─► daemon
panel ─► postgres:5432, redis:6379, mariadb:3306       (network panel-backend, internal)
site container ─► mariadb:3306                         (network panel-db, internal; the daemon attaches sites that have a database)
daemon (host) ─► Caddy admin unix:///run/panel/caddy-admin.sock, Docker, PANEL_URL (install.sh: http://127.0.0.1:3000)
```

- Published: Caddy `80`, `443` (tcp+udp); panel `127.0.0.1:3000`. Not published: the Caddy admin
  (unix socket in `/run/panel`), Postgres, Redis and MariaDB.
- All containers, networks and volumes have `panel.managed=true`, `panel.instance=main` and
  `panel.role=infra`. Names are fixed (`panel-web`, `panel-postgres`, `panel-redis`,
  `panel-mariadb`, `panel-caddy`, `panel-frontend`, `panel-backend`, `panel-db`, `panel-*-data`), so that `CADDY_CONTAINER`
  is correct and `uninstall.sh` (phase 4) finds them.
- `/run/panel` comes from systemd (`RuntimeDirectory=panel`) with `RuntimeDirectoryPreserve=yes`:
  otherwise systemd wipes the directory when the daemon restarts and the bind mount in Caddy
  points at a deleted directory (socket not found until Caddy restarts). Start Caddy before the
  daemon, then Docker creates the directory; systemd takes it over afterwards.
- Restarting the unit: `KillMode=process` only stops the daemon; containers belong to
  dockerd, and the daemon never stops them itself on shutdown.
- `install.sh` sets `PANEL_URL=http://127.0.0.1:3000` (if not set yet), so that the
  daemon reaches the panel without external DNS or hairpin NAT. `CADDY_ADMIN_URL` and
  `CADDY_TLS_ADDR` get the values from the example if they are missing or empty.

## MariaDB

- `panel-mariadb` (`mariadb:11`), as uid 999 with read-only rootfs, no capabilities,
  `utf8mb4`, `--skip-name-resolve`, data in volume `panel-mariadb-data`.
- Manage as `root` with `MARIADB_ROOT_PASSWORD` from `panel.env` (generated by `install.sh`;
  only applies to an empty volume). The panel reaches it as `mariadb:3306`
  via `panel-backend`; the daemon (host) has no published port and uses a
  container on `panel-db` (e.g. `mariadb-dump` for backups).
- `panel-db` is `internal`: sites with a database are attached to it by the daemon and
  only see MariaDB there (host `mariadb` or `panel-mariadb`, port 3306). Note: sites on
  this network can also reach each other; isolation between sites relies on the MariaDB privileges
  (a separate user per database).

## Mail (compose profile `mail`)

- Off by default. Postfix, Dovecot, Rspamd, ClamAV, Unbound and a separate Redis (`panel-postfix`, `panel-dovecot`,
  `panel-rspamd`, `panel-clamav`, `panel-unbound`, `panel-mail-redis`), label `panel.role=mail`, config in
  `mail/` (read-only mounts), data in named volumes (`panel-vmail`, `panel-postfix-spool`, `panel-mail-dkim`, ...).
- The switch is `COMPOSE_PROFILES` in `panel.env` (`mail` = on). `mail.sh enable|disable|reload|status` keeps it
  in sync and starts/stops only the mail containers; `install.sh`/`upgrade.sh` include the profile only when it is
  listed there and `MAIL_HOSTNAME` is set.
- Caddy gets a site for `MAIL_HOSTNAME` (`caddy/mail/on-site.caddy`, imported only when compose sets
  `MAIL_CADDY=on`); Postfix/Dovecot read the certificate from `caddy_data` (read-only).
- `test/mail-stack.sh`: end-to-end test with its own labels and random ports. Admin documentation:
  [docs/mail.md](../docs/mail.md).

## phpMyAdmin

The sidebar item "phpMyAdmin" opens `https://$PANEL_DOMAIN/phpmyadmin/`, signed in without a password.

- **Container** `panel-phpmyadmin` (image built from `deploy/phpmyadmin/`: official `phpmyadmin:5.2.3-apache`
  plus our config, `signon.php` and the theme `bssg`). No published ports; it sits on `panel-backend` (to reach
  `panel:3000` and MariaDB) and on `panel-pma`, an internal network shared only with Caddy. Caddy proxies
  `/phpmyadmin/*` (prefix stripped) to `phpmyadmin:80`.
- **Single sign-on**: the panel (`databases.phpMyAdminUrl`) mints a one-time token (Redis, 60 s). `signon.php`
  exchanges it server-to-server at `POST http://panel:3000/api/pma/exchange` (`Authorization: Bearer
  $PMA_SHARED_SECRET`) for `{user, password}` of the MariaDB account `pma_u<userId>`. On every exchange the panel
  (through the daemon: `PUT /api/db/pma-users/{user}`) gives that account a new password and `ALL PRIVILEGES` on
  exactly the databases the user may manage (own servers, servers where they are subuser with `database.manage`;
  full admins: all customer databases). Never `GRANT OPTION`, never `mysql`/`sys`/`performance_schema`.
- **Variables** (`panel.env`, generated by `install.sh`, also on upgrades): `PMA_SHARED_SECRET`,
  `PMA_BLOWFISH_SECRET`. Without `PMA_SHARED_SECRET` in the panel the item is hidden and the endpoint answers 404.
- **Multi-node**: phpMyAdmin only sees the MariaDB of the panel machine (the local node). Databases on other
  nodes are not available; the UI says so.
- Screenshots: `docs/assets/phpmyadmin.png`.

## Assumptions about `caddy/` (web-hosting)

`caddy/Caddyfile` at `/etc/caddy/Caddyfile` and `caddy/global.d/` at `/etc/caddy/global.d`
(both read-only; `global.d` is empty in production), default command of `caddy:2` without
`--resume`, volumes at `/data` and `/config`, `/run/panel` as a directory (daemon socket and
admin socket `caddy-admin.sock`). Caddy only gets `PANEL_DOMAIN`, `NODE_DOMAIN` and
`ACME_EMAIL` as env (not the whole panel.env, so no secrets). Upstreams: `panel:3000` and
`unix//run/panel/daemon.sock`. `deploy/test.sh` runs `caddy validate` with exactly this env and
mounts.

## Testing

```
deploy/test.sh              # shellcheck, compose config, unit, install.sh --dry-run, Paper smoke test
SKIP_PAPER=1 deploy/test.sh # without Paper
```

The Paper smoke test runs the install script of `templates/game/paper.yaml` in a container
and starts the server the way the daemon does (uid 1000, read-only rootfs, tmpfs `/tmp`, caps
dropped, 1280 MB → 1 GB heap) until `ready_pattern`, checks the port, sends `stop` and cleans
up. Everything with `panel.test=true` + `panel.instance=templates-ops-<pid>`.

## Velocity with two Paper servers

A Velocity proxy that players connect to, with two Paper servers behind it (e.g. `lobby`
and `survival`). Modern forwarding: Velocity passes the player's name, UUID and IP on,
signed with a shared secret; without that secret nobody can log in directly on the
Paper servers.

1. **Pick a secret**: 12-128 characters `A-Z a-z 0-9 _ -`, e.g. `openssl rand -hex 24`.
2. **Create the Velocity server** (template *Velocity*, 512 MB is enough). Variable
   `VELOCITY_FORWARDING_SECRET` = the secret. (If you leave it empty, the installer creates
   `forwarding.secret`; copy that value.) This allocation is the address
   players use.
3. **Create two Paper servers** (template *Paper* or *Folia*), each with its own allocation.
   For each server: `VELOCITY_FORWARDING` = `true` and `VELOCITY_SECRET` = the same secret.
   The panel then sets `config/paper-global.yml` (`proxies.velocity.enabled/secret/online-mode`)
   and `online-mode=false` in `server.properties` (the proxy checks the accounts). Use
   a Minecraft version on both that Velocity supports (the newest is always fine).
4. **Server list**: in the file manager of the Velocity server open `velocity.toml` and under
   `[servers]` add the allocations of the Paper servers (IP:port as the panel shows them):

   ```toml
   [servers]
   lobby = "203.0.113.10:25566"
   survival = "203.0.113.10:25567"
   try = ["lobby"]
   ```

   `bind`, `player-info-forwarding-mode = "modern"`, `forwarding-secret-file` and
   `online-mode` are set by the panel on every start; the rest of the file is yours.
5. Start the two Paper servers and then Velocity. Players connect to the address of the
   Velocity server, land on `lobby` and switch with `/server survival`.

Connecting directly to a Paper server does not work: Paper rejects everyone who does not come through
the proxy with the right secret. So keep the secret private. Problems show up in the console: *"Backend server is online-mode"* in Velocity = `VELOCITY_FORWARDING` is not
enabled on that Paper server; *"Unable to verify player details"* in Paper = the secret
differs.

`deploy/test.sh` does exactly this (step *Velocity with two Paper servers*), with a
mineflayer bot that logs in on server a via the proxy and switches with `/server b`.

## Node toevoegen met één regel (join)

Admin > Nodes > Add node toont `curl -fsSL https://<PANEL_DOMAIN>/join | sudo bash -s -- <code>`.

- De code is willekeurig (192 bit), een uur geldig, eenmalig en staat alleen als SHA-256 in de database. Het
  node-token zit niet in het commando: het script ruilt de code via `POST /api/join/exchange` in voor token en
  configuratie (panel-URL, node-domein, ACME-mail, poorten, `supports_domains`, `public_port`).
- `GET /join` is `deploy/join/join.sh` (geen geheimen; alleen de panel-URL wordt ingevuld). Het script: controleert
  OS/arch (amd64/arm64), vraagt (of `--yes`) om Docker te installeren (get.docker.com), wacht tot het node-domein naar
  het gemelde IPv4 wijst (Cloudflare-zone gekoppeld: het panel maakt het A-record zelf; anders toont het panel het exacte
  record), downloadt de daemon van `/join/daemon/<arch>` en controleert `.sha256`, haalt `/join/files.tar.gz`
  (compose, Caddy-build, systemd-unit), schrijft `/etc/panel/panel.env`, start MariaDB (+ Caddy) en de daemon, opent
  ufw-poorten na bevestiging en meldt voortgang via `/api/join/progress` (node-token). Het panel-image bouwt de
  daemon (amd64+arm64) en het bestandspakket uit dezelfde commit (`panel.Dockerfile`).
- `--dry-run [--root DIR]` schrijft alleen naar DIR en print systeemcommando's; `--uninstall [--purge]` verwijdert de node
  (weigert op een machine met `panel-web` of zonder env-bestand van het join-script).
- "Update daemon" (node-pagina) roept `POST /api/update` op de node aan (node-token): de daemon haalt de binary van het
  panel, controleert de sha256 en herstart via systemd.

### Domeinondersteuning per node

- **Aan** (standaard): Caddy op 80/443 (compose-profiel `caddy`), node-domein op 443; websites en domeinen voor
  gameservers mogelijk.
- **Uit**: geen Caddy en niets op 80/443. De daemon luistert zelf met TLS op `DAEMON_TLS_PORT` (= `public_port`,
  standaard 8443) en haalt een Let's Encrypt-certificaat met DNS-01 (`ACME_DIRECTORY` voor staging). De TXT-records
  `_acme-challenge.<node-domein>` zet het **panel** (`POST /api/remote/acme/dns`, alleen voor het eigen node-domein) via
  de gekoppelde Cloudflare-zone, dus het Cloudflare-token verlaat het panel nooit. Een zone die het node-domein dekt is
  daarom vereist. Het panel bouwt console-, upload- en daemon-URL's met die poort. Websites, `domains.add`, het
  "domeinen toestaan" van gameservers, wijzigen van template en verplaatsen (transfer) naar zo'n node worden geweigerd
  (`NODE_HAS_NO_DOMAINS`). Aan -> uit kan alleen zonder websites/domeinen op de node (`NODE_HAS_DOMAINS`).
