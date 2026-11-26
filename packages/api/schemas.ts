/**
 * Gedeelde zod-schema's voor het tRPC-contract.
 * Eigenaar: orchestrator. Agents wijzigen dit bestand niet; vraag een wijziging aan.
 */
import { z } from "zod";

// ---------- basis ----------

export const Uuid = z.string().uuid();
export const Id = z.number().int().positive();
/** Discord-ID's zijn snowflakes; altijd als string (te groot voor JS-number). */
export const DiscordId = z.string().regex(/^\d{15,21}$/, "ongeldig Discord-ID");
export const Hostname = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "ongeldige hostnaam");

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

export const ServerDetail = ServerSummary.extend({
  /** Rechten van de ingelogde gebruiker op deze server. */
  permissions: z.array(Permission),
  allocations: z.array(Allocation),
  variables: z.array(ServerVariable),
  node: z.object({ id: Id, name: z.string(), fqdn: z.string() }),
  sftp: z.object({ host: z.string(), port: z.number().int(), username: z.string() }),
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
  targetPort: z.number().int().nullable(), // null = standaardpoort van de webtemplate
  redirectTo: Hostname.nullable(),
  wildcard: z.boolean(),
  dnsProviderId: Id.nullable(),
  sslStatus: SslStatus,
  dnsStatus: DnsStatus,
  lastCheckedAt: z.date().nullable(),
});
export type Domain = z.infer<typeof Domain>;

export const DnsRecordCheck = z.object({
  type: z.enum(["A", "AAAA", "CNAME", "TXT"]),
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
