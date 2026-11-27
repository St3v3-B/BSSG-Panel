# Admin guide

The admin area lives under `/admin`. It is only reachable for accounts that are in the admin list **and**
have two-factor authentication enabled **and** verified it in the current session. This is enforced on the
server for every admin call, not just hidden in the interface.

## Admins

The owner (`OWNER_DISCORD_ID`) is always an admin and cannot be removed. Add or remove other admins under
**Admin, Users**. There is no `is_admin` flag on user rows, so there is nothing to forget to check.

## Dashboard

Shows counts and alerts: emergency login used, node offline, failed installs, failed backups and low disk space.

## Users

- Pre-create accounts by Discord ID, so you can assign a server before the person ever logs in.
- Block users, reset their 2FA, manage admins.
- Set a **quota** per user (total RAM, disk and CPU, number of servers and databases, allowed templates and nodes,
  ports per server). Users with a quota can create their own servers within it. See the usage overview under **Quotas**.

## Servers

Create servers for any user and choose node, template, limits and ports. You can change limits live, change the
owner, ports and variables, suspend a server with a reason, switch its template (optionally reinstalling),
reinstall, delete, or **transfer** it to another node (see [multi-node.md](multi-node.md)). A toggle controls whether a game
server may have domains attached.

## Nodes and allocations

Nodes are the machines running the daemon. Create a node to get a one-time token and a ready-made install command.
Allocations are IP and port ranges per node: `25565`, `25565-25600` or `25565,25570-25575`. Game servers take one or more
allocations; websites need none.

## Templates

Templates are YAML files read from `TEMPLATES_DIR` at startup (format in [`templates/SCHEMA.md`](../templates/SCHEMA.md)).
You can list, create, edit and validate templates in a YAML editor in **Admin, Templates**.

## Settings

- Branding: panel name, logo URL and accent colour.
- Default limits for new servers.
- **Image updates**: a global default policy (`auto`, `notify` or `off`) and a maintenance window. Owners can override the policy per
  server. The daemon checks for new images every `IMAGE_CHECK_INTERVAL` (default 24 hours). With `auto`, an update is applied inside the window.
- Database hosts: the local MariaDB is registered at startup; more hosts can be added and tested.
- **S3 backup targets**: endpoint, bucket, region, path-style and keys. See [backups.md](backups.md).
- **DNS providers**: add a Cloudflare API token and the panel can set records in one click and enable wildcard certificates.
- A Discord webhook for admin-wide notifications.

## Activity log

Every action is logged with user, server and IP. Search by user, server or action.

## Emergency login

For the case that Discord itself is unavailable, the panel has an emergency account with a password and a mandatory
authenticator code. Using it raises an alert on the admin dashboard. Treat it as a break-glass account.

## Backups of the panel itself

The panel database lives in the `panel-postgres-data` volume and server data in `/var/lib/panel`. Back up both, and keep a copy of
`/etc/panel/panel.env`. Without `PANEL_ENCRYPTION_KEY` the encrypted secrets in the database cannot be read.

## Uninstalling

Everything the panel creates carries the labels `panel.managed=true` and `panel.instance=<PANEL_INSTANCE>`. Infrastructure containers have
`panel.role=infra`, server containers `panel.role=server`. Remove the stack with Docker Compose, stop the `panel-daemon` unit and delete
`/var/lib/panel` when you are sure you no longer need the data.
