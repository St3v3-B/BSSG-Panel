import { buildRouter, procedurePaths } from "@panel/api";
import { describe, expect, it } from "vitest";
import { implementation, implementedPaths } from "./index";

/** Fase 1 volgens apps/web/server/CLAUDE.md. */
export const PHASE1 = [
  "auth.me", "auth.branding", "auth.discordLoginUrl", "auth.verifyTotp", "auth.logout",
  "account.get", "account.totpSetup", "account.totpEnable", "account.totpDisable",
  "servers.list", "servers.get", "servers.stats", "servers.power", "servers.sendCommand", "servers.consoleToken",
  "servers.rename", "servers.updateVariables", "servers.reinstall", "servers.activity",
  "admin.dashboard",
  "admin.servers.list", "admin.servers.create", "admin.servers.updateLimits", "admin.servers.updateOwner", "admin.servers.updateAllocations", "admin.servers.delete",
  "admin.nodes.list", "admin.nodes.get",
  "admin.allocations.list", "admin.allocations.create", "admin.allocations.delete",
  "admin.users.list", "admin.users.get", "admin.users.create", "admin.users.setBlocked", "admin.users.resetTotp",
  "admin.admins.list", "admin.admins.add", "admin.admins.remove",
  "admin.templates.list", "admin.templates.get", "admin.templates.validate",
  "admin.activity.search",
  "admin.settings.get",
];

describe("dekking fase 1", () => {
  it("elke fase-1-procedure is geïmplementeerd en bestaat in het contract", () => {
    const contract = new Set(procedurePaths().map((p) => p.path));
    for (const p of PHASE1) expect(contract.has(p), p).toBe(true);
    expect(implementedPaths().sort()).toEqual([...PHASE1].sort());
  });
  it("de router bouwt met de volledige implementatie", () => {
    expect(() => buildRouter(implementation)).not.toThrow();
  });
});
