# Admin guide

For people who install and run a panel. Users of the panel: see the [user guide](user-guide.md).
Examples use `panel.example.com`, `node1.example.com` and `node2.example.com`.

- [Installation](#installation)
- [The admin area](#the-admin-area)
- [Nodes: adding machines (join)](#nodes-adding-machines-join)
- [Templates](#templates)
- [Settings](#settings)
- [Updates and upgrades](#updates-and-upgrades)
- [Backups and S3](#backups-and-s3)
- [Network isolation](#network-isolation)
- [Emergency login](#emergency-login)
- [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)

## Installation

The short version, on a dedicated Linux machine with Docker, systemd and free ports 80, 443 and 2022:

```bash
git clone https://github.com/St3v3-B/BSSG-Panel.git
cd BSSG-Panel
sudo deploy/install.sh
```

The installer asks for the panel and node domains, an e-mail address for Let's Encrypt, your Discord user ID and the
Discord OAuth2 client ID and secret. It writes `/etc/panel/panel.env` (mode 600, all keys generated), builds and installs the
daemon with its systemd unit `panel-daemon`, and starts the Compose stack (panel, PostgreSQL, Redis, MariaDB, phpMyAdmin, Caddy).
Running it again is safe: existing values and generated secrets are kept.

Then sign in with Discord, enable 2FA under **Account**, open **Admin, Nodes**, add port ranges to the local node and create your first
server. Requirements, all options (`--non-interactive`, `--dry-run`, `--daemon-bin`) and the configuration variables are in
[installation.md](installation.md).

## The admin area

The admin area lives under `/admin`. It is only reachable for accounts that are in the admin list **and**
have two-factor authentication enabled **and** verified it in the current session. This is enforced on the
server for every admin call, not just hidden in the interface.

### Admins

The owner (`OWNER_DISCORD_ID`) is always an admin and cannot be removed. Add or remove other admins under
**Admin, Users**. There is no `is_admin` flag on user rows, so there is nothing to forget to check.

### Dashboard

Shows counts and alerts: emergency login used, node offline, failed installs, failed backups and low disk space.

### Users

- Pre-create accounts by Discord ID, so you can assign a server before the person ever logs in.
- Approve pending accounts, block users, reset their 2FA (for example when they lost phone and recovery codes), manage admins.
- Set a **quota** per user (total RAM, disk and CPU, number of servers and databases, allowed templates and nodes,
  ports per server). Users with a quota can create their own servers within it. See the usage overview under **Quotas**.

### Servers

Create servers for any user and choose node, template, limits and ports. You can change limits live, change the
owner, ports and variables, suspend a server with a reason, switch its template (optionally reinstalling),
reinstall, delete, or **transfer** it to another node (see [multi-node.md](multi-node.md)). A toggle controls whether a game
server may have domains attached.

### Activity log

Every action is logged with user, server and IP. Search by user, server or action. Old entries are removed after the
retention period in **Settings** (default 90 days, 0 keeps everything).

## Nodes: adding machines (join)

Nodes are the machines running the daemon. The panel's own machine is the local node and is registered automatically.

To add a machine:

1. Open **Admin, Nodes, Add node**. Fill in a domain for the node (for example `node2.example.com`; empty uses a suggestion) and
   choose whether the node supports domains (websites and game-server domains need Caddy on ports 80 and 443).
2. The panel shows a one-line command with a **join code**. The code is single use and valid for one hour; the node token is never
   part of the command:

   ```bash
   curl -fsSL https://panel.example.com/join | sudo bash -s -- <join-code>
   ```

3. Run it as root on the new machine. The script checks the machine (Linux, amd64 or arm64), offers to install Docker, waits until the
   node domain resolves (with a connected Cloudflare zone the panel creates the A record itself), downloads the daemon from the panel and
   checks its SHA-256, installs the systemd unit, starts MariaDB (and Caddy) and reports progress. The panel shows each step live.
4. When the node is ready, open the game ports in its firewall. Default allocations are created from the ports you entered.

Options of the join script: `--yes` (no questions), `--no-ufw`, `--ip IPV4`, `--dry-run`. The older way, a git checkout plus
`deploy/install.sh --node-only`, still works and is described in [multi-node.md](multi-node.md).

### HTTP(S) via another node (relay)

A node that cannot use ports 80 and 443 (another web server already runs there, the machine is behind NAT, or it gets no inbound
traffic at all) can send **all its HTTP(S)** through another node, the *relay node*. Choose it per node in **Admin, Nodes, <node>,
HTTP(S) entry, HTTP(S) via**, or already in the **Add node** form. Only nodes with their own ports 80/443 that do not relay
themselves can be a relay node; the local node (the panel machine) always uses its own ports.

How it works:

- The daemon of the node keeps an outgoing, encrypted tunnel (websocket over HTTPS with multiplexed streams) open to
  `https://<relay node>/api/relay/tunnel`. Both sides prove a per-pair secret that the panel hands out; the node also checks the TLS
  certificate of the relay node. It reconnects by itself with backoff.
- Caddy on the relay node serves the node domain and every web domain of the node, gets their certificates (HTTP-01 on the relay
  node because DNS points there, or a DNS challenge for wildcard domains with a connected Cloudflare provider) and sends the
  requests through the tunnel. The relay node only forwards host names the panel assigned to that node; everything else is refused.
- Everything that used Caddy on the node keeps working through the relay: websites, HTTP domains of game servers, the console
  websocket, uploads and downloads, and the panel's own calls to the daemon (the panel reaches `https://<node domain>`, which now
  resolves to the relay node).
- **Not via the relay:** game ports, Minecraft domains (A + SRV records point to the node's own IP) and SFTP. Those stay direct, so
  open them in the node's firewall. The SFTP port does not have to be 22 or 2022.
- SSL status in the panel comes from the relay node, which holds the certificates.

Changing the setting:

1. Pick the relay node and press **Apply**. The panel warns that DNS has to change: the node domain and all web domains of the node
   must point to the relay node (back to the node itself when you switch to own ports). Records in a connected Cloudflare zone or with a
   linked DNS provider are changed by the panel; the list on the card shows which ones you must change by hand and whether they
   already point to the right IP.
2. Put Caddy on the node into the matching mode. The card shows the command; run it as root on the node:

   ```bash
   curl -fsSL https://panel.example.com/join | sudo bash -s -- --http-mode relay    # or: --http-mode direct
   ```

   In relay mode Caddy publishes no ports (the `caddy-relay` compose profile); the daemon delivers the sites to it over a local socket.
   A node joined with **HTTP(S) via** set gets this mode automatically; `--no-public-http` makes the join script refuse to continue
   if the panel has no relay set for the node. For `deploy/install.sh --node-only` set `HTTP_MODE=relay`.
3. The card shows the tunnel as seen from the node (connected, latency, reconnects, last error) and from the relay node. A warning
   appears while the node still runs Caddy on its own ports.

A relay node cannot be deleted while other nodes relay through it, and a node that relays for others cannot use a relay itself.

**Allocations** are IP and port ranges per node: `25565`, `25565-25600` or `25565,25570-25575`. Game servers take one or more
allocations; websites need none. **Update daemon** on a node makes it download the daemon of the current panel version and restart.
A node with servers cannot be removed: move or delete the servers first.

### Maintenance mode and evacuating a node

Before you work on a machine, put its node in **maintenance** (**Admin, Nodes, <node>, Maintenance mode**):

- No new servers land on the node: creating a server for a user, users creating their own (quota), plans (automatic node choice)
  and moving a server *to* the node all refuse with `NODE_IN_MAINTENANCE`. Existing servers keep running.
- Owners of servers on the node see a banner on their server pages and a badge on the overview ("in maintenance from … until …",
  with your optional message). Planned start and end are information only; times are entered and shown in Europe/Amsterdam.
- With **Notify the owners** checked, every owner gets one notification (panel inbox, Discord, e-mail, depending on their own
  settings, event *Node maintenance and server moves*) listing their servers on the node. Changing the text or the planning sends a
  new one; saving without changes does not.

**Evacuate** moves servers off the node. Choose the servers (all are selected), a target per server (or *Automatic*) and how many
moves run at the same time (1 to 5). Each move is the normal transfer (**Admin, Servers, <server>, Move**): stop, copy the data and the
databases through the panel, create the server on the target, move domains and routes, start it again if it was running, and only then
remove it from the old node.

- *Automatic* is decided when that server's move starts: the node with the most free RAM (nodes with unlimited RAM first) that has
  enough free disk and free allocations, supports domains if the server is a website or has domains, is not in maintenance, is ready and
  not offline, and preferably has the same HTTP(S) mode (own ports 80/443 or the same relay). The planner shows each candidate and why
  it does not fit.
- Progress is shown per server and refreshes every two seconds. **Cancel the rest** stops queued moves; the move that is running
  finishes. A panel restart during an evacuation marks the interrupted move as failed (the server stays where it was) and continues
  with the rest.
- A failed move leaves the server on the old node, running as before. The admin who started the evacuation gets a notification (and
  the admin Discord webhook a message). Fix the cause (free ports, room on the target) and evacuate it again.
- After a move the list shows the new address of game servers and every DNS record the owner has to change: `A` records of
  websites and HTTP domains point to the HTTP(S) entry of the new node (its own IP, or that of its relay node), Minecraft domains to
  the node's own IP, and the `_minecraft._tcp` SRV record to the new port. The owner gets a notification with a link to the domains
  page of the server, which shows the same records with copy buttons and a live check. Records in a connected Cloudflare zone can be
  set from there with one click.

**End maintenance** makes the node accept new servers again and cancels queued moves. Nothing moves back automatically; move servers
back yourself if you want to.

## Templates

Templates are YAML files read from `TEMPLATES_DIR` (`/app/templates` in the panel container, from `templates/` in the repo) at every
start. The format is described in [`templates/SCHEMA.md`](../templates/SCHEMA.md) and validated by a schema, so a broken template fails CI
instead of production.

In **Admin, Templates** you can list, create, edit and validate templates in a YAML editor. Templates live in the database; at startup a
file from `TEMPLATES_DIR` is added when its slug is new and replaces the stored one only when its `version` is higher. So bump `version`
when you change a template file, and keep in mind that a newer file version overwrites edits made in the editor. A template defines the image, the startup command (with `{{VARIABLES}}`),
how to stop, the install script, config files the panel writes, user-editable variables and, for websites, the HTTP port.

## Importing from Pterodactyl or Pelican

**Admin, Import** brings users, servers and their files over from an existing Pterodactyl (1.x) or Pelican panel. The source is
**only read**: the panel sends nothing but `GET` requests to its API and only reads over SFTP. The source panel and its servers keep
running; switch them off yourself when you are done.

1. **Connect.** Enter the panel URL and an **Application API key** (Pterodactyl: *Admin, Application API*, `ptla_…`; Pelican: `peli_…`)
   with read permission on Users, Nodes, Allocations, Nests/Eggs and Servers. For files, add one or both of:
   - a **Client API key** of an admin account (*Account, API Credentials*, `ptlc_…`/`pacc_…`): the newest *completed* backup of each
     server is downloaded (`/api/client/servers/<id>/backups/<uuid>/download`). No new backup is made on the source, because that
     would change it; make fresh backups there first if you want current data.
   - an **SFTP login** on the Wings nodes: your panel username and password there. The panel logs in as `<username>.<server id>`
     on the FQDN and SFTP port of the source node (override the host and port if needed) and reads all files. API keys do not work
     for Wings SFTP.
   Without either, servers are created empty and the template's install script runs.
   The keys and the SFTP password are stored encrypted (AES-GCM with `PANEL_ENCRYPTION_KEY`) only while the import exists: they are
   wiped as soon as every server is imported, or when you press **Disconnect**.
2. **Eggs → templates.** Every egg gets a suggestion based on its name, docker image, start command and variables; a suggestion of
   50% or more is selected automatically. Pick another template or skip the egg (its servers are then not imported). **Convert** turns
   an egg into template YAML for you to review: `/mnt/server` becomes `/home/container`, bash install scripts are run with bash,
   `{{server.build.default.port}}`-style placeholders become `{{SERVER_PORT}}`, simple Laravel rules (`in:`, `integer`, `boolean`,
   `regex:`) become patterns, and the comments at the top list what could not be converted (ini/xml config files, wildcard keys,
   built-in variables). Check that the image runs as a non-root user (uid 1000). **Save as template** stores it and maps the egg.
3. **Users → accounts.** A user is linked automatically when an account here has the same Discord ID (the user's `external_id`, or
   the Discord ID of a Pelican OAuth login), e-mail address or name. Otherwise choose **Create account** with the person's Discord ID
   (like *Admin, Users, Create*: the name comes with the first Discord login; the source username is used until then and the source
   e-mail is kept as an unconfirmed address), link to another account, or skip the user (their servers are skipped too).
4. **Servers.** Choose which servers come along, the default target node and, per server, another node. Allocations: the same
   port as on the source when it is free on the target node, otherwise the first free one. Limits are taken over (unlimited RAM in
   the source becomes 1024 MB). Variables the template does not know are dropped and listed in the dry run.
5. **Dry run** shows, with the current choices, which accounts would be created and for every server the owner, template, node, ports,
   file method, dropped variables, warnings, or why it would be skipped. It creates and changes nothing (it does read the list of
   backups on the source).
6. **Start import.** First the accounts, then one server at a time: create it on the target node (without install when files come
   along), copy the files (backup → unpacked into the server; or SFTP → streamed), done. Progress and copied bytes are shown per
   server. A server that fails is removed again and marked *Failed* with the reason; fix the cause and press **Resume**: only failed
   and remaining servers run again, imported servers are never imported twice. **Stop after this server** pauses the import. Imported
   servers are not started.

One import exists at a time. Imported servers are normal servers: databases, subusers, schedules and backups of the source are not
imported.

## Settings

**Admin, Settings** has these sections:

| Section | What |
|---|---|
| General | Panel name, logo URL and accent colour; default limits for new servers; data retention of the activity log; a Discord webhook for admin-wide notifications |
| Database hosts | The local MariaDB is registered at startup (`local`, host `panel-mariadb`); add and test more hosts |
| DNS providers | Cloudflare API tokens, so the panel can create DNS records and issue wildcard certificates |
| Backup storage | S3 targets, see [Backups and S3](#backups-and-s3) |
| Image updates | Global policy `auto`, `notify` or `off` and a maintenance window; owners can override it per server. The daemon checks every `IMAGE_CHECK_INTERVAL` (default `24h`) |
| Updates | Panel updates from GitHub, see below |

Install-specific settings (domains, Discord, keys, ports) live in `/etc/panel/panel.env`, not in the database. After changing that file:
`systemctl restart panel-daemon` and bring the Compose stack up again. Reference: [`deploy/panel.env.example`](../deploy/panel.env.example).

## Updates and upgrades

### From the panel

**Admin, Settings, Updates** shows the current version, new commits on `origin/main` with their CI status and an **Update panel** button
(optionally only when CI is green). The update runs `deploy/upgrade.sh` detached on the host: the panel is unavailable for a minute or two,
game servers keep running, and if the health check fails the previous version is restored automatically. The page shows the steps, the result and
the last log lines. Turn **Allow panel updates** off on a machine where you develop.

### From the shell

```bash
cd BSSG-Panel
sudo deploy/upgrade.sh --check      # list available updates
sudo deploy/upgrade.sh --dry-run    # show what would happen
sudo deploy/upgrade.sh              # update to origin/main, roll back on failure
sudo deploy/upgrade.sh --ref <sha>  # a specific commit
```

`upgrade.sh` refuses to run with local changes in the checkout, takes a lock, runs `install.sh --non-interactive` at the new commit and checks
panel, daemon and Compose services. Logs and `status.json` are in `/var/lib/panel/upgrade`. The plain way, `git pull && sudo deploy/install.sh
--non-interactive`, still works but has no rollback.

Remote nodes are not updated by this. Use **Update daemon** on the node in **Admin, Nodes**, or run the join command again.

## Backups and S3

### Server backups

Backups of servers go to S3-compatible storage (AWS S3, MinIO, Backblaze B2, Cloudflare R2 and similar). Add a target under
**Admin, Settings, Backup storage**: endpoint URL, bucket, region, path-style on or off, access key and secret key, then run the connection
test. A default target can be chosen per node. Keys are stored encrypted. Users create, restore and schedule backups themselves. Each server keeps
at most `max_backups_per_server` completed backups (default 7); the oldest is removed from S3 when a new one completes. More: [backups.md](backups.md).

### The panel itself

The panel database lives in the `panel-postgres-data` volume, customer databases in `panel-mariadb-data` and server data in `/var/lib/panel`.
Back them up, and keep a copy of `/etc/panel/panel.env`: without `PANEL_ENCRYPTION_KEY` the encrypted secrets in the database cannot be read.
A quick manual dump:

```bash
docker exec panel-postgres pg_dump -U panel panel > panel.sql
docker exec panel-mariadb sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-dump -uroot --all-databases --single-transaction' > mariadb.sql
```

## Network isolation

Every server gets its own Docker network (`panel-site-<uuid>`, label `panel.role=site`), also game servers; nothing uses the shared default
`bridge`. Sites never see each other. A website with a database is not put on a shared network: the daemon connects MariaDB to that site's
own network. A Velocity proxy and its backends share one extra network (`panel-net-<proxy-uuid>`, `panel.role=proxy-net`).

The subnets come from `DOCKER_NETWORK_POOL` in `panel.env`:

| Value | Meaning |
|---|---|
| empty (default) | `10.213.0.0/16`: a `/28` per server and a `/26` per Velocity network |
| a CIDR, for example `10.50.0.0/16` | use that block instead |
| `docker` | let Docker pick from its default pools (only about 30 networks fit there) |

The block must not overlap with your LAN, VPN or other Docker networks. After changing it, restart the daemon; existing networks keep their
subnet until the server is recreated.

## Emergency login

For the case that Discord itself is unavailable, the panel has an emergency account with a password and a mandatory
authenticator code. Set it on the panel host with `sudo deploy/install.sh --set-emergency-password` (prints a QR code once). Using it raises
an alert on the admin dashboard. Treat it as a break-glass account.

## Uninstalling

`deploy/uninstall.sh` removes a panel or node installation:

```bash
sudo deploy/uninstall.sh --dry-run            # show what would be removed, change nothing
sudo deploy/uninstall.sh --backup             # dump PostgreSQL + MariaDB and copy panel.env first, then remove
sudo deploy/uninstall.sh --purge              # also delete the data
sudo deploy/uninstall.sh --purge --yes        # no confirmation prompt
```

Without `--yes` it lists everything and asks you to type the panel domain (on a node: the node domain).

| Removed | When |
|---|---|
| The `panel-daemon` unit (stopped, disabled, deleted) and `/usr/local/bin/panel-daemon` | always |
| Containers, networks and locally built images with **both** `panel.managed=true` and `panel.instance=<PANEL_INSTANCE>`: the Compose stack, game servers, websites, install containers | always |
| Docker volumes with those labels (PostgreSQL, MariaDB, Caddy certificates), `/etc/panel`, `DATA_DIR` (`/var/lib/panel`, all server files), `/opt/panel-node` | only with `--purge` |

Without `--purge` volumes, configuration and data stay, so running `install.sh` again brings the panel back as it was. `--backup[=DIR]` writes
`postgres.sql`, `mariadb.sql` and `panel.env` to `DIR` (default `/root/panel-backup-<date>`, mode 700) and aborts before removing anything if a
dump fails. The script never touches Docker objects without both labels, other panel instances, the git checkout, Docker itself, firewall rules
or DNS records. A node that joined with the join script can also be removed with `join.sh --uninstall [--purge]`; delete the node in
**Admin, Nodes** as well.

## Troubleshooting

Logs:

```bash
journalctl -u panel-daemon -f        # daemon
docker logs -f panel-web             # panel
docker logs -f panel-caddy           # Caddy and certificates
docker compose --env-file /etc/panel/panel.env -f deploy/docker-compose.yml ps
```

| Symptom | Check |
|---|---|
| Servers show `unknown` | The panel cannot reach the node: `systemctl status panel-daemon`, Caddy running, `NODE_DOMAIN` resolves, node token correct |
| `/admin` sends you to Account | Enable 2FA and verify it in this session |
| Certificate stays pending or `dns_wrong` | A record wrong or the Cloudflare proxy is on; set the record to DNS only |
| Join script waits for DNS | Create the A record shown in the panel, or connect a Cloudflare zone |
| New servers fail with an address pool error | `DOCKER_NETWORK_POOL` overlaps with another network or is full; pick another block |
| Update rolled back | See the log on the Updates page or in `/var/lib/panel/upgrade` |
| Port 80, 443 or 2022 in use | Stop the other service; the installer needs them. On a remote node you can instead run HTTP(S) through a relay node (see Nodes) and pick another SFTP port |
| Relay tunnel not connected | The card in Admin, Nodes shows the last error. `HTTP 401`/`403`: wrong or old secret, press Apply again; certificate error: the relay node has no valid certificate for its own domain yet; `journalctl -u panel-daemon` on both nodes |
| Site behind a relay shows "unavailable" | The tunnel is down or Caddy on the node is not in relay mode (`--http-mode relay`) |

More symptoms and fixes: [troubleshooting.md](troubleshooting.md).
