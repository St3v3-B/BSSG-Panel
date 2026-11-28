# Backups and schedules

## S3 targets

Backups go to S3-compatible storage (AWS S3, MinIO, Backblaze B2, Cloudflare R2 and similar). An admin adds a target under **Admin,
Settings** with endpoint URL, bucket, region, path-style on or off, access key and secret key, and can run a connection test. A default target
can be chosen per node. Keys are stored encrypted.

## Two kinds of backup

| | Full | Incremental |
|---|---|---|
| Format | One `tar.zst` object per backup (`servers/<uuid>/<id>.tar.zst`) | A [restic](https://restic.net) snapshot in one repository per server (`s3:<endpoint>/<bucket>/restic/<uuid>`) |
| Speed and size | Reads and uploads everything every time | Only changed data is uploaded (deduplicated, compressed) |
| Checksum | SHA-256 of the archive, checked on restore | restic checks every blob it reads |
| Download | Yes, through a one-time link | No |
| Restore | Whole server | Whole server, or selected files and folders |
| Cleanup | Maximum number of backups per server (oldest goes first) | Retention policy per server (see below) |

Full is the default and works exactly as before. Incremental is meant for large worlds that should be backed up often (for example every
hour). Both kinds go to the same S3 targets and can be mixed on one server.

The kind is chosen per backup (the **Type** field on the Backups tab), per schedule (the backup type of a `backup` schedule) or as the
server default under **Backup settings** (used when nothing else is chosen).

## Creating and restoring

On the **Backups** tab of a server:

- **Create** a backup, optionally including the server's databases (they are dumped with `mariadb-dump`; in an incremental snapshot they
  are stored under `/_databases/<name>.sql`).
- Every backup shows its kind, size and status; a full backup also its SHA-256 checksum, an incremental one its snapshot id and how much new
  data it added to the repository. A failed backup shows its reason and triggers a notification.
- **Restore** needs the `backup.restore` permission. A full restore stops the server, unpacks into a temporary folder, swaps the data and then
  restores the databases. If anything fails before the swap, the current files stay untouched; if a database fails, the old files come back.
- **Browse files** (incremental only): open folders of a snapshot, tick files and folders and restore them either to their **original
  location** (overwrites those paths, other files stay) or into a new folder **`/restore-<date>/`** in the server root. The server keeps
  running. Paths always stay inside the server's files, also through symlinks. When the server is over its disk limit, this is refused.
- **Download** a full backup through a one-time link.
- You can delete backups by hand; for an incremental backup this removes the snapshot (`restic forget`); the data is freed at the next prune.

## Incremental backups in detail

- **Repository and password.** Every server gets its own restic repository with its own random password. The panel stores the password
  encrypted (`server_backup_settings.restic_password_enc`) and sends it to the node with each operation; it never appears in logs or error
  messages. The S3 target is fixed at the first incremental backup, so the snapshots stay reachable when the node's default target changes.
  Moving a server to another node (transfer) does not involve backups; the repository is keyed by the server uuid and keeps working on the
  new node.
- **How restic runs.** The node daemon runs the official restic image (pinned by version and digest) as a short-lived container:
  uid 1000, no capabilities, read-only root filesystem, the server's files mounted read-only, on the server's own network
  (`panel-site-<uuid>`) for S3 access. It carries the labels of a temporary container (`panel.role=install`) and is named
  `panel-<uuid>-restic-<hex>`. A restic cache per server is kept in `$DATA_DIR/cache/restic/<uuid>`.
- **Retention.** After each incremental backup the node runs `restic forget` with the server's policy: keep the last *N* snapshots, one per
  day for *D* days and one per week for *W* weeks (defaults 10 / 7 / 4; at least one must be above zero). Snapshots that are forgotten
  disappear from the list. `restic prune`, which actually frees space, runs with it at most once a day.
- **One operation at a time.** A node runs one backup or restore per server at a time (full and incremental together). A stale lock (for
  example from an interrupted container) is removed automatically when the repository turns out to be locked.
- **Progress** is shown live, like for full backups (`backup_progress`), and can be cancelled while uploading or downloading.
- The plan limit "maximum backups" counts full backups only; incremental snapshots are bounded by the retention policy.

## Schedules

The **Schedules** tab runs tasks on a cron expression (five fields, timezone `Europe/Amsterdam`).

| Action | What it does |
|---|---|
| `restart` | Restart the server |
| `command` | Send a console command (game servers) |
| `backup` | Create a backup: full, incremental or the server default |
| `exec` | Run a shell command in a website container; the last 4 KiB of output is kept |

You can run any schedule immediately with **Run now**.
