/**
 * Datamodel van het panel (PostgreSQL 16). Eigenaar: orchestrator.
 * Kolomnamen zijn Engels (snake_case); de betekenis staat in docs/ontwerp.md, Datamodel.
 * Velden met suffix `_enc` zijn versleuteld met AES-256-GCM (PANEL_ENCRYPTION_KEY),
 * opgeslagen als tekst "v1:<iv b64>:<ciphertext+tag b64>".
 *
 * Wijzigen: schema aanpassen, dan `pnpm --filter @panel/db generate` voor een nieuwe migratie.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const pk = () => integer("id").primaryKey().generatedAlwaysAsIdentity();

export const serverType = pgEnum("server_type", ["game", "web"]);
export const serverStatus = pgEnum("server_status", [
  "installing",
  "install_failed",
  "offline",
  "starting",
  "online",
  "stopping",
  "disk_exceeded",
  "sleeping",
  "unknown",
]);
export const diskQuotaMode = pgEnum("disk_quota_mode", ["soft", "xfs"]);
export const sslStatus = pgEnum("ssl_status", ["pending", "dns_wrong", "issuing", "active", "failed"]);
export const dnsStatus = pgEnum("dns_status", ["unchecked", "missing", "wrong_ip", "cloudflare_proxy", "ok"]);
export const backupStatus = pgEnum("backup_status", ["pending", "running", "completed", "failed", "restoring"]);
export const scheduleAction = pgEnum("schedule_action", ["restart", "command", "backup", "exec"]);

// ---------- gebruikers en auth ----------

export const users = pgTable("users", {
  id: pk(),
  /** null alleen voor het noodaccount */
  discordId: text("discord_id").unique(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  totpSecretEnc: text("totp_secret_enc"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  blocked: boolean("blocked").notNull().default(false),
  isEmergency: boolean("is_emergency").notNull().default(false),
  /** Argon2id; voor het noodaccount en voor de backup-login (login_username) */
  passwordHash: text("password_hash"),
  /** Backup-login: eigen loginnaam (kleine letters). null = backup-login uit (standaard). Nooit bij het noodaccount. */
  loginUsername: text("login_username").unique(),
  /** Laatste keer dat het backup-wachtwoord gezet is. */
  passwordSetAt: ts("password_set_at"),
  /** Het backup-wachtwoord is door een admin gegenereerd (en nog niet door de gebruiker zelf veranderd). */
  passwordSetByAdmin: boolean("password_set_by_admin").notNull().default(false),
  createdAt: createdAt(),
  lastLoginAt: ts("last_login_at"),
  /** Discord-webhook voor eigen meldingen (versleuteld; bevat het token in de URL) */
  discordWebhookEnc: text("discord_webhook_enc"),
  /** Geverifieerd e-mailadres voor meldingen (null = geen) */
  email: text("email"),
  emailVerifiedAt: ts("email_verified_at"),
  /** Kanalen per gebeurtenis: {server_crashed: {panel, discord, email}, ...}; ontbrekende sleutels = standaard */
  notificationPrefs: jsonb("notification_prefs").$type<Record<string, { panel: boolean; discord: boolean; email: boolean }>>().notNull().default({}),
}, (t) => [
  check("users_discord_or_emergency", sql`${t.discordId} is not null or ${t.isEmergency}`),
  uniqueIndex("users_one_emergency").on(t.isEmergency).where(sql`${t.isEmergency}`),
  check("users_login_username_not_emergency", sql`${t.loginUsername} is null or not ${t.isEmergency}`),
]);

/** Enige bron voor admin-schap; er is geen is_admin-kolom. */
export const adminDiscordIds = pgTable("admin_discord_ids", {
  discordId: text("discord_id").primaryKey(),
  addedBy: integer("added_by").references(() => users.id, { onDelete: "set null" }),
  addedAt: ts("added_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** SHA-256 van het cookie-token */
  tokenHash: text("token_hash").notNull().unique(),
  totpVerified: boolean("totp_verified").notNull().default(false),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
  /** Laatste gebruik (bijgewerkt hooguit eens per minuut); voor inactiviteits-timeout en de sessielijst */
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  /** Absolute levensduur */
  expiresAt: ts("expires_at").notNull(),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

/** Herstelcodes voor 2FA: alleen SHA-256 van de code; usedAt gevuld = verbruikt. */
export const recoveryCodes = pgTable("recovery_codes", {
  id: pk(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
}, (t) => [index("recovery_codes_user_idx").on(t.userId)]);

/** Passkeys (WebAuthn-credentials). Nooit voor het noodaccount. */
export const passkeys = pgTable("passkeys", {
  id: pk(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** Credential-ID (base64url), wereldwijd uniek */
  credentialId: text("credential_id").notNull().unique(),
  /** COSE-publieke sleutel (base64url) */
  publicKey: text("public_key").notNull(),
  /** signCount; moet bij elke login stijgen (tenzij de authenticator altijd 0 meldt) */
  counter: bigint("counter", { mode: "number" }).notNull().default(0),
  transports: jsonb("transports").$type<string[]>().notNull().default([]),
  /** WebAuthn user handle (base64url, willekeurig per gebruiker; gelijk voor al zijn passkeys) */
  userHandle: text("user_handle").notNull(),
  name: text("name").notNull(),
  aaguid: text("aaguid"),
  /** singleDevice | multiDevice */
  deviceType: text("device_type").notNull().default("singleDevice"),
  backedUp: boolean("backed_up").notNull().default(false),
  createdAt: createdAt(),
  lastUsedAt: ts("last_used_at"),
}, (t) => [index("passkeys_user_idx").on(t.userId)]);

/** Kortlevende, eenmalige WebAuthn-challenges (5 min). */
export const webauthnChallenges = pgTable("webauthn_challenges", {
  /** base64url-challenge zoals in clientDataJSON */
  challenge: text("challenge").primaryKey(),
  /** register | login | verify */
  purpose: text("purpose").notNull(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
}, (t) => [index("webauthn_challenges_expires_idx").on(t.expiresAt)]);

export const apiKeys = pgTable("api_keys", {
  id: pk(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull().unique(),
  /** SHA-256 van de volledige sleutel */
  hash: text("hash").notNull(),
  permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
  /** Alleen deze servers (servers.id); leeg = alle servers van de gebruiker. */
  serverIds: integer("server_ids").array().notNull().default(sql`'{}'::integer[]`),
  lastUsedAt: ts("last_used_at"),
  expiresAt: ts("expires_at"),
  createdAt: createdAt(),
});

// ---------- infrastructuur ----------

export const s3Targets = pgTable("s3_targets", {
  id: pk(),
  name: text("name").notNull(),
  endpoint: text("endpoint").notNull(),
  bucket: text("bucket").notNull(),
  region: text("region").notNull().default("us-east-1"),
  accessKeyEnc: text("access_key_enc").notNull(),
  secretKeyEnc: text("secret_key_enc").notNull(),
  pathStyle: boolean("path_style").notNull().default(true),
  createdAt: createdAt(),
});

export const nodes = pgTable("nodes", {
  id: pk(),
  name: text("name").notNull().unique(),
  fqdn: text("fqdn").notNull().unique(),
  daemonPort: integer("daemon_port").notNull().default(8080),
  sftpPort: integer("sftp_port").notNull().default(2022),
  /** SHA-256 van het node-token */
  tokenHash: text("token_hash").notNull().unique(),
  /** Het token zelf, versleuteld; nodig om remote daemons aan te roepen. Null voor de lokale node (NODE_TOKEN uit env). */
  tokenEnc: text("token_enc"),
  maxRamMb: integer("max_ram_mb").notNull().default(0),
  maxDiskMb: integer("max_disk_mb").notNull().default(0),
  s3TargetId: integer("s3_target_id").references(() => s3Targets.id, { onDelete: "set null" }),
  diskQuotaMode: diskQuotaMode("disk_quota_mode"),
  /** De node uit NODE_DOMAIN; het panel zet fqdn bij elke start. Maximaal één. */
  isLocal: boolean("is_local").notNull().default(false),
  daemonVersion: text("daemon_version"),
  lastSeenAt: ts("last_seen_at"),
  /** Websites en domeinen voor gameservers mogen op deze node (Caddy op 80/443). Uit: de node-domeinnaam draait op public_port. */
  supportsDomains: boolean("supports_domains").notNull().default(true),
  /** Poort waarop https://<fqdn> bereikbaar is (console, uploads). 443 bij supports_domains. */
  publicPort: integer("public_port").notNull().default(443),
  /** Door het join-script gemeld publiek IPv4-adres. */
  publicIp: text("public_ip"),
  /** Voortgang van de join-installatie (waiting, docker, download, dns, daemon, certificate, ready, failed); null = niet via join. */
  joinState: text("join_state"),
  joinMessage: text("join_message"),
  joinUpdatedAt: ts("join_updated_at"),
  /** Opties van de join (allocatiebereik, DNS-modus); null bij nodes die niet via join zijn gemaakt. */
  joinOptions: jsonb("join_options").$type<{ allocationIp: string | null; allocationPorts: string; dnsMode: "cloudflare" | "manual"; dnsDone: boolean; allocationsCreated: number }>(),
  /**
   * HTTP(S)-relay: null = eigen 80/443. Gezet = al het HTTP(S)-verkeer van deze node (sites, domeinen, node-API) loopt
   * via de node met dit id (die zelf 80/443 heeft); DNS van de domeinen wijst naar die node. Gamepoorten en SFTP niet.
   */
  httpRelayNodeId: integer("http_relay_node_id").references((): AnyPgColumn => nodes.id, { onDelete: "restrict" }),
  /** Gedeeld geheim van de tunnel naar de relay-node (versleuteld); nieuw bij elke relay-keuze. */
  relaySecretEnc: text("relay_secret_enc"),
  /** Laatste melding van de daemon over zijn tunnel (POST /api/remote/relay/status). */
  relayStatus: jsonb("relay_status").$type<{ edgeNodeId: number; connected: boolean; latencyMs: number | null; lastError: string | null; lastErrorAt: string | null; connectedAt: string | null; reconnects: number; httpMode: "direct" | "relay" | null; reportedAt: string }>(),
  /** Onderhoudsmodus (null = normaal): geen nieuwe servers op deze node; tijden als ISO-tekst. */
  maintenance: jsonb("maintenance").$type<{ since: string; message: string | null; plannedStart: string | null; plannedEnd: string | null; by: number | null }>(),
  /**
   * Achter Nginx Proxy Manager (HTTP_MODE=npm): null = niet. De daemon beheert met deze instellingen de proxy hosts in NPM
   * (GET /api/remote/npm). Geheimen staan apart en versleuteld (npm_password_enc, npm_cloudflare_token_enc).
   */
  npmSettings: jsonb("npm_settings").$type<{ url: string; email: string; forwardHost: string | null; forwardPort: number | null; ssl: "http" | "cloudflare"; forceSsl: boolean }>(),
  npmPasswordEnc: text("npm_password_enc"),
  npmCloudflareTokenEnc: text("npm_cloudflare_token_enc"),
  /** Laatste melding van de daemon over NPM (POST /api/remote/npm/status). */
  npmStatus: jsonb("npm_status").$type<{ state: string; error: string | null; version: string | null; proxyHosts: number; managedHosts: number; conflicts: string[]; hosts: { host: string; ssl: string; error: string | null }[]; httpMode: string | null; reportedAt: string }>(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("nodes_one_local").on(t.isLocal).where(sql`${t.isLocal}`)]);

/** Eenmalige join-codes (alleen de SHA-256 staat hier): de node ruilt de code in voor zijn token en configuratie. */
export const nodeJoinCodes = pgTable("node_join_codes", {
  id: pk(),
  nodeId: integer("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
});

export const templates = pgTable("templates", {
  id: pk(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  type: serverType("type").notNull(),
  image: text("image").notNull(),
  startup: text("startup").notNull(),
  /** {type: "command"|"signal", value} */
  stop: jsonb("stop").$type<{ type: "command" | "signal"; value: string }>().notNull(),
  readyPattern: text("ready_pattern").notNull(),
  httpPort: integer("http_port"),
  variables: jsonb("variables").$type<Array<{ key: string; name: string; description?: string; default: string; user_editable: boolean; pattern?: string }>>().notNull().default([]),
  installImage: text("install_image").notNull(),
  installScript: text("install_script").notNull(),
  configFiles: jsonb("config_files").$type<Array<{ path: string; format: "properties" | "yaml" | "json" | "toml"; set: Record<string, string> }>>().notNull().default([]),
  version: integer("version").notNull(),
  /** Originele YAML zoals geïmporteerd */
  sourceYaml: text("source_yaml").notNull(),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const servers = pgTable("servers", {
  id: pk(),
  uuid: uuid("uuid").notNull().unique().defaultRandom(),
  name: text("name").notNull(),
  ownerId: integer("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  nodeId: integer("node_id").notNull().references(() => nodes.id, { onDelete: "restrict" }),
  templateId: integer("template_id").notNull().references(() => templates.id, { onDelete: "restrict" }),
  type: serverType("type").notNull(),
  cpuPct: integer("cpu_pct").notNull(),
  ramMb: integer("ram_mb").notNull(),
  swapMb: integer("swap_mb").notNull().default(0),
  diskMb: integer("disk_mb").notNull(),
  sleepEnabled: boolean("sleep_enabled").notNull().default(false),
  sleepIdleMinutes: integer("sleep_idle_minutes").notNull().default(10),
  /** Beleid voor image-updates: null = globale standaard, anders auto | notify | off. */
  imageUpdatePolicy: text("image_update_policy"),
  /** Laatste melding van de daemon: draaiende container gebruikt een oudere image. */
  imageUpdateAvailable: boolean("image_update_available").notNull().default(false),
  imageReinstallRequired: boolean("image_reinstall_required").notNull().default(false),
  imageCheckedAt: ts("image_checked_at"),
  /** Allocation die Geyser (Bedrock, UDP) gebruikt; geldig zolang die allocation nog bij deze server hoort. null = Bedrock uit. */
  bedrockAllocationId: integer("bedrock_allocation_id"),
  suspendedAt: ts("suspended_at"),
  suspendedReason: text("suspended_reason"),
  domainsAllowed: boolean("domains_allowed").notNull().default(false),
  /** Webterminal/SSH-shell toegestaan (admin; globaal: setting terminal_enabled). */
  terminalAllowed: boolean("terminal_allowed").notNull().default(true),
  status: serverStatus("status").notNull().default("installing"),
  installedAt: ts("installed_at"),
  /** Automatisch herstarten na een crash; max N herstarts per 10 minuten */
  autoRestart: boolean("auto_restart").notNull().default(false),
  autoRestartMax: integer("auto_restart_max").notNull().default(3),
  /** Discord-webhook voor meldingen over deze server (versleuteld) */
  discordWebhookEnc: text("discord_webhook_enc"),
  createdAt: createdAt(),
}, (t) => [index("servers_owner_idx").on(t.ownerId), index("servers_node_idx").on(t.nodeId), index("servers_status_idx").on(t.status)]);

export const allocations = pgTable("allocations", {
  id: pk(),
  nodeId: integer("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  ip: text("ip").notNull(),
  port: integer("port").notNull(),
  /** leeg = vrij */
  serverId: integer("server_id").references(() => servers.id, { onDelete: "set null" }),
  isPrimary: boolean("is_primary").notNull().default(false),
}, (t) => [
  uniqueIndex("allocations_node_ip_port").on(t.nodeId, t.ip, t.port),
  index("allocations_server_idx").on(t.serverId),
  check("allocations_port_range", sql`${t.port} between 1 and 65535`),
]);

export const serverVariables = pgTable("server_variables", {
  serverId: integer("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value").notNull(),
}, (t) => [primaryKey({ columns: [t.serverId, t.key] })]);

export const subusers = pgTable("subusers", {
  serverId: integer("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.serverId, t.userId] }), index("subusers_user_idx").on(t.userId)]);

export const sftpCredentials = pgTable("sftp_credentials", {
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serverId: integer("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  /** Argon2id */
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.userId, t.serverId] })]);

// ---------- web ----------

export const dnsProviders = pgTable("dns_providers", {
  id: pk(),
  type: text("type").notNull().default("cloudflare"),
  name: text("name").notNull(),
  apiTokenEnc: text("api_token_enc").notNull(),
  zones: jsonb("zones").$type<Array<{ id: string; name: string }>>().notNull().default([]),
  createdAt: createdAt(),
});

export const domains = pgTable("domains", {
  id: pk(),
  serverId: integer("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  hostname: text("hostname").notNull().unique(),
  protocol: text("protocol").notNull().default("http"),
  targetPort: integer("target_port"),
  redirectTo: text("redirect_to"),
  dnsProviderId: integer("dns_provider_id").references(() => dnsProviders.id, { onDelete: "set null" }),
  wildcard: boolean("wildcard").notNull().default(false),
  sslStatus: sslStatus("ssl_status").notNull().default("pending"),
  dnsStatus: dnsStatus("dns_status").notNull().default("unchecked"),
  /** Laatste volledige DnsCheck (zie contract) */
  lastCheck: jsonb("last_check"),
  lastCheckedAt: ts("last_checked_at"),
  createdAt: createdAt(),
}, (t) => [index("domains_server_idx").on(t.serverId)]);

/** Backend-servers achter een proxy (Minecraft-netwerk). Een backend hoort bij hooguit één proxy; positie 0 = standaardserver. */
export const networkMembers = pgTable("network_members", {
  id: pk(),
  proxyServerId: integer("proxy_server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  backendServerId: integer("backend_server_id").notNull().unique().references(() => servers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  position: integer("position").notNull(),
}, (t) => [uniqueIndex("network_members_proxy_name").on(t.proxyServerId, t.name), index("network_members_proxy_idx").on(t.proxyServerId)]);

/**
 * Velocity forced hosts: spelers die via `hostname` verbinden landen op `backendServerId` (een lid van
 * het netwerk van de proxy). Op server-id, dus hernoemen of verplaatsen (transfer) van een backend verandert niets;
 * verwijderen uit het netwerk haalt de regel weg. Een hostnaam hoort bij hooguit één proxy.
 */
export const networkForcedHosts = pgTable("network_forced_hosts", {
  id: pk(),
  proxyServerId: integer("proxy_server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  hostname: text("hostname").notNull().unique(),
  backendServerId: integer("backend_server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
}, (t) => [index("network_forced_hosts_proxy_idx").on(t.proxyServerId)]);

/** Via het panel geïnstalleerde plugins/mods (Modrinth/Hangar). Eén rij per project per server. */
export const serverContent = pgTable("server_content", {
  id: pk(),
  serverId: integer("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  versionId: text("version_id").notNull(),
  versionNumber: text("version_number").notNull(),
  filename: text("filename").notNull(),
  kind: text("kind").notNull(),
  installedAt: createdAt(),
}, (t) => [uniqueIndex("server_content_project").on(t.serverId, t.source, t.projectId), index("server_content_server_idx").on(t.serverId)]);

export const databaseHosts = pgTable("database_hosts", {
  id: pk(),
  name: text("name").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull().default(3306),
  adminUser: text("admin_user").notNull(),
  adminPasswordEnc: text("admin_password_enc").notNull(),
  nodeId: integer("node_id").references(() => nodes.id, { onDelete: "set null" }),
  /** true: beheerd via de daemon van `nodeId` (nooit rechtstreeks verbinden); admin_* zijn dan leeg/ongebruikt. */
  daemonManaged: boolean("daemon_managed").notNull().default(false),
  createdAt: createdAt(),
});

export const databases = pgTable("databases", {
  id: pk(),
  serverId: integer("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  hostId: integer("host_id").notNull().references(() => databaseHosts.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  username: text("username").notNull(),
  passwordEnc: text("password_enc").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("databases_host_name").on(t.hostId, t.name), index("databases_server_idx").on(t.serverId)]);

// ---------- one-click apps ----------

export const appInstalls = pgTable("app_installs", {
  id: pk(),
  serverId: integer("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  appId: text("app_id").notNull(),
  status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull().default("running"),
  steps: jsonb("steps").$type<Array<{ key: string; status: "pending" | "running" | "done" | "failed" }>>().notNull().default([]),
  errorCode: text("error_code"),
  error: text("error"),
  /** Versleuteld JSON-resultaat (bevat het eenmalige beheerderswachtwoord tot het is opgehaald). */
  resultEnc: text("result_enc"),
  createdAt: createdAt(),
  finishedAt: ts("finished_at"),
}, (t) => [index("app_installs_server").on(t.serverId)]);

// ---------- git-deploy (websites) ----------

/** Koppeling van een website aan een git-repository (één per server). */
export const deployConfigs = pgTable("deploy_configs", {
  serverId: integer("server_id").primaryKey().references(() => servers.id, { onDelete: "cascade" }),
  repoUrl: text("repo_url").notNull(),
  branch: text("branch").notNull().default("main"),
  authType: text("auth_type", { enum: ["none", "token", "ssh"] }).notNull().default("none"),
  /** HTTPS-token (privérepo). */
  tokenEnc: text("token_enc"),
  tokenUsername: text("token_username"),
  /** Door het panel gegenereerde ed25519-deploy key (OpenSSH-formaat). */
  sshPrivateKeyEnc: text("ssh_private_key_enc"),
  sshPublicKey: text("ssh_public_key"),
  /** Vertrouwde known_hosts-regels voor sshHostFor ("host:poort"), met hun fingerprints. */
  knownHosts: text("known_hosts"),
  sshHostFor: text("ssh_host_for"),
  sshHostKeys: jsonb("ssh_host_keys").$type<Array<{ type: string; fingerprint: string }>>(),
  sshHostTrust: text("ssh_host_trust", { enum: ["builtin", "confirmed"] }),
  targetDir: text("target_dir").notNull(),
  sourceDir: text("source_dir").notNull().default("/"),
  buildCommand: text("build_command"),
  buildImage: text("build_image").notNull().default("site"),
  sharedPaths: text("shared_paths").array().notNull().default(sql`'{}'::text[]`),
  restartAfter: boolean("restart_after").notNull().default(false),
  autoDeploy: boolean("auto_deploy").notNull().default(true),
  /** Er kwam een push binnen tijdens een lopende deploy: daarna nog één keer deployen. */
  redeployPending: boolean("redeploy_pending").notNull().default(false),
  /** Publiek deel van de webhook-URL; het geheim staat apart (versleuteld). */
  webhookId: text("webhook_id").notNull(),
  webhookSecretEnc: text("webhook_secret_enc").notNull(),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("deploy_configs_webhook_id").on(t.webhookId)]);

/** Deploy-geschiedenis. `log` = de laatste regels (geredacteerd door de daemon). */
export const deploys = pgTable("deploys", {
  id: pk(),
  serverId: integer("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  status: text("status", { enum: ["running", "succeeded", "failed", "cancelled"] }).notNull().default("running"),
  trigger: text("trigger", { enum: ["manual", "webhook"] }).notNull(),
  branch: text("branch").notNull(),
  commitSha: text("commit_sha"),
  commitAuthor: text("commit_author"),
  commitMessage: text("commit_message"),
  commitDate: ts("commit_date"),
  error: text("error"),
  log: text("log").array().notNull().default(sql`'{}'::text[]`),
  durationMs: integer("duration_ms"),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
}, (t) => [
  index("deploys_server_idx").on(t.serverId, t.id),
  // Nooit twee lopende deploys per site (ook niet bij gelijktijdige webhooks).
  uniqueIndex("deploys_one_running").on(t.serverId).where(sql`status = 'running'`),
]);

// ---------- backups en schema's ----------

export const backups = pgTable("backups", {
  id: pk(),
  serverId: integer("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  s3TargetId: integer("s3_target_id").references(() => s3Targets.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  s3Key: text("s3_key").notNull(),
  sha256: text("sha256"),
  status: backupStatus("status").notNull().default("pending"),
  includesDatabases: boolean("includes_databases").notNull().default(false),
  error: text("error"),
  createdAt: createdAt(),
  completedAt: ts("completed_at"),
}, (t) => [index("backups_server_idx").on(t.serverId)]);

export const schedules = pgTable("schedules", {
  id: pk(),
  serverId: integer("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  cron: text("cron").notNull(),
  action: scheduleAction("action").notNull(),
  payload: text("payload"),
  active: boolean("active").notNull().default(true),
  lastRunAt: ts("last_run_at"),
  nextRunAt: ts("next_run_at"),
  lastResult: text("last_result"),
  lastOutput: text("last_output"),
  createdAt: createdAt(),
});

// ---------- server dupliceren ----------

/**
 * Kopieeropdracht "server dupliceren": achtergrondtaak met stappen (zoals app_installs). Het doel wordt
 * bij een fout of annuleren verwijderd (target_server_id wordt dan null; uuid en naam blijven voor het log).
 * `databases`: welke database naar welke nieuwe is gekopieerd (configbestanden worden niet herschreven).
 */
export const serverClones = pgTable("server_clones", {
  id: pk(),
  sourceServerId: integer("source_server_id").references(() => servers.id, { onDelete: "set null" }),
  targetServerId: integer("target_server_id").references(() => servers.id, { onDelete: "set null" }),
  sourceUuid: uuid("source_uuid").notNull(),
  targetUuid: uuid("target_uuid").notNull(),
  sourceName: text("source_name").notNull(),
  targetName: text("target_name").notNull(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  status: text("status", { enum: ["running", "succeeded", "failed", "canceled"] }).notNull().default("running"),
  steps: jsonb("steps").$type<Array<{ key: string; status: "pending" | "running" | "done" | "failed" | "skipped" }>>().notNull().default([]),
  options: jsonb("options").$type<{ copyDatabases: boolean; domain: string | null; startAfter: boolean; sameNode: boolean; live: boolean }>().notNull(),
  bytesCopied: bigint("bytes_copied", { mode: "number" }).notNull().default(0),
  bytesTotal: bigint("bytes_total", { mode: "number" }),
  databases: jsonb("databases").$type<Array<{ from: string; to: string; username: string }>>().notNull().default([]),
  warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  errorCode: text("error_code"),
  error: text("error"),
  createdAt: createdAt(),
  finishedAt: ts("finished_at"),
}, (t) => [index("server_clones_source_idx").on(t.sourceServerId), index("server_clones_target_idx").on(t.targetServerId)]);

// ---------- verbruiksalarmen ----------

/**
 * Eigen alarminstelling van een server (geen rij = de standaard van de admin, settings `alarm_defaults`).
 * Drempels in procenten van de limiet; null = dat alarm uit. `notify_offline` uit = geen crashmelding
 * voor de eigenaar (de bestaande server_crashed-melding; het admin-kanaal blijft).
 */
export const serverAlarms = pgTable("server_alarms", {
  serverId: integer("server_id").primaryKey().references(() => servers.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  cpuPct: integer("cpu_pct"),
  ramPct: integer("ram_pct"),
  durationMinutes: integer("duration_minutes").notNull().default(5),
  diskPct: integer("disk_pct"),
  notifyOffline: boolean("notify_offline").notNull().default(true),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Toestand per server en meetwaarde (cpu, ram, disk): actief sinds, laatste melding (cooldown). */
export const serverAlarmState = pgTable("server_alarm_state", {
  serverId: integer("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  metric: text("metric", { enum: ["cpu", "ram", "disk"] }).notNull(),
  active: boolean("active").notNull().default(false),
  since: ts("since"),
  /** Gemeten waarde (procent van de limiet) bij de laatste evaluatie toen het alarm actief was. */
  value: real("value"),
  threshold: integer("threshold"),
  lastNotifiedAt: ts("last_notified_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.serverId, t.metric] }), index("server_alarm_state_active_idx").on(t.active)]);

// ---------- meldingen ----------

/** Verificatielinks voor e-mailadressen; alleen de SHA-256 van het token. */
export const emailVerifications = pgTable("email_verifications", {
  id: pk(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
}, (t) => [index("email_verifications_user_idx").on(t.userId)]);

/** Meldingen in het panel (bel in de kopbalk). */
export const notifications = pgTable("notifications", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  level: text("level", { enum: ["info", "success", "warning", "error"] }).notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  serverId: integer("server_id").references(() => servers.id, { onDelete: "set null" }),
  link: text("link"),
  readAt: ts("read_at"),
  createdAt: createdAt(),
}, (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)]);

/**
 * Wachtrij voor uitgaande meldingen (e-mail, Discord) met retries. `target_enc` is het adres of de
 * webhook-URL (versleuteld: een webhook-URL bevat het token). `payload` is het kant-en-klare bericht.
 */
export const notificationOutbox = pgTable("notification_outbox", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  channel: text("channel", { enum: ["email", "discord"] }).notNull(),
  targetEnc: text("target_enc").notNull(),
  /** SHA-256 van het doel, voor de limiet per ontvanger zonder te ontsleutelen */
  targetHash: text("target_hash").notNull(),
  event: text("event").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: text("status", { enum: ["pending", "sending", "sent", "failed", "dropped"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  lastError: text("last_error"),
  createdAt: createdAt(),
  sentAt: ts("sent_at"),
}, (t) => [index("notification_outbox_due_idx").on(t.status, t.nextAttemptAt), index("notification_outbox_target_idx").on(t.targetHash, t.createdAt)]);

// ---------- statuspagina's ----------

/** Openbare statuspagina op /status/<slug>: één server (`kind = server`) of een netwerk van servers. */
export const statusPages = pgTable("status_pages", {
  id: pk(),
  slug: text("slug").notNull().unique(),
  ownerId: integer("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["server", "network"] }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(true),
  /** Toont het adres (ip:poort of domein); standaard uit */
  showAddress: boolean("show_address").notNull().default(false),
  showPlayers: boolean("show_players").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("status_pages_owner_idx").on(t.ownerId)]);

export const statusPageServers = pgTable("status_page_servers", {
  pageId: integer("page_id").notNull().references(() => statusPages.id, { onDelete: "cascade" }),
  serverId: integer("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  position: integer("position").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.pageId, t.serverId] }), index("status_page_servers_server_idx").on(t.serverId)]);

/** Beschikbaarheid per server per uur (één meting per minuut): voor uptime 24 u / 7 d. */
export const serverUptime = pgTable("server_uptime", {
  serverId: integer("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  hour: ts("hour").notNull(),
  upMinutes: integer("up_minutes").notNull().default(0),
  totalMinutes: integer("total_minutes").notNull().default(0),
  /** Laatst gemeten minuut (0-59): voorkomt dubbel tellen door twee panelprocessen */
  lastMinute: integer("last_minute").notNull().default(-1),
}, (t) => [primaryKey({ columns: [t.serverId, t.hour] })]);

// ---------- overig ----------

/** sleutels o.a.: panel_name, logo_url, accent_color, default_limits, jwt_signing_key_enc, admin_webhook_enc, smtp (host/poort/beveiliging/gebruiker/afzender), smtp_password_enc */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const activityLog = pgTable("activity_log", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  serverId: integer("server_id").references(() => servers.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  ip: text("ip"),
  at: ts("at").notNull().defaultNow(),
}, (t) => [
  index("activity_user_idx").on(t.userId, t.at),
  index("activity_server_idx").on(t.serverId, t.at),
  index("activity_action_idx").on(t.action),
  /** Voor de bewaartermijn (verwijderen op `at`). */
  index("activity_at_idx").on(t.at),
]);

/** Quotum per gebruiker; geen rij = de gebruiker kan zelf geen servers maken. null in de lijsten = alles. */
export const userQuotas = pgTable("user_quotas", {
  userId: integer("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  maxRamMb: integer("max_ram_mb").notNull(),
  maxDiskMb: integer("max_disk_mb").notNull(),
  maxCpuPct: integer("max_cpu_pct").notNull(),
  maxServers: integer("max_servers").notNull(),
  maxDatabases: integer("max_databases").notNull(),
  templateIds: jsonb("template_ids").$type<number[] | null>(),
  nodeIds: jsonb("node_ids").$type<number[] | null>(),
  maxPortsPerServer: integer("max_ports_per_server"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * Verbruiksgeschiedenis per server voor de grafieken. Het panel meet elke minuut (resolution 60)
 * en vat samen naar 15 min (900) en 1 uur (3600); elke rij is het gemiddelde over `samples` metingen.
 * Bewaard: 60 → 24 u, 900 → 7 d, 3600 → 30 d (zie apps/web/server/stats-history.ts).
 * Netwerk in bytes/s; null als er geen vorige teller was om mee te vergelijken.
 */
export const serverStats = pgTable("server_stats", {
  serverId: integer("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  resolution: integer("resolution").notNull(),
  bucket: ts("bucket").notNull(),
  samples: integer("samples").notNull(),
  cpuPct: real("cpu_pct").notNull(),
  cpuMaxPct: real("cpu_max_pct").notNull(),
  memoryBytes: bigint("memory_bytes", { mode: "number" }).notNull(),
  memoryMaxBytes: bigint("memory_max_bytes", { mode: "number" }).notNull(),
  diskBytes: bigint("disk_bytes", { mode: "number" }).notNull(),
  rxBytesPerSec: real("rx_bytes_per_sec"),
  txBytesPerSec: real("tx_bytes_per_sec"),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.resolution, t.bucket] }),
  index("server_stats_retention_idx").on(t.resolution, t.bucket),
]);

// ---------- pakketten en facturatie ----------

export const subscriptionStatus = pgEnum("subscription_status", ["pending", "active", "past_due", "suspended", "canceled"]);
export const invoiceStatus = pgEnum("invoice_status", ["open", "paid", "overdue", "void"]);

/** Pakketten (plans): vaste limieten waarmee een gebruiker zelf een server maakt. */
export const plans = pgTable("plans", {
  id: pk(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  type: serverType("type").notNull(),
  /** Toegestane templates (minstens één, van hetzelfde type). */
  templateIds: jsonb("template_ids").$type<number[]>().notNull(),
  /** null = automatisch kiezen uit alle nodes; anders alleen deze nodes. */
  nodeIds: jsonb("node_ids").$type<number[] | null>(),
  ramMb: integer("ram_mb").notNull(),
  cpuPct: integer("cpu_pct").notNull(),
  diskMb: integer("disk_mb").notNull(),
  maxDatabases: integer("max_databases").notNull().default(0),
  maxBackups: integer("max_backups").notNull().default(0),
  /** Aantal poorten (allocations) van een game-server; 0 voor websites. */
  allocations: integer("allocations").notNull().default(1),
  /** Prijs per maand in centen; 0 = gratis. */
  priceCents: integer("price_cents").notNull().default(0),
  currency: text("currency").notNull().default("EUR"),
  visible: boolean("visible").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [check("plans_price_nonneg", sql`${t.priceCents} >= 0`)]);

/** Abonnement: gebruiker ↔ pakket, met hooguit één server. `free` = zonder facturen (toegekend of gratis pakket). */
export const subscriptions = pgTable("subscriptions", {
  id: pk(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  planId: integer("plan_id").notNull().references(() => plans.id, { onDelete: "restrict" }),
  /** null zodra de server weg is (verwijderd door eigenaar/admin of na opzeggen). */
  serverId: integer("server_id").unique().references(() => servers.id, { onDelete: "set null" }),
  status: subscriptionStatus("status").notNull().default("pending"),
  free: boolean("free").notNull().default(false),
  /** Prijs op het moment van afsluiten (centen per maand). */
  priceCents: integer("price_cents").notNull().default(0),
  currency: text("currency").notNull().default("EUR"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  /** Dag van de maand waarop de periode begint (1-31; korter in korte maanden). */
  anchorDay: integer("anchor_day"),
  currentPeriodStart: ts("current_period_start"),
  currentPeriodEnd: ts("current_period_end"),
  /** Vervaldatum van de oudste openstaande factuur zodra die achterstallig is. */
  pastDueSince: ts("past_due_since"),
  suspendedAt: ts("suspended_at"),
  canceledAt: ts("canceled_at"),
  grantedBy: integer("granted_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
}, (t) => [index("subscriptions_user_idx").on(t.userId), index("subscriptions_status_idx").on(t.status)]);

/** Facturen. Nummer `<prefix><jaar>-<volgnummer>` via `invoice_sequences`. */
export const invoices = pgTable("invoices", {
  id: pk(),
  number: text("number").notNull().unique(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  subscriptionId: integer("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
  description: text("description").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull(),
  status: invoiceStatus("status").notNull().default("open"),
  periodStart: ts("period_start"),
  periodEnd: ts("period_end"),
  issuedAt: ts("issued_at").notNull().defaultNow(),
  dueAt: ts("due_at").notNull(),
  paidAt: ts("paid_at"),
  /** Klantgegevens op het moment van uitgeven. */
  customerName: text("customer_name"),
  customerDiscordId: text("customer_discord_id"),
  provider: text("provider"),
  providerPaymentId: text("provider_payment_id"),
  checkoutUrl: text("checkout_url"),
  createdAt: createdAt(),
}, (t) => [index("invoices_user_idx").on(t.userId), index("invoices_subscription_idx").on(t.subscriptionId), index("invoices_status_idx").on(t.status, t.dueAt)]);

export const invoiceSequences = pgTable("invoice_sequences", {
  year: integer("year").primaryKey(),
  last: integer("last").notNull(),
});

/** Verwerkte webhook-events van betaalproviders (idempotentie). */
export const billingEvents = pgTable("billing_events", {
  provider: text("provider").notNull(),
  eventId: text("event_id").notNull(),
  invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
  receivedAt: ts("received_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.provider, t.eventId] })]);

// ---------- onderhoud en import (agent hostops) ----------

/** Evacuatie van een node: servers één (of N) tegelijk verhuizen met admin.servers.transfer. */
export const nodeEvacuations = pgTable("node_evacuations", {
  id: pk(),
  nodeId: integer("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  /** running | completed | cancelled */
  status: text("status").notNull().default("running"),
  concurrency: integer("concurrency").notNull().default(1),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  finishedAt: ts("finished_at"),
}, (t) => [index("node_evacuations_node_idx").on(t.nodeId)]);

export const nodeEvacuationItems = pgTable("node_evacuation_items", {
  id: pk(),
  evacuationId: integer("evacuation_id").notNull().references(() => nodeEvacuations.id, { onDelete: "cascade" }),
  serverId: integer("server_id").references(() => servers.id, { onDelete: "set null" }),
  serverUuid: uuid("server_uuid").notNull(),
  serverName: text("server_name").notNull(),
  /** Gekozen doel; null + auto = nog te kiezen bij het starten. */
  targetNodeId: integer("target_node_id").references(() => nodes.id, { onDelete: "set null" }),
  auto: boolean("auto").notNull().default(true),
  /** queued | running | done | failed | cancelled */
  status: text("status").notNull().default("queued"),
  error: text("error"),
  /** Na de verhuizing: nieuw adres en DNS-records die de eigenaar moet aanpassen. */
  result: jsonb("result").$type<{ newAddress: string | null; dns: Array<{ hostname: string; type: "A" | "SRV"; value: string | null; changed: boolean | null }> }>(),
  position: integer("position").notNull().default(0),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
}, (t) => [index("node_evacuation_items_evac_idx").on(t.evacuationId)]);

/**
 * Import vanuit Pterodactyl/Pelican. Eén rij per import; de sleutels (`_enc`) worden gewist zodra de import
 * klaar is of ontkoppeld wordt. `snapshot` = wat de bron-API gaf, `mapping` = keuzes van de admin.
 */
export const importSessions = pgTable("import_sessions", {
  id: pk(),
  kind: text("kind").notNull(),
  url: text("url").notNull(),
  apiKeyEnc: text("api_key_enc"),
  clientKeyEnc: text("client_key_enc"),
  /** SFTP-login op de bron-nodes; wachtwoord versleuteld. */
  sftp: jsonb("sftp").$type<{ username: string; passwordEnc: string; host: string | null; port: number | null }>(),
  snapshot: jsonb("snapshot").notNull(),
  mapping: jsonb("mapping").notNull().default({}),
  /** ready | running | done | cancelled */
  state: text("state").notNull().default("ready"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  fetchedAt: ts("fetched_at").notNull().defaultNow(),
  createdAt: createdAt(),
});

/** Voortgang per bronserver. */
export const importItems = pgTable("import_items", {
  sessionId: integer("session_id").notNull().references(() => importSessions.id, { onDelete: "cascade" }),
  sourceServerId: integer("source_server_id").notNull(),
  /** pending | creating | copying | done | failed | skipped */
  status: text("status").notNull().default("pending"),
  error: text("error"),
  method: text("method"),
  serverId: integer("server_id").references(() => servers.id, { onDelete: "set null" }),
  newUuid: uuid("new_uuid"),
  bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
}, (t) => [primaryKey({ columns: [t.sessionId, t.sourceServerId] })]);
