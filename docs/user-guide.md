# User guide

For people who log in to a panel somebody else runs. Admins should also read the
[admin guide](admin-guide.md). Examples use `panel.example.com` and `node1.example.com`; your
panel has its own domains.

- [Signing in, 2FA and recovery codes](#signing-in-2fa-and-recovery-codes)
- [Your servers](#your-servers)
- [Console and logs](#console-and-logs)
- [Files](#files)
- [SFTP](#sftp)
- [Backups](#backups)
- [Schedules](#schedules)
- [Domains](#domains)
- [Databases and phpMyAdmin](#databases-and-phpmyadmin)
- [Statistics (usage graphs)](#statistics-usage-graphs)
- [Subusers and permissions](#subusers-and-permissions)
- [API keys](#api-keys)
- [Notifications and the Discord bot](#notifications-and-the-discord-bot)
- [Quotas: creating your own servers](#quotas-creating-your-own-servers)

## Signing in, 2FA and recovery codes

Login is with Discord. If an admin has not created your account yet, you land on a waiting
screen until they approve you. You can switch the interface between English and Dutch and between
light and dark at any time (bottom of the sidebar; on a phone, open the menu).

### Two-factor authentication

Under **Account** scan the QR code with any TOTP app (Aegis, 2FAS, Google Authenticator, a password
manager, ...) and confirm with a six-digit code. Can't scan it? Type the key shown below the QR code.
From then on every login asks for a code. 2FA is optional for users and **mandatory for admins**: the
admin area stays closed until it is enabled and verified in the current session.

### Recovery codes

When you enable 2FA the panel shows **10 recovery codes**, once. Copy or download them and keep them
somewhere safe. Each code works one time instead of an app code, for example when you lose your phone:
on the code screen at login choose **Use a recovery code instead**.

- The account page shows how many codes are left and warns when only two remain.
- **Generate new codes** replaces all existing codes; the old ones stop working at once.
- Out of codes and lost your phone? Ask an admin to reset your 2FA.

### Sessions

**Account, Active sessions** lists where you are signed in. Sign out one device or everywhere else.
Sessions also end on their own after a period of inactivity.

## Your servers

The home page lists your game servers and websites as cards with live status, address and CPU,
memory and disk meters. A card shows a badge when a newer container image is available.

Open a server to see its tabs. Which tabs you see depends on the server type and your permissions.

| Tab | What it does |
|---|---|
| **Console** (game) / **Logs** (website) | Live console with command input and history, or a read-only log viewer |
| **Files** | File manager with editor, search, permissions, archives, upload and download |
| **Plugins / Mods** | Search and install from Modrinth and Hangar, update and uninstall, import modpacks (see [minecraft.md](minecraft.md)) |
| **Domains** | Attach domains, see the exact DNS records, live DNS and SSL status |
| **Network** | Velocity proxy: add backends and manage the network |
| **Bedrock** | Let Bedrock players join through Geyser and Floodgate |
| **Apps** | One-click apps for websites (WordPress, Grav, Nextcloud) |
| **Databases** | MariaDB databases, one user per database, phpMyAdmin |
| **Statistics** | CPU, memory, disk and network graphs |
| **Backups** | Create, restore, download and delete backups |
| **Schedules** | Cron-style tasks: restart, command, backup or shell command |
| **Users** | Invite subusers with fine-grained permissions (owner only) |
| **Settings** | Rename, limits, variables, sleep mode, image updates, PHP settings, reinstall, delete |

### Power controls

Start, stop, restart and kill are in the header. They react immediately; the real state follows a
moment later. **Kill** ends the process at once and can lose unsaved world data, so prefer **Stop**.
If the node cannot be reached the status shows `unknown` with the time it was last seen.

### Crashes

The daemon notices when a server exits unexpectedly (exit code, out-of-memory, crash report) and
restarts it with a growing delay and a limit. You are notified when it happens.

## Console and logs

- The console connects straight to the node and shows the last 500 lines when it opens.
- Type a command and press Enter. The up and down arrows walk through your command history.
- When the connection drops, the console reconnects on its own.
- Websites have a **Logs** tab instead: a read-only viewer with a filter, pause/follow and download.

You need `console.read` to watch and `console.write` to send commands.

## Files

The **Files** tab manages the server's directory. Nothing outside that directory is reachable, not even
through symlinks.

| Action | How |
|---|---|
| Open and edit | Click a text file. The editor highlights syntax; **Ctrl+S** (**Cmd+S** on a Mac) saves. Leaving with unsaved changes asks first. |
| Upload | Drag files onto the list, or use **Upload**. |
| Download | One file directly; a selection or a folder as **.zip** or **.tar.gz**. |
| New file or folder, rename, delete | Buttons above the list, or the menu on each row. |
| Move | Select items, choose **Move** and type the destination folder, for example `/plugins`. |
| Compress and extract | **Compress** packs the selection into a `.tar.gz` archive. **Extract** unpacks `.zip`, `.tar`, `.tar.gz` / `.tgz` and `.tar.zst` in the current folder. |
| Search | **Search** finds files by name from the current folder down; `*` and `?` work as wildcards. **Search file contents** finds text inside files (text files up to 1 MB, binary files are skipped) and shows the line number. Very broad searches show only the first results. |
| Permissions (chmod) | Choose **Permissions** on one or more items. Tick read, write and execute for owner, group and others, or type an octal mode such as `644` or `755`. For folders you can apply it recursively, with one mode for files and one for folders; symlinks are skipped. Special bits (setuid, setgid, sticky) need an extra confirmation. |

Browser uploads and downloads use one-time links that expire after ten minutes. When the server is at its
disk limit, uploads and saves are refused with a clear message; a warning appears at 90%.

You need `files.read` to browse and download, and `files.write` for everything that changes something.

## SFTP

SFTP is handy for many files at once, with tools like FileZilla or WinSCP. The **Files** tab shows the exact
connection details with copy buttons.

| Field | Value |
|---|---|
| Host | the node's domain, for example `node1.example.com` |
| Port | `2022`, unless your admin changed it |
| Username | `<your Discord name>.<shortId>`, where `shortId` is the first eight characters of the server UUID |
| Password | your SFTP password (set it under **Account**) or an API key |

Your permissions apply over SFTP too: with only `files.read` the connection is read-only.

## Backups

On the **Backups** tab:

- **Create** a backup, optionally including the server's databases (dumped with `mariadb-dump`). Progress is shown while it runs.
- Every backup has a size and a SHA-256 checksum. A failed backup shows its reason and sends a notification.
- **Restore** needs the `backup.restore` permission. The checksum is checked again before the files are replaced.
- **Download** a backup through a one-time link.
- When the maximum number of backups is reached, the oldest one is removed automatically. You can also delete backups yourself.

Backups go to the S3-compatible storage your admin configured. Details: [backups.md](backups.md).

## Schedules

The **Schedules** tab runs tasks on a cron expression (five fields, timezone `Europe/Amsterdam`).

| Action | What it does |
|---|---|
| `restart` | Restart the server |
| `command` | Send a console command (game servers) |
| `backup` | Create a backup |
| `exec` | Run a shell command in a website container; the last 4 KiB of output is kept |

**Run now** runs a schedule immediately. You need `schedule.manage`.

## Domains

On the **Domains** tab of a website (or of a game server, if the admin allows it):

1. Add a domain, for example `www.example.com`.
2. The panel shows the exact DNS records to create, with copy buttons and step-by-step instructions for common DNS
   providers. For a game server it also shows the SRV record, so players can join without a port.
3. The status refreshes every 30 seconds: DNS (`ok`, `missing`, `wrong IP`, `behind Cloudflare proxy`) and SSL
   (`pending`, `waiting for DNS`, `requesting`, `active`, `failed`). The Let's Encrypt certificate is requested as soon as
   DNS is right, usually within a minute.

Tips: switch the Cloudflare proxy (orange cloud) off for these records, remove AAAA records (there is no IPv6 yet) and do not
put a CNAME on the apex. If the admin connected a Cloudflare account, the panel can create the records for you, and wildcard
certificates become possible. Extra domains can redirect to the main one. You need `domain.manage`.
More: [websites.md](websites.md).

## Databases and phpMyAdmin

On the **Databases** tab you create MariaDB databases. Each database gets its own user with rights on that
database only. The tab shows host, port, database name, user and a password you can reveal, copy or reset.

- From inside the website the host is `panel-mariadb`, port `3306`. Databases are not reachable from the internet.
- **Open in phpMyAdmin** signs you in to phpMyAdmin (`https://panel.example.com/phpmyadmin/`) with a temporary account that
  sees only your databases. You never type a database password there.
- Databases on another node than the panel's own are not available in phpMyAdmin yet.

You need `database.manage`.

## Statistics (usage graphs)

The **Statistics** tab shows CPU, memory, disk and network (in and out) for the last hour, 24 hours, 7 days or 30 days, with
average, peak and the server's limit. The panel measures every minute while the server runs and keeps per-minute values for
24 hours, 15-minute values for 7 days and hourly values for 30 days. Gaps mean the server was off or its node was unreachable.
**Show as table** gives the same numbers as a table. You need `console.read`.

## Subusers and permissions

As the owner of a server you invite people by Discord ID on the **Users** tab and pick what they may do.

| Permission | Allows |
|---|---|
| `console.read` | Console or logs, live stats and graphs |
| `console.write` | Send commands |
| `power` | Start, stop, restart, kill |
| `files.read` | Browse and download files; read-only SFTP |
| `files.write` | Edit, upload, delete, move, chmod, compress, extract; write SFTP |
| `backup.create`, `backup.restore` | Create and restore backups |
| `database.manage` | Create databases, reset passwords, phpMyAdmin |
| `domain.manage` | Add domains, change redirects |
| `schedule.manage` | Manage schedules |

Only the owner manages subusers and can delete the server.

## API keys

Under **Account, API keys** you create keys for scripts and tools.

- Pick a name, the permissions the key may use and optionally an expiry date. The key is shown **once**; copy it right away.
- A key never gives more than you have yourself: on each server it gets the overlap of its permissions and yours. A key never
  gives admin access.
- Send it as a bearer token (`Authorization: Bearer <key>`), or use it as the SFTP password.
- The list shows the first characters of each key and when it was last used. Delete a key to revoke it immediately.

## Notifications and the Discord bot

Under **Account** you can paste a Discord webhook URL. The panel posts when one of your servers
crashes or runs out of disk, when a backup, install or certificate fails, and when a node goes offline or
comes back. The webhook URL is never shown again after saving, only a hint.

If the admin enabled the Discord bot, `/servers`, `/status`, `/start`, `/stop` and `/restart` work for
the servers you may control.

## Quotas: creating your own servers

If an admin gave you a quota you can create servers yourself (**New server**) within it: total RAM, disk, CPU, number of
servers and databases, allowed templates and nodes. Your usage is shown on the home page.
