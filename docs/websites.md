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

## Databases

The **Databases** tab creates MariaDB databases. Every database gets its own user with rights on that database only. The daemon attaches the MariaDB
container to the site's own network for as long as the site has a database; inside the site the host is `panel-mariadb`, port `3306`.
Passwords are stored encrypted and can be reset.

## Files and logs

Use the file manager or SFTP (`<name>.<shortId>` on port 2022). The **Logs** tab is read-only with filter, pause/follow and colour-coded errors,
and downloads as a `.txt` file.
