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
  text,
  timestamp,
  uniqueIndex,
  uuid,
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
export const scheduleAction = pgEnum("schedule_action", ["restart", "command", "backup"]);

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
  /** Argon2id; alleen voor het noodaccount */
  passwordHash: text("password_hash"),
  createdAt: createdAt(),
  lastLoginAt: ts("last_login_at"),
}, (t) => [
  check("users_discord_or_emergency", sql`${t.discordId} is not null or ${t.isEmergency}`),
  uniqueIndex("users_one_emergency").on(t.isEmergency).where(sql`${t.isEmergency}`),
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
  expiresAt: ts("expires_at").notNull(),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

export const apiKeys = pgTable("api_keys", {
  id: pk(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull().unique(),
  /** SHA-256 van de volledige sleutel */
  hash: text("hash").notNull(),
  permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
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
  createdAt: createdAt(),
}, (t) => [uniqueIndex("nodes_one_local").on(t.isLocal).where(sql`${t.isLocal}`)]);

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
  status: serverStatus("status").notNull().default("installing"),
  installedAt: ts("installed_at"),
  createdAt: createdAt(),
}, (t) => [index("servers_owner_idx").on(t.ownerId), index("servers_node_idx").on(t.nodeId)]);

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
}, (t) => [primaryKey({ columns: [t.serverId, t.userId] })]);

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
});

export const databaseHosts = pgTable("database_hosts", {
  id: pk(),
  name: text("name").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull().default(3306),
  adminUser: text("admin_user").notNull(),
  adminPasswordEnc: text("admin_password_enc").notNull(),
  nodeId: integer("node_id").references(() => nodes.id, { onDelete: "set null" }),
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
}, (t) => [uniqueIndex("databases_host_name").on(t.hostId, t.name)]);

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
  createdAt: createdAt(),
});

// ---------- overig ----------

/** sleutels: panel_name, logo_url, accent_color, default_limits, jwt_signing_key_enc */
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
]);
