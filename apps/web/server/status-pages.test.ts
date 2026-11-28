import { NextRequest } from "next/server";
/** Openbare statuspagina's: beheer, rechten, geen gevoelige velden, caching, uptime en spelers. */
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { authProxy } from "./proxy";
import { CACHE_MS, invalidateStatus, publicStatus, sampleUptime, statusStats, uptimeFor } from "./status-pages";
import { GAME_TEMPLATE, OWNER, useHarness, type TestUser } from "./test/harness";

const PAPER = GAME_TEMPLATE.replace("slug: testgame", "slug: paper").replace("name: Testspel", "name: Paper");
const h = useHarness({ templates: { "game/paper.yaml": PAPER } });
let admin: TestUser, player: TestUser, other: TestUser;
let smp = "", lobby = "", foreign = "";

async function mk(name: string, ownerId: number, port: number, slug = "paper") {
  const d = await admin.api.admin.servers.create({
    name,
    ownerId,
    nodeId: h.localNodeId,
    templateId: await h.templateId(slug),
    limits: { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 },
    allocationIds: [await h.allocation(port, "203.0.113.50")],
    variables: {},
    startOnInstall: true,
  });
  return d.uuid;
}
const setState = async (uuid: string, status: "online" | "offline") => {
  await getDb().update(schema.servers).set({ status }).where(eq(schema.servers.uuid, uuid));
  const s = h.daemon.servers.get(uuid);
  if (s) s.state = status;
};

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, admin: true, totp: true });
  player = await h.user({ discordId: "280000000000000001", name: "speler" });
  other = await h.user({ discordId: "280000000000000002", name: "ander" });
  smp = await mk("SMP", player.id, 25601);
  lobby = await mk("Lobby", player.id, 25602, "testgame");
  foreign = await mk("Vreemd", other.id, 25603);
});
beforeEach(() => invalidateStatus());

describe("serverpagina (eigenaar)", () => {
  it("aanzetten, openbaar zonder login, zonder gevoelige velden; adres alleen als de eigenaar dat wil", async () => {
    expect(await player.api.statusPages.serverPage({ uuid: smp })).toBeNull();
    await expect(other.api.statusPages.setServerPage({ uuid: smp, enabled: true, slug: "smp", showAddress: false, showPlayers: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const p = await player.api.statusPages.setServerPage({ uuid: smp, enabled: true, slug: "SMP-status", showAddress: false, showPlayers: true });
    expect(p).toMatchObject({ slug: "smp-status", kind: "server", title: "SMP", servers: [{ uuid: smp, name: "SMP" }] });
    await setState(smp, "online");
    const anon = await h.anon();
    const pub = await anon.statusPages.public({ slug: "smp-status" });
    expect(pub).toMatchObject({ title: "SMP", kind: "server", overall: "operational" });
    expect(pub.servers).toHaveLength(1);
    expect(pub.servers[0]).toMatchObject({ name: "SMP", type: "game", state: "online", players: { online: 2, max: 20 }, address: null });
    expect(pub.servers[0]!.hours).toHaveLength(24);
    expect(pub.servers[0]!.days).toHaveLength(7);
    const json = JSON.stringify(pub);
    for (const secret of [smp, "203.0.113.50", "node1", "speler", h.env.NODE_DOMAIN!]) expect(json).not.toContain(secret);
    expect(Object.keys(pub.servers[0]!).sort()).toEqual(["address", "days", "hours", "name", "players", "state", "type", "uptime24h", "uptime7d"]);

    await player.api.statusPages.setServerPage({ uuid: smp, enabled: true, slug: "smp-status", showAddress: true, showPlayers: false });
    const pub2 = await anon.statusPages.public({ slug: "smp-status" });
    expect(pub2.servers[0]).toMatchObject({ address: "203.0.113.50:25601", players: null });
  });

  it("uit of onbekend: NOT_FOUND; slug bezet: CONFLICT; ongeldige slug: BAD_REQUEST", async () => {
    const anon = await h.anon();
    await expect(anon.statusPages.public({ slug: "bestaat-niet" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(anon.statusPages.public({ slug: "../x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.api.statusPages.setServerPage({ uuid: foreign, enabled: true, slug: "smp-status", showAddress: false, showPlayers: true })).rejects.toMatchObject({ code: "CONFLICT", message: "SLUG_TAKEN" });
    await expect(other.api.statusPages.setServerPage({ uuid: foreign, enabled: true, slug: "-x", showAddress: false, showPlayers: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await player.api.statusPages.setServerPage({ uuid: smp, enabled: false, slug: "smp-status", showAddress: false, showPlayers: true });
    await expect(anon.statusPages.public({ slug: "smp-status" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await player.api.statusPages.setServerPage({ uuid: smp, enabled: true, slug: "smp-status", showAddress: false, showPlayers: true });
  });
});

describe("netwerkpagina", () => {
  it("alleen eigen servers; volgorde; bijwerken en verwijderen", async () => {
    await expect(player.api.statusPages.create({ slug: "netwerk", title: "Netwerk", description: null, enabled: true, showAddress: false, showPlayers: true, serverUuids: [smp, foreign] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const p = await player.api.statusPages.create({ slug: "netwerk", title: "Netwerk", description: "Alles van speler", enabled: true, showAddress: false, showPlayers: true, serverUuids: [lobby, smp] });
    expect(p.servers.map((x) => x.name)).toEqual(["Lobby", "SMP"]);
    expect((await player.api.statusPages.list()).map((x) => x.slug).sort()).toEqual(["netwerk", "smp-status"]);
    expect(await other.api.statusPages.list()).toEqual([]);
    await expect(other.api.statusPages.update({ id: p.id, slug: "netwerk", title: "x", description: null, enabled: true, showAddress: false, showPlayers: true, serverUuids: [foreign] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await setState(smp, "online");
    await setState(lobby, "offline");
    const pub = await (await h.anon()).statusPages.public({ slug: "netwerk" });
    expect(pub.overall).toBe("degraded");
    expect(pub.servers.map((x) => [x.name, x.state])).toEqual([["Lobby", "offline"], ["SMP", "online"]]);
    // geen Minecraft-template → geen ping
    expect(pub.servers[0]!.players).toBeNull();
    // server van eigenaar gewisseld → verdwijnt van de netwerkpagina
    await admin.api.admin.servers.updateOwner({ uuid: lobby, ownerId: other.id });
    invalidateStatus();
    expect((await (await h.anon()).statusPages.public({ slug: "netwerk" })).servers.map((x) => x.name)).toEqual(["SMP"]);
    await admin.api.admin.servers.updateOwner({ uuid: lobby, ownerId: player.id });
    const cands = await player.api.statusPages.candidates();
    expect(cands.map((c) => c.uuid).sort()).toEqual([smp, lobby].sort());
    await player.api.statusPages.delete({ id: p.id });
    invalidateStatus();
    await expect((await h.anon()).statusPages.public({ slug: "netwerk" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("caching", () => {
  it("veel bezoekers: één berekening per slug per venster, ook voor onbekende slugs", async () => {
    const before = statusStats.computed;
    const now = Date.now();
    const many = await Promise.all(Array.from({ length: 200 }, () => publicStatus("smp-status", now)));
    expect(many.every((x) => x?.title === "SMP")).toBe(true);
    for (let i = 0; i < 50; i++) await publicStatus("onbekend-x", now);
    expect(statusStats.computed - before).toBe(2);
    // na het venster opnieuw
    await publicStatus("smp-status", now + 2 * CACHE_MS);
    expect(statusStats.computed - before).toBe(3);
  });

  it("de spelers-ping gebeurt niet bij elke bezoeker", async () => {
    await setState(smp, "online");
    const pings = () => h.daemon.requests.filter((r) => r.path.endsWith(`/${smp}/players`)).length;
    const n = pings();
    for (let i = 0; i < 20; i++) await (await h.anon()).statusPages.public({ slug: "smp-status" });
    expect(pings() - n).toBe(1);
  });
});

describe("uptime", () => {
  it("één meting per minuut per server, ook bij dubbele aanroep; percentages per uur en dag", async () => {
    const [s] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, smp));
    await getDb().delete(schema.serverUptime);
    const base = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    await setState(smp, "online");
    for (let m = 0; m < 30; m++) {
      const t = new Date(base.getTime() + m * 60_000);
      await sampleUptime(t);
      await sampleUptime(t); // tweede panelproces in dezelfde minuut
    }
    await setState(smp, "offline");
    for (let m = 30; m < 40; m++) await sampleUptime(new Date(base.getTime() + m * 60_000));
    const [row] = await getDb().select().from(schema.serverUptime).where(eq(schema.serverUptime.serverId, s!.id));
    expect(row).toMatchObject({ upMinutes: 30, totalMinutes: 40 });
    const u = (await uptimeFor([s!.id], new Date(base.getTime() + 45 * 60_000))).get(s!.id)!;
    expect(u.uptime24h).toBe(75);
    expect(u.uptime7d).toBe(75);
    expect(u.hours.at(-1)).toBe(75);
    expect(u.hours.slice(0, 23).every((x) => x === null)).toBe(true);
    expect(u.days.at(-1)).toBe(75);
    // opgeschorte servers tellen niet mee
    await getDb().update(schema.servers).set({ suspendedAt: new Date() }).where(eq(schema.servers.id, s!.id));
    await sampleUptime(new Date(base.getTime() + 41 * 60_000));
    const [row2] = await getDb().select().from(schema.serverUptime).where(eq(schema.serverUptime.serverId, s!.id));
    expect(row2!.totalMinutes).toBe(40);
    await getDb().update(schema.servers).set({ suspendedAt: null }).where(eq(schema.servers.id, s!.id));
  });
});

describe("proxy", () => {
  it("/status/<slug> en /verify-email zijn openbaar; /status-pages niet", () => {
    const loc = (p: string) => authProxy(new NextRequest(`http://panel.test${p}`)).headers.get("location");
    expect(loc("/status/smp-status")).toBeNull();
    expect(loc("/verify-email?token=abc")).toBeNull();
    expect(loc("/status-pages")).toContain("/login");
  });
});
