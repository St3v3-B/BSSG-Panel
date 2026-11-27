/**
 * Gedeelde zod-schema's voor het tRPC-contract.
 * Eigenaar: orchestrator. Agents wijzigen dit bestand niet; vraag een wijziging aan.
 */
import { z } from "zod";

// ---------- basis ----------

export const Uuid = z.string().uuid();
export const Id = z.number().int().positive();
/** Discord-ID's zijn snowflakes; altijd als string (te groot voor JS-number). */
export const DiscordId = z.string().regex(/^\d{15,21}$/, "invalid Discord ID");
export const Hostname = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "invalid host name");

export const Ok = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof Ok>;

export const PageInput = z.object({
  cursor: z.string().nullish(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const ServerRef = z.object({ uuid: Uuid });

// ---------- rechten ----------

/** Rechten van subusers. De eigenaar en admins hebben ze allemaal. */
export const Permission = z.enum([
  "console.read",
  "console.write",
  "files.read",
  "files.write",
  "backup.create",
  "backup.restore",
  "database.manage",
  "domain.manage",
  "schedule.manage",
  "power",
]);
export type Permission = z.infer<typeof Permission>;
export const ALL_PERMISSIONS = Permission.options;

// ---------- gebruikers ----------

export const UserPublic = z.object({
  id: Id,
  discordId: DiscordId,
  name: z.string().nullable(), // null zolang de gebruiker nog nooit heeft ingelogd
  avatarUrl: z.string().url().nullable(),
});
export type UserPublic = z.infer<typeof UserPublic>;

export const Me = z.object({
  user: UserPublic,
  isAdmin: z.boolean(),
  isOwner: z.boolean(), // OWNER_DISCORD_ID
  isEmergency: z.boolean(),
  totpEnabled: z.boolean(),
  /** false = sessie wacht nog op de TOTP-code; alleen `pending`-procedures werken dan. */
  totpVerified: z.boolean(),
});
export type Me = z.infer<typeof Me>;

export const Branding = z.object({
  panelName: z.string(),
  logoUrl: z.string().nullable(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
export type Branding = z.infer<typeof Branding>;

export const AdminUser = UserPublic.extend({
  blocked: z.boolean(),
  isAdmin: z.boolean(),
  totpEnabled: z.boolean(),
  createdAt: z.date(),
  lastLoginAt: z.date().nullable(),
  serverCount: z.number().int(),
});
export type AdminUser = z.infer<typeof AdminUser>;

// ---------- servers ----------

export const ServerType = z.enum(["game", "web"]);
export type ServerType = z.infer<typeof ServerType>;

/**
 * Status zoals het panel hem toont.
 * - installing / install_failed: install-script draait of faalde
 * - offline: container bestaat maar draait niet
 * - starting: container draait, ready-patroon nog niet gezien
 * - online: ready-patroon gezien
 * - stopping: stop-commando verstuurd
 * - disk_exceeded: gestopt wegens disk-limiet; starten geweigerd
 * - unknown: daemon onbereikbaar
 */
export const ServerStatus = z.enum([
  "installing",
  "install_failed",
  "offline",
  "starting",
  "online",
  "stopping",
  "disk_exceeded",
  /** Gestopt door slaapstand; de daemon luistert op de poort en start bij een verbindingspoging. */
  "sleeping",
  "unknown",
]);
export type ServerStatus = z.infer<typeof ServerStatus>;

export const PowerAction = z.enum(["start", "stop", "restart", "kill"]);
export type PowerAction = z.infer<typeof PowerAction>;

export const Limits = z.object({
  /** 100 = één core; 0 = onbeperkt */
  cpuPct: z.number().int().min(0).max(6400),
  ramMb: z.number().int().min(64),
  /** -1 = onbeperkt, 0 = geen swap */
  swapMb: z.number().int().min(-1),
  diskMb: z.number().int().min(0),
});
export type Limits = z.infer<typeof Limits>;

export const Allocation = z.object({
  id: Id,
  nodeId: Id,
  ip: z.ipv4(),
  port: z.number().int().min(1).max(65535),
  serverUuid: Uuid.nullable(),
  primary: z.boolean(),
});
export type Allocation = z.infer<typeof Allocation>;

export const Stats = z.object({
  cpuPct: z.number(), // 100 = één core vol
  memoryBytes: z.number(),
  memoryLimitBytes: z.number(),
  networkRxBytes: z.number(),
  networkTxBytes: z.number(),
  diskBytes: z.number(),
  diskLimitBytes: z.number(),
  uptimeMs: z.number(),
});
export type Stats = z.infer<typeof Stats>;

export const ServerSummary = z.object({
  uuid: Uuid,
  shortId: z.string().length(8), // eerste 8 tekens van de uuid
  name: z.string(),
  type: ServerType,
  status: ServerStatus,
  templateName: z.string(),
  nodeName: z.string(),
  primaryAddress: z.string().nullable(), // "ip:poort" (game) of eerste domein (web)
  limits: Limits,
  isOwner: z.boolean(),
  owner: UserPublic,
  /** Opgeschort door een admin: gestopt, en de eigenaar/subusers mogen niet starten of schrijven. */
  suspended: z.object({ reason: z.string().nullable(), at: z.date() }).nullable().default(null),
});
export type ServerSummary = z.infer<typeof ServerSummary>;

export const ServerVariable = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  value: z.string(),
  default: z.string(),
  userEditable: z.boolean(),
  pattern: z.string().nullable(), // regex waaraan de waarde moet voldoen
});
export type ServerVariable = z.infer<typeof ServerVariable>;

/** Netwerknaam van een backend achter een proxy: kort, voor `[servers]` in velocity.toml. */
export const NetworkName = z.string().regex(/^[a-z0-9-]{1,32}$/);

/** Een backend-server achter een proxy. De standaardserver (eerste in `try`) staat vooraan, `isDefault` is daar true. */
export const NetworkMember = z.object({
  serverUuid: Uuid,
  serverName: z.string(),
  name: NetworkName,
  isDefault: z.boolean(),
  /** "ip:poort" zoals in velocity.toml (0.0.0.0 vervangen door het publieke IP van de node). */
  address: z.string().nullable(),
});
export type NetworkMember = z.infer<typeof NetworkMember>;

/**
 * Minecraft-netwerk van een server. `proxy`: Velocity-server met `members` (op volgorde van `try`) en
 * `connectAddress` (domein of allocation voor spelers). `backend`: lid van de proxy in `proxy`.
 * `none`: geen van beide (ook voor servers die geen proxy of backend kunnen zijn).
 */
export const ServerNetwork = z.object({
  role: z.enum(["none", "proxy", "backend"]),
  members: z.array(NetworkMember),
  proxy: z.object({ uuid: Uuid, name: z.string() }).nullable(),
  connectAddress: z.string().nullable(),
});
export type ServerNetwork = z.infer<typeof ServerNetwork>;

/** Een server die als backend gekozen kan worden; `takenBy` = naam van een andere proxy waar hij al achter hangt. */
export const NetworkCandidate = z.object({
  uuid: Uuid,
  name: z.string(),
  templateName: z.string(),
  address: z.string().nullable(),
  ownerName: z.string().nullable(),
  suggestedName: NetworkName,
  takenBy: z.string().nullable(),
});
export type NetworkCandidate = z.infer<typeof NetworkCandidate>;

/** Uitkomst per betrokken server (proxy en backends) van `updateNetwork`. */
export const NetworkUpdateResult = z.object({
  servers: z.array(z.object({ uuid: Uuid, name: z.string(), role: z.enum(["proxy", "backend", "removed"]), restarted: z.boolean(), error: z.string().nullable() })),
});
export type NetworkUpdateResult = z.infer<typeof NetworkUpdateResult>;

export const ServerDetail = ServerSummary.extend({
  /** Rechten van de ingelogde gebruiker op deze server. */
  permissions: z.array(Permission),
  allocations: z.array(Allocation),
  variables: z.array(ServerVariable),
  node: z.object({ id: Id, name: z.string(), fqdn: z.string() }),
  sftp: z.object({ host: z.string(), port: z.number().int(), username: z.string() }),
  /** Slaapstand (alleen templates met sleep_capable). */
  /** Door een admin aangezet: deze game-server mag domeinen koppelen (web: altijd). */
  domainsAllowed: z.boolean().default(false),
  sleep: z.object({ supported: z.boolean(), enabled: z.boolean(), idleMinutes: z.number().int() }).default({ supported: false, enabled: false, idleMinutes: 10 }),
  /** Minecraft-netwerk (proxy of backend); `role: "none"` voor alle andere servers. */
  network: ServerNetwork.default({ role: "none", members: [], proxy: null, connectAddress: null }),
  installedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type ServerDetail = z.infer<typeof ServerDetail>;

export const ConsoleToken = z.object({
  token: z.string(),
  /** wss://$NODE_DOMAIN/api/servers/{uuid}/ws */
  socketUrl: z.string(),
  expiresAt: z.date(),
});
export type ConsoleToken = z.infer<typeof ConsoleToken>;

export const ActivityEntry = z.object({
  id: Id,
  action: z.string(), // bv. "server.power.start", "auth.login", "admin.server.create"
  user: UserPublic.nullable(),
  serverUuid: Uuid.nullable(),
  serverName: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
  at: z.date(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

// ---------- bestanden ----------

export const FilePath = z.string().min(1).max(4096); // relatief aan /home/container, begint met "/"
export const FileEntry = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  isSymlink: z.boolean(),
  size: z.number(),
  mode: z.string(), // bv. "-rw-r--r--"
  mimeType: z.string(),
  modifiedAt: z.date(),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const SignedUrl = z.object({ url: z.string(), expiresAt: z.date() });

// ---------- domeinen ----------

export const SslStatus = z.enum(["pending", "dns_wrong", "issuing", "active", "failed"]);
export type SslStatus = z.infer<typeof SslStatus>;
export const DnsStatus = z.enum(["unchecked", "missing", "wrong_ip", "cloudflare_proxy", "ok"]);
export type DnsStatus = z.infer<typeof DnsStatus>;

export const Domain = z.object({
  id: Id,
  serverUuid: Uuid,
  hostname: Hostname,
  /**
   * http: via Caddy (HTTPS) naar targetPort in de container (web: null = http_port van de template;
   * game: verplicht, bv. 8123 voor een live-map-plugin).
   * minecraft: geen proxy; DNS-records A + SRV `_minecraft._tcp.<host>` naar de primaire allocation.
   */
  protocol: z.enum(["http", "minecraft"]).default("http"),
  targetPort: z.number().int().nullable(),
  redirectTo: Hostname.nullable(),
  wildcard: z.boolean(),
  dnsProviderId: Id.nullable(),
  sslStatus: SslStatus,
  dnsStatus: DnsStatus,
  lastCheckedAt: z.date().nullable(),
});
export type Domain = z.infer<typeof Domain>;

export const DnsRecordCheck = z.object({
  type: z.enum(["A", "AAAA", "CNAME", "TXT", "SRV"]), // SRV: expected = "0 5 <poort> <doel>"
  name: z.string(), // "@" of "www"
  expected: z.string().nullable(), // null bij AAAA: hoort er niet te zijn
  actual: z.array(z.string()),
  status: z.enum(["missing", "wrong_ip", "cloudflare_proxy", "unexpected", "ok"]),
});
export const DnsCheck = z.object({
  domainId: Id,
  records: z.array(DnsRecordCheck),
  nameservers: z.array(z.string()),
  /** herkende provider, sleutel voor de uitleg in de UI (cloudflare, transip, hostinger, strato, versio, other) */
  provider: z.string(),
  warnings: z.array(z.enum(["cloudflare_proxy", "stale_aaaa", "cname_at_apex"])),
  checkedAt: z.date(),
});
export type DnsCheck = z.infer<typeof DnsCheck>;

// ---------- databases ----------

export const Database = z.object({
  id: Id,
  serverUuid: Uuid,
  hostId: Id,
  hostName: z.string(),
  host: z.string(),
  port: z.number().int(),
  name: z.string(),
  username: z.string(),
  password: z.string(), // ontsleuteld; alleen met database.manage
  adminerUrl: z.string().nullable(),
});
export type Database = z.infer<typeof Database>;

// ---------- one-click apps ----------

export const AppId = z.string().regex(/^[a-z0-9-]{2,32}$/);
export const AppSummary = z.object({
  id: AppId,
  name: z.string(),
  description: z.string(),
  homepage: z.string(),
  requiresDatabase: z.boolean(),
  /** Kan de installatie een beheerder aanmaken (gebruikersnaam + e-mail, gegenereerd wachtwoord)? */
  supportsAdmin: z.boolean(),
  downloadMb: z.number(),
  /** false als de template van deze site het niet aankan (bv. geen PHP). */
  compatible: z.boolean(),
  incompatibleReason: z.string().nullable(),
});
export type AppSummary = z.infer<typeof AppSummary>;

export const AppPreflight = z.object({
  /** public/ bestaat niet of bevat alleen de standaardpagina. */
  publicEmpty: z.boolean(),
  entries: z.number().int(),
});
export type AppPreflight = z.infer<typeof AppPreflight>;

export const AppStepStatus = z.enum(["pending", "running", "done", "failed"]);
export const AppStep = z.object({ key: z.string(), status: AppStepStatus });
export type AppStep = z.infer<typeof AppStep>;

export const AppJobResult = z.object({
  version: z.string(),
  siteUrl: z.string().nullable(),
  adminUrl: z.string().nullable(),
  adminUsername: z.string().nullable(),
  /** Alleen bij de eerste keer dat de afgeronde job wordt opgehaald; daarna null. */
  adminPassword: z.string().nullable(),
  databaseName: z.string().nullable(),
  /** Sleutels voor vervolgstappen in de UI (bv. "finish_in_browser"). */
  notes: z.array(z.string()),
});
export type AppJobResult = z.infer<typeof AppJobResult>;

export const AppJob = z.object({
  id: Id,
  serverUuid: Uuid,
  appId: AppId,
  appName: z.string(),
  status: z.enum(["running", "succeeded", "failed"]),
  steps: z.array(AppStep),
  /** Foutcode (bv. CHECKSUM_MISMATCH, PUBLIC_NOT_EMPTY, DOWNLOAD_FAILED) met uitleg. */
  errorCode: z.string().nullable(),
  error: z.string().nullable(),
  result: AppJobResult.nullable(),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
});
export type AppJob = z.infer<typeof AppJob>;

// ---------- backups ----------

export const BackupStatus = z.enum(["pending", "running", "completed", "failed", "restoring"]);
export const Backup = z.object({
  id: Id,
  serverUuid: Uuid,
  name: z.string(),
  sizeBytes: z.number().nullable(),
  sha256: z.string().nullable(),
  status: BackupStatus,
  includesDatabases: z.boolean(),
  createdAt: z.date(),
  completedAt: z.date().nullable(),
});
export type Backup = z.infer<typeof Backup>;

// ---------- schema's ----------

export const ScheduleAction = z.enum(["restart", "command", "backup"]);
export const Schedule = z.object({
  id: Id,
  serverUuid: Uuid,
  name: z.string(),
  cron: z.string(), // 5 velden, tijdzone Europe/Amsterdam
  action: ScheduleAction,
  payload: z.string().nullable(), // commando bij action=command
  active: z.boolean(),
  lastRunAt: z.date().nullable(),
  nextRunAt: z.date().nullable(),
  lastResult: z.string().nullable(),
});
export type Schedule = z.infer<typeof Schedule>;

export const ScheduleInput = z.object({
  name: z.string().min(1).max(100),
  cron: z.string().min(9).max(100),
  action: ScheduleAction,
  payload: z.string().max(1000).nullable(),
  active: z.boolean(),
});

// ---------- subusers ----------

export const Subuser = z.object({
  user: UserPublic,
  permissions: z.array(Permission),
  createdAt: z.date(),
});
export type Subuser = z.infer<typeof Subuser>;

// ---------- account ----------

export const ApiKey = z.object({
  id: Id,
  name: z.string(),
  prefix: z.string(), // eerste 8 tekens, om de sleutel te herkennen
  permissions: z.array(Permission),
  lastUsedAt: z.date().nullable(),
  expiresAt: z.date().nullable(),
  createdAt: z.date(),
});
export type ApiKey = z.infer<typeof ApiKey>;

// ---------- admin ----------

export const DiskQuotaMode = z.enum(["soft", "xfs"]);
export const Node = z.object({
  id: Id,
  name: z.string(),
  fqdn: z.string(),
  daemonPort: z.number().int(),
  sftpPort: z.number().int(),
  maxRamMb: z.number().int(),
  maxDiskMb: z.number().int(),
  s3TargetId: Id.nullable(),
  diskQuotaMode: DiskQuotaMode.nullable(), // null = nog nooit verbonden
  isLocal: z.boolean(), // de node uit NODE_DOMAIN
});
export type Node = z.infer<typeof Node>;

export const NodeInput = z.object({
  name: z.string().min(1).max(100),
  fqdn: z.string().min(1).max(253),
  daemonPort: z.number().int().default(8080),
  sftpPort: z.number().int().default(2022),
  maxRamMb: z.number().int().min(0),
  maxDiskMb: z.number().int().min(0),
  s3TargetId: Id.nullable().default(null),
});

export const NodeHealth = z.object({
  nodeId: Id,
  online: z.boolean(),
  version: z.string().nullable(),
  diskQuotaMode: DiskQuotaMode.nullable(),
  cpuCount: z.number().int().nullable(),
  memoryTotalBytes: z.number().nullable(),
  memoryUsedBytes: z.number().nullable(),
  diskTotalBytes: z.number().nullable(),
  diskFreeBytes: z.number().nullable(),
  serverCount: z.number().int(),
  error: z.string().nullable(),
});
export type NodeHealth = z.infer<typeof NodeHealth>;

export const TemplateVariable = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  name: z.string(),
  description: z.string().nullable(),
  default: z.string(),
  userEditable: z.boolean(),
  pattern: z.string().nullable(),
});

export const TemplateSummary = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  type: ServerType,
  version: z.number().int(),
  description: z.string().nullable(),
  serverCount: z.number().int(),
});
export type TemplateSummary = z.infer<typeof TemplateSummary>;
export const TemplateDetail = TemplateSummary.extend({
  yaml: z.string(), // bron, zie templates/SCHEMA.md
  variables: z.array(TemplateVariable),
});
export type TemplateDetail = z.infer<typeof TemplateDetail>;

export const DatabaseHost = z.object({
  id: Id,
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  adminUser: z.string(),
  nodeId: Id.nullable(),
  databaseCount: z.number().int(),
});
export const DatabaseHostInput = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().default(3306),
  adminUser: z.string().min(1),
  adminPassword: z.string().min(1), // bij update: weglaten = ongewijzigd
  nodeId: Id.nullable(),
});

export const S3Target = z.object({
  id: Id,
  name: z.string(),
  endpoint: z.string().url(),
  bucket: z.string(),
  region: z.string(),
  pathStyle: z.boolean(),
  accessKeyPreview: z.string(), // alleen de eerste 4 tekens
});
export const S3TargetInput = z.object({
  name: z.string().min(1),
  endpoint: z.string().url(),
  bucket: z.string().min(1),
  region: z.string().default("us-east-1"),
  pathStyle: z.boolean().default(true),
  accessKey: z.string().min(1),
  secretKey: z.string().min(1),
});

export const DnsProvider = z.object({
  id: Id,
  type: z.literal("cloudflare"),
  name: z.string(),
  zones: z.array(z.object({ id: z.string(), name: z.string() })),
});

/** Alleen echte Discord-webhooks (https://discord.com|discordapp.com/api[/vN]/webhooks/<id>/<token>). */
export const DISCORD_WEBHOOK_RE = /^https:\/\/(?:discord|discordapp)\.com\/api(?:\/v\d+)?\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,200}$/;
export const WebhookUrl = z.string().trim().max(300).regex(DISCORD_WEBHOOK_RE, "INVALID_WEBHOOK_URL");

/** Nooit de volledige URL teruggeven (het token zit erin): alleen of hij gezet is en een hint. */
export const WebhookStatus = z.object({ set: z.boolean(), hint: z.string().nullable() });
export type WebhookStatus = z.infer<typeof WebhookStatus>;

export const ServerNotifications = z.object({
  webhook: WebhookStatus,
  autoRestart: z.boolean(),
  /** Max herstarts per 10 minuten (1-20). */
  autoRestartMax: z.number().int().min(1).max(20),
});
export type ServerNotifications = z.infer<typeof ServerNotifications>;

export const Settings = Branding.extend({
  defaultLimits: Limits,
});
export type Settings = z.infer<typeof Settings>;

export const DashboardAlert = z.object({
  kind: z.enum(["emergency_login", "node_offline", "install_failed", "backup_failed", "disk_low"]),
  message: z.string(),
  at: z.date(),
  serverUuid: Uuid.nullable(),
  nodeId: Id.nullable(),
});

// ---------- Minecraft: plugins, mods, modpacks, versiekiezer ----------

export const ContentSource = z.enum(["modrinth", "hangar"]);
export type ContentSource = z.infer<typeof ContentSource>;
/** Plugin (`plugins/`) of mod (`mods/`). */
export const ContentKind = z.enum(["plugin", "mod"]);
export type ContentKind = z.infer<typeof ContentKind>;

/** Wat een server voor plugins/mods ondersteunt (afgeleid van template en variabelen). `supported: false` = geen tabblad. */
export const ContentInfo = z.object({
  supported: z.boolean(),
  kind: ContentKind.nullable(),
  /** Map in de serverroot: `/plugins` of `/mods`. */
  directory: z.string().nullable(),
  /** Modrinth-loaders waarop gefilterd wordt (bv. paper, spigot, bukkit of fabric). */
  loaders: z.array(z.string()),
  sources: z.array(ContentSource),
  /** Minecraft-versie van de server (`latest` is al omgezet); null voor een proxy. */
  gameVersion: z.string().nullable(),
  /** Modpacks (.mrpack) importeren kan alleen op Fabric. */
  modpacks: z.boolean(),
});
export type ContentInfo = z.infer<typeof ContentInfo>;

export const ContentHit = z.object({
  source: ContentSource,
  /** Modrinth: project-id; Hangar: slug. */
  projectId: z.string(),
  name: z.string(),
  description: z.string(),
  author: z.string(),
  downloads: z.number().int(),
  iconUrl: z.string().nullable(),
  /** Pagina op de bronsite. */
  url: z.string(),
});
export type ContentHit = z.infer<typeof ContentHit>;

export const ContentSearchResult = z.object({ hits: z.array(ContentHit), total: z.number().int() });
export type ContentSearchResult = z.infer<typeof ContentSearchResult>;

export const ContentDependency = z.object({
  projectId: z.string(),
  name: z.string(),
  /** Al op de server geïnstalleerd (via het panel). */
  installed: z.boolean(),
});
export type ContentDependency = z.infer<typeof ContentDependency>;

/** Nieuwste compatibele versie van een project plus de verplichte afhankelijkheden. */
export const ContentResolved = z.object({
  hit: ContentHit,
  versionId: z.string(),
  versionNumber: z.string(),
  filename: z.string(),
  size: z.number().int(),
  dependencies: z.array(ContentDependency),
});
export type ContentResolved = z.infer<typeof ContentResolved>;

export const InstalledContent = z.object({
  id: Id,
  source: ContentSource,
  projectId: z.string(),
  name: z.string(),
  versionId: z.string(),
  versionNumber: z.string(),
  filename: z.string(),
  kind: ContentKind,
  installedAt: z.date(),
});
export type InstalledContent = z.infer<typeof InstalledContent>;

export const ContentUpdate = z.object({ id: Id, versionId: z.string(), versionNumber: z.string() });
export type ContentUpdate = z.infer<typeof ContentUpdate>;

export const ModpackSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("modrinth"), projectId: z.string().min(1).max(64), versionId: z.string().min(1).max(64).optional() }),
  /** Een `.mrpack` dat al in de bestanden van de server staat (max 5 MB; groter: kies de Modrinth-bron). */
  z.object({ type: z.literal("file"), path: FilePath }),
]);
export type ModpackSource = z.infer<typeof ModpackSource>;

export const ModpackResult = z.object({
  name: z.string(),
  minecraftVersion: z.string(),
  loaderVersion: z.string().nullable(),
  filesInstalled: z.number().int(),
  /** Bestanden die voor clients zijn (`server: unsupported`) en dus overgeslagen zijn. */
  filesSkipped: z.number().int(),
  overridesApplied: z.number().int(),
  reinstalled: z.boolean(),
});
export type ModpackResult = z.infer<typeof ModpackResult>;

export const VersionOption = z.object({ id: z.string(), stable: z.boolean() });
/** Beschikbare versies voor de versiekiezer (uit PaperMC Fill of Fabric meta, een uur gecachet). */
export const VersionOptions = z.object({
  /** Variabelen die de kiezer vervangt; leeg = geen kiezer (andere template). */
  variables: z.object({ version: z.string().nullable(), build: z.string().nullable(), loader: z.string().nullable() }),
  versions: z.array(VersionOption),
  /** Builds van `minecraftVersion` (nieuwste eerst), Paper/Folia/Velocity. */
  builds: z.array(z.string()),
  /** Loader-versies (nieuwste eerst), Fabric. */
  loaderVersions: z.array(VersionOption),
});
export type VersionOptions = z.infer<typeof VersionOptions>;
// ---------- quota's ----------

/** Quotum per gebruiker. Geen quotum = de gebruiker kan zelf geen servers maken. null bij lijsten = alles toegestaan. */
export const QuotaInput = z.object({
  /** Som van ramMb over alle eigen servers. */
  maxRamMb: z.number().int().min(0),
  maxDiskMb: z.number().int().min(0),
  /** Som van cpuPct (100 = één core). Servers van quotum-gebruikers hebben altijd een CPU-limiet > 0. */
  maxCpuPct: z.number().int().min(0),
  maxServers: z.number().int().min(0),
  maxDatabases: z.number().int().min(0),
  templateIds: z.array(Id).nullable(),
  nodeIds: z.array(Id).nullable(),
  /** Poorten per game-server; null = geen aparte grens (alleen wat vrij is). */
  maxPortsPerServer: z.number().int().min(1).max(100).nullable(),
});
export type QuotaInput = z.infer<typeof QuotaInput>;

export const QuotaUsage = z.object({
  ramMb: z.number().int(),
  diskMb: z.number().int(),
  cpuPct: z.number().int(),
  servers: z.number().int(),
  databases: z.number().int(),
});
export type QuotaUsage = z.infer<typeof QuotaUsage>;

export const QuotaOverview = z.object({
  quota: QuotaInput,
  usage: QuotaUsage,
  /** Templates en nodes waaruit de gebruiker mag kiezen (al gefilterd op het quotum). */
  templates: z.array(z.object({ id: Id, name: z.string(), type: ServerType })),
  nodes: z.array(z.object({ id: Id, name: z.string() })),
});
export type QuotaOverview = z.infer<typeof QuotaOverview>;

export const UserQuotaUsage = z.object({
  user: UserPublic,
  quota: QuotaInput.nullable(),
  usage: QuotaUsage,
});
export type UserQuotaUsage = z.infer<typeof UserQuotaUsage>;

/** Eigen limieten van een server (zonder swap: die staat voor quotum-gebruikers op 0). */
export const OwnLimits = z.object({
  cpuPct: z.number().int().min(1).max(6400),
  ramMb: z.number().int().min(64),
  diskMb: z.number().int().min(64),
});
export type OwnLimits = z.infer<typeof OwnLimits>;
