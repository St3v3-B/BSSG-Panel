import { parseTemplate } from "@panel/api";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as status } from "@/app/api/remote/servers/[uuid]/status/route";
import { getDb, schema } from "./db";
import { upsertTemplate } from "./templates";
import { GAME_TEMPLATE, OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, player: TestUser, sub: TestUser;
let mc = "", plain = "";

const MC = GAME_TEMPLATE.replace("slug: testgame", "slug: testmc").replace("name: Testspel", "name: Test-MC\nsleep_capable: true");

beforeAll(async () => {
  const p = parseTemplate(MC);
  if (!p.ok) throw new Error(p.errors.join("; "));
  await upsertTemplate(p.spec, MC);
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "290000000000000001", name: "speler" });
  sub = await h.user({ discordId: "290000000000000002", name: "helper" });
  const mk = async (slug: string, port: number) =>
    (await admin.api.admin.servers.create({
      name: slug, ownerId: player.id, nodeId: h.localNodeId, templateId: await h.templateId(slug),
      limits: { cpuPct: 100, ramMb: 1024, swapMb: 0, diskMb: 2048 }, allocationIds: [await h.allocation(port)], variables: {}, startOnInstall: true,
    })).uuid;
  mc = await mk("testmc", 25600);
  plain = await mk("testgame", 25601);
  await player.api.subusers.invite({ uuid: mc, who: sub.discordId, permissions: ["power", "console.read"] });
});

describe("slaapstand", () => {
  it("ServerDetail.sleep: supported alleen bij sleep_capable", async () => {
    expect((await player.api.servers.get({ uuid: mc })).sleep).toEqual({ supported: true, enabled: false, idleMinutes: 10 });
    expect((await player.api.servers.get({ uuid: plain })).sleep).toEqual({ supported: false, enabled: false, idleMinutes: 10 });
    expect(h.daemon.servers.get(mc)!.spec.sleep).toBeNull();
  });

  it("nieuwe Minecraft-server vraagt server_icon bssg, andere templates niet", async () => {
    const icon = (u: string) => (h.daemon.servers.get(u)!.spec as unknown as { server_icon?: string }).server_icon;
    expect(icon(mc)).toBe("bssg");
    expect(icon(plain)).toBeUndefined();
  });

  it("MOTD-instellingen: standaard, opslaan, in spec (naam, promo, favicon_mode, server_icon)", async () => {
    expect((await admin.api.admin.settings.get()).sleepMotd).toMatchObject({ showLogoIcon: true, seedLogoIcon: true, promo: expect.stringContaining("BSSG Panel") });
    await admin.api.admin.settings.update({ sleepMotd: { promo: "&aHoi", showLogoIcon: false, seedLogoIcon: false } });
    expect((await admin.api.admin.settings.get()).sleepMotd).toEqual({ promo: "&aHoi", showLogoIcon: false, seedLogoIcon: false });
    await expect(admin.api.admin.settings.update({ sleepMotd: { promo: "x".repeat(121), showLogoIcon: true, seedLogoIcon: true } })).rejects.toBeTruthy();
    await player.api.servers.updateSleep({ uuid: mc, enabled: true, idleMinutes: 15 });
    const put = h.daemon.last("PUT", `/api/servers/${mc}`)!.body as { sleep: unknown; server_icon: string };
    expect(put.sleep).toMatchObject({ server_name: expect.any(String), promo: "&aHoi", favicon_mode: "server_only" });
    expect(put.server_icon).toBeUndefined();
    await admin.api.admin.settings.update({ sleepMotd: { promo: "", showLogoIcon: true, seedLogoIcon: true } });
    await player.api.servers.updateSleep({ uuid: mc, enabled: true, idleMinutes: 15 });
    expect((h.daemon.last("PUT", `/api/servers/${mc}`)!.body as { sleep: unknown }).sleep).toMatchObject({ favicon_mode: "server_or_logo" });
    await player.api.servers.updateSleep({ uuid: mc, enabled: false, idleMinutes: 15 });
  });

  it("updateSleep: PUT met sleep in de spec, DB bijgewerkt, activiteit; uit → sleep null", async () => {
    await player.api.servers.updateSleep({ uuid: mc, enabled: true, idleMinutes: 15 });
    const put = h.daemon.last("PUT", `/api/servers/${mc}`)!.body as { sleep: unknown; skip_install: boolean };
    expect(put.sleep).toMatchObject({ idle_minutes: 15, motd: expect.any(String), kick_message: expect.any(String) });
    expect(put.skip_install).toBe(true);
    const [row] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, mc));
    expect(row).toMatchObject({ sleepEnabled: true, sleepIdleMinutes: 15 });
    expect((await player.api.servers.get({ uuid: mc })).sleep).toEqual({ supported: true, enabled: true, idleMinutes: 15 });
    const log = (await admin.api.admin.activity.search({ serverUuid: mc, action: "server.sleep.update" })).items;
    expect(log[0]!.metadata).toMatchObject({ enabled: true, idleMinutes: 15 });

    // andere spec-wijzigingen houden sleep mee
    await admin.api.admin.servers.updateLimits({ uuid: mc, limits: { cpuPct: 100, ramMb: 1024, swapMb: 0, diskMb: 4096 } });
    expect((h.daemon.last("PUT", `/api/servers/${mc}`)!.body as { sleep: unknown }).sleep).toMatchObject({ idle_minutes: 15 });

    await player.api.servers.updateSleep({ uuid: mc, enabled: false, idleMinutes: 15 });
    expect((h.daemon.last("PUT", `/api/servers/${mc}`)!.body as { sleep: unknown }).sleep).toBeNull();
  });

  it("weigert: niet supported → BAD_REQUEST, subuser → FORBIDDEN, API-sleutel → FORBIDDEN; admin mag", async () => {
    await expect(player.api.servers.updateSleep({ uuid: plain, enabled: true, idleMinutes: 5 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(sub.api.servers.updateSleep({ uuid: mc, enabled: true, idleMinutes: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { key } = await player.api.account.createApiKey({ name: "k", permissions: ["power"], expiresAt: null });
    const { createCallerFactory, buildRouter } = await import("@panel/api");
    const { implementation } = await import("./index");
    const { createContext } = await import("./context");
    const api = createCallerFactory(buildRouter(implementation))(await createContext(new Request("http://panel.test/", { headers: { authorization: `Bearer ${key}` } }), new Headers()));
    await expect(api.servers.updateSleep({ uuid: mc, enabled: true, idleMinutes: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await admin.api.servers.updateSleep({ uuid: mc, enabled: true, idleMinutes: 5 });
  });

  it("status sleeping: remote-endpoint, live status, en start vanuit sleeping", async () => {
    const res = await status(
      new Request(`http://panel.test/api/remote/servers/${mc}/status`, { method: "POST", headers: { authorization: `Bearer ${h.env.NODE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ state: "sleeping" }) }),
      { params: Promise.resolve({ uuid: mc }) },
    );
    expect(res.status).toBe(204);
    const [row] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, mc));
    expect(row!.status).toBe("sleeping");
    h.daemon.servers.get(mc)!.state = "sleeping";
    expect((await player.api.servers.get({ uuid: mc })).status).toBe("sleeping");
    expect((await player.api.servers.list()).find((s) => s.uuid === mc)!.status).toBe("sleeping");
    await sub.api.servers.power({ uuid: mc, action: "start" });
    expect(h.daemon.last("POST", `/api/servers/${mc}/power`)!.body).toEqual({ action: "start" });
  });
});
