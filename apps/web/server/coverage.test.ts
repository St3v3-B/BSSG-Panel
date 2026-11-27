import { buildRouter, procedurePaths } from "@panel/api";
import { describe, expect, it } from "vitest";
import { implementation, implementedPaths } from "./index";

/** Fase 1 volgens apps/web/server/CLAUDE.md. */
export const PHASE1 = [
  "auth.me", "auth.branding", "auth.discordLoginUrl", "auth.verifyTotp", "auth.logout",
  "account.get", "account.totpSetup", "account.totpEnable", "account.totpDisable",
  "servers.list", "servers.get", "servers.stats", "servers.power", "servers.sendCommand", "servers.consoleToken",
  "servers.rename", "servers.updateVariables", "servers.reinstall", "servers.activity", "servers.updateSleep",
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
  "files.uploadUrl", "files.downloadUrl", "files.sftpDetails",
  "admin.nodes.create", "admin.nodes.update", "admin.nodes.delete", "admin.nodes.regenerateToken",
  "subusers.list", "subusers.invite", "subusers.update", "subusers.remove",
];

/** Fase 3. */
export const PHASE3 = [
  "domains.list", "domains.add", "domains.update", "domains.remove", "domains.check", "domains.lastCheck", "domains.target", "domains.applyDns",
  "admin.dnsProviders.list", "admin.dnsProviders.create", "admin.dnsProviders.delete", "admin.dnsProviders.refreshZones",
  "databases.list", "databases.create", "databases.resetPassword", "databases.delete",
  "admin.databaseHosts.list", "admin.databaseHosts.create", "admin.databaseHosts.update", "admin.databaseHosts.delete", "admin.databaseHosts.test",
];

/** One-click apps. */
export const APPS = ["apps.catalog", "apps.check", "apps.install", "apps.job", "apps.jobs"];

/** Website-instellingen (PHP). */
export const SITE_SETTINGS = ["siteSettings.php", "siteSettings.updatePhp"];

/** Fase 4: backups, schema's en S3-doelen. */
export const PHASE4 = [
  "backups.list", "backups.create", "backups.restore", "backups.delete", "backups.downloadUrl",
  "schedules.list", "schedules.create", "schedules.update", "schedules.delete", "schedules.runNow",
  "admin.s3Targets.list", "admin.s3Targets.create", "admin.s3Targets.update", "admin.s3Targets.delete", "admin.s3Targets.test",
];

/** Admin-beheer (opschorten, template wisselen, instellingen). */
export const ADMIN2 = ["admin.servers.setSuspended", "admin.servers.changeTemplate", "admin.settings.update", "admin.servers.setDomainsAllowed", "admin.templates.create", "admin.templates.update", "admin.templates.delete", "servers.networkCandidates", "servers.updateNetwork"];

/** Minecraft-inhoud: plugins, mods, modpacks, versiekiezer. */
export const CONTENT = ["content.info", "content.search", "content.resolve", "content.install", "content.list", "content.checkUpdates", "content.update", "content.uninstall", "content.importModpack", "content.versionOptions"];
/** Quota's per gebruiker. */
export const QUOTA = ["account.quota", "servers.create", "servers.updateOwnLimits", "servers.deleteOwn", "admin.users.getQuota", "admin.users.setQuota", "admin.users.clearQuota", "admin.quotas.usage"];

describe("dekking fase 1 + 2 + 3", () => {
  it("elke fase-1-procedure is geïmplementeerd en bestaat in het contract", () => {
    const contract = new Set(procedurePaths().map((p) => p.path));
    const all = [...PHASE1, ...PHASE2, ...PHASE3, ...PHASE4, ...ADMIN2, ...QUOTA, ...CONTENT, ...APPS, ...SITE_SETTINGS];
    for (const p of all) expect(contract.has(p), p).toBe(true);
    expect(implementedPaths().sort()).toEqual(all.sort());
  });
  it("de router bouwt met de volledige implementatie", () => {
    expect(() => buildRouter(implementation)).not.toThrow();
  });
});
