# Websites

## Templates

| Template | What |
|---|---|
| **Static site** | nginx, dotfiles blocked, custom `nginx/*.conf` supported |
| **PHP 8.2, 8.3, 8.4** | nginx and PHP-FPM with mysqli, pdo_mysql, gd, intl, zip, exif, curl, mbstring and opcache; 64 MB uploads; WordPress permalinks; PHP in `uploads/` blocked |
| **Node.js site** | A Node app behind Caddy, dependencies installed at install time |
| **Adminer** | Database UI pre-filled for the local MariaDB |

Each website runs as a non-root container on its own Docker network (`panel-site-<uuid>`) with a read-only root filesystem.
Sites cannot see each other or your game servers. New sites get a friendly "your website is live" page, and sites that are installing,
stopped, out of disk space or unreachable show a matching status page instead of a bare 502.

## Domains and SSL

Open the **Domains** tab and add a domain. The panel then:

1. shows the exact DNS records to create (A record for the apex, CNAME for `www`) with copy buttons,
2. detects the DNS provider from the nameservers and shows step-by-step instructions,
3. re-checks every 30 seconds while the screen is open, using 1.1.1.1 and 8.8.8.8, and reports each record as missing, wrong IP,
   behind a Cloudflare proxy, or ok,
4. warns about common mistakes: Cloudflare's orange cloud, stale AAAA records, a CNAME on the apex,
5. shows the certificate status: `pending`, `issuing`, `active`, `dns_wrong` or `failed` with a reason.

Certificates come from Let's Encrypt through Caddy. You can redirect `www` to the apex or the other way around.

**Cloudflare (optional).** An admin adds an API token under **Admin, Settings**. After that the panel can create the records with one click and
Caddy can issue **wildcard certificates** through the DNS-01 challenge.

## PHP settings

On the **Settings** tab of a PHP site you can change memory limit, upload size (which also sets the nginx body limit), max execution time, max input vars, error display,
timezone and OPcache, and switch off individual PHP extensions, without editing configuration files.

## Cron and schedules

The **Schedules** tab accepts a cron expression (timezone `Europe/Amsterdam`) and the action `exec`, which runs a command in the site
container and keeps the last 4 KiB of output. WP-CLI works from the container CLI, so a schedule like `wp cron event run --due-now` is possible.

## One-click apps

The **Apps** tab installs ready-made applications into an empty PHP site: **WordPress**, **Grav** and **Nextcloud**. The panel downloads the
release, verifies its checksum where the project publishes one, creates the database, writes the config and shows the admin login at
the end. Installs run as a background job, and a failed install is rolled back (database included).

## Git deploy

The **Deploy** tab publishes a website from a Git repository.

1. Enter the repository URL and branch. For a private repository use an HTTPS URL with an access token (stored encrypted), or an
   SSH URL: the panel then creates a **deploy key**; add its public key to the repository (read-only is enough). For hosts other
   than GitHub, GitLab and Bitbucket you confirm the host key fingerprint once.
2. Pick the folder to publish (default `public`, `app` for Node.js), optionally a subfolder of the repository (for example `dist`)
   and an optional **build command** (`npm ci && npm run build`, `composer install --no-dev`) with a build image.
3. List **shared paths** that must survive a deploy, such as `.env` or `uploads/`.
4. Press **Deploy now**, or copy the **webhook URL** and secret into GitHub, GitLab, Gitea or Bitbucket to deploy on every push to
   the branch.

A deploy fetches and builds in separate, locked-down containers and swaps the folder in one atomic step. If anything fails before
that, the live site is untouched. History, live log and cancel are on the same tab; failed deploys send a notification.
Submodules are not supported yet.

## Staging and publishing

The **Staging** tab lets you try changes on a copy of a website and then publish them to the live site.

**Create a staging copy.** On the live site, press **Create staging copy** (owner or admin). This is a normal duplicate (see
*Duplicate* on the Settings tab) named `<site> (staging)`, with its own databases and, optionally, its own domain. Any successful copy
of a website counts as a staging copy of the site it was copied from, as long as that site still exists. The staging site shows
"This site is a staging copy of …", and the live site lists its staging copies with the last publish date.

**Publish.** On the staging site, press **Publish to production** and choose:

- **Files** (on by default): the live files are replaced by the staging files, except the paths you keep (see below).
- **Databases** (off by default): each live database is replaced by the staging database with the same base name (for example
  `s<staging>_wordpress` → `s<live>_wordpress`). This overwrites everything that changed on the live site since the copy was made
  (new orders, comments, accounts), so you have to confirm it explicitly.
- **Replace URLs** (with databases): the staging domain is replaced by the live domain in the databases (see below).
- **Paths to keep**: by default `wp-config.php`, `.env`, the Nextcloud config files, the PHP settings the panel writes
  (`php/00-panel.ini`, `nginx/00-panel.conf`, `php/.disabled-extensions`), the PHP extensions the panel installs (`.php/`),
  `public/wp-content/uploads/` (only kept by default when you don't publish the databases) and `nextcloud-data/`. You can untick them and
  add your own (gitignore-like: a bare name matches at any depth, a path with `/` starts at the root, a trailing `/` matches folders
  only; no `**` or `!`). A kept path keeps the live version; if the live site doesn't have it, the staging version isn't published either.
  Names starting with `.panel-` (git deploy, work folders, one-time setup files) are never published.

What happens, step by step (visible as progress, and kept in the publish history of both sites):

1. **Backup** of the live site with its databases, using the normal backup flow, and waiting until it is complete. Without a backup
   target for the node you have to tick **Continue without a backup**.
2. **Prepare**: the staging files are copied into a work folder (`.panel-publish-<id>`) inside the live site. On the same node the daemon
   copies them locally; across nodes they are streamed through the panel like moving a server. The live site keeps running.
3. **Stop** the live site (only if it was running); visitors see the "stopped" status page for a moment.
4. **Swap**: the daemon moves the current files aside and the new version into place with renames (no copying), then puts the kept paths
   back. Every step is journaled, so a failed swap is undone completely, also after a daemon restart.
5. **Databases**: a safety copy of each live database is made on the same MariaDB, then the staging dump is imported with the database
   emptied first (`DROP` + `CREATE`, the site's user keeps its rights).
6. **Start** the live site again if it was running.
7. **Clean up**: the previous version and the safety copies are removed.

If any step fails, the live site is put back: databases from their safety copies, files by undoing the swap, and started again. The
result says whether that worked; if a database could not be restored, its safety copy (`pb<id>_<n>`) is kept and named in the notes.

**URL replacement.** The panel replaces `://<staging domain>` (and the JSON form `:\/\/<staging domain>`) with the live domain in every
string of the dump, but only when the domain ends there (`staging.example.com` does not touch `staging.example.com.other`). Serialized
PHP data (WordPress options, widgets, page builders) is parsed and rebuilt with correct byte lengths, also when nested. A value that
looks serialized but can't be parsed safely is left unchanged and counted, and the result tells you how many. Binary columns are not
touched. For WordPress (detected from `$table_prefix` in the live `wp-config.php`) `siteurl` and `home` are also updated with an explicit
`UPDATE` at the end of the import. URLs are only replaced when both sites have a domain.

**Permissions.** Owners and admins can always publish. A subuser needs `files.read` on the staging site and `files.write` + `power` on
the live site, plus `backup.create` on the live site when a backup is made, and `database.manage` on both when publishing databases.
API keys can't publish. Every publish is in the activity log of both sites (`server.publish.start`, `.complete`, `.failed`).

**Limitations.** While publishing, power actions and git deploys on the live site are refused. During step 2 both versions are on the
live site's disk, so it needs free disk space for the staging files (otherwise `DISK_EXCEEDED`). If the live site deploys from Git, its next
deploy replaces the published files in its target folder. Daemons older than this feature fail with `DAEMON_TOO_OLD` (nothing changes).

## Databases

The **Databases** tab creates MariaDB databases. Every database gets its own user with rights on that database only. The daemon attaches the MariaDB
container to the site's own network for as long as the site has a database; inside the site the host is `panel-mariadb`, port `3306`.
Passwords are stored encrypted and can be reset.

## Files and logs

Use the file manager or SFTP (`<name>.<shortId>` on port 2022). The **Logs** tab is read-only with filter, pause/follow and colour-coded errors,
and downloads as a `.txt` file.
