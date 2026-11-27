# Backups and schedules

## S3 targets

Backups go to S3-compatible storage (AWS S3, MinIO, Backblaze B2, Cloudflare R2 and similar). An admin adds a target under **Admin,
Settings** with endpoint URL, bucket, region, path-style on or off, access key and secret key, and can run a connection test. A default target
can be chosen per node. Keys are stored encrypted.

## Creating and restoring

On the **Backups** tab of a server:

- **Create** a backup, optionally including the server's databases (they are dumped with `mariadb-dump`).
- Every backup has a size and SHA-256 checksum. A failed backup shows its reason and triggers a notification.
- **Restore** needs the `backup.restore` permission. The checksum is recorded when the backup is made and checked again on restore.
- **Download** a backup through a one-time link.
- Delete backups you no longer need.

## Schedules

The **Schedules** tab runs tasks on a cron expression (five fields, timezone `Europe/Amsterdam`).

| Action | What it does |
|---|---|
| `restart` | Restart the server |
| `command` | Send a console command (game servers) |
| `backup` | Create a backup |
| `exec` | Run a shell command in a website container; the last 4 KiB of output is kept |

You can run any schedule immediately with **Run now**.
