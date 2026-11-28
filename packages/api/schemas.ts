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

/** Resultaat van auth.verifyTotp: bij een herstelcode het aantal overgebleven codes (anders null). */
export const VerifyTotpResult = z.object({ ok: z.literal(true), recoveryCodesLeft: z.number().int().nullable() });
export const RecoveryCodes = z.object({ recoveryCodes: z.array(z.string()) });
export const RecoveryStatus = z.object({ remaining: z.number().int(), total: z.number().int() });
export const SessionInfo = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.date(),
  lastSeenAt: z.date(),
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

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
  /** `bedrock` = de UDP-poort van Geyser (zie servers.bedrock); anders gewoon een game-poort. */
  role: z.enum(["game", "bedrock"]).default("game"),
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

/** Periode voor `servers.statsHistory`. */
export const StatsRange = z.enum(["1h", "24h", "7d", "30d"]);
export type StatsRange = z.infer<typeof StatsRange>;

/**
 * Eén stap in de verbruiksgeschiedenis. Alle meetwaarden null = geen meting (server uit of node
 * onbereikbaar): de grafiek toont dan een gat. Gemiddelden over de stap, plus de piek van CPU/RAM.
 */
export const StatsPoint = z.object({
  t: z.date(), // begin van de stap
  cpuPct: z.number().nullable(), // 100 = één core vol
  cpuMaxPct: z.number().nullable(),
  memoryBytes: z.number().nullable(),
  memoryMaxBytes: z.number().nullable(),
  diskBytes: z.number().nullable(),
  rxBytesPerSec: z.number().nullable(),
  txBytesPerSec: z.number().nullable(),
});
export type StatsPoint = z.infer<typeof StatsPoint>;

export const StatsHistory = z.object({
  range: StatsRange,
  stepSeconds: z.number().int().positive(),
  from: z.date(),
  to: z.date(),
  /** Huidige limieten (0 = onbeperkt), voor een limietlijn in de grafiek. */
  cpuLimitPct: z.number(),
  memoryLimitBytes: z.number(),
  diskLimitBytes: z.number(),
  /** Op volgorde, elke stap precies één keer (dus ook de gaten). */
  points: z.array(StatsPoint),
});
export type StatsHistory = z.infer<typeof StatsHistory>;

/** Compacte reeks voor de serverkaarten: de laatste 60 minuten per minuut, null = geen meting. */
export const StatsSparkline = z.object({
  cpuPct: z.array(z.number().nullable()),
  memoryBytes: z.array(z.number().nullable()),
});
export type StatsSparkline = z.infer<typeof StatsSparkline>;

/** Beleid voor image-updates (zie docs bij `servers.updateImagePolicy`). */
export const ImagePolicy = z.enum(["auto", "notify", "off"]);
export type ImagePolicy = z.infer<typeof ImagePolicy>;

export const ImageUpdateInfo = z.object({
  /** Keuze van de eigenaar; null = het globale standaardbeleid. */
  policy: ImagePolicy.nullable(),
  /** Het beleid dat geldt (eigen keuze of globale standaard). */
  effectivePolicy: ImagePolicy,
  /** De draaiende container gebruikt een oudere image dan de lokaal opgehaalde. */
  available: z.boolean(),
  /** De nieuwe image heeft een andere PHP-minor (of vergelijkbaar): eerst herinstalleren, dus alleen melden. */
  reinstallRequired: z.boolean(),
  checkedAt: z.date().nullable(),
});
export type ImageUpdateInfo = z.infer<typeof ImageUpdateInfo>;

export const ServerSummary = z.object({
  uuid: Uuid,
  shortId: z.string().length(8), // eerste 8 tekens van de uuid
  name: z.string(),
  type: ServerType,
  status: ServerStatus,
  templateName: z.string(),
  /** Slug van de template (bv. "paper"); voor logica in de UI, `templateName` is alleen weergave. */
  templateSlug: z.string(),
  nodeName: z.string(),
  primaryAddress: z.string().nullable(), // "ip:poort" (game) of eerste domein (web)
  limits: Limits,
  isOwner: z.boolean(),
  owner: UserPublic,
  /** Opgeschort door een admin: gestopt, en de eigenaar/subusers mogen niet starten of schrijven. */
  suspended: z.object({ reason: z.string().nullable(), at: z.date() }).nullable().default(null),
  imageUpdate: ImageUpdateInfo.default({ policy: null, effectivePolicy: "notify", available: false, reinstallRequired: false, checkedAt: null }),
  /** Wanneer de node de status voor het laatst bevestigde (achtergrondmonitor). null = onbekend/nooit. */
  lastSeenAt: z.date().nullable().optional(),
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

/** Hostnaam voor een Velocity forced host: kleine letters, geen wildcard, minstens één punt. */
export const ForcedHostname = z
  .string()
  .min(3)
  .max(253)
  .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "invalid host name");

/** Forced host: spelers die via `hostname` verbinden komen op backend `serverUuid` (een lid van het netwerk). */
export const ForcedHost = z.object({ hostname: ForcedHostname, serverUuid: Uuid });
export type ForcedHost = z.infer<typeof ForcedHost>;

/**
 * Minecraft-netwerk van een server. `proxy`: Velocity-server met `members` (op volgorde van `try`) en
 * `connectAddress` (domein of allocation voor spelers). `backend`: lid van de proxy in `proxy`.
 * `none`: geen van beide (ook voor servers die geen proxy of backend kunnen zijn).
 * Alleen bij `proxy`: `forcedHosts` (`[forced-hosts]` in velocity.toml) en `forcedHostSuggestions`
 * (minecraft-domeinen van de proxy en zijn leden; `serverUuid` = de server waar het domein aan hangt).
 */
export const ServerNetwork = z.object({
  role: z.enum(["none", "proxy", "backend"]),
  members: z.array(NetworkMember),
  proxy: z.object({ uuid: Uuid, name: z.string() }).nullable(),
  connectAddress: z.string().nullable(),
  forcedHosts: z.array(ForcedHost).default([]),
  forcedHostSuggestions: z.array(z.object({ hostname: z.string(), serverUuid: Uuid })).default([]),
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

/** Uitkomst per betrokken server (proxy en backends) van `updateNetwork`. `reloaded`: proxy kreeg `velocity reload` i.p.v. een herstart. */
export const NetworkUpdateResult = z.object({
  servers: z.array(z.object({ uuid: Uuid, name: z.string(), role: z.enum(["proxy", "backend", "removed"]), restarted: z.boolean(), reloaded: z.boolean(), error: z.string().nullable() })),
});
export type NetworkUpdateResult = z.infer<typeof NetworkUpdateResult>;

/**
 * Bedrock-toegang (Geyser + Floodgate) voor Java-servers. `mode`: `standalone` (Paper/Folia), `proxy`
 * (Velocity: Geyser + Floodgate op de proxy, Floodgate op de backends) of `backend` (hangt achter een
 * proxy: Bedrock loopt via de proxy, hier niets te schakelen). `supported` = false voor andere templates
 * en voor backends. `address`/`port` = wat Bedrock-spelers invullen (UDP).
 */
export const BedrockStatus = z.object({
  supported: z.boolean(),
  mode: z.enum(["standalone", "proxy", "backend"]),
  enabled: z.boolean(),
  address: z.string().nullable(),
  port: z.number().int().nullable(),
  allocationId: Id.nullable(),
  /** Vrije allocations op de node (zelfde IP als de primaire poort) die als Bedrock-poort kunnen. */
  freeAllocations: z.array(z.object({ id: Id, ip: z.ipv4(), port: z.number().int() })),
});
export type BedrockStatus = z.infer<typeof BedrockStatus>;

export const ServerDetail = ServerSummary.extend({
  /** Rechten van de ingelogde gebruiker op deze server. */
  permissions: z.array(Permission),
  allocations: z.array(Allocation),
  variables: z.array(ServerVariable),
  node: z.object({ id: Id, name: z.string(), fqdn: z.string(), supportsDomains: z.boolean() }),
  sftp: z.object({ host: z.string(), port: z.number().int(), username: z.string() }),
  /** Slaapstand (alleen templates met sleep_capable). */
  /** Door een admin aangezet: deze game-server mag domeinen koppelen (web: altijd). */
  domainsAllowed: z.boolean().default(false),
  sleep: z.object({ supported: z.boolean(), enabled: z.boolean(), idleMinutes: z.number().int() }).default({ supported: false, enabled: false, idleMinutes: 10 }),
  /** Minecraft-netwerk (proxy of backend); `role: "none"` voor alle andere servers. */
  network: ServerNetwork.default({ role: "none", members: [], proxy: null, connectAddress: null, forcedHosts: [], forcedHostSuggestions: [] }),
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

/** Octale modus voor files.chmod: "644", "0755"; een vierde cijfer (setuid/setgid/sticky) alleen met allowSpecial. */
export const FileMode = z.string().regex(/^[0-7]{3,4}$/);
export const ArchiveFormat = z.enum(["zip", "tar.gz"]);
export type ArchiveFormat = z.infer<typeof ArchiveFormat>;
export const FileSearchHit = z.object({
  entry: FileEntry,
  /** Alleen bij zoeken op inhoud: gevonden regels (max 5 per bestand). */
  matches: z.array(z.object({ line: z.number().int(), text: z.string() })),
});
export type FileSearchHit = z.infer<typeof FileSearchHit>;
export const FileSearchResult = z.object({
  results: z.array(FileSearchHit),
  /** Meer resultaten dan de limiet. */
  truncated: z.boolean(),
  /** De daemon stopte na zijn tijdslimiet (10 s); onvolledig. */
  timedOut: z.boolean(),
});
export type FileSearchResult = z.infer<typeof FileSearchResult>;

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

/** Zichtbaarheid en doel van de phpMyAdmin-koppeling (zijbalk en databasescherm). */
export const PhpMyAdminInfo = z.object({
  /** Gebruiker heeft databases op een node met daemon-beheerde MariaDB (elke node), of is volledige admin. */
  visible: z.boolean(),
  /**
   * Gebruiker heeft ook databases op een externe database-host (niet door een daemon beheerd); die staan niet in
   * phpMyAdmin. Databases op remote nodes staan er wel in (één server per node), dus dit is normaal false.
   */
  hasRemoteDatabases: z.boolean(),
  /** Database-hosts (id's, zie `Database.hostId`) waarvan de databases in phpMyAdmin staan. */
  hostIds: z.array(z.number().int()).default([]),
});
export type PhpMyAdminInfo = z.infer<typeof PhpMyAdminInfo>;

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
  error: z.string().nullable(), // reden bij status failed
  createdAt: z.date(),
  completedAt: z.date().nullable(),
});
export type Backup = z.infer<typeof Backup>;

/** Live voortgang van een lopende backup of herstel (BackupProgress van de daemon). */
export const BackupPhase = z.enum(["preparing", "dumping", "archiving", "stopping", "downloading", "applying", "finishing", "done", "failed", "cancelled"]);
export type BackupPhase = z.infer<typeof BackupPhase>;
export const BackupProgress = z.object({
  backupId: Id,
  operation: z.enum(["backup", "restore"]),
  phase: BackupPhase,
  /** Verwerkt in deze fase (brondata bij een backup, gedownload bij een herstel). */
  bytes: z.number(),
  /** 0 = onbekend */
  totalBytes: z.number(),
  percent: z.number().min(0).max(100),
  /** Geschatte resterende seconden; null = onbekend. */
  etaSeconds: z.number().nullable(),
  startedAt: z.date(),
  cancellable: z.boolean(),
});
export type BackupProgress = z.infer<typeof BackupProgress>;

// ---------- schema's ----------

export const ScheduleAction = z.enum(["restart", "command", "backup", "exec"]);
export const Schedule = z.object({
  id: Id,
  serverUuid: Uuid,
  name: z.string(),
  cron: z.string(), // 5 velden, tijdzone Europe/Amsterdam
  action: ScheduleAction,
  payload: z.string().nullable(), // commando bij action=command of exec
  active: z.boolean(),
  lastRunAt: z.date().nullable(),
  nextRunAt: z.date().nullable(),
  lastResult: z.string().nullable(),
  /** Laatste 4 KiB uitvoer van de laatste run (alleen action=exec). */
  lastOutput: z.string().nullable(),
});
export type Schedule = z.infer<typeof Schedule>;

export const ScheduleInput = z.object({
  name: z.string().min(1).max(100),
  cron: z.string().min(9).max(100),
  action: ScheduleAction,
  payload: z.string().max(1000).nullable(),
  active: z.boolean(),
});

// ---------- website-instellingen (PHP) ----------

export const PhpExtension = z.enum(["gd", "intl", "exif", "mysqli"]);
export const PhpSettings = z.object({
  /** memory_limit in MB; maximaal het RAM-limiet van de site. */
  memoryLimitMb: z.number().int().min(32).max(32768),
  /** upload_max_filesize = post_max_size = nginx client_max_body_size, in MB. */
  uploadMaxMb: z.number().int().min(1).max(4096),
  maxExecutionTime: z.number().int().min(1).max(300),
  maxInputVars: z.number().int().min(100).max(100000),
  displayErrors: z.boolean(),
  /** IANA-naam, bv. Europe/Amsterdam. */
  timezone: z.string().min(1).max(64),
  opcache: z.boolean(),
  /** Door de template gebouwde extensies die uit staan. */
  disabledExtensions: z.array(PhpExtension),
});
export type PhpSettings = z.infer<typeof PhpSettings>;

export const PhpSettingsInfo = z.object({
  /** Effectieve waarden: de beheerde ini, anders de standaardwaarden van de template. */
  settings: PhpSettings,
  defaults: PhpSettings,
  /** Het beheerde bestand (php/00-panel.ini) bestaat. */
  managed: z.boolean(),
  /** RAM-limiet van de site (MB): bovengrens voor memory_limit. */
  ramLimitMb: z.number().int(),
  extensions: z.array(PhpExtension),
});
export type PhpSettingsInfo = z.infer<typeof PhpSettingsInfo>;

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
  /** Websites en domeinen voor gameservers toegestaan op deze node. */
  supportsDomains: z.boolean(),
  /** Poort van https://<fqdn> (console/uploads); 443 als supportsDomains. */
  publicPort: z.number().int(),
  publicIp: z.string().nullable(),
  joinState: z.lazy(() => NodeJoinState).nullable(),
  /** HTTP(S)-relay: null = eigen 80/443; anders loopt alle HTTP(S) (sites, domeinen, node-API) via deze node. */
  httpRelayNodeId: Id.nullable(),
});
export type Node = z.infer<typeof Node>;

/** Tunnel van een node via zijn relay-node, zoals de node hem zelf meldt. */
export const NodeRelayTunnel = z.object({
  connected: z.boolean(),
  latencyMs: z.number().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.date().nullable(),
  connectedAt: z.date().nullable(),
  reconnects: z.number().int(),
  /** HTTP_MODE van de node: "direct" = Caddy draait nog op 80/443 (omzetten op de node nodig). */
  httpMode: z.enum(["direct", "relay"]).nullable(),
  reportedAt: z.date(),
});

/** Een DNS-record dat naar de HTTP(S)-ingang van een node moet wijzen. */
export const RelayDnsRecord = z.object({
  name: z.string(),
  type: z.literal("A"),
  /** Het IP waar het record naar moet wijzen; null = onbekend. */
  value: z.string().nullable(),
  /** Kan het panel dit record via een gekoppelde DNS-provider zetten? */
  managed: z.boolean(),
  /** Bij setHttpRelay: gezet via de provider; null = niet geprobeerd. */
  applied: z.boolean().nullable(),
  error: z.string().nullable(),
  /** Wijst het record (via 1.1.1.1/8.8.8.8) al naar value? null = niet gecontroleerd (wildcards, setHttpRelay). */
  ok: z.boolean().nullable(),
});
export type RelayDnsRecord = z.infer<typeof RelayDnsRecord>;

export const NodeRelayStatus = z.object({
  relayNodeId: Id.nullable(),
  /** Het IP waar de HTTP(S)-records van deze node naar moeten wijzen (eigen IP of dat van de relay-node). */
  httpIp: z.string().nullable(),
  /** Gemeld door deze node; null = nog niets gemeld. */
  tunnel: NodeRelayTunnel.nullable(),
  /** Live gezien vanaf de relay-node; null = relay-node niet bereikbaar of geen relay. */
  edge: z.object({ connected: z.boolean(), latencyMs: z.number().nullable(), lastError: z.string().nullable(), hosts: z.array(z.string()) }).nullable(),
  /** Records die naar httpIp moeten wijzen: het node-domein en de webdomeinen op deze node. */
  dns: z.array(RelayDnsRecord),
  /** Nodes die als relay kunnen dienen: eigen 80/443, zelf geen relay, niet deze node. */
  candidates: z.array(z.object({ id: Id, name: z.string(), fqdn: z.string() })),
  /** Nodes die via deze node lopen. */
  clients: z.array(z.object({ id: Id, name: z.string(), fqdn: z.string() })),
  /** Op de node (als root) uitvoeren om zijn Caddy in de juiste modus te zetten (relay: zonder 80/443); null voor de lokale node. */
  modeCommand: z.string().nullable(),
});
export type NodeRelayStatus = z.infer<typeof NodeRelayStatus>;

export const NodeJoinState = z.enum(["waiting", "docker", "download", "dns", "daemon", "certificate", "ready", "failed"]);
export type NodeJoinState = z.infer<typeof NodeJoinState>;

/** Een node toevoegen met het join-commando. Zonder fqdn: <naam>.<basisdomein van PANEL_DOMAIN>. */
export const NodeJoinInput = z.object({
  name: z.string().min(1).max(100),
  fqdn: z.string().max(253).optional(),
  /** Uit: geen websites/domeinen; de node-domeinnaam draait op publicPort met een DNS-01-certificaat (via het panel + Cloudflare). */
  supportsDomains: z.boolean().default(true),
  /** Standaard 443 (supportsDomains) of 8443. */
  publicPort: z.number().int().min(1).max(65535).optional(),
  daemonPort: z.number().int().default(8080),
  sftpPort: z.number().int().default(2022),
  maxRamMb: z.number().int().min(0).default(0),
  maxDiskMb: z.number().int().min(0).default(0),
  s3TargetId: Id.nullable().default(null),
  /** Standaard allocatiebereik op het publieke IP van de node, bijv. "25565-25600"; leeg = geen. */
  allocationPorts: z.string().max(100).default("25565-25600"),
  /** HTTP(S) via deze node (die zelf 80/443 heeft): de nieuwe node heeft geen 80/443 nodig. Vereist supportsDomains. */
  httpRelayNodeId: Id.nullable().default(null),
});

export const NodeJoinStatus = z.object({
  state: NodeJoinState.nullable(),
  message: z.string().nullable(),
  ip: z.string().nullable(),
  dns: z.object({
    mode: z.enum(["cloudflare", "manual"]),
    /** Het record dat moet bestaan; value is null zolang het IP nog niet bekend is. */
    record: z.object({ type: z.literal("A"), name: z.string(), value: z.string().nullable() }),
    resolvedIp: z.string().nullable(),
    ok: z.boolean(),
  }),
  daemonConnected: z.boolean(),
  certificateOk: z.boolean(),
  allocationsCreated: z.number().int(),
  codeExpiresAt: z.date().nullable(),
  codeUsed: z.boolean(),
});
export type NodeJoinStatus = z.infer<typeof NodeJoinStatus>;

export const NodeInput = z.object({
  name: z.string().min(1).max(100),
  fqdn: z.string().min(1).max(253),
  daemonPort: z.number().int().default(8080),
  sftpPort: z.number().int().default(2022),
  maxRamMb: z.number().int().min(0),
  maxDiskMb: z.number().int().min(0),
  s3TargetId: Id.nullable().default(null),
  /** Alleen te zetten van aan naar uit als er geen websites/domeinen op de node staan (NODE_HAS_DOMAINS). */
  supportsDomains: z.boolean().default(true),
  publicPort: z.number().int().min(1).max(65535).default(443),
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
  /** Laatste keer dat de node antwoordde (uit de monitor-cache); null = nog nooit. */
  lastSeenAt: z.date().nullable().optional(),
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
  /** Beheerd via de daemon van de node (de node meldt zijn eigen MariaDB aan). */
  daemonManaged: z.boolean(),
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

const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Globale instellingen voor image-updates; het venster is in Europe/Amsterdam en mag over middernacht lopen. */
export const ImageUpdateSettings = z.object({
  defaultPolicy: ImagePolicy,
  windowStart: ClockTime,
  windowEnd: ClockTime,
});
export type ImageUpdateSettings = z.infer<typeof ImageUpdateSettings>;
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

/** MOTD van slapende Minecraft-servers (promoregel met `&`-kleurcodes, icoon-opties). */
export const SleepMotdSettings = z.object({
  promo: z.string().max(120),
  showLogoIcon: z.boolean(),
  seedLogoIcon: z.boolean(),
});
export type SleepMotdSettings = z.infer<typeof SleepMotdSettings>;

export const Settings = Branding.extend({
  defaultLimits: Limits,
  imageUpdates: ImageUpdateSettings,
  sleepMotd: SleepMotdSettings,
  /** Activiteitenlog zoveel dagen bewaren; 0 = altijd. Oudere regels ruimt een periodieke taak op. */
  activityRetentionDays: z.number().int().min(0).max(3650),
});
export type Settings = z.infer<typeof Settings>;

/** Admin-overzicht van de image-status per server. */
export const AdminImageRow = z.object({
  uuid: Uuid,
  name: z.string(),
  type: ServerType,
  status: ServerStatus,
  templateName: z.string(),
  nodeName: z.string(),
  /** Image uit de template waarmee de server (opnieuw) wordt aangemaakt. */
  image: z.string(),
  imageUpdate: ImageUpdateInfo,
});
export type AdminImageRow = z.infer<typeof AdminImageRow>;

// ---------- panel updates (Admin > Settings > Updates) ----------

export const UpgradeState = z.enum(["idle", "running", "success", "failed", "rolled_back"]);
export type UpgradeState = z.infer<typeof UpgradeState>;
/** CI-status van een commit op GitHub: `none` = geen check-runs, `unknown` = GitHub niet bereikbaar. */
export const CiStatus = z.enum(["success", "failure", "pending", "none", "unknown"]);
export type CiStatus = z.infer<typeof CiStatus>;

export const PanelCommit = z.object({ sha: z.string(), date: z.string().nullable(), message: z.string() });
export type PanelCommit = z.infer<typeof PanelCommit>;
export const AvailableUpdate = PanelCommit.extend({ author: z.string().nullable(), ci: CiStatus });
export type AvailableUpdate = z.infer<typeof AvailableUpdate>;

/** Laatste (of lopende) run van deploy/upgrade.sh, uit /var/lib/panel/upgrade/status.json. */
export const UpgradeRun = z.object({
  state: UpgradeState,
  from: z.string(),
  to: z.string(),
  step: z.string(),
  started: z.string().nullable(),
  finished: z.string().nullable(),
  error: z.string().nullable(),
});
export type UpgradeRun = z.infer<typeof UpgradeRun>;

export const UpdatesStatus = z.object({
  /** Instelling `updates_enabled`: uit = de knop en `start` zijn geblokkeerd. */
  enabled: z.boolean(),
  /** De versie die nu draait (bij het bouwen van de image ingebakken). */
  current: PanelCommit,
  daemonVersion: z.string().nullable(),
  daemonCommit: z.string().nullable(),
  /** Commits op origin/main die nog niet in de checkout zitten (nieuwste eerst, max 50). */
  available: z.array(AvailableUpdate),
  upgrade: UpgradeRun.nullable(),
  logTail: z.string(),
  /** De lokale daemon is bereikbaar en heeft een checkout om vanuit te upgraden. */
  canUpgrade: z.boolean(),
  /** Reden als er niets te tonen of te doen is (daemon onbereikbaar, git fetch mislukt, ...). */
  error: z.string().nullable(),
  githubRepo: z.string().nullable(),
});
export type UpdatesStatus = z.infer<typeof UpdatesStatus>;

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
  nodes: z.array(z.object({ id: Id, name: z.string(), supportsDomains: z.boolean() })),
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

// ---------- meldingen (in het panel, Discord, e-mail) ----------

/**
 * Soorten gebeurtenissen waarvoor een gebruiker per kanaal kiest. `node_offline` en `image_update`
 * zijn alleen voor admins (zie ADMIN_NOTIFICATION_EVENTS).
 */
export const NotificationEvent = z.enum([
  "server_crashed",
  "server_unreachable",
  "disk",
  "backup_failed",
  "backup_completed",
  "install_failed",
  "ssl_failed",
  "login_new_ip",
  "node_offline",
  "image_update",
  "usage_alarm",
  "server_cloned",
]);
export type NotificationEvent = z.infer<typeof NotificationEvent>;
export const ADMIN_NOTIFICATION_EVENTS: readonly NotificationEvent[] = ["node_offline", "image_update"];
export const NotificationChannel = z.enum(["panel", "discord", "email"]);
export type NotificationChannel = z.infer<typeof NotificationChannel>;
export const ChannelPrefs = z.object({ panel: z.boolean(), discord: z.boolean(), email: z.boolean() });
export type ChannelPrefs = z.infer<typeof ChannelPrefs>;
/** Volledige tabel: elke gebeurtenis heeft een rij. */
export const NotificationPrefs = z.record(NotificationEvent, ChannelPrefs);
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;

/** Standaard: overal het panel en Discord; e-mail voor wat echt aandacht vraagt. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  server_crashed: { panel: true, discord: true, email: true },
  server_unreachable: { panel: true, discord: true, email: true },
  disk: { panel: true, discord: true, email: true },
  backup_failed: { panel: true, discord: true, email: true },
  backup_completed: { panel: false, discord: false, email: false },
  install_failed: { panel: true, discord: true, email: false },
  ssl_failed: { panel: true, discord: true, email: true },
  login_new_ip: { panel: true, discord: false, email: true },
  node_offline: { panel: true, discord: true, email: true },
  image_update: { panel: true, discord: false, email: false },
  usage_alarm: { panel: true, discord: true, email: false },
  server_cloned: { panel: true, discord: false, email: false },
};

export const EmailAddress = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const EmailStatus = z.object({
  /** Geverifieerd adres waar meldingen heen gaan (null = geen). */
  address: z.string().nullable(),
  /** Adres dat op verificatie wacht (link verstuurd). */
  pending: z.string().nullable(),
});
export type EmailStatus = z.infer<typeof EmailStatus>;

export const NotificationSettings = z.object({
  prefs: NotificationPrefs,
  email: EmailStatus,
  /** Eigen Discord-webhook ingesteld. */
  discordSet: z.boolean(),
  /** De admin heeft SMTP ingesteld (anders kan e-mail niet). */
  emailAvailable: z.boolean(),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

export const InboxLevel = z.enum(["info", "success", "warning", "error"]);
export const InboxItem = z.object({
  id: Id,
  event: NotificationEvent,
  level: InboxLevel,
  title: z.string(),
  body: z.string(),
  server: z.object({ uuid: Uuid, name: z.string() }).nullable(),
  /** Pad binnen het panel, bv. /servers/<uuid>. */
  link: z.string().nullable(),
  createdAt: z.date(),
  readAt: z.date().nullable(),
});
export type InboxItem = z.infer<typeof InboxItem>;

export const SmtpSecurity = z.enum(["tls", "starttls", "none"]);
export type SmtpSecurity = z.infer<typeof SmtpSecurity>;
/** SMTP zoals de admin hem ziet (nooit het wachtwoord). `host: null` = niet ingesteld. */
export const SmtpSettings = z.object({
  host: z.string().nullable(),
  port: z.number().int().min(1).max(65535),
  security: SmtpSecurity,
  username: z.string().nullable(),
  passwordSet: z.boolean(),
  from: z.string().nullable(),
  fromName: z.string().nullable(),
});
export type SmtpSettings = z.infer<typeof SmtpSettings>;
export const SmtpInput = z.object({
  /** null = SMTP uitzetten (alles wissen). */
  host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$|^\[[0-9a-fA-F:.]+\]$/, "invalid host").nullable(),
  port: z.number().int().min(1).max(65535),
  security: SmtpSecurity,
  username: z.string().max(254).nullable(),
  /** Weggelaten = ongewijzigd, null = wissen. */
  password: z.string().max(500).nullable().optional(),
  from: EmailAddress.nullable(),
  fromName: z.string().trim().max(100).nullable(),
});
export type SmtpInput = z.infer<typeof SmtpInput>;

// ---------- openbare statuspagina's ----------

/** 3-48 tekens, kleine letters, cijfers en streepjes (niet aan begin of eind). */
export const StatusSlug = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/, "INVALID_SLUG");
export const StatusPageKind = z.enum(["server", "network"]);
export const StatusPage = z.object({
  id: Id,
  slug: z.string(),
  kind: StatusPageKind,
  title: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  showAddress: z.boolean(),
  showPlayers: z.boolean(),
  servers: z.array(z.object({ uuid: Uuid, name: z.string() })),
  createdAt: z.date(),
});
export type StatusPage = z.infer<typeof StatusPage>;
export const StatusPageInput = z.object({
  slug: StatusSlug,
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().default(null),
  enabled: z.boolean().default(true),
  showAddress: z.boolean().default(false),
  showPlayers: z.boolean().default(true),
  /** Op volgorde; alleen eigen servers. */
  serverUuids: z.array(Uuid).min(1).max(50),
});
export const StatusCandidate = z.object({
  uuid: Uuid,
  name: z.string(),
  type: ServerType,
  templateName: z.string(),
  /** Proxy (Velocity): de backends van zijn netwerk, om in één keer toe te voegen. */
  networkMembers: z.array(Uuid),
});
export type StatusCandidate = z.infer<typeof StatusCandidate>;

/** Wat een bezoeker ziet. Bewust zonder uuid's, IP's (tenzij showAddress), node of eigenaar. */
export const PublicServerState = z.enum(["online", "starting", "sleeping", "offline", "maintenance", "unknown"]);
export type PublicServerState = z.infer<typeof PublicServerState>;
export const PublicStatusServer = z.object({
  name: z.string(),
  type: ServerType,
  state: PublicServerState,
  players: z.object({ online: z.number().int(), max: z.number().int() }).nullable(),
  /** Percentages 0-100; null = nog geen metingen. */
  uptime24h: z.number().nullable(),
  uptime7d: z.number().nullable(),
  /** Per uur (oudste eerst, 24 stuks) en per dag (7 stuks). */
  hours: z.array(z.number().nullable()),
  days: z.array(z.number().nullable()),
  address: z.string().nullable(),
});
export type PublicStatusServer = z.infer<typeof PublicStatusServer>;
export const PublicStatus = z.object({
  title: z.string(),
  description: z.string().nullable(),
  kind: StatusPageKind,
  branding: Branding,
  overall: z.enum(["operational", "degraded", "down", "unknown"]),
  servers: z.array(PublicStatusServer),
  updatedAt: z.date(),
});
export type PublicStatus = z.infer<typeof PublicStatus>;
// ---------- server dupliceren ----------

export const CloneStepKey = z.enum(["create", "files", "databases", "domain", "finish"]);
export type CloneStepKey = z.infer<typeof CloneStepKey>;
export const CloneStepStatus = z.enum(["pending", "running", "done", "failed", "skipped"]);
export const CloneStatus = z.enum(["running", "succeeded", "failed", "canceled"]);
export type CloneStatus = z.infer<typeof CloneStatus>;
export const CloneJob = z.object({
  id: Id,
  status: CloneStatus,
  /** `exists: false` = die server is (inmiddels) verwijderd. */
  source: z.object({ uuid: Uuid, name: z.string(), exists: z.boolean() }),
  target: z.object({ uuid: Uuid, name: z.string(), exists: z.boolean() }),
  steps: z.array(z.object({ key: CloneStepKey, status: CloneStepStatus })),
  /** Zelfde node: de daemon kopieert lokaal; anders via het panel (zoals verplaatsen). */
  sameNode: z.boolean(),
  /** De bron draaide tijdens het kopiëren (Minecraft: wereld bevroren met save-off). */
  live: z.boolean(),
  bytesCopied: z.number().int(),
  /** Laatst gemeten schijfgebruik van de bron (schatting); null = onbekend. */
  bytesTotal: z.number().int().nullable(),
  /** Gekopieerde databases: oude naam → nieuwe naam + gebruiker. Configbestanden wijzen nog naar de oude! */
  databases: z.array(z.object({ from: z.string(), to: z.string(), username: z.string() })),
  domain: z.string().nullable(),
  warnings: z.array(z.string()),
  errorCode: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
});
export type CloneJob = z.infer<typeof CloneJob>;

/** Wat het dupliceerformulier moet weten over de bron (servers.cloneOptions). */
export const CloneOptions = z.object({
  type: ServerType,
  limits: Limits,
  /** Aantal poorten dat de kopie krijgt (game; Bedrock telt mee). */
  ports: z.number().int(),
  /** Databases van de bron; `copyable` = op een door de daemon beheerde MariaDB (dump/restore kan). */
  databases: z.array(z.object({ name: z.string(), copyable: z.boolean() })),
  /** Quotum van de eigenaar (gebruikers) met wat er nog vrij is; null voor admins of zonder quotum. */
  quota: z.object({ ramMb: z.number().int(), diskMb: z.number().int(), cpuPct: z.number().int(), servers: z.number().int(), databases: z.number().int() }).nullable(),
  /** Gebruiker zonder quotum kan niet dupliceren (FORBIDDEN NO_QUOTA). */
  allowed: z.boolean(),
  /** Admin: mag eigenaar en node kiezen. */
  isAdmin: z.boolean(),
  /** Vrije allocations op de node van de bron. */
  freeAllocations: z.number().int(),
  /** Waarschuwingen die vooraf al vaststaan (Velocity-netwerk, Bedrock, …), als codes. */
  notes: z.array(z.enum(["proxy_members_not_cloned", "backend_not_in_network", "bedrock_new_port", "live_copy", "domains_not_cloned", "subusers_not_cloned", "external_databases"])),
  /** Lopende kopie van deze bron (dan kan er geen tweede bij). */
  running: CloneJob.nullable(),
});
export type CloneOptions = z.infer<typeof CloneOptions>;

export const CloneInput = z.object({
  name: z.string().trim().min(1).max(100),
  /** Weggelaten = dezelfde limieten als de bron (gebruikers: binnen het quotum). */
  limits: OwnLimits.optional(),
  /** Databases op de MariaDB van de node meekopiëren naar nieuwe databases met nieuwe gebruikers. */
  copyDatabases: z.boolean().default(false),
  /** Alleen websites: meteen dit (nieuwe) domein koppelen. */
  domain: Hostname.nullable().default(null),
  /** Na het kopiëren starten. */
  startAfter: z.boolean().default(false),
  /** Alleen admins: andere eigenaar / node / allocations (eerste = primair). */
  ownerId: Id.optional(),
  nodeId: Id.optional(),
  allocationIds: z.array(Id).optional(),
});

// ---------- verbruiksalarmen ----------

export const AlarmMetric = z.enum(["cpu", "ram", "disk"]);
export type AlarmMetric = z.infer<typeof AlarmMetric>;
const AlarmPct = z.number().int().min(10).max(100);
/** Drempels in procent van de limiet van de server; null = dat alarm uit. CPU en RAM moeten `durationMinutes` aanhouden. */
export const AlarmConfig = z.object({
  enabled: z.boolean(),
  cpuPct: AlarmPct.nullable(),
  ramPct: AlarmPct.nullable(),
  durationMinutes: z.number().int().min(1).max(120),
  diskPct: AlarmPct.nullable(),
});
export type AlarmConfig = z.infer<typeof AlarmConfig>;
/** Standaard voor servers zonder eigen instelling, plus de cooldown (geldt voor alle servers). */
export const AlarmDefaults = AlarmConfig.extend({ cooldownMinutes: z.number().int().min(5).max(1440) });
export type AlarmDefaults = z.infer<typeof AlarmDefaults>;
export const ActiveAlarm = z.object({
  server: z.object({ uuid: Uuid, name: z.string() }),
  owner: UserPublic,
  metric: AlarmMetric,
  /** Laatst gemeten waarde in procent van de limiet. */
  valuePct: z.number(),
  thresholdPct: z.number().int(),
  since: z.date(),
});
export type ActiveAlarm = z.infer<typeof ActiveAlarm>;
export const ServerAlarms = z.object({
  /** true = geen eigen instelling, de standaard van de admin geldt. */
  useDefaults: z.boolean(),
  /** Wat nu geldt (eigen of standaard). */
  config: AlarmConfig,
  defaults: AlarmDefaults,
  /** Crashmelding (server_crashed) voor deze server; staat los van de drempels. */
  notifyOffline: z.boolean(),
  active: z.array(ActiveAlarm.omit({ server: true, owner: true })),
});
export type ServerAlarms = z.infer<typeof ServerAlarms>;

// ---------- pakketten en facturatie ----------
export * from "./billing-schemas";
