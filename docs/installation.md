# Installation

This guide installs BSSG Panel on one dedicated Linux machine. That machine runs the panel,
its databases, Caddy and the node daemon. You can add more machines later, see
[multi-node.md](multi-node.md).

## Requirements

| What | Details |
|---|---|
| OS | Linux with systemd. Developed and tested on Ubuntu 24.04. |
| Docker | Docker Engine with the Compose plugin. |
| Go | Go 1.23 or newer, to build the daemon. Alternatively pass a prebuilt binary with `--daemon-bin`. |
| Free ports | `80`, `443` (TCP and UDP) and `2022` (SFTP). Game servers use extra ports of your choice. |
| DNS | Two A records pointing to the machine, for example `panel.example.com` and `node1.example.com`. |
| Discord | A Discord application (OAuth2) and your own Discord user ID. |
| Memory | The panel stack itself is light. Plan the rest for your game servers (a Paper server wants 1.5 GB or more). |

There is no IPv6 support yet. Remove stale AAAA records for your domains.

## 1. Create the Discord application

1. Open the [Discord developer portal](https://discord.com/developers/applications) and create an application.
2. Under **OAuth2**, add the redirect URI `https://panel.example.com/api/auth/discord/callback`
   (replace the domain with yours; it must match exactly).
3. Copy the **client ID** and **client secret**.
4. In Discord, enable Developer Mode (Settings, Advanced) and copy your own user ID. This is the
   owner account.

Optional: for the slash-command bot (`/servers`, `/status`, `/start`, `/stop`, `/restart`) create a bot in the same
application, invite it with the `applications.commands` scope and keep the bot token for `DISCORD_BOT_TOKEN`.

## 2. Run the installer

```bash
git clone https://github.com/St3v3-B/BSSG-Panel.git
cd BSSG-Panel
sudo deploy/install.sh
```

The installer asks for the values below, then:

1. writes `/etc/panel/panel.env` (mode `600`) and generates every key and password,
2. builds the daemon to `/usr/local/bin/panel-daemon` and installs the `panel-daemon` systemd unit,
3. builds and starts the Docker Compose stack: panel, PostgreSQL, Redis, MariaDB and Caddy.

Running it again is safe. Existing values are kept, generated secrets are never regenerated, and
restarting the daemon leaves running game servers alone.

### Installer options

```text
--non-interactive   no prompts; values come from the environment
--dry-run           change nothing; write to --root (default a temp dir) and print docker/systemctl commands
--root DIR          (only with --dry-run) target directory instead of /
--daemon-bin PATH   use a prebuilt panel-daemon instead of building with Go
--no-start          do not (re)start the unit and compose
--node-only         install a remote node only (see multi-node.md)
```

Every variable in [`deploy/panel.env.example`](../deploy/panel.env.example) can be passed in the
environment. A variable set in the environment wins over the value in an existing `panel.env`.

### Non-interactive install

```bash
sudo PANEL_DOMAIN=panel.example.com NODE_DOMAIN=node1.example.com \
     ACME_EMAIL=you@example.com OWNER_DISCORD_ID=<your discord id> \
     DISCORD_CLIENT_ID=<id> DISCORD_CLIENT_SECRET=<secret> \
     deploy/install.sh --non-interactive
```

## 3. First login

1. Open `https://panel.example.com` and sign in with Discord. The owner is always an admin.
2. Open **Account** and enable two-factor authentication with any TOTP app. Admins must do this
   before the admin area opens.
3. Open **Admin, Nodes**, add a port range to the local node (allocations), then create your first
   server or website.

## Configuration

Everything install-specific lives in `/etc/panel/panel.env`, read by Docker Compose and by the
daemon's systemd unit. The commented reference is
[`deploy/panel.env.example`](../deploy/panel.env.example). The important variables:

| Variable | Meaning |
|---|---|
| `PANEL_DOMAIN`, `NODE_DOMAIN` | Domains of the panel and of this node's daemon |
| `ACME_EMAIL` | E-mail for Let's Encrypt |
| `OWNER_DISCORD_ID` | Owner, always admin, can never be removed |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Discord OAuth2 application |
| `DISCORD_BOT_TOKEN` | Optional slash-command bot; empty means off |
| `PANEL_ENCRYPTION_KEY` | 32 bytes base64, AES-256-GCM for secrets in the database (generated) |
| `NODE_TOKEN` | Token of the local node (generated) |
| `NODE_PUBLIC_IP` | IPv4 for DNS instructions; empty means auto-detect |
| `MARIADB_ROOT_PASSWORD` | Root password of the bundled MariaDB (generated) |
| `SFTP_PORT`, `DAEMON_PORT` | Defaults `2022` and `8080` |
| `IMAGE_CHECK_INTERVAL` | How often the daemon checks for new images (default `24h`, `0` is off) |
| `NODE_POLL_INTERVAL_MS` and friends | Background node monitor tuning |

## Where things live

| Path | What |
|---|---|
| `/etc/panel/panel.env` | All configuration and secrets |
| `/var/lib/panel/volumes/<uuid>` | Data of each server |
| `/var/lib/panel/state` | Daemon state: server specs, routes, SFTP host key |
| `/run/panel/` | Daemon socket and Caddy admin socket |
| `panel-daemon` (systemd) | The node daemon |
| Docker objects with label `panel.managed=true` | Everything the panel created |

## Updating

```bash
cd BSSG-Panel
git pull
sudo deploy/install.sh --non-interactive
```

## Changing the domain

Edit `/etc/panel/panel.env`, run `systemctl restart panel-daemon`, bring the stack up again
(`docker compose --env-file /etc/panel/panel.env -f deploy/docker-compose.yml up -d`) and update the
redirect URI in the Discord portal.

## Day-to-day management

```bash
cd BSSG-Panel
docker compose --env-file /etc/panel/panel.env -f deploy/docker-compose.yml ps
docker compose --env-file /etc/panel/panel.env -f deploy/docker-compose.yml logs -f
systemctl status panel-daemon
journalctl -u panel-daemon -f
```

More detail on how the containers reach each other is in [`deploy/README.md`](../deploy/README.md).
Problems? See [troubleshooting.md](troubleshooting.md).
