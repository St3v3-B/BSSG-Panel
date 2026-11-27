# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it has releases.

## [Unreleased]

### 0.1.0 (first public version, not yet tagged)

#### Added

- **Core**: Next.js 16 and tRPC panel, Go node daemon, Caddy for automatic HTTPS, PostgreSQL, Redis and MariaDB, installed with one script (`deploy/install.sh`).
- **Contracts first**: tRPC contract (zod), daemon OpenAPI, panel remote API, template schema and a Caddy router interface, with an in-memory mock for UI work.
- **Login and access**: Discord OAuth2, TOTP two-factor authentication, access levels (`public`, `pending`, `user`, `admin`) enforced centrally, API keys,
  subusers with per-server permissions, rate-limited login and TOTP, emergency login for when Discord is unavailable.
- **Game servers**: Paper, Folia, Fabric, Velocity, generic Java (8 to 25) and generic Node.js templates; live console with backlog, stats every two seconds,
  restart-safe daemon, crash detection with auto-restart and backoff, disk limits with warnings.
- **Minecraft extras**: sleep mode, Velocity network management, Bedrock support through Geyser and Floodgate, plugin and mod search and install from Modrinth and Hangar,
  modpack import, version picker, domains and SRV records for game servers.
- **Files**: file manager with Monaco editor, drag and drop upload, zip and unzip, built-in SFTP authenticated against the panel.
- **Websites**: static, PHP 8.2 to 8.4, Node.js and Adminer templates; per-site networks; MariaDB databases with one user per database; domains with live DNS checks,
  provider-specific help, Cloudflare integration, wildcard certificates; branded status pages; PHP settings; one-click WordPress, Grav and Nextcloud.
- **Operations**: backups to S3 with database dumps and checksums, schedules (restart, command, backup, shell command), per-user quotas,
  automatic image updates with a maintenance window, Discord webhooks and a slash-command bot, activity log.
- **Multi-node**: one-line node join (`install.sh --node-only`), per-node domains, background node monitor, server transfers between nodes including databases.
- **Admin area**: users, servers (suspend, change template, transfer), nodes and allocations, templates editor, settings and branding, S3 targets, DNS providers.
- **Interface**: sidebar layout, light and dark themes, English and Dutch, mobile-friendly, optimistic power controls and performance work (node cache, indexes).
- **Security**: hardened containers, `openat2` path confinement, Ed25519 browser tokens, AES-256-GCM secrets, strict redirects, security headers, an internal security review.
- **Quality**: unit, contract, Docker and end-to-end tests, GitHub Actions workflow running `make check`.
- **Licence**: AGPL-3.0-or-later.
