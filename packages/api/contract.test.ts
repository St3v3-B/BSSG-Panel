import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMock, mockSession } from "./mock";
import { parseTemplate } from "./template-schema";
import { buildRouter, checkAccess, createCallerFactory, notImplemented, procedurePaths, type Ctx, type SessionCtx } from "./trpc-builder";

const ctx = (session: SessionCtx | null): Ctx => ({ session, ip: "127.0.0.1", userAgent: "test", resHeaders: new Headers() });

describe("contract", () => {
  it("heeft unieke paden en een access-niveau per procedure", () => {
    const paths = procedurePaths();
    expect(paths.length).toBeGreaterThan(80);
    for (const { path, def } of paths) {
      expect(["public", "pending", "user", "admin"], path).toContain(def.access);
      if (path.startsWith("admin.")) expect(def.access, path).toBe("admin");
    }
  });

  it("mock implementeert elke procedure", () => {
    expect(() => buildRouter(createMock())).not.toThrow();
  });

  it("notImplemented bouwt ook", () => {
    expect(() => buildRouter(notImplemented())).not.toThrow();
  });
});

describe("toegang", () => {
  const admin = mockSession("admin")!;
  it("public mag zonder sessie", () => expect(() => checkAccess("public", ctx(null))).not.toThrow());
  it("user zonder sessie → UNAUTHORIZED", () => expect(() => checkAccess("user", ctx(null))).toThrow(/UNAUTHORIZED/));
  it("pending sessie mag pending, niet user", () => {
    const s = { ...admin, totpVerified: false };
    expect(() => checkAccess("pending", ctx(s))).not.toThrow();
    expect(() => checkAccess("user", ctx(s))).toThrow(/TOTP_PENDING/);
  });
  it("admin zonder 2FA → TOTP_REQUIRED", () => {
    expect(() => checkAccess("admin", ctx({ ...admin, totpEnabled: false, totpVerified: false }))).toThrow(/TOTP_REQUIRED/);
  });
  it("niet-admin → NOT_ADMIN", () => expect(() => checkAccess("admin", ctx(mockSession("user")))).toThrow(/NOT_ADMIN/));
  it("geblokkeerd → BLOCKED", () => expect(() => checkAccess("pending", ctx({ ...admin, blocked: true }))).toThrow(/BLOCKED/));
  it("admin met 2FA mag", () => expect(() => checkAccess("admin", ctx(admin))).not.toThrow());
});

describe("mock via de echte router (output-validatie)", () => {
  const caller = createCallerFactory(buildRouter(createMock()))(ctx(mockSession("admin")));
  const uuid = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";

  it("queries leveren geldige output", async () => {
    await caller.auth.me();
    await caller.auth.branding();
    await caller.servers.list();
    await caller.servers.get({ uuid });
    await caller.servers.stats({ uuid });
    await caller.servers.activity({ uuid });
    await caller.files.list({ uuid, path: "/" });
    await caller.domains.list({ uuid });
    await caller.backups.list({ uuid });
    await caller.schedules.list({ uuid });
    await caller.subusers.list({ uuid });
    await caller.account.apiKeys();
    await caller.admin.dashboard();
    await caller.admin.nodes.list();
    await caller.admin.nodes.get({ id: 1 });
    await caller.admin.allocations.list({ nodeId: 1 });
    await caller.admin.servers.list({});
    await caller.admin.templates.list();
    await caller.admin.users.list({});
    await caller.admin.admins.list();
    await caller.admin.databaseHosts.list();
    await caller.admin.s3Targets.list();
    await caller.admin.dnsProviders.list();
    await caller.admin.activity.search({});
    await caller.admin.settings.get();
  });

  it("admin maakt een server aan voor een andere gebruiker", async () => {
    const s = await caller.admin.servers.create({ name: "Test", ownerId: 2, nodeId: 1, templateId: 1, limits: { cpuPct: 100, ramMb: 1024, swapMb: 0, diskMb: 5000 }, allocationIds: [3] });
    expect(s.status).toBe("installing");
    expect(s.owner.id).toBe(2);
    expect(s.primaryAddress).toBe("203.0.113.10:25567");
  });

  it("ongeldige input wordt geweigerd", async () => {
    await expect(caller.servers.get({ uuid: "geen-uuid" })).rejects.toThrow();
  });
});

describe("openapi-types", () => {
  it("gegenereerde types zijn actueel (draai `pnpm --filter @panel/api gen`)", () => {
    const dir = mkdtempSync(join(tmpdir(), "oapi-"));
    for (const [src, gen] of [["openapi.yaml", "daemon-types.gen.ts"], ["panel-remote.yaml", "panel-remote-types.gen.ts"]] as const) {
      execFileSync("pnpm", ["exec", "openapi-typescript", src, "-o", join(dir, gen)], { cwd: __dirname, stdio: "ignore" });
      expect(readFileSync(join(dir, gen), "utf8"), gen).toBe(readFileSync(join(__dirname, gen), "utf8"));
    }
  }, 60_000);
});

describe("templates", () => {
  it("voorbeeld uit templates/SCHEMA.md is geldig", () => {
    const md = readFileSync(join(__dirname, "../../templates/SCHEMA.md"), "utf8");
    const yaml = md.match(/```yaml\n([\s\S]*?)```/)?.[1];
    expect(yaml).toBeTruthy();
    const r = parseTemplate(yaml!);
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it("alle templates in templates/game en templates/web zijn geldig", () => {
    for (const sub of ["game", "web"]) {
      const dir = join(__dirname, "../../templates", sub);
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
        const r = parseTemplate(readFileSync(join(dir, f), "utf8"));
        expect(r.ok ? [] : r.errors, `${sub}/${f}`).toEqual([]);
      }
    }
  });
});
