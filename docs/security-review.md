# Security review

Reviewed on branch `agent/security-review` (base `922e136`), read-only, by reading the code
(no exploits were run against a live system). Scope: authn/authz, daemon, Caddy integration,
secrets, templates, deploy, SSRF/CSRF/CORS. Severity is judged for a panel with mutually
untrusting customers (website/game-server owners and their subusers); admins are trusted.

"Verified" = confirmed by reading the code path end to end. "To verify" = plausible from the code,
not reproduced.

## Summary

| # | Severity | Finding |
|---|---|---|
| 1 | High | Any user with `domain.manage` can use any admin DNS provider (Cloudflare token): rewrite or delete records in every zone of that account, and get wildcard certs |
| 2 | Medium | No rate limit on TOTP verification (only SFTP auth is rate limited) |
| 3 | Medium | `account.setSftpPassword` is allowed with an API key: a restricted key escalates to the user's full rights |
| 4 | Medium | Game servers share the default Docker bridge: no isolation between customers' servers, unrestricted egress to host/LAN |
| 5 | Medium | `servers.activity` is readable by any subuser and exposes IPs and console commands |
| 6 | Low-Medium | Open redirect after login via tab/newline in `redirectTo` (to verify in a browser) |
| 7 | Low | No security headers (CSP, frame-ancestors, HSTS, nosniff) on panel and Caddy |
| 8 | Low | Install containers run as root with default capabilities and the default bridge |
| 9 | Low | SFTP: unlimited pre-auth connections; per-username lockout can be abused; user enumeration not hidden |
| 10 | Low | Cloudflare token stored in plaintext in Caddy config/autosave and `routes.json`, and returned by `GET /api/routes` |
| 11 | Low | Transfer-token `path`/`directory` claims are never enforced by the daemon; tokens travel in the URL |
| 12 | Low | Misc: FIFO in the volume can hang a download goroutine; `NODE_TOKEN` min length 16; default Postgres password fallback; daemon unit has no sandboxing; unauthenticated Minecraft wake-up; no domain ownership verification |
| 13 | Info | Design mismatch: emergency account (password + TOTP) from `docs/ontwerp.md` is not implemented; API rate limiting absent |

## Status

Updated on branch `agent/security-fixes`.

| # | Status |
|---|---|
| 1 | Fixed in 3e02134: only a full admin (session + 2FA) may set `dnsProviderId` (`DNS_PROVIDER_ADMIN_ONLY`); `applyDns` only touches the domain's hostname, `*.hostname` (wildcard) and the Minecraft SRV name, inside a zone that contains the hostname (`nameAllowed`), and refuses hostnames under `PANEL_DOMAIN`/`NODE_DOMAIN` for non-admins. A provider attached by an admin (remove + re-add as admin, as there is no update field for it) can still be applied by the domain's owner. Not done: domain ownership verification (see 12) |
| 2 | Fixed in 6a1b68c: 5 failures / 10 min per user and per IP on `verifyTotp`, `totpEnable`, `totpDisable` (`TOO_MANY_REQUESTS`), a code is accepted only once. Not done: session deletion after N failures, API-key bearer rate limit |
| 3 | Fixed in 808f57d: `setSftpPassword` is `NOT_WITH_API_KEY` and blocked for suspended servers for non-admins |
| 4 | Not fixed (deliberately): needs a per-server game bridge (`panel-game-<uuid>`, role `game-net`) created in `containerConfig`/`ensureGameNetwork`, which interacts with the site network that game servers with an http route already get (`EnsureGameNetwork`), with existing containers (a `NetworkMode` change needs a recreate) and with the parallel `mc-network` work (Velocity backends must stay reachable through the published ip:port, which needs a hairpin test on real Docker). Plan: create the bridge with `enable_icc` default, publish ports as now, migrate on next start, then add DOCKER-USER rules dropping container traffic to the host and private ranges |
| 5 | Fixed in 355d6c3: `servers.activity` returns `ip: null` and empty `metadata` for subusers; owner and full admin see everything. Console commands are still logged in full for the owner (not truncated) |
| 6 | Fixed in 8717edf: `safeRedirect` allows only `^/(?![/\\])` paths without control characters or backslashes, also after (repeated) URL-decoding, and the URL must stay on the same origin |
| 7 | Fixed in 4b42145: `headers()` in `next.config.ts` (CSP with `frame-ancestors 'none'`, jsdelivr for Monaco, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, HSTS). CSP uses `'unsafe-inline'` for scripts (no nonces). Caddy `header` block not added |
| 8 | Not fixed |
| 9 | Not fixed |
| 10 | Partly fixed in 360a16e: the daemon no longer returns `dns_challenge.api_token` from `GET /api/routes[/{host}]` and the PUT response. Token at rest in Caddy config and `routes.json` unchanged |
| 11 | Fixed in 360a16e: the daemon compares the `path`/`directory` claims of transfer tokens with the URL (403 on mismatch; tokens without the claim, such as console JWTs, are still accepted) |
| 12 | Partly: `NODE_TOKEN` minimum 32 and compose without a `POSTGRES_PASSWORD` fallback fixed in 4b42145 (`panel.env.example` still has an example value `panel`, which is a contract file). Rest not fixed |
| 13 | Not fixed (info) |

## Findings

### 1. High: any domain manager can drive the admin's Cloudflare token (verified)

- `apps/web/server/routers/domains.ts:129-132` (`add`), `:48-54` (`routeFor`), `:189-217` (`applyDns`);
  `apps/web/server/lib/cloudflare.ts:74-98` (`setARecord`).
- `domains.add` accepts any `dnsProviderId` and only checks that the row exists. The provider is an
  admin resource (`dnsProviders.*` is `admin`-only in `packages/api/trpc-contract.ts:277`), but ids are
  small integers and there is no ownership or "allowed for this server" check. Web servers always
  have `domainsAllowed`, so every website owner or subuser with `domain.manage` qualifies.
- Exploit: attacker owns a website, calls `domains.add {hostname: "www.company.com", dnsProviderId: 1}`
  with the id of the admin's Cloudflare provider, then `domains.applyDns`. The panel decrypts the
  admin's token and calls `setARecord`, which deletes all `AAAA`/`CNAME` records for that name and
  rewrites/deletes the `A` records to the node IP. Result: DNS takeover of any hostname in any zone the
  token can edit (mail, www, the panel domain itself, if it is in that zone). A wildcard add with the
  same provider additionally makes Caddy request `*.zone` certificates with the admin's token.
- Fix: bind providers to an explicit allow-list (e.g. `dns_providers.allowed_server_ids` or an admin-only
  flag per server) and enforce it in `add`, `update`, `routeFor` and `applyDns`. Minimum: only
  `isFullAdmin` may set `dnsProviderId`/`wildcard`; in `applyDns` refuse names that already have records
  not pointing to this node unless an admin confirms; refuse hostnames equal to or below `PANEL_DOMAIN`/
  `NODE_DOMAIN`. Also add domain ownership verification (a TXT token) before a hostname is accepted,
  see 12.

### 2. Medium: TOTP verification is not rate limited (verified)

- `apps/web/server/routers/auth.ts:46-56` (`verifyTotp`), `apps/web/server/lib/totp.ts:41-46`.
- Only `remote.ts` (SFTP) uses `getLimiter()`. TOTP accepts a 6-digit code in a +/-1 step window
  (3 valid codes of 10^6), unlimited attempts, and a code is valid repeatedly within its window.
  Also `totpDisable` (`:100`) checks a code without a limit. For an attacker holding a Discord session
  (stolen cookie, Discord account takeover), TOTP is the only barrier to `/admin`; about 1 hour at
  100 requests/s for a 50% chance.
- Fix: limiter key `totp:<userId>` (e.g. 5 failures per 15 min, then lockout, plus a per-IP key), apply
  to `verifyTotp`, `totpEnable`, `totpDisable`; store the last accepted time step per user and reject
  reuse; delete the session after N failures. The design doc (`ontwerp.md`) also promises limits on login
  and API; the API-key bearer lookup (`apikey.ts:33`) has none either (keys are 256-bit so this is
  only a DoS/log-noise concern).

### 3. Medium: API key escalation through `setSftpPassword` (verified)

- `apps/web/server/routers/credentials.ts:27-37` (no `forbidApiKey`), `remote.ts:107-139`.
- A key limited to e.g. `files.read` passes `requireServer(..., "files.read")` (the permission set is
  the intersection of key and user). It can set an SFTP password; SFTP auth then grants the user's own
  full permission set (`sftpCandidates` uses the user's rights, not the key's) for that password. A
  leaked read-only key therefore becomes `files.write` (and for an owner: all file rights) over SFTP.
- Fix: call `forbidApiKey(ctx)` in `setSftpPassword` (as for key/TOTP management).

### 4. Medium: no tenant isolation between game servers; open egress (verified)

- `daemon/internal/server/manager.go:65-66` (default `NetworkMode = "bridge"`), `lifecycle.go:50-71`.
- All game containers share the default bridge with inter-container communication enabled. A
  compromised plugin on server A can scan and attack the ports of every other customer's server on the
  node (RCON, query, unauthenticated admin ports, backends behind Velocity). Websites are well isolated
  (per-site network, no shared network with MariaDB), which game servers are not. Containers also have
  unrestricted egress to the docker gateway (host services bound to `0.0.0.0`, e.g. SFTP/Caddy) and the LAN
  (e.g. an S3/backup host).
- Fix: a per-server bridge for games as for sites (`panel-site-<uuid>`, `internal=false`) with published
  ports only; or at least a dedicated user-defined bridge with `com.docker.network.bridge.enable_icc=false`.
  Add host firewall rules (DOCKER-USER chain) dropping container traffic to the host and private ranges.

### 5. Medium: `servers.activity` exposes sensitive data to every subuser (verified)

- `apps/web/server/routers/servers.ts:192-195` (access `"any"`), `activity-query.ts:28`,
  `servers.ts:124-130`.
- A subuser with a single minor right (e.g. `console.read`) sees all server activity with IP addresses of
  the owner and other subusers, SFTP login attempts (`server.sftp.failed` with usernames), file paths, and
  every console command in `metadata.command` (which often contains passwords: `/login`, RCON, `/op`).
- Fix: require `owner`, or return the entries without `ip` and with `metadata` stripped for non-owners;
  do not log full console commands (log length or first token only).

### 6. Low-Medium: open redirect after login (to verify)

- `apps/web/server/discord.ts:14-17` (`safeRedirect`), used at `:29` and `:112-115`.
- The check only looks at the first characters (`//`, `/\`). `redirectTo=/%09/evil.example` decodes to
  `"/\t/evil.example"`, passes, is stored in the state cookie and is sent back as `Location: /<TAB>/evil.example`.
  Browsers strip tab/CR/LF in URL parsing, which makes it `//evil.example`. Expected impact: phishing
  right after a legitimate Discord login. Not tested in a browser.
- Fix: reject any control character, then validate with `new URL(to, "https://x")`: require
  `url.origin === "https://x"` and use `url.pathname + url.search`.

### 7. Low: missing security headers (verified)

- `apps/web/next.config.ts`, `deploy/caddy/Caddyfile`. No `Content-Security-Policy`, `X-Frame-Options`/
  `frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy` or HSTS. The admin UI can be framed
  (clickjacking on actions that need only a click) and an XSS would not be contained. Note that file
  downloads are served by the daemon with `Content-Type: application/octet-stream` and
  `Content-Disposition: attachment`, which is fine.
- Fix: `headers()` in `next.config.ts` (CSP with nonces, `frame-ancestors 'none'`, `nosniff`,
  `Referrer-Policy: same-origin`, HSTS) or a `header` block for `$PANEL_DOMAIN` in the Caddyfile.

### 8. Low: install containers are more privileged than runtime (verified)

- `daemon/internal/server/lifecycle.go:84-100`. `User: 0:0`, no `CapDrop`, writable rootfs, default bridge,
  full egress, runs `Install.Script` from the template with user-controlled variables in the environment
  and the customer's volume mounted. No host escape path was found (the mount is only the server's own
  volume, `no-new-privileges` is set, there is no privileged mode), but root with default capabilities
  (`NET_RAW`, `DAC_OVERRIDE`, `SETUID`, ...) is a larger kernel attack surface during every (re)install,
  which an owner can trigger at will (`servers.reinstall`).
- Fix: `CapDrop ALL` and add back only `CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID` (apk needs these),
  `PidsLimit`, `Tmpfs` for `/tmp`; only run the install container on a network with egress needed
  (it needs internet for apk/curl).
- Install downloads (`templates/game/paper.yaml:116-125`, `java-generic.yaml:75-86`) verify SHA-256 sums,
  but taken from the same API response as the file. Acceptable over TLS; pinning checksums in the template
  would be stronger.

### 9. Low: SFTP hardening (verified)

- `daemon/internal/sftpd/sftpd.go:119-145`, `apps/web/server/remote.ts:155-186`.
- No limit on concurrent unauthenticated connections (30 s handshake deadline only), so one host can hold
  many sockets; the failed-login delay (`FailDelay`) is per connection, and parallel connections are only
  limited by the panel's counters (30 per IP, 10 per username per 10 min). The username counter is keyed
  on the attacker-supplied username: anyone who knows `<name>.<shortId>` can lock the owner out of
  SFTP for 10 minutes by sending 10 bad passwords.
- Fix: cap concurrent connections (global and per IP) with `net.Listener` wrapping; on lockout, apply
  the counter per (username, ip) rather than per username only; consider key-based auth.

### 10. Low: DNS API token at rest and in responses (verified)

- `daemon/proxy/tls.go:78,96` (token inside Caddy's JSON config, autosaved by Caddy to the `caddy_config`
  volume), `daemon/internal/api/routes.go:24-47` (`RouteWithStatus` embeds `Route` with `dns_challenge.api_token`,
  returned by `GET /api/routes` and `/api/routes/{host}`), `routes.json` (0600).
- The token is decrypted from the DB, then stored in plaintext in three more places on the node. Only a
  holder of the node token or root can reach them, so this is defense in depth. Fix: omit `dns_challenge`
  from API responses (`json:"-"` on output, or return `has_dns_challenge: true`), and use a Cloudflare token
  scoped to `Zone.DNS:Edit` for the needed zones only (document this in the admin UI).

### 11. Low: transfer-token claims and URL tokens (verified)

- `daemon/internal/api/files.go:274-317`. The panel puts `path`/`directory` in the token claims "so the
  daemon can see they were not modified" (`apps/web/server/lib/jwt.ts`), but the daemon reads the
  path from the URL and never compares it to the claim, so a token for `files.read` can download any file
  the user may read. No privilege gain (same permission), but the stated design property does not hold.
  Tokens are one-time (`jti` in memory) and expire in 10 min; they appear in Caddy access logs and
  browser history. Fix: compare `claims.Path`/`claims.Directory` to the query values.
- A console JWT (reused for the websocket) has the user's full permissions and is not one-time, so it
  can also be used as an upload/download token once; same user, so harmless.

### 12. Low / hardening notes (verified unless marked)

- `daemon/internal/files/root.go:192-209` `OpenRead` opens with plain `O_RDONLY`; a FIFO created by the
  container user in its volume blocks the daemon goroutine forever on download/read (`O_NONBLOCK` then
  check regular file via `fstat`). Repeated requests exhaust goroutines/fds of the daemon (DoS).
- `apps/web/server/env.ts:32` accepts a `NODE_TOKEN` of 16 chars; the installer generates 64 hex chars,
  but manual installs could be weak. Require >= 32. `deploy/docker-compose.yml` falls back to
  `POSTGRES_PASSWORD=panel`; the DB network is internal, but fail instead of defaulting.
- `deploy/systemd/panel-daemon.service` runs as root (needed for Docker) with only `NoNewPrivileges`; add
  `ProtectSystem=strict` (`ReadWritePaths=/var/lib/panel /run/panel /etc/panel`), `ProtectHome`,
  `PrivateTmp`, `RestrictAddressFamilies`.
- `daemon/internal/mcproto/listener.go`: the sleep listener is well bounded (64 conns total, 4 per IP, 2 KiB
  packets, deadlines), but 16 hosts can occupy all slots and deny wake-up for real players, and any
  anonymous login attempt wakes the server (resource abuse). Consider an optional allow-list/cooldown.
- Hostnames are not ownership-verified (`domains.add`): any user can squat any hostname (`DOMAIN_TAKEN`
  for the real owner) and reserved names under `PANEL_DOMAIN`/`NODE_DOMAIN` are protected only because
  static Caddy routes sort first (`daemon/proxy/caddy.go:341-411`; this is correct, keep the test).
- Archive handling: the zip path has no limit on the number of entries (disk budget still applies; with
  `disk_mb = 0` the budget is unlimited, so a zip bomb can fill the node's disk). Treat `disk_mb = 0` as
  an admin-only choice.
- `apps/web/server/routers/databases.ts:31` returns the first 300 characters of the MariaDB error to the
  user; host/user names can leak for remote database hosts. Return a generic message and log details.
- Disk quota mode `soft` measures at an interval (`server/disk.go`): a container can write quickly between
  measurements; node disk full is possible on a single hostile server. Use `xfs` project quotas when
  available (the daemon already reports `disk_quota_mode`).

### 13. Design mismatch (info)

- `docs/ontwerp.md` describes an emergency account with Argon2id password + mandatory TOTP and audit/dashboard
  notice. Only the `isEmergency` flag exists (`session.ts`, `admin.ts` listing); there is no login route
  for it. Nothing is exploitable now, but note this when implementing: it must have its own strict rate limit
  and must not bypass `checkAccess`.
- Rate limiting on login and API is promised but exists only for SFTP auth (see 2).

## Checked and found OK

- **Access levels** (`packages/api/trpc-builder.ts:68-77`): UNAUTHORIZED/BLOCKED/TOTP_PENDING/NOT_ADMIN/
  TOTP_REQUIRED enforced centrally for every procedure; admin status is read fresh from
  `admin_discord_ids` on each request (`session.ts:73-98`). Input and output are validated with zod.
- **Per-server rights**: every procedure in `routers/{servers,files,databases,domains,subusers,credentials}.ts`
  goes through `requireServer` with the matching permission (or `owner`); `domainById`/`databaseById` resolve the
  server of the row first, so IDOR on ids is closed. API keys never get admin, owner actions are blocked, and
  rights are the intersection with the user's (`servers-data.ts:133-151`). `forbidApiKey` is applied to keys, TOTP,
  logout and sleep settings.
- **Sessions**: 256-bit random token, only SHA-256 stored, HttpOnly, SameSite=Lax, Secure (except `.test` over http),
  blocked users lose sessions. CSRF: state-changing tRPC calls need `application/json` plus the Lax cookie;
  daemon CORS only allows `https://$PANEL_DOMAIN`.
- **Discord OAuth**: random `state` in a path-scoped cookie compared in constant time, fixed redirect URI built from
  `PANEL_DOMAIN`, Discord ID validated as digits, nothing from the profile trusted for authorisation.
- **Test login**: needs `PANEL_INSECURE_TEST_LOGIN=1` and a `.test` `PANEL_DOMAIN`; the panel refuses to start
  otherwise (`env.ts:67`), the route returns 404 when disabled.
- **Node token**: constant-time compare via SHA-256 digests, required on every `/api/*` route except transfer
  endpoints and the websocket (which use JWTs). Remote API in the panel authenticates with the token hash and
  scopes servers to the node (`serverOnNode`).
- **Browser JWT** (`daemon/internal/auth/jwt.go`): algorithm pinned to EdDSA, audience, `exp` required, 10 min
  maximum lifetime enforced by the daemon, `kid` lookup with refresh throttling, server binding checked for
  websocket and transfers, `jti` single use for transfers, websocket subject cannot change on re-auth, permissions
  checked per message (`console.write`, `power`), 64 KiB read limit, origin check.
- **File API**: `openat2(RESOLVE_BENEATH|NO_MAGICLINKS)` from a root fd for every operation, so `..`, absolute
  symlinks and swap races cannot leave the volume; hard links to outside are impossible; uploads use temp files
  plus rename with a byte budget; tar/zip extraction goes through the same root (absolute/`..` names cleaned,
  hard links and special files skipped, zip symlinks ignored, tar symlinks created but only followed inside the root).
  Writes are capped (5 MB read, write limit) and reject when over disk limit; the panel `read` has a size check.
- **SFTP**: password only through the panel, 1 KiB password cap, shortId must match the server, `files.read`
  required and `files.write` enforced per handler, only `session` channels and the `sftp` subsystem, no shell/exec.
- **Container hardening** (`lifecycle.go:47-73`): runs as non-root `UID:GID`, `CapDrop ALL`, `no-new-privileges`,
  read-only rootfs with a `nosuid,nodev` tmpfs, PIDs/memory/CPU limits, `Init`, no privileged mode, no devices,
  no host mounts other than the server's own volume; the API spec has no field for mounts or privileges.
  Cleanup/listing is by both labels (`panel.managed` and `panel.instance`); site-network handling checks labels
  (`site.go:25`); the only foreign object touched is network connect/disconnect of `panel-mariadb`. (Minor: the
  removal of `panel-<uuid>` containers is by name; uuids are random so a collision needs an existing foreign
  container with that exact name.)
- **Caddy**: admin API only on a unix socket; hostnames validated by regex in both panel and daemon before reaching
  Caddy JSON (no injection); upstream container names/networks validated by `plainRe`; static routes cannot be
  overridden by dynamic ones; redirect target normalised and not wildcard; route needs a server that exists on the
  node; tokens are redacted from Caddy logs (`tls.go:174`).
- **Secrets**: AES-256-GCM with random 96-bit IV for TOTP secrets, DNS tokens, DB passwords, node tokens, JWT key;
  Argon2id for SFTP passwords (min 12 chars); API keys stored as SHA-256 of 256-bit tokens; no secrets in the repo,
  fixtures or git history (searched for private keys, tokens, Discord-ID-shaped real data, IPs, real domains); no
  token/password logged in the daemon or panel (`grep` on log calls); error messages from the daemon to the panel
  are truncated.
- **Templates**: user-editable variables have strict `pattern`s (anchored); shell metacharacters are not
  allowed in `JAVA_ARGS`/`NODE_ARGS`/`JAR_FILE`; PHP nginx config denies dotfiles and PHP in uploads, php-fpm
  `security.limit_extensions = .php`, `try_files` guard against path info exploits; sites run read-only as uid 1000.
- **Install script / deploy**: `install.sh` downloads nothing from the network, writes `panel.env` with 0600 in a
  0700 directory via `mktemp`, generates 256-bit secrets with `openssl rand`; compose has no Docker socket mount,
  no privileged containers, `cap_drop: ALL` and read-only rootfs for panel/MariaDB, internal networks for DB/Redis,
  the panel only on `127.0.0.1:3000`, only 80/443 (and 443/udp) published, MariaDB reachable only on internal networks,
  and the panel gets the whole `panel.env` while Caddy gets only the three domain variables.
- **SSRF**: the panel only calls Discord, the Cloudflare API, DNS resolvers 1.1.1.1/8.8.8.8, the registered nodes
  and database hosts; none of those URLs/hosts is settable by non-admins. SQL for customer databases uses
  parameters or a strict `[A-Za-z0-9_]` identifier check (`lib/mariadb.ts:17-22`), name length 48 plus prefix <= 64.
- **SQL**: Drizzle parameterised queries; the one raw `like` in `remote.ts:171` is parameterised and the short id is
  regex-validated to 8 hex characters.
