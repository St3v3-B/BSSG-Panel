# User guide

For people who log in to a panel somebody else runs. Admins should also read the
[admin guide](admin-guide.md).

## Signing in

Login is with Discord. If an admin has not created your account yet, you land on a waiting
screen until they approve you. You can switch the interface between English and Dutch and between
light and dark at any time (bottom of the sidebar; on a phone, open the menu).

Set up two-factor authentication under **Account**. It is optional for users and mandatory for admins.

## Your servers

The home page lists your game servers and websites as cards with live status, address and CPU,
memory and disk meters. A card shows a badge when a newer container image is available.

Open a server to see its tabs. Which tabs you see depends on the server type and your permissions.

| Tab | What it does |
|---|---|
| **Console** (game) / **Logs** (website) | Live console with command input and history, or a read-only log viewer with filter, pause/follow and download |
| **Files** | File manager with a Monaco editor, drag and drop upload, download, rename, zip and unzip |
| **Plugins / Mods** | Search and install from Modrinth and Hangar, update and uninstall, import modpacks (see [minecraft.md](minecraft.md)) |
| **Domains** | Attach domains, see exact DNS records, live DNS and SSL status |
| **Network** | Velocity proxy: add backends and manage the network |
| **Bedrock** | Let Bedrock players join through Geyser and Floodgate |
| **Apps** | One-click apps for websites (WordPress, Grav, Nextcloud) |
| **Databases** | MariaDB databases, one user per database |
| **Backups** | Create, restore, download, delete backups |
| **Schedules** | Cron-style tasks: restart, command, backup or shell command |
| **Users** | Invite subusers with fine-grained permissions (owner only) |
| **Settings** | Rename, limits, variables, sleep mode, image updates, PHP settings, reinstall, delete |

### Power controls

Start, stop, restart and kill are in the header. They react immediately; the real state follows a
moment later. If the node cannot be reached the status shows `unknown` with the time it was last seen.

### Crashes

The daemon notices when a server exits unexpectedly (exit code, out-of-memory, crash report) and
restarts it with a growing delay and a limit. You are notified when it happens.

## Files, SFTP and API keys

SFTP runs on port `2022` of the node. Username: `<your Discord name>.<shortId>` where `shortId` is the
first eight characters of the server UUID (the Files tab shows the exact value). Password: your
SFTP password (set under **Account**) or an API key.

Downloads and uploads from the browser use one-time links that expire after ten minutes.

## Subusers and permissions

As the owner of a server you can invite people by Discord ID and pick what they may do.

| Permission | Allows |
|---|---|
| `console.read` | Console or logs and live stats |
| `console.write` | Send commands |
| `power` | Start, stop, restart, kill |
| `files.read` | Browse and download files; read-only SFTP |
| `files.write` | Edit, upload, delete; write SFTP |
| `backup.create`, `backup.restore` | Create and restore backups |
| `database.manage` | Create databases, reset passwords |
| `domain.manage` | Add domains, change redirects |
| `schedule.manage` | Manage schedules |

## Notifications

Under **Account** you can paste a Discord webhook URL. The panel posts when one of your servers
crashes or runs out of disk, when a backup, install or certificate fails, and when a node goes offline or
comes back. The webhook URL is never shown again after saving, only a hint.

If the admin enabled the Discord bot, `/servers`, `/status`, `/start`, `/stop` and `/restart` work for
the servers you may control.

## Quotas

If an admin gave you a quota you can create servers yourself within it: total RAM, disk, CPU, number of
servers and databases, allowed templates and nodes. Your usage is shown on the home page.
