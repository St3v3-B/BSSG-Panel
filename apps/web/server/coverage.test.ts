import { buildRouter, procedurePaths } from "@panel/api";
import { describe, expect, it } from "vitest";
import { implementation, implementedPaths } from "./index";

/** Fase 1 volgens apps/web/server/CLAUDE.md. */
export const PHASE1 = [
  "auth.me", "auth.branding", "auth.discordLoginUrl", "auth.verifyTotp", "auth.logout",
  "account.get", "account.totpSetup", "account.totpEnable", "account.totpDisable",
  "servers.list", "servers.get", "servers.stats", "servers.power", "servers.sendCommand", "servers.consoleToken",
  "servers.rename", "servers.updateVariables", "servers.reinstall", "servers.activity", "servers.updateSleep",
  "servers.updateImagePolicy", "servers.updateImageNow", "admin.imageUpdates.list", "admin.imageUpdates.checkNow",
  "admin.dashboard",
  "admin.servers.list", "admin.servers.create", "admin.servers.updateLimits", "admin.servers.updateOwner", "admin.servers.updateAllocations", "admin.servers.delete", "admin.servers.transfer",
  "admin.nodes.list", "admin.nodes.get",
  "admin.allocations.list", "admin.allocations.create", "admin.allocations.delete",
  "admin.users.list", "admin.users.get", "admin.users.create", "admin.users.setBlocked", "admin.users.resetTotp",
  "admin.admins.list", "admin.admins.add", "admin.admins.remove",
  "admin.templates.list", "admin.templates.get", "admin.templates.validate",
  "admin.activity.search",
  "admin.settings.get",
];

/** Fase 2. */
export const PHASE2 = [
  "account.apiKeys", "account.createApiKey", "account.revokeApiKey", "account.setSftpPassword",
  "files.list", "files.read", "files.write", "files.mkdir", "files.rename", "files.delete", "files.compress", "files.decompress",
  "files.uploadUrl", "files.downloadUrl", "files.sftpDetails", "files.search", "files.chmod", "files.move", "files.archiveUrl",
  "admin.nodes.create", "admin.nodes.update", "admin.nodes.delete", "admin.nodes.regenerateToken",
  "subusers.list", "subusers.invite", "subusers.update", "subusers.remove",
];

/** Fase 3. */
export const PHASE3 = [
  "domains.list", "domains.add", "domains.update", "domains.remove", "domains.check", "domains.lastCheck", "domains.target", "domains.applyDns",
  "admin.dnsProviders.list", "admin.dnsProviders.create", "admin.dnsProviders.delete", "admin.dnsProviders.refreshZones",
  "databases.list", "databases.create", "databases.resetPassword", "databases.delete", "databases.phpMyAdminInfo", "databases.phpMyAdminUrl",
  "admin.databaseHosts.list", "admin.databaseHosts.create", "admin.databaseHosts.update", "admin.databaseHosts.delete", "admin.databaseHosts.test",
];

/** One-click apps. */
export const UPDATES = ["admin.updates.status", "admin.updates.start", "admin.updates.setEnabled"];

export const APPS = ["apps.catalog", "apps.check", "apps.install", "apps.job", "apps.jobs"];

/** Website-instellingen (PHP). */
export const SITE_SETTINGS = ["siteSettings.php", "siteSettings.updatePhp"];

/** Fase 4: backups, schema's en S3-doelen. */
export const PHASE4 = [
  "backups.list", "backups.create", "backups.restore", "backups.delete", "backups.downloadUrl", "backups.progress", "backups.cancel",
  "schedules.list", "schedules.create", "schedules.update", "schedules.delete", "schedules.runNow",
  "admin.s3Targets.list", "admin.s3Targets.create", "admin.s3Targets.update", "admin.s3Targets.delete", "admin.s3Targets.test",
];

/** Auth-hardening: noodlogin, herstelcodes, sessies. */
export const AUTH_HARDENING = [
  "auth.emergencyLogin", "account.recoveryCodesStatus", "account.regenerateRecoveryCodes",
  "account.sessions", "account.revokeSession", "account.revokeOtherSessions", "admin.users.revokeSessions",
];

/** Admin-beheer (opschorten, template wisselen, instellingen). */
export const ADMIN2 = ["admin.servers.setSuspended", "admin.servers.changeTemplate", "admin.settings.update", "admin.servers.setDomainsAllowed", "admin.templates.create", "admin.templates.update", "admin.templates.delete", "servers.networkCandidates", "servers.updateNetwork", "servers.bedrock", "servers.setBedrock"];

/** Minecraft-inhoud: plugins, mods, modpacks, versiekiezer. */
export const CONTENT = ["content.info", "content.search", "content.resolve", "content.install", "content.list", "content.checkUpdates", "content.update", "content.uninstall", "content.importModpack", "content.versionOptions"];
/** Minecraft-spelers: online, whitelist, ops, bans. */
export const PLAYERS = ["players.info", "players.online", "players.manage"];
/** Quota's per gebruiker. */
export const NOTIFY = ["account.webhook", "account.setWebhook", "account.testWebhook", "servers.notifications", "servers.updateNotifications", "servers.testWebhook", "admin.notifications.get", "admin.notifications.set", "admin.notifications.test"];
/** Meldingssysteem (inbox, e-mail, voorkeuren, SMTP) en openbare statuspagina's. */
export const NOTIFY2 = [
  "auth.verifyEmail", "account.notificationSettings", "account.setNotificationPrefs", "account.setEmail", "account.resendEmailVerification", "account.testEmail",
  "inbox.list", "inbox.unreadCount", "inbox.markRead", "admin.smtp.get", "admin.smtp.set", "admin.smtp.test",
  "statusPages.list", "statusPages.create", "statusPages.update", "statusPages.delete", "statusPages.candidates", "statusPages.serverPage", "statusPages.setServerPage", "statusPages.public",
];
/** Node-join: join-codes, voortgang, daemon bijwerken. */
export const NODE_JOIN = ["admin.nodes.createJoin", "admin.nodes.joinCommand", "admin.nodes.joinStatus", "admin.nodes.updateDaemon", "admin.nodes.uninstallCommand", "admin.nodes.setHttpRelay", "admin.nodes.relayStatus"];
/** Verbruiksgrafieken. */
export const STATS = ["servers.statsHistory", "servers.statsSparklines"];
export const QUOTA = ["account.quota", "servers.create", "servers.updateOwnLimits", "servers.deleteOwn", "admin.users.getQuota", "admin.users.setQuota", "admin.users.clearQuota", "admin.quotas.usage"];
/** Pakketten en facturatie. */
export const BILLING = [
  "billing.status", "billing.plans", "billing.subscriptions", "billing.invoices", "billing.invoice", "billing.subscribe", "billing.pay", "billing.cancel", "billing.resume",
  "admin.plans.list", "admin.plans.create", "admin.plans.update", "admin.plans.delete",
  "admin.subscriptions.list", "admin.subscriptions.grant", "admin.subscriptions.cancel",
  "admin.invoices.list", "admin.invoices.markPaid", "admin.invoices.void",
  "admin.billing.get", "admin.billing.update",
];

describe("dekking fase 1 + 2 + 3", () => {
  it("elke fase-1-procedure is geïmplementeerd en bestaat in het contract", () => {
    const contract = new Set(procedurePaths().map((p) => p.path));
    const all = [...PHASE1, ...PHASE2, ...PHASE3, ...PHASE4, ...AUTH_HARDENING, ...ADMIN2, ...QUOTA, ...CONTENT, ...APPS, ...NOTIFY, ...SITE_SETTINGS, ...NODE_JOIN, ...UPDATES, ...STATS, ...NOTIFY2, ...BILLING, ...PLAYERS];
    for (const p of all) expect(contract.has(p), p).toBe(true);
    expect(implementedPaths().sort()).toEqual(all.sort());
  });
  it("de router bouwt met de volledige implementatie", () => {
    expect(() => buildRouter(implementation)).not.toThrow();
  });
});
