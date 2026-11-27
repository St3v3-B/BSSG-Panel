/**
 * Catalogue of one-click apps. Data-driven: an app is one definition below; the engine
 * (engine.ts) knows nothing about individual apps. Adding an app = adding an entry here
 * (plus UI strings for its name/description if you want them translated).
 *
 * Only these sources are ever downloaded: every hop of every download (including redirects)
 * must be https and on the app's `hosts` list. Users cannot supply URLs.
 */
import { randomBytes } from "node:crypto";

export type ArchiveFormat = "zip" | "tar.gz";
export type ChecksumAlgo = "sha1" | "sha256";

export type SourceDef =
  /** Fixed download URL with a checksum file next to it (first hex word in the file). */
  | { kind: "url"; url: string; format: ArchiveFormat; checksumUrl: string; algo: ChecksumAlgo }
  /** GitHub release: the asset's `digest` (sha256) from the releases API is the checksum. */
  | { kind: "github"; repo: string; asset: RegExp; format: ArchiveFormat };

export interface AppFile {
  /** Path relative to the home directory of the site (`/home/container`), e.g. `public/x.php` or `wp-config.php`. */
  path: string;
  content: string;
}

export interface AppCtx {
  siteName: string;
  /** Domains of the site (without scheme), first one is primary. */
  domains: string[];
  db: { host: string; port: number; name: string; user: string; password: string } | null;
  admin: { username: string; email: string; password: string } | null;
}

export interface AppDef {
  id: string;
  name: string;
  description: string;
  homepage: string;
  downloadMb: number;
  /** Hard cap on the download (bytes). */
  maxBytes: number;
  /** The site's template slug must start with this (`php-` = all PHP versions). */
  templatePrefix: string;
  hosts: string[];
  source: SourceDef;
  /** Top-level directory inside the archive whose contents go to public/ ("" = archive root). */
  strip: string;
  database: boolean;
  /** Can the installer create the admin user (username + e-mail, generated password)? */
  admin: boolean;
  adminPath: string;
  /** Read the installed version from a file after extraction (otherwise the source's version). */
  versionFile?: { path: string; pattern: RegExp };
  /** Directories to create (relative to home) before the files are written. */
  dirs?: string[];
  files: (c: AppCtx) => AppFile[];
  /** Note keys for the UI (translated there). */
  notes: (c: AppCtx) => string[];
}

const GITHUB_HOSTS = ["api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];

/** PHP single-quoted string literal. */
export const phpStr = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const SALT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#%^&*()-_=+[]{}<>,.;:|~";
export function salt(len = 64): string {
  const b = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += SALT_CHARS[b[i]! % SALT_CHARS.length];
  return out;
}

const dbHost = (d: NonNullable<AppCtx["db"]>) => (d.port === 3306 ? d.host : `${d.host}:${d.port}`);

// ---------- WordPress ----------

const wordpressConfig = (c: AppCtx): string => {
  const d = c.db!;
  const keys = ["AUTH_KEY", "SECURE_AUTH_KEY", "LOGGED_IN_KEY", "NONCE_KEY", "AUTH_SALT", "SECURE_AUTH_SALT", "LOGGED_IN_SALT", "NONCE_SALT"];
  const setup = c.admin
    ? `
// One-time setup written by the panel: completes the installation on the first request,
// then deletes the file with the admin password (and this block does nothing any more).
$panel_setup = __DIR__ . '/.panel-wp-setup.json';
if (PHP_SAPI !== 'cli' && is_file($panel_setup)) {
    define('WP_INSTALLING', true);
    require_once ABSPATH . 'wp-settings.php';
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $fh = fopen($panel_setup, 'r');
    if ($fh && flock($fh, LOCK_EX)) {
        if (is_file($panel_setup)) {
            $cfg = json_decode((string) stream_get_contents($fh), true);
            if (is_array($cfg) && !is_blog_installed()) {
                wp_install($cfg['title'], $cfg['username'], $cfg['email'], true, '', $cfg['password']);
            }
            @unlink($panel_setup);
        }
        flock($fh, LOCK_UN);
    }
    header('Location: ' . (isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/'), true, 302);
    exit;
}
`
    : "";
  return `<?php
// Written by the panel. Database credentials; the file lives outside public/ (WordPress finds it there).
define('DB_NAME', ${phpStr(d.name)});
define('DB_USER', ${phpStr(d.user)});
define('DB_PASSWORD', ${phpStr(d.password)});
define('DB_HOST', ${phpStr(dbHost(d))});
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');

${keys.map((k) => `define('${k.padEnd(16)}', ${phpStr(salt())});`).join("\n")}

$table_prefix = 'wp_';
define('WP_DEBUG', false);
// The site runs as the same (non-root) user as PHP: plugin and theme updates can write directly.
define('FS_METHOD', 'direct');
// HTTPS is terminated by the proxy in front of the site.
if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') {
    $_SERVER['HTTPS'] = 'on';
}

if (!defined('ABSPATH')) {
    define('ABSPATH', __DIR__ . '/public/');
}
${setup}
require_once ABSPATH . 'wp-settings.php';
`;
};

// ---------- Nextcloud ----------

const nextcloudFiles = (c: AppCtx): AppFile[] => {
  const d = c.db!;
  const auto: Record<string, string> = {
    dbtype: "mysql",
    dbname: d.name,
    dbuser: d.user,
    dbpass: d.password,
    dbhost: dbHost(d),
    directory: "/home/container/nextcloud-data",
  };
  if (c.admin) {
    auto.adminlogin = c.admin.username;
    auto.adminpass = c.admin.password;
  }
  const arr = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `  ${phpStr(k)} => ${phpStr(v)},`).join("\n");
  return [
    // Nextcloud completes the installation from this file on the first visit and then removes it.
    { path: "public/config/autoconfig.php", content: `<?php\n$AUTOCONFIG = [\n${arr(auto)}\n];\n` },
    {
      path: "public/config/panel.config.php",
      content: `<?php
// Written by the panel: HTTPS behind the proxy and the domains of this site.
$CONFIG = [
  'overwriteprotocol' => 'https',
  'trusted_proxies' => ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
  'trusted_domains' => [${c.domains.map(phpStr).join(", ")}],
  'check_data_directory_permissions' => false,
];
`,
    },
    {
      path: "nginx/nextcloud.conf",
      content: `# Written by the panel: keep Nextcloud's internal directories private.
location ^~ /config/ { return 404; }
location ^~ /lib/ { return 404; }
location ^~ /3rdparty/ { return 404; }
location ^~ /templates/ { return 404; }
location ^~ /data/ { return 404; }
location ^~ /build/ { return 404; }
location ^~ /tests/ { return 404; }
location = /.well-known/carddav { return 301 /remote.php/dav/; }
location = /.well-known/caldav { return 301 /remote.php/dav/; }
`,
    },
  ];
};

// ---------- Grav ----------

const GRAV_NGINX = `# Written by the panel: keep Grav's internals private (sources, config and content files).
location ^~ /cache/ { return 403; }
location ^~ /logs/ { return 403; }
location ^~ /backup/ { return 403; }
location ^~ /bin/ { return 403; }
location ^~ /tests/ { return 403; }
location ^~ /user/ {
  location ~* \\.(txt|md|json|yaml|yml|php|pl|py|cgi|twig|sh|bat|lock)$ { return 403; }
  try_files $uri =404;
}
location ^~ /system/ {
  location ~* \\.(txt|xml|md|html|htm|json|yaml|yml|php|pl|py|cgi|twig|sh|bat)$ { return 403; }
  try_files $uri =404;
}
location ^~ /vendor/ {
  location ~* \\.(txt|xml|md|html|htm|json|yaml|yml|php|pl|py|cgi|twig|sh|bat)$ { return 403; }
  try_files $uri =404;
}
location ~* ^/(LICENSE\\.txt|composer\\.(json|lock)|nginx\\.conf|web\\.config|htaccess\\.txt|CHANGELOG\\.md|README\\.md|CONTRIBUTING\\.md|CODE_OF_CONDUCT\\.md|SECURITY\\.md)$ { return 403; }
`;

export const CATALOG: AppDef[] = [
  {
    id: "wordpress",
    name: "WordPress",
    description: "The most popular CMS and blog platform. Latest release, database and wp-config.php are set up for you.",
    homepage: "https://wordpress.org",
    downloadMb: 35,
    maxBytes: 120 * 1024 ** 2,
    templatePrefix: "php-",
    hosts: ["wordpress.org", "downloads.wordpress.org", "api.wordpress.org"],
    source: { kind: "url", url: "https://wordpress.org/latest.tar.gz", format: "tar.gz", checksumUrl: "https://wordpress.org/latest.tar.gz.sha1", algo: "sha1" },
    strip: "wordpress",
    database: true,
    admin: true,
    adminPath: "/wp-admin/",
    versionFile: { path: "public/wp-includes/version.php", pattern: /\$wp_version\s*=\s*'([^']+)'/ },
    files: (c) => [
      { path: "wp-config.php", content: wordpressConfig(c) },
      ...(c.admin ? [{ path: ".panel-wp-setup.json", content: JSON.stringify({ title: c.siteName, username: c.admin.username, email: c.admin.email, password: c.admin.password }) }] : []),
    ],
    notes: (c) => (c.admin ? ["finish_in_browser"] : ["run_wizard"]),
  },
  {
    id: "grav",
    name: "Grav",
    description: "Fast flat-file CMS without a database: pages are Markdown files. Includes the admin plugin.",
    homepage: "https://getgrav.org",
    downloadMb: 23,
    maxBytes: 100 * 1024 ** 2,
    templatePrefix: "php-",
    hosts: GITHUB_HOSTS,
    source: { kind: "github", repo: "getgrav/grav", asset: /^grav-admin-v?[0-9.]+\.zip$/, format: "zip" },
    strip: "grav-admin",
    database: false,
    admin: false,
    adminPath: "/admin",
    versionFile: { path: "public/system/defines.php", pattern: /GRAV_VERSION',\s*'([^']+)'/ },
    files: () => [{ path: "nginx/grav.conf", content: GRAV_NGINX }],
    notes: () => ["create_admin_on_first_visit", "restart_needed"],
  },
  {
    id: "nextcloud",
    name: "Nextcloud",
    description: "Your own cloud: files, calendar, contacts. Large download (about 300 MB) and needs a site with enough disk space.",
    homepage: "https://nextcloud.com",
    downloadMb: 296,
    maxBytes: 700 * 1024 ** 2,
    templatePrefix: "php-",
    hosts: ["download.nextcloud.com"],
    source: { kind: "url", url: "https://download.nextcloud.com/server/releases/latest.zip", format: "zip", checksumUrl: "https://download.nextcloud.com/server/releases/latest.zip.sha256", algo: "sha256" },
    strip: "nextcloud",
    database: true,
    admin: true,
    adminPath: "/",
    versionFile: { path: "public/version.php", pattern: /\$OC_VersionString\s*=\s*'([^']+)'/ },
    dirs: ["nextcloud-data"],
    files: nextcloudFiles,
    notes: (c) => (c.admin ? ["finish_in_browser", "restart_needed"] : ["run_wizard", "restart_needed"]),
  },
];

export const appById = (id: string): AppDef | undefined => CATALOG.find((a) => a.id === id);
